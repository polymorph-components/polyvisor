// End-to-end scenarios for the demo visor, in a REAL browser — Chromium
// for all but one of them, and Firefox for the one Gecko smoke beat.
//
//   just e2e            (builds the site first, then runs this)
//   deno run -A e2e/run.ts [scenario-name ...]
//
// WHY THIS EXISTS. Every visor and storage flow in this demo has so far
// been driven BY HAND in a browser, once per session, by whoever last
// touched it. That is not a regression test: it is a memory. Worse, the
// hand-driving surface was paseo's embedded webview, which is not a
// reference environment — it eats `<dialog>` close events, forces
// prefers-reduced-motion and cannot see into sandboxed frames, so
// several claims about this visor were literally unverifiable there
// (scenarios/storage-page-navigation.ts carries the history: it began as
// `dialog-close-retirement`, whose whole subject was a `<dialog>` close
// event that webview never delivered).
//
// So: Playwright driving a real headless Chromium, as a LIBRARY from
// Deno — no @playwright/test, no package.json, no second toolchain. The
// output discipline is the tasks-engine act runner's: sequential acts,
// a loud line per claim, and a non-zero exit if any of them broke.
//
// The harness owns the world the scenarios run in: a static server for
// the built `serve/` directory, a MinIO with CORS open (the credential
// beats need a real S3 to talk to, and one of them needs it DOWN), an
// iroh relay (every engine instance binds an endpoint through one, and
// the pairing ceremony actually crosses it), and the browsers. Each
// scenario gets a fresh browser context, so no scenario can pass because
// of something another one left in storage — and nothing here reaches
// off this machine.

import { chromium, firefox } from "npm:playwright@1.57.0";
import type { Browser, Page } from "npm:playwright@1.57.0";
import { serveDir } from "jsr:@std/http@1.0.13/file-server";
import {
  actCount,
  type Ctx,
  type FreshOptions,
  newContext,
  pageUrl,
  RendererGoneError,
  resetActs,
  waitForBoot,
} from "./util.ts";
import { type SeverableProxy, startTcpProxy } from "./proxy.ts";

import bootAppSurface from "./scenarios/boot-app-surface.ts";
import petnameCeremony from "./scenarios/petname-ceremony.ts";
import settingsIdentity from "./scenarios/settings-identity.ts";
import stripGeometry from "./scenarios/strip-geometry.ts";
import credentialFlow from "./scenarios/credential-flow.ts";
import transportRefusal from "./scenarios/transport-refusal.ts";
import tenantPrecedence from "./scenarios/tenant-precedence.ts";
import storagePageNavigation from "./scenarios/storage-page-navigation.ts";
import storagePicker from "./scenarios/storage-picker.ts";
import drawerAnnouncements from "./scenarios/drawer-announcements.ts";
import stripOwnership from "./scenarios/strip-ownership.ts";
import devicePairing from "./scenarios/device-pairing.ts";
import devicePairingMock from "./scenarios/device-pairing-mock.ts";
import soloPairing from "./scenarios/solo-pairing.ts";
import soloPersistence from "./scenarios/solo-persistence.ts";
import soloErase from "./scenarios/solo-erase.ts";
import soloResumeSync from "./scenarios/solo-resume-sync.ts";
import soloEphemeral from "./scenarios/solo-ephemeral.ts";
import soloStorage from "./scenarios/solo-storage.ts";
import soloGdrive from "./scenarios/solo-gdrive.ts";
import drawerOverflow from "./scenarios/drawer-overflow.ts";
import soloAccountStorage from "./scenarios/solo-account-storage.ts";
import soloOfflineSync from "./scenarios/solo-offline-sync.ts";
import soloPasskey from "./scenarios/solo-passkey.ts";
import soloRecovery from "./scenarios/solo-recovery.ts";
import soloRecoveryFile from "./scenarios/solo-recovery-file.ts";
import visorReset from "./scenarios/visor-reset.ts";
import firefoxSmoke from "./scenarios/firefox-smoke.ts";
import crossEnginePairing from "./scenarios/cross-engine-pairing.ts";
import workerEviction from "./scenarios/worker-eviction.ts";
import harnessFaults from "./scenarios/harness-faults.ts";
import storeOutageRecovery from "./scenarios/store-outage-recovery.ts";
import oneSidedReload from "./scenarios/one-sided-reload.ts";
import relayPartition from "./scenarios/relay-partition.ts";
import relayPartitionAsym from "./scenarios/relay-partition-asym.ts";

// Re-exported so a scenario imports its whole contract from one place:
// `Scenario` and the `Ctx` it is handed.
export type { Ctx, FreshOptions };

export interface Scenario {
  /** Selector name, and what the summary calls it. */
  name: string;
  /** One line: the claim the whole scenario is making. */
  why: string;
  /** Options for the page the runner opens and boots for this scenario.
   * A function when the seed depends on the world — MinIO's port is
   * ephemeral, so a stored storage config can only be written once the
   * harness knows it. */
  page?: FreshOptions | ((ctx: Ctx) => FreshOptions);
  /** Whether the store must be reachable. `down` stops MinIO for the
   * duration and brings it back afterwards. */
  minio?: "up" | "down";
  /** Which browser drives this scenario. Chromium unless named: the
   * suite is a Chromium suite plus ONE Gecko smoke beat, deliberately —
   * see `firefox-smoke` and the `FIREFOX_PREFS` note below. */
  engine?: "chromium" | "firefox";
  /** A scenario expected to FAIL right now — a known gap being tracked
   * rather than hidden. An `expected: "red"` scenario that fails is
   * recorded `ok` with an `(xfail: expected red)` marker in the
   * summary; one that PASSES is recorded as a FAILURE (the gate has
   * flipped — promote it to green by dropping this flag, don't leave a
   * silently-passing xfail in the suite). A CRASH-SHAPED failure
   * (RendererGoneError, a scenario deadline, or a delivered crash
   * event) is never read as "the expected red": it still retries under
   * the same rule as every other scenario, because a renderer SEGV is
   * an environment flake, not the fault this flag exists to track. */
  expected?: "red";
  /** Overrides `SCENARIO_DEADLINE_MS` for this one scenario. Partition
   * scenarios legitimately wait out several real relay pull cadences
   * (45s each) in a single run, which the suite-wide deadline was never
   * sized for. */
  deadlineMs?: number;
  run(page: Page, ctx: Ctx): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  bootAppSurface,
  // THE HARNESS'S OWN FAULT-INJECTION MACHINERY, tested against ITSELF
  // rather than the demo. It needs no engine boot at all (`page: {
  // noWait: true }`), so it runs early and cheaply — a broken proxy or
  // relay stop/start would otherwise surface as a mysterious failure in
  // whatever partition scenario used it first, several minutes later.
  harnessFaults,
  petnameCeremony,
  settingsIdentity,
  stripGeometry,
  // The credential beats come before the refusal beat: one needs the
  // store up, the next needs it down, and a scenario that has to bring
  // infrastructure back is cheaper than one that has to configure it.
  credentialFlow,
  transportRefusal,
  tenantPrecedence,
  storagePicker,
  // THE NON-VISUAL HALF of everything the two scenarios above assert
  // visually: the same drawer, read through #visor-live. It follows them
  // because a failure here with those green says the fault is in the
  // spoken channel rather than in the drawer.
  drawerAnnouncements,
  storagePageNavigation,
  // The two pairing ceremonies, run TWICE against the two
  // implementations of the same `PairingDriver` seam (shared acts in
  // scenarios/device-pairing-acts.ts).
  //
  // The mock goes first: it is fast, needs no transport at all, and a
  // failure in it means the fault is in the visor's own ceremonies
  // rather than in the engine or the relay. The real one follows and is
  // the claim the demo actually ships — a live engine ceremony over the
  // harness's own relay, ENROLL included.
  devicePairingMock,
  devicePairing,
  // THE SOLO PAGE: the same ceremony again, but across TWO INDEPENDENT
  // PAGES in two isolated contexts. It runs after the one-page pairing
  // scenarios on purpose — a failure here with those two green says the
  // fault is in what a real second device has to do for itself (dial the
  // enrollment's peer ids, discover the tasks partition through the
  // account), not in the ceremony.
  soloPairing,
  // THE DEVICE STORE'S OWN TWO (PERSISTENCE.md's T-E). They follow the
  // pairing scenario because they are about what a device is BETWEEN
  // ceremonies — kept, reloaded, resealed, or never kept at all — and a
  // failure here with solo-pairing green says the fault is in the device
  // store rather than in anything the two pages say to each other.
  //
  // Persistence first: it is the one whose beats a reader should meet in
  // order (try, keep, reload, reseal), and the ephemeral one is the
  // negative space around it.
  soloPersistence,
  // And the way a device LEAVES. It follows persistence directly
  // because it is the same subject read backwards: persistence proves
  // the namespace survives a reload, this proves the erase ceremony
  // takes it away — and a failure here with persistence green says the
  // fault is in the erasure rather than in anything the device does
  // between ceremonies.
  soloErase,
  // AND THE STATE BETWEEN CEREMONIES, which is where the account lives
  // most of the time: both devices of a paired account close and reopen,
  // and sync has to come back WITHOUT a ceremony. It runs after
  // solo-pairing (which proves the ceremony) and after solo-persistence
  // (which proves a device survives a reload with the same transport
  // address) because it depends on both: a failure here with those two
  // green says the fault is in the resume wiring — the device directory,
  // the role read out of it, the acceptor and the dial — rather than in
  // anything either of them covers.
  soloResumeSync,
  // AND ITS ONE-SIDED SIBLING, GREEN SINCE #113: solo-resume-sync proves
  // the both-sides reload recovers; this one proves the harder half —
  // only the ACCEPTOR reloads, and the reader, holding a handle to a page
  // that no longer exists, has to notice and dial again. It was pinned
  // `expected: "red"` from PR #108 until #113 landed a `conn-status` that
  // reports a wire that DIED (the `gone:` marker) and a solo-page
  // wire-keeper that re-dials on it — and only on it, so a healthy peer
  // is never double-dialled. Measured heal: 35s, three runs, dominated by
  // the pinned endpoint's QUIC idle timeout (nothing under the reader's
  // side dies when a peer merely vanishes, so the wire ends on a timer
  // rather than on an error). It runs here, after the resume family,
  // because its preconditions are exactly theirs.
  oneSidedReload,
  soloEphemeral,
  // THE WORKER HOST'S STORAGE EGRESS (STORAGE-EGRESS.md's T-E): the same
  // sheet the two device-store scenarios above just proved a device
  // KEEPS itself through, now driven all the way to a real MinIO — bind,
  // reload, reseal and unbind, with MinIO's own filesystem as the
  // witness that bytes actually left the browser. It follows them
  // because a failure here with solo-persistence green says the fault is
  // in the store-egress wiring, not in the device store underneath it.
  soloStorage,
  // THE STORE THAT COMES BACK (runtime/SYNC.md §3's backoff): the same
  // MinIO binding solo-storage just proved, now with the store dying
  // MID-SESSION and returning. transport-refusal pins the honest
  // failure of a store that is down from the start; this pins the
  // RECOVERY — failures counted, the announcement made, and the
  // worker's own backoff retry healing everything with nobody pressing
  // anything. It follows solo-storage because it uses that scenario's
  // ceremony as a precondition: a failure here with solo-storage green
  // says the fault is in the schedule's recovery, not in the binding.
  storeOutageRecovery,
  // GOOGLE DRIVE FROM THE WORKER HOST (runtime/DRIVE.md's e2e gate): the
  // same solo page, the same fresh context, but this one needs no MinIO
  // at all — it drives its own in-process fake Drive instead, and runs
  // right after the S3 storage scenario without disturbing the
  // harness's MinIO (which stays up regardless, for everything after
  // it). The real popup path is the point: the worker mints PKCE, the
  // page only ever opens a window and relays a one-shot code.
  soloGdrive,
  // THE OPEN DRAWER'S GEOMETRY ON A PHONE. It follows solo-gdrive
  // because it drives the same storage sheet, and it needs that sheet's
  // ASYNC FILL to be working before its own claims mean anything: what
  // it asserts is that the drawer's BOX keeps up with content that
  // arrives late, that the assembly leaves a band of app surface
  // showing, and that a gesture inside the visor stays inside it. It
  // needs no MinIO and no fake Drive — nothing here connects to
  // anything, and the connect button is only checked for reachability.
  drawerOverflow,
  // THE ACCOUNT'S STORAGE RECORD (DRIVE.md, "The account syncs its
  // storage config; devices keep their credentials"): the pairing
  // scenario's two isolated contexts and the Drive scenario's fake, in
  // one story — A binds and writes the destination through the account,
  // B announces the change and then adopts it with nothing typed but a
  // consent click. It runs directly after solo-gdrive because a failure
  // here with that one green says the fault is in the SYNC of the
  // config, not in the Drive ceremony it reuses wholesale.
  soloAccountStorage,
  // AND THE ROUND'S PRODUCT CLAIM (runtime/SYNC.md's Gates, "the money
  // shot — OFFLINE SYNC): the same two-context account and the same
  // fake, but this time both pages CLOSE and a todo still crosses. It
  // runs directly after solo-account-storage because it uses that
  // scenario's ceremony as its precondition — A binds, B adopts with a
  // consent click — and a failure here with that one green says the
  // fault is in the SCHEDULE (the worker's debounced flush, the boot
  // pull) rather than in anything about pairing, adoption or the Drive
  // ceremony underneath it.
  soloOfflineSync,
  // THE WORKER THAT DIES WITH NO GOODBYE, at product level: B's whole
  // engine host (its SharedWorker) is evicted via CDP while A keeps
  // working, and the user-shaped recovery — reload the tab — brings the
  // same device back from its checkpoint and the account converges
  // again. It runs after solo-account-storage and solo-offline-sync
  // because it uses their ceremony and their channels as preconditions:
  // a failure here with both of those green says the fault is in the
  // eviction/recovery path, not in pairing, adoption or the schedule.
  // The mechanics underneath are pinned one level down in devstore rows
  // 51-56 (lock release, the silent port, checkpoint intactness).
  workerEviction,
  // THE PRF RUNG (passkey unseal, PERSISTENCE.md). Follows the device
  // store's other two for the same reason they follow solo-pairing: a
  // failure here with those two green says the fault is in the passkey
  // rung specifically (its own ceremony, its own never-auto-unseal
  // rule) rather than in the device store's persistence machinery in
  // general. It is the one solo scenario that has to leave the
  // harness's usual 127.0.0.1 origin — WebAuthn refuses an IP-address
  // origin outright — so it runs last among the solo trio, in case a
  // page left on a different origin has any surprise for whatever
  // follows (nothing in this suite currently depends on that, but nor
  // did the observation cost anything to write down).
  soloPasskey,
  // ACCOUNT RECOVERY (runtime/RECOVERY.md's T-C gate) — the round's
  // money shot, and the only pair of scenarios in this suite that
  // DESTROY a browser context mid-story rather than merely reloading.
  //
  // THEY RUN HERE, after every storage scenario, because they consume
  // all of it: an account, a bound bucket, a flush that actually landed,
  // and then a wiped browser that has to find its way back to the
  // account with nothing but a phrase (or a file) and the credentials
  // the user remembers. A failure here with solo-storage and
  // solo-offline-sync green says the fault is in the RECOVERY path — the
  // kit ceremony, the restore bring-up, the consume — and not in the
  // egress or the schedule it rides on.
  //
  // The phrase kind goes first: it is the record's primary kind, it
  // needs no filesystem, and a failure in it makes the file kind's
  // failure much easier to read.
  soloRecovery,
  soloRecoveryFile,
  // THE TWO RELAY-PARTITION SCENARIOS, green since #113 landed end to
  // end and the last of the `expected: "red"` pins from PR #108 to be
  // dropped. Between them they claim that a paired account survives its
  // RELAY going away — vanishing for everyone, and vanishing for one
  // device while the other stays connected — with both pages open the
  // whole time and nobody reloading, re-pairing or pressing anything.
  // Three waves of gap had to close for that: the ceremony wires that
  // never re-dialled and the `conn-status` latch that made re-dialling
  // unsafe (#113 as filed), then the page's wire-keeper, then the stale
  // transport chain in the engine that the wire-keeper uncovered. The
  // scenarios' own banners carry all three, and demo/host's
  // `conn-gone-check.ts` and `rebind-sync-check.ts` are the headless
  // gates under them.
  //
  // STILL LATE, AND STILL FOR THE OLD REASON, though the cost has
  // collapsed: ~39s each now (it was ~184s while each spent its whole
  // HEAL_MS proving a heal that never came), and what remains is two
  // deliberate 30s windows per scenario — the control crossing's bound
  // and the negative assertion that the partition is real. That is still
  // the most expensive pair in the suite, so they run after everything
  // whose failure would explain theirs: pairing, convergence, and the
  // harness's own fault levers are all claims made green above.
  relayPartition,
  relayPartitionAsym,
  // The erase ceremony: seeds a name, a petname and a storage sentinel,
  // then reloads the page (twice) as part of its own claim. It runs
  // after the other identity/naming scenarios and before the one that
  // must stay last, on its own fresh context either way.
  visorReset,
  // Second to last: it provokes the visor-timer races, so it is the
  // scenario most likely to leave a page in an interesting state — and
  // it gets a fresh context either way.
  stripOwnership,
  // LAST, and in a different browser. Firefox is launched lazily, so
  // putting the only Gecko beat at the end means a run that fails
  // earlier never pays for a second browser at all — and a Chromium
  // suite that is already green is the right place to ask "and does it
  // work under the other engine".
  firefoxSmoke,
  // AND THE ONE THAT NEEDS BOTH BROWSERS AT ONCE: a Chromium device and
  // a Firefox device paired over the relay, converging both ways. It
  // sits here for exactly firefoxSmoke's reason, cited above — Firefox
  // is launched lazily, so a run that failed earlier must never pay for
  // a second browser, and a Chromium suite that is already green is the
  // right place to ask the cross-engine question.
  //
  // AFTER firefoxSmoke rather than before it, which is the ordering
  // argument the solo family uses throughout: firefoxSmoke proves Gecko
  // can boot the engine and keep a device AT ALL, and solo-pairing
  // proves the ceremony works between two devices. A failure HERE with
  // both of those green says the fault is in something only two
  // DIFFERENT engines can break — a wire format, a transcript, a
  // subduction across runtimes — rather than in Gecko or in the
  // ceremony. It also inherits firefoxSmoke's warm Firefox process
  // (run.ts's `browserFor` keeps the one handle), so the launch is paid
  // for once.
  crossEnginePairing,
];

const here = new URL(".", import.meta.url).pathname;
const demoRoot = new URL("../", import.meta.url).pathname;

// --- the static site -------------------------------------------------------

async function freePort(): Promise<number> {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return await Promise.resolve(port);
}

function serveSite(root: string, port: number): Deno.HttpServer {
  return Deno.serve({
    port,
    // BOUND TO ALL INTERFACES, not just 127.0.0.1 — solo-passkey.ts
    // needs this site reachable on `localhost` too: WebAuthn refuses an
    // IP-address origin with a synchronous SecurityError before the
    // authenticator is even consulted (wosh's browser-passkey.mjs
    // finding #1, cited in spikes/prf-unseal/run.ts, which binds its own
    // throwaway server the same way — "some resolvers prefer ::1").
    // Every OTHER scenario keeps using the 127.0.0.1 URL `ctx.baseUrl`
    // hands them; this only widens what the socket ACCEPTS.
    hostname: "0.0.0.0",
    onListen: () => {},
  }, (req) =>
    serveDir(req, {
      fsRoot: root,
      quiet: true,
      // REQUIRED, not a convenience. The surface frame is sandboxed
      // WITHOUT `allow-same-origin`, so its origin is opaque ("null") —
      // and a script fetch from an opaque origin is a cross-origin
      // request. Without these headers frame.js is blocked and the demo
      // wedges at "mounting apps…". `just serve` gets this from the
      // file-server CLI, which sends them by default; serveDir does not.
      enableCors: true,
      // A missing artifact must be a 404 the page reports rather than a
      // directory listing it tries to instantiate.
      showDirListing: false,
    }));
}

// --- MinIO -----------------------------------------------------------------

const MINIO_BIN = `${demoRoot}../engine/.deps/minio`;
const MINIO_USER = "minioadmin";
const MINIO_PASS = "minioadmin";

class Minio {
  #proc: Deno.ChildProcess | null = null;
  #data: string | null = null;
  readonly url: string;
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  /** MinIO's own on-disk data directory — the filesystem witness a
   * scenario reads a bucket's objects off directly, rather than through
   * anything it is trying to prove (solo-storage.ts). */
  get dataDir(): string | null {
    return this.#data;
  }

  async start(): Promise<void> {
    if (this.#proc) return;
    // A FRESH data directory per run: a previous run's buckets, grants
    // and revoked pickup objects must never be what makes a beat pass.
    this.#data ??= await Deno.makeTempDir({ prefix: "pm-e2e-minio." });
    this.#proc = new Deno.Command(MINIO_BIN, {
      args: ["server", this.#data, "--address", `127.0.0.1:${this.#port}`, "--quiet"],
      env: {
        MINIO_ROOT_USER: MINIO_USER,
        MINIO_ROOT_PASSWORD: MINIO_PASS,
        // Chrome will not let the page's fetch reach the store without
        // it; the demo's own `just infra` sets exactly this.
        MINIO_API_CORS_ALLOW_ORIGIN: "*",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    for (let i = 0; i < 120; i++) {
      try {
        // Bounded: a fetch that SYN-hangs would otherwise wedge start()
        // forever — every harness wait must have a deadline.
        const r = await fetch(`${this.url}/minio/health/live`, {
          signal: AbortSignal.timeout(2_000),
        });
        await r.body?.cancel();
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("minio never became healthy");
  }

  async stop(): Promise<void> {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
    await proc.status;
    // The port must actually be refusing connections before a scenario
    // asserts on a transport failure — otherwise it races the socket.
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.url}/minio/health/live`, {
          signal: AbortSignal.timeout(2_000),
        });
        await r.body?.cancel();
      } catch (e) {
        // Connection refused is the state this loop exists to reach. A
        // TIMEOUT is not refusal — the port answered nothing either way,
        // and a scenario asserting on transport refusal must not be told
        // the socket is closed while a slow server still holds it.
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("minio kept answering after being killed");
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.#data) await Deno.remove(this.#data, { recursive: true }).catch(() => {});
  }
}

// --- the local relay -------------------------------------------------------
//
// HERMETIC, like MinIO. Every engine instance in this demo binds an iroh
// endpoint through a relay, and until this existed that relay was n0's
// PUBLIC one: the boot wire step (alice ⇄ bob) and now the real pairing
// ceremony both went out over the internet, so the suite's result
// depended on a third party's availability and latency. That is not a
// regression test either.
//
// So the harness owns a relay too — the same pinned binary the engine
// spike installs (`cd engine && just relay-bin`, iroh-relay@1.0.3), on
// an EPHEMERAL port, and every page URL carries `?relay=…` pointing at
// it (see `baseQuery` below).
//
// THE PORT COMES FROM A CONFIG FILE, not a flag: the CLI offers exactly
// `--dev` and `-c/--config-path` (iroh-relay 1.0.3 src/main.rs), and
// `--dev` hard-codes 3340 — which two suites running side by side would
// fight over. `--dev` is still passed, because it is what turns TLS off;
// an explicit `http_bind_addr` in the config wins over its default (main.rs:
// `if cfg.http_bind_addr.is_none()`). `enable_metrics = false` matters
// for the same collision reason: the metrics listener otherwise defaults
// to :9090 and a second relay would fail to bind it.
const RELAY_BIN = `${demoRoot}../engine/.deps/relay/bin/iroh-relay`;

class Relay {
  #proc: Deno.ChildProcess | null = null;
  #dir: string | null = null;
  readonly url: string;
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  /** For `ctx.relayProxy()`, which needs the real relay's port to dial
   * as its own upstream. */
  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    if (this.#proc) return;
    try {
      await Deno.stat(RELAY_BIN);
    } catch {
      console.error(
        `no iroh-relay at ${RELAY_BIN} — run \`cd engine && just relay-bin\` ` +
          `(the suite runs its own relay; it no longer uses the public one).`,
      );
      Deno.exit(2);
    }
    this.#dir ??= await Deno.makeTempDir({ prefix: "pm-e2e-relay." });
    const cfg = `${this.#dir}/relay.toml`;
    await Deno.writeTextFile(
      cfg,
      `http_bind_addr = "127.0.0.1:${this.#port}"\nenable_metrics = false\n`,
    );
    this.#proc = new Deno.Command(RELAY_BIN, {
      args: ["--dev", "--config-path", cfg],
      stdout: "null",
      stderr: "null",
    }).spawn();
    // `/generate_204` is the relay's own net-report probe endpoint
    // (iroh-relay src/server.rs) — answering it is the relay saying it
    // is serving, which is stronger than the port being open.
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${this.url}/generate_204`, {
          signal: AbortSignal.timeout(2_000),
        });
        await r.body?.cancel();
        if (r.status === 204 || r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the local relay never answered on ${this.url}`);
  }

  /** Mirrors `Minio.stop()` exactly, down to the refused/timeout split —
   * see that method's comment for why a TIMEOUT is not the state a
   * scenario asserting on transport refusal may be told it reached. The
   * probe is `/generate_204`, the same net-report endpoint `start()`
   * uses to know the relay is actually serving. `start()` re-creates
   * `this.#proc` afterwards (it is null-checked, same as Minio), and
   * keeps the SAME config file — same port — so a page that already
   * captured `?relay=<url>` stays pointed at a relay that will listen
   * there again. */
  async stop(): Promise<void> {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
    await proc.status;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.url}/generate_204`, {
          signal: AbortSignal.timeout(2_000),
        });
        await r.body?.cancel();
      } catch (e) {
        // Connection refused is the state this loop exists to reach —
        // see Minio.stop()'s identical comment for why a TimeoutError
        // must keep the loop going rather than being read as "down".
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the relay kept answering after being killed");
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

// --- the run ---------------------------------------------------------------

async function main() {
  const headed = Deno.args.includes("--headed");
  // --file <path>: a DEV LOADER for scenarios not yet registered in
  // SCENARIOS above. WHY THIS EXISTS: several partition scenarios are
  // developed in parallel by separate tracks, and requiring every one
  // of them to land a run.ts edit (import + list placement, with its
  // own ordering commentary) before it can even be RUN once would
  // gate iteration speed on a merge. `--file` imports the module
  // directly (default export = Scenario) relative to this file's own
  // directory (`demo/e2e/`), so `--file scenarios/foo.ts` finds
  // `demo/e2e/scenarios/foo.ts` regardless of the caller's cwd. Mixed
  // usage (bare names plus `--file`s) simply runs the union of both
  // lists — keeping that simple was an explicit non-goal to gold-plate.
  const filePaths: string[] = [];
  // `wanted` must NOT swallow a --file's path argument as a scenario
  // name (a path is a bare token too, and would otherwise be read as
  // "unknown scenario"), so both are stripped from args before the
  // ordinary bare-name scan runs.
  const consumed = new Set<number>();
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--file") {
      const p = Deno.args[i + 1];
      if (!p) {
        console.error("--file needs a path argument");
        Deno.exit(2);
      }
      filePaths.push(p);
      consumed.add(i);
      consumed.add(i + 1);
      i++;
    }
  }
  const wanted = Deno.args.filter((a, i) => !consumed.has(i) && !a.startsWith("-"));
  const fileScenarios: Scenario[] = [];
  for (const p of filePaths) {
    const mod = await import(new URL(p, `file://${here}`).toString());
    const s = mod.default as Scenario | undefined;
    if (!s || typeof s.run !== "function") {
      console.error(`--file ${p}: default export is not a Scenario`);
      Deno.exit(2);
    }
    fileScenarios.push(s);
  }
  const site = `${demoRoot}serve`;
  try {
    await Deno.stat(`${site}/index.html`);
  } catch {
    console.error(`no built site at ${site} — run \`just site\` first (\`just e2e\` does).`);
    Deno.exit(2);
  }

  const sitePort = await freePort();
  const server = serveSite(site, sitePort);
  const baseUrl = `http://127.0.0.1:${sitePort}`;
  const minio = new Minio(await freePort());
  await minio.start();
  const relay = new Relay(await freePort());
  await relay.start();
  console.log(`local relay: ${relay.url}`);
  /** What EVERY page in the suite gets, before any scenario's own
   * `query`. The suite is hermetic: no page here talks to the public
   * relay, including the boot wire step. */
  const baseQuery: Record<string, string> = { relay: relay.url };

  // The browser comes from playwright's own cache — `~/.cache/ms-playwright`
  // by default, or wherever PLAYWRIGHT_BROWSERS_PATH points (CI sets it to
  // a cacheable directory keyed on the pinned version; see
  // .github/workflows/e2e.yml). `just e2e-deps` is what guarantees it is
  // there, by PROBING a launch and only downloading if that fails.
  const launchBrowser = () =>
    chromium.launch({
      headless: !headed,
      // The demo runs entirely against 127.0.0.1 and instantiates a large
      // wasm graph; the sandbox is off for the same reason cdp-heap.ts
      // turns it off (containerised CI without user namespaces), and
      // /dev/shm is small in the same containers.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  let browser: Browser = await launchBrowser();

  // --- the Gecko side ---------------------------------------------------
  //
  // ONE SCENARIO RUNS UNDER FIREFOX (`firefox-smoke`), because the demo's
  // whole persistence story rides on platform features that are per-engine
  // facts rather than per-standard ones: JSPI, module SharedWorkers, OPFS,
  // Web Locks, and a non-extractable CryptoKey structured-cloned into
  // IndexedDB. A Chromium-only suite means a Gecko regression is only ever
  // found BY HAND, which is how this scenario came to exist.
  //
  // THE PREF, AND WHY IT IS NOT A COMPATIBILITY SHIM. Playwright 1.57.0's
  // Firefox build (144.0.2) ships with
  // `javascript.options.wasm_js_promise_integration` DEFAULTED OFF, so
  // `WebAssembly.Suspending` is simply absent and the engine cannot be
  // instantiated at all. Release Firefox of the same generation has it ON
  // — the project owner runs this demo on a real mobile Firefox, account
  // creation and storage sheet included. The pref therefore restores the
  // RELEASE default that Playwright's build lags; it does not grant the
  // page anything a real user's browser does not already have. Measured
  // 2026-08-23: with the pref, that same build reports JSPI, module
  // SharedWorker, OPFS, Web Locks and CryptoKey-in-IndexedDB all present
  // and the solo page boots clean; without it, boot refuses by name
  // ("this browser cannot run the engine: it has no WebAssembly JS
  // Promise Integration…", runtime/device-store/worker.ts's
  // `requireJspi`). If a future Playwright build turns it on, this map
  // becomes a no-op rather than a lie.
  //
  // (Not covered by the pref, and not needed: `createSyncAccessHandle` is
  // absent on OPFS files in this build. The device store never asks for
  // one — it writes through `createWritable` — so the boot is green
  // regardless. Worth knowing before someone reaches for the sync API.)
  // THE SECOND PREF, and it is a HARNESS fact rather than a lag in
  // Playwright's build. `navigator.storage.persist()` under headless
  // Playwright Firefox NEVER SETTLES — the promise neither resolves nor
  // rejects — because the persistent-storage permission prompt has no UI
  // to answer it and headless has nobody to click. Every kept-device
  // ceremony awaits that call, so without this pref the whole
  // keep-this-device family wedges on a promise that will not settle,
  // which reads as a deadline failure in whatever act happened to be
  // first. Setting the permission to 1 (ALLOW) answers the prompt the way
  // a user who chose to keep the device already answered it. Measured
  // 2026-08-23: with it, solo-persistence, solo-storage, solo-gdrive and
  // solo-account-storage all pass under Gecko; without it, all four hang.
  const FIREFOX_PREFS: Record<string, boolean | number> = {
    "javascript.options.wasm_js_promise_integration": true,
    "permissions.default.persistent-storage": 1,
  };
  let firefoxBrowser: Browser | null = null;
  const launchFirefox = () =>
    firefox.launch({ headless: !headed, firefoxUserPrefs: FIREFOX_PREFS });
  /** Which engine the scenario now running asked for. `ctx.browser` and
   * `fresh` both read it through `current()` rather than closing over a
   * browser, for the same reason the chromium handle is a getter: the
   * runner replaces a wedged browser underneath a scenario.
   *
   * THE JUGGLER HAZARD, and it constrains how a Firefox-lane scenario may
   * be WRITTEN, not just which browser it gets. Calling a
   * `WebAssembly.promising` export from inside a `page.evaluate` frame
   * SIGSEGVs the Firefox content process — measured 2026-08-23, 4 of 4
   * minimal cases, with the identical code in a PAGE SCRIPT running clean
   * every time. The fault is in the Juggler protocol's evaluate frame
   * meeting a JSPI stack switch, not in the engine: nothing in the wasm
   * or the embedder differs between the two paths. Playwright reports it
   * as a bare "Target crashed", which names nothing and sends the reader
   * looking at the engine.
   *
   * So: a scenario on the firefox lane must reach engine work through
   * page scripts, exposed bindings or event hooks — anything the page
   * itself drives — and must never sit in an evaluate frame that reaches
   * a promising export. `firefox-smoke` is written to that rule: it
   * evaluates only FEATURE PROBES (typeof checks, constructor presence),
   * which touch no promising export, and leaves engine instantiation to
   * the page's own boot.
   *
   * WHERE THE RULE'S PRECONDITION NO LONGER HOLDS, measured 2026-08-24.
   * /solo.html instantiates NO wasm in the document: `conn.driver`
   * (host/solo.ts:723) is an RPC proxy over the device host's module
   * SharedWorker, so an evaluate frame awaiting a `__solo` hook is
   * awaiting a postMessage round trip, and the promising export it
   * eventually reaches runs in the WORKER's global — a realm the Juggler
   * evaluate frame is not on the stack of. Spiked before
   * `cross-engine-pairing` was written: a Firefox solo page driven
   * through `solo()`/`hookOn` survived 20 consecutive `tick`s, 20
   * `hasAccount`s (`us-profile-get`), a `newAccount`, a todo typed into
   * the app and read back through `todos()` (`tasks.items()`), and an
   * `endpointId` off a live iroh bind — no crash, no renderer silence,
   * on 3 of 3 runs. So `cross-engine-pairing` drives its whole Gecko
   * side through ordinary `solo()` calls, and the queue-based command
   * channel designed to dodge the hazard was never built: there was
   * nothing left to dodge.
   *
   * That is a fact about ONE PAGE, not a repeal. /index.html still
   * instantiates its engines in the document, and the rule above governs
   * any Firefox-lane scenario that drives it — as it will govern
   * /solo.html again the day the device host moves back into the page. */
  let engine: "chromium" | "firefox" = "chromium";
  const current = (): Browser => engine === "firefox" ? firefoxBrowser! : browser;
  /** Did the scenario ATTEMPT NOW RUNNING actually get a Firefox
   * context? Reset per attempt, set by `browserFor` the moment it hands
   * the Gecko handle out — so it covers both ways in: a `firefox`-lane
   * scenario and a Chromium-lane one that asked for a Gecko context
   * through `ctx.fresh({ engine })`.
   *
   * It exists to SCOPE the dead-secondary crash test below. `firefox
   * Browser` is a run-lifetime handle: once any scenario has launched
   * Gecko it stays non-null for every scenario after it, so an
   * unscoped "is the secondary connected?" would be consulted on
   * failures that never touched Firefox at all — and a Gecko that died
   * quietly in the background would then re-label a LATER Chromium
   * scenario's ordinary assertion failure as crash-shaped. */
  let usedFirefox = false;
  /** The browser ONE `ctx.fresh` call gets. Without `opts.engine` this
   * is just `current()` — the scenario's own lane, unchanged. WITH it,
   * a scenario may open a context in the OTHER engine, which is what
   * makes a genuinely cross-browser scenario possible at all:
   * `cross-engine-pairing` keeps device A on the runner's Chromium page
   * and asks for device B in Firefox.
   *
   * Firefox is launched HERE when first asked for, and kept — the same
   * laziness the scenario-level `engine` field gets a few lines below,
   * and for the same reason (a Chromium-only run must never pay for a
   * Gecko launch). `firefoxBrowser` is the single handle both paths
   * share, so a mixed scenario following `firefox-smoke` reuses the
   * browser that scenario already started. */
  const browserFor = async (want?: "chromium" | "firefox"): Promise<Browser> => {
    const which = want ?? engine;
    if (which !== "firefox") return browser;
    usedFirefox = true;
    if (!firefoxBrowser) {
      setPhase("launchFirefox");
      firefoxBrowser = await launchFirefox();
    }
    return firefoxBrowser;
  };

  const openPages: Page[] = [];
  // Every proxy a scenario opens via `ctx.relayProxy()`, closed in the
  // per-scenario finally alongside `openPages` — isolation is the
  // harness's job (see the comment at that finally block), not
  // something a partition scenario has to remember to do for itself.
  const openProxies: SeverableProxy[] = [];
  // Phase tracing for the deadline diagnostics: every await between a
  // scenario banner and its first act sets the phase it is entering, so
  // a deadline failure can NAME the wedged call instead of leaving a
  // silent banner (the two observed CI wedges both died namelessly).
  let phase = "idle";
  let phaseAt = performance.now();
  const setPhase = (p: string) => {
    phase = p;
    phaseAt = performance.now();
  };
  const ctx: Ctx = {
    baseUrl,
    // A getter, not a copy: the runner replaces a wedged browser (see the
    // deadline machinery below), and a scenario must always see the live
    // one.
    get browser() {
      return current();
    },
    minioUrl: minio.url,
    minioAccess: MINIO_USER,
    minioSecret: MINIO_PASS,
    get minioDataDir() {
      return minio.dataDir;
    },
    stopMinio: () => minio.stop(),
    startMinio: () => minio.start(),
    stopRelay: () => relay.stop(),
    startRelay: () => relay.start(),
    relayUrl: relay.url,
    relayProxy: async () => {
      const p = await startTcpProxy(relay.port);
      openProxies.push(p);
      return p;
    },
    fresh: async (opts: FreshOptions = {}) => {
      // `opts.engine` is the per-context override (util.ts's
      // FreshOptions.engine); undefined keeps the scenario's own lane.
      const target = await browserFor(opts.engine);
      setPhase("newContext");
      const bctx = await newContext(target, opts);
      setPhase("newPage");
      const page = await bctx.newPage();
      openPages.push(page);
      // Console noise is kept, not printed: a failing act dumps it, a
      // passing one would drown the summary.
      const lines: string[] = [];
      page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message}`));
      // CI run 32442122042 caught the wedge red-handed: the RENDERER took
      // SIGSEGV (SEGV_ACCERR, mid-boot at the alice⇄bob wire step) and then
      // hung in its own crash handler — no crash event reached the driver,
      // and waitForFunction's in-page timeout died with the page. When the
      // event DOES fire, this flag fails the boot wait in seconds with a
      // name; when it doesn't (CI run 32486407187, mid reload-boot), the
      // boot wait now detects the PROTOCOL SILENCE itself in ~20s — it is
      // a harness-side probe loop, see util.ts's waitForBoot. Either way
      // the scenario is retried once on a fresh browser: a renderer SEGV
      // is a Chromium/environment flake, not a claim about the demo.
      let crashed = false;
      page.on("crash", () => {
        crashed = true;
        lines.push("[crash] the renderer crashed (pw:browser stderr has the signal)");
      });
      (page as unknown as { __log: string[] }).__log = lines;
      (page as unknown as { __crashed: () => boolean }).__crashed = () => crashed;
      setPhase("goto");
      await page.goto(pageUrl(baseUrl, baseQuery, opts), { waitUntil: "domcontentloaded" });
      if (!opts.noWait) {
        setPhase("waitForBoot");
        // No crash race here any more: waitForBoot is itself crash-aware
        // (it reads the flag above through `__crashed` and attaches — and
        // REMOVES — its own listener), so racing one here would only leak
        // a `crash` listener per boot.
        await waitForBoot(page, opts.bootGlobal);
      }
      return page;
    },
  };

  const results: {
    name: string;
    ok: boolean;
    ms: number;
    acts: number;
    error?: string;
    retried?: boolean;
    xfailNote?: string;
  }[] = [];
  const runList = wanted.length > 0
    ? SCENARIOS.filter((s) => wanted.includes(s.name))
    : filePaths.length > 0
    ? [] // named --file(s) only, no bare names: run exactly those
    : SCENARIOS;
  if (wanted.length > 0 && runList.length !== wanted.length) {
    console.error(`unknown scenario(s): ${wanted.filter((w) => !SCENARIOS.some((s) => s.name === w))}`);
    Deno.exit(2);
  }
  runList.push(...fileScenarios);

  console.log(`\ne2e: ${runList.length} scenario(s) against ${baseUrl}\n`);
  const started = performance.now();

  // --- the scenario deadline --------------------------------------------
  //
  // Every wait INSIDE the harness is bounded (BOOT_TIMEOUT, UI_TIMEOUT,
  // minio's health loops) — but Playwright PROTOCOL calls are not:
  // newContext/newPage against a wedged chrome-headless-shell simply
  // never return. Observed twice in CI (2026-08-21): a run hung at a
  // scenario banner — after the previous scenario, before the first
  // act — for 56 minutes until the JOB timeout killed it, with the
  // headless shell still alive among the orphans. The deadline turns
  // that hour of silence into a labeled failure in minutes.
  //
  // It is no longer the only net under a dead renderer. CI run
  // 32486407187 (SEGV_ACCERR mid reload-boot, no crash event, the in-page
  // waitForFunction timeout dying with the renderer — reproduced by
  // SIGSTOP: silence AFTER poller injection never times out, silence
  // BEFORE it gets the driver-side 90s) cost 4 minutes of deadline
  // because nothing below it could see the silence. waitForBoot now sees
  // it in ~20s. What the deadline still owns is the hang with no in-flight
  // page wait at all — a wedged newContext/newPage protocol call.
  //
  // A CRASH-SHAPED failure (RendererGoneError, a deadline, or a delivered
  // crash event) relaunches the browser and retries the scenario ONCE: a
  // wedged browser stays wedged and would eat every following scenario,
  // and a renderer SEGV is a Chromium/environment flake rather than a
  // claim about the demo. An ordinary act failure is NOT retried — that
  // would mask a real regression.
  const SCENARIO_DEADLINE_MS = 240_000; // > BOOT_TIMEOUT + slowest scenario
  const DEADLINE_MARK = "scenario deadline";
  const withDeadline = <T>(p: Promise<T>, deadlineMs = SCENARIO_DEADLINE_MS): Promise<T> => {
    let timer: number | undefined;
    const bomb = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${DEADLINE_MARK}: no progress in ${deadlineMs / 1000}s ` +
                `(a hang below the harness's own bounded waits — a wedged ` +
                `browser protocol call is the known cause)`,
            ),
          ),
        deadlineMs,
      );
    });
    return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
  };
  /** Bounded close-and-relaunch for a browser presumed wedged: close()
   * itself is a protocol call and can hang, so it races a short fuse
   * and the old process is abandoned to the OS if it does. Whichever
   * engine the failing scenario was driving is the one replaced — a
   * relaunched Chromium would do nothing for a wedged Gecko.
   *
   * A MIXED scenario (one that opens a `ctx.fresh({ engine: … })`
   * context in the OTHER browser — `cross-engine-pairing`) has TWO
   * browsers in flight, and this recovers them ASYMMETRICALLY, which is
   * a deliberate choice rather than an oversight:
   *
   *   - the scenario's OWN lane (`current()`) is always closed and
   *     relaunched, because that is the browser the runner will hand to
   *     the next scenario and a wedged one eats every scenario after it;
   *   - the SECONDARY browser is relaunched only when it is visibly gone
   *     (`isConnected()` false). A live secondary is left alone: closing
   *     a healthy Firefox to recover a wedged Chromium would cost a
   *     ~5s relaunch on the retry for no evidence at all.
   *
   * What this deliberately does NOT solve, in two directions. First: a
   * secondary browser whose RENDERER wedged without disconnecting the
   * browser process. In a mixed scenario that shows up as an ordinary
   * act failure or a scenario deadline — the deadline IS crash-shaped,
   * so the retry happens, but it happens against the same wedged
   * secondary and will most likely fail the same way. Second, and
   * currently unexercised: the MIRROR arrangement, a `firefox`-lane
   * scenario that opens a CHROMIUM secondary through `ctx.fresh({
   * engine: "chromium" })`. Nothing here relaunches that one — the
   * clause above names Firefox specifically, and `browser` is not
   * re-checked while `engine === "firefox"` — so a dead Chromium
   * secondary survives until the NEXT Chromium-lane scenario's own
   * `!current().isConnected()` test catches it, one scenario late.
   * Fixing either properly means tracking crash events (and handles)
   * per browser rather than per page, which is more machinery than one
   * cross-engine scenario has earned; both are written down here rather
   * than discovered later. */
  const recoverBrowser = async () => {
    const dying = current();
    await Promise.race([
      dying.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (engine === "firefox") firefoxBrowser = await launchFirefox();
    else browser = await launchBrowser();
    console.log(`         (${engine} relaunched)`);
    // The secondary, only if it is demonstrably gone (see above).
    if (engine !== "firefox" && firefoxBrowser && !firefoxBrowser.isConnected()) {
      firefoxBrowser = await launchFirefox();
      console.log("         (the secondary firefox was gone; relaunched too)");
    }
  };

  // --- memory watch -------------------------------------------------------
  //
  // A wedge from memory pressure looks exactly like the observed protocol
  // wedges — a renderer stalls and no crash event ever reaches the driver —
  // so the harness watches the browser's whole process tree, not just the
  // aftermath: /proc-walked RSS grouped into the LIVE chrome tree (our
  // descendants), ORPHANED chrome (abandoned by recoverBrowser, reparented
  // to init, still eating memory — matched by playwright-cache cmdline so a
  // developer's own desktop Chrome is never counted), minio, and the
  // harness itself, plus the kernel's MemAvailable. RSS summed over a
  // process tree OVERCOUNTS shared pages (every renderer maps the same
  // binary); the trend is what matters here, not the absolute number.
  // One line per scenario; the full recent history on a deadline failure.
  type MemSample = {
    t: number;
    chromeMb: number;
    orphanMb: number;
    minioMb: number;
    otherMb: number;
    harnessMb: number;
    availMb: number;
  };
  const pwCachePath = Deno.env.get("PLAYWRIGHT_BROWSERS_PATH") ?? "ms-playwright";
  const sampleMem = (): MemSample | null => {
    if (Deno.build.os !== "linux") return null;
    try {
      const table = new Map<number, { ppid: number; rssMb: number; comm: string }>();
      for (const ent of Deno.readDirSync("/proc")) {
        if (!/^\d+$/.test(ent.name)) continue;
        const pid = Number(ent.name);
        try {
          const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
          // comm may contain spaces/parens: parse around the LAST ')'.
          const close = stat.lastIndexOf(")");
          const comm = stat.slice(stat.indexOf("(") + 1, close);
          const ppid = Number(stat.slice(close + 2).split(" ")[1]);
          const pages = Number(Deno.readTextFileSync(`/proc/${pid}/statm`).split(" ")[1]);
          table.set(pid, { ppid, rssMb: (pages * 4096) / 1048576, comm });
        } catch { /* pid raced away */ }
      }
      const isOurs = (pid: number): boolean => {
        for (let cur = pid, guard = 0; guard < 64; guard++) {
          const p = table.get(cur);
          if (!p) return false;
          if (p.ppid === Deno.pid) return true;
          if (p.ppid <= 1) return false;
          cur = p.ppid;
        }
        return false;
      };
      const s: MemSample = {
        t: performance.now(),
        chromeMb: 0,
        orphanMb: 0,
        minioMb: 0,
        otherMb: 0,
        harnessMb: Deno.memoryUsage().rss / 1048576,
        availMb: Number(
          Deno.readTextFileSync("/proc/meminfo").match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0,
        ) / 1024,
      };
      for (const [pid, p] of table) {
        if (pid === Deno.pid) continue;
        // "browser-ish": the Chromium tree, plus the Gecko one the
        // firefox-smoke scenario launches (`comm` is `firefox` for the
        // parent and `Isolated Web Co`/`Web Content` for its children,
        // which the harness lumps into `otherMb` — the trend is what
        // this watch reads, and a browser tree in the wrong column
        // would misread it).
        const chromeish = /chrom|headless|firefox|Web Content|Isolated Web/i.test(p.comm);
        if (isOurs(pid)) {
          if (chromeish) s.chromeMb += p.rssMb;
          else if (/minio/i.test(p.comm)) s.minioMb += p.rssMb;
          else s.otherMb += p.rssMb;
        } else if (chromeish) {
          try {
            if (Deno.readTextFileSync(`/proc/${pid}/cmdline`).includes(pwCachePath)) {
              s.orphanMb += p.rssMb;
            }
          } catch { /* not ours to read */ }
        }
      }
      return s;
    } catch {
      return null; // diagnostics are best-effort
    }
  };
  const memHistory: MemSample[] = [];
  let scenarioPeakMb = 0;
  const recordSample = (): MemSample | null => {
    const s = sampleMem();
    if (!s) return null;
    memHistory.push(s);
    if (memHistory.length > 40) memHistory.shift();
    scenarioPeakMb = Math.max(scenarioPeakMb, s.chromeMb + s.orphanMb);
    return s;
  };
  const fmtMb = (mb: number) => `${Math.round(mb)}MB`;
  const memTimer = setInterval(recordSample, 5_000);
  Deno.unrefTimer(memTimer);

  for (const scenario of runList) {
    console.log(`  ── ${scenario.name}: ${scenario.why}`);
    const t0 = performance.now();
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      resetActs();
      // Per ATTEMPT, not per scenario: the retry re-runs `ctx.fresh`
      // and will set it again if it really opens a Gecko context.
      usedFirefox = false;
      scenarioPeakMb = 0;
      recordSample();
      let page: Page | null = null;
      let failure: unknown;
      let failed = false;
      // Sampled INSIDE the catch: the finally below empties openPages, so
      // the crash-shape test after it has nothing left to ask.
      let crashEventSeen = false;
      try {
        await withDeadline((async () => {
          setPhase("minio");
          if (scenario.minio === "down") await minio.stop();
          else await minio.start();
          // Every scenario gets the relay UP at the start, unconditionally
          // — mirrors the minio handling above. Unlike MinIO there is no
          // `relay: "down"` scenario field: a scenario that wants the real
          // relay down for its own duration calls `ctx.stopRelay()` itself
          // (harness-faults.ts does exactly that), because a suite-wide
          // relay outage would take EVERY scenario's page with it, not just
          // one pane the way MinIO's outage does.
          setPhase("relay");
          await relay.start();
          // The engine is chosen BEFORE `fresh`, since that is what
          // `current()` resolves against. Firefox is launched lazily and
          // kept for the rest of the run: a suite that is one Gecko beat
          // long should not pay for a second browser it never opens.
          engine = scenario.engine ?? "chromium";
          if (engine === "firefox") await browserFor("firefox");
          page = await ctx.fresh(
            typeof scenario.page === "function" ? scenario.page(ctx) : scenario.page,
          );
          setPhase("scenario");
          await scenario.run(page, ctx);
          setPhase("idle");
        })(), scenario.deadlineMs);
      } catch (e) {
        failed = true;
        failure = e;
        crashEventSeen = openPages.some((p) =>
          (p as unknown as { __crashed?: () => boolean }).__crashed?.() === true
        );
        // The log is read off whatever pages the scenario opened —
        // including one that failed to BOOT, which is the case where the
        // console is the only evidence there is.
        const log = openPages.flatMap((p) => (p as unknown as { __log: string[] }).__log ?? []);
        if (log.length > 0) {
          console.log("         --- page console (last 15) ---");
          for (const l of log.slice(-15)) console.log(`         ${l}`);
        }
        if (e instanceof Error && e.message.startsWith(DEADLINE_MARK)) {
          // The diagnostics the two silent CI wedges lacked: WHERE it was
          // stuck, whether the protocol was alive at all, and whether the
          // runner was starved for memory (an OOM-killed browser child
          // manifests as exactly this kind of silence).
          const stuck = ((performance.now() - phaseAt) / 1000).toFixed(1);
          console.log(`         wedged in phase '${phase}' for ${stuck}s`);
          console.log(`         browser.isConnected(): ${current().isConnected()}`);
          const crashedPages = openPages.filter((p) =>
            (p as unknown as { __crashed?: () => boolean }).__crashed?.()
          ).length;
          console.log(
            `         pages with a delivered crash event: ${crashedPages}/${openPages.length}`,
          );
          // The sampled history answers the question a post-mortem snapshot
          // cannot: was memory CLIMBING before the stall, or flat?
          recordSample();
          if (memHistory.length > 0) {
            console.log("         --- mem history (5s cadence, oldest first) ---");
            const now = performance.now();
            for (const s of memHistory.slice(-12)) {
              console.log(
                `         t-${((now - s.t) / 1000).toFixed(0).padStart(3)}s  ` +
                  `chrome ${fmtMb(s.chromeMb)}  orphans ${fmtMb(s.orphanMb)}  ` +
                  `minio ${fmtMb(s.minioMb)}  other ${fmtMb(s.otherMb)}  ` +
                  `harness ${fmtMb(s.harnessMb)}  avail ${fmtMb(s.availMb)}`,
              );
            }
          }
          if (Deno.build.os === "linux") {
            try {
              const mem = new TextDecoder().decode(
                (await new Deno.Command("free", { args: ["-m"] }).output()).stdout,
              );
              for (const l of mem.trim().split("\n")) console.log(`         ${l}`);
            } catch { /* diagnostics are best-effort */ }
          }
        }
      } finally {
        // Every scenario's contexts go away with it: isolation is the
        // harness's job, not the scenario's. Bounded for the same reason
        // as recoverBrowser: close() on a wedged browser never returns.
        for (const p of openPages.splice(0)) {
          await Promise.race([
            p.context().close().catch(() => {}),
            new Promise((r) => setTimeout(r, 5_000)),
          ]);
        }
        // Every proxy a scenario opened, closed the same way and for the
        // same reason: a partition scenario must never leak a listening
        // socket into the one after it.
        for (const p of openProxies.splice(0)) {
          await p.close().catch(() => {});
        }
      }
      // The crash shape: the renderer stopped answering (either named by
      // waitForBoot/driverBounded, or caught only by the deadline), or a
      // crash event was actually delivered, or the whole BROWSER is gone
      // — `isConnected()` false, and protocol calls failing with
      // playwright's "has been closed" wording. All of these say "the
      // browser died", not "the demo is wrong". The last two were
      // learned the hard way (2026-08-24): an externally-killed Chromium
      // made `newContext` fail INSTANTLY with "Target page, context or
      // browser has been closed", which is not a RendererGoneError and
      // never trips the deadline — so the runner sailed on with a dead
      // browser and every following Chromium scenario failed in 0.0s.
      // A cascade like that is a statement about the browser process,
      // and the recovery it needs is exactly recoverBrowser's.
      const crashShaped = failed && (
        (failure instanceof RendererGoneError) ||
        (failure instanceof Error && failure.name === "RendererGoneError") ||
        (failure instanceof Error && failure.message.startsWith(DEADLINE_MARK)) ||
        (failure instanceof Error && /has been closed/.test(failure.message)) ||
        !current().isConnected() ||
        // THE SECONDARY BROWSER of a scenario that used both (ctx.fresh's
        // `engine` override). `current()` only ever names the scenario's
        // own lane, so without this a Firefox that died under a
        // Chromium-lane cross-engine scenario would read as an ordinary
        // act failure — a claim about the demo — and never be retried.
        //
        // SCOPED TO `usedFirefox` ON PURPOSE. `firefoxBrowser` is a
        // run-lifetime handle, so the unscoped test would fire for EVERY
        // failed scenario once Gecko had ever launched: a background
        // Firefox that died quietly would turn a later Chromium
        // scenario's ordinary assertion failure into a crash-shaped one
        // — one wasted retry, and worse, an `expected: "red"` scenario
        // loses its xfail reading on that attempt (crash-shaped failures
        // are deliberately never folded into the xfail marker). It would
        // self-heal on attempt 2, since the retry's recoverBrowser
        // relaunches the dead secondary and MAX_ATTEMPTS bounds the
        // whole thing — but a correct result reached through a
        // misdiagnosis is still a misdiagnosis, and this flag costs four
        // lines. What remains unguarded is narrow and honest: a Gecko
        // that dies DURING the scenario that is using it, which is
        // exactly the case this clause exists for.
        // (The cast is the same one the close block at the end of the
        // run needs, and for the same reason written there: every
        // assignment to `firefoxBrowser` happens inside a closure, so
        // the checker's flow analysis reaches here still believing it
        // is `null`.)
        (usedFirefox && (firefoxBrowser as Browser | null)?.isConnected() === false) ||
        crashEventSeen
      );
      if (failed && crashShaped && attempt < MAX_ATTEMPTS) {
        console.log(
          "    !!   renderer crash/wedge — relaunching the browser and retrying the scenario",
        );
        await recoverBrowser();
        continue;
      }
      // XFAIL: an `expected: "red"` scenario inverts the ok/fail reading,
      // UNLESS the failure is crash-shaped — a renderer SEGV under an
      // xfail scenario is still an environment flake, not "the expected
      // red", so it must not be quietly folded into the xfail marker.
      const xfail = scenario.expected === "red" && !crashShaped;
      let ok = !failed;
      let error = failed ? (failure instanceof Error ? failure.message : String(failure)) : undefined;
      let xfailNote: string | undefined;
      if (xfail) {
        if (failed) {
          // The expected shape: record it as ok, but say so plainly —
          // this is a known gap being TRACKED, not a passing claim.
          ok = true;
          xfailNote = "(xfail: expected red)";
        } else {
          // The gate FLIPPED: a scenario marked `expected: "red"` just
          // passed. That is itself a failure — an xfail that keeps
          // passing silently is worse than no xfail at all, because it
          // hides a fixed regression behind a flag nobody comes back to
          // remove.
          ok = false;
          error =
            "expected: \"red\" scenario PASSED — the gate has flipped; promote it to green " +
            "by dropping the `expected` flag";
        }
      }
      results.push({
        name: scenario.name,
        ok,
        ms: Math.round(performance.now() - t0),
        acts: actCount().acts,
        error,
        retried: attempt > 1,
        xfailNote,
      });
      // A wedged browser stays wedged: never hand it to the next scenario.
      if (failed && crashShaped) await recoverBrowser();
      break;
    }
    const memEnd = recordSample();
    if (memEnd) {
      console.log(
        `         mem: chrome ${fmtMb(memEnd.chromeMb)} (scenario peak ${fmtMb(scenarioPeakMb)})` +
          `${memEnd.orphanMb > 1 ? `, orphans ${fmtMb(memEnd.orphanMb)}` : ""}` +
          `, avail ${fmtMb(memEnd.availMb)}`,
      );
    }
    console.log("");
  }

  await Promise.race([
    Promise.all([
      browser.close().catch(() => {}),
      // The annotation is not decoration: every assignment to
      // `firefoxBrowser` happens inside the scenario loop's closures, so
      // the checker's flow analysis reaches here still believing it is
      // `null`.
      (firefoxBrowser as Browser | null)?.close().catch(() => {}) ?? Promise.resolve(),
    ]),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  await minio.dispose();
  await relay.dispose();
  await server.shutdown();

  const wall = ((performance.now() - started) / 1000).toFixed(1);
  const failed = results.filter((r) => !r.ok);
  console.log("  ════ summary ════");
  for (const r of results) {
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(26)} ${String(r.acts).padStart(2)} acts  ${
        (r.ms / 1000).toFixed(1)
      }s${r.error ? `  — ${r.error}` : ""}${
        r.retried && r.ok ? "  (2nd attempt; renderer crashed on the 1st)" : ""
      }${r.xfailNote ? `  ${r.xfailNote}` : ""}`,
    );
  }
  console.log(
    `\n  ${results.length - failed.length}/${results.length} scenarios passed in ${wall}s\n`,
  );
  Deno.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();
export { here };
