// THE ACCOUNT OUTLIVES ITS LAST DEVICE — runtime/RECOVERY.md's whole
// claim, made executable against a real browser and a real MinIO.
//
// This is the round's money shot, and what makes it one is the DESTROYED
// CONTEXT in the middle. A fresh Playwright `BrowserContext` is a wiped
// browser: no IndexedDB, no localStorage, no sessionStorage, no OPFS, no
// SharedWorker, no device index, no escrowed credential. Nothing of the
// first half survives into the second except two things the user
// carried: the recovery phrase they wrote down, and the storage
// credentials they know. That is exactly the disaster the feature is
// for, and it is the reason this scenario cannot be written as a reload.
//
// FIVE CLAIMS, in the order the record makes them:
//
//   1. A KIT IS MINTED THROUGH THE REAL SHEET (RECOVERY.md, "The kit
//      ceremony"): the storage sheet's own control, the phrase kind, and
//      a phrase displayed ONCE in visor pixels behind an explicit
//      confirm-dismiss — no timer, because a user copying ten words must
//      not be racing one.
//   2. THE ACCOUNT COMES BACK ON A VIRGIN BROWSER, with no live peer
//      anywhere: the todos are present afterwards, which is the only
//      assertion that distinguishes "an account was restored" from "a
//      device was made".
//   3. THE VISOR CLAIMS AT THE END (RECOVERY.md, "Restore"; the
//      anti-spoofing sentence): nothing personal is on screen while the
//      ceremony is collecting, and the colour and the name arrive
//      together from the PULLED profile. Both halves are asserted —
//      the absence before, the presence after — because only the pair
//      is the property.
//   4. THE KIT IS CONSUMED, AND SAID SO (RECOVERY.md, "Single-use"):
//      "your recovery kit was used — create a new one" reaches the
//      strip, and the account's kit list is empty afterwards. The
//      announcement is the honest half of the bargain: a window with no
//      kit, loudly.
//   5. THE SAME PHRASE REFUSES A SECOND TIME, in a THIRD virgin
//      context, with the sheet's own plain sentence rather than a raw
//      seam error — and the ceremony stays usable, which is the "no
//      wedged ceremony" rule.
//
// Claim 5 is what makes claim 4 more than a message: double-restore is
// an identity fork (two live instances of one identity clobbering each
// other's keyed oplog names), and consumption is what makes the fork
// structurally impossible rather than merely discouraged.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, createAccount, setAccountName, solo, stripPersonal, until, WAITS } from "../solo-util.ts";
import type { Page } from "npm:playwright@1.57.0";

const BUCKET = "pm-recovery";
// The harness's own MinIO root credentials — synthetic by construction
// (run.ts's `Minio` class), never anything a person would type.
const ACCESS = "minioadmin";
const SECRET = "minioadmin";
const TODOS = ["buy the milk", "call the bank"];

/** Open settings → storage, the way a user reaches that sheet. */
async function openStorageSheet(page: Page) {
  await page.evaluate(() => {
    (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
  });
  await page.waitForFunction(
    () =>
      (document.querySelector(
        '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
      ) as HTMLButtonElement | null) !== null,
    undefined,
    { timeout: 15_000 },
  );
  await solo(page, "openStorageSheet");
}

/** Drive the restore ceremony's own fields and press its own button.
 *
 * A DRIVER, NOT A CLAIM (solo-util.ts's rule for this shape): it asserts
 * nothing, so a scenario's assertions all live in the scenario. */
async function fillRestore(
  page: Page,
  opts: { endpoint: string; phrase: string; deviceName: string },
) {
  await page.waitForSelector("#restore-sheet", { state: "visible", timeout: WAITS.boot });
  // The phrase kind is the default, but the driver clicks it anyway: a
  // default is a thing that can change, and a scenario that silently
  // rode one would stop testing what it says it tests.
  await page.click("#restore-kind-phrase");
  await page.click("#restore-dest-s3");
  await page.fill("#restore-endpoint", opts.endpoint);
  await page.fill("#restore-bucket", BUCKET);
  await page.fill("#restore-access", ACCESS);
  await page.fill("#restore-secret", SECRET);
  await page.fill("#restore-phrase", opts.phrase);
  await page.fill("#restore-device-name", opts.deviceName);
  await page.click("#restore-go");
}

const scenario: Scenario = {
  name: "solo-recovery",
  why:
    "the account outlives its last device: a phrase kit minted through the real sheet restores the whole account — todos included — into a DESTROYED-and-recreated browser context, the visor claims from the pulled profile, and the spent phrase refuses a second time",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
    },
  },

  async run(page: Page, ctx: Ctx) {
    let phrase = "";

    await act("an account with work in it, and a bucket to keep it in", async () => {
      await createAccount(page);
      await setAccountName(page, "Ada");
      for (const t of TODOS) await addTodo(page, t);

      await openStorageSheet(page);
      await page.waitForSelector("#storage-endpoint", { timeout: 15_000 });
      await page.fill("#storage-endpoint", ctx.minioUrl);
      await page.fill("#storage-bucket", BUCKET);
      await page.fill("#storage-access", ACCESS);
      await page.fill("#storage-secret", SECRET);
      await page.click("#storage-connect");
      await until([page], "storage:bound", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:bound") ? t : false;
      }, 60_000);
    });

    await act("push the work to the bucket by hand, so the kit has something to find", async () => {
      // THE KIT IS A KEY TO THE BUCKET, NOT A COPY OF THE ACCOUNT
      // (RECOVERY.md, "The claim"), so a restore can only ever be as
      // fresh as what actually reached storage. Pressing Sync now is
      // what a user does; waiting for the scheduler would be waiting on
      // a cadence this scenario is not testing.
      await page.waitForSelector("#storage-sync", { state: "visible", timeout: 15_000 });
      await page.click("#storage-sync");
      await until([page], "storage:synced", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:synced") ? t : false;
      }, 60_000);
    });

    await act("mint a PHRASE kit through the storage sheet, and read it once", async () => {
      await page.click("#storage-kits");
      await page.waitForSelector("#recovery-make", { state: "visible", timeout: 15_000 });
      // THE ACCOUNT STARTS WITH NONE, which is the baseline claim 4
      // needs at the other end.
      await page.waitForSelector("#recovery-none", { timeout: 15_000 });
      await page.click("#recovery-kind-bucket");
      await page.fill("#recovery-label", "the paper one");
      await page.click("#recovery-make");

      await page.waitForSelector("#recovery-phrase", { state: "visible", timeout: 90_000 });
      phrase = (await page.textContent("#recovery-phrase") ?? "").trim();
      // The record pins the format: ten words from the EFF short list.
      // Asserting the SHAPE (not the words) is what catches a derivation
      // that silently changed under the ceremony.
      const words = phrase.split(/\s+/).filter((w) => w !== "");
      assertEquals(words.length, 10, `the phrase should be ten words, got: ${words.length}`);

      // NO TIMER: the phrase is still on screen, and the ceremony is
      // waiting for the user's word. Dismissing is what publishes the
      // kit to the list.
      await page.click("#recovery-phrase-done");
      await page.waitForSelector(".recovery-row", { timeout: 30_000 });
      const rows = await page.$$eval(".recovery-row", (els) => els.map((e) => e.textContent ?? ""));
      assertEquals(rows.length, 1, `one kit should be listed, got ${JSON.stringify(rows)}`);
      assertIncludes(rows[0], "phrase kit", "the listed kit names its kind");

      // THE PHRASE IS NEVER RENDERED AGAIN. There is no call that
      // returns it, so the list must not contain it either — a leak here
      // would turn a write-it-down secret into a read-it-later one.
      const sheetText = await page.textContent("#storage-sheet") ?? "";
      assert(
        !sheetText.includes(phrase),
        "the kit list rendered the phrase again after it was dismissed",
      );
    });

    await act("DESTROY the browser: a context close is a wiped browser", async () => {
      // Everything goes with it — the device index, the sealed device,
      // the escrowed signing key, the worker. What survives is what the
      // user carried out of the room in their hand.
      await page.context().close();
    });

    let fresh!: Page;
    await act("a virgin browser lands on the first-run fork, with nothing personal", async () => {
      fresh = await ctx.fresh({ path: "/solo.html", bootGlobal: "__solo" });
      // THE RECOVERY DOOR IS ON THE FORK because a browser with no
      // devices never sees the picker — and a browser with no devices is
      // exactly the browser a real recovery happens on.
      await fresh.waitForSelector("#solo-restore-account", { timeout: WAITS.boot });
      // THE ANTI-SPOOFING HALF THAT COMES FIRST: no name of the user's
      // anywhere on this screen, because the account is not in hand yet.
      const body = await fresh.evaluate(() => document.body.textContent ?? "");
      assert(!body.includes("Ada"), "a pre-restore screen must render nothing personal");
    });

    await act("restore: destination, credentials, the phrase, and a name for this machine", async () => {
      await fresh.click("#solo-restore-account");
      await fillRestore(fresh, {
        endpoint: ctx.minioUrl,
        phrase,
        deviceName: "the replacement laptop",
      });
      // The fork's door reaches the record's claim-at-the-end ordering
      // through a reload (solo.ts says why), so the wait is a BOOT wait,
      // not a selector wait.
      await until([fresh], "the restore to land", async () => {
        const problem = await fresh.$("#restore-problem");
        if (problem !== null && (await problem.isVisible())) {
          throw new Error(`the restore refused: ${await problem.textContent()}`);
        }
        return (await fresh.$("#restore-sheet")) === null;
      }, WAITS.boot);
      await waitForBoot(fresh, "__solo");
    });

    await act("the account is here: the todos came back through the bucket", async () => {
      const titles = await until([fresh], "the restored todos", async () => {
        const t = (await solo(fresh, "todos").catch(() => [])) as string[];
        return t.length >= TODOS.length ? t : false;
      }, WAITS.converge);
      for (const want of TODOS) {
        assertIncludes(titles.join(" | "), want, "a todo that was in the bucket");
      }
    });

    await act("the visor CLAIMED: colour and name arrived together, from the pulled profile", async () => {
      const personal = await until([fresh], "the claim", async () => {
        const p = await stripPersonal(fresh);
        return p.anchorColour !== "" && p.identityText.includes("Ada") ? p : false;
      }, WAITS.converge);
      assert(personal.anchorColour !== "", "the anchor colour is painted after the claim");
      assertIncludes(personal.identityText, "Ada", "the name came from the account, not the page");
    });

    await act("the kit was CONSUMED, and the visor said so", async () => {
      // `restore:announced` is the marker on THIS page. The ceremony's
      // own `restored` marker belongs to the page that ran it, and that
      // page's trace died with the reload the fork's door goes through —
      // which is the honest shape of the evidence here rather than a
      // gap: what is being asserted is that the RESTORED boot said the
      // sentence, not that some earlier page intended to.
      await until([fresh], "restore:announced", async () => {
        const t = (await solo(fresh, "bootTrace")) as string[];
        return t.includes("restore:announced") ? t : false;
      }, WAITS.converge);
      // THE SENTENCE ITSELF — the record's exact stance, read from the
      // page's own account of what it said rather than off the strip.
      // `visor.announce` REPLACES, and a restored boot has several other
      // things to say in the seconds that follow (the resume path's
      // reconcile among them), so a DOM read here would be asserting on
      // a race rather than on the copy.
      const announced = (await solo(fresh, "restoreAnnouncement")) as string;
      assertIncludes(announced, "recovery kit was used", "the record's exact stance");
      assertIncludes(announced, "create a new one", "the announcement says what to do next");

      // AND THE ACCOUNT AGREES WITH THE ANNOUNCEMENT. The sheet is
      // where a user goes to ask "do I still have a kit", and after a
      // restore the true answer is the one the visor just said out loud:
      // no, make a new one. A list still showing the spent kit would be
      // the sheet arguing with the visor about the single fact this
      // moment turns on — so "no kit, LOUDLY" (RECOVERY.md's honest
      // cost) has to be assertable on the restored device's own list,
      // not merely on the sentence.
      //
      // THIS IS A REGRESSION TEST WITH A KNOWN PAST. It did not pass
      // before the worker learned to checkpoint after a successful
      // consume: internal driver mutations bypass the debounce hooks, so
      // a restore's consume cleared the account record and flushed it
      // while the CHECKPOINT still predated the clear — and this
      // scenario's fork door goes through a reload, so the respawned
      // worker resumed exactly that stale checkpoint, with the pull
      // fan-out's self-filter keeping the flushed clear permanently out
      // of its own author's reach. The devstore matrix owns that
      // regression directly (row 61, with a negative control); this act
      // is the same fact seen from where the user sees it.
      await openStorageSheet(fresh);
      await fresh.waitForSelector("#storage-kits", { state: "visible", timeout: WAITS.boot });
      await fresh.click("#storage-kits");
      await fresh.waitForSelector("#recovery-none", { timeout: 60_000 });
      const kitList = (await fresh.textContent("#recovery-kits") ?? "").trim();
      assertIncludes(kitList, "no recovery kit", "the restored device's list says the kit is gone");
      const rowsLeft = await fresh.$$eval(".recovery-row", (els) => els.length);
      assertEquals(rowsLeft, 0, "the spent kit must not still be listed after a restore");
    });

    await act("a spent phrase refuses, in plain words, in a third virgin browser", async () => {
      const second = await ctx.fresh({ path: "/solo.html", bootGlobal: "__solo" });
      await second.waitForSelector("#solo-restore-account", { timeout: WAITS.boot });
      await second.click("#solo-restore-account");
      await fillRestore(second, {
        endpoint: ctx.minioUrl,
        phrase,
        deviceName: "should not happen",
      });
      const text = await until([second], "the refusal", async () => {
        const el = await second.$("#restore-problem");
        if (el === null || !(await el.isVisible())) return false;
        const t = (await el.textContent()) ?? "";
        return t.trim() === "" ? false : t;
      }, WAITS.boot);
      // A PLAIN SENTENCE, not a raw seam error: the refusal has to tell
      // someone mid-disaster what actually happened.
      assertIncludes(text, "recovery kit", "the refusal names what was not found");
      assertIncludes(text, "used up", "the refusal explains single-use");

      // NO WEDGED CEREMONY: the sheet is still up, still usable, and the
      // way back out is still there.
      assert(
        await second.isVisible("#restore-go"),
        "the ceremony must stay usable after a refusal",
      );
      assert(
        await second.isVisible("#restore-cancel"),
        "the way back out must survive a refusal",
      );
    });
  },
};

export default scenario;
