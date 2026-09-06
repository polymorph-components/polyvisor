// Mount a `polymorph:stream-dom` producer with extra WIT imports.
//
// `@polymorph/stream-dom-receiver`'s own `mount()` has no way to add imports,
// and both producers here need some: the visor imports the kernel interfaces
// and `shell`, the app imports `polyvisor:app/tasks`. So this is that
// module's component-glue half — `createDriver` + `instantiate` + the
// readDirect loop — copied from receiver/src/mount.ts at the pinned rev
// (deno.json's import map) with `imports` merged in and the transports,
// recording tap and remote backend dropped: nothing here uses them.
//
// JSPI is not an option this repository takes (docs/design.md "No JSPI"):
// every realm-crossing import is `async func` and suspends through the
// component model's async ABI, so a Promise from a sync-typed import is a
// bug and the embedder should refuse it loudly. Hence `jspi: false` on the
// `instantiate` below — pinned for every call site by web/jspi_test.ts.

import { instantiate } from "@polyengine/runtime/embedder";
import type { InstantiateSource } from "@polyengine/runtime/embedder";
import type { Stream } from "@polyengine/protocol";
import { wasi } from "@polyengine/wasi";

import { createDriver } from "@polymorph/stream-dom-receiver/mod.ts";
import type { Policy } from "@polymorph/stream-dom-receiver/mod.ts";

export interface MountProducerOptions {
  source: InstantiateSource;
  root: Element;
  /** Merged into the imports record after `wasi()` and the stream-dom
   * interfaces, keyed by verbatim interface id. */
  imports?: Record<string, unknown>;
  policy?: Policy;
  resolveAsset?(handle: Uint8Array): string;
  /** Asynchronous failure after mount: the mutation stream's read session
   * rejecting (which includes a policy rejection), or a `handle-event` call
   * rejecting. */
  onError?(err: unknown): void;
}

export interface MountedProducer {
  dispose(): void;
}

/** Host-implemented `events.dom-event` resource, lent to the guest for its
 * synchronous prefix inside `handle-event`. */
class DomEvent {
  #native: Event;
  constructor(native: Event) {
    this.#native = native;
  }
  preventDefault(): void {
    this.#native.preventDefault();
  }
  stopPropagation(): void {
    this.#native.stopPropagation();
  }
}

export async function mountProducer(
  opts: MountProducerOptions,
): Promise<MountedProducer> {
  let disposed = false;
  const onError = opts.onError ?? (() => {});

  // Populated after `instantiate()`: `handle-event` may be invoked by a
  // synthetic dispatch during the first `onCommit`, before `run` resolves.
  const exports_: { handleEvent?: (...a: unknown[]) => unknown } = {};

  const driver = createDriver({
    root: opts.root,
    policy: opts.policy,
    resolveAsset: opts.resolveAsset,
    onError,
    handleEvent: (target, nameRef, payload, ev) => {
      if (!exports_.handleEvent || disposed) return;
      return exports_.handleEvent(target, nameRef, payload, new DomEvent(ev));
    },
  });

  const imports = {
    // wasip2 components import wasi:cli/io/clocks/random/filesystem whether
    // or not the guest calls them.
    ...wasi(),
    "polymorph:stream-dom/queries@0.1.0": driver.queries,
    "polymorph:stream-dom/events@0.1.0": { DomEvent },
    ...opts.imports,
  };

  const instance = await instantiate(opts.source, imports, { jspi: false });
  exports_.handleEvent = instance.exports.handleEvent as (
    ...a: unknown[]
  ) => unknown;

  const stream = await (instance.exports.run as (
    hydrate: boolean,
  ) => Promise<Stream<number>>)(false);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stream.drop();
    driver.dispose();
  }

  // Direct-access byte edge: the callback runs synchronously inside the
  // rendezvous with a view over the writer's unread bytes; `driver.push`
  // copies what it keeps before `markRead` releases the view, and throws on
  // a policy rejection — which lands on the catch below and tears the mount
  // down, so the guest observes reader-gone instead of parking forever.
  const readLoop = stream.readDirect((src) => {
    const view = src.remaining();
    driver.push(view);
    src.markRead(view.length);
    return "more";
  });
  readLoop.catch((err: unknown) => {
    if (disposed) return;
    onError(err);
    dispose();
  });

  return { dispose };
}
