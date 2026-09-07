// The device's SharedWorker: it owns the runtime component and every port
// into it (internal.wit "Realms" — "runtime component — SharedWorker, one
// per device").
//
// Two kinds of port exist and the difference is the whole security story:
//
//   control port — a tab's own connect port. Serves `device`, `store` and
//                  `apps` straight off the runtime's exports, because the
//                  visor on the other end is trusted pixels, plus `events`
//                  from that tab's own queue.
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
import { webcryptoImports } from "@polymorph/webcrypto";
import { websocketImports } from "@polymorph/websocket";
import { webrtcImports } from "@polymorph/webrtc-datachannels";

// Vendored, not `@polymorph/iroh`: that package's only export is its root,
// whose graph statically pulls @polyengine/translator into this bundle.
import { socketsImports } from "./platform/sockets.ts";

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
  sync: "polyvisor:internal/sync@0.1.0",
  pairing: "polyvisor:internal/pairing@0.1.0",
  storage: "polyvisor:internal/storage@0.1.0",
  // Both sides of one seam: the runtime EXPORTS `events` (the pump below
  // consumes it) and each tab's visor IMPORTS it (served further down from
  // that tab's queue). Same interface id, opposite directions.
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
 * event stream: the worker pumps the runtime's parking `events.next` and
 * fans each event out to every tab, whose own glue serves the visor's
 * `events.next` import from a local queue (internal.wit `interface
 * events`). */
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
  /** The iroh relay this device binds its endpoint through
   * (`lifecycle.boot-config.relay`): the home origin's `config.json`, which
   * the tab read and passed on. Like the device id, it is deployment
   * configuration that exists before the kernel does. */
  relay: string;
  /** This page's URL without query or fragment
   * (`lifecycle.boot-config.page-url`): the OAuth redirect the storage
   * ceremony comes back to. Only a window knows its own URL, so like the
   * device id and the relay it arrives from the tab. */
  pageUrl: string;
  /** Google Drive's API and OAuth bases, when the home origin publishes
   * its own (`config.json`'s `drive_api`/`drive_oauth`; the e2e harness
   * points both at a fake). `undefined` is Google's, which is the kernel's
   * default and not this glue's business to spell. */
  driveApi?: string;
  driveOauth?: string;
  /** Resolves when this worker actually HOLDS `pm-device-<device>`. */
  lock: Promise<void>;
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
 * Returns a promise that resolves when the lock is GRANTED, not when it is
 * requested — `navigator.locks.request` is asynchronous, so between the call
 * and the callback running this device's lock is not held and a sibling
 * worker's sweep would read it as free. The boot awaits this before the
 * kernel exists, which is the only window where the kernel's own state root
 * is on disk with nothing claiming it.
 *
 * The request promise itself is deliberately never awaited — the callback
 * never settles, so awaiting it would park forever. `deviceLock` keeps the
 * whole chain alive and says so.
 */
let deviceLock: Promise<unknown> | undefined;

function holdDeviceLock(device: string): Promise<void> {
  return new Promise<void>((granted, failed) => {
    deviceLock = navigator.locks.request(`pm-device-${device}`, () => {
      granted();
      return new Promise<never>(() => {});
    });
    // A request that cannot be granted at all (a bad name, a browser that
    // refuses) must fail the boot rather than leave it parked: the lock is
    // not decoration, it is what makes the sweep safe.
    deviceLock.catch(failed);
  });
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
      // The endpoint component's own imports, which is what the runtime's
      // are once `wac plug` has composed it in (justfile `compose`): the
      // relay wire (websocket), the direct browser wire (webrtc data
      // channels), the identity keys (webcrypto — the kernel imports the
      // ed25519 halves directly too, and both sides resolve to this one
      // provider), and a `wasi:sockets` UDP surface that answers
      // `not-supported`, which is the browser profile's honest answer: the
      // endpoint binds no socket.
      ...webcryptoImports(),
      ...websocketImports(),
      ...webrtcImports(),
      ...socketsImports(),
      "polyvisor:internal/kv@0.1.0": kv,
      [I.locks]: locks,
    },
    // No realm needs JSPI (docs/design.md "No JSPI"). Every glue-implemented
    // import is an `async func` whose callback ABI never blocks a frame, and
    // the composed iroh endpoint — the one thing here that ever did need it
    // — now signs its QUIC handshakes in-guest: the identity comes from
    // `polymorph:iroh/identity-from-seed`, so rustls's synchronous
    // `Signer::sign` no longer reaches an async webcrypto import. `false` is
    // therefore an assertion, not a default: polyengine refuses loudly if a
    // sync-typed import ever returns a Promise. web/jspi_test.ts pins it at
    // every call site in this repository.
    { jspi: false },
  );
  return instance.exports as unknown as Exports;
}

/** Resolves once the runtime is booted; rejects if boot failed. Parks until
 * the first tab says which device this worker is: the id exists before the
 * kernel does and only a tab can supply it. */
const ready: Promise<Exports> = (async () => {
  const { device, homeOrigin, relay, pageUrl, driveApi, driveOauth, lock } =
    await helloed;
  // Before the kernel exists: `lifecycle.boot` runs the sweep, and a sweep
  // that ran while a sibling worker's lock was merely REQUESTED would read
  // that device as dead and collect a live namespace. Held first, booted
  // second.
  await lock;
  const exports_ = await loadRuntime(device);
  const boot = exports_[I.lifecycle].boot as (
    c: {
      homeOrigin: string;
      device: string;
      relay: string;
      pageUrl: string;
      driveApi: string | undefined;
      driveOauth: string | undefined;
    },
  ) => Promise<void>;
  // The home origin without a trailing slash, per `lifecycle.boot-config`;
  // the tab derives it from its own URL, and every tab that can reach this
  // worker is on the home origin by construction.
  // `option<string>` lowers as `T | undefined` (m1-context.md "Value
  // mapping"), so an absent base is passed as the absence itself rather
  // than as an empty string the kernel would have to re-interpret.
  await boot({ homeOrigin, device, relay, pageUrl, driveApi, driveOauth });
  return exports_;
})();

ready.catch((err: unknown) => {
  const message = String((err as Error)?.message ?? err);
  for (const tab of tabs) tab.port.postMessage({ t: "fatal", message });
});

// ---------------------------------------------------------------------------
// Events: one long-poll pump over the runtime's export
//
// internal.wit `interface events` and design.md "Contracts" rule 4. The
// runtime's `next` parks while its queue is empty, so no call has to carry
// an event across: a phase the OTHER device drove — a peer confirming, an
// enrollment landing — wakes this pump with nothing pressed on this device.
// ---------------------------------------------------------------------------

function fanOut(events: KernelEvent[]): void {
  for (const ev of events) {
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
}

/** The pump. Started once the runtime is booted, never restarted: if `next`
 * rejects, the runtime is gone, and a runtime that is gone was already
 * reported to every tab through `ready`'s failure path. Retrying would spin
 * on the same rejection forever. */
void ready.then(async (exports_) => {
  const next = exports_[I.events].next as () => Promise<KernelEvent>;
  try {
    for (;;) fanOut([await next()]);
  } catch (err: unknown) {
    console.error(
      "polyvisor: the kernel's event pump stopped:",
      (err as Error)?.message ?? err,
    );
  }
}).catch(() => {
  // Not booted: `ready.catch` already told every tab.
});

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
      const relay = String((data as { relay: string }).relay);
      const pageUrl = String((data as { pageUrl: string }).pageUrl);
      const optional = (v: unknown) =>
        typeof v === "string" && v !== "" ? v : undefined;
      if (hello === undefined) {
        hello = {
          device,
          homeOrigin,
          relay,
          pageUrl,
          driveApi: optional((data as { driveApi?: unknown }).driveApi),
          driveOauth: optional((data as { driveOauth?: unknown }).driveOauth),
          lock: holdDeviceLock(device),
        };
        announce(hello);
      } else if (hello.device !== device) {
        // One worker, one device (docs/design.md "Devices"). Two ids on one
        // worker means the name did not separate them, and serving the tab
        // anyway would show it another device's pixels. So the port is told
        // and then dropped: a tab that cannot be served correctly must not
        // go on being served at all, and it must not keep receiving this
        // device's events.
        port.postMessage({
          t: "fatal",
          message:
            `this worker is device ${hello.device}, not ${device} — the ` +
            `browser matched two SharedWorker names to one worker`,
        });
        tabs.delete(tab);
        port.close();
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
    // Control port only, like `device`: dialing another device is the
    // visor's act, and an app session has no business naming a peer.
    [I.sync]: {
      connect: async (endpointId: string) =>
        (await ready)[I.sync].connect(endpointId),
      peers: async () => (await ready)[I.sync].peers(),
      members: async () => (await ready)[I.sync].members(),
    },
    // Control port only, like `sync`: pairing is a ceremony in the trusted
    // pixels, and an app session has no business starting or confirming
    // one.
    [I.pairing]: {
      offer: async () => (await ready)[I.pairing].offer(),
      claim: async (code: string) => (await ready)[I.pairing].claim(code),
      confirm: async () => (await ready)[I.pairing].confirm(),
      cancel: async () => (await ready)[I.pairing].cancel(),
      status: async () => (await ready)[I.pairing].status(),
    },
    // Control port only, like `pairing`: connecting a store is a ceremony
    // in the trusted pixels, and an app session has no business naming a
    // provider — still less holding the one-shot code that crosses here.
    // The tokens themselves never cross this port: `oauth-complete` hands
    // the kernel a code, and what comes back the kernel seals for itself
    // (internal.wit `storage`).
    [I.storage]: {
      status: async () => (await ready)[I.storage].status(),
      oauthStart: async (client: unknown) =>
        (await ready)[I.storage].oauthStart(client),
      oauthComplete: async (code: string, state: string) =>
        (await ready)[I.storage].oauthComplete(code, state),
      disconnect: async () => (await ready)[I.storage].disconnect(),
      syncNow: async () => (await ready)[I.storage].syncNow(),
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
    // The tab side of `events`: served from this tab's own local queue,
    // which the pump above fills.
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
