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
//   * THE REVEAL ITSELF MUST ANIMATE. The height this scenario measures
//     is the endpoint of a CSS transition, and that transition was once
//     silently cancelled: `retarget()` used to write `height: auto` onto
//     `#visor-drawer-inner` and read `offsetHeight` back to measure the
//     content, and the read forces a style/layout flush, so `auto`
//     genuinely reached computed style. `auto` is not interpolable
//     against a length, so per CSS Transitions the running height
//     transition was cancelled outright and the drawer snapped open in
//     one frame instead of growing. Measured identically in Chromium and
//     Firefox — never Gecko-specific — which is why the regression gate
//     below lives on the ordinary Chromium lane rather than `firefox`.
//     The fix measures the in-flow `.visor-slide` child, never the
//     animating container at `auto` (visor.ts's `measure`/`aimed`).
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
import { act, assert, assertEquals, settleDrawer, SOLO_KEYS } from "../util.ts";
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
/** How many of the sampled per-frame heights must land strictly between
 * 0 and the largest sampled height for the reveal to count as animated.
 * A cancelled transition (the `auto`-reaches-computed-style regression
 * described above) yields exactly ZERO such samples — the box goes
 * straight from 0 to full height in one frame — so this gate is
 * decisive at any positive threshold. It is kept at 3, rather than 1,
 * only so a loaded CI machine that drops a frame or two still passes;
 * it is not evidence the transition ran for any particular duration. */
const MIN_INTERMEDIATE_SAMPLES = 3;

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
      //
      // This is also the drawer's very first "up" reveal — the fresh
      // 0 → measured-height growth (visor.ts's `reveal`), as opposed to
      // the `retarget` a swap or a resize triggers later. The sampler is
      // started BEFORE the click that opens the sheet, so it catches the
      // whole curve including its very first frame off zero.
      //
      // FAILURE HERE MEANS THE HEIGHT TRANSITION WAS CANCELLED: some
      // write in the open path reached a non-interpolable value (`auto`,
      // most concretely) on the animating property while the transition
      // was running, per CSS Transitions that cancels it outright, and
      // the drawer opened in a single frame instead of growing into
      // view.
      const sampler = page.evaluate(() =>
        new Promise<number[]>((resolve) => {
          const inner = document.getElementById("visor-drawer-inner")!;
          const out: number[] = [];
          const tick = () => {
            out.push(Math.round(parseFloat(getComputedStyle(inner).height)));
            if (out.length >= 20) resolve(out);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })
      );
      assertEquals(await solo(page, "newAccount"), true, "the entry sheet's button was clicked");
      await until([page], "the account", async () => await solo(page, "hasAccount"), WAITS.boot);
      const heights = await sampler;
      const max = Math.max(...heights);
      const between = heights.filter((h) => h > 0 && h < max).length;
      assert(
        between >= MIN_INTERMEDIATE_SAMPLES,
        `only ${between} of ${heights.length} sampled heights fell strictly between 0 and ` +
          `${max}px (samples: ${heights.join(",")}) — the drawer opened in one frame instead ` +
          `of animating, which is what a cancelled height transition looks like`,
      );
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
      // A claim about where the sheet comes to REST, not about a frame
      // of the growth `until` above merely tolerated (its own check is
      // `innerHeight >= sheetHeight - 1`, loose enough to exit while the
      // curve is still a pixel short) — settle first, or an occasional
      // still-moving pixel reads as the clipped-top regression this act
      // exists to catch.
      await settleDrawer(page);
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
      // Same reasoning as the previous act: the boundary this checks is
      // where the assembly comes to rest, not wherever it is mid-growth.
      await settleDrawer(page);
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
