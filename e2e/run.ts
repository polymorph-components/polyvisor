// The M1 gates on real Chromium (docs/design.md "Delivery": "Playwright on
// real Chromium for every claim about pixels or realms", and "M1": "app
// renders in the opaque frame; strip geometry immobile with the app mounted;
// zero network requests from the frame; no JSPI").
//
// The server sets neither COOP nor COEP: a SharedWorker needs none, and
// setting them would make this harness diverge from what a home origin
// actually serves.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { contentType } from "@std/media-types";
import { extname, join, normalize } from "@std/path";

const DIST = new URL("../web/dist", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

function serve(): { origin: string; stop(): Promise<void> } {
  const server = Deno.serve({
    port: 0, // The kernel picks; parallel checkouts must not collide.
    hostname: "127.0.0.1",
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    // `normalize` collapses `..` before the join, so a request cannot climb
    // out of dist.
    const file = join(DIST, normalize(path));
    if (!file.startsWith(DIST)) return new Response("no", { status: 403 });
    try {
      const body = await Deno.readFile(file);
      return new Response(body, {
        headers: {
          "content-type": contentType(extname(file)) ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class Failure extends Error {}

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Failure(what);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Failure(`${what}: got ${a}, want ${e}`);
}

interface Scenario {
  name: string;
  run(ctx: BrowserContext, origin: string): Promise<void>;
}

/** Wait for the visor to have painted its strip, and fail loudly on the
 * framework's fatal text rather than on a 30s timeout. */
async function visorReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector("#visor-strip") !== null ||
      (document.querySelector("#visor")?.textContent ?? "").includes(
        "could not start",
      ),
    undefined,
    { timeout: 30_000 },
  );
  const fatal = await page.locator("#visor").textContent();
  check(
    !(fatal ?? "").includes("could not start"),
    `the visor reported a fatal: ${fatal}`,
  );
}

/** The tab's device anchor, as `web/boot.ts` spells it. */
const ANCHOR = "polyvisor.device";

async function open(ctx: BrowserContext, origin: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  page error:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  console:", m.text());
  });
  await page.goto(origin + "/");
  return page;
}

// ---------------------------------------------------------------------------
// The visor, as these scenarios drive it
//
// Every selector and every label below is the visor's own tree (visor/src/
// ui.rs): `#visor-strip` with `.unclaimed` until the device is open,
// `#visor-circle` carrying the hue and nothing else ever painting it,
// `#visor-drawer` holding one tenant at a time, `.sheet` / `.sheet-error` /
// `.app-row` / `.device-row`. They live in one block so a visor rename is one
// edit here rather than six.
// ---------------------------------------------------------------------------

const strip = (page: Page) => page.locator("#visor-strip");
const drawer = (page: Page) => page.locator("#visor-drawer");

/** Press one of the strip's tenant buttons and wait for the drawer. */
async function openTenant(page: Page, label: string): Promise<void> {
  await strip(page).getByRole("button", { name: label, exact: true }).click();
  await drawer(page).waitFor({ timeout: 10_000 });
}

/** The `.sheet` whose head says `head` — the drawer stacks several. */
function sheet(page: Page, head: string | RegExp) {
  return drawer(page).locator(".sheet").filter({ hasText: head }).first();
}

/**
 * Launch an installed app by its title.
 *
 * `awaitFrame` is false for an app that is expected to be refused: the
 * hostile fixture's frame can be torn down before a `waitForSelector` on it
 * ever polls, and "the frame existed for a moment" is not part of any claim
 * — the claim is what the strip says afterwards.
 */
async function launchApp(
  page: Page,
  title: string,
  awaitFrame = true,
): Promise<void> {
  await openTenant(page, "Apps");
  const row = drawer(page).locator(".app-row").filter({ hasText: title })
    .first();
  await row.waitFor({ timeout: 10_000 });
  await row.getByRole("button", { name: "Open", exact: true }).click();
  if (awaitFrame) {
    await page.waitForSelector("#app-zone iframe[sandbox]", {
      timeout: 30_000,
    });
  }
}

async function launchTodoMvc(page: Page): Promise<void> {
  await launchApp(page, "TodoMVC");
}

/** Settings → the device's user-voice name. */
async function setDeviceName(page: Page, name: string): Promise<void> {
  await openTenant(page, "Settings");
  const field = drawer(page).locator("label").filter({ hasText: /^name$/ })
    .locator("input");
  await field.fill(name);
  // The visor writes on `change`, not on every keystroke.
  await field.blur();
}

/**
 * "Keep this device" (docs/design.md "Devices": the promotion from ephemeral
 * to durable). `passphrase === undefined` is the rests-open tier.
 *
 * Leaves the Settings tenant open, showing the kept note.
 */
async function keepDevice(
  page: Page,
  petname: string,
  passphrase?: string,
): Promise<void> {
  if (await drawer(page).count() === 0) await openTenant(page, "Settings");
  const keep = sheet(page, "Keep this device");
  await keep.waitFor({ timeout: 10_000 });
  await keep.locator("input[type=text]").fill(petname);
  if (passphrase === undefined) {
    await keep.getByRole("button", { name: "rests open on this browser" })
      .click();
  } else {
    await keep.getByRole("button", { name: "passphrase", exact: true }).click();
    const fields = keep.locator("input[type=password]");
    await fields.nth(0).fill(passphrase);
    await fields.nth(1).fill(passphrase);
  }
  await keep.getByRole("button", { name: "Keep", exact: true }).click();
  await sheet(page, "kept as").waitFor({ timeout: 15_000 });
}

/** Is the strip painted with an identity? `.unclaimed` is the whole dress:
 * one class, and `#visor-circle` gets a background only in the open arm. */
async function claimed(page: Page): Promise<boolean> {
  const cls = await strip(page).getAttribute("class") ?? "";
  const style = await page.locator("#visor-circle").getAttribute("style") ?? "";
  const painted = style.includes("hsl(");
  if (cls.includes("unclaimed") && painted) {
    throw new Failure(
      "the strip is unclaimed and yet the anchor colour is painted — " +
        'docs/design.md "Devices" forbids exactly that',
    );
  }
  return !cls.includes("unclaimed");
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "boot",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const strip = page.locator("#visor-strip");
      const box = await strip.boundingBox();
      check(box !== null, "#visor-strip has no box");
      eq(box!.height, 56, "#visor-strip height");
      // The strip says "waking" until `device.status` answers over the
      // worker port; the placeholder is the first kernel-backed pixel.
      await strip.getByText("this device").waitFor({ timeout: 10_000 });
    },
  },

  {
    name: "open-app",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const strip = page.locator("#visor-strip");
      const before = await strip.boundingBox();

      await launchTodoMvc(page);

      // The app renders in an opaque origin: nothing on this side can read
      // into its document. Chromium answers `null` for a sandboxed frame
      // without `allow-same-origin`.
      const reachable = await page.evaluate(() => {
        const f = document.querySelector(
          "#app-zone iframe",
        ) as HTMLIFrameElement;
        try {
          return f.contentDocument !== null;
        } catch {
          return false;
        }
      });
      check(!reachable, "the app frame's document was reachable from the page");

      // Wait for the app to have actually painted before measuring: the
      // claim is that a MOUNTED app does not move the strip.
      await page.frameLocator("#app-zone iframe").locator("input").first()
        .waitFor({ timeout: 30_000 });

      const after = await strip.boundingBox();
      eq(after, before, "#visor-strip geometry moved when the app mounted");

      const plated = await strip.locator("q").first().textContent();
      eq(plated, "TodoMVC", "the strip's context should plate the app title");
    },
  },

  {
    name: "todo-roundtrip",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await launchTodoMvc(page);
      const app = page.frameLocator("#app-zone iframe");

      const input = app.locator("input.new-todo, input").first();
      await input.waitFor({ timeout: 30_000 });
      await input.fill("write the gate");
      await input.press("Enter");

      const item = app.getByText("write the gate").first();
      await item.waitFor({ timeout: 15_000 });

      const toggle = app.locator("li input[type=checkbox]").first();
      await toggle.click();
      await app.locator("li.completed").first().waitFor({ timeout: 15_000 });

      // ONE tab, on purpose. M1 kept a second page open so the SharedWorker
      // would outlive the reload; M2's claim is the stronger one
      // (docs/design.md "Devices"): "the worker respawns on every single-tab
      // reload — checkpoint + rehydrate, not worker-memory luck". A second
      // tab here would hide exactly the failure this scenario is for.
      await page.reload();
      await visorReady(page);
      await launchTodoMvc(page);
      const again = page.frameLocator("#app-zone iframe");
      await again.getByText("write the gate").first().waitFor({
        timeout: 30_000,
      });
      await again.locator("li.completed").first().waitFor({ timeout: 15_000 });
    },
  },

  {
    name: "frame-violation-ends-session",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const before = await strip(page).boundingBox();

      // `apps/hostile` renders one `<script>`, which web/policy.ts's tag
      // table refuses. The rejection closes the mutation stream, the frame
      // reports it, and the glue tears the frame down and calls `apps.abort`
      // — which is what puts `session-ended` in the strip.
      await launchApp(page, "Hostile fixture", false);

      await page.waitForFunction(
        () => document.querySelector("#app-zone iframe") === null,
        undefined,
        { timeout: 5_000 },
      );

      // Settle before measuring, and settle on facts rather than on a
      // timeout: the strip's claim is about where it ends up, and launching
      // went through the Apps drawer, which is part of the visor's own tree
      // and legitimately moves the strip while it is open. Comparing a
      // drawer-open frame against a drawer-closed baseline would fail for a
      // reason that has nothing to do with the app.
      const context = page.locator("#visor-context");
      await context.getByText("ended", { exact: false }).waitFor({
        timeout: 10_000,
      });
      await drawer(page).waitFor({ state: "detached", timeout: 10_000 });

      // The trusted pixels do not move because an app misbehaved.
      const after = await strip(page).boundingBox();
      check(after !== null, "#visor-strip lost its box");
      eq(after!.height, 56, "#visor-strip height");
      eq(after, before, "#visor-strip geometry moved when the session ended");

      // Framework voice for the reason, the app's own title plated: the
      // publisher's text never enters the sentence unquoted.
      eq(
        await context.locator("q").first().textContent(),
        "Hostile fixture",
        "the strip should plate the ended app's title",
      );
    },
  },

  {
    name: "keep-open-survives-reload",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);

      await setDeviceName(page, "the workbench");
      await keepDevice(page, "laptop");

      await page.reload();
      await visorReady(page);

      // Rests open: no ceremony at all on the next boot, and the name the
      // user set before keeping is still the device's. The text wait comes
      // first on purpose — the strip paints before `device.status` answers,
      // so asserting `claimed` on the bare strip would only observe the
      // waking state.
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      check(
        await sheet(page, "is sealed").count() === 0,
        "a rests-open device asked to be unsealed",
      );
      check(await claimed(page), "the strip did not paint an identity");
    },
  },

  {
    name: "keep-passphrase-unseal",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await setDeviceName(page, "the workbench");
      await keepDevice(page, "study", "correct horse");

      await page.reload();
      await visorReady(page);

      // The sealed boot's own ceremony is the proof that `device.status`
      // answered; only then does "nothing personal is painted" mean
      // anything (internal.wit `interface device`). `claimed` fails loudly
      // if the hue were painted anyway.
      const unseal = sheet(page, "is sealed");
      await unseal.waitFor({ timeout: 15_000 });
      check(!await claimed(page), "a sealed boot painted an identity");

      const field = unseal.locator("input[type=password]");
      const press = unseal.getByRole("button", { name: "Unseal", exact: true });

      await field.fill("horse correct");
      await press.click();
      await unseal.locator(".sheet-error").waitFor({ timeout: 10_000 });
      check(!await claimed(page), "a refused unseal painted an identity");

      await field.fill("correct horse");
      await press.click();
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      check(await claimed(page), "the opened seal painted no identity");
    },
  },

  {
    name: "erase",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const erased = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        ANCHOR,
      );
      check(erased !== null, "the tab has no device anchor to erase");
      await keepDevice(page, "laptop");

      // Two presses: the first only arms it (visor/src/ui.rs `EraseControl`).
      await drawer(page).getByRole("button", { name: "Erase this device" })
        .click();
      await drawer(page).getByRole("button", { name: /^Erase —/ }).click();

      // `erase` ends with `shell.switch-device(none)`: the anchor is dropped
      // and the page reloads onto a device that has never existed. Wait for
      // the anchor to CHANGE, not to be null — the null window is one
      // navigation wide, and the next boot mints its replacement at once.
      await page.waitForFunction(
        ([key, gone]) => {
          const now = sessionStorage.getItem(key);
          return now !== null && now !== gone;
        },
        [ANCHOR, erased] as const,
        { timeout: 15_000 },
      );
      await visorReady(page);
      await strip(page).getByText("this device").waitFor({ timeout: 15_000 });

      await openTenant(page, "Settings");
      await drawer(page).getByRole("button", { name: "Other devices" }).click();
      const rows = drawer(page).locator(".device-row");
      await drawer(page).getByRole("button", { name: "Start fresh here" })
        .waitFor({ timeout: 10_000 });
      eq(
        await rows.filter({ hasText: "laptop" }).count(),
        0,
        "the erased device is still in the index",
      );
    },
  },

  {
    name: "two-devices-entry",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await setDeviceName(page, "the workbench");
      await keepDevice(page, "laptop");

      // Dropping the anchor is exactly what `shell.switch-device(none)`
      // does; doing it here rather than through a button keeps this
      // scenario to what the WIT guarantees, so it does not depend on which
      // control the visor happens to offer for a second device.
      await page.evaluate((key) => sessionStorage.removeItem(key), ANCHOR);
      await page.reload();
      await visorReady(page);

      // A brand-new device on an origin that already holds a kept one gets
      // the picker without asking: far more likely a lost anchor than a
      // deliberate second device (visor/src/state.rs `boot_drawer`).
      const row = drawer(page).locator(".device-row").filter({
        hasText: "laptop",
      }).first();
      await row.waitFor({ timeout: 15_000 });

      await row.getByRole("button", { name: "Continue", exact: true }).click();
      await page.waitForFunction(
        (key) => sessionStorage.getItem(key) !== null,
        ANCHOR,
        { timeout: 15_000 },
      );
      await visorReady(page);
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      check(await claimed(page), "the device switched back unpainted");
    },
  },

  {
    name: "frame-network-dead",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      const fromFrame: string[] = [];
      page.on("request", (req) => {
        if (req.frame() !== page.mainFrame()) fromFrame.push(req.url());
      });
      await visorReady(page);
      await launchTodoMvc(page);
      await page.frameLocator("#app-zone iframe").locator("input").first()
        .waitFor({ timeout: 30_000 });
      // The app emits no `<link>` in M1 (apps/todomvc/src/lib.rs's CONTRACT
      // note), and the frame's CSP has no connect-src at all: there is
      // nothing the frame could fetch even if it named something.
      check(
        fromFrame.length === 0,
        `the app frame made ${fromFrame.length} request(s): ${
          fromFrame.join(", ")
        }`,
      );
    },
  },

  {
    name: "instantiates-without-jspi",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      // The strip paints before the worker answers, and M2's boot is slower
      // than M1's (OPFS preopen, checkpoint read) — so wait for the mark
      // rather than sampling it the instant the first pixel lands.
      await page.waitForFunction(
        () =>
          ((globalThis as Record<string, unknown>).__polyvisor as {
            workerBooted: boolean;
          }).workerBooted,
        undefined,
        { timeout: 30_000 },
      );
      // Both realms on this side instantiated, and both `instantiate` calls
      // passed `{ jspi: false }` (web/jspi_test.ts pins that at the source
      // level). Under that option polyengine refuses a sync-typed import
      // that returns a Promise, so the visor having rendered its strip and
      // the worker having answered `booted` — which needs the runtime
      // component's exports — proves no import took a suspending path.
      const marks = await page.evaluate(() =>
        (globalThis as Record<string, unknown>).__polyvisor
      );
      eq(marks, { workerBooted: true }, "__polyvisor");
      check(
        await page.locator("#visor-strip").count() === 1,
        "#visor-strip did not render",
      );
    },
  },
];

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await Deno.stat(join(DIST, "index.html"));
  } catch {
    console.error("e2e: web/dist is not built — run `just site` first");
    Deno.exit(1);
  }

  const server = serve();
  console.log(`e2e: serving web/dist at ${server.origin}`);
  let browser: Browser | undefined;
  let failures = 0;
  try {
    browser = await chromium.launch();
    for (const scenario of scenarios) {
      // A fresh context per scenario: a device is per browser context, so
      // scenarios must not inherit each other's IndexedDB or SharedWorker.
      const ctx = await browser.newContext();
      const t0 = performance.now();
      try {
        await scenario.run(ctx, server.origin);
        console.log(
          `ok   ${scenario.name} (${(performance.now() - t0).toFixed(0)}ms)`,
        );
      } catch (err) {
        failures++;
        console.error(`FAIL ${scenario.name}: ${(err as Error).message}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
  if (failures > 0) {
    console.error(`e2e: ${failures} scenario(s) failed`);
    Deno.exit(1);
  }
  console.log(`e2e: ${scenarios.length} scenario(s) passed`);
}

await main();
