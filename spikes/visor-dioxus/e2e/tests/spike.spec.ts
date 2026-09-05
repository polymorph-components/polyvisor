// The spike's E2E suite: the three imported interfaces wired for real, the
// foreign-sheet seam, and the geometry/height/announcement/arm gates
// ported from demo/e2e/scenarios/{strip-geometry,drawer-overflow,
// drawer-announcements}.ts (governing docs 3-4 of the dispatch).
//
// UNLIKE THE DEMO SUITE, there is no naming ceremony, no pairing, no entry
// — dispatch scope forbids building them — so every drawer sheet here is
// opened by calling `control` DIRECTLY (`exports[CONTROL_ID]`, typed as
// `Control`) rather than by clicking through app-rendered affordances. The
// three demo tenants (credentials/picker/settings) are registered by
// host/mount.ts right after mount.
//
// Build identity is checked FIRST, exactly as the skeleton's suite did: the
// harness page carries a stamp with the sha-256 of the component the build
// step produced, and this re-hashes the bytes the server actually
// returned. Without that, a colliding server from a sibling worktree would
// silently satisfy every other assertion.

import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { Control } from "../../host/mount.ts";

const BASE = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup did not run");
  return url;
};

/** The hue seeded into localStorage BEFORE boot, under the host's own
 * prefixed key. The guest never spells this key: it asks for slot `hue`
 * and host/mount.ts maps it. Must be a member of `state::VISOR_HUES` —
 * `claim()` re-rolls (and persists a fresh one) for anything outside that
 * palette, per component.rs's CONTRACT note on `committed_hue`. */
const SEEDED_HUE = 265;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((hue) => {
    localStorage.setItem("pm-spike-hue", String(hue));
  }, SEEDED_HUE);
  await page.goto(BASE());
  await page.waitForFunction(() => (globalThis as never as { __mounted?: boolean }).__mounted === true, undefined, {
    timeout: 30_000,
  });
});

// -- helpers ------------------------------------------------------------

/** Call a `control` method inside the page. `Control`'s methods are all the
 * host needs to name here; the WIT variant/record shapes (dispatch's
 * "Value mapping") are spelled by the small builders below. */
function ctl<K extends keyof Control>(
  page: Page,
  fn: K,
  ...args: Parameters<Control[K]>
): Promise<ReturnType<Control[K]>> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const control = (globalThis as any).__visor.control;
      return control[fn](...args);
    },
    { fn: fn as string, args: args as unknown[] },
  );
}

/** `variant context`'s `panel` case, carrying a `surface` record
 * (contract:"Value mapping" — variant lifts as `{kind, value}`, record as
 * a plain camelCase object). */
function panelCtx(petname: string) {
  return {
    kind: "panel",
    value: { name: "app", nickname: "todo", icon: "", isNew: false, petname },
  };
}
const noneCtx = { kind: "none" };
function closeReason(restoreContext: boolean) {
  return { restoreContext };
}

/** Poll-and-accumulate `#visor-live`, exactly as
 * demo/e2e/scenarios/drawer-announcements.ts's `recordLive` does: a live
 * region holds ONE string and the visor may write several sentences across
 * one gesture, so a single read is a coin flip. */
async function recordLive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g.__liveLog !== undefined) return;
    const log: string[] = [];
    g.__liveLog = log;
    const el = document.getElementById("visor-live");
    if (el === null) throw new Error("no #visor-live on this page");
    const push = () => {
      const t = el.textContent ?? "";
      if (t !== "" && log[log.length - 1] !== t) log.push(t);
    };
    push();
    new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
  });
}
function liveLog(page: Page): Promise<string[]> {
  return page.evaluate(() => ((globalThis as unknown as Record<string, unknown>).__liveLog as string[] ?? []).slice());
}
/** `#visor-live` is written as ONE atomic string per activation
 * (component.rs's `Visor::speak`): a close that resumes the occupant
 * underneath joins BOTH sentences with `". "` into a single log entry, so
 * a search has to look for the phrase inside entries, not for an entry
 * equal to it. Returns a total order across the whole log (entry index,
 * then offset within it) or `null`. */
function findSaid(log: string[], phrase: string): number | null {
  for (let i = 0; i < log.length; i++) {
    const idx = log[i].indexOf(phrase);
    if (idx !== -1) return i * 1_000_000 + idx;
  }
  return null;
}
async function waitSaid(page: Page, sentence: string): Promise<string[]> {
  await page.waitForFunction(
    (want: string) =>
      (((globalThis as unknown as Record<string, unknown>).__liveLog as string[]) ?? []).some((l) => l.includes(want)),
    sentence,
    { timeout: 10_000 },
  ).catch(async (e) => {
    const log = await liveLog(page);
    throw new Error(`#visor-live never said ${JSON.stringify(sentence)} (${e.message}); it said ${JSON.stringify(log)}`);
  });
  return await liveLog(page);
}

// -- (1) build identity ---------------------------------------------------

test("serves the build under test", async ({ page, request }) => {
  const stamp = await page.evaluate(
    () => (globalThis as never as { __buildStamp?: { componentSha256: string } }).__buildStamp,
  );
  expect(stamp?.componentSha256).toBeTruthy();

  const res = await request.get(`${BASE()}/visor-spike.component.wasm`);
  expect(res.status()).toBe(200);
  const served = createHash("sha256").update(await res.body()).digest("hex");
  expect(served).toBe(stamp!.componentSha256);
});

// -- (1b) the artifact's imported capabilities ----------------------------

/**
 * THE CAPABILITY SET IS AN ARTIFACT PROPERTY, SO ASSERT IT ON THE ARTIFACT.
 *
 * `wit/deps/polymorph-dioxus/world.wit` and `src/component.rs`'s `with:`
 * mappings are both source; what a host must actually grant is whatever
 * survives into the .wasm's import section, and the two can disagree
 * silently. They did at the fdc0d52 bump: the renderer's world gained
 * `head` and `history` WITHOUT a package-version bump, so nothing caught
 * the change by version — instantiation simply failed on the missing
 * import records.
 *
 * Both directions matter and both are asserted:
 *   - `head`/`history` PRESENT: the renderer provides `WitDocument` and
 *     `WitHistory` as root context unconditionally (polyengine-dioxus/
 *     src/driver.rs:258-269), so they are imported even though this spike
 *     renders no `<head>` element and runs no router. `host/mount.ts` must
 *     supply both or the mount dies.
 *   - `eval` ABSENT: the negative is the one that carries security weight.
 *     `eval` reaches the page's own realm, and the port measured that its
 *     one suspected customer (the pairing QR) did not need it (Cargo.toml
 *     carries the argument). A mapping in `component.rs` naming the
 *     interface is bookkeeping; an IMPORT would be a capability the host
 *     had to grant. Only this check tells the two apart.
 *
 * The same file the server serves — the build-identity gate above ties the
 * served bytes to this build's stamp.
 */
test("imports head and history, and does not import eval", () => {
  // `e2e/package.json` sets `"type": "module"`, so there is no `__dirname`
  // at runtime (TypeScript's node typings offer one regardless, which is how
  // a `__dirname` here type-checks and then fails when the test runs).
  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = join(here, "..", "..", "build", "visor-spike.component.wasm");
  const wit = execFileSync("wasm-tools", ["component", "wit", artifact], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });

  // Top-level world imports are one `  import <id>;` line each; matching the
  // whole line (rather than a substring) keeps an interface NAMED in a doc
  // comment from passing for an interface IMPORTED.
  const imports = new Set(
    wit.split("\n")
      .map((l) => /^\s*import\s+(\S+);\s*$/.exec(l)?.[1])
      .filter((id): id is string => id !== undefined),
  );

  expect(imports).toContain("polymorph:dioxus/head@0.6.0");
  expect(imports).toContain("polymorph:dioxus/history@0.6.0");
  expect([...imports].filter((id) => id.startsWith("polymorph:dioxus/eval"))).toEqual([]);
});

// -- (2) mounts, and the extra IMPORTED interfaces ------------------------

test("mounts and renders the real DOM", async ({ page }) => {
  await expect(page.locator("#visor-zone")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("mounted");
  expect(await page.evaluate(() => (globalThis as never as { __e2eErrors: string[] }).__e2eErrors)).toEqual([]);
});

test("guest calls the host's store.get during mount", async ({ page }) => {
  const calls = await page.evaluate(
    // deno-lint-ignore no-explicit-any
    () => (globalThis as any).__visor.store.calls,
  );
  expect(calls).toContainEqual({ op: "get", slot: "hue" });
});

test("control.committedHue returns the value seeded before boot, after claim", async ({ page }) => {
  // `committed-hue` is 0 until `claim()` runs (component.rs's CONTRACT
  // note) — the WIT world boots deferred, on purpose.
  await ctl(page, "claim");
  const hue = await ctl(page, "committedHue");
  expect(hue).toBe(SEEDED_HUE);
});

test("control.announce changes #visor-context .ctx-bottom", async ({ page }) => {
  await ctl(page, "announce", "hello", 0);
  await expect(page.locator("#visor-context .ctx-bottom")).toHaveText("hello");
});

// -- (3) the exported interface's naming --------------------------------

test("control appears on instance.exports under the verbatim WIT id", async ({ page }) => {
  const keys = await page.evaluate(
    // deno-lint-ignore no-explicit-any
    () => Object.keys((globalThis as any).__visor.exports),
  );
  expect(keys).toContain("polymorph:visor-spike/control@0.1.0");
  const fns = await page.evaluate(
    // deno-lint-ignore no-explicit-any
    () => Object.keys((globalThis as any).__visor.exports["polymorph:visor-spike/control@0.1.0"]),
  );
  expect(fns).toContain("announce");
  expect(fns).toContain("committedHue");
  expect(fns).toContain("listEvents");
});

// -- 3a. GEOMETRY, ported from demo/e2e/scenarios/strip-geometry.ts -------

const LONG_PETNAME = "the quarterly planning board for everyone";

interface Metrics {
  barInner: number;
  stripHeight: number;
  context: { w: number; h: number };
  identity: { w: number; h: number };
  gap: number;
  settingsBtn: { w: number; h: number };
  docOverflow: number;
  idLines: { scrollW: number; clientW: number }[];
  badge: boolean;
}

function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const strip = document.getElementById("visor-strip")!;
    const inner = strip.querySelector(".bar-inner") as HTMLElement;
    const context = document.getElementById("visor-context")!;
    const identity = document.getElementById("visor-identity")!;
    const btn = document.getElementById("visor-settings")!;
    // THE CONTENT BOX, not the border box — see strip-geometry.ts's own
    // note: `.bar-inner` carries horizontal padding and the 45/45/10 split
    // resolves against content width.
    const istyle = getComputedStyle(inner);
    const innerContent = inner.clientWidth - parseFloat(istyle.paddingLeft) - parseFloat(istyle.paddingRight);
    const cr = context.getBoundingClientRect();
    const idr = identity.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      barInner: innerContent,
      stripHeight: strip.getBoundingClientRect().height,
      context: { w: cr.width, h: cr.height },
      identity: { w: idr.width, h: idr.height },
      gap: idr.left - cr.right,
      settingsBtn: { w: br.width, h: br.height },
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      idLines: Array.from(document.querySelectorAll("#visor-identity .id-lines .who")).map((e) => ({
        scrollW: (e as HTMLElement).scrollWidth,
        clientW: (e as HTMLElement).clientWidth,
      })),
      badge: btn.querySelector(".visor-badge") !== null,
    };
  });
}

async function seedGeometryFixture(page: Page): Promise<void> {
  // Identity + a pathological petname on the strip's context, plus one
  // UNSEEN event so the badge is LIT for every measurement (#132's
  // zero-layout-shift promise, taken with the dot actually rendered).
  await ctl(page, "claim");
  await ctl(page, "saveIdentity", {
    name: "Ada Lovelace-Byron the Countess",
    device: "the study PC under the stairs",
    icon: "",
  });
  await ctl(page, "setContext", panelCtx(LONG_PETNAME));
  await ctl(page, "addEvent", "seeded for geometry");
}

async function checkGeometryAt(page: Page, label: string): Promise<Metrics> {
  const m = await measure(page);
  const EPS = 0.002;
  expect(m.badge, `${label}: the seeded unseen event did not light the badge`).toBe(true);
  expect(m.settingsBtn.w, `${label}: settings button width under 44px floor`).toBeGreaterThanOrEqual(44);
  expect(m.settingsBtn.h, `${label}: settings button height under 44px floor`).toBeGreaterThanOrEqual(44);
  expect(m.context.w / m.barInner, `${label}: context cluster over the 45% cap`).toBeLessThanOrEqual(0.45 + EPS);
  expect(m.identity.w / m.barInner, `${label}: identity cluster over the 45% cap`).toBeLessThanOrEqual(0.45 + EPS);
  expect(m.gap / m.barInner, `${label}: clusters under the 10% gap floor`).toBeGreaterThanOrEqual(0.10 - EPS);
  expect(m.docOverflow, `${label}: the document overflows horizontally`).toBeLessThanOrEqual(0);
  return m;
}

test("strip geometry holds its shape at 1280, with the badge lit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedGeometryFixture(page);
  await checkGeometryAt(page, "1280");
  const stripLit = (await measure(page)).stripHeight;

  // THE BADGE'S ZERO-LAYOUT-SHIFT PROMISE: the strip's own height must be
  // IDENTICAL lit and unlit (visor.css's absolute-positioned dot).
  await ctl(page, "markEventsSeen");
  const stripUnlit = (await measure(page)).stripHeight;
  expect(stripUnlit).toBeCloseTo(stripLit, 1);
});

test("strip geometry holds its shape at 390 (phone), and identity lines ellipsize", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedGeometryFixture(page);
  const m = await checkGeometryAt(page, "390");
  expect(m.identity.w, "the identity cluster vanished at 390").toBeGreaterThan(0);

  const top = await page.evaluate(() => document.querySelector("#visor-context .ctx-top")?.textContent ?? "");
  expect(top, `the petname was not on the strip at 390: ${JSON.stringify(top)}`).toContain("quarterly planning");

  // ELLIPSIS, NOT DISAPPEARANCE (#22): a cramped identity line must
  // overflow its own box (scrollWidth > clientWidth) rather than push the
  // cluster off-edge or hide.
  const truncated = m.idLines.filter((l) => l.scrollW > l.clientW + 1).length;
  expect(truncated, `no identity line ellipsized at 390: ${JSON.stringify(m.idLines)}`).toBeGreaterThan(0);
});

// -- 3b. HEIGHT BUDGET, from drawer-overflow.ts ---------------------------

test("the drawer's sheet is capped at viewport - strip - 48, and scrolls internally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await ctl(page, "claim");
  const opened = await ctl(page, "openTenant", "credentials", noneCtx);
  expect(opened, "credentials refused to open").toBe(true);

  // The build/mount round trip is async (host/sheets.ts's ResizeObserver
  // path); wait for the drawer to have actually grown to it.
  await page.waitForFunction(() => {
    const inner = document.getElementById("visor-drawer-inner")!;
    const sheet = inner.querySelector(".cred-sheet") as HTMLElement | null;
    return sheet !== null && parseFloat(getComputedStyle(inner).height) > 0;
  });

  const g = await page.evaluate(() => {
    const inner = document.getElementById("visor-drawer-inner")!;
    const sheet = inner.querySelector(".cred-sheet") as HTMLElement;
    const strip = document.getElementById("visor-strip")!;
    return {
      innerHeight: parseFloat(getComputedStyle(inner).height),
      stripHeight: strip.getBoundingClientRect().height,
      sheetScrollHeight: sheet.scrollHeight,
      sheetClientHeight: sheet.clientHeight,
      vh: globalThis.innerHeight,
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight,
    };
  });

  const budget = g.vh - Math.ceil(g.stripHeight) - 48;
  expect(g.innerHeight, "the drawer grew past its budget").toBeLessThanOrEqual(budget + 1);
  expect(g.sheetScrollHeight, "the sheet does not overflow — the internal-scroll claim is trivially true").toBeGreaterThan(
    g.sheetClientHeight,
  );
  // THE PAGE DOES NOT SCROLL: the drawer's own box is what grows, not the
  // document underneath it.
  expect(g.docScrollH, "the document itself grew scrollable under the drawer").toBeLessThanOrEqual(g.docClientH + 1);
});

// -- 3c. ANNOUNCEMENTS, from drawer-announcements.ts ----------------------

test("open, closed, and back on resume, prefixed by the anchor word (\"visor\" pre-claim)", async ({ page }) => {
  await recordLive(page);
  // Unclaimed: the word prefix is the literal "visor" (component.rs's
  // `word_prefix`), which is the honest pre-claim sentence
  // (wit/world.wit's `embedder` header cites visor.ts:1845-1861 for this).
  await ctl(page, "openTenant", "picker", noneCtx);
  await waitSaid(page, "visor: storage picker open");

  // credentials is EXCLUSIVE... no — picker is suspendable, so opening
  // credentials over it SUSPENDS picker (silently) rather than closing it.
  await ctl(page, "openTenant", "credentials", noneCtx);
  const afterCreds = await waitSaid(page, "credentials open");
  expect(afterCreds.some((l) => l.includes("storage picker closed")), "a suspended sheet must not announce a close").toBe(
    false,
  );

  await ctl(page, "closeTenant", "credentials", closeReason(true));
  await waitSaid(page, "credentials closed");
  const log = await waitSaid(page, "storage picker back");
  const closedAt = findSaid(log, "visor: credentials closed");
  const backAt = findSaid(log, "visor: storage picker back");
  expect(closedAt).not.toBeNull();
  expect(backAt).not.toBeNull();
  expect(backAt!).toBeGreaterThan(closedAt!);
});

// -- 3d. THE FOREIGN SLOT --------------------------------------------------

test("a mounted sheet survives guest re-renders, and a swap never leaves two foreign roots in one slide", async ({ page }) => {
  await ctl(page, "claim");
  await ctl(page, "openTenant", "picker", noneCtx);
  await page.waitForSelector("#visor-drawer-inner .picker-sheet");
  const before = await page.evaluate(() =>
    document.querySelector("#visor-drawer-inner .picker-sheet")
  );
  expect(before).not.toBeNull();

  // Force guest re-renders that touch the slide's class, the drawer's
  // height, and the strip — none of which may disturb the foreign root
  // (src/app.rs's `.visor-slide` LEAF contract).
  await ctl(page, "announce", "re-render probe", 0);
  await ctl(page, "pulseContext", undefined);
  await ctl(page, "setContext", panelCtx("re-render"));

  const sameNode = await page.evaluate(() => {
    const marker = document.querySelector("#visor-drawer-inner .picker-sheet");
    return marker !== null;
  });
  expect(sameNode, "the foreign sheet did not survive the guest's re-renders").toBe(true);

  // A swap: credentials is exclusive and displaces the suspendable picker.
  await ctl(page, "openTenant", "credentials", noneCtx);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet");

  // THE HOST'S OWN REFERENCE COUNT, checked FIRST and separately from the
  // DOM: `suspend` (src/drawer.rs) unmounts synchronously — before the
  // travel even starts — so this must already be 1 while the outgoing
  // picker sheet's DOM is still visibly mid-travel (its slide is
  // `.visor-swap-out`, out of flow, for SWAP_MS; that overlap is the
  // travel working as designed, not a foreign-root leak).
  const liveCount = await page.evaluate(
    // deno-lint-ignore no-explicit-any
    () => (globalThis as any).__visor.sheets.liveCount(),
  );
  expect(liveCount, "the host held more than one foreign-sheet reference during the swap").toBe(1);

  // Once the travel settles, the DOM agrees: exactly one foreign root.
  await page.waitForTimeout(500);
  const liveRootCount = await page.evaluate(() =>
    document.querySelectorAll("#visor-drawer-inner .visor-slide .cred-sheet, #visor-drawer-inner .visor-slide .picker-sheet")
      .length
  );
  expect(liveRootCount, "two foreign roots remained after the swap settled").toBe(1);
});

// -- 3e. ARM_MS: a security control, tested like one ----------------------

async function credentialsButtonsDisabled(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#visor-drawer-inner .cred-sheet .cred-row button"));
    return buttons.length > 0 && buttons.every((b) => b.disabled);
  });
}
async function credentialsButtonsLive(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#visor-drawer-inner .cred-sheet .cred-row button"));
    return buttons.length > 0 && buttons.every((b) => !b.disabled);
  });
}

test("an armed tenant's controls are disabled at +300ms and live at ~700ms", async ({ page }) => {
  await ctl(page, "claim");
  await ctl(page, "openTenant", "credentials", noneCtx);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .cred-row button");

  expect(await credentialsButtonsDisabled(page), "disabled at mount").toBe(true);
  await page.waitForTimeout(300);
  expect(await credentialsButtonsDisabled(page), "disabled at +300ms — the arming delay is a security control").toBe(true);

  await page.waitForFunction(
    () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("#visor-drawer-inner .cred-sheet .cred-row button"),
      );
      return buttons.length > 0 && buttons.every((b) => !b.disabled);
    },
    undefined,
    { timeout: 2_000 },
  );
  expect(await credentialsButtonsLive(page)).toBe(true);
});

test("the arming delay survives prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ctl(page, "claim");
  await ctl(page, "openTenant", "credentials", noneCtx);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .cred-row button");

  expect(await credentialsButtonsDisabled(page), "disabled at mount under reduced motion").toBe(true);
  await page.waitForTimeout(300);
  expect(
    await credentialsButtonsDisabled(page),
    "reduced motion must not shorten ARM_MS — the timer is the enforcement, the slide is only its visible form",
  ).toBe(true);

  await page.waitForFunction(
    () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("#visor-drawer-inner .cred-sheet .cred-row button"),
      );
      return buttons.length > 0 && buttons.every((b) => !b.disabled);
    },
    undefined,
    { timeout: 2_000 },
  );
});
