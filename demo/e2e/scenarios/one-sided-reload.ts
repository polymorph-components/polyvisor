// A DOCUMENTED, UNRECOVERED GAP, TURNED INTO A GATE — the sibling
// `solo-resume-sync` deliberately does not claim, and this scenario is
// what watches for the day it becomes true.
//
// THE CLAIM UNDER TEST, stated by solo.ts itself (~2988-3012, next to the
// resume-wire code): when only ONE side of a paired account reloads, and
// that side is the one that ACCEPTS (the adder), the recovery does not
// happen. The acceptor's own resume is fine — it posts a fresh acceptor
// and waits, correctly. Its peer — the reader, who DIALS — is the
// problem: it still holds a connection HANDLE from before the reload,
// and has no way to learn the thing on the other end of it is gone.
// `conn-status` reports the handshake's outcome once and is never
// invalidated afterwards (engine/guest/src/lib.rs:4407 writes the
// outcome into `conn_results` once per connection, and :4413-4420's
// `conn_status` reads that same entry back forever), so the reader sees
// a "healthy" connection to a page that no longer exists and never
// re-dials. The honest fix belongs in the engine — a `conn-status` that
// goes false when the connection drops — and until it lands, this file
// cannot tell the difference between a healthy peer and a departed one.
// Filed as #113.
//
// WHY THIS IS A GATE RATHER THAN MORE PROSE: `solo-resume-sync` proves
// the BOTH-sides-reload case recovers (the ordinary one — a user closes
// their laptop, then their phone) and explicitly declines to claim this
// one, with a paragraph pointing here. A paragraph does not fail a CI
// run when the gap closes. This scenario asserts the RECOVERY as if it
// already held, marked `expected: "red"` (see run.ts ~95-105): today it
// times out and is recorded `ok (xfail: expected red)` — a known gap,
// tracked, not hidden. The day the engine grows a live `conn-status`
// and B's resume loop re-dials, this scenario turns green, which the
// harness reads as the xfail FLIPPING — the whole suite fails until
// someone drops the `expected: "red"` flag. That failure IS the
// promotion notice.
//
// WHICH DIRECTION, traced rather than assumed: A is the adder (it
// accepts) and B is the reader (it dials), per the ceremony's fixed
// direction (solo.ts ~2564-2570, issue #78). Only A reloads. After A's
// resume:
//   - A's role is "writer accepts": it reposts a fresh acceptor and
//     genuinely waits — for ITS OWN us-devices directory to show a
//     child dialling in, and for that dial to land. That side of the
//     resume is honestly correct; it is just listening into silence,
//     because nothing ever dials it again.
//   - B's role is "reader dials", but B never reloads, so B's
//     resume-wire — the only code path that would make B re-dial —
//     never runs at all. B's ORIGINAL ceremony-time connection object
//     is still sitting there, and `conn-status` on it still answers
  //     with the handshake's old, one-time-written "true"
  //     (engine/guest/src/lib.rs:4407/:4413-4420). B has no symptom to
//     act on and no trigger to re-dial: nothing in B's code ever asks
//     "is this still good?" once the handshake result is latched.
// So the crossing asserted is B → A: a todo authored on B after A's
// reload has no path to A, because the only way it could travel — a
// fresh dial from B, prompted by B noticing its peer came back — never
// happens. A's freshly-reposted acceptor is real and waiting; nobody
// ever dials it. That is the cleanest single claim, and the one this
// scenario asserts: the reader side is where the gap actually lives
// (it is the side with no signal and no retry), so the reader's silence
// is what the xfail act below drives and waits on.
//

// RELAY-ONLY ACCOUNT, ON PURPOSE — CONTRACT: no storage is bound
// anywhere in this scenario, and nothing here must add one. With a
// bucket bound, the worker's pull cadence (SYNC.md §2, ~45s) would
// eventually deliver A's todo to B through the bucket regardless of the
// relay wire, and a scenario that could pass via a channel it never
// meant to exercise is not testing what its banner says. With no
// storage, the RELAY subduction is the only channel either device has,
// so a todo that fails to cross is unambiguously the stale-handle gap
// and not a masked, slower success.
//
// THE BOUNDED WAIT'S ARITHMETIC: the resume loop retries on a 5s cadence
// (solo.ts's `RESUME_TICK_MS`). A healthy re-wire (in the fixed world)
// would need at most a few ticks to notice a directory entry and dial —
// well under a minute. `REWIRE` below is sized generously past that
// (comfortably containing several retry cycles plus relay/CI slack)
// without turning a permanently-red scenario into a multi-minute tax on
// every suite run: it never actually gets there today, because nothing
// on B's side loops at all.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, createAccount, pairPages, solo, todoRows, until, WAITS } from "../solo-util.ts";

/** How long to wait for the crossing that the gap says will not happen.
 * Sized to comfortably contain several of the resume loop's 5s retry
 * ticks plus relay/CI slack — see the arithmetic note above. Kept short
 * on purpose: this scenario runs red in every suite invocation until the
 * engine grows a live `conn-status`, and a five-minute tax on every run
 * for a known, documented gap would be a worse citizen than a tight
 * bound that still gives the healthy world (once it exists) room to
 * land inside it. */
const REWIRE = 75_000;

const scenario: Scenario = {
  name: "one-sided-reload",
  why:
    "REGRESSION GATE for a documented gap (solo.ts ~2988-3012): after only the ADDER side of a " +
    "paired account reloads, the READER never learns its connection handle is stale and a todo " +
    "never crosses — expected red until the engine invalidates conn-status on disconnect",
  expected: "red",
  // Comfortably contains REWIRE plus the pairing/convergence beats ahead
  // of it; the suite-wide default is sized for scenarios with no
  // multi-tick relay wait at all.
  deadlineMs: 180_000,
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(pageA: Page, ctx: Ctx) {
    // --- the precondition: a paired account, proven live -----------------

    await act("A creates the account (A is the ADDER: it accepts)", async () => {
      await createAccount(pageA);
    });

    const pageB = await ctx.fresh({
      path: "/solo.html",
      bootGlobal: "__solo",
      storage: { [SOLO_KEYS.hue]: "265" },
    });

    await act("B pairs into A's account over the relay (B is the reader: it dials)", async () => {
      assertEquals(await solo(pageB, "hasAccount"), false, "B must hold no account of its own");
      await pairPages(pageA, pageB, "the other tab");
      await until(
        [pageA, pageB],
        "B's account",
        async () => await solo(pageB, "hasAccount"),
        WAITS.enrolled,
      );
    });

    await act("live convergence, proven BEFORE any reload: a todo from A reaches B", async () => {
      await addTodo(pageA, "buy milk");
      const rows = todoRows(pageB);
      await rows.first().waitFor({ state: "visible", timeout: WAITS.converge });
      const titles = await until([pageA, pageB], "A's todo on B", async () => {
        const t = (await solo(pageB, "todos").catch(() => [])) as string[];
        return t.includes("buy milk") ? t : false;
      }, WAITS.converge);
      assertEquals(titles.length, 1, `B's todos before the reload: ${JSON.stringify(titles)}`);
    });

    // --- ONLY A reloads: A is the acceptor, B is left untouched ----------

    await act("A (the acceptor) reloads for real; B's page is never touched", async () => {
      // A checkpoint first, for the same reason solo-resume-sync takes
      // one: what follows is a claim about the wiring, not a race with
      // the worker's 500ms debounce.
      await solo(pageA, "checkpoint");
      // A REAL NAVIGATION: it tears down A's page and its SharedWorker,
      // so A's ceremony-time acceptor is gone and its resume path is what
      // brings it back — the only path solo.ts documents as recovering
      // ITS side of this pair. B's page is left running the entire time:
      // B's original connection object, and B's belief in it, are
      // exactly what the gap is about.
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(pageA, "__solo");

      const trace = (await solo(pageA, "bootTrace")) as string[];
      assert(
        trace.includes("account:resumed"),
        `A resumed onto its account rather than the first-run fork: ${JSON.stringify(trace)}`,
      );
      const st = await solo(pageA, "deviceStatus");
      assertEquals(st.resumed, true, "A's engine RESUMED rather than starting fresh");
    });

    // --- THE XFAIL CLAIM: asserted as if the engine fix already existed --

    await act(
      "xfail: a todo authored on B after A's reload reaches A within a resume-sized window",
      async () => {
        // THE DIRECTION TRACED ABOVE: B → A is the crossing the gap
        // provably blocks. A's resume has reposted a fresh acceptor and
        // is genuinely waiting (solo.ts's writer-accepts resume path);
        // what never happens is B re-dialling it, because B's
        // resume-wire never runs — B never reloaded, so B's original
        // connection object is still there, and `conn-status` on it
        // still answers with the handshake's old, one-time "true"
        // (engine/guest/src/lib.rs:4407 writes it, :4413-4420 reads it
        // back). Filed as #113.
        await addTodo(pageB, "call the bank");

        // DIAGNOSIS RIDES WITH THE FAILURE: on a red run this wait times
        // out, and what a future reader needs is not "it timed out" but
        // the STALE-HANDLE SHAPE — both sides' boot traces, both sides'
        // device-status/conn-adjacent fields, and both sides' todo lists
        // — so the failure teaches the gap rather than hiding it behind
        // a bare deadline.
        let diag: unknown = null;
        const titles = await until([pageA, pageB], "B's new todo on A", async () => {
          diag = {
            aTrace: await solo(pageA, "bootTrace").catch((e) => String(e)),
            aStatus: await solo(pageA, "deviceStatus").catch((e) => String(e)),
            aTodos: await solo(pageA, "todos").catch((e) => String(e)),
            bTrace: await solo(pageB, "bootTrace").catch((e) => String(e)),
            bStatus: await solo(pageB, "deviceStatus").catch((e) => String(e)),
            bTodos: await solo(pageB, "todos").catch((e) => String(e)),
          };
          const t = (await solo(pageA, "todos").catch(() => [])) as string[];
          return t.includes("call the bank") ? t : false;
        }, REWIRE).catch((e) => {
          throw new Error(
            `${(e as Error).message}; the stale-handle shape at timeout: ${JSON.stringify(diag)}`,
          );
        });
        assert(
          titles.some((t) => t.includes("buy milk")),
          `A kept the pre-reload row too: ${JSON.stringify(titles)}`,
        );
      },
    );
  },
};

export default scenario;
