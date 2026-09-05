// THE DIOXUS FRAME TRANSPORT: polyengine-dioxus mounted into a REAL
// sandboxed iframe on an opaque origin.
//
// This is the `polymorph:dioxus` analogue of ../../../visor/frame/
// frame-backend.ts, and it exists for exactly the reason that file exists.
// The demo page's default backend is `frame` because the visor's strip
// carries the user's personal anchor colour, and non-disclosure of that
// colour must be STRUCTURAL rather than an allowlist: a separate document on
// an opaque origin has nothing to read, as opposed to nothing it is allowed
// to read. The dioxus guest is a re-target, not a downgrade, so it keeps that
// property — see e2e/tests/dioxus-frame.spec.ts, which asserts it.
//
// WHY THIS FILE EXISTS AT ALL. The sibling's `mountApp` (@polyengine/
// dioxus-host/host.ts) applies mutations into the document IT runs in. Here
// the two halves must live in different documents:
//
//   - THE SHELL (this file) runs the wasm instance, owns the import table,
//     and reads the mutation stream. It never touches the app's DOM.
//   - THE FRAME (./frame-dioxus.ts) owns the app's document: `DomApplier`,
//     `applyOperations`, `EventDispatcher`, `serializePayload`. It never sees
//     the component.
//
// The op batch is the seam, and it crosses as-is: lifted `operation` values
// are plain data (records, variants-as-`{kind,value}`, `Uint8Array` paths,
// `bigint` for `attr-value.int`) and every one of those is structured-
// cloneable, so the batch the read loop receives is the batch the frame
// applies. Events come back the same way.
//
// KEPT IN THE SPIKE, not pushed upstream into the sibling. This is the first
// consumer of the shape; if a second one appears it moves.
//
// ---------------------------------------------------------------------------
// THE THREE DEGRADATIONS, and they are real
// ---------------------------------------------------------------------------
//
// Each is implemented honestly (no pretending, no silent failure) and marked
// at its site below. Summarised here so the list is in one place:
//
//   1. `dom-event.prevent-default` / `stop-propagation` CANNOT WORK. The
//      frame's native listener returned before the shell ever saw the event —
//      by the time `handle-event` runs, the browser has already decided the
//      default action. Both are no-ops. (See `DomEvent` below.)
//   2. THE `dom` QUERIES CANNOT CROSS. `get-client-rect`, `set-focus` and the
//      rest are SYNCHRONOUS imports; postMessage is not. They answer the
//      interface's own miss values — `none` for queries, `false` for commands
//      — which wit/world.wit explicitly permits ("none = no live node holds
//      that id"). (See `frameDomImports` below.)
//   3. `eval` IS NOT GRANTED, which is not a degradation but a rule: apps
//      never get it. No import is supplied and the guest imports none.
//
// A FOURTH, found while building this rather than predicted: an event payload
// carrying a RESOURCE — `form-data.files` (`list<own<file>>`) or
// `drag-data.transfer` — cannot cross either. The sibling's serializer builds
// live `HostFile`/`HostDataTransfer` instances at capture time, and
// structuredClone turns a class instance into a plain object, losing the
// methods the resource lowering calls. TodoMVC never produces one (its inputs
// are text and checkbox, so `files` is always `[]`, which clones fine), so
// this costs the app nothing today — but a file input in a framed app would
// need the handle to stay frame-side behind an async read.

/// <reference lib="dom" />

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import type { Stream } from "@deltic/protocol";
import { wasi } from "@polyengine/wasi";

import { DispatchGate } from "@polyengine/dioxus-host/dispatch.ts";
import { createHeadImports } from "@polyengine/dioxus-host/head.ts";
import {
  createHistoryImports,
  fragmentHistory,
  type HistoryProvider,
} from "@polyengine/dioxus-host/history.ts";
import { HostDataTransfer, HostFile } from "@polyengine/dioxus-host/events.ts";
import type { Operation } from "@polyengine/dioxus-host/operations.ts";

// -- the wire ----------------------------------------------------------------

/** Shell → frame. One arm: batches of lifted `operation` values. */
type ShellMsg = { t: "ops"; ops: Operation[] };

/** Frame → shell. `event` carries what `handle-event` needs and nothing
 * else; the payload was serialized frame-side, where the native event is. */
type FrameMsg =
  | { t: "event"; target: number; nameId: number; payload: unknown }
  | { t: "height"; px: number };

/** Floor for the frame's height: an unsized iframe is 150px by spec, and a
 * frame that reports 0 before its first paint would collapse to invisible.
 * Same value and same reason as frame-backend.ts's. */
const MIN_HEIGHT_PX = 48;

/** A whole batch must arrive in one chunk; mirrors `mountApp`'s constant. */
const MAX_READ = 1 << 22;

// -- the shell's import table ------------------------------------------------

/**
 * DEGRADATION 1. `polymorph:dioxus/events`' `dom-event` resource, as much of
 * it as survives the hop: nothing.
 *
 * The WIT calls this "a live DOM event, lent to the guest for the duration of
 * one `handle-event` call (the cancelable window)". Across a frame there IS no
 * cancelable window on the shell side: the frame's native listener ran, posted
 * to us, and returned, and the browser committed to the default action at that
 * moment. `driver::handle_event` still calls `prevent_default()` whenever an
 * app handler asked for it (polyengine-dioxus/src/driver.rs:368-370) — it just
 * reaches this, which can do nothing.
 *
 * The WIT's own escape hatch covers the shape: "calling either method after
 * the originating dispatch has completed is a harmless no-op". That is
 * precisely the state every dispatch is in here.
 *
 * WHAT IT COSTS TODOMVC, concretely: the two `evt.prevent_default()` calls in
 * the app (the label's `onclick`, the destroy button's) and the filter
 * anchors'. The label case is why a `<label for=cbg-N>` click would otherwise
 * toggle the checkbox twice; the anchors' default action moves the FRAME's own
 * fragment, which nothing reads. Both are absorbed: see the e2e suite, which
 * drives all of them through real interaction and asserts the list state.
 */
class DomEvent {
  // CONTRACT: no-ops, deliberately. See the class doc — this is the honest
  // implementation across a frame, not a stub awaiting completion.
  preventDefault(): void {}
  stopPropagation(): void {}
}

/**
 * DEGRADATION 2. `polymorph:dioxus/dom` — the request/response imports behind
 * dioxus-html's `MountedData`.
 *
 * Every one of these is a SYNCHRONOUS WIT function returning an answer the
 * caller uses immediately, and every answer lives in the frame's document.
 * postMessage cannot be awaited from inside a sync import, so there is no
 * implementation to write: the choice is between a wrong answer and the
 * interface's documented miss value.
 *
 * The miss value is a real, specified state, not an error: "Convention:
 * queries return `option` (none = no live node holds that id), commands return
 * `bool` (false = same)... ids are reused slab indices, so a handle an app
 * stashed can outlive its element and the miss case is ordinary, not
 * exceptional" (wit/world.wit, `interface dom`). An app that asks gets the
 * same answer it would get for a stale id, which dioxus already handles.
 *
 * WHAT IT COSTS TODOMVC: `set-focus` is the one that bites. The app marks both
 * the new-todo input and the edit input `autofocus: "true"`, which dioxus
 * routes through `MountedData::set_focus`. Framed, neither auto-focuses. That
 * is the SAME gap the README recorded for the old prototype ("no
 * `onmounted`/focus bridging") — the re-target closes it for a same-realm
 * mount, where `mountApp` wires the real thing, and it stays open across the
 * frame for this structural reason rather than for the old missing-plumbing
 * one. The e2e suite therefore clicks into the edit field explicitly.
 */
const frameDomImports = {
  getScrollOffset: (_target: number) => undefined,
  getScrollSize: (_target: number) => undefined,
  getClientRect: (_target: number) => undefined,
  scrollTo: (_target: number, _options: unknown) => false,
  scroll: (_target: number, _offset: unknown, _behavior: unknown) => false,
  setFocus: (_target: number, _focus: boolean) => false,
};

export interface DioxusFrameMount {
  /** The sandboxed iframe the app lives in. */
  frame: HTMLIFrameElement;
  /** The shell-side history provider — `fragmentHistory(window)`, so the
   * app's route IS the page's URL fragment. Exposed for tests. */
  history: HistoryProvider;
  /** Tear down, and resolve when it is actually gone. Idempotent, in the
   * same completion — see frame-backend.ts's `destroy` for why the extra
   * macrotask is load-bearing. */
  dispose(): Promise<void>;
}

export interface MountDioxusFrameOptions {
  container: HTMLElement;
  /** Build-time translation envelope + component bytes. */
  envelope: string;
  bytes: Uint8Array;
  onError: (err: unknown) => void;
  /** The frame document, relative to the page that loads it. */
  frameSrc?: string;
}

/**
 * Mount a `polymorph:dioxus` app into a sandboxed frame.
 *
 * Resolves once the component is instantiated and its first batch is on its
 * way to the frame. Rejects if the handshake or the instantiation fails.
 */
export async function mountDioxusFrame(
  opts: MountDioxusFrameOptions,
): Promise<DioxusFrameMount> {
  const { container, envelope, bytes, onError } = opts;

  const frame = document.createElement("iframe");
  // THE load-bearing attribute, verbatim from frame-backend.ts: `allow-
  // scripts` and NOTHING else. With no `allow-same-origin` the frame's
  // document has an opaque origin and cannot reach this realm's DOM, styles,
  // storage or cookies even though it was served from the same URL space.
  // Adding `allow-same-origin` here would silently undo this entire file.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = opts.frameSrc ?? "./frame-dioxus.html";
  frame.style.cssText =
    `width: 100%; border: none; display: block; height: ${MIN_HEIGHT_PX}px;`;
  frame.setAttribute("scrolling", "no");
  container.appendChild(frame);

  let port: MessagePort | null = null;
  let disposed = false;
  let teardown: Promise<void> | null = null;

  // Faults arrive on the WINDOW channel, which outlives the handshake — a
  // diagnostic that dies with the handshake listener reports "no faults" for
  // a frame that is on fire. (frame-backend.ts:98-107.)
  const onFault = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    if ((e.data as { t?: string })?.t !== "fault") return;
    const faults = ((globalThis as Record<string, unknown>).__frameFaults ??= []) as string[];
    faults.push(String((e.data as { msg?: string }).msg));
  };
  globalThis.addEventListener("message", onFault);

  // -- handshake -------------------------------------------------------------
  //
  // The shell cannot address an opaque-origin frame by origin (every
  // sandboxed frame reports "null"), so `e.source` identity is the only check
  // available, exactly as in frame-backend.ts.
  const ready = new Promise<MessagePort>((resolve, reject) => {
    const onWindowMessage = (e: MessageEvent) => {
      if (disposed || e.source !== frame.contentWindow) return;
      const data = e.data as { t?: unknown } | null;
      if (!data || typeof data !== "object" || data.t !== "frame-ready") return;
      globalThis.removeEventListener("message", onWindowMessage);
      const channel = new MessageChannel();
      // Target origin "*" is the only option for an opaque origin; safe here
      // because the payload is a bare MessagePort with no secret in it,
      // delivered to one specific contentWindow rather than broadcast.
      frame.contentWindow!.postMessage({ t: "port" }, "*", [channel.port2]);
      resolve(channel.port1);
    };
    globalThis.addEventListener("message", onWindowMessage);
    // A frame that never announces itself would otherwise hang the mount
    // forever with no diagnostic at all.
    setTimeout(() => {
      globalThis.removeEventListener("message", onWindowMessage);
      if (!disposed) reject(new Error("dioxus frame: no frame-ready within 10s"));
    }, 10_000);
  });

  port = await ready;

  // -- the guest side --------------------------------------------------------

  // The gate still serializes ENTRIES into the guest (one `handle-event` in
  // flight at a time, FIFO). What it is NOT doing here is bracketing mutation
  // application: that happens in the frame, asynchronously, so none of
  // dispatch.ts's three reentrancy windows can occur — every event arrives on
  // a fresh macrotask from a MessagePort, with no guest turn on the stack.
  // `beginApply`/`endApply` are therefore never called, and the deferred-
  // dispatch `preventDefault` caveat in that file is moot for the same reason
  // degradation 1 is: there was never a live cancelable window to lose.
  const gate = new DispatchGate(onError);

  let handleEventExport: ((...a: unknown[]) => unknown) | undefined;

  const historyProvider = fragmentHistory(globalThis.window);

  const imports = {
    // WASI p2 providers. This guest is built for wasm32-wasip2, which links
    // wasi-libc and therefore imports wasi:cli/io/clocks/random whether or
    // not the app calls them (std's startup touches environment/stdio). Not
    // optional and not app-visible capability: leaving them out fails
    // instantiation outright with "host import 'wasi:io/poll@0.2.6/pollable'
    // not provided", which is how this line came to be here.
    ...wasi(),
    // `dom-event`, `file` and `data-transfer` are the `events` interface's
    // host-implemented resources, keyed by their bindgen UpperCamel names.
    // The two file/drag classes are supplied even though TodoMVC renders no
    // file input and no drag source: resource-TYPE imports are not
    // payload-conditional, so a missing key is a failed instantiation rather
    // than a dormant capability. (This is exactly what broke the visor spike
    // on the same bump — see spikes/visor-dioxus/host/mount.ts.)
    "polymorph:dioxus/events@0.6.0": {
      DomEvent,
      File: HostFile,
      DataTransfer: HostDataTransfer,
    },
    // Degradation 2, above.
    "polymorph:dioxus/dom@0.6.0": frameDomImports,
    // THE APP'S `<head>` IS THE FRAME'S, NOT OURS — and this table runs in
    // the shell. Writing a `<title>` or a `<link>` here would put app-chosen
    // content into the SHELL's document, which is the trusted one; that is
    // strictly worse than doing nothing. Routing head writes into the frame
    // instead is possible (they are one-way commands, so unlike the `dom`
    // queries they COULD be posted) but it is a policy decision — which
    // elements, whose stylesheet origin, what a framed app may put in a head
    // nobody sees — that this spike is not the place to settle.
    //
    // So: the real import, with an interceptor that refuses every call. The
    // interceptor is the right tool because refusal has one spelling from the
    // WIT (`false` = "the host did not do it") and the guest has nothing to do
    // with it: "refusal is silent by design: the element simply is not there"
    // (wit/world.wit, `interface head`). `document` is passed but is never
    // reached, because `next` is never called.
    "polymorph:dioxus/head@0.6.0": createHeadImports(
      document,
      gate,
      { allowScript: false },
      {
        setTitle: () => false,
        createElement: () => false,
      },
    ),
    // HISTORY RUNS IN THE SHELL, and needs no frame plumbing at all: it is
    // the URL that is the state, the shell owns the URL, and the guest is on
    // this side of the port too (only the DOM is in the frame). `fragment`
    // and not `memory` because this app HAS routes and the page's fragment is
    // where they belong — wit/world.wit names this exact case: "encoded into
    // the URL fragment (the shape for a host that does not own the path, such
    // as polyvisor's apps)".
    "polymorph:dioxus/history@0.6.0": createHistoryImports(historyProvider),
    // NO `polymorph:dioxus/eval@0.6.0`. Degradation 3 / the rule: apps never
    // get eval. The guest is built without the renderer's `eval` feature so it
    // imports nothing here, and the justfile asserts that on the artifact. A
    // key here would be an entry nothing claims.
  };

  const instance = await instantiate(artifactsFromEnvelope(envelope, bytes), imports);
  handleEventExport = instance.exports.handleEvent as (...a: unknown[]) => unknown;

  // -- frame → shell ---------------------------------------------------------

  port.onmessage = (m: MessageEvent<FrameMsg>) => {
    if (disposed) return;
    const msg = m.data;
    if (msg.t === "event") {
      if (!handleEventExport) return;
      // The payload was built frame-side by `serializePayload`, where the
      // native event lives; a fresh `DomEvent` per dispatch keeps the shape
      // `handle-event` expects even though it can do nothing.
      gate.dispatch(() =>
        handleEventExport!(msg.target, msg.nameId, msg.payload, new DomEvent())
      );
    } else if (msg.t === "height") {
      // The shell cannot measure a cross-origin document, so the frame
      // reports its own layout height. Clamped, and used for nothing but
      // sizing.
      const px = Math.max(MIN_HEIGHT_PX, Math.ceil(Number(msg.px) || 0));
      frame.style.height = `${px}px`;
    }
  };
  port.start();

  // -- the mutation read loop ------------------------------------------------

  const mode = { kind: "fresh" };
  const ops = await (instance.exports.run as (m: unknown) => Promise<Stream<Operation>>)(
    mode,
  );

  (async () => {
    while (!disposed) {
      const chunk = await ops.read(MAX_READ);
      if (chunk.length === 0) break; // end of stream
      // The whole batch goes over in one post, preserving the guest's batch
      // boundary. structuredClone is implicit in postMessage and is what
      // enforces that operations really are plain data.
      port!.postMessage({ t: "ops", ops: chunk } satisfies ShellMsg);
    }
  })().catch((err: unknown) => {
    if (!disposed) onError(err);
  });

  return {
    frame,
    history: historyProvider,
    dispose() {
      if (teardown) return teardown;
      disposed = true;
      globalThis.removeEventListener("message", onFault);
      gate.dispose();
      if (port) {
        port.onmessage = null;
        port.close();
        port = null;
      }
      // Dropping the read end resolves the loop's next read with `done` and
      // the guest observes reader-gone on its next write (driver.rs's `dead`
      // flag), so it goes dark rather than accumulating batches.
      ops.drop();
      frame.remove();
      // One macrotask, for frame-backend.ts's reason: the frame's window can
      // already have posted toward us, and removing the element does not
      // unqueue a message posted before the removal. A caller standing up the
      // NEXT surface must not do so while those are still landing.
      teardown = new Promise<void>((resolve) => setTimeout(resolve, 0));
      return teardown;
    },
  };
}
