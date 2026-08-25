// SELF-TEST: the harness's own fault-injection machinery, tested
// against ITSELF rather than the demo. Every partition scenario that
// follows depends on `ctx.relayProxy()` and `ctx.stopRelay()`/
// `ctx.startRelay()` doing exactly what their names claim; a bug here
// would otherwise surface as a mysterious failure deep inside whichever
// partition scenario used the broken primitive first, several minutes
// and a full engine boot later.
//
// No engine boot is needed at all — every act below talks to the proxy
// or the relay directly with a plain `fetch`, never through a page —
// so `page: { noWait: true }` skips `waitForBoot` and the whole
// scenario runs in a few seconds.

import type { Scenario } from "../run.ts";
import { act, assert } from "../util.ts";

/** A short, bounded probe against `/generate_204` — the relay's own
 * net-report endpoint (see run.ts's `Relay` class), which is also what
 * both `Relay.stop()` and this scenario use to tell "answering" from
 * "refusing" from "hanging". */
async function probe204(
  url: string,
  timeoutMs: number,
): Promise<"answered" | "refused" | "timedOut"> {
  try {
    const r = await fetch(`${url}/generate_204`, { signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return "answered";
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") return "timedOut";
    return "refused";
  }
}

/** The same `/generate_204` probe, but over a CALLER-HELD raw TCP
 * connection rather than a fresh `fetch()` — the only way to ask "is
 * THIS SPECIFIC connection still alive" rather than "can a new one be
 * made". `fetch()` picks its own connection (and Deno's fetch may not
 * even reuse one across calls), so proving that a connection which
 * lived through blackhole()/restore() does not resume needs the raw
 * socket in the caller's hand, written to and read from directly.
 *
 * Three outcomes, matching `probe204`'s vocabulary where they overlap:
 *   - "answered": a well-formed `204 No Content` came back.
 *   - "dead": the write threw, the read threw, or the read returned
 *     EOF (`null`) — the connection is gone, by any of the shapes a
 *     closed TCP socket can present.
 *   - "timedOut": neither of the above within `timeoutMs` — the
 *     connection is neither answering nor visibly closed (the
 *     blackhole shape, if this were probed mid-blackhole rather than
 *     after restore()). */
async function rawRoundTrip(
  conn: Deno.Conn,
  timeoutMs: number,
): Promise<"answered" | "dead" | "timedOut"> {
  try {
    await conn.write(
      new TextEncoder().encode(
        "GET /generate_204 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
      ),
    );
  } catch {
    return "dead";
  }
  const buf = new Uint8Array(4096);
  const TIMEOUT = Symbol("timeout");
  let n: number | null | typeof TIMEOUT;
  try {
    n = await Promise.race([
      conn.read(buf),
      new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), timeoutMs)),
    ]);
  } catch {
    return "dead";
  }
  if (n === TIMEOUT) return "timedOut";
  if (n === null) return "dead"; // EOF: the peer (the proxy) closed its end.
  const text = new TextDecoder().decode(buf.subarray(0, n));
  return /^HTTP\/1\.[01] 204\b/.test(text) ? "answered" : "dead";
}

const scenario: Scenario = {
  name: "harness-faults",
  why: "the fault-injection primitives (severable proxy, relay stop/start) actually do what they claim",
  page: { noWait: true },

  async run(_page, ctx) {
    await act("a relay proxy FORWARDS to the real relay", async () => {
      const proxy = await ctx.relayProxy();
      const outcome = await probe204(proxy.url, 3_000);
      assert(outcome === "answered", `expected the proxy to forward; got ${outcome}`);
    });

    await act("sever() cuts a proxy: the peer sees refusal, not a hang", async () => {
      const proxy = await ctx.relayProxy();
      // Prove it forwards first, so a refusal below is provably CAUSED
      // by sever() rather than the proxy having never worked at all.
      assert(
        (await probe204(proxy.url, 3_000)) === "answered",
        "the proxy did not forward before sever()",
      );
      proxy.sever();
      const outcome = await probe204(proxy.url, 3_000);
      assert(outcome === "refused", `expected sever() to refuse; got ${outcome}`);
    });

    await act("blackhole() hangs a proxy: the peer sees a timeout, not a refusal", async () => {
      const proxy = await ctx.relayProxy();
      proxy.blackhole();
      // A SHORT deadline: blackhole's whole claim is "answers nothing",
      // so a probe that outlasted a generous timeout would still only
      // prove "not answered within N seconds" — the short bound is what
      // makes the act itself fast rather than what makes the claim true.
      const outcome = await probe204(proxy.url, 1_500);
      assert(outcome === "timedOut", `expected blackhole() to hang; got ${outcome}`);
      await proxy.close();
    });

    await act("restore() heals a proxy for new connections", async () => {
      const proxy = await ctx.relayProxy();
      proxy.sever();
      assert(
        (await probe204(proxy.url, 3_000)) === "refused",
        "the proxy did not refuse after sever()",
      );
      proxy.restore();
      const outcome = await probe204(proxy.url, 3_000);
      assert(outcome === "answered", `expected restore() to heal new connections; got ${outcome}`);
    });

    await act(
      "a connection established BEFORE blackhole() does not resume after restore() — a fresh one does",
      async () => {
        // THE CLAIM this act pins (proxy.ts's file banner, and the
        // interface doc on `restore()`): "connections that lived
        // through sever()/blackhole() do NOT come back". A held
        // connection is the only way to ask that question — a `fetch`
        // per round trip proves nothing about any ONE connection's
        // fate, because it is free to open a new one every time.
        const proxy = await ctx.relayProxy();
        const held = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
        try {
          // Prove the held connection is real and answering BEFORE
          // blackhole() — a refusal below must be caused by
          // blackhole()+restore(), not by a connection that never
          // worked, or that was merely a one-shot (no keep-alive).
          const before = await rawRoundTrip(held, 3_000);
          assert(before === "answered", `expected the held connection's first round trip to answer; got ${before}`);

          proxy.blackhole();
          proxy.restore();

          // THE MONEY ASSERTION: the SAME socket, after the mode went
          // blackhole-then-forward with NO traffic sent in between (an
          // idle keep-alive connection — the case the bug fix added,
          // since nothing was ever dropped ON it to trip the older
          // drop-only taint). It must be dead, not quietly forwarding
          // again on framing state nobody can vouch for.
          const after = await rawRoundTrip(held, 2_000);
          assert(
            after !== "answered",
            `expected the held connection to be dead after blackhole()+restore(); it answered again (${after})`,
          );

          // AND a FRESH connection through the very same (now-restored)
          // proxy must work — restore() heals NEW connections; it only
          // refuses to resurrect ones that lived through the blackhole
          // window. Without this half, a bug that left the proxy
          // wedged for everyone would also make the assertion above
          // pass for the wrong reason.
          const fresh = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
          try {
            const freshOutcome = await rawRoundTrip(fresh, 3_000);
            assert(
              freshOutcome === "answered",
              `expected a fresh connection to answer after restore(); got ${freshOutcome}`,
            );
          } finally {
            try {
              fresh.close();
            } catch { /* already gone */ }
          }
        } finally {
          try {
            held.close();
          } catch { /* already gone — which, post-restore(), is exactly the claim */ }
        }
      },
    );

    await act("stopRelay() makes the REAL relay refuse, and startRelay() heals it", async () => {
      await ctx.stopRelay();
      const down = await probe204(ctx.relayUrl, 3_000);
      assert(down === "refused", `expected the stopped relay to refuse; got ${down}`);
      await ctx.startRelay();
      const up = await probe204(ctx.relayUrl, 3_000);
      assert(up === "answered", `expected the restarted relay to answer; got ${up}`);
    });
  },
};

export default scenario;
