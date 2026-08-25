// The gate for #113's ENGINE half: `conn-status` must stop being
// write-once. A wire that came up and later DIED has to say so, in a
// way a page can match on, or no page path may ever re-dial (a second
// dial to a live peer is a second connection carrying the same
// subscriptions — #78's direction discipline — so "retry on a timer"
// is only safe once "this one is dead" is knowable).
//
//   deno run -A host/conn-gone-check.ts        (or: just conn-gone)
//
// NEEDS NO `just infra`: the probe spawns its OWN iroh-relay child on an
// EPHEMERAL port, because killing the relay is the whole experiment and
// a shared one on :3340 would take everyone else's runs down with it.
// Same reason the port is never fixed: sibling worktrees run this
// concurrently.
//
// The beats:
//   1. two engines, bound to this probe's relay, wired alice→bob;
//      conn-status reports the peer on BOTH sides.
//   2. the healthy-path CONTROL: repeated reads over several seconds
//      keep reporting Ok. ("Gone" that fires on a live wire would pass
//      beat 4 for the wrong reason.)
//   3. SIGKILL the relay.
//   4. poll until both sides report the `gone: ` marker, printing the
//      measured kill→gone latency for each side.
//   5. LATCHED: read again, seconds later, still gone.
//
// WHAT GOVERNS THE LATENCY — and the surprise. The theory going in was
// the QUIC IDLE TIMEOUT: nothing writes on an idle connection, so
// nothing learns the path is gone from an error, and the connection
// would only end tens of seconds later when the timeout fired. That is
// NOT what this rig measures. These connections are relay-dialed, and
// the relay leg is a WEBSOCKET over TCP: killing the relay process
// closes that socket, and the endpoint learns synchronously. Measured
// kill→gone here is UNDER A SECOND on both sides.
//
// The idle timeout still exists and still governs the cases where no
// socket dies — a black-holing relay, a NAT drop, a cut path — so
// callers must treat "gone" as eventually-consistent on the order of
// tens of seconds, and `BOUND_MS` is sized for that slower mechanism
// rather than for the fast one this probe happens to trigger. Both
// numbers belong to the pinned endpoint (jsr:@polymorph/iroh@0.3.0),
// not to this engine, which is why this probe MEASURES and PRINTS
// rather than asserting a figure.

import { type Engine, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNoNet } from "./probe-net.ts";

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL("../../engine/target/composed.wasm", import.meta.url);
const RELAY_BIN = new URL("../../engine/.deps/relay/bin/iroh-relay", import.meta.url).pathname;

/// Measured kill→gone on this rig: under a second, both sides (the
/// websocket teardown above). The bound is not measured+50%, and
/// deliberately so: the fast path is an artifact of killing a LOCAL
/// relay process, and a bound tight enough to gate that would turn into
/// a flake the first time this runs somewhere the socket lingers and
/// the idle timeout has to do the work instead. 20s is comfortably
/// above both, and still far below "the gate hung".
const BOUND_MS = 20_000;
/// The contract's machine-readable marker (engine/guest/wit/engine.wit,
/// `conn-status`). The page half matches on this same prefix.
const GONE = "gone:";

async function freePort(): Promise<number> {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return await Promise.resolve(port);
}

/** The e2e suite's `Relay` class, trimmed to what one probe needs
 * (demo/e2e/run.ts:493). `/generate_204` is the relay's own net-report
 * endpoint: answering it is the relay saying it is SERVING, which is
 * stronger than the port being open — and refusing it is how we know
 * the kill landed rather than merely being issued. */
class Relay {
  #proc: Deno.ChildProcess | null = null;
  #dir: string | null = null;
  readonly url: string;
  constructor(readonly port: number) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    try {
      await Deno.stat(RELAY_BIN);
    } catch {
      console.error(
        `no iroh-relay at ${RELAY_BIN} — run \`cd engine && just relay-bin\``,
      );
      Deno.exit(2);
    }
    this.#dir ??= await Deno.makeTempDir({ prefix: "pm-conn-gone-relay." });
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
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the local relay never answered on ${this.url}`);
  }

  async stop(): Promise<void> {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
    await proc.status;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.url}/generate_204`, { signal: AbortSignal.timeout(2_000) });
        await r.body?.cancel();
      } catch (e) {
        // A TIMEOUT is not "down" — only a refusal is (the e2e Relay
        // makes the same split for the same reason).
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the relay kept answering after being killed");
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

/** What a `conn-status` read looks like from TS. The WIT
 * `result<option<string>, string>` lowers to resolve-or-THROW
 * (runtime/engine.ts's Driver contract), so an Err — including the
 * gone marker — arrives as a thrown exception whose message carries
 * the guest's string. Both shapes are folded here so the assertions
 * below read as three states, not as try/catch plumbing. */
type Status =
  | { tag: "alive"; peer: string }
  | { tag: "gone"; message: string }
  | { tag: "failed"; message: string }
  | { tag: "unknown" };

async function status(e: Engine, conn: number): Promise<Status> {
  try {
    const peer = await e.driver.connStatus(conn);
    return peer === undefined ? { tag: "unknown" } : { tag: "alive", peer };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes(GONE) ? { tag: "gone", message } : { tag: "failed", message };
  }
}

function dumpOnFail(engines: [string, Engine][]) {
  for (const [name, e] of engines) {
    const err = e.stderr();
    if (err.trim()) console.error(`--- ${name} stderr ---\n${err}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const artifacts = {
    envelope: await Deno.readTextFile(ENVELOPE),
    bytes: await Deno.readFile(WASM),
  };
  const relay = new Relay(await freePort());
  await relay.start();
  console.log(`relay up on ${relay.url} (ephemeral port, this probe's own child)`);

  const alice = await newEngine("alice", artifacts, probeNoNet);
  const bob = await newEngine("bob", artifacts, probeNoNet);
  try {
    await alice.driver.init(false);
    const bobId = unhex(await bob.driver.init(false));
    await alice.driver.irohBind(relay.url);
    const bobEp = unhex(await bob.driver.irohBind(relay.url));

    // Acceptor first, then the dial — the acceptor's `accept()` must be
    // pending before anyone connects (host/bringup.ts's wire phase does
    // exactly this ordering).
    const cb = await bob.driver.irohStart(false, new Uint8Array(), relay.url, new Uint8Array());
    const ca = await alice.driver.irohStart(true, bobEp, relay.url, bobId);
    await until(
      "subduction handshake over the probe's relay",
      async () => (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)),
    );
    console.log("both sides report a peer: the wire is up");

    // --- the healthy-path control -------------------------------------
    //
    // The monitor must not fire on a LIVE connection. Without this, beat
    // 4 would also pass for an engine that simply marked everything gone
    // after a few seconds.
    for (let i = 0; i < 6; i++) {
      await sleep(1_000);
      for (const [who, e, c] of [["alice", alice, ca], ["bob", bob, cb]] as const) {
        const s = await status(e, c);
        if (s.tag !== "alive") {
          throw new Error(`CONTROL FAILED: ${who} is ${s.tag} while the relay is up ` +
            `(${"message" in s ? s.message : "-"})`);
        }
      }
    }
    console.log("control: 6s of repeated reads, both sides stayed alive");

    // --- the kill -----------------------------------------------------
    //
    // `t0` is the instant the SIGKILL is ISSUED, not the instant
    // `relay.stop()` returns — stop() additionally waits for the port to
    // refuse, and folding that wait into the latency would flatter the
    // measurement.
    const t0 = performance.now();
    const stopped = relay.stop();
    console.log("relay SIGKILLed — waiting for the wire to notice");

    const seen: Record<string, number> = {};
    const messages: Record<string, string> = {};
    while (performance.now() - t0 < BOUND_MS) {
      for (const [who, e, c] of [["alice", alice, ca], ["bob", bob, cb]] as const) {
        if (seen[who] !== undefined) continue;
        const s = await status(e, c);
        if (s.tag === "gone") {
          seen[who] = performance.now() - t0;
          messages[who] = s.message;
          console.log(`  ${who}: gone after ${(seen[who] / 1000).toFixed(2)}s — ${s.message}`);
        } else if (s.tag === "failed") {
          throw new Error(`${who} reports a NON-gone error after the kill: ${s.message} ` +
            `(the gone marker is the contract; a bare error is not it)`);
        }
      }
      if (seen.alice !== undefined && seen.bob !== undefined) break;
      await sleep(100);
    }
    for (const who of ["alice", "bob"]) {
      if (seen[who] === undefined) {
        throw new Error(
          `${who} never reported "${GONE}" within ${BOUND_MS / 1000}s of the relay dying — ` +
            `conn-status is still write-once on that side`,
        );
      }
    }
    await stopped;
    console.log("relay confirmed refusing (SIGKILL landed, not merely issued)");

    // --- latched ------------------------------------------------------
    //
    // `wait-closed` is latched at the iroh layer and the engine writes
    // the marker once; the point of reading again is that nothing
    // LATER (a reconnect attempt, a handshake settling late) walks the
    // entry back to Ok.
    await sleep(5_000);
    for (const [who, e, c] of [["alice", alice, ca], ["bob", bob, cb]] as const) {
      const s = await status(e, c);
      if (s.tag !== "gone") throw new Error(`${who} un-latched: re-read says ${s.tag}`);
    }
    console.log("latched: 5s later both sides still report gone");

    console.log(
      `\nMEASURED kill→gone: alice ${(seen.alice / 1000).toFixed(1)}s, ` +
        `bob ${(seen.bob / 1000).toFixed(2)}s (bound ${BOUND_MS / 1000}s).`,
    );
    console.log("conn-gone-check: OK");
  } catch (e) {
    dumpOnFail([["alice", alice], ["bob", bob]]);
    throw e;
  } finally {
    await relay.dispose();
  }
}

if (import.meta.main) {
  await main();
  Deno.exit(0);
}
