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

/// Every index row this runtime can read, in id order.
///
/// A row that does not decode is skipped, not an error: it is a row from a
/// future schema or a corrupt one, and neither is something to say to the
/// user or to refuse the whole picker over. It is also not something to
/// *delete* — a newer runtime in another tab may own it. The key stays out of
/// every message for the same reason: there is nothing actionable in it.
pub async fn rows(platform: &dyn Platform) -> Result<Vec<IndexRow>, Error> {
    let mut keys = platform.keys(INDEX_PREFIX.to_string()).await;
    keys.sort();
    let mut rows = Vec::with_capacity(keys.len());
    for key in keys {
        // A row missing between `keys` and `get` is an erase or a sweep
        // racing us; a row that is gone is simply not in the list.
        if let Some(bytes) = platform.get(key).await
            && let Ok(row) = IndexRow::decode(&bytes)
        {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Destroy a device's namespace, its small records and its index row.
///
/// The namespace is removed by name — the kernel cannot list a directory
/// (internal.wit `world runtime`) — so this reads the device's generation
/// pointer first and hands it to [`crate::checkpoint::destroy`], which knows
/// every path the kernel can have written. The index row goes last: a row
/// without a namespace is recoverable (it boots as a device whose checkpoint
/// is missing), a namespace without a row is unreachable garbage.
pub async fn destroy(platform: &dyn Platform, files: &dyn Files, id: &str) {
    let pointer = crate::checkpoint::pointer(platform, id).await;
    crate::checkpoint::destroy(files, id, pointer).await;
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
    // `rows` has already skipped anything undecodable, which is what the
    // sweep wants too: a row it cannot read is a row it cannot judge, and
    // destroying a namespace on a guess is unrecoverable.
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
