// The engine composite under polyengine: load the pre-translated envelope,
// assemble the import record (WASI batteries + the fetch-backed
// wasi:http fragment + the polymorph ports + the browser-profile
// sockets stub), and hand back typed views of the two exports.
//
// Every instance gets FRESH import fragments: the port modules' resource
// classes carry per-instance registry identity (polymorph-iroh
// host-deltic finding).

import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import { http } from "@polyengine/wasi/http";
import { webcryptoImports } from "@polymorph/webcrypto-polyengine";
import { websocketImports } from "@polymorph/websocket-polyengine";
import { webrtcImports } from "@polymorph/webrtc-polyengine";
import { socketsImports } from "./stubs.ts";

const DRIVER = "polyvisor:engine/driver@0.1.0";
const TASKS = "polyvisor:tasks/tasks@0.1.0";

/** `store-config` — a WIT variant; `{kind, value}` per the value-mapping
 * convention below. ADDRESSING ONLY (#7/#11): no credential crosses this
 * boundary any more. Whether an instance can write, whose account it acts
 * as, and whether it can sign at all are properties of what its three
 * storage imports were WIRED to below — which config cannot see and must
 * not second-guess. The S3 access key stays because it is a public
 * identifier that travels in the Authorization header in clear. */
export type StoreConfig =
  | {
    kind: "s3";
    value: { endpoint: string; bucket: string; accessKey: string };
  }
  | {
    kind: "dropbox";
    value: { root: string };
  }
  | {
    kind: "gdrive";
    value: { root: string; apiBase: string; space: "appdata" | "drive" };
  };
// gdrive: addressing only, exactly like every other arm (DRIVE.md §2)
// — this is the user-only provider (DRIVE.md §1), so there is no
// credential here at all, not even a public identifier like S3's
// access key. `apiBase` is config for the same reason S3's `endpoint`
// is: a self-hosted (or fake) backend is ordinary addressing, not a
// probe hack.
//
// `space` picks WHERE in the user's Drive the root folder sits, and
// "appdata" is the default wherever a chooser has to pick one. It is a
// location choice, not a second strategy: the `docs`/`pickup` layout
// and the keyed names are identical in both. Hidden appdata makes "no
// sharing" platform-enforced (Drive cannot share those files at all)
// and puts the store out of reach of a Drive-UI rename, which on a
// store addressed by keyed name would strand a file for good. Visible
// "drive" stays available because appdata cannot be inspected by its
// owner and is orphaned INVISIBLY by an app/client rotation — and
// because a live beat against real Google is only checkable by eye in
// a visible folder. The value is a plain string, mirroring the WIT
// record's plain-string fields; the guest validates it and refuses an
// unknown value by name at initStore.

// WIT `result<T, string>` returns resolve T / throw ComponentException.
export interface Driver {
  /** Platform posture (`false`) consults the `device-identity` import
   * first and ADOPTS the embedder-held pair when there is one; only
   * `undefined` mints. `true` is the seed posture and never consults it. */
  init(exportableIdentity: boolean): Promise<string>;
  khKnowsAgent(agentId: Uint8Array): Promise<boolean>;
  khCreateGroup(): Promise<Uint8Array>;
  khAddToGroup(groupId: Uint8Array, memberId: Uint8Array, level: string): Promise<void>;
  khRevokeFromGroup(groupId: Uint8Array, memberId: Uint8Array): Promise<void>;
  khExportCard(agentId: Uint8Array): Promise<Uint8Array>;
  khIngestCard(card: Uint8Array): Promise<number>;
  khAddMember(docId: Uint8Array, agentId: Uint8Array, level: string): Promise<void>;
  khRevokeMember(docId: Uint8Array, agentId: Uint8Array): Promise<void>;
  khContactCard(): Promise<Uint8Array>;
  khIngestContact(card: Uint8Array): Promise<void>;
  irohBind(relayUrl: string): Promise<string>;
  irohStart(
    initiator: boolean,
    peerEndpointId: Uint8Array,
    relayUrl: string,
    expectedPeer: Uint8Array,
  ): Promise<number>;
  connStatus(conn: number): Promise<string | undefined>;
  syncStart(peer: Uint8Array, tree: Uint8Array, subscribe: boolean): Promise<number>;
  syncStatus(handle: number): Promise<string | undefined>;
  createPartition(): Promise<Uint8Array>;
  sealPartition(id: Uint8Array): Promise<void>;
  adoptPartition(id: Uint8Array): Promise<void>;
  chunkStats(id: Uint8Array): Promise<[number, number]>;
  initStore(config: StoreConfig): Promise<void>;
  ensureBucket(): Promise<void>;
  /** S3: none. Dropbox: the member's minted pickup link — their standing
   * capability, carried by the caller in lieu of the E2E channel. */
  storeGrant(docId: Uint8Array, memberId: Uint8Array): Promise<string | undefined>;
  /** Human-readable guarantee note (cooperative vs. server-side hard). */
  storeRevoke(docId: Uint8Array, memberId: Uint8Array): Promise<string>;
  bucketFlush(docId: Uint8Array): Promise<string>;
  /** `pickup` is the link-tier standing capability; owner tiers ignore it. */
  bucketPull(
    docId: Uint8Array,
    ownerId: Uint8Array,
    pickup: string | undefined,
  ): Promise<string>;
  identityExport(
    label: string,
    passphrase: string | undefined,
    secretSlot: Uint8Array | undefined,
  ): Promise<Uint8Array>;
  identityImport(
    bundle: Uint8Array,
    passphrase: string | undefined,
    secret: Uint8Array | undefined,
  ): Promise<string>;

  // --- state persistence (#20 G5) --- (engine.wit's `state-checkpoint` /
  // `state-resume`; the full contract, including the platform-posture
  // seam, is the doc comment there — not repeated here to keep one
  // authority.)

  /** Write a crash-consistent snapshot into the mounted state root.
   * Cadence is the EMBEDDER's: there is no timer in the guest, so
   * whoever holds the engine decides when a checkpoint is worth taking.
   * Rejects when no state root was mounted. */
  stateCheckpoint(): Promise<void>;

  /** Resume from the state root INSTEAD of `init` — call this first and
   * only call `init` when it answers `false`:
   *
   * ```ts
   * if (!await engine.driver.stateResume()) await engine.driver.init(true);
   * ```
   *
   * `false` means "nothing to resume" (no state root, or none valid) and
   * is the fresh-boot path, never an error. A rejection is a real fault —
   * a corrupt root, or a `platform`-posture checkpoint the
   * `device-identity` import cannot answer for: either it answered
   * `none` (this embedding granted no device identity) or it handed back
   * a DIFFERENT device's key than the checkpoint records. */
  stateResume(): Promise<boolean>;

  // --- device pairing (#10) + user-system (#36) --- (engine.wit ~214-280)

  pairJoinStart(): Promise<PairOffer>;
  pairJoinStatus(): Promise<PairJoinState>;
  pairJoinConfirm(): Promise<void>;

  pairAddStart(code: string): Promise<void>;
  pairAddStatus(): Promise<PairAddState>;
  /** device-name: the user's own word for the new device, recorded in
   * the devices annotations by the ADDER (engine.wit's pair-add-confirm
   * doc comment). */
  pairAddConfirm(deviceName: string): Promise<void>;

  pairAbort(): Promise<void>;

  /** First device only: create user group + user-system partition,
   * write the initial profile. Returns the user group id. */
  userCreate(profile: UsProfile): Promise<Uint8Array>;

  usProfileGet(): Promise<UsProfile>;
  usProfileSet(profile: UsProfile): Promise<void>;

  usMarksList(): Promise<UsMark[]>;
  usMarkPut(mark: UsMark): Promise<void>;
  usMarkForget(provenance: string): Promise<void>;
  usMarkConfirm(provenance: string): Promise<void>;

  /** Publish/refresh the account's pointer to a data partition. The map
   * lives in the user-system doc, so it syncs; a freshly paired device
   * discovers the tasks partition by reading `usPartitions()`. */
  usPartitionPut(name: string, id: Uint8Array): Promise<void>;
  usPartitions(): Promise<UsPartition[]>;

  /** Write the account's storage record through (engine.wit's
   * `us-storage-put`; DRIVE.md, "The account syncs its storage config;
   * devices keep their credentials"). Overwrite semantics, one record
   * per account — an account has one store.
   *
   * What rides it: the DESTINATION and, for gdrive, the BYO CLIENT PAIR.
   * They are account-level config by nature — `drive.file` confines
   * visibility per client id and the layout hangs off root + space — so
   * every device must agree on all of them or the store forks
   * invisibly. The client secret is APP identity every device
   * legitimately holds in cleartext anyway, and the channel here is
   * keyhive E2E, so syncing it crosses no line per-device sealing had
   * not already crossed.
   *
   * What does NOT ride it, and the absence IS the enforcement: there is
   * nowhere in `UsStorage` to put an OAuth refresh token or a consent
   * grant, and the SigV4 secret structurally cannot appear (it exists
   * only as a non-extractable handle — there are no bytes to write).
   *
   * The OTHER devices learn about a change through a `storage-changed`
   * event and announce it; this one gets no echo of its own write. */
  usStoragePut(s: UsStorage): Promise<void>;

  /** The account's storage record, or `undefined` on an account that
   * has never bound a store (and on a user-system doc written before
   * this key existed — additive, exactly like the partition map). Never
   * an error for "not set". */
  usStorageGet(): Promise<UsStorage | undefined>;

  usContactsList(): Promise<Array<[Uint8Array, string]>>;
  usContactPut(card: Uint8Array, petname: string): Promise<void>;

  usDevicesList(): Promise<UsDevice[]>;
  usDeviceRevoke(agentId: Uint8Array): Promise<void>;

  /** Drain remotely-caused changes the visor must announce (#22).
   * Local-echo suppression is engine-side: a device never receives
   * events for its own writes. */
  usEvents(): Promise<UsEvent[]>;

  stats(): Promise<string>;
}

// --- device-pairing + user-system WIT record/variant mirrors
// (engine.wit ~214-280). `option<T>` lowers to `T | undefined`, `list<u8>`
// to Uint8Array, `u64` to bigint, `u16`/`u32` to number, `tuple<A, B>` to
// `[A, B]`, and a WIT variant/result case lowers to `{ kind: "case-name";
// value?: payload }` (no `value` key when the case has no payload) — the
// @polyengine/runtime value-mapping convention (embedder/values.ts, the
// authority; verified empirically against this composite, e.g.
// `driver.pairJoinStatus()` resolving `{"kind":"waiting"}`) — same
// convention the existing `StoreConfig` type above already uses.

export interface PairOffer {
  code: string;
  expiresMs: bigint;
}

export interface PairEnrollment {
  userGroupId: Uint8Array;
  partitionId: Uint8Array;
  /** THE ADDER'S IDS, AS THIS DEVICE OBSERVED THEM (engine.wit's
   * `pair-enrollment`). Pairing grants membership and stops; the
   * EMBEDDER owes the pair a sync path (PAIRING.md §2 step 7), and these
   * two are what it needs to dial: `irohStart(true, peerEndpointId,
   * relay, peerAgentId)` from the joiner.
   *
   * Neither is a name the peer claimed. The endpoint id is the
   * transport-authenticated dialer; the agent id is the issuer of the
   * signed delegation in the ENROLL card that made this device a member.
   *
   * They are NOT carried into the visor's `PairingDriver` contract
   * (visor/ui/pairing-driver.ts): the visor has no business dialling
   * anything, so the embedder reads them from the raw driver instead —
   * see runtime/pairing-engine.ts's `toMockJoinState`. */
  peerAgentId: Uint8Array;
  peerEndpointId: Uint8Array;
}

export type PairJoinState =
  | { kind: "waiting" }
  | { kind: "claimed"; value: string } // SAS — display, await pairJoinConfirm
  | { kind: "confirmed-waiting" }
  | { kind: "enrolled"; value: PairEnrollment }
  | { kind: "expired" }
  | { kind: "failed"; value: string };

export type PairAddState =
  | { kind: "connecting" }
  | { kind: "sas-ready"; value: string } // SAS — display, await pairAddConfirm
  | { kind: "waiting-peer" }
  | { kind: "enrolled" }
  | { kind: "failed"; value: string };

export interface UsProfile {
  displayName: string;
  hue: number; // OKLCH hue index per #22 palette (u16)
  icon?: Uint8Array;
}

export interface UsMark {
  provenance: string;
  petname: string;
  /** The pet-icon glyph (engine.wit's `us-mark.icon`), or "" for
   * unmarked. Opaque to the engine — repair is exact-equality only; the
   * curated vocabulary and its confusability rules are the visor's
   * (visor/ui/visor.ts's APP_MARK_ICONS). Was `hue: u16` (#22). */
  icon: string;
  nickname?: string;
  createdAt: bigint;
  needsReconfirm: boolean; // set by conflict repair; cleared by usMarkConfirm
}

/** `us-partition` — a record, so it lowers to a plain object (the
 * `{kind, value}` variant convention above does not apply). `id` is a
 * keyhive doc id as raw bytes, matching every other `list<u8>` here;
 * `hex()`/`unhex()` below convert when a string is wanted. */
export interface UsPartition {
  name: string;
  id: Uint8Array;
}

export interface UsDevice {
  agentId: Uint8Array;
  name: string;
  enrolledAt: bigint;
  revoked: boolean;
}

export type UsEvent =
  | { kind: "profile-changed" }
  | { kind: "mark-added"; value: string } // provenance
  | { kind: "mark-changed"; value: string }
  | { kind: "mark-conflict-repaired"; value: [string, string] } // (provenance, "petname"|"icon")
  | { kind: "device-added"; value: string } // name
  | { kind: "device-revoked"; value: string }
  /** The ACCOUNT'S storage destination changed on another device; the
   * payload is the engine's provider name ("s3" | "gdrive"), the same
   * bare-string shape `device-added` uses. DRIVE.md rules that such a
   * bind "is a change the OTHER devices announce (`us-events`), never
   * silently adopt" — so this is an announcement, not a re-point. */
  | { kind: "storage-changed"; value: string };

/** The S3 arm of the account's storage record — addressing, and NO
 * SECRET, structurally. The SigV4 secret exists only as a
 * non-extractable handle, so there are no bytes to put in a document;
 * `accessKey` is the PUBLIC key identifier. Every device still escrows
 * the secret itself, per device (DRIVE.md, same section). */
export interface UsStorageS3 {
  endpoint: string;
  bucket: string;
  accessKey: string;
}

/** The gdrive arm — addressing plus the BYO client pair. `root`,
 * `apiBase`, `space` and `clientId` are all things every device must
 * agree on or the store forks invisibly in the appdata space;
 * `clientSecret` is app identity, not a user credential. No token
 * field, by design: consent stays per-device. */
export interface UsStorageGdrive {
  root: string;
  apiBase: string;
  space: string;
  clientId: string;
  clientSecret: string;
}

/** `us-storage` — a WIT variant, so it lowers to the `{kind, value}`
 * convention (see the value-mapping note above); kebab fields lower to
 * camelCase. */
export type UsStorage =
  | { kind: "s3"; value: UsStorageS3 }
  | { kind: "gdrive"; value: UsStorageGdrive };

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
}

export interface Snapshot {
  revision: bigint;
  items: TodoItem[];
}

export interface Tasks {
  partition(): Promise<Uint8Array>;
  revision(): Promise<bigint>;
  items(): Promise<Snapshot>;
  add(title: string): Promise<string>;
  setCompleted(id: string, completed: boolean): Promise<void>;
  setTitle(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Engine {
  driver: Driver;
  tasks: Tasks;
  stdout(): string;
  stderr(): string;
}

export interface EngineArtifacts {
  envelope: string;
  bytes: Uint8Array;
}

/** One storage-egress seam: the shape of `store-owner-fetch.request` and
 * `store-public-fetch.request` (the same WIT interface type under two
 * import names — the memo's whole mechanism). A refusal is the err side
 * of `result<response, string>`: a branded ComponentException, not a
 * trap, so the guest can observe a denied egress. */
export type StoreFetch = (
  method: string,
  url: string,
  headers: Array<[string, string]>,
  body: Uint8Array,
) => Promise<{ status: number; body: Uint8Array }>;

/** `store-signer.sign`: public request metadata in, one lowercase-hex
 * signature out. Key material crosses in neither direction. */
export type StoreSign = (
  stringToSign: string,
  date: string,
  region: string,
  service: string,
) => Promise<string>;

/**
 * THE PER-INSTANCE STORAGE AUTHORITY (#7 "authority in the instance,
 * selection by import name"). The engine composite imports three named
 * seams; what each one is wired to IS the grant. Two instances of the
 * same bytes with different `net` are a writer and a reader, and the
 * difference is legible in the wiring rather than in whether some config
 * field happened to be left blank.
 */
export interface EngineNet {
  /** Acts as the user: signs (S3) or injects the held bearer (Dropbox). */
  ownerFetch: StoreFetch;
  /** Carries no identity, ever: strips authorization, injects nothing. */
  publicFetch: StoreFetch;
  /** Carries the APP's identity and never the user's: Dropbox demands an
   * authenticated caller for shared-link reads, but app auth identifies
   * the shipped client, not the person holding it. Its own import is
   * what makes recipient anonymity structural — the user's bearer is
   * wired elsewhere and cannot reach this path. */
  sharedFetch: StoreFetch;
  /** SigV4 over an escrowed non-extractable key (./keystore.ts). */
  signer: StoreSign;
}

/**
 * THE STATE ROOT (#20 G5; runtime/PERSISTENCE.md "State persistence").
 *
 * The engine treats ONE preopened directory as its state root and reaches
 * it through `wasi:filesystem@0.2` — the track `wasm32-wasip2`'s `std::fs`
 * links, which `@polyengine/wasi` serves from BOTH real backends
 * (`filesystem-node` = `node:fs`, sync by construction; `filesystem-web` =
 * OPFS, parking through JSPI, which this engine already requires).
 *
 * Two accepted forms:
 *
 * - a directory handle — `navigator.storage.getDirectory()` or a
 *   subdirectory of it. The browser's per-device OPFS namespace; mounted
 *   here through `@polyengine/wasi/filesystem-web`.
 * - `{ imports }` — a `wasi:filesystem` fragment the embedder built
 *   itself. This is how NON-BROWSER hosts mount a state root, and it is
 *   deliberately the only way: see below.
 *
 * WHY THERE IS NO `string` HOST-PATH FORM, though it would read better.
 * The Deno/Node backend is `@polyengine/wasi/filesystem-node`, which
 * reaches `node:fs` through `process.getBuiltinModule`. This module is
 * bundled into `serve/demo.js` and `serve/solo.js`, and `deno bundle`
 * inlines DYNAMIC imports too — so merely naming that specifier here,
 * even on a branch no browser consumer ever takes, puts a `node:` builtin
 * into the browser bundles. That is not a hypothetical: it tripped
 * `demo/justfile`'s own "NO node: BUILTIN MAY SURVIVE INTO EITHER BUNDLE"
 * check the first time this was written the ergonomic way. Server-side
 * hosts import `filesystemNode` themselves and pass the fragment, which
 * costs them three lines (demo/host/bringup.ts's `denoStateRoot`) and
 * costs the browser nothing.
 *
 * OMITTING IT IS THE DEFAULT AND CHANGES NOTHING. `wasi()`'s batteries
 * already carry a filesystem fragment whose `preopens.get-directories`
 * answers an empty list, so a guest with no state root fails at its first
 * `std::fs` call — which the engine reads as "fresh boot": `stateResume()`
 * answers `false` and `stateCheckpoint()` refuses. Every existing consumer
 * passes nothing here and is byte-for-byte the engine it was before.
 *
 * THE MOUNT IS THE SEALED BOUNDARY. Whatever directory is handed over
 * receives PLAINTEXT — keyhive archive, chunk-envelope keys, and in seed
 * posture the identity seed. PERSISTENCE.md's per-device DEK seals the
 * directory, not the bytes; mounting an unsealed one is choosing an
 * unsealed device.
 */
export type PersistDir =
  | { imports: Record<string, unknown> }
  // The OPFS handle, structurally. `FileSystemDirectoryHandle` does not
  // structurally satisfy the impl's own handle interface (writer parameter
  // form, `Uint8Array<ArrayBufferLike>` vs `ArrayBuffer`), so the cast at
  // the mount site below is expected rather than a smell — the spike hit
  // the same thing (spikes/worker-host/README.md Q2, `worker.ts:198`).
  | { getFileHandle: unknown; getDirectoryHandle: unknown };

/** Build the `wasi:filesystem` fragment for one state root.
 *
 * `filesystem-web` is safe to name here — it is pure web-platform code
 * over OPFS and drags in no `node:` builtin — and it is loaded lazily all
 * the same, so a host that never persists never pays for it. */
async function persistImports(dir: PersistDir): Promise<Record<string, unknown>> {
  if ("imports" in dir) return dir.imports as Record<string, unknown>;
  const { filesystemWeb } = await import("@polyengine/wasi/filesystem-web");
  // `writable: true` IS REQUIRED and is the trap the spike found: the
  // published @polyengine/wasi defaults the whole filesystem fragment to
  // READ-ONLY, and every create/truncate/write throws `read-only` without
  // it (spikes/worker-host/README.md Q2). A checkpoint into a read-only
  // mount is the exact silent-looking failure this comment exists to stop.
  // deno-lint-ignore no-explicit-any -- the structural-shape gap above.
  return filesystemWeb({ preopens: { "/": dir as any }, writable: true }).imports;
}

/**
 * THE APP-OWNED DEVICE IDENTITY (#20 G5; runtime/PERSISTENCE.md "Engine
 * contract additions"; the webcrypto#391 ruling).
 *
 * `polyvisor:engine/device-identity@0.1.0` — a world import, so it MUST be
 * filled at instantiation; `newEngine` therefore always supplies at least
 * the `none`-answering default below.
 *
 * `deviceKeyPair()` resolves the embedder-held pair, or `undefined` for
 * "this embedding persists no device identity" (WIT `option`). The engine
 * consults it at platform-posture `init(false)` — `undefined` means mint a
 * fresh key, the pre-existing behavior — and at `stateResume()` of a
 * platform-posture checkpoint, where `undefined` is an explicit refusal
 * rather than a silent new device.
 *
 * The values are the PORT's typed handles, not raw `CryptoKey`s: the
 * device store's identity library loads the persisted non-extractable
 * `CryptoKey` from the device namespace and launders it through
 * `SigningKey.fromCryptoKey` / `VerifyingKey.fromCryptoKey`
 * (@polymorph/webcrypto 0.4.0, the merged #392 seams). They travel as the
 * PAIR because the port mints them as pairs and a signing key carries no
 * accessor to its verifying half. `unknown` here rather than the port's
 * classes: this module deliberately does not depend on the port's JS
 * surface, and the resource identity that matters is per-instance
 * registry identity, which no static type captures.
 */
export interface DeviceIdentityFragment {
  deviceKeyPair(): Promise<[unknown, unknown] | undefined>;
}

/** The import key for {@link DeviceIdentityFragment}. */
export const DEVICE_IDENTITY = "polyvisor:engine/device-identity@0.1.0";

/** The default: this embedding persists no device identity.
 *
 * Every existing consumer gets this and is byte-for-byte the engine it
 * was before the import existed — platform-posture `init` mints, as it
 * always did. The WORKER HOST OVERRIDES IT (`newEngine`'s
 * `deviceIdentity` parameter) with the device namespace's persisted
 * handle; that fragment is the device-store track's. */
const noDeviceIdentity: DeviceIdentityFragment = {
  deviceKeyPair: () => Promise.resolve(undefined),
};

export async function newEngine(
  label: string,
  artifacts: EngineArtifacts,
  net: EngineNet,
  persistDir?: PersistDir,
  deviceIdentity?: DeviceIdentityFragment,
): Promise<Engine> {
  const shims = wasi({ cli: { args: [`engine-${label}`] } });
  const imports = {
    ...shims,
    // The generic fetch-backed wasi:http fragment stays: the composite no
    // longer routes storage through it, and anything else that wants HTTP
    // is unaffected by this retrofit.
    ...http().imports,
    ...webcryptoImports(),
    ...websocketImports(),
    ...webrtcImports(),
    ...socketsImports(),
    // The three storage seams, by IMPORT NAME. Attaching the wrong
    // authority is inexpressible here rather than checked at request
    // time: a call site that wants the user's identity had to be written
    // against `store-owner-fetch` when the guest was compiled.
    "store-owner-fetch": { request: net.ownerFetch },
    "store-public-fetch": { request: net.publicFetch },
    "store-shared-fetch": { request: net.sharedFetch },
    "store-signer": { sign: net.signer },
    // The shared `response` record's interface is TYPE-ONLY, and the
    // translated plan elides it entirely (verified: the plan's import
    // list holds `store-owner-fetch`, `store-public-fetch` and
    // `store-signer`, and no `store-fetch-types` entry). This empty
    // record is therefore a no-op today, kept because a superfluous
    // import key is ignored — the same reason the wasi:http fragment
    // above can stay — whereas a missing one would be fatal if a future
    // translator does surface it.
    "polyvisor:engine/store-fetch-types@0.1.0": {},
    // The app-owned device identity. NOT optional the way the state root
    // is: a world import must be filled at instantiation, so the stub
    // ships by default and an embedder that persists a key overrides it
    // — exactly the sockets-stub pattern above.
    [DEVICE_IDENTITY]: deviceIdentity ?? noDeviceIdentity,
    // THE STATE ROOT, last so it REPLACES the batteries' empty-preopens
    // filesystem on the `@0.2` track rather than sitting beside it: the
    // resolver refuses a track key and an exact-versioned sibling on one
    // track as ambiguous (@polyengine/wasi's mod.ts, "Per-interface
    // override"). Absent — every existing call site — the batteries stub
    // stays and the guest sees no preopens at all.
    ...(persistDir === undefined ? {} : await persistImports(persistDir)),
  };
  const instance = await instantiate(
    artifactsFromEnvelope(artifacts.envelope, artifacts.bytes),
    imports,
  );
  const driver = instance.exports[DRIVER] as unknown as Driver;
  const tasks = instance.exports[TASKS] as unknown as Tasks;
  if (!driver || typeof driver.init !== "function") {
    throw new Error(
      `export "${DRIVER}" missing or shapeless; exports: ${
        Object.keys(instance.exports).join(", ")
      }`,
    );
  }
  return {
    driver,
    tasks,
    stdout: () => shims.captured.stdoutText(),
    stderr: () => shims.captured.stderrText(),
  };
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Poll until `f` returns a truthy value or the deadline passes. */
export async function until<T>(
  what: string,
  f: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timeout: ${what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
