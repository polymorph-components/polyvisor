// SYNC COMES BACK BY ITSELF — after BOTH devices have been closed and
// reopened.
//
// THE ARGUMENT, and it is the last hole in the solo page's story.
// `solo-pairing` proves two independent pages can be joined into one
// account and that edits then cross. `solo-persistence` proves a device
// survives a real reload with its todo list and its transport address
// intact. Neither says anything about the state BETWEEN them, and that
// state was broken: the wiring the two pages had was made by a CEREMONY,
// out of facts the ceremony carried (the enrollment's peer ids), and a
// ceremony does not run twice. So a reloaded page wired nothing, and
// once both had reloaded the account was two devices holding the same
// document and never speaking again — with no symptom at all. Both
// pages looked healthy. Both reported an account. Nothing crossed.
//
// The silence is the point: this is the failure mode solo.ts's direction
// discipline keeps writing down, and it cannot be caught by a scenario
// that only ever reloads one page, because the other one's ceremony-time
// acceptor is still up and doing the work.
//
// WHAT MAKES IT COME BACK is the account's own device directory. Each
// `us-device` entry now carries the device's ENDPOINT ID — recorded by
// the adder from an id it observed on the wire — and an ENROLLED-BY
// naming the device that let it in. That is enough for a resumed boot to
// read its own role out of the account instead of remembering one: my
// enroller is who I dialled, so I dial it again; my children dialled me,
// so I accept again. The direction is preserved, which matters more than
// it sounds — reversed, both sides report healthy connections and
// nothing arrives (#78).
//
// FIVE CLAIMS:
//
//   1. Two independent pages pair, and converge. (Not this scenario's
//      subject — its PRECONDITION. Driven through solo-util's
//      `pairPages`; solo-pairing is where those beats are claims.)
//   2. BOTH pages reload, for real: two navigations, two torn-down
//      SharedWorkers, two engines resumed from checkpoints.
//   3. The joiner's transport address is the SAME one as before. This is
//      the premise everything else rests on — the account recorded that
//      address once, and if a reload minted a fresh one the directory
//      would be pointing at a device that no longer exists. Cheap to
//      assert, and it fails first and legibly if the endpoint key ever
//      stops being persisted.
//   4. A todo added on A AFTER the double reload reaches B — and it is
//      asserted on B's RENDERED ROWS, not merely on B's engine, because
//      the complaint being fixed is a user's ("my other device stopped
//      updating"), not a partition's.
//   5. A profile change made on A after the double reload lands on B's
//      STRIP. That is a different path over the same new wire: the us
//      doc rather than the tasks partition, and the drain-poll's
//      `profile-changed` → `reconcileFromDriver` → `applyProfile` apply
//      chain rather than the app's own repaint.
//   6. And a MARK made on A after the double reload lands on B's strip
//      too — the same us-doc path, but through the `mark-added` drain
//      trigger and `applyMarks`. Cheap here (the wire is already proven
//      up by 4 and 5, so this is one ceremony and one poll) and worth
//      it: the mark tags are a SECOND set of drain triggers, and a
//      resumed wire that carried profile events but not mark events
//      would look entirely healthy.
//
// WHAT THIS SCENARIO DELIBERATELY DOES NOT CLAIM: that reloading ONLY
// the adder recovers. It does not, and the reason is an engine limit
// rather than a wiring bug — a READER has no way to learn that its peer
// went away. `conn-status` reports the outcome of the handshake and is
// never invalidated afterwards (engine/guest/src/lib.rs:3700 writes it
// once, :3706-3713 reads it back forever), and `sync-status` is one-shot
// per round rather than a subscription's health. So the un-reloaded side
// keeps a handle to a connection that no longer exists and has no
// evidence to act on. An act asserting the recovery was written, run,
// and removed when it turned out to be asserting a property nothing on
// the page can currently provide; the alternative — re-dialling on a
// timer — would be a second connection and a second set of subductions
// for the same pair, which is exactly the double-dialling solo.ts's
// direction discipline exists to prevent. solo.ts's resume section
// carries the same note next to the code. The BOTH-sides case, which is
// the ordinary one (a user closes their laptop, then their phone), is
// what this scenario claims and what the design recovers.
//
// DEADLINES ARE LONG AND DELIBERATELY SO. The post-reload claims cannot
// begin to be true until a wire that does not exist yet has been built,
// and the resume loop retries on a 5s cadence by design — it is waiting
// for a person to open a browser, not for a packet. A deadline that is
// merely "usually enough" here would be a flake generator whose failure
// text is indistinguishable from the real regression.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import {
  act,
  assert,
  assertEquals,
  SOLO_KEYS,
  stripMarkIcon,
  stripText,
  waitForBoot,
} from "../util.ts";
import {
  addTodo,
  appFrame,
  createAccount,
  nameApp,
  pairPages,
  setAccountName,
  solo,
  stripPersonal,
  todoRows,
  until,
  WAITS,
} from "../solo-util.ts";

/** The name the account carries through the pairing, and the one it is
 * renamed to AFTERWARDS — the second is the claim, and it is
 * deliberately unlike the first so a strip that simply never changed
 * cannot pass by standing still. */
const NAME_BEFORE = "Ada";
const NAME_AFTER = "Ada Lovelace";
/** Not the 265 both pages are seeded with, for the same reason. */
const ACCOUNT_HUE = 175;
/** What A calls the app in the last act. The mark that goes with it is
 * whatever the ceremony offers (a fresh random draw — see `nameApp`),
 * so it is captured at ceremony time rather than named here. */
const APP_PETNAME = "the tasks";

/** Everything after a double reload has to wait for a wire that is being
 * rebuilt on a 5s retry cadence, behind a relay. */
const REWIRE = 180_000;

const scenario: Scenario = {
  name: "solo-resume-sync",
  why: "after BOTH devices of a paired account reload, edits and profile changes cross again without a ceremony",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(pageA: Page, ctx: Ctx) {
    // --- the precondition: a paired account -----------------------------

    await act("A creates an account, names it, and writes a todo", async () => {
      await createAccount(pageA);
      await setAccountName(pageA, NAME_BEFORE, ACCOUNT_HUE);
      await addTodo(pageA, "buy milk");
    });

    const pageB = await ctx.fresh({
      path: "/solo.html",
      bootGlobal: "__solo",
      storage: { [SOLO_KEYS.hue]: "265" },
    });

    await act("B is a different device and joins A's account", async () => {
      assertEquals(await solo(pageB, "hasAccount"), false, "B must hold no account of its own");
      await pairPages(pageA, pageB, "the other tab");
      await until(
        [pageA, pageB],
        "B's account",
        async () => await solo(pageB, "hasAccount"),
        WAITS.enrolled,
      );
    });

    await act("B converged: A's todo on B's rows, A's name on B's strip", async () => {
      const rows = todoRows(pageB);
      await rows.first().waitFor({ state: "visible", timeout: WAITS.converge });
      const titles = await until([pageA, pageB], "A's todo on B", async () => {
        const t = (await solo(pageB, "todos").catch(() => [])) as string[];
        return t.includes("buy milk") ? t : false;
      }, WAITS.converge);
      assertEquals(titles.length, 1, `B's todos: ${JSON.stringify(titles)}`);
      const personal = await until([pageA, pageB], "A's name on B's strip", async () => {
        const p = await stripPersonal(pageB);
        return p.identityText.includes(NAME_BEFORE) ? p : false;
      }, WAITS.converge);
      assert(
        personal.anchorColour.includes(String(ACCOUNT_HUE)),
        `B's anchor took the account's colour: ${JSON.stringify(personal)}`,
      );
    });

    // THE TRANSPORT ADDRESSES, READ BEFORE THE RELOADS. Bind happens at
    // boot and off the critical path, so they are polled rather than
    // assumed present (solo.ts's `myEndpoint`).
    const endpointB = await until([pageA, pageB], "B's bound endpoint", async () => {
      const id = (await solo(pageB, "endpointId")) as string;
      return id !== "" ? id : false;
    }, WAITS.converge);

    // --- the double reload ----------------------------------------------

    await act("BOTH pages reload for real, and both come back with the account", async () => {
      // CHECKPOINTS ON PURPOSE, so what follows is a claim about the
      // wiring rather than a race with the worker's 500 ms debounce.
      await solo(pageA, "checkpoint");
      await solo(pageB, "checkpoint");
      // TWO REAL NAVIGATIONS. Each tears its page down and the device's
      // SharedWorker with it, so both engines below came back from a
      // checkpoint — and, decisively, NEITHER page's ceremony-time
      // acceptor survives. Reloading only one would leave the other's
      // listener doing the work and the regression invisible.
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(pageA, "__solo");
      await pageB.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(pageB, "__solo");

      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        const trace = (await solo(page, "bootTrace")) as string[];
        assert(
          trace.includes("account:resumed"),
          `${who} resumed onto its account rather than the first-run fork: ${JSON.stringify(
            trace,
          )}`,
        );
        const st = await solo(page, "deviceStatus");
        assertEquals(st.resumed, true, `${who}'s engine RESUMED rather than starting fresh`);
      }
      // Both apps are up again from local state, without waiting for any
      // peer — the wire is rebuilt in the background, which is the
      // page's own rule (solo.ts: "THE APP FIRST, THE WIRE IN THE
      // BACKGROUND").
      await appFrame(pageA).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.boot,
      });
      await appFrame(pageB).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.boot,
      });
    });

    await act("B's transport address survived: the directory still points at it", async () => {
      // THE PREMISE. In iroh the key IS the address, so the endpoint id
      // A's account recorded for B at enrollment is only still useful if
      // B rebinds to the same one. Before the endpoint key pair was
      // persisted, "both devices reloaded and re-found each other" was
      // impossible by construction rather than by bug.
      const after = await until([pageA, pageB], "B's rebound endpoint", async () => {
        const id = (await solo(pageB, "endpointId")) as string;
        return id !== "" ? id : false;
      }, WAITS.converge);
      assertEquals(after, endpointB, "B's transport address must survive a real reload");
    });

    // --- THE CLAIM --------------------------------------------------------

    await act("a todo added on A after the double reload appears on B's ROWS", async () => {
      await addTodo(pageA, "call the bank");
      // ON THE RENDERED ROWS, not on B's engine. The regression is a
      // user's complaint — the other device stopped updating — so the
      // assertion is made where the user would make it. `until` drives
      // both pages' own drains while it waits, which is what keeps a
      // slow machine from turning this into a flake.
      const titles = await until([pageA, pageB], "A's new todo on B's rows", async () => {
        const rendered = await todoRows(pageB).allTextContents();
        return rendered.some((t) => t.includes("call the bank")) ? rendered : false;
      }, REWIRE);
      assert(
        titles.some((t) => t.includes("buy milk")),
        `B kept the old row too: ${JSON.stringify(titles)}`,
      );
    });

    await act("a profile change made on A after the double reload lands on B's strip", async () => {
      // THE OTHER PATH OVER THE SAME NEW WIRE: the us doc rather than the
      // tasks partition, and B's drain poll rather than the app's own
      // repaint. A wire that carried todos but not this would be half
      // rebuilt, and the strip is where a user would see the half that
      // was missing.
      await setAccountName(pageA, NAME_AFTER);
      const personal = await until([pageA, pageB], "A's new name on B's strip", async () => {
        const p = await stripPersonal(pageB);
        return p.identityText.includes(NAME_AFTER) ? p : false;
      }, REWIRE);
      assert(
        personal.anchorColour.includes(String(ACCOUNT_HUE)),
        `B's anchor is still the account's: ${JSON.stringify(personal)}`,
      );
    });

    await act("a mark made on A after the double reload lands on B's strip", async () => {
      // THE OTHER FAMILY OF ACCOUNT EVENT. A names the app through the
      // real ceremony; `onNamed` writes it through to the account, and B
      // adopts it off `mark-added` — a different drain trigger and a
      // different apply than the profile above, over the same rebuilt
      // wire. B has never seen this record before, so its strip cannot
      // pass by standing still.
      const mark = await nameApp(pageA, APP_PETNAME);
      const top = await until([pageA, pageB], "A's petname for the app on B's strip", async () => {
        const t = (await stripText(pageB)).top;
        return t.includes(APP_PETNAME) ? t : false;
      }, REWIRE);
      assert(top.includes(APP_PETNAME), `B's strip: ${JSON.stringify(top)}`);
      assertEquals(await stripMarkIcon(pageB), mark, "A's mark on B's strip");
    });

  },
};

export default scenario;
