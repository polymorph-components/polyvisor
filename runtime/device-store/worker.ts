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
} from "@polyengine/protocol";
import {
  type DeviceIdentityFragment,
  type Engine,
  newEngine,
  type PersistDir,
  type RecoveryKit,
  type StoreConfig,
  type StoreSign,
  type UsPartition,
} from "../engine.ts";
// THE STORAGE EGRESS SEAMS AND THE ESCROW, both runtime modules and
// both already inside this file's pin set: keystore.ts and
// store-egress.ts import `@polyengine/protocol` (they took it from
// `@polyengine/runtime/embedder` until A22 moved the vocabulary), which
// worker.ts pins anyway for the cloneable forms and `ComponentException`, so
// neither adds a resolution burden to this graph (runtime/README.md's
// model; the device-store CORE modules stay package-free, this entry
// point never was). The keystore read is a plain same-origin IndexedDB
// read: a SharedWorker on the origin sees the very database the page's
// credential sheet wrote into, which is what lets the secret stay on the
// page and still reach the signer (STORAGE-EGRESS.md §2).
import {
  type EgressGrant,
  emptyGrant,
  makeOwnerFetch,
  makePublicFetch,
  makeSharedFetch,
  normalizeOrigin,
} from "../store-egress.ts";
import { getSigningKey, makeSigner, type Signer } from "../keystore.ts";
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
import { DEVICE_ENDPOINT_KEY, DEVICE_IDENTITY_KEY, loadOrMintIdentity } from "./identity-keys.ts";
import { type DeviceNamespace, destroyNamespace, openNamespace } from "./namespace.ts";
import {
  createSealedDek,
  enablePrf,
  enableUntilReseal,
  rekeyFromPlatform,
  reseal as resealNamespace,
  SealError,
  sealedDelete,
  sealedGet,
  sealedPut,
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
  type GdriveSpace,
  type Hello,
  type OauthStartResult,
  type OauthStartSpec,
  type PromoteOptions,
  READONLY_METHODS,
  type RecoveryKitInput,
  type RecoveryKitResult,
  type RecoveryKitSpec,
  type ResealOptions,
  type RestoreSpec,
  hostCodeOf,
  hostErrorOf,
  type Req,
  type Res,
  type StoreBinding,
  type SyncStatus,
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
    // THE GRANT GOES BACK TOO. `bringUpEngine` arms the grant BEFORE the
    // engine exists (it has to: the seams close over it at
    // instantiation), so a failure anywhere after that point would
    // otherwise leave a sealed device holding live egress authority for
    // a destination — armed seams with no engine and no DEK, which is
    // precisely the half-open state this rollback exists to forbid.
    clearGrant();
    throw e;
  }
  // THE SCHEDULE STARTS HERE, NOT INSIDE `bringUpEngine`, and the
  // placement is the contract (SYNC.md §2: the boot pull runs "after the
  // worker re-applies the binding and the engine is up, BEHIND
  // readiness"). By this line the engine is published and `status()` is
  // answerable, and `startSyncSchedule` only arms a timer — so the boot
  // pull cannot be in front of the answer this call is about to return,
  // and boot never blocks on the network.
  startSyncSchedule();
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
 * by the platform wrap, still upgradable. A FINAL CHECKPOINT sits
 * between them, and it can refuse the whole ceremony: see the note at
 * the call site.
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
  // THE FINAL CHECKPOINT, and it is the FALLIBLE HALF, taken first.
  //
  // Sealing drops the engine (see this function's header), and a
  // mutation inside the 500 ms debounce window has a checkpoint armed
  // that will never fire — so without this, every seal silently threw
  // away up to half a second of work. `destroy` already drains the
  // chain for the sharper version of the same reason ("a checkpoint
  // already RUNNING is mid-write into the state root"); reseal only
  // grew the asymmetry because for a long time nothing in that window
  // was expensive to lose. #93 ended that: bucket state — the per-doc
  // name-key chain and the flushed-chunk map — is checkpointed now, and
  // losing it does not merely rewind a keystroke, it re-mints the
  // keychain and makes the next flush upload a complete duplicate of
  // the store under all-new names.
  //
  // A FAILURE PROPAGATES and the device STAYS OPEN. This is the erase
  // ceremony's discipline (keystore.ts's `eraseKeystore`: report the
  // refusal, let the user retry, never report success over a partial
  // act) applied to the other end of the lifecycle — sealing over work
  // we just failed to save is exactly "reporting success over a partial
  // act", and the user can always try again on a device that is still
  // open. Nothing has been dropped at this point: `rekeyFromPlatform`
  // above is additive and leaves the device openable either way.
  //
  // AN UNTOUCHED ENGINE IS NOT A FAILURE PATH: `stateCheckpoint()` on an
  // engine that has done nothing since it resumed simply writes another
  // generation. The only case with nothing to checkpoint is having no
  // engine at all — an already-sealed device — which is why the guard
  // is `engine !== null` rather than a "was anything mutated" flag we
  // would have to keep honest.
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  // THE PRE-RESEAL FLUSH, AND IT IS THE ASYMMETRIC HALF (SYNC.md §3).
  //
  // The reseal-saves-first discipline extends to the bucket: sealing
  // means everything the account should have crossed the wire or the
  // bucket, and a mutation inside the 20 s flush window has a flush
  // armed that this ceremony is about to cancel. So one runs here.
  //
  // BUT IT IS BEST-EFFORT AND A FAILURE MUST NOT REFUSE THE RESEAL,
  // unlike the mandatory checkpoint immediately below — SYNC.md §3 says
  // why in one clause: "reseal must not become hostage to an unreachable
  // bucket". The two halves fail differently because what is at stake
  // differs. A failed CHECKPOINT means work would be LOST, and it is
  // recoverable by trying again on a device that is still open. A failed
  // FLUSH means work is still safely on this disk and merely not yet in
  // the bucket — and the user asking to seal may be doing so precisely
  // because they are about to lose the network, or leave, or hand the
  // laptop over. Holding a device open against that is refusing a
  // security act over a durability nicety.
  //
  // IT GOES BEFORE THE CHECKPOINT, not after: a flush mutates the
  // guest's bucket state (the name-key chain and the flushed-chunk map),
  // and #93's whole finding is that losing that state costs a duplicate
  // upload of the entire store. Flushing after the final checkpoint
  // would leave exactly that state uncheckpointed.
  await syncFlushNow();
  if (engine !== null) await checkpoint();
  await resealNamespace(ns);
  dek = null;
  engine = null;
  resumed = null;
  // The timestamp goes too: a sealed device has no engine, and reporting
  // when the LAST one checkpointed invites a reader to conclude that
  // something is still being saved.
  lastCheckpoint = null;
  // AND THE EGRESS AUTHORITY, with the DEK (STORAGE-EGRESS.md §6): the
  // grant is emptied and the signer — with its per-scope key cache — is
  // dropped. The BINDING rests sealed and returns at the next unseal;
  // the ESCROW persists, because it is profile-tier and shared by every
  // device on this origin. The honest sentence for the UI: sealing a
  // device does not seal the escrow, it takes away this device's name
  // for it.
  clearGrant();
  return await status();
}

// --- storage egress ---------------------------------------------------------
//
// THE SEAMS ARE REAL AND THEY REFUSE UNTIL SOMETHING BINDS THEM
// (runtime/STORAGE-EGRESS.md §1).
//
// The three `EngineNet` fetch seams and the signer are FUNCTIONS, and
// functions do not survive structured clone — so an embedder on the other
// side of the port could not hand them over even if it wanted to. That
// fact has not changed; what changed is the conclusion drawn from it.
// Rather than a callback protocol, the closures live HERE, in the worker,
// built over a worker-held mutable `EgressGrant` exactly as the demo page
// builds them over its own — and what crosses the port is DATA: a
// `StoreBinding`, addressing plus a public identifier, which is why the
// binding ceremony below takes that shape and no other.
//
// Per #7 the authority is in the WIRING, not in a config field: an
// instance whose grant is empty CANNOT reach a bucket, and the refusal is
// the factories' own ("… no storage grant configured yet",
// "store-signer: no signing credential wired for this instance"). That is
// the same observable posture the old `NO_STORE` had, with one
// difference that matters: a bind can now change the grant's CONTENTS
// without relinking anything, so a device gains storage without a new
// engine instance. Selection stays by import name; nothing here chooses a
// credential per request.
//
// The binding ceremony is `bindStore`/`unbindStore` below; the sealed
// persistence and the re-application at every bring-up are §3.

/**
 * The device's egress grant — ONE object for the life of this global.
 *
 * Never reassigned: every seam closes over this identity at
 * instantiation, so a bind mutates the CONTENTS (rebind, not relink) and
 * a reseal empties them. Reassigning it would silently orphan every live
 * engine's wiring.
 */
const storeGrant: EgressGrant = emptyGrant();

/** The escrowed signer for the bound destination, or null when nothing
 * is bound. Dropped at reseal with the DEK (§6). */
let storeSigner: Signer | null = null;

/**
 * The `store-signer` import, wired ONCE per engine instance and pointed
 * at whatever `storeSigner` currently holds.
 *
 * This is demo/host/demo.ts's boot-time `wiredSigner` (demo.ts:1011),
 * which was the reference implementation and which this replaces for the
 * worker host: same box-holding-a-signer shape, same refusal text, for
 * the same reason — null must mean "the seam exists and says no", not
 * "the import is absent". An absent import would trap the guest; a
 * present one lets it render the refusal.
 */
const wiredSigner: StoreSign = (stringToSign, date, region, service) => {
  if (!storeSigner) {
    return Promise.reject(
      new ComponentException("store-signer: no signing credential wired for this instance"),
    );
  }
  return storeSigner(stringToSign, date, region, service);
};

/** The sealed-kv name the `StoreBinding` rests under, JSON, under the
 * device's DEK (§3). Pre-unseal nothing on disk names the destination. */
const STORE_BINDING_KEY = "storage";

/** Read the binding out of the sealed namespace, or undefined if this
 * device has none. Propagates `SealError "tampered"` — see `readBinding`
 * callers. */
async function readBinding(key: CryptoKey): Promise<StoreBinding | undefined> {
  const bytes = await sealedGet(ns, key, STORE_BINDING_KEY);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as StoreBinding;
}

/**
 * THE SEALED OAUTH ROW — the user's own Google tokens, at rest
 * (DRIVE.md §4).
 *
 * DEVICE-scoped, deliberately unlike the SigV4 escrow, which is
 * origin-shared: there is no platform handle for a bearer, so the DEK
 * seal is the best rest available, and sharing one across devices would
 * be credential sharing between agents. Multi-device is the same client
 * id and the same root with SEPARATE consents.
 *
 * THE ROW NEVER LEAVES THIS FILE'S CONTROL. It is never logged, never
 * reported in `status()` (which carries only the boolean
 * `gdriveConsent`), and never crosses the port in either direction. The
 * only shapes derived from it that go anywhere are the grant's in-memory
 * bearer/refresh and the outbound Authorization header the owner seam
 * attaches.
 */
const OAUTH_KEY = "oauth-gdrive";

interface OauthRow {
  access: string;
  refresh?: string;
  /** The client id the consent was granted TO. The `drive.file` scope
   * confines visibility per client id (DRIVE.md §2), so a binding naming
   * a different one is a mismatch to refuse at bind. */
  clientId: string;
  /** WHICH SPACE THIS CONSENT WAS GRANTED FOR — i.e. which SCOPE was
   * asked for and agreed to (DRIVE.md §5). Recorded here because a
   * binding naming the other space is asking this device to act under a
   * permission it was never given, and that is a bind-time refusal. */
  space: GdriveSpace;
  clientSecret?: string;
  /** The token endpoint this consent was obtained from, kept so the
   * refresh behind the owner seam goes back to the SAME backend a
   * self-hosted/fake deployment used. */
  tokenUrl?: string;
  obtainedAt: number;
}

async function readOauth(key: CryptoKey): Promise<OauthRow | undefined> {
  const bytes = await sealedGet(ns, key, OAUTH_KEY);
  if (!bytes) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as OauthRow;
}

async function writeOauth(key: CryptoKey, row: OauthRow): Promise<void> {
  await sealedPut(ns, key, OAUTH_KEY, new TextEncoder().encode(JSON.stringify(row)));
}

/**
 * Point the grant and the signer at `b`'s destination.
 *
 * THE GRANT IS DERIVED FROM THE DESTINATION, NEVER ACCEPTED AS AN
 * ALLOWLIST (STORAGE-EGRESS.md §4). Nothing on the wire says where this
 * device may go: the origin is computed from the address it was told to
 * use, so a client cannot widen the reach by asking.
 *
 * S3: the population is demo.ts's `setupBucket` S3 arm verbatim in
 * effect (demo.ts:1285-1292) — owner and public both the one origin, the
 * shared set EMPTY because S3 has no app tier and the shim refuses that
 * seam by name.
 *
 * GDRIVE (DRIVE.md §1/§5): owner is the one API origin and the public
 * and shared sets are EMPTY — the unused tiers refuse BY CONSTRUCTION
 * rather than by a checked flag, which is what "user-only" means here.
 * The authority is the user's own sealed consent, so this arm ARMS ONLY
 * WHEN ONE RESTS: with no consent the grant is left EMPTY and every seam
 * refuses, while the binding's `initStore` still applies — addressing is
 * not authority. There is no SigV4 on this provider, so the signer stays
 * null and `wiredSigner` refuses by name.
 *
 * ASYNC because the gdrive arm reads the sealed oauth row.
 *
 * Returns the normalized origin, or null when the address is not one.
 */
async function applyBinding(b: StoreBinding): Promise<string | null> {
  if (b.kind === "gdrive") {
    const origin = normalizeOrigin(b.apiBase);
    if (origin === null) return null;
    const row = dek ? await readOauth(dek) : undefined;
    if (!row) {
      // No consent rests: leave the grant EMPTY. The device knows where
      // its store is and has no authority to reach it, which is the
      // honest state and the one the seams already have words for.
      clearGrant();
      return origin;
    }
    // Rebind: contents, not wiring.
    storeGrant.provider = "gdrive";
    storeGrant.origins = new Set([origin]);
    storeGrant.publicOrigins = new Set();
    storeGrant.sharedOrigins = new Set();
    storeGrant.bearer = row.access;
    if (row.refresh !== undefined) storeGrant.refresh = row.refresh;
    else delete storeGrant.refresh;
    storeGrant.appKey = row.clientId;
    if (row.clientSecret !== undefined) storeGrant.appSecret = row.clientSecret;
    else delete storeGrant.appSecret;
    if (row.tokenUrl !== undefined) storeGrant.tokenUrl = row.tokenUrl;
    else delete storeGrant.tokenUrl;
    storeSigner = null;
    return origin;
  }
  const origin = normalizeOrigin(b.endpoint);
  if (origin === null) return null;
  // Rebind: contents, not wiring.
  storeGrant.provider = "s3";
  storeGrant.origins = new Set([origin]);
  storeGrant.publicOrigins = new Set([origin]);
  storeGrant.sharedOrigins = new Set();
  storeSigner = makeSigner(origin);
  return origin;
}

/**
 * Empty the grant and drop the signer — the in-worker egress authority,
 * gone (STORAGE-EGRESS.md §6).
 *
 * IN PLACE, for the reason `storeGrant` is a `const`: the live engine's
 * seams closed over this object, and only mutating it can make them
 * refuse. Every seam checks `provider === null` first, so this is the
 * whole of the revocation; the origin sets are replaced anyway so that a
 * later reader cannot mistake a stale allowlist for a live one.
 */
function clearGrant(): void {
  storeGrant.provider = null;
  storeGrant.origins = new Set();
  storeGrant.publicOrigins = new Set();
  storeGrant.sharedOrigins = new Set();
  delete storeGrant.bearer;
  delete storeGrant.refresh;
  delete storeGrant.appKey;
  delete storeGrant.appSecret;
  delete storeGrant.tokenUrl;
  storeSigner = null;
  // AND THE SCHEDULE, at every one of these sites at once. See
  // `stopSyncSchedule` for why this is the right place to hang it: a
  // grant that has been dropped is a destination this device can no
  // longer reach, and a timer left armed over one would fire into a
  // device with nothing to sync — or, at the seal sites, with no DEK.
  stopSyncSchedule();
}

/**
 * A BIND REFUSAL — the worker's own condition, not the engine's and not
 * the seal ladder's.
 *
 * It carries a `code` as an own property, which is exactly what rpc.ts's
 * `hostCodeOf` reads (structurally, deliberately: "a hand-rolled refusal
 * with one is as legitimate as `SealError`"), so it crosses the port as
 * a typed `{form:"host"}` failure and the client can branch on the code
 * rather than on a message. The two codes are the two ways a destination
 * can be unusable, and both are settled AT BIND TIME rather than being
 * discovered as a provider error later:
 *
 *   bad-destination  the endpoint is not a usable origin, or the bucket
 *                    or access key is empty.
 *   no-credential    nothing is escrowed for that origin, so this device
 *                    could address the bucket and never sign for it.
 */
class StoreError extends Error {
  constructor(readonly code: "bad-destination" | "no-credential", message: string) {
    super(message);
    this.name = "StoreError";
  }
}

// --- the OAuth ceremony -----------------------------------------------------
//
// THE WORKER RUNS THE OAUTH; THE PAGE RUNS THE POPUP (DRIVE.md §3) —
// the v2 shape STORAGE-EGRESS.md §5 parked, now built. The split falls
// on capability lines rather than on convenience: a window is a PAGE
// capability (the consent has to render in the provider's own pixels),
// while the verifier, the exchange and the tokens are the WORKER's,
// because a bearer must never exist in page memory or cross this port.
//
// WHAT CROSSES, THEREFORE: a URL out, and a one-shot authorization code
// plus its state back in. The code is allowed across and §3 says exactly
// why — it is a one-shot artifact, bound to a verifier that never left
// this global, consumed inside the ceremony. The bearer ban is about
// STANDING credentials, which a code is not.

/**
 * AN OAUTH CEREMONY REFUSAL — the worker's own condition, in the same
 * shape and for the same reason as `StoreError` above: an own `code`
 * property is what rpc.ts's `hostCodeOf` reads structurally, so it
 * crosses the port as a typed `{form:"host"}` failure and the client
 * branches on the code rather than on a message.
 *
 *   bad-ceremony     `oauthComplete` with no pending ceremony, or with a
 *                    state that is not the one this worker minted. Both
 *                    are the same finding — this answer does not belong
 *                    to this ceremony — and neither is retryable without
 *                    starting over.
 *   exchange-failed  the provider's token endpoint refused, or answered
 *                    without an access token. THE MESSAGE NAMES THE HTTP
 *                    STATUS AND NOTHING ELSE: a token-endpoint body can
 *                    echo the request it was sent, so quoting one into a
 *                    message — which is a thing that gets logged — could
 *                    put credential-shaped material somewhere it was
 *                    never meant to rest.
 */
class OauthError extends Error {
  constructor(readonly code: "bad-ceremony" | "exchange-failed", message: string) {
    super(message);
    this.name = "OauthError";
  }
}

/**
 * A PLATFORM REFUSAL — this browser cannot run the engine at all.
 *
 * Same shape and reason as `StoreError` and `OauthError` above: an own
 * `code` property is what rpc.ts's `hostCodeOf` reads structurally, so
 * it crosses the port as a typed `{form:"host"}` failure with its
 * sentence intact.
 *
 *   no-jspi   the global has no WebAssembly JS Promise Integration.
 */
class PlatformError extends Error {
  constructor(readonly code: "no-jspi", message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

/**
 * THE ONE PLATFORM FACT THE ENGINE CANNOT DO WITHOUT, asked BEFORE the
 * engine is built rather than discovered halfway through instantiating
 * it.
 *
 * The engine's kernel parks WebAssembly frames on host promises through
 * JSPI (runtime/engine.ts's note; engine/guest/src/persist.rs:24), and
 * JSPI availability is PER-GLOBAL (spikes/worker-host/README.md Q1) —
 * which is why the question is asked here, inside the SharedWorker that
 * actually instantiates, and not on the page that spawned it.
 *
 * WITHOUT THIS CHECK the absence is still fatal, but it surfaces as the
 * runtime's own mid-instantiation complaint: "needs JSPI (M2 phase 3):
 * synchronous lower of import 'wasi:filesystem/types@0.2.9/[method]
 * descriptor.open-at', whose host implementation returned a Promise".
 * True, and unreadable — it names the first import that happened to
 * suspend rather than the capability the browser is missing. Measured
 * 2026-08-23 against Playwright 1.57.0's Firefox 144 build, where JSPI
 * is off by default (see demo/e2e/run.ts's `FIREFOX_PREFS`).
 *
 * The sentence is written to read correctly with the boot path's own
 * `boot failed: ` prefix in front of it (demo/host/solo.ts).
 */
function requireJspi(): void {
  if (typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function") return;
  throw new PlatformError(
    "no-jspi",
    "this browser cannot run the engine: it has no WebAssembly JS Promise " +
      "Integration (WebAssembly.Suspending), which the engine's kernel needs " +
      "in order to park a guest call on a host promise",
  );
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** The minimal honest scope for a VISIBLE folder: files this app
 * created, and nothing else in the user's Drive (DRIVE.md §2). */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** The scope for the HIDDEN per-app space — narrower still than
 * `drive.file`, and that narrowing is the point (DRIVE.md §5): it can
 * reach the app-data folder and NOTHING in the user's own Drive at all,
 * not even files this app made there. The consent screen a user is
 * asked to read is correspondingly smaller, and the permission they
 * grant cannot be turned on their documents even by a bug. */
const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** THE SPACE PICKS THE SCOPE, which is why the space rides on
 * `OauthStartSpec` and not only on the binding: these are two different
 * permissions, asked for on two different consent screens, and a device
 * that consented to one cannot act in the other. */
function scopeForSpace(space: GdriveSpace): string {
  return space === "appdata" ? DRIVE_APPDATA_SCOPE : DRIVE_SCOPE;
}


/**
 * THE ONE PENDING CEREMONY, in memory only.
 *
 * One at a time, and a new `oauthStart` OVERWRITES it: two concurrent
 * consents are not a thing a user does, and when a second start arrives
 * it is because the first one was abandoned — the user closed the popup,
 * or the redirect never came back — so the NEWEST wins. Keeping the old
 * one alive instead would mean a restarted ceremony answering with a
 * state the worker has already replaced, which is the confusing
 * direction.
 *
 * It dies with the global, which is correct: a verifier that outlived
 * the worker would have to rest somewhere, and there is nothing to gain
 * from persisting half a ceremony.
 */
let pendingCeremony: { verifier: string; state: string; spec: OauthStartSpec } | null = null;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(n: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, "0")).join("");
}

/** Percent-encode one `application/x-www-form-urlencoded` value. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * BEGIN THE CONSENT (DRIVE.md §3). Mints the PKCE verifier, its S256
 * challenge and the state, keeps all three here, and hands back only the
 * authorization URL.
 *
 * THE URL IS PUBLIC DATA. Every parameter in it is app identity,
 * addressing, or the CHALLENGE — a hash, from which the verifier that
 * stays in this global cannot be recovered. That is what makes it safe
 * to hand to a page whose job is to open a popup on it.
 */
async function oauthStart(spec: OauthStartSpec): Promise<OauthStartResult> {
  // A ceremony that succeeded on a sealed device would end holding
  // tokens with nowhere sealed to put them, so it refuses at the front
  // rather than at the seal.
  if (!dek) {
    throw new SealError("no-rung", "the device is sealed; open it before connecting an account");
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = randomHex(16);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource),
  );
  const challenge = base64url(digest);
  pendingCeremony = { verifier, state, spec };
  const url = new URL(spec.authUrl ?? GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", spec.clientId);
  url.searchParams.set("redirect_uri", spec.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopeForSpace(spec.space));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // `offline` + `consent` together are what make Google issue a REFRESH
  // token rather than an access token alone — without one a device would
  // silently stop syncing an hour after its ceremony (DRIVE.md §4's
  // lazy-401 refresh has to have something to refresh WITH).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString() };
}

/**
 * FINISH THE CONSENT: exchange the page-relayed code, sealed the tokens
 * it buys (DRIVE.md §3).
 *
 * The exchange is THIS GLOBAL'S OWN `fetch` — the code and the verifier
 * meet here and nowhere else, and what comes back never leaves. Binding
 * is still `bindStore`'s job: consent and commitment stay two acts.
 */
async function oauthComplete(code: string, state: string): Promise<DeviceStatus> {
  if (!dek) {
    throw new SealError("no-rung", "the device is sealed; open it before connecting an account");
  }
  const pending = pendingCeremony;
  if (!pending) {
    throw new OauthError("bad-ceremony", "no consent ceremony is pending on this device");
  }
  if (state !== pending.state) {
    // Not the ceremony this worker minted. The two cases — a stale popup
    // answering after a restart, and a redirect that was never ours —
    // are indistinguishable from here and take the same refusal.
    throw new OauthError("bad-ceremony", "this consent answer does not match the pending ceremony");
  }
  const spec = pending.spec;
  const tokenUrl = spec.tokenUrl ?? GOOGLE_TOKEN_URL;
  const body = [
    `code=${formEncode(code)}`,
    `client_id=${formEncode(spec.clientId)}`,
    ...(spec.clientSecret ? [`client_secret=${formEncode(spec.clientSecret)}`] : []),
    `redirect_uri=${formEncode(spec.redirectUri)}`,
    "grant_type=authorization_code",
    `code_verifier=${formEncode(pending.verifier)}`,
  ].join("&");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status !== 200) {
    // THE STATUS, AND NOT ONE BYTE OF THE BODY. See `OauthError`.
    throw new OauthError("exchange-failed", `the token endpoint refused: HTTP ${res.status}`);
  }
  let parsed: { access_token?: string; refresh_token?: string };
  try {
    parsed = await res.json();
  } catch {
    throw new OauthError("exchange-failed", "the token endpoint answered with unreadable JSON");
  }
  const access = parsed.access_token ?? "";
  if (access === "") {
    throw new OauthError("exchange-failed", "the token endpoint answered without an access token");
  }
  const row: OauthRow = {
    access,
    clientId: spec.clientId,
    // THE SPACE THE CONSENT WAS ASKED FOR, sealed with the tokens it
    // bought: it is what the scope above was chosen from, so it is the
    // only honest record of what this consent actually permits, and
    // `settleGdrive` refuses a binding that disagrees with it.
    space: spec.space,
    obtainedAt: Date.now(),
  };
  if (parsed.refresh_token) row.refresh = parsed.refresh_token;
  if (spec.clientSecret !== undefined) row.clientSecret = spec.clientSecret;
  if (spec.tokenUrl !== undefined) row.tokenUrl = spec.tokenUrl;
  await writeOauth(dek, row);
  // The code was one-shot and is now spent; the verifier has nothing
  // left to be bound to.
  pendingCeremony = null;
  return await status();
}

/**
 * REFRESH WRITE-BACK (DRIVE.md §4): the owner seam refreshed behind our
 * back, so the sealed row has to catch up or a worker respawn would
 * resume on a token Google has already superseded.
 *
 * FIRE-AND-FORGET WITH A SWALLOWED CATCH, and both halves are
 * deliberate. `makeOwnerFetch` calls this synchronously in the middle of
 * a 401→refresh→retry, which is not a place to await IndexedDB and
 * certainly not a place to fail a storage call over a bookkeeping write.
 * The `if (dek)` guard is the reseal race stated rather than left to be
 * discovered: a refresh that lands while the device is being resealed
 * has nowhere sealed to write, and losing that write costs nothing —
 * the grant already carries the new token for this instance's lifetime,
 * and a device that has been resealed is going to re-read the row (or
 * refresh again) at its next unseal anyway.
 *
 * IT MERGES RATHER THAN OVERWRITES: the row is re-read first so the
 * clientId/clientSecret/tokenUrl the ceremony sealed survive, and a
 * ROTATED refresh token replaces the old one only when the provider
 * actually issued one.
 */
function onTokenRefreshed(token: string, refreshToken?: string): void {
  const key = dek;
  if (!key) return;
  void (async () => {
    const row = await readOauth(key);
    if (!row) return;
    row.access = token;
    if (refreshToken) row.refresh = refreshToken;
    row.obtainedAt = Date.now();
    await writeOauth(key, row);
  })().catch(() => {});
}

/**
 * DISCONNECT THE ACCOUNT (DRIVE.md §4) — the honest disconnect, and the
 * only place revocation belongs.
 *
 * THE REVOKE IS BEST-EFFORT BY DESIGN AND GOES FIRST. The DELETION is
 * the act; telling the provider is courtesy, and a courtesy that cannot
 * be completed (offline, an already-invalid token, a fake with no such
 * endpoint) must never leave the row sitting here undeleted. So every
 * failure is swallowed, and it is attempted first only because a token
 * that has already been deleted cannot be revoked afterwards.
 *
 * THE BINDING ROW STAYS. Forgetting the account is not forgetting the
 * destination — the exact mirror of `unbindStore` keeping the escrow
 * (STORAGE-EGRESS.md §6). What does go immediately is the in-memory
 * grant: a bearer must not outlive the consent it came from.
 */
async function forgetOauth(): Promise<DeviceStatus> {
  if (!dek) {
    throw new SealError("no-rung", "the device is sealed; open it before disconnecting an account");
  }
  const row = await readOauth(dek);
  if (row) {
    const revokeUrl = row.tokenUrl
      ? new URL("/revoke", row.tokenUrl).toString()
      : GOOGLE_REVOKE_URL;
    try {
      await fetch(revokeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${formEncode(row.refresh ?? row.access)}`,
      });
    } catch { /* best-effort: see the doc comment */ }
  }
  await sealedDelete(ns, OAUTH_KEY);
  clearGrant();
  return await status();
}

/**
 * BIND THIS DEVICE TO A BUCKET — the worker half of the storage
 * ceremony (STORAGE-EGRESS.md §§2-4). The page half escrowed the secret
 * before calling; what arrived here is addressing and a public
 * identifier.
 *
 * The order is chosen so a failure leaves nothing half-armed: everything
 * fallible and cheap is checked first, the binding is PERSISTED before
 * the grant is armed (a bind that survives the answer but not the disk
 * would come back unbound at the next unseal, which is the confusing
 * direction), and `initStore` re-points the LIVE engine last — the same
 * call `bringUpEngine` makes for a device that was already bound.
 */
async function bindStore(binding: StoreBinding): Promise<DeviceStatus> {
  // Sealed means no DEK to seal the binding under and no engine to
  // re-point; the file's idiom for "open it first" is a `SealError
  // "no-rung"`, and clients already branch on that code.
  if (!dek || !engine) {
    throw new SealError("no-rung", "the device is sealed; open it before binding storage");
  }
  const stored = await settleBinding(binding, dek);
  // A THROW FROM HERE LEAVES THE BINDING SEALED AND THE GRANT ARMED
  // while the live instance still has no addressing — self-consistent
  // rather than half-open (the seams refuse or the engine does, and
  // nothing writes anywhere unintended), and the next bring-up repairs
  // it by re-applying the same config. Rolling the seal back instead
  // would throw away a binding the user correctly entered because one
  // engine call failed.
  await engine.driver.initStore(storeConfigOf(stored));
  // A DESTINATION EXISTS AGAIN, SO THE SCHEDULE DOES. `clearGrant` stops
  // it at every unbind/reseal/erase, so a bind is the matching arm: a
  // device that has just been pointed at a bucket should sync on its own
  // without waiting for a reload. At the ORDINARY cadence, never the
  // boot pull's — see `rearmSyncSchedule`.
  rearmSyncSchedule();
  return await status();
}

/**
 * THE `initStore` CONFIG FOR A SETTLED BINDING — one spelling, used by
 * `bindStore`, by every bring-up's re-apply, and by the restore (where
 * it is a PARAMETER of `recovery-restore-*` rather than a call, because
 * finding the bundle needs the destination before any engine state
 * exists — engine.wit's `recovery-restore-bucket`).
 *
 * ADDRESSING ONLY, on every arm. The gdrive arm carries no credential
 * at all, not even a public identifier; the S3 arm carries the access
 * key, which is a public identifier that travels in the Authorization
 * header in clear.
 */
function storeConfigOf(b: StoreBinding): StoreConfig {
  return b.kind === "gdrive"
    ? {
      kind: "gdrive",
      // The space rides on the sealed binding, so every re-apply
      // restores the SAME space the bind chose — a default here would
      // silently move the store.
      value: { root: b.root, apiBase: b.apiBase, space: b.space },
    }
    : {
      kind: "s3",
      value: { endpoint: b.endpoint, bucket: b.bucket, accessKey: b.accessKey },
    };
}

/**
 * VALIDATE A BINDING AND MAKE IT THIS DEVICE'S, minus the engine.
 *
 * The fail-at-bind half of `bindStore`, factored out because the RESTORE
 * needs exactly it and nothing else: a restore has no engine to
 * `initStore` (that is the point — the config is a parameter of the
 * restore call), but it must run the same refusals, in the same order,
 * before it fetches anything. Two copies of the destination checks would
 * be two places for the escrow rules to drift.
 *
 * Everything fallible and cheap is checked first, and the binding is
 * PERSISTED before the grant is armed — a bind that survives the answer
 * but not the disk would come back unbound at the next unseal, which is
 * the confusing direction.
 */
async function settleBinding(binding: StoreBinding, key: CryptoKey): Promise<StoreBinding> {
  if (binding?.kind === "gdrive") return await settleGdrive(binding, key);
  if (binding?.kind !== "s3") {
    // The two arms this host binds are S3 and Google Drive. DROPBOX is
    // still parked for the worker and the reason is unchanged
    // (STORAGE-EGRESS.md §5): its bearer would have to cross this port
    // at deposit. Drive is not the exception to that rule — it is the
    // rule honoured, because the worker runs the ceremony itself and the
    // bearer is born on this side (DRIVE.md §3).
    throw new StoreError("bad-destination", "this host binds s3 or gdrive destinations only");
  }
  const origin = normalizeOrigin(binding.endpoint);
  if (origin === null) {
    throw new StoreError(
      "bad-destination",
      `storage endpoint is not a usable origin: ${binding.endpoint}`,
    );
  }
  if (binding.bucket.trim() === "" || binding.accessKey.trim() === "") {
    throw new StoreError("bad-destination", "a storage binding needs a bucket and an access key");
  }
  // THE SIGNING AUTHORITY COMES FROM THE KEYSTORE, NOT FROM THE
  // BINDING, and its absence is a refusal HERE — the demo's own rule
  // (demo.ts:1275-1283: "saying so plainly beats discovering it as a 403
  // twenty provider calls later"). The read is by destination origin,
  // which is the escrow's key: profile-tier, destination-bound, shared
  // by every device on the origin (§2).
  const held = await getSigningKey(origin);
  if (!held) {
    throw new StoreError(
      "no-credential",
      `no signing credential escrowed for ${origin} — enter the secret key in the storage sheet first`,
    );
  }
  // THE ESCROW IS KEYED BY ORIGIN, BUT IT SIGNS FOR ONE ACCESS KEY.
  // `SigningRecord` keeps the public identifier beside the handle
  // (keystore.ts:37-47) precisely so this can be checked: a REBIND that
  // changed the access key without a fresh secret would find the OLD
  // record, pass the existence check above, and then sign every request
  // with the wrong key's derivation — a provider 403 twenty calls later,
  // which is exactly the outcome §4's fail-at-bind rule exists to
  // prevent. From the user's side it is the same condition as "nothing
  // escrowed" (this browser cannot sign for that destination), so it
  // takes the same code.
  if (held.accessKey !== binding.accessKey) {
    throw new StoreError(
      "no-credential",
      `the secret this browser holds for ${origin} was escrowed for a different access key — ` +
        `re-enter the secret key for ${binding.accessKey}`,
    );
  }
  const stored: StoreBinding = {
    kind: "s3",
    endpoint: binding.endpoint,
    bucket: binding.bucket,
    accessKey: binding.accessKey,
  };
  await sealedPut(ns, key, STORE_BINDING_KEY, new TextEncoder().encode(JSON.stringify(stored)));
  await applyBinding(stored);
  return stored;
}

/**
 * VALIDATE A DRIVE BINDING AND MAKE IT THIS DEVICE'S (DRIVE.md §5) —
 * the gdrive arm of `settleBinding`, and the same shape of thing.
 *
 * The refusals mirror the S3 arm's one-for-one, because they are the
 * same rule wearing this provider's vocabulary: everything that can be
 * known at bind time is settled at bind time, never discovered as a
 * provider 403 twenty calls later (STORAGE-EGRESS.md §4).
 *
 *   bad-destination  an empty root or client id, or an apiBase that is
 *                    not a usable origin.
 *   no-credential    no sealed consent rests on this device, or the one
 *                    that does was granted to a DIFFERENT client id, or
 *                    for a DIFFERENT SPACE. Both mismatch cases are the
 *                    access-key-mismatch rule's exact analog (§4, and
 *                    the S3 arm above): the `drive.file` scope confines
 *                    visibility PER CLIENT ID (DRIVE.md §2), so binding
 *                    a root under a client id the consent was not
 *                    granted to would produce a store whose own objects
 *                    are invisible to it — and the SPACE selects the
 *                    scope itself (DRIVE.md §5), so a consent for the
 *                    other space is a consent to a different permission
 *                    entirely.
 */
async function settleGdrive(
  binding: Extract<StoreBinding, { kind: "gdrive" }>,
  key: CryptoKey,
): Promise<StoreBinding> {
  if (binding.root.trim() === "" || binding.clientId.trim() === "") {
    throw new StoreError("bad-destination", "a Drive binding needs a root folder and a client id");
  }
  const origin = normalizeOrigin(binding.apiBase);
  if (origin === null) {
    throw new StoreError(
      "bad-destination",
      `the Drive API base is not a usable origin: ${binding.apiBase}`,
    );
  }
  const row = await readOauth(key);
  if (!row) {
    throw new StoreError(
      "no-credential",
      "no Google account is connected on this device — run the Google Drive consent first",
    );
  }
  if (row.clientId !== binding.clientId) {
    throw new StoreError(
      "no-credential",
      `the consent this device holds was granted to a different client id — ` +
        `run the consent again for ${binding.clientId}`,
    );
  }
  if (row.space !== binding.space) {
    // THE SPACE MISMATCH, and it is the client-id mismatch above
    // wearing the scope's vocabulary rather than the visibility's: the
    // consent this device holds was granted for a DIFFERENT PERMISSION
    // (`drive.appdata` vs `drive.file` — see `scopeForSpace`), so this
    // browser cannot act for that destination at all. Same rule as
    // STORAGE-EGRESS.md §4's access-key mismatch: settle it at bind,
    // never as a provider 403 twenty calls later.
    throw new StoreError(
      "no-credential",
      `the consent this device holds was granted for a different Drive space ` +
        `(${row.space}, not ${binding.space}) — that is a different permission, so ` +
        `run the consent again for ${binding.space}`,
    );
  }
  const stored: StoreBinding = {
    kind: "gdrive",
    root: binding.root,
    apiBase: binding.apiBase,
    clientId: binding.clientId,
    space: binding.space,
  };
  await sealedPut(ns, key, STORE_BINDING_KEY, new TextEncoder().encode(JSON.stringify(stored)));
  await applyBinding(stored);
  return stored;
}

/**
 * FORGET THE DESTINATION (STORAGE-EGRESS.md §6).
 *
 * The sealed binding goes and the grant is emptied IMMEDIATELY, so every
 * seam refuses from the next call onward. The live engine instance keeps
 * the addressing `initStore` gave it until the next bring-up — there is
 * no un-init on the driver — and that is deliberately not chased: an
 * instance that still knows an address and can no longer reach it is the
 * enforced property, and it is the one the matrix checks.
 *
 * THE ESCROW IS NOT TOUCHED. It is profile-tier and destination-bound,
 * shared with every other device on this origin, and deleting it here
 * would take their signing with it. Erasing it is the erase ceremony's
 * job (keystore.ts's `eraseKeystore`).
 *
 * NEITHER IS THE SEALED DRIVE CONSENT, for the same shape of reason
 * (DRIVE.md §4): forgetting the destination is not forgetting the
 * account. Deleting that row is `forgetOauth`'s job, and it is a
 * ceremony a user asks for by name.
 */
async function unbindStore(): Promise<DeviceStatus> {
  if (!dek) {
    throw new SealError("no-rung", "the device is sealed; open it before unbinding storage");
  }
  await sealedDelete(ns, STORE_BINDING_KEY);
  clearGrant();
  return await status();
}

// --- the engine -------------------------------------------------------------

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

/**
 * The device's TRANSPORT key pair, cached on the same terms and for the
 * same reasons as the signing one above — and a genuinely separate pair
 * (identity-keys.ts's `DEVICE_ENDPOINT_KEY`, engine.wit's
 * `endpoint-key-pair`): iroh's endpoint id is this key's public half,
 * and no key crosses between keyhive's signatures and iroh's handshake.
 */
let endpointPair: Promise<CryptoKeyPair> | undefined;

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

function endpointKey(): Promise<CryptoKeyPair> {
  endpointPair ??= loadOrMintIdentity(ns, DEVICE_ENDPOINT_KEY)
    .then((r) => r.pair)
    .catch((e) => {
      endpointPair = undefined;
      throw e;
    });
  return endpointPair;
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
    // THE ENDPOINT ID SURVIVES THE RELOAD, which is the point: this
    // device's iroh address is derived from a key that lives in the
    // device namespace, so a peer that recorded the id can still dial it
    // after both sides have been closed and reopened. Fresh wrappers per
    // instance for the registry-identity reason in this function's
    // header; the underlying `CryptoKeyPair` is the cached one.
    endpointKeyPair: async () => {
      const pair = await endpointKey();
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
 *
 * WITH A `restore` PLAN THERE IS NEITHER (RECOVERY.md, "Restore"): the
 * engine is born from the kit, so `stateResume()`'s answer becomes a
 * guard and `init` never runs. Everything AFTER the guest's restore —
 * the pull fan-out, the first checkpoint, the consume — belongs to
 * `restore()` below rather than here, because none of it is bring-up:
 * it is the ceremony's own tail, and it needs the published engine and
 * the schedule that this function's callers arm.
 */
async function bringUpEngine(restore?: RestorePlan): Promise<void> {
  if (engine) return;
  requireJspi();
  if (!attached) throw new Error("device-store: the host was never attached (no engine artifacts)");
  if (!dek) throw new SealError("no-rung", "the device is sealed");

  const dir = await ns.directory();
  // THE BINDING IS READ AND APPLIED BEFORE THE ENGINE EXISTS, which is
  // safe because the seams read the grant AT CALL TIME: they close over
  // the object, not over a snapshot of its contents, so arming it early
  // and instantiating over it is the same wiring either way. Doing it
  // here rather than after also means there is no window in which a
  // resumed engine could reach a seam that has not caught up yet.
  //
  // `sealedGet` throws `SealError "tampered"` for a row that is present
  // and does not open. It is left to PROPAGATE: unseal's atomic rollback
  // is right above us and will put the device back to sealed rather than
  // leave it half open, and a binding that has been altered underneath
  // the DEK is a finding worth surfacing at the ceremony that touched it.
  const binding = await readBinding(dek);
  if (binding) await applyBinding(binding);
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
    // The instance's storage authority, and all of it (#7): three named
    // seams plus the signer, over this global's one grant. While the
    // grant is empty every one of them refuses by name.
    {
      ownerFetch: makeOwnerFetch(storeGrant, onTokenRefreshed),
      publicFetch: makePublicFetch(storeGrant),
      sharedFetch: makeSharedFetch(storeGrant),
      signer: wiredSigner,
    },
    sealed as unknown as PersistDir,
    deviceIdentityFragment(),
  );

  resumed = await e.driver.stateResume();
  if (restore) {
    // THE RESTORE BRING-UP (RECOVERY.md, "Restore"): the engine is born
    // from the KIT, so there is neither a resume nor an `init` here.
    //
    // `stateResume()` still ran, and its answer is a GUARD rather than a
    // step: a namespace with something to resume is not a fresh device,
    // and restoring over it would strand whatever it held behind an
    // identity that no longer matches the manifest. `restore()`'s
    // pre-checks refuse that case before we ever get here; this is the
    // last line of it, checked against the engine's own answer rather
    // than against our bookkeeping.
    if (resumed) {
      throw new StoreError(
        "bad-destination",
        "this namespace already holds a device: a restore needs a fresh one",
      );
    }
    // THE CONFIG IS A PARAMETER, NOT `initStore` STATE, and the ordering
    // is the reason (engine.wit's `recovery-restore-bucket`): finding
    // the bundle needs the destination FIRST, and the destination cannot
    // be read out of the account document the bundle is what unlocks. So
    // the guest fetches through config-parameterized helpers before any
    // engine state exists and applies the same config as `init-store`
    // would once it does — which is why the `if (binding)` re-apply
    // below is skipped on this path rather than merely redundant.
    const agent = restore.kit.kind === "bucket"
      ? await e.driver.recoveryRestoreBucket(
        storeConfigOf(restore.binding),
        restore.kit.phrase,
        restore.deviceName,
      )
      : await e.driver.recoveryRestoreFile(
        storeConfigOf(restore.binding),
        restore.kit.bundle,
        restore.kit.passphrase,
        restore.deviceName,
      );
    // The fresh-init path's write, for the fresh-init path's reason: an
    // agent id is a public key, the sweep and the picker read it before
    // anything is open, and the SYNC SCHEDULER needs it in order to tell
    // this device apart from its siblings in the account directory
    // (`pullCycle`'s self-filter). A restored device that never recorded
    // it would fan out pulls against ITSELF.
    await ns.put("meta", AGENT_KEY, agent);
    engine = e;
    return;
  }
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

  // THE STORE CONFIG IS RE-APPLIED, EVERY BRING-UP, BY US. It is not in
  // the checkpoint and that is a decision, not an omission:
  // engine/guest/src/persist.rs:611-614 records store config as
  // "embedder-supplied addressing, re-applied by the embedder" — and in
  // this deployment the worker IS the embedder. So it goes after
  // `stateResume()`/`init` (there is no engine state to configure before
  // one of those has run) and before the instance is published below, so
  // no client can reach an engine that knows its bucket's seams but not
  // its address. A device therefore returns to its bucket on every
  // unseal with no page-side state and nothing re-entered (§3).
  if (binding) {
    await e.driver.initStore(storeConfigOf(binding));
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

// --- the restore bring-up (RECOVERY.md, "Restore") --------------------------
//
// A FRESH DEVICE NAMESPACE WHOSE ENGINE IS BORN FROM A KIT. The whole of
// what makes it different from an ordinary bring-up is stated in
// engine.wit's `recovery-restore-bucket` doc comment and in RECOVERY.md;
// what lives here is the ORDER, and the order is the design:
//
//   1. THE BINDING, settled with `bindStore`'s own fail-at-bind
//      discipline (`settleBinding` — shared code, not a second copy).
//      Everything knowable is settled before a single byte is fetched.
//   2. THE ENGINE, wired to the seams over the just-armed grant, with NO
//      `stateResume` and NO `init` — `bringUpEngine`'s restore arm.
//   3. THE GUEST'S RESTORE, which fetches (or is handed) the bundle,
//      adopts the us partition, takes the K_p pickup and writes this
//      device's own entry under the ceremony's name.
//   4. THE PULL FAN-OUT, US-DOC FIRST. The guest's own pull bootstrapped
//      the account; this is the ordinary account pull path (SYNC.md §2),
//      run once eagerly so the restored device has CONTENT and not only
//      membership. It is the worker's existing machinery on purpose —
//      RECOVERY.md keeps the content fan-out out of the guest so there
//      is one account pull path rather than two.
//   5. THE FIRST CHECKPOINT, so a device that is restored and then
//      reloaded before anyone touches it comes back as itself.
//   6. THE CONSUME, LAST AND NEVER FATAL. engine.wit: "called by the
//      embedder AFTER the content fan-out and the first checkpoint
//      succeed — not before: a consume that raced the restore would burn
//      the kit for a restore that had not landed."
//
// THE RESTORED DEVICE IS T0. Promotion is the user's own later act
// (PERSISTENCE.md's try-then-keep), so nothing here touches the index
// row's tier: a restore is not a decision to keep the machine it ran on.

interface RestorePlan {
  binding: StoreBinding;
  kit: RecoveryKitInput;
  deviceName: string;
}

/**
 * RUN ONE CEREMONY WITH THE STORE TO ITSELF.
 *
 * `call()` does this for every client-initiated bucket op it dispatches
 * (see `clientBucketOps`), but the recovery ceremonies arrive on the
 * HOST surface, which never passes through it — so they hold the same
 * claim explicitly. Without it a 45-second pull cycle could land in the
 * middle of a restore and pull against an engine that is still being
 * born. The counter is released in `finally`, because a REFUSED
 * ceremony must not leave the scheduler muted for the life of the
 * worker.
 */
async function holdingStore<T>(body: () => Promise<T>): Promise<T> {
  clientBucketOps++;
  try {
    return await body();
  } finally {
    clientBucketOps--;
  }
}

/**
 * OPEN A FRESH NAMESPACE WITHOUT INITING AN ENGINE — the restore path's
 * first stage, and the one thing `unseal` cannot do (it inits).
 *
 * IT EXISTS FOR THE DRIVE CONSENT. `oauthStart`/`oauthComplete` seal
 * tokens under the DEK, so they refuse on a sealed device — and a gdrive
 * restore needs its consent BEFORE the binding it is about to validate.
 * The S3 arm needs no such stage: its escrow is page-side and keyed by
 * destination origin, so `restore()` alone is the whole ceremony there.
 *
 * IDEMPOTENT, and refuses a namespace that already holds a device: this
 * is a door into a device that has not been born yet, and it must never
 * become a second way to open one that has.
 */
async function restorePrepare(opts: UnsealOptions = {}): Promise<DeviceStatus> {
  if (engine) {
    throw new StoreError(
      "bad-destination",
      "this device is already running: a restore needs a fresh namespace",
    );
  }
  await refuseUnlessFresh();
  if (!dek) {
    const record = await getDevice(DEVICE_ID);
    if (!record) {
      throw new SealError("no-rung", `device-store: no device ${DEVICE_ID} in the index`);
    }
    const rungs = await sealState(ns);
    // A namespace with rungs has been sealed before, which means a DEK
    // was minted for it — and `refuseUnlessFresh` has already established
    // that no ENGINE state rests under it. Climbing rather than minting
    // a second one is `unseal`'s rule and its reason (a second DEK
    // silently orphans everything sealed under the first).
    dek = (!rungs.passphrase && !rungs.untilReseal && !rungs.prf)
      ? await firstSeal(record.tier, opts)
      : await climbRung(record.unsealPolicy, rungs, opts);
  }
  return await status();
}

/**
 * "A RESTORE NEEDS A FRESH NAMESPACE", checked rather than assumed.
 *
 * The agent id in unsealed `meta` is the honest witness: it is written
 * exactly once, on the fresh-init path and on the restore path, and it
 * is readable WITHOUT the DEK — so this refusal works on a device
 * nobody has opened yet, which is precisely when a client would be
 * about to make the mistake.
 */
async function refuseUnlessFresh(): Promise<void> {
  const agent = await ns.get<string>("meta", AGENT_KEY);
  if (agent) {
    throw new StoreError(
      "bad-destination",
      "this namespace already holds a device — restore into a fresh one " +
        "(a restore is a new device, never an overwrite)",
    );
  }
}

/**
 * RESTORE THIS DEVICE FROM A RECOVERY KIT.
 *
 * The secret discipline, stated where it is implemented: `spec.kit`
 * carries the phrase (or the file's passphrase), it is handed to the
 * guest, and the local references are dropped in `finally`. Nothing
 * writes it to the namespace, the checkpoint, the bucket or a log, and
 * `status()` has nowhere to echo it. HONESTLY BEST-EFFORT: dropping a
 * reference is not scrubbing a heap — the string was cloned across the
 * port and neither realm can erase the other's copy — but it is the
 * same promise `UnsealOptions.passphrase` makes and it is kept the same
 * way.
 */
async function restore(spec: RestoreSpec): Promise<DeviceStatus> {
  return await holdingStore(() => restoreCeremony(spec));
}

async function restoreCeremony(spec: RestoreSpec): Promise<DeviceStatus> {
  if (engine) {
    throw new StoreError(
      "bad-destination",
      "this device is already running: a restore needs a fresh namespace",
    );
  }
  await refuseUnlessFresh();
  if (!dek) await restorePrepare(spec.unseal ?? {});
  const key = dek;
  if (!key) throw new SealError("no-rung", "the device is sealed; there is nothing to restore into");
  const kit = spec.kit;
  try {
    // 1. THE DESTINATION, on `bindStore`'s terms and before anything is
    //    fetched. A missing escrow or a mismatched access key is a
    //    refusal HERE rather than a provider 403 in the middle of a
    //    ceremony that has already minted half a device.
    const binding = await settleBinding(spec.binding, key);
    // 2-3. The engine, and the guest's restore inside it.
    try {
      await bringUpEngine({ binding, kit, deviceName: spec.deviceName });
    } catch (e) {
      // `unseal`'s atomic rollback, for `unseal`'s reason: a half-open
      // device — key held, no engine, `status()` claiming unsealed — is
      // the state this whole discipline exists to forbid. The binding
      // stays sealed in the namespace (the user entered it correctly and
      // a retry should not re-ask), but the grant goes: armed seams with
      // no engine are authority with nothing to authorize.
      dek = null;
      engine = null;
      resumed = null;
      clearGrant();
      throw e;
    }
    const live = engine as unknown as Engine;
    // 4. THE CONTENT FAN-OUT, us-doc first. Failures are TOLERATED and
    //    left to the schedule: a sibling that has not flushed, or a
    //    partition whose objects are not there yet, is absence — and a
    //    restore that refused over it would throw away an account it has
    //    already successfully rebuilt. The ordinary cycle retries.
    await restoreFanOut(live);
    // 5. The first checkpoint. This one is NOT tolerated: without it a
    //    reload before the debounce fires would find a namespace with an
    //    agent id and no state, which is the one shape nothing recovers
    //    from.
    await checkpoint();
    // 6. THE CONSUME, and its failure is an announcement rather than a
    //    refusal — see `settleConsume`.
    await settleConsume(live);
    // The schedule starts at the END, `unseal`'s placement and for
    // `unseal`'s reason: the engine is published and `status()` is
    // answerable, and this only arms timers.
    startSyncSchedule();
    return await status();
  } finally {
    // The secret's last local reference. See this function's header for
    // what that is and is not worth.
    if (kit.kind === "bucket") kit.phrase = "";
    else {
      kit.passphrase = "";
      kit.bundle = new Uint8Array(0);
    }
  }
}

/**
 * THE RESTORED DEVICE'S FIRST PULL — the account pull path (SYNC.md §2)
 * run once, eagerly, instead of waiting out a cadence.
 *
 * US-DOC FIRST AND THEN THE POINTER MAP, in that order and re-read
 * between: the us-doc's content IS the pointer map, so a fan-out that
 * read the map first would fan out over whatever the guest's own
 * bootstrap pull happened to leave and miss every partition a sibling
 * added since.
 *
 * IT ADOPTS BEFORE IT PULLS, and only here. `adoptPartition` REPLACES
 * whatever this device held for that id with an empty document
 * (engine/guest/src/lib.rs, and solo.ts:3100's contract note), so it is
 * only ever safe on a device that demonstrably held nothing — which is
 * the definition of the device this function runs on, and is why this
 * lives in the restore rather than in the ordinary `pullCycle`.
 */
async function restoreFanOut(live: Engine): Promise<void> {
  await pullUsDoc(live, await siblingsOf(live));
  const parts = await syncScope(live);
  if (parts === null) return;
  const siblings = await siblingsOf(live);
  for (const part of parts) {
    try {
      await live.driver.adoptPartition(part.id);
    } catch {
      // A partition this device cannot adopt is one it is not a member
      // of, or one the guest already holds. Neither is a reason to stop
      // the ones after it.
      continue;
    }
    for (const sib of siblings) {
      // Owner tier between two devices of one account, so no pickup —
      // `pullCycle`'s argument verbatim.
      await live.driver.bucketPull(part.id, sib.agentId, undefined).catch(() => {});
    }
  }
}

/**
 * CONSUME THE KIT, AND NEVER FAIL THE RESTORE OVER IT (RECOVERY.md:
 * "consume failures … never block the restore: they announce and retry
 * on the flush cadence's backoff loop").
 *
 * The announcement is the SCHEDULER'S OWN SURFACE rather than a new one:
 * the failure counts as a flush-direction failure, so it escalates
 * toward the announce-after-three threshold, leaves its sentence in
 * `lastError`, and is retried on the same jittered backoff. The one
 * thing that count cannot say — WHAT is outstanding — is
 * `SyncStatus.consumePending`.
 */
async function settleConsume(live: Engine): Promise<void> {
  try {
    await consumeAndCheckpoint(live);
  } catch (e) {
    consumePending = true;
    const delay = noteSyncOutcome("flush", e);
    armFlush(delay, false);
  }
}

/**
 * CONSUME, THEN CHECKPOINT — and the checkpoint is not bookkeeping, it
 * is what keeps the consume from being UNDONE by the next respawn.
 *
 * THE STRAND HAZARD, in full, because it cost a track to find. The
 * consume's last act inside the guest is `recovery_clear` — a write to
 * the LIVE us-doc — followed by the guest's own `bucket_flush(us)`.
 * Both landed; neither survives a worker death, and here is why each
 * half fails to save the other:
 *
 *   * THE CHECKPOINT NEVER ARMS ITSELF. The debounce hooks live in
 *     `call()`, which is the dispatcher for CLIENT requests only. Every
 *     driver call this file makes internally — the fan-out, the flush
 *     cycles, this consume — goes straight to `engine.driver` and arms
 *     nothing. So a mutation made after a sequence's last checkpoint is
 *     simply not in any checkpoint, and a respawn resumes the state as
 *     it was BEFORE the consume: the spent kit back in the account's
 *     registry, on the one device most likely to be looking at it.
 *   * THE BUCKET COPY IS OUT OF ITS OWN REACH. The clear WAS flushed —
 *     under THIS device's own keyed object names — and `pullCycle`
 *     self-filters the device out of its own sibling fan-out (a device
 *     does not pull from itself). So the flushed clear is durable and
 *     permanently invisible to every future resume of its author. It
 *     heals only when some OTHER device pulls it and re-manifests it,
 *     which is exactly what the account that just used its last-resort
 *     kit does not have.
 *
 * The record's checkpoint-BEFORE-consume ordering stays as it is: a
 * crash between the consume and a FIRST checkpoint would burn the kit
 * with nothing durable to show for it, which is a lockout. So this is a
 * SECOND checkpoint, after the fact, and the first one is untouched.
 *
 * `consumePending` IS CLEARED LAST, after the checkpoint has landed.
 * A checkpoint that fails leaves the obligation standing and the retry
 * runs the whole thing again — which is safe precisely because
 * `recovery-consume` is idempotent by contract (absence is success), so
 * a second pass over an already-consumed kit succeeds and reaches the
 * checkpoint that failed the first time.
 */
async function consumeAndCheckpoint(live: Engine): Promise<void> {
  await live.driver.recoveryConsume();
  // Through `checkpoint()`, never `stateCheckpoint()` directly: that is
  // the file's serialization point for checkpoints (they queue against
  // each other on `checkpointChain` and against nothing else), and it is
  // what keeps `lastCheckpoint` honest in `status()`.
  await checkpoint();
  consumePending = false;
}

/**
 * MINT A RECOVERY KIT (RECOVERY.md, "The kit ceremony").
 *
 * The guest owns every refusal that matters — no bound store, no
 * account, a bucket kit on a provider that cannot address objects by
 * name — and they arrive as ordinary engine errors through the typed
 * failure path. Nothing here second-guesses them.
 *
 * THE FAN-OUT IS STEP 6 AND IT IS PART OF THE CEREMONY, not a
 * background nicety: "the worker then flushes the us-doc and every named
 * partition, so the kit is valid the moment the ceremony reports
 * success". The guest flushes the us-doc itself (`publish_account`); the
 * PARTITIONS are ours, because a kit whose account names a partition the
 * bucket has never seen restores an account with no content.
 *
 * A FAILED FAN-OUT DOES NOT UNMAKE THE KIT — the device is enrolled and
 * the phrase is already minted, so refusing here would hand back nothing
 * for a kit that exists. It leaves the ordinary flush schedule armed and
 * the failure visible where every other flush failure is.
 */
async function createRecoveryKit(spec: RecoveryKitSpec): Promise<RecoveryKitResult> {
  const out = await holdingStore(() => kitCeremony(spec));
  // THE FAN-OUT IS OUTSIDE THE HOLD, and it has to be: `syncFlushNow`
  // runs the scheduler's OWN cycle, and `syncMayRun` refuses to run one
  // while a client bucket op is outstanding. Holding the store across
  // it would silently turn ceremony step 6 into a no-op — which is the
  // "kit that looks valid and is not" the step exists to prevent.
  await syncFlushNow();
  // AND A CHECKPOINT, for `consumeAndCheckpoint`'s reason exactly. This
  // ceremony reaches the engine from the HOST surface (`callHost`), not
  // through `call()`, so nothing here arms the mutation debounce — and
  // what it just wrote is a minted device, an epoch rotation, a K_p
  // grant and the account's `recovery` row. All of it went to the bucket
  // under THIS device's own keyed names, which the pull fan-out
  // self-filters, so a respawn before some unrelated client mutation
  // happened to arm a checkpoint would resume an account that has never
  // heard of the kit whose phrase the user has just written down.
  //
  // SWALLOWED, and the swallow is the same ruling the fan-out above
  // takes: the kit EXISTS and the phrase is minted and returned once, so
  // rejecting here would hand back nothing for a kit that is real, and
  // a caller retrying would mint a second one. A failed local checkpoint
  // is a device in trouble for other reasons, and the next mutation's
  // debounce catches up.
  await checkpoint().catch(() => {});
  return out;
}

async function kitCeremony(spec: RecoveryKitSpec): Promise<RecoveryKitResult> {
  if (!engine) {
    throw new SealError("no-rung", "the device is sealed; open it before creating a recovery kit");
  }
  const live = engine;
  let out: RecoveryKitResult;
  if (spec.kind === "bucket") {
    out = { kind: "bucket", phrase: await live.driver.recoveryKitCreateBucket(spec.label) };
  } else {
    try {
      out = {
        kind: "file",
        bundle: await live.driver.recoveryKitCreateFile(spec.label, spec.passphrase),
      };
    } finally {
      spec.passphrase = "";
    }
  }
  return out;
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

// --- the sync schedule ------------------------------------------------------
//
// THE WORKER OWNS THE SCHEDULE (runtime/SYNC.md §3), for the reason it
// owns the checkpoint cadence: it owns the engine and the binding, and
// it outlives tabs. A page that scheduled its own flushes would stop
// syncing when the user switched tabs, and two tabs would schedule two.
//
// FLUSH is the CHECKPOINT'S SLOWER SIBLING and is armed by exactly the
// same event — a non-readonly dispatch through `call()` below — with a
// ~20 s trailing debounce instead of 500 ms. The two timers are
// INDEPENDENT: a checkpoint is a local write and wants to be prompt, a
// flush is a network round trip against a provider with rate limits and
// wants to be far from the hot-file heuristics (SYNC.md §3 records the
// 2026-08-23 measurement: one flush ≈ 750 quota units against
// 325k/min/user, so the binding limit is the per-file write rate, not
// the quota). Plus the two moments the checkpoint already honours:
// last-client-disconnect, and before reseal — with ONE asymmetry, called
// out at that call site.
//
// PULL is a DUMB TIMER, on purpose (SYNC.md §2: "the scheduler just
// calls `bucketPull`; cheapness-when-idle lives INSIDE the provider
// strategy"). One cycle at bring-up behind readiness, then every 45 s
// while unsealed. Nothing in here inspects a change board, counts
// requests, or decides a pull is unnecessary — if that logic ever grows
// a bug, this file is not where it lives.
//
// THE CYCLES MUTATE CHECKPOINTED STATE AND ARM NO CHECKPOINT, and that
// is recorded rather than fixed. A flush or a pull writes the guest's
// per-doc bucket state (#93: the name-key chain and the flushed-chunk
// map are in the checkpoint), and these calls are INTERNAL — `call()`'s
// debounce hooks are for client requests only — so a cycle's work is not
// checkpointed until some unrelated mutation happens to arm one. It is
// the same shape as the hazard `consumeAndCheckpoint` exists for, and it
// is left alone because the consequence is not the same: this state
// SELF-HEALS. The chain is re-read from the account document
// (`ensure_bucket_state`'s case 1, since SYNC.md §1 made the us-doc its
// source of truth) and the flushed-chunk map is repopulated from the
// manifests the next pull reads, so the cost of losing it is at most one
// duplicate upload, never a fact that cannot be recovered. Checkpointing
// per cycle instead would put a disk write on every idle 45 s tick of
// every bound device, which is a real price for a self-healing map.
//
// BACKOFF IS PER DIRECTION AND UNTRIAGED. Any failed background cycle

// backs the direction off (truncated exponential, base 5 s, factor 2,
// cap 10 min, jittered), because "transient-vs-permanent triage is not
// worth string-matching error text for a background loop" — Google's
// 429/403-rate contract is then honoured as a special case of honouring
// everything. THE USER'S OWN Sync-now IS NOT ROUTED THROUGH HERE AT ALL
// (the sheet calls `driver.bucketFlush` directly), which is what makes
// "an explicit act deserves an explicit answer" true by construction
// rather than by a bypass flag.

const FLUSH_DEBOUNCE_MS = 20_000;
const PULL_INTERVAL_MS = 45_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 600_000;
/** Where a background failure stops being the scheduler's business and
 * becomes the user's (SYNC.md §3). */
const SYNC_VISIBLE_AFTER = 3;

/** One direction's consecutive-failure count. The delay is DERIVED from
 * it rather than stored, so there is one number to reset and no way for
 * a count and a delay to disagree. */
let flushFailures = 0;
let pullFailures = 0;
let lastFlush: number | null = null;
let lastPull: number | null = null;
let lastSyncError: string | null = null;
/**
 * A RESTORED DEVICE'S KIT IS STILL WAITING TO BE RETIRED — see
 * `settleConsume`. Cleared by the first `recoveryConsume()` that
 * succeeds, from wherever it is attempted; absence is success by
 * contract, so this never becomes permanently stuck on a kit somebody
 * else already revoked.
 */
let consumePending = false;

/**
 * THE US-DOC, AS THE BUCKET SURFACE NAMES IT: an EMPTY doc-id
 * (engine.wit's `bucket-flush`/`bucket-pull`; RECOVERY.md, "The us-doc
 * through the bucket, unparked").
 *
 * SYNC.md §3 scoped the cycle to the pointer map and parked the us-doc;
 * this is the unparking. The account document has to BE in the bucket
 * because a cold restore reads the account out of it — and the engine
 * flushes it only at the moments the engine controls (kit create,
 * revoke, consume), so a restore can otherwise be only as fresh as the
 * last of those.
 *
 * THE SPELLING IS `new Uint8Array(0)`: `list<u8>` lowers to a typed
 * array through this adapter, so the empty list is an empty typed array
 * — not `undefined`, and not an omitted argument. One frozen instance
 * because it is read-only by every caller and minting one per cycle
 * would be noise.
 */
const US_DOC: Uint8Array = new Uint8Array(0);

let flushTimer: number | undefined;
let pullTimer: number | undefined;
/** WHEN THE STANDING FLUSH TIMER IS DUE, absolute `Date.now()` ms, and
 * meaningful only while `flushTimer` is armed. An absolute deadline
 * rather than a remaining delay because the question a mutation has to
 * ask mid-backoff is "is the arm I am about to make EARLIER than the one
 * already standing?", and a remaining delay cannot be compared across
 * two different moments. See `armFlush`. */
let flushDueAt = 0;

/**
 * The two cycles serialize against each other and against nothing else —
 * the `checkpointChain` idiom, for the same reason and with the same
 * non-breaking `catch`.
 *
 * A flush and a pull overlapping on one engine would be two passes over
 * the same doc's objects for no gain, and on the flush side the guest's
 * flushed-chunk map is exactly the kind of state two concurrent passes
 * would each write a stale copy of. Ordinary driver calls are NOT queued
 * behind this, for the checkpoint chain's reason.
 */
let syncChain: Promise<unknown> = Promise.resolve();

/**
 * HOW MANY CLIENT-INITIATED BUCKET OPS ARE IN FLIGHT.
 *
 * The scheduler must not fight the user, and it must not fight a test.
 * A page pressing "Sync to storage now", a connect ceremony running
 * `ensureBucket`/`storeGrant`/`bucketFlush` in sequence, or a gate row
 * asserting an exact object-name set across a flush all want the store
 * to themselves for the duration; a background cycle landing in the
 * middle would at best duplicate work and at worst make an assertion
 * about "what one flush wrote" false. So a cycle that arrives while a
 * client op is outstanding DEFERS rather than runs — it re-arms at the
 * ordinary cadence and tries again later, which is exactly what a
 * trailing debounce is for.
 *
 * It is a COUNTER rather than a boolean because two ports may be calling
 * at once, and a boolean would be cleared by whichever finished first.
 */
const CLIENT_BUCKET_METHODS: ReadonlySet<string> = new Set([
  "ensureBucket",
  "storeGrant",
  "storeRevoke",
  "bucketFlush",
  "bucketPull",
  "initStore",
  // THE RECOVERY CEREMONIES ARE CLIENT BUCKET OPS TOO, and for the
  // reason above rather than by analogy: each of them writes or deletes
  // objects (the bundle, the K_p) and flushes the account document, and
  // a background cycle landing in the middle of one would race a
  // ceremony the user is watching — and would make a gate row's
  // assertion about "what one ceremony wrote" false. `recoveryKits` is
  // absent because it reads a document and touches no store.
  "recoveryKitCreateBucket",
  "recoveryKitCreateFile",
  "recoveryRestoreBucket",
  "recoveryRestoreFile",
  "recoveryConsume",
  "recoveryKitRevoke",
]);
let clientBucketOps = 0;

/** The jittered delay for a direction that has failed `n` times.
 * Truncated exponential (SYNC.md §3) with full-width jitter around the
 * nominal delay, clamped to the cap: the jitter is what keeps a fleet of
 * devices that all lost the same provider from retrying in lockstep. */
function backoffDelay(n: number): number {
  const nominal = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, n - 1)));
  return Math.min(BACKOFF_CAP_MS, Math.round(nominal * (0.5 + Math.random())));
}

/**
 * One failure, as a sentence a person can read.
 *
 * NEVER MATERIAL, and truncated (rpc.ts's `SyncStatus.lastError` states
 * the rule). What arrives here is a seam or guest refusal — the same
 * prose the storage sheet already renders beside the Sync-now button
 * when the user presses it — so the honest treatment is to keep the
 * sentence and cut it, not to invent a summary of it.
 */
function syncErrorSentence(e: unknown): string {
  const message = String((e as { message?: unknown } | null)?.message ?? e);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/** Bytes to lowercase hex — the form `meta`'s agent id already rests in,
 * so a sibling's `agentId` can be compared against this device's own. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * MAY A BACKGROUND CYCLE RUN AT ALL? Three conditions, and each one is a
 * different kind of "no".
 *
 *   * the device was erased, or is sealed, or has no engine — a timer
 *     must never fire into a sealed device (the checkpoint's guard, and
 *     the reason `reseal` clears these timers before it drops the DEK).
 *   * nothing is BOUND — no destination, so no cycle. The binding is
 *     read from the sealed namespace each time rather than cached,
 *     because `bindStore`/`unbindStore` can move it between two ticks
 *     and a cached answer would sync to a destination the user just
 *     disconnected.
 *   * a client bucket op is in flight — defer, see `clientBucketOps`.
 */
async function syncMayRun(): Promise<Engine | null> {
  if (destroyed || dek === null || engine === null) return null;
  if (clientBucketOps > 0) return null;
  const live = engine;
  const key = dek;
  let binding: StoreBinding | undefined;
  try {
    binding = await readBinding(key);
  } catch {
    // A binding that will not open is `unseal`'s and `status()`'s
    // finding to report, not a background timer's to raise: those two
    // let the `SealError "tampered"` propagate to a caller who asked.
    // From in here it is simply "no destination this cycle".
    return null;
  }
  if (!binding) return null;
  // The awaits above are suspension points; re-check that the device did
  // not seal underneath them.
  if (destroyed || dek !== key || engine !== live) return null;
  return live;
}

/**
 * THE PARTITIONS A CYCLE COVERS: the ACCOUNT POINTER MAP, re-read every
 * cycle (SYNC.md §3, "Scope"), or NULL for "this device has no account".
 *
 * Re-read rather than cached because a partition added on another device
 * arrives through the account's own sync, and a cached list would keep
 * this device flushing yesterday's set.
 *
 * CONTRACT: `usPartitions()` REFUSES on a device with no user-system
 * document ("no user-system partition (user-create or pair first)" —
 * engine/guest/src/usdoc.rs's `doc_id`), and that refusal is NOT counted
 * as a sync failure. SYNC.md §3 defines the scope of a cycle as the
 * pointer map; a device that has no map has no scope, which is the same
 * "nothing to do" an EMPTY map is, and treating it as a failure would
 * put every account-less device into permanent backoff and announce a
 * broken sync at a device that was never asked to sync anything. Read
 * failures of the map are therefore ABSENCE, not error; failures of the
 * flush/pull calls themselves are what the backoff is about.
 *
 * NULL AND `[]` ARE NOW DIFFERENT ANSWERS, and the us-doc is why. An
 * account with an empty pointer map still HAS an account document to
 * flush and pull (RECOVERY.md's unparking), so "no partitions" can no
 * longer stand in for "nothing to do". The refusal above is the honest
 * test for the account's existence — it is the same call, asked for its
 * other meaning.
 */
async function syncScope(live: Engine): Promise<UsPartition[] | null> {
  try {
    return await live.driver.usPartitions();
  } catch {
    return null;
  }
}

/**
 * THIS ACCOUNT'S OTHER DEVICES — the pull fan-out's other axis
 * (`pullCycle`'s header has the argument for why a fan-out is what
 * "pull whatever my other devices wrote" means).
 *
 * Revoked entries are dropped, and so is this device itself, by the
 * agent id `meta` recorded at init or restore. NO DIRECTORY IS ABSENCE:
 * an account-less device's ordinary state is an empty sibling list, not
 * a failed cycle.
 */
async function siblingsOf(live: Engine): Promise<{ agentId: Uint8Array }[]> {
  const self = (await ns.get<string>("meta", AGENT_KEY)) ?? null;
  try {
    return (await live.driver.usDevicesList())
      .filter((d) => !d.revoked && (self === null || hexOf(d.agentId) !== self));
  } catch {
    return [];
  }
}

/**
 * PULL THE ACCOUNT DOCUMENT from every sibling, absence-tolerant.
 *
 * IT GOES FIRST IN EVERY CYCLE, and the ordering is the whole point:
 * the us-doc's content IS the pointer map and the device directory, so
 * the content pulls that follow chain off what this one brought in. A
 * cycle that read the map first would fan out over yesterday's set.
 *
 * A SIBLING THAT HAS NEVER FLUSHED THE US-DOC IS ABSENCE, NEVER AN
 * ERROR — it is the ordinary state of a device that was enrolled and has
 * not synced yet, and it must not cost the siblings that would have
 * worked. So the per-pair outcome is counted (for `pullCycle`'s
 * every-pair-failed rule) and never thrown.
 */
async function pullUsDoc(
  live: Engine,
  siblings: { agentId: Uint8Array }[],
): Promise<{ attempted: number; succeeded: number; failure: unknown | null }> {
  let attempted = 0;
  let succeeded = 0;
  let failure: unknown | null = null;
  for (const sib of siblings) {
    if (engine !== live || dek === null || destroyed) break;
    attempted++;
    try {
      await live.driver.bucketPull(US_DOC, sib.agentId, undefined);
      succeeded++;
    } catch (e) {
      failure ??= e;
    }
  }
  return { attempted, succeeded, failure };
}

/** Record a cycle's outcome and hand back the delay the direction's next
 * tick should use. */
function noteSyncOutcome(direction: "flush" | "pull", failure: unknown | null): number {
  if (failure === null) {
    if (direction === "flush") {
      flushFailures = 0;
      lastFlush = Date.now();
    } else {
      pullFailures = 0;
      lastPull = Date.now();
    }
    // The sentence goes when BOTH directions are healthy — a page that
    // cleared it on one direction's success would erase the only
    // description of the other's ongoing failure.
    if (flushFailures === 0 && pullFailures === 0) lastSyncError = null;
    return direction === "flush" ? FLUSH_DEBOUNCE_MS : PULL_INTERVAL_MS;
  }
  const n = direction === "flush" ? ++flushFailures : ++pullFailures;
  lastSyncError = syncErrorSentence(failure);
  return backoffDelay(n);
}

/**
 * ONE FLUSH CYCLE: the ACCOUNT DOCUMENT first, then every partition in
 * the pointer map, in order.
 *
 * A partition that fails does NOT stop the ones after it — a doc whose
 * objects a provider is refusing is no reason to leave the others
 * unwritten — but the cycle as a whole is a FAILURE if any partition
 * failed, which is the literal reading of SYNC.md §3's "ANY failed
 * background flush". The first failure is the one whose sentence is
 * kept, because it is the one with the least other noise in front of it.
 *
 * THE US-DOC RIDES THE SAME DEBOUNCE (RECOVERY.md's unparking). It is
 * armed by the same mutation hook as everything else, which is correct
 * without a special case: `usProfileSet`, `usMarkPut`, `usPartitionPut`,
 * `usDeviceEndpointPut` and the rest are all NON-readonly methods, so a
 * write to the account document already schedules a flush through
 * `call()`. It goes FIRST so a cycle that dies halfway has published the
 * account state that names everything else.
 *
 * AND THE OUTSTANDING CONSUME, at the head of the cycle. A restore whose
 * kit could not be retired retries here — this is the "flush cadence's
 * backoff loop" engine.wit's `recovery-consume` names, and the retry is
 * safe because absence is success by contract.
 */
async function flushCycle(): Promise<void> {
  const live = await syncMayRun();
  if (live === null) {
    armFlush(FLUSH_DEBOUNCE_MS, false);
    return;
  }
  let failure: unknown | null = null;
  if (consumePending) {
    try {
      // AND THE CHECKPOINT THAT MAKES IT STICK — the retry path needs it
      // exactly as much as the restore's own does, and for the same
      // reason: this call is internal, so nothing here arms the
      // debounce, and a consume that outlives its checkpoint is undone
      // by the next respawn while its bucket copy stays self-filtered
      // out of its own reach. See `consumeAndCheckpoint`.
      await consumeAndCheckpoint(live);
    } catch (e) {
      failure ??= e;
    }
  }
  const parts = await syncScope(live);
  if (parts === null) {
    // No account: no us-doc to flush and no map to walk. The next
    // mutation re-arms — except that an outstanding consume has to keep
    // being retried, and a device with a kit to retire always has an
    // account, so this branch cannot strand one.
    if (failure !== null) armFlush(noteSyncOutcome("flush", failure), true);
    return;
  }
  try {
    await live.driver.bucketFlush(US_DOC);
  } catch (e) {
    failure ??= e;
  }
  for (const part of parts) {
    if (engine !== live || dek === null || destroyed) break;
    try {
      await live.driver.bucketFlush(part.id);
    } catch (e) {
      failure ??= e;
    }
  }
  const delay = noteSyncOutcome("flush", failure);
  // A SUCCESSFUL cycle does not re-arm: flush is EVENT-DRIVEN, and a
  // device nobody is touching should be silent. A FAILED one does, which
  // is what makes the backoff a retry cadence rather than a mute button.
  if (failure !== null) armFlush(delay, true);
}

/**
 * ONE PULL CYCLE: the ACCOUNT DOCUMENT and then every partition in the
 * pointer map, from every SIBLING DEVICE of this account that is not
 * this one.
 *
 * THE US-DOC IS PULLED FIRST AND THE MAP IS RE-READ AFTER IT
 * (RECOVERY.md's unparking of "the us-doc through the bucket"): the
 * account document carries the pointer map and the device directory, so
 * it is what the content pulls chain off. See `pullUsDoc`.
 *
 * WHY A FAN-OUT AT ALL. `bucketPull(docId, ownerId, pickup)` names the
 * device whose keyed namespace is being read (the bringup's cold pull
 * passes the flushing engine's own agent id —
 * demo/host/bringup.ts:221,469), because the object model is
 * single-writer-per-name: each device writes under ITS OWN verifying key
 * and there is no "the store's copy" to pull. So "pull whatever my other
 * devices wrote" is exactly (partition × sibling), and the sibling list
 * is the account's own device directory (`usDevicesList()`) minus this
 * device and minus revoked entries.
 *
 * PER-PAIR FAILURES ARE TOLERATED INDEPENDENTLY: a sibling that has
 * never flushed to this store, or has been switched off since before the
 * bind, refuses its pair (the gdrive arm's "pickup object missing:
 * revoked, or never granted to this device") and must not cost the
 * pairs that would have worked.
 *
 * CONTRACT — and this is the one place SYNC.md §3's "ANY failed
 * background pull" and the fan-out's per-pair tolerance pull in
 * different directions. The conservative reading taken here: a cycle is
 * a FAILURE only when it attempted at least one pair and EVERY pair
 * failed. The alternative — any pair's failure fails the cycle — makes a
 * single never-flushed sibling pin the pull direction in permanent
 * backoff and announce a broken sync to a user whose sync is working,
 * which is the "lie of omission" rule inverted into crying wolf. Flagged
 * in the track report.
 */
async function pullCycle(): Promise<void> {
  const live = await syncMayRun();
  if (live === null) {
    armPull(PULL_INTERVAL_MS);
    return;
  }
  const siblings = await siblingsOf(live);
  if (siblings.length === 0) {
    armPull(PULL_INTERVAL_MS);
    return;
  }
  // THE ACCOUNT DOCUMENT FIRST, and then the map it just updated — see
  // `pullUsDoc`. Reading the scope AFTER this pull rather than before is
  // the whole reason the ordering is specified: a partition a sibling
  // published a minute ago is in the map this pull brought in, and a
  // cycle that read the map first would not fetch it until the next one.
  const us = await pullUsDoc(live, siblings);
  let attempted = us.attempted;
  let succeeded = us.succeeded;
  let failure: unknown | null = us.failure;
  const parts = await syncScope(live);
  for (const part of parts ?? []) {
    for (const sib of siblings) {
      if (engine !== live || dek === null || destroyed) break;
      attempted++;
      try {
        // `pickup` is the LINK tier's standing capability and this is an
        // owner-tier pull between two devices of one account, so it is
        // `undefined` — the same argument the bringup's cold pull
        // passes, and the gdrive arm refuses a non-undefined one BY NAME
        // (DRIVE.md §1).
        await live.driver.bucketPull(part.id, sib.agentId, undefined);
        succeeded++;
      } catch (e) {
        failure ??= e;
      }
    }
  }
  const total = attempted > 0 && succeeded === 0 ? failure : null;
  const delay = noteSyncOutcome("pull", total);
  armPull(delay);
}

/**
 * Arm the trailing flush.
 *
 * `fromMutation` distinguishes the two arms, and the difference is the
 * debounce's whole meaning: a MUTATION resets the window (a burst of
 * typing costs one flush, taken after the burst rather than through it),
 * while a BACKOFF re-arm must not be pushed further out by every
 * keystroke — so it only ever moves the deadline LATER when nothing is
 * already armed sooner.
 */
function armFlush(delay: number, fromMutation: boolean): void {
  if (dek === null || destroyed) return;
  if (!fromMutation && flushTimer !== undefined) return;
  const now = Date.now();
  let due = now + delay;
  // A MUTATION WHILE THE DIRECTION IS BACKED OFF CHANGES *WHAT* WILL BE
  // FLUSHED, NEVER *WHEN*: a failing store is retried on the backoff's
  // schedule no matter how busy the user is, and a recovery resets
  // everything. Without this the debounce's own re-arm would clobber the
  // standing backoff deadline on every keystroke — the failure COUNT
  // would still escalate and the announcement would still fire, but the
  // retry PRESSURE against a store that is already refusing would stay
  // at mutation cadence, which is the one thing backoff exists to
  // prevent. `max` rather than "leave it alone" because a debounce
  // deadline further out than the backoff's is the quieter of the two,
  // and quieter always wins here.
  if (fromMutation && flushFailures > 0 && flushTimer !== undefined) {
    due = Math.max(flushDueAt, due);
  }
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushDueAt = due;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    syncChain = syncChain.then(() => flushCycle()).catch(() => {});
  }, Math.max(0, due - now)) as unknown as number;
}

function armPull(delay: number): void {
  if (dek === null || destroyed) return;
  if (pullTimer !== undefined) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => {
    pullTimer = undefined;
    syncChain = syncChain.then(() => pullCycle()).catch(() => {});
  }, delay) as unknown as number;
}

/** The mutation hook's sync half — armed beside `scheduleCheckpoint()`
 * and by the same event, at the same call site. */
function scheduleFlush(): void {
  armFlush(FLUSH_DEBOUNCE_MS, true);
}

/**
 * BRING-UP: one pull, then the cadence (SYNC.md §2, "PULL AT BRING-UP").
 *
 * BEHIND READINESS, AND THAT IS THE POINT: this is called at the END of
 * `unseal`, after the engine is published and `status()` is answerable,
 * and it arms a ZERO-DELAY TIMER rather than awaiting anything. So the
 * unseal that opened the device returns on its own schedule and the boot
 * pull happens after it — "boot never blocks on the network", made
 * structural instead of promised. Idempotent: two tabs unsealing one
 * already-open device re-arm one timer, they do not start two loops.
 */
function startSyncSchedule(): void {
  if (dek === null || destroyed) return;
  armPull(0);
}

/**
 * RE-ARM AT THE ORDINARY CADENCE — the bind sites' arm, and it is
 * deliberately NOT `startSyncSchedule`.
 *
 * A BIND IS THE FIRST HALF OF A CEREMONY, not the end of one: the page
 * that just bound goes straight on to `ensureBucket`, `storeGrant` and a
 * first `bucketFlush` (demo/host/solo.ts's connect ceremony), and those
 * calls have not been dispatched yet — so `clientBucketOps`, which can
 * only see an op that is already in flight, would wave a boot pull
 * through into the middle of them. Measured, not theorised: the
 * `solo-account-storage` scenario went red on exactly this, with the
 * binding device's first flush producing no doc folder at all.
 *
 * The ordinary cadence is the right answer rather than a workaround. A
 * freshly bound device has nothing a sibling wrote that it needs in the
 * next second — SYNC.md's boot pull is the "my other device wrote while
 * this one was CLOSED" beat, and this device has been open the whole
 * time — so 45 s later is both safe and sufficient.
 */
function rearmSyncSchedule(): void {
  if (dek === null || destroyed) return;
  armPull(PULL_INTERVAL_MS);
}

/**
 * Stop the schedule and forget everything it learned.
 *
 * CALLED FROM `clearGrant()`, which is deliberate rather than
 * convenient: every site that drops this device's egress authority — the
 * reseal, the erase, the unseal rollback, an unbind, a forgotten consent
 * — is exactly a site where a timer that later fired would be firing
 * into a device with no destination, and in the seal cases into one with
 * no DEK at all. Putting it there means the list cannot drift out of
 * sync with the grant's.
 *
 * THE COUNTS GO WITH THE TIMERS. Backoff state describes a conversation
 * with a destination; a device that has just been unbound, resealed or
 * re-pointed is not in that conversation any more, so carrying a failure
 * count across would announce an old bucket's outage against a new one.
 *
 * `consumePending` DOES NOT GO WITH THEM, deliberately: it is not a
 * fact about a conversation but an OBLIGATION this device took on when
 * it restored — the kit is still live in the account until something
 * retires it. A reseal does not retire it, so the flag survives to be
 * retried at the next cycle. (An ERASE does end it, by ending the
 * global that holds it.)
 */
function stopSyncSchedule(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pullTimer !== undefined) {
    clearTimeout(pullTimer);
    pullTimer = undefined;
  }
  flushDueAt = 0;
  flushFailures = 0;
  pullFailures = 0;
  lastFlush = null;
  lastPull = null;
  lastSyncError = null;
}

/**
 * FLUSH RIGHT NOW, BEST-EFFORT — the two moments that are not a timer.
 *
 * Used at last-client-disconnect (beside the existing best-effort
 * checkpoint) and before reseal. Returns a promise that never rejects:
 * both callers are places where a rejection has nobody to go to, and the
 * reseal caller in particular must NOT be able to refuse the ceremony.
 */
function syncFlushNow(): Promise<void> {
  const next = syncChain.then(() => flushCycle());
  syncChain = next.catch(() => {});
  return next.catch(() => {});
}

/** `status()`'s sync half. Null while sealed or unbound, with the
 * cannot-know/has-no-opinion split rpc.ts documents. */
function syncStatusOf(binding: StoreBinding | null): SyncStatus | null {
  if (dek === null || binding === null) return null;
  return {
    lastFlush,
    lastPull,
    flushFailures,
    pullFailures,
    lastError: lastSyncError,
    consumePending,
  };
}

// --- status -----------------------------------------------------------------

async function status(): Promise<DeviceStatus> {
  const record = await getDevice(DEVICE_ID);
  const rungs = await sealState(ns);
  const policy = record?.unsealPolicy ?? "every-session";
  // Read once, reported below: `null` while sealed is UNREADABLE, not
  // absent (see the field's own note).
  const gdriveRow = dek === null ? undefined : await readOauth(dek);
  // Read once and used TWICE below — by `storage` and by `sync`, whose
  // null arms are the same two facts (sealed, or nothing bound). Two
  // reads could straddle a bind and report a destination beside a
  // "nothing is bound" sync record.
  const binding = dek === null ? null : ((await readBinding(dek)) ?? null);
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
    // Null while sealed BECAUSE IT IS UNREADABLE THEN, not as a
    // simplification: the binding rests under the DEK. A tampered row
    // would throw out of here rather than report null, and that is the
    // ruling — swallowing it in `status()` would hide a real finding
    // from the one call everything makes.
    storage: binding,
    // THE CONSENT AS A NULLABLE RECORD, with the same cannot-know
    // semantics as `storage` above: the oauth row rests under the DEK,
    // so `null` on a sealed device means unreadable rather than absent.
    // The one field on it is the SPACE the consent was granted for —
    // addressing, the same class as the binding's own space, and the
    // thing a sheet needs in order to know whether the consent it has
    // matches the destination the user picked. Nothing else about the
    // row — no token, no expiry, no account name — is derivable from
    // this field, which is the whole design of it (DRIVE.md §3).
    gdriveConsent: gdriveConsentOf(gdriveRow),
    // THE SCHEDULE'S OWN REPORT (SYNC.md §3, "Surface"). Timestamps,
    // counts and one sentence — nothing addressing, nothing secret; see
    // rpc.ts's `SyncStatus`.
    sync: syncStatusOf(binding),
  };
}

/** `status()`'s one derivation from the sealed oauth row: existence,
 * plus the space that existence was granted for. */
function gdriveConsentOf(row: OauthRow | undefined): { space: GdriveSpace } | null {
  return row === undefined ? null : { space: row.space };
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
    case "bindStore":
      return await bindStore(args[0] as StoreBinding);
    case "unbindStore":
      return await unbindStore();
    // --- account recovery (RECOVERY.md; the ordering lives in
    // --- `restore` and the reason it is a method in rpc.ts's
    // --- `RestoreSpec`).
    case "restorePrepare":
      return await restorePrepare((args[0] as UnsealOptions) ?? {});
    case "restore":
      return await restore(args[0] as RestoreSpec);
    case "createRecoveryKit":
      return await createRecoveryKit(args[0] as RecoveryKitSpec);
    case "recoveryKits": {
      // A pure read, but it goes through the host surface beside its two
      // siblings so a sheet has ONE place to reach for kit management
      // rather than one method on the host and one on the proxied
      // driver. The refusals are the guest's own.
      if (!engine) {
        throw new SealError("no-rung", "the device is sealed; open it before listing kits");
      }
      return await engine.driver.recoveryKits();
    }
    case "revokeRecoveryKit": {
      // The guest does the whole revocation — membership, the K_p, the
      // epoch rotation, the bundle object, the record — and flushes the
      // account document itself, so there is nothing to arrange here
      // beyond handing back the guarantee note the UI renders. The
      // partition flush the rotation implies rides the ordinary
      // mutation-armed cadence.
      if (!engine) {
        throw new SealError("no-rung", "the device is sealed; open it before revoking a kit");
      }
      const note = await engine.driver.recoveryKitRevoke(args[0] as Uint8Array);
      // AND A CHECKPOINT, the third instance of `consumeAndCheckpoint`'s
      // hazard: a HOST-surface call arms no debounce, and everything
      // this one wrote — the revoked membership, the new name-key epoch,
      // the cleared registry row — would be resurrected by a respawn,
      // with the bucket's copy self-filtered out of this device's own
      // reach. A resurrected REVOCATION is the worst of the three: the
      // device would go on believing a kit it has already destroyed is
      // live. Swallowed for the kit ceremony's reason — the revocation
      // has already happened at the provider, so reporting a failure
      // here would be reporting a revoke that did not occur.
      await checkpoint().catch(() => {});
      return note;
    }
    case "oauthStart":
      return await oauthStart(args[0] as OauthStartSpec);
    case "oauthComplete":
      return await oauthComplete(args[0] as string, args[1] as string);
    case "forgetOauth":
      return await forgetOauth();
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
      //    AND THE SYNC TIMERS, for a related but weaker reason: a
      //    background flush does not write the state root, but it does
      //    read this engine and mutate the guest's bucket state, and the
      //    drain below is an await during which an armed timer would
      //    otherwise fire on a device that is being erased. The RUNNING
      //    cycle is deliberately NOT drained the way the checkpoint
      //    chain is: it is a network round trip, so awaiting it would
      //    let an unreachable provider hold an erasure open — and unlike
      //    a checkpoint it cannot recreate the namespace's files, so
      //    there is nothing to be sure of. `destroyed` (set below)
      //    refuses whatever it tries next.
      stopSyncSchedule();
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
      // AND THE EGRESS AUTHORITY, exactly as reseal drops it (§6 of
      // STORAGE-EGRESS.md; the sealed rows below go with the namespace,
      // but the grant and the signer are THIS GLOBAL'S memory and would
      // otherwise stay armed on a device that no longer exists —
      // unreachable by any new call once `destroyed` is up, but an
      // in-flight engine call still holds the seams' closures until it
      // settles, and a destroyed device must not be able to sign or
      // egress even from that window).
      clearGrant();
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
  // A CLIENT-INITIATED BUCKET OP OWNS THE STORE WHILE IT RUNS. See
  // `clientBucketOps`: a background cycle that arrived mid-ceremony
  // would race the user's own act (and a gate row's own assertion about
  // what one flush wrote), so it defers instead. The counter is bumped
  // around the await and released in `finally`, because a REFUSED
  // bucket op must not leave the scheduler muted for the life of the
  // worker.
  const holdsBucket = target === "driver" && CLIENT_BUCKET_METHODS.has(method);
  if (holdsBucket) clientBucketOps++;
  let value: unknown;
  try {
    value = await surface[method](...args);
  } finally {
    if (holdsBucket) clientBucketOps--;
  }
  if (!READONLY_METHODS.has(method)) {
    scheduleCheckpoint();
    // THE FLUSH IS THE CHECKPOINT'S SLOWER SIBLING, armed by the same
    // event at the same site and running on its own independent timer
    // (SYNC.md §3). One hook, two cadences — 500 ms to this disk, ~20 s
    // to the bucket.
    scheduleFlush();
  }
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
        // AND THE FLUSH, on the same trigger and with the same honesty
        // about what "best-effort" means (SYNC.md §3 names
        // last-client-disconnect as one of the two moments the schedule
        // honours beside the debounce). An armed flush is cancelled by
        // the cycle this starts, and the cycle no-ops on a device with
        // nothing bound. Fire-and-forget by construction: there is
        // nobody left to report to, and this global may be torn down
        // before it settles.
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        void syncFlushNow();
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
