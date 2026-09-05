// Shared wiring: artifact loading, backend construction, and the
// serialized guest-call runner used by every page.

import { artifactsFromEnvelope, instantiate } from "@deltic/runtime/embedder";
import { createSurface } from "../../../visor/surface/surface.ts";
import type { Backend, BackendKind } from "../../../visor/surface/backend.ts";
import { createDirectBackend } from "../../../visor/surface/backend-direct.ts";
import { createQueuedBackend } from "../../../visor/surface/backend-queued.ts";
import { createChannelBackend } from "../../../visor/surface/backend-channel.ts";
import { mountApp } from "../../../visor/frame/mount.ts";
import { createApplier } from "../../../visor/surface/applier.ts";
import type { UiEvent } from "../../../visor/surface/events.ts";
import { createRunner, type Runner } from "../../../visor/surface/runner.ts";

export { createRunner, type Runner };

// --- artifacts ---------------------------------------------------------------

const artifactCache = new Map<
  string,
  Promise<{ envelope: string; bytes: Uint8Array }>
>();

function loadArtifacts(name: string) {
  let p = artifactCache.get(name);
  if (!p) {
    p = Promise.all([
      fetch(`./${name}.plan.json`).then((r) => {
        if (!r.ok) throw new Error(`${name} plan fetch: HTTP ${r.status}`);
        return r.text();
      }),
      fetch(`./${name}.component.wasm`).then((r) => {
        if (!r.ok) throw new Error(`${name} component fetch: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]).then(([envelope, bytes]) => ({
      envelope,
      bytes: new Uint8Array(bytes),
    }));
    artifactCache.set(name, p);
  }
  return p;
}

export async function instantiateWorld(
  name: string,
  imports: Record<string, Record<string, unknown>>,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const { envelope, bytes } = await loadArtifacts(name);
  const component = await instantiate(
    artifactsFromEnvelope(envelope, bytes),
    imports,
  );
  // deno-lint-ignore no-explicit-any
  return component.exports as any;
}

// --- backends ------------------------------------------------------------------

/** The three backends `createBackend` builds synchronously, in-realm.
 * "frame" is deliberately excluded from this type: it is not a backend
 * this file builds at all any more — it is the app-mount seam
 * (visor/frame/mount.ts), which stands up the frame, the surface and the
 * runner together. Both callers branch on it before reaching here. */
export type SameRealmBackendKind = Exclude<BackendKind, "frame">;

export function createBackend(
  kind: SameRealmBackendKind,
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
): Backend {
  switch (kind) {
    case "direct":
      return createDirectBackend(container, dispatch);
    case "queued": {
      // Same-realm canary configuration: structuredClone enforces
      // serializability on every batch; the applier re-validates.
      const applier = createApplier(container, dispatch);
      return createQueuedBackend((ops) => applier.apply(structuredClone(ops)));
    }
    case "channel":
      return createChannelBackend(container, dispatch);
  }
}

// --- the TodoMVC app ------------------------------------------------------------

export interface TodoExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
}

export interface TodoApp {
  /** The serialized guest-call chain — present for the three same-realm
   * kinds only. `kind === "frame"` goes through the app-mount seam
   * (visor/frame/mount.ts), which owns its runner and exposes what a
   * caller may do with it (`exports`, suspension, teardown) rather than
   * the chain itself. The two harness consumers of `settle`/`generation`
   * (harness.ts, bench.ts) sweep the same-realm kinds only. */
  runner?: Runner;
  exports: TodoExports;
  /** Inject a synthetic event record (harness use). */
  sendEvent(ev: UiEvent): Promise<void>;
  sendRoute(route: string): Promise<void>;
  /** Destroy the sandboxed frame surface, when there is one — undefined
   * (no-op) for the three same-realm kinds, where retirement is just
   * "pause the runner forever, drop the DOM node" and needs no help from
   * here. This is only the frame's own teardown, and awaiting it is the
   * difference between the iframe being GONE and merely superseded.
   *
   * No caller in this spike today: the visor's simulated "kill" tenant
   * that used to await it is gone (see host/visor.ts). Kept deliberately
   * — a real embedder API for retiring a surface is a framework-real
   * need (#22), and this is the honest half of it. */
  teardown?(): Promise<void>;
}

export async function startTodoApp(
  kind: BackendKind,
  container: HTMLElement,
  route: () => string,
  onEventError: (e: unknown) => void,
  artifact = "todomvc",
): Promise<TodoApp> {
  // THE FRAME KIND IS NOT A BACKEND CHOICE ANY MORE, it is the app-mount
  // seam: the frame, the surface and the runner all live behind
  // `mountApp` (visor/frame/mount.ts), which is what the visor's own
  // pages use. The three same-realm kinds below stay exactly as they
  // were — they are the differential harness's instrument, not a
  // product placement.
  if (kind === "frame") {
    const { envelope, bytes } = await loadArtifacts(artifact);
    const mounted = await mountApp<TodoExports>({
      container,
      artifact: { envelope, bytes },
      imports: {},
      // The seam holds a route VALUE, not the caller's getter, so the
      // route travels with the call that announces it. Every route
      // change in this spike already comes through `sendRoute`.
      route: route(),
      onEventError,
    });
    await mounted.exports.run();
    return {
      exports: mounted.exports,
      sendEvent: (ev) => mounted.exports.onEvent(ev),
      sendRoute: (r) => {
        mounted.setRoute(r);
        return mounted.exports.onRoute(r);
      },
      teardown: () => mounted.destroy(),
    };
  }

  // DOM-originated events land on the same serialized chain as everything
  // else; the exports binding below closes the loop.
  let dispatch: (ev: UiEvent) => void = () => {};
  const backend = createBackend(kind, container, (ev) => dispatch(ev));
  const surface = createSurface(backend, route);
  const exports = (await instantiateWorld(
    artifact,
    surface.imports,
  )) as unknown as TodoExports;
  const runner = createRunner(surface);
  dispatch = (ev) => {
    runner.call(() => exports.onEvent(ev)).catch(onEventError);
  };
  await runner.call(() => exports.run());
  return {
    runner,
    exports,
    sendEvent: (ev) => runner.call(() => exports.onEvent(ev)),
    sendRoute: (r) => runner.call(() => exports.onRoute(r)),
  };
}

// --- the lab guest ----------------------------------------------------------------

export interface LabExports {
  probe(id: number): Promise<void>;
  bench(scenario: number, n: number): Promise<void>;
}

export interface LabApp {
  /** Same-realm kinds only — see TodoApp.runner. */
  runner?: Runner;
  exports: LabExports;
}

export async function startLab(
  kind: BackendKind,
  container: HTMLElement,
): Promise<LabApp> {
  if (kind === "frame") {
    const { envelope, bytes } = await loadArtifacts("lab");
    const mounted = await mountApp<LabExports>({
      container,
      artifact: { envelope, bytes },
      imports: {},
    });
    return { exports: mounted.exports };
  }
  const backend = createBackend(kind, container, () => {});
  const surface = createSurface(backend, () => "");
  const exports = (await instantiateWorld(
    "lab",
    surface.imports,
  )) as unknown as LabExports;
  return { runner: createRunner(surface), exports };
}
