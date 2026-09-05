// THE FRAME SIDE of the dioxus frame transport: this module runs INSIDE the
// sandboxed iframe, on an opaque origin, with no reference to the shell's
// realm. Its only channel to the shell is the MessagePort it is handed at
// startup; its only job is to be the DOM half of polyengine-dioxus.
//
// It is ../../../visor/frame/frame.ts's counterpart for `polymorph:dioxus`,
// and the same rules govern it. See ./dioxus-frame.ts for the protocol, the
// trust story, and the three degradations this split imposes.
//
// WHAT LIVES HERE, all of it the sibling's code rather than a reimplementation:
//
//   - `DomApplier`      — the id→Node table and the mutation vocabulary
//   - `applyOperations` — the lifted-`operation` walk that drives it
//   - `EventDispatcher` — delegated listener registration (and the SYNTHETIC
//                         `mounted` dispatch, which it fires itself)
//   - `serializePayload`— native event → wit `events.payload`
//
// The component itself is NOT here. It runs in the shell, which is the whole
// point: the app's code and the app's pixels are in different realms, and the
// only thing that crosses is data.

/// <reference lib="dom" />

import { DomApplier } from "@polyengine/dioxus-host/applier.ts";
import { EventDispatcher, serializePayload } from "@polyengine/dioxus-host/events.ts";
import type { NativeEventLike } from "@polyengine/dioxus-host/events.ts";
import { applyOperations } from "@polyengine/dioxus-host/operations.ts";
import type { Operation } from "@polyengine/dioxus-host/operations.ts";

type ShellMsg = { t: "ops"; ops: Operation[] };
type FrameMsg =
  | { t: "event"; target: number; nameId: number; payload: unknown }
  | { t: "height"; px: number };

let wired = false;

function wire(port: MessagePort): void {
  // One port per frame, for the frame's lifetime. A second `port` message is
  // either a bug or an attempt to re-point the surface; either way the first
  // port keeps the frame. (frame.ts:30-34.)
  if (wired) return;
  wired = true;

  const root = document.getElementById("app") as HTMLElement;

  // EVENTS ARE SERIALIZED HERE, where the native event object actually is.
  // The shell receives a finished payload plus the ids `handle-event` needs;
  // it never sees an Event. This is also where the synthetic `mounted`
  // dispatch originates — `EventDispatcher.add` calls this sink directly for
  // it, with a `{type:"mounted"}` stub, and it rides the same wire as every
  // real event.
  const dispatcher = new EventDispatcher(root, (elementId, nameId, name, ev) => {
    port.postMessage({
      t: "event",
      target: elementId,
      nameId,
      // `serializePayload` yields plain data for every family TodoMVC uses.
      // The exception is resource-carrying payloads (`form-data.files`,
      // `drag-data.transfer`): those hold live `HostFile`/`HostDataTransfer`
      // instances, which structuredClone would flatten into method-less plain
      // objects. TodoMVC never produces one — its inputs are text and
      // checkbox, so `files` is always the empty array — and a framed app
      // that did would need the handle to stay here behind an async read.
      // Documented in ./dioxus-frame.ts as the fourth degradation.
      payload: serializePayload(name, ev as NativeEventLike),
    } satisfies FrameMsg);
  });

  const applier = new DomApplier(root, dispatcher);

  // FRAME-SIDE MITIGATION OF DEGRADATION 1 (see ./dioxus-frame.ts).
  //
  // The guest's `evt.prevent_default()` cannot reach this document — by the
  // time the shell has the event, this frame's native listener has returned
  // and the browser has already acted. For most defaults that costs nothing.
  // For an in-page anchor it costs something real: a hash `href` navigates
  // THIS document, and a same-document navigation in a subframe still appends
  // an entry to the browsing context group's JOINT SESSION HISTORY. The
  // shell's back button then steps through fragment entries belonging to a
  // frame whose URL nobody reads, instead of through the app's actual route
  // history — found by e2e/tests/dioxus-frame.spec.ts, whose second
  // `history.back()` moved nothing.
  //
  // So the frame refuses in-page anchor defaults on the guest's behalf. This
  // is a policy the TRANSPORT owns rather than a guess about app intent: a
  // framed app's own fragment is unobservable by construction, so navigating
  // it can only ever be noise. Routing still works — it goes through
  // `history.push` on the shell side, which is the interface for it.
  //
  // Capture phase, and `preventDefault` only: propagation is untouched, so
  // the delegated listener the EventDispatcher installed still dispatches the
  // click to the guest exactly as before.
  document.addEventListener("click", (e) => {
    const anchor = (e.target as Element | null)?.closest?.("a[href]");
    if (anchor && (anchor.getAttribute("href") ?? "").startsWith("#")) {
      e.preventDefault();
    }
  }, true);

  // Measure the BODY's flow box rather than documentElement.scrollHeight: the
  // frame renders with scrolling disabled (the shell sizes it), and under
  // overflow:hidden scrollHeight collapses to the clipped viewport — the frame
  // would truthfully report its own clamp forever. (frame.ts:41-53.)
  const postHeight = () => {
    const rect = document.body.getBoundingClientRect();
    port.postMessage({ t: "height", px: Math.ceil(rect.bottom + 8) } satisfies FrameMsg);
  };

  port.onmessage = (m: MessageEvent<ShellMsg>) => {
    if (m.data.t !== "ops") return;
    try {
      applyOperations(m.data.ops, applier);
    } catch (err) {
      // A silent applier failure is indistinguishable from "nothing rendered"
      // when the shell cannot read this document.
      window.parent.postMessage({ t: "fault", msg: `apply: ${err}` }, "*");
    }
    // After every apply: the only measurement the shell can take of a
    // cross-origin document is the one this frame volunteers.
    postHeight();
  };
  port.start();

  // Height must be reported CONTINUOUSLY, not once: the first report races
  // the render-blocking stylesheet, and a quiet app produces no further
  // applies to correct it. An observer covers every later cause too (fonts,
  // wrapping, the list growing). (frame.ts:80-89.)
  const observer = new ResizeObserver(() => postHeight());
  observer.observe(document.documentElement);
  globalThis.addEventListener("load", () => postHeight());
  postHeight();
}

// The shell cannot address this frame by origin (it is opaque), so the
// handshake is: we announce ourselves, the shell replies to our contentWindow
// with the port, and we accept a port ONLY from the embedder. Sibling frames
// can obtain a handle to this one (`parent.frames[i]` is reachable
// cross-origin) and postMessage to it; without this check the first sibling to
// send a port would become this frame's shell and drive its DOM. Origin cannot
// be checked — every sandboxed frame reports "null" — so source identity is
// the check. (frame.ts:96-109.)
globalThis.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const data = e.data as { t?: unknown } | null;
  if (!data || typeof data !== "object" || data.t !== "port") return;
  const port = e.ports[0];
  if (!port) return;
  wire(port);
});

// The frame's console is not readable from the shell, and a silent failure
// looks exactly like "nothing rendered". Report faults.
globalThis.addEventListener("error", (e) => {
  window.parent.postMessage(
    { t: "fault", msg: `${e.message} @${e.filename}:${e.lineno}` },
    "*",
  );
});

window.parent.postMessage({ t: "frame-ready" }, "*");
