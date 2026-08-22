// SEALING: the per-device DEK and the KEK ladder (PERSISTENCE.md,
// "Sealing").
//
// One data key per device — AES-GCM-256, random — under which the
// device's bulk state rests: keyhive archive, checkpoint blobs, us-doc
// working state, visor cache. Everything above this module (the sealed
// KV surface below, sealed-fs.ts) encrypts with that one key; this
// module's job is only to decide WHO can get it back, and how often
// they have to prove it.
//
// THE DEK'S RAW BYTES NEVER ENTER JS. It is generated inside WebCrypto,
// wrapped with `wrapKey` and recovered with `unwrapKey`; both operations
// keep the material on the platform's side of the boundary. Every DEK
// handle this module HANDS OUT is `extractable: false`, so the next
// track can park one in worker memory (the `while-open` rung) without
// that handle being a bearer secret. The one exception is spelled out
// at `wrappableDek` — a ceremony that re-wraps has to be able to wrap.
//
// KEK LADDER, v1 (the table in PERSISTENCE.md, "Sealing"):
//
//   every-session  passphrase → PBKDF2-SHA-256 → AES-KW over the DEK.
//                  The real tier. Nothing persisted can open it.
//   while-open     not this track's: the unwrapped DEK is simply held
//                  in the worker and dies with it. What this module
//                  contributes is that the handle it returns is safe to
//                  hold (non-extractable).
//   until-reseal   the DEK additionally wrapped by a NON-EXTRACTABLE
//                  platform key living as a structured-cloned handle in
//                  the namespace. See `enableUntilReseal` for the
//                  honest sentence.
//
// Argon2 and the WebAuthn PRF rung are RECORDED FUTURE RUNGS, not this
// track's: the wrap record carries a `kdf` tag so a later rung can be
// told apart from this one rather than guessed at.

import type { DeviceNamespace } from "./namespace.ts";

/**
 * A refusal from the sealing layer, as a type rather than a string
 * match. Every failure here is one of a small closed set, and callers
 * (the unseal ceremony above all) must be able to tell "you typed the
 * wrong passphrase" from "this device has no passphrase rung" from
 * "these bytes have been tampered with" without parsing prose.
 */
export class SealError extends Error {
  constructor(
    readonly code:
      | "wrong-passphrase"
      | "no-rung"
      | "already-sealed"
      | "tampered"
      | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "SealError";
  }
}

// --- the stored shapes ------------------------------------------------------
//
// All three live in the namespace's `seal` store, which rests UNSEALED
// (it is what the seal is made of). A reader of this store learns: that
// the device has a passphrase rung, its KDF parameters, and 40-odd bytes
// of wrapped key. That is the whole exposure, and it is the exposure the
// passphrase's strength is measured against.

const KEY_PASSPHRASE_WRAP = "wrap:passphrase";
const KEY_PLATFORM_WRAP = "wrap:platform";
const KEY_PLATFORM_KEK = "kek:platform";

/** PBKDF2 parameters, v1. 600k iterations is OWASP's 2023 floor for
 * PBKDF2-HMAC-SHA-256; the salt is 16 fresh random bytes per wrap, so
 * two devices (and two re-keys of one device) never share a derivation.
 * These are RECORDED IN THE RECORD, not assumed at read time, so
 * raising the count later does not orphan existing devices. */
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;

interface PassphraseWrap {
  v: 1;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: Uint8Array;
  /** The DEK wrapped with AES-KW under the derived KEK. */
  wrapped: Uint8Array;
}

interface PlatformWrap {
  v: 1;
  /** The DEK wrapped with AES-KW under the non-extractable platform
   * key stored beside it. */
  wrapped: Uint8Array;
}

/** What rungs this device actually has — the picker's question, asked
 * without opening anything. */
export interface SealState {
  /** A passphrase can open this device. */
  passphrase: boolean;
  /** This device auto-unseals from the platform key until reseal. */
  untilReseal: boolean;
}

export async function sealState(ns: DeviceNamespace): Promise<SealState> {
  const [p, k] = await Promise.all([
    ns.get<PassphraseWrap>("seal", KEY_PASSPHRASE_WRAP),
    ns.get<PlatformWrap>("seal", KEY_PLATFORM_WRAP),
  ]);
  return { passphrase: p !== undefined, untilReseal: k !== undefined };
}

// --- the DEK ----------------------------------------------------------------

const DEK_ALGORITHM = { name: "AES-GCM", length: 256 } as const;
const KW = { name: "AES-KW" } as const;

/**
 * AES-KW, not AES-GCM, for both wraps.
 *
 * Two reasons. It is deterministic, so a wrap needs no IV stored beside
 * it and no IV-reuse hazard exists across re-wraps of the same key. And
 * it is authenticated by construction (RFC 3394's integrity check
 * value), which is what turns a wrong passphrase into a CLEAN REFUSAL:
 * the unwrap fails inside WebCrypto and no partial key ever exists to
 * be mistaken for a real one. A wrong passphrase and a corrupted wrap
 * are indistinguishable here, deliberately — neither tells an attacker
 * anything about the other.
 */
async function kekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    // `length` is REQUIRED for a derived AES key even though AES-KW-256
    // is implied by the usages: Chromium throws
    // "AesDerivedKeyParams: length: Missing required property" without
    // it (observed, first run of the probe matrix).
    { name: "AES-KW", length: 256 },
    // The KEK itself is never read back either; it exists to wrap.
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Recover the DEK as a handle the caller may HOLD but not read. This
 * is what every unseal path returns. */
function unwrapDek(wrapped: Uint8Array, kek: CryptoKey, extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    wrapped as BufferSource,
    kek,
    KW,
    DEK_ALGORITHM,
    extractable,
    ["encrypt", "decrypt"],
  );
}

const wrapDek = async (dek: CryptoKey, kek: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.wrapKey("raw", dek, kek, KW));

/**
 * THE ONE PLACE A WRAPPABLE DEK EXISTS.
 *
 * `wrapKey` exports the key internally, so a key that is to be wrapped
 * must have been created `extractable: true`. Every ceremony that adds
 * or rotates a rung therefore needs the DEK in that form for the length
 * of the ceremony and no longer. Two properties keep this honest:
 *
 *   * the wrappable handle is a LOCAL, dropped when the ceremony
 *     returns; what the caller gets back is always the non-extractable
 *     handle from `unwrapDek(..., false)`.
 *   * even here the raw bytes stay inside WebCrypto — `extractable:
 *     true` means `exportKey` WOULD work, not that anything calls it.
 *     Nothing in this repo calls it (demo/scripts/check-invariants.sh
 *     invariant (d) bans the verb outright).
 */
async function wrappableDek(ns: DeviceNamespace, passphrase: string): Promise<CryptoKey> {
  const rec = await ns.get<PassphraseWrap>("seal", KEY_PASSPHRASE_WRAP);
  if (!rec) throw new SealError("no-rung", "this device has no passphrase rung");
  const kek = await kekFromPassphrase(passphrase, rec.salt, rec.iterations);
  try {
    return await unwrapDek(rec.wrapped, kek, true);
  } catch {
    throw new SealError("wrong-passphrase", "the passphrase did not open this device");
  }
}

/**
 * Mint this device's DEK and seal it under a passphrase — the
 * `every-session` rung, and the promotion moment's default.
 *
 * REFUSES on a device that already has a rung rather than replacing it:
 * a second mint would produce a second DEK, and every byte written
 * under the first would become unreadable with no error anywhere. If a
 * caller genuinely wants a new device, that is `createDevice`.
 */
export async function createSealedDek(
  ns: DeviceNamespace,
  passphrase: string,
): Promise<CryptoKey> {
  if ((await sealState(ns)).passphrase) {
    throw new SealError("already-sealed", "this device already has a passphrase rung");
  }
  requirePassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const kek = await kekFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const dek = await crypto.subtle.generateKey(DEK_ALGORITHM, true, ["encrypt", "decrypt"]);
  const wrapped = await wrapDek(dek, kek);
  const record: PassphraseWrap = {
    v: 1,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt,
    wrapped,
  };
  await ns.put("seal", KEY_PASSPHRASE_WRAP, record);
  // Hand back the SAME key as a non-extractable handle rather than the
  // wrappable local: the caller is going to hold this for a session.
  return await unwrapDek(wrapped, kek, false);
}

/** An empty passphrase is not a rung, it is the absence of one wearing
 * a rung's costume. Refuse it at the door rather than deriving a KEK
 * anyone can reproduce. */
function requirePassphrase(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new SealError("unsupported", "an empty passphrase cannot seal a device");
  }
}

/**
 * THE LOGIN: open the device with the passphrase. The returned handle
 * is non-extractable and is the whole unsealed state — dropping it
 * re-seals the device as far as this tab is concerned.
 */
export async function unsealWithPassphrase(
  ns: DeviceNamespace,
  passphrase: string,
): Promise<CryptoKey> {
  const rec = await ns.get<PassphraseWrap>("seal", KEY_PASSPHRASE_WRAP);
  if (!rec) throw new SealError("no-rung", "this device has no passphrase rung");
  const kek = await kekFromPassphrase(passphrase, rec.salt, rec.iterations);
  try {
    return await unwrapDek(rec.wrapped, kek, false);
  } catch {
    // No partial state: nothing was written, nothing was cached, and
    // the caller learns exactly one bit.
    throw new SealError("wrong-passphrase", "the passphrase did not open this device");
  }
}

/**
 * Change the passphrase. THE SALT ROTATES: a re-key that kept the old
 * salt would leave any precomputation against the old passphrase
 * partly valid against the new one, and would make the two wraps
 * visibly related in a store that rests in the clear.
 *
 * The DEK itself does NOT rotate, and that is deliberate: rotating it
 * would mean re-encrypting every sealed byte the device holds, and the
 * threat this rung answers (someone has your profile and is guessing)
 * is answered by the new derivation, not by new data keys.
 */
export async function rekeyPassphrase(
  ns: DeviceNamespace,
  oldPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  requirePassphrase(newPassphrase);
  const dek = await wrappableDek(ns, oldPassphrase);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const kek = await kekFromPassphrase(newPassphrase, salt, PBKDF2_ITERATIONS);
  const record: PassphraseWrap = {
    v: 1,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt,
    wrapped: await wrapDek(dek, kek),
  };
  // One write, after every fallible step has already succeeded: a
  // failed re-key leaves the old passphrase working.
  await ns.put("seal", KEY_PASSPHRASE_WRAP, record);
}

// --- the `until-reseal` rung ------------------------------------------------

/**
 * Turn on auto-unseal until the user explicitly reseals.
 *
 * THE HONEST SENTENCE, and the UI must say it: this is LOGIN
 * CONVENIENCE, NOT PROTECTION AGAINST SOMEONE HOLDING YOUR PROFILE. The
 * wrapping key is a non-extractable platform key, so the DEK cannot be
 * lifted out of the browser profile as bytes — but anything that can
 * run script on this origin in this profile can ask the platform to
 * unwrap, exactly as the app does. The tier therefore degrades to
 * profile access control (PERSISTENCE.md's ladder table), and `reseal`
 * deletes the wrap.
 *
 * It is ADDITIVE: the passphrase rung stays, because it is the only
 * thing that can open the device after a reseal.
 */
export async function enableUntilReseal(
  ns: DeviceNamespace,
  passphrase: string,
): Promise<void> {
  const dek = await wrappableDek(ns, passphrase);
  // Non-extractable, structured-cloned into the namespace: the wosh
  // handle-persistence pattern (identity-keys.ts documents it at
  // length). `wrapKey`/`unwrapKey` are its only usages — it cannot
  // encrypt data, only hold the DEK.
  const kek = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]) as CryptoKey;
  const wrapped = await wrapDek(dek, kek);
  // Handle first, then the wrap: the pair is only meaningful together,
  // and a wrap with no key is the state that would make `unsealFromPlatform`
  // report a rung it cannot actually use.
  await ns.put("seal", KEY_PLATFORM_KEK, kek);
  await ns.put("seal", KEY_PLATFORM_WRAP, { v: 1, wrapped } satisfies PlatformWrap);
}

/**
 * Auto-unseal, if this device has the `until-reseal` rung. Returns
 * `null` when it does not — a device that must be asked for its
 * passphrase is the normal case, not an error.
 */
export async function unsealFromPlatform(ns: DeviceNamespace): Promise<CryptoKey | null> {
  const [rec, kek] = await Promise.all([
    ns.get<PlatformWrap>("seal", KEY_PLATFORM_WRAP),
    ns.get<CryptoKey>("seal", KEY_PLATFORM_KEK),
  ]);
  if (!rec || !kek) return null;
  // Validate-on-load, for identity-keys.ts's reason: IndexedDB is
  // writable by anything else on this origin, so a stored key is
  // untrusted input on the way back in. A planted EXTRACTABLE key here
  // would be an attacker's handle we then used to unwrap the DEK.
  if (!(kek instanceof CryptoKey) || kek.extractable !== false || kek.algorithm.name !== "AES-KW") {
    throw new SealError("tampered", "the persisted platform key is not a usable non-extractable AES-KW key");
  }
  try {
    return await unwrapDek(rec.wrapped, kek, false);
  } catch {
    throw new SealError("tampered", "the platform wrap did not open");
  }
}

/**
 * RESEAL (PERSISTENCE.md, "Unseal UX"): delete the persisted wrap and
 * the platform key handle, so the next boot has to ask for the
 * passphrase again. Telling the worker to drop its key material is the
 * caller's other half — this is only the durable half.
 *
 * The handle goes too, not just the wrap. Leaving a non-extractable key
 * lying in the namespace would leave the thing whose existence the user
 * just asked to end.
 */
export async function reseal(ns: DeviceNamespace): Promise<void> {
  await ns.delete("seal", KEY_PLATFORM_WRAP);
  await ns.delete("seal", KEY_PLATFORM_KEK);
}

// --- the sealed key/value surface -------------------------------------------

/** AES-GCM's IV: 96 bits, FRESH PER WRITE. Reuse under one key is the
 * failure mode that loses both confidentiality and integrity for GCM,
 * so it is generated at the write and stored beside the ciphertext,
 * never derived from the key name or a counter. */
const IV_BYTES = 12;

interface SealedValue {
  v: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

/**
 * Seal `bytes` under the device's DEK and store them at `key`.
 *
 * THE KEY NAME IS ADDITIONAL AUTHENTICATED DATA. It is not secret (it
 * is the IndexedDB key, in the clear), but binding it means an attacker
 * with write access to the namespace cannot move a valid sealed value
 * from one name to another — a swap that would otherwise be undetectable
 * because every value is sealed under the same DEK.
 */
export async function sealedPut(
  ns: DeviceNamespace,
  dek: CryptoKey,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(key) },
      dek,
      bytes as BufferSource,
    ),
  );
  await ns.put("sealed", key, { v: 1, iv, ct } satisfies SealedValue);
}

/**
 * Open the sealed value at `key`, or `undefined` if there is none.
 *
 * A value that is present but does not open throws `SealError
 * "tampered"` rather than returning `undefined`: "nothing stored" and
 * "stored, and altered underneath us" are different facts and the
 * caller must not be able to confuse them by accident. GCM's tag is
 * what makes the second one detectable at all.
 */
export async function sealedGet(
  ns: DeviceNamespace,
  dek: CryptoKey,
  key: string,
): Promise<Uint8Array | undefined> {
  const rec = await ns.get<SealedValue>("sealed", key);
  if (!rec) return undefined;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: rec.iv as BufferSource, additionalData: aad(key) },
        dek,
        rec.ct as BufferSource,
      ),
    );
  } catch {
    throw new SealError("tampered", `the sealed value ${JSON.stringify(key)} did not open`);
  }
}

export function sealedDelete(ns: DeviceNamespace, key: string): Promise<void> {
  return ns.delete("sealed", key);
}

const aad = (key: string): BufferSource => new TextEncoder().encode(key) as BufferSource;
