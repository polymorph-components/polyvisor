//! Passphrase-encrypted root signing seed backup.
//!
//! File export and the synced current backup use this same fixed-width v1
//! envelope. Parsing is by fixed offsets so untrusted KDF costs and context
//! are rejected before the expensive derivation is requested.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use ed25519_dalek::SigningKey;

pub const ROOT_SEED_LEN: usize = 32;
pub const ROOT_PUBLIC_KEY_LEN: usize = 32;
pub const GROUP_ID_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// Backup v1 uses Argon2id v1.3 with 64 MiB, three passes, and one lane.
/// The approximately five-second recent-phone target remains unverified.
pub const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
pub const ARGON2_TIME_COST: u32 = 3;
pub const ARGON2_LANES: u32 = 1;

const MAGIC: &[u8; 8] = b"PVROOTBK";
const VERSION: u8 = 1;
const KDF_ARGON2ID_V19: u8 = 1;
const HEADER_LEN: usize = 8 + 1 + 1 + 4 + 4 + 4 + 32 + 32 + 16 + 12;
const TAG_LEN: usize = 16;
pub const ENCODED_LEN: usize = HEADER_LEN + ROOT_SEED_LEN + TAG_LEN;
const MAX_PASSPHRASE_LEN: usize = 1024;

/// Derived AEAD key. Deliberately has no `Debug` implementation.
pub struct DerivedKey([u8; KEY_LEN]);

impl DerivedKey {
    /// Import the fixed-size result returned by the dedicated derivation worker.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Borrow key bytes for transfer from the derivation worker.
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for DerivedKey {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

/// A backup cannot be opened or its untrusted inputs are unacceptable.
/// Wrong keys and tampering intentionally have the same non-secret error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error;

/// Validated metadata used to encrypt after key derivation completes.
pub struct PreparedEncryption {
    header: [u8; HEADER_LEN],
}

impl PreparedEncryption {
    pub fn salt(&self) -> &[u8; SALT_LEN] {
        self.header[86..102]
            .try_into()
            .expect("fixed header offsets")
    }
}

/// A bounded envelope whose version, KDF costs, root, and group are validated.
pub struct PreparedDecryption {
    envelope: [u8; ENCODED_LEN],
}

impl PreparedDecryption {
    pub fn salt(&self) -> &[u8; SALT_LEN] {
        self.envelope[86..102]
            .try_into()
            .expect("fixed envelope offsets")
    }
}

/// Build authenticated v1 metadata before dispatching its salt for derivation.
pub fn prepare_encrypt(
    seed: &[u8; ROOT_SEED_LEN],
    group: &[u8; GROUP_ID_LEN],
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
) -> PreparedEncryption {
    let root = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    let mut header = [0; HEADER_LEN];
    header[..8].copy_from_slice(MAGIC);
    header[8] = VERSION;
    header[9] = KDF_ARGON2ID_V19;
    header[10..14].copy_from_slice(&ARGON2_MEMORY_KIB.to_be_bytes());
    header[14..18].copy_from_slice(&ARGON2_TIME_COST.to_be_bytes());
    header[18..22].copy_from_slice(&ARGON2_LANES.to_be_bytes());
    header[22..54].copy_from_slice(&root);
    header[54..86].copy_from_slice(group);
    header[86..102].copy_from_slice(&salt);
    header[102..].copy_from_slice(&nonce);
    PreparedEncryption { header }
}

/// Validate and copy a fixed-size envelope before requesting key derivation.
pub fn prepare_decrypt(
    expected_root: &[u8; ROOT_PUBLIC_KEY_LEN],
    expected_group: &[u8; GROUP_ID_LEN],
    envelope: &[u8],
) -> Result<PreparedDecryption, Error> {
    let envelope: [u8; ENCODED_LEN] = envelope.try_into().map_err(|_| Error)?;
    if &envelope[..8] != MAGIC
        || envelope[8] != VERSION
        || envelope[9] != KDF_ARGON2ID_V19
        || read_u32(&envelope, 10) != ARGON2_MEMORY_KIB
        || read_u32(&envelope, 14) != ARGON2_TIME_COST
        || read_u32(&envelope, 18) != ARGON2_LANES
        || &envelope[22..54] != expected_root
        || &envelope[54..86] != expected_group
    {
        return Err(Error);
    }
    Ok(PreparedDecryption { envelope })
}

/// The sole expensive seam: derive a v1 key from only passphrase and salt.
///
/// A dedicated Rust Wasm worker can call this function and return the key;
/// root seed material never crosses that worker boundary.
pub fn derive_key(passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<DerivedKey, Error> {
    if passphrase.len() > MAX_PASSPHRASE_LEN {
        return Err(Error);
    }
    let params = argon2::Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_TIME_COST,
        ARGON2_LANES,
        Some(KEY_LEN),
    )
    .map_err(|_| Error)?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| Error)?;
    Ok(DerivedKey(key))
}

/// Encrypt a root seed after derivation, binding every header field as AAD.
pub fn encrypt(
    prepared: PreparedEncryption,
    seed: &[u8; ROOT_SEED_LEN],
    key: &DerivedKey,
) -> Result<Vec<u8>, Error> {
    if SigningKey::from_bytes(seed).verifying_key().to_bytes() != prepared.header[22..54] {
        return Err(Error);
    }
    let nonce: [u8; NONCE_LEN] = prepared.header[102..].try_into().map_err(|_| Error)?;
    let ciphertext = cipher(key)?
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: seed,
                aad: &prepared.header,
            },
        )
        .map_err(|_| Error)?;
    let mut envelope = Vec::with_capacity(ENCODED_LEN);
    envelope.extend_from_slice(&prepared.header);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

/// Decrypt after derivation and verify that the seed makes the named root key.
pub fn decrypt(
    prepared: PreparedDecryption,
    key: &DerivedKey,
) -> Result<[u8; ROOT_SEED_LEN], Error> {
    let nonce: [u8; NONCE_LEN] = prepared.envelope[102..HEADER_LEN]
        .try_into()
        .map_err(|_| Error)?;
    let mut plaintext = cipher(key)?
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &prepared.envelope[HEADER_LEN..],
                aad: &prepared.envelope[..HEADER_LEN],
            },
        )
        .map_err(|_| Error)?;
    let seed: [u8; ROOT_SEED_LEN] = plaintext.as_slice().try_into().map_err(|_| Error)?;
    plaintext.fill(0);
    if SigningKey::from_bytes(&seed).verifying_key().to_bytes() != prepared.envelope[22..54] {
        let mut rejected = seed;
        rejected.fill(0);
        return Err(Error);
    }
    Ok(seed)
}

fn cipher(key: &DerivedKey) -> Result<Aes256Gcm, Error> {
    Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| Error)
}

fn read_u32(bytes: &[u8; ENCODED_LEN], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed envelope offsets"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; ROOT_SEED_LEN] = [7; ROOT_SEED_LEN];
    const GROUP: [u8; GROUP_ID_LEN] = [11; GROUP_ID_LEN];
    const SALT: [u8; SALT_LEN] = [13; SALT_LEN];
    const NONCE: [u8; NONCE_LEN] = [17; NONCE_LEN];

    fn root() -> [u8; ROOT_PUBLIC_KEY_LEN] {
        SigningKey::from_bytes(&SEED).verifying_key().to_bytes()
    }

    fn backup() -> Vec<u8> {
        let prepared = prepare_encrypt(&SEED, &GROUP, SALT, NONCE);
        let key = derive_key("correct horse", prepared.salt()).unwrap();
        encrypt(prepared, &SEED, &key).unwrap()
    }

    fn open(passphrase: &str, envelope: &[u8]) -> Result<[u8; ROOT_SEED_LEN], Error> {
        let prepared = prepare_decrypt(&root(), &GROUP, envelope)?;
        let key = derive_key(passphrase, prepared.salt())?;
        decrypt(prepared, &key)
    }

    #[test]
    fn self_contained_roundtrip() {
        let encoded = backup();
        assert_eq!(encoded.len(), ENCODED_LEN);
        assert_eq!(open("correct horse", &encoded), Ok(SEED));
    }

    #[test]
    fn rejects_wrong_passphrase_and_tampering() {
        let encoded = backup();
        assert_eq!(open("wrong", &encoded), Err(Error));
        let mut tampered = encoded;
        tampered[HEADER_LEN] ^= 1;
        assert_eq!(open("correct horse", &tampered), Err(Error));

        let mut nonce_tampered = backup();
        nonce_tampered[102] ^= 1;
        assert_eq!(open("correct horse", &nonce_tampered), Err(Error));
    }

    #[test]
    fn rejects_group_root_and_authenticated_seed_substitution() {
        let encoded = backup();
        assert!(prepare_decrypt(&root(), &[12; GROUP_ID_LEN], &encoded).is_err());
        let other_root = SigningKey::from_bytes(&[8; ROOT_SEED_LEN])
            .verifying_key()
            .to_bytes();
        assert!(prepare_decrypt(&other_root, &GROUP, &encoded).is_err());

        let prepared = prepare_encrypt(&SEED, &GROUP, SALT, NONCE);
        let key = derive_key("correct horse", prepared.salt()).unwrap();
        assert_eq!(encrypt(prepared, &[29; ROOT_SEED_LEN], &key), Err(Error));
    }

    #[test]
    fn rejects_bad_size_and_huge_kdf_costs_before_derivation() {
        let encoded = backup();
        assert!(prepare_decrypt(&root(), &GROUP, &encoded[..ENCODED_LEN - 1]).is_err());
        let mut oversized = encoded.clone();
        oversized.push(0);
        assert!(prepare_decrypt(&root(), &GROUP, &oversized).is_err());

        let mut hostile = encoded;
        hostile[10..14].copy_from_slice(&u32::MAX.to_be_bytes());
        hostile[14..18].copy_from_slice(&u32::MAX.to_be_bytes());
        hostile[18..22].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(prepare_decrypt(&root(), &GROUP, &hostile).is_err());
    }

    #[test]
    fn fresh_salt_and_nonce_change_the_envelope() {
        let first = backup();
        let prepared = prepare_encrypt(&SEED, &GROUP, [19; SALT_LEN], [23; NONCE_LEN]);
        let key = derive_key("correct horse", prepared.salt()).unwrap();
        let second = encrypt(prepared, &SEED, &key).unwrap();
        assert_ne!(first, second);
        assert_eq!(open("correct horse", &second), Ok(SEED));
    }
}
