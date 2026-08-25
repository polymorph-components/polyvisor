// A RELAY OUTAGE BETWEEN TWO LIVE SIBLINGS — and the heal that does not
// come. Registered `expected: "red"`: this scenario PINS A GAP.
//
// ─── THE CLAIM IT WOULD MAKE IF THE GAP WERE CLOSED ──────────────────
//
// Two devices of one account are paired and syncing live. The relay
// they meet over goes away; each device is edited while it is alone;
// the relay comes back. Both devices then hold the SAME todo set —
// merged, not merely one-way delivered — with nobody reloading
// anything, nobody re-running a ceremony, and nobody pressing a button.
// That is what a user means by "my other device caught up".
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
//     ALPN pair and a relay URL and nothing else (engine/guest/src/lib.rs
//     :4088-4096); `endpoint-options.webrtc` is never called, and
//     iroh.wit says of it "When disabled (the default), `webrtc` entries
//     are ignored for dialing and inbound signaling is discarded";
//   * the dial address offers no other wire anyway — `iroh-start` builds
//     `EndpointAddr { addrs: vec![TransportAddr::Relay(relay_url)] }`
//     (lib.rs:4134), one relay entry, no `webrtc` and no `ip:port`.
//
// MEASURED, not merely read: with two paired pages converging in 4ms,
// `ctx.stopRelay()` and then a todo authored on each side, NOTHING
// crossed in either direction for 60s. The relay is the path.
//
// ─── AND THE HEAL DOES NOT HAPPEN. WHERE THE GAP IS ──────────────────
//
// Same probe, continued: `ctx.startRelay()`, then 240s of watching with
// both pages alive and being ticked. Neither side ever saw the other's
// outage edit. Traced, in the page's own terms:
//
//   * THE ONLY PATIENT RETRY ON THIS PAGE IS `resumeWire`, and it is
//     entered only from the RESUMED-BOOT branch (demo/host/solo.ts:3366
//     and :3374 — the two `void resumeWire(…)` calls, both inside the
//     `probe.ok` arm that means "this device already held the account
//     when the page loaded"). Its tick loop is the thing that re-dials
//     every RESUME_TICK_MS (solo.ts:3016, :3214) and the only caller of
//     `rebindEndpoint` for a `Closed` endpoint (solo.ts:2879, :3132).
//   * A PAGE THAT PAIRED IN THIS SESSION NEVER ENTERS IT. It is in a
//     CEREMONY role — `joinerWire` (solo.ts:2673) or `adderWire`
//     (:2900) — each of which runs at most once: the `joinWired` /
//     `adderWired` guards latch true on the first success, and the
//     `WIRE_ATTEMPTS = 3` budget (solo.ts:2666) is a retry for wiring
//     that FAILED TO COME UP, not a re-dial for a wire that came up and
//     later died. So when the relay dies under a freshly-paired pair,
//     there is no loop left running that would ever dial again.
//   * AND NEITHER SIDE CAN EVEN LEARN THE WIRE DIED, which is why the
//     absence of a retry has no symptom. `conn-status` reports the
//     outcome of the HANDSHAKE and is never invalidated afterwards
//     — `iroh-start`'s spawned wiring writes the outcome into
//     `conn_results` once and nothing ever removes it
//     (engine/guest/src/lib.rs:4262, and :4198/:4255 for the two error
//     outcomes), and `conn-status` reads that map back for ever
//     (:4268-4275). `sync-status` is one-shot per round rather than a
//     subscription's health. solo.ts:2988-3012 writes this down
//     already, for the neighbouring one-sided-reload case; the relay
//     outage is the same engine limit reached by a different road.
//     (solo.ts's committed comment there still cites this latch by its
//     OLD line numbers — the code moved, the fact did not.)
//
// THE MISSING PIECE, in the engine's own terms: a `conn-status` that
// goes false when the connection drops (solo.ts:3009-3012 names exactly
// this), plus a page-side retry that is armed for the life of the page
// rather than only on the resumed-boot path. With the first, the second
// is cheap and cannot double-dial; without it, any re-dial-on-a-timer
// would be the double-dialling solo.ts's direction discipline exists to
// prevent — which is why this is pinned as a gap rather than papered
// over in a scenario-local workaround.
//
// ─── WHAT IS NOT THE SUBJECT ────────────────────────────────────────
//
// NOTHING RELOADS HERE. The one-sided-reload gap (solo.ts:2988-3012) is
// a different track's; the double reload is `solo-resume-sync`'s claim
// and it is GREEN, precisely because a reloaded page does enter
// `resumeWire`. The distinction is the finding: this account can
// survive both its devices being closed and reopened, but not its relay
// blinking while both stay open.
//
// NO STORAGE IS BOUND, deliberately. `solo-offline-sync` shows a todo
// crossing through a Drive bucket with no live peer at all; if this
// scenario bound a store, a heal could be the BUCKET's doing and the
// relay claim would be unfalsifiable. Neither page here has any store,
// so the relay is the only channel that exists.
//
// ─── HOW IT FAILS WHEN IT FAILS ─────────────────────────────────────
//
// The red act is the LAST one, and everything before it is a plain
// green precondition — pairing, a live crossing, a real cut. An xfail
// that went red because pairing broke would be a gap flag hiding a
// regression, so the last act's timeout carries a full diagnosis of
// both pages (todos, `usSynced`, sync status, endpoint id) in the
// solo-offline-sync manner, and the acts before it assert their own
// preconditions loudly.

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

/** WHAT THE HEAL IS GIVEN, derived rather than guessed — sized to what
 * SHOULD work if the missing piece existed, since an xfail whose wait
 * was too short would be pinning the harness's impatience instead of
 * the gap:
 *
 *     RESUME_TICK_MS   5s   solo.ts:3016 — the page's own retry cadence
 *   + dial deadline   30s   solo.ts:2641 — `until` around conn-status
 *   + subscribe       30s   solo.ts:2617 — `until` around sync-status
 *   + relay pull      45s   the relay-mediated pull cadence run.ts's
 *                           `deadlineMs` note names
 *   ------------------------
 *                    110s, and a missed tick costs at most another 5s
 *
 * Rounded up to 150s: two full dial-and-subscribe attempts plus a pull
 * cadence, which is a generous reading of every retry this page could
 * plausibly grow. The probe watched 240s and saw nothing move, so the
 * red is not this number being tight. */
const HEAL_MS = 150_000;

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
    "a relay outage between two LIVE paired devices heals by itself when the relay returns — no reload, no ceremony (XFAIL: it does not; see this file's banner)",
  // PINNED AS A GAP. Drop this flag the day the last act passes; the
  // runner fails an `expected: "red"` scenario that goes green, which
  // is what forces that promotion rather than leaving a stale flag.
  expected: "red",
  // Boot + pairing + CONTROL_MS + OUTAGE_WATCH_MS + HEAL_MS ≈ 250s of
  // deliberate waiting, well past the suite-wide 240s.
  deadlineMs: 420_000,
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
      // THIS ACT TAKES ~60s IN PRACTICE, not OUTAGE_WATCH_MS, and the
      // extra 30s is a fact about the PAGE rather than slack in this
      // loop. Measured, on this same harness: `stopRelay()` returns in
      // 2ms and each local `addTodo` in ~85ms, but the FIRST `tick`
      // after the relay dies takes ~30s — the drain runs a driver call
      // that goes out over the dead transport and unwinds on one of
      // solo.ts's own 30s `until` deadlines (:2617, :2641). It happens
      // ONCE; every later tick is milliseconds again, which is why the
      // liveness act after this one costs nothing. Worth knowing before
      // anyone reads the act's wall clock as a bug in the watch window.
      
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

    // --- THE CLAIM (this is the act that is red) ------------------------

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
        // THE DIAGNOSIS, because this act is the one a reader will meet
        // as a failure — either as the expected red or, one day, as a
        // regression in whatever closed the gap.
        throw new Error(
          `${e instanceof Error ? e.message : e}\n` +
            `        the relay came back and the two devices did not re-find each other ` +
            `within ${HEAL_MS / 1000}s. Expected exactly ${JSON.stringify(want)} on both.\n` +
            `        ${await diagnoseBoth(pageA, pageB)}`,
        );
      });
      // AND ON THE ROWS TOO, once the engines agree: the user's
      // complaint is about a screen, and a partition that healed in the
      // engine but not on the surface is still a device that "stopped
      // updating".
      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        const rendered = await todoRows(page).allTextContents();
        assert(
          rendered.some((t) => t.includes(A_ALONE)) && rendered.some((t) => t.includes(B_ALONE)),
          `${who}'s rendered rows after the heal: ${JSON.stringify(rendered)}`,
        );
      }
    });
  },
};

export default scenario;
