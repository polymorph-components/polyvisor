/// <reference lib="dom" />
// Host wiring for the visor spike: the three extra imports our world adds
// on top of `polymorph:dioxus/app`, the foreign-sheet seam, and a mount
// that hands back the guest's `control` export.
//
// Governing docs: ../wit/world.wit (world `visor`),
// @polyengine/dioxus-host/host.ts (= ../../../polyengine-dioxus/host/src/host.ts;
// the bare specifier is mapped in deno.json so this file does not encode the
// checkout's depth) (`mountApp`, whose body this
// file mirrors), and
// ../../../polyengine-dioxus/.deps/polyengine/contracts/embedder-api.md
// ("Module wiring and instantiation", "Value mapping") — cited as
// `contract:<section>`.
//
// WHY THIS IS NOT A CALL TO `mountApp`. `mountApp`'s `MountOptions` is
// `{ source, root, onError }`: there is no seam for additional imports, and
// its `Mounted` return exposes the applier/dispatcher but not
// `instance.exports`. Our world adds three imports and one export, so
// neither end fits. Everything mechanical is still the sibling's code —
// `DomApplier`, `DispatchGate`, `EventDispatcher`, `applyOperations`,
// `createDomImports` are all imported, not reimplemented — but the ~40
// lines of instantiate/read-loop wiring are duplicated here. Two upstream
// additions would delete this duplication: an `imports?: Record<string,
// unknown>` field on `MountOptions` merged into the import record, and
// `exports` on `Mounted`. Reported as the spike's main integration finding.

import { instantiate } from "@deltic/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import type { InstantiateSource } from "@deltic/runtime/embedder";
import type { Stream } from "@deltic/protocol";

import { DomApplier } from "@polyengine/dioxus-host/applier.ts";
import { DispatchGate } from "@polyengine/dioxus-host/dispatch.ts";
import { createDomImports } from "@polyengine/dioxus-host/host.ts";
import {
  EventDispatcher,
  serializePayload,
} from "@polyengine/dioxus-host/events.ts";
import type { NativeEventLike } from "@polyengine/dioxus-host/events.ts";
import { applyOperations } from "@polyengine/dioxus-host/operations.ts";
import type { Operation } from "@polyengine/dioxus-host/operations.ts";

import { ForeignSlotHost } from "./sheets.ts";

// -- `polymorph:visor-spike/store` -------------------------------------------

/** WIT `store.slot` — an enum lifts as the bare kebab-case case name
 * (contract:"Value mapping"). */
export type Slot = "hue" | "word" | "identity" | "events" | "legacy-hue";

/** The slot -> storage-key mapping lives HERE, not in the guest. That is the
 * whole point of naming slots rather than keys: a component that cannot
 * spell a key cannot reach the rest of the origin's localStorage
 * (wit/world.wit, interface `store`). The prefix is the consumer's. */
const KEYS: Record<Slot, string> = {
  hue: "pm-spike-hue",
  word: "pm-spike-word",
  identity: "pm-spike-identity",
  events: "pm-spike-events",
  "legacy-hue": "pm-spike-visor-hue",
};

/** Call record, so the e2e can assert (2): the host's `store.get` really was
 * invoked by the guest during mount. */
export interface StoreLog {
  calls: Array<{ op: "get" | "set" | "remove" | "clear-all"; slot?: Slot }>;
}

export function createStoreImports(log: StoreLog) {
  return {
    /** WIT `option<string>` lifts as `string | undefined`
     * (contract:"Value mapping"); `null` from `getItem` means never
     * written, which is exactly the `none` the WIT doc distinguishes from
     * written-empty. */
    get(key: Slot): string | undefined {
      log.calls.push({ op: "get", slot: key });
      return localStorage.getItem(KEYS[key]) ?? undefined;
    },
    set(key: Slot, value: string): void {
      log.calls.push({ op: "set", slot: key });
      localStorage.setItem(KEYS[key], value);
    },
    remove(key: Slot): void {
      log.calls.push({ op: "remove", slot: key });
      localStorage.removeItem(KEYS[key]);
    },
    clearAll(): void {
      log.calls.push({ op: "clear-all" });
      // Every slot at once, from the SAME map the individual accessors use
      // — a slot added to `KEYS` later cannot be forgotten by an erase
      // ceremony enumerating them by hand (wit/world.wit:50-53).
      for (const k of Object.values(KEYS)) localStorage.removeItem(k);
    },
  };
}

// -- `polymorph:visor-spike/chrome` ------------------------------------------

export function createChromeImports(_sheets: ForeignSlotHost) {
  return {
    viewportHeight(): number {
      return globalThis.innerHeight;
    },
  };
}

// -- `polymorph:visor-spike/embedder` ----------------------------------------

/** Every `embedder` call, timestamped, so the e2e can read the visor's own
 * lifecycle notifications off `globalThis` (dispatch's "record every
 * notification with a timestamp"). */
export interface EmbedderLog {
  calls: Array<{ fn: string; at: number; arg?: unknown }>;
}

export function createEmbedderImports(log: EmbedderLog, sheets: ForeignSlotHost) {
  const note = (fn: string) => (arg?: unknown) => {
    log.calls.push({ fn, at: Date.now(), arg });
  };
  return {
    requestNaming: note("request-naming"),
    requestSettings: note("request-settings"),
    // KNOWN BROKEN, FIXED: `requestBack` was missing entirely, which failed
    // instantiation outright (the WIT gained `embedder.request-back` this
    // round — wit/world.wit:140-148's CONTRACT BUG note).
    requestBack: note("request-back"),
    tenantBeforeShow: note("tenant-before-show"),
    tenantBeforeCollapse: note("tenant-before-collapse"),
    tenantAfterCollapse: note("tenant-after-collapse"),
    tenantAfterRestore: note("tenant-after-restore"),
    tenantArmed(tenant: string): void {
      note("tenant-armed")(tenant);
      sheets.arm(tenant);
    },
    tenantBuild(tenant: string): void {
      note("tenant-build")(tenant);
      sheets.build(tenant);
    },
    tenantUnmount(tenant: string): void {
      note("tenant-unmount")(tenant);
      sheets.unmount(tenant);
    },
  };
}

// -- the mount ---------------------------------------------------------------

/** `polymorph:visor-spike/control`, in full — every function on the WIT
 * interface, camelCased (contract:"Value mapping"). */
export interface TenantSpec {
  name: string;
  spoken: string;
  exclusive: boolean;
  armed: boolean;
  dim: boolean;
  suspendable: boolean;
}
export interface BackAction {
  label?: string;
}
export interface CloseReason {
  restoreContext: boolean;
}
export interface WitIdentity {
  name: string;
  device: string;
  icon: string;
}
export interface EventRecord {
  at: bigint;
  text: string;
}
export interface Control {
  claim(): boolean;
  getIdentity(): WitIdentity;
  saveIdentity(rec: WitIdentity): void;
  committedHue(): number;
  applyHue(hue: number): void;
  commitHue(hue: number): void;
  speakWord(): void;
  rerollWord(): void;
  setContext(ctx: unknown): void;
  announce(text: string, ms: number): void;
  pulseContext(srText?: string): void;
  setBack(action?: BackAction): void;
  addEvent(text: string): void;
  listEvents(): EventRecord[];
  markEventsSeen(): void;
  unseenEventCount(): number;
  setCondition(key: string, text: string): boolean;
  clearCondition(key: string): boolean;
  listConditions(): Array<[string, string]>;
  registerTenant(spec: TenantSpec): void;
  openTenant(tenant: string, ctx: unknown): boolean;
  closeTenant(tenant: string, reason: CloseReason): void;
  rebuildTenant(tenant: string): void;
  tenantIsOpen(tenant: string): boolean;
  tenantIsSuspended(tenant: string): boolean;
  restoreContext(): void;
  mountSheet(tenant: string, height: number): void;
  resizeSheet(height: number): void;
  erase(): void;
}

export interface MountVisorOptions {
  source: InstantiateSource;
  root: Element;
  onError?: (err: unknown) => void;
}

export interface MountedVisor {
  control: Control;
  store: StoreLog;
  embedder: EmbedderLog;
  /** Raw export record, for the e2e's naming assertion. */
  // deno-lint-ignore no-explicit-any
  exports: Record<string, any>;
  /** For the e2e's foreign-slot assertions. */
  sheets: ForeignSlotHost;
  dispose(): void;
}

/** The interface id the `control` export is keyed by: the fully-qualified
 * WIT id verbatim, version included (contract:"Module wiring and
 * instantiation", the interface-key row of its table). */
export const CONTROL_ID = "polymorph:visor-spike/control@0.1.0";

/** The three demo tenants, mirroring demo/host/demo.ts's shapes
 * (credentialTenant / pickerTenant / the settings tenant): "credentials" is
 * exclusive, armed and dims the page; "picker" is suspendable; "settings"
 * is ordinary. Registered once, right after mount, so the drawer gates have
 * something real to open. */
const DEMO_TENANTS: TenantSpec[] = [
  { name: "credentials", spoken: "credentials", exclusive: true, armed: true, dim: true, suspendable: false },
  { name: "picker", spoken: "storage picker", exclusive: false, armed: false, dim: false, suspendable: true },
  { name: "settings", spoken: "visor settings", exclusive: false, armed: false, dim: false, suspendable: false },
];

export async function mountVisor(opts: MountVisorOptions): Promise<MountedVisor> {
  const onError = opts.onError ?? (() => {});
  const storeLog: StoreLog = { calls: [] };
  const embedderLog: EmbedderLog = { calls: [] };
  let disposed = false;
  let control: Control | undefined;
  const sheets = new ForeignSlotHost({
    mountSheet: (tenant, height) => control!.mountSheet(tenant, height),
    resizeSheet: (height) => control!.resizeSheet(height),
  });

  // deno-lint-ignore no-explicit-any
  let handleEventExport: ((...a: any[]) => unknown) | undefined;

  const dispatcher = new EventDispatcher(
    opts.root,
    (elementId, nameId, name, ev) => {
      if (disposed || !handleEventExport) return;
      const payload = serializePayload(name, ev);
      const domEvent = new DomEvent(ev);
      gate.dispatch(() => handleEventExport!(elementId, nameId, payload, domEvent));
    },
  );
  const applier = new DomApplier(opts.root, dispatcher);
  const gate = new DispatchGate(onError);

  // Keyed by the verbatim interface id, version included
  // (contract:"Module wiring and instantiation").
  const instance = await instantiate(opts.source, {
    ...wasi(),
    "polymorph:dioxus/events@0.5.0": { DomEvent },
    "polymorph:dioxus/dom@0.5.0": createDomImports(applier, gate),
    "polymorph:visor-spike/store@0.1.0": createStoreImports(storeLog),
    "polymorph:visor-spike/chrome@0.1.0": createChromeImports(sheets),
    "polymorph:visor-spike/embedder@0.1.0": createEmbedderImports(embedderLog, sheets),
  });

  // deno-lint-ignore no-explicit-any
  const exports = instance.exports as Record<string, any>;
  handleEventExport = exports.handleEvent;

  const ops = await (exports.run as () => Promise<Stream<Operation>>)();

  const MAX_READ = 1 << 22;
  (async () => {
    while (!disposed) {
      const chunk = await ops.read(MAX_READ);
      if (chunk.length === 0) break;
      gate.beginApply();
      try {
        applyOperations(chunk, applier);
      } finally {
        gate.endApply();
      }
    }
  })().catch((err: unknown) => {
    if (!disposed) onError(err);
  });

  control = exports[CONTROL_ID] as Control | undefined;
  if (!control) {
    throw new Error(
      `no ${CONTROL_ID} on instance.exports; got: ${Object.keys(exports).join(", ")}`,
    );
  }

  // Register the three demo tenants now the export is live. Registration
  // order is precedence order (wit/world.wit:250-251), so this order is
  // itself part of what the drawer gates exercise.
  for (const spec of DEMO_TENANTS) control.registerTenant(spec);

  return {
    control,
    store: storeLog,
    embedder: embedderLog,
    exports,
    sheets,
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.dispose();
      dispatcher.dispose();
      ops.drop();
    },
  };
}

/** Host-implemented `polymorph:dioxus/events.dom-event`
 * (contract:"Resources"). Identical to `mountApp`'s private class of the
 * same name — it is not exported from host.ts, so it is restated rather
 * than imported. */
class DomEvent {
  #native: NativeEventLike;
  constructor(native: NativeEventLike) {
    this.#native = native;
  }
  preventDefault(): void {
    this.#native.preventDefault?.();
  }
  stopPropagation(): void {
    this.#native.stopPropagation?.();
  }
}
