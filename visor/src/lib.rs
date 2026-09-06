//! polyvisor `visor` component: the trusted pixels, on the main thread.
//!
//! A `polymorph:stream-dom` producer rendering the strip (the trust anchor)
//! and the drawer into its mount root, driving the kernel through the
//! `device`/`apps`/`events` imports and the page through `shell`.
//!
//! Split for the same reason as the runtime component: everything with a
//! testable answer — the voices, the drawer state machine, the stylesheet —
//! is plain Rust and runs under a host `cargo test`, while the bindings and
//! the UI that calls them are behind the wasm cfg.

// Off the component target these modules' only consumers are their own
// tests — the UI that uses them in earnest is wasm-only — so dead-code
// analysis has nothing to see there.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod state;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod style;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod voice;

#[cfg(target_arch = "wasm32")]
mod component;
#[cfg(target_arch = "wasm32")]
mod kernel;
#[cfg(target_arch = "wasm32")]
mod ui;
