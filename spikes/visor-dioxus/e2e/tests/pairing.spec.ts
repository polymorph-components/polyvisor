/// <reference lib="dom" />
// THE PAIRING CEREMONIES, ported from
// demo/e2e/scenarios/{device-pairing-acts,device-pairing-mock}.ts (dispatch
// governing docs) against the in-page mock host (host/pairing.ts) rather
// than a two-device network — see that file's header for what "steerable"
// means here and what a single-page mock cannot exercise (no second device,
// so no cross-device write-through; noted in the report).
//
// THE CLAIM UNDER TEST, restated for a Rust guest and an SVG QR rather than
// TypeScript and a canvas one: a relay able to see and modify everything on
// the wire still cannot get a device enrolled, because the digits render
// where an app cannot draw (visor pixels, behind the drawer's dim) and
// confirming is a deliberate human press. Nothing here asserts anything
// about the digits' cryptographic origin — that is the backend's claim, and
// this mock manufactures obviously-synthetic ones (host/pairing.ts's
// `DEFAULT_SAS`, "000000") precisely so no one mistakes them for real
// output.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup did not run");
  return url;
};

const JSQR_PATH = fileURLToPath(
  new URL("../node_modules/jsqr/dist/jsQR.js", import.meta.url),
);
void path;

test.beforeEach(async ({ page }) => {
  await page.goto(BASE());
  await page.waitForFunction(() => (globalThis as never as { __mounted?: boolean }).__mounted === true, undefined, {
    timeout: 30_000,
  });
});

// -- helpers ------------------------------------------------------------

function pairingCall(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const pairing = (globalThis as any).__visor.pairing;
      return pairing[fn](...args);
    },
    { fn, args },
  );
}

function ctlCall(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const control = (globalThis as any).__visor.control;
      return control[fn](...args);
    },
    { fn, args },
  );
}

/** Set a field on `__visor.pairingTest` (host/pairing.ts's
 * `PairingTestControls`) — the one door this mock's state machine is
 * steered through. */
async function setPairingTest(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((patch) => {
    // deno-lint-ignore no-explicit-any
    Object.assign((globalThis as any).__visor.pairingTest, patch);
  }, patch);
}

function joinSheet(page: Page) {
  return page.locator("#visor-drawer-inner .pair-join-sheet");
}
function addSheet(page: Page) {
  return page.locator("#visor-drawer-inner .pair-add-sheet");
}

// -- 4a. THE JOIN FLOW ------------------------------------------------------

test("join: the code and its QR render in visor pixels, the QR decodes back to the code, and confirming advances the ceremony", async ({ page }) => {
  await pairingCall(page, "requestJoin");
  await page.waitForSelector("#visor-drawer-inner .pair-join-sheet");
  expect(await pairingCall(page, "joinOpen")).toBe(true);

  // THE CODE: 79 characters (PAIRING.md §1), grouped by 4 on screen — the
  // same shape gate 4b's twin (device-pairing-acts.ts) asserts.
  const grouped = await joinSheet(page).locator(".pair-code").innerText();
  const ungrouped = grouped.replace(/\s+/g, "");
  expect(ungrouped.length, "the pairing code's length").toBe(79);
  expect(grouped, "the code is rendered grouped").toContain(" ");
  expect(grouped.split(" ")[0].length, "the first group's length (groups of 4)").toBe(4);

  // THE QR: rendered as ONE SVG <path> (2 DOM nodes: the quiet-zone <rect>
  // and the module <path> — the whole reason `document::eval` is not
  // needed here, per this wave's dispatch). DECODES BACK to the same code,
  // rasterised in-page and read with jsQR — the "scanner library in the
  // test" the dispatch names.
  const svg = joinSheet(page).locator("svg.pair-qr");
  await expect(svg).toBeVisible();
  const nodeCount = await svg.evaluate((el) => el.querySelectorAll("*").length);
  expect(nodeCount, "the QR is one <rect> (quiet zone) + one <path> (modules)").toBe(2);

  await page.addScriptTag({ path: JSQR_PATH });
  const decoded = await page.evaluate(async () => {
    const svgEl = document.querySelector("#visor-drawer-inner .pair-join-sheet svg.pair-qr")!;
    const xml = new XMLSerializer().serializeToString(svgEl);
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg image failed to load"));
    });
    img.src = "data:image/svg+xml;base64," + btoa(xml);
    await loaded;
    const scale = 4; // upscale — a 1px-per-module raster is too small for jsQR's own resampling
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth * scale || 264;
    canvas.height = img.naturalHeight * scale || 264;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // deno-lint-ignore no-explicit-any
    const jsQR = (globalThis as any).jsQR;
    const result = jsQR(data.data, data.width, data.height);
    return result?.data ?? null;
  });
  expect(decoded, "the QR decodes to the same code the text form shows").toBe(ungrouped);

  // THE COMPARISON SCREEN: force the driver to report `claimed`, exactly as
  // the dispatch's "give the tests control over which state the next
  // *-status poll returns" asks.
  await setPairingTest(page, { forceJoinStatus: { kind: "claimed", value: "000000" } });
  await expect(joinSheet(page).locator(".pair-sas")).toHaveText("000000", { timeout: 5_000 });

  // CONFIRMING ADVANCES THE CEREMONY — a real click on the visor's own
  // control, not a driver-status edge (join.rs: the button's own onclick
  // moves the screen once `pair-join-confirm` resolves).
  await joinSheet(page).locator("button", { hasText: "I initiated this" }).click();
  await expect(joinSheet(page).locator(".cred-line.said")).toContainText(
    "confirmed — waiting for the other device",
    { timeout: 5_000 },
  );

  await joinSheet(page).locator("button", { hasText: "Cancel" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .pair-join-sheet"));
});

// -- 4b. THE ADD FLOW ---------------------------------------------------------

test("add: the statement of consequence, the arming delay from the consequence screen's mount, and an EMPTY device-name field", async ({ page }) => {
  await pairingCall(page, "requestAdd");
  await page.waitForSelector("#visor-drawer-inner .pair-add-sheet");
  expect(await pairingCall(page, "addOpen")).toBe(true);

  await addSheet(page).locator("textarea").fill("some code from the new device");
  await addSheet(page).locator("button", { hasText: "connect" }).click();

  await setPairingTest(page, { forceAddStatus: { kind: "sas-ready", value: "000000" } });
  await expect(addSheet(page).locator(".pair-sas")).toHaveText("000000", { timeout: 5_000 });

  // Pressing "codes match — continue" does NOT grant anything on its own
  // — it only reaches the statement of consequence, which is where the
  // arming delay's clock actually starts (add.rs's module header: "the
  // delay is started from the consequence screen's mount, NOT from the
  // drawer presentation").
  await addSheet(page).locator("button", { hasText: "codes match" }).click();

  const warning = await addSheet(page).locator(".cred-warning").innerText();
  expect(warning, "the statement of consequence").toContain(
    "full access to everything in your account",
  );

  const grantBtn = addSheet(page).locator("button.pair-grant");
  expect(await grantBtn.isDisabled(), "disabled at mount").toBe(true);

  // THE DEVICE NAME STARTS EMPTY — typed by the user, never prefilled by
  // anything the joiner sent or by a visor-invented default.
  const nameField = addSheet(page).locator("#visor-pair-name");
  expect(await nameField.inputValue(), "the device-name field at first paint").toBe("");

  // +300ms — still disabled (a security control, not a decoration) —
  // mirroring sheets.spec.ts's identical reset-sheet gate.
  await page.waitForTimeout(300);
  expect(await grantBtn.isDisabled(), "disabled at +300ms").toBe(true);

  // Past ARM_MS (700ms, crate::drawer::ARM_MS) — live.
  await page.waitForTimeout(1000);
  expect(await grantBtn.isDisabled(), "live past ARM_MS").toBe(false);

  await addSheet(page).locator("button", { hasText: "Cancel" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .pair-add-sheet"));
});

test("add: naming a device and granting reaches ENROLLED end-to-end (mock-steered)", async ({ page }) => {
  await pairingCall(page, "requestAdd");
  await page.waitForSelector("#visor-drawer-inner .pair-add-sheet");
  await addSheet(page).locator("textarea").fill("a code");
  await addSheet(page).locator("button", { hasText: "connect" }).click();
  await setPairingTest(page, { forceAddStatus: { kind: "sas-ready", value: "000000" } });
  await expect(addSheet(page).locator(".pair-sas")).toHaveText("000000", { timeout: 5_000 });
  await addSheet(page).locator("button", { hasText: "codes match" }).click();
  await addSheet(page).locator(".pair-grant").waitFor({ state: "attached" });
  await page.waitForFunction(
    () => !(document.querySelector("#visor-drawer-inner .pair-add-sheet .pair-grant") as HTMLButtonElement)?.disabled,
    undefined,
    { timeout: 2_000 },
  );
  await addSheet(page).locator("#visor-pair-name").fill("tablet");
  await addSheet(page).locator(".pair-grant").click();
  // THE GRANT IS THE LAST ACT ON THIS DEVICE — the sheet comes down.
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .pair-add-sheet"));
  expect(await pairingCall(page, "addOpen"), "the add sheet after the grant").toBe(false);
});

// -- 4b (cont'd). THE ACCOUNT'S DEVICE LIST ON ENROLLMENT --------------------
//
// `pairing-driver.us-devices-list` was declared (wit/world.wit) and
// implemented (host/pairing.ts) with no Rust caller — the gap this dispatch
// closes. `renderDevices`'s one call site (visor/ui/pairing.ts:859) fires
// when the add ceremony reaches `enrolled`, so both gates below reach that
// screen by forcing `pair-add-status` straight to `enrolled` from
// `Connecting` — `AddPhase::advance`'s `AddStatus::Enrolled` arm is
// unconditional (`pure/phase.rs`), which is a real, already-ported rule, not
// a test-only shortcut.

test("add: the account's device list renders on enrollment, both branches gated (a real word, and unnamed+revoked)", async ({ page }) => {
  await pairingCall(page, "requestAdd");
  await page.waitForSelector("#visor-drawer-inner .pair-add-sheet");
  await addSheet(page).locator("textarea").fill("a code");
  await addSheet(page).locator("button", { hasText: "connect" }).click();

  // OBVIOUSLY SYNTHETIC device records — agent IDs and timestamps that
  // stand for nothing except "some device", labelled as such rather than
  // resembling real enrollment material.
  await setPairingTest(page, {
    forceDevicesList: [
      { agentId: "synthetic-device-1", name: "the tablet", enrolledAt: 1n, revoked: false, endpoint: "", enrolledBy: "" },
      { agentId: "synthetic-device-2", name: "", enrolledAt: 2n, revoked: true, endpoint: "", enrolledBy: "" },
    ],
    forceAddStatus: { kind: "enrolled" },
  });

  await expect(addSheet(page).locator(".cred-line", { hasText: "done." })).toBeVisible({ timeout: 5_000 });
  const items = addSheet(page).locator(".cred-devices li");
  await expect(items).toHaveCount(2);
  // USER VOICE: the real device word, rendered through `.who` — not folded
  // into a string with the framework-voice qualifier.
  await expect(items.nth(0)).toContainText("the tablet");
  await expect(items.nth(0).locator(".who")).toHaveText("the tablet");
  // FRAMEWORK VOICE: the unnamed fallback and the revoked qualifier, for a
  // record with no user word at all.
  await expect(items.nth(1)).toContainText("(unnamed)");
  await expect(items.nth(1)).toContainText("revoked");

  await addSheet(page).locator("button", { hasText: "Close" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .pair-add-sheet"));
});

test("add: a device-list failure is silent — the enrollment success is not overwritten and the sheet stays closable", async ({ page }) => {
  await pairingCall(page, "requestAdd");
  await page.waitForSelector("#visor-drawer-inner .pair-add-sheet");
  await addSheet(page).locator("textarea").fill("a code");
  await addSheet(page).locator("button", { hasText: "connect" }).click();

  await setPairingTest(page, {
    devicesListError: "the account partition is unreachable",
    forceAddStatus: { kind: "enrolled" },
  });

  // "device added" was already announced by `add_line(&AddPhase::Enrolled)`
  // before the list is even fetched — a listing failure must not read as
  // the enrollment having failed, so the success screen stands.
  await expect(addSheet(page).locator(".cred-line", { hasText: "done." })).toBeVisible({ timeout: 5_000 });
  // NOTHING DRAWN in place of the list — no error line, no empty list
  // marker, just its continued absence (`EnrolledDevices`'s doc: the
  // TypeScript `if (!res.ok) return;` kept, not "fixed" into an error).
  await expect(addSheet(page).locator(".cred-devices")).toHaveCount(0);

  await addSheet(page).locator("button", { hasText: "Close" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .pair-add-sheet"));
});

// -- 4c. THE US-EVENT DRAIN --------------------------------------------------

test("us-events: several sentences from one drain arrive as ONE atomic live-region write, and ONE event record per line", async ({ page }) => {
  const before = (await ctlCall(page, "listEvents")) as Array<{ text: string }>;

  await page.evaluate(() => {
    const el = document.getElementById("visor-live")!;
    (globalThis as unknown as Record<string, unknown>).__log = [] as string[];
    const push = () => {
      const t = el.textContent ?? "";
      if (t !== "") ((globalThis as unknown as { __log: string[] }).__log).push(t);
    };
    new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
  });

  await setPairingTest(page, {
    pendingUsEvents: [
      { kind: "device-added", value: "tablet" },
      { kind: "profile-changed" },
    ],
  });
  await pairingCall(page, "drainUsEvents");

  const log = await page.evaluate(() => (globalThis as unknown as { __log: string[] }).__log);
  // ONE WRITE FOR THE WHOLE BATCH: the live region was mutated exactly
  // once by this drain, and that one write carries both sentences joined
  // by ". " (component.rs's `Visor::speak`; pairing.rs's `say_all`).
  const joined = log.find((t) => t.includes("device added") && t.includes("."));
  expect(joined, `#visor-live should carry both sentences in one write; saw ${JSON.stringify(log)}`).toBeTruthy();

  // ONE EVENT RECORD PER LINE: the durable log gets two new entries, not one.
  const after = (await ctlCall(page, "listEvents")) as Array<{ text: string }>;
  expect(after.length - before.length, "one event record per drained line").toBe(2);
});

// -- 4e. THE FIRST-RUN FORK --------------------------------------------------

test("first-run: the join choice hands over to the join ceremony", async ({ page }) => {
  // deno-lint-ignore no-explicit-any
  await page.evaluate(() => (globalThis as any).__visor.entryApi.offerFirstRun());
  await page.waitForSelector("#visor-drawer-inner .cred-sheet #solo-new-account");
  await page.locator("#solo-join-device").click();
  await page.waitForSelector("#visor-drawer-inner .pair-join-sheet");
  expect(await pairingCall(page, "joinOpen"), "the join ceremony after the fork's join choice").toBe(true);
});
