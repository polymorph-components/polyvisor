//! The one source of randomness the visor has: the anchor colour's roll and
//! the anchor word's.
//!
//! WHY THIS IS HAND-ROLLED RATHER THAN A CRATE. The guest's world
//! (`wit/world.wit`) imports `store`, `chrome`, `embedder` and the three
//! `polymorph:dioxus` interfaces, and nothing else — there is no entropy
//! interface on it. What is reachable is `std`, whose `RandomState` seeds
//! itself once per thread from `wasi:random/insecure-seed` on this target and
//! then hashes with SipHash-1-3: a 128-bit key an app cannot read, over a
//! counter it cannot observe.
//!
//! THE BAR THIS HAS TO CLEAR, STATED HONESTLY, is not "cryptographic" — and
//! `insecure-seed` is named "insecure" for a reason, so the claim is only what
//! the seam actually supports. The TypeScript original rolls both tokens with
//! `Math.random` (visor.ts:87, words.ts's `rollVisorWord`), and words.ts:52
//! states the threat model outright: the word "is not a secret against an
//! offline search — it defends against an app that must produce the right token
//! BLIND, on the first try, in a sentence the user is listening to." Parity with
//! `Math.random` is therefore the property the port owes, and a keyed hash over
//! a per-instance seed clears it. An implementation that wanted more would ask
//! the world for `wasi:random/random`, which is a WIT change this spike may not
//! make.

use std::hash::{BuildHasher, RandomState};

thread_local! {
    /// Keyed ONCE per instance. Re-creating a `RandomState` per call would
    /// re-derive from std's per-thread seed plus a counter that increments by
    /// one — correlated across calls, which is the failure this holds a single
    /// keyed state to avoid.
    static KEY: RandomState = RandomState::new();
    static COUNTER: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// A uniform-enough index in `0..len`. Panics on an empty range, which is a
/// bug at the call site rather than a state the visor can be in: both pools
/// (ten hues, 1293 words) are compile-time non-empty.
pub(crate) fn below(len: usize) -> usize {
    assert!(len > 0, "rng::below: empty range");
    let n = COUNTER.with(|c| {
        let n = c.get();
        c.set(n.wrapping_add(1));
        n
    });
    // The modulo bias over a u64 against a pool of at most 1293 is ~2^-53 —
    // below the point at which it is a describable property of the roll, let
    // alone an exploitable one.
    (KEY.with(|k| k.hash_one(n)) % (len as u64)) as usize
}
