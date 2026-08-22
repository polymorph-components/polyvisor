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
import type { Browser, BrowserContext, Page } from "npm:playwright@1.57.0";
import { serveDir } from "jsr:@std/http@1.0.13/file-server";

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
    hostname: "127.0.0.1",
    onListen: (addr) => {
      port = addr.port;
    },
  }, (req) => serveDir(req, { fsRoot: SERVE, quiet: true, headers: ["cache-control: no-store"] }));
  return { server, port };
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

  const browser: Browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log(`chromium ${browser.version()}`);

  try {
    const ctx = await browser.newContext();
    const page = await openPage(ctx, port);

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
      // THE WIT BIT IS THE ASSERTION. A host-side refusal (sealed
      // device, unknown method) is also a DeviceHostError and would have
      // made a looser version of this row green while proving nothing —
      // it did, on the first run of this matrix, because row 16 had
      // resealed the device out from under it.
      const ok = r.constructed && r.adapterOk === false &&
        r.wire !== null && r.wire.isWitError === true &&
        typeof r.wire.witPayload === "string" && r.wire.witPayload.length > 0 &&
        r.adapterUsedPayload;
      record(
        "18 host",
        "runtime/pairing-engine.ts's adapter is constructible over the remote driver, payload and all",
        ok,
        `createEnginePairingDriver(remote.driver) builds a complete PairingDriver ` +
          `(${r.constructed}) with not one line changed — every method it needs moves only ` +
          `structured-clone-safe values (Uint8Array ids, strings, plain records, {kind,value} ` +
          `variants, u64 bigints), so nothing had to be excluded from the proxy. Its error path ` +
          `is the half that could have rotted silently: the adapter reads a WIT err payload out ` +
          `of every rejection via isComponentException(e) then e.payload, and over the port it ` +
          `still gets one — the raw rejection is a ${r.wire?.name} with ` +
          `isWitError=${r.wire?.isWitError} carrying witPayload=${j(r.wire?.witPayload)}, and ` +
          `the adapter's own error string IS that payload rather than a message ` +
          `(${r.adapterUsedPayload}). Module identity does NOT cross a worker boundary; what ` +
          `makes this work is that DeviceHostError mints the ComponentException brand LOCALLY ` +
          `from the envelope's isWitError bit (rpc.ts), never by cloning anything branded — ` +
          `symbols do not clone, and Symbol.for's registry is per-agent.`,
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

    await ctx.close();
  } finally {
    await browser.close();
    await server.shutdown();
  }

  console.log(`\n=== DEVICE STORE MATRIX ===`);
  for (const r of rows) console.log(`${r.n.padEnd(16)} ${r.verdict.padEnd(6)} ${r.title}`);
  console.log(failures === 0 ? "\nALL REQUIRED ROWS PASS" : `\n${failures} REQUIRED ROW(S) FAILED`);
  await Deno.writeTextFile(`${here}last-run.json`, JSON.stringify(rows, null, 2));
  Deno.exit(failures === 0 ? 0 : 1);
}

await main();
