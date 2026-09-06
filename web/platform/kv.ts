// `polyvisor:internal/kv` over IndexedDB.
//
// internal.wit `interface kv`: the small UNSEALED store, holding only what
// must be readable before any device is unsealed. Sealed state lives behind
// `wasi:filesystem` and is not this. Keys are strings, values `list<u8>`
// (Uint8Array on the wire — M1 context "Value mapping").

const DB_NAME = "polyvisor";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let db: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return (db ??= open());
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return database().then((d) =>
    new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

export const kv = {
  async get(key: string): Promise<Uint8Array | undefined> {
    return await run<Uint8Array | undefined>("readonly", (s) => s.get(key));
  },
  async set(key: string, value: Uint8Array): Promise<void> {
    // Copy: the value is a view over the guest's lowered buffer, and
    // IndexedDB's structured clone is asynchronous relative to it.
    await run("readwrite", (s) => s.put(value.slice(), key));
  },
  async delete(key: string): Promise<void> {
    await run("readwrite", (s) => s.delete(key));
  },
  async keys(prefix: string): Promise<string[]> {
    const all = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return all.map(String).filter((k) => k.startsWith(prefix));
  },
};
