// Real Chromium, per docs/design.md "Delivery": claims about pixels or
// realms need it, mocks don't prove them.
//
// The server sets neither COOP nor COEP: a SharedWorker needs none, and
// setting them would make this harness diverge from what a home origin
// actually serves.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { contentType } from "@std/media-types";
import { copy } from "@std/fs";
import { extname, join, normalize } from "@std/path";

import type { FakeDrive } from "./fake-drive.ts";
import { startFakeDrive } from "./fake-drive.ts";

const BUILT = new URL("../web/dist", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

/** The extra path prefix the same site is ALSO reachable under, so a
 * scenario can check that nothing the site emits is root-absolute.
 *
 * A GitHub Pages project site serves the whole deployment from
 * `/<repo>/`, where `/` is somebody else's page (docs/design.md
 * "Routing"). Mounting the identical tree twice — at `/` and here — costs
 * two lines and lets one scenario open the subpath copy and assert that
 * everything it resolves, the service worker scope included, stays under
 * it. */
const SUBPATH = "/pages-subpath/";

function serve(dist: string): { origin: string; stop(): Promise<void> } {
  const server = Deno.serve({
    port: 0, // The kernel picks; parallel checkouts must not collide.
    hostname: "127.0.0.1",
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    // The second mount of the same tree; see SUBPATH.
    if (path.startsWith(SUBPATH)) path = "/" + path.slice(SUBPATH.length);
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
async function stageSite(relay: string, drive: string): Promise<string> {
  const dist = await Deno.makeTempDir({ prefix: "polyvisor-dist-" });
  await copy(BUILT, dist, { overwrite: true });
  // `drive_api`/`drive_oauth` are optional in the contract
  // (`lifecycle.boot-config.drive-api`/`drive-oauth`: "`none` = Google's"),
  // and this is the deployment that supplies them: one fake answers both
  // the API paths and the OAuth paths, so both bases are its origin. A gate
  // that left them out would talk to Google.
  await Deno.writeTextFile(
    join(dist, "config.json"),
    JSON.stringify({ relay, drive_api: drive, drive_oauth: drive }),
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
   * `browser` and closes it itself. `drive` is the run's fake store — the
   * scenarios that use it read it as an oracle (what was actually pushed)
   * and drive its control endpoint. */
  run(
    ctx: BrowserContext,
    origin: string,
    browser: Browser,
    drive: FakeDrive,
  ): Promise<void>;
}

function selectedScenarios(all: Scenario[]): Scenario[] {
  const only = new Set(
    Deno.args
      .filter((arg) => arg.startsWith("--scenario="))
      .map((arg) => arg.slice("--scenario=".length))
      .filter((name) => name !== ""),
  );
  if (only.size === 0) return all;
  const picked = all.filter((scenario) => only.has(scenario.name));
  const missing = [...only].filter((name) => !all.some((scenario) => scenario.name === name));
  if (missing.length > 0) {
    throw new Failure(`unknown scenario(s): ${missing.join(", ")}`);
  }
  return picked;
}

async function withScenarioTimeout<T>(
  name: string,
  ms: number,
  run: Promise<T>,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Failure(`${name} exceeded ${ms}ms`));
        }, ms) as unknown as number;
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withTimeout<T>(ms: number, label: string, run: Promise<T>): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Failure(`${label} exceeded ${ms}ms`)), ms) as unknown as number;
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

async function currentBuildDigests(): Promise<Record<string, string>> {
  return {
    "runtime.component.wasm": await sha256File(join(BUILT, "runtime.component.wasm")),
    "visor.component.wasm": await sha256File(join(BUILT, "visor.component.wasm")),
  };
}

async function verifyServedBuild(
  origin: string,
  expected: Record<string, string>,
): Promise<void> {
  const checks = Object.entries(expected);
  for (const [name, expected] of checks) {
    const res = await fetch(`${origin}/${name}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Failure(`served build is missing ${name}: ${res.status}`);
    const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
    const got = hex(new Uint8Array(digest));
    if (got !== expected) {
      throw new Failure(`served ${name} digest mismatch: got ${got}, want ${expected}`);
    }
  }
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

/** The profile's last kept device, as `web/boot.ts` spells it. */
const LAST = "polyvisor.last-device";

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
// Every selector below is the visor's own tree (visor/src/ui.rs), kept in
// one block so a rename there is one edit here. With nothing running, the
// drawer is pinned open on the app list rather than closed, so pressing the
// half whose section is already showing does nothing.
// ---------------------------------------------------------------------------

const strip = (page: Page) => page.locator("#visor-strip");
const drawer = (page: Page) => page.locator("#visor-drawer");
const drawerBody = (page: Page) => page.locator("#visor-drawer-body");
const sidebar = (page: Page) => page.locator("#visor-sidebar");
const sidebarToggle = (page: Page) => page.locator("#visor-sidebar-toggle");
const content = (page: Page) => page.locator("#visor-content");
const visorNav = (page: Page) => page.locator("#visor-nav-visor");
const appNav = (page: Page) => page.locator("#visor-nav-app");
const contactsNav = (page: Page) => page.locator("#visor-nav-contacts");
/** The strip's left half: what is running (the app list, or the running
 * app's own sheet). */
const appsButton = (page: Page) => page.locator("#visor-app");
/** The strip's right half: who this is, and this device's settings. */
const settingsButton = (page: Page) => page.locator("#visor-self");

/** Wait for the drawer's one live content area to be present. */
async function paneSettled(page: Page): Promise<void> {
  await drawer(page).waitFor({ timeout: 10_000 });
  await content(page).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const host = document.querySelector("#visor-drawer");
    if (host === null) return false;
    return host.getAnimations({ subtree: false }).every((animation) =>
      animation.playState === "finished"
    );
  }, undefined, { timeout: 10_000 });
}

/** Press the strip's left half and wait for the pane it raises. With
 * nothing running that is the app list; with a session it is that session's
 * own sheet. */
async function openApps(page: Page): Promise<void> {
  await appsButton(page).click();
  await paneSettled(page);
}

/** Press the strip's right half: the settings sheet. */
async function openSettingsSheet(page: Page): Promise<void> {
  await settingsButton(page).click();
  await paneSettled(page);
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
 * — the claim is what the visor says afterwards.
 */
async function launchApp(
  page: Page,
  title: string,
  awaitFrame = true,
): Promise<void> {
  // With nothing running the app list is already what the drawer is
  // showing, so this press is usually a no-op — which is the point.
  await openApps(page);
  const row = drawer(page).locator(".app-row").filter({ hasText: title })
    .first();
  await row.waitFor({ timeout: 10_000 });
  await row.getByRole("button", { name: "Open", exact: true }).click();
  if (awaitFrame) {
    await page.waitForSelector("#app-zone iframe[sandbox]", {
      timeout: 30_000,
    });
    // The visor closes the drawer over the frame, and that close outlives
    // the frame's arrival — returning inside that window risks pressing a
    // drawer that is still mid-close (`inert`, taking no press). Its
    // absence is the visor's own statement that the launch is over.
    await page.waitForFunction(
      () => document.querySelector("#visor-drawer") === null,
      undefined,
      { timeout: 10_000 },
    );
  }
}

async function launchTodoMvc(page: Page): Promise<void> {
  await launchApp(page, "TodoMVC");
}

/**
 * Press `Save` in the settings sheet and wait for the draft to be clean.
 *
 * Save disappears and clean `Close` replaces it when `draft == seed`; the
 * seed only catches up once every kernel call the save made has come back
 * (visor/src/ui.rs `save_draft`) — so this is the one observable that says
 * the device, and not merely the screen, has the new value. Reloading
 * without it races the checkpoint.
 */
async function saveDraft(page: Page): Promise<void> {
  await drawer(page).getByRole("button", { name: "Save", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      return document.querySelector("#visor-actions")?.textContent?.trim() ===
        "Close";
    },
    undefined,
    { timeout: 15_000 },
  );
}

async function pageCleanDrawer(page: Page): Promise<void> {
  const revert = drawer(page).getByRole("button", { name: "Revert", exact: true });
  if (await revert.count() > 0) {
    await revert.click();
    await page.waitForFunction(() =>
      document.querySelector("#visor-actions")?.textContent?.trim() === "Close"
    );
  }
  const close = drawer(page).getByRole("button", { name: "Close", exact: true });
  if (await close.count() > 0) {
    await close.click();
    await page.waitForFunction(() => document.querySelector("#visor-drawer") === null);
  }
}

async function waitForPageText(page: Page, text: string, ms = 30_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if ((await page.locator("#visor-root").textContent())?.includes(text)) return;
    await page.waitForTimeout(100);
  }
  throw new Failure(`never saw ${text}`);
}

async function waitForSidebarState(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction(
    (wantOpen) => {
      const body = document.querySelector("#visor-drawer-body");
      if (body === null) return false;
      if (body.classList.contains("open") !== wantOpen) return false;
      return document.getAnimations().every((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return !(target instanceof Element) || !body.contains(target) ||
          animation.playState === "finished";
      });
    },
    open,
    { timeout: 10_000 },
  );
}

function activeElementVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const box = active.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 &&
      box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  });
}

const contactsSheet = (page: Page) => content(page).locator(".contacts-sheet");

function contactsTool(page: Page, name: string) {
  return contactsSheet(page).locator(".contacts-nav").getByRole("button", {
    name,
    exact: true,
  });
}

async function openContactsSection(page: Page): Promise<void> {
  await paneSettled(page);
  const mobile = await page.evaluate(() => matchMedia("(max-width: 560px)").matches);
  if (mobile && await sidebarToggle(page).isVisible() &&
    await sidebarToggle(page).getAttribute("aria-expanded") !== "true") {
    await sidebarToggle(page).click();
    await waitForSidebarState(page, true);
  }
  await contactsNav(page).click();
  await page.waitForFunction(
    () => document.querySelector("#visor-content")?.getAttribute("aria-label") === "contacts",
    undefined,
    { timeout: 10_000 },
  );
  await contactsSheet(page).waitFor({ timeout: 10_000 });
}

async function openContactsView(
  page: Page,
  name: string,
  selector: string,
): Promise<void> {
  await openContactsSection(page);
  await contactsTool(page, name).click();
  await contactsSheet(page).locator(selector).waitFor({ timeout: 10_000 });
}

async function addProfileClaim(
  page: Page,
  name: string,
  value: string,
): Promise<void> {
  await openContactsView(page, "My profile", ".contacts-profile");
  const profile = contactsSheet(page).locator(".contacts-profile");
  await profile.locator("label").filter({ hasText: "Claim name" }).locator("input")
    .fill(name);
  await profile.locator("label").filter({ hasText: "Claim value" }).locator("input")
    .fill(value);
  await profile.getByRole("button", { name: "Add to draft", exact: true })
    .click();
  await profile.locator(".profile-draft-claim").getByText(value, { exact: true })
    .waitFor({ timeout: 10_000 });
  await profile.getByRole("button", { name: "Save complete profile", exact: true })
    .click();
  await profile.locator("[data-profile-variant]").getByText(value, { exact: true })
    .waitFor({ timeout: 10_000 });
}

async function expectRootCustody(page: Page, hasRoot: boolean): Promise<void> {
  await openContactsView(page, "My profile", ".contacts-profile");
  const status = contactsSheet(page).locator("#root-custody-status");
  await status.waitFor({ timeout: 15_000 });
  eq(
    (await status.textContent())?.trim(),
    hasRoot
      ? "This device holds the user root."
      : "This device does not hold the user root.",
    "root custody status",
  );
  eq(
    await contactsSheet(page).locator("#profile-root-required").count(),
    hasRoot ? 0 : 1,
    "official profile edit notice did not match root custody",
  );
  const profile = contactsSheet(page).locator(".contacts-profile");
  await profile.locator("label").filter({ hasText: "Claim name" }).locator(
    "input",
  )
    .fill("e2e custody probe");
  await profile.locator("label").filter({ hasText: "Claim value" }).locator(
    "input",
  )
    .fill("not saved");
  eq(
    await profile.getByRole("button", {
      name: "Add to draft",
      exact: true,
    }).isDisabled(),
    !hasRoot,
    "official profile edit control did not match root custody",
  );
  eq(
    await profile.locator("#save-profile-draft").isDisabled(),
    !hasRoot,
    "complete profile save did not match root custody",
  );
  for (const remove of await profile.getByRole("button", {
    name: "Remove from draft",
    exact: true,
  }).all()) {
    eq(
      await remove.isDisabled(),
      !hasRoot,
      "draft claim removal did not match root custody",
    );
  }
  await profile.locator("label").filter({ hasText: "Claim name" }).locator("input")
    .fill("");
  await profile.locator("label").filter({ hasText: "Claim value" }).locator("input")
    .fill("");
}

async function waitForRootCustody(page: Page, hasRoot: boolean): Promise<void> {
  const wanted = hasRoot
    ? "This device holds the user root."
    : "This device does not hold the user root.";
  await openContactsView(page, "My profile", ".contacts-profile");
  await contactsSheet(page).locator("#root-custody-status").filter({ hasText: wanted }).waitFor({ timeout: 60_000 });
  await expectRootCustody(page, hasRoot);
}

async function waitForOfficialValue(page: Page, value: string): Promise<void> {
  await openContactsView(page, "My profile", ".contacts-profile");
  await contactsSheet(page).locator("[data-profile-variant]")
    .getByText(value, { exact: true }).waitFor({ timeout: 60_000 });
}

function claimCheckbox(scope: Locator, text: string): Locator {
  return scope.locator(".claim-choices label").filter({ hasText: text }).locator(
    'input[type="checkbox"]',
  ).first();
}

function importClaimCheckbox(scope: Locator, text: string): Locator {
  return scope.locator(".import-party label").filter({ hasText: text }).locator(
    'input[type="checkbox"]:not(.import-party-include)',
  ).first();
}

function labeledInput(scope: Locator, label: string | RegExp): Locator {
  return scope.locator("label").filter({ hasText: label }).locator("input").first();
}

/**
 * Raise the running app's own sheet, from wherever the drawer is, via the
 * pane's own `Close` control rather than pressing the strip's app half from
 * another pane — that press is a no-op while a dirty draft has parked the
 * transition behind a confirmation dialog.
 */
async function toAppSheet(page: Page): Promise<void> {
  // A drawer mid-close, or one under the confirmation dialog, is `inert`
  // and takes no press.
  await page.waitForFunction(
    () => {
      const d = document.querySelector("#visor-drawer");
      return d === null || !d.hasAttribute("inert");
    },
    undefined,
    { timeout: 15_000 },
  );
  const back = drawer(page).getByRole("button", {
    name: "Close",
    exact: true,
  });
  if (await back.count() > 0) {
    await back.click();
    // `data-visor-app-inert` is the visor's own statement that the strip is
    // not to be pressed, and it outlives the closing animation
    // (visor/src/ui.rs `app_inert`).
    await page.waitForFunction(
      () =>
        document.querySelector("#visor-root")?.hasAttribute(
          "data-visor-app-inert",
        ) === false,
      undefined,
      { timeout: 10_000 },
    );
  }
  await openApps(page);
}

/**
 * The running app's own glyph (`device.meta`, `meta-scope.app`), selected and
 * SAVED — which is the value an install is allowed to paint with.
 *
 * The app sheet uses the same action bar as device settings. Save there and
 * wait for the clean Close action, which means the kernel accepted the map.
 */
async function setAppGlyph(
  page: Page,
  glyph: string,
  expected = glyph,
): Promise<void> {
  await toAppSheet(page);
  const tile = drawer(page).getByRole("button", {
    name: "Choose glyph",
    exact: true,
  });
  await tile.waitFor({ timeout: 10_000 });
  await tile.click();
  const picker = drawer(page).locator(".glyph-picker");
  const search = picker.getByRole("searchbox", {
    name: "Enter glyph or search",
  });
  await search.fill(glyph);
  await picker.getByRole("button", { name: `Use ${expected}`, exact: true })
    .click();
  await saveDraft(page);
  await page.waitForFunction(
    (want) =>
      document.querySelector('button[aria-label="Choose glyph"]')
        ?.textContent ===
        want,
    expected,
    { timeout: 15_000 },
  );
}

async function setUserPetname(page: Page, value: string): Promise<void> {
  await openSettingsSheet(page);
  await setTextDraft(page, /^your petname$/, value);
}

async function setAppPetname(page: Page, value: string): Promise<void> {
  await toAppSheet(page);
  await setTextDraft(page, /^petname$/, value);
}

async function setTextDraft(page: Page, label: RegExp, value: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const input = drawer(page).locator("label").filter({ hasText: label }).locator("input");
    await input.fill(value);
    const save = drawer(page).getByRole("button", { name: "Save", exact: true });
    try {
      await save.click({ timeout: 2_000 });
      await page.waitForFunction(() => document.querySelector("#visor-actions")?.textContent?.trim() === "Close", undefined, { timeout: 15_000 });
      return;
    } catch {
      if (performance.now() > deadline) throw new Failure(`could not save ${value}`);
    }
  }
}

async function waitForInputToDiffer(input: Locator, previous: string): Promise<string> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const value = await input.inputValue();
    if (value !== previous) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Failure(`input stayed ${JSON.stringify(previous)}`);
}

/** Press "Install as app" and read back the manifest.
 *
 * Waits for the link's href to CHANGE: a second install starts with the
 * first one's link in the document, so "a link is present" would read the
 * previous manifest back while this install is still painting. */
async function installAndReadManifest(
  page: Page,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  await toAppSheet(page);
  const before = await page.evaluate(() =>
    document.querySelector<HTMLLinkElement>("link[rel=manifest]")?.href ?? ""
  );
  await page.getByRole("button", { name: "Install as app" }).click();
  await page.waitForFunction(
    (was) => {
      const link = document.querySelector<HTMLLinkElement>(
        "link[rel=manifest]",
      );
      return link !== null && link.href !== was;
    },
    before,
    { timeout: 30_000 },
  );
  return await page.evaluate(async () => {
    const href =
      document.querySelector<HTMLLinkElement>("link[rel=manifest]")!.href;
    return await (await fetch(href)).json();
  });
}

/** Fetch an icon FROM THE PAGE (the only client the worker controls) and
 * decode it: `ok` and a byte length would pass on an HTML error page
 * wearing a `.png` URL. `ink` counts near-white pixels, `corner` the
 * ground. */
async function probeIcon(page: Page, src: string): Promise<{
  status: number;
  type: string | null;
  width: number;
  height: number;
  ink: number;
  corner: [number, number, number];
}> {
  return await page.evaluate(async (url) => {
    const res = await fetch(url);
    const type = res.headers.get("content-type");
    const none = [0, 0, 0] as [number, number, number];
    if (!res.ok) {
      return {
        status: res.status,
        type,
        width: 0,
        height: 0,
        ink: 0,
        corner: none,
      };
    }
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) ink++;
    }
    return {
      status: res.status,
      type,
      width: bitmap.width,
      height: bitmap.height,
      ink,
      corner: [data[0], data[1], data[2]] as [number, number, number],
    };
  }, src);
}

/** Settings → the device's user-voice petname. Typed into the draft, and
 * `Save` is the only thing the kernel hears. */
async function setDeviceName(page: Page, name: string): Promise<void> {
  await openSettingsSheet(page);
  const field = drawer(page).locator("label").filter({
    hasText: /^device petname$/,
  }).locator("input");
  await field.fill(name);
  await saveDraft(page);
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
  await openSettingsSheet(page);
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

/** Is the visor painted with an identity? One class and one inline
 * variable, both on `#visor-root`: `--hue` is emitted by the open arm alone
 * and every colour in the stylesheet is a function of it. */
async function claimed(page: Page): Promise<boolean> {
  const root = page.locator("#visor-root");
  const cls = await root.getAttribute("class") ?? "";
  const style = await root.getAttribute("style") ?? "";
  if (cls.includes("unclaimed") && style.includes("--hue")) {
    throw new Failure(
      "the visor is unclaimed and yet the anchor colour is painted — " +
        'docs/design.md "Devices" forbids exactly that',
    );
  }
  return !cls.includes("unclaimed");
}

// ---------------------------------------------------------------------------
// The keyboard, and what is out of its reach
//
// The visor moves focus through markup (visor/src/ui.rs `FocusWant`,
// web/focus.ts), so everything below asks the DOM what actually has the
// caret rather than trusting either side's account of it.
// ---------------------------------------------------------------------------

/** What has the keyboard, named the way an assertion can read. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement)) return "<none>";
    if (a.id !== "") return "#" + a.id;
    const cls = String(a.className).trim();
    return a.tagName.toLowerCase() +
      (cls === "" ? "" : "." + cls.split(/\s+/)[0]);
  });
}

/** Is the caret inside `selector`? */
function focusIn(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const a = document.activeElement;
    return host !== null && a !== null && host.contains(a);
  }, selector);
}

/** `inert` is a presence attribute: `inert="false"` is still inert, so this
 * asks whether it is THERE rather than what it says (visor/src/ui.rs
 * `flag`). */
function inert(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.hasAttribute("inert") ?? false,
    selector,
  );
}

/** Press Tab `times` and report every place the caret landed. */
async function tabTour(page: Page, times: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Tab");
    seen.push(await focused(page));
    if (await focusIn(page, "#app-zone")) seen.push("!app-zone");
  }
  return seen;
}

/** Measured WCAG contrast for every visible text leaf at one hue. Chromium
 * does the oklch parsing, gamut mapping, and translucent compositing. */
function inkContrast(
  page: Page,
  hue: number | "unclaimed",
): Promise<Record<string, number>> {
  return page.evaluate((h) => {
    const root = document.querySelector("#visor-root") as HTMLElement;
    if (h === "unclaimed") root.classList.add("unclaimed");
    else {
      root.classList.remove("unclaimed");
      root.style.setProperty("--hue", String(h));
    }
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    const px = (css: string): number[] => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#000";
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (fg: number[], bg: number[]): number[] =>
      [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const lum = (c: number[]): number => {
      const [r, gg, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    };
    const behind = (el: Element): number[] => {
      const chain: Element[] = [];
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        chain.push(n);
      }
      let acc = [255, 255, 255];
      for (const n of chain.reverse()) {
        acc = over(px(getComputedStyle(n).backgroundColor), acc);
      }
      return acc;
    };
    const out: Record<string, number> = {};
    for (
      const el of document.querySelectorAll(
        "#visor-root span, #visor-root q, #visor-root button, #visor-root div",
      )
    ) {
      const text = (el.textContent ?? "").trim();
      if (text === "" || el.querySelector("*") !== null) continue;
      if (el.closest("[inert]") !== null || el.getClientRects().length === 0) {
        continue;
      }
      const style = getComputedStyle(el);
      if (style.visibility === "hidden") continue;
      const bg = behind(el);
      const fg = over(px(style.color), bg);
      const hi = Math.max(lum(fg), lum(bg)) + 0.05;
      const lo = Math.min(lum(fg), lum(bg)) + 0.05;
      const cls = String(el.className).trim() || "-";
      out[`${el.tagName.toLowerCase()}.${cls} "${text.slice(0, 24)}"`] = hi /
        lo;
    }
    return out;
  }, hue);
}

/** Every active control below the retained 44px accessibility floor. */
function undersizedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (
      const el of document.querySelectorAll<HTMLElement>(
        "#visor-root button, #visor-root input",
      )
    ) {
      if (el.closest("[inert]") !== null) continue;
      const box = el.getBoundingClientRect();
      if (box.height === 0) continue;
      const what = el.tagName === "INPUT"
        ? `input[${(el as HTMLInputElement).type}]`
        : `"${(el.textContent ?? "").trim().slice(0, 20)}"`;
      if (box.height < 44 || box.width < 44) {
        bad.push(`${what} is ${box.width.toFixed(0)}×${box.height.toFixed(0)}`);
      }
    }
    return bad;
  });
}

/** Is every long machine identifier wholly reachable? Wrapping and local
 * scrolling are both fine; what is not is content the user cannot get to —
 * clipped, or scrollable but not to its end. A sideways-scrolling id must
 * also take focus, since a keyboard has no other way to scroll it (Chromium
 * focuses overflowing scroll containers without a `tabindex`). */
function unreadableIdentifiers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (
      const el of document.querySelectorAll<HTMLElement>(
        "#visor-root .endpoint-id",
      )
    ) {
      const where = `${el.id || "a member/peer id"}`;
      if (el.scrollHeight > el.clientHeight + 1) {
        bad.push(`${where} is clipped vertically`);
      }
      if (el.scrollWidth <= el.clientWidth) continue; // wraps; nothing to scroll
      el.scrollLeft = el.scrollWidth;
      const end = el.scrollLeft + el.clientWidth;
      if (end < el.scrollWidth - 1) {
        bad.push(`${where} cannot be scrolled to its end`);
      }
      el.scrollLeft = 0;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) {
        bad.push(`${where} takes no focus, so a keyboard cannot scroll it`);
      }
      el.blur();
    }
    return bad;
  });
}

/** Two boxes that share pixels. What "the member id overlaps the status"
 * looked like: a nowrap id that would not shrink, laid over the text
 * beside it. */
function overlappingRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (
      const row of document.querySelectorAll(
        "#visor-root .member-row, #visor-root .peer-row, " +
          "#visor-root .device-row, #visor-root .app-row, #visor-root .sync-self",
      )
    ) {
      const kids = [...row.children].map((k) => ({
        text: (k.textContent ?? "").trim().slice(0, 16),
        box: k.getBoundingClientRect(),
      })).filter((k) => k.box.width > 0 && k.box.height > 0);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].box, b = kids[j].box;
          if (
            a.left < b.right - 0.5 && b.left < a.right - 0.5 &&
            a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
          ) {
            bad.push(`"${kids[i].text}" over "${kids[j].text}"`);
          }
        }
      }
    }
    return bad;
  });
}

/** Anything the visor is drawing wider than the screen. A long identifier
 * gets its own local scroll; nothing gets the page's. An element whose
 * ancestor clips it is not overflow — the strip's two lines are `nowrap`
 * and ellipsised on purpose — so the clipping ancestor is what is measured
 * instead, and it is in this same sweep. */
function sidewaysOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) {
      bad.push(
        `the page scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`,
      );
    }
    const body = document.querySelector<HTMLElement>("#visor-drawer-body");
    if (body !== null && body.scrollWidth > body.clientWidth) {
      bad.push(
        `the drawer body scrolls sideways: ${body.scrollWidth} > ${body.clientWidth}`,
      );
    }
    const content = document.querySelector<HTMLElement>("#visor-content");
    if (content !== null && content.scrollWidth > content.clientWidth) {
      bad.push(
        `the content scrolls sideways: ${content.scrollWidth} > ${content.clientWidth}`,
      );
    }
    const clipped = (el: Element): boolean => {
      for (let n = el.parentElement; n !== null; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll<HTMLElement>("#visor-root *")) {
      if (el.getClientRects().length === 0 || clipped(el)) continue;
      const right = el.getBoundingClientRect().right;
      if (right > innerWidth + 0.5) {
        bad.push(
          `${el.tagName.toLowerCase()}.${el.className} reaches ${
            right.toFixed(0)
          }`,
        );
      }
    }
    return bad;
  });
}

/** Screenshots for a human, when `VISOR_SHOTS` asks for them. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = Deno.env.get("VISOR_SHOTS");
  if (dir === undefined) return;
  // Long enough for the drawer's own open/close animation, which is not
  // what `paneSettled` waits on: a shot taken mid-slide is a picture of an
  // animation rather than of a layout.
  await withTimeout(5_000, `settling screenshot ${name}`, page.waitForTimeout(400));
  await Deno.mkdir(dir, { recursive: true });
  await withTimeout(5_000, `screenshot ${name}`, page.screenshot({ path: join(dir, `${name}.png`) }));
}

async function dumpPage(page: Page): Promise<object> {
  return await withTimeout(5_000, `page dump ${page.url()}`, page.evaluate(() => ({
    strip: document.querySelector("#visor-strip")?.textContent ?? "<none>",
    drawer: document.querySelector("#visor-drawer")?.textContent ?? "<none>",
  }))).catch((e) => ({ error: String(e) }));
}

async function closeContext(ctx: BrowserContext, name: string): Promise<void> {
  await withTimeout(5_000, `close context ${name}`, ctx.close()).catch((e) => {
    console.error(`  cleanup ${name}: ${String(e)}`);
  });
}

async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (browser === undefined) return;
  await withTimeout(5_000, "close browser", browser.close()).catch((e) => {
    console.error(`  cleanup browser: ${String(e)}`);
  });
}

// ---------------------------------------------------------------------------
// Devices, as these scenarios drive it
//
// The visor has no timer and holds no state of its own: `device.status`,
// `sync.peers` and `sync.members` are read on the press that opens Settings
// and on its "Refresh" button, so that press is the only way this harness
// re-reads any of them. Pairing phases are the exception — the kernel
// pushes `events.pairing-changed`, so a phase the OTHER device caused
// reaches this screen with nothing pressed here, and the scenarios below
// wait on those without pressing Refresh to prove exactly that.
// ---------------------------------------------------------------------------

const devicesSheet = (page: Page) => sheet(page, "Devices");

/** Settings open, showing the Devices section. */
async function openSettings(page: Page): Promise<void> {
  if (await devicesSheet(page).count() > 0) return;
  await openSettingsSheet(page);
  await devicesSheet(page).waitFor({ timeout: 10_000 });
}

/** Re-read everything the Devices section shows. */
async function refreshSettings(page: Page): Promise<void> {
  await openSettings(page);
  await devicesSheet(page).getByRole("button", { name: "Refresh", exact: true })
    .click();
}

/**
 * This device's endpoint id, as another device would read it off the
 * screen.
 *
 * Empty until the endpoint is bound (internal.wit
 * `device-status.endpoint-id`): the bind is spawned and lands after first
 * paint, so the sheet says "binding…" for a while, and "Refresh" is the
 * re-read (visor/src/ui.rs `refresh_devices`).
 */
async function endpointId(page: Page): Promise<string> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    await openSettings(page);
    const shown = devicesSheet(page).locator("#visor-endpoint-id");
    try {
      await shown.waitFor({ timeout: 3_000 });
      const id = (await shown.textContent() ?? "").trim();
      if (id.length > 0) return id;
    } catch {
      // Still "binding…"; fall through to another refresh.
    }
    if (performance.now() > deadline) {
      throw new Failure("this device never bound an iroh endpoint");
    }
    await refreshSettings(page);
  }
}

/** Wait for something in the Devices section. `refresh` says how what is
 * waited for arrives: `true` for a pull-only read (`sync.members`,
 * `sync.peers`) that only a Refresh press re-reads, `false` for a pairing
 * phase, which the kernel pushes. It is required at every call site
 * because pressing Refresh on a pushed value would hide a broken event
 * path behind a poll. A pairing failure is worth more than a timeout, so
 * it ends the wait with the kernel's own words. */
async function waitInDevices(
  page: Page,
  what: string,
  ready: () => Promise<boolean>,
  { refresh, ms = 60_000 }: { refresh: boolean; ms?: number },
): Promise<void> {
  const deadline = performance.now() + ms;
  for (;;) {
    await openSettings(page);
    if (await ready()) return;
    const failed = devicesSheet(page).locator(".sheet-error");
    // An error that appears between the predicate's read and this one may
    // be the very thing the predicate is waiting for (a caller that expects
    // a failure), so ask again before treating it as the wait's abort.
    if (await failed.count() > 0 && !(await ready())) {
      throw new Failure(
        `${what}: the visor showed ${await failed.textContent()}`,
      );
    }
    if (performance.now() > deadline) throw new Failure(`never saw ${what}`);
    await new Promise((r) => setTimeout(r, 500));
    if (refresh) await refreshSettings(page);
  }
}

/** Joiner: show a pairing code. Returned exactly as displayed — in groups
 * of four — because that is what a person retypes, and the visor's own
 * `claim_code` is what has to undo the grouping. */
async function offerPairing(page: Page): Promise<string> {
  await openSettings(page);
  await devicesSheet(page)
    .getByRole("button", { name: "Pair this device with another" }).click();
  const code = devicesSheet(page).locator("#visor-pairing-code");
  await waitInDevices(
    page,
    "a pairing code",
    async () => await code.count() > 0,
    { refresh: false },
  );
  return (await code.textContent() ?? "").trim();
}

/** Adder: claim the code the other device is showing. */
async function claimPairing(page: Page, code: string): Promise<void> {
  await openSettings(page);
  const devices = devicesSheet(page);
  await devices.getByRole("button", { name: "Add a device", exact: true })
    .click();
  await devices.locator("input[type=text]").fill(code);
  await devices.getByRole("button", { name: "Claim", exact: true }).click();
}

/** The six digits this device is showing for comparison. */
async function sasDigits(page: Page): Promise<string> {
  const sas = devicesSheet(page).locator("#visor-pairing-sas");
  await waitInDevices(
    page,
    "the pairing digits",
    async () => await sas.count() > 0,
    { refresh: false },
  );
  return (await sas.textContent() ?? "").trim();
}

/** Wait for a device to appear in this one's group. */
async function waitForMember(page: Page, peer: string): Promise<void> {
  await waitInDevices(
    page,
    `${peer} in the group`,
    async () =>
      await devicesSheet(page).locator(`.member-row[data-endpoint-id="${peer}"]`)
        .count() > 0,
    { refresh: true },
  );
}

/**
 * Pair two devices: `joiner` shows a code, `adder` claims it, both compare
 * the same six digits and both confirm. The claim of the ceremony is that
 * the digits MATCH — a pair that went through with two different numbers
 * would be the failure the whole commit-and-reveal exchange exists to
 * prevent — so that is asserted rather than assumed.
 */
async function pair(adder: Page, joiner: Page): Promise<void> {
  const code = await offerPairing(joiner);
  await claimPairing(adder, code);
  const onAdder = await sasDigits(adder);
  const onJoiner = await sasDigits(joiner);
  eq(onAdder, onJoiner, "the two devices showed different pairing digits");
  for (const page of [adder, joiner]) {
    await devicesSheet(page).getByRole("button", {
      name: "Yes, pair",
      exact: true,
    })
      .click();
  }
}

/** Wait for the peer row to say `connected`. Generous, because what it is
 * waiting for is a relay handshake — a WebSocket to the relay, a QUIC
 * handshake through it and subduction's own handshake on top — none of which
 * is fast. There is no direct path to wait for: the browser profile has no
 * UDP, and WebRTC is off in the worker (runtime/component/src/net.rs), so
 * every dial and accept stays on the relay. */
async function waitForConnectedPeer(page: Page, peer: string): Promise<void> {
  const deadline = performance.now() + 60_000;
  let said = "no row at all";
  for (;;) {
    const row = devicesSheet(page).locator(".peer-row").filter({
      hasText: peer,
    })
      .first();
    if (await row.count() > 0) {
      said = (await row.locator(".framework").first().textContent() ?? "")
        .trim();
      // "connecting" is not "connected", and the kernel's own vocabulary
      // (internal.wit `sync.peer`) is what is matched here, unparaphrased.
      if (said === "connected") return;
    }
    if (performance.now() > deadline) {
      throw new Failure(`the peer never reached "connected"; it read ${said}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
    await refreshSettings(page);
  }
}

// ---------------------------------------------------------------------------
// Storage, as these scenarios drive it
//
// Settings → "Storage" is re-read the same way Devices is: on the press
// that opens it and after every act in the section.
//
// The ceremony runs headless: "Connect Google Drive" opens a popup at the
// kernel-minted URL, the fake's `/auth` 302s straight back with `code` and
// `state`, and that returning load broadcasts the pair on the ceremony's
// BroadcastChannel for `shell.open-popup` to resolve with. No consent
// screen to click.
// ---------------------------------------------------------------------------

const storageSheet = (page: Page) => sheet(page, "Storage");

/** What the kernel says about the binding, in its own words. */
async function storageState(page: Page): Promise<string> {
  await openSettings(page);
  const line = storageSheet(page).locator("#visor-storage-state");
  await line.waitFor({ timeout: 15_000 });
  return (await line.textContent() ?? "").trim();
}

/**
 * A binding that is connected AND whose last sync finished.
 *
 * The kernel's four spellings (runtime/crates/kernel/src/drive.rs `state`):
 * "not connected", "connected", "connected; the last sync did not finish:
 * <why>", "needs re-authorization: <why>". The third starts with the same
 * word as the healthy one, so matching the prefix alone would let a store
 * that connects and then fails every sync pass every one of these
 * scenarios — the exact equality below is what keeps that failure loud.
 */
function connectedCleanly(said: string): boolean {
  return said === "connected";
}

/**
 * Run the ceremony: type an (entirely synthetic) installed-app client pair,
 * press Connect, and wait for the kernel to say the binding is connected.
 *
 * The pair is synthetic and labelled — the fake gates on PKCE, not on the
 * client, and nothing real should ever be typed into it.
 */
async function connectDrive(page: Page): Promise<void> {
  await openSettings(page);
  const store = storageSheet(page);
  await store.waitFor({ timeout: 15_000 });
  const fields = store.locator("input[type=text]");
  await fields.nth(0).fill("synthetic-client-1");
  await fields.nth(1).fill("synthetic-client-secret-1");
  await store.getByRole("button", { name: "Connect Google Drive" }).click();

  const deadline = performance.now() + 60_000;
  for (;;) {
    const said = await storageState(page);
    if (connectedCleanly(said)) return;
    const failed = storageSheet(page).locator(".sheet-error");
    if (await failed.count() > 0) {
      throw new Failure(
        `connecting the store: the visor showed ${await failed.textContent()}`,
      );
    }
    if (performance.now() > deadline) {
      throw new Failure(`the store never connected; it read "${said}"`);
    }
    await new Promise((r) => setTimeout(r, 500));
    // Re-read: the ceremony completes in the kernel, and this world has no
    // timer. The press that opens Settings is the read — and the drawer is
    // not a toggle any more, so leaving it and coming back is what makes
    // that press happen again.
    await openApps(page);
    await openSettings(page);
  }
}

/** Press "Sync now". A pass already running coalesces this one into it
 * (`Kernel::sync_now`), so pressing again is always safe and never a second
 * concurrent pass. */
async function syncNow(page: Page): Promise<void> {
  await openSettings(page);
  await storageSheet(page).getByRole("button", { name: "Sync now" }).click();
}

/**
 * Wait for a todo written on ANOTHER device to arrive through the store.
 *
 * The explicit pull is needed; the mounted app's parked `tasks.watch` then
 * observes the resulting revision without a remount or local dummy action.
 */
async function pullUntilTodo(page: Page, title: string): Promise<void> {
  const deadline = performance.now() + 120_000;
  for (;;) {
    await syncNow(page);
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      await todoFrame(page).getByText(title).first().waitFor({
        timeout: 3_000,
      });
      return;
    } catch {
      if (performance.now() > deadline) {
        throw new Failure(`"${title}" never arrived through the store`);
      }
    }
  }
}

/** Press "Sync now" and wait for the fake to hold at least `want`
 * objects. The fake is the oracle: what the visor says about a push is the
 * kernel's report of it, and what was actually written is this. */
async function syncUntil(
  page: Page,
  drive: FakeDrive,
  want: number,
  what: string,
): Promise<void> {
  const deadline = performance.now() + 90_000;
  for (;;) {
    await syncNow(page);
    const settled = performance.now() + 10_000;
    while (performance.now() < settled) {
      if (drive.objects().length >= want) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (performance.now() > deadline) {
      throw new Failure(
        `${what}: the store holds ${drive.objects().length} object(s), ` +
          `wanted at least ${want}`,
      );
    }
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
 * a fresh `tasks.items` read. With the app open, the URL still carries
 * `#app/<token>` and the visor restores it on boot, so this waits for that
 * restore rather than pressing "Apps" itself and racing the visor's own
 * click; with no app open there is no fragment, and the press is the only
 * way. */
async function remountTodoMvc(page: Page): Promise<void> {
  const bookmarked = await page.evaluate(() =>
    location.hash.startsWith("#app/")
  );
  await page.reload();
  await visorReady(page);
  if (bookmarked) {
    await page.waitForSelector("#app-zone iframe[sandbox]", {
      timeout: 30_000,
    });
  } else {
    await launchTodoMvc(page);
  }
}

/**
 * Wait for a todo that was written on the *other* device.
 *
 * `tasks.watch` is a revision long-poll, so this observes the already-mounted
 * app directly. Reloading here would not prove real-time propagation.
 */
async function waitForRemoteTodo(page: Page, title: string): Promise<void> {
  await todoFrame(page).getByText(title).first().waitFor({ timeout: 60_000 });
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

  // A adds B: B shows the code, A claims it, both confirm the same six
  // digits. Enrollment is what makes the connection legal at all — sync
  // policy is group membership (internal.wit `sync`), so there is no
  // dialling a stranger any more.
  await pair(a, b);
  await waitForMember(a, idB);
  await waitForMember(b, idA);
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
    async run(ctx, origin, browser) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const box = await page.locator("#visor-strip").boundingBox();
      check(box !== null && box.height > 0, "#visor-strip has no visible box");
      // The strip says "waking" until `device.status` answers over the
      // worker port; the placeholder is the first kernel-backed pixel, and
      // it is the right half — the one that speaks for this device.
      await page.locator("#visor-self .bottom .user").waitFor({ timeout: 10_000 });
    },
  },

  {
    // docs/design.md "Windows and handles": a window a document holds a
    // handle to can be navigated cross-origin by that document, so it gets
    // no trusted pixels at all. Both holders are exercised — an opener and
    // a parent — and both from a page on the HOME origin, because what the
    // visor refuses is the handle, not the holder's origin.
    name: "handled-window-refuses-to-boot",
    async run(ctx, origin) {
      const indexUrl = origin + "/";
      const refusal = "not this visor's own";

      const host = await open(ctx, origin);
      await visorReady(host);

      // (i) OPENED. Chromium under Playwright blocks no popups, so a bare
      // `window.open` is enough; the window it hands back is exactly the
      // handle the ruling is about.
      const [opened] = await Promise.all([
        host.waitForEvent("popup"),
        host.evaluate((u: string) => {
          globalThis.open(u);
        }, indexUrl),
      ]);
      await opened.locator("#visor-reopen").waitFor({ timeout: 20_000 });
      check(
        (await opened.locator("#visor").textContent() ?? "").includes(refusal),
        "the opened window did not paint the framework's refusal",
      );
      // Give the boot every chance to happen anyway before claiming it did
      // not: the claim is that no strip and no worker ever appear, and a
      // check made at once would pass against a visor still starting.
      await opened.waitForTimeout(3_000);
      eq(
        await opened.locator("#visor-strip").count(),
        0,
        "the opened window painted trusted pixels",
      );
      // `__polyvisor` is not even installed in a refusing window — the
      // tripwire parks above the line that installs it — so "no worker" is
      // read as "nothing said a worker booted".
      eq(
        await opened.evaluate(() =>
          ((globalThis as Record<string, unknown>).__polyvisor as
            | { workerBooted?: boolean }
            | undefined)?.workerBooted ?? false
        ),
        false,
        "the refusing window booted a worker",
      );

      // The way out: a fresh browsing context nobody holds a handle to.
      // Awaited on the CONTEXT rather than as the clicking page's `popup`,
      // because `noopener` is precisely the case where the new window is
      // not related to the one that asked for it.
      const [reopened] = await Promise.all([
        ctx.waitForEvent("page"),
        opened.locator("#visor-reopen").click(),
      ]);
      await visorReady(reopened);
      check(
        await reopened.locator("#visor-strip").count() === 1,
        "the reopened window did not boot the visor",
      );
      eq(
        await reopened.evaluate(() => globalThis.opener === null),
        true,
        "the reopened window still has an opener",
      );

      // (ii) FRAMED, on the same origin as the frame's own document.
      await host.setContent(
        `<iframe id="framed" src="${indexUrl}" width="800" height="600"></iframe>`,
      );
      const framed = host.frameLocator("#framed");
      await framed.locator("#visor-reopen").waitFor({ timeout: 20_000 });
      check(
        (await framed.locator("#visor").textContent() ?? "").includes(refusal),
        "the framed visor did not paint the framework's refusal",
      );
      await host.waitForTimeout(3_000);
      eq(
        await framed.locator("#visor-strip").count(),
        0,
        "the framed visor painted trusted pixels",
      );
    },
  },

  {
    name: "open-app",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const strip = page.locator("#visor-strip");

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

      // Wait for the app to have actually painted before measuring.
      await page.frameLocator("#app-zone iframe").locator("input").first()
        .waitFor({ timeout: 30_000 });

      const plated = await strip.locator("q").first().textContent();
      eq(plated, "TodoMVC", "the strip's left half should plate the app title");
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

      // ONE tab, on purpose: a second tab would keep the SharedWorker alive
      // across the reload, hiding a claim this scenario exists to check —
      // that the todo survives from checkpoint + rehydrate, not from
      // worker memory.
      await page.reload();
      await visorReady(page);
      await page.waitForSelector("#app-zone iframe[sandbox]", {
        timeout: 30_000,
      });
      const again = page.frameLocator("#app-zone iframe");
      await again.getByText("write the gate").first().waitFor({
        timeout: 30_000,
      });
      await again.locator("li.completed").first().waitFor({ timeout: 15_000 });
    },
  },

  {
    // "This app, here" (docs/design.md "Routing"): the URL bar names a
    // running session and the app's own route inside it, so a bookmark of
    // it reopens the same app at the same filter — on this device only,
    // because the token is sealed under a key only this user's devices
    // hold (wit/app.wit `route`, internal.wit `apps.route-encode`).
    name: "bookmark-round-trip",
    async run(ctx, origin, browser) {
      const page = await open(ctx, origin);
      await visorReady(page);
      // Kept first, since every reload below needs the same route key.
      await keepDevice(page, "the workbench");
      await launchTodoMvc(page);
      // The footer's filter links only render with at least one todo
      // (apps/todomvc/src/lib.rs), and that todo persists on this device,
      // so one add here also covers the reopened app in step (c) below.
      await addTodo(page, "bookmark this filter");

      const h0 = await page.evaluate(() => location.hash);
      check(
        /^#app\/[A-Za-z0-9_-]+$/.test(h0),
        `a plain launch did not write a bookmarkable fragment: ${h0}`,
      );

      const filters = todoFrame(page).locator("ul.filters a");
      const active = filters.filter({ hasText: "Active" });
      const all = filters.filter({ hasText: "All" });

      await active.click();
      await page.waitForFunction(
        (want) => location.hash !== want,
        h0,
        { timeout: 10_000 },
      );
      const h1 = await page.evaluate(() => location.hash);
      check(h1 !== h0, "the Active filter did not change the fragment");

      // Deterministic encryption: the same (install, route) pair seals to
      // the same token every time, so returning to "All" returns the URL
      // to exactly H0 rather than to some other equally-valid encoding of
      // the same plain launch.
      await all.click();
      await page.waitForFunction(
        (want) => location.hash === want,
        h0,
        { timeout: 10_000 },
      );
      await active.click();
      await page.waitForFunction(
        (want) => location.hash === want,
        h1,
        { timeout: 10_000 },
      );

      // Reopening H1 with no click at all: the visor decodes the fragment
      // on boot, launches the app at the route it names, and the app
      // starts already filtered — proving the route travelled through the
      // URL and not through anything client-side kept warm.
      await page.goto(origin + "/" + h1);
      await page.reload();
      await visorReady(page);
      await page.waitForSelector("#app-zone iframe[sandbox]", {
        timeout: 30_000,
      });
      eq(
        await page.evaluate(() => location.hash),
        h1,
        "reopening a bookmark changed the fragment",
      );
      const reopenedFilters = todoFrame(page).locator("ul.filters a");
      await reopenedFilters.filter({ hasText: "Active" }).evaluate((el) =>
        el.className
      ).then((cls) =>
        check(
          cls.includes("selected"),
          `the reopened app was not filtered to Active: class="${cls}"`,
        )
      );

      // Closing the session (not navigation) also clears the bar — the one
      // case the notice-only checks below don't cover.
      await page.locator("#visor-app").click();
      await paneSettled(page);
      await drawer(page).getByRole("button", { name: "Close app", exact: true })
        .click();
      await page.waitForFunction(
        () => location.hash === "",
        undefined,
        { timeout: 10_000 },
      );

      // A fragment this device's route key never sealed: the visor says so
      // rather than opening anything. The reload is what makes this a
      // bookmark being opened rather than a same-document hash edit, which
      // the visor ignores by ruling (docs/design.md "Routing").
      await page.goto(origin + "/#app/not-a-real-token");
      await page.reload();
      await visorReady(page);
      await page.waitForTimeout(2_000);
      eq(
        await page.locator("#app-zone iframe").count(),
        0,
        "a bogus fragment opened a frame anyway",
      );
      await drawer(page).getByText(/link/i).waitFor({
        timeout: 10_000,
      });

      // A second device — fresh context, fresh route key — cannot open
      // H1 either: the token decrypts only under the key of the device
      // (or its group) that sealed it, and this one has never paired.
      const ctxB = await browser.newContext();
      try {
        const b = await ctxB.newPage();
        await b.goto(origin + "/" + h1);
        await visorReady(b);
        await b.waitForTimeout(2_000);
        eq(
          await b.locator("#app-zone iframe").count(),
          0,
          "another device's route key opened this bookmark",
        );
        await drawer(b).getByText(/link/i).waitFor({
          timeout: 10_000,
        });
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    // A bookmark opened in a genuinely fresh tab: Chromium only copies
    // sessionStorage on duplicate/`window.open`, not on a plain navigation,
    // so this tab has no device anchor of its own and must adopt the
    // profile's kept device to decrypt the token at all.
    name: "bookmark-in-a-new-tab",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await keepDevice(page, "the workbench");
      await launchTodoMvc(page);
      // `route.set` is debounced (docs/design.md "Routing"), so the
      // fragment is not necessarily there the instant the frame opens.
      await page.waitForFunction(() => location.hash !== "", undefined, {
        timeout: 10_000,
      });
      const h = await page.evaluate(() => location.hash);

      // `ctx.newPage()`, not a second window off `page`: a genuinely new
      // tab shares the profile's localStorage but starts with an empty
      // sessionStorage of its own — nothing here copies the anchor.
      const tab = await ctx.newPage();
      await tab.goto(origin + "/" + h);
      await visorReady(tab);
      await tab.waitForSelector("#app-zone iframe[sandbox]", {
        timeout: 30_000,
      });
      eq(
        await tab.evaluate(() => location.hash),
        h,
        "the adopted-device tab did not open at the bookmarked fragment",
      );
    },
  },

  {
    // The other route kind (docs/design.md "Routing", the `launch/` bullet):
    // plaintext, keyless, resolved by `route-decode` to this user's install
    // of the package. Opening the fragment cold — no click, the visor
    // decodes it itself at boot (visor/src/ui.rs) — is the whole point: a
    // launcher replays `start_url` unattended.
    name: "launch-fragment-opens-app",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await keepDevice(page, "the workbench");

      const tab = await ctx.newPage();
      await tab.goto(origin + "/#launch/todomvc");
      await visorReady(tab);
      await tab.waitForSelector("#app-zone iframe[sandbox]", {
        timeout: 30_000,
      });
      // Once the frame is up the bar switches to `app/` (docs/design.md:
      // "Once the frame is up the bar switches to `app/` as for any
      // launch"), same mechanism as any other open (`encodeFragment` in
      // web/boot.ts).
      await tab.waitForFunction(
        () => /^#app\//.test(location.hash),
        undefined,
        { timeout: 10_000 },
      );

      // A bogus package: `unknown-app`, in a fresh tab so nothing from the
      // first device's session lingers.
      const bad = await ctx.newPage();
      await bad.goto(origin + "/#launch/nope");
      await visorReady(bad);
      await bad.waitForTimeout(2_000);
      check(
        await bad.locator("#app-zone iframe").count() === 0,
        "a bogus launch/ fragment must not open a frame",
      );
      const notice = bad.locator("#visor-notice");
      await notice.getByText(/installed/i).waitFor({ timeout: 10_000 });
    },
  },

  {
    // Playwright cannot complete an OS install, so this asserts what the
    // glue does control: the manifest `shell.install-app` mints and the
    // icons it paints, stores and serves (docs/design.md "Routing", which
    // also records what a green run here does NOT say about Android).
    name: "install-app-manifest",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await keepDevice(page, "the workbench");
      await launchTodoMvc(page);

      const base = await page.evaluate(() => new URL(".", location.href).href);

      // Baseline: no saved glyph, so the static icons — real files, no
      // service worker involved.
      const plain = await installAndReadManifest(page);
      check(
        Array.isArray(plain.icons) && plain.icons.length === 2 &&
          plain.icons.every((i: { src: string }) =>
            i.src === base + "icon-512.png" || i.src === base + "icon-192.png"
          ),
        "an install with no saved glyph must fall back to the static icons",
      );
      for (const icon of plain.icons as { src: string }[]) {
        // `page.request` never goes through a service worker: the network
        // is what answers here.
        const res = await page.request.get(icon.src);
        check(res.ok(), `static icon ${icon.src} is not served`);
      }

      // The reusable picker is also the app glyph control. Its selection is
      // only a draft: installing before Save must still use static icons,
      // and Revert must clear it.
      await toAppSheet(page);
      const appGlyph = drawer(page).getByRole("button", {
        name: "Choose glyph",
        exact: true,
      });
      await appGlyph.click();
      const appPicker = drawer(page).locator(".glyph-picker");
      await appPicker.getByRole("searchbox", {
        name: "Enter glyph or search",
      }).fill(
        "rocket",
      );
      await appPicker.getByRole("button", { name: "rocket", exact: true })
        .click();
      eq(
        await appGlyph.textContent(),
        "🚀",
        "app picker chose the wrong glyph",
      );
      check(
        (await drawer(page).locator("#visor-actions").textContent())?.includes(
          "Save",
        ),
        "an app picker choice did not remain an unsaved draft",
      );
      await drawer(page).getByRole("button", { name: "Revert", exact: true })
        .click();
      eq(await appGlyph.textContent(), "", "Revert kept an app picker choice");

      // A combining sequence and not an emoji: a colour emoji font ignores
      // the white fill the pixel checks below look for. Rust keeps the whole
      // grapheme and drops the following suffix.
      const paintedGlyph = "e\u0301";
      await setAppGlyph(page, paintedGlyph + "x", paintedGlyph);

      await page.evaluate(() => {
        const proto = CanvasRenderingContext2D.prototype;
        const original = proto.fillText;
        (globalThis as Record<string, unknown>).__paintedGlyphs = [];
        proto.fillText = function (text, x, y, maxWidth) {
          ((globalThis as Record<string, unknown>).__paintedGlyphs as string[])
            .push(String(text));
          if (maxWidth === undefined) original.call(this, text, x, y);
          else original.call(this, text, x, y, maxWidth);
        };
      });
      const manifest = await installAndReadManifest(page);
      const startUrl = await page.evaluate(
        (b) => new URL("#launch/todomvc", b).href,
        base,
      );

      eq(
        manifest.start_url,
        startUrl,
        "manifest start_url must be launch/todomvc absolute against the page base",
      );
      eq(manifest.scope, base, "manifest scope must be the page base");
      check(
        typeof manifest.id === "string" &&
          manifest.id.includes("launch/todomvc"),
        "manifest id must be absolute and name launch/todomvc",
      );
      check(
        typeof manifest.name === "string" && manifest.name.includes("TodoMVC"),
        "manifest name must carry the app's title",
      );

      // The worker's now: under the page's base and named by a digest.
      const icons = manifest.icons as { src: string; sizes: string }[];
      check(
        Array.isArray(icons) && icons.length === 2 &&
          icons.every((i) =>
            new RegExp(
              "^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                "launcher-icons/[0-9a-f]{64}\\.png$",
            ).test(i.src)
          ),
        `manifest icons must be base-relative digest URLs: ${
          JSON.stringify(icons)
        }`,
      );
      eq(
        icons.map((i) => i.sizes).sort(),
        ["192x192", "512x512"],
        "the manifest must name both launcher sizes",
      );
      check(
        !icons.some((i) => i.src.includes(paintedGlyph)),
        "the glyph must not appear literally in an icon URL",
      );

      const bySize = new Map(icons.map((i) => [i.sizes, i.src]));
      // Pixel ink only proves that something rendered; this proves the
      // complete Rust-normalized grapheme crossed the TypeScript glue.
      const paintedText = await page.evaluate(() =>
        (globalThis as Record<string, unknown>).__paintedGlyphs
      ) as string[];
      check(
        paintedText.length === 2 &&
          paintedText.every((g) => g === paintedGlyph),
        `canvas received ${
          JSON.stringify(paintedText)
        }, not the whole grapheme`,
      );
      const big = await probeIcon(page, bySize.get("512x512")!);
      const small = await probeIcon(page, bySize.get("192x192")!);
      eq(
        [big.status, big.width, big.height],
        [200, 512, 512],
        "the 512 icon must be served and decode at 512x512",
      );
      eq(
        [small.status, small.width, small.height],
        [200, 192, 192],
        "the 192 icon must be served and decode at 192x192",
      );
      eq(big.type, "image/png", "the launcher icon's content type");
      // A glyph really is on it: white ink present, corner still the hue
      // ground. An all-ground image (a glyph that never rendered) and an
      // all-white one both fail here.
      check(
        big.ink > 0 && big.ink < 512 * 512,
        `the 512 icon must carry white glyph ink on a coloured ground ` +
          `(ink=${big.ink})`,
      );
      check(
        !(big.corner[0] > 235 && big.corner[1] > 235 && big.corner[2] > 235),
        `the icon's corner must be the hue ground, not ink: ${big.corner}`,
      );

      // NOT network-hosted: the same URL off the network is a 404, because
      // no such file exists in the deployment. This is what says the icon
      // came out of Cache Storage and not off disk.
      for (const icon of icons) {
        const res = await page.request.get(icon.src);
        eq(
          res.status(),
          404,
          `${icon.src} must not be served by the network — the worker is ` +
            `the only thing that answers it`,
        );
      }

      // A miss is a 404, never the app shell.
      const missing = await probeIcon(
        page,
        base + "launcher-icons/" + "0".repeat(64) + ".png",
      );
      eq(missing.status, 404, "an unknown launcher icon must be a 404");

      // Not an offline cache: an unrelated fetch from the controlled page
      // still reaches the network.
      const config = await page.evaluate(async () =>
        await (await fetch("./config.json")).json()
      );
      check(
        typeof config?.relay === "string",
        "an unrelated fetch from the controlled page must reach the network",
      );

      // A different saved glyph is a different image at a different URL —
      // also the check that the paint reads the saved map.
      await setAppGlyph(page, "▲");
      const second = await installAndReadManifest(page);
      const secondIcons = second.icons as { src: string; sizes: string }[];
      check(
        secondIcons.every((i) => !icons.some((j) => j.src === i.src)),
        "a different saved glyph must produce different icon URLs",
      );
      const repainted = await probeIcon(
        page,
        secondIcons.find((i) => i.sizes === "512x512")!.src,
      );
      eq(
        [repainted.status, repainted.width],
        [200, 512],
        "the repainted 512 icon must be served and decode",
      );
      check(
        repainted.ink !== big.ink,
        "a different glyph must paint a different amount of ink",
      );

      // The cache outlives the page, and nothing here deletes.
      await page.reload();
      await visorReady(page);
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        undefined,
        { timeout: 15_000 },
      );
      const survived = await probeIcon(page, bySize.get("512x512")!);
      eq(
        [survived.status, survived.width],
        [200, 512],
        "a launcher icon must survive a page reload",
      );

      // The Pages rule: nothing root-absolute, which on a project site
      // names somebody else's page.
      check(
        !/"\/[^/]/.test(JSON.stringify(manifest)),
        "no manifest field may start with a root-absolute /",
      );
    },
  },

  {
    // The same install on a deployment that is not at the origin root —
    // every GitHub Pages project site. Exercises what a `/`-hardcode would
    // break: scope, script URL and icon URLs all derived from the base.
    name: "install-icons-under-a-subpath",
    async run(ctx, origin) {
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error("  page error:", e.message));
      await page.goto(origin + SUBPATH);
      await visorReady(page);
      await keepDevice(page, "the workbench");
      await launchTodoMvc(page);
      await setAppGlyph(page, "★");

      const manifest = await installAndReadManifest(page);
      const base = origin + SUBPATH;
      const icons = manifest.icons as { src: string; sizes: string }[];
      check(
        icons.length === 2 &&
          icons.every((i) =>
            i.src.startsWith(base + "launcher-icons/") && i.src.endsWith(".png")
          ),
        `icons must resolve under the deployment subpath: ${
          JSON.stringify(icons)
        }`,
      );
      // The worker took the subpath as its scope, not the origin root.
      const scopes = await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
      );
      eq(scopes, [base], "the icon worker's scope must be the page's base");

      const probe = await probeIcon(
        page,
        icons.find((i) => i.sizes === "512x512")!.src,
      );
      eq(
        [probe.status, probe.width, probe.height],
        [200, 512, 512],
        "the subpath deployment's launcher icon must be served and decode",
      );
      check(probe.ink > 0, "the subpath icon must carry glyph ink");
      await page.close();
    },
  },

  {
    name: "frame-violation-ends-session",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);

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

      // Settle on facts rather than on a timeout: with nothing running the
      // drawer is pinned on the app list, so the session ending puts it
      // back there; the notice is read from it.
      const notice = page.locator("#visor-notice");
      await notice.getByText("ended", { exact: false }).waitFor({
        timeout: 10_000,
      });

      const after = await strip(page).boundingBox();
      check(after !== null && after.height > 0, "#visor-strip lost its box");

      // Framework voice for the reason, the app's own title plated: the
      // publisher's text never enters the sentence unquoted.
      eq(
        await notice.locator("q").first().textContent(),
        "Hostile fixture",
        "the notice should plate the ended app's title",
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
      eq(
        await drawer(page).locator("#visor-actions").count(),
        0,
        "the pinned Unseal ceremony offered Close",
      );

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
      await strip(page).locator("#visor-self .bottom .user").waitFor({ timeout: 15_000 });

      await openSettingsSheet(page);
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

      // Dropping only the tab's own anchor is a lost anchor, not a new
      // device: LAST still names the device kept above, and `deviceId`
      // adopts it, so this reload is the SAME device and the picker never
      // appears.
      await page.evaluate((key) => sessionStorage.removeItem(key), ANCHOR);
      await page.reload();
      await visorReady(page);
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      eq(
        await drawer(page).locator(".device-row").count(),
        0,
        "a lost anchor with a kept LAST device showed the picker anyway",
      );

      // Now drop LAST too — an explicit new device, done directly rather
      // than through a button so this scenario depends only on what
      // `shell.switch-device(none)` guarantees.
      await page.evaluate((key) => sessionStorage.removeItem(key), ANCHOR);
      await page.evaluate((key) => localStorage.removeItem(key), LAST);
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
        const { a, b } = await converge(ctx, ctxB, origin);

        // A is not asked to do anything of its own: no mutation, no dial and
        // no reload. Its mounted app must wake from `tasks.watch`.
        await waitForRemoteTodo(a, "from B");
        await todoFrame(a).getByText("from A").first().waitFor({
          timeout: 15_000,
        });
        await pageCleanDrawer(a);
        await pageCleanDrawer(b);
        await todoFrame(a).getByText("from B").dblclick();
        const edit = todoFrame(a).locator("input.edit");
        await edit.fill("edited on A");
        await edit.press("Enter");
        await todoFrame(b).getByText("edited on A").waitFor({ timeout: 15_000 });
        await todoFrame(b).locator("li").filter({ hasText: "from A" })
          .locator("input[type=checkbox]").click();
        await todoFrame(a).locator("li.completed").filter({ hasText: "from A" })
          .waitFor({ timeout: 15_000 });
        await todoFrame(a).locator("li").filter({ hasText: "edited on A" })
          .locator("button.destroy").click();
        await todoFrame(b).getByText("edited on A").waitFor({ state: "detached", timeout: 15_000 });
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    name: "animal-glyph-font",
    async run(ctx, origin) {
      const page = await open(ctx, `${origin}${SUBPATH}`);
      await visorReady(page);
      const animals = Array.from(
        { length: 64 },
        (_, offset) => String.fromCodePoint(0x1f400 + offset),
      ).join("");
      const covered = "🎲" + animals;
      await page.evaluate(async (text) => {
        const probe = document.createElement("div");
        probe.id = "animal-font-probe";
        probe.style.cssText =
          "font:400 32px 'Polyvisor Noto Emoji';display:grid;position:fixed;" +
          "inset:0;z-index:999;background:white;align-content:center;justify-content:center;" +
          "grid-template-columns:repeat(8,40px);line-height:40px;";
        for (const glyph of text) {
          const cell = document.createElement("span");
          cell.textContent = glyph;
          probe.append(cell);
        }
        document.body.append(probe);
        await document.fonts.load("400 32px 'Polyvisor Noto Emoji'", text);
      }, covered);
      const fontResponse = await page.request.get(
        `${origin}${SUBPATH}fonts/noto-emoji-animals.woff2`,
      );
      check(fontResponse.ok(), "subpath animal fallback font was not served");
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#animal-font-probe",
      });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      const custom = fonts.filter((font) => font.isCustomFont);
      check(custom.length === 1, `expected one custom animal font, got ${JSON.stringify(fonts)}`);
      eq(custom[0].glyphCount, 65, "bundled font did not render the die and all 64 animal glyphs");
      check(
        fonts.every((font) => font.isCustomFont || font.glyphCount === 0),
        `an installed fallback rendered part of the controlled grid: ${JSON.stringify(fonts)}`,
      );
      await shot(page, "animal-font-grid");
    },
  },

  {
    name: "petname-dice-and-glyph-random",
    async run(ctx, origin, browser) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await openSettingsSheet(page);

      const field = (label: RegExp) =>
        drawer(page).locator("label").filter({ hasText: label }).locator("input");
      const user = field(/^your petname$/);
      const device = field(/^device petname$/);
      const userDie = drawer(page).getByRole("button", { name: "Re-roll user petname" });
      const deviceDie = drawer(page).getByRole("button", { name: "Re-roll device petname" });
      const glyphValue = (button: Locator) => button.locator(".glyph-tile-face").textContent();

      const assertDieGap = async (input: Locator, die: Locator, where: string) => {
        const inputBox = await input.boundingBox();
        const dieBox = await die.boundingBox();
        check(inputBox !== null && dieBox !== null, `${where} petname controls are not visible`);
        const gap = dieBox.x - (inputBox.x + inputBox.width);
        check(gap >= 0 && gap <= 12, `${where} die gap is ${gap}px, expected 0..12px`);
        console.log(`  ${where} die gap: ${gap}px`);
        return gap;
      };
      await assertDieGap(user, userDie, "desktop user");
      await assertDieGap(device, deviceDie, "desktop device");

      for (const [input, die] of [[user, userDie], [device, deviceDie]] as const) {
        const initial = await input.inputValue();
        eq(await die.getAttribute("aria-disabled"), "true", "saved petname die was enabled");
        await die.hover();
        let tip = drawer(page).getByRole("tooltip", { name: "clear to re-roll" });
        await tip.waitFor();
        eq(await die.getAttribute("aria-describedby"), await tip.getAttribute("id"), "tooltip association missing");
        await page.mouse.move(0, 0);
        await tip.waitFor({ state: "detached" });
        await die.focus();
        await tip.waitFor();
        await die.press("Escape");
        await tip.waitFor({ state: "detached" });
        await die.click({ force: true });
        eq(await input.inputValue(), initial, "disabled die changed a petname");
        await input.fill("");
        await die.click();
        const first = await waitForInputToDiffer(input, "");
        await die.click();
        await waitForInputToDiffer(input, first);
      }
      await saveDraft(page);

      const userGlyphButton = drawer(page).getByRole("button", { name: "Choose your glyph", exact: true });
      eq(await drawer(page).getByRole("button", { name: "Re-roll user glyph", exact: true }).count(), 0, "settings kept an exterior glyph die");
      await userGlyphButton.click();
      const userPicker = drawer(page).locator(".glyph-picker");
      eq(await userPicker.getByRole("button", { name: "Clear glyph", exact: true }).count(), 0, "user picker kept Clear glyph");
      const userRandom = userPicker.getByRole("button", { name: "Random", exact: true });
      check(await userRandom.isEnabled(), "user Random was disabled for a blank glyph");
      await userRandom.click();
      const firstUserGlyph = await glyphValue(userGlyphButton);
      check(firstUserGlyph !== null && /^[\u{1f400}-\u{1f43f}]$/u.test(firstUserGlyph), "user Random left the animal range");
      check(await userGlyphButton.evaluate((button) => button === document.activeElement), "user Random did not return focus to the tile");
      await userGlyphButton.click();
      check(await userRandom.isEnabled(), "user Random was disabled for an animal glyph");
      await shot(page, "desktop-glyph-random-picker");
      await userRandom.click();
      const secondUserGlyph = await glyphValue(userGlyphButton);
      check(secondUserGlyph !== firstUserGlyph, "user Random repeated its selected animal");
      await drawer(page).getByRole("button", { name: "Revert", exact: true }).click();
      eq(await glyphValue(userGlyphButton), "", "Revert kept a random user glyph");
      await userGlyphButton.click();
      await userRandom.click();
      const savedUserGlyph = await glyphValue(userGlyphButton);
      await saveDraft(page);
      await appsButton(page).click();
      await paneSettled(page);
      await openSettingsSheet(page);
      eq(await drawer(page).getByRole("button", { name: "Re-roll user petname" }).getAttribute("aria-disabled"), null, "saved roll lost eligibility on reopen");
      eq(await glyphValue(drawer(page).getByRole("button", { name: "Choose your glyph", exact: true })), savedUserGlyph, "saved user glyph changed on reopen");

      await launchTodoMvc(page);
      await toAppSheet(page);
      const app = field(/^petname$/);
      const appDie = drawer(page).getByRole("button", { name: "Re-roll app petname" });
      const appGlyphButton = drawer(page).getByRole("button", { name: "Choose glyph", exact: true });
      eq(await appDie.getAttribute("aria-disabled"), "true", "generated app default was rerollable");
      eq(await drawer(page).getByRole("button", { name: /app glyph/i }).count(), 0, "app sheet kept an exterior glyph die");
      await appGlyphButton.click();
      const appPicker = drawer(page).locator(".glyph-picker");
      eq(await appPicker.getByRole("button", { name: "Clear glyph", exact: true }).count(), 0, "app picker kept Clear glyph");
      const appRandom = appPicker.getByRole("button", { name: "Random", exact: true });
      check(await appRandom.isEnabled(), "app Random was disabled for a blank glyph");
      await appRandom.click();
      const firstAppGlyph = await glyphValue(appGlyphButton);
      check(firstAppGlyph !== null && /^[\u{1f400}-\u{1f43f}]$/u.test(firstAppGlyph), "app Random left the animal range");
      check(await appGlyphButton.evaluate((button) => button === document.activeElement), "app Random did not return focus to the tile");
      await appGlyphButton.click();
      check(await appRandom.isEnabled(), "app Random was disabled for an animal glyph");
      await appRandom.click();
      check(await glyphValue(appGlyphButton) !== firstAppGlyph, "app Random repeated its selected animal");
      await app.fill("");
      await appDie.click();
      await page.waitForFunction(() => {
        const label = [...document.querySelectorAll("label")].find((node) => node.textContent?.trim() === "petname");
        return (label?.querySelector("input") as HTMLInputElement | null)?.value.length;
      });
      await drawer(page).getByRole("button", { name: "Revert", exact: true }).click();
      await appGlyphButton.click();
      await appRandom.click();
      const savedAppGlyph = await glyphValue(appGlyphButton);
      await saveDraft(page);
      await openSettingsSheet(page);
      await paneSettled(page);
      await toAppSheet(page);
      eq(await glyphValue(drawer(page).getByRole("button", { name: "Choose glyph", exact: true })), savedAppGlyph, "saved app glyph changed on reopen");
      await pageCleanDrawer(page);
      await page.reload();
      await visorReady(page);
      await page.waitForSelector("#app-zone iframe[sandbox]", { timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector("#visor-drawer") === null);
      await openSettingsSheet(page);
      eq(await drawer(page).getByRole("button", { name: "Re-roll user petname" }).getAttribute("aria-disabled"), "true", "reload retained roll eligibility");
      eq(await glyphValue(drawer(page).getByRole("button", { name: "Choose your glyph", exact: true })), savedUserGlyph, "user glyph did not survive reload");
      check(await drawer(page).getByText("word", { exact: true }).count() === 0, "obsolete word field is still rendered");

      const reloadedUser = field(/^your petname$/);
      const reloadedDevice = field(/^device petname$/);
      await reloadedUser.fill("");
      await reloadedDevice.fill("");
      await saveDraft(page);
      check((await reloadedUser.inputValue()).length > 0, "blank user save was not normalized");
      check((await reloadedDevice.inputValue()).length > 0, "blank device save was not normalized");

      await toAppSheet(page);
      eq(await glyphValue(drawer(page).getByRole("button", { name: "Choose glyph", exact: true })), savedAppGlyph, "app glyph did not survive reload");
      const savedApp = field(/^petname$/);
      await savedApp.fill("");
      await saveDraft(page);
      check((await savedApp.inputValue()).length > 0, "blank app save was not normalized");

      await page.setViewportSize({ width: 390, height: 844 });
      await assertDieGap(field(/^petname$/), drawer(page).getByRole("button", { name: "Re-roll app petname" }), "mobile app");
      const mobileAppGlyph = drawer(page).getByRole("button", { name: "Choose glyph", exact: true });
      await mobileAppGlyph.click();
      await shot(page, "mobile-glyph-random-picker");
      await drawer(page).locator(".glyph-picker").getByRole("searchbox", { name: "Enter glyph or search" }).press("Escape");
      const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      try {
        const mobile = await open(touch, origin);
        await visorReady(mobile);
        await openSettingsSheet(mobile);
        const mobileUser = drawer(mobile).locator("label").filter({ hasText: /^your petname$/ }).locator("input");
        const mobileDie = drawer(mobile).getByRole("button", { name: "Re-roll user petname" });
        const before = await mobileUser.inputValue();
        await mobileDie.tap({ force: true });
        eq(await mobileUser.inputValue(), before, "disabled touch die changed the draft");
        await drawer(mobile).getByRole("tooltip", { name: "clear to re-roll" }).waitFor();
        const mobileGlyph = drawer(mobile).getByRole("button", { name: "Choose your glyph", exact: true });
        const beforeGlyph = await mobileGlyph.textContent();
        await mobileGlyph.tap();
        const mobileDialog = drawer(mobile).locator("dialog.glyph-dialog");
        await mobile.waitForFunction(() => document.querySelector("dialog.glyph-dialog")?.matches(":modal"));
        const underlyingApp = await mobile.locator("#visor-app").boundingBox();
        check(underlyingApp !== null, "underlying app button has no touch geometry");
        await mobile.touchscreen.tap(underlyingApp.x + 8, underlyingApp.y + underlyingApp.height / 2);
        eq(await mobileDialog.count(), 0, "touch outside kept the glyph modal open");
        eq(await mobileGlyph.textContent(), beforeGlyph, "touch outside changed the draft glyph");
        check(await mobileGlyph.evaluate((button) => button === document.activeElement), "touch outside did not return focus to the glyph tile");
        eq(await content(mobile).getAttribute("aria-label"), "settings", "touch outside activated the underlying self button");
        eq(await visorNav(mobile).getAttribute("aria-current"), "page", "touch outside changed the current section");
      } finally {
        await touch.close();
      }
    },
  },

  {
    name: "live-personalization-and-device-names",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      try {
        const a = await open(ctx, origin);
        const b = await open(ctxB, origin);
        await visorReady(a);
        await visorReady(b);
        await setDeviceName(a, "alpha device");
        await setUserPetname(a, "group owner");
        await launchTodoMvc(a);
        await setAppPetname(a, "shared todos");

        // Conflicting pre-pair values on the joiner must be replaced by A's
        // established group identity, while B keeps its own device label.
        await setDeviceName(b, "beta device");
        await setUserPetname(b, "joiner value");
        await launchTodoMvc(b);
        await setAppPetname(b, "joiner todos");
        const idA = await endpointId(a);
        await endpointId(b);
        await pair(a, b);
        await waitForConnectedPeer(b, idA);
        await waitForPageText(b, "group owner");
        await pageCleanDrawer(a);
        await pageCleanDrawer(b);
        await openSettingsSheet(a);
        await devicesSheet(a).locator(".member-row").filter({ hasText: "beta device" }).waitFor({ timeout: 30_000 });

        // Keep one device-local field dirty while clean shared fields update.
        await openSettingsSheet(b);
        const remoteUser = drawer(b).locator("label").filter({ hasText: /^your petname$/ }).locator("input");
        const remoteDie = drawer(b).getByRole("button", { name: "Re-roll user petname" });
        await remoteUser.fill("");
        await remoteDie.click();
        await waitForInputToDiffer(remoteUser, "");
        await saveDraft(b);
        eq(await remoteDie.getAttribute("aria-disabled"), null, "saved roll lost eligibility");
        const dirtyName = drawer(b).locator("label").filter({ hasText: /^device petname$/ }).locator("input");
        await dirtyName.fill("unsaved beta");
        await setUserPetname(a, "post-pair owner");
        await waitForPageText(b, "post-pair owner");
        eq(await remoteUser.inputValue(), "post-pair owner", "remote petname did not replace the clean draft");
        eq(await remoteDie.getAttribute("aria-disabled"), "true", "remote replacement inherited roll eligibility");
        eq(await dirtyName.inputValue(), "unsaved beta", "remote refresh replaced a dirty field");
        await drawer(b).getByRole("button", { name: "Revert", exact: true }).click();
        eq(await dirtyName.inputValue(), "beta device", "Revert did not use the latest synced baseline");

        await openSettingsSheet(a);
        await drawer(a).getByRole("button", { name: "Choose your glyph", exact: true }).click();
        const userPicker = drawer(a).locator(".glyph-picker");
        await userPicker.getByRole("searchbox", { name: "Enter glyph or search" }).fill("★");
        await userPicker.getByRole("button", { name: "Use ★", exact: true }).click();
        await saveDraft(a);
        await waitForPageText(b, "★");

        await openSettingsSheet(a);
        await drawer(a).locator('input[type="range"]').fill("123");
        await saveDraft(a);
        await b.waitForFunction(() => document.querySelector("#visor-root")?.getAttribute("style")?.includes("123"), undefined, { timeout: 30_000 });
        await setAppPetname(a, "post-pair todos");
        await waitForPageText(b, "post-pair todos");

        await a.reload();
        await visorReady(a);
        await waitForPageText(a, "post-pair owner", 15_000);
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    name: "same-device-tabs-live-tasks",
    async run(ctx, origin) {
      const a = await open(ctx, origin);
      await visorReady(a);
      await keepDevice(a, "shared tab device");
      await launchTodoMvc(a);
      const b = await ctx.newPage();
      await b.goto(`${origin}/`);
      await visorReady(b);
      await launchTodoMvc(b);

      await addTodo(a, "live lifecycle");
      await todoFrame(b).getByText("live lifecycle").waitFor({ timeout: 15_000 });
      await todoFrame(b).getByText("live lifecycle").dblclick();
      const edit = todoFrame(b).locator("input.edit");
      await edit.fill("edited remotely");
      await edit.press("Enter");
      await todoFrame(a).getByText("edited remotely").waitFor({ timeout: 15_000 });
      await todoFrame(a).locator("li input[type=checkbox]").first().click();
      await todoFrame(b).locator("li.completed").first().waitFor({ timeout: 15_000 });
      await todoFrame(b).locator("button.destroy").first().click();
      await todoFrame(a).getByText("edited remotely").waitFor({ state: "detached", timeout: 15_000 });
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
        await b.waitForSelector("#app-zone iframe[sandbox]", {
          timeout: 30_000,
        });
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
      // The app's one fetch is its stylesheet, a `blob:` URL the frame
      // minted from the bundle (web/frame.ts's `resolveAsset`) — Playwright
      // reports it as a request but it is not network. The frame's CSP has
      // no connect-src at all, so nothing else can leave.
      const notBlob = fromFrame.filter((url) => !url.startsWith("blob:"));
      check(
        notBlob.length === 0,
        `the app frame made ${notBlob.length} non-blob request(s): ${
          notBlob.join(", ")
        }`,
      );

      // The stylesheet did apply: `.todoapp { background: #fff }` from
      // apps/todomvc/assets/todomvc-app.css.
      const background = await todoFrame(page).locator("section.todoapp")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      eq(background, "rgb(255, 255, 255)", "the stylesheet did not apply");

      // The checkboxes are `data:` SVG background images in that stylesheet
      // (todomvc-app.css `.toggle + label`), which `img-src` must admit. A
      // computed `background-image` reads the same whether or not CSP let
      // the image load, so load a `data:` image in the frame and see.
      const dataImageLoads = await todoFrame(page).locator("body").evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src =
              "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>";
          }),
      );
      check(dataImageLoads, "the frame's CSP blocks data: images");
    },
  },

  {
    name: "pairing-declined-aborts-both",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      try {
        const a = await open(ctx, origin);
        await visorReady(a);
        const b = await open(ctxB, origin);
        await visorReady(b);

        const code = await offerPairing(b);
        await claimPairing(a, code);
        const onA = await sasDigits(a);
        const onB = await sasDigits(b);
        eq(onA, onB, "the two devices showed different pairing digits");

        // B presses "No" (`pairing.cancel`). B's own phase goes straight to
        // Idle; A lands on a failed phase, whether from the cancel itself
        // or from the transport closing first — both are the kernel's own
        // words for "the other side is gone," so both count.
        await devicesSheet(b).getByRole("button", { name: "No", exact: true })
          .click();

        await waitInDevices(
          a,
          'the "other device" failure',
          async () => {
            const err = devicesSheet(a).locator(".sheet-error");
            if (await err.count() === 0) return false;
            return (await err.textContent() ?? "").includes("other device");
          },
          { refresh: false, ms: 15_000 },
        );

        // Neither device is in the other's group: a declined ceremony never
        // reached enrollment.
        for (const page of [a, b]) {
          await refreshSettings(page);
          eq(
            await devicesSheet(page).locator(".member-row").count(),
            1,
            "a declined pairing still added a member",
          );
        }

        // The canceller (B) also lands on Idle: its offer/claim controls
        // are back, not stuck mid-ceremony.
        await refreshSettings(b);
        check(
          await devicesSheet(b).getByRole("button", {
            name: "Pair this device with another",
          }).count() === 1,
          "B did not return to Idle after cancelling",
        );
        check(
          await devicesSheet(b).getByRole("button", {
            name: "Add a device",
            exact: true,
          }).count() === 1,
          "B did not return to Idle after cancelling",
        );
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    // The ceremony, end to end and headless: the kernel mints the URL, the
    // page opens the popup, the fake consents at once and redirects back,
    // the returning load broadcasts the pair on the ceremony's channel, and
    // the kernel exchanges and seals it (internal.wit `storage`,
    // `shell.open-popup`).
    name: "drive-connect",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);

      eq(
        await storageState(page),
        "not connected",
        "a device with no store should say so, in the kernel's own words",
      );
      await connectDrive(page);

      // The tokens are sealed in the kernel's checkpoint, not in the page:
      // a reload has no ceremony to re-run and the binding is still there.
      await page.reload();
      await visorReady(page);
      const said = await storageState(page);
      check(
        connectedCleanly(said),
        `the binding did not survive a reload; it read "${said}"`,
      );
    },
  },

  {
    // The store as a sync path: what one device pushed, another device of
    // the SAME group pulls, with no live connection between them. Two
    // claims: unrelated groups derive different names and so read nothing
    // of each other's (checked unpaired, so no live path exists at all);
    // and after pairing, the store alone carries a todo written while B is
    // offline and read after A is gone — `mediaReads` corroborates that B
    // actually read it from the store rather than over a live connection.
    name: "drive-round-trip",
    async run(ctx, origin, browser, drive) {
      const ctxB = await browser.newContext();
      try {
        const a = await open(ctx, origin);
        await visorReady(a);
        await launchTodoMvc(a);
        await addTodo(a, "from A");
        // Counted BEFORE the ceremony: connecting a store schedules a pass
        // of its own, so a baseline taken afterwards would already include
        // everything A has.
        const before = drive.objects().length;
        await connectDrive(a);
        await syncUntil(a, drive, before + 1, "A's first push");

        const b = await open(ctxB, origin);
        await visorReady(b);
        await connectDrive(b);
        // B is not in A's group: it derives none of A's names, so its own
        // sync reads nothing out of the store at all. `mediaReads` is the
        // oracle for that — a name it cannot derive is a name it never
        // asks `alt=media` for — and it is the stronger claim: the app
        // never mounted "from A" is also true of a device that read the
        // object and merely failed to decode it.
        const readsBeforeB = drive.mediaReads();
        await syncNow(b);
        // `sync-now` returns once accepted, not once the pass settled
        // (internal.wit `storage.sync-now`); a moment for the pass this
        // scenario just triggered to actually run.
        await b.waitForTimeout(2_000);
        eq(
          drive.mediaReads(),
          readsBeforeB,
          "a device outside the group read an object out of the store",
        );
        await launchTodoMvc(b);
        // Its mounted watcher must remain quiet for another group's objects.
        eq(
          await todoFrame(b).getByText("from A").count(),
          0,
          "a device outside the group read another group's objects",
        );

        // Now B joins A's group — which is what carries the naming key,
        // and the only thing that changes.
        const idA = await endpointId(a);
        const idB = await endpointId(b);
        await pair(a, b);
        await waitForMember(a, idB);
        await waitForMember(b, idA);

        // B offline: navigating away (not closing the tab) drops its hold
        // on its SharedWorker regardless of what a second tab would resolve
        // to, and the device anchor is per-tab sessionStorage anyway, so
        // this is the one dependable way to take B offline while keeping
        // its checkpoint (OPFS, sealed tokens) alive under the context.
        await b.goto("about:blank");

        // Written while B could not be listening, so the store is the only
        // place it can reach B from.
        const staged = drive.objects().length;
        await addTodo(a, "posted while B was away");
        await syncUntil(a, drive, staged + 1, "A's second push");

        // ...and A goes away entirely: its context takes its worker, its
        // endpoint and its OPFS with it.
        await ctx.close();

        const readsBefore = drive.mediaReads();
        await b.goto(`${origin}/`);
        await visorReady(b);
        await launchTodoMvc(b);
        await pullUntilTodo(b, "posted while B was away");
        check(
          drive.mediaReads() > readsBefore,
          "the todo arrived without B reading anything out of the store",
        );
      } finally {
        await ctxB.close();
      }
    },
  },

  {
    // The token dance. `/_fake/revoke-access` invalidates every access
    // token and leaves the refresh tokens alive — an access token that
    // expired, which is the one refusal the store has a recovery for. The
    // claim is that a push after it still lands, so the assertion is the
    // fake's object count and not anything the visor says.
    name: "drive-refresh",
    async run(ctx, origin, _browser, drive) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await launchTodoMvc(page);
      await addTodo(page, "before the refusal");
      const pushed = drive.objects().length;
      await connectDrive(page);
      await syncUntil(page, drive, pushed + 1, "the first push");

      const revoked = await fetch(`${drive.url}/_fake/revoke-access`, {
        method: "POST",
      });
      check(revoked.ok, `the fake refused to revoke: ${revoked.status}`);
      await revoked.body?.cancel();

      const afterFirst = drive.objects().length;
      await addTodo(page, "after the refusal");
      await syncUntil(
        page,
        drive,
        afterFirst + 1,
        "the push that had to refresh first",
      );

      // And the binding is still a binding: a 401 that was recovered from
      // must not have left the device asking for re-authorization.
      const said = await storageState(page);
      check(
        connectedCleanly(said),
        `a recovered 401 left the binding reading "${said}"`,
      );
    },
  },

  {
    // Unsaved changes are the user's, and the visor is the only thing that
    // holds them: a field typed into the settings sheet reaches the kernel
    // on `Save` and nowhere else, and a transition away from a dirty sheet
    // asks rather than dropping it (visor/src/ui.rs `Draft`).
    name: "visor-drafts",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await openSettingsSheet(page);
      const field = drawer(page).locator("label").filter({
        hasText: /^device petname$/,
      }).locator("input");
      const original = await field.inputValue();
      const confirm = page.locator("#visor-confirm");

      eq(
        (await drawer(page).locator("#visor-actions").textContent())?.trim(),
        "Close",
        "a clean editable sheet did not offer Close",
      );
      await field.fill("half typed");
      eq(
        (await drawer(page).locator("#visor-actions").textContent())?.trim(),
        "SaveRevert",
        "a dirty sheet did not offer Save and Revert",
      );
      await shot(page, "desktop-action-bar-dirty");

      await drawer(page).getByRole("button", { name: "Revert", exact: true })
        .click();
      eq(await field.inputValue(), original, "bar Revert kept the abandoned draft");
      check(
        await focusIn(page, "#visor-actions") &&
          await drawer(page).getByRole("button", { name: "Close", exact: true })
              .count() === 1,
        `bar Revert did not focus its replacement Close; focus is ${await focused(
          page,
        )}`,
      );
      await shot(page, "desktop-action-bar-clean");
      await field.fill("half typed");

      // Leaving a dirty sheet asks. Cancel means "I was not done": the
      // sheet stays, and so does every character of it.
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      await confirm.getByRole("button", { name: "Cancel", exact: true })
        .click();
      await confirm.waitFor({ state: "detached", timeout: 10_000 });
      eq(await field.inputValue(), "half typed", "Cancel dropped the draft");

      // Revert means "throw it away and go": the transition happens, and
      // the sheet goes back to what the kernel last said — which for a
      // device is its generated name.
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      await confirm.getByRole("button", { name: "Revert", exact: true })
        .click();
      await paneSettled(page);
      check(
        await drawer(page).locator(".app-row").count() > 0,
        "Revert did not go on to the transition it was asked about",
      );
      await openSettingsSheet(page);
      eq(await field.inputValue(), original, "Revert kept the abandoned draft");

      // Saved, and it is the kernel that remembers it: a reload has no
      // draft at all, and reads the name back off the device.
      await field.fill("the workbench");
      await saveDraft(page);
      check(
        await focusIn(page, "#visor-actions") &&
          await drawer(page).getByRole("button", { name: "Close", exact: true })
              .count() === 1,
        `bar Save did not focus its replacement Close; focus is ${await focused(
          page,
        )}`,
      );

      // Same-task input makes this deterministic without a permanent mock:
      // Save captures "first snapshot", then newer typing and two navigation
      // attempts arrive while that async persistence call is in flight.
      await field.fill("first snapshot");
      await field.evaluate((input) => {
        const save = document.querySelector<HTMLButtonElement>(
          "#visor-actions button",
        )!;
        save.focus();
        save.click();
        (input as HTMLInputElement).value = "newer text";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        document.querySelector<HTMLButtonElement>("#visor-app")!.click();
        document.querySelector("#visor-root")!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      await page.waitForFunction(
        () =>
          document.querySelector("#visor-actions")?.textContent?.includes(
            "Save",
          ),
      );
      eq(await content(page).getAttribute("aria-label"), "settings", "navigation escaped while Save was in flight");
      eq(await visorNav(page).getAttribute("aria-current"), "page", "navigation changed the current section while Save was in flight");
      eq(
        await confirm.count(),
        0,
        "navigation opened confirmation during Save",
      );
      eq(await field.inputValue(), "newer text", "Save lost newer field text");
      await drawer(page).getByRole("button", { name: "Revert", exact: true })
        .click();
      eq(
        await field.inputValue(),
        "first snapshot",
        "Revert did not return to the snapshot the kernel accepted",
      );
      await page.reload();
      await visorReady(page);
      await strip(page).getByText("first snapshot").waitFor({
        timeout: 15_000,
      });
      await openSettingsSheet(page);
      eq(
        await field.inputValue(),
        "first snapshot",
        "the saved device petname did not survive a reload",
      );

      // The user's own labels ride in the same draft and land on the strip:
      // the petname in the right half's top line, and one whole extended
      // grapheme in the circle.
      const userPetname = drawer(page).locator("label").filter({
        hasText: /^your petname$/,
      }).locator("input");
      await userPetname.fill("ada");
      const glyph = drawer(page).getByRole("button", {
        name: "Choose your glyph",
        exact: true,
      });
      await glyph.click();
      const picker = drawer(page).locator(".glyph-picker");
      const glyphDialog = drawer(page).locator("dialog.glyph-dialog");
      await page.waitForFunction(() =>
        document.querySelector("dialog.glyph-dialog")?.matches(":modal")
      );
      eq(await drawer(page).locator("dialog:modal").count(), 1, "picker did not open as the only modal dialog");
      eq(await glyphDialog.getAttribute("aria-label"), "Choose your glyph", "glyph dialog has the wrong accessible name");
      const desktopPanel = await picker.boundingBox();
      const desktopViewport = page.viewportSize();
      check(desktopPanel !== null && desktopViewport !== null && desktopPanel.width <= 512 && Math.abs(desktopPanel.x + desktopPanel.width / 2 - desktopViewport.width / 2) <= 1, "desktop glyph modal was not centred at a moderate width");
      eq(await drawer(page).getByRole("button", { name: "Re-roll user glyph", exact: true }).count(), 0, "picker test found an exterior glyph die");
      eq(await picker.getByRole("button", { name: "Clear glyph", exact: true }).count(), 0, "picker test found Clear glyph");
      check(await picker.getByRole("button", { name: "Random", exact: true }).isEnabled(), "Random was not enabled");
      const search = picker.getByRole("searchbox", {
        name: "Enter glyph or search",
      });
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute("type") === "search"
      );
      await search.press("Shift+Tab");
      eq(await page.locator(":focus").textContent(), "Random", "Shift+Tab escaped the modal instead of reaching Random");
      await page.keyboard.press("Shift+Tab");
      check(await glyphDialog.evaluate((dialog) => dialog === document.activeElement), "backward Tab escaped the modal");
      await page.keyboard.press("Tab");
      eq(await page.locator(":focus").textContent(), "Random", "forward Tab did not wrap inside the modal");
      await search.click();
      await picker.locator("label").click({ position: { x: 4, y: 4 } });
      check(await glyphDialog.evaluate((dialog) => dialog.matches(":modal")), "an inside click dismissed the modal");
      const glyphBeforeDismiss = await glyph.textContent();
      const underlyingApp = await appsButton(page).boundingBox();
      check(underlyingApp !== null, "underlying app button has no geometry");
      await page.mouse.click(underlyingApp.x + 8, underlyingApp.y + underlyingApp.height / 2);
      eq(await glyphDialog.count(), 0, "an outside click kept the glyph modal open");
      eq(await glyph.textContent(), glyphBeforeDismiss, "outside dismissal changed the draft glyph");
      check(await glyph.evaluate((button) => button === document.activeElement), "outside dismissal did not return focus to the glyph tile");
      eq(await content(page).getAttribute("aria-label"), "settings", "outside dismissal closed the drawer");
      eq(await visorNav(page).getAttribute("aria-current"), "page", "outside dismissal changed the current section");
      await glyph.click();
      await picker.getByRole("button", { name: "Close", exact: true }).click();
      eq(await glyph.textContent(), glyphBeforeDismiss, "Close changed the draft glyph");
      check(await glyph.evaluate((button) => button === document.activeElement), "Close did not return focus to the glyph tile");
      await glyph.click();
      const actionsBeforeQuery = await drawer(page).locator("#visor-actions")
        .textContent();

      // Search is not a draft mutation. Its raw value stays intact while
      // only the direct candidate strips leading Unicode whitespace and a
      // trailing suffix from the first extended grapheme.
      const compoundQuery = " \u00a0👩🏽‍💻tail";
      await search.fill(compoundQuery);
      eq(await search.inputValue(), compoundQuery, "glyph query was rewritten");
      const results = picker.locator(".glyph-results button");
      eq(
        await results.first().getAttribute("aria-label"),
        "Use 👩🏽‍💻",
        "compound direct candidate was not first",
      );
      await shot(page, "desktop-glyph-compound-query");
      eq(
        await drawer(page).locator("#visor-actions").textContent(),
        actionsBeforeQuery,
        "a glyph query changed the draft state",
      );

      // Composition owns its incomplete query: no partial direct candidate
      // is offered until compositionend, while emoji search remains query-only.
      await search.evaluate((input) => {
        input.dispatchEvent(
          new CompositionEvent("compositionstart", {
            bubbles: true,
          }),
        );
        // An IME may expose only a partial grapheme while composing.
        (input as HTMLInputElement).value = "e";
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
          }),
        );
      });
      eq(await search.inputValue(), "e", "composition query was changed early");
      eq(
        await picker.getByRole("button", { name: "Use e", exact: true })
          .count(),
        0,
        "partial composition exposed a direct candidate",
      );
      await search.dispatchEvent("compositionend");
      await search.evaluate((input) => {
        (input as HTMLInputElement).value = "e\u0301x";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      eq(
        await search.inputValue(),
        "éx",
        "composition changed the raw query",
      );
      eq(
        await results.first().getAttribute("aria-label"),
        "Use é",
        "complete combining grapheme was not the first candidate",
      );

      // Trimmed whole-query emoji search follows the direct candidate while
      // the field keeps its raw spaces: "cat" first offers c, then matching
      // named/shortcode emoji.
      await search.fill("  cat ");
      eq(
        await search.inputValue(),
        "  cat ",
        "spaced letter search query was rewritten",
      );
      eq(
        await results.first().getAttribute("aria-label"),
        "Use c",
        "direct letter was not first",
      );
      check(await results.count() > 1, "cat search returned no emoji matches");
      check(
        await picker.getByRole("button", { name: /cat/i }).count() > 0,
        "spaced cat search returned no named cat emoji",
      );
      await search.press("ControlOrMeta+A");
      await search.pressSequentially("cat");
      eq(
        await search.inputValue(),
        "cat",
        "select-all did not replace the glyph query",
      );
      await shot(page, "desktop-glyph-picker");
      await results.first().click();
      eq(
        await glyph.textContent(),
        "c",
        "direct candidate chose the wrong glyph",
      );
      check(
        await glyph.evaluate((button) => button === document.activeElement),
        "picker selection did not return focus to the glyph tile",
      );
      await drawer(page).getByRole("button", { name: "Revert", exact: true })
        .click();
      eq(await glyph.textContent(), "", "Revert kept a picker choice");
      // Revert covered the whole draft, including the sibling petname.
      await userPetname.fill("ada");

      // Escape closes the inline chooser, not its drawer.
      await glyph.click();
      eq(await search.inputValue(), "", "reopened picker retained its query");
      await search.press("Escape");
      eq(await picker.count(), 0, "Escape kept the glyph picker open");
      check(
        await glyph.evaluate((button) => button === document.activeElement),
        "Escape did not return focus to the glyph tile",
      );
      eq(await content(page).getAttribute("aria-label"), "settings", "Escape closed the drawer with the picker");
      eq(await visorNav(page).getAttribute("aria-current"), "page", "Escape changed the current section with the picker open");
      await glyph.click();
      await search.fill(compoundQuery);
      await results.first().click();
      await saveDraft(page);
      await page.waitForFunction(
        () => document.querySelector("#visor-circle")?.textContent === "👩🏽‍💻",
        undefined,
        { timeout: 10_000 },
      );
      await page.locator("#visor-self").getByText("ada").waitFor({
        timeout: 10_000,
      });
      await page.reload();
      await visorReady(page);
      await page.waitForFunction(
        () => document.querySelector("#visor-circle")?.textContent === "👩🏽‍💻",
      );
      await page.setViewportSize({ width: 390, height: 400 });
      await openSettingsSheet(page);
      const mobileTile = drawer(page).getByRole("button", {
        name: "Choose your glyph",
        exact: true,
      });
      await mobileTile.click();
      const mobileSearch = picker.getByRole("searchbox", {
        name: "Enter glyph or search",
      });
      const mobilePanel = await picker.boundingBox();
      check(mobilePanel !== null && mobilePanel.x >= 12 && mobilePanel.x + mobilePanel.width <= 378 && mobilePanel.y >= 12 && mobilePanel.y + mobilePanel.height <= 388, `short mobile glyph modal escaped the viewport gutter: ${JSON.stringify(mobilePanel)}`);
      console.log(`  short mobile glyph modal bounds: ${JSON.stringify(mobilePanel)}`);
      check(await picker.locator(".glyph-results").evaluate((results) => results.scrollHeight > results.clientHeight), "mobile glyph results were not internally scrollable");
      for (const control of [
        picker.getByRole("button", { name: "Random", exact: true }),
        mobileSearch,
        picker.getByRole("button", { name: "Close", exact: true }),
      ]) {
        const box = await control.boundingBox();
        check(box !== null && box.y >= 0 && box.y + box.height <= 400, `short mobile modal put a fixed control offscreen: ${JSON.stringify(box)}`);
      }
      await mobileSearch.fill("cat");
      await shot(page, "mobile-glyph-picker");

      // Escape and selecting the already-saved glyph are both clean acts.
      await mobileSearch.press("Escape");
      eq(
        await mobileTile.textContent(),
        "👩🏽‍💻",
        "Escape changed the saved glyph",
      );
      await mobileTile.click();
      await mobileSearch.fill(compoundQuery);
      await picker.getByRole("button", { name: "Use 👩🏽‍💻", exact: true })
        .click();
      eq(
        (await drawer(page).locator("#visor-actions").textContent())?.trim(),
        "Close",
        "selecting the saved glyph dirtied the draft",
      );

      // Random remains available for a manually selected saved glyph and is
      // an ordinary draft change that Revert restores.
      await mobileTile.click();
      const previousGlyph = await mobileTile.textContent();
      const random = picker.getByRole("button", { name: "Random", exact: true });
      check(await random.isEnabled(), "Random was disabled for a saved manual glyph");
      await random.click();
      const randomGlyph = await mobileTile.textContent();
      check(randomGlyph !== previousGlyph && randomGlyph !== null && /^[\u{1f400}-\u{1f43f}]$/u.test(randomGlyph), "Random did not replace a saved manual glyph with a different animal");
      check(await mobileTile.evaluate((button) => button === document.activeElement), "Random did not return focus to the glyph tile");
      await drawer(page).getByRole("button", { name: "Revert", exact: true })
        .click();
      eq(
        await mobileTile.textContent(),
        "👩🏽‍💻",
        "Revert did not restore the saved glyph after Random",
      );
    },
  },

  {
    // The sidebar replaces the old horizontal drawer panes. The claim here is
    // purely layout and semantics: it stays bounded by the drawer on desktop
    // and mobile, the strip no longer speaks in pressed-state tab language,
    // the narrow menu closes on selection, and the content area keeps a real
    // usable box.
    name: "sidebar-geometry",
    async run(ctx, origin, browser) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await paneSettled(page);

      eq(await appsButton(page).getAttribute("aria-pressed"), null, "#visor-app kept pressed semantics");
      eq(await settingsButton(page).getAttribute("aria-pressed"), null, "#visor-self kept pressed semantics");
      eq(await appNav(page).getAttribute("aria-current"), "page", "the resting drawer did not mark App current");
      eq(await visorNav(page).getAttribute("aria-current"), null, "Visor started current unexpectedly");
      eq(await contactsNav(page).count(), 1, "Contacts navigation button is missing");

      const desktopDrawer = await drawer(page).boundingBox();
      const desktopSidebar = await sidebar(page).boundingBox();
      const desktopContent = await content(page).boundingBox();
      const desktopStrip = await strip(page).boundingBox();
      check(
        desktopDrawer !== null && desktopSidebar !== null && desktopContent !== null &&
          desktopStrip !== null,
        "desktop sidebar geometry is missing",
      );
      check(
        desktopSidebar.x >= desktopDrawer.x - 0.5 &&
          desktopSidebar.y >= desktopDrawer.y - 0.5 &&
          desktopSidebar.x + desktopSidebar.width <= desktopDrawer.x + desktopDrawer.width + 0.5 &&
          desktopSidebar.y + desktopSidebar.height <= desktopDrawer.y + desktopDrawer.height + 0.5,
        `desktop sidebar escaped the drawer: ${JSON.stringify({ desktopDrawer, desktopSidebar })}`,
      );
      check(
        Math.abs(desktopSidebar.x - desktopDrawer.x) <= 0.5,
        `desktop sidebar did not start at the drawer's left edge: ${JSON.stringify({ desktopDrawer, desktopSidebar })}`,
      );
      check(
        desktopContent.x >= desktopSidebar.x + desktopSidebar.width - 0.5,
        `desktop content did not stay to the right of the sidebar: ${JSON.stringify({ desktopSidebar, desktopContent })}`,
      );
      check(
        Math.abs(desktopDrawer.y + desktopDrawer.height - desktopStrip.y) <= 1,
        `desktop drawer did not stay attached above the strip: ${JSON.stringify({ desktopDrawer, desktopStrip })}`,
      );
      check(desktopContent.height > 0 && desktopContent.width > 0, `desktop content has no usable box: ${JSON.stringify(desktopContent)}`);
      await shot(page, "sidebar-desktop");
      await visorNav(page).click();
      eq(await content(page).getAttribute("aria-label"), "settings", "Visor nav did not switch the content pane to settings");
      eq(await visorNav(page).getAttribute("aria-current"), "page", "Visor nav did not become current");
      check(await content(page).locator('input[type="range"]').count() > 0, "settings content did not remain usable on desktop");
      await appNav(page).click();
      eq(await content(page).getAttribute("aria-label"), "apps", "App nav did not switch back to apps");
      await content(page).locator(".app-row").first().waitFor({ timeout: 10_000 });
      let over = await sidewaysOverflow(page);
      check(over.length === 0, `desktop sidebar layout overflowed: ${over.join("; ")}`);

      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      try {
        const narrow = await open(mobile, origin);
        await visorReady(narrow);
        await paneSettled(narrow);
        await sidebarToggle(narrow).waitFor({ timeout: 10_000 });
        eq(await sidebarToggle(narrow).getAttribute("aria-expanded"), "false", "mobile nav toggle started open");
        const before = await content(narrow).boundingBox();
        check(before !== null && before.height > 0 && before.width > 0, `mobile content started unusable: ${JSON.stringify(before)}`);

        await sidebarToggle(narrow).click();
        await waitForSidebarState(narrow, true);
        eq(await sidebarToggle(narrow).getAttribute("aria-expanded"), "true", "mobile nav toggle did not open the menu");
        const mobileDrawer = await drawer(narrow).boundingBox();
        const mobileSidebar = await sidebar(narrow).boundingBox();
        const mobileContent = await content(narrow).boundingBox();
        const mobileStrip = await strip(narrow).boundingBox();
        check(
          mobileDrawer !== null && mobileSidebar !== null && mobileContent !== null &&
            mobileStrip !== null,
          "mobile sidebar geometry is missing",
        );
        check(
          mobileSidebar.x >= mobileDrawer.x - 0.5 &&
            mobileSidebar.y >= mobileDrawer.y - 0.5 &&
            mobileSidebar.x + mobileSidebar.width <= mobileDrawer.x + mobileDrawer.width + 0.5 &&
            mobileSidebar.y + mobileSidebar.height <= mobileDrawer.y + mobileDrawer.height + 0.5,
          `mobile sidebar escaped the drawer: ${JSON.stringify({ mobileDrawer, mobileSidebar })}`,
        );
        check(
          Math.abs(mobileSidebar.x - mobileDrawer.x) <= 0.5,
          `mobile sidebar did not open from the drawer's left edge: ${JSON.stringify({ mobileDrawer, mobileSidebar })}`,
        );
        check(
          Math.abs(mobileDrawer.y + mobileDrawer.height - mobileStrip.y) <= 1,
          `mobile drawer did not stay attached above the strip: ${JSON.stringify({ mobileDrawer, mobileStrip })}`,
        );
        check(
          mobileSidebar.height > 0 && mobileSidebar.height <= mobileDrawer.height + 0.5,
          `mobile sidebar height escaped the drawer: ${JSON.stringify({ mobileDrawer, mobileSidebar })}`,
        );
        check(mobileContent.height > 0 && mobileContent.width > 0, `mobile content collapsed under the open sidebar: ${JSON.stringify(mobileContent)}`);
        over = await sidewaysOverflow(narrow);
        check(over.length === 0, `mobile sidebar layout overflowed while open: ${over.join("; ")}`);
        await shot(narrow, "sidebar-mobile-open");

        await contactsNav(narrow).focus();
        check(await activeElementVisible(narrow), "mobile current nav item was not visibly focusable while open");
        await narrow.keyboard.press("Tab");
        const afterTab = await focused(narrow);
        await waitForSidebarState(narrow, false);
        check(await focusIn(narrow, "#visor-content"), `Tab from the last mobile nav item did not move into content: ${afterTab}`);
        check(await activeElementVisible(narrow), "mobile content focus after dismissing the menu was not visible");

        await sidebarToggle(narrow).click();
        await waitForSidebarState(narrow, true);
        await visorNav(narrow).click();
        await waitForSidebarState(narrow, false);
        eq(await sidebarToggle(narrow).getAttribute("aria-expanded"), "false", "mobile nav selection did not close the menu");
        eq(await content(narrow).getAttribute("aria-label"), "settings", "mobile Visor nav did not switch the content pane to settings");
        eq(await visorNav(narrow).getAttribute("aria-current"), "page", "mobile Visor nav did not become current");
        check(await content(narrow).locator('input[type="range"]').count() > 0, "mobile settings content did not remain usable");
        check(await activeElementVisible(narrow), "mobile focus after selecting a nav section was not visible");

        const settingsField = content(narrow).locator("label").filter({ hasText: /^device petname$/ }).locator("input");
        await settingsField.fill("mobile draft");
        await sidebarToggle(narrow).click();
        await waitForSidebarState(narrow, true);
        await appNav(narrow).click();
        const confirm = narrow.locator("#visor-confirm");
        await confirm.waitFor({ timeout: 10_000 });
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await confirm.waitFor({ state: "detached", timeout: 10_000 });
        eq(await content(narrow).getAttribute("aria-label"), "settings", "dirty-draft cancel left the wrong section visible");
        check(await activeElementVisible(narrow), "dirty-draft cancel did not return visible focus");
        eq(await settingsField.inputValue(), "mobile draft", "dirty-draft cancel lost the typed value");
        await drawer(narrow).getByRole("button", { name: "Revert", exact: true }).click();

        await sidebarToggle(narrow).click();
        await waitForSidebarState(narrow, true);
        await appNav(narrow).click();
        await waitForSidebarState(narrow, false);
        eq(await content(narrow).getAttribute("aria-label"), "apps", "mobile App nav did not switch back to apps");
        await content(narrow).locator(".app-row").first().waitFor({ timeout: 10_000 });
        const after = await content(narrow).boundingBox();
        check(after !== null && after.height > 0 && after.width > 0, `mobile content ended unusable: ${JSON.stringify(after)}`);
        over = await sidewaysOverflow(narrow);
        check(over.length === 0, `mobile sidebar layout overflowed after selection: ${over.join("; ")}`);
        await shot(narrow, "sidebar-mobile-closed");
      } finally {
        await mobile.close();
      }
    },
  },

  {
    // One representative browser path for the identity contract: pairing
    // adopts the founder's public identity but not its root secret; an
    // explicit, named member transfer changes custody and survives reload.
    name: "identity-root-transfer-and-profile",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      const ctxC = await browser.newContext();
      try {
        const a = await open(ctx, origin);
        const b = await open(ctxB, origin);
        const c = await open(ctxC, origin);
        await Promise.all([visorReady(a), visorReady(b), visorReady(c)]);
        await expectRootCustody(a, true);
        await addProfileClaim(a, "name", "Founder Identity");

        const idA = await endpointId(a);
        const idB = await endpointId(b);
        await pair(a, b);
        await waitForMember(a, idB);
        await waitForConnectedPeer(b, idA);
        await waitForOfficialValue(b, "Founder Identity");
        await expectRootCustody(b, false);
        await shot(b, "identity-before-root-transfer");

        // A non-root member still has ordinary group authority and can enroll C.
        const idC = await endpointId(c);
        await pair(b, c);
        await waitForMember(b, idC);
        await waitForOfficialValue(c, "Founder Identity");
        await expectRootCustody(c, false);

        await openSettings(a);
        const memberB = devicesSheet(a).locator(
          `.member-row[data-endpoint-id="${idB}"]`,
        );
        await memberB.locator(".root-transfer-start").click();
        const confirm = memberB.locator(
          `.root-transfer-confirm[data-transfer-endpoint="${idB}"]`,
        );
        await confirm.waitFor();
        check(
          (await confirm.textContent() ?? "").includes(idB),
          "root transfer confirmation did not name B's endpoint",
        );
        await confirm.getByRole("button", {
          name: "Approve permanent root copy",
          exact: true,
        }).click();
        await waitForRootCustody(b, true);
        await shot(b, "identity-after-root-transfer");

        await b.reload();
        await visorReady(b);
        await expectRootCustody(b, true);

        // A root holder can copy custody onward; this does not depend on
        // profile propagation completing first.
        await openSettings(b);
        const memberC = devicesSheet(b).locator(
          `.member-row[data-endpoint-id="${idC}"]`,
        );
        await memberC.locator(".root-transfer-start").click();
        await memberC.locator(".root-transfer-confirm")
          .getByRole("button", {
            name: "Approve permanent root copy",
            exact: true,
          })
          .click();
        await waitForRootCustody(c, true);

        await addProfileClaim(b, "email", "founder@example.test");
        await openSettings(b);
        await devicesSheet(b).locator(`.member-row[data-endpoint-id="${idA}"]`)
          .getByRole("button", { name: "Connect", exact: true }).click();
        await waitForConnectedPeer(b, idA);
        await waitForOfficialValue(a, "founder@example.test");
      } finally {
        await closeContext(ctxB, "identity-root-transfer-B");
        await closeContext(ctxC, "identity-root-transfer-C");
      }
    },
  },

  {
    // File and synced backups use the same passphrase envelope. This keeps
    // the browser claim to one successful round trip plus meaningful wrong-
    // passphrase and modified-file boundaries; envelope edge cases stay in
    // native tests.
    name: "identity-root-backup-roundtrip",
    async run(ctx, origin, browser) {
      const passphrase = "synthetic e2e backup passphrase";
      const wrongPassphrase = "synthetic wrong passphrase";
      const ctxB = await browser.newContext();
      try {
        const a = await open(ctx, origin);
        await visorReady(a);
        await openContactsView(a, "My profile", ".contacts-profile");
        const profileA = contactsSheet(a).locator(".contacts-profile");
        const passA = labeledInput(profileA, "Backup passphrase");
        await passA.fill(passphrase);
        await profileA.getByRole("button", {
          name: "Create or replace synced backup",
          exact: true,
        }).click();
        await profileA.locator("#root-backup-status")
          .getByText("Synced backup enabled.", { exact: true }).waitFor({
            timeout: 30_000,
          });

        const downloadPromise = a.waitForEvent("download");
        await profileA.getByRole("button", {
          name: "Export backup file",
          exact: true,
        }).click();
        const download = await downloadPromise;
        const backupPath = "/tmp/opencode/user-identity-root-backup.pvbackup";
        await download.saveAs(backupPath);
        const tamperedPath =
          "/tmp/opencode/user-identity-root-backup-tampered.pvbackup";
        const tampered = await Deno.readFile(backupPath);
        check(
          tampered.length > 32,
          "exported root backup was unexpectedly short",
        );
        tampered[Math.floor(tampered.length / 2)] ^= 1;
        await Deno.writeFile(tamperedPath, tampered);

        const b = await open(ctxB, origin);
        await visorReady(b);
        await pair(a, b);
        await waitForRootCustody(b, false);
        await openContactsView(b, "My profile", ".contacts-profile");
        const profileB = contactsSheet(b).locator(".contacts-profile");
        const passB = labeledInput(profileB, "Backup passphrase");

        await passB.fill(wrongPassphrase);
        let chooserPromise = b.waitForEvent("filechooser");
        await profileB.getByRole("button", {
          name: "Import backup file",
          exact: true,
        }).click();
        let chooser = await chooserPromise;
        await chooser.setFiles(backupPath);
        await contactsSheet(b).locator(".sheet-error").waitFor({
          timeout: 30_000,
        });
        await expectRootCustody(b, false);

        await passB.fill(passphrase);
        chooserPromise = b.waitForEvent("filechooser");
        await profileB.getByRole("button", {
          name: "Import backup file",
          exact: true,
        }).click();
        chooser = await chooserPromise;
        await chooser.setFiles(tamperedPath);
        await contactsSheet(b).locator(".sheet-error").waitFor({
          timeout: 30_000,
        });
        await expectRootCustody(b, false);

        await openContactsView(b, "My profile", ".contacts-profile");
        await labeledInput(
          contactsSheet(b).locator(".contacts-profile"),
          "Backup passphrase",
        )
          .fill(passphrase);
        chooserPromise = b.waitForEvent("filechooser");
        await contactsSheet(b).getByRole("button", {
          name: "Import backup file",
          exact: true,
        }).click();
        chooser = await chooserPromise;
        await chooser.setFiles(backupPath);
        await waitForRootCustody(b, true);
        await shot(b, "identity-backup-unlocked");

        await openContactsView(b, "My profile", ".contacts-profile");
        await contactsSheet(b).getByRole("button", {
          name: "Disable synced backup",
          exact: true,
        }).click();
        await contactsSheet(b).locator("#root-backup-status")
          .getByText("Synced backup disabled.", { exact: true }).waitFor({
            timeout: 30_000,
          });
        await b.reload();
        await visorReady(b);
        await expectRootCustody(b, true);
        await openContactsView(b, "My profile", ".contacts-profile");
        await contactsSheet(b).locator("#root-backup-status")
          .getByText("Synced backup disabled.", { exact: true }).waitFor();
      } finally {
        await closeContext(ctxB, "identity-root-backup-B");
      }
    },
  },

  {
    name: "contacts-portable-file-import",
    async run(ctx, origin, browser) {
      const author = await open(ctx, origin);
      await visorReady(author);
      await addProfileClaim(author, "name", "Ada Portable");
      await addProfileClaim(author, "email", "ada-portable@example.test");
      await openContactsView(author, "Share", ".contacts-share");
      const share = contactsSheet(author).locator(".contacts-share");
      const official = share.locator(".share-official-profile").first();
      await official.getByText("Ada Portable", { exact: true }).waitFor();
      await official.getByText("ada-portable@example.test", { exact: true })
        .waitFor();
      eq(
        await share.locator('.share-official-profile input[type="checkbox"]')
          .count(),
        0,
        "official profile exposed selective-claim controls",
      );
      await shot(author, "contacts-share-preview");
      await share.getByRole("button", {
        name: "Sign contact card",
        exact: true,
      }).click();
      await share.getByRole("button", {
        name: "Save contact file",
        exact: true,
      }).waitFor({ timeout: 10_000 });

      await Deno.mkdir("/tmp/opencode", { recursive: true });
      const cardPath =
        "/tmp/opencode/contacts-portable-file-import.polycontact";
      const downloadPromise = author.waitForEvent("download");
      await share.getByRole("button", {
        name: "Save contact file",
        exact: true,
      }).click();
      const download = await downloadPromise;
      await download.saveAs(cardPath);
      await Deno.stat(cardPath);

      const tamperedPath =
        "/tmp/opencode/contacts-portable-file-import-tampered.polycontact";
      const tampered = await Deno.readFile(cardPath);
      check(tampered.length > 0, "saved contact card was empty");
      tampered[Math.floor(tampered.length / 2)] ^= 0x01;
      await Deno.writeFile(tamperedPath, tampered);

      const recipientCtx = await browser.newContext();
      try {
        const recipient = await open(recipientCtx, origin);
        await visorReady(recipient);
        await openContactsView(recipient, "Import", ".contacts-import-review");
        const importView = contactsSheet(recipient).locator(
          ".contacts-import-review",
        );

        let fileChooserPromise = recipient.waitForEvent("filechooser");
        await importView.getByRole("button", {
          name: "Choose contact file",
          exact: true,
        }).click();
        let fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(tamperedPath);
        await contactsSheet(recipient).locator(".sheet-error").waitFor({
          timeout: 10_000,
        });
        eq(
          await contactsSheet(recipient).locator(".import-party").count(),
          0,
          "tampered contact file still produced an import review",
        );
        await openContactsView(recipient, "Contacts", ".contacts-list");
        eq(
          await contactsSheet(recipient).locator(".contact-row").filter({
            hasText: "Ada Portable",
          }).count(),
          0,
          "tampered contact file created a contact",
        );

        await openContactsView(recipient, "Import", ".contacts-import-review");
        fileChooserPromise = recipient.waitForEvent("filechooser");
        await importView.getByRole("button", {
          name: "Choose contact file",
          exact: true,
        }).click();
        fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(cardPath);
        await importView.getByText(/Verified signed introduction/i).waitFor({
          timeout: 10_000,
        });
        const signedProfile = importView.locator(".signed-import-profile")
          .first();
        await signedProfile.getByText("Ada Portable", { exact: true })
          .waitFor();
        await signedProfile.getByText("ada-portable@example.test", {
          exact: true,
        }).waitFor();
        await shot(recipient, "contacts-import-review");
        await importView.getByRole("button", {
          name: "Import complete signed profiles",
          exact: true,
        }).click();
        await importView.locator(".signed-import-identity").waitFor({
          state: "detached",
          timeout: 15_000,
        });

        await openContactsView(recipient, "Contacts", ".contacts-list");
        const row = contactsSheet(recipient).locator(".contact-row").first();
        await row.waitFor({ timeout: 10_000 });
        await row.click();
        const detail = contactsSheet(recipient).locator(".contact-details");
        await detail.waitFor({ timeout: 10_000 });
        const retained = detail.locator(".contact-official-profile").first();
        await retained.getByText("Ada Portable", { exact: true }).waitFor();
        await retained.getByText("ada-portable@example.test", { exact: true })
          .waitFor();
        await shot(recipient, "contacts-detail");

        await recipient.reload();
        await visorReady(recipient);
        await openContactsView(recipient, "Contacts", ".contacts-list");
        const again = contactsSheet(recipient).locator(".contact-row").first();
        await again.waitFor({ timeout: 10_000 });
        await again.click();
        const restored = contactsSheet(recipient).locator(".contact-details");
        await restored.locator(".contact-official-profile").first()
          .getByText("ada-portable@example.test", { exact: true }).waitFor();
      } finally {
        await recipientCtx.close();
      }
    },
  },

  {
    name: "contacts-meet-now",
    async run(ctx, origin, browser) {
      const ctxB = await browser.newContext();
      let a: Page | undefined;
      let b: Page | undefined;
      try {
        a = await open(ctx, origin);
        b = await open(ctxB, origin);
        await visorReady(a);
        await visorReady(b);
        const idA = await endpointId(a);
        const idB = await endpointId(b);
        check(idA !== idB, "meeting peers share one endpoint id");

        await addProfileClaim(a, "name", "Ada Meeting");
        await addProfileClaim(b, "name", "Bob Meeting");
        await openContactsView(a, "Meet now", ".meet-now");
        const meetA = contactsSheet(a).locator(".meet-now");
        await meetA.locator(".meeting-share-profile")
          .getByText("Ada Meeting", { exact: true }).waitFor();
        eq(
          await meetA.locator('.meeting-share-profile input[type="checkbox"]')
            .count(),
          0,
          "meeting exposed selective official-profile controls",
        );
        await meetA.getByRole("button", { name: "Offer meeting", exact: true }).click();
        const offer = contactsSheet(a).locator(".meet-offer");
        await offer.waitFor({ timeout: 30_000 });
        eq(await offer.locator("svg.qr").count(), 1, "meeting offer did not render a QR");
        const link = (await offer.locator("code").textContent() ?? "").trim();
        check(link.startsWith(origin + "/#meet/"), `meeting offer did not expose a meet link: ${link}`);
        await shot(a, "meet-offer");

        await b.goto("about:blank");
        await b.goto(link);
        await visorReady(b);
        await contactsSheet(b).waitFor({ timeout: 10_000 });
        const meetB = contactsSheet(b).locator(".meet-now");
        await meetB.waitFor({ timeout: 10_000 });
        await meetB.locator(".meet-join-review").waitFor({ timeout: 10_000 });
        await meetB.getByRole("button", { name: "Join meeting", exact: true }).click();

        const confirmA = contactsSheet(a).locator(".meet-confirm");
        const confirmB = contactsSheet(b).locator(".meet-confirm");
        await confirmA.waitFor({ timeout: 30_000 });
        await confirmB.waitFor({ timeout: 30_000 });
        const sasA = (await confirmA.locator(".meet-sas").textContent() ?? "").trim();
        const sasB = (await confirmB.locator(".meet-sas").textContent() ?? "").trim();
        eq(sasA, sasB, "meeting peers showed different SAS values");
        await shot(a, "meet-confirm-host");
        await shot(b, "meet-confirm-joiner");

        await confirmA.getByRole("button", { name: "Confirm", exact: true }).click();
        await contactsSheet(a).getByText("Waiting for the other person…", { exact: true }).waitFor({ timeout: 10_000 });
        await confirmB.getByRole("button", { name: "Confirm", exact: true }).click();
        await contactsSheet(a).getByText(/^Meeting complete\. Contact /).waitFor({ timeout: 30_000 });
        await contactsSheet(b).getByText(/^Meeting complete\. Contact /).waitFor({ timeout: 30_000 });

        await contactsTool(a, "Contacts").click();
        await contactsSheet(a).locator(".contacts-list").waitFor({ timeout: 10_000 });
        const contactB = contactsSheet(a).locator(".contact-row").first();
        await contactB.waitFor({ timeout: 10_000 });
        await contactB.click();
        await contactsSheet(a).locator(".contact-official-profile")
          .getByText("Bob Meeting", { exact: true }).waitFor({ timeout: 10_000 });
        await contactsTool(b, "Contacts").click();
        await contactsSheet(b).locator(".contacts-list").waitFor({ timeout: 10_000 });
        const contactA = contactsSheet(b).locator(".contact-row").first();
        await contactA.waitFor({ timeout: 10_000 });
        await contactA.click();
        await contactsSheet(b).locator(".contact-official-profile")
          .getByText("Ada Meeting", { exact: true }).waitFor({ timeout: 10_000 });

        await openSettings(a);
        eq(await devicesSheet(a).locator(`.member-row[data-endpoint-id="${idB}"]`).count(), 0, "meeting enrolled the peer into A's group membership");
        await openSettings(b);
        eq(await devicesSheet(b).locator(`.member-row[data-endpoint-id="${idA}"]`).count(), 0, "meeting enrolled the peer into B's group membership");
      } catch (err) {
        if (a !== undefined) {
          await shot(a, "meet-fail-host").catch(() => {});
        }
        if (b !== undefined) {
          await shot(b, "meet-fail-joiner").catch(() => {});
        }
        throw err;
      } finally {
        await closeContext(ctxB, "contacts-meet-now-joiner");
      }
    },
  },

  {
    // Both realms on this side, named: the visor on the main thread and the
    // runtime in the SharedWorker. The worker is worth spelling out — a
    // page can see its own realm fail, but a worker that throws while
    // instantiating does so out of sight, and `workerBooted` is the only
    // evidence on this side that it did not. The frame realm is covered by
    // every scenario that launches an app: a frame that suspended would
    // never mount.
    name: "instantiates-without-jspi",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      // The strip paints before the worker answers (OPFS preopen, checkpoint
      // read), so wait for the mark rather than sampling it at first pixel.
      await page.waitForFunction(
        () =>
          ((globalThis as Record<string, unknown>).__polyvisor as {
            workerBooted: boolean;
          }).workerBooted,
        undefined,
        { timeout: 30_000 },
      );
      // Every `instantiate` call in the repository passes `{ jspi: false }`
      // (web/jspi_test.ts pins that at the source level), under which
      // polyengine refuses a sync-typed import that returns a Promise. So
      // the strip rendering and the worker answering `booted` — which needs
      // the runtime's exports and its endpoint's in-guest signer — proves no
      // import took a suspending path.
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

  {
    // The drawer by keyboard alone: a way OUT of an open pane, and a
    // guarantee that Tab cannot walk under the scrim into the app.
    name: "drawer-keyboard",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await launchTodoMvc(page);
      // The app has the screen: the drawer is gone and the zone is live.
      await page.waitForFunction(
        () => document.querySelector("#visor-drawer") === null,
        undefined,
        { timeout: 10_000 },
      );
      eq(await inert(page, "#app-zone"), false, "the app zone stayed inert");

      // Raise the running app's sheet from the strip, by keyboard.
      await appsButton(page).focus();
      await page.keyboard.press("Enter");
      await paneSettled(page);
      check(
        await focusIn(page, "#visor-content"),
        `opening a pane left the keyboard at ${await focused(page)}`,
      );

      // `inert` and not a `tabindex` sweep: the app zone holds a frame whose
      // contents this side cannot enumerate.
      eq(
        await inert(page, "#app-zone"),
        true,
        "the app zone is reachable under the scrim",
      );
      const tour = await tabTour(page, 12);
      check(
        !tour.includes("!app-zone"),
        `Tab reached the app under the scrim: ${tour.join(" → ")}`,
      );
      // ...and the strip is not walled off: an open pane is not a modal.
      check(
        tour.includes("#visor-app") || tour.includes("#visor-self"),
        `an open pane trapped the keyboard away from the strip: ${
          tour.join(" → ")
        }`,
      );

      eq(
        await drawer(page).locator("#visor-actions").textContent(),
        "Close",
        "the running app's sheet offered no way back to it",
      );

      // Escape is that button by another name, and the caret goes back to
      // the half of the strip that raised the pane.
      await content(page).focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.querySelector("#visor-drawer") === null,
        undefined,
        { timeout: 10_000 },
      );
      eq(await focused(page), "#visor-app", "the keyboard was left nowhere");
      eq(
        await inert(page, "#app-zone"),
        false,
        "the app stayed unreachable after the drawer closed",
      );

      // Reopen: the animation ran both ways and the pane still takes the
      // caret — the case a one-shot focus would get wrong.
      await page.keyboard.press("Enter");
      await paneSettled(page);
      check(
        await focusIn(page, "#visor-content"),
        `reopening left the keyboard at ${await focused(page)}`,
      );
      await shot(page, "desktop-app-sheet");
    },
  },

  {
    // The same claims where the drawer is pinned (so "out" is the app list)
    // and with the animations taken away: every close waits on
    // `animationend`, and a zero-duration animation still has to fire one.
    name: "drawer-keyboard-reduced-motion",
    async run(_ctx, origin, browser) {
      const ctx = await browser.newContext({ reducedMotion: "reduce" });
      try {
        const page = await open(ctx, origin);
        await visorReady(page);
        // Nothing behind the drawer, so it offers no way out at all.
        await paneSettled(page);
        eq(
          await drawer(page).locator("#visor-actions").count(),
          0,
          "the resting app list offered a dismissal to nowhere",
        );

        await settingsButton(page).focus();
        await page.keyboard.press("Enter");
        await paneSettled(page);
        eq(
          await drawer(page).locator("#visor-actions").textContent(),
          "Close",
          "a pinned settings sheet offered no way back",
        );
        check(
          await focusIn(page, "#visor-content"),
          `opening settings left the keyboard at ${await focused(page)}`,
        );

        // Escape lands on the app list rather than shutting the drawer: the
        // visor rests there (visor/src/state.rs `reduce`, pinned).
        await page.keyboard.press("Escape");
        await paneSettled(page);
        check(
          await drawer(page).locator(".app-row").count() > 0,
          "Escape from a pinned sheet did not land on the app list",
        );
        check(
          await focusIn(page, "#visor-content"),
          `the switch left the keyboard at ${await focused(page)}`,
        );

        // A launch is a close the user did not press, and it still has to
        // hand the app zone back without the animation it waits on.
        await launchTodoMvc(page);
        await page.waitForFunction(
          () => document.querySelector("#visor-drawer") === null,
          undefined,
          { timeout: 10_000 },
        );
        eq(
          await inert(page, "#app-zone"),
          false,
          "the drawer left the app zone inert behind it",
        );
      } finally {
        await ctx.close();
      }
    },
  },

  {
    // The unsaved-changes dialog is the one modal thing in the visor: three
    // answers, none safe to guess. So it is named, the caret is put in it,
    // nothing outside it can be reached or pressed until it is answered, and
    // every way of answering leaves the caret somewhere sensible.
    name: "drawer-confirm-focus",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await openSettingsSheet(page);
      const field = drawer(page).locator("label").filter({
        hasText: /^device petname$/,
      }).locator("input");
      const confirm = page.locator("#visor-confirm");

      await field.fill("half typed");
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });

      // Named, or a screen reader announces a dialog about nothing.
      eq(await confirm.getAttribute("role"), "dialog", "the dialog's role");
      eq(
        await confirm.getAttribute("aria-label"),
        "unsaved changes",
        "the dialog's accessible name",
      );
      check(
        await focusIn(page, "#visor-confirm"),
        `the dialog did not take the keyboard; it is at ${await focused(page)}`,
      );
      eq(await inert(page, "#visor-strip"), true, "the strip under a dialog");
      eq(await inert(page, "#visor-drawer"), true, "the drawer under a dialog");

      // Escape cancels the DIALOG and nothing else: the draft is still the
      // user's, the sheet has not moved, and the caret goes back where it
      // was when the dialog appeared.
      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "detached", timeout: 10_000 });
      eq(await field.inputValue(), "half typed", "Escape dropped the draft");
      eq(
        await inert(page, "#visor-strip"),
        false,
        "the strip stayed inert after the dialog went",
      );
      eq(
        await focused(page),
        "#visor-app",
        "cancelling by Escape left the keyboard nowhere",
      );
      // The sheet the draft belongs to is still the one on screen.
      eq(await content(page).getAttribute("aria-label"), "settings", "Escape took the section change it was asked about");
      eq(await visorNav(page).getAttribute("aria-current"), "page", "Escape changed the current section under the dialog");

      // Held: with everything else inert there is nowhere for Tab to go but
      // the three answers. (Past the last it leaves for the browser's own
      // chrome and comes back, which is not a way into the visor.)
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      const tour = await tabTour(page, 8);
      for (const where of ["#visor-app", "#visor-self", "!app-zone"]) {
        check(
          !tour.includes(where),
          `Tab escaped the dialog to ${where}: ${tour.join(" → ")}`,
        );
      }

      // Cancel, the button, means what Escape meant.
      await confirm.getByRole("button", { name: "Cancel", exact: true })
        .click();
      await confirm.waitFor({ state: "detached", timeout: 10_000 });
      eq(await field.inputValue(), "half typed", "Cancel dropped the draft");
      eq(
        await focused(page),
        "#visor-app",
        "Cancel left the keyboard nowhere",
      );

      // Revert answers the dialog AND takes the transition it was asking
      // about — so the caret follows the transition rather than going back
      // to a strip half the user has now left.
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      await confirm.getByRole("button", { name: "Revert", exact: true })
        .click();
      await paneSettled(page);
      check(
        await drawer(page).locator(".app-row").count() > 0,
        "Revert did not go on to the transition it was asked about",
      );
      check(
        await focusIn(page, "#visor-content"),
        `Revert left the keyboard at ${await focused(page)}`,
      );
      eq(await appNav(page).getAttribute("aria-current"), "page", "Revert did not leave the App section current");

      // Save, likewise, and the kernel is the one that remembers it. The
      // transition waits on the kernel here — `save_draft` calls one
      // `set-*` per changed field and only then takes the parked action —
      // so the caret rests on the strip half in the meantime and follows
      // the pane when it finally arrives. Waiting on the app list rather
      // than on `paneSettled`: the Settings pane is itself "settled" for
      // as long as the save is in flight.
      await openSettingsSheet(page);
      await field.fill("the workbench");
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      await confirm.getByRole("button", { name: "Save", exact: true }).click();
      await drawer(page).locator(".app-row").first().waitFor({
        timeout: 15_000,
      });
      await paneSettled(page);
      check(
        await focusIn(page, "#visor-content"),
        `Save left the keyboard at ${await focused(page)}`,
      );
      eq(await appNav(page).getAttribute("aria-current"), "page", "Save did not leave the App section current");
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });

      // With an app running there is a scrim as well, and it is a press
      // target, so it must not silently answer the dialog in place of one
      // of the three named buttons.
      await launchTodoMvc(page);
      await openSettingsSheet(page);
      await field.fill("typed over the app");
      await appsButton(page).click();
      await confirm.waitFor({ timeout: 10_000 });
      eq(await inert(page, "#visor-scrim"), true, "the scrim under a dialog");
      await page.locator("#visor-scrim").click({ force: true });
      await page.waitForTimeout(300);
      eq(
        await page.locator("#visor-confirm").count(),
        1,
        "a scrim press answered the dialog",
      );
      await confirm.getByRole("button", { name: "Revert", exact: true })
        .click();
      await paneSettled(page);
      eq(await content(page).getAttribute("aria-label"), "the running app", "the scrim press replaced the section the dialog was asked about");
      eq(await appNav(page).getAttribute("aria-current"), "page", "the scrim press left the wrong section current");
    },
  },

  {
    // Two handheld widths. The Devices section pairs long machine
    // identifiers with short framework-voice facts, so nothing may be
    // answered by hiding: the whole identifier stays reachable — wrapped or
    // locally scrolled — while neither the page nor the drawer scrolls
    // sideways.
    name: "visor-narrow-layout",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      // A person's own words, at the length people use.
      await setDeviceName(page, "Ada's very own workbench in the back room");
      await drawer(page).locator("label").filter({ hasText: /^your petname$/ })
        .locator("input").fill("Ada Lovelace-Byron the Elder");
      await saveDraft(page);

      // The unnamed case, where an id and a short fact sit closest: with no
      // petname, a device is shown by its endpoint id alone.
      const id = await endpointId(page);
      check(id.length > 20, `the endpoint id is implausibly short: ${id}`);
      await waitInDevices(
        page,
        "this device in its own group",
        async () => await devicesSheet(page).locator(".member-row").count() > 0,
        { refresh: true },
      );

      // Where the long identifiers are, and so what the pictures show.
      await devicesSheet(page).scrollIntoViewIfNeeded();
      await content(page).evaluate((el) =>
        el.scrollTo(0, el.scrollHeight)
      );
      const actionBox = await drawer(page).locator("#visor-actions")
        .boundingBox();
      const stripBox = await strip(page).boundingBox();
      check(
        actionBox !== null && stripBox !== null &&
          Math.abs(actionBox.y + actionBox.height - stripBox.y) <= 1,
        "the action bar did not stay attached to the strip after scrolling",
      );
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 780 });
        // A resize is a layout, not a render; give it one.
        await page.waitForTimeout(300);
        const over = await sidewaysOverflow(page);
        check(over.length === 0, `at ${width}px: ${over.join("; ")}`);
        const laid = await overlappingRows(page);
        check(
          laid.length === 0,
          `at ${width}px rows overlap: ${laid.join("; ")}`,
        );
      // Every id on screen is one line, whole, scrollable
        // to its end, and focusable so a keyboard can do the scrolling.
        const ids = await unreadableIdentifiers(page);
        check(ids.length === 0, `at ${width}px: ${ids.join("; ")}`);
        await shot(page, `mobile-${width}-settings`);
        if (width === 390) {
          const name = drawer(page).locator("label").filter({
            hasText: /^device petname$/,
          }).locator("input");
          await name.fill("mobile draft");
          await shot(page, "mobile-action-bar-dirty");
          await drawer(page).getByRole("button", {
            name: "Revert",
            exact: true,
          }).click();
          await shot(page, "mobile-action-bar-clean");
        }
        const action = await drawer(page).locator("#visor-actions")
          .boundingBox();
        const anchor = await strip(page).boundingBox();
        check(
          action !== null && anchor !== null &&
            Math.abs(action.y + action.height - anchor.y) <= 1,
          `at ${width}px the action bar detached from the strip`,
        );
      }

      const shown = devicesSheet(page).locator("#visor-endpoint-id");
      eq(await shown.textContent(), id, "the endpoint id was truncated");
      // A named member intentionally shows its device-specific label instead
      // of duplicating the endpoint id.
    },
  },

  {
    // Retained accessibility contracts: readable text at every selectable
    // hue and active controls at least 44px on both axes.
    name: "visor-contrast-and-touch",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await page.setViewportSize({ width: 390, height: 780 });
      await openSettingsSheet(page);
      const glyphTile = drawer(page).getByRole("button", {
        name: "Choose your glyph",
        exact: true,
      });
      await glyphTile.click();
      const picker = drawer(page).locator(".glyph-picker");
      await picker.getByRole("searchbox", {
        name: "Enter glyph or search",
      }).fill("A");
      await picker.getByRole("button", { name: "Use A", exact: true }).click();
      await saveDraft(page);
      await page.waitForFunction(
        () => document.querySelector("#visor-circle")?.textContent === "A",
      );
      const painted = await page.locator("#visor-root").getAttribute("style");
      const worst = new Map<string, number>();
      const wheel: Array<number | "unclaimed"> = ["unclaimed"];
      for (let h = 0; h < 360; h++) wheel.push(h);
      for (const hue of wheel) {
        for (
          const [what, ratio] of Object.entries(await inkContrast(page, hue))
        ) {
          const key = `${what} @${hue}`;
          if (ratio < (worst.get(key) ?? Infinity)) worst.set(key, ratio);
        }
      }
      check(worst.size > 20, `only ${worst.size} pieces of text were measured`);
      const failing = [...worst].filter(([, r]) => r < 4.5)
        .sort((a, b) => a[1] - b[1]);
      check(
        failing.length === 0,
        `${failing.length} text(s) below 4.5:1, worst ${
          failing.slice(0, 4).map(([k, r]) => `${k} = ${r.toFixed(2)}`).join(
            "; ",
          )
        }`,
      );
      await page.locator("#visor-root").evaluate(
        (el, style) => el.setAttribute("style", style ?? ""),
        painted,
      );
      let small = await undersizedControls(page);
      check(
        small.length === 0,
        `mobile under touch floor: ${small.join("; ")}`,
      );
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);
      small = await undersizedControls(page);
      check(
        small.length === 0,
        `desktop under touch floor: ${small.join("; ")}`,
      );
    },
  },

  {
    // The strip must stay wholly inside the viewport, with room for the
    // app below it, at handheld sizes. Emulated viewports only: Playwright
    // never collapses or expands a physical browser toolbar, so this says
    // nothing about that — only that the layout survives a small viewport.
    name: "android-visor-band",
    async run(_ctx, origin, browser) {
      const ctx = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        viewport: { width: 390, height: 844 },
      });
      try {
        const page = await open(ctx, origin);
        await visorReady(page);
        await paneSettled(page);

        await launchTodoMvc(page);

        for (
          const [width, height] of [
            [390, 844],
            [360, 640],
            [320, 480],
            [844, 390], // Short landscape.
          ]
        ) {
          await page.setViewportSize({ width, height });
          // Idempotent: pressing the strip's app half is never a toggle
          // (visor/src/state.rs `Action::Show`), so this opens the drawer
          // on the app's own sheet the first time and re-settles it after
          // each resize.
          await toAppSheet(page);
          await paneSettled(page);
          await page.waitForFunction(
            () =>
              document.getAnimations().every((a) => a.playState === "finished"),
            undefined,
            { timeout: 10_000 },
          );

          const strip = await page.locator("#visor-strip").boundingBox();
          check(strip !== null, `${width}x${height}: #visor-strip has no box`);
          check(
            strip.y >= -0.5 && strip.y + strip.height <= height + 0.5 &&
              strip.height > 0,
            `${width}x${height}: the strip is not wholly on screen: ${
              JSON.stringify(strip)
            }`,
          );

          const zone = await page.locator("#app-zone").boundingBox();
          check(zone !== null, `${width}x${height}: #app-zone has no box`);
          check(
            Math.abs(zone.y + zone.height - height) <= 1,
            `${width}x${height}: #app-zone bottom is ${
              zone.y + zone.height
            }, want ${height}`,
          );
          check(
            zone.height > 0,
            `${width}x${height}: no room at all below the strip`,
          );

          const overflowed = await page.evaluate(
            () =>
              document.documentElement.scrollHeight >
                document.documentElement.clientHeight,
          );
          check(
            !overflowed,
            `${width}x${height}: the shell scrolls vertically`,
          );

          // Short landscape is where the drawer's cap bites hardest: prove
          // the pane actually scrolls a real control into view, not merely
          // that its computed style says it could.
          if (width === 844 && height === 390) {
            const install = drawer(page).getByRole("button", {
              name: "Install as app",
            });
            await install.scrollIntoViewIfNeeded();
            const box = await install.boundingBox();
            const panel = await content(page).boundingBox();
            check(box !== null && panel !== null, "no box to check scroll");
            check(
              box.y >= panel.y && box.y + box.height <= panel.y + panel.height,
              `"Install as app" did not scroll into the pane: ${
                JSON.stringify({ box, panel })
              }`,
            );
          }

          if (width === 320 || width === 390) {
            await shot(page, `android-band-${width}x${height}`);
          }
        }
      } finally {
        await ctx.close();
      }
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
  // ONE fake for the whole run, deliberately: the store is the user's own
  // Drive account, and two devices of one group reaching the same account
  // is what the round-trip scenario turns on. Objects a previous scenario
  // pushed stay visible — under names derived from THAT group's key, which
  // is precisely the isolation the round-trip asserts, so a shared fake
  // makes that assertion stronger rather than weaker.
  const drive = startFakeDrive();
  console.log(`e2e: fake drive at ${drive.url}`);
  const buildDigests = await currentBuildDigests();
  const dist = await stageSite(relay.url, drive.url);
  const server = serve(dist);
  console.log(`e2e: serving ${dist} at ${server.origin}`);
  await verifyServedBuild(server.origin, buildDigests);
  const planned = selectedScenarios(scenarios);
  console.log(`e2e: running ${planned.map((scenario) => scenario.name).join(", ")}`);
  let browser: Browser | undefined;
  let failures = 0;
  try {
    // Playwright defaults to --disable-dev-shm-usage, which redirects
    // Chromium's shared-memory files into /tmp. Some development containers
    // have a large /dev/shm but a nearly-full /tmp; opt into Chromium's native
    // Linux shared-memory path for those environments.
    browser = await chromium.launch({
      ignoreDefaultArgs: Deno.env.get("E2E_DEV_SHM") === "1"
        ? ["--disable-dev-shm-usage"]
        : undefined,
    });
    for (const scenario of planned) {
      // A fresh context per scenario: a device is per browser context, so
      // scenarios must not inherit each other's IndexedDB or SharedWorker.
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(30_000);
      ctx.setDefaultNavigationTimeout(30_000);
      const t0 = performance.now();
      try {
        await withScenarioTimeout(
          scenario.name,
          120_000,
          scenario.run(ctx, server.origin, browser, drive),
        );
        console.log(
          `ok   ${scenario.name} (${(performance.now() - t0).toFixed(0)}ms)`,
        );
      } catch (err) {
        failures++;
        console.error(`FAIL ${scenario.name}: ${(err as Error).message}`);
        const dir = Deno.env.get("VISOR_SHOTS");
        if (dir !== undefined) {
          await Deno.mkdir(dir, { recursive: true });
          for (const [index, page] of (browser?.contexts().flatMap((c) => c.pages()) ?? []).entries()) {
            await withTimeout(
              5_000,
              `failure screenshot ${scenario.name}-${index}`,
              page.screenshot({ path: join(dir, `${scenario.name}-fail-${index}.png`) }),
            ).catch(() => {});
          }
        }
        // What the visor was showing when the wait gave up, per open page —
        // EVERY context, not just this scenario's own: a scenario with a
        // second device fails at that device as often as at this one, and
        // dumping only `ctx` prints nothing when the failure is over there.
        for (
          const page of browser?.contexts().flatMap((c) => c.pages()) ?? []
        ) {
          const dump = await dumpPage(page);
          console.error(`  page ${page.url()}: ${JSON.stringify(dump)}`);
        }
      } finally {
        await closeContext(ctx, scenario.name);
      }
    }
  } finally {
    await closeBrowser(browser);
    await server.stop();
    await drive.stop();
    await relay.stop();
    await Deno.remove(dist, { recursive: true }).catch(() => {});
  }
  if (failures > 0) {
    console.error(`e2e: ${failures} scenario(s) failed`);
    Deno.exit(1);
  }
  console.log(`e2e: ${planned.length} scenario(s) passed`);
}

await main();
