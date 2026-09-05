//! THE DEVICE SEAL AS A COMPONENT — the Rust half of
//! `polyvisor:device-seal@0.1.0` (wit/world.wit).
//!
//! seal.ts's KEK ladder and DEK, sealed-fs.ts's per-file format, and
//! identity-keys.ts's signing handles, moved behind a component boundary.
//! What the boundary buys is that THE UNSEALED DEK EXISTS NOWHERE IN
//! JAVASCRIPT: the worker holds a component and asks it to seal and open
//! bytes, with no handle to export. The parked DEK lives in
//! [`state`]'s thread-local and dies with the instance, exactly as
//! dropping the `CryptoKey` handle re-sealed the device before.
//!
//! MODULE SPLIT, and the reason for it. `records` and `file_format` are
//! PURE: plain data in, refusals out, no `bindings` in sight, compiled
//! and tested natively by `cargo test`. That is where "absent origin
//! means generated", "a 31-byte PRF salt is tampering", and the PMSEALv1
//! layout live, and it is the WIT's claim that those rules become
//! `cargo test` rather than a browser matrix (world.wit:23-26) being
//! made good. Everything that touches the platform is `wasm32`-only.

pub mod file_format;
pub mod records;

// BINDINGS REUSE. `polymorph-webcrypto-guest` already binds the whole
// `polymorph:webcrypto` surface, and our world NAMES its types —
// `kw-key` crosses `namespace` and `seal`, `signing-key`/`verifying-key`
// cross `namespace` and `identity`. Every `polymorph:webcrypto`
// interface in this world's transitive resolution must therefore be
// remapped onto that crate's `bindings::*`; binding one a second time
// here would yield a nominally different resource type that no wrapper
// accepts (the crate says so at rust/guest/src/lib.rs:14-20, and
// engine/guest/src/lib.rs:18-36 is this repo's precedent).
//
// The list is the closure of the world's thirteen webcrypto imports over
// their `use` statements: `types` and `wrapping` under everything;
// `derivation` under the KDFs; `digest` under `sha2`; `aes` for
// `aes-variant`; `aead`/`key-wrap`/`signature` for the resources their
// algorithm interfaces mint.
//
// `wasi:random/random` is deliberately NOT remapped: it is ours to bind,
// and it is the platform CSPRNG every salt, IV and nonce here comes from.
#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({
    path: "wit",
    world: "device-seal",
    generate_all,
    with: {
        "polymorph:webcrypto/types@0.1.0": polymorph_webcrypto_guest::bindings::types,
        "polymorph:webcrypto/wrapping@0.1.0": polymorph_webcrypto_guest::bindings::wrapping,
        "polymorph:webcrypto/derivation@0.1.0": polymorph_webcrypto_guest::bindings::derivation,
        "polymorph:webcrypto/digest@0.1.0": polymorph_webcrypto_guest::bindings::digest,
        "polymorph:webcrypto/sha2@0.1.0": polymorph_webcrypto_guest::bindings::sha2,
        "polymorph:webcrypto/pbkdf2@0.1.0": polymorph_webcrypto_guest::bindings::pbkdf2,
        "polymorph:webcrypto/pbkdf2-sha2@0.1.0": polymorph_webcrypto_guest::bindings::pbkdf2_sha2,
        "polymorph:webcrypto/hkdf@0.1.0": polymorph_webcrypto_guest::bindings::hkdf,
        "polymorph:webcrypto/hkdf-sha2@0.1.0": polymorph_webcrypto_guest::bindings::hkdf_sha2,
        "polymorph:webcrypto/key-wrap@0.1.0": polymorph_webcrypto_guest::bindings::key_wrap,
        "polymorph:webcrypto/aes@0.1.0": polymorph_webcrypto_guest::bindings::aes,
        "polymorph:webcrypto/aes-kw@0.1.0": polymorph_webcrypto_guest::bindings::aes_kw,
        "polymorph:webcrypto/aead@0.1.0": polymorph_webcrypto_guest::bindings::aead,
        "polymorph:webcrypto/aes-gcm@0.1.0": polymorph_webcrypto_guest::bindings::aes_gcm,
        "polymorph:webcrypto/signature@0.1.0": polymorph_webcrypto_guest::bindings::signature,
        "polymorph:webcrypto/ed25519-sign@0.1.0": polymorph_webcrypto_guest::bindings::ed25519_sign,
        "polymorph:webcrypto/ed25519-verify@0.1.0": polymorph_webcrypto_guest::bindings::ed25519_verify,
    },
});

#[cfg(target_arch = "wasm32")]
mod component;
#[cfg(target_arch = "wasm32")]
mod identity;
#[cfg(target_arch = "wasm32")]
mod ladder;
#[cfg(target_arch = "wasm32")]
mod state;
