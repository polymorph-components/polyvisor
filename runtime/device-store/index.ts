// THE INDEX: the one unsealed database (PERSISTENCE.md, "The index:
// what may exist before unseal").
//
// This file is readable by exactly the adversary the sealing defends
// against — disk, backups, synced profiles — so what it holds is the
// minimum a picker needs and NOTHING PERSONAL. The record type below is
// the whole contract, and the negative half of it is the important one:
//
//   NEVER the anchor colour (invariantly undisclosed — demo's
//   check-invariants.sh (c) already enforces that it is not even
//   ambient in the DOM), never the user's name, never their icon, never
//   an account identifier, never key material.
//
// The petname is the one user-typed string here, ruled acceptable in
// the clear (a picker with unlabelled devices is not a picker). Because
// everything else personal is missing, pre-unseal chrome is generic —
// which is what gives unseal-as-login its anti-spoofing property: a
// page imitating the picker cannot paint your colour.
//
// If you are tempted to add a field, the test is not "is this useful to
// the picker" but "would I be comfortable finding this in a synced
// profile backup".

import { idbReq, withDb } from "./idb.ts";
import { INDEX_DB, INDEX_STORE } from "./names.ts";
import { destroyNamespace } from "./namespace.ts";

/** How long a device lives (PERSISTENCE.md, "Tiers, as a promotion").
 * Every device starts `t0`; `t1` is reached by promotion, never by
 * choosing it up front. */
export type Tier = "t0" | "t1";

/** How the device's signing identity rests. `platform` (non-extractable
 * WebCrypto handles) is the target; `seed` is the recovery/export
 * format and the fallback posture. */
export type Posture = "seed" | "platform";

/** Which unseal ceremony the picker should offer. The tag lives in the
 * index precisely so the picker can decide WITHOUT opening anything.
 * See seal.ts for what each rung actually buys. */
export type UnsealPolicy = "every-session" | "while-open" | "until-reseal";

/** One row of the index. Every field here rests in the clear. */
export interface DeviceRecord {
  /** Opaque and random — not derived from anything about the user, and
   * not an account identifier. It names storage (`pm-device-<id>`) and
   * nothing else. */
  id: string;
  /** The user's word for this device ("laptop"). The one personal-ish
   * string ruled admissible in the clear. */
  petname: string;
  tier: Tier;
  posture: Posture;
  unsealPolicy: UnsealPolicy;
  createdAt: number;
  lastUsed: number;
}

/** What a caller may choose at creation. Everything else is fixed by
 * the tier story: a new device is T0, `seed`, `every-session`. */
export interface CreateSpec {
  petname: string;
  posture?: Posture;
  unsealPolicy?: UnsealPolicy;
}

/** What promotion asks (PERSISTENCE.md: "the promotion moment is where
 * the seal choices are asked"). */
export interface PromoteSpec {
  /**
   * The user's word for this device, typed at the promotion ceremony.
   *
   * IT BELONGS HERE rather than only at creation because creation is
   * where a T0 device gets a GENERATED placeholder — "try, then keep"
   * means there is no ceremony to ask at, so the first real chance to
   * ask is the moment the user says the device should outlive the tab.
   * It rests in the clear like every other field of this record, and
   * the ceremony has to say so in its own words.
   */
  petname?: string;
  posture?: Posture;
  unsealPolicy?: UnsealPolicy;
}

/**
 * A fresh opaque device id: 128 bits of `crypto.getRandomValues`, hex.
 *
 * Random rather than counted or derived, because the id is the one part
 * of a device that appears in storage names, lock names and the
 * sessionStorage anchor — all of them places an id can be observed. A
 * counter would leak how many devices this profile has made; anything
 * derived from the petname or the identity would leak the thing the
 * index is careful not to hold.
 */
export function newDeviceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const index = <T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => Promise<T> | T) =>
  withDb(INDEX_DB, [INDEX_STORE], mode, (tx) => body(tx.objectStore(INDEX_STORE)));

/** Every device this browser can offer, newest use first. */
export async function listDevices(): Promise<DeviceRecord[]> {
  const rows = await index("readonly", (s) =>
    idbReq(s.getAll() as IDBRequest<DeviceRecord[]>));
  return rows.sort((a, b) => b.lastUsed - a.lastUsed);
}

export function getDevice(id: string): Promise<DeviceRecord | undefined> {
  return index("readonly", (s) => idbReq(s.get(id) as IDBRequest<DeviceRecord | undefined>));
}

/**
 * Create-or-load the device with THIS id, race-free.
 *
 * THE RACE IS REAL AND IT IS THE ANCHOR'S. A T0 device id lives in
 * sessionStorage, and a restored session can open several tabs pointing
 * at the SAME id at once (crash restore reopens a window's worth of
 * tabs simultaneously); each of them wants the device to exist. A
 * read-then-write would have both read "absent" and both write a row,
 * and the loser's `createdAt` would silently overwrite the winner's.
 *
 * The settle is wosh's (`identity-store.ts`'s `loadOrMint`, mirrored in
 * spikes/worker-host/worker.ts:129-155): re-read INSIDE the readwrite
 * transaction and let that one transaction pick the winner. IndexedDB
 * serialises overlapping readwrite transactions on the same store, so
 * exactly one caller sees `undefined` there.
 *
 * Returns the row that won, and whether this call is the one that made
 * it (the caller needs to know: only a creator should run first-boot
 * ceremonies).
 */
export async function ensureDevice(
  id: string,
  spec: CreateSpec,
): Promise<{ record: DeviceRecord; created: boolean }> {
  const now = Date.now();
  const candidate: DeviceRecord = {
    id,
    petname: spec.petname,
    tier: "t0",
    posture: spec.posture ?? "seed",
    unsealPolicy: spec.unsealPolicy ?? "every-session",
    createdAt: now,
    lastUsed: now,
  };
  return await index("readwrite", async (s) => {
    const existing = await idbReq(s.get(id) as IDBRequest<DeviceRecord | undefined>);
    if (existing) return { record: existing, created: false };
    s.put(candidate, id);
    return { record: candidate, created: true };
  });
}

/**
 * A new device: fresh id, T0, no ceremony (PERSISTENCE.md, "This is the
 * first-run shape (#37): try, then keep").
 */
export async function createDevice(spec: CreateSpec): Promise<DeviceRecord> {
  const { record } = await ensureDevice(newDeviceId(), spec);
  return record;
}

/** Mark a device as used now. Silently does nothing for a device that
 * is gone — a touch losing a race with a sweep is not an error. */
export async function touchDevice(id: string): Promise<void> {
  await index("readwrite", async (s) => {
    const row = await idbReq(s.get(id) as IDBRequest<DeviceRecord | undefined>);
    if (!row) return;
    s.put({ ...row, lastUsed: Date.now() }, id);
  });
}

/**
 * "KEEP THIS DEVICE" — T0 → T1 (PERSISTENCE.md, "Tiers, as a
 * promotion"). The seal choices are made HERE, because this is the
 * first moment the user has said the device should outlive the tab.
 *
 * `navigator.storage.persist()` is REQUESTED, and its answer is
 * RETURNED rather than assumed: the browser may say no (and does, on a
 * fresh origin with no engagement), and the caller has to be able to
 * tell the user that this device is durable-but-evictable instead of
 * pretending. Eviction is origin-granular anyway — if the index goes,
 * everything goes — so a refusal is a warning, never a failure of the
 * promotion.
 *
 * Promotion does not carry the DEK: sealing the device is seal.ts's
 * job, and the caller runs it around this call. A device whose row says
 * `t1` and which has no wrap yet is a legal intermediate state — the
 * next boot's unseal ceremony sees "no rung" and can ask again.
 */
export async function promoteDevice(
  id: string,
  spec: PromoteSpec = {},
): Promise<{ record: DeviceRecord; persisted: boolean }> {
  const record = await index("readwrite", async (s) => {
    const row = await idbReq(s.get(id) as IDBRequest<DeviceRecord | undefined>);
    if (!row) throw new Error(`device-store: no device ${id} to promote`);
    const next: DeviceRecord = {
      ...row,
      tier: "t1",
      // An empty or whitespace-only petname is not a rename, it is a
      // ceremony the user left blank: the placeholder stays rather than
      // being replaced with nothing.
      petname: spec.petname?.trim() ? spec.petname.trim() : row.petname,
      posture: spec.posture ?? row.posture,
      unsealPolicy: spec.unsealPolicy ?? row.unsealPolicy,
      lastUsed: Date.now(),
    };
    s.put(next, id);
    return next;
  });
  let persisted = false;
  try {
    persisted = await navigator.storage.persist();
  } catch {
    // Private mode and storage-refusing profiles: the device is still
    // promoted, it is simply as durable as the profile allows. Degrade,
    // never error (PERSISTENCE.md, "Eviction and degradation").
    persisted = false;
  }
  return { record, persisted };
}

/**
 * FORGET THIS DEVICE: the namespace's database, its OPFS directory and
 * its index row. See `destroyNamespace` for the ordering and why the
 * row goes last.
 */
export function removeDevice(id: string): Promise<void> {
  return destroyNamespace(id);
}
