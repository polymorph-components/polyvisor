// The launcher-icon service worker (docs/design.md "Routing", the `launch/`
// bullet, which carries the reasoning and the caveats).
//
// One job: answer the icon URLs an install named in its manifest, out of
// the cache web/boot.ts wrote them into. Not an offline cache — every other
// request returns without `respondWith`, so the browser does exactly what it
// would have done had this worker never existed — and a miss is a 404, never
// the app shell, because an HTML body wearing an icon's URL looks like a
// success and is not one.

export {};

// Both must match web/boot.ts, the cache's only writer: separate bundles,
// no module in common. The e2e scenario fetches an icon for real, so a name
// that drifted fails a gate rather than degrading quietly.
const ICON_CACHE = "polyvisor-launcher-icons-v1";
const ICON_DIR = "launcher-icons/";

/** A stored icon's file name: the hex SHA-256 of its PNG bytes. */
const ICON_NAME = /^[0-9a-f]{64}\.png$/;

// Typed locally because deno.json's `lib` is `dom`, not `webworker`, so
// `ServiceWorkerGlobalScope` and friends do not exist here — and adding
// `webworker` would put a second, conflicting `self` in front of every other
// file in `web/`. These are the members used and no more.

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface ServiceWorkerScope {
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: FetchEventLike) => void,
  ): void;
}

const sw = self as unknown as ServiceWorkerScope;

// Derived from the registration's own scope, which is the page's base and
// never `/` — on a project Pages site the root is somebody else's page. The
// scope is the base rather than this directory because a worker intercepts
// only fetches from clients it controls, and the client fetching an icon is
// the page; the narrowing that matters is `isIconRequest`, below.
const iconDir = new URL(ICON_DIR, sw.registration.scope);

/** Exact, because every request the page makes goes past here: own-origin
 * GET, directly inside the icon directory, digest file name, no query or
 * fragment. Anything else is not this worker's business. */
function isIconRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== iconDir.origin) return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (!url.pathname.startsWith(iconDir.pathname)) return false;
  return ICON_NAME.test(url.pathname.slice(iconDir.pathname.length));
}

async function handle(request: Request): Promise<Response> {
  const cache = await caches.open(ICON_CACHE);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;
  return new Response("no such launcher icon", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

// The page that registers this worker is about to name icon URLs in a
// manifest, so a worker parked in `waiting` is the same as no worker, and an
// unclaimed page stays uncontrolled until a navigation. Nothing is deleted:
// the cache is versioned in its own name.
sw.addEventListener("install", (event) => {
  event.waitUntil(sw.skipWaiting());
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("fetch", (event) => {
  if (!isIconRequest(event.request)) return;
  event.respondWith(handle(event.request));
});
