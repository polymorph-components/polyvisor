// THE DEVICE SURVIVES — PERSISTENCE.md's whole point, end to end.
//
// THE ARGUMENT. Before G5 every page load was a fresh device: the engine
// minted a new identity at boot, so an account created on one visit was
// gone on the next and the solo page's returning-visit branch was
// written for a future that had not arrived. This scenario is that
// future, driven as a user: make a device by using it, keep it, close
// the page for real, and find the same todo list behind the same name.
//
// FIVE CLAIMS, in the order a user meets them:
//
//   1. TRY, THEN KEEP (#37). The first visit asks NOTHING. A device
//      exists, it is T0, and nothing personal has touched disk unsealed.
//   2. THE PROMOTION CEREMONY IS WHERE THE SEAL CHOICES ARE ASKED, and
//      it says two things out loud that a comfortable UI would not: that
//      the device's name rests UNENCRYPTED (it has to — the picker reads
//      it before anything is open), and the honest sentence about what
//      the convenience rung is worth.
//   3. A REAL RELOAD, not a re-render: the browser tears the page down,
//      the SharedWorker with it (the spike measured Chromium respawning
//      it on every single-tab reload), and what comes back comes back
//      from the checkpoint.
//   4. UNSEAL IS THE LOGIN, and the ordering is the anti-spoofing tell:
//      the anchor colour and the user's name appear at the moment the
//      seal opens and NOT ONE PIXEL BEFORE. Asserted on both sides —
//      present after an auto-unseal, absent on the picker of a device
//      that is waiting to be opened.
//   5. RESEAL IS A REAL EXIT — and on a device that opens itself, an
//      UPGRADE: it asks what should unseal it from now on, rather than
//      quietly leaving a device nobody can open (see below).
//
// WHAT RESEAL MEANS FOR AN `until-reseal` DEVICE — recorded here because
// it is the interesting corner, and RULED rather than inferred.
//
// seal.ts is explicit: `reseal` deletes the platform wrap and the
// platform key handle, and the passphrase rung is "the only thing that
// can open the device after a reseal" (seal.ts's `enableUntilReseal`).
// A device kept on the `until-reseal` rung with no passphrase HAS a
// passphrase rung — but it is the one worker.ts's `sealT0` minted from
// 32 random bytes and dropped on the floor ("a door with no key"). So a
// plain reseal of that device would leave a picker row demanding a
// passphrase THAT NEVER EXISTED: a zombie entry, and a device destroyed
// as a side effect of signing out. Destruction is `removeDevice`'s job
// and is asked for explicitly.
//
// THE RULING: resealing such a device is an UPGRADE CEREMONY. The sheet
// asks for a new passphrase — "sealing this device means choosing what
// unseals it" — the worker re-keys the DEK from the platform rung
// (`rekeyFromPlatform`, and reseal time is exactly when that rung is
// still there to authorize it) and only then deletes the wrap. What
// comes back is an `every-session` device: sealed, openable by the
// passphrase just chosen, with the index's policy tag flipped so the
// picker demands it. A device that already has the user's own
// passphrase reseals with no extra ceremony.
//
// This scenario asserts the upgrade end to end: the sheet asks, the
// worker REFUSES an empty ceremony rather than destroying anything, the
// reload lands on a picker that demands the passphrase, a wrong one is
// refused cleanly, and the right one opens the device with the todo
// list intact.

import type { Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, solo, stripPersonal, until, WAITS } from "../solo-util.ts";

/** The user's own name, seeded so that "nothing personal before unseal"
 * has something personal to be about. A visor with no name renders no
 * name for the trivial reason, which would make the pre-unseal
 * assertion pass without meaning anything. */
const WHO = "Ada";

/** The passphrase the reseal ceremony upgrades this device onto, and one
 * that is not it. Obviously synthetic, and never anything a person would
 * actually use. */
const PASS = "correct-horse-battery-staple-TEST";
const PASS_WRONG = "definitely-not-the-passphrase-TEST";

const scenario: Scenario = {
  name: "solo-persistence",
  why:
    "a solo device is kept, survives a real reload behind its own name, opens without a ceremony, and reseals onto a passphrase it asks for",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: WHO }),
    },
  },

  async run(page: Page) {
    await act("the first visit asks nothing: a T0 device, and the fork", async () => {
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("index:0"), `boot trace: ${JSON.stringify(trace)}`);
      assert(trace.includes("first-device"), `boot trace: ${JSON.stringify(trace)}`);
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "a device starts ephemeral — try, then keep");
      assertEquals(st.sealed, false, "and it is open, with no ceremony");
      // The picker is not even on screen: there was nothing to pick.
      const pickerVisible = await page.evaluate(() =>
        document.getElementById("device-picker")?.hidden === false
      );
      assertEquals(pickerVisible, false, "no picker on a browser with no devices");
      assertEquals(
        await page.evaluate(() => document.getElementById("first-run")?.hidden === false),
        true,
        "the first-run fork is on screen",
      );
    });

    await act("an account and two todos, through the real app frame", async () => {
      await solo(page, "newAccount");
      await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
      await appFrame(page).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      await addTodo(page, "buy milk");
      await addTodo(page, "call the bank");
      const titles = await until([page], "two todos", async () => {
        const t = (await solo(page, "todos")) as string[];
        return t.length >= 2 ? t : false;
      }, WAITS.converge);
      assertEquals(titles.length, 2, `the todos: ${JSON.stringify(titles)}`);
    });

    await act("one device: the strip carries NO device label", async () => {
      // THE RULED DISPLAY RULE, negative half (PERSISTENCE.md, "Unseal
      // UX"): one device is not a choice, so naming it on the anchor is
      // noise.
      assertEquals(await solo(page, "deviceLabel"), "", "no device line with a single device");
    });

    await act("the 'keep this device' ceremony says what it costs", async () => {
      await solo(page, "openDevice");
      const sheet = await until([page], "the device sheet", async () => {
        const s = await solo(page, "deviceSheet");
        return s.open && s.keep ? s : false;
      }, 15_000);
      // THE UNENCRYPTED-INDEX SENTENCE. The petname rests in the clear
      // by design (index.ts's contract) and the ceremony that asks for
      // it has to say so — a user choosing a word for a picker is
      // entitled to know where the word goes.
      assertIncludes(sheet.text, "stored unencrypted", "the sheet discloses where the name rests");
      // THE HONEST SENTENCE about the convenience rung, in the page's
      // own words (PERSISTENCE.md's ladder; seal.ts's
      // `enableUntilReseal`).
      assertIncludes(
        sheet.text,
        "not protection against someone holding this browser",
        "the honest sentence for the until-reseal rung",
      );
      assert(sheet.reseal === false, "a device that is not kept yet has nothing to reseal");
    });

    await act("kept as 'laptop', on the until-reseal rung", async () => {
      assertEquals(
        await solo(page, "keepDevice", "laptop", "until-reseal"),
        true,
        "the ceremony's own controls took the choice",
      );
      const row = await until([page], "the promoted device", async () => {
        const ds = (await solo(page, "devices")) as { petname: string; tier: string }[];
        return ds.find((d) => d.tier === "t1") ?? false;
      }, 30_000);
      assertEquals(row.petname, "laptop", "the petname the ceremony asked for");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("promoted:until-reseal"), `trace: ${JSON.stringify(trace)}`);
    });

    // A CHECKPOINT ON PURPOSE, so the reload below is a claim about
    // persistence rather than a race with the worker's 500 ms debounce.
    // (The debounce would almost always win; "almost always" is how a
    // suite grows a flake.)
    await solo(page, "checkpoint");

    await act("a REAL reload: the picker offers 'laptop' and opens it silently", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("index:1"), `trace: ${JSON.stringify(trace)}`);
      // NOT THROUGH THE ANCHOR. The anchor is the T0 pointer; a kept
      // device is reached through the picker, which is the difference
      // this act exists to pin.
      assert(!trace.includes("anchor:t0"), `a kept device is not an anchored one: ${trace}`);
      assert(trace.includes("auto-unseal"), `trace: ${JSON.stringify(trace)}`);
      assert(trace.includes("picked:silent"), `the unseal asked nothing: ${trace}`);
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t1", "still kept");
      assertEquals(st.sealed, false, "and open");
      assertEquals(st.resumed, true, "the engine RESUMED rather than starting fresh");
    });

    await act("the visor became yours at the unseal: colour and name are up", async () => {
      const personal = await stripPersonal(page);
      assert(personal.anchorColour !== "", "the anchor colour is painted after the unseal");
      assertIncludes(personal.identityText, WHO, "the user's own name is on the strip");
    });

    await act("the todo list survived the reload", async () => {
      const titles = await until([page], "the resumed todos", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 2 ? t : false;
      }, WAITS.converge);
      assert(titles.includes("buy milk"), `resumed todos: ${JSON.stringify(titles)}`);
      assert(titles.includes("call the bank"), `resumed todos: ${JSON.stringify(titles)}`);
    });

    await act("the reseal control asks what should unseal this device", async () => {
      await solo(page, "openDevice");
      const sheet = await until([page], "the kept-device sheet", async () => {
        const s = await solo(page, "deviceSheet");
        return s.open && s.reseal ? s : false;
      }, 15_000);
      assertIncludes(sheet.text, "laptop", "the sheet names the device");
      // THE PLAIN SENTENCE (ruled). Not a warning about loss — a
      // statement of what the ceremony is for.
      assertIncludes(
        sheet.text,
        "Sealing this device means choosing what unseals it",
        "the upgrade ceremony says what it is",
      );
      assert(sheet.keep === false, "a kept device is not offered promotion again");
      // And the field is really there to be typed into.
      assertEquals(
        await page.evaluate(() => document.getElementById("device-reseal-pass") !== null),
        true,
        "the ceremony offers a passphrase field",
      );
    });

    await act("an empty ceremony is REFUSED — reseal never destroys by omission", async () => {
      // The worker's own refusal, reached through the sheet's own
      // controls: the arming click, the commit click, an empty field.
      // Nothing is deleted, and the device is still open behind the
      // sheet.
      await solo(page, "resealDevice", "");
      const problem = await until([page], "the refusal", async () => {
        const s = await solo(page, "deviceSheet");
        return s.problem !== "" ? s.problem : false;
      }, 15_000);
      assertIncludes(problem, "passphrase", "the refusal says what the ceremony needs");
      const st = await solo(page, "deviceStatus");
      assertEquals(st.sealed, false, "the device was not sealed by the failed ceremony");
      assertEquals(st.rungs.untilReseal, true, "and its platform wrap is untouched");
    });

    await act("reseal with a passphrase: the device becomes an every-session one", async () => {
      assertEquals(await solo(page, "resealDevice", PASS), true, "the ceremony took it");
      // The sheet reports its own failures, so a ceremony that refused
      // must fail HERE rather than three assertions later as a policy
      // tag that did not move.
      await until([page], "the ceremony to settle", async () => {
        const sheet = await solo(page, "deviceSheet").catch(() => null);
        if (sheet === null) return true; // the page is already reloading
        if (sheet.problem !== "") throw new Error(`the reseal refused: ${sheet.problem}`);
        return sheet.open === false ? true : false;
      }, 15_000);
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("index:1"), `trace: ${JSON.stringify(trace)}`);
      // THE POLICY TAG FLIPPED, which is what the picker reads before
      // attaching anything — a device that now opens by passphrase must
      // say so in the one unsealed place read that early.
      const rows = await solo(page, "devices") as { petname: string; policy: string }[];
      assertEquals(rows.length, 1, "the device is still in the index — nothing was destroyed");
      assertEquals(rows[0].petname, "laptop", "under the same name");
      assertEquals(rows[0].policy, "every-session", "on the rung the user just chose");
      // NO AUTO-UNSEAL any more: the picker waits, because the policy
      // tag says it must ask.
      assert(trace.includes("picker:wait"), `the picker waits for a user now: ${trace}`);
      const picker = await until([page], "the picker", async () => {
        const p = await solo(page, "picker");
        return p.visible ? p : false;
      }, WAITS.boot);
      assert(picker.rows.includes("laptop"), `the picker's rows: ${JSON.stringify(picker.rows)}`);
    });

    await act("NOTHING PERSONAL is on screen while the device is sealed", async () => {
      // THE ANTI-SPOOFING PROPERTY, asserted at the one moment it is
      // stable: a device waiting to be opened. No anchor colour, no
      // name — a page imitating this screen has nothing of the user's to
      // copy, because at this moment neither does the real one.
      const personal = await stripPersonal(page);
      assertEquals(personal.anchorColour, "", "no anchor colour before the seal opens");
      assert(
        !personal.identityText.includes(WHO),
        `the user's name must not be rendered before unseal: ${JSON.stringify(personal)}`,
      );
      const body = await page.evaluate(() => document.body.textContent ?? "");
      assert(!body.includes(WHO), "and it is nowhere else on the document either");
    });

    await act("a wrong passphrase is refused cleanly, and changes nothing", async () => {
      assertEquals(await solo(page, "pickDevice", "laptop"), true, "the row was pickable");
      const asking = await until([page], "the passphrase demand", async () => {
        const p = await solo(page, "picker");
        return p.needsPassphrase ? p : false;
      }, WAITS.boot);
      assertEquals(asking.visible, true, "the picker is still the screen");
      await solo(page, "typePassphrase", PASS_WRONG);
      await solo(page, "unsealClick");
      const refusal = await until([page], "the refusal", async () => {
        const p = await solo(page, "picker");
        return p.problem !== "" && p.problem !== asking.problem ? p.problem : false;
      }, WAITS.boot);
      // AES-KW's integrity check is what makes this a clean refusal:
      // the unwrap fails inside WebCrypto and no partial key ever
      // exists (seal.ts's `kekFromPassphrase`).
      assertIncludes(refusal, "did not open", "the wrong passphrase is refused, and says so");
      const personal = await stripPersonal(page);
      assertEquals(personal.anchorColour, "", "and still nothing personal is painted");
    });

    await act("the right passphrase opens it, and the todo list is intact", async () => {
      await solo(page, "typePassphrase", PASS);
      await solo(page, "unsealClick");
      await until([page], "the unsealed device", async () => {
        try {
          const st = await solo(page, "deviceStatus");
          return st.sealed === false ? st : false;
        } catch {
          return false;
        }
      }, WAITS.boot);
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("picked:passphrase"), `the unseal was a ceremony: ${trace}`);
      const st = await solo(page, "deviceStatus");
      assertEquals(st.policy, "every-session", "the rung the upgrade left it on");
      assertEquals(st.resumed, true, "the engine resumed rather than starting fresh");
      const titles = await until([page], "the todos, after the upgrade", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 2 ? t : false;
      }, WAITS.converge);
      assert(titles.includes("buy milk"), `todos: ${JSON.stringify(titles)}`);
      assert(titles.includes("call the bank"), `todos: ${JSON.stringify(titles)}`);
      // And the visor is the user's again, on the far side of a real
      // login.
      const personal = await stripPersonal(page);
      assert(personal.anchorColour !== "", "the anchor colour is back");
      assertIncludes(personal.identityText, WHO, "and so is the user's name");
    });
  },
};

export default scenario;
