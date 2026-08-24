// THE CLIENT HALF OF THE DEVICE HOST: a tab's view of its device
// (PERSISTENCE.md, "The worker host": "Tabs attach over MessagePort and
// are views").
//
// `connectDevice()` resolves WHICH device this tab is looking at,
// constructs (or joins) the SharedWorker that hosts it, and hands back a
// typed remote `driver`/`tasks` pair plus the host-surface calls. Every
// method is a `postMessage` round trip; nothing here holds engine state,
// key material, or an opinion about either.
//
// THE INDEX STAYS ON THIS SIDE. Reading the list of devices needs no
// worker at all — the index is the one unsealed database, and a picker
// that had to spawn a worker per row in order to render a name would be
// spawning workers to answer a question the index already answers.
// `listDevices()` (index.ts) is what a picker calls; `connectDevice` is
// what happens after the user chooses. Same for the T0 anchor: it lives
// in sessionStorage, which does not exist in a worker (anchor.ts's
// header), so THE TAB resolves the pointer and hands the worker a
// concrete id.
//
// ONE PACKAGE IMPORT, NEW AT 0.4.0 AND RE-HOMED AT 0.5.1. This module
// used to be package-free; `fromCloneable` changed that, deliberately. It
// came from `@polyengine/runtime/embedder` until polyengine A22 made that
// module application-only and moved the vocabulary to
// `@polyengine/protocol`, which is where it is imported from now. It is what turns the worker's engine rejection
// back into a REAL branded `ComponentException` in this realm — payload,
// cause chain, sender's stack — instead of the facsimile the old
// hand-rolled brand produced. The trade is stated rather than hidden:
// a picker that only reads the index still needs no pins, but it must
// import index.ts directly rather than reach this module through mod.ts
// (runtime/README.md's resolution model). The engine TYPES below are
// type-only and still erase.

import { fromCloneable } from "@polyengine/protocol";
import type { Driver, Tasks } from "../engine.ts";
import { adoptAnchor, setAnchor } from "./anchor.ts";
import {
  createDevice,
  getDevice,
  type Posture,
  touchDevice,
  type UnsealPolicy,
} from "./index.ts";
import { nsDbName } from "./names.ts";
import {
  type AttachSpec,
  type DeviceStatus,
  DeviceHostError,
  DRIVER_METHODS,
  type GdriveSpace,
  type Hello,
  type OauthStartResult,
  type OauthStartSpec,
  type PromoteOptions,
  type ResealOptions,
  type Req,
  type Res,
  type StoreBinding,
  type SyncStatus,
  TASKS_METHODS,
  type UnsealOptions,
  type WireFailure,
} from "./rpc.ts";

export { DeviceHostError };
export type {
  DeviceStatus,
  GdriveSpace,
  OauthStartResult,
  OauthStartSpec,
  PromoteOptions,
  ResealOptions,
  StoreBinding,
  /** The worker's sync schedule, as `DeviceStatus.sync` carries it
   * (SYNC.md §3). Re-exported beside `StoreBinding` for the same reason
   * that one is: a page rendering the storage sheet reads it off a
   * status and should not have to reach past this module for its type. */
  SyncStatus,
  UnsealOptions,
};

/** Which device this tab wants. */
export type DeviceChoice =
  /** This exact device — a picker's answer, or a T1 boot's. */
  | { kind: "id"; id: string }
  /**
   * THE T0 BOOT: whatever this tab was already looking at, or a new
   * ephemeral device if it was looking at nothing (or at something the
   * sweep has since collected). The degrade rule, applied here rather
   * than reported: a stale pointer is A FRESH DEVICE, SILENTLY — never
   * an error, never a dialog (PERSISTENCE.md, "T0 reload survival").
   */
  | { kind: "anchor"; petname: string }
  /** A brand-new device, anchored to this tab. */
  | {
    kind: "new";
    petname: string;
    unsealPolicy?: UnsealPolicy;
    /** Overrides the `platform` default. The one caller that wants
     * `seed` is the gate row proving old checkpoints still resume. */
    posture?: Posture;
  };

export interface ConnectSpec {
  device: DeviceChoice;
  /**
   * The bundled worker entry (device-store/worker.ts, built by the
   * embedder). A URL rather than a specifier because a SharedWorker is
   * constructed from one, and because the embedder — not this module —
   * decides where its bundles live.
   */
  workerUrl: string | URL;
  /** Where the worker should fetch the engine from. Resolved against
   * the WORKER's URL, not the page's. */
  artifacts: AttachSpec["artifacts"];
  /** `wasi:cli` args label; diagnostics only. */
  label?: string;
  /** PROBE ONLY — see `AttachSpec.__seedPosture` in rpc.ts. */
  __seedPosture?: boolean;
  /** How long a single RPC may take before the client gives up.
   * Instantiating the composite is ~100 ms, but a first unseal also runs
   * 600k PBKDF2 iterations and a resume reads the whole state root. */
  timeoutMs?: number;
}

/**
 * The remote device. `driver` and `tasks` are the engine's own surfaces,
 * proxied method-for-method (rpc.ts's tables, which are type-checked
 * exhaustive against `Driver` and `Tasks`).
 *
 * A REJECTION IS ONE OF TWO THINGS, and telling them apart is the
 * point of the split (rpc.ts, "how a rejection crosses"):
 *
 *   * THE ENGINE REFUSED — a real `ComponentException`, rehydrated by
 *     `fromCloneable` in this realm. `isComponentException(e)` answers
 *     true, `e.payload` is the WIT err arm, the cause chain is whole.
 *     This is an EXPECTED outcome an app handles.
 *   * THE HOST REFUSED — a `DeviceHostError` carrying a typed `code`
 *     ("wrong-passphrase", "no-rung", "timeout", …). Nothing in the
 *     guest produced it; the unseal ceremony is its main audience.
 *
 * Branch on `e.code` for the second and on the embedder's brand
 * predicate for the first. Do not branch on `instanceof DeviceHostError`
 * across a bundle boundary — class identity is per module graph — and
 * note the corollary: an engine error is no longer a `DeviceHostError`
 * at all, which is a deliberate 0.4.0 change from the facsimile this
 * class used to present.
 */
export interface DeviceConnection {
  readonly deviceId: string;
  readonly driver: Driver;
  readonly tasks: Tasks;
  /** Open the device. See the worker's `unseal` for the rung rules and
   * the honest sentence about what each tier is worth. */
  unseal(opts?: UnsealOptions): Promise<DeviceStatus>;
  /**
   * "KEEP THIS DEVICE" — the SEAL half of promotion, which is all of it
   * that needs the worker. The INDEX half (`promoteDevice`) is the
   * caller's, on this side, because the index is unsealed and needs no
   * worker; run them together and the index one last, so a failed
   * re-wrap never leaves a row claiming a rung the device does not
   * have. See the worker's `promote` for what each rung does.
   */
  promote(opts: PromoteOptions): Promise<DeviceStatus>;
  /**
   * Forget the persisted wrap and drop the worker's key material. The
   * engine goes down with it; the next `unseal` runs the ceremony.
   *
   * IT SAVES FIRST, AND IT CAN REFUSE. The ceremony takes a final
   * checkpoint before dropping anything — the debounce window would
   * otherwise lose every mutation of the last half second at each seal —
   * and if that checkpoint fails the whole call REJECTS with the device
   * still open, rather than sealing over work it could not save. A
   * caller retries; it does not get a success it cannot trust.
   *
   * SOMETIMES AN UPGRADE: on a device whose only usable rung is the
   * platform wrap, this REQUIRES `passphrase` and the device comes back
   * as an `every-session` one — see the worker's `reseal` for why
   * reseal must not be able to destroy a device by omission. The caller
   * owns the index half (`promoteDevice(id, {unsealPolicy:
   * "every-session"})`) and runs it after this resolves, so a failed
   * ceremony never leaves a row describing a rung the device lacks.
   */
  reseal(opts?: ResealOptions): Promise<DeviceStatus>;
  /** Force a checkpoint now. Resolves with its timestamp. */
  checkpoint(): Promise<number>;
  /**
   * POINT THIS DEVICE AT A BUCKET, durably.
   *
   * WHAT CROSSES IS ADDRESSING AND A PUBLIC IDENTIFIER — endpoint,
   * bucket, access key — AND NOTHING ELSE. The SECRET half never travels
   * this wire and has no need to: the credential ceremony runs here on
   * the page, `putSigningKey(origin, accessKey, secret)` escrows it into
   * the origin keystore as a non-extractable handle, and the worker —
   * being a SharedWorker on this same origin — reads that handle back BY
   * DESTINATION ORIGIN out of the same IndexedDB database
   * (runtime/STORAGE-EGRESS.md §2). So the escrow must land BEFORE this
   * call: a bind with nothing escrowed for the endpoint's origin is
   * refused with `code === "no-credential"` rather than accepted and
   * discovered later as a provider 403.
   *
   * The worker DERIVES what this device may reach from the endpoint
   * (§4); an allowlist is not something a caller can hand it. The
   * binding then persists sealed under the device's DEK and is
   * re-applied at every unseal, so nothing here has to be remembered or
   * re-entered.
   *
   * Refusals: `SealError`-shaped `code: "no-rung"` while sealed,
   * `"bad-destination"` for an unusable endpoint/bucket/access key, and
   * `"no-credential"` as above — all as `DeviceHostError`, branch on
   * `code`.
   */
  bindStore(binding: StoreBinding): Promise<DeviceStatus>;
  /**
   * Forget the destination. The sealed binding goes and the worker's
   * grant is emptied at once, so every storage seam refuses from the
   * next call onward; the live engine keeps the addressing it was given
   * until the next bring-up, which is harmless precisely because the
   * authority is in the wiring (§6).
   *
   * IT DOES NOT DELETE THE ESCROWED CREDENTIAL. That record is
   * profile-tier and destination-bound — shared with every other device
   * on this origin — so removing it belongs to the erase ceremony
   * (`eraseKeystore`), not to one device's unbind.
   */
  unbindStore(): Promise<DeviceStatus>;
  /**
   * BEGIN THE GOOGLE CONSENT — and note which half of it this is.
   *
   * THE PAGE OWNS THE POPUP; THE WORKER OWNS THE VERIFIER (DRIVE.md §3).
   * A window is a page capability, so opening the consent is this side's
   * job — but the PKCE verifier, the token exchange and the tokens
   * themselves stay in the worker, which is what keeps a bearer out of
   * page memory entirely.
   *
   * So what crosses on this call is app identity and addressing (the
   * client id and secret are INSTALLED-APP identifiers, the same public
   * class as the Dropbox appKey/appSecret the demo already holds in page
   * memory — DRIVE.md §3) plus the SPACE, which is what picks the scope
   * this consent asks for and so has to be decided before the popup
   * opens, not at bind. What comes back is a URL. Open a popup on
   * it; the redirect lands back on `spec.redirectUri` with `?code&state`
   * and both go to `oauthComplete`.
   *
   * Refused with `code: "no-rung"` while sealed: a ceremony that
   * succeeded on a sealed device would end holding tokens with nowhere
   * sealed to put them.
   */
  oauthStart(spec: OauthStartSpec): Promise<OauthStartResult>;
  /**
   * FINISH THE CONSENT by relaying what the popup came back with.
   *
   * THE CODE MAY CROSS THIS WIRE AND THE RULING SAYS WHY (DRIVE.md §3):
   * it is a one-shot artifact, bound to a verifier that never left the
   * worker, consumed inside the ceremony. It is not a standing
   * credential, and the bearer ban is about standing credentials. NO
   * TOKEN EVER TRAVELS BACK — what returns is the ordinary
   * `DeviceStatus`, whose only word on the subject is
   * `gdriveConsent` — null, or the SPACE the consent was granted for,
   * which is addressing and never a credential.
   *
   * Refusals: `"no-rung"` while sealed; `"bad-ceremony"` when no
   * ceremony is pending or the state does not match the one the worker
   * minted; `"exchange-failed"` when the token endpoint refused (named
   * by HTTP status only — a token-endpoint body can echo the request).
   *
   * It does NOT bind anything. Consent and commitment stay two acts;
   * `bindStore` is the second one.
   */
  oauthComplete(code: string, state: string): Promise<DeviceStatus>;
  /**
   * DISCONNECT THE ACCOUNT: delete the sealed consent and best-effort
   * revoke it at the provider (DRIVE.md §4) — the honest disconnect, and
   * the only place revocation belongs.
   *
   * The revoke is courtesy and its failure is swallowed; the DELETION is
   * the act. The device's in-memory bearer goes with it, so every
   * storage seam refuses from the next call onward.
   *
   * THE BINDING SURVIVES, deliberately: forgetting the account is not
   * forgetting the destination — the mirror image of `unbindStore`
   * keeping the escrow. Re-consenting on the same client id puts the
   * device back to work with nothing re-addressed.
   */
  forgetOauth(): Promise<DeviceStatus>;
  status(): Promise<DeviceStatus>;
  /** The worker's identity as this client first saw it. */
  readonly hello: Hello;
  /** Say goodbye (which is what gives the worker its last-client
   * checkpoint a chance) and stop listening. Idempotent. */
  close(): Promise<void>;
  /**
   * ERASE THIS DEVICE — the user's explicit one, and the end of this
   * connection.
   *
   * The worker destroys its OWN namespace (database, OPFS directory,
   * index row) and then closes its global, which is what releases the
   * device lock and the lease. It has to be the worker's own hand: the
   * host is the only thing that can drain its checkpoint chain and drop
   * the engine before the storage goes, and a page deleting a live
   * device's database from underneath it would race a background
   * checkpoint into recreating what it just deleted.
   *
   * THIS ONE IS NOT BEST-EFFORT, unlike `close()`. It is the fallible
   * half of an erase ceremony (visor/ui/sheets.ts's `onReset` contract):
   * a caller is meant to await it FIRST and let a rejection refuse the
   * whole ceremony, so that a device whose storage is still there is
   * never reported as erased. Afterwards this connection is closed and
   * every call on it fails with the closed-connection error.
   */
  destroy(): Promise<void>;
  /**
   * PROBE ONLY: ask the host to `close()` its own global — a crash,
   * on demand. Nothing in an application should call this; it exists so
   * a kill-and-resume gate can kill a host without also destroying the
   * tabs that have to observe the recovery.
   */
  __die(): Promise<void>;
}

/**
 * Resolve the choice into a concrete device id, entirely on this side.
 *
 * The anchor arm is the interesting one, and it is deliberately silent
 * about the difference between "you were here before" and "what you
 * pointed at is gone": `adoptAnchor()` already clears a stale pointer,
 * so both cases arrive here as `null` and both produce a fresh T0
 * device.
 */
async function resolveDevice(choice: DeviceChoice): Promise<string> {
  if (choice.kind === "id") {
    const row = await getDevice(choice.id);
    if (!row) throw new Error(`device-store: no device ${choice.id} in the index`);
    await touchDevice(choice.id);
    return choice.id;
  }
  if (choice.kind === "anchor") {
    const existing = await adoptAnchor();
    if (existing !== null) {
      await touchDevice(existing);
      return existing;
    }
    const made = await createDevice({
      petname: choice.petname,
      // PLATFORM POSTURE, from the first moment. The worker always hands
      // the engine the namespace's non-extractable key through the
      // `device-identity` import, so `seed` (createDevice's default,
      // which predates that seam) would make the index row say something
      // untrue about every device this library creates.
      posture: "platform",
      // WHILE-OPEN IS THE T0 RUNG, and naming it here is what makes the
      // reload path work: the worker climbs the rung the DEVICE RECORD
      // names, and `every-session` (createDevice's default, right for a
      // device someone chose to keep) would demand a passphrase from a
      // device that never had a ceremony. `while-open` is also the
      // honest description of what T0 buys — see worker.ts's `sealT0`
      // for what actually rests on disk and why the sweep, not key
      // volatility, is what ends it.
      unsealPolicy: "while-open",
    });
    setAnchor(made.id);
    return made.id;
  }
  const made = await createDevice({
    petname: choice.petname,
    unsealPolicy: choice.unsealPolicy,
    // See the anchor arm above: the worker runs platform posture, so the
    // row says so.
    posture: choice.posture ?? "platform",
  });
  setAnchor(made.id);
  return made.id;
}

/**
 * Turn one wire failure into the thing to reject with.
 *
 * THE ENGINE ARM GOES THROUGH `fromCloneable`, which mints a value
 * branded by THIS copy (A20's round-trip law): what comes back out is a
 * genuine `ComponentException` — `isComponentException()` true,
 * `payload` intact, `cause` chain to full depth, the worker's stack
 * carried verbatim because the sender's stack is the useful one.
 *
 * A THROW OUT OF `fromCloneable` IS REPORTED, NOT SMOOTHED. It raises a
 * `TypeError` for an unknown envelope tag, and the only way to get one
 * is two realms running different engine versions — outside the
 * supported matrix. Its own message says exactly that, so it is
 * rejected with verbatim rather than wrapped: a version-skew diagnosis
 * is worth more than a tidy `DeviceHostError`.
 */
function thrown(failure: WireFailure): unknown {
  if (failure.form === "host") return new DeviceHostError(failure.error);
  try {
    return fromCloneable(failure.value);
  } catch (skew) {
    return skew;
  }
}

export async function connectDevice(spec: ConnectSpec): Promise<DeviceConnection> {
  const deviceId = await resolveDevice(spec.device);
  const timeoutMs = spec.timeoutMs ?? 120_000;

  // THE NAME IS THE DEVICE. A SharedWorker is keyed by (origin, script
  // URL, name), so naming it after the namespace is what makes "one
  // worker per device" true rather than merely intended: two tabs of one
  // device join one global, and two devices in one browser are two
  // globals that cannot see each other's memory. `nsDbName` is reused
  // for the spelling so the worker name, the database and the lock can
  // never drift apart (names.ts's whole reason for existing).
  const worker = new SharedWorker(String(spec.workerUrl), {
    type: "module",
    name: nsDbName(deviceId),
  });

  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: number;
  }>();
  let helloResolve: (h: Hello) => void = () => {};
  const helloPromise = new Promise<Hello>((r) => {
    helloResolve = r;
  });
  let closed = false;

  worker.port.onmessage = (ev: MessageEvent<Res | Hello>) => {
    const data = ev.data;
    if (data.id === 0) {
      helloResolve(data as Hello);
      return;
    }
    const res = data as Res;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    clearTimeout(entry.timer);
    if (res.ok) entry.resolve(res.value);
    else entry.reject(thrown(res.failure));
  };
  worker.port.start();

  function send(target: Req["target"], method: string, args: unknown[]): Promise<unknown> {
    if (closed) {
      return Promise.reject(
        new DeviceHostError({
          message: "device-store: this connection was closed",
          hostName: "DeviceHostError",
          code: "closed",
        }),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          // A TIMEOUT IS NOT AN ENGINE ERROR. It says nothing about what
          // the guest did or did not do — the call may still be running
          // in the worker — so it must never arrive as a
          // `ComponentException` an app would handle as an err arm. It
          // is a host condition, and it says so.
          reject(new DeviceHostError({
            message: `device-store: ${target}.${method} timed out after ${timeoutMs}ms`,
            hostName: "TimeoutError",
            code: "timeout",
          }));
        }
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const req: Req = { id, target, method, args };
      worker.port.postMessage(req);
    });
  }

  /** Build one remote surface from its method table. */
  function remote<T>(target: "driver" | "tasks", methods: readonly string[]): T {
    const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const m of methods) out[m] = (...args: unknown[]) => send(target, m, args);
    return out as T;
  }

  const hello = await helloPromise;
  await send("host", "attach", [
    {
      deviceId,
      artifacts: spec.artifacts,
      label: spec.label,
      __seedPosture: spec.__seedPosture,
    } satisfies AttachSpec,
  ]);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // Best-effort, and short: this runs on `pagehide` too, where the
      // document may be gone before a reply could arrive. Its VALUE is
      // in the worker (a last-client checkpoint), not in the answer.
      await Promise.race([
        new Promise<void>((r) => {
          const id = nextId++;
          const req: Req = { id, target: "host", method: "detach", args: [] };
          worker.port.postMessage(req);
          setTimeout(r, 0);
        }),
        new Promise<void>((r) => setTimeout(r, 250)),
      ]);
    } catch {
      // A dead port is exactly the case this is best-effort for.
    }
    for (const [, entry] of pending) clearTimeout(entry.timer);
    pending.clear();
    worker.port.close();
  };

  const destroy = async (): Promise<void> => {
    // THE REPLY IS AWAITED, in full and on the ordinary timeout: the
    // whole value of this call is in the answer, because a rejection is
    // what refuses the ceremony that called it. So no `Promise.race`
    // against a short timer here — that pattern belongs to `close()`,
    // whose value is in the worker rather than in the reply.
    await send("host", "destroy", []);
    // Only now. The connection is dead either way once the worker closes
    // its global, but flipping `closed` before the reply would turn a
    // refusal into an unusable connection over a device that still
    // exists. The pagehide handler below reads the same flag, so the
    // farewell `detach` it would otherwise post — to a host that has
    // erased itself — is a no-op from here on.
    closed = true;
    for (const [, entry] of pending) clearTimeout(entry.timer);
    pending.clear();
    worker.port.close();
  };

  // `pagehide` rather than `unload`: it fires in the cases `unload` is
  // increasingly not delivered for, and it is the last point at which a
  // `postMessage` is still worth attempting. The page is
  // bfcache-ineligible anyway (it holds a live relay WebSocket —
  // PERSISTENCE.md, "T0 reload survival"), so there is no persisted-page
  // case to keep the connection alive for.
  globalThis.addEventListener?.("pagehide", () => void close());

  return {
    deviceId,
    hello,
    driver: remote<Driver>("driver", DRIVER_METHODS),
    tasks: remote<Tasks>("tasks", TASKS_METHODS),
    unseal: (opts?: UnsealOptions) => send("host", "unseal", [opts ?? {}]) as Promise<DeviceStatus>,
    promote: (opts: PromoteOptions) =>
      send("host", "promote", [opts]) as Promise<DeviceStatus>,
    reseal: (opts?: ResealOptions) =>
      send("host", "reseal", [opts ?? {}]) as Promise<DeviceStatus>,
    checkpoint: () => send("host", "checkpoint", []) as Promise<number>,
    bindStore: (binding: StoreBinding) =>
      send("host", "bindStore", [binding]) as Promise<DeviceStatus>,
    unbindStore: () => send("host", "unbindStore", []) as Promise<DeviceStatus>,
    oauthStart: (spec: OauthStartSpec) =>
      send("host", "oauthStart", [spec]) as Promise<OauthStartResult>,
    oauthComplete: (code: string, state: string) =>
      send("host", "oauthComplete", [code, state]) as Promise<DeviceStatus>,
    forgetOauth: () => send("host", "forgetOauth", []) as Promise<DeviceStatus>,
    status: () => send("host", "status", []) as Promise<DeviceStatus>,
    close,
    destroy,
    __die: async () => {
      await send("host", "__die", []);
      closed = true;
    },
  };
}
