// The frame loader: the entire contents of every app frame.
//
// It is constant — one build artifact, hash-pinned in the srcdoc's meta CSP
// (web/boot.ts `frameSrcdoc`) — so the app's own code arrives as data over a
// port and never as script. The frame is an opaque origin with no
// `connect-src`: everything it renders comes down the mutation stream or out
// of a `blob:` minted here from bytes the kernel served over the session
// port. That is the e2e `frame-network-dead` claim, structurally.
//
// Its authority is exactly one session port (internal.wit "Realms"): the
// app's `polyvisor:app/tasks` import and the three `polyvisor:internal/apps`
// members that read its own bundle. It never states a session id; the worker
// bound one to this port.

import { artifactsFromEnvelope } from "@polyengine/runtime/embedder";

import { mountProducer } from "./mount.ts";
import type { MountedProducer } from "./mount.ts";
import { appPolicy } from "./policy.ts";
import { proxyInterfaces } from "./rpc.ts";

const I = {
  tasks: "polyvisor:app/tasks@0.1.0",
  apps: "polyvisor:internal/apps@0.1.0",
  route: "polyvisor:app/route@0.1.0",
} as const;

interface AssetInfo {
  handle: Uint8Array;
  mediaType: string;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

let mounted: MountedProducer | undefined;
/** Set synchronously on the first `mount` message: `mounted` itself only
 * exists an await later, which is not a guard. */
let mounting = false;

/** `polyvisor:app/route.get`'s answer: the route the mount message carried
 * ("" for a plain launch), fixed for this frame's lifetime — `wit/app.wit`
 * `route`: "the route the app was launched at". Served locally, never over
 * the session port: the port answers `tasks`/`apps`, and route is a
 * page-URL concern the glue owns on the other side of `postMessage`, not a
 * kernel call (internal.wit `shell.open-frame` docs). */
let route = "";

function teardown(message: string): void {
  mounted?.dispose();
  mounted = undefined;
  document.body.textContent = "";
  parent.postMessage({ t: "error", message }, "*");
}

async function mount(
  wasm: Uint8Array,
  plan: string,
  port: MessagePort,
): Promise<void> {
  const imports = proxyInterfaces(port, [I.tasks]);
  // `route` is local, not proxied over `port`: `get` reads the value the
  // mount message carried and `set` relays to the parent, which is the one
  // side that can touch `location` at all (internal.wit `shell.open-frame`:
  // "the glue also writes the page fragment ... on every `route.set` the
  // frame relays"). Same shape as a proxied interface — a record of
  // camelCase methods, keyed by the verbatim WIT interface id — so it merges
  // into `imports` exactly where a proxy would have gone.
  imports[I.route] = {
    get: () => route,
    set: (r: string) => {
      parent.postMessage({ t: "route", route: r }, "*");
    },
  };
  const appsClient = proxyInterfaces(port, [I.apps])[I.apps] as {
    assets(): Promise<AssetInfo[]>;
    asset(handle: Uint8Array): Promise<Uint8Array>;
  };

  // `resolveAsset` must answer synchronously — the driver resolves an asset
  // attribute value while applying a frame — so every asset in the bundle is
  // fetched and given a blob URL before the producer runs. Bundles are small
  // and fully known at launch, so "prefetch all" is the whole strategy.
  const urls = new Map<string, string>();
  for (const info of await appsClient.assets()) {
    const bytes = await appsClient.asset(info.handle);
    urls.set(
      hex(info.handle),
      URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: info.mediaType }),
      ),
    );
  }

  mounted = await mountProducer({
    source: artifactsFromEnvelope(plan, wasm),
    root: document.body,
    imports,
    policy: appPolicy,
    resolveAsset: (handle: Uint8Array) => {
      const url = urls.get(hex(handle));
      // An unresolvable handle is a producer naming something outside its
      // own bundle: it aborts the stream through the normal error path.
      if (url === undefined) {
        throw new Error(`unknown asset handle ${hex(handle)}`);
      }
      return url;
    },
    onError: (err: unknown) => teardown(String((err as Error)?.message ?? err)),
  });
}

globalThis.addEventListener("message", (ev: MessageEvent) => {
  // Only the embedder may hand this frame its component and its port.
  if (ev.source !== parent) return;
  const data = ev.data;
  if (typeof data !== "object" || data === null) return;
  if ((data as { t?: string }).t !== "mount") return;
  if (mounting) return; // one mount per frame
  mounting = true;
  const { wasm, plan, route: launchRoute } = data as {
    wasm: Uint8Array;
    plan: string;
    route: string;
  };
  route = launchRoute;
  const port = ev.ports[0];
  mount(wasm, plan, port).catch((err: unknown) =>
    teardown(String((err as Error)?.message ?? err))
  );
});

parent.postMessage({ t: "ready" }, "*");
