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
//! ```
//!
//! MANIFEST is written **last** and is the completeness marker: a generation
//! whose MANIFEST is missing, unreadable, disagrees about the generation
//! number, or does not match the digest of `state` is a torn write, and the
//! loader falls back to the highest generation that is complete. Older
//! generations are removed only after a newer one is complete, so there is
//! always one intact generation on disk.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::device::{Device, SCHEMA};
use crate::seal::Dek;
use crate::tasks::TaskList;
use crate::{Error, ErrorCode, Files, Rng};

/// Everything a reload must restore. Sessions are deliberately absent: a
/// reload tears every frame down, so a restored session id would name a
/// session no frame is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    v: u32,
    pub device: Device,
    /// One task list per app id, as `Kernel::tasks` holds them.
    pub tasks: BTreeMap<String, TaskList>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestJson {
    v: u32,
    generation: u64,
    /// Lowercase hex sha256 of the `state` file's bytes exactly as written.
    sha256: String,
}

/// The `/<id>/gen-<n>` directory prefix.
const GEN: &str = "gen-";

pub fn namespace(id: &str) -> String {
    format!("/{id}")
}

fn gen_dir(id: &str, generation: u64) -> String {
    format!("/{id}/{GEN}{generation}")
}

/// Read the highest *complete* generation. `Ok(None)` means there is no
/// checkpoint yet (a device that has never been mutated); the generation
/// counter is returned alongside so the next write continues the sequence
/// rather than colliding with a torn newer directory.
pub async fn load(
    files: &dyn Files,
    dek: &Dek,
    id: &str,
) -> Result<(u64, Option<Snapshot>), Error> {
    let mut generations = generations(files, id).await;
    generations.sort_unstable();
    let highest = generations.last().copied().unwrap_or(0);
    for generation in generations.into_iter().rev() {
        if let Some(snapshot) = read_generation(files, dek, id, generation).await {
            return Ok((highest, Some(snapshot)));
        }
    }
    Ok((highest, None))
}

/// Write generation `generation`, then drop every other one. The caller owns
/// the counter (it is `previous + 1`), so two writers cannot be talked into
/// sharing a directory — and there is only ever one writer, the device's own
/// worker, holding the device's Web Lock.
pub async fn write(
    files: &dyn Files,
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
    files.write(format!("{dir}/state"), state).await;
    // Last, always: this is what makes a generation complete.
    files.write(format!("{dir}/MANIFEST"), manifest).await;

    for old in generations(files, id).await {
        if old != generation {
            files.remove_dir_all(gen_dir(id, old)).await;
        }
    }
    Ok(())
}

/// Every `gen-<n>` directory name under the namespace, parsed. Anything else
/// in there is not ours to interpret and is left alone.
async fn generations(files: &dyn Files, id: &str) -> Vec<u64> {
    files
        .list(namespace(id))
        .await
        .into_iter()
        .filter_map(|name| name.strip_prefix(GEN)?.parse::<u64>().ok())
        .collect()
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
    pub fn new(device: Device, tasks: BTreeMap<String, TaskList>) -> Snapshot {
        Snapshot {
            v: SCHEMA,
            device,
            tasks,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
