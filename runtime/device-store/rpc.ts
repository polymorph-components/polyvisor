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
// IT IMPORTS NO PACKAGE — only sibling TYPES, which erase. That is
// deliberate and it is what keeps this module checkable under any
// embedder's config (runtime/README.md's resolution model).
//
// ITS TWO CONSUMERS NO LONGER SHARE THAT PROPERTY, and the header should
// say so plainly rather than let a reader infer it. Since 0.4.0 the
// engine-error path crosses as the embedder's SANCTIONED CLONEABLE FORM
// (A20), so worker.ts calls `toCloneable` and client.ts calls
// `fromCloneable` — both real value imports from
// @polyengine/runtime/embedder. worker.ts always needed the pin (it
// instantiates the engine); client.ts did not, and now does. What is
// still package-free is everything BELOW the host: the index, the
// namespace, the seal ladder, the locks, the anchor and this file — so a
// consumer that only reads the index to render a picker still needs no
// pins, provided it imports those modules directly rather than through
// mod.ts (which re-exports client.ts). See runtime/README.md.

import type { Driver, Tasks } from "../engine.ts";
import type { Posture, Tier, UnsealPolicy } from "./index.ts";

// --- how a rejection crosses -----------------------------------------------
//
// TWO PATHS, AND THE SPLIT IS THE POINT (polyengine amendments A19/A20;
// the 0.4.0 bump). A rejection out of the worker is one of two very
// different kinds of thing, and flattening both into one envelope — as
// the pre-0.4.0 version of this file did — cost fidelity at both ends.
//
//   THE ENGINE'S ERRORS take the SANCTIONED CLONEABLE FORM. A20 ships
//   `toCloneable`/`fromCloneable` on the embedder, built with this
//   SharedWorker seam as its named consumer driver: the worker sends
//   `toCloneable(error)` and the client rehydrates with `fromCloneable`,
//   which mints a REAL branded `ComponentException` in the client's own
//   realm — payload, cause chain to full depth, sender's stack, and
//   `isComponentException()` answering true. That is strictly more than
//   the hand-rolled facsimile carried: it had one payload and no cause
//   chain, and it depended on this file spelling a brand key correctly,
//   which it had already got wrong once (A18) and which A19 renamed
//   again (`witError` -> `componentException`). Adopting the forms
//   deletes the hand-roll rather than chasing the spelling a third time.
//
//   THE HOST'S OWN CONDITIONS KEEP THEIR TYPED ENVELOPE, below. A
//   `SealError` is NOT a WIT error — nothing in the guest produced it,
//   and "you typed the wrong passphrase" is a normal answer from the
//   ceremony rather than a fault in the engine. There is also a
//   mechanical reason, and it is decisive: `toCloneable` encodes any
//   unbranded `Error` — subclasses included — through the contract's
//   `error` row, which carries `name`, `message`, `stack` and `cause`
//   AND NOTHING ELSE (@polyengine/protocol@0.2.1/src/cloneable.ts, the
//   `o instanceof Error` branch). `SealError.code` is an own property,
//   so it would be dropped, silently — and `code` is exactly what the
//   unseal ceremony branches on (demo/host/solo.ts's boot path;
//   runtime/tests/devstore rows 13, 16, 19, 20).
//
// THE CLONEABLE FORM IS VERSION-INTERNAL AND MUST NEVER BE PERSISTED
// (A20: "the supported matrix is the same engine version in both realms,
// the shape may change in any release, and nothing may be persisted on
// it"). This use satisfies that by construction and it is worth saying
// where the form crosses: a `WireFailure` lives for one `postMessage`
// between two realms of ONE page load, running one bundle of one engine
// version. Nothing here reaches IndexedDB, OPFS or the checkpoint —
// sealed-fs.ts and seal.ts never see it. If a future change is tempted
// to log one, cache one, or put one in a checkpoint: that is the line.

/**
 * A HOST-SURFACE condition — the device store's own refusals, not the
 * engine's.
 *
 * `code` is the contract; `message` is for a human and `hostName` is a
 * breadcrumb. The closed set of codes comes from the modules that raise
 * them: `SealError.code` ("wrong-passphrase", "no-rung",
 * "already-sealed", "tampered", "unsupported"),
 * `SealedFsError.fsCode` ("io"), `IdentityKeyError.code`
 * ("extractable", "algorithm", "unavailable"), plus this module's own
 * "timeout", "closed" and "unclonable".
 */
export interface HostError {
  message: string;
  /** The thrower's class name, for diagnosis only. */
  hostName: string;
  code?: string;
}

/**
 * One rejection, on the wire. A discriminated union rather than a
 * widened record, so neither side can read the engine path's fields off
 * a host refusal or the reverse.
 */
export type WireFailure =
  /** `toCloneable(error)` output — hand it to `fromCloneable` and throw
   * the result. Carries the whole branded taxonomy faithfully. */
  | { form: "cloneable"; value: unknown }
  /** A device-store condition, with its typed code intact. */
  | { form: "host"; error: HostError };

/**
 * The client-side error for a HOST-SURFACE condition.
 *
 * WHAT THIS CLASS IS NOT, ANY MORE. Before 0.4.0 it was also a
 * `ComponentException` facsimile: it carried `isWitError`, `witPayload`,
 * a `payload` alias and a hand-minted brand, so that an adapter written
 * against the in-process driver would keep working over the port. All of
 * that is gone, because `fromCloneable` now produces the real thing and
 * a facsimile beside it would be a second, worse answer to a question
 * that has a first one. `DeviceHostError` is now exactly what its name
 * says: the device host refusing, for a reason the device host owns.
 *
 * BRANCH ON `code`. `instanceof` is still meaningless across the port
 * boundary in the general case — two realms are two module graphs — but
 * `code` is a plain string and travels.
 */
export class DeviceHostError extends Error {
  readonly code?: string;
  /** The worker-side thrower's class name ("SealError", "TypeError"). */
  readonly hostName: string;

  constructor(e: HostError) {
    super(e.message);
    this.name = "DeviceHostError";
    this.hostName = e.hostName;
    if (e.code !== undefined) this.code = e.code;
  }
}

/**
 * Does this rejection carry a typed host code? If so it takes the host
 * path, because the cloneable form would drop the code (see above).
 *
 * Deliberately structural rather than `instanceof`: worker.ts and the
 * modules that raise these live in one graph today, but the predicate
 * that matters is "does it carry a code", and a hand-rolled refusal with
 * one is as legitimate as `SealError`.
 */
export function hostCodeOf(e: unknown): string | undefined {
  const err = e as { code?: unknown; fsCode?: unknown } | null;
  if (err === null || typeof err !== "object") return undefined;
  if (typeof err.code === "string") return err.code;
  if (typeof err.fsCode === "string") return err.fsCode;
  return undefined;
}

/** Describe any thrown thing as a host condition. */
export function hostErrorOf(e: unknown, code?: string): HostError {
  const err = e as { name?: unknown; message?: unknown } | null;
  const out: HostError = {
    message: String((err as { message?: unknown })?.message ?? e),
    hostName: typeof err?.name === "string" ? err.name : typeof e,
  };
  if (code !== undefined) out.code = code;
  return out;
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
  // `failure`, not `error`: the field changed SHAPE at 0.4.0 (a
  // discriminated union, not a flat record), and renaming it makes every
  // call site a compile error rather than letting a stale reader pick
  // fields off the wrong arm.
  | { id: number; ok: false; failure: WireFailure };

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
