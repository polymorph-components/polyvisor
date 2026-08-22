// THE WIRE BETWEEN A TAB AND ITS DEVICE HOST (PERSISTENCE.md, "The
// worker host": "the driver/tasks/pairing surfaces cross the port as
// structured-clone data … the envelope is the embedder API — design it
// once, in runtime/, not per page").
//
// This module is the contract and NOTHING ELSE: types, the method
// tables, and the two pure functions that turn a thrown thing into a
// clonable envelope and back. worker.ts and client.ts both import it,
// which is the point — there is exactly one description of the wire.
//
// IT IMPORTS NO PACKAGE, only sibling types. That is deliberate and it
// is what lets a page take `client.ts` with no pins at all
// (runtime/README.md's resolution model). The one place a package
// identity would have been convenient — `isComponentException` from
// @polyengine/runtime/embedder — is handled by the brand REGISTRY KEY
// instead; see `rehydrate` below for the whole argument.

import type { Driver, Tasks } from "../engine.ts";
import type { Posture, Tier, UnsealPolicy } from "./index.ts";

// --- the error envelope -----------------------------------------------------

/**
 * A rejection, flattened into something structured clone will carry.
 *
 * WHY IT CANNOT BE THE ERROR ITSELF. Structured clone does carry `Error`
 * objects, but it carries only `name`, `message`, `stack` and `cause` —
 * OWN PROPERTIES ARE DROPPED. `ComponentException`'s entire meaning is
 * its `payload` (the WIT `result<T, E>` err value), and `SealError`'s is
 * its `code`; both would arrive as bare `Error`s with a nice message and
 * no machine-readable content. So the envelope names the three facts a
 * caller can act on and carries them explicitly.
 *
 * WHAT `isWitError` MEANS, precisely: the worker-side rejection was
 * recognized by `isComponentException` — i.e. the guest returned the err
 * arm of a WIT `result`, and `witPayload` is that arm's value. `false`
 * covers everything else: a host bug, a `SealError`, a `TypeError` in
 * the worker. The distinction matters because a WIT err is an EXPECTED
 * outcome the app should handle, while an unbranded throw is a defect.
 */
export interface WireError {
  /** Always present, always safe to show a developer. Never assume it
   * is stable enough to branch on — that is what the other two are for. */
  message: string;
  /** The original error's `name` ("ComponentException", "SealError",
   * "TypeError"…). Diagnostic, not a contract. */
  name: string;
  /** True iff the worker recognized the rejection as a WIT `result` err
   * value. See the note above. */
  isWitError: boolean;
  /** The WIT err arm's value when `isWitError`; absent otherwise. For
   * this engine's `result<T, string>` methods it is a string
   * (engine.ts:38). */
  witPayload?: unknown;
  /** A typed refusal code where the thrower had one — `SealError.code`
   * ("wrong-passphrase", "no-rung", …) or `SealedFsError.fsCode`. This
   * is what an unseal ceremony branches on. */
  code?: string;
}

/**
 * The brand key for a WIT `result` err value, spelled out rather than
 * imported.
 *
 * THE AUTHORITY, and it is explicit about this being allowed:
 * `@polyengine/protocol@0.1.0/src/brands.ts` (the brands module the
 * pinned `@polyengine/runtime@0.3.1/embedder` recognizes values with) —
 * "Every brand is a `Symbol.for` REGISTRY symbol, so N copies of this
 * package (or of the runtime) agree on every brand by construction", and
 * "Brands are contract markers, NOT a security boundary: a hand-rolled
 * object carrying the right symbol is a legal value (this is what makes
 * zero-import host modules possible)."
 *
 * SO THE CLIENT CAN MINT an error that `isComponentException()` accepts
 * without importing the embedder, and `rehydrate` below does exactly
 * that — which is what keeps this module, and client.ts with it,
 * package-free (runtime/README.md's resolution model: a picker that only
 * reads the index should not have to pin the engine).
 *
 * THE COST, STATED, BECAUSE IT ALREADY BIT ONCE. The key is a wire
 * constant with a history: amendment A18 renamed every key's prefix from
 * `deltic.` to `polyengine.`, and that module's own header says
 * pre-A18 and post-A18 brands "do NOT interoperate … by design and
 * WITHOUT A DIAGNOSTIC". The first draft of this file hand-rolled the
 * older spelling (taken from a stale copy in the module cache), and the
 * result was precisely the described silence: nothing threw, nothing
 * warned, and `pairing-engine.ts` quietly reported every engine refusal
 * as a message instead of a payload. That is why row 18 of the gate
 * (runtime/tests/devstore/run.ts) asserts the adapter's error string IS
 * the WIT payload rather than merely that a rejection happened: a future
 * key change turns a silent degradation into a red row.
 *
 * What is NOT claimed: that the brand crossed the port. Symbols do not
 * clone and `Symbol.for`'s registry is per-agent, so nothing branded
 * survives a `postMessage`. The brand on the client's error is MINTED
 * FRESH from the envelope's `isWitError` bit, on this side, in this
 * realm.
 */
const WIT_ERROR_BRAND: symbol = Symbol.for("polyengine.witError/1");

/**
 * The client-side error every remote call rejects with.
 *
 * BRANCH ON THE FIELDS, NOT ON THE CLASS AND NOT ON THE BRAND. Module
 * identity does not cross a worker boundary — the page and the worker
 * evaluate two separate module graphs in two separate agents — so
 * `instanceof` against anything the worker threw is meaningless here,
 * and even class identity of `DeviceHostError` itself only holds within
 * one bundle. `isWitError` / `witPayload` / `code` are the contract.
 *
 * The `ComponentException` brand IS carried, as a compatibility
 * courtesy, so that an adapter written against the in-process driver
 * keeps working over the remote one unmodified — runtime/pairing-engine.ts's
 * `errFrom` reads `isComponentException(e)` then `e.payload`, and that
 * is precisely the shape this class presents. `payload` is an alias of
 * `witPayload` for the same reason. Consumers writing NEW code should
 * still read `isWitError`: the brand is a bridge for existing adapters,
 * not the wire contract.
 */
export class DeviceHostError extends Error {
  readonly isWitError: boolean;
  readonly witPayload?: unknown;
  readonly code?: string;
  /** Alias of `witPayload`, for `ComponentException`-shaped consumers. */
  readonly payload?: unknown;

  constructor(wire: WireError) {
    super(wire.message);
    this.name = "DeviceHostError";
    this.isWitError = wire.isWitError;
    if (wire.isWitError) {
      this.witPayload = wire.witPayload;
      this.payload = wire.witPayload;
    }
    if (wire.code !== undefined) this.code = wire.code;
    // Minted here, in this realm, from the envelope's bit — see the
    // brand comment above. Only for genuine WIT err values: branding a
    // host bug would tell an adapter that a defect was an expected
    // outcome, which is the one lie this whole envelope exists to avoid.
    if (wire.isWitError) {
      Object.defineProperty(this, WIT_ERROR_BRAND, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  }
}

/**
 * Worker side: flatten a thrown thing into the envelope.
 *
 * `isWit` is passed in rather than computed, because only the worker has
 * the embedder module and therefore the brand predicate — this module
 * stays package-free (see the header).
 */
export function toWire(e: unknown, isWit: boolean): WireError {
  const err = e as {
    name?: string;
    message?: string;
    payload?: unknown;
    code?: string;
    fsCode?: string;
  };
  const wire: WireError = {
    message: String(err?.message ?? e),
    name: typeof err?.name === "string" ? err.name : typeof e,
    isWitError: isWit,
  };
  if (isWit) wire.witPayload = err?.payload;
  const code = err?.code ?? err?.fsCode;
  if (typeof code === "string") wire.code = code;
  return wire;
}

/** Client side: the envelope, as something to `throw`. */
export function rehydrate(wire: WireError): DeviceHostError {
  return new DeviceHostError(wire);
}

// --- the proxied surfaces ---------------------------------------------------
//
// SERIALIZATION DISCIPLINE (the deliverable's third item). Every method
// below moves only values structured clone carries natively:
//
//   * `Uint8Array` — ids, cards, bundles, icons. Cloned as a typed array
//     over a copied buffer; no transfer, so the caller keeps theirs.
//   * `string`, `boolean`, `number`, `bigint` (`u64` lowers to bigint —
//     `PairOffer.expiresMs`, `UsMark.createdAt`, `Snapshot.revision`).
//     bigint has been clonable since the HTML spec's 2018 addition and
//     is exercised by the `tasks.items` row of the matrix.
//   * plain records — `StoreConfig`, `UsProfile`, `UsMark`, `UsPartition`,
//     `UsDevice`, `TodoItem`, `Snapshot`, `PairOffer`, `PairEnrollment`.
//     Object literals with no prototype of consequence.
//   * `{kind, value}` variants — `PairJoinState`, `PairAddState`,
//     `UsEvent`, `StoreConfig`. The @polyengine/runtime value-mapping
//     convention lowers every WIT variant to exactly this (engine.ts:162-170),
//     which is a plain object, so variants clone by construction. This is
//     the fact that makes "proxy the whole surface" viable at all.
//   * tuples — `chunkStats`'s `[number, number]`, `usContactsList`'s
//     `Array<[Uint8Array, string]>`. Arrays.
//   * `undefined` — `option<T>` lowers to `T | undefined`; clone carries it.
//
// NOTHING IS EXCLUDED. There is no method here that moves a function, a
// CryptoKey, a resource handle, a stream or a class instance, so there is
// no method that needed to be left out. The two places where the engine
// DOES hand out non-clonable things — the `EngineNet` fetch/sign seams
// and the mounted state root — are not on this surface: they are wired
// INSIDE the worker at instantiation and never named across the port.
//
// The consequence worth stating: `createEnginePairingDriver`
// (runtime/pairing-engine.ts) is constructible over the remote driver
// unmodified. It needs `pairJoinStart/Status/Confirm`,
// `pairAddStart/Status/Confirm`, `pairAbort`, `userCreate`, the
// `usProfile*`/`usMark*`/`usContact*`/`usDevice*` family and `usEvents`
// — all present below — plus rejections it can read a WIT payload out
// of, which is what `DeviceHostError` above provides.

/** Every method of `Driver`, as the wire knows them. */
export const DRIVER_METHODS = [
  "init",
  "khKnowsAgent",
  "khCreateGroup",
  "khAddToGroup",
  "khRevokeFromGroup",
  "khExportCard",
  "khIngestCard",
  "khAddMember",
  "khRevokeMember",
  "khContactCard",
  "khIngestContact",
  "irohBind",
  "irohStart",
  "connStatus",
  "syncStart",
  "syncStatus",
  "createPartition",
  "sealPartition",
  "adoptPartition",
  "chunkStats",
  "initStore",
  "ensureBucket",
  "storeGrant",
  "storeRevoke",
  "bucketFlush",
  "bucketPull",
  "identityExport",
  "identityImport",
  "stateCheckpoint",
  "stateResume",
  "pairJoinStart",
  "pairJoinStatus",
  "pairJoinConfirm",
  "pairAddStart",
  "pairAddStatus",
  "pairAddConfirm",
  "pairAbort",
  "userCreate",
  "usProfileGet",
  "usProfileSet",
  "usMarksList",
  "usMarkPut",
  "usMarkForget",
  "usMarkConfirm",
  "usPartitionPut",
  "usPartitions",
  "usContactsList",
  "usContactPut",
  "usDevicesList",
  "usDeviceRevoke",
  "usEvents",
  "stats",
] as const;

/** Every method of `Tasks`. */
export const TASKS_METHODS = [
  "partition",
  "revision",
  "items",
  "add",
  "setCompleted",
  "setTitle",
  "remove",
] as const;

// THE EXHAUSTIVENESS TRIPWIRE. A method added to `Driver` or `Tasks` in
// engine.ts and forgotten here would be a silently missing remote
// method — the client's proxy is built from these arrays, so the call
// would simply be `undefined` at the call site. These two aliases make
// that a TYPE ERROR at `deno check` time instead, and the error text
// names the missing methods.
type MissingDriver = Exclude<keyof Driver, (typeof DRIVER_METHODS)[number]>;
type MissingTasks = Exclude<keyof Tasks, (typeof TASKS_METHODS)[number]>;
const _driverIsComplete: [MissingDriver] extends [never] ? true : MissingDriver = true;
const _tasksIsComplete: [MissingTasks] extends [never] ? true : MissingTasks = true;
void _driverIsComplete;
void _tasksIsComplete;

/**
 * The methods that do NOT change engine state, and therefore do not
 * schedule a checkpoint.
 *
 * THE LIST IS OF THE QUERIES, NOT OF THE MUTATIONS, on purpose. A method
 * added to the engine and forgotten here is treated as a mutation, which
 * costs a redundant checkpoint; the reverse default would cost a lost
 * one. Sweeping late costs storage, sweeping early costs a user their
 * work — the same asymmetry locks.ts's lease window is chosen for.
 */
export const READONLY_METHODS: ReadonlySet<string> = new Set([
  // driver — pure reads and status polls
  "khKnowsAgent",
  "khExportCard",
  "khContactCard",
  "connStatus",
  "syncStatus",
  "chunkStats",
  "storeGrant",
  "stateCheckpoint",
  "stateResume",
  "pairJoinStatus",
  "pairAddStatus",
  "usProfileGet",
  "usMarksList",
  "usPartitions",
  "usContactsList",
  "usDevicesList",
  "stats",
  // `usEvents` DRAINS a queue, so it is a mutation of engine state in
  // the strict sense — but the queue is not part of the checkpoint's
  // meaning and a poll loop calling it every 250 ms would defeat the
  // debounce entirely. Treated as a read, deliberately, and recorded
  // here rather than left to be inferred.
  "usEvents",
  // tasks — reads
  "partition",
  "revision",
  "items",
]);

// --- the host surface -------------------------------------------------------

/** What `unseal` may be told. */
export interface UnsealOptions {
  /** The `every-session` rung's input, and the first-seal ceremony's.
   * Never persisted, never logged, never echoed back in `status()`. */
  passphrase?: string;
  /** FIRST SEAL ONLY: also arm the `until-reseal` rung (seal.ts's
   * `enableUntilReseal`). Ignored on a device that already has rungs —
   * arming after the fact is a separate ceremony the UI owns. */
  untilReseal?: boolean;
}

/**
 * THE SEAL HALF OF "KEEP THIS DEVICE" (PERSISTENCE.md, "Tiers, as a
 * promotion").
 *
 * The INDEX half — tier, petname, posture, policy — is `promoteDevice`
 * and stays on the tab's side, because the index is the one unsealed
 * database and needs no worker. What crosses the port is only what the
 * worker can do and the page must not: re-wrapping the DEK. A page that
 * did its own crypto here would have to hold key material, which is the
 * entire property the worker host exists to keep.
 */
export interface PromoteOptions {
  /** The rung the user chose. `every-session` re-wraps the DEK under
   * `passphrase` and then DELETES the platform wrap (a rung the user
   * asked to be asked past must not be left standing). `until-reseal`
   * keeps or arms the platform wrap. */
  policy: UnsealPolicy;
  /** Required for `every-session`. Never persisted, never logged, never
   * echoed back in `status()`. */
  passphrase?: string;
}

/**
 * What `reseal` may be told.
 *
 * THE PASSPHRASE IS AN UPGRADE, NOT A CHECK. Reseal never asks a device
 * to prove anything — the caller is already holding it open. The
 * passphrase is only needed when deleting the platform wrap would leave
 * the device with no rung anybody knows (see the worker's `reseal`), in
 * which case it becomes the device's new `every-session` rung and the
 * INDEX's policy tag must be flipped to match by the caller.
 */
export interface ResealOptions {
  /** Required when the device's only usable rung is the platform wrap.
   * Never persisted, never logged, never echoed back in `status()`. */
  passphrase?: string;
}

/** What the first client tells the worker so it can become a host. */
export interface AttachSpec {
  deviceId: string;
  /** Fetched INSIDE the worker (the worker has `fetch`), so the bytes
   * never cross the port. Absolute or worker-relative. */
  artifacts: { envelopeUrl: string; wasmUrl: string };
  /** For `newEngine`'s `wasi:cli` args and nothing else. */
  label?: string;
}

/** Everything a picker or a strip needs to know, and nothing secret. */
export interface DeviceStatus {
  deviceId: string;
  tier: Tier;
  posture: Posture;
  policy: UnsealPolicy;
  /** True until an unseal succeeds, true again after `reseal()`. The
   * headline fact. */
  sealed: boolean;
  /** Which rungs this device HAS (seal.ts's `sealState`) — the picker's
   * question, answerable without opening anything. `userPassphrase` is
   * the one a reseal ceremony branches on: a passphrase rung EXISTS on
   * every sealed device, but only a `user` one is a door anybody can
   * walk through. */
  rungs: { passphrase: boolean; userPassphrase: boolean; untilReseal: boolean };
  /** True when the next `unseal()` cannot succeed without one. */
  needsPassphrase: boolean;
  /**
   * How the engine came up: `null` while sealed, `true` when
   * `stateResume()` answered true, `false` when it answered false and
   * the fresh-init path ran. This is the kill-and-resume claim, made
   * observable.
   */
  resumed: boolean | null;
  /** `Date.now()` of the last successful `stateCheckpoint()`, or null. */
  lastCheckpoint: number | null;
  /** Whether the worker holds `pm-device-<id>` right now. */
  lockHeld: boolean;
  /** Bumped once per WORKER GLOBAL SCOPE, persisted in the namespace's
   * unsealed `meta` store. Stable across a reload that reuses the worker
   * and across two tabs of one device; bumped by a respawn. The spike's
   * Q4/Q4b instrument, kept because it is the only way to tell "the same
   * host" from "a new host that looks the same". */
  bootSeq: number;
  /** Minted once per worker global. Same fact, without the storage. */
  instanceNonce: string;
  /** How many client ports are currently attached. */
  clients: number;
}

export type HostMethod =
  | "attach"
  | "detach"
  | "unseal"
  | "promote"
  | "reseal"
  | "checkpoint"
  | "status"
  | "__die";

export interface Req {
  id: number;
  target: "driver" | "tasks" | "host";
  method: string;
  args: unknown[];
}

export type Res =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: WireError };

/** The unsolicited first message on every port. Reply id 0 is reserved
 * for it so a client can recognize it without a pending entry. */
export interface Hello {
  id: 0;
  kind: "hello";
  deviceId: string;
  bootSeq: number;
  instanceNonce: string;
  clients: number;
  /** False until some client has run `attach` — a second tab connecting
   * to a live worker sees `true` and can skip the artifact handshake. */
  attached: boolean;
}
