// THE DEVICE-STORE PROBE PAGE: every question the harness asks, answered
// in a real browser, from a page (`run.ts` drives it with Playwright).
//
// Shape copied from spikes/worker-host/page.ts: the page exposes one
// `globalThis.probe(op, arg)` entry point, the driver calls it and
// records a verdict. Nothing here decides pass/fail — the driver does,
// so that the assertions live beside the reasoning about what they mean.
//
// WHY A PAGE AND NOT A WORKER. This track is the device store, not the
// device HOST: every module under test is callable from either, holds no
// long-lived connection, and the worker is the next track. The one
// question that genuinely needs two contexts (does a second context see
// the lock held?) is answered with a second PAGE, which the lock manager
// treats exactly as it would a worker.
//
// TEST DATA IS OBVIOUSLY SYNTHETIC AND LABELLED. Passphrases here are
// literal strings like "correct-horse-battery-staple-TEST"; no value in
// this file is, or resembles, real key material.

import { filesystemWeb } from "@polyengine/wasi/filesystem-web";
import {
  adoptAnchor,
  anchorIsLive,
  clearAnchor,
  createDevice,
  createSealedDek,
  deviceLockIsHeld,
  type DeviceLock,
  type DeviceNamespace,
  enableUntilReseal,
  ensureDevice,
  getAnchor,
  getDevice,
  holdDeviceLock,
  listDevices,
  loadIdentity,
  loadOrMintIdentity,
  newDeviceId,
  openNamespace,
  persistIdentity,
  promoteDevice,
  rekeyPassphrase,
  removeDevice,
  reseal,
  sealedGet,
  sealedPreopens,
  sealedPut,
  SealError,
  sealState,
  setAnchor,
  startLease,
  sweepT0,
  touchDevice,
  touchLease,
  unsealFromPlatform,
  unsealWithPassphrase,
} from "../../device-store/mod.ts";

// --- obviously-synthetic test values ---------------------------------------

const PASS = "correct-horse-battery-staple-TEST";
const PASS_WRONG = "definitely-not-the-passphrase-TEST";
const PASS_NEW = "the-second-passphrase-TEST";
const IDENTITY_ID = "device-signing";

// --- small helpers ----------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What the driver gets back for a failure that was SUPPOSED to happen:
 * the error's own type and code, never a stringified stack. A refusal
 * that is not typed is a refusal callers have to parse. */
function caught(e: unknown): { name: string; code: string; message: string } {
  const err = e as { name?: string; code?: string; message?: string; fsCode?: string };
  return {
    name: err?.name ?? typeof e,
    code: err?.code ?? err?.fsCode ?? "",
    message: String(err?.message ?? e).slice(0, 200),
  };
}

async function refuses(body: () => Promise<unknown>): Promise<
  { refused: boolean; error: ReturnType<typeof caught> | null }
> {
  try {
    await body();
    return { refused: false, error: null };
  } catch (e) {
    return { refused: true, error: caught(e) };
  }
}

const hexOf = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0"))
    .join("");

// --- the wasi descriptor surface (the spike's Q2 pattern) -------------------

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

/**
 * Mount a device's OPFS directory through the SEALED wrapper and the
 * REAL published `filesystemWeb` fragment, and hand back the preopened
 * root descriptor — i.e. exactly the surface the engine would import.
 *
 * `writable: true` is required and its absence is not a no-op
 * (spikes/worker-host/worker.ts:236-247: the pinned 0.3.1 defaults the
 * whole fragment to read-only). The casts are the spike's, for the
 * spike's reason: the DOM handle types do not structurally satisfy the
 * published interfaces though the runtime shapes match exactly.
 */
async function mountSealed(ns: DeviceNamespace, dek: CryptoKey): Promise<Descriptor03Like> {
  const dir = await ns.directory();
  const preopens = sealedPreopens(dek, {
    "/": dir as unknown as Parameters<typeof sealedPreopens>[1][string],
  });
  const fragment = filesystemWeb(
    { preopens, writable: true } as unknown as Parameters<typeof filesystemWeb>[0],
  );
  const imports = fragment.imports as Record<string, Record<string, unknown>>;
  const preopens03 = imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [Descriptor03Like, string][];
  };
  return preopens03.getDirectories()[0][0];
}

/**
 * A `wasi:filesystem@0.3` result, as an exception.
 *
 * THE 0.3 SURFACE REPORTS ERRORS OUT OF BAND. `readViaStream` returns
 * `[stream, completion]` and delivers a failure by SETTLING THE
 * COMPLETION with an err variant — the stream itself simply ends
 * (fs_provider.ts:872-889). A probe that only drained the stream would
 * read a wrong-key file as the empty string and call it a pass; the
 * first run of this matrix did exactly that. The guest sees the errno,
 * so the harness must look where the guest looks.
 */
class WasiFsError extends Error {
  constructor(readonly code: string, op: string, path: string) {
    super(`${op} ${path}: ${code}`);
    this.name = "WasiFsError";
  }
}

interface FsResult03Like {
  kind: string;
  value?: { kind?: string };
}

function requireOk(result: unknown, op: string, path: string): void {
  const r = result as FsResult03Like | undefined;
  if (r && r.kind === "err") throw new WasiFsError(r.value?.kind ?? "unknown", op, path);
}

async function guestWrite(root: Descriptor03Like, path: string, text: string): Promise<void> {
  const file = await root.openAt({}, path, { create: true, truncate: true }, {
    read: true,
    write: true,
  });
  requireOk(await file.writeViaStream([enc.encode(text)], 0n), "write", path);
}

async function guestRead(root: Descriptor03Like, path: string): Promise<string> {
  const file = await root.openAt({}, path, {}, { read: true });
  const [chunks, completion] = file.readViaStream(0n);
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  requireOk(await completion, "read", path);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return dec.decode(out);
}

/** Read a device's file straight out of OPFS, with no wrapper anywhere
 * near it — the "is it actually ciphertext on disk" question. */
async function rawBytes(id: string, path: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`pm-device-${id}`);
  const fh = await dir.getFileHandle(path);
  return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}

// --- the probes -------------------------------------------------------------

const ops: Record<string, (arg: never) => Promise<unknown>> = {
  /** Index CRUD, plus the create-race two tabs of one restored session
   * actually run. */
  index: async () => {
    const before = (await listDevices()).length;
    const a = await createDevice({ petname: "laptop" });
    const b = await createDevice({ petname: "phone" });
    const fetched = await getDevice(a.id);
    await touchDevice(a.id);
    const touched = await getDevice(a.id);

    // THE RACE: both callers start from the same id (the anchor's), both
    // want it to exist, neither waits for the other.
    const contested = newDeviceId();
    const [r1, r2] = await Promise.all([
      ensureDevice(contested, { petname: "restored" }),
      ensureDevice(contested, { petname: "restored" }),
    ]);
    const rows = await listDevices();
    const raceRows = rows.filter((r) => r.id === contested).length;

    await removeDevice(b.id);
    const afterRemove = await getDevice(b.id);

    return {
      before,
      created: { id: a.id, tier: a.tier, posture: a.posture, unsealPolicy: a.unsealPolicy },
      /** The negative half of the index contract, checked as a FACT
       * about the stored record rather than as a comment. */
      fields: Object.keys(fetched ?? {}).sort(),
      idLooksOpaque: /^[0-9a-f]{32}$/.test(a.id),
      touchedLater: (touched?.lastUsed ?? 0) >= (fetched?.lastUsed ?? 0),
      race: {
        createdCount: [r1.created, r2.created].filter(Boolean).length,
        sameRow: r1.record.createdAt === r2.record.createdAt,
        rows: raceRows,
      },
      removed: afterRemove === undefined,
      cleanup: await cleanup([a.id, contested]),
    };
  },

  /** T0 → T1, and what the browser said about persistence. */
  promote: async () => {
    const d = await createDevice({ petname: "keeper" });
    const before = d.tier;
    const { record, persisted } = await promoteDevice(d.id, {
      posture: "platform",
      unsealPolicy: "until-reseal",
    });
    return {
      before,
      after: record.tier,
      posture: record.posture,
      unsealPolicy: record.unsealPolicy,
      persisted,
      cleanup: await cleanup([d.id]),
    };
  },

  /** The `every-session` rung: seal, unseal, refuse the wrong
   * passphrase, and rotate the salt on re-key. */
  passphrase: async () => {
    const d = await createDevice({ petname: "sealed" });
    const ns = openNamespace(d.id);
    const dek = await createSealedDek(ns, PASS);
    const state = await sealState(ns);

    // The DEK a caller may hold is not a bearer secret.
    const dekExtractable = dek.extractable;

    // Round-trip through the sealed KV to prove the unsealed handle is
    // the SAME key, not merely a key.
    await sealedPut(ns, dek, "probe", enc.encode("sealed-kv-payload-TEST"));
    const reopened = await unsealWithPassphrase(ns, PASS);
    const readBack = dec.decode((await sealedGet(ns, reopened, "probe"))!);

    const wrong = await refuses(() => unsealWithPassphrase(ns, PASS_WRONG));

    const saltBefore = await saltOf(ns);
    await rekeyPassphrase(ns, PASS, PASS_NEW);
    const saltAfter = await saltOf(ns);
    const oldRefused = await refuses(() => unsealWithPassphrase(ns, PASS));
    const withNew = await unsealWithPassphrase(ns, PASS_NEW);
    const stillReadable = dec.decode((await sealedGet(ns, withNew, "probe"))!);

    const secondMint = await refuses(() => createSealedDek(ns, PASS));

    return {
      state,
      dekExtractable,
      readBack,
      wrong,
      saltRotated: saltBefore !== saltAfter && saltBefore.length === 32,
      oldRefused,
      stillReadable,
      secondMint,
      cleanup: await cleanup([d.id]),
    };
  },

  /** Sealed KV round trip and tamper detection. */
  kv: async () => {
    const d = await createDevice({ petname: "kv" });
    const ns = openNamespace(d.id);
    const dek = await createSealedDek(ns, PASS);
    const payload = "the-sealed-value-TEST";
    await sealedPut(ns, dek, "blob", enc.encode(payload));
    const round = dec.decode((await sealedGet(ns, dek, "blob"))!);
    const absent = await sealedGet(ns, dek, "never-written");

    // FLIP ONE CIPHERTEXT BYTE. GCM's tag is what turns this into a
    // refusal instead of plausible garbage.
    const rec = await ns.get<{ v: 1; iv: Uint8Array; ct: Uint8Array }>("sealed", "blob");
    rec!.ct[0] ^= 0x01;
    await ns.put("sealed", "blob", rec);
    const tampered = await refuses(() => sealedGet(ns, dek, "blob"));

    return {
      round,
      absentIsUndefined: absent === undefined,
      tampered,
      cleanup: await cleanup([d.id]),
    };
  },

  /** The identity library: mint, persist, and the two refusals.
   * Returns the device id so the driver can reload and load it back. */
  "identity-mint": async () => {
    const d = await createDevice({ petname: "identity" });
    setAnchor(d.id);
    const ns = openNamespace(d.id);
    const { pair, minted } = await loadOrMintIdentity(ns, IDENTITY_ID);
    const again = await loadOrMintIdentity(ns, IDENTITY_ID);

    // The race, exactly as two restored tabs run it.
    const raceNs = openNamespace(d.id);
    const [x, y] = await Promise.all([
      loadOrMintIdentity(raceNs, "raced"),
      loadOrMintIdentity(raceNs, "raced"),
    ]);
    // ONE key, not two: a signature made under one caller's handle
    // verifies under the other caller's public half. (Comparing handles
    // by identity would not prove it — two loads of one stored entry
    // are two JS objects.)
    const raceSame = await verify(y.pair, await sign(x.pair, "cross-verify-TEST"), "cross-verify-TEST");
    const raceMintedCount = [x.minted, y.minted].filter(Boolean).length;

    // An EXTRACTABLE key is refused at the door.
    const loose = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const extractableRefused = await refuses(() => persistIdentity(ns, "loose", loose));

    return {
      id: d.id,
      minted,
      secondCallMinted: again.minted,
      extractable: pair.privateKey.extractable,
      publicKey: hexOf(await rawPublic(pair)),
      signed: await verify(pair, await sign(pair, "identity-probe-TEST"), "identity-probe-TEST"),
      raceSame,
      raceMintedCount,
      extractableRefused,
    };
  },

  /** After a REAL reload: the handle comes back and still signs, and a
   * planted junk entry is discarded rather than handed out. */
  "identity-after": async (arg: { id: string }) => {
    const ns = openNamespace(arg.id);
    const loaded = await loadIdentity(ns, IDENTITY_ID);
    const signed = loaded
      ? await verify(loaded, await sign(loaded, "identity-probe-TEST"), "identity-probe-TEST")
      : false;

    // PLANTED JUNK: anything on this origin can write to IndexedDB, so
    // the load path treats an entry as untrusted input. Two plants — a
    // value that is not a key pair at all, and an EXTRACTABLE pair,
    // which is the one that would matter.
    await ns.put("identity", "junk", { privateKey: "not a key", publicKey: 42 });
    const junk = await loadIdentity(ns, "junk");
    const junkDiscarded = (await ns.get("identity", "junk")) === undefined;

    const loose = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    await ns.put("identity", "planted", loose);
    const planted = await loadIdentity(ns, "planted");
    const plantedDiscarded = (await ns.get("identity", "planted")) === undefined;

    // And after a discard, load-or-mint gives a REAL key rather than
    // looping against the plant.
    const after = await loadOrMintIdentity(ns, "planted");

    return {
      loadedAfterReload: loaded !== null,
      publicKey: loaded ? hexOf(await rawPublic(loaded)) : "",
      signed,
      junkRejected: junk === null,
      junkDiscarded,
      plantedRejected: planted === null,
      plantedDiscarded,
      remintedNonExtractable: after.minted && after.pair.privateKey.extractable === false,
      cleanup: await cleanup([arg.id]),
    };
  },

  /** Arm the `until-reseal` rung. The driver reloads after this. */
  "platform-arm": async () => {
    const d = await createDevice({ petname: "convenient" });
    const ns = openNamespace(d.id);
    const dek = await createSealedDek(ns, PASS);
    await sealedPut(ns, dek, "note", enc.encode("survives-the-reload-TEST"));
    await enableUntilReseal(ns, PASS);
    return { id: d.id, state: await sealState(ns) };
  },

  /** After a REAL reload: auto-unseal with NO passphrase. Then reseal,
   * and prove the passphrase is required again. */
  "platform-after": async (arg: { id: string }) => {
    const ns = openNamespace(arg.id);
    const auto = await unsealFromPlatform(ns);
    const read = auto ? dec.decode((await sealedGet(ns, auto, "note"))!) : "";
    const autoExtractable = auto?.extractable ?? null;

    await reseal(ns);
    const afterReseal = await unsealFromPlatform(ns);
    const state = await sealState(ns);
    // The handle went too, not just the wrap.
    const handleGone = (await ns.get("seal", "kek:platform")) === undefined;
    // The passphrase rung is untouched — it is the only thing that can
    // open the device after a reseal.
    const stillOpens = dec.decode(
      (await sealedGet(ns, await unsealWithPassphrase(ns, PASS), "note"))!,
    );

    return {
      autoUnsealed: auto !== null,
      autoExtractable,
      read,
      afterResealIsNull: afterReseal === null,
      state,
      handleGone,
      stillOpens,
      cleanup: await cleanup([arg.id]),
    };
  },

  /** Write through the sealed mount. The driver reloads after this. */
  "fs-write": async (arg: { marker: string }) => {
    const d = await createDevice({ petname: "filesystem" });
    const ns = openNamespace(d.id);
    const dek = await createSealedDek(ns, PASS);
    const root = await mountSealed(ns, dek);
    const text = `checkpoint plaintext ${arg.marker} end`;
    await guestWrite(root, "checkpoint.bin", text);
    // Read it back through a FRESH descriptor before the reload, so a
    // failure after the reload is unambiguously about persistence.
    const immediate = await guestRead(root, "checkpoint.bin");
    return { id: d.id, wrote: text, immediate, ok: immediate === text };
  },

  /** After a REAL reload: re-mount with the DEK recovered from the
   * passphrase and read the guest's plaintext back; refuse a wrong DEK;
   * and look at what actually rests on disk. */
  "fs-after": async (arg: { id: string; marker: string; wrote: string }) => {
    const ns = openNamespace(arg.id);
    const dek = await unsealWithPassphrase(ns, PASS);
    const root = await mountSealed(ns, dek);
    const readBack = await guestRead(root, "checkpoint.bin");

    // A DIFFERENT DEK is the "someone else's device key" case, and it
    // must fail the way a filesystem fails, not by trapping.
    const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]) as CryptoKey;
    const otherRoot = await mountSealed(ns, other);
    const wrongKey = await refuses(() => guestRead(otherRoot, "checkpoint.bin"));

    // THE BYTES ON DISK. The marker is a string the guest wrote; if it
    // appears in the raw OPFS file, the sealing did nothing.
    const raw = await rawBytes(arg.id, "checkpoint.bin");
    const rawText = Array.from(raw, (b) => String.fromCharCode(b)).join("");
    const magic = rawText.slice(0, 8);

    // Append-and-reread, because whole-file sealing has to survive a
    // partial write (the provider does one open-write-close per write).
    await guestWrite(root, "second.bin", "another checkpoint TEST");
    const second = await guestRead(root, "second.bin");

    return {
      readBack,
      ok: readBack === arg.wrote,
      wrongKey,
      rawLength: raw.length,
      markerOnDisk: rawText.includes(arg.marker),
      plaintextOnDisk: rawText.includes("checkpoint plaintext"),
      magic,
      second,
      cleanup: await cleanup([arg.id]),
    };
  },

  /** Take and hold the device lock; the driver asks a SECOND page. */
  "lock-hold": async (arg: { id?: string }) => {
    const id = arg?.id ?? newDeviceId();
    const lock = await holdDeviceLock(id);
    held.set(id, lock);
    return { id, name: lock.name, heldHere: await deviceLockIsHeld(id) };
  },

  /** Asked from the second page: is it held from over here too? */
  "lock-probe": async (arg: { id: string }) => ({
    held: await deviceLockIsHeld(arg.id),
  }),

  /** A second holder must not get in while the first holds it. */
  "lock-contend": async (arg: { id: string }) =>
    await refuses(() => holdDeviceLock(arg.id, { ifAvailable: true })),

  "lock-release": async (arg: { id: string }) => {
    held.get(arg.id)?.release();
    held.delete(arg.id);
    await new Promise((r) => setTimeout(r, 100));
    return { held: await deviceLockIsHeld(arg.id) };
  },

  /**
   * The sweep. Two T0 devices: one with a live host (lock held, lease
   * renewed), one dead (no lock, lease written far enough in the past
   * to be stale), plus a T1 device that must survive whatever its lease
   * says.
   */
  sweep: async () => {
    const live = await createDevice({ petname: "live" });
    const dead = await createDevice({ petname: "dead" });
    const durable = await createDevice({ petname: "durable" });
    await promoteDevice(durable.id, {});

    const liveNs = openNamespace(live.id);
    const liveLock = await holdDeviceLock(live.id);
    const beat = startLease(liveNs);
    await touchLease(liveNs);

    // The dead one: a lease from long ago and no lock at all. Written
    // directly, because waiting out LEASE_STALE_MS in a test would be
    // thirty seconds of nothing.
    const deadNs = openNamespace(dead.id);
    await deadNs.put("meta", "lease", { at: Date.now() - 10 * 60_000 });

    // A T1 device with a stale lease, to prove the tier check comes
    // first.
    await openNamespace(durable.id).put("meta", "lease", { at: Date.now() - 10 * 60_000 });

    const result = await sweepT0();
    beat.stop();

    const after = await listDevices();
    const stillThere = (id: string) => after.some((r) => r.id === id);
    const out = {
      swept: result.swept.includes(dead.id),
      keptLive: stillThere(live.id) &&
        result.kept.some((k) => k.id === live.id && k.because === "lock-held"),
      keptDurable: stillThere(durable.id) &&
        result.kept.some((k) => k.id === durable.id && k.because === "not-t0"),
      deadGone: !stillThere(dead.id),
      detail: result,
    };
    liveLock.release();
    return { ...out, cleanup: await cleanup([live.id, durable.id, dead.id]) };
  },

  /** The anchor, and the stale-pointer case the degrade rule is for. */
  anchor: async () => {
    const d = await createDevice({ petname: "anchored" });
    setAnchor(d.id);
    const pointer = getAnchor();
    const live = await anchorIsLive(d.id);
    const adopted = await adoptAnchor();

    // Sweep it out from under the pointer — a restored tab presenting a
    // pointer to a collected namespace is a FRESH DEVICE, silently.
    await removeDevice(d.id);
    const liveAfter = await anchorIsLive(d.id);
    const adoptedAfter = await adoptAnchor();
    const pointerCleared = getAnchor();

    const unknown = await anchorIsLive(newDeviceId());
    clearAnchor();
    return {
      pointer,
      matchedDevice: pointer === d.id,
      live,
      adopted: adopted === d.id,
      liveAfter,
      adoptedAfterIsNull: adoptedAfter === null,
      pointerCleared: pointerCleared === null,
      unknownIsNotLive: unknown === false,
    };
  },
};

const held = new Map<string, DeviceLock>();

/** Best-effort teardown so cases cannot contaminate each other through
 * a shared index. */
async function cleanup(ids: string[]): Promise<string> {
  for (const id of ids) {
    try {
      await removeDevice(id);
    } catch (e) {
      return `cleanup ${id}: ${caught(e).message}`;
    }
  }
  return "ok";
}

async function saltOf(ns: DeviceNamespace): Promise<string> {
  const rec = await ns.get<{ salt: Uint8Array }>("seal", "wrap:passphrase");
  return hexOf(rec!.salt);
}

const sign = async (pair: CryptoKeyPair, msg: string) =>
  new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, enc.encode(msg) as BufferSource));

const verify = (pair: CryptoKeyPair, sig: Uint8Array, msg: string) =>
  crypto.subtle.verify(
    "Ed25519",
    pair.publicKey,
    sig as BufferSource,
    enc.encode(msg) as BufferSource,
  );

/** The PUBLIC half only. (`exportKey` on a public key is not the banned
 * verb's danger — but this repo bans the verb outright in host and
 * runtime code, so it stays in the harness, where it exists to prove
 * two loads yield the SAME identity.) */
const rawPublic = (pair: CryptoKeyPair) => crypto.subtle.exportKey("raw", pair.publicKey);

// deno-lint-ignore no-explicit-any
(globalThis as any).probe = async (op: string, arg: unknown) => {
  const fn = ops[op];
  if (!fn) throw new Error(`no probe ${op}`);
  return await (fn as (a: unknown) => Promise<unknown>)(arg);
};
// deno-lint-ignore no-explicit-any
(globalThis as any).ready = true;
