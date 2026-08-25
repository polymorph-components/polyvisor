// THE DEVICE LOCK AND THE T0 SWEEP (PERSISTENCE.md, "T0 reload
// survival: the sessionStorage anchor").
//
// One Web Lock per device, `pm-device-<id>`, held for the LIFETIME of
// whatever hosts the device — the SharedWorker, in the track that comes
// after this one. The lock is not a mutex here so much as a LIVENESS
// SIGNAL: locks are released by the platform when the holder dies, with
// no cooperation from the holder, which is the one thing a crashed tab
// cannot fake. That is what makes the sweep sound.
//
// THE SWEEP RULE, verbatim from the design record: a T0 namespace is
// garbage EXACTLY WHEN its device lock is FREE and its lease is STALE.
// Both halves are needed and neither is sufficient:
//
//   * lock free, lease fresh   → a host died seconds ago and a tab is
//     about to reconnect after a reload (the spike measured Chromium
//     respawning the SharedWorker on EVERY single-tab reload — the
//     zero-client window at navigation). Sweeping here would delete the
//     state of a device that is mid-reload. The lease's staleness
//     window is precisely the grace period for that gap.
//   * lock held, lease stale   → a host that is alive but has not
//     written a lease in a while (the worker wedged mid-GC, or a
//     browser that froze the worker under memory pressure). Alive is
//     alive. Whether a SUSPENDED TAB suspends the SharedWorker whose
//     lease this is remains UNMEASURED: the devstore matrix's CDP page
//     freeze does not take on a harness page in this build (row 55), so
//     the question could not even be posed there, let alone answered.
//
// bfcache would complicate lock lifetimes; the page already holds a
// live relay WebSocket and is bfcache-ineligible regardless, so the
// cost is pre-paid (design record, same section).

import { listDevices } from "./index.ts";
import { deviceLockName } from "./names.ts";
import { type DeviceNamespace, destroyNamespace, openNamespace } from "./namespace.ts";

export { deviceLockName };

/** How often a live host should renew its lease. */
export const LEASE_INTERVAL_MS = 5_000;
/**
 * How old a lease may be before it is stale. Six intervals: long enough
 * that a reload's zero-client window, a slow rehydrate, and a couple of
 * missed renewals in a throttled background tab do not look like death;
 * short enough that a genuinely dead T0 device is collected within the
 * same session rather than accumulating. Sweeping late costs storage;
 * sweeping early costs a user their unsaved device, so the asymmetry is
 * deliberate.
 */
export const LEASE_STALE_MS = LEASE_INTERVAL_MS * 6;

const LEASE_KEY = "lease";

interface Lease {
  /** Wall-clock ms. Compared only against `Date.now()` on the same
   * machine, so clock skew between devices is not a concern; a clock
   * that jumps BACKWARD makes a lease look fresher than it is, which
   * errs toward not sweeping. */
  at: number;
}

/** Write the lease now — the host's "I am alive" mark. */
export function touchLease(ns: DeviceNamespace): Promise<void> {
  return ns.put("meta", LEASE_KEY, { at: Date.now() } satisfies Lease);
}

export async function readLease(ns: DeviceNamespace): Promise<number | null> {
  const l = await ns.get<Lease>("meta", LEASE_KEY);
  return l?.at ?? null;
}

export async function leaseIsStale(ns: DeviceNamespace, now = Date.now()): Promise<boolean> {
  const at = await readLease(ns);
  // NO LEASE AT ALL IS STALE. A namespace that never wrote one either
  // predates the lease or belongs to a host that died before its first
  // renewal; both are garbage by the time the lock is also free.
  return at === null || now - at > LEASE_STALE_MS;
}

/** A running lease heartbeat; `stop()` when the host goes away. */
export interface LeaseHeartbeat {
  stop(): void;
}

/** Renew the lease every `LEASE_INTERVAL_MS`, starting immediately. */
export function startLease(ns: DeviceNamespace, intervalMs = LEASE_INTERVAL_MS): LeaseHeartbeat {
  void touchLease(ns);
  const timer = setInterval(() => {
    // A failed renewal is not fatal — the next one may succeed, and a
    // permanently failing one correctly leads to a sweep.
    void touchLease(ns).catch(() => {});
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

// --- the lock ---------------------------------------------------------------

/** A held device lock. Releasing is explicit; DYING also releases it,
 * which is the property the sweep depends on. */
export interface DeviceLock {
  readonly id: string;
  readonly name: string;
  release(): void;
}

/**
 * Take the device lock and HOLD IT until `release()` (or until this
 * context dies). Resolves when the lock is held.
 *
 * The callback returns a promise that never settles — the spike's shape
 * (spikes/worker-host/worker.ts:88-101) — because the lock's release
 * has to coincide with the holder's death, not with the end of some
 * piece of work.
 *
 * Rejects with `"held"` if `ifAvailable` was asked for and another
 * context already holds it; without it, the request QUEUES, which is
 * the right behaviour for a second host waiting for a first to finish
 * shutting down.
 */
export function holdDeviceLock(
  id: string,
  opts: { ifAvailable?: boolean } = {},
): Promise<DeviceLock> {
  const name = deviceLockName(id);
  return new Promise<DeviceLock>((resolve, reject) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    navigator.locks
      .request(name, { mode: "exclusive", ifAvailable: opts.ifAvailable ?? false }, (lock) => {
        if (lock === null) {
          reject(new Error(`device-store: the lock for ${id} is already held`));
          return Promise.resolve();
        }
        resolve({ id, name, release });
        return held;
      })
      .catch(reject);
  });
}

/** Is some context hosting this device right now? Answered from the
 * lock manager's own view, so it is true across tabs and workers. */
export async function deviceLockIsHeld(id: string): Promise<boolean> {
  const name = deviceLockName(id);
  const state = await navigator.locks.query();
  return (state.held ?? []).some((l) => l.name === name);
}

// --- the sweep --------------------------------------------------------------

export interface SweepResult {
  /** Device ids whose namespaces were deleted. */
  swept: string[];
  /** Device ids examined and kept, with why. */
  kept: { id: string; because: "lock-held" | "lease-fresh" | "not-t0" }[];
}

/**
 * Collect dead T0 namespaces.
 *
 * THE FREENESS TEST IS THE ACQUISITION. Asking `navigator.locks.query()`
 * and then deleting would be a time-of-check/time-of-use bug with a
 * catastrophic outcome: a host could start between the two and find its
 * storage deleted underneath it. So the sweep TAKES the lock with
 * `ifAvailable: true` — an atomic "is it free, and if so it is now
 * mine" — and does the destroy while holding it. A host that starts
 * mid-sweep queues behind us and finds a clean, absent namespace, which
 * is the degrade rule's "fresh device, silently".
 *
 * T1 devices are never swept, whatever their lease says: durable means
 * durable, and only `removeDevice` takes one away.
 */
export async function sweepT0(): Promise<SweepResult> {
  const result: SweepResult = { swept: [], kept: [] };
  for (const device of await listDevices()) {
    if (device.tier !== "t0") {
      result.kept.push({ id: device.id, because: "not-t0" });
      continue;
    }
    const outcome = await withLockIfFree(device.id, async () => {
      const ns = openNamespace(device.id);
      if (!(await leaseIsStale(ns))) return "lease-fresh" as const;
      await destroyNamespace(device.id);
      return "swept" as const;
    });
    if (outcome === "swept") result.swept.push(device.id);
    else result.kept.push({ id: device.id, because: outcome });
  }
  return result;
}

/** Run `body` while holding the device lock, but only if it was free;
 * otherwise answer `"lock-held"` without waiting. */
async function withLockIfFree<T>(
  id: string,
  body: () => Promise<T>,
): Promise<T | "lock-held"> {
  return await navigator.locks.request(
    deviceLockName(id),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => (lock === null ? ("lock-held" as const) : await body()),
  ) as T | "lock-held";
}
