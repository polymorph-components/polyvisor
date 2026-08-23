// THE OPEN DRAWER'S GEOMETRY ON A PHONE — the shape a sheet must have
// when it is bigger than the space it was measured into.
//
// Reported from a real phone: the storage sheet came up "half closed",
// with its top out of view, and a drag inside it scrolled the app
// underneath. Both halves are geometry the suite could not see, for two
// different reasons:
//
//   * THE STALE MEASURE. The drawer reveals by animating
//     `#visor-drawer-inner`'s HEIGHT to a pixel value measured once, at
//     the moment the sheet is mounted — and the storage sheet mounts a
//     SKELETON, then fills in when `status()` and the stored config come
//     back through the worker's port. Measured at 70px (two buttons),
//     grown to 525px of content, and never re-measured: the inner is
//     `overflow: hidden` with `justify-content: flex-end`, so the
//     overflow is clipped from the TOP. The heading, the radios and the
//     fields are all simply above the drawer's box. No e2e scenario
//     caught it because a clipped element is still clickable through
//     `page.evaluate` — which is exactly why the clicks below are REAL
//     Playwright clicks: actionability is the claim, not a nuisance to
//     be worked around (solo-gdrive.ts used to carry that workaround,
//     and it was this bug seen at desk width).
//
//   * THE APP-REVEAL BAND. A drawer permitted to grow until it covers
//     the last of the app surface makes the visor's whole claim
//     uncheckable: a full-screen sheet is indistinguishable from a page
//     that has drawn one. `fit`'s budget keeps a band of dimmed app
//     visible under the assembly at every size (visor.ts's APP_REVEAL).
//
//   * THE CONTAINED GESTURE. A wheel or a drag inside the visor's own
//     pixels must not move the page beneath it — one gesture, one
//     surface.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS } from "../util.ts";
import { solo, until, WAITS } from "../solo-util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** A phone, and a short one: the viewport where a sheet of this size
 * genuinely does not fit, so the budget and the internal scroll are
 * both load-bearing rather than incidentally satisfied. */
const VIEWPORT = { width: 390, height: 664 };
/** The band of app surface the open assembly must leave visible. The
 * assertion allows a little less than visor.ts's own APP_REVEAL (48):
 * this is a claim about a visible boundary, not about an exact
 * constant, and a rounding difference must not read as a regression. */
const REVEAL_FLOOR = 40;

interface Geometry {
  vh: number;
  innerTop: number;
  innerBottom: number;
  sheetTop: number;
  sheetHeight: number;
  sheetScrollHeight: number;
  sheetClientHeight: number;
  zoneBottom: number;
  gdTop: number;
  gdBottom: number;
}

function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const inner = document.getElementById("visor-drawer-inner")!;
    const sheet = document.querySelector("#visor-drawer-inner .cred-sheet") as HTMLElement;
    const zone = document.getElementById("visor-zone")!;
    const gd = document.getElementById("storage-kind-gdrive") as HTMLElement;
    const ir = inner.getBoundingClientRect();
    const sr = sheet.getBoundingClientRect();
    const gr = gd.getBoundingClientRect();
    return {
      vh: globalThis.innerHeight,
      innerTop: ir.top,
      innerBottom: ir.bottom,
      sheetTop: sr.top,
      sheetHeight: sr.height,
      sheetScrollHeight: sheet.scrollHeight,
      sheetClientHeight: sheet.clientHeight,
      zoneBottom: zone.getBoundingClientRect().bottom,
      gdTop: gr.top,
      gdBottom: gr.bottom,
    };
  });
}

const scenario: Scenario = {
  name: "drawer-overflow",
  why:
    "an open drawer on a phone shows its TOP, leaves a band of app surface visible, scrolls internally, contains its own gestures, and is really clickable",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    viewport: VIEWPORT,
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },

  async run(page: Page, _ctx: Ctx) {
    await act("an account, through the app frame's own entry ceremony", async () => {
      // Same order rule as solo-gdrive.ts: the entry ceremony is a
      // drawer sheet mounted only at first run, so it is driven BEFORE
      // any other sheet has ever opened.
      assertEquals(await solo(page, "newAccount"), true, "the entry sheet's button was clicked");
      await until([page], "the account", async () => await solo(page, "hasAccount"), WAITS.boot);
    });

    await act("the storage sheet, filled in from the worker", async () => {
      await page.evaluate(() => {
        (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
      });
      await page.waitForFunction(
        () =>
          document.querySelector(
            '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
          ) !== null,
        undefined,
        { timeout: 15_000 },
      );
      await solo(page, "openStorageSheet");
      await page.waitForSelector("#storage-kind-gdrive", { timeout: 15_000 });
      // THE ASYNC FILL IS THE SUBJECT, so the wait is for the drawer to
      // have caught up with it rather than for the fields to exist: the
      // regression is precisely a drawer whose box never learned that
      // its content grew.
      await until([page], "the drawer to finish growing", async () => {
        const g = await geometry(page);
        return g.innerBottom - g.innerTop >= g.sheetHeight - 1 ? g : false;
      }, 20_000);
    });

    await act("the sheet's TOP is on screen, and so is the gdrive radio", async () => {
      const g = await geometry(page);
      assert(
        g.sheetTop >= -0.5,
        `the sheet's top is at ${g.sheetTop.toFixed(1)}px — clipped above the drawer's box, ` +
          `which is the drawer sitting half out of view (inner ${
            (g.innerBottom - g.innerTop).toFixed(1)
          }px vs sheet ${g.sheetHeight.toFixed(1)}px: a stale measure)`,
      );
      assert(
        g.gdTop >= -0.5 && g.gdBottom <= g.vh + 0.5,
        `the gdrive radio is at ${g.gdTop.toFixed(1)}..${g.gdBottom.toFixed(1)} — ` +
          `outside the ${g.vh}px viewport`,
      );
      assert(
        g.gdTop >= g.innerTop - 0.5 && g.gdBottom <= g.innerBottom + 0.5,
        `the gdrive radio is at ${g.gdTop.toFixed(1)}..${g.gdBottom.toFixed(1)} — ` +
          `outside the drawer's own visible box ${g.innerTop.toFixed(1)}..${
            g.innerBottom.toFixed(1)
          }`,
      );
    });

    await act("a band of app surface stays visible under the assembly", async () => {
      const g = await geometry(page);
      assert(
        g.zoneBottom <= g.vh - REVEAL_FLOOR,
        `the visor assembly ends at ${g.zoneBottom.toFixed(1)}px of ${g.vh}px — ` +
          `less than ${REVEAL_FLOOR}px of app surface is left showing, so the boundary ` +
          `between the visor's pixels and the page's is no longer visible`,
      );
    });

    await act("a REAL click reaches the sheet's controls", async () => {
      // No `evaluate(...).click()` anywhere in this beat, deliberately:
      // Playwright's actionability check is a stand-in for a thumb, and
      // an element it refuses is an element a user cannot reach either.
      await page.click("#storage-kind-gdrive");
      await page.waitForSelector("#storage-gd-root", { state: "visible", timeout: 15_000 });
      await page.click("#storage-gd-space-drive");
      assertEquals(
        await page.evaluate(() =>
          (document.getElementById("storage-gd-space-drive") as HTMLInputElement).checked
        ),
        true,
        "the space radio took the real click",
      );
      // TRIAL: the connect button's reachability is the claim, not the
      // ceremony behind it (this scenario has no Drive to connect to).
      await page.click("#storage-connect", { trial: true });
    });

    await act("the sheet scrolls ITSELF, and the page underneath does not move", async () => {
      const g = await geometry(page);
      assert(
        g.sheetScrollHeight > g.sheetClientHeight + 1,
        `the sheet does not overflow at ${VIEWPORT.width}×${VIEWPORT.height} ` +
          `(${g.sheetScrollHeight} vs ${g.sheetClientHeight}) — the internal-scroll claim ` +
          `below would be trivially true`,
      );
      const box = (await page.locator("#visor-drawer-inner .cred-sheet").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, g.vh / 2));
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({
        doc: document.scrollingElement?.scrollTop ?? 0,
        sheet:
          (document.querySelector("#visor-drawer-inner .cred-sheet") as HTMLElement).scrollTop,
      }));
      assert(after.sheet > 0, `the wheel did not scroll the sheet (scrollTop ${after.sheet})`);
      assertEquals(
        after.doc,
        0,
        "the wheel over the sheet scrolled the DOCUMENT — the gesture chained past the visor " +
          "into the app surface it is covering",
      );
    });

    await act("a wheel over the dim moves nothing at all", async () => {
      const dimUp = await page.evaluate(() => {
        const d = document.getElementById("visor-dim");
        return d !== null && !d.hidden;
      });
      assert(dimUp, "the storage sheet is supposed to dim the page behind it");
      const before = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
      // Low on the screen, which is the app-reveal band itself: the one
      // part of the dim no sheet is over.
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 12);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
      assertEquals(
        after,
        before,
        "a wheel over the dim scrolled the page — the surface the visor has just declared " +
          "out of play moved under the user's gesture",
      );
    });
  },
};

export default scenario;
