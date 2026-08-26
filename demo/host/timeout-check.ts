// The gate for #123: a sync against a SILENT peer must end, and end
// with a name.
//
//   deno run -A host/timeout-check.ts        (or: just timeout-check)
//
// WHY A THIRD PROBE. `conn-gone-check.ts` proves the engine notices a
// DEAD wire; `rebind-sync-check.ts` proves it can USE a replacement.
// Neither says anything about the third shape, which is the one #123 is
// about: a wire nothing has killed, carrying a peer that has stopped
// answering. Until #123 the engine's subduction `Timeout` was
// `NeverTimeout` — literally `Ok(fut.await)` — so that shape did not
// produce a slow sync, it produced a sync that NEVER SETTLED, and the
// handle sat unread for the life of the page.
//
// WHAT IS ASSERTED, EXACTLY: BOUNDED, NOT PARKED. The claim under test
// is that `sync-start` against a silent peer REACHES A NAMED OUTCOME
// within a bound — not which layer produced it. Two mechanisms can
// legitimately win the race here:
//
//   - THE CALL TIMEOUT (#123's `MonotonicTimeout`): subduction's
//     `CallTimeout::Default` resolves to `DEFAULT_ROUNDTRIP_TIMEOUT`,
//     30s, and the roundtrip is dropped. `conn-status` still says LIVE:
//     the wire is fine, the peer is silent.
//   - THE QUIC IDLE TIMEOUT plus #122's teardown: the transport itself
//     gives up on the blackholed path, `conn-status` flips to `gone:`,
//     the connection is removed and the sync fails against a closed
//     transport.
//
// Both are bounded outcomes and both are correct. The probe REPORTS
// which one won (it watches `conn-status` alongside the sync and prints
// the order the two landed in) and fails only on the third
// possibility — nothing settles at all — which is the pre-#123
// behaviour. Pinning one mechanism would make this probe a test of the
// relay's idle timer as much as of the engine's bound.
//
// MEASURED, AND SAID PLAINLY: ON THIS RIG QUIC USUALLY WINS. Running
// this probe against a deliberately reverted guest (the `Ok(fut.await)`
// body put back) settles in 30.20s and reports `gone:`, against 30.03s
// and `gone:` with the bound in place. iroh's idle timeout and
// subduction's `DEFAULT_ROUNDTRIP_TIMEOUT` are BOTH 30s, and blackholing
// a path takes the QUIC keepalives down with the application traffic —
// so a headless rig cannot produce "live wire, silent peer" from the
// network side alone. That is a fact about transports, not a gap that
// more probe cleverness closes: app-level silence needs a cooperating
// peer engine that ignores requests, which would mean test-only WIT
// surface on a shipping world, and that trade is not worth it.
//
// WHAT THIS PROBE IS THEREFORE WORTH, precisely: it pins
// BOUNDED-NOT-PARKED end to end — the property #123 is about — and it
// would go red on any future path where the transport does NOT rescue
// the sync (which is the whole family the bound exists for, and exactly
// the shape #113 hit). It does not, on this rig, prove that the call
// bound specifically fired. What proves the bound's machinery works is
// the clock itself: `wasi:clocks/monotonic-clock@0.3.0`'s `wait-for`
// was measured through a temporary guest export during #123's bringup
// (asked 100ms → guest measured 109ms; asked 250ms → 252ms), and the
// export was removed rather than left as permanent test-only surface.
//
// THE ARRANGEMENT. Alice talks to the relay directly; BOB reaches it
// through the e2e suite's severable TCP proxy (e2e/proxy.ts, imported
// rather than re-implemented — it is harness code and its
// `blackhole()` is precisely this fault shape: bytes stop moving, no
// RST, no FIN, sockets stay open). Blackholing the proxy leaves bob's
// engine running and its sockets open while nothing it says reaches
// anyone — app-level silence, which is what a wedged remote engine
// looks like from across a healthy network.
//
// The healthy CONTROL beat runs first and is not a formality: a timeout
// impl that bounds the silent path by also slowing the working one is
// the wrong fix, so the control asserts a settle in well under a second
// on the same rig.

import { type Engine, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNoNet } from "./probe-net.ts";
import { startTcpProxy } from "../e2e/proxy.ts";

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL("../../engine/target/composed.wasm", import.meta.url);
const RELAY_BIN = new URL("../../engine/.deps/relay/bin/iroh-relay", import.meta.url).pathname;

/// The healthy-path budget. `rebind-sync-check` measures ~0.2s on this
/// rig; a second is generous and still an order of magnitude under the
/// bound being tested, so the two beats can never be confused.
const CONTROL_MS = 1_000;
/// How long the blackholed sync gets before the probe calls it PARKED.
/// The engine's own bound is 30s (subduction's `DEFAULT_ROUNDTRIP_TIMEOUT`,
/// mirrored by the handshake constant in the guest); `sync_with_peer`
/// may spend that per connection it walks, so this is 30s plus room for
/// one such walk plus polling slack — a "long enough to believe never"
/// figure, not a performance budget.
const BOUND_MS = 90_000;
/// The `conn-status` dead-wire marker (engine.wit's `conn-status`
/// contract). Matched with `includes`: the host prefixes the guest's
/// message ("component error: gone: …").
const GONE = "gone:";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** conn-gone-check.ts's Relay, verbatim in behaviour: an ephemeral port
 * of this probe's own (a shared :3340 would take sibling runs down with
 * it), and `/generate_204` — the relay's own net-report endpoint — as
 * the readiness signal. */
class Relay {
  #proc: Deno.ChildProcess | null = null;
  #dir: string | null = null;
  readonly url: string;
  constructor(readonly port: number) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    if (this.#proc) return;
    try {
      await Deno.stat(RELAY_BIN);
    } catch {
      console.error(`no iroh-relay at ${RELAY_BIN} — run \`cd engine && just relay-bin\``);
      Deno.exit(2);
    }
    this.#dir ??= await Deno.makeTempDir({ prefix: "pm-timeout-relay." });
    const cfg = `${this.#dir}/relay.toml`;
    await Deno.writeTextFile(
      cfg,
      `http_bind_addr = "127.0.0.1:${this.port}"\nenable_metrics = false\n`,
    );
    this.#proc = new Deno.Command(RELAY_BIN, {
      args: ["--dev", "--config-path", cfg],
      stdout: "null",
      stderr: "null",
    }).spawn();
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`${this.url}/generate_204`, { signal: AbortSignal.timeout(2_000) });
        await r.body?.cancel();
        if (r.status === 204 || r.ok) return;
      } catch { /* not up yet */ }
      await sleep(250);
    }
    throw new Error(`the local relay never answered on ${this.url}`);
  }

  async dispose(): Promise<void> {
    const proc = this.#proc;
    this.#proc = null;
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch { /* already dead */ }
      await proc.status;
    }
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

/** Whether the engine still calls this wire alive — read at the moment
 * the sync settles, which is what tells the two winning mechanisms
 * apart. */
async function wireState(e: Engine, conn: number): Promise<"live" | "gone" | "error"> {
  try {
    return (await e.driver.connStatus(conn)) === undefined ? "error" : "live";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes(GONE) ? "gone" : "error";
  }
}

/** A `sync-start` allowed NOT to settle: `until` throws on timeout,
 * which is the right shape for the control and the wrong shape for the
 * assertion — here the difference between "errored" and "never
 * answered" is the entire result, so both are returned as data. */
async function settle(
  e: Engine,
  peer: Uint8Array,
  part: Uint8Array,
  subscribe: boolean,
  boundMs: number,
  /** When given, `conn-status` is polled alongside the sync and the
   * first moment it reported `gone:` comes back with the result — the
   * ordering of the two is what names the mechanism. */
  watchConn?: number,
): Promise<{ ms: number; outcome: string; errored: boolean; goneMs: number | null } | null> {
  const t0 = performance.now();
  const h = await e.driver.syncStart(peer, part, subscribe);
  let goneMs: number | null = null;
  const done = (outcome: string, errored: boolean) => ({
    ms: performance.now() - t0,
    outcome,
    errored,
    goneMs,
  });
  while (performance.now() - t0 < boundMs) {
    if (watchConn !== undefined && goneMs === null) {
      if (await wireState(e, watchConn) === "gone") goneMs = performance.now() - t0;
    }
    try {
      const s = await e.driver.syncStatus(h);
      if (s !== undefined) return done(s, false);
    } catch (err) {
      // An ERRORED sync is a SETTLED sync, and the outcome this probe
      // most expects: a bound fired and said so.
      return done(err instanceof Error ? err.message : String(err), true);
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const artifacts = {
    envelope: await Deno.readTextFile(ENVELOPE),
    bytes: await Deno.readFile(WASM),
  };
  const relay = new Relay(freePort());
  await relay.start();
  // Bob's whole view of the relay goes through here.
  const proxy = await startTcpProxy(relay.port);
  console.log(`relay up on ${relay.url}; bob's path proxied via ${proxy.url}`);

  const alice = await newEngine("alice", artifacts, probeNoNet);
  const bob = await newEngine("bob", artifacts, probeNoNet);
  try {
    const aliceId = unhex(await alice.driver.init(false));
    const bobId = unhex(await bob.driver.init(false));

    await alice.driver.irohBind(relay.url);
    const bobEp = await bob.driver.irohBind(proxy.url);
    const cb = await bob.driver.irohStart(false, new Uint8Array(), proxy.url, new Uint8Array());
    const ca = await alice.driver.irohStart(true, unhex(bobEp), relay.url, bobId);
    await until(
      "handshake",
      async () => (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)),
    );
    await until(
      "contact cards over the bridge",
      async () =>
        (await alice.driver.khKnowsAgent(bobId)) && (await bob.driver.khKnowsAgent(aliceId)),
    );

    const part = await alice.driver.createPartition();
    await alice.driver.khAddMember(part, bobId, "edit");
    await alice.driver.sealPartition(part);
    await bob.driver.adoptPartition(part);
    await until("bob's keyhive knows the doc", () => bob.driver.khKnowsAgent(part));

    // Pull before subscribe: a subscribe=true FIRST sync reports commits
    // received but does not store them (bringup.ts records the same
    // ordering constraint).
    const pullHandle = await bob.driver.syncStart(aliceId, part, false);
    await until("bob pull", () => bob.driver.syncStatus(pullHandle));
    await until("bob decrypts creation", async () => (await bob.tasks.revision()) >= 1n);

    // --- beat 1: the CONTROL — a healthy sync settles FAST ------------
    const control = await settle(alice, bobId, part, true, CONTROL_MS + 5_000);
    if (!control || control.errored || control.ms > CONTROL_MS) {
      throw new Error(
        `CONTROL: a healthy sync must settle in under ${CONTROL_MS}ms — got ` +
          (control ? `${control.ms.toFixed(0)}ms (${control.outcome})` : "no settle at all") +
          ` — the bound added in #123 must not cost the happy path anything`,
      );
    }
    console.log(`control: healthy sync settled in ${(control.ms / 1000).toFixed(2)}s`);

    // --- beat 2: bob goes SILENT (not dead) ---------------------------
    proxy.blackhole();
    console.log("bob's relay path blackholed: sockets open, bytes stop moving");

    // --- beat 3: THE ASSERTION — bounded, not parked ------------------
    const t0 = performance.now();
    const stuck = await settle(alice, bobId, part, true, BOUND_MS, ca);
    if (!stuck) {
      throw new Error(
        `sync-start against a SILENT peer never settled in ${BOUND_MS / 1000}s — ` +
          `this is the #123 shape exactly: the wire is not dead, the peer is not ` +
          `answering, and the call has no bound`,
      );
    }
    const wire = await wireState(alice, ca);
    const mechanism = wire === "gone"
      ? `the QUIC idle timeout + #122 teardown (conn-status reported gone: at ` +
        `${stuck.goneMs === null ? "settle time" : `${(stuck.goneMs / 1000).toFixed(2)}s`}) ` +
        `— the expected winner on a blackholed path, see this file's banner`
      : "the #123 call bound (conn-status still LIVE — live wire, silent peer)";
    console.log(
      `\nBOUNDED in ${(stuck.ms / 1000).toFixed(2)}s ` +
        `(${stuck.errored ? "errored" : "reported"}): ${stuck.outcome.slice(0, 200)}`,
    );
    console.log(`mechanism that won the race: ${mechanism}`);
    console.log(`elapsed since the blackhole: ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    console.log("timeout-check: OK");
  } finally {
    await proxy.close();
    await relay.dispose();
  }
}

if (import.meta.main) {
  await main();
  Deno.exit(0);
}
