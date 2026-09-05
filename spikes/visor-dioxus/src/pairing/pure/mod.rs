//! THE PAIRING CEREMONIES' PURE HALF: the two state machines, the QR matrix,
//! and every sentence either ceremony says.
//!
//! # WHY THIS SUBDIRECTORY EXISTS — it is about which gate can see the code
//!
//! `src/lib.rs` gates `pairing` on `target_arch = "wasm32"`, exactly as it
//! gates `sheets` and `component`, because those modules name the generated
//! bindings. So `cargo test` — which runs on the host — cannot reach anything
//! under `src/pairing/`, and the wave's 25 tests were compiled but never RUN.
//!
//! That is not a theoretical cost. One of those tests asserted the wrong bound
//! on the QR's run count and was only found by executing it out-of-tree; the
//! wasm `--all-targets` clippy that "covered" it had typechecked a false
//! assertion and reported success.
//!
//! Nothing in this subdirectory names a binding, a DOM node or a clock. It is
//! the same split `crate::state`, `crate::drawer` and `crate::marks` already
//! make and for the identical stated reason (`lib.rs`'s layout note): the rules
//! a ceremony obeys are checkable with no host underneath them, and only the
//! durations and the pixels need a browser.
//!
//! # HOW IT IS REACHED, and the one ugly line
//!
//! `src/lib.rs` is not this wave's to edit, so these modules cannot be declared
//! there. They are declared instead from `crate::state` — which IS natively
//! compiled — with a `#[path]` pointing here, and re-exported by
//! `crate::pairing` so that every use site reads `crate::pairing::phase::…` as
//! if nothing unusual had happened. See `state.rs`'s declaration, which carries
//! the same note.
//!
//! The declaration's parent being `state` is a wart, and the whole of the fix
//! is one line in `src/lib.rs`:
//!
//! ```text
//!     pub mod pairing;                       // instead of the wasm32 gate,
//!     #[cfg(target_arch = "wasm32")] ...     // with the gate moved onto the
//!                                            // four rendering modules
//! ```
//!
//! Left for whoever owns `lib.rs`; the restructuring here is what makes that
//! one line all it takes.

pub mod phase;
pub mod qr;
pub mod text;
pub mod us;
