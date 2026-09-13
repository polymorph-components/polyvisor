//! Small device checkpoints and the incremental engine journal. One KV
//! pointer commits both, so identity adoption cannot expose half old and half
//! new state.
//!
//! Layout, under the device's namespace `/<id>/`:
//!
//! ```text
//! /<id>/gen-<n>/state      nonce || AES-256-GCM(DEK, aad = <id>) over JSON
//! /<id>/gen-<n>/MANIFEST   { generation: n, sha256: hex(state bytes) }
//! /<id>/engine/<n>         sealed bincode EngineDelta
//! kv  dev/<id>/gen         { generation, engine_head } — the commit point
//! ```
//!
//! **The kernel never lists a directory** (internal.wit `world runtime`):
//! `read-directory` is one of the four stream-returning `wasi:filesystem@0.3`
//! functions that stayed sync in WIT, and the OPFS host answers it with a
//! Promise, which is a JSPI trap. So every path is named, and the name comes
//! from the pointer in `kv`.
//!
//! Write order is state, MANIFEST, pointer — each a commit for the one
//! after it:
//!
//! - a write that *reports* failure stops the whole checkpoint before the
//!   pointer moves, and the caller is told; the pointer advancing over a
//!   state file that never landed would hand the next boot a generation that
//!   does not verify while an intact older one was thrown away;
//! - a crash before the MANIFEST leaves `gen-<n>` incomplete and the pointer
//!   at `n-1`, which is what loads;
//! - a crash after the MANIFEST but before the pointer leaves a complete but
//!   unpointed `gen-<n>`, and the pointer still at `n-1`, which is what
//!   loads — the next write is `(n-1) + 1 = n` again and overwrites it;
//! - only after the pointer advances are older generations removed, so there
//!   is always one intact pointed generation on disk.
//!
//! A pointed generation or journal record that does not verify is storage
//! loss. Falling back would silently discard a mutation already acknowledged
//! as durable. Cleanup still reaches back two to collect files left by older
//! versions of this experimental format.

use data_encoding::HEXLOWER;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::Device;
use crate::seal::Dek;
use crate::{Error, ErrorCode, Files, Platform, Rng};

/// Everything a reload must restore. Sessions are deliberately absent: a
/// reload tears every frame down, so a restored session id would name a
/// session no frame is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub device: Device,
    /// The device's Ed25519 seed. Sealed like everything else here: it is the
    /// whole of the device's identity to its peers, and to iroh.
    pub seed: [u8; 32],
    /// The durable store's binding: the sealed OAuth tokens and how the last
    /// sync went (`crate::drive`). Sealed like everything else here, which is
    /// the whole reason a bearer never crosses the port.
    pub storage: Option<crate::drive::Sealed>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pointer {
    pub generation: u64,
    pub engine_head: u64,
}

pub struct Write<'a> {
    pub files: &'a dyn Files,
    pub platform: &'a dyn Platform,
    pub rng: &'a dyn Rng,
    pub dek: &'a Dek,
    pub id: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestJson {
    generation: u64,
    /// Lowercase hex sha256 of the `state` file's bytes exactly as written.
    sha256: String,
}

pub fn namespace(id: &str) -> String {
    format!("/{id}")
}

fn gen_dir(id: &str, generation: u64) -> String {
    format!("/{id}/gen-{generation}")
}

/// The kv key holding the current complete generation.
pub fn pointer_key(id: &str) -> String {
    format!("{}gen", crate::store::dev_prefix(id))
}

/// The pointed generation, or 0 for a device that has never checkpointed. An
/// unreadable pointer reads as 0: the alternative is refusing to boot over a
/// value nothing else can interpret, and 0 loses at most the last write.
pub async fn pointer(platform: &dyn Platform, id: &str) -> Result<Option<Pointer>, Error> {
    let Some(bytes) = platform.get(pointer_key(id)).await else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| Error::new(ErrorCode::Failed, "this device's commit pointer is invalid"))
}

/// Read the pointed generation, falling back to its predecessor once.
/// Returns the pointer alongside, because the next write is `pointer + 1`
/// whether or not the pointed generation verified.
pub async fn load(
    files: &dyn Files,
    platform: &dyn Platform,
    dek: &Dek,
    id: &str,
) -> Result<
    (
        Pointer,
        Option<Snapshot>,
        Option<polyvisor_engine::Snapshot>,
    ),
    Error,
> {
    let pointer = pointer(platform, id).await?.unwrap_or_default();
    let snapshot = if pointer.generation == 0 {
        None
    } else {
        read_generation(files, dek, id, pointer.generation).await
    };
    if pointer.generation != 0 && snapshot.is_none() {
        return Err(Error::new(
            ErrorCode::Failed,
            "this device's committed state did not open",
        ));
    }
    let mut journal = polyvisor_engine::JournalState::default();
    for sequence in 1..=pointer.engine_head {
        let path = journal_path(id, sequence);
        let sealed = files.read(path).await.ok_or_else(|| {
            Error::new(
                ErrorCode::Failed,
                "this device's committed history is missing",
            )
        })?;
        let plain = dek.open(&sealed, &journal_aad(id, sequence)).map_err(|_| {
            Error::new(
                ErrorCode::Failed,
                "this device's committed history did not open",
            )
        })?;
        let delta = bincode::deserialize(&plain).map_err(|_| {
            Error::new(
                ErrorCode::Failed,
                "this device's committed history is invalid",
            )
        })?;
        journal.apply(delta);
    }
    Ok((pointer, snapshot, journal.snapshot()))
}

/// Write generation `generation` — state, then MANIFEST, then the pointer —
/// and drop the one it replaces. The caller owns the counter (it is
/// `pointer + 1`), and there is only ever one writer: the device's own
/// worker, holding the device's Web Lock.
pub async fn write(
    io: Write<'_>,
    generation: u64,
    engine_head: u64,
    snapshot: &Snapshot,
) -> Result<(), Error> {
    let Write {
        files,
        platform,
        rng,
        dek,
        id,
    } = io;
    let plain = serde_json::to_vec(snapshot).map_err(|e| {
        Error::new(
            ErrorCode::Failed,
            format!("the kernel state could not be written: {e}"),
        )
    })?;
    let state = dek.seal(rng, &plain, id.as_bytes())?;
    let manifest = serde_json::to_vec(&ManifestJson {
        generation,
        sha256: HEXLOWER.encode(&Sha256::digest(&state)),
    })
    .map_err(|e| {
        Error::new(
            ErrorCode::Failed,
            format!("the checkpoint manifest could not be written: {e}"),
        )
    })?;

    let dir = gen_dir(id, generation);
    // Either file failing means this generation is not whole. Stop before the
    // pointer and before any cleanup: the previous generation is still
    // pointed, still on disk, and still what the next boot reads.
    let wrote = files.write(format!("{dir}/state"), state).await.is_ok()
        && files
            .write(format!("{dir}/MANIFEST"), manifest)
            .await
            .is_ok();
    if !wrote {
        return Err(Error::new(
            ErrorCode::Failed,
            "this device's state could not be written",
        ));
    }

    // The commit. Nothing before this line is visible to a later boot.
    platform
        .set(
            pointer_key(id),
            serde_json::to_vec(&Pointer {
                generation,
                engine_head,
            })
            .expect("pointer serializes"),
        )
        .await;

    // Two back, not one: see the module docs on fallback loads. Both may be
    // absent, and removal is best effort.
    for old in [generation.saturating_sub(1), generation.saturating_sub(2)] {
        if old > 0 {
            remove_generation(files, id, old).await;
        }
    }
    Ok(())
}

/// Everything the kernel ever put under `/<id>/`, removed by name: the two
/// generations that can exist, then the namespace directory itself.
///
/// The window is `pointer + 1` through `pointer - 2`, and it has to be:
/// `pointer + 1` because a crash between a MANIFEST and its pointer leaves a
/// complete-but-unpointed generation, and `pointer - 2` because a fallback
/// load defers cleanup by one (see the module docs). Anything left behind
/// would keep `/<id>` non-empty and therefore unremovable, leaking the whole
/// namespace.
pub async fn destroy(files: &dyn Files, id: &str, pointer: Pointer) {
    destroy_engine(files, id, pointer.engine_head).await;
    for back in 0..=3 {
        let generation = (pointer.generation + 1).saturating_sub(back);
        if generation > 0 {
            remove_generation(files, id, generation).await;
        }
    }
    files.remove_dir(namespace(id)).await;
}

pub async fn write_engine(
    files: &dyn Files,
    rng: &dyn Rng,
    dek: &Dek,
    id: &str,
    sequence: u64,
    delta: &polyvisor_engine::EngineDelta,
) -> Result<(), Error> {
    let plain = bincode::serialize(delta).map_err(|e| {
        Error::new(
            ErrorCode::Failed,
            format!("engine history could not be written: {e}"),
        )
    })?;
    let sealed = dek.seal(rng, &plain, &journal_aad(id, sequence))?;
    files
        .write(journal_path(id, sequence), sealed)
        .await
        .map_err(|_| {
            Error::new(
                ErrorCode::Failed,
                "this device's history could not be written",
            )
        })
}

pub async fn commit_pointer(platform: &dyn Platform, id: &str, pointer: Pointer) {
    platform
        .set(
            pointer_key(id),
            serde_json::to_vec(&pointer).expect("pointer serializes"),
        )
        .await;
}

pub async fn destroy_engine(files: &dyn Files, id: &str, head: u64) {
    for sequence in 1..=head.saturating_add(1) {
        files.remove_file(journal_path(id, sequence)).await;
    }
    files.remove_dir(format!("/{id}/engine")).await;
}

fn journal_path(id: &str, sequence: u64) -> String {
    format!("/{id}/engine/{sequence}")
}

fn journal_aad(id: &str, sequence: u64) -> Vec<u8> {
    let mut aad = b"polyvisor:engine-journal:v1\0".to_vec();
    aad.extend_from_slice(id.as_bytes());
    aad.extend_from_slice(&sequence.to_le_bytes());
    aad
}

async fn remove_generation(files: &dyn Files, id: &str, generation: u64) {
    let dir = gen_dir(id, generation);
    files.remove_file(format!("{dir}/MANIFEST")).await;
    files.remove_file(format!("{dir}/state")).await;
    files.remove_dir(dir).await;
}

/// `None` for any generation that is not complete and readable. The
/// distinction between "torn" and "not ours" does not exist at this layer:
/// either the digest and the key agree or the generation is skipped.
async fn read_generation(
    files: &dyn Files,
    dek: &Dek,
    id: &str,
    generation: u64,
) -> Option<Snapshot> {
    let dir = gen_dir(id, generation);
    let manifest = files.read(format!("{dir}/MANIFEST")).await?;
    let manifest: ManifestJson = serde_json::from_slice(&manifest).ok()?;
    if manifest.generation != generation {
        return None;
    }
    let state = files.read(format!("{dir}/state")).await?;
    if HEXLOWER.encode(&Sha256::digest(&state)) != manifest.sha256 {
        return None;
    }
    let plain = dek.open(&state, id.as_bytes()).ok()?;
    serde_json::from_slice(&plain).ok()
}

impl Snapshot {
    pub fn new(device: Device, seed: [u8; 32], storage: Option<crate::drive::Sealed>) -> Snapshot {
        Snapshot {
            device,
            seed,
            storage,
        }
    }
}
