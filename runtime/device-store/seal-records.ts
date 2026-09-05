// THE SEAL'S RECORD SHAPES, AND NOTHING THAT PERFORMS CRYPTOGRAPHY.
//
// The KEK ladder, the DEK and the per-file format moved into the device
// seal COMPONENT (runtime/device-seal/, `polyvisor:device-seal@0.1.0`);
// seal-component.ts is the adapter that instantiates it. What stayed
// behind is this file: the structured-clone shapes those records take in
// IndexedDB, the keys they rest under, the typed refusal callers branch
// on, and the ONE reader that needs no key.
//
// WHY THE SHAPES ARE STILL SPELLED HERE. The component owns the ladder's
// rules; the HOST owns the codec (world.wit's `namespace`: "the host's
// job per function is a structured-clone object ↔ record mapping and
// nothing else"). A codec needs the shape it maps, and two consumers
// outside the adapter — passkey.ts and rpc.ts — need the enrollment type
// without instantiating anything. Keeping the declarations here rather
// than inside the adapter is what lets the page read a PRF enrollment
// with no wasm in the graph.
//
// ON-DISK FORMAT: UNCHANGED, and this is a requirement, not a
// convenience (world.wit:35-41). Every doc comment below is the one
// seal.ts carried, kept verbatim, because the rules they state are the
// rules the component now enforces and the codec must not quietly
// reinterpret. A device sealed before the port opens after it; the
// `legacy-unseal` matrix row is the fixture that proves it.

import type { DeviceNamespace } from "./namespace.ts";

/**
 * A refusal from the sealing layer, as a type rather than a string
 * match. Every failure here is one of a small closed set, and callers
 * (the unseal ceremony above all) must be able to tell "you typed the
 * wrong passphrase" from "this device has no passphrase rung" from
 * "these bytes have been tampered with" without parsing prose.
 *
 * SINCE THE PORT these codes are the lowered form of the component's
 * `seal-error` variant (world.wit's `types`), which is the same closed
 * set by construction — seal-component.ts's `sealErrorOf` is the one
 * place the mapping lives.
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

export const KEY_PASSPHRASE_WRAP = "wrap:passphrase";
export const KEY_PLATFORM_WRAP = "wrap:platform";
export const KEY_PLATFORM_KEK = "kek:platform";
export const KEY_PRF_WRAP = "wrap:prf";

/** The `seal` store, by name — the store every key above rests in. */
export const SEAL_STORE = "seal";
/** The `sealed` store: the key/value surface under the DEK. */
export const SEALED_STORE = "sealed";
/** The `identity` store: the device's persisted signing handles. */
export const IDENTITY_STORE = "identity";

export interface PassphraseWrap {
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
   *
   * The COMPONENT owns that rule now (`option<passphrase-origin>` with
   * `none` reading as `generated`); the codec's whole job is to let an
   * absent field cross as `none` rather than inventing a default here.
   */
  origin?: "user" | "generated";
}

export interface PlatformWrap {
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
export interface PrfWrap {
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

/** AES-GCM's IV: 96 bits, FRESH PER WRITE. Reuse under one key is the
 * failure mode that loses both confidentiality and integrity for GCM,
 * so it is generated at the write and stored beside the ciphertext,
 * never derived from the key name or a counter. */
export interface SealedValue {
  v: 1;
  iv: Uint8Array;
  ct: Uint8Array;
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
 * IT STAYED IN TYPESCRIPT, and deliberately: PERSISTENCE.md's "Unseal"
 * has the PAGE read this record before anything is open, to decide
 * whether to offer the passkey button at all. Nothing here is
 * cryptographic — it is the wrap record minus its only secret-adjacent
 * field — so routing it through the component would mean instantiating
 * a seal to answer a question about whether to offer a button. The
 * component's own `get-prf-enrollment` serves the WORKER's copy of the
 * same question; this serves the page's.
 *
 * VALIDATE-ON-LOAD: the `seal` store is writable by anything else on
 * this origin, so a record read back out is untrusted input. A malformed
 * one is refused as `tampered` rather than handed to a ceremony that
 * would then ask an authenticator to evaluate whatever bytes were
 * planted in it.
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
 * Load the PRF wrap and validate its shape. The salts are pinned at the
 * length this construction writes (32 bytes): a planted 1-byte input
 * would otherwise reach an authenticator ceremony before anything
 * refused it.
 */
async function readPrfWrap(ns: DeviceNamespace): Promise<PrfWrap | undefined> {
  const rec = await ns.get<PrfWrap>(SEAL_STORE, KEY_PRF_WRAP);
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
