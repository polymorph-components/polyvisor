// THE DEVICE THAT WAS NEVER KEPT — T0, and the strip rule about how
// many devices there are.
//
// TWO CLAIMS, and they are different in kind.
//
// FIRST, T0 SURVIVES A RELOAD WITHOUT BEING DURABLE. The worker-host
// spike measured Chromium respawning the SharedWorker on EVERY
// single-tab reload (the zero-client window at navigation), so a T0
// device cannot survive by worker memory and does not try to: the tab
// holds the ONLY pointer to its namespace, in sessionStorage, and hands
// it to the fresh worker, which rehydrates from the checkpoint
// (PERSISTENCE.md, "T0 reload survival: the sessionStorage anchor").
// Reload is therefore the strongest thing a T0 device is claimed to
// survive — and the todo list surviving one is that claim, made with
// real data through the real app.
//
// SECOND, THE DEVICE-NAME DISPLAY RULE (ruled, PERSISTENCE.md's "Unseal
// UX"): the strip shows this device's petname whenever this browser's
// index holds MORE THAN ONE device — pickable, not merely active. One
// device: no label, it is noise. Both halves are asserted, which needs
// two devices in one browser and therefore the picker.
//
// WHY A SECOND TAB RATHER THAN A SECOND CONTEXT. A second browser
// context would be a second browser — its own IndexedDB, its own index,
// and therefore two profiles with one device each, which is not the
// situation the rule is about. The rule is about ONE browser holding
// several devices, so the second device has to be made in the SAME
// context; and since sessionStorage is per-tab, a second tab is exactly
// a boot with no anchor, which is precisely the boot that meets the
// picker. The two facts fit together rather than being arranged.
//
// The picker does NOT auto-open the first tab's T0 device, and that is
// deliberate (host/solo.ts's auto-unseal condition): a T0 device belongs
// to one tab and the anchor is the only thing that says which, so a tab
// arriving without one is offered the row rather than dropped into
// someone else's ephemeral device.

import type { Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, solo, until, WAITS } from "../solo-util.ts";

const scenario: Scenario = {
  name: "solo-ephemeral",
  why:
    "an unkept T0 device survives a reload through its anchor, and the strip names a device only when there is more than one",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(page: Page) {
    await act("a T0 device, an account, and a todo — no ceremony anywhere", async () => {
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "nothing was kept");
      await solo(page, "newAccount");
      await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
      await appFrame(page).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      await addTodo(page, "water the plants");
      const titles = await until([page], "the todo", async () => {
        const t = (await solo(page, "todos")) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "water the plants", `the todos: ${JSON.stringify(titles)}`);
    });

    await act("one device: the strip carries NO device label", async () => {
      assertEquals((await solo(page, "devices") as unknown[]).length, 1, "one device in the index");
      assertEquals(await solo(page, "deviceLabel"), "", "and therefore no label on the anchor");
    });

    await solo(page, "checkpoint");

    await act("a REAL reload: the anchor resumes this tab's device, silently", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      // THE C1 RULE, made observable: the tab's own pointer is what
      // resolved this boot, and it did so without a picker.
      assert(trace.includes("anchor:t0"), `boot trace: ${JSON.stringify(trace)}`);
      assert(!trace.includes("picker:wait"), `no picker for an anchored tab: ${trace}`);
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "still ephemeral — surviving a reload is not being kept");
      assertEquals(st.resumed, true, "and it RESUMED from the checkpoint");
      const titles = await until([page], "the resumed todo", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "water the plants", `resumed todos: ${JSON.stringify(titles)}`);
    });

    // --- a second device, in the same browser --------------------------
    const tab2 = await page.context().newPage();
    (tab2 as unknown as { __log: string[] }).__log = [];
    await tab2.goto(page.url(), { waitUntil: "domcontentloaded" });
    await waitForBoot(tab2, "__solo");

    await act("a second tab meets the picker rather than someone else's device", async () => {
      const trace = (await solo(tab2, "bootTrace")) as string[];
      assert(trace.includes("index:1"), `trace: ${JSON.stringify(trace)}`);
      assert(!trace.includes("anchor:t0"), `a fresh tab has no anchor: ${trace}`);
      assert(trace.includes("picker:wait"), `trace: ${JSON.stringify(trace)}`);
      const picker = await solo(tab2, "picker");
      assertEquals(picker.visible, true, "the picker is on screen");
      assertEquals(picker.rows.length, 1, `the picker's rows: ${JSON.stringify(picker.rows)}`);
      // GENERIC CHROME: the row is a petname and nothing else. The
      // colour and the name are not painted here — solo-persistence
      // makes that claim in full, at the moment it is stable.
      assertEquals(picker.rows[0], "device 1", "the generated default petname");
    });

    await act("'set up a new device here' makes a second device", async () => {
      await solo(tab2, "newDevice");
      // WAIT FOR THE BOOT TO FINISH, not merely for the index to grow.
      // The new device's row exists the moment `connectDevice` creates
      // it — before the seal opens, before the visor is constructed, and
      // therefore before this page has any of the hooks that describe a
      // running device. Polling the index would win that race and then
      // ask a page that cannot yet answer.
      const st = await until([tab2], "the new device's page to come up", async () => {
        try {
          return await solo(tab2, "deviceStatus");
        } catch {
          return false;
        }
      }, WAITS.boot);
      assertEquals(
        (await solo(tab2, "devices") as unknown[]).length,
        2,
        "two devices in this browser's index",
      );
      assertEquals(st.tier, "t0", "a new device starts ephemeral too");
      assertEquals(
        await tab2.evaluate(() => document.getElementById("first-run")?.hidden === false),
        true,
        "and it holds no account: the fork is offered",
      );
    });

    await act("more than one device: the strip NAMES this one", async () => {
      // THE RULED RULE, positive half. The label is the index's petname,
      // in the visor's subordinate identity slot — the user's own word
      // for which of their things this is.
      const label = await until([tab2], "the device label", async () => {
        const l = (await solo(tab2, "deviceLabel")) as string;
        return l !== "" ? l : false;
      }, WAITS.boot);
      assertEquals(label, "device 2", "the second device names itself on the anchor");
    });

    await act("and the first tab names itself too, once it looks again", async () => {
      // The rule is about the INDEX, not about this tab, so the first
      // device gains a label as soon as its page re-reads the index —
      // which a reload is. Its own state is untouched by any of it.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const label = await until([page], "tab 1's device label", async () => {
        const l = (await solo(page, "deviceLabel")) as string;
        return l !== "" ? l : false;
      }, WAITS.boot);
      assertEquals(label, "device 1", "the first device, named now that there are two");
      const titles = await until([page], "the todo, still", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "water the plants", `tab 1's todos: ${JSON.stringify(titles)}`);
    });
  },
};

export default scenario;
