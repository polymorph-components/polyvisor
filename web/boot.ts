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
// `state` on it, so the returning load is this same bundle — in a window
// that has an opener and nothing else to do. It hands the two parameters to
// the opener and closes.
//
// `location.origin` as the target, not `"*"`: the redirect landed on this
// origin, so the opener is on it too, and naming it means a one-shot
// authorization code is never posted into a window that turned out to be
// somewhere else.
//
// Then the module PARKS. Everything below this block is the visor's boot —
// a SharedWorker, a device, a mounted component — and none of it belongs in
// a window that exists for one message. `window.close()` does not stop the
// synchronous code that follows it, so the stop has to be explicit; a
// top-level await that never settles is exactly that, and it leaves the
// rest of the module unevaluated rather than merely unused.
// ---------------------------------------------------------------------------

const returned = popupReturn(location.search);
if (returned !== undefined && globalThis.opener !== null) {
  globalThis.opener.postMessage(
    { t: "oauth", code: returned.code, state: returned.state },
    location.origin,
  );
  globalThis.close();
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

/** What the e2e scenarios read (`visor-and-frame-without-jspi`): the page's own
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

/** The anchored device id, minting and anchoring a fresh one if this tab has
 * none. 16 random bytes as hex: the id is only ever an opaque name. */
function deviceId(): string {
  const anchored = sessionStorage.getItem(ANCHOR);
  if (anchored !== null && anchored !== "") return anchored;
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
      homeOrigin: location.origin,
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
const apps = kernel[I.apps] as {
  component(session: number): Promise<ComponentArtifacts>;
  abort(session: number, reason: string): Promise<void>;
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
 * `<link href>` resolves to a blob URL).
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
    "img-src blob:",
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

/** One listener for every frame's lifetime traffic, registered once: a
 * listener per frame would outlive the frame it closed over. The frame
 * cannot state its session — `ev.source` identifies it, and `frames` says
 * which session that window is (internal.wit header: "Caller identity is
 * supplied by the glue from the port a call arrived on, never taken from
 * the caller"). */
globalThis.addEventListener("message", (ev: MessageEvent) => {
  if ((ev.data as { t?: string })?.t !== "error") return;
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

async function openFrame(session: number, srcdoc: string): Promise<void> {
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
}

function closeFrame(session: number): void {
  frames.get(session)?.remove();
  frames.delete(session);
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
    openFrame: (session: number) =>
      openFrame(session, srcdoc).catch((err: unknown) => {
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
    // Also sync. Re-anchoring is all this does — the worker is named after
    // the anchor, so the reload is what actually moves the tab to the other
    // device (docs/design.md "Devices": "Switching devices is a reload").
    // `none` drops the anchor, and the next boot mints a fresh id.
    switchDevice: (target: string | undefined) => {
      if (target === undefined) sessionStorage.removeItem(ANCHOR);
      else sessionStorage.setItem(ANCHOR, target);
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
    // Three ways this resolves, and `none` is two of them:
    //
    //   * the popup returned to this page's URL and the returning load
    //     posted us the pair (the block at the top of this module) — the
    //     only `some`;
    //   * the user closed the window, which nothing notifies us of, so it
    //     is polled: `popup.closed` every 500 ms, as internal.wit's "`none`
    //     if the user closed it" requires something to notice;
    //   * the browser refused to open a window at all — a popup blocker,
    //     or a call not made from a user gesture. Indistinguishable from a
    //     window closed at once, and `none` is the same honest answer: no
    //     code came back.
    openPopup: (url: string): Promise<[string, string] | undefined> =>
      new Promise((resolve) => {
        const popup = globalThis.open(
          url,
          "polyvisor-oauth",
          "popup,width=520,height=640",
        );
        if (popup === null) {
          resolve(undefined);
          return;
        }
        let settled = false;
        const finish = (answer: [string, string] | undefined) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          globalThis.removeEventListener("message", onMessage);
          // The returning page closes itself; this covers the paths where
          // it did not get that far, so a ceremony that ended one way or
          // another never leaves a window standing.
          try {
            popup.close();
          } catch {
            // Already gone.
          }
          resolve(answer);
        };
        const onMessage = (ev: MessageEvent) => {
          // Same-origin only, and only from the window we opened: the
          // message carries a one-shot authorization code, and any page may
          // post to an opener.
          if (ev.origin !== location.origin || ev.source !== popup) return;
          const data = ev.data;
          if (typeof data !== "object" || data === null) return;
          if ((data as { t?: string }).t !== "oauth") return;
          const { code, state } = data as { code: string; state: string };
          finish([String(code), String(state)]);
        };
        globalThis.addEventListener("message", onMessage);
        const poll = setInterval(() => {
          if (popup.closed) finish(undefined);
        }, 500);
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
