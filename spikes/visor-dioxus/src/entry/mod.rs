//! THE ENTRY CEREMONIES: how a browser becomes a device with an account
//! (`visor/ui/entry.ts`).
//!
//! Two surfaces, and between them they are the whole of the way in — see
//! entry.ts:1-63's header, which states the argument for putting them in
//! visor territory at all (identity/account/ceremony UI appears ONLY in the
//! visor, and the drawer's dim + pinned-strip geometry is a real
//! anti-spoofing property a component frame cannot reproduce):
//!
//!   - [`PICKER`] (`mountDevicePicker`, entry.ts:184-497) — which of this
//!     browser's devices this tab is looking at. THE ONE SHEET THAT OPENS
//!     BEFORE THE VISOR IS CLAIMED, so it renders on the unclaimed grey dress
//!     with index content only. `picker.rs`.
//!   - [`FIRST_RUN`] (`offerFirstRun`, entry.ts:529-705) — no account on this
//!     device yet: start a new one, or recover an existing one. `fork.rs`.
//!
//! # THE PATTERN THIS FOLLOWS
//!
//! `crate::sheets`'s module header, in full, exactly as `crate::pairing`
//! inherits it: no-prop `#[component]`s keyed by presentation, transient
//! state in `use_signal`/`use_hook`, `crate::sheets::SheetRoot` as the root,
//! render bodies reading through `read_visor` (or, here, a `GlobalSignal` —
//! see `picker.rs`'s header for why) and writing nothing.
//!
//! # WHERE THIS DIFFERS FROM THE FOUR SHEETS AND FROM PAIRING
//!
//! Both differences trace to the SAME cause: this dispatch's territory is
//! `src/entry/**` only, and `sheets/mod.rs`, `state.rs`, `component.rs` and
//! `lib.rs` are named off-limits.
//!
//!   - **The subject lives in a `GlobalSignal`, not on `SheetsState`.** The
//!     natural home for "what a ceremony is about, arriving from outside" is
//!     a field on `crate::sheets::SheetsState` — `naming.rs`'s `Subject` is
//!     the worked example — but that file cannot be extended here. See
//!     `picker.rs`'s header for the substitute and why it obeys the same
//!     read/write discipline.
//!   - **The pure logic does not run under `cargo test`.** `crate::pairing`
//!     escapes `lib.rs`'s wasm32 gate by having `state.rs` declare its pure
//!     files with `#[path]`; that fix lives in a file this dispatch may not
//!     touch. See `pure.rs`'s header for the full account. `src/entry/pure.rs`
//!     is written and organised exactly as if it could be ungated tomorrow —
//!     one file, no bindings, no DOM — so that the same one-line fix
//!     `crate::pairing`'s header names would light it up unchanged.

#[cfg(target_arch = "wasm32")]
use crate::component::exports::polymorph::visor_spike::entry::Guest as EntryGuest;
#[cfg(target_arch = "wasm32")]
use crate::component::polymorph::visor_spike::entry_host::PickerRow;
#[cfg(target_arch = "wasm32")]
use crate::component::{read_visor, with_visor, VisorComponent};
#[cfg(target_arch = "wasm32")]
use crate::drawer::TenantSpec;
#[cfg(target_arch = "wasm32")]
use crate::state::Context;

#[cfg(target_arch = "wasm32")]
pub mod export;
#[cfg(target_arch = "wasm32")]
mod fork;
#[cfg(target_arch = "wasm32")]
mod picker;
/// The entry ceremonies' pure half: row ordering, the last-used wording and
/// refusal classification name no binding and no DOM node, so they compile and
/// RUN on the host and their tests are real `cargo test` tests.
pub mod pure;

/// The device picker: which of this browser's devices this tab is opening.
/// THE ONE TENANT THAT MAY BE OPEN BEFORE THE VISOR IS CLAIMED.
pub const PICKER: &str = "device-picker";
/// The first-run fork: no account on this device yet.
pub const FIRST_RUN: &str = "first-run";

/// Is this one of the two entry tenants? The predicate `crate::sheets`'s
/// router and `is_visor_tenant` both consult, on the same terms as
/// `crate::pairing::is_pairing_tenant`.
pub fn is_entry_tenant(name: &str) -> bool {
    matches!(name, PICKER | FIRST_RUN)
}

/// THE TWO SPECS (entry.ts:190-219, :535-563).
///
/// BOTH `armed: false` — A RULING, and entry.ts:200-215 states it for the
/// picker at length: the arming delay defends secret entry against a BAITED
/// MIS-TAP, which needs a live app rectangle on the page to train the tap
/// in. Pre-unseal there is no component frame instantiated at all — no
/// engine, no app, nothing — so the tax would defend nothing and would only
/// teach users to sit through a delay that means something elsewhere. What
/// still holds is the geometry: the passphrase is typed in visor pixels, in
/// a sheet attached to the pinned strip, over a dimmed page. Nothing on the
/// fork is secret either (entry.ts:556-559), for the ordinary reason
/// `crate::sheets::specs` gives its three lightweight tenants.
///
/// BOTH `dim: true`, UNCONDITIONALLY rather than resolved from
/// `nested-place-active` as the four visor sheets are: there is no consumer
/// page with a "nested place" to bracket at the moment either of these can
/// be open — the picker predates the claim entirely, and the fork's device
/// holds no component surface yet.
///
/// PICKER IS `exclusive`; FORK IS NOT AND IS `suspendable`. entry.ts:196-199
/// and :540-563 both state the reasoning directly: the picker is the whole
/// login, nothing may displace it (though nothing else can exist to try);
/// the fork is a RESTING STATE the user may legitimately step away from
/// (most obviously to the settings sheet, to set their own name before the
/// account it will be stamped on exists) and must come back to, not be
/// destroyed by a detour.
#[cfg(target_arch = "wasm32")]
fn specs() -> [TenantSpec; 2] {
    [
        TenantSpec {
            name: PICKER.into(),
            spoken: "device picker".into(),
            exclusive: true,
            armed: false,
            dim: true,
            suspendable: false,
        },
        TenantSpec {
            name: FIRST_RUN.into(),
            spoken: "getting started".into(),
            exclusive: false,
            armed: false,
            dim: true,
            suspendable: true,
        },
    ]
}

/// Register the two, ONCE and idempotently — `crate::sheets::ensure_registered`'s
/// and `crate::pairing::ensure_registered`'s reason, verbatim: registration
/// order is precedence order, and a consumer with its own exclusive tenant
/// must be able to register it first. `DrawerState::register` updates a spec
/// in place rather than appending, so calling this twice cannot reorder or
/// duplicate the pair.
#[cfg(target_arch = "wasm32")]
fn ensure_registered() {
    with_visor(|v| {
        for spec in specs() {
            v.drawer.register(spec);
        }
    });
}

/// Which strip context a tenant maps to (`types.context`,
/// wit/world.wit:184-196's `device-picker`/`first-run` cases) — a straight
/// mapping, `crate::pairing::context_for`'s twin.
#[cfg(target_arch = "wasm32")]
fn context_for(tenant: &str) -> Context {
    if tenant == FIRST_RUN {
        Context::FirstRun
    } else {
        Context::DevicePicker
    }
}

/// Open one entry ceremony. Returns whether the drawer took it.
///
/// `Entry::FromOutside` always: both ceremonies are entered from the
/// consumer's own call (`entry.mount-device-picker` /
/// `entry.offer-first-run`), never from another sheet the way the settings
/// sheet reaches the four visor ceremonies — so the consumer's `can-open`
/// refusal and `before-open` always run, and the refusal comes first so a
/// call arriving while an exclusive sheet is up is a pure no-op.
#[cfg(target_arch = "wasm32")]
fn open(tenant: &str) -> bool {
    ensure_registered();
    crate::sheets::open_ceremony(tenant, context_for(tenant), crate::sheets::Entry::FromOutside)
}

/// Close one entry ceremony.
#[cfg(target_arch = "wasm32")]
pub(crate) fn close(tenant: &str, restore_context: bool) {
    crate::sheets::close_ceremony(tenant, restore_context);
}

/// Is this ceremony the one holding the drawer? `crate::sheets::owns`, which
/// every handler in `picker.rs`/`fork.rs` is guarded on, for the reason
/// stated there and at `crate::pairing::owns`.
#[cfg(target_arch = "wasm32")]
pub(crate) fn owns(tenant: &str) -> bool {
    crate::sheets::owns(tenant)
}

#[cfg(target_arch = "wasm32")]
impl EntryGuest for VisorComponent {
    /// Mount the picker with this browser's on-device index, opened
    /// immediately (entry.ts:184-219). `problem` pre-reveals a refusal line —
    /// the auto-unseal failure path, where a single kept device was opened
    /// with no sheet at all, so when that attempt fails there is no surface
    /// for the refusal to land on until this call.
    ///
    /// THE SUBJECT IS SET BEFORE THE CEREMONY OPENS. `picker::mount` writes
    /// the rows and the problem line to `picker::SUBJECT`; only then does
    /// `open` present the slide, so by the time `PickerSheet`'s render body
    /// runs — on this same synchronous call stack's continuation, once
    /// Dioxus flushes — the value is already there to read. Reversing the
    /// order would let the sheet's first render see the tenant open but no
    /// subject to draw, which `PickerSheet` treats as "render nothing" (an
    /// empty sheet the drawer would size at zero).
    fn mount_device_picker(rows: Vec<PickerRow>, problem: Option<String>) {
        picker::mount(rows, problem);
        open(PICKER);
    }

    /// Offer the fork, opened immediately (entry.ts:529-563).
    fn offer_first_run() {
        open(FIRST_RUN);
    }

    fn picker_open() -> bool {
        read_visor(|v| v.drawer.is_open(PICKER)).unwrap_or(false)
    }

    fn first_run_open() -> bool {
        read_visor(|v| v.drawer.is_open(FIRST_RUN)).unwrap_or(false)
    }
}
