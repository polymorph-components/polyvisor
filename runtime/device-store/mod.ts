// THE DEVICE STORE (PERSISTENCE.md — read it first; its vocabulary is
// this module family's vocabulary).
//
// The browser-side home of all devices on an origin: an unsealed INDEX
// of what exists, one NAMESPACE per device, the DEK/KEK ladder that
// SEALS a namespace, an encrypting filesystem over the engine's state
// root, the device LOCK and the T0 sweep, and the sessionStorage
// ANCHOR a tab uses to find its ephemeral device again after a reload.
//
// Everything in this family is callable from a page or a worker and
// holds no long-lived connection, so the WORKER HOST sits on top of it
// without any of it having to change.
//
// THE HOST IS TWO FILES AND ONLY ONE OF THEM IS HERE. `client.ts` (the
// tab's half) and `rpc.ts` (the wire) are exported below; `worker.ts` is
// NOT, and must not be — it is a SharedWorker ENTRY POINT the embedder
// bundles as its own module graph, and it imports ../engine.ts, whose
// bare `@polyengine`/`@polymorph` specifiers only the embedder can map
// (runtime/README.md's resolution model). Re-exporting it would put
// those pins in front of every consumer of the index.

export {
  createDevice,
  type CreateSpec,
  type DeviceRecord,
  ensureDevice,
  getDevice,
  listDevices,
  newDeviceId,
  type Posture,
  promoteDevice,
  type PromoteSpec,
  removeDevice,
  type Tier,
  touchDevice,
  type UnsealPolicy,
} from "./index.ts";

export {
  type DeviceNamespace,
  destroyNamespace,
  namespaceExists,
  NS_STORES,
  openNamespace,
} from "./namespace.ts";

export { deviceLockName, INDEX_DB, INDEX_STORE, nsDbName, nsDirName } from "./names.ts";

export {
  createSealedDek,
  enableUntilReseal,
  rekeyFromPlatform,
  rekeyPassphrase,
  reseal,
  SealError,
  sealedDelete,
  sealedGet,
  sealedPut,
  type SealState,
  sealState,
  unsealFromPlatform,
  unsealWithPassphrase,
} from "./seal.ts";

export {
  deleteIdentity,
  DEVICE_ENDPOINT_KEY,
  DEVICE_IDENTITY_KEY,
  IdentityKeyError,
  loadIdentity,
  loadOrMintIdentity,
  persistIdentity,
  usableIdentity,
} from "./identity-keys.ts";

export {
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  sealedDirectory,
  SealedFsError,
  sealedPreopens,
} from "./sealed-fs.ts";

export {
  type DeviceLock,
  deviceLockIsHeld,
  holdDeviceLock,
  LEASE_INTERVAL_MS,
  LEASE_STALE_MS,
  type LeaseHeartbeat,
  leaseIsStale,
  readLease,
  startLease,
  type SweepResult,
  sweepT0,
  touchLease,
} from "./locks.ts";

export { adoptAnchor, anchorIsLive, clearAnchor, getAnchor, setAnchor } from "./anchor.ts";

export {
  type ConnectSpec,
  connectDevice,
  type DeviceChoice,
  type DeviceConnection,
} from "./client.ts";

export {
  type AttachSpec,
  DeviceHostError,
  type DeviceStatus,
  DRIVER_METHODS,
  type Hello,
  type HostMethod,
  type PromoteOptions,
  type ResealOptions,
  READONLY_METHODS,
  TASKS_METHODS,
  type UnsealOptions,
  type HostError,
  type WireFailure,
} from "./rpc.ts";
