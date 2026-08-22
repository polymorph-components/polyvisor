// One device's storage, and nothing else's (PERSISTENCE.md,
// "Namespaces: strict partitioning").
//
// A namespace is a PAIR: an IndexedDB database `pm-device-<id>` for
// sealed blobs and key handles, and an OPFS directory `pm-device-<id>/`
// for bulk bytes. No sharing between devices, ever, in v1 — two devices
// are two replicas, and coupling their storage would shortcut the epoch
// and membership story the engine exists to enforce.
//
// This module holds no live connection (see idb.ts's header): every
// operation opens, transacts, closes. `destroyNamespace` is the reason
// — it deletes the database, and IndexedDB will not complete a delete
// behind an open handle.

import { deleteDb, idbDone, idbReq, withDb } from "./idb.ts";
import { INDEX_DB, INDEX_STORE, nsDbName, nsDirName } from "./names.ts";

/** The stores every namespace database has.
 *
 * - `seal` — the KEK ladder's persisted state: passphrase wrap, the
 *   non-extractable platform key handle and its wrap (seal.ts).
 * - `sealed` — the sealed key/value surface (`sealedPut`/`sealedGet`).
 * - `meta` — unsealed per-device bookkeeping the sweep needs: the lease.
 *   NOTHING PERSONAL: this store rests in the clear exactly like the
 *   index, so it carries timestamps and nothing else.
 * - `identity` — the device's signing identity as NON-EXTRACTABLE
 *   CryptoKey handles (identity-keys.ts). Unsealed by construction and
 *   deliberately so: the handles are unreadable because the platform
 *   says so, not because a DEK hides them (PERSISTENCE.md, "Device
 *   signing identity").
 */
export const NS_STORES = ["seal", "sealed", "meta", "identity"] as const;
export type NsStore = (typeof NS_STORES)[number];

/**
 * A handle onto one device's storage. It is a NAMING + ACCESS object,
 * not an open connection: holding one costs nothing and does not block
 * a destroy.
 */
export interface DeviceNamespace {
  readonly id: string;
  readonly dbName: string;
  readonly dirName: string;
  get<T>(store: NsStore, key: string): Promise<T | undefined>;
  put(store: NsStore, key: string, value: unknown): Promise<void>;
  delete(store: NsStore, key: string): Promise<void>;
  /** Read-modify-write inside ONE transaction — the multi-tab-safe
   * shape (wosh's `loadOrMint`, spikes/worker-host/worker.ts:129-155):
   * `body` sees the committed value and its return value is what the
   * store ends up holding. Returning `undefined` leaves the entry
   * untouched. */
  update<T>(store: NsStore, key: string, body: (current: T | undefined) => T | undefined): Promise<T | undefined>;
  /** The device's OPFS directory, created on first use. */
  directory(): Promise<FileSystemDirectoryHandle>;
}

/**
 * Open (creating if absent) the namespace for `id`. Cheap and
 * idempotent — this does not itself create the OPFS directory; the
 * first `directory()` call does.
 */
export function openNamespace(id: string): DeviceNamespace {
  const dbName = nsDbName(id);
  const dirName = nsDirName(id);
  return {
    id,
    dbName,
    dirName,
    get: <T>(store: NsStore, key: string) =>
      withDb(dbName, NS_STORES, "readonly", (tx) =>
        idbReq(tx.objectStore(store).get(key) as IDBRequest<T | undefined>)),
    put: (store: NsStore, key: string, value: unknown) =>
      withDb(dbName, NS_STORES, "readwrite", (tx) => {
        tx.objectStore(store).put(value, key);
      }),
    delete: (store: NsStore, key: string) =>
      withDb(dbName, NS_STORES, "readwrite", (tx) => {
        tx.objectStore(store).delete(key);
      }),
    update: <T>(store: NsStore, key: string, body: (current: T | undefined) => T | undefined) =>
      withDb(dbName, NS_STORES, "readwrite", async (tx) => {
        const os = tx.objectStore(store);
        const current = await idbReq(os.get(key) as IDBRequest<T | undefined>);
        const next = body(current);
        if (next !== undefined) os.put(next, key);
        return next ?? current;
      }),
    directory: async () => {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(dirName, { create: true });
    },
  };
}

/** Does this device have any storage at all? (Used by the anchor's
 * liveness question and by tests; a namespace with no database yet is
 * indistinguishable from one that was swept.) */
export async function namespaceExists(id: string): Promise<boolean> {
  // `indexedDB.databases()` is Chromium/WebKit; where it is missing the
  // honest answer is "cannot tell", and the caller's degrade rule (a
  // missing namespace is a fresh device, silently) is the safe side.
  const dbs = (indexedDB as unknown as {
    databases?: () => Promise<{ name?: string }[]>;
  }).databases;
  if (!dbs) return true;
  const list = await dbs.call(indexedDB);
  return list.some((d) => d.name === nsDbName(id));
}

/**
 * THE DEVICE LEAVES: database, OPFS directory, and the index row —
 * all three, or the caller hears about it.
 *
 * Used by `removeDevice` (the user's explicit "forget this device") and
 * by the T0 sweep. Order matters: the INDEX ROW GOES LAST, so a failure
 * part-way leaves a row whose storage is partly gone — which the next
 * sweep or remove can finish — rather than orphaned storage no row
 * points at, which nothing would ever collect.
 */
export async function destroyNamespace(id: string): Promise<void> {
  await deleteDb(nsDbName(id));
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(nsDirName(id), { recursive: true });
  } catch (e) {
    // NotFoundError: the directory was never created (a device that
    // never wrote bulk bytes). Anything else is real.
    if ((e as { name?: string })?.name !== "NotFoundError") throw e;
  }
  await withDb(INDEX_DB, [INDEX_STORE], "readwrite", (tx) => {
    tx.objectStore(INDEX_STORE).delete(id);
  });
}

/** Re-exported for callers that only need the spelling. */
export { idbDone, nsDbName, nsDirName };
