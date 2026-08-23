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
//   passkey        the DEK wrapped under a KEK derived from a WebAuthn
//                  PRF output — HKDF-SHA-256 → AES-KW, the passphrase
//                  rung's ladder with the human secret replaced by a
//                  credential the authenticator gates behind presence
//                  plus verification. The CEREMONY IS NOT HERE: it
//                  cannot be, because `navigator.credentials` is
//                  window-only. This module only ever sees the derived
//                  KEK handle (passkey.ts is the window half; the
//                  design record is PERSISTENCE.md's "The PRF rung:
//                  passkey unseal").
//
// Argon2 is a RECORDED FUTURE RUNG, not this module's: each wrap record
// carries a `kdf` tag so a later rung can be told apart from these
// rather than guessed at.

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
      /** The passkey ceremony ran and the KEK it derived did not open
       * the wrap — a wrong credential, a wrong PRF input, or a wrap
       * record copied in from another device. Indistinguishable by
       * construction, exactly as `wrong-passphrase` is. */
      | "wrong-passkey"
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
const KEY_PRF_WRAP = "wrap:prf";

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
  /**
   * WHETHER ANYBODY KNOWS THIS PASSPHRASE.
   *
   * `user` — a person chose it and can type it again. `generated` — it
   * was minted from random bytes and dropped on the floor, which is how
   * a T0 device is sealed with no ceremony (worker.ts's `sealT0`: "a
   * door with no key").
   *
   * IT HAS TO BE RECORDED, because the two are otherwise
   * indistinguishable: `sealState` can say a passphrase rung EXISTS but
   * not that it is reachable, and the index's policy tag does not answer
   * it either — a device may sit on `until-reseal` and ALSO have the
   * user's own passphrase (that is what `enableUntilReseal` being
   * ADDITIVE means). Deleting the platform wrap on a device whose only
   * rung is `generated` would destroy it, so the ceremony that deletes
   * that wrap needs this bit to know whether to ask for a replacement
   * first.
   *
   * ABSENT MEANS `generated`, deliberately: the failure modes are not
   * symmetric. Reading an unmarked rung as reachable risks destroying a
   * device; reading it as unreachable costs one ceremony nobody needed.
   */
  origin?: "user" | "generated";
}

interface PlatformWrap {
  v: 1;
  /** The DEK wrapped with AES-KW under the non-extractable platform
   * key stored beside it. */
  wrapped: Uint8Array;
}

/**
 * THE PASSKEY RUNG'S RECORD (PERSISTENCE.md, "The PRF rung: passkey
 * unseal"). A sibling of `PassphraseWrap`, with the same at-rest
 * posture and a different honest sentence.
 *
 * WHAT A READER OF THIS STORE LEARNS, stated as plainly as the
 * passphrase wrap's exposure is stated above: that the device has a
 * passkey rung; WHICH credential opens it (`credentialId` plus the
 * `transports` routing hints and the `rpId` — an identifier and where
 * to look for it, not secrets); the two fresh-random 32-byte salts;
 * and 40-odd bytes of wrapped key. Unlike the passphrase wrap there is
 * NO HUMAN-CHOSEN SECRET behind those bytes to guess at offline: the
 * key material rests in the authenticator, which demands presence and
 * verification per ceremony, so possession of this record is not the
 * start of an attack the way a passphrase wrap is.
 *
 * NO `origin` FIELD, deliberately, and the absence is load-bearing.
 * `PassphraseWrap` needs one because a passphrase rung may be a door
 * with no key (`sealT0`'s generated wrap). A PRF rung cannot be: it
 * only ever exists because a person ran an enrollment ceremony on an
 * authenticator they hold, so it is ALWAYS a door somebody can walk
 * through. That is the fact the reseal-upgrade guard consults
 * (worker.ts's `reseal`), and it is true by construction rather than
 * by a recorded bit.
 */
interface PrfWrap {
  v: 1;
  /** Names THIS construction, so a later rung (a rotated input, a
   * different KDF) is told apart rather than guessed at — the `kdf`
   * tag's job on the passphrase wrap too. */
  kdf: "prf-hkdf-sha-256";
  credentialId: Uint8Array;
  transports?: string[];
  rpId: string;
  /** The 32 random bytes handed to the PRF extension as `eval.first`.
   * Fresh per wrap; not a secret (the authenticator's per-credential
   * key is what makes the output unpredictable). */
  prfInput: Uint8Array;
  /** HKDF's salt, 32 fresh random bytes. */
  hkdfSalt: Uint8Array;
  /** The DEK wrapped with AES-KW under the derived KEK. */
  wrapped: Uint8Array;
}

/**
 * What the PAGE hands the worker beside the KEK at enrollment, and
 * what it reads back (`getPrfEnrollment`) to run an unseal assertion.
 *
 * It is `PrfWrap` MINUS the wrapped bytes: the ceremony half of the
 * record and nothing that a page has any use for. The page cannot
 * unwrap anyway — the DEK never crosses to it — so handing it the wrap
 * would be exposure bought for nothing.
 */
export interface PrfEnrollment {
  credentialId: Uint8Array;
  transports?: string[];
  rpId: string;
  prfInput: Uint8Array;
  hkdfSalt: Uint8Array;
}

/** What rungs this device actually has — the picker's question, asked
 * without opening anything. */
export interface SealState {
  /** A passphrase rung EXISTS. It says nothing about whether anybody
   * knows the passphrase — see `userPassphrase`. */
  passphrase: boolean;
  /** A passphrase rung exists AND a person chose it, so it is a door
   * somebody can actually walk through. This is the bit a ceremony that
   * deletes the platform wrap has to consult (`PassphraseWrap.origin`). */
  userPassphrase: boolean;
  /** This device auto-unseals from the platform key until reseal. */
  untilReseal: boolean;
  /** This device has a passkey rung. Unlike `passphrase`, this bit
   * needs no companion "does anybody know it": a PRF rung is always
   * reachable by whoever holds the authenticator (see `PrfWrap`). */
  prf: boolean;
}

export async function sealState(ns: DeviceNamespace): Promise<SealState> {
  const [p, k, r] = await Promise.all([
    ns.get<PassphraseWrap>("seal", KEY_PASSPHRASE_WRAP),
    ns.get<PlatformWrap>("seal", KEY_PLATFORM_WRAP),
    ns.get<PrfWrap>("seal", KEY_PRF_WRAP),
  ]);
  return {
    passphrase: p !== undefined,
    userPassphrase: p !== undefined && p.origin === "user",
    untilReseal: k !== undefined,
    prf: r !== undefined,
  };
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
  /** Whether a PERSON chose `passphrase`. `generated` is for the
   * no-ceremony T0 seal and nothing else — see `PassphraseWrap.origin`
   * for why the distinction has to be durable. */
  origin: "user" | "generated" = "user",
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
    origin,
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
    // A person chose this one, whatever the rung it replaces was.
    origin: "user",
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
 * THE PROMOTION SEAM: give this device a passphrase rung it did not
 * choose for itself, authorized by the PLATFORM rung it already has.
 *
 * WHY IT HAS TO EXIST, and why `rekeyPassphrase` could not do the job.
 * A T0 device is sealed with no ceremony (worker.ts's `sealT0`): the
 * passphrase rung it carries was minted from 32 random bytes that were
 * then dropped on the floor, so nobody — including this worker after a
 * reload — can reproduce it. When the user later says "keep this
 * device" and chooses `every-session`, the DEK has to be re-wrapped
 * under THEIR passphrase, and there is no old passphrase to present.
 * The DEK handle the worker is holding cannot stand in for one either:
 * every handle this module hands out is `extractable: false`, and
 * `wrapKey` needs an extractable key. So the authorization comes from
 * the one door that IS open on a T0 device — the platform wrap.
 *
 * WHAT THIS IS AUTHORIZED BY, stated plainly: possession of the
 * profile. That is exactly the `until-reseal` tier's honest strength
 * (PERSISTENCE.md's ladder), and it is not a widening: anything that
 * can call this could equally call `unsealFromPlatform` and read the
 * device. It refuses outright when the platform rung is absent, so a
 * device that has already been resealed cannot be re-keyed this way —
 * that one needs its passphrase, which is what reseal is for.
 *
 * The salt rotates and the DEK does not, for `rekeyPassphrase`'s
 * reasons. The single write lands after every fallible step.
 */
export async function rekeyFromPlatform(
  ns: DeviceNamespace,
  newPassphrase: string,
): Promise<void> {
  requirePassphrase(newPassphrase);
  const dek = await wrappableDekFromPlatform(ns);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const kek = await kekFromPassphrase(newPassphrase, salt, PBKDF2_ITERATIONS);
  const record: PassphraseWrap = {
    v: 1,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt,
    wrapped: await wrapDek(dek, kek),
    // THE POINT OF THIS CEREMONY: what it leaves behind is a rung
    // somebody knows, where a moment ago there was only a door with no
    // key.
    origin: "user",
  };
  await ns.put("seal", KEY_PASSPHRASE_WRAP, record);
}

/**
 * The platform rung's `wrappableDek`. Same discipline as that one: the
 * extractable handle is a LOCAL of the ceremony that needs it, the raw
 * bytes never enter JS, and nothing in this repo calls `exportKey`
 * (demo/scripts/check-invariants.sh invariant (d)).
 */
async function wrappableDekFromPlatform(ns: DeviceNamespace): Promise<CryptoKey> {
  const [rec, kek] = await Promise.all([
    ns.get<PlatformWrap>("seal", KEY_PLATFORM_WRAP),
    ns.get<CryptoKey>("seal", KEY_PLATFORM_KEK),
  ]);
  if (!rec || !kek) {
    throw new SealError("no-rung", "this device has no platform rung to re-key from");
  }
  // Validate-on-load, for `unsealFromPlatform`'s reason: a planted
  // EXTRACTABLE key here would be an attacker's handle we then used to
  // unwrap the DEK.
  if (!(kek instanceof CryptoKey) || kek.extractable !== false || kek.algorithm.name !== "AES-KW") {
    throw new SealError(
      "tampered",
      "the persisted platform key is not a usable non-extractable AES-KW key",
    );
  }
  try {
    return await unwrapDek(rec.wrapped, kek, true);
  } catch {
    throw new SealError("tampered", "the platform wrap did not open");
  }
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

// --- the `passkey` rung -----------------------------------------------------
//
// THE WORKER'S HALF, AND ONLY THAT HALF. WebAuthn cannot run here
// (`navigator.credentials` is window-only), so the assertion runs on the
// PAGE, the page derives the KEK, and what reaches this module is the
// NON-EXTRACTABLE AES-KW handle — a CryptoKey structured-clones through
// `postMessage` exactly as it does into IndexedDB (spikes/prf-unseal,
// row 9). The raw PRF output never comes near this module.

/**
 * VALIDATE THE CROSSED KEK BEFORE USING IT — the same refusal
 * `unsealFromPlatform` makes about a persisted platform key, for the
 * same reason wearing different clothes.
 *
 * A key that arrived from somewhere else is untrusted input. There it
 * arrives from IndexedDB, which anything on this origin may write; here
 * it arrives over the port from the page, which anything running on this
 * origin may hold. Either way an EXTRACTABLE key, or one whose algorithm
 * is not AES-KW, is not the handle this ceremony was designed around, and
 * using it anyway would mean wrapping the device's DEK under something
 * whose material can be read back. So it is refused as `tampered` rather
 * than coerced.
 *
 * Both usages matter and both are checked at the operation, not here:
 * enrollment needs `wrapKey`, unseal needs `unwrapKey`, and passkey.ts
 * derives with both — WebCrypto raises on a usage the key does not have,
 * which is a refusal in its own right.
 */
function requirePrfKek(kek: CryptoKey): void {
  if (!(kek instanceof CryptoKey) || kek.extractable !== false || kek.algorithm.name !== "AES-KW") {
    throw new SealError(
      "tampered",
      "the passkey KEK handed to this ceremony is not a usable non-extractable AES-KW key",
    );
  }
}

/**
 * The ceremony metadata the page needs to run an unseal assertion:
 * which credential, where to look for it, and the PRF input to ask it
 * to evaluate. The WRAPPED BYTES ARE NOT RETURNED — the page has no use
 * for them and no way to open them.
 *
 * `undefined` when this device has no passkey rung, which is the normal
 * case rather than an error (the picker asks this to decide whether to
 * offer the button).
 *
 * VALIDATE-ON-LOAD, for `unsealFromPlatform`'s reason: the `seal` store
 * is writable by anything else on this origin, so a record read back out
 * is untrusted input. A malformed one is refused as `tampered` rather
 * than handed to a ceremony that would then ask an authenticator to
 * evaluate whatever bytes were planted in it.
 */
export async function getPrfEnrollment(
  ns: DeviceNamespace,
): Promise<PrfEnrollment | undefined> {
  const rec = await readPrfWrap(ns);
  if (!rec) return undefined;
  const out: PrfEnrollment = {
    credentialId: rec.credentialId,
    rpId: rec.rpId,
    prfInput: rec.prfInput,
    hkdfSalt: rec.hkdfSalt,
  };
  if (rec.transports?.length) out.transports = rec.transports;
  return out;
}

/**
 * Load the PRF wrap and validate its shape — the ONE reader both
 * ceremonies go through, so a planted record is refused identically
 * whether the page is about to run an assertion or the worker is about
 * to unwrap. The salts are pinned at the length this construction
 * writes (32 bytes): a planted 1-byte input would otherwise reach an
 * authenticator ceremony before anything refused it.
 */
async function readPrfWrap(ns: DeviceNamespace): Promise<PrfWrap | undefined> {
  const rec = await ns.get<PrfWrap>("seal", KEY_PRF_WRAP);
  if (!rec) return undefined;
  const bytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.length > 0;
  const salt = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.length === 32;
  const ok = rec.v === 1 && rec.kdf === "prf-hkdf-sha-256" &&
    bytes(rec.credentialId) && salt(rec.prfInput) && salt(rec.hkdfSalt) &&
    bytes(rec.wrapped) &&
    typeof rec.rpId === "string" && rec.rpId.length > 0 &&
    (rec.transports === undefined ||
      (Array.isArray(rec.transports) && rec.transports.every((t) => typeof t === "string")));
  if (!ok) throw new SealError("tampered", "this device's passkey rung record is not readable");
  return rec;
}

/**
 * ADD THE PASSKEY RUNG: re-wrap this device's DEK under a KEK the page
 * derived from a passkey's PRF output.
 *
 * WHAT AUTHORIZES IT, stated as plainly as `rekeyFromPlatform` states
 * its own. Preferentially the PLATFORM rung — a device at the promotion
 * moment always has one, and its existing passphrase rung may well be
 * the door with no key `sealT0` left behind. That authorization is
 * possession of the profile, which is exactly the `until-reseal` tier's
 * honest strength and not a widening: anything that could call this
 * could equally call `unsealFromPlatform` and read the device. When the
 * platform rung is gone (a resealed device being switched to passkey
 * unseal on the this-device sheet) the authority is the PASSPHRASE,
 * which the sheet asks for and which is that device's login anyway.
 * With neither, this refuses — there is no third authority, and a
 * ceremony that re-wrapped a DEK on nobody's say-so would be one.
 *
 * IT DOES NOT DELETE THE PLATFORM WRAP. Shutting that door is the
 * caller's half, exactly as it is for `every-session` (worker.ts's
 * `promote` calls `reseal` after this returns): the decision "a user who
 * asked to be asked must not leave a silent door standing" belongs to
 * the ceremony that knows what the user chose, not to the re-wrap.
 *
 * ONE WRITE, after every fallible step has already succeeded — the
 * assertion, the derivation, the unwrap and the re-wrap all happen
 * first, so a failed enrollment leaves the device exactly as it was.
 */
export async function enablePrf(
  ns: DeviceNamespace,
  kek: CryptoKey,
  enrollment: PrfEnrollment,
  authz: { passphrase?: string },
): Promise<void> {
  requirePrfKek(kek);
  const rungs = await sealState(ns);
  let dek: CryptoKey;
  if (rungs.untilReseal) {
    dek = await wrappableDekFromPlatform(ns);
  } else if (authz.passphrase !== undefined) {
    dek = await wrappableDek(ns, authz.passphrase);
  } else {
    throw new SealError(
      "no-rung",
      "enrolling a passkey needs an authority: this device has no platform rung, " +
        "and no passphrase was offered",
    );
  }
  const record: PrfWrap = {
    v: 1,
    kdf: "prf-hkdf-sha-256",
    credentialId: enrollment.credentialId,
    rpId: enrollment.rpId,
    prfInput: enrollment.prfInput,
    hkdfSalt: enrollment.hkdfSalt,
    wrapped: await wrapDek(dek, kek),
  };
  if (enrollment.transports?.length) record.transports = enrollment.transports;
  await ns.put("seal", KEY_PRF_WRAP, record);
}

/**
 * THE LOGIN, passkey flavour: open the device with the KEK the page
 * derived from a fresh assertion. The returned handle is
 * non-extractable and is the whole unsealed state, exactly as
 * `unsealWithPassphrase`'s is.
 *
 * A FAILED UNWRAP IS ONE BIT, deliberately. AES-KW's integrity check
 * fails inside WebCrypto and no partial key ever exists to be mistaken
 * for a real one, so "a different credential answered", "the PRF input
 * was not the one this wrap was made with" and "this record was copied
 * in from another device" are indistinguishable here — the same
 * property that makes a wrong passphrase a clean refusal. The last of
 * those three is why the derivation binds the device id into HKDF's
 * `info` (passkey.ts): a wrap carried between namespaces refuses HERE,
 * as a typed `wrong-passkey`, instead of opening a foreign DEK and
 * surfacing as GCM tamper noise somewhere downstream.
 */
export async function unsealWithPrf(ns: DeviceNamespace, kek: CryptoKey): Promise<CryptoKey> {
  // The validated reader, so a MALFORMED record refuses as `tampered`
  // here too — "someone altered the record" and "the right record, the
  // wrong key" are different facts and get different codes.
  const rec = await readPrfWrap(ns);
  if (!rec) throw new SealError("no-rung", "this device has no passkey rung");
  requirePrfKek(kek);
  try {
    return await unwrapDek(rec.wrapped, kek, false);
  } catch {
    // Nothing was written and nothing cached; the caller learns exactly
    // one bit.
    throw new SealError("wrong-passkey", "that passkey did not open this device");
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
 *
 * THE PASSKEY WRAP SURVIVES, and that is the design record's ruling
 * (PERSISTENCE.md, "The PRF rung", "Reseal"): an assertion per unseal is
 * that rung's whole point, so what it leaves behind opens nothing on its
 * own — there is no door here to shut.
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
