// THE SOLO PAGE: one device, one engine, one visor, one app — and now a
// device that SURVIVES (PERSISTENCE.md's T-D).
//
// The three-pane demo (host/demo.ts) puts a whole account on one screen
// so a reader can watch both ends of every beat at once. That is a good
// theatre and a bad model of a deployment: the two devices share a
// process, a page, a storage origin and a boot, so several things a real
// second device must do for itself are simply not exercised.
//
// This page is the other half. It is ONE DEVICE — one engine instance,
// its own storage, its own boot — and pairing runs between TWO
// INDEPENDENT PAGES over the relay. Everything the demo could hand a
// second pane out of band, this page has to obtain over the wire:
//
//   - the ADDER's endpoint and agent ids, so the joiner can dial back
//     (engine.wit's `pair-enrollment.peer-agent-id` /
//     `peer-endpoint-id`, added for exactly this — see runtime/engine.ts's
//     `PairEnrollment`);
//   - the account's tasks partition id, read out of the synced
//     user-system doc's partition-pointer map (#36), which is the only
//     channel a freshly-joined device has for it.
//
// WHAT CHANGED IN G5, and it is the whole shape of this file's boot: the
// engine no longer runs HERE. It runs in the device's SharedWorker
// (runtime/device-store/worker.ts), one worker per device, and this page
// is a view onto it over a MessagePort — `connectDevice` hands back a
// remote `driver`/`tasks` pair that is method-for-method the engine's
// own surface (device-store/rpc.ts's tables). Three consequences worth
// stating before the code says them:
//
//   * THE DEVICE OUTLIVES THE TAB, or does not, by the user's choice.
//     A device starts T0 (ephemeral, reload-survivable through the
//     sessionStorage anchor) and is PROMOTED to T1 by a ceremony that
//     asks the seal choices. Try, then keep (#37).
//   * UNSEAL IS THE LOGIN, and the page renders NOTHING PERSONAL before
//     it: no anchor colour, no name, no icon, no app. What DOES exist
//     before it is the visor SHELL, booted UNCLAIMED
//     (`initVisor({ deferClaim: true })`): the strip in its generic grey
//     dress, an EMPTY identity cluster, and a live drawer — because the
//     device picker is a visor drawer sheet (visor/ui/entry.ts), not
//     page furniture. The CLAIM at unseal (`visor.claim()`) is when the
//     colour and the name arrive together, which is what "the visor
//     becomes yours" means here.
//
//     THE ORDERING IS UNCHANGED BY THAT, and it is the ordering that is
//     the anti-spoofing property (PERSISTENCE.md, "The index: what may
//     exist before unseal"): no colour, no name, no icon before the seal
//     opens. A page imitating the picker cannot paint your colour,
//     because at picker time nothing on this origin has — and it cannot
//     produce the picker's geometry either, since a sheet hanging off
//     the pinned strip over a dimmed page is not a thing a component
//     confined to its own rectangle can draw.
//   * THE STORAGE SEAMS REFUSE IN THE WORKER now, not here (worker.ts's
//     `NO_STORE`). Solo never had a bucket; what changed is only which
//     module states the refusal.
//
// The three-pane demo does NOT adopt any of this: it stays a direct,
// in-page embedder, deliberately, so the two pages remain two different
// arguments.

import {
  artifactsFromEnvelope,
  instantiate,
} from "@polyengine/runtime/embedder";
import { createRunner, type Runner } from "../../visor/surface/runner.ts";
import { createFrameBackend } from "../../visor/frame/frame-backend.ts";
import { createSurface } from "../../visor/surface/surface.ts";
import { initVisor, type SurfaceIdentity, type Visor, VISOR_HUES } from "../../visor/ui/visor.ts";
import { registerVisorSheets } from "../../visor/ui/sheets.ts";
import {
  type DevicePickerHost,
  type DevicePickerRow,
  type FirstRunHost,
  mountDevicePicker,
  offerFirstRun,
} from "../../visor/ui/entry.ts";
import {
  type AddPaneHandle,
  type AnnounceSink,
  drainAnnouncements,
  type JoinPaneHandle,
  mountAddPane,
  reconcileFromDriver,
  usCacheKeys,
  visorAnnounceSink,
} from "../../visor/ui/pairing.ts";
import type { PairingDriver } from "../../visor/ui/pairing-driver.ts";
import { createEnginePairingDriver } from "../../runtime/pairing-engine.ts";
import type { UiEvent } from "../../visor/surface/events.ts";
import { type EngineArtifacts, hex, unhex, until } from "../../runtime/engine.ts";
import { adoptAnchor } from "../../runtime/device-store/anchor.ts";
import {
  connectDevice,
  type DeviceConnection,
} from "../../runtime/device-store/client.ts";
import {
  type DeviceRecord,
  getDevice,
  listDevices,
  promoteDevice,
  type UnsealPolicy,
} from "../../runtime/device-store/index.ts";
import type { DeviceStatus, StoreBinding } from "../../runtime/device-store/rpc.ts";
import { putSigningKey } from "../../runtime/keystore.ts";
import { normalizeOrigin } from "../../runtime/store-egress.ts";
// THE PAGE HALF OF THE PASSKEY RUNG (PERSISTENCE.md, "The PRF rung:
// passkey unseal"). `navigator.credentials` is window-only, so the
// enrollment/assertion ceremonies live here — on the embedder's side of
// the visor seam — and hand the worker only a non-extractable derived
// KEK: never a passphrase-shaped secret, never the DEK.
import { assertPasskey, enrollPasskey, prfCapability } from "../../runtime/device-store/passkey.ts";

const params = new URLSearchParams(location.search);
// Same default as demo.ts: n0's public relay, overridable with ?relay=…
// (the e2e harness points every page at its own ephemeral one).
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// --- the OAuth redirect landing (visor-owned; DRIVE.md §3 × #7) -----------
//
// Google's consent redirects the popup back to THIS page with
// ?code=&state=. That window's only job is to relay the code to the
// opener and go away: it must not boot a second solo device (a fresh
// engine, a fresh worker attach, a fresh picker). Navigation and
// redirect handling are visor capabilities; the popup's ONLY job is to
// relay the one-shot code (DRIVE.md §3) — the worker holds the verifier
// and does the exchange, so this window never sees a token.
const relayedCode = params.get("code");
const isAuthPopup = !!relayedCode && !!window.opener;
if (isAuthPopup) {
  window.opener.postMessage(
    { pmGdriveCode: relayedCode, state: params.get("state") },
    location.origin,
  );
  const el = document.getElementById("banner");
  if (el) el.textContent = "authorization relayed — close this window";
  window.close();
}

// --- storage keys -----------------------------------------------------------
//
// `pm-solo-*`, NOT `pm-demo-*`. The two pages are served from one origin
// and therefore share localStorage; sharing the identity record and the
// anchor hue between them would make the solo page's "this is a separate
// device" claim false the moment anyone opened the demo first. The visor
// itself takes the keys as configuration precisely so two embedders on
// one origin can be two devices.
//
// THESE ARE THE VISOR'S BOOT CACHE, NOT THE DEVICE'S. The device's own
// state — which devices exist, what they are called, what opens them —
// is the device store's (an IndexedDB index plus one namespace each),
// and nothing here duplicates it. The keys below survive because the
// visor's us-cache demotion path still reads them (visor/ui/pairing.ts's
// `usCacheKeys`), and because a colour and a name are exactly the two
// things a boot must be able to paint the INSTANT the seal opens.
const VISOR_KEY = "pm-solo-visor-hue";
const IDENTITY_KEY = "pm-solo-identity";
const MARKS_KEY = "pm-solo-surface-marks";
const US_CACHE_KEYS = usCacheKeys("pm-solo");

const BUILD =
  (document.querySelector('meta[name="pm-build"]') as HTMLMetaElement | null)?.content ?? "";
const stamp = (path: string) => (BUILD && BUILD !== "__BUILD__" ? `${path}?v=${BUILD}` : path);

/** The artifact name the visor fetched the app by — and therefore the
 * key of the app's row in the trust table (provenance, never a
 * self-declared name). */
const APP_ARTIFACT = "app";
/** The account's name for its todo partition in the user-system doc's
 * pointer map. The joiner looks the partition up by THIS string, so it
 * is a contract between the two pages and not a local convention. */
const TASKS_POINTER = "tasks";

/** The device host's bundled entry (demo/justfile's `site` builds it out
 * of host/solo-worker.ts). A URL, because a SharedWorker is constructed
 * from one; stamped like every other artifact so a new build is a new
 * script rather than a cached one. */
const WORKER_URL = stamp("./solo-worker.js");
/** Where the WORKER fetches the engine from — resolved against the
 * worker's URL, which is this same directory. */
const ENGINE_ARTIFACTS = {
  envelopeUrl: stamp("./engine.plan.json"),
  wasmUrl: stamp("./engine.component.wasm"),
};

/** The input-masking type. Never a label: the visor's words are the
 * visor's own (demo/scripts/check-invariants.sh invariant (b)), and this
 * is the platform's masking token, spelled once, here. */
const MASKED = { type: "password" } as const;

async function fetchArtifacts(name: string): Promise<EngineArtifacts> {
  const [envelope, bytes] = await Promise.all([
    fetch(stamp(`./${name}.plan.json`)).then((r) => {
      if (!r.ok) throw new Error(`${name} plan: HTTP ${r.status}`);
      return r.text();
    }),
    fetch(stamp(`./${name}.component.wasm`)).then((r) => {
      if (!r.ok) throw new Error(`${name} wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { envelope, bytes: new Uint8Array(bytes) };
}

function err(e: unknown): string {
  // ONE READER FOR BOTH BACKENDS. Over the port the engine's errors
  // arrive as REAL `ComponentException`s (device-store/rpc.ts: the
  // worker sends `toCloneable`, client.ts rehydrates with
  // `fromCloneable`), so `payload` is the WIT err arm exactly as it is
  // in-process. The host's own refusals are `DeviceHostError`s with no
  // payload and a typed `code` — those fall to `message` here, and the
  // boot path below reads their `code` where it matters.
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String((e as { message?: string }).message ?? e);
}

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  poll(): Promise<boolean>;
}

// --- the one background chain ----------------------------------------------
//
// One engine instance, several callers (the join pane's poll, the add
// sheet's poll, the announcement drain, this file's own wiring). The
// guest is single-threaded and its async support is cooperative, so
// overlapping calls are serialized HERE, in exactly one place — see
// demo.ts's note on the deadlock a caller earns by wrapping itself a
// second time.
//
// THE WORKER DOES NOT DO THIS FOR US, and the distinction is worth
// keeping straight: worker.ts serializes CHECKPOINTS against each other
// and nothing else, deliberately (its "CHECKPOINTS ARE SERIALIZED"
// note), so a tab that fires two overlapping driver calls still fires
// them at one cooperative guest. The chain is therefore still this
// page's job even though the engine moved.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(f: () => Promise<T>): Promise<T> {
  const next = chain.then(f, f);
  chain = next.catch(() => {});
  return next;
}

/** Every method of a driver put on the chain. Mechanical, so it cannot
 * forget one: it is built from the object it wraps. */
function serialized(raw: PairingDriver): PairingDriver {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(raw) as (keyof PairingDriver)[]) {
    const fn = raw[key];
    if (typeof fn !== "function") continue;
    out[key as string] = (...args: unknown[]) =>
      enqueue(() => (fn as (...a: unknown[]) => Promise<unknown>).apply(raw, args));
  }
  return out as unknown as PairingDriver;
}

/** Skip-a-tick-if-the-last-one-is-still-running, with no queueing of its
 * own (the callee is already on the chain). */
function poll(everyMs: number, f: () => Promise<unknown>): number {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    f().catch(() => {}).finally(() => {
      running = false;
    });
  }, everyMs) as unknown as number;
}

// --- what the page says about itself ---------------------------------------
//
// The driving hooks (the `__demo.pairing` pattern): what an e2e scenario
// needs to act as a user and to read what the user would see, and
// nothing that would let a test bypass a ceremony's own gates. It is
// installed EARLY — before the picker, which may wait indefinitely for a
// user — and grown as the boot proceeds, because a page that can pause
// at a login must still be drivable at that pause.
const hooks: Record<string, unknown> = {};
(globalThis as unknown as Record<string, unknown>).__solo = hooks;

/** ADDRESSING OVERRIDES for the Google Drive ceremony — the same reason
 * `gdrive-config` carries an `api-base` (DRIVE.md §2): a self-hosted or
 * FAKE backend is ordinary addressing, not a probe hack. Defaults are
 * Google's own endpoints; the e2e harness's fake Drive points this at
 * itself before driving the ceremony (DRIVE.md's Gates, `solo-gdrive`). */
let gdriveEndpoints: { apiBase?: string; authUrl?: string; tokenUrl?: string } = {};
hooks.setGdriveEndpoints = (v: { apiBase?: string; authUrl?: string; tokenUrl?: string }) => {
  gdriveEndpoints = v;
};

/** Same deadline as demo.ts's Dropbox `authorize()`: long enough for a
 * human to actually complete a consent screen, short enough that a
 * forgotten popup does not wedge the connect ceremony forever. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/**
 * WHAT THE BOOT DID, in order, as short machine-readable tokens.
 *
 * The boot has branches a user experiences but cannot afterwards see —
 * "your anchor still pointed at a live device" and "the picker had one
 * device whose policy let it open itself" produce the SAME screen. A
 * scenario asserting on the screen alone would pass for the wrong
 * reason. This is the page's own account of which branch it took; it
 * carries no personal state (device ids are opaque, petnames are index
 * rows that already rest in the clear).
 */
const trace: string[] = [];
const note = (t: string) => {
  trace.push(t);
  console.log(`[solo] ${t}`);
};
hooks.bootTrace = () => trace.slice();

// --- boot: the device comes first ------------------------------------------

/** THE APP'S ROW IN THE TRUST TABLE, in a box.
 *
 * It is a box rather than a plain `let` because the visor is now
 * constructed in `boot` and filled in by `startApp`: the config's
 * `appSurface` thunk closes over boot's scope, and `startApp` writes the
 * value once the app has mounted. One mutable field, one reader, no
 * setter ceremony. */
interface AppSlot {
  surface: SurfaceIdentity | null;
}

async function boot() {
  const banner = document.getElementById("banner")!.querySelector(".bar-inner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[solo] ${s}`);
  };
  const statusEl = document.getElementById("solo-status")!;
  const status = (line: string) => {
    statusEl.textContent = line;
  };

  hooks.devices = async () =>
    (await listDevices()).map((d) => ({
      petname: d.petname,
      tier: d.tier,
      policy: d.unsealPolicy,
      lastUsed: d.lastUsed,
    }));

  // THE VISOR SHELL, BEFORE THE DEVICE IS RESOLVED — and UNCLAIMED.
  //
  // It has to exist this early because the device picker is one of its
  // drawer sheets (visor/ui/entry.ts): the sheet's whole claim is that it
  // hangs off the pinned strip over a dimmed page, which needs the strip
  // and the drawer host to be real. It must be UNCLAIMED for exactly as
  // long, because nothing personal may render before the seal opens — so
  // `deferClaim` reads no hue, writes no `--visor-bg`, and renders no
  // identity cluster. What the user sees at the picker is the generic
  // grey dress and an empty right-hand cluster.
  //
  // `startApp` calls `visor.claim()` at the unseal, and THAT is the
  // moment the colour and the name arrive.
  const appSlot: AppSlot = { surface: null };
  const visor = initVisor({
    hueKey: VISOR_KEY,
    identityKey: IDENTITY_KEY,
    deferClaim: true,
    // ONE app surface and no nested places: the strip's context falls
    // back to the app's row and there is nothing to override it with.
    appSurface: () => appSlot.surface,
  });

  say("looking for your devices…");
  const devices = await listDevices();
  note(`index:${devices.length}`);

  const conn = await resolveDevice(devices, say, status, visor);
  note(`unsealed:${conn.deviceId.slice(0, 8)}`);
  await startApp(conn, say, status, visor, appSlot);
}

/**
 * WHICH DEVICE THIS TAB IS LOOKING AT, resolved before one personal
 * pixel is painted. Resolves only once the device is OPEN.
 *
 * THE ANCHOR IS CONSULTED FIRST, AND ONLY FOR A T0 DEVICE. That split is
 * the reconciliation of two rules that would otherwise disagree:
 *
 *   * "a reloaded T0 tab resumes silently" (PERSISTENCE.md, "T0 reload
 *     survival") — the sessionStorage pointer is the ONLY record that a
 *     T0 namespace belongs to this tab, so a picker here would be asking
 *     a question the tab has already answered, about a device no other
 *     tab should be offered anyway;
 *   * "boot: index read → picker" (PERSISTENCE.md, "Unseal UX") — which
 *     is the DURABLE device's path, and the anchor has nothing to say
 *     about a device that survives the tab.
 *
 * So: anchored AND still T0 ⇒ resume it. Everything else ⇒ the picker
 * (which auto-opens the single-device case when the policy permits,
 * exactly as the design record describes).
 *
 * The DEGRADE RULE is `adoptAnchor`'s and is silent by construction: a
 * pointer to a swept namespace comes back as `null` with the pointer
 * cleared, and `null` here is simply "no anchored device" — never an
 * error, never a dialog (PERSISTENCE.md's C1 rule).
 */
async function resolveDevice(
  devices: DeviceRecord[],
  say: (s: string) => void,
  status: (s: string) => void,
  visor: Visor,
): Promise<DeviceConnection> {
  const anchored = await adoptAnchor();
  const anchoredRow = anchored === null ? undefined : await getDevice(anchored);
  if (anchoredRow && anchoredRow.tier === "t0") {
    note("anchor:t0");
    say("resuming this tab's device…");
    return await open(anchoredRow.id, undefined, status);
  }

  if (devices.length === 0) {
    // FIRST RUN, and the device is made WITHOUT a ceremony: try, then
    // keep (#37). `connectDevice`'s anchor arm creates it, anchors it,
    // and seals it as a T0 device — nothing is asked, and nothing
    // personal has touched disk unsealed.
    note("first-device");
    say("setting this device up…");
    return await openNew(devices);
  }

  return await picker(devices, say, status, visor);
}

/** A generic, non-personal default. The petname rests IN THE CLEAR
 * (index.ts's contract), so a device nobody has named yet must be named
 * something nobody minds finding in a profile backup — a count, not a
 * guess at who is holding the laptop. The promotion ceremony is where a
 * real word is asked for. */
const defaultPetname = (devices: DeviceRecord[]) => `device ${devices.length + 1}`;

async function openNew(devices: DeviceRecord[]): Promise<DeviceConnection> {
  const conn = await connectDevice({
    device: { kind: "anchor", petname: defaultPetname(devices) },
    workerUrl: WORKER_URL,
    artifacts: ENGINE_ARTIFACTS,
    label: "solo",
  });
  await conn.unseal();
  return conn;
}

/** Attach to a known device and open it. `passphrase` is the
 * `every-session` rung's input and is not held anywhere: it goes over
 * the port and out of scope. `prfKek` is the passkey rung's input — the
 * non-extractable handle the page derived (`assertPasskey`) — and is
 * under the same non-retention discipline: it crosses the port and is
 * out of scope here too. */
async function open(
  id: string,
  passphrase: string | undefined,
  status: (s: string) => void,
  prfKek?: CryptoKey,
): Promise<DeviceConnection> {
  const conn = await connectDevice({
    device: { kind: "id", id },
    workerUrl: WORKER_URL,
    artifacts: ENGINE_ARTIFACTS,
    label: "solo",
  });
  const opts: { passphrase?: string; prfKek?: CryptoKey } = {};
  if (passphrase !== undefined) opts.passphrase = passphrase;
  if (prfKek !== undefined) opts.prfKek = prfKek;
  const st = await conn.unseal(opts);

  status(`device ${conn.deviceId.slice(0, 8)}… open (resumed: ${st.resumed})`);
  return conn;
}

/**
 * THE PICKER — generic chrome, device petnames and last-used only.
 *
 * WHAT MAY BE ON THIS SCREEN is the index's contract and the negative
 * half is the important one: no colour, no name, no icon, no account
 * identifier (index.ts's header, PERSISTENCE.md's "The index"). The
 * SHEET is the visor's (visor/ui/entry.ts's `mountDevicePicker`) and the
 * visor is UNCLAIMED at this point, so the generic-ness is structural
 * rather than a promise this file keeps: there is no hue to paint and no
 * identity record rendered. What this function owns is the HOST half —
 * what "open this row" actually does, and what a refusal means.
 *
 * AUTO-UNSEAL is the design record's own sentence: "One device in the
 * index and a policy that permits it: auto-unseal straight to the app."
 * A policy permits it when the device does not need a passphrase — which
 * `DeviceStatus.needsPassphrase` answers after attaching, and which the
 * index's policy tag predicts before attaching. The prediction is what
 * is used to decide whether to auto-open at all; the status is what
 * decides whether the ceremony is silent.
 */
function picker(
  devices: DeviceRecord[],
  say: (s: string) => void,
  status: (s: string) => void,
  visor: Visor,
): Promise<DeviceConnection> {
  // THE INDEX ROW, NARROWED to what a picker may see. The mapping is the
  // enforcement: nothing that is not on `DevicePickerRow` can reach the
  // sheet, so a record growing a field later cannot leak it by accident.
  const rows: DevicePickerRow[] = devices.map((d) => ({
    id: d.id,
    petname: d.petname,
    lastUsed: d.lastUsed,
    asksPassphrase: d.unsealPolicy === "every-session",
    asksPasskey: d.unsealPolicy === "passkey",
  }));

  // The driving hooks for this screen, installed ONCE and querying
  // LAZILY: the picker's elements exist only while its sheet is open, so
  // a hook that captured them at install time would be a hook that
  // stopped working the moment the sheet was rebuilt (or never started,
  // on the auto-unseal path where the sheet may never appear at all).
  const el = (id: string) => document.getElementById(id);
  const shown = (id: string) => {
    const e = el(id);
    return e !== null && e.hidden === false;
  };
  hooks.picker = () => ({
    visible: shown("device-picker"),
    rows: Array.from(document.querySelectorAll("#device-list .device-pick")).map(
      (b) => b.textContent ?? "",
    ),
    needsPassphrase: shown("device-pass"),
    needsPasskey: shown("device-passkey"),
    problem: shown("device-problem") ? el("device-problem")!.textContent ?? "" : "",
  });
  hooks.pickDevice = (petname: string) => {
    const b = document.querySelector(
      `#device-list .device-pick[data-petname="${CSS.escape(petname)}"]`,
    ) as HTMLButtonElement | null;
    if (!b) return false;
    b.click();
    return true;
  };
  hooks.newDevice = () => (el("device-new") as HTMLButtonElement | null)?.click();
  hooks.typePassphrase = (v: string) => {
    const input = el("device-pass-input") as HTMLInputElement | null;
    if (!input) return false;
    input.value = v;
    return true;
  };
  hooks.unsealClick = () => (el("device-pass-open") as HTMLButtonElement | null)?.click();
  /** The passkey ceremony's own button, clicked as a user clicks it —
   * the ceremony behind it is a real WebAuthn assertion either way. */
  hooks.passkeyUnsealClick = () =>
    (el("device-passkey-open") as HTMLButtonElement | null)?.click();


  return new Promise<DeviceConnection>((resolve) => {
    /** The banner is the page's own account of where it has got to, and
     * "opening this device…" is a lie once the open has failed. A picker
     * that is waiting for a user is READY — it is simply waiting for a
     * different thing than usual. (The refusal itself lands IN THE
     * SHEET; this line is page furniture.) */
    const readyToAsk = () => say("ready — this device needs its passphrase");

    const host: DevicePickerHost = {
      open: async (row, passphrase) => {
        say("opening this device…");
        try {
          const conn = await open(row.id, passphrase, status);
          note(passphrase === undefined ? "picked:silent" : "picked:passphrase");
          resolve(conn);
        } catch (e) {
          readyToAsk();
          // NOT A DEAD END, and not a guess about why. `no-rung` /
          // `wrong-passphrase` both mean "this device wants its
          // passphrase"; anything else is reported as it came, and the
          // sheet stays up either way.
          const code = (e as { code?: string }).code;
          throw {
            needsPassphrase: code === "no-rung" || code === "wrong-passphrase",
            message: err(e),
          };
        }
      },
      openWithPasskey: async (row) => {
        // THE CEREMONY IS THE PAGE'S (PERSISTENCE.md, "The window/worker
        // split"): the assertion runs here, the KEK is derived here, and
        // what crosses the port is the non-extractable handle. The KEK
        // is a LOCAL — it is never stashed on this page.
        say("opening this device…");
        try {
          const prfKek = await assertPasskey(row.id);
          const conn = await open(row.id, undefined, status, prfKek);
          note("picked:passkey");
          resolve(conn);
        } catch (e) {
          // TWO KINDS OF REFUSAL, and the difference is which door the
          // sheet should be showing afterwards. `no-rung` /
          // `wrong-passphrase` mean this device wants its passphrase, so
          // the field is revealed (rungs are additive: a passkey device
          // may also carry the user's own). `wrong-passkey` /
          // `unsupported` — and a ceremony the user cancelled, which
          // arrives as a plain DOMException — are the passkey path
          // saying no, so the sheet STAYS on the passkey view and the
          // button stays clickable.
          const code = (e as { code?: string }).code;
          const needsPassphrase = code === "no-rung" || code === "wrong-passphrase";
          if (needsPassphrase) readyToAsk();
          else say("ready — try your passkey again");
          throw { needsPassphrase, message: err(e) };
        }
      },
      openNew: async () => {
        say("setting this device up…");
        try {
          const conn = await openNew(devices);
          note("picked:new");
          resolve(conn);
        } catch (e) {
          readyToAsk();
          throw { needsPassphrase: false, message: err(e) };
        }
      },
    };

    // ONE KEPT DEVICE AND A POLICY THAT PERMITS IT: straight through
    // (PERSISTENCE.md, "Unseal UX": "One device in the index and a
    // policy that permits it: auto-unseal straight to the app").
    //
    // T1 ONLY, and that qualifier is this page's reading rather than the
    // record's words. A T0 device belongs to ONE TAB — the sessionStorage
    // anchor is the only thing that says which — and a tab that arrived
    // here has by definition no anchor for it. Opening someone else's
    // ephemeral device unasked would be the picker guessing; offering it
    // as a row the user can choose is the honest version, and a second
    // tab of one device is a case the worker host supports (two clients,
    // one engine) rather than one it needs protecting from.
    //
    // NO SHEET IS MOUNTED FIRST any more, and that is a change from when
    // the picker was page markup that merely got unhidden. A drawer
    // sheet that opened and closed inside the fraction of a second an
    // auto-unseal takes would be a slide-down-slide-up flicker on the
    // trust anchor itself, teaching the user that visor motion is noise.
    // The failure path loses nothing: the picker arrives carrying the
    // refusal (`opts.problem`), which is where it would have landed.
    //
    // A `passkey` DEVICE NEVER AUTO-UNSEALS (PERSISTENCE.md, "Unseal
    // UX", explicitly): its ceremony is a user gesture some browsers
    // demand for `credentials.get` anyway, so this policy has no silent
    // path at all — a single kept passkey device still gets the picker.
    const only = devices[0];
    if (
      devices.length === 1 && only.tier === "t1" &&
      only.unsealPolicy !== "every-session" && only.unsealPolicy !== "passkey"
    ) {
      note("auto-unseal");
      void (async () => {
        say("opening this device…");
        try {
          const conn = await open(only.id, undefined, status);
          note("picked:silent");
          resolve(conn);
        } catch (e) {
          readyToAsk();
          mountDevicePicker(visor, rows, host, { problem: err(e) });
        }
      })();
    } else {
      note("picker:wait");
      say("ready — choose a device");
      mountDevicePicker(visor, rows, host);
    }
  });
}

// --- everything after the seal opens ---------------------------------------

async function startApp(
  conn: DeviceConnection,
  say: (s: string) => void,
  status: (s: string) => void,
  visor: Visor,
  appSlot: AppSlot,
) {
  const driver = conn.driver;
  const tasks = conn.tasks;

  say("fetching the app…");
  const appArt = await fetchArtifacts(APP_ARTIFACT);

  // THE MOMENT THE VISOR BECOMES YOURS. The shell has been on screen
  // since before the picker, but nothing above this line painted a
  // colour, a name or an icon; this call brings all three at once, which
  // is what makes unseal-as-login legible (PERSISTENCE.md, "Unseal UX":
  // "Unseal success is when the visor becomes yours").
  const { fresh } = visor.claim();
  if (fresh) {
    visor.announce("new visor colour set for this device — remember it", 15000);
  }
  const announce: AnnounceSink = visorAnnounceSink(visor);
  note("visor:painted");

  /**
   * THE DEVICE-NAME DISPLAY RULE (PERSISTENCE.md, "Unseal UX", ruled):
   * the strip shows this device's petname whenever this browser's index
   * holds MORE THAN ONE device — pickable, not merely active. Exactly
   * one device: no label, it is noise.
   *
   * IT GOES IN THE VISOR'S `device` SLOT, which is the subordinate line
   * of the identity cluster and is rendered in USER VOICE — which is
   * right, because a petname IS the user's own word (they typed it at
   * the promotion ceremony, or accepted the generic default). It is the
   * only slot on the strip that means "which of your things is this".
   *
   * CONTRACT: this writes the slot at boot and after a promotion, and
   * does NOT fight a later hand edit in the settings sheet. The rule is
   * about what the strip shows a user who has more than one device, not
   * about owning a field the settings sheet offers them.
   */
  const refreshDeviceLabel = async () => {
    const all = await listDevices();
    const mine = all.find((d) => d.id === conn.deviceId);
    const rec = visor.identity();
    visor.saveIdentity({
      ...rec,
      device: all.length > 1 ? mine?.petname : undefined,
    });
    visor.renderIdentity();
  };
  await refreshDeviceLabel();

  const us = serialized(createEnginePairingDriver(driver));

  say("binding the transport…");
  // BOUND AT BOOT, unconditionally. Pairing rides iroh and the guest
  // refuses an unbound instance (guest/src/pairing.rs's "iroh-bind
  // first"), and BOTH roles need it here: this page may turn out to be
  // the joiner (which dials) or the adder (which accepts). A bind
  // deferred to the moment a role is chosen would fail at the worst
  // possible time, inside a ceremony the user has already started.
  //
  // IT IS THE WORKER'S ENDPOINT NOW, which changes nothing about the
  // ceremony and one thing about its lifetime: it belongs to the device,
  // not to the tab, so a second tab of one device joins a transport that
  // is already up.
  let myEndpoint: Uint8Array | null = null;
  try {
    myEndpoint = unhex(await enqueue(() => driver.irohBind(RELAY)));
  } catch (e) {
    status(`pairing transport unavailable: ${err(e)}`);
    console.warn(`[solo] iroh-bind failed: ${err(e)}`);
  }
  /**
   * WHO WAS ALREADY IN THIS ACCOUNT when an add ceremony starts.
   *
   * The adder has to recognise the device it just enrolled, and the old
   * way of doing it — "the entry that is not MY agent id" — needed this
   * page to know its own agent id, which it obtained by calling
   * `init`. That call is no longer available to ask: `init` MINTS an
   * identity every time (engine/guest/src/lib.rs:2390), and the worker
   * has already run it at bring-up, so a second call from here would
   * quietly replace the identity the account was built on.
   *
   * So the question is asked the other way round, and it is the more
   * direct one anyway: snapshot the account's device list at the moment
   * the ceremony OPENS, and the joiner is whoever is in it afterwards
   * and was not before.
   */
  let knownAgents = new Set<string>();

  // --- the app -------------------------------------------------------------

  let appRunner: Runner | null = null;
  let appMounted = false;

  /** Instantiate the app guest over THIS device's engine, in a real
   * sandboxed frame (#16). Structurally the same block as demo.ts's
   * `mountApp`, and deliberately so: the frame backend, the surface, the
   * runner and the `polyvisor:tasks` import being the engine's own
   * export object ARE the framework's app-mount shape. What differs is
   * that the export object is a REMOTE one — every call is a port round
   * trip, which the app cannot tell apart because both are async. */
  const mountApp = async () => {
    if (appMounted) return;
    appMounted = true;
    const container = document.getElementById("solo-app")!;
    let dispatch: (ev: UiEvent) => void = () => {};
    const frameBackend = createFrameBackend(container, (ev) => dispatch(ev));
    const backend = await frameBackend.backend;
    const surface = createSurface(backend, () => "");
    const instance = await instantiate(
      artifactsFromEnvelope(appArt.envelope, appArt.bytes),
      {
        ...surface.imports,
        // The framework seam: the app's data-service import IS this
        // device's `tasks` export, proxied over the port.
        "polyvisor:tasks/tasks@0.1.0": tasks,
      },
    );
    const app = instance.exports as unknown as AppExports;
    const runner = createRunner(surface);
    dispatch = (ev) => {
      runner.call(() => app.onEvent(ev)).catch((e) => status(`event: ${err(e)}`));
    };
    await runner.call(() => app.run());
    appRunner = runner;
    // The app's row in the trust table: ONE artifact, ONE record, keyed
    // by the name the visor fetched it by.
    const { mark, isNew } = sheets.marks.mark(APP_ARTIFACT);
    appSlot.surface = {
      // `name` IS the provenance key — the name the visor fetched the
      // artifact by, never the component's self-declared one.
      name: APP_ARTIFACT,
      // v1 does not read the app's self-declared nickname or its mark
      // nomination: both are extra seam-crossings whose only consumer is
      // the naming ceremony's presentation, and the solo page's claim is
      // about pairing. Falling back to the provenance key is the same
      // NO-FABRICATION answer demo.ts gives when the read fails.
      nickname: APP_ARTIFACT,
      icon: mark.icon,
      isNew,
      petname: mark.petname,
      firstSeen: mark.firstSeen,
    };
    visor.renderContext();
    // Remote changes surface as revision bumps; poll on a UI cadence,
    // skipping a tick whose predecessor is still in flight (an unbounded
    // `runner.call` chain is how demo.ts once wedged a page).
    let polling = false;
    setInterval(() => {
      if (polling) return;
      polling = true;
      runner.call(() => app.poll()).catch(() => {}).finally(() => {
        polling = false;
      });
    }, 400);
    // THE ENTRY CEREMONY IS OVER. It was a drawer sheet, so it is
    // CLOSED rather than hidden — the drawer is a tenancy, and a sheet
    // left open under a mounted app would keep the strip naming a
    // ceremony that has finished. Null-guarded because there may never
    // have been one: a returning device with an account mounts the app
    // without ever offering the fork.
    entry?.close();
    entry = null;
    note("app:mounted");
    say("ready");
  };

  // --- the visor's own sheets ----------------------------------------------

  /** Where the ADD ceremony is opened from (installed below, once the
   * add tenant exists). The settings sheet is registered before it, so
   * the action is a thunk rather than a forward reference. */
  let openAddDevice = () => {};
  /** Where the "this device" ceremony is opened from — promotion while
   * the device is T0, reseal once it is kept. */
  let openThisDevice = () => {};
  /** Where the storage sheet is opened from (installed below, once the
   * storage tenant exists). v1 is S3 only, chrome only
   * (STORAGE-EGRESS.md §5) — one sheet, no picker. */
  let openStorage = () => {};

  const sheets = registerVisorSheets(visor, {
    marksKey: MARKS_KEY,
    onIdentityCommitted: (rec, hue) => {
      // WRITE-THROUGH (PAIRING.md §5): the visor has already stored and
      // painted; the partition is the source of truth catching up, so a
      // failure here is announced rather than hidden.
      void (async () => {
        const res = await us.usProfileSet({
          displayName: rec.name ?? "",
          hue: hueIndexOf(hue),
        });
        if (!res.ok) announce(`could not save your profile: ${res.error}`, true);
      })();
    },
    onNamed: (provenance, petname, icon) => {
      if (appSlot.surface && appSlot.surface.name === provenance) {
        appSlot.surface = { ...appSlot.surface, petname, icon, isNew: false };
        visor.renderContext();
      }
      void (async () => {
        const res = await us.usMarkPut({
          provenance,
          petname,
          // The glyph itself crosses, opaquely (engine.wit's
          // `us-mark.icon`): the vocabulary is the visor's.
          icon,
          createdAt: Date.now(),
          needsReconfirm: false,
        });
        if (!res.ok) announce(`could not record the name in your account: ${res.error}`, true);
      })();
    },
    onForgotten: (provenance) => {
      if (appSlot.surface && appSlot.surface.name === provenance) {
        // BOTH HALVES GO: forgetting deletes the record, so a cached
        // surface keeping its glyph would leave the strip wearing a mark
        // the visor no longer holds.
        appSlot.surface = { ...appSlot.surface, petname: undefined, icon: "" };
        visor.renderContext();
      }
      void (async () => {
        const res = await us.usMarkForget(provenance);
        if (!res.ok) announce(`could not forget it in your account: ${res.error}`, true);
      })();
    },
    onReset: () => {
      for (const k of [US_CACHE_KEYS.hue, US_CACHE_KEYS.name, US_CACHE_KEYS.marks]) {
        localStorage.removeItem(k);
      }
    },
    resetConsequences: ["the devices you paired with this one"],
    extraActions: [
      {
        label: "this device…",
        key: "this-device",
        hint: "keep it on this browser, or seal it again",
        onSelect: () => openThisDevice(),
      },
      {
        label: "add a device…",
        key: "add-device",
        hint: "show a code on the other device, then enter it here",
        onSelect: () => openAddDevice(),
      },
      {
        label: "storage…",
        key: "storage",
        hint: "connect this device to a bucket it can sync through",
        onSelect: () => openStorage(),
      },
    ],
  });

  /** The account stores a PALETTE INDEX, never a raw angle (PAIRING.md
   * §4). An angle the palette does not contain — unreachable from the
   * settings sheet — falls back to index 0 rather than writing a number
   * the other device cannot render. */
  const hueIndexOf = (angle: number) => {
    const i = VISOR_HUES.indexOf(angle);
    return i < 0 ? 0 : i;
  };

  // --- "keep this device", and "seal it again" -----------------------------
  //
  // ONE SHEET, TWO STATES, because they are one subject: what this
  // browser holds of you. While the device is T0 the sheet is the
  // PROMOTION CEREMONY (PERSISTENCE.md, "Tiers, as a promotion": the
  // seal choices are asked HERE, at the first moment the user has said
  // the device should outlive the tab). Once it is T1 the sheet reports
  // what was chosen and offers the way back out — RESEAL.
  //
  // IT IS A VISOR SHEET, opened from the strip's settings sheet, which
  // is the only entry a component cannot draw or reach. The passphrase
  // is typed in visor pixels for the same reason the credential sheet's
  // is.

  const deviceTenant = visor.drawer.tenant<{ container: HTMLElement }>({
    name: "this-device",
    exclusive: true,
    dim: true,
    context: () => ({ kind: "settings" }),
  });

  const field = (labelText: string, hintText?: string) => {
    const wrap = document.createElement("div");
    wrap.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrap.append(label);
    if (hintText !== undefined) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = hintText;
      wrap.append(hint);
    }
    return wrap;
  };

  /** Re-read the device's own row and status. Both are cheap and both
   * can change under the sheet (a promotion in another tab of the same
   * device is a real case). */
  const deviceState = async (): Promise<{ row?: DeviceRecord; st: DeviceStatus }> => ({
    row: await getDevice(conn.deviceId),
    st: await conn.status(),
  });

  openThisDevice = () => {
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "device-sheet";
    const session = { container };
    deviceTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "This device";
      const body = document.createElement("div");
      container.replaceChildren(heading, body);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.onclick = () => {
        if (deviceTenant.owns(session)) deviceTenant.close();
      };
      container.append(close);
      void renderBody(body);
      return { root: container };
    });
  };

  /** Re-read the device's row and status and (re-)draw the sheet body.
   * Shared by the initial open AND the switch-to-passkey flow below,
   * which must show the device's NEW policy once it lands — the simplest
   * honest way is to ask the device again rather than hand-patch what is
   * on screen. */
  const renderBody = async (body: HTMLElement) => {
    body.replaceChildren();
    const { row, st } = await deviceState();
    if (st.tier === "t0") await renderPromotion(body, row);
    else await renderKept(body, row, st);
    // NO `rebuild()` HERE, deliberately: the tenant's builder is what
    // calls this, so a re-measure from inside it would recurse. The
    // drawer measures the body it is handed; the switch flow below
    // re-renders in place, which is a height change the sheet already
    // tolerates the same way the initial async fill does.
  };

  /** THE PROMOTION CEREMONY. */
  const renderPromotion = async (body: HTMLElement, row?: DeviceRecord) => {
    const lead = document.createElement("p");
    lead.className = "cred-note";
    lead.textContent =
      "Nothing here outlives this tab yet. Keep this device and its state stays on " +
      "this browser, sealed, so you can come back to it.";
    body.append(lead);

    // THE PETNAME, AND THE HONEST SENTENCE ABOUT WHERE IT GOES. The
    // index rests UNENCRYPTED — that is what lets a picker offer this
    // device before anything is unsealed — so the sheet says so in its
    // own words rather than leaving the user to assume otherwise
    // (index.ts's contract: "would I be comfortable finding this in a
    // synced profile backup").
    const nameField = field(
      "What do you want to call this device?",
      "This name is stored unencrypted on this browser, so the device picker can " +
        "offer it before anything is opened. Nothing else about you is.",
    );
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = "device-petname";
    nameInput.value = row?.petname ?? "";
    nameField.append(nameInput);
    body.append(nameField);

    // CAPABILITY FIRST, asked once per sheet render (PERSISTENCE.md,
    // "Enrollment order and the degrade"). "no" means the choice is
    // simply not offered, with a plain sentence — never a broken
    // ceremony; "yes"/"maybe" both offer it and let enrollment be the
    // authoritative check.
    const prfCap = await prfCapability();

    // THE SHIPPED RUNGS. `while-open` is the T0 rung and is not on
    // offer here: a device the user asked to keep must not rest on a key
    // that dies with the worker. `passkey` is offered only when this
    // browser might do it at all.
    const rungField = field("How should this device open?");
    const rungs: { value: UnsealPolicy; label: string; hint: string }[] = [
      {
        value: "until-reseal",
        label: "Open it for me, until I seal it again",
        // THE HONEST SENTENCE, verbatim in meaning from PERSISTENCE.md's
        // ladder table and seal.ts's `enableUntilReseal`.
        hint:
          "Login convenience, not protection against someone holding this browser " +
          "profile: the key that opens this device is kept here, and anything that " +
          "can run on this site in this profile can ask for it.",
      },
      {
        value: "every-session",
        label: "Ask me for a passphrase every session",
        hint:
          "The real one: the key that opens this device is derived from what you type " +
          "and is never stored. Forget it and this device's state is gone.",
      },
    ];
    if (prfCap !== "no") {
      rungs.push({
        value: "passkey",
        label: "Open it with my passkey",
        // THE HONEST SENTENCE for this rung (PERSISTENCE.md, "The PRF
        // rung: passkey unseal"), in the same register as the two above.
        hint:
          "The key that opens this device is derived from a passkey this browser " +
          "asks for every time. Nothing stored here can open it. Lose the passkey " +
          "and this device's state is gone.",
      });
    }
    let chosen: UnsealPolicy = "until-reseal";
    const passWrap = field("Your passphrase for this device");
    const passInput = document.createElement("input");
    passInput.type = MASKED.type;
    passInput.id = "device-new-pass";
    passWrap.append(passInput);
    passWrap.hidden = true;
    for (const r of rungs) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "device-rung";
      radio.value = r.value;
      radio.checked = r.value === chosen;
      radio.onchange = () => {
        chosen = r.value;
        // THE PASSPHRASE FIELD STAYS HIDDEN FOR `passkey`: promotion
        // always has the platform rung to authorize the re-wrap
        // (worker.ts's `enablePrf`), so no passphrase is needed here.
        passWrap.hidden = chosen !== "every-session";
      };
      label.append(radio, document.createTextNode(` ${r.label}`));
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = r.hint;
      line.append(label, hint);
      rungField.append(line);
    }
    body.append(rungField, passWrap);
    if (prfCap === "no") {
      // THE PLAIN SENTENCE the degrade owes the user, instead of a
      // choice that would break when taken.
      const noPrf = document.createElement("div");
      noPrf.className = "hint";
      noPrf.id = "device-passkey-unavailable";
      noPrf.textContent = "this browser cannot open devices with a passkey";
      body.append(noPrf);
    }

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "device-sheet-problem";
    problem.hidden = true;
    body.append(problem);

    const keep = document.createElement("button");
    keep.type = "button";
    keep.id = "device-keep";
    keep.textContent = "Keep this device";
    keep.onclick = () => {
      keep.disabled = true;
      problem.hidden = true;
      void (async () => {
        try {
          if (chosen === "passkey") {
            // ENROLL FIRST. A failure here (an authenticator declining,
            // a cancelled ceremony) leaves the device exactly as it was
            // — nothing below has run — and the message already says
            // whether a credential the authenticator minted needs
            // deleting there (passkey.ts's `enrollPasskey`).
            const grant = await enrollPasskey(conn.deviceId, nameInput.value);
            // THE WORKER FIRST, THE INDEX LAST, exactly as the other
            // arms: a failed re-wrap must never leave a row claiming a
            // rung the device does not have.
            await conn.promote({
              policy: "passkey",
              prf: { kek: grant.kek, ...grant.enrollment },
            });
            const { persisted } = await promoteDevice(conn.deviceId, {
              petname: nameInput.value,
              unsealPolicy: "passkey",
            });
            note("promoted:passkey");
            await refreshDeviceLabel();
            if (deviceTenant.isOpen()) deviceTenant.close();
            announce(
              persisted
                ? "this device is kept on this browser"
                : "this device is kept, but this browser would not promise to keep it — " +
                  "it may be cleared when space runs short",
              !persisted,
            );
            return;
          }
          // THE WORKER FIRST, THE INDEX LAST (client.ts's `promote`): a
          // failed re-wrap must never leave a row claiming a rung the
          // device does not have.
          await conn.promote({
            policy: chosen,
            passphrase: chosen === "every-session" ? passInput.value : undefined,
          });
          const { persisted } = await promoteDevice(conn.deviceId, {
            petname: nameInput.value,
            unsealPolicy: chosen,
          });
          note(`promoted:${chosen}`);
          await refreshDeviceLabel();
          if (deviceTenant.isOpen()) deviceTenant.close();
          // THE ANSWER IS SURFACED, NOT ASSUMED (index.ts's
          // `promoteDevice`, PERSISTENCE.md's "Eviction and
          // degradation"): a browser that refused durable storage leaves
          // this device kept-but-evictable, and saying so is the whole
          // point of returning the flag.
          announce(
            persisted
              ? "this device is kept on this browser"
              : "this device is kept, but this browser would not promise to keep it — " +
                "it may be cleared when space runs short",
            // A refusal STICKS: it is a fact about the device the user
            // has just chosen to rely on, and a sentence that scrolls
            // away in eight seconds is a warning nobody was given.
            !persisted,
          );
        } catch (e) {
          keep.disabled = false;
          problem.textContent = err(e);
          problem.hidden = false;
        }
      })();
    };
    body.append(keep);
  };

  /** THE KEPT DEVICE: what was chosen, and the way back out. */
  const renderKept = async (body: HTMLElement, row: DeviceRecord | undefined, st: DeviceStatus) => {
    const lead = document.createElement("p");
    lead.className = "cred-note";
    lead.textContent = row === undefined
      ? "This device is kept on this browser."
      : st.policy === "every-session"
      ? `This device is kept on this browser as "${row.petname}", and asks for its ` +
        `passphrase every session.`
      : st.policy === "passkey"
      ? `This device is kept on this browser as "${row.petname}", and opens with ` +
        `your passkey.`
      : `This device is kept on this browser as "${row.petname}", and opens itself ` +
        `until you seal it again.`;
    body.append(lead);

    // RESEAL, AND WHAT IT ASKS — stated before it is offered.
    //
    // TWO SHAPES, because a device with no passphrase of its own is a
    // different question (RULED). Reseal deletes the key kept here
    // (seal.ts's `reseal`), and for a device kept on the convenience
    // rung that key is the only one anybody knows — the passphrase rung
    // such a device carries is `sealT0`'s, minted from bytes nobody
    // kept. Sealing it without asking anything would leave a picker row
    // that demands a passphrase THAT NEVER EXISTED: a zombie entry.
    // Destroying a device is a separate, explicit act; reseal must not
    // do it by omission.
    //
    // WHICH SHAPE IS `rungs.userPassphrase` OR `rungs.prf`, NOT THE
    // POLICY TAG. The tag says which ceremony to offer at unseal; it
    // does not say whether anybody holds a reachable rung, and a device
    // can be on `until-reseal` AND have the user's own passphrase, or a
    // passkey rung (both additive — `enableUntilReseal`, `enablePrf`).
    // A PASSKEY RUNG IS ALWAYS WALKABLE (rpc.ts's `rungs.prf`: "a
    // passkey rung only exists because a person enrolled a credential
    // they hold"), which is why it joins `userPassphrase` here exactly
    // as the worker's own reseal guard generalized.
    //
    // So on that device reseal ASKS, and the sentence is the plain one:
    // sealing this device means choosing what unseals it. The worker
    // re-keys from the platform rung — which is still there, which is
    // exactly why reseal time is when this is possible at all — and the
    // device comes back an `every-session` one. A device that already
    // has a reachable rung reseals with no extra ceremony.
    const upgrades = !st.rungs.userPassphrase && !st.rungs.prf && st.rungs.untilReseal;

    const warn = document.createElement("div");
    warn.className = "hint";
    warn.id = "device-reseal-warning";
    warn.textContent = upgrades
      ? "Sealing this device means choosing what unseals it. This device opens itself " +
        "today, so there is nothing yet that you know and it does not — pick a " +
        "passphrase now, and from here on it asks for that."
      : st.policy === "passkey"
      ? "Sealing it again drops the keys held here and returns you to the device " +
        "picker. You open it again with your passkey."
      : "Sealing it again drops the keys held here and returns you to the device " +
        "picker. You open it again with your passphrase.";
    body.append(warn);

    const passWrap = field("A passphrase for this device");
    const passInput = document.createElement("input");
    passInput.type = MASKED.type;
    passInput.id = "device-reseal-pass";
    passWrap.append(passInput);
    passWrap.hidden = !upgrades;
    body.append(passWrap);

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "device-sheet-problem";
    problem.hidden = true;
    body.append(problem);

    let armed = false;
    const seal = document.createElement("button");
    seal.type = "button";
    seal.id = "device-reseal";
    seal.textContent = "Seal this device again";
    seal.onclick = () => {
      if (!armed) {
        armed = true;
        seal.textContent = upgrades
          ? "Yes — seal it with this passphrase"
          : "Yes — seal it and sign out";
        return;
      }
      seal.disabled = true;
      problem.hidden = true;
      void (async () => {
        try {
          // THE WORKER FIRST, THE INDEX LAST, exactly as promotion does
          // it: a re-key that failed must never leave a row claiming a
          // rung the device does not have. The worker refuses the
          // platform-only reseal without a passphrase, so an empty field
          // lands here as a refusal rather than as a device nobody can
          // open.
          await conn.reseal(upgrades ? { passphrase: passInput.value } : {});
          if (upgrades) {
            // THE PICKER MUST DEMAND IT AFTERWARDS. The policy tag is
            // what the picker reasons about before attaching anything,
            // so a device that now opens by passphrase has to say so in
            // the one unsealed place that is read that early.
            await promoteDevice(conn.deviceId, { unsealPolicy: "every-session" });
          }
          note(upgrades ? "resealed:upgraded" : "resealed");
          // BACK TO THE PICKER, BY RELOAD. Reseal means the worker has
          // dropped its key material and the engine with it, so
          // everything this page is showing — the app, the colour, the
          // name — is state the user just asked to close. Repainting
          // around that would leave personal pixels up after the seal
          // shut; a reload is the only honest way back to a screen with
          // nothing on it.
          location.reload();
        } catch (e) {
          seal.disabled = false;
          armed = false;
          seal.textContent = "Seal this device again";
          problem.textContent = err(e);
          problem.hidden = false;
        }
      })();
    };
    body.append(seal);

    // SWITCH TO PASSKEY (PERSISTENCE.md, "Enrollment placement": "On a
    // kept device"). Offered only for a device not already on this rung,
    // and only when the browser might do it at all — the same capability
    // probe the promotion sheet asks.
    if (st.policy !== "passkey" && await prfCapability() !== "no") {
      const switchWrap = document.createElement("div");
      switchWrap.className = "cred-field";
      // NO PLATFORM WRAP TO AUTHORIZE FROM: the switch needs an
      // authorizing secret and the worker's `enablePrf` refuses without
      // one, so a device on `every-session` (whose platform wrap did not
      // survive promotion) is asked for its passphrase FIRST — which is
      // that device's login anyway.
      const needsPassphrase = !st.rungs.untilReseal;
      const switchPassField = field(
        "Your passphrase for this device",
        "your current passphrase authorizes the switch",
      );
      const switchPassInput = document.createElement("input");
      switchPassInput.type = MASKED.type;
      switchPassInput.id = "device-switch-passkey-pass";
      switchPassField.append(switchPassInput);
      switchPassField.hidden = !needsPassphrase;

      const switchProblem = document.createElement("div");
      switchProblem.className = "hint";
      switchProblem.id = "device-switch-passkey-problem";
      switchProblem.hidden = true;

      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.id = "device-switch-passkey";
      switchBtn.textContent = "switch to passkey unseal";
      switchBtn.onclick = () => {
        switchBtn.disabled = true;
        switchProblem.hidden = true;
        void (async () => {
          try {
            const grant = await enrollPasskey(conn.deviceId, row?.petname ?? "");
            // WORKER FIRST, INDEX LAST — the worker's re-wrap order
            // guarantees nothing partial: a failure below leaves the
            // device on its old rung, still openable exactly as before.
            await conn.promote({
              policy: "passkey",
              passphrase: needsPassphrase ? switchPassInput.value : undefined,
              prf: { kek: grant.kek, ...grant.enrollment },
            });
            await promoteDevice(conn.deviceId, { unsealPolicy: "passkey" });
            note("switched:passkey");
            await refreshDeviceLabel();
            // THE RE-RENDER READS THE DEVICE AGAIN rather than patching
            // this screen by hand: the platform wrap is now gone (the
            // worker deletes it), so the copy above must reflect the new
            // policy, and `deviceState()` is the one place that already
            // knows how to say so.
            await renderBody(body);
          } catch (e) {
            switchBtn.disabled = false;
            switchProblem.textContent = err(e);
            switchProblem.hidden = false;
          }
        })();
      };
      switchWrap.append(switchPassField, switchBtn, switchProblem);
      body.append(switchWrap);
    }
  };

  // --- storage: connect this device to a bucket it can sync through --------
  //
  // TWO PROVIDERS, ONE SHEET, CHROME-OWNED FIELDS (DRIVE.md §6 /
  // STORAGE-EGRESS.md §5): a provider choice, no picker of pickers and
  // no provider panels — with only two worker-side providers there is
  // nothing to delegate to a component. The invariant holds by
  // construction rather than by review: every secret is typed in VISOR
  // PIXELS, and no component is ever present on this path (there is no
  // panel here at all, unlike demo.ts's credential drawer, which exists
  // only because a PANEL asks the visor to collect on its behalf).
  //
  // THE ONE MOMENT OF CLEARTEXT, twice over: the S3 secret key and the
  // Drive OAuth client secret are both read out of this sheet's input
  // and the field is cleared IN THE SAME TICK — before either value is
  // used — exactly like the passphrase fields elsewhere in this file
  // (DRIVE.md §3: the client secret is an APP identifier, not a user
  // secret, but it still does not linger). A local variable carries the
  // value into the ceremony from there, so a thrown `oauthStart`, a
  // blocked or closed popup, a timeout, or a failed exchange all leave
  // the field empty rather than sitting on a typed secret.

  const storageTenant = visor.drawer.tenant<{ container: HTMLElement }>({
    name: "storage",
    exclusive: true,
    dim: true,
    context: () => ({ kind: "settings" }),
  });

  /** The connect ceremony's own busy-guard, mirroring `setupInFlight` in
   * demo.ts's `setupBucket`: a duplicate click while one binding is in
   * flight would race the same escrow write (or the same OAuth
   * ceremony) and the same bind. */
  let storageConnectInFlight = false;

  openStorage = () => {
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "storage-sheet";
    const session = { container };
    storageTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "Storage";
      const body = document.createElement("div");
      container.replaceChildren(heading, body);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.onclick = () => {
        if (storageTenant.owns(session)) storageTenant.close();
      };
      container.append(close);
      void conn.status().then((st) => {
        if (st.storage === null) renderUnbound(body);
        else renderBound(body, st.storage);
      });
      return { root: container };
    });
  };

  /** THE UNBOUND VIEW: the provider choice and the connect ceremony.
   * `prefill` re-shows a known destination when this is reached from
   * "Change…" — whichever provider it names is the one selected and
   * pre-filled; the OTHER provider's fields start at their defaults,
   * and no secret is ever carried into a prefill (neither the S3 secret
   * key nor the Drive client secret is held here to read back). */
  const renderUnbound = (body: HTMLElement, prefill?: StoreBinding) => {
    const lead = document.createElement("p");
    lead.className = "cred-note";
    lead.textContent =
      "This device can sync through a bucket it reaches directly. Whichever provider you " +
      "choose, the secret half of the ceremony is typed here and never stored as text.";
    body.append(lead);

    // THE PROVIDER CHOICE (DRIVE.md §6). S3 is the default — it is the
    // provider this sheet has always offered — and choosing Drive shows
    // its own fields in place of S3's rather than beside them: the two
    // providers are alternatives, not a combined form.
    let chosenKind: StoreBinding["kind"] = prefill?.kind ?? "s3";
    const kindField = field("Where do you want this device to sync?");
    const kindChoices: { value: StoreBinding["kind"]; id: string; label: string }[] = [
      { value: "s3", id: "storage-kind-s3", label: "S3-compatible object storage" },
      { value: "gdrive", id: "storage-kind-gdrive", label: "Google Drive" },
    ];
    for (const k of kindChoices) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "storage-kind";
      radio.id = k.id;
      radio.value = k.value;
      radio.checked = k.value === chosenKind;
      radio.onchange = () => {
        chosenKind = k.value;
        s3Group.hidden = chosenKind !== "s3";
        gdriveGroup.hidden = chosenKind !== "gdrive";
      };
      label.append(radio, document.createTextNode(` ${k.label}`));
      line.append(label);
      kindField.append(line);
    }
    body.append(kindField);

    // --- the S3 fields (unchanged ids: this is the existing sheet) ---------
    const s3Group = document.createElement("div");
    s3Group.hidden = chosenKind !== "s3";

    const endpointField = field("Endpoint");
    const endpointInput = document.createElement("input");
    endpointInput.type = "text";
    endpointInput.id = "storage-endpoint";
    endpointInput.value = prefill?.kind === "s3" ? prefill.endpoint : "";
    endpointField.append(endpointInput);
    s3Group.append(endpointField);

    const bucketField = field("Bucket");
    const bucketInput = document.createElement("input");
    bucketInput.type = "text";
    bucketInput.id = "storage-bucket";
    bucketInput.value = prefill?.kind === "s3" ? prefill.bucket : "";
    bucketField.append(bucketInput);
    s3Group.append(bucketField);

    const accessField = field("Access key ID");
    const accessInput = document.createElement("input");
    accessInput.type = "text";
    accessInput.id = "storage-access";
    accessInput.value = prefill?.kind === "s3" ? prefill.accessKey : "";
    accessField.append(accessInput);
    s3Group.append(accessField);

    const secretField = field(
      "Secret key",
      "Leave blank if this browser already holds the secret for this destination.",
    );
    const passInput = document.createElement("input");
    passInput.type = MASKED.type;
    passInput.id = "storage-secret";
    secretField.append(passInput);
    s3Group.append(secretField);
    body.append(s3Group);

    // --- the Drive fields (DRIVE.md §6) -------------------------------------
    const gdriveGroup = document.createElement("div");
    gdriveGroup.hidden = chosenKind !== "gdrive";

    const rootField = field(
      "Drive folder",
      "The folder this device syncs through — created in your Drive if it does not exist yet.",
    );
    const gdRootInput = document.createElement("input");
    gdRootInput.type = "text";
    gdRootInput.id = "storage-gd-root";
    // Dev prefill: the manual live beat and the e2e harness both pass
    // ?gdroot=… as test convenience (DRIVE.md's Gates); a real "Change…"
    // prefill takes precedence over it.
    gdRootInput.value = prefill?.kind === "gdrive"
      ? prefill.root
      : (params.get("gdroot") ?? "polyvisor");
    rootField.append(gdRootInput);
    gdriveGroup.append(rootField);

    const clientField = field("OAuth client id");
    const gdClientInput = document.createElement("input");
    gdClientInput.type = "text";
    gdClientInput.id = "storage-gd-client";
    gdClientInput.value = prefill?.kind === "gdrive"
      ? prefill.clientId
      : (params.get("gdclient") ?? "");
    clientField.append(gdClientInput);
    gdriveGroup.append(clientField);

    const gdSecretField = field(
      "OAuth client secret",
      // THE ONE HONEST SENTENCE (DRIVE.md §3): this identifies the APP
      // to Google, not you. It is not your account's secret, and Google's
      // own documentation says an installed app's client secret is "not
      // treated as a secret" — but it is still masked, because it is
      // still not something to paint on a screen.
      "This identifies the app to Google, not you — it is not your account's secret.",
    );
    const gdSecretInput = document.createElement("input");
    gdSecretInput.type = MASKED.type;
    gdSecretInput.id = "storage-gd-secret";
    // Never prefilled from a binding — the secret is not part of
    // `StoreBinding` and this sheet never holds one to read back. The
    // dev URL param is test convenience only (DRIVE.md's Gates).
    gdSecretInput.value = params.get("gdsecret") ?? "";
    gdSecretField.append(gdSecretInput);
    gdriveGroup.append(gdSecretField);
    body.append(gdriveGroup);

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "storage-sheet-problem";
    problem.hidden = true;
    body.append(problem);

    const stepNote = document.createElement("div");
    stepNote.className = "hint";
    stepNote.id = "storage-sheet-note";
    body.append(stepNote);

    const connect = document.createElement("button");
    connect.type = "button";
    connect.id = "storage-connect";
    connect.textContent = "Save & connect";
    connect.onclick = () => {
      if (storageConnectInFlight) return;
      storageConnectInFlight = true;
      connect.disabled = true;
      problem.hidden = true;
      const kind = chosenKind;
      // s3's fields, read once regardless of which provider is chosen —
      // harmless, since only the chosen branch below uses them.
      const endpoint = endpointInput.value;
      const bucket = bucketInput.value;
      const access = accessInput.value;
      // THE ONE MOMENT OF CLEARTEXT (s3 half): read straight off the
      // input, used once, and the field is cleared in the same tick
      // regardless of outcome.
      const secret = passInput.value;
      passInput.value = "";
      // gdrive's fields. THE CLIENT SECRET IS READ HERE AND CLEARED IN
      // THE SAME TICK, exactly like the s3 secret above: the local
      // variable carries it into the ceremony below, so a thrown
      // `oauthStart`, a blocked or closed popup, a timeout, or a failed
      // exchange all leave the field empty rather than sitting on a
      // typed secret.
      const root = gdRootInput.value;
      const client = gdClientInput.value;
      const gdSecret = gdSecretInput.value;
      gdSecretInput.value = "";
      void enqueue(async () => {
        let step = "init";
        const at = (s: string) => {
          step = s;
          stepNote.textContent = `configuring storage: ${s}…`;
        };
        try {
          let bound: DeviceStatus;
          if (kind === "s3") {
            at("destination");
            const origin = normalizeOrigin(endpoint);
            if (origin === null) {
              throw new Error(`storage endpoint is not a usable origin: ${endpoint}`);
            }
            if (secret !== "") {
              at("escrow");
              await putSigningKey(origin, access, secret);
            }
            at("binding");
            const st = await conn.bindStore({ kind: "s3", endpoint, bucket, accessKey: access });
            const part = await tasks.partition();
            const self = st.agentId === null ? null : unhex(st.agentId);
            if (self === null) {
              throw new Error("this device has no agent id yet — bring it up before connecting");
            }
            at("bucket + policy");
            await driver.ensureBucket();
            at("grants");
            await driver.storeGrant(part, self);
            at("first sync");
            await driver.bucketFlush(part);
            note("storage:bound");
            bound = await conn.status();
            announce("this device now syncs through your bucket");
          } else {
            at("destination");
            if (root.trim() === "") throw new Error("a Drive folder name is required");
            if (client.trim() === "") throw new Error("an OAuth client id is required");
            // BIND-WITHOUT-CEREMONY (DRIVE.md §5): a consent already
            // sealed for this device is reused rather than asked for
            // twice. `gdriveConsent` says nothing about WHICH client id
            // it was minted for — `bindStore` is where a mismatch is
            // caught, by name, as `no-credential` (the access-key
            // mismatch rule's exact analog).
            const already = (await conn.status()).gdriveConsent;
            if (already) {
              step = "consent";
              stepNote.textContent =
                "configuring storage: consent (using the consent this device already holds)…";
            } else {
              at("consent");
              // THE WORKER OWNS THE VERIFIER; THE PAGE OWNS THE POPUP
              // (DRIVE.md §3). What crosses here is app identity and
              // addressing; what comes back is a URL, never a token.
              const { authorizeUrl } = await conn.oauthStart({
                provider: "gdrive",
                clientId: client,
                clientSecret: gdSecret || undefined,
                redirectUri: location.origin + location.pathname,
                authUrl: gdriveEndpoints.authUrl,
                tokenUrl: gdriveEndpoints.tokenUrl,
              });
              // THE STATE BINDING: the worker minted the state and
              // embedded it in the URL it handed back; a relay from
              // some other ceremony (a stale popup, a second sheet) is
              // ignored rather than trusted (mirrors demo.ts's
              // `authorize()`).
              const expectedState = new URL(authorizeUrl).searchParams.get("state");
              const popup = window.open(authorizeUrl, "pm-gdrive-auth", "width=680,height=760");
              if (!popup) {
                throw new Error("could not open the authorization window (popup blocked)");
              }
              const relay = await new Promise<{ code: string; state: string }>(
                (resolve, reject) => {
                  const done = (f: () => void) => {
                    globalThis.removeEventListener("message", onMessage);
                    clearInterval(closedTimer);
                    clearTimeout(deadline);
                    f();
                  };
                  const onMessage = (e: MessageEvent) => {
                    if (e.origin !== location.origin) return;
                    const d = e.data as { pmGdriveCode?: unknown; state?: unknown } | null;
                    if (!d || typeof d.pmGdriveCode !== "string") return;
                    if (expectedState !== null && d.state !== expectedState) return;
                    done(() =>
                      resolve({
                        code: d.pmGdriveCode as string,
                        state: typeof d.state === "string" ? d.state : "",
                      })
                    );
                  };
                  globalThis.addEventListener("message", onMessage);
                  const closedTimer = setInterval(() => {
                    if (popup.closed) done(() => reject(new Error("authorization window closed")));
                  }, 500);
                  const deadline = setTimeout(
                    () => done(() => reject(new Error("authorization timed out"))),
                    AUTH_TIMEOUT_MS,
                  );
                },
              );
              try {
                popup.close();
              } catch { /* already gone */ }
              await conn.oauthComplete(relay.code, relay.state);
              note("storage:consented");
            }
            at("binding");
            const st = await conn.bindStore({
              kind: "gdrive",
              root,
              apiBase: gdriveEndpoints.apiBase ?? "https://www.googleapis.com",
              clientId: client,
            });
            const part = await tasks.partition();
            const self = st.agentId === null ? null : unhex(st.agentId);
            if (self === null) {
              throw new Error("this device has no agent id yet — bring it up before connecting");
            }
            at("bucket + policy");
            await driver.ensureBucket();
            at("grants");
            await driver.storeGrant(part, self);
            at("first sync");
            await driver.bucketFlush(part);
            note("storage:bound");
            bound = await conn.status();
            announce("this device now syncs through your Drive folder");
          }
          storageConnectInFlight = false;
          body.replaceChildren();
          if (bound.storage) renderBound(body, bound.storage);
        } catch (e) {
          storageConnectInFlight = false;
          connect.disabled = false;
          // A STALE-CONSENT MISMATCH (DRIVE.md §5) names its own fix:
          // the worker's `no-credential` here means either no S3
          // signing key is escrowed, or a Drive consent is missing or
          // was minted for a different client id — either way, advice
          // beats a bare refusal.
          const code = (e as { code?: string }).code;
          problem.textContent = code === "no-credential"
            ? `${err(e)} — enter the secret key, or connect and consent again`
            : err(e);
          problem.hidden = false;
          stepNote.textContent = "";
        }
      });
    };
    body.append(connect);
  };

  /** THE BOUND VIEW: what this device syncs through, sync-now, and the
   * way out — for either provider. */
  const renderBound = (body: HTMLElement, storage: StoreBinding) => {
    const lead = document.createElement("p");
    lead.className = "cred-note";
    // These are the user's own configuration — typed into this very
    // sheet, never a component's — so no plating applies here (the
    // three-voices rule is about FOREIGN prose; this is the visor
    // reporting the user's own words back to them).
    lead.textContent = storage.kind === "s3"
      ? `This device syncs through ${storage.bucket} at ${storage.endpoint}.`
      : `This device syncs through the "${storage.root}" folder in your Google Drive, ` +
        `using client ${storage.clientId}.`;
    body.append(lead);

    const stepNote = document.createElement("div");
    stepNote.className = "hint";
    stepNote.id = "storage-sheet-note";

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "storage-sheet-problem";
    problem.hidden = true;

    const sync = document.createElement("button");
    sync.type = "button";
    sync.id = "storage-sync";
    sync.textContent = "Sync to storage now";
    sync.onclick = () => {
      sync.disabled = true;
      problem.hidden = true;
      void enqueue(async () => {
        try {
          const part = await tasks.partition();
          // THE ENGINE'S OWN ANSWER, and it renders as plain text inside
          // this sheet — the same treatment demo.ts gives it in a pane
          // status line, with no plating: it is component-influenced,
          // but it is a status report about a sync THIS device just ran,
          // not foreign prose being narrated as the visor's own.
          const result = await driver.bucketFlush(part);
          note("storage:synced");
          stepNote.textContent = result;
        } catch (e) {
          problem.textContent = err(e);
          problem.hidden = false;
        } finally {
          sync.disabled = false;
        }
      });
    };

    const change = document.createElement("button");
    change.type = "button";
    change.id = "storage-change";
    change.textContent = "Change…";
    change.onclick = () => {
      body.replaceChildren();
      renderUnbound(body, storage);
    };

    // DISCONNECT VS. FORGET — THE SAME SPLIT AS STORAGE-EGRESS.md §6,
    // now with a second thing that can be forgotten: disconnecting the
    // DESTINATION is not forgetting the ACCOUNT, and (for Drive) forgetting
    // the ACCOUNT is not forgetting the DESTINATION either. The two acts
    // stay separate controls on purpose.
    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.id = "storage-disconnect";
    disconnect.textContent = "Disconnect";
    disconnect.onclick = () => {
      disconnect.disabled = true;
      problem.hidden = true;
      void (async () => {
        try {
          // THE HONEST SENTENCE (STORAGE-EGRESS.md §6): disconnect
          // forgets THIS DEVICE's binding. For S3 the escrowed secret
          // key stays on this browser for any device that still names
          // it (profile-tier escrow); for Drive the sealed consent
          // stays too (device-tier, but a separate act — DRIVE.md §4).
          // Either way, a separate ceremony is what deletes the
          // credential; disconnect only forgets the destination.
          await conn.unbindStore();
          note("storage:disconnected");
          body.replaceChildren();
          renderUnbound(body);
        } catch (e) {
          disconnect.disabled = false;
          problem.textContent = err(e);
          problem.hidden = false;
        }
      })();
    };

    body.append(sync, change, disconnect);

    if (storage.kind === "gdrive") {
      // FORGET THIS GOOGLE ACCOUNT: the mirror of disconnect, and a
      // control S3 has no analog for (there is no standing consent to
      // forget — the escrowed secret key lives in the keystore, and its
      // ceremony is the profile-wide erase). Two clicks, arming exactly
      // as the reseal button does (`renderKept`'s `seal.onclick`): the
      // first click states what is about to happen, the second commits.
      let forgetArmed = false;
      const forget = document.createElement("button");
      forget.type = "button";
      forget.id = "storage-gd-forget";
      forget.textContent = "Forget this Google account…";
      forget.onclick = () => {
        if (!forgetArmed) {
          forgetArmed = true;
          forget.textContent = "Yes — forget this Google account";
          return;
        }
        forget.disabled = true;
        problem.hidden = true;
        void (async () => {
          try {
            // THE HONEST SENTENCE, THE OTHER HALF (DRIVE.md §4): this
            // revokes the consent at Google (best effort) and deletes
            // the sealed tokens here. THE BINDING SURVIVES — the folder
            // and its contents remain in your Drive, and re-consenting
            // on the same client id puts this device back to work with
            // nothing re-addressed. A sync attempted before that
            // happens fails at the seam, honestly, in the problem div
            // below rather than silently.
            await conn.forgetOauth();
            note("storage:forgotten");
            announce(
              "the consent for this Google account is revoked where possible and deleted " +
                "from this device — the folder and its contents remain in your Drive",
            );
            body.replaceChildren();
            renderBound(body, storage);
          } catch (e) {
            forget.disabled = false;
            forgetArmed = false;
            forget.textContent = "Forget this Google account…";
            problem.textContent = err(e);
            problem.hidden = false;
          }
        })();
      };
      body.append(forget);
    }

    body.append(stepNote, problem);
  };

  // --- cross-page sync ------------------------------------------------------
  //
  // PAIRING.md §2 step 7's embedder half, and the beat this whole page
  // exists to exercise: pairing grants MEMBERSHIP and stops. Nothing
  // flows between the two pages until someone connects them and
  // subscribes, and only the embedder knows the transport.
  //
  // ALL OF IT RIDES THE REMOTE DRIVER NOW. Row 18 of the device-store
  // matrix (runtime/tests/devstore/run.ts) proves the visor's
  // `PairingDriver` adapter is constructible over the remote driver
  // unmodified — the error envelope carries the WIT payload, which is
  // the one property `createEnginePairingDriver` depends on. The
  // post-enrollment wiring below is the same code it always was; only
  // the object it calls has moved into the worker.
  //
  // DIRECTION IS MANDATORY AND IT IS "WRITER ACCEPTS, READER DIALS"
  // (issue #78): the adder posts an ACCEPTOR after its grant, the joiner
  // DIALS the ids its enrollment carried. Reversed, both sides report a
  // healthy connection, both sync handles report ready, and nothing ever
  // arrives — a failure with no symptom but silence, which is why the
  // direction is written down here rather than left to whichever call
  // happened to be first.

  let usSynced = false;

  /** Subscribe to `tree` with `peer`, both directions being the caller's
   * to arrange. `subscribe` is what makes a LATER write push rather than
   * wait for a poll. */
  const subscribe = async (peer: Uint8Array, tree: Uint8Array, what: string) => {
    const h = await driver.syncStart(peer, tree, true);
    await until(`subscribed to ${what}`, () => driver.syncStatus(h), 30_000);
  };

  // --- role: the JOINER (this page is the new device) ----------------------

  let joinWired = false;
  let joinAttempts = 0;
  const WIRE_ATTEMPTS = 3;

  /** Everything after ENROLLED, on the joining side.
   *
   * EXACTLY ONCE PER ENROLLMENT, retry-bounded: a second wiring is a
   * second connection and a second subscription for the same pair, so
   * the guard is set before the first await rather than after the last. */
  const joinerWire = async () => {
    if (joinWired) return;
    joinWired = true;
    joinAttempts++;
    try {
      if (!myEndpoint) throw new Error("this device never bound an iroh endpoint");
      // The RAW driver, not the adapter: the peer ids are the
      // embedder's business and the visor's contract deliberately does
      // not carry them (runtime/pairing-engine.ts's `toMockJoinState`).
      // `pair-join-status` keeps answering `enrolled`, so reading it back
      // here is a poll and not a race with the join pane's own tick.
      const enrollment = await until("this device's enrollment", async () => {
        const s = await enqueue(() => driver.pairJoinStatus());
        return s.kind === "enrolled" ? s.value : false;
      }, 30_000, 200);
      if (enrollment.peerAgentId.length === 0 || enrollment.peerEndpointId.length === 0) {
        // CONTRACT: engine.wit says an empty id means "not observed".
        // There is nothing honest to dial with, so this reports rather
        // than guessing at the other device.
        throw new Error("the enrollment carried no peer ids — cannot reach the other device");
      }
      const peer = enrollment.peerAgentId;
      await enqueue(async () => {
        // READER DIALS.
        const conn2 = await driver.irohStart(true, enrollment.peerEndpointId, RELAY, peer);
        await until("the other device answers", () => driver.connStatus(conn2), 30_000);
        await subscribe(peer, enrollment.partitionId, "your account");
      });
      // The tasks partition id has no channel but the account's own
      // pointer map — which is why the map exists (#36).
      // THE RAW DRIVER AGAIN, and for the same reason as the peer ids:
      // `us-partitions` is not on the visor's `PairingDriver` contract
      // and must not be added to it. Which partition an app is mounted
      // on is the embedder's concern; the trusted surface has no use for
      // a partition id and no business holding one.
      const pointer = await until("your account's todo list", async () => {
        const list = await enqueue(() => driver.usPartitions());
        return list.find((p) => p.name === TASKS_POINTER) ?? false;
      }, 60_000, 250);
      const tasksId = pointer.id;
      await enqueue(async () => {
        await driver.adoptPartition(tasksId);
        await subscribe(peer, tasksId, "your todo list");
      });
      usSynced = true;
      console.log("[solo] subduction wired: this device ⇄ the device that added it");
      await mountApp();
    } catch (e) {
      if (joinAttempts < WIRE_ATTEMPTS) joinWired = false;
      else announce(`could not sync this device with your account: ${err(e)}`, true);
      console.warn(`[solo] post-enrollment wiring failed (attempt ${joinAttempts}): ${err(e)}`);
    }
  };

  /** THE ADOPTION BEAT: this device takes the account's colour and name.
   * The visor UI reports the value; painting is the consumer's job — so
   * this is the consumer's half, handed to `offerFirstRun` and fired by
   * the join pane inside it. */
  const adoptionBeat = (profile: { hue: number; displayName: string }) => {
    const angle = VISOR_HUES[profile.hue] ?? VISOR_HUES[0];
    visor.commitHue(angle);
    const rec = visor.identity();
    if (profile.displayName) visor.saveIdentity({ ...rec, name: profile.displayName });
    visor.renderIdentity();
    status(`this device now follows your account: ${profile.displayName || "(unnamed)"}`);
  };

  // --- role: the ADDER (this page already has the account) -----------------

  let addTicker = 0;
  let acceptorPosted = false;
  let acceptorConn: number | null = null;
  let adderWired = false;
  let adderAttempts = 0;

  /** Everything after the GRANT, on the adding side.
   *
   * The acceptor is posted FIRST and unconditionally: the joiner is
   * already dialling by the time it has an enrollment, and a listener
   * that arrives after the dial is a dial into nothing. Only then does
   * this side wait to learn WHO joined — from its own us-doc `devices`
   * map, whose entries are keyed by agent id and which THIS device wrote
   * at enrollment (usdoc.rs's `enroll_device`). There is no need to ask
   * the peer for a name it would only be claiming. */
  const adderWire = async () => {
    if (adderWired) return;
    adderWired = true;
    adderAttempts++;
    try {
      if (!acceptorPosted) {
        acceptorPosted = true;
        // WRITER ACCEPTS: no peer, no expectation — this side answers
        // whoever it granted.
        acceptorConn = await enqueue(() =>
          driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array())
        );
      }
      const joiner = await until("the joined device", async () => {
        const res = await us.usDevicesList();
        if (!res.ok) return false;
        return res.value.find((d) => !knownAgents.has(d.agentId) && !d.revoked) ?? false;
      }, 60_000, 250);
      const peer = unhex(joiner.agentId);
      // WAIT FOR THE DIAL BEFORE SUBSCRIBING. The device entry above is
      // THIS device's own write, made at enrollment, so it appears long
      // before the joiner has dialled — and a `sync-start` issued
      // against a peer this side has no connection to reports a healthy
      // handle and delivers nothing (the same silent shape as the
      // reversed-direction bug, #78). The headless smoke waits for both
      // sides' `conn-status` before either subscribes
      // (host/pairing-bringup.ts) and so does this.
      if (acceptorConn === null) throw new Error("no acceptor connection to wait on");
      await until(
        "the new device to connect",
        () => driver.connStatus(acceptorConn as number),
        60_000,
        250,
      );
      const partitions = await enqueue(() => driver.usPartitions());
      const tasksPart = partitions.find((p) => p.name === TASKS_POINTER);
      await enqueue(async () => {
        // The user-system doc's own id is not exposed by the `us-*`
        // surface by design, and it does not need to be: the engine
        // subscribes the us doc to every known peer itself
        // (usdoc.rs's `ensure_subscriptions`, which runs on every pump).
        // What the engine cannot do for us is the TASKS partition — it
        // has no name for it — so that one is subscribed here.
        if (tasksPart) await subscribe(peer, tasksPart.id, "your todo list");
      });
      usSynced = true;
      console.log("[solo] subduction wired: this device ⇄ the device it added");
    } catch (e) {
      if (adderAttempts < WIRE_ATTEMPTS) adderWired = false;
      else announce(`could not sync the new device with your account: ${err(e)}`, true);
      console.warn(`[solo] post-grant wiring failed (attempt ${adderAttempts}): ${err(e)}`);
    }
  };

  const addTenant = visor.drawer.tenant<{ container: HTMLElement }>({
    name: "add-device",
    exclusive: true,
    dim: true,
    context: () => ({ kind: "settings" }),
  });

  openAddDevice = () => {
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "pair-add-sheet";
    const session = { container };
    // BEFORE ANYTHING IS ENROLLED: see `knownAgents`.
    void (async () => {
      const res = await us.usDevicesList();
      if (res.ok) knownAgents = new Set(res.value.map((d) => d.agentId));
    })();
    const opened = addTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "Add a device";
      const body = document.createElement("div");
      container.replaceChildren(heading, body);
      const handle: AddPaneHandle = mountAddPane(body, us, announce, {
        // The settings sheet's "add a device…" WAS the entry
        // affordance; asking again would be asking twice.
        entry: "immediate",
        onGranted: () => {
          if (addTenant.owns(session)) addTenant.close();
          // THE GRANT IS THE TRIGGER. The joiner cannot dial a device
          // that is not listening, and after the grant the ceremony is
          // entirely the other device's turn — so the acceptor goes up
          // here, not when the ENROLLED state is eventually observed.
          void adderWire();
        },
      });
      clearInterval(addTicker);
      addTicker = poll(200, async () => {
        await handle.tick();
        if (handle.settled()) clearInterval(addTicker);
      });
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.onclick = () => {
        if (addTenant.owns(session)) addTenant.close();
      };
      container.append(close);
      return { root: container };
    });
    if (!opened) clearInterval(addTicker);
  };

  // --- first run, or not ----------------------------------------------------

  /** Create the account this device is the first device of.
   *
   * ORDER IS LOAD-BEARING, and it is the order pairing-bringup.ts and
   * the native acts prove: user-create → create the tasks partition →
   * delegate it to the USER GROUP → seal → publish the pointer.
   *
   * DELEGATED TO THE GROUP, NEVER TO A DEVICE. A device added later
   * joins the group, so a group-delegated partition is readable by it
   * through the membership pairing already granted — whereas a partition
   * delegated to this device's individual would need a fresh grant per
   * device, made by a device that may not be running. */
  const newAccount = async () => {
    const created = await us.userCreate({
      displayName: visor.identity().name ?? "",
      hue: hueIndexOf(visor.committedHue()),
    });
    if (!created.ok) throw new Error(created.error);
    const userGroupId = unhex(created.value);
    const tasksId = await enqueue(async () => {
      const id = await driver.createPartition();
      await driver.khAddMember(id, userGroupId, "edit");
      await driver.sealPartition(id);
      await driver.usPartitionPut(TASKS_POINTER, id);
      return id;
    });
    console.log(`[solo] account created; tasks partition ${hex(tasksId).slice(0, 8)}…`);
    // A checkpoint the moment the account exists: everything above is
    // state a reload must not lose, and the worker's debounce would
    // otherwise be the only thing standing between it and a fast reload.
    await conn.checkpoint().catch(() => {});
    await mountApp();
  };

  /** THE ENTRY CEREMONY, while it is on screen. Null whenever there is
   * none — a device that already holds an account never offers the fork,
   * and `mountApp` closes it on the join path. It carries the JOIN
   * PANE's handle, because the pane lives inside the sheet and its poll
   * loop is this file's. */
  let entry: { joinHandle: JoinPaneHandle; close(): void } | null = null;

  /** THE FORK'S first choice, as the sheet's host sees it. The visor
   * sheet shows a failure in its own pixels; the page's status line is
   * kept too, because it is this page's own furniture and says where the
   * boot has got to. */
  const firstRunHost: FirstRunHost = {
    newAccount: async () => {
      status("creating your account…");
      try {
        await newAccount();
      } catch (e) {
        status(`could not create an account: ${err(e)}`);
        // RE-THROWN AS ITS READ FORM: the sheet renders `message`, and
        // `err` is the one reader that understands both backends' error
        // shapes (the WIT payload and the host's typed refusals).
        throw new Error(err(e));
      }
    },
  };

  // DOES THIS DEVICE ALREADY HOLD THE ACCOUNT? `us-profile-get` refuses
  // when there is no user-system partition, and that refusal IS the
  // question's answer.
  //
  // IT IS NOW A REAL QUESTION. Before G5 the engine minted a fresh
  // identity on every load, so this probe failed every time and the fork
  // was what every visitor saw; the returning-visit branch was written
  // for a future that had not arrived. The worker resumes from the
  // checkpoint (`stateResume` — `DeviceStatus.resumed` reports which
  // path it took), so a kept device that had an account still has one,
  // and this branch is the ordinary case rather than the theoretical.
  const probe = await us.usProfileGet();
  if (probe.ok) {
    note("account:resumed");
    say("your account…");
    await reconcileFromDriver(us, US_CACHE_KEYS, announce);
    const parts = await enqueue(() => driver.usPartitions());
    const tasksPart = parts.find((p) => p.name === TASKS_POINTER);
    if (tasksPart) {
      await mountApp();
    } else {
      // An account with no todo list is not a first run — offering to
      // create a SECOND account here would be the page guessing at a
      // state it does not understand.
      status("this account has no todo list yet");
      say("ready — no todo list on this account");
    }
  } else {
    note("account:none");
    // THE FORK, AS A VISOR DRAWER SHEET (visor/ui/entry.ts). It carries
    // the join pane with it, which is why the handle comes back here:
    // the pane's tick is one driver read and the wiring it triggers is
    // entirely this file's business.
    entry = offerFirstRun(visor, us, announce, firstRunHost, adoptionBeat);
    say("ready — no account on this device yet");
  }

  // The join pane's tick is one driver read; its `true` is the
  // JOIN-COMPLETED edge, which is where the embedder owes the pair a
  // sync path. NULL-GUARDED: the pane exists only while the fork sheet
  // does, and a device that already holds an account never has one.
  poll(250, async () => {
    if (await entry?.joinHandle.tick()) void joinerWire();
  });
  // Remotely-caused identity changes are announced, never silent.
  poll(1000, () => drainAnnouncements(us, announce));

  // --- driving hooks --------------------------------------------------------
  //
  // Deliberately tight (the __demo.pairing pattern): what the e2e
  // scenario needs to act as a user and to read what the user would see,
  // and nothing that would let a test bypass a ceremony's own gates.
  Object.assign(hooks, {
    /** Which side of the wire this page turned out to be, and whether it
     * has an account at all. */
    hasAccount: async () => (await us.usProfileGet()).ok,
    usSynced: () => usSynced,
    /** THE DEVICE, as the store holds it. Nothing personal: an opaque
     * id, the tier, the policy and the rungs the picker reasons about. */
    deviceId: () => conn.deviceId,
    deviceStatus: () => conn.status(),
    /** The strip's device line — "" when the rule says there is none. */
    deviceLabel: () =>
      (document.querySelector("#visor-identity .who.device") as HTMLElement | null)
        ?.textContent ?? "",
    /** The first-run fork, clicked as a user clicks it. LAZY LOOKUPS,
     * all of them: the fork is a drawer sheet now, so its controls exist
     * only while it is open — which is exactly when a scenario drives
     * them. Returns whether the button was actually found and clicked,
     * so a scenario that drives this hook too late (after the entry
     * sheet has already unmounted) fails on the spot naming the cause,
     * rather than timing out 60s later on an account that was never
     * going to appear. */
    newAccount: () => {
      const b = document.getElementById("solo-new-account") as HTMLButtonElement | null;
      b?.click();
      return b !== null;
    },
    joinAccount: () =>
      (document.getElementById("solo-join-account") as HTMLButtonElement | null)?.click(),
    /** The 79-char code as the JOIN pane renders it, ungrouped. Scoped
     * to `#solo-join`, the pane's own container, which is attached to
     * the sheet exactly while the sheet is showing the join phase. */
    code: () =>
      (document.querySelector("#solo-join .pm-code") as HTMLElement | null)?.textContent
        ?.replace(/\s+/g, "") ?? "",
    sasJoin: () =>
      (document.querySelector("#solo-join .pm-sas") as HTMLElement | null)?.textContent ?? "",
    joinConfirm: () => {
      const btns = Array.from(
        document.querySelectorAll("#solo-join button"),
      ) as HTMLButtonElement[];
      btns.find((b) => (b.textContent ?? "").includes("I initiated"))?.click();
    },
    /** The "this device" ceremony, entered the way a user enters it: the
     * strip's settings button, then the sheet's own action. */
    openDevice: () => {
      (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
      (document.querySelector(
        '#visor-drawer-inner .settings-extra-action[data-action="this-device"]',
      ) as HTMLButtonElement | null)?.click();
    },
    deviceSheet: () => ({
      open: deviceTenant.isOpen(),
      text: (document.getElementById("device-sheet")?.textContent ?? ""),
      keep: document.getElementById("device-keep") !== null,
      reseal: document.getElementById("device-reseal") !== null,
      problem: (document.getElementById("device-sheet-problem") as HTMLElement | null)?.hidden ===
          false
        ? document.getElementById("device-sheet-problem")!.textContent ?? ""
        : "",
    }),
    /** Fill the promotion ceremony's fields, then press its button —
     * every one a real control, so nothing here bypasses the sheet. */
    keepDevice: (petname: string, policy: UnsealPolicy, passphrase?: string) => {
      const name = document.getElementById("device-petname") as HTMLInputElement | null;
      if (!name) return false;
      name.value = petname;
      const radio = document.querySelector(
        `#device-sheet input[name="device-rung"][value="${policy}"]`,
      ) as HTMLInputElement | null;
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event("change"));
      if (passphrase !== undefined) {
        const p = document.getElementById("device-new-pass") as HTMLInputElement | null;
        if (!p) return false;
        p.value = passphrase;
      }
      (document.getElementById("device-keep") as HTMLButtonElement).click();
      return true;
    },
    /** Reseal: TWO clicks, exactly as the sheet demands of a user. The
     * first arms, the second commits — a driver that could skip the arm
     * would be testing a control the user does not have. `passphrase` is
     * typed into the sheet's own field first, when the ceremony is the
     * upgrade one; omitting it on a device that needs one is a real
     * thing to drive, and lands on the worker's refusal. */
    resealDevice: (passphrase?: string) => {
      const b = document.getElementById("device-reseal") as HTMLButtonElement | null;
      if (!b) return false;
      if (passphrase !== undefined) {
        const p = document.getElementById("device-reseal-pass") as HTMLInputElement | null;
        if (!p) return false;
        p.value = passphrase;
      }
      b.click();
      b.click();
      return true;
    },
    /** The add ceremony, entered the way a user enters it. */
    openAdd: () => {
      (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
      (document.querySelector(
        '#visor-drawer-inner .settings-extra-action[data-action="add-device"]',
      ) as HTMLButtonElement | null)?.click();
    },
    addOpen: () => addTenant.isOpen(),
    pasteCode: (code: string) => {
      const ta = document.querySelector("#pair-add-sheet textarea") as HTMLTextAreaElement | null;
      if (!ta) return false;
      ta.value = code;
      return true;
    },
    connect: () => {
      const btns = Array.from(
        document.querySelectorAll("#pair-add-sheet button"),
      ) as HTMLButtonElement[];
      btns.find((b) => b.textContent === "connect")?.click();
    },
    sasAdd: () =>
      (document.querySelector("#pair-add-sheet .pm-sas") as HTMLElement | null)?.textContent ?? "",
    sasContinue: () => {
      const btns = Array.from(
        document.querySelectorAll("#pair-add-sheet button"),
      ) as HTMLButtonElement[];
      btns.find((b) => (b.textContent ?? "").includes("codes match"))?.click();
    },
    /** CLICKS, so a driver meets the arming delay exactly as a user
     * does: a click before it elapses lands on a disabled button. */
    grantArmed: () => {
      const b = document.querySelector("#pair-add-sheet button.pm-armed") as
        | HTMLButtonElement
        | null;
      return b === null ? null : !b.disabled;
    },
    typeDeviceName: (value: string) => {
      const input = document.querySelector("#pair-add-sheet input[type=text]") as
        | HTMLInputElement
        | null;
      if (input) input.value = value;
    },
    grant: () =>
      (document.querySelector("#pair-add-sheet button.pm-armed") as HTMLButtonElement | null)
        ?.click(),
    /** The todo list as the ENGINE holds it. The e2e scenario drives the
     * real app UI through the frame; this is what it ASSERTS on, because
     * convergence is a claim about the partition and reading it out of
     * the frame's rendered rows would test the frame instead. */
    todos: async () => {
      const snap = await enqueue(() => tasks.items());
      return snap.items.map((i) => i.title);
    },
    /** Force a checkpoint, for a scenario that wants to reload without
     * racing the worker's 500 ms debounce. */
    checkpoint: () => conn.checkpoint(),
    /** The account's marks, for the petname-converges beat. */
    marks: async () => {
      const res = await us.usMarksList();
      return res.ok ? res.value : [];
    },
    putMark: async (provenance: string, petname: string, icon: string) => {
      const res = await us.usMarkPut({
        provenance,
        petname,
        icon,
        createdAt: Date.now(),
        needsReconfirm: false,
      });
      return res.ok;
    },
    /** Drain both timers once, without waiting on them. */
    tick: async () => {
      if (await entry?.joinHandle.tick()) void joinerWire();
      await drainAnnouncements(us, announce);
    },
    appRunner: () => appRunner !== null,
    /** The storage sheet, entered the way a user enters it. */
    openStorageSheet: () => openStorage(),
    /** The device's own claim about where it syncs — `null` sealed or
     * unbound (`DeviceStatus.storage`'s own ambiguity; see rpc.ts). */
    storageStatus: async () => (await conn.status()).storage,
    /** Whether this device already holds a sealed Drive consent — the
     * bind-without-ceremony condition (DRIVE.md §5). */
    gdriveConsent: async () => (await conn.status()).gdriveConsent,
  });
}

if (!isAuthPopup) {
  boot().catch((e) => {
    console.error(e);
    const banner = document.getElementById("banner")!.querySelector(".bar-inner")!;
    banner.textContent = `boot failed: ${err(e)}`;
  });
}
