//! Checkpoints: the kernel's serializable state, sealed under the device's
//! DEK and written to the state root after every successful mutation
//! (docs/design.md "Devices": "Generation directories, manifest written
//! last").
//!
//! Layout, under the device's namespace `/<id>/`:
//!
//! ```text
//! /<id>/gen-<n>/state      nonce || AES-256-GCM(DEK, aad = <id>) over JSON
//! /<id>/gen-<n>/MANIFEST   { v, generation: n, sha256: hex(state bytes) }
//! kv  dev/<id>/gen         n — the pointer, and the commit point
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
//! The loader tries the pointed generation and, if it does not verify, `n-1`
//! once. Cleanup therefore reaches back two: after a fallback load the next
//! write is `n + 1` while the torn `n` and the loaded `n - 1` are both still
//! on disk, and only removing both collects them.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::{Device, SCHEMA};
use crate::seal::Dek;
use crate::{Error, ErrorCode, Files, Platform, Rng};

/// Everything a reload must restore. Sessions are deliberately absent: a
/// reload tears every frame down, so a restored session id would name a
/// session no frame is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    v: u32,
    pub device: Device,
    /// The device's Ed25519 seed. Sealed like everything else here: it is the
    /// whole of the device's identity to its peers, and to iroh.
    pub seed: [u8; 32],
    /// The sync engine's state: an automerge document and its sedimentree
    /// items per app. `None` for a device that has not run an engine yet —
    /// the anchor written at mint, before the engine is built.
    pub engine: Option<polyvisor_engine::Snapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestJson {
    v: u32,
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
pub async fn pointer(platform: &dyn Platform, id: &str) -> u64 {
    platform
        .get(pointer_key(id))
        .await
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

/// Read the pointed generation, falling back to its predecessor once.
/// Returns the pointer alongside, because the next write is `pointer + 1`
/// whether or not the pointed generation verified.
pub async fn load(
    files: &dyn Files,
    platform: &dyn Platform,
    dek: &Dek,
    id: &str,
) -> Result<(u64, Option<Snapshot>), Error> {
    let pointer = pointer(platform, id).await;
    for generation in [pointer, pointer.saturating_sub(1)] {
        if generation == 0 {
            continue;
        }
        if let Some(snapshot) = read_generation(files, dek, id, generation).await {
            return Ok((pointer, Some(snapshot)));
        }
    }
    Ok((pointer, None))
}

/// Write generation `generation` — state, then MANIFEST, then the pointer —
/// and drop the one it replaces. The caller owns the counter (it is
/// `pointer + 1`), and there is only ever one writer: the device's own
/// worker, holding the device's Web Lock.
pub async fn write(
    files: &dyn Files,
    platform: &dyn Platform,
    rng: &dyn Rng,
    dek: &Dek,
    id: &str,
    generation: u64,
    snapshot: &Snapshot,
) -> Result<(), Error> {
    let plain = serde_json::to_vec(snapshot).map_err(|e| {
        Error::new(
            ErrorCode::Failed,
            format!("the kernel state could not be written: {e}"),
        )
    })?;
    let state = dek.seal(rng, &plain, id.as_bytes())?;
    let manifest = serde_json::to_vec(&ManifestJson {
        v: SCHEMA,
        generation,
        sha256: hex(&Sha256::digest(&state)),
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
        .set(pointer_key(id), generation.to_string().into_bytes())
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
pub async fn destroy(files: &dyn Files, id: &str, pointer: u64) {
    for back in 0..=3 {
        let generation = (pointer + 1).saturating_sub(back);
        if generation > 0 {
            remove_generation(files, id, generation).await;
        }
    }
    files.remove_dir(namespace(id)).await;
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
    if manifest.v != SCHEMA || manifest.generation != generation {
        return None;
    }
    let state = files.read(format!("{dir}/state")).await?;
    if hex(&Sha256::digest(&state)) != manifest.sha256 {
        return None;
    }
    let plain = dek.open(&state, id.as_bytes()).ok()?;
    let snapshot: Snapshot = serde_json::from_slice(&plain).ok()?;
    (snapshot.v == SCHEMA).then_some(snapshot)
}

impl Snapshot {
    pub fn new(
        device: Device,
        seed: [u8; 32],
        engine: Option<polyvisor_engine::Snapshot>,
    ) -> Snapshot {
        Snapshot {
            v: SCHEMA,
            device,
            seed,
            engine,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
