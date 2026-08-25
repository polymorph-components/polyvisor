// ONE DEVICE'S RELAY PATH IS CUT — the asymmetric partition, and the
// heal that does not come. Registered `expected: "red"`: like its
// symmetric sibling (scenarios/relay-partition.ts), this scenario PINS
// A GAP rather than asserting a working property.
//
// ─── WHY A SECOND FILE ──────────────────────────────────────────────
//
// `expected: "red"` is a whole-SCENARIO flag: the run stops at the
// first failing act, so two partitions in one file would mean the
// second was never reached and never pinned. These are two distinct
// failures of the same missing machinery — a relay that vanishes for
// EVERYONE, and a relay path that vanishes for ONE device while the
// other sits happily connected — and each deserves to go green
// independently on the day it can.
//
// ─── THE CLAIM IT WOULD MAKE IF THE GAP WERE CLOSED ─────────────────
//
// A is on the harness's real relay; B reaches the same relay through a
// severable TCP proxy, which is B's `?relay=` and therefore B's home
// relay. They pair and sync live. B's path is then cut — A's is never
// touched, and A stays connected to a relay that is up the entire time
// — each device is edited while it is alone, and the cut is healed.
// Both devices then hold the same todo set, merged, with nothing
// reloaded.
//
// ─── THE ADDRESS WRINKLE, VERIFIED RATHER THAN ASSUMED ──────────────
//
// The obvious story about an asymmetric relay cut is "B advertises an
// address carrying B's relay URL, so A's dials toward B ride the proxy
// too". IN THIS CODEBASE THAT STORY IS WRONG, and it is worth writing
// down because it would otherwise be quietly assumed by the next
// reader: the dial address is built by the DIALER out of the DIALER's
// own relay URL. `dialPeer` passes the page's own `RELAY` constant into
// `iroh-start` (demo/host/solo.ts:2640), and the engine turns that into
// `EndpointAddr { addrs: vec![TransportAddr::Relay(relay_url)] }`
// (engine/guest/src/lib.rs:4134) — one entry, the dialer's relay. The
// account's device directory records B's ENDPOINT ID and nothing about
// where B's relay is (engine.wit's `us-device`). So A's dial toward B
// names the REAL relay, not the proxy.
//
// WHAT MAKES THE SEVER A PARTITION ANYWAY is the other end of the same
// picture: B's endpoint is BOUND with the proxy as its home relay
// (lib.rs:4093, from B's `?relay=`), and that home connection is the
// only way any packet — A's dial included — is delivered to B. Cutting
// it therefore cuts BOTH directions of B's relay path while leaving A's
// own relay connection untouched, which is exactly what "B is
// partitioned" should mean. MEASURED: with the proxy severed and one
// todo authored on each side, neither direction crossed in 45s, while
// before the cut B→A had crossed in 7ms.
//
// (And the two pages meet at all despite naming different relay URLs
// because the proxy's upstream IS the same relay process — measured:
// pairing, enrollment and first convergence all complete across the
// mismatched URLs. A proxy in front of a DIFFERENT relay would be a
// different experiment, and not this one.)
//
// ─── WHY sever(), NOT blackhole() ───────────────────────────────────
//
// One fault shape per act, and this act's is the RST one. Two reasons.
//
// First, it is the STRONGEST case for the claim being made: sever()
// kills B's relay socket outright (proxy.ts's `sever`), so B's page has
// the best possible evidence that its transport died — a socket error,
// not silence. A heal that fails even here fails for want of machinery,
// not for want of information, and that is the finding worth pinning. A
// blackhole would leave the page nothing to notice, and a red under it
// could always be read as "the page simply could not tell".
//
// Second, the healing side is deterministic: `restore()` heals NEW
// connections and deliberately does not resurrect the ones that lived
// through the fault (proxy.ts's banner, and harness-faults.ts's last
// act, which pins exactly that). So after `restore()` the world is
// unambiguous — B can reach the relay again, and only by dialling
// afresh. That is precisely the state the missing machinery would have
// to act in.
//
// ─── WHERE THE GAP IS ───────────────────────────────────────────────
//
// The same one relay-partition.ts traces in full, reached by a
// different road; the short form, in the page's own terms:
//
//   * the only patient retry on this page is `resumeWire`, entered ONLY
//     from the resumed-boot branch (demo/host/solo.ts:3366, :3374), and
//     it is the sole caller of `rebindEndpoint` for a `Closed` endpoint
//     (solo.ts:3132);
//   * a page that paired in THIS session is in a ceremony role
//     (`joinerWire` solo.ts:2673 / `adderWire` :2900), each latched by
//     its own `…Wired` guard after the first success — a retry for
//     wiring that never came up, not a re-dial for a wire that died;
//   * and neither side can learn the wire died at all: `conn-status`
//     latches the handshake's outcome and is never invalidated
//     — the outcome goes into `conn_results` once and is never
//     removed (engine/guest/src/lib.rs:4262, with :4198/:4255 for the
//     error outcomes), and `conn-status` reads it back for ever
//     (:4268-4275). solo.ts:2988-3012 already writes this down for the
//     neighbouring one-sided-reload case, though by the latch's OLD
//     line numbers — the code moved, the fact did not.
//
// THE MISSING PIECE, in the engine's own terms: a `conn-status` that
// goes false when the connection drops (named as the honest fix at
// solo.ts:3009-3012), and a page-side retry armed for the life of the
// page rather than only on the resumed-boot path.
//
// NOTHING RELOADS HERE, and no storage is bound — see relay-partition.ts
// for both, in full. A reload would enter `resumeWire` and heal (that is
// `solo-resume-sync`'s green claim); a bound store would let a bucket
// carry the todos and make the relay claim unfalsifiable.

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

const ACCOUNT_NAME = "Ada";
const ACCOUNT_HUE = 175;

/** The four todos. The two authored during the cut are CONCURRENT, one
 * per side, because a heal has to merge rather than deliver. */
const SEED = "buy milk";
const CONTROL = "the control that crossed live";
const A_ALONE = "A wrote this while B was cut off";
const B_ALONE = "B wrote this while it was cut off";

/** MEASURED live crossing through the proxy: 7ms (B→A). Thirty seconds
 * is that with room for a busy CI box, so a slow machine cannot turn
 * the PRECONDITION into this scenario's failure. */
const CONTROL_MS = 30_000;

/** How long the cut is watched before it is called a partition. A
 * negative assertion, so the window is its strength: it is CONTROL_MS's
 * own bound — a span in which the live wire demonstrably delivers, by
 * roughly four thousand times over. */
const CUT_WATCH_MS = 30_000;

/** What the heal is given. Derived exactly as relay-partition.ts's is
 * (see that file for the arithmetic): RESUME_TICK_MS 5s + the 30s dial
 * `until` + the 30s subscribe `until` + a 45s relay pull cadence ≈ 110s,
 * rounded to 150s for two full attempts. The probe behind this file
 * watched the full 150s and saw nothing move, so the red is not this
 * number being tight. */
const HEAL_MS = 150_000;

/** A page's whole story, for attaching to a wait that lost — the
 * solo-offline-sync pattern. Best-effort: a diagnosis that threw would
 * replace the real failure with its own. */
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

const diagnoseBoth = async (a: Page, b: Page) =>
  `${await diagnose("A (real relay)", a)} | ${await diagnose("B (proxied)", b)}`;

/** The titles the ENGINE holds, sorted: convergence is a property of the
 * partition (solo-pairing's rule), and automerge owes no ordering. */
async function engineTodos(page: Page): Promise<string[]> {
  const t = (await solo(page, "todos").catch(() => [])) as string[];
  return [...t].sort();
}

const scenario: Scenario = {
  name: "relay-partition-asym",
  why:
    "cutting ONE device's relay path and healing it brings both devices back into sync by itself (XFAIL: it does not; see this file's banner)",
  expected: "red",
  deadlineMs: 420_000,
  // PAGE A stays on the harness's own relay — `baseQuery` gives it that
  // for free, so this scenario names no relay at all here. B's override
  // is the whole asymmetry and it is written where B is opened.
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(pageA: Page, ctx: Ctx) {
    // B'S OWN ROAD TO THE RELAY. The harness closes this proxy when the
    // scenario ends (run.ts's `openProxies` finally), so nothing here
    // has to remember to.
    const proxy = await ctx.relayProxy();
    const pageB = await ctx.fresh({
      path: "/solo.html",
      bootGlobal: "__solo",
      storage: { [SOLO_KEYS.hue]: "265" },
      // THE ASYMMETRY, in one line: B's home relay is the proxy (the
      // `?relay=` override FreshOptions.query exists for), A's is the
      // real one. Both terminate at the same relay process.
      query: { relay: proxy.url },
    });
    const both = [pageA, pageB];

    // --- the precondition: two live siblings, one of them proxied ------

    await act("A and B pair across their two relay URLs, and converge", async () => {
      await createAccount(pageA);
      await setAccountName(pageA, ACCOUNT_NAME, ACCOUNT_HUE);
      await addTodo(pageA, SEED);
      assertEquals(await solo(pageB, "hasAccount"), false, "B must hold no account of its own");
      // The whole ceremony rides B's proxy in one direction and A's real
      // relay in the other; that it completes at all is the premise the
      // banner's "same relay process behind the proxy" note explains.
      await pairPages(pageA, pageB, "the proxied tab");
      await until(both, "B's account", async () => await solo(pageB, "hasAccount"), WAITS.enrolled);
      const titles = await until(both, "A's seed todo on B", async () => {
        const t = await engineTodos(pageB);
        return t.includes(SEED) ? t : false;
      }, WAITS.converge);
      assertEquals(titles.length, 1, `B's todos after joining: ${JSON.stringify(titles)}`);
    });

    await act("the proxied wire is LIVE: a todo crosses B → A in seconds", async () => {
      // AUTHORED ON B ON PURPOSE — the proxied side. A control that only
      // ever went A→B would leave "B can still be heard" untested, and
      // that is the direction the sever below has to be shown to kill.
      await addTodo(pageB, CONTROL);
      const titles = await until(both, "B's control todo on A", async () => {
        const t = await engineTodos(pageA);
        return t.includes(CONTROL) ? t : false;
      }, CONTROL_MS).catch(async (e) => {
        throw new Error(`${e instanceof Error ? e.message : e} — ${await diagnoseBoth(pageA, pageB)}`);
      });
      assertEquals(titles.length, 2, `A's todos: ${JSON.stringify(titles)}`);
    });

    // --- the cut, on ONE side only --------------------------------------

    await act("B's relay path is severed while A's stays up, and both are edited", async () => {
      // RST-shaped, and one shape per act (see the banner). A's own
      // relay connection is not touched by this and the relay process is
      // never stopped — the asymmetry is the point.
      proxy.sever();
      assert(
        (await solo(pageA, "hasAccount")) === true,
        "A still holds its account with its own relay untouched",
      );

      await addTodo(pageA, A_ALONE);
      await addTodo(pageB, B_ALONE);

      assert(
        (await engineTodos(pageA)).includes(A_ALONE),
        `A kept its own edit: ${JSON.stringify(await engineTodos(pageA))}`,
      );
      assert(
        (await engineTodos(pageB)).includes(B_ALONE),
        `B kept its own edit: ${JSON.stringify(await engineTodos(pageB))}`,
      );

      // BOTH DIRECTIONS ARE DEAD, which is the banner's address-wrinkle
      // claim made as an assertion rather than a comment: A→B fails
      // even though A's dial names the real relay, because B's home
      // connection through the proxy is what delivers it.
      const deadline = Date.now() + CUT_WATCH_MS;
      while (Date.now() < deadline) {
        for (const p of both) await solo(p, "tick").catch(() => {});
        const a = await engineTodos(pageA);
        const b = await engineTodos(pageB);
        // Built only when it is about to be needed — see the identical
        // note in relay-partition.ts: an eagerly-composed diagnosis
        // would run eight driver round trips per second for the whole
        // window and quietly double what this wait costs.
        if (b.includes(A_ALONE)) {
          assert(
            false,
            "A's edit reached B WITH B'S RELAY PATH SEVERED — B is not " +
              "actually partitioned, and this scenario's premise is wrong: " +
              `${await diagnoseBoth(pageA, pageB)}`,
          );
        }
        if (a.includes(B_ALONE)) {
          assert(
            false,
            "B's edit reached A WITH B'S RELAY PATH SEVERED — same premise, " +
              `other direction: ${await diagnoseBoth(pageA, pageB)}`,
          );
        }
        await sleep(1_000);
      }
    });

    await act("the CUT-OFF device stays alive and usable, and so does the connected one", async () => {
      // The transport-refusal scenario's spirit, applied to the device
      // that lost its path: a dead wire may cost a user their sync,
      // never their app. Read off the pixels on both sides of the frame
      // boundary, and on BOTH pages — the connected one is the control.
      for (const [who, page] of [["A (real relay)", pageA], ["B (severed)", pageB]] as [string, Page][]) {
        await appFrame(page).locator("input.new-todo").waitFor({
          state: "visible",
          timeout: WAITS.converge,
        });
        assertEquals(await todoRows(page).count(), 3, `${who}'s rendered rows during the cut`);
        // The ACCOUNT's name — committed on A before pairing and adopted
        // by B over the wire, so on B this is state that arrived while
        // the path was up and survived it being cut.
        const personal = await stripPersonal(page);
        assert(
          personal.identityText.includes(ACCOUNT_NAME),
          `${who}'s strip still names the account: ${JSON.stringify(personal)}`,
        );
      }
      // And B's surface still TAKES input. Not committed (no Enter): the
      // convergence claim below names an exact four-title set, and a
      // fifth todo authored on the cut-off side could not be matched on
      // the other. The box is cleared afterwards so `addTodo`'s
      // empty-box precondition still holds for anything later.
      const input = appFrame(pageB).locator("input.new-todo");
      await input.fill("typing while cut off");
      assertEquals(
        await input.inputValue(),
        "typing while cut off",
        "B's app still takes typing with its relay path severed",
      );
      await input.fill("");
    });

    // --- THE CLAIM (this is the act that is red) ------------------------

    await act("B's path is restored and BOTH devices converge, with nothing reloaded", async () => {
      // `restore()` heals NEW connections only — the ones that lived
      // through the fault stay dead by contract (proxy.ts's banner,
      // pinned by harness-faults.ts's last act). So from here B CAN
      // reach the relay, and only by dialling afresh: exactly the state
      // the missing machinery would have to act in.
      proxy.restore();
      const want = [A_ALONE, B_ALONE, CONTROL, SEED].sort();
      await until(both, "both devices to hold the same four todos", async () => {
        const a = await engineTodos(pageA);
        const b = await engineTodos(pageB);
        return JSON.stringify(a) === JSON.stringify(want) &&
            JSON.stringify(b) === JSON.stringify(want)
          ? true
          : false;
      }, HEAL_MS).catch(async (e) => {
        throw new Error(
          `${e instanceof Error ? e.message : e}\n` +
            `        B's relay path came back and the two devices did not re-find ` +
            `each other within ${HEAL_MS / 1000}s. Expected exactly ${JSON.stringify(want)} ` +
            `on both.\n        ${await diagnoseBoth(pageA, pageB)}`,
        );
      });
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
