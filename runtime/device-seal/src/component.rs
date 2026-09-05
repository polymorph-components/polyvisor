//! THE EXPORTS: `seal`, `sealed`, `identity`.
//!
//! Each function is seal.ts's, cited by name, with one change of shape —
//! NO FUNCTION RETURNS A DEK. Where seal.ts handed back a
//! non-extractable `CryptoKey`, these park it (`state`) and the `sealed`
//! interface spends it.

use polymorph_webcrypto_guest::{Aead, KwKey, SigningKey, VerifyingKey};

use crate::exports::polyvisor::device_seal::identity::Guest as IdentityGuest;
use crate::exports::polyvisor::device_seal::seal::Guest as SealGuest;
use crate::exports::polyvisor::device_seal::sealed::Guest as SealedGuest;
use crate::file_format::{self, Framed};
use crate::ladder::{self, Res};
use crate::polyvisor::device_seal::namespace;
use crate::polyvisor::device_seal::types::{
    IdentitySlot, PassphraseOrigin, PrfEnrollment, SealCode, SealError, SealState,
};
use crate::records::{self, Code, Refusal};
use crate::{identity, state};

struct Component;

/// Lower a [`Refusal`] onto the WIT variant. `platform` carries the
/// platform's own sentence and never key material.
fn lower(refusal: Refusal) -> SealError {
    SealError {
        code: match refusal.code {
            Code::WrongPassphrase => SealCode::WrongPassphrase,
            Code::WrongPasskey => SealCode::WrongPasskey,
            Code::NoRung => SealCode::NoRung,
            Code::AlreadySealed => SealCode::AlreadySealed,
            Code::Tampered => SealCode::Tampered,
            Code::Unsupported => SealCode::Unsupported,
        },
        message: refusal.message,
    }
}

fn out<T>(result: Res<T>) -> Result<T, SealError> {
    result.map_err(lower)
}

// --- seal --------------------------------------------------------------------

impl SealGuest for Component {
    /// Which rungs this device HAS, asked without opening anything
    /// (seal.ts `sealState`). Deliberately does no shape validation: the
    /// picker's question is "does a record exist", and a device whose
    /// record is malformed still has the rung, as the ceremony that tries
    /// it will report.
    async fn state() -> SealState {
        let passphrase = namespace::get_passphrase_wrap().await;
        let platform = namespace::get_platform_wrap().await;
        let prf = namespace::get_prf_wrap().await;
        let origin = passphrase
            .as_ref()
            .map(|rec| rec.origin.map(from_wit_origin));
        let (passphrase, user_passphrase, until_reseal, prf) =
            records::seal_state(origin, platform.is_some(), prf.is_some());
        SealState {
            passphrase,
            user_passphrase,
            until_reseal,
            prf,
        }
    }

    fn unsealed() -> bool {
        state::unsealed()
    }

    fn forget() {
        state::forget();
    }

    /// Mint the DEK and seal it under a passphrase (seal.ts
    /// `createSealedDek`).
    ///
    /// REFUSES ON A DEVICE THAT ALREADY HAS A RUNG rather than replacing
    /// it: a second mint would produce a second DEK, and every byte
    /// written under the first would become unreadable with no error
    /// anywhere.
    ///
    /// The order of the two refusals is seal.ts's (332-335):
    /// `already-sealed` is decided BEFORE the passphrase is inspected, so
    /// an empty passphrase offered to a sealed device reports the rung it
    /// hit, not the argument it carried.
    async fn create_sealed_dek(passphrase: String, origin: PassphraseOrigin) -> Result<(), SealError> {
        out(create_sealed_dek(&passphrase, origin).await)
    }

    /// THE LOGIN (seal.ts `unsealWithPassphrase`). Parks the DEK.
    async fn unseal_with_passphrase(passphrase: String) -> Result<(), SealError> {
        out(unseal_with_passphrase(&passphrase).await)
    }

    /// Change the passphrase. THE SALT ROTATES and the DEK does not
    /// (seal.ts `rekeyPassphrase`): rotating the DEK would mean
    /// re-encrypting every sealed byte, and the threat this rung answers
    /// is answered by the new derivation.
    async fn rekey_passphrase(old: String, new: String) -> Result<(), SealError> {
        out(rekey_passphrase(&old, &new).await)
    }

    /// Arm `until-reseal` (seal.ts `enableUntilReseal`). ADDITIVE — the
    /// passphrase rung stays, because it is the only thing that can open
    /// the device after a reseal.
    async fn enable_until_reseal(passphrase: String) -> Result<(), SealError> {
        out(enable_until_reseal(&passphrase).await)
    }

    /// THE PROMOTION SEAM (seal.ts `rekeyFromPlatform`): give a
    /// platform-rung device a passphrase it did not have, authorised by
    /// the platform wrap. Marks the rung `user` — the point of the
    /// ceremony is that what it leaves behind is a door somebody knows.
    async fn rekey_from_platform(new: String) -> Result<(), SealError> {
        out(rekey_from_platform(&new).await)
    }

    /// Open from the platform wrap (seal.ts `unsealFromPlatform`).
    async fn unseal_from_platform() -> Result<bool, SealError> {
        out(unseal_from_platform().await)
    }

    /// The PRF rung's ceremony half, for the page's assertion (seal.ts
    /// `getPrfEnrollment`). THE WRAPPED BYTES ARE NOT RETURNED: the page
    /// has no use for them and no way to open them.
    async fn get_prf_enrollment() -> Result<Option<PrfEnrollment>, SealError> {
        out(get_prf_enrollment().await)
    }

    /// Enrol a passkey rung (seal.ts `enablePrf`).
    async fn enable_prf(
        kek: polymorph_webcrypto_guest::bindings::key_wrap::KwKey,
        enrollment: PrfEnrollment,
        passphrase: Option<String>,
    ) -> Result<(), SealError> {
        out(enable_prf(KwKey::from_raw(kek), enrollment, passphrase).await)
    }

    /// Open with the page-derived KEK (seal.ts `unsealWithPrf`). Parks
    /// the DEK.
    async fn unseal_with_prf(
        kek: polymorph_webcrypto_guest::bindings::key_wrap::KwKey,
    ) -> Result<(), SealError> {
        out(unseal_with_prf(KwKey::from_raw(kek)).await)
    }

    /// Delete the platform wrap and its key, AND NOTHING ELSE (seal.ts
    /// `reseal`). The passphrase wrap and the PRF wrap survive: an
    /// assertion per unseal is the PRF rung's whole point, so what it
    /// leaves behind opens nothing on its own.
    async fn reseal() {
        namespace::delete_platform_wrap().await;
        namespace::delete_platform_kek().await;
    }
}

fn from_wit_origin(origin: PassphraseOrigin) -> records::Origin {
    match origin {
        PassphraseOrigin::User => records::Origin::User,
        PassphraseOrigin::Generated => records::Origin::Generated,
    }
}

async fn create_sealed_dek(passphrase: &str, origin: PassphraseOrigin) -> Res<()> {
    if namespace::get_passphrase_wrap().await.is_some() {
        return Err(Refusal::already_sealed());
    }
    records::require_passphrase(passphrase)?;
    let salt = ladder::fresh_salt();
    let kek = ladder::kek_from_passphrase(passphrase, &salt, records::PBKDF2_ITERATIONS).await?;
    // Born extractable: `wrap` has to be able to serialize it.
    let dek = ladder::generate_dek().await?;
    let wrapped = ladder::wrap_dek(&dek, &kek).await?;
    namespace::put_passphrase_wrap(ladder::passphrase_record(
        salt,
        wrapped.clone(),
        origin,
    ))
    .await;
    // PARK THE SAME KEY AS A NON-EXTRACTABLE HANDLE, not the wrappable
    // local (seal.ts:349-351): the component holds this for a session.
    let parked = ladder::unwrap_dek(&wrapped, &kek, false)
        .await
        .map_err(ladder::platform)?;
    state::park(parked);
    Ok(())
}

async fn unseal_with_passphrase(passphrase: &str) -> Res<()> {
    let rec = namespace::get_passphrase_wrap()
        .await
        .ok_or_else(Refusal::no_passphrase_rung)?;
    records::validate_passphrase_wrap(rec.iterations, &rec.salt, &rec.wrapped)?;
    // THE ITERATION COUNT COMES FROM THE RECORD, never the constant: a
    // device sealed under an older floor must still open.
    let kek = ladder::kek_from_passphrase(passphrase, &rec.salt, rec.iterations).await?;
    // Nothing is written and nothing cached on failure; the caller learns
    // exactly one bit.
    let dek = ladder::unwrap_dek(&rec.wrapped, &kek, false)
        .await
        .map_err(|_| Refusal::wrong_passphrase())?;
    state::park(dek);
    Ok(())
}

async fn rekey_passphrase(old: &str, new: &str) -> Res<()> {
    records::require_passphrase(new)?;
    let dek = ladder::wrappable_dek(old).await?;
    let salt = ladder::fresh_salt();
    let kek = ladder::kek_from_passphrase(new, &salt, records::PBKDF2_ITERATIONS).await?;
    let wrapped = ladder::wrap_dek(&dek, &kek).await?;
    // ONE WRITE, after every fallible step has succeeded: a failed re-key
    // leaves the old passphrase working. A person chose this one,
    // whatever the rung it replaces was.
    namespace::put_passphrase_wrap(ladder::passphrase_record(
        salt,
        wrapped,
        PassphraseOrigin::User,
    ))
    .await;
    Ok(())
}

async fn enable_until_reseal(passphrase: &str) -> Res<()> {
    let dek = ladder::wrappable_dek(passphrase).await?;
    // Non-extractable, `wrap`/`unwrap` only: it cannot encrypt data, only
    // hold the DEK.
    let kek = polymorph_webcrypto_guest::aes_kw::generate_key(
        polymorph_webcrypto_guest::aes_gcm::AesVariant::Aes256,
        polymorph_webcrypto_guest::KwKeyOptions {
            wrap: true,
            unwrap: true,
            extractable: false,
        },
    )
    .await
    .map_err(ladder::platform)?;
    let wrapped = ladder::wrap_dek(&dek, &kek).await?;
    // HANDLE FIRST, THEN THE WRAP (seal.ts:449-453): the pair is only
    // meaningful together, and a wrap with no key is the state that would
    // make `unseal-from-platform` report a rung it cannot use.
    namespace::put_platform_kek(kek.as_raw()).await;
    namespace::put_platform_wrap(namespace::PlatformWrap { wrapped }).await;
    Ok(())
}

async fn rekey_from_platform(new: &str) -> Res<()> {
    records::require_passphrase(new)?;
    let dek = ladder::wrappable_dek_from_platform().await?;
    let salt = ladder::fresh_salt();
    let kek = ladder::kek_from_passphrase(new, &salt, records::PBKDF2_ITERATIONS).await?;
    let wrapped = ladder::wrap_dek(&dek, &kek).await?;
    namespace::put_passphrase_wrap(ladder::passphrase_record(
        salt,
        wrapped,
        PassphraseOrigin::User,
    ))
    .await;
    Ok(())
}

async fn unseal_from_platform() -> Res<bool> {
    // `ok(false)` when EITHER half is absent — a device that must be
    // asked for its passphrase is the normal case, not an error
    // (seal.ts:540-548, world.wit:255-258).
    let rec = namespace::get_platform_wrap().await;
    let kek = namespace::get_platform_kek().await;
    let (Some(rec), Some(kek)) = (rec, kek) else {
        return Ok(false);
    };
    records::validate_platform_wrap(&rec.wrapped)?;
    let kek = KwKey::from_raw(kek);
    // Validate-on-load: a planted EXTRACTABLE key here would be an
    // attacker's handle we then used to unwrap the DEK (seal.ts:546-552).
    if kek.extractable() || !kek.can_unwrap() {
        return Err(Refusal::platform_kek_unusable());
    }
    let dek = ladder::unwrap_dek(&rec.wrapped, &kek, false)
        .await
        .map_err(|_| Refusal::platform_wrap_did_not_open())?;
    state::park(dek);
    Ok(true)
}

async fn get_prf_enrollment() -> Res<Option<PrfEnrollment>> {
    Ok(ladder::read_prf_wrap().await?.map(|rec| PrfEnrollment {
        credential_id: rec.credential_id,
        transports: rec.transports,
        rp_id: rec.rp_id,
        prf_input: rec.prf_input,
        hkdf_salt: rec.hkdf_salt,
    }))
}

async fn enable_prf(
    kek: KwKey,
    enrollment: PrfEnrollment,
    passphrase: Option<String>,
) -> Res<()> {
    ladder::require_prf_kek(&kek)?;
    // WHAT AUTHORIZES IT (seal.ts `enablePrf`, 651-709): preferentially
    // the PLATFORM rung — a device at the promotion moment always has
    // one, and its passphrase rung may well be the door with no key
    // `sealT0` left behind. With the platform rung gone, the authority is
    // the PASSPHRASE the sheet asked for. With neither, this refuses:
    // there is no third authority, and a ceremony that re-wrapped a DEK
    // on nobody's say-so would be one.
    //
    // The branch follows `until-reseal`, which is the platform WRAP's
    // presence alone (seal.ts:687 reads `sealState`); a wrap whose key
    // has gone missing therefore refuses `no-rung` from
    // `wrappable_dek_from_platform` rather than falling through to the
    // passphrase, exactly as the TypeScript does.
    let dek: Aead = if namespace::get_platform_wrap().await.is_some() {
        ladder::wrappable_dek_from_platform().await?
    } else if let Some(passphrase) = &passphrase {
        // An EMPTY string is an offered passphrase, not an absent one:
        // seal.ts branches on `!== undefined`, so it reaches
        // `wrappableDek` and refuses `wrong-passphrase`. Preserved.
        ladder::wrappable_dek(passphrase).await?
    } else {
        return Err(Refusal::no_prf_authority());
    };
    let wrapped = ladder::wrap_dek(&dek, &kek).await?;
    // ONE WRITE, after every fallible step: a failed enrollment leaves
    // the device exactly as it was.
    //
    // IT DOES NOT DELETE THE PLATFORM WRAP (seal.ts:668-672). Shutting
    // that door is the caller's half — worker.ts's `promote` calls
    // `reseal` after this returns — because the decision "a user who
    // asked to be asked must not leave a silent door standing" belongs to
    // the ceremony that knows what the user chose, not to the re-wrap.
    // PERSISTENCE.md's promotion paragraph describes that CALLER's
    // sequence, not this function's.
    namespace::put_prf_wrap(namespace::PrfWrap {
        credential_id: enrollment.credential_id,
        transports: enrollment.transports,
        rp_id: enrollment.rp_id,
        prf_input: enrollment.prf_input,
        hkdf_salt: enrollment.hkdf_salt,
        wrapped,
    })
    .await;
    Ok(())
}

async fn unseal_with_prf(kek: KwKey) -> Res<()> {
    // The VALIDATED reader, so a malformed record refuses as `tampered`
    // here too: "someone altered the record" and "the right record, the
    // wrong key" are different facts and get different codes.
    let rec = ladder::read_prf_wrap().await?.ok_or_else(Refusal::no_passkey_rung)?;
    ladder::require_prf_kek(&kek)?;
    // A FAILED UNWRAP IS ONE BIT: a wrong credential, a wrong PRF input,
    // and a record copied in from another device are indistinguishable
    // here by construction.
    let dek = ladder::unwrap_dek(&rec.wrapped, &kek, false)
        .await
        .map_err(|_| Refusal::wrong_passkey())?;
    state::park(dek);
    Ok(())
}

// --- sealed ------------------------------------------------------------------

/// The parked DEK, or `no-rung`: the component is sealed
/// (world.wit:282-283).
fn dek() -> Res<std::rc::Rc<Aead>> {
    state::dek().ok_or_else(Refusal::device_sealed)
}

impl SealedGuest for Component {
    /// Seal `bytes` under the DEK and store them at `key` (seal.ts
    /// `sealedPut`). Fresh 12-byte IV per write — reuse under one key is
    /// the failure mode that loses both confidentiality and integrity for
    /// GCM — and THE KEY NAME IS THE ADDITIONAL DATA, so a valid value
    /// cannot be moved from one name to another.
    async fn put(key: String, bytes: Vec<u8>) -> Result<(), SealError> {
        out(sealed_put(&key, &bytes).await)
    }

    /// Open the sealed value at `key` (seal.ts `sealedGet`). A value that
    /// is PRESENT BUT DOES NOT OPEN is `tampered`, never `none`:
    /// "nothing stored" and "stored and altered underneath us" are
    /// different facts.
    async fn get(key: String) -> Result<Option<Vec<u8>>, SealError> {
        out(sealed_get(&key).await)
    }

    /// Forget the value at `key`.
    ///
    /// CONTRACT: seal.ts `sealedDelete` (833-835) takes no DEK and works
    /// on a sealed device — deleting ciphertext needs no key. The WIT
    /// rules otherwise for the whole interface ("Every function refuses
    /// with `no-rung` when nothing is parked", world.wit:282-283), and
    /// the WIT is the pinned contract, so the gate applies here too. The
    /// conservative reading also happens to be the narrower surface: a
    /// sealed component offers no way to touch the namespace at all.
    async fn delete(key: String) -> Result<(), SealError> {
        out(sealed_delete(&key).await)
    }

    /// Seal a whole file, PMSEALv1 (sealed-fs.ts `sealBytes`). Fresh IV
    /// per commit, so re-sealing a file after a one-byte change never
    /// reuses one under the DEK.
    async fn seal_file(plaintext: Vec<u8>) -> Result<Vec<u8>, SealError> {
        out(seal_file(&plaintext).await)
    }

    /// Open a whole file (sealed-fs.ts `openBytes`). Bad magic, a short
    /// header and a GCM failure are all `tampered`: a wrong DEK and
    /// altered bytes are the same event to GCM and are reported as one.
    async fn open_file(sealed: Vec<u8>) -> Result<Vec<u8>, SealError> {
        out(open_file(&sealed).await)
    }
}

async fn sealed_put(key: &str, bytes: &[u8]) -> Res<()> {
    let dek = dek()?;
    let iv = ladder::random(records::IV_BYTES);
    let ct = dek
        .seal(&iv[..], records::sealed_aad(key), bytes)
        .await
        .map_err(ladder::platform)?;
    namespace::put_sealed(key.to_string(), namespace::SealedValue { iv, ct }).await;
    Ok(())
}

async fn sealed_get(key: &str) -> Res<Option<Vec<u8>>> {
    let dek = dek()?;
    let Some(rec) = namespace::get_sealed(key.to_string()).await else {
        return Ok(None);
    };
    records::validate_sealed_value(key, &rec.iv, &rec.ct)?;
    let opened = dek
        .open(&rec.iv[..], records::sealed_aad(key), &rec.ct[..])
        .await
        .map_err(|_| Refusal::sealed_value_did_not_open(key))?;
    Ok(Some(opened.collect().await))
}

async fn sealed_delete(key: &str) -> Res<()> {
    let _dek = dek()?;
    namespace::delete_sealed(key.to_string()).await;
    Ok(())
}

async fn seal_file(plaintext: &[u8]) -> Res<Vec<u8>> {
    let dek = dek()?;
    let iv = ladder::random(file_format::IV_BYTES);
    // The additional data is the MAGIC, not the whole header — see
    // `file_format::AAD`.
    let body = dek
        .seal(&iv[..], file_format::AAD, plaintext)
        .await
        .map_err(ladder::platform)?;
    Ok(file_format::frame(&iv, &body))
}

async fn open_file(sealed: &[u8]) -> Res<Vec<u8>> {
    let dek = dek()?;
    match file_format::parse(sealed)? {
        // A file the provider created and never wrote to has no header at
        // all, and is an empty file rather than a broken one.
        Framed::Empty => Ok(Vec::new()),
        Framed::Sealed { iv, body } => {
            let opened = dek
                .open(iv, file_format::AAD, body)
                .await
                .map_err(|_| Refusal::file_did_not_open())?;
            Ok(opened.collect().await)
        }
    }
}

// --- identity ----------------------------------------------------------------

impl IdentityGuest for Component {
    async fn load_or_mint(
        slot: IdentitySlot,
    ) -> Result<(SigningKeyRaw, VerifyingKeyRaw), SealError> {
        out(identity::load_or_mint(slot).await.map(into_raw_pair))
    }

    async fn load(
        slot: IdentitySlot,
    ) -> Result<Option<(SigningKeyRaw, VerifyingKeyRaw)>, SealError> {
        out(identity::load(slot).await.map(|pair| pair.map(into_raw_pair)))
    }

    async fn delete(slot: IdentitySlot) -> Result<(), SealError> {
        out(identity::delete(slot).await)
    }
}

type SigningKeyRaw = polymorph_webcrypto_guest::bindings::signature::SigningKey;
type VerifyingKeyRaw = polymorph_webcrypto_guest::bindings::signature::VerifyingKey;

fn into_raw_pair(pair: (SigningKey, VerifyingKey)) -> (SigningKeyRaw, VerifyingKeyRaw) {
    (pair.0.into_raw(), pair.1.into_raw())
}

crate::export!(Component with_types_in crate);
