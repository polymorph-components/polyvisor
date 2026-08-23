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
  isTrap,
  toCloneable,
} from "@polyengine/runtime/embedder";
import {
  type DeviceIdentityFragment,
  type Engine,
  newEngine,
  type PersistDir,
} from "../engine.ts";
// THE SAME MODULE INSTANCE THE ENGINE'S OWN IMPORTS COME FROM. `newEngine`
// builds the port's fragment with `webcryptoImports()` out of
// `@polymorph/webcrypto-polyengine` (engine.ts:13), and these two statics
// are exports of THAT module — so a handle minted here lands in the same
// class family the port's own imports serve. Reaching for a second copy
// of the package (a different specifier, an unpinned range) would mint
// wrappers the port does not recognize, and the failure would arrive as
// an unhelpful lowering error deep inside a call. The specifier is
// spelled identically to engine.ts's on purpose; demo/deno.json maps it
// once for the whole graph, which is that file's stated reason for
// existing.
import { SigningKey, VerifyingKey } from "@polymorph/webcrypto-polyengine";
import { getDevice } from "./index.ts";
import { DEVICE_IDENTITY_KEY, loadOrMintIdentity } from "./identity-keys.ts";
import { type DeviceNamespace, destroyNamespace, openNamespace } from "./namespace.ts";
import {
  createSealedDek,
  enablePrf,
  enableUntilReseal,
  rekeyFromPlatform,
  reseal as resealNamespace,
  SealError,
  sealState,
  unsealFromPlatform,
  unsealWithPassphrase,
  unsealWithPrf,
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
  hostCodeOf,
  hostErrorOf,
  type Req,
  type Res,
  TASKS_METHODS,
  type UnsealOptions,
  type WireFailure,
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
//   passkey        THE CEREMONY RUNS ON THE PAGE, and it has to:
//                  `navigator.credentials` is window-only, so no code in
//                  this global can assert a passkey. What arrives here
//                  is the DERIVED KEK HANDLE (`UnsealOptions.prfKek`) —
//                  non-extractable, validated in seal.ts before use.
//                  The worker never sees the raw PRF output and never
//                  persists the handle. device-store/passkey.ts is the
//                  window half; PERSISTENCE.md's "The PRF rung: passkey
//                  unseal" is the record.

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
 * THE DEVICE WAS ERASED, and this global outlived the erasure by
 * whatever it takes to post one reply and close.
 *
 * `destroy` deletes the namespace out from under everything this global
 * owns, so the window between "the storage is gone" and "the global is
 * gone" must not be a window in which anything else can run: a call
 * arriving from a second tab would otherwise reopen the database it just
 * deleted (`openNamespace` creates), and the fresh, empty namespace
 * would have no index row pointing at it — orphaned storage nothing
 * would ever collect. So the flag is a REFUSAL, not bookkeeping: after
 * it is set, every method except `destroy` itself and the `__die` probe
 * rejects, and a racing client hears a sentence instead of inheriting a
 * half-alive host.
 */
let destroyed = false;

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
  // `!rungs.prf` IS A TRIPWIRE, not a reachable branch: every path that
  // writes a PRF wrap starts from a device that already has rungs. But
  // if a namespace ever DID hold only a PRF wrap, falling into
  // `firstSeal` here would mint a SECOND DEK and silently orphan every
  // byte sealed under the first — the exact failure `createSealedDek`'s
  // `already-sealed` refusal exists to prevent. Climb instead; the worst
  // a climb can do is refuse.
  if (!rungs.passphrase && !rungs.untilReseal && !rungs.prf) {
    dek = await firstSeal(record.tier, opts);
  } else {
    dek = await climbRung(record.unsealPolicy, rungs, opts);
  }

  // UNSEALING IS ATOMIC: KEY *AND* ENGINE, OR NEITHER.
  //
  // The DEK is assigned above because `bringUpEngine` needs it to mount
  // the sealed state root — so a failure below would otherwise leave the
  // device HALF OPEN: key material held in memory, no engine, and a
  // `status()` reporting `sealed: false` while every driver call refused
  // with "the device is sealed". Worse, the early return at the top of
  // this function would then make the NEXT `unseal()` a silent no-op
  // reporting success, on a device that still has no engine.
  //
  // The gate caught this on the mismatch row (row 22), which is exactly
  // the case that makes it reachable: the ceremony genuinely succeeds —
  // the passphrase was right, the wrap opened — and then `stateResume()`
  // refuses because the namespace holds another device's key. So the
  // rollback is not a tidy-up for impossible states; it is the ordinary
  // outcome of a device whose storage has been disturbed.
  //
  // Rolling back to SEALED rather than inventing a third state keeps one
  // thing true at a time. The caller is not left guessing why: the
  // rejection it receives is the engine's own, and for a mismatch that
  // is a `ComponentException` naming both agent ids.
  try {
    await bringUpEngine();
  } catch (e) {
    dek = null;
    engine = null;
    resumed = null;
    throw e;
  }
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
  rungs: { passphrase: boolean; untilReseal: boolean; prf: boolean },
  opts: UnsealOptions,
): Promise<CryptoKey> {
  // THE PASSKEY POLICY IS TRIED FIRST AND NEVER FALLS TO THE PLATFORM
  // WRAP. Promotion deleted that wrap precisely so this device asks; if
  // a stale one somehow survived, using it would open the device without
  // the ceremony the user chose — the `every-session` arm's
  // asked-to-be-asked rule, applied to the rung that replaced it.
  if (policy === "passkey") {
    if (opts.prfKek) return await unsealWithPrf(ns, opts.prfKek);
    // The explicit fallback the design record allows: rungs are ADDITIVE,
    // so a device switched to passkey unseal on the this-device sheet may
    // still carry the user's own passphrase, and the picker offers "use
    // your passphrase instead" beside the button. A `generated` rung is
    // not a door — `rungs.passphrase` alone would let one through — so
    // the caller must have offered a passphrase AND the device must have
    // a passphrase rung for this to be tried at all; a wrong one refuses
    // in seal.ts as it always does.
    if (opts.passphrase !== undefined && rungs.passphrase) {
      return await unsealWithPassphrase(ns, opts.passphrase);
    }
    throw new SealError(
      "no-rung",
      "this device opens with its passkey; the page runs that ceremony and hands over the key",
    );
  }
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
 * passkey: the PAGE ran the ceremony (it must — `navigator.credentials`
 *   is window-only) and hands over the enrollment plus the KEK it
 *   derived; `enablePrf` re-wraps the DEK under that handle, authorized
 *   by the platform rung when there is one and by the passphrase when
 *   there is not. The platform wrap is then DELETED, for
 *   `every-session`'s reason.
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
  } else if (opts.policy === "passkey") {
    // The page has already run the enrollment ceremony (passkey.ts) and
    // is handing over the metadata plus the KEK it derived; the worker
    // cannot run it itself, because `navigator.credentials` is
    // window-only. Without that payload there is nothing to enroll.
    if (opts.prf === undefined) {
      throw new SealError(
        "no-rung",
        "this rung is a passkey; the ceremony needs the page's enrollment and its derived key",
      );
    }
    const { credentialId, transports, rpId, prfInput, hkdfSalt } = opts.prf;
    await enablePrf(
      ns,
      opts.prf.kek,
      { credentialId, transports, rpId, prfInput, hkdfSalt },
      { passphrase: opts.passphrase },
    );
    // THE PLATFORM DOOR SHUTS, for the `every-session` arm's reason
    // verbatim: a user who chose to be asked — here, asked for their
    // passkey — must not leave a door standing that skips the question.
    // `reseal()`'s durable half is exactly that deletion, and the PRF
    // wrap just written survives it by design (seal.ts's `reseal`).
    await resealNamespace(ns);
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
  //
  // THE GUARD'S QUESTION, generalized: "would deleting the platform wrap
  // leave NO door anybody can walk through?" A PASSKEY RUNG IS ALWAYS
  // ONE. It exists only because a person enrolled a credential they
  // hold, which is why `PrfWrap` carries no `origin` field to consult —
  // the reachability is by construction. So a device with a PRF rung
  // reseals plainly, with no upgrade ceremony and nothing to ask for.
  const platformOnly = !rungs.userPassphrase && !rungs.prf && rungs.untilReseal;
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

// --- the device identity (platform posture) ---------------------------------
//
// THE POSTURE THE DESIGN ALWAYS WANTED (PERSISTENCE.md, "Device signing
// identity"): the device's signing key is a NON-EXTRACTABLE WebCrypto
// handle living in the device namespace, and the engine is handed that
// handle rather than a seed it could write into a checkpoint. A seed
// posture's private material rests inside the sealed state root; a
// platform posture's cannot leave the browser profile at all, because
// the platform refuses to export it — which is the difference between
// "encrypted at rest under a key someone may hold" and "not present".
//
// THE ENGINE SEAM is the app-owned `polyvisor:engine/device-identity@0.1.0`
// import (engine.wit; the webcrypto#391 ruling that persistence is an
// EMBEDDER library, not a WebCrypto capability). It is consulted twice:
// at `init(false)`, where the handed pair is ADOPTED instead of a fresh
// mint, and at `stateResume()` of a platform checkpoint, where it is the
// only place the identity can come from — and where the engine verifies
// it against the agent id the manifest recorded.

/**
 * The device's key pair, loaded ONCE per worker global.
 *
 * `loadOrMintIdentity` is already race-free and validate-on-load
 * (identity-keys.ts), so the caching here is about not paying an
 * IndexedDB round trip on every `deviceKeyPair()` call — the engine asks
 * at least once per instantiation and the answer cannot change while
 * this global lives.
 *
 * A REJECTION CLEARS THE CACHE. A poisoned promise would make one
 * transient IndexedDB failure permanent for the worker's whole life,
 * which for a device host means "this device never opens again until you
 * close every tab".
 */
let identityPair: Promise<CryptoKeyPair> | undefined;

/** Where the fresh-init agent id is recorded, in the unsealed `meta`
 * store beside the lease and the boot counter. */
const AGENT_KEY = "agent";

function devicePair(): Promise<CryptoKeyPair> {
  identityPair ??= loadOrMintIdentity(ns, DEVICE_IDENTITY_KEY)
    .then((r) => r.pair)
    .catch((e) => {
      identityPair = undefined;
      throw e;
    });
  return identityPair;
}

/**
 * Build the `device-identity` fragment for ONE engine instance.
 *
 * FRESH PER INSTANCE, and that is not incidental: the port's resource
 * classes carry per-instance registry identity (engine.ts's module
 * header, the polymorph-iroh host-deltic finding), so a `SigningKey`
 * wrapper minted for one instance must not be handed to another. What is
 * cached across instances is the `CryptoKeyPair` — plain platform
 * handles, which belong to no registry — and the wrappers are minted at
 * the moment the engine asks.
 *
 * `fromCryptoKey` is the merged webcrypto#392 injection seam: it
 * launders the key, checks the type, algorithm and usages, and mints a
 * wrapper under the port's private token. The non-extractability rides
 * along untouched — the port never sees material either.
 */
function deviceIdentityFragment(): DeviceIdentityFragment {
  return {
    deviceKeyPair: async () => {
      const pair = await devicePair();
      return [
        SigningKey.fromCryptoKey(pair.privateKey),
        VerifyingKey.fromCryptoKey(pair.publicKey),
      ];
    },
  };
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
    deviceIdentityFragment(),
  );

  resumed = await e.driver.stateResume();
  if (!resumed) {
    // The bringup `solo` shape (demo/host/bringup.ts:57-64): a fresh
    // device needs an identity and a partition before `tasks` has
    // anywhere to put anything.
    //
    // `init(false)` — PLATFORM POSTURE, now that the seam is open. The
    // engine consults the `device-identity` import first and adopts the
    // handle this worker just loaded, so the identity a fresh device
    // starts life with is the one already persisted in its namespace
    // rather than a fresh mint the guest would then have to write down.
    //
    // The old `init(true)` was a placeholder with a stated reason: a
    // platform checkpoint used to be REFUSED on resume, so seed was the
    // only posture that could survive a kill. That is no longer true —
    // engine commit addbca8 — and seed's cost is real: its private
    // material rests inside the checkpoint, so it is only as safe as the
    // DEK, whereas a platform key is not in the checkpoint at all.
    //
    // `__seedPosture` is the probe's back-compat knob and nothing else;
    // see AttachSpec.
    const agent = await e.driver.init(attached.__seedPosture === true);
    // RECORDED IN `meta`, unsealed, deliberately: an agent id is a public
    // key, it is the one thing a resumed device must still be, and the
    // sweep and the picker both read this store before anything is open.
    // It is written on the FRESH path only — a resume must never be able
    // to overwrite the id it is supposed to have matched.
    await ns.put("meta", AGENT_KEY, agent);
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
    // The id the engine reported at this device's FRESH init — a public
    // key, so it rests unsealed like everything else in `meta`. It is
    // what a resume has to still be, and the probe matrix compares it
    // across a kill; `khKnowsAgent(unhex(agentId))` asks the resumed
    // engine the same question from the other side.
    agentId: (await ns.get<string>("meta", AGENT_KEY)) ?? null,
    policy,
    sealed: dek === null,
    rungs,
    // What the picker needs in order to decide whether to render a
    // passphrase field: `every-session` always, and any other policy
    // whose persisted wrap has gone away (a reseal) — unless a PASSKEY
    // rung is what opens this device, in which case what the next
    // `unseal()` needs is that ceremony, not a passphrase. The picker
    // learns which to offer from `policy`; `rungs` tells it what else it
    // may offer beside it.
    needsPassphrase: dek === null &&
      (policy === "every-session" || (!rungs.untilReseal && !rungs.prf)),
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
    case "destroy": {
      // "ERASE THIS DEVICE" — the user's explicit one, and the only
      // method here that ends with there being nothing left to host.
      //
      // ORDER IS THE WHOLE OF IT, because `destroyNamespace` deletes a
      // database and an OPFS directory that three different things in
      // this global are still entitled to write to.
      //
      // 1. THE DEBOUNCE TIMER. A mutation within the last 500 ms has a
      //    checkpoint armed; letting it fire after the delete would
      //    recreate the namespace's files behind an index row that no
      //    longer exists.
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      // 2. THE CHAIN. A checkpoint already RUNNING is mid-write into the
      //    state root; draining is the only way to be sure none outlives
      //    the storage. Awaiting the chain (rather than `checkpoint()`)
      //    is safe by construction — the chain swallows failures so that
      //    later checkpoints do not inherit a rejection, so this cannot
      //    turn a stale background write into a refused erasure.
      await checkpointChain;
      // 3. THE REFUSAL GOES UP BEFORE THE FIRST DELETE, so nothing that
      //    arrives while the awaits below are outstanding can reopen
      //    what is being torn down.
      destroyed = true;
      // The key and the engine go the way `reseal` sends them, and for a
      // sharper version of the same reason: the mounted state root
      // closes over the DEK and over files that are about to stop
      // existing. There is no dispose call on an `Engine` — dropping the
      // reference is what we have — so the honest claim is unchanged: no
      // NEW call can reach that instance and the wasm instance is
      // garbage, while an in-flight call still holds its own closure
      // until it settles. The identity promise goes too; its handles
      // live in the `identity` store, which is one of the things being
      // deleted.
      dek = null;
      engine = null;
      resumed = null;
      lastCheckpoint = null;
      identityPair = undefined;
      // The device leaves: database, OPFS directory, index row. A throw
      // here PROPAGATES — the client's ceremony is built to refuse on
      // it, and a swallowed failure would report an erasure that did not
      // happen. (This is a SharedWorker, so the wasi fs backend cannot
      // be holding OPFS sync-access handles: with the chain drained and
      // the engine dropped, the recursive removal has nothing left to
      // contend with.)
      await destroyNamespace(DEVICE_ID);
      return "destroyed";
    }
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
  // THE ERASED-DEVICE REFUSAL, in front of every surface at once —
  // `callHost` is reachable only from here, so this one place is the
  // whole of it. `destroy` stays open because it is idempotent and a
  // retry of a partly-failed erasure is a thing a client is entitled to
  // do; `__die` stays open because closing the global is never wrong for
  // a device that no longer exists.
  if (destroyed && !(target === "host" && (method === "destroy" || method === "__die"))) {
    throw new Error(`device-store: this device was erased (${target}.${method} refused)`);
  }
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

/**
 * Choose how one rejection crosses (rpc.ts's "how a rejection crosses").
 *
 * ORDER MATTERS. The branded taxonomy is tested FIRST and unconditionally:
 * a `ComponentException` is the engine's err arm and belongs in the
 * cloneable form whatever else it happens to carry. Only then does a
 * typed host `code` claim the value, because the cloneable form's
 * unbranded-`Error` row would drop that code silently. Everything left
 * over — a `TypeError` from a host bug, a plain `Error` — takes the
 * cloneable form too, which is a strict upgrade on the old flattening:
 * it keeps the cause chain and the worker-side stack, and the
 * worker-side stack is the diagnostically useful one.
 */
function toFailure(e: unknown): WireFailure {
  const branded = isComponentException(e) || isTrap(e);
  if (!branded) {
    const code = hostCodeOf(e);
    if (code !== undefined) return { form: "host", error: hostErrorOf(e, code) };
  }
  try {
    return { form: "cloneable", value: toCloneable(e) };
  } catch (refusal) {
    // `toCloneable` REFUSES rather than degrades: an `InvalidHandleError`
    // naming the path to a realm-local leaf, or a `TypeError` for a
    // prototype the form does not cover. Both are findings about THIS
    // code — something put a handle where a value belongs — and the
    // refusal message names the path, so it is forwarded verbatim under
    // a code the client can see instead of being swallowed into a
    // timeout. Nothing is stripped to make the send succeed.
    return { form: "host", error: hostErrorOf(refusal, "unclonable") };
  }
}

function serve(port: MessagePort): void {
  ports.add(port);
  port.onmessage = (ev: MessageEvent<Req>) => {
    const { id, target, method, args } = ev.data ?? ({} as Req);
    // BOTH METHODS END THE GLOBAL, for the same mechanical reason and
    // two different purposes: `__die` is the crash probe, and `destroy`
    // has just deleted everything this global exists to own. A host left
    // running over an erased namespace would keep a lock and a lease
    // alive for a device the index no longer lists.
    const dying = target === "host" && (method === "__die" || method === "destroy");
    call(target, method, args ?? []).then(
      (value) => {
        const res: Res = { id, ok: true, value };
        try {
          port.postMessage(res);
        } catch (cloneFailure) {
          // A `DataCloneError` HERE IS A FINDING, NOT A NUISANCE. Every
          // method on the proxied surfaces is supposed to move records,
          // strings and bytes (rpc.ts's serialization-discipline note),
          // so this firing means a REALM-LOCAL VALUE — a stream, a
          // future, a resource wrapper — has leaked into a result, and
          // the honest response is to say so at the call site rather
          // than strip it and hand back a husk. Without this catch the
          // throw would escape into the message handler and the client
          // would simply time out, which is the same bug with none of
          // the evidence.
          port.postMessage({
            id,
            ok: false,
            failure: {
              form: "host",
              error: hostErrorOf(cloneFailure, "unclonable"),
            },
          } satisfies Res);
          return;
        }
        // Reply FIRST, die after: a client whose kill request never
        // resolved could not tell "killed" from "hung".
        if (dying) setTimeout(() => (self as unknown as { close(): void }).close(), 0);
      },
      (e) => {
        const res: Res = { id, ok: false, failure: toFailure(e) };
        port.postMessage(res);
      },
    );
    if (target === "host" && method === "detach") {
      ports.delete(port);
      if (ports.size === 0 && !destroyed) {
        // TRIGGER 3. Fire-and-forget by construction — there is nobody
        // left to report to, and the global may be torn down before this
        // settles. That is the "best-effort" in the design record,
        // meant literally.
        //
        // NOT AFTER AN ERASE. `checkpoint()` would throw on the dropped
        // engine and the throw would be swallowed here anyway, so the
        // guard buys no safety it did not already have — it states the
        // intent, which is that the last tab of an erased device leaves
        // without writing anything back.
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
