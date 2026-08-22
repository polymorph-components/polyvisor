// THE MATRIX RUNNER: Playwright driving a real headless Chromium over
// the built spike site, one act per question, a verdict per row.
//
//   just run              (builds first)
//   deno run -A run.ts    (needs `just build` to have run)
//
// Same shape as demo/e2e/run.ts — Playwright as a LIBRARY from Deno, an
// ephemeral-port static server the harness owns, an ephemeral-port relay
// for the bonus row, and a non-zero exit if a row that must pass didn't.
//
// PORT DISCIPLINE: every listener binds port 0 and the port is read back;
// nothing here hard-codes a port, so parallel worktrees cannot silently
// probe each other's build. The relay is killed by PID.

import { chromium } from "npm:playwright@1.57.0";
import type { Browser, BrowserContext, Page } from "npm:playwright@1.57.0";
import { serveDir } from "jsr:@std/http@1.0.13/file-server";

const here = new URL(".", import.meta.url).pathname;
const SERVE = `${here}serve`;
const RELAY_BIN = `${here}../../engine/.deps/relay/bin/iroh-relay`;

type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "INFO";
interface Row {
  q: string;
  title: string;
  verdict: Verdict;
  evidence: string;
}
const rows: Row[] = [];
const record = (q: string, title: string, verdict: Verdict, evidence: string) => {
  rows.push({ q, title, verdict, evidence });
  console.log(`\n[${verdict}] Q${q} ${title}\n        ${evidence.replace(/\n/g, "\n        ")}`);
};

// --- the static server (ephemeral port, read back) --------------------------

function serveSite(): { server: Deno.HttpServer; port: number } {
  let port = 0;
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: (addr) => {
      port = addr.port;
    },
  }, (req) =>
    serveDir(req, {
      fsRoot: SERVE,
      quiet: true,
      headers: [
        // No caching: the reload experiment must re-fetch, and a cached
        // worker script would make "same worker" ambiguous.
        "cache-control: no-store",
      ],
    }));
  return { server, port };
}

// --- the relay (bonus row) --------------------------------------------------

class Relay {
  #proc: Deno.ChildProcess | null = null;
  #dir: string | null = null;
  url = "";

  async start(): Promise<boolean> {
    try {
      await Deno.stat(RELAY_BIN);
    } catch {
      return false;
    }
    // Ephemeral port: bind 0, read it back, close, hand it to the relay
    // (its config wants an address, not a socket).
    const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const port = (l.addr as Deno.NetAddr).port;
    l.close();
    this.url = `http://127.0.0.1:${port}`;
    this.#dir = await Deno.makeTempDir({ prefix: "spike-worker-relay." });
    const cfg = `${this.#dir}/relay.toml`;
    // Same config trick demo/e2e/run.ts:286-296 documents: `--dev` for
    // no-TLS, the port from the config (the CLI has no port flag), and
    // metrics off so a second relay does not fight over :9090.
    await Deno.writeTextFile(
      cfg,
      `http_bind_addr = "127.0.0.1:${port}"\nenable_metrics = false\n`,
    );
    this.#proc = new Deno.Command(RELAY_BIN, {
      args: ["--dev", "--config-path", cfg],
      stdout: "null",
      stderr: "null",
    }).spawn();
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.url}/generate_204`, { signal: AbortSignal.timeout(2000) });
        await r.body?.cancel();
        if (r.status === 204 || r.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async dispose() {
    const p = this.#proc;
    this.#proc = null;
    if (p) {
      // KILL BY PID, never by port/name pattern.
      try {
        p.kill("SIGKILL");
      } catch { /* gone */ }
      await p.status;
    }
    if (this.#dir) await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

// --- page helpers -----------------------------------------------------------

const url = (port: number, q: Record<string, string> = {}) => {
  const u = new URL(`http://127.0.0.1:${port}/probe.html`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

async function openPage(ctx: BrowserContext, port: number, q: Record<string, string> = {}) {
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/error|FAILED|Uncaught/i.test(t)) console.log(`      · console: ${t}`);
  });
  page.on("pageerror", (e) => console.log(`      · pageerror: ${e.message}`));
  await page.goto(url(port, q), { waitUntil: "load" });
  return page;
}

const hello = (page: Page) =>
  page.waitForFunction(() => (globalThis as any).hello !== undefined, undefined, {
    timeout: 30_000,
  }).then(() => page.evaluate(() => (globalThis as any).hello));

const probe = (page: Page, op: string, arg?: unknown, timeout = 180_000) =>
  page.evaluate(
    ([op, arg]) => (globalThis as any).probe(op, arg),
    [op, arg] as const,
    // deno-lint-ignore no-explicit-any
  ) as any as Promise<any>;

// --- the run ----------------------------------------------------------------

async function main() {
  try {
    await Deno.stat(`${SERVE}/engine.plan.json`);
  } catch {
    console.error(`no built site at ${SERVE} — run \`just build\` first`);
    Deno.exit(2);
  }

  const { server, port } = serveSite();
  await new Promise((r) => setTimeout(r, 50));
  console.log(`site: http://127.0.0.1:${port}/probe.html`);

  const relay = new Relay();
  const relayUp = await relay.start();
  console.log(relayUp ? `relay: ${relay.url}` : "relay: unavailable (bonus row will be SKIPPED)");

  const browser: Browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  let failures = 0;
  try {
    const ctx = await browser.newContext();
    const page = await openPage(ctx, port, relayUp ? { relay: relay.url } : {});
    const h = await hello(page);
    console.log(`worker hello: ${JSON.stringify(h)}`);
    record(
      "0",
      "module SharedWorker accepted, JSPI present in the worker",
      h && h.jspi ? "PASS" : "FAIL",
      `scope=${h?.scope} jspi=${h?.jspi} opfs=${h?.hasOpfs} locks=${h?.hasLocks} ` +
        `nonce=${String(h?.instanceNonce).slice(0, 8)} bootSeq=${h?.bootSeq}`,
    );

    // --- Q1: the engine composite in the worker ---------------------------
    try {
      const r = await probe(page, "engine");
      record(
        "1",
        "engine composite instantiated and driven inside the SharedWorker",
        r.ok ? "PASS" : "FAIL",
        `${r.steps.join(" | ")}\nitems=${JSON.stringify(r.items)}`,
      );
      if (!r.ok) failures++;
    } catch (e) {
      failures++;
      record("1", "engine composite in the SharedWorker", "FAIL", String(e).slice(0, 900));
    }

    // --- Q2: OPFS through the polyengine wasi filesystem ------------------
    try {
      const r = await probe(page, "opfs");
      record(
        "2",
        "OPFS preopen + wasi filesystem round-trip from the SharedWorker",
        r.ok ? "PASS" : "FAIL",
        `preopen=${r.guestName} file=${r.path} readBack===wrote: ${r.ok}\n` +
          `createSyncAccessHandle here: ${r.syncHandle}`,
      );
      if (!r.ok) failures++;
    } catch (e) {
      failures++;
      record("2", "OPFS from the SharedWorker", "FAIL", String(e).slice(0, 900));
    }

    // --- Q3 (part 1): mint the key ---------------------------------------
    let keyBefore: any = null;
    try {
      keyBefore = await probe(page, "key");
      console.log(`      · key minted=${keyBefore.minted} pub=${keyBefore.publicKey.slice(0, 16)}…`);
    } catch (e) {
      failures++;
      record("3", "WebCrypto identity in the worker", "FAIL", `mint: ${String(e).slice(0, 900)}`);
    }

    // --- Q5: the lock, observed from the page -----------------------------
    let lockClientId = "";
    try {
      const l = await probe(page, "lock");
      const q = await page.evaluate(() => (globalThis as any).locksQuery());
      const seen = (q.held ?? []).find((x: any) => x.name === "spike-worker-host-device");
      lockClientId = seen?.clientId ?? "";
      record(
        "5",
        "Web Lock held inside the worker, visible to the page",
        l.held && seen ? "PASS" : "FAIL",
        `worker: held=${l.held} err=${l.error}; page navigator.locks.query() sees ` +
          `${JSON.stringify(seen ?? null)}`,
      );
      if (!(l.held && seen)) failures++;
    } catch (e) {
      failures++;
      record("5", "Web Lock from the worker", "FAIL", String(e).slice(0, 900));
    }

    // --- Q7 (bonus): iroh bind from the worker ----------------------------
    if (!relayUp) {
      record("7", "iroh bind over WebSocket from the worker", "SKIPPED", "no relay binary");
    } else {
      try {
        const r = await probe(page, "relay", relay.url, 120_000);
        record(
          "7",
          "iroh bind over WebSocket from the worker",
          "PASS",
          `driver.irohBind(${r.relayUrl}) → endpoint ${r.endpoint}`,
        );
      } catch (e) {
        record(
          "7",
          "iroh bind over WebSocket from the worker",
          "FAIL",
          String(e).slice(0, 900),
        );
        // Bonus row: recorded, not counted against the run.
      }
    }

    // --- Q4: does the worker survive a reload? ----------------------------
    //
    // Five reloads of the SAME tab, with the tab never closed. The worker
    // has a client throughout except for the instant of navigation, which
    // is exactly the window in which Chromium may decide to collect it.
    const seq: Array<{ reload: number; nonce: string; bootSeq: number; uptimeMs: number }> = [];
    const h0 = await hello(page);
    seq.push({ reload: 0, nonce: h0.instanceNonce, bootSeq: h0.bootSeq, uptimeMs: h0.uptimeMs });
    for (let i = 1; i <= 5; i++) {
      await page.reload({ waitUntil: "load" });
      const hi = await hello(page);
      seq.push({ reload: i, nonce: hi.instanceNonce, bootSeq: hi.bootSeq, uptimeMs: hi.uptimeMs });
    }
    const stable = seq.every((s) => s.nonce === seq[0].nonce);
    record(
      "4",
      "SharedWorker lifetime across 5 single-tab reloads",
      "INFO",
      (stable
        ? "SAME worker instance survived all 5 reloads (nonce and bootSeq stable) — " +
          "worker memory is continuous across a reload"
        : "worker RESPAWNED during reloads — worker memory is NOT continuous") +
        `\n${seq.map((s) => `#${s.reload} boot=${s.bootSeq} up=${s.uptimeMs}ms ${s.nonce.slice(0, 8)}`).join(" | ")}`,
    );

    // --- Q4b: the same reload, with a SECOND TAB holding the worker ------
    //
    // DISCRIMINATOR for the Q4 result. If the respawn above were caused by
    // the script re-fetch (the harness serves `cache-control: no-store`),
    // a second attached client would make no difference. If it is caused
    // by the ZERO-CLIENT WINDOW between the old document detaching and the
    // new one attaching, a second tab closes that window and the worker
    // survives. Whichever way this goes, it names the mechanism.
    const holder = await openPage(ctx, port);
    const hHold = await hello(holder);
    await page.reload({ waitUntil: "load" });
    const hAfter = await hello(page);
    const survived = hAfter.instanceNonce === hHold.instanceNonce;
    record(
      "4b",
      "reload of one tab while a SECOND tab holds the worker",
      "INFO",
      survived
        ? `SAME worker survived (nonce ${String(hHold.instanceNonce).slice(0, 8)}, ` +
          `bootSeq ${hHold.bootSeq}→${hAfter.bootSeq}) — the Q4 respawn is the ` +
          `zero-client window at navigation, not the script re-fetch`
        : `worker respawned EVEN WITH a second client attached ` +
          `(${String(hHold.instanceNonce).slice(0, 8)}→${String(hAfter.instanceNonce).slice(0, 8)}, ` +
          `bootSeq ${hHold.bootSeq}→${hAfter.bootSeq})`,
    );
    await holder.close();

    // --- Q4c: does `extendedLifetime: true` change the reload verdict? ---
    //
    // The candidate FIX for Q4, tested rather than assumed: the option is
    // specified as "keep the worker alive after all clients unload"
    // (chromestatus 5138641357373440, Chrome 148 desktop/android/webview),
    // and the Q4b result says the respawn is caused by precisely that
    // window. Its own worker name, so it is its own worker instance.
    const extPage = await openPage(ctx, port, { extended: "1" });
    const e0 = await hello(extPage);
    const eseq = [e0];
    for (let i = 1; i <= 5; i++) {
      await extPage.reload({ waitUntil: "load" });
      eseq.push(await hello(extPage));
    }
    const extStable = eseq.every((s) => s.instanceNonce === eseq[0].instanceNonce);
    const optionRead = await extPage.evaluate(() =>
      (globalThis as any).extendedLifetimeRead
    );
    record(
      "4c",
      "the same 5 reloads with `extendedLifetime: true`",
      // NOT a negative result when the option was never read: this
      // Chromium simply predates it, so the row is BLOCKED rather than
      // "extendedLifetime does not help".
      optionRead ? "INFO" : "BLOCKED",
      (!optionRead
        ? "UNTESTABLE HERE: this Chromium never read the option, so the " +
          "reload behaviour below is just the plain Q4 result again"
        : extStable
        ? "SAME worker instance survived all 5 reloads — extendedLifetime GIVES " +
          "reload continuity of worker memory"
        : "worker STILL respawned with extendedLifetime: true") +
        `\nChromium ${browser.version()}; the constructor READ the ` +
        `extendedLifetime member: ${optionRead} (a getter on the options ` +
        `dictionary — an unsupported option would never be read)` +
        `\nworker=${e0.workerName} ` +
        eseq.map((s, i) => `#${i} boot=${s.bootSeq} ${String(s.instanceNonce).slice(0, 8)}`).join(" | "),
    );
    await extPage.close();

    // --- Q3 (part 2) + Q5 (release): kill the worker ----------------------
    //
    // A SharedWorker dies when its last client goes. Closing the whole
    // CONTEXT is the bluntest available "worker restart" and is what the
    // key-persistence claim needs.
    await ctx.close();
    await new Promise((r) => setTimeout(r, 1500));

    // Key persistence needs ONE storage partition either side of the
    // restart, and a Playwright browser context is a fresh partition —
    // so the restart claim runs in a PERSISTENT context, where closing
    // every page kills the worker but leaves IndexedDB on disk.
    const profile = await Deno.makeTempDir({ prefix: "spike-worker-profile." });
    const pctx = await chromium.launchPersistentContext(profile, {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const p1 = await openPage(pctx as unknown as BrowserContext, port);
      const ph1 = await hello(p1);
      const k1 = await probe(p1, "key");
      const l1 = await probe(p1, "lock");
      await p1.close();
      await new Promise((r) => setTimeout(r, 1500));

      // THE RELEASE, OBSERVED DIRECTLY: a page that does not construct
      // the worker at all (`?noworker=1`), so nothing re-acquires the
      // lock before the question is asked.
      const observer = await openPage(pctx as unknown as BrowserContext, port, {
        noworker: "1",
      });
      const gap = await observer.evaluate(() => (globalThis as any).locksQuery());
      const stillHeld = (gap.held ?? []).some((x: any) =>
        x.name === "spike-worker-host-device"
      );
      await observer.close();
      await new Promise((r) => setTimeout(r, 500));

      const p2 = await openPage(pctx as unknown as BrowserContext, port);
      const ph2 = await hello(p2);
      const k2 = await probe(p2, "key");
      const restarted = ph2.instanceNonce !== ph1.instanceNonce;
      const same = k1.publicKey === k2.publicKey;
      const ok = restarted && same && k2.minted === false && k2.extractable === false && k2.verified;
      record(
        "3",
        "non-extractable Ed25519 pair in IndexedDB, across a worker restart",
        ok ? "PASS" : "FAIL",
        `worker restarted: ${restarted} (boot ${ph1.bootSeq}→${ph2.bootSeq}); ` +
          `same public key: ${same}; after restart minted=${k2.minted} ` +
          `extractable=${k2.extractable} exportRefused=${k2.exportRefused} ` +
          `sign+verify=${k2.verified} (${k2.signatureLen}-byte signature)`,
      );
      if (!ok) failures++;

      // Lock release: the old worker is gone, so its lock must be too —
      // the new worker holds a lock with a DIFFERENT clientId.
      const lq = await p2.evaluate(() => (globalThis as any).locksQuery());
      const held = (lq.held ?? []).find((x: any) => x.name === "spike-worker-host-device");
      record(
        "5b",
        "the worker's lock is released when the worker dies",
        !stillHeld && held ? "PASS" : "FAIL",
        `with NO worker alive, a ?noworker=1 page sees the lock held: ${stillHeld} ` +
          `(query: ${JSON.stringify(gap)}); the first worker's grant was ` +
          `${JSON.stringify(l1)}; a later page respawns the worker and the lock ` +
          `is held again, by a NEW client: ${JSON.stringify(held ?? null)}`,
      );
      if (stillHeld || !held) failures++;
      await p2.close();
    } finally {
      await pctx.close();
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    }
  } finally {
    await browser.close();
    await relay.dispose();
    await server.shutdown();
  }

  console.log(`\n=== MATRIX ===`);
  for (const r of rows) {
    console.log(`Q${r.q.padEnd(3)} ${r.verdict.padEnd(8)} ${r.title}`);
  }
  console.log(failures === 0 ? "\nALL REQUIRED ROWS PASS" : `\n${failures} REQUIRED ROW(S) FAILED`);
  await Deno.writeTextFile(`${here}last-run.json`, JSON.stringify(rows, null, 2));
  Deno.exit(failures === 0 ? 0 : 1);
}

await main();
