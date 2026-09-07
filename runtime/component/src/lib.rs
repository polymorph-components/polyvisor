//! polyvisor `runtime` component: the kernel in the device's SharedWorker.
//!
//! This crate is the adapter and nothing else — it turns the generated
//! bindings for `world runtime` into the `Platform`/`Fetch`/`Rng` seams
//! `polyvisor-kernel` is written against, and forwards each exported call.
//! Everything worth testing is in the kernel, which is why the whole
//! component is behind the wasm cfg: a host `cargo test`/`cargo clippy` does
//! not need the component-model target.

#[cfg(target_arch = "wasm32")]
mod component;
#[cfg(target_arch = "wasm32")]
mod net;
// The one exception to "everything worth testing is in the kernel": the
// endpoint id's text spelling has to be iroh's, byte for byte, and that is
// a pure function with an answer a test can pin. It sits here rather than
// in the kernel because the bytes it encodes never reach the kernel — the
// kernel is handed the text.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod z32;
