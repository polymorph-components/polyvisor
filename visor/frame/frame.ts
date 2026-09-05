// THE IN-FRAME RUNTIME. This module runs INSIDE the sandboxed iframe, on
// an opaque origin, and it is where the app's component now lives:
// polyengine instantiates the guest HERE (#142, spike 2, validated in
// Chromium 143 and Firefox 144), not in the visor's realm.
//
// WHAT THAT BUYS, and it is the whole point of the placement. The
// `polyvisor:surface` imports bind to THIS document's real DOM,
// synchronously, through the same `createDirectBackend` the same-realm
// pages use — so the op protocol, the serialization of every DOM call
// and the second validation pass a realm crossing required are simply
// gone from the app path. What crosses a realm now is only what must:
// the app's OTHER imports (proxied to the visor over one MessagePort
// each) and the visor's calls into the app's exports (one control
// port).
//
// THE LINKER RULE THAT MAKES IT WORK WITHOUT JSPI (#142 spike 2,
// finding 1). Every import that crosses to the visor is a WIT `async
// func`, so the guest suspends on it through the component model's async
// ABI — no stack switching. The imports that are NOT async-declared
// (`dom`, `events`, `shell`) never leave this realm. Measured
// consequence: this frame runs on engines with no JSPI at all, which is
// a lower floor than the runtime SharedWorker's.
//
// TRUST. Only visor-shipped code runs as JavaScript here; the guest is
// wasm and can reach nothing but the imports it was handed. So the
// surface's validation (../surface/validate.ts, via createSurface) is
// still enforced against the guest even though it now executes in the
// frame — the guest has no path around it. What this document CANNOT do
// is reach the visor: opaque origin, and a `<meta>` CSP of
// `default-src 'none'` that makes it network-dead (mount.ts).

import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";
import { fromCloneable, toCloneable } from "@polyengine/protocol";
import { createDirectBackend } from "../surface/backend-direct.ts";
import { createSurface } from "../surface/surface.ts";
import { createRunner } from "../surface/runner.ts";
import type { UiEvent } from "../surface/events.ts";

/** THE SURFACE'S EVENT EXPORT, and a constant rather than a parameter on
 * purpose: `export on-event: func(ev: event)` is part of the surface
 * contract every world here builds against, not a per-app choice —
 * `todomvc`, `demo-app` (examples/todomvc/wit/todomvc.wit) and both
 * panel worlds (wit/panel/panel.wit) all declare exactly this name. A
 * parameter would invite a fifth spelling and make the contract
 * negotiable at the call site. */
const EVENT_EXPORT = "onEvent";

// --- the wire ---------------------------------------------------------------
//
// Defined here, in the module that implements it, and type-imported by
// mount.ts. Three channels, and they are separate because they have
// different lifetimes: the WINDOW channel carries diagnostics and works
// before any port exists (and after the frame is on fire); the CONTROL
// port carries the visor's calls into the guest; one IMPORT port per
// granted WIT id carries the guest's calls out.

/** Visor → frame, on the window channel. The one mount message. */
export interface MountMsg {
  t: "mount";
  /** The artifact envelope (`plan.json` text) and the component bytes. */
  plan: string;
  bytes: Uint8Array;
  route: string;
  theme: "light" | "dark";
  /** The METHOD NAMES of each granted import, keyed by verbatim WIT id.
   * The frame cannot enumerate the visor's objects, and the linker binds
   * imports by property name, so the names must cross explicitly. */
  imports: Record<string, string[]>;
  ports: {
    control: MessagePort;
    imports: Record<string, MessagePort>;
  };
}

/** Visor → frame, on the control port. */
export type ControlMsg =
  | { t: "call"; id: number; name: string; args: unknown[] }
  | { t: "route"; route: string }
  | { t: "suspend" }
  | { t: "resume" }
  | { t: "theme"; mode: "light" | "dark" };

/** Frame → visor, on the control port. */
export type FrameMsg =
  | { t: "ready" }
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: unknown }
  | { t: "height"; px: number }
  | { t: "event-handled" };

/** Frame → visor, on the window channel. Diagnostics only: both of
 * these must be deliverable before the control port exists (a CSP
 * violation can fire while the document is still parsing) and after it
 * is gone. */
export type FrameFaultMsg =
  | { t: "fault"; msg: string }
  | { t: "violation"; directive: string; blockedURI: string };

/** Guest → visor, on an import port. */
export interface ImportCall {
  id: number;
  method: string;
  args: unknown[];
}

/** Visor → guest, on an import port. */
export type ImportResult =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: unknown };

// --- diagnostics ------------------------------------------------------------

const post = (m: FrameFaultMsg) => window.parent.postMessage(m, "*");

// The frame's console is not readable from the visor, and a silent
// failure in here looks exactly like "nothing rendered". Report faults.
globalThis.addEventListener("error", (e) => {
  post({ t: "fault", msg: `${e.message} @${e.filename}:${e.lineno}` });
});
globalThis.addEventListener("unhandledrejection", (e) => {
  post({ t: "fault", msg: `unhandled rejection: ${(e as PromiseRejectionEvent).reason}` });
});

// A CSP violation fires on THIS document, where the visor cannot see it
// (#142, spike 2 finding 4). Relay it: the visor treats a violation as a
// kill signal, except `form-action`, which is an app that forgot
// preventDefault rather than an attack (#142, spike 4 P4).
globalThis.addEventListener("securitypolicyviolation", (e) => {
  const v = e as SecurityPolicyViolationEvent;
  post({ t: "violation", directive: v.violatedDirective, blockedURI: v.blockedURI });
});

// --- how a rejection crosses ------------------------------------------------
//
// MIRRORS runtime/device-store/rpc.ts's discipline, which already carries
// engine exceptions across a port for the solo page. A host
// `ComponentException` is a WIT `result` err arm and MUST arrive in the
// guest as `err(payload)` rather than as a trap, so it crosses in the
// embedder's sanctioned cloneable form (`toCloneable`) and is rehydrated
// with `fromCloneable`, which mints a real branded exception in the
// receiving realm — payload, cause chain and sender's stack intact.
//
// ONE ARM, NOT rpc.ts's TWO. rpc.ts also has a `host` arm, because the
// device store raises typed refusals whose `code` the cloneable form's
// unbranded-Error row would drop. Nothing on this wire has one: the
// values crossing are the app's own imports and exports. So the envelope
// is the cloneable form alone — and the one thing rpc.ts's second arm
// still teaches is kept below: `toCloneable` REFUSES rather than
// degrades, and a refusal is a finding about this code (a realm-local
// handle where a value belongs), so it is forwarded verbatim instead of
// being swallowed.
function encodeError(e: unknown): unknown {
  try {
    return toCloneable(e);
  } catch (refusal) {
    return toCloneable(
      new Error(`unclonable rejection (${String(refusal)}): ${String(e)}`),
    );
  }
}

function decodeError(error: unknown): unknown {
  try {
    return fromCloneable(error);
  } catch (skew) {
    // A throw out of `fromCloneable` means two realms running different
    // engine versions — outside the supported matrix, and its own
    // message says so. Reported, not smoothed (rpc.ts's `thrown`).
    return skew;
  }
}

// --- the import proxies -----------------------------------------------------

/** One granted WIT id's implementation, as the guest sees it: an object
 * whose named methods are request/response round trips to the visor.
 * Every one returns a Promise, which is what lets the guest suspend on
 * it through the async ABI (see the header's linker rule). */
function importProxy(
  port: MessagePort,
  methods: string[],
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  port.onmessage = (e: MessageEvent<ImportResult>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(decodeError(m.error));
  };
  port.start();

  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods) {
    proxy[method] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        port.postMessage({ id, method, args } satisfies ImportCall);
      });
  }
  return proxy;
}

// --- mount ------------------------------------------------------------------

let mounted = false;

async function mount(msg: MountMsg): Promise<void> {
  const control = msg.ports.control;

  // The theme is coarse mode ONLY. "light"/"dark" is already inferable
  // by any content via prefers-color-scheme, so telling the component
  // leaks nothing new — whereas the visor's personal anchor colour must
  // never cross this boundary in any form.
  const setTheme = (mode: "light" | "dark") => {
    document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
  };
  setTheme(msg.theme);

  let route = msg.route;
  let dispatch: (ev: UiEvent) => void = () => {};

  // THE SURFACE, SAME REALM. No op array, no structured clone, no id→Node
  // map, no second validation pass: `createSurface` validates and
  // `createDirectBackend` touches this document's DOM immediately.
  const backend = createDirectBackend(document.body, (ev) => dispatch(ev));
  const surface = createSurface(backend, () => route);

  const proxies: Record<string, Record<string, unknown>> = {};
  for (const [witId, methods] of Object.entries(msg.imports)) {
    proxies[witId] = importProxy(msg.ports.imports[witId], methods);
  }

  const instance = await instantiate(
    artifactsFromEnvelope(msg.plan, msg.bytes),
    { ...surface.imports, ...proxies },
  );
  const raw = instance.exports as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const runner = createRunner(surface);

  dispatch = (ev) => {
    runner.call(() => raw[EVENT_EXPORT](ev))
      // The visor's `afterEvent` hook fires off this: it used to run on
      // the visor's own call chain, and now it is one message later.
      .then(() => control.postMessage({ t: "event-handled" } satisfies FrameMsg))
      .catch((e) => post({ t: "fault", msg: `event: ${e}` }));
  };

  control.onmessage = (e: MessageEvent<ControlMsg>) => {
    const m = e.data;
    if (m.t === "call") {
      // EVERY guest call rides the one runner, whoever asked: the
      // serialized chain, the end-of-invocation flush and the suspension
      // gate are properties of "calling the guest", not of the caller.
      runner.call(() => raw[m.name](...m.args)).then(
        (value) => {
          const res: FrameMsg = { t: "result", id: m.id, ok: true, value };
          try {
            control.postMessage(res);
          } catch (cloneFailure) {
            // A DataCloneError here is a FINDING: a realm-local value
            // (a resource wrapper, a stream) has leaked into an export's
            // result. Say so at the call site rather than let the visor
            // hang waiting (rpc.ts's serve loop makes the same choice).
            control.postMessage({
              t: "result",
              id: m.id,
              ok: false,
              error: encodeError(cloneFailure),
            } satisfies FrameMsg);
          }
        },
        (err) => {
          control.postMessage({
            t: "result",
            id: m.id,
            ok: false,
            error: encodeError(err),
          } satisfies FrameMsg);
        },
      );
    } else if (m.t === "route") {
      route = m.route;
    } else if (m.t === "suspend") {
      // TWO HALVES, because neither is sufficient alone (#142, spike 4
      // P1). The visor sets `inert` on the iframe, which blocks pointer
      // input in both engines and NOTHING ELSE uniformly: programmatic
      // focus from in here still works, and Chromium still delivers
      // keystrokes to an input that was focused before `inert` was set.
      // So the guest-facing half is the runner's gate — invocations are
      // QUEUED, not delivered, exactly as when the instance lived in the
      // visor's realm — and the frame drops focus so there is no focused
      // input for the platform to keep feeding.
      runner.pause();
      (document.activeElement as HTMLElement | null)?.blur();
    } else if (m.t === "resume") {
      runner.resume();
    } else if (m.t === "theme") {
      setTheme(m.mode);
    }
  };
  control.start();

  // Measure the BODY's flow box, not documentElement.scrollHeight: the
  // frame is rendered with scrolling disabled (the visor sizes it, so an
  // inner scrollbar would be wrong), and under overflow:hidden
  // scrollHeight collapses to the clipped viewport — the frame would
  // truthfully report its own clamp forever. `bottom` includes the top
  // offset reserved for TodoMVC's absolutely-positioned title.
  const postHeight = () => {
    const rect = document.body.getBoundingClientRect();
    control.postMessage({
      t: "height",
      px: Math.ceil(rect.bottom + 8),
    } satisfies FrameMsg);
  };
  // CONTINUOUSLY, not once. A one-shot read races layout: it can report
  // 0 before the render-blocking stylesheet resolves, the visor clamps
  // to its floor, and nothing ever corrects it because a quiet app
  // produces no further DOM writes. An observer covers every later cause
  // too (fonts, images, wrapping) — #142 spike 2's finding 6.
  new ResizeObserver(() => postHeight()).observe(document.body);
  globalThis.addEventListener("load", () => postHeight());

  // READY MEANS INSTANTIATED, NOT RUN. `run()` is the visor's call to
  // make (the panel seeds first, the app does not), and it arrives as an
  // ordinary control call like every other export.
  control.postMessage({ t: "ready" } satisfies FrameMsg);
  postHeight();
}

// THE ONE MOUNT MESSAGE. Accepted only from the embedder and only once:
// sibling app frames can obtain a handle to this one (`parent.frames[i]`
// is reachable cross-origin) and postMessage to it, so without the
// source check the first sibling to send a mount would own this frame's
// DOM. Origin cannot be checked — every sandboxed frame reports "null" —
// so the source identity is the check, and the transferred ports are the
// real authenticator (#142, spike 2 finding 5).
globalThis.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const data = e.data as { t?: unknown } | null;
  if (!data || typeof data !== "object" || data.t !== "mount") return;
  if (mounted) return;
  mounted = true;
  mount(e.data as MountMsg).catch((err) => {
    post({ t: "fault", msg: `mount: ${err}\n${(err as Error)?.stack ?? ""}` });
  });
});
