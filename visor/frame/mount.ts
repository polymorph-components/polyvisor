// THE APP-MOUNT SEAM. One function stands a component up on a sandboxed
// surface and hands back the handles a visor needs to drive it: the
// frame element, the exports, route, input suspension, teardown.
//
// WHERE THE APP RUNS: INSIDE THE FRAME (#142, ruled 2026-09-05, measured
// in Chromium 143 and Firefox 144). This file creates the frame,
// assembles its document, and hands the guest's bytes across; the
// instance itself is stood up by frame.ts in the frame's own realm,
// where `polyvisor:surface` binds to the real DOM synchronously. So what
// this module owns is the crossing and nothing else:
//
//   * the frame's document — a `srcdoc` string assembled here from the
//     visor's own fetched assets, carrying a `<meta>` CSP that makes the
//     frame network-dead;
//   * one MessagePort per granted import, served by forwarding to the
//     visor-side implementation the caller passed in;
//   * one control port, over which `Mounted.exports` calls the guest.
//
// WHAT IS GONE: the queued op protocol on the app path. Every DOM call
// used to be serialized into an op array, posted, re-validated and
// applied a realm away. The applier and the queued/channel backends
// remain (../surface/) — the todomvc harness uses them as the
// differential instrument, and the applier's re-validation is still what
// a trusted-territory backend needs — but no app mount touches them.

import { fromCloneable, toCloneable } from "@polyengine/protocol";
import type {
  ControlMsg,
  FrameFaultMsg,
  FrameMsg,
  ImportCall,
  ImportResult,
  MountMsg,
} from "./frame.ts";

// --- the frame's document ---------------------------------------------------
//
// The frame gets no `src`: this module ASSEMBLES its document and hands
// it over as `srcdoc` (#142). A sandboxed frame's navigation is
// invisible to a service worker in both engines, so a real-URL skeleton
// would be served raw by the origin, outside the release-integrity path,
// with whatever headers the host sends — unpinnable. Assembling it here
// means every byte came through the visor's own asset path, and lets us
// insert a <meta> CSP whose `script-src` is a hash of the bundled
// frame.js text.
//
// CONTRACT (#142's correction comment, 2026-09-05): the hash below is
// computed at RUNTIME and lives only in the frame's own meta. That is
// sufficient exactly as long as the visor's page carries no header
// `script-src` — the inherited policy must also admit the inline script,
// and a header cannot know a runtime-assembled hash. When the visor
// starts shipping a header CSP, the same hash has to be emitted into it
// at build/serve time from the same frame.js bytes.

/** Below this the frame is a sliver; a surface that renders nothing at
 * all should still be visible as an empty rectangle rather than shrink
 * to invisible. */
const MIN_HEIGHT_PX = 48;

/** The three texts the frame document is assembled from, at the same
 * relative URLs the template used to reference: they are served
 * alongside whatever page loaded the visor. Fetched in the VISOR's
 * realm — that is what puts them on the same path as every other visor
 * asset, and hence what makes the frame's content pinned. */
const TEMPLATE_URL = "./frame.html";
const STYLE_TAG = `<link rel="stylesheet" href="./todomvc-app.css">`;
const SCRIPT_TAG = `<script type="module" src="./frame.js"></script>`;

/** One assembly per page, shared by every surface. */
let srcdocOnce: Promise<string> | null = null;

function frameSrcdoc(): Promise<string> {
  return (srcdocOnce ??= buildSrcdoc());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function buildSrcdoc(): Promise<string> {
  const [template, css, js] = await Promise.all([
    fetchText(TEMPLATE_URL),
    fetchText("./todomvc-app.css"),
    fetchText("./frame.js"),
  ]);

  // Inlining is by exact tag match against the template, so a template
  // edit that moves an asset fails LOUDLY here instead of yielding a
  // frame that is silently missing its stylesheet or its script.
  for (const tag of [STYLE_TAG, SCRIPT_TAG]) {
    if (!template.includes(tag)) {
      throw new Error(`frame.html no longer contains ${tag}`);
    }
  }
  // An inline script is terminated by the first `</script` in the text,
  // whatever it is nested inside; a bundle containing one would break
  // out of the frame document rather than run.
  if (/<\/script/i.test(js)) {
    throw new Error("frame.js contains </script and cannot be inlined");
  }

  // The hash is over the EXACT text content of the inline <script>
  // element — every byte between the tags, INCLUDING the surrounding
  // newlines. Build that string once and hash the same value we embed.
  const inlineScript = `\n${js}\n`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(inlineScript),
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  // THE RULED POLICY (#142, spikes 3–4 comment). Every directive earns
  // its place:
  //   `wasm-unsafe-eval` — the guest is COMPILED HERE now; without it
  //     `WebAssembly.compile` fails with a CSP CompileError.
  //   `img-src`/`font-src`/`media-src blob:` plus `img-src data:` — the
  //     asset-handle story (bytes in over postMessage, blob: URLs minted
  //     in frame) and TodoMVC's data-URL SVG glyphs. Neither is a
  //     network scheme, so the zero-exfiltration property is untouched.
  //   `form-action 'none'` — with `allow-forms` on the sandbox (below),
  //     the `submit` event fires and `preventDefault()` works; an
  //     un-prevented submission is then blocked by policy rather than
  //     silently never firing at all.
  const meta = `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; script-src 'sha256-${hash}' 'wasm-unsafe-eval'; ` +
    `style-src 'unsafe-inline'; img-src blob: data:; font-src blob:; ` +
    `media-src blob:; form-action 'none'">`;

  // Insert as the first child of <head>, so the policy is in force from
  // the first thing the parser sees after it. Anchored PAST `<html`:
  // the template's leading comment is prose about this very tag, and a
  // naive first-match replace buries the policy inside that comment
  // (where it is inert and invisible — this bit once).
  const headAt = template.indexOf("<head>", template.indexOf("<html"));
  if (headAt < 0) throw new Error("frame.html has no <head> after <html>");
  const withMeta = template.slice(0, headAt) +
    `<head>\n  ${meta}` + template.slice(headAt + "<head>".length);

  return withMeta
    .replace(STYLE_TAG, `<style>\n${css}\n</style>`)
    // `type="module"` is required, not stylistic: `deno bundle` emits
    // `import.meta.url`, which is a syntax error in a classic script.
    // Inline module scripts are hash-addressable in both engines.
    .replace(SCRIPT_TAG, `<script type="module">${inlineScript}</script>`);
}

// --- the seam ---------------------------------------------------------------

export interface AppArtifact {
  envelope: string;
  bytes: Uint8Array;
}

export interface MountOptions {
  container: HTMLElement;
  artifact: AppArtifact;
  /** Every import the app is granted OTHER than polyvisor:surface/*,
   * keyed by verbatim WIT id (e.g. "polyvisor:tasks/tasks@0.1.0").
   * Every method is async (returns a Promise) — which is now a
   * REQUIREMENT rather than an observation: these cross a realm, and
   * the frame stays off JSPI only for as long as they are async-declared
   * in the WIT too (#142, spike 2 finding 1). */
  imports: Record<string, Record<string, unknown>>;
  /** Initial value returned by polyvisor:surface/shell.route(). */
  route?: string;
  theme?: "light" | "dark";
  /** Where a rejected event dispatch goes (today: pane.status / console). */
  onEventError?: (e: unknown) => void;
  /** Run after each event the guest handled successfully.
   *
   * CONTRACT: not in the seam's originally specified shape. The event
   * pump lives inside the mount, so a visor that has to react to the
   * guest having handled an event has no other way to hear about it —
   * and demo.ts's panel does: the binding is LIVE (#22 rule 2), so it
   * re-reads the panel's declared destination after every pumped event.
   *
   * It is ASYNCHRONOUS relative to the frame now: the guest handles the
   * event, the frame posts `event-handled`, and this runs when that
   * message lands. The ORDER is unchanged (never before the guest
   * handled it); what changed is that it is one message later, so it no
   * longer shares a promise chain with the guest call. */
  afterEvent?: () => void | Promise<void>;
  /** CANCELLATION OF A MOUNT THAT IS STILL IN FLIGHT.
   *
   * CONTRACT: also not in the originally specified shape; it is here
   * because that shape cannot express a semantic the callers already
   * have. demo.ts's `mountPanel` tears a mount down WHILE it is mounting
   * (two picker clicks in quick succession), and its teardown both
   * destroys the surface and clears the region. With no way in, a
   * torn-down mount would be left holding a detached iframe that can
   * never complete its handshake — the returned promise would never
   * settle, and `teardownPanel`'s completion signal, which the next
   * mount awaits, would hang forever.
   *
   * Aborting destroys the frame, which is what makes this mount reject
   * with "frame backend destroyed before it was ready" — the same
   * rejection the callers already distinguish from a real failure by
   * their generation counter. */
  signal?: AbortSignal;
}

export interface Mounted<E> {
  frame: HTMLIFrameElement;
  /** The app's exports. EVERY method returns a Promise: each is one
   * control-port round trip, serialized through the frame's runner —
   * callers never see the runner, and never needed to know whether the
   * call was local. */
  exports: E;
  /** polyvisor:surface/shell.route() now returns `route`. Callers still
   * invoke the app's own on-route export themselves if its world has
   * one: the visor decides whether a route change is worth telling the
   * app about, and only the app's world knows what to call. */
  setRoute(route: string): void;
  /** Input suspension (#22): stop delivering events into the guest.
   * Queued, not dropped. Both halves — `inert` on the iframe here, the
   * runner's gate and a focus drop in the frame — because neither is
   * sufficient alone (#142, spike 4 P1). */
  suspend(): void;
  resume(): void;
  /** Tear the surface down; resolves when it is actually gone.
   * Idempotent, and in the SAME completion. */
  destroy(): Promise<void>;
}

/** The names the frame must bind for one granted import.
 *
 * Own AND inherited: an import implementation may be an object literal
 * (`dropboxFetchImports`) or a component instance's export object whose
 * methods live on a prototype (`engine.tasks`). Enumerating only own
 * keys would silently bind an empty interface for the second kind, and
 * the guest would trap on a missing import at instantiation rather than
 * here. */
function methodNames(impl: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (
    let o: object | null = impl;
    o !== null && o !== Object.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === "constructor") continue;
      if (typeof (impl as Record<string, unknown>)[k] === "function") names.add(k);
    }
  }
  return [...names];
}

export async function mountApp<E extends object>(
  opts: MountOptions,
): Promise<Mounted<E>> {
  const frame = document.createElement("iframe");
  // THE load-bearing attribute. `allow-scripts` and `allow-forms` and
  // NOTHING else: with no `allow-same-origin`, the frame's document gets
  // an opaque origin, so it cannot touch the visor's DOM, styles,
  // cookies or storage. Adding `allow-same-origin` here would silently
  // undo the entire point of this file.
  //
  // `allow-forms` is not a relaxation (#142, spike 4 P4): WITHOUT it the
  // `submit` event never fires at all in either engine, so `<form
  // onsubmit>` is simply dead and a component cannot even prevent a
  // submission. With it, `preventDefault()` works and the meta policy's
  // `form-action 'none'` blocks any un-prevented navigation — the probe
  // saw no request leave the browser in either engine.
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.style.cssText =
    `width: 100%; border: none; display: block; height: ${MIN_HEIGHT_PX}px;`;
  frame.setAttribute("scrolling", "no");
  opts.container.appendChild(frame);

  let destroyed = false;
  /** The completion of the ONE teardown this surface ever gets. Non-null
   * means teardown has started. */
  let teardown: Promise<void> | null = null;

  const control = new MessageChannel();
  const importChannels: Record<string, MessageChannel> = {};
  for (const witId of Object.keys(opts.imports)) {
    importChannels[witId] = new MessageChannel();
  }

  let callSeq = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  const destroy = (): Promise<void> => {
    // Idempotent, and idempotent in the SAME completion: a second caller
    // must be able to await the teardown the first one started rather
    // than get a promise that resolves on its own schedule.
    if (teardown) return teardown;
    destroyed = true;
    globalThis.removeEventListener("message", onWindowMessage);
    control.port1.onmessage = null;
    control.port1.close();
    // A call in flight can never be answered now — its `result` would
    // have arrived on the port just closed. Reject it rather than leave
    // the caller's await dangling forever (when the instance lived in the
    // visor's realm, an in-flight call still completed locally).
    for (const p of pending.values()) {
      p.reject(new Error("frame backend destroyed before it was ready"));
    }
    pending.clear();
    for (const ch of Object.values(importChannels)) {
      ch.port1.onmessage = null;
      ch.port1.close();
    }
    frame.remove();
    // WHY THE TURN. Everything above is synchronous, but the frame's
    // window can already have posted toward us — a message is delivered
    // as a task, and removing the element does not unqueue one that was
    // posted before the removal. The listeners are gone so those
    // messages hit nothing, but a caller that stands up the NEXT surface
    // must not do so while they are still landing: that is the window in
    // which a stale delivery gets attributed to the new frame. So
    // completion is one macrotask out, which is exactly long enough for
    // the queue this frame could still be holding to drain.
    teardown = new Promise<void>((resolve) => setTimeout(resolve, 0));
    return teardown;
  };

  // FAULTS AND VIOLATIONS ARRIVE ON THE WINDOW CHANNEL, which outlives
  // the control port and exists before it: a CSP violation can fire
  // while the frame's document is still parsing. Same shape the frame
  // seam has always had.
  const onWindowMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const data = e.data as FrameFaultMsg | null;
    if (!data || typeof data !== "object") return;
    if (data.t === "violation") {
      // A `form-action` violation is an app that forgot preventDefault,
      // not an attack — log it, do not treat it as a fault (#142, spike
      // 4 P4's ruling). Everything else is the frame trying to reach
      // something `default-src 'none'` forbids, which is a finding.
      if (data.directive.startsWith("form-action")) {
        console.warn(`[frame] form-action: ${data.blockedURI}`);
        return;
      }
      recordFault(`csp ${data.directive}: ${data.blockedURI}`);
    } else if (data.t === "fault") {
      recordFault(data.msg);
    }
  };
  globalThis.addEventListener("message", onWindowMessage);

  function recordFault(msg: string): void {
    const faults = ((globalThis as Record<string, unknown>).__frameFaults ??= []) as string[];
    faults.push(msg);
  }

  // --- serve the imports ---------------------------------------------------
  //
  // One port per granted WIT id, and the grant is per PORT rather than a
  // string on a shared channel: a frame that only ever received the
  // `tasks` port has no name it could utter to reach `fetch`.
  for (const [witId, ch] of Object.entries(importChannels)) {
    const impl = opts.imports[witId] as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    ch.port1.onmessage = (e: MessageEvent<ImportCall>) => {
      const { id, method, args } = e.data;
      const fn = impl[method];
      // The frame was told the method names by this same module, so a
      // miss is a bug here rather than a guest reaching for something it
      // was not granted — report it as a rejection either way.
      const run = typeof fn === "function"
        ? Promise.resolve().then(() => fn.apply(impl, args))
        : Promise.reject(new Error(`${witId}: no method ${method}`));
      run.then(
        (value) => {
          try {
            ch.port1.postMessage({ id, ok: true, value } satisfies ImportResult);
          } catch (cloneFailure) {
            ch.port1.postMessage(
              { id, ok: false, error: encodeError(cloneFailure) } satisfies ImportResult,
            );
          }
        },
        (err) => {
          ch.port1.postMessage(
            { id, ok: false, error: encodeError(err) } satisfies ImportResult,
          );
        },
      );
    };
    ch.port1.start();
  }

  // --- the control port ----------------------------------------------------

  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Nobody is required to await a mount whose surface got torn down
  // first; keep the rejection from surfacing as an unhandled rejection
  // when they don't.
  ready.catch(() => {});

  control.port1.onmessage = (e: MessageEvent<FrameMsg>) => {
    const m = e.data;
    if (destroyed) return;
    if (m.t === "ready") {
      resolveReady();
    } else if (m.t === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(decodeError(m.error));
    } else if (m.t === "height") {
      // The visor cannot measure a cross-origin document, so the frame
      // reports its own layout height and the visor decides what to do
      // with it. Clamped, and never used for anything but sizing.
      const px = Math.max(MIN_HEIGHT_PX, Math.ceil(Number(m.px) || 0));
      frame.style.height = `${px}px`;
    } else if (m.t === "event-handled") {
      Promise.resolve()
        .then(() => opts.afterEvent?.())
        .catch(opts.onEventError ?? (() => {}));
    }
  };
  control.port1.start();

  const onAbort = () => void destroy();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // THE DOCUMENT ARRIVES BY VALUE, one turn later (assembly needs three
    // fetches and a digest). A surface torn down while the assembly was
    // in flight must not get a document at all.
    const html = await frameSrcdoc();
    if (destroyed) throw new Error("frame backend destroyed before it was ready");
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      frame.addEventListener(
        "error",
        () => reject(new Error("frame document failed to load")),
        { once: true },
      );
      frame.srcdoc = html;
    });
    if (destroyed) throw new Error("frame backend destroyed before it was ready");

    // EVERYTHING VARIABLE CROSSES IN ONE MESSAGE, after `load`, which is
    // when the frame's inline module script has evaluated and its
    // listener exists. The srcdoc itself stays a build-time-shaped
    // constant, which is what keeps it hash-addressable (#142's
    // correction comment).
    //
    // Target origin "*": an opaque-origin frame CANNOT be addressed by
    // origin (there is no origin string that matches "null" as a
    // targetOrigin), so "*" is the only option. It is safe here because
    // the payload's authority is the transferred PORTS, delivered to one
    // specific contentWindow rather than broadcast.
    const importPorts: Record<string, MessagePort> = {};
    const importMethods: Record<string, string[]> = {};
    const transfer: Transferable[] = [control.port2];
    for (const [witId, ch] of Object.entries(importChannels)) {
      importPorts[witId] = ch.port2;
      importMethods[witId] = methodNames(opts.imports[witId]);
      transfer.push(ch.port2);
    }
    const msg: MountMsg = {
      t: "mount",
      plan: opts.artifact.envelope,
      bytes: opts.artifact.bytes,
      route: opts.route ?? "",
      theme: opts.theme ?? "light",
      imports: importMethods,
      ports: { control: control.port2, imports: importPorts },
    };
    frame.contentWindow!.postMessage(msg, "*", transfer);

    await ready;
    if (destroyed) throw new Error("frame backend destroyed before it was ready");
  } catch (e) {
    // A mount that failed leaves nothing behind: the caller's catch has
    // no handle to clean up with, so cleaning up is this function's job.
    await destroy();
    throw e;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const call = (name: string, args: unknown[]): Promise<unknown> => {
    if (destroyed) {
      return Promise.reject(new Error("frame backend destroyed before it was ready"));
    }
    return new Promise((resolve, reject) => {
      const id = ++callSeq;
      pending.set(id, { resolve, reject });
      control.port1.postMessage({ t: "call", id, name, args } satisfies ControlMsg);
    });
  };

  // A wrapper per name, cached, so repeated reads are the same function
  // value. The proxy cannot ask the frame what the exports ARE — and
  // does not need to: a name the guest does not export rejects when it
  // is called, which is where a caller can see it.
  const wrapped = new Map<string, unknown>();
  const exports = new Proxy(Object.create(null) as E, {
    get(_t, prop) {
      // `then` in particular MUST NOT answer with a function: any
      // `await` or `Promise.resolve()` reaching this object would
      // otherwise mistake it for a thenable and hang.
      if (typeof prop !== "string") return undefined;
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      let w = wrapped.get(prop);
      if (!w) {
        w = (...args: unknown[]) => call(prop, args);
        wrapped.set(prop, w);
      }
      return w;
    },
  });

  return {
    frame,
    exports,
    setRoute: (route: string) => {
      if (!destroyed) {
        control.port1.postMessage({ t: "route", route } satisfies ControlMsg);
      }
    },
    suspend: () => {
      if (destroyed) return;
      // `inert` handles pointer input uniformly and nothing else
      // uniformly (#142, spike 4 P1); the frame's own half — the
      // runner's gate plus dropping focus — is what actually stops the
      // guest seeing input.
      frame.inert = true;
      control.port1.postMessage({ t: "suspend" } satisfies ControlMsg);
    },
    resume: () => {
      if (destroyed) return;
      frame.inert = false;
      control.port1.postMessage({ t: "resume" } satisfies ControlMsg);
    },
    destroy,
  };
}

// --- how a rejection crosses ------------------------------------------------
//
// The visor's half of the discipline frame.ts's own header describes: a
// host `ComponentException` (a WIT `result` err arm) must reach the
// guest as `err(payload)` rather than as a trap, and a guest trap must
// reach the visor as a rejection carrying the trap's message. Both
// directions go through the embedder's sanctioned cloneable form, which
// is what makes the rehydrated value a REAL branded exception in the
// receiving realm rather than a facsimile.
function encodeError(e: unknown): unknown {
  try {
    return toCloneable(e);
  } catch (refusal) {
    // `toCloneable` REFUSES rather than degrades — a realm-local handle
    // where a value belongs. Forward the refusal verbatim instead of
    // stripping something to make the send succeed (rpc.ts's rule).
    return toCloneable(
      new Error(`unclonable rejection (${String(refusal)}): ${String(e)}`),
    );
  }
}

function decodeError(error: unknown): unknown {
  try {
    return fromCloneable(error);
  } catch (skew) {
    return skew;
  }
}
