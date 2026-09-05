//! THE KEK LADDER AND THE DEK — seal.ts's ceremonies over the platform's
//! WebCrypto, reached through `polymorph:webcrypto`.
//!
//! Two rules govern every function here and are worth restating because
//! they are the ones a port gets wrong (world.wit:218-226):
//!
//! - THE DEK IS BORN EXTRACTABLE AND PARKED NON-EXTRACTABLE. `wrap` needs
//!   a key whose material can be serialized, so the mint and every
//!   re-wrap hold a wrappable DEK for the length of the ceremony and no
//!   longer. [`wrappable_dek`] and [`wrappable_dek_from_platform`] are
//!   the only two places one exists, and neither result is ever parked.
//! - THE SINGLE WRITE LANDS AFTER EVERY FALLIBLE STEP. A ceremony that
//!   fails part-way leaves the namespace exactly as it was.
//!
//! ERROR MAPPING, stated once. An AES-KW unwrap that fails under a
//! passphrase KEK is `wrong-passphrase`; under a PRF KEK it is
//! `wrong-passkey`; under the platform KEK it is `tampered` — three
//! different facts about one indistinguishable event, told apart by which
//! door was tried, never by anything the platform reported. A record that
//! fails shape validation is `tampered`. Everything else the platform
//! declines is `unsupported`, carrying the platform's own sentence and
//! never key material.
//!
//! EVERY REFUSAL CARRIES ITS SENTENCE, built by a named constructor on
//! [`Refusal`] (`records.rs`) that cites the seal.ts line it is ported
//! from. The visor renders these, so the site that knows which refusal
//! this is is the site that states it.

use polymorph_webcrypto_guest::aes_gcm::AesVariant;
use polymorph_webcrypto_guest::{
    aes_gcm, aes_kw, pbkdf2, pbkdf2_sha2, Aead, AeadKeyOptions, DeriveOptions, Error, KwKey,
    KwKeyOptions,
};

use crate::polyvisor::device_seal::namespace;
use crate::polyvisor::device_seal::types::PassphraseOrigin;
use crate::records::{self, Refusal, PBKDF2_ITERATIONS, SALT_BYTES};

pub type Res<T> = Result<T, Refusal>;

/// The platform declined an operation. Carries its sentence; the wrapper
/// crate's `Display` never renders key material.
pub fn platform(err: Error) -> Refusal {
    Refusal::platform(err.to_string())
}

/// `len` bytes from the PLATFORM'S CSPRNG (world.wit:330-332). Never an
/// in-guest generator: every salt, IV and nonce this component writes
/// comes through here.
pub fn random(len: usize) -> Vec<u8> {
    crate::wasi::random::random::get_random_bytes(len as u64)
}

// --- the ladder's two primitives --------------------------------------------

/// AES-KW, not AES-GCM, for both wraps (seal.ts:233-243). It is
/// deterministic, so a wrap needs no IV beside it and no IV-reuse hazard
/// exists across re-wraps of one key; and RFC 3394's integrity check
/// value is what turns a wrong passphrase into a CLEAN REFUSAL — the
/// unwrap fails inside the platform and no partial key ever exists.
///
/// The KEK is non-extractable and may only wrap and unwrap: it exists to
/// hold the DEK and cannot encrypt data.
pub async fn kek_from_passphrase(passphrase: &str, salt: &[u8], iterations: u32) -> Res<KwKey> {
    let password = pbkdf2::import_password(
        passphrase.as_bytes().to_vec(),
        DeriveOptions {
            // The derivation mints a key and never yields raw bits.
            derive_bits: false,
            derive_key: true,
        },
    )
    .await
    .map_err(platform)?;
    let input = pbkdf2_sha2::prepare(
        polymorph_webcrypto_guest::sha2::Sha2Variant::Sha256,
        &password,
        salt.to_vec(),
        iterations,
    )
    .await
    .map_err(platform)?;
    aes_kw::derive_key(
        AesVariant::Aes256,
        &input,
        KwKeyOptions {
            wrap: true,
            unwrap: true,
            extractable: false,
        },
    )
    .await
    .map_err(platform)
}

/// Serialize the DEK's material and encrypt it under `kek` (seal.ts
/// `wrapDek`). Only ever called with a wrappable DEK.
pub async fn wrap_dek(dek: &Aead, kek: &KwKey) -> Res<Vec<u8>> {
    let input = dek.to_wrap_input_raw().await.map_err(platform)?;
    kek.wrap(input).await.map_err(platform)
}

/// Recover the DEK from `wrapped` (seal.ts `unwrapDek`).
///
/// `extractable` is the whole distinction this module turns on: `false`
/// for the handle that gets parked, `true` for a ceremony's local. The
/// usages are the DEK's own — seal and open — and never wrap: nothing
/// wraps *under* the DEK.
///
/// Returns the platform's error unmapped, because WHICH refusal a failed
/// unwrap is depends on which door was tried, and only the caller knows.
pub async fn unwrap_dek(
    wrapped: &[u8],
    kek: &KwKey,
    extractable: bool,
) -> Result<Aead, Error> {
    let input = kek.unwrap(wrapped.to_vec()).await?;
    aes_gcm::unwrap_key_raw(
        AesVariant::Aes256,
        input,
        AeadKeyOptions {
            seal: true,
            open: true,
            wrap: false,
            unwrap: false,
            extractable,
        },
    )
    .await
}

/// A fresh AES-GCM-256 DEK, born EXTRACTABLE so the mint's own wrap can
/// serialize it (seal.ts:338). The handle that survives the ceremony is
/// the re-unwrapped non-extractable one, never this.
pub async fn generate_dek() -> Res<Aead> {
    aes_gcm::generate_key(
        AesVariant::Aes256,
        AeadKeyOptions {
            seal: true,
            open: true,
            wrap: false,
            unwrap: false,
            extractable: true,
        },
    )
    .await
    .map_err(platform)
}

// --- the wrappable DEK, and only here ---------------------------------------

/// THE ONE PLACE A PASSPHRASE-AUTHORIZED WRAPPABLE DEK EXISTS (seal.ts
/// `wrappableDek`, 288-313). A local of the ceremony that needs it,
/// dropped when the ceremony returns, and never parked.
pub async fn wrappable_dek(passphrase: &str) -> Res<Aead> {
    let rec = namespace::get_passphrase_wrap()
        .await
        .ok_or_else(Refusal::no_passphrase_rung)?;
    records::validate_passphrase_wrap(rec.iterations, &rec.salt, &rec.wrapped)?;
    let kek = kek_from_passphrase(passphrase, &rec.salt, rec.iterations).await?;
    unwrap_dek(&rec.wrapped, &kek, true)
        .await
        .map_err(|_| Refusal::wrong_passphrase())
}

/// The platform rung's [`wrappable_dek`] (seal.ts
/// `wrappableDekFromPlatform`, 505-533). Refuses `no-rung` when EITHER
/// half is missing — unlike `unseal-from-platform`, which reports the
/// same state as a plain `ok(false)`.
pub async fn wrappable_dek_from_platform() -> Res<Aead> {
    let (rec, kek) = platform_rung().await?;
    let (rec, kek) = match (rec, kek) {
        (Some(rec), Some(kek)) => (rec, kek),
        _ => return Err(Refusal::no_platform_rung()),
    };
    unwrap_dek(&rec.wrapped, &kek, true)
        .await
        .map_err(|_| Refusal::platform_wrap_did_not_open())
}

/// Read the platform wrap and its key, VALIDATING BOTH ON LOAD.
///
/// IndexedDB is writable by anything else on this origin, so a stored key
/// is untrusted input on the way back in: a planted EXTRACTABLE key here
/// would be an attacker's handle we then used to unwrap the DEK
/// (seal.ts:546-552). It is refused as `tampered` rather than coerced.
/// A key that cannot unwrap is refused for the same reason — the ceremony
/// would fail at the operation anyway, and a typed refusal beats the
/// platform's prose.
///
/// `Ok((None, _))` or `Ok((_, None))` is "no platform rung", which is the
/// caller's to interpret.
#[allow(clippy::type_complexity)]
async fn platform_rung() -> Res<(Option<namespace::PlatformWrap>, Option<KwKey>)> {
    let rec = namespace::get_platform_wrap().await;
    let kek = namespace::get_platform_kek().await.map(KwKey::from_raw);
    if let Some(rec) = &rec {
        records::validate_platform_wrap(&rec.wrapped)?;
    }
    if let Some(kek) = &kek {
        if kek.extractable() || !kek.can_unwrap() {
            return Err(Refusal::platform_kek_unusable());
        }
    }
    Ok((rec, kek))
}

/// VALIDATE THE CROSSED PRF KEK BEFORE USING IT.
///
/// CONTRACT: seal.ts `requirePrfKek` (588-595) refuses with `tampered`;
/// world.wit:303-304 spells this refusal `unsupported` ("Refuses a `kek`
/// that is extractable or lacks wrap+unwrap as `unsupported`"), and
/// world.wit:65-67 names exactly this case as `unsupported`'s reason for
/// existing ("a KEK handle with the wrong shape"). The WIT is the pinned
/// contract, so `unsupported` it is; the TypeScript's code differs. Its
/// SENTENCE is seal.ts's, unchanged.
///
/// The key arrived over the port from the page, which anything on this
/// origin may hold. An extractable one is not the handle this ceremony
/// was designed around: wrapping the device's DEK under something whose
/// material can be read back would undo the rung. AES-KW is guaranteed by
/// the resource type — a `kw-key` is nothing else.
pub fn require_prf_kek(kek: &KwKey) -> Res<()> {
    if kek.extractable() || !kek.can_wrap() || !kek.can_unwrap() {
        return Err(Refusal::prf_kek_unusable());
    }
    Ok(())
}

// --- record helpers ----------------------------------------------------------

/// A `wrap:passphrase` record for a fresh derivation, with the parameters
/// THIS version writes (seal.ts:340-347).
pub fn passphrase_record(
    salt: Vec<u8>,
    wrapped: Vec<u8>,
    origin: PassphraseOrigin,
) -> namespace::PassphraseWrap {
    namespace::PassphraseWrap {
        iterations: PBKDF2_ITERATIONS,
        salt,
        wrapped,
        origin: Some(origin),
    }
}

/// A fresh 16-byte salt from the platform CSPRNG.
pub fn fresh_salt() -> Vec<u8> {
    random(SALT_BYTES)
}

/// The validated `wrap:prf` reader — the ONE reader both PRF ceremonies
/// go through, so a planted record is refused identically whether the
/// page is about to run an assertion or the worker is about to unwrap
/// (seal.ts `readPrfWrap`, 628-649).
pub async fn read_prf_wrap() -> Res<Option<namespace::PrfWrap>> {
    let Some(rec) = namespace::get_prf_wrap().await else {
        return Ok(None);
    };
    records::validate_prf_wrap(
        &rec.credential_id,
        &rec.rp_id,
        &rec.prf_input,
        &rec.hkdf_salt,
        &rec.wrapped,
    )?;
    Ok(Some(rec))
}
