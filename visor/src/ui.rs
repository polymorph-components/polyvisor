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

use crate::kernel::{self, App, Entry, Event, Peer, SessionId, Status};
use crate::state::{Action, Drawer, Gate, Rest, Tenant, Tier, boot_drawer, dial_target};
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
///
/// Gated like [`read_status`]: this is called after the ceremonies that
/// change the device, and a user write landing while it is out must win.
async fn read_identity(
    mut status: Signal<Option<Status>>,
    mut apps: Signal<Vec<App>>,
    mut notice: Signal<Option<Notice>>,
    gate: CopyValue<Gate>,
) {
    let token = gate.peek().begin();
    match kernel::status().await {
        Err(e) => {
            notice.set(Some(Notice::Plain(e)));
            return;
        }
        Ok(s) => {
            if !gate.peek().apply(token) {
                return;
            }
            let sealed = s.is_sealed();
            status.set(Some(s));
            if sealed {
                apps.set(Vec::new());
                return;
            }
        }
    }
    match kernel::installed().await {
        Ok(list) => {
            if gate.peek().apply(token) {
                apps.set(list);
            }
        }
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

/// Re-read the device identity alone, and only write it if it actually
/// changed.
///
/// The endpoint id arrives after first paint — the bind is spawned, and
/// `device.status`'s `endpoint-id` is "" until it completes — so the Sync
/// section would show a device with no endpoint until something else
/// happened to re-read. This is that re-read, and it is deliberately
/// narrower than [`read_identity`]: the app list has not changed, and
/// re-reading it would only cost a round trip.
///
/// The equality guard is not an optimisation but the thing that keeps the
/// press cheap: `Signal::set` marks the scope dirty whether or not the
/// value moved, so an unguarded write would re-render the entire visor on
/// every Settings press for as long as the drawer is used.
///
/// The [`Gate`] is the other half, and it is a correctness rule rather than
/// a cost one: this read is spawned by the Settings press, and the user's
/// very next act in that sheet is usually to rename the device. A read that
/// started before the rename answers about the world before it, so applying
/// it would put the old name back — which is exactly the flake this closes.
async fn read_status(
    mut status: Signal<Option<Status>>,
    mut notice: Signal<Option<Notice>>,
    gate: CopyValue<Gate>,
) {
    let token = gate.peek().begin();
    match kernel::status().await {
        Ok(s) => {
            // A write landed while this was out: it describes the world
            // before that write, so it is dropped rather than applied. The
            // next Settings press reads again, and reads something newer.
            if !gate.peek().apply(token) {
                return;
            }
            // The read guard is dropped before the write: `status` is the
            // signal being compared and the signal being set.
            let changed = status.read().as_ref() != Some(&s);
            if changed {
                status.set(Some(s));
            }
        }
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

/// The peers this device has dialed. `sync.peers` is the only account of a
/// connection there is — the visor keeps none of its own — and this world
/// has no timer to poll with, so the read happens at the two moments a user
/// could care: opening Settings, and finishing a dial.
async fn read_peers(mut peers: Signal<Vec<Peer>>, mut notice: Signal<Option<Notice>>) {
    match kernel::peers().await {
        Ok(list) => peers.set(list),
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
    let peers = use_signal(Vec::<Peer>::new);

    // Two orderings, both between a spawned read and a user's write. They
    // are `CopyValue` rather than `Signal` on purpose: a generation is
    // bookkeeping about renders, not something to render, and subscribing
    // to it would re-render the visor on every press that bumps it.
    //
    // `status_gate`: bumped by everything that changes this device
    // (set-name, colour, word, keep, unseal), read by `read_status` and
    // `read_identity`.
    //
    // `drawer_gate`: bumped by every press that opens or closes a tenant,
    // read by the boot decision below — which is the only writer of
    // `drawer` that the user did not ask for.
    let mut status_gate = use_hook(|| CopyValue::new(Gate::default()));
    let mut drawer_gate = use_hook(|| CopyValue::new(Gate::default()));

    // The boot read: identity first, then the index, then whichever
    // ceremony the two of them together call for.
    //
    // This runs exactly once — `use_future` spawns from a `use_hook` and
    // has no reactive dependency on `status` (dioxus-hooks 0.7.10
    // `src/use_future.rs:63`), so a later status re-read cannot re-run it.
    // Running once is not enough on its own, though: it *finishes* late.
    // `visorReady` and the strip only wait for `device.status`, so the
    // Settings button goes live while `store.devices` is still in flight,
    // and a user who presses it then had the drawer shut under them when
    // the boot decided `Closed`. So the decision applies only if the user
    // has not touched the drawer meanwhile — after which it is not the
    // boot's business what is open.
    use_future(move || async move {
        let token = drawer_gate.peek().begin();
        read_identity(status, apps, notice, status_gate).await;
        let index = kernel::devices().await.unwrap_or_default();
        // The user has taken over: neither the decision nor the index it
        // was based on is the newest thing on screen any more. `entries` is
        // dropped along with the decision because the press that shows the
        // device index re-reads it (`show_devices`) and that read is
        // younger than this one.
        if !drawer_gate.peek().apply(token) {
            return;
        }
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

    // Every `drawer.set` below is a user's own doing, and each bumps
    // `drawer_gate` so a boot decision still in flight cannot undo it.
    let mut set_drawer = move |next: Drawer| {
        drawer_gate.write().bump();
        drawer.set(next);
    };

    let open = move |app: App| async move {
        match kernel::launch(&app.id).await {
            Err(e) => notice.set(Some(Notice::Plain(e))),
            Ok(id) => match kernel::open_frame(id).await {
                Ok(()) => {
                    notice.set(None);
                    session.set(Some((id, app)));
                    // The frame gets the screen; the drawer never covers it.
                    set_drawer(drawer().reduce(Action::Close));
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
        set_drawer(drawer().reduce(Action::Close));
    };

    // "Other devices": the index is cheap and the ages on it go stale, so
    // the press that shows the sheet is also the read.
    let show_devices = move |_| async move {
        entries.set(kernel::devices().await.unwrap_or_default());
        set_drawer(drawer().reduce(Action::Toggle(Tenant::Devices)));
    };

    // Every handler below is passed to a child *component*, and so has to
    // survive a re-render unchanged or the child cannot memoize.
    //
    // Dioxus decides whether to re-render a child by `PartialEq` on its
    // props, and `Callback`'s `PartialEq` is pointer equality on a
    // generational box that `Callback::new` allocates fresh (dioxus-core
    // 0.7.10 `src/events.rs:483` and `:472`) — so an inline closure written
    // straight into `rsx!` is a *different* handler every render, the props
    // never compare equal, and the child re-renders every time anything in
    // this component changes. Measured: with inline closures a child
    // re-renders on every unrelated parent render; behind `use_callback`
    // (which keeps one box and swaps its contents) it renders once and is
    // never asked again.
    //
    // They are also all written non-async on purpose: `use_callback` infers
    // its return type from the closure, so an `async move` body would make
    // these `Callback<_, impl Future>` rather than `EventHandler<_>`. The
    // work is `spawn`ed instead, which is exactly what an async handler
    // would have done.
    let toggle_apps = use_callback(move |t: Tenant| {
        set_drawer(drawer().reduce(Action::Toggle(t)));
    });

    // Settings carries two things that are only ever as fresh as their last
    // read: the peer list, and this device's own endpoint id — which is ""
    // until the spawned bind completes, so first paint has none. Both are
    // read by the press that shows the tenant, exactly as "Other devices"
    // is for the index. A press that *closes* Settings reads nothing.
    let show_settings = use_callback(move |t: Tenant| {
        let next = drawer().reduce(Action::Toggle(t));
        set_drawer(next);
        if next == Drawer::Open(Tenant::Settings) {
            spawn(async move {
                read_status(status, notice, status_gate).await;
                read_peers(peers, notice).await;
            });
        }
    });

    // Unseal is the one ceremony where a *later* status read is the point:
    // the seal opening is what the sheet was for. So the gate is bumped
    // first and the read that follows carries the new generation.
    let on_unsealed = use_callback(move |()| {
        status_gate.write().bump();
        spawn(async move {
            read_identity(status, apps, notice, status_gate).await;
            set_drawer(drawer().reduce(Action::Close));
        });
    });

    let on_stay = use_callback(move |()| set_drawer(drawer().reduce(Action::Close)));

    let on_kept = use_callback(move |persisted: bool| {
        status_gate.write().bump();
        spawn(async move {
            if !persisted {
                notice.set(Some(Notice::Plain(
                    "the browser declined to persist storage".into(),
                )));
            }
            read_identity(status, apps, notice, status_gate).await;
        });
    });

    let on_dialed = use_callback(move |()| {
        spawn(async move { read_peers(peers, notice).await });
    });

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
    let (self_id, tier, rest, petname, endpoint_id) = match status.read().as_ref() {
        Some(s) => (
            s.id.clone(),
            s.tier,
            s.rest,
            s.petname.clone(),
            s.endpoint_id.clone(),
        ),
        None => (
            String::new(),
            Tier::Ephemeral,
            Rest::RestsOpen,
            String::new(),
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
                    onpress: toggle_apps }
                TenantButton { label: "Settings", tenant: Tenant::Settings, open: tenant == Some(Tenant::Settings), disabled: !claimed,
                    onpress: show_settings }
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
                        UnsealSheet { petname: petname.clone(), on_open: on_unsealed }
                    },

                    Tenant::Devices => rsx! {
                        DevicesSheet {
                            entries: entries.read().clone(),
                            self_id: self_id.clone(),
                            on_stay,
                        }
                    },

                    Tenant::Settings => rsx! {
                        label {
                            span { class: "{Voice::Framework.class()}", "name" }
                            input {
                                r#type: "text",
                                // `initial_value`, not `value`. dioxus-html
                                // marks `value` *volatile*: it is written to
                                // the DOM on every diff, not only when it
                                // changed — so any re-render while the user
                                // is typing resets the field to whatever the
                                // kernel last said the name was. That is not
                                // hypothetical here: the press that opens
                                // this sheet spawns a `device.status` read,
                                // and the endpoint id binding makes it
                                // return *changed* — so the field was being
                                // cleared under the user between typing and
                                // committing, and the name was silently
                                // never set.
                                //
                                // Seeded once per opening of the tenant
                                // instead (the drawer rebuilds this arm each
                                // time), and the DOM owns the text from
                                // there: the visor writes on `change`, so
                                // there is nothing the signal needs to push
                                // back in.
                                initial_value: status.read().as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                                onchange: move |e| async move {
                                    // Bumped before the kernel call, not
                                    // after the local apply: a read already
                                    // in flight is answering about the name
                                    // this is replacing, whichever lands
                                    // first.
                                    status_gate.write().bump();
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
                                // Volatile, exactly as the name field above:
                                // a slider being dragged is a user write in
                                // the DOM, and a status read landing mid-drag
                                // would snap it back.
                                initial_value: "{status.read().as_ref().map(|s| s.hue).unwrap_or(0)}",
                                onchange: move |e| async move {
                                    let Ok(hue) = e.value().parse::<u16>() else { return };
                                    status_gate.write().bump();
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
                                    status_gate.write().bump();
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
                            KeepSheet { on_kept }
                        }

                        SyncSheet {
                            endpoint_id: endpoint_id.clone(),
                            peers: peers.read().clone(),
                            on_dialed,
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

/// Manual sync: this device's endpoint id to read off, a box to paste
/// another one into, and the peers dialed so far.
///
/// Deliberately spare — this chrome is slated for a redesign, and the
/// milestone's claim is convergence, not a device manager. Two shapes here
/// are decisions rather than omissions:
///
/// * The endpoint id is **selectable, not copyable**. The visor's world
///   (internal.wit `world visor`) grants no clipboard capability, and the
///   trusted pixels are exactly the wrong place to acquire one on a whim,
///   so the id is rendered for selection and the copy is the browser's own.
/// * Every peer's `state` is the kernel's framework voice, rendered as it
///   arrived (internal.wit `sync.peer`). The visor invents no row of its
///   own after a dial: `sync.peers` is the whole account.
#[component]
fn SyncSheet(endpoint_id: String, peers: Vec<Peer>, on_dialed: EventHandler<()>) -> Element {
    let mut typed = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);
    let mine = endpoint_id.clone();

    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Sync" }
            }
            div { class: "sync-self",
                span { class: "{Voice::Framework.class()}", "endpoint" }
                if endpoint_id.is_empty() {
                    // "" while sealed, and until the endpoint is bound
                    // (internal.wit `device-status.endpoint-id`). Settings
                    // is unreachable while sealed, so the case this reaches
                    // is the bind, which is spawned and lands after first
                    // paint — hence a verb, not an absence: this device
                    // will have an endpoint, it does not have one yet.
                    // Opening Settings re-reads `device.status`, so the
                    // next press is what replaces this.
                    span { class: "{Voice::Framework.class()} placeholder", "binding…" }
                } else {
                    span { id: "visor-endpoint-id", class: "endpoint-id", "{endpoint_id}" }
                }
            }
            label {
                span { class: "{Voice::Framework.class()}", "peer endpoint id" }
                input {
                    r#type: "text",
                    value: "{typed}",
                    oninput: move |e| typed.set(e.value()),
                }
            }
            button {
                onclick: move |_| {
                    let mine = mine.clone();
                    async move {
                        let Some(id) = dial_target(&typed(), &mine) else {
                            error.set(Some("paste another device's endpoint id".into()));
                            return;
                        };
                        match kernel::connect(id).await {
                            Ok(()) => {
                                error.set(None);
                                typed.set(String::new());
                                on_dialed.call(());
                            }
                            Err(e) => error.set(Some(e)),
                        }
                    }
                },
                "Connect"
            }
            // The honest sentence. Pairing — who may connect, and what they
            // may read — is M3b (internal.wit `interface sync`), and until
            // it exists a dial hands over everything.
            div { class: "{Voice::Framework.class()}",
                "a connected device is trusted with everything on this one; pairing comes later"
            }
            for peer in peers {
                div { key: "{peer.endpoint_id}", class: "peer-row",
                    span { class: "endpoint-id", "{peer.endpoint_id}" }
                    span { class: "{Voice::Framework.class()}", "{peer.state}" }
                }
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
