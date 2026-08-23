// The end-to-end TodoMVC demo (#20): three panes, one page.
//
//   alice   — the engine + app, wire hub, bucket owner
//   bob     — a collaborator over the live iroh websocket relay
//   tablet  — Alice's second device; NO connections, bucket only
//
// Each pane is TWO component instances under polyengine: the engine
// composite (keyhive + automerge + subduction + bridge + SigV4 bucket
// client + iroh endpoint) and the todomvc app guest. The app's
// `polyvisor:tasks` import is wired DIRECTLY to the engine
// instance's export — the framework-links-apps-to-services topology.

import {
  artifactsFromEnvelope,
  ComponentException,
  instantiate,
} from "@polyengine/runtime/embedder";
import { createRunner, type Runner } from "../../visor/surface/runner.ts";
import { createFrameBackend } from "../../visor/frame/frame-backend.ts";
import { createSurface } from "../../visor/surface/surface.ts";
// The visor's system UI: the strip, the identity cluster, the context
// cluster and the drawer host. The demo is a CONSUMER of it — it supplies
// storage keys, the surface the strip falls back to, and the CONTENT of
// the three sheets it registers as drawer tenants.
import {
  type DrawerSheet,
  foreignToken,
  initVisor,
  isAppMarkIcon,
  markIcon,
  nicknameQuote,
  petnameSpan,
  type SurfaceIdentity,
} from "../../visor/ui/visor.ts";
// The visor's own two ceremonies — the naming/App-settings sheet and the
// "Your visor" settings sheet — plus the trust table they read and write.
// They used to live in this file; they are neither demo content nor
// anybody's app content (they are the visor talking about itself and
// about what it drew), so they are the framework's, and a second spike
// consumes exactly this implementation instead of a lookalike.
import { createSurfaceMarks, registerVisorSheets } from "../../visor/ui/sheets.ts";
// The visor's pairing + user-system UI (PAIRING.md §5): the join and add
// ceremonies, the us-events announcement drain and the boot-cache
// reconcile. It is framework code — this file supplies the driver, the
// containers, the announcement sink and the storage keys, and never
// renders a pairing code or a SAS itself (invariant (f)).
import {
  type AddPaneHandle,
  type AnnounceSink,
  drainAnnouncements,
  mountAddPane,
  mountJoinPane,
  reconcileFromDriver,
  usCacheKeys,
  visorAnnounceSink,
} from "../../visor/ui/pairing.ts";
import { VISOR_HUES } from "../../visor/ui/visor.ts";
import type { PairingDriver } from "../../visor/ui/pairing-driver.ts";
// The two PairingDriver implementations. Which one this page uses is a
// URL choice — see PAIRING_BACKEND below for why the default is the
// real engine and what the mock is still for.
import { createEnginePairingDriver } from "../../runtime/pairing-engine.ts";
import { createMockDriver, MockPairingNetwork } from "./pairing-mock.ts";
import type { UiEvent } from "../../visor/surface/events.ts";
import {
  type Driver,
  type Engine,
  type EngineArtifacts,
  type EngineNet,
  newEngine,
  type StoreConfig,
  type StoreSign,
  unhex,
  until,
} from "../../runtime/engine.ts";
import {
  eraseKeystore,
  getSigningKey,
  makeSigner,
  putSigningKey,
  refusingSigner,
  type Signer,
} from "../../runtime/keystore.ts";
import {
  DROPBOX_OWNER_ORIGINS,
  DROPBOX_PUBLIC_ORIGINS,
  DROPBOX_SHARED_ORIGINS,
  emptyGrant,
  makeOwnerFetch,
  makePublicFetch,
  makeSharedFetch,
  normalizeOrigin,
  refusingOwnerFetch,
} from "../../runtime/store-egress.ts";

// The live path rides n0's PUBLIC relay by default (interop proven in
// polymorph-iroh's `just interop-prod`); override with ?relay=… — e.g.
// a local `iroh-relay --dev` at http://127.0.0.1:3340.
const params = new URLSearchParams(location.search);
const RELAY = params.get("relay") ?? "https://use1-1.relay.n0.iroh.link";

// --- which pairing backend this page drives (PAIRING.md §5/§6) ---------------
//
// THE DEFAULT IS THE REAL ENGINE. Each pane's ceremony runs against its
// own engine instance through ../../runtime/pairing-engine.ts, over the
// real iroh transport; `?pairing=mock` selects the in-page mock
// (host/pairing-mock.ts) instead. The UI, the wiring, the
// announcements and the write-through below are IDENTICAL either way —
// the only difference is which object implements `PairingDriver`.
//
// The mock used to be the default because the real path could not
// finish a ceremony at all. Both blockers are closed (PAIRING.md §6):
//   - the `user-create` guest trap was a SCHEDULER MISATTRIBUTION in the
//     runtime's async support (polyengine#213), fixed in
//     @polyengine/runtime 0.3.1, which this tree pins;
//   - the add side's post-grant linger was a yield-spin that never let
//     the joiner's ingest run; it is a real await now (this tree).
// So a live ceremony — code, SAS, grant, ENROLL — completes in a real
// headless Chromium, and the e2e suite drives it that way.
//
// The mock is KEPT, and is not a fallback: it is the visor-only
// regression harness. It needs no relay, no wasm and no wall-clock
// convergence, so scenarios/device-pairing-mock.ts can assert the UI's
// own behaviour without the transport in the picture.
//
// The pane's status line still says which backend is live: the demo must
// never claim a ceremony it did not perform.
const PAIRING_BACKEND: "mock" | "engine" = params.get("pairing") === "mock"
  ? "mock"
  : "engine";

/** The us-* boot cache keys (PAIRING.md §5's demotion: same keys, same
 * formats, no longer the source of truth). */
const US_CACHE_KEYS = usCacheKeys("pm-demo");

// --- the OAuth redirect landing (visor-owned; #22 × #7) ------------------------
//
// The provider redirects the popup back to THIS page with ?code=&state=.
// That window's only job is to relay the code to the opener and go away:
// it must not boot a second demo (three more engines, a second wire).
// Navigation and redirect handling are visor capabilities — the panel
// never sees this at all.
const relayedCode = params.get("code");
const isAuthPopup = !!relayedCode && !!window.opener;
if (isAuthPopup) {
  window.opener.postMessage(
    { pmDropboxCode: relayedCode, state: params.get("state") },
    location.origin,
  );
  const el = document.getElementById("banner");
  if (el) el.textContent = "authorization relayed — close this window";
  window.close();
}

// The bucket (non-realtime path + the tablet pane) is USER-CONFIGURED,
// per provider. Stored in localStorage; the s3 query params
// (?s3=&bucket=&access=&secret=) still pre-seed an S3 config.
//
// WHAT IS NO LONGER IN HERE (#11): the S3 secret key. A stored config
// carries ADDRESSING plus public identifiers only; the signing
// credential lives in the keystore as a non-extractable handle, and the
// Dropbox tokens live in the visor's per-session credential state and the
// egress grant. A blob read out of localStorage can therefore no longer
// sign anything or be replayed as a bearer for S3.
type StorageConfig =
  | { provider: "s3"; endpoint: string; bucket: string; access: string }
  | {
    provider: "dropbox";
    appKey: string;
    appSecret: string;
    accessToken: string;
    refreshToken: string;
    root: string;
  };

type ProviderKey = StorageConfig["provider"];

/** THE INSTALLED-PROVIDER REGISTRY — what EXISTS on this device, as data.
 *
 * This is the storage page's two provider tabs, promoted. The tabs
 * encoded the same knowledge (which providers there are, which artifact
 * each one's config panel is fetched by) as markup plus a hardcoded
 * union in `mountPanel`, in the one place the knowledge could not be
 * used: inside the page, below the bar, in pixels an app can imitate.
 * The picker sheet needs it ABOVE the bar, so it becomes a table.
 *
 * `artifact` is the PROVENANCE KEY — the name the visor fetches the
 * panel by, and therefore the key of its row in the trust table
 * (`marks`). It is the join between "a provider is installed" and
 * "the user has a word for this component", which is what lets the
 * picker render list (a) in the same voices the strip uses.
 *
 * `label` is the visor's OWN word for the provider — framework voice,
 * used where the visor has to name a component it has never run (a
 * never-mounted provider has said nothing about itself yet). It is
 * never mixed into an app-voice token: the entries in the lists show
 * the provenance key through `foreignToken`, and this label sits beside
 * it as the visor's description. */
interface InstalledProvider {
  key: ProviderKey;
  artifact: string;
  label: string;
  /** WHAT THE VISOR MUST HOLD to connect this provider — the credential
   * kinds its sheet asks for, in the visor's own fixed vocabulary
   * (`CREDENTIAL_VOCABULARY`).
   *
   * It is DECLARED HERE rather than asked of the panel, because by the
   * time the picker binds there is no panel to ask: the record was
   * written on an earlier visit and the component has not run since.
   * That is a strengthening rather than a compromise — the fields on the
   * credential sheet now derive from the visor's own table with no app
   * input at all, where before a (validated) panel answer chose which of
   * the visor's fields appeared. The page keeps its own check against
   * what the running panel declares (`mountPanel` disables Save on an
   * unknown kind), so a panel that asks for something outside the
   * vocabulary is still refused where it is running. */
  needs: readonly string[];
}
const INSTALLED_PROVIDERS: readonly InstalledProvider[] = [
  {
    key: "s3",
    artifact: "panel-s3",
    label: "S3-compatible object storage",
    needs: ["access-key", "secret-key"],
  },
  {
    key: "dropbox",
    artifact: "panel-dropbox",
    label: "Dropbox",
    needs: ["app-key", "app-secret", "bearer-token", "refresh-token"],
  },
];
const providerInfo = (key: ProviderKey): InstalledProvider =>
  INSTALLED_PROVIDERS.find((p) => p.key === key)!;

const STORAGE_KEY = "pm-demo-storage";

/** THE CONFIG STORE, PLURAL (#22 "the storage picker moves above the
 * bar"). One record per CONFIGURED provider, keyed by provider, plus
 * which one is BOUND.
 *
 * Why the split. Configuring a provider and committing to it used to be
 * the same act — the storage page's Save both wrote the record and
 * connected the app to it — so a single stored record was all the state
 * there was. The picker separates them: the page WRITES a record
 * (configuration, below the bar, in pixels an app could imitate) and
 * only the picker BINDS one (commitment, above the bar, armed). Two acts
 * need two pieces of state, and a user may now have several providers
 * configured with exactly one of them in force.
 *
 * `bound` is what boot arms from. Without it a returning user with two
 * configured providers would have no answer to "which one is my
 * storage?" and the visor would have to guess — which is the sort of
 * silent choice this whole design exists to stop making. */
interface StorageStore {
  bound: ProviderKey | null;
  providers: Partial<Record<ProviderKey, StorageConfig>>;
}

// --- the visor's own storage keys ---------------------------------------------
//
// The visor ITSELF — the anchor colour and its palette, the hue
// load/migrate/announce semantics, the scoping discipline that keeps
// --visor-bg off :root, the identity record and its fixed glyph
// vocabulary, the strip, and the drawer host — lives in
// visor/ui/visor.ts. What stays here is the DEMO'S KEYS: two spikes
// sharing an origin must not share an anchor colour or an identity
// record, so the keys are the consumer's and the palette is the
// framework's.
const VISOR_KEY = "pm-demo-visor-hue";
// CONTRACT: rename-only migration (chrome -> visor, GitHub issue #22); the
// legacy key is read once by `initVisor` and then removed, never re-created.
const LEGACY_CHROME_KEY = "pm-demo-chrome-hue";
const IDENTITY_KEY = "pm-demo-identity";

// The trust table: the surface marks, the first-sight timestamps and the
// user's petnames. The TABLE ITSELF — the assignment rule, the local
// uniqueness property, the petname triangle and the refusals — is the
// framework's (visor/ui/sheets.ts, where the reasoning lives in full);
// what stays here is the DEMO'S KEY, for the same reason the hue and
// identity keys are the demo's: two spikes sharing an origin must not
// share a trust table.
const MARKS_KEY = "pm-demo-surface-marks";

/** The demo's view of its own trust table. Stateless (see
 * `SurfaceMarks`), so this facade and the one `registerVisorSheets`
 * builds over the same key are the same table — which is what lets the
 * app's row be registered at boot, long before the sheets can be
 * registered behind the exclusive credential tenant. */
const marks = createSurfaceMarks(MARKS_KEY);


/** Pre-provider-split key; read once as an S3 config so a configured
 * browser keeps working across the rework. */
const LEGACY_S3_KEY = "pm-demo-s3";

/** A secret found in a place secrets no longer live: an old stored blob,
 * or the `?secret=` seed URL. It is escrowed into the keystore and the
 * source is scrubbed — see `escrowPending`. Module-scoped and cleared on
 * use: it is the ONE transient the migration needs. */
let pendingEscrow: { origin: string; access: string; secret: string } | null = null;

/** Split a possibly-legacy S3 blob into today's addressing-only config
 * plus the secret that has to be escrowed and scrubbed. */
function splitLegacyS3(
  raw: { endpoint: string; bucket: string; access: string; secret?: string },
): StorageConfig {
  const cfg: StorageConfig = {
    provider: "s3",
    endpoint: raw.endpoint,
    bucket: raw.bucket,
    access: raw.access,
  };
  const origin = normalizeOrigin(raw.endpoint);
  if (raw.secret && origin !== null) {
    pendingEscrow = { origin, access: raw.access, secret: raw.secret };
  }
  return cfg;
}

/** Read the whole store, MIGRATING every older shape on the way through.
 *
 * Three shapes have been written to this key, and all three still load:
 *   1. today's `{ bound, providers }`;
 *   2. the single record `{ provider: "s3" | "dropbox", … }` — THE
 *      EXISTING RECORD ADOPTS ITS OWN KEY (#22 ruling): the provider it
 *      declares becomes its key in `providers`, and since it was the one
 *      configuration this device had, it is also what was in force, so
 *      it becomes `bound`. A returning user is therefore connected to
 *      exactly what they were connected to before, with no ceremony;
 *   3. the pre-#11 record, which still carries a readable secret — split
 *      by `splitLegacyS3` and escrowed by `escrowPending`, unchanged.
 * Plus the pre-provider-split `LEGACY_S3_KEY` and the `?s3=` seed, both
 * of which land as an s3 record that is bound for the same reason.
 *
 * MIGRATION IS NOT WRITTEN BACK HERE. This is a read; the rewrite
 * happens the next time something persists (`escrowPending` on a boot
 * that escrows, `saveProviderConfig` on a config write). A read that
 * silently rewrites storage is a read that can corrupt on a half-loaded
 * page, and there is nothing to gain: every reader goes through here. */
function loadStorageStore(): StorageStore {
  const seeded = (cfg: StorageConfig): StorageStore => ({
    bound: cfg.provider,
    providers: { [cfg.provider]: cfg },
  });
  if (params.get("s3")) {
    // The ?secret= seed is treated exactly like a legacy stored secret:
    // escrowed on the way in, never re-persisted as a string.
    return seeded(splitLegacyS3({
      endpoint: params.get("s3")!,
      bucket: params.get("bucket") ?? "pm-demo",
      access: params.get("access") ?? "",
      secret: params.get("secret") ?? "",
    }));
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as
        | (StorageConfig & { secret?: string })
        | StorageStore;
      if ("providers" in parsed && typeof parsed.providers === "object") {
        const providers: StorageStore["providers"] = {};
        for (const p of INSTALLED_PROVIDERS) {
          const cfg = parsed.providers?.[p.key];
          if (!cfg || cfg.provider !== p.key) continue;
          // The pre-#11 secret can be sitting in a plural store too (a
          // device that migrated to plural before it ever escrowed), so
          // the split runs per record rather than only on the flat shape.
          providers[p.key] = cfg.provider === "s3"
            ? splitLegacyS3(cfg as StorageConfig & { secret?: string } & { provider: "s3" })
            : cfg;
        }
        const bound = parsed.bound ?? null;
        return {
          bound: bound !== null && providers[bound] ? bound : null,
          providers,
        };
      }
      const cfg = parsed as StorageConfig & { secret?: string };
      // MIGRATION: a config written before #11 still carries the raw
      // secret. Split it out here; `escrowPending` imports it and writes
      // the blob back without the field.
      if (cfg.provider === "s3") return seeded(splitLegacyS3(cfg));
      if (cfg.provider === "dropbox") return seeded(cfg);
      return { bound: null, providers: {} };
    }
    const legacy = localStorage.getItem(LEGACY_S3_KEY);
    if (legacy) {
      const s3 = JSON.parse(legacy) as {
        endpoint: string;
        bucket: string;
        access: string;
        secret: string;
      };
      return seeded(splitLegacyS3(s3));
    }
    return { bound: null, providers: {} };
  } catch {
    return { bound: null, providers: {} };
  }
}

/** The record for one provider, or null when that provider has never
 * been configured on this device. */
function loadStorageFor(provider: ProviderKey): StorageConfig | null {
  return loadStorageStore().providers[provider] ?? null;
}

/** The configuration currently IN FORCE — the bound provider's record.
 * Null when nothing is bound, which is now a real and ordinary state: a
 * provider can be configured (its record written on the page) and not
 * yet selected (never confirmed in the picker). */
function loadBoundStorage(): StorageConfig | null {
  const store = loadStorageStore();
  return store.bound === null ? null : store.providers[store.bound] ?? null;
}

function writeStorageStore(store: StorageStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/** CONFIGURATION, not commitment: write one provider's record and leave
 * the binding exactly as it was. This is what the storage page's Save
 * does now, and the demotion is the point — a page below the bar may
 * describe a destination; only the picker above the bar may put one in
 * force. */
function saveProviderConfig(cfg: StorageConfig): void {
  const store = loadStorageStore();
  store.providers[cfg.provider] = cfg;
  writeStorageStore(store);
}

/** COMMITMENT: the record is in force from here. Only the picker's armed
 * confirmation (and the credential sheet it hands to) reaches this. */
function bindProviderConfig(cfg: StorageConfig): void {
  const store = loadStorageStore();
  store.providers[cfg.provider] = cfg;
  store.bound = cfg.provider;
  writeStorageStore(store);
}

/** Finish the migration: import any secret found in cleartext storage as
 * a non-extractable handle, then rewrite the stored config WITHOUT it.
 * Idempotent — after one run there is nothing left to find. */
async function escrowPending(cfg: StorageConfig | null): Promise<void> {
  const pending = pendingEscrow;
  pendingEscrow = null;
  if (!pending || pending.secret === "") return;
  try {
    await putSigningKey(pending.origin, pending.access, pending.secret);
    // The rewrite is the whole store, in today's shape: this is the one
    // place a legacy blob is guaranteed to be replaced, so it is where
    // the flat record stops existing on disk.
    if (cfg) bindProviderConfig(cfg);
    localStorage.removeItem(LEGACY_S3_KEY);
    console.log("[keystore] migrated a stored secret into a non-extractable signing key");
  } catch (e) {
    console.warn(`[keystore] migration failed: ${e}`);
  }
}

const INFRA_HELP = `the live path needs the relay to be reachable (default: n0's public
relay; ?relay=… to override). The bucket pane is configured via the
Storage… page and is optional for boot.`;

// --- artifacts -----------------------------------------------------------------

/** Build stamp from the page's tiny mutable root; artifacts carry it so a
 * cached bundle can never be paired with fresh components (or vice
 * versa). Empty in a dev tree that skipped the rewrite. */
const BUILD =
  (document.querySelector('meta[name="pm-build"]') as HTMLMetaElement | null)
    ?.content ?? "";
const stamp = (path: string) => (BUILD && BUILD !== "__BUILD__" ? `${path}?v=${BUILD}` : path);

/** The artifact name the visor fetches the app by — and therefore the KEY
 * of the app's row in the surface-mark table. Provenance, never a
 * self-declared name (see visor/ui/sheets.ts's trust-table comment). */
const APP_ARTIFACT = "app";

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

// --- visor capabilities the panels do NOT have -------------------------------

/** `throw new ComponentException(payload)` is the err side of a
 * `result<_, string>` (embedder-api §"Error model"; same brand the
 * webcrypto/websocket ports use). An UNBRANDED throw would trap the
 * panel instead of letting it render the refusal. */
function witErr(message: string): never {
  throw new ComponentException(message);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const AUTH_TIMEOUT_MS = 5 * 60_000;

/** The visor's credential store for the live panel session. Installed by
 * the storage-page wiring in `boot`; module-level so the broker and the scoped
 * fetch shim (both visor capabilities defined out here) can deposit and
 * read WITHOUT the values ever passing through a panel. Per-session: the
 * panel's teardown clears them. */
let depositCredential: (kind: string, value: string) => void = () => {};
let heldCredential: (kind: string) => string = () => "";
/** The destination the visor's held credentials are BOUND to: a normalized
 * origin, or null while there is none. Module-level for the same reason
 * the store above is — the scoped fetch shim is a visor capability
 * defined out here, and injection is conditioned on this binding (#22).
 * The storage-page wiring maintains it; teardown clears it. */
let boundDestination: string | null = null;

/**
 * The PKCE ceremony, run HERE, in the visor: a sandboxed panel can neither
 * open a popup nor follow a redirect, and must not see the ceremony at
 * all. The TOKENS stay in the visor, deposited straight into the visor's own
 * credential fields (#22) — the powerbox shape: the visor shows what is
 * authorized and holds the resulting capability; no panel touches it.
 *
 * NO PANEL CAN TRIGGER THIS ANY MORE. It is invoked from the Connect
 * control the visor renders among the drawer's own fields, and `clientId`
 * comes from the drawer's own App key input — never across the
 * boundary. `oauth-broker` survives in the WIT as the recorded shape for
 * future surfaces (its `authorize` now takes no parameter, for exactly
 * this reason: the client identifier is the visor's), but the Dropbox
 * panel's import is GONE — an unused capability is a wrong grant (#21).
 */
async function authorize(clientId: string): Promise<void> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = b64url(verifierBytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = b64url(new Uint8Array(digest));
  const state = randomHex(8);
  const redirectUri = location.origin + location.pathname;

  const url = `https://www.dropbox.com/oauth2/authorize?client_id=${
    encodeURIComponent(clientId)
  }&response_type=code&code_challenge=${challenge}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&token_access_type=offline&state=${state}`;
  const popup = window.open(url, "pm-dropbox-auth", "width=680,height=760");
  if (!popup) witErr("could not open the authorization window (popup blocked)");

  const code = await new Promise<string>((resolve, reject) => {
    const done = (f: () => void) => {
      globalThis.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      clearTimeout(deadline);
      f();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { pmDropboxCode?: unknown; state?: unknown } | null;
      if (!d || typeof d.pmDropboxCode !== "string") return;
      // The state binding: a relay from another ceremony is ignored.
      if (d.state !== state) return;
      const c = d.pmDropboxCode;
      done(() => resolve(c));
    };
    globalThis.addEventListener("message", onMessage);
    const closedTimer = setInterval(() => {
      if (popup.closed) done(() => reject(new Error("authorization window closed")));
    }, 500);
    const deadline = setTimeout(
      () => done(() => reject(new Error("authorization timed out"))),
      AUTH_TIMEOUT_MS,
    );
  }).catch((e: unknown) => witErr(e instanceof Error ? e.message : String(e)));

  try {
    popup.close();
  } catch { /* already gone */ }

  // Token exchange: PKCE public client — the verifier, never a secret.
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) witErr(`token exchange: HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as { access_token?: string; refresh_token?: string };
  if (!json.access_token) witErr("token exchange: no access_token in the response");
  // Straight into THE VISOR's fields. Nothing is returned to the panel.
  depositCredential("bearer-token", json.access_token);
  depositCredential("refresh-token", json.refresh_token ?? "");
}

/** The one origin the Dropbox panel's grant — network AND credential —
 * points at. The visor's own constant: the panel reports the same string,
 * but the visor never takes the panel's word for it (#22). */
const DROPBOX_DESTINATION = "https://api.dropboxapi.com";

/**
 * `polyvisor:fetch/fetch@0.1.0`, scoped to one host. THIS SHIM IS
 * THE PER-DESTINATION NETWORK GRANT: the panel holds no ambient network
 * capability, only this closure, and the closure will not carry a
 * request anywhere but the Dropbox API. The refusal is a WIT err, not a
 * trap — a panel is entitled to observe (and render) a denied egress.
 */
const dropboxFetchImports = {
  "polyvisor:fetch/fetch@0.1.0": {
    async request(
      method: string,
      url: string,
      headers: Array<[string, string]>,
      body: Uint8Array,
    ): Promise<{ status: number; body: Uint8Array }> {
      let host: string;
      let requestOrigin: string | null;
      try {
        const parsed = new URL(url);
        host = parsed.host;
        requestOrigin = normalizeOrigin(parsed.origin);
      } catch {
        witErr("fetch: host not granted to this panel");
      }
      if (host !== "api.dropboxapi.com") {
        witErr("fetch: host not granted to this panel");
      }
      // CREDENTIAL INJECTION AT THE GRANTED BOUNDARY (#22). The panel
      // holds no token and cannot set one: any panel-supplied
      // `authorization` header is DROPPED (it could only ever be a
      // guess, or an attempt to exfiltrate something by echoing it to
      // the wire), and the visor attaches the bearer credential it holds —
      // outside the sandbox, on the way out. With no token held, no
      // header is added and the provider's 401 is honest.
      //
      // The injection is also BOUND: the token goes out only toward the
      // destination the visor displayed in its credential fields. The host
      // allowlist above is the network grant; this is the credential
      // grant, and both must pass — the allowlist says where the request
      // may go, the binding says where the SECRET may go.
      const outbound = headers.filter(([k]) => k.toLowerCase() !== "authorization");
      const bearer = heldCredential("bearer-token");
      if (bearer && requestOrigin !== null && requestOrigin === boundDestination) {
        outbound.push(["authorization", `Bearer ${bearer}`]);
      }
      const empty = method === "GET" || method === "HEAD" || body.length === 0;
      try {
        const res = await fetch(url, {
          method,
          headers: outbound,
          // Copy out of the guest's view before it crosses back (and the
          // dom lib wants a plain ArrayBuffer, not a Uint8Array view).
          body: empty ? undefined : body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        });
        const buf = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, body: buf };
      } catch (e) {
        // Same rule as the engine's storage seams: a panel is entitled to
        // OBSERVE a failed request (it renders "check the endpoint"), and
        // an unbranded throw out of this import would trap it instead.
        witErr(`fetch: transport: ${err(e)}`);
      }
    },
  },
};

/** Set when a grant's bearer is refreshed behind the seam, so the visor's
 * own copy (and its localStorage mirror) follow. Installed in `boot`; passed
 * to `makeOwnerFetch` as a stable closure so the late install still reaches
 * the factory's callback (runtime/store-egress.ts's `onBearerRefreshed`
 * parameter takes the place of the module-scoped `let` that used to live
 * here). */
let onBearerRefreshed: (token: string) => void = () => {};

// --- panes ---------------------------------------------------------------------

interface AppExports {
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  onRoute(route: string): Promise<void>;
  poll(): Promise<boolean>;
  /** What the app CALLS ITSELF. Self-declared and unverified, exactly
   * like the panels' — read once, clamped, rendered only as
   * foreign-quoted text, never a table key. */
  nickname(): Promise<string>;
  /** What the app ASKS TO WEAR — see `readNomination`. */
  markNomination(): Promise<string | undefined>;
}

/** The `s3-panel` / `dropbox-panel` worlds: seed → run → on-event pump,
 * polling `outcome` after each event. some("") = cancelled,
 * some(json) = completed. */
interface PanelExports {
  seed(config: string): Promise<void>;
  run(): Promise<void>;
  onEvent(ev: UiEvent): Promise<void>;
  outcome(): Promise<string | undefined>;
  /** Visor-driven: produce the config, or none if not yet valid. */
  commit(): Promise<string | undefined>;
  /** The panel's DECLARED credential needs, from the fixed WIT
   * vocabulary (`credentials.credential-kind`). Enum values cross the
   * boundary as their kebab-case WIT names ("access-key", …) — same
   * convention as `event-kind` ("dblclick"/"keydown") in the surface. */
  credentialNeeds(): Promise<string[]>;
  /** Where the panel's configuration currently points: a URL origin, or
   * "" for none. The visor re-reads this after every pumped event, binds
   * its held credentials to it, and revalidates at commit time — the
   * panel REPORTS a destination, the visor DECIDES what it means. */
  destination(): Promise<string>;
  /** What the panel CALLS ITSELF. Self-declared and unverified: read
   * once at mount, clamped, and rendered only as foreign-quoted text.
   * It is never a table key and never the visor's own voice. */
  nickname(): Promise<string>;
  /** What the panel ASKS TO WEAR — see `readNomination`. */
  markNomination(): Promise<string | undefined>;
}

/** The visor's own normalization of a panel-reported destination: parse
 * with the platform's URL machinery and keep the ORIGIN only
 * (scheme + host + port; URL lowercases the scheme and host and gives
 * punycode for unicode hostnames — which is exactly the confusable
 * defence we want, since the comparison and the display then agree).
 * `null` for anything empty or unparseable, and for opaque origins
 * ("null") which cannot be compared meaningfully. */
/** READ A COMPONENT'S PET-ICON NOMINATION, AND VALIDATE IT AT THE SEAM.
 *
 * `mark-nomination` is a component saying which glyph it would like to
 * wear in the user's trust table. It is the only component-influenced
 * value in the whole mark story, so it gets the strictest handling of
 * any string this file reads:
 *
 *   - VALIDATED HERE, at the crossing, not at the render site. The
 *     visor's curated vocabulary is a fixed list of single BMP scalars
 *     (`isAppMarkIcon`), and anything else — a bidi override, a ZWJ
 *     sequence that composes into a colour emoji, a homoglyph of the
 *     visor's OWN button glyph, a paragraph — is dropped RIGHT HERE, so
 *     an invalid string never reaches a render path at all. Not the
 *     strip, not a sheet, not even the ceremony's picker. That
 *     adjacency (the call beside the read) is invariant (g) in
 *     scripts/check-invariants.sh.
 *   - NEVER A KEY. The trust record is addressed by provenance; a
 *     nomination addresses nothing.
 *   - NEVER SPOKEN IN THE VISOR'S VOICE unless the user adopts it. It
 *     surfaces in exactly one place, the naming ceremony's picker,
 *     first and foreign-attributed (visor/ui/sheets.ts).
 *   - WRITE-ONLY, from the component's side: it is read once at mount
 *     and the component is never told whether it was offered, whether
 *     it was taken, or what the user picked instead. Nothing about the
 *     picker or its outcome crosses the seam — the same discipline
 *     invariant (e) keeps for the user's identity.
 *
 * Failure discipline matches `nickname`: a trap, a hang or a refusal is
 * a warning on the console and no nomination, never a broken boot. */
async function readMarkNomination(
  label: string,
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    const asked = await read();
    if (typeof asked !== "string") return undefined;
    return isAppMarkIcon(asked) ? asked : undefined;
  } catch (e) {
    console.warn(`[${label}] mark-nomination: ${err(e)}`);
    return undefined;
  }
}

/** The visor's own cleartext judgement (#22 rule 7): http to anything but
 * the loopback names means the credentials the visor holds would travel in
 * the clear. The visor says this in the visor's words, from the NORMALIZED
 * origin — never from the panel's string. */
function isCleartextDestination(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.hostname !== "127.0.0.1" && url.hostname !== "localhost";
}

// --- visor-owned credential fields (#22) --------------------------------------
//
// The phishing surface this closes: a panel that draws its own secret
// inputs is asking for credentials in ITS pixels while sitting inside
// the visor's storage page, borrowing the visor's authority. So a panel may only
// DECLARE a kind from a fixed vocabulary; the visor renders the field with
// THE VISOR'S OWN WORDS. The visor never renders a panel-supplied label — that
// is the whole point: otherwise a panel declares "your Dropbox password"
// and the visor's pixels say it. Unknown kinds are refused outright, and
// the word "password" is never a label the visor writes.
interface CredentialSpec {
  label: string;
  type: "text" | "password";
  required: boolean;
  note?: string;
}

const CREDENTIAL_VOCABULARY: Record<string, CredentialSpec> = {
  "access-key": { label: "Access key ID", type: "text", required: true },
  "secret-key": { label: "Secret key", type: "password", required: true },
  "bearer-token": {
    label: "Access token",
    type: "password",
    required: true,
    note: "from provider sign-in, or paste a developer token",
  },
  "refresh-token": { label: "Refresh token (optional)", type: "password", required: false },
  // Provider-console identifiers. These are not secrets in the strict
  // sense — an app key ships inside every copy of a public client, and a
  // PKCE public client cannot use an app secret at all. They are here
  // anyway, because the rule the user is being taught has to hold
  // WITHOUT EXCEPTIONS: everything you paste out of a provider console
  // is typed under your colored bar. A panel that could draw one field
  // labelled "App secret" in its own pixels has already taught the user
  // that mid-page secret-ish fields are normal, which is the entire
  // phishing surface back again. Panels keep only provider-specific
  // NON-secret config (S3: endpoint, bucket; Dropbox: root folder).
  "app-key": {
    label: "App key",
    type: "text",
    required: true,
    note: "from the provider's app console",
  },
  "app-secret": { label: "App secret", type: "password", required: true },
};

interface Pane {
  name: string;
  engine: Engine;
  id: Uint8Array;
  runner?: Runner;
  app?: AppExports;
  /** Polls dropped because the previous one was still in flight. */
  pollSkips?: number;
  status: (line: string, sticky?: boolean) => void;
}

// Beat results (pull outcomes, revocation guarantee notes) are the point
// of the demo, and the 4s stats refresh used to erase them within one
// tick. A beat status is STICKY: stats stand down until it expires.
const STICKY_MS = 12_000;
const stickyUntil = new Map<string, number>();

function statusLine(name: string): (line: string, sticky?: boolean) => void {
  const div = document.getElementById(`${name}-status`)!;
  return (line, sticky = false) => {
    if (!sticky && (stickyUntil.get(name) ?? 0) > performance.now()) return;
    if (sticky) stickyUntil.set(name, performance.now() + STICKY_MS);
    div.textContent = line;
  };
}

async function newPane(
  name: string,
  engineArtifacts: EngineArtifacts,
  net: EngineNet,
): Promise<Pane> {
  const engine = await newEngine(name, engineArtifacts, net);
  const status = statusLine(name);
  status("engine up");
  return { name, engine, id: new Uint8Array(), status };
}

/** Instantiate the app guest over a pane's engine (call once the pane's
 * partition is bound: the app renders the service's answers). */
async function mountApp(pane: Pane, appArtifacts: EngineArtifacts) {
  const container = document.getElementById(`${pane.name}-app`)!;
  let dispatch: (ev: UiEvent) => void = () => {};
  // A REAL sandboxed frame per app surface (#16), not the `direct`
  // backend: the app's nodes never enter the visor's document, so the visor's
  // personal strip colour is unreachable by construction rather than by
  // allowlist. See frame-backend.ts.
  const frameBackend = createFrameBackend(
    container as HTMLElement,
    (ev) => dispatch(ev),
  );
  const backend = await frameBackend.backend;
  const surface = createSurface(backend, () => "");
  const imports = {
    ...surface.imports,
    // The framework seam: the app's data-service import IS the engine
    // instance's export object (same embedder, same value conventions,
    // same exception brand).
    "polyvisor:tasks/tasks@0.1.0": pane.engine.tasks,
  };
  const instance = await instantiate(
    artifactsFromEnvelope(appArtifacts.envelope, appArtifacts.bytes),
    imports,
  );
  const app = instance.exports as unknown as AppExports;
  const runner = createRunner(surface);
  dispatch = (ev) => {
    runner.call(() => app.onEvent(ev)).catch((e) => pane.status(`event: ${e}`));
  };
  await runner.call(() => app.run());
  pane.app = app;
  pane.runner = runner;
  // Remote changes surface as revision bumps; poll on a UI cadence —
  // but SKIP a tick whose predecessor is still running. `runner.call`
  // is an unbounded promise chain, so a poll that outlives its 400 ms
  // period (routine while the engine is busy syncing) would otherwise
  // append forever: the queue grows, latency grows with it, and the
  // page ends up wedged with every tick's closure still retained.
  let polling = false;
  pane.pollSkips = 0;
  setInterval(() => {
    if (polling) {
      pane.pollSkips!++;
      return;
    }
    polling = true;
    runner.call(() => app.poll())
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, 400);
}

// --- boot choreography -----------------------------------------------------------

function err(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

/** THE APP'S OWN ROW IN THE TRUST TABLE. Registered once at boot, after
 * the app artifact is instantiated for the regions: ONE artifact drawn
 * into three regions is ONE record, so the strip names the component,
 * not the rectangles. Null until then (and if the nickname read fails,
 * the record still exists — only the self-declared name falls back). */
let appSurface: SurfaceIdentity | null = null;

async function boot() {
  const banner = document.getElementById("banner")!;
  const say = (s: string) => {
    banner.textContent = s;
    console.log(`[boot] ${s}`);
  };

  // THE VISOR. `contextOverride` is the demo's answer to "who owns the
  // strip right now, before any drawer tenant does": a LIVE COMPONENT
  // SURFACE is the only claimant that is not the visor's own, which makes
  // mislabelling it the one error with a victim. (`activePanel` is
  // declared further down this same function; the arrow is only ever
  // called after that point.)
  const visor = initVisor({
    hueKey: VISOR_KEY,
    legacyHueKey: LEGACY_CHROME_KEY,
    identityKey: IDENTITY_KEY,
    appSurface: () => appSurface,
    contextOverride: () => activePanel?.surface ?? null,
  });
  const setVisorContext = visor.setContext;
  const announce = visor.announce;

  // An anchor that resets silently trains the user that it changes; a
  // reset is therefore announced — on the visor's own line, which reverts
  // by re-render when the announcement expires.
  if (visor.fresh) {
    announce("new visor colour set for this device — remember it", 15000);
  }

  say("fetching artifacts…");
  const [engineArt, appArt] = await Promise.all([
    fetchArtifacts("engine"),
    fetchArtifacts(APP_ARTIFACT),
  ]);

  say("instantiating engines…");
  // THE GRANTS, one per authority rather than one per instance: alice and
  // the tablet are the SAME user's two devices, so they share the owner
  // grant (a refreshed Dropbox bearer is thereby refreshed for both, with
  // no re-instantiation). Bob is a different party and gets his own,
  // public-only grant.
  const ownerGrant = emptyGrant();
  const readerGrant = emptyGrant();

  // The signer behind alice's and the tablet's `store-signer` import. The
  // WIRING is fixed here at instantiation; `setupBucket` swaps what this
  // box holds when the user binds a new destination (rebind, not relink).
  // Null = nothing escrowed yet, and the seam says so rather than
  // pretending to be absent.
  let ownerSigner: Signer | null = null;
  const wiredSigner: StoreSign = (stringToSign, date, region, service) => {
    if (!ownerSigner) {
      return Promise.reject(
        new ComponentException("store-signer: no signing credential wired for this instance"),
      );
    }
    return ownerSigner(stringToSign, date, region, service);
  };
  const ownerNet: EngineNet = {
    ownerFetch: makeOwnerFetch(ownerGrant, (token) => onBearerRefreshed(token)),
    publicFetch: makePublicFetch(ownerGrant),
    sharedFetch: makeSharedFetch(ownerGrant),
    signer: wiredSigner,
  };
  // BOB'S CONFINEMENT IS IN THE WIRING. His owner seam and his signer are
  // present and refuse; nothing about his config says "reader", and
  // nothing about it could say otherwise — he holds no import that could
  // act as anybody.
  // ...and the app tier is REAL for him: app auth is the recipient's only
  // credential, and it identifies the shipped client rather than the
  // person, so holding it costs him no anonymity.
  const readerNet: EngineNet = {
    ownerFetch: refusingOwnerFetch,
    publicFetch: makePublicFetch(readerGrant),
    sharedFetch: makeSharedFetch(readerGrant),
    signer: refusingSigner,
  };
  const alice = await newPane("alice", engineArt, ownerNet);
  const bob = await newPane("bob", engineArt, readerNet);
  const tablet = await newPane("tablet", engineArt, ownerNet);
  const panes = [alice, bob, tablet];

  say("identities…");
  for (const p of panes) {
    p.id = unhex(await p.engine.driver.init(false));
    p.status(`id ${Array.from(p.id.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("")}…`);
  }

  // Tablet enrollment cards are pasted (it has no wire).
  await alice.engine.driver.khIngestContact(await tablet.engine.driver.khContactCard());
  await tablet.engine.driver.khIngestContact(await alice.engine.driver.khContactCard());

  say("wire: alice ⇄ bob over the relay…");
  // Alice's endpoint id is KEPT: the post-enrollment user-system wiring
  // (`wireUsSubduction`, far below) dials HER from the tablet, mirroring
  // the headless smoke's direction — see the note there.
  const aliceEp = unhex(await alice.engine.driver.irohBind(RELAY));
  const bobEp = unhex(await bob.engine.driver.irohBind(RELAY));
  const cb = await bob.engine.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
  const ca = await alice.engine.driver.irohStart(true, bobEp, RELAY, bob.id);
  await until("handshake", async () =>
    (await alice.engine.driver.connStatus(ca)) && (await bob.engine.driver.connStatus(cb)));
  await until("contact cards", () => alice.engine.driver.khKnowsAgent(bob.id));

  say("partition: create → members → seal…");
  const part = await alice.engine.driver.createPartition();
  await alice.engine.driver.khAddMember(part, bob.id, "edit");
  await alice.engine.driver.khAddMember(part, tablet.id, "edit");
  await alice.engine.driver.sealPartition(part);
  await bob.engine.driver.adoptPartition(part);
  await tablet.engine.driver.adoptPartition(part);

  say("first sync…");
  await until("bob knows the doc", () => bob.engine.driver.khKnowsAgent(part));
  const pull = async (e: Engine, from: Uint8Array) => {
    const h = await e.driver.syncStart(from, part, false);
    return await until("pull", () => e.driver.syncStatus(h));
  };
  await pull(bob.engine, alice.id);
  await until("bob decrypts", async () => (await bob.engine.tasks.revision()) >= 1n);
  const hs = await bob.engine.driver.syncStart(alice.id, part, true);
  await until("bob subscribe", () => bob.engine.driver.syncStatus(hs));
  await pull(alice.engine, bob.id);
  const ha = await alice.engine.driver.syncStart(bob.id, part, true);
  await until("alice subscribe", () => alice.engine.driver.syncStatus(ha));

  say("mounting apps…");
  for (const p of panes) await mountApp(p, appArt);

  // --- THE APP JOINS THE TRUST TABLE ---------------------------------
  //
  // ONE ARTIFACT, ONE RECORD. The same `app` artifact is instantiated
  // into three regions (alice, bob, tablet); the regions are places
  // the visor drew it, not identities. So the visor registers exactly one
  // surface mark, keyed — like every other record — by the artifact name
  // THE VISOR FETCHED IT BY (unforgeable provenance in this demo; see
  // SurfaceMarks.mark). The region names move to the App settings sheet as
  // metadata, where they describe the record rather than standing in for
  // it.
  //
  // Genuine first boot therefore shows NEW plus the visor's offer to name
  // it, on the strip's bottom line, for the app itself — the TOFU moment
  // the panels already had.
  const { mark: appMark, isNew: appIsNew } = marks.mark(APP_ARTIFACT);
  // WHAT THE APP CALLS ITSELF: read ONCE, from ONE instance, exactly as
  // the panels' nickname is read — the app's exports are reachable from
  // the visor (the frame isolates the app's DOM, not its export surface;
  // see mountApp), so no new seam is needed. Same failure discipline: a
  // trap, an empty answer or whitespace falls back to the provenance
  // key, and the value is clamped at 40 on the way in so no downstream
  // renderer has to remember to.
  let appNickname = APP_ARTIFACT;
  try {
    const declared = alice.app && alice.runner
      ? await alice.runner.call(() => alice.app!.nickname())
      : "";
    const clamped = (declared ?? "").trim().slice(0, 40);
    if (clamped !== "") appNickname = clamped;
  } catch (e) {
    console.warn(`[app] nickname: ${err(e)}`);
  }
  // WHAT THE APP ASKS TO WEAR: read ONCE, right beside the nickname, and
  // validated at the crossing (see `readMarkNomination`). It reaches
  // exactly one render path — the naming ceremony's picker — and only if
  // it is also unclaimed.
  const appNomination = await readMarkNomination(
    "app",
    async () =>
      alice.app && alice.runner
        ? await alice.runner.call(() => alice.app!.markNomination())
        : undefined,
  );
  appSurface = {
    name: APP_ARTIFACT,
    nickname: appNickname,
    icon: appMark.icon,
    nomination: appNomination,
    isNew: appIsNew,
    petname: appMark.petname,
    firstSeen: appMark.firstSeen,
    // The visor's own words for the visor's own fact: where it drew this
    // artifact. Not component-influenced, so not foreign-quoted.
    meta: { label: "drawn in", value: panes.map((p) => p.name).join(", "), foreign: false },
  };
  // A repaint, not a context move: whatever is on the strip stays, and a
  // live announcement (the fresh-anchor one, at boot) keeps its line.
  visor.renderContext();

  // All background engine work rides ONE chain: never concurrent with
  // itself (a wedged overlap of interval-driven driver calls froze the
  // page once; recorded).
  let bg: Promise<unknown> = Promise.resolve();
  let bgDepth = 0;
  const enqueue = (f: () => Promise<unknown>) => {
    bgDepth++;
    const next = bg.then(f).catch(() => {}).finally(() => {
      bgDepth--;
    });
    bg = next;
    return next;
  };
  /** `enqueue` for a call whose ANSWER the caller needs: same one chain,
   * same ordering guarantee, but the returned promise carries the value
   * (and the failure) instead of the swallowing tail the chain itself
   * rides on. The pairing driver goes through this — every pairing and
   * user-system call is serialized against every sync, poll and stats tick on the
   * page, which is the strongest form of the discipline this file
   * already keeps (one chain across ALL instances, not one per
   * instance). */
  const enqueueValue = <T>(f: () => Promise<T>): Promise<T> => {
    bgDepth++;
    const run = bg.then(f);
    // The chain itself must never carry a rejection forward, or one
    // failed pairing call would poison every job queued behind it.
    bg = run.catch(() => {}).finally(() => {
      bgDepth--;
    });
    return run;
  };
  /** Periodic work must never QUEUE: if the previous tick is still
   * running (consumer-API syncs take seconds, well past these periods),
   * appending another job grows the chain without bound — the queue
   * itself becomes the leak, and the page dies sluggish-then-locked.
   * Ticks are skipped instead, which is the correct semantics anyway:
   * a reconciliation pull is a refresh, not a transaction. */
  const periodic = (name: string, everyMs: number, f: () => Promise<unknown>) => {
    let running = false;
    let skipped = 0;
    setInterval(() => {
      if (running) {
        skipped++;
        return;
      }
      running = true;
      enqueue(f).finally(() => {
        running = false;
      });
    }, everyMs);
    return { name, skips: () => skipped };
  };

  // --- controls -------------------------------------------------------------

  // Subscriptions carry the realtime path; a background reconciliation
  // pull bounds any missed push (one in-browser push miss was observed;
  // recorded as a finding).
  const reconcile = periodic("reconcile", 2500, async () => {
    await pull(bob.engine, alice.id);
    await pull(alice.engine, bob.id);
  });

  // --- the bucket leg: user-configured, activates the tablet ---------------

  let bucketReady = false;
  let currentProvider: ProviderKey = loadBoundStorage()?.provider ?? "s3";
  // Dropbox link tier: Bob's standing pickup capability. The visor carries
  // it here in lieu of the E2E channel the framework would use.
  let bobPickup: string | undefined;
  const syncBtn = document.getElementById("bucket-sync") as HTMLButtonElement;
  const autoBox = document.getElementById("bucket-auto") as HTMLInputElement;
  const pullBtn = document.getElementById("bob-pull") as HTMLButtonElement;
  syncBtn.disabled = true;
  autoBox.disabled = true;
  pullBtn.disabled = true;
  tablet.status("no storage configured — use Storage… to activate this pane");

  /** 4 random bytes of namespace: re-runs of the demo mint their own
   * folder (and their own links), so a stale run's revoked links never
   * collide with a fresh one's. */
  const sessionSuffix = () => `/run-${randomHex(4)}`;

  // Storage setup is ~20 sequential provider calls (consumer APIs run
  // ~0.5-1.5 s each), so a single "configuring…" line looks wedged for
  // half a minute. Each step announces itself instead, and a failure
  // says WHICH step died — the engine's transport errors now name the
  // request, so the two compose into an actionable message.
  // Guard against a SECOND setup while one is in flight. The 20 s
  // configure window makes "click Save again" the natural user response,
  // and a duplicate run re-mints container links and republishes pickup
  // objects underneath the first one — the failure mode is confusing
  // rather than harmless, so it is refused rather than queued.
  let setupInFlight = false;

  const setupBucket = (cfg: StorageConfig) => {
    // The flag is claimed SYNCHRONOUSLY, not inside the job: the
    // background chain serializes work, so a guard checked inside it
    // would always find the previous run finished and would happily
    // redo the whole thing. Verified by driving two calls in a row.
    if (setupInFlight) {
      tablet.status("storage setup already running — wait for it", true);
      return Promise.resolve();
    }
    setupInFlight = true;
    return enqueue(async () => {
      let step = "init";
      const at = (s: string) => {
        step = s;
        tablet.status(`configuring storage: ${s}…`, true);
      };
      try {
        at("provider config");
        currentProvider = cfg.provider;
        bobPickup = undefined;
        if (cfg.provider === "s3") {
          const origin = normalizeOrigin(cfg.endpoint);
          if (origin === null) {
            throw new Error(`storage endpoint is not a usable origin: ${cfg.endpoint}`);
          }
          // THE SIGNING AUTHORITY IS FETCHED FROM THE KEYSTORE, not from
          // the config: what the config carries is the address and the
          // public access-key identifier. No escrowed key for this
          // origin means this device cannot write, and saying so plainly
          // beats discovering it as a 403 twenty provider calls later.
          const held = await getSigningKey(origin);
          if (!held) {
            throw new Error(
              `no signing credential held for ${origin} — open Storage… and enter the secret key`,
            );
          }
          // REBIND: the grants' contents change; the instances' wiring
          // does not, and never will for the life of the page.
          ownerGrant.provider = "s3";
          ownerGrant.origins = new Set([origin]);
          ownerGrant.publicOrigins = new Set([origin]);
          // S3 has no app tier; an empty allowlist plus the provider
          // check in the shim means the seam refuses by name.
          ownerGrant.sharedOrigins = new Set();
          readerGrant.provider = "s3";
          readerGrant.origins = new Set();
          readerGrant.publicOrigins = new Set([origin]);
          readerGrant.sharedOrigins = new Set();
          ownerSigner = makeSigner(origin);
          const owner: StoreConfig = {
            kind: "s3",
            value: {
              endpoint: cfg.endpoint,
              bucket: cfg.bucket,
              accessKey: cfg.access,
            },
          };
          // Bob's config is the SAME SHAPE. His reader tier is not a
          // blank field any more — it is the fact that his owner seam
          // and his signer refuse.
          const reader: StoreConfig = {
            kind: "s3",
            value: { endpoint: cfg.endpoint, bucket: cfg.bucket, accessKey: "" },
          };
          await alice.engine.driver.initStore(owner);
          await tablet.engine.driver.initStore(owner);
          await bob.engine.driver.initStore(reader);
          at("bucket + policy");
          await alice.engine.driver.ensureBucket();
          at("grants");
          for (const m of [alice.id, bob.id, tablet.id]) {
            await alice.engine.driver.storeGrant(part, m); // S3: none
          }
        } else {
          const root = cfg.root + sessionSuffix();
          // Visor-held, grant-fed, config-free: the bearer and its
          // refresh (and the app identifiers the refresh needs) go into
          // the GRANT the owner seam closes over. The engine's config
          // gets addressing and nothing else.
          ownerGrant.provider = "dropbox";
          ownerGrant.origins = new Set(DROPBOX_OWNER_ORIGINS);
          ownerGrant.publicOrigins = new Set(DROPBOX_PUBLIC_ORIGINS);
          ownerGrant.sharedOrigins = new Set(DROPBOX_SHARED_ORIGINS);
          ownerGrant.bearer = cfg.accessToken;
          ownerGrant.refresh = cfg.refreshToken;
          ownerGrant.appKey = cfg.appKey;
          ownerGrant.appSecret = cfg.appSecret;
          readerGrant.provider = "dropbox";
          readerGrant.origins = new Set();
          readerGrant.publicOrigins = new Set(DROPBOX_PUBLIC_ORIGINS);
          readerGrant.sharedOrigins = new Set(DROPBOX_SHARED_ORIGINS);
          // The recipient's grant carries the APP identifiers and NOTHING
          // else: no bearer, no refresh. That asymmetry is the whole
          // recipient-anonymity claim, and it is visible right here.
          readerGrant.appKey = cfg.appKey;
          readerGrant.appSecret = cfg.appSecret;
          // No S3 signing on this provider; a stale signer from an
          // earlier S3 session must not survive the switch.
          ownerSigner = null;
          // The tablet is Alice's OWN device: owner tier, same grant.
          const owner: StoreConfig = { kind: "dropbox", value: { root } };
          // Bob is the link tier: same config, different wiring.
          const reader: StoreConfig = { kind: "dropbox", value: { root } };
          await alice.engine.driver.initStore(owner);
          await tablet.engine.driver.initStore(owner);
          await bob.engine.driver.initStore(reader);
          at("folders");
          await alice.engine.driver.ensureBucket();
          at("grant: alice");
          await alice.engine.driver.storeGrant(part, alice.id);
          at("grant: tablet");
          await alice.engine.driver.storeGrant(part, tablet.id);
          at("grant: bob (pickup link)");
          bobPickup = await alice.engine.driver.storeGrant(part, bob.id);
        }
        at("flush");
        await alice.engine.driver.bucketFlush(part);
        at("tablet cold pull");
        tablet.status(
          await tablet.engine.driver.bucketPull(part, alice.id, undefined),
          true,
        );
        bucketReady = true;
        syncBtn.disabled = false;
        autoBox.disabled = false;
        pullBtn.disabled = false;
      } catch (e) {
        // Name the step: a half-configured store is recoverable (every
        // provider call is idempotent), so "retry Save & connect" is
        // honest advice rather than a shrug.
        tablet.status(
          `storage setup failed at ${step}: ${err(e)} — check the endpoint/token and CORS, then Save & connect again`,
          true,
        );
      } finally {
        setupInFlight = false;
      }
    });
  };

  // A bearer refreshed BEHIND the seam is the visor's news, not the
  // component's: the grant already holds the new token (the seam wrote
  // it), and the visor's durable mirror follows so a reload does not start
  // from the expired one. The engine is never told; that is the point of
  // the handle naming the relationship rather than the bytes.
  onBearerRefreshed = (token: string) => {
    try {
      // THROUGH THE STORE, not over it: the refreshed bearer belongs to
      // the dropbox RECORD, and a whole-key overwrite would take every
      // other provider's configuration with it. The binding is not
      // touched — a token refresh is not a commitment.
      const store = loadStorageStore();
      const cfg = store.providers.dropbox;
      if (!cfg || cfg.provider !== "dropbox") return;
      cfg.accessToken = token;
      writeStorageStore(store);
    } catch { /* nothing durable to write to; the grant still has it */ }
  };

  // The body, callable both from the button (queued once) and from the
  // periodic driver (which skips rather than queues).
  const bucketSyncOnce = async () => {
    if (!bucketReady) return;
    try {
      await alice.engine.driver.bucketFlush(part);
      await tablet.engine.driver.bucketFlush(part);
      tablet.status(await tablet.engine.driver.bucketPull(part, alice.id, undefined), true);
      alice.status(await alice.engine.driver.bucketPull(part, alice.id, undefined), true);
    } catch (e) {
      tablet.status(`bucket: ${err(e)}`, true);
    }
  };
  syncBtn.onclick = () => {
    enqueue(bucketSyncOnce);
  };
  const autoSync = periodic("auto-sync", 4000, async () => {
    if (autoBox.checked) await bucketSyncOnce();
  });

  // Bob pulling from the bucket is the revocation beat: S3 shows the
  // cooperative darkness (his K_p is gone), Dropbox the hard server-side
  // refusal (his link is revoked, and it was revoked retroactively).
  const bobPull = () =>
    enqueue(async () => {
      if (!bucketReady) return;
      try {
        const out = await bob.engine.driver.bucketPull(
          part,
          alice.id,
          currentProvider === "dropbox" ? bobPickup : undefined,
        );
        bob.status(`bucket: ${out}`, true);
      } catch (e) {
        bob.status(`bucket: ${err(e)}`, true);
      }
    });
  pullBtn.onclick = () => {
    bobPull();
  };

  // --- the storage PAGE: visor frame, sandboxed provider panel ------------
  //
  // #22's provisional ruling: a provider's config panel is an APP — its
  // own region, its own grants, launched FROM the visor, never rendered AS
  // the visor. The visor owns the page and the OAuth ceremony; the panel
  // owns the fields and hands back an opaque config blob. (The provider
  // TABS the visor used to own here are gone: choosing a provider is a
  // commitment and moved into the picker sheet above the bar, so this
  // page configures exactly the one provider it was opened for.)
  // Credentials never touch app code or visor-rendered provider code.
  //
  // IT WAS A MODAL <dialog> AND IS NOW A SIBLING PAGE (web/index.html's
  // #page-track). The reason is the anchor: a modal paints in the TOP
  // LAYER, above #visor-zone, and its ::backdrop dims everything under
  // it — so the strip's identity flip to the arriving panel (NEW + "name
  // it", the TOFU beat this whole demo is about) happened in the one
  // place the user was being visually pushed away from. Nothing may
  // paint over or dim a component surface's anchor except the visor
  // itself. As a page, the panel becomes a PLACE: the strip is the one
  // element that does not move while everything else slides, so the
  // motion points AT the anchor instead of covering it.
  //
  // It also deleted machinery rather than adding it. Gone with the top
  // layer: the sheets' "take the page back first" precondition, the
  // ESC-close retirement observer, and the close-event-arrives-late
  // ordering class that observer belonged to. There is no top layer, so
  // there is nothing to close and nothing to close it out of order.

  const region = document.getElementById("panel-region") as HTMLElement;
  const saveBtn = document.getElementById("storage-save") as HTMLButtonElement;
  const pageTrack = document.getElementById("page-track") as HTMLElement;
  const pageMain = document.getElementById("page-main") as HTMLElement;
  const pageStorage = document.getElementById("page-storage") as HTMLElement;

  /** Which page the track is showing. The CLASS is the state — one
   * source of truth that the CSS, the e2e harness and this file all read
   * the same way. */
  const onStoragePage = () => pageTrack.classList.contains("show-storage");
  /** Move the track, and move `inert` with it. The off-screen page must
   * not be tabbable, hit-testable or visible to assistive tech: a
   * control the user cannot see but can still reach is worse than a
   * modal, not better. */
  /** A VISOR CEREMONY IS UP OVER THE STORAGE PAGE and has frozen it (the
   * naming or settings sheet — see the `nestedPlace` bracket passed to
   * `registerVisorSheets`). It composes with the track's own inert
   * flags rather than fighting them, which is why both go through
   * `applyPageInert` below instead of being set at their call sites. */
  let ceremonyFrozen = false;

  /** THE ONE PLACE `inert` IS DECIDED, from the two things that decide
   * it. The off-screen page must never be tabbable, hit-testable or
   * visible to assistive tech (a control the user cannot see but can
   * still reach is worse than a modal), and the page UNDER A CEREMONY
   * must not take input either.
   *
   * Written as a recomputation rather than as set/unset pairs because
   * the two states end in any order: a ceremony can close while its
   * page is still up, and a page can be walked out from under an open
   * ceremony (the chevron does exactly that — sheets are orthogonal to
   * navigation). Every exit order then lands on the same answer.
   *
   * The ceremony freeze only ever ADDS inert to the storage page. It
   * never inerts the main page: a ceremony that started over the nested
   * place and outlived it is at home now, where the lightweight sheets
   * have always left the app alone. */
  const applyPageInert = () => {
    const storage = onStoragePage();
    pageStorage.toggleAttribute("inert", !storage || ceremonyFrozen);
    pageMain.toggleAttribute("inert", storage);
  };

  const showPage = (which: "main" | "storage") => {
    pageTrack.classList.toggle("show-storage", which === "storage");
    applyPageInert();
  };

  // --- the visor's own credential entry: the anchored drawer (#22) -----------
  //
  // The phishing surface this closes: a panel that draws its own secret
  // inputs is asking for credentials in ITS pixels while sitting inside
  // the visor's storage page, borrowing the visor's authority. So a panel may only
  // DECLARE a kind from a fixed vocabulary; the visor renders the field with
  // THE VISOR'S OWN WORDS (CREDENTIAL_VOCABULARY above). The visor never
  // renders a panel-supplied label — that is the whole point: otherwise a
  // panel declares "your Dropbox password" and the visor's pixels say it.
  // Unknown kinds are refused outright, and the word "password" is never
  // a label the visor writes.
  //
  // What the drawer changes is WHERE those visor-owned fields live. In
  // the old dialog they sat mid-page between the sandboxed region and the
  // action row: the visor's pixels by construction, but not RECOGNISABLY so
  // — an app can draw that same rectangle, pixel for pixel, inside its
  // own region. They now live on a sheet that unfolds ABOVE the pinned
  // strip, painted in the user's own anchor colour, with the panel
  // already torn down and every remaining surface frozen and dimmed.
  //
  // The GEOMETRY of that reveal — above and never below, the push that
  // moves the real bar, the viewport-minus-strip height budget and the
  // arming delay — is the framework's, and its reasoning now lives with
  // it in visor/ui/visor.ts. What is left here is the CONTENT of the
  // sheet and the demo's own two-phase commit.
  /** The drawer's content box, for the driving handles at the bottom of
   * this file. The host owns it; the queries below only read it. */
  const drawerInner = document.getElementById("visor-drawer-inner") as HTMLElement;
  /** The storage page's own refusal line: the commit-time destination
   * checks fail while that page is still up and no sheet exists yet. */
  const storageReason = document.getElementById("storage-reason") as HTMLElement;
  const storageNote = (text: string) => {
    storageReason.textContent = text;
  };

  /** The visor's per-session credential state, keyed by WIT kind. The
   * inputs are the UI; this map is the value the visor hands onward (and
   * what the fetch shim injects from). It outlives the panel: the OAuth
   * broker deposits into it DURING the panel session, and the drawer
   * opens after that panel is gone. */
  const credValues = new Map<string, string>();
  const credInputs = new Map<string, HTMLInputElement>();
  let credKinds: string[] = [];
  /** True when the visor ALREADY holds an escrowed signing key for the
   * destination this sheet is bound to. It changes two things and
   * nothing else: the secret-key field renders empty with a placeholder
   * saying so, and "empty" passes the visor's requiredness rule (empty =
   * keep the held key; non-empty = replace it). It is deliberately NOT a
   * relaxation of the destination binding — the lookup is keyed by the
   * SAME bound origin the triple revalidation just agreed on, so a panel
   * that re-points itself gets `false` here for free. */
  let heldSigningKey = false;

  /** Element refs for the sheet currently on screen; null while the
   * drawer is closed, in which case every renderer below is a no-op. */
  let credFields: HTMLElement | null = null;
  let credBinding: HTMLElement | null = null;
  let credWarning: HTMLElement | null = null;
  let credReason: HTMLElement | null = null;
  /** The open sheet's refusal line, in the visor's own words — a no-op
   * while no sheet has declared one (see `visor.drawer.setNote`). */
  const drawerNote = visor.drawer.note;

  heldCredential = (kind) => credValues.get(kind) ?? "";
  depositCredential = (kind, value) => {
    credValues.set(kind, value);
    const input = credInputs.get(kind);
    if (input) input.value = value;
  };

  const clearCredentials = () => {
    credKinds = [];
    credValues.clear();
    credInputs.clear();
    heldSigningKey = false;
    boundDestination = null;
  };

  /** The binding line, in the visor's own words. The origin it names is
   * the visor's normalization of what the panel reported — quoted and
   * foreign-styled because it is panel-INFLUENCED data, even after
   * normalization. No panel-supplied prose ever appears here. */
  function renderBinding() {
    if (!credBinding || !credWarning) return;
    credBinding.replaceChildren();
    credWarning.textContent = "";
    if (boundDestination === null) {
      // Rule 3: no destination, no fields. The visor says why, and the
      // inputs cannot be typed into — there is nowhere to release to.
      // (The commit-time revalidation refuses to open the drawer at all
      // without a destination, so this is a defensive branch.)
      const said = document.createElement("span");
      said.textContent =
        "no destination configured — credentials cannot be entered until the panel names one";
      credBinding.append(said);
      for (const input of credInputs.values()) input.disabled = true;
      return;
    }
    const lead = document.createElement("span");
    lead.textContent = "released only toward";
    // APP VOICE through the visor's one door (`foreignToken`): the same
    // `<q>`, the same 120 clamp, the same rendered text — plus the plate.
    credBinding.append(lead, foreignToken(boundDestination, { maxLen: 120 }));
    if (isCleartextDestination(boundDestination)) {
      credWarning.textContent = "unencrypted destination — credentials will travel in the clear";
    }
  }

  /** Re-read the panel's destination and re-bind. A CHANGE is treated as
   * a new secret-handling decision: the values the visor holds were entered
   * (or deposited by the OAuth broker) for the old destination, so they
   * are dropped rather than silently re-aimed (#22 rule 2). Returns the
   * new binding. */
  const rebind = (raw: string, { note = true }: { note?: boolean } = {}): string | null => {
    const next = normalizeOrigin(raw);
    if (next === boundDestination) {
      renderBinding();
      return next;
    }
    const had = boundDestination;
    boundDestination = next;
    // Clear held values AND any visible inputs: the visor must not keep
    // showing (or holding) a secret that is no longer bound to anything.
    credValues.clear();
    for (const input of credInputs.values()) input.value = "";
    renderBinding();
    if (note && had !== null) {
      storageNote("destination changed — credentials will be requested for the new destination");
    }
    return next;
  };

  clearCredentials();

  /** Render the declared kinds INTO THE DRAWER — the visor's labels only.
   * An unrecognised kind is REFUSED rather than guessed at: the visor will
   * not lend its pixels to a request it has no words for, and Confirm
   * stays disabled so the refusal cannot be clicked past (Save is
   * likewise disabled back on the storage page, at mount time). Returns whether
   * anything was refused. */
  const renderCredentials = (kinds: string[], prefill: Record<string, string>): boolean => {
    credKinds = kinds;
    credInputs.clear();
    // The visor ends up holding EXACTLY the kinds this sheet shows: anything
    // left over from the panel session (an OAuth deposit for a kind no
    // longer asked for) is dropped rather than quietly merged at Confirm.
    // Deposits that are still relevant arrive through `prefill`.
    credValues.clear();
    if (!credFields) return false;
    credFields.replaceChildren();
    let refused = false;
    for (const kind of kinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec) {
        refused = true;
        continue;
      }
      const row = document.createElement("div");
      row.className = "cred-field";
      const label = document.createElement("label");
      // THE VISOR'S OWN WORDS. Never a panel-supplied string.
      label.textContent = spec.label;
      const input = document.createElement("input");
      input.type = spec.type;
      input.autocomplete = "off";
      if (kind === "secret-key" && heldSigningKey) {
        // The visor's own words for a credential it holds but cannot show:
        // the key is a non-extractable handle, so "leave blank to keep
        // it" is literally the only offer the visor can make.
        input.placeholder = "held as a non-extractable signing key — leave blank to keep it";
      }
      const seeded = prefill[kind] ?? "";
      input.value = seeded;
      credValues.set(kind, seeded);
      input.addEventListener("input", () => credValues.set(kind, input.value));
      credInputs.set(kind, input);
      row.append(label, input);
      if (spec.note) {
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent = spec.note;
        row.append(note);
      }
      credFields.append(row);
    }
    if (refused) {
      drawerNote("panel requested an unknown credential kind — refused");
    }
    // The binding line governs whether these fields can be typed into at
    // all (rule 3), so it is (re)drawn with them.
    renderBinding();
    return refused;
  };

  /** Requiredness is THE VISOR's rule, by kind — not the panel's. */
  const missingCredential = (): string | null => {
    for (const kind of credKinds) {
      const spec = CREDENTIAL_VOCABULARY[kind];
      if (!spec || !spec.required) continue;
      // A held key satisfies requiredness: the credential IS present,
      // the visor simply cannot render it. Requiredness stays the visor's rule
      // — this is the visor answering its own question with what it holds,
      // not the panel being allowed to skip a field.
      if (kind === "secret-key" && heldSigningKey) continue;
      if ((credValues.get(kind) ?? "").trim() === "") return spec.label;
    }
    return null;
  };

  /** The visor merges its held values into the panel's secret-free config.
   * The panel produced provider + public identifiers; the credentials
   * are added here, on the visor's side of the boundary. */
  const withCredentials = (cfg: StorageConfig): StorageConfig => {
    if (cfg.provider === "s3") {
      // The secret key is NOT merged in: it is escrowed into the keystore
      // at release time (`releaseCredentials`) and never becomes part of
      // a config object, in memory or in storage.
      return { ...cfg, access: heldCredential("access-key") };
    }
    return {
      ...cfg,
      // The panel's blob carries `root` and nothing else; app key and app
      // secret are the visor's fields now, merged in here like every other
      // held value.
      appKey: heldCredential("app-key"),
      appSecret: heldCredential("app-secret"),
      accessToken: heldCredential("bearer-token"),
      refreshToken: heldCredential("refresh-token"),
    };
  };

  /** What the visor hands the PANEL: the stored config with every secret
   * field stripped. A panel that never receives a credential cannot leak
   * one, and seeding is the one path that would otherwise hand it back. */
  const redactForPanel = (cfg: StorageConfig): Record<string, unknown> => {
    const copy = { ...cfg } as Record<string, unknown>;
    // appKey/appSecret join the strip list: the panel does not render
    // them any more, so seeding them back would hand a component data it
    // has no field for and no business holding.
    for (
      const secret of ["access", "secret", "accessToken", "refreshToken", "appKey", "appSecret"]
    ) {
      delete copy[secret];
    }
    return copy;
  };

  /** The destination the visor derives from a CONFIG — the committed blob's
   * own account of where it points, computed by the visor, not reported by
   * the panel. s3: the origin of its endpoint; dropbox: the fixed
   * provider origin (the same one its network grant is scoped to). */
  const configDestination = (cfg: StorageConfig): string | null =>
    cfg.provider === "s3" ? normalizeOrigin(cfg.endpoint) : DROPBOX_DESTINATION;

  /** The visor's fields, prefilled from the stored config for this provider
   * — but ONLY when the stored config was for the SAME destination the
   * panel now points at (#22 rule 5). This is the password manager's
   * refusal to type a saved secret into a look-alike site: a panel that
   * seeds itself toward another origin gets empty fields and a note the
   * user can read, rather than the visor quietly handing over what it kept
   * from last time. */
  const credPrefill = (
    cfg: StorageConfig | null,
    provider: "s3" | "dropbox",
    bound: string | null,
  ): { prefill: Record<string, string>; mismatch: boolean } => {
    if (!cfg || cfg.provider !== provider) return { prefill: {}, mismatch: false };
    const storedDest = configDestination(cfg);
    if (bound === null || storedDest === null || storedDest !== bound) {
      return { prefill: {}, mismatch: true };
    }
    return {
      prefill: cfg.provider === "s3"
        // No secret to prefill any more — there is no readable copy of
        // it anywhere. A HELD key shows as an empty field with the visor's
        // "already held" placeholder instead (see `heldKeyForSession`).
        ? { "access-key": cfg.access }
        : {
          "app-key": cfg.appKey,
          "app-secret": cfg.appSecret,
          "bearer-token": cfg.accessToken,
          "refresh-token": cfg.refreshToken,
        },
      mismatch: false,
    };
  };


  // --- the two-phase commit: the page decides, the drawer collects (#22) ---
  //
  // Phase 1 is the storage PICKER, a sheet above the bar: the user picks
  // a configured provider, under an arming delay, and that armed
  // selection is the whole commitment. Phase 2 is this drawer. Between
  // them the visor tears any panel down and leaves the config page, so
  // by the time a secret is on screen there is no component surface
  // alive anywhere: not on the storage page (left), not in a pane
  // (paused), nowhere. That invariant is the reason for the ordering in
  // `selectProvider`, and it must be preserved by anything that touches
  // this flow.
  //
  // WHAT MOVED (#22 "the storage picker moves above the bar"): phase 1
  // used to be the storage page's Save button — a commitment entered
  // from below the bar. The page now only WRITES a provider's record;
  // binding happens exclusively in the picker.

  // --- THE DRAWER'S THREE TENANTS ------------------------------------------
  //
  // The host (visor/ui/visor.ts) owns the drawer, the reveal, the height
  // budget, the arming delay and every deferred teardown. What the demo
  // declares here is WHO may hold it, in what precedence, and what each
  // one has to undo. REGISTRATION ORDER IS PRECEDENCE ORDER — it is the
  // order `restoreContext` consults and the order evictions run in — so
  // the credential session is registered first.

  /** What the visor holds between the two phases: the panel's secret-free
   * config, the destination the visor bound it to, and the surface mark of
   * the panel that produced it (for the provider line). Non-null exactly
   * while the drawer owns the interaction. */
  interface CredentialSession {
    cfg: StorageConfig;
    destination: string;
    surface: SurfaceIdentity;
  }

  /** THE CREDENTIAL SESSION, and it ALWAYS WINS: `exclusive` means the
   * lightweight tenants refuse to open while this sheet is up or arming,
   * and that an opening credential sheet evicts either of them. It is
   * also the only `armed` tenant (a baited mis-tap must not be able to
   * spend a secret) and the only `dim`med one.
   *
   * NO COMPONENT SURFACE IS LIVE WHILE SECRETS ARE ON SCREEN: the panel
   * is torn down by the caller before the sheet opens, and every
   * remaining pane's runner is paused in `beforeShow` — queued
   * invocations are held, not delivered, so app code can neither observe
   * nor race the entry. */
  const credentialTenant = visor.drawer.tenant<CredentialSession>({
    name: "credentials",
    exclusive: true,
    armed: true,
    dim: true,
    // The strip names the sheet hanging off it, in the same colour it has
    // always had (the anchor never changes colour per surface).
    context: (s) => ({ ...s.surface, kind: "credentials" }),
    beforeShow: () => {
      for (const p of panes) p.runner?.pause();
    },
    // Input delivery resumes for every pane; the panel is already gone.
    afterCollapse: () => {
      for (const p of panes) p.runner?.resume();
    },
    // Held secrets die with the sheet: the visor keeps nothing after the
    // interaction it collected them for is over.
    afterRestore: () => {
      clearCredentials();
      credFields = credBinding = credWarning = credReason = null;
    },
  });

  /** THE VISOR'S OWN TWO CEREMONIES — the naming/App-settings sheet and
   * the "Your visor" settings sheet — registered from the framework
   * layer (visor/ui/sheets.ts), which owns their tenants, their content,
   * the trust table they write and the wording of every refusal.
   *
   * REGISTERED HERE, AFTER THE CREDENTIAL TENANT, ON PURPOSE: registration
   * order is precedence order (see DrawerHost.tenant), and the exclusive
   * sheet that may be holding secrets must outrank both of these. Moving
   * this call above `credentialTenant` would silently invert that.
   *
   * ONE HOOK NOW, and it is the demo's only real precondition: no
   * lightweight sheet may open while the credential sheet holds secrets
   * on screen.
   *
   * WHAT WENT WITH THE MODAL. There used to be a `beforeOpen` here that
   * tore down the panel and closed the storage <dialog>, because a modal
   * paints in the top layer — above the visor zone, and therefore above
   * the very sheet the strip was about to reveal. The storage
   * configuration is a sibling PAGE now, under the same pinned strip, so
   * a sheet can simply unfold above the strip while the storage page sits
   * where it is: no top layer, no occlusion, nothing to take back.
   *
   * AND THE SHEET STAYS CORRECT WHILE IT DOES. A naming sheet is about a
   * SURFACE, and it says which one — it is not a statement about which
   * page is on screen. Naming the app and then walking to the storage
   * page leaves a sheet that still names the app, truthfully, with the
   * strip's own line naming the sheet. That was already the accepted
   * semantics: the old comment here noted that naming outliving the panel
   * session is correct, since the name is a statement about the
   * component rather than about this visit to its configuration. */
  /** Installed by the pairing block near the end of `boot` — the
   * settings sheet's "add a device…" action calls through here. A
   * forward reference because the ceremony needs the engine panes and
   * the background queue, both of which come later, while the sheet
   * that offers it is registered here. Until then the action is a
   * no-op rather than a missing button: the sheet's shape must not
   * depend on how far boot has got. */
  let openAddDevice: () => void = () => {};
  /** Write-through of a naming/settings commit into the user-system
   * partition (PAIRING.md §5's demotion). Installed with the pairing
   * block; a no-op until the driver exists, since localStorage — the
   * boot cache — has already been written by the visor itself either
   * way. */
  let writeThroughMark: (provenance: string, petname: string, icon: string) => void = () => {};
  let forgetThroughMark: (provenance: string) => void = () => {};
  let writeThroughProfile: (displayName: string, hue: number) => void = () => {};

  const sheets = registerVisorSheets(visor, {
    marksKey: MARKS_KEY,
    canOpen: () => !credentialTenant.isOpen(),
    /** THE NESTED PLACE this consumer has: the provider-config page. A
     * ceremony opened over it brackets it — the visor's dim goes up (the
     * drawer host does that from the tenant's `dim` predicate) and the
     * page itself goes inert here.
     *
     * THE PANEL STAYS LIVE. Inert is not retirement: the component keeps
     * running and keeps its grants, and what it loses for the ceremony's
     * duration is the user's input. That is the closure that matters —
     * a live component soliciting text while a visor ceremony is on
     * screen is the interleaving the anchor exists to prevent — and
     * retiring the panel instead would destroy a configuration session
     * the user is in the middle of and is coming back to.
     *
     * `thaw` is unconditional and recomputes, because the page may have
     * been left while the ceremony was up (the chevron walks it out from
     * under an open sheet). */
    nestedPlace: {
      active: () => onStoragePage(),
      freeze: () => {
        ceremonyFrozen = true;
        applyPageInert();
      },
      thaw: () => {
        ceremonyFrozen = false;
        applyPageInert();
      },
    },
    // The demo's in-memory surfaces are caches of the trust record; the
    // strip renders from them, so a commit that only touched storage
    // would leave the anchor showing yesterday's answer. FIRST SIGHT IS
    // OVER on a name: `isNew` is cleared with it.
    onNamed: (provenance, petname, icon) => {
      // §5: the marks live in the partition now; localStorage (which
      // `SurfaceMarks` has already written) is the boot cache.
      writeThroughMark(provenance, petname, icon);
      if (appSurface && appSurface.name === provenance) {
        appSurface = { ...appSurface, petname, icon, isNew: false };
      }
      if (activePanel && activePanel.surface.name === provenance) {
        activePanel.surface = { ...activePanel.surface, petname, icon, isNew: false };
      }
    },
    // Forgetting must be honest on the strip too: the cached petname goes
    // with the record, so the anchor stops speaking a name the visor no
    // longer holds. (`isNew` stays as it is — this session has seen the
    // component; the NEXT mount is the one that is genuinely new again.)
    onForgotten: (provenance) => {
      forgetThroughMark(provenance);
      // BOTH HALVES GO. The record held a name AND a mark; forgetting
      // deletes the record, so a cached surface that kept its glyph
      // would leave the strip wearing a mark the visor no longer holds
      // — the colour-chip version of exactly the dishonesty the forget
      // path exists to prevent ("dropped the name but still greeted as
      // familiar").
      if (appSurface && appSurface.name === provenance) {
        appSurface = { ...appSurface, petname: undefined, icon: "" };
      }
      if (activePanel && activePanel.surface.name === provenance) {
        activePanel.surface = { ...activePanel.surface, petname: undefined, icon: "" };
      }
    },
    // The profile half of the same demotion: the user's name and their
    // anchor colour are account state now, not device state.
    onIdentityCommitted: (rec, hue) => {
      writeThroughProfile(rec.name ?? "", hue);
    },
    // THE ENTRY TO THE ADD CEREMONY (PAIRING.md §5: "strip menu -> add
    // a device"). It is a visor-drawn button on a visor-owned sheet
    // reached from the strip, which is the only place a grant this
    // consequential may start from.
    extraActions: [{
      key: "add-device",
      label: "add a device…",
      hint: "pairs another device with this account — it will have full access",
      onSelect: () => openAddDevice(),
    }],
    // THE CONSUMER'S OWN STATEMENT-OF-CONSEQUENCE LINES (visor/ui/
    // sheets.ts:1214-1223): what this demo is about to destroy that the
    // visor itself knows nothing about. SEMANTICS RULING (this dispatch):
    // reset means THIS DEVICE LEAVES the account — every local copy is
    // erased so the device can no longer act on the user's behalf — not
    // an account-wide erase, so both lines say "this device" and name
    // what other paired devices keep.
    resetConsequences: [
      "this device's keys and its storage configurations are erased with it — this device leaves your account",
      "other devices paired with this account keep their own copies of everything",
    ],
    // THE CONSUMER'S FALLIBLE WIPE (visor/ui/sheets.ts:1329-1339): runs
    // BEFORE the visor erases its own marks table and identity/hue keys,
    // and a throw here aborts the whole ceremony with nothing visor-held
    // lost. So this must erase EVERY demo-owned persistence except the
    // three the visor's own `erase()`/`marks.eraseAll()` already cover
    // (IDENTITY_KEY, VISOR_KEY, MARKS_KEY — removing them here too would
    // be harmless but is the visor's job, not the consumer's, per the
    // ordering contract). THIS IS THE ONE PLACE "this device leaves" is
    // enforced end to end: any future demo-owned persistence key belongs
    // in this list.
    onReset: async () => {
      // The storage configuration (S3 endpoint/bucket/region) and its
      // legacy predecessor: device-local wiring the visor never touches.
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_S3_KEY);
      // The legacy pre-visor anchor-hue key (host/demo.ts's migration
      // path reads it once on an old boot; a device that just erased
      // itself must not resurrect a colour from it on the next one).
      localStorage.removeItem(LEGACY_CHROME_KEY);
      // The pairing boot cache (visor/ui/pairing.ts's `usCacheKeys`):
      // hue/name/marks, DEMOTED to a cache of the account's own state
      // (PAIRING.md §5) but still a local copy that must not survive a
      // device leaving — a stale cache is exactly what would let a freshly
      // reset device flash the old name for one frame on the next boot.
      localStorage.removeItem(US_CACHE_KEYS.hue);
      localStorage.removeItem(US_CACHE_KEYS.name);
      localStorage.removeItem(US_CACHE_KEYS.marks);
      // The signing keystore: this device's escrowed credential handles,
      // in a separate IndexedDB database the visor's own erase does not
      // reach. Erasing it is the literal mechanism of "this device can no
      // longer act on the account" — after this line the device holds no
      // signing capability at all, escrowed or otherwise.
      await eraseKeystore();
    },
  });

  /** PUT THE STRIP BACK IN THE HANDS OF WHOEVER ACTUALLY OWNS IT NOW —
   * the host's recomputation, in the precedence order above, with the
   * live panel surface ahead of all three (see the `contextOverride`
   * passed to `initVisor`). No caller states what the context should
   * become; each one says only "I am done". */
  const restoreVisorContext = visor.drawer.restoreContext;

  /** Persist and connect: identical to the pre-drawer commit tail, just
   * moved behind the sheet's Confirm — and it BINDS, because everything
   * that reaches here came through the picker's armed confirmation. */
  const persistAndConnect = (cfg: StorageConfig) => {
    try {
      bindProviderConfig(cfg);
      if (bucketReady) {
        tablet.status("storage changed — reload the page to reconfigure");
      } else {
        setupBucket(cfg);
      }
    } catch (e) {
      tablet.status(`storage config unreadable: ${err(e)}`);
    }
  };

  // The three closes are the tenants' own, thin: everything they used to
  // do by hand — dropping the session, dropping the resize listener,
  // collapsing the sheet, un-dimming, restoring the strip to its rightful
  // owner and blanking the drawer only if nobody else claimed it
  // meanwhile — is the host's now, driven by the specs above.
  const closeDrawer = () => credentialTenant.close();
  // (The naming/settings closes used to be bound here too, for the
  // openStorage path that closed a sheet before showing the modal. A
  // page slide does not fight a sheet, so nothing calls them; the
  // tenants' own `closeNaming`/`closeSettings` remain on `sheets` for
  // any consumer that needs them.)


  /** Build the visor's sheet. Every word here is the visor's; the only foreign
   * strings are the component's name and the destination origin, both
   * quoted, clamped and foreign-styled. */
  const buildSheet = (session: CredentialSession, needs: string[]) => {    const root = document.createElement("div");
    root.className = "cred-sheet";
    // The DRAWER spans the full window width (it hangs off the pinned
    // strip, which is full-width by construction — that is the anchor).
    // Its CONTENT is constrained to the same centered column the page
    // uses, so the sheet's fields line up with everything else instead
    // of stretching across a wide display.
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Storage credentials";

    // The requesting provider, by its surface mark: the same PET ICON the
    // strip showed while its panel was up — or nothing at all, if the
    // user has not marked it yet. WHO is named the same way the strip
    // names it — the user's petname in the visor's voice when there is
    // one, with the component's self-description demoted to a foreign
    // footnote; otherwise only what the component calls itself, quoted.
    const who = document.createElement("div");
    who.className = "cred-line";
    const lead = document.createElement("span");
    lead.textContent = "requested by";
    who.append(lead);
    const mark = markIcon(session.surface.icon);
    if (mark) who.append(mark);
    const petname = (session.surface.petname ?? "").trim();
    if (petname !== "") {
      const said = document.createElement("span");
      said.className = "said calls-itself";
      said.textContent = "calls itself";
      who.append(petnameSpan(petname), said, nicknameQuote(session.surface.nickname));
    } else {
      who.append(nicknameQuote(session.surface.nickname));
    }

    credBinding = document.createElement("div");
    credBinding.className = "cred-line";
    credWarning = document.createElement("div");
    credWarning.className = "cred-warning";
    credFields = document.createElement("div");
    credReason = document.createElement("div");
    credReason.className = "cred-reason";
    // Where `drawerNote` writes for as long as this sheet is up. The host
    // clears it on close, so a note aimed at a sheet that is gone cannot
    // land in the next one.
    visor.drawer.setNote(credReason);

    // THE VISOR'S OWN SIGN-IN CONTROL. It appears only when this session
    // actually needs both halves of the ceremony's inputs and outputs —
    // an app key to authorize against, and a bearer token to deposit.
    // It lives here rather than in the panel for the same reason the
    // fields do: it acts on the app key, and the app key is the visor's.
    // The panel cannot render it, cannot trigger it, and cannot observe
    // it; it only ever sees a later `fetch` that already works.
    let connectBtn: HTMLButtonElement | null = null;
    const connectRow = document.createElement("div");
    connectRow.className = "cred-connect";
    if (needs.includes("app-key") && needs.includes("bearer-token")) {
      connectBtn = document.createElement("button");
      connectBtn.type = "button";
      connectBtn.textContent = "Connect Dropbox (sign-in)";
      connectRow.append(connectBtn);
    }

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "secrets are only ever typed here, in the space this bar just opened above itself — every app surface is frozen and dimmed while this sheet is open";

    const row = document.createElement("div");
    row.className = "cred-row";
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    row.append(confirmBtn, cancelBtn);

    root.append(h, who, credBinding, credWarning, credFields);
    if (connectBtn) root.append(connectRow);
    root.append(note, credReason, row);
    return { root, confirmBtn, cancelBtn, connectBtn };
  };

  const openCredentialDrawer = (
    session: CredentialSession,
    needs: string[],
    prefill: Record<string, string>,
    mismatch: boolean,
    /** The visor already holds an escrowed signing key for this session's
     * bound destination (looked up by the caller, under the same
     * binding the commit-time revalidation agreed on). */
    held: boolean,
  ) => {
    heldSigningKey = held;
    // The credential session takes the drawer from anything else holding
    // it — the host evicts the lightweight tenants context-free, because
    // they are interruptible conveniences and secret entry is not. The
    // caller has usually CLAIMED this same session object already (see
    // the storage Save handler), which the host reads as a claim being
    // revealed rather than a re-entry: nothing held is dropped.
    credentialTenant.open(session, () => {
      const { root, confirmBtn, cancelBtn, connectBtn } = buildSheet(session, needs);
      const refused = renderCredentials(needs, prefill);
      if (mismatch) {
        drawerNote("stored credentials are for a different destination — not filled");
      }

      confirmBtn.onclick = () => {
        const s = credentialTenant.session();
        if (!s) return;
        // Requiredness is the visor's rule, judged in the visor's pixels; the
        // panel is not told which credential was missing (it is gone).
        const missing = missingCredential();
        if (missing !== null) {
          drawerNote(`${missing} is required`);
          return;
        }
        // The visor merges its held values into the panel's secret-free
        // config — the same withCredentials path as before the drawer.
        // The S3 secret is NOT among them: it goes straight into the
        // keystore as a non-extractable handle and is never part of any
        // config object. Read the sheet's values HERE, because closing the
        // drawer drops them.
        const secret = heldCredential("secret-key").trim();
        const access = heldCredential("access-key").trim();
        const destination = s.destination;
        const full = withCredentials(s.cfg);
        closeDrawer();
        void (async () => {
          if (full.provider === "s3" && secret !== "") {
            // Non-empty = replace the held key; empty = keep it (the
            // field's placeholder said so, and requiredness agreed).
            // Escrow BEFORE persisting: a config that points at a
            // destination with no usable key is the one state worth
            // avoiding, since setup would then refuse.
            try {
              await putSigningKey(destination, access, secret);
            } catch (e) {
              tablet.status(`could not escrow the signing key: ${err(e)}`, true);
              return;
            }
          }
          persistAndConnect(full);
        })();
      };
      if (connectBtn) {
        const btn = connectBtn;
        btn.onclick = async () => {
          // The app key comes from THIS SHEET's own field, never from a
          // panel: the visor authorizes against what the user typed under the
          // bar, so nothing a component said can steer the ceremony.
          const clientId = (credValues.get("app-key") ?? "").trim();
          if (clientId === "") {
            drawerNote("enter the App key first");
            return;
          }
          // Re-entrancy: the popup + token exchange is a long await, and a
          // second ceremony would race the deposit.
          btn.disabled = true;
          drawerNote("waiting for the provider's sign-in window…");
          try {
            await authorize(clientId);
            // The sheet may have been confirmed or cancelled while the
            // popup was up; its held values are gone, so a late deposit
            // must not be reported as this session's success.
            if (!credentialTenant.owns(session)) return;
            drawerNote("signed in ✓ — the token fields above were filled by the visor");
          } catch (e) {
            if (!credentialTenant.owns(session)) return;
            drawerNote(`sign-in failed: ${err(e)}`);
          } finally {
            if (credentialTenant.owns(session)) btn.disabled = false;
          }
        };
      }
      cancelBtn.onclick = () => {
        // Nothing was persisted and nothing was released: the held config
        // and the held credentials both die here.
        closeDrawer();
        tablet.status("storage setup cancelled — nothing saved", true);
      };

      return {
        root,
        // Disabled BEFORE the first frame, inputs included: a secret must
        // not be typeable into a sheet the user has not yet had time to
        // see. The host holds them disabled for ARM_MS.
        controls: [
          confirmBtn,
          cancelBtn,
          // The visor's sign-in control is armed by the SAME delay as the
          // rest: it opens a provider window, which is exactly the sort of
          // thing a baited mis-tap should not be able to reach.
          ...(connectBtn ? [connectBtn] : []),
          ...credInputs.values(),
        ],
        onArmed: () => {
          // Rule 3 still governs the inputs after arming: with no bound
          // destination there is nowhere to release to, so nothing may be
          // typed. (Refused kinds keep Confirm out of reach for good.)
          if (boundDestination === null) {
            for (const input of credInputs.values()) input.disabled = true;
          }
          if (refused) confirmBtn.disabled = true;
        },
      };
    });
  };

  const panelArtifacts = new Map<string, EngineArtifacts>();
  let panelMounted: "s3" | "dropbox" | null = null;
  let activePanel:
    | {
      provider: "s3" | "dropbox";
      panel: PanelExports;
      runner: Runner;
      /** The surface mark the visor showed for this panel; the drawer
       * repeats it so "who asked" survives the panel's teardown. */
      surface: SurfaceIdentity;
    }
    | null = null;
  let panelDispatch: (ev: UiEvent) => void = () => {};
  /** The live panel surface's sandboxed frame, if any (see
   * frame-backend.ts). Teardown must destroy it explicitly: clearing the
   * region would orphan the port and the window listener. */
  let panelFrame: { destroy(): Promise<void> } | null = null;

  /** Drop the panel: clear its granted subtree and cut the event path.
   * (Instance teardown proper is an OPEN polyengine question — there is no
   * `drop`/`dispose` on an instantiated component yet; dropping our refs
   * and its DOM is the whole of the retirement we can express today.) */
  // Every mount takes a generation; teardown bumps it. Mounting is
  // async (artifact fetch + frame handshake), so without this a mount
  // that completes AFTER the user left the storage page would append a
  // live component frame to a region nobody is looking at — an invisible
  // surface holding a granted rectangle.
  let panelGeneration = 0;
  /** THE COMPLETION SIGNAL FOR THE LAST TEARDOWN — the thing this file's
   * late-teardown ordering class was missing a fourth time.
   *
   * The other three members of that class (the retirement observer's
   * `open`-attribute trigger, teardownPanel's session-aware context
   * restore, and the drawer's occupancy-checked timers) all exist
   * because a lifecycle step here finishes LATER than the code that
   * caused it returns. Frame teardown is the same shape and had no
   * signal at all: `destroy()` returned void, so a remount had no way to
   * ask "is the old surface actually gone?" and simply hoped. It is a
   * promise now (frame-backend.ts's `destroy`), and this holds the
   * in-flight one so `mountPanel` can await it.
   *
   * Null when no teardown is outstanding. */
  let teardownInFlight: Promise<void> | null = null;
  const teardownPanel = (): Promise<void> => {
    panelGeneration++;
    panelDispatch = () => {};
    // Close the port and drop the frame BEFORE clearing the region, so
    // the frame's window listener and MessagePort go with it rather than
    // being left holding a detached document.
    const gone = panelFrame?.destroy() ?? Promise.resolve();
    panelFrame = null;
    region.innerHTML = "";
    panelMounted = null;
    activePanel = null;
    // The strip goes back to whoever rightfully owns it now (see
    // restoreVisorContext): NOT unconditionally to the app, because a
    // teardown can land AFTER a handoff (the Save path retires the panel
    // and then opens the credential sheet) and would otherwise blank a
    // live sheet's line.
    restoreVisorContext();
    region.style.removeProperty("--component-color");
    saveBtn.disabled = false;
    storageNote("");
    // Held credentials are PER-SESSION visor state: when the panel goes,
    // so do the values — UNLESS this teardown is the handoff into the
    // credential drawer, which is the one case where the visor must keep
    // holding them (the OAuth broker deposits during the panel session,
    // and the sheet that will show them opens a moment later). The drawer
    // clears them itself on Confirm or Cancel. Testing the credential session
    // rather than a transient flag is what makes the ORDER of the Save
    // path irrelevant: the teardown runs while the handoff is already
    // claimed, so it cannot wipe the values the sheet is about to show.
    if (credentialTenant.session() === null) clearCredentials();
    // Publish the completion, and retire it once it lands so a later
    // mount does not await a teardown that finished long ago. The
    // identity check is the usual discipline: only the teardown that is
    // still the current one may clear the slot.
    const done = gone.then(() => {
      if (teardownInFlight === done) teardownInFlight = null;
    });
    teardownInFlight = done;
    return done;
  };

  const mountPanel = async (provider: "s3" | "dropbox") => {
    const gone = teardownPanel();
    const generation = ++panelGeneration;
    // NOTHING MOUNTS INTO A PAGE NOBODY IS ON. Same claim the old
    // `dialog.open` guards made, read off the page state instead.
    if (!onStoragePage()) return;
    const name = provider === "s3" ? "panel-s3" : "panel-dropbox";
    let art = panelArtifacts.get(name);
    if (!art) {
      art = await fetchArtifacts(name);
      panelArtifacts.set(name, art);
    }
    if (generation !== panelGeneration) return;
    // Bind the surface's identity into the strip BEFORE it can draw. The
    // mark is looked up by PROVENANCE (the visor fetched this artifact
    // itself, by this name, from its own origin) and CREATED on first
    // sight, unmarked — the pet icon is the user's to choose in the
    // ceremony, never the visor's to roll (visor/ui/sheets.ts).
    const { mark, isNew } = marks.mark(name);
    // THE REGION'S EDGE TINT, and it is NOT a recognition device — it
    // never was one, whatever the code here used to imply by sharing a
    // value with the strip's chip. It is decoration on the UNTRUSTED
    // rectangle, so it is derived from the artifact name (public, the
    // component's own, and stable) rather than from anything of the
    // user's. Deriving it is now honest rather than dangerous precisely
    // BECAUSE the visor no longer shows a matching colour: with the chip
    // gone, an impersonator grinding its artifact for a target's tint
    // wins a border colour inside its own rectangle, which it could
    // paint anyway. Scoped to the region regardless — the visor's
    // document root stays clean (invariant (c)).
    let tint = 0;
    for (const ch of name) tint = (tint * 31 + ch.codePointAt(0)!) % 360;
    region.style.setProperty("--component-color", `oklch(62% .16 ${tint})`);
    // Before instantiation the visor has nothing but provenance to show, so
    // that is what it shows — the nickname is a claim only the running
    // component can make, and it lands a moment later.
    let identity: SurfaceIdentity = {
      name,
      nickname: name,
      icon: mark.icon,
      isNew,
      petname: mark.petname,
      firstSeen: mark.firstSeen,
    };
    setVisorContext(identity);

    // THE PREVIOUS SURFACE MUST BE ACTUALLY GONE before this one is
    // stood up. Teardown does not finish when `teardownPanel()` returns
    // — the old frame's window can still have messages in flight toward
    // the visor (frame-backend.ts's `destroy`), and creating the next frame
    // inside that window is how a stale delivery ends up attributed to
    // the new surface. Awaiting the completion is what turns "reopen
    // immediately after ESC" from a race into an ordering.
    await gone;
    // GENERATION AFTER EVERY AWAIT, this one included: two reopens in
    // the time the teardown took would leave this mount stale, and a
    // stale mount must not resurrect itself into a region a newer one
    // already owns.
    if (generation !== panelGeneration) return;
    if (!onStoragePage()) return;

    // Same sandboxed-frame treatment as the app panes: the panel handles
    // provider credentials, so the argument for keeping it out of
    // the visor's document is if anything stronger here.
    const frameBackend = createFrameBackend(region, (ev) => panelDispatch(ev), "dark");
    panelFrame = frameBackend;
    // A HANDSHAKE THAT NEVER COMPLETES BECAUSE WE WERE TORN DOWN IS
    // CANCELLATION, NOT FAILURE. `backend` rejects when the surface is
    // destroyed before it is ready, and an unguarded `await` turns that
    // into a thrown error — which openStorage's `.catch` then writes
    // into the region as "panel failed to mount: frame backend destroyed
    // before it was ready", clobbering whatever surface is legitimately
    // there by now. The generation is what distinguishes the two: if we
    // have been superseded, the rejection is our own retirement arriving
    // and this mount simply stops, silently.
    const backend = await frameBackend.backend.catch((e: unknown) => {
      if (generation !== panelGeneration) return null;
      throw e;
    });
    if (backend === null || generation !== panelGeneration) {
      await frameBackend.destroy();
      return;
    }
    const surface = createSurface(backend, () => "");
    // The capability profiles, side by side (#21): the S3 panel is PURE —
    // surface only, no egress. The Dropbox panel additionally holds
    // exactly ONE host-scoped fetch. It used to hold the OAuth broker
    // too; sign-in moved into the visor's drawer (where the app key is), so
    // the grant went with it rather than lingering unused.
    const imports = provider === "s3" ? { ...surface.imports } : {
      ...surface.imports,
      ...dropboxFetchImports,
    };
    const instance = await instantiate(
      artifactsFromEnvelope(art.envelope, art.bytes),
      imports,
    );
    if (generation !== panelGeneration) {
      await frameBackend.destroy();
      return;
    }
    const panel = instance.exports as unknown as PanelExports;
    const runner = createRunner(surface);
    // WHAT THE COMPONENT CALLS ITSELF: read ONCE, here, and never again —
    // a name that could change under the visor's feet would be a name the visor
    // could not have shown the user before they acted on it. Clamped to
    // 40 at the read, exactly as `destination` is clamped at render, so
    // no downstream renderer has to remember. A hostile or broken panel
    // that traps, hangs the read, or answers with whitespace does NOT
    // take the visor down: the visor falls back to the provenance key it
    // fetched the artifact by, rendered foreign-quoted like any other
    // machine string.
    let nickname = name;
    try {
      const declared = await runner.call(() => panel.nickname());
      const clamped = (declared ?? "").trim().slice(0, 40);
      if (clamped !== "") nickname = clamped;
    } catch (e) {
      console.warn(`[panel] nickname: ${err(e)}`);
    }
    if (generation !== panelGeneration) return;
    // The nomination, read once beside the nickname and validated at the
    // crossing (`readMarkNomination`) — same trip, same discipline.
    const nomination = await readMarkNomination(
      "panel",
      () => runner.call(() => panel.markNomination()),
    );
    if (generation !== panelGeneration) return;
    identity = { ...identity, nickname, nomination };
    setVisorContext(identity);
    panelMounted = provider;
    // The visor keeps the handles it needs to COMMIT; the panel only ever
    // gets events and answers questions.
    activePanel = { provider, panel, runner, surface: identity };
    panelDispatch = (ev) => {
      if (panelMounted !== provider) return;
      runner.call(() => panel.onEvent(ev))
        // The binding is LIVE (#22 rule 2): the panel's configuration can
        // move under the visor's feet with any keystroke, so the visor re-reads
        // the destination after every pumped event rather than trusting
        // the one it read at mount. A change drops the held values.
        .then(async () => {
          if (panelMounted !== provider || generation !== panelGeneration) return;
          const raw = await runner.call(() => panel.destination());
          if (panelMounted !== provider || generation !== panelGeneration) return;
          rebind(raw ?? "");
        })
        .catch((e) => console.warn(`[panel] event: ${err(e)}`));
    };
    // THIS PROVIDER'S OWN RECORD, not "the" configuration: the store is
    // plural now, so a panel is seeded from the record filed under the
    // provider it is the panel for — never from another provider's.
    const stored = loadStorageFor(provider);
    // The panel is seeded with a REDACTED copy: its own public fields
    // only. The visor's fields get the secrets (#22).
    const seedJson = stored ? JSON.stringify(redactForPanel(stored)) : "";
    await runner.call(() => panel.seed(seedJson));
    await runner.call(() => panel.run());
    if (generation !== panelGeneration) return;
    // The panel DECLARES its credential kinds. The visor does NOT render a
    // field here any more — entry happens later, in the visor's own drawer.
    // What the visor checks at mount is only whether it has WORDS for what
    // was asked: an unrecognised kind is refused up front and Save is
    // disabled, so the refusal cannot be clicked past into a sheet the visor
    // could not honestly label.
    const needs = await runner.call(() => panel.credentialNeeds());
    if (generation !== panelGeneration) return;
    const rawDest = await runner.call(() => panel.destination());
    if (generation !== panelGeneration) return;
    // note:false — this is the FIRST binding of the session, not a
    // change of one; there is nothing the user entered to invalidate.
    const bound = rebind(rawDest ?? "", { note: false });
    // The panel's DECLARED destination, carried on the identity so the
    // App settings sheet can show it. Component-INFLUENCED even after
    // the visor's normalization, hence foreign:true — the sheet quotes it.
    if (bound !== null) {
      identity = { ...identity, meta: { label: "declared destination", value: bound, foreign: true } };
      setVisorContext(identity);
      if (activePanel) activePanel.surface = identity;
    }

    const unknown = (needs ?? []).some((kind) => !CREDENTIAL_VOCABULARY[kind]);
    saveBtn.disabled = unknown;
    storageNote(unknown ? "panel requested an unknown credential kind — refused" : "");

    // THE LOUD HANDOFF. The page has changed under the user and the
    // pixels below the strip now belong to a component — so the visor
    // points at itself, at the moment the surface actually arrives
    // rather than when the navigation started. The modal made this beat
    // invisible (top layer above the anchor, backdrop dimming the page);
    // the slide makes it visible, and this makes it NOTICED.
    //
    // WHY A PULSE AND NOT AN ANNOUNCEMENT. This used to be
    // `visor.announce(...)`, which owns the bottom line for 8s — so it
    // spent those 8 seconds PARAPHRASING the strip ("the strip above
    // says NEW") while covering the very thing it was paraphrasing. The
    // pulse points AT the lines instead of talking over them: the
    // panel's plated nickname, the NEW marker and the offer to name it
    // are all readable during the arrival, which is when they matter.
    //
    // ANNOUNCEMENT POLICY (visor/ui/visor.ts's `pulseContext`): the
    // pulse puts no words on screen at all, so nothing here can wear the
    // wrong voice. The sr string is heard, not seen, and obeys the same
    // rule an announcement would: framework voice, USER-voice words
    // inline (the petname, which the user wrote), but never the
    // component's nickname and never its provenance key — those are app
    // voice, and a flat string cannot wear the app-voice plate. Hence
    // the unnamed branch DESCRIBES rather than names. It also avoids
    // spatial-visual wording ("the strip above"), which means nothing to
    // a listener.
    const named = (identity.petname ?? "").trim().slice(0, 40);
    visor.pulseContext(
      named !== ""
        ? `this page is now drawn by ${named} — a component, in its own sandbox`
        : "this page is now drawn by a component you have not named — the visor offers to name it",
    );
  };

  /** LEAVING THE STORAGE PAGE, by every path there is. Cancel, the Save
   * commit's handoff, and the browser's own Back button all come through
   * here, because the property being defended is a single sentence: NO
   * PATH MAY LEAVE A LIVE PANEL SESSION OFF-SCREEN. A component holding a
   * granted rectangle on a page the user has walked away from is a
   * surface with no anchor.
   *
   * WHAT THIS REPLACED is worth recording, because it was three
   * mechanisms rather than one. A <dialog> closes natively on ESC, so
   * retirement had to cover every close path; the close EVENT was the
   * obvious place, but at least one embedding (the paseo webview: native
   * close(), listener verified by manual dispatch) flips `open` without
   * ever delivering the queued event, and also closes modals
   * spuriously — so there was a MutationObserver on the `open` attribute
   * as well, and both were guarded on `open` being false at the moment
   * they ran, because a close event is delivered as a TASK and a reopen
   * could land in between, making the event describe a session that was
   * already over while a NEW surface was mid-handshake. None of that
   * exists here: leaving is a function call, synchronous, with no event
   * to arrive late and no engine-specific behaviour to reconcile.
   * `teardownPanel` is still idempotent, so a double call is free.
   *
   * History is SYNCED rather than driven: the entry is rewritten in
   * place instead of calling `history.back()`, because `back()` is
   * asynchronous and would land a popstate in the middle of the Save
   * path's handoff into the credential sheet. Rewriting keeps the stack
   * honest about where the user is, at the cost of a Back press that
   * lands on the main page twice — the honest, boring outcome. */
  /** THE DETOUR IS OVER — every exit runs it, because every exit runs
   * `closeStorage`. Installed with the picker below (a forward
   * reference: the ceremony that reacts to leaving a place is built
   * after the place's own teardown, and a no-op until it exists, so the
   * teardown's shape does not depend on how far boot has got). */
  let onPlaceLeft: () => void = () => {};

  const closeStorage = () => {
    teardownPanel();
    showPage("main");
    // The picker, if the user is in the middle of one, re-expands from
    // its band here: they have come back, so the breadcrumb becomes the
    // full choice again — with its lists rebuilt, which is how a
    // just-saved provider is seen to move from "not configured" to
    // "pick one to connect". (Deferred when a ceremony is holding the
    // drawer: see `expandPicker`.)
    onPlaceLeft();
    // THE CHEVRON GOES WITH THE PLACE. Cleared here rather than in each
    // caller, so every exit — Cancel, the Save handoff, browser Back —
    // leaves the strip saying the truth about where the user is. An exit
    // affordance that outlived the place it exits would be the anchor
    // making a false statement, which is the one thing it may not do.
    visor.setBack(null);
    if ((history.state as { page?: string } | null)?.page === "storage") {
      history.replaceState({ page: "main" }, "");
    }
  };

  // THE BROWSER'S OWN BACK BUTTON IS A CLOSE PATH. It was not one before
  // — a modal is not a history entry — and it is the reason the storage
  // page pushes state at all: a place the user can walk to should be a
  // place they can walk back from with the gesture they already know.
  globalThis.addEventListener("popstate", (ev) => {
    if ((ev.state as { page?: string } | null)?.page === "storage") {
      // FORWARD into a storage entry whose session no longer exists. The
      // panel session is not durable (nothing about a half-finished
      // provider configuration should survive a navigation), so the
      // visor refuses to fake one: it rewrites the entry to the main page
      // rather than showing an empty region that looks like a mount that
      // failed.
      history.replaceState({ page: "main" }, "");
    }
    closeStorage();
  });

  // THE STRIP'S LATE-BOUND CONTROLS are the framework's now: the "name
  // it" affordance, the context cluster and the settings button were
  // installed by `registerVisorSheets` above, which also holds the
  // demo's one precondition (the credential-sheet refusal).
  // What remains here is the demo's own entry point into the ceremony,
  // for its driving hooks.
  const requestNaming = sheets.requestNaming;

  // A RELOAD LANDS ON THE MAIN PAGE. The panel session is not durable —
  // there is no half-configured provider to restore — so the boot state
  // is rewritten in place rather than left saying "storage" from a
  // previous visit. `replaceState` and not `pushState`: boot must not add
  // an entry the user did not navigate to.
  history.replaceState({ page: "main" }, "");
  showPage("main");

  /** WALK TO ONE PROVIDER'S CONFIGURATION PAGE. The provider is now a
   * PARAMETER rather than a guess: the page used to open on whatever was
   * stored (or s3) and then offer tabs to switch, which put the CHOICE
   * of provider inside the page — below the bar, in pixels a component
   * can imitate. The choice moved above the bar into the picker, so
   * arriving here means the user already said which provider they were
   * configuring, in trusted chrome, and this page's only job is that
   * one provider's configuration. */
  const openStorage = (provider: ProviderKey = "s3") => {
    // NO SHEET IS CLOSED HERE ANY MORE. The modal used to paint over
    // whatever lightweight sheet was open, so both were closed first;
    // a page slide has nothing to paint over. A sheet is about a
    // SURFACE and says which one, so one that was naming the app stays
    // open, stays correct, and keeps its line on the strip while the
    // page changes underneath it.
    storageNote("");
    showPage("storage");
    // THE STRIP'S OWN WAY OUT, for as long as the user is here. The
    // frame's Cancel button is visor pixels too, but it sits in
    // scrollable content that an app can imitate; this one is in the bar,
    // where nothing but the visor can draw. Every exit runs the SAME
    // `closeStorage`, so there is one teardown path and three doors into
    // it rather than three teardowns to keep in agreement.
    //
    // The label names the RETURN, and it may say the user's own word for
    // the app when they have given it one — user voice is admissible in
    // the visor's own sentence, here exactly as in an announcement. What
    // it never carries is the component's nickname: an attribute cannot
    // be plated, so an app-influenced string in it would be the visor
    // appearing to speak a component's words.
    const home = (appSurface?.petname ?? "").trim().slice(0, 40);
    visor.setBack({
      onBack: () => closeStorage(),
      label: home !== "" ? `back to ${home}` : "back to the app",
    });
    // AND IF A PICKER IS OPEN, IT COLLAPSES TO ITS BAND. Hung on the
    // NAVIGATION rather than on the button that caused it: the band is
    // about being away from the choice, so every door into this place
    // produces it — the picker's own "set it up" entry, and equally a
    // consumer or driver walking here directly. A rule that lived on one
    // button would be a rule with a hole in it.
    bandPicker(providerInfo(provider));
    // A PLACE THE USER CAN WALK BACK FROM. See the popstate handler.
    history.pushState({ page: "storage" }, "");
    mountPanel(provider).catch((e) => {
      region.textContent = `panel failed to mount: ${err(e)}`;
    });
  };

  // --- THE STORAGE PICKER: commitment, above the bar (#22) -----------------
  //
  // The provider CHOICE was the last consequential act still living in
  // forgeable territory. It was the storage page's two tabs: visor
  // pixels by construction, but inside a page that scrolls, adjacent to
  // a component's own rectangle, where an app can paint a convincing
  // copy of the same two buttons. Choosing a provider decides where the
  // user's data goes, so it belongs in the one region no component can
  // draw — a sheet hanging off the pinned strip.
  //
  // TWO LISTS, ON TWO ORTHOGONAL AXES:
  //   (a) CONFIGURED providers, offered for immediate armed SELECTION;
  //   (b) INSTALLED but unconfigured providers, offered for CONFIGURATION.
  // Which list an entry is in follows CONFIG state. Which VOICE it wears
  // follows NAMING state. They are independent, which is why a
  // configured-but-unnamed provider sits in (a) wearing app voice and
  // the NEW marker — it is a thing the user has set up but never given a
  // word to, and the sheet says exactly that.
  //
  // NEW HERE MEANS "YOU HAVE NO WORD FOR THIS", not "first sight this
  // boot" as it does on the strip. A list entry is a standing question
  // ("do you recognise this?"), not an arrival event; the ruling spells
  // the case out — "a configured-but-unnamed provider sits in (a)
  // wearing app voice + NEW" — so unnamed is the test.
  interface PickerSession {
    /** Identity only: each open is its own session object, so a deferred
     * handler can ask whether it is still the current one. */
    opened: number;
  }

  /** One row's identity, resolved the way the STRIP resolves it: by
   * PROVENANCE (the artifact name the visor fetches the panel by), out
   * of the same trust table. Read-only — `marks.load()` rather than
   * `marks.mark()`, because merely LISTING a provider must not create a
   * first-sight record for it. Opening a picker is not meeting a
   * component. */
  const pickerIdentity = (info: InstalledProvider) => {
    const rec = marks.load()[info.artifact];
    const petname = (rec?.petname ?? "").trim();
    return { petname, icon: rec?.icon ?? "", named: petname !== "" };
  };

  /** The entry's identity, in the voice its naming state earns.
   *
   * NAMED -> user voice: the pet icon the user picked and the word they
   * wrote, unquoted, unplated (`markIcon`/`petnameSpan`).
   * UNNAMED -> app voice through the constructor, plus the visor's NEW
   * marker. The plated token is the PROVENANCE KEY, which is what the
   * strip itself shows for a surface that has not run yet: the nickname
   * is a claim only a running component can make, and the picker lists
   * providers that may not have run for weeks. */
  const pickerIdentityNodes = (info: InstalledProvider): Node[] => {
    const { petname, icon, named } = pickerIdentity(info);
    if (named) {
      const nodes: Node[] = [];
      const mark = markIcon(icon);
      if (mark) nodes.push(mark);
      nodes.push(petnameSpan(petname));
      return nodes;
    }
    // App voice ONLY through the constructor (invariant (h)): this file
    // never writes the `foreign` class itself.
    const fresh = document.createElement("span");
    fresh.className = "fresh";
    fresh.textContent = "NEW";
    return [nicknameQuote(info.artifact), fresh];
  };

  const pickerTenant = visor.drawer.tenant<PickerSession>({
    name: "storage-picker",
    // NOT EXCLUSIVE: the credential sheet this one hands off to is, and
    // an exclusive picker would refuse its own successor. Not `dim`med
    // either — the picker deliberately survives a walk to a config page
    // (sheets are orthogonal to navigation), and a dim would grey out
    // the very page it just sent the user to.
    armed: true,
    // The strip names the sheet hanging off it. The picker is about the
    // APP's storage, so the cluster keeps naming the app above and says
    // which visor sheet is open below.
    context: () => (appSurface ? { ...appSurface, kind: "storage" } : null),
    // SUSPENDABLE ONLY WHILE BANDED. During the configuration detour the
    // picker is a breadcrumb, not an occupant — a ceremony started from
    // the strip (naming the arriving panel is the invited case) displaces
    // it sideways and it comes back when that ceremony closes. EXPANDED,
    // it is an occupant like any other and the ordinary eviction rule
    // applies: a user who opens another sheet while looking at the full
    // picker has changed their mind, and a picker that survived that
    // would be re-asserting a choice they walked away from.
    suspendable: () => pickerMode === "band",
  });

  /** THE PICKER'S SHAPE. `expanded` is the full two-list sheet;
   * `band` is the collapsed breadcrumb it wears while the user is off
   * on a provider's configuration page (#22's collapse-to-band). The
   * SESSION is the same throughout — this is one ceremony that changes
   * shape, never a close and a reopen, because "what step of MY ceremony
   * is this" is a question only a surviving session can answer. */
  let pickerMode: "expanded" | "band" = "expanded";
  /** Which entry the band shrink-wraps: the provider the user chose to
   * configure. Null whenever the mode is `expanded`. */
  let bandProvider: InstalledProvider | null = null;

  /** COLLAPSE: the user pressed "set it up" and is being sent to that
   * provider's page. */
  const bandPicker = (info: InstalledProvider) => {
    if (!pickerTenant.isOpen()) return;
    pickerMode = "band";
    bandProvider = info;
    pickerTenant.rebuild();
  };

  /** RE-EXPAND: the detour is over, by whichever door (Cancel, Save, the
   * strip's chevron, browser Back — they all run `closeStorage`).
   *
   * THE LISTS ARE REBUILT, NOT RESTORED, and that is the point of the
   * whole shape change: a provider the user just configured has moved
   * from list (b) to list (a), and seeing it move is the confirmation
   * that the detour did something. Arming restarts with the new
   * presentation, so the entry that appears under the user's cursor
   * cannot be pressed for another ARM_MS.
   *
   * SUSPENDED IS NOT A SPECIAL CASE, it is a DEFERRAL: if a ceremony
   * (naming the panel, say) is holding the drawer when the page exits,
   * the band is off-stage and must stay there — re-expanding underneath
   * a ceremony would be the picker shoving its way back on screen while
   * the user is in the middle of something else. Setting the mode is
   * enough: the host rebuilds from the same builder when it resumes the
   * tenant, and by then the mode says `expanded`. */
  const expandPicker = () => {
    if (!pickerTenant.isOpen()) return;
    pickerMode = "expanded";
    bandProvider = null;
    // No-op while suspended, by the host's own rule — the resume does it.
    pickerTenant.rebuild();
  };

  /** THE BAND — the picker collapsed to a ceremony breadcrumb while the
   * user is off configuring the provider they chose (#22).
   *
   * WHAT IT IS FOR. Two questions are live during the detour and they
   * have different answers: the STRIP says who is drawing the page below
   * ("this is the panel, it is NEW, here is the offer to name it"), and
   * the band says what step of the USER'S OWN ceremony this is ("you
   * were choosing where your data goes; you are configuring this one").
   * Both are trust-grade pixels and together they stay in the two-to-
   * three strip-heights the ruling budgets, which is why the picker
   * shrink-wraps instead of sitting there at full height over the place
   * it just sent the user to.
   *
   * INERT BY CONSTRUCTION. The entry is a plain element, not a control:
   * there is no selection to make here, nothing to arm, and nowhere to
   * navigate — the page below IS the navigation. Building it inert is
   * stronger than disabling a button, because there is no handler to
   * reach at all. The single interaction that survives is DISMISSAL: a
   * user's own sheet is always theirs to close, and closing it ends the
   * ceremony (the return then lands plain, with no picker). */
  const buildPickerBand = (info: InstalledProvider): DrawerSheet => {
    const root = document.createElement("div");
    root.className = "cred-sheet picker-sheet picker-band armed";

    const row = document.createElement("div");
    row.className = "band-row";

    // The chosen entry, in the SAME voice it wore in the list — the
    // user's own word and pet icon if they have named this provider,
    // the plated provenance key and NEW if they have not. A breadcrumb
    // that renamed the thing it is a breadcrumb for would be useless.
    const entry = document.createElement("span");
    entry.className = "band-entry";
    entry.dataset.provider = info.key;
    entry.append(...pickerIdentityNodes(info));

    const status = document.createElement("span");
    status.className = "band-status";
    status.textContent = "configuring — save on the page below";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "band-close";
    close.textContent = "Close";
    close.onclick = () => pickerTenant.close();

    row.append(entry, status, close);
    root.append(row);
    // NO `controls`: nothing here is armed, because nothing here spends.
    return { root };
  };

  // Installed now that the picker exists (see the forward reference at
  // `closeStorage`).
  onPlaceLeft = () => expandPicker();

  let pickerSerial = 0;
  const openPicker = () => {
    // A NEW CEREMONY STARTS EXPANDED, always. The shape is a property of
    // THIS ceremony's progress, and the last one's progress must not
    // leak into it: a picker dismissed while it was a band would
    // otherwise re-open as a band for a detour that is over, offering a
    // breadcrumb to a place nobody is going.
    pickerMode = "expanded";
    bandProvider = null;
    const session: PickerSession = { opened: ++pickerSerial };
    pickerTenant.open(session, () => {
      // THE SAME BUILDER, TWO SHAPES. The host re-invokes this on every
      // presentation — a collapse, a re-expansion, a resume after a
      // ceremony — so the shape is read from the mode each time rather
      // than captured when the ceremony started.
      if (pickerMode === "band" && bandProvider !== null) {
        return buildPickerBand(bandProvider);
      }
      const root = document.createElement("div");
      // `.cred-sheet` is the SHARED SHEET SHAPE every drawer tenant
      // wears (visor.css's note on it), not the credential sheet's
      // private name; `.picker-sheet` carries only what is this sheet's.
      root.className = "cred-sheet picker-sheet";

      const h = document.createElement("h2");
      h.textContent = "Where your data goes";

      const lead = document.createElement("div");
      lead.className = "cred-line said";
      lead.textContent =
        "choosing here connects this app to a provider — the choice is made in the bar's own pixels, never on a page";

      const store = loadStorageStore();
      const configured = INSTALLED_PROVIDERS.filter((p) => store.providers[p.key]);
      const unconfigured = INSTALLED_PROVIDERS.filter((p) => !store.providers[p.key]);

      const armedControls: HTMLButtonElement[] = [];
      const lists = document.createElement("div");
      lists.className = "picker-lists";

      // --- LIST (a): configured, offered for SELECTION -------------------
      const listA = document.createElement("div");
      listA.className = "picker-group";
      listA.id = "picker-configured";
      const headA = document.createElement("div");
      headA.className = "picker-head";
      headA.textContent = configured.length > 0
        ? "configured — pick one to connect"
        : "nothing configured yet";
      listA.append(headA);
      for (const info of configured) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "picker-entry";
        btn.dataset.provider = info.key;
        const line = document.createElement("span");
        line.className = "picker-entry-id";
        line.append(...pickerIdentityNodes(info));
        // The visor's own description of the provider sits BESIDE the
        // identity token, never inside it: framework voice, so it can
        // never be mistaken for something the component said.
        const what = document.createElement("span");
        what.className = "picker-entry-what";
        what.textContent = info.label;
        btn.append(line, what);
        btn.onclick = () => selectProvider(session, info);
        armedControls.push(btn);
        listA.append(btn);
      }

      // --- LIST (b): installed, offered for CONFIGURATION ----------------
      const listB = document.createElement("div");
      listB.className = "picker-group";
      listB.id = "picker-unconfigured";
      if (unconfigured.length > 0) {
        const headB = document.createElement("div");
        headB.className = "picker-head";
        headB.textContent = "installed, not configured yet";
        listB.append(headB);
        for (const info of unconfigured) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "picker-entry";
          btn.dataset.provider = info.key;
          const line = document.createElement("span");
          line.className = "picker-entry-id";
          line.append(...pickerIdentityNodes(info));
          const what = document.createElement("span");
          what.className = "picker-entry-what";
          what.textContent = `${info.label} — set it up`;
          btn.append(line, what);
          // NOT ARMED, deliberately, and this is the same weight-class
          // judgement the naming sheet makes: arming defends an act that
          // SPENDS something against a baited mis-tap. This one walks to
          // a configuration page and can be walked back from with the
          // strip's own chevron. Paying the tax where nothing is spent
          // trains users to click through a delay that means something
          // elsewhere.
          btn.onclick = () => {
            // THE SHEET SURVIVES THE DETOUR, COLLAPSED. Sheets are
            // orthogonal to navigation (the ruling, gated by
            // tenant-precedence), so the ceremony the user started is
            // not closed by the walk to the page it sent them to — but
            // it does not sit at full height over that page either. It
            // shrink-wraps to this entry and waits.
            //
            // ORDER MATTERS: navigate first, collapse second. The band's
            // status line is about a place the user is already in, and
            // `openStorage` mounts the panel, which claims the strip;
            // collapsing first would animate the drawer twice.
            openStorage(info.key);
          };
          listB.append(btn);
        }
      }

      lists.append(listA);
      if (unconfigured.length > 0) lists.append(listB);

      const reason = document.createElement("div");
      reason.className = "cred-reason";
      // Where the visor's refusals land for as long as this sheet is up.
      // IN THE SHEET, which is the move: a destination refusal used to
      // print on the storage page, below the bar, and it is a statement
      // about a commitment the user just tried to make in trusted
      // pixels — so it belongs in the trusted pixels.
      visor.drawer.setNote(reason);

      const note = document.createElement("div");
      note.className = "cred-note";
      note.textContent =
        "a provider is configured on its own page, below this bar; it is only connected here, above it";

      const row = document.createElement("div");
      row.className = "cred-row picker-row";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Close";
      // Cancel is NOT armed: the delay defends against spending, and
      // dismissing the sheet spends nothing. A way out that cannot be
      // taken for the first 700ms is a trap, not a defence.
      cancelBtn.onclick = () => pickerTenant.close();
      row.append(cancelBtn);

      root.append(h, lead, lists, reason, note, row);
      return { root, controls: armedControls };
    });
  };

  /** SELECTION — the one commitment in this flow, and the reason the
   * sheet exists. It runs the destination checks the storage page's Save
   * used to run, then binds and hands off to the credential sheet.
   *
   * WHAT THE CHECKS BECAME. On the page they defended a LIVE PANEL: the
   * visor re-read `destination()` at click time and held it against the
   * binding and against the committed blob, because a component can
   * re-point itself between the render and the click. There is no panel
   * here — the record was written on an earlier visit and has been
   * sitting in storage since — so the TOCTOU those checks defended
   * cannot arise, and the checks that remain are the ones that still
   * mean something about a STORED record:
   *   - it is filed under the provider it claims to be (storage is
   *     hand-editable; a record in the wrong slot would be offered as a
   *     provider it is not);
   *   - the visor can derive a usable destination from it.
   * Each refusal renders IN THIS SHEET, in framework voice, and leaves
   * it open: nothing is bound, no credential is askable for. */
  const selectProvider = (session: PickerSession, info: InstalledProvider) => {
    if (!pickerTenant.owns(session)) return;
    const cfg = loadStorageStore().providers[info.key] ?? null;
    if (cfg === null) {
      drawerNote("that provider has no configuration on this device — set it up first");
      return;
    }
    if (cfg.provider !== info.key) {
      drawerNote("that configuration is filed under a different provider — nothing was connected");
      return;
    }
    const destination = configDestination(cfg);
    if (destination === null) {
      drawerNote("no usable destination in that configuration — nothing was connected");
      return;
    }
    void (async () => {
      // THE BINDING THE FOLLOWING SHEET WILL NAME. `rebind` is what the
      // panel session used to establish keystroke by keystroke; the
      // picker establishes it once, from the record the user just chose,
      // and the credential sheet's binding line reads it exactly as
      // before.
      rebind(destination, { note: false });
      const { prefill, mismatch } = credPrefill(cfg, info.key, destination);
      const held = info.key === "s3" && (await getSigningKey(destination)) !== null;
      if (!pickerTenant.owns(session)) return;
      // Anything the OAuth broker deposited during a panel session is the
      // visor's own capture of a ceremony the visor ran; it survives into
      // the sheet, where the user can see it before releasing it.
      for (const [kind, value] of credValues) {
        if (value !== "") prefill[kind] = value;
      }
      const { petname, icon } = pickerIdentity(info);
      const credSession = {
        cfg,
        destination,
        // WHO ASKED, resolved the same way the row above was: by
        // provenance, out of the trust table. The nickname falls back to
        // the provenance key for a provider that has not run — the same
        // fallback `mountPanel` uses before instantiation.
        surface: {
          name: info.artifact,
          nickname: info.artifact,
          icon,
          isNew: petname === "",
          petname: petname === "" ? undefined : petname,
        } as SurfaceIdentity,
      };
      credentialTenant.claim(credSession);
      // THE CEREMONY IS COMPLETE, so the picker goes. Then the ordering
      // invariant, which survives the move intact and is now enforced in
      // one place instead of depending on where the user was: NO
      // COMPONENT SURFACE IS ALIVE WHEN A SECRET IS ON SCREEN.
      // `closeStorage` retires the panel and leaves the config page — and
      // it is called unconditionally, because the picker can be selected
      // from OVER that page (the sheet survives the detour), which is
      // exactly the state in which a panel would still be live.
      pickerTenant.close({ context: false });
      closeStorage();
      const needs = info.needs;
      if (needs.length === 0) {
        credentialTenant.claim(null);
        const full = withCredentials(cfg);
        clearCredentials();
        persistAndConnect(full);
        return;
      }
      openCredentialDrawer(credSession, [...needs], prefill, mismatch, held);
    })();
  };

  // THE OPENER CARRIES NO PAYLOAD (#22 ruling). The page's "Storage…"
  // button REQUESTS the picker and passes nothing — no preselected
  // provider, no filter, no label. It is the `requestNaming` shape: an
  // app affordance may ask the visor to start one of its ceremonies, and
  // the visor then runs it entirely out of its own state. An argument
  // here would be app influence reaching system UI unmarked — the
  // requesting button would be choosing what the trusted sheet shows.
  (document.getElementById("storage-open") as HTMLButtonElement).onclick = () => openPicker();
  // THE VISOR'S SAVE, DEMOTED TO A CONFIG WRITE (#22 "the storage picker
  // moves above the bar"). It asks the panel for its configuration, the
  // visor decides the configuration is well-formed, the record is
  // written, and the page walks back. That is all it does now.
  //
  // WHAT LEFT, AND WHY IT HAD TO. This handler used to be phase 1 of the
  // two-phase commit: it revalidated the destination, bound it, retired
  // the panel and opened the credential drawer — a COMMITMENT, entered
  // from a button on a page below the bar. The page is visor pixels by
  // construction, but it sits in scrollable content an app can imitate,
  // so the most consequential act in the demo was reachable from the
  // most forgeable place it could be. Binding moved into the picker
  // sheet above the bar, where it is armed and unforgeable. The page's
  // trust sentence collapses to: CONFIGURATION HAPPENS ON THE PAGE;
  // COMMITMENT ONLY ABOVE THE BAR.
  //
  // A panel refusing (none) leaves the page up with its own explanation
  // showing inside its region. Nothing here connects, binds, releases a
  // credential or opens a sheet.
  (document.getElementById("storage-save") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    const active = activePanel;
    if (!active) return;
    active.runner.call(() => active.panel.commit())
      .then((out) => {
        if (out === undefined || out === "") return;
        if (activePanel !== active) return;
        let cfg: StorageConfig | null = null;
        try {
          cfg = JSON.parse(out) as StorageConfig;
        } catch {
          cfg = null;
        }
        // WELL-FORMEDNESS IS STILL THE VISOR'S CALL, even for a write
        // that commits to nothing: a record filed under a provider it
        // does not belong to would be a configuration the picker could
        // later offer as that provider's. The panel is told nothing —
        // the refusal is in the visor's words, on the visor's line.
        if (cfg === null || cfg.provider !== active.provider) {
          storageNote("the panel returned a configuration for a different provider — nothing was saved");
          return;
        }
        // CONFIGURATION, NOT COMMITMENT: the record is written under its
        // provider's key and the BINDING IS UNTOUCHED. A user who
        // configures a provider and walks away is connected to exactly
        // what they were connected to before.
        saveProviderConfig(cfg);
        closeStorage();
        tablet.status(
          "provider configuration saved — choose it in Storage… to connect",
          true,
        );
      })
      .catch((e) => console.warn(`[panel] commit: ${err(e)}`));
  };
  (document.getElementById("storage-cancel") as HTMLButtonElement).onclick = (ev) => {
    ev.preventDefault();
    closeStorage();
  };

  // BOOT ARMS FROM THE BINDING, and only from it. A provider whose
  // record exists but was never selected in the picker is CONFIGURED,
  // not in force: arming from it would be the visor committing on the
  // user's behalf to a destination they never confirmed — precisely the
  // silent choice the picker exists to make explicit. (The one-record
  // device is unaffected: its record adopts its key AND the binding on
  // migration, so a returning user is armed exactly as before.)
  const stored = loadBoundStorage();
  // Migration runs FIRST: a config written before #11 still carries a
  // readable secret, which is escrowed and scrubbed here, so the setup
  // below finds a keystore entry instead of a field.
  await escrowPending(stored);
  if (stored) setupBucket(stored);

  (document.getElementById("revoke-bob") as HTMLButtonElement).onclick = () => {
    enqueue(async () => {
      try {
        await alice.engine.driver.khRevokeMember(part, bob.id);
        // The guarantee note is the point of the beat: cooperative-now
        // (S3) vs. hard + retroactive (Dropbox), in the provider's words.
        const note = await alice.engine.driver.storeRevoke(part, bob.id);
        await alice.engine.driver.bucketFlush(part);
        alice.status(`revoke: ${note}`, true);
        bob.status("REVOKED: new epochs are dark from here", true);
        (document.getElementById("bob-pane") as HTMLElement).classList.add("revoked");
      } catch (e) {
        alice.status(`revoke: ${err(e)}`);
      }
    });
  };

  // Live stats footer per pane (the tablet keeps its setup hint until
  // storage is configured).
  const statsTick = periodic("stats", 4000, async () => {
    for (const p of panes) {
      if (p === tablet && !bucketReady) continue;
      try {
        p.status(await p.engine.driver.stats());
      } catch { /* pane dead */ }
    }
  });

  // --- device pairing + the user-system partition (PAIRING.md §5) -----------
  //
  // WHAT THE USER SEES. Two ceremonies, in the two places §5 puts them:
  //   - ADD (heavy): "Your visor" sheet -> "add a device…" -> a visor
  //     drawer sheet with the code field, the SAS, the statement of
  //     consequence, the arming delay and the never-prefilled device
  //     name. It is a grant of admin over everything in the account, so
  //     it is the most consequential thing this demo can do from the
  //     strip, and it pays the full ceremony.
  //   - JOIN (light): a pane-local affordance in the TABLET pane —
  //     "join existing account" -> QR + grouped code -> SAS -> a single
  //     confirm. Nothing secret is typed and the worst mis-tap is a
  //     cancelled join, so there is no arming tax on it (#22 weight
  //     classes).
  // Both are rendered by visor/ui/pairing.ts. Not one line of this file
  // draws a pairing code or a SAS — that is invariant (f), and it is now
  // a property of the framework layer rather than of this file's good
  // behaviour.
  //
  // WHAT IS DEMOTED (the §5 half that is not a ceremony): the marks
  // (petname + pet icon), the display name and the anchor hue are
  // ACCOUNT state now. localStorage
  // keeps exactly the keys and formats it had — that IS the demotion:
  // the same bytes, no longer the source of truth. Boot renders from
  // them, `reconcileFromDriver` compares them against the partition and
  // ANNOUNCES any difference, and every later commit is written through.
  const pairingNet = new MockPairingNetwork();
  /** One pane's driver, wrapped so every call rides the page's single
   * background chain (see `enqueueValue`). The wrapper is mechanical: it
   * cannot forget a method, because it is built from the object it
   * wraps. */
  const serializedDriver = (raw: PairingDriver): PairingDriver => {
    const out = {} as Record<string, unknown>;
    for (const key of Object.keys(raw) as (keyof PairingDriver)[]) {
      const fn = raw[key];
      if (typeof fn !== "function") continue;
      out[key as string] = (...args: unknown[]) =>
        enqueueValue(() => (fn as (...a: unknown[]) => Promise<unknown>).apply(raw, args));
    }
    return out as unknown as PairingDriver;
  };
  const pairingDriverFor = (pane: Pane): PairingDriver =>
    serializedDriver(
      PAIRING_BACKEND === "engine"
        ? createEnginePairingDriver(pane.engine.driver)
        : createMockDriver(pane.name, pairingNet),
    );
  const aliceUs = pairingDriverFor(alice);
  const tabletUs = pairingDriverFor(tablet);

  /** SERIALIZE IN EXACTLY ONE PLACE. `serializedDriver` already puts
   * every pairing call on the page's one background chain, so a CALLER
   * of the driver must never ALSO wrap itself in `enqueue`/`periodic`:
   * the outer job would sit on the chain awaiting an inner job queued
   * BEHIND it, and the chain would deadlock — permanently, silently, and
   * for every later job too. (Observed exactly once, here, while wiring
   * this in: the join pane's poll went through `periodic`, and from its
   * first tick onward nothing on the page's background chain ever
   * completed again.)
   *
   * So pairing's periodic work uses this instead: the same
   * skip-a-tick-if-the-last-one-is-still-running discipline as
   * `periodic`, and no queueing of its own. */
  const poll = (name: string, everyMs: number, f: () => Promise<unknown>) => {
    let running = false;
    let skipped = 0;
    setInterval(() => {
      if (running) {
        skipped++;
        return;
      }
      running = true;
      f().catch(() => {}).finally(() => {
        running = false;
      });
    }, everyMs);
    return { name, skips: () => skipped };
  };

  // The tablet has NO WIRE in the demo's own choreography (its cards are
  // pasted, see boot's contact-card step). Real pairing rides iroh
  // (guest/src/pairing.rs refuses an unbound instance), so the engine
  // path — and only the engine path — binds it here. In mock mode this
  // is skipped entirely: the mock's "network" is an in-page object, and
  // a relay round-trip the demo does not need is a flake the e2e suite
  // does not need either.
  //
  // The endpoint id the bind returns is KEPT as the proof that the bind
  // HAPPENED: after a join enrolls, the tablet has to dial alice for the
  // user-system sync (see `wireUsSubduction`), and an instance that
  // never bound cannot dial at all. Without this the failure would
  // surface as a mute connection rather than as the missing bind it is.
  let tabletEp: Uint8Array | null = null;
  if (PAIRING_BACKEND === "engine") {
    await enqueue(async () => {
      try {
        tabletEp = unhex(await tablet.engine.driver.irohBind(RELAY));
      } catch (e) {
        tablet.status(`pairing transport unavailable: ${err(e)}`, true);
      }
    });
  }

  /** THE ANNOUNCEMENT SINK. Remotely-caused identity changes belong on
   * the STRIP, in the visor's own voice, with priority over the ambient
   * stats tick — which is exactly what `visorAnnounceSink` builds out of
   * `visor.announce` (visor/ui/pairing.ts). The standalone pairing page
   * passes per-pane status writers instead; the UI does not know the
   * difference. */
  const usAnnounce: AnnounceSink = visorAnnounceSink(visor);

  // The palette index the account stores, out of the angle the visor
  // paints (PAIRING.md §4: `hue` is an INDEX into the framework palette,
  // never a raw angle). An angle the palette does not contain — there is
  // no way to pick one in the settings sheet — falls back to index 0
  // rather than writing a number the other device cannot render.
  const hueIndexOf = (angle: number) => {
    const i = VISOR_HUES.indexOf(angle);
    return i < 0 ? 0 : i;
  };

  /** Boot-time user-system setup on the OWNER pane (the laptop): if this
   * account has no partition yet, create one seeded from what the user
   * has already told the visor — their name and their committed anchor
   * colour. There is no invention here: an unset name stays the empty
   * string (the same NO-FABRICATION rule the identity record follows).
   *
   * Failure is REPORTED, never fatal: a demo that died in boot over the
   * user system would take nine unrelated scenarios with it, and the
   * pane's own status line is where the failure belongs. */
  const usReady = await (async () => {
    const probe = await aliceUs.usProfileGet();
    if (probe.ok) return true;
    const created = await aliceUs.userCreate({
      displayName: visor.identity().name ?? "",
      hue: hueIndexOf(visor.committedHue()),
    });
    if (!created.ok) {
      alice.status(`user-system unavailable (${PAIRING_BACKEND}): ${created.error}`, true);
      console.warn(`[us] user-create failed: ${created.error}`);
      return false;
    }
    return true;
  })();

  if (usReady) {
    // Write-through (§5). The visor has ALREADY written the boot cache
    // and repainted by the time these run — the partition write is the
    // authoritative copy catching up, so a failed write leaves the two
    // out of step and the next reconcile announces it rather than
    // silently papering over it.
    writeThroughMark = (provenance, petname, icon) => {
      void (async () => {
        const res = await aliceUs.usMarkPut({
          provenance,
          petname,
          // The pet icon crosses as the GLYPH ITSELF — the partition
          // holds it opaquely and repairs collisions on exact equality
          // (engine.wit's `us-mark.icon`). No index, no palette: the
          // vocabulary is the visor's, and a device running a different
          // visor build simply refuses to render a glyph it does not
          // know (`isAppMarkIcon`) rather than mis-rendering an index.
          icon,
          createdAt: Date.now(),
          needsReconfirm: false,
        });
        if (!res.ok) alice.status(`could not record the name in your account: ${res.error}`, true);
      })();
    };
    forgetThroughMark = (provenance) => {
      void (async () => {
        const res = await aliceUs.usMarkForget(provenance);
        if (!res.ok) alice.status(`could not forget it in your account: ${res.error}`, true);
      })();
    };
    writeThroughProfile = (displayName, hue) => {
      void (async () => {
        const res = await aliceUs.usProfileSet({ displayName, hue: hueIndexOf(hue) });
        if (!res.ok) alice.status(`could not save your profile: ${res.error}`, true);
      })();
    };

    // RECONCILE, then announce the diff. This is the moment the boot
    // cache stops being the truth: whatever the partition says wins, and
    // a hue or a name that changed underneath the user is announced on
    // the strip rather than quietly applied (#22).
    await reconcileFromDriver(aliceUs, US_CACHE_KEYS, usAnnounce, (profile) => {
      const angle = VISOR_HUES[profile.hue] ?? VISOR_HUES[0];
      if (angle !== visor.committedHue()) visor.commitHue(angle);
    });

    // Announced-never-silent, continuously: every remotely-caused change
    // the account makes is drained onto the strip. Both panes drain their
    // own driver — an event is addressed to a DEVICE, and the tablet is a
    // device of this account once it has joined.
    poll("us-events", 3000, async () => {
      await drainAnnouncements(aliceUs, usAnnounce);
      await drainAnnouncements(tabletUs, usAnnounce);
    });
  }

  /** THE ADD SHEET. Its own drawer tenant, registered last so it cannot
   * outrank the credential sheet, and EXCLUSIVE: while a device is being
   * granted admin over the account, a click on the strip must not be
   * able to slide something else over the ceremony. The tenant is NOT
   * `armed` — the arming delay that matters here is the one
   * visor/ui/pairing.ts puts on the grant button itself, and two
   * different arming delays in one sheet would teach the user that the
   * delay means nothing. */
  const addDeviceTenant = visor.drawer.tenant<{ container: HTMLElement }>({
    name: "add-device",
    exclusive: true,
    dim: true,
    context: () => ({ kind: "settings" }),
  });
  /** THE ADD SESSION'S LIFECYCLE IS NOT THE SHEET'S.
   *
   * The ceremony outlives the surface it was started from: the grant is
   * the user's last required act here, the sheet comes down on it (see
   * `onGranted`), and the session then runs to ENROLLED-or-FAILED with
   * nothing on screen at all. So the poll lives out here, keyed to the
   * SESSION, and stops on `handle.settled()` — never on the sheet being
   * closed, torn down or evicted.
   *
   * Everything it still has to say goes to `usAnnounce`, i.e. the strip,
   * which is the one surface that cannot be closed. */
  let addTicker = 0;
  let addWatchdog = 0;
  const stopAddSession = () => {
    clearInterval(addTicker);
    clearTimeout(addWatchdog);
    addTicker = 0;
    addWatchdog = 0;
  };
  const runAddSession = (handle: AddPaneHandle) => {
    stopAddSession();
    addTicker = setInterval(() => {
      handle.tick().catch(() => {}).finally(() => {
        if (handle.settled()) stopAddSession();
      });
    }, 200) as unknown as number;
  };
  /** A grant that is never answered must not be a silence. The driver
   * reports `failed` for a session that breaks; it has no state for a
   * peer that simply never confirms, so the deadline is the visor's.
   * PAIRING.md §1 puts the offer's own expiry at 120s; this waits a
   * little past it before saying so. */
  const ADD_PEER_DEADLINE_MS = 150_000;
  const armAddWatchdog = (handle: AddPaneHandle) => {
    clearTimeout(addWatchdog);
    addWatchdog = setTimeout(() => {
      if (!handle.settled()) {
        usAnnounce("the new device never finished joining — nothing was added", true);
        stopAddSession();
      }
    }, ADD_PEER_DEADLINE_MS) as unknown as number;
  };

  openAddDevice = () => {
    if (credentialTenant.isOpen()) return;
    const container = document.createElement("div");
    container.className = "cred-sheet";
    container.id = "pair-add-sheet";
    container.style.maxWidth = "72rem";
    container.style.marginLeft = "auto";
    container.style.marginRight = "auto";
    const session = { container };
    const opened = addDeviceTenant.open(session, () => {
      const heading = document.createElement("h2");
      heading.textContent = "Add a device";
      const body = document.createElement("div");
      container.replaceChildren(heading, body);
      // The visor's UI does the whole ceremony; this file supplies the
      // node, the sink and the two lifecycle answers, and gets out of
      // the way.
      const handle = mountAddPane(body, aliceUs, usAnnounce, {
        // "immediate": the settings sheet's "add a device…" WAS the
        // entry affordance, so the sheet opens on the step the user
        // asked for (visor/ui/pairing.ts's `AddEntry`).
        entry: "immediate",
        // THE GRANT CLOSES THE SHEET. The user has nothing left to do on
        // this device, and the sheet is modal-ish: it dims the page. On
        // this one-page demo the dim sits over the "other device", so a
        // sheet that stayed up would make the joiner's confirm —
        // literally the next click the ceremony waits for —
        // unclickable. The session keeps running without it.
        onGranted: () => {
          if (addDeviceTenant.owns(session)) addDeviceTenant.close();
          armAddWatchdog(handle);
        },
      });
      runAddSession(handle);
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      // Closing BEFORE the grant abandons nothing that was granted; the
      // session is still polled (a peer may yet fail, and that is
      // announced) and the user simply stopped watching.
      close.onclick = () => {
        if (addDeviceTenant.owns(session)) addDeviceTenant.close();
      };
      container.append(close);
      return { root: container };
    });
    if (!opened) stopAddSession();
  };

  // THE JOIN AFFORDANCE, in the tablet pane. Built here rather than in
  // web/index.html because it is the visor's, not the page's: the pane
  // is a place the visor drew a device, and this is the visor offering
  // that device a way into the account.
  const tabletPane = document.getElementById("tablet-pane")!;
  const joinHost = document.createElement("div");
  joinHost.id = "tablet-join";
  tabletPane.append(joinHost);
  const joinHandle = mountJoinPane(joinHost, tabletUs, usAnnounce);

  /** THE ADOPTION BEAT (§5): the tablet takes the account's colour and
   * name. The value arrives from the visor's UI; painting the pane is
   * this page's job, exactly as `applyVisorHue` is (the UI reports, the
   * consumer paints).
   *
   * AFTER THE WIRING, NOT AT THE ENROLLMENT EDGE. Enrollment makes the
   * tablet a member and hands it an EMPTY user-system doc; alice's name
   * and colour only arrive over the subduction wired below. Reading at
   * the edge would therefore adopt an empty name and hue 0, once, for
   * ever — which is precisely why `mountJoinPane` no longer reads the
   * profile itself (see its doc comment). Mock mode wires nothing and
   * hands the doc over in-page, so there the wiring call is a no-op and
   * this runs immediately.
   *
   * ONCE: `joinTick` keeps reporting done on every poll, and
   * `wireUsSubduction` is itself retry-bounded, so the latch is here. */
  let adopted = false;
  const adoptFromAccount = async () => {
    if (adopted) return;
    const res = await tabletUs.usProfileGet();
    if (!res.ok) return;
    adopted = true;
    const profile = res.value;
    const angle = VISOR_HUES[profile.hue] ?? VISOR_HUES[0];
    joinHost.style.setProperty("--pm-join-hue", String(angle));
    joinHost.style.background = `oklch(92% .03 ${angle})`;
    // Announced, never silent — both surfaces the pane used to reach:
    // the strip, and the tablet pane's own line.
    usAnnounce(
      `this device now follows your profile: ${profile.displayName || "(unnamed)"}, your colour`,
      true,
    );
    tablet.status(
      `this device now follows your profile: ${profile.displayName || "(unnamed)"}, your colour`,
      true,
    );
  };
  /** POST-ENROLLMENT SYNC — the embedder's half of PAIRING.md §2 step 7.
   *
   * Pairing grants MEMBERSHIP. It does not, by itself, wire subduction
   * between the two devices: the engine leaves that to whoever is
   * embedding it, because only the embedder knows which transport the
   * two ends should meet on. The native act battery does exactly this
   * (engine/host/src/pairing_acts.rs:187 `wire_us` — connect, then
   * sync-start with `subscribe` in BOTH directions), and so does the
   * headless smoke (host/pairing-bringup.ts). Without it the joiner
   * holds a membership and an EMPTY user-system doc, and nothing the
   * laptop writes — a petname, a pet icon, a profile change — can ever
   * reach it.
   *
   * DIRECTION MATTERS, and it is the smoke's: the WRITER accepts and the
   * reader dials — alice `iroh-start`s as the acceptor and the tablet
   * dials her published endpoint (host/pairing-bringup.ts wires the
   * add side as acceptor and the join side as dialler). Measured, not
   * assumed: with the roles reversed the handshake still reports
   * connected on both sides and both sync handles still report ready,
   * but nothing ever reaches the tablet — its user-system replica sits
   * at revision 0 forever while alice's advances. Flagged as a
   * dispatcher-level finding; the demo takes the direction that
   * delivers.
   *
   * Then both sides `sync-start` the enrollment's partition with
   * `subscribe`, so a LATER write on either side is pushed rather than
   * waited for.
   *
   * EXACTLY ONCE PER ENROLLMENT. A second wiring would open a second
   * connection and a second subscription for the same pair, which is
   * pure cost — so the guard is set before the first await, not after
   * the last one. Mock mode never gets here: its "network" is an in-page
   * object with nothing to wire. */
  let usWired = false;
  let usSynced = false;
  let usWireAttempts = 0;
  const US_WIRE_ATTEMPTS = 3;
  const wireUsSubduction = async () => {
    if (PAIRING_BACKEND !== "engine" || usWired) return;
    usWired = true;
    usWireAttempts++;
    try {
      // The enrollment payload is the JOIN side's: `pair-join-status`
      // keeps answering `enrolled` once it has, so reading it back here
      // is a poll rather than a race with the UI's own tick.
      const enrollment = await until("the tablet's enrollment", async () => {
        const res = await tabletUs.pairJoinStatus();
        return res.ok && res.value.tag === "enrolled" ? res.value.enrollment : false;
      }, 30_000, 200);
      const partition = unhex(enrollment.partitionId);
      // The tablet must be BOUND (an unbound instance cannot dial), and
      // alice is the side that is dialled — the same direction the
      // headless smoke proves, with the WRITER accepting and the reader
      // dialling (host/pairing-bringup.ts).
      if (!tabletEp) throw new Error("the tablet never bound an iroh endpoint");
      await enqueue(async () => {
        const ca = await alice.engine.driver.irohStart(
          false,
          new Uint8Array(),
          RELAY,
          new Uint8Array(),
        );
        const ct = await tablet.engine.driver.irohStart(true, aliceEp, RELAY, alice.id);
        await until(
          "us subduction handshake",
          async () =>
            (await alice.engine.driver.connStatus(ca)) &&
            (await tablet.engine.driver.connStatus(ct)),
          30_000,
        );
        for (const [who, e, peer] of [
          ["alice", alice, tablet.id] as const,
          ["tablet", tablet, alice.id] as const,
        ]) {
          const h = await e.engine.driver.syncStart(peer, partition, true);
          await until(
            `${who} subscribes to the user-system doc`,
            () => e.engine.driver.syncStatus(h),
            30_000,
          );
        }
      });
      usSynced = true;
      // The user-visible half of this beat is the adoption announcement
      // `adoptFromAccount` makes on the strip the moment this returns;
      // this line is for the console, where a wiring that silently did
      // not happen would otherwise look exactly like one that did.
      console.log("[us] subduction wired: alice ⇄ tablet on the user-system partition");
    } catch (e) {
      // A transient relay hiccup is worth a second attempt; an endless
      // one would just rewrite the tablet's status line forever, so the
      // retries are counted and the last one is the one that SAYS so.
      if (usWireAttempts < US_WIRE_ATTEMPTS) usWired = false;
      else tablet.status(`could not sync this device with your account: ${err(e)}`, true);
      console.warn(`[us] post-enrollment wiring failed (attempt ${usWireAttempts}): ${err(e)}`);
    }
  };

  // The join pane polls its driver on the ONE chain like everything else
  // (mountJoinPane's `tick` is a single driver read per call). Its `true`
  // is the JOIN-COMPLETED edge, which is the moment the embedder owes
  // the pair a sync path.
  const joinTick = poll("pair-join", 250, async () => {
    if (await joinHandle.tick()) {
      void wireUsSubduction();
      // NOT `await wireUsSubduction(); adopt()` — the wiring's own
      // once-guard returns instantly to every poll after the first
      // while the first is still crossing the relay, so chaining off it
      // would adopt from a doc that has not arrived. `usSynced` is the
      // flag that means it HAS. Mock mode wires nothing, so there the
      // enrollment edge is already the arrival.
      if (PAIRING_BACKEND !== "engine" || usSynced) void adoptFromAccount();
    }
  });

  // Debug/validation handles (the paseo browser driver uses these).
  (globalThis as unknown as Record<string, unknown>).__demo = {
    alice,
    bob,
    tablet,
    part,
    pull,
    bobPull: () => bobPull(),
    /** Walk straight to ONE provider's config page, skipping the picker.
     * Driving only: the USER's way in is the picker, and the page's own
     * opener passes no payload. */
    openStorage: (provider?: ProviderKey) =>
      openStorage(provider ?? loadBoundStorage()?.provider ?? "s3"),
    /** THE PICKER, for driving. `open` clicks nothing — the opener is
     * payload-free by construction, so there is nothing to pass here
     * either. `select`/`configure` CLICK the real entry buttons rather
     * than calling the handlers, so a driver meets the arming delay
     * exactly as a user does: a click before ARM_MS lands on a disabled
     * button and does nothing. */
    picker: {
      open: () => openPicker(),
      isOpen: () => pickerTenant.isOpen(),
      /** What each list holds, by provider key — the lists' membership,
       * without reading it back out of the DOM. */
      lists: () => {
        const store = loadStorageStore();
        return {
          configured: INSTALLED_PROVIDERS.filter((p) => store.providers[p.key]).map((p) => p.key),
          unconfigured: INSTALLED_PROVIDERS.filter((p) => !store.providers[p.key]).map((p) =>
            p.key
          ),
        };
      },
      /** The picker's SHAPE, for driving: `expanded`, `band`, or
       * `suspended` while another ceremony holds the drawer over it. */
      mode: () =>
        !pickerTenant.isOpen()
          ? "closed"
          : pickerTenant.isSuspended()
          ? "suspended"
          : pickerMode,
      /** What the band shrink-wraps, or null when the band is not the
       * drawer's OCCUPANT. `:not(.visor-swap-out)` is the difference
       * between the two: a band that is travelling off-stage is still on
       * screen for the length of the motion (that is the motion), and it
       * has already stopped being the occupant. */
      band: () => {
        const el = drawerInner.querySelector(
          ".picker-band:not(.visor-swap-out) .band-entry",
        ) as HTMLElement | null;
        return el === null ? null : {
          provider: el.dataset.provider ?? "",
          /** A CONTROL would be a mis-tap that spends something; the
           * band's entry is deliberately not one. */
          isControl: el.tagName === "BUTTON",
          entries: drawerInner.querySelectorAll(
            ".picker-band:not(.visor-swap-out) .band-entry",
          ).length,
        };
      },
      /** Click the band's own dismissal — the one interaction it keeps. */
      dismissBand: () =>
        (drawerInner.querySelector(".picker-band .band-close") as HTMLButtonElement | null)?.click(),
      select: (provider: string) =>
        (drawerInner.querySelector(
          `#picker-configured .picker-entry[data-provider="${provider}"]`,
        ) as HTMLButtonElement | null)?.click(),
      configure: (provider: string) =>
        (drawerInner.querySelector(
          `#picker-unconfigured .picker-entry[data-provider="${provider}"]`,
        ) as HTMLButtonElement | null)?.click(),
      close: () => pickerTenant.close(),
    },
    /** The config store, for driving and inspection: which providers have
     * a record, and which one is BOUND (what boot arms from). */
    storageStore: () => {
      const store = loadStorageStore();
      return {
        bound: store.bound,
        configured: INSTALLED_PROVIDERS.filter((p) => store.providers[p.key]).map((p) => p.key),
      };
    },
    // Exposed for driving: re-running setup is also how the in-flight
    // guard is exercised without racing a 20 s consumer-API window.
    setupBucket: (cfg: StorageConfig) => setupBucket(cfg),
    // Backpressure telemetry: queue depth plus per-timer skip counts.
    // If depth climbs monotonically, a periodic driver is queueing.
    health: () => ({
      bgDepth,
      skips: {
        reconcile: reconcile.skips(),
        autoSync: autoSync.skips(),
        stats: statsTick.skips(),
        pairJoin: joinTick.skips(),
        poll: Object.fromEntries(panes.map((p) => [p.name, p.pollSkips ?? 0])),
      },
    }),
    authorize,
    // The isolation claim, made checkable instead of asserted: every
    // surface frame on the page must be UNREACHABLE from the visor's realm.
    // A sandboxed frame without `allow-same-origin` has an opaque origin,
    // so `contentDocument` is null (or throws) — if this ever reports
    // `sameOriginReachable: true`, the sandbox attribute has regressed
    // and the visor's pixels are once again in reach of component code.
    frameProbe: () => {
      const frames = Array.from(document.querySelectorAll("iframe"));
      let reachable = false;
      for (const f of frames) {
        try {
          if (f.contentDocument !== null) reachable = true;
        } catch { /* opaque origin: the expected outcome */ }
      }
      return {
        appFrames: frames.length,
        sameOriginReachable: reachable,
        sandbox: frames.map((f) => f.getAttribute("sandbox")),
      };
    },
    // The panel's granted fetch, exposed so the DENIAL side of the
    // per-destination grant is demonstrable and not merely asserted.
    panelFetch: dropboxFetchImports["polyvisor:fetch/fetch@0.1.0"],
    // The live credential binding, for driving: what the visor believes the
    // held values may be released toward (null = nothing may).
    boundDestination: () => boundDestination,
    // The credential sheet, for driving. `confirm`/`cancel` CLICK the
    // real buttons rather than calling the handlers, so a driver sees the
    // arming delay exactly as a user does: a click before ARM_MS lands on
    // a disabled button and does nothing.
    drawer: {
      open: () => credentialTenant.isOpen(),
      confirm: () =>
        (drawerInner.querySelector(".cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
    },
    // The visor's App settings sheet (the naming ceremony, grown), for
    // driving. `nameIt` clicks the strip's own control — visor pixels,
    // the only place the ceremony can start; `openCluster` clicks the
    // whole left cluster, which is the other way in.
    naming: {
      open: () => sheets.namingOpen(),
      nameIt: () =>
        (document.getElementById("visor-name-it") as HTMLButtonElement | null)?.click(),
      openCluster: () =>
        (document.getElementById("visor-context") as HTMLElement | null)?.click(),
      /** Open the sheet for a named record directly — driving only, and
       * deliberately provenance-keyed: it opens for the surface the visor
       * already holds under that key, never for one synthesised from an
       * argument. Unknown keys open nothing. */
      openFor: (provenance: string) => {
        const known = [appSurface, activePanel?.surface].filter((s): s is SurfaceIdentity => !!s);
        const surface = known.find((s) => s.name === provenance);
        if (!surface) return false;
        requestNaming(surface);
        return true;
      },
      type: (value: string) => {
        const input = drawerInner.querySelector(".name-sheet input") as HTMLInputElement | null;
        if (input) input.value = value;
      },
      /** THE PET-ICON PICKER, as it is actually rendered: the six offers
       * in order, each with the glyph, whether the visor flagged it as
       * the component's own nomination, and whether it is currently
       * picked. A DOM read, deliberately — the claim these scenarios
       * make is about what a user sees on the sheet, not about what the
       * facade computed. */
      offers: () =>
        Array.from(
          drawerInner.querySelectorAll(".name-sheet .name-icons button"),
        ).map((el) => {
          const b = el as HTMLButtonElement;
          return {
            glyph: b.dataset.glyph ?? "",
            nominated: b.dataset.nominated === "true",
            picked: b.classList.contains("picked"),
          };
        }),
      /** The foreign attribution line above the picker, or "" when the
       * surface nominated nothing (or its nomination was refused). */
      nominationLine: () =>
        (drawerInner.querySelector(".name-sheet .name-nomination") as HTMLElement | null)
          ?.textContent ?? "",
      /** Pick a mark by CLICKING its button, exactly as a user does. */
      pickIcon: (glyph: string) =>
        (drawerInner.querySelector(
          `.name-sheet .name-icons button[data-glyph="${glyph}"]`,
        ) as HTMLButtonElement | null)?.click(),
      /** Pick whichever offer the visor flagged as the component's — the
       * adoption gesture, without the scenario having to know which
       * glyph the component asked for. Returns the glyph adopted, or ""
       * when there was no nomination on offer. */
      adoptNomination: () => {
        const b = drawerInner.querySelector(
          '.name-sheet .name-icons button[data-nominated="true"]',
        ) as HTMLButtonElement | null;
        if (!b) return "";
        b.click();
        return b.dataset.glyph ?? "";
      },
      save: () =>
        (drawerInner.querySelector(".name-sheet .cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".name-sheet .cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
      forget: () =>
        (drawerInner.querySelector(".name-sheet .forget") as HTMLButtonElement | null)?.click(),
      reason: () =>
        (drawerInner.querySelector(".name-sheet .cred-reason") as HTMLElement | null)?.textContent ??
          "",
      marks: () => marks.load(),
    },
    // The visor's settings sheet, for driving — mirrors `naming`.
    // `openSheet` CLICKS the strip's own button rather than calling the
    // opener, so a driver exercises the same path a user does (visor
    // pixels, the only place this ceremony can start).
    settings: {
      open: () => sheets.settingsOpen(),
      openSheet: () =>
        (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click(),
      type: (field: "name" | "device", value: string) => {
        const id = field === "name" ? "visor-settings-name" : "visor-settings-device";
        const input = drawerInner.querySelector(`#${id}`) as HTMLInputElement | null;
        if (input) input.value = value;
      },
      pickIcon: (glyph: string) =>
        (drawerInner.querySelector(
          `.settings-icons button[data-glyph="${glyph}"]`,
        ) as HTMLButtonElement | null)?.click(),
      pickHue: (hue: number) =>
        (drawerInner.querySelector(
          `.settings-hues button[data-hue="${hue}"]`,
        ) as HTMLButtonElement | null)?.click(),
      save: () =>
        (drawerInner.querySelector(".settings-sheet .cred-row button:first-child") as
          | HTMLButtonElement
          | null)?.click(),
      cancel: () =>
        (drawerInner.querySelector(".settings-sheet .cred-row button:last-child") as
          | HTMLButtonElement
          | null)?.click(),
      identity: () => visor.identity(),
    },
    // The visor's erase ceremony, for driving — same conventions as
    // `settings`: every control is CLICKED (or, for the confirm input, its
    // value is set the way a user's typing would leave it) rather than
    // invoked through a handler, so a driver sees the arming delay and the
    // typed-confirmation gate exactly as a user does.
    reset: {
      open: () => sheets.resetOpen(),
      // Opens from the settings sheet's own danger button — the only
      // path in (visor/ui/sheets.ts's `requestReset`), matching how a user
      // reaches it: settings must already be open for this to do anything.
      openFromSettings: () =>
        (drawerInner.querySelector("#visor-settings-reset") as HTMLButtonElement | null)?.click(),
      type: (value: string) => {
        const input = drawerInner.querySelector("#visor-reset-confirm") as
          | HTMLInputElement
          | null;
        if (input) input.value = value;
      },
      // Whether the erase button and the confirm input are still behind
      // the arming delay — read as `disabled`, the same enforcement the
      // ceremony itself relies on (visor/ui/sheets.ts's `controls`).
      armingState: () => {
        const btn = drawerInner.querySelector(".reset-sheet .erase-confirm") as
          | HTMLButtonElement
          | null;
        const input = drawerInner.querySelector("#visor-reset-confirm") as
          | HTMLInputElement
          | null;
        return {
          btnDisabled: btn?.disabled ?? null,
          btnText: btn?.textContent ?? "",
          inputDisabled: input?.disabled ?? null,
          armed: drawerInner.querySelector(".reset-sheet")?.classList.contains("armed") ?? false,
        };
      },
      erase: () =>
        (drawerInner.querySelector(".reset-sheet .erase-confirm") as HTMLButtonElement | null)
          ?.click(),
      cancel: () => {
        const btns = Array.from(
          drawerInner.querySelectorAll(".reset-sheet .cred-row button"),
        ) as HTMLButtonElement[];
        btns.find((b) => b.textContent === "Cancel")?.click();
      },
      reason: () =>
        (drawerInner.querySelector(".reset-sheet .cred-reason") as HTMLElement | null)
          ?.textContent ?? "",
    },
    /** The pairing ceremonies, for driving. Every one of these CLICKS a
     * real control — the arming delay, the disabled grant button and the
     * empty device-name field are seen exactly as a user sees them. The
     * two SAS readers are DOM reads on purpose: the claim under test is
     * that the same six digits are on both surfaces, which is a claim
     * about pixels, not about the driver. */
    pairing: {
      backend: () => PAIRING_BACKEND,
      /** Open the add ceremony the way a user does: the strip's settings
       * button, then the sheet's own "add a device…" action. */
      openAdd: () => {
        (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
        (drawerInner.querySelector(
          '.settings-extra-action[data-action="add-device"]',
        ) as HTMLButtonElement | null)?.click();
      },
      addOpen: () => addDeviceTenant.isOpen(),
      /** Close it the way a user does: the sheet's own Close button. */
      closeAdd: () => {
        const btns = Array.from(
          drawerInner.querySelectorAll("#pair-add-sheet button"),
        ) as HTMLButtonElement[];
        btns.find((b) => b.textContent === "Close")?.click();
      },
      /** The tablet's own affordance. */
      joinStart: () =>
        (joinHost.querySelector("button") as HTMLButtonElement | null)?.click(),
      /** The 79-char code as the JOIN pane renders it, ungrouped. */
      code: () =>
        (joinHost.querySelector(".pm-code") as HTMLElement | null)?.textContent?.replace(
          /\s+/g,
          "",
        ) ?? "",
      pasteCode: (code: string) => {
        const ta = drawerInner.querySelector("#pair-add-sheet textarea") as
          | HTMLTextAreaElement
          | null;
        if (!ta) return false;
        ta.value = code;
        return true;
      },
      connect: () => {
        const btns = Array.from(
          drawerInner.querySelectorAll("#pair-add-sheet button"),
        ) as HTMLButtonElement[];
        btns.find((b) => b.textContent === "connect")?.click();
        return true;
      },
      sasAdd: () =>
        (drawerInner.querySelector("#pair-add-sheet .pm-sas") as HTMLElement | null)
          ?.textContent ?? "",
      sasJoin: () =>
        (joinHost.querySelector(".pm-sas") as HTMLElement | null)?.textContent ?? "",
      /** "codes match — continue" on the add side: SAS -> consequence. */
      sasContinue: () => {
        const btns = Array.from(
          drawerInner.querySelectorAll("#pair-add-sheet button"),
        ) as HTMLButtonElement[];
        btns.find((b) => (b.textContent ?? "").includes("codes match"))?.click();
      },
      /** The heavy ceremony's own controls. `grant` CLICKS: before the
       * arming delay elapses the click lands on a disabled button and
       * does nothing, which is the property worth testing. */
      consequence: () =>
        (drawerInner.querySelector("#pair-add-sheet .pm-consequence") as HTMLElement | null)
          ?.textContent ?? "",
      grantArmed: () => {
        const b = drawerInner.querySelector("#pair-add-sheet button.pm-armed") as
          | HTMLButtonElement
          | null;
        return b === null ? null : !b.disabled;
      },
      deviceName: () =>
        (drawerInner.querySelector("#pair-add-sheet input[type=text]") as HTMLInputElement | null)
          ?.value ?? null,
      typeDeviceName: (value: string) => {
        const input = drawerInner.querySelector("#pair-add-sheet input[type=text]") as
          | HTMLInputElement
          | null;
        if (input) input.value = value;
      },
      grant: () =>
        (drawerInner.querySelector("#pair-add-sheet button.pm-armed") as HTMLButtonElement | null)
          ?.click(),
      /** The join side's LIGHT confirm ("I initiated this — codes match"). */
      joinConfirm: () => {
        const btns = Array.from(joinHost.querySelectorAll("button")) as HTMLButtonElement[];
        btns.find((b) => (b.textContent ?? "").includes("I initiated"))?.click();
      },
      /** Drain both sides' status once, without waiting on the timers. */
      tick: async () => {
        await joinHandle.tick();
        await drainAnnouncements(aliceUs, usAnnounce);
        await drainAnnouncements(tabletUs, usAnnounce);
      },
      devices: async () => {
        const res = await aliceUs.usDevicesList();
        return res.ok ? res.value : [];
      },
      marks: async () => {
        const res = await tabletUs.usMarksList();
        return res.ok ? res.value : { error: true };
      },
      putMark: async (provenance: string, petname: string, icon: string) => {
        const res = await aliceUs.usMarkPut({
          provenance,
          petname,
          icon,
          createdAt: Date.now(),
          needsReconfirm: false,
        });
        return res.ok;
      },
      usReady: () => usReady,
      /** Whether the embedder has finished wiring subduction between
       * this account's two devices (engine path only — the mock has no
       * transport to wire, so it is never true there). Diagnostics: the
       * write-through beats converge only once this is up. */
      usSynced: () => usSynced,
    },
    /** The app's own row in the trust table, as the visor registered it at
     * boot: provenance key, self-declared nickname, assigned mark, the
     * user's petname if any. Driving/inspection only. */
    appSurface: () => appSurface,
  };

  say("ready — E2E-encrypted, three replicas, two sync paths");
}

boot().catch((e) => {
  console.error(e);
  const banner = document.getElementById("banner")!;
  banner.textContent = `boot failed: ${err(e)}`;
  const help = document.createElement("pre");
  help.style.cssText = "margin:.5em 0 0; font-size:11px; color:#f5c16c; white-space:pre-wrap";
  help.textContent = INFRA_HELP;
  banner.appendChild(help);
});
