// TWO BROWSER ENGINES, ONE ACCOUNT — the first genuinely cross-BROWSER
// beat in this suite.
//
// WHAT WAS MISSING. Every multi-device scenario here runs its two
// "devices" as two CONTEXTS OF ONE CHROMIUM (solo-pairing's own banner
// says so: separate cookies, localStorage and IndexedDB, meeting only
// over the relay). That removes a great deal of help, but it leaves one
// thing shared that a real pair of devices never shares: the ENGINE.
// Both sides are the same wasm runtime, the same JSPI implementation,
// the same OPFS, the same structured-clone, the same iroh-over-WebSocket
// stack — so a serialization or a transport detail that two DIFFERENT
// engines disagree about cannot fail here, because there is only ever
// one of them. And the suite's single Gecko beat (`firefox-smoke`)
// proves Firefox boots and keeps a device, but it is a party of one: it
// never talks to anybody.
//
// So this scenario pairs a CHROMIUM device with a FIREFOX device over
// the harness's relay and makes both sides of the convergence claim: a
// todo authored on Chromium reaches Gecko, and a todo authored on Gecko
// reaches Chromium. Everything between them — the enrollment's endpoint
// and agent ids, the account's tasks-partition pointer, the todos
// themselves — crosses a wire between two independently-built runtimes.
//
// HOW IT GETS TWO BROWSERS. `ctx.fresh({ engine: "firefox" })`
// (util.ts's `FreshOptions.engine`, run.ts's `browserFor`): a per-CALL
// override of which browser one context is opened in. The scenario-level
// `engine` field still means "the browser the RUNNER's page uses", so
// device A here is an ordinary Chromium page and only device B asks for
// Gecko. Firefox is launched lazily on that first ask and kept, exactly
// as `firefox-smoke` gets it.
//
// THE JUGGLER HAZARD, AND WHY THIS SCENARIO IS ALLOWED TO EXIST.
// run.ts's note is emphatic: calling a `WebAssembly.promising` export
// from inside a `page.evaluate` frame SIGSEGVs the Firefox content
// process (measured 2026-08-23, 4/4). `solo()` — util.ts's `hookOn` —
// is page.evaluate straight into the `__solo` hooks, so on the face of
// it every B-side drive below is that hazard.
//
// It is not, and the reason is structural rather than lucky. MEASURED
// 2026-08-24, spiked before this scenario was written: a Firefox solo
// page driven through `solo()` survived 20 consecutive `tick`s, 20
// `hasAccount`s (`us-profile-get`, straight at the guest), a
// `newAccount`, a todo typed into the app and read back through
// `todos()` (`tasks.items()`), and an `endpointId` off a live iroh
// bind — no crash, no renderer silence, on 3 of 3 runs. THE ENGINE IS
// NOT IN THE PAGE'S REALM ANY MORE: /solo.html holds no wasm instance at
// all: `conn.driver` (host/solo.ts:723) is an RPC proxy over the device
// host's module SharedWorker, so an evaluate frame awaiting a `__solo`
// hook is awaiting a postMessage round trip, and the promising export it
// eventually reaches runs in the WORKER's global — a realm the Juggler
// evaluate frame is not on the stack of. The hazard's precondition (a
// stack switch inside the evaluate frame's own realm) simply does not
// hold here.
//
// That is a fact about THIS page, not a repeal of the rule. /index.html
// still instantiates its engines in the document, and the note in run.ts
// governs any Firefox-lane scenario that drives it. If the device host
// ever moves back into the page, this scenario is the first thing that
// will SIGSEGV, and this paragraph is the reason why.
//
// LOCATORS ARE NOT EVALUATE FRAMES. `addTodo` (solo-util.ts) drives the
// todomvc input inside the sandboxed frame through Playwright locators:
// fill, press, count. Those are protocol-level DOM operations executed
// by the browser itself, with no author JavaScript frame of ours on the
// stack — so they are Gecko-safe regardless of what the page's own event
// handlers go on to do asynchronously. The hazard is specifically an
// evaluate frame that REACHES a promising export while it is still on
// the stack; nothing about the DOM path can construct one.
//
// WAITS. Every step here crosses a relay AND an engine boundary, so the
// deadlines are solo-util's `WAITS` — already sized for a real ceremony
// over a real relay — with no Gecko-specific padding, because the spike
// measured no Gecko-specific slowness in the drives themselves (the
// slow part is the Firefox LAUNCH, which is the runner's phase and is
// paid for by this scenario's own `deadlineMs` below, not by any wait).

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS } from "../util.ts";
import {
  addTodo,
  appFrame,
  createAccount,
  pairPages,
  solo,
  todoRows,
  until,
  WAITS,
} from "../solo-util.ts";

/** The 79-character pairing code, as PAIRING.md §1 sizes it — asserted
 * here for the same reason `firefox-smoke` re-reads the JSPI pref out of
 * the page: it is the cheapest proof that the ceremony B is driving is
 * the real one and not a degraded path. */
const CODE_LEN = 79;

const scenario: Scenario = {
  name: "cross-engine-pairing",
  why: "a Chromium device and a Firefox device pair over the relay and converge both ways",
  // The RUNNER's page — device A — is an ordinary Chromium solo page.
  // Device B asks for Gecko per-context, below.
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    // `noWait: false` (the default): the runner boots this page with
    // `waitForBoot`, which is Gecko-safe on B's side too — it polls
    // through an evaluate that reads a global's presence and the
    // banner's textContent and nothing else. Data only, no hook call,
    // no promising export.
    storage: { [SOLO_KEYS.hue]: "265" },
  },
  // A FIREFOX LAUNCH plus a full pairing ceremony plus two convergence
  // waits. The suite-wide 240s was sized for one browser; the launch is
  // charged to the `newContext` phase of this scenario alone.
  deadlineMs: 420_000,

  async run(pageA: Page, ctx: Ctx) {
    let pageB!: Page;

    await act("device B is a SECOND BROWSER ENGINE, not a second context", async () => {
      pageB = await ctx.fresh({
        engine: "firefox",
        path: "/solo.html",
        bootGlobal: "__solo",
        // B's own anchor colour, so a fresh-anchor announcement never
        // sits over the line this scenario reads (util.ts's `seedHue`
        // note). A different hue from A's on purpose: the two are
        // different devices until the account says otherwise.
        storage: { [SOLO_KEYS.hue]: "212" },
      });
      // THE SCENARIO'S WHOLE PREMISE, asserted rather than assumed. A
      // silently-ignored `engine` override would turn this into
      // solo-pairing with extra words — a slow green lie about
      // cross-engine sync. Both user agents are read, because "B is
      // Gecko" is only half of it.
      const uaA = await pageA.evaluate(() => navigator.userAgent);
      const uaB = await pageB.evaluate(() => navigator.userAgent);
      assert(!/Firefox/.test(uaA) && /Chrome/.test(uaA), `A must be Chromium: ${uaA}`);
      assert(/Firefox/.test(uaB), `B must be Gecko: ${uaB}`);
    });

    await act("A (Chromium) opens the account and writes the first todo", async () => {
      await createAccount(pageA);
      await addTodo(pageA, "buy milk");
      const titles = await until(
        [pageA],
        "A's first todo",
        async () => {
          const t = (await solo(pageA, "todos")) as string[];
          return t.includes("buy milk") ? t : false;
        },
        WAITS.converge,
      );
      assertEquals(titles.length, 1, `A's todos: ${JSON.stringify(titles)}`);
    });

    await act("the add ceremony, driven ACROSS the two engines", async () => {
      // `pairPages` is solo-util's driver, not a claim (see its banner):
      // the joiner shows a code, the adder takes it, both sides read the
      // same SAS, the grant arms, the joiner confirms. Every B-side step
      // in it is a `solo()` evaluate — the drives the spike above
      // measured as Gecko-safe.
      const { code, sasAdder, sasJoiner } = await pairPages(pageA, pageB, "the firefox one");
      assertEquals(code.length, CODE_LEN, `the pairing code Gecko rendered: ${code.length} chars`);
      // THE ONE THING THAT MOST WANTS TWO ENGINES: the short
      // authentication string is derived on each side from the
      // transcript it saw, so equal digits across a Chromium/Gecko pair
      // is a statement about both runtimes agreeing byte for byte on
      // what was said.
      assert(sasAdder.length > 0, "the adder's SAS is not empty");
      assertEquals(sasJoiner, sasAdder, "the same six digits on Chromium and on Gecko");
    });

    await act("B (Gecko) joins the account and A's todo crosses to it", async () => {
      await until(
        [pageA, pageB],
        "B's account",
        async () => await solo(pageB, "hasAccount"),
        WAITS.enrolled,
      );
      const titles = await until(
        [pageA, pageB],
        "A's todo on B",
        async () => {
          const t = (await solo(pageB, "todos").catch(() => [])) as string[];
          return t.includes("buy milk") ? t : false;
        },
        WAITS.converge,
      );
      assertEquals(titles.length, 1, `B's todos: ${JSON.stringify(titles)}`);
      // And the APP is really mounted under Gecko, not merely the
      // engine holding the partition — the frame is up and the row is
      // rendered. Read through locators, which is the Gecko-safe path
      // (see this file's banner): the browser walks the DOM, not us.
      const rows = todoRows(pageB);
      await rows.first().waitFor({ state: "visible", timeout: WAITS.converge });
      assertEquals(await rows.count(), 1, "B's rendered todo rows");
    });

    await act("and the other way: a todo authored on Gecko reaches Chromium", async () => {
      // The direction that has never been tested: bytes MINTED by
      // Firefox's engine, read by Chromium's. `addTodo` types into the
      // sandboxed frame on B — locators again, and the input must be up
      // before it will type.
      await appFrame(pageB).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      await addTodo(pageB, "water the plants");
      const titles = await until(
        [pageA, pageB],
        "B's todo on A",
        async () => {
          const t = (await solo(pageA, "todos")) as string[];
          return t.includes("water the plants") ? t : false;
        },
        WAITS.converge,
      );
      assertEquals(titles.length, 2, `A's todos: ${JSON.stringify(titles)}`);
    });

    await act("the account's own state converged too, Chromium → Gecko", async () => {
      // The todos prove the APP's partition crossed; this proves the
      // user-system document did — a different subduction, a different
      // wire, and the one solo-pairing found broken on the joiner side.
      // ♜ is the glyph the app guest nominates, so it is a mark a user
      // could really have picked.
      assertEquals(
        await solo(pageA, "putMark", "app", "the list", "\u265C"),
        true,
        "A wrote the mark",
      );
      const mark = await until(
        [pageA, pageB],
        "A's petname on B",
        async () => {
          const marks = (await solo(pageB, "marks")) as Array<
            { provenance: string; petname: string }
          >;
          return marks.find((m) => m.provenance === "app") ?? false;
        },
        WAITS.converge,
      );
      assertEquals(mark.petname, "the list", "the petname that converged to Gecko");
    });
  },
};

export default scenario;
