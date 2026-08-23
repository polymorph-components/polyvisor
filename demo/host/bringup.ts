// Deno bring-up of the engine composite under polyengine — retire the
// platform risks (translation, CM-async task wakeups, wasi p2+p3 track
// serving, webcrypto port coverage, iroh-over-websocket, wasi:http
// against MinIO) before any browser work.
//
//   deno run -A host/bringup.ts solo          # one instance, no wire
//   deno run -A host/bringup.ts wire          # two instances over the relay
//   deno run -A host/bringup.ts bucket        # MinIO flush + cold pull
//   deno run -A host/bringup.ts gdrive        # fake Drive flush + cold pull
//
// Infra (relay, MinIO) is started by the justfile.

import { type Engine, hex, newEngine, unhex, until } from "../../runtime/engine.ts";
import { probeNet, probeNoNet, probeReaderNet } from "./probe-net.ts";
import { type FakeDrive, type FakeSpace, startFakeDrive } from "./fake-drive.ts";
import { ComponentException } from "@polyengine/runtime/embedder";
import type { EngineNet, StoreFetch } from "../../runtime/engine.ts";
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

// --- phase: gdrive -----------------------------------------------------------
//
// The user-only provider (runtime/DRIVE.md): the full owner beat
// (initStore → ensureBucket → grant → flush) plus a COLD SECOND ENGINE
// that reconstructs the document from the fake Drive alone. It mirrors
// the `bucket` phase beat for beat, with one deliberate difference that
// is the whole point of the provider: the cold engine is NOT wired
// reader-only, because there is no anonymous tier to read through. Its
// authority is the USER'S OWN OAuth — a second device of the same
// account, with its own consent (DRIVE.md §4: bearers are never shared
// between devices), and the only tier this store has.

const GDRIVE_ROOT = "pm-bringup";

/** Run the fake's consent ceremony with real PKCE and return the access
 * token. Synthetic material throughout: the fake mints
 * `synthetic-access-N`, and what it actually gates on is that the
 * verifier we present hashes to the challenge it recorded. */
async function driveConsent(fake: FakeDrive): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource),
    ),
  );
  const auth = new URL(`${fake.url}/auth`);
  auth.searchParams.set("redirect_uri", "http://127.0.0.1:1/relay");
  auth.searchParams.set("state", "bringup-state");
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  const res = await fetch(auth, { redirect: "manual" });
  if (res.status !== 302) throw new Error(`/auth answered ${res.status}, expected 302`);
  await res.body?.cancel();
  const back = new URL(res.headers.get("location") ?? "");
  if (back.searchParams.get("state") !== "bringup-state") {
    throw new Error("consent did not echo the state");
  }
  const code = back.searchParams.get("code");
  if (!code) throw new Error("consent returned no code");
  const tokenRes = await fetch(`${fake.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:1/relay",
    }),
  });
  const body = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`/token refused: ${JSON.stringify(body)}`);
  return body.access_token as string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The gdrive seam set, wired the way DRIVE.md §1 says this provider is
 * wired: owner over the API origin with the held bearer injected AT THE
 * SEAM (the guest never sees it), and the other three REFUSING — empty
 * origin sets and no signer, so "no sharing" is structural rather than a
 * flag the guest could be talked out of. */
function driveNet(apiBase: string, accessToken: string): EngineNet {
  const granted = new URL(apiBase).origin;
  const owner: StoreFetch = async (method, url, headers, body) => {
    const target = new URL(url).origin;
    if (target !== granted) {
      throw new ComponentException(`store-owner-fetch: origin not granted: ${target}`);
    }
    const empty = method === "GET" || method === "HEAD" || body.length === 0;
    try {
      const res = await fetch(url, {
        method,
        headers: [...headers, ["authorization", `Bearer ${accessToken}`]],
        body: empty ? undefined : body.slice() as unknown as BodyInit,
      });
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
    } catch (e) {
      throw new ComponentException(
        `store-owner-fetch: transport: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const refuseTier = (name: string): StoreFetch => () =>
    Promise.reject(
      new ComponentException(`${name}: this provider mints no capability (user-only store)`),
    );
  return {
    ownerFetch: owner,
    publicFetch: refuseTier("store-public-fetch"),
    sharedFetch: refuseTier("store-shared-fetch"),
    signer: () =>
      Promise.reject(new ComponentException("store-signer: no SigV4 on this provider")),
  };
}

/** The two storage spaces, and the fake's name for each.
 *
 * `"appdata"` FIRST because it is the default: where a space has to be
 * chosen and nothing says otherwise — this harness's own config
 * included — the hidden per-app folder is the answer. It makes "no
 * sharing" platform-enforced (Drive cannot share appdata files at all)
 * and puts a store addressed by keyed name out of reach of a Drive-UI
 * rename, which would otherwise strand a file permanently. `"drive"`
 * is proved beside it because it is a supported choice, not a legacy
 * one: appdata cannot be inspected by its owner and an app rotation
 * orphans it invisibly. */
const GDRIVE_SPACES: [space: "appdata" | "drive", fake: FakeSpace][] = [
  ["appdata", "appDataFolder"],
  ["drive", "drive"],
];

/** The whole owner beat + cold pull, in ONE space, against a fake that
 * both spaces share. Parameterized rather than duplicated, because the
 * property under test is that the beat is IDENTICAL in both: the space
 * changes where the root folder sits and nothing below it. */
async function gdriveBeat(
  artifacts: { envelope: string; bytes: Uint8Array },
  fake: FakeDrive,
  space: "appdata" | "drive",
) {
  // The fake's spelling of the same choice: `appdata` is the config
  // value the guest validates, `appDataFolder` is Drive's own alias.
  const fakeSpace: FakeSpace = space === "appdata" ? "appDataFolder" : "drive";

  // Two consents, two tokens — one per device, never shared.
  const ownerToken = await driveConsent(fake);
  const coldToken = await driveConsent(fake);
  if (ownerToken === coldToken) throw new Error("the two devices got the same token");
  step(`consent ×2 (PKCE verified by the fake): ${ownerToken}, ${coldToken}`);

  const owner = await newEngine("owner", artifacts, driveNet(fake.url, ownerToken));
  const cold = await newEngine("cold", artifacts, driveNet(fake.url, coldToken));
  step("instantiated owner + cold");
  try {
    const ownerId = unhex(await owner.driver.init(false));
    const coldId = unhex(await cold.driver.init(false));
    step("init ×2");

    // Enrollment cards are host-carried (neither device has a wire).
    await owner.driver.khIngestContact(await cold.driver.khContactCard());
    await cold.driver.khIngestContact(await owner.driver.khContactCard());
    step("contact cards pasted both ways");

    const part = await owner.driver.createPartition();
    await owner.driver.khAddMember(part, coldId, "edit");
    await owner.driver.sealPartition(part);
    step("partition sealed with the cold device as a member");

    // An unknown space is refused BY NAME at init-store, never
    // defaulted: a typo that silently fell back would put the store in
    // the other space, where the walk finds nothing and the next flush
    // rebuilds the tree — indistinguishable from data loss. `"appData"`
    // is the plausible wrong spelling, which is why it is the one used.
    let spaceRefusal = "";
    await owner.driver.initStore({
      kind: "gdrive",
      value: { root: GDRIVE_ROOT, apiBase: fake.url, space: "appData" as "appdata" },
    }).catch((e) => {
      spaceRefusal = String(e);
    });
    if (!spaceRefusal.includes('unknown value "appData"')) {
      throw new Error(`an unknown space should be refused by name, got: ${spaceRefusal || "OK"}`);
    }
    step(`unknown space refused: ${spaceRefusal.replace(/^\w*Error:\s*/, "")}`);

    const store = {
      kind: "gdrive" as const,
      value: { root: GDRIVE_ROOT, apiBase: fake.url, space },
    };
    await owner.driver.initStore(store);
    await owner.driver.ensureBucket();
    // THE RULING (DRIVE.md §1): grant returns NONE. There is no link to
    // carry because there is nothing a link could grant.
    const granted = await owner.driver.storeGrant(part, ownerId);
    const grantedCold = await owner.driver.storeGrant(part, coldId);
    if (granted !== undefined || grantedCold !== undefined) {
      throw new Error(
        `store-grant minted a capability on the user-only store: ${granted} / ${grantedCold}`,
      );
    }
    step("store configured + pickups written (grant returned none, as it must)");

    await owner.tasks.add("drive task");
    await owner.tasks.add("second drive task");
    console.log("  flush:", await owner.driver.bucketFlush(part));
    step("authored + flushed");

    // WHAT AN OBSERVER OF THE STORE IS PREVENTED FROM LEARNING.
    // Names are keyed now (DRIVE.md §2), so the assertion can no longer
    // be "a child called manifest-<hex>" — it is STRUCTURE plus the
    // negative property that is the point of the derivation: the doc
    // id's hex appears NOWHERE in the tree, so listing this account
    // tells you how much is stored and not which document it belongs
    // to.
    const docsChildren = fake.childNames(`${GDRIVE_ROOT}/docs`, fakeSpace);
    if (docsChildren.length !== 1) {
      throw new Error(`expected one doc folder under docs, got ${JSON.stringify(docsChildren)}`);
    }
    const docFolder = `${GDRIVE_ROOT}/docs/${docsChildren[0]}`;
    const children = fake.childNames(docFolder, fakeSpace);
    // chunk ×2 + oplog + manifest for the one flushing device.
    if (children.length < 3) {
      throw new Error(`too few objects landed in the fake: ${JSON.stringify(children)}`);
    }
    const pickups = fake.childNames(`${GDRIVE_ROOT}/pickup`, fakeSpace);
    if (pickups.length !== 2) {
      throw new Error(`expected two pickup objects (owner + cold), got ${JSON.stringify(pickups)}`);
    }
    const partHex = hex(part);
    const everyName = fake.files().map((f) => f.name);
    const leaked = everyName.filter((n) => n.includes(partHex));
    if (leaked.length > 0) {
      throw new Error(`a stored name carries the doc id: ${JSON.stringify(leaked)}`);
    }
    step(
      `objects in the fake: ${children.length} under ${docFolder}, ${pickups.length} pickups; ` +
        `no name among ${everyName.length} carries the doc id`,
    );

    await cold.driver.initStore(store);
    await cold.driver.adoptPartition(part);
    // A pickup argument is refused BY NAME, not ignored (DRIVE.md §1).
    let refusal = "";
    await cold.driver.bucketPull(part, ownerId, "https://example.invalid/whatever")
      .catch((e) => {
        refusal = String(e);
      });
    if (!refusal.includes("mints no pickup capability")) {
      throw new Error(`link-tier pull should be refused by name, got: ${refusal || "success"}`);
    }
    step("link-tier pull refused by name (this store has no link tier)");

    console.log("  pull:", await cold.driver.bucketPull(part, ownerId, undefined));
    const snap = await cold.tasks.items();
    step(`cold pull: rev=${snap.revision} items=${snap.items.length}`);
    if (snap.items.length !== 2) throw new Error("cold boot incomplete");

    // Every request the engines made carried a bearer, and every one of
    // them went to the fake's files API: no tier but the owner's exists.
    const files = fake.requests().filter((r) => r.path.includes("/drive/v3/"));
    if (files.some((r) => !r.hasAuth)) {
      throw new Error("a files-API request left without a bearer");
    }
    step(`${files.length} files-API requests, all bearing the owner seam's token`);

    // Revoke, and the honest note (DRIVE.md §1): the pickup object goes
    // away, and there is nothing else to take back because nothing was
    // ever minted. The lever that actually cuts off a credential holder
    // is at Google, not here, and the note says so.
    const note = await owner.driver.storeRevoke(part, coldId);
    if (!note.includes("never minted a capability")) {
      throw new Error(`revoke note does not tell the truth about this store: ${note}`);
    }
    // The pickup object is name-keyed-INDEPENDENT (it is where the
    // keychain is learned), so it is still identifiable here — by count
    // rather than by a name the harness can spell.
    if (fake.childNames(`${GDRIVE_ROOT}/pickup`, fakeSpace).length !== 1) {
      throw new Error("revoke did not leave exactly the owner's own pickup behind");
    }
    step(`revoke: ${note.replaceAll(/\s+/g, " ")}`);
  } catch (e) {
    dumpOnFail([["owner", owner], ["cold", cold]]);
    throw e;
  }
}

async function gdrive() {
  const artifacts = await loadArtifacts();
  const fake = await startFakeDrive();
  step(`fake drive up on ${fake.url}`);
  try {
    // ONE fake for both beats, deliberately: two fakes could not tell
    // an isolated store from a fresh one. Sharing the server means the
    // second beat writes the SAME root folder name into the other
    // space, so the assertions below are about isolation and not about
    // two servers happening to differ.
    const landed: Record<string, Set<string>> = {};
    for (const [space, fakeSpace] of GDRIVE_SPACES) {
      const before = new Set(fake.files().map((f) => f.id));
      console.log(`\n--- gdrive space=${space} (fake: ${fakeSpace}) ---`);
      await gdriveBeat(artifacts, fake, space);
      const after = fake.files().filter((f) => !before.has(f.id));
      // POSITIVE assertion, not an absence: every file this beat
      // created is IN the space it asked for. An engine that ignored
      // the setting entirely would still pass a "the other space is
      // empty" check on the first beat; it cannot pass this one.
      const stray = after.filter((f) => f.space !== fakeSpace);
      if (stray.length > 0) {
        throw new Error(
          `space=${space}: ${stray.length} file(s) landed in the wrong space: ` +
            JSON.stringify(stray.map((f) => [f.name, f.space])),
        );
      }
      landed[fakeSpace] = new Set(after.map((f) => f.id));
      // The layout is the SAME in both spaces — that is what makes the
      // space a storage location rather than a second strategy.
      const top = fake.childNames(GDRIVE_ROOT, fakeSpace).sort();
      if (JSON.stringify(top) !== JSON.stringify(["docs", "pickup"])) {
        throw new Error(`space=${space}: unexpected root layout ${JSON.stringify(top)}`);
      }
      step(`space=${space}: ${after.length} files, all in ${fakeSpace}, layout ${top.join("+")}`);
    }

    // THE ISOLATION ASSERTIONS, now that both stores exist side by side
    // under the same root NAME. Each space resolves that name to its
    // OWN folder, and neither space's objects appear in the other's
    // listing.
    const appRoot = fake.byPath(GDRIVE_ROOT, "appDataFolder");
    const visRoot = fake.byPath(GDRIVE_ROOT, "drive");
    if (!appRoot || !visRoot) {
      throw new Error(
        `both spaces should hold a ${GDRIVE_ROOT} folder: ` +
          `appdata=${appRoot?.id}, drive=${visRoot?.id}`,
      );
    }
    if (appRoot.id === visRoot.id) {
      throw new Error("the two spaces resolved the SAME root folder — no isolation at all");
    }
    const appIds = landed["appDataFolder"];
    const visNames = new Set(
      fake.files().filter((f) => f.space === "drive").map((f) => f.id),
    );
    const bleed = [...appIds].filter((id) => visNames.has(id));
    if (bleed.length > 0) {
      throw new Error(`appdata objects are visible to the drive space: ${JSON.stringify(bleed)}`);
    }
    // And by NAME, which is how a device would actually look: the
    // appdata doc folder is not among the visible space's doc folders.
    const appDocs = fake.childNames(`${GDRIVE_ROOT}/docs`, "appDataFolder");
    const visDocs = fake.childNames(`${GDRIVE_ROOT}/docs`, "drive");
    const shared = appDocs.filter((n) => visDocs.includes(n));
    if (appDocs.length !== 1 || visDocs.length !== 1 || shared.length > 0) {
      throw new Error(
        `doc folders are not separate per space: appdata=${JSON.stringify(appDocs)} ` +
          `drive=${JSON.stringify(visDocs)}`,
      );
    }
    step(
      `isolation: roots ${appRoot.id}(appdata) vs ${visRoot.id}(drive), ` +
        `${appIds.size} appdata objects invisible to a default-space listing`,
    );

    console.log("\nGDRIVE BRINGUP PASS");
  } finally {
    await fake.close();
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
  gdrive,
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
