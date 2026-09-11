//! The trusted pixels: the strip, and the drawer it opens over the app.
//!
//! The strip is the trust anchor — always present, fixed height, and the
//! only place the device identity is shown. Two halves and nothing else:
//! what is running, and who this is. The drawer is everything that needs
//! room: the app list, the running app's own labels, the device settings,
//! and the two device ceremonies (unseal, and the entry picker). Both are
//! rendered by this one component so there is exactly one tree, and no
//! ordering question about which of them the receiver mounts first.
//!
//! The strip is the line between trusted pixels and the app zone, so
//! whatever the visor opens goes on the visor's side of that line — above
//! the strip — and pushes the strip, and the app zone under it, down
//! rather than covering it.
//!
//! The visor holds no state of its own beyond what is on screen right now
//! (docs/design.md "Visor and apps render through stream-dom"): identity,
//! hue, word, the labels, the app list and the device index are kernel
//! state, read at mount and re-read only when the visor itself changed
//! them. The one exception is a [`Draft`], which is what a user has typed
//! and not saved — on screen, and nowhere else.
//!
//! The one rule the whole file is arranged around (design.md "Devices"):
//! **the anchor colour is never painted before the device is `open`.** A
//! page imitating the picker must not be able to show the user's own
//! colour, so the hue reaches the DOM through exactly one expression, and
//! that expression is unreachable unless `device.status` said `open`.

use dioxus::html::Key;
use dioxus::prelude::*;

use crate::glyph::normalize_glyph;
use crate::kernel::{
    self, App, Binding, Entry, Event, InstallOutcome, Member, Meta, MetaScope, Peer, SessionId,
    Status,
};
use crate::state::{
    Action, Drawer, Gate, Phase, Rest, Tenant, Tier, boot_drawer, claim_code, grouped,
};
use crate::style::CSS;
use crate::voice::{AppText, AppVoice, Voice, coarse_age};

/// Visor-owned keys, with the same meaning in user and app metadata.
const PETNAME: &str = "petname";
const GLYPH: &str = "glyph";

fn glyph_of(meta: &Meta) -> String {
    meta.get(GLYPH)
        .map(|s| normalize_glyph(s).to_string())
        .unwrap_or_default()
}

fn normalize_meta_glyph(meta: &mut Meta) {
    if let Some(value) = meta.get(GLYPH) {
        set_field(meta, GLYPH, normalize_glyph(value).to_string());
    }
}

fn petname_of(meta: &Meta) -> String {
    meta.get(PETNAME).cloned().unwrap_or_default()
}

/// Write one field of a draft's meta map. An emptied field removes its key
/// rather than storing "": `set-meta` replaces the whole map, so an empty
/// value would be a key that means nothing — and, worse, would leave the
/// draft comparing unequal to its seed, which is the whole definition of
/// "unsaved changes" here.
fn set_field(meta: &mut Meta, key: &str, value: String) {
    if value.is_empty() {
        meta.remove(key);
    } else {
        meta.insert(key.to_string(), value);
    }
}

/// What a sheet has been told but the kernel has not.
///
/// The visor still holds no state of its own beyond what is on screen
/// (docs/design.md "Visor and apps render through stream-dom"): a draft is
/// exactly what is on screen and not yet said. Two copies are kept — the
/// seed as the sheet was opened, the draft as it stands — because their
/// inequality is the only honest definition of "unsaved changes", and
/// because a save writes only the fields that differ rather than restating
/// the whole identity to the kernel.
#[derive(Clone, PartialEq, Default)]
struct Draft {
    name: String,
    hue: u16,
    user: Meta,
    app: Meta,
}

/// Commit a draft: one kernel call per field that actually changed, then
/// the local apply, then the seed catches up so the sheet is clean again.
///
/// The gate is bumped before the first call and not after the local apply,
/// for the reason [`read_status`] spells out: a read already in flight is
/// answering about the identity this is replacing, whichever lands first.
///
/// A failure leaves the seed alone, so the sheet stays dirty and the
/// user's text is still theirs to retry with — the kernel's refusal is the
/// notice, not a silent revert.
#[allow(clippy::too_many_arguments)]
async fn save_draft(
    mut draft: Signal<Draft>,
    mut seed: Signal<Draft>,
    mut status: Signal<Option<Status>>,
    mut user_meta: Signal<Meta>,
    mut app_meta: Signal<Meta>,
    mut notice: Signal<Option<Notice>>,
    app_id: Option<String>,
    mut status_gate: CopyValue<Gate>,
) -> bool {
    let was = seed();
    let mut now = draft();
    normalize_meta_glyph(&mut now.user);
    normalize_meta_glyph(&mut now.app);
    draft.set(now.clone());
    status_gate.write().bump();
    let mut failed = false;
    let mut fail = |e: String, failed: &mut bool| {
        notice.set(Some(Notice::Plain(e)));
        *failed = true;
    };

    if now.name != was.name {
        match kernel::set_name(now.name.clone()).await {
            Ok(()) => status.with_mut(|s| {
                if let Some(s) = s {
                    s.name = now.name.clone()
                }
            }),
            Err(e) => fail(e, &mut failed),
        }
    }
    if now.hue != was.hue {
        match kernel::set_hue(now.hue).await {
            Ok(()) => status.with_mut(|s| {
                if let Some(s) = s {
                    s.hue = now.hue
                }
            }),
            Err(e) => fail(e, &mut failed),
        }
    }
    if now.user != was.user {
        match kernel::set_meta(MetaScope::User, now.user.clone()).await {
            Ok(()) => user_meta.set(now.user.clone()),
            Err(e) => fail(e, &mut failed),
        }
    }
    // Only ever the live app's map: `AppInfo` exists only while a session
    // runs, and Settings seeds `app` from that same session, so there is no
    // path here that could write one app's labels into another's.
    if now.app != was.app
        && let Some(id) = app_id
    {
        match kernel::set_meta(MetaScope::App(id), now.app.clone()).await {
            Ok(()) => app_meta.set(now.app.clone()),
            Err(e) => fail(e, &mut failed),
        }
    }
    if !failed {
        seed.set(now);
    }
    !failed
}

/// Load the running app's labels when its session opens.
async fn read_app_meta(id: String, mut app_meta: Signal<Meta>, mut notice: Signal<Option<Notice>>) {
    match kernel::meta(MetaScope::App(id)).await {
        Ok(m) => app_meta.set(m),
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
}

/// What the drawer says when something happened that the user did not ask
/// for. Two shapes because a session ending is framework voice with the
/// app's *title* plated — the one place the two voices share a sentence.
#[derive(Clone, PartialEq)]
enum Notice {
    Plain(String),
    Ended { app: AppText, reason: String },
}

/// Where the visor is asking the browser to put the keyboard.
///
/// The visor cannot move focus itself: the pinned stream-dom receiver's
/// `MountedData` is `()` with `set_focus` unsupported. So focus is markup —
/// one element carries `data-visor-focus` with a generation number, and
/// `web/focus.ts` obeys it when that number advances. Rust keeps the
/// decision (which element, and whether a transition is worth a move at
/// all); the glue keeps the `.focus()` call and the one fact only a DOM
/// has, namely whether the caret is still the visor's to move.
///
/// The generation is what keeps ordinary work quiet: a status read landing,
/// a keystroke, an animation ending all re-render with the same number.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum FocusWant {
    /// Not asking — the state at boot, so a page load leaves the caret
    /// wherever the browser put it.
    #[default]
    Nowhere,
    Pane,
    /// The clean action replacing Save/Revert after a bar invocation.
    Bar,
    /// The half of the strip the drawer was raised from, because it closed.
    Strip {
        self_half: bool,
    },
    Confirm,
    Glyph,
    GlyphSearch,
}

/// Which half of the strip a tenant belongs to, and so which half the
/// keyboard returns to when its drawer closes: `Devices` is reached from
/// `Settings` (the right half's) and `AppInfo` from the app list.
fn raised_by_self_half(t: Tenant) -> bool {
    matches!(t, Tenant::Settings | Tenant::Unseal | Tenant::Devices)
}

/// The way out of a pane, in words — a scrim press is a mouse gesture and
/// the strip is not a toggle, so without this a keyboard cannot leave an
/// open drawer. `None` for the two panes with nowhere to go: the app list
/// with nothing running (where the visor rests) and the unseal ceremony
/// (every other kernel call is `unavailable` until it succeeds).
fn dismissal(t: Tenant, running: bool) -> Option<Action> {
    if running {
        Some(Action::Close)
    } else if t == Tenant::Apps || t == Tenant::Unseal {
        None
    } else {
        Some(Action::Show(Tenant::Apps))
    }
}

/// What a pane is, for a screen reader that has just been moved into one.
fn pane_label(t: Tenant) -> &'static str {
    match t {
        Tenant::Apps => "apps",
        Tenant::AppInfo => "the running app",
        Tenant::Settings => "settings",
        Tenant::Unseal => "unseal this device",
        Tenant::Devices => "other devices",
    }
}

// CONTRACT: `inert` is a presence attribute — `inert="false"` is still
// inert — and stream-dom-dioxus writes `AttributeValue::Bool(false)` as the
// string "false", removing an attribute only for `AttributeValue::None`
// (writer.rs:738 and :724; its `is_bool_attr` list does not include
// `inert`). So every `inert` here is an `Option<&str>`, never a `bool`.
fn flag(yes: bool) -> Option<&'static str> {
    yes.then_some("")
}

/// Launch `app` and give its frame the screen, with `route` as what the
/// frame answers `polyvisor:app/route.get` with (internal.wit
/// `shell.open-frame`): "" for a press on the app list, and the route a
/// bookmark carried for [`restore_bookmark`]. One function because the two
/// paths differ in that string and in nothing else — including the failure
/// handling, where a frame that will not open has to take its session with
/// it or every failure leaks a session id.
async fn open_app(
    app: App,
    route: String,
    mut session: Signal<Option<(SessionId, App)>>,
    app_meta: Signal<Meta>,
    mut notice: Signal<Option<Notice>>,
    apply: Callback<Action>,
) {
    match kernel::launch(&app.id).await {
        Err(e) => notice.set(Some(Notice::Plain(e))),
        Ok(id) => match kernel::open_frame(id, &route).await {
            Ok(()) => {
                notice.set(None);
                let app_id = app.id.clone();
                session.set(Some((id, app)));
                // The strip's left half now speaks for this app.
                read_app_meta(app_id, app_meta, notice).await;
                // The frame gets the screen; the drawer never covers it.
                // `apply` and not a bare `drawer.set`: it bumps `drawer_gate`,
                // so a boot decision still in flight cannot reopen a drawer
                // over the frame that just opened.
                apply.call(Action::Close);
            }
            Err(e) => {
                // The session outlived the frame that was to show it;
                // leaving it live would leak a session id per failure.
                let _ = kernel::close(id).await;
                notice.set(Some(Notice::Plain(e)));
            }
        },
    }
}

thread_local! {
    /// Has this page load already spent its fragment?
    ///
    /// A `thread_local` and not a hook: [`restore_bookmark`] is reached from
    /// [`read_identity`], which is a free function called from three different
    /// callbacks, and the rule is about the *page load* rather than about any
    /// one component's lifetime. The component realm is single-threaded
    /// (one guest instance per page), so this is a plain `Cell`.
    static FRAGMENT_SPENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Open what the page's fragment names, once per page load.
///
/// The fragment is read but never parsed: the kernel owns the grammar and
/// the token is opaque (internal.wit `apps.route-decode`), so the visor's
/// whole part is to hand the text over and act on the answer. A fragment
/// this device cannot open comes back as an error whose framework-voice
/// message is the kernel's, and it is shown as-is — the visor has no
/// sentence of its own to compose about a link it cannot read.
///
/// Once per page load, because [`read_identity`] runs again after every
/// ceremony that changes the device (unseal, keep). Relaunching there
/// would put the bookmarked app back on screen over whatever the user has
/// since opened, so the flag is spent on the first run that gets this far
/// — before the first await, so two reads in flight together cannot both
/// claim it.
///
/// It is never reached while the device is sealed: `read_identity` returns
/// at the seal, and every kernel call this makes would answer
/// `unavailable` anyway (internal.wit `device`). A device sealed at boot
/// restores its bookmark when the unseal ceremony succeeds, because
/// `on_unsealed` reads the identity again and the flag is still unspent.
async fn restore_bookmark(
    session: Signal<Option<(SessionId, App)>>,
    app_meta: Signal<Meta>,
    mut notice: Signal<Option<Notice>>,
    apply: Callback<Action>,
) {
    if FRAGMENT_SPENT.with(|spent| spent.replace(true)) {
        return;
    }
    let Some(f) = kernel::fragment() else {
        return;
    };
    match kernel::route_decode(&f).await {
        Err(e) => notice.set(Some(Notice::Plain(e))),
        Ok((app, route)) => open_app(app, route, session, app_meta, notice, apply).await,
    }
}

/// Read the device's identity, and — unless the device is sealed — the app
/// list and the user's own labels. Both are skipped while sealed on
/// purpose: every kernel call other than `status`/`unseal`/`erase` answers
/// `unavailable` then (internal.wit `device`), so asking would only
/// manufacture an error to show. A `fresh` device is read in full — it is
/// not sealed, and internal.wit `device` rules that "`fresh` is not a
/// gate".
///
/// Gated like [`read_status`]: this is called after the ceremonies that
/// change the device, and a user write landing while it is out must win.
///
/// The unsealed path ends in [`restore_bookmark`], which is the one place
/// a page's fragment is spent: it is the first moment the device is known
/// to be open, which is also the first moment `apps.route-decode` and
/// `apps.launch` will answer anything but `unavailable`.
async fn read_identity(
    mut status: Signal<Option<Status>>,
    mut apps: Signal<Vec<App>>,
    mut notice: Signal<Option<Notice>>,
    mut user_meta: Signal<Meta>,
    gate: CopyValue<Gate>,
    session: Signal<Option<(SessionId, App)>>,
    app_meta: Signal<Meta>,
    apply: Callback<Action>,
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
                user_meta.set(Meta::new());
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
    // The strip's right half shows these, so they are boot state and not
    // sheet state: a user who never opens Settings still sees their own
    // petname and glyph on the anchor.
    match kernel::meta(MetaScope::User).await {
        Ok(m) => {
            if gate.peek().apply(token) {
                user_meta.set(m);
            }
        }
        Err(e) => notice.set(Some(Notice::Plain(e))),
    }
    // Last, so the strip is whole — identity, labels, app list — before a
    // bookmark's launch takes its turn. Inside the gate: a read this one
    // superseded is not the one to spend the fragment, and the newer read
    // will spend it instead.
    if gate.peek().apply(token) {
        restore_bookmark(session, app_meta, notice, apply).await;
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
        // Framework voice, on the drawer's notice line: the ceremony is
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
    // The user's own labels, and the running app's. Kernel state, like
    // everything else here — and written back only by a save, so the strip
    // never shows a label the kernel has not been told about.
    let user_meta = use_signal(Meta::new);
    let mut app_meta = use_signal(Meta::new);

    // What the sheets are editing. `seed` is the identity as the sheet was
    // opened, `draft` as it stands; dirty is exactly `draft != seed`.
    let mut seed = use_signal(Draft::default);
    let mut draft = use_signal(Draft::default);
    // A transition the user asked for while the draft was dirty. It waits
    // on `#visor-confirm` rather than happening.
    let mut pending = use_signal(|| None::<Action>);
    let mut saving = use_signal(|| false);
    // Whether the async bar Save still owns focus. A user who moves back to
    // a field while it is in flight keeps the caret there, even if their
    // newer text happens to equal the captured snapshot when it lands.
    let mut bar_save_focused = use_signal(|| false);
    // Shut, but still on screen playing its close animation. The drawer
    // stays `Open(t)` throughout — this is what says the tenant showing is
    // the one on its way out — and `onanimationend` is what finally closes.
    let mut closing = use_signal(|| false);
    // The tenant sliding out under the new one, and whether it goes left.
    let mut leaving = use_signal(|| None::<(Tenant, bool)>);
    // Where the keyboard should be, and a generation that advances only
    // when the visor itself caused the move (see [`FocusWant`]).
    let mut focus = use_signal(|| (0u32, FocusWant::default()));
    let ask_focus = use_callback(move |want: FocusWant| {
        let next = focus.peek().0.wrapping_add(1);
        focus.set((next, want));
    });

    // Two orderings, both between a spawned read and a user's write. They
    // are `CopyValue` rather than `Signal` on purpose: a generation is
    // bookkeeping about renders, not something to render, and subscribing
    // to it would re-render the visor on every press that bumps it.
    //
    // `status_gate`: bumped by everything that changes this device
    // (a saved draft, word, keep, unseal), read by `read_status` and
    // `read_identity`.
    //
    // `drawer_gate`: bumped by every transition the user caused, read by
    // the boot decision below — which is the only writer of `drawer` that
    // the user did not ask for.
    let mut status_gate = use_hook(|| CopyValue::new(Gate::default()));
    let mut drawer_gate = use_hook(|| CopyValue::new(Gate::default()));

    // Settings carries three things that are only ever as fresh as their
    // last read: the peer list, the group, and this device's own endpoint
    // id — which is "" until the spawned bind completes, so first paint has
    // none. All are read by the transition that shows the tenant. So one
    // refresh, used by three things: that transition, the section's own
    // "Refresh" button, and every pairing act (each of which is a phase
    // change the kernel is the authority on).
    let refresh_devices = use_callback(move |()| {
        spawn(async move {
            read_status(status, notice, status_gate).await;
            read_peers(peers, notice).await;
            read_members(members, notice).await;
            read_pairing(pairing_phase, members, notice).await;
        });
    });

    // The Storage section's own re-read: the transition that shows
    // Settings, and every act in the section (connect, sync, disconnect),
    // each of which changes what `storage.status` answers.
    let refresh_storage = use_callback(move |()| {
        spawn(async move {
            read_storage(binding, notice).await;
        });
    });

    // Open a sheet on what the kernel last said. Called once per *opening*
    // — never on a press that lands on the tenant already showing — so a
    // half-typed field is never taken away from the user who typed it.
    let seed_draft = use_callback(move |()| {
        let identity = status.read();
        let mut next = Draft {
            name: identity
                .as_ref()
                .map(|s| s.name.clone())
                .unwrap_or_default(),
            hue: identity.as_ref().map(|s| s.hue).unwrap_or(0),
            user: user_meta(),
            app: app_meta(),
        };
        normalize_meta_glyph(&mut next.user);
        normalize_meta_glyph(&mut next.app);
        drop(identity);
        seed.set(next.clone());
        draft.set(next);
    });

    // Every drawer transition, and the only writer of `drawer`, `closing`
    // and `leaving` other than the two animation handlers and the boot.
    //
    // The animation bookkeeping is here rather than in the reducer because
    // it is about the two renders either side of a transition, which is not
    // something a plain value can know. Three shapes:
    //
    // * shutting — the drawer stays mounted with `closing`, and the
    //   `onanimationend` below is what sets `Closed`. Any pane in mid-slide
    //   is dropped first: the bridge carries no animation name
    //   (stream-dom-dioxus `convert_animation_data` answers ""), so
    //   `closing` has to be the whole discriminator, and that only holds if
    //   the drawer's own animation is the only one under it.
    // * switching — the old tenant keeps rendering as a second pane until
    //   its own animation ends, and the direction is the sign of the
    //   ordinals.
    // * opening — nothing to slide out of the way.
    let apply = use_callback(move |action: Action| {
        drawer_gate.write().bump();
        // Pinned is "nothing is running": with no app on screen the drawer
        // has nothing to be in the way of, so it rests on the app list.
        let pinned = session.read().is_none();
        let from = drawer().tenant();
        let next = drawer().reduce(action, pinned);
        match (from, next.tenant()) {
            (Some(t), None) => {
                leaving.set(None);
                closing.set(true);
                ask_focus.call(FocusWant::Strip {
                    self_half: raised_by_self_half(t),
                });
            }
            (Some(a), Some(b)) if a != b => {
                closing.set(false);
                leaving.set(Some((a, b.ordinal() > a.ordinal())));
                drawer.set(next);
                ask_focus.call(FocusWant::Pane);
            }
            (None, Some(_)) => {
                closing.set(false);
                drawer.set(next);
                ask_focus.call(FocusWant::Pane);
            }
            // The tenant showing is the one asked for. Still cancels a
            // close in flight: pressing the half you just left reopens it.
            // No focus move: a press that changes nothing must not take the
            // caret off whatever the user was in.
            _ => closing.set(false),
        }
        if from == next.tenant() {
            return;
        }
        match next.tenant() {
            Some(Tenant::Settings) => {
                seed_draft.call(());
                refresh_devices.call(());
                refresh_storage.call(());
            }
            // Seed synchronously before the pane can accept input; a later
            // seed could overwrite a glyph selected while a read was in flight.
            Some(Tenant::AppInfo) => {
                seed_draft.call(());
            }
            _ => {}
        }
    });

    // Every transition the *user* asked for. A dirty sheet is not left
    // silently: the transition is parked on `pending` and `#visor-confirm`
    // asks. Everything that calls `apply` directly instead — the boot, a
    // session opening or ending, an opened seal — is a transition the user
    // did not ask for and cannot be asked about, so a dirty draft is simply
    // dropped there.
    let request = use_callback(move |action: Action| {
        // While the dialog stands it is the only thing that may act. A press
        // that arrives now is input queued before it appeared — a scrim
        // click, a strip press already in flight — and taking it would
        // silently replace the transition the dialog is asking about.
        if pending().is_some() || saving() {
            return;
        }
        if draft() != seed() {
            pending.set(Some(action));
            // Everything else is inert under the dialog, so the keyboard has
            // to be put inside it or there is nothing focusable on screen.
            ask_focus.call(FocusWant::Confirm);
        } else {
            apply.call(action);
        }
    });

    let save_now = use_callback(move |(after, from_bar): (Option<Action>, bool)| {
        if saving() {
            return;
        }
        saving.set(true);
        let app_id = session
            .read()
            .as_ref()
            .map(|(_, a): &(SessionId, App)| a.id.clone());
        spawn(async move {
            let saved = save_draft(
                draft,
                seed,
                status,
                user_meta,
                app_meta,
                notice,
                app_id,
                status_gate,
            )
            .await;
            saving.set(false);
            if saved {
                if let Some(action) = after {
                    // Text typed after the captured snapshot stays in this
                    // sheet; it has not been answered by the earlier Save.
                    if draft() == seed() {
                        apply.call(action);
                    }
                } else if from_bar && bar_save_focused() && draft() == seed() {
                    ask_focus.call(FocusWant::Bar);
                }
            }
        });
    });

    let revert_now = use_callback(move |(after, from_bar): (Option<Action>, bool)| {
        if saving() {
            return;
        }
        draft.set(seed());
        if let Some(action) = after {
            apply.call(action);
        } else if from_bar {
            ask_focus.call(FocusWant::Bar);
        }
    });

    // The boot read: identity first, then the index, then whichever
    // ceremony the two of them together call for.
    //
    // This runs exactly once — `use_future` spawns from a `use_hook` and
    // has no reactive dependency on `status` (dioxus-hooks 0.7.10
    // `src/use_future.rs:63`), so a later status re-read cannot re-run it.
    // Running once is not enough on its own, though: it *finishes* late.
    // `visorReady` and the strip only wait for `device.status`, so the
    // strip goes live while `store.devices` is still in flight, and a user
    // who pressed it then had the drawer changed under them when the boot
    // decided. So the decision applies only if the user has not touched the
    // drawer meanwhile — after which it is not the boot's business what is
    // open. Nor `restore_bookmark`'s business: it closes the drawer through
    // `apply`, which bumps the same gate, and a bookmark that opened is the
    // strongest statement about what this page load is for — so the boot's
    // own idea of which tenant to show is dropped by exactly the mechanism a
    // user's press would have dropped it by.
    use_future(move || async move {
        let token = drawer_gate.peek().begin();
        read_identity(
            status,
            apps,
            notice,
            user_meta,
            status_gate,
            session,
            app_meta,
            apply,
        )
        .await;
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
            // `boot_drawer`'s `Closed` is "no ceremony to raise", not "show
            // nothing": nothing is running at boot, so the reducer rests it
            // on the app list.
            drawer.set(
                match boot_drawer(s.state, s.tier, &s.petname, others_kept) {
                    Drawer::Closed => Drawer::Closed.reduce(Action::Close, true),
                    raised => raised,
                },
            );
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
                        app_meta.set(Meta::new());
                        notice.set(Some(Notice::Ended {
                            app: app.title,
                            reason,
                        }));
                        // Nothing is running now, so this rests the drawer
                        // on the app list — which is where the notice is
                        // read, and the strip has not moved to say it.
                        apply.call(Action::Close);
                    }
                }
                // The other device acted: a peer that confirmed, an offer
                // that expired, an enrollment that landed. Nothing else
                // could bring those to the screen — there is no timer here
                // and `pairing.status` may not park.
                Event::PairingChanged(next) => {
                    apply_phase(next, pairing_phase, members, notice).await;
                }
            }
        }
    });

    // A press on the app list is a plain launch: no route, so the frame
    // answers `route.get` with "" (internal.wit `shell.open-frame`).
    let open = move |app: App| async move {
        open_app(app, String::new(), session, app_meta, notice, apply).await
    };

    let close_session = move |id: SessionId| async move {
        let _ = kernel::close_frame(id).await;
        if let Err(e) = kernel::close(id).await {
            notice.set(Some(Notice::Plain(e)));
        }
        session.set(None);
        app_meta.set(Meta::new());
        apply.call(Action::Close);
    };

    // Install the running app as its own OS-level app: the visor's own act,
    // since the fragment it opens at is the kernel's (`install-fragment`)
    // and the name the launcher shows is composed by the glue from the
    // app's title (docs/design.md "Routing", the `launch/` bullet).
    //
    // `glyph` is read off `app_meta` — the map the kernel last confirmed —
    // and never off `draft.app`, which is text the user is still typing.
    // An install is written into the OS's app registry and replayed for
    // months; seeding it from an unsaved field would mint a launcher icon
    // the user could then Revert away from.
    let install_as_app = move |app: App, hue: u16, glyph: String| async move {
        let outcome = match kernel::install_fragment(&app.id).await {
            Ok(fragment) => {
                kernel::install_app(fragment, app.title.expose().to_string(), hue, glyph).await
            }
            Err(e) => Err(e),
        };
        notice.set(Some(Notice::Plain(match outcome {
            Ok(InstallOutcome::Prompted) => "the browser is asking whether to install it".into(),
            Ok(InstallOutcome::Manual) => {
                "install it from the browser's menu — the app's manifest is in place".into()
            }
            Err(e) => e,
        })));
    };

    // "Other devices": the index is cheap and the ages on it go stale, so
    // the press that shows the sheet is also the read.
    let show_devices = use_callback(move |()| {
        spawn(async move {
            entries.set(kernel::devices().await.unwrap_or_default());
        });
        request.call(Action::Show(Tenant::Devices));
    });

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
    let on_unsealed = use_callback(move |()| {
        // Unseal is the one ceremony where a *later* status read is the
        // point: the seal opening is what the sheet was for. So the gate is
        // bumped first and the read that follows carries the new
        // generation.
        status_gate.write().bump();
        spawn(async move {
            read_identity(
                status,
                apps,
                notice,
                user_meta,
                status_gate,
                session,
                app_meta,
                apply,
            )
            .await;
            apply.call(Action::Close);
        });
    });

    let on_stay = use_callback(move |()| apply.call(Action::Close));

    let on_kept = use_callback(move |persisted: bool| {
        status_gate.write().bump();
        spawn(async move {
            if !persisted {
                notice.set(Some(Notice::Plain(
                    "the browser declined to persist storage".into(),
                )));
            }
            read_identity(
                status,
                apps,
                notice,
                user_meta,
                status_gate,
                session,
                app_meta,
                apply,
            )
            .await;
        });
    });

    // The word is not part of the draft: a reroll is a new secret from the
    // kernel, not an edit, and there is nothing to type or take back.
    let on_reroll = use_callback(move |()| {
        status_gate.write().bump();
        spawn(async move {
            match kernel::reroll_word().await {
                Ok(word) => status.with_mut(|s| {
                    if let Some(s) = s {
                        s.word = word
                    }
                }),
                Err(e) => notice.set(Some(Notice::Plain(e))),
            }
        });
    });

    let running = session.read().is_some();
    let tenant = drawer().tenant();
    let ident = Ident::of(&status.read());
    // The whole visor wears the unclaimed dress while the seal is shut, so
    // "no identity to show" is one fact with one rendering, not a
    // per-element negotiation.
    //
    // The predicate is `state != sealed`, not `state == open`. internal.wit
    // `device`: "`fresh` is not a gate: an ephemeral device is fully
    // usable, and its colour is freshly minted, so painting it before
    // \"keep\" gives an impostor nothing." Only the passphrase tier has a
    // screen worth imitating, and that is the one this greys.
    let claimed = matches!(ident, Ident::Open(_));
    let locked = !claimed;
    let root_class = if claimed { "" } else { "unclaimed" };

    // The single site that paints the anchor colour, and it is inside the
    // `Open` arm — which is only ever constructed from a `device.status`
    // that was not sealed, so a page imitating the picker has no branch
    // that reaches it (docs/design.md "Devices"). It is a variable rather
    // than one element's background because the whole palette derives from
    // it now (visor/src/style.rs), but it is still one expression in one
    // place, and `--hue` appears nowhere else in the DOM.
    let painted = match &ident {
        Ident::Open(a) => Some(format!(
            "--hue: {}",
            // The draft owns the colour while its sheet is open, so the
            // visor recolours under the slider and reverts with it.
            if tenant == Some(Tenant::Settings) {
                draft().hue
            } else {
                a.hue
            }
        )),
        Ident::Waking | Ident::Unclaimed => None,
    };

    // The device's own line in the right stack. Three ways to have no name
    // and each says something different: not asked yet, asked and sealed,
    // open but never named.
    let (device_line, device_named) = match &ident {
        Ident::Waking => ("waking".to_string(), false),
        Ident::Unclaimed => ("no device open".to_string(), false),
        Ident::Open(a) if a.name.is_empty() => ("this device".to_string(), false),
        Ident::Open(a) => (a.name.clone(), true),
    };
    let user_petname = petname_of(&user_meta.read());
    let app_petname = petname_of(&app_meta.read());
    // No glyphs before the identity is painted: they are the user's own
    // marks, and the same rule covers them as covers the colour.
    let user_glyph = if claimed {
        glyph_of(&user_meta.read())
    } else {
        String::new()
    };
    let app_glyph = if claimed {
        glyph_of(&app_meta.read())
    } else {
        String::new()
    };

    let on_apps = tenant == Some(Tenant::Apps) || tenant == Some(Tenant::AppInfo);
    let on_self = tenant == Some(Tenant::Settings);
    let shutting = closing();
    let drawer_class = if shutting { "closing" } else { "" };
    let entering = match leaving() {
        Some((_, true)) => "pane enter-from-right",
        Some((_, false)) => "pane enter-from-left",
        None => "pane",
    };

    // At most one element carries `data-visor-focus`, so the glue never has
    // to choose; its value is the generation `web/focus.ts` acts on.
    let (focus_gen, focus_want) = focus();
    let focus_tag = |want: FocusWant| (focus_want == want).then(|| focus_gen.to_string());
    let focus_pane = focus_tag(FocusWant::Pane);
    let focus_bar = focus_tag(FocusWant::Bar);
    let focus_confirm = focus_tag(FocusWant::Confirm);
    let focus_glyph = focus_tag(FocusWant::Glyph);
    let focus_glyph_search = focus_tag(FocusWant::GlyphSearch);
    let focus_app_half = focus_tag(FocusWant::Strip { self_half: false });
    let focus_self_half = focus_tag(FocusWant::Strip { self_half: true });

    // `inert` is the whole of the dialog's trap: with strip, scrim and
    // drawer inert there is nowhere for Tab to go but its three answers. An
    // ordinary open pane is not a modal and traps nothing.
    let confirming = pending().is_some();
    // The app zone is the page's element, not this tree's, so the glue
    // mirrors this marker onto it (`web/focus.ts`). True throughout the
    // drawer's open and close animations, since it is on screen for both.
    let app_inert = flag(tenant.is_some() || confirming);
    // The exit the pane offers, which Escape is the keyboard spelling of.
    let escape = tenant.and_then(|t| dismissal(t, running));

    // One pane's worth of drawer. Rendered twice while a switch is
    // animating — the tenant coming in and the one going out — so it is a
    // closure rather than an arm inlined in the tree. `current` is which of
    // the two this is: only the pane that is staying carries the ids, since
    // two elements with one id is a tree nobody can query.
    let sheet_for = move |t: Tenant, current: bool| -> Element {
        let (self_id, tier, rest, petname, endpoint_id, word, hue) = match status.read().as_ref() {
            Some(s) => (
                s.id.clone(),
                s.tier,
                s.rest,
                s.petname.clone(),
                s.endpoint_id.clone(),
                s.word.clone(),
                s.hue,
            ),
            None => (
                String::new(),
                Tier::Ephemeral,
                Rest::RestsOpen,
                String::new(),
                String::new(),
                String::new(),
                0,
            ),
        };
        let live = session.read().as_ref().map(|(id, app)| (*id, app.clone()));
        let live_id = live.as_ref().map(|(id, _)| *id);
        let (info_petname, info_glyph) = {
            let d = draft.read();
            (
                d.app.get(PETNAME).cloned().unwrap_or_default(),
                d.app.get(GLYPH).cloned().unwrap_or_default(),
            )
        };

        rsx! {
            // Whatever happened that the user did not ask for. It lives at
            // the top of every pane because the strip has no room to say
            // it any more and no business moving to make some.
            div { id: if current { Some("visor-notice") } else { None }, class: "notice",
                match &*notice.read() {
                    Some(Notice::Ended { app, reason }) => rsx! {
                        AppVoice { text: app.clone() }
                        span { class: "{Voice::Framework.class()}", " ended: {reason}" }
                    },
                    Some(Notice::Plain(message)) => rsx! {
                        span { class: "{Voice::Framework.class()}", "{message}" }
                    },
                    None => rsx! {},
                }
            }

            match t {
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

                // The running app, and the user's own words for it. Only
                // reachable while a session runs — the strip's left half
                // shows the app list otherwise — so the title is the live
                // one and the draft's `app` map is that app's.
                Tenant::AppInfo => rsx! {
                    div { class: "sheet",
                        match &live {
                            Some((_, app)) => rsx! {
                                div { class: "sheet-head", AppVoice { text: app.title.clone() } }
                            },
                            None => rsx! {
                                span { class: "{Voice::Framework.class()}", "nothing running" }
                            },
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "petname" }
                            // Controlled, unlike the fields this replaced.
                            // `value` is volatile in dioxus-html — written
                            // on every diff — which is why the old fields
                            // read the kernel once and let the DOM own the
                            // text: a status re-read landing mid-typing
                            // reset them. Nothing re-reads a draft, so the
                            // signal is the field's only writer and the
                            // volatility has nothing to overwrite with.
                            input {
                                r#type: "text",
                                value: "{info_petname}",
                                oninput: move |e| {
                                    let mut d = draft.write();
                                    set_field(&mut d.app, PETNAME, e.value());
                                },
                            }
                        }
                        GlyphPicker {
                            label: "glyph",
                            value: info_glyph,
                            focus_return: current.then(|| focus_glyph.clone()).flatten(),
                            focus_search: current.then(|| focus_glyph_search.clone()).flatten(),
                            onchange: move |value| {
                                let mut d = draft.write();
                                set_field(&mut d.app, GLYPH, value);
                            },
                            onreturn: move |_| ask_focus.call(FocusWant::Glyph),
                            onsearch: move |_| ask_focus.call(FocusWant::GlyphSearch),
                        }
                        if let Some(id) = live_id {
                            button {
                                onclick: move |_| async move { close_session(id).await },
                                "Close app"
                            }
                            // Only offered for a live session: the fragment
                            // is `install-fragment`'s, this app's `launch/`
                            // route (docs/design.md "Routing"). The glyph
                            // is the saved one, read here off `app_meta`
                            // rather than out of the draft above.
                            button {
                                onclick: {
                                    let live = live.clone();
                                    move |_| {
                                        let app = live.clone().unwrap().1;
                                        let glyph = glyph_of(&app_meta.read());
                                        async move { install_as_app(app, hue, glyph).await }
                                    }
                                },
                                "Install as app"
                            }
                        }
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
                    SettingsSheet {
                        draft,
                        word: word.clone(),
                        tier,
                        petname: petname.clone(),
                        rest,
                        binding: binding.read().clone(),
                        endpoint_id: endpoint_id.clone(),
                        members: members.read().clone(),
                        peers: peers.read().clone(),
                        phase: pairing_phase.read().clone(),
                        on_reroll,
                        on_refresh_storage: refresh_storage,
                        on_refresh_devices: refresh_devices,
                        on_kept,
                        on_devices: show_devices,
                        focus_glyph: current.then(|| focus_glyph.clone()).flatten(),
                        focus_glyph_search: current.then(|| focus_glyph_search.clone()).flatten(),
                        on_glyph_return: move |_| ask_focus.call(FocusWant::Glyph),
                        on_glyph_search: move |_| ask_focus.call(FocusWant::GlyphSearch),
                    }
                },
            }
        }
    };

    rsx! {
        // One positioned root. The drawer is rendered before the strip so
        // it sits in normal flow above it: the strip is the line between
        // trusted pixels and the app zone, so whatever the visor opens goes
        // on the visor's side of that line — above the strip — and pushes
        // the strip, and the app zone under it, down rather than covering
        // it.
        div {
            id: "visor-root",
            class: "{root_class}",
            style: painted,
            "data-visor-app-inert": app_inert,
            // One listener for the whole tree, and not a document one: the
            // visor's world grants no page-level key capability, and a key
            // pressed with the caret in an app's frame is that app's. The
            // drawer moves the caret into its pane as it opens, so by the
            // time there is something to dismiss the focus is in here.
            // Residue: a caret tabbed right out of the visor into browser
            // chrome is out of reach until it comes back.
            onkeydown: move |e: KeyboardEvent| {
                if e.key() != Key::Escape {
                    return;
                }
                // In the dialog, Escape cancels the dialog ALONE: the parked
                // transition is not taken and the draft is untouched.
                if pending().is_some() {
                    e.stop_propagation();
                    pending.set(None);
                    return;
                }
                // Otherwise it is the dismissal button by another name, and
                // takes the same dirty-draft guard.
                if let Some(action) = escape {
                    e.stop_propagation();
                    request.call(action);
                }
            },
            // The trusted pixels depend on nothing the page provides, so
            // the visor ships its own stylesheet as part of its own tree.
            style { "{CSS}" }

            if let Some(t) = tenant {
                // Only when there is something behind the drawer to
                // dismiss back to. With nothing running the drawer is
                // where the visor rests, and a scrim over an empty app
                // zone would be a dismissal to nowhere.
                if running {
                    div {
                        id: "visor-scrim",
                        // A press target as much as the strip is, so it goes
                        // inert under the dialog with everything else.
                        inert: flag(confirming),
                        onclick: move |_| request.call(Action::Close),
                    }
                }
                div {
                    id: "visor-drawer",
                    class: "{drawer_class}",
                    // Under the dialog, or shut but still sliding: Tab must
                    // not walk into a pane that is leaving.
                    inert: flag(confirming || shutting),
                    onanimationend: move |_| {
                        // `closing` is the whole discriminator: the bridge
                        // reports no animation name, and the close path
                        // drops any pane still sliding, so the drawer's own
                        // animation is the only one that can be ending
                        // under it while this is true.
                        if closing() {
                            closing.set(false);
                            drawer.set(Drawer::Closed);
                        }
                    },
                    div { class: "pane-host",
                        if let Some((from, forward)) = leaving() {
                            div {
                                key: "{from:?}",
                                class: if forward { "pane leave-to-left" } else { "pane leave-to-right" },
                                inert: flag(true),
                                onanimationend: move |_| leaving.set(None),
                                {sheet_for(from, false)}
                            }
                        }
                        div {
                            key: "{t:?}",
                            class: "{entering}",
                            tabindex: "-1",
                            role: "group",
                            aria_label: pane_label(t),
                            "data-visor-focus": focus_pane,
                            {sheet_for(t, true)}
                        }
                    }

                    if matches!(t, Tenant::Settings | Tenant::AppInfo) && draft() != seed() {
                        div { id: "visor-actions",
                            button {
                                aria_disabled: "{saving()}",
                                onfocus: move |_| bar_save_focused.set(true),
                                onblur: move |_| bar_save_focused.set(false),
                                onclick: move |_| save_now.call((None, true)),
                                "Save"
                            }
                            button {
                                disabled: "{saving()}",
                                onclick: move |_| revert_now.call((None, true)),
                                "Revert"
                            }
                        }
                    } else if let Some(action) = dismissal(t, running) {
                        div { id: "visor-actions",
                            button {
                                "data-visor-focus": focus_bar,
                                onclick: move |_| request.call(action),
                                "Close"
                            }
                        }
                    }
                }
            }

            div {
                id: "visor-strip",
                // Under the dialog only: an open pane is not a modal, so the
                // strip stays reachable from one.
                inert: flag(confirming),
                // Left half: what is running. Both halves need a kernel
                // that answers, so neither is offered before the seal
                // opens; the ceremony the boot raised is what the user has
                // to act on instead.
                button {
                    id: "visor-app",
                    disabled: "{locked}",
                    aria_pressed: "{on_apps}",
                    "data-visor-focus": focus_app_half,
                    onclick: move |_| {
                        request.call(Action::Show(if running { Tenant::AppInfo } else { Tenant::Apps }))
                    },
                    div { id: "visor-app-glyph", class: "glyph-tile-face", "{app_glyph}" }
                    div { class: "stack",
                        div { class: "top",
                            match session.read().as_ref() {
                                Some((_, app)) => rsx! { AppVoice { text: app.title.clone() } },
                                None => rsx! {
                                    span { class: "{Voice::Framework.class()}", "nothing running" }
                                },
                            }
                        }
                        div { class: "bottom",
                            if !app_petname.is_empty() {
                                span { class: "{Voice::User.class()}", "{app_petname}" }
                            }
                        }
                    }
                }

                div { id: "visor-divider" }

                // Right half: who this is, and which device this is.
                button {
                    id: "visor-self",
                    disabled: "{locked}",
                    aria_pressed: "{on_self}",
                    "data-visor-focus": focus_self_half,
                    onclick: move |_| request.call(Action::Show(Tenant::Settings)),
                    div { id: "visor-circle", "{user_glyph}" }
                    div { class: "stack",
                        div { class: "top",
                            if user_petname.is_empty() {
                                span { class: "{Voice::Framework.class()} placeholder", "you" }
                            } else {
                                span { class: "{Voice::User.class()}", "{user_petname}" }
                            }
                        }
                        div { class: "bottom",
                            if device_named {
                                span { class: "{Voice::User.class()}", "{device_line}" }
                            } else {
                                span { class: "{Voice::Framework.class()} placeholder", "{device_line}" }
                            }
                        }
                    }
                }
                // The anchor word is a recognition secret between the user
                // and this device: spoken only in the settings sheet, on
                // request, never left standing in the strip.
            }

            // Unsaved changes, over the drawer that holds them. The three
            // answers are the three things a user could mean, and none of
            // them is "lose it quietly".
            if let Some(action) = pending() {
                div {
                    id: "visor-confirm",
                    role: "dialog",
                    aria_modal: "true",
                    aria_label: "unsaved changes",
                    // Focusable, so the caret lands on the dialog rather than
                    // on one of three answers none of which is safe to guess.
                    tabindex: "-1",
                    "data-visor-focus": focus_confirm,
                    span { class: "{Voice::Framework.class()}", "unsaved changes" }
                    button {
                        onclick: move |_| {
                            pending.set(None);
                            save_now.call((Some(action), false));
                        },
                        "Save"
                    }
                    button {
                        onclick: move |_| {
                            pending.set(None);
                            revert_now.call((Some(action), false));
                        },
                        "Revert"
                    }
                    button { onclick: move |_| pending.set(None), "Cancel" }
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

/// The painted identity. A plain value, and the only shape a hue is
/// carried in: constructing one is what says the kernel called this device
/// unsealed.
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

const GLYPH_PAGE: usize = 96;

/// One glyph tile plus the bundled, searchable Unicode emoji catalogue.
///
/// The search field is deliberately not a glyph input: its complete, raw
/// value remains available to emoji name/shortcode search. `normalize_glyph`
/// is applied only to make the explicit first result, and selecting that
/// result is the act that changes the draft.
#[component]
fn GlyphPicker(
    label: &'static str,
    value: String,
    onchange: EventHandler<String>,
    focus_return: Option<String>,
    focus_search: Option<String>,
    onreturn: EventHandler<()>,
    onsearch: EventHandler<()>,
) -> Element {
    let mut open = use_signal(|| false);
    let mut query = use_signal(String::new);
    let mut limit = use_signal(|| GLYPH_PAGE);
    let mut composing = use_signal(|| false);
    let needle = query().trim().to_lowercase();
    let direct = (!composing())
        .then(|| normalize_glyph(&query()).to_string())
        .filter(|glyph| !glyph.is_empty());
    let mut matches = Vec::new();
    let cap = limit().saturating_add(1);
    'emoji: for emoji in emojis::iter().take_while(|_| open()) {
        let base_found = needle.is_empty()
            || emoji.name().contains(&needle)
            || emoji.shortcodes().any(|code| code.contains(&needle));
        if let Some(tones) = emoji.skin_tones() {
            for variant in tones {
                let found = base_found
                    || variant.name().contains(&needle)
                    || variant.shortcodes().any(|code| code.contains(&needle));
                if found {
                    matches.push(variant);
                }
                if matches.len() == cap {
                    break 'emoji;
                }
            }
        } else if base_found {
            matches.push(emoji);
            if matches.len() == cap {
                break;
            }
        }
    }
    let more = matches.len() > limit();
    matches.truncate(limit());
    let empty = matches.is_empty() && direct.is_none();

    rsx! {
        div {
            class: "glyph-control",
            onkeydown: move |e: KeyboardEvent| {
                if open() && e.key() == Key::Escape {
                    e.stop_propagation();
                    open.set(false);
                    onreturn.call(());
                }
            },
            div { class: "glyph-control-row",
                span { class: "{Voice::Framework.class()}", "{label}" }
                button {
                    r#type: "button",
                    class: "glyph-tile-button",
                    aria_label: "Choose {label}",
                    aria_expanded: "{open}",
                    "data-visor-focus": focus_return,
                    onclick: move |_| {
                        if open() {
                            open.set(false);
                            onreturn.call(());
                        } else {
                            query.set(String::new());
                            composing.set(false);
                            open.set(true);
                            limit.set(GLYPH_PAGE);
                            onsearch.call(());
                        }
                    },
                    span { class: "glyph-tile-face", "{value}" }
                }
            }
            if open() {
                div { class: "glyph-picker",
                    label {
                        span { class: "{Voice::Framework.class()}", "Enter glyph or search" }
                        input {
                            r#type: "search",
                            value: "{query}",
                            "data-visor-focus": focus_search,
                            oncompositionstart: move |_| composing.set(true),
                            oncompositionend: move |_| composing.set(false),
                            oninput: move |e| {
                                query.set(e.value());
                                limit.set(GLYPH_PAGE);
                            },
                        }
                    }
                    div { class: "glyph-results",
                        if let Some(glyph) = direct {
                            button {
                                r#type: "button",
                                title: "Use {glyph}",
                                aria_label: "Use {glyph}",
                                onclick: move |_| {
                                    onchange.call(glyph.clone());
                                    open.set(false);
                                    onreturn.call(());
                                },
                                "{glyph}"
                            }
                        }
                        for emoji in matches {
                            button {
                                r#type: "button",
                                title: "{emoji.name()}",
                                aria_label: "{emoji.name()}",
                                onclick: move |_| {
                                    onchange.call(emoji.as_str().to_string());
                                    open.set(false);
                                    onreturn.call(());
                                },
                                "{emoji.as_str()}"
                            }
                        }
                    }
                    if more {
                        button {
                            r#type: "button",
                            onclick: move |_| limit += GLYPH_PAGE,
                            "Show more"
                        }
                    }
                    if empty {
                        span { class: "{Voice::Framework.class()}", "no emoji found" }
                    }
                    if !value.is_empty() {
                        button {
                            r#type: "button",
                            class: "glyph-clear",
                            onclick: move |_| {
                                onchange.call(String::new());
                                open.set(false);
                                onreturn.call(());
                            },
                            "Clear glyph"
                        }
                    }
                }
            }
        }
    }
}

/// Everything about this device, and the user, that is a field rather
/// than a ceremony.
///
/// The four editable fields go through the draft, not the kernel: what a
/// user has typed and not saved is theirs, and the kernel hears about it
/// once, on `Save`. `Revert` puts the sheet back to what the kernel last
/// said. The word is the exception and is deliberately not a field — a
/// reroll is a new secret from the kernel, immediate, with nothing to take
/// back.
#[component]
#[allow(clippy::too_many_arguments)]
fn SettingsSheet(
    draft: Signal<Draft>,
    word: String,
    tier: Tier,
    petname: String,
    rest: Rest,
    binding: Option<Binding>,
    endpoint_id: String,
    members: Vec<Member>,
    peers: Vec<Peer>,
    phase: Phase,
    on_reroll: EventHandler<()>,
    on_refresh_storage: EventHandler<()>,
    on_refresh_devices: EventHandler<()>,
    on_kept: EventHandler<bool>,
    on_devices: EventHandler<()>,
    focus_glyph: Option<String>,
    focus_glyph_search: Option<String>,
    on_glyph_return: EventHandler<()>,
    on_glyph_search: EventHandler<()>,
) -> Element {
    let mut draft = draft;
    // Read out rather than held: the field values are wanted here, and a
    // read guard alive across the tree would be one the input handlers
    // below have to hope nobody took a write against.
    let (name, hue, user_petname, user_glyph) = {
        let d = draft.read();
        (
            d.name.clone(),
            d.hue,
            d.user.get(PETNAME).cloned().unwrap_or_default(),
            d.user.get(GLYPH).cloned().unwrap_or_default(),
        )
    };
    rsx! {
        label {
            span { class: "{Voice::Framework.class()}", "device petname" }
            input {
                r#type: "text",
                value: "{name}",
                oninput: move |e| draft.write().name = e.value(),
            }
        }
        label {
            span { class: "{Voice::Framework.class()}", "colour" }
            // `oninput`, not `onchange`: the hue is what the whole visor is
            // painted from, so the drag is the preview — the strip, the
            // drawer and every button recolour under the thumb, and
            // `Revert` is what undoes it.
            input {
                r#type: "range", min: "0", max: "359",
                value: "{hue}",
                oninput: move |e| {
                    if let Ok(hue) = e.value().parse::<u16>() {
                        draft.write().hue = hue;
                    }
                },
            }
        }
        label {
            span { class: "{Voice::Framework.class()}", "your petname" }
            input {
                r#type: "text",
                value: "{user_petname}",
                oninput: move |e| {
                    let mut d = draft.write();
                    set_field(&mut d.user, PETNAME, e.value());
                },
            }
        }
        GlyphPicker {
            label: "your glyph",
            value: user_glyph,
            focus_return: focus_glyph,
            focus_search: focus_glyph_search,
            onchange: move |value| {
                let mut d = draft.write();
                set_field(&mut d.user, GLYPH, value);
            },
            onreturn: move |_| on_glyph_return.call(()),
            onsearch: move |_| on_glyph_search.call(()),
        }
        label {
            span { class: "{Voice::Framework.class()}", "word" }
            span { class: "{Voice::Framework.class()}", "{word}" }
            button { onclick: move |_| on_reroll.call(()), "Reroll" }
        }

        if tier == Tier::Durable {
            KeptNote { petname: petname.clone(), rest }
        } else {
            KeepSheet { on_kept }
        }

        StorageSection { binding, on_refresh: on_refresh_storage }

        DevicesSection {
            endpoint_id,
            members,
            peers,
            phase,
            on_refresh: on_refresh_devices,
        }

        div { class: "sheet",
            button { onclick: move |_| on_devices.call(()), "Other devices" }
            EraseControl {}
        }
    }
}
