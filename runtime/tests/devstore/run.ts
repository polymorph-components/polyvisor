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
