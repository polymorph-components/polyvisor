// "ERASE THIS DEVICE" ON THE SOLO PAGE — and the device is actually
// gone afterwards.
//
// THE COMPLAINT THIS SCENARIO IS ABOUT. The visor's erase ceremony has
// always wiped what the VISOR holds (visor-reset.ts is that claim, on
// the three-pane demo). On the solo page the consumer's half used to
// wipe three localStorage caches and nothing else — so the reload that
// ends the ceremony walked straight back into the same device, unsealed
// the same namespace, and the account was simply THERE again. Everything
// the sheet promised was true of the visor and false of the device.
//
// WHAT ERASE MEANS HERE, ruled: this device leaves. Not the account —
// other paired devices keep their own copies, and nothing on this page
// can or should reach them (visor-reset.ts's semantics ruling, which
// this scenario inherits rather than restates). What goes is THIS
// device's whole namespace: the IndexedDB database, the OPFS directory,
// and the index row that made it pickable (runtime/device-store's
// `destroyNamespace`) — plus the sessionStorage anchor that pointed at
// it.
//
// WHOSE HAND DOES THE DELETING, and why it is not this page's. The
// device lives in a SharedWorker, and the worker is the only thing that
// can drain its own checkpoint chain and drop its engine before the
// storage goes. A page deleting a live device's database would race a
// debounced background checkpoint into recreating the files it just
// removed — orphaned storage with no index row, which nothing would ever
// collect. So the ceremony asks the host to erase ITSELF and die
// (`conn.destroy()`), and awaits the answer, because a failure has to be
// able to refuse the ceremony.
//
// THE POST-CONDITION THAT IS THE USER'S ACTUAL COMPLAINT is the first
// one asserted below: the reload lands on the FIRST-RUN FORK, with
// "join another device" there to press. A user who erased a device in
// order to re-pair it must be able to re-pair it.

import type { Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, UI_TIMEOUT, waitForBoot } from "../util.ts";
import { appFrame, solo, until, WAITS } from "../solo-util.ts";

/** The reset sheet arms itself after a delay the drawer host owns; the
 * `armed` class is the moment the controls become real (the same signal
 * visor-reset.ts waits on, scoped here to the solo page's drawer). */
async function waitForArmed(page: Page, timeout = UI_TIMEOUT): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector("#visor-drawer-inner .reset-sheet")?.classList
        .contains("armed") === true,
    undefined,
    { timeout },
  ).catch(async (e) => {
    const state = await solo(page, "reset.armingState");
    throw new Error(`waiting for the reset sheet to arm: ${JSON.stringify(state)} (${e.message})`);
  });
}

/** IS THE NAMESPACE STILL THERE? Both halves, asked the way the store
 * itself names them (runtime/device-store/names.ts: `pm-device-<id>` for
 * both the database and the OPFS directory).
 *
 * `indexedDB.databases()` is Chromium-only, which is exactly the browser
 * this harness drives. The OPFS half asks WITHOUT `create`, so a
 * `NotFoundError` is the answer rather than an accident — and the error
 * NAME is what is reported, because "it threw" would also be true of a
 * quota failure or a security error, which would mean something else
 * entirely. */
function namespaceState(
  page: Page,
  id: string,
): Promise<{ db: boolean; dirError: string }> {
  return page.evaluate(async (deviceId: string) => {
    const name = `pm-device-${deviceId}`;
    const dbs = await indexedDB.databases();
    let dirError = "present";
    try {
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle(name);
    } catch (e) {
      dirError = (e as { name?: string })?.name ?? "unknown";
    }
    return { db: dbs.some((d) => d.name === name), dirError };
  }, id);
}

/** The index's own keys — the list a boot can offer (`INDEX_DB` /
 * `INDEX_STORE` in names.ts). Read directly rather than through the
 * page's `devices` hook, which narrows rows to what a PICKER may see and
 * so does not carry the id this scenario has to compare against.
 *
 * Opened with no version, so this cannot create or upgrade anything: if
 * the index were somehow absent the read answers an empty list, which is
 * the honest shape of "no device is listed". */
function indexKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open("pm-devices");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("devices")) {
          db.close();
          resolve([]);
          return;
        }
        const keys = db.transaction("devices", "readonly").objectStore("devices").getAllKeys();
        keys.onerror = () => {
          db.close();
          reject(keys.error);
        };
        keys.onsuccess = () => {
          db.close();
          resolve(keys.result.map(String));
        };
      };
    })
  );
}

const scenario: Scenario = {
  name: "solo-erase",
  why:
    "erasing a solo device destroys its namespace and index row, so the reload lands on the first-run fork with pairing offered again — not back inside the old account",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    // The committed anchor hue, for the reason every solo scenario seeds
    // it: an unseeded boot spends its first 15 seconds announcing a
    // fresh colour over the line these acts read.
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(page: Page) {
    let erasedId = "";

    await act("a device, an account, and a mounted app to lose", async () => {
      assertEquals(
        await page.evaluate(() => document.getElementById("first-run")?.hidden === false),
        true,
        "the first-run fork is on screen before there is an account",
      );
      await solo(page, "newAccount");
      await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
      await appFrame(page).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      erasedId = (await solo(page, "deviceId")) as string;
      assert(erasedId !== "", "the page reported no device id");
      // The premise, stated rather than assumed: the thing about to be
      // erased really is on disk under its own name right now, so the
      // post-conditions below are a change and not a coincidence.
      const before = await namespaceState(page, erasedId);
      assertEquals(before.db, true, "the device's database before the erase");
      assert(
        (await indexKeys(page)).includes(erasedId),
        "the device is not listed in the index before the erase",
      );
    });

    await act("the ceremony opens from settings and states the device's own consequence", async () => {
      await solo(page, "openSettings");
      await solo(page, "reset.openFromSettings");
      await page.waitForFunction(
        () => document.querySelector("#visor-drawer-inner .reset-sheet") !== null,
        undefined,
        { timeout: UI_TIMEOUT },
      );
      // THE CONSUMER'S OWN LINES (`resetConsequences`): the visor lists
      // what IT holds, and only the page knows that a device's copy of
      // the account goes too. A ceremony that did not say so would be
      // erasing more than it named.
      const text = await page.evaluate(() =>
        document.querySelector("#visor-drawer-inner .reset-sheet .cred-danger")?.textContent ?? ""
      );
      assertIncludes(text, "this device's copy of your account", "the device consequence line");
    });

    await act("the erase control is behind the arming delay, then live", async () => {
      const before = await solo(page, "reset.armingState");
      assertEquals(before.btnDisabled, true, "the erase button before arming");
      await waitForArmed(page);
      const after = await solo(page, "reset.armingState");
      assertEquals(after.btnDisabled, false, "the erase button once armed");
    });

    await act("the typed challenge confirms, and the page reloads", async () => {
      // THE FIXED-WORD CHALLENGE. This page seeds no name, and a new
      // account's profile carries none either, so the sheet falls back
      // to the visor's own word (visor/ui/sheets.ts's `want`). Asserted
      // rather than assumed: if a name ever did arrive on this path the
      // typed word below would be the wrong one, and a scenario that
      // silently typed a mismatch would "pass" by never erasing
      // anything.
      const label = await page.evaluate(() =>
        document.querySelector("#visor-drawer-inner .reset-sheet label")?.textContent ?? ""
      );
      assertIncludes(label, "type erase to confirm", "the fixed-word challenge label");
      await solo(page, "reset.type", "erase");
      // THE RELOAD IS PART OF THE CEREMONY (visor/ui/sheets.ts), so it
      // is waited for as a navigation rather than polled around.
      const navigated = page.waitForEvent("load", { timeout: WAITS.boot });
      await solo(page, "reset.erase");
      await navigated;
      await waitForBoot(page, "__solo");
    });

    await act("THE COMPLAINT: the first-run fork is back, with pairing offered again", async () => {
      const fork = await page.evaluate(() => ({
        visible: document.getElementById("first-run")?.hidden === false,
        joinBtn: document.getElementById("solo-join-account") !== null,
        newBtn: document.getElementById("solo-new-account") !== null,
      }));
      assertEquals(fork.visible, true, "the first-run fork after the erase");
      assertEquals(fork.joinBtn, true, "'join another device' after the erase");
      assertEquals(fork.newBtn, true, "'new account' after the erase");
      assertEquals(await solo(page, "hasAccount"), false, "the account after the erase");
    });

    await act("the erased device's namespace is gone: database, directory, index row", async () => {
      const state = await namespaceState(page, erasedId);
      assertEquals(state.db, false, `pm-device-${erasedId} (the database) survived the erase`);
      assertEquals(
        state.dirError,
        "NotFoundError",
        `pm-device-${erasedId} (the OPFS directory) survived the erase`,
      );
      // The index row goes LAST in `destroyNamespace`, so its absence is
      // also the claim that the two deletions before it completed.
      const keys = await indexKeys(page);
      assert(
        !keys.includes(erasedId),
        `the erased device is still listed in the index: ${JSON.stringify(keys)}`,
      );
      // The boot after an erase makes a device of its own (there is no
      // account yet, but there is a page), so "the index is empty" would
      // be the wrong claim — "the OLD id is not in it" is the right one,
      // and this pins that the two are genuinely different devices.
      assert(
        (await solo(page, "deviceId")) !== erasedId,
        "the page came back on the device it just erased",
      );
    });
  },
};

export default scenario;
