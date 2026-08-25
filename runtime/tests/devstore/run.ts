// THE DEVICE-STORE MATRIX RUNNER: Playwright driving a real headless
// Chromium over the built probe page, one row per question.
//
//   just test              (builds first)
//   deno run -A run.ts     (needs `just build` to have run)
//
// Same shape as spikes/worker-host/run.ts and demo/e2e/run.ts —
// Playwright as a LIBRARY from Deno, an ephemeral-port static server the
// harness owns, a verdict per row, non-zero exit if any required row
// failed.
//
// PORT DISCIPLINE: the server binds port 0 and the port is read back, so
// parallel worktrees cannot silently probe each other's build.
//
// THE RELOADS ARE REAL. Four rows (identity, until-reseal, sealed-fs,
// and the anchor's degrade) mean nothing without a genuine navigation:
// what they claim is that a HANDLE or a SEALED FILE survives the
// document being torn down, which an in-page "pretend to reload" cannot
// test. `page.reload({waitUntil:"load"})` in the same context keeps the
// storage partition and destroys everything else, which is exactly the
// experiment.

import { chromium } from "npm:playwright@1.57.0";
import type { Browser, BrowserContext, CDPSession, Page } from "npm:playwright@1.57.0";
import { serveDir } from "jsr:@std/http@1.0.13/file-server";
// The fake Google Drive: one module shared with the bringup phase and
// the e2e suite (DRIVE.md's Gates section). This harness holds the
// handle directly and asserts against it run.ts-side — no HTTP
// inspection endpoint needed, unlike the S3 recorder, because the fake
// already exposes `requests()`/`files()`/`childNames()`/`expireNow()`
// in-process.
import { startFakeDrive } from "../../../demo/host/fake-drive.ts";

const here = new URL(".", import.meta.url).pathname;
const SERVE = `${here}serve`;

type Verdict = "PASS" | "FAIL" | "INFO";
interface Row {
  n: string;
  title: string;
  verdict: Verdict;
  evidence: string;
}
const rows: Row[] = [];
let failures = 0;

function record(n: string, title: string, ok: boolean | "info", evidence: string) {
  const verdict: Verdict = ok === "info" ? "INFO" : ok ? "PASS" : "FAIL";
  if (verdict === "FAIL") failures++;
  rows.push({ n, title, verdict, evidence });
  console.log(`\n[${verdict}] ${n} ${title}\n        ${evidence.replace(/\n/g, "\n        ")}`);
}

const j = (v: unknown) => JSON.stringify(v);

// The host rows' synthetic test values, spelled the same way page.ts
// spells them (page.ts's PASS/PASS_WRONG). Obviously not key material.
const PASS = "correct-horse-battery-staple-TEST";
const PASS_WRONG = "definitely-not-the-passphrase-TEST";
const TODOS = ["buy milk", "write the worker host"];
/** Row 17 writes exactly this and never asks for a checkpoint. */
const DEBOUNCED = "never explicitly checkpointed";

function serveSite(): { server: Deno.HttpServer; port: number } {
  let port = 0;
  const server = Deno.serve({
    port: 0,
    // Bind all interfaces (the spike's finding, spikes/prf-unseal/run.ts:
    // some resolvers prefer ::1) so ONE server answers both the
    // existing 127.0.0.1 origin (rows 1-23, unchanged) and the PRF
    // rows' http://localhost:<port> origin — WebAuthn requires a domain
    // RP id, and 127.0.0.1 is a synchronous SecurityError.
    hostname: "0.0.0.0",
    onListen: (addr) => {
      port = addr.port;
    },
  }, (req) => serveDir(req, { fsRoot: SERVE, quiet: true, headers: ["cache-control: no-store"] }));
  return { server, port };
}

// --- the S3-shaped RECORDER (rows 28+) ---------------------------------
//
// AN OBSERVER, NOT A FAKE. This does not implement S3 — it never checks
// a signature, never stores a byte — it only notes that a request
// LEFT THE WORKER through the owner seam and what it looked like
// (method, path, whether an Authorization header rode along and its
// public prefix, whether an x-amz-date rode along). The rows that use
// it assert egress and SigV4 signing over the escrowed synthetic
// credential; MinIO-backed end-to-end verification (the object actually
// landing, a real reload, reseal reported through the real sheet) lives
// in the demo e2e suite's `solo-storage` scenario per
// STORAGE-EGRESS.md's gates, not here.
interface S3LogEntry {
  method: string;
  path: string;
  hasAuthorization: boolean;
  /** First ~40 chars only — the scheme, algorithm and the PUBLIC access
   * key identifier plus scope, which already travels to the destination
   * in clear (rpc.ts's `StoreBinding` doc comment). Never the signature,
   * never anything secret. */
  authorizationPrefix: string;
  hasAmzDate: boolean;
}

function serveRecorder(): { server: Deno.HttpServer; port: number } {
  const log: S3LogEntry[] = [];
  let port = 0;
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-allow-headers": "*",
  };
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: (addr) => {
      port = addr.port;
    },
  }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/__s3log" && req.method === "GET") {
      return new Response(JSON.stringify(log), {
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
      });
    }
    if (url.pathname === "/__s3log/clear" && req.method === "POST") {
      log.length = 0;
      return new Response(null, { status: 200, headers: cors });
    }
    // Every OTHER request is the thing under observation: drain the
    // body (a PUT's object bytes) before answering, then log the
    // request's own public metadata.
    if (req.body) {
      try {
        await req.arrayBuffer();
      } catch { /* a cut-short body is not this harness's concern */ }
    }
    const auth = req.headers.get("authorization") ?? "";
    log.push({
      method: req.method,
      path: url.pathname,
      hasAuthorization: auth !== "",
      authorizationPrefix: auth.slice(0, 64),
      hasAmzDate: req.headers.has("x-amz-date"),
    });
    // ANY PUT → 200 empty body; ANY GET → 404. That is the whole of
    // what an ensureBucket/bucketFlush call needs to see to either
    // succeed or fail cleanly — the rows tolerate either outcome (the
    // CLAIM is the signed egress, not a working bucket).
    if (req.method === "PUT") return new Response(null, { status: 200, headers: cors });
    return new Response(null, { status: 404, headers: cors });
  });
  return { server, port };
}

const s3LogGet = (port: number): Promise<S3LogEntry[]> =>
  fetch(`http://127.0.0.1:${port}/__s3log`).then((r) => r.json());
const s3LogClear = (port: number): Promise<void> =>
  fetch(`http://127.0.0.1:${port}/__s3log/clear`, { method: "POST" }).then(() => {});

// --- the S3-shaped OBJECT STORE (rows 54+) -----------------------------
//
// A STORE, NOT A RECORDER, AND THAT IS THE DIFFERENCE THAT MATTERS. The
// recorder above answers every GET with 404 by design — it exists to
// observe that a signed request left the worker, and the rows that use
// it assert egress rather than durability. The RECOVERY rows cannot
// live on that: a restore READS the account out of the bucket (that is
// the whole claim), so the kit's bundle, the K_p and every flushed
// object have to still be there when a second device asks for them.
//
// So this is a separate server on its own ephemeral port rather than an
// upgrade of the recorder: every existing row keeps the backend it was
// written against, and nothing about "GET is always a 404" changes
// underneath rows 28-47.
//
// It implements exactly what providers/s3/store's four verbs need
// (`/{bucket}` for the bucket, `/{bucket}/{key}` for an object; keys
// contain slashes — `recovery/<hex>` — so the key is everything after
// the first segment) and NOT S3: no signature is checked, no ACL, no
// versioning, no listing. The signing claim is rows 30/33's and is
// measured against the recorder.
//
// DELETE ANSWERS 204 WHETHER OR NOT THE OBJECT WAS THERE, which is real
// S3 behaviour and is exactly the property `recovery-consume`'s
// idempotency contract rests on ("absence is success ... a retry after
// partial success must not error on an object that is already gone").
// `refuseNextDeletes` is the injected outage for the consume-failure
// row: it refuses the DELETE and NOTHING else, so a restore still
// succeeds end to end and only its tail fails — which is the exact
// shape RECOVERY.md says must never block a restore.
interface ObjectStoreHandle {
  server: Deno.HttpServer;
  port: number;
  /** Every object key currently stored, sorted. Names only — no bytes
   * ever leave this harness, and the names are keyed hashes anyway. */
  names(): string[];
  /** Refuse the next `n` DELETEs with a 503. `Infinity` for an outage
   * with no end until it is healed with 0. */
  refuseNextDeletes(n: number): void;
  deleteRefusalsPending(): number;
}

function serveObjects(): ObjectStoreHandle {
  const objects = new Map<string, Uint8Array>();
  const buckets = new Set<string>();
  let refuseDeletes = 0;
  let port = 0;
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "*",
  };
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: (addr) => {
      port = addr.port;
    },
  }, async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const segments = url.pathname.replace(/^\//, "").split("/");
    const bucket = segments[0] ?? "";
    const key = segments.slice(1).join("/");
    if (key === "") {
      // The bucket itself: `ensureBucket`'s PUT, and nothing else.
      if (req.method === "PUT") {
        buckets.add(bucket);
        return new Response(null, { status: 200, headers: cors });
      }
      return new Response(null, { status: buckets.has(bucket) ? 200 : 404, headers: cors });
    }
    if (req.method === "PUT") {
      objects.set(key, new Uint8Array(await req.arrayBuffer()));
      return new Response(null, { status: 200, headers: cors });
    }
    if (req.method === "GET") {
      const body = objects.get(key);
      if (!body) return new Response(null, { status: 404, headers: cors });
      return new Response(body as BodyInit, {
        status: 200,
        headers: { ...cors, "content-type": "application/octet-stream" },
      });
    }
    if (req.method === "DELETE") {
      if (refuseDeletes > 0) {
        refuseDeletes--;
        return new Response("injected outage: this store is refusing deletes", {
          status: 503,
          headers: cors,
        });
      }
      // 204 whether or not it was there — see the header.
      objects.delete(key);
      return new Response(null, { status: 204, headers: cors });
    }
    return new Response(null, { status: 405, headers: cors });
  });
  return {
    server,
    port,
    names: () => [...objects.keys()].sort(),
    refuseNextDeletes: (n: number) => {
      refuseDeletes = n;
    },
    deleteRefusalsPending: () => (refuseDeletes === Infinity ? Infinity : refuseDeletes),
  };
}

// Synthetic labeled S3 credentials — never realistic-looking material,
// spelled the same way across every row that uses them.
const S3_ACCESS_KEY = "SYNTHETIC-TEST-KEY";
const S3_SECRET = "synthetic-test-secret-0000";

// Synthetic labeled Google Drive installed-app identifiers. Not user
// secrets (DRIVE.md §3: an installed app's "client secret" is not
// treated as one) — but still never realistic-looking, per the
// dispatch's own rule.
const GD_CLIENT_ID = "SYNTHETIC-CLIENT";
const GD_CLIENT_SECRET = "synthetic-client-secret-0000";

/**
 * Run one consent ceremony against the fake, entirely from the harness
 * side — this IS the popup's job, done without a popup: `oauthStart`
 * hands back a URL that is public data (app identity, addressing, and a
 * PKCE CHALLENGE a fetch cannot reverse), the fake's `/auth` 302s
 * straight back to `redirectUri` with `?code&state` (headless consent,
 * fake-drive.ts's own doc comment), and `oauthComplete` relays both. The
 * e2e suite drives the real popup; this harness only needs what a popup
 * would produce.
 */
async function startAndFetchAuth(
  page: Page,
  id: string,
  spec: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    authUrl: string;
    tokenUrl: string;
    /** WHICH SPACE THE CONSENT IS FOR — it picks the scope the worker
     * puts in the authorize URL, so every ceremony in this file has to
     * name one (DRIVE.md §5). */
    space: "appdata" | "drive";
  },
  // deno-lint-ignore no-explicit-any
): Promise<{ start: any; code: string; state: string }> {
  const start = await probe(page, "gd-oauth-start", {
    id,
    spec: { provider: "gdrive", ...spec },
  });
  if (!start.ok) return { start, code: "", state: "" };
  const res = await fetch(start.value.authorizeUrl, { redirect: "manual" });
  const loc = res.headers.get("location") ?? "";
  const locUrl = new URL(loc, spec.authUrl);
  return { start, code: locUrl.searchParams.get("code") ?? "", state: locUrl.searchParams.get("state") ?? "" };
}

async function openPage(ctx: BrowserContext, port: number): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`      · pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    // The identity library WARNS when it discards a planted entry; that
    // is a probe expectation, not noise, so it is surfaced.
    if (/error|Uncaught|discarding/i.test(t)) console.log(`      · console: ${t}`);
  });
  await page.goto(`http://127.0.0.1:${port}/probe.html`, { waitUntil: "load" });
  await ready(page);
  return page;
}

const ready = (page: Page) =>
  page.waitForFunction(() => (globalThis as unknown as { ready?: boolean }).ready === true, undefined, {
    timeout: 30_000,
  });

/**
 * The PRF rows' own page, on `http://localhost:<port>` — a WebAuthn RP
 * id must be a domain (spikes/prf-unseal/run.ts, re-confirmed there by
 * construction), so 127.0.0.1 cannot host these ceremonies. A separate
 * origin means a separate storage partition, which is fine: the PRF
 * rows are self-contained and create their own devices here.
 *
 * The CDP virtual authenticator is installed BEFORE any ceremony (the
 * spike's discipline) with `hasPrf: true` — the option that makes it
 * implement hmac-secret. `hasPrf` is not in Playwright's CDP types, so
 * the cast mirrors the spike's exactly.
 */
async function openPrfPage(ctx: BrowserContext, port: number): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`      · pageerror (prf): ${e.message}`));
  const cdp: CDPSession = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  await page.goto(`http://localhost:${port}/probe.html`, { waitUntil: "load" });
  await ready(page);
  return page;
}

// deno-lint-ignore no-explicit-any
const probe = (page: Page, op: string, arg?: unknown): Promise<any> =>
  page.evaluate(
    ([op, arg]) => (globalThis as unknown as { probe(o: unknown, a: unknown): Promise<unknown> }).probe(op, arg),
    [op, arg] as const,
    // deno-lint-ignore no-explicit-any
  ) as any;

/** Run one matrix section; a thrown error becomes a FAILED ROW rather
 * than the end of the run. A gate that stops at the first failure hides
 * every fact after it, and the point of a matrix is the whole matrix. */
async function guard(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    record("--", "section threw", false, String((e as Error)?.stack ?? e).slice(0, 1500));
  }
}

/** Poll one device's `status().sync` until the predicate holds, or give
 * up at the deadline and hand back the LAST thing seen so the row's
 * evidence can say what the schedule was actually doing.
 *
 * Polling `hc-status` is safe to do in a tight-ish loop here for a
 * reason worth writing down: `status` is a HOST method, answered by
 * worker.ts's `callHost`, so it never runs through `call()` and
 * therefore never arms the checkpoint or the flush debounce. A poll that
 * re-armed the very timer it is waiting for would never fire.
 */
async function untilSync(
  page: Page,
  id: string,
  what: string,
  // deno-lint-ignore no-explicit-any
  pred: (s: any) => boolean,
  timeout: number,
  // deno-lint-ignore no-explicit-any
): Promise<{ sync: any; ok: boolean; waitedMs: number; what: string }> {
  const started = Date.now();
  const deadline = started + timeout;
  // deno-lint-ignore no-explicit-any
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await probe(page, "hc-status", { id })).sync ?? null;
    if (last !== null && pred(last)) {
      return { sync: last, ok: true, waitedMs: Date.now() - started, what };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { sync: last, ok: false, waitedMs: Date.now() - started, what };
}

async function main() {
  try {
    await Deno.stat(`${SERVE}/page.js`);
  } catch {
    console.error(`no built probe at ${SERVE} — run \`just build\` first`);
    Deno.exit(2);
  }

  const { server, port } = serveSite();
  await new Promise((r) => setTimeout(r, 50));
  console.log(`probe: http://127.0.0.1:${port}/probe.html`);

  const { server: s3Server, port: s3Port } = serveRecorder();
  await new Promise((r) => setTimeout(r, 50));
  const s3Origin = `http://127.0.0.1:${s3Port}`;
  console.log(`s3 recorder: ${s3Origin}`);

  // The recovery rows' backend: a real (tiny) object store, because a
  // restore reads the account back out of the bucket. See `serveObjects`.
  const objects = serveObjects();
  await new Promise((r) => setTimeout(r, 50));
  const objOrigin = `http://127.0.0.1:${objects.port}`;
  console.log(`s3 object store: ${objOrigin}`);

  const fake = await startFakeDrive();
  // The fake now serves its own CORS (access-control-allow-origin: *,
  // OPTIONS preflights answered 204 with authorization/content-type
  // allowed — demo/host/fake-drive.ts), so the SharedWorker's
  // `fetch(tokenUrl)`/files-API calls work directly against its origin;
  // no fronting proxy needed.
  const gdOrigin = fake.url;
  console.log(`fake drive: ${gdOrigin}`);

  const browser: Browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log(`chromium ${browser.version()}`);

  try {
    const ctx = await browser.newContext();
    const page = await openPage(ctx, port);
    // The PRF rows' own page/origin — opened once, up front, so the
    // virtual authenticator is installed well before rows 24-27 run.
    const prfPage = await openPrfPage(ctx, port);

    // --- 1: the index -----------------------------------------------------
    await guard(async () => {
      const r = await probe(page, "index");
      // The negative half of the index contract, checked as a fact about
      // the stored record: exactly these seven fields, and nothing that
      // could name the user, their colour, their icon or their account.
      const expected = [
        "createdAt",
        "id",
        "lastUsed",
        "petname",
        "posture",
        "tier",
        "unsealPolicy",
      ];
      const fieldsExact = j(r.fields) === j(expected);
      const ok = fieldsExact && r.idLooksOpaque && r.created.tier === "t0" &&
        r.touchedLater && r.removed && r.cleanup === "ok";
      record(
        "1  index",
        "CRUD, and the record carries nothing personal",
        ok,
        `fields=${j(r.fields)} (exactly the contract: ${fieldsExact}); a new device is ` +
          `tier=${r.created.tier} posture=${r.created.posture} policy=${r.created.unsealPolicy}; ` +
          `id opaque 128-bit hex: ${r.idLooksOpaque}; touch advances lastUsed: ${r.touchedLater}; ` +
          `remove clears the row: ${r.removed}`,
      );
      const raceOk = r.race.createdCount === 1 && r.race.rows === 1 && r.race.sameRow;
      record(
        "1b index",
        "two concurrent ensureDevice on one id → exactly one creator",
        raceOk,
        `creators=${r.race.createdCount} rows=${r.race.rows} both callers saw the same row: ` +
          `${r.race.sameRow} (the settle is one readwrite transaction, index.ts's ensureDevice)`,
      );
    });

    // --- 2: promotion -----------------------------------------------------
    await guard(async () => {
      const r = await probe(page, "promote");
      const ok = r.before === "t0" && r.after === "t1" && r.posture === "platform" &&
        r.unsealPolicy === "until-reseal" && r.cleanup === "ok";
      record(
        "2  promote",
        "T0 → T1 carries the seal choices; persist() is reported, not assumed",
        ok,
        `${r.before} → ${r.after}, posture=${r.posture}, policy=${r.unsealPolicy}; ` +
          `navigator.storage.persist() said ${r.persisted} (a refusal is a warning, ` +
          `never a failed promotion — PERSISTENCE.md, "Eviction and degradation")`,
      );
    });

    // --- 3: the passphrase rung -------------------------------------------
    await guard(async () => {
      const r = await probe(page, "passphrase");
      const ok = r.state.passphrase && r.dekExtractable === false &&
        r.readBack === "sealed-kv-payload-TEST" &&
        r.wrong.refused && r.wrong.error.code === "wrong-passphrase" &&
        r.saltRotated && r.oldRefused.refused &&
        r.stillReadable === "sealed-kv-payload-TEST" &&
        r.secondMint.refused && r.secondMint.error.code === "already-sealed" &&
        r.cleanup === "ok";
      record(
        "3  seal",
        "every-session rung: unseal, refuse the wrong passphrase, rotate the salt on re-key",
        ok,
        `the handed-out DEK is extractable=${r.dekExtractable}; unseal round-trips a sealed ` +
          `value (${j(r.readBack)}); wrong passphrase → ${r.wrong.error.name} ` +
          `code=${j(r.wrong.error.code)} and nothing was written; re-key rotates the 16-byte ` +
          `salt: ${r.saltRotated}, old passphrase then refused: ${r.oldRefused.refused}, and the ` +
          `SAME data still opens (${j(r.stillReadable)}) — the DEK did not rotate, by design; ` +
          `a second mint is refused (${j(r.secondMint.error.code)})`,
      );
    });

    // --- 4: the sealed KV -------------------------------------------------
    await guard(async () => {
      const r = await probe(page, "kv");
      const ok = r.round === "the-sealed-value-TEST" && r.absentIsUndefined &&
        r.tampered.refused && r.tampered.error.code === "tampered" && r.cleanup === "ok";
      record(
        "4  sealed-kv",
        "round trip, and one flipped ciphertext byte is a clean typed refusal",
        ok,
        `round trip ${j(r.round)}; a key never written is undefined: ${r.absentIsUndefined}; ` +
          `after flipping ct[0]: ${r.tampered.error.name} code=${j(r.tampered.error.code)} ` +
          `(GCM's tag — "absent" and "altered" are deliberately different answers)`,
      );
    });

    // --- 5: identity keys, across a REAL reload ---------------------------
    await guard(async () => {
      const mint = await probe(page, "identity-mint");
      const mintOk = mint.minted && mint.secondCallMinted === false &&
        mint.extractable === false && mint.raceSame && mint.raceMintedCount === 1 &&
        mint.extractableRefused.refused &&
        mint.extractableRefused.error.code === "extractable" && mint.signed;
      record(
        "5  identity",
        "non-extractable mint, race-free first mint, extractable key refused",
        mintOk,
        `minted=${mint.minted} (second call minted=${mint.secondCallMinted}); private half ` +
          `extractable=${mint.extractable}; it signs and verifies: ${mint.signed}; two ` +
          `concurrent loadOrMint → one minter (${mint.raceMintedCount}) and one key ` +
          `(cross-verified: ${mint.raceSame}); persisting an EXTRACTABLE key is refused: ` +
          `${mint.extractableRefused.error.name} code=${j(mint.extractableRefused.error.code)}`,
      );

      await page.reload({ waitUntil: "load" });
      await ready(page);
      const after = await probe(page, "identity-after", { id: mint.id });
      const sameKey = after.publicKey === mint.publicKey && after.publicKey !== "";
      const ok = after.loadedAfterReload && sameKey && after.signed &&
        after.junkRejected && after.junkDiscarded &&
        after.plantedRejected && after.plantedDiscarded &&
        after.remintedNonExtractable && after.cleanup === "ok";
      record(
        "5b identity",
        "the handle survives a REAL reload and still signs; planted entries are discarded",
        ok,
        `after navigation the stored pair loads (${after.loadedAfterReload}), is the SAME ` +
          `identity (public halves equal: ${sameKey}) and signs: ${after.signed}; a non-key ` +
          `entry is rejected AND deleted (${after.junkRejected}/${after.junkDiscarded}); a ` +
          `planted EXTRACTABLE pair likewise (${after.plantedRejected}/${after.plantedDiscarded}); ` +
          `load-or-mint then produces a real non-extractable key rather than looping: ` +
          `${after.remintedNonExtractable}`,
      );
    });

    // --- 6: the until-reseal rung, across a REAL reload -------------------
    await guard(async () => {
      const arm = await probe(page, "platform-arm");
      await page.reload({ waitUntil: "load" });
      await ready(page);
      const r = await probe(page, "platform-after", { id: arm.id });
      const ok = arm.state.untilReseal && r.autoUnsealed && r.autoExtractable === false &&
        r.read === "survives-the-reload-TEST" && r.afterResealIsNull &&
        r.state.untilReseal === false && r.state.passphrase && r.handleGone &&
        r.stillOpens === "survives-the-reload-TEST" && r.cleanup === "ok";
      record(
        "6  until-reseal",
        "auto-unseal after a REAL reload with NO passphrase; reseal puts the passphrase back",
        ok,
        `armed: ${j(arm.state)}; after navigation the DEK comes back from the non-extractable ` +
          `platform key with no passphrase (${r.autoUnsealed}, extractable=${r.autoExtractable}) ` +
          `and opens the sealed value (${j(r.read)}); after reseal(): auto-unseal is null ` +
          `(${r.afterResealIsNull}), the key HANDLE is gone too (${r.handleGone}), state=${j(r.state)}, ` +
          `and the passphrase still opens the same data (${j(r.stillOpens)}). ` +
          `The honest sentence stands: this rung is login convenience, not protection ` +
          `against someone holding the profile.`,
      );
    });

    // --- 7: the sealed filesystem, across a REAL reload -------------------
    await guard(async () => {
      const marker = `MARKER-${crypto.randomUUID()}`;
      const w = await probe(page, "fs-write", { marker });
      await page.reload({ waitUntil: "load" });
      await ready(page);
      const r = await probe(page, "fs-after", { id: w.id, marker, wrote: w.wrote });
      const ok = w.ok && r.ok && r.wrongKey.refused && r.wrongKey.error.code === "io" &&
        !r.markerOnDisk && !r.plaintextOnDisk && r.magic === "PMSEALv1" &&
        r.second === "another checkpoint TEST" && r.cleanup === "ok";
      record(
        "7  sealed-fs",
        "guest plaintext through the polyengine wasi Descriptor surface, sealed on disk, across a REAL reload",
        ok,
        `write+read through wasi:filesystem/preopens@0.3 → openAt → writeViaStream/readViaStream ` +
          `(the spike's Q2 pattern) round-trips before the reload: ${w.ok}; after navigation, ` +
          `re-mounting with the DEK recovered from the passphrase reads the guest's plaintext ` +
          `back: ${r.ok}; a DIFFERENT DEK fails cleanly as a filesystem error ` +
          `(the 0.3 completion future settles err: ${r.wrongKey.error.name} ` +
          `kind=${j(r.wrongKey.error.code)}), not a trap; the RAW ` +
          `OPFS file is ${r.rawLength} bytes beginning ${j(r.magic)}, and contains neither the ` +
          `marker (${r.markerOnDisk}) nor the words "checkpoint plaintext" (${r.plaintextOnDisk}); ` +
          `a second file written after the reload round-trips too (${j(r.second)})`,
      );
      record(
        "7b sealed-fs",
        "checkpoint digests are verified ABOVE the seal",
        "info",
        `The engine digests plaintext as it wrote it; this layer returns byte-for-byte what the ` +
          `guest wrote (row 7), so a digest taken before sealing and re-taken after unsealing ` +
          `agree. Nothing above the wrapper ever sees, or should digest, the ciphertext.`,
      );
    });

    // --- 8: the device lock, seen from a second context -------------------
    await guard(async () => {
      const hold = await probe(page, "lock-hold", {});
      const second = await openPage(ctx, port);
      const seen = await probe(second, "lock-probe", { id: hold.id });
      const contend = await probe(second, "lock-contend", { id: hold.id });
      const released = await probe(page, "lock-release", { id: hold.id });
      const afterRelease = await probe(second, "lock-probe", { id: hold.id });

      // And the release-on-death half: a page that HOLDS the lock and is
      // then CLOSED releases it with no cooperation — the property the
      // sweep is built on.
      const dying = await openPage(ctx, port);
      const dyingHold = await probe(dying, "lock-hold", {});
      const seenAlive = await probe(second, "lock-probe", { id: dyingHold.id });
      await dying.close();
      await new Promise((r) => setTimeout(r, 500));
      const seenDead = await probe(second, "lock-probe", { id: dyingHold.id });
      await second.close();

      const ok = hold.heldHere && seen.held && contend.refused && !released.held &&
        !afterRelease.held && seenAlive.held && !seenDead.held;
      record(
        "8  locks",
        "held across contexts, contended, released explicitly, and released by DEATH",
        ok,
        `page A holds ${j(hold.name)}; page B sees it held: ${seen.held}; page B's ifAvailable ` +
          `request is refused: ${contend.refused}; after release() neither page sees it ` +
          `(${released.held}/${afterRelease.held}); a THIRD page takes a lock (B sees it: ` +
          `${seenAlive.held}) and is then CLOSED — B sees it free: ${!seenDead.held}. ` +
          `That last line is why the sweep can trust a free lock.`,
      );
    });

    // --- 9: the T0 sweep --------------------------------------------------
    await guard(async () => {
      const r = await probe(page, "sweep");
      const ok = r.swept && r.deadGone && r.keptLive && r.keptDurable && r.cleanup === "ok";
      record(
        "9  sweep",
        "a T0 namespace is garbage exactly when its lock is FREE and its lease is STALE",
        ok,
        `live device (lock held, lease renewing) kept, because=${j("lock-held")}: ${r.keptLive}; ` +
          `dead device (no lock, 10-minute-old lease) swept: ${r.swept}, and its index row is ` +
          `gone: ${r.deadGone}; a T1 device with an equally stale lease is never swept: ` +
          `${r.keptDurable}. Detail: ${j(r.detail)}`,
      );
    });

    // --- 10: the anchor ---------------------------------------------------
    await guard(async () => {
      const r = await probe(page, "anchor");
      const ok = r.matchedDevice && r.live && r.adopted && !r.liveAfter &&
        r.adoptedAfterIsNull && r.pointerCleared && r.unknownIsNotLive;
      record(
        "10 anchor",
        "the tab's T0 pointer, and a stale one answers `not live` (the degrade rule's input)",
        ok,
        `sessionStorage holds the device id (${r.matchedDevice}); anchorIsLive: ${r.live}; ` +
          `adoptAnchor returns it: ${r.adopted}; after the device is collected the SAME pointer ` +
          `answers live=${r.liveAfter}, adoptAnchor returns null (${r.adoptedAfterIsNull}) and ` +
          `clears the stale pointer (${r.pointerCleared}); an unknown id is not live ` +
          `(${r.unknownIsNotLive}). The consumer's degrade rule — that is a fresh device, ` +
          `silently — is the caller's; this is the question it asks.`,
      );
    });

    // --- 11-16: THE WORKER HOST -------------------------------------------
    //
    // One browser context for all of them, deliberately: a fresh
    // Playwright context is a fresh storage partition, so "close the
    // page to kill the worker" would also throw away the IndexedDB and
    // OPFS the claims are about (the spike hit exactly this —
    // README.md's Q3 note on the persistent-profile block).
    //
    // From here on the page is only an RPC client. Every engine call,
    // every DEK and every checkpoint happens inside the SharedWorker.

    /** Row 11 carries its device into rows 12 and 16. */
    let t1Device = "";
    /** Row 13 carries its device into row 14. */
    let sessionDevice = "";

    // --- 11: the T1 lifecycle, killed and resumed -------------------------
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "host-t1",
        policy: "until-reseal",
        promote: true,
      });
      t1Device = made.id;

      // The promotion ceremony's worker half: the DEK is minted INSIDE
      // the worker, sealed under the passphrase, and the until-reseal
      // wrap is armed in the same call.
      const open = await probe(page, "hc-open", {
        id: made.id,
        unseal: { passphrase: PASS, untilReseal: true },
      });
      await probe(page, "hc-add", { id: made.id, titles: TODOS });
      const before = await probe(page, "hc-items", { id: made.id });
      const cp = await probe(page, "hc-checkpoint", { id: made.id });
      const died = await probe(page, "hc-die", { id: made.id });

      // RECONNECT: a brand-new SharedWorker under the same name, which
      // is what a respawn is. No passphrase this time — the until-reseal
      // rung is the whole point.
      const back = await probe(page, "hc-open", { id: made.id, unseal: {} });
      const after = await probe(page, "hc-items", { id: made.id });

      const ok = made.tier === "t1" && open.unseal.refused === false &&
        open.status.resumed === false && open.status.sealed === false &&
        before.n === 2 && cp.at > 0 && died.lockHeld === false &&
        back.unseal.refused === false && back.status.resumed === true &&
        back.hello.bootSeq > open.hello.bootSeq &&
        back.hello.instanceNonce !== open.hello.instanceNonce &&
        j(after.titles) === j(before.titles) && after.n === 2;
      record(
        "11 host",
        "T1: promote → unseal → fresh engine → tasks → checkpoint → KILL the worker → resume",
        ok,
        `promote(until-reseal) gives tier=${made.tier}; the first unseal mints the DEK in the ` +
          `worker and the engine comes up FRESH (stateResume()=${open.status.resumed}); ` +
          `tasks.add ×2 over the port → rev=${before.revision} n=${before.n} ${j(before.titles)}; ` +
          `explicit checkpoint at ${cp.at}; then the probe-only die RPC closes the worker's own ` +
          `global and the device lock is released with no cooperation (lockHeld=${died.lockHeld}); ` +
          `a reconnect gets a NEW worker (boot ${open.hello.bootSeq}→${back.hello.bootSeq}, new ` +
          `nonce: ${back.hello.instanceNonce !== open.hello.instanceNonce}), auto-unseals from the ` +
          `platform wrap with NO passphrase, and stateResume() answers ` +
          `${back.status.resumed} — the todos are ${j(after.titles)}`,
      );
    });

    // --- 12: the same, across a REAL page reload --------------------------
    await guard(async () => {
      const before = await probe(page, "hc-items", { id: t1Device });
      const wasBoot = (await probe(page, "hc-status", { id: t1Device })).bootSeq;

      // THE RESPAWN PATH. The spike measured this Chromium replacing the
      // worker on EVERY single-tab reload (Q4) — the zero-client window
      // at navigation — so this row is not a repeat of row 11 by another
      // route: it is the case the T0 design was rewritten for, and the
      // only one a user actually performs.
      await page.reload({ waitUntil: "load" });
      await ready(page);

      const back = await probe(page, "hc-open", { id: t1Device, unseal: {} });
      const after = await probe(page, "hc-items", { id: t1Device });
      const ok = back.unseal.refused === false && back.status.resumed === true &&
        back.status.sealed === false && back.hello.bootSeq > wasBoot &&
        j(after.titles) === j(before.titles);
      record(
        "12 host",
        "a REAL page reload respawns the worker; the device auto-unseals and resumes",
        ok,
        `boot ${wasBoot} → ${back.hello.bootSeq} across the navigation (the worker really was ` +
          `replaced — spike Q4's zero-client window, measured again here); the fresh worker ` +
          `auto-unseals from the persisted wrap (sealed=${back.status.sealed}) and ` +
          `stateResume() answers ${back.status.resumed}; the todos survive: ${j(after.titles)}`,
      );
    });

    // --- 13: the every-session rung DEMANDS the passphrase ----------------
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "host-every",
        policy: "every-session",
        promote: true,
      });
      sessionDevice = made.id;
      const open = await probe(page, "hc-open", {
        id: made.id,
        unseal: { passphrase: PASS },
      });
      await probe(page, "hc-add", { id: made.id, titles: TODOS });
      const before = await probe(page, "hc-items", { id: made.id });
      await probe(page, "hc-checkpoint", { id: made.id });
      await probe(page, "hc-close", { id: made.id });

      await page.reload({ waitUntil: "load" });
      await ready(page);

      // NO UNSEAL ARGUMENT AT ALL: this is the claim. A device on the
      // real tier must not open itself, and the worker must not quietly
      // try the platform wrap on its behalf.
      const sealed = await probe(page, "hc-open", { id: made.id });
      const engineRefused = await probe(page, "hc-call-sealed", { id: made.id });
      const wrong = await probe(page, "hc-unseal", {
        id: made.id,
        opts: { passphrase: PASS_WRONG },
      });
      const right = await probe(page, "hc-unseal", { id: made.id, opts: { passphrase: PASS } });
      const after = await probe(page, "hc-items", { id: made.id });

      const ok = open.status.resumed === false && before.n === 2 &&
        sealed.status.sealed === true && sealed.status.needsPassphrase === true &&
        sealed.status.resumed === null &&
        sealed.status.rungs.passphrase === true && sealed.status.rungs.untilReseal === false &&
        engineRefused.refused && engineRefused.error.code === "no-rung" &&
        wrong.attempt.refused && wrong.attempt.error.code === "wrong-passphrase" &&
        wrong.status.sealed === true &&
        right.attempt.refused === false && right.status.resumed === true &&
        j(after.titles) === j(before.titles);
      record(
        "13 host",
        "every-session: after a reload the unseal DEMANDS the passphrase, refuses the wrong one cleanly",
        ok,
        `the device rests with rungs=${j(sealed.status.rungs)} — a passphrase and NO platform ` +
          `wrap; after the reload it comes back sealed=${sealed.status.sealed} ` +
          `needsPassphrase=${sealed.status.needsPassphrase} and no engine at all ` +
          `(resumed=${sealed.status.resumed}); a driver call through the sealed host is refused ` +
          `as ${j(engineRefused.error.code)}; the WRONG passphrase is refused with ` +
          `${wrong.attempt.error.name} code=${j(wrong.attempt.error.code)} and the device stays ` +
          `sealed (${wrong.status.sealed}); the right one resumes ` +
          `(stateResume()=${right.status.resumed}) and the todos are ${j(after.titles)}`,
      );
    });

    // --- 14: two pages, one context, one device, ONE worker ---------------
    await guard(async () => {
      const second = await openPage(ctx, port);
      const a = await probe(page, "hc-status", { id: sessionDevice });
      // The second tab attaches with NO ceremony: the device is already
      // open, and "unsealed while the app is open ANYWHERE" is exactly
      // the worker's lifetime.
      const b = await probe(second, "hc-open", { id: sessionDevice });
      const itemsA = await probe(page, "hc-items", { id: sessionDevice });
      const itemsB = await probe(second, "hc-items", { id: sessionDevice });

      // A write from one tab is visible to the other because there is
      // only one engine — the dangerous case (two tabs, one device) made
      // structural rather than policed.
      await probe(second, "hc-add", { id: sessionDevice, titles: ["from the second tab"] });
      const afterA = await probe(page, "hc-items", { id: sessionDevice });
      const afterB = await probe(second, "hc-items", { id: sessionDevice });
      const statusB = await probe(second, "hc-status", { id: sessionDevice });
      await probe(second, "hc-close", { id: sessionDevice });
      await second.close();

      const ok = b.hello.bootSeq === a.bootSeq &&
        b.hello.instanceNonce === a.instanceNonce && b.hello.attached === true &&
        b.status.sealed === false && itemsA.revision === itemsB.revision &&
        afterA.revision === afterB.revision && afterA.revision !== itemsA.revision &&
        afterA.n === 3 && afterB.n === 3 && statusB.clients === 2;
      record(
        "14 host",
        "two pages, one device: the SAME worker, one engine, one revision",
        ok,
        `the second tab's hello carries boot=${b.hello.bootSeq} nonce=${b.hello.instanceNonce ===
          a.instanceNonce
          ? "identical"
          : "DIFFERENT"} and attached=${b.hello.attached} — it joined the running host rather ` +
          `than spawning one (a SharedWorker is keyed by origin+url+NAME, and the name is the ` +
          `device); it needs no ceremony (sealed=${b.status.sealed}); both tabs read revision ` +
          `${itemsA.revision}; a tasks.add from the second tab moves BOTH to ${afterA.revision} ` +
          `with n=${afterA.n}; the host counts ${statusB.clients} clients`,
      );
    });

    // --- 15: T0 — the anchor, the reload, and the sweep --------------------
    await guard(async () => {
      // ITS OWN PAGE, because the anchor is per-TAB sessionStorage and
      // because this row has to CLOSE the tab to kill the host — which
      // is what makes the sweep's precondition (lock free) true.
      const t0 = await openPage(ctx, port);
      const first = await probe(t0, "hc-open", { anchorPetname: "ephemeral", unseal: {} });
      const id = first.deviceId;
      await probe(t0, "hc-add", { id, titles: TODOS });
      const before = await probe(t0, "hc-items", { id });
      await probe(t0, "hc-checkpoint", { id });

      // C1's sweep rule, re-asked with a LIVE WORKER: the lease is
      // backdated on purpose, so the lock is the only thing keeping this
      // device — which is precisely the claim.
      const live = await probe(t0, "hc-sweep-live", { id });

      await t0.reload({ waitUntil: "load" });
      await ready(t0);
      // No id: the tab rehydrates from its OWN sessionStorage pointer,
      // which is the entire T0 reload story.
      const back = await probe(t0, "hc-open", { anchorPetname: "ephemeral", unseal: {} });
      const after = await probe(t0, "hc-items", { id: back.deviceId });

      await probe(t0, "hc-close", { id });
      await t0.close();
      await new Promise((r) => setTimeout(r, 600));
      const dead = await probe(page, "hc-sweep-dead", { id });

      const ok = first.status.tier === "t0" && first.status.resumed === false &&
        first.status.sealed === false && before.n === 2 &&
        live.lockHeld && live.kept && !live.swept && live.stillIndexed &&
        back.deviceId === id && back.status.resumed === true &&
        j(after.titles) === j(before.titles) &&
        dead.lockBefore === false && dead.swept && dead.indexRowGone &&
        dead.namespaceGone && dead.anchorNotLive;
      record(
        "15 host",
        "T0: no ceremony, survives a REAL reload through the anchor, and is swept when the host dies",
        ok,
        `a T0 device is created and opened with NO ceremony at all (tier=${first.status.tier}, ` +
          `sealed=${first.status.sealed}) — its DEK rests under the namespace's non-extractable ` +
          `platform key, and its ephemerality is the SWEEP, not key volatility (worker.ts's ` +
          `sealT0); two todos, a checkpoint; with the worker alive and the lease deliberately ` +
          `backdated 10 minutes the sweep KEEPS it because the lock is held ` +
          `(kept=${live.kept} swept=${live.swept}); after a REAL reload the tab rehydrates the ` +
          `SAME device from sessionStorage (${back.deviceId === id}) and stateResume() answers ` +
          `${back.status.resumed} with ${j(after.titles)} intact; then the tab is CLOSED, the ` +
          `lock is free (${dead.lockBefore === false}) and the sweep collects it — index row ` +
          `gone: ${dead.indexRowGone}, namespace gone: ${dead.namespaceGone}, the anchor's ` +
          `liveness question now answers no: ${dead.anchorNotLive}`,
      );
    });

    // --- 16: reseal puts the ceremony back --------------------------------
    await guard(async () => {
      const open = await probe(page, "hc-open", { id: t1Device, unseal: {} });
      const before = await probe(page, "hc-items", { id: t1Device });
      const resealed = await probe(page, "hc-reseal", { id: t1Device });
      const refused = await probe(page, "hc-unseal", { id: t1Device, opts: {} });
      const engineRefused = await probe(page, "hc-call-sealed", { id: t1Device });
      const back = await probe(page, "hc-unseal", { id: t1Device, opts: { passphrase: PASS } });
      const after = await probe(page, "hc-items", { id: t1Device });

      const ok = open.status.sealed === false && resealed.status.sealed === true &&
        resealed.status.rungs.untilReseal === false &&
        resealed.status.rungs.passphrase === true &&
        resealed.status.needsPassphrase === true && resealed.status.resumed === null &&
        refused.attempt.refused && refused.attempt.error.code === "no-rung" &&
        engineRefused.refused &&
        back.attempt.refused === false && back.status.resumed === true &&
        j(after.titles) === j(before.titles);
      record(
        "16 host",
        "reseal(): the persisted wrap goes, the worker drops the DEK, the next unseal is a ceremony again",
        ok,
        `the device was open (sealed=${open.status.sealed}); after reseal() the status says ` +
          `sealed=${resealed.status.sealed} rungs=${j(resealed.status.rungs)} ` +
          `needsPassphrase=${resealed.status.needsPassphrase}, and the engine is gone with the ` +
          `key (resumed=${resealed.status.resumed}); an unseal with no passphrase is refused ` +
          `(${j(refused.attempt.error.code)}) and so is a driver call; the PASSPHRASE still ` +
          `opens the device — the rung reseal deliberately leaves standing — and it resumes ` +
          `(${back.status.resumed}) with ${j(after.titles)} intact`,
      );
    });

    // --- 17: the checkpoint cadence, with nobody asking ------------------
    await guard(async () => {
      // WITH THE PASSPHRASE, because row 16 resealed this device and the
      // platform wrap really is gone — the ceremony is the point of that
      // row and this row must not quietly undo it.
      const open = await probe(page, "hc-open", { id: t1Device, unseal: { passphrase: PASS } });
      const beat = await probe(page, "hc-debounce", { id: t1Device, title: DEBOUNCED });
      // THE ASSERTION THAT MATTERS: kill the host without ever calling
      // `checkpoint()`, and see whether the write is still there. A
      // `lastCheckpoint` that merely moved could be a timer that wrote
      // nothing.
      await probe(page, "hc-die", { id: t1Device });
      const back = await probe(page, "hc-open", { id: t1Device, unseal: { passphrase: PASS } });
      const after = await probe(page, "hc-items", { id: t1Device });

      const ok = open.status.sealed === false &&
        beat.settled !== null && beat.settled !== beat.before &&
        back.status.resumed === true && after.titles.includes(DEBOUNCED);
      record(
        "17 host",
        "the trailing 500ms debounce checkpoints a mutation nobody checkpointed",
        ok,
        `one tasks.add and then NOTHING — no explicit checkpoint call anywhere in this row. ` +
          `lastCheckpoint was ${j(beat.before)} before the write, ${j(beat.immediately)} ` +
          `immediately after it (the trailing edge has not fired yet — a LEADING-edge debounce ` +
          `would have recorded the state from before the write, which is the one moment nobody ` +
          `wants), and ${j(beat.settled)} once the window closed. Then the worker is killed ` +
          `outright and a new one resumes (${back.status.resumed}) with the write present: ` +
          `${after.titles.includes(DEBOUNCED)} — ${j(after.titles)}`,
      );
    });

    // --- 18: the PairingDriver adapter over the REMOTE driver -------------
    await guard(async () => {
      const r = await probe(page, "hc-pairing", { id: t1Device });
      // THE CONTRAST ARM: seal the device and call the engine through
      // it, so the same predicate is asked about a HOST refusal. If both
      // arms answered alike, the two-path split would be decorative.
      await probe(page, "hc-reseal", { id: t1Device });
      const h = await probe(page, "hc-host-refusal", { id: t1Device });
      await probe(page, "hc-unseal", { id: t1Device, opts: { passphrase: PASS } });

      const ok = r.constructed && r.adapterOk === false &&
        // A REAL ComponentException, minted by the PAGE's copy.
        r.engine !== null && r.engine.isWit === true && r.engine.isTrapped === false &&
        r.engine.name === "ComponentException" &&
        typeof r.engine.payload === "string" && r.engine.payload.length > 0 &&
        r.engine.hasStack === true && r.engine.code === undefined &&
        r.adapterUsedPayload &&
        // …and the host arm is emphatically NOT one.
        h.refused === true && h.isWit === false && h.name === "DeviceHostError" &&
        h.code === "no-rung" && h.hostName === "SealError";
      record(
        "18 host",
        "the engine's errors cross as the SANCTIONED cloneable form; the host's keep their typed code",
        ok,
        `createEnginePairingDriver(remote.driver) builds a complete PairingDriver ` +
          `(${r.constructed}) with not one line changed — every method it needs moves only ` +
          `structured-clone-safe values, so nothing had to be excluded from the proxy. ` +
          `ENGINE ARM: the worker sends toCloneable(error) and client.ts rehydrates with ` +
          `fromCloneable, so what the PAGE catches is a real ${r.engine?.name} — ` +
          `isComponentException(e)=${r.engine?.isWit} asked with the PAGE's own copy of the ` +
          `predicate (not a bit the worker asserted about itself), isTrap=${r.engine?.isTrapped}, ` +
          `payload=${j(r.engine?.payload)}, the worker's stack carried verbatim ` +
          `(${r.engine?.hasStack}), and no host \`code\` (${j(r.engine?.code)}) because it is not ` +
          `a host condition. The adapter's own error string IS that payload rather than a ` +
          `message (${r.adapterUsedPayload}). HOST ARM: with the device resealed, a tasks call ` +
          `comes back ${h.name} isComponentException=${h.isWit} code=${j(h.code)} from a ` +
          `${j(h.hostName)} — the typed code survives, which the cloneable form's unbranded-Error ` +
          `row would have dropped silently. The hand-rolled brand is GONE: A19 renamed the key a ` +
          `second time and A20 shipped the forms this seam was the named consumer for.`,
      );

      await probe(page, "hc-close", { id: t1Device });
      await probe(page, "hc-forget", { ids: [t1Device, sessionDevice] });
    });

    // --- 19: the PROMOTION SEAM — a T0 device gains the user's rung -------
    //
    // THE PROBLEM THIS ROW EXISTS FOR. A T0 device is sealed with no
    // ceremony, and the passphrase rung it carries was minted from 32
    // random bytes that were then dropped on the floor (worker.ts's
    // `sealT0`: "a door with no key"). So when the user later says "keep
    // this device" and chooses `every-session`, there is no old
    // passphrase to re-key from and the worker's own DEK handle is
    // non-extractable — `wrapKey` cannot touch it. seal.ts's
    // `rekeyFromPlatform` is the seam that resolves it: the re-wrap is
    // authorized by the PLATFORM rung, which is the one door a T0 device
    // does have, and is therefore authorized by exactly what the
    // `until-reseal` tier is worth — possession of the profile. Anything
    // that could call it could equally have called `unsealFromPlatform`
    // and read the device outright, so it widens nothing.
    //
    // THE ASSERTION IS THE NEGATIVE ONE. It is easy to make a promotion
    // look successful: the index row says `t1`, the status says the
    // right policy, and the device still opens — because the PLATFORM
    // WRAP IS STILL THERE. That device would auto-unseal forever and
    // never ask the passphrase the user chose. So this row closes the
    // connection, reconnects, and proves that an unseal with no
    // passphrase is REFUSED before proving that the passphrase works.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "not yet kept",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      const opened = await probe(page, "hc-open", { id, unseal: {} });
      await probe(page, "hc-add", { id, titles: TODOS });
      await probe(page, "hc-checkpoint", { id });

      const kept = await probe(page, "hc-promote", {
        id,
        petname: "laptop",
        policy: "every-session",
        passphrase: PASS,
      });

      // A NEW WORKER, so nothing in memory can be what opens it.
      await probe(page, "hc-die", { id });
      const silent = await probe(page, "hc-open", { id, unseal: {} });
      const withPass = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS } });
      const items = await probe(page, "hc-items", { id });

      const ok = opened.status.tier === "t0" && opened.status.sealed === false &&
        kept.attempt.refused === false && kept.row.tier === "t1" &&
        kept.row.petname === "laptop" &&
        kept.row.policy === "every-session" &&
        kept.status.rungs.untilReseal === false &&
        silent.unseal.refused === true && silent.unseal.error.code === "no-rung" &&
        silent.status.sealed === true &&
        silent.status.needsPassphrase === true &&
        withPass.attempt.refused === false && withPass.status.sealed === false &&
        withPass.status.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "19 host",
        "promotion: a T0 device is re-keyed onto the user's own rung, and the platform door is shut",
        ok,
        `the device was ephemeral and open with no ceremony (tier=${j(opened.status.tier)} ` +
          `sealed=${opened.status.sealed}); "keep this device" re-wrapped its DEK under the ` +
          `user's passphrase (refused: ${kept.attempt.refused}) — authorized by the platform rung, ` +
          `because the passphrase rung sealT0 left behind is a door whose key nobody kept — and ` +
          `the index row followed LAST: ${j(kept.row)}. The platform wrap is GONE ` +
          `(untilReseal=${kept.status.rungs.untilReseal}): a promotion that left it standing ` +
          `would have produced a device that auto-unseals forever and never asks the passphrase ` +
          `the user just chose. With the worker killed, an unseal carrying no passphrase is ` +
          `refused (${j(silent.unseal.error)}) and the status agrees (sealed=${silent.status.sealed} ` +
          `needsPassphrase=${silent.status.needsPassphrase}); the PASSPHRASE opens it, resumes ` +
          `(${withPass.status.resumed}) and the state is intact — ${j(items.titles)}`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 20: reseal as an UPGRADE ceremony (the ruling) -------------------
    //
    // WHAT IT PROTECTS AGAINST. Reseal deletes the platform wrap. On a
    // device kept with `until-reseal` and never given a passphrase, the
    // rung that would remain is the one `sealT0` minted from 32 random
    // bytes and dropped on the floor — so a plain reseal would leave a
    // picker row demanding a passphrase THAT NEVER EXISTED, and a device
    // destroyed as a side effect of signing out. Destroying a device is
    // `removeDevice`'s job and is asked for explicitly.
    //
    // SO RESEAL ASKS, and reseal time is exactly when it can: the
    // platform rung is still there to authorize `rekeyFromPlatform`, and
    // the re-wrap lands BEFORE the deletion, so a refused ceremony
    // leaves the device precisely as it was. This row asserts both
    // directions — the refusal changes nothing, and the upgrade produces
    // an `every-session` device that the right passphrase opens and the
    // wrong one does not.
    await guard(async () => {
      // THE REAL PATH, not a shortcut: a T0 device gains its wraps by
      // being opened (`sealT0`), and "keep this device" on the
      // convenience rung is a no-op on the seal — which is exactly why
      // the device ends up with no passphrase anybody knows.
      const made = await probe(page, "hc-make", {
        petname: "opens itself",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: {} });
      await probe(page, "hc-add", { id, titles: TODOS });
      // EXPLICITLY, because the worker is killed below and the trailing
      // debounce would be racing it — and because a reseal drops the
      // engine, so a pending background checkpoint would find nothing to
      // write.
      await probe(page, "hc-checkpoint", { id });
      const kept = await probe(page, "hc-promote", {
        id,
        petname: "opens itself",
        policy: "until-reseal",
      });

      // (a) THE REFUSAL, and that it costs the device nothing.
      const bare = await probe(page, "hc-reseal", { id });
      // (b) THE UPGRADE.
      const up = await probe(page, "hc-reseal", { id, passphrase: PASS, upgrade: true });

      // A NEW WORKER, so nothing in memory can be what opens it.
      await probe(page, "hc-die", { id });
      const silent = await probe(page, "hc-open", { id, unseal: {} });
      const wrong = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS_WRONG } });
      const right = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS } });
      const items = await probe(page, "hc-items", { id });

      const ok = kept.status.rungs.untilReseal === true &&
        bare.attempt.refused === true && bare.attempt.error.code === "no-rung" &&
        bare.status.sealed === false && bare.status.rungs.untilReseal === true &&
        up.attempt.refused === false && up.status.sealed === true &&
        up.status.rungs.untilReseal === false && up.status.needsPassphrase === true &&
        up.row.unsealPolicy === "every-session" && up.row.petname === "opens itself" &&
        silent.unseal.refused === true &&
        wrong.attempt.refused === true && wrong.attempt.error.code === "wrong-passphrase" &&
        right.attempt.refused === false && right.status.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "20 host",
        "reseal on a device that opens itself is an UPGRADE ceremony, never a destruction",
        ok,
        `the device was kept on the convenience rung with no passphrase anybody knows ` +
          `(untilReseal=${kept.status.rungs.untilReseal}; the passphrase rung it carries is ` +
          `sealT0's, minted from random bytes and dropped). A reseal with NOTHING is REFUSED ` +
          `(${j(bare.attempt.error.code)}: ${j(bare.attempt.error.message)}) and costs the ` +
          `device nothing — still open (sealed=${bare.status.sealed}), platform wrap intact ` +
          `(${bare.status.rungs.untilReseal}) — which is the whole point: a plain reseal here ` +
          `would have left a picker row demanding a passphrase that never existed. With one, ` +
          `the DEK is re-keyed from the platform rung BEFORE that rung is deleted, and the ` +
          `device comes back an every-session one: sealed=${up.status.sealed} ` +
          `untilReseal=${up.status.rungs.untilReseal} needsPassphrase=${up.status.needsPassphrase}, ` +
          `index row ${j(up.row.unsealPolicy)} under the same name ${j(up.row.petname)}. Against a ` +
          `FRESH worker: an unseal with no passphrase is refused, the WRONG passphrase is a ` +
          `clean ${j(wrong.attempt.error.code)} (AES-KW's integrity check — no partial key ever ` +
          `exists), and the right one opens it and resumes (${right.status.resumed}) with ` +
          `${j(items.titles)} intact`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 21: PLATFORM POSTURE — the same device across a kill -------------
    //
    // The posture the design always wanted (PERSISTENCE.md, "Device
    // signing identity"), now that the engine's `device-identity` import
    // exists (engine commit addbca8). The worker hands the engine the
    // non-extractable handle from the device namespace; the private half
    // never enters the checkpoint at all, so a resumed device is the same
    // device because the PLATFORM still holds its key — not because a
    // seed was decrypted back out of the state root.
    //
    // Every host row above already runs this path (platform is the
    // default now). This one makes the identity claim explicitly, from
    // both sides: the recorded agent id, and the restored archive's own
    // answer to `khKnowsAgent`.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "platform device",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });
      const fresh = await probe(page, "hc-agent", { id });
      const atRest = await probe(page, "hc-identity-at-rest", { id });
      await probe(page, "hc-add", { id, titles: TODOS });
      await probe(page, "hc-checkpoint", { id });

      await probe(page, "hc-die", { id });
      const back = await probe(page, "hc-open", { id, unseal: {} });
      const after = await probe(page, "hc-agent", { id });
      const items = await probe(page, "hc-items", { id });

      const ok = made.posture === "platform" &&
        typeof fresh.agentId === "string" && fresh.agentId.length > 0 &&
        fresh.resumed === false && fresh.knows === true &&
        atRest.present === true && atRest.privateExtractable === false &&
        atRest.algorithm === "Ed25519" && atRest.exportRefused === true &&
        back.status.resumed === true && back.status.sealed === false &&
        after.agentId === fresh.agentId && after.knows === true &&
        after.posture === "platform" && after.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "21 host",
        "platform posture: the device's key never enters the checkpoint, and the resumed device is the SAME agent",
        ok,
        `the index row rests as posture=${j(made.posture)} and the namespace's identity entry is ` +
          `a real platform handle — extractable=${atRest.privateExtractable}, ` +
          `${atRest.algorithm} usages=${j(atRest.usages)}, exportKey("pkcs8") refused: ` +
          `${atRest.exportRefused} (row 5 pins the same property for a harness-driven device; ` +
          `this is the namespace THE WORKER populated and the engine is now trusting). ` +
          `init(false) adopted it rather than minting: agent ${j(String(fresh.agentId).slice(0, 16))}…, ` +
          `resumed=${fresh.resumed}. After the worker is KILLED and a new one resumes ` +
          `(${back.status.resumed}), the agent id is unchanged ` +
          `(${after.agentId === fresh.agentId}) and the RESTORED ARCHIVE itself answers ` +
          `khKnowsAgent(that id)=${after.knows} — asked of the engine, not of our own note. ` +
          `Todos intact: ${j(items.titles)}`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 22: THE MISMATCH REFUSAL -----------------------------------------
    //
    // THE FAILURE THIS ROW IS REALLY ABOUT IS THE SILENT ONE. A resume
    // handed the wrong device's key could plausibly answer "nothing to
    // resume" — and `false` is the fresh-boot path, so the worker would
    // call `init`, mint a third identity, and produce a device that WORKS
    // and is empty, having lost every membership it held. The engine
    // therefore errors rather than answering false (persist.rs's "NOT
    // `Ok(false)`"), and this row asserts the whole consequence: a named
    // refusal, and a host that comes up FAILED rather than empty.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "wrong namespace",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });
      const fresh = await probe(page, "hc-agent", { id });
      await probe(page, "hc-add", { id, titles: TODOS });
      await probe(page, "hc-checkpoint", { id });
      await probe(page, "hc-die", { id });

      // Between the checkpoint and the reconnect, a DIFFERENT valid pair.
      const plant = await probe(page, "hc-plant-identity", { id });

      const refused = await probe(page, "hc-open", { id, unseal: {} });
      const engineCall = await probe(page, "hc-host-refusal", { id });
      const status = await probe(page, "hc-status", { id });

      const payload = String(refused.unseal?.error?.witPayload ?? "");
      // The engine names BOTH agents. The first prefix is the
      // CHECKPOINT's — so this is the engine confirming, from the
      // manifest, which identity the state belongs to.
      const prefix = String(fresh.agentId ?? "").slice(0, 8);
      const ok = refused.unseal.refused === true &&
        refused.unseal.error.isWit === true &&
        payload.includes("device-identity mismatch") &&
        payload.includes(prefix) &&
        // NOT empty-but-working: no engine came up at all, and the
        // device rolled back to SEALED rather than sitting half-open
        // with key material and no engine (worker.ts's "UNSEALING IS
        // ATOMIC" — this row is what found that).
        refused.status.resumed === null && refused.status.sealed === true &&
        engineCall.refused === true && engineCall.code === "no-rung" &&
        status.agentId === fresh.agentId &&
        plant.planted === true && plant.rivalExtractable === false && plant.different === true;
      record(
        "22 host",
        "a rival identity in the namespace is REFUSED by name — never a silent fresh device",
        ok,
        `the device checkpointed as agent ${j(prefix)}…; a DIFFERENT but perfectly valid ` +
          `non-extractable pair was then planted in its identity store ` +
          `(planted=${plant.planted}, extractable=${plant.rivalExtractable}, ` +
          `different=${plant.different}) — the wrong-device / corrupt-namespace case. The resume ` +
          `is refused with a real WIT error (isComponentException=${refused.unseal.error.isWit}) ` +
          `whose payload names both agents and matches the CHECKPOINT's recorded id: ` +
          `${j(payload.slice(0, 150))}. The consequence is the point: the host comes up FAILED, ` +
          `not empty — resumed=${refused.status.resumed}, sealed=${refused.status.sealed}, and a ` +
          `tasks call is refused (${j(engineCall.code)}). An embedder that read the refusal as ` +
          `"nothing to resume" would have called init, minted a third identity and silently lost ` +
          `every membership the device held; the recorded agent id is still ` +
          `${status.agentId === fresh.agentId ? "the original" : "CHANGED"}. This row also found ` +
          `the half-open state it now pins: the ceremony SUCCEEDS here (the wrap opened) and only ` +
          `the resume fails, so an unseal that was not atomic left the DEK in memory with no ` +
          `engine — sealed=false and every call refusing "the device is sealed".`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 23: SEED-POSTURE BACK COMPAT --------------------------------------
    //
    // VERIFY, DO NOT ASSUME. The engine forks on the MANIFEST's recorded
    // posture, not on what the embedder currently prefers
    // (engine/guest/src/persist.rs, "THE POSTURE FORK"), so a checkpoint
    // written before the switch should still resume through the seed
    // path with the `device-identity` fragment present and ignored. That
    // is a claim about someone else's code, which is exactly the kind
    // worth a row rather than a sentence.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "an older device",
        policy: "until-reseal",
        promote: true,
        posture: "seed",
      });
      const id = made.id as string;
      // The probe-only knob: init(true), the pre-switch posture.
      const fresh = await probe(page, "hc-open", {
        id,
        seedPosture: true,
        unseal: { passphrase: PASS, untilReseal: true },
      });
      await probe(page, "hc-add", { id, titles: TODOS });
      await probe(page, "hc-checkpoint", { id });
      await probe(page, "hc-die", { id });

      // …and back with the ORDINARY platform-posture worker: no knob, the
      // fragment wired exactly as every other device gets it.
      const back = await probe(page, "hc-open", { id, unseal: {} });
      const items = await probe(page, "hc-items", { id });

      const ok = made.posture === "seed" && fresh.status.resumed === false &&
        back.unseal.refused === false && back.status.resumed === true &&
        back.status.sealed === false &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "23 host",
        "a SEED-posture checkpoint still resumes under the platform-posture worker",
        ok,
        `the device was inited through the probe's seed knob (init(true), the posture every ` +
          `device used before engine addbca8) and checkpointed; the worker was then killed and ` +
          `the device reopened by the UNCHANGED platform-posture host — same fragment wiring as ` +
          `every other row, no knob. stateResume() answered ${back.status.resumed} and the state ` +
          `is intact (${j(items.titles)}). The engine forked on the manifest's recorded posture ` +
          `rather than on the embedder's current preference, so the identity came back out of the ` +
          `checkpoint and the device-identity import was never consulted — which is what makes ` +
          `the posture switch a change to NEW devices only.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 24: passkey — THE PROMOTION AND THE LOGIN --------------------------
    //
    // Runs on the PRF PAGE (its own localhost origin, its own devices).
    // A T0 device gains a passkey rung the same way row 19 gains a
    // passphrase one: created open with no ceremony, then "keep this
    // device" — except the ceremony here (`enrollPasskey`) runs against
    // the CDP virtual authenticator, and what crosses to the worker is
    // not a typed passphrase but a DERIVED, NON-EXTRACTABLE KEK handle
    // (PERSISTENCE.md's "trust sentence": the assertion runs on the
    // page because `navigator.credentials` is window-only).
    await guard(async () => {
      const made = await probe(prfPage, "hc-make", {
        petname: "not yet kept",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      const opened = await probe(prfPage, "hc-open", { id, unseal: {} });
      await probe(prfPage, "hc-add", { id, titles: TODOS });
      await probe(prfPage, "hc-checkpoint", { id });

      const kept = await probe(prfPage, "pk-promote", { id, petname: "passkey laptop" });

      // A NEW WORKER, so nothing in memory can be what opens it.
      await probe(prfPage, "hc-die", { id });
      const silent = await probe(prfPage, "hc-open", { id, unseal: {} });
      const withPasskey = await probe(prfPage, "pk-unseal", { id });
      const items = await probe(prfPage, "hc-items", { id });

      const ok = kept.attempt.refused === false &&
        kept.row.policy === "passkey" &&
        kept.status.rungs.prf === true &&
        kept.status.rungs.untilReseal === false &&
        kept.status.rungs.passphrase === true &&
        kept.status.rungs.userPassphrase === false &&
        kept.status.needsPassphrase === false &&
        kept.enrollment.rpId === "localhost" &&
        kept.enrollment.credIdLen > 0 &&
        silent.unseal.refused === true && silent.unseal.error.code === "no-rung" &&
        silent.status.sealed === true &&
        withPasskey.attempt.refused === false &&
        withPasskey.status.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "24 passkey",
        "promotion: enrolling a passkey rung, and logging in with it",
        ok,
        `the ceremony (\`enrollPasskey\`) ran on the PAGE against the CDP virtual ` +
          `authenticator — rpId=${j(kept.enrollment.rpId)}, credential ${kept.enrollment.credIdLen} ` +
          `bytes, transports=${j(kept.enrollment.transports)}. What crossed to the worker was the ` +
          `DERIVED, NON-EXTRACTABLE KEK HANDLE, never the raw PRF output or the credential; the ` +
          `worker re-wrapped the DEK under it (refused: ${kept.attempt.refused}) and the index row ` +
          `followed LAST: ${j(kept.row)}. rungs=${j(kept.status.rungs)} — the platform door is SHUT ` +
          `(untilReseal=false, "asked to be asked"), and sealT0's generated passphrase wrap stays ` +
          `behind as a door with no key (passphrase=true, userPassphrase=false); ` +
          `needsPassphrase=${kept.status.needsPassphrase} because the picker offers the passkey ` +
          `ceremony, not a text field. Against a FRESH worker, an unseal with no ceremony at all is ` +
          `refused (${j(silent.unseal.error)}); asserting the passkey (\`assertPasskey\` → ` +
          `\`conn.unseal({prfKek})\`) opens it and resumes (${withPasskey.status.resumed}) with ` +
          `${j(items.titles)} intact`,
      );
      await probe(prfPage, "hc-close", { id });
      await probe(prfPage, "hc-forget", { ids: [id] });
    });

    // --- 25: passkey — THE WRONG KEY IS ONE CLEAN BIT -----------------------
    //
    // A fresh device, promoted to passkey exactly as row 24 does, then
    // an unseal attempt with a KEK derived from key material the wrap
    // was never made with. AES-KW's integrity check makes this a clean
    // `wrong-passkey` refusal with no partial state — a wrong credential,
    // a wrong PRF input, and a copied wrap record all land here
    // indistinguishably, by construction.
    await guard(async () => {
      const made = await probe(prfPage, "hc-make", {
        petname: "wrong key candidate",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      await probe(prfPage, "hc-open", { id, unseal: {} });
      await probe(prfPage, "hc-add", { id, titles: TODOS });
      await probe(prfPage, "hc-checkpoint", { id });
      await probe(prfPage, "pk-promote", { id, petname: "wrong key candidate" });

      await probe(prfPage, "hc-die", { id });
      // Reconnect (no ceremony) before the passkey ops, which assume an
      // existing connection — the same shape row 24's `silent` open
      // uses.
      await probe(prfPage, "hc-open", { id });
      const wrong = await probe(prfPage, "pk-unseal-wrong", { id });
      // No partial state: a call against the still-sealed host refuses
      // the same way it always does, not with anything half-open.
      const sealedCall = await probe(prfPage, "hc-call-sealed", { id });
      const right = await probe(prfPage, "pk-unseal", { id });
      const items = await probe(prfPage, "hc-items", { id });

      const ok = wrong.attempt.refused === true &&
        wrong.attempt.error.code === "wrong-passkey" &&
        wrong.status.sealed === true &&
        sealedCall.refused === true && sealedCall.error.code === "no-rung" &&
        right.attempt.refused === false && right.status.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "25 passkey",
        "a KEK derived from the wrong key material is refused cleanly — AES-KW's integrity check, no partial key",
        ok,
        `against a fresh worker, a KEK derived from 32 random bytes the wrap was never made ` +
          `with — same HKDF→AES-KW shape, wrong input — refuses as ${j(wrong.attempt.error.code)} ` +
          `(${j(wrong.attempt.error.message)}); the device stays sealed (${wrong.status.sealed}) ` +
          `with no partial DEK ever existing, exactly as a wrong passphrase refuses (row 20). A ` +
          `follow-up call against the still-sealed host refuses the ordinary way ` +
          `(${j(sealedCall.error.code)}), not with anything half-open. The RIGHT passkey then ` +
          `opens it and resumes (${right.status.resumed}) with ${j(items.titles)} intact — a wrong ` +
          `credential, a wrong PRF input, and a copied wrap record are all this same one clean bit.`,
      );
      await probe(prfPage, "hc-close", { id });
      await probe(prfPage, "hc-forget", { ids: [id] });
    });

    // --- 26: passkey — RESEAL SURVIVAL AND THE ADDITIVE FALLBACK ------------
    //
    // A device kept with `every-session` (a real user-chosen passphrase,
    // so it has NO platform wrap) switched to passkey unseal — the
    // kept-device path where the passphrase, not a platform rung,
    // authorizes the re-wrap (PERSISTENCE.md's "On a kept device"). Then
    // the two rulings this row exists to pin: reseal never asks an
    // upgrade question when a PRF rung remains reachable (the
    // generalized guard), and BOTH doors open the device afterward —
    // rungs are additive, the policy tag names the ceremony to OFFER,
    // not the only one.
    await guard(async () => {
      const made = await probe(prfPage, "hc-make", {
        petname: "every-session then passkey",
        policy: "every-session",
        promote: true,
      });
      const id = made.id as string;
      await probe(prfPage, "hc-open", { id, unseal: { passphrase: PASS } });
      await probe(prfPage, "hc-add", { id, titles: TODOS });
      await probe(prfPage, "hc-checkpoint", { id });

      const switched = await probe(prfPage, "pk-switch", { id, passphrase: PASS });

      // RESEAL — NO PASSPHRASE OFFERED. The generalized guard: any
      // reachable rung (userPassphrase OR prf) makes reseal proceed
      // with no ceremony at all.
      const resealed = await probe(prfPage, "hc-reseal", { id });

      // DOOR ONE: the passkey. A fresh worker first, so nothing in
      // memory is what opens it.
      await probe(prfPage, "hc-die", { id });
      await probe(prfPage, "hc-open", { id });
      const viaPasskey = await probe(prfPage, "pk-unseal", { id });

      // RESEAL AGAIN, then DOOR TWO: the passphrase.
      await probe(prfPage, "hc-reseal", { id });
      await probe(prfPage, "hc-die", { id });
      await probe(prfPage, "hc-open", { id });
      const viaPassphrase = await probe(prfPage, "hc-unseal", { id, opts: { passphrase: PASS } });
      const items = await probe(prfPage, "hc-items", { id });

      const ok = switched.attempt.refused === false &&
        switched.row.policy === "passkey" &&
        switched.status.rungs.prf === true &&
        switched.status.rungs.userPassphrase === true &&
        switched.status.rungs.untilReseal === false &&
        resealed.attempt.refused === false &&
        resealed.status.sealed === true &&
        resealed.status.rungs.prf === true &&
        viaPasskey.attempt.refused === false && viaPasskey.status.resumed === true &&
        viaPassphrase.attempt.refused === false && viaPassphrase.status.resumed === true &&
        TODOS.every((t: string) => items.titles.includes(t));
      record(
        "26 passkey",
        "the PRF wrap survives reseal with no upgrade ceremony, and BOTH doors still open the device",
        ok,
        `the device was kept as \`every-session\` with a real user passphrase (no platform ` +
          `wrap to re-wrap from) and switched to passkey unseal — the kept-device path, ` +
          `authorized by the passphrase itself. rungs after the switch: ${j(switched.status.rungs)} ` +
          `— policy=${j(switched.row.policy)}, both rungs present. A reseal offering NO passphrase ` +
          `was NOT refused (refused=${resealed.attempt.refused}): the generalized guard walks a ` +
          `PRF rung as always-reachable, so no upgrade question was asked. After reseal ` +
          `(sealed=${resealed.status.sealed}) the wrap SURVIVED — rungs.prf=${resealed.status.rungs.prf} ` +
          `— which is the rung's whole point: an assertion per unseal, nothing persisted opens it ` +
          `alone. Against fresh workers, BOTH doors open it: the passkey ` +
          `(resumed=${viaPasskey.status.resumed}) and, after resealing again, the passphrase ` +
          `(resumed=${viaPassphrase.status.resumed}) — rungs are additive, the policy tag names ` +
          `the ceremony to OFFER, not the only one. Todos intact: ${j(items.titles)}`,
      );

      // --- 26b: a STALE PLATFORM WRAP is never walked silently --------------
      //
      // The ruling this pins (worker.ts's `climbRung`, PERSISTENCE.md's
      // "Unseal."): the passkey policy NEVER falls to the platform wrap.
      // Promotion deletes that wrap precisely so the device asks; no
      // shipped path recreates it beside a PRF wrap, so this arm PLANTS
      // one (through seal.ts's own `enableUntilReseal`) and asserts the
      // silent unseal still refuses — a device whose owner chose the
      // passkey ceremony must get that ceremony even when a skippable
      // door has appeared in its namespace.
      await probe(prfPage, "pk-plant-platform", { id, passphrase: PASS });
      await probe(prfPage, "hc-die", { id });
      const planted = await probe(prfPage, "hc-open", { id, unseal: {} });
      const opened = await probe(prfPage, "pk-unseal", { id });
      const plantedOk = planted.unseal.refused === true &&
        planted.unseal.error.code === "no-rung" &&
        planted.status.sealed === true &&
        planted.status.rungs.untilReseal === true &&
        opened.attempt.refused === false && opened.status.resumed === true;
      record(
        "26b passkey",
        "a planted platform wrap beside the PRF wrap is NEVER walked silently",
        plantedOk,
        `with the device sealed, a platform wrap was PLANTED beside its PRF wrap ` +
          `(rungs.untilReseal=${planted.status.rungs.untilReseal} — the skippable door exists); ` +
          `a fresh worker's unseal with no ceremony input is still refused ` +
          `(${j(planted.unseal.error?.code)}) and the device stays sealed ` +
          `(${planted.status.sealed}): the passkey policy never falls to the platform wrap ` +
          `(worker.ts's asked-to-be-asked rule, applied to the rung that replaced it). The ` +
          `passkey ceremony then opens it as ever (resumed=${opened.status.resumed}).`,
      );
      await probe(prfPage, "hc-close", { id });
      await probe(prfPage, "hc-forget", { ids: [id] });
    });

    // --- 27: passkey — capability, off the browser --------------------------
    await guard(async () => {
      const caps = await probe(prfPage, "pk-capability");
      record(
        "27 passkey",
        "INFO: PRF capability, answered off the browser with the CDP authenticator present",
        "info",
        `prfCapability()=${j(caps.capability)}; PublicKeyCredential present=${caps.publicKeyCredential} ` +
          `— a browser without either would simply not be offered the rung, never a broken ceremony.`,
      );
    });

    // --- 28: THE SEAMS ARE REAL, AND REFUSE BEFORE ANY BINDING -------------
    //
    // A client that reaches PAST `bindStore` and calls
    // `conn.driver.initStore(...)` directly — every `Driver` method is
    // on the remote proxy, so nothing stops the call from being made —
    // must still find every storage seam refusing. `initStore` only
    // arms the GUEST's own notion of an address; the worker's
    // module-scoped grant and signer (what the factories actually close
    // over) are untouched by it, so the first byte still cannot leave.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "unbound",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: {} });
      await s3LogClear(s3Port);

      const r = await probe(page, "sx-sneak", { id, recorderOrigin: s3Origin });
      const logAfter = await s3LogGet(s3Port);

      const ensureMsg = String(r.ensureAttempt.error?.message ?? "");
      const named = ensureMsg.includes("store-owner-fetch: no storage grant configured yet") ||
        ensureMsg.includes("store-signer: no signing credential wired");
      const ok = r.ensureAttempt.refused === true && named && logAfter.length === 0;
      const initNote = r.initAttempt.refused
        ? "also refused"
        : "accepted (it only arms the guest's own address, not the worker's grant)";
      record(
        "28 store-egress",
        "the worker's seams are real and refuse before any binding",
        ok,
        `\`conn.driver.initStore(...)\` called DIRECTLY (a client sneaking addressing past the ` +
          `bind ceremony) then \`ensureBucket()\` → refused: ${r.ensureAttempt.refused}, naming ` +
          `the refusing seam: ${j(ensureMsg)} — one of the factories' own strings, never the ` +
          `old NO_STORE text. The recorder saw NOTHING: ${logAfter.length} requests logged. ` +
          `initStore itself: ${initNote}`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 29: bindStore REFUSES BY NAME -------------------------------------
    //
    // Three distinct destinations that must never be accepted, each
    // refused with its OWN code rather than a shared message a caller
    // would have to parse (worker.ts's `StoreError`/`SealError`).
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "bind-refusals",
        policy: "while-open",
        promote: false,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: {} });

      // (1) bad-destination: an unparseable endpoint.
      const bad = await probe(page, "hc-bind", {
        id,
        binding: { kind: "s3", endpoint: "not a url at all", bucket: "pm-devstore", accessKey: S3_ACCESS_KEY },
      });

      // (2) no-credential: a good endpoint, nothing escrowed for it.
      // A FRESH origin (a port nothing else in this run ever escrows
      // for), so an earlier row's escrow cannot leak into this one.
      const uncredited = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "s3",
          endpoint: "http://127.0.0.1:1/never-escrowed",
          bucket: "pm-devstore",
          accessKey: S3_ACCESS_KEY,
        },
      });

      // (4) no-credential, the MISMATCH shape: escrow a synthetic
      // credential for the recorder origin under S3_ACCESS_KEY, then
      // bind that SAME origin with a DIFFERENT access key and no
      // re-escrow. The worker compares the escrowed record's own
      // `accessKey` field (STORAGE-EGRESS.md §4) — a caller cannot bind
      // under an identifier the escrow was never keyed for, and this
      // fails at bind rather than as a provider 403 later. Escrowed
      // AFTER sub-case (2) ran, so (2)'s "nothing escrowed" origin
      // (a distinct port) stays genuinely uncredited.
      await probe(page, "sx-escrow", {
        origin: s3Origin,
        accessKey: S3_ACCESS_KEY,
        secret: S3_SECRET,
      });
      const mismatched = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "s3",
          endpoint: s3Origin,
          bucket: "pm-devstore",
          accessKey: "SYNTHETIC-OTHER-KEY",
        },
      });

      // (3) no-rung: sealed. A T1 device sealed under a REAL passphrase
      // (row 16's shape): reseal() drops the platform wrap and leaves
      // the passphrase rung standing, sealed=true, and this time there
      // IS no auto-unseal to undo it. Bind while it rests sealed.
      const sealDevice = await probe(page, "hc-make", {
        petname: "bind-refusals-sealed",
        policy: "until-reseal",
        promote: true,
      });
      const sealId = sealDevice.id as string;
      await probe(page, "hc-open", { id: sealId, unseal: { passphrase: PASS, untilReseal: true } });
      const resealed = await probe(page, "hc-reseal", { id: sealId });
      const sealed = await probe(page, "hc-bind", {
        id: sealId,
        binding: { kind: "s3", endpoint: s3Origin, bucket: "pm-devstore", accessKey: S3_ACCESS_KEY },
      });

      const ok = bad.attempt.refused && bad.attempt.error.code === "bad-destination" &&
        uncredited.attempt.refused && uncredited.attempt.error.code === "no-credential" &&
        mismatched.attempt.refused && mismatched.attempt.error.code === "no-credential" &&
        sealed.attempt.refused && sealed.attempt.error.code === "no-rung";
      record(
        "29 store-egress",
        "bindStore refuses by NAME, not by message prose",
        ok,
        `an unparseable endpoint → ${j(bad.attempt.error.code)}; a usable endpoint with nothing ` +
          `escrowed for its origin → ${j(uncredited.attempt.error.code)} (fail at bind, not as a ` +
          `403 twenty provider calls later); a MISMATCHED access key — escrowed under ` +
          `${j(S3_ACCESS_KEY)}, bound with a different one and no re-escrow — → ` +
          `${j(mismatched.attempt.error.code)} (the escrowed record's own accessKey is compared, ` +
          `never accepted as an allowlist of one); and on a SEALED device → ` +
          `${j(sealed.attempt.error.code)}, the same code every other sealed-host refusal in ` +
          `this matrix carries`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
      // sealId is sealed and never re-opened — hc-forget only removes
      // the index row, which is all cleanup needs here.
      await probe(page, "hc-forget", { ids: [sealId] });
    });

    /** Row 30 carries its device into rows 31 and 32. */
    let storeDevice = "";

    // --- 30: bind wires the derived grant and the escrowed signer ---------
    //
    // The page half of the ceremony (`putSigningKey`) and the worker
    // half (`bindStore`) in the order a real embedder must run them.
    // The claim is the EGRESS and its SIGNATURE: nothing crossed the
    // port but addressing, and what the worker signed with is a
    // credential the PAGE escrowed and the worker read back BY
    // DESTINATION ORIGIN — never a secret string on this wire.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "bound device",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      storeDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      const escrow = await probe(page, "sx-escrow", {
        origin: s3Origin,
        accessKey: S3_ACCESS_KEY,
        secret: S3_SECRET,
      });

      const binding = { kind: "s3", endpoint: s3Origin, bucket: "pm-devstore", accessKey: S3_ACCESS_KEY };
      const bound = await probe(page, "hc-bind", { id, binding });

      await s3LogClear(s3Port);
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      const log = await s3LogGet(s3Port);
      const signed = log.find((e: S3LogEntry) =>
        e.authorizationPrefix.startsWith(`AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/`)
      );

      const ok = escrow.ok && bound.attempt.refused === false &&
        j(bound.status.storage) === j(binding) &&
        log.length >= 1 && signed !== undefined;
      record(
        "30 store-egress",
        "bind wires the derived grant and the escrowed signer",
        ok,
        `escrow landed for ${s3Origin} (${escrow.ok}); bindStore accepted ` +
          `(refused=${bound.attempt.refused}) and status().storage echoes the addressing: ` +
          `${j(bound.status.storage)}; ensureBucket() then produced ${log.length} recorded ` +
          `request(s), one signed with \`Authorization: ` +
          `${signed?.authorizationPrefix ?? "(none found)"}…\` — the worker signed with a ` +
          `credential the PAGE escrowed and the worker read back, and nothing crossed the port ` +
          `but addressing. ensureBucket() itself came back ` +
          `${ensure.attempt.refused ? "REFUSED (the recorder is not a real S3, so this is fine — the claim is the signed egress)" : "accepted"}`,
      );
    });

    // --- 31: the binding survives the host's death -------------------------
    //
    // `__die`, reconnect, `unseal` with NO passphrase (the platform
    // wrap from row 30's `untilReseal: true`) — and the sealed row must
    // have been RE-APPLIED by the worker at bring-up with no page-side
    // state at all (persist.rs's "embedder-supplied addressing,
    // re-applied by the embedder", engine/guest/src/persist.rs:611-614
    // — the round's central claim).
    await guard(async () => {
      const id = storeDevice;
      await probe(page, "hc-die", { id });
      const back = await probe(page, "hc-open", { id, unseal: {} });

      await s3LogClear(s3Port);
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      const log = await s3LogGet(s3Port);
      const signed = log.find((e: S3LogEntry) =>
        e.authorizationPrefix.startsWith(`AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/`)
      );

      const ok = back.unseal.refused === false &&
        back.status.storage !== null &&
        back.status.storage.endpoint === s3Origin &&
        log.length >= 1 && signed !== undefined;
      record(
        "31 store-egress",
        "the binding survives the host's death: re-applied at bring-up, no re-bind",
        ok,
        `after a KILL and a fresh worker, an unseal with NO passphrase auto-unseals from the ` +
          `platform wrap and status().storage still reports the addressing ` +
          `(${j(back.status.storage)}) — the sealed row survived and \`bringUpEngine\` ` +
          `re-applied it. With NO \`bindStore\` call anywhere in this row, \`ensureBucket()\` ` +
          `still produced a SIGNED request (${log.length} recorded, prefix ` +
          `${j(signed?.authorizationPrefix)}…) — the worker re-ran \`initStore\` and re-minted ` +
          `the signer from the escrow at bring-up, exactly as persist.rs's comment describes.`,
      );
    });

    // --- 32: reseal seals it, unseal restores it, unbind refuses at the seam
    //
    // Reseal drops the IN-WORKER egress authority with everything else
    // (STORAGE-EGRESS.md §6): a fresh status() on the sealed device
    // must report storage null (unreadable, not absent — read together
    // with `sealed`), unseal brings it back, and `unbindStore` clears
    // the sealed binding and empties the grant so every subsequent
    // egress refuses at the seam with the recorder log staying empty.
    await guard(async () => {
      const id = storeDevice;
      // THE UPGRADE CEREMONY (row 20's idiom): this device's only
      // usable rung is the platform wrap from row 30, so reseal REQUIRES
      // the passphrase and it becomes the device's new every-session
      // rung.
      const resealed = await probe(page, "hc-reseal", { id, passphrase: PASS, upgrade: true });
      const sealedStatus = await probe(page, "hc-status", { id });

      const back = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS } });

      const unbound = await probe(page, "hc-unbind", { id });

      await s3LogClear(s3Port);
      const ensureAfterUnbind = await probe(page, "hc-ensure-bucket", { id });
      const logAfterUnbind = await s3LogGet(s3Port);

      const ok = resealed.attempt.refused === false && resealed.status.sealed === true &&
        sealedStatus.storage === null && sealedStatus.sealed === true &&
        back.attempt.refused === false && back.status.storage !== null &&
        unbound.attempt.refused === false && unbound.status.storage === null &&
        ensureAfterUnbind.attempt.refused === true &&
        logAfterUnbind.length === 0;
      record(
        "32 store-egress",
        "reseal seals the binding; unseal restores it; unbind refuses at the seam",
        ok,
        `reseal() (an upgrade ceremony, refused=${resealed.attempt.refused}) leaves the device ` +
          `sealed (${resealed.status.sealed}); a FRESH status() on the sealed device reports ` +
          `storage=${j(sealedStatus.storage)} — unreadable, read together with ` +
          `sealed=${sealedStatus.sealed}, never a false "absent"; unseal brings it back ` +
          `(storage=${j(back.status.storage)}); unbindStore() then clears the sealed row ` +
          `(storage=${j(unbound.status.storage)}) and \`ensureBucket()\` is refused ` +
          `(${ensureAfterUnbind.attempt.refused}: ${j(ensureAfterUnbind.attempt.error?.message)}) ` +
          `with the recorder seeing NOTHING (${logAfterUnbind.length} requests) — the owner/signer ` +
          `seam, not a 403 twenty calls later.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 33: the egress factories confine by origin and strip identity ----
    //
    // A PAGE-SIDE UNIT ROW: no worker, no wire, `store-egress.ts`'s
    // factories called directly over a hand-built `EgressGrant` — the
    // same shape `applyBinding` builds for an s3 destination (§4).
    await guard(async () => {
      await s3LogClear(s3Port);
      const r = await probe(page, "sx-unit", { recorderOrigin: s3Origin });
      const log = await s3LogGet(s3Port);
      const stripped = log.find((e: S3LogEntry) => e.path === "/pm-devstore/unit-test-key");

      const ok = r.notGranted.refused && r.notGranted.error.message.includes("origin not granted") &&
        stripped !== undefined && stripped.hasAuthorization === false &&
        r.sharedRefused.refused && r.sharedRefused.error.message.includes("no app tier on this provider");
      record(
        "33 store-egress",
        "the egress factories confine by origin and strip identity",
        ok,
        `makeOwnerFetch(grant) to an UNGRANTED origin → refused: ` +
          `${j(r.notGranted.error.message)} (structural, the platform URL parser — never a ` +
          `prefix test); makePublicFetch(grant) carrying a guest-supplied Authorization header ` +
          `reached the recorder with it STRIPPED — hasAuthorization=${stripped?.hasAuthorization} ` +
           `on the logged request; makeSharedFetch(grant) on an s3 provider (no app tier at all) ` +
          `→ ${j(r.sharedRefused.error.message)}`,
      );
    });

    // --- 34: the consent ceremony seals tokens the port never sees --------
    //
    // The v2 shape DRIVE.md §3 builds: the WORKER mints the PKCE
    // verifier and the state and hands back only a URL (public data —
    // app identity, addressing, and a CHALLENGE a fetch cannot reverse);
    // the harness stands in for the popup by fetching that URL with
    // `redirect: "manual"` against the fake's headless `/auth` and
    // relaying `code`+`state` to `oauthComplete`. No token ever crosses
    // this port in either direction.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "gdrive-consent",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      const spec = {
        clientId: GD_CLIENT_ID,
        clientSecret: GD_CLIENT_SECRET,
        redirectUri: `http://127.0.0.1:${port}/probe.html`,
        authUrl: `${gdOrigin}/auth`,
        tokenUrl: `${gdOrigin}/token`,
        space: "drive" as const,
      };
      const { start, code, state } = await startAndFetchAuth(page, id, spec);
      const authorizeUrl = String(start.value?.authorizeUrl ?? "");
      const urlCarriesChallenge = authorizeUrl.includes("code_challenge=") &&
        authorizeUrl.includes("state=") && authorizeUrl.includes(`client_id=${GD_CLIENT_ID}`);
      const urlCarriesNoSecret = !authorizeUrl.includes(GD_CLIENT_SECRET) &&
        !authorizeUrl.includes("client_secret");

      // WRONG STATE, WHILE THE CEREMONY IS STILL PENDING: the real code
      // paired with a state the worker did not mint — refused by name,
      // and the pending ceremony is UNTOUCHED by the refusal (worker.ts
      // only clears it on success), so the correct pair still works
      // right after.
      const wrongState = await probe(page, "gd-oauth-complete", {
        id,
        code,
        state: `${state}-wrong`,
      });

      const completed = await probe(page, "gd-oauth-complete", { id, code, state });
      const status = await probe(page, "hc-status", { id });
      const serialized = j(status);
      const noTokenLeaked = !serialized.includes("synthetic-access") &&
        !serialized.includes("synthetic-refresh");

      // SECOND COMPLETE AFTER SUCCESS: the slot is cleared, so even the
      // SAME code+state now finds no pending ceremony at all.
      const again = await probe(page, "gd-oauth-complete", { id, code, state });

      const ok = start.ok && urlCarriesChallenge && urlCarriesNoSecret &&
        wrongState.ok === false && wrongState.error.code === "bad-ceremony" &&
        completed.ok && completed.value.gdriveConsent?.space === "drive" &&
        status.gdriveConsent?.space === "drive" && noTokenLeaked &&
        again.ok === false && again.error.code === "bad-ceremony";
      record(
        "34 gdrive",
        "the consent ceremony seals tokens the port never sees",
        ok,
        `oauthStart's authorizeUrl carries a PKCE challenge and state and the client id, no ` +
          `client secret anywhere in it (${j(authorizeUrl.slice(0, 90))}…); a real code paired ` +
          `with the WRONG state is refused (${j(wrongState.ok ? "accepted" : wrongState.error.code)}) ` +
          `and does not consume the pending ceremony; the CORRECT pair (via the harness's own ` +
          `fetch of that URL with redirect:"manual", standing in for the popup) completes ` +
          `(gdriveConsent=${j(completed.value?.gdriveConsent)} — a nullable RECORD naming the ` +
          `space the consent was granted for, never a boolean beside a separate space); the ` +
          `FULL serialized status contains ` +
          `no "synthetic-access"/"synthetic-refresh" substring (${noTokenLeaked}) — no token ever ` +
          `crossed this port; a SECOND complete after success finds the slot cleared ` +
          `(${j(again.ok ? "accepted" : again.error.code)})`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 35: bindStore gdrive refuses by code ------------------------------
    //
    // The same rule as the S3 arm, wearing this provider's vocabulary
    // (DRIVE.md §5): everything knowable at bind time settles at bind
    // time. Four distinct destinations that must never be accepted.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "gdrive-bind-refusals",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      // (1) no-credential: no ceremony at all on this device yet.
      const noConsent = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "gdrive",
          root: "pm-devstore",
          apiBase: gdOrigin,
          clientId: GD_CLIENT_ID,
          space: "drive",
        },
      });

      // Run a real ceremony under GD_CLIENT_ID, so the next sub-case has
      // a consent to MISMATCH against.
      const spec = {
        clientId: GD_CLIENT_ID,
        clientSecret: GD_CLIENT_SECRET,
        redirectUri: `http://127.0.0.1:${port}/probe.html`,
        authUrl: `${gdOrigin}/auth`,
        tokenUrl: `${gdOrigin}/token`,
        space: "drive" as const,
      };
      const { code, state } = await startAndFetchAuth(page, id, spec);
      const consented = await probe(page, "gd-oauth-complete", { id, code, state });

      // (2) no-credential, the mismatch analog: a consent rests, but for
      // a DIFFERENT client id than the one this bind names.
      const mismatch = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "gdrive",
          root: "pm-devstore",
          apiBase: gdOrigin,
          clientId: "SYNTHETIC-OTHER",
          space: "drive",
        },
      });

      // (3) bad-destination: an unusable apiBase.
      const badBase = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "gdrive",
          root: "pm-devstore",
          apiBase: "not a url at all",
          clientId: GD_CLIENT_ID,
          space: "drive",
        },
      });

      // (4) bad-destination: an empty root.
      const emptyRoot = await probe(page, "hc-bind", {
        id,
        binding: {
          kind: "gdrive",
          root: "",
          apiBase: gdOrigin,
          clientId: GD_CLIENT_ID,
          space: "drive",
        },
      });

      const ok = noConsent.attempt.refused && noConsent.attempt.error.code === "no-credential" &&
        consented.ok && consented.value.gdriveConsent?.space === "drive" &&
        mismatch.attempt.refused && mismatch.attempt.error.code === "no-credential" &&
        badBase.attempt.refused && badBase.attempt.error.code === "bad-destination" &&
        emptyRoot.attempt.refused && emptyRoot.attempt.error.code === "bad-destination";
      record(
        "35 gdrive",
        "bindStore gdrive refuses by CODE",
        ok,
        `a fresh device with NO ceremony → ${j(noConsent.attempt.error.code)}; after a ceremony ` +
          `under ${j(GD_CLIENT_ID)}, binding with a DIFFERENT client id → ` +
          `${j(mismatch.attempt.error.code)} (the access-key-mismatch rule's exact analog — the ` +
          `\`drive.file\` scope confines visibility per client id); an unusable apiBase → ` +
          `${j(badBase.attempt.error.code)}; an empty root → ${j(emptyRoot.attempt.error.code)}`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    /** Row 36 carries its device into rows 37, 38, 39, 40. */
    let gdriveDevice = "";
    const gdriveBinding = {
      kind: "gdrive",
      root: "pm-devstore",
      apiBase: gdOrigin,
      clientId: GD_CLIENT_ID,
      space: "drive" as const,
    };
    const gdriveSpec = {
      clientId: GD_CLIENT_ID,
      clientSecret: GD_CLIENT_SECRET,
      space: "drive" as const,
      get redirectUri() {
        return `http://127.0.0.1:${port}/probe.html`;
      },
      authUrl: `${gdOrigin}/auth`,
      tokenUrl: `${gdOrigin}/token`,
    };

    // --- 36: bind wires the derived grant; egress carries the consent -----
    //
    // Addressing plus app identifiers, nothing user-secret (DRIVE.md
    // §5); the fake's request log is the observable that the OWNER
    // seam actually carried the consent's Bearer.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "gdrive-bound",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      gdriveDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      const { code, state } = await startAndFetchAuth(page, id, gdriveSpec);
      const consent = await probe(page, "gd-oauth-complete", { id, code, state });

      const bound = await probe(page, "hc-bind", { id, binding: gdriveBinding });
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      const authedCalls = fake.requests().filter((r) => r.hasAuth && !r.refused);
      const root = fake.childNames("");
      const rootChildren = fake.childNames("pm-devstore");

      const ok = consent.ok && consent.value.gdriveConsent?.space === "drive" &&
        bound.attempt.refused === false && j(bound.status.storage) === j(gdriveBinding) &&
        ensure.attempt.refused === false &&
        authedCalls.length > 0 &&
        root.includes("pm-devstore") &&
        rootChildren.includes("docs") && rootChildren.includes("pickup");
      record(
        "36 gdrive",
        "bind wires the derived grant; egress carries the consent",
        ok,
        `bindStore accepted and status().storage echoes the addressing: ${j(bound.status.storage)}; ` +
          `ensureBucket() succeeded (${!ensure.attempt.refused}) and produced ` +
          `${authedCalls.length} Bearer-authorized files-API call(s); the fake's own tree now has ` +
          `${j(root)} at the root and ${j(rootChildren)} inside it — the root/docs/pickup layout ` +
          `DRIVE.md §2 describes — and nothing crossed the port but addressing plus app ` +
          `identifiers: no token is on \`StoreBinding\` or anywhere in \`status()\``,
      );
    });

    // --- 37: consent and binding survive the host's death ------------------
    //
    // `__die`, reconnect, unseal with NO ceremony — the sealed oauth row
    // AND the sealed binding both come back re-applied at bring-up, not
    // re-entered (persist.rs's "the embedder's `init-store` ADDRESSING,
    // re-applied by the embedder", engine/guest/src/persist.rs — the
    // same claim STORAGE-EGRESS.md's row 31 pins for S3, now for the
    // OAuth row too).
    //
    // ADDRESSING is what this row is about, and only addressing. The
    // per-doc bucket STATE that used to be lumped in with it — the
    // name-key chain, the flushed map — is checkpointed since #93 and
    // is row 41's subject. This device has flushed nothing yet, so
    // there is no bucket state here to lose either way.
    await guard(async () => {
      const id = gdriveDevice;
      await probe(page, "hc-die", { id });
      const back = await probe(page, "hc-open", { id, unseal: {} });

      const before = fake.requests().length;
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      const after = fake.requests().length;

      const ok = back.unseal.refused === false &&
        back.status.gdriveConsent?.space === "drive" &&
        back.status.storage !== null && back.status.storage.apiBase === gdOrigin &&
        ensure.attempt.refused === false && after > before;
      record(
        "37 gdrive",
        "consent and binding survive the host's death",
        ok,
        `after a KILL and a fresh worker, an unseal with NO passphrase auto-unseals from the ` +
          `platform wrap and status() reports gdriveConsent=${j(back.status.gdriveConsent)} AND the ` +
          `binding (${j(back.status.storage)}) — both sealed rows survived. With NO ceremony and ` +
          `NO \`bindStore\` call anywhere in this row, \`ensureBucket()\` still reached the fake ` +
          `(${after - before} new request(s)) — \`bringUpEngine\` re-armed the grant from the ` +
          `sealed oauth row and re-applied \`initStore\`, exactly as persist.rs's comment ` +
          `describes and row 31 already pinned for the S3 arm.`,
      );
    });

    // --- 38: 401 → refresh → retry, and the ROTATION is SEALED -------------
    //
    // DRIVE.md §4's write-back, made falsifiable: `fake.expireNow()`
    // invalidates every access token, so the next bucket op must refresh
    // behind the owner seam to succeed at all. The row then kills the
    // worker, re-unseals with NO ceremony, and expires AGAIN — if the
    // rotated refresh token from the FIRST refresh had not been
    // re-sealed, the second refresh would present the fake with a
    // refresh token it already deleted at rotation, and this op would
    // fail.
    await guard(async () => {
      const id = gdriveDevice;

      fake.expireNow();
      const first = await probe(page, "hc-ensure-bucket", { id });

      await probe(page, "hc-die", { id });
      await probe(page, "hc-open", { id, unseal: {} });
      fake.expireNow();
      const second = await probe(page, "hc-ensure-bucket", { id });

      const ok = first.attempt.refused === false && second.attempt.refused === false;
      record(
        "38 gdrive",
        "401 → refresh → retry, and the rotation is SEALED",
        ok,
        `expireNow() invalidates every live access token; a bucket op still succeeds ` +
          `(${!first.attempt.refused}) — the owner seam refreshed behind the seam and retried. ` +
          `The worker is then KILLED, re-unsealed with NO ceremony, and expireNow() runs AGAIN: ` +
          `the fake deleted the FIRST refresh token at rotation (rotation is what makes this a ` +
          `real assertion rather than a no-op), so a worker holding only the stale sealed row ` +
          `would fail this second refresh — it instead succeeds (${!second.attempt.refused}), ` +
          `proving the ROTATED token from the first refresh was written back into the sealed ` +
          `row and re-read at bring-up.`,
      );
    });

    // --- 39: forget is the honest disconnect --------------------------------
    //
    // `forgetOauth` deletes the sealed consent and best-effort revokes
    // it at the provider; the BINDING survives (forgetting the account
    // is not forgetting the destination — the exact mirror of
    // `unbindStore` keeping the S3 escrow, STORAGE-EGRESS.md §6).
    await guard(async () => {
      const id = gdriveDevice;
      const before = fake.requests().length;
      const forgotten = await probe(page, "gd-forget", { id });
      const afterReqs = fake.requests().slice(before);
      const revoked = afterReqs.some((r) => r.path === "/revoke" && r.method === "POST");

      const statusAfter = await probe(page, "hc-status", { id });
      // `ensureBucket` is idempotent on an already-created root (the
      // guest caches resolved folder ids in instance memory, DRIVE.md
      // §2), so a repeat call could succeed with NO network at all and
      // pass this refusal for the wrong reason. `bucketFlush` on this
      // device's own task partition has never been flushed anywhere in
      // this matrix, so it always attempts the write and is the genuine
      // probe of the (now-cleared) owner seam.
      const ensureRefused = await probe(page, "gd-flush", { id });

      // A fresh ceremony under the SAME client id, then the SAME bind:
      // ops work again with nothing re-addressed.
      const { code, state } = await startAndFetchAuth(page, id, gdriveSpec);
      const reconsent = await probe(page, "gd-oauth-complete", { id, code, state });
      const rebound = await probe(page, "hc-bind", { id, binding: gdriveBinding });
      const ensureAgain = await probe(page, "gd-flush", { id });

      const ok = forgotten.ok && forgotten.value.gdriveConsent === null && revoked &&
        statusAfter.gdriveConsent === null && statusAfter.storage !== null &&
        ensureRefused.attempt.refused === true &&
        reconsent.ok && reconsent.value.gdriveConsent?.space === "drive" &&
        rebound.attempt.refused === false &&
        ensureAgain.attempt.refused === false;
      record(
        "39 gdrive",
        "forget is the honest disconnect",
        ok,
        `forgetOauth() reports gdriveConsent=${j(forgotten.value?.gdriveConsent)} and the fake's log ` +
          `shows the /revoke POST (${revoked}); status() agrees (gdriveConsent=` +
          `${j(statusAfter.gdriveConsent)}) while storage stays non-null (${j(statusAfter.storage)}) ` +
          `— forgetting the account is not forgetting the destination; a bucket op now refuses ` +
          `at the owner seam (${ensureRefused.attempt.refused}: ` +
          `${j(ensureRefused.attempt.error?.message)}). A FRESH ceremony under the same client id ` +
          `plus the SAME bind (nothing re-addressed) puts it back to work: ` +
          `gdriveConsent=${j(reconsent.value?.gdriveConsent)}, rebind refused=` +
          `${rebound.attempt.refused}, ensureBucket refused=${ensureAgain.attempt.refused}`,
      );
    });

    // --- 40: reseal seals the consent with everything else ------------------
    //
    // Reseal drops the in-worker egress authority with everything else
    // (STORAGE-EGRESS.md §6, DRIVE.md §4): the same upgrade-ceremony
    // shape row 32 pins for S3, now checked for the oauth row too.
    //
    // IT ALSO TAKES A FINAL CHECKPOINT (worker.ts's `reseal`: sealing
    // drops the engine, so the ceremony saves first and REFUSES if it
    // cannot), and this row is where that is load-bearing rather than
    // merely tidy: row 39 flushed a moment ago, which minted the doc's
    // name-key chain, and row 41 downstream asserts an exact doc-folder
    // count over it. NO TEST MAY PRE-CHECKPOINT BEFORE A RESEAL — an
    // `hc-checkpoint` anywhere between that flush and this ceremony
    // would save the work on the test's behalf and hide a regression of
    // exactly the behaviour under test, leaving row 41 green over a
    // reseal that had thrown the keychain away.
    await guard(async () => {
      const id = gdriveDevice;
      const resealed = await probe(page, "hc-reseal", { id, passphrase: PASS, upgrade: true });
      const sealedStatus = await probe(page, "hc-status", { id });

      const back = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS } });
      const ensure = await probe(page, "hc-ensure-bucket", { id });

      const ok = resealed.attempt.refused === false && resealed.status.sealed === true &&
        sealedStatus.gdriveConsent === null && sealedStatus.storage === null &&
        sealedStatus.sealed === true &&
        back.attempt.refused === false && back.status.gdriveConsent?.space === "drive" &&
        back.status.storage !== null &&
        ensure.attempt.refused === false;
      record(
        "40 gdrive",
        "reseal seals the consent with everything else",
        ok,
        `reseal() (an upgrade ceremony, refused=${resealed.attempt.refused}) leaves the device ` +
          `sealed; a FRESH status() reports gdriveConsent=${j(sealedStatus.gdriveConsent)} and ` +
          `storage=${j(sealedStatus.storage)} — both unreadable while sealed, read together with ` +
          `sealed=${sealedStatus.sealed}; unseal brings BOTH back (gdriveConsent=` +
          `${j(back.status.gdriveConsent)}, storage=${j(back.status.storage)}) and a bucket op works ` +
          `(refused=${ensure.attempt.refused})`,
      );
    });

    // --- 41: names disclose no doc id, and they are STABLE across a kill ---
    //
    // WHAT AN OBSERVER OF THE STORE IS PREVENTED FROM LEARNING, made
    // falsifiable. Object contents on this provider are keyhive
    // ciphertext already, so the names were the remaining disclosure,
    // and plain names had the two properties that hurt: a doc id is
    // GLOBAL (the same shared document carries the same id in every
    // member's store, so listing two accounts reveals that they share a
    // document) and STABLE (activity on one document stays trackable
    // forever). Object AND FOLDER names are now keyed hashes under the
    // doc's name-key, ported from the S3 provider (DRIVE.md §2).
    //
    // THREE CLAIMS, and the third one is new with #93:
    //
    //  1. STRUCTURE still resolves — the fixed container words
    //     `docs`/`pickup`, a doc folder, objects inside it — so a device
    //     holding the name-key can still find everything.
    //  2. The doc id's hex appears in NO stored name anywhere in the
    //     fake's tree, folders included. This is the half that would
    //     have failed before names were keyed and fails again if any
    //     call site is reverted to a plain name.
    //  3. EXACTLY ONE DOC FOLDER, and the same names before and after a
    //     kill. This row used to assert `>= 1` and its evidence text
    //     explained the duplicates as expected: `BucketState.name_keys`
    //     was instance memory, so every respawned worker minted a fresh
    //     keychain and flushed a complete second copy of the store under
    //     a fresh folder name. That was the defect, not the design
    //     (#93): bucket STATE now rides the checkpoint beside the
    //     keyhive archive, so a kill + unseal + flush is a NO-OP on the
    //     tree. The row therefore checkpoints, kills the worker,
    //     re-unseals with no ceremony and flushes again, then asserts
    //     SET EQUALITY of every name in the tree across that cycle.
    await guard(async () => {
      const id = gdriveDevice;
      const flushed = await probe(page, "gd-flush", { id });
      const docHex = flushed.docHex as string;

      const rootChildren = fake.childNames("pm-devstore");
      const docFolders = fake.childNames("pm-devstore/docs");
      const perFolder = docFolders.map((f) => fake.childNames(`pm-devstore/docs/${f}`).length);
      // Every name the provider has written anywhere — folders included.
      const allNames = fake.files().map((f) => f.name);
      const leaking = allNames.filter((n) => n.includes(docHex));
      const namesBefore = [...allNames].sort();

      // THE RESPAWN. An explicit checkpoint (the flush's debounced one
      // would usually have landed, but this row asserts an exact set and
      // will not race a timer), then `__die` — a genuine crash, no
      // goodbye — then an unseal, which brings the engine back up
      // through `stateResume()`. The passphrase is here because row 40's
      // upgrade ceremony moved this device onto `every-session`; which
      // rung reopens it is not what this row is about.
      await probe(page, "hc-checkpoint", { id });
      await probe(page, "hc-die", { id });
      const back = await probe(page, "hc-open", { id, unseal: { passphrase: PASS } });
      const reflushed = await probe(page, "gd-flush", { id });

      const namesAfter = fake.files().map((f) => f.name).sort();
      const docFoldersAfter = fake.childNames("pm-devstore/docs");
      const stable = j(namesBefore) === j(namesAfter);

      const ok = flushed.attempt.refused === false &&
        rootChildren.includes("docs") && rootChildren.includes("pickup") &&
        docFolders.length === 1 &&
        perFolder.every((n) => n > 0) &&
        !docFolders.includes(docHex) &&
        leaking.length === 0 &&
        back.unseal.refused === false &&
        reflushed.attempt.refused === false &&
        docFoldersAfter.length === 1 &&
        stable;
      record(
        "41 gdrive",
        "stored names disclose no doc id, and survive a respawn unchanged",
        ok,
        `after a flush, the structure still resolves — ${j(rootChildren)} under the root, ` +
          `${docFolders.length} doc folder(s) holding ${j(perFolder)} object(s) — so a device ` +
          `that holds the name-key can still find everything. But NO doc folder is the doc id ` +
          `(${!docFolders.includes(docHex)}), and scanning all ${allNames.length} names the ` +
          `provider has written (folders included) for the doc id's hex finds ${leaking.length} ` +
          `— an untrusted observer of this tree learns object counts, sizes and timing, and ` +
          `nothing about WHICH document any of it belongs to. Name-keys blind labels, not ` +
          `traffic shape. Then the STABILITY half (#93): checkpoint, \`__die\`, unseal ` +
          `(refused=${back.unseal.refused}), flush again ` +
          `(refused=${reflushed.attempt.refused}) — the tree still holds ` +
          `${docFoldersAfter.length} doc folder and the full set of ${namesAfter.length} names ` +
          `is IDENTICAL to the ${namesBefore.length} before the kill (${stable}). The keychain ` +
          `and the flushed-chunk map are checkpointed state now, so a respawn re-addresses the ` +
          `store and re-uses it; it no longer re-mints a keychain and writes a complete ` +
          `duplicate copy under a fresh folder name, which is what this row used to record as ` +
          `expected. The S3 arm orphaned objects the same way for the same reason and is fixed ` +
          `by the same change.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    /** Rows 42-44 share one device: an APPDATA-space store. */
    let appdataDevice = "";
    const APPDATA_ROOT = "pm-appdata";
    const appdataBinding = {
      kind: "gdrive",
      root: APPDATA_ROOT,
      apiBase: gdOrigin,
      clientId: GD_CLIENT_ID,
      space: "appdata" as const,
    };
    const appdataSpec = {
      clientId: GD_CLIENT_ID,
      clientSecret: GD_CLIENT_SECRET,
      get redirectUri() {
        return `http://127.0.0.1:${port}/probe.html`;
      },
      authUrl: `${gdOrigin}/auth`,
      tokenUrl: `${gdOrigin}/token`,
      space: "appdata" as const,
    };

    // --- 42: an appdata bind writes into the hidden space, and only there ---
    //
    // THE ISOLATION PROPERTY, PROVEN THROUGH THE WORKER (DRIVE.md §5).
    // The bringup phase already shows the strategy can address both
    // spaces; what this row adds is that the whole worker path — an
    // `appdata` consent, an `appdata` binding, `initStore`, the owner
    // seam — lands the bytes in the HIDDEN space and NOWHERE in the
    // visible one. The negative half is what makes it non-vacuous: the
    // fake answers a cross-space list with an EMPTY LIST rather than an
    // error (real Drive does the same), so a strategy that forgot the
    // `spaces` parameter would leave its objects visible here and this
    // row would catch it.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "gdrive-appdata",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      appdataDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      const { code, state } = await startAndFetchAuth(page, id, appdataSpec);
      const consent = await probe(page, "gd-oauth-complete", { id, code, state });
      const bound = await probe(page, "hc-bind", { id, binding: appdataBinding });
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      const flushed = await probe(page, "gd-flush", { id });

      const hiddenRoot = fake.childNames("", "appDataFolder");
      const hiddenChildren = fake.childNames(APPDATA_ROOT, "appDataFolder");
      const hiddenDocs = fake.childNames(`${APPDATA_ROOT}/docs`, "appDataFolder");
      // THE NEGATIVE HALF, in the DEFAULT (visible) space — the same
      // path, asked the other way.
      const visibleRoot = fake.childNames("");
      const visibleChildren = fake.childNames(APPDATA_ROOT);
      const strayed = fake.files().filter((f) =>
        f.space === "drive" && (f.name === APPDATA_ROOT)
      );

      const ok = consent.ok && bound.attempt.refused === false &&
        j(bound.status.storage) === j(appdataBinding) &&
        ensure.attempt.refused === false && flushed.attempt.refused === false &&
        hiddenRoot.includes(APPDATA_ROOT) &&
        hiddenChildren.includes("docs") && hiddenChildren.includes("pickup") &&
        hiddenDocs.length >= 1 &&
        !visibleRoot.includes(APPDATA_ROOT) && visibleChildren.length === 0 &&
        strayed.length === 0;
      record(
        "42 gdrive",
        "an appdata bind writes into the HIDDEN space and nowhere in the visible one",
        ok,
        `a consent granted for the appdata space plus a binding naming it: status().storage ` +
          `echoes the addressing INCLUDING the space (${j(bound.status.storage)}); after ` +
          `ensureBucket + flush the fake's HIDDEN space holds ${j(hiddenRoot)} at its root, ` +
          `${j(hiddenChildren)} inside it and ${hiddenDocs.length} doc folder(s) — the same ` +
          `root/docs/pickup layout the visible space gets, because everything below the root ` +
          `is identical between spaces. Asked the DEFAULT (visible) way, the same paths are ` +
          `EMPTY: root children ${j(visibleRoot)} (no ${j(APPDATA_ROOT)}), ` +
          `${visibleChildren.length} child(ren) under it, and ${strayed.length} file(s) named ` +
          `${j(APPDATA_ROOT)} anywhere in the visible space. The fake answers a cross-space ` +
          `list with an empty list, not an error — exactly as Google does — so a strategy that ` +
          `dropped \`spaces=appDataFolder\` would show up here as objects in the wrong space.`,
      );
    });

    // --- 43: a consent for one space cannot bind the other ------------------
    //
    // THE SPACE MISMATCH REFUSAL (DRIVE.md §5), the client-id
    // mismatch's exact analog and refused with the same code. The space
    // selects the OAuth SCOPE (`drive.appdata` vs `drive.file`), so the
    // consent this device holds is a consent to a DIFFERENT permission
    // — this browser cannot act for that destination, and it says so at
    // bind rather than as a provider 403 later (STORAGE-EGRESS.md §4).
    await guard(async () => {
      const id = appdataDevice;
      // Everything identical except the space: same client id, same
      // root, same apiBase — so the space is the ONLY thing this
      // refusal can be about.
      const crossSpace = await probe(page, "hc-bind", {
        id,
        binding: { ...appdataBinding, space: "drive" },
      });
      // The appdata bind still works right after, so the refusal did
      // not damage the device or its consent.
      const stillFine = await probe(page, "hc-bind", { id, binding: appdataBinding });
      const message = String(crossSpace.attempt.error?.message ?? "");

      const ok = crossSpace.attempt.refused === true &&
        crossSpace.attempt.error.code === "no-credential" &&
        message.includes("space") && message.includes("consent") &&
        stillFine.attempt.refused === false &&
        j(stillFine.status.storage) === j(appdataBinding);
      record(
        "43 gdrive",
        "a consent for one space cannot bind the other",
        ok,
        `this device's consent was granted for \`appdata\`; a bind identical in every other ` +
          `respect (same client id, same root, same apiBase) but naming \`drive\` → ` +
          `${j(crossSpace.attempt.error?.code)}: ${j(message)} — the access-key-mismatch rule's ` +
          `exact analog, because the space picks the SCOPE and the consent granted was for a ` +
          `different permission; the message tells the user to run the consent again. The ` +
          `matching appdata bind still succeeds immediately after ` +
          `(refused=${stillFine.attempt.refused}, storage=${j(stillFine.status.storage)}).`,
      );
    });

    // --- 44: status() reports the space a consent was granted for -----------
    //
    // `gdriveConsent` is a NULLABLE RECORD, not a boolean beside a
    // separate space (rpc.ts): it mirrors `storage` right beside it, and
    // the two facts cannot disagree because there is only one. Both
    // halves are checked here — the space it names while open, and the
    // null a SEALED host reports because the oauth row rests under the
    // DEK and is genuinely unreadable then.
    await guard(async () => {
      const id = appdataDevice;
      const open = await probe(page, "hc-status", { id });
      const serialized = j(open);
      const noTokenLeaked = !serialized.includes("synthetic-access") &&
        !serialized.includes("synthetic-refresh");

      const resealed = await probe(page, "hc-reseal", { id, passphrase: PASS, upgrade: true });
      const sealedStatus = await probe(page, "hc-status", { id });
      const back = await probe(page, "hc-unseal", { id, opts: { passphrase: PASS } });

      const ok = open.gdriveConsent !== null && open.gdriveConsent.space === "appdata" &&
        open.storage !== null && open.storage.space === "appdata" && noTokenLeaked &&
        resealed.attempt.refused === false &&
        sealedStatus.sealed === true && sealedStatus.gdriveConsent === null &&
        back.attempt.refused === false && back.status.gdriveConsent?.space === "appdata";
      record(
        "44 gdrive",
        "status() names the space a consent was granted for, and null while sealed",
        ok,
        `while open, status().gdriveConsent=${j(open.gdriveConsent)} — the SPACE, and only the ` +
          `space: the full serialized status still contains no token substring ` +
          `(${noTokenLeaked}). It agrees with the binding beside it ` +
          `(storage.space=${j(open.storage?.space)}) because both are addressing. After a ` +
          `reseal a FRESH status() reports gdriveConsent=${j(sealedStatus.gdriveConsent)} — ` +
          `unreadable, not absent, read together with sealed=${sealedStatus.sealed}, exactly ` +
          `the ambiguity \`storage\` carries — and an unseal brings the SAME space back ` +
          `(${j(back.status.gdriveConsent)}).`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 45: a fresh account has no storage record, and says so ------------
    //
    // AN ABSENCE, NEVER AN ERROR. `us-storage-get` answers `none` on an
    // account that has never bound a store — and on a user-system doc
    // written before this key existed, which is the same additive story
    // the partition map has. The sheet's whole account-aware fork hangs
    // off being able to ask this question cheaply on every open, so a
    // rejection here would either cost the sheet a try/catch on the
    // common path or, worse, get papered over into "no record".
    //
    // Deliberately asked on an account that EXISTS (`hc-us-create`
    // first): "no user-system at all" is a different question, already
    // pinned as the WIT-err arm of row 18's `usProfileGet`.
    let acctDevice = "";
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "account-storage",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      acctDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });
      await probe(page, "hc-us-create", { id, displayName: "Synthetic Account" });

      const fresh = await probe(page, "hc-us-storage-get", { id });
      const ok = fresh.attempt.ok === true && fresh.attempt.value === null;
      record(
        "45 account-storage",
        "a fresh account's storage record is an absence, not an error",
        ok,
        `on an account created moments ago and never bound to a store, us-storage-get ` +
          `resolved (ok=${fresh.attempt.ok}) with ${j(fresh.attempt.value ?? null)} — \`none\`, ` +
          `arriving as an absence over the RPC rather than as a rejection. That is what lets ` +
          `the storage sheet ask "does my ACCOUNT have a destination?" on every open and treat ` +
          `the answer as data (DRIVE.md, "The account syncs its storage config; devices keep ` +
          `their credentials").`,
      );
    });

    // --- 46: the account's storage record survives the host's death --------
    //
    // THE CHECKPOINT CLAIM, and it is a claim about a LIST rather than
    // about the engine: `usStoragePut` is absent from rpc.ts's
    // `READONLY_METHODS` — whose note says the list is "of the QUERIES,
    // NOT of the MUTATIONS, on purpose" — so the RPC seam schedules a
    // checkpoint for it exactly as it does for any other write. Put the
    // record, let the 500 ms trailing edge fire, KILL the worker, unseal
    // a fresh one with no ceremony: the record is there. Had the method
    // been filed as a read, this row would come back with `null` and the
    // account's destination would be a thing that quietly evaporated on
    // a crash.
    //
    // The record is a SYNTHETIC LABELED gdrive one — the arm that
    // carries the client pair, so this also pins that the pair makes the
    // round trip through the port and the checkpoint. `client-secret` is
    // app identity, not a user credential (DRIVE.md); no token field
    // exists in the shape to lose.
    await guard(async () => {
      const id = acctDevice;
      const record_ = {
        kind: "gdrive" as const,
        value: {
          root: "SYNTHETIC-ACCOUNT-ROOT",
          apiBase: gdOrigin,
          space: "appdata",
          clientId: "SYNTHETIC-CLIENT-ID.example",
          clientSecret: "SYNTHETIC-CLIENT-SECRET-LABEL",
        },
      };
      const put = await probe(page, "hc-us-storage-put", { id, record: record_ });

      await probe(page, "hc-die", { id });
      const back = await probe(page, "hc-open", { id, unseal: {} });
      const after = await probe(page, "hc-us-storage-get", { id });

      const scheduled = put.after !== null && put.after !== put.before;
      const survived = after.attempt.ok === true && j(after.attempt.value) === j(record_);
      const ok = put.attempt.refused === false && j(put.readBack) === j(record_) &&
        scheduled && back.unseal.refused === false && survived;
      record(
        "46 account-storage",
        "the account's storage record survives the host's death (the put scheduled a checkpoint)",
        ok,
        `a synthetic labeled gdrive record went in through the RPC and read straight back ` +
          `(${j(put.readBack)}) — the variant round-tripped as {kind, value} and the kebab ` +
          `fields as camelCase. lastCheckpoint moved across the put's debounce window ` +
          `(${j(put.before)} → ${j(put.after)}, changed=${scheduled}): \`usStoragePut\` is NOT ` +
          `in rpc.ts's READONLY_METHODS, whose note says that list is of the queries and never ` +
          `of the mutations, so the seam scheduled a checkpoint. The worker was then KILLED and ` +
          `a fresh one unsealed with NO ceremony and NO second put — us-storage-get returns the ` +
          `SAME record (${survived}), client pair included. Filed as a read, this row would ` +
          `come back \`null\`.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 47b: the MINIMAL driver-gate storm (no egress, no latency) -------
    //
    // THE REGRESSION GATE for polyengine#239, and the reason this repo
    // moved to @polyengine/runtime 0.5.1.
    //
    // Two of the device's OWN periodic drivers, run back to back on one
    // store — no network, no egress, nothing slow. 0.4.0's `driveAsync`
    // took its speculative pending-resumption entry unconditionally
    // (0.4.0 src/exec/boundary.ts:1064) and that entry is a store-wide
    // gate, so the second driver could only hop at the top of its loop;
    // 10,000 hops later the internal-bug assert fires. af97c13 bounds the
    // entry to the sole driver and adds a driver-arrival wake.
    //
    // THE DRAIN COUNT IS THE INTERESTING NUMBER, not just the trap: it
    // measures the starvation directly. Measured 21 checkpoints / 1 drain
    // / trap on stock 0.4.0; 107 / 108 / no trap on 0.5.1. A fix that
    // merely deleted the entry would clear the trap; the drain count
    // recovering is what shows the shipped driver-arrival wake working.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "gate storm",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });
      await probe(page, "hc-add", { id, titles: ["gate-storm"] });
      const r = await probe(page, "hc-driver-gate-storm", { id, ms: 12_000 });
      record(
        "47b store-egress",
        "two of the device's own periodic drivers do not trip the speculative resume gate",
        r.trap === "" && r.checkpoints > 0 && r.drains > 0,
        `12 s of back-to-back \`state-checkpoint\` and \`us-events\` calls on ONE store: ` +
          `${r.checkpoints} checkpoints and ${r.drains} drains completed, trap=${j(r.trap)}, ` +
          `and the device still answers afterwards (refused=${r.alive.refused}). Both callers ` +
          `are drivers this device runs on its OWN timers — the worker's 500 ms debounced ` +
          `non-blocking checkpoint (worker.ts) and the solo page's 1 s us-events drain ` +
          `(solo.ts) — so this collision is the ordinary case, not an exotic one. THE TRIGGER ` +
          `IS CONCURRENCY, NOT LATENCY: no slow network, no egress and no Drive round trip is ` +
          `involved anywhere in this row, and there is no Gecko differential; mobile Firefox ` +
          `merely reported it first because slow OPFS widens the window. On 0.4.0 this row ` +
          `FAILS — the us-events driver is starved to a single drain and then dies on ` +
          `"driveAsync: a resumed-activation claim was never released" (polyengine#239, the ` +
          `store-wide speculative resume gate). af97c13 in v0.5.1 bounds that entry to the ` +
          `sole driver and wakes the incumbent on driver arrival, which is what the drain ` +
          `count recovering measures.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // === THE WORKER'S SYNC SCHEDULE (runtime/SYNC.md §3) — rows 48-50 ===
    //
    // WHAT THESE THREE ROWS ARE FOR, and what they deliberately are not.
    // SYNC.md's Devstore gate asks for "the scheduler mechanics on ONE
    // device": a mutation flushing within the debounce window with no
    // button press, an injected failure backing off far enough to cross
    // the announcement threshold, and the boot pull running behind
    // readiness. The ANNOUNCEMENT itself is a page fact and belongs to
    // the e2e suite (this matrix has no visor in it); what is asked of
    // the worker here is the STATUS SURFACE the announcement reads —
    // `DeviceStatus.sync`.
    //
    // THEY SHARE ONE DEVICE, in the order 48 → 49 → 50, because the
    // setup is the expensive part and because the sequence is itself the
    // story: a schedule that works, then fails, then recovers, then
    // survives the host's death. Their own root (`pm-sync`) keeps the
    // change-board assertion in row 48 unambiguous — no other row has
    // ever flushed into this folder, so a board value of "1" means the
    // FIRST flush of this doc from this device and nothing else.
    let syncDevice = "";
    const SYNC_ROOT = "pm-sync";
    const syncBinding = {
      kind: "gdrive",
      root: SYNC_ROOT,
      apiBase: gdOrigin,
      clientId: GD_CLIENT_ID,
      space: "drive" as const,
    };
    /** The doc folders under this row-family's own store root, and the
     * change board hanging off each (SYNC.md §2). The leaf names are
     * keyed hashes, so this is as fine-grained as an outside observer
     * can get. */
    const syncBoards = (): { folder: string; board: Record<string, string> }[] =>
      fake.childNames(`${SYNC_ROOT}/docs`).map((folder) => ({
        folder,
        board: fake.appProperties(`${SYNC_ROOT}/docs/${folder}`),
      }));

    // --- 48: a mutation syncs itself, with no button anywhere --------------
    //
    // PILLAR 3'S HEADLINE ON ONE DEVICE (SYNC.md §3): the flush is the
    // checkpoint's slower sibling, armed by the same mutation
    // notification with a ~20 s trailing debounce, and NOTHING in this
    // row presses anything. The only acts are: publish the tasks
    // partition in the account's pointer map (which is what gives the
    // scheduler a scope at all — worker.ts's `syncScope`), add a todo,
    // and then WAIT.
    //
    // TWO WITNESSES, one on each side of the wire. The worker's own
    // `status().sync.lastFlush` moving off null says the SCHEDULER
    // completed a cycle; the fake's change board says the bytes and the
    // commit note actually landed at the provider. Either alone would be
    // weaker than it looks — a status field can move without a store
    // being touched, and a store can be written by a ceremony rather
    // than by a schedule.
    //
    // THE BOARD VALUE IS A COUNTER, and "1" is the whole assertion: this
    // device's first committed flush of this doc, patched onto the doc
    // folder's `appProperties` after the manifest write that IS the
    // commit point (engine/guest/src/lib.rs's flush-commit note). Nothing
    // secret is on that board and nothing may be — the key is 16 hex
    // characters of a PUBLIC verifying key and the value is a decimal
    // count.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "sync-schedule",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      syncDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });

      const { code, state } = await startAndFetchAuth(page, id, gdriveSpec);
      const consent = await probe(page, "gd-oauth-complete", { id, code, state });
      const bound = await probe(page, "hc-bind", { id, binding: syncBinding });
      const ensure = await probe(page, "hc-ensure-bucket", { id });

      // THE ACCOUNT, and then the SCOPE. Without a user-system document
      // there is no pointer map; without a pointer map the scheduler's
      // scope is empty and every cycle is a no-op that would pass a
      // careless row for the wrong reason.
      await probe(page, "hc-us-create", { id, displayName: "Synthetic Sync Account" });
      const scoped = await probe(page, "hc-us-partition-put", { id, name: "tasks" });

      const boardsBefore = syncBoards();
      const idleStatus = await probe(page, "hc-status", { id });

      // THE ONLY ACT. A todo through the RPC — the same `call()` hook
      // that arms the 500 ms checkpoint — and then nobody touches this
      // device again until the schedule has done something.
      await probe(page, "hc-add", { id, titles: ["a todo that flushes itself"] });
      const flushed = await untilSync(
        page,
        id,
        "the scheduled flush",
        (s) => s.lastFlush !== null,
        45_000,
      );
      const boardsAfter = syncBoards();
      const boards = boardsAfter.map((b) => b.board);
      // TWO DOC FOLDERS, NOT ONE, since RECOVERY.md unparked the us-doc:
      // a cycle now flushes the ACCOUNT DOCUMENT (the empty-doc-id
      // sentinel) as well as every partition in the pointer map. Each
      // carries its own change board, and each board's single value is
      // this device's FIRST committed flush of that doc — so "1" twice
      // rather than "1" once. The count is the assertion it always was;
      // what changed is the SCOPE of a cycle, deliberately.
      const everyBoardFirstFlush = boards.length > 0 &&
        boards.every((b) => Object.keys(b).length === 1 && Object.values(b)[0] === "1");

      const ok = consent.ok && bound.attempt.refused === false &&
        ensure.attempt.refused === false &&
        scoped.attempt.refused === false && scoped.names.includes("tasks") &&
        idleStatus.sync !== null && idleStatus.sync.lastFlush === null &&
        flushed.ok && flushed.sync.flushFailures === 0 &&
        boardsBefore.length === 0 && boardsAfter.length === 2 &&
        everyBoardFirstFlush;
      record(
        "48 sync",
        "a mutation flushes itself within the debounce window, with no button pressed",
        ok,
        `a bound device with an ACCOUNT and its tasks partition published in the pointer map ` +
          `(usPartitions=${j(scoped.names)} — worker.ts's \`syncScope\` reads exactly this, so a ` +
          `device without it would have no scope to flush). Before the mutation the store held ` +
          `${boardsBefore.length} doc folder(s) and status().sync said ` +
          `${j(idleStatus.sync)} — bound, and nothing synced yet, which is the ` +
          `\`{lastFlush: null}\` case rpc.ts distinguishes from an unbound device's null. ONE ` +
          `todo went in through the RPC and NOTHING ELSE was called: ${flushed.waitedMs} ms ` +
          `later (debounce 20 s + margin, deadline 45 s) status().sync=${j(flushed.sync)} — ` +
          `lastFlush stamped, flushFailures 0. The provider agrees: ${boardsAfter.length} doc ` +
          `folders now — the tasks partition AND the ACCOUNT DOCUMENT, which rides the cycle ` +
          `since RECOVERY.md unparked SYNC.md §3's parked item (the empty-doc-id sentinel; a ` +
          `restore can only be as fresh as the last us flush) — carrying the change boards ` +
          `${j(boards)}: each ONE key (16 hex characters of a public verifying key) whose value ` +
          `is the decimal counter "1", this device's first COMMITTED flush of that doc, patched ` +
          `after the manifest write that is the commit point. A counter and a public tag are ` +
          `the only things that may ever go on that board (SYNC.md §2).`,
      );
    });

    // --- 49: backoff is real, and shaped like the announcement -------------
    //
    // SYNC.md §3: "any failed background flush/pull is backoff-with-jitter
    // (truncated exponential, factor 2, cap 10 min)… after three
    // consecutive failures the visor ANNOUNCES". This row owns the
    // WORKER's half of that sentence — the count reaching three, the
    // sentence available to say, and the reset. The visor's actual
    // announcement is the e2e suite's (no page in this matrix).
    //
    // THE OUTAGE IS A 503 ON THE FILES API ONLY, injected through the
    // fake's `refuseNextFiles` (added for this row). Not a 401: that is
    // the one refusal the seam has a recovery for (DRIVE.md §4's
    // refresh-and-retry), so it would exercise the token dance instead
    // of the backoff. The OAuth endpoints keep answering throughout, so
    // nothing here can be mistaken for a consent that fell over.
    //
    // THE DEADLINES COME FROM THE CONSTANTS, not from taste. Base 5 s,
    // factor 2, jitter ×0.5–1.5: the first failure lands one debounce
    // (20 s) after the mutation, the second up to 7.5 s later, the third
    // up to 15 s after that — worst case ~43 s, so 90 s is a margin
    // rather than a guess. The recovery retry is the n=3 delay, up to
    // 30 s, and the flush that follows it must both zero the count and
    // stamp `lastFlush`.
    //
    // WHAT "A SENTENCE" MEANS is asserted rather than assumed: prose
    // with the provider's own words in it, no bearer, no object name, no
    // signed URL — `lastError` inherits the OAuth ceremony's "the status
    // and not one byte of the body" discipline (rpc.ts's `SyncStatus`).
    await guard(async () => {
      const id = syncDevice;
      const before = (await probe(page, "hc-status", { id })).sync;

      // THE STORE GOES DOWN. `Infinity` rather than a count: the row
      // heals it explicitly below, and a count would make the number of
      // requests one flush cycle happens to make into a load-bearing
      // constant.
      fake.refuseNextFiles(Infinity);
      await probe(page, "hc-add", { id, titles: ["a todo nobody can flush"] });
      const failing = await untilSync(
        page,
        id,
        "three consecutive failed flush cycles",
        (s) => s.flushFailures >= 3,
        90_000,
      );
      const sentence = String(failing.sync?.lastError ?? "");
      // NOT MATERIAL, asked negatively. The bearer the fake issues is
      // labelled, so its label appearing anywhere in the status would be
      // a leak with a name.
      const noMaterial = !/synthetic-access|synthetic-refresh|Bearer /i.test(sentence);

      // AND THE STORE COMES BACK. The next retry is the n=3 backoff
      // (≤30 s jittered); the cycle after it must zero the count AND
      // stamp lastFlush — a count that reset without a flush landing
      // would be a mute button rather than a recovery.
      fake.refuseNextFiles(0);
      const healed = await untilSync(
        page,
        id,
        "the first successful cycle after the outage",
        (s) => s.flushFailures === 0 && s.lastFlush !== null,
        90_000,
      );

      const ok = before !== null && before.flushFailures === 0 &&
        failing.ok && failing.sync.flushFailures >= 3 &&
        sentence.length > 0 && /\s/.test(sentence) && sentence.length <= 301 &&
        noMaterial &&
        healed.ok && healed.sync.flushFailures === 0 &&
        healed.sync.lastFlush !== null &&
        (before.lastFlush === null || healed.sync.lastFlush > before.lastFlush) &&
        fake.refusalsPending() === 0;
      record(
        "49 sync",
        "three failed background flushes back off and leave a sentence; a success resets the count",
        ok,
        `the fake's files API was put into a 503 outage (the OAuth endpoints kept answering, so ` +
          `this is a provider outage and not a lost consent) and ONE todo was added. ` +
          `${failing.waitedMs} ms later — the debounce plus two jittered backoff waits, base ` +
          `5 s × 2, worst case ~43 s — status().sync reported ` +
          `flushFailures=${failing.sync?.flushFailures}, which is the threshold at which SYNC.md ` +
          `§3 says a silently-stopped sync becomes a lie of omission and the visor must speak. ` +
          `lastError is prose a person can read (${j(sentence.slice(0, 120))}, ` +
          `${sentence.length} chars, truncated at 300 by the worker) and carries NO material: ` +
          `no bearer label, no object name (${noMaterial}). The store was then healed and left ` +
          `alone: ${healed.waitedMs} ms later (the n=3 backoff, ≤30 s jittered, plus the cycle) ` +
          `status().sync=${j(healed.sync)} — the count is back to 0 AND lastFlush moved, so the ` +
          `reset is a flush that landed rather than a counter someone cleared. The pull ` +
          `direction backs off on its own counter beside it, deliberately: one bucket can be ` +
          `unwritable and readable.`,
      );
    });

    // --- 50: the boot pull is armed BEHIND readiness -----------------------
    //
    // SYNC.md §2: one pull per partition at bring-up, "BEHIND readiness —
    // boot never blocks on the network". The claim is STRUCTURAL, and so
    // is the way it is measured: `unseal` publishes the engine, makes
    // `status()` answerable, and only then calls `startSyncSchedule`,
    // which ARMS A ZERO-DELAY TIMER rather than awaiting anything
    // (worker.ts's `startSyncSchedule`). So at the instant the unseal
    // returns, the pull has not run yet — `sync.lastPull` is null — and
    // the ceremony was not made to wait for it.
    //
    // WITH THE BUCKET UNREACHABLE, which is what turns "did not wait"
    // from an inference into an observation: a boot that awaited the
    // pull would take the outage's full failure path before answering,
    // and this row would time out rather than return in seconds.
    //
    // WHAT THIS ROW DOES NOT CLAIM, deliberately. It does NOT assert
    // that `lastPull` gets stamped shortly afterwards, because on a
    // device with no SIBLINGS it does not: worker.ts's `pullCycle` finds
    // an empty sibling set, re-arms at the ordinary cadence and returns
    // WITHOUT stamping — a cycle that pulled from nowhere does not get
    // to claim it pulled. Asserting a stamp here would be inventing a
    // semantic the worker does not have. The stamp on a device that DOES
    // have a sibling is the e2e scenario `solo-offline-sync`'s claim,
    // where there is a second device to have written something.
    await guard(async () => {
      const id = syncDevice;
      // Enough refusals to cover whatever the boot pull attempts; healed
      // immediately after, and `refusalsPending()` reports what was left.
      fake.refuseNextFiles(24);
      await probe(page, "hc-die", { id });
      const startedAt = Date.now();
      const back = await probe(page, "hc-open", { id, unseal: {} });
      const elapsed = Date.now() - startedAt;
      const atReturn = back.status.sync;
      // A beat later, still under the outage: the schedule may have
      // failed a cycle by now, but a boot pull must not by itself drive
      // the device over the announcement threshold.
      await new Promise((r) => setTimeout(r, 3_000));
      const settled = (await probe(page, "hc-status", { id })).sync;
      const leftover = fake.refusalsPending();
      fake.refuseNextFiles(0);

      const ok = back.unseal.refused === false && back.status.sealed === false &&
        back.status.storage !== null && atReturn !== null &&
        atReturn.lastPull === null && elapsed < 30_000 &&
        settled !== null && settled.pullFailures < 3;
      record(
        "50 sync",
        "the boot pull is ARMED behind readiness — the unseal that opened the device did not wait for it",
        ok,
        `the worker was KILLED and reopened with the store REFUSING every files-API call, so a ` +
          `bring-up that awaited its pull would have to walk the whole failure path before ` +
          `answering. It answered in ${elapsed} ms (deadline 30 s), unrefused, with the binding ` +
          `re-applied (${j(back.status.storage?.kind)}) — and at the instant it returned ` +
          `status().sync=${j(atReturn)}: lastPull is NULL because the pull is a zero-delay TIMER ` +
          `armed after the engine is published, never an await in front of the answer ` +
          `(worker.ts's \`startSyncSchedule\`). Three seconds later, still under the outage, ` +
          `sync=${j(settled)} — pullFailures below the announcement threshold, so a boot against ` +
          `an unreachable bucket does not by itself become news. NOTE, and it is a contract ` +
          `rather than an omission: this device has NO SIBLINGS, and worker.ts's \`pullCycle\` ` +
          `returns without stamping lastPull when the sibling set is empty — a cycle that ` +
          `pulled from nowhere does not claim to have pulled. The stamp itself is asserted ` +
          `where there IS a sibling: the e2e scenario \`solo-offline-sync\`. ` +
          `${leftover} injected refusal(s) went unused and were cleared.`,
      );
      await probe(page, "hc-close", { id });
      await probe(page, "hc-forget", { ids: [id] });
    });

    // --- 54-60: ACCOUNT RECOVERY (runtime/RECOVERY.md) ---------------------
    //
    // "Losing every device does not lose the account." The kit ceremony
    // mints a DORMANT MEMBER DEVICE whose secrets exist only inside a
    // sealed bundle; restore boots that device on a fresh namespace and
    // then consumes the kit, because a reusable kit would need a silent
    // background re-exporter whose failure is invisible until the
    // disaster it exists for.
    //
    // THE SECRETS NEVER REACH THIS FILE. The guest mints the phrase and
    // the page holds it under a handle (page.ts's `phrases`); every row
    // below drives a restore BY HANDLE, so no phrase and no bundle
    // crosses the Playwright protocol or lands in this run's log. What
    // the rows assert about them is shape (ten words), absence (the scan)
    // and consequence (a restore that works, and one that refuses).
    //
    // THE BACKEND IS THE OBJECT STORE, not the recorder: see
    // `serveObjects` for why the difference is structural rather than
    // convenient.
    const rcBinding = {
      kind: "s3" as const,
      endpoint: objOrigin,
      bucket: "pm-recovery",
      accessKey: S3_ACCESS_KEY,
    };
    // A wrong phrase, obviously synthetic and obviously not a kit's: ten
    // words that no wordlist draw would produce together.
    const WRONG_PHRASE = "wrong wrong wrong not the phrase test test test test test";
    const FILE_PASS = "the-file-kit-passphrase-TEST";
    const FILE_PASS_WRONG = "definitely-not-the-file-passphrase-TEST";
    let rcDevice = "";
    let rcKitHandle = "";
    let rcRestored = "";
    let objectsAfterKit: string[] = [];
    let objectsAfterRestore: string[] = [];
    const RC_TODOS = ["a todo from before the kit", "a second todo from before the kit"];
    const RC_LATE = "a todo written AFTER the kit was minted";
    const RC_NAME = "the machine it became";

    // --- 54: the kit ceremony, and the phrase is nowhere on disk -----------
    //
    // RECOVERY.md pins the phrase: ten words from the EFF short
    // wordlist, ~103.4 bits, "generated IN-GUEST (single authority for
    // format and derivation), displayed once in visor pixels, never
    // persisted anywhere".
    //
    // THE ABSENCE IS THE HEADLINE and it is asked the way the identity
    // rows ask their at-rest questions: go and look. Every IndexedDB
    // record on the origin (bytes included), both web-storage areas, and
    // every file under every OPFS directory — searched for the phrase,
    // for a slice of it, and for a whitespace-collapsed variant, as text
    // AND as hex. A `clean` verdict here is the difference between "we
    // do not write it down" as a claim and as a fact: the DEVICE STORE
    // is the layer that persists things, so it is the layer that has to
    // be searched.
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "recovery-origin",
        policy: "until-reseal",
        promote: true,
      });
      const id = made.id as string;
      rcDevice = id;
      await probe(page, "hc-open", { id, unseal: { passphrase: PASS, untilReseal: true } });
      await probe(page, "sx-escrow", {
        origin: objOrigin,
        accessKey: S3_ACCESS_KEY,
        secret: S3_SECRET,
      });
      const bound = await probe(page, "hc-bind", { id, binding: rcBinding });
      const ensure = await probe(page, "hc-ensure-bucket", { id });
      // THE ACCOUNT IN THE SHAPE A REAL EMBEDDER BUILDS IT — the tasks
      // partition DELEGATED TO THE USER GROUP, not to this device. See
      // page.ts's `rc-account-create`: a device-delegated partition is
      // unreadable by any device enrolled later, restored kits included,
      // because BeeKEM adds are not retroactive.
      const scoped = await probe(page, "rc-account-create", {
        id,
        displayName: "Synthetic Recovery Account",
      });
      await probe(page, "hc-add", { id, titles: RC_TODOS });
      // The user's own Sync-now, not the schedule: this row wants
      // determinism, and an explicit act deserves an explicit answer.
      const flushed = await probe(page, "rc-flush-now", { id });

      const kit = await probe(page, "rc-kit-create", {
        id,
        spec: { kind: "bucket", label: "paper backup" },
      });
      const kits = await probe(page, "rc-kits", { id });
      const scan = kit.attempt.ok ? await probe(page, "rc-scan", { handle: kit.handle }) : null;
      const devices = await probe(page, "rc-devices", { id });
      if (kit.attempt.ok) rcKitHandle = kit.handle;
      objectsAfterKit = objects.names();
      const bundleObjects = objectsAfterKit.filter((n) => n.startsWith("recovery/"));

      const ok = bound.attempt.refused === false && ensure.attempt.refused === false &&
        j(scoped.names) === j(["tasks"]) && flushed.us.refused === false &&
        kit.attempt.ok === true && kit.kind === "bucket" &&
        kit.words === 10 && kit.allLowercaseWords === true &&
        kits.attempt.ok === true && kits.kits.length === 1 &&
        kits.kits[0].kind === "bucket" &&
        devices.n === 2 && devices.names.includes("paper backup") &&
        bundleObjects.length === 1 &&
        scan !== null && scan.clean === true && scan.idbRecords > 0 && scan.opfsFiles > 0;
      record(
        "54 recovery",
        "a bucket kit mints ten words, enrolls a dormant device — and the phrase is on no disk anywhere",
        ok,
        `an S3-bound device with an account and its tasks partition published minted a BUCKET ` +
          `kit. The phrase came back with ${kit.words} words (RECOVERY.md pins ten from the EFF ` +
          `short list, ~103.4 bits), all lowercase word characters: ${kit.allLowercaseWords} — ` +
          `and it never left the page: the driver holds a HANDLE, not a secret. The account's ` +
          `kit list is ${j(kits.kits)} (agent ids truncated to 12 hex characters here; they are ` +
          `public keys, but a log is not the place for a whole one), and the kit is a real ` +
          `DEVICE: the directory now names ${j(devices.names)} — ${devices.n} entries, the kit ` +
          `beside the machine that minted it, revocable like any device. The store holds ` +
          `${bundleObjects.length} object under \`recovery/\` (the phrase-derived name; the ` +
          `provider sees it regardless and it unlocks nothing — the payload is sealed under the ` +
          `phrase-derived KEK). THE SCAN: ${scan?.idbDatabases} IndexedDB database(s), ` +
          `${scan?.idbRecords} records, ${scan?.storageEntries} web-storage entries and ` +
          `${scan?.opfsFiles} OPFS files were searched for the phrase, for a three-word slice of ` +
          `it and for a whitespace-collapsed variant, as text and as hex. Hits: ` +
          `${j(scan?.hits ?? [])}.`,
      );
    });

    // --- 55: the restore round trip, on a SECOND device namespace ----------
    //
    // THE CLAIM RECOVERY.md OPENS WITH, made executable in one browser:
    // a fresh device namespace with no engine state, no identity and no
    // account boots from the kit plus the destination alone, and comes
    // up holding the account's content.
    //
    // THE LATE WRITE IS THE POINT OF THE THIRD TODO. A kit is a key to
    // the BUCKET, not a snapshot of the account (RECOVERY.md: "the kit
    // is the bucket's key, not a second bucket"), so a todo written
    // AFTER the ceremony has to arrive too — which is only true if the
    // restore actually rehydrates from the store rather than from
    // anything bundled.
    //
    // AND THE NAME: "the kit's label gives way to the user's word for
    // the machine it became" (engine.wit's `recovery-restore-bucket`).
    // The devices sheet must show the ceremony's name, not "paper
    // backup".
    await guard(async () => {
      await probe(page, "hc-add", { id: rcDevice, titles: [RC_LATE] });
      const flushed = await probe(page, "rc-flush-now", { id: rcDevice });
      const before = await probe(page, "hc-items", { id: rcDevice });

      const restored = await probe(page, "rc-restore", {
        petname: "restored-device",
        binding: rcBinding,
        handle: rcKitHandle,
        kind: "bucket",
        deviceName: RC_NAME,
      });
      rcRestored = restored.id as string;
      const after = restored.attempt.refused
        ? { titles: [], n: 0, revision: "-" }
        : await probe(page, "hc-items", { id: rcRestored });
      const devices = restored.attempt.refused
        ? { names: [], n: 0 }
        : await probe(page, "rc-devices", { id: rcRestored });
      objectsAfterRestore = objects.names();

      const equal = j(after.titles) === j(before.titles);
      const ok = flushed.us.refused === false && restored.attempt.refused === false &&
        restored.status.sealed === false && restored.status.storage?.kind === "s3" &&
        restored.status.agentId !== null && restored.status.tier === "t0" &&
        equal && after.n === 3 && after.titles.includes(RC_LATE) &&
        devices.names.includes(RC_NAME) && !devices.names.includes("paper backup");
      record(
        "55 recovery",
        "a fresh namespace restores the whole account from phrase + destination, with NO live peer",
        ok,
        `a SECOND device namespace in this browser — no engine state, no identity, no account — ` +
          `was handed the destination and the kit and nothing else. It came up unsealed ` +
          `(sealed=${restored.status.sealed}), bound (${j(restored.status.storage?.kind)}), with ` +
          `an agent id of its own, and at TIER ${j(restored.status.tier)}: a restore is not a ` +
          `decision to keep the machine it ran on, so promotion stays the user's later act ` +
          `(PERSISTENCE.md's try-then-keep). Its todo list is ${j(after.titles)} against the ` +
          `origin device's ${j(before.titles)} — equal: ${equal} — INCLUDING ` +
          `${j(RC_LATE)}, written after the kit was minted, which is what proves the content ` +
          `came out of the BUCKET rather than out of the bundle. The devices sheet now reads ` +
          `${j(devices.names)}: the ceremony's name, and the kit's label "paper backup" is gone ` +
          `from it.`,
      );
    });

    // --- 56: the kit is spent — consumed artifacts, and a refused second ---
    //
    // RECOVERY.md, "Single-use, consumed at restore": the bundle object
    // and the K_p are deleted after the restore fully succeeds and the
    // us-doc record is cleared. Three witnesses, because each one alone
    // is weaker than it looks:
    //
    //   * THE STORE'S OWN SET DIFFERENCE — what actually stopped
    //     existing between the ceremony and the end of the restore.
    //     Asked as REMOVALS only: a restore also WRITES (its own
    //     manifests, its own oplogs), so the assertion is about what
    //     went, not about what is left.
    //   * A SECOND RESTORE, refused. Double-restore is an identity fork
    //     — two live instances of one identity clobbering each other's
    //     keyed names — so consumption makes it structurally impossible
    //     rather than merely discouraged.
    //   * THE ACCOUNT'S OWN LIST, read on the ORIGIN device after it
    //     pulls: the consume cleared the record and flushed the us-doc,
    //     so the device that minted the kit learns it is gone through
    //     the ordinary account pull path and not through a side channel.
    await guard(async () => {
      const removed = objectsAfterKit.filter((n) => !objectsAfterRestore.includes(n));
      const bundleGone = removed.some((n) => n.startsWith("recovery/"));
      const kpGone = removed.some((n) => !n.startsWith("recovery/"));

      const second = await probe(page, "rc-restore", {
        petname: "second-restore",
        binding: rcBinding,
        handle: rcKitHandle,
        kind: "bucket",
        deviceName: "a device that must not exist",
      });
      const refusal = String(second.attempt.error?.message ?? "");

      // The origin device catches up through the ordinary pull path.
      const pulled = await probe(page, "rc-pull-now", { id: rcDevice });
      const kits = await probe(page, "rc-kits", { id: rcDevice });

      const ok = bundleGone && kpGone && removed.length === 2 &&
        second.attempt.refused === true &&
        /no recovery kit at this name/i.test(refusal) &&
        second.attempt.error?.isWit === true &&
        pulled.usPulled >= 1 &&
        kits.attempt.ok === true && kits.kits.length === 0;
      record(
        "56 recovery",
        "the kit is single-use: artifacts gone, a second restore refused, the account's list empty",
        ok,
        `between the ceremony and the end of the restore the store LOST exactly ` +
          `${removed.length} object(s): the \`recovery/\` bundle (${bundleGone}) and one ` +
          `unprefixed object, the K_p pickup (${kpGone}). Nothing else was removed — a restore ` +
          `writes as well as reads, so the claim is about removals. A SECOND restore with the ` +
          `same kit was refused (isWit=${second.attempt.error?.isWit}) with ` +
          `${j(refusal.slice(0, 90))} — the same refusal a WRONG phrase gets, deliberately: the ` +
          `kit's absence is the only fact either case establishes, and a double restore would ` +
          `be an identity fork of one account (two live instances clobbering each other's keyed ` +
          `oplog/manifest names, which SYNC.md's single-writer-per-name invariant forbids). The ` +
          `ORIGIN device then pulled the account document from ${pulled.usPulled} of ` +
          `${pulled.siblings} sibling(s) and its kit list is now ${j(kits.kits)} — empty, ` +
          `learned through the ordinary account pull path rather than announced out of band.`,
      );
    });

    // --- 57: the two refusals, one per kit kind -----------------------------
    //
    // A WRONG PHRASE derives a different name and finds nothing: "the
    // refusal is 'no recovery kit at this name', never a partial
    // restore" (engine.wit). A WRONG FILE PASSPHRASE is a clean keyslot
    // miss — "unlock failed", indistinguishable from any other, which is
    // the point: a slot that told you WHICH slot missed would be an
    // oracle.
    //
    // The file kit minted here is revoked at the end of the row rather
    // than left standing, so the account goes back to holding no kits —
    // and the revocation is the leaked-kit answer exercised in passing
    // ("a leaked phrase or file is answered by revoking the kit device,
    // because it IS the same thing").
    await guard(async () => {
      const wrong = await probe(page, "rc-restore", {
        petname: "wrong-phrase",
        binding: rcBinding,
        handle: rcKitHandle,
        kind: "bucket",
        wrongPhrase: WRONG_PHRASE,
        deviceName: "a device that must not exist",
      });
      const wrongMsg = String(wrong.attempt.error?.message ?? "");

      const fileKit = await probe(page, "rc-kit-create", {
        id: rcDevice,
        spec: { kind: "file", label: "downloaded file kit", passphrase: FILE_PASS },
      });
      const badPass = fileKit.attempt.ok
        ? await probe(page, "rc-restore", {
          petname: "wrong-passphrase",
          binding: rcBinding,
          handle: fileKit.handle,
          kind: "file",
          passphrase: FILE_PASS_WRONG,
          deviceName: "a device that must not exist",
        })
        : { attempt: { refused: false, error: null } };
      const badMsg = String(badPass.attempt.error?.message ?? "");

      const kitsBefore = await probe(page, "rc-kits", { id: rcDevice });
      const revoked = kitsBefore.attempt.ok && kitsBefore.kits.length > 0
        ? await probe(page, "rc-revoke", { id: rcDevice, agentPrefix: kitsBefore.kits[0].agent })
        : { attempt: { ok: false } };
      const kitsAfter = await probe(page, "rc-kits", { id: rcDevice });

      const ok = wrong.attempt.refused === true &&
        /no recovery kit at this name/i.test(wrongMsg) &&
        wrong.attempt.error?.isWit === true &&
        fileKit.attempt.ok === true && fileKit.kind === "file" && fileKit.bytes > 0 &&
        badPass.attempt.refused === true && /unlock failed/i.test(badMsg) &&
        revoked.attempt.ok === true && typeof revoked.attempt.value === "string" &&
        revoked.attempt.value.length > 0 &&
        kitsAfter.attempt.ok === true && kitsAfter.kits.length === 0;
      record(
        "57 recovery",
        "a wrong phrase finds no kit; a wrong file passphrase is one clean keyslot miss",
        ok,
        `a restore attempted with an obviously-synthetic wrong phrase was refused ` +
          `(isWit=${wrong.attempt.error?.isWit}) with ${j(wrongMsg.slice(0, 90))}: a wrong ` +
          `phrase derives a DIFFERENT object name and finds nothing there, so the refusal is ` +
          `an absence and never a partial restore. A FILE kit (${fileKit.bytes} sealed bytes, ` +
          `stored in no bucket — which is why this kind works on every provider) was then ` +
          `opened with the wrong passphrase and refused with ${j(badMsg.slice(0, 90))} — a ` +
          `clean keyslot miss, indistinguishable from any other, because a slot that named ` +
          `which one missed would be an oracle. The file kit was then REVOKED, the leaked-kit ` +
          `answer: the call returned the guarantee note the UI renders ` +
          `(${j(String(revoked.attempt.value ?? "").slice(0, 80))}) and the account's list is ` +
          `back to ${j(kitsAfter.kits)}.`,
      );
    });

    // --- 58: a consume that fails announces and retries — it never blocks ---
    //
    // RECOVERY.md: "Consume failures (unreachable bucket at the end of a
    // restore) never block the restore: they announce and retry on the
    // flush cadence's backoff loop." engine.wit says why the retry is
    // safe: `recovery-consume` is IDEMPOTENT BY CONTRACT, absence is
    // success.
    //
    // THE OUTAGE IS DELETE-ONLY, injected into the object store, and
    // that shape is chosen rather than convenient: a restore reads and
    // writes but deletes nothing, so refusing DELETEs leaves the whole
    // restore working and breaks only its tail — which is exactly the
    // condition the rule is about. A blanket outage would have failed
    // the restore itself and proved nothing about the tail.
    //
    // "ANNOUNCE-SHAPED" IS ASSERTED, not asserted-about: the failure
    // lands on the SCHEDULER'S OWN surface — `flushFailures` climbing
    // toward the announce-after-three threshold (SYNC.md §3, row 49's
    // claim) and a sentence in `lastError` — plus the one thing a count
    // cannot say, `consumePending`, so a sheet can name what is
    // outstanding instead of reporting a generic stall.
    await guard(async () => {
      const kit = await probe(page, "rc-kit-create", {
        id: rcDevice,
        spec: { kind: "bucket", label: "a kit whose consume will fail" },
      });
      await probe(page, "rc-flush-now", { id: rcDevice });

      // THE OUTAGE. `Infinity` rather than a count: the row heals it
      // explicitly, and a count would make the number of deletes one
      // consume happens to make into a load-bearing constant.
      objects.refuseNextDeletes(Infinity);
      const restored = await probe(page, "rc-restore", {
        petname: "restored-under-outage",
        binding: rcBinding,
        handle: kit.handle,
        kind: "bucket",
        deviceName: "a device whose kit outlived its restore",
      });
      const id = restored.id as string;
      const atReturn = restored.status.sync;
      const items = restored.attempt.refused ? { n: 0 } : await probe(page, "hc-items", { id });

      // The retry is on the flush direction's backoff (base 5 s, ×2,
      // jittered ×0.5–1.5), so a second failure lands within ~15 s of
      // the first; 60 s is margin.
      const failing = await untilSync(
        page,
        id,
        "the consume retry failing a second time",
        (s) => s.flushFailures >= 2 && s.consumePending === true,
        60_000,
      );
      const sentence = String(failing.sync?.lastError ?? "");

      // AND THE STORE COMES BACK.
      objects.refuseNextDeletes(0);
      const healed = await untilSync(
        page,
        id,
        "the consume succeeding on a retry",
        (s) => s.consumePending === false && s.flushFailures === 0,
        90_000,
      );
      await probe(page, "hc-close", { id });

      const ok = kit.attempt.ok === true && restored.attempt.refused === false &&
        restored.status.sealed === false && items.n === 3 &&
        atReturn !== null && atReturn.consumePending === true &&
        failing.ok && sentence.length > 0 && /\s/.test(sentence) &&
        healed.ok && healed.sync.consumePending === false;
      record(
        "58 recovery",
        "a consume that cannot reach the store announces and retries; the restore itself stands",
        ok,
        `a fresh kit was minted and the store was put into a DELETE-ONLY outage — a restore ` +
          `reads and writes but deletes nothing, so this breaks the ceremony's TAIL and nothing ` +
          `else. The restore SUCCEEDED anyway (refused=${restored.attempt.refused}, ` +
          `${items.n} todos in hand) and at the instant it returned status().sync=${j(atReturn)}: ` +
          `consumePending TRUE, which is the one thing a failure count cannot say — WHAT is ` +
          `outstanding, so a sheet can name the kit instead of reporting a generic stall. The ` +
          `retry then ran on the flush direction's own backoff: ${failing.waitedMs} ms later ` +
          `flushFailures=${failing.sync?.flushFailures} (climbing toward the announce-after-three ` +
          `threshold SYNC.md §3 sets, and row 49 measures) with the sentence ` +
          `${j(sentence.slice(0, 100))} — prose, no object name, no material. The store was then ` +
          `healed and left alone: ${healed.waitedMs} ms later sync=${j(healed.sync)} — the kit ` +
          `was retired by a RETRY, which is only safe because absence is success by contract ` +
          `(engine.wit: "a retry after partial success must not error on an object that is ` +
          `already gone").`,
      );
    });

    // --- 59: a FILE kit end to end against the fake Drive ------------------
    //
    // THE PROVIDER HALF OF THE DESIGN, executable. Bucket kits are
    // S3-ONLY at this rev (the kind needs an owner-tier PUT at a name
    // the guest DERIVES, and only S3 addresses objects by name), so the
    // promise that "no provider loses recovery coverage" rests entirely
    // on the FILE kit — which stores no object and therefore works
    // anywhere. This row is that promise, run.
    //
    // IT IS ALSO THE `recovery-consume` GDRIVE ARM'S PROMISED COVERAGE.
    // The engine's own battery runs against MinIO, so its S3 arm is the
    // one `just recover` exercises; recovery.rs's `delete_own_pickup`
    // names these devstore rows as where the Drive arm gets its
    // executable coverage instead of duplicating a fake Drive inside the
    // native rig for one delete.
    //
    // THE CREDENTIALS DO NOT RIDE THE BUNDLE, and the two-stage ceremony
    // is that rule made structural: the restoring device runs its OWN
    // consent (`restorePrepare` opens the namespace so the consent has
    // somewhere sealed to land) before the restore validates a binding
    // against it. An OAuth token is device-scoped by DRIVE.md's ruling
    // and there is nowhere in a bundle to put one.
    const RC_GD_ROOT = "pm-recovery-gd";
    // Row 60 rides this pair; see the note there for why it must be a
    // pair that has crossed no revocation epoch.
    let rcGdOrigin = "";
    let rcGdRestored = "";
    const rcGdBinding = {
      kind: "gdrive" as const,
      root: RC_GD_ROOT,
      apiBase: gdOrigin,
      clientId: GD_CLIENT_ID,
      space: "drive" as const,
    };
    await guard(async () => {
      const made = await probe(page, "hc-make", {
        petname: "recovery-gdrive",
        policy: "until-reseal",
        promote: true,
      });
      const originId = made.id as string;
      rcGdOrigin = originId;
      await probe(page, "hc-open", {
        id: originId,
        unseal: { passphrase: PASS, untilReseal: true },
      });
      const consent = await startAndFetchAuth(page, originId, gdriveSpec);
      await probe(page, "gd-oauth-complete", {
        id: originId,
        code: consent.code,
        state: consent.state,
      });
      const bound = await probe(page, "hc-bind", { id: originId, binding: rcGdBinding });
      await probe(page, "hc-ensure-bucket", { id: originId });
      await probe(page, "rc-account-create", {
        id: originId,
        displayName: "Synthetic Drive Account",
      });
      const titles = ["a drive todo", "a second drive todo"];
      await probe(page, "hc-add", { id: originId, titles });
      await probe(page, "rc-flush-now", { id: originId });

      const kit = await probe(page, "rc-kit-create", {
        id: originId,
        spec: { kind: "file", label: "drive file kit", passphrase: FILE_PASS },
      });

      // The restoring device: prepare (DEK), consent (sealed under it),
      // then restore. The consent's code/state are fetched here for the
      // same reason every other gdrive row fetches them here — the page
      // cannot follow the fake's 302 for itself.
      const fresh = await probe(page, "rc-prepare", { petname: "restored-from-file" });
      const freshId = fresh.id as string;
      const consent2 = await startAndFetchAuth(page, freshId, gdriveSpec);
      const restored = await probe(page, "rc-restore", {
        id: freshId,
        petname: "restored-from-file",
        binding: rcGdBinding,
        handle: kit.handle,
        kind: "file",
        passphrase: FILE_PASS,
        deviceName: "the drive machine it became",
        oauth: { code: consent2.code, state: consent2.state },
      });
      const id = restored.id as string;
      rcGdRestored = id;
      const after = restored.attempt.refused
        ? { titles: [], n: 0 }
        : await probe(page, "hc-items", { id });
      const sync = restored.status.sync;
      const devices = restored.attempt.refused
        ? { names: [] }
        : await probe(page, "rc-devices", { id });

      const ok = bound.attempt.refused === false && kit.attempt.ok === true &&
        kit.kind === "file" && kit.bytes > 0 &&
        fresh.attempt.refused === false && fresh.status.sealed === false &&
        restored.attempt.refused === false &&
        restored.status.storage?.kind === "gdrive" &&
        j(after.titles) === j([...titles].sort()) &&
        sync !== null && sync.consumePending === false &&
        devices.names.includes("the drive machine it became");
      record(
        "59 recovery",
        "a FILE kit restores a Drive-bound account end to end, and the consume lands there too",
        ok,
        `a Google-Drive-bound account (its own store root, its own consent) minted a FILE kit of ` +
          `${kit.bytes} sealed bytes — no object stored anywhere, which is why this kind works ` +
          `on a provider that cannot address objects by a name the guest derives, and why ` +
          `RECOVERY.md can say no provider loses recovery coverage while bucket kits stay ` +
          `S3-only. A fresh namespace then ran the TWO-STAGE ceremony: restorePrepare opened it ` +
          `(sealed=${fresh.status.sealed}) so the Drive consent had somewhere sealed to land — ` +
          `credentials never ride bundles, and an OAuth grant is device-scoped — and the restore ` +
          `followed with bytes + passphrase + destination. It came up bound ` +
          `(${j(restored.status.storage?.kind)}) holding ${j(after.titles)}, and its devices ` +
          `entry reads ${j(devices.names)}. THE CONSUME SUCCEEDED ON DRIVE: ` +
          `sync.consumePending=${sync?.consumePending} — this is the executable coverage ` +
          `recovery.rs's \`delete_own_pickup\` promises for the gdrive arm, which the engine's ` +
          `MinIO-only battery cannot reach.`,
      );
    });

    // --- 60: the us-doc rides the cycle, with no button anywhere -----------
    //
    // RECOVERY.md unparks what SYNC.md §3 explicitly parked: "the worker's
    // flush/pull cycle MUST include [the us-doc] — the engine flushes the
    // us-doc only at the moments it controls (kit create, revoke,
    // consume), and a restore can only be as fresh as the last us flush."
    //
    // The claim is therefore about the SCHEDULER and not about a
    // ceremony, so nothing in this row presses anything. Device A
    // changes its PROFILE — a us-doc write, and one that is not in
    // rpc.ts's READONLY_METHODS, so it arms the same 20 s flush debounce
    // a todo does — and then two waits: A's own `lastFlush` moving, and
    // B (a sibling with NO wire between them, only the bucket) reporting
    // the change through the ordinary surfaces.
    //
    // B'S WITNESS IS THE EVENT QUEUE, which is the honest one: `usEvents`
    // is where a visor's announcements come from, and local-echo
    // suppression is engine-side, so `profile-changed` arriving there
    // means B learned it from somewhere other than itself.
    //
    // THE PAIR IS ROW 59'S, and the choice is a FINDING rather than a
    // convenience. Rows 56-58 put the S3 account through a
    // `recovery-kit-revoke`, which rotates the us-doc's NAME-KEY EPOCH
    // (that is the "hard forward" half of the guarantee note), and a
    // sibling that has not yet caught up derives object names from the
    // chain it holds — which it can only refresh by reading the us-doc,
    // whose newest objects now sit under the NEW epoch's names. Measured
    // here: after that revocation the restored device kept reading the
    // origin's stale epoch-0 manifest and never saw the profile change.
    // That is a pre-existing property of rotation-plus-a-lagging-device
    // (SYNC.md's territory, not this round's), and pinning this row to a
    // pair that has crossed no revocation keeps it a measurement of the
    // us-doc riding the cycle rather than of that separate question.
    // Flagged in the track report.
    await guard(async () => {
      const idA = rcGdOrigin;
      const idB = rcGdRestored;
      const NEW_NAME = "Renamed On The Other Device";
      const beforeA = (await probe(page, "hc-status", { id: idA })).sync;
      // Drain B's queue first, so anything the row observes afterwards
      // is this row's own change and not an older one.
      await probe(page, "rc-events", { id: idB });

      const set = await probe(page, "rc-profile-set", { id: idA, displayName: NEW_NAME });
      const flushedA = await untilSync(
        page,
        idA,
        "A's scheduled flush after a us-doc write",
        (s) => s.lastFlush !== null && (beforeA?.lastFlush === null || s.lastFlush > beforeA.lastFlush),
        60_000,
      );
      // B pulls on the ordinary 45 s cadence; the us-doc goes FIRST in
      // its cycle, which is what makes the profile arrive at all.
      const deadline = Date.now() + 120_000;
      let profileB = { displayName: "" };
      let kindsB: string[] = [];
      while (Date.now() < deadline) {
        profileB = await probe(page, "rc-profile-get", { id: idB });
        const ev = await probe(page, "rc-events", { id: idB });
        kindsB = [...kindsB, ...ev.kinds];
        if (profileB.displayName === NEW_NAME) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }
      const syncB = (await probe(page, "hc-status", { id: idB })).sync;

      const ok = set.attempt.refused === false && flushedA.ok &&
        flushedA.sync.flushFailures === 0 &&
        profileB.displayName === NEW_NAME &&
        kindsB.includes("profile-changed") &&
        syncB !== null && syncB.lastPull !== null;
      record(
        "60 recovery",
        "the account document rides the ordinary flush/pull cycle — SYNC.md's parked item, unparked",
        ok,
        `device A changed its account PROFILE and NOTHING ELSE was called. A us-doc write is a ` +
          `mutation like any other (it is absent from rpc.ts's READONLY_METHODS), so it armed ` +
          `the same ~20 s flush debounce a todo does: ${flushedA.waitedMs} ms later A's ` +
          `status().sync=${j(flushedA.sync)} — a completed scheduled cycle, which now includes ` +
          `the account document under the EMPTY doc-id sentinel (engine.wit's bucket-flush; the ` +
          `us id itself stays hidden and an empty id was meaningless on every arm before this). ` +
          `Device B — a SIBLING with no wire of any kind between them, only the shared bucket — ` +
          `then pulled on its ordinary 45 s cadence, where the us-doc goes FIRST so the content ` +
          `pulls chain off the map it brings in. B's profile now reads ${j(profileB.displayName)} ` +
          `and its event queue carried ${j(kindsB)}: \`profile-changed\` arrived through the ` +
          `ORDINARY announcement surface, and local-echo suppression is engine-side, so B could ` +
          `only have learned it from A. B's own sync record: ${j(syncB)}.`,
      );
      await probe(page, "hc-close", { id: idA });
      await probe(page, "hc-close", { id: idB });
      await probe(page, "hc-close", { id: rcDevice });
      await probe(page, "hc-close", { id: rcRestored });
    });

    await ctx.close();
  } finally {
    await browser.close();
    await server.shutdown();
    await s3Server.shutdown();
    await objects.server.shutdown();
    await fake.close();
  }


  console.log(`\n=== DEVICE STORE MATRIX ===`);
  for (const r of rows) console.log(`${r.n.padEnd(16)} ${r.verdict.padEnd(6)} ${r.title}`);
  console.log(failures === 0 ? "\nALL REQUIRED ROWS PASS" : `\n${failures} REQUIRED ROW(S) FAILED`);
  await Deno.writeTextFile(`${here}last-run.json`, JSON.stringify(rows, null, 2));
  Deno.exit(failures === 0 ? 0 : 1);
}

await main();
