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
import { copy } from "@std/fs";
import { extname, join, normalize } from "@std/path";

const BUILT = new URL("../web/dist", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

function serve(dist: string): { origin: string; stop(): Promise<void> } {
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
    const file = join(dist, normalize(path));
    if (!file.startsWith(dist)) return new Response("no", { status: 403 });
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
// The relay
//
// Two devices in two browser contexts have no way to reach each other
// without one: `polymorph:iroh` dials through a relay over WebSocket, and
// the home origin names it in `config.json`. This harness runs its own — a
// local `iroh-relay --dev` — so the gate never depends on the public n0
// relays being up, or on this machine having any internet at all.
// ---------------------------------------------------------------------------

/** A port nothing is listening on, right now.
 *
 * `iroh-relay` takes a fixed `http_bind_addr` and has no port-0 mode, so
 * the port has to be chosen before the relay starts: bind it, read it, drop
 * it. The window between the close and the relay's bind is a race, and a
 * lost one shows up as the relay failing to start rather than as a silent
 * wrong-relay probe (which is why the readiness wait below is against the
 * port we picked, not against whatever answered). */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

interface Relay {
  url: string;
  /** Kill the relay and take its config directory with it, the way
   * `stageSite`'s copy is removed: a gate that leaves temp trees behind
   * fills `/tmp` one run at a time. */
  stop(): Promise<void>;
}

async function startRelay(): Promise<Relay> {
  const port = freePort();
  const dir = await Deno.makeTempDir({ prefix: "polyvisor-relay-" });
  const config = join(dir, "relay.toml");
  await Deno.writeTextFile(
    config,
    `http_bind_addr = "127.0.0.1:${port}"\nenable_metrics = false\n`,
  );
  const child = new Deno.Command("iroh-relay", {
    args: ["--dev", "--config-path", config],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const url = `http://127.0.0.1:${port}`;
  const deadline = performance.now() + 30_000;
  for (;;) {
    try {
      // Any answer at all means the HTTP server is up; the relay's own
      // paths are the client's business, not the harness's.
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      break;
    } catch {
      if (performance.now() > deadline) {
        child.kill("SIGKILL");
        await Deno.remove(dir, { recursive: true }).catch(() => {});
        throw new Error(`iroh-relay did not answer at ${url} within 30s`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return {
    url,
    async stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; nothing owed.
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

/**
 * A copy of the built site with this run's relay in its `config.json`.
 *
 * The copy is the point: `web/dist` is what a home origin serves, and a
 * gate that edited it in place would leave a checkout whose site points at
 * a relay that stopped existing when the run ended.
 */
async function stageSite(relay: string): Promise<string> {
  const dist = await Deno.makeTempDir({ prefix: "polyvisor-dist-" });
  await copy(BUILT, dist, { overwrite: true });
  await Deno.writeTextFile(
    join(dist, "config.json"),
    JSON.stringify({ relay }),
  );
  return dist;
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
  /** `ctx` is this scenario's own fresh context — one browser context is
   * one device (separate sessionStorage, separate SharedWorker). A
   * scenario that needs a *second* device makes its own context from
   * `browser` and closes it itself. */
  run(ctx: BrowserContext, origin: string, browser: Browser): Promise<void>;
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
// Sync, as these scenarios drive it
//
// Everything here is shaped by one fact about the visor: it holds no state
// of its own and no timer exists in its world (visor/src/ui.rs), so nothing
// on screen refreshes on its own. `device.status` and `sync.peers` are read
// on every press that *opens* the Settings tenant — so toggling Settings
// shut and open again is how this harness re-reads an endpoint id or a
// peer's state. That is not a workaround for a missing feature; polling
// chrome is a thing the milestone deliberately does not have.
// ---------------------------------------------------------------------------

const syncSheet = (page: Page) => sheet(page, "Sync");

const settingsButton = (page: Page) =>
  strip(page).getByRole("button", { name: "Settings", exact: true });

/** Settings open, showing the sync section. */
async function openSettings(page: Page): Promise<void> {
  if (await syncSheet(page).count() > 0) return;
  await settingsButton(page).click();
  await syncSheet(page).waitFor({ timeout: 10_000 });
}

/** Close Settings and open it again: the press that opens it is the
 * `device.status` and `sync.peers` read, so this is the only way to see
 * either of them change. */
async function refreshSettings(page: Page): Promise<void> {
  if (await syncSheet(page).count() > 0) {
    await settingsButton(page).click();
    await drawer(page).waitFor({ state: "detached", timeout: 10_000 });
  }
  await openSettings(page);
}

/**
 * This device's endpoint id, as another device would read it off the
 * screen.
 *
 * Empty until the endpoint is bound (internal.wit
 * `device-status.endpoint-id`): the bind is spawned and lands after first
 * paint, so the sheet says "binding…" for a while. The re-read is a
 * Settings toggle, not a reload — the visor re-reads `device.status` on the
 * press that opens the tenant (visor/src/ui.rs `show_settings`), and a
 * reload would burn a fresh wasm instance per realm (~124 memories per
 * renderer) to learn one string that a second press already tells us.
 */
async function endpointId(page: Page): Promise<string> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    await openSettings(page);
    const shown = syncSheet(page).locator("#visor-endpoint-id");
    try {
      await shown.waitFor({ timeout: 3_000 });
      const id = (await shown.textContent() ?? "").trim();
      if (id.length > 0) return id;
    } catch {
      // Still "binding…"; fall through to another press.
    }
    if (performance.now() > deadline) {
      throw new Failure("this device never bound an iroh endpoint");
    }
    await refreshSettings(page);
  }
}

/** Paste a peer's endpoint id into the sync form and dial it. */
async function dial(page: Page, peer: string): Promise<void> {
  await openSettings(page);
  const sync = syncSheet(page);
  await sync.locator("input[type=text]").fill(peer);
  await sync.getByRole("button", { name: "Connect", exact: true }).click();
}

/** Wait for the peer row to say `connected`. Generous, because what it is
 * waiting for is a relay handshake — a WebSocket to the relay, a QUIC
 * handshake through it and subduction's own handshake on top — none of which
 * is fast. There is no direct path to wait for: the browser profile has no
 * UDP, and WebRTC is off in the worker (runtime/component/src/net.rs), so
 * every dial and accept stays on the relay. */
async function waitForConnectedPeer(page: Page, peer: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  let said = "no row at all";
  for (;;) {
    const row = syncSheet(page).locator(".peer-row").filter({ hasText: peer })
      .first();
    if (await row.count() > 0) {
      said = (await row.locator(".framework").first().textContent() ?? "")
        .trim();
      // "connecting" is not "connected", and the kernel's own vocabulary
      // (internal.wit `sync.peer`) is what is matched here, unparaphrased.
      if (said === "connected") return;
    }
    // A refused dial is the kernel's own message in the sync sheet, and it
    // is worth more than a 30s timeout — but only until the next refresh
    // closes the sheet and takes the message with it, which is why it is
    // read here rather than at the moment of the click.
    const refused = syncSheet(page).locator(".sheet-error");
    if (await refused.count() > 0) {
      throw new Failure(`the dial was refused: ${await refused.textContent()}`);
    }
    if (performance.now() > deadline) {
      throw new Failure(`the peer never reached "connected"; it read ${said}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
    await refreshSettings(page);
  }
}

const todoFrame = (page: Page) => page.frameLocator("#app-zone iframe");

async function addTodo(page: Page, title: string): Promise<void> {
  const input = todoFrame(page).locator("input.new-todo, input").first();
  await input.waitFor({ timeout: 30_000 });
  await input.fill(title);
  await input.press("Enter");
  await todoFrame(page).getByText(title).first().waitFor({ timeout: 15_000 });
}

/** Reload the page and put TodoMVC back on screen: a fresh mount, which is
 * a fresh `tasks.items` read. */
async function remountTodoMvc(page: Page): Promise<void> {
  await page.reload();
  await visorReady(page);
  await launchTodoMvc(page);
}

/**
 * Wait for a todo that was written on the *other* device.
 *
 * Nothing pushes into a mounted app: `polyvisor:app/tasks` is pull-only and
 * the TodoMVC guest re-reads after its own mutations and at mount
 * (apps/todomvc/src/lib.rs). So a remote change is on this device's disk
 * long before it is on this device's screen, and the only honest way to
 * observe it is to make the app read again — which is what the remount
 * between attempts does.
 */
async function waitForRemoteTodo(page: Page, title: string): Promise<void> {
  // The app re-reads `tasks.items` only on mount and after its own
  // mutations (wit/app.wit `tasks`: a change feed is the additive next
  // step), so a remote change shows up on the next mount. Remounting costs
  // a wasm instance per realm; a few seconds between attempts keeps the
  // whole wait inside a handful of them.
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      await todoFrame(page).getByText(title).first().waitFor({
        timeout: 5_000,
      });
      return;
    } catch {
      if (performance.now() > deadline) {
        throw new Failure(`"${title}" never arrived from the other device`);
      }
    }
    await page.waitForTimeout(3_000);
    await remountTodoMvc(page);
  }
}

/**
 * Two devices, dialed and converged: A holds "from A", B has dialed A and
 * holds both todos. Returns both pages and both endpoint ids; the caller
 * owns B's context.
 *
 * Two browser contexts really are two devices — separate sessionStorage, so
 * separate device anchors, so separately-named SharedWorkers and separate
 * OPFS — and the two endpoint ids differing is the assertion that says so.
 */
async function converge(
  ctxA: BrowserContext,
  ctxB: BrowserContext,
  origin: string,
): Promise<{ a: Page; b: Page; idA: string; idB: string }> {
  const a = await open(ctxA, origin);
  await visorReady(a);
  await launchTodoMvc(a);
  await addTodo(a, "from A");
  const idA = await endpointId(a);

  const b = await open(ctxB, origin);
  await visorReady(b);
  const idB = await endpointId(b);
  check(
    idA !== idB,
    "the two contexts are the same device: they share an endpoint id",
  );

  await dial(b, idA);
  await waitForConnectedPeer(b, idA);

  // B's app only re-reads after B's own mutations, so adding "from B" is
  // both the second half of the convergence claim and the thing that makes
  // A's todo appear.
  await launchTodoMvc(b);
  await addTodo(b, "from B");
  await waitForRemoteTodo(b, "from A");

  return { a, b, idA, idB };
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
    name: "two-devices-sync",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      try {
        const { a } = await converge(ctx, ctxB, origin);

        // A is not asked to do anything of its own: no mutation, no dial.
        // The claim is that the change B made arrived on A and went into
        // A's checkpoint, so A's *next boot* — a cold read off disk — has
        // it. Nothing in worker memory can be doing this work.
        await remountTodoMvc(a);
        await waitForRemoteTodo(a, "from B");
        await todoFrame(a).getByText("from A").first().waitFor({
          timeout: 15_000,
        });
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    name: "sync-merged-doc-survives-reload",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      try {
        const { b } = await converge(ctx, ctxB, origin);

        // No re-dial: what is being tested is B's checkpoint holding the
        // merged document, so convergence is state and not a live session.
        // Whether B still has a peer row afterwards is deliberately not
        // asserted — peers are not persisted, and the claim of this
        // scenario is about the todos; asserting the other thing would
        // fail for a reason it is not about.
        await b.reload();
        await visorReady(b);
        await launchTodoMvc(b);
        for (const title of ["from A", "from B"]) {
          await todoFrame(b).getByText(title).first().waitFor({
            timeout: 30_000,
          });
        }
      } finally {
        await ctxB.close();
      }
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
    // Both realms on this side, named: the visor on the main thread and the
    // runtime in the SharedWorker. The worker is the exception that makes
    // the name worth spelling out — a page can see its own realm fail, but
    // a worker that throws while instantiating does so out of sight, and
    // `workerBooted` is the only evidence on this side that it did not.
    name: "visor-and-frame-without-jspi",
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
    await Deno.stat(join(BUILT, "index.html"));
  } catch {
    console.error("e2e: web/dist is not built — run `just site` first");
    Deno.exit(1);
  }

  const relay = await startRelay();
  console.log(`e2e: relay at ${relay.url}`);
  const dist = await stageSite(relay.url);
  const server = serve(dist);
  console.log(`e2e: serving ${dist} at ${server.origin}`);
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
        await scenario.run(ctx, server.origin, browser);
        console.log(
          `ok   ${scenario.name} (${(performance.now() - t0).toFixed(0)}ms)`,
        );
      } catch (err) {
        failures++;
        console.error(`FAIL ${scenario.name}: ${(err as Error).message}`);
        // What the visor was showing when the wait gave up, per open page:
        // the M3a flakes were diagnosed from exactly this line.
        for (const page of ctx.pages()) {
          const dump = await page.evaluate(() => ({
            strip: document.querySelector("#visor-strip")?.textContent ??
              "<none>",
            drawer: document.querySelector("#visor-drawer")?.textContent ??
              "<none>",
          })).catch((e) => ({ error: String(e) }));
          console.error(`  page ${page.url()}: ${JSON.stringify(dump)}`);
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
    await relay.stop();
    await Deno.remove(dist, { recursive: true }).catch(() => {});
  }
  if (failures > 0) {
    console.error(`e2e: ${failures} scenario(s) failed`);
    Deno.exit(1);
  }
  console.log(`e2e: ${scenarios.length} scenario(s) passed`);
}

await main();
