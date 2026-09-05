// THE DEVICE SEAL, AS THE WORKER SEES IT: an adapter over the
// `polyvisor:device-seal@0.1.0` component (runtime/device-seal/).
//
// WHAT MOVED, AND WHAT THIS FILE IS. seal.ts's KEK ladder, sealed-fs.ts's
// per-file format and identity-keys.ts's signing handles are now Rust
// inside a component. This file instantiates it over ONE device's
// namespace and hands back typed wrappers. It performs no cryptography:
// every `crypto.subtle` call the three deleted modules made is now the
// component's, reached through `polymorph:webcrypto`.
//
// THE UNSEALED DEK EXISTS NOWHERE IN JAVASCRIPT (world.wit:13-18). No
// function below returns a key. Where the worker used to hold a
// `CryptoKey` in a variable and pass it to two modules, it now holds a
// `DeviceSeal` and asks it to seal and open bytes — there is no handle to
// export. `unsealed()` reports whether a DEK is parked; `forget()` drops
// it, exactly as dropping the old handle re-sealed the device.
//
// THE HOST'S JOB IS A CODEC WITH NO DECISIONS IN IT (world.wit:125-129).
// `namespaceImports` below maps structured-clone objects to WIT records
// field for field: `Uint8Array` ↔ `list<u8>`, an absent optional field ↔
// `none`, an absent `transports` ↔ the empty list. It applies no
// defaults and validates nothing — "absent origin means generated" is
// the COMPONENT's rule, and duplicating it here would be a second place
// for it to drift. The one judgement the contract DOES assign to the
// host is validate-on-load for key handles, and it is discharged by
// `fromCryptoKey`'s own refusals (world.wit:131-137).
//
// MODULE IDENTITY. `@polymorph/webcrypto-polyengine` is spelled with the
// SAME bare specifier engine.ts:13 uses, and for the reason worker.ts
// spells out at length (worker.ts:80-92): the key wrappers minted here
// must land in the same class family the component's own webcrypto
// imports serve. A second copy of the package would mint wrappers the
// port does not recognize.

import {
  artifactsFromEnvelope,
  type InstantiateSource,
  instantiate,
} from "@polyengine/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import {
  KwKey,
  SigningKey,
  VerifyingKey,
  webcryptoImports,
} from "@polymorph/webcrypto-polyengine";
import { isComponentException } from "@polyengine/protocol";
import { idbReq, withDb } from "./idb.ts";
import { type DeviceNamespace, NS_STORES } from "./namespace.ts";
import {
  IDENTITY_STORE,
  KEY_PASSPHRASE_WRAP,
  KEY_PLATFORM_KEK,
  KEY_PLATFORM_WRAP,
  KEY_PRF_WRAP,
  type PassphraseWrap,
  type PlatformWrap,
  type PrfEnrollment,
  type PrfWrap,
  SEAL_STORE,
  SEALED_STORE,
  SealError,
  type SealedValue,
  type SealState,
} from "./seal-records.ts";

// --- the interface ids ------------------------------------------------------

const I_TYPES = "polyvisor:device-seal/types@0.1.0";
const I_NAMESPACE = "polyvisor:device-seal/namespace@0.1.0";
const I_SEAL = "polyvisor:device-seal/seal@0.1.0";
const I_SEALED = "polyvisor:device-seal/sealed@0.1.0";
const I_IDENTITY = "polyvisor:device-seal/identity@0.1.0";

/** Which persisted signing identity — the WIT `identity-slot` enum, whose
 * two case names ARE the IndexedDB keys identity-keys.ts used
 * (`device-signing`, `device-endpoint`). The store stayed keyed by the
 * same strings, so the slot needs no translation table. */
export type IdentitySlot = "device-signing" | "device-endpoint";

/** A pair as the port's own wrappers, which is what the engine's
 * `device-identity` fragment wants: the SAME host module serves this
 * component and the engine, so the handoff is a no-op. */
export type IdentityPair = [SigningKey, VerifyingKey];

/**
 * The sealing surface the OPFS proxy needs, and nothing more — what
 * `sealedDirectory` is given in place of the DEK it used to take.
 */
export interface FileSealer {
  sealFile(plaintext: Uint8Array): Promise<Uint8Array>;
  openFile(sealed: Uint8Array): Promise<Uint8Array>;
}

/** One device's seal: the ladder, the sealed KV and file surface, and
 * the device's signing handles. */
export interface DeviceSeal {
  /** Which rungs this device HAS, asked without opening anything. */
  state(): Promise<SealState>;
  /**
   * Whether a DEK is parked — the successor to the worker's
   * `dek !== null`, and SYNCHRONOUS as that test was.
   *
   * IT DOES NOT CALL THE COMPONENT, and the contract is what says it
   * need not. `unsealed` is declared `func() -> bool`, but on polyengine
   * hosts EVERY export is Promise-shaped — "a host reading it as a
   * synchronous boolean gets a truthy Promise and an always-unsealed
   * device", and "a host with synchronous call sites mirrors the parked
   * bit itself from the five paths that change it" (world.wit:250-258).
   * Several of this predicate's call sites ARE synchronous by
   * construction (timer arming, `status()`'s sync half), so this is that
   * host.
   *
   * The mirror is exact by construction rather than by hope: those five
   * paths are the four ceremonies that succeed into a parked DEK
   * (component.rs's `state::park` — create, the two unseals, and the
   * platform open when it answers true) and `forget`. Every one is a
   * wrapper below, and each updates the mirror as it returns. `state()`
   * remains the component's answer to the DURABLE question; this is only
   * "is one parked HERE, NOW".
   */
  unsealed(): boolean;
  /**
   * THE SEAL GENERATION, for the races the worker's `dek` identity used
   * to settle — incremented on every park and every forget.
   *
   * The WIT offers `unsealed()` (a bool) and blesses a host mirror of
   * the parked bit (world.wit, `seal.unsealed`); this is that mirror
   * carrying one more bit of history. The worker held a `CryptoKey` and
   * compared it BY IDENTITY — `if (dek !== key) return`
   * after an await, which is how a background cycle notices the device
   * was resealed and re-unsealed underneath it (worker.ts's
   * `syncMayRun`). A bool cannot express that: sealed→unsealed→sealed
   * reads as `true` at both ends. So the adapter counts parks and
   * forgets and hands out the count. It is bookkeeping ABOUT the
   * component, not a widening of it — no key, no capability, and the
   * component is not consulted.
   */
  epoch(): number;

  /** Mint the DEK and seal it under a passphrase (the `every-session`
   * rung). Refuses `already-sealed` rather than replacing. */
  createSealedDek(passphrase: string, origin?: "user" | "generated"): Promise<void>;
  /** THE LOGIN. Parks the DEK. */
  unsealWithPassphrase(passphrase: string): Promise<void>;
  /** Re-wrap under a new passphrase; the salt rotates, the DEK does not. */
  rekeyPassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  /** Arm `until-reseal`. ADDITIVE — the passphrase rung stays. */
  enableUntilReseal(passphrase: string): Promise<void>;
  /** Give a platform-rung device a passphrase it did not have. */
  rekeyFromPlatform(newPassphrase: string): Promise<void>;
  /** Open from the platform wrap. `false` when there is no platform rung
   * — the normal case, not an error. */
  unsealFromPlatform(): Promise<boolean>;
  /** The PRF rung's ceremony half, for the page's assertion. */
  getPrfEnrollment(): Promise<PrfEnrollment | undefined>;
  /** Enrol a passkey rung under the page-derived KEK. */
  enablePrf(kek: CryptoKey, enrollment: PrfEnrollment, passphrase?: string): Promise<void>;
  /** Open with the page-derived KEK. Parks the DEK. */
  unsealWithPrf(kek: CryptoKey): Promise<void>;
  /** Delete the platform wrap and its key. The passphrase and PRF wraps
   * SURVIVE. */
  reseal(): Promise<void>;
  /** Drop the parked DEK. The namespace is untouched. Awaited because it
   * IS a component call, whatever the WIT's `func` suggests. */
  forget(): Promise<void>;

  /** Spending the parked DEK: the sealed KV surface and the per-file
   * sealing the OPFS proxy calls. */
  readonly sealed: FileSealer & {
    put(key: string, bytes: Uint8Array): Promise<void>;
    get(key: string): Promise<Uint8Array | undefined>;
    delete(key: string): Promise<void>;
  };

  /** The device's signing handles, as the port's own wrappers. */
  readonly identity: {
    loadOrMint(slot: IdentitySlot): Promise<IdentityPair>;
    load(slot: IdentitySlot): Promise<IdentityPair | undefined>;
    delete(slot: IdentitySlot): Promise<void>;
  };
}

// --- refusals ---------------------------------------------------------------

/**
 * The WIT `seal-error` RECORD, as the value conventions shape it: a
 * plain object with camelCase fields, its `code` the `seal-code` enum
 * lifted to its kebab-case case name.
 */
interface SealErrorPayload {
  code: SealError["code"];
  message: string;
}

/**
 * Lower the component's refusal onto the `SealError` callers branch on.
 *
 * THE SENTENCE IS THE COMPONENT'S, CARRIED VERBATIM. It used to be
 * synthesised here — one generic line per code — because the variant had
 * no room for text, and that was a real defect rather than a cosmetic
 * one: the visor RENDERS `SealError.message` on its unseal and promotion
 * sheets, so every refusal reached the user as this file's paraphrase
 * instead of seal.ts's own words. A demo e2e scenario caught it
 * (demo/e2e/scenarios/solo-persistence.ts:275) where the browser matrix
 * could not, because the matrix asserts `code` and never reads the
 * prose. `types.seal-error` now carries `message`, the component states
 * seal.ts's exact sentence per site, and this function's whole job is to
 * not get in the way of it.
 *
 * The two closed sets are the same set by construction — `seal-code` is
 * `SealError.code`, case for case — so there is no mapping table here
 * and there should never be one again.
 */
function sealErrorOf(e: unknown): unknown {
  if (!isComponentException(e)) return e;
  const payload = (e as { payload?: unknown }).payload as SealErrorPayload | undefined;
  // The shape check is the discriminator, not validation: it says "this
  // exception is a `seal-error`" and lets anything else through
  // untouched, to be reported as whatever it actually is.
  if (
    !payload || typeof payload.code !== "string" || typeof payload.message !== "string"
  ) return e;
  return new SealError(payload.code, payload.message);
}

/** Run a component call, lowering its refusal. Every wrapper below goes
 * through here so a `seal-error` never escapes as a raw
 * `ComponentException`. */
async function lowered<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    throw sealErrorOf(e);
  }
}

// --- the namespace import: a codec, and only a codec ------------------------

/** Warn ONCE per namespace per slot about a stored handle the port
 * refuses. A silent discard of a key the user's account depends on is
 * exactly the event that should be visible in a console when someone is
 * debugging "why am I a new device" (identity-keys.ts's rule, kept). */
function warnOnce(seen: Set<string>, what: string, ns: DeviceNamespace, e: unknown): void {
  if (seen.has(what)) return;
  seen.add(what);
  console.warn(
    `device-store: the ${what} entry in ${ns.dbName} is not a usable key handle; ` +
      `reading it as absent (${(e as Error)?.message ?? e})`,
  );
}

function namespaceImports(ns: DeviceNamespace): Record<string, unknown> {
  const warned = new Set<string>();

  return {
    // `passphrase-wrap`. `origin` is `option<passphrase-origin>`: an
    // absent field crosses as `none` and the COMPONENT reads that as
    // `generated`. Nothing is defaulted here.
    getPassphraseWrap: async () => {
      const rec = await ns.get<PassphraseWrap>(SEAL_STORE, KEY_PASSPHRASE_WRAP);
      if (!rec) return undefined;
      const out: {
        iterations: number;
        salt: Uint8Array;
        wrapped: Uint8Array;
        origin?: "user" | "generated";
      } = { iterations: rec.iterations, salt: rec.salt, wrapped: rec.wrapped };
      if (rec.origin !== undefined) out.origin = rec.origin;
      return out;
    },
    // THE WRITE SIDE KEEPS THE ON-DISK SHAPE EXACTLY: `v` and `kdf` are
    // seal.ts's constants and are re-attached here because the WIT record
    // does not carry them — they are format tags, not ladder inputs, and
    // dropping them would change the bytes a pre-port reader sees.
    putPassphraseWrap: async (rec: {
      iterations: number;
      salt: Uint8Array;
      wrapped: Uint8Array;
      origin?: "user" | "generated";
    }) => {
      const stored: PassphraseWrap = {
        v: 1,
        kdf: "PBKDF2-SHA-256",
        iterations: rec.iterations,
        salt: rec.salt,
        wrapped: rec.wrapped,
      };
      if (rec.origin !== undefined) stored.origin = rec.origin;
      await ns.put(SEAL_STORE, KEY_PASSPHRASE_WRAP, stored);
    },

    getPlatformWrap: async () => {
      const rec = await ns.get<PlatformWrap>(SEAL_STORE, KEY_PLATFORM_WRAP);
      return rec ? { wrapped: rec.wrapped } : undefined;
    },
    putPlatformWrap: async (rec: { wrapped: Uint8Array }) => {
      await ns.put(SEAL_STORE, KEY_PLATFORM_WRAP, { v: 1, wrapped: rec.wrapped } satisfies PlatformWrap);
    },
    deletePlatformWrap: () => ns.delete(SEAL_STORE, KEY_PLATFORM_WRAP),

    /**
     * `wrap:prf`. THE `kdf` TAG IS THE HOST'S ONE FILTER: the WIT fixes
     * this version's construction at `prf-hkdf-sha-256` and rules that a
     * record carrying another tag reads as `none` (world.wit:162-164).
     * That is not validation of the ladder's rules — the component still
     * owns those, and refuses a malformed record as `tampered`; it is the
     * codec declining to MAP a record it has no shape for.
     *
     * `transports` is `list<string>`, not an option: absent crosses as
     * the empty list.
     */
    getPrfWrap: async () => {
      const rec = await ns.get<PrfWrap>(SEAL_STORE, KEY_PRF_WRAP);
      if (!rec) return undefined;
      if (rec.kdf !== "prf-hkdf-sha-256") return undefined;
      return {
        credentialId: rec.credentialId,
        transports: rec.transports ?? [],
        rpId: rec.rpId,
        prfInput: rec.prfInput,
        hkdfSalt: rec.hkdfSalt,
        wrapped: rec.wrapped,
      };
    },
    putPrfWrap: async (rec: {
      credentialId: Uint8Array;
      transports: string[];
      rpId: string;
      prfInput: Uint8Array;
      hkdfSalt: Uint8Array;
      wrapped: Uint8Array;
    }) => {
      const stored: PrfWrap = {
        v: 1,
        kdf: "prf-hkdf-sha-256",
        credentialId: rec.credentialId,
        rpId: rec.rpId,
        prfInput: rec.prfInput,
        hkdfSalt: rec.hkdfSalt,
        wrapped: rec.wrapped,
      };
      // WRITE `transports` ONLY WHEN NON-EMPTY. seal.ts wrote the field
      // only for a non-empty array (`if (enrollment.transports?.length)`),
      // so writing `[]` would put a field on disk that no pre-port record
      // carries — a shape change, in a format whose unchangedness is the
      // requirement.
      if (rec.transports.length > 0) stored.transports = rec.transports;
      await ns.put(SEAL_STORE, KEY_PRF_WRAP, stored);
    },

    /**
     * `kek:platform`, the non-extractable AES-KW platform key, as a
     * handle. VALIDATE-ON-LOAD IS `fromCryptoKey`'s REFUSAL
     * (world.wit:131-137): IndexedDB is writable by anything else on this
     * origin, so a stored key is untrusted input on the way back in, and
     * a value that is not a usable AES-KW handle reads as `none` rather
     * than crossing. The component makes the second half of the judgement
     * — it re-checks `extractable`/`can_unwrap` and refuses `tampered`.
     */
    getPlatformKek: async () => {
      const stored = await ns.get<unknown>(SEAL_STORE, KEY_PLATFORM_KEK);
      if (stored === undefined) return undefined;
      try {
        return KwKey.fromCryptoKey(stored as CryptoKey);
      } catch (e) {
        warnOnce(warned, "kek:platform", ns, e);
        return undefined;
      }
    },
    putPlatformKek: async (key: KwKey) => {
      await ns.put(SEAL_STORE, KEY_PLATFORM_KEK, key.toCryptoKey());
    },
    deletePlatformKek: () => ns.delete(SEAL_STORE, KEY_PLATFORM_KEK),

    getSealed: async (key: string) => {
      const rec = await ns.get<SealedValue>(SEALED_STORE, key);
      return rec ? { iv: rec.iv, ct: rec.ct } : undefined;
    },
    putSealed: async (key: string, rec: { iv: Uint8Array; ct: Uint8Array }) => {
      await ns.put(SEALED_STORE, key, { v: 1, iv: rec.iv, ct: rec.ct } satisfies SealedValue);
    },
    deleteSealed: (key: string) => ns.delete(SEALED_STORE, key),

    /**
     * The `identity` store, keyed by slot. A stored pair that
     * `fromCryptoKey` refuses reads as `none` — which IS
     * identity-keys.ts's `usableIdentity` check, relocated to the seam
     * the contract assigns it to.
     */
    getIdentity: async (slot: IdentitySlot) => {
      const pair = await readIdentity(ns, slot, warned);
      return pair ?? undefined;
    },

    /**
     * ADD-IF-ABSENT, AND IT RETURNS WHAT IS STORED (world.wit:200-206).
     *
     * The transaction discipline is identity-keys.ts's `loadOrMintIdentity`
     * verbatim (identity-keys.ts:207-223) and the reason is unchanged: two
     * workers attaching to one device both want the identity to exist, and
     * a read-then-write would mint two keys and let the later write
     * silently replace the identity the earlier one had already begun
     * signing with. IndexedDB serialises overlapping readwrite
     * transactions on a store, so exactly one caller sees an absent entry
     * inside one. The loser's candidate is dropped and both callers agree
     * on one identity — which is why this returns the STORED pair rather
     * than the caller's.
     *
     * Key generation cannot happen inside a transaction (an `await` on
     * anything but an IndexedDB request lets it commit out from under
     * you), and does not need to: the component minted the candidate
     * before calling.
     */
    putIdentity: async (
      slot: IdentitySlot,
      signing: SigningKey,
      verifying: VerifyingKey,
    ): Promise<IdentityPair> => {
      const candidate: CryptoKeyPair = {
        privateKey: signing.toCryptoKey(),
        publicKey: verifying.toCryptoKey(),
      };
      const stored = await withDb(ns.dbName, NS_STORES, "readwrite", async (tx) => {
        const store = tx.objectStore(IDENTITY_STORE);
        const raced = await idbReq(store.get(slot) as IDBRequest<unknown>);
        const usable = usablePair(raced);
        if (usable) return usable;
        // A stored-but-unusable entry is REPLACED in the same
        // transaction, so the planted-junk case ends with a real key
        // rather than a loop against the plant.
        store.put(candidate, slot);
        return candidate;
      });
      return [
        SigningKey.fromCryptoKey(stored.privateKey),
        VerifyingKey.fromCryptoKey(stored.publicKey),
      ];
    },

    deleteIdentity: (slot: IdentitySlot) => ns.delete(IDENTITY_STORE, slot),
  };
}

/**
 * VALIDATE-ON-LOAD for a stored identity pair — `usableIdentity`, in
 * full, and THE HOST OWNS IT (world.wit:136-153).
 *
 * `fromCryptoKey` is not all of the predicate and the contract says so:
 * it refuses the wrong type, algorithm and usages, but never looks at
 * `extractable`. So this checks that bit itself and lets `fromCryptoKey`
 * supply the rest. The bit is the one that matters — a PLANTED
 * EXTRACTABLE PAIR is an attacker's handle wearing a stored key's
 * costume, and adopting it would make the device sign under material
 * that can be read back (identity-keys.ts:96-101's reasoning, kept).
 *
 * IT LIVES HERE RATHER THAN IN THE COMPONENT because `put-identity`'s
 * add-if-absent transaction has to apply it to the entry it FINDS, and
 * an IndexedDB transaction cannot call back into a component without
 * committing out from under itself. The component re-checks the
 * extractability bit on every pair it receives from either door and
 * refuses `unsupported` (identity.rs `refuse_extractable`), so a codec
 * bug here fails loudly at the seam instead of quietly downstream.
 */
function usablePair(value: unknown): CryptoKeyPair | undefined {
  const pair = value as CryptoKeyPair | null;
  if (
    typeof pair !== "object" || pair === null ||
    !(pair.privateKey instanceof CryptoKey) || !(pair.publicKey instanceof CryptoKey) ||
    pair.privateKey.extractable !== false
  ) return undefined;
  try {
    // The port's own refusals are the rest of the validation; minting the
    // wrappers is how they are asked for.
    SigningKey.fromCryptoKey(pair.privateKey);
    VerifyingKey.fromCryptoKey(pair.publicKey);
  } catch {
    return undefined;
  }
  return pair;
}

async function readIdentity(
  ns: DeviceNamespace,
  slot: IdentitySlot,
  warned: Set<string>,
): Promise<IdentityPair | undefined> {
  const stored = await ns.get<unknown>(IDENTITY_STORE, slot);
  if (stored === undefined) return undefined;
  // ONE PREDICATE FOR BOTH READERS — `usablePair` carries the
  // extractability finding this seam turns on.
  const pair = usablePair(stored);
  if (!pair) {
    warnOnce(
      warned,
      `identity/${slot}`,
      ns,
      new Error("not a usable non-extractable Ed25519 key pair"),
    );
    return undefined;
  }
  return [
    SigningKey.fromCryptoKey(pair.privateKey),
    VerifyingKey.fromCryptoKey(pair.publicKey),
  ];
}

// --- opening one -------------------------------------------------------------

/** The component's exports, as the conventions shape them. */
interface SealExports {
  state(): Promise<SealState>;
  forget(): Promise<void>;
  createSealedDek(passphrase: string, origin: "user" | "generated"): Promise<void>;
  unsealWithPassphrase(passphrase: string): Promise<void>;
  rekeyPassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  enableUntilReseal(passphrase: string): Promise<void>;
  rekeyFromPlatform(newPassphrase: string): Promise<void>;
  unsealFromPlatform(): Promise<boolean>;
  getPrfEnrollment(): Promise<WitEnrollment | undefined>;
  enablePrf(kek: KwKey, enrollment: WitEnrollment, passphrase: string | undefined): Promise<void>;
  unsealWithPrf(kek: KwKey): Promise<void>;
  reseal(): Promise<void>;
}

interface WitEnrollment {
  credentialId: Uint8Array;
  transports: string[];
  rpId: string;
  prfInput: Uint8Array;
  hkdfSalt: Uint8Array;
}

interface SealedExports {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  sealFile(plaintext: Uint8Array): Promise<Uint8Array>;
  openFile(sealed: Uint8Array): Promise<Uint8Array>;
}

interface IdentityExports {
  loadOrMint(slot: IdentitySlot): Promise<IdentityPair>;
  load(slot: IdentitySlot): Promise<IdentityPair | undefined>;
  delete(slot: IdentitySlot): Promise<void>;
}

/**
 * The seal component's artifacts, fetched beside the engine's.
 *
 * `artifactsFromEnvelope` verifies the envelope's embedded sha-256
 * against the bytes, so a mismatched pair fails loudly at instantiation
 * rather than subtly later.
 */
export function sealArtifacts(envelope: string, bytes: Uint8Array): InstantiateSource {
  return artifactsFromEnvelope(envelope, bytes);
}

/**
 * INSTANTIATE ONE DEVICE'S SEAL.
 *
 * WHICH DEVICE IS DECIDED HERE AND NOWHERE ELSE. There is no `device-id`
 * parameter anywhere in the `namespace` interface: the component can
 * spell five record kinds and four key slots of the namespace this
 * function closed over, and cannot name another (world.wit:117-123).
 *
 * The import record is `newEngine`'s shape (engine.ts:640-700): the WASI
 * batteries, the whole webcrypto fragment, and ours. `webcryptoImports()`
 * serves more interfaces than this component imports — the linker
 * stripped the rest — and a superfluous import key is ignored, which is
 * the same reason engine.ts can leave its wasi:http fragment in place.
 *
 * `types` is functionless and needs no implementation, but it IS in the
 * artifact's import list (`wasm-tools component wit` on the build), so it
 * gets the empty record engine.ts gives `store-fetch-types` for exactly
 * this reason.
 */
export async function openSeal(
  ns: DeviceNamespace,
  source: InstantiateSource,
): Promise<DeviceSeal> {
  // PLAIN MODE, PINNED — `jspi: false` — and the reason is a measured crash.
  //
  // This component never needs a suspended wasm frame: every import it
  // calls is an `async func` (the webcrypto surface, our `namespace`), so
  // each is lowered through the component-model async ABI and the guest
  // parks on a callback, never on a blocked frame. polyengine's
  // auto-detection nevertheless picks jspi mode for this plan, because
  // wit-bindgen emits the sync-form `subtask.cancel`/`task.cancel`
  // built-ins for the drop-a-pending-future path, and those are classified
  // block-capable (embedder-api.md, amendment A1; jspi/bridge.ts
  // `trampolineNeedsSuspension`). In jspi mode every export is wrapped in
  // `WebAssembly.promising`, and under Gecko — where JSPI is still
  // pref-gated and experimental — the first async export call then kills
  // the content process (firefox-smoke, and a minimal probe: the same
  // sequence passes with `jspi: false` and crashes with `true`; the
  // engine survives only because its plan genuinely needs suspension and
  // its exports are driven differently). Forcing plain costs nothing here
  // and would surface loudly if it were ever wrong: a sync-lowered import
  // that returned a Promise is refused at the call site (`NeedsJspi`),
  // never silently degraded. The recorded Gecko hazard this joins is
  // PERSISTENCE.md's 0.5.1 addendum on `WebAssembly.promising` exports.
  const instance = await instantiate(source, {
    ...wasi({ cli: { args: [`device-seal-${ns.id.slice(0, 8)}`] } }),
    ...webcryptoImports(),
    [I_TYPES]: {},
    [I_NAMESPACE]: namespaceImports(ns),
  }, { jspi: false });

  const seal = instance.exports[I_SEAL] as SealExports;
  const sealed = instance.exports[I_SEALED] as SealedExports;
  const identity = instance.exports[I_IDENTITY] as IdentityExports;
  if (!seal || typeof seal.forget !== "function") {
    throw new Error(
      `device-seal: export "${I_SEAL}" missing or shapeless; exports: ${
        Object.keys(instance.exports).join(", ")
      }`,
    );
  }

  // THE MIRROR AND THE GENERATION COUNTER — see `unsealed()` and
  // `epoch()` on the interface. Both move in exactly one place per
  // transition: `parked()` for a ceremony that ends with a DEK parked,
  // and `forget()` below.
  let parkedDek = false;
  let epoch = 0;
  const parked = async (body: () => Promise<void>): Promise<void> => {
    await lowered(body);
    parkedDek = true;
    epoch++;
  };

  return {
    state: () => lowered(() => seal.state()),
    unsealed: () => parkedDek,
    epoch: () => epoch,

    createSealedDek: (passphrase, origin = "user") =>
      parked(() => seal.createSealedDek(passphrase, origin)),
    unsealWithPassphrase: (passphrase) => parked(() => seal.unsealWithPassphrase(passphrase)),
    rekeyPassphrase: (oldPassphrase, newPassphrase) =>
      lowered(() => seal.rekeyPassphrase(oldPassphrase, newPassphrase)),
    enableUntilReseal: (passphrase) => lowered(() => seal.enableUntilReseal(passphrase)),
    rekeyFromPlatform: (newPassphrase) => lowered(() => seal.rekeyFromPlatform(newPassphrase)),
    // `ok(false)` is "this device has no platform rung", which is the
    // normal case and parks nothing — so the mirror moves only on true.
    unsealFromPlatform: async () => {
      const opened = await lowered(() => seal.unsealFromPlatform());
      if (opened) {
        parkedDek = true;
        epoch++;
      }
      return opened;
    },

    getPrfEnrollment: async () => {
      const rec = await lowered(() => seal.getPrfEnrollment());
      if (!rec) return undefined;
      const out: PrfEnrollment = {
        credentialId: rec.credentialId,
        rpId: rec.rpId,
        prfInput: rec.prfInput,
        hkdfSalt: rec.hkdfSalt,
      };
      if (rec.transports.length > 0) out.transports = rec.transports;
      return out;
    },
    // THE KEK ARRIVES AS A `CryptoKey` — structured-cloned over the port
    // from the page, which derived it from the PRF output (rpc.ts). It
    // enters the component as a `kw-key` handle, and `fromCryptoKey`'s
    // refusals are the first gate: a key that is not a usable AES-KW
    // handle never reaches the ceremony. The component makes the second
    // judgement (extractable, wrap/unwrap) and refuses `unsupported`.
    enablePrf: (kek, enrollment, passphrase) =>
      lowered(() =>
        seal.enablePrf(
          KwKey.fromCryptoKey(kek),
          {
            credentialId: enrollment.credentialId,
            transports: enrollment.transports ?? [],
            rpId: enrollment.rpId,
            prfInput: enrollment.prfInput,
            hkdfSalt: enrollment.hkdfSalt,
          },
          passphrase,
        )
      ),
    unsealWithPrf: (kek) => parked(() => seal.unsealWithPrf(KwKey.fromCryptoKey(kek))),

    reseal: () => lowered(() => seal.reseal()),
    forget: async () => {
      await lowered(() => seal.forget());
      parkedDek = false;
      epoch++;
    },

    sealed: {
      put: (key, bytes) => lowered(() => sealed.put(key, bytes)),
      get: (key) => lowered(() => sealed.get(key)),
      delete: (key) => lowered(() => sealed.delete(key)),
      sealFile: (plaintext) => lowered(() => sealed.sealFile(plaintext)),
      openFile: (bytes) => lowered(() => sealed.openFile(bytes)),
    },

    identity: {
      loadOrMint: (slot) => lowered(() => identity.loadOrMint(slot)),
      load: (slot) => lowered(() => identity.load(slot)),
      delete: (slot) => lowered(() => identity.delete(slot)),
    },
  };
}
