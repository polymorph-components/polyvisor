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
