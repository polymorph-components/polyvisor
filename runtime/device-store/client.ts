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
// IT IMPORTS NO PACKAGE, only siblings — so a page can take this module
// with no pins (runtime/README.md's resolution model). The engine types
// it re-exports are type-only imports, which erase.

import type { Driver, Tasks } from "../engine.ts";
import { adoptAnchor, setAnchor } from "./anchor.ts";
import { createDevice, getDevice, touchDevice, type UnsealPolicy } from "./index.ts";
import { nsDbName } from "./names.ts";
import {
  type AttachSpec,
  type DeviceStatus,
  DeviceHostError,
  DRIVER_METHODS,
  type Hello,
  type PromoteOptions,
  rehydrate,
  type ResealOptions,
  type Req,
  type Res,
  TASKS_METHODS,
  type UnsealOptions,
} from "./rpc.ts";

export { DeviceHostError };
export type { DeviceStatus, PromoteOptions, ResealOptions, UnsealOptions };

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
  | { kind: "new"; petname: string; unsealPolicy?: UnsealPolicy };

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
 * EVERY REJECTION IS A `DeviceHostError`. Branch on `isWitError` /
 * `witPayload` / `code`, never on `instanceof ComponentException`: the
 * worker and the page are separate module graphs in separate agents, so
 * class identity — and the very concept of "the same module" — does not
 * cross the port. See rpc.ts's `DeviceHostError` for the full argument
 * and for what it does carry.
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
  status(): Promise<DeviceStatus>;
  /** The worker's identity as this client first saw it. */
  readonly hello: Hello;
  /** Say goodbye (which is what gives the worker its last-client
   * checkpoint a chance) and stop listening. Idempotent. */
  close(): Promise<void>;
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
  });
  setAnchor(made.id);
  return made.id;
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
    else entry.reject(rehydrate(res.error));
  };
  worker.port.start();

  function send(target: Req["target"], method: string, args: unknown[]): Promise<unknown> {
    if (closed) {
      return Promise.reject(
        new DeviceHostError({
          message: "device-store: this connection was closed",
          name: "DeviceHostError",
          isWitError: false,
        }),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          // A TIMEOUT IS NOT A WIT ERROR. It says nothing about what the
          // guest did or did not do — the call may still be running in
          // the worker — so it must never present itself as an err arm
          // the app can handle. `isWitError: false` is the whole
          // distinction the envelope exists to keep.
          reject(new DeviceHostError({
            message: `device-store: ${target}.${method} timed out after ${timeoutMs}ms`,
            name: "TimeoutError",
            isWitError: false,
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
    { deviceId, artifacts: spec.artifacts, label: spec.label } satisfies AttachSpec,
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
    status: () => send("host", "status", []) as Promise<DeviceStatus>,
    close,
    __die: async () => {
      await send("host", "__die", []);
      closed = true;
    },
  };
}
