// The names the device store is built out of, in one place because they
// are the coupling between the index and the namespaces (PERSISTENCE.md,
// "Namespaces"): a device's storage is found from its index row by
// STRING CONSTRUCTION and nothing else, so a typo in one of these is a
// device that exists in the picker and has no state, or state nobody can
// find. Keeping them here also keeps `index.ts` and `namespace.ts`
// acyclic — the index owns rows, the namespace owns storage, and both
// agree on the spelling here.

/** The one unsealed database: the list of devices a boot can offer. */
export const INDEX_DB = "pm-devices";
/** Its single object store; the key is the device id. */
export const INDEX_STORE = "devices";

/** A device's IndexedDB database — sealed blobs and key handles. */
export const nsDbName = (id: string): string => `pm-device-${id}`;
/** A device's OPFS directory — bulk bytes (chunk store, archives). */
export const nsDirName = (id: string): string => `pm-device-${id}`;
/** A device's Web Lock — held by whoever hosts the device (the worker). */
export const deviceLockName = (id: string): string => `pm-device-${id}`;
