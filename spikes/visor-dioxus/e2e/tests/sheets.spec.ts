// The visor's own four ceremonies, guest-rendered — ported from
// demo/e2e/scenarios/{petname-ceremony,settings-identity,visor-events,
// visor-reset}.ts (dispatch governing docs). See spike.spec.ts's header for
// the build-identity discipline this file inherits unchanged.
//
// UNLIKE THE DEMO SUITE there is no real component, so a component's own
// nomination and provenance are FIXTURES this file makes up, and every
// ceremony is opened through the guest's own `sheets`/`marks` exports
// (`__visor.sheets_api`, `__visor.marks`) rather than through app-rendered
// affordances — the same discipline spike.spec.ts already takes with
// `control`.
//
// CONTRACT GAP, FOUND BY THIS FILE (out of this dispatch's territory —
// src/** — so reported, not fixed): `sheets.request-naming`'s
// `SheetsGuest::request_naming` (src/sheets/export.rs:147-154) builds the
// guest `Surface` through `surface_from_parts`, which hardcodes `nomination:
// None` (src/state.rs:558-566), and `naming.rs`'s own `nomination_for`
// (src/sheets/naming.rs:74-76) is ALSO unconditionally `None` — both
// unchanged from the "no nomination field on the WIT" era even though
// `types.surface` gained `nomination: option<string>` this round
// (wit/world.wit:118-133, whose own "ADDED AFTER WAVE ONE" note says the
// field was added so `marks.icon-offers` would have a caller). The result:
// nothing reached through `sheets.request-naming` can ever show the
// component's own nomination offered first, no matter what the caller's
// `WitSurface.nomination` says. The MECHANISM below it — `marks.icon-offers`
// taking a nomination and dropping a claimed one silently — is intact and
// tested here directly against `marks`, since that half of the seam does not
// route through the broken call site.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Marks, Sheets, WitSurface } from "../../host/mount.ts";

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

// -- helpers, mirroring spike.spec.ts's `ctl` ------------------------------

function sheetsCall<K extends keyof Sheets>(
  page: Page,
  fn: K,
  ...args: Parameters<Sheets[K]>
): Promise<ReturnType<Sheets[K]>> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const sheets = (globalThis as any).__visor.sheets_api;
      return sheets[fn](...args);
    },
    { fn: fn as string, args: args as unknown[] },
  );
}

function marksCall<K extends keyof Marks>(
  page: Page,
  fn: K,
  ...args: Parameters<Marks[K]>
): Promise<ReturnType<Marks[K]>> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const marks = (globalThis as any).__visor.marks;
      return marks[fn](...args);
    },
    { fn: fn as string, args: args as unknown[] },
  );
}

// deno-lint-ignore no-explicit-any
function ctlCall(page: Page, fn: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(
    ({ fn, args }: { fn: string; args: unknown[] }) => {
      // deno-lint-ignore no-explicit-any
      const control = (globalThis as any).__visor.control;
      return control[fn](...args);
    },
    { fn, args },
  );
}

function surface(over: Partial<WitSurface> & { name: string }): WitSurface {
  return { nickname: "TodoMVC", icon: "", isNew: true, ...over };
}

async function nameSheetOpen(page: Page): Promise<boolean> {
  return await page.locator("#visor-drawer-inner .name-sheet").count() > 0;
}

// The naming sheet has exactly one text `<input>` (the petname field), and
// exactly one `.cred-row` with Save first, Cancel second — the layout
// naming.rs's own component renders.
async function typePetname(page: Page, name: string): Promise<void> {
  await page.locator("#visor-drawer-inner .name-sheet .cred-field input[type=text]").fill(name);
}
function saveButton(page: Page) {
  return page.locator("#visor-drawer-inner .name-sheet .cred-row button", { hasText: "Save" });
}
function cancelButton(page: Page) {
  return page.locator("#visor-drawer-inner .name-sheet .cred-row button", { hasText: "Cancel" });
}
function reasonText(page: Page): Promise<string> {
  return page.locator("#visor-drawer-inner .name-sheet .cred-reason").innerText();
}

// -- 3a. THE NAMING CEREMONY, from petname-ceremony.ts --------------------

test("naming a component sets the petname, clears NEW, refuses a collision, and forgetting restores NEW", async ({ page }) => {
  await ctlCall(page, "claim");

  // Open the ceremony for a fresh surface — the port of the strip's naming
  // affordance being used, called directly per this file's header.
  await sheetsCall(page, "requestNaming", surface({ name: "app" }));
  await page.waitForSelector("#visor-drawer-inner .name-sheet");
  expect(await sheetsCall(page, "namingOpen")).toBe(true);

  await typePetname(page, "tasks board");
  await saveButton(page).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .name-sheet"));
  expect(await sheetsCall(page, "namingOpen")).toBe(false);

  // Persisted in the trust table.
  const table = await marksCall(page, "listAll");
  const app = table.find((e) => e.provenance === "app");
  expect(app?.mark.petname, "the persisted petname").toBe("tasks board");

  // FIRST SIGHT IS OVER: `marks.mark` on the same provenance now reports
  // `isNew: false` — the ceremony IS the TOFU moment completing.
  const remarked = await marksCall(page, "mark", "app");
  expect(remarked.isNew, "isNew after the naming ceremony").toBe(false);

  // A SECOND record cannot be given the same word.
  await sheetsCall(page, "requestNaming", surface({ name: "panel-s3", nickname: "S3" }));
  await page.waitForSelector("#visor-drawer-inner .name-sheet");
  await typePetname(page, "tasks board");
  await saveButton(page).click();
  const reason = await reasonText(page);
  expect(reason, "the collision refusal").toContain("you already call another component");
  expect(reason, "the collision refusal names the petname").toContain("tasks board");
  expect(reason, "the collision refusal names the provenance key").toContain("app");
  expect(await sheetsCall(page, "namingOpen"), "the sheet stays open on a refused collision").toBe(true);
  // Close without saving: Cancel, since this act's subject is done with.
  await cancelButton(page).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .name-sheet"));

  // FORGETTING drops the whole record.
  await sheetsCall(page, "requestNaming", surface({ name: "app", petname: "tasks board" }));
  await page.waitForSelector("#visor-drawer-inner .name-sheet");
  await page.locator("#visor-drawer-inner .name-sheet .name-forget button.forget").click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .name-sheet"));

  const afterForget = await marksCall(page, "listAll");
  expect(afterForget.some((e) => e.provenance === "app"), "the app record after forgetting").toBe(false);
  const remarkedAfterForget = await marksCall(page, "mark", "app");
  expect(remarkedAfterForget.isNew, "a forgotten component is NEW again").toBe(true);
});

test("an empty name is refused, not treated as forget", async ({ page }) => {
  await ctlCall(page, "claim");
  await sheetsCall(page, "requestNaming", surface({ name: "blank-test" }));
  await page.waitForSelector("#visor-drawer-inner .name-sheet");
  await typePetname(page, "   ");
  await saveButton(page).click();
  expect(await sheetsCall(page, "namingOpen"), "the sheet after an empty save").toBe(true);
  expect(await reasonText(page)).toContain("type a name, or Cancel");
});

// THE NOMINATION MECHANISM, tested directly against `marks` — see this
// file's header for why `sheets.request-naming` cannot exercise it.
test("marks.iconOffers: a nomination is offered first, and a claimed glyph is dropped silently", async ({ page }) => {
  await ctlCall(page, "claim");
  const ROOK = "\u265C"; // an offer from the curated table
  const offers = await marksCall(page, "iconOffers", "nomination-fixture-a", ROOK);
  expect(offers.length, "the number of offers").toBe(6);
  expect(offers[0], "the nomination is offered first").toEqual({ glyph: ROOK, nominated: true });
  expect(offers.filter((o) => o.nominated).length, "exactly one nominated offer").toBe(1);

  // The record that already wears the rook.
  await marksCall(page, "setPetname", "nomination-fixture-a", "already wears it", ROOK);
  const offersForOther = await marksCall(page, "iconOffers", "nomination-fixture-b", ROOK);
  expect(
    offersForOther.some((o) => o.glyph === ROOK),
    "a glyph another record already wears must not be offered, nominated or not",
  ).toBe(false);
  expect(offersForOther.some((o) => o.nominated), "no nomination survives when it was claimed").toBe(false);
});

// -- 3b. SETTINGS, from settings-identity.ts -------------------------------

function settingsSheet(page: Page) {
  return page.locator("#visor-drawer-inner .settings-sheet");
}
/** WAS BROKEN, NOW FIXED — kept as the record of what the defect was,
 * because the cause is a hazard specific to this port and has no
 * TypeScript analogue.
 *
 * `SettingsSheet` never completed its first render: the call never
 * resolved and `.settings-sheet` never appeared, even after 8s idle. Not a
 * slow render — a genuine hang, so the guest never returned from the
 * export and the host awaited it forever.
 *
 * THE CAUSE: render bodies were reading visor state through the WRITE door
 * (`with_visor`, which takes `signal.write()` and therefore marks the
 * signal dirty unconditionally) instead of the read door (`read_visor`,
 * which subscribes). `SettingsSheet` was the one sheet that both
 * SUBSCRIBED (via `committed_hue`/`unseen_event_count`) and WROTE on every
 * render pass: dirty -> render -> dirty, unbounded.
 *
 * The same mistake seen from the other side produced the arming defect
 * below: a component that writes but never subscribes renders once and
 * never learns anything again. One cause, two opposite symptoms. */
async function openSettings(page: Page): Promise<void> {
  await sheetsCall(page, "requestSettings");
  await page.waitForSelector("#visor-drawer-inner .settings-sheet");
}

test(
  "settings: name and device commit on Save and appear on the strip; Cancel restores the hue",
  async ({ page }) => {
  await ctlCall(page, "claim");
  const before = await ctlCall(page, "committedHue");

  await openSettings(page);
  await settingsSheet(page).locator("#visor-settings-name").fill("Ada");
  await settingsSheet(page).locator("#visor-settings-device").fill("study PC");
  await settingsSheet(page).locator(".settings-hues button[data-hue]").first().click();
  await settingsSheet(page).locator(".cred-row button", { hasText: "Save" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .settings-sheet"));

  const idText = await page.locator("#visor-identity .id-lines").innerText();
  expect(idText).toContain("Ada");
  expect(idText).toContain("study PC");

  // Cancel restores the hue the sheet opened with: pick a DIFFERENT hue,
  // Cancel, and the committed hue must be untouched — the live preview must
  // not survive a cancel.
  const committedAfterSave = await ctlCall(page, "committedHue");
  await openSettings(page);
  const hues = settingsSheet(page).locator(".settings-hues button[data-hue]");
  const otherHue = await hues.nth(1).getAttribute("data-hue");
  await hues.nth(1).click();
  await settingsSheet(page).locator(".cred-row button", { hasText: "Cancel" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .settings-sheet"));
  const committedAfterCancel = await ctlCall(page, "committedHue");
  expect(committedAfterCancel, "cancel must not commit the live preview").toBe(committedAfterSave);
  expect(String(committedAfterCancel)).not.toBe(otherHue);
  void before;
  },
);

test(
  "settings: consumer extra-actions render with their data-action keys, and an empty list renders nothing",
  async ({ page }) => {
  await ctlCall(page, "claim");
  await sheetsCall(page, "configure", [], [{ label: "sign out", key: "sign-out" }]);
  await openSettings(page);
  const btn = settingsSheet(page).locator('[data-action="sign-out"]');
  await expect(btn).toHaveText("sign out");
  await settingsSheet(page).locator(".cred-row button", { hasText: "Cancel" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .settings-sheet"));

  await sheetsCall(page, "configure", [], []);
  await openSettings(page);
  expect(await settingsSheet(page).locator(".settings-extra").count(), "an empty extra-actions list renders nothing").toBe(0);
  await settingsSheet(page).locator(".cred-row button", { hasText: "Cancel" }).click();
  },
);

// -- 3c. THE EVENT LIST, from visor-events.ts ------------------------------

test("events: the badge lights on a consequential event, opening the list marks it seen, and ages render coarsely", async ({ page }) => {
  await ctlCall(page, "claim");
  await ctlCall(page, "addEvent", "seeded event");
  expect(await ctlCall(page, "unseenEventCount"), "unseen count after an event").toBeGreaterThan(0);
  const labelBefore = await page.locator("#visor-settings").getAttribute("aria-label");
  expect(labelBefore, "the settings aria-label while unseen events stand").toContain("— recent events waiting");

  await sheetsCall(page, "requestEvents");
  await page.waitForSelector("#visor-drawer-inner .events-sheet");
  const row = page.locator("#visor-drawer-inner .events-sheet .events-row").first();
  await expect(row.locator(".events-when")).toHaveText("just now");
  await expect(row).toContainText("seeded event");
  await page.locator("#visor-drawer-inner .events-sheet .cred-row button", { hasText: "Close" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .events-sheet"));

  // OPENING MARKED EVERYTHING SEEN: the badge is out and the count is zero,
  // no standing condition holding it up.
  expect(await ctlCall(page, "unseenEventCount"), "unseen count after opening the list").toBe(0);
  const labelAfter = await page.locator("#visor-settings").getAttribute("aria-label");
  expect(labelAfter, "the settings aria-label once seen").not.toContain("recent events waiting");
});

test("events: a standing condition keeps the badge lit even with nothing unseen", async ({ page }) => {
  await ctlCall(page, "claim");
  await ctlCall(page, "setCondition", "offline", "working offline");
  const label = await page.locator("#visor-settings").getAttribute("aria-label");
  expect(label, "a standing condition lights the badge on its own").toContain("recent events waiting");
  await ctlCall(page, "clearCondition", "offline");
});

test("events: records survive a reload", async ({ page }) => {
  await ctlCall(page, "claim");
  await ctlCall(page, "addEvent", "before reload");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (globalThis as never as { __mounted?: boolean }).__mounted === true);
  const events = await ctlCall(page, "listEvents");
  expect(events.some((e: { text: string }) => e.text === "before reload"), "the event after a reload").toBe(true);
});

// -- 3d. THE ERASE CEREMONY, from visor-reset.ts ---------------------------

function resetSheet(page: Page) {
  return page.locator("#visor-drawer-inner .reset-sheet");
}
async function openReset(page: Page): Promise<void> {
  await sheetsCall(page, "requestReset");
  await page.waitForSelector("#visor-drawer-inner .reset-sheet");
}
function eraseButton(page: Page) {
  return resetSheet(page).locator(".erase-confirm");
}

// THE ARMING DELAY ON THE GUEST-RENDERED PATH. Was broken and is fixed;
// the record is kept because the failure was a security control going dead
// on exactly the path this port proposes to ship.
//
// RESET is the only armed tenant in this world (naming/settings/events all
// ship `armed: false`). Its control never went live: `.reset-sheet` never
// gained `.armed` and `.erase-confirm` stayed `disabled` past 1.6s, while
// the FOREIGN-sheet arming path (spike.spec.ts's `credentials` gate) armed
// correctly at ~702ms. So the clock and the state machine were both fine —
// `embedder.tenant-armed` was observed firing on time.
//
// What failed was one line downstream: `SheetRoot` (the `.armed` class) and
// `ResetSheet` (the `disabled` attribute) both read the armed fact through
// the WRITE door, so neither SUBSCRIBED, so neither ever re-rendered to
// learn the machine had opened the control. It failed CLOSED, which is the
// right direction for a security control to fail in, and it made the
// ceremony unusable.
//
// Measured after the fix, guest-rendered path: 706.0 / 710.5 / 708.5 ms
// against ARM_MS = 700 (the foreign path measures 702.5).
test("reset: controls stay disabled at mount and at +300ms, and are live past ARM_MS", async ({ page }) => {
  await ctlCall(page, "claim");
  await ctlCall(page, "saveIdentity", { name: "Ada", device: "laptop", icon: "" });
  await openReset(page);

  expect(await eraseButton(page).isDisabled(), "disabled at mount").toBe(true);
  await page.waitForTimeout(300);
  expect(await eraseButton(page).isDisabled(), "disabled at +300ms — a security control").toBe(true);
  // THE ASSERTION THIS GATE IS REALLY ABOUT: the control goes live, and only
  // after the delay has actually been spent.
  await page.waitForTimeout(1000);
  expect(
    await eraseButton(page).isDisabled(),
    "live past ARM_MS — the delay is spent, not skipped and not permanent",
  ).toBe(false);

  await resetSheet(page).locator(".cred-row button", { hasText: "Cancel" }).click();
  await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .reset-sheet"));
});

test(
  "reset: the refusal path — on-reset failing forgets nothing",
  async ({ page }) => {
    await ctlCall(page, "claim");
    await ctlCall(page, "saveIdentity", { name: "Ada", device: "laptop", icon: "" });
    await ctlCall(page, "commitHue", 200);
    await marksCall(page, "setPetname", "still-here", "still there", "");

    await page.evaluate(() => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).__visor.embedderTest.onResetFail = "consumer refused for the test";
    });

    await openReset(page);
    await page.waitForFunction(
      () => !(document.querySelector("#visor-drawer-inner .reset-sheet .erase-confirm") as HTMLButtonElement)?.disabled,
      undefined,
      { timeout: 2_000 },
    );
    await resetSheet(page).locator("#visor-reset-confirm").fill("Ada");
    await eraseButton(page).click();
    await expect(resetSheet(page).locator(".cred-reason")).toContainText("could not erase", { timeout: 5_000 });

    // NOTHING HAS BEEN FORGOTTEN: identity, hue and marks are all still there.
    const identity = await ctlCall(page, "getIdentity");
    expect(identity.name).toBe("Ada");
    expect(await ctlCall(page, "committedHue")).toBe(200);
    const table = await marksCall(page, "listAll");
    expect(table.some((e) => e.provenance === "still-here")).toBe(true);

    await resetSheet(page).locator(".cred-row button", { hasText: "Cancel" }).click();
    await page.waitForFunction(() => !document.querySelector("#visor-drawer-inner .reset-sheet"));
  },
);

test(
  "reset: the success path erases everything and reloads",
  async ({ page }) => {
    await ctlCall(page, "claim");
    await ctlCall(page, "saveIdentity", { name: "Ada", device: "laptop", icon: "" });
    await marksCall(page, "setPetname", "gone-after-erase", "erased", "");

    await page.evaluate(() => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).__visor.embedderTest.onResetFail = false;
    });

    await openReset(page);
    await page.waitForFunction(
      () => !(document.querySelector("#visor-drawer-inner .reset-sheet .erase-confirm") as HTMLButtonElement)?.disabled,
      undefined,
      { timeout: 2_000 },
    );
    await resetSheet(page).locator("#visor-reset-confirm").fill("Ada");

    const navigated = page.waitForEvent("load");
    await eraseButton(page).click();
    await navigated;

    // A fresh boot: unclaimed, no identity, no marks.
    await page.waitForFunction(() => (globalThis as never as { __mounted?: boolean }).__mounted === true);
    const stored = await page.evaluate(() => ({
      identity: localStorage.getItem("pm-spike-identity"),
      marks: localStorage.getItem("pm-spike-marks"),
      hue: localStorage.getItem("pm-spike-hue"),
    }));
    expect(stored.identity, "identity after erase + reload").toBeNull();
    expect(stored.marks, "marks after erase + reload").toBeNull();
    expect(stored.hue, "hue after erase + reload").toBeNull();
  },
);
