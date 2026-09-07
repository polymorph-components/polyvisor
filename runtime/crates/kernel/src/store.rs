//! The device index and the sweep.
//!
//! The index is one `kv` row per device (`index/<id>`) — the only record
//! readable before any seal opens, and what `store.devices` serves to the
//! entry picker. Small per-device records live beside it under `dev/<id>/`;
//! the bulk state lives in the OPFS namespace `/<id>/`.
//!
//! The sweep is the ephemeral tier's garbage collection (docs/design.md
//! "Devices": "the namespace is garbage once its lock is free and its lease
//! stale"). Liveness is the Web Lock `pm-device-<id>`, which the glue holds
//! for its worker's lifetime and which the browser releases when the worker
//! dies; the lease is a timestamp the row's own worker refreshes.

use crate::device::{IndexRow, Tier};
use crate::{Error, Files, Locks, Platform};

/// How stale a lease may be before an *unlocked* ephemeral device counts as
/// abandoned. Two minutes.
///
/// The kernel has no timers and the glue has none either, so the lease is
/// refreshed only at boot and on every checkpoint. That is enough for what
/// the sweep decides, because the lock is the liveness signal and the lease
/// is only the tie-breaker: a worker that is alive but has been idle for two
/// minutes still holds `pm-device-<id>`, so it is never swept regardless of
/// how old its lease is. The lease exists to keep the sweep from destroying a
/// device whose worker died seconds ago and whose lock the browser has
/// already released, while a tab is mid-reload and about to bring it back.
pub const LEASE_TTL_MS: u64 = 2 * 60 * 1000;

pub fn index_key(id: &str) -> String {
    format!("index/{id}")
}

pub fn dev_prefix(id: &str) -> String {
    format!("dev/{id}/")
}

pub const INDEX_PREFIX: &str = "index/";

/// Every index row, in id order. Rows that cannot be read are an error: the
/// picker showing a partial list would be worse than showing none.
pub async fn rows(platform: &dyn Platform) -> Result<Vec<IndexRow>, Error> {
    let mut keys = platform.keys(INDEX_PREFIX.to_string()).await;
    keys.sort();
    let mut rows = Vec::with_capacity(keys.len());
    for key in keys {
        let Some(bytes) = platform.get(key).await else {
            // Deleted between `keys` and `get` — an erase or a sweep racing
            // us. A row that is gone is simply not in the list.
            continue;
        };
        rows.push(IndexRow::decode(&bytes)?);
    }
    Ok(rows)
}

/// Destroy a device's namespace, its small records and its index row. The
/// order matters only in that the index row goes last: a row without a
/// namespace is recoverable (it boots as a device whose checkpoint is
/// missing), a namespace without a row is unreachable garbage.
pub async fn destroy(platform: &dyn Platform, files: &dyn Files, id: &str) {
    files.remove_dir_all(crate::checkpoint::namespace(id)).await;
    for key in platform.keys(dev_prefix(id)).await {
        platform.delete(key).await;
    }
    platform.delete(index_key(id)).await;
}

/// Destroy every ephemeral device other than `ours` whose worker is gone and
/// whose lease is stale. Returns the ids swept, which is what the tests
/// assert on.
pub async fn sweep(
    platform: &dyn Platform,
    files: &dyn Files,
    locks: &dyn Locks,
    ours: &str,
    now: u64,
) -> Result<Vec<String>, Error> {
    let mut swept = Vec::new();
    for row in rows(platform).await? {
        if row.id == ours || row.tier != Tier::Ephemeral {
            continue;
        }
        // `saturating_sub`: the system clock is not monotonic (wasi:clocks
        // says so outright), so a row from the future must read as fresh
        // rather than as infinitely stale.
        if now.saturating_sub(row.last_used) <= LEASE_TTL_MS {
            continue;
        }
        if locks.is_held(lock_name(&row.id)).await {
            continue;
        }
        destroy(platform, files, &row.id).await;
        swept.push(row.id);
    }
    Ok(swept)
}

/// The Web Lock the glue holds for a device's worker lifetime.
pub fn lock_name(id: &str) -> String {
    format!("pm-device-{id}")
}
