// The visor's escrowed signing credentials (#11's keystore slice, #7's
// signer seam).
//
// WHAT THIS BUYS. A raw SigV4 secret is a bearer string: whoever reads it
// can sign anything, anywhere, for the life of the key. What is stored
// here instead is a WebCrypto handle — an object that can be USED to sign
// and cannot be read back. The raw secret exists for exactly one moment,
// in the credential sheet, because the user typed it; from `putSigningKey`
// onward it exists only as a non-extractable key handle inside IndexedDB's
// structured clone. `crypto.subtle.exportKey` on such a key throws BY
// CONSTRUCTION (extractable: false), and scripts/check-invariants.sh bans
// the call from host code entirely so nobody re-opens the door by writing
// a "just for debugging" export path.
//
// The stored key is the SigV4 *root* — HMAC("AWS4" + secret) — not the
// secret string. That is already one derivation step away from the value
// the provider console shows, and it is the only form any signature needs.
//
// HONEST LIMIT. The per-request derivation chain (date → region → service
// → "aws4_request") produces intermediate MAC outputs, and those bytes do
// transit JS memory as ArrayBuffers before being re-imported as handles.
// So a same-page attacker who wins during a derivation could lift a
// *scope* key: one date, one region, one service. The DURABLE root never
// transits JS memory at all after escrow, so nothing that outlives the
// day's scope is exposed. Narrowing the window further would need the
// whole chain inside the platform (a webcrypto SigV4 primitive), which
// does not exist.

import { ComponentException } from "@polyengine/protocol";

const DB_NAME = "pm-demo-keystore";
const DB_VERSION = 1;
const STORE = "sigv4";

/** One escrowed storage credential, keyed by the origin it was bound to
 * in the credential sheet (#22's destination binding, made durable). */
export interface SigningRecord {
  /** Normalized origin — the keyPath, and the binding. */
  origin: string;
  /** The public half: an identifier that travels in the Authorization
   * header in clear. Stored beside the handle so the wiring can name the
   * credential without the user re-typing it. */
  accessKey: string;
  /** Non-extractable HMAC-SHA-256 handle over "AWS4" + secret. */
  key: CryptoKey;
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Verify-then-create: an upgrade may run against a store that a
      // previous version already made.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "origin" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("keystore: open failed"));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = body(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("keystore: request failed"));
      t.oncomplete = () => db.close();
    })
  );
}

function bytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

/**
 * Escrow a storage secret for `origin`. THE RAW SECRET STOPS HERE: it is
 * imported into a non-extractable key handle and the string parameter is
 * never stored, logged, or returned. Callers hold it only for the length
 * of this call (it came straight off the credential sheet's input).
 */
export async function putSigningKey(
  origin: string,
  accessKey: string,
  secret: string,
): Promise<void> {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(`AWS4${secret}`) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    // extractable: false — this is the whole mechanism. Structured clone
    // still persists it; only script read-back is gone.
    false,
    ["sign"],
  );
  const record: SigningRecord = { origin, accessKey, key, createdAt: Date.now() };
  await tx("readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>);
}

export async function getSigningKey(origin: string): Promise<SigningRecord | null> {
  try {
    const rec = await tx<SigningRecord | undefined>(
      "readonly",
      (s) => s.get(origin) as IDBRequest<SigningRecord | undefined>,
    );
    return rec ?? null;
  } catch {
    // A browser with IndexedDB unavailable (private mode quirks) simply
    // holds no credential; the callers' "none held" path is correct.
    return null;
  }
}

export async function deleteSigningKey(origin: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(origin) as IDBRequest<undefined>);
}

/**
 * ERASE THE WHOLE KEYSTORE (the erase ceremony's `onReset`, visor/ui/
 * sheets.ts:1329-1339): every escrowed credential for every origin,
 * gone, by deleting the database itself rather than clearing the one
 * store — the version number and any store this module grows later go
 * with it, so a future migration starts from nothing rather than from a
 * store this call forgot to clear.
 *
 * ON `onblocked`: IndexedDB will not run a `deleteDatabase` to
 * completion while ANY connection to it is still open — the delete sits
 * pending until every open handle closes. This module already closes
 * every connection it opens as soon as its one transaction completes
 * (`tx`'s `t.oncomplete`), so under this module's own usage there should
 * be nothing left open by the time this runs. But "should be" is not the
 * same guarantee as blocking-cannot-happen, and the failure mode of
 * resolving anyway on `onblocked` is a SILENT PARTIAL ERASE — the ceremony
 * would report success while a stale connection kept the store alive
 * underneath it, which is precisely the "this device leaves" promise
 * broken invisibly. So `onblocked` is treated as a real error: it rejects
 * rather than resolves, and the erase ceremony's own contract
 * (visor/ui/sheets.ts:1329-1339, "the fallible half first") takes it from
 * there — the ceremony refuses the whole erase and the user can retry
 * rather than walking away believing a device that can no longer sign is
 * still a device that can no longer sign for reasons other than the ones
 * it was told.
 */
export function eraseKeystore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("keystore: erase failed"));
    req.onblocked = () =>
      reject(
        new Error(
          "keystore: erase blocked by an open connection — nothing was erased",
        ),
      );
  });
}

// --- the `store-signer` seam ---------------------------------------------------

/** The WIT `result<_, string>` err side: the branded exception the polyengine
 * embedder maps back to an error string, so the guest can OBSERVE a
 * refusal instead of trapping (same convention as demo.ts's `witErr`). */
function refuse(message: string): never {
  throw new ComponentException(message);
}

async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
}

/** Re-import one derivation step's output as another non-extractable
 * sign-only handle: only handles are kept past this line. */
async function asKey(raw: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The scope the escrowed handle will sign for, and nothing else. A raw
 * SigV4 key is valid account-wide, for every service and region; this
 * capability is strictly NARROWER than the key it wraps, which is the
 * point of escrowing it (#11). Widening these is a design decision, not a
 * configuration one, so they are constants. */
const SIGNER_SERVICE = "s3";
const SIGNER_REGION = "us-east-1";

export type Signer = (
  stringToSign: string,
  date: string,
  region: string,
  service: string,
) => Promise<string>;

/**
 * The `store-signer` implementation for an instance holding the escrowed
 * credential for `origin`. What crosses the boundary inbound is public
 * request metadata (a string-to-sign and its scope); what crosses back is
 * one signature. Key material crosses in neither direction, so a
 * compromised guest can obtain only the signatures this function agrees
 * to produce.
 */
export function makeSigner(origin: string): Signer {
  // Scope keys are derived per (date, region, service) and cached as
  // handles. The cache holds CryptoKeys, never bytes.
  const scopeKeys = new Map<string, Promise<CryptoKey>>();
  let root: Promise<SigningRecord | null> | null = null;

  return async (stringToSign, date, region, service) => {
    if (service !== SIGNER_SERVICE) {
      refuse(`store-signer: out of scope: service ${service} != ${SIGNER_SERVICE}`);
    }
    if (region !== SIGNER_REGION) {
      refuse(`store-signer: out of scope: region ${region} != ${SIGNER_REGION}`);
    }
    root ??= getSigningKey(origin);
    const rec = await root;
    if (!rec) {
      // Defensive: setup refuses to wire a signer with nothing escrowed,
      // so reaching here means the entry was deleted underneath us.
      root = null;
      refuse(`store-signer: no signing credential held for ${origin}`);
    }
    const scope = `${date}/${region}/${service}`;
    let scopeKey = scopeKeys.get(scope);
    if (!scopeKey) {
      scopeKey = (async () => {
        // SigV4 key derivation (AWS SigV4, "Calculate the signature"),
        // chained over handles: the same chain the native host does in
        // engine/host/src/main.rs.
        let k = rec.key;
        for (const step of [date, region, service, "aws4_request"]) {
          k = await asKey(await hmac(k, bytes(step)));
        }
        return k;
      })();
      scopeKeys.set(scope, scopeKey);
    }
    return hex(await hmac(await scopeKey, bytes(stringToSign)));
  };
}

/** The signer for an instance that was wired NO signing authority. It is
 * a real seam that really refuses — not an absent import and not an empty
 * config — so the reader tier's confinement is visible in the wiring
 * rather than inferred from a blank field. */
export const refusingSigner: Signer = () =>
  Promise.reject(
    new ComponentException("store-signer: no signing credential wired for this instance"),
  );
