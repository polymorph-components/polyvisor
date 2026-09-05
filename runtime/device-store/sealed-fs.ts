// THE ENCRYPTING FILESYSTEM: the engine's state root, sealed at rest
// while the GUEST sees plaintext (PERSISTENCE.md, "Sealing" — bulk
// state under the per-device DEK; "State persistence" — the engine
// world's wasi:filesystem imports mount a per-device OPFS directory).
//
// WHAT WAS SHIPPED, AND WHY IT IS THE SEAM AND NOT A FALLBACK. This is
// an OPFS-DIRECTORY proxy fed INTO `@polyengine/wasi`'s `filesystemWeb`,
// not an interposer over the assembled imports fragment. The published
// backend consumes OPFS through STRUCTURAL interfaces and says so in its
// own header ("any object implementing the structural handle interfaces
// below works, including in-memory fakes for tests" —
// filesystem_web.ts:1-6), so a proxy at that level is the supported
// extension point. Interposing above it instead would mean re-
// implementing the descriptor surface the provider already implements
// (open-at, read/write via stream, stat, rename, identity) and doing so
// at BYTE OFFSETS, where whole-file sealing has no natural boundary.
// Below it, every offset question is already resolved into
// `getFile()`/`createWritable()` — exactly the whole-file granularity
// v1 wants. The engine-facing surface is byte-identical with and
// without sealing: the same `filesystemWeb({preopens, writable:true})`
// fragment, only the handle differs.
//
// (`writable: true` is REQUIRED and is not a no-op: the pinned
// jsr:@polyengine/wasi@0.3.1 defaults the fragment to READ-ONLY and
// answers `read-only` to any create/truncate/write open. The spike's Q2
// failed on exactly that — spikes/worker-host/worker.ts:236-247.)
//
// GRANULARITY, v1: WHOLE FILE. A read buffers and opens the whole file;
// a writable buffers the whole plaintext and seals it on `close()`.
// Checkpoint files are KB-scale, so this is bought cheaply; the chunk
// store is the case that would not survive it, and PERSISTENCE.md parks
// it explicitly ("sealing the OPFS chunk store" — the store holds
// envelope ciphertext and may rest unsealed in v1).
//
// VERIFICATION HAPPENS ABOVE THE SEAL. The engine's checkpoint digests
// are computed over PLAINTEXT as the engine wrote it. This layer is
// invisible to that: what the engine reads back is byte-for-byte what it
// wrote, so a digest taken before sealing and re-taken after unsealing
// agree. Nothing here should ever be asked to make a claim about the
// ciphertext, and nothing above should ever digest it.
//
// HONEST LIMITS, stated rather than implied:
//   * PER-FILE INTEGRITY, NOT WHOLE-TREE. AES-GCM's tag detects any
//     modification of a file's bytes, and the header is authenticated
//     as AAD so an unsealed file cannot pass as a sealed one. It does
//     NOT detect an attacker with write access to the directory
//     REPLACING one sealed file with an older version of itself, or
//     with another file sealed under the same DEK. Binding the path in
//     as AAD would answer the second and break the first thing the
//     engine does with a checkpoint (rename it into place). A real
//     answer is a signed manifest above this layer; parked, recorded.
//   * FILE NAMES AND SIZES REST IN THE CLEAR. Directory structure is
//     OPFS's, unencrypted; only contents are sealed. Sizes leak to
//     within the fixed 28-byte overhead.
//   * NOT CRASH-ATOMIC BEYOND OPFS's OWN GUARANTEE. A writable commits
//     on close, so a crash mid-close leaves the previous sealed content
//     or a truncated file that fails to open — never a half-decrypted
//     one. The engine's checkpoint semantics are crash-CONSISTENT, not
//     write-through-perfect (PERSISTENCE.md), which this matches.

/** Wrong DEK, unsealed bytes where sealed ones were expected, or a
 * tampered file. Tagged with `fsCode` so the polyengine provider maps
 * it onto a wasi errno instead of trapping: the guest sees an I/O
 * error, which is a thing filesystems do, rather than the host
 * exploding. */
export class SealedFsError extends Error {
  /** Consumed by the provider's `mapError` (fs_provider.ts). */
  readonly fsCode = "io";
  /** `cause` carries the sealer's own refusal — the component's
   * `seal-error`, lowered — so a debugger can still see WHICH refusal it
   * was without that becoming part of the filesystem's contract. */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SealedFsError";
  }
}

// --- the structural OPFS surface -------------------------------------------
//
// Mirrors `@polyengine/wasi/filesystem-web`'s exported interfaces
// EXACTLY, and is declared here rather than imported so that this module
// depends on no package at all (runtime/README.md's resolution model:
// these modules are resolved by the embedder, and a wrapper that needs
// no pin is a wrapper the embedder cannot mis-pin). If the published
// interfaces drift, the assignment at the `filesystemWeb({preopens})`
// call site is where it will be caught.

export interface OpfsFileLike {
  readonly size: number;
  readonly lastModified: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritable {
  write(params: { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean>;
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsDirectoryHandle | OpfsFileHandle]>;
  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean>;
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

// --- the sealing seam -------------------------------------------------------

/**
 * WHAT SEALS AND OPENS A FILE'S BYTES — the device seal component's
 * `sealed` interface (world.wit:296-307), handed in rather than
 * performed here.
 *
 * THE FORMAT MOVED AND THIS MODULE NO LONGER KNOWS IT. PMSEALv1's magic,
 * its 12-byte IV, the additional data and the empty-file rule all live in
 * the component (runtime/device-seal/src/file_format.rs, which cites the
 * lines of this file they were ported from). What is left here is the
 * PROXY: buffering, the plaintext view, growth and truncation, handle
 * identity — everything that is about OPFS rather than about
 * cryptography.
 *
 * The proxy passes bytes through UNCHANGED in both directions and adds no
 * special case of its own, which is the same thing the deleted code did:
 * `sealBytes` had no empty-plaintext branch (an empty file the guest
 * actually wrote costs a full header and tag), and the zero-length read
 * was `openBytes`'s rule, not the proxy's. Both are the component's now.
 */
export interface FileSealer {
  sealFile(plaintext: Uint8Array): Promise<Uint8Array>;
  openFile(sealed: Uint8Array): Promise<Uint8Array>;
}

// --- the plaintext view -----------------------------------------------------

/** The `File`-shaped plaintext view the provider reads through. Its
 * `size` is the PLAINTEXT size, which is what makes `stat` and every
 * offset the guest computes agree with what the guest wrote. */
function plainFile(bytes: Uint8Array, lastModified: number): OpfsFileLike {
  const buf = () => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  };
  return {
    size: bytes.length,
    lastModified,
    arrayBuffer: () => Promise.resolve(buf()),
    slice: (start: number, end: number) => ({
      arrayBuffer: () => {
        const s = bytes.subarray(start, end);
        const copy = new Uint8Array(s.length);
        copy.set(s);
        return Promise.resolve(copy.buffer);
      },
    }),
  };
}

/**
 * RE-TAG THE SEALER'S REFUSAL AS A FILESYSTEM ERROR.
 *
 * The component refuses a file that does not open with a `seal-error`,
 * which the adapter lowers to a `SealError` — and a `SealError` carries
 * no `fsCode`, so the polyengine provider's `mapError` would not
 * recognize it and the host would explode where a filesystem should
 * merely report an error. `SealedFsError` is what makes the guest see an
 * I/O error instead, which is the whole reason that class has an
 * `fsCode` at all; the wrapping keeps that contract across the move.
 *
 * A wrong DEK and altered bytes are the same event to GCM and were
 * always reported as one, so nothing is lost by flattening the
 * component's refusal into this sentence.
 */
async function asFsError<T>(what: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    throw new SealedFsError(
      `${what}: did not open under this device key (wrong key or altered bytes)`,
      { cause: e },
    );
  }
}

function sealedFile(inner: OpfsFileHandle, sealer: FileSealer): OpfsFileHandle {
  const read = async (): Promise<{ bytes: Uint8Array; lastModified: number }> => {
    const f = await inner.getFile();
    const raw = new Uint8Array(await f.arrayBuffer());
    return {
      bytes: await asFsError(inner.name, () => sealer.openFile(raw)),
      lastModified: f.lastModified,
    };
  };

  const handle: OpfsFileHandle = {
    kind: "file",
    name: inner.name,
    async getFile() {
      const { bytes, lastModified } = await read();
      return plainFile(bytes, lastModified);
    },

    /**
     * A BUFFERED writable. The provider does every positional write as
     * open-writable → write → close with `keepExistingData: true`
     * (filesystem_web.ts's `writeAt`), so each guest write costs one
     * decrypt of the old content and one encrypt of the new. That is
     * the whole-file granularity being paid for, per write, and it is
     * why this is v1-for-checkpoints and not v1-for-chunk-stores.
     */
    async createWritable(opts?: { keepExistingData?: boolean }) {
      let buffer = opts?.keepExistingData ? (await read()).bytes : new Uint8Array(0);
      return {
        write: (params: { type: "write"; position: number; data: Uint8Array }) => {
          const end = params.position + params.data.length;
          if (end > buffer.length) {
            // Growing a file by writing past its end zero-fills the
            // gap, as POSIX does and as OPFS does.
            const grown = new Uint8Array(end);
            grown.set(buffer);
            buffer = grown;
          }
          buffer.set(params.data, params.position);
          return Promise.resolve();
        },
        truncate: (size: number) => {
          const next = new Uint8Array(size);
          next.set(buffer.subarray(0, Math.min(size, buffer.length)));
          buffer = next;
          return Promise.resolve();
        },
        close: async () => {
          // THE SEAL HAPPENS HERE, once, on the whole file — and the
          // underlying writable is opened WITHOUT keepExistingData, so
          // the previous ciphertext (a different length in general) can
          // never leave a tail behind the new one.
          const raw = await asFsError(inner.name, () => sealer.sealFile(buffer));
          const w = await inner.createWritable({ keepExistingData: false });
          try {
            await w.write({ type: "write", position: 0, data: raw });
          } finally {
            await w.close();
          }
        },
      };
    },

    isSameEntry: (other) => inner.isSameEntry(unwrap(other)),
  };
  // `move` is exposed only when the platform has it, because the
  // provider BRANCHES on its presence (rename falls back to copy+delete
  // otherwise) and a proxy that pretended would turn a missing feature
  // into a runtime failure. Renaming a sealed file is a pure metadata
  // operation: the ciphertext is not path-bound (see HONEST LIMITS).
  if (inner.move) handle.move = (parent, name) => inner.move!(unwrap(parent) as OpfsDirectoryHandle, name);
  return handle;
}

const INNER = Symbol("sealed-fs.inner");

function unwrap(h: OpfsFileHandle | OpfsDirectoryHandle): OpfsFileHandle | OpfsDirectoryHandle {
  return (h as unknown as Record<symbol, OpfsFileHandle | OpfsDirectoryHandle>)[INNER] ?? h;
}

/**
 * Wrap an OPFS directory so every file under it rests sealed by
 * `sealer` while readers and writers see plaintext. Sub-directories are
 * wrapped on the way out, so the whole subtree is covered.
 *
 * Hand the result to `filesystemWeb({ preopens: { "/": here }, writable:
 * true })`. Nothing above needs to know it is there.
 */
export function sealedDirectory(inner: OpfsDirectoryHandle, sealer: FileSealer): OpfsDirectoryHandle {
  const dir: OpfsDirectoryHandle = {
    kind: "directory",
    name: inner.name,
    getDirectoryHandle: async (name, opts) =>
      sealedDirectory(await inner.getDirectoryHandle(name, opts), sealer),
    getFileHandle: async (name, opts) => sealedFile(await inner.getFileHandle(name, opts), sealer),
    removeEntry: (name, opts) => inner.removeEntry(name, opts),
    entries: async function* () {
      for await (const [name, h] of inner.entries()) {
        yield [name, h.kind === "directory" ? sealedDirectory(h, sealer) : sealedFile(h, sealer)] as [
          string,
          OpfsDirectoryHandle | OpfsFileHandle,
        ];
      }
    },
    isSameEntry: (other) => inner.isSameEntry(unwrap(other)),
  };
  if (inner.move) dir.move = (parent, name) => inner.move!(unwrap(parent) as OpfsDirectoryHandle, name);
  // The identity escape hatch: `isSameEntry` and `move` take the OTHER
  // side's handle, and OPFS compares real handles, not proxies.
  (dir as unknown as Record<symbol, unknown>)[INNER] = inner;
  return dir;
}

/**
 * The preopens map for a sealed mount, ready to spread into
 * `filesystemWeb`:
 *
 * ```ts
 * const ns = openNamespace(id);
 * const fragment = filesystemWeb({
 *   preopens: sealedPreopens(seal.sealed, { "/": await ns.directory() }),
 *   writable: true,
 * });
 * ```
 *
 * The DOM's `FileSystemDirectoryHandle` does not STRUCTURALLY satisfy
 * these interfaces (the writable's `write` overload set and the
 * `Uint8Array<ArrayBufferLike>` split — spikes/worker-host/worker.ts:
 * 202-210 documents the same friction); the runtime shapes match
 * exactly, so callers cast at this boundary. It is a cast, not a
 * workaround.
 */
export function sealedPreopens(
  sealer: FileSealer,
  preopens: Record<string, OpfsDirectoryHandle>,
): Record<string, OpfsDirectoryHandle> {
  return Object.fromEntries(
    Object.entries(preopens).map(([guestName, handle]) => [guestName, sealedDirectory(handle, sealer)]),
  );
}
