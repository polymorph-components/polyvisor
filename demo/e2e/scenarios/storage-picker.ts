// THE STORAGE PICKER — commitment above the bar (#22 "the storage picker
// moves above the bar; commitment never leaves it").
//
// WHAT THIS SCENARIO IS ABOUT. Choosing a storage provider decides where
// the user's data goes, and until this change it was made by clicking one
// of two tabs INSIDE the storage page: visor pixels by construction, but
// sitting in scrollable content next to a component's own rectangle,
// which is the most forgeable position on the screen. An app can paint
// that row of tabs. It cannot paint a sheet hanging off the pinned strip.
//
// So the choice moved into a drawer sheet, and the acts below are the
// properties that move with it:
//   - the two LISTS say different things: (a) providers the user has
//     configured, offered for selection; (b) providers that are
//     installed but not configured, offered for configuration;
//   - VOICE follows NAMING state while LIST follows CONFIG state, on two
//     orthogonal axes — the same entry changes voice, in place, when the
//     user names it, without changing list;
//   - selection is ARMED, exactly as the credential sheet is, because it
//     is the act that spends something;
//   - refusals render IN THE SHEET, in the visor's own words, and leave
//     it open with nothing bound;
//   - the opener carries NO PAYLOAD: a page affordance may request the
//     picker and cannot say anything about what it shows;
//   - and the ordering invariant the old Save path owned survives the
//     move: no component surface is alive when a secret is on screen.

import type { Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  assertList,
  hook,
  KEYS,
  onStoragePage,
  settleDrawer,
  sheetOpen,
  stripText,
  SWAP_MS,
  UI_TIMEOUT,
  waitForDrawerHidden,
  waitForPanelSurface,
  waitForSheet,
  waitForStoragePage,
} from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** One entry's STRUCTURE, read out of the sheet: which group it is in,
 * whether it can be pressed, and — the part this scenario exists for —
 * which VOICE its identity is rendered in.
 *
 * Voice is asserted STRUCTURALLY, never by matching text: the app-voice
 * token must sit inside an element carrying the `foreign` class (the one
 * class `foreignToken` assigns), and the user-voice token must sit in a
 * `.petname` and NOT inside anything `foreign`. That is the same style
 * the other scenarios use, and it is the only kind of assertion that can
 * catch the failure that matters — a component-influenced string
 * rendered as if the visor had said it. */
/** How many DISTINCT per-frame samples a travelling value must take for
 * the motion to count as real rather than a jump. A cut (no transition
 * at all, or one property jumping while another animates) yields 1
 * distinct value across the whole window; this is kept at 3 rather than
 * 2 only so a loaded machine that coalesces a couple of frames still
 * passes — it is not a claim about how many frames the transition
 * actually takes. */
const MIN_DISTINCT_SAMPLES = 3;

async function entries(page: Page): Promise<
  Array<{
    provider: string;
    group: string;
    disabled: boolean;
    petname: string | null;
    icon: string | null;
    foreign: string | null;
    fresh: boolean;
    what: string;
  }>
> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("#visor-drawer-inner .picker-entry")).map((r) => ({
      provider: (r as HTMLElement).dataset.provider ?? "",
      group: r.closest(".picker-group")?.id ?? "",
      disabled: (r as HTMLButtonElement).disabled,
      petname: r.querySelector(".petname")?.textContent ?? null,
      icon: r.querySelector(".mark-icon")?.textContent ?? null,
      foreign: r.querySelector(".foreign")?.textContent ?? null,
      fresh: r.querySelector(".fresh") !== null,
      what: r.querySelector(".picker-entry-what")?.textContent ?? "",
    }))
  );
}

const entry = (
  rows: Awaited<ReturnType<typeof entries>>,
  provider: string,
) => rows.find((r) => r.provider === provider);

/** The picker's SHAPE: `expanded`, `band`, `suspended` (session alive,
 * another sheet holding the drawer) or `closed`. */
const pickerMode = (page: Page): Promise<string> =>
  // deno-lint-ignore no-explicit-any
  page.evaluate(() => (globalThis as any).__demo.picker.mode());

/** What the band is showing, or null when there is no band in the
 * drawer — which is also how "suspended" looks structurally. */
const bandState = (
  page: Page,
): Promise<{ provider: string; isControl: boolean; entries: number } | null> =>
  // deno-lint-ignore no-explicit-any
  page.evaluate(() => (globalThis as any).__demo.picker.band());

/** The visor's total on-screen chrome, in pixels: the strip, the drawer
 * and the two together. The band's budget is expressed against the strip
 * because the strip's own height is measured, not fixed (it wraps to two
 * rows on a narrow viewport). */
const chromeGeometry = (
  page: Page,
): Promise<{ strip: number; drawer: number; total: number }> =>
  page.evaluate(() => {
    const strip = document.getElementById("visor-strip")!.getBoundingClientRect().height;
    const drawer = document.getElementById("visor-drawer-inner")!.getBoundingClientRect().height;
    return { strip, drawer, total: strip + drawer };
  });

/** The whole sheet's text, for the refusal lines. */
const sheetText = (page: Page) =>
  page.evaluate(() => document.querySelector("#visor-drawer-inner")?.textContent ?? "");

/** Wait for the picker to be showing entries — the sheet is built
 * synchronously on open, so this is a settle, not a poll for a timer. */
async function waitForPicker(page: Page, want: boolean): Promise<void> {
  await page.waitForFunction(
    (w: boolean) =>
      // deno-lint-ignore no-explicit-any
      ((globalThis as any).__demo.picker.isOpen() === true) === w,
    want,
    { timeout: UI_TIMEOUT },
  );
}

const scenario: Scenario = {
  name: "storage-picker",
  why:
    "the provider choice happens in a sheet above the bar: two voice-marked lists, an armed selection, refusals in the sheet, and no payload from the page that asks for it",
  // ONE PROVIDER CONFIGURED AND NOTHING BOUND — the state the plural
  // store made expressible, and the state this whole scenario is about.
  // A record exists for s3 (someone filled the page in) and the app is
  // connected to nothing, because connecting is a separate act that has
  // not happened yet. Boot must therefore arm nothing, which is asserted
  // in the first act.
  page: () => ({
    storage: {
      [KEYS.storage]: JSON.stringify({
        bound: null,
        providers: {
          s3: {
            provider: "s3",
            endpoint: "https://store.example:9000",
            bucket: "pm-demo",
            access: "AKIAEXAMPLE",
          },
        },
      }),
    },
  }),

  async run(page) {
    await act("a CONFIGURED provider is not a CONNECTED one", async () => {
      // The demotion, read off the store: the record exists and the
      // binding is null, so boot armed nothing. Before the split there
      // was one record and its existence WAS the connection, which is
      // exactly the conflation the picker undoes — writing a
      // configuration on a page below the bar must not connect anything.
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding after a boot with a configured provider");
      assertList(store.configured, ["s3"], "the configured providers at boot");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet at boot");
    });

    await act("the page's opener REQUESTS the picker and passes nothing", async () => {
      // THE PAYLOAD-FREE OPENER (the ruling). The button lives on the
      // main page — app-adjacent pixels — so it may ask the visor to
      // start its ceremony and may not say anything about it: no
      // preselected provider, no filter. What proves it here is that the
      // click produces the SAME sheet the visor would have built on its
      // own, with nothing chosen: both lists as the store dictates, and
      // no navigation to any provider's page.
      await page.click("#storage-open");
      await waitForPicker(page, true);
      assertEquals(await onStoragePage(page), false, "the storage page after the opener");
      const lists = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.picker.lists()
      );
      assertList(lists.configured, ["s3"], "list (a) from the opener");
      assertList(lists.unconfigured, ["dropbox"], "list (b) from the opener");
      // Nothing is preselected: no entry is pressed, checked or focused.
      const focused = await page.evaluate(() =>
        document.activeElement?.classList.contains("picker-entry") === true
      );
      assertEquals(focused, false, "a preselected entry after a payload-free open");
      // The strip names the sheet hanging off it, as it does for every
      // other ceremony: "which pixels am I choosing in" has a visor-side
      // answer.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "storage", "the strip while the picker is open");
    });

    await act("the two lists are on two axes: (a) is CONFIG state, the voice is NAMING state", async () => {
      const rows = await entries(page);
      const s3 = entry(rows, "s3");
      const dropbox = entry(rows, "dropbox");
      assert(s3 !== undefined, "no s3 entry in the picker");
      assert(dropbox !== undefined, "no dropbox entry in the picker");
      assertEquals(s3!.group, "picker-configured", "the configured provider's list");
      assertEquals(dropbox!.group, "picker-unconfigured", "the unconfigured provider's list");
      // BOTH are unnamed here, so both wear APP VOICE — and s3 is in
      // list (a) anyway. That is the orthogonality, stated as a fact
      // about one sheet: a configured-but-unnamed provider sits in (a)
      // wearing app voice + NEW.
      assertEquals(s3!.foreign, "panel-s3", "the app-voice token on the configured entry");
      assertEquals(s3!.petname, null, "a petname on an unnamed entry");
      assertEquals(s3!.fresh, true, "the NEW marker on an unnamed entry");
      assertEquals(dropbox!.foreign, "panel-dropbox", "the app-voice token on the unconfigured entry");
      assertEquals(dropbox!.fresh, true, "the NEW marker on an unnamed entry");
      // The plated token is the PROVENANCE KEY — what the visor fetched
      // the panel by — and never a nickname the component chose for
      // itself, because a provider that has not run this session has
      // made no claim about itself at all.
      const foreignInside = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#visor-drawer-inner .picker-entry .foreign")).every(
          (el) => el.textContent?.startsWith("panel-") === true,
        )
      );
      assertEquals(foreignInside, true, "an app-voice token that is not a provenance key");
      // And the visor's OWN description of the provider is NOT inside
      // the plate: it is the visor speaking, so it carries no marking.
      const whatIsFramework = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#visor-drawer-inner .picker-entry-what")).every(
          (el) => el.closest(".foreign") === null,
        )
      );
      assertEquals(whatIsFramework, true, "the visor's own words inside an app-voice plate");
    });

    await act("a selection DURING the arming delay is a NO-OP", async () => {
      // The same claim credential-flow makes about Confirm, for the same
      // reason and by the same means: the driver CLICKS the real button,
      // so an entry armed too early would show up here as a credential
      // sheet appearing. Selection is the act that spends — it connects
      // the app to a destination — so it pays the arming tax.
      await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.picker.close()
      );
      await waitForPicker(page, false);
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      // Read the disabled state FIRST, before any round-trip has had a
      // chance to burn through ARM_MS.
      const early = await page.evaluate(() => ({
        disabled: (document.querySelector(
          "#picker-configured .picker-entry",
        ) as HTMLButtonElement).disabled,
        armed: document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        // The way OUT is live from the first frame: the delay defends
        // against spending, and dismissing the sheet spends nothing.
        closeDisabled: (document.querySelector(
          ".picker-row button",
        ) as HTMLButtonElement).disabled,
      }));
      assertEquals(early.disabled, true, "the selection entry during the arming delay");
      assertEquals(early.armed, false, "the sheet's armed marker during the arming delay");
      assertEquals(early.closeDisabled, false, "the sheet's Close button during the arming delay");
      await hook(page, "picker.select", "s3");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after an early click");
      assertEquals(await onStoragePage(page), false, "the storage page after an early click");
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding after an early click");
    });

    await act("a refusal renders IN THE SHEET and binds nothing", async () => {
      // The commit-time destination checks used to print on the storage
      // page, below the bar. They are statements about a COMMITMENT the
      // user just tried to make in trusted pixels, so they moved with
      // it. The provocation is a hand-edited store — which is the real
      // threat model for a localStorage record, not a hypothetical.
      await page.waitForFunction(
        () => document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await page.evaluate((key: string) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            bound: null,
            providers: { s3: { provider: "s3", endpoint: "not-a-url", bucket: "b", access: "a" } },
          }),
        );
      }, KEYS.storage);
      // Reopen so the sheet is built from the edited store.
      await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.picker.close()
      );
      await waitForPicker(page, false);
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      await page.waitForFunction(
        () => document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "picker.select", "s3");
      const text = await sheetText(page);
      assertIncludes(text, "no usable destination", "the refusal line in the picker sheet");
      // THE THREE THINGS A REFUSAL MUST LEAVE ALONE.
      assertEquals(await sheetOpen(page, "picker"), true, "the picker after a refusal");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after a refusal");
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding after a refusal");
    });

    await act("a record filed under the WRONG provider is never OFFERED", async () => {
      // The other integrity check on a hand-editable store: a dropbox
      // blob sitting in the s3 slot must never be connected as S3.
      //
      // AND IT IS REFUSED EARLIER THAN THE SELECTION. The first draft of
      // this act expected a refusal line, because that is where the old
      // page-side checks lived; the loader drops the record instead, so
      // the entry does not appear in list (a) at all and there is
      // nothing to press. That is the stronger outcome — an offer the
      // visor would have to refuse is an offer it should not have made —
      // so this asserts the behaviour rather than the expectation.
      // (`selectProvider` keeps the same check as defence in depth, for
      // the paths that do not come from the loader.)
      await page.evaluate((key: string) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            bound: null,
            providers: {
              s3: {
                provider: "dropbox",
                appKey: "k",
                appSecret: "s",
                accessToken: "t",
                refreshToken: "r",
                root: "/",
              },
            },
          }),
        );
      }, KEYS.storage);
      await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.picker.close()
      );
      await waitForPicker(page, false);
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      const rows = await entries(page);
      assertEquals(
        entry(rows, "s3")?.group,
        "picker-unconfigured",
        "a record filed under the wrong provider was offered for selection",
      );
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#picker-configured .picker-entry").length
        ),
        0,
        "an entry in list (a) built from a mismatched record",
      );
      // And a click on the entry that IS there configures, never
      // connects: nothing is bound by the presence of a bad record.
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding with a mismatched record in the store");
    });

    await act("'set it up' walks to that provider's page and COLLAPSES the sheet to a band", async () => {
      // Three claims. (1) List (b) navigates: the entry the user pressed
      // decides which provider's page mounts, so the page no longer has
      // to guess (and no longer offers tabs to change its mind).
      // (2) The ceremony SURVIVES the detour — sheets are orthogonal to
      // navigation, the ruling this flow leans on rather than building
      // close-and-reopen machinery for.
      // (3) It survives COLLAPSED (#22's band). The interim behaviour was
      // that the picker simply stayed at full height, which meant the
      // ceremony sat on top of the place it had just sent the user to;
      // the band shrink-wraps to the chosen entry, so the two questions
      // that are live during the detour get one short line each: the
      // strip says who is drawing below, the band says what step of the
      // user's own ceremony this is.
      await page.evaluate((key: string) => localStorage.removeItem(key), KEYS.storage);
      await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.picker.close()
      );
      await waitForPicker(page, false);
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      const rows = await entries(page);
      assertEquals(
        entry(rows, "s3")?.group,
        "picker-unconfigured",
        "a provider with no record is offered for configuration",
      );
      await hook(page, "picker.configure", "dropbox");
      await waitForStoragePage(page, true);
      await waitForPanelSurface(page);
      assertEquals(await sheetOpen(page, "picker"), true, "the picker over the config page");
      assertEquals(await pickerMode(page), "band", "the picker's shape over the config page");
      // ONLY THE CHOSEN ENTRY. A band still offering the other providers
      // would be the full picker with a smaller font — the point is that
      // it is a breadcrumb for the choice already made.
      const band = await bandState(page);
      assertEquals(band?.provider, "dropbox", "the provider the band shrink-wraps");
      assertEquals(band?.entries, 1, "the number of entries in the band");
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#visor-drawer-inner .picker-entry").length
        ),
        0,
        "list entries still rendered inside the band",
      );
      // The status is the visor's own words about the visor's own
      // ceremony: framework voice, no marking.
      assertIncludes(await sheetText(page), "configuring", "the band's status line");
      // TRUSTED CHROME BUDGET. Strip plus band, against the strip alone:
      // the ruling puts the whole assembly at about two to three strip
      // heights, so the ceremony is legible and still not the thing on
      // screen. (Asserted as a ratio, since the strip's own height is a
      // measured property that varies with viewport.)
      //
      // A claim about the BAND's budget, not about the mid-collapse
      // sheet's — the collapse from full sheet to band is itself a
      // height transition, so this has to wait for the band to actually
      // come to rest before reading its chrome, or it is measuring
      // whatever height the collapse happened to be passing through.
      await settleDrawer(page);
      const chrome = await chromeGeometry(page);
      assert(
        chrome.total <= chrome.strip * 3,
        `the band pushed total visor chrome past three strip heights: ${JSON.stringify(chrome)}`,
      );
      assert(
        chrome.drawer > 0 && chrome.total > chrome.strip,
        `the band is not on screen at all: ${JSON.stringify(chrome)}`,
      );
      // The page that mounted is the one the entry named — read off the
      // panel's own surface, not off the entry that asked for it.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "Dropbox", "the strip's surface line on the configured provider's page");
    });

    await act("the band is INERT: the one thing it still does is close", async () => {
      // "No selection, no arming, no navigation." Asserted at the level
      // that makes it true by construction rather than by handler: the
      // band's entry is NOT A CONTROL, so there is nothing to click
      // through, nothing to arm and nothing to disable. A disabled
      // button would have been the weaker version of this claim.
      const band = await bandState(page);
      assertEquals(band?.isControl, false, "the band's entry is a button");
      // And a real click on it changes nothing: same page, same binding,
      // same shape.
      await page.click(".picker-band .band-entry");
      assertEquals(await onStoragePage(page), true, "the page after clicking the band's entry");
      assertEquals(await pickerMode(page), "band", "the picker's shape after clicking the entry");
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding after clicking the band's entry");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after clicking the band");
    });

    await act("a ceremony over the config page SWAPS the band out — it is suspended, not closed", async () => {
      // THE DRAWER'S SECOND MOTION (#22). Naming is the invited case:
      // the panel arriving on its own page is NEW and the strip offers
      // to name it, so the user starts a second ceremony in the middle
      // of the first one. Neither stacking nor silent eviction is
      // acceptable — one would put two ceremonies on the anchor at once,
      // the other would destroy a choice the user is halfway through —
      // so the band slides out and WAITS.
      // THE SAMPLER STARTS BEFORE THE HOOK: the swap is triggered by
      // `hook` below, and the whole point is to catch the motion from
      // its first frame, not just its settled end state. It samples two
      // numbers per frame for ~25 frames: the outgoing slide's
      // translated X (read off the CSS transform matrix, since that is
      // what `.visor-slide.to-left`/`.to-right` actually animates) and
      // the drawer inner's computed height, because the rework put both
      // on the SAME curve — a swap whose height jumped while its sheets
      // slid would be the exact regression this guards, distinct from
      // either motion being individually present.
      //
      // `document.querySelector("#visor-drawer-inner .visor-swap-out")`
      // is a bare descendant selector, deliberately: the travelling
      // element is a `.visor-slide` wrapper now (mounted around the
      // sheet so the travel is a full 100% of the drawer's width — see
      // visor.ts's SWAP_MS comment), not the `.picker-band` itself, so
      // querying `.picker-band.visor-swap-out` would find nothing.
      const motionSampler = page.evaluate(() =>
        new Promise<{ x: number[]; height: number[] }>((resolve) => {
          const inner = document.getElementById("visor-drawer-inner")!;
          const x: number[] = [];
          const height: number[] = [];
          const tick = () => {
            const out = inner.querySelector(".visor-swap-out") as HTMLElement | null;
            if (out) {
              x.push(Math.round(new DOMMatrixReadOnly(getComputedStyle(out).transform).m41));
            }
            height.push(Math.round(parseFloat(getComputedStyle(inner).height)));
            if (height.length >= 25) resolve({ x, height });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })
      );
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      // SUSPENDED: session alive, drawer someone else's. The structural
      // half is that the band is not in the drawer any more.
      assertEquals(await pickerMode(page), "suspended", "the picker's shape under a ceremony");
      assertEquals(await sheetOpen(page, "picker"), true, "the picker session under a ceremony");
      assertEquals(await bandState(page), null, "the band while another sheet holds the drawer");
      // AND IT TRAVELS RATHER THAN BLINKING OUT: the departing band is
      // still on screen for the length of the motion — that IS the
      // motion, the page track's grammar at drawer scale — and the host
      // removes it when the travel is done. Both halves are claims: a
      // swap with no overlap would be a cut, and a leftover element
      // would be a leak.
      //
      // AND THE MOTION IS REAL, ON BOTH AXES: distinct X samples mean
      // the outgoing slide actually travelled rather than being cut in
      // place, and distinct height samples over the same window mean
      // the drawer's height moved WITH that travel rather than snapping
      // to the incoming sheet's size the instant the swap began.
      const motion = await motionSampler;
      const distinctX = new Set(motion.x).size;
      assert(
        distinctX >= MIN_DISTINCT_SAMPLES,
        `the outgoing slide's X took only ${distinctX} distinct value(s) over ` +
          `${motion.x.length} samples (${motion.x.join(",")}) — it was cut out rather than ` +
          `travelling`,
      );
      const distinctHeight = new Set(motion.height).size;
      assert(
        distinctHeight >= MIN_DISTINCT_SAMPLES,
        `the drawer's height took only ${distinctHeight} distinct value(s) over ` +
          `${motion.height.length} samples (${motion.height.join(",")}) — it jumped instead of ` +
          `moving on the same curve as the travel`,
      );
      await page.waitForFunction(
        () => document.querySelectorAll("#visor-drawer-inner .visor-swap-out").length === 0,
        undefined,
        { timeout: SWAP_MS + 2_000 },
      );
      assertEquals(
        await page.evaluate(() =>
          document.querySelectorAll("#visor-drawer-inner .picker-band").length
        ),
        0,
        "a band left in the drawer after the swap",
      );
      // THE PLACE IS BRACKETED for the ceremony's duration: the visor's
      // own dim is up and the page below is inert.
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-dim") as HTMLElement).hidden),
        false,
        "the visor dim while a ceremony is up over the config page",
      );
      assertEquals(
        await page.evaluate(() =>
          document.getElementById("page-storage")!.hasAttribute("inert")
        ),
        true,
        "the config page while a ceremony is up over it",
      );
      // AND THE PANEL IS STILL LIVE. Inert is not retirement: the
      // component keeps running and keeps its grants, and what it loses
      // is the user's input for as long as the ceremony is on screen.
      // Retiring it instead would destroy a configuration session the
      // user is coming back to.
      assertEquals(
        await page.evaluate(() => document.querySelectorAll("#panel-region iframe").length),
        1,
        "the panel's surface while a ceremony is up over its page",
      );
      assertEquals(await onStoragePage(page), true, "the page under the ceremony");
    });

    await act("closing the ceremony brings the band BACK, and un-brackets the page", async () => {
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.picker.mode() === "band",
        undefined,
        { timeout: UI_TIMEOUT },
      );
      const band = await bandState(page);
      assertEquals(band?.provider, "dropbox", "the band after the ceremony closed");
      assertEquals(
        await page.evaluate(() => (document.getElementById("visor-dim") as HTMLElement).hidden),
        true,
        "the visor dim after the ceremony closed",
      );
      assertEquals(
        await page.evaluate(() =>
          document.getElementById("page-storage")!.hasAttribute("inert")
        ),
        false,
        "the config page after the ceremony closed",
      );
      assertEquals(await onStoragePage(page), true, "the page after the ceremony closed");
    });

    await act("LEAVING the place mid-ceremony: the band waits for the ceremony, not for the page", async () => {
      // THE EXIT ORDER THAT COMPOSES BADLY IF NOTHING THINKS ABOUT IT.
      // The chevron walks the page out from under an open ceremony
      // (sheets are orthogonal to history — the established ruling), so
      // the detour ends while the band is still suspended. The band must
      // NOT come back at that moment: re-expanding underneath a ceremony
      // would be the picker shoving its way on screen while the user is
      // in the middle of something else. It re-expands when the ceremony
      // closes, which is when the drawer is theirs to give back.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      assertEquals(await pickerMode(page), "suspended", "the picker before the page exit");
      await page.click("#visor-back");
      await waitForStoragePage(page, false);
      // The ceremony survived the page exit (names outlive visits) and
      // the band is still waiting behind it.
      assertEquals(await sheetOpen(page, "naming"), true, "the naming sheet after the page exit");
      assertEquals(await pickerMode(page), "suspended", "the picker after the page exit");
      assertEquals(await bandState(page), null, "the band after the page exit");
      // NOW the ceremony closes, and the picker comes back EXPANDED —
      // the detour is over, so what returns is the full choice, not the
      // breadcrumb for a place nobody is in any more.
      await hook(page, "naming.cancel");
      await waitForSheet(page, "naming", false);
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.picker.mode() === "expanded",
        undefined,
        { timeout: UI_TIMEOUT },
      );
      assertEquals(await bandState(page), null, "a band after returning home");
      assert(
        (await entries(page)).length > 0,
        "the picker's lists after re-expanding from a suspended band",
      );
    });

    await act("the page's Save WRITES a record, connects nothing, and RE-EXPANDS the band", async () => {
      // SAVE, DEMOTED. It used to bind the destination, retire the panel
      // and open the credential sheet — a commitment entered from below
      // the bar. It now writes this provider's record and walks back:
      // the store gains a configured provider and the binding does not
      // move. This is the strictly stronger claim, because the old flow
      // could not make it at all.
      //
      // AND THE RETURN IS THE CONFIRMATION. The band re-expands with its
      // lists REBUILT, so the provider the user just configured is seen
      // to move from "installed, not configured yet" to "pick one to
      // connect". That movement is the whole reason the ceremony stays
      // alive across the detour: it is what tells the user the trip they
      // just took accomplished something.
      await hook(page, "picker.configure", "dropbox");
      await waitForStoragePage(page, true);
      await waitForPanelSurface(page);
      assertEquals(await pickerMode(page), "band", "the picker's shape on the way in");
      const before = await entries(page);
      assertEquals(before.length, 0, "list entries visible while the band is up");

      await page.click("#storage-save");
      await waitForStoragePage(page, false);
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after Save");
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertList(store.configured, ["dropbox"], "the configured providers after Save");
      assertEquals(store.bound, null, "the binding after Save");
      // Re-expanded, same ceremony, refreshed lists.
      await page.waitForFunction(
        // deno-lint-ignore no-explicit-any
        () => (globalThis as any).__demo.picker.mode() === "expanded",
        undefined,
        { timeout: UI_TIMEOUT },
      );
      assertEquals(await sheetOpen(page, "picker"), true, "the picker session across the detour");
      assertEquals(await bandState(page), null, "a band after returning from the page");
      const after = await entries(page);
      assertEquals(
        entry(after, "dropbox")?.group,
        "picker-configured",
        "the just-configured provider's list after returning",
      );
    });

    await act("re-expansion RE-ARMS: the delay is per presentation, not per session", async () => {
      // A picker that had armed before the detour must not come back
      // already armed. The user's hand is wherever the page's Save
      // button was, the sheet has just changed shape underneath it, and
      // the entry that lands there connects the app to a provider — the
      // exact baited-mis-tap geometry the delay exists for.
      //
      // The click is real, so an entry armed too early would show up
      // here as a credential sheet appearing.
      const early = await page.evaluate(() => ({
        disabled: (document.querySelector(
          "#picker-configured .picker-entry",
        ) as HTMLButtonElement).disabled,
        armed: document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
      }));
      assertEquals(early.disabled, true, "the re-expanded selection entry's arming");
      assertEquals(early.armed, false, "the re-expanded sheet's armed marker");
      await hook(page, "picker.select", "dropbox");
      assertEquals(await sheetOpen(page, "drawer"), false, "a credential sheet after an early click");
      const store = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.storageStore()
      );
      assertEquals(store.bound, null, "the binding after an early click on a re-expanded picker");
    });

    await act("DISMISSING the band ends the ceremony: the return lands plain", async () => {
      // The one interaction the band keeps is the way out, and it means
      // what it says: a user who closes their own sheet has ended the
      // ceremony, so coming back from the page finds no picker waiting —
      // not the band, and not a re-expanded picker either. The visor
      // does not reinstate a ceremony the user dismissed.
      await page.waitForFunction(
        () => document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "picker.configure", "s3");
      await waitForStoragePage(page, true);
      assertEquals(await pickerMode(page), "band", "the picker's shape before the dismissal");
      await hook(page, "picker.dismissBand");
      await waitForPicker(page, false);
      assertEquals(await pickerMode(page), "closed", "the picker after dismissing the band");
      // Still on the page: dismissing the ceremony is not an exit from
      // the place. The place has its own exits, and this is not one.
      assertEquals(await onStoragePage(page), true, "the page after dismissing the band");
      await page.click("#storage-cancel");
      await waitForStoragePage(page, false);
      assertEquals(await sheetOpen(page, "picker"), false, "a picker after returning from a dismissed ceremony");
      await waitForDrawerHidden(page);
    });

    await act("SELECTION connects: the credential sheet follows the choice, not the save", async () => {
      // THE HANDOFF, moved. The credential sheet follows SELECTION, and
      // the ordering invariant it depends on comes with it: NO COMPONENT
      // SURFACE IS ALIVE WHEN A SECRET IS ON SCREEN.
      //
      // THAT INVARIANT IS NOW HELD BY CONSTRUCTION, which is what this
      // act checks. Selection is only reachable from the EXPANDED
      // picker, the picker is only expanded at home, and the way home
      // runs `closeStorage` — which retires the panel. There is no state
      // in which a selection is made over a live panel, so there is no
      // ordering to get wrong. (The band is the reason: while a config
      // page is up the picker is a breadcrumb with nothing to press. The
      // previous version of this act selected from a full-height picker
      // sitting over a live page and relied on the handler tearing
      // things down in the right order; the shape change turned an
      // ordering discipline into a structural impossibility.)
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      assertEquals(await pickerMode(page), "expanded", "the picker's shape at home");
      assertEquals(await onStoragePage(page), false, "a config page when a selection is possible");
      assertEquals(
        await page.evaluate(() => document.querySelectorAll("#panel-region iframe").length),
        0,
        "a live panel surface when a selection is possible",
      );
      await page.waitForFunction(
        () => document.querySelector(".picker-sheet")?.classList.contains("armed") === true,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "picker.select", "dropbox");
      await waitForSheet(page, "drawer", true, 30_000);
      assertEquals(await onStoragePage(page), false, "the storage page while the credential sheet is up");
      assertEquals(await sheetOpen(page, "picker"), false, "the picker after the ceremony completed");
      const frames = await page.evaluate(() =>
        // deno-lint-ignore no-explicit-any
        (globalThis as any).__demo.frameProbe().appFrames
      );
      // The app's own panes are frames too; what must be gone is the
      // PANEL's.
      assertEquals(
        await page.evaluate(() => document.querySelectorAll("#panel-region iframe").length),
        0,
        `a live panel surface while a secret is on screen (frames: ${frames})`,
      );
      // The sheet is bound to the destination the CHOSEN record points
      // at — the binding the picker established, which is what the
      // sheet's own line names.
      assertEquals(
        await page.evaluate(() =>
          // deno-lint-ignore no-explicit-any
          (globalThis as any).__demo.boundDestination()
        ),
        "https://api.dropboxapi.com",
        "the destination the credential sheet is bound to",
      );
      // The strip names the sheet that owns the drawer now.
      const { bottom } = await stripText(page);
      assertIncludes(bottom, "storage credentials", "the strip during credential entry");
    });

    await act("a credential sheet NEVER arrives in slid-in mode", async () => {
      // The credential sheet is the one occupant that must never be part
      // of the drawer's second motion: it is exclusive, it is the end of
      // the ceremony rather than a step inside one, and a sheet that
      // slid in over a suspended band would imply something waiting
      // behind it to come back. Nothing does — the picker is closed by
      // the selection that opened this sheet.
      //
      // Asserted as the CONSTRUCTION the dispatch names, not as new
      // machinery: no sheet is suspended, and the credential sheet
      // carries no swap marking.
      const state = await page.evaluate(() => ({
        swapped: document.querySelectorAll(
          "#visor-drawer-inner .visor-swap-in, #visor-drawer-inner .visor-swap-out",
        ).length,
        // deno-lint-ignore no-explicit-any
        pickerMode: (globalThis as any).__demo.picker.mode(),
      }));
      assertEquals(state.swapped, 0, "swap marking on the credential sheet");
      assertEquals(state.pickerMode, "closed", "a suspended ceremony behind the credential sheet");
    });

    await act("naming an entry changes its VOICE and not its LIST", async () => {
      // THE ORTHOGONALITY, as a before/after on one entry. Cancel the
      // credential sheet first (nothing was released), name the provider
      // through the visor's own ceremony, then reopen the picker: same
      // group, different voice.
      // The credential sheet's Cancel is ARMED like everything else on
      // it, so the driver waits the delay out exactly as a user would.
      await page.waitForFunction(
        () =>
          (document.querySelector("#visor-drawer-inner .cred-row button:last-child") as
            | HTMLButtonElement
            | null)?.disabled === false,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      await hook(page, "drawer.cancel");
      await waitForSheet(page, "drawer", false);
      await page.evaluate((key: string) => {
        // The petname is written through the visor's trust table, which
        // is the same table the ceremony writes: what is under test here
        // is the PICKER's reading of it, not the ceremony (which
        // petname-ceremony owns).
        localStorage.setItem(
          key,
          JSON.stringify({ "panel-dropbox": { petname: "my dropbox", icon: "●", firstSeen: 1 } }),
        );
      }, KEYS.marks);
      await hook(page, "picker.open");
      await waitForPicker(page, true);
      const rows = await entries(page);
      const dropbox = entry(rows, "dropbox");
      assertEquals(dropbox?.group, "picker-configured", "the list after naming");
      assertEquals(dropbox?.petname, "my dropbox", "the user-voice token after naming");
      assertEquals(dropbox?.icon, "●", "the pet icon after naming");
      assertEquals(dropbox?.foreign, null, "an app-voice plate on a NAMED entry");
      assertEquals(dropbox?.fresh, false, "the NEW marker on a named entry");
      // And the user's word is NOT inside a plate — the structural half
      // of the claim, which is the half that would catch a regression
      // that renders the petname through the app-voice constructor.
      const plated = await page.evaluate(() =>
        document.querySelector("#visor-drawer-inner .picker-entry .petname")?.closest(".foreign") !==
          null
      );
      assertEquals(plated, false, "the user's own word rendered as an app-voice token");
    });
  },
};

export default scenario;
