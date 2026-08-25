// ONE DEVICE'S RELAY PATH IS CUT — the asymmetric partition, and the
// heal that comes by itself. Green since #113 landed end to end,
// alongside its symmetric sibling (scenarios/relay-partition.ts), whose
// banner carries the full three-wave history both files were red for.
//
// ─── WHY A SECOND FILE ──────────────────────────────────────────────
//
// A scenario stops at its first failing act, so two partitions in one
// file would mean the second was never reached — and while both were
// pinned `expected: "red"` that also meant the second was never pinned.
// These are two distinct shapes of the same fault — a relay that
// vanishes for EVERYONE, and a relay path that vanishes for ONE device
// while the other sits happily connected — and they went green
// independently, which is exactly the argument for having kept them
// apart. (Measured: this one flipped first, on runs where its sibling
// was still losing a repaint race.)
//
// ─── THE CLAIM ──────────────────────────────────────────────────────
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
// ─── WHAT HAD TO BE TRUE, AND THE THREE WAVES IT TOOK ───────────────
//
// relay-partition.ts's banner traces all three in full; this file
// reaches the same machinery by a different road, so the short form,
// with the one thing that is specific to THIS fault called out:
//
//   WAVE 1 — THE PAGE COULD NOT RETRY, AND COULD NOT HAVE (#113 as
//   filed). The ceremony wires (`joinerWire` / `adderWire`) latch on
//   first success and never re-dial; the only patient loop was entered
//   from the resumed-boot branch alone. And `conn-status` latched the
//   HANDSHAKE's outcome for ever, so no page could tell a dead wire from
//   a live one — which made any re-dial-on-a-timer the double-dial the
//   direction discipline forbids (#78).
//
//   WAVE 2 — THE PAGE HALF: a machine-readable `gone:` marker written by
//   a per-connection monitor on the iroh WIT's `wait-closed`, plus ONE
//   WIRE-KEEPER in solo.ts armed for the life of every paired page,
//   which re-dials on that marker and on nothing else — rebinding a
//   `Closed` endpoint on the way, because a dead relay path latches this
//   device's own transport shut as well as its connections.
//
//   AND THIS FAULT IS WHERE THAT SIGNAL IS AT ITS STRONGEST: `sever()`
//   kills B's relay socket outright, so B's death is an ERROR rather
//   than silence. That was the argument for the fault shape while this
//   file was red (a heal that fails even here fails for want of
//   machinery, not information), and it is why B's side of the heal is
//   the fast one now.
//
//   WAVE 3 — THE STALE TRANSPORT CHAIN, which wave 2 uncovered: a
//   `QueueTransport` that held its own channel ends and so could never
//   fail, a subduction teardown driven only by that failure, an
//   `add_connection` that APPENDS rather than replaces, and a
//   `sync_with_peer` that walks the resulting list in order under a
//   never-firing timeout — so after a rebind it parked on the dead
//   connection and never reached the live one. The gone-monitor now
//   closes the dead connection's inbound queues, so subduction's own
//   teardown runs. Pinned red→green by demo/host/rebind-sync-check.ts
//   (`just rebind-sync`): post-rebind `sync-start` settles in 0.20s,
//   crossing 0.03–0.06s both ways.
//
//   THE ASYMMETRY THAT WAVE 3 EXPLAINS is worth keeping in THIS file in
//   particular, because this scenario is the asymmetric one and the two
//   asymmetries are unrelated: only the side that CALLS `sync_with_peer`
//   walked the stale list, so the dialling side hung while the accepting
//   side settled normally. That has nothing to do with which device's
//   relay path was cut — B is the cut device here AND the dialling one,
//   which is why this fault showed the bug so cleanly.
//
// NOTHING RELOADS HERE, and no storage is bound — see relay-partition.ts
// for both, in full. A reload would re-handshake from nothing and hide
// what is being claimed; a bound store would let a bucket carry the
// todos and make the relay claim unfalsifiable.

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

/** What the heal is given, sized as relay-partition.ts's is and for the
 * same reasons (that file carries the arithmetic in full):
 *
 *     ≤5s   the wire-keeper's tick noticing and running its repair
 *   + ~1s   rebind, repost, re-dial, re-handshake — measured headless at
 *           0.20s to settle and 0.03–0.06s to cross
 *           (demo/host/rebind-sync-check.ts)
 *   + slack for a missed tick and a busy box
 *   ------
 *     MEASURED end to end here: 4.3–4.6s over five consecutive runs,
 *     from `proxy.restore()` to both ENGINES holding the merged set.
 *
 * 60s is that with an order of magnitude of margin. The old 150s was
 * sized for a heal that was never coming, and that reasoning is stale. */
const HEAL_MS = 60_000;

/** And what the SCREENS are given once the engines agree. A repaint is
 * not a claim violation: the rows are rendered off a drain that runs a
 * beat behind the engine, so a bare DOM read here raced the paint and
 * was this file's last intermittent red. 30s is thirty of that drain's
 * 1s cadence — generous against a loaded box, short enough that a screen
 * which genuinely never updates still reports promptly. Same figure and
 * same reasoning as relay-partition.ts's; measured here at 0.03–0.53s
 * over five runs. */
const RENDER_MS = 30_000;

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
    // THE WIRE-KEEPER'S OWN VIEW (#113): which handles the page holds
    // and what `conn-status` says about each. First thing to read on a
    // failure, because it says WHICH wave came back: two LIVE wires with
    // nothing crossing is wave 3 (subduction on a stale connection); a
    // dead, missing or never-re-dialled wire is wave 2 (the page's
    // wire-keeper); a wire still reading alive on a path that has been
    // severed for half a minute is wave 1 (the `gone:` marker).
    await read("wire", () => solo(page, "wireHealth")),
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
    "cutting ONE device's relay path and healing it brings both devices back into sync by itself — the cut device marks its wire gone, rebinds, re-dials and resumes subduction, with no reload and no ceremony",
  // Boot + pairing across the two relay URLs + the crossing + the 30s
  // CUT_WATCH_MS window + a ~4.4s heal ≈ 38s measured (37.8–38.7s over
  // five runs). 180s is over
  // 4x that; the two deliberate 30s waits are what this scenario costs,
  // and a regressed heal reports inside HEAL_MS long before this outer
  // deadline is reached.
  deadlineMs: 180_000,
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

    // --- THE CLAIM, in two acts -----------------------------------------

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
    });

    await act("and both SCREENS follow: each device RENDERS the other's cut-off edit", async () => {
      // The user's own test — a partition that healed in the engine and
      // not on the surface is still a device that "stopped updating".
      // WAITED FOR, NOT SAMPLED (see `RENDER_MS`), and its own act so a
      // red says which half went: this one green means the network
      // healed and the screen did not.
      for (const [who, page] of [["A", pageA], ["B", pageB]] as [string, Page][]) {
        await until(both, `${who}'s rows to show both cut-off edits`, async () => {
          const rendered = await todoRows(page).allTextContents();
          return rendered.some((t) => t.includes(A_ALONE)) &&
            rendered.some((t) => t.includes(B_ALONE));
        }, RENDER_MS).catch(async (e) => {
          throw new Error(
            `${e instanceof Error ? e.message : e}\n` +
              `        ${who}'s engine holds the merged set but its rows do not show it ` +
              `after ${RENDER_MS / 1000}s: ` +
              `${JSON.stringify(await todoRows(page).allTextContents())}\n` +
              `        ${await diagnoseBoth(pageA, pageB)}`,
          );
        });
      }
    });
  },
};

export default scenario;
