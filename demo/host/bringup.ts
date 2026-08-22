// Deno bring-up of the engine composite under polyengine — retire the
// platform risks (translation, CM-async task wakeups, wasi p2+p3 track
// serving, webcrypto port coverage, iroh-over-websocket, wasi:http
// against MinIO) before any browser work.
//
//   deno run -A host/bringup.ts solo          # one instance, no wire
//   deno run -A host/bringup.ts wire          # two instances over the relay
//   deno run -A host/bringup.ts bucket        # MinIO flush + cold pull
//
// Infra (relay, MinIO) is started by the justfile.

import { type Engine, hex, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNet, probeNoNet, probeReaderNet } from "./probe-net.ts";
import { filesystemNode } from "@polyengine/wasi/filesystem-node";

const RELAY = "http://127.0.0.1:3340";
const S3 = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "pm-demo",
  access: "minioadmin",
  secret: "minioadmin",
};

const ENVELOPE = new URL("../build/engine.plan.json", import.meta.url);
const WASM = new URL(
  "../../engine/target/composed.wasm",
  import.meta.url,
);

async function loadArtifacts() {
  return {
    envelope: await Deno.readTextFile(ENVELOPE),
    bytes: await Deno.readFile(WASM),
  };
}

let stepT0 = performance.now();
function step(label: string) {
  const dt = (performance.now() - stepT0).toFixed(1);
  console.log(`[${dt.padStart(8)}ms] ${label}`);
  stepT0 = performance.now();
}

function dumpOnFail(engines: [string, Engine][]) {
  for (const [name, e] of engines) {
    const err = e.stderr();
    if (err.trim()) console.error(`--- ${name} stderr ---\n${err}`);
  }
}

// --- phase: solo -------------------------------------------------------------

async function solo() {
  const artifacts = await loadArtifacts();
  const t0 = performance.now();
  const a = await newEngine("solo", artifacts, probeNoNet);
  step(`instantiated (${(performance.now() - t0).toFixed(0)}ms total)`);
  try {
    const id = await a.driver.init(false);
    step(`init: ${id.slice(0, 16)}…`);
    const part = await a.driver.createPartition();
    step(`create-partition: ${hex(part).slice(0, 16)}…`);
    await a.driver.sealPartition(part);
    step("seal-partition");
    const milk = await a.tasks.add("buy milk");
    await a.tasks.add("write demo");
    step(`tasks.add ×2 (milk id ${milk})`);
    await a.tasks.setCompleted(milk, true);
    const snap = await a.tasks.items();
    step(`items: rev=${snap.revision} ${JSON.stringify(snap.items)}`);
    if (snap.items.length !== 2) throw new Error("expected 2 items");
    if (!snap.items.some((i) => i.title === "buy milk" && i.completed)) {
      throw new Error("toggle lost");
    }
    const [chunks, maxParents] = await a.driver.chunkStats(part);
    step(`chunk-stats: chunks=${chunks} max-parents=${maxParents}`);
    console.log("\nSOLO PASS");
  } catch (e) {
    dumpOnFail([["solo", a]]);
    throw e;
  }
}

// --- phase: wire -------------------------------------------------------------

async function wire() {
  const artifacts = await loadArtifacts();
  const alice = await newEngine("alice", artifacts, probeNoNet);
  const bob = await newEngine("bob", artifacts, probeNoNet);
  step("instantiated alice + bob");
  try {
    const aliceId = unhex(await alice.driver.init(false));
    const bobId = unhex(await bob.driver.init(false));
    step("init ×2");

    await alice.driver.irohBind(RELAY);
    const bobEp = unhex(await bob.driver.irohBind(RELAY));
    step("iroh-bind ×2");

    const cb = await bob.driver.irohStart(false, new Uint8Array(), RELAY, new Uint8Array());
    const ca = await alice.driver.irohStart(true, bobEp, RELAY, bobId);
    await until("handshake", async () =>
      (await alice.driver.connStatus(ca)) && (await bob.driver.connStatus(cb)));
    step("subduction handshake over iroh websocket relay");

    await until("contact cards", async () =>
      (await alice.driver.khKnowsAgent(bobId)) &&
      (await bob.driver.khKnowsAgent(aliceId)));
    step("contact cards over the bridge");

    const part = await alice.driver.createPartition();
    await alice.driver.khAddMember(part, bobId, "edit");
    await alice.driver.sealPartition(part);
    await bob.driver.adoptPartition(part);
    step("partition: create → member(edit) → seal → adopt");

    // Polyengine divergence probe (recorded): a subscribe=true FIRST sync
    // reports commits received but does not store them; a plain pull
    // stores fine. Order: pull first, then subscribe.
    const pull = async (who: string, e: typeof bob, from: Uint8Array) => {
      const h = await e.driver.syncStart(from, part, false);
      return await until(`${who} pull`, () => e.driver.syncStatus(h));
    };
    await until("bob's keyhive knows the doc (bridge)", () => bob.driver.khKnowsAgent(part));
    console.log("  bob pull:", await pull("bob", bob, aliceId));
    await until("bob decrypts creation", async () =>
      (await bob.tasks.revision()) >= 1n);
    const hs = await bob.driver.syncStart(aliceId, part, true);
    console.log("  bob subscribe:", await until("bob subscribe", () => bob.driver.syncStatus(hs)));
    console.log("  alice pull:", await pull("alice", alice, bobId));
    const ha = await alice.driver.syncStart(bobId, part, true);
    console.log("  alice subscribe:", await until("alice subscribe", () => alice.driver.syncStatus(ha)));
    step("pulls + subscriptions up");

    await alice.tasks.add("from alice");
    await until("bob sees alice's task", async () =>
      (await bob.tasks.items()).items.some((i) => i.title === "from alice"));
    step("alice → bob over the wire");

    await bob.tasks.add("from bob");
    await until("alice sees bob's task", async () =>
      (await alice.tasks.items()).items.some((i) => i.title === "from bob"));
    step("bob → alice over the wire (transitive put authority)");

    // Soak: revoke bob, keep every background loop running for 30s —
    // the browser wedge suspect (post-revocation refused pulls + nudged
    // keyhive re-syncs) reproduces here if it is engine-side.
    if (Deno.args[1] === "soak") {
      await alice.driver.khRevokeMember(part, bobId);
      await alice.tasks.add("secret");
      const t0 = performance.now();
      let cycles = 0;
      while (performance.now() - t0 < 30_000) {
        await alice.tasks.items();
        await bob.tasks.items().catch(() => {});
        const h = await bob.driver.syncStart(aliceId, part, false);
        await until("refused pull settles", () => bob.driver.syncStatus(h)).catch(() => {});
        await pull("alice", alice, bobId).catch(() => {});
        cycles++;
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log(`soak: ${cycles} cycles, no wedge; bob items:`,
        (await bob.tasks.items()).items.length);
    }

    console.log("\nWIRE PASS");
  } catch (e) {
    dumpOnFail([["alice", alice], ["bob", bob]]);
    throw e;
  }
}

// --- phase: bucket -----------------------------------------------------------

async function bucket() {
  const artifacts = await loadArtifacts();
  // The credential goes into the OWNER instance's seams and nowhere
  // else; the cold device is wired reader-only and its refusals are the
  // rig's proof that pulls really do ride the anonymous tier.
  const owner = await newEngine("owner", artifacts, probeNet(S3.endpoint, S3.secret));
  const cold = await newEngine("cold", artifacts, probeReaderNet(S3.endpoint));
  step("instantiated owner + cold");
  try {
    const ownerId = unhex(await owner.driver.init(false));
    const coldId = unhex(await cold.driver.init(false));
    step("init ×2");

    // Enrollment cards are host-carried (the cold device has no wire).
    await owner.driver.khIngestContact(await cold.driver.khContactCard());
    await cold.driver.khIngestContact(await owner.driver.khContactCard());
    step("contact cards pasted both ways");

    const part = await owner.driver.createPartition();
    await owner.driver.khAddMember(part, coldId, "edit");
    await owner.driver.sealPartition(part);
    step("partition sealed with cold member");

    await owner.driver.initStore({
      kind: "s3",
      value: { endpoint: S3.endpoint, bucket: S3.bucket, accessKey: S3.access },
    });
    await owner.driver.ensureBucket();
    await owner.driver.storeGrant(part, ownerId);
    await owner.driver.storeGrant(part, coldId);
    step("store configured + K_p granted");

    await owner.tasks.add("bucketed task");
    await owner.tasks.add("second task");
    console.log("  flush:", await owner.driver.bucketFlush(part));
    step("authored + flushed");

    await cold.driver.initStore({
      kind: "s3",
      value: { endpoint: S3.endpoint, bucket: S3.bucket, accessKey: "" },
    });
    await cold.driver.adoptPartition(part);
    console.log("  pull:", await cold.driver.bucketPull(part, ownerId, undefined));
    const snap = await cold.tasks.items();
    step(`cold pull: rev=${snap.revision} items=${snap.items.length}`);
    if (snap.items.length !== 2) throw new Error("cold boot incomplete");

    console.log("\nBUCKET PASS");
  } catch (e) {
    dumpOnFail([["owner", owner], ["cold", cold]]);
    throw e;
  }
}

// --- phase: resume -----------------------------------------------------------
//
// The #20 G5 kill-and-resume beat under Deno (runtime/PERSISTENCE.md
// "Checkpoint semantics"), through @polyengine/wasi's `filesystem-node`
// backend — the owner's "Deno has a filesystem binding" is
// `jsr:@polyengine/wasi@0.3.1/filesystem-node`, `node:fs` via
// `process.getBuiltinModule`, which Deno's node compat serves. Same guest
// `std::fs` code the browser drives over OPFS; real files here.
//
// THE KILL IS A REAL PROCESS DEATH. `resume` is an orchestrator: it
// re-execs THIS FILE as `resume-write` and then as `resume-read`, so
// nothing but the state root survives between the halves — no shared heap,
// no shared instance, no shared Deno runtime. That is a strictly harsher
// kill than the native acts' second-instance idiom, and it is the one that
// matches `worker.terminate()`.

/** The Deno state root, as a `wasi:filesystem` fragment.
 *
 * Built HERE rather than inside `newEngine` on purpose: naming
 * `@polyengine/wasi/filesystem-node` from `runtime/engine.ts` would put
 * `node:fs` into `serve/demo.js` and `serve/solo.js`, which
 * `demo/justfile`'s "NO node: BUILTIN MAY SURVIVE INTO EITHER BUNDLE"
 * check refuses (and did refuse, when this was first written the
 * ergonomic way). This file is Deno-only and never bundled, so it is the
 * right side of that line. `writable: true` is mandatory — the published
 * @polyengine/wasi defaults the fragment to READ-ONLY (the spike's trap).
 */
function denoStateRoot(dir: string) {
  return filesystemNode({ preopens: { "/": dir }, writable: true });
}

const RESUME_TODOS = ["buy milk", "survive the kill", "prove the checkpoint"];

async function resumeWrite(dir: string) {
  const artifacts = await loadArtifacts();
  const a = await newEngine("resume-write", artifacts, probeNoNet, denoStateRoot(dir));
  try {
    // `exportable-identity: true` is REQUIRED for a resumable device at
    // this rev: the default platform posture rests as a non-extractable
    // WebCrypto handle the guest cannot write down, and `stateResume`
    // refuses such a checkpoint rather than silently minting a NEW
    // identity (engine.wit's documented seam; PERSISTENCE.md T-A).
    const id = await a.driver.init(true);
    step(`init(exportable): ${id.slice(0, 16)}…`);

    await a.driver.userCreate({ displayName: "Bringup Bea", hue: 120 });
    await a.driver.usMarkPut({
      provenance: "app://bringup",
      petname: "Bringup",
      icon: "🌱",
      createdAt: 1_000n,
      needsReconfirm: false,
    });
    step("user-create + one mark");

    const part = await a.driver.createPartition();
    await a.driver.sealPartition(part);
    await a.driver.usPartitionPut("tasks", part);
    step(`partition ${hex(part).slice(0, 16)}… sealed + published`);

    for (const t of RESUME_TODOS) await a.tasks.add(t);
    const snap = await a.tasks.items();
    await a.tasks.setCompleted(snap.items[0].id, true);
    step(`tasks.add ×${RESUME_TODOS.length} + one toggle`);

    await a.driver.stateCheckpoint();
    step("state-checkpoint written");

    // Handed to the reader half through stdout: the identity this device
    // must still have on the other side of the kill.
    console.log(`RESUME-WRITE-OK ${id} ${hex(part)}`);
  } catch (e) {
    dumpOnFail([["resume-write", a]]);
    throw e;
  }
}

async function resumeRead(dir: string, wantPartition: string) {
  const artifacts = await loadArtifacts();
  const a = await newEngine("resume-read", artifacts, probeNoNet, denoStateRoot(dir));
  try {
    const resumed = await a.driver.stateResume();
    step(`state-resume: ${resumed}`);
    if (!resumed) throw new Error("state-resume answered false over a written state root");

    const bound = hex(await a.tasks.partition());
    if (bound !== wantPartition) {
      throw new Error(`bound ${bound.slice(0, 16)}…, expected ${wantPartition.slice(0, 16)}…`);
    }
    const pointers = await a.driver.usPartitions();
    if (!pointers.some((p) => p.name === "tasks" && hex(p.id) === wantPartition)) {
      throw new Error("the `tasks` partition pointer did not survive");
    }
    step("active partition + us-partition pointer intact");

    const snap = await a.tasks.items();
    if (snap.items.length !== RESUME_TODOS.length) {
      throw new Error(`${snap.items.length} todos, expected ${RESUME_TODOS.length}`);
    }
    for (const title of RESUME_TODOS) {
      if (!snap.items.some((i) => i.title === title)) throw new Error(`lost todo: ${title}`);
    }
    if (!snap.items.some((i) => i.completed)) throw new Error("lost the completion toggle");
    step(`todos intact: rev=${snap.revision} ${JSON.stringify(snap.items)}`);

    const marks = await a.driver.usMarksList();
    if (marks.length !== 1 || marks[0].provenance !== "app://bringup") {
      throw new Error(`marks did not survive: ${JSON.stringify(marks)}`);
    }
    const profile = await a.driver.usProfileGet();
    if (profile.displayName !== "Bringup Bea") {
      throw new Error(`profile did not survive: ${JSON.stringify(profile)}`);
    }
    step(`marks + profile intact: ${marks[0].petname} ${marks[0].icon}, ${profile.displayName}`);

    // RESUME IS NOT A JOIN: everything restored was announced before the
    // kill, so the first drain must be empty rather than replaying the
    // whole document as remote news.
    const events = await a.driver.usEvents();
    if (events.length !== 0) {
      throw new Error(`resume replayed stale events: ${JSON.stringify(events)}`);
    }
    step("us-events drain empty (resume is not a join)");

    // Authoring proves the chunk-envelope keys survived: the engine
    // refuses to seal on a parent whose key it does not hold, and after a
    // resume every parent is inherited history.
    await a.tasks.add("authored after the kill");
    const after = await a.tasks.items();
    if (after.items.length !== RESUME_TODOS.length + 1) {
      throw new Error("could not author on restored history");
    }
    step("authored a new change on restored history (chunk keys survived)");
  } catch (e) {
    dumpOnFail([["resume-read", a]]);
    throw e;
  }
}

/** Fresh boot, unchanged: no state root, so resume is a no-op `false`. */
async function resumeFreshBootControl() {
  const artifacts = await loadArtifacts();
  const a = await newEngine("resume-control", artifacts, probeNoNet);
  const resumed = await a.driver.stateResume();
  if (resumed) throw new Error("state-resume answered true with no state root mounted");
  let refused = "";
  await a.driver.stateCheckpoint().catch((e) => {
    refused = String(e);
  });
  if (!refused.includes("no state root")) {
    throw new Error(`state-checkpoint should refuse without a state root, got: ${refused || "success"}`);
  }
  await a.driver.init(false);
  step("no state root: resume=false, checkpoint refused, init still works");
}

async function resume() {
  await resumeFreshBootControl();

  const dir = await Deno.makeTempDir({ prefix: "pm-bringup-state-" });
  step(`state root: ${dir}`);

  const self = new URL(import.meta.url).pathname;
  const run = async (phase: string, args: string[]) => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", self, phase, dir, ...args],
      stdout: "piped",
      stderr: "inherit",
    });
    const out = await cmd.output();
    const text = new TextDecoder().decode(out.stdout);
    console.log(text.trimEnd());
    if (!out.success) throw new Error(`${phase} exited ${out.code}`);
    return text;
  };

  const written = await run("resume-write", []);
  const line = written.split("\n").find((l) => l.startsWith("RESUME-WRITE-OK"));
  if (!line) throw new Error("resume-write produced no identity line");
  const [, , partition] = line.trim().split(" ");
  step("*** kill: the writer PROCESS is gone; only the state root remains ***");

  await run("resume-read", [partition]);

  await Deno.remove(dir, { recursive: true });
  console.log("\nRESUME PASS");
}

// --- main ---------------------------------------------------------------------

const phase = Deno.args[0] ?? "solo";
const phases: Record<string, () => Promise<void>> = {
  solo,
  wire,
  bucket,
  resume,
  // The two halves `resume` re-execs; not meant to be run by hand, but
  // harmless and useful when debugging one side in isolation.
  "resume-write": () => resumeWrite(Deno.args[1]),
  "resume-read": () => resumeRead(Deno.args[1], Deno.args[2]),
};
const run = phases[phase];
if (!run) {
  console.error(`unknown phase ${phase}; expected: ${Object.keys(phases).join("|")}`);
  Deno.exit(2);
}
await run();
Deno.exit(0);
