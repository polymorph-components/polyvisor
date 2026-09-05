//! THE DEVICE'S SIGNING HANDLES — identity-keys.ts, posture `platform`
//! (PERSISTENCE.md, "Sealing": "Device signing identity").
//!
//! Non-extractable Ed25519, minted by the platform, persisted as handles
//! through the namespace's add-if-absent slot, NEVER passphrase-derived:
//! a wrapped seed is offline-guessable at passphrase strength, while a
//! non-extractable handle cannot leave the profile at all.
//!
//! WHO CHECKS WHAT, and why it is split that way.
//!
//! The usability predicate for a stored entry is the HOST'S, in full —
//! identity-keys.ts `usableIdentity`: both halves the right type and
//! algorithm, the private half non-extractable and able to `sign`, the
//! public half able to `verify` (world.wit, `namespace`'s
//! "VALIDATE-ON-LOAD IS THE HOST'S" paragraph). It has to live there
//! because `put-identity`'s add-if-absent transaction applies it to the
//! entry it finds, and a transaction cannot call back into a component.
//! `fromCryptoKey` alone is NOT that predicate: it refuses the wrong
//! type, algorithm and usages, but never looks at `extractable`.
//!
//! We re-check exactly ONE bit of it — [`refuse_extractable`] — on every
//! pair we receive, from either door. It is the bit whose failure is
//! silent and expensive: a codec bug on the host side would hand us a
//! signing key whose material can be read back, and this module would go
//! on using it as though the material had never been readable. Checking
//! it here turns that into a loud `unsupported` at the seam instead of a
//! device identity that is quietly a bearer secret. The rest of the
//! predicate fails visibly on first use and is the host's to own.

use polymorph_webcrypto_guest::{ed25519, SigningKey, SigningKeyOptions, VerifyingKey};

use crate::ladder::{platform, Res};
use crate::polyvisor::device_seal::namespace;
use crate::polyvisor::device_seal::types::IdentitySlot;
use crate::records::Refusal;

/// Mint a fresh device identity. THE PRIVATE HALF IS NON-EXTRACTABLE —
/// this is the only place that decides it (identity-keys.ts:118-127).
async fn mint() -> Res<(SigningKey, VerifyingKey)> {
    ed25519::generate_key(SigningKeyOptions {
        sign: true,
        extractable: false,
    })
    .await
    .map_err(platform)
}

/// Refuse a pair whose signing half can export its material.
///
/// A stored signing key PROMISES material that was never readable; a
/// readable one is a bearer secret wearing a handle's costume, and every
/// later loader — and every signature made under it — would inherit the
/// lie. `unsupported` is the WIT's code for a handle with the wrong shape
/// (world.wit's `namespace` validate-on-load paragraph and
/// `identity.load-or-mint`).
fn refuse_extractable(pair: (SigningKey, VerifyingKey)) -> Res<(SigningKey, VerifyingKey)> {
    if pair.0.extractable() {
        return Err(Refusal::extractable_identity());
    }
    Ok(pair)
}

fn lift(pair: (RawSigning, RawVerifying)) -> Res<(SigningKey, VerifyingKey)> {
    refuse_extractable((SigningKey::from_raw(pair.0), VerifyingKey::from_raw(pair.1)))
}

type RawSigning = polymorph_webcrypto_guest::bindings::signature::SigningKey;
type RawVerifying = polymorph_webcrypto_guest::bindings::signature::VerifyingKey;

/// CREATE-OR-LOAD, RACE-FREE (identity-keys.ts `loadOrMintIdentity`,
/// 199-224).
///
/// THE RETURNED PAIR IS WHAT IS STORED, NOT THE LOCAL MINT. Two workers
/// attaching to one device both want the identity to exist; a
/// read-then-write would mint two keys and let the later write silently
/// replace the identity the earlier one had already begun signing with —
/// signatures under a key nothing can produce again. `put-identity` is
/// ADD-IF-ABSENT and returns what is stored afterwards
/// (world.wit:227-233), so the loser's candidate is simply dropped and
/// both callers agree on one identity. Returning the candidate here
/// instead would reintroduce exactly the bug the slot exists to prevent.
///
/// BOTH DOORS ARE CHECKED. `put-identity` can return the RACE WINNER'S
/// pair rather than ours, so its result is as much someone else's key as
/// `get-identity`'s is — checking only the read path would leave the
/// interesting case unchecked.
pub async fn load_or_mint(slot: IdentitySlot) -> Res<(SigningKey, VerifyingKey)> {
    if let Some(pair) = load(slot).await? {
        return Ok(pair);
    }
    let (signing, verifying) = mint().await?;
    lift(namespace::put_identity(slot, signing.as_raw(), verifying.as_raw()).await)
}

/// The slot's pair if one is stored and usable; `none` otherwise
/// (identity-keys.ts `loadIdentity`). Most of "usable" is the host's
/// judgement; the extractability bit is re-checked here — see the module
/// header.
pub async fn load(slot: IdentitySlot) -> Res<Option<(SigningKey, VerifyingKey)>> {
    match namespace::get_identity(slot).await {
        Some(pair) => lift(pair).map(Some),
        None => Ok(None),
    }
}

/// Forget one identity.
pub async fn delete(slot: IdentitySlot) -> Res<()> {
    namespace::delete_identity(slot).await;
    Ok(())
}
