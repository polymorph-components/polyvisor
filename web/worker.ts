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
  apps: "polyvisor:internal/apps@0.1.0",
  events: "polyvisor:internal/events@0.1.0",
  appServices: "polyvisor:internal/app-services@0.1.0",
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

async function loadRuntime(): Promise<Exports> {
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

  const instance = await instantiate(
    artifactsFromEnvelope(plan, wasm),
    {
      ...wasi(),
      ...http().imports,
      "polyvisor:internal/kv@0.1.0": kv,
    },
    { jspi: false },
  );
  return instance.exports as unknown as Exports;
}

/** Resolves once the runtime is booted; rejects if boot failed. */
const ready: Promise<Exports> = (async () => {
  const exports_ = await loadRuntime();
  const boot = exports_[I.lifecycle].boot as (
    c: { homeOrigin: string },
  ) => Promise<void>;
  // The home origin without a trailing slash, per `lifecycle.boot-config`.
  // A SharedWorker's `location.origin` IS the origin that served its script,
  // which is the home origin by construction.
  await boot({ homeOrigin: self.location.origin });
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

  // Non-WIT control traffic: the frame-port request. Registered before
  // `serveInterfaces` starts the port so no message is missed.
  port.addEventListener("message", (m: MessageEvent) => {
    const data = m.data;
    if (typeof data !== "object" || data === null) return;
    if ((data as { t?: string }).t !== "frame-port") return;
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
