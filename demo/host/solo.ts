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
import {
  initVisor,
  type SurfaceIdentity,
  type Visor,
  VISOR_HUES,
  VISOR_ICONS,
} from "../../visor/ui/visor.ts";
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
import type { PairingDriver, UsMark, UsProfile } from "../../visor/ui/pairing-driver.ts";
import { createEnginePairingDriver } from "../../runtime/pairing-engine.ts";
import type { UiEvent } from "../../visor/surface/events.ts";
import {
  type EngineArtifacts,
  hex,
  type RecoveryKit,
  unhex,
  until,
  type UsStorage,
} from "../../runtime/engine.ts";
import { adoptAnchor, clearAnchor } from "../../runtime/device-store/anchor.ts";
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
import type {
  DeviceStatus,
  GdriveSpace,
  RecoveryKitInput,
  StoreBinding,
} from "../../runtime/device-store/rpc.ts";
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
// THE FALLBACK PATH, demoted (web/oauth-callback.html is now the
// REGISTERED path for a web-application client). This branch stays,
// unchanged in shape, because it is still the ONLY path a desktop-type
// client accepts: those clients are registered against a loopback
// origin WITH A PATH (DRIVE.md §3's probe — `http://127.0.0.1:8600/
// solo.html`), and any path is accepted at that origin, so landing here
// works for them too. Both are cheap to keep and they cover different
// client types — this one is not deleted, only no longer the only door.
const relayedCode = params.get("code");
const isAuthPopup = !!relayedCode && !!window.opener;
if (isAuthPopup) {
  window.opener.postMessage(
    { pmGdriveCode: relayedCode, state: params.get("state") },
    location.origin,
  );
  const el = document.getElementById("banner");
  if (el) el.textContent = "authorization relayed — close this window";
  // Scrub ?code&state before the close, in case the browser blocks it
  // (close usually wins; this covers the page lingering): a one-shot
  // code is dead after relay, but a credential-shaped string left in
  // synced history is noise someone will one day have to explain away.
  history.replaceState(null, "", location.pathname);
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

/** THE ACCOUNT'S USER ICON, coming the other way: UTF-8 bytes of one
 * glyph (engine.wit's `us-profile.icon` — `option<list<u8>>`, opaque to
 * the engine) turned back into a glyph this visor is willing to draw.
 *
 * Returns null for every "nothing to say" answer — absent, undecodable,
 * or a glyph outside the visor's curated vocabulary (visor.ts's
 * VISOR_ICONS; another device may run a different build) — so a caller
 * can tell "the account has no icon" from "the account has one" and
 * never confuse the first with "clear the one this device wears". */
function decodeUserIcon(bytes: Uint8Array | undefined): string | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    const glyph = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return VISOR_ICONS.includes(glyph) ? glyph : null;
  } catch {
    return null;
  }
}

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
//
// ────────────────────────────────────────────────────────────────────
// NEVER CALL `enqueue` FROM INSIDE A JOB, and never `await` a helper
// that does. THIS IS A PAGE-WIDE FOOTGUN, not a local one.
//
// The chain is ONE promise. An `enqueue` issued while a job is running
// is appended AFTER that job, so it cannot start until the job finishes
// — and if the job is awaiting it, the job never finishes. That is a
// permanent self-deadlock, and the casualty is not just the caller: the
// chain is left holding a promise that will never settle, so EVERY
// later enqueue on the page (the announcement drain, the pairing polls,
// every serialized driver call) queues behind it forever. The page goes
// quietly dead rather than throwing.
//
// It has been paid for twice now. demo.ts's own note records the first;
// the second was the recovery-kit sheet repainting its list from inside
// its mint job (RECOVERY.md's T-C), which presented as "the file kind
// never lists" and was misdiagnosed as an engine bug — the registry was
// correct all along and the read was simply never run. Nesting fails
// SILENTLY and looks exactly like the thing you are calling being
// broken, which is why it is worth this many lines.
//
// The rule at a call site: if you are already inside a job, call the
// connection or the driver DIRECTLY — the enclosing job is already the
// serialization. A helper that reads the engine should either take its
// reader as a parameter, so the question is answered where the answer
// is known (see the recovery sheet's `readKitsQueued`/`readKitsInJob`
// pair), or be fire-and-forget and never awaited (see
// `writeThroughAccountStorage`, which enqueues from inside a job
// harmlessly precisely because nothing waits for it).
//
// WHY THERE IS NO RE-ENTRANCY GUARD HERE, though one would make the
// whole class impossible: it cannot be made sound in a browser. A guard
// needs to know "is this call coming from within a running job", and a
// plain boolean set around the job's execution answers a DIFFERENT
// question — "is a job in flight" — which is also true for a timer or
// an event handler that fires while a job sits at an await. Those are
// not in the job; running them directly would put a second guest call
// in flight beside the first and break exactly the serialization this
// chain exists to provide. The honest tool is an async-context tracker
// (`AsyncLocalStorage`), which the browser does not have. So the
// invariant is kept at the call sites, and stated here.
// ────────────────────────────────────────────────────────────────────
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
      // THE RECOVERY DOOR (entry.ts's `DevicePickerHost.restore`). The
      // picker has already closed by the time this runs and will not
      // reopen itself, so this arm owns the drawer and owns getting the
      // user back to a usable entry surface.
      //
      // THE SUCCESS PATH IS THE ORDINARY ONE, and that is the point: it
      // resolves the very promise a picked device resolves, so boot
      // continues into `startApp`, which claims the visor. Colour, name
      // and icon therefore arrive together, from the profile the restore
      // just pulled, through the SAME machinery unseal-as-login uses —
      // no second claim path, and nothing personal painted before the
      // account state was genuinely in hand (RECOVERY.md, "Restore").
      restore: () => {
        say("ready — restore from your recovery kit");
        note("picker:restore");
        return new Promise<void>((settle) => {
          mountRestore(visor, {
            onRestored: (conn, consumePending) => {
              restoredKitNote = consumedKitSentence(consumePending);
              note("restored");
              settle();
              resolve(conn);
            },
            onAbandoned: () => {
              // BACK TO THE PICKER, rebuilt: abandoning a ceremony must
              // land somewhere a user can act, and the picker is where
              // they were.
              say("ready — choose a device");
              settle();
              mountDevicePicker(visor, rows, host);
            },
          });
        });
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

// --- account recovery: the restore ceremony (runtime/RECOVERY.md) ----------
//
// THE CLAIM THIS EXISTS TO MAKE: losing every device does not lose the
// account. A recovery kit — a generated phrase, or a downloaded file
// plus its passphrase — together with access to the account's storage
// restores the account on a fresh browser with no live peer anywhere.
//
// WHERE IT RUNS, AND WHY THAT IS PRE-CLAIM. This ceremony lives at
// MODULE scope, beside `picker()`, and not inside `startApp` like the
// storage sheet it borrows its fields from. That is forced by the
// record's own ordering rule: "the visor claims at the end — colour,
// name and icon arrive from the pulled profile, and nothing personal
// renders before the account state is genuinely in hand"
// (RECOVERY.md, "Restore"). A ceremony hosted inside `startApp` would be
// a ceremony running AFTER `visor.claim()` had already painted a colour,
// which is precisely the ordering the anti-spoofing property forbids.
//
// So the restore runs on the UNCLAIMED grey dress, exactly as the picker
// does, and hands back a `DeviceConnection` for the ordinary boot to
// claim on. The two doors into it (the picker's, and the first-run
// fork's) differ only in what they do with that connection — see each
// call site.
//
// THE SECRET DISCIPLINE is the storage sheet's, unchanged: the phrase,
// the file passphrase and the S3 secret key are each read straight off
// their input and the field is cleared IN THE SAME TICK, before the
// value is used. A local carries it into the ceremony, so a refusal at
// any stage leaves no typed secret sitting in the DOM.

/** A labelled field, the shape the credential sheets use. A module-scope
 * twin of `startApp`'s own `field` — the restore ceremony cannot reach
 * that one (it is a closure over a live device) and duplicating eleven
 * lines beats hoisting a helper out of a sheet that is not this track's. */
function credField(labelText: string, hintText?: string): HTMLElement {
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
}

/**
 * WHAT A COMPLETED RESTORE OWES THE NEXT SCREEN, parked here between the
 * ceremony and the claim.
 *
 * The consumed-kit announcement is the record's own sentence and it is
 * NOT OPTIONAL (RECOVERY.md, "Single-use"): "the visor announces 'your
 * recovery kit was used — create a new one'". But the visor has no
 * announcement surface worth using until it has CLAIMED, and the claim
 * is deliberately the last thing that happens. So the ceremony leaves
 * the sentence here and `startApp` says it immediately after claiming.
 *
 * A MODULE-LEVEL LATCH RATHER THAN A RETURN VALUE because the fork's
 * door reaches the claim through a RELOAD (see its call site), and a
 * value cannot cross that; `sessionStorage` carries it instead, and this
 * variable carries it on the path that does not reload. Both are drained
 * exactly once.
 */
const RESTORE_NOTE_KEY = "pm-solo-restored";
let restoredKitNote: string | null = null;

/** The consumed-kit sentence this page actually announced, or "". See
 * the note at the announcement site: announcements REPLACE, so the strip
 * is not a surface a claim about this sentence can rest on. */
let restoreAnnouncedText = "";

/** The sentence, worded off the one fact the worker will tell us: has
 * the kit actually been retired yet? A consume failure never blocks a
 * restore (RECOVERY.md), so "used — make a new one" is true either way;
 * what changes is whether the cleanup is still in flight, and saying so
 * is honest without being alarming. */
function consumedKitSentence(consumePending: boolean): string {
  return consumePending
    ? "your recovery kit was used — create a new one. Retiring the old one is still " +
      "being retried against your storage; it cannot be used again either way."
    : "your recovery kit was used — create a new one";
}

/** Map a restore refusal onto a plain sentence.
 *
 * THE TYPED CLASSES ARE THE WORKER'S AND THE GUEST'S (client.ts's
 * `restore`): `bad-destination` and `no-credential` are host codes;
 * a wrong or already-spent phrase and a wrong file passphrase arrive as
 * the guest's own branded messages. Each becomes a sentence that says
 * what to DO, because a bare refusal at the end of a disaster is the
 * least useful thing this sheet could render.
 *
 * ANYTHING UNRECOGNISED IS REPORTED AS IT CAME. Guessing at a cause
 * would be worse than quoting the seam. */
function restoreRefusal(e: unknown): string {
  const code = (e as { code?: string }).code;
  const raw = err(e);
  if (code === "no-credential") {
    return "this browser has no credential for that destination yet — enter the secret key " +
      `for it, or grant access again (${raw})`;
  }
  if (code === "bad-destination") {
    return `that destination could not be used: ${raw}`;
  }
  // The guest's slot failures. Matched on the engine's own words rather
  // than a code because they arrive as branded component exceptions, not
  // as host conditions — see client.ts's `restore` refusal note.
  if (/no recovery kit at this name|not found|404/i.test(raw)) {
    return "no recovery kit answers that phrase. Check the words, and remember that a kit " +
      "is used up the first time it works — a phrase that restored once will never " +
      "restore again.";
  }
  if (/unlock failed|decrypt/i.test(raw)) {
    return "that passphrase did not open this file. Check it and try again — the file " +
      "itself is fine.";
  }
  return raw;
}

/** What the ceremony needs from whichever door opened it. */
interface RestoreCeremonyHost {
  /** The restore succeeded and `conn` is a live, restored device. */
  onRestored(conn: DeviceConnection, consumePending: boolean): void;
  /** The user backed out. The door owns putting them somewhere usable —
   * the ceremony has by then given the drawer up. */
  onAbandoned(): void;
}

/**
 * Mount the restore ceremony as a drawer sheet, opened immediately.
 *
 * ONE SHEET, COLLECTING IN THE RECORD'S OWN ORDER: kind, then
 * destination + credentials, then the kit secret, then the name of the
 * machine this is becoming. They are collected on one surface rather
 * than as a wizard because every one of them is needed before ANYTHING
 * can be attempted — a staged ceremony would only be able to validate at
 * the end anyway, and would have spent four screens getting there.
 */
function mountRestore(visor: Visor, host: RestoreCeremonyHost): void {
  const tenant = visor.drawer.tenant<{ root: HTMLElement }>({
    name: "restore",
    // EXCLUSIVE: this is a way IN, the same weight class as the picker,
    // and nothing may displace a half-entered recovery phrase.
    exclusive: true,
    // ARMED: FALSE — the picker's ruling, for the picker's reason
    // (entry.ts): pre-unseal there is no component frame on the page at
    // all, so the arming tax would defend nothing. The geometry is doing
    // the work: visor pixels, attached to the pinned strip, over a
    // dimmed page.
    armed: false,
    dim: true,
    context: () => ({ kind: "device-picker" }),
  });

  // THE PERSISTENT ROOT, for `mountDevicePicker`'s reason: the sheet
  // re-measures on every visibility change, and a builder that rebuilt
  // the tree would wipe a half-typed phrase the moment a refusal
  // appeared under it.
  const root = document.createElement("div");
  root.id = "restore-sheet";
  root.className = "cred-sheet";

  const heading = document.createElement("h2");
  heading.textContent = "Restore from a recovery kit";

  const lead = document.createElement("p");
  lead.className = "cred-note";
  // THE HONEST FLOOR, said before anything is typed (RECOVERY.md, "The
  // claim"): the kit is the bucket's key, not a second bucket. A user
  // who no longer has the storage is not going to be rescued by this
  // sheet, and finding that out after typing a ten-word phrase would be
  // the ceremony wasting their hope.
  lead.textContent =
    "Your account lives in your storage; the kit is the key to it. So this needs both — " +
    "where the account syncs, and the kit you kept.";

  // --- the kit kind ---------------------------------------------------------
  let kitKind: "bucket" | "file" = "bucket";
  const kindField = credField("Which kind of kit do you have?");
  const kindChoices: { value: "bucket" | "file"; id: string; label: string }[] = [
    { value: "bucket", id: "restore-kind-phrase", label: "A recovery phrase (about ten words)" },
    { value: "file", id: "restore-kind-file", label: "A recovery file, and its passphrase" },
  ];
  for (const k of kindChoices) {
    const line = document.createElement("div");
    line.className = "cred-field";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "restore-kind";
    radio.id = k.id;
    radio.value = k.value;
    radio.checked = k.value === kitKind;
    radio.onchange = () => {
      kitKind = k.value;
      phraseGroup.hidden = kitKind !== "bucket";
      fileGroup.hidden = kitKind !== "file";
      resize();
    };
    label.append(radio, document.createTextNode(` ${k.label}`));
    line.append(label);
    kindField.append(line);
  }

  // --- the destination ------------------------------------------------------
  //
  // THE SAME TWO PROVIDERS AND THE SAME FIELDS as the storage ceremony
  // (`renderUnbound`), because it IS the same question — and the same
  // credential paths behind them: the S3 secret escrows page-side
  // through `putSigningKey` keyed by destination origin, and Drive runs
  // the worker-owned OAuth with the page owning the popup. What this
  // sheet does NOT do is `bindStore`: `restore()` validates and binds
  // the destination itself, with the fail-at-bind discipline, BEFORE it
  // fetches anything (rpc.ts's `RestoreSpec.binding`).
  //
  // IDS ARE ITS OWN (`restore-*`, not `storage-*`) because both sheets
  // can exist in one document's lifetime and duplicate ids are a bug
  // waiting for whichever driver looks one up first.
  let destKind: StoreBinding["kind"] = "s3";
  const destField = credField("Where does this account sync?");
  const destChoices: { value: StoreBinding["kind"]; id: string; label: string }[] = [
    { value: "s3", id: "restore-dest-s3", label: "S3-compatible object storage" },
    { value: "gdrive", id: "restore-dest-gdrive", label: "Google Drive" },
  ];
  for (const d of destChoices) {
    const line = document.createElement("div");
    line.className = "cred-field";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "restore-dest";
    radio.id = d.id;
    radio.value = d.value;
    radio.checked = d.value === destKind;
    radio.onchange = () => {
      destKind = d.value;
      s3Group.hidden = destKind !== "s3";
      gdGroup.hidden = destKind !== "gdrive";
      resize();
    };
    label.append(radio, document.createTextNode(` ${d.label}`));
    line.append(label);
    destField.append(line);
  }

  const s3Group = document.createElement("div");
  const mkInput = (id: string, masked = false): HTMLInputElement => {
    const i = document.createElement("input");
    i.id = id;
    i.type = masked ? MASKED.type : "text";
    i.autocomplete = "off";
    return i;
  };
  const endpointInput = mkInput("restore-endpoint");
  const bucketInput = mkInput("restore-bucket");
  const accessInput = mkInput("restore-access");
  const secretInput = mkInput("restore-secret", true);
  {
    const f1 = credField("Endpoint");
    f1.append(endpointInput);
    const f2 = credField("Bucket");
    f2.append(bucketInput);
    const f3 = credField("Access key ID");
    f3.append(accessInput);
    const f4 = credField(
      "Secret key",
      "Held here as a key this browser can use and never read back. Credentials never ride " +
        "a recovery kit, so this is one thing the kit cannot bring for you.",
    );
    f4.append(secretInput);
    s3Group.append(f1, f2, f3, f4);
  }

  const gdGroup = document.createElement("div");
  gdGroup.hidden = true;
  let gdSpace: GdriveSpace = "appdata";
  const gdRootInput = mkInput("restore-gd-root");
  gdRootInput.value = params.get("gdroot") ?? "polyvisor";
  const gdClientInput = mkInput("restore-gd-client");
  gdClientInput.value = params.get("gdclient") ?? "";
  const gdSecretInput = mkInput("restore-gd-secret", true);
  {
    const spaceField = credField("Where in your Drive?");
    for (
      const sp of [
        { value: "appdata" as GdriveSpace, id: "restore-gd-space-appdata", label: "Hidden app data" },
        { value: "drive" as GdriveSpace, id: "restore-gd-space-drive", label: "A visible folder" },
      ]
    ) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "restore-gd-space";
      radio.id = sp.id;
      radio.value = sp.value;
      radio.checked = sp.value === gdSpace;
      radio.onchange = () => {
        gdSpace = sp.value;
      };
      label.append(radio, document.createTextNode(` ${sp.label}`));
      line.append(label);
      spaceField.append(line);
    }
    const f1 = credField("Drive folder");
    f1.append(gdRootInput);
    const f2 = credField("OAuth client id");
    f2.append(gdClientInput);
    const f3 = credField(
      "OAuth client secret",
      "This identifies the app to Google, not you — it is not your account's secret.",
    );
    f3.append(gdSecretInput);
    gdGroup.append(spaceField, f1, f2, f3);
  }

  // --- the kit itself -------------------------------------------------------
  const phraseGroup = document.createElement("div");
  const phraseInput = document.createElement("textarea");
  phraseInput.id = "restore-phrase";
  phraseInput.rows = 3;
  phraseInput.autocomplete = "off";
  {
    const f = credField(
      "Your recovery phrase",
      // NORMALIZATION IS THE GUEST'S (RECOVERY.md, "Derivation,
      // pinned": trim + lowercase + collapse internal whitespace), so
      // the sheet can promise this rather than police it.
      "The words in order. Capitals and extra spaces do not matter.",
    );
    f.append(phraseInput);
    phraseGroup.append(f);
  }

  const fileGroup = document.createElement("div");
  fileGroup.hidden = true;
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "restore-file";
  const filePassInput = mkInput("restore-file-pass", true);
  {
    const f1 = credField("Your recovery file");
    f1.append(fileInput);
    const f2 = credField("The passphrase for that file");
    f2.append(filePassInput);
    // NO PRE-FILL FROM THE BUNDLE, and this is a recorded gap rather
    // than an omission. RECOVERY.md's bundle payload carries the
    // account's storage ADDRESSING snapshot precisely "so a file restore
    // can pre-fill the destination fields after unlock" — but that
    // snapshot does not surface page-side: `RecoveryKitResult`'s file arm
    // is `{kind:"file", bundle}` and `RestoreSpec` takes a binding as an
    // INPUT (rpc.ts:740-756), so the page must know the destination
    // before the bundle is ever opened. Adding a worker surface to
    // expose it is not this track's to add.
    //
    // CONTRACT: the file arm therefore asks for the destination exactly
    // as the bucket arm does, where the record expects it to ask for
    // credentials only.
    fileGroup.append(f1, f2);
  }

  // --- the name of the machine this becomes ---------------------------------
  const nameInput = mkInput("restore-device-name");
  nameInput.value = "this device";
  const nameField = credField(
    "What will you call this machine?",
    // THE KIT'S LABEL GIVES WAY TO THIS (RECOVERY.md, "Restore"): the
    // kit was a dormant device wearing whatever the minting ceremony
    // called it; the restore ends with the user's own word for the
    // machine it woke up as.
    "It appears in your devices under this name, in place of the kit's own label.",
  );
  nameField.append(nameInput);

  const problem = document.createElement("div");
  problem.id = "restore-problem";
  problem.className = "entry-problem";
  problem.hidden = true;

  const stepNote = document.createElement("div");
  stepNote.id = "restore-step";
  stepNote.className = "hint";

  const go = document.createElement("button");
  go.type = "button";
  go.id = "restore-go";
  go.textContent = "Restore this account";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "restore-cancel";
  cancel.className = "entry-secondary";
  cancel.textContent = "not now";

  root.append(
    heading,
    lead,
    kindField,
    destField,
    s3Group,
    gdGroup,
    phraseGroup,
    fileGroup,
    nameField,
    problem,
    stepNote,
    go,
    cancel,
  );

  const resize = () => tenant.rebuild();
  let busy = false;

  const fail = (text: string) => {
    busy = false;
    go.disabled = false;
    cancel.disabled = false;
    stepNote.textContent = "";
    problem.textContent = text;
    problem.hidden = false;
    resize();
  };

  cancel.onclick = () => {
    // A CEREMONY IN FLIGHT IS NOT ABANDONABLE HERE: a half-run restore
    // has a device namespace and possibly a bound store behind it, and
    // "not now" cannot unwind those. The control simply refuses while
    // busy, exactly as the picker's do.
    if (busy) return;
    tenant.close();
    host.onAbandoned();
  };

  go.onclick = () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    cancel.disabled = true;
    problem.hidden = true;

    const kind = kitKind;
    const dest = destKind;
    const deviceName = nameInput.value.trim() === "" ? "this device" : nameInput.value.trim();
    const endpoint = endpointInput.value.trim();
    const bucket = bucketInput.value.trim();
    const access = accessInput.value.trim();
    // THE ONE MOMENT OF CLEARTEXT, three times over — read once, cleared
    // in the same tick, carried onward by a local (the storage sheet's
    // discipline, and the record prices this exposure explicitly in its
    // threat-model deltas).
    const secret = secretInput.value;
    secretInput.value = "";
    const phrase = phraseInput.value;
    phraseInput.value = "";
    const filePass = filePassInput.value;
    filePassInput.value = "";
    const gdRoot = gdRootInput.value.trim();
    const gdClient = gdClientInput.value.trim();
    const gdSecret = gdSecretInput.value;
    gdSecretInput.value = "";
    const chosenFile = fileInput.files?.[0] ?? null;
    const space = gdSpace;

    const at = (s: string) => {
      stepNote.textContent = `${s}…`;
      resize();
    };

    void (async () => {
      let conn: DeviceConnection | null = null;
      try {
        // THE KIT, ASSEMBLED FIRST — before a namespace exists, so a
        // missing file or an empty phrase costs nothing to refuse.
        let kit: RecoveryKitInput;
        if (kind === "bucket") {
          if (phrase.trim() === "") throw new Error("enter your recovery phrase");
          kit = { kind: "bucket", phrase };
        } else {
          if (chosenFile === null) throw new Error("choose your recovery file");
          if (filePass === "") throw new Error("enter the passphrase for that file");
          kit = {
            kind: "file",
            bundle: new Uint8Array(await chosenFile.arrayBuffer()),
            passphrase: filePass,
          };
        }

        let binding: StoreBinding;
        if (dest === "s3") {
          at("checking the destination");
          const origin = normalizeOrigin(endpoint);
          if (origin === null) {
            throw new Error(`that endpoint is not a usable address: ${endpoint}`);
          }
          if (secret !== "") {
            // ESCROW BEFORE THE NAMESPACE EXISTS: the keystore is
            // PROFILE-tier and keyed by destination origin
            // (STORAGE-EGRESS.md §2), so it belongs to the browser
            // rather than to the device about to be made — which is
            // exactly why the worker can read it back a moment later.
            at("keeping the key for this browser");
            await putSigningKey(origin, access, secret);
          }
          binding = { kind: "s3", endpoint, bucket, accessKey: access };
        } else {
          if (gdRoot === "") throw new Error("a Drive folder name is required");
          if (gdClient === "") throw new Error("an OAuth client id is required");
          binding = {
            kind: "gdrive",
            root: gdRoot,
            apiBase: gdriveEndpoints.apiBase ?? "https://www.googleapis.com",
            clientId: gdClient,
            space,
          };
        }

        // A BRAND-NEW NAMESPACE, always. `restore()` refuses on a
        // namespace that already holds a device — "a restore is a NEW
        // device, never an overwrite" (client.ts) — so `kind: "new"` is
        // the only correct arm here: `"anchor"` would hand back whatever
        // this tab was already looking at.
        //
        // NOT UNSEALED HERE. `restore` brings the engine up FROM THE KIT
        // instead of from `init`, so an `unseal()` first would init the
        // very engine the restore has to replace.
        at("setting this device up");
        conn = await connectDevice({
          device: {
            kind: "new",
            petname: deviceName,
            unsealPolicy: "while-open",
            // SEED POSTURE, said honestly in the index row: the restored
            // device's identity came out of a bundle, which is one notch
            // below platform posture (RECOVERY.md, "Restore"). The
            // migration for a restored device is parked, and a row
            // claiming `platform` would be the index lying about it.
            posture: "seed",
          },
          workerUrl: WORKER_URL,
          artifacts: ENGINE_ARTIFACTS,
          label: "solo",
        });

        if (dest === "gdrive") {
          // THE TWO-STAGE SHAPE (rpc.ts's `RestoreSpec` note): the Drive
          // consent seals its tokens under the DEK, so a DEK must exist
          // before the popup runs — and `restorePrepare` is exactly that
          // and nothing more: it opens the namespace WITHOUT initing an
          // engine. The S3 arm needs no such stage; its escrow is
          // page-side and keyed by origin.
          at("opening this device");
          await conn.restorePrepare({});
          at("asking Google for permission");
          const { authorizeUrl } = await conn.oauthStart({
            provider: "gdrive",
            clientId: gdClient,
            clientSecret: gdSecret || undefined,
            space,
            redirectUri: new URL("./oauth-callback.html", location.href).toString(),
            authUrl: gdriveEndpoints.authUrl,
            tokenUrl: gdriveEndpoints.tokenUrl,
          });
          const expectedState = new URL(authorizeUrl).searchParams.get("state");
          const popup = window.open(authorizeUrl, "pm-gdrive-auth", "width=680,height=760");
          if (!popup) {
            throw new Error("could not open the authorization window (popup blocked)");
          }
          const relay = await new Promise<{ code: string; state: string }>((resolve, reject) => {
            const done = (f: () => void) => {
              globalThis.removeEventListener("message", onMessage);
              clearInterval(closedTimer);
              clearTimeout(deadline);
              f();
            };
            const onMessage = (e: MessageEvent) => {
              if (e.origin !== location.origin) return;
              const d = e.data as
                | { pmGdriveCode?: unknown; pmGdriveError?: unknown; state?: unknown }
                | null;
              if (!d) return;
              if (expectedState !== null && d.state !== expectedState) return;
              if (typeof d.pmGdriveError === "string") {
                done(() => reject(new Error(`authorization was refused: ${d.pmGdriveError}`)));
                return;
              }
              if (typeof d.pmGdriveCode !== "string") return;
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
          });
          try {
            popup.close();
          } catch { /* already gone */ }
          await conn.oauthComplete(relay.code, relay.state);
        }

        // THE RESTORE ITSELF. Everything after this line is the worker's
        // (client.ts's `restore`): validate the binding, bring the engine
        // up from the kit, pull the us-doc and then the account fan-out,
        // checkpoint, and only then consume the kit. The page's only job
        // is to say so while it happens.
        at("finding your account in your storage");
        note("restore:started");
        const st = await conn.restore({ binding, kit, deviceName, unseal: {} });
        note("restore:done");
        at("your account is here");

        // A CONSUME FAILURE NEVER FAILS A RESTORE, so it is a fact to
        // REPORT rather than a branch to take.
        const consumePending = st.sync?.consumePending ?? false;
        tenant.close();
        host.onRestored(conn, consumePending);
      } catch (e) {
        // NOT A DEAD END. The sheet keeps everything the user typed
        // except the secrets it cleared, says what happened in a plain
        // sentence, and stays up — and the DOOR that opened it is still
        // reachable through "not now", so a refused restore never wedges
        // the way in.
        note("restore:refused");
        if (conn !== null) {
          // The half-born namespace goes. Leaving it would put a device
          // in the index that holds nothing, under a name the user gave
          // to a machine that never became anything.
          try {
            await conn.destroy();
          } catch { /* a namespace that will not go is not this refusal's story */ }
          clearAnchor();
        }
        fail(restoreRefusal(e));
      }
    })();
  };

  tenant.open({ root }, () => ({ root }));
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

  // THE CONSUMED-KIT ANNOUNCEMENT, said HERE and not in the ceremony
  // (RECOVERY.md, "Single-use": "the visor announces 'your recovery kit
  // was used — create a new one'").
  //
  // AFTER THE CLAIM, DELIBERATELY. The ceremony that earned this
  // sentence ran on the unclaimed grey dress, where the visor has no
  // voice worth using yet; one line above, the visor became the user's.
  // This is the first thing it says as theirs, which is also the right
  // order for the user: they see their account arrive, then they are
  // told what it cost.
  //
  // STICKY, because "you currently have no recovery kit" is a standing
  // condition and not news that should scroll past. The honest cost the
  // record names is a window with NO kit until the user mints a fresh
  // one — "no kit, loudly" is the whole bargain, and an announcement
  // that vanished after fifteen seconds would be the quiet version.
  //
  // TWO SOURCES, ONE DRAIN: the picker's door leaves the sentence in a
  // module variable (no reload crosses that path), the fork's door
  // leaves it in `sessionStorage` (a reload does). Drained exactly once
  // either way.
  {
    let kitNote = restoredKitNote;
    restoredKitNote = null;
    if (kitNote === null) {
      try {
        kitNote = sessionStorage.getItem(RESTORE_NOTE_KEY);
        if (kitNote !== null) sessionStorage.removeItem(RESTORE_NOTE_KEY);
      } catch { /* a storage-less browser simply loses the sentence */ }
    }
    if (kitNote !== null && kitNote !== "") {
      note("restore:announced");
      // KEPT FOR DRIVING, not for the UI: `visor.announce` REPLACES, so
      // by the time anything else has been said the strip no longer
      // holds this sentence — and a scenario asserting the record's
      // exact stance would be asserting on a race. This is the same
      // shape as `bootTrace`: the page's own account of what it said.
      restoreAnnouncedText = kitNote;
      announce(kitNote, true);
    }
  }

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
      //
      // THE GLYPH GOES WITH THE NAME, as UTF-8 bytes of the glyph
      // itself (engine.wit's `us-profile.icon` is `option<list<u8>>`
      // and the engine treats it as opaque). `rec.icon` was already
      // filtered to the visor's curated vocabulary by `loadIdentity`,
      // so what crosses is one vetted glyph and never free text. An
      // ABSENT icon crosses as `none`, which the engine reads as
      // "delete" — right, because absent here means the user's record
      // genuinely has no glyph, not that this device has nothing to
      // say (the settings sheet always commits a picked one).
      void (async () => {
        const res = await us.usProfileSet({
          displayName: rec.name ?? "",
          hue: hueIndexOf(hue),
          icon: rec.icon ? new TextEncoder().encode(rec.icon) : undefined,
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
    onReset: async () => {
      // THE DEVICE ITSELF GOES, and that is the point of this handler on
      // this page. Before G5 an erase here wiped three localStorage
      // caches and reloaded onto the SAME device — the account came
      // straight back, which is not what the ceremony promised.
      //
      // FIRST, AND FALLIBLE ON PURPOSE. `conn.destroy()` is the one step
      // that can fail, and the sheet's contract is that a throw out of
      // `onReset` REFUSES the whole ceremony with everything still held
      // (visor/ui/sheets.ts's "the fallible half first"). So it runs
      // before anything else is forgotten: if the namespace cannot be
      // destroyed, the user is told, and nothing below has already
      // thrown away the way back to it.
      await conn.destroy();
      // The T0 pointer, which now names storage that does not exist.
      // `adoptAnchor` would clear it on the next boot anyway (a stale
      // pointer is a fresh device, silently — PERSISTENCE.md's degrade
      // rule), but leaving it would make the reload's first act a
      // recovery from something we did on purpose.
      clearAnchor();
      // And the boot caches, which are this page's copies of what the
      // account said about the user.
      for (const k of [US_CACHE_KEYS.hue, US_CACHE_KEYS.name, US_CACHE_KEYS.marks]) {
        localStorage.removeItem(k);
      }
    },
    resetConsequences: [
      "this device's copy of your account",
      "the devices you paired with this one",
    ],
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

  /** Re-measure the storage sheet. Every view in it (bound, unbound,
   * recovery kits) changes the sheet's height, and the drawer animates
   * to a MEASURED pixel target and clips the overflow — so a view that
   * grew without saying so is a view whose bottom controls cannot be
   * reached. */
  const tenantRebuild = () => storageTenant.rebuild();

  /** The connect ceremony's own busy-guard, mirroring `setupInFlight` in
   * demo.ts's `setupBucket`: a duplicate click while one binding is in
   * flight would race the same escrow write (or the same OAuth
   * ceremony) and the same bind. */
  let storageConnectInFlight = false;

  // --- what the worker's sync schedule has done (runtime/SYNC.md §3) -------
  //
  // THE PAGE SCHEDULES NOTHING. Everything below is a READER of
  // `DeviceStatus.sync`: the schedule lives in the worker, which owns
  // the engine and the binding and outlives this tab. Two facts flow out
  // of it and both land here — the "last synced" line in the bound view,
  // and the announcement a repeatedly-failing schedule owes the user.

  /** The bound view's "last synced" element while that view is mounted,
   * or null. Nulled by every path that replaces the view, so the poll
   * below never repaints a detached node. */
  let syncLine: HTMLElement | null = null;

  /** True while an announcement about a failing schedule is standing.
   * ONE ANNOUNCEMENT PER CROSSING, not one per poll: the poll runs every
   * second and a sync that is down stays down, so announcing on the
   * fact rather than on the edge would bury every other sentence the
   * visor has to say under a metronome. Cleared when the counts come
   * back under the threshold, which re-arms it for the NEXT outage. */
  let syncFailureAnnounced = false;

  /** THE THRESHOLD, and it is the worker's own (rpc.ts's `SyncStatus`):
   * three consecutive failures is where a background failure stops
   * being the scheduler's business and becomes the user's. */
  const SYNC_VISIBLE_AFTER = 3;

  /**
   * "3 minutes ago" — a DURATION, because the question the line answers
   * is "is my work in the bucket?" and no clock time answers that
   * without arithmetic.
   *
   * Coarse on purpose: a sync that happened 91 seconds ago and one that
   * happened 110 do not differ in any way the reader cares about, and a
   * ticking seconds counter would make a settled sheet look busy.
   */
  const agoText = (at: number): string => {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 10) return "just now";
    if (secs < 90) return `${secs} seconds ago`;
    const mins = Math.round(secs / 60);
    if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${Math.round(hours / 24)} days ago`;
  };

  /**
   * The bound view's one sentence about the schedule.
   *
   * IT NEVER FABRICATES A TIME. `lastFlush === null` on a bound device
   * means the schedule has genuinely not completed a flush yet — a
   * device bound a moment ago, or one whose every attempt has failed —
   * and saying "not yet" is the honest answer where "never" would sound
   * like a fault and a made-up timestamp would be a lie. When the
   * schedule is also FAILING, the sentence says so and carries the
   * seam's own words, which is the same treatment the Sync-now button's
   * result already gets.
   */
  const paintSyncLine = async (): Promise<void> => {
    const line = syncLine;
    if (!line) return;
    let st: DeviceStatus;
    try {
      st = await conn.status();
    } catch {
      return; // a status read that failed says nothing; leave the last true thing up
    }
    if (line !== syncLine || !line.isConnected) return;
    const sync = st.sync;
    if (!sync) {
      // Sealed, or unbound — neither of which this view should be
      // mounted over, so it is a transient rather than a state to word.
      line.textContent = "";
      return;
    }
    const when = sync.lastFlush === null
      ? "This device has not finished an automatic sync yet."
      : `Last synced ${agoText(sync.lastFlush)}.`;
    const failing = sync.flushFailures >= SYNC_VISIBLE_AFTER ||
      sync.pullFailures >= SYNC_VISIBLE_AFTER;
    line.textContent = failing && sync.lastError !== null
      ? `${when} Syncing is failing: ${sync.lastError}`
      : when;
  };

  /**
   * THE ANNOUNCEMENT HALF (SYNC.md §3: "a sync that has silently stopped
   * is a lie of omission").
   *
   * STICKY, because this is not news that scrolls past: the user's work
   * is not going where they think it is, and the sentence should stay up
   * until they act or until it comes back. It names the seam's own error
   * because a bare "syncing is failing" gives them nothing to do with
   * it.
   *
   * A RECOVERY IS ANNOUNCED TOO, and only when a failure was announced
   * — the visor should not congratulate itself for a sync nobody was
   * told had stopped.
   */
  const watchSyncFailures = async (): Promise<void> => {
    let st: DeviceStatus;
    try {
      st = await conn.status();
    } catch {
      return;
    }
    const sync = st.sync;
    if (!sync) return;
    const failing = sync.flushFailures >= SYNC_VISIBLE_AFTER ||
      sync.pullFailures >= SYNC_VISIBLE_AFTER;
    if (failing && !syncFailureAnnounced) {
      syncFailureAnnounced = true;
      announce(
        `this device has stopped syncing with your storage${
          sync.lastError === null ? "" : ` — ${sync.lastError}`
        }`,
        true,
      );
    } else if (!failing && syncFailureAnnounced) {
      syncFailureAnnounced = false;
      announce("this device is syncing with your storage again");
    }
    await paintSyncLine();
  };

  /** THE ACCOUNT'S STORAGE RECORD as this sheet last read it, kept so a
   * bind can tell whether it would be saying anything new. The diverge
   * path (`#storage-diverge`) drops the adopt view but not this
   * knowledge — that is what makes the redundant-put check possible
   * from there too. */
  let accountStorageSeen: UsStorage | undefined;

  /** Is `a` the same destination `b` names? Field-wise, because the
   * record is flat and the comparison is only ever used to SKIP work. */
  const sameStorage = (a: UsStorage | undefined, b: UsStorage | undefined): boolean => {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "s3" && b.kind === "s3") {
      return a.value.endpoint === b.value.endpoint && a.value.bucket === b.value.bucket &&
        a.value.accessKey === b.value.accessKey;
    }
    if (a.kind === "gdrive" && b.kind === "gdrive") {
      return a.value.root === b.value.root && a.value.apiBase === b.value.apiBase &&
        a.value.space === b.value.space && a.value.clientId === b.value.clientId &&
        a.value.clientSecret === b.value.clientSecret;
    }
    return false;
  };

  /**
   * WRITE-THROUGH after a manual bind (DRIVE.md, "The account syncs its
   * storage config; devices keep their credentials": the record is
   * "written through when a device binds, announced on the others when
   * it changes").
   *
   * SAME IDIOM AS `onIdentityCommitted` above (see its WRITE-THROUGH
   * note, ~line 878): the local thing has already happened — the store
   * is bound and the first flush landed — so the account is the source
   * of truth CATCHING UP, and a failure here is ANNOUNCED rather than
   * hidden or retried behind the user's back. Fire-and-forget for the
   * same reason: nothing on screen is waiting for it.
   *
   * WHAT IT DOES NOT DO:
   *   - it does not fire for a bind that ADOPTED the record (the caller
   *     decides that), and it skips a record identical to the one
   *     already in the account — track 1 diffs, so an identical put
   *     raises no event on the other devices, but a redundant write to
   *     the user-system doc is still a redundant write;
   *   - it does not write a gdrive record without a client secret.
   *     CONTRACT: `us-storage-gdrive.client-secret` is a plain `string`
   *     with no "absent" case, and a record carrying an EMPTY one would
   *     be actively harmful — a second device would adopt it, consent,
   *     and then fail the token exchange with nothing on screen to
   *     explain why. The conservative reading is to leave the account's
   *     existing record alone and say so, which is what the announce
   *     below does. (Reached when a bind reuses a consent this device
   *     already holds and the secret field was left blank.)
   */
  const writeThroughAccountStorage = (
    storage: StoreBinding | null,
    clientSecret: string,
  ) => {
    if (storage === null) return;
    let record: UsStorage;
    if (storage.kind === "s3") {
      // NO SECRET, STRUCTURALLY (DRIVE.md): `accessKey` is the public
      // identifier; the SigV4 secret is a non-extractable handle and
      // has no bytes to write. Each device escrows its own.
      record = {
        kind: "s3",
        value: {
          endpoint: storage.endpoint,
          bucket: storage.bucket,
          accessKey: storage.accessKey,
        },
      };
    } else {
      if (clientSecret === "") {
        announce(
          "this device is connected, but your account's storage settings were left unchanged " +
            "— reconnect with the client secret to share this destination with your other " +
            "devices",
          true,
        );
        return;
      }
      record = {
        kind: "gdrive",
        value: {
          root: storage.root,
          apiBase: storage.apiBase,
          space: storage.space,
          clientId: storage.clientId,
          clientSecret,
        },
      };
    }
    if (sameStorage(record, accountStorageSeen)) return;
    void (async () => {
      try {
        await enqueue(() => driver.usStoragePut(record));
        accountStorageSeen = record;
        note("storage:account-written");
      } catch (e) {
        announce(`could not save your account's storage settings: ${err(e)}`, true);
      }
    })();
  };

  openStorage = () => {
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "storage-sheet";
    // THE PERSISTENT BODY — the same discipline the device picker's root
    // keeps (visor/ui/entry.ts), and it became load-bearing when this
    // sheet grew a view tall enough to need a re-measure.
    //
    // THE DRAWER'S `rebuild()` RE-RUNS THIS BUILDER. So a builder that
    // created the body would hand every re-measure a FRESH EMPTY body
    // and detach the one the current view is living in — the sheet would
    // blank itself at exactly the moment it was asked to fit its
    // contents. Creating the body once, out here, makes `rebuild()` mean
    // what its name says: measure this again, change nothing.
    //
    // Measured the hard way, twice: without a re-measure the recovery
    // control below the fold was unclickable (the drawer clips to a
    // measured height, so a click on it lands on the dim); with a
    // re-measure against a builder-created body, the whole sheet went
    // blank instead.
    const body = document.createElement("div");
    const session = { container };
    /** The async fill runs ONCE per open, not once per re-measure: it is
     * a read of the device and the account, and re-issuing it on every
     * height change would race the view the user is currently in. */
    let filled = false;
    storageTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "Storage";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.onclick = () => {
        if (storageTenant.owns(session)) storageTenant.close();
      };
      container.replaceChildren(heading, body, close);
      if (filled) return { root: container };
      filled = true;
      // THE ACCOUNT'S RECORD IS READ ON EVERY OPEN (DRIVE.md, "The
      // account syncs its storage config; devices keep their
      // credentials"): whether this device has a store of its own and
      // whether its ACCOUNT has one are two different questions, and the
      // interesting cell of that table — unbound device, bound account —
      // is exactly the freshly-paired second device. A failed read is
      // not a failed sheet: it degrades to the plain manual form, which
      // is always correct, merely more typing.
      void Promise.all([
        conn.status(),
        enqueue(() => driver.usStorageGet()).catch(() => undefined),
      ]).then(([st, account]) => {
        accountStorageSeen = account ?? undefined;
        if (st.storage === null) renderUnbound(body, undefined, accountStorageSeen);
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
   * key nor the Drive client secret is held here to read back).
   *
   * `account` FORKS THE VIEW (DRIVE.md, "The account syncs its storage
   * config; devices keep their credentials"): when the account already
   * carries a storage record and THIS device is unbound, the sheet
   * leads with "your account syncs through …" and offers exactly the
   * per-device half of the ceremony — the consent click (gdrive) or the
   * secret-key escrow (s3). Nothing that syncs is typed again: typing a
   * different-but-valid client id is the silent-fork failure mode the
   * record exists to prevent.
   *
   * The account view is a MODE OF THIS FUNCTION rather than a second
   * renderer, deliberately: the bind ceremony below (consent, escrow,
   * `ensureBucket`/`storeGrant`/`bucketFlush`, the failure wording) is
   * the same ceremony either way, and a copy of it would be a copy that
   * drifts. What the mode changes is which values it reads and which
   * fields it paints. */
  const renderUnbound = (body: HTMLElement, prefill?: StoreBinding, account?: UsStorage) => {
    // The synced record this render is ADOPTING, if any. Non-undefined
    // means: every field that syncs comes from the account, not from
    // this sheet — which is also what suppresses the write-through
    // below (a bind that came FROM the record has nothing to write).
    const adopting = account;
    const lead = document.createElement("p");
    lead.className = "cred-note";
    lead.id = "storage-lead";
    if (adopting) {
      // VISOR VOICE, and the destination is the USER'S own
      // configuration (typed on their other device), so no plating
      // applies — same reasoning as `renderBound`'s lead below.
      lead.textContent = adopting.kind === "gdrive"
        ? `Your account syncs its storage through the "${adopting.value.root}" folder in ` +
          `${
            adopting.value.space === "appdata"
              ? "your Google Drive's hidden app data"
              : "your Google Drive"
          }. This device only needs your permission — nothing to type.`
        : `Your account syncs its storage through ${adopting.value.bucket} at ` +
          `${adopting.value.endpoint}. This device only needs the secret key for it — ` +
          "the rest is already settled by your account.";
    } else {
      lead.textContent =
        "This device can sync through a bucket it reaches directly. Whichever provider you " +
        "choose, the secret half of the ceremony is typed here and never stored as text.";
    }
    body.append(lead);

    // THE PROVIDER CHOICE (DRIVE.md §6). S3 is the default — it is the
    // provider this sheet has always offered — and choosing Drive shows
    // its own fields in place of S3's rather than beside them: the two
    // providers are alternatives, not a combined form.
    let chosenKind: StoreBinding["kind"] = adopting?.kind ?? prefill?.kind ?? "s3";
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
    // THE PROVIDER CHOICE IS NOT OFFERED WHEN ADOPTING: an account has
    // ONE store, so on this path the provider is already decided and a
    // radio pair would be an invitation to fork it. The way to change
    // the account's mind is the diverge link at the bottom, which is a
    // different, louder gesture.
    if (!adopting) body.append(kindField);

    // --- the S3 fields (unchanged ids: this is the existing sheet) ---------
    const s3Group = document.createElement("div");
    s3Group.hidden = chosenKind !== "s3";

    // WHEN ADOPTING S3, addressing comes from the account and is
    // SETTLED — shown, because the user is entitled to see where their
    // data goes, but not editable, because every device must agree on
    // it. The one input left is the secret key: "the SigV4 secret
    // structurally cannot sync … each device still escrows the secret
    // itself" (DRIVE.md, same section).
    const acctS3 = adopting?.kind === "s3" ? adopting.value : undefined;
    const settle = (input: HTMLInputElement) => {
      if (!acctS3) return;
      input.readOnly = true;
      input.setAttribute("aria-readonly", "true");
    };

    const endpointField = field("Endpoint");
    const endpointInput = document.createElement("input");
    endpointInput.type = "text";
    endpointInput.id = "storage-endpoint";
    endpointInput.value = acctS3?.endpoint ?? (prefill?.kind === "s3" ? prefill.endpoint : "");
    settle(endpointInput);
    endpointField.append(endpointInput);
    s3Group.append(endpointField);

    const bucketField = field("Bucket");
    const bucketInput = document.createElement("input");
    bucketInput.type = "text";
    bucketInput.id = "storage-bucket";
    bucketInput.value = acctS3?.bucket ?? (prefill?.kind === "s3" ? prefill.bucket : "");
    settle(bucketInput);
    bucketField.append(bucketInput);
    s3Group.append(bucketField);

    const accessField = field("Access key ID");
    const accessInput = document.createElement("input");
    accessInput.type = "text";
    accessInput.id = "storage-access";
    accessInput.value = acctS3?.accessKey ?? (prefill?.kind === "s3" ? prefill.accessKey : "");
    settle(accessInput);
    accessField.append(accessInput);
    s3Group.append(accessField);

    const secretField = field(
      "Secret key",
      acctS3
        ? "The one thing your account cannot carry for you: it is held here as a key this " +
          "browser can use and never read back."
        : "Leave blank if this browser already holds the secret for this destination.",
    );
    const passInput = document.createElement("input");
    passInput.type = MASKED.type;
    passInput.id = "storage-secret";
    secretField.append(passInput);
    s3Group.append(secretField);
    // Adopting a gdrive account leaves the S3 group off the page
    // entirely rather than merely hidden: there is no provider choice
    // on that path, so a hidden alternative form is dead weight.
    if (!adopting || adopting.kind === "s3") body.append(s3Group);

    // --- the Drive fields (DRIVE.md §6) -------------------------------------
    const gdriveGroup = document.createElement("div");
    gdriveGroup.hidden = chosenKind !== "gdrive";

    // WHERE IN THE DRIVE, and the visor says both halves plainly
    // (DRIVE.md §5). HIDDEN APP DATA IS THE DEFAULT: the platform
    // itself refuses to share those files, and nothing in the Drive UI
    // can rename or move them out from under a store that addresses
    // them by keyed name. The visible folder stays on offer because
    // some people want to see the thing they are trusting.
    const acctGdrive = adopting?.kind === "gdrive" ? adopting.value : undefined;
    // CONTRACT: engine.wit types the record's `space` as a bare
    // `string`, not the two-case enum `GdriveSpace` — so a record
    // written by a NEWER build could name a space this one does not
    // know. That is REFUSED, not narrowed.
    //
    // Narrowing it (to the hidden app data, say, as the safer-looking of
    // the two known values) would be the exact failure this whole
    // feature exists to prevent: the account agreed on a destination,
    // this device would flush into a DIFFERENT one, and in the appdata
    // space the fork is invisible in the user's own Drive UI — a silent
    // fork with a UI, DRIVE.md's own phrase. An unknown space is not a
    // value to guess at; it is a device that is too old to join this
    // account's store, and the honest move is to say so and refuse the
    // bind. The diverge hatch below still works: rebinding the account
    // is a legitimate answer to "my other device moved on".
    const acctSpaceUnknown = acctGdrive !== undefined &&
      acctGdrive.space !== "drive" && acctGdrive.space !== "appdata";
    const acctSpace: GdriveSpace = acctGdrive?.space === "drive" ? "drive" : "appdata";
    let chosenSpace: GdriveSpace = acctGdrive
      ? acctSpace
      : prefill?.kind === "gdrive"
      ? prefill.space
      : "appdata";
    const spaceField = field("Where in your Drive?");
    const spaceChoices: { value: GdriveSpace; id: string; label: string; note: string }[] = [
      {
        value: "appdata",
        id: "storage-gd-space-appdata",
        label: "Hidden app data (recommended)",
        note: "Your Drive will not show these files; they cannot be shared; and you cannot " +
          "move or delete them one at a time — Drive's own settings can remove all of this " +
          "app's hidden data at once.",
      },
      {
        value: "drive",
        id: "storage-gd-space-drive",
        label: "A visible folder in your Drive",
        note: "You will see a folder in your Drive. Its files are encrypted, so they will " +
          "look like meaningless names — and if you rename or move them, this device cannot " +
          "find them again.",
      },
    ];
    for (const sp of spaceChoices) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "storage-gd-space";
      radio.id = sp.id;
      radio.value = sp.value;
      radio.checked = sp.value === chosenSpace;
      radio.onchange = () => {
        chosenSpace = sp.value;
      };
      label.append(radio, document.createTextNode(` ${sp.label}`));
      line.append(label);
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = sp.note;
      line.append(note);
      spaceField.append(line);
    }
    const spaceSwitchNote = document.createElement("div");
    spaceSwitchNote.className = "hint";
    // THE CONSENT COUPLING, said once and where it lands (DRIVE.md §5):
    // the space picks the scope, so the two choices are two different
    // permissions and a change means a fresh consent screen.
    spaceSwitchNote.textContent =
      "Changing this later asks for a new consent, because it is a different permission.";
    spaceField.append(spaceSwitchNote);
    gdriveGroup.append(spaceField);

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
    // `StoreBinding` and this sheet never holds one to read back. NO
    // `?gdsecret=` URL param, unlike gdclient/gdroot above: a URL is
    // synced history plus a server request line, and a confidential
    // secret (DRIVE.md's BYO ruling) must never ride either — the
    // masked field below is its only entry path.
    gdSecretInput.value = "";
    gdSecretField.append(gdSecretInput);
    gdriveGroup.append(gdSecretField);
    // ADOPTING A DRIVE ACCOUNT PAINTS NO FIELDS AT ALL. Root, space,
    // client id and client secret all ride the account precisely so a
    // second device never types them — retyping is the silent-fork
    // failure mode (DRIVE.md). What is left is the consent click, which
    // is the button below.
    if (!adopting) body.append(gdriveGroup);

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
    connect.textContent = adopting ? "Connect this device" : "Save & connect";
    // THE REFUSAL (see the `acctSpaceUnknown` note above): a record
    // naming a Drive space this build does not know cannot be adopted,
    // because adopting it would mean flushing somewhere other than
    // where the account agreed. Said in the visor's own voice, naming
    // the cause and both ways out — and the button stays dead, so there
    // is no path from here into the wrong store.
    if (acctSpaceUnknown) {
      problem.textContent =
        "This account's storage was set up by a newer version of this app than this device is " +
        "running — update this device, or choose a different destination below.";
      problem.hidden = false;
      connect.disabled = true;
    }
    connect.onclick = () => {
      // Belt as well as braces: the button is disabled above, so this is
      // unreachable through the DOM — but "cannot adopt" is a rule about
      // the BIND, not about a button's state, and it is cheaper to state
      // it here than to rely on nobody ever calling `.click()` on a
      // disabled element from a hook.
      if (acctSpaceUnknown) return;
      if (storageConnectInFlight) return;
      storageConnectInFlight = true;
      connect.disabled = true;
      problem.hidden = true;
      const kind = chosenKind;
      // s3's fields, read once regardless of which provider is chosen —
      // harmless, since only the chosen branch below uses them. When
      // adopting, the addressing inputs hold the account's own values
      // (settled above), so reading them here is reading the record.
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
      //
      // WHEN ADOPTING, these come from the ACCOUNT and not from the
      // page: no gdrive field was painted at all on that path. The
      // client secret arrives over the account's keyhive-E2E channel
      // rather than through a keyboard, which is exactly the ruling —
      // app identity may ride the account, user credentials may not.
      const root = acctGdrive?.root ?? gdRootInput.value;
      const client = acctGdrive?.clientId ?? gdClientInput.value;
      const space = chosenSpace;
      const gdSecret = acctGdrive?.clientSecret ?? gdSecretInput.value;
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
            // BIND-WITHOUT-CEREMONY (DRIVE.md §5), NOW SPACE-AWARE: a
            // consent already sealed for this device is reused rather
            // than asked for twice — but only when it was granted for
            // the space this connect names. The space picks the SCOPE,
            // so a consent for the other one is a consent to a
            // different permission, and reusing it would only produce
            // `bindStore`'s `no-credential` a moment later. Asking
            // again is the honest move, and the step text says so.
            // (`gdriveConsent` still says nothing about WHICH client id
            // it was minted for — that mismatch stays `bindStore`'s to
            // catch, by name, as the access-key analog.)
            const consent = (await conn.status()).gdriveConsent;
            if (consent && consent.space === space) {
              step = "consent";
              stepNote.textContent =
                "configuring storage: consent (using the consent this device already holds)…";
            } else {
              at("consent");
              if (consent) {
                stepNote.textContent =
                  "configuring storage: consent (this device's consent was for a different " +
                  "place in your Drive, so Google will ask again)…";
              }
              // THE WORKER OWNS THE VERIFIER; THE PAGE OWNS THE POPUP
              // (DRIVE.md §3). What crosses here is app identity and
              // addressing; what comes back is a URL, never a token.
              const { authorizeUrl } = await conn.oauthStart({
                provider: "gdrive",
                clientId: client,
                clientSecret: gdSecret || undefined,
                // THE SPACE IS A CONSENT-TIME DECISION: it selects the
                // scope this URL asks for (`drive.appdata` vs
                // `drive.file`), which is why it crosses here and not
                // only at bind.
                space,
                // web/oauth-callback.html is the REGISTERED redirect for
                // a web-application client (DRIVE.md §3) — resolved
                // relative to the current page, never a hardcoded
                // origin, so this is correct on localhost, on 127.0.0.1
                // and on the Pages path alike. The `?code` branch above
                // stays as the fallback for a desktop-type client
                // registered against solo.html itself.
                redirectUri: new URL("./oauth-callback.html", location.href).toString(),
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
                    const d = e.data as
                      | { pmGdriveCode?: unknown; pmGdriveError?: unknown; state?: unknown }
                      | null;
                    if (!d) return;
                    if (expectedState !== null && d.state !== expectedState) return;
                    // THE ERROR CASE (oauth-callback.html): the provider
                    // sent ?error= instead of a code. Rejecting here
                    // turns that into a prompt refusal the sheet can
                    // render, rather than a silent wait for the timeout
                    // this listener would otherwise hit.
                    if (typeof d.pmGdriveError === "string") {
                      done(() => reject(new Error(`authorization was refused: ${d.pmGdriveError}`)));
                      return;
                    }
                    if (typeof d.pmGdriveCode !== "string") return;
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
              apiBase: acctGdrive?.apiBase ?? gdriveEndpoints.apiBase ??
                "https://www.googleapis.com",
              clientId: client,
              space,
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
          if (adopting) {
            // THE HEADLINE, as a breadcrumb: this bind used the
            // account's synced record, so nothing that syncs was typed
            // on this device.
            note("storage:account-adopted");
          } else {
            // WRITE-THROUGH, and DELIBERATELY NOT when adopting: a bind
            // that came FROM the record has nothing to say back to it.
            writeThroughAccountStorage(bound.storage, gdSecret);
          }
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

    // THE ESCAPE HATCH. Adopting is the right default and not an
    // obligation: an account member may legitimately want to REBIND THE
    // ACCOUNT — a bucket that is going away, a Drive client being
    // replaced. So the adopt view offers a way to the full manual form,
    // quietly (a link, not a second primary button), and the bind that
    // follows it is an ordinary manual bind: it writes the record
    // through, and the OTHER devices announce the change rather than
    // silently adopting it (DRIVE.md).
    if (adopting) {
      const diverge = document.createElement("button");
      diverge.type = "button";
      diverge.id = "storage-diverge";
      diverge.className = "hint";
      diverge.textContent = "use a different destination…";
      diverge.onclick = () => {
        if (storageConnectInFlight) return;
        body.replaceChildren();
        // No `account` — that is the whole gesture. `accountStorageSeen`
        // still remembers the record, so a bind that lands on the very
        // same destination anyway still skips its redundant put.
        renderUnbound(body);
      };
      body.append(diverge);
    }
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
      : `This device syncs through the "${storage.root}" folder in ${
        storage.space === "appdata"
          ? "your Google Drive's hidden app data, where your Drive will not show it"
          : "your Google Drive, where you can see it"
      }, using client ${storage.clientId}.`;
    body.append(lead);

    const stepNote = document.createElement("div");
    stepNote.className = "hint";
    stepNote.id = "storage-sheet-note";

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "storage-sheet-problem";
    problem.hidden = true;

    // WHAT THE SCHEDULE HAS DONE, beside the button that does it by
    // hand (SYNC.md §3, "Surface": "the sheet renders 'last synced'
    // beside the Sync-now button it keeps"). The whole point of an
    // automatic flush is that the user stops pressing the button — so
    // the sheet owes them the fact that would otherwise have been the
    // press's receipt.
    //
    // RELATIVE, NOT A CLOCK TIME, because the question this line answers
    // is "is my work in the bucket?" and the answer to that is a
    // DURATION. It repaints off the same slow poll that watches for a
    // failing schedule, and is filled in immediately below so the sheet
    // is not blank for a second on open.
    const synced = document.createElement("p");
    synced.className = "cred-note";
    synced.id = "storage-last-sync";
    syncLine = synced;
    paintSyncLine();
    body.append(synced);

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
          // A HAND FLUSH DOES NOT MOVE `sync.lastFlush` — that field is
          // the SCHEDULER's, deliberately (rpc.ts's `SyncStatus`), so a
          // button press cannot make a stalled schedule look healthy.
          // The line is still repainted, because the poll would repaint
          // it a second later anyway and a receipt that lags its own
          // press reads as a bug.
          void paintSyncLine();
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
      syncLine = null;
      renderUnbound(body, storage);
    };

    // THE STORAGE-REBIND CAVEAT (RECOVERY.md's threat-model deltas, the
    // recorded one): "storage rebind strands kits in the old bucket (K_p
    // and bundle do not migrate). RECORDED CAVEAT: the storage
    // ceremony's copy tells the user to re-mint kits after a destination
    // change; no migration machinery."
    //
    // IT LANDS BESIDE "Change…", WHICH IS THE DESTINATION-CHANGE PATH,
    // and it is stated BEFORE the change rather than announced after:
    // the whole value of the sentence is that it is read by someone
    // deciding, and a kit stranded in a bucket they have just stopped
    // using is discovered at the disaster otherwise.
    const rebindCaveat = document.createElement("div");
    rebindCaveat.className = "hint";
    rebindCaveat.id = "storage-rebind-caveat";
    rebindCaveat.textContent =
      "Changing where this account syncs leaves any recovery kit behind in the old storage — " +
      "kits do not move. Make a new one afterwards.";

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
          // The line goes with the view that owned it: a detached node
          // repainted by the poll would be an invisible timer keeping a
          // status read alive forever.
          syncLine = null;
          renderUnbound(body);
        } catch (e) {
          disconnect.disabled = false;
          problem.textContent = err(e);
          problem.hidden = false;
        }
      })();
    };

    body.append(sync, change, disconnect);

    // THE WAY TO THE RECOVERY KITS, and this is where it belongs.
    //
    // PLACEMENT, JUSTIFIED (the track's one placement call): a kit
    // REQUIRES a bound store — "both kinds still require a bound store
    // at creation (a kit without a bucket restores nothing — content
    // rehydrates from the bucket)" (RECOVERY.md). Hanging the control
    // off the BOUND view makes that precondition structural instead of a
    // refusal: the door only exists where walking it can work. The
    // settings sheet was the alternative and it is the worse one — the
    // control would be present on an unbound device, and the ceremony
    // behind it would exist only to say no.
    //
    // IT SWAPS THIS SHEET'S BODY rather than opening a second drawer
    // tenant. The storage tenant is EXCLUSIVE, so a second sheet could
    // not open over it anyway; and view-swapping is already this sheet's
    // grammar (bound ⇄ unbound ⇄ diverge). The kit ceremony is still in
    // visor pixels, still attached to the pinned strip, still over a
    // dimmed page — which is what the drawer rule is actually about.
    const kits = document.createElement("button");
    kits.type = "button";
    kits.id = "storage-kits";
    kits.textContent = "Recovery kit…";
    kits.onclick = () => {
      body.replaceChildren();
      syncLine = null;
      renderKits(body, storage);
    };
    body.append(kits, rebindCaveat);

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
    // RE-MEASURE, because this view was just swapped in under a height
    // the drawer measured for a DIFFERENT one (the connect form, or the
    // kit list). The drawer animates to a measured pixel target and
    // CLIPS the overflow, so a taller view under a stale height has
    // controls that are on the page and not reachable — a click on one
    // lands on the dim instead, silently. Measured the hard way: the
    // recovery-kit control, appended below the existing three, was
    // clicked by a driver and did nothing at all.
    tenantRebuild();
  };

  // --- recovery kits (runtime/RECOVERY.md, "The kit ceremony") -------------
  //
  // A KIT IS A DEVICE, and that is the round's core ruling rather than
  // an implementation detail: "the kit ceremony mints a dormant member
  // device — a real leaf in the account's delegation graph, visible in
  // the devices sheet under the user's own label, revocable like any
  // device". So this view lists kits the way a devices list lists
  // devices, and its revoke control is the devices sheet's revoke,
  // because it IS the same mechanic — "a leaked phrase or file is
  // answered by revoking the kit device … the same mechanic as a lost
  // phone, because it IS the same thing".
  //
  // WHAT THIS VIEW NEVER DOES: render a phrase twice. The phrase exists
  // in exactly one moment — the tick `createRecoveryKit` resolves — and
  // there is no call that returns it again (client.ts says so). The
  // display-once pane below is that moment; everything after it lists
  // metadata and nothing else.

  /** THE CONFIRM-DISMISS PANE for a freshly minted phrase.
   *
   * NO TIMER, DELIBERATELY, and the reason is the whole design of this
   * pane: a user copying ten words onto paper must not be racing a
   * countdown. A phrase that vanished on a clock would produce exactly
   * one outcome at scale — half-copied phrases, believed to be kits —
   * and a half-copied kit is the "bad kit, quietly" failure the record
   * spends its single-use ruling avoiding. The user says when they have
   * it, and the announcement waits for that word too: announcing before
   * the dismiss would put a sentence on the strip while the secret is
   * still on screen being copied.
   */
  const renderPhraseOnce = (body: HTMLElement, phrase: string, label: string) => {
    const heading = document.createElement("p");
    heading.className = "cred-note";
    heading.textContent = "Write these words down, in this order, and keep them somewhere safe.";

    // VISOR PIXELS, and nothing else on the page ever sees this string:
    // it came back over the port from the ceremony and is written into
    // this node and into no other. It is not persisted, not logged, and
    // there is no call that returns it a second time.
    const words = document.createElement("p");
    words.id = "recovery-phrase";
    words.className = "recovery-phrase";
    words.textContent = phrase;

    const why = document.createElement("div");
    why.className = "hint";
    why.textContent =
      "This is shown once and never again. With these words and access to your storage, " +
      "this account can be brought back on a browser that has never seen it — which is " +
      "also why anyone else who has them can do the same. It works once: restoring uses " +
      "the kit up.";

    const done = document.createElement("button");
    done.type = "button";
    done.id = "recovery-phrase-done";
    done.textContent = "I have written it down";
    done.onclick = () => {
      note("recovery:kit-shown");
      announce(`a recovery kit for this account is ready — you saved it as ${label}`);
      body.replaceChildren();
      renderKits(body, boundStorage!);
    };

    body.append(heading, words, why, done);
  };

  /** The bound destination this kit view was entered from, kept so the
   * display-once pane can hand it back to `renderKits` on dismiss. */
  let boundStorage: StoreBinding | null = null;

  const renderKits = (body: HTMLElement, storage: StoreBinding) => {
    boundStorage = storage;
    const heading = document.createElement("p");
    heading.className = "cred-note";
    // THE HONEST FLOOR, stated where the user is deciding whether to
    // bother (RECOVERY.md, "The claim"): bucket + all devices lost = the
    // account is gone. The kit is the storage's key, not a second copy
    // of the account, and a user who thinks otherwise has been sold the
    // wrong safety.
    heading.textContent =
      "A recovery kit brings this account back on a fresh browser when every device is " +
      "gone. It is a key to your storage, not a copy of your account — if the storage " +
      "goes too, nothing can bring it back.";
    body.append(heading);

    const problem = document.createElement("div");
    problem.className = "hint";
    problem.id = "recovery-problem";
    problem.hidden = true;

    const stepNote = document.createElement("div");
    stepNote.className = "hint";
    stepNote.id = "recovery-step";

    /** The guarantee note a revoke hands back, rendered as prose.
     *
     * PRIORITY OVER THE STATS TICK (the recorded UI finding for
     * `storeRevoke`, whose note this is): the sentence describes what
     * revocation does and does not guarantee, and a stats line
     * repainting over it would replace the one thing the user needs to
     * read with a number they do not. So it lands in its own node, and
     * nothing in this view writes over it.
     */
    const guarantee = document.createElement("p");
    guarantee.className = "cred-note";
    guarantee.id = "recovery-guarantee";
    guarantee.hidden = true;

    const list = document.createElement("div");
    list.id = "recovery-kits";

    /**
     * READ THE ACCOUNT'S KITS FROM OUTSIDE A CHAIN JOB — the ordinary
     * case (a render, a user's click handler).
     *
     * The pair of readers below exists because `enqueue` MUST NOT BE
     * NESTED (see its own note): the chain is one promise, so an
     * `enqueue` issued from inside a running job queues BEHIND that job
     * and can only run once it finishes — while the job is sitting there
     * awaiting it. That is a permanent self-deadlock, and it takes the
     * whole page's serialized chain with it, not just the caller.
     *
     * Making the two readers SEPARATE, NAMED THINGS is the fix rather
     * than a comment on one reader: the question "am I already on the
     * chain?" then has to be answered at every call site, in a word that
     * is visible in the call itself.
     */
    const readKitsQueued = () => enqueue(() => conn.recoveryKits());

    /** THE SAME READ, FROM INSIDE A CHAIN JOB — already serialized by
     * the job that encloses it, so it goes straight to the connection.
     * Wrapping this one in `enqueue` is the deadlock described above. */
    const readKitsInJob = () => conn.recoveryKits();

    /** Repaint the kit list from whichever reader the caller's position
     * on the chain calls for (`readKitsQueued` / `readKitsInJob`).
     *
     * NO RETRY, AND NO GRACE PERIOD. An earlier revision had one, on the
     * theory that a list read in the same breath as a create could beat
     * the record it was reading — the file kind appeared to list nothing
     * while the phrase kind listed correctly. That theory was WRONG and
     * the asymmetry had nothing to do with timing: the phrase kind
     * repaints from the display-once pane's dismiss click (off the
     * chain), the file kind repainted from inside its own mint job (on
     * it), and only the second one nested an `enqueue` and hung. The
     * registry was correct all along and answers immediately. A grace
     * period here would only be a place for the next such bug to hide. */
    const paintList = async (read: () => Promise<RecoveryKit[]>) => {
      let rows: RecoveryKit[];
      try {
        rows = await read();
      } catch (e) {
        list.replaceChildren();
        const oops = document.createElement("div");
        oops.className = "hint";
        oops.textContent = `could not read this account's kits: ${err(e)}`;
        list.append(oops);
        tenantRebuild();
        return;
      }
      list.replaceChildren();
      if (rows.length === 0) {
        const none = document.createElement("div");
        none.className = "hint";
        none.id = "recovery-none";
        // AFTER A RESTORE THIS IS THE TRUE AND LOUD STATE (RECOVERY.md's
        // "honest cost"): a window with no kit until the user mints a
        // fresh one.
        none.textContent = "This account has no recovery kit.";
        list.append(none);
      }
      for (const kit of rows) {
        const row = document.createElement("div");
        row.className = "device-row recovery-row";
        row.dataset.agent = hex(kit.agentId);
        const what = document.createElement("span");
        // USER VOICE would be the kit's label — which this projection
        // does not carry (`RecoveryKit` is {agentId, kind, created}), so
        // the row says what it honestly knows: which kind, and when.
        what.className = "recovery-what";
        what.textContent = kit.kind === "bucket"
          ? "phrase kit, kept in your storage"
          : "file kit, kept by you";
        const when = document.createElement("span");
        when.className = "device-when";
        when.textContent = `created ${new Date(Number(kit.created)).toLocaleString()}`;
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "recovery-revoke";
        revoke.textContent = "Revoke";
        let armed = false;
        revoke.onclick = () => {
          // TWO CLICKS, as the reseal and forget-Google controls take
          // them: revoking a kit is not undoable and the first click
          // says what the second one will do.
          if (!armed) {
            armed = true;
            revoke.textContent = "Yes — revoke this kit";
            tenantRebuild();
            return;
          }
          revoke.disabled = true;
          problem.hidden = true;
          void enqueue(async () => {
            try {
              const guaranteeNote = await conn.revokeRecoveryKit(kit.agentId);
              note("recovery:kit-revoked");
              guarantee.textContent = guaranteeNote;
              guarantee.hidden = false;
              announce("that recovery kit is revoked — it cannot restore this account any more");
              // IN-JOB READER: this whole handler is one chain job (the
              // revoke and the repaint belong together — a list that
              // still showed the kit would be the sheet contradicting
              // the guarantee note it just rendered), so the read must
              // NOT re-enter `enqueue`.
              await paintList(readKitsInJob);
            } catch (e) {
              revoke.disabled = false;
              armed = false;
              revoke.textContent = "Revoke";
              problem.textContent = err(e);
              problem.hidden = false;
            }
            tenantRebuild();
          });
        };
        row.append(what, when, revoke);
        list.append(row);
      }
      tenantRebuild();
    };

    body.append(list);
    // OFF-CHAIN READER: a render is not inside a job, so this one takes
    // its turn on the chain like any other caller.
    void paintList(readKitsQueued);

    // --- minting a new one --------------------------------------------------
    //
    // BUCKET KITS ARE S3-ONLY AT THIS REV (RECOVERY.md, settled in T-A):
    // the bucket kind needs an owner-tier PUT at a NAME the guest
    // derives, and only S3 addresses objects by name. So on a
    // Drive-bound account the phrase kind is not offered at all — and
    // the sheet says why in one plain sentence rather than offering a
    // control that would be refused by name a moment later.
    const bucketKitsPossible = storage.kind === "s3";
    let mintKind: "bucket" | "file" = bucketKitsPossible ? "bucket" : "file";

    const kindField = credField("What kind of kit?");
    if (bucketKitsPossible) {
      for (
        const k of [
          {
            value: "bucket" as const,
            id: "recovery-kind-bucket",
            label: "A phrase kit — ten words you write down; the kit itself lives in your bucket",
          },
          {
            value: "file" as const,
            id: "recovery-kind-file",
            label: "A file kit — a file you keep, opened by a passphrase you choose",
          },
        ]
      ) {
        const line = document.createElement("div");
        line.className = "cred-field";
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "recovery-kind";
        radio.id = k.id;
        radio.value = k.value;
        radio.checked = k.value === mintKind;
        radio.onchange = () => {
          mintKind = k.value;
          fileFields.hidden = mintKind !== "file";
          tenantRebuild();
        };
        label.append(radio, document.createTextNode(` ${k.label}`));
        line.append(label);
        kindField.append(line);
      }
    } else {
      const only = document.createElement("div");
      only.className = "hint";
      only.id = "recovery-file-only";
      // ONE PLAIN SENTENCE, and it names the cause rather than the
      // mechanism: the user does not need "objects addressed by name" to
      // understand which kind they are getting.
      only.textContent =
        "This account syncs through Google Drive, where a kit cannot be filed under a name " +
        "the phrase alone would find. So this is a file kit: you keep the file.";
      kindField.append(only);
    }
    body.append(kindField);

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.id = "recovery-label";
    labelInput.autocomplete = "off";
    labelInput.value = "recovery kit";
    const labelField = credField(
      "Call this kit",
      "It is a device in your account, and this is the name it wears there.",
    );
    labelField.append(labelInput);
    body.append(labelField);

    // --- the file kind's passphrase, and the loud warning -------------------
    const fileFields = document.createElement("div");
    fileFields.hidden = mintKind !== "file";

    // THE OWNER'S AMENDMENT, RENDERED (RECOVERY.md: "disallowing custody
    // would be paternalism, so the ceremony WARNS LOUDLY instead"). All
    // three of the record's sentences are here, and none of them is
    // softened:
    //
    //   1. the passphrase's strength is the USER'S OWN — and the visor
    //      says so plainly instead of measuring it. A strength meter
    //      would be the visor pretending to a judgement it cannot make
    //      and, worse, would launder a weak choice into an approved one.
    //   2. the file plus its passphrase open the WHOLE account.
    //   3. the file is dead the day it is used or its device revoked.
    const warn = document.createElement("div");
    warn.id = "recovery-file-warning";
    warn.className = "entry-problem recovery-warning";
    warn.textContent =
      "Read this before you choose a passphrase. This file and its passphrase together open " +
      "your whole account — everything in it, and the ability to write to it. How hard that " +
      "passphrase is to guess is entirely your choice: this app does not judge it, does not " +
      "measure it, and cannot protect you from a weak one. A file that is easy to open is an " +
      "account that is easy to take. The file dies the day it is used, or the day you revoke " +
      "it here — nothing else retires it.";
    fileFields.append(warn);

    const kitPass = document.createElement("input");
    kitPass.type = MASKED.type;
    kitPass.id = "recovery-file-pass";
    kitPass.autocomplete = "off";
    const kitPassField = credField("A passphrase for this file");
    kitPassField.append(kitPass);
    const kitPass2 = document.createElement("input");
    kitPass2.type = MASKED.type;
    kitPass2.id = "recovery-file-pass2";
    kitPass2.autocomplete = "off";
    // THE CONFIRM FIELD, and it is not ceremony here: a mistyped
    // passphrase on a file kit is undiscoverable until the disaster,
    // because nothing ever asks for it again until then.
    const kitPass2Field = credField("And again, to be sure");
    kitPass2Field.append(kitPass2);
    fileFields.append(kitPassField, kitPass2Field);
    body.append(fileFields);

    const make = document.createElement("button");
    make.type = "button";
    make.id = "recovery-make";
    make.textContent = "Make a recovery kit";
    make.onclick = () => {
      if (make.disabled) return;
      const kind = mintKind;
      const label = labelInput.value.trim() === "" ? "recovery kit" : labelInput.value.trim();
      // THE ONE MOMENT OF CLEARTEXT, as everywhere else on this page.
      const pass = kitPass.value;
      const pass2 = kitPass2.value;
      kitPass.value = "";
      kitPass2.value = "";
      problem.hidden = true;

      if (kind === "file") {
        if (pass === "") {
          problem.textContent = "choose a passphrase for this file";
          problem.hidden = false;
          tenantRebuild();
          return;
        }
        if (pass !== pass2) {
          problem.textContent = "those two did not match — try again";
          problem.hidden = false;
          tenantRebuild();
          return;
        }
      }

      make.disabled = true;
      stepNote.textContent = "making your recovery kit…";
      tenantRebuild();
      void enqueue(async () => {
        try {
          const result = kind === "bucket"
            ? await conn.createRecoveryKit({ kind: "bucket", label })
            : await conn.createRecoveryKit({ kind: "file", label, passphrase: pass });
          note("recovery:kit-created");
          stepNote.textContent = "";
          if (result.kind === "bucket") {
            // DISPLAY ONCE, with the confirm-dismiss — see
            // `renderPhraseOnce`. The announcement waits for the
            // dismiss, deliberately.
            body.replaceChildren();
            renderPhraseOnce(body, result.phrase, label);
            tenantRebuild();
            return;
          }
          // THE FILE, DELIVERED AS A DOWNLOAD. A blob URL from this
          // sheet's own button: the bytes came over the port, are
          // written to no storage on the way past, and the object URL is
          // revoked as soon as the click has been taken.
          //
          // A VISOR-VOICED FILENAME — the user's label plus the date, so
          // a folder full of downloads still says which account and
          // which day this one is.
          const stampDate = new Date().toISOString().slice(0, 10);
          const safe = label.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-") ||
            "recovery-kit";
          const blob = new Blob([result.bundle as BlobPart], {
            type: "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${safe}-${stampDate}.polyvisor-kit`;
          a.id = "recovery-download";
          a.textContent = "Download your recovery file";
          body.append(a);
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          note("recovery:kit-downloaded");
          announce(
            "your recovery file is downloaded — keep it somewhere its passphrase is not " +
              "written down beside it",
          );
          // IN-JOB READER, for the reason spelled out on the readers
          // above: this repaint runs inside the mint's own chain job.
          // Re-entering `enqueue` here is what wedged the page — the
          // read queued behind the very job that was awaiting it, so the
          // list never painted AND every later call on the chain (the
          // event drain, every driver call) queued behind a promise that
          // would never settle.
          await paintList(readKitsInJob);
          // THE CEREMONY REOPENS. Unlike the phrase kind, which leaves
          // for its display-once pane, the file kind finishes with the
          // user still on this sheet — and an account may legitimately
          // want a second kit (a kit per place the user keeps one). A
          // control left dead would make the sheet a dead end reachable
          // only by navigating out and back.
          //
          // A DOUBLE-CLICK CANNOT MINT TWICE BY ACCIDENT: the
          // passphrase fields were cleared in the same tick the first
          // mint read them, so a stray second press meets the ceremony's
          // own "choose a passphrase" refusal rather than minting a kit
          // nobody asked for.
          make.disabled = false;
        } catch (e) {
          make.disabled = false;
          stepNote.textContent = "";
          problem.textContent = err(e);
          problem.hidden = false;
          tenantRebuild();
        }
      });
    };

    const back = document.createElement("button");
    back.type = "button";
    back.id = "recovery-back";
    back.className = "hint";
    back.textContent = "back to storage";
    back.onclick = () => {
      body.replaceChildren();
      renderBound(body, storage);
      tenantRebuild();
    };

    body.append(make, guarantee, stepNote, problem, back);
    tenantRebuild();
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

  /** KEEP THE ACCOUNT'S DEVICE DIRECTORY HONEST — the backstop the whole
   * resume path stands on.
   *
   * The devices map is not just a roster any more: each entry carries
   * the device's iroh ENDPOINT ID, which is the only way one device of
   * an account can find another after both have been closed and
   * reopened. The adder writes the joiner's endpoint at enrollment (from
   * an id it observed on the wire, which is why it is trustworthy), and
   * `user-create` writes the founder's own — so in the ordinary case the
   * directory is already right and this call authors nothing.
   *
   * It is called anyway, on every boot that has both an endpoint and an
   * account, because "already right" is a claim about a past that may
   * have contained an older engine, a failed bind, or an entry written
   * before the field existed. The engine compares before it writes
   * (usdoc.rs's `device_endpoint_put`: "THE NO-OP IS THE CONTRACT"), so
   * the cost of being sure is one read.
   *
   * IT DOES NOT CREATE A MISSING ENTRY, and that is the engine's rule
   * rather than this page's choice: a device whose entry has not synced
   * yet would be racing the adder's enrollment write, and the loser of
   * that automerge conflict loses the name the write carried. The next
   * boot finds the entry.
   *
   * THE RAW DRIVER: `us-device-endpoint-put` is transport bookkeeping,
   * not something the visor's contract has any business carrying. */
  const recordMyEndpoint = async () => {
    if (!myEndpoint) return;
    try {
      await enqueue(() => driver.usDeviceEndpointPut(myEndpoint as Uint8Array));
    } catch (e) {
      // NOT ANNOUNCED. A directory this device could not update is a
      // reachability problem for a FUTURE boot, not something the user
      // can act on now, and the account still works in every other way.
      console.warn(`[solo] could not record this device's endpoint: ${err(e)}`);
    }
  };

  /** Subscribe to `tree` with `peer`, both directions being the caller's
   * to arrange. `subscribe` is what makes a LATER write push rather than
   * wait for a poll. */
  const subscribe = async (peer: Uint8Array, tree: Uint8Array, what: string) => {
    const h = await driver.syncStart(peer, tree, true);
    await until(`subscribed to ${what}`, () => driver.syncStatus(h), 30_000);
  };

  /** READER DIALS, and this is the only place on this page that opens a
   * connection as the initiator. Both the ceremony's joiner and a
   * RESUMED boot's reader come through here, so the direction rule above
   * is stated once and obeyed twice.
   *
   * `usPartition` is the CEREMONY path's extra. At enrollment time the
   * joiner has the account doc's id in hand (the enrollment carries it)
   * and subscribes it explicitly, because nothing else will: the two
   * sides have only just met. A RESUMED boot passes nothing, and that is
   * not an omission — the doc's id is deliberately absent from the
   * `us-*` surface, and the engine subscribes the us doc to every known
   * peer itself on every pump (usdoc.rs's `ensure_subscriptions`:
   * "Engine-driven because `us-*` hides doc identity by design"). By
   * resume time the peer is known, so the engine does it. */
  const dialPeer = async (
    peer: Uint8Array,
    peerEndpoint: Uint8Array,
    usPartition?: Uint8Array,
  ) => {
    await enqueue(async () => {
      const conn2 = await driver.irohStart(true, peerEndpoint, RELAY, peer);
      await until("the other device answers", () => driver.connStatus(conn2), 30_000);
      if (usPartition) await subscribe(peer, usPartition, "your account");
    });
  };

  /** The account's todo list, as the account's own pointer map names it
   * (#36) — the only channel either side has for it.
   *
   * THE RAW DRIVER, and for the same reason the peer ids are read raw:
   * `us-partitions` is not on the visor's `PairingDriver` contract and
   * must not be added to it. Which partition an app is mounted on is the
   * embedder's concern; the trusted surface has no use for a partition
   * id and no business holding one. */
  const awaitTasksPointer = async (what: string, timeoutMs: number) => {
    const pointer = await until(what, async () => {
      const list = await enqueue(() => driver.usPartitions());
      return list.find((p) => p.name === TASKS_POINTER) ?? false;
    }, timeoutMs, 250);
    return pointer.id;
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
      // READER DIALS — and the account doc goes with the dial, because
      // the two sides have only just met (see `dialPeer`).
      await dialPeer(peer, enrollment.peerEndpointId, enrollment.partitionId);
      const tasksId = await awaitTasksPointer("your account's todo list", 60_000);
      await enqueue(async () => {
        await driver.adoptPartition(tasksId);
        await subscribe(peer, tasksId, "your todo list");
      });
      usSynced = true;
      console.log("[solo] subduction wired: this device ⇄ the device that added it");
      // THE ADOPTION BEAT, at the only honest moment for it. The join
      // pane's tick fired this wiring on the enrollment edge, when the
      // adopted us doc was still empty; the account's actual document
      // arrived over the subscription above — the tasks pointer this
      // function waited on IS us-doc content, so its arrival is the
      // proof. Only now is there a name and a colour to take.
      //
      // `reconcileFromDriver` refreshes the boot cache and announces any
      // cache diff; on a device joining for the first time the cache is
      // empty, so it says nothing and the line below is the only one the
      // user hears. The two do not double-speak.
      await reconcileFromDriver(us, US_CACHE_KEYS, announce, applyProfile, applyMarks);
      const adopted = await us.usProfileGet();
      if (adopted.ok) {
        // THE ADOPTION ANNOUNCEMENT (PAIRING.md §5): a remotely-caused
        // identity change is announced, never silent. Once, here.
        status(
          `this device now follows your account: ${adopted.value.displayName || "(unnamed)"}`,
        );
      }
      await mountApp();
      // DIRECTORY UPKEEP, at the first moment this device has an account
      // to keep it in — see `recordMyEndpoint`. The adder already wrote
      // this device's endpoint from the id it observed on the wire, so
      // this call is almost always the engine's own no-op; it is here so
      // that "every device with an endpoint and an account has said so"
      // holds without a case analysis.
      await recordMyEndpoint();
    } catch (e) {
      if (joinAttempts < WIRE_ATTEMPTS) joinWired = false;
      else announce(`could not sync this device with your account: ${err(e)}`, true);
      console.warn(`[solo] post-enrollment wiring failed (attempt ${joinAttempts}): ${err(e)}`);
    }
  };

  /** THE ADOPTION BEAT, silent half: this device takes the account's
   * colour and name. The visor UI reports the value; painting is the
   * consumer's job — so this is the consumer's half, and it lives here
   * rather than in the join pane because only this file knows WHEN the
   * account's document has actually arrived.
   *
   * DIRECTION IS ACCOUNT → VISOR, and only at three moments: the join
   * beat, a resumed boot, and a `profile-changed` event drained off the
   * account. The opposite direction is the settings write-through
   * (`onIdentityCommitted` above), which is the only writer going
   * visor → account. Adding a fourth caller here would be inventing a
   * second writer of the strip and racing the user's own edit.
   *
   * SILENT ON PURPOSE — the announcement is the caller's, because what
   * there is to say differs by moment: the join beat says this device
   * has taken the account's identity, a resumed boot's diff is announced
   * by `reconcileFromDriver` itself, and a remote change was already
   * announced by the drain that noticed it. §5's announced-never-silent
   * is kept by every one of the three, not by this function. */
  const applyProfile = (profile: UsProfile) => {
    const angle = VISOR_HUES[profile.hue] ?? VISOR_HUES[0];
    visor.commitHue(angle);
    const rec = visor.identity();
    const next = { ...rec };
    if (profile.displayName) next.name = profile.displayName;
    // THE GLYPH, decoded from the account's bytes and then VETTED. It
    // was written by another device — possibly a different visor build,
    // with a vocabulary this one does not have — so it passes the same
    // membership test `loadIdentity` applies to hand-editable storage
    // (visor.ts's VISOR_ICONS: the bidi/ZWJ/confusable firewall) before
    // it can reach the one position on the strip that is supposed to be
    // unspoofable. `saveIdentity` would refuse an outsider anyway; the
    // check is here so a refusal does not silently DROP the glyph this
    // device already wears.
    //
    // ABSENT OR INVALID MEANS "NOTHING TO SAY", never "clear it": an
    // account that has never carried an icon must not undress a device
    // whose user picked one locally.
    const glyph = decodeUserIcon(profile.icon);
    if (glyph) next.icon = glyph;
    visor.saveIdentity(next);
    visor.renderIdentity();
  };

  /** THE ACCOUNT'S MARKS, adopted into THIS device's trust table — the
   * inbound half of `onNamed`'s write-through, at the same three moments
   * `applyProfile` runs at (the join beat, a resumed boot, a mark event
   * drained off the account).
   *
   * WHAT MAY BE ADOPTED, and why it is narrower than the list
   * (PAIRING.md §5 and its repaired-view rule): `us-marks-list` returns
   * the REPAIRED view, not the raw records — the engine has already run
   * petname- and icon-uniqueness repair over the doc, and a record that
   * LOST is handed out with `needs-reconfirm` set and, for an icon
   * collision, with its icon cleared to "". Such a record is not a name
   * this device may start speaking in the visor's own voice: the
   * contract is that it renders NEW-with-explanation and the USER
   * re-confirms it through the naming ceremony (which is also where a
   * cleared icon gets re-picked, since the vocabulary is the visor's and
   * the engine cannot choose a replacement). So only WHOLE marks are
   * seeded — petname and icon both non-empty, `needsReconfirm` false —
   * and everything else is left for the ceremony. Note that "" icon
   * implies `needs-reconfirm` engine-side anyway; both are tested
   * because the contract states both, not because either is redundant.
   *
   * DELETIONS ARE OUT OF SCOPE. There is no mark-forgotten event to
   * drain, so a mark forgotten on another device stays in this device's
   * table until it is forgotten here too. That is a gap, not a decision
   * hidden in an omission — it needs an event before it can be closed.
   *
   * SILENT, like `applyProfile`: the drain has already announced the
   * event, and the join beat has its own sentence. */
  const applyMarks = (marks: UsMark[]) => {
    for (const m of marks) {
      if (m.needsReconfirm) continue;
      const petname = m.petname.trim();
      if (petname === "" || m.icon === "") continue;
      // `setPetname` is the same call the ceremony makes, and it applies
      // its own write-side vocabulary gate to the glyph.
      sheets.marks.setPetname(m.provenance, petname, m.icon);
      // AND THE LIVE SURFACE, exactly as `onNamed` refreshes it locally:
      // a table seeded under a mounted app would otherwise leave the
      // strip calling the surface NEW while the record says otherwise.
      if (appSlot.surface && appSlot.surface.name === m.provenance) {
        appSlot.surface = { ...appSlot.surface, petname, icon: m.icon, isNew: false };
        visor.renderContext();
      }
    }
  };

  // --- role: the ADDER (this page already has the account) -----------------

  let addTicker = 0;
  let acceptorPosted = false;
  let acceptorConn: number | null = null;
  let adderWired = false;
  let adderAttempts = 0;

  /** WRITER ACCEPTS: no peer, no expectation — this side answers
   * whoever it granted, or whoever it once granted and is now coming
   * back. Idempotent, because both the add ceremony and a resumed boot
   * want it up and a second listener on one endpoint would be a second
   * answer to the same dial. */
  const postAcceptor = async () => {
    if (acceptorPosted) return;
    acceptorPosted = true;
    try {
      acceptorConn = await enqueue(() =>
        driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array())
      );
    } catch (e) {
      // The flag goes back down so the next caller can try again: a
      // posted-but-failed acceptor is the silent failure this whole
      // section exists to avoid.
      acceptorPosted = false;
      throw e;
    }
  };

  /** THIS PAGE'S OWN ENDPOINT DIED — which is what a `Closed` error out
   * of a dial or an acceptor means, and it is sticky by design: iroh's
   * home relay does not come back on its own, so every later call
   * against that endpoint fails the same way. There is nothing to do but
   * bind again.
   *
   * IT IS SAFE TO REBIND ONLY BECAUSE THE IDENTITY IS STABLE. The
   * endpoint key pair is held by the device
   * (engine.wit's `device-identity.endpoint-key-pair`), so a rebind
   * mints the SAME endpoint id — the address the account's directory
   * records, and the one the other device is dialling. Before that key
   * was persisted this recovery would have silently moved this device,
   * which is worse than staying broken.
   *
   * CONTRACT: `Closed` is matched capitalised, on the word. The
   * lower-case "the peer closed the pairing stream" is a DIFFERENT
   * fact — the far end going away, which is a thing to retry, not a
   * reason to tear down this device's transport. */
  const isEndpointClosed = (e: unknown) => /\bClosed\b/.test(err(e));

  const rebindEndpoint = async () => {
    const id = unhex(await enqueue(() => driver.irohBind(RELAY)));
    myEndpoint = id;
    console.warn(`[solo] endpoint was closed; rebound the same address ${hex(id).slice(0, 8)}…`);
    // The old acceptor went down with the endpoint, so the flag has to
    // as well — otherwise this device would look like it was listening
    // while nothing was.
    acceptorPosted = false;
    acceptorConn = null;
    await postAcceptor();
  };

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
      await postAcceptor();
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

  // --- role: a RESUMED BOOT (the account is already here) ------------------
  //
  // THE GAP THIS CLOSES, stated plainly: the two roles above are
  // CEREMONY roles. They run once, on the edge of an enrollment, and
  // everything they know — who the peer is, where to dial it — came out
  // of a ceremony that is over. So a page that reloads afterwards wires
  // nothing, and once BOTH devices have reloaded there is no connection
  // between them at all: edits stop crossing, and neither page has any
  // symptom to show for it. Silence again, which is the failure mode
  // this whole file keeps writing down.
  //
  // WHAT REPLACES THE CEREMONY'S KNOWLEDGE is the account's own device
  // directory. Each entry now carries an ENDPOINT (where that device
  // can be dialled) and an ENROLLED-BY (which device let it in), so the
  // enrollment tree survives in the one place both devices already
  // agree about — and a resumed boot can read its own role out of it
  // instead of remembering one.
  //
  // THE ROLE IS THE SAME ROLE, and it must be: reversing the direction
  // is the healthy-looking silence #78 is about. So this side re-enacts
  // exactly what it did at ceremony time —
  //
  //   * MY ENROLLER, if I have one, is who I DIALLED then; I dial it
  //     again. (READER DIALS.)
  //   * MY CHILDREN — the devices whose `enrolled-by` is me — dialled
  //     ME; I ACCEPT again, and subscribe them once their dial lands.
  //     (WRITER ACCEPTS.)
  //
  // The acceptor goes up UNCONDITIONALLY and first, for the same reason
  // adderWire posts it before it waits for anything: a listener that
  // arrives after the dial is a dial into nothing. Every device may have
  // enrolled someone, and posting it costs one call.
  //
  // AND IT IS PATIENT RATHER THAN PERSISTENT-UNTIL-IT-GIVES-UP. The
  // ceremony's bounded three attempts are right for a ceremony: the user
  // is watching, the other device is on the desk, and a failure is
  // something to report while they can still act on it. Here the other
  // device may be shut, on a train, or opened tomorrow — so the retry
  // runs for as long as the page lives, and says so ONCE. A line per
  // attempt would be a page shouting a fact that has not changed.

  // AND WHAT THIS DOES NOT RECOVER, written down because the shape of
  // the gap is not obvious and the workaround for it would be worse.
  //
  // Only ONE side reloading is NOT recovered, when the side that
  // reloaded is the one that ACCEPTS. Its own resume posts an acceptor
  // and waits, correctly; but its peer — the reader — still holds a
  // connection handle from before, and has no way to learn that the
  // thing on the other end of it is gone. `conn-status` reports the
  // outcome of the HANDSHAKE and is never invalidated afterwards
  // (engine/guest/src/lib.rs:3700 writes it once; :3706-3713 reads it
  // back forever), and `sync-status` is one-shot per round rather than a
  // subscription's health. So the reader has no evidence of staleness at
  // all, and the only "fix" available to this file would be to re-dial
  // on a timer — a second connection and a second set of subductions for
  // the same pair, which is precisely the double-dialling the direction
  // discipline exists to prevent.
  //
  // The both-sides case, which is the ordinary one (a user closes their
  // laptop, then their phone), IS recovered: both readers come back with
  // no handle to be misled by, and dial.
  //
  // The honest fix belongs in the engine — a `conn-status` that goes
  // false when the connection drops — and until it exists this page
  // cannot tell the difference between a healthy peer and a departed
  // one.

  /** Slow on purpose: the thing being waited for is another human
   * opening a browser. */
  const RESUME_TICK_MS = 5_000;
  /** Ten minutes, and it is a wait for a PERSON, not for a wire. */
  const RESUME_POINTER_MS = 600_000;

  let resumeWired = false;

  /** Wire a device that already holds the account.
   *
   * `needsTasks` is the un-dead-end: an account whose todo-list pointer
   * has not reached this device yet. That used to park the page on "this
   * account has no todo list yet" — a sentence that describes a
   * PERMANENT state and was being said about a temporary one. The
   * pointer is us-doc content, so it arrives exactly when the wire below
   * comes up; the page waits for it instead of concluding from it. */
  const resumeWire = async (needsTasks: boolean) => {
    if (resumeWired) return;
    resumeWired = true;

    const st = await conn.status();
    // Hex both ways, lower-cased at the boundary: the worker's `meta`
    // copy and the directory's keys are both written by `hex()`
    // (runtime/engine.ts), so this is belt-and-braces rather than a
    // known mismatch — and a silent no-match here would be the page
    // deciding it has no role in its own account.
    const me = (st.agentId ?? "").toLowerCase();
    if (!me) {
      console.warn("[solo] resume wiring: this device has no recorded agent id");
      return;
    }

    let announced = false;
    const sayWaiting = () => {
      if (announced) return;
      announced = true;
      status("waiting for your other device…");
    };

    /** Dialled at most once — a second dial to the same peer is a second
     * connection carrying the same subscriptions. */
    let dialled = false;
    /** Which peers this device has already subscribed the todo list to.
     * Keyed by agent id, hex. */
    const tasksWired = new Set<string>();
    /** Whether the tasks partition is this device's to read. False only
     * on the `needsTasks` path, until the pointer arrives and the
     * adoption below runs. */
    let tasksHeld = !needsTasks;

    /** Subscribe the account's todo list to one peer.
     *
     * ONLY THE TASKS PARTITION, because only it needs asking: the engine
     * subscribes the us doc to every known peer itself on every pump
     * (usdoc.rs's `ensure_subscriptions`), and it has no name for this
     * one. Same division of labour as adderWire's. */
    const wireTasks = async (peerHex: string) => {
      if (!tasksHeld || tasksWired.has(peerHex)) return;
      const list = await enqueue(() => driver.usPartitions());
      const part = list.find((p) => p.name === TASKS_POINTER);
      if (!part) return;
      tasksWired.add(peerHex);
      try {
        await enqueue(() => subscribe(unhex(peerHex), part.id, "your todo list"));
        usSynced = true;
        console.log(`[solo] subduction re-wired: this device ⇄ ${peerHex.slice(0, 8)}…`);
      } catch (e) {
        // Back out of the set: a subscription that did not take must be
        // retried, or this device is silently unsubscribed for ever.
        tasksWired.delete(peerHex);
        throw e;
      }
    };

    // THE POINTER ARM, when this device has no todo list yet. It runs
    // alongside the retry loop rather than inside it: the loop's job is
    // the wire, and this is what the wire is FOR.
    if (needsTasks) {
      sayWaiting();
      say("waiting for your other device…");
      void (async () => {
        try {
          const tasksId = await awaitTasksPointer(
            "your account's todo list",
            RESUME_POINTER_MS,
          );
          // CONTRACT: `adopt-partition` REPLACES whatever this device
          // held for that id with an empty document
          // (engine/guest/src/lib.rs:3804), so it is called only on the
          // path where this device demonstrably held nothing — the
          // pointer was absent at boot and has only just arrived. A
          // resumed device that already had the partition gets it back
          // from its checkpoint and must never be re-adopted.
          await enqueue(() => driver.adoptPartition(tasksId));
          tasksHeld = true;
          await reconcileFromDriver(us, US_CACHE_KEYS, announce, applyProfile, applyMarks);
          await mountApp();
        } catch (e) {
          announce(`could not open your account's todo list: ${err(e)}`, true);
          console.warn(`[solo] resume: the tasks pointer never arrived: ${err(e)}`);
        }
      })();
    }

    /** One attempt at everything, run again every `RESUME_TICK_MS`. Each
     * step guards itself, so a tick that achieves half the wiring keeps
     * the half it got. */
    const tick = async () => {
      // AT MOST ONE REBIND PER TICK. `Closed` is sticky, so an
      // unguarded rebind-on-error would be a rebind storm: every failing
      // call in this function would mint a fresh endpoint for the next
      // one to fail against.
      let rebound = false;
      const onError = async (e: unknown, what: string) => {
        console.warn(`[solo] resume ${what}: ${err(e)}`);
        if (rebound || !isEndpointClosed(e)) return;
        rebound = true;
        try {
          await rebindEndpoint();
        } catch (e2) {
          console.warn(`[solo] resume: rebinding the endpoint failed: ${err(e2)}`);
        }
      };

      // WRITER ACCEPTS, first and always — see the section note.
      try {
        await postAcceptor();
      } catch (e) {
        await onError(e, "acceptor");
      }

      const res = await us.usDevicesList();
      if (!res.ok) return;
      const devices = res.value;
      const mine = devices.find((d) => d.agentId.toLowerCase() === me);

      // READER DIALS: my enroller is the device I dialled at ceremony
      // time, and an empty `enrolled-by` means I am the founding device
      // and never dialled anyone.
      if (!dialled && mine && mine.enrolledBy !== "") {
        const enroller = devices.find(
          (d) => d.agentId.toLowerCase() === mine.enrolledBy.toLowerCase(),
        );
        // An entry with no endpoint is the directory saying "not
        // observed" (engine.wit's `us-device`), and there is nothing
        // honest to dial with. It may be filled in by that device's own
        // boot-time upkeep, so this keeps looking rather than failing.
        if (enroller && !enroller.revoked && enroller.endpoint !== "") {
          sayWaiting();
          try {
            await dialPeer(unhex(enroller.agentId), unhex(enroller.endpoint));
            dialled = true;
          } catch (e) {
            await onError(e, "dial");
          }
        }
      }
      if (dialled && mine) {
        try {
          await wireTasks(mine.enrolledBy.toLowerCase());
        } catch (e) {
          await onError(e, "subscribe (enroller)");
        }
      }

      // MY CHILDREN dialled me, so this side waits for the dial to LAND
      // before subscribing. adderWire's reasoning applies unchanged: a
      // `sync-start` against a peer this side has no connection to
      // reports a healthy handle and delivers nothing — the same silent
      // shape as the reversed-direction bug (#78). The difference from
      // adderWire is only that this is a POLL rather than an `until`:
      // the tick is already the waiting loop.
      const children = devices.filter(
        (d) => !d.revoked && d.enrolledBy !== "" && d.enrolledBy.toLowerCase() === me,
      );
      if (children.length > 0 && acceptorConn !== null) {
        sayWaiting();
        let connected = false;
        try {
          connected = Boolean(await driver.connStatus(acceptorConn));
        } catch (e) {
          await onError(e, "acceptor status");
        }
        if (connected) {
          for (const child of children) {
            try {
              await wireTasks(child.agentId.toLowerCase());
            } catch (e) {
              await onError(e, "subscribe (child)");
            }
          }
        }
      }
    };

    // NOT `until`, and not a bounded count. `poll` skips a tick whose
    // predecessor is still running, which is exactly right here: a dial
    // has its own 30s deadline inside it, and overlapping attempts would
    // be several endpoints racing to reach one peer.
    void tick();
    poll(RESUME_TICK_MS, tick);
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
    // THE FORK'S THIRD CHOICE — the recovery door on the surface a
    // VIRGIN BROWSER actually lands on (entry.ts's `FirstRunHost.restore`
    // carries the reasoning; in short, a browser with no devices never
    // sees the picker, and that is precisely the browser a real recovery
    // happens on).
    //
    // THIS ARM RELOADS, and the picker's does not. The difference is
    // forced and worth stating: by the time the fork is on screen,
    // `startApp` has ALREADY claimed the visor for the device that has
    // no account — a colour is painted, a name may be. Restoring from
    // here therefore cannot end with "the visor claims at the end",
    // because the claim is behind us. A reload is the honest way back to
    // the record's ordering: the restored device is anchored to this
    // tab, so the next boot resumes it through `resolveDevice`'s anchor
    // arm and claims from the profile the restore pulled — the same
    // machinery, reached from the top.
    //
    // The device this fork belonged to is left in the index rather than
    // swept: it is an account-less T0 device, which is exactly what the
    // sweep already exists to collect, and destroying a namespace out
    // from under a live worker on the way to a reload buys nothing.
    restore: () => {
      status("restoring from your recovery kit…");
      note("first-run:restore");
      return new Promise<void>((settle) => {
        mountRestore(visor, {
          onRestored: (_conn, consumePending) => {
            note("restored");
            // ACROSS THE RELOAD: a module variable cannot survive one,
            // so the sentence rides sessionStorage and `startApp` drains
            // it just after the claim on the other side.
            try {
              sessionStorage.setItem(RESTORE_NOTE_KEY, consumedKitSentence(consumePending));
            } catch { /* a storage-less browser loses the sentence, not the account */ }
            settle();
            location.reload();
          },
          onAbandoned: () => {
            // BACK TO THE FORK: an abandoned ceremony must land on a
            // surface with something to do on it, and for an
            // account-less device that surface is the fork.
            status("ready");
            settle();
            entry = offerFirstRun(visor, us, announce, firstRunHost);
          },
        });
      });
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
    // WITH `applyProfile`: a resumed boot repaints from the ACCOUNT, not
    // from the device-local cache the strip drew at boot — the cache is
    // a first-paint convenience, not the source of truth. Reconcile
    // announces any diff it finds, which is the announcement this moment
    // owes; there is no adoption fanfare on a device that already
    // belongs to the account.
    await reconcileFromDriver(us, US_CACHE_KEYS, announce, applyProfile, applyMarks);
    // THE DIRECTORY, BEFORE ANYTHING WAITS ON IT. This device's own
    // entry is what the account's OTHER devices dial, so it is refreshed
    // at the top of the resumed boot rather than after the wiring that
    // depends on the symmetric fact being true over there.
    await recordMyEndpoint();
    const parts = await enqueue(() => driver.usPartitions());
    const tasksPart = parts.find((p) => p.name === TASKS_POINTER);
    if (tasksPart) {
      // THE APP FIRST, THE WIRE IN THE BACKGROUND. Everything this
      // device needs to show the user is already on disk; making them
      // watch a spinner while a peer that may be switched off is dialled
      // would be the page confusing "not yet in sync" with "not yet
      // usable".
      await mountApp();
      void resumeWire(false);
    } else {
      // NOT A DEAD END ANY MORE. An account with no todo list is still
      // not a first run — offering to create a SECOND account here would
      // be the page guessing at a state it does not understand — but nor
      // is it a state to park in. The pointer lives in the account's own
      // document, so it arrives when the wire does; `resumeWire` says so
      // on screen, waits, adopts, and mounts.
      void resumeWire(true);
    }
  } else {
    note("account:none");
    // THE FORK, AS A VISOR DRAWER SHEET (visor/ui/entry.ts). It carries
    // the join pane with it, which is why the handle comes back here:
    // the pane's tick is one driver read and the wiring it triggers is
    // entirely this file's business.
    entry = offerFirstRun(visor, us, announce, firstRunHost);
    say("ready — no account on this device yet");
  }

  // The join pane's tick is one driver read; its `true` is the
  // JOIN-COMPLETED edge, which is where the embedder owes the pair a
  // sync path. NULL-GUARDED: the pane exists only while the fork sheet
  // does, and a device that already holds an account never has one.
  poll(250, async () => {
    if (await entry?.joinHandle.tick()) void joinerWire();
  });
  // Remotely-caused identity changes are announced, never silent — and
  // then ADOPTED, which is the other half. The drain has already spoken
  // the event; a `profile-changed` in the batch means the account's name
  // or colour moved under this device, so the strip is repainted from
  // the account rather than left stale behind a sentence describing a
  // change the user cannot see.
  //
  // ONE FUNCTION, TWO CALLERS, and that is not tidiness. `usEvents` is a
  // DRAIN: it hands each event out exactly once, so whoever calls it
  // owns what the event meant. The driving hook below used to call it on
  // its own and then throw the batch away — which meant a scenario
  // ticking the page faster than this timer could swallow the one
  // `profile-changed` the timer existed to act on, and the strip would
  // stay stale for a reason nothing on the page could report. Any future
  // caller of the drain must come through here.
  const drainAndAdopt = async () => {
    const events = await drainAnnouncements(us, announce);
    // THE ADOPTION HALF, for both families of remotely-caused change the
    // account can hand this device. `profile-changed` moves the strip's
    // identity; the three MARK tags move the trust table — including
    // `mark-conflict-repaired`, which is the one that most needs
    // adopting rather than merely announcing, since after a repair the
    // account's view of a record and this device's may genuinely differ.
    // One reconcile covers all of them: it re-reads both halves anyway,
    // and a batch mentioning several is still one round trip.
    if (
      events.some((ev) =>
        ev.tag === "profile-changed" || ev.tag === "mark-added" ||
        ev.tag === "mark-changed" || ev.tag === "mark-conflict-repaired"
      )
    ) {
      await reconcileFromDriver(us, US_CACHE_KEYS, announce, applyProfile, applyMarks);
    }
  };
  // THE SLOW POLL CARRIES THE SYNC WATCH TOO (SYNC.md §3's announcement
  // half). It rides here rather than on a timer of its own because it is
  // the same KIND of work — one cheap read per tick, looking for
  // something the user has to be told — and a second interval would be a
  // second thing to clear.
  //
  // AT A FIFTH OF THE CADENCE, though: `conn.status()` crosses the port
  // and reads the sealed binding and the sealed consent row on the other
  // side, which is not a per-second cost worth paying for a fact that
  // changes on a 20-45 second schedule. The drain's own tick stays at 1 s
  // because an announcement it is holding IS per-second news.
  let syncWatchAt = 0;
  poll(1000, async () => {
    await drainAndAdopt();
    const now = Date.now();
    if (now - syncWatchAt < 5_000) return;
    syncWatchAt = now;
    await watchSyncFailures();
  });

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
    /** THE TRANSPORT ADDRESS this page bound, hex, or "" when the bind
     * failed. Read-only and deliberately narrow: it exists so a scenario
     * can assert that the id is the SAME one across a real reload —
     * which is the whole claim of the persisted endpoint key
     * (engine.wit's `device-identity.endpoint-key-pair`). Nothing here
     * lets a test set it. */
    endpointId: () => (myEndpoint ? hex(myEndpoint) : ""),
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
    /** Drain both timers once, without waiting on them. The drain goes
     * through `drainAndAdopt` for the reason written there: an event
     * handed out once must be ACTED on once, by whoever took it. */
    tick: async () => {
      if (await entry?.joinHandle.tick()) void joinerWire();
      await drainAndAdopt();
    },
    appRunner: () => appRunner !== null,
    /** The storage sheet, entered the way a user enters it. */
    openStorageSheet: () => openStorage(),
    /** THE CONSUMED-KIT SENTENCE this boot announced, or "" — the one
     * announcement in this page that a scenario cannot read off the
     * strip, because `visor.announce` replaces and the restored boot has
     * several other things to say in the seconds that follow
     * (runtime/RECOVERY.md, "Single-use"). The trace marker
     * `restore:announced` proves it reached the visor; this proves WHAT
     * reached it. */
    restoreAnnouncement: () => restoreAnnouncedText,
    /** The device's own claim about where it syncs — `null` sealed or
     * unbound (`DeviceStatus.storage`'s own ambiguity; see rpc.ts). */
    storageStatus: async () => (await conn.status()).storage,
    /** WHAT THE WORKER'S SYNC SCHEDULE HAS DONE — `DeviceStatus.sync`,
     * or null when sealed or unbound (SYNC.md §3's "Surface"; the two
     * nulls are told apart in rpc.ts). Read straight off the status for
     * `storageStatus`'s reason: the schedule is the WORKER's, and a
     * scenario asserting on the sheet's rendering of it would be
     * testing the paint rather than the fact. The offline-sync
     * scenario's boot-pull claim rests on this. */
    syncStatus: async () => (await conn.status()).sync,
    /** The sealed Drive consent this device holds, or null — the
     * bind-without-ceremony condition (DRIVE.md §5). Its one field is
     * the SPACE it was granted for, which is what makes the skip
     * space-aware. */
    gdriveConsent: async () => (await conn.status()).gdriveConsent,
    /** The ACCOUNT'S storage record, or null — the other half of the
     * table `storageStatus` reads one column of. The interesting cell is
     * (device unbound, account bound): a freshly paired device, whose
     * sheet leads with "your account syncs through …" (DRIVE.md, "The
     * account syncs its storage config; devices keep their
     * credentials"). Read straight from the engine, not from whatever
     * the sheet last cached, so a scenario can assert the SYNCED fact. */
    accountStorage: async () => (await enqueue(() => driver.usStorageGet())) ?? null,
    /** The strip's settings button. `openDevice`/`openAdd` above press
     * it on their way to an extra action; the erase ceremony's own way
     * in is a button on the settings sheet itself, so it needs the first
     * half on its own. */
    openSettings: () =>
      (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click(),
    /** THE ERASE CEREMONY, for driving — the same conventions as the
     * device hooks above and as the demo's own `reset` block
     * (host/demo.ts): every control is CLICKED, or (for the confirm
     * field) left holding the value a user's typing would leave, so a
     * driver meets the arming delay and the typed-confirmation gate
     * exactly as a user does. Nothing here reaches `onReset` directly;
     * the only way through is the sheet's own button. */
    reset: {
      /** The only path in (visor/ui/sheets.ts's `requestReset`): the
       * settings sheet's own danger button. Settings must already be
       * open for this to do anything, which is also true of the user. */
      openFromSettings: () =>
        (document.querySelector("#visor-drawer-inner #visor-settings-reset") as
          | HTMLButtonElement
          | null)?.click(),
      open: () => sheets.resetOpen(),
      /** Whether the erase control is still behind the arming delay,
       * read as `disabled` — the enforcement the ceremony itself relies
       * on — plus the `armed` class the drawer host adds once ARM_MS has
       * elapsed. */
      armingState: () => {
        const btn = document.querySelector("#visor-drawer-inner .reset-sheet .erase-confirm") as
          | HTMLButtonElement
          | null;
        const input = document.querySelector("#visor-drawer-inner #visor-reset-confirm") as
          | HTMLInputElement
          | null;
        return {
          btnDisabled: btn?.disabled ?? null,
          btnText: btn?.textContent ?? "",
          inputDisabled: input?.disabled ?? null,
          armed: document.querySelector("#visor-drawer-inner .reset-sheet")?.classList
            .contains("armed") ?? false,
        };
      },
      type: (value: string) => {
        const input = document.querySelector("#visor-drawer-inner #visor-reset-confirm") as
          | HTMLInputElement
          | null;
        if (input) input.value = value;
      },
      erase: () =>
        (document.querySelector("#visor-drawer-inner .reset-sheet .erase-confirm") as
          | HTMLButtonElement
          | null)?.click(),
      /** What the sheet is telling the user right now — a refused word,
       * or a refused erasure. */
      reason: () =>
        (document.querySelector("#visor-drawer-inner .reset-sheet .cred-reason") as
          | HTMLElement
          | null)?.textContent ?? "",
    },
  });
}

if (!isAuthPopup) {
  boot().catch((e) => {
    // THE MESSAGE FIRST, THE OBJECT SECOND. `console.error(e)` alone is
    // a legible stack in a devtools console and NOTHING ANYWHERE ELSE:
    // an out-of-process observer sees whatever the browser chose to
    // serialise, and Playwright's Firefox (Juggler) renders an Error
    // argument as the bare word "Error" — which is how a JSPI-less boot
    // read as an opaque failure for a whole round of debugging while
    // the banner three lines below carried the full sentence all along.
    // A string argument survives every observer there is.
    console.error(`[solo] boot failed: ${err(e)}`, e);
    const banner = document.getElementById("banner")!.querySelector(".bar-inner")!;
    banner.textContent = `boot failed: ${err(e)}`;
  });
}
