// THE DEVICE'S SIGNING IDENTITY, AT REST (PERSISTENCE.md, "Device
// signing identity"; posture `platform`).
//
// WHY THIS LIVES HERE AND NOT IN THE PORT. It used to be a WIT package
// in polymorph-webcrypto; webcrypto#391 ruled it out — "store a handle"
// is a browser-specific capability, not a WebCrypto one, so persistence
// is an EMBEDDER library and the guest-facing function is app-owned WIT.
// The engine's `device-identity`-shaped import is implemented by the
// embedder loading a handle from here and passing it to the port's
// `webcryptoHost().inject.signingKey` (webcrypto#390). This module
// therefore stops at the CryptoKey; it knows nothing about WIT, nothing
// about resources, and throws plain typed errors rather than
// `ComponentException`. It is honestly browser-only.
//
// WHAT IT BUYS. The Web Cryptography API gives `CryptoKey` structured-
// clone steps (§13), so a browser can put a key in IndexedDB and take
// it out again with `[[extractable]]` and the underlying handle intact.
// A NON-EXTRACTABLE key therefore survives a reload while its material
// stays unreadable — which is the whole point, and the reason the
// alternative (export material, re-import next time) is a downgrade
// rather than an equivalent: a wrapped or exported seed is offline-
// guessable at the wrapping secret's strength, while a non-extractable
// handle cannot leave the profile at all.
//
// VALIDATE ON LOAD. IndexedDB is writable by anything else running on
// this origin, so a stored entry is UNTRUSTED INPUT on the way back in.
// `usableIdentity` re-checks everything the mint promised — instance,
// type, algorithm, `extractable === false`, usages — and a failing
// entry is DISCARDED rather than merely rejected, so the caller's
// load-or-mint path is not an infinite loop against a planted value.
// The predicate's shape is wosh's `usable()` (site/identity-store.ts:
// 67-76), mirrored in spikes/worker-host/worker.ts:117-124.

import { idbReq, withDb } from "./idb.ts";
import type { DeviceNamespace } from "./namespace.ts";
import { NS_STORES } from "./namespace.ts";

/** The object store inside the device's namespace database. */
const STORE = "identity";

/**
 * THE DEVICE'S OWN SIGNING IDENTITY, by name.
 *
 * One well-known id, because there is exactly one of these per device
 * and three places need to agree on the spelling: the worker host (which
 * loads it and hands it to the engine through the `device-identity`
 * import), any tool that wants to inspect it, and the probe matrix that
 * plants a rival pair to prove the engine refuses it. The store itself
 * stays keyed — `persistIdentity(ns, id, pair)` — because nothing here
 * should assume this is the only key a device will ever hold.
 */
export const DEVICE_IDENTITY_KEY = "device-signing";

/**
 * Ed25519, and only Ed25519. The engine's device identity is an Ed25519
 * signing key; keeping the algorithm a CONSTANT rather than a stored
 * field is what makes validate-on-load meaningful — the algorithm a
 * loaded key is checked against is reconstructed here, never read back
 * from a record an attacker could have rewritten.
 */
const ALGORITHM = "Ed25519" as const;

/** A refusal from the identity store, typed so callers can tell "no key
 * yet" (which is not an error and is reported as `null`) from a real
 * storage failure. */
export class IdentityKeyError extends Error {
  constructor(readonly code: "extractable" | "algorithm" | "unavailable", message: string) {
    super(message);
    this.name = "IdentityKeyError";
  }
}

/**
 * Whether a stored value is a key pair this module is willing to hand
 * back: exactly what `mint` makes, re-checked rather than assumed.
 *
 * Both halves are checked. The private half carries the promise
 * (`extractable === false`, usable for `sign`); the public half is
 * checked too because a swapped public key would make the caller
 * publish an identity whose signatures it cannot produce — a confusing
 * failure much later, instead of a discard now.
 */
export function usableIdentity(value: unknown): value is CryptoKeyPair {
  const pair = value as CryptoKeyPair | null;
  return (
    typeof pair === "object" && pair !== null &&
    pair.privateKey instanceof CryptoKey &&
    pair.publicKey instanceof CryptoKey &&
    pair.privateKey.type === "private" &&
    pair.publicKey.type === "public" &&
    pair.privateKey.algorithm.name === ALGORITHM &&
    pair.publicKey.algorithm.name === ALGORITHM &&
    pair.privateKey.extractable === false &&
    pair.privateKey.usages.includes("sign") &&
    pair.publicKey.usages.includes("verify")
  );
}

/** Mint a fresh device identity. The PRIVATE half is non-extractable —
 * this is the only place that decides it, and every load re-checks it. */
function mint(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    ALGORITHM,
    /* extractable (private half) */ false,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/**
 * Persist a key pair under `id` in this device's namespace, replacing
 * whatever was there (idempotent under `id`).
 *
 * REFUSES AN EXTRACTABLE KEY. A stored key promises material that was
 * never readable; accepting an extractable one would quietly turn the
 * promise into a lie for every later loader — including `usableIdentity`,
 * which would then be discarding a key the caller thought it had saved.
 */
export async function persistIdentity(
  ns: DeviceNamespace,
  id: string,
  pair: CryptoKeyPair,
): Promise<void> {
  requireId(id);
  if (pair.privateKey.extractable) {
    throw new IdentityKeyError(
      "extractable",
      "an extractable signing key cannot be stored: a stored key promises material that was never readable",
    );
  }
  if (pair.privateKey.algorithm.name !== ALGORITHM) {
    throw new IdentityKeyError(
      "algorithm",
      `this store holds ${ALGORITHM} signing keys; this key is ${pair.privateKey.algorithm.name}`,
    );
  }
  await ns.put(STORE, id, pair);
}

/**
 * The identity stored under `id`, or `null` when this device holds no
 * usable one — including the case where it holds something that failed
 * validation, which is DISCARDED on the way out (with a warning: a
 * silent discard of a key the user's account depends on is exactly the
 * event that should be visible in a console when someone is debugging
 * "why am I a new device").
 */
export async function loadIdentity(
  ns: DeviceNamespace,
  id: string,
): Promise<CryptoKeyPair | null> {
  requireId(id);
  const stored = await ns.get<unknown>(STORE, id);
  if (stored === undefined) return null;
  if (!usableIdentity(stored)) {
    console.warn(
      `device-store: the identity entry ${JSON.stringify(id)} in ${ns.dbName} is not a usable ` +
        `non-extractable ${ALGORITHM} key pair; discarding it`,
    );
    await ns.delete(STORE, id);
    return null;
  }
  return stored;
}

/**
 * CREATE-OR-LOAD, RACE-FREE — the shape every caller actually wants.
 *
 * The race is not hypothetical: two tabs attaching to one device (or a
 * restored session opening several at once) both want the identity to
 * exist, and a read-then-write would mint two keys and let the later
 * write silently replace the identity the earlier one had already begun
 * signing with. That is an account-level bug — signatures under a key
 * nothing can produce again.
 *
 * The settle is wosh's `loadOrMint` (site/identity-store.ts:79 f.,
 * mirrored in spikes/worker-host/worker.ts:126-158): mint a CANDIDATE
 * first (key generation cannot happen inside a transaction — an `await`
 * on anything but an IndexedDB request lets the transaction commit out
 * from under you), then re-read INSIDE one readwrite transaction and let
 * that transaction pick the winner. IndexedDB serialises overlapping
 * readwrite transactions on a store, so exactly one caller sees an
 * absent entry there. The loser's candidate is simply dropped: minting a
 * key that is then discarded costs nothing but the entropy.
 *
 * A stored-but-invalid entry is discarded in the same transaction, so
 * the planted-junk case ends with a real key rather than a loop.
 */
export async function loadOrMintIdentity(
  ns: DeviceNamespace,
  id: string,
): Promise<{ pair: CryptoKeyPair; minted: boolean }> {
  requireId(id);
  const existing = await loadIdentity(ns, id);
  if (existing) return { pair: existing, minted: false };

  const candidate = await mint();
  return await withDb(ns.dbName, NS_STORES, "readwrite", async (tx) => {
    const store = tx.objectStore(STORE);
    const raced = await idbReq(store.get(id) as IDBRequest<unknown>);
    if (usableIdentity(raced)) return { pair: raced, minted: false };
    store.put(candidate, id);
    return { pair: candidate, minted: true };
  });
}

/** Forget one identity. (Forgetting the whole device is
 * `removeDevice`, which takes the database with it.) */
export function deleteIdentity(ns: DeviceNamespace, id: string): Promise<void> {
  requireId(id);
  return ns.delete(STORE, id);
}

function requireId(id: string): void {
  if (id === "") throw new IdentityKeyError("unavailable", "an identity id must not be empty");
}
