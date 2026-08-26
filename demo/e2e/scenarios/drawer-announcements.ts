// THE AUDIBLE ANCHOR WORD — provenance for people who cannot see the
// anchor colour.
//
// WHAT THIS SCENARIO IS ABOUT. Every anti-spoofing property the visor
// ships is VISUAL: a colour an app can never sample, a strip no
// component may draw in, plated app-voice tokens, a sheet that hangs off
// a pinned bar. A screen reader flattens all of it. App-frame text and
// visor text arrive in one undifferentiated stream, iframe boundaries
// are not announced at all, and so an app can render, inside its own
// rectangle, a sentence that SOUNDS exactly like the visor speaking.
//
// The answer is the same shape as the colour: a word rolled once per
// identity, never rendered in pixels, never crossing the visor API, and
// spoken as the FIRST TOKEN of every drawer lifecycle sentence. The acts
// below are the properties that makes true:
//
//   - the word PREFIXES the sentence, and the rest of the sentence is
//     framework vocabulary (`DrawerTenantSpec.spoken`), so nothing an
//     app could have influenced ever rides behind the user's own token;
//   - open, close and resume ("back") each get a sentence, and they are
//     spoken BY THE HOST, so a tenant cannot forget one;
//   - a SUSPEND is silent — audibly covered by the displacing tenant's
//     own open — and the resume is what closes the pair;
//   - two sentences emitted in the SAME synchronous block (a close that
//     resumes the occupant underneath) both survive, which is the whole
//     reason `speak` is a queue rather than a bare live-region write;
//   - and the word is spoken and NEVER DRAWN: nothing in the visor's
//     pixels, sheets included, contains it.
//
// The word is SEEDED by the harness (`seedWord` in e2e/util.ts). It has
// to be: the sentence under test is "<word>: <sheet> <verb>", which can
// only be asserted against a word the test chose.

import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, hook, seedWord, UI_TIMEOUT, waitForSheet } from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** START ACCUMULATING what `#visor-live` says, from now on.
 *
 * POLL-AND-ACCUMULATE, not a sample, and this is the only way to read
 * this region honestly. A live region holds ONE string; the visor's
 * speak queue deliberately replaces it every `SPEAK_DWELL_MS` so a
 * screen reader gets each sentence in turn. A test that reads the region
 * once therefore sees whichever sentence happens to be resident, which
 * for a two-sentence transition is a coin flip. The MutationObserver
 * installed here records every distinct value the region ever holds, so
 * an assertion can ask "was this said?" instead of "is this showing?".
 *
 * Installed in the page rather than polled from the driver because a
 * driver-side poll can miss a sentence entirely: the dwell is ~1.4s but
 * nothing in the contract promises the driver a turn inside it.
 */
async function recordLive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    // Idempotent: a scenario that calls this twice keeps ONE observer and
    // one log, so a re-arm never doubles every sentence.
    if (g.__liveLog !== undefined) return;
    const log: string[] = [];
    g.__liveLog = log;
    const el = document.getElementById("visor-live");
    if (el === null) throw new Error("no #visor-live on this page");
    const push = () => {
      const t = el.textContent ?? "";
      // The queue's clear-then-set writes "" between sentences; that is
      // delivery machinery, not something anybody hears.
      if (t !== "" && log[log.length - 1] !== t) log.push(t);
    };
    push();
    new MutationObserver(push).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

/** Everything `#visor-live` has held since `recordLive`. */
function liveLog(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((globalThis as unknown as Record<string, unknown>).__liveLog as string[] ?? []).slice()
  );
}

/** Wait until the live region has SAID `sentence` at some point, and
 * return the whole log. Bounded by `UI_TIMEOUT`, and the failure message
 * carries the log — a wrong sentence is far more useful to read than a
 * bare timeout. */
async function waitSaid(page: Page, sentence: string): Promise<string[]> {
  await page.waitForFunction(
    (want: string) =>
      (((globalThis as unknown as Record<string, unknown>).__liveLog as string[]) ?? []).includes(
        want,
      ),
    sentence,
    { timeout: UI_TIMEOUT },
  ).catch(async (e) => {
    const log = await liveLog(page);
    throw new Error(
      `#visor-live never said ${JSON.stringify(sentence)} (${e.message}); it said ${
        JSON.stringify(log)
      }`,
    );
  });
  return await liveLog(page);
}

/** The index of a sentence in the log, or -1. Used for ORDER claims. */
function at(log: string[], sentence: string): number {
  return log.indexOf(sentence);
}

/** The LAST index of a sentence, or -1 — for the claims that are about a
 * sentence NOT being said again, where the first occurrence is exactly
 * the one that must be ignored. */
function lastAt(log: string[], sentence: string): number {
  return log.lastIndexOf(sentence);
}

/** Wait for the erase ceremony's own sheet to be mounted in the drawer.
 *
 * Read off the DOM rather than through `waitForSheet`, which only knows
 * the tenants the demo publishes a predicate for (`__demo` has no
 * `drawer` handle, and the erase ceremony's `__demo.reset.open` is the
 * sheets module's predicate rather than a tenant one). `.reset-sheet` is
 * the class the ceremony's own sheet carries, and `:not(.visor-swap-out)`
 * is the same distinction the demo's picker handle draws: a sheet
 * travelling off-stage is still in the DOM for the length of the motion
 * and has already stopped being the occupant. */
async function waitForResetSheet(page: Page, want: boolean): Promise<void> {
  await page.waitForFunction(
    (want: boolean) =>
      (document.querySelectorAll("#visor-drawer-inner .reset-sheet:not(.visor-swap-out)").length >
          0) === want,
    want,
    { timeout: UI_TIMEOUT },
  ).catch((e) => {
    throw new Error(`waiting for the erase sheet to be ${want ? "open" : "gone"}: ${e.message}`);
  });
}

/** IS THE WORD DRAWN? — the pixel-policy probe, and the whole reason it
 * needs care is that `#visor-live` legitimately CONTAINS the word.
 *
 * The live region is the audible channel. It is visually hidden by the
 * clip-rect recipe rather than by `display:none` (a display:none live
 * region is not announced at all — visor.ts says so where it builds the
 * element), which means it is still in the layout and still in
 * `innerText`. Excluding it by id would be a test that trusts the id; so
 * this excludes it by MEASUREMENT instead — the region must actually be
 * clipped to a degenerate box, and everything else on the page must not
 * contain the word. A regression that made the live region visible
 * therefore fails here rather than being excluded along with it.
 *
 * Returns the offending element descriptions, so a failure names what
 * drew it.
 *
 * SCOPE: LIGHT DOM ONLY — the walk descends `children`, so it enters no
 * shadow root and no same-origin iframe document. That is complete
 * TODAY, because every pixel the visor draws is light DOM in this
 * document (the app frame is a separate, opaque origin the word never
 * reaches). Revisit if the visor ever renders into a shadow root. */
async function drawnOccurrences(page: Page, word: string): Promise<string[]> {
  return await page.evaluate((w: string) => {
    const hits: string[] = [];
    const live = document.getElementById("visor-live");
    if (live !== null) {
      const r = live.getBoundingClientRect();
      // The clip-rect recipe leaves a 1x1-ish box. Anything larger is a
      // live region that became visible, which is a real leak.
      if (r.width > 2 || r.height > 2) {
        hits.push(`#visor-live is VISIBLE (${Math.round(r.width)}x${Math.round(r.height)})`);
      }
    }
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        if (child === live) continue;
        walk(child);
      }
      // Own text only, so an ancestor is not blamed for a descendant.
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("");
      if (own.includes(w)) hits.push(`${el.tagName.toLowerCase()}.${el.className}: ${own.trim()}`);
      // Attributes travel to pixels too — a title becomes a tooltip, and
      // an aria-label is read out as though it were the control's name.
      for (const attr of ["title", "aria-label", "placeholder", "value", "alt"]) {
        const v = el.getAttribute(attr);
        if (v !== null && v.includes(w)) hits.push(`${el.tagName.toLowerCase()}[${attr}]: ${v}`);
      }
    };
    if (document.body !== null) walk(document.body);
    return hits;
  }, word);
}

const scenario: Scenario = {
  name: "drawer-announcements",
  why:
    "every drawer sheet opens, closes and resumes with a spoken sentence prefixed by the user's own anchor word — and the word is never drawn",
  page: {},

  async run(page) {
    const W = seedWord;

    await act("the seeded word is the visor's, and nothing on the page draws it", async () => {
      await recordLive(page);
      // The pixel policy, asserted against the DOM rather than against
      // the page's own account of itself: the word is an AUDIBLE channel
      // precisely because pixels travel (screenshots, screen-shares,
      // recordings), so a rendered word would hand an app the one token
      // it must never be able to guess.
      const drawn = await drawnOccurrences(page, W);
      assertEquals(
        drawn.length,
        0,
        `the anchor word ${JSON.stringify(W)} is drawn on the page: ${JSON.stringify(drawn)}`,
      );
      // And no getter leaks it either — the Visor interface has none, by
      // construction (visor/ui/visor.ts, `speakWord`). This is the
      // structural half of the same claim.
      const hasGetter = await page.evaluate(() => {
        const d = (globalThis as unknown as Record<string, unknown>).__demo as
          | Record<string, unknown>
          | undefined;
        return d !== undefined && "committedWord" in d;
      });
      assertEquals(hasGetter, false, "a word getter on the driving handle");
    });

    await act("opening the settings sheet speaks the word, then the sheet's own name", async () => {
      await hook(page, "settings.openSheet");
      await waitForSheet(page, "settings", true);
      const log = await waitSaid(page, `${W}: visor settings open`);
      // FRAMEWORK VOCABULARY AFTER THE COLON. The sheet is announced by
      // what the visor calls it, never by a component's own string —
      // there is no way to plate app voice in a flat spoken sentence, so
      // an app-influenced token here would arrive behind the user's own
      // anchor word, wearing the exact provenance the word exists to
      // make unforgeable.
      assert(
        !log.some((s) => s.includes("TodoMVC")),
        `the live region carried a component's own name: ${JSON.stringify(log)}`,
      );
    });

    // The settings -> erase step is the framework's ONE suspension path
    // on this page (visor/ui/sheets.ts's `settingsSuspends`), which makes
    // it the only place the full open/suspend/close/resume quartet can be
    // driven — so all three remaining claims live in this one act.
    await act("a displacing sheet speaks its open; the suspended one stays silent", async () => {
      await hook(page, "reset.openFromSettings");
      await waitForResetSheet(page, true);
      const log = await waitSaid(page, `${W}: erase this visor open`);
      // SUSPEND IS SILENT, on purpose: the sheet that displaced this one
      // just announced itself, and a second sentence about the sheet
      // going away would narrate machinery rather than the screen. It is
      // the RESUME that closes the pair.
      assert(
        !log.includes(`${W}: visor settings closed`),
        `a suspended sheet announced a close: ${JSON.stringify(log)}`,
      );
    });

    await act("cancelling speaks the close AND the resume — both, in order", async () => {
      await hook(page, "reset.cancel");
      await waitForResetSheet(page, false);
      // THE PAIR THE QUEUE EXISTS FOR. `close()` speaks its own "closed"
      // and then, in the SAME synchronous block, resumes the occupant
      // waiting underneath, which speaks "back". Against a bare live
      // region the second write destroys the first and a non-visual user
      // is never told the erase ceremony ended. Both must be present,
      // and in this order.
      await waitSaid(page, `${W}: erase this visor closed`);
      const log = await waitSaid(page, `${W}: visor settings back`);
      const closed = at(log, `${W}: erase this visor closed`);
      const back = at(log, `${W}: visor settings back`);
      assert(
        closed !== -1 && back !== -1 && closed < back,
        `expected the close before the resume, got ${JSON.stringify(log)}`,
      );
      // "back", not "open": the user already heard this sheet open once,
      // and the second half of a displacement is a return. LAST
      // occurrence, deliberately — `at`/indexOf would find the ORIGINAL
      // open from the first act and be satisfied by it, so a resume that
      // ALSO re-announced an open would slip through. Asking where the
      // open sentence was said LAST is the claim the comment makes.
      assert(
        lastAt(log, `${W}: visor settings open`) < closed,
        `the settings sheet re-announced an open on resume: ${JSON.stringify(log)}`,
      );
    });

    await act("closing the last sheet speaks its close", async () => {
      await hook(page, "settings.cancel");
      await waitForSheet(page, "settings", false);
      await waitSaid(page, `${W}: visor settings closed`);
    });

    await act("the word is STILL not drawn, after four sheet transitions", async () => {
      // Re-asserted at the end rather than only at the start: the sheets
      // that came and went are exactly the surfaces that could have
      // rendered it, and a leak into a sheet body would be invisible to
      // the boot-time check above.
      const drawn = await drawnOccurrences(page, W);
      assertEquals(
        drawn.length,
        0,
        `the anchor word ${JSON.stringify(W)} reached the pixels: ${JSON.stringify(drawn)}`,
      );
      // ...and it WAS spoken, several times over — the point is that the
      // channel is audible-only, not that the mechanism went quiet.
      const log = await liveLog(page);
      assert(
        log.filter((l) => l.startsWith(`${W}: `)).length >= 4,
        `expected the word to have prefixed several sentences: ${JSON.stringify(log)}`,
      );
    });
  },
};

export default scenario;
