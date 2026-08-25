//! Account recovery (#11), implementing runtime/RECOVERY.md.
//!
//! The claim: losing every device does not lose the account. A recovery
//! kit — a generated phrase, or a downloaded file plus its passphrase —
//! together with access to the account's storage bucket restores the
//! account on a fresh browser with NO LIVE PEER ANYWHERE.
//!
//! # Recovery is a DEVICE, not a resurrection
//!
//! The kit ceremony mints a dormant MEMBER DEVICE: a real leaf in the
//! account's delegation graph, enrolled through the ordinary
//! `usdoc::enroll_device` path, visible in the devices sheet, revocable
//! like any device. Its secrets exist only inside a sealed bundle. This
//! is not an export of a live device's identity, and the reason is
//! posture: a kept device's signing key is a non-extractable platform
//! handle, so an exportable kit from it would require a downgrade for
//! every device that wanted recovery coverage. A minted-for-export soft
//! identity leaves every real device's posture untouched.
//!
//! # Why the dormant leaf does not go stale
//!
//! The G5 finding stands — self-rotation secrets exist only in the
//! archive, so a bundle exported before its device's own authoring
//! cannot reach epochs that authoring created. The recovery device NEVER
//! AUTHORS between mint and restore, so its leaf never self-rotates, so
//! every later epoch reaches it through CGKA ops in the flushed oplogs,
//! addressed to a leaf it still holds. This is the proven G4 tablet path
//! with the tablet's browser replaced by a sealed blob.
//!
//! # The bootstrap
//!
//! SYNC.md moved the per-doc name chains INTO the us-doc, which is
//! exactly why a cold restore could not start: the us-doc's own chain is
//! inside the us-doc. `store_grant(us-doc, recovery-id)` closes the loop
//! with machinery that already exists — a K_p pickup carrying the
//! us-doc's name-key chain and the author device list, sealed to the
//! recovery device's contact-card prekeys, which ride the bundle. ONE
//! pickup bootstraps everything.

use std::sync::Arc;

use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use polymorph_webcrypto_guest::{hkdf, hkdf_sha2, DeriveOptions};
use provider_gdrive::{gd_delete, gd_pickup_name};
use provider_s3::{delete_object, get_object_unsigned, kp_location, put_object, S3Cfg};
use serde::{Deserialize, Serialize};

use crate::exports::polyvisor::engine::driver::{
    Guest as DriverGuest, RecoveryKit, StoreConfig, UsStorage,
    UsStorageGdrive, UsStorageS3,
};
use crate::wordlist::EFF_SHORT;
use crate::{
    aead_from_raw, aead_open, aead_seal, argon2id_key, arr32, usdoc, with_state, BundleSlot,
    Component, EngineFetch, EngineSigner, IdentityBundle, IdentityKey, Kh, KhStore, Provider,
    SignerInner, StoreCfg, WebcryptoSigner, ARGON_M_KIB, ARGON_P, ARGON_T, CARD, T,
};

/// The two kit kinds, as the account's `recovery` record spells them.
pub(crate) const KIND_BUCKET: &str = "bucket";
pub(crate) const KIND_FILE: &str = "file";

/// AAD for the recovery bundle's sealed payload.
///
/// DOMAIN-SEPARATED FROM `b"identity-bundle"` DELIBERATELY. The two
/// payloads share the `IdentityBundle` container and the keyslot
/// machinery but decode as different structs, so a bundle of one kind
/// fed to the other kind's reader must fail at the AEAD rather than at
/// `bincode`, where a partial structural match is imaginable.
const RECOVERY_AAD: &[u8] = b"recovery-bundle";

/// The FIXED argon2id salt (RECOVERY.md, "Derivation, pinned").
///
/// Fixed BECAUSE the bucket object name must be derivable from the
/// phrase alone — there is nowhere to put a per-kit salt that a cold
/// restore could read before it has found the kit. The phrase's
/// GENERATED entropy (~103.4 bits) is the security here and argon2id is
/// depth; the brainwallet objection applies to human-chosen secrets,
/// which this slot never holds (see `kit_create_bucket`'s refusal to
/// accept one).
const ROOT_SALT: &[u8] = b"polyvisor-recovery-v1";

/// HKDF info strings, pinned by the record.
const INFO_NAME: &[u8] = b"polyvisor recovery name v1";
const INFO_KEK: &[u8] = b"polyvisor recovery kek v1";

/// The bucket object-name prefix. Not secret — the provider sees the
/// object regardless, and the payload behind it is sealed under the
/// phrase-derived KEK.
const NAME_PREFIX: &str = "recovery/";

/// Words per generated phrase (RECOVERY.md: 10 × log2(1296) ≈ 103.4
/// bits).
const PHRASE_WORDS: usize = 10;

// --- the sealed payload ---------------------------------------------------

/// The account's storage ADDRESSING snapshot, secret-free.
///
/// A separate type from the WIT `us-storage` because WIT records are not
/// `Serialize`; the shapes are kept field-for-field so the conversion
/// cannot silently drop one. What is NOT here is the enforcement, and it
/// is inherited rather than restated: there is no token field and no
/// consent field in `us-storage` either, so no standing user credential
/// can ride a bundle even by accident. The S3 secret cannot appear even
/// in principle — it exists only as a non-extractable handle.
///
/// It rides so that a FILE restore can pre-fill the destination fields
/// after unlock. The BUCKET kind cannot use it for its own fetch:
/// finding the bundle needs the destination first.
#[derive(Serialize, Deserialize)]
enum StorageSnapshot {
    S3 {
        endpoint: String,
        bucket: String,
        access_key: String,
    },
    Gdrive {
        root: String,
        api_base: String,
        space: String,
        client_id: String,
        client_secret: String,
    },
}

impl StorageSnapshot {
    fn from_wit(s: &UsStorage) -> Self {
        match s {
            UsStorage::S3(c) => StorageSnapshot::S3 {
                endpoint: c.endpoint.clone(),
                bucket: c.bucket.clone(),
                access_key: c.access_key.clone(),
            },
            UsStorage::Gdrive(c) => StorageSnapshot::Gdrive {
                root: c.root.clone(),
                api_base: c.api_base.clone(),
                space: c.space.clone(),
                client_id: c.client_id.clone(),
                client_secret: c.client_secret.clone(),
            },
        }
    }

    #[allow(dead_code)] // the visor's pre-fill consumer is T-C's
    fn to_wit(&self) -> UsStorage {
        match self {
            StorageSnapshot::S3 {
                endpoint,
                bucket,
                access_key,
            } => UsStorage::S3(UsStorageS3 {
                endpoint: endpoint.clone(),
                bucket: bucket.clone(),
                access_key: access_key.clone(),
            }),
            StorageSnapshot::Gdrive {
                root,
                api_base,
                space,
                client_id,
                client_secret,
            } => UsStorage::Gdrive(UsStorageGdrive {
                root: root.clone(),
                api_base: api_base.clone(),
                space: space.clone(),
                client_id: client_id.clone(),
                client_secret: client_secret.clone(),
            }),
        }
    }
}

/// What a recovery bundle carries.
///
/// A NEW STRUCT, NOT AN EXTENSION OF `BundlePayload` — the ruling is
/// RECOVERY.md's compat floor made structural: `buckets.bin`-style
/// bincode is not self-describing, and every G5 bundle in the wild must
/// keep decoding. The two payloads share the container and the keyslots
/// and nothing else.
#[derive(Serialize, Deserialize)]
struct RecoveryPayload {
    /// The recovery identity's 32-byte seed. A SOFT key by construction:
    /// this identity is minted for export and has never been anything
    /// else, which is the whole point (module header).
    signing_key_seed: [u8; 32],
    verifying: [u8; 32],
    /// The throwaway keyhive's archive, bincoded. Signed by the recovery
    /// key, which is what `try_from_archive`'s same-signer rule requires
    /// at restore.
    keyhive_archive: Vec<u8>,
    /// The ENROLL CARD: the static events exported for the recovery
    /// individual. Belt and suspenders against op-arrival-order wedges —
    /// the flushed oplogs carry the same events, so this is redundancy,
    /// not the only copy.
    enroll_card: Vec<u8>,
    /// The user-system partition id and the user group id: what
    /// `usdoc::adopt` needs, and what a cold device has no other way to
    /// learn.
    us_partition: Vec<u8>,
    user_group: Vec<u8>,
    /// The GRANTING device's agent id — the `owner` component of the
    /// K_p's location. Without it the restore cannot name the object
    /// that bootstraps it.
    granting_device: Vec<u8>,
    /// The account's storage addressing at mint time, or `None` if the
    /// account had no record (see `StorageSnapshot`).
    storage: Option<StorageSnapshot>,
    /// `"bucket"` or `"file"`.
    kind: String,
    /// The bucket object name (bucket kind only; empty for a file kit).
    /// Carried so `recovery-consume` and `recovery-kit-revoke` can
    /// delete the object without re-deriving it from a phrase nobody
    /// kept.
    object_name: String,
}

/// What this instance restored from, held for `recovery-consume`.
///
/// INSTANCE MEMORY ONLY, and deliberately not checkpointed: consume runs
/// in the same instance as the restore, right after the first checkpoint
/// and the content fan-out. A worker that died between the two loses the
/// consume, not the restore — and RECOVERY.md prices that exactly: "no
/// kit, loudly" is recoverable by a ceremony; the account's `recovery`
/// record still names the kit, so a later `recovery-kit-revoke` from any
/// device reaches the same end state.
#[derive(Clone)]
pub(crate) struct RestoredKit {
    pub(crate) agent_id: Vec<u8>,
    pub(crate) kind: String,
    pub(crate) object_name: String,
    pub(crate) us_partition: Vec<u8>,
    pub(crate) granting_device: Vec<u8>,
}

// --- derivation (RECOVERY.md, "Derivation, pinned") -----------------------

/// Entry normalization: trim, lowercase, collapse internal whitespace.
///
/// Applied at BOTH ends — generation joins with single spaces, so a
/// generated phrase is already normalized and a re-typed one becomes it.
/// Anything else and a user who typed two spaces would derive a
/// different object name and be told, truthfully but uselessly, that
/// there is no kit at that name.
fn normalize_phrase(phrase: &str) -> String {
    phrase
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A fresh phrase: `PHRASE_WORDS` words drawn UNIFORMLY from the
/// embedded EFF short wordlist.
///
/// Rejection sampling, not a modulus: `u32 % 1296` is biased toward the
/// first 1296 × (2^32 mod 1296 ≠ 0) words, and a biased phrase is a
/// weaker phrase in exactly the dimension the word count was chosen for.
fn generate_phrase() -> String {
    let n = EFF_SHORT.len() as u32;
    let limit = (u32::MAX / n) * n;
    let mut words: Vec<&str> = Vec::with_capacity(PHRASE_WORDS);
    while words.len() < PHRASE_WORDS {
        let v: u32 = rand::random();
        if v >= limit {
            continue;
        }
        words.push(EFF_SHORT[(v % n) as usize]);
    }
    words.join(" ")
}

/// argon2id over the normalized phrase with the fixed context salt.
fn phrase_root(phrase: &str) -> Result<[u8; 32], String> {
    argon2id_key(
        &normalize_phrase(phrase),
        ROOT_SALT,
        ARGON_M_KIB,
        ARGON_T,
        ARGON_P,
    )
}

/// HKDF-SHA-256(root, info) → 32 bytes, through the guest's webcrypto
/// port (`polymorph:webcrypto/hkdf` + `hkdf-sha2`), which is what the
/// engine already uses for every other symmetric primitive.
///
/// Salt is EMPTY, i.e. RFC 5869's default of a hash-length zero block.
/// The extract step's salt is not carrying separation here — `info` is,
/// and the two derivations differ only there, which is precisely the
/// parameter RFC 5869 defines for it.
async fn hkdf32(root: &[u8; 32], info: &[u8]) -> Result<[u8; 32], String> {
    let ikm = hkdf::import_ikm(
        root.to_vec(),
        DeriveOptions {
            derive_bits: true,
            derive_key: false,
        },
    )
    .await
    .map_err(|e| format!("hkdf import: {e}"))?;
    let input = hkdf_sha2::prepare(
        hkdf_sha2::Sha2Variant::Sha256,
        &ikm,
        Vec::new(),
        info.to_vec(),
    )
    .await
    .map_err(|e| format!("hkdf prepare: {e}"))?;
    let bits = input
        .derive_bits(Some(256))
        .await
        .map_err(|e| format!("hkdf derive: {e}"))?;
    arr32(&bits, "hkdf output")
}

/// The bucket object name and the slot KEK, from one phrase.
async fn derive_bucket_kit(phrase: &str) -> Result<(String, [u8; 32]), String> {
    let root = phrase_root(phrase)?;
    let name = hkdf32(&root, INFO_NAME).await?;
    let kek = hkdf32(&root, INFO_KEK).await?;
    Ok((format!("{NAME_PREFIX}{}", hex::encode(name)), kek))
}

// --- the config-parameterized store, for a stateless fetch ---------------

/// S3 addressing straight out of a `store-config`, with NO ENGINE STATE
/// CONSULTED.
///
/// This is the ordering the bucket restore turns on: the bundle must be
/// fetched before `finish_init` has run, so `crate::store()` — which
/// reads `State` — cannot be used and the config travels as a parameter
/// instead (engine.wit's note on `recovery-restore-bucket`). The S3
/// helpers were already shaped for it: they take an explicit `S3Cfg`,
/// and `EngineFetch` counts fetches through a `let _ = with_state(..)`
/// that tolerates an uninitialized engine.
fn s3_from_config(config: &StoreConfig) -> Result<S3Cfg, String> {
    match config {
        StoreConfig::S3(c) => Ok(S3Cfg {
            endpoint: c.endpoint.trim_end_matches('/').to_string(),
            bucket: c.bucket.clone(),
            access: c.access_key.clone(),
        }),
        // CONTRACT: RECOVERY.md describes the bucket kit provider-
        // neutrally, but the object it needs is an owner-tier PUT at a
        // NAME the guest derives, and only S3 addresses objects by name.
        // Dropbox and Drive resolve ids through a folder walk, so a
        // phrase-derived name is not a location there without a design
        // decision this track has no ruling for. Refused BY NAME rather
        // than silently mis-stored; the FILE kit works on every provider
        // because it stores no object at all.
        StoreConfig::Dropbox(_) => Err(
            "recovery bucket kits are S3-only at this rev: a phrase-derived object NAME is not \
             a location on Dropbox (id-addressed). Use a file kit."
                .into(),
        ),
        StoreConfig::Gdrive(_) => Err(
            "recovery bucket kits are S3-only at this rev: a phrase-derived object NAME is not \
             a location on Google Drive (id-addressed). Use a file kit."
                .into(),
        ),
    }
}

/// The same refusal, from the bound store rather than a parameter.
fn s3_from_state() -> Result<S3Cfg, String> {
    with_state(|s| match s.store.as_ref() {
        Some(StoreCfg::S3(c)) => Ok(S3Cfg {
            endpoint: c.endpoint.clone(),
            bucket: c.bucket.clone(),
            access: c.access.clone(),
        }),
        Some(_) => Err(
            "recovery bucket kits are S3-only at this rev (see `s3_from_config`); use a file kit"
                .to_string(),
        ),
        None => Err("no store bound (init-store first)".to_string()),
    })?
}

/// Which keyslot the ceremony seals the bundle key under.
///
/// ONE SLOT PER KIT, and the kind decides which. The G5 bundle can carry
/// both because a device file is a have-and-know artifact either way;
/// a recovery bundle cannot, because the two kinds have OPPOSITE
/// exposure rules (RECOVERY.md's table) and a bundle carrying both slots
/// would be as weak as its weaker one.
enum Slot {
    /// The BUCKET kind: a GENERATED secret, never a human-chosen one.
    /// The exposure rule made structural — a replicated artifact gets a
    /// generated-secret slot only. This is the brainwallet/LastPass
    /// lesson: nothing the system replicates may be crackable via human
    /// memory.
    Generated([u8; 32]),
    /// The FILE kind: the user's own passphrase (argon2id, random
    /// per-file salt riding the slot — PERSISTENCE.md's table,
    /// unchanged). Sanctioned because custody makes it have+know.
    Passphrase(String),
}

// --- the kit ceremony (RECOVERY.md, "The kit ceremony") -------------------

/// Everything the ceremony produces before the kind's own step: the
/// enrolled recovery device and the payload it will be sealed into,
/// minus the two fields only the kind knows.
struct Minted {
    recovery_id: Vec<u8>,
    payload: RecoveryPayload,
}

/// Steps 1–3 of the record's ceremony, shared by both kinds.
///
/// The ORDER is the record's, step for step, and it is load-bearing:
/// the contact card must be ingested before enrollment (the delegation
/// is issued to a principal the account holds), enrollment must precede
/// the K_p (the pickup carries a device list the enrollment writes), and
/// the archive must be taken before any of it (the leaf the bundle
/// carries is the never-authored one).
async fn mint(label: &str) -> Result<Minted, String> {
    // Both kinds REFUSE BY NAME without a bound store and without an
    // account. A kit with no bucket restores nothing — content
    // rehydrates from the bucket — and a kit with no account has no
    // membership to mint.
    if with_state(|s| s.store.is_none())? {
        return Err(
            "no store bound: a recovery kit without a bucket restores nothing (init-store first)"
                .into(),
        );
    }
    if !usdoc::has_account()? {
        return Err(
            "no account on this device: a recovery kit is a MEMBER DEVICE, and there is no \
             account to enrol it into (user-create or pair first)"
                .into(),
        );
    }

    // 1. The recovery identity and its THROWAWAY keyhive. `contact_card`
    //    mints the prekeys the K_p is sealed to; the archive is taken
    //    immediately after, so what the bundle carries is a keyhive that
    //    has never authored anything (module header: dormancy).
    let seed_key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    let seed = seed_key.to_bytes();
    let verifying = seed_key.verifying_key();
    let rsigner = WebcryptoSigner(std::rc::Rc::new(SignerInner {
        key: IdentityKey::Soft(Box::new(seed_key)),
        verifying,
        sign_count: std::cell::Cell::new(0),
    }));
    let rstore: KhStore = MemoryCiphertextStore::new();
    let rkh: Kh = Kh::generate(rsigner, rstore, NoListener, rand::rngs::OsRng)
        .await
        .map_err(|e| format!("recovery keyhive generate: {e:?}"))?;
    let card = rkh
        .contact_card()
        .await
        .map_err(|e| format!("recovery contact card: {e:?}"))?;
    let card_bytes = bincode::serialize(&card).map_err(|e| e.to_string())?;
    let archive_bytes = bincode::serialize(&rkh.clone().into_archive().await)
        .map_err(|e| format!("archive serialize: {e}"))?;

    // 2. Enrollment, through the EXISTING path — admin membership, the
    //    deliberate epoch rotation, the devices entry (the us-doc's walk
    //    anchor), `anchor_data_partitions`. Reused, not reimplemented: a
    //    second enrollment path is a second place for PAIRING.md §2's
    //    ordering to rot. The kit appears in the devices sheet under the
    //    user's own label, which is what makes revoking it the same
    //    gesture as revoking a lost phone.
    //
    //    No endpoint id: a dormant device is nowhere, and writing an
    //    empty one would turn a silence into an assertion (usdoc's
    //    `device_entry` contract).
    let recovery_id = crate::ingest_contact_card(card_bytes).await?;
    let (user_group, enroll_card, us_partition) =
        usdoc::enroll_device(&recovery_id, label, &[]).await?;

    // 3. The K_p: the bootstrap object, with the device-list union fix
    //    (`crate::pickup_devices`). This is the ONE pickup that lets a
    //    cold restore start at all.
    Component::store_grant(us_partition.clone(), recovery_id.clone()).await?;

    let granting_device = crate::own_agent_id()?;
    let storage = usdoc::storage_get()
        .await?
        .as_ref()
        .map(StorageSnapshot::from_wit);

    // 6. SCRUB. `rkh` and the signer holding the seed are dropped here,
    //    at the end of this scope; the seed itself survives only inside
    //    `payload`, which the caller seals and drops. HONEST CLAIM, and
    //    it is the honest one because this is wasm: there is no
    //    `mlock`, no guarantee the allocator does not keep the pages,
    //    and no way to prove a copy was not made. Dropping is what the
    //    platform offers, so dropping is what is claimed.
    drop(rkh);

    Ok(Minted {
        recovery_id,
        payload: RecoveryPayload {
            signing_key_seed: seed,
            verifying: verifying.to_bytes(),
            keyhive_archive: archive_bytes,
            enroll_card,
            us_partition,
            user_group,
            granting_device,
            storage,
            // Filled by the kind's own arm below.
            kind: String::new(),
            object_name: String::new(),
        },
    })
}

/// Seal a payload into the `IdentityBundle` container under one keyslot.
///
/// The container and the keyslot machinery are G5's, verbatim; only the
/// AAD and the payload type differ (see `RECOVERY_AAD`).
async fn seal_bundle(
    label: &str,
    payload: &RecoveryPayload,
    slot: &Slot,
) -> Result<Vec<u8>, String> {
    let bundle_key: [u8; 32] = rand::random();
    let aead = aead_from_raw(&bundle_key).await?;
    let sealed = aead_seal(
        &aead,
        RECOVERY_AAD,
        &bincode::serialize(payload).map_err(|e| e.to_string())?,
    )
    .await?;

    let slot = match slot {
        Slot::Generated(kek) => {
            let slot_aead = aead_from_raw(kek).await?;
            BundleSlot::Secret {
                label: "recovery-phrase".into(),
                wrapped: aead_seal(&slot_aead, b"bundle-slot", &bundle_key).await?,
            }
        }
        Slot::Passphrase(pass) => {
            let salt: [u8; 16] = rand::random();
            let slot_key = argon2id_key(pass, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
            let slot_aead = aead_from_raw(&slot_key).await?;
            BundleSlot::Passphrase {
                salt,
                m_cost_kib: ARGON_M_KIB,
                t_cost: ARGON_T,
                p_cost: ARGON_P,
                wrapped: aead_seal(&slot_aead, b"bundle-slot", &bundle_key).await?,
            }
        }
    };

    bincode::serialize(&IdentityBundle {
        label: label.to_string(),
        created: crate::now_ms_u64() / 1000,
        slots: vec![slot],
        sealed,
    })
    .map_err(|e| e.to_string())
}

/// Open a recovery bundle with exactly the material the kind provides.
///
/// One slot, one key: unlike `identity-import`, which tries every slot
/// it has material for, a recovery bundle carries exactly one and the
/// caller knows which kind it holds. A miss is the SAME refusal either
/// way — "unlock failed" — because distinguishing "wrong passphrase"
/// from "wrong kind of bundle" tells an attacker which of the two they
/// got right.
async fn open_bundle(bundle: &[u8], slot: &Slot) -> Result<RecoveryPayload, String> {
    let bundle: IdentityBundle =
        bincode::deserialize(bundle).map_err(|e| format!("bad recovery bundle: {e}"))?;
    let mut bundle_key: Option<[u8; 32]> = None;
    for s in &bundle.slots {
        let opened = match (s, slot) {
            (BundleSlot::Secret { wrapped, .. }, Slot::Generated(kek)) => {
                let slot_aead = aead_from_raw(kek).await?;
                aead_open(&slot_aead, b"bundle-slot", wrapped).await.ok()
            }
            (
                BundleSlot::Passphrase {
                    salt,
                    m_cost_kib,
                    t_cost,
                    p_cost,
                    wrapped,
                },
                Slot::Passphrase(pass),
            ) => {
                let slot_key = argon2id_key(pass, salt, *m_cost_kib, *t_cost, *p_cost)?;
                let slot_aead = aead_from_raw(&slot_key).await?;
                aead_open(&slot_aead, b"bundle-slot", wrapped).await.ok()
            }
            _ => None,
        };
        if let Some(k) = opened {
            bundle_key = Some(arr32(&k, "bundle key")?);
            break;
        }
    }
    let bundle_key = bundle_key.ok_or("unlock failed: no keyslot opened")?;
    let aead = aead_from_raw(&bundle_key).await?;
    bincode::deserialize(&aead_open(&aead, RECOVERY_AAD, &bundle.sealed).await?)
        .map_err(|e| format!("recovery payload decode: {e}"))
}

/// Flush the account document, so the kit is valid THE MOMENT the
/// ceremony reports success (RECOVERY.md, kit ceremony step 6).
///
/// Not an optimization: a restore reads the account out of the bucket,
/// so an enrollment that lived only in this device's memory would
/// produce a kit whose device the account does not yet acknowledge
/// anywhere the restore can see. Every path here that MUTATES the
/// account document ends with this, for the same reason.
///
/// (The ongoing cadence is the worker's; see `crate::resolve_doc` for
/// how the us-doc became nameable at the bucket surface at all.)
async fn publish_account(us_partition: &[u8]) -> Result<(), String> {
    Component::bucket_flush(us_partition.to_vec()).await.map(|s| {
        eprintln!("[recovery] account flushed: {s}");
    })
}

/// `recovery-kit-create-bucket`: mint, seal under the phrase-derived
/// KEK, upload at the phrase-derived name, record, return the phrase.
pub(crate) async fn kit_create_bucket(label: String) -> Result<String, String> {
    // The provider refusal comes FIRST, before anything is minted: a kit
    // ceremony that enrolled a device and then discovered it could not
    // store the bundle would leave a member device nobody can restore.
    let st = s3_from_state()?;
    let phrase = generate_phrase();
    let (name, kek) = derive_bucket_kit(&phrase).await?;

    let mut minted = mint(&label).await?;
    minted.payload.kind = KIND_BUCKET.to_string();
    minted.payload.object_name = name.clone();
    let bytes = seal_bundle(&label, &minted.payload, &Slot::Generated(kek)).await?;

    // Owner tier: the account writes its own bucket. The object is
    // readable by name-secrecy alone, which is what a cold restore has
    // to work with — and is exactly why the slot may only ever hold a
    // GENERATED secret.
    put_object(&st, &EngineFetch, &EngineSigner, &name, bytes).await?;

    usdoc::recovery_put(&minted.recovery_id, KIND_BUCKET, &name, crate::now_ms_u64()).await?;
    publish_account(&minted.payload.us_partition).await?;
    Ok(phrase)
}

/// `recovery-kit-create-file`: mint, seal under the user's passphrase,
/// return the bytes. No object is stored, so this arm works on every
/// provider.
pub(crate) async fn kit_create_file(
    label: String,
    passphrase: String,
) -> Result<Vec<u8>, String> {
    if passphrase.is_empty() {
        return Err("a file kit needs a passphrase: it is the only thing wrapping it".into());
    }
    let mut minted = mint(&label).await?;
    minted.payload.kind = KIND_FILE.to_string();
    let bytes = seal_bundle(&label, &minted.payload, &Slot::Passphrase(passphrase)).await?;
    usdoc::recovery_put(&minted.recovery_id, KIND_FILE, "", crate::now_ms_u64()).await?;
    publish_account(&minted.payload.us_partition).await?;
    Ok(bytes)
}

// --- restore (RECOVERY.md, "Restore") ------------------------------------

/// The shared restore, for both kinds.
///
/// THE ORDERING IS THE DESIGN. Every step below either needs engine
/// state that the previous one created, or must happen before state
/// exists at all:
///
/// 1. FETCH (bucket kind) — before `finish_init`, through the
///    config-parameterized helpers, because finding the bundle needs the
///    destination and the destination is inside the account the bundle
///    unlocks.
/// 2. OPEN + CHECK — seed against verifying key, so a tampered bundle
///    fails here rather than as an unexplained signature error later.
/// 3. `try_from_archive` + `finish_init` — `identity-import`'s pattern,
///    with the recovery signer (the archive's own signer, which
///    `try_from_archive` requires).
/// 4. APPLY THE STORE CONFIG — as `init-store` does, now that there is
///    state to hold it.
/// 5. INGEST THE ENROLL CARD — the delegation that makes this device a
///    member, ahead of the pull that would also carry it.
/// 6. ADOPT the us partition, then `bucket-pull(us, granting-device,
///    none)`, which takes the PICKUP FORK because `account_sibling`
///    reads a still-empty local device directory and correctly answers
///    no. One pickup, and the account's state is in hand.
/// 7. RENAME this device's own entry to the ceremony's `device-name` —
///    the kit's label gives way to the user's word for the machine it
///    became.
///
/// The CONTENT fan-out over the pointer map is deliberately NOT here: it
/// is the worker's existing pull machinery, and duplicating it in the
/// guest would put a second, divergent copy of the account pull path in
/// the tree.
async fn restore(
    config: StoreConfig,
    payload: RecoveryPayload,
    device_name: String,
) -> Result<String, String> {
    // Consistency before trust: a seed that does not match its recorded
    // verifying key means a corrupt or forged bundle, and every later
    // failure would be a less legible version of this one.
    let sk = ed25519_dalek::SigningKey::from_bytes(&payload.signing_key_seed);
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&payload.verifying)
        .map_err(|e| format!("bad verifying key: {e:?}"))?;
    if sk.verifying_key() != verifying {
        return Err("recovery bundle inconsistent: seed does not match verifying key".into());
    }
    let signer = WebcryptoSigner(std::rc::Rc::new(SignerInner {
        key: IdentityKey::Soft(Box::new(sk)),
        verifying,
        sign_count: std::cell::Cell::new(0),
    }));

    let archive: keyhive_core::archive::Archive<T> =
        bincode::deserialize(&payload.keyhive_archive)
            .map_err(|e| format!("recovery archive decode: {e}"))?;
    #[allow(clippy::arc_with_non_send_sync)] // upstream API shape; single-threaded wasm
    let csprng = Arc::new(futures::lock::Mutex::new(rand::rngs::OsRng));
    let ciphertexts: KhStore = MemoryCiphertextStore::new();
    let kh = Kh::try_from_archive(
        &archive,
        signer.clone(),
        ciphertexts.clone(),
        NoListener,
        csprng,
    )
    .await
    .map_err(|e| format!("recovery archive restore: {e:?}"))?;
    let card = kh
        .contact_card()
        .await
        .map_err(|e| format!("contact card: {e:?}"))?;
    CARD.with(|c| *c.borrow_mut() = Some(card));
    crate::finish_init(signer, verifying, kh, ciphertexts)?;

    // The store, as `init-store` would apply it. Addressing only; the
    // credentials are the wired instances' and never rode the bundle.
    Component::init_store(config).await?;

    // The enroll card: belt and suspenders (the oplogs carry the same
    // events). A card that resolves nothing yet is not an error — this
    // instance holds no context — which is why the pending count is
    // logged rather than refused.
    let pending = crate::ingest_static_card(payload.enroll_card.clone()).await?;
    if pending > 0 {
        eprintln!("[recovery] enroll card: {pending} event(s) pending until the pull lands");
    }

    usdoc::adopt(&payload.us_partition, &payload.user_group).await?;

    // THE BOOTSTRAP PULL. `pickup` is `none`: S3 derives the K_p
    // location from the (doc, owner, member) triple and ignores it.
    let summary = Component::bucket_pull(
        payload.us_partition.clone(),
        payload.granting_device.clone(),
        None,
    )
    .await?;
    eprintln!("[recovery] us bootstrap: {summary}");

    // The devices entry exists (the ceremony's `enroll_device` wrote it
    // under the kit's label), so this is a rename, not a creation — and
    // `device_rename` refuses rather than creating one, for the same
    // reason `device_endpoint_put` does: two devices `put_object`-ing a
    // fresh entry under one key is an automerge conflict whose loser's
    // fields vanish.
    if !device_name.is_empty() {
        usdoc::device_rename(&crate::own_agent_id()?, &device_name).await?;
    }

    with_state(|s| {
        s.recovery = Some(RestoredKit {
            agent_id: s.my_peer.as_bytes().to_vec(),
            kind: payload.kind.clone(),
            object_name: payload.object_name.clone(),
            us_partition: payload.us_partition.clone(),
            granting_device: payload.granting_device.clone(),
        });
    })?;

    Ok(hex::encode(payload.verifying))
}

/// `recovery-restore-bucket`.
pub(crate) async fn restore_bucket(
    config: StoreConfig,
    phrase: String,
    device_name: String,
) -> Result<String, String> {
    if crate::STATE.with(|s| s.borrow().is_some()) {
        return Err("already initialized".into());
    }
    let st = s3_from_config(&config)?;
    let (name, kek) = derive_bucket_kit(&phrase).await?;
    // A WRONG PHRASE derives a different name and finds nothing. The
    // refusal is the same one a CONSUMED kit gets, and that is the
    // design rather than a coincidence: the kit's absence is the only
    // fact either case establishes.
    let bytes = get_object_unsigned(&st, &EngineFetch, &name)
        .await?
        .ok_or("no recovery kit at this name (wrong phrase, or the kit was already used)")?;
    let payload = open_bundle(&bytes, &Slot::Generated(kek)).await?;
    restore(config, payload, device_name).await
}

/// `recovery-restore-file`.
pub(crate) async fn restore_file(
    config: StoreConfig,
    bundle: Vec<u8>,
    passphrase: String,
    device_name: String,
) -> Result<String, String> {
    if crate::STATE.with(|s| s.borrow().is_some()) {
        return Err("already initialized".into());
    }
    // NO PROVIDER CHECK HERE, deliberately: a file kit stores no object,
    // so every provider the bucket surface supports can host the account
    // it restores. The destination is validated where it always is, by
    // `init-store` inside `restore`.
    let payload = open_bundle(&bundle, &Slot::Passphrase(passphrase)).await?;
    restore(config, payload, device_name).await
}

// --- consume (RECOVERY.md, "Single-use, consumed at restore") ------------

/// A delete that treats ABSENCE AS SUCCESS.
///
/// The idempotency contract engine.wit states for `recovery-consume`:
/// the embedder retries this on the flush cadence's backoff loop, so a
/// retry after partial success must not fail on an object the previous
/// attempt already removed. S3 answers a delete of a missing key with
/// 204 anyway; the 404 arm is for stores that do not.
async fn delete_gone_is_fine(st: &S3Cfg, name: &str) -> Result<(), String> {
    match delete_object(st, &EngineFetch, &EngineSigner, name).await {
        Ok(()) => Ok(()),
        Err(e) if e.contains(": 404") || e.contains(": 204") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Delete the restored device's OWN pickup object — the second half of
/// single-use, and the only thing enforcing it for a file kit (the file
/// itself is in the user's custody and cannot be deleted).
///
/// FORKED ON THE PROVIDER, exactly as `store_revoke`'s pickup deletion
/// is. This is not the same operation as `store_revoke`, though, and
/// consume must NOT call it: `store_revoke` rotates the name-key epoch
/// and strikes the agent from `grantees`, which is the semantics for
/// throwing a member out. A device consuming its OWN kit is not being
/// thrown out — it goes on being a full member, authoring under the
/// current epoch — so borrowing that path would rotate the account's
/// chain for nothing and mark the live device as a revoked grantee.
///
/// ABSENCE IS SUCCESS on every arm, which is the retry contract: S3 via
/// `delete_gone_is_fine`, Drive because `gd_delete` resolves the name
/// first and answers `Ok` when nothing is there (and accepts 404 for the
/// already-deleted race).
///
/// EXECUTABLE COVERAGE, honestly placed: this battery runs against MinIO
/// only, so the S3 arm below is the one `just recover` exercises. The
/// GDRIVE arm's executable coverage lands with T-B's devstore rows
/// against the fake-Drive harness — standing up a fake Drive inside the
/// native acts rig to cover it here would duplicate that harness for one
/// delete.
async fn delete_own_pickup(kit: &RestoredKit) -> Result<(), String> {
    match crate::provider()? {
        Provider::S3 => {
            let st = s3_from_state()?;
            let name = kp_location(&kit.us_partition, &kit.granting_device, &kit.agent_id).await?;
            delete_gone_is_fine(&st, &name).await
        }
        Provider::Gdrive => {
            let cfg = crate::gd()?;
            let folder = crate::gd_pickup_folder(&cfg).await?;
            let name =
                gd_pickup_name(&kit.us_partition, &kit.granting_device, &kit.agent_id).await?;
            gd_delete(&cfg, &EngineFetch, &folder, &name).await
        }
        // CONTRACT: RECOVERY.md says the K_p is deleted for BOTH kinds
        // and says nothing about providers. The Dropbox pickup DELETE
        // itself is one call (`dbx_delete` on `dbx_pickup_path`), but
        // the idempotency half is not mechanical: `dbx_delete` surfaces
        // `path/not_found` as an error, and teaching it absence-as-
        // success means editing `providers/dropbox/store`, outside this
        // track — and guessing at that error's exact shape without a
        // harness to check it against would be inventing the contract
        // rather than implementing it. Since a non-idempotent consume on
        // the embedder's backoff loop is a permanent retry spin, the
        // honest answer is to REFUSE BY NAME here. Nothing is lost that
        // was working: the worker's v1 providers are S3 and Drive, and a
        // Dropbox-bound account can still revoke the kit device from the
        // devices sheet, which is the same end state by the other lever.
        Provider::Dropbox => Err(
            "recovery-consume is not wired for Dropbox at this rev: its pickup delete has no \
             absence-as-success path, and a consume that cannot be retried would spin on the \
             flush backoff loop. Revoke the kit device from the devices sheet instead."
                .into(),
        ),
    }
}

/// `recovery-consume`.
pub(crate) async fn consume() -> Result<(), String> {
    let kit = with_state(|s| s.recovery.clone())?
        .ok_or("this instance did not restore from a recovery kit")?;

    // 1. The bundle object, for a bucket kit. S3 BY CONSTRUCTION and not
    //    by assumption: bucket kits refuse to mint on any other provider
    //    (`s3_from_config`), so a non-empty `object_name` can only have
    //    been written by the S3 arm. A file kit's is empty, which is why
    //    this reads the field rather than the provider.
    if kit.kind == KIND_BUCKET && !kit.object_name.is_empty() {
        delete_gone_is_fine(&s3_from_state()?, &kit.object_name).await?;
    }

    // 2. The pickup, whichever provider holds it. This is what makes a
    //    second restore refuse cleanly at the us bootstrap — a 404,
    //    never a fork.
    delete_own_pickup(&kit).await?;

    // 3. The account's record, and the flush that publishes it. The
    //    device ENTRY stays: the restored device is a real member and
    //    goes on being one — what is consumed is the kit, not the
    //    device it became.
    usdoc::recovery_clear(&kit.agent_id).await?;
    Component::bucket_flush(kit.us_partition.clone()).await?;
    Ok(())
}

// --- the kit registry ----------------------------------------------------

/// `recovery-kits`: a projection of the account's `recovery` map.
pub(crate) async fn kits() -> Result<Vec<RecoveryKit>, String> {
    Ok(usdoc::recovery_list()
        .await?
        .into_iter()
        .map(|(agent_id, row)| RecoveryKit {
            agent_id,
            kind: row.kind,
            created: row.created,
        })
        .collect())
}

/// `recovery-kit-revoke`: a leaked phrase or file is answered by
/// revoking the kit device, because it IS a device.
pub(crate) async fn kit_revoke(agent_id: Vec<u8>) -> Result<String, String> {
    let _ = arr32(&agent_id, "agent id")?;
    let us_partition = with_state(|s| s.us.doc.clone())?
        .ok_or("no account on this device (nothing to revoke a kit from)")?;
    let us_partition_for_flush = us_partition.clone();
    let row = usdoc::recovery_get(&agent_id)
        .await?
        .ok_or("no recovery kit recorded for this agent")?;

    // 1. Membership: the real revocation. Docs containing the user group
    //    drop CGKA leaves for individuals no longer reachable, and the
    //    devices entry is annotated for the sheet.
    usdoc::device_revoke(agent_id.clone()).await?;

    // 2. The bucket tier: K_p deleted (cooperative now) and the
    //    name-key epoch rotated (hard forward). The note this returns is
    //    the guarantee class the UI renders.
    let note = Component::store_revoke(us_partition, agent_id.clone()).await?;

    // 3. The bundle object, for a bucket kit. A file kit has none, and
    //    its bytes are in the user's custody — which is what the
    //    revocation above is the answer to.
    if row.kind == KIND_BUCKET && !row.name.is_empty() {
        delete_gone_is_fine(&s3_from_state()?, &row.name).await?;
    }

    // 4. The record. The kit is gone from the account's list; the
    //    revoked DEVICE stays in the devices sheet, as every revoked
    //    device does.
    usdoc::recovery_clear(&agent_id).await?;
    publish_account(&us_partition_for_flush).await?;
    Ok(note)
}
