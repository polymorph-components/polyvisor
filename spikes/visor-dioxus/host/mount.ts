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
// WHY THIS IS NOT A CALL TO `mountApp`. `mountApp`'s `MountOptions` grew at
// fdc0d52 (`eval`, `history`, `intercept` joined `source`/`root`/`hydrate`/
// `onError`), but not in the direction this file needs: there is still no seam
// for ADDITIONAL imports, and its `Mounted` return still exposes the applier/
// dispatcher/history but not `instance.exports`. Our world adds five imports
// and five exports, so neither end fits. Everything mechanical is still the
// sibling's code — `DomApplier`, `DispatchGate`, `EventDispatcher`,
// `applyOperations`, `createDomImports`, `createHeadImports`,
// `createHistoryImports` are all imported, not reimplemented — but the ~40
// lines of instantiate/read-loop wiring are duplicated here. Two upstream
// additions would delete this duplication: an `imports?: Record<string,
// unknown>` field on `MountOptions` merged into the import record, and
// `exports` on `Mounted`. Reported as the spike's main integration finding.

import { instantiate } from "@deltic/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import type { InstantiateSource } from "@deltic/runtime/embedder";
import type { Stream } from "@deltic/protocol";
import { ComponentException } from "@deltic/protocol";

import { DomApplier } from "@polyengine/dioxus-host/applier.ts";
import { DispatchGate } from "@polyengine/dioxus-host/dispatch.ts";
import { createDomImports } from "@polyengine/dioxus-host/host.ts";
import { createHeadImports } from "@polyengine/dioxus-host/head.ts";
import { createHistoryImports, memoryHistory } from "@polyengine/dioxus-host/history.ts";
import {
  EventDispatcher,
  HostDataTransfer,
  HostFile,
  serializePayload,
} from "@polyengine/dioxus-host/events.ts";
import type { NativeEventLike } from "@polyengine/dioxus-host/events.ts";
import { applyOperations } from "@polyengine/dioxus-host/operations.ts";
import type { Operation } from "@polyengine/dioxus-host/operations.ts";

import { ForeignSlotHost } from "./sheets.ts";
import { createPairingDriverImports } from "./pairing.ts";
import type { PairingCallLog, PairingTestControls } from "./pairing.ts";
import { createEntryHostImports, defaultEntryTestControls } from "./entry.ts";
import type { EntryCallLog, EntryTestControls } from "./entry.ts";

// -- `polymorph:visor-spike/store` -------------------------------------------

/** WIT `store.slot` — an enum lifts as the bare kebab-case case name
 * (contract:"Value mapping"). `account` is the USER-SYSTEM BOOT CACHE
 * (wit/world.wit's `store.slot` doc: "the last-known profile, device list
 * and account marks, reconciled against the partition at boot") — a slot
 * of its own, not a corner of `marks`, for the reason the WIT doc gives. */
export type Slot =
  | "hue"
  | "word"
  | "identity"
  | "events"
  | "marks"
  | "account"
  | "legacy-hue";

/** The slot -> storage-key mapping lives HERE, not in the guest. That is the
 * whole point of naming slots rather than keys: a component that cannot
 * spell a key cannot reach the rest of the origin's localStorage
 * (wit/world.wit, interface `store`). The prefix is the consumer's. */
const KEYS: Record<Slot, string> = {
  hue: "pm-spike-hue",
  word: "pm-spike-word",
  identity: "pm-spike-identity",
  events: "pm-spike-events",
  marks: "pm-spike-marks",
  account: "pm-spike-account",
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
    /** `chrome.reload` — the erase ceremony's last step (wit/world.wit's
     * `chrome.reload` doc). Real `location.reload()`: the e2e observes it
     * happened by waiting for the page's own reload/navigation, exactly as
     * a user would see it happen. */
    reload(): void {
      location.reload();
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

/** The consumer-side knobs the e2e needs to reach past `embedder`'s
 * notification/query split (wit/world.wit's `embedder` doc): `can-open` and
 * `nested-place-active` are QUERIES the consumer answers, and `on-reset` is
 * the one FALLIBLE one — the refusal path is the one the erase ceremony's
 * whole design is about, so the harness must be able to force it on demand
 * rather than only ever exercise the ok arm.
 *
 * `onResetFail`: `false` = ok; a `string` or `true` = fail (a `string`
 * becomes the `ComponentException`'s payload, `true` uses a fixed one —
 * `sheets.ts`'s own ceremony never renders the payload either way, see
 * `src/sheets/reset.rs`'s CONTRACT note, so the exact string is not
 * load-bearing for the guest, only for the host-side calls-log assertion). */
export interface EmbedderTestControls {
  canOpen: boolean;
  nestedPlaceActive: boolean;
  onResetFail: boolean | string;
}

export function createEmbedderImports(
  log: EmbedderLog,
  sheets: ForeignSlotHost,
  testControls: EmbedderTestControls,
) {
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

    // -- the ceremonies' consumer half (`VisorSheetsConfig`) --------------

    canOpen(): boolean {
      note("can-open")();
      return testControls.canOpen;
    },
    beforeOpen: note("before-open"),
    onNamed(provenance: string, petname: string, icon: string): void {
      note("on-named")({ provenance, petname, icon });
    },
    onForgotten: note("on-forgotten"),
    onIdentityCommitted(rec: WitIdentity, hue: number): void {
      note("on-identity-committed")({ rec, hue });
    },
    nestedPlaceActive(): boolean {
      note("nested-place-active")();
      return testControls.nestedPlaceActive;
    },
    nestedPlaceFreeze: note("nested-place-freeze"),
    nestedPlaceThaw: note("nested-place-thaw"),
    onAction: note("on-action"),

    /** `on-reset` — async and fallible (wit/world.wit's `embedder.on-reset`
     * doc). ONE FLAG the e2e can flip (`testControls.onResetFail`) to make
     * it fail on demand: the refusal path is the one the ceremony's design
     * is actually about (nothing forgotten on `err`), so an untested
     * failure arm would be the whole risk left unexercised.
     *
     * `result<_, string>` as a HOST IMPORT lowers as: return (here,
     * resolve) `undefined` for `ok`, `throw`/reject a branded
     * `ComponentException(payload)` for `err`
     * (contract:"Value mapping", the `result<T,E>` function-result row,
     * and the "Host import with `result<T, E>`" bullet). */
    async onReset(): Promise<void> {
      note("on-reset")();
      if (testControls.onResetFail !== false) {
        throw new ComponentException(
          typeof testControls.onResetFail === "string" ? testControls.onResetFail : "consumer refused",
        );
      }
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

// -- `polymorph:visor-spike/types`, `sheets`, `marks` ------------------------

/** `types.surface`, camelCased, for `sheets.request-naming`'s argument and
 * `control`'s context variant's payload. `meta`/`firstSeen` are sheet-only
 * (wit/world.wit's own note) but live on the one shared shape rather than a
 * second one, since the WIT's `surface` record is itself the one shape. */
export interface WitSurface {
  name: string;
  nickname: string;
  icon: string;
  isNew: boolean;
  petname?: string;
  nomination?: string;
  meta?: { label: string; value: string; foreign: boolean };
  firstSeen?: bigint;
}

/** `sheets.action`, camelCased. */
export interface SheetAction {
  label: string;
  hint?: string;
  key: string;
}

/** `polymorph:visor-spike/sheets`, in full. */
export interface Sheets {
  configure(resetConsequences: string[], extraActions: SheetAction[]): void;
  requestNaming(target: WitSurface): void;
  requestSettings(): void;
  requestReset(): void;
  requestEvents(): void;
  closeNaming(restoreContext: boolean): void;
  closeSettings(restoreContext: boolean, commit: boolean): void;
  closeReset(restoreContext: boolean): void;
  closeEvents(restoreContext: boolean): void;
  namingOpen(): boolean;
  settingsOpen(): boolean;
  resetOpen(): boolean;
  eventsOpen(): boolean;
}

export interface PetMark {
  icon: string;
  firstSeen: bigint;
  petname?: string;
}
export interface MarkEntry {
  provenance: string;
  mark: PetMark;
}
export interface Marked {
  mark: PetMark;
  isNew: boolean;
}
export interface Offer {
  glyph: string;
  nominated: boolean;
}
export interface Clash {
  key: string;
  petname: string;
}

/** `polymorph:visor-spike/marks`, in full — the trust table, exported
 * because it is consumer-facing as well as ceremony-facing. */
export interface Marks {
  listAll(): MarkEntry[];
  mark(provenance: string): Marked;
  setPetname(provenance: string, petname: string, icon: string): void;
  forget(provenance: string): void;
  eraseAll(): void;
  freeIcons(provenance: string): string[];
  iconOffers(provenance: string, nomination?: string): Offer[];
  collision(provenance: string, petname: string): Clash | undefined;
}

/** `polymorph:visor-spike/pairing`, in full — the pairing ceremonies as the
 * consumer drives them. */
export interface Pairing {
  requestJoin(): void;
  requestAdd(): void;
  joinOpen(): boolean;
  addOpen(): boolean;
  closePairing(restoreContext: boolean): void;
  drainUsEvents(): Promise<void>;
  reconcile(): Promise<void>;
}

/** `entry.picker-row`, camelCased — re-exported from `./entry.ts`'s WIT
 * mirror so a consumer of this module names one type for both the export's
 * argument and the `entry-host` import's record. */
export type { PickerRow } from "./entry.ts";
import type { PickerRow } from "./entry.ts";

/** `polymorph:visor-spike/entry`, in full — the entry ceremonies as the
 * consumer drives them. */
export interface Entry {
  mountDevicePicker(rows: PickerRow[], problem?: string): void;
  offerFirstRun(): void;
  pickerOpen(): boolean;
  firstRunOpen(): boolean;
}

export interface MountVisorOptions {
  source: InstantiateSource;
  root: Element;
  onError?: (err: unknown) => void;
}

export interface MountedVisor {
  control: Control;
  sheets_api: Sheets;
  marks: Marks;
  pairing: Pairing;
  entryApi: Entry;
  store: StoreLog;
  embedder: EmbedderLog;
  /** The e2e's own knobs onto `embedder`'s query/fallible half — see
   * `EmbedderTestControls`. */
  embedderTest: EmbedderTestControls;
  /** The e2e's knobs onto the pairing-driver mock — see
   * `./pairing.ts`'s `PairingTestControls`. */
  pairingTest: PairingTestControls;
  pairingCalls: PairingCallLog;
  /** The e2e's knobs onto the entry-host mock — see `./entry.ts`'s
   * `EntryTestControls`. */
  entryTest: EntryTestControls;
  entryCalls: EntryCallLog;
  /** Raw export record, for the e2e's naming assertion. */
  // deno-lint-ignore no-explicit-any
  exports: Record<string, any>;
  /** For the e2e's foreign-slot assertions. */
  sheets: ForeignSlotHost;
  dispose(): void;
}

/** The interface ids the exports are keyed by: the fully-qualified WIT id
 * verbatim, version included (contract:"Module wiring and instantiation",
 * the interface-key row of its table). */
export const CONTROL_ID = "polymorph:visor-spike/control@0.1.0";
export const SHEETS_ID = "polymorph:visor-spike/sheets@0.1.0";
export const MARKS_ID = "polymorph:visor-spike/marks@0.1.0";
export const PAIRING_ID = "polymorph:visor-spike/pairing@0.1.0";
export const ENTRY_ID = "polymorph:visor-spike/entry@0.1.0";

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
  const embedderTest: EmbedderTestControls = {
    canOpen: true,
    nestedPlaceActive: false,
    onResetFail: false,
  };
  const pairingCalls: PairingCallLog = { calls: [] };
  const pairingTest: PairingTestControls = { pendingUsEvents: [] };
  const entryCalls: EntryCallLog = { calls: [] };
  const entryTest: EntryTestControls = defaultEntryTestControls();
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
    // `DomEvent` is host-implemented HERE (see the class at the foot of this
    // file); `File`/`DataTransfer` are the sibling's, imported rather than
    // restated because — unlike `DomEvent` — they ARE exported from the host
    // package.
    //
    // The two resource classes arrived with the fdc0d52 bump (event payloads
    // gained file and drag-transfer handles). This spike renders no file input
    // and no drag source, but the CLASSES are not optional: the guest's
    // generated bindings import the resource TYPES `events.file` and
    // `events.data-transfer` whether or not a payload ever carries one, so a
    // missing key is a failed instantiation, not a dormant capability. That is
    // exactly how the bump surfaced here — "the component imports the resource
    // type 'data-transfer'; provide the implementing class as 'DataTransfer'".
    //
    // Keys are the resource name PascalCased (contract:"Resources").
    "polymorph:dioxus/events@0.6.0": { DomEvent, File: HostFile, DataTransfer: HostDataTransfer },
    "polymorph:dioxus/dom@0.6.0": createDomImports(applier, gate),
    // NOT ASKED FOR, AND SUPPLIED ANYWAY. The renderer provides `WitDocument`
    // and `WitHistory` as root context unconditionally
    // (polyengine-dioxus/src/driver.rs:258-269), so every component built
    // against the crate imports `head` and `history` whether it renders a
    // `document::Title` or runs a router or not — this one does neither. A
    // missing key here is not a dormant capability, it is a failed
    // instantiation, so both must be present.
    //
    // `allowScript: false` — host.ts computes this as `!!opts.eval`, and this
    // mount grants no eval (see the eval note below), so the renderer's WIT
    // says the answer already: "The default host refuses `script` unless the
    // mount also granted `eval` — a script tag is eval by another name."
    // Refusing is silent by design (`create-element` returns `false` and the
    // guest has nothing to do with it), which is the correct shape here: the
    // visor renders into a page it SHARES with the consumer, so the sibling's
    // default head policy is exactly the policy wanted.
    "polymorph:dioxus/head@0.6.0": createHeadImports(document, gate, { allowScript: false }),
    // MEMORY HISTORY AT "/", because THE VISOR DOES NOT ROUTE. It has no
    // router, no routes, and no link that navigates; `history` is imported
    // only because the renderer installs the provider for everyone. Memory
    // history is therefore the honest answer — a stack of one entry nothing
    // ever pushes to.
    //
    // Deliberately NOT `fragmentHistory`: that encodes routes into the URL
    // fragment, which would have the visor's shell claim the page's fragment.
    // The fragment belongs to the apps the visor hosts, not to the visor.
    "polymorph:dioxus/history@0.6.0": createHistoryImports(memoryHistory()),
    // NO `polymorph:dioxus/eval@0.6.0` KEY, deliberately, and it is a
    // two-sided opt-in so this end matters. The renderer's `eval` Cargo
    // feature is off (Cargo.toml carries the argument — the capability had one
    // suspected customer, the pairing QR, and the port measured that it did
    // not need it), so the component emits no `eval` import and a key here
    // would be an import record entry nothing claims. Re-enabling is the
    // feature, the `with:` mapping in src/component.rs, and this key; a
    // component built with only one side fails to instantiate, which is the
    // loud, safe direction.
    "polymorph:visor-spike/store@0.1.0": createStoreImports(storeLog),
    "polymorph:visor-spike/chrome@0.1.0": createChromeImports(sheets),
    "polymorph:visor-spike/embedder@0.1.0": createEmbedderImports(embedderLog, sheets, embedderTest),
    "polymorph:visor-spike/pairing-driver@0.1.0": createPairingDriverImports(pairingTest, pairingCalls),
    "polymorph:visor-spike/entry-host@0.1.0": createEntryHostImports(entryTest, entryCalls),
  });

  // deno-lint-ignore no-explicit-any
  const exports = instance.exports as Record<string, any>;
  handleEventExport = exports.handleEvent;

  // `render-mode`, added in 0.6.0. A payload-less variant lowers as
  // `{ kind: "..." }` (contract:"Value mapping"). `fresh` unconditionally: the
  // spike serves an empty mount root, and hydration would require this page to
  // serve `dioxus-ssr` prerendered markup from the SAME component at the SAME
  // initial state — which the visor's initial state (read out of localStorage
  // at boot) is not, per origin or per user. Mirrors `mountApp`'s default.
  const ops = await (exports.run as (m: unknown) => Promise<Stream<Operation>>)({
    kind: "fresh",
  });

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
  const sheetsApi = exports[SHEETS_ID] as Sheets | undefined;
  if (!sheetsApi) {
    throw new Error(
      `no ${SHEETS_ID} on instance.exports; got: ${Object.keys(exports).join(", ")}`,
    );
  }
  const marks = exports[MARKS_ID] as Marks | undefined;
  if (!marks) {
    throw new Error(
      `no ${MARKS_ID} on instance.exports; got: ${Object.keys(exports).join(", ")}`,
    );
  }
  const pairing = exports[PAIRING_ID] as Pairing | undefined;
  if (!pairing) {
    throw new Error(
      `no ${PAIRING_ID} on instance.exports; got: ${Object.keys(exports).join(", ")}`,
    );
  }
  const entryApi = exports[ENTRY_ID] as Entry | undefined;
  if (!entryApi) {
    throw new Error(
      `no ${ENTRY_ID} on instance.exports; got: ${Object.keys(exports).join(", ")}`,
    );
  }

  // Register the three demo tenants now the export is live. Registration
  // order is precedence order (wit/world.wit:250-251), so this order is
  // itself part of what the drawer gates exercise.
  for (const spec of DEMO_TENANTS) control.registerTenant(spec);

  return {
    control,
    sheets_api: sheetsApi,
    marks,
    pairing,
    entryApi,
    store: storeLog,
    embedder: embedderLog,
    embedderTest,
    pairingTest,
    pairingCalls,
    entryTest,
    entryCalls,
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
