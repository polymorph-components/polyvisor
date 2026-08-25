// THE HARDER HALF OF A RELOAD: only ONE side comes back, and the side
// that stayed up is the one that has to notice.
//
// ─── THE CLAIM ───────────────────────────────────────────────────────
//
// Two devices of one account are paired and syncing. The ADDER — the
// side that ACCEPTS — reloads for real: page gone, SharedWorker gone,
// engine gone, a fresh acceptor posted on the other side of the reload.
// The READER never reloads and is never touched. A todo authored on the
// reader afterwards still reaches the adder, because the reader NOTICES
// that the connection it has been holding is dead and dials again.
//
// ─── IT WAS RED, AND WHY (kept, because it is the point) ─────────────
//
// Pinned `expected: "red"` from PR #108 until #113 closed it, and the
// gap had two halves that had to close together:
//
//   * THE READER HAD NO SIGNAL. `conn-status` reported the outcome of
//     the HANDSHAKE and was never invalidated afterwards: the engine
//     wrote it into `conn_results` once and read that entry back for
//     ever. So the reader's handle to a page that had ceased to exist
//     answered exactly as a live one did. Nothing in the reader's code
//     could ask "is this still good?", because there was no answer.
//   * AND NO TRIGGER. The reader was in a CEREMONY role (`joinerWire`),
//     which runs at most once; the only patient retry on the page,
//     `resumeWire`, was entered exclusively from the resumed-boot
//     branch — and the reader is precisely the side that did not
//     reload. Adding a re-dial timer without the first half would have
//     been the double-dial #78's direction discipline exists to
//     prevent: a second connection carrying the same subscriptions,
//     silently.
//
// WHAT CLOSED IT, both halves of #113:
//
//   * THE ENGINE now gives every connection a monitor that awaits the
//     iroh WIT's `wait-closed` and overwrites that connection's entry
//     with `Err("gone: …")`. The `gone:` prefix is a machine-readable
//     marker, spelled out in engine.wit's `conn-status` doc comment; it
//     overwrites only an `Ok`, so a handshake failure — which is more
//     informative — survives.
//   * THE PAGE now runs ONE WIRE-KEEPER for the life of every paired
//     page rather than only on resumed boots (demo/host/solo.ts's
//     `wireKeeper`). Both ceremonies hand it their wire when they are
//     done; each tick it reads `conn-status` on the handles it holds,
//     and a `gone:` — and nothing else — clears that peer and lets the
//     next tick re-dial. The double-dial discipline is unchanged; it is
//     merely enforceable now.
//
// ─── THE MEASURED NUMBER, AND WHAT GOVERNS IT ────────────────────────
//
// MEASURED: 35.0s from the reader's todo to the adder holding it, three
// consecutive runs, varying by tens of milliseconds. Its shape:
//
//     ~30s   the wire actually ending. THIS IS THE WHOLE COST, and it
//            belongs to the pinned endpoint rather than to either side's
//            code: when a PEER VANISHES, nothing under the surviving
//            side dies. Its socket is fine, the relay is fine, and no
//            close frame is ever sent by a page that has been navigated
//            away from — so the connection ends on the QUIC IDLE
//            TIMEOUT, not on an error. (Contrast the relay-death shape,
//            where the relay leg is a websocket over TCP and the
//            endpoint learns synchronously: measured under a second in
//            demo/host/conn-gone-check.ts. Same marker, two mechanisms,
//            two orders of magnitude apart.)
//   + ≤5s    the keeper's next tick noticing (`KEEPER_TICK_MS`)
//   + <1s    the re-dial and the re-subscription
//     ------
//     ~35s
//
// `REWIRE` below is that with roughly 2x of margin. Sizing it much
// tighter would gate the pinned endpoint's idle timeout, which is not
// this repo's number to hold; sizing it much looser would make a real
// regression cost minutes per suite run before it reported.
//
// ─── WHICH DIRECTION, traced rather than assumed ─────────────────────
//
// A is the adder (it accepts) and B is the reader (it dials), per the
// ceremony's fixed direction (issue #78). Only A reloads. After A's
// resume:
//   - A's role is "writer accepts": it reposts a fresh acceptor and
//     waits — for its own us-devices directory to show a child dialling
//     in, and for that dial to land. That side was always correct; it
//     was just listening into silence.
//   - B's role is "reader dials", and B never reloads. B's keeper —
//     armed at the end of B's own joining ceremony, which is the change
//     — sweeps its one outbound handle every tick, sees the `gone:`
//     marker when the idle timeout fires, forgets the wire and the
//     subscription that rode on it, and dials A's fresh acceptor.
// So the crossing asserted is B → A: it is the direction that requires
// the reader to have noticed, which is the whole claim.

// RELAY-ONLY ACCOUNT, ON PURPOSE — CONTRACT: no storage is bound
// anywhere in this scenario, and nothing here must add one. With a
// bucket bound, the worker's pull cadence (SYNC.md §2, ~45s) would
// eventually deliver the todo through the bucket regardless of the relay
// wire, and a scenario that can pass via a channel it never meant to
// exercise is not testing what its banner says. With no storage, the
// RELAY subduction is the only channel either device has, so the
// crossing below is unambiguously the re-dial.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, createAccount, pairPages, solo, todoRows, until, WAITS } from "../solo-util.ts";

/** How long the crossing is given. Measured 35.0s (three runs); see the
 * banner's arithmetic — ~30s of it is the pinned endpoint's QUIC idle
 * timeout, which is what the reader is waiting on, plus one ≤5s keeper
 * tick and a sub-second re-dial. 75s is that with roughly 2x of margin:
 * enough that a busy CI box cannot turn the endpoint's own timer into a
 * red, tight enough that a genuine regression reports in about a minute
 * instead of costing the suite five. */
const REWIRE = 75_000;

const scenario: Scenario = {
  name: "one-sided-reload",
  why:
    "when only the ADDER side of a paired account reloads, the READER notices its connection went " +
    "`gone:` and re-dials by itself — a todo authored on the reader still crosses, with no " +
    "ceremony and nothing reloaded on that side (was red until #113: engine gone-marker + the " +
    "page's wire-keeper)",
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

    // --- THE CLAIM: the reader notices, and dials again -----------------

    await act(
      "a todo authored on B after A's reload reaches A: B noticed its wire went gone and re-dialled",
      async () => {
        // THE DIRECTION TRACED ABOVE: B → A is the crossing that requires
        // the reader to have noticed. A's resume has reposted a fresh
        // acceptor and is waiting (solo.ts's writer-accepts path); what
        // used to never happen is B re-dialling it. Now B's wire-keeper
        // sweeps its handle every tick, and when the pinned endpoint's
        // idle timeout finally ends the connection to a page that no
        // longer exists, `conn-status` says `gone:` and the next tick
        // dials. #113.
        await addTodo(pageB, "call the bank");

        // DIAGNOSIS RIDES WITH THE FAILURE, and it is worth MORE now than
        // it was as an xfail: this act is green, so the next reader to
        // meet it as a failure is meeting a REGRESSION, and what they
        // need is which half went. `wireHealth` is the keeper's own
        // account of the handles it holds — B reading "alive" on a wire
        // to a page that is gone means the engine's monitor stopped
        // firing; B reading "gone" with no re-dial behind it means the
        // keeper stopped keeping. Both sides' boot traces and todo lists
        // are kept for the same reason they always were.
        let diag: unknown = null;
        const titles = await until([pageA, pageB], "B's new todo on A", async () => {
          diag = {
            aTrace: await solo(pageA, "bootTrace").catch((e) => String(e)),
            aStatus: await solo(pageA, "deviceStatus").catch((e) => String(e)),
            aWire: await solo(pageA, "wireHealth").catch((e) => String(e)),
            aTodos: await solo(pageA, "todos").catch((e) => String(e)),
            bTrace: await solo(pageB, "bootTrace").catch((e) => String(e)),
            bStatus: await solo(pageB, "deviceStatus").catch((e) => String(e)),
            bWire: await solo(pageB, "wireHealth").catch((e) => String(e)),
            bTodos: await solo(pageB, "todos").catch((e) => String(e)),
          };
          const t = (await solo(pageA, "todos").catch(() => [])) as string[];
          return t.includes("call the bank") ? t : false;
        }, REWIRE).catch((e) => {
          throw new Error(
            `${(e as Error).message}; the reader never re-dialled within ${REWIRE / 1000}s ` +
              `(measured heal is 35s — see this file's banner). Both sides at timeout: ` +
              `${JSON.stringify(diag)}`,
          );
        });
        assert(
          titles.some((t) => t.includes("buy milk")),
          `A kept the pre-reload row too: ${JSON.stringify(titles)}`,
        );
        // AND ON THE ROWS, not only in the engine: the user's complaint
        // is about a screen. A heal that reached the partition but not
        // the surface is still a device that "stopped updating".
        //
        // WAITED FOR RATHER THAN SAMPLED, and the difference is real: the
        // assertion above reads the ENGINE, and the app's rows are
        // re-rendered off a later drain — so reading the DOM in the same
        // breath catches A mid-frame and fails on a row that appears a
        // beat later. `WAITS.converge` here is a paint deadline, not a
        // network one; the network wait already happened.
        await until([pageA, pageB], "B's new todo RENDERED on A", async () => {
          const rows = await todoRows(pageA).allTextContents();
          return rows.some((t) => t.includes("call the bank"));
        }, WAITS.converge);
      },
    );
  },
};

export default scenario;
