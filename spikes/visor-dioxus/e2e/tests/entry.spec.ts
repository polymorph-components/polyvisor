/// <reference lib="dom" />
// THE ENTRY CEREMONIES: the device picker (PRE-CLAIM, index content only)
// and the first-run fork — ported gates for `src/entry/**`
// (wit/world.wit's `entry-host`/`entry` docs).

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { PickerRow } from "../../host/mount.ts";

const BASE = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup did not run");
  return url;
};

test.beforeEach(async ({ page }) => {
  await page.goto(BASE());
  await page.waitForFunction(() => (globalThis as never as { __mounted?: boolean }).__mounted === true, undefined, {
    timeout: 30_000,
  });
});

function entryCall(page: Page, fn: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const entryApi = (globalThis as any).__visor.entryApi;
      return entryApi[fn](...args);
    },
    { fn, args },
  );
}

async function setEntryTest(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((patch) => {
    // deno-lint-ignore no-explicit-any
    Object.assign((globalThis as any).__visor.entryTest, patch);
  }, patch);
}

function pickerSheet(page: Page) {
  return page.locator("#visor-drawer-inner .cred-sheet");
}

const ROW_PLAIN: PickerRow = {
  id: "device-a",
  petname: "laptop",
  lastUsed: 0n,
  asksPassphrase: false,
  asksPasskey: false,
};
const ROW_PASSPHRASE: PickerRow = {
  id: "device-b",
  petname: "old phone",
  lastUsed: 0n,
  asksPassphrase: true,
  asksPasskey: false,
};
const ROW_PASSKEY: PickerRow = {
  id: "device-c",
  petname: "study PC",
  lastUsed: 0n,
  asksPassphrase: false,
  asksPasskey: true,
};

// -- 4d. THE DEVICE PICKER ----------------------------------------------------

test("picker: renders PRE-CLAIM on the unclaimed grey dress, with index content only", async ({ page }) => {
  // NEVER CLAIMED in this test — the whole point: the picker is the one
  // sheet that opens before `control.claim()` has ever run.
  const claimedBefore = await page.evaluate(() =>
    localStorage.getItem("pm-spike-identity") !== null
  );
  expect(claimedBefore, "no identity persisted before this test's own boot").toBe(false);

  await entryCall(page, "mountDevicePicker", [ROW_PLAIN, ROW_PASSPHRASE], undefined);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .device-row");
  expect(await entryCall(page, "pickerOpen")).toBe(true);

  // INDEX CONTENT ONLY: petnames and times, nothing personal (an account
  // name, an icon, a hue).
  const text = await pickerSheet(page).innerText();
  expect(text).toContain("laptop");
  expect(text).toContain("old phone");
  const rows = page.locator("#visor-drawer-inner .device-pick");
  await expect(rows).toHaveCount(2);

  // THE ABSENCE OF ACCOUNT CONTENT: NOTHING PERSONAL BEFORE THE CLAIM —
  // app.rs renders `.id-lines` and `#visor-settings` at all ONLY once
  // `claimed`, so their absence here is the structural proof, not merely
  // an empty string that could also mean "claimed with blank fields".
  expect(
    await page.locator("#visor-identity .id-lines").count(),
    "no identity content renders at all pre-claim",
  ).toBe(0);
  expect(
    await page.locator("#visor-settings").count(),
    "no settings button renders pre-claim — the settings sheet is about an account that is not yours yet",
  ).toBe(0);

  // THE ANCHOR COLOUR IS UNCLAIMED (zero chroma): `hue_style` (app.rs)
  // emits no `--visor-bg` custom property at all while unclaimed, so the
  // strip/drawer fall through to visor.css's zero-chroma grey fallback —
  // checked as the absence of the inline property this crate is the only
  // thing that ever writes.
  const bg = await page.evaluate(() => {
    const strip = document.getElementById("visor-strip");
    return strip?.style.getPropertyValue("--visor-bg") ?? "";
  });
  expect(bg, "no --visor-bg inline property while unclaimed (the zero-chroma fallback applies)").toBe("");

  await page.locator("#device-new").waitFor();
});

test("picker: a needs-passphrase refusal REVEALS THE FIELD rather than merely reporting", async ({ page }) => {
  await setEntryTest(page, { openResult: { needsPassphrase: true, message: "this device needs its passphrase" } });
  await entryCall(page, "mountDevicePicker", [ROW_PLAIN], undefined);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .device-pick");
  // ROW_PLAIN asks neither rung, so the first tap goes straight to
  // `open(row, none)` (`InitialAction::ChooseNow`) — and its refusal here
  // carries `needsPassphrase: true`.
  await pickerSheet(page).locator(".device-pick").click();
  await page.waitForSelector("#visor-drawer-inner .cred-sheet input[type=password]");
  expect(await pickerSheet(page).locator(".entry-problem").innerText()).toContain(
    "this device needs its passphrase",
  );
});

test("picker: a passkey row still reaches the passphrase field through the fallback control", async ({ page }) => {
  await entryCall(page, "mountDevicePicker", [ROW_PASSKEY], undefined);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .device-pick");
  await pickerSheet(page).locator(".device-pick").click();
  await page.waitForSelector("#visor-drawer-inner .cred-sheet button", { state: "attached" });
  await pickerSheet(page).locator("button", { hasText: "use your passphrase instead" }).click();
  await expect(pickerSheet(page).locator("input[type=password]")).toBeVisible();
});

test("picker: supports-passkey / supports-restore false render NO control, not an inert one", async ({ page }) => {
  await setEntryTest(page, { supportsRestore: false });
  await entryCall(page, "mountDevicePicker", [ROW_PLAIN], undefined);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .device-pick");
  expect(await pickerSheet(page).locator("button", { hasText: "Restore from a recovery kit" }).count()).toBe(0);

  await setEntryTest(page, { supportsPasskey: false });
  // Re-presenting the (exclusive, already-open) picker with a new subject
  // needs no dismissal first — `entry.mount-device-picker` re-opens the
  // same tenant (src/entry/mod.rs's `EntryGuest::mount_device_picker`).
  await entryCall(page, "mountDevicePicker", [ROW_PASSKEY], undefined);
  await page.waitForSelector("#visor-drawer-inner .cred-sheet .device-pick");
  await pickerSheet(page).locator(".device-pick").click();
  await pickerSheet(page).locator("button", { hasText: "Use your passkey" }).click();
  // `supports-passkey() === false` is an HONEST DEGRADE, not a swap: the
  // screen still offers the button (a page cannot know in advance whether
  // a tap will succeed), but the press itself refuses rather than opening
  // a ceremony no one asked for.
  await expect(pickerSheet(page).locator(".entry-problem")).toContainText("cannot open devices with a passkey");
});

// -- 4e. THE FIRST-RUN FORK --------------------------------------------------

test("first-run: three choices, and 'new account' calls the host", async ({ page }) => {
  await entryCall(page, "offerFirstRun");
  await page.waitForSelector("#visor-drawer-inner .cred-sheet #solo-new-account");
  expect(await entryCall(page, "firstRunOpen")).toBe(true);
  expect(await page.locator("#solo-new-account").count()).toBe(1);
  expect(await page.locator("#solo-join-device").count()).toBe(1);
  expect(await page.locator("#solo-restore-account").count()).toBe(1);

  await page.locator("#solo-new-account").click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner #solo-new-account"));
  expect(await entryCall(page, "firstRunOpen"), "the fork after new-account succeeds").toBe(false);
});

test("first-run: supports-restore false hides the restore choice entirely", async ({ page }) => {
  await setEntryTest(page, { supportsRestore: false });
  await entryCall(page, "offerFirstRun");
  await page.waitForSelector("#visor-drawer-inner .cred-sheet #solo-new-account");
  expect(await page.locator("#solo-restore-account").count()).toBe(0);
});
