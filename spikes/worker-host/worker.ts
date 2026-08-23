// THE SPIKE'S SHARED WORKER — the candidate device host.
//
// Everything the G5 persistence round wants to put in a worker is
// exercised from HERE, never from the page: the engine composite
// (polyengine runtime + the demo's built envelope), OPFS through the
// polyengine wasi filesystem, a non-extractable WebCrypto identity in
// IndexedDB, a Web Lock, and (optionally) an iroh bind over WebSocket.
// The page is only an RPC client, so a PASS here is a claim about the
// worker and not about the page's ambient capabilities.
//
// Loaded as a MODULE SharedWorker (`{type:"module"}`) — see page.ts.

import { hex, newEngine, unhex } from "../../runtime/engine.ts";
import { ComponentException } from "@polyengine/protocol";
import { filesystemWeb } from "@polyengine/wasi/filesystem-web";

// --- worker-global identity + boot counter (question 4) ---------------------
//
// INSTANCE_NONCE is minted once per WORKER GLOBAL SCOPE: two pages that
// are served by one worker see the same nonce; a respawned worker gets a
// new one. BOOT_SEQ is the same fact made durable (IndexedDB), so it
// survives even the observer that would otherwise have to remember the
// previous nonce.
const INSTANCE_NONCE = crypto.randomUUID();
const BOOTED_AT = Date.now();
/** The SharedWorker's name — `spike-worker-host`, or
 * `spike-worker-host-extended` for the extendedLifetime variant (page.ts).
 * A worker is keyed by (origin, script URL, name), so the two are
 * DIFFERENT workers and every per-worker fact below is scoped by it:
 * an unscoped boot counter would interleave two workers' boots, and an
 * unscoped lock name would leave the second worker blocked forever
 * behind the first one's never-released exclusive grant. */
const WORKER_NAME = (self as unknown as { name?: string }).name || "spike-worker-host";

const DB = "spike-worker-host";
const STORE = "kv";

const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
    open.onblocked = () => rej(new Error("IndexedDB open blocked"));
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await idbReq(db.transaction(STORE).objectStore(STORE).get(key)) as T | undefined;
  } finally {
    db.close();
  }
}

async function kvPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Incremented ONCE per worker global scope, at module evaluation. A
 * reload that reuses the worker leaves it alone; a respawn bumps it. */
const bootSeq: Promise<number> = (async () => {
  const prev = (await kvGet<number>(`bootSeq:${WORKER_NAME}`)) ?? 0;
  const next = prev + 1;
  await kvPut(`bootSeq:${WORKER_NAME}`, next);
  return next;
})();

// --- question 5: a Web Lock held by the worker ------------------------------
//
// Held for the LIFETIME OF THE WORKER: the promise the callback returns
// never settles, so the lock is released only when this global scope
// goes away. That is the whole point — a device host wants a lock whose
// release IS the signal that the host died.
const LOCK_NAME = `${WORKER_NAME}-device`;
let lockHeld = false;
let lockError: string | null = null;
const lockAcquired = new Promise<void>((resolveAcquired) => {
  navigator.locks.request(LOCK_NAME, () => {
    lockHeld = true;
    resolveAcquired();
    return new Promise<never>(() => {}); // never released while we live
  }).catch((e) => {
    lockError = String(e);
    resolveAcquired();
  });
});

// --- question 3: the durable non-extractable identity -----------------------
//
// Pattern from ~/p/wosh/site/identity-store.ts:66 (`usable` validates a
// stored value against exactly what `mint` makes) and :79 (`loadOrMint`
// settles a two-client race inside ONE readwrite transaction).
const KEY_ID = "device-ed25519";

function mintKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    "Ed25519",
    /* extractable (private half) */ false,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

function usable(v: unknown): v is CryptoKeyPair {
  const pair = v as CryptoKeyPair | null;
  return typeof pair === "object" && pair !== null &&
    pair.privateKey instanceof CryptoKey &&
    pair.publicKey instanceof CryptoKey &&
    pair.privateKey.algorithm.name === "Ed25519" &&
    !pair.privateKey.extractable &&
    pair.privateKey.usages.includes("sign");
}

async function loadOrMintKey(): Promise<{ pair: CryptoKeyPair; minted: boolean }> {
  const existing = await kvGet<unknown>(KEY_ID);
  if (usable(existing)) return { pair: existing, minted: false };
  const candidate = await mintKey();
  // Race-free settle: one readwrite transaction decides the winner.
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const race = await idbReq(store.get(KEY_ID));
    let winner: CryptoKeyPair;
    let minted: boolean;
    if (usable(race)) {
      winner = race;
      minted = false;
    } else {
      store.put(candidate, KEY_ID);
      winner = candidate;
      minted = true;
    }
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = tx.onerror = () => rej(tx.error);
    });
    return { pair: winner, minted };
  } finally {
    db.close();
  }
}

const hexOf = (b: ArrayBuffer | Uint8Array): string =>
  hex(b instanceof Uint8Array ? b : new Uint8Array(b));

async function keyProbe() {
  const { pair, minted } = await loadOrMintKey();
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  const msg = new TextEncoder().encode("worker-host spike");
  const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, msg);
  const verified = await crypto.subtle.verify("Ed25519", pair.publicKey, sig, msg);
  let exportRefused = false;
  try {
    await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  } catch {
    exportRefused = true; // non-extractable keys refuse export — the claim
  }
  return {
    minted,
    extractable: pair.privateKey.extractable,
    exportRefused,
    publicKey: hexOf(pub),
    signature: hexOf(sig).slice(0, 16) + "…",
    signatureLen: sig.byteLength,
    verified,
  };
}

// --- question 2: OPFS through the polyengine wasi filesystem ----------------
//
// filesystem_web.ts:16 states outright that `createSyncAccessHandle` is
// dedicated-worker-only and that the impl deliberately targets the
// portable ASYNC handle API (createWritable/getFile) — so nothing here
// should hit the shared-worker restriction. This probe checks that
// empirically, and drives the wasi layer rather than raw OPFS: the 0.3
// `Descriptor` is async in WIT and therefore directly callable
// host-side, with no guest and no JSPI (fs_provider.ts:892
// writeViaStream, :872 readViaStream), which is what makes wiring the
// real wasi layer cheap enough to be worth doing.
async function opfsProbe() {
  const root = await navigator.storage.getDirectory();
  // TYPE-ONLY FRICTION, recorded because it will bite the real host too:
  // the dom lib's `FileSystemDirectoryHandle` does NOT structurally
  // satisfy filesystem_web.ts's `OpfsDirectoryHandle` (its `createWritable`
  // writer types `write(FileSystemWriteChunkType)` where the interface
  // wants the `{type:"write",position,data}` param form, and the
  // Uint8Array<ArrayBufferLike>/ArrayBuffer split compounds it). The
  // runtime shapes match exactly — the impl only ever passes the param
  // form, which the DOM accepts — so this is a cast, not a workaround.
  type Preopens = Parameters<typeof filesystemWeb>[0]["preopens"];
  // `writable: true` IS REQUIRED, and its absence is not a no-op: the
  // pinned jsr:@polyengine/wasi@0.3.1 defaults the whole fragment to
  // READ-ONLY (`makeFilesystem(..., {writable})`, bundled at
  // serve/worker.js:17927-17962 — `requireOpenAllowed` throws
  // `read-only` for any create/truncate/write open). The first run of
  // this probe failed exactly there. Note the working-tree copy of the
  // impl at ~/p/polymorph/polyengine/wasi/src/filesystem_web.ts has NO
  // such option — it is ahead of/behind the published 0.3.1 the demo
  // pins, so read the pin, not the checkout, for behavioural questions.
  const fragment = filesystemWeb(
    { preopens: { "/": root } as unknown as Preopens, writable: true } as unknown as
      Parameters<typeof filesystemWeb>[0],
  );
  const imports = fragment.imports as Record<string, Record<string, unknown>>;
  const preopens03 = imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [Descriptor03Like, string][];
  };
  const dirs = preopens03.getDirectories();
  const [dir, guestName] = dirs[0];

  const path = `spike-${Date.now()}.txt`;
  const payload = `hello from the shared worker ${INSTANCE_NONCE}`;
  const file = await dir.openAt(
    {},
    path,
    { create: true, truncate: true },
    { read: true, write: true },
  );
  await file.writeViaStream([new TextEncoder().encode(payload)], 0n);

  // Re-open from a FRESH descriptor so the read cannot be served by any
  // state the write left behind.
  const reopened = await dir.openAt({}, path, {}, { read: true });
  const [chunks] = reopened.readViaStream(0n);
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  const readBack = new TextDecoder().decode(
    parts.reduce((a, b) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    }, new Uint8Array()),
  );

  // Whether the SYNC access handle (the dedicated-worker-only API the
  // module header calls out) is in fact refused here. Informational: the
  // impl never calls it, but the record should say what the platform does.
  let syncHandle = "not attempted";
  try {
    const fh = await root.getFileHandle(path);
    const sync = await (fh as unknown as {
      createSyncAccessHandle?: () => Promise<{ close(): void }>;
    }).createSyncAccessHandle?.();
    if (sync) {
      sync.close();
      syncHandle = "ALLOWED in this SharedWorker (surprise)";
    } else {
      syncHandle = "createSyncAccessHandle absent on the handle";
    }
  } catch (e) {
    syncHandle = `refused: ${(e as Error).name}: ${(e as Error).message}`;
  }

  await root.removeEntry(path).catch(() => {});
  return { guestName, path, wrote: payload, readBack, ok: readBack === payload, syncHandle };
}

interface Descriptor03Like {
  openAt(
    pathFlags: Record<string, boolean>,
    path: string,
    openFlags: Record<string, boolean>,
    flags: Record<string, boolean>,
  ): Promise<Descriptor03Like>;
  writeViaStream(data: Iterable<Uint8Array>, offset: bigint): Promise<unknown>;
  readViaStream(offset: bigint): [AsyncIterable<Uint8Array>, Promise<unknown>];
}

// --- question 1: the engine composite, instantiated in the worker -----------

const NO_STORE = {
  ownerFetch: () => Promise.reject(new ComponentException("no storage destination")),
  publicFetch: () => Promise.reject(new ComponentException("no storage destination")),
  sharedFetch: () => Promise.reject(new ComponentException("no storage destination")),
  signer: () => Promise.reject(new ComponentException("no signing credential")),
};

async function fetchArtifacts(name: string) {
  const [envelope, bytes] = await Promise.all([
    fetch(new URL(`./${name}.plan.json`, self.location.href)).then((r) => {
      if (!r.ok) throw new Error(`${name} plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(new URL(`./${name}.component.wasm`, self.location.href)).then((r) => {
      if (!r.ok) throw new Error(`${name} wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

/** ONE engine instance per worker, like a device host would have. */
let enginePromise: ReturnType<typeof newEngine> | undefined;
function engine() {
  enginePromise ??= (async () => {
    const art = await fetchArtifacts("engine");
    // deno-lint-ignore no-explicit-any
    return await newEngine("worker", art, NO_STORE as any);
  })();
  return enginePromise;
}

/** The bringup.ts `solo` phase (demo/host/bringup.ts:52-77), moved into
 * a SharedWorker: init → create-partition → (kh-add-member) → seal →
 * tasks.add ×2 → tasks.items. Every one of these suspends through JSPI
 * inside the guest, so a green run IS the JSPI-in-SharedWorker answer. */
async function engineProbe() {
  const steps: string[] = [];
  const t0 = performance.now();
  const e = await engine();
  steps.push(`instantiate ${(performance.now() - t0).toFixed(0)}ms`);

  const id = await e.driver.init(false);
  steps.push(`init ${id.slice(0, 16)}…`);

  const part = await e.driver.createPartition();
  steps.push(`create-partition ${hex(part).slice(0, 16)}…`);

  // KH-ADD-MEMBER (self). The bringup `solo` phase does NOT do this — a
  // freshly created partition is already delegated to its creator — so a
  // refusal here is expected and NOT a failure of the worker host. It is
  // run anyway because the dispatch asks for the call to be exercised in
  // the worker; the outcome is recorded either way.
  let addMember: string;
  try {
    await e.driver.khAddMember(part, unhex(id), "edit");
    addMember = "kh-add-member(self) accepted";
  } catch (err) {
    addMember = `kh-add-member(self) refused: ${errText(err)}`;
  }
  steps.push(addMember);

  await e.driver.sealPartition(part);
  steps.push("seal-partition");

  const first = await e.tasks.add("buy milk");
  await e.tasks.add("write spike");
  steps.push(`tasks.add ×2 (first id ${first})`);

  const snap = await e.tasks.items();
  steps.push(`tasks.items rev=${snap.revision} n=${snap.items.length}`);

  const ok = snap.items.length === 2 &&
    snap.items.some((i) => i.title === "buy milk") &&
    snap.items.some((i) => i.title === "write spike");

  return {
    ok,
    agentId: id,
    partition: hex(part),
    addMember,
    items: snap.items.map((i) => ({ title: i.title, completed: i.completed })),
    steps,
    stderr: e.stderr().slice(-2000),
  };
}

/** Question 7 (bonus): iroh bind from inside the worker — a WebSocket to
 * a locally spawned relay, opened by the guest through the websocket
 * port. Only run when the driver hands us a relay URL. */
async function relayProbe(relayUrl: string) {
  const e = await engine();
  const endpoint = await e.driver.irohBind(relayUrl);
  return { endpoint: endpoint.slice(0, 16) + "…", relayUrl };
}

function errText(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

// --- the ad-hoc RPC envelope ------------------------------------------------
//
// {id, op, arg} → {id, ok, value} | {id, ok:false, error}. Deliberately
// tiny: this spike is answering platform questions, not designing the
// device-host RPC.

async function dispatch(op: string, arg: unknown): Promise<unknown> {
  switch (op) {
    case "hello":
      return {
        instanceNonce: INSTANCE_NONCE,
        bootSeq: await bootSeq,
        bootedAt: BOOTED_AT,
        uptimeMs: Date.now() - BOOTED_AT,
        // JSPI is what the engine's suspending kernel needs; report what
        // the worker global actually has.
        jspi: typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function",
        hasOpfs: typeof navigator.storage?.getDirectory === "function",
        hasLocks: typeof navigator.locks?.request === "function",
        scope: self.constructor?.name ?? "unknown",
        workerName: WORKER_NAME,
        lockName: LOCK_NAME,
      };
    case "engine":
      return await engineProbe();
    case "opfs":
      return await opfsProbe();
    case "key":
      return await keyProbe();
    case "lock":
      await lockAcquired;
      return { name: LOCK_NAME, held: lockHeld, error: lockError };
    case "relay":
      return await relayProbe(String(arg));
    default:
      throw new Error(`unknown op ${op}`);
  }
}

interface Req {
  id: number;
  op: string;
  arg?: unknown;
}

function serve(port: MessagePort) {
  port.onmessage = (ev: MessageEvent<Req>) => {
    const { id, op, arg } = ev.data;
    dispatch(op, arg).then(
      (value) => port.postMessage({ id, ok: true, value }),
      (e) => port.postMessage({ id, ok: false, error: errText(e), stack: (e as Error)?.stack }),
    );
  };
  port.start();
  port.postMessage({ id: 0, ok: true, value: { connected: INSTANCE_NONCE } });
}

// SET SYNCHRONOUSLY at module evaluation: `connect` events fire as soon
// as the module graph is evaluated, and a handler installed after an
// await would miss the first page's port.
(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (ev) => {
  serve((ev as MessageEvent & { ports: MessagePort[] }).ports[0]);
};
