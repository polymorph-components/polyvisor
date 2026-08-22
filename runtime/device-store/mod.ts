// THE DEVICE STORE (PERSISTENCE.md — read it first; its vocabulary is
// this module family's vocabulary).
//
// The browser-side home of all devices on an origin: an unsealed INDEX
// of what exists, one NAMESPACE per device, the DEK/KEK ladder that
// SEALS a namespace, an encrypting filesystem over the engine's state
// root, the device LOCK and the T0 sweep, and the sessionStorage
// ANCHOR a tab uses to find its ephemeral device again after a reload.
//
// What is NOT here, deliberately: the worker host and its RPC envelope
// (the next track). Everything in this family is callable from a page
// or a worker and holds no long-lived connection, so the host can sit
// on top of it without any of it having to change.

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
