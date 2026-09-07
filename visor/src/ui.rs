//! The trusted pixels: the strip, and the drawer behind it.
//!
//! The strip is the trust anchor — always present, fixed height, and the
//! only place the device identity is shown. The drawer is everything that
//! needs room: the app list, the device settings, and the two device
//! ceremonies (unseal, and the entry picker). Both are rendered by this one
//! component so there is exactly one tree, and no ordering question about
//! which of them the receiver mounts first.
//!
//! The visor holds no state of its own beyond what is on screen right now
//! (docs/design.md "Visor and apps render through stream-dom"): identity,
//! hue, word, the app list and the device index are kernel state, read at
//! mount and re-read only when the visor itself changed them.
//!
//! The one rule the whole file is arranged around (design.md "Devices"):
//! **the anchor colour is never painted before the device is `open`.** A
//! page imitating the picker must not be able to show the user's own
//! colour, so the hue reaches the DOM through exactly one expression, and
//! that expression is unreachable unless `device.status` said `open`.

use dioxus::prelude::*;

use crate::kernel::{self, App, Entry, Event, SessionId, Status};
use crate::state::{Action, Drawer, Rest, Tenant, Tier, boot_drawer};
use crate::style::CSS;
use crate::voice::{AppText, AppVoice, Voice, coarse_age};

/// What the strip says when nothing is running. Two shapes because a
/// session ending is framework voice with the app's *title* plated — the
/// one place the two voices share a sentence.
#[derive(Clone, PartialEq)]
enum Notice {
    Plain(String),
    Ended { app: AppText, reason: String },
}

/// Read the device's identity, and the app list unless the device is
/// sealed. The app list is skipped while sealed on purpose: every kernel
/// call other than `status`/`unseal`/`erase` answers `unavailable` then
/// (internal.wit `device`), so asking would only manufacture an error to
/// show. A `fresh` device is read in full — it is not sealed, and
/// internal.wit `device` rules that "`fresh` is not a gate".
async fn read_identity(
    mut status: Signal<Option<Status>>,
    mut apps: Signal<Vec<App>>,
    mut notice: Signal<Option<Notice>>,
) {
    match kernel::status().await {
        Err(e) => {
            notice.set(Some(Notice::Plain(e)));
            return;
        }
        Ok(s) => {
            let sealed = s.is_sealed();
            status.set(Some(s));
            if sealed {
                apps.set(Vec::new());
                return;
            }
        }
    }
    match kernel::installed().await {
        Ok(list) => apps.set(list),
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

#[component]
pub(crate) fn Visor() -> Element {
    let mut drawer = use_signal(Drawer::default);
    let mut status = use_signal(|| None::<Status>);
    let apps = use_signal(Vec::<App>::new);
    let mut entries = use_signal(Vec::<Entry>::new);
    let mut session = use_signal(|| None::<(SessionId, App)>);
    let mut notice = use_signal(|| None::<Notice>);

    // The boot read: identity first, then the index, then whichever
    // ceremony the two of them together call for.
    use_future(move || async move {
        read_identity(status, apps, notice).await;
        let index = kernel::devices().await.unwrap_or_default();
        if let Some(s) = status.read().as_ref() {
            let others_kept = index
                .iter()
                .any(|e| e.id != s.id && e.tier == Tier::Durable);
            drawer.set(boot_drawer(s.state, s.tier, &s.petname, others_kept));
        }
        entries.set(index);
    });

    // The long poll. A session ending here is one the visor did not ask
    // for (`apps.close` emits nothing), so it always has something to say.
    use_future(move || async move {
        loop {
            let Event::SessionEnded(ended, reason) = kernel::next_event().await;
            let current = session.read().as_ref().map(|(id, app)| (*id, app.clone()));
            if let Some((id, app)) = current
                && id == ended
            {
                let _ = kernel::close_frame(id).await;
                session.set(None);
                notice.set(Some(Notice::Ended {
                    app: app.title,
                    reason,
                }));
            }
        }
    });

    let open = move |app: App| async move {
        match kernel::launch(&app.id).await {
            Err(e) => notice.set(Some(Notice::Plain(e))),
            Ok(id) => match kernel::open_frame(id).await {
                Ok(()) => {
                    notice.set(None);
                    session.set(Some((id, app)));
                    // The frame gets the screen; the drawer never covers it.
                    drawer.set(drawer().reduce(Action::Close));
                }
                Err(e) => {
                    // The session outlived the frame that was to show it;
                    // leaving it live would leak a session id per failure.
                    let _ = kernel::close(id).await;
                    notice.set(Some(Notice::Plain(e)));
                }
            },
        }
    };

    let close_session = move |id: SessionId| async move {
        let _ = kernel::close_frame(id).await;
        if let Err(e) = kernel::close(id).await {
            notice.set(Some(Notice::Plain(e)));
        }
        session.set(None);
        drawer.set(drawer().reduce(Action::Close));
    };

    // "Other devices": the index is cheap and the ages on it go stale, so
    // the press that shows the sheet is also the read.
    let show_devices = move |_| async move {
        entries.set(kernel::devices().await.unwrap_or_default());
        drawer.set(drawer().reduce(Action::Toggle(Tenant::Devices)));
    };

    let live = session.read().as_ref().map(|(id, app)| (*id, app.clone()));
    let tenant = drawer().tenant();
    let ident = Ident::of(&status.read());
    // The whole strip wears the unclaimed dress while the seal is shut, so
    // "no identity to show" is one fact with one rendering, not a
    // per-element negotiation.
    //
    // The predicate is `state != sealed`, not `state == open`. internal.wit
    // `device`: "`fresh` is not a gate: an ephemeral device is fully
    // usable, and its colour is freshly minted, so painting it before
    // \"keep\" gives an impostor nothing." Only the passphrase tier has a
    // screen worth imitating, and that is the one this greys.
    let claimed = matches!(ident, Ident::Open(_));
    let strip_class = if claimed { "" } else { "unclaimed" };
    let (self_id, tier, rest, petname) = match status.read().as_ref() {
        Some(s) => (s.id.clone(), s.tier, s.rest, s.petname.clone()),
        None => (
            String::new(),
            Tier::Ephemeral,
            Rest::RestsOpen,
            String::new(),
        ),
    };

    rsx! {
        // The trusted pixels depend on nothing the page provides, so the
        // visor ships its own stylesheet as part of its own tree.
        style { "{CSS}" }

        div { id: "visor-strip", class: "{strip_class}",
            Identity { ident }
            div { id: "visor-context",
                match (&live, &*notice.read()) {
                    (Some((_, app)), _) => rsx! {
                        span { class: "{Voice::Framework.class()}", "showing " }
                        AppVoice { text: app.title.clone() }
                    },
                    (None, Some(Notice::Ended { app, reason })) => rsx! {
                        AppVoice { text: app.clone() }
                        span { class: "{Voice::Framework.class()}", " ended: {reason}" }
                    },
                    (None, Some(Notice::Plain(message))) => rsx! {
                        span { class: "{Voice::Framework.class()}", "{message}" }
                    },
                    (None, None) => rsx! {
                        span { class: "{Voice::Framework.class()}", "nothing is running" }
                    },
                }
            }
            div { id: "visor-actions",
                // Both tenants need a kernel that answers, so neither is
                // offered before the seal opens; the ceremony the boot
                // raised is what the user has to act on instead.
                TenantButton { label: "Apps", tenant: Tenant::Apps, open: tenant == Some(Tenant::Apps), disabled: !claimed,
                    onpress: move |t| drawer.set(drawer().reduce(Action::Toggle(t))) }
                TenantButton { label: "Settings", tenant: Tenant::Settings, open: tenant == Some(Tenant::Settings), disabled: !claimed,
                    onpress: move |t| drawer.set(drawer().reduce(Action::Toggle(t))) }
                if let Some((id, _)) = live {
                    button { onclick: move |_| async move { close_session(id).await }, "Close" }
                }
            }
        }

        if let Some(tenant) = tenant {
            div { id: "visor-drawer",
                match tenant {
                    Tenant::Apps => rsx! {
                        for app in apps.read().iter().cloned() {
                            div { key: "{app.id}", class: "app-row",
                                div { class: "app-row-title", AppVoice { text: app.title.clone() } }
                                button {
                                    onclick: move |_| { let app = app.clone(); async move { open(app).await } },
                                    "Open"
                                }
                            }
                        }
                        if apps.read().is_empty() {
                            span { class: "{Voice::Framework.class()}", "no apps are installed" }
                        }
                    },

                    Tenant::Unseal => rsx! {
                        UnsealSheet {
                            petname: petname.clone(),
                            on_open: move |()| async move {
                                read_identity(status, apps, notice).await;
                                drawer.set(drawer().reduce(Action::Close));
                            },
                        }
                    },

                    Tenant::Devices => rsx! {
                        DevicesSheet {
                            entries: entries.read().clone(),
                            self_id: self_id.clone(),
                            on_stay: move |()| drawer.set(drawer().reduce(Action::Close)),
                        }
                    },

                    Tenant::Settings => rsx! {
                        label {
                            span { class: "{Voice::Framework.class()}", "name" }
                            input {
                                r#type: "text",
                                value: status.read().as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                                onchange: move |e| async move {
                                    let name = e.value();
                                    match kernel::set_name(name.clone()).await {
                                        Ok(()) => status.with_mut(|s| { if let Some(s) = s { s.name = name } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                            }
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "colour" }
                            input {
                                r#type: "range", min: "0", max: "359",
                                value: "{status.read().as_ref().map(|s| s.hue).unwrap_or(0)}",
                                onchange: move |e| async move {
                                    let Ok(hue) = e.value().parse::<u16>() else { return };
                                    match kernel::set_hue(hue).await {
                                        Ok(()) => status.with_mut(|s| { if let Some(s) = s { s.hue = hue } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                            }
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "word" }
                            span { class: "{Voice::Framework.class()}", "{status.read().as_ref().map(|s| s.word.clone()).unwrap_or_default()}" }
                            button {
                                onclick: move |_| async move {
                                    match kernel::reroll_word().await {
                                        Ok(word) => status.with_mut(|s| { if let Some(s) = s { s.word = word } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                                "Reroll"
                            }
                        }

                        if tier == Tier::Durable {
                            KeptNote { petname: petname.clone(), rest }
                        } else {
                            KeepSheet {
                                on_kept: move |persisted: bool| async move {
                                    if !persisted {
                                        notice.set(Some(Notice::Plain(
                                            "the browser declined to persist storage".into(),
                                        )));
                                    }
                                    read_identity(status, apps, notice).await;
                                },
                            }
                        }

                        div { class: "sheet",
                            button { onclick: show_devices, "Other devices" }
                            EraseControl {}
                        }
                    },
                }
            }
        }
    }
}

/// The identity as the strip draws it. Three cases, not an `Option`, so
/// "we have not asked yet" and "the kernel answered, and this device is
/// sealed" are different sentences — and so that the only variant carrying
/// a hue is one the kernel said was unsealed.
#[derive(Clone, PartialEq)]
enum Ident {
    /// No answer from `device.status` yet.
    Waking,
    /// Answered `sealed`: nothing personal is readable (name, hue and word
    /// come back blank), so nothing personal is drawn.
    Unclaimed,
    /// `fresh` or `open` — both fully usable, both painted.
    Open(Anchor),
}

impl Ident {
    fn of(status: &Option<Status>) -> Ident {
        match status {
            None => Ident::Waking,
            Some(s) if s.is_sealed() => Ident::Unclaimed,
            Some(s) => Ident::Open(Anchor::of(s)),
        }
    }
}

/// The painted identity. A plain value so `Identity` is a pure function of
/// it and re-renders only when the identity changed.
#[derive(Clone, PartialEq)]
struct Anchor {
    name: String,
    hue: u16,
}

impl Anchor {
    fn of(status: &Status) -> Anchor {
        Anchor {
            name: status.name.clone(),
            hue: status.hue,
        }
    }
}

#[component]
fn Identity(ident: Ident) -> Element {
    let anchor = match ident {
        // No circle colour, no name, no word: the greys come from the
        // `.unclaimed` rule on the strip, and no hue is computed at all.
        Ident::Waking => {
            return rsx! {
                div { id: "visor-identity",
                    div { id: "visor-circle" }
                    span { class: "{Voice::Framework.class()} placeholder", "waking" }
                }
            };
        }
        Ident::Unclaimed => {
            return rsx! {
                div { id: "visor-identity",
                    div { id: "visor-circle" }
                    span { class: "{Voice::Framework.class()} placeholder", "no device open" }
                }
            };
        }
        Ident::Open(a) => a,
    };
    rsx! {
        div { id: "visor-identity",
            // Per-element, not a theme variable: the hue is this device's
            // identity, and identity does not cascade. This is the single
            // site that paints it, and it is inside the `Open` arm.
            div { id: "visor-circle", style: "background: hsl({anchor.hue}deg 65% 50%)" }
            if anchor.name.is_empty() {
                span { class: "{Voice::Framework.class()} placeholder", "this device" }
            } else {
                span { class: "{Voice::User.class()}", "{anchor.name}" }
            }
            // The anchor word is a recognition secret between the user and
            // this device: spoken only in the settings sheet, on request,
            // never left standing in the strip.
        }
    }
}

/// The login. Raised by the boot when `device.status` says `sealed`; the
/// only thing on screen that can do anything, because every other kernel
/// call is `unavailable` until it succeeds.
#[component]
fn UnsealSheet(petname: String, on_open: EventHandler<()>) -> Element {
    let mut passphrase = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);

    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                // The petname is the user's own label for this device, and
                // the index carries it in the clear precisely so a sealed
                // boot can say which device is asking.
                if petname.is_empty() {
                    span { class: "{Voice::Framework.class()}", "this device is sealed" }
                } else {
                    span { class: "{Voice::User.class()}", "{petname}" }
                    span { class: "{Voice::Framework.class()}", " is sealed" }
                }
            }
            input {
                r#type: "password",
                value: "{passphrase}",
                oninput: move |e| passphrase.set(e.value()),
            }
            button {
                onclick: move |_| async move {
                    match kernel::unseal(passphrase()).await {
                        Ok(()) => {
                            passphrase.set(String::new());
                            error.set(None);
                            on_open.call(());
                        }
                        // Refused: the message is the kernel's own framework
                        // voice, and the sheet stays exactly where it is.
                        Err(e) => error.set(Some(e)),
                    }
                },
                "Unseal"
            }
            if let Some(message) = error() {
                div { class: "{Voice::Framework.class()} sheet-error", "{message}" }
            }
            // A forgotten passphrase is exactly when erase is needed, and
            // internal.wit `device` permits it while sealed for that
            // reason: "a forgotten passphrase must not make a device
            // un-erasable". Same two-step confirm as in Settings.
            EraseControl {}
        }
    }
}

/// The entry picker: every device on this origin, and the choice to stay
/// on this one. Raised by the boot for a brand-new device on an origin
/// that already holds a kept one, and reachable from Settings.
#[component]
fn DevicesSheet(entries: Vec<Entry>, self_id: String, on_stay: EventHandler<()>) -> Element {
    // Read once per render: every row's age is relative to the same now.
    let now = kernel::now_ms();
    let others: Vec<Entry> = entries.into_iter().filter(|e| e.id != self_id).collect();

    rsx! {
        div { class: "sheet",
            for entry in others {
                div { key: "{entry.id}", class: "device-row",
                    div { class: "device-row-name",
                        if entry.petname.is_empty() {
                            span { class: "{Voice::Framework.class()}", "unnamed device" }
                        } else {
                            span { class: "{Voice::User.class()}", "{entry.petname}" }
                        }
                    }
                    span { class: "{Voice::Framework.class()}",
                        if entry.tier == Tier::Durable { "kept" } else { "ephemeral" }
                    }
                    span { class: "{Voice::Framework.class()}", "{coarse_age(now, entry.last_used)}" }
                    button {
                        onclick: move |_| {
                            // Terminal: the anchor is the tab's
                            // sessionStorage pointer and the worker is named
                            // after it, so this reloads the page.
                            kernel::switch_device(Some(entry.id.clone()));
                        },
                        "Continue"
                    }
                }
            }
            button { onclick: move |_| on_stay.call(()), "Start fresh here" }
        }
    }
}

/// "Keep this device": the promotion from ephemeral to durable, and the
/// one place the user chooses how the device rests.
#[component]
fn KeepSheet(on_kept: EventHandler<bool>) -> Element {
    let mut petname = use_signal(String::new);
    let mut under_passphrase = use_signal(|| false);
    let mut first = use_signal(String::new);
    let mut second = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);

    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Keep this device" }
            }
            label {
                span { class: "{Voice::Framework.class()}", "petname" }
                input {
                    r#type: "text",
                    value: "{petname}",
                    oninput: move |e| petname.set(e.value()),
                }
            }
            div { class: "choice",
                button {
                    aria_pressed: "{!under_passphrase()}",
                    onclick: move |_| under_passphrase.set(false),
                    "rests open on this browser"
                }
                button {
                    aria_pressed: "{under_passphrase()}",
                    onclick: move |_| under_passphrase.set(true),
                    "passphrase"
                }
            }
            if under_passphrase() {
                input { r#type: "password", value: "{first}", oninput: move |e| first.set(e.value()) }
                input { r#type: "password", value: "{second}", oninput: move |e| second.set(e.value()) }
            } else {
                // design.md "Devices": rests-open is an honest tier, and
                // the visor says exactly what it is protected by.
                div { class: "{Voice::Framework.class()}",
                    "protected only by this browser profile's access control"
                }
            }
            button {
                onclick: move |_| async move {
                    let passphrase = if under_passphrase() {
                        if first() != second() {
                            error.set(Some("the two passphrases do not match".into()));
                            return;
                        }
                        if first().is_empty() {
                            error.set(Some("a passphrase is needed to seal this device".into()));
                            return;
                        }
                        Some(first())
                    } else {
                        None
                    };
                    if let Err(e) = kernel::keep(petname(), passphrase).await {
                        error.set(Some(e));
                        return;
                    }
                    error.set(None);
                    first.set(String::new());
                    second.set(String::new());
                    // The device is durable either way; persistence only
                    // decides how evictable it is, so its answer is a note
                    // and never a failure.
                    on_kept.call(kernel::request_persistence().await);
                },
                "Keep"
            }
            if let Some(message) = error() {
                div { class: "{Voice::Framework.class()} sheet-error", "{message}" }
            }
        }
    }
}

/// What a kept device shows instead of the keep form.
#[component]
fn KeptNote(petname: String, rest: Rest) -> Element {
    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "kept as " }
                if petname.is_empty() {
                    span { class: "{Voice::Framework.class()}", "an unnamed device" }
                } else {
                    span { class: "{Voice::User.class()}", "{petname}" }
                }
            }
            div { class: "{Voice::Framework.class()}",
                match rest {
                    Rest::RestsOpen => "rests open on this browser — protected only by this browser profile's access control",
                    Rest::Passphrase => "rests under a passphrase — unsealing is the login, every session",
                }
            }
        }
    }
}

/// Erase, behind a second press. The first press only arms it: an
/// unrecoverable act does not happen on one click.
#[component]
fn EraseControl() -> Element {
    let mut armed = use_signal(|| false);
    let mut error = use_signal(|| None::<String>);

    rsx! {
        if armed() {
            button {
                onclick: move |_| async move {
                    match kernel::erase().await {
                        // Nothing is left to render against, so the tab
                        // re-anchors to a fresh device and reloads.
                        Ok(()) => kernel::switch_device(None),
                        Err(e) => {
                            armed.set(false);
                            error.set(Some(e));
                        }
                    }
                },
                "Erase — this cannot be undone"
            }
        } else {
            button { onclick: move |_| armed.set(true), "Erase this device" }
        }
        if let Some(message) = error() {
            div { class: "{Voice::Framework.class()} sheet-error", "{message}" }
        }
    }
}

/// A strip button that opens its tenant. `aria-pressed` is the open state
/// the stylesheet keys off, so pressed-ness is one fact, not two.
#[component]
fn TenantButton(
    label: String,
    tenant: Tenant,
    open: bool,
    disabled: bool,
    onpress: EventHandler<Tenant>,
) -> Element {
    rsx! {
        button {
            aria_pressed: "{open}",
            disabled: "{disabled}",
            onclick: move |_| onpress.call(tenant),
            "{label}"
        }
    }
}
