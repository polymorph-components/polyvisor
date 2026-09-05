//! The WIT seam: the generated bindings, the `control` export, and the live
//! [`Visor`] value the renderer's signal watches.
//!
//! Compiled for wasm32 only — it names the generated bindings, and (through
//! [`later`]) the clock, neither of which exists on the host. See `lib.rs` for
//! the layout and for where each of visor.ts's timed behaviours ended up.
//!
//! The `// CONTRACT:` notes below are the places where a WIT signature and
//! `visor/ui/visor.ts` disagree and the conservative reading was taken. None of
//! them is about timing any more.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use dioxus::core::{Runtime, RuntimeGuard, ScopeId};
use dioxus::prelude::*;

use crate::drawer::{CloseReason, Deadline, DrawerState, Effect, TenantSpec};
use crate::state::{
    Conditions, Context, EventStore, Identity, VISOR_HUES,
};
use crate::voice::{FrameworkText, MarkIcon, UserVoice, IDENTITY_MAX};

wit_bindgen::generate!({
    path: "wit",
    world: "visor",
    // The reuse that lets an EXTENDED world be generated downstream while the
    // renderer's already-generated types are kept. Without it,
    // `driver::run(App)` returns a `StreamReader<Operation>` over the
    // renderer's `Operation`, and our world's `run` export would want a
    // structurally identical but nominally different type. Verified against the
    // renderer's own `generate!` (polyengine-dioxus/src/bindings.rs), which
    // sets `default_bindings_module: "polyengine_dioxus::bindings"` — so its
    // interface modules live at `polyengine_dioxus::bindings::<pkg
    // namespace>::<pkg name>::<interface>`, snake_cased.
    with: {
        "polymorph:dioxus/events@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::events,
        "polymorph:dioxus/mutations@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::mutations,
        "polymorph:dioxus/dom@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::dom,
        // ADDED BY THE fdc0d52 BUMP, and mapped for the same reason the three
        // above are: the base world gained `import head` and `import history`,
        // and `driver::run` now provides `WitDocument` and `WitHistory` as root
        // context UNCONDITIONALLY (polyengine-dioxus/src/driver.rs:258-269), so
        // both imports are live in every component built against the crate —
        // this one included, which asks for neither.
        //
        // Generating a second copy would make nominally different types from
        // the ones `polyengine_dioxus::{document, history}` call through, which
        // is the same trap the `events`/`dom` mappings exist to avoid.
        "polymorph:dioxus/head@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::head,
        "polymorph:dioxus/history@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::history,
        // REUSED BUT INERT, and worth keeping for the day it is not.
        //
        // The base world declares `import eval` unconditionally, so a mapping
        // has to name something; this points at the renderer's module rather
        // than generating a second copy of the interface, whose types would be
        // nominally different from the ones `polyengine_dioxus::document`
        // holds.
        //
        // NOTHING CALLS IT. `WitDocument` IS installed now (see above — that
        // changed at fdc0d52, and it is why `head` had to be mapped), but the
        // renderer's `eval` Cargo feature is still OFF (`Cargo.toml`, which
        // carries the argument), so `Document::eval` delegates to dioxus's
        // `NoOpDocument` and answers `Unsupported`, the crate names the `eval`
        // interface nowhere, and no import is emitted
        // (polyengine-dioxus/src/document.rs:92-99). Verified rather than
        // assumed: the `e2e/imports` gate runs `wasm-tools component wit` on
        // the built artifact and asserts `head` and `history` are imported and
        // `eval` is not — an unused mapping is bookkeeping, an unused IMPORT
        // would still be a capability the host had to grant.
        "polymorph:dioxus/eval@0.6.0": polyengine_dioxus::bindings::polymorph::dioxus::eval,
    },
    generate_all,
});

use exports::polymorph::visor_spike::control::{
    BackAction, Guest as ControlGuest, Identity as WitIdentity,
};
use polymorph::visor_spike::types::{CloseReason as WitCloseReason, Context as WitContext, Surface as WitSurface};
pub(crate) use polymorph::visor_spike::{embedder, store};
use polymorph::visor_spike::chrome;

/// The renderer's `dom` interface, reached through the reuse above. The strip
/// IS a guest-rendered element, so this is the one half of the drawer's height
/// budget the guest can measure for itself (wit/world.wit:57-61).
use polyengine_dioxus::bindings::polymorph::dioxus::dom;

// --- the live seam ------------------------------------------------------------

/// Live state shared between the Dioxus render and the `control` export.
///
/// The `Runtime` handle is captured inside the component (the only place a
/// Dioxus runtime is on the stack) so that a `control` call, which arrives on a
/// *separate* WIT export task with no runtime pushed, can install a
/// `RuntimeGuard` before touching the signal. This is dioxus-core's own
/// documented escape hatch for exactly this situation
/// (dioxus-core-0.7.10/src/runtime.rs:95-131, the `Runtime::current` panic
/// message's worked example).
struct Live {
    runtime: Rc<Runtime>,
    visor: Signal<Visor>,
}

thread_local! {
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
    /// THE ELEMENT ID OF THE EVENT CURRENTLY BEING DISPATCHED.
    ///
    /// `dom.get-client-rect` takes an ElementId, and the only place a guest is
    /// told one is `handle-event`'s `target` — dioxus-html's `MountedData`
    /// wraps it in the renderer's private `MountedElement`, whose accessors are
    /// all `async` and whose type is not nameable downstream. Since dispatch
    /// into the VirtualDom is synchronous inside `handle_event`, stashing the
    /// argument here for the duration is exact: an `onmounted` handler reads
    /// the id of the element it fired for. Six lines instead of polling a
    /// future that is already resolved.
    static EVENT_TARGET: Cell<u32> = const { Cell::new(0) };
}

/// The measured box of a guest-rendered element. The strip's own budget half
/// and, since the visor's ceremonies became part of this tree, every sheet's
/// natural height (`crate::sheets::SheetRoot`).
pub(crate) fn client_rect(id: u32) -> Option<dom::Rect> {
    dom::get_client_rect(id)
}

/// The id of the element the event now being dispatched fired on.
pub(crate) fn dispatching_target() -> u32 {
    EVENT_TARGET.get()
}

/// Run `f` against the live visor with a Dioxus runtime installed, and mark the
/// signal dirty so the renderer's parked scheduler task wakes and flushes.
///
/// The `Signal` and the `Rc<Runtime>` are copied out before `f` runs, so the
/// `RefCell` borrow never spans a call that might re-enter (the effect drain
/// below does exactly that).
///
/// # NEVER CALL THIS FROM A RENDER BODY. Use [`read_visor`].
///
/// It takes a WRITE borrow, and a write MARKS THE SIGNAL DIRTY unconditionally
/// — that is the whole point of it, and it is what lets a `control` call
/// arriving on a bare export task repaint the strip. Inside a render body the
/// same property is a defect, and it produced both of the two the browser
/// found:
///
///   - a component that also SUBSCRIBES (any [`read_visor`] in its body) and
///     writes here re-renders itself forever — dirty, render, dirty — and the
///     instance never finishes a flush. That was the settings sheet's hang.
///   - a component that only writes here never subscribes AT ALL, so it renders
///     once and never again, and a later state change is invisible to it. That
///     was the erase ceremony never drawing itself armed, even though the
///     machine armed on time and `embedder.tenant-armed` fired.
///
/// One rule removes both: RENDER BODIES READ THROUGH [`read_visor`] AND WRITE
/// NOTHING; handlers, deferred edges and the WIT exports write through here.
pub(crate) fn with_visor<R>(f: impl FnOnce(&mut Visor) -> R) -> Option<R> {
    let live = LIVE.with(|l| l.borrow().as_ref().map(|v| (v.runtime.clone(), v.visor)))?;
    let _guard = RuntimeGuard::new(live.0);
    let mut signal = live.1;
    let mut write = signal.write();
    Some(f(&mut write))
}

/// READ THE LIVE VISOR. The door for the `control`/`sheets`/`marks` queries,
/// and THE ONLY DOOR A RENDER BODY MAY USE — see [`with_visor`] for what
/// happens when a render writes instead.
///
/// It takes a read borrow and marks nothing dirty. Called from inside a
/// component it also SUBSCRIBES that component to the signal, which is not
/// incidental: it is what makes a sheet redraw when the fact it is drawn from
/// changes — the erase ceremony's `.armed` class and its `disabled` attribute
/// both hang off exactly that. Called from a bare WIT export task there is no
/// scope to subscribe, so the same call is a plain read.
pub(crate) fn read_visor<R>(f: impl FnOnce(&Visor) -> R) -> Option<R> {
    let live = LIVE.with(|l| l.borrow().as_ref().map(|v| (v.runtime.clone(), v.visor)))?;
    let _guard = RuntimeGuard::new(live.0);
    let signal = live.1;
    let read = signal.read();
    Some(f(&read))
}

// --- the visor ----------------------------------------------------------------

/// The strip's own way out of a nested place (`back-action`,
/// wit/world.wit:169). `label` is the visor's own wording, used as `title` and
/// `aria-label` and NEVER rendered as text beside the glyph — the strip has no
/// room for a word there, and the glyph is the affordance (visor.ts:510-516).
#[derive(Clone, PartialEq)]
pub struct Back {
    pub label: FrameworkText,
}

/// Everything the strip and the drawer are, in one value the renderer watches.
pub struct Visor {
    // --- the personal, undisclosed anchor ---
    /// `None` while unclaimed: no hue has been read or rolled, so the strip and
    /// the drawer wear visor.css's zero-chroma grey fallback and the claim
    /// reads as THE ARRIVAL OF COLOUR rather than as a shade changing
    /// (visor.css:92-108).
    pub hue: Option<u16>,
    /// True when this boot rolled a FRESH anchor colour — a reset is announced,
    /// never quiet.
    pub fresh: bool,
    /// THE COMMITTED ANCHOR WORD, or "" while unclaimed.
    ///
    /// PRIVATE, AND THAT IS THE MECHANISM. `wit/world.wit:209-215` states it:
    /// there is no getter for the word on `control` and there must never be
    /// one, because a word that reaches pixels is a word a screenshot or a
    /// screen-share hands straight to an app. In TypeScript that is a
    /// module-private `let` (visor.ts:1246). Here it is a private field on a
    /// struct whose module exposes no accessor for it, and [`crate::words`] is
    /// `pub(crate)`, so nothing outside this crate can even name the vocabulary
    /// it was drawn from. `speak_word` and `reroll_word` are the only doors and
    /// both end in the live region.
    word: String,
    word_fresh: bool,
    /// So a fresh roll teaches itself exactly once.
    word_taught: bool,
    pub claimed: bool,

    // --- the strip ---
    pub context: Context,
    /// A timed announcement replaces the whole bottom line for its window, and
    /// then the line comes back by RE-RENDERING from the live context — never
    /// by restoring a saved string, because the thing the line is about can
    /// change while the announcement is showing (visor.ts:933-943). That is
    /// free here: clearing this is the whole revert, and the tree renders from
    /// `context`.
    pub announcement: Option<FrameworkText>,
    /// Bumped by every announcement and by every context MOVE. A REVERT TIMER
    /// WHOSE TOKEN IS STALE HAS BEEN OVERTAKEN AND MUST DO NOTHING
    /// (visor.ts:1497-1499, 1929-1932) — otherwise a four-second-old
    /// announcement's expiry would blank the line a newer one had just claimed.
    announce_token: u64,
    pub back: Option<Back>,
    pub identity: Identity,
    /// The `#visor-live` text. Written as ONE atomic string per activation; see
    /// [`Visor::speak`].
    pub live: String,
    /// `.pulse` on `#visor-context`, cleared by its own `animationend`.
    pub pulsing: bool,
    /// The ElementId of `#visor-strip`, learned from its `onmounted`. The other
    /// half of the drawer's height budget.
    pub strip_id: Option<u32>,

    // --- the record and the conditions ---
    events: EventStore,
    conditions: Conditions,

    // --- the drawer ---
    pub drawer: DrawerState,

    /// THE CEREMONIES' OWN STATE: the consumer's static contributions, and
    /// which surface each open ceremony is about. See `crate::sheets`.
    pub sheets: crate::sheets::SheetsState,
}

/// The button's standing sentence, extended while the dot is lit. The dot
/// carries no text at all, so this is the ONLY channel that tells a non-sighted
/// user the badge is on — and it is a `title`/`aria-label` rather than an
/// announcement because the badge is a standing state, not an arrival
/// (visor.ts:1397-1403).
/// The default announcement dwell (visor.ts:1915's `ms = 8000`).
const ANNOUNCE_MS: u64 = 8_000;

/// One frame at 60Hz — long enough for the host to have applied the `.pulse`
/// removal and the browser to have resolved style over it, which is what
/// visor.ts:1908's forced `offsetWidth` read achieves synchronously. See
/// `pulse_context`; it is the only place a duration here is about the
/// RENDERER's pipeline rather than about the visor's own timing.
const PULSE_RESTART_MS: u64 = 16;

pub const SETTINGS_LABEL: &str = "your visor: name, device, colour";
pub const SETTINGS_LABEL_LIT: &str = "your visor: name, device, colour — recent events waiting";

impl Visor {
    /// Read what is durable and roll what is not. `deferClaim` is not
    /// expressible on `control` — there is no config record — so the
    /// conservative reading of wit/world.wit:199 (`claim: func() -> bool`
    /// exists at all) is that the world is a DEFERRED one: the shell boots
    /// unclaimed and `claim()` is what makes it the user's. An embedder that
    /// wants the ordinary behaviour calls `claim()` at boot.
    pub(crate) fn boot() -> Self {
        // The pre-rename hue key, read once at boot and cleared
        // (`loadVisorHue`'s migration, visor.ts:66-76). Carried to the new slot
        // only if that slot is empty, so an existing user keeps their colour
        // without a re-roll; then dropped, so this runs at most once per device.
        if store::get(store::Slot::Hue).is_none() {
            if let Some(legacy) = store::get(store::Slot::LegacyHue) {
                store::set(store::Slot::Hue, &legacy);
            }
        }
        store::remove(store::Slot::LegacyHue);

        let events = EventStore::parse(store::get(store::Slot::Events).as_deref());
        let identity = Identity::parse(store::get(store::Slot::Identity).as_deref());
        Self {
            hue: None,
            fresh: false,
            word: String::new(),
            word_fresh: false,
            word_taught: false,
            claimed: false,
            context: Context::None,
            announcement: None,
            announce_token: 0,
            back: None,
            identity,
            live: String::new(),
            pulsing: false,
            strip_id: None,
            events,
            conditions: Conditions::default(),
            drawer: DrawerState::default(),
            sheets: crate::sheets::SheetsState::default(),
        }
    }

    /// THE PROVENANCE PREFIX every drawer lifecycle sentence opens with: the
    /// user's own word once there is one, and the literal "visor" before that.
    ///
    /// The pre-claim case is real, not a defensive default: a deferred embedder
    /// puts its unseal picker in the drawer, so the drawer opens and closes —
    /// and therefore speaks — before any identity exists. "visor: this device
    /// open" is the honest sentence there; it names the speaker without
    /// claiming a token that has not been minted (visor.ts:1845-1861).
    pub(crate) fn word_prefix(&self) -> &str {
        if self.word.is_empty() {
            "visor"
        } else {
            &self.word
        }
    }

    /// SAY SOMETHING TO ASSISTIVE TECH ONLY.
    ///
    /// # Why this is one write rather than a queue
    ///
    /// A live region has ONE slot and the screen reader reads it
    /// asynchronously, so writing twice in quick succession destroys the first
    /// message rather than queueing it. TypeScript answers with a FIFO queue and
    /// a `SPEAK_DWELL_MS` dwell (visor.ts:1795-1843), which needs a timer.
    ///
    /// What replaces it here is better, not merely available: `#visor-live`
    /// carries `aria-atomic="true"`, so the region is read WHOLE on every
    /// change. Joining the sentences emitted in one activation into one atomic
    /// write therefore delivers all of them — which is exactly the property the
    /// queue existed to guarantee. visor.ts:1806-1816 names the two cases: a
    /// close that speaks "closed" and then resumes the occupant underneath
    /// (which speaks "back"), and a claim that teaches a fresh word immediately
    /// before the consumer's colour announcement. Both are one synchronous
    /// block, so both survive here.
    ///
    /// KEPT EVEN THOUGH THERE IS NOW A CLOCK. The queue was never the goal; it
    /// was the workaround for a one-slot region, and `aria-atomic` removes the
    /// need for it outright — a joined write delivers every sentence with no
    /// dwell to tune and no burst to cap. Reinstating `SPEAK_DWELL_MS` on top of
    /// this would only add latency.
    ///
    /// CONTRACT: the residual loss is a REPEATED IDENTICAL sentence. An
    /// unchanged live region announces nothing, and the TypeScript
    /// clear-then-set (two turns, 30ms apart) has no equivalent in a single
    /// render flush. It is reachable — `speak-word` twice in a row says the
    /// same words — and the fix, if it is ever wanted, is a second render turn
    /// on the clock this module now has, not the queue.
    fn speak(&mut self, sentences: Vec<String>) {
        let joined = sentences.join(". ");
        if !joined.is_empty() {
            self.live = joined;
        }
    }

    /// A MOVE preempts a live announcement; a mere repaint of the same subject
    /// must not — the app surface being registered a second after boot would
    /// otherwise silently eat the "new visor colour" announcement
    /// (visor.ts:1501-1506, 1956-1960).
    fn set_context(&mut self, ctx: Context) {
        if !self.context.same_subject(&ctx) {
            // A MOVE preempts, and takes the token with it so the preempted
            // announcement's own revert cannot fire later over the new line.
            self.announce_token += 1;
            self.announcement = None;
        }
        self.context = ctx;
    }

    /// LIT = UNSEEN RECORDS ∪ STANDING CONDITIONS. One predicate, so there is
    /// never a state where something is waiting and nothing shows
    /// (visor.ts:1405-1439).
    pub fn badge_lit(&self) -> bool {
        self.events.unseen() > 0 || !self.conditions.is_empty()
    }

    pub fn settings_label(&self) -> &'static str {
        if self.badge_lit() {
            SETTINGS_LABEL_LIT
        } else {
            SETTINGS_LABEL
        }
    }

    /// The drawer's height budget: the viewport, minus the strip the sheet
    /// grows above, minus the band of app that always shows.
    pub(crate) fn budget(&self) -> f64 {
        let strip = self
            .strip_id
            .and_then(dom::get_client_rect)
            .map_or(0.0, |r| r.height);
        DrawerState::budget(chrome::viewport_height(), strip)
    }

    fn persist_events(&self) {
        store::set(store::Slot::Events, &self.events.to_json());
    }
}

/// Wall-clock milliseconds, for an event record's `at`.
///
/// `SystemTime` rather than a logical counter: `event-record.at` is documented
/// as wall-clock (visor.ts:405-408) and is what the events sheet words a coarse
/// age from, so a counter would be a lie in the data. It is the ONE thing this
/// crate takes from `wasi` beyond the world — a clock READ, which is available;
/// a clock WAIT, which is what every ported `setTimeout` needs, is not.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

// --- effects at the edge --------------------------------------------------------

impl From<CloseReason> for WitCloseReason {
    fn from(r: CloseReason) -> Self {
        WitCloseReason { restore_context: r.restore_context }
    }
}

/// THE CLOCK. Run `f` after `ms` milliseconds, off the Dioxus task pool.
///
/// `dioxus_sdk_time::sleep`'s `wasip3` backend waits on
/// `wasi:clocks/monotonic-clock` rather than reaching `setTimeout` through
/// wasm-bindgen, which is what makes a timer expressible in a component at all
/// (see `Cargo.toml`'s patch note). Its own doc records the constraint this
/// call site has to satisfy: "awaiting a WASIp3 import requires a `wit-bindgen`
/// async task to be current, which is the case for code reached from a
/// component's async exports."
///
/// `Runtime::spawn(ScopeId::APP, ..)` rather than the `spawn` of
/// `dioxus::prelude`, because that one needs a current SCOPE and a `control`
/// call arrives on a bare WIT export task with no scope on the stack — the same
/// reason [`with_visor`] has to install a `RuntimeGuard` at all. The task is
/// owned by the app scope, so it dies with the app; and it is first polled by
/// the renderer's scheduler task (`polyengine_dioxus::driver::run`'s
/// `spawn_local`), which is the async export the sleep needs to be current.
///
/// NOTHING HERE CHECKS WHETHER THE WAIT IS STILL WANTED. Every callback below
/// re-checks its own guards instead — the token, the presentation, the
/// occupancy — which is visor.ts's discipline (:1931, :2364, :2491) and the
/// reason a superseded timer is harmless rather than a bug. There is no
/// cancellation and none is needed.
fn later(ms: u64, f: impl FnOnce() + 'static) {
    spawn(async move {
        dioxus_sdk_time::sleep(std::time::Duration::from_millis(ms)).await;
        f();
    });
}

/// SPAWN A TASK ON THE RENDERER'S SCHEDULER. [`later`] is this plus a sleep,
/// and so is every async host import the guest awaits — `embedder.on-reset`
/// being the one that exists (wit/world.wit:230-247).
///
/// `Runtime::spawn(ScopeId::APP, ..)` rather than the `spawn` of
/// `dioxus::prelude`, because that one needs a current SCOPE and a `control` or
/// `sheets` call arrives on a bare WIT export task with no scope on the stack —
/// the same reason [`with_visor`] has to install a `RuntimeGuard` at all. The
/// task is owned by the app scope, so it dies with the app; and it is first
/// polled by the renderer's scheduler task (`polyengine_dioxus::driver::run`'s
/// `spawn_local`), which is the async export a WASIp3 import must be current
/// under. `dioxus_sdk_time::sleep`'s own doc states that constraint — "awaiting
/// a WASIp3 import requires a `wit-bindgen` async task to be current, which is
/// the case for code reached from a component's async exports" — and an async
/// IMPORT generated by `wit_bindgen::generate!` needs exactly the same thing,
/// which is why the two share this one call site rather than each finding their
/// own way onto the pool.
pub(crate) fn spawn(fut: impl std::future::Future<Output = ()> + 'static) {
    let Some(runtime) = LIVE.with(|l| l.borrow().as_ref().map(|v| v.runtime.clone())) else {
        return;
    };
    let _guard = RuntimeGuard::new(runtime.clone());
    runtime.spawn(ScopeId::APP, fut);
}

/// Schedule one of the drawer machine's deferred edges, and feed whatever it
/// then emits back through the same drain.
fn schedule(deadline: Deadline, ms: u64) {
    later(ms, move || match deadline {
        Deadline::Arm { tenant, presentation } => {
            let Some(effects) = with_visor(|v| v.drawer.arm_elapsed(&tenant, presentation)) else {
                return;
            };
            apply_effects(effects);
        }
        Deadline::Swap => {
            with_visor(|v| v.drawer.swap_settled());
        }
        Deadline::Blank => {
            with_visor(|v| v.drawer.collapse_settled());
        }
    });
}

/// Drain the drawer machine's effects: the one-way `embedder` notifications go
/// out, the recomputed context lands on the strip, and every sentence emitted in
/// this activation is spoken as ONE atomic write (see [`Visor::speak`]).
///
/// THE VISOR'S OWN FOUR TENANTS ARE ROUTED DIFFERENTLY on three arms, and each
/// difference is stated in the WIT:
///
///   - `Build` / `Unmount` are DROPPED. wit/world.wit:176-181: "ONLY FOR
///     TENANTS THE HOST OWNS. The visor's own ceremonies — naming, settings,
///     reset, events — are rendered by the guest now, so they never emit this."
///     There is no round trip to wait for: the slide's arrival IS the build,
///     and `crate::sheets::SheetRoot` reports its own measured height back
///     through `mount-sheet`.
///   - `BeforeShow` / `AfterCollapse` additionally run the nested-place
///     bracket (sheets.ts:589-602's `freezePlace`/`thawPlace`, which were these
///     tenants' own spec callbacks). The embedder notification is still sent:
///     it is one-way and identifies the tenant, and withholding it would take
///     information away from a consumer that pauses its runners on it.
///   - `Armed` additionally records the tenant, because a guest-rendered sheet
///     has to draw its own `.armed` class — in TypeScript the drawer host set
///     it on foreign DOM it was holding.
pub(crate) fn apply_effects(effects: Vec<Effect>) {
    let mut sentences = Vec::new();
    for effect in effects {
        match effect {
            Effect::Speak(s) => sentences.push(s),
            Effect::BeforeShow(n) => {
                if crate::sheets::is_visor_tenant(&n) {
                    crate::sheets::freeze_place();
                }
                embedder::tenant_before_show(&n);
            }
            Effect::BeforeCollapse(n, r) => embedder::tenant_before_collapse(&n, r.into()),
            Effect::AfterCollapse(n, r) => {
                if crate::sheets::is_visor_tenant(&n) {
                    crate::sheets::thaw_place();
                }
                embedder::tenant_after_collapse(&n, r.into());
            }
            Effect::AfterRestore(n, r) => embedder::tenant_after_restore(&n, r.into()),
            Effect::Armed(n) => {
                if crate::sheets::is_visor_tenant(&n) {
                    with_visor(|v| v.sheets.armed = Some(n.clone()));
                }
                embedder::tenant_armed(&n);
            }
            Effect::Build(n) => {
                if crate::sheets::is_visor_tenant(&n) {
                    // ARMING IS PER PRESENTATION, and `Build` is emitted by
                    // `DrawerState::present` — so this is the one edge that
                    // fires for a fresh open, a rebuild AND a resume, which is
                    // exactly the set `arm_elapsed`'s presentation token
                    // invalidates. Clearing here is what makes "a resumed sheet
                    // re-arms from zero" (drawer.rs's test of that name) true of
                    // the VISIBLE arming too: without it a reset sheet coming
                    // back would draw its erase button live while the delay it
                    // is behind was really running again.
                    with_visor(|v| {
                        if v.sheets.armed.as_deref() == Some(n.as_str()) {
                            v.sheets.armed = None;
                        }
                    });
                } else {
                    embedder::tenant_build(&n);
                }
            }
            Effect::Unmount(n) => {
                if !crate::sheets::is_visor_tenant(&n) {
                    embedder::tenant_unmount(&n);
                }
            }
            Effect::SetContext(c) => {
                with_visor(|v| v.set_context(c));
            }
            Effect::Schedule(deadline, ms) => schedule(deadline, ms),
        }
    }
    if !sentences.is_empty() {
        with_visor(|v| v.speak(sentences));
    }
}


/// THE ANNOUNCE PATH, reachable from inside the crate as well as from
/// `control.announce` — the visor's own ceremonies say things on the strip
/// (`sheets.ts:963`, `:1002`), and they are framework voice by exactly the
/// argument `control.announce` is: a flat string cannot carry class marking, so
/// an announcement is spoken entirely in the visor's own voice and may embed
/// user-voice words inline. `voice.rs` is why an app-influenced string cannot
/// reach this call from inside the crate at all.
pub(crate) fn announce_framework(text: &str) {
    announce_for(text.to_string(), 0);
}

fn announce_for(text: String, ms: u32) {
    let Some(token) = with_visor(|v| {
        let text = FrameworkText::from(text);
        // SCREEN-READER MIRROR: sighted users get the line, this is the
        // other half (visor.ts:957-959).
        v.speak(vec![text.as_str().to_string()]);
        v.announcement = Some(text);
        v.announce_token += 1;
        v.announce_token
    }) else {
        return;
    };
    let ms = if ms == 0 { ANNOUNCE_MS } else { ms as u64 };
    later(ms, move || {
        with_visor(|v| {
            // Overtaken by a newer render or announcement: that one owns the
            // line now (visor.ts:1929-1932).
            if v.announce_token != token {
                return;
            }
            // REVERT BY RE-RENDER, never by restoring what was there.
            v.announcement = None;
        });
    });
}

// --- WIT conversions ------------------------------------------------------------

fn surface_in(s: &WitSurface) -> crate::state::Surface {
    crate::state::surface_with(
        s.name.clone(),
        &s.nickname,
        &s.icon,
        s.is_new,
        s.petname.as_deref(),
        s.nomination.as_deref(),
        s.meta.as_ref().map(|m| (m.label.clone(), m.value.as_str(), m.foreign)),
        s.first_seen,
    )
}

fn context_in(ctx: &WitContext) -> Context {
    match ctx {
        WitContext::None => Context::None,
        WitContext::Panel(s) => Context::Panel(surface_in(s)),
        WitContext::Credentials(s) => Context::Credentials(surface_in(s)),
        WitContext::Naming(s) => Context::Naming(surface_in(s)),
        WitContext::Storage(s) => Context::Storage(surface_in(s)),
        WitContext::Settings => Context::Settings,
        WitContext::Reset => Context::Reset,
        WitContext::Events => Context::Events,
        WitContext::DevicePicker => Context::DevicePicker,
        WitContext::FirstRun => Context::FirstRun,
        WitContext::PairingJoin => Context::PairingJoin,
        WitContext::PairingAdd => Context::PairingAdd,
    }
}

/// The surface a naming request reports back through `embedder.request-naming`.
///
/// CONTRACT: the round trip is LOSSY, and deliberately so. The guest holds the
/// nickname as an [`crate::voice::AppVoice`] with no text accessor, which is the whole
/// of the app-voice enforcement — so it cannot be handed back. The embedder
/// knows the surface by its `name` (the provenance key it supplied), which is
/// the field the request is actually keyed by; the rest is echoed as the guest
/// holds it.
pub(crate) fn surface_out(s: &crate::state::Surface) -> WitSurface {
    WitSurface {
        name: s.name.clone(),
        nickname: String::new(),
        icon: s.icon.map_or(String::new(), |i| i.as_str().to_string()),
        is_new: s.is_new,
        petname: s.petname.as_ref().map(|p| p.as_str().to_string()),
        // The nomination echoes safely: it is a `MarkIcon`, i.e. one of the
        // crate's own vetted constants, never a component-supplied string.
        nomination: s.nomination.map(|i| i.as_str().to_string()),
        // `meta.value` cannot echo for the same reason `nickname` cannot —
        // it is held as `AppVoice` precisely so no bare copy exists. The
        // embedder supplied it and can re-derive it from `name`.
        meta: None,
        first_seen: s.first_seen,
    }
}

// --- what the strip's own controls report ---------------------------------------

/// Install the signal the `control` export writes to. Called from the component
/// body, which is the only place a Dioxus runtime is on the stack.
pub(crate) fn install_live(visor: Signal<Visor>) {
    LIVE.with(|l| {
        *l.borrow_mut() = Some(Live { runtime: Runtime::current(), visor });
    });
}

/// The strip's naming affordance was used — the petname, the "name it" button,
/// or the cluster as a whole (wit/world.wit:135).
pub(crate) fn report_naming(surface: &crate::state::Surface) {
    embedder::request_naming(&surface_out(surface));
}

/// The identity circle was pressed (wit/world.wit:137).
pub(crate) fn report_settings() {
    embedder::request_settings();
}

/// The back chevron was pressed (wit/world.wit:148).
///
/// The destination is the embedder's, exactly as `BackAction.on-back` is a
/// consumer closure today: the guest owns the chevron and the press, and
/// nothing else. That split is what makes the control worth having —
/// visor.css:128-143 calls it THE UNFORGEABLE EXIT, because "a page's own
/// Cancel sits in scrollable content, which an app can reproduce pixel for
/// pixel inside its own rectangle; this sits in the one region no component can
/// draw."
///
/// The live action is read at PRESS TIME rather than captured when the chevron
/// was rendered (visor.ts:1300-1303), which here is free: there is no action
/// value to capture, only a notification.
pub(crate) fn report_back() {
    embedder::request_back();
}

// --- the exports ----------------------------------------------------------------

/// The world's exports. `run` and `handle-event` delegate to the renderer's
/// driver — the point of the `with:` reuse above is that `driver::run`'s return
/// type IS this export's return type.
///
/// `polyengine_dioxus::launch!` cannot be used: it implements the BASE world's
/// `Guest` and invokes the renderer's own `export!`. Our world is a superset, so
/// the export glue has to come from our own `generate!`.
pub(crate) struct VisorComponent;

impl Guest for VisorComponent {
    /// `mode` is PASSED THROUGH, not decided here. The spike's harness always
    /// asks for `fresh` (host/mount.ts), but the choice is the host's — the
    /// world says so — and a guest that ignored it would silently emit
    /// node-creating operations against a prerendered root, which the WIT
    /// describes as surfacing host-side rather than being silently repaired
    /// (wit/deps/polymorph-dioxus/world.wit:650-656).
    ///
    /// The `match` is not ceremony. `render-mode` is declared in the WORLD, not
    /// in an interface, and `wit_bindgen::generate!`'s `with:` remaps
    /// interfaces only — so our world's `RenderMode` is a nominally distinct
    /// type from the renderer's `polyengine_dioxus::bindings::RenderMode` that
    /// `driver::run` takes, even though the two are structurally identical.
    /// Every other type on this seam (`Operation`, `Payload`, `DomEvent`)
    /// crosses free because each is an interface type the `with:` above
    /// reuses. A new `render-mode` case upstream therefore breaks this build
    /// loudly, which is the right failure.
    async fn run(mode: RenderMode) -> polyengine_dioxus::driver::MutationStream {
        use polyengine_dioxus::bindings::RenderMode as DriverMode;
        let mode = match mode {
            RenderMode::Fresh => DriverMode::Fresh,
            RenderMode::Hydrate => DriverMode::Hydrate,
        };
        polyengine_dioxus::driver::run(crate::app::App, mode).await
    }

    async fn handle_event(target: u32, name: u16, payload: Payload, ev: &DomEvent) {
        // Stashed for the duration of the synchronous dispatch below, so an
        // `onmounted` handler can learn the ElementId of the element it fired
        // for; see `EVENT_TARGET`.
        EVENT_TARGET.set(target);
        polyengine_dioxus::driver::handle_event(target, name, payload, ev).await;
        EVENT_TARGET.set(0);
    }
}

impl ControlGuest for VisorComponent {
    // --- identity and the claim ---------------------------------------------

    /// THE MOMENT THE VISOR BECOMES YOURS: roll (or read) the anchor hue and the
    /// audible anchor word, teach a fresh word out loud, and let the identity
    /// cluster render — colour, name, device and the settings button all
    /// arriving in one frame (visor.ts:909-921, 2634-2658).
    ///
    /// IDEMPOTENT: a second call reports the boot's answer and touches nothing.
    /// The hue must be rolled EXACTLY once, or a "fresh" announced twice would
    /// train users that the anchor colour changes on its own.
    fn claim() -> bool {
        with_visor(|v| {
            if v.claimed {
                return v.fresh;
            }
            v.claimed = true;

            let stored = store::get(store::Slot::Hue).and_then(|s| s.parse::<u16>().ok());
            match stored.filter(|h| crate::state::is_visor_hue(*h)) {
                Some(hue) => {
                    v.hue = Some(hue);
                    v.fresh = false;
                }
                None => {
                    // A silently-reset anchor would train users that "visor
                    // colour changes sometimes", which inverts the training — so
                    // a reset is ANNOUNCED, never quiet, and `fresh` is how the
                    // consumer is told to announce it (visor.ts:83-91).
                    let hue = VISOR_HUES[crate::rng::below(VISOR_HUES.len())];
                    v.hue = Some(hue);
                    v.fresh = true;
                    store::set(store::Slot::Hue, &hue.to_string());
                }
            }

            // THE WORD ARRIVES WITH THE COLOUR, in the same call: they are one
            // identity becoming this user's, and a word rolled at any other
            // moment would either exist before the seal opened or arrive later
            // as a second, unexplained event.
            match store::get(store::Slot::Word).filter(|w| crate::words::is_rollable(w)) {
                Some(word) => {
                    v.word = word;
                    v.word_fresh = false;
                }
                None => {
                    v.word = crate::words::roll(None);
                    v.word_fresh = true;
                    store::set(store::Slot::Word, &v.word);
                }
            }

            // THE ONE SENTENCE THE WHOLE MECHANISM DEPENDS ON. A word the user
            // was never told is a word they cannot use to tell the visor from an
            // app imitating it, so a fresh roll teaches itself out loud —
            // `speak`, never `announce`, because the word must never reach
            // pixels at all (visor.ts:1867-1884).
            if v.word_fresh && !v.word_taught {
                v.word_taught = true;
                let sentence = format!(
                    "your visor's word is {} — it will start everything your visor says",
                    v.word
                );
                v.speak(vec![sentence]);
            }
            v.fresh
        })
        .unwrap_or(false)
    }

    fn get_identity() -> WitIdentity {
        read_visor(|v| WitIdentity {
            name: v.identity.name.as_ref().map_or(String::new(), |n| n.as_str().to_string()),
            device: v.identity.device.as_ref().map_or(String::new(), |d| d.as_str().to_string()),
            icon: v.identity.icon.map_or(String::new(), |i| i.as_str().to_string()),
        })
        .unwrap_or(WitIdentity { name: String::new(), device: String::new(), icon: String::new() })
    }

    fn save_identity(rec: WitIdentity) {
        with_visor(|v| {
            v.identity = Identity {
                name: UserVoice::new(&rec.name, IDENTITY_MAX),
                device: UserVoice::new(&rec.device, IDENTITY_MAX),
                // The same strict gate the stored record is read through: an
                // icon outside the vocabulary is DROPPED rather than kept, so
                // the button falls back to the shield instead of wearing a
                // string a caller chose (visor.ts:393).
                icon: MarkIcon::identity_icon_strict(&rec.icon),
            };
            store::set(store::Slot::Identity, &v.identity.to_json());
        });
    }

    /// The committed hue, for consumers that must paint with it.
    ///
    /// CONTRACT: TypeScript THROWS while unclaimed, "a loud refusal, not a
    /// plausible number" (visor.ts:2713-2718). `committed-hue: func() -> u16`
    /// has no error channel, and a trap would take the whole instance down —
    /// which is a strictly worse failure than the one it is guarding against. It
    /// answers 0 instead, which is not a member of `VISOR_HUES` and so is
    /// detectable by a caller who cares.
    fn committed_hue() -> u16 {
        read_visor(|v| v.hue.unwrap_or(0)).unwrap_or(0)
    }

    /// Live preview: paint without committing. A no-op while unclaimed — see
    /// `committed_hue`'s CONTRACT note — because exactly one code path may put
    /// the first colour on the strip and it is `claim()`.
    fn apply_hue(hue: u16) {
        with_visor(|v| {
            if v.claimed {
                v.hue = Some(hue);
            }
        });
    }

    fn commit_hue(hue: u16) {
        with_visor(|v| {
            if !v.claimed {
                return;
            }
            v.hue = Some(hue);
            store::set(store::Slot::Hue, &hue.to_string());
        });
    }

    /// SAY THE USER'S ANCHOR WORD, to assistive tech only — "remind me what my
    /// word is". One of the only two doors; see [`Visor::word`].
    fn speak_word() {
        with_visor(|v| {
            if !v.claimed {
                return;
            }
            let sentence = format!("your visor's word is {}", v.word);
            v.speak(vec![sentence]);
        });
    }

    /// MINT A NEW ANCHOR WORD and say it, for a user who believes the old one
    /// was overheard. GUARANTEED DIFFERENT (`words::roll`'s `avoid`): a re-roll
    /// that returned the same word would leave a user believing they had rotated
    /// away from a token that is still live.
    fn reroll_word() {
        with_visor(|v| {
            if !v.claimed {
                return;
            }
            let previous = v.word.clone();
            v.word = crate::words::roll(Some(&previous));
            store::set(store::Slot::Word, &v.word);
            // "new", so a user who fires this twice can tell the second sentence
            // from an echo of the first.
            let sentence = format!("your visor's new word is {}", v.word);
            v.speak(vec![sentence]);
        });
    }

    // --- the strip ------------------------------------------------------------

    fn set_context(ctx: WitContext) {
        let ctx = context_in(&ctx);
        with_visor(|v| v.set_context(ctx));
    }

    /// Say something in THE VISOR'S OWN VOICE on the strip's bottom line, and
    /// mirror it to the live region.
    ///
    /// FRAMEWORK VOICE BY CONSTRUCTION: a flat string cannot carry class
    /// marking, so an announcement is spoken entirely in the visor's own voice
    /// and may embed user-voice words inline. See `voice.rs` for why an
    /// app-influenced string cannot reach this call at all from inside the
    /// crate.
    ///
    /// `ms = 0` uses the default dwell (wit/world.wit:222).
    fn announce(text: String, ms: u32) {
        announce_for(text, ms);
    }

    /// THE VISOR POINTING AT ITS OWN CONTEXT LINES. It does NOT touch the
    /// lines' contents — that is the whole point, and it is what a timed
    /// announcement could not do (visor.ts:961-981).
    ///
    /// CALLING IT DURING A LIVE PULSE RESTARTS THE ANIMATION (visor.ts:1904-1909).
    ///
    /// Re-adding a class that is already present does not restart a CSS
    /// animation, so TypeScript removes it, forces a reflow with an
    /// `offsetWidth` read, and re-adds it — all synchronously. A guest cannot
    /// force a reflow: it describes a tree and the renderer flushes one batch
    /// per activation, so a remove-and-re-add inside one activation reaches the
    /// host as no change at all. The restart therefore has to be two flushes
    /// with a style resolution between them, which is what the frame-length
    /// wait below buys — the clock standing in for the forced reflow.
    ///
    /// The wait is paid ONLY on a restart. A pulse arriving on a quiet cluster
    /// is set straight away, because there is nothing to take off first.
    fn pulse_context(sr_text: Option<String>) {
        let restarting = with_visor(|v| {
            if let Some(text) = sr_text.filter(|t| !t.is_empty()) {
                v.speak(vec![text]);
            }
            let live = v.pulsing;
            // Off first, so the class removal gets a flush of its own.
            v.pulsing = false;
            live
        });
        if restarting != Some(true) {
            with_visor(|v| v.pulsing = true);
            return;
        }
        later(PULSE_RESTART_MS, || {
            with_visor(|v| v.pulsing = true);
        });
    }

    fn set_back(action: Option<BackAction>) {
        with_visor(|v| {
            // THE VISOR'S OWN WORDING, always: `label` is framework voice and
            // may embed the user's vocabulary, never a component's.
            v.back = action.map(|a| Back {
                label: FrameworkText::from(a.label.unwrap_or_else(|| "back".to_string())),
            });
        });
    }

    // --- the event record and standing conditions -------------------------------

    fn add_event(text: String) {
        with_visor(|v| {
            v.events.push(now_ms(), FrameworkText::from(text));
            v.persist_events();
        });
    }

    fn list_events() -> Vec<exports::polymorph::visor_spike::control::EventRecord> {
        read_visor(|v| {
            v.events
                .newest_first()
                .into_iter()
                .map(|e| exports::polymorph::visor_spike::control::EventRecord {
                    at: e.at,
                    text: e.text.into_string(),
                })
                .collect()
        })
        .unwrap_or_default()
    }

    fn mark_events_seen() {
        with_visor(|v| {
            v.events.mark_seen(now_ms());
            v.persist_events();
        });
    }

    fn unseen_event_count() -> u32 {
        read_visor(|v| v.events.unseen()).unwrap_or(0)
    }

    fn set_condition(key: String, text: String) -> bool {
        with_visor(|v| v.conditions.set(key, FrameworkText::from(text))).unwrap_or(false)
    }

    fn clear_condition(key: String) -> bool {
        with_visor(|v| v.conditions.clear(&key)).unwrap_or(false)
    }

    fn list_conditions() -> Vec<(String, String)> {
        read_visor(|v| {
            v.conditions.list().map(|(k, t)| (k.to_string(), t.as_str().to_string())).collect()
        })
        .unwrap_or_default()
    }

    // --- the drawer host ---------------------------------------------------------

    fn register_tenant(spec: exports::polymorph::visor_spike::control::TenantSpec) {
        with_visor(|v| {
            v.drawer.register(TenantSpec {
                name: spec.name,
                spoken: FrameworkText::from(spec.spoken),
                exclusive: spec.exclusive,
                armed: spec.armed,
                dim: spec.dim,
                suspendable: spec.suspendable,
            });
        });
    }

    fn open_tenant(tenant: String, ctx: WitContext) -> bool {
        let ctx = context_in(&ctx);
        let Some((ok, effects)) = with_visor(|v| {
            let budget = v.budget();
            let prefix = v.word_prefix().to_string();
            v.drawer.open(&tenant, ctx, &prefix, budget)
        }) else {
            return false;
        };
        apply_effects(effects);
        ok
    }

    fn close_tenant(tenant: String, reason: WitCloseReason) {
        let reason = CloseReason { restore_context: reason.restore_context };
        let Some(effects) = with_visor(|v| {
            let prefix = v.word_prefix().to_string();
            v.drawer.close(&tenant, reason, &prefix)
        }) else {
            return;
        };
        apply_effects(effects);
    }

    fn rebuild_tenant(tenant: String) {
        let Some(effects) = with_visor(|v| v.drawer.rebuild(&tenant)) else { return };
        apply_effects(effects);
    }

    fn tenant_is_open(tenant: String) -> bool {
        read_visor(|v| v.drawer.is_open(&tenant)).unwrap_or(false)
    }

    fn tenant_is_suspended(tenant: String) -> bool {
        read_visor(|v| v.drawer.is_suspended(&tenant)).unwrap_or(false)
    }

    fn restore_context() {
        let Some(effects) = read_visor(|v| v.drawer.restore_context()) else { return };
        apply_effects(effects);
    }

    fn mount_sheet(tenant: String, height: f64) {
        let Some(effects) = with_visor(|v| {
            let budget = v.budget();
            v.drawer.mount_sheet(&tenant, height, budget)
        }) else {
            return;
        };
        apply_effects(effects);
    }

    fn resize_sheet(height: f64) {
        with_visor(|v| {
            let budget = v.budget();
            v.drawer.resize_sheet(height, budget);
        });
    }

    /// FORGET EVERYTHING THIS VISOR HOLDS ON THIS DEVICE — the storage half of
    /// the reset ceremony (visor.ts:1168-1199). Every slot at once, through
    /// `store.clear-all`, so a slot added later cannot be forgotten by a caller
    /// enumerating them by hand (wit/world.wit:50-53).
    ///
    /// IT DOES NOT REPAINT, ANNOUNCE OR RESTORE ANYTHING, and that is not an
    /// omission: the caller reloads immediately afterwards, and a fresh boot
    /// rolls a fresh anchor and announces it through the existing `fresh`
    /// mechanics. The standing conditions are untouched because they were never
    /// persisted in the first place — there is nothing here that could remove
    /// one.
    fn erase() {
        store::clear_all();
    }
}

export!(VisorComponent);

