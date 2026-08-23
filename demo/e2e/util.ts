// Shared helpers for the demo's end-to-end scenarios.
//
// The house style here is the tasks-engine act runner's: a scenario is a
// sequence of ACTS, each one a named claim that either holds or does
// not. `act` prints the claim and throws on failure, so a scenario reads
// as the argument it is making and a failure names the beat that broke.

import type { Browser, BrowserContext, Page } from "npm:playwright@1.57.0";

/** What every scenario is handed: the page under test plus the levers
 * that live OUTSIDE the page (a fresh browser context, the MinIO the
 * credential beats need up — or down). */
export interface Ctx {
  /** Where the built `serve/` directory is being served from. */
  readonly baseUrl: string;
  readonly browser: Browser;
  /** Open a brand-new browser context (cookies, localStorage and
   * IndexedDB all empty) and boot the demo in it. */
  fresh(opts?: FreshOptions): Promise<Page>;
  /** Stop MinIO, for the beat that is ABOUT the store being unreachable. */
  stopMinio(): Promise<void>;
  /** Bring MinIO back up (a no-op when it is already running). */
  startMinio(): Promise<void>;
  readonly minioUrl: string;
  readonly minioAccess: string;
  readonly minioSecret: string;
  /** MinIO's own temp data directory (run.ts's `Minio` class) — the
   * filesystem witness solo-storage.ts reads a bucket's objects off,
   * rather than through anything this scenario is trying to prove.
   * `null` only before the harness's MinIO has ever started, which
   * cannot happen once a scenario is running. */
  readonly minioDataDir: string | null;
}

export interface FreshOptions {
  /** Seed localStorage before ANY page script runs. */
  storage?: Record<string, string>;
  /** Viewport, for the geometry beats. */
  viewport?: { width: number; height: number };
  /** Skip the boot wait — for the beats that watch booting itself. */
  noWait?: boolean;
  /** Let the demo pick (and ANNOUNCE) a fresh anchor colour. Off by
   * default: see `seedHue`. */
  freshAnchor?: boolean;
  /** WHICH DOCUMENT to open, as a root-relative path. Defaults to the
   * demo's own `/index.html` (i.e. the served root). The solo page
   * (`/solo.html`) is a SECOND embedder over the same served artifacts,
   * so the harness needs to be able to name it — the alternative was a
   * second runner, which would have meant a second relay, a second
   * MinIO and a second set of crash-recovery machinery for one page. */
  path?: string;
  /** The global the boot wait polls for. Defaults to `__demo`; the solo
   * page installs `__solo`. Named rather than sniffed, so a page that
   * booted the WRONG document fails the wait instead of passing on the
   * other page's marker. */
  bootGlobal?: string;
  /** Extra URL query parameters for this scenario's page — e.g.
   * `{ pairing: "mock" }`. MERGED over the harness's own base query (see
   * `pageUrl`), which is how every page in the suite gets the local
   * relay without a scenario having to know the relay exists. A
   * scenario may override a base parameter by naming it here; that is a
   * deliberate escape hatch, not an accident, so nothing hides it. */
  query?: Record<string, string>;
}

/** The URL a scenario's page is opened at: the served site, plus the
 * harness's base query (the ephemeral local relay), plus whatever the
 * scenario asked for. ONE place, so a new world-level parameter reaches
 * all thirteen scenarios by being added to the base — the alternative
 * was editing every scenario, which is how a suite ends up half
 * hermetic. */
export function pageUrl(
  baseUrl: string,
  baseQuery: Record<string, string>,
  opts: FreshOptions = {},
): string {
  const url = new URL(baseUrl);
  if (opts.path) url.pathname = opts.path;
  for (const [k, v] of Object.entries({ ...baseQuery, ...(opts.query ?? {}) })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/** The demo's own storage keys, mirrored from host/demo.ts. Duplicated
 * rather than imported because the browser-side module is bundled for
 * the page and importing it here would drag the whole polyengine graph into
 * the harness. If a key is renamed there, the scenario that depends on
 * it fails loudly — which is the point of a tripwire. */
export const KEYS = {
  hue: "pm-demo-visor-hue",
  identity: "pm-demo-identity",
  marks: "pm-demo-surface-marks",
  storage: "pm-demo-storage",
  legacyS3: "pm-demo-s3",
} as const;

/** The SOLO page's own keys, mirrored from host/solo.ts for the same
 * reason as `KEYS` above (a rename there fails the scenario loudly). The
 * `pm-solo-` prefix is the whole point: two embedders on one origin must
 * not share an identity, or the second page is not a second device. */
export const SOLO_KEYS = {
  hue: "pm-solo-visor-hue",
  identity: "pm-solo-identity",
  marks: "pm-solo-surface-marks",
} as const;

/** CONTRACT (host/demo.ts:1573-1576): a boot that finds NO stored anchor
 * hue picks one and ANNOUNCES it for 15 seconds — and that announcement
 * owns `.ctx-bottom`, which is the very line most scenarios assert on.
 * The announcement is correct behaviour, so the harness does not fight
 * it: it seeds a committed hue so a boot is the ordinary second-visit
 * boot, and the one scenario that is about the fresh anchor opts in with
 * `freshAnchor: true`. */
const seedHue = "265";

// --- act discipline --------------------------------------------------------

let acts = 0;
let failures = 0;

export function actCount(): { acts: number; failures: number } {
  return { acts, failures };
}

export function resetActs(): void {
  acts = 0;
  failures = 0;
}

/** Run one act: print the claim, run the body, print pass or fail. A
 * throwing body fails the act AND the scenario — the sequence is an
 * argument, and a broken step invalidates everything downstream. */
export async function act(claim: string, body: () => Promise<void> | void): Promise<void> {
  acts++;
  const started = performance.now();
  try {
    await body();
    const ms = Math.round(performance.now() - started);
    console.log(`    ok   ${claim} (${ms}ms)`);
  } catch (e) {
    failures++;
    console.log(`    FAIL ${claim}`);
    console.log(`         ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(haystack: string, needle: string, msg: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg}: ${JSON.stringify(needle)} not found in ${JSON.stringify(haystack)}`);
  }
}

/** Element-wise, for the small string lists the strip is read as. */
export function assertList(actual: string[], expected: string[], msg: string): void {
  const same = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  if (!same) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- page helpers ----------------------------------------------------------

/** Generous but BOUNDED: a wasm component graph booting under polyengine in
 * a cold headless browser is slow, and a scenario that hangs forever is
 * worse than one that fails. */
export const BOOT_TIMEOUT = 90_000;
export const UI_TIMEOUT = 15_000;
/** The strip's announcements last 8s (host/demo.ts `announce` default),
 * so a revert-by-re-render lands just after. */
export const ANNOUNCE_MS = 8_000;
/** The context cluster's arrival PULSE lasts 1.8s — the
 * `visor-ctx-pulse` animation of visor/ui/visor.css, .9s × 2 cycles,
 * mirrored by `PULSE_MS` in visor/ui/visor.ts's cleanup fallback. The
 * `pulse` class is off the element by then. */
export const PULSE_MS = 1_800;
/** The drawer's OCCUPANT SWAP — the band sliding out while a ceremony
 * slides in, and back again (visor/ui/visor.ts's `SWAP_MS`, matched by
 * the `.visor-swap-*` transitions in visor/ui/visor.css). The departing
 * sheet is on screen for exactly this long and is then removed by the
 * host. */
export const SWAP_MS = 420;

export async function newContext(
  browser: Browser,
  opts: FreshOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
  });
  const seed: Record<string, string> = { ...(opts.storage ?? {}) };
  // THE HUE SEED FOLLOWS THE PAGE. Each embedder owns its own storage
  // keys (that is what makes two pages on one origin two devices), so
  // seeding the demo's key on a solo page would leave the solo visor
  // rolling a fresh anchor and ANNOUNCING it for 15s — over the very
  // line the scenario reads.
  const hueKey = opts.path?.includes("solo") ? SOLO_KEYS.hue : KEYS.hue;
  if (!opts.freshAnchor && seed[hueKey] === undefined) seed[hueKey] = seedHue;
  if (Object.keys(seed).length > 0) {
    await context.addInitScript((entries: [string, string][]) => {
      // Runs before every document's own scripts, which is the only
      // moment a seeded config is indistinguishable from one a previous
      // visit left behind.
      //
      // SEED ONLY WHAT IS ABSENT. This script runs on EVERY document in
      // the context, reloads included, so an unconditional write would
      // silently undo whatever the page just committed — and a reload is
      // precisely how several scenarios check that a commit persisted.
      try {
        for (const [k, v] of entries) {
          if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        }
      } catch { /* storage unavailable: the demo tolerates it, so do we */ }
    }, Object.entries(seed));
  }
  return context;
}

/** The renderer stopped answering the protocol altogether: no evaluate
 * result, no rejection, and (in the observed CI mode) no crash event
 * either. Distinct from a timeout, because it is a statement about the
 * BROWSER rather than about the demo — the runner retries a scenario
 * that fails this way. */
export class RendererGoneError extends Error {
  constructor(what: string, detail: string) {
    super(
      `the renderer stopped answering (crashed without delivering a crash event?) ` +
        `while waiting for ${what}: ${detail}`,
    );
    this.name = "RendererGoneError";
  }
}

/** How long a single probe may take before the renderer counts as
 * silent for that interval. */
const PROBE_STALL_MS = 5_000;
/** Continuous protocol silence that means the renderer is gone. */
const RENDERER_SILENCE_MS = 20_000;
/** How long past an IN-PAGE timeout the driver waits before declaring
 * the renderer gone. */
const GRACE_MS = 10_000;
/** Race token: this probe answered nothing within PROBE_STALL_MS. */
const STALLED = Symbol("stalled");

/** Wait for the demo to finish booting: `__demo` installed AND the
 * banner saying so. Both, because `__demo` is assigned near the end of
 * `boot` but the banner is the user-visible claim.
 *
 * A HARNESS-SIDE PROBE LOOP, not `page.waitForFunction`. CI run
 * 32486407187: the renderer took SIGSEGV (SEGV_ACCERR) mid reload-boot
 * and hung in its own crash handler — no crash event was delivered,
 * `browser.isConnected()` stayed true, and the boot wait never returned
 * because once `waitForFunction` has INJECTED its poller the timeout is
 * enforced in the page, and it died with the renderer. Reproduced
 * deterministically by SIGSTOPping the renderer: silence AFTER injection
 * hangs forever; silence BEFORE it gets the driver-side 90s. So the whole
 * clock lives here, in Deno timers, where no part of it can die with the
 * page.
 *
 * A probe REJECTION resets the silence clock: a rejection is a protocol
 * ANSWER (e.g. "Execution context was destroyed", which is what an
 * ordinary mid-reload probe gets), and the mode being detected answers
 * nothing at all. Only crash/closed-shaped rejections are fatal. */
export async function waitForBoot(page: Page, bootGlobal = "__demo"): Promise<void> {
  let crashed = false;
  const onCrash = () => {
    crashed = true;
  };
  // waitForBoot runs many times per run; a leaked listener per call
  // accumulates, so it comes off in the finally below.
  page.on("crash", onCrash);
  const started = performance.now();
  let silentSince: number | null = null;
  let last = "no probe has answered yet";
  try {
    for (;;) {
      // A crash delivered BEFORE this call (the runner attaches its own
      // listener at `fresh` time) counts too.
      if (crashed || (page as unknown as { __crashed?: () => boolean }).__crashed?.()) {
        throw new RendererGoneError("the demo to boot", "a crash event was delivered");
      }
      if (performance.now() - started > BOOT_TIMEOUT) {
        throw new Error(
          `boot timeout: the demo did not report ready within ${BOOT_TIMEOUT / 1000}s (${last})`,
        );
      }
      const probe = page.evaluate((g: string) => {
        const d = (globalThis as Record<string, unknown>)[g];
        const banner = document.getElementById("banner")?.textContent ?? "";
        return d !== undefined && banner.includes("ready");
      }, bootGlobal);
      let stallTimer: number | undefined;
      const stall = new Promise<symbol>((r) => {
        stallTimer = setTimeout(() => r(STALLED), PROBE_STALL_MS);
      });
      let outcome: boolean | symbol | string;
      try {
        outcome = await Promise.race<boolean | symbol | string>([
          probe.then((v) => v, (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            // A rejection is an ANSWER. Only crash/closed-shaped ones say
            // the renderer is gone; "Execution context was destroyed" is
            // the ordinary mid-reload case and just means "probe again".
            if (/crash|closed/i.test(msg)) throw new RendererGoneError("the demo to boot", msg);
            return `the probe rejected: ${msg}`;
          }),
          stall,
        ]);
      } finally {
        clearTimeout(stallTimer);
      }
      if (outcome === STALLED) {
        // Do NOT keep awaiting the abandoned probe — but DO swallow its
        // eventual rejection: under Deno an unhandled rejection (this one
        // lands minutes later, when the browser is closed) kills the
        // process.
        probe.catch(() => {});
        silentSince ??= performance.now() - PROBE_STALL_MS;
        const silentFor = performance.now() - silentSince;
        last = `no answer for ${(silentFor / 1000).toFixed(1)}s`;
        if (silentFor >= RENDERER_SILENCE_MS) {
          throw new RendererGoneError(
            "the demo to boot",
            `no probe answered for ${(silentFor / 1000).toFixed(1)}s`,
          );
        }
        continue;
      }
      // Anything else is an ANSWER: the renderer is talking.
      silentSince = null;
      if (outcome === true) return;
      last = typeof outcome === "boolean" ? "the page said it is not ready yet" : String(outcome);
      await sleep(250);
    }
  } finally {
    page.off("crash", onCrash);
  }
}

/** A DRIVER-SIDE grace bomb around an in-page wait.
 *
 * Every `page.waitForFunction` carries its timeout INSIDE the page, so it
 * dies with the renderer (see waitForBoot). When the renderer is alive
 * the in-page timeout at `timeoutMs` always fires first; therefore this
 * bomb firing at `timeoutMs + GRACE_MS` MEANS the renderer is gone. */
async function driverBounded<T>(
  page: Page,
  p: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: number | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RendererGoneError(
            what,
            `the in-page wait's own ${timeoutMs / 1000}s timeout never fired ` +
              `(${GRACE_MS / 1000}s past it)`,
          ),
        ),
      timeoutMs + GRACE_MS,
    );
  });
  let onCrash!: () => void;
  const crash = new Promise<never>((_, reject) => {
    onCrash = () => reject(new RendererGoneError(what, "a crash event was delivered"));
  });
  page.on("crash", onCrash);
  try {
    return await Promise.race([p, bomb, crash]);
  } finally {
    clearTimeout(timer);
    page.off("crash", onCrash);
    // The loser can settle much later; an unhandled rejection is fatal
    // under Deno.
    p.catch(() => {});
    bomb.catch(() => {});
    crash.catch(() => {});
  }
}

/** The strip's two lines, as text. The whole harness reads the visor
 * through these — they are what a user sees. */
export function stripText(page: Page): Promise<{ top: string; bottom: string }> {
  return page.evaluate(() => {
    const ctx = document.getElementById("visor-context");
    return {
      top: (ctx?.querySelector(".ctx-top") as HTMLElement | null)?.textContent ?? "",
      bottom: (ctx?.querySelector(".ctx-bottom") as HTMLElement | null)?.textContent ?? "",
    };
  });
}

/** Wait until the strip's bottom line satisfies a predicate on its text.
 * DETERMINISTIC WAITING is the rule in this harness: the DOM is the
 * clock, and a sleep is only used where the thing being tested IS a
 * timer (the arming delay, the announcement revert). */
export async function waitForBottom(
  page: Page,
  pred: (text: string) => boolean,
  what: string,
  timeout = UI_TIMEOUT,
): Promise<string> {
  return await driverBounded(page, (async () => {
    const handle = await page.waitForFunction(
      (src: string) => {
        const fn = new Function("t", `return (${src})(t)`) as (t: string) => boolean;
        const el = document.querySelector("#visor-context .ctx-bottom");
        const text = el?.textContent ?? "";
        return fn(text) ? text : false;
      },
      pred.toString(),
      { timeout },
    ).catch(async (e) => {
      const now = (await stripText(page)).bottom;
      throw new Error(`waiting for ${what}: bottom line was ${JSON.stringify(now)} (${e.message})`);
    });
    return await handle.jsonValue() as string;
  })(), timeout, what);
}

/** Is a visor sheet of the given tenant open? Read through `__demo`,
 * which is the demo's own account of its drawer state. */
export function sheetOpen(
  page: Page,
  tenant: "naming" | "settings" | "drawer" | "picker",
): Promise<boolean> {
  return page.evaluate((t: string) => {
    const d = (globalThis as Record<string, unknown>).__demo as Record<
      string,
      { open?: () => boolean; isOpen?: () => boolean }
    >;
    // The picker's handle reads `isOpen` (its `open` OPENS it — the
    // handle is the ceremony's entry point, not a predicate).
    return t === "picker" ? d[t].isOpen?.() === true : d[t].open?.() === true;
  }, tenant);
}

export async function waitForSheet(
  page: Page,
  tenant: "naming" | "settings" | "drawer" | "picker",
  want: boolean,
  timeout = UI_TIMEOUT,
): Promise<void> {
  await driverBounded(
    page,
    page.waitForFunction(
      ({ t, want }: { t: string; want: boolean }) => {
        const d = (globalThis as Record<string, unknown>).__demo as Record<
          string,
          { open?: () => boolean; isOpen?: () => boolean }
        >;
        const open = t === "picker" ? d[t].isOpen?.() === true : d[t].open?.() === true;
        return open === want;
      },
      { t: tenant, want },
      { timeout },
    ).catch((e) => {
      throw new Error(
        `waiting for the ${tenant} sheet to be ${want ? "open" : "closed"}: ${e.message}`,
      );
    }),
    timeout,
    `the ${tenant} sheet to be ${want ? "open" : "closed"}`,
  );
}

/** WHICH PAGE THE TRACK IS SHOWING. The storage configuration is a
 * sibling PAGE under the same pinned strip, not a modal (web/index.html's
 * #page-track), so "is storage up?" is a question about the track's
 * state class rather than about a <dialog>'s `open` property. */
export function onStoragePage(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    document.getElementById("page-track")?.classList.contains("show-storage") === true
  );
}

/** Wait until the track is showing (or has left) the storage page. */
export function waitForStoragePage(
  page: Page,
  want: boolean,
  timeout = UI_TIMEOUT,
): Promise<unknown> {
  return driverBounded(
    page,
    page.waitForFunction(
      (want: boolean) =>
        (document.getElementById("page-track")?.classList.contains("show-storage") === true) ===
          want,
      want,
      { timeout },
    ).catch((e) => {
      throw new Error(`waiting for the storage page to be ${want ? "up" : "left"}: ${e.message}`);
    }) as Promise<unknown>,
    timeout,
    `the storage page to be ${want ? "up" : "left"}`,
  );
}

/** THE STRIP'S BACK CHEVRON (visor/ui/visor.ts's `setBack`), as the DOM
 * has it. `present` is the whole control's existence — null renders
 * nothing at all, so absence is the honest reading of "not in a nested
 * place" — and `inStrip` is the claim that makes it worth having: the
 * control lives in the one region no component can draw, which is what
 * separates it from a page's own cancel button that an app can
 * reproduce pixel for pixel. */
export function backControl(page: Page): Promise<
  { present: boolean; inStrip: boolean; label: string; glyph: string }
> {
  return page.evaluate(() => {
    const el = document.getElementById("visor-back");
    return {
      present: el !== null,
      inStrip: el?.closest("#visor-strip") !== null && el?.closest("#visor-strip") !== undefined,
      label: el?.getAttribute("aria-label") ?? "",
      glyph: el?.textContent ?? "",
    };
  });
}

/** IS THE VISOR STRIP ACTUALLY VISIBLE AND UNOBSCURED? The whole point of
 * replacing the storage modal with a page slide: a modal paints in the
 * top layer, above #visor-zone, and dims everything under it, so the
 * strip's identity flip to an arriving component happened where the user
 * could not see it.
 *
 * The test is a HIT TEST, not a style read: `elementFromPoint` at the
 * strip's centre returns whatever the user would actually touch there,
 * which is the only way to catch something painted over it (a top-layer
 * dialog, a backdrop, a stray overlay). It resolving INSIDE #visor-strip
 * is the claim. */
export function stripUnobscured(page: Page): Promise<{ visible: boolean; hitInStrip: boolean }> {
  return page.evaluate(() => {
    const strip = document.getElementById("visor-strip");
    if (!strip) return { visible: false, hitInStrip: false };
    const r = strip.getBoundingClientRect();
    const visible = r.height > 0 && r.top >= 0 && r.top < globalThis.innerHeight;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { visible, hitInStrip: hit !== null && strip.contains(hit) };
  });
}

/** Wait until the storage page's panel is not merely PRESENT but
 * REGISTERED: the visor fetches the artifact, mounts it, asks it for its
 * nickname and computes the DESTINATION it is bound to. An iframe in the
 * region appears before all that finishes, so "the iframe is there" is a
 * weaker claim — a Save clicked in between finds a panel with nothing to
 * commit, and the scenario fails for a reason that is not the one under
 * test.
 *
 * `boundDestination()` is the signal: it is null until the visor has bound
 * the panel to an origin, and a non-null binding is exactly the
 * precondition the visor's own Save re-validates against. Side-effect free.
 *
 * (The strip's context is NOT usable for this, for a plainer reason than
 * this comment once gave: the visor claims the top line for the panel in
 * STAGES — the provenance key at mount, the self-declared nickname a
 * moment later — so the line is a poor readiness signal even though it
 * is never WRONG. That it is never wrong is its own claim, made by
 * scenarios/strip-ownership.ts.) */
export async function waitForPanelSurface(page: Page, timeout = UI_TIMEOUT): Promise<void> {
  await driverBounded(
    page,
    page.waitForFunction(
      () =>
        document.querySelectorAll("#panel-region iframe").length > 0 &&
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.boundDestination() !== null,
      undefined,
      { timeout },
    ).catch(async (e) => {
      const region = await page.evaluate(() =>
        document.getElementById("panel-region")?.textContent?.slice(0, 200) ?? ""
      );
      throw new Error(
        `waiting for the panel surface to register: the region said ${
          JSON.stringify(region)
        } (${e.message})`,
      );
    }),
    timeout,
    "the panel surface to register",
  );
}

/** The drawer HIDES on a transition (the sheet collapses its height
 * first), so "the drawer is away" is a wait rather than a sample. */
export async function waitForDrawerHidden(page: Page, timeout = UI_TIMEOUT): Promise<void> {
  await driverBounded(
    page,
    page.waitForFunction(
      () => (document.getElementById("visor-drawer") as HTMLElement).hidden === true,
      undefined,
      { timeout },
    ).catch((e) => {
      throw new Error(`waiting for the drawer to be hidden: ${e.message}`);
    }),
    timeout,
    "the drawer to be hidden",
  );
}

/** The text of the sheet currently in the drawer. */
export function sheetText(page: Page): Promise<string> {
  return page.evaluate(() =>
    document.getElementById("visor-drawer-inner")?.textContent ?? ""
  );
}

/** A pane's status line — where the engine's own words land. */
export function paneStatus(page: Page, pane: "alice" | "bob" | "tablet"): Promise<string> {
  return page.evaluate(
    (p: string) => document.getElementById(`${p}-status`)?.textContent ?? "",
    pane,
  );
}

export async function waitForPaneStatus(
  page: Page,
  pane: "alice" | "bob" | "tablet",
  pred: (text: string) => boolean,
  what: string,
  timeout = UI_TIMEOUT,
): Promise<string> {
  return await driverBounded(page, (async () => {
    const handle = await page.waitForFunction(
      ({ p, src }: { p: string; src: string }) => {
        const fn = new Function("t", `return (${src})(t)`) as (t: string) => boolean;
        const text = document.getElementById(`${p}-status`)?.textContent ?? "";
        return fn(text) ? text : false;
      },
      { p: pane, src: pred.toString() },
      { timeout },
    ).catch(async (e) => {
      const now = await paneStatus(page, pane);
      throw new Error(
        `waiting for ${what} on ${pane}: status was ${JSON.stringify(now)} (${e.message})`,
      );
    });
    return await handle.jsonValue() as string;
  })(), timeout, `${what} on ${pane}`);
}

/** Record every `localStorage` write from now on.
 *
 * Some commits are deliberately QUIET on screen: a pane's status line
 * suppresses a non-sticky message while a sticky one is still holding
 * (host/demo.ts:1132), so "the visor persisted the config" can be true and
 * invisible at the same time. The durable write is the honest observable
 * for those beats — and for a credential path it is also the one worth
 * checking, because WHAT was written is the security claim. */
export async function recordStorageWrites(
  page: Page,
): Promise<() => Promise<{ key: string; value: string }[]>> {
  await page.evaluate(() => {
    const store = ((globalThis as Record<string, unknown>).__e2e_writes = [] as unknown[]);
    const proto = Object.getPrototypeOf(localStorage);
    const original = proto.setItem;
    proto.setItem = function (key: string, value: string) {
      store.push({ key, value });
      return original.call(this, key, value);
    };
  });
  return () =>
    page.evaluate(() =>
      ((globalThis as Record<string, unknown>).__e2e_writes ?? []) as {
        key: string;
        value: string;
      }[]
    );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Record EVERY value a pane's status line takes from now on.
 *
 * Polling a status line is a sampling race: the demo's stats tick
 * rewrites each pane's status every 4 seconds, so a transient step
 * message ("configuring storage: grants…") can appear and be overwritten
 * between two samples — and then a real beat looks like it never
 * happened. An observer installed BEFORE the action cannot miss it. */
export async function recordPaneStatus(
  page: Page,
  pane: "alice" | "bob" | "tablet",
): Promise<{ seen(): Promise<string[]>; sawText(needle: string, timeout?: number): Promise<string> }> {
  const slot = `__e2e_status_${pane}`;
  await page.evaluate(({ p, slot }: { p: string; slot: string }) => {
    const el = document.getElementById(`${p}-status`)!;
    const store = ((globalThis as Record<string, unknown>)[slot] = [] as string[]);
    store.push(el.textContent ?? "");
    new MutationObserver(() => store.push(el.textContent ?? "")).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }, { p: pane, slot });
  const seen = () =>
    page.evaluate((s: string) => (globalThis as unknown as Record<string, string[]>)[s] ?? [], slot);
  return {
    seen,
    async sawText(needle: string, timeout = UI_TIMEOUT) {
      return await driverBounded(page, (async () => {
        const handle = await page.waitForFunction(
          ({ s, needle }: { s: string; needle: string }) => {
            const store = (globalThis as unknown as Record<string, string[]>)[s] ?? [];
            return store.find((t) => t.includes(needle)) ?? false;
          },
          { s: slot, needle },
          { timeout },
        ).catch(async (e) => {
          throw new Error(
            `${pane} never showed ${JSON.stringify(needle)}; it showed ${
              JSON.stringify(await seen())
            } (${e.message})`,
          );
        });
        return await handle.jsonValue() as string;
      })(), timeout, `${pane} to show ${JSON.stringify(needle)}`);
    },
  };
}

/** Record EVERY value the strip's SURFACE-NAME line takes, from now on.
 *
 * That is the BOTTOM line: the claims-and-status row, where the
 * component's own quoted account of itself lives (the top line is the
 * user's — their mark and their word, or the visor's offer to create
 * them). The claim being made about it is a NEVER: no deferred visor
 * timer may put one surface's name up while a different surface owns the
 * context. A
 * `never` cannot be checked by sampling — the wrong label may be up for
 * one frame — so this records rather than polls, on BOTH edges:
 *
 *   - a MutationObserver, which cannot miss a value the DOM took;
 *   - a rAF tick, which timestamps how long each value was actually on
 *     screen (a mutation pair that lands within one frame never painted).
 *
 * `stop()` returns every distinct value observed, in order. */
export async function recordSurfaceLine(page: Page): Promise<{
  samples(): Promise<string[]>;
  stop(): Promise<string[]>;
}> {
  await page.evaluate(() => {
    const el = document.querySelector("#visor-context .ctx-bottom") as HTMLElement;
    const store = ((globalThis as Record<string, unknown>).__e2e_ctx_top = [] as string[]);
    const push = () => {
      const text = (el.textContent ?? "").trim();
      if (store.length === 0 || store[store.length - 1] !== text) store.push(text);
    };
    push();
    const mo = new MutationObserver(push);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    let running = true;
    const tick = () => {
      if (!running) return;
      push();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (globalThis as Record<string, unknown>).__e2e_ctx_top_stop = () => {
      running = false;
      mo.disconnect();
      push();
    };
  });
  const samples = () =>
    page.evaluate(() =>
      ((globalThis as Record<string, unknown>).__e2e_ctx_top ?? []) as string[]
    );
  return {
    samples,
    async stop() {
      await page.evaluate(() =>
        ((globalThis as Record<string, unknown>).__e2e_ctx_top_stop as () => void)?.()
      );
      return await samples();
    },
  };
}

/** Everything the page has said on its console since it was opened.
 *
 * The runner attaches the collector at `ctx.fresh` time (run.ts) and
 * dumps the tail when a scenario fails. A scenario that is ABOUT the
 * absence of a particular complaint has to read it directly: a mount
 * that fails on a race is caught by the visor's own `.catch` and written
 * into the panel region, but the warnings around it only exist here. */
export function consoleLog(page: Page): string[] {
  return (page as unknown as { __log?: string[] }).__log ?? [];
}

/** The panel region's text — where `openStorage`'s mount `.catch` writes
 * `panel failed to mount: …`. The region normally holds nothing but the
 * surface's iframe, so any text in it at all is the visor reporting a
 * failure. */
export function regionText(page: Page): Promise<string> {
  return page.evaluate(() =>
    (document.getElementById("panel-region")?.textContent ?? "").trim()
  );
}

// --- the demo's own driving hooks -----------------------------------------
//
// `__demo` (host/demo.ts, near the end of `boot`) is the demo's OWN
// account of itself, installed for exactly this purpose. The harness
// prefers it to DOM archaeology wherever the two agree — and prefers the
// DOM wherever the claim is about what a user can SEE.

/** One row of the visor's trust table, as the visor holds it. */
export interface Surface {
  name: string;
  nickname: string;
  petname?: string;
  isNew: boolean;
  /** THE PET ICON (#22 discussion): one glyph out of the visor's curated
   * vocabulary, or "" for UNMARKED. Replaces `hue`, and with it the
   * colour chip the strip used to draw. */
  icon: string;
  /** What the component asked to wear, once the visor has validated it
   * at the seam. Undefined when the component nominated nothing, or
   * nominated something the visor refused. */
  nomination?: string;
  firstSeen?: number;
}

/** One offer in the naming ceremony's pet-icon picker, exactly as the
 * sheet renders it (`__demo.naming.offers`). */
export interface IconOffer {
  glyph: string;
  /** The visor flagged this one as the COMPONENT's request, not its
   * own — the button is drawn differently and the sheet carries a
   * foreign-attributed line above the row. */
  nominated: boolean;
  picked: boolean;
}

export function iconOffers(page: Page): Promise<IconOffer[]> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.naming.offers());
}

/** The foreign attribution line above the picker ("" when the surface
 * has no nomination on offer). */
export function nominationLine(page: Page): Promise<string> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.naming.nominationLine());
}

/** The pet icon the STRIP is currently showing for the surface the
 * cluster is about — "" when the surface is unmarked, which is the
 * honest rendering of "the user has not said anything about this yet".
 * It lives on the TOP line, beside the user's own word for the
 * component: one recognition pair, read together. */
export function stripMarkIcon(page: Page): Promise<string> {
  return page.evaluate(() =>
    (document.querySelector("#visor-context .ctx-top .mark-icon") as HTMLElement | null)
      ?.textContent ?? ""
  );
}

export function appSurface(page: Page): Promise<Surface | null> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.appSurface()) as Promise<Surface | null>;
}

export function frameProbe(
  page: Page,
): Promise<{ appFrames: number; sameOriginReachable: boolean; sandbox: (string | null)[] }> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.frameProbe());
}

/** The persisted trust table (`loadMarks()` through the naming hook). */
export function marks(page: Page): Promise<Record<string, unknown>> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.naming.marks());
}

/** The persisted visor identity record (`loadIdentity()`). */
export function identity(
  page: Page,
): Promise<{ name?: string; device?: string; icon?: string }> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.settings.identity());
}

/** The refusal/explanation line inside the App settings sheet. */
export function namingReason(page: Page): Promise<string> {
  // deno-lint-ignore no-explicit-any
  return page.evaluate(() => (globalThis as any).__demo.naming.reason());
}

/** Call a `__demo` hook by path, e.g. `hook(page, "naming.save")`. Every
 * one of these CLICKS a real control rather than calling a handler (see
 * the comments on `__demo.drawer`), so a driver sees the arming delay
 * exactly as a user does. */
// deno-lint-ignore no-explicit-any
export function hook(page: Page, path: string, ...args: any[]): Promise<any> {
  return hookOn(page, "__demo", path, ...args);
}

/** The same, against a NAMED driving root. The solo page installs
 * `__solo` rather than `__demo` (a second embedder, not a second copy of
 * the first), and the root is passed explicitly rather than sniffed so a
 * call against a page that booted the wrong document fails loudly
 * instead of silently finding the other page's hooks. */
// deno-lint-ignore no-explicit-any
export function hookOn(page: Page, root: string, path: string, ...args: any[]): Promise<any> {
  return page.evaluate(
    // deno-lint-ignore no-explicit-any
    ({ root, path, args }: { root: string; path: string; args: any[] }) => {
      // deno-lint-ignore no-explicit-any
      const base: any = (globalThis as any)[root];
      if (base === undefined) throw new Error(`no ${root} on this page`);
      // deno-lint-ignore no-explicit-any
      let target: any = base;
      const parts = path.split(".");
      const last = parts.pop()!;
      for (const p of parts) target = target[p];
      return target[last](...args);
    },
    { root, path, args },
  );
}

