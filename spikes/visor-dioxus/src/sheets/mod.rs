//! THE VISOR'S OWN FOUR CEREMONIES, as part of the Dioxus tree
//! (`visor/ui/sheets.ts`'s `registerVisorSheets`).
//!
//! In TypeScript these were built as foreign DOM and handed to the drawer host
//! through `control.mount-sheet`. They are guest-rendered now, which is what
//! `wit/world.wit:309-317`'s `sheets` interface exists to drive, and it changes
//! three things structurally. Everything below is the contract the other waves
//! fill in against.
//!
//! # THE PATTERN. Read this before adding a sheet.
//!
//! One submodule per ceremony, each exporting exactly two items:
//!
//! ```text
//!   naming.rs    NamingSheet   — the naming ceremony (sheets.ts:736-1033)
//!   settings.rs  SettingsSheet — the visor's settings (sheets.ts:1038-1446)
//!   events.rs    EventsSheet   — the event list      (sheets.ts:1691-1804)
//!   reset.rs     ResetSheet    — the erase ceremony  (sheets.ts:1457-1661)
//! ```
//!
//! 1. **The sheet is a `#[component]` taking no props.** It is mounted by
//!    [`Sheet`] below, inside the slide its tenant owns, and is KEYED BY
//!    PRESENTATION — so it is remounted, never updated, when the drawer
//!    re-presents. That is not an implementation detail, it is the port of
//!    sheets.ts's rule that a suspended sheet is REBUILT on resume rather than
//!    restored ("the world moved while it was away", visor.ts's ruling quoted
//!    at sheets.ts:1350-1353): unsaved edits drop because the component
//!    remounts, with nothing to write to make it so.
//!
//! 2. **Per-ceremony state is a local signal; the ceremony's SUBJECT is in
//!    [`SheetsState`].** What the user has typed, which glyph is picked, which
//!    six were offered — all `use_signal`/`use_hook` inside the sheet, because
//!    all of it must die with the presentation. What the ceremony is ABOUT
//!    arrives from outside through the `sheets` export and therefore lives on
//!    [`SheetsState`], which the render reads. `use_hook` is also what makes
//!    "freshly per ceremony" true of the icon offers with no extra machinery:
//!    it runs once per mount, and a mount is a presentation.
//!
//! 3. **The root element is [`SheetRoot`], always.** It is the ONE piece of
//!    shared chrome (see "What was NOT extracted" below), and the reason is not
//!    the markup — it is that a guest-rendered sheet has to MEASURE ITSELF.
//!
//! 4. **Every write goes: table/store first, then `embedder`, then close, then
//!    announce.** The orderings are stated per callback in `wit/world.wit` and
//!    each carries a reason; `on-reset` inverts it and says why
//!    (wit/world.wit:240-245).
//!
//! # What replaced the `tenant-build` round trip
//!
//! `wit/world.wit:176-181`: `embedder.tenant-build` is now "ONLY FOR TENANTS
//! THE HOST OWNS", so these four never emit it — `component::apply_effects`
//! drops `Build` and `Unmount` for a tenant [`is_visor_tenant`] recognises.
//! What used to be "ask the host to build, wait for `mount-sheet`" is now: the
//! drawer machine presents a slide, the Dioxus tree grows the sheet inside it,
//! and [`SheetRoot`]'s `onmounted` measures its own client rect and calls
//! `mount-sheet` itself. The drawer machine is untouched — it is still waiting
//! on exactly the same `awaiting` token, and `DrawerState::mount_sheet` still
//! starts the reveal and the arming delay. Only the party that answers changed.
//!
//! That is also why the sheet may be a subtree at all. `app.rs`'s header calls
//! `.visor-slide` A LEAF, because the renderer's applier walks template paths
//! by CHILD INDEX and a foreign root interleaved among guest siblings would
//! corrupt addressing. The rule is unchanged and the reasoning still holds: a
//! slide's tenant is fixed for the slide's whole life (`Slide::key` is per
//! presentation and never reused), so a slide is EITHER guest-rendered
//! throughout — in which case the applier addresses only nodes it emitted — or
//! a leaf awaiting foreign DOM. What is forbidden is the mixture, and nothing
//! here can produce one.
//!
//! # What IS and is NOT shared chrome
//!
//! [`SheetRoot`] is the whole of it, and it earns its place on the measurement
//! plumbing rather than on its four lines of markup.
//!
//! NOT EXTRACTED, deliberately, having read all four builders:
//!
//!   - `.cred-note`, `.cred-reason`, `.cred-line` + `.said` lead. Four, two and
//!     many sites respectively — but each is one element with one class, and a
//!     component wrapping `div { class: "cred-note", "…" }` would be strictly
//!     more to read than the thing it replaced.
//!   - The `.cred-row` button pair. It looks like four sites and is not: naming
//!     and settings share Save/Cancel, events has a lone Close, and reset has a
//!     `.erase-confirm` whose label and disabled state are the arming ceremony.
//!     Two identical call sites is not a pattern.
//!   - The `.cred-field` label/input/hint stack. Three sites that differ in
//!     exactly the parts that matter: naming has a hint, settings has two
//!     fields and its own `mkField` (sheets.ts:1060-1077) local to it, and
//!     reset's label is COMPOSED of spans so the user's name can be `.who` —
//!     user voice inside a framework-voice sentence (sheets.ts:1516-1531).
//!   - The danger entry. One site, on the settings sheet, and framework policy
//!     there for a reason stated at length (sheets.ts:1311-1315).
//!
//! # THE ONE RULE THAT IS NOT ABOUT SHEETS: RENDER BODIES DO NOT WRITE
//!
//! A render body reads through [`crate::component::read_visor`] and writes
//! nothing; handlers, deferred edges and the WIT exports write through
//! `with_visor`. Both halves matter and each was a browser-visible defect
//! before this rule was written down — a subscribing component that also wrote
//! re-rendered itself forever (the settings sheet's hang), and a component that
//! only wrote never subscribed at all, so it rendered once and never saw a
//! later state change (the erase ceremony never drawing itself armed, while the
//! machine armed on time). `with_visor`'s own header carries the full account.
//!
//! The one deliberate exception in this module tree is `events.rs`'s
//! `use_hook(mark_events_seen)`, which is bounded by the `use_hook` and is
//! annotated at its site.

use dioxus::prelude::*;

use crate::component::{apply_effects, embedder, read_visor, store, with_visor};
use crate::drawer::TenantSpec;
use crate::marks::MarkTable;
use crate::state::Context;
use crate::voice::FrameworkText;

pub mod events;
pub mod naming;
pub mod reset;
pub mod settings;

mod export;

// --- what the consumer contributed, and what each ceremony is about ----------

/// ONE CONSUMER-CONTRIBUTED ACTION on the settings sheet (`sheets.action`,
/// wit/world.wit:321-332; `SheetAction`, sheets.ts:498-509).
///
/// THE ONE EXTENSION POINT on a visor-owned sheet, and deliberately narrow: a
/// consumer contributes a LABEL and a key, never a node. The visor draws the
/// button in its own chrome, so a consumer cannot paint on a sheet whose whole
/// claim is that no one but the visor draws there.
///
/// `label` and `hint` are [`FrameworkText`] because the visor speaks them in
/// its own voice. That the words are the CONSUMER'S OWN — never
/// component-influenced — is the consumer's rule to keep and is stated at the
/// option; nothing here can check it, exactly as sheets.ts:499-503 says.
#[derive(Clone, PartialEq, Debug)]
pub struct Action {
    pub label: FrameworkText,
    pub hint: Option<FrameworkText>,
    /// Stable key for `data-action`, and what `embedder.on-action` reports.
    pub key: String,
}

/// The ceremonies' half of the value the renderer watches.
///
/// Everything here either came from `sheets.configure` (set once) or names what
/// an open ceremony is ABOUT. Nothing transient lives here — see the module
/// header, rule 2.
#[derive(Default)]
pub struct SheetsState {
    /// EXTRA LINES IN THE ERASE CEREMONY'S STATEMENT OF CONSEQUENCE: what else
    /// this consumer is about to destroy, which only it knows
    /// (wit/world.wit:336-341). Rendered by the visor in the visor's own
    /// chrome; the words are the consumer's.
    pub reset_consequences: Vec<FrameworkText>,
    /// An empty list renders NOTHING — no heading, no container, no separator
    /// (sheets.ts:490-492).
    pub extra_actions: Vec<Action>,
    /// Which surface the naming ceremony is about, and the first-sight
    /// timestamp read from the trust table when it opened. `None` when the
    /// ceremony is not open.
    pub naming: Option<naming::Subject>,
    /// Which tenant's arming delay has ELAPSED. A guest-rendered sheet draws
    /// its own `.armed`; in TypeScript the drawer host set the class on foreign
    /// DOM it was holding (visor.ts:1462-1470).
    pub armed: Option<String>,
    /// Whether the four tenants have been registered yet — see
    /// [`ensure_registered`].
    registered: bool,
}

// --- the four tenants --------------------------------------------------------

pub const NAMING: &str = "naming";
pub const SETTINGS: &str = "settings";
pub const EVENTS: &str = "events";
pub const RESET: &str = "reset";

/// Is this one of the visor's own guest-rendered ceremonies? The predicate
/// `component::apply_effects` routes on, and the one `app.rs` asks before
/// deciding whether a slide is a leaf.
pub fn is_visor_tenant(name: &str) -> bool {
    matches!(name, NAMING | SETTINGS | EVENTS | RESET)
}

/// The four specs, IN REGISTRATION ORDER — which is PRECEDENCE ORDER
/// (wit/world.wit:447-448, sheets.ts:569-585).
///
/// The order is the argument. Naming, settings and events are the LIGHTWEIGHT
/// class: they take the reveal above the strip (the unforgeable part) but not
/// the arming delay, the runner suspension or the page dim, because nothing
/// secret is typed on any of them, all three open from strip pixels an app can
/// neither draw nor reach, and the worst a mis-tap costs is a sheet the user
/// closes. Paying the arming tax where it buys nothing would train users to
/// click through a delay that means something elsewhere, which is the real
/// cost.
///
/// The event list sits BETWEEN settings and reset (sheets.ts:660-676): it is a
/// lightweight sheet exactly like settings, so it must not outrank anything
/// settings does not, and the erase ceremony must keep sitting behind both.
///
/// RESET IS THE OPPOSITE WEIGHT CLASS and is the case that rationale reserves
/// the delay for (sheets.ts:696-707). A mis-tap here is not a form; it is the
/// user's whole visor-side memory of this device, with no undo. So it pays the
/// full price: `armed` (a baited tap sequence cannot reach a control that does
/// not exist yet), `exclusive` (nothing displaces a destructive ceremony the
/// user is mid-decision on) and `dim` (the page behind it stops competing for
/// the gesture while the user reads a statement of consequence).
///
/// `dim` on the three lightweight tenants is resolved AT OPEN from
/// `embedder.nested-place-active`; see [`open_ceremony`].
fn specs(nested_place: bool) -> [TenantSpec; 4] {
    [
        TenantSpec {
            name: NAMING.into(),
            // The sheet is the naming ceremony GROWN into everything the visor
            // knows about one component, so it is announced by what it IS now,
            // not by the identifier it kept. Framework vocabulary throughout:
            // the component's own nickname is app-influenced and must never
            // reach a flat spoken sentence.
            spoken: "app settings".into(),
            exclusive: false,
            armed: false,
            dim: nested_place,
            suspendable: false,
        },
        TenantSpec {
            name: SETTINGS.into(),
            // "visor settings", not "settings": the app-settings sheet above is
            // also settings, and a listener told only "settings open" cannot
            // tell which of the two arrived.
            spoken: "visor settings".into(),
            exclusive: false,
            armed: false,
            dim: nested_place,
            // CONTRACT / TRANSLATION LOSS, inherited from `drawer.rs:104-108`:
            // `suspendable` is `(session) => boolean` in TypeScript, and
            // sheets.ts:621-635 uses that to scope suspension to EXACTLY the
            // settings->reset and settings->events steps ("one step further
            // into a ceremony you will come back from"). A `bool` here means
            // settings suspends under every displacer, so a naming ceremony
            // opened from the strip over an open settings sheet will slide
            // settings back in when it closes, where TypeScript evicted it. The
            // conservative reading is taken — suspension keeps the user's
            // session rather than destroying it, and the wrong half of this
            // trade is the one that loses work. See the spike report.
            suspendable: true,
        },
        TenantSpec {
            name: EVENTS.into(),
            // The same three words the entry button, the strip's bottom line
            // and the sheet's heading use. One place, one name.
            spoken: "recent events".into(),
            exclusive: false,
            armed: false,
            dim: nested_place,
            // NOT SUSPENDABLE, and the asymmetry with settings is the point of
            // the pair (sheets.ts:667-672): there is no deeper step to take
            // from a list, and anything that displaces it is a separate errand
            // started from elsewhere.
            suspendable: false,
        },
        TenantSpec {
            name: RESET.into(),
            // Named by the ACT, not by the noun: this is the one sheet where a
            // user who mis-navigated needs to know it from the first syllable.
            spoken: "erase this visor".into(),
            exclusive: true,
            armed: true,
            dim: true,
            suspendable: false,
        },
    ]
}

/// Register the four, ONCE, and idempotently.
///
/// WHY THIS IS LAZY AND NOT DONE AT BOOT. Registration order is precedence
/// order, and sheets.ts:569-575 makes that a rule the CONSUMER has to be able
/// to obey: "a consumer with an EXCLUSIVE tenant of its own — the demo's
/// credential sheet — must register that one FIRST, so the sheet that may be
/// holding secrets outranks both of these." Registering at `Visor::boot` would
/// put the four ahead of everything and take that decision away. Doing it on
/// the consumer's first call instead — `sheets.configure`, or whichever
/// `request-*` comes first — leaves the ordering exactly where TypeScript left
/// it: whoever called first is ahead.
///
/// `DrawerState::register` is itself idempotent (it updates a spec in place
/// rather than appending a second entry), so this is belt and braces; the flag
/// is what keeps the four from being re-ordered relative to each other by a
/// re-registration, and what makes the dim re-resolution below a spec UPDATE
/// rather than a first registration.
pub fn ensure_registered() {
    with_visor(|v| {
        if v.sheets.registered {
            return;
        }
        v.sheets.registered = true;
        for spec in specs(false) {
            v.drawer.register(spec);
        }
    });
}

// --- the bracket every ceremony puts around a consumer's nested place --------

/// Is the consumer showing a nested place with a live component surface on it
/// (`nestedPlace.active`, sheets.ts:422-443)?
fn over_nested_place() -> bool {
    embedder::nested_place_active()
}

/// FREEZE, on the way in. Conditional, because a ceremony at HOME dims nothing
/// and freezes nothing: naming a component is not secret entry, and a tax paid
/// where nothing is spent teaches users to click through delays that mean
/// something elsewhere.
pub(crate) fn freeze_place() {
    if over_nested_place() {
        embedder::nested_place_freeze();
    }
}

/// THAW, on the way out — UNCONDITIONAL, and idempotent on the consumer's side
/// (sheets.ts:597-602). The place may have been LEFT while the ceremony was up
/// (the demo's chevron walks the page out from under an open naming sheet —
/// sheets are orthogonal to navigation), so "are we still over it?" is the
/// wrong question to ask when undoing.
pub(crate) fn thaw_place() {
    embedder::nested_place_thaw();
}

// --- opening and closing -----------------------------------------------------

/// WHO IS ASKING. It decides whether the consumer's preconditions run, and the
/// distinction is sheets.ts:1826-1843's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Entry {
    /// From OUTSIDE — the strip's own pixels, or a consumer's driving hook.
    /// `can-open` then `before-open`, in that order: the refusal first, so a
    /// click while an exclusive sheet is up is a pure no-op, and only then
    /// whatever the consumer must do to get the page back.
    FromOutside,
    /// From the settings sheet, which paid both a moment ago. Re-running
    /// `before-open` would ask the consumer to retire a page it has already
    /// retired, and re-running `can-open` would ask about a precondition that
    /// has not changed. The refusal that still applies is the drawer host's own
    /// — an exclusive tenant that claimed the drawer in between refuses this
    /// open outright, and nothing happens.
    FromSettings,
}

/// Open one ceremony. Returns whether the drawer took it.
///
/// THE DIM PREDICATE IS RESOLVED HERE, and this is the port of what
/// `drawer.rs:96-103` records as lost. `TenantSpec.dim` is a `bool` fixed at
/// registration, but sheets.ts's three lightweight tenants pass `dim:
/// overNestedPlace` — a PREDICATE, evaluated per open, because whether a
/// ceremony dims depends on what the consumer has on screen and not on which
/// ceremony it is. Re-registering the spec with the live value immediately
/// before the open restores exactly that: `register` updates in place and
/// keeps the tenant's position, so precedence is untouched, and the drawer
/// machine's own rule — resolve once at open, undo the REMEMBERED value —
/// then does the rest.
pub fn open_ceremony(tenant: &str, ctx: Context, entry: Entry) -> bool {
    ensure_registered();
    if entry == Entry::FromOutside {
        if !embedder::can_open() {
            return false;
        }
        embedder::before_open();
    }
    let nested = over_nested_place();
    with_visor(|v| {
        for spec in specs(nested) {
            if spec.name == tenant {
                v.drawer.register(spec);
            }
        }
    });
    let Some((ok, effects)) = with_visor(|v| {
        let budget = v.budget();
        let prefix = v.word_prefix().to_string();
        v.drawer.open(tenant, ctx, &prefix, budget)
    }) else {
        return false;
    };
    apply_effects(effects);
    ok
}

/// Close one ceremony. `restore_context` is the old option bag's `context`
/// (wit/world.wit:353-358).
pub fn close_ceremony(tenant: &str, restore_context: bool) {
    let reason = crate::drawer::CloseReason { restore_context };
    let Some(effects) = with_visor(|v| {
        let prefix = v.word_prefix().to_string();
        v.drawer.close(tenant, reason, &prefix)
    }) else {
        return;
    };
    apply_effects(effects);
}

/// Is this ceremony the one currently holding the drawer? The port of
/// sheets.ts's `tenant.owns(session)` guard, which every handler on every sheet
/// is wrapped in.
///
/// In TypeScript the sheet's DOM could outlive its session, so the identity
/// comparison was load-bearing. Here it is nearly free: a sheet is keyed by
/// presentation, so a stale one is UNMOUNTED rather than merely stale, and its
/// handlers cannot run. Kept anyway, as sheets.ts:1577-1582 keeps the reset
/// sheet's own `armed` flag — "the second refusal for anything that got past
/// the first" — because the cost is a comparison and the thing being guarded is
/// a write to the trust table.
pub fn owns(tenant: &str) -> bool {
    with_visor(|v| v.drawer.is_open(tenant) && !v.drawer.is_suspended(tenant)).unwrap_or(false)
}

// --- the trust table, loaded and saved afresh every time ---------------------
//
// wit/world.wit:254-257. There is no cached table anywhere in this crate and
// there must not be one: two facades over one key are the same TABLE only for
// as long as neither of them remembers anything.

pub(crate) fn load_marks() -> MarkTable {
    MarkTable::parse(store::get(store::Slot::Marks).as_deref())
}

pub(crate) fn save_marks(table: &MarkTable) {
    store::set(store::Slot::Marks, &table.to_json());
}

// --- the shared chrome -------------------------------------------------------

/// EVERY SHEET'S ROOT, and the only thing the four have in common that is worth
/// a component.
///
/// The markup is four attributes. What earns it its place is the `onmounted`:
/// a guest-rendered sheet has to report its own height, because the round trip
/// that used to do it (`tenant-build` out, `mount-sheet` back) is gone for
/// these tenants — see the module header. The measurement is the strip's own
/// pattern (`app.rs`'s `#visor-strip`): the ElementId arrives through
/// `component::dispatching_target`, which is the only place a guest is ever
/// told one, and `dom.get-client-rect` turns it into the natural height
/// `DrawerState::mount_sheet` clamps against the budget.
///
/// `armed` is the visible half of the arming delay, and the honesty rule around
/// it is sheets.ts:1459-1463's: the three lightweight sheets ship `.armed`
/// because there is no delay to wait for and a button row drawn dimmed for a
/// wait that does not exist is a lie in the other direction; the erase ceremony
/// ships WITHOUT it and gains it when `embedder.tenant-armed` fires.
#[component]
pub fn SheetRoot(
    /// The tenant this sheet belongs to — the name `mount-sheet` is keyed by.
    tenant: String,
    /// The sheet's own class, e.g. `name-sheet`. `.cred-sheet` IS SHARED
    /// VOCABULARY and not one sheet's name (visor.css:650), so it is always
    /// first and always here.
    class: &'static str,
    children: Element,
) -> Element {
    // `read_visor`, NOT `with_visor` — this is a render body. The read also
    // SUBSCRIBES this component, which is the half that was missing: the arming
    // delay fired on time and set `SheetsState::armed`, and nothing redrew.
    let armed = read_visor(|v| {
        // A tenant with no arming delay is armed from the first frame; one that
        // has a delay is armed only once `embedder.tenant-armed` has fired.
        // Asking the SPEC rather than hardcoding the three lightweight names
        // keeps this true if a weight class ever changes.
        !v.drawer.arms(&tenant) || v.sheets.armed.as_deref() == Some(tenant.as_str())
    })
    .unwrap_or(true);
    let mounted = tenant.clone();
    rsx! {
        div {
            class: if armed { format!("cred-sheet {class} armed") } else { format!("cred-sheet {class}") },
            // rem, not px: it aligns with the page's `--content-max` column,
            // and the `.cred-sheet` rule's own 34em max-width is what actually
            // caps the text measure (visor.css:713).
            style: "max-width: 72rem; margin-left: auto; margin-right: auto;",
            onmounted: move |_| {
                let id = crate::component::dispatching_target();
                let Some(rect) = crate::component::client_rect(id) else { return };
                let Some(effects) = with_visor(|v| {
                    let budget = v.budget();
                    v.drawer.mount_sheet(&mounted, rect.height, budget)
                }) else {
                    return;
                };
                apply_effects(effects);
            },
            {children}
        }
    }
}

/// THE SHEET LIVING IN ONE SLIDE. `app.rs` renders this inside a slide whose
/// tenant [`is_visor_tenant`] recognises, and a bare leaf otherwise.
///
/// Nothing is rendered for a tenant whose subject has gone (a naming ceremony
/// whose surface was cleared by a close that raced the render): an empty sheet
/// is a slide with no height, which the drawer already handles, and inventing a
/// placeholder would put the visor's chrome around nothing.
#[component]
pub fn Sheet(tenant: String) -> Element {
    match tenant.as_str() {
        NAMING => rsx! { naming::NamingSheet {} },
        SETTINGS => rsx! { settings::SettingsSheet {} },
        EVENTS => rsx! { events::EventsSheet {} },
        RESET => rsx! { reset::ResetSheet {} },
        _ => rsx! {},
    }
}
