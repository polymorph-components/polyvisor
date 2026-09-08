// The main thread: the visor's realm, and the only code that touches the
// page (internal.wit "Realms" — "visor component — main thread").
//
// It connects the device's SharedWorker, proxies the three kernel
// interfaces over that control port, implements `shell` locally, and mounts
// the visor as a stream-dom producer into `#visor`. App frames go into
// `#app-zone`; the visor never sees them, it only asks for them.

import { artifactsFromEnvelope } from "@polyengine/runtime/embedder";
import { ComponentException } from "@polyengine/protocol";

import { mountProducer } from "./mount.ts";
import { popupReturn } from "./oauth.ts";
import { proxyInterfaces } from "./rpc.ts";

// ---------------------------------------------------------------------------
// The returning half of the storage ceremony (internal.wit
// `shell.open-popup`)
//
// The provider redirects the popup back to THIS page's URL with `code` and
// `state` on it (or with `error` and `state`, the user having declined), so
// the returning load is this same bundle — in a window with nothing else to
// do. It reports the outcome and gets out of the way.
//
// It reports over a BroadcastChannel, not to an opener: we open the popup
// with `noopener` (docs/design.md "Windows and handles"), so there is no
// opener to post to and nothing on either side holds a handle to the other.
// A BroadcastChannel is same-origin by construction — no origin argument to
// get wrong, and no other origin can subscribe — but it reaches EVERY tab of
// this origin, so the message carries the ceremony's `state` and the waiting
// side matches it against the state of the URL it opened. That is what keeps
// one tab's ceremony from settling another's.
//
// Then the module PARKS. Everything below this block is the visor's boot —
// a SharedWorker, a device, a mounted component — and none of it belongs in
// a window that exists for one message. `window.close()` does not stop the
// synchronous code that follows it, so the stop has to be explicit; a
// top-level await that never settles is exactly that, and it leaves the
// rest of the module unevaluated rather than merely unused.
// ---------------------------------------------------------------------------

const CEREMONY_CHANNEL = "polyvisor.oauth";

// ---------------------------------------------------------------------------
// The browser's own install prompt (internal.wit `shell.install-app`)
//
// Chromium fires `beforeinstallprompt` once, early, and only if the page is
// still listening synchronously when it does — a handler added later (e.g.
// from inside `installApp`, once the user has actually asked to install)
// can simply miss it, and there is no way to ask the browser to fire it
// again. So it is captured here, at module top, before anything else runs
// (including the returning-popup and framed-window early-outs above this
// comment, which is fine: those windows never call `installApp` and the
// listener is inert if they park or refuse). `preventDefault` defers the
// browser's own mini-infobar so `installApp` decides when to call
// `.prompt()` instead of the browser deciding on its own schedule.
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let deferredInstall: BeforeInstallPromptEvent | undefined;

addEventListener("beforeinstallprompt", (e: Event) => {
  e.preventDefault();
  deferredInstall = e as BeforeInstallPromptEvent;
});

const returned = popupReturn(location.search);
if (returned !== undefined) {
  const channel = new BroadcastChannel(CEREMONY_CHANNEL);
  channel.postMessage(
    returned.kind === "code"
      ? { t: "oauth", state: returned.state, code: returned.code }
      : { t: "oauth", state: returned.state, declined: true },
  );

  // A window opened with `noopener` is script-closable only while its
  // session history has one entry, and the provider's consent flow is
  // several navigations — so `close()` works against the e2e fake's single
  // 302 and will not work against Google. There is no way to ask which
  // happened; the window either went away and this timer never fires, or it
  // is still here and the framework says the one true thing left to say.
  globalThis.close();
  setTimeout(() => {
    const visor = document.getElementById("visor");
    if (visor !== null) visor.textContent = "You can close this window.";
  }, 500);

  await new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// The window this visor will not boot in (docs/design.md "Windows and
// handles")
//
// A document that holds a WindowProxy to this window can navigate it
// cross-origin at any moment, which is trusted pixels under someone else's
// control. Two holders: a parent (we are framed) and an opener (someone
// called `window.open` on us).
//
// The opener test is ONE-SIDED. A positive is reliable; a null is not — an
// opener can null its popup's `opener` on the initial about:blank and then
// navigate it here, and its handle keeps working. So this catches the naive
// case only. COOP `same-origin` on the home origin is the general form and
// is an optional deployment enhancement, never a requirement (GitHub Pages
// cannot set headers, and `<meta>` does not carry COOP).
//
// Browsers have defaulted `target=_blank` to `noopener` since ~2020, so a
// non-null opener today means someone opened us on purpose.
//
// Placed above everything: the refusing window reads no device anchor, names
// no worker and mounts nothing personal. The returning half above ran first
// and parked, which is what keeps a returning popup — top-level, and with no
// opener since we open it `noopener` — from tripping this.
// ---------------------------------------------------------------------------

if (self !== top || globalThis.opener !== null) {
  const visor = document.getElementById("visor");
  if (visor !== null) {
    visor.textContent =
      "This window is not this visor's own: something else can navigate it, " +
      "so nothing of yours is shown here.";
    const button = document.createElement("button");
    button.id = "visor-reopen";
    button.textContent = "Open the visor in its own window";
    // A user gesture, because that is what a popup blocker wants; and
    // `noopener` so the fresh browsing context has no handle-holder at all —
    // not the page that framed us, not this window either. The refusing
    // window is left exactly as it is: blanking it would undo nothing a
    // handle-holder could not redo.
    button.addEventListener("click", () => {
      globalThis.open(location.href, "_blank", "noopener");
    });
    visor.append(button);
  }
  await new Promise<never>(() => {});
}

const I = {
  device: "polyvisor:internal/device@0.1.0",
  store: "polyvisor:internal/store@0.1.0",
  apps: "polyvisor:internal/apps@0.1.0",
  sync: "polyvisor:internal/sync@0.1.0",
  pairing: "polyvisor:internal/pairing@0.1.0",
  storage: "polyvisor:internal/storage@0.1.0",
  events: "polyvisor:internal/events@0.1.0",
  shell: "polyvisor:internal/shell@0.1.0",
} as const;

interface ComponentArtifacts {
  wasm: Uint8Array;
  plan: string;
}

/** What the e2e scenarios read (`instantiates-without-jspi`): the page's own
 * record that the worker got its runtime up, which the main thread cannot
 * see any other way. */
const marks: { workerBooted: boolean } = {
  workerBooted: false,
};
(globalThis as Record<string, unknown>).__polyvisor = marks;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id} in index.html`);
  return node;
}

/** The last fatal, if there was one. Also the flag `main` checks: a fatal
 * that landed while the visor was still being fetched or mounted must not be
 * painted over by the mount that followed it. */
let fatalMessage: string | undefined;

function paintFatal(): void {
  if (fatalMessage === undefined) return;
  const visor = document.getElementById("visor");
  if (visor !== null) {
    visor.textContent =
      `This device could not start its visor. ${fatalMessage}`;
  }
}

/** The framework's own voice, for when there are no trusted pixels to say
 * it with: the visor could not be brought up. */
function fatal(message: string): void {
  fatalMessage = message;
  paintFatal();
  console.error("polyvisor: fatal:", message);
}

// ---------------------------------------------------------------------------
// The control port
// ---------------------------------------------------------------------------

/** The tab's device anchor (docs/design.md "Devices": "the glue owns only
 * what has to exist before the kernel does: the device id ... because the
 * worker is named after it"). sessionStorage, not localStorage: the anchor
 * is per tab, so two tabs of the same profile can hold two devices and
 * `shell.switch-device` is a reload of one of them. */
const ANCHOR = "polyvisor.device";

/** The last device this profile saw promoted to durable (docs/design.md
 * "Devices", last bullet). localStorage, not sessionStorage: it is shared by
 * every tab of the origin, which is the point — a fresh tab with no anchor
 * of its own adopts it instead of minting "new tab, new stranger". Written
 * from `device.status`, read here, cleared only by an explicit
 * `switch-device(none)`. */
const LAST = "polyvisor.last-device";

/** The anchored device id: this tab's own anchor if it has one, else the
 * profile's last kept device (adopted and anchored here so the rest of this
 * tab's life reads the same sessionStorage path), else a fresh mint. 16
 * random bytes as hex: the id is only ever an opaque name. */
function deviceId(): string {
  const anchored = sessionStorage.getItem(ANCHOR);
  if (anchored !== null && anchored !== "") return anchored;
  const last = localStorage.getItem(LAST);
  if (last !== null && last !== "") {
    sessionStorage.setItem(ANCHOR, last);
    return last;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  sessionStorage.setItem(ANCHOR, fresh);
  return fresh;
}

const device = deviceId();

// A MODULE worker: the bundle keeps `import.meta.url` (polyengine's realm
// identity), which is a syntax error in a classic worker.
//
// The NAME is what makes one SharedWorker per device: two tabs anchored to
// the same id connect to the same worker, and a tab anchored elsewhere gets
// its own. `type` and the URL are part of the identity too, but the name is
// the only part that varies.
const worker = new SharedWorker("./worker.js", {
  type: "module",
  name: `polyvisor:${device}`,
});
const control = worker.port;

// A worker that dies on its own script is otherwise SILENT: `onconnect`
// never fires, the hello sits unread, and the visor waits on `workerBooted`
// forever with nothing to say why. This is the page's only notification, so
// it is the difference between a diagnosis and a hang.
//
// It is not a complete net. Chromium fires nothing at all for a module
// SharedWorker that fails to *start* — the failure this milestone spent its
// afternoon on (see web/platform/no-node-datachannel.ts) presented exactly
// that way. This catches the case it can: a script that throws while
// evaluating.
worker.addEventListener("error", (ev: Event) => {
  const e = ev as ErrorEvent;
  fatal(
    `this device's worker could not start: ${
      e.message || "the browser refused the worker script"
    }${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`,
  );
});

// First message on the port, before any RPC: the worker boots its runtime
// against the device the FIRST hello names (`lifecycle.boot-config.device`).
// A later hello for the same id is a no-op — that is just another tab.
//
// The relay comes with it. It is the home origin's deployment configuration
// (`config.json`, written by web/build.ts; the e2e harness serves its own),
// not something a tab may choose, and `lifecycle.boot-config.relay` is not
// optional — a device with no relay binds no endpoint and can never be
// dialed. So a config that will not load is fatal rather than a default
// quietly substituted here: silently binding a whole origin's devices to
// some other relay than the one the operator published is worse than a
// visible failure.
fetch(new URL("config.json", location.href), { cache: "no-store" })
  .then(async (res) => {
    if (!res.ok) {
      throw new Error(`config.json: the origin answered ${res.status}`);
    }
    const config = await res.json() as {
      relay?: unknown;
      drive_api?: unknown;
      drive_oauth?: unknown;
    };
    const relay = config.relay;
    if (typeof relay !== "string" || relay === "") {
      throw new Error("config.json names no relay");
    }
    // Optional, unlike the relay: `none` is Google's own bases
    // (`lifecycle.boot-config.drive-api`/`drive-oauth`), and a home origin
    // that publishes neither is the ordinary deployment. Only a string is
    // passed on — anything else in the file is a configuration this glue
    // will not silently interpret.
    const optional = (v: unknown): string | undefined =>
      typeof v === "string" && v !== "" ? v : undefined;
    control.postMessage({
      t: "hello",
      device,
      // The directory this page is served from, not `location.origin`: a
      // GitHub Pages project site lives under `/<repo>/`, and the kernel
      // fetches `{home-origin}/apps/...`, so the prefix must be kept.
      homeOrigin: new URL(".", location.href).href.replace(/\/$/, ""),
      relay,
      // The OAuth redirect (`lifecycle.boot-config.page-url`): this page's
      // URL without query or fragment, which is where the popup comes back
      // to. The kernel needs it to build the authorization URL and again
      // to exchange the code, and only the page knows it.
      pageUrl: location.origin + location.pathname,
      driveApi: optional(config.drive_api),
      driveOauth: optional(config.drive_oauth),
    });
  })
  .catch((err: unknown) => {
    fatal(
      `this origin's configuration could not be read: ` +
        String((err as Error)?.message ?? err),
    );
  });

/** Frame-port replies, keyed by session: `shell.open-frame` awaits one. */
const framePortWaiters = new Map<
  number,
  { resolve(p: MessagePort): void; reject(e: unknown): void }
>();

control.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data;
  if (typeof data !== "object" || data === null) return;
  const t = (data as { t?: string }).t;
  if (t === "booted") {
    marks.workerBooted = true;
  } else if (t === "fatal") {
    fatal(String((data as { message: string }).message));
  } else if (t === "frame-port" || t === "frame-port-failed") {
    const session = (data as { session: number }).session;
    const waiter = framePortWaiters.get(session);
    if (waiter === undefined) return;
    framePortWaiters.delete(session);
    if (t === "frame-port") {
      waiter.resolve((data as { port: MessagePort }).port);
    } else waiter.reject(new Error((data as { message: string }).message));
  }
});

const kernel = proxyInterfaces(control, [
  I.device,
  I.store,
  I.apps,
  I.sync,
  I.pairing,
  I.storage,
  I.events,
]);

// The other end of the LAST pointer: `device.status`'s `tier` is the kernel's
// only word on whether this device has been kept (runtime/wit internal.wit
// "Lifecycle": `enum tier { ephemeral, durable }`, and on the wire an enum is
// its kebab-case case name as a plain string — bindgen's codegen.rs, "enum =
// string literal union of kebab-case case names"). `ephemeral` devices are
// swept, so only `durable` is worth remembering across tabs; every other
// `device` method passes straight through the proxy underneath.
const rawDevice = kernel[I.device] as Record<string, unknown>;
kernel[I.device] = new Proxy(rawDevice, {
  get(target, key, receiver) {
    if (key !== "status") return Reflect.get(target, key, receiver);
    return async (...args: unknown[]) => {
      const result = await (target.status as (...a: unknown[]) => Promise<
        { tier?: string }
      >)(...args);
      if (result?.tier === "durable") localStorage.setItem(LAST, device);
      return result;
    };
  },
});

const apps = kernel[I.apps] as {
  component(session: number): Promise<ComponentArtifacts>;
  abort(session: number, reason: string): Promise<void>;
  routeEncode(session: number, route: string): Promise<string>;
};

function requestFramePort(session: number): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    framePortWaiters.set(session, { resolve, reject });
    control.postMessage({ t: "frame-port", session });
  });
}

// ---------------------------------------------------------------------------
// The frame loader
// ---------------------------------------------------------------------------

function base64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * The constant, hash-pinned srcdoc every app frame loads
 * (internal.wit `shell.open-frame`).
 *
 * `default-src 'none'` plus a script-src that names exactly one hash: the
 * frame can run this loader and nothing else, and — with no `connect-src` —
 * cannot reach the network at all. Everything it renders comes down the
 * mutation stream or out of a `blob:` the parent minted, which is why
 * `style-src` allows `blob:` (the app bundle's stylesheet is an asset, so
 * `<link href>` resolves to a blob URL). `img-src` also allows `data:`: the
 * bytes of a `data:` URL are inline in whatever names it — here, the
 * stylesheet's `background-image` SVGs — so nothing leaves the frame. An
 * `<img src="data:...">` from the app is still refused, by the receiver
 * policy (web/policy.ts: URL-kind attributes take asset handles only), not
 * by this CSP.
 *
 * The hash covers the exact text between the tags INCLUDING the two
 * newlines, because that is what the browser hashes.
 */
async function frameSrcdoc(frameJs: string): Promise<string> {
  const script = `\n${frameJs}\n`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(script),
  );
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${base64(digest)}' 'wasm-unsafe-eval'`,
    "style-src blob:",
    "img-src blob: data:",
    "font-src blob:",
    "media-src blob:",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta charset=utf-8></head><body>` +
    // `type=module` for the same reason the worker is one: the bundle keeps
    // `import.meta.url`. A CSP hash-source matches an inline module script
    // exactly as it matches a classic one.
    `<script type="module">${script}</script></body></html>`;
}

const frames = new Map<number, HTMLIFrameElement>();

/** Which session's route currently owns the page's URL fragment, or
 * `undefined` when no open frame has written one yet. `close-frame` clears
 * the fragment only when the closing session is this one — internal.wit
 * `shell`: "the URL bar belongs to the one open session, and the glue owns
 * it" — so a session that never wrote a fragment (or one that lost the bar
 * to a later frame, which "at most one frame per session" makes impossible
 * anyway) does not clear someone else's bookmark on its way out. */
let fragmentOwner: number | undefined;

/** `history.replaceState` only — never `pushState` (internal.wit `shell`:
 * "an app never gets a history entry"). */
function writeFragment(session: number, fragment: string): void {
  fragmentOwner = session;
  history.replaceState(null, "", "#" + fragment);
}

function clearFragment(session: number): void {
  if (fragmentOwner !== session) return;
  fragmentOwner = undefined;
  history.replaceState(null, "", location.pathname + location.search);
}

/** One listener for every frame's lifetime traffic, registered once: a
 * listener per frame would outlive the frame it closed over. The frame
 * cannot state its session — `ev.source` identifies it, and `frames` says
 * which session that window is (internal.wit header: "Caller identity is
 * supplied by the glue from the port a call arrived on, never taken from
 * the caller"). */
globalThis.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as { t?: string };
  if (data?.t === "route") {
    onFrameRoute(ev.source, String((data as { route: string }).route));
    return;
  }
  if (data?.t !== "error") return;
  let ended: number | undefined;
  for (const [session, iframe] of frames) {
    if (ev.source === iframe.contentWindow) ended = session;
  }
  if (ended === undefined) return;
  const message = String((ev.data as { message: string }).message);
  console.error(`polyvisor: session ${ended} frame failed:`, message);
  // The frame tore itself down (a policy rejection, a decode failure, a
  // mount that never completed). Take the iframe out first, then tell the
  // kernel: `apps.abort` ends the session and emits `session-ended`, which
  // is how every visor — including this tab's — learns of it.
  closeFrame(ended);
  void apps.abort(ended, `the app's frame was closed: ${message}`).catch(
    (err: unknown) => {
      console.error("polyvisor: abort failed:", (err as Error)?.message ?? err);
    },
  );
});

/** Pending `route.set` relays, keyed by session: coalesced so a burst of
 * clicks (TodoMVC's filter, e.g.) writes the encoder once per settle rather
 * than once per click. 250ms: fast enough that a bookmark taken right after
 * a click is fresh, slow enough that a click storm does not spend a
 * `route-encode` (an AES-GCM seal) per keystroke. */
const routeDebounce = new Map<number, number>();

/** The newest encode asked for per session. Encodes are not ordered by the
 * kernel — the first one on a device also mints the route key and
 * checkpoints, so it can land after a `route.set` that followed it — and an
 * older answer arriving later must not put an older route in the bar. */
const routeSeq = new Map<number, number>();

/** Encode `route` for `session` and, if it is still the newest ask and the
 * frame is still up, write it to the bar. */
function encodeFragment(session: number, route: string): void {
  const seq = (routeSeq.get(session) ?? 0) + 1;
  routeSeq.set(session, seq);
  void apps.routeEncode(session, route).then((fragment) => {
    if (!frames.has(session) || routeSeq.get(session) !== seq) return;
    writeFragment(session, fragment);
  }).catch((err: unknown) => {
    console.error(
      "polyvisor: route-encode failed:",
      (err as Error)?.message ?? err,
    );
  });
}

function onFrameRoute(source: MessageEventSource | null, route: string): void {
  let session: number | undefined;
  for (const [s, iframe] of frames) {
    if (source === iframe.contentWindow) session = s;
  }
  if (session === undefined) return; // frame already gone
  // The kernel refuses a route over its length cap (`refused`, 238 UTF-8
  // bytes: internal.wit `apps.route-encode`) — dropped here rather than
  // sent, so a bug in an app's own route does not spend a round trip on a
  // call whose answer is already known.
  if (new TextEncoder().encode(route).length > 238) {
    console.warn(
      `polyvisor: session ${session} set a route over the encoder's cap; ignored`,
    );
    return;
  }
  const existing = routeDebounce.get(session);
  if (existing !== undefined) clearTimeout(existing);
  routeDebounce.set(
    session,
    setTimeout(() => {
      routeDebounce.delete(session);
      encodeFragment(session, route);
    }, 250) as unknown as number,
  );
}

async function openFrame(
  session: number,
  route: string,
  srcdoc: string,
): Promise<void> {
  if (frames.has(session)) return; // at most one frame per session
  const [artifacts, port] = await Promise.all([
    apps.component(session),
    requestFramePort(session),
  ]);

  const iframe = document.createElement("iframe");
  iframe.dataset.session = String(session);
  // No `allow-same-origin`: the frame is an opaque origin, so nothing on
  // this side can reach into its document and it has no storage of its own.
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.srcdoc = srcdoc;

  // A srcdoc frame cannot be messaged before its script has run, and there
  // is no `load` event ordering that fixes that — so the loader announces
  // itself and we answer. Registered before the frame is in the document.
  await new Promise<void>((resolve) => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      const data = ev.data;
      if (typeof data !== "object" || data === null) return;
      const t = (data as { t?: string }).t;
      if (t === "ready") {
        globalThis.removeEventListener("message", onMessage);
        iframe.contentWindow!.postMessage(
          {
            t: "mount",
            wasm: artifacts.wasm,
            plan: artifacts.plan,
            port,
            route,
          },
          // The frame's origin is opaque; "*" is the only target that names
          // it, and it is safe because `ev.source` identified the recipient.
          "*",
          [port],
        );
        resolve();
      }
    };
    globalThis.addEventListener("message", onMessage);
    el("app-zone").append(iframe);
  });

  frames.set(session, iframe);

  // The fragment for the state the frame was actually opened at — a plain
  // launch ("") encodes just as well as a bookmarked one, so the URL always
  // ends up naming this session once the frame is up, not only once the app
  // has since called `route.set`. Not awaited: `open-frame` returning is
  // what lets the visor record the session, and the first encode on a
  // device also mints its route key and checkpoints — long enough that a
  // frame which dies at mount (the hostile fixture) would report
  // `session-ended` for a session the visor had not yet heard of.
  encodeFragment(session, route);
}

function closeFrame(session: number): void {
  frames.get(session)?.remove();
  frames.delete(session);
  const pending = routeDebounce.get(session);
  if (pending !== undefined) {
    clearTimeout(pending);
    routeDebounce.delete(session);
  }
  routeSeq.delete(session);
  clearFragment(session);
}

// ---------------------------------------------------------------------------
// Installing a launch (internal.wit `shell.install-app`, docs/design.md
// "Routing", the `launch/` bullet)
// ---------------------------------------------------------------------------

interface InstallRequest {
  fragment: string;
  title: string;
  glyph: string;
  hue: number;
}

/** The blob URL our own `<link rel=manifest>` currently points at, so a
 * later install can revoke it. Never revokes a URL this glue did not mint —
 * there is none to inherit; `index.html` carries no such link. */
let manifestBlobUrl: string | undefined;

/** One 512×512 (or `size`, scaled) PNG of the app's glyph on the user's hue,
 * as a `blob:` URL. This is the one place the trusted pixels reach the
 * launcher (internal.wit `shell.install-app` docs) — an installed app's
 * icon is not app-controlled art, it is the visor's own paint of the
 * user's labels for it, exactly as the strip button beside it is. */
function paintIcon(glyph: string, hue: number, size: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Same formula as the strip's own hue paint (visor/src/style.rs
  // `--strip: oklch(0.62 0.14 var(--hue))`), so an installed app's icon
  // reads as the same colour as its button in the strip it came from.
  ctx.fillStyle = `oklch(0.62 0.14 ${hue})`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "white";
  ctx.font = `${Math.round(size * 0.6)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, size / 2, size / 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("the browser refused to encode the app icon"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

async function installApp(
  request: InstallRequest,
): Promise<"prompted" | "manual"> {
  // Absolute against the page's own base — never `/`, which on a GitHub
  // Pages project site names somebody else's page (docs/design.md
  // "Routing"). `base` is the directory this page is served from, the same
  // one the OAuth return and the worker's `homeOrigin` use. `id` is derived
  // from the fragment alone (not `start_url`, which a future kind's fragment
  // grammar might vary in ways that should not mint a new installed app for
  // the same package) so the same package on the same origin is the same
  // installed app on every device, per the design's `launch/` bullet.
  const base = new URL(".", location.href);
  const startUrl = new URL("#" + request.fragment, base).href;
  const scope = base.href;
  const id = new URL(request.fragment, base).href;

  const [icon512, icon192] = await Promise.all([
    paintIcon(request.glyph, request.hue, 512),
    paintIcon(request.glyph, request.hue, 192),
  ]);
  const themeColor = `oklch(0.62 0.14 ${request.hue})`;

  const manifest = {
    name: `${request.title} — polyvisor`,
    short_name: request.title,
    display: "standalone",
    start_url: startUrl,
    scope,
    id,
    icons: [
      { src: icon512, sizes: "512x512", type: "image/png" },
      { src: icon192, sizes: "192x192", type: "image/png" },
    ],
    theme_color: themeColor,
    background_color: "#ffffff",
  };

  const manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }),
  );

  let link = document.querySelector<HTMLLinkElement>("link[rel=manifest]");
  if (link === null) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.append(link);
  }
  // Revoke only a URL this glue minted — a previous install's blob, not
  // whatever (nothing, today) `index.html` shipped the link pointing at.
  if (manifestBlobUrl !== undefined) URL.revokeObjectURL(manifestBlobUrl);
  manifestBlobUrl = manifestUrl;
  // A prompt the browser offered earlier was offered for the manifest that
  // was in place then — another app's, if this is the second install of the
  // visit — so it goes with that manifest, and the one that counts is
  // whatever the browser offers for this one. Chromium re-evaluates
  // installability when the link changes and fires a fresh
  // `beforeinstallprompt`; a bounded wait catches it, and none in time means
  // the browser is not offering one (already installed, or no such event),
  // which is `manual`.
  deferredInstall = undefined;
  link.href = manifestUrl;
  const offered = await new Promise<BeforeInstallPromptEvent | undefined>(
    (resolve) => {
      const poll = setInterval(() => {
        if (deferredInstall === undefined) return;
        clearInterval(poll);
        resolve(deferredInstall);
      }, 50);
      setTimeout(() => {
        clearInterval(poll);
        resolve(undefined);
      }, 2_000);
    },
  );
  if (offered === undefined) return "manual";
  deferredInstall = undefined;
  await offered.prompt();
  return "prompted";
}

// ---------------------------------------------------------------------------
// Bring-up
// ---------------------------------------------------------------------------

async function fetchArtifacts(name: string): Promise<ComponentArtifacts> {
  const [wasmRes, planRes] = await Promise.all([
    fetch(`./${name}.component.wasm`),
    fetch(`./${name}.component.plan.json`),
  ]);
  if (!wasmRes.ok || !planRes.ok) {
    throw new Error(
      `${name} component unavailable (${wasmRes.status}/${planRes.status})`,
    );
  }
  return {
    wasm: new Uint8Array(await wasmRes.arrayBuffer()),
    plan: await planRes.text(),
  };
}

async function main(): Promise<void> {
  const frameJsRes = await fetch("./frame.js");
  if (!frameJsRes.ok) throw new Error("frame loader unavailable");
  const srcdoc = await frameSrcdoc(await frameJsRes.text());

  const visor = await fetchArtifacts("visor");

  const shell = {
    // `open-frame` returns `result<_, error>`: its error arm is the WIT
    // `types.error` record, which reaches the guest only as a
    // `ComponentException` payload (M1 context "Value mapping"). A raw
    // rejection would be a host fault instead of the refusal the WIT
    // declares.
    openFrame: (session: number, route: string) =>
      openFrame(session, route, srcdoc).catch((err: unknown) => {
        throw new ComponentException({
          code: "failed",
          message: String((err as Error)?.message ?? err),
        });
      }),
    closeFrame: (session: number) => {
      closeFrame(session);
      return Promise.resolve();
    },
    // `shell.reload` is the one sync func in internal.wit: it must not
    // return a promise.
    reload: () => {
      location.reload();
    },
    // Also sync (internal.wit `shell.fragment`). `""` and `"#"` both read as
    // `undefined`: `location.hash` is `""` with none, and is `"#"` for a
    // literal bare `#` — neither names a fragment `apps.route-decode` could
    // ever accept, so there is nothing to hand it.
    fragment: (): string | undefined => {
      const hash = location.hash;
      return hash === "" || hash === "#" ? undefined : hash.slice(1);
    },
    // Also sync. Re-anchoring is all this does — the worker is named after
    // the anchor, so the reload is what actually moves the tab to the other
    // device (docs/design.md "Devices": "Switching devices is a reload").
    // `none` drops the anchor AND the LAST pointer (an explicit new device,
    // per the design's "or an explicit switch-device(none), which clears the
    // pointer too") so the next boot mints a fresh id rather than adopting
    // the one just left; switching TO a named target leaves LAST alone —
    // `device.status` after the reload rewrites it if that target is
    // durable, and if it isn't, LAST still names whatever this profile's
    // last durable device was.
    switchDevice: (target: string | undefined) => {
      if (target === undefined) {
        sessionStorage.removeItem(ANCHOR);
        localStorage.removeItem(LAST);
      } else sessionStorage.setItem(ANCHOR, target);
      location.reload();
    },
    // A window capability, asked at the moment a device is kept. `false` is
    // an honest answer, not a failure: internal.wit says the device is
    // durable regardless, only more evictable. Browsers without the API
    // (and insecure contexts, where `navigator.storage` is absent) answer
    // the same way.
    requestPersistence: async (): Promise<boolean> => {
      try {
        return await navigator.storage?.persist?.() ?? false;
      } catch {
        return false;
      }
    },
    // The ceremony's browser half (internal.wit `shell.open-popup`): a
    // window is a page capability, so the kernel never sees one — it mints
    // the URL, this opens it, and the two parameters that come back are all
    // that crosses.
    //
    // `noopener`, per docs/design.md "Windows and handles": the popup must
    // not hold a handle to these trusted pixels, and a provider's page is
    // exactly the sort of live content that must not. The cost is that
    // `open` returns null, so we have no handle either — no `popup.closed`
    // to poll, no `ev.source` to check a message against. The returning load
    // therefore reports over a same-origin BroadcastChannel, and what stands
    // in for "the window we opened" is the `state` in the URL we just
    // handed out: a broadcast from another tab's ceremony, or a stale one,
    // names a different state and is ignored here.
    //
    // Three ways this resolves, and `none` is two of them:
    //
    //   * the popup returned to this page's URL with a code for this
    //     ceremony (the block at the top of this module broadcast it) — the
    //     only `some`;
    //   * the user declined consent, which the provider redirects back as
    //     `error`+`state` and the returning load broadcasts too;
    //   * nothing came back inside the bound. That covers the user closing
    //     the window — which nothing can notify us of, having no handle —
    //     and a browser that refused to open one at all. Ten minutes: long
    //     enough for a real consent screen, and a provider's code does not
    //     outlive it anyway.
    openPopup: (url: string): Promise<[string, string] | undefined> =>
      new Promise((resolve) => {
        // Whatever the kernel put in the URL it minted. A URL with no state
        // is not a ceremony this glue can attribute an answer to, and the
        // empty string matches nothing a returning load can broadcast
        // (web/oauth.ts requires a non-empty state).
        const wanted = new URL(url, location.href).searchParams.get("state") ??
          "";
        const channel = new BroadcastChannel(CEREMONY_CHANNEL);
        let settled = false;
        const finish = (answer: [string, string] | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(bound);
          channel.close();
          resolve(answer);
        };
        channel.addEventListener("message", (ev: MessageEvent) => {
          const data = ev.data;
          if (typeof data !== "object" || data === null) return;
          const msg = data as {
            t?: string;
            state?: string;
            code?: string;
            declined?: boolean;
          };
          if (msg.t !== "oauth") return;
          // The ceremony this call opened, and no other: `state` is the only
          // thing left that says which window a broadcast came from.
          if (wanted === "" || msg.state !== wanted) return;
          if (msg.declined === true) finish(undefined);
          else if (typeof msg.code === "string") finish([msg.code, wanted]);
        });
        const bound = setTimeout(() => finish(undefined), 10 * 60 * 1000);

        // Subscribed before the window is opened: the answer arrives on a
        // channel, and a subscription made afterwards is one that can miss
        // it.
        globalThis.open(url, "_blank", "popup,noopener,width=520,height=640");
      }),
    // internal.wit `shell.install-app`: mints the manifest, points the
    // document at it, and calls whatever install prompt the browser
    // deferred earlier. Errors (icon encoding, most plausibly) surface as
    // the WIT's `result<_, error>` arm, same reasoning as `open-frame`.
    installApp: (request: InstallRequest) =>
      installApp(request).catch((err: unknown) => {
        throw new ComponentException({
          code: "failed",
          message: String((err as Error)?.message ?? err),
        });
      }),
  };

  // A fatal that arrived while the artifacts were being fetched: the worker
  // has told us this tab cannot be served, so there is nothing honest to
  // mount and the framework's text stands.
  if (fatalMessage !== undefined) return;

  // No policy: the visor IS the trusted pixels (docs/design.md "Realms").
  await mountProducer({
    source: artifactsFromEnvelope(visor.plan, visor.wasm),
    root: el("visor"),
    imports: { ...kernel, [I.shell]: shell },
    onError: (err) => fatal(String((err as Error)?.message ?? err)),
  });

  // ...and one that arrived DURING the mount, which paints into the same
  // node. The mount had already claimed the element by then, so the text has
  // to be restated rather than merely flagged.
  paintFatal();
}

main().catch((err: unknown) => fatal(String((err as Error)?.message ?? err)));
