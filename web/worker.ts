// The device's SharedWorker: it owns the runtime component and every port
// into it (internal.wit "Realms" — "runtime component — SharedWorker, one
// per device").
//
// Two kinds of port exist and the difference is the whole security story:
//
//   control port — a tab's own connect port. Serves `device`, `apps` and
//                  `events` straight off the runtime's exports, because the
//                  visor on the other end is trusted pixels.
//   session port — minted per `{t:"frame-port", session}` and bound HERE to
//                  that session id. Serves exactly `polyvisor:app/tasks` and
//                  three members of `polyvisor:internal/apps`, each called
//                  with the session this port was bound to. The frame never
//                  states a session; internal.wit's header rule: "Caller
//                  identity is supplied by the glue from the port a call
//                  arrived on, never taken from the caller."

import {
  artifactsFromEnvelope,
  instantiate,
} from "@polyengine/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import { filesystemWeb } from "@polyengine/wasi/filesystem-web";
import type { OpfsDirectoryHandle } from "@polyengine/wasi/filesystem-web";
import { http } from "@polyengine/wasi/http";

import { serveInterfaces } from "./rpc.ts";
import { kv } from "./platform/kv.ts";

// The `dom` lib does not describe a SharedWorker's global scope, and pulling
// in `webworker` alongside `dom` conflicts on most of the DOM. This is the
// whole of what this module uses.
declare const self: {
  readonly location: Location;
  onconnect: ((ev: MessageEvent) => void) | null;
};

const I = {
  lifecycle: "polyvisor:internal/lifecycle@0.1.0",
  device: "polyvisor:internal/device@0.1.0",
  store: "polyvisor:internal/store@0.1.0",
  apps: "polyvisor:internal/apps@0.1.0",
  events: "polyvisor:internal/events@0.1.0",
  appServices: "polyvisor:internal/app-services@0.1.0",
  locks: "polyvisor:internal/locks@0.1.0",
  tasks: "polyvisor:app/tasks@0.1.0",
} as const;

/** The runtime's exports, keyed by verbatim interface id. */
type Exports = Record<string, Record<string, (...a: unknown[]) => unknown>>;

interface KernelEvent {
  kind: string;
  value?: unknown;
}

/** One connected tab. `queue`/`waiter` are that tab's copy of the kernel
 * event stream: the worker long-polls `events.next` once and fans each
 * event out to every tab, whose own glue serves the visor's `events.next`
 * import from a local queue (internal.wit `interface events`). */
interface Tab {
  port: MessagePort;
  queue: KernelEvent[];
  waiter?: (ev: KernelEvent) => void;
}

/** Deepest a tab's backlog may grow. A tab that stops calling `events.next`
 * (backgrounded, wedged) must not make the worker's memory grow without
 * bound; past this the OLDEST event is dropped, because the newest state of
 * the device is what a returning visor needs. */
const QUEUE_LIMIT = 64;

const tabs = new Set<Tab>();

// ---------------------------------------------------------------------------
// The device this worker is
// ---------------------------------------------------------------------------

/** What the first `hello` said. The worker is NAMED after the device id, so
 * every tab that reaches this worker is anchored to the same one; a hello
 * naming a different id means the browser matched two different names to
 * one worker, which is a bug, not a state to recover from. */
interface Hello {
  device: string;
  homeOrigin: string;
}

let hello: Hello | undefined;
let announce: (h: Hello) => void;
const helloed = new Promise<Hello>((resolve) => {
  announce = resolve;
});

/** The device's liveness signal (internal.wit `interface locks`): held for
 * the worker's lifetime and released only when the worker dies, which is
 * what lets the kernel's sweep tell a dead namespace from a live one.
 *
 * The request promise is deliberately never awaited — the callback never
 * settles, so awaiting it would park here forever. The reference keeps the
 * whole chain alive and says so.
 */
let deviceLock: Promise<unknown> | undefined;

function holdDeviceLock(device: string): void {
  deviceLock = navigator.locks.request(
    `pm-device-${device}`,
    () => new Promise<never>(() => {}),
  );
}

/** Answers `locks.is-held` off the browser's own lock table. `query()` lists
 * only locks held in THIS agent cluster's origin — which is exactly the set
 * the sweep asks about: another device's worker on this origin. */
const locks = {
  isHeld: async (name: string): Promise<boolean> => {
    const q = await navigator.locks.query();
    return q.held?.some((l) => l.name === name) ?? false;
  },
};

async function loadRuntime(device: string): Promise<Exports> {
  const base = self.location.href;
  const [wasmRes, planRes] = await Promise.all([
    fetch(new URL("runtime.component.wasm", base)),
    fetch(new URL("runtime.component.plan.json", base)),
  ]);
  if (!wasmRes.ok || !planRes.ok) {
    throw new Error(
      `runtime component unavailable (${wasmRes.status}/${planRes.status})`,
    );
  }
  const wasm = new Uint8Array(await wasmRes.arrayBuffer());
  const plan = await planRes.text();

  // The kernel's state root (internal.wit `world runtime`): the origin's
  // OPFS at `/`, and the kernel keeps each device under `/<id>/`. The
  // preopen is granted here and nowhere else — `device` is passed to the
  // kernel, not baked into the grant, because a single-device preopen would
  // give the sweep nothing to sweep.
  //
  // The cast is structural-typing paperwork: `filesystemWeb` takes its own
  // handle interface (so in-memory fakes work) and the `dom` lib's
  // `FileSystemDirectoryHandle.entries()` is typed over the `FileSystemHandle`
  // base rather than the file/directory union.
  const root = await navigator.storage.getDirectory();
  const fs = filesystemWeb({
    preopens: { "/": root as unknown as OpfsDirectoryHandle },
    // Package-level, never per-preopen (filesystem_web.ts header). The
    // kernel writes checkpoints, so it is on.
    writable: true,
  });

  const instance = await instantiate(
    artifactsFromEnvelope(plan, wasm),
    {
      ...wasi(),
      // After `wasi()`: that fragment carries a filesystem of its own for
      // the baseline imports every wasip2 component names, and this is the
      // one that must win.
      ...fs.imports,
      ...http().imports,
      "polyvisor:internal/kv@0.1.0": kv,
      [I.locks]: locks,
    },
    { jspi: false },
  );
  return instance.exports as unknown as Exports;
}

/** Resolves once the runtime is booted; rejects if boot failed. Parks until
 * the first tab says which device this worker is: the id exists before the
 * kernel does and only a tab can supply it. */
const ready: Promise<Exports> = (async () => {
  const { device, homeOrigin } = await helloed;
  const exports_ = await loadRuntime(device);
  const boot = exports_[I.lifecycle].boot as (
    c: { homeOrigin: string; device: string },
  ) => Promise<void>;
  // The home origin without a trailing slash, per `lifecycle.boot-config`.
  // `location.origin` is spelled that way, and every tab that can reach this
  // worker is on the home origin by construction.
  await boot({ homeOrigin, device });
  startEventPump(exports_);
  return exports_;
})();

ready.catch((err: unknown) => {
  const message = String((err as Error)?.message ?? err);
  for (const tab of tabs) tab.port.postMessage({ t: "fatal", message });
});

function startEventPump(exports_: Exports): void {
  const next = exports_[I.events].next as () => Promise<KernelEvent>;
  void (async () => {
    for (;;) {
      const ev = await next();
      for (const tab of tabs) {
        if (tab.waiter) {
          const w = tab.waiter;
          tab.waiter = undefined;
          w(ev);
        } else {
          tab.queue.push(ev);
          if (tab.queue.length > QUEUE_LIMIT) tab.queue.shift();
        }
      }
    }
  })().catch(() => {
    // The pump is the only reader of `events.next`; if it dies the kernel
    // has stopped, which the tabs learn from their next call failing.
  });
}

/** Bind a fresh MessageChannel to `session` and serve the session's two
 * interfaces on it. Returns the end to transfer to the frame. */
function mintSessionPort(
  exports_: Exports,
  session: number,
): MessagePort {
  const svc = exports_[I.appServices];
  const apps = exports_[I.apps];
  const { port1, port2 } = new MessageChannel();
  serveInterfaces(port1, {
    [I.tasks]: {
      revision: () => svc.tasksRevision(session),
      items: () => svc.tasksItems(session),
      add: (title: string) => svc.tasksAdd(session, title),
      setCompleted: (id: string, completed: boolean) =>
        svc.tasksSetCompleted(session, id, completed),
      setTitle: (id: string, title: string) =>
        svc.tasksSetTitle(session, id, title),
      remove: (id: string) => svc.tasksRemove(session, id),
    },
    // Only these three: a session port is not a way to enumerate or launch
    // apps.
    [I.apps]: {
      component: () => apps.component(session),
      assets: () => apps.assets(session),
      asset: (handle: Uint8Array) => apps.asset(session, handle),
    },
  });
  return port2;
}

self.onconnect = (ev: MessageEvent) => {
  const port = ev.ports[0];
  const tab: Tab = { port, queue: [] };
  tabs.add(tab);

  // Non-WIT control traffic: the device hello and the frame-port request.
  // Registered before `serveInterfaces` starts the port so no message is
  // missed — the hello is the FIRST thing a tab sends, and nothing the
  // runtime can serve exists before it.
  port.addEventListener("message", (m: MessageEvent) => {
    const data = m.data;
    if (typeof data !== "object" || data === null) return;
    const t = (data as { t?: string }).t;

    if (t === "hello") {
      const device = String((data as { device: string }).device);
      const homeOrigin = String((data as { homeOrigin: string }).homeOrigin);
      if (hello === undefined) {
        hello = { device, homeOrigin };
        holdDeviceLock(device);
        announce(hello);
      } else if (hello.device !== device) {
        // One worker, one device (docs/design.md "Devices"). Two ids on one
        // worker means the name did not separate them, and serving the tab
        // anyway would show it another device's pixels.
        port.postMessage({
          t: "fatal",
          message:
            `this worker is device ${hello.device}, not ${device} — the ` +
            `browser matched two SharedWorker names to one worker`,
        });
      }
      return;
    }

    if (t !== "frame-port") return;
    const session = (data as { session: number }).session;
    void ready.then((exports_) => {
      const frame = mintSessionPort(exports_, session);
      port.postMessage({ t: "frame-port", session, port: frame }, [frame]);
    }).catch((err: unknown) => {
      port.postMessage({
        t: "frame-port-failed",
        session,
        message: String((err as Error)?.message ?? err),
      });
    });
  });

  serveInterfaces(port, {
    [I.device]: {
      status: async () => (await ready)[I.device].status(),
      setName: async (name: string) => (await ready)[I.device].setName(name),
      setHue: async (hue: number) => (await ready)[I.device].setHue(hue),
      rerollWord: async () => (await ready)[I.device].rerollWord(),
      keep: async (petname: string, passphrase: string | undefined) =>
        (await ready)[I.device].keep(petname, passphrase),
      unseal: async (passphrase: string) =>
        (await ready)[I.device].unseal(passphrase),
      erase: async () => (await ready)[I.device].erase(),
    },
    [I.store]: {
      devices: async () => (await ready)[I.store].devices(),
    },
    [I.apps]: {
      installed: async () => (await ready)[I.apps].installed(),
      launch: async (app: string) => (await ready)[I.apps].launch(app),
      sessionApp: async (s: number) => (await ready)[I.apps].sessionApp(s),
      component: async (s: number) => (await ready)[I.apps].component(s),
      assets: async (s: number) => (await ready)[I.apps].assets(s),
      asset: async (s: number, h: Uint8Array) =>
        (await ready)[I.apps].asset(s, h),
      close: async (s: number) => (await ready)[I.apps].close(s),
      // Control port only: `abort` is how the tab's own glue reports a
      // frame that died (internal.wit `apps.abort`). `mintSessionPort`
      // deliberately does not serve it — a session must not be able to end
      // itself with a reason of its own composing.
      abort: async (s: number, reason: string) =>
        (await ready)[I.apps].abort(s, reason),
    },
    [I.events]: {
      // Parks while the tab's queue is empty, exactly as the WIT says. One
      // waiter per tab: a second concurrent `next()` would silently replace
      // the first, stranding it forever, so it is refused instead.
      next: () => {
        if (tab.queue.length > 0) return Promise.resolve(tab.queue.shift()!);
        if (tab.waiter !== undefined) {
          return Promise.reject(
            new Error("events.next is already parked for this tab"),
          );
        }
        return new Promise<KernelEvent>((resolve) => {
          tab.waiter = resolve;
        });
      },
    },
  });

  void ready.then(() => {
    port.postMessage({ t: "booted" });
  }).catch(() => {
    // `ready.catch` above already told every connected tab.
  });
};
