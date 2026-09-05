//! DEVICE ENROLLMENT, IN VISOR PIXELS (`visor/ui/pairing.ts`, PAIRING.md §5).
//!
//! # WHAT THE CEREMONY IS FOR
//!
//! A device joins an existing account, or an enrolled device admits a new one.
//! Both halves end in a SHORT AUTHENTICATION STRING that two humans compare
//! out of band. The property being bought is stated at wit/world.wit:548-553:
//! **a relay which can see and modify everything on the wire still cannot get
//! a device enrolled**, because it cannot make two people read the same digits
//! to each other over a channel it is not on.
//!
//! Everything cryptographic belongs to the backend. THE VISOR'S ENTIRE
//! CONTRIBUTION is two things, and they are the two things a backend cannot do
//! for itself:
//!
//!   1. the digits appear somewhere an app cannot draw and cannot read — the
//!      drawer hanging off the pinned strip, which is the geometry
//!      `visor/ui/visor.css:128-143` calls unforgeable;
//!   2. confirming is a DELIBERATE HUMAN PRESS on a control the visor drew.
//!
//! Neither is cryptography and both are load-bearing. A SAS rendered inside a
//! component frame is a SAS an attacker can render; a SAS confirmed by
//! anything other than a person looking at it is not compared at all.
//!
//! # THE PATTERN THIS FOLLOWS
//!
//! `crate::sheets`'s module header, in full — these are two more guest-rendered
//! ceremonies and they obey the same rules, so that header is the contract and
//! this one only records where pairing differs. In particular:
//!
//!   - each sheet is a no-prop `#[component]`, KEYED BY PRESENTATION, so a
//!     re-presentation REBUILDS it. For a pairing ceremony that is not merely
//!     acceptable, it is required: a half-typed device name and a pending
//!     comparison must not survive the drawer having gone away and come back.
//!   - transient state is `use_signal`/`use_hook`;
//!   - the root is always [`crate::sheets::SheetRoot`], which measures itself
//!     and draws `.armed`;
//!   - render bodies READ through `component::read_visor` and write nothing
//!     (`component::with_visor`'s header — the two defects it records were
//!     both browser-visible, and one of them was an arming delay silently
//!     going dead, which is the exact control this module depends on).
//!
//! # WHERE THE SESSION LIVES, and why it is not on `Visor`
//!
//! In TypeScript a pane's phase lived in a closure (`mountJoinPane`'s locals,
//! pairing.ts:517-519). Here it is a `use_signal` inside the sheet, which is
//! the same lifetime — dead with the presentation — and additionally is a
//! SUBSCRIPTION, so the poll loop's writes redraw the sheet. Putting it on
//! `Visor` would have been the wrong shape twice over: it is transient (rule 2
//! of the sheets header), and it would need a field on a struct this wave does
//! not own.
//!
//! THE ONE THING THAT OUTLIVES THE SHEET is the add flow's post-grant watch —
//! see [`add`]. It holds no UI state, only the announcement it still owes.
//!
//! # THE POLL, which is new here and belongs to the visor now
//!
//! `visor/ui/pairing.ts` does not poll: it exposes `tick()` and the host page
//! drives it on a `setInterval` (demo/host/pairing-demo.ts:98-110,
//! demo/host/demo.ts:3530-3533). The `pairing` interface has no `tick`
//! (wit/world.wit:709-723) — deliberately, since the consumer is not being
//! asked to run the visor's ceremony for it — so the loop moved inside, onto
//! the clock `component::later` already provides. Every iteration re-checks
//! its own guards, which is this crate's standing discipline for a deferred
//! edge (`component::later`'s header): still the tenant that owns the drawer?
//! still the same presentation? still not settled?

#[cfg(target_arch = "wasm32")]
use dioxus::prelude::*;

#[cfg(target_arch = "wasm32")]
use crate::component::{
    exports::polymorph::visor_spike::control::Guest as ControlGuest, now_ms, read_visor,
    with_visor, VisorComponent,
};
#[cfg(target_arch = "wasm32")]
use crate::drawer::TenantSpec;
#[cfg(target_arch = "wasm32")]
use crate::state::Context;

#[cfg(target_arch = "wasm32")]
pub mod add;
#[cfg(target_arch = "wasm32")]
pub mod join;
#[cfg(target_arch = "wasm32")]
pub mod render;

#[cfg(target_arch = "wasm32")]
pub mod export;

/// THE PURE HALF, re-exported so every use site reads
/// `crate::pairing::phase::…` / `::qr::…` / `::us::…` as if declared here.
///
/// They are not, and cannot be: `src/lib.rs` gates this whole module on
/// `wasm32`, so anything declared here is invisible to `cargo test`. The files
/// live in `src/pairing/pure/` and are declared from `crate::state`, which the
/// host build compiles — see that declaration and `pure/mod.rs`'s header for
/// the one-line change to `lib.rs` that removes the indirection entirely.
/// The ceremony state machines, the QR matrix and every announcement's
/// wording name no binding, no DOM node and no clock — so they compile and
/// RUN on the host, and their tests are real `cargo test` tests rather than
/// merely typechecked claims. Only the rendering modules above are gated.
pub mod pure;
pub use pure::{devices, phase, qr, text, us};

// --- the two tenants ---------------------------------------------------------

/// This device joining an existing account.
pub const JOIN: &str = "pair-join";
/// This device admitting another.
pub const ADD: &str = "pair-add";

/// Is this one of the pairing ceremonies? The predicate `crate::sheets`'s
/// router consults so a pairing slide is grown by the guest rather than left
/// as a leaf awaiting foreign DOM.
pub fn is_pairing_tenant(name: &str) -> bool {
    matches!(name, JOIN | ADD)
}

/// HOW LONG A CONSEQUENTIAL LINE HOLDS THE STRIP against ambient traffic
/// (`STICKY_MS`, pairing.ts:191). The lesson it encodes is #22's: a revocation
/// note erased by a statistics tick is a revocation the user never saw.
#[cfg(target_arch = "wasm32")]
const STICKY_MS: u64 = 12_000;

/// HOW OFTEN THE CEREMONY READS THE DRIVER. `demo/host/demo.ts:3533`'s 200ms,
/// which is the interval the visor-integrated consumer actually ran (the
/// standalone pairing page used 150). Fast enough that the comparison screen
/// appears to arrive with the other device's scan, slow enough that a session
/// sitting on `waiting` for the offer's full window is not thousands of calls.
#[cfg(target_arch = "wasm32")]
const POLL_MS: u64 = 200;

/// THE TWO SPECS, and the weight classes are the whole argument.
///
/// BOTH ARE `exclusive` AND BOTH `dim`. A ceremony with a code or a SAS on
/// screen must not be displaceable by a stray tap on the strip, for the reason
/// `crate::sheets::specs` gives the erase ceremony: the user is mid-decision on
/// something with no undo, and the decision is being made by comparing two
/// screens. Dimming the page behind it is the same argument one step further —
/// while the user reads digits off the visor, the page must stop competing for
/// the gesture. Note that `dim` here is UNCONDITIONAL rather than resolved from
/// `nested-place-active` as the three lightweight sheets are: there is no case
/// where a pairing ceremony wants the page live behind it.
///
/// THEY DIFFER ON WHERE THE ARMING DELAY LIVES, AND THAT IS THE WEIGHT CLASS
/// (pairing.ts:32-38, :556-561):
///
///   - JOIN IS LIGHT AND HAS NO DELAY AT ALL. Nothing secret is typed, the
///     gesture starts from pixels the visor drew, and the worst a mis-tap costs
///     is a cancelled join the user starts again. Paying the arming tax here
///     would buy nothing and would train users to click through a delay that
///     means something elsewhere — which is `crate::sheets::specs`'s stated
///     reason for keeping the delay off the three lightweight sheets, and it
///     applies verbatim.
///   - ADD IS HEAVY: the device it admits becomes admin of everything in the
///     account, so its grant pays the full price.
///
/// BUT NOTE `armed: false` ON BOTH, AND READ `add.rs`'s HEADER BEFORE CHANGING
/// IT. `TenantSpec::armed` is a PRESENTATION-SCOPED delay: the drawer starts it
/// when the sheet is presented. The add ceremony's dangerous control does not
/// exist then — the user has a code to paste, a connection to wait for and
/// digits to compare first — so a presentation-scoped delay would have elapsed
/// tens of seconds before the grant button was ever drawn, and the button would
/// be live the instant it appeared. That is an arming delay that is present in
/// the spec, visible in the code, and buys NOTHING.
///
/// So the add flow arms its GRANT CONTROL, from the mount of the screen that
/// carries it, which is what `visor/ui/pairing.ts:796-805` does (its
/// `setTimeout` is in `renderConsequenceScreen`, not at pane mount). The
/// duration is `crate::drawer::ARM_MS` — the framework's one arming duration,
/// reached as a constant so there is no second value to drift. The sheet's
/// ordinary controls (the code field, "codes match — continue", Cancel) are
/// light and are correctly NOT held behind anything.
///
/// NEITHER IS `suspendable`. A ceremony whose whole content is a live session
/// with another device cannot be put away and resumed: by the time it slid
/// back, the offer has expired or the peer has given up. Better to end it
/// honestly than to restore a screen that is lying about being live.
#[cfg(target_arch = "wasm32")]
fn specs() -> [TenantSpec; 2] {
    [
        TenantSpec {
            name: JOIN.into(),
            // Named by the ACT and from THIS device's point of view. "pairing"
            // would be the jargon; a user who mis-navigated needs to know from
            // the first syllable which of the two ceremonies they are in,
            // because the two look alike and mean opposite things.
            spoken: "join this device to your account".into(),
            exclusive: true,
            armed: false,
            dim: true,
            suspendable: false,
        },
        TenantSpec {
            name: ADD.into(),
            // The other direction, said so plainly that hearing the wrong one
            // is impossible: this device is the one GIVING access.
            spoken: "add another device to your account".into(),
            exclusive: true,
            // See the note above — the delay is real and is `add.rs`'s.
            armed: false,
            dim: true,
            suspendable: false,
        },
    ]
}

/// Register the two, ONCE and idempotently.
///
/// LAZY, for `crate::sheets::ensure_registered`'s reason and no other:
/// registration order is precedence order, and a consumer with an exclusive
/// tenant of its own must be able to register it FIRST. Registering at boot
/// would put these ahead of everything and take that decision away. Doing it on
/// the consumer's first `pairing` call leaves the ordering where TypeScript
/// left it — whoever called first is ahead.
///
/// `DrawerState::register` updates a spec in place rather than appending, so
/// calling this twice cannot produce a second entry or reorder the pair.
#[cfg(target_arch = "wasm32")]
fn ensure_registered() {
    with_visor(|v| {
        for spec in specs() {
            v.drawer.register(spec);
        }
    });
}

/// OPEN ONE PAIRING CEREMONY. Returns whether the drawer took it.
///
/// The tenants are registered here and then
/// [`crate::sheets::open_ceremony`] does the rest — the consumer's `can-open`
/// refusal, `before-open`, the drawer machine's own precedence check and the
/// effect drain. Its own re-registration loop matches on the four sheet
/// tenants only, so it leaves these two exactly as registered above.
///
/// `Entry::FromOutside` for both: a pairing ceremony is always entered from
/// outside — `pairing.request-join`/`request-add` are the consumer's calls —
/// so the consumer's preconditions run, and the refusal comes first so that a
/// request arriving while an exclusive sheet is up is a pure no-op.
#[cfg(target_arch = "wasm32")]
fn open(tenant: &str, ctx: Context) -> bool {
    ensure_registered();
    crate::sheets::open_ceremony(tenant, ctx, crate::sheets::Entry::FromOutside)
}

/// WHICH CONTEXT THE STRIP SHOWS while a pairing ceremony holds the drawer.
///
/// `types.context` now carries `pairing-join` and `pairing-add`
/// (wit/world.wit:184-196), so this is a straight mapping.
///
/// WHAT THIS REPLACED, kept because the reasoning is the interesting part. The
/// first cut of this wave had no cases to map to, and borrowed the context of
/// whatever surface each ceremony was reached FROM — `Settings` for the add
/// flow (it opens from the settings sheet's "add a device…" action) and
/// `FirstRun` for the join flow (PAIRING.md §5 makes it the second phase of the
/// first-run sheet). That kept `sheet_is_open()` true and `is_tappable()`
/// false, which are the two properties a ceremony holding a short
/// authentication string actually needs, so it was the safe direction — but the
/// strip then read "visor settings" while a comparison screen was up, and the
/// bottom line's whole job is to answer "which pixels am I looking at". A safe
/// sentence that is not a true one is still the wrong sentence on this line.
#[cfg(target_arch = "wasm32")]
fn context_for(tenant: &str) -> Context {
    if tenant == ADD {
        Context::PairingAdd
    } else {
        Context::PairingJoin
    }
}

/// Close one pairing ceremony.
#[cfg(target_arch = "wasm32")]
pub fn close(tenant: &str, restore_context: bool) {
    crate::sheets::close_ceremony(tenant, restore_context);
}

/// Is this ceremony the one holding the drawer? `crate::sheets::owns`, which
/// every handler and every deferred edge in this module is guarded on for the
/// reason stated there.
#[cfg(target_arch = "wasm32")]
fn owns(tenant: &str) -> bool {
    crate::sheets::owns(tenant)
}

// --- the announcement sink ---------------------------------------------------

thread_local! {
    /// WHEN THE CURRENT CONSEQUENTIAL LINE STOPS OUTRANKING AMBIENT TRAFFIC.
    ///
    /// The port of pairing.ts's module-level `stickyUntil` map (:192), narrowed
    /// to one entry because there is exactly one surface here: the strip is a
    /// singleton per page, and the standalone pairing page's per-pane status
    /// lines — the reason the TypeScript needed a keyed map — do not exist in
    /// a visor that owns its own pixels.
    ///
    /// A `Cell` in this module rather than a field on `Visor`: it is
    /// ANNOUNCEMENT PRIORITY, not visor state — nothing renders from it, and
    /// marking the render signal dirty for it would be a write with no reader.
    static STICKY_UNTIL: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// SAY ONE LINE ON THE STRIP, with the priority the #22 rulings ask for.
///
/// THE THREE THINGS THIS DOES, and each is a rule rather than a convenience:
///
///   1. AN AMBIENT LINE ARRIVING INSIDE A CONSEQUENTIAL LINE'S WINDOW IS
///      DROPPED, not queued (pairing.ts:218-221). It is ambient — the next
///      poll brings another — and the alternative is the lesson the sticky
///      window exists for: a "device revoked" erased by a "connecting…".
///   2. EVERY CONSEQUENTIAL ANNOUNCEMENT LEAVES A RECORD, and ambient ones
///      never do (#132, pairing.ts:228-253). It lives here, in the one place
///      this module's traffic funnels through, because that is what makes it a
///      rule rather than a habit — a consequential event source written later
///      is recorded the day it is written. The gate is the flag the line
///      already carried; ambient telemetry stays out, or the event list
///      becomes junk mail and the one alarm that matters drowns in it.
///   3. THE RECORD IS WRITTEN BEFORE THE ANNOUNCEMENT (pairing.ts:240-243).
///      The memory is the half that has to survive.
///
/// THE AUTHOR RULE HOLDS BY CONSTRUCTION ON THIS PATH. Everything that reaches
/// here is visor-authored (`phase.rs`'s sentences, `us::describe`'s) or
/// driver-authored, and a `pairing-driver` is the EMBEDDER's implementation —
/// host code on the visor's side of the app seam, not a sandboxed component
/// (pairing.ts:176-185). Nothing an app influenced can light the user's own
/// identity circle. The one string that genuinely crosses from another device —
/// a petname, a device name — is clamped and dressed in `us.rs`, never here.
#[cfg(target_arch = "wasm32")]
fn say(line: phase::Line) {
    say_all(vec![line]);
}

/// SAY EVERYTHING THIS ACTIVATION HAS TO SAY, AS ONE WRITE.
///
/// # Why this is not a loop over [`say`]
///
/// It was, and that was a defect the browser found: a reconcile that had both a
/// colour change and a rename to report announced the colour, then overwrote it
/// with the name a microsecond later, and the user was never told about the
/// colour at all. Announced-never-silent, broken by the announcing mechanism.
///
/// `Visor::speak`'s header states the rule this obeys: a live region has ONE
/// SLOT, and writing twice in quick succession destroys the first message
/// rather than queueing it. `#visor-live` carries `aria-atomic="true"`, so the
/// region is read WHOLE on every change — which makes JOINING the sentences
/// emitted in one activation into a single write deliver all of them. That is
/// exactly what `component::apply_effects` already does with the drawer
/// machine's sentences, and this is the same discipline applied to the
/// ceremonies' own.
///
/// THE RECORD STAYS ONE ENTRY PER LINE. Only the announcement is joined. The
/// event list is the durable log and wants each fact findable on its own; the
/// strip's bottom line is a transient "look at this now" and wants one
/// utterance. Splitting the two is what lets both be right.
#[cfg(target_arch = "wasm32")]
fn say_all(lines: Vec<phase::Line>) {
    let now = now_ms();
    let sticky = STICKY_UNTIL.with(|s| s.get()) > now;
    let mut speak: Vec<String> = Vec::new();
    let mut consequential = false;
    for line in lines {
        if !line.consequential {
            // An ambient line arriving inside a consequential line's window is
            // DROPPED, not queued (pairing.ts:218-221) — it is ambient, and the
            // next poll brings another. The lesson is #22's: a "device revoked"
            // erased by a "connecting…".
            if sticky {
                continue;
            }
            speak.push(line.text);
            continue;
        }
        consequential = true;
        // EVERY CONSEQUENTIAL ANNOUNCEMENT LEAVES A RECORD, and ambient ones
        // never do (#132, pairing.ts:228-253). It lives here, in the one place
        // this module's traffic funnels through, because that is what makes it
        // a rule rather than a habit. BEFORE the announcement: the memory is
        // the half that has to survive.
        VisorComponent::add_event(line.text.clone());
        speak.push(line.text);
    }
    if speak.is_empty() {
        return;
    }
    // ". " is `Visor::speak`'s own join, so a joined announcement reads the way
    // a joined live-region write does.
    let text = speak.join(". ");
    if consequential {
        STICKY_UNTIL.with(|s| s.set(now + STICKY_MS));
        VisorComponent::announce(text, STICKY_MS as u32);
    } else {
        // The default dwell; `control.announce`'s `ms = 0` means exactly that
        // (wit/world.wit:222).
        VisorComponent::announce(text, 0);
    }
}

// --- the poll ----------------------------------------------------------------

/// IS THIS PRESENTATION STILL THE ONE THAT STARTED THE POLL?
///
/// The tenant owning the drawer is not enough on its own: a ceremony can be
/// closed and re-opened, and the second presentation has its own sheet, its own
/// signal and its own poll loop. Without this, the first loop would go on
/// writing into a signal belonging to a sheet that is gone — or, worse, the
/// two loops would both drive the second sheet.
///
/// `Slide::key` is per presentation and never reused (`crate::app`'s header),
/// so it is exactly the token wanted, and it is the same shape of guard
/// `DrawerState::arm_elapsed` uses for the arming delay.
#[cfg(target_arch = "wasm32")]
fn presentation_of(tenant: &str) -> Option<u64> {
    read_visor(|v| v.drawer.slides().iter().find(|s| s.tenant == tenant).map(|s| s.key)).flatten()
}

// --- re-measuring a sheet that changes height --------------------------------

/// `.cred-sheet`'s OWN VERTICAL PADDING in device pixels: `padding: .8em 1.1em
/// 1.1em` at `font-size: 13px` (visor.css:713-716). `(0.8 + 1.1) * 13`.
///
/// CONTRACT: a number lifted out of a READ-ONLY stylesheet, which is a drift
/// risk and is why it is named and cited rather than inlined. It is needed
/// because [`Frame`] can measure only the element it is attached to — its own
/// wrapper, INSIDE `crate::sheets::SheetRoot`'s padded box — and the drawer
/// wants the height of the box. Everything else about the sheet's geometry is
/// measured rather than assumed. The exact fix, if this is ever wanted
/// properly, is for `SheetRoot` to expose the ElementId it already learns in
/// its `onmounted`; that is a change in another wave's file. REPORTED.
#[cfg(target_arch = "wasm32")]
const SHEET_PADDING_PX: f64 = (0.8 + 1.1) * 13.0;

/// RE-REPORT THE SHEET'S HEIGHT WHEN THE CEREMONY CHANGES SCREENS.
///
/// # Why the pairing sheets need this and the visor's own four do not
///
/// `crate::sheets::SheetRoot` measures itself ONCE, in its `onmounted`, and
/// `DrawerState::mount_sheet` refuses any later call — it early-returns unless
/// the tenant is the one whose build the drawer is still `awaiting`. That is
/// sound for all four of the visor's own ceremonies, because each is
/// EFFECTIVELY FIXED HEIGHT for its presentation: the events list is read once
/// per mount, the erase ceremony's text is static, and `.cred-reason` carries
/// a reserved `min-height` (visor.css:734-735) precisely so a refusal line
/// appearing does not move anything.
///
/// A PAIRING CEREMONY IS A STATE MACHINE WITH SCREENS OF DIFFERENT SIZES: a QR
/// and a 79-character code, then a line of digits, then a statement of
/// consequence with a form under it. Measured once at mount, the drawer would
/// hold the first screen's height for the whole ceremony — and it did, visibly:
/// the browser probe showed the join sheet clipped, with the QR scrolled out of
/// the drawer entirely.
///
/// `control.resize-sheet` is the door for exactly this (wit/world.wit:521-523 —
/// "the ResizeObserver the host keeps on the foreign root"). A guest-rendered
/// sheet has no host-side observer, so it reports its own changes, which is the
/// same shift of responsibility `SheetRoot`'s self-measurement already is.
///
/// KEYED BY THE SCREEN. `key` forces a remount when the screen changes, and the
/// remount is what fires `onmounted` again — the same trick the drawer's slides
/// use, and the reason `Slide::key` is per presentation.
/// KEYED-LIST DIFFING, not a bare `key`. A `key` on a single non-list child is
/// not what forces a remount — Dioxus diffs that position and updates the
/// element in place, so `onmounted` fires exactly once and never again. This
/// was measured, not assumed: the join sheet stayed clamped at its first
/// screen's 69px while its content was 301px tall, with the QR scrolled out of
/// the drawer entirely.
///
/// Rendering the wrapper as a ONE-ELEMENT KEYED LIST puts it on the keyed
/// diffing path, where a changed key removes the old node and creates a new
/// one — and the creation is what re-fires `onmounted`.
#[component]
#[cfg(target_arch = "wasm32")]
pub fn Frame(key_for: String, children: Element) -> Element {
    rsx! {
        for k in std::iter::once(key_for.clone()) {
        div {
            key: "{k}",
            onmounted: move |_| {
                let id = crate::component::dispatching_target();
                let Some(rect) = crate::component::client_rect(id) else { return };
                // NOT a render body: this is an event handler, so it may write
                // (`component::with_visor`'s header). `resize_sheet` re-clamps
                // against a freshly-read budget.
                VisorComponent::resize_sheet(rect.height + SHEET_PADDING_PX);
            },
            {children.clone()}
        }
        }
    }
}
