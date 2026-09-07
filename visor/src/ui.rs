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

use crate::kernel::{self, App, Binding, Entry, Event, Member, Peer, SessionId, Status};
use crate::state::{
    Action, Drawer, Gate, Phase, Rest, Tenant, Tier, boot_drawer, claim_code, grouped,
};
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

/// The device group (internal.wit `sync.members`). Read alongside the
/// peers, and again whenever a ceremony ends in `done` — an enrollment is
/// precisely a change to this list, and it is the only thing on the screen
/// that proves the pairing did anything.
async fn read_members(mut members: Signal<Vec<Member>>, mut notice: Signal<Option<Notice>>) {
    match kernel::members().await {
        Ok(list) => members.set(list),
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

/// The store binding (internal.wit `storage.status`). Read alongside the
/// peers and the group: this world has no timer, so a store's state is
/// only ever as fresh as the last press that read it.
async fn read_storage(mut binding: Signal<Option<Binding>>, mut notice: Signal<Option<Notice>>) {
    match kernel::storage_status().await {
        // Guarded like `read_status`: `Signal::set` marks the scope dirty
        // whether or not the value moved, and this is re-read on every
        // Settings press and every storage act.
        Ok(b) => {
            let changed = binding.read().as_ref() != Some(&b);
            if changed {
                binding.set(Some(b));
            }
        }
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

/// Where the ceremony stands, from the kernel.
///
/// `pairing.status` is the ceremony's one authority: the visor never
/// advances the phase on its own guess about what a button did, because
/// half the transitions belong to the *other* device. This read happens
/// after every act, on every "Refresh", and on the press that opens
/// Settings; the kernel's `events.pairing-changed` covers the rest.
async fn read_pairing(
    pairing_phase: Signal<Phase>,
    members: Signal<Vec<Member>>,
    notice: Signal<Option<Notice>>,
) {
    match kernel::pairing_status().await {
        Ok(next) => apply_phase(next, pairing_phase, members, notice).await,
        Err(e) => {
            let mut notice = notice;
            notice.set(Some(Notice::Plain(e)))
        }
    }
}

/// Put a phase on screen, whichever of the two paths it arrived by (a read
/// after an act, or the kernel's push).
///
/// Two things hang off the transition rather than off the rendering. The
/// equality guard is the first: `Signal::set` marks the scope dirty
/// whether or not the value moved, and both paths deliver the same phase
/// routinely. The `done` announcement is the second — it belongs to the
/// *moment* the group changed, and the guard is what keeps it from being
/// said again on every later read that still says `done`.
async fn apply_phase(
    next: Phase,
    mut pairing_phase: Signal<Phase>,
    members: Signal<Vec<Member>>,
    mut notice: Signal<Option<Notice>>,
) {
    if *pairing_phase.read() == next {
        return;
    }
    let paired = next == Phase::Done;
    pairing_phase.set(next);
    if paired {
        // Framework voice, in the strip's context line: the ceremony is
        // over and the drawer may well be shut by the time it lands.
        notice.set(Some(Notice::Plain("device paired".into())));
        read_members(members, notice).await;
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
    let members = use_signal(Vec::<Member>::new);
    let pairing_phase = use_signal(Phase::default);
    let binding = use_signal(|| None::<Binding>);

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
            match kernel::next_event().await {
                Event::SessionEnded(ended, reason) => {
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
                // The other device acted: a peer that confirmed, an offer
                // that expired, an enrollment that landed. Nothing else
                // could bring those to the screen — there is no timer here
                // and `pairing.status` may not park (internal.wit
                // `event-source`).
                Event::PairingChanged(next) => {
                    apply_phase(next, pairing_phase, members, notice).await;
                }
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
    // Everything the Devices section shows is only ever as fresh as its
    // last read, and there is no timer in this world to make it otherwise.
    // So one refresh, used by three things: the press that opens Settings,
    // the section's own "Refresh" button, and every pairing act (each of
    // which is a phase change the kernel is the authority on).
    let refresh_devices = use_callback(move |()| {
        spawn(async move {
            read_status(status, notice, status_gate).await;
            read_peers(peers, notice).await;
            read_members(members, notice).await;
            read_pairing(pairing_phase, members, notice).await;
        });
    });

    // The Storage section's own re-read: the press that opens Settings,
    // and every act in the section (connect, sync, disconnect), each of
    // which changes what `storage.status` answers.
    let refresh_storage = use_callback(move |()| {
        spawn(async move {
            read_storage(binding, notice).await;
        });
    });

    let show_settings = use_callback(move |t: Tenant| {
        let next = drawer().reduce(Action::Toggle(t));
        set_drawer(next);
        if next == Drawer::Open(Tenant::Settings) {
            refresh_devices.call(());
            refresh_storage.call(());
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

                        StorageSection {
                            binding: binding.read().clone(),
                            on_refresh: refresh_storage,
                        }

                        DevicesSection {
                            endpoint_id: endpoint_id.clone(),
                            members: members.read().clone(),
                            peers: peers.read().clone(),
                            phase: pairing_phase.read().clone(),
                            on_refresh: refresh_devices,
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

/// Durable storage on a dumb store the user owns (internal.wit `storage`).
///
/// The section is arranged around one fact: the kernel is the only
/// authority on what a binding is doing. `binding.state` is the kernel's
/// own framework voice and is rendered unparaphrased, exactly as a peer's
/// state is; the visor adds no sentence about a store beyond the ones it
/// composes about its own acts (a ceremony that did not come back, a field
/// left empty).
///
/// The client pair is typed here and goes straight through to
/// `oauth-start`. Nothing about it is kept: the kernel seals what it needs
/// and the fields are cleared, so the trusted pixels are not a second home
/// for the user's credentials.
///
/// The ceremony's shape is fixed by the split in internal.wit `storage`:
/// the kernel mints the URL (`oauth-start`), the *page* opens the window
/// (`shell.open-popup`, which is why the visor can run this at all), and
/// the kernel exchanges the pair the window brought back
/// (`oauth-complete`). The visor never sees a token and never sees a
/// window.
#[component]
fn StorageSection(binding: Option<Binding>, on_refresh: EventHandler<()>) -> Element {
    let now = kernel::now_ms();
    let mut client_id = use_signal(String::new);
    let mut client_secret = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);
    // The ceremony is a window the user is looking at somewhere else, and
    // this glue holds no handle to it any more (docs/design.md "Windows and
    // handles"), so all the visor knows is that it asked and has not been
    // answered. Read in the render body below — a signal written and never
    // read renders once forever (docs/design.md, the visor-dioxus costs).
    let mut waiting = use_signal(|| false);

    // Same shape as the Devices section's `acted`: show the kernel's
    // refusal if it refused, then re-read, because what the binding is now
    // is the kernel's answer and never this button's assumption about it.
    let mut acted = move |result: Result<(), String>| {
        match result {
            Ok(()) => error.set(None),
            Err(e) => error.set(Some(e)),
        }
        on_refresh.call(());
    };

    let connect = move |_| async move {
        // An empty client id is refused by the kernel, in the kernel's own
        // words (`storage.oauth-start`). The visor does not compose a
        // second sentence for it.
        let url = match kernel::oauth_start(client_id(), client_secret()).await {
            Ok(url) => url,
            Err(e) => {
                error.set(Some(e));
                return;
            }
        };
        // Set only once there is a URL to open: an `oauth-start` the kernel
        // refused never opened a window, so there is nothing to wait for.
        waiting.set(true);
        match kernel::open_popup(url).await {
            // `none` is a ceremony that did not come back: consent declined,
            // the window closed, or nothing inside the glue's bound
            // (internal.wit `shell.open-popup`). None of those is a failure
            // the kernel has to hear about — the ceremony it minted is
            // simply not completed, and pressing Connect again mints
            // another.
            None => {
                waiting.set(false);
                error.set(Some(
                    "the sign-in window closed without authorizing this device".into(),
                ));
                on_refresh.call(());
            }
            Some((code, state)) => {
                waiting.set(false);
                client_id.set(String::new());
                client_secret.set(String::new());
                acted(kernel::oauth_complete(code, state).await);
            }
        }
    };

    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Storage" }
            }
            match binding.as_ref() {
                // Before the first `storage.status` answers. Not "not
                // connected": that is a state the kernel says, and saying
                // it here would be the visor guessing.
                None => rsx! {
                    span { class: "{Voice::Framework.class()} placeholder", "reading the store…" }
                },
                Some(b) => rsx! {
                    // The kernel's own words, whichever of the four they
                    // are — including "needs re-authorization: <why>",
                    // whose reason the visor neither shortens nor rewrites.
                    div { id: "visor-storage-state", class: "{Voice::Framework.class()}", "{b.state}" }

                    if b.connected() {
                        div { class: "{Voice::Framework.class()}",
                            if b.last_pull == 0 {
                                "nothing pulled yet"
                            } else {
                                "last pull {coarse_age(now, b.last_pull)} ago"
                            }
                        }
                        div { class: "{Voice::Framework.class()}",
                            if b.last_push == 0 {
                                "nothing pushed yet"
                            } else {
                                "last push {coarse_age(now, b.last_push)} ago"
                            }
                        }
                        button {
                            onclick: move |_| async move { acted(kernel::sync_now().await) },
                            "Sync now"
                        }
                        button {
                            // Forgets the tokens; internal.wit `storage`:
                            // "does not touch the store". So the sentence
                            // says what happens and does not imply the
                            // user's own objects went anywhere.
                            onclick: move |_| async move { acted(kernel::storage_disconnect().await) },
                            "Disconnect"
                        }
                    }

                    if b.needs_ceremony() {
                        label {
                            span { class: "{Voice::Framework.class()}", "client id" }
                            input {
                                r#type: "text",
                                value: "{client_id}",
                                oninput: move |e| client_id.set(e.value()),
                            }
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "client secret" }
                            input {
                                r#type: "text",
                                value: "{client_secret}",
                                oninput: move |e| client_secret.set(e.value()),
                            }
                        }
                        // internal.wit `storage.oauth-client`, said once and
                        // plainly: Google documents the installed-app secret
                        // as not treated as a secret, and this framework
                        // bakes none in. A `type=password` field above would
                        // contradict exactly that, which is why neither is
                        // one.
                        div { class: "{Voice::Framework.class()}",
                            "an installed-app client pair — the secret gates nothing without your consent, and nothing is built in"
                        }
                        button {
                            onclick: connect,
                            disabled: "{waiting}",
                            "Connect Google Drive"
                        }
                        if waiting() {
                            div { class: "{Voice::Framework.class()}",
                                "waiting for the sign-in window…"
                            }
                        }
                    }
                },
            }
            if let Some(message) = error() {
                div { class: "{Voice::Framework.class()} sheet-error", "{message}" }
            }
        }
    }
}

/// Devices: this device's group, the pairing ceremony, and the peers
/// dialed so far.
///
/// Deliberately spare — this chrome is slated for a redesign, and the
/// milestone's claim is a group that pairs and converges, not a device
/// manager. Three shapes here are decisions rather than omissions:
///
/// * Endpoint ids and pairing codes are **selectable, not copyable**. The
///   visor's world (internal.wit `world visor`) grants no clipboard
///   capability, and the trusted pixels are exactly the wrong place to
///   acquire one on a whim, so both are rendered for selection and the
///   copy is the browser's own.
/// * There is no box to paste a stranger's endpoint id into any more.
///   Membership is the sync policy (internal.wit `sync`: "a non-member is
///   refused with `refused`"), so the only dial that can succeed is a dial
///   to a member — which is a button on that member's row.
/// * Every peer's `state` is the kernel's framework voice, rendered as it
///   arrived (internal.wit `sync.peer`), and so is every pairing failure.
///   The visor invents neither.
///
/// Voices: a petname is the user's own word and is rendered in the user
/// voice; codes, the six digits, and every sentence about them are the
/// framework's. Nothing here is ever app voice — no publisher string
/// reaches this sheet at all.
#[component]
fn DevicesSection(
    endpoint_id: String,
    members: Vec<Member>,
    peers: Vec<Peer>,
    phase: Phase,
    on_refresh: EventHandler<()>,
) -> Element {
    // Read once per render, so every row's age is relative to the same now.
    let now = kernel::now_ms();
    let empty_group = members.is_empty();
    let mut adding = use_signal(|| false);
    let mut typed = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);

    // Every act is the same shape: call the kernel, show its refusal if it
    // refused, and re-read — because what the ceremony is doing now is the
    // kernel's answer, never this button's assumption about it.
    let mut acted = move |result: Result<(), String>| {
        match result {
            Ok(()) => error.set(None),
            Err(e) => error.set(Some(e)),
        }
        on_refresh.call(());
    };

    rsx! {
        div { class: "sheet",
            div { class: "sheet-head",
                span { class: "{Voice::Framework.class()}", "Devices" }
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
                    span { class: "{Voice::Framework.class()} placeholder", "binding…" }
                } else {
                    span { id: "visor-endpoint-id", class: "endpoint-id", "{endpoint_id}" }
                }
            }

            // The group. A device with no group yet is a group of one, so
            // this list is never empty once the kernel answers — an empty
            // one means it has not answered, and says so rather than
            // implying this device belongs to nothing.
            for member in members {
                div { key: "{member.endpoint_id}", class: "member-row",
                    div { class: "member-row-name",
                        if member.petname.is_empty() {
                            // No petname: the id is what this device is
                            // called, and it is shown in the one shape ids
                            // are ever shown in.
                            span { class: "endpoint-id", "{member.endpoint_id}" }
                        } else {
                            span { class: "{Voice::User.class()}", "{member.petname}" }
                        }
                    }
                    if member.me {
                        span { class: "{Voice::Framework.class()}", "this device" }
                    }
                    span { class: "{Voice::Framework.class()}",
                        "enrolled {coarse_age(now, member.enrolled)} ago"
                    }
                    if !member.me {
                        button {
                            onclick: move |_| {
                                let id = member.endpoint_id.clone();
                                async move { acted(kernel::connect(id).await) }
                            },
                            "Connect"
                        }
                    }
                }
            }
            if empty_group {
                span { class: "{Voice::Framework.class()} placeholder", "reading the group…" }
            }

            // The ceremony. One phase on screen at a time, and the two ways
            // to start one are offered only when none is running.
            match phase.clone() {
                Phase::Idle | Phase::Done | Phase::Failed(_) => rsx! {
                    if let Phase::Failed(why) = phase.clone() {
                        div { class: "{Voice::Framework.class()} sheet-error", "{why}" }
                        button {
                            // Dismissing is `cancel`, not a local forget:
                            // the kernel owns the phase, and a visor that
                            // hid a failure it had not cleared would show
                            // it again on the next read.
                            //
                            // CONTRACT: internal.wit `pairing.cancel` is
                            // "either side, at any point"; whether it
                            // returns a failed ceremony to `idle` is not
                            // spelled out. If the kernel leaves it failed,
                            // the message comes back — which is honest.
                            onclick: move |_| async move { acted(kernel::pairing_cancel().await) },
                            "Dismiss"
                        }
                    }
                    if phase == Phase::Done {
                        div { class: "{Voice::Framework.class()}", "device paired" }
                    }
                    if adding() {
                        label {
                            span { class: "{Voice::Framework.class()}", "the code the other device shows" }
                            input {
                                r#type: "text",
                                value: "{typed}",
                                oninput: move |e| typed.set(e.value()),
                            }
                        }
                        button {
                            onclick: move |_| async move {
                                let Some(code) = claim_code(&typed()) else {
                                    error.set(Some("type the code the other device is showing".into()));
                                    return;
                                };
                                typed.set(String::new());
                                adding.set(false);
                                acted(kernel::pairing_claim(code).await);
                            },
                            "Claim"
                        }
                    } else {
                        button { onclick: move |_| adding.set(true), "Add a device" }
                        button {
                            onclick: move |_| async move { acted(kernel::pairing_offer().await) },
                            "Pair this device with another"
                        }
                    }
                },

                Phase::Offering(code) => rsx! {
                    div { class: "{Voice::Framework.class()}", "type this on the other device" }
                    // Groups of four, monospace, selectable: 79 characters
                    // read across from one screen to another.
                    div { id: "visor-pairing-code", class: "pairing-code", "{grouped(&code)}" }
                    div { class: "{Voice::Framework.class()}", "waiting for the other device…" }
                    button {
                        onclick: move |_| async move { acted(kernel::pairing_cancel().await) },
                        "Cancel"
                    }
                },

                Phase::Claiming => rsx! {
                    div { class: "{Voice::Framework.class()}", "reaching the other device…" }
                    button {
                        onclick: move |_| async move { acted(kernel::pairing_cancel().await) },
                        "Cancel"
                    }
                },

                Phase::AwaitingConfirm(sas) => rsx! {
                    // The whole security of the ceremony is a person
                    // comparing these six digits with the six on the other
                    // screen, so they are the largest thing in the drawer.
                    div { id: "visor-pairing-sas", class: "pairing-sas", "{sas}" }
                    div { class: "{Voice::Framework.class()}",
                        "does the other device show the same number?"
                    }
                    button {
                        onclick: move |_| async move { acted(kernel::pairing_confirm().await) },
                        "Yes, pair"
                    }
                    button {
                        onclick: move |_| async move { acted(kernel::pairing_cancel().await) },
                        "No"
                    }
                },

                Phase::AwaitingPeer => rsx! {
                    div { class: "{Voice::Framework.class()}",
                        "waiting for the other device to confirm"
                    }
                    button {
                        onclick: move |_| async move { acted(kernel::pairing_cancel().await) },
                        "Cancel"
                    }
                },
            }

            // Nothing on this screen refreshes on its own: the visor holds
            // no state and its world has no timer. The kernel pushes
            // `pairing-changed`, but a peer's state and the group are read,
            // so this is the press that reads them.
            button { onclick: move |_| on_refresh.call(()), "Refresh" }

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
