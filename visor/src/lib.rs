//! polyvisor `visor` component: the trusted pixels, on the main thread.
//!
//! A `polymorph:stream-dom` producer rendering the strip (the trust anchor)
//! and the drawer into its mount root, driving the kernel through the
//! `device`/`apps`/`events` imports and the page through `shell`.
//!
//! Plain state and presentation modules remain available to native tests;
//! bindings and UI imports compile only for the component target.

// Off the component target these modules' only consumers are their own
// tests — the UI that uses them in earnest is wasm-only — so dead-code
// analysis has nothing to see there.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod draft;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) mod glyph;
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
