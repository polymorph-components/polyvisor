// End-to-end scenarios for the demo visor, in a REAL Chromium.
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
// the pairing ceremony actually crosses it), and one browser. Each
// scenario gets a fresh browser context, so no scenario can pass because
// of something another one left in storage — and nothing here reaches
// off this machine.

import { chromium } from "npm:playwright@1.57.0";
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

import bootAppSurface from "./scenarios/boot-app-surface.ts";
import petnameCeremony from "./scenarios/petname-ceremony.ts";
import settingsIdentity from "./scenarios/settings-identity.ts";
import stripGeometry from "./scenarios/strip-geometry.ts";
import credentialFlow from "./scenarios/credential-flow.ts";
import transportRefusal from "./scenarios/transport-refusal.ts";
import tenantPrecedence from "./scenarios/tenant-precedence.ts";
import storagePageNavigation from "./scenarios/storage-page-navigation.ts";
import storagePicker from "./scenarios/storage-picker.ts";
import stripOwnership from "./scenarios/strip-ownership.ts";
import devicePairing from "./scenarios/device-pairing.ts";
import devicePairingMock from "./scenarios/device-pairing-mock.ts";
import soloPairing from "./scenarios/solo-pairing.ts";
import soloPersistence from "./scenarios/solo-persistence.ts";
import soloErase from "./scenarios/solo-erase.ts";
import soloEphemeral from "./scenarios/solo-ephemeral.ts";
import soloStorage from "./scenarios/solo-storage.ts";
import soloGdrive from "./scenarios/solo-gdrive.ts";
import soloAccountStorage from "./scenarios/solo-account-storage.ts";
import soloPasskey from "./scenarios/solo-passkey.ts";
import visorReset from "./scenarios/visor-reset.ts";

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
  run(page: Page, ctx: Ctx): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  bootAppSurface,
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
  soloEphemeral,
  // THE WORKER HOST'S STORAGE EGRESS (STORAGE-EGRESS.md's T-E): the same
  // sheet the two device-store scenarios above just proved a device
  // KEEPS itself through, now driven all the way to a real MinIO — bind,
  // reload, reseal and unbind, with MinIO's own filesystem as the
  // witness that bytes actually left the browser. It follows them
  // because a failure here with solo-persistence green says the fault is
  // in the store-egress wiring, not in the device store underneath it.
  soloStorage,
  // GOOGLE DRIVE FROM THE WORKER HOST (runtime/DRIVE.md's e2e gate): the
  // same solo page, the same fresh context, but this one needs no MinIO
  // at all — it drives its own in-process fake Drive instead, and runs
  // right after the S3 storage scenario without disturbing the
  // harness's MinIO (which stays up regardless, for everything after
  // it). The real popup path is the point: the worker mints PKCE, the
  // page only ever opens a window and relays a one-shot code.
  soloGdrive,
  // THE ACCOUNT'S STORAGE RECORD (DRIVE.md, "The account syncs its
  // storage config; devices keep their credentials"): the pairing
  // scenario's two isolated contexts and the Drive scenario's fake, in
  // one story — A binds and writes the destination through the account,
  // B announces the change and then adopts it with nothing typed but a
  // consent click. It runs directly after solo-gdrive because a failure
  // here with that one green says the fault is in the SYNC of the
  // config, not in the Drive ceremony it reuses wholesale.
  soloAccountStorage,
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
  // The erase ceremony: seeds a name, a petname and a storage sentinel,
  // then reloads the page (twice) as part of its own claim. It runs
  // after the other identity/naming scenarios and before the one that
  // must stay last, on its own fresh context either way.
  visorReset,
  // Last: it provokes the visor-timer races, so it is the scenario most
  // likely to leave a page in an interesting state — and it gets a fresh
  // context either way.
  stripOwnership,
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

  async dispose(): Promise<void> {
    const proc = this.#proc;
    this.#proc = null;
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch { /* already dead */ }
      await proc.status;
    }
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

// --- the run ---------------------------------------------------------------

async function main() {
  const wanted = Deno.args.filter((a) => !a.startsWith("-"));
  const headed = Deno.args.includes("--headed");
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

  const openPages: Page[] = [];
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
      return browser;
    },
    minioUrl: minio.url,
    minioAccess: MINIO_USER,
    minioSecret: MINIO_PASS,
    get minioDataDir() {
      return minio.dataDir;
    },
    stopMinio: () => minio.stop(),
    startMinio: () => minio.start(),
    fresh: async (opts: FreshOptions = {}) => {
      setPhase("newContext");
      const bctx = await newContext(browser, opts);
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
  }[] = [];
  const runList = wanted.length > 0
    ? SCENARIOS.filter((s) => wanted.includes(s.name))
    : SCENARIOS;
  if (wanted.length > 0 && runList.length !== wanted.length) {
    console.error(`unknown scenario(s): ${wanted.filter((w) => !SCENARIOS.some((s) => s.name === w))}`);
    Deno.exit(2);
  }

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
  const withDeadline = <T>(p: Promise<T>): Promise<T> => {
    let timer: number | undefined;
    const bomb = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${DEADLINE_MARK}: no progress in ${SCENARIO_DEADLINE_MS / 1000}s ` +
                `(a hang below the harness's own bounded waits — a wedged ` +
                `browser protocol call is the known cause)`,
            ),
          ),
        SCENARIO_DEADLINE_MS,
      );
    });
    return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
  };
  /** Bounded close-and-relaunch for a browser presumed wedged: close()
   * itself is a protocol call and can hang, so it races a short fuse
   * and the old process is abandoned to the OS if it does. */
  const recoverBrowser = async () => {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    browser = await launchBrowser();
    console.log("         (browser relaunched)");
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
        const chromeish = /chrom|headless/i.test(p.comm);
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
          page = await ctx.fresh(
            typeof scenario.page === "function" ? scenario.page(ctx) : scenario.page,
          );
          setPhase("scenario");
          await scenario.run(page, ctx);
          setPhase("idle");
        })());
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
          console.log(`         browser.isConnected(): ${browser.isConnected()}`);
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
      }
      // The crash shape: the renderer stopped answering (either named by
      // waitForBoot/driverBounded, or caught only by the deadline), or a
      // crash event was actually delivered. All three say "the browser
      // died", not "the demo is wrong".
      const crashShaped = failed && (
        (failure instanceof RendererGoneError) ||
        (failure instanceof Error && failure.name === "RendererGoneError") ||
        (failure instanceof Error && failure.message.startsWith(DEADLINE_MARK)) ||
        crashEventSeen
      );
      if (failed && crashShaped && attempt < MAX_ATTEMPTS) {
        console.log(
          "    !!   renderer crash/wedge — relaunching the browser and retrying the scenario",
        );
        await recoverBrowser();
        continue;
      }
      results.push({
        name: scenario.name,
        ok: !failed,
        ms: Math.round(performance.now() - t0),
        acts: actCount().acts,
        error: failed
          ? (failure instanceof Error ? failure.message : String(failure))
          : undefined,
        retried: attempt > 1,
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
    browser.close().catch(() => {}),
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
      }`,
    );
  }
  console.log(
    `\n  ${results.length - failed.length}/${results.length} scenarios passed in ${wall}s\n`,
  );
  Deno.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();
export { here };
