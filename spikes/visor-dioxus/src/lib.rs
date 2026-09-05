//! visor-spike — the visor's STRIP and DRAWER HOST as a wasm component.
//!
//! The question (wit/world.wit:3-7): can the framework's trusted UI be a
//! component rendering through `polymorph:dioxus`, instead of ~6.5k lines of
//! TypeScript running as the page's own script? Scope is the strip and the
//! drawer host only; sheets, pairing and entry stay in TypeScript and arrive as
//! foreign DOM.
//!
//! # Layout
//!
//! - [`voice`] — the three voices, enforced by construction rather than by a
//!   grep. Read its header first: it is the answer to one of the two questions
//!   the spike exists to ask.
//! - [`state`] — the surface, the context, the identity record, the event
//!   record, the standing conditions. Pure, and tested natively.
//! - [`drawer`] — the tenancy state machine: precedence, eviction,
//!   suspend/resume, the height budget. Pure, and tested natively.
//! - `component` (wasm32 only) — the WIT bindings, the `control` export, and
//!   the `Visor` that ties the pure halves to the signal the renderer watches.
//! - [`marks`] — the trust table: the pet icon, the first-sight timestamp and
//!   the user's own word for one component. Pure, and tested natively.
//! - `sheets` (wasm32 only) — the visor's OWN four ceremonies, rendered by the
//!   guest now rather than mounted as foreign DOM. Read its header before
//!   adding one: it states the pattern all four follow.
//! - `app` (wasm32 only) — the Dioxus tree: the whole of the visor's pixels,
//!   including the `.visor-slide` a visor ceremony grows inside and a
//!   consumer's foreign sheet is appended into.
//!
//! The wasm32 gate is the same one `polyengine_dioxus` uses and for the same
//! reason: those two modules name the generated bindings, and the pure ones do
//! not, so `cargo test` can exercise the state machines on the host.
//!
//! # The clock
//!
//! Every `setTimeout` in `visor/ui/visor.ts` is present, on a real clock:
//! `dioxus-sdk-time`'s `wasip3` feature waits on
//! `wasi:clocks/monotonic-clock` rather than reaching `setTimeout` through
//! wasm-bindgen, which is what makes a timer expressible inside a component.
//! The patch and the pin are the sibling renderer's, verbatim; see
//! `Cargo.toml`, and `component::later` for the one call site.
//!
//! The timed behaviours and where each lives:
//!
//! | visor.ts | here |
//! |---|---|
//! | `ARM_MS = 700`, the arming delay (:637, :2361-2369) | `drawer::ARM_MS`, per presentation, edge at `DrawerState::arm_elapsed` |
//! | the deferred blank (:2487-2495) | `drawer::ARM_MS`, edge at `DrawerState::collapse_settled`, gated on occupancy |
//! | `SWAP_MS = 420`, the travel (:2203, :2303-2307) | `drawer::SWAP_MS`, edge at `DrawerState::swap_settled` |
//! | `announce`'s dwell (:1928-1936) | `component::ANNOUNCE_MS`, guarded by `Visor::announce_token` |
//! | the pulse's forced reflow (:1904-1911) | `component::PULSE_RESTART_MS` |
//!
//! ONE THING IS DELIBERATELY NOT RESTORED: `speak`'s FIFO queue and its
//! `SPEAK_DWELL_MS` (:1782-1843). `#visor-live` carries `aria-atomic="true"`,
//! so joining the sentences emitted in one activation into a single write
//! delivers all of them — which is the entire property the queue existed to
//! guarantee, with no dwell to tune and no burst cap to overflow. See
//! `Visor::speak`.
//!
//! The timer EDGES are pure and live in [`drawer`], so `cargo test` checks the
//! rules a delay obeys — still the same presentation? still unoccupied? — with
//! no clock underneath them. Only the durations need a browser.

pub mod drawer;
pub mod marks;
pub mod state;
pub mod voice;

// Reachable only from `component`, which is wasm32-only — but exercised by
// `cargo test` on the host, which is where the word roll's "a re-roll is a
// DIFFERENT word" contract is actually cheap to check. `pub(crate)` and not
// `pub`: the anchor word's vocabulary must not become part of this crate's
// surface, for the same structural reason `control` has no word getter.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod rng;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod words;

#[cfg(target_arch = "wasm32")]
pub mod app;
#[cfg(target_arch = "wasm32")]
mod component;
#[cfg(target_arch = "wasm32")]
pub mod sheets;
