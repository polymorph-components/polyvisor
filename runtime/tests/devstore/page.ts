// THE DEVICE-STORE PROBE PAGE: every question the harness asks, answered
// in a real browser, from a page (`run.ts` drives it with Playwright).
//
// Shape copied from spikes/worker-host/page.ts: the page exposes one
// `globalThis.probe(op, arg)` entry point, the driver calls it and
// records a verdict. Nothing here decides pass/fail — the driver does,
// so that the assertions live beside the reasoning about what they mean.
//
// WHY A PAGE AND NOT A WORKER, for rows 1-10. Those rows are the device
// STORE, not the device HOST: every module under test is callable from
// either, holds no long-lived connection, and the worker was the next
// track. The one question that genuinely needs two contexts (does a
// second context see the lock held?) is answered with a second PAGE,
// which the lock manager treats exactly as it would a worker.
//
// ROWS 11+ ARE THE HOST, and there the page is only a client: every
// engine call, every DEK and every checkpoint happens inside
// device-store/worker.ts, reached through `connectDevice`. So a PASS
// there is a claim about the worker, not about the page's ambient
// capabilities — the spike's discipline, kept.
//
// TEST DATA IS OBVIOUSLY SYNTHETIC AND LABELLED. Passphrases here are
// literal strings like "correct-horse-battery-staple-TEST"; no value in
// this file is, or resembles, real key material.

import { filesystemWeb } from "@polyengine/wasi/filesystem-web";
// The one import here that is NOT the device store: the visor's
// PairingDriver adapter, pulled in so row 18 can prove it is
// constructible over the REMOTE driver without a line changed.
import { createEnginePairingDriver } from "../../pairing-engine.ts";
import { unhex } from "../../engine.ts";
// The storage-egress rows (24+): the page-side half of the credential
// ceremony (`putSigningKey`, exactly as the visor's real sheet would
// call it) and the moved factories under direct unit test (row 29,
// no worker involved at all — STORAGE-EGRESS.md §7, "verbatim in
// semantics").
import { putSigningKey } from "../../keystore.ts";
import {
  emptyGrant,
  makeOwnerFetch,
  makePublicFetch,
  makeSharedFetch,
} from "../../store-egress.ts";
import type { StoreBinding } from "../../device-store/rpc.ts";
// The brand predicate, IN THE PAGE'S REALM. Row 18's central claim since
// the 0.4.0 bump is that `fromCloneable` mints a value this copy
// recognizes — so the predicate has to be the page's own, not the
// worker's, and not a field the worker asserted about itself.
import { isComponentException, isTrap } from "@polyengine/runtime/embedder";
import {
  adoptAnchor,
  anchorIsLive,
  clearAnchor,
  connectDevice,
  createDevice,
  createSealedDek,
  type DeviceConnection,
  DEVICE_IDENTITY_KEY,
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
  namespaceExists,
  newDeviceId,
  type Posture,
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
  type UnsealPolicy,
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
function caught(
  e: unknown,
): { name: string; code: string; message: string; isWit: boolean; witPayload: unknown } {
  const err = e as {
    name?: string;
    code?: string;
    message?: string;
    fsCode?: string;
    payload?: unknown;
  };
  // THE TWO PATHS, REPORTED SEPARATELY (device-store/rpc.ts, "how a
  // rejection crosses"). `code` is the host arm's contract; `isWit` and
  // `witPayload` are the engine arm's, asked with the PAGE's own brand
  // predicate so a row can tell a device-store refusal from something
  // the guest actually said. A row that only looked at `message` would
  // pass for either.
  const isWit = isComponentException(e);
  return {
    name: err?.name ?? typeof e,
    code: err?.code ?? err?.fsCode ?? "",
    message: String(err?.message ?? e).slice(0, 200),
    isWit,
    witPayload: isWit && typeof err?.payload === "string"
      ? err.payload.slice(0, 200)
      : isWit
      ? err?.payload
      : undefined,
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

  // --- the worker host (rows 11+) -------------------------------------------
  //
  // From here down the page owns nothing but a MessagePort. The device
  // id, the anchor and the index are resolved on this side (the index is
  // unsealed and sessionStorage does not exist in a worker); the DEK,
  // the engine, the lock, the lease and the checkpoints all live in
  // device-store/worker.ts and are only ever observed through
  // `connectDevice`'s surface.

  /** Make a T1 device the way the promotion moment does: create, then
   * promote WITH the seal choices. Returns the id for the driver to
   * carry across a reload. */
  "hc-make": async (
    arg: { petname: string; policy: UnsealPolicy; promote: boolean; posture?: Posture },
  ) => {
    const d = await createDevice({
      petname: arg.petname,
      unsealPolicy: arg.policy,
      // The index row states how the identity RESTS. Every device the
      // worker inits is platform posture now; the seed-back-compat row
      // asks for `seed` so its row is not a lie either.
      posture: arg.posture ?? "platform",
    });
    if (arg.promote) await promoteDevice(d.id, { unsealPolicy: arg.policy });
    const row = await getDevice(d.id);
    return { id: d.id, tier: row?.tier, policy: row?.unsealPolicy, posture: row?.posture };
  },

  /**
   * Attach to a device's host. `unseal` present ⇒ also run the ceremony
   * and report what it did; absent ⇒ report the SEALED status, which is
   * how the every-session row proves no auto-unseal happened.
   */
  "hc-open": async (arg: {
    id?: string;
    anchorPetname?: string;
    seedPosture?: boolean;
    unseal?: { passphrase?: string; untilReseal?: boolean };
  }) => {
    const conn = await connect(arg);
    const opened = arg.unseal ? await refuses(() => conn.unseal(arg.unseal)) : null;
    return {
      deviceId: conn.deviceId,
      hello: conn.hello,
      // `refuses` swallows the value, so status is asked for separately —
      // which also proves the two agree.
      unseal: opened,
      status: await conn.status(),
    };
  },

  /** The ceremony on its own, so a row can attempt it more than once
   * (wrong passphrase, then right). */
  "hc-unseal": async (arg: { id: string; opts: { passphrase?: string } }) => {
    const conn = conns.get(arg.id)!;
    const attempt = await refuses(() => conn.unseal(arg.opts));
    return { attempt, status: await conn.status() };
  },

  /**
   * "KEEP THIS DEVICE", both halves, in the order an embedder must run
   * them (device-store/client.ts's `promote`): the WORKER re-wraps the
   * DEK, and only then does the INDEX row start claiming the new tier
   * and rung. A failed re-wrap must never leave a row promising a rung
   * the device does not have.
   */
  "hc-promote": async (arg: {
    id: string;
    petname: string;
    policy: UnsealPolicy;
    passphrase?: string;
  }) => {
    const conn = conns.get(arg.id)!;
    const attempt = await refuses(() =>
      conn.promote({ policy: arg.policy, passphrase: arg.passphrase })
    );
    const { record, persisted } = await promoteDevice(arg.id, {
      petname: arg.petname,
      unsealPolicy: arg.policy,
    });
    return {
      attempt,
      persisted,
      row: { petname: record.petname, tier: record.tier, policy: record.unsealPolicy },
      status: await conn.status(),
    };
  },

  /**
   * RESEAL, both halves. On a device whose only usable rung is the
   * platform wrap this is an UPGRADE ceremony (worker.ts's `reseal`):
   * the passphrase becomes the device's new `every-session` rung, and
   * the INDEX's policy tag has to follow or the picker would keep
   * trying to open silently something that now needs asking. The index
   * write lands LAST, so a refused ceremony leaves the row honest.
   */
  "hc-reseal": async (arg: { id: string; passphrase?: string; upgrade?: boolean }) => {
    const conn = conns.get(arg.id)!;
    const attempt = await refuses(() =>
      conn.reseal(arg.passphrase === undefined ? {} : { passphrase: arg.passphrase })
    );
    if (!attempt.refused && arg.upgrade) {
      await promoteDevice(arg.id, { unsealPolicy: "every-session" });
    }
    return { attempt, status: await conn.status(), row: await getDevice(arg.id) };
  },

  /** Drive the remote `tasks` surface: this is the structured-clone
   * claim, made by moving real strings and real bigint revisions. */
  "hc-add": async (arg: { id: string; titles: string[] }) => {
    const conn = conns.get(arg.id)!;
    const ids: string[] = [];
    for (const t of arg.titles) ids.push(await conn.tasks.add(t));
    return { ids };
  },

  "hc-items": async (arg: { id: string }) => {
    const snap = await conns.get(arg.id)!.tasks.items();
    return {
      // `revision` is a WIT u64 and therefore a bigint over the port —
      // structured clone carries it, JSON does not, so it is stringified
      // HERE (at the Playwright boundary) and not before.
      revision: String(snap.revision),
      titles: snap.items.map((i) => i.title).sort(),
      n: snap.items.length,
    };
  },

  "hc-checkpoint": async (arg: { id: string }) => ({
    at: await conns.get(arg.id)!.checkpoint(),
  }),

  "hc-status": async (arg: { id: string }) => await conns.get(arg.id)!.status(),

  /** A refusal that must be a WIT error rather than a host bug: calling
   * the engine through a SEALED host. Proves the envelope's `code` and
   * `isWitError` bits are populated and distinguishable. */
  "hc-call-sealed": async (arg: { id: string }) =>
    await refuses(() => conns.get(arg.id)!.tasks.items()),

  /**
   * The kill. `__die` makes the worker `close()` its own global, which
   * is a crash on demand: the lock and the lease go with it exactly as
   * they would if the process had died. Closing every tab would also
   * work and would take the observers with it.
   */
  "hc-die": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    await conn.__die();
    conns.delete(arg.id);
    // Locks are released asynchronously by the platform; give it a beat
    // before anyone asks.
    await new Promise((r) => setTimeout(r, 300));
    return { lockHeld: await deviceLockIsHeld(arg.id) };
  },

  "hc-close": async (arg: { id: string }) => {
    await conns.get(arg.id)?.close();
    conns.delete(arg.id);
    await new Promise((r) => setTimeout(r, 200));
    return { lockHeld: await deviceLockIsHeld(arg.id) };
  },

  /** The C1 sweep rule, re-asked with a LIVE WORKER holding the lock:
   * a T0 device whose host is alive is never garbage, whatever its lease
   * says. The lease is backdated deliberately so the ONLY thing keeping
   * the device is the worker's lock. */
  "hc-sweep-live": async (arg: { id: string }) => {
    await openNamespace(arg.id).put("meta", "lease", { at: Date.now() - 10 * 60_000 });
    const result = await sweepT0();
    return {
      lockHeld: await deviceLockIsHeld(arg.id),
      kept: result.kept.some((k) => k.id === arg.id && k.because === "lock-held"),
      swept: result.swept.includes(arg.id),
      stillIndexed: (await getDevice(arg.id)) !== undefined,
    };
  },

  /** …and the other half: with the worker dead the same device IS
   * collected, storage and all. */
  "hc-sweep-dead": async (arg: { id: string }) => {
    await openNamespace(arg.id).put("meta", "lease", { at: Date.now() - 10 * 60_000 });
    const lockBefore = await deviceLockIsHeld(arg.id);
    const result = await sweepT0();
    return {
      lockBefore,
      swept: result.swept.includes(arg.id),
      indexRowGone: (await getDevice(arg.id)) === undefined,
      namespaceGone: !(await namespaceExists(arg.id)),
      anchorNotLive: !(await anchorIsLive(arg.id)),
    };
  },

  /**
   * THE AGENT ID, ASKED FROM BOTH SIDES.
   *
   * `status().agentId` is the worker's note of what the engine reported
   * at this device's fresh init. On its own that is only our own memo,
   * so the resumed ENGINE is asked the same question directly:
   * `khKnowsAgent(unhex(id))` goes into the restored keyhive archive. A
   * resume that had quietly minted a new identity would not know the old
   * agent, and a resume that refused would not be answering at all.
   *
   * (The engine's own enforcement is stronger than either and is what
   * row 22 pins: the manifest records the agent id, and a handed key
   * that does not match it is refused by name.)
   */
  "hc-agent": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    const status = await conn.status();
    const agentId = status.agentId;
    const knows = agentId === null
      ? null
      : await conn.driver.khKnowsAgent(unhex(agentId));
    return {
      agentId,
      knows,
      posture: status.posture,
      resumed: status.resumed,
      sealed: status.sealed,
    };
  },

  /**
   * PLANT A RIVAL IDENTITY in the device's namespace — a DIFFERENT but
   * perfectly valid non-extractable Ed25519 pair, exactly the shape
   * `loadOrMintIdentity` would hand back.
   *
   * This is the wrong-device / corrupt-namespace case made reproducible.
   * The engine records the agent id in the checkpoint manifest, so the
   * resume must notice that the key it was handed is not the key the
   * state belongs to. The interesting failure it guards against is not a
   * crash but a SILENT one: an embedder that treated the refusal as
   * "nothing to resume" would call `init` and mint a third identity,
   * losing every membership the device held.
   */
  "hc-plant-identity": async (arg: { id: string }) => {
    const ns = openNamespace(arg.id);
    const before = await loadIdentity(ns, DEVICE_IDENTITY_KEY);
    const rival = await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    await persistIdentity(ns, DEVICE_IDENTITY_KEY, rival);
    const after = await loadIdentity(ns, DEVICE_IDENTITY_KEY);
    return {
      hadOne: before !== null,
      planted: after !== null,
      // The rival is a real one: non-extractable, like every key this
      // store will accept.
      rivalExtractable: rival.privateKey.extractable,
      different: before !== null && after !== null &&
        (await rawPublic(before)).byteLength > 0 &&
        hexOf(await rawPublic(before)) !== hexOf(await rawPublic(after)),
    };
  },

  /**
   * What the identity store actually holds, read back raw — the
   * non-extractability claim at the storage layer rather than at the
   * mint. Row 5 already pins this for a device the harness drives
   * directly; this asks it of a namespace THE WORKER populated, which is
   * the one the engine is now trusting.
   */
  "hc-identity-at-rest": async (arg: { id: string }) => {
    const ns = openNamespace(arg.id);
    const stored = await ns.get<CryptoKeyPair>("identity", DEVICE_IDENTITY_KEY);
    if (!stored) return { present: false };
    let exportRefused = false;
    try {
      await crypto.subtle.exportKey("pkcs8", stored.privateKey);
    } catch {
      exportRefused = true;
    }
    return {
      present: true,
      privateExtractable: stored.privateKey.extractable,
      algorithm: stored.privateKey.algorithm.name,
      usages: stored.privateKey.usages.join(","),
      exportRefused,
      publicHex: hexOf(await rawPublic(stored)).slice(0, 16),
    };
  },

  "hc-forget": async (arg: { ids: string[] }) => ({ cleanup: await cleanup(arg.ids) }),

  /**
   * THE DEBOUNCE, with no explicit checkpoint anywhere: write, wait out
   * the 500 ms trailing window, and report what `status()` says about
   * `lastCheckpoint`. The driver then kills the worker and reads the
   * state back — which is the only assertion that actually matters, and
   * the reason this op returns the two timestamps rather than judging.
   */
  "hc-debounce": async (arg: { id: string; title: string }) => {
    const conn = conns.get(arg.id)!;
    const before = (await conn.status()).lastCheckpoint;
    await conn.tasks.add(arg.title);
    const immediately = (await conn.status()).lastCheckpoint;
    // Comfortably past the 500 ms trailing edge, and long enough that a
    // slow IndexedDB commit does not make this flaky.
    await new Promise((r) => setTimeout(r, 1_500));
    const settled = (await conn.status()).lastCheckpoint;
    return { before, immediately, settled };
  },

  /**
   * THE PAIRING ADAPTER, CONSTRUCTED OVER THE REMOTE DRIVER — the
   * serialization-discipline claim, made by the one consumer that would
   * notice if it were false.
   *
   * `createEnginePairingDriver` (runtime/pairing-engine.ts) is written
   * against the IN-PROCESS `Driver` and reads a WIT err payload out of
   * every rejection via `isComponentException(e)` then `e.payload`. If
   * the port dropped either the branding or the payload, this adapter
   * would silently degrade every engine refusal to a stringified stack
   * — a change nothing else here would catch, because it still "works".
   *
   * `usProfileGet()` on a device with no user-system is the cheapest
   * genuine err arm the engine offers: no network, no pairing, no
   * ceremony.
   */
  "hc-pairing": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    const pairing = createEnginePairingDriver(conn.driver);
    const profile = await pairing.usProfileGet();

    // THE RAW ENGINE REJECTION, inspected with the PAGE's own brand
    // predicate. Since 0.4.0 the worker sends `toCloneable(error)` and
    // client.ts rehydrates with `fromCloneable`, so what should arrive
    // here is a genuine `ComponentException` minted by this copy — not a
    // facsimile carrying a hand-rolled symbol, and not a bare Error.
    let engine: {
      isWit: boolean;
      isTrapped: boolean;
      name: string;
      message: string;
      payload: unknown;
      hasStack: boolean;
      /** A `DeviceHostError` would have one; a ComponentException must not. */
      code: unknown;
    } | null = null;
    try {
      await conn.driver.usProfileGet();
    } catch (e) {
      const d = e as {
        name: string;
        message: string;
        payload?: unknown;
        stack?: string;
        code?: unknown;
      };
      engine = {
        isWit: isComponentException(e),
        isTrapped: isTrap(e),
        name: d.name,
        message: String(d.message).slice(0, 120),
        payload: typeof d.payload === "string" ? d.payload.slice(0, 120) : d.payload,
        hasStack: typeof d.stack === "string" && d.stack.length > 0,
        code: d.code,
      };
    }

    // The contrasting arm — a HOST refusal, which must NOT come back
    // branded — is its own op (`hc-host-refusal`), because it needs the
    // device SEALED and this one needs it open.
    return {
      constructed: typeof pairing.pairJoinStart === "function" &&
        typeof pairing.usEvents === "function",
      adapterOk: profile.ok,
      adapterError: profile.ok ? "" : String(profile.error).slice(0, 120),
      /** The adapter's error string IS the WIT payload, not a message —
       * only true if the brand AND the payload both survived the port. */
      adapterUsedPayload: !profile.ok && engine !== null && profile.error === engine.payload,
      engine,
    };
  },

  /**
   * A HOST refusal, inspected with the same predicate — the contrast
   * that makes row 18's claim mean something. Calling the engine through
   * a SEALED host is a `SealError` in the worker: not a WIT error, and
   * it must arrive with its `code` intact and its brand absent.
   */
  "hc-host-refusal": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    try {
      await conn.tasks.items();
      return { refused: false };
    } catch (e) {
      const d = e as { name: string; message: string; code?: unknown; hostName?: unknown };
      return {
        refused: true,
        isWit: isComponentException(e),
        name: d.name,
        hostName: d.hostName,
        code: d.code,
        message: String(d.message).slice(0, 120),
      };
    }
  },

  // --- storage egress (rows 24+) ---------------------------------------

  /**
   * ROW 24. A client that reaches for `conn.driver.initStore(...)`
   * DIRECTLY — sneaking addressing past the `bindStore` ceremony,
   * since `initStore` is a plain `Driver` method and every `Driver`
   * method is on the remote proxy — must still find every seam
   * refusing. `initStore` only arms the GUEST's own notion of where to
   * write; the worker's module-scoped `storeGrant`/`storeSigner` (what
   * the factories actually close over) are untouched by it, so
   * `ensureBucket()` reaches `store-owner-fetch` with `grant.provider
   * === null` and refuses by name before a single byte leaves the
   * worker.
   */
  "sx-sneak": async (arg: { id: string; recorderOrigin: string }) => {
    const conn = conns.get(arg.id)!;
    const initAttempt = await refuses(() =>
      conn.driver.initStore({
        kind: "s3",
        value: {
          endpoint: arg.recorderOrigin,
          bucket: "pm-devstore",
          accessKey: "SYNTHETIC-TEST-KEY",
        },
      })
    );
    const ensureAttempt = await refuses(() => conn.driver.ensureBucket());
    return { initAttempt, ensureAttempt };
  },

  /** ROW 25. `bindStore`'s own refusals, asked by CODE. */
  "hc-bind": async (arg: { id: string; binding: StoreBinding }) => {
    const conn = conns.get(arg.id)!;
    const attempt = await refuses(() => conn.bindStore(arg.binding));
    return { attempt, status: await conn.status() };
  },

  /**
   * ROW 26+. The page half of the ceremony: escrow a SYNTHETIC LABELED
   * credential exactly as the credential sheet would
   * (`putSigningKey(origin, accessKey, secret)`), non-extractable, and
   * out of scope the instant this call returns.
   */
  "sx-escrow": async (arg: { origin: string; accessKey: string; secret: string }) => {
    await putSigningKey(arg.origin, arg.accessKey, arg.secret);
    return { ok: true };
  },

  /** `ensureBucket()` on its own, so a row can call it more than once
   * (bound, then after a die+reunseal, then after unbind). */
  "hc-ensure-bucket": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    return { attempt: await refuses(() => conn.driver.ensureBucket()) };
  },

  /** ROW 28's other half: `unbindStore` refuses at the seam, never
   * silently. */
  "hc-unbind": async (arg: { id: string }) => {
    const conn = conns.get(arg.id)!;
    const attempt = await refuses(() => conn.unbindStore());
    return { attempt, status: await conn.status() };
  },

  /**
   * ROW 29. The moved factories, gated DIRECTLY — no worker, no wire,
   * one `EgressGrant` built by hand exactly as `applyBinding` would
   * build it for an s3 destination (STORAGE-EGRESS.md §4: owner and
   * public both the one origin, shared empty because S3 has no app
   * tier).
   */
  "sx-unit": async (arg: { recorderOrigin: string }) => {
    const grant = emptyGrant();
    grant.provider = "s3";
    grant.origins = new Set([arg.recorderOrigin]);
    grant.publicOrigins = new Set([arg.recorderOrigin]);
    grant.sharedOrigins = new Set();

    // (1) CONFINEMENT: a destination outside the grant is refused
    // structurally, by the platform URL parser, never a prefix test.
    const owner = makeOwnerFetch(grant);
    const notGranted = await refuses(() =>
      owner("GET", "https://synthetic-other.invalid/x", [], new Uint8Array())
    );

    // (2) STRIPPING: the public tier holds no identity, so it ACTIVELY
    // strips whatever the guest set. The recorder's log entry (read by
    // the driver right after this call) is the actual assertion; this
    // call just has to reach the recorder with a header attached so
    // there is something to strip.
    const pub = makePublicFetch(grant);
    await pub(
      "PUT",
      `${arg.recorderOrigin}/pm-devstore/unit-test-key`,
      [["authorization", "Bearer synthetic-not-a-real-token"]],
      new Uint8Array(),
    );

    // (3) NO APP TIER ON S3: the shared seam is a Dropbox-only import;
    // asking for it on an s3 grant is a call site wanting an identity
    // this provider cannot mint.
    const shared = makeSharedFetch(grant);
    const sharedRefused = await refuses(() =>
      shared("GET", `${arg.recorderOrigin}/x`, [], new Uint8Array())
    );

    return { notGranted, sharedRefused };
  },
};

// --- the host client, per page ----------------------------------------------

/** Where the harness's build put the engine. Resolved against the
 * WORKER's URL inside the worker, which is why they are bare relative
 * names rather than page-relative ones. */
const ARTIFACTS = {
  envelopeUrl: "./engine.plan.json",
  wasmUrl: "./engine.component.wasm",
} as const;

/** One connection per device per page — the shape a real embedder has.
 * Keyed by device id so a reload starts empty and every row has to
 * re-attach, which is the point of the reload rows. */
const conns = new Map<string, DeviceConnection>();

function connect(
  arg: { id?: string; anchorPetname?: string; seedPosture?: boolean },
): Promise<DeviceConnection> {
  const existing = arg.id ? conns.get(arg.id) : undefined;
  if (existing) return Promise.resolve(existing);
  return connectDevice({
    device: arg.id
      ? { kind: "id", id: arg.id }
      // The T0 boot: whatever this TAB was looking at, or a fresh
      // device. sessionStorage survives the reload; the worker does not.
      : { kind: "anchor", petname: arg.anchorPetname ?? "ephemeral" },
    workerUrl: "./worker.js",
    artifacts: ARTIFACTS,
    label: "probe",
    // PROBE ONLY, and only the seed-back-compat row passes it: the
    // worker inits in platform posture otherwise.
    __seedPosture: arg.seedPosture === true,
  }).then((c) => {
    conns.set(c.deviceId, c);
    return c;
  });
}

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
