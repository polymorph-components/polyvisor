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
// `fromCloneable` — both real value imports from @polyengine/protocol
// (they lived in @polyengine/runtime/embedder until A22 made that module
// application-only). worker.ts always needed the pin (it
// instantiates the engine); client.ts did not, and now does. What is
// still package-free is everything BELOW the host: the index, the
// namespace, the seal ladder, the locks, the anchor and this file — so a
// consumer that only reads the index to render a picker still needs no
// pins, provided it imports those modules directly rather than through
// mod.ts (which re-exports client.ts). See runtime/README.md.

import type { Driver, Tasks } from "../engine.ts";
import type { Posture, Tier, UnsealPolicy } from "./index.ts";
import type { PrfEnrollment } from "./seal.ts";

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
 * them: `SealError.code` ("wrong-passphrase", "wrong-passkey",
 * "no-rung", "already-sealed", "tampered", "unsupported"),
 * `SealedFsError.fsCode` ("io"), `IdentityKeyError.code`
 * ("extractable", "algorithm", "unavailable"), the worker's own storage
 * binding refusals ("bad-destination", "no-credential" — worker.ts's
 * `StoreError`), the worker's OAuth-ceremony refusals ("bad-ceremony" —
 * a complete with no pending ceremony, or a state that does not match
 * the one the worker minted; "exchange-failed" — the provider's token
 * endpoint refused the exchange, named by HTTP status and never by body
 * content, since a token-endpoint body can echo the request back —
 * worker.ts's `OauthError`), the worker's platform refusal ("no-jspi" —
 * the global has no WebAssembly JS Promise Integration, so the engine
 * cannot be instantiated at all; worker.ts's `PlatformError`), plus this
 * module's own "timeout", "closed" and "unclonable".
 *
 * AND "host-gone", which is the newest and the one worth distinguishing
 * from its nearest neighbour. "timeout" means THIS CALL did not answer
 * in the budget it was given and says nothing else — the call may still
 * be running in a perfectly healthy worker. "host-gone" means the WHOLE
 * HOST stopped answering: client.ts's heartbeat missed two consecutive
 * pings on this port, which is what a browser evicting the SharedWorker
 * looks like from a tab, there being no close event to hear (devstore
 * row 52). It is raised only by client.ts, never by the worker — a dead
 * worker cannot report its own death, which is the entire problem — and
 * it is terminal for the connection it appears on: once one call has
 * seen it, every later call on that connection gets it immediately.
 * Recovery is a fresh `connectDevice`, and it is the only recovery.
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
// THE DRIVER AND TASKS SURFACES MOVE NOTHING ELSE. There is no method on
// either that moves a function, a resource handle, a stream or a class
// instance, so there is no method that needed to be left out. The two
// places where the engine DOES hand out non-clonable things — the
// `EngineNet` fetch/sign seams and the mounted state root — are not on
// those surfaces: they are wired INSIDE the worker at instantiation and
// never named across the port.
//
// THE HOST SURFACE MOVES EXACTLY TWO CryptoKeys, DELIBERATELY, and this
// note used to claim otherwise — it said no method here moves a
// CryptoKey at all, which was true until the passkey rung and would be
// papering over the change now. They are `UnsealOptions.prfKek` and
// `PromoteOptions.prf.kek`. Three facts make that a design rather than
// a leak:
//
//   * CryptoKey is ON the structured-clone list, and the spike measured
//     this exact crossing (spikes/prf-unseal, row 9: a derived KEK
//     handle clones through `postMessage` into a worker and unwraps
//     there) — it is not a value squeezed through a hole.
//   * BOTH ARE NON-EXTRACTABLE, so neither is a bearer secret in the way
//     a passphrase string is: the receiver can ask the platform to
//     unwrap with it and can do nothing else with it, and seal.ts
//     validates that property on arrival rather than trusting it
//     (`requirePrfKek`).
//   * THE CEREMONY HAS NOWHERE ELSE TO RUN. `navigator.credentials` is
//     window-only, so the assertion happens on the page; handing the
//     worker anything LESS derived would mean handing it the raw PRF
//     output, and handing it anything more would mean handing it the
//     DEK. The KEK handle is the narrowest thing that crosses.
//
// Neither is persisted by the worker and neither is echoed back in
// `status()`.
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
  "usStoragePut",
  "usStorageGet",
  "usContactsList",
  "usContactPut",
  "usDevicesList",
  "usDeviceRevoke",
  "usDeviceEndpointPut",
  "usEvents",
  "recoveryKitCreateBucket",
  "recoveryKitCreateFile",
  "recoveryRestoreBucket",
  "recoveryRestoreFile",
  "recoveryConsume",
  "recoveryKits",
  "recoveryKitRevoke",
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
  // `storeGrant` USED TO BE HERE and no longer is (#93). It was a pure
  // remote write while bucket state lived only in instance memory:
  // nothing it changed was in the checkpoint, so scheduling one bought
  // nothing. Now `State.buckets` IS checkpointed — a grant appends to
  // the doc's `grantees` list, and on S3 it republishes K_p against the
  // current name-key epoch — so it mutates persisted state and must
  // schedule a checkpoint like any other mutation.
  "stateCheckpoint",
  "stateResume",
  "pairJoinStatus",
  "pairAddStatus",
  "usProfileGet",
  "usMarksList",
  "usPartitions",
  // `usStorageGet` is a pure read of the account's storage record.
  // `usStoragePut` is DELIBERATELY ABSENT: it writes the user-system
  // doc, so it is a mutation and must schedule a checkpoint — that
  // scheduling is exactly what makes a freshly bound destination
  // survive a worker kill and come back on unseal.
  "usStorageGet",
  "usContactsList",
  "usDevicesList",
  "stats",
  // `usEvents` DRAINS a queue, so it is a mutation of engine state in
  // the strict sense — but the queue is not part of the checkpoint's
  // meaning and a poll loop calling it every 250 ms would defeat the
  // debounce entirely. Treated as a read, deliberately, and recorded
  // here rather than left to be inferred.
  "usEvents",
  // `recoveryKits` is a pure read of the account's `recovery` map — a
  // projection that unlocks nothing and changes nothing. Every OTHER
  // `recovery*` method is deliberately absent: they mint or revoke a
  // member device, write the us-doc and delete bucket objects, which is
  // as much a mutation as anything else on this surface.
  "recoveryKits",
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
  /**
   * THE PASSKEY RUNG'S INPUT: a NON-EXTRACTABLE AES-KW handle the page
   * derived (HKDF-SHA-256) from a fresh assertion's PRF output —
   * device-store/passkey.ts's `assertPasskey`.
   *
   * It is one of the two CryptoKeys that cross this surface by design
   * (see the serialization-discipline note above); the ceremony cannot
   * run in the worker, because `navigator.credentials` is window-only.
   * seal.ts validates the handle on arrival rather than trusting it.
   * Never persisted by the worker, never logged, never echoed back in
   * `status()`.
   */
  prfKek?: CryptoKey;
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
   * keeps or arms the platform wrap. `passkey` enrolls the credential
   * the page just ceremonied and then deletes the platform wrap, for
   * `every-session`'s reason. */
  policy: UnsealPolicy;
  /** Required for `every-session`. Never persisted, never logged, never
   * echoed back in `status()`. */
  passphrase?: string;
  /**
   * REQUIRED FOR `passkey`: the enrollment the PAGE just ran, plus the
   * KEK it derived from it (device-store/passkey.ts's `enrollPasskey`).
   * The worker re-wraps the DEK under that handle and then deletes the
   * platform wrap, for the `every-session` arm's reason.
   *
   * The metadata half is what lands in the wrap record so a later unseal
   * can name the credential again; the `kek` half is the second of the
   * two CryptoKeys this surface moves (see the serialization-discipline
   * note). `passphrase` remains the authorizing secret when the device
   * has no platform rung to re-wrap from — the kept-device switch path.
   */
  prf?: { kek: CryptoKey } & PrfEnrollment;
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
/**
 * `reseal`'s input.
 *
 * Reseal is not a pure discard: it takes a FINAL CHECKPOINT before it
 * drops the engine, and a checkpoint that fails REFUSES the ceremony
 * and leaves the device open (worker.ts's `reseal`). So a rejection
 * here can mean "could not save", not only "could not re-key".
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
  /**
   * PROBE ONLY — boot a FRESH device in seed posture (`init(true)`)
   * instead of the platform posture every real device now uses.
   *
   * It exists for exactly one gate row: proving that a seed-posture
   * checkpoint written before this switch still resumes through the
   * unchanged seed path with the `device-identity` fragment present and
   * ignored. The engine forks on the MANIFEST's recorded posture, not on
   * what the embedder currently prefers (engine/guest/src/persist.rs's
   * "THE POSTURE FORK"), so back-compat is a property to verify rather
   * than assume — and the smallest honest way to verify it is to be able
   * to write one.
   *
   * Named with the leading underscores that `__die` uses, for the same
   * reason: nothing in an application should ever set it.
   */
  __seedPosture?: boolean;
}

/**
 * WHERE THIS DEVICE'S BUCKET IS — the whole of what `bindStore` moves
 * across the port (runtime/STORAGE-EGRESS.md §2, "Nothing crosses the
 * RPC but addressing").
 *
 * ADDRESSING PLUS ONE PUBLIC IDENTIFIER, AND NEVER A CREDENTIAL. The
 * access key is an identifier that already travels to the destination in
 * clear inside the Authorization header; the SECRET behind it never
 * appears on this type, in this file, or anywhere on this wire. The
 * ceremony that takes it runs on the PAGE, escrows it into the origin
 * keystore (runtime/keystore.ts) as a non-extractable handle, and the
 * worker reads that handle back BY DESTINATION ORIGIN out of the same
 * IndexedDB database — so the secret has no path across the port and
 * needs none. A future field carrying one (a bearer, a session token, a
 * password) is not an extension of this type: it is the thing this
 * design forbids, and Dropbox is parked for the worker precisely because
 * it would require it (§5).
 *
 * It is also the shape the engine's `StoreConfig` "s3" arm carries, on
 * purpose: the worker re-applies it as `initStore` at every bring-up.
 *
 * THE GDRIVE ARM SAYS THE SAME THING IN ITS OWN PROVIDER'S VOCABULARY
 * (DRIVE.md §5). `root` and `apiBase` are addressing — `apiBase` for
 * exactly the reason S3's `endpoint` is config, because a self-hosted or
 * fake backend is ordinary addressing rather than a probe hack — and
 * `clientId` is an APP IDENTIFIER, not a user secret: an installed-app
 * OAuth client id, public by nature (DRIVE.md §3, where Google's own
 * documentation is quoted saying an installed app's client secret is
 * "not treated as a secret"). It rides on the binding because the
 * `drive.file` scope confines visibility PER CLIENT ID (§2), so the
 * client id is part of the store's identity beside the root folder.
 *
 * What still never appears on this type: the user's own tokens. The
 * access and refresh tokens are born in the worker, rest sealed there,
 * and have no path across this wire in either direction (§3).
 */
export type StoreBinding =
  | {
    kind: "s3";
    endpoint: string;
    bucket: string;
    accessKey: string;
  }
  | {
    kind: "gdrive";
    root: string;
    apiBase: string;
    clientId: string;
    /**
     * WHICH DRIVE SPACE THE ROOT FOLDER SITS IN — `"appdata"` for the
     * hidden per-app space, `"drive"` for an ordinary visible folder in
     * My Drive (DRIVE.md §5). ADDRESSING, exactly like `root` and
     * `apiBase`: it names a place, grants nothing, and everything below
     * the root folder is identical between the two.
     *
     * It is nonetheless not free to change: the space determines the
     * OAuth SCOPE the consent was granted under (see `OauthStartSpec`),
     * so a binding whose space disagrees with the sealed consent's is
     * refused at bind rather than discovered as a provider 403 later.
     */
    space: GdriveSpace;
  };

/**
 * The two Drive storage spaces this store can address (DRIVE.md §5).
 *
 * `"appdata"` is the default wherever a chooser must pick one: the
 * hidden per-app space cannot be shared at all (the platform enforces
 * it rather than the strategy promising it), and it is out of reach of
 * a Drive-UI rename, which on a store addressed by keyed name would
 * strand a file permanently. `"drive"` stays available because appdata
 * cannot be inspected by its own owner and is orphaned INVISIBLY by an
 * app/client rotation.
 */
export type GdriveSpace = "appdata" | "drive";

/**
 * WHAT THE WORKER'S SYNC SCHEDULE HAS DONE LATELY (runtime/SYNC.md §3,
 * "Surface": "`DeviceStatus` grows a `sync` record (last flush, last
 * pull, backoff state, per the picker-safe rules — timestamps and
 * booleans, nothing secret)").
 *
 * The schedule itself lives in the worker, which is the only thing that
 * outlives a tab and owns both the engine and the binding; this record
 * is the whole of what a page may learn about it. Everything on it is a
 * TIMESTAMP or a COUNT except `lastError`, and that one field carries
 * the rule with it: it is a SENTENCE — the seam's own refusal text, the
 * same class of prose the storage sheet already renders beside the
 * Sync-now button — and never material. No object name, no bearer, no
 * signed URL, no key: the seams that could produce such a thing are
 * already forbidden from putting it in a message (the OAuth ceremony's
 * "the status and not one byte of the body" rule, worker.ts's
 * `OauthError`), and this field inherits that discipline rather than
 * relaxing it. It is truncated on the way in, because a sentence is what
 * a user can read and a page is what gets logged.
 */
export interface SyncStatus {
  /** `Date.now()` of the last SCHEDULED flush cycle in which every
   * partition succeeded, or null if none has. A user-initiated Sync-now
   * does not move it: it is not the scheduler's, and reporting it here
   * would let a button press make a stalled schedule look healthy. */
  lastFlush: number | null;
  /** `Date.now()` of the last scheduled pull cycle that got something
   * through, or null. */
  lastPull: number | null;
  /** CONSECUTIVE failed scheduled flush cycles, zeroed by the first
   * success. Three is where the failure stops being the scheduler's
   * business and becomes the user's (SYNC.md §3: "a sync that has
   * silently stopped is a lie of omission"). */
  flushFailures: number;
  /** The same count for the pull direction. The two back off
   * independently — one bucket can be unreachable for writes and
   * readable, and a shared counter would hide which. */
  pullFailures: number;
  /** The most recent background failure, as a sentence for a human, or
   * null when the last cycle in each direction succeeded. */
  lastError: string | null;
  /**
   * A RESTORE'S KIT IS STILL WAITING TO BE CONSUMED (RECOVERY.md,
   * "Single-use"): the restore fully succeeded and `recoveryConsume()`
   * has not yet.
   *
   * A CONSUME FAILURE NEVER BLOCKS OR UNDOES A RESTORE — an unreachable
   * bucket at the end of a restore is exactly the moment least able to
   * afford a refusal — so it is retried on the flush direction's own
   * backoff loop, which is why the failure ALSO shows up as
   * `flushFailures` and a `lastError` sentence and reaches the
   * announcement threshold like any other stalled sync. This flag is
   * the one thing that count cannot say: WHAT is still outstanding, so
   * a sheet can name it ("your recovery kit has not been retired yet")
   * rather than reporting a generic sync failure.
   *
   * It is a boolean and nothing else. The kit's name, its object and
   * its phrase are not derivable from it, and none of them may ever
   * appear on this type.
   */
  consumePending: boolean;
}


/**
 * WHAT THE WORKER NEEDS IN ORDER TO RUN THE OAUTH CEREMONY (DRIVE.md
 * §3, "The worker runs the OAuth; the page runs the popup").
 *
 * The page owns the popup because a window is a page capability; the
 * worker owns the verifier, the exchange and the tokens. So what crosses
 * on the way IN is app identity plus addressing, and what crosses on the
 * way BACK is a URL — never a token.
 */
export interface OauthStartSpec {
  provider: "gdrive";
  /** The installed-app client id. Public by nature (DRIVE.md §3). */
  clientId: string;
  /**
   * The installed-app client secret, when the registered client class
   * has one. IT IS AN APP IDENTIFIER, NOT A USER SECRET (DRIVE.md §3):
   * it identifies the app, gates nothing without the user's consent, and
   * is the same class as the Dropbox appKey/appSecret the demo's grant
   * already carries in page memory. That is why it may cross this wire
   * when the bearer never may.
   */
  clientSecret?: string;
  /**
   * WHICH SPACE THIS CONSENT IS BEING ASKED FOR, and it belongs on the
   * ceremony rather than only on the binding because THE SPACE
   * DETERMINES THE SCOPE (DRIVE.md §3/§5): `"appdata"` asks for
   * `drive.appdata` (the hidden per-app space and nothing else),
   * `"drive"` asks for `drive.file` (files this app created in the
   * user's visible Drive). Those are two different permissions on two
   * different consent screens, so choosing a space is a CONSENT-TIME
   * decision, not merely a bind-time one — and changing it later means
   * asking the user again.
   */
  space: GdriveSpace;
  /** Where the provider sends the consent result. A loopback URI for a
   * desktop-client pair; the page's own URL in a deployment. */
  redirectUri: string;
  /** ADDRESSING OVERRIDES for a self-hosted or fake backend (the
   * devstore harness's fake Drive, DRIVE.md's Gates section). Absent,
   * Google's own endpoints are used. */
  authUrl?: string;
  tokenUrl?: string;
}

/** What comes back out: a URL for the page to open a popup on. Public
 * data — every parameter in it is either app identity or a PKCE
 * challenge, and the verifier it was derived from stays in the worker. */
export interface OauthStartResult {
  authorizeUrl: string;
}

/**
 * WHICH KIT IS BEING PRESENTED, and it is the ONE PLACE a recovery
 * secret crosses this wire (RECOVERY.md, "Restore"; the threat-model
 * line that prices it: "the restore ceremony types the secret into page
 * script — the same exposure class as the passphrase unseal rung").
 *
 * IT CROSSES ONCE. The worker hands the value straight to the guest and
 * drops its own reference; nothing here is persisted, logged, or echoed
 * back in `status()`. That is the same promise `UnsealOptions.passphrase`
 * carries and it is worth no more than that promise is: a string in a
 * page's heap is a string in a page's heap, and neither side can scrub
 * the other's realm.
 *
 * The FILE arm's `bundle` is not secret on its own — it is sealed under
 * the passphrase beside it — but it is treated identically, because
 * "the file plus its passphrase open the account" and the two travel
 * together here.
 */
export type RecoveryKitInput =
  | { kind: "bucket"; phrase: string }
  | { kind: "file"; bundle: Uint8Array; passphrase: string };

/**
 * WHAT A RESTORE NEEDS, and why it is a HOST METHOD rather than an
 * `AttachSpec` variant (the track's structural decision, recorded here
 * because rpc.ts is where the wire is described).
 *
 * The restore is a BRING-UP MODE: the engine is born from the kit
 * instead of from `init`, so it cannot ride `unseal`, which inits. Two
 * shapes could carry it — a variant on `AttachSpec`, or a method of its
 * own — and the method wins on both counts that matter:
 *
 *   * SECRET LIFETIME. `AttachSpec` is REMEMBERED: worker.ts keeps it in
 *     `attached` for the life of the global (first attach wins, and the
 *     artifacts are re-read from it). A phrase on that record would rest
 *     in worker memory long after the ceremony it belonged to. A method
 *     argument lives for one call.
 *   * WHEN IT IS VALID. Attach happens at CONNECT, before any ceremony
 *     — before the DEK exists, and before the Drive consent a gdrive
 *     restore needs. A method can be refused precisely when it is wrong
 *     ("this namespace already holds a device") instead of being
 *     accepted early and discovered late.
 *
 * The corollary is the two-stage shape below: `restorePrepare` opens the
 * device (mints the DEK) WITHOUT initing an engine, which is what gives
 * the page a window to run the Drive consent — that ceremony seals
 * tokens under the DEK, so it needs one, and the S3 arm needs no such
 * stage because its escrow is page-side and keyed by origin.
 */
export interface RestoreSpec {
  /** Where the restored account's bucket is. Validated with `bindStore`'s
   * own fail-at-bind discipline (STORAGE-EGRESS.md §4) BEFORE anything
   * is fetched: a restore that discovered a missing credential halfway
   * through would leave a half-born device. */
  binding: StoreBinding;
  /** The kit, and the secret that opens it. See `RecoveryKitInput`. */
  kit: RecoveryKitInput;
  /** The user's own word for the machine this became. The kit's label
   * gives way to it in the devices sheet at the end of the restore
   * (engine.wit's `recovery-restore-bucket`). */
  deviceName: string;
  /** The seal choices for the fresh namespace, exactly as `unseal`
   * takes them. Ignored when `restorePrepare` already opened the
   * device. */
  unseal?: UnsealOptions;
}

/**
 * WHICH KIND OF KIT TO MINT (RECOVERY.md, "The kit ceremony").
 *
 * `label` is the name the kit's DEVICE wears in the devices sheet — it
 * is a real leaf in the delegation graph, so it is labelled like one.
 * The `file` arm's `passphrase` is the user's own choice and its
 * strength is the user's own; the ceremony that collects it warns
 * loudly, which is the owner's amendment and the visor's job. It
 * crosses this wire under `RecoveryKitInput`'s discipline.
 */
export type RecoveryKitSpec =
  | { kind: "bucket"; label: string }
  | { kind: "file"; label: string; passphrase: string };

/**
 * What a kit ceremony hands back: the phrase for a bucket kit (displayed
 * once in visor pixels, never persisted), the sealed bytes for a file
 * kit (downloaded by the user, never persisted here).
 */
export type RecoveryKitResult =
  | { kind: "bucket"; phrase: string }
  | { kind: "file"; bundle: Uint8Array };

/** Everything a picker or a strip needs to know, and nothing secret. */
export interface DeviceStatus {
  deviceId: string;
  tier: Tier;
  /** The index row's claim about how this device's identity RESTS.
   * Every device the worker inits is `platform`; a namespace carrying an
   * older seed-posture checkpoint resumes through the seed path
   * regardless, because the engine forks on the manifest, not on this. */
  posture: Posture;
  /** The agent id (a public key, hex) the engine reported when this
   * device was FRESHLY INITED, or null before that has happened. A
   * resume must still be this agent — the engine enforces it against the
   * checkpoint manifest and refuses a mismatch by name. */
  agentId: string | null;
  policy: UnsealPolicy;
  /** True until an unseal succeeds, true again after `reseal()`. The
   * headline fact. */
  sealed: boolean;
  /** Which rungs this device HAS (seal.ts's `sealState`) — the picker's
   * question, answerable without opening anything. `userPassphrase` is
   * the one a reseal ceremony branches on: a passphrase rung EXISTS on
   * every sealed device, but only a `user` one is a door anybody can
   * walk through. `prf` needs no such companion bit — a passkey rung
   * only exists because a person enrolled a credential they hold, so it
   * is always walkable (seal.ts's `PrfWrap`). */
  rungs: { passphrase: boolean; userPassphrase: boolean; untilReseal: boolean; prf: boolean };
  /** True when the next `unseal()` cannot succeed without one.
   *
   * A `passkey`-policy device does NOT need a passphrase: it needs its
   * ceremony, which the picker offers off the `policy` tag (and it may
   * additionally offer a passphrase fallback when `rungs.userPassphrase`
   * says one exists — rungs are additive). */
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
  /**
   * Where this device syncs, or null.
   *
   * NULL MEANS TWO DIFFERENT THINGS AND THE FIELD CANNOT DISTINGUISH
   * THEM, deliberately: the device is SEALED, or it is unsealed and
   * nothing is bound. The sealed case is structural rather than a
   * simplification — the binding rests DEK-sealed in the namespace
   * (STORAGE-EGRESS.md §3), so a sealed host genuinely cannot read it,
   * and a status that named the destination anyway would be pretending
   * to a knowledge it does not have. Read it together with `sealed`: a
   * sealed device's storage is unknown, not absent.
   */
  storage: StoreBinding | null;
  /**
   * The sealed Google Drive consent this namespace holds, or null
   * (DRIVE.md §5), so a sheet can offer bind-without-ceremony.
   *
   * NULL MEANS THE SAME TWO THINGS `storage` NULL DOES, for the same
   * structural reason: the oauth row rests under the DEK, so a SEALED
   * host genuinely cannot know whether one is there. Read it together
   * with `sealed`.
   *
   * IT IS A NULLABLE RECORD RATHER THAN A BOOLEAN, and it mirrors
   * `storage: StoreBinding | null` right above it for the same reason:
   * a boolean plus a separate space field is two facts that can
   * disagree, and one of the two would eventually be read without the
   * other. One nullable record cannot disagree with itself — the space
   * exists exactly when the consent does.
   *
   * STILL NOTHING SECRET. The space is ADDRESSING (which permission was
   * granted, hence where this device may write), the same class as the
   * binding's own `space`. No token, no expiry, no account name —
   * nothing else derived from the sealed row ever appears on this type
   * (DRIVE.md §3/§4).
   */
  gdriveConsent: { space: GdriveSpace } | null;
  /**
   * WHAT THE WORKER'S SYNC SCHEDULE HAS DONE LATELY, or null.
   *
   * NULL MEANS THE SAME KIND OF THING `storage` NULL MEANS, and it is
   * worth spelling out because the two nulls have different arms. The
   * device is SEALED — in which case there is no engine, no timer and
   * no readable binding, so the schedule does not exist to report on —
   * or it is unsealed and NOTHING IS BOUND, in which case there is no
   * destination to sync with and the scheduler deliberately has no
   * opinion. Read it together with `sealed` and `storage`: a sealed
   * device's sync state is unknown, an unbound device's is absent, and
   * neither is "nothing has synced" (which is what
   * `{lastFlush: null, …}` says, on a device that IS bound).
   *
   * It carries no addressing and nothing secret — see `SyncStatus`.
   */
  sync: SyncStatus | null;
}

export type HostMethod =
  | "attach"
  | "detach"
  /**
   * ARE YOU ALIVE — the client heartbeat's whole vocabulary
   * (client.ts's "THE HEARTBEAT"). It takes no arguments, touches no
   * state, and MUST be answerable in every state this worker can be in:
   * before attach, sealed, unsealed, mid-flush, and after an erase.
   * Anything that could make it conditional would turn the death
   * detector into a detector of that condition instead.
   */
  | "ping"
  | "unseal"
  | "promote"
  | "reseal"
  | "checkpoint"
  | "status"
  | "bindStore"
  | "unbindStore"
  // --- account recovery (RECOVERY.md; T-B) ---
  /** Open a fresh namespace WITHOUT initing an engine — the restore
   * path's first stage. See `RestoreSpec`. */
  | "restorePrepare"
  | "restore"
  | "createRecoveryKit"
  | "recoveryKits"
  | "revokeRecoveryKit"
  | "oauthStart"
  | "oauthComplete"
  | "forgetOauth"
  | "destroy"
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
