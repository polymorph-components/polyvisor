//! Trusted document sharing: the confirm prompt `tasks-share` raises, the
//! outgoing delivery list, and the received-invitation inbox.
//!
//! Everything here is `sharing`/`contacts` state, read fresh on open and on
//! `events.sharing-changed`, exactly like [`crate::contacts_ui`]. The app
//! never supplies a contact or a document id — those are chosen here, in
//! trusted pixels, and the app only ever learns that `tasks-share` queued a
//! prompt.

use dioxus::prelude::*;

use crate::kernel::{
    self, Access, Contact, DeliveryState, Invitation, OutgoingItem, Prompt, Provenance,
};
use crate::voice::Voice;

pub(crate) fn refresh_sharing(
    mut prompts: Signal<Vec<Prompt>>,
    mut outgoing: Signal<Vec<OutgoingItem>>,
    mut inbox: Signal<Vec<Invitation>>,
) {
    spawn(async move {
        if let Ok(items) = kernel::sharing_prompts().await {
            prompts.set(items);
        }
        if let Ok(items) = kernel::sharing_outgoing().await {
            outgoing.set(items);
        }
        if let Ok(items) = kernel::sharing_inbox().await {
            inbox.set(items);
        }
    });
}

/// A contact this device may name as a share recipient.
///
/// `grant_document`/`adopt_document` verify the recipient's group/device
/// binding from a `membership_proof` the kernel obtains itself, keyed off a
/// contact's `authenticated` identity (internal.wit
/// `contacts.contact.authenticated`, set only by a verified meeting or
/// `import-accept`). A manual or unsigned-import contact carries none, so
/// it is excluded here rather than offered as a dead choice.
fn eligible(contacts: &[Contact]) -> Vec<&Contact> {
    contacts
        .iter()
        .filter(|c| c.authenticated.is_some())
        .collect()
}

fn access_label(a: Access) -> &'static str {
    match a {
        Access::Read => "read",
        Access::Edit => "edit",
    }
}

fn state_label(s: DeliveryState) -> &'static str {
    match s {
        DeliveryState::Queued => "queued",
        DeliveryState::Delivering => "delivering",
        DeliveryState::Delivered => "delivered",
        DeliveryState::Failed => "failed",
    }
}

#[component]
fn PromptRow(
    prompt: Prompt,
    contacts: Signal<Vec<Contact>>,
    on_done: EventHandler<()>,
    error: Signal<Option<String>>,
) -> Element {
    let mut selected_contact = use_signal(|| None::<String>);
    let mut access = use_signal(|| Access::Read);
    let mut busy = use_signal(|| false);

    // The default selection is the first eligible contact, but contacts
    // can arrive after this row already mounted (a fresh Sharing pane
    // fetches them in parallel); re-derive the default whenever the list
    // changes rather than only once at mount, so the selector does not
    // stay stuck on "choose a contact" once one exists.
    use_effect(move || {
        let contacts_read = contacts.read();
        let candidates = eligible(&contacts_read);
        let still_present = selected_contact
            .peek()
            .as_ref()
            .is_some_and(|id| candidates.iter().any(|c| &c.id == id));
        if !still_present {
            selected_contact.set(candidates.first().map(|c| c.id.clone()));
        }
    });

    let confirm = {
        let id = prompt.id.clone();
        move |_| {
            let Some(contact) = selected_contact() else {
                error.set(Some("choose a contact first".into()));
                return;
            };
            if busy() {
                return;
            }
            busy.set(true);
            let prompt_id = id.clone();
            spawn(async move {
                match kernel::sharing_confirm(&prompt_id, &contact, access()).await {
                    Ok(()) => on_done.call(()),
                    Err(e) => error.set(Some(e)),
                }
                busy.set(false);
            });
        }
    };
    let cancel = {
        let id = prompt.id.clone();
        move |_| {
            let id = id.clone();
            spawn(async move {
                let _ = kernel::sharing_cancel(&id).await;
                on_done.call(());
            });
        }
    };

    let contacts_read = contacts.read();
    let candidates = eligible(&contacts_read);

    rsx! {
        div { class: "sharing-consent",
            div { class: "sharing-consent-title", span { class: "{Voice::Framework.class()}", "{prompt.label}" } }
            if candidates.is_empty() {
                p { class: "{Voice::Framework.class()}",
                    "no authenticated contact is eligible to receive this — meet or import one first"
                }
                div { class: "sharing-actions",
                    button { disabled: "{busy()}", onclick: cancel, "Cancel" }
                }
            } else {
                label { class: "sharing-field",
                    span { class: "sharing-field-label", "Recipient" }
                    select {
                        onchange: move |e| selected_contact.set(Some(e.value())),
                        for c in candidates.iter() {
                            option {
                                key: "{c.id}",
                                value: "{c.id}",
                                selected: selected_contact().as_deref() == Some(c.id.as_str()),
                                {
                                    let name = contact_display_name(c);
                                    if name.is_empty() {
                                        format!("an unnamed contact ({})", crate::contacts::key_short(&c.public_key))
                                    } else {
                                        name
                                    }
                                }
                            }
                        }
                    }
                }
                div { class: "sharing-field",
                    span { class: "sharing-field-label", "Access" }
                    div { class: "sharing-access",
                        label {
                            input {
                                r#type: "radio",
                                name: "access-{prompt.id}",
                                checked: access() == Access::Read,
                                onchange: move |_| access.set(Access::Read),
                            }
                            "Read"
                        }
                        label {
                            input {
                                r#type: "radio",
                                name: "access-{prompt.id}",
                                checked: access() == Access::Edit,
                                onchange: move |_| access.set(Access::Edit),
                            }
                            "Edit"
                        }
                    }
                }
                p { class: "sharing-consent-note {Voice::Framework.class()}",
                    "sharing includes the whole history — deleted tasks and "
                    "earlier titles may still be readable — and the recipient "
                    "may reshare at this access level or lower"
                }
                div { class: "sharing-actions",
                    button { disabled: "{busy()}", onclick: confirm, "Confirm" }
                    button { disabled: "{busy()}", onclick: cancel, "Cancel" }
                }
            }
        }
    }
}

/// A contact's own display name: the user's petname; else (same rule
/// `contacts_ui`'s contact detail view uses) the preferred or latest
/// locally-observed "name" claim; else a "name" claim from the contact's
/// signed official profile (`Contact.official_profiles` — the decoded
/// claims of a verified introduction, `Contact.authenticated`'s actual
/// content). "" only when none of these exist — a fresh meeting alone
/// names neither the local observation nor necessarily the profile.
fn contact_display_name(contact: &Contact) -> String {
    if !contact.petname.is_empty() {
        return contact.petname.clone();
    }
    let preferred = contact
        .preferred
        .iter()
        .find(|(name, _)| name == "name")
        .map(|(_, value)| value.as_str());
    let observed = crate::contacts::default_name(
        preferred,
        contact
            .observations
            .iter()
            .filter(|o| o.name.expose() == "name" && o.provenance == Provenance::Local)
            .map(|o| (o.value.expose(), o.received)),
    );
    if !observed.is_empty() {
        return observed;
    }
    contact
        .official_profiles
        .iter()
        .find_map(|profile| {
            profile
                .claims
                .iter()
                .find(|(name, _)| name.expose() == "name")
                .map(|(_, value)| value.expose().to_string())
        })
        .unwrap_or_default()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || s.is_empty() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// A person label for display, given the exact string `sharing`
/// (`outgoing-item.recipient` / `invitation.sender`) sent: the matching
/// contact's own display name when the string is that contact's raw
/// identity (internal.wit doesn't guarantee a resolved petname), the
/// string itself when it already looks like resolved text, or a
/// framework-voice placeholder — a short reference to the root, never the
/// whole public key — when no name is available at all. Returns whether
/// the placeholder was used, so the caller can pick the right voice class.
fn person_label(raw: &str, contacts: &[Contact]) -> (bool, String) {
    if raw.is_empty() {
        return (true, "an unnamed contact".to_string());
    }
    let looks_like_raw_id = raw.len() >= 16 && raw.bytes().all(|b| b.is_ascii_hexdigit());
    if looks_like_raw_id && let Some(bytes) = hex_decode(raw) {
        if let Some(contact) = contacts.iter().find(|c| c.public_key == bytes) {
            let name = contact_display_name(contact);
            if !name.is_empty() {
                return (false, name);
            }
        }
        // No local contact record, or one with no name at all: a short
        // reference to the root rather than the whole key (the same
        // `key_short` format the consent selector and Contacts use).
        return (
            true,
            format!(
                "an unnamed contact ({})",
                crate::contacts::key_short(&bytes)
            ),
        );
    }
    (false, raw.to_string())
}

#[component]
fn OutgoingRow(
    item: OutgoingItem,
    contacts: Signal<Vec<Contact>>,
    on_done: EventHandler<()>,
    error: Signal<Option<String>>,
) -> Element {
    let mut busy = use_signal(|| false);
    let retry = {
        let id = item.id.clone();
        move |_| {
            if busy() {
                return;
            }
            busy.set(true);
            let id = id.clone();
            spawn(async move {
                match kernel::sharing_retry(&id).await {
                    Ok(()) => on_done.call(()),
                    Err(e) => error.set(Some(e)),
                }
                busy.set(false);
            });
        }
    };
    let (placeholder, name) = person_label(&item.recipient, &contacts.read());
    let name_class = if placeholder {
        format!("placeholder {}", Voice::Framework.class())
    } else {
        Voice::User.class().to_string()
    };
    rsx! {
        div { class: "app-row sharing-status-row",
            div { class: "app-row-title",
                span { class: "{Voice::Framework.class()}", "{item.label}" }
                span { class: "{name_class}", " to {name}" }
            }
            p { class: "{Voice::Framework.class()}",
                "{access_label(item.access)} — {state_label(item.state)}"
                if !item.detail.is_empty() { ": {item.detail}" }
            }
            if item.state == DeliveryState::Failed {
                p { class: "{Voice::Framework.class()}",
                    "the grant was made and persists; only delivery failed"
                }
                button { disabled: "{busy()}", onclick: retry, "Retry" }
            }
        }
    }
}

#[component]
fn InboxRow(
    invitation: Invitation,
    apps: Signal<Vec<kernel::App>>,
    contacts: Signal<Vec<Contact>>,
    on_open: EventHandler<(String, String, String)>,
    on_done: EventHandler<()>,
    error: Signal<Option<String>>,
) -> Element {
    let mut busy = use_signal(|| false);
    let adopt = {
        let id = invitation.id.clone();
        move |_| {
            if busy() {
                return;
            }
            busy.set(true);
            let id = id.clone();
            spawn(async move {
                match kernel::sharing_adopt(&id).await {
                    Ok(_instance) => on_done.call(()),
                    Err(e) => error.set(Some(e)),
                }
                busy.set(false);
            });
        }
    };
    let dismiss = {
        let id = invitation.id.clone();
        move |_| {
            let id = id.clone();
            spawn(async move {
                let _ = kernel::sharing_dismiss(&id).await;
                on_done.call(());
            });
        }
    };
    // "Open" is a distinct, explicit press from "Adopt", offered only once
    // an instance exists — adopting alone never launches anything.
    let app_id = invitation.app.clone();
    let open = {
        let instance = invitation.adopted_instance.clone();
        let app_id = app_id.clone();
        let label = invitation.label.clone();
        move |_| {
            if let Some(instance) = instance.clone() {
                on_open.call((app_id.clone(), instance, label.clone()));
            }
        }
    };
    let app_title = apps
        .read()
        .iter()
        .find(|a| a.id == app_id)
        .map(|a| a.title.expose().to_string())
        .unwrap_or_else(|| app_id.clone());
    let (placeholder, name) = person_label(&invitation.sender, &contacts.read());
    let name_class = if placeholder {
        format!("placeholder {}", Voice::Framework.class())
    } else {
        Voice::User.class().to_string()
    };

    rsx! {
        div { class: "app-row sharing-status-row",
            div { class: "app-row-title",
                span { class: "{Voice::Framework.class()}", "{invitation.label}" }
                span { class: "{name_class}", " from {name}" }
            }
            p { class: "{Voice::Framework.class()}",
                "{app_title} — {access_label(invitation.access)}"
                if invitation.history_and_resharing {
                    " — whole history, may reshare"
                }
            }
            div { class: "sharing-actions",
                if invitation.adopted_instance.is_none() {
                    button { disabled: "{busy()}", onclick: adopt, "Adopt" }
                } else {
                    button { onclick: open, "Open in {app_title}" }
                }
                button { onclick: dismiss, "Dismiss" }
            }
            p { class: "{Voice::Framework.class()}", "dismissing only hides this row; it does not revoke access" }
        }
    }
}

#[component]
pub(crate) fn SharingSheet(
    prompts: Signal<Vec<Prompt>>,
    outgoing: Signal<Vec<OutgoingItem>>,
    inbox: Signal<Vec<Invitation>>,
    mut contacts: Signal<Vec<Contact>>,
    apps: Signal<Vec<kernel::App>>,
    on_open_instance: EventHandler<(String, String, String)>,
) -> Element {
    let mut error = use_signal(|| None::<String>);

    use_future(move || async move {
        refresh_sharing(prompts, outgoing, inbox);
        // The recipient selector needs a contact list even when this pane
        // opens before Contacts ever has.
        if contacts.peek().is_empty()
            && let Ok(items) = kernel::contacts_items().await
        {
            contacts.set(items);
        }
    });

    let on_done = use_callback(move |()| {
        error.set(None);
        refresh_sharing(prompts, outgoing, inbox);
    });

    rsx! {
        div { class: "sheet sharing-sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Sharing" }
            }
            if let Some(message) = error() {
                div { class: "sheet-error framework", "{message}" }
            }

            if !prompts.read().is_empty() {
                div { class: "sheet-section",
                    div { class: "sharing-section-title {Voice::Framework.class()}", "Share this list" }
                    for prompt in prompts.read().iter().cloned() {
                        PromptRow { key: "{prompt.id}", prompt, contacts, on_done, error }
                    }
                }
            }

            div { class: "sheet-section",
                div { class: "sharing-section-title {Voice::Framework.class()}", "Outgoing" }
                if outgoing.read().is_empty() {
                    p { class: "{Voice::Framework.class()}", "nothing shared yet" }
                }
                for item in outgoing.read().iter().cloned() {
                    OutgoingRow { key: "{item.id}", item, contacts, on_done, error }
                }
            }

            div { class: "sheet-section",
                div { class: "sharing-section-title {Voice::Framework.class()}", "Received" }
                if inbox.read().is_empty() {
                    p { class: "{Voice::Framework.class()}", "nothing received yet" }
                }
                for invitation in inbox.read().iter().cloned() {
                    InboxRow {
                        key: "{invitation.id}",
                        invitation,
                        apps,
                        contacts,
                        on_open: on_open_instance,
                        on_done,
                        error,
                    }
                }
            }
        }
    }
}
