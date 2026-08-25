// The gate for #113's RESIDUAL gap: subduction sync must survive an
// ENDPOINT REBIND, not just a fresh connection.
//
//   deno run -A host/rebind-sync-check.ts       (or: just rebind-sync)
//
// WHY A SECOND PROBE. `conn-gone-check.ts` proves the engine NOTICES a
// dead wire; this one proves the engine can USE the replacement. Those
// are different claims and the second one was false: after a relay
// outage both pages rebind their endpoint, re-dial, and `conn-status`
// goes LIVE within seconds — and then nothing crosses, for minutes,
// because `sync-start` on the reader side never settles. A liveness
// signal that leads to a wire nobody can sync over is a worse bug than
// no signal, so it gets its own gate.
//
// Same rig as conn-gone-check: this probe spawns its OWN relay child on
// an EPHEMERAL port (killing it is the experiment; a shared :3340 would
// take every other run down with it, and a fixed port collides with
// sibling worktrees).
//
// THE BEATS:
//   1. two engines, wired, a partition created/sealed/adopted, both
//      subscribed — and a todo actually CROSSES. That is the control:
//      the machinery works before anything is broken.
//   2. SIGKILL the relay; wait for both sides to report `gone:`
//      (#113's engine half, already gated by conn-gone-check).
//   3. restart the relay on the SAME port, and both sides `iroh-bind`
//      AGAIN — which is what the page's `rebindEndpoint` does. A rebind
//      keeps the endpoint IDENTITY (the persisted transport key) so the
//      peers can still find each other; what it replaces is the
//      endpoint RESOURCE and every connection hanging off it.
//   4. re-dial / re-accept; `conn-status` goes live again.
//   5. THE ASSERTION: `sync-start` settles on BOTH sides, and a todo
//      written after the outage crosses BOTH ways.
//
// Beat 5 is the one that was red. See the recipe comment in
// demo/justfile for what the failure looked like.

import { type Engine, hex, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNoNet } from "./probe-net.ts";

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL("../../engine/target/composed.wasm", import.meta.url);
const RELAY_BIN = new URL("../../engine/.deps/relay/bin/iroh-relay", import.meta.url).pathname;

/// How long a post-rebind `sync-start` gets to settle before the probe
/// calls it stuck. The healthy path settles in well under a second; the
/// broken path never settles at all, so this is a "how long to wait
/// before believing never" figure, not a performance budget.
const SETTLE_MS = 30_000;
/// How long the todo written after the outage gets to cross.
const CROSS_MS = 45_000;
/// The `conn-status` gone marker (engine.wit's `conn-status` contract).
const GONE = "gone:";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return await Promise.resolve(port);
}

/** conn-gone-check.ts's Relay, verbatim in behaviour: `/generate_204`
 * is the relay's own net-report endpoint, so answering it means SERVING
 * and refusing it means the kill actually landed. `start()` is
 * re-enterable and keeps the SAME config file — same port — which is
 * what beat 3 needs: a peer that rebinds must find a relay listening
 * where it expects one. */
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
    this.#dir ??= await Deno.makeTempDir({ prefix: "pm-rebind-relay." });
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
        // A TIMEOUT is not "down"; only a refusal is.
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        return;
      }
      await sleep(100);
    }
    throw new Error("the relay kept answering after being killed");
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

/** `conn-status` folded into three states. The WIT
 * `result<option<string>, string>` lowers to resolve-or-THROW, and the
 * host prefixes the guest's message ("component error: gone: …"), so
 * the marker is matched with `includes`, never `startsWith`. */
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

/** A `sync-start` that is allowed to NOT settle. `until` throws on
 * timeout, which is the right shape for a control and the wrong shape
 * for the assertion under test: this returns the summary or `null`, so
 * the probe can say WHICH side stuck rather than just failing. */
async function settle(
  who: string,
  e: Engine,
  peer: Uint8Array,
  part: Uint8Array,
  subscribe: boolean,
  boundMs: number,
): Promise<{ ms: number; summary: string } | null> {
  const t0 = performance.now();
  const h = await e.driver.syncStart(peer, part, subscribe);
  while (performance.now() - t0 < boundMs) {
    try {
      const s = await e.driver.syncStatus(h);
      if (s !== undefined) {
        const ms = performance.now() - t0;
        console.log(`  ${who} sync settled in ${(ms / 1000).toFixed(2)}s: ${s}`);
        return { ms, summary: s };
      }
    } catch (err) {
      // An ERRORED sync is still a settled sync — and a far better
      // outcome than silence, because it names something.
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${who} sync settled ERRORED: ${message}`);
      return { ms: performance.now() - t0, summary: `ERR ${message}` };
    }
    await sleep(200);
  }
  console.log(`  ${who} sync NEVER SETTLED within ${boundMs / 1000}s`);
  return null;
}

function dumpOnFail(engines: [string, Engine][]) {
  for (const [name, e] of engines) {
    const err = e.stderr();
    if (err.trim()) console.error(`--- ${name} stderr (last 4000) ---\n${err.slice(-4000)}`);
  }
}

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
    const aliceId = unhex(await alice.driver.init(false));
    const bobId = unhex(await bob.driver.init(false));

    // --- beat 1: the CONTROL — a working wire, and data crossing ------
    const aliceEp1 = await alice.driver.irohBind(relay.url);
    const bobEp1 = await bob.driver.irohBind(relay.url);
    let cb = await bob.driver.irohStart(false, new Uint8Array(), relay.url, new Uint8Array());
    let ca = await alice.driver.irohStart(true, unhex(bobEp1), relay.url, bobId);
    await until(
      "handshake",
      async () => (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)),
    );

    // Contact cards cross the bridge on their own once the handshake
    // lands; `kh-add-member` needs bob's card to exist here first.
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
    // ordering constraint). ONE sync-start, then poll ITS handle —
    // restarting a sync every poll would be a request storm, not a wait.
    const pullHandle = await bob.driver.syncStart(aliceId, part, false);
    await until("bob pull", () => bob.driver.syncStatus(pullHandle));
    await until("bob decrypts creation", async () => (await bob.tasks.revision()) >= 1n);
    for (const [who, e, peer] of [["bob", bob, aliceId], ["alice", alice, bobId]] as const) {
      const h = await e.driver.syncStart(peer, part, true);
      await until(`${who} subscribe`, () => e.driver.syncStatus(h));
    }
    await alice.tasks.add("before the outage");
    await until("CONTROL: bob sees alice's todo over the live wire", async () =>
      (await bob.tasks.items()).items.some((i) => i.title === "before the outage"));
    console.log("control: the wire works and a todo crossed");

    // --- beat 2: the outage -------------------------------------------
    const t0 = performance.now();
    await relay.stop();
    console.log("relay SIGKILLed");
    for (const [who, e, c] of [["alice", alice, ca], ["bob", bob, cb]] as const) {
      await until(`${who} reports gone`, async () => (await status(e, c)).tag === "gone");
    }
    console.log(`both sides gone after ${((performance.now() - t0) / 1000).toFixed(2)}s`);

    // --- beat 3: the relay returns and both sides REBIND ---------------
    await relay.start();
    console.log("relay back up on the same port");
    const tRebind = performance.now();
    const aliceEp2 = await alice.driver.irohBind(relay.url);
    const bobEp2 = await bob.driver.irohBind(relay.url);
    // The endpoint IDENTITY must survive: peers address each other by
    // it, and a rebind that minted a fresh one would make the two pages
    // undiscoverable to each other for reasons unrelated to sync. (This
    // probe's engines have no persisted transport key, so a CHANGED id
    // here is expected and is exactly why the re-dial below uses the
    // fresh `bobEp2` rather than the stale `bobEp1`.)
    console.log(
      `rebound: alice ${aliceEp1 === aliceEp2 ? "same" : "new"} endpoint id, ` +
        `bob ${bobEp1 === bobEp2 ? "same" : "new"}`,
    );

    // --- beat 4: re-dial ----------------------------------------------
    cb = await bob.driver.irohStart(false, new Uint8Array(), relay.url, new Uint8Array());
    ca = await alice.driver.irohStart(true, unhex(bobEp2), relay.url, bobId);
    await until(
      "re-handshake after the rebind",
      async () => (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)),
    );
    console.log(
      `conn-status LIVE again ${((performance.now() - tRebind) / 1000).toFixed(2)}s after the rebind`,
    );

    // --- beat 5: THE ASSERTION ----------------------------------------
    //
    // Both directions, because the failure was ASYMMETRIC: the side that
    // accepted settled and the side that dialled did not, and a probe
    // that only checked one of them would have been green through the
    // whole bug.
    const aliceSync = await settle("alice", alice, bobId, part, true, SETTLE_MS);
    const bobSync = await settle("bob", bob, aliceId, part, true, SETTLE_MS);
    const stuck = [
      ...(aliceSync ? [] : ["alice"]),
      ...(bobSync ? [] : ["bob"]),
    ];
    if (!aliceSync || !bobSync) {
      throw new Error(
        `sync-start never settled after the rebind on: ${stuck.join(", ")} — ` +
          `the connection is LIVE by conn-status but sync cannot use it ` +
          `(the stale-registration gap; see this file's banner)`,
      );
    }

    // Settling is necessary, not sufficient: a sync can report success
    // having talked to nobody. Only data crossing proves the wire.
    await alice.tasks.add("after the rebind");
    const tCross = performance.now();
    await until(
      "alice's post-rebind todo reaches bob",
      async () => (await bob.tasks.items()).items.some((i) => i.title === "after the rebind"),
      CROSS_MS,
    );
    const aliceToBob = performance.now() - tCross;

    await bob.tasks.add("bob's reply after the rebind");
    const tBack = performance.now();
    await until(
      "bob's post-rebind todo reaches alice",
      async () =>
        (await alice.tasks.items()).items.some((i) => i.title === "bob's reply after the rebind"),
      CROSS_MS,
    );
    const bobToAlice = performance.now() - tBack;

    console.log(
      `\nHEALED: alice→bob ${(aliceToBob / 1000).toFixed(2)}s, ` +
        `bob→alice ${(bobToAlice / 1000).toFixed(2)}s after the rebind ` +
        `(sync settle: alice ${(aliceSync.ms / 1000).toFixed(2)}s, ` +
        `bob ${(bobSync.ms / 1000).toFixed(2)}s)`,
    );
    console.log("rebind-sync-check: OK");
    // Keeps the unused-binding honest: the ids are read above only to
    // report whether the rebind preserved them.
    void hex(aliceId);
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
