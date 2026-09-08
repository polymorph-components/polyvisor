// The M1 gates on real Chromium (docs/design.md "Delivery": "Playwright on
// real Chromium for every claim about pixels or realms", and "M1": "app
// renders in the opaque frame; zero network requests from the frame; no
// JSPI").
//
// The server sets neither COOP nor COEP: a SharedWorker needs none, and
// setting them would make this harness diverge from what a home origin
// actually serves.

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
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
// Every selector and every label below is the visor's own tree (visor/src/
// ui.rs): `#visor-root` carrying `.unclaimed` until the device is open and
// the `--hue` inline style when it is (nothing else ever paints it),
// `#visor-strip` with its two halves `#visor-app` and `#visor-self`,
// `#visor-drawer` holding one `.pane` per tenant, `.sheet` / `.sheet-error`
// / `.app-row` / `.device-row`. They live in one block so a visor rename is
// one edit here rather than six.
//
// The drawer is no longer a toggle: with nothing running it is pinned open
// on the app list, so "close" means "back to the app list" and pressing the
// half whose sheet is already showing does nothing at all.
// ---------------------------------------------------------------------------

const strip = (page: Page) => page.locator("#visor-strip");
const drawer = (page: Page) => page.locator("#visor-drawer");
/** The strip's left half: what is running (the app list, or the running
 * app's own sheet). */
const appsButton = (page: Page) => page.locator("#visor-app");
/** The strip's right half: who this is, and this device's settings. */
const settingsButton = (page: Page) => page.locator("#visor-self");

/** Wait for the drawer to hold exactly one pane, done sliding and not on its
 * way out.
 *
 * A tenant switch renders two panes for the length of the slide — the one
 * arriving still wearing an `enter-` class — and a click into a moving
 * target lands wherever the animation had got to. A drawer in mid-close is
 * one pane and no `enter` class, so "settled" has to exclude `closing` too
 * (visor/src/ui.rs `drawer_class`) or this passes on a pane that is
 * leaving. */
async function paneSettled(page: Page): Promise<void> {
  await drawer(page).waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const d = document.querySelector("#visor-drawer");
      if (d === null || d.className.includes("closing")) return false;
      const panes = d.querySelectorAll(".pane");
      return panes.length === 1 &&
        !(panes[0] as HTMLElement).className.includes("enter");
    },
    undefined,
    { timeout: 10_000 },
  );
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
    // The frame is not the end of the launch: the visor closes the drawer
    // over it (visor/src/ui.rs `apply`, the `(Some(t), None)` arm), and that
    // close outlives the frame's arrival — first as an open drawer whose
    // `closing` render has not landed yet, then as a mounted `closing`
    // drawer, which is `inert` and so hands every press to the scrim
    // underneath. Returning inside that window makes the caller press a
    // drawer that is on its way out. `Drawer::Closed` unmounts the element,
    // so its absence is the visor's own statement that the launch is over.
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
 * The button disables itself exactly when `draft == seed`, and the seed
 * only catches up once every kernel call the save made has come back
 * (visor/src/ui.rs `save_draft`) — so this is the one observable that says
 * the device, and not merely the screen, has the new value. Reloading
 * without it races the checkpoint.
 */
async function saveDraft(page: Page): Promise<void> {
  await drawer(page).getByRole("button", { name: "Save", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      const save = Array.from(
        document.querySelectorAll("#visor-drawer button"),
      ).find((b) => b.textContent === "Save") as HTMLButtonElement | undefined;
      return save !== undefined && save.disabled;
    },
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Raise the running app's own sheet, from wherever the drawer is.
 *
 * Not by pressing the strip's app half from another pane. With a session
 * running, every pane offers "Return to app" and that is the supported way
 * out (visor/src/ui.rs `dismissal`); pressing the half for the tenant
 * already on screen is worse than useless, since a dirty draft parks the
 * transition and the dialog that raises makes the strip `inert` — after
 * which no press can land at all.
 */
async function toAppSheet(page: Page): Promise<void> {
  // Settled first. A drawer in mid-close is `inert`, and so is one under
  // the dialog (visor/src/ui.rs, `flag(confirming || shutting)`): its
  // buttons take no press and the scrim behind takes it instead.
  await page.waitForFunction(
    () => {
      const d = document.querySelector("#visor-drawer");
      return d === null || !d.hasAttribute("inert");
    },
    undefined,
    { timeout: 15_000 },
  );
  const back = drawer(page).getByRole("button", {
    name: "Return to app",
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
 * The running app's own glyph (`device.meta`, `meta-scope.app`), typed and
 * SAVED — which is the value an install is allowed to paint with.
 *
 * The app sheet carries no `Save` of its own: the draft it writes into is
 * the same one the settings sheet saves, so the save here is the "unsaved
 * changes" dialog that guards the transition away from a dirty sheet
 * (visor/src/ui.rs `#visor-confirm`). Returns once the app sheet, reopened,
 * shows the value read back off the kernel (`read_app_meta`) — so a caller
 * that installs next is installing against a saved map, not a draft.
 */
async function setAppGlyph(page: Page, glyph: string): Promise<void> {
  await toAppSheet(page);
  // `^glyph$`: the settings sheet's field is "your glyph", and this is the
  // app sheet's.
  const field = drawer(page).locator("label").filter({ hasText: /^glyph$/ })
    .locator("input");
  await field.waitFor({ timeout: 10_000 });
  // Typed until it stays typed. Unlike the settings sheet, the app sheet
  // seeds its draft from a kernel read that lands AFTER the pane is on
  // screen (visor/src/ui.rs: the `AppInfo` arm spawns `read_app_meta` and
  // calls `seed_draft` only when it comes back), so a glyph typed the
  // instant the pane settles can be wiped by that seed arriving — leaving a
  // clean draft, no "unsaved changes" dialog, and nothing saved. The seed
  // happens once per transition, so this converges immediately.
  const deadline = performance.now() + 15_000;
  for (;;) {
    await field.fill(glyph);
    await page.waitForTimeout(300);
    if (await field.inputValue() === glyph) break;
    check(
      performance.now() < deadline,
      "the app sheet's glyph field would not hold a value",
    );
  }
  await settingsButton(page).click();
  const confirm = page.locator("#visor-confirm");
  await confirm.waitFor({ timeout: 10_000 });
  await confirm.getByRole("button", { name: "Save", exact: true }).click();
  // The dialog clears the moment it is answered, but the save it asked for
  // is async and the parked transition is taken only once that save lands
  // (visor/src/ui.rs `save_now`). The settings pane the dialog was guarding
  // is therefore the observable that says the kernel has the glyph:
  // navigating on the dialog's disappearance alone races the save, finds
  // the draft still dirty, and parks the next transition behind a second
  // dialog that nothing can then dismiss.
  await confirm.waitFor({ state: "detached", timeout: 15_000 });
  await drawer(page).locator("label").filter({ hasText: /^device petname$/ })
    .waitFor({ timeout: 15_000 });
  await paneSettled(page);
  await toAppSheet(page);
  await page.waitForFunction(
    (want) => {
      const label = Array.from(
        document.querySelectorAll("#visor-drawer label"),
      ).find((l) => l.querySelector("span")?.textContent === "glyph");
      const input = label?.querySelector("input") as
        | HTMLInputElement
        | undefined;
      return input?.value === want;
    },
    glyph,
    { timeout: 15_000 },
  );
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
      return { status: res.status, type, width: 0, height: 0, ink: 0, corner: none };
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

/**
 * The measured contrast of every piece of text on screen at one point on the
 * hue wheel, as WCAG ratios keyed by a description of the element.
 *
 * Measured, not computed: the sheet states `oklch`, and what a ratio is
 * depends on how Chromium maps that into sRGB. So every colour goes through
 * a 1×1 canvas — the browser's own parser and gamut mapping — and the
 * translucent layers are composited there before anything is measured.
 *
 * `hue` drives the stylesheet's two arms directly; which arm a real visor
 * takes is the anchor rule, which `claimed()` tests.
 */
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
    /** Everything painted under `el`, its own background included, flattened
     * onto the page's white. */
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
      // Leaves only: a container's own `color` is not what is drawn.
      if (text === "" || el.querySelector("*") !== null) continue;
      if (el.closest("[inert]") !== null) continue;
      if (el.getClientRects().length === 0) continue;
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

/** Every control below the 44px touch floor, on either axis. */
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

/** Is every long machine identifier still wholly readable — one line high,
 * scrollable to its own end, and reachable by keyboard to do it? Chromium
 * focuses overflowing scroll containers without a `tabindex`, which is what
 * makes the local scroll usable at all; recent enough to be worth checking
 * rather than assuming. */
function unreadableIdentifiers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (
      const el of document.querySelectorAll<HTMLElement>(
        "#visor-root .endpoint-id",
      )
    ) {
      const where = `${el.id || "a member/peer id"}`;
      const style = getComputedStyle(el);
      if (style.overflowX !== "auto") {
        bad.push(`${where}: overflow-x is ${style.overflowX}`);
      }
      const lines = Math.round(
        el.getBoundingClientRect().height / parseFloat(style.lineHeight),
      );
      if (lines !== 1) bad.push(`${where} is ${lines} lines high`);
      if (el.scrollWidth <= el.clientWidth) continue; // nothing to scroll
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
    const pane = document.querySelector<HTMLElement>("#visor-drawer .pane");
    if (pane !== null && pane.scrollWidth > pane.clientWidth) {
      bad.push(
        `the drawer scrolls sideways: ${pane.scrollWidth} > ${pane.clientWidth}`,
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
  await page.waitForTimeout(400);
  await Deno.mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

// ---------------------------------------------------------------------------
// Devices, as these scenarios drive it
//
// Everything here is shaped by one fact about the visor: it holds no state
// of its own and no timer exists in its world (visor/src/ui.rs), so nothing
// on screen refreshes on its own. `device.status`, `sync.peers`,
// `sync.members` and `pairing.status` are read on the press that opens the
// Settings tenant and on the Devices section's own "Refresh" button — so
// pressing Refresh is how this harness re-reads any of them. That is not a
// workaround for a missing feature; polling chrome is a thing the milestone
// deliberately does not have.
//
// Pairing phases are the exception, and they are not a press: the kernel
// pushes `events.pairing-changed` on every transition and the runtime's
// `events.next` parks, so a phase the OTHER device caused reaches this
// screen with nothing pressed here (internal.wit `interface events`). The
// scenarios below therefore wait on those without pressing Refresh, which
// is what makes them exercise the push path at all.
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
      await devicesSheet(page).locator(".member-row").filter({ hasText: peer })
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
// The section is Settings → "Storage" (visor/src/ui.rs `StorageSection`),
// and like everything else in that drawer it is only ever as fresh as the
// press that read it: the state line comes from `storage.status`, re-read
// on the press that opens Settings and after every act in the section.
//
// The ceremony runs headless. "Connect Google Drive" opens a popup at the
// URL the kernel minted; the fake's `/auth` 302s straight back to this
// page's URL with `code` and `state`, that returning load broadcasts the
// pair on the ceremony's BroadcastChannel and closes itself (web/boot.ts —
// the popup is opened `noopener`, so there is no opener to post to), and the
// waiting `shell.open-popup` resolves with it. No consent screen to click.
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
 * Two things have to happen and neither is automatic here: a pull, which is
 * the "Sync now" press, and a re-read by the app, which is the remount
 * (`polyvisor:app/tasks` is pull-only and the guest re-reads at mount).
 */
async function pullUntilTodo(page: Page, title: string): Promise<void> {
  const deadline = performance.now() + 120_000;
  for (;;) {
    await syncNow(page);
    await new Promise((r) => setTimeout(r, 2_000));
    await remountTodoMvc(page);
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
 * a fresh `tasks.items` read. A reload with the app open leaves `#app/<token>`
 * in the URL, and the visor auto-restores whatever fragment it finds after
 * boot (docs/design.md "Routing"), so this — and every other
 * reload-with-the-app-open site below — waits for that restore rather than
 * pressing "Apps" itself, which would race the visor's own click. With no
 * app open (a page that arrived at the bare origin) there is no fragment,
 * and the press is the only way. */
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
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      const strip = page.locator("#visor-strip");
      const box = await strip.boundingBox();
      check(box !== null, "#visor-strip has no box");
      eq(box!.height, 56, "#visor-strip height");
      // The strip says "waking" until `device.status` answers over the
      // worker port; the placeholder is the first kernel-backed pixel, and
      // it is the right half — the one that speaks for this device.
      await page.locator("#visor-self").getByText("this device").waitFor({
        timeout: 10_000,
      });
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

      // ONE tab, on purpose. M1 kept a second page open so the SharedWorker
      // would outlive the reload; M2's claim is the stronger one
      // (docs/design.md "Devices"): "the worker respawns on every single-tab
      // reload — checkpoint + rehydrate, not worker-memory luck". A second
      // tab here would hide exactly the failure this scenario is for.
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
      // A device with no route key yet mints one on its first encode
      // (README/dispatch: "minted on first use"); "kept" is not what that
      // needs, but every other scenario that leans on a device surviving
      // more than one page is kept first, and this one reloads twice.
      await keepDevice(page, "the workbench");
      await launchTodoMvc(page);
      // TodoMVC's footer — and the filter links in it — only renders with
      // at least one todo (apps/todomvc/src/lib.rs: the footer is gated on
      // `!items.read().is_empty()`), and the todo persists on this device,
      // so one add here is enough for the reopened app in step (c) too.
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

      // Closing the session is the glue's own act of clearing the bar
      // (internal.wit `shell`: "clears it in close-frame") — no navigation
      // involved, so this is the one place that is not also covered by the
      // notice-only checks below. The strip's left half opens the running
      // app's sheet, and "Close app" is in there.
      await page.locator("#visor-app").click();
      await paneSettled(page);
      await drawer(page).getByRole("button", { name: "Close app", exact: true })
        .click();
      await page.waitForFunction(
        () => location.hash === "",
        undefined,
        { timeout: 10_000 },
      );

      // A fragment that is not a token this device's route key sealed:
      // `not-found`, and the visor says so in its own voice rather than
      // opening anything. `goto` to a URL that differs only in its fragment
      // is a same-document navigation — no boot, and the visor ignores
      // `hashchange` by ruling (docs/design.md "Routing") — so the reload
      // is what makes this a bookmark being opened rather than a bar edit.
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
    // The case the per-tab anchor used to break (docs/design.md "Devices",
    // last bullet): a bookmark opened in a genuinely fresh tab — no
    // sessionStorage anchor, because Chromium only copies that on
    // duplicate/`window.open`, not on a plain navigation to a URL typed or
    // clicked elsewhere. Before LAST, this minted a brand-new device with
    // no route key, so the token could never decrypt. With LAST, the fresh
    // tab adopts the profile's kept device and the bookmark just opens.
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

      // "★" and not an emoji: a colour emoji font ignores the white fill
      // the pixel checks below look for. Two typed, one drawn — the icon
      // must agree with the strip's first-`char` rule.
      await setAppGlyph(page, "★x");

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
        !icons.some((i) => i.src.includes("★")),
        "the glyph must not appear literally in an icon URL",
      );

      const bySize = new Map(icons.map((i) => [i.sizes, i.src]));
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
      check(after !== null, "#visor-strip lost its box");
      eq(after!.height, 56, "#visor-strip height");

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
      // device: `device.status` wrote LAST when this device was kept above
      // (docs/design.md "Devices", last bullet), and it is still there.
      // `deviceId` adopts it, so this reload is the SAME device and the
      // picker never appears at all.
      await page.evaluate((key) => sessionStorage.removeItem(key), ANCHOR);
      await page.reload();
      await visorReady(page);
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      eq(
        await drawer(page).locator(".device-row").count(),
        0,
        "a lost anchor with a kept LAST device showed the picker anyway",
      );

      // Now drop LAST too: an explicit new device, per the design's "only a
      // profile with no kept device ... mints". This is exactly what
      // `shell.switch-device(none)` does; doing it here rather than through
      // a button keeps this scenario to what the WIT guarantees, so it does
      // not depend on which control the visor happens to offer for a
      // second device.
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

        // B presses "No" — `pairing.cancel` (runtime/crates/kernel/src/
        // pairing.rs `pairing_cancel`). The canceller's own phase goes
        // straight to `Idle` (pairing.rs:220 `set_phase(Phase::Idle)`); it
        // is the OTHER side that lands on a `Failed` phase, from whichever
        // race it sees first: the Cancel frame itself (`cancelled()`,
        // pairing.rs:664, "the other device cancelled") or the transport
        // closing ahead of it (pairing.rs:668, "the other device went
        // away") — both are the kernel's own words for "the other side is
        // gone", so both count.
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

        // The canceller (B) lands on `Idle` too, same as pairing.rs:220 —
        // its offer/claim controls are back, not stuck mid-ceremony.
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
    // the SAME group pulls — with no live connection between them.
    //
    // Two claims, and the scenario is arranged around keeping each of them
    // from being answered by the other path:
    //
    //   * ISOLATION. B, connected to the same Drive account but not in A's
    //     group, has a different naming key, so every object A wrote sits
    //     at a name B cannot derive. It sees nothing of A's. Asserted
    //     while the two are unpaired, so no live path exists at all.
    //   * THE STORE CARRIES. Pairing does bring a live path up, and it is
    //     fast — so the todo this claim turns on is written while B's page
    //     is CLOSED (no page, no worker, no endpoint), and A is gone
    //     entirely before B comes back. The fake's `alt=media` counter is
    //     the corroboration: B read objects out of the store, which a
    //     device that converged over the wire never does.
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
        // A remount is a fresh `tasks.items` read (the app polls; nothing
        // pushes into a mounted frame), so this is B looking as hard as it
        // can.
        await remountTodoMvc(b);
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

        // B goes offline: navigating the tab away takes its SharedWorker
        // with it (a worker lives while a client holds it), and with the
        // worker goes the endpoint A could reach B on. Its device survives
        // — the OPFS and the sealed tokens are the context's.
        //
        // NAVIGATED, not closed, and this is the whole reason: the device
        // anchor is `sessionStorage` (web/boot.ts), which is per TAB — but
        // a second tab is no longer reliably a second device (docs/design.md
        // "Devices", last bullet): B here is ephemeral, so its LAST pointer
        // was never written and a second tab would still mint fresh, but a
        // KEPT device's second tab would instead ADOPT it — same group,
        // same tokens, B's own worker still up. Closing this tab is
        // therefore not a dependable way to take B offline for either case;
        // navigating it away is, because it is the same client dropping
        // its hold on B's SharedWorker (a worker lives while a client holds
        // it) regardless of what any other tab would resolve to.
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
      const confirm = page.locator("#visor-confirm");

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
      // device nobody has named is nothing.
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
      eq(await field.inputValue(), "", "Revert kept the abandoned draft");

      // Saved, and it is the kernel that remembers it: a reload has no
      // draft at all, and reads the name back off the device.
      await field.fill("the workbench");
      await saveDraft(page);
      await page.reload();
      await visorReady(page);
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });
      await openSettingsSheet(page);
      eq(
        await field.inputValue(),
        "the workbench",
        "the saved device petname did not survive a reload",
      );

      // The user's own labels ride in the same draft and land on the strip:
      // the petname in the right half's top line, and the glyph — of which
      // only the first character is ever drawn — in the circle.
      await drawer(page).locator("label").filter({ hasText: /^your petname$/ })
        .locator("input").fill("ada");
      await drawer(page).locator("label").filter({ hasText: /^your glyph$/ })
        .locator("input").fill("🜁x");
      await saveDraft(page);
      await page.waitForFunction(
        () => document.querySelector("#visor-circle")?.textContent === "🜁",
        undefined,
        { timeout: 10_000 },
      );
      await page.locator("#visor-self").getByText("ada").waitFor({
        timeout: 10_000,
      });
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
      // Both realms on this side instantiated, and every `instantiate` call
      // in the repository — visor, frame and worker alike — passes
      // `{ jspi: false }` (web/jspi_test.ts pins that at the source level).
      // Under that option polyengine refuses a sync-typed import that
      // returns a Promise, so the visor having rendered its strip and the
      // worker having answered `booted` — which needs the runtime
      // component's exports, and its endpoint's in-guest signer — proves no
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
        await focusIn(page, "#visor-drawer .pane"),
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
        await drawer(page).locator(".pane-dismiss").textContent(),
        "Return to app",
        "the running app's sheet offered no way back to it",
      );

      // Escape is that button by another name, and the caret goes back to
      // the half of the strip that raised the pane.
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
        await focusIn(page, "#visor-drawer .pane"),
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
          await drawer(page).locator(".pane-dismiss").count(),
          0,
          "the resting app list offered a dismissal to nowhere",
        );

        await settingsButton(page).focus();
        await page.keyboard.press("Enter");
        await paneSettled(page);
        eq(
          await drawer(page).locator(".pane-dismiss").textContent(),
          "Back to apps",
          "a pinned settings sheet offered no way back",
        );
        check(
          await focusIn(page, "#visor-drawer .pane"),
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
          await focusIn(page, "#visor-drawer .pane"),
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
      eq(
        await drawer(page).locator(".pane").getAttribute("aria-label"),
        "settings",
        "Escape took the transition it was asked about",
      );

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
        await focusIn(page, "#visor-drawer .pane"),
        `Revert left the keyboard at ${await focused(page)}`,
      );

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
        await focusIn(page, "#visor-drawer .pane"),
        `Save left the keyboard at ${await focused(page)}`,
      );
      await strip(page).getByText("the workbench").waitFor({ timeout: 15_000 });

      // With an app running there is a scrim as well, and it is a press
      // target: pressing it while the dialog stands used to replace the
      // parked transition, so "Revert" closed the drawer instead of opening
      // the sheet the user had actually asked for.
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
      eq(
        await drawer(page).locator(".pane").getAttribute("aria-label"),
        "the running app",
        "the scrim press replaced the transition the dialog was asked about",
      );
    },
  },

  {
    // Two handheld widths. The Devices section is long machine identifiers
    // next to short framework-voice facts about them, which is the shape
    // that used to lay one over the other. Nothing may be answered by
    // hiding: the whole identifier stays readable, in its own local scroll,
    // while neither the page nor the drawer scrolls sideways.
    name: "visor-narrow-layout",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      // A person's own words, at the length people use.
      await setDeviceName(page, "Ada's very own workbench in the back room");
      await drawer(page).locator("label").filter({ hasText: /^your petname$/ })
        .locator("input").fill("Ada Lovelace-Byron the Elder");
      await saveDraft(page);

      // The unnamed case is the one that overlapped: with no petname, a
      // device is shown by its endpoint id — tens of characters of machine
      // text beside "this device" and an age.
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
        // Every id on screen — this device's endpoint, and the same id
        // again as the unnamed member row — is one line, whole, scrollable
        // to its end, and focusable so a keyboard can do the scrolling.
        const ids = await unreadableIdentifiers(page);
        check(ids.length === 0, `at ${width}px: ${ids.join("; ")}`);
        await shot(page, `mobile-${width}-settings`);
      }

      const shown = devicesSheet(page).locator("#visor-endpoint-id");
      eq(await shown.textContent(), id, "the endpoint id was truncated");
      check(
        await shown.evaluate((el) => el.scrollWidth > el.clientWidth),
        "at 320px the endpoint id fits, so this proves nothing about the " +
          "local scroll it is supposed to have",
      );
      eq(
        await devicesSheet(page).locator(".member-row .endpoint-id").count(),
        1,
        "no unnamed member id was on screen to check",
      );
    },
  },

  {
    // The strip stays saturated by ruling, so its text carries the whole
    // burden of being readable — at every hue a user can pick, and in the
    // grey the visor wears before it is claimed.
    name: "visor-contrast-and-touch",
    async run(ctx, origin) {
      const page = await open(ctx, origin);
      await visorReady(page);
      await page.setViewportSize({ width: 390, height: 780 });
      await openSettingsSheet(page);
      // A glyph, saved: with no glyph the circle has no text, and the
      // contrast sweep below only measures leaves with some — the circle
      // must carry one to be in scope for it at all. Which is the point of
      // saving it here: the circle is a medium-dark plate under light ink
      // (visor/src/style.rs `#visor-circle`, `--strip-edge`), so the sweep
      // has to answer for that pairing at every hue like any other text.
      await drawer(page).locator("label").filter({ hasText: /^your glyph$/ })
        .locator("input").fill("A");
      await saveDraft(page);
      await page.waitForFunction(
        () => document.querySelector("#visor-circle")?.textContent === "A",
      );
      const circleStyle = await page.locator("#visor-circle").evaluate(
        (el) => {
          const s = getComputedStyle(el);
          return {
            w: s.width,
            h: s.height,
            fontSize: s.fontSize,
            lineHeight: s.lineHeight,
            fontWeight: s.fontWeight,
          };
        },
      );
      eq(
        circleStyle,
        {
          w: "32px",
          h: "32px",
          fontSize: "20px",
          lineHeight: "20px",
          fontWeight: "600",
        },
        "the circle's fixed geometry drifted",
      );
      // Self is selected right now (the settings sheet is open): a marker
      // along its bottom edge and no fill — unlike the app half's own
      // pressed dress, and out of the way of the circle beside it.
      const selfPressed = await page.locator("#visor-self").evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, shadow: s.boxShadow };
      });
      check(
        selfPressed.bg === "rgba(0, 0, 0, 0)" ||
          selfPressed.bg === "transparent",
        `self selected must have no fill, got ${selfPressed.bg}`,
      );
      // The offsets, not merely "some shadow": an outline on all four sides
      // is what this replaced, and it reads as a box around the identity.
      check(
        selfPressed.shadow.includes("inset") &&
          /(^|\s)0px -2px 0px(\s|$)/.test(
            selfPressed.shadow.replace(" inset", ""),
          ),
        `self selected must be marked along its bottom edge only, got ${selfPressed.shadow}`,
      );
      // The circle itself does not change with selection: same plate
      // whether settings is open or not.
      const circleSelected = await page.locator("#visor-circle").evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      await openApps(page);
      const circleUnselected = await page.locator("#visor-circle").evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      eq(
        circleSelected,
        circleUnselected,
        "the identity circle changed when settings opened",
      );
      // App selected keeps the existing light fill.
      const appPressed = await page.locator("#visor-app").evaluate((el) =>
        getComputedStyle(el).backgroundColor
      );
      check(
        appPressed !== "rgba(0, 0, 0, 0)" && appPressed !== "transparent",
        `app selected must keep its light fill, got ${appPressed}`,
      );
      await openSettingsSheet(page);
      // Both halves of the strip are on screen at once, self selected: the
      // ink above is unaffected by that, which is what the sweep below
      // relies on to speak for both halves alike.
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
      // Put the device's own colour back: the sweep drove the sheet
      // directly, and the rest of this is about the real visor.
      await page.locator("#visor-root").evaluate(
        (el, style) => el.setAttribute("style", style ?? ""),
        painted,
      );

      // The ring is drawn outside its control, so one colour works on the
      // strip and in the drawer alike.
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const s = getComputedStyle(a);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      check(
        ring.style !== "none" && ring.width >= 2,
        `the focus ring is ${JSON.stringify(ring)}`,
      );

      const small = await undersizedControls(page);
      check(small.length === 0, `under the touch floor: ${small.join("; ")}`);
      await shot(page, "mobile-390-settings-touch");

      // Desktop: the same floor, and fields that stay a field's width
      // rather than spanning the window.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);
      const wide = await undersizedControls(page);
      check(wide.length === 0, `under the touch floor: ${wide.join("; ")}`);
      const stretched = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement>("#visor-root input")]
          .filter((el) => el.getBoundingClientRect().width > 400)
          .map((el) =>
            `input[${el.type}] is ${
              el.getBoundingClientRect().width.toFixed(0)
            }px`
          )
      );
      check(
        stretched.length === 0,
        `fields span the window: ${stretched.join("; ")}`,
      );
      await shot(page, "desktop-settings");
    },
  },

  {
    // The drawer sizes itself in `svh`, capped so the app zone keeps room
    // below the strip on a handheld — see visor/src/style.rs #visor-drawer.
    // Playwright's mobile emulation never collapses a toolbar, so the CSSOM
    // check below is what this asserts about the *rule*, not the emulator.
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

        const rules = await page.evaluate(() => {
          const out: string[] = [];
          for (const sheet of Array.from(document.styleSheets)) {
            for (const rule of Array.from(sheet.cssRules)) {
              if (
                rule instanceof CSSStyleRule &&
                rule.selectorText === "#visor-drawer"
              ) out.push(rule.cssText);
              if (
                rule instanceof CSSMediaRule &&
                rule.conditionText.includes("600px")
              ) {
                for (const inner of Array.from(rule.cssRules)) {
                  out.push(inner.cssText);
                }
              }
            }
          }
          return out;
        });
        check(
          rules.length === 2,
          `expected 2 drawer rules, found ${rules.length}: ${
            rules.join(" | ")
          }`,
        );
        for (const rule of rules) {
          check(
            rule.includes("svh") && !/(?<!s)vh\b/.test(rule),
            `drawer rule does not size itself in svh: ${rule}`,
          );
        }
        const paneOverflowY = await page.evaluate(() =>
          getComputedStyle(document.querySelector("#visor-drawer .pane")!)
            .overflowY
        );
        eq(paneOverflowY, "auto", "the pane does not scroll its own content");

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
          eq(strip.height, 56, `${width}x${height}: #visor-strip height`);

          const zone = await page.locator("#app-zone").boundingBox();
          check(zone !== null, `${width}x${height}: #app-zone has no box`);
          check(
            Math.abs(zone.y + zone.height - height) <= 1,
            `${width}x${height}: #app-zone bottom is ${
              zone.y + zone.height
            }, want ${height}`,
          );
          if (height >= 152) {
            check(
              zone.height >= 96,
              `${width}x${height}: only ${
                zone.height.toFixed(0)
              }px below the strip`,
            );
          }

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
            const pane = await drawer(page).locator(".pane").boundingBox();
            check(box !== null && pane !== null, "no box to check scroll");
            check(
              box.y >= pane.y && box.y + box.height <= pane.y + pane.height,
              `"Install as app" did not scroll into the pane: ${
                JSON.stringify({ box, pane })
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
  const dist = await stageSite(relay.url, drive.url);
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
        await scenario.run(ctx, server.origin, browser, drive);
        console.log(
          `ok   ${scenario.name} (${(performance.now() - t0).toFixed(0)}ms)`,
        );
      } catch (err) {
        failures++;
        console.error(`FAIL ${scenario.name}: ${(err as Error).message}`);
        // What the visor was showing when the wait gave up, per open page:
        // the M3a flakes were diagnosed from exactly this line. EVERY
        // context, not just this scenario's own: a scenario with a second
        // device fails at that device as often as at this one, and dumping
        // only `ctx` prints nothing at all when the failure is over there.
        for (
          const page of browser?.contexts().flatMap((c) => c.pages()) ?? []
        ) {
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
    await drive.stop();
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
