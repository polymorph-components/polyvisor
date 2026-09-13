/** Browser half of the runtime's fixed backup-KDF import. Chromium does not
 * expose `Worker` inside a SharedWorker, so the device worker asks one of its
 * connected trusted tabs to create the one-shot dedicated worker. */
export interface KdfRequest {
  passphrase: string;
  salt: Uint8Array;
}

export type DispatchKdf = (request: KdfRequest) => Promise<Uint8Array>;

/** Run one request in a dedicated page-owned worker. SharedWorkers cannot
 * construct nested workers in Chromium, so boot.ts invokes this for the
 * device worker and sends the bytes back over its control port. */
export function runBackupKdf(
  request: KdfRequest,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) return Promise.reject(new Error("backup KDF worker cancelled"));
  let worker: Worker;
  try {
    // Bundled into dist/boot.js beside kdf-worker.js.
    worker = new Worker(new URL("kdf-worker.js", import.meta.url), {
      type: "module",
      name: "polyvisor-backup-kdf-v1",
    });
  } catch (error) {
    return Promise.reject(error);
  }
  let timeout: number;
  let abort: () => void;
  return new Promise<Uint8Array>((resolve, reject) => {
    abort = () => reject(new Error("backup KDF worker cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => reject(new Error("backup KDF worker timed out")),
      30_000,
    );
    worker.onmessage = (reply: MessageEvent) => {
      const value = reply.data as { ok?: unknown; error?: unknown };
      if (value?.ok instanceof Uint8Array && value.ok.byteLength === 32) {
        resolve(value.ok);
      } else if (typeof value?.error === "string") {
        reject(new Error(value.error));
      } else {
        reject(new Error("backup KDF worker returned a malformed response"));
      }
    };
    worker.onerror = (failure) =>
      reject(new Error(failure.message || "backup KDF worker failed"));
    worker.onmessageerror = () =>
      reject(new Error("backup KDF worker returned an unreadable response"));
    worker.postMessage(request);
  }).finally(() => {
    signal.removeEventListener("abort", abort);
    clearTimeout(timeout);
    worker.terminate();
  });
}

/** Validate the fixed byte boundary before dispatching to the requesting tab. */
export function createBackupKdf(dispatch: DispatchKdf) {
  return {
    async derive(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
      if (!(salt instanceof Uint8Array) || salt.byteLength !== 16) {
        throw new Error("backup salt must be 16 bytes");
      }
      const key = await dispatch({ passphrase, salt });
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
        throw new Error("backup KDF returned an invalid key");
      }
      return key;
    },
  };
}
