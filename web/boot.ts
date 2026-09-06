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
import { proxyInterfaces } from "./rpc.ts";

const I = {
  device: "polyvisor:internal/device@0.1.0",
  apps: "polyvisor:internal/apps@0.1.0",
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

/** The framework's own voice, for when there are no trusted pixels to say
 * it with: the visor could not be brought up. */
function fatal(message: string): void {
  const visor = document.getElementById("visor");
  if (visor !== null) {
    visor.textContent = `This device could not start its visor. ${message}`;
  }
  console.error("polyvisor: fatal:", message);
}

// ---------------------------------------------------------------------------
// The control port
// ---------------------------------------------------------------------------

// A MODULE worker: the bundle keeps `import.meta.url` (polyengine's realm
// identity), which is a syntax error in a classic worker.
const worker = new SharedWorker("./worker.js", {
  type: "module",
  name: "polyvisor",
});
const control = worker.port;

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

const kernel = proxyInterfaces(control, [I.device, I.apps, I.events]);
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
  };

  // No policy: the visor IS the trusted pixels (docs/design.md "Realms").
  await mountProducer({
    source: artifactsFromEnvelope(visor.plan, visor.wasm),
    root: el("visor"),
    imports: { ...kernel, [I.shell]: shell },
    onError: (err) => fatal(String((err as Error)?.message ?? err)),
  });
}

main().catch((err: unknown) => fatal(String((err as Error)?.message ?? err)));
