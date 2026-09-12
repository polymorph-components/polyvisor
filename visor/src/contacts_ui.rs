use std::collections::{BTreeMap, BTreeSet};

use dioxus::prelude::*;

use crate::contacts::{
    ClaimChoice, Qr, accept_signed, artifact_matches, default_name, generation_changed,
    issuer_display, key_short, name_claim, qr_matrix, received_label, selected, should_rebase,
    status_response_is_current,
};
use crate::kernel::{
    self, Contact, ImportReview, Introduction, MeetingPhase, MeetingRecord, Party, Provenance,
    Selection, SelfProfile,
};
use crate::voice::{AppText, AppVoice, Voice};

#[derive(Clone, PartialEq)]
pub(crate) enum Incoming {
    Contact(String),
    Meet(String),
}

#[derive(Clone, PartialEq)]
enum View {
    List,
    Detail(String),
    Profile,
    Create,
    Share,
    Import,
    Meet,
}

fn parse_key(value: &str) -> Result<Vec<u8>, String> {
    let compact: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Ok(Vec::new());
    }
    if !compact.is_ascii() || compact.len() % 2 != 0 {
        return Err("Enter the public key as pairs of hexadecimal digits.".into());
    }
    compact
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| "The public key is not hexadecimal.".into())
        })
        .collect()
}

fn full_key(key: &[u8]) -> String {
    if key.is_empty() {
        "no public key".into()
    } else {
        key.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

fn claim_choices(observations: &[kernel::Observation]) -> Vec<ClaimChoice> {
    observations
        .iter()
        .filter(|item| item.name.expose() != "name")
        .map(|item| ClaimChoice::new(item.name.expose(), item.value.expose()))
        .collect()
}

fn observed_name(preferred: Option<&str>, observations: &[kernel::Observation]) -> String {
    default_name(
        preferred,
        observations
            .iter()
            .filter(|item| item.name.expose() == "name" && item.provenance == Provenance::Local)
            .map(|item| (item.value.expose(), item.received)),
    )
}

fn rebase_choices(old: &[ClaimChoice], observations: &[kernel::Observation]) -> Vec<ClaimChoice> {
    claim_choices(observations)
        .into_iter()
        .map(|mut fresh| {
            fresh.selected = old.iter().any(|prior| {
                prior.name == fresh.name && prior.value == fresh.value && prior.selected
            });
            fresh
        })
        .collect()
}

pub(crate) fn refresh_contacts(
    mut contacts: Signal<Vec<Contact>>,
    mut profile: Signal<Option<SelfProfile>>,
    mut records: Signal<Vec<MeetingRecord>>,
) {
    spawn(async move {
        if let Ok(items) = kernel::contacts_items().await {
            contacts.set(items);
        }
        if let Ok(value) = kernel::contacts_profile().await {
            profile.set(Some(value));
        }
        if let Ok(items) = kernel::contacts_meetings().await {
            records.set(items);
        }
    });
}

async fn refresh_contacts_now(
    mut contacts: Signal<Vec<Contact>>,
    mut profile: Signal<Option<SelfProfile>>,
    mut records: Signal<Vec<MeetingRecord>>,
) -> Result<(), String> {
    let (items, self_profile, meetings) = (
        kernel::contacts_items().await?,
        kernel::contacts_profile().await?,
        kernel::contacts_meetings().await?,
    );
    contacts.set(items);
    profile.set(Some(self_profile));
    records.set(meetings);
    Ok(())
}

fn finish_mutation(
    result: Result<(), String>,
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    mut error: Signal<Option<String>>,
) {
    match result {
        Ok(()) => refresh_contacts(contacts, profile, records),
        Err(message) => error.set(Some(message)),
    }
}

#[component]
pub(crate) fn ContactsSheet(
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    meeting: Signal<MeetingPhase>,
    meeting_epoch: Signal<u64>,
    offered_card: Signal<Option<(u32, Party)>>,
    on_meeting_offer: EventHandler<Party>,
    on_meeting_join: EventHandler<(String, Party)>,
    pending_submission: Signal<Option<(u64, Party)>>,
    mut incoming: Signal<Option<Incoming>>,
) -> Element {
    let mut view = use_signal(|| View::List);
    let mut error = use_signal(|| None::<String>);
    let mut incoming_contact = use_signal(|| None::<String>);
    let mut incoming_meet = use_signal(|| None::<String>);
    let meet_choices = use_signal(Vec::<ClaimChoice>::new);
    let meet_name = use_signal(String::new);
    let meet_name_seed = use_signal(|| None::<String>);

    use_future(move || {
        let captured = meeting_epoch();
        async move {
            refresh_contacts(contacts, profile, records);
            if let Ok(value) = kernel::meeting_status().await
                && status_response_is_current(captured, meeting_epoch())
            {
                let mut meeting = meeting;
                meeting.set(value);
            }
        }
    });

    use_effect(move || {
        if let Some(value) = incoming() {
            incoming.set(None);
            match value {
                Incoming::Contact(body) => {
                    incoming_contact.set(Some(body));
                    view.set(View::Import);
                }
                Incoming::Meet(fragment) => {
                    incoming_meet.set(Some(fragment));
                    view.set(View::Meet);
                }
            }
        }
    });

    let mut navigate = move |next: View| {
        incoming_contact.set(None);
        incoming_meet.set(None);
        error.set(None);
        view.set(next);
    };

    rsx! {
        div { class: "sheet contacts-sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Contacts" }
            }
            div { class: "contacts-nav",
                button { onclick: move |_| navigate(View::List), "Contacts" }
                button { onclick: move |_| navigate(View::Profile), "My profile" }
                button { onclick: move |_| navigate(View::Create), "Create" }
                button { onclick: move |_| navigate(View::Share), "Share" }
                button { onclick: move |_| navigate(View::Import), "Import" }
                button { onclick: move |_| navigate(View::Meet), "Meet now" }
            }
            if let Some(message) = error() {
                div { class: "sheet-error framework", "{message}" }
            }
            match view() {
                View::List => rsx! { ContactList { contacts, view } },
                View::Detail(id) => rsx! {
                    ContactDetail { id, contacts, profile, records, error, view }
                },
                View::Profile => rsx! { ProfileView { contacts, profile, records, error } },
                View::Create => rsx! { CreateView { contacts, profile, records, error, view } },
                View::Share => rsx! { ShareView { contacts, profile, error } },
                View::Import => rsx! {
                    ImportView {
                        initial_body: incoming_contact(),
                        contacts,
                        profile,
                        records,
                        error,
                    }
                },
                View::Meet => rsx! {
                    MeetView {
                        initial_fragment: incoming_meet(),
                        profile,
                        meeting,
                        meeting_epoch,
                        own_choices: meet_choices,
                        shared_name: meet_name,
                        shared_name_seed: meet_name_seed,
                        offered_card,
                        on_meeting_offer,
                        on_meeting_join,
                        pending_submission,
                        error,
                    }
                },
            }
        }
    }
}

#[component]
fn ContactList(contacts: Signal<Vec<Contact>>, mut view: Signal<View>) -> Element {
    rsx! {
        div { class: "contacts-list",
            if contacts().is_empty() {
                p { class: "framework", "No contacts yet." }
            }
            for contact in contacts() {
                button {
                    class: "contact-row",
                    key: "{contact.id}",
                    onclick: {
                        let id = contact.id.clone();
                        move |_| view.set(View::Detail(id.clone()))
                    },
                    span { class: "user", "{contact.petname}" }
                    if let Some((_, value)) = contact.preferred.iter().find(|(name, _)| name == "name") {
                        span { class: "user", "{value}" }
                    } else if let Some(item) = contact.observations.iter().find(|item| item.name.expose() == "name") {
                        AppVoice { text: item.value.clone() }
                    }
                    code { title: "{full_key(&contact.public_key)}", "{key_short(&contact.public_key)}" }
                }
            }
        }
    }
}

#[component]
fn ContactDetail(
    id: String,
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    mut error: Signal<Option<String>>,
    mut view: Signal<View>,
) -> Element {
    let mut petname = use_signal(String::new);
    let mut claim_name = use_signal(String::new);
    let mut claim_value = use_signal(String::new);
    let mut merge_target = use_signal(String::new);
    let mut petname_seed = use_signal(|| None::<String>);
    let contact = contacts().into_iter().find(|contact| contact.id == id);

    use_effect({
        let id = id.clone();
        move || match contacts().into_iter().find(|contact| contact.id == id) {
            Some(contact)
                if should_rebase(&petname(), petname_seed().as_deref())
                    && petname_seed().as_deref() != Some(contact.petname.as_str()) =>
            {
                petname.set(contact.petname.clone());
                petname_seed.set(Some(contact.petname));
            }
            None => view.set(View::List),
            _ => {}
        }
    });

    let Some(contact) = contact else {
        return rsx! { div { class: "contact-details", "Contact no longer exists." } };
    };
    let contact_id = contact.id.clone();
    rsx! {
        div { class: "contact-details",
            button { onclick: move |_| view.set(View::List), "Back" }
            div { class: "key-full", code { "{full_key(&contact.public_key)}" } }
            label {
                span { "Petname" }
                input { value: "{petname}", oninput: move |event| petname.set(event.value()) }
            }
            button {
                onclick: {
                    let id = contact_id.clone();
                    move |_| {
                        let id = id.clone();
                        async move {
                            let saved = petname();
                            match kernel::contacts_set_petname(id, saved.clone()).await {
                                Ok(()) => {
                                    petname_seed.set(Some(saved));
                                    refresh_contacts(contacts, profile, records);
                                }
                                Err(message) => error.set(Some(message)),
                            }
                        }
                    }
                },
                "Save petname"
            }
            div { class: "contact-history",
                if contact.observations.is_empty() {
                    p { class: "framework", "No observations." }
                }
                for observation in contact.observations {
                    div { class: "observation-row",
                        AppVoice { text: observation.name.clone() }
                        AppVoice { text: observation.value.clone() }
                        if contact.preferred.iter().any(|pair| pair == &(observation.name.expose().into(), observation.value.expose().into())) {
                            span { class: "framework", "preferred" }
                        }
                        span { class: "framework",
                            "{provenance_label(observation.provenance)} · asserted {claimed_label(observation.claimed.as_ref())} · received {received_label(kernel::now_ms(), observation.received)}"
                        }
                        if !observation.issuer.is_empty() {
                            if let Some(name) = issuer_display(&observation.issuer, contacts().iter().map(|contact| (contact.public_key.as_slice(), contact.petname.as_str()))) {
                                span { class: "issuer-display",
                                    span { class: "framework", "issuer" }
                                    span { class: "user", "{name}" }
                                    code { title: "{full_key(&observation.issuer)}", "{key_short(&observation.issuer)}" }
                                }
                            } else {
                                code { title: "{full_key(&observation.issuer)}", "issuer {key_short(&observation.issuer)}" }
                            }
                        }
                        if let Some(record) = records().iter().find(|record| record.id == observation.meeting) {
                            div { class: "meeting-record",
                                div { class: "meeting-record-summary",
                                    span { class: "framework", "{record.method}" }
                                    span { class: "framework", " · {verification_label(record.verified)}" }
                                }
                                if !record.source.is_empty() {
                                    div { class: "framework", "Source: {record.source}" }
                                }
                                if !record.source_key.is_empty() {
                                    div { class: "meeting-record-source",
                                        span { class: "framework", "Source identity:" }
                                        if let Some(name) = issuer_display(&record.source_key, contacts().iter().map(|contact| (contact.public_key.as_slice(), contact.petname.as_str()))) {
                                            span { class: "user", "{name}" }
                                        }
                                        code { title: "{full_key(&record.source_key)}", "{key_short(&record.source_key)}" }
                                    }
                                }
                                div { class: "framework",
                                    "Received {received_label(kernel::now_ms(), record.occurred)}"
                                }
                            }
                        }
                        button {
                            onclick: {
                                let id = contact_id.clone();
                                let name = observation.name.expose().to_string();
                                let value = observation.value.expose().to_string();
                                move |_| {
                                    let id = id.clone();
                                    let name = name.clone();
                                    let value = value.clone();
                                    async move {
                                        finish_mutation(kernel::contacts_set_preferred(id, name, Some(value)).await, contacts, profile, records, error);
                                    }
                                }
                            },
                            "Prefer"
                        }
                        if contact.preferred.iter().any(|(name, _)| name == observation.name.expose()) {
                            button {
                                onclick: {
                                    let id = contact_id.clone();
                                    let name = observation.name.expose().to_string();
                                    move |_| {
                                        let id = id.clone();
                                        let name = name.clone();
                                        async move {
                                            finish_mutation(kernel::contacts_set_preferred(id, name, None).await, contacts, profile, records, error);
                                        }
                                    }
                                },
                                "Clear preferred"
                            }
                        }
                        button {
                            onclick: {
                                let id = contact_id.clone();
                                let name = observation.name.expose().to_string();
                                let value = observation.value.expose().to_string();
                                move |_| {
                                    let id = id.clone();
                                    let name = name.clone();
                                    let value = value.clone();
                                    async move {
                                        finish_mutation(kernel::contacts_remove_observation(id, name, value).await, contacts, profile, records, error);
                                    }
                                }
                            },
                            "Remove"
                        }
                    }
                }
            }
            label { span { "Claim name" } input { value: "{claim_name}", oninput: move |event| claim_name.set(event.value()) } }
            label { span { "Claim value" } input { value: "{claim_value}", oninput: move |event| claim_value.set(event.value()) } }
            button {
                onclick: {
                    let id = contact_id.clone();
                    move |_| {
                        let id = id.clone();
                        async move {
                            finish_mutation(kernel::contacts_set_observation(id, claim_name(), claim_value()).await, contacts, profile, records, error);
                        }
                    }
                },
                "Add observation"
            }
            if contact.public_key.is_empty() {
                label {
                    span { "Merge into" }
                    select { value: "{merge_target}", onchange: move |event| merge_target.set(event.value()),
                        option { value: "", "Choose a keyed contact" }
                        for target in contacts().into_iter().filter(|target| !target.public_key.is_empty()) {
                            option { value: "{target.id}", "{target.petname} · {key_short(&target.public_key)}" }
                        }
                    }
                }
                button {
                    disabled: merge_target().is_empty(),
                    onclick: {
                        let from = contact_id.clone();
                        move |_| {
                            let from = from.clone();
                            async move {
                                match kernel::contacts_merge(from, merge_target()).await {
                                    Ok(()) => {
                                        refresh_contacts(contacts, profile, records);
                                        view.set(View::List);
                                    }
                                    Err(message) => error.set(Some(message)),
                                }
                            }
                        }
                    },
                    "Merge keyless contact"
                }
            }
            button {
                onclick: {
                    let id = contact_id.clone();
                    move |_| {
                        let id = id.clone();
                        async move { match kernel::contacts_delete(id).await {
                            Ok(()) => {
                                refresh_contacts(contacts, profile, records);
                                view.set(View::List);
                            }
                            Err(message) => error.set(Some(message)),
                        }}
                    }
                },
                "Delete contact"
            }
        }
    }
}

#[component]
fn ProfileView(
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    mut error: Signal<Option<String>>,
) -> Element {
    let mut name = use_signal(String::new);
    let mut value = use_signal(String::new);
    rsx! {
        div { class: "contacts-profile",
            if let Some(profile_value) = profile() {
                div { class: "key-full", code { "{full_key(&profile_value.public_key)}" } }
                if profile_value.observations.is_empty() {
                    p { class: "framework", "No profile claims." }
                }
                for item in profile_value.observations {
                    div { class: "observation-row",
                        AppVoice { text: item.name.clone() }
                        AppVoice { text: item.value.clone() }
                        button {
                            onclick: {
                                let claim_name = item.name.expose().to_string();
                                let claim_value = item.value.expose().to_string();
                                move |_| {
                                    let claim_name = claim_name.clone();
                                    let claim_value = claim_value.clone();
                                    async move { match kernel::contacts_remove_self_observation(claim_name, claim_value).await {
                                        Ok(()) => refresh_contacts(contacts, profile, records),
                                        Err(message) => error.set(Some(message)),
                                    }}
                                }
                            },
                            "Remove"
                        }
                    }
                }
            }
            label { span { "Claim name" } input { value: "{name}", oninput: move |event| name.set(event.value()) } }
            label { span { "Claim value" } input { value: "{value}", oninput: move |event| value.set(event.value()) } }
            button {
                disabled: name().is_empty() || value().is_empty(),
                onclick: move |_| async move {
                    match kernel::contacts_set_self_observation(name(), value()).await {
                        Ok(()) => refresh_contacts(contacts, profile, records),
                        Err(message) => error.set(Some(message)),
                    }
                },
                "Add to my profile"
            }
        }
    }
}

#[component]
fn CreateView(
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    mut error: Signal<Option<String>>,
    mut view: Signal<View>,
) -> Element {
    let mut key = use_signal(String::new);
    let mut petname = use_signal(String::new);
    rsx! {
        div { class: "contacts-create",
            label { span { "Public key (hex, optional)" } input { value: "{key}", oninput: move |event| key.set(event.value()) } }
            label { span { "Petname" } input { value: "{petname}", oninput: move |event| petname.set(event.value()) } }
            button {
                onclick: move |_| async move {
                    match parse_key(&key()) {
                        Err(message) => error.set(Some(message)),
                        Ok(bytes) => match kernel::contacts_create(bytes, petname()).await {
                            Ok(id) => match refresh_contacts_now(contacts, profile, records).await {
                                Ok(()) => view.set(View::Detail(id)),
                                Err(message) => error.set(Some(message)),
                            },
                            Err(message) => error.set(Some(message)),
                        },
                    }
                },
                "Create contact"
            }
        }
    }
}

#[component]
fn ShareView(
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    mut error: Signal<Option<String>>,
) -> Element {
    let mut included = use_signal(BTreeSet::<String>::new);
    let mut choices_by_id = use_signal(BTreeMap::<String, Vec<ClaimChoice>>::new);
    let mut names = use_signal(BTreeMap::<String, String>::new);
    let mut name_baselines = use_signal(BTreeMap::<String, String>::new);
    let mut signed = use_signal(|| None::<(Introduction, Vec<u8>)>);
    let mut share_gen = use_signal(|| 0u64);
    let mut signing = use_signal(|| false);
    let mut source_snapshot = use_signal(|| None::<(SelfProfile, Vec<Contact>)>);

    use_effect(move || {
        if let Some(profile) = profile() {
            let live = contacts();
            let snapshot = (profile.clone(), live.clone());
            let source_changed = source_snapshot().as_ref() != Some(&snapshot);
            let old_rows = choices_by_id();
            let mut rows = BTreeMap::new();
            rows.insert(
                "self".into(),
                rebase_choices(
                    old_rows.get("self").map(Vec::as_slice).unwrap_or_default(),
                    &profile.observations,
                ),
            );
            let live_ids: BTreeSet<_> = live.iter().map(|contact| contact.id.clone()).collect();
            let mut selected_ids = included();
            selected_ids.retain(|id| live_ids.contains(id));
            for contact in live
                .iter()
                .filter(|contact| selected_ids.contains(&contact.id))
            {
                rows.insert(
                    contact.id.clone(),
                    rebase_choices(
                        old_rows
                            .get(&contact.id)
                            .map(Vec::as_slice)
                            .unwrap_or_default(),
                        &contact.observations,
                    ),
                );
            }
            let mut next_names = names();
            let mut next_baselines = name_baselines();
            rebase_name(
                "self",
                observed_name(None, &profile.observations),
                &mut next_names,
                &mut next_baselines,
            );
            for contact in &live {
                let preferred = contact
                    .preferred
                    .iter()
                    .find(|(name, _)| name == "name")
                    .map(|(_, value)| value.as_str());
                rebase_name(
                    &contact.id,
                    observed_name(preferred, &contact.observations),
                    &mut next_names,
                    &mut next_baselines,
                );
            }
            next_names.retain(|id, _| id == "self" || live_ids.contains(id));
            next_baselines.retain(|id, _| id == "self" || live_ids.contains(id));
            if rows != old_rows
                || selected_ids != included()
                || next_names != names()
                || next_baselines != name_baselines()
            {
                choices_by_id.set(rows);
                included.set(selected_ids);
                names.set(next_names);
                name_baselines.set(next_baselines);
            }
            if source_changed {
                source_snapshot.set(Some(snapshot));
                signed.set(None);
                share_gen.set(share_gen().wrapping_add(1));
            }
        }
    });

    let Some(profile_value) = profile() else {
        return rsx! { div { class: "contacts-share", p { class: "framework", "Profile unavailable." } } };
    };
    let assemble = move || {
        let choices = choices_by_id();
        let issuer = Party {
            public_key: profile_value.public_key.clone(),
            claims: with_draft_name(
                names().get("self"),
                choices
                    .get("self")
                    .map(|items| selected(items))
                    .unwrap_or_default(),
            ),
        };
        let parties = contacts()
            .into_iter()
            .filter(|contact| included().contains(&contact.id) && !contact.public_key.is_empty())
            .map(|contact| Party {
                public_key: contact.public_key,
                claims: with_draft_name(
                    names().get(&contact.id),
                    choices
                        .get(&contact.id)
                        .map(|items| selected(items))
                        .unwrap_or_default(),
                ),
            })
            .collect();
        Introduction { issuer, parties }
    };
    let preview = assemble();

    rsx! {
        div { class: "contacts-share",
            h3 { "My claims" }
            ShareName { id: "self", names, signed, share_gen, signing }
            ClaimChecks { id: "self", choices_by_id, signed, share_gen, signing }
            h3 { "Other contacts" }
            for contact in contacts().into_iter().filter(|contact| !contact.public_key.is_empty()) {
                label {
                    input {
                        r#type: "checkbox",
                        checked: included().contains(&contact.id),
                        disabled: signing(),
                        onchange: {
                            let id = contact.id.clone();
                            let observations = contact.observations.clone();
                            move |event| {
                                signed.set(None);
                                share_gen.set(share_gen().wrapping_add(1));
                                let mut selected_ids = included();
                                let mut rows = choices_by_id();
                                if event.checked() {
                                    selected_ids.insert(id.clone());
                                    rows.entry(id.clone()).or_insert_with(|| claim_choices(&observations));
                                } else {
                                    selected_ids.remove(&id);
                                    rows.remove(&id);
                                }
                                included.set(selected_ids);
                                choices_by_id.set(rows);
                            }
                        },
                    }
                    span { class: "user", "{contact.petname}" }
                }
                if included().contains(&contact.id) {
                    ShareName { id: contact.id.clone(), names, signed, share_gen, signing }
                    ClaimChecks { id: contact.id.clone(), choices_by_id, signed, share_gen, signing }
                }
            }
            div { class: "contacts-share-preview",
                h3 { "Exact preview" }
                PartyPreview { party: preview.issuer.clone() }
                for party in preview.parties.clone() {
                    PartyPreview { party }
                }
            }
            button {
                disabled: signing(),
                onclick: move |_| {
                    let exact_preview = assemble();
                    let captured = share_gen();
                    async move {
                        signing.set(true);
                        match kernel::contacts_share(exact_preview.clone()).await {
                            Ok(bytes) if accept_signed(captured, share_gen()) => signed.set(Some((exact_preview, bytes))),
                            Ok(_) => {}
                            Err(message) => error.set(Some(message)),
                        }
                        signing.set(false);
                    }
                },
                "Sign contact card"
            }
            if let Some((signed_preview, signed_bytes)) = signed()
                && artifact_matches(&signed_preview, &preview)
            {
                div { class: "contacts-share-export",
                    button {
                        onclick: {
                            let bytes = signed_bytes.clone();
                            move |_| {
                                let bytes = bytes.clone();
                                async move { if let Err(message) = kernel::save_contact_file("contact.polycontact".into(), &bytes).await {
                                error.set(Some(message));
                                }}
                            }
                        },
                        "Save contact file"
                    }
                    button {
                        onclick: {
                            let bytes = signed_bytes.clone();
                            move |_| {
                            let bytes = bytes.clone();
                            async move { let link = format!("{}#contact/{}", kernel::page_url(), base64url(&bytes));
                            if let Err(message) = kernel::copy_text(link).await {
                                error.set(Some(message));
                            }} }
                        },
                        "Copy share link"
                    }
                }
            }
        }
    }
}

#[component]
fn ClaimChecks(
    id: String,
    mut choices_by_id: Signal<BTreeMap<String, Vec<ClaimChoice>>>,
    mut signed: Signal<Option<(Introduction, Vec<u8>)>>,
    mut share_gen: Signal<u64>,
    signing: Signal<bool>,
) -> Element {
    let row = choices_by_id().get(&id).cloned().unwrap_or_default();
    rsx! {
        div { class: "claim-choices",
            for (index, claim) in row.into_iter().enumerate() {
                label {
                    input {
                        r#type: "checkbox",
                        checked: claim.selected,
                        disabled: signing(),
                        onchange: {
                            let id = id.clone();
                            move |event| {
                                signed.set(None);
                                share_gen.set(share_gen().wrapping_add(1));
                                let mut rows = choices_by_id();
                                if let Some(items) = rows.get_mut(&id)
                                    && let Some(item) = items.get_mut(index)
                                {
                                    item.selected = event.checked();
                                }
                                choices_by_id.set(rows);
                            }
                        },
                    }
                    AppVoice { text: AppText::from_kernel(claim.name) }
                    AppVoice { text: AppText::from_kernel(claim.value) }
                }
            }
        }
    }
}

#[component]
fn ShareName(
    id: String,
    mut names: Signal<BTreeMap<String, String>>,
    mut signed: Signal<Option<(Introduction, Vec<u8>)>>,
    mut share_gen: Signal<u64>,
    signing: Signal<bool>,
) -> Element {
    let value = names().get(&id).cloned().unwrap_or_default();
    rsx! {
        label {
            span { "Shared name" }
            input {
                value: "{value}",
                disabled: signing(),
                oninput: move |event| {
                    let mut current = names();
                    current.insert(id.clone(), event.value());
                    names.set(current);
                    signed.set(None);
                    share_gen.set(share_gen().wrapping_add(1));
                },
            }
        }
    }
}

fn with_draft_name(
    name: Option<&String>,
    mut claims: Vec<(String, String)>,
) -> Vec<(String, String)> {
    claims.retain(|(claim, _)| claim != "name");
    if let Some(claim) = name.and_then(|value| name_claim(value)) {
        claims.insert(0, claim);
    }
    claims
}

fn rebase_name(
    id: &str,
    latest: String,
    drafts: &mut BTreeMap<String, String>,
    baselines: &mut BTreeMap<String, String>,
) {
    let clean = should_rebase(
        drafts.get(id).map(String::as_str).unwrap_or_default(),
        baselines.get(id).map(String::as_str),
    );
    if clean {
        drafts.insert(id.into(), latest.clone());
    }
    baselines.insert(id.into(), latest);
}

#[component]
fn PartyPreview(party: Party) -> Element {
    rsx! {
        div { class: "share-party",
            code { "{full_key(&party.public_key)}" }
            for (name, value) in party.claims {
                AppVoice { text: AppText::from_kernel(name) }
                AppVoice { text: AppText::from_kernel(value) }
            }
        }
    }
}

#[component]
fn ImportView(
    initial_body: Option<String>,
    contacts: Signal<Vec<Contact>>,
    profile: Signal<Option<SelfProfile>>,
    records: Signal<Vec<MeetingRecord>>,
    mut error: Signal<Option<String>>,
) -> Element {
    let mut review = use_signal(|| None::<ImportReview>);
    let mut bytes = use_signal(Vec::<u8>::new);
    let mut source = use_signal(String::new);
    let mut checks = use_signal(BTreeSet::<(u32, String, String)>::new);
    let mut included_parties = use_signal(BTreeSet::<u32>::new);
    let mut busy = use_signal(|| false);
    let mut generation = use_hook(|| CopyValue::new(0u64));

    let mut begin_preview = move |next_bytes: Vec<u8>, next_source: String| {
        let token = generation.peek().wrapping_add(1);
        generation.set(token);
        busy.set(true);
        review.set(None);
        checks.set(BTreeSet::new());
        included_parties.set(BTreeSet::new());
        bytes.set(next_bytes.clone());
        source.set(next_source);
        spawn(async move {
            let result = kernel::contacts_import_preview(&next_bytes).await;
            if generation() != token {
                return;
            }
            busy.set(false);
            match result {
                Ok(value) => {
                    included_parties.set(value.parties.iter().map(|party| party.index).collect());
                    review.set(Some(value));
                }
                Err(message) => error.set(Some(message)),
            }
        });
    };

    use_effect(move || {
        if let Some(body) = initial_body.clone() {
            let token = generation.peek().wrapping_add(1);
            generation.set(token);
            busy.set(true);
            review.set(None);
            checks.set(BTreeSet::new());
            included_parties.set(BTreeSet::new());
            bytes.set(Vec::new());
            source.set("contact link".into());
            spawn(async move {
                let result = match kernel::decode_link(body).await {
                    Ok(decoded) => kernel::contacts_import_preview(&decoded)
                        .await
                        .map(|review| (decoded, review)),
                    Err(message) => Err(message),
                };
                if generation() != token {
                    return;
                }
                busy.set(false);
                match result {
                    Ok((decoded, value)) => {
                        bytes.set(decoded);
                        included_parties
                            .set(value.parties.iter().map(|party| party.index).collect());
                        review.set(Some(value));
                    }
                    Err(message) => error.set(Some(message)),
                }
            });
        }
    });

    rsx! {
        div { class: "contacts-import-review",
            button {
                disabled: busy(),
                onclick: move |_| async move {
                    match kernel::read_contact_file().await {
                        Ok(Some((filename, file_bytes))) => begin_preview(file_bytes, filename),
                        Ok(None) => {}
                        Err(message) => error.set(Some(message)),
                    }
                },
                "Choose contact file"
            }
            if busy() {
                p { class: "framework", "Reviewing…" }
            }
            if let Some(review_value) = review() {
                span { class: "framework", "{review_value.summary}" }
                for party in review_value.parties {
                    div { class: "import-party",
                        label {
                            input {
                                class: "import-party-include",
                                r#type: "checkbox",
                                checked: included_parties().contains(&party.index),
                                onchange: {
                                    let index = party.index;
                                    move |event| {
                                        let mut parties = included_parties();
                                        if event.checked() { parties.insert(index); } else { parties.remove(&index); }
                                        included_parties.set(parties);
                                    }
                                },
                            }
                            "Include this identity"
                        }
                        div { class: "key-full", code { "subject {full_key(&party.public_key)}" } }
                        div { class: "key-full", code { "issuer {full_key(&party.issuer)}" } }
                        span { class: "framework",
                            "{provenance_label(party.provenance)} · asserted {claimed_label(party.claimed.as_ref())}"
                        }
                        span { class: "framework", "{import_outcome(&party.public_key, &contacts())}" }
                        for (name, value) in party.claims {
                            label {
                                input {
                                    r#type: "checkbox",
                                    onchange: {
                                        let index = party.index;
                                        let name_raw = name.expose().to_string();
                                        let value_raw = value.expose().to_string();
                                        move |event| {
                                            let item = (index, name_raw.clone(), value_raw.clone());
                                            let mut selected_items = checks();
                                            if event.checked() {
                                                selected_items.insert(item);
                                            } else {
                                                selected_items.remove(&item);
                                            }
                                            checks.set(selected_items);
                                        }
                                    },
                                }
                                AppVoice { text: name.clone() }
                                AppVoice { text: value.clone() }
                            }
                        }
                    }
                }
                button {
                    disabled: busy(),
                    onclick: move |_| async move {
                        let mut grouped = BTreeMap::<u32, Vec<(String, String)>>::new();
                        for index in included_parties() {
                            grouped.entry(index).or_default();
                        }
                        for (index, name, value) in checks() {
                            if included_parties().contains(&index) {
                                grouped.entry(index).or_default().push((name, value));
                            }
                        }
                        let selections = grouped
                            .into_iter()
                            .map(|(index, claims)| Selection { index, claims })
                            .collect();
                        busy.set(true);
                        match kernel::contacts_import_accept(&bytes(), source(), selections).await {
                            Ok(_) => {
                                bytes.set(Vec::new());
                                review.set(None);
                                checks.set(BTreeSet::new());
                                included_parties.set(BTreeSet::new());
                                refresh_contacts(contacts, profile, records);
                            }
                            Err(message) => error.set(Some(message)),
                        }
                        busy.set(false);
                    },
                    "Import selected claims"
                }
            }
        }
    }
}

#[component]
fn MeetView(
    initial_fragment: Option<String>,
    profile: Signal<Option<SelfProfile>>,
    mut meeting: Signal<MeetingPhase>,
    mut meeting_epoch: Signal<u64>,
    mut own_choices: Signal<Vec<ClaimChoice>>,
    mut shared_name: Signal<String>,
    mut shared_name_seed: Signal<Option<String>>,
    mut offered_card: Signal<Option<(u32, Party)>>,
    on_meeting_offer: EventHandler<Party>,
    on_meeting_join: EventHandler<(String, Party)>,
    pending_submission: Signal<Option<(u64, Party)>>,
    mut error: Signal<Option<String>>,
) -> Element {
    let fragment = use_signal(|| initial_fragment.unwrap_or_default());
    let mut peer_keep = use_signal(BTreeSet::<(String, String)>::new);
    let mut peer_generation = use_signal(|| None::<u32>);
    let active = !matches!(
        meeting(),
        MeetingPhase::Idle | MeetingPhase::Done(_) | MeetingPhase::Failed(_)
    );

    use_effect(move || {
        if let Some(value) = profile()
            && !active
        {
            let rebased = rebase_choices(&own_choices(), &value.observations);
            if rebased != own_choices() {
                own_choices.set(rebased);
            }
            let next_name = observed_name(None, &value.observations);
            let baseline = shared_name_seed();
            if baseline.is_none() || baseline.as_deref() == Some(shared_name().as_str()) {
                // Same guard as above: only write when the value changes, or
                // the effect re-dirties its own inputs and spins.
                if shared_name() != next_name {
                    shared_name.set(next_name.clone());
                }
                if shared_name_seed().as_deref() != Some(next_name.as_str()) {
                    shared_name_seed.set(Some(next_name));
                }
            }
        }
    });

    let Some(profile_value) = profile() else {
        return rsx! { div { class: "meet-now", "Profile unavailable." } };
    };
    let card = move || Party {
        public_key: profile_value.public_key.clone(),
        claims: with_draft_name(Some(&shared_name()), selected(&own_choices())),
    };
    use_effect(move || {
        if let MeetingPhase::AwaitingConfirm { generation, .. } = meeting()
            && generation_changed(peer_generation(), generation)
        {
            peer_generation.set(Some(generation));
            peer_keep.set(BTreeSet::new());
        }
        // Guard the reset writes: `Signal::set` marks the scope dirty
        // unconditionally, so writing `None`/empty on every run when the
        // meeting is already inactive re-triggers this effect forever (the
        // Meet-now main-thread hang). Only write when the value actually
        // changes.
        if !active {
            if peer_generation().is_some() {
                peer_generation.set(None);
            }
            if !peer_keep().is_empty() {
                peer_keep.set(BTreeSet::new());
            }
        }
    });

    rsx! {
        div { class: "meet-now",
            div { class: "meet-own-claims",
                if let Some((_, card)) = pending_submission() {
                    p { class: "framework", "Submitting… you offered:" }
                    PartyPreview { party: card }
                } else if let Some(generation) = active_generation(&meeting()) {
                    if let Some((stored_generation, card)) = offered_card()
                        && stored_generation == generation
                    {
                        p { class: "framework", "You offered:" }
                        PartyPreview { party: card }
                    } else {
                        p { class: "framework", "This meeting was started elsewhere; its offered card is not available in this tab." }
                    }
                } else {
                    p { class: "framework", "Choose what you will present." }
                    label {
                        span { "Shared name" }
                        input {
                            value: "{shared_name}",
                            disabled: pending_submission().is_some(),
                            oninput: move |event| shared_name.set(event.value()),
                        }
                    }
                    for (index, claim) in own_choices().into_iter().enumerate() {
                        label {
                            input {
                                r#type: "checkbox",
                                checked: claim.selected,
                                disabled: pending_submission().is_some(),
                                onchange: move |event| {
                                    let mut items = own_choices();
                                    if let Some(item) = items.get_mut(index) {
                                        item.selected = event.checked();
                                    }
                                    own_choices.set(items);
                                },
                            }
                            AppVoice { text: AppText::from_kernel(claim.name) }
                            AppVoice { text: AppText::from_kernel(claim.value) }
                        }
                    }
                }
            }
            if fragment().is_empty() && active_generation(&meeting()).is_none() && pending_submission().is_none() {
                button {
                    onclick: move |_| {
                        let exact = card();
                        on_meeting_offer.call(exact);
                    },
                    "Offer meeting"
                }
            } else if !fragment().is_empty() && matches!(meeting(), MeetingPhase::Idle | MeetingPhase::Failed(_)) {
                div { class: "meet-join-review",
                    p { class: "framework", "Review what you will share before joining." }
                    button {
                        disabled: pending_submission().is_some(),
                        onclick: move |_| {
                            let exact = card();
                            on_meeting_join.call((fragment(), exact));
                        },
                        "Join meeting"
                    }
                }
            }
            match meeting() {
                MeetingPhase::Idle => rsx! {},
                MeetingPhase::Offering { generation, link } => rsx! {
                    div { class: "meet-offer",
                        if let Ok(matrix) = qr_matrix(link.as_bytes()) { Qr { modules: matrix } }
                        code { "{link}" }
                        button {
                            onclick: {
                                let link = link.clone();
                                move |_| {
                                    let link = link.clone();
                                    async move { if let Err(message) = kernel::copy_text(link).await {
                                        error.set(Some(message));
                                    }}
                                }
                            },
                            "Copy link"
                        }
                        button {
                            class: "meet-cancel",
                            onclick: move |_| async move {
                                meeting_epoch.set(meeting_epoch().wrapping_add(1));
                                match kernel::meeting_cancel(generation).await {
                                    Ok(()) => { update_meeting(meeting, meeting_epoch, error).await; }
                                    Err(message) => error.set(Some(message)),
                                }
                            },
                            "Cancel offer"
                        }
                    }
                },
                MeetingPhase::Dialing(generation) => rsx! {
                    div { class: "meet-dialing",
                        p { class: "framework", "Connecting…" }
                        button {
                            class: "meet-cancel",
                            onclick: move |_| async move {
                                meeting_epoch.set(meeting_epoch().wrapping_add(1));
                                match kernel::meeting_cancel(generation).await {
                                    Ok(()) => { update_meeting(meeting, meeting_epoch, error).await; }
                                    Err(message) => error.set(Some(message)),
                                }
                            },
                            "Cancel meeting"
                        }
                    }
                },
                MeetingPhase::AwaitingConfirm { generation, sas, peer_key, claims } => rsx! {
                    div { class: "meet-confirm",
                        p { class: "framework",
                            "Compare this code with the other person. Confirm only if both codes match."
                        }
                        div { class: "meet-sas", "{sas}" }
                        div { class: "key-full", code { "{full_key(&peer_key)}" } }
                        p { class: "framework", "Choose details to save" }
                        for (name, value) in claims {
                            label {
                                input {
                                    r#type: "checkbox",
                                    checked: peer_generation() == Some(generation)
                                        && peer_keep().contains(&(name.expose().to_string(), value.expose().to_string())),
                                    onchange: {
                                        let name_raw = name.expose().to_string();
                                        let value_raw = value.expose().to_string();
                                        move |event| {
                                            let item = (name_raw.clone(), value_raw.clone());
                                            let mut keep = peer_keep();
                                            if event.checked() { keep.insert(item); } else { keep.remove(&item); }
                                            peer_keep.set(keep);
                                        }
                                    },
                                }
                                AppVoice { text: name.clone() }
                                AppVoice { text: value.clone() }
                            }
                        }
                        button {
                            onclick: move |_| async move {
                                let keep = if peer_generation() == Some(generation) {
                                    peer_keep().into_iter().collect()
                                } else {
                                    Vec::new()
                                };
                                match kernel::meeting_confirm(generation, keep).await {
                                    Ok(()) => { update_meeting(meeting, meeting_epoch, error).await; }
                                    Err(message) => error.set(Some(message)),
                                }
                            },
                            "Confirm"
                        }
                        button {
                            class: "meet-cancel",
                            onclick: move |_| async move {
                                meeting_epoch.set(meeting_epoch().wrapping_add(1));
                                match kernel::meeting_cancel(generation).await {
                                    Ok(()) => { update_meeting(meeting, meeting_epoch, error).await; }
                                    Err(message) => error.set(Some(message)),
                                }
                            },
                            "Cancel meeting"
                        }
                    }
                },
                MeetingPhase::AwaitingPeer(generation) => rsx! {
                    div { class: "meet-awaiting-peer",
                        p { class: "framework", "Waiting for the other person…" }
                        button {
                            class: "meet-cancel",
                            onclick: move |_| async move {
                                meeting_epoch.set(meeting_epoch().wrapping_add(1));
                                match kernel::meeting_cancel(generation).await {
                                    Ok(()) => { update_meeting(meeting, meeting_epoch, error).await; }
                                    Err(message) => error.set(Some(message)),
                                }
                            },
                            "Cancel meeting"
                        }
                    }
                },
                MeetingPhase::Done(id) => rsx! { p { class: "framework", "Meeting complete. Contact {id}" } },
                MeetingPhase::Failed(message) => rsx! { p { class: "sheet-error framework", "{message}" } },
            }
        }
    }
}

async fn update_meeting(
    meeting: Signal<MeetingPhase>,
    meeting_epoch: Signal<u64>,
    error: Signal<Option<String>>,
) -> Option<MeetingPhase> {
    let captured = meeting_epoch();
    update_meeting_at(meeting, meeting_epoch, captured, error).await
}

async fn update_meeting_at(
    mut meeting: Signal<MeetingPhase>,
    meeting_epoch: Signal<u64>,
    captured: u64,
    mut error: Signal<Option<String>>,
) -> Option<MeetingPhase> {
    match kernel::meeting_status().await {
        Ok(value) if status_response_is_current(captured, meeting_epoch()) => {
            meeting.set(value.clone());
            Some(value)
        }
        Ok(_) => None,
        Err(message) => {
            error.set(Some(message));
            None
        }
    }
}

fn active_generation(phase: &MeetingPhase) -> Option<u32> {
    match phase {
        MeetingPhase::Offering { generation, .. }
        | MeetingPhase::Dialing(generation)
        | MeetingPhase::AwaitingConfirm { generation, .. }
        | MeetingPhase::AwaitingPeer(generation) => Some(*generation),
        MeetingPhase::Idle | MeetingPhase::Done(_) | MeetingPhase::Failed(_) => None,
    }
}

fn provenance_label(value: Provenance) -> &'static str {
    match value {
        Provenance::Local => "local",
        Provenance::Imported => "imported",
        Provenance::Verified => "verified assertion",
    }
}

fn verification_label(verified: bool) -> &'static str {
    if verified { "verified" } else { "not verified" }
}

fn claimed_label(value: Option<&kernel::ClaimedTime>) -> String {
    let Some(value) = value else {
        return "not supplied".into();
    };
    let days = value.seconds.div_euclid(86_400);
    let (year, month, day) = civil_date(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_date(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn import_outcome(key: &[u8], contacts: &[Contact]) -> &'static str {
    if key.is_empty() {
        "Keyless: choose an established identity explicitly after import."
    } else if contacts.iter().any(|contact| contact.public_key == key) {
        "Same key: merges automatically."
    } else {
        "New key: creates a contact; different keys never merge silently."
    }
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((value >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(TABLE[(value & 63) as usize] as char);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_parser_accepts_keyless_and_rejects_unicode_without_panicking() {
        assert_eq!(parse_key("  "), Ok(Vec::new()));
        assert!(parse_key("é0").is_err());
        assert_eq!(parse_key("00 01"), Ok(vec![0, 1]));
    }

    #[test]
    fn calendar_dates_include_pre_epoch_values() {
        assert_eq!(civil_date(0), (1970, 1, 1));
        assert_eq!(civil_date(-1), (1969, 12, 31));
    }

    #[test]
    fn base64url_is_unpadded() {
        assert_eq!(base64url(&[0, 1, 2]), "AAEC");
        assert_eq!(base64url(&[0]), "AA");
    }
}
