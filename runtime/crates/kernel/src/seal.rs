//! Sealing: the data-encryption key (DEK), how it rests, and the AEAD the
//! checkpoint rides under.
//!
//! docs/design.md "Devices": *rests open* leaves the DEK in the namespace and
//! the protection is the browser profile's access control; *passphrase* wraps
//! it under Argon2id and unsealing is the login. Both are pure Rust with the
//! key as bytes — a non-extractable WebCrypto handle persisted in IndexedDB
//! would rest under the same profile protection, so it buys nothing here.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};

use crate::{Error, ErrorCode, Rng};

pub const DEK_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;

/// Argon2id at the OWASP minimum configuration: m = 19 MiB, t = 2, p = 1.
///
/// Not the 64 MiB tier a server would use: this runs inside the device's
/// SharedWorker, and a 64 MiB scratch buffer is a wasm32 linear-memory growth
/// of that size on every unseal — on the login path of a browser tab, on
/// phones included. 19 MiB is the documented floor that is still a real
/// memory-hard cost, and it is what fits.
const ARGON2_M_COST_KIB: u32 = 19 * 1024;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

/// The unwrapped data-encryption key. Lives in worker memory only while the
/// device is open.
#[derive(Clone, PartialEq, Eq)]
pub struct Dek(pub [u8; DEK_LEN]);

impl Dek {
    pub fn mint(rng: &dyn Rng) -> Dek {
        let mut key = [0u8; DEK_LEN];
        rng.fill(&mut key);
        Dek(key)
    }

    pub fn decode(bytes: &[u8]) -> Result<Dek, Error> {
        let key: [u8; DEK_LEN] = bytes.try_into().map_err(|_| {
            Error::new(
                ErrorCode::Failed,
                format!(
                    "the stored data key is {} bytes; it must be {DEK_LEN}",
                    bytes.len()
                ),
            )
        })?;
        Ok(Dek(key))
    }

    /// AES-256-GCM over `plaintext`, `aad` authenticated in the clear. The
    /// nonce is drawn fresh per call and prefixed to the ciphertext, so a
    /// stored blob is self-describing.
    pub fn seal(&self, rng: &dyn Rng, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill(&mut nonce);
        let mut out = nonce.to_vec();
        out.extend_from_slice(&encrypt(&self.0, &nonce, plaintext, aad)?);
        Ok(out)
    }

    /// The inverse of [`Dek::seal`]. Any failure — short blob, wrong key,
    /// wrong `aad`, a flipped bit — is one indistinguishable error.
    pub fn open(&self, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
        if blob.len() < NONCE_LEN {
            return Err(unreadable());
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().expect("split at NONCE_LEN");
        decrypt(&self.0, &nonce, ct, aad)
    }
}

/// The record written to `dev/<id>/dek-wrapped` when a device rests under a
/// passphrase. Everything needed to re-derive the KEK, and nothing else: the
/// parameters travel with the ciphertext so a later runtime raising the cost
/// can still open an older device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedDek {
    v: u32,
    pub salt: Vec<u8>,
    pub nonce: Vec<u8>,
    pub ct: Vec<u8>,
    pub params: Argon2Params,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Argon2Params {
    /// Memory cost in KiB.
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for Argon2Params {
    fn default() -> Self {
        Argon2Params {
            m_cost: ARGON2_M_COST_KIB,
            t_cost: ARGON2_T_COST,
            p_cost: ARGON2_P_COST,
        }
    }
}

impl WrappedDek {
    /// Derive a KEK from `passphrase` under a fresh salt and wrap `dek` with
    /// it. The device id is the AEAD's associated data, so a wrapped key
    /// cannot be moved to another device's namespace and still open.
    pub fn wrap(rng: &dyn Rng, dek: &Dek, passphrase: &str, id: &str) -> Result<WrappedDek, Error> {
        let mut salt = [0u8; SALT_LEN];
        rng.fill(&mut salt);
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill(&mut nonce);
        let params = Argon2Params::default();
        let kek = derive_kek(passphrase, &salt, &params)?;
        let ct = encrypt(&kek, &nonce, &dek.0, id.as_bytes())?;
        Ok(WrappedDek {
            v: crate::device::SCHEMA,
            salt: salt.to_vec(),
            nonce: nonce.to_vec(),
            ct,
            params,
        })
    }

    /// The login. A wrong passphrase is indistinguishable from a corrupt
    /// record here; the caller turns both into `refused`.
    pub fn unwrap_with(&self, passphrase: &str, id: &str) -> Result<Dek, Error> {
        let kek = derive_kek(passphrase, &self.salt, &self.params)?;
        let nonce: [u8; NONCE_LEN] = self.nonce.as_slice().try_into().map_err(|_| unreadable())?;
        let plain = decrypt(&kek, &nonce, &self.ct, id.as_bytes())?;
        Dek::decode(&plain)
    }

    pub fn decode(bytes: &[u8]) -> Result<WrappedDek, Error> {
        let record: WrappedDek = serde_json::from_slice(bytes).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the wrapped data key could not be read: {e}"),
            )
        })?;
        if record.v != crate::device::SCHEMA {
            return Err(Error::new(
                ErrorCode::Failed,
                format!(
                    "the wrapped data key is version {}; this runtime speaks {}",
                    record.v,
                    crate::device::SCHEMA
                ),
            ));
        }
        Ok(record)
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(self).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the wrapped data key could not be written: {e}"),
            )
        })
    }
}

fn derive_kek(
    passphrase: &str,
    salt: &[u8],
    params: &Argon2Params,
) -> Result<[u8; DEK_LEN], Error> {
    let params = argon2::Params::new(params.m_cost, params.t_cost, params.p_cost, Some(DEK_LEN))
        .map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the key derivation parameters are not usable: {e}"),
            )
        })?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut kek = [0u8; DEK_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut kek)
        .map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the passphrase could not be turned into a key: {e}"),
            )
        })?;
    Ok(kek)
}

fn cipher(key: &[u8; DEK_LEN]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("a 32-byte key is an AES-256 key")
}

fn encrypt(
    key: &[u8; DEK_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, Error> {
    cipher(key)
        .encrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::new(ErrorCode::Failed, "the state could not be sealed"))
}

fn decrypt(
    key: &[u8; DEK_LEN],
    nonce: &[u8; NONCE_LEN],
    ct: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, Error> {
    cipher(key)
        .decrypt(&Nonce::from(*nonce), Payload { msg: ct, aad })
        .map_err(|_| unreadable())
}

fn unreadable() -> Error {
    Error::new(ErrorCode::Failed, "the sealed record did not open")
}
