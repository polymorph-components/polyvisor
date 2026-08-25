// A RELAY OUTAGE BETWEEN TWO LIVE SIBLINGS, AND THE HEAL THAT COMES BY
// ITSELF. Green since #113 landed end to end; it was `expected: "red"`
// for three waves of gap before that, and the history is kept below
// because each wave hid the next one.
//
// ─── THE CLAIM ───────────────────────────────────────────────────────
//
// Two devices of one account are paired and syncing live. The relay
// they meet over goes away; each device is edited while it is alone;
// the relay comes back. Both devices then hold the SAME todo set —
// merged, not merely one-way delivered — with nobody reloading
// anything, nobody re-running a ceremony, and nobody pressing a button.
// That is what a user means by "my other device caught up", and every
// step of it now happens on its own:
//
//     the relay dies       both sides' `conn-status` reports `gone:`
//                          in ~0.1s (the relay leg is a websocket over
//                          TCP, so the socket dies under each endpoint
//                          and it learns synchronously)
//     …the outage…         each page keeps taking edits locally
//     the relay returns
//     +~5s                 both pages rebind their endpoint — same
//                          address, off the persisted transport key —
//                          repost the acceptor, and re-dial
//     +~5s from restore    BOTH engines hold the merged four-todo set
//                          (measured 4.8–5.4s over five runs)
//     +~0.3s               and both SCREENS show it (0.26–0.54s)
//
// ─── WHICH PATH CARRIES THE BYTES (asked first, answered empirically)
//
// component-iroh can upgrade a relay-dialled connection to a WebRTC
// data channel in the background (iroh.wit's `endpoint.connect`: "A
// `webrtc` entry … upgrades a relay-dialed connection in the
// background"). On one localhost box such a channel would carry edits
// straight past a dead relay, and a scenario that stopped the relay
// would be partitioning nothing at all. It does not happen here, for
// two reasons that are both in the engine's own source:
//
//   * the endpoint is bound with WebRTC LEFT OFF. `iroh-bind` sets an
//     ALPN pair and a relay URL and nothing else;
//     `endpoint-options.webrtc` is never called, and iroh.wit says of it
//     "When disabled (the default), `webrtc` entries are ignored for
//     dialing and inbound signaling is discarded";
//   * the dial address offers no other wire anyway — `iroh-start` builds
//     `EndpointAddr { addrs: vec![TransportAddr::Relay(relay_url)] }`,
//     one relay entry, no `webrtc` and no `ip:port`.
//
// MEASURED, not merely read: with two paired pages converging in 4ms,
// `ctx.stopRelay()` and then a todo authored on each side, NOTHING
// crossed in either direction for 60s. The relay is the path — which is
// what makes the outage act below a real partition and this file's
// claim about the relay rather than about localhost.
//
// ─── THE THREE WAVES OF RED, KEPT ────────────────────────────────────
//
// This file spent its whole life so far as an `expected: "red"` pin, and
// it was red for three DIFFERENT reasons in turn. Each one was only
// findable once the one before it was fixed, which is the argument for
// writing all three down rather than the last.
//
// WAVE 1 — THE PAGE COULD NOT RETRY, AND COULD NOT HAVE (issue #113 as
// filed). Two halves, and neither was any use without the other:
//
//   * NO LOOP. A page that paired in THIS session is in a ceremony role
//     — `joinerWire` / `adderWire` in demo/host/solo.ts — and both latch
//     on their first success. `WIRE_ATTEMPTS = 3` is a retry for wiring
//     that never CAME UP, not a re-dial for a wire that came up and
//     died. The only patient loop, `resumeWire`, was entered exclusively
//     from the resumed-boot branch. So when the relay died under a
//     freshly-paired pair there was no loop left running anywhere.
//   * AND NO SIGNAL TO LOOP ON. `conn-status` reported the outcome of
//     the HANDSHAKE and was never invalidated afterwards: written into
//     `conn_results` once, read back for ever. A handle to a peer that
//     had been unreachable for an hour answered exactly as a live one
//     did. Re-dialling on a timer against that would have been the
//     double-dial the direction discipline exists to prevent (#78) — a
//     second connection carrying the same subscriptions, silently.
//
//   Measured then: no convergence in 240s, both pages alive and ticking
//   throughout.
//
// WAVE 2 — THE PAGE HALF, which fixed the above and MOVED the gap into
// the engine. `conn-status` grew a machine-readable `gone:` marker
// (every connection gets a monitor on the iroh WIT's `wait-closed`;
// gated by demo/host/conn-gone-check.ts, ~0.1s on a relay kill), and
// solo.ts grew ONE WIRE-KEEPER armed for the life of every paired page
// rather than only on resumed boots: each 5s tick it reads `conn-status`
// on the handles it holds, and a `gone:` — and nothing else — clears
// that peer so the next tick re-dials. A third fact turned up here and
// is worth keeping: a relay's death does not merely kill CONNECTIONS,
// it latches this device's own ENDPOINT `Closed`, so the keeper's
// repair path runs through `rebindEndpoint` (which re-mints the same
// address off the persisted key) before a dial can land.
//
//   Measured then: the transport came ALL the way back — both sides
//   rebound, re-dialled, and reported a live connection within ~10s of
//   the relay returning — and then not one todo crossed in 150s. The
//   reader's `sync-start` returned a handle whose `sync-status` never
//   settled; the acceptor's settled fine.
//
// WAVE 3 — THE STALE TRANSPORT CHAIN, which is what that asymmetry was.
// Four links, each individually reasonable:
//
//   1. `QueueTransport` held its OWN channel ends — `in_tx` alongside
//      `in_rx` — so `recv_bytes` COULD NOT FAIL. When `iroh_reader` hit
//      EOF it dropped only its clone of the sender; the channel stayed
//      open and the transport went on politely awaiting frames from a
//      socket that no longer existed.
//   2. Subduction's teardown is driven ENTIRELY by a connection's reader
//      failing — the per-connection loop's exit is the only thing that
//      posts a closure, which is the only thing that removes the
//      connection. A transport that cannot fail is therefore never
//      removed.
//   3. `add_connection` APPENDS rather than replaces, so after a rebind
//      the peer owned a DEAD connection at index 0 and the live one at
//      index 1.
//   4. And `sync_with_peer` walks that list IN ORDER, under this
//      engine's never-firing timeout — so it called the dead one first
//      and parked there for ever, never reaching the live one.
//
//   THE ASYMMETRY EXPLAINED: only the side that CALLS `sync_with_peer`
//   walks the stale list. An acceptor answering an inbound request
//   replies on the connection the message arrived on, so it settled
//   normally — which is why `one-sided-reload` was green throughout and
//   only the dialling side ever hung.
//
//   THE FIX, one link, no upstream change and nothing reaching into
//   subduction's registries behind its back: the gone-monitor now CLOSES
//   the dead connection's inbound queues, so `recv_bytes` starts
//   failing, subduction's own teardown runs, and the next
//   `sync_with_peer` finds only the live connection.
//
//   Pinned by demo/host/rebind-sync-check.ts (`just rebind-sync`), the
//   headless gate written for exactly this and red→green across the fix:
//   post-rebind `sync-start` settles in 0.20s and a todo crosses in
//   0.03–0.06s, both directions, where before neither settled at all.
//
// ─── WHAT IS NOT THE SUBJECT ────────────────────────────────────────
//
// NOTHING RELOADS HERE, and that is the point of the file: a reload
// re-handshakes from nothing, which is the state this scenario exists
// NOT to be in. The double reload is `solo-resume-sync`'s claim and the
// one-sided reload is `one-sided-reload`'s; with this file green, all
// three shapes of "the wire went away" are now covered — both devices
// closed and reopened, one device vanishing, and the relay itself
// blinking while both stay open.
//
// NO STORAGE IS BOUND, deliberately. `solo-offline-sync` shows a todo
// crossing through a Drive bucket with no live peer at all; if this
// scenario bound a store, the heal could be the BUCKET's doing and the
// relay claim would be unfalsifiable. Neither page here has any store,
// so the relay is the only channel that exists.
//
// ─── HOW IT FAILS WHEN IT FAILS ─────────────────────────────────────
//
// Everything before the heal is a plain precondition — pairing, a live
// crossing, a real cut — and each asserts itself loudly, so a failure
// there reads as the regression it is rather than as a heal that did not
// come. The heal itself is split into TWO acts on purpose: the engines
// agreeing and the screens following are different claims with different
// failure modes, and keeping them apart means a red says which one went.
// The convergence act's timeout carries a full diagnosis of both pages
// (todos, `usSynced`, sync status, endpoint id, and the wire-keeper's own
// view of its handles) in the solo-offline-sync manner.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, sleep } from "../util.ts";
import {
  addTodo,
  appFrame,
  createAccount,
  pairPages,
  setAccountName,
  solo,
  stripPersonal,
  todoRows,
  until,
  WAITS,
} from "../solo-util.ts";

/** The account's own face, so the strip has something to still be
 * showing during the outage. Not 265 (what both pages are seeded with),
 * for the reason solo-pairing gives: a strip that never changed must not
 * be able to pass by standing still. */
const ACCOUNT_NAME = "Ada";
const ACCOUNT_HUE = 175;

/** THE FOUR TODOS, and which side each is authored on. The two outage
 * ones are authored CONCURRENTLY, one per side, because the claim is a
 * MERGE: a heal that only carried A's work to B would satisfy a
 * one-way delivery test and still lose half the user's typing. */
const SEED = "buy milk";
const CONTROL = "the control that crossed live";
const A_ALONE = "A wrote this alone";
const B_ALONE = "B wrote this alone";

/** MEASURED LIVE CROSSING: 4ms, two paired pages on one box (the probe
 * this file's banner reports). Thirty seconds is that with three orders
 * of magnitude of margin — it exists so a busy CI box cannot turn the
 * PRECONDITION into the failure, not because 30s is plausible. */
const CONTROL_MS = 30_000;

/** HOW LONG THE OUTAGE IS WATCHED before it is called a real partition.
 * A negative assertion, so its length is its whole strength: 30s is
 * CONTROL_MS's own bound, i.e. a window in which a working wire
 * demonstrably delivers — measured at ~7500x under it. (The relay
 * process is dead for this whole window, so there is no slower cadence
 * left that could have been mid-flight: run.ts's Relay.stop() does not
 * return until the port REFUSES.) */
const OUTAGE_WATCH_MS = 30_000;

/** WHAT THE HEAL IS GIVEN, sized to the measurement rather than to a
 * guess at machinery that did not exist yet:
 *
 *     ≤5s   the wire-keeper's tick noticing the relay is back and
 *           running its repair (solo.ts's `KEEPER_TICK_MS`)
 *   + ~1s   rebind, repost, re-dial, re-handshake (measured: the
 *           post-rebind `sync-start` settles in 0.20s headless, and a
 *           todo crosses in 0.03–0.06s — demo/host/rebind-sync-check.ts)
 *   + slack for a missed tick and a busy CI box
 *   ------
 *     MEASURED end to end on this harness: 4.8–5.4s over five
 *     consecutive runs, from `startRelay()` to both ENGINES holding the
 *     merged set.
 *
 * 60s is that with an order of magnitude of margin. It is not sized to
 * the old never-happens world — the previous 150s existed to give a heal
 * that was not coming every retry it might plausibly have grown, and
 * that reasoning is stale. This bound's only job now is to absorb a slow
 * box without letting a genuine regression cost the suite minutes. */
const HEAL_MS = 60_000;

/** AND WHAT THE SCREENS ARE GIVEN, once the engines agree.
 *
 * A REPAINT IS NOT A CLAIM VIOLATION, which is the whole reason this is
 * a bounded wait and not a bare read. The engine convergence above is
 * the network fact; the rows are rendered off a LATER drain, so sampling
 * the DOM in the same breath catches a page mid-frame and fails on a row
 * that appears milliseconds later. That was the last intermittent red in
 * this file's life — a zero-tolerance DOM read racing the repaint, which
 * alternated which device's row it found "missing" — and every other row
 * assertion in this suite already waits.
 *
 * 30s: the drain that repaints runs on a 1s cadence, so a healthy paint
 * is one or two of those behind the engine. Thirty of them is generous
 * enough that a loaded box cannot turn a paint into a red, and short
 * enough that a screen which genuinely never updates reports promptly —
 * which is a real bug worth failing on, and the reason this is asserted
 * at all rather than dropped as "the engine agreed, good enough".
 *
 * Measured: 0.26–0.54s over five consecutive runs, so the bound carries
 * roughly two orders of magnitude of headroom. */
const RENDER_MS = 30_000;

/** Everything a timeout in this scenario should be able to say about a
 * page, in the shape solo-offline-sync attaches to its own waits: what
 * the engine holds, whether the page thinks it is wired, and what the
 * transport says about itself. Best-effort throughout — a diagnosis
 * that threw would replace the real failure with its own. */
async function diagnose(label: string, page: Page): Promise<string> {
  const read = async (what: string, f: () => Promise<unknown>) => {
    try {
      return `${what}=${JSON.stringify(await f())}`;
    } catch (e) {
      return `${what}=<${e instanceof Error ? e.message : String(e)}>`;
    }
  };
  const parts = [
    await read("todos", () => solo(page, "todos")),
    await read("usSynced", () => solo(page, "usSynced")),
    await read("sync", () => solo(page, "syncStatus")),
    // THE WIRE-KEEPER'S OWN VIEW, added with #113 and the single most
    // useful line in this diagnosis now: which handles the page holds and
    // what `conn-status` says about each. A reader meeting this failure
    // needs to know whether the transport came back — because it does,
    // and everything upstream of that fact is already working.
    await read("wire", () => solo(page, "wireHealth")),
    // A PREFIX, not the whole id: 64 hex characters per page would
    // drown the two facts either side of it, and all a reader needs
    // from a transport address here is whether it is present and
    // whether it is the SAME one it was before the fault.
    await read("endpoint", async () => ((await solo(page, "endpointId")) as string).slice(0, 8)),
  ];
  return `${label}: ${parts.join(" ")}`;
}

/** Both pages' diagnosis, one string, for attaching to a wait that lost. */
const diagnoseBoth = async (a: Page, b: Page) =>
  `${await diagnose("A", a)} | ${await diagnose("B", b)}`;

/** The todo titles the ENGINE holds, sorted — convergence is a property
 * of the partition, so it is asserted on the engine's view (solo-pairing's
 * rule) and compared as a SET, since automerge owes no ordering. */
async function engineTodos(page: Page): Promise<string[]> {
  const t = (await solo(page, "todos").catch(() => [])) as string[];
  return [...t].sort();
}

const scenario: Scenario = {
  name: "relay-partition",
  why:
    "a relay outage between two LIVE paired devices heals by itself when the relay returns — the wire is marked gone, the endpoint rebound, the dial remade and subduction resumed, and both devices converge with no reload and no ceremony",
  // Boot + pairing + CONTROL_MS's crossing + the 30s OUTAGE_WATCH_MS
  // window + a ~5s heal ≈ 39s measured (38.7–39.2s over five runs). 180s is comfortably over 4x
  // that: the two deliberate 30s waits are what this scenario costs, and
  // a heal that has regressed reports inside HEAL_MS long before this
  // outer deadline is reached.
  deadlineMs: 180_000,
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(pageA: Page, ctx: Ctx) {
    const pageB = await ctx.fresh({
      path: "/solo.html",
      bootGlobal: "__solo",
      storage: { [SOLO_KEYS.hue]: "265" },
    });
    const both = [pageA, pageB];

    // --- the precondition: two live siblings, actually syncing ---------

    await act("A holds an account with a todo, and B joins it", async () => {
      await createAccount(pageA);
      await setAccountName(pageA, ACCOUNT_NAME, ACCOUNT_HUE);
      await addTodo(pageA, SEED);
      assertEquals(await solo(pageB, "hasAccount"), false, "B must hold no account of its own");
      await pairPages(pageA, pageB, "the other tab");
      await until(both, "B's account", async () => await solo(pageB, "hasAccount"), WAITS.enrolled);
      const titles = await until(both, "A's seed todo on B", async () => {
        const t = await engineTodos(pageB);
        return t.includes(SEED) ? t : false;
      }, WAITS.converge);
      assertEquals(titles.length, 1, `B's todos after joining: ${JSON.stringify(titles)}`);
    });

    await act("the wire is LIVE: a todo crosses in seconds, un-prompted", async () => {
      // THE BASELINE THE WHOLE SCENARIO IS MEASURED AGAINST. Without
      // it, "nothing crossed during the outage" could be said of a pair
      // that was never syncing in the first place, and the heal act
      // would be waiting on a wire that never existed.
      await addTodo(pageA, CONTROL);
      const titles = await until(both, "A's control todo on B", async () => {
        const t = await engineTodos(pageB);
        return t.includes(CONTROL) ? t : false;
      }, CONTROL_MS).catch(async (e) => {
        throw new Error(`${e instanceof Error ? e.message : e} — ${await diagnoseBoth(pageA, pageB)}`);
      });
      assertEquals(titles.length, 2, `B's todos: ${JSON.stringify(titles)}`);
    });

    // --- the cut --------------------------------------------------------

    await act("the relay goes away, and both devices are edited while alone", async () => {
      // `stopRelay()` does not return until the relay's own
      // `/generate_204` REFUSES (run.ts's Relay.stop()), so from here on
      // there is provably no relay, rather than a relay that is slow.
      await ctx.stopRelay();

      // CONCURRENT AUTHORSHIP, one edit per side. This is what makes the
      // heal a MERGE rather than a delivery: at the moment the relay
      // returns, each engine holds a change the other has never seen.
      await addTodo(pageA, A_ALONE);
      await addTodo(pageB, B_ALONE);

      // Each side took its OWN edit — the local write path owes the user
      // nothing from the network, and a page that had swallowed the
      // typing would make everything after this meaningless.
      assert(
        (await engineTodos(pageA)).includes(A_ALONE),
        `A kept its own outage edit: ${JSON.stringify(await engineTodos(pageA))}`,
      );
      assert(
        (await engineTodos(pageB)).includes(B_ALONE),
        `B kept its own outage edit: ${JSON.stringify(await engineTodos(pageB))}`,
      );

      // AND THE CUT IS REAL: neither edit reaches the other side for a
      // window in which the live wire demonstrably delivers.
      //
      // THIS ACT USED TO TAKE ~60s IN PRACTICE, not OUTAGE_WATCH_MS: the
      // FIRST `tick` after the relay died queued behind `adderWire`'s
      // background retry, which held one `enqueue` slot open for its
      // whole 30s `subscribe`-wait against the now-dead transport (the
      // subscribe/dial `until` loops solo.ts runs at ceremony time).
      // FIXED BY #115: those waits now enqueue each driver call
      // individually rather than the whole 30s wait as one job, so a
      // dead-transport retry no longer blocks anything else queued
      // behind it. This act now costs ~OUTAGE_WATCH_MS, not
      // OUTAGE_WATCH_MS-plus-a-stalled-tick — measured at ~30.5s on this
      // harness, against ~60.5s before the fix.
      const deadline = Date.now() + OUTAGE_WATCH_MS;
      while (Date.now() < deadline) {
        for (const p of both) await solo(p, "tick").catch(() => {});
        const a = await engineTodos(pageA);
        const b = await engineTodos(pageB);
        // The diagnosis is built ONLY when the assertion is about to
        // fail. Composed eagerly as an argument it would run eight
        // driver round trips per second for the whole window, which
        // does not change the verdict but does change how long the
        // window takes to pass — a wait must cost what it says it
        // costs.
        if (b.includes(A_ALONE) || a.includes(B_ALONE)) {
          assert(
            false,
            "an edit crossed WHILE THE RELAY WAS DOWN — some path other than " +
              "the relay is carrying these bytes, and this scenario's whole " +
              `partition premise is wrong: ${await diagnoseBoth(pageA, pageB)}`,
          );
        }
        await sleep(1_000);
      }
    });

    await act("both pages stay ALIVE and usable through the outage", async () => {
      // THE #115 REGRESSION GATE: a tick against a relay that has been
      // dead for a whole OUTAGE_WATCH_MS window still completes quickly.
      // 10s is generous — every measured tick here is milliseconds — but
      // bounded rather than exact, because a busy CI box's occasional
      // slow tick is not this bug; a tick that eats a 30s driver-call
      // deadline is. Both pages, because the fix applies to either
      // role's retry (`adderWire`'s subscribe, `joinerWire`/resumeWire's
      // dial).
      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        const t0 = Date.now();
        await solo(page, "tick").catch(() => {});
        const ms = Date.now() - t0;
        assert(
          ms < 10_000,
          `${who}'s tick with the relay dead took ${ms}ms (#115 regression: it should be milliseconds, not a stalled 30s driver-call deadline)`,
        );
      }
      // THE TRANSPORT-REFUSAL SCENARIO'S SPIRIT, applied to the relay: a
      // dead wire may cost a user their sync, never their app. Asserted
      // on the PIXELS both sides of the frame boundary — the todomvc
      // rows the app rendered, and the visor strip that frames them —
      // because "alive" is a thing a user sees, not a flag a page sets.
      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        // The app's own input is still there and still accepting.
        await appFrame(page).locator("input.new-todo").waitFor({
          state: "visible",
          timeout: WAITS.converge,
        });
        const rows = await todoRows(page).count();
        assertEquals(rows, 3, `${who}'s rendered rows during the outage`);
        // And the visor above it still knows whose account this is —
        // no trap, no wedged strip, no spinner that ate the page.
        // The ACCOUNT's own name, which A committed before pairing and B
        // adopted over the wire — so on B this is a positive read of
        // state that arrived while the wire was up and survived it
        // going down, not a page that happens to be showing something.
        const personal = await stripPersonal(page);
        assert(
          personal.identityText.includes(ACCOUNT_NAME),
          `${who}'s strip still names the account during the outage: ${JSON.stringify(personal)}`,
        );
      }
      // USABLE, not merely painted — and deliberately WITHOUT
      // committing a fifth todo: the convergence claim below names an
      // exact four-title set, so an extra row authored here would have
      // to be authored on both sides to keep it, which is precisely
      // what a partition forbids. Typing into the box and reading it
      // back is the honest test of "the surface is still taking input"
      // that costs the later assertion nothing.
      const input = appFrame(pageA).locator("input.new-todo");
      await input.fill("typing during an outage");
      assertEquals(
        await input.inputValue(),
        "typing during an outage",
        "A's app still takes typing while the relay is gone",
      );
      // Left uncommitted on purpose: no Enter, so no fifth todo, and the
      // box is cleared so `addTodo`'s empty-box precondition still holds
      // for anything after this act.
      await input.fill("");
    });

    // --- THE CLAIM, in two acts -----------------------------------------

    await act("the relay returns and BOTH devices converge, with nothing reloaded", async () => {
      await ctx.startRelay();
      // Nothing else happens here. No reload, no re-pairing, no button:
      // the entire claim is that the machinery the pages already have
      // notices the relay is back and finishes the job. `until` drives
      // both pages' own drain timers while it waits — the same service a
      // user's browser gives them for free — and nothing more.
      const want = [A_ALONE, B_ALONE, CONTROL, SEED].sort();
      await until(both, "both devices to hold the same four todos", async () => {
        const a = await engineTodos(pageA);
        const b = await engineTodos(pageB);
        return JSON.stringify(a) === JSON.stringify(want) &&
            JSON.stringify(b) === JSON.stringify(want)
          ? true
          : false;
      }, HEAL_MS).catch(async (e) => {
        // THE DIAGNOSIS, because this is the act a reader will meet as a
        // regression in whatever closed the gap — and the `wire` field
        // says WHICH gap came back. Two LIVE wires with nothing crossing
        // is the wave-3 shape (subduction holding a stale connection);
        // a dead, missing or never-re-dialled wire is wave 2 (the page's
        // wire-keeper); a wire still reading alive on a relay that has
        // been dead for half a minute is wave 1 (the `gone:` marker).
        // The banner's arithmetic for each is above.
        throw new Error(
          `${e instanceof Error ? e.message : e}\n` +
            `        the relay came back and the two devices did not converge ` +
            `within ${HEAL_MS / 1000}s. Expected exactly ${JSON.stringify(want)} on both.\n` +
            `        ${await diagnoseBoth(pageA, pageB)}`,
        );
      });
    });

    await act("and both SCREENS follow: each device RENDERS the other's outage edit", async () => {
      // THE USER'S OWN TEST. A partition that healed in the engine but
      // not on the surface is still a device that "stopped updating", so
      // the claim is not finished until the rows say so on both sides.
      //
      // WAITED FOR, NOT SAMPLED — see `RENDER_MS`. The engines agreed in
      // the act above; the rows are painted off a later drain, and a bare
      // read here raced that repaint. It is its own act so that a red
      // says plainly which half went: this one green means the network
      // healed and the surface did not.
      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        await until(both, `${who}'s rows to show both outage edits`, async () => {
          const rendered = await todoRows(page).allTextContents();
          return rendered.some((t) => t.includes(A_ALONE)) &&
            rendered.some((t) => t.includes(B_ALONE));
        }, RENDER_MS).catch(async (e) => {
          throw new Error(
            `${e instanceof Error ? e.message : e}\n` +
              `        ${who}'s engine holds the merged set but its rows do not show it ` +
              `after ${RENDER_MS / 1000}s: ${JSON.stringify(await todoRows(page).allTextContents())}\n` +
              `        ${await diagnoseBoth(pageA, pageB)}`,
          );
        });
      }
    });
  },
};

export default scenario;
