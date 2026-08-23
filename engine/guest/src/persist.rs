//! State persistence into a mounted state root (#20 G5; the "Engine
//! contract additions" of runtime/PERSISTENCE.md).
//!
//! # Why `std::fs` and not hand-written `wasi:filesystem` bindings
//!
//! The `wasm32-wasip2` target's std already speaks `wasi:filesystem` — a
//! `std::fs` call site makes the component import
//! `wasi:filesystem/types@0.2.x` + `wasi:filesystem/preopens@0.2.x`
//! through wasi-libc, which is exactly the world addition the design
//! calls for and is observable in `wasm-tools component wit
//! target/composed.wasm`. Declaring the same interfaces in `engine.wit`
//! would generate a second, unused `wit_bindgen` surface for imports the
//! component already has. So the world gains the imports; it gains them
//! from the target, and the WIT stays the engine's own vocabulary.
//!
//! THE 0.2 LINE, deliberately. `@polyengine/wasi@0.3.1` serves BOTH the
//! `@0.2` and `@0.3` tracks from `filesystem-node` and `filesystem-web`
//! alike (their module headers say so), so either would be wired. 0.2 is
//! what std links, which buys: real `std::fs` on the native wasmtime host
//! with no extra host code, synchronous call sites (no async plumbing
//! through a checkpoint that wants to be stop-the-world anyway), and —
//! per `filesystem_node.ts`'s header — a node/Deno backend that is "sync
//! by construction", serving the 0.2 track with no parking at all. In the
//! browser the 0.2 track parks through JSPI, which this engine already
//! requires and has (spikes/worker-host README Q1/Q2).
//!
//! # The state root
//!
//! ONE preopened directory, mounted by the embedder at `/`. Absent
//! preopens (the `wasi()` batteries default — `filesystem.ts` returns
//! `get-directories -> []`) every operation here fails at the first
//! `std::fs` call, which is what makes fresh boot indistinguishable from
//! today: `resume` maps that to `Ok(false)` and `checkpoint` to a plain
//! "no state root" error.
//!
//! # Layout and the atomicity story
//!
//! ```text
//! /gen-<n>/MANIFEST      <- written LAST; magic + bincode + trailing digest
//! /gen-<n>/identity.bin
//! /gen-<n>/keyhive.bin
//! /gen-<n>/content.bin
//! /gen-<n>/tree-<hex>.bin
//! ```
//!
//! A checkpoint writes generation `n = highest + 1` into a fresh
//! directory and only then writes that generation's `MANIFEST`. Resume
//! scans generations HIGHEST-first and takes the first whose manifest
//! parses (magic, bincode, trailing digest) and whose every member file
//! matches the length and BLAKE3 digest the manifest records. A kill at
//! any instant therefore lands in one of three states, all of which
//! resume from a consistent snapshot: before the new generation's
//! MANIFEST exists (generation `n` is skipped, `n-1` is selected), during
//! the MANIFEST write (truncated → magic/digest check fails → `n-1`),
//! after it (generation `n` is selected, whole).
//!
//! NO RENAME IS RELIED ON. The obvious write-new-then-rename scheme is
//! unsound on the browser backend: `filesystem_web.ts`'s header records
//! that `rename-at` is EMULATED — `move()` where the engine ships it,
//! "copy+delete for files otherwise" — so a kill mid-rename can leave a
//! truncated manifest where the previous good one used to be. Versioned
//! generations plus a last-written manifest need no atomic primitive
//! beyond "a torn file is detectable", which the digest gives.
//!
//! Old generations are swept after a successful checkpoint, keeping the
//! newest two: a resume that is already reading generation `n-1` when
//! `n` lands must not have the floor pulled out from under it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use automerge::AutoCommit;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use keyhive_crypto::symmetric_key::SymmetricKey;
use sedimentree_core::{blob::Blob, id::SedimentreeId, loose_commit::LooseCommit};
use serde::{Deserialize, Serialize};
use subduction_core::storage::traits::Storage;
use subduction_crypto::signed::Signed;
use subduction_crypto::verified_meta::VerifiedMeta;

use crate::{
    finish_init, IdentityKey, KhStore, Kh, Partition, SignerInner, WebcryptoSigner, CARD,
    STATE,
};
use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use std::cell::Cell;
use std::rc::Rc;

/// The state root, as the guest sees it: the embedder's single preopen.
const ROOT: &str = "/";

const GEN_PREFIX: &str = "gen-";
const MANIFEST: &str = "MANIFEST";
const IDENTITY_FILE: &str = "identity.bin";
const KEYHIVE_FILE: &str = "keyhive.bin";
const CONTENT_FILE: &str = "content.bin";

/// Manifest magic + format version. A future layout change bumps this and
/// old generations simply stop validating, which is the right outcome:
/// a checkpoint this build cannot read is not a checkpoint.
const MAGIC: &[u8] = b"POLYVISOR-ENGINE-CHECKPOINT-1\n";

/// How many generations survive a sweep (see the module header).
const KEEP_GENERATIONS: usize = 2;

// --- the on-disk shapes ------------------------------------------------------

/// How the device's signing identity rests, per PERSISTENCE.md
/// "Posture". `Seed` round-trips through the checkpoint; `Platform`
/// round-trips through the `device-identity` import instead.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
enum Posture {
    /// The extractable in-guest key (`init(exportable-identity: true)`),
    /// the same material `identity-export`'s bundle carries.
    Seed,
    /// A non-extractable WebCrypto handle. The guest cannot see the
    /// private half, so nothing identity-shaped is written; resume takes
    /// the pair from the app-owned `device-identity` import and checks it
    /// against `Manifest::verifying` (engine.wit; PERSISTENCE.md "Engine
    /// contract additions").
    Platform,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    generation: u64,
    created_ms: u64,
    posture: Posture,
    /// The device's public identity, in the clear: it is a public key,
    /// and having it outside the sealed members makes "which device is
    /// this generation" answerable without opening anything. In
    /// `platform` posture it is ALSO the load-bearing check — the only
    /// record of which device this state belongs to, against which the
    /// `device-identity` import's handed pair is verified.
    verifying: [u8; 32],
    /// `(file name, byte length, BLAKE3)` for every member of this
    /// generation. Resume validates all of them before selecting it.
    files: Vec<(String, u64, [u8; 32])>,
}

#[derive(Serialize, Deserialize)]
struct IdentityState {
    /// Seed posture only. THE MOUNT IS THE SEALED BOUNDARY (engine.wit):
    /// this is plaintext private-key material and the embedder owes it an
    /// encrypted-at-rest directory.
    seed: [u8; 32],
    verifying: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct PartitionState {
    id: Vec<u8>,
    /// `AutoCommit::save()` — the full compressed automerge document.
    automerge: Vec<u8>,
    applied: Vec<[u8; 32]>,
    revision: u64,
    undecryptable: u32,
    decrypted: u32,
    walked: u32,
}

#[derive(Serialize, Deserialize)]
struct ContentState {
    partitions: Vec<PartitionState>,
    /// The partition the tasks service is bound to.
    active: Option<Vec<u8>>,
    /// The user-system doc + the user group every device of this user is
    /// in (usdoc.rs's `UsDoc`).
    us_doc: Option<Vec<u8>>,
    us_user_group: Option<Vec<u8>>,
    /// Provenances THIS device wrote — the repair rule keys off it, so
    /// dropping it would quietly change which device persists a repair.
    us_my_marks: Vec<String>,
    /// cref -> the symmetric key that chunk's envelope was sealed under.
    ///
    /// NOT optional. `encrypt_and_commit` refuses to author on a parent
    /// whose key it does not hold ("authoring on unmaterialized history
    /// would cut the causal chain"), and after a resume EVERY parent is
    /// inherited history — so a checkpoint without these resumes into a
    /// device that can read but never write again.
    chunk_keys: Vec<([u8; 32], SymmetricKey)>,
}

/// One sedimentree's commits, as stored.
///
/// `(Signed<LooseCommit>` wire bytes, blob bytes)`. The SIGNATURE IS
/// PRESERVED: `Signed::as_bytes()` / `Signed::try_decode()` round-trip
/// the original attestation, and restore goes through
/// `VerifiedMeta::try_from_trusted` (subduction_crypto/src/verified_meta.rs:160
/// — "for data loaded from trusted storage that was previously
/// verified"). Re-adding the commits through `Subduction::add_commit`
/// would have been shorter and WRONG: that seals a fresh signature with
/// OUR signer (subduction_core/src/subduction.rs:1302), rewriting every
/// peer's attestation as our own.
#[derive(Serialize, Deserialize)]
struct TreeState {
    tree: [u8; 32],
    commits: Vec<(Vec<u8>, Vec<u8>)>,
}

// --- filesystem helpers ------------------------------------------------------

/// Map an io error to the engine's `result<_, string>` error side.
///
/// The one case that is NOT an error is "the state root is not mounted",
/// which callers classify themselves (`resume` -> `Ok(false)`).
fn io(what: &str, e: std::io::Error) -> String {
    format!("state root: {what}: {e}")
}

fn gen_dir(n: u64) -> String {
    format!("{ROOT}{GEN_PREFIX}{n}")
}

/// Every generation number present under the state root, DESCENDING.
///
/// A state root that cannot be listed at all is reported as such; the
/// caller decides whether that means "fresh boot" or "fault".
fn generations() -> Result<Vec<u64>, std::io::Error> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(ROOT)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(n) = name.strip_prefix(GEN_PREFIX) else {
            continue;
        };
        if let Ok(n) = n.parse::<u64>() {
            out.push(n);
        }
    }
    out.sort_unstable_by(|a, b| b.cmp(a));
    Ok(out)
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    *blake3::hash(bytes).as_bytes()
}

/// Encode a manifest: magic, payload, trailing digest OF THE PAYLOAD.
///
/// The digest is what makes a torn write detectable without an atomic
/// rename — a truncated file loses its tail, and a file truncated
/// exactly at the payload boundary loses the digest entirely.
fn encode_manifest(m: &Manifest) -> Result<Vec<u8>, String> {
    let payload = bincode::serialize(m).map_err(|e| format!("manifest encode: {e}"))?;
    let mut out = Vec::with_capacity(MAGIC.len() + payload.len() + 32);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&payload);
    out.extend_from_slice(&digest(&payload));
    Ok(out)
}

/// Decode a manifest, or `None` if it is torn, truncated, or foreign.
///
/// Never an error: an unreadable manifest means "this generation does not
/// count", and the next one down is tried.
fn decode_manifest(bytes: &[u8]) -> Option<Manifest> {
    let rest = bytes.strip_prefix(MAGIC)?;
    if rest.len() < 32 {
        return None;
    }
    let (payload, want) = rest.split_at(rest.len() - 32);
    if digest(payload) != want {
        return None;
    }
    bincode::deserialize(payload).ok()
}

/// Read a generation's member file, checking it against the manifest.
fn read_member(n: u64, name: &str, m: &Manifest) -> Option<Vec<u8>> {
    let (_, want_len, want_digest) = m.files.iter().find(|(f, _, _)| f == name)?;
    let bytes = std::fs::read(format!("{}/{name}", gen_dir(n))).ok()?;
    if bytes.len() as u64 != *want_len || digest(&bytes) != *want_digest {
        return None;
    }
    Some(bytes)
}

/// A generation is usable when its manifest decodes AND every file the
/// manifest names is present at the recorded length and digest.
fn validate(n: u64) -> Option<Manifest> {
    let raw = std::fs::read(format!("{}/{MANIFEST}", gen_dir(n))).ok()?;
    let m = decode_manifest(&raw)?;
    for (name, want_len, want_digest) in &m.files {
        let bytes = std::fs::read(format!("{}/{name}", gen_dir(n))).ok()?;
        if bytes.len() as u64 != *want_len || digest(&bytes) != *want_digest {
            return None;
        }
    }
    Some(m)
}

// --- checkpoint --------------------------------------------------------------

/// Collect the engine's whole persistable state and write it as a new
/// generation. See the module header for the atomicity argument.
pub(crate) async fn checkpoint() -> Result<(), String> {
    // Probing the root first turns "no preopen" into one clear message
    // rather than a confusing failure partway through a write.
    let existing = generations().map_err(|e| {
        format!(
            "no state root mounted (the embedder must preopen one directory \
             at `{ROOT}`; `wasi()`'s batteries filesystem has no preopens): {e}"
        )
    })?;
    let n = existing.first().map_or(1, |hi| hi + 1);
    let dir = gen_dir(n);
    std::fs::create_dir_all(&dir).map_err(|e| io(&format!("create {dir}"), e))?;

    let mut files: Vec<(String, u64, [u8; 32])> = Vec::new();
    let mut write = |name: &str, bytes: &[u8]| -> Result<(), String> {
        std::fs::write(format!("{dir}/{name}"), bytes)
            .map_err(|e| io(&format!("write {name}"), e))?;
        files.push((name.to_string(), bytes.len() as u64, digest(bytes)));
        Ok(())
    };

    // --- identity ---
    let (signer, verifying) = crate::with_state(|s| (s.signer.clone(), s.signer.0.verifying))?;
    let posture = match &signer.0.key {
        IdentityKey::Soft(sk) => {
            let state = IdentityState {
                seed: sk.to_bytes(),
                verifying: verifying.to_bytes(),
            };
            write(
                IDENTITY_FILE,
                &bincode::serialize(&state).map_err(|e| format!("identity encode: {e}"))?,
            )?;
            Posture::Seed
        }
        // CONTRACT: engine.wit's `state-checkpoint` — "In `platform`
        // posture the snapshot is written WITHOUT identity material".
        // The manifest's `verifying` is all that records WHICH device
        // this is; resume gets the key itself from the `device-identity`
        // import and checks it against that.
        IdentityKey::Platform(_) => Posture::Platform,
    };

    // --- keyhive archive ---
    let kh = crate::with_state(|s| s.kh.clone())?;
    let archive = kh.into_archive().await;
    write(
        KEYHIVE_FILE,
        &bincode::serialize(&archive).map_err(|e| format!("archive encode: {e}"))?,
    )?;

    // --- the sedimentree chunk store, one file per tree ---
    let storage = crate::with_state(|s| s.sd_storage.clone())?;
    let ids: Vec<SedimentreeId> = Storage::<future_form::Local>::load_all_sedimentree_ids(&storage)
        .await
        .map_err(|e| format!("list sedimentrees: {e}"))?
        .into_iter()
        .collect();
    for id in ids {
        let loaded = Storage::<future_form::Local>::load_loose_commits(&storage, id)
            .await
            .map_err(|e| format!("load commits: {e}"))?;
        let commits = loaded
            .into_iter()
            .map(|v| {
                let (signed, _payload, blob) = v.into_full_parts();
                (signed.as_bytes().to_vec(), blob.as_slice().to_vec())
            })
            .collect();
        let state = TreeState {
            tree: *id.as_bytes(),
            commits,
        };
        write(
            &format!("tree-{}.bin", hex::encode(id.as_bytes())),
            &bincode::serialize(&state).map_err(|e| format!("tree encode: {e}"))?,
        )?;
    }

    // --- automerge replicas, bindings, chunk keys ---
    let content = crate::with_state(|s| {
        let partitions = s
            .partitions
            .iter_mut()
            .map(|(id, p)| PartitionState {
                id: id.clone(),
                automerge: p.am.save(),
                applied: p.applied.iter().copied().collect(),
                revision: p.revision,
                undecryptable: p.undecryptable,
                decrypted: p.decrypted,
                walked: p.walked,
            })
            .collect();
        ContentState {
            partitions,
            active: s.active.clone(),
            us_doc: s.us.doc.clone(),
            us_user_group: s.us.user_group.clone(),
            us_my_marks: crate::usdoc::my_marks(&s.us),
            chunk_keys: s.chunk_keys.iter().map(|(k, v)| (*k, *v)).collect(),
        }
    })?;
    write(
        CONTENT_FILE,
        &bincode::serialize(&content).map_err(|e| format!("content encode: {e}"))?,
    )?;

    // --- the manifest, LAST: this is the commit point ---
    let manifest = Manifest {
        generation: n,
        created_ms: crate::now_ms_u64(),
        posture,
        verifying: verifying.to_bytes(),
        files,
    };
    std::fs::write(format!("{dir}/{MANIFEST}"), encode_manifest(&manifest)?)
        .map_err(|e| io("write MANIFEST", e))?;

    // Sweep, best effort and strictly AFTER the commit point: a failure
    // here leaves extra generations, which costs space and nothing else.
    for old in existing.into_iter().skip(KEEP_GENERATIONS - 1) {
        let _ = std::fs::remove_dir_all(gen_dir(old));
    }
    Ok(())
}

// --- resume ------------------------------------------------------------------

/// Rebuild this instance from the newest valid generation.
///
/// `Ok(false)` means "no state to resume" and is NOT a fault: an absent
/// state root, an empty one, or one holding only torn generations all
/// land here, and the embedder answers by calling `init`. PERSISTENCE.md's
/// degrade rule is the same shape — a pointer to a swept namespace "is a
/// fresh device, silently — never an error".
pub(crate) async fn resume() -> Result<bool, String> {
    if STATE.with(|s| s.borrow().is_some()) {
        return Err("already initialized (state-resume replaces init, not follows it)".into());
    }
    // No preopen at all is the fresh-boot default, not a fault.
    let Ok(gens) = generations() else {
        return Ok(false);
    };
    let Some((n, manifest)) = gens.into_iter().find_map(|n| validate(n).map(|m| (n, m))) else {
        return Ok(false);
    };

    // THE POSTURE FORK. `seed` restores the identity from the persisted
    // material below; `platform` never wrote any, so its identity arrives
    // from OUTSIDE the checkpoint — the app-owned `device-identity` import
    // (engine.wit; runtime/PERSISTENCE.md "Engine contract additions",
    // the webcrypto#391 ruling).
    let signer = if manifest.posture == Posture::Platform {
        let Some((key, verifying)) = crate::embedder_device_key().await? else {
            // NOT `Ok(false)`: answering "nothing here" would send the
            // embedder to `init`, which mints a NEW identity, and the
            // device would silently lose every membership it held.
            return Err(format!(
                "checkpoint generation {n} rests in `platform` posture, but this \
                 embedding granted no device identity: the `device-identity` \
                 import answered `none`. The device key is a non-extractable \
                 handle the checkpoint could not contain — the embedder must \
                 hand back the one it persisted (PERSISTENCE.md \"Engine \
                 contract additions\")."
            ));
        };
        // CORRUPT-STATE / WRONG-DEVICE DETECTION, not trust. The archive's
        // delegations only verify under the right key anyway, so a wrong
        // key fails later and far less legibly; catching it here names
        // both ids instead. `manifest.verifying` IS the recorded agent id
        // (checkpoint writes it in the clear — it is a public key).
        if manifest.verifying != verifying.to_bytes() {
            return Err(format!(
                "device-identity mismatch: checkpoint generation {n} belongs to \
                 agent {}…, the embedder handed agent {}… — a corrupt state root, \
                 or another device's namespace",
                &hex::encode(manifest.verifying)[..8],
                &hex::encode(verifying.to_bytes())[..8],
            ));
        }
        WebcryptoSigner(Rc::new(SignerInner {
            key,
            verifying,
            sign_count: Cell::new(0),
        }))
    } else {
        let identity: IdentityState = bincode::deserialize(
            &read_member(n, IDENTITY_FILE, &manifest)
                .ok_or("checkpoint validated but identity member vanished")?,
        )
        .map_err(|e| format!("identity decode: {e}"))?;

        let sk = ed25519_dalek::SigningKey::from_bytes(&identity.seed);
        let verifying = DalekVerifyingKey::from_bytes(&identity.verifying)
            .map_err(|e| format!("bad verifying key: {e:?}"))?;
        if sk.verifying_key() != verifying {
            return Err("checkpoint inconsistent: seed does not match verifying key".into());
        }
        if manifest.verifying != identity.verifying {
            return Err("checkpoint inconsistent: manifest and identity disagree".into());
        }
        WebcryptoSigner(Rc::new(SignerInner {
            key: IdentityKey::Soft(Box::new(sk)),
            verifying,
            sign_count: Cell::new(0),
        }))
    };
    let verifying = signer.0.verifying;

    let archive: keyhive_core::archive::Archive<crate::T> = bincode::deserialize(
        &read_member(n, KEYHIVE_FILE, &manifest)
            .ok_or("checkpoint validated but keyhive member vanished")?,
    )
    .map_err(|e| format!("archive decode: {e}"))?;

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
    .map_err(|e| format!("archive restore: {e:?}"))?;

    let card = kh
        .contact_card()
        .await
        .map_err(|e| format!("contact card: {e:?}"))?;
    CARD.with(|c| *c.borrow_mut() = Some(card));
    finish_init(signer, verifying, kh, ciphertexts)?;

    // --- the sedimentree chunk store ---
    //
    // Restored into the FRESH `MemoryStorage` `finish_init` just built,
    // before anything touches a tree. Subduction hydrates its in-memory
    // sedimentrees lazily from storage (`get_or_hydrate`,
    // subduction_core/src/subduction.rs:1074), so writing underneath it
    // now is seen; writing after a tree had been accessed would not be.
    let storage = crate::with_state(|s| s.sd_storage.clone())?;
    for (name, _, _) in &manifest.files {
        if !name.starts_with("tree-") {
            continue;
        }
        let bytes = read_member(n, name, &manifest)
            .ok_or_else(|| format!("checkpoint validated but {name} vanished"))?;
        let tree: TreeState =
            bincode::deserialize(&bytes).map_err(|e| format!("tree decode: {e}"))?;
        let id = SedimentreeId::from_bytes(tree.tree);
        Storage::<future_form::Local>::save_sedimentree_id(&storage, id)
            .await
            .map_err(|e| format!("restore tree id: {e}"))?;
        for (signed_bytes, blob_bytes) in tree.commits {
            let signed: Signed<LooseCommit> = Signed::try_decode(&signed_bytes)
                .map_err(|e| format!("commit decode: {e:?}"))?;
            let verified = VerifiedMeta::try_from_trusted(signed, Blob::new(blob_bytes))
                .map_err(|e| format!("commit rehydrate: {e:?}"))?;
            Storage::<future_form::Local>::save_loose_commit(&storage, id, verified)
                .await
                .map_err(|e| format!("restore commit: {e}"))?;
        }
    }

    // --- automerge replicas, bindings, chunk keys ---
    let content: ContentState = bincode::deserialize(
        &read_member(n, CONTENT_FILE, &manifest)
            .ok_or("checkpoint validated but content member vanished")?,
    )
    .map_err(|e| format!("content decode: {e}"))?;

    let mut partitions: HashMap<Vec<u8>, Partition> = HashMap::new();
    for p in content.partitions {
        let am = AutoCommit::load(&p.automerge)
            .map_err(|e| format!("automerge load ({}): {e}", hex::encode(&p.id)))?;
        partitions.insert(
            p.id,
            Partition {
                am,
                applied: p.applied.into_iter().collect::<HashSet<_>>(),
                revision: p.revision,
                undecryptable: p.undecryptable,
                decrypted: p.decrypted,
                walked: p.walked,
            },
        );
    }
    let has_us = content.us_doc.is_some();
    crate::with_state(|s| {
        s.partitions = partitions;
        s.active = content.active;
        s.chunk_keys = content.chunk_keys.into_iter().collect();
        s.us.doc = content.us_doc;
        s.us.user_group = content.us_user_group;
        crate::usdoc::set_my_marks(&mut s.us, content.us_my_marks);
    })?;

    // RESUME IS NOT A JOIN. `UsDoc::last` is the baseline `us-events`
    // diffs against, and leaving it `None` would make the first drain
    // announce every profile, mark and device this device has known for
    // ages as a fresh remote change (usdoc.rs's `pump`: `unwrap_or_default`
    // on a missing baseline). A joining device wants exactly that (#22:
    // announced, never silently adopted); a resuming one already
    // announced them before it died, so it baselines from what it just
    // restored and reports only what happened WHILE IT WAS GONE.
    if has_us {
        crate::usdoc::set_baseline()?;
    }

    // Deliberately left empty (see engine.wit): `pending` — a partition
    // created but never sealed was never committed; `store`/`buckets` —
    // embedder-supplied addressing, re-applied by the embedder; and every
    // wire handle, because a resumed device has no live connections.
    Ok(true)
}
