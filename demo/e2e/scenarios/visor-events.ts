// THE EVENT RECORD (#132): announced-never-silent stops being hollow.
//
// The strip's announcement is twelve seconds on a bar the user may not
// be watching, and on a multi-device account consequential things happen
// while you are away BY CONSTRUCTION. The split #132 rules makes the
// announcement the ARRIVAL and adds a memory behind it: every
// CONSEQUENTIAL announcement leaves a record, the identity circle wears
// a dot while something is unseen, and the list is a drawer sheet
// reached from the settings sheet. This scenario walks that whole path
// once, in order, because every beat of it is a claim no other scenario
// makes:
//
//   1. a genuinely remote-caused, genuinely CONSEQUENTIAL event lands —
//      not a synthetic call into the visor, so the mechanical rule
//      itself is under test and not just the storage;
//   2. the badge lights on `#visor-settings` (a dot, no text, and the
//      button's label gains the standing sentence);
//   3. the settings sheet's own row counts what is waiting, in the
//      visor's words;
//   4. the list holds the sentence the strip said, and OPENING MARKS IT
//      SEEN — the dot goes out with the sheet still up;
//   5. closing RESUMES settings (the erase entry's suspend/resume
//      motion, which is the whole reason the row suspends rather than
//      closes);
//   6. a reload finds the record still there and the badge still dark —
//      the records persist at `eventsKey`, and so does the seen mark.
//
// WHERE THE EVENT COMES FROM, and why this one. `?pairing=mock` boots
// the demo against the in-page `PairingDriver` (device-pairing-mock.ts's
// backend), and host/demo.ts's boot calls `reconcileFromDriver` — the
// step that compares the localStorage BOOT CACHE against what the
// account actually says and ANNOUNCES the difference (visor/ui/pairing.ts:
// "a silently-changed hue/name is exactly the 'anchor that quietly
// changes' lesson"). So this scenario seeds a boot cache holding a name
// the account does not have, and boot reconciliation announces the
// correction as consequential. That is the cheapest honest source of a
// real one: engine-authored, remote in kind, and travelling the exact
// sink every other consequential line travels. (The pairing join flow
// would work too, at ten times the ceremony for the same one record.)
//
// THE ACCOUNT'S NAME IS THE IDENTITY RECORD'S. host/demo.ts creates the
// user-system group from `visor.identity().name` when no profile exists
// yet, so seeding the identity with a name and the boot NAME CACHE with
// a different one produces exactly one disagreement, worded by
// `reconcileFromDriver` and by nothing this file wrote.

import type { Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  assertIncludes,
  hook,
  KEYS,
  sheetText,
  UI_TIMEOUT,
  waitForBoot,
  waitForSheet,
} from "../util.ts";

/** The user's own name, as their account will hold it. */
const ACCOUNT_NAME = "Ada";
/** What the stale boot cache claims instead — the disagreement
 * reconciliation announces. Obviously synthetic, and never anything the
 * account itself was told. */
const STALE_CACHED_NAME = "Bea";

/** The demo's user-system boot-cache keys (visor/ui/pairing.ts's
 * `usCacheKeys("pm-demo")`, whose prefix host/demo.ts passes). Mirrored
 * rather than imported for the same reason `KEYS` is — a rename there
 * should fail this scenario loudly. */
const US_NAME_CACHE = "pm-demo-us-name-cache";

/** The sentence `reconcileFromDriver` announces for a name that changed
 * underneath the boot cache, quoted here exactly as that function words
 * it (visor/ui/pairing.ts) so a reworded announcement fails this
 * scenario rather than silently drifting from it. */
const RECORDED_LINE = `your name is now "${ACCOUNT_NAME}" (synced from your account)`;

/** Is the dot on the identity circle? A pure DOM read of the visor's own
 * pixels — the badge is a child of `#visor-settings` with no text at
 * all, so its PRESENCE is the whole signal. */
function badgeLit(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    document.querySelector("#visor-settings .visor-badge") !== null
  );
}

/** The settings button's standing sentence — the badge's only non-visual
 * channel (the dot is `aria-hidden`, deliberately). */
function settingsLabel(page: Page): Promise<string> {
  return page.evaluate(() =>
    document.getElementById("visor-settings")?.getAttribute("aria-label") ?? ""
  );
}

/** Open the event list the way a user does: the settings sheet's own
 * row, clicked. Never a handler call — the row's whole job is the
 * suspend/resume motion around the click. */
async function openEventsSheet(page: Page): Promise<void> {
  await page.click("#visor-settings-events");
  await page.waitForFunction(
    () => document.querySelector("#visor-drawer-inner .events-sheet") !== null,
    undefined,
    { timeout: UI_TIMEOUT },
  );
}

const scenario: Scenario = {
  name: "visor-events",
  why:
    "a consequential announcement leaves a record: the identity circle's badge lights, the settings row counts it, the list holds the sentence, opening marks it seen, and both the record and the seen-mark survive a reload",
  page: {
    // The in-page pairing driver: no wasm, no relay, no convergence wait
    // — the same choice device-pairing-mock.ts makes, and for the same
    // reason (everything above the driver seam is the code under test).
    query: { pairing: "mock" },
    storage: {
      [KEYS.identity]: JSON.stringify({ name: ACCOUNT_NAME }),
      // THE STALE CACHE that makes boot reconciliation have something to
      // say. Written before any page script runs, which is the only
      // moment it can be a BOOT cache.
      [US_NAME_CACHE]: STALE_CACHED_NAME,
    },
  },

  async run(page: Page) {
    await act("boot reconciliation announces the account's name, and the badge lights", async () => {
      // THE APPEARANCE IS THE ASSERTION, not the absence: the drain and
      // the reconcile both run inside boot, so a "no dot yet" read taken
      // after `waitForBoot` would be racing the very event this scenario
      // is about. The clean absence assertion is the LAST beat, after
      // the list has been seen and the page reloaded — there the state
      // is settled and a dark badge is a claim rather than a coin toss.
      await page.waitForFunction(
        () => document.querySelector("#visor-settings .visor-badge") !== null,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      assert(await badgeLit(page), "the badge should be lit by the reconciliation event");
      assertIncludes(
        await settingsLabel(page),
        "recent events waiting",
        "the settings button's label while the badge is lit",
      );
    });

    await act("the settings sheet's own row says how many are unseen, in the visor's words", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      const text = await sheetText(page);
      // SINGULAR, and the count is inline on the row rather than on the
      // badge (the badge is a dot, never a number — #132).
      assertIncludes(text, "recent events — 1 unseen", "the settings sheet's event row");
    });

    await act("the list holds the sentence the strip said, and opening MARKS IT SEEN", async () => {
      await openEventsSheet(page);
      const text = await sheetText(page);
      assertIncludes(text, "Recent events", "the event sheet's heading");
      assertIncludes(text, RECORDED_LINE, "the record the announcement left");
      // The age is coarse and rendered once, at open.
      assertIncludes(text, "just now", "the record's relative age");
      // No condition stands on the demo page, so the standing block must
      // not render at all — an empty "ongoing:" rule would be the visor
      // implying a live fault that does not exist.
      assert(
        !text.includes("ongoing:"),
        `no condition stands, so no standing block should render: ${JSON.stringify(text)}`,
      );
      // OPENING IS THE ACKNOWLEDGMENT: the dot is out while the sheet is
      // still on screen.
      assertEquals(await badgeLit(page), false, "the badge after opening the list");
      assertEquals(
        await settingsLabel(page),
        "your visor: name, device, colour",
        "the settings button's label once nothing is waiting",
      );
    });

    await act("closing the list RESUMES the settings sheet underneath it", async () => {
      // The erase entry's motion (visor/ui/sheets.ts): the row SUSPENDED
      // settings rather than closing it, so the host slides settings
      // back in on this close — there is nothing here that re-opens it.
      await page.click(".events-sheet .cred-row button");
      await waitForSheet(page, "settings", true);
      const text = await sheetText(page);
      assertIncludes(text, "your visor", "the resumed settings sheet");
      // And the row it was opened from is back, now with nothing unseen
      // to count.
      assertIncludes(text, "recent events", "the resumed sheet's event row");
      assert(
        !text.includes("unseen"),
        `nothing is unseen after the list was opened: ${JSON.stringify(text)}`,
      );
      await hook(page, "settings.cancel");
      await waitForSheet(page, "settings", false);
    });

    await act("the record and the seen-mark both survive a reload", async () => {
      // Same browser context: localStorage is the point of this beat.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page);

      // THE CLEAN ABSENCE ASSERTION (see beat 1). The boot cache now
      // agrees with the account — `reconcileFromDriver` refreshed it —
      // so this boot announces nothing, nothing is unseen, and no
      // condition stands. A lit badge here would mean either the
      // seen-mark did not persist or the reconciliation re-announced a
      // difference that no longer exists.
      assertEquals(await badgeLit(page), false, "the badge after a reload with nothing waiting");

      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      await openEventsSheet(page);
      assertIncludes(
        await sheetText(page),
        RECORDED_LINE,
        "the record after a reload — the list persists at the demo's eventsKey",
      );
    });
  },
};

export default scenario;
