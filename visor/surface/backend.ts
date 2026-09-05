// A backend implements the surface's ordering spec (see wit/surface/surface.wit,
// the `polyvisor:surface` package header) for one placement. The surface
// front-end owns ALL guest-facing validation and calls these primitives with
// already-checked arguments; `Rep` is the backend's element representation
// (an integer id for op-queue backends, the real Element for the direct
// backend).
//
// Semantics every backend must preserve identically: call-order
// application, flush at end of guest invocation (a trapped invocation
// still flushes what it emitted), listener records built by
// events.attachListener, free() releases bookkeeping never DOM nodes.

export type Rep = unknown;

export interface Backend {
  readonly root: Rep;
  create(tag: string): Rep;
  textNode(data: string): Rep;
  attr(rep: Rep, name: string, value: string | null): void;
  append(parent: Rep, child: Rep): void;
  before(ref: Rep, node: Rep): void;
  after(ref: Rep, node: Rep): void;
  remove(rep: Rep): void;
  text(rep: Rep, text: string): void;
  value(rep: Rep, value: string): void;
  checked(rep: Rep, checked: boolean): void;
  focus(rep: Rep): void;
  listen(rep: Rep, kind: string, token: number): void;
  free(rep: Rep): void;
  /** End-of-invocation flush boundary. No-op for immediate backends. */
  flush(): void;
  /** Resolve once all flushed ops have been applied to the DOM. */
  drain(): Promise<void>;
}

// "frame": NOT a backend at all any more, and kept in this union only
// as the todomvc harness's fourth placement label. Since #142 the app's
// instance runs INSIDE the sandboxed frame (visor/frame/mount.ts), where
// the surface binds to the real DOM through `direct` — so there is no
// op protocol on the app path and nothing for `createBackend` below to
// construct. Every consumer branches on it before reaching that switch.
export type BackendKind = "queued" | "direct" | "channel" | "frame";

export function isBackendKind(s: string | null): s is BackendKind {
  return s === "queued" || s === "direct" || s === "channel" || s === "frame";
}
