// THE APP-MOUNT SEAM. One function stands a component up on a sandboxed
// surface and hands back the handles a visor needs to drive it: the
// frame element, the exports, route, input suspension, teardown.
//
// WHY IT EXISTS AS A SEAM. Today the app's wasm instance runs in the
// VISOR's realm and only its DOM ops cross into the frame (the queued op
// protocol, frame-backend.ts → frame.ts → surface/applier.ts). The
// placement validated in #142 (spikes 2–4) moves the instance INSIDE the
// frame: `polyvisor:surface` then binds to the frame's real DOM
// synchronously via createDirectBackend, every other import becomes a
// proxy over a MessagePort, and the visor calls the app's exports over a
// control port. That is a wholesale change of internals and NO change to
// what a visor needs from a mount — so the internals go behind this
// function, and the callers stop naming createFrameBackend,
// createSurface, instantiate and createRunner individually.
//
// Consequently: everything below is the four call sites' existing code
// factored, semantics unchanged. `createFrameBackend` has no other
// caller.

import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";
import { createFrameBackend } from "./frame-backend.ts";
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

export interface AppArtifact {
  envelope: string;
  bytes: Uint8Array;
}

export interface MountOptions {
  container: HTMLElement;
  artifact: AppArtifact;
  /** Every import the app is granted OTHER than polyvisor:surface/*,
   * keyed by verbatim WIT id (e.g. "polyvisor:tasks/tasks@0.1.0").
   * Every method is async (returns a Promise). */
  imports: Record<string, Record<string, unknown>>;
  /** Initial value returned by polyvisor:surface/shell.route(). */
  route?: string;
  theme?: "light" | "dark";
  /** Where a rejected event dispatch goes (today: pane.status / console). */
  onEventError?: (e: unknown) => void;
  /** Run after each event the guest handled successfully, on the same
   * chain (its rejection lands in `onEventError` too).
   *
   * CONTRACT: also not in the seam's specified shape. The event pump
   * lives inside the mount now, so a visor that has to react to the
   * guest having handled an event has no other way to hear about it —
   * and demo.ts's panel does: the binding is LIVE (#22 rule 2), so it
   * re-reads the panel's declared destination after every pumped event
   * rather than trusting the one it read at mount. Dropping that would
   * be a behaviour change, not a refactor. */
  afterEvent?: () => void | Promise<void>;
  /** CANCELLATION OF A MOUNT THAT IS STILL IN FLIGHT.
   *
   * CONTRACT: this option is not in the seam's specified shape; it is
   * here because the specified shape cannot express a semantic the
   * callers already have, and preserving that semantic was the harder
   * requirement. demo.ts's `mountPanel` tears a mount down WHILE it is
   * mounting (two picker clicks in quick succession), and its teardown
   * both destroys the surface and clears the region. With no way in, a
   * torn-down mount would be left holding a detached iframe that can
   * never complete its handshake — the returned promise would never
   * settle, and `teardownPanel`'s completion signal, which the next
   * mount awaits, would hang forever.
   *
   * Aborting destroys the frame backend, which is what makes
   * `frameBackend.backend` reject with "frame backend destroyed before
   * it was ready" — the SAME rejection the callers already distinguish
   * from a real failure by their generation counter. Nothing else about
   * it is new. */
  signal?: AbortSignal;
}

export interface Mounted<E> {
  frame: HTMLIFrameElement;
  /** The app's exports. EVERY method returns a Promise and is serialized
   * through the runner — callers never see the runner. */
  exports: E;
  /** polyvisor:surface/shell.route() now returns `route`. Callers still
   * invoke the app's own on-route export themselves if its world has
   * one: the visor decides whether a route change is worth telling the
   * app about, and only the app's world knows what to call. */
  setRoute(route: string): void;
  /** Input suspension (#22): stop delivering events into the guest.
   * Queued, not dropped — see runner.pause. */
  suspend(): void;
  resume(): void;
  /** Tear the surface down; resolves when it is actually gone
   * (frame-backend.ts's destroy() semantics, verbatim: idempotent, in
   * the same completion, one macrotask out so messages already posted by
   * the dying frame land before the next surface exists). */
  destroy(): Promise<void>;
}

export async function mountApp<E extends object>(
  opts: MountOptions,
): Promise<Mounted<E>> {
  // The dispatch closure is installed BEFORE the frame exists and
  // rebound once the runner does: events cannot be delivered to a guest
  // that has not been instantiated, and dropping them silently until
  // then is what the callers all did by hand.
  let dispatch: (ev: UiEvent) => void = () => {};
  const frameBackend = createFrameBackend(
    opts.container,
    (ev) => dispatch(ev),
    opts.theme ?? "light",
  );

  const onAbort = () => void frameBackend.destroy();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const backend = await frameBackend.backend;
    // `route` is read through a closure, not captured by value, so
    // `setRoute` is visible to the guest's next shell.route() call
    // without re-entering the surface.
    let route = opts.route ?? "";
    const surface = createSurface(backend, () => route);
    const instance = await instantiate(
      artifactsFromEnvelope(opts.artifact.envelope, opts.artifact.bytes),
      { ...surface.imports, ...opts.imports },
    );
    const raw = instance.exports as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const runner = createRunner(surface);
    const onEventError = opts.onEventError ?? (() => {});
    dispatch = (ev) => {
      runner.call(() => raw[EVENT_EXPORT](ev))
        .then(() => opts.afterEvent?.())
        .catch(onEventError);
    };

    // EVERY export goes through the runner, which is the whole reason
    // callers no longer need one: the serialized chain, the end-of-call
    // flush and the suspension gate are properties of "calling the
    // guest", not of any particular export. A wrapper per name, cached,
    // so repeated reads are the same function value.
    const wrapped = new Map<string, unknown>();
    const exports = new Proxy(Object.create(null) as E, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const fn = raw[prop];
        // Non-functions pass through as themselves, which also keeps the
        // proxy awaitable-safe: a `then` that is not a function means
        // `await mounted.exports` cannot mistake it for a thenable.
        if (typeof fn !== "function") return fn;
        let w = wrapped.get(prop);
        if (!w) {
          w = (...args: unknown[]) => runner.call(() => raw[prop](...args));
          wrapped.set(prop, w);
        }
        return w;
      },
    });

    return {
      frame: frameBackend.frame,
      exports,
      setRoute: (r: string) => {
        route = r;
      },
      suspend: () => runner.pause(),
      resume: () => runner.resume(),
      destroy: () => frameBackend.destroy(),
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
