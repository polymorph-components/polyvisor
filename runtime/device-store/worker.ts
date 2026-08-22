// THE DEVICE HOST — one SharedWorker per device (PERSISTENCE.md, "The
// worker host"; the platform facts it stands on are
// spikes/worker-host/README.md's executed matrix).
//
// This is an ENTRY POINT, not a library module: the embedder bundles it
// as its own module graph and constructs it with
// `new SharedWorker(url, {type:"module", name:"pm-device-<id>"})` — the
// visor/frame `frame.js` pattern. It is deliberately NOT re-exported
// from mod.ts: it imports ../engine.ts, which imports @polyengine and
// @polymorph packages by bare specifier, and dragging those pins into
// every consumer of the device store would undo runtime/README.md's
// resolution model (device-store/ imports no package at all).
//
// WHAT THIS GLOBAL OWNS, for as long as it lives:
//
//   * the device Web Lock `pm-device-<id>` — taken once, released only
//     by death. Locks are the one liveness signal a crashed host cannot
//     fake (spike Q5/Q5b), and the T0 sweep is built on exactly that.
//   * the lease heartbeat beside it (locks.ts): the OTHER half of the
//     sweep rule, and the grace period that keeps a mid-reload device
//     from being collected in the zero-client window.
//   * the namespace — one IndexedDB database and one OPFS directory.
//   * THE UNSEALED DEK. "Unsealed while the app is open anywhere" is
//     exactly this global's lifetime; there is no extra machinery and
//     there is deliberately no way to read the key back out (every
//     handle seal.ts hands over is non-extractable).
//   * one engine instance, mounted on the sealed state root, and the
//     checkpoint cadence over it.
//
// WHY THE WORKER AND NOT THE TAB. Two tabs of one device become two
// clients of ONE engine rather than two engines racing over one
// namespace — the dangerous case made structural rather than policed.
// Same-browser multi-device is then just two workers, because a
// SharedWorker is keyed by (origin, script URL, NAME) and the name
// carries the device id.
//
// THE RELOAD IS NOT SURVIVED, AND THAT IS DESIGNED FOR. The spike
// measured this Chromium respawning the worker on EVERY single-tab
// reload (Q4: boot counter 1→6, a new nonce each load, ~1 ms uptime at
// every hello) — the zero-client window at navigation. So nothing here
// treats worker memory as durable: reload survival is checkpoint +
// re-unseal + `stateResume()`, and the boot counter below exists to
// make the respawn visible rather than to hope against it.

import {
  ComponentException,
  isComponentException,
} from "@polyengine/runtime/embedder";
import { type Engine, newEngine, type PersistDir } from "../engine.ts";
import { getDevice } from "./index.ts";
import { type DeviceNamespace, openNamespace } from "./namespace.ts";
import {
  createSealedDek,
  enableUntilReseal,
  rekeyFromPlatform,
  reseal as resealNamespace,
  SealError,
  sealState,
  unsealFromPlatform,
  unsealWithPassphrase,
} from "./seal.ts";
import { sealedDirectory } from "./sealed-fs.ts";
import { type DeviceLock, deviceLockIsHeld, holdDeviceLock, startLease } from "./locks.ts";
import {
  type AttachSpec,
  type DeviceStatus,
  DRIVER_METHODS,
  type Hello,
  type PromoteOptions,
  READONLY_METHODS,
  type ResealOptions,
  type Req,
  type Res,
  TASKS_METHODS,
  toWire,
  type UnsealOptions,
} from "./rpc.ts";

// --- who am I ---------------------------------------------------------------

/**
 * The device id, taken from the WORKER NAME.
 *
 * The name is the only thing available at module evaluation — before any
 * client has said anything — and the lock, the namespace and the boot
 * counter are all needed that early. It is also the key the platform
 * uses to decide whether a second tab joins THIS worker or spawns
 * another, so taking the id from anywhere else would let two different
 * devices share one global.
 *
 * `attach` re-checks the id a client claims against this one and refuses
 * a mismatch: a client that constructed the worker under one name and
 * then asked it to host a different device is a bug worth failing on,
 * not a configuration to honour.
 */
const WORKER_NAME = (self as unknown as { name?: string }).name ?? "";
const DEVICE_ID = WORKER_NAME.startsWith("pm-device-")
  ? WORKER_NAME.slice("pm-device-".length)
  : WORKER_NAME;

const INSTANCE_NONCE = crypto.randomUUID();
const ns: DeviceNamespace = openNamespace(DEVICE_ID);

/**
 * Bumped exactly ONCE per worker global scope, at module evaluation, in
 * the namespace's unsealed `meta` store.
 *
 * This is the spike's Q4 instrument promoted to production, and it earns
 * its place: "the same host" and "a new host that looks the same" are
 * otherwise indistinguishable from a tab, and three of the matrix rows
 * (two tabs share a worker; a killed worker really died; a reload really
 * respawned) are claims about precisely that difference. It is in `meta`
 * rather than `sealed` because the sweep and the picker read it before
 * anything is unsealed, and it says nothing personal — it is a count.
 */
const bootSeq: Promise<number> = (async () => {
  try {
    return (await ns.update<number>("meta", "boot", (n) => (n ?? 0) + 1)) ?? 1;
  } catch {
    // A namespace that cannot be opened at all is a real problem, but it
    // is `attach`'s to report against a client that can hear it. Boot
    // counting must never be the thing that stops a worker booting.
    return 0;
  }
})();

// --- the lock and the lease -------------------------------------------------

let lock: DeviceLock | null = null;

/**
 * Take the device lock and start the lease. Idempotent: a second client
 * attaching must not queue behind our own grant.
 *
 * The request DOES NOT pass `ifAvailable`, so it QUEUES. That is the
 * right behaviour for the respawn case: the outgoing worker's grant is
 * released by its death, and a host that refused rather than waited
 * would turn a millisecond of overlap into a failed boot. The await is
 * what makes "attached" mean "actually hosting".
 */
async function takeLock(): Promise<void> {
  if (lock) return;
  lock = await holdDeviceLock(DEVICE_ID);
  // THE HEARTBEAT'S `stop()` HANDLE IS DELIBERATELY DROPPED. Nothing
  // here ever stops the lease: it is meant to end when this global does,
  // exactly as the lock does, and the two together are the sweep's
  // "alive" answer. `lock` is kept only because the early return above
  // is what makes a second client's attach idempotent.
  startLease(ns);
}

// --- the unseal state machine -----------------------------------------------
//
// THE RUNGS, and which one is asked is the DEVICE RECORD's `unsealPolicy`
// — not a client's request. A client that could choose the ceremony
// could choose the weakest one.
//
//   every-session  the passphrase, every time. `unsealFromPlatform` is
//                  never even attempted: a device whose owner asked to
//                  be asked must be asked.
//   until-reseal   the persisted platform wrap opens it with no
//                  interaction. If the wrap is gone (a reseal happened)
//                  this DEGRADES to demanding the passphrase, which is
//                  exactly what reseal is for.
//   while-open     THE DEK IS THIS WORKER'S MEMORY. There is no rung to
//                  climb: while the global lives the device is open, and
//                  when it dies the device is shut. See the honest
//                  sentence on `unseal` below.

/** The unwrapped DEK, or null while sealed. THE WHOLE UNSEALED STATE. */
let dek: CryptoKey | null = null;

/**
 * The engine and how it came up. `resumed` is `true` when
 * `stateResume()` answered true, `false` when the fresh-init path ran,
 * `null` while there is no engine.
 */
let engine: Engine | null = null;
let resumed: boolean | null = null;
let lastCheckpoint: number | null = null;

/** What `attach` was told. Null until the first client attaches. */
let attached: AttachSpec | null = null;

/**
 * OPEN THE DEVICE — the login (PERSISTENCE.md, "Unseal UX": "Unseal is
 * the login").
 *
 * THE HONEST SENTENCE, which belongs on this API and which the UI must
 * repeat where it applies: the `until-reseal` rung is LOGIN CONVENIENCE,
 * NOT PROTECTION AGAINST SOMEONE HOLDING YOUR PROFILE. The wrapping key
 * is a non-extractable platform key, so the DEK cannot be lifted out of
 * the browser profile as bytes — but anything that can run script on
 * this origin in this profile can ask the platform to unwrap, exactly as
 * this worker does. And the `while-open` rung's honesty is its own: it
 * is ≈ a browser session, because it is literally this worker global's
 * lifetime and nothing more. Neither tier is the passphrase tier;
 * `every-session` is the real one.
 *
 * Succeeding twice is a no-op that reports the current status: two tabs
 * both calling `unseal` on one already-open device is the normal case,
 * not a race to lose.
 */
async function unseal(opts: UnsealOptions = {}): Promise<DeviceStatus> {
  if (dek) return await status();
  const record = await getDevice(DEVICE_ID);
  if (!record) {
    // The degrade rule's storage half (PERSISTENCE.md, "T0 reload
    // survival"): a pointer to a swept device is a FRESH DEVICE,
    // silently — but the freshness is the CLIENT's to arrange, because
    // only the tab holds the anchor. From in here it is simply a
    // refusal, and client.ts's `connectDevice` never produces it
    // (it resolves the anchor before constructing the worker).
    throw new SealError("no-rung", `device-store: no device ${DEVICE_ID} in the index`);
  }

  const rungs = await sealState(ns);
  if (!rungs.passphrase && !rungs.untilReseal) {
    dek = await firstSeal(record.tier, opts);
  } else {
    dek = await climbRung(record.unsealPolicy, rungs, opts);
  }

  await bringUpEngine();
  return await status();
}

/**
 * THE FIRST SEAL — the promotion moment's worker half (PERSISTENCE.md,
 * "Tiers, as a promotion": "the promotion moment is where the seal
 * choices are asked"). Minting the DEK here rather than in the tab is
 * the point of the worker: the key is generated inside this global and
 * never leaves it.
 */
async function firstSeal(tier: string, opts: UnsealOptions): Promise<CryptoKey> {
  if (opts.passphrase !== undefined) {
    const key = await createSealedDek(ns, opts.passphrase);
    if (opts.untilReseal) await enableUntilReseal(ns, opts.passphrase);
    return key;
  }
  if (tier === "t0") return await sealT0(ns);
  // A T1 device with no rung and no passphrase offered is the legal
  // intermediate state index.ts's `promoteDevice` documents ("a device
  // whose row says t1 and which has no wrap yet … the next boot's unseal
  // ceremony sees 'no rung' and can ask again"). Ask again.
  throw new SealError("no-rung", "this device has no rung yet; the ceremony needs a passphrase");
}

/**
 * CONTRACT: a T0 device is sealed with no user ceremony, and this is the
 * shape that decision took.
 *
 * PERSISTENCE.md is unambiguous that T0 must be sealed — "nothing about
 * it is durable and NOTHING PERSONAL TOUCHES DISK UNSEALED" — and
 * equally unambiguous that T0 has no upfront ceremony ("try, then keep";
 * the seal choices are asked at PROMOTION, which a T0 device has not
 * reached). It is also required to survive a reload, and the spike
 * proved the worker does not: reload survival is checkpoint + rehydrate,
 * so the DEK must be recoverable by a DIFFERENT worker global. Those
 * three facts together force a persisted wrap; a key that lived only in
 * memory would make row (e) of the gate impossible.
 *
 * So a T0 device rests under the SAME mechanism as the `until-reseal`
 * rung — the DEK wrapped by a non-extractable platform key in the
 * namespace — and its EPHEMERALITY comes from the sweep rather than from
 * key volatility: when the lock is free and the lease is stale,
 * `destroyNamespace` takes the wrap, the platform key and the state
 * together. That is the honest description, and it is weaker than it
 * might sound: for as long as the namespace exists, profile access is
 * enough to open a T0 device. It is also exactly as strong as what T0
 * promises, which is nothing durable.
 *
 * The implementation uses ONLY seal.ts's exported ceremonies rather than
 * duplicating its record layout: `enableUntilReseal` requires a
 * passphrase rung to re-wrap from, so one is minted from 32 random bytes
 * and then dropped on the floor. Nothing holds it, nothing persists it,
 * nothing can reproduce it — the passphrase rung it leaves behind is a
 * door with no key, and the platform wrap is the only way in. (Being
 * able to open a T0 device with a passphrase is not a feature anyone
 * asked for; if it ever is, that is a promotion.)
 */
async function sealT0(namespace: DeviceNamespace): Promise<CryptoKey> {
  const throwaway = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  // `generated`: nothing kept this passphrase and nothing can reproduce
  // it, and the record says so — see seal.ts's `PassphraseWrap.origin`
  // and the reseal ceremony that consults it.
  const key = await createSealedDek(namespace, throwaway, "generated");
  await enableUntilReseal(namespace, throwaway);
  return key;
}

/** Climb the rung the DEVICE RECORD names — never the one the caller
 * would prefer. */
async function climbRung(
  policy: string,
  rungs: { passphrase: boolean; untilReseal: boolean },
  opts: UnsealOptions,
): Promise<CryptoKey> {
  if (policy === "every-session") {
    if (opts.passphrase === undefined) {
      throw new SealError("no-rung", "this device is opened with its passphrase, every session");
    }
    return await unsealWithPassphrase(ns, opts.passphrase);
  }
  // `until-reseal` and `while-open` both try the persisted wrap first.
  // For `while-open` that is a degradation to be honest about: this
  // worker has no DEK in memory (we would have returned already), so the
  // session it was "open for" has ended, and the only remaining doors
  // are the ones on disk.
  if (rungs.untilReseal) {
    const auto = await unsealFromPlatform(ns);
    if (auto) return auto;
  }
  if (opts.passphrase !== undefined) return await unsealWithPassphrase(ns, opts.passphrase);
  throw new SealError(
    "no-rung",
    "this device's persisted wrap is gone (resealed?); it needs its passphrase",
  );
}

/**
 * "KEEP THIS DEVICE" — the SEAL half (PERSISTENCE.md, "Tiers, as a
 * promotion": "the promotion moment is where the seal choices are
 * asked"). The index half is the tab's `promoteDevice`; see rpc.ts's
 * `PromoteOptions` for why the split falls exactly there.
 *
 * IT REQUIRES THE DEVICE TO BE OPEN. Promotion is a thing the user does
 * to a device they are using, and re-wrapping a DEK nobody has opened
 * would mean acting on a device whose state we cannot even read.
 *
 * every-session: `rekeyFromPlatform` re-wraps the DEK under the user's
 *   passphrase — authorized by the platform rung, because a T0 device's
 *   existing passphrase rung was minted from bytes nobody kept (see
 *   `sealT0`). The platform wrap is then DELETED: a user who asked to
 *   be asked every session must not leave a door open that skips the
 *   question. `reseal()`'s durable half is exactly that deletion, so it
 *   is what does it.
 *
 * until-reseal: the platform wrap IS the rung, and a T0 device already
 *   has one, so the ordinary path is a no-op on the seal. When it is
 *   absent (a device that was resealed) a passphrase is required, and
 *   `enableUntilReseal` re-arms from it.
 *
 * THE HONEST SENTENCE travels with the choice and belongs in the UI:
 * `until-reseal` is login convenience, not protection against someone
 * holding your profile. See `unseal` above and seal.ts's
 * `enableUntilReseal`.
 */
async function promote(opts: PromoteOptions): Promise<DeviceStatus> {
  if (!dek) throw new SealError("no-rung", "the device is sealed; open it before keeping it");
  if (opts.policy === "every-session") {
    if (opts.passphrase === undefined) {
      throw new SealError("no-rung", "this rung is the passphrase; the ceremony needs one");
    }
    await rekeyFromPlatform(ns, opts.passphrase);
    await resealNamespace(ns);
  } else if (opts.policy === "until-reseal") {
    const rungs = await sealState(ns);
    if (!rungs.untilReseal) {
      if (opts.passphrase === undefined) {
        throw new SealError(
          "no-rung",
          "this device's platform wrap is gone (resealed?); re-arming it needs the passphrase",
        );
      }
      await enableUntilReseal(ns, opts.passphrase);
    }
  } else {
    // `while-open` is the T0 rung and is not a thing to be promoted TO
    // (PERSISTENCE.md's ladder offers two rungs at the promotion
    // moment). Refusing is honest; silently accepting would leave a
    // device the index calls durable resting on a rung that dies with
    // the worker.
    throw new SealError("unsupported", `${opts.policy} is not a rung this ceremony offers`);
  }
  return await status();
}

/**
 * RESEAL (PERSISTENCE.md, "Unseal UX"): delete the persisted wrap, drop
 * the key material, return to the picker.
 *
 * IT IS SOMETIMES AN UPGRADE CEREMONY, AND THAT IS THE RULING.
 *
 * Deleting the platform wrap leaves whatever passphrase rung the device
 * has. For a device kept on `every-session` that is the user's own and
 * this is a plain sign-out. For a device kept on `until-reseal` and
 * never given a passphrase, the only rung left would be the one
 * `sealT0` minted from random bytes and dropped ("a door with no key"),
 * so a plain reseal would produce a picker row that demands a passphrase
 * NOBODY EVER CHOSE — a zombie entry. Destroying a device is
 * `removeDevice`'s job and is asked for explicitly; reseal must not do
 * it as a side effect.
 *
 * So for that device reseal ASKS: sealing it means choosing what unseals
 * it. `rekeyFromPlatform` re-wraps the DEK under the new passphrase —
 * and reseal time is exactly when that is still possible, because the
 * platform rung has not been deleted yet — and only then does the wrap
 * go. What comes back is an `every-session` device: sealed, and openable
 * by the passphrase just chosen. The INDEX's policy tag has to follow
 * (the picker must demand the passphrase afterwards), and that is the
 * caller's half, on the tab's side, for the same reason promotion's is.
 *
 * ORDER IS LOAD-BEARING: the re-wrap lands before the deletion, so a
 * failed ceremony leaves the device exactly as it was — still openable
 * by the platform wrap, still upgradable.
 *
 * The engine goes with the key, and it has to: the mounted state root
 * closes over the DEK, so an engine left running would keep writing
 * plaintext through a key the user just asked us to forget. There is no
 * dispose call on an `Engine` — dropping the reference is what we have —
 * so the honest claim is: no NEW call can reach that instance, its key
 * handle is unreferenced from here, and the wasm instance is garbage. An
 * in-flight call still holds its own closure until it settles.
 */
async function reseal(opts: ResealOptions = {}): Promise<DeviceStatus> {
  const rungs = await sealState(ns);
  // WHOSE PASSPHRASE RUNG IS IT? Not a question the index can answer:
  // its policy tag says which ceremony to OFFER, and a device may sit on
  // `until-reseal` and also have the user's own passphrase (that is what
  // `enableUntilReseal` being additive means). The durable answer is
  // `PassphraseWrap.origin`, which `sealState` surfaces as
  // `userPassphrase` — a rung somebody can actually walk through.
  const platformOnly = !rungs.userPassphrase && rungs.untilReseal;
  if (platformOnly) {
    if (opts.passphrase === undefined) {
      throw new SealError(
        "no-rung",
        "sealing this device means choosing what unseals it: this ceremony needs a passphrase",
      );
    }
    await rekeyFromPlatform(ns, opts.passphrase);
  }
  await resealNamespace(ns);
  dek = null;
  engine = null;
  resumed = null;
  // The timestamp goes too: a sealed device has no engine, and reporting
  // when the LAST one checkpointed invites a reader to conclude that
  // something is still being saved.
  lastCheckpoint = null;
  return await status();
}

// --- the engine -------------------------------------------------------------

/**
 * NO STORAGE EGRESS FROM THE WORKER, v1.
 *
 * The three `EngineNet` seams and the signer are FUNCTIONS, and functions
 * do not survive structured clone — so an embedder could not hand them
 * across the port even if it wanted to. Rather than invent a callback
 * protocol nothing needs yet, all four are wired to refusal, which is
 * what the spike's engine probe and the solo page already do. Per #7's
 * ruling this is not a missing feature but a stated authority: an
 * instance wired this way CANNOT reach a bucket, and that is legible
 * here rather than hidden in a config field. Giving the worker real
 * egress is its own track.
 */
const NO_STORE = {
  ownerFetch: () => Promise.reject(new ComponentException("no storage destination")),
  publicFetch: () => Promise.reject(new ComponentException("no storage destination")),
  sharedFetch: () => Promise.reject(new ComponentException("no storage destination")),
  signer: () => Promise.reject(new ComponentException("no signing credential")),
};

async function fetchArtifacts(spec: AttachSpec["artifacts"]) {
  const [envelope, bytes] = await Promise.all([
    fetch(new URL(spec.envelopeUrl, self.location.href)).then((r) => {
      if (!r.ok) throw new Error(`engine plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(new URL(spec.wasmUrl, self.location.href)).then((r) => {
      if (!r.ok) throw new Error(`engine wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

/**
 * Mount the state root and resume, or come up fresh.
 *
 * THE MOUNT IS THE SEALED BOUNDARY (engine.ts's `PersistDir` doc
 * comment: "Whatever directory is handed over receives PLAINTEXT …
 * mounting an unsealed one is choosing an unsealed device"). So what is
 * handed over is never the raw OPFS directory: it is `sealedDirectory`
 * over it, under this device's DEK. `newEngine` does the rest —
 * `filesystemWeb({preopens, writable: true})`, with the `writable` flag
 * the spike's Q2 proved is not optional.
 *
 * THE RESUME IDIOM IS THE ENGINE'S, verbatim (engine.ts:100-113): call
 * `stateResume()` FIRST and only `init` when it answers `false`. `false`
 * is "nothing to resume" and is the fresh-boot path, never an error.
 */
async function bringUpEngine(): Promise<void> {
  if (engine) return;
  if (!attached) throw new Error("device-store: the host was never attached (no engine artifacts)");
  if (!dek) throw new SealError("no-rung", "the device is sealed");

  const dir = await ns.directory();
  // The cast is the one engine.ts, sealed-fs.ts and the spike all
  // document: the DOM's `FileSystemDirectoryHandle` does not
  // STRUCTURALLY satisfy the published handle interfaces (writer
  // parameter form, `Uint8Array<ArrayBufferLike>` vs `ArrayBuffer`)
  // although the runtime shapes match exactly.
  // deno-lint-ignore no-explicit-any
  const sealed = sealedDirectory(dir as any, dek);
  const artifacts = await fetchArtifacts(attached.artifacts);
  const e = await newEngine(
    attached.label ?? `device-${DEVICE_ID.slice(0, 8)}`,
    artifacts,
    // deno-lint-ignore no-explicit-any
    NO_STORE as any,
    sealed as unknown as PersistDir,
  );

  resumed = await e.driver.stateResume();
  if (!resumed) {
    // The bringup `solo` shape (demo/host/bringup.ts:57-64): a fresh
    // device needs an identity and a partition before `tasks` has
    // anywhere to put anything.
    //
    // `init(true)` — an EXPORTABLE (seed-posture) identity — because
    // seed is the resting posture until the platform-posture engine path
    // lands, and engine.ts:110-113 warns that a checkpoint taken in
    // `platform` posture REJECTS on resume while that seam is still
    // open. A device that could not be resumed is the one failure this
    // whole track exists to prevent.
    await e.driver.init(true);
    const partition = await e.driver.createPartition();
    await e.driver.sealPartition(partition);
  }
  engine = e;

  if (!resumed) {
    // One checkpoint immediately, so a device that is created and then
    // reloaded before anyone touches it still has something to resume
    // from. Without it the first reload of a brand-new device would take
    // the fresh-init path again and mint a SECOND identity for the same
    // index row.
    await checkpoint();
  }
}

// --- the checkpoint cadence -------------------------------------------------
//
// THREE TRIGGERS, because no one of them is sufficient (PERSISTENCE.md,
// "Checkpoint semantics": crash-consistent, not write-through-perfect;
// engine.ts:95-99: "Cadence is the EMBEDDER's — there is no timer in the
// guest"):
//
//   1. DEBOUNCED AFTER MUTATIONS, 500 ms trailing. A burst of writes —
//      which is what a user typing looks like — costs one checkpoint,
//      taken 500 ms after the burst ends rather than 500 ms into it.
//      Leading-edge would checkpoint the state BEFORE the burst, which
//      is the one moment nobody wants recorded.
//   2. AN EXPLICIT RPC, for the moments an app knows are worth it (and
//      for a test that wants determinism instead of a timer).
//   3. BEST-EFFORT ON LAST-CLIENT-DISCONNECT. "Best-effort" is not
//      modesty: a tab that is killed, crashes, or is closed by the OS
//      never gets to say goodbye, and the spike's Q4 says the worker is
//      torn down in the zero-client window with no unload hook of its
//      own (`extendedLifetime`, the standard's answer, is Chrome 148+
//      and untested here — spike Q4c). Trigger 1 is what actually
//      protects the data; trigger 3 catches the orderly case.
//
// CHECKPOINTS ARE SERIALIZED AGAINST EACH OTHER and against nothing
// else. Two overlapping `stateCheckpoint()` calls into one engine
// instance would be a race over the same files for no gain, so they
// queue. Ordinary driver/tasks calls are NOT blocked behind a
// checkpoint: the engine's own semantics are crash-CONSISTENT, meaning a
// checkpoint taken while other work is in flight is a legal snapshot,
// and serializing every call behind checkpoints would stall a pairing
// poll loop for no benefit.

const CHECKPOINT_DEBOUNCE_MS = 500;
let debounceTimer: number | undefined;
let checkpointChain: Promise<unknown> = Promise.resolve();

/** Take one now, queued behind any checkpoint already running. Resolves
 * with the timestamp recorded. */
function checkpoint(): Promise<number> {
  const next = checkpointChain.then(async () => {
    if (!engine) throw new SealError("no-rung", "the device is sealed; there is nothing to checkpoint");
    await engine.driver.stateCheckpoint();
    lastCheckpoint = Date.now();
    return lastCheckpoint;
  });
  // The CHAIN must not break on a failure, or every later checkpoint
  // would inherit the rejection. The returned promise still rejects for
  // the caller.
  checkpointChain = next.catch(() => {});
  return next;
}

/** Schedule the trailing checkpoint after a mutation. */
function scheduleCheckpoint(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    // A failed background checkpoint is not reportable to anyone — no
    // client asked for it — so it is swallowed here and surfaces as a
    // stale `lastCheckpoint` in `status()`, which is a fact a client can
    // actually see.
    checkpoint().catch(() => {});
  }, CHECKPOINT_DEBOUNCE_MS);
}

// --- status -----------------------------------------------------------------

async function status(): Promise<DeviceStatus> {
  const record = await getDevice(DEVICE_ID);
  const rungs = await sealState(ns);
  const policy = record?.unsealPolicy ?? "every-session";
  return {
    deviceId: DEVICE_ID,
    tier: record?.tier ?? "t0",
    posture: record?.posture ?? "seed",
    policy,
    sealed: dek === null,
    rungs,
    // What the picker needs in order to decide whether to render a
    // passphrase field: `every-session` always, and any other policy
    // whose persisted wrap has gone away (a reseal).
    needsPassphrase: dek === null && (policy === "every-session" || !rungs.untilReseal),
    resumed,
    lastCheckpoint,
    lockHeld: await deviceLockIsHeld(DEVICE_ID),
    bootSeq: await bootSeq,
    instanceNonce: INSTANCE_NONCE,
    clients: ports.size,
  };
}

// --- the RPC ----------------------------------------------------------------

const ports = new Set<MessagePort>();

async function callHost(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "attach": {
      const spec = args[0] as AttachSpec;
      if (spec.deviceId !== DEVICE_ID) {
        throw new Error(
          `device-store: this worker hosts ${DEVICE_ID}, not ${spec.deviceId} ` +
            `(the SharedWorker name is the device id)`,
        );
      }
      // FIRST ATTACH WINS. A second tab's spec is not applied: the
      // artifacts are already fetched and an engine is possibly already
      // running, and quietly re-pointing a live host at different bytes
      // is a worse outcome than ignoring a redundant argument. They are
      // the same bytes in every real deployment.
      attached ??= spec;
      await takeLock();
      return await status();
    }
    case "detach":
      // The port is removed by `serve`'s handler before this resolves;
      // see the last-client checkpoint there.
      return await status();
    case "unseal":
      return await unseal((args[0] as UnsealOptions) ?? {});
    case "promote":
      return await promote(args[0] as PromoteOptions);
    case "reseal":
      return await reseal((args[0] as ResealOptions) ?? {});
    case "checkpoint":
      return await checkpoint();
    case "status":
      return await status();
    case "__die":
      // PROBE ONLY, and named to look like it. `SharedWorkerGlobalScope.close()`
      // is the only way to make this global go away on demand, which is
      // what a kill-and-resume act needs: closing every client tab also
      // works but takes the tabs with it, and a test that has to destroy
      // its own observers cannot observe the recovery. The lock and the
      // lease die with the global, exactly as they would in a crash —
      // which is the property under test.
      return "dying";
    default:
      throw new Error(`device-store: no host method ${method}`);
  }
}

async function call(target: string, method: string, args: unknown[]): Promise<unknown> {
  if (target === "host") return await callHost(method, args);
  if (!engine) {
    throw new SealError("no-rung", "the device is sealed; unseal it before calling the engine");
  }
  const surface = target === "driver"
    ? (engine.driver as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
    : (engine.tasks as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>);
  const names: readonly string[] = target === "driver" ? DRIVER_METHODS : TASKS_METHODS;
  // The name is checked against the TABLE, not against the object: an
  // arbitrary string from a port must never reach a property lookup on
  // the engine's exports.
  if (!names.includes(method)) throw new Error(`device-store: no ${target} method ${method}`);
  const value = await surface[method](...args);
  if (!READONLY_METHODS.has(method)) scheduleCheckpoint();
  return value;
}

function serve(port: MessagePort): void {
  ports.add(port);
  port.onmessage = (ev: MessageEvent<Req>) => {
    const { id, target, method, args } = ev.data ?? ({} as Req);
    const dying = target === "host" && method === "__die";
    call(target, method, args ?? []).then(
      (value) => {
        const res: Res = { id, ok: true, value };
        port.postMessage(res);
        // Reply FIRST, die after: a client whose kill request never
        // resolved could not tell "killed" from "hung".
        if (dying) setTimeout(() => (self as unknown as { close(): void }).close(), 0);
      },
      (e) => {
        const res: Res = { id, ok: false, error: toWire(e, isComponentException(e)) };
        port.postMessage(res);
      },
    );
    if (target === "host" && method === "detach") {
      ports.delete(port);
      if (ports.size === 0) {
        // TRIGGER 3. Fire-and-forget by construction — there is nobody
        // left to report to, and the global may be torn down before this
        // settles. That is the "best-effort" in the design record,
        // meant literally.
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
        checkpoint().catch(() => {});
      }
    }
  };
  port.onmessageerror = () => {
    // A message that could not be deserialized. There is no id to reply
    // against, so the only honest thing is to leave the caller's timeout
    // to fire; recorded here so the silence is deliberate rather than
    // missing code.
  };
  port.start();
  const hello: Hello = {
    id: 0,
    kind: "hello",
    deviceId: DEVICE_ID,
    bootSeq: 0,
    instanceNonce: INSTANCE_NONCE,
    clients: ports.size,
    attached: attached !== null,
  };
  // The boot counter is async (IndexedDB), so hello is sent twice-shaped:
  // immediately with a placeholder is worse than simply awaiting, and
  // awaiting here is safe because the client's own `attach` follows.
  bootSeq.then((n) => port.postMessage({ ...hello, bootSeq: n } satisfies Hello));
}

// SET SYNCHRONOUSLY at module evaluation. `connect` fires as soon as the
// module graph is evaluated, and a handler installed after an `await`
// misses the first client's port outright (the spike's worker.ts:448-452
// says the same thing, having been bitten by it).
(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (ev) => {
  serve((ev as MessageEvent & { ports: MessagePort[] }).ports[0]);
};
