// The IndexedDB plumbing the device store shares (PERSISTENCE.md's
// "Namespaces": the index and every per-device namespace are IndexedDB
// databases; nothing here is localStorage, for the three reasons that
// document gives — no structured clone for CryptoKey handles, no
// existence in workers, and no eviction advantage).
//
// ONE CONNECTION PER TRANSACTION, closed on completion. This is
// keystore.ts's discipline (keystore.ts:65-78) and it is not merely
// tidiness: `indexedDB.deleteDatabase` sits pending behind ANY open
// connection, and the device store deletes whole databases as a
// first-class operation (`destroyNamespace`, the T0 sweep, `remove`).
// A cached long-lived connection would turn "this device leaves" into a
// silent no-op that reports success.

/** Promisify one IDBRequest. */
export function idbReq<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb: request failed"));
  });
}

/** Promisify a transaction's completion (the commit is the durability
 * point; a request that succeeded inside an aborted transaction did
 * not happen). */
export function idbDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("indexeddb: transaction failed"));
  });
}

/**
 * Open `name` at version 1, creating exactly `stores`.
 *
 * VERIFY-THEN-CREATE inside the upgrade (keystore.ts:54-58): an upgrade
 * may run against stores a previous version already made, and
 * `createObjectStore` on an existing name throws, which would leave the
 * database unopenable rather than merely un-upgraded.
 */
export function openDb(name: string, stores: readonly string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`indexeddb: open ${name} failed`));
    req.onblocked = () => reject(new Error(`indexeddb: open ${name} blocked`));
  });
}

/** Run `body` in one transaction over `stores`, then close the
 * connection. The value `body` returns is resolved only after the
 * transaction COMMITS. */
export async function withDb<T>(
  name: string,
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb(name, stores);
  try {
    const tx = db.transaction(stores as string[], mode);
    const value = await body(tx);
    await idbDone(tx);
    return value;
  } finally {
    db.close();
  }
}

/**
 * Delete a whole database.
 *
 * `onblocked` REJECTS rather than resolving, for keystore.ts:139-150's
 * reason: resolving anyway is a silent partial erase — the caller is
 * told the device left while a stale connection kept its storage alive.
 * A refusal the caller can retry is the honest outcome.
 */
export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`indexeddb: delete ${name} failed`));
    req.onblocked = () =>
      reject(new Error(`indexeddb: delete ${name} blocked by an open connection — nothing was deleted`));
  });
}
