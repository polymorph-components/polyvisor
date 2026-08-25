// A SEVERABLE TCP proxy, for ASYMMETRIC network partitions.
//
// WHY THIS EXISTS RATHER THAN CHROMIUM'S OWN NETWORK EMULATION.
// Playwright's `context.route()` and CDP's `Network.emulateNetworkConditions`
// both operate on HTTP-shaped requests the browser is ABOUT to make; neither
// touches a WebSocket connection that is already established. The demo's
// iroh relay traffic rides exactly one such long-lived WebSocket per
// engine endpoint, opened once at boot and held for the ceremony's whole
// life — so "cut device A's relay path without touching device B's" is not
// a thing the browser's own network layer can do at all. The only honest
// way to sever ONE page's path is a real TCP intermediary that page's own
// `?relay=` URL points at, which this file is.
//
// THREE FAULT SHAPES, and they are deliberately distinct rather than one
// "break it" knob — because the harness has already had to draw this same
// line once, for MinIO (run.ts's `Minio.stop()`): a REFUSED connection and
// a TIMED-OUT one are different claims about the network, and a scenario
// testing "does the visor retry a partition and heal" needs to provoke
// both shapes on purpose.
//   - sever():    RST-shaped — every live connection dies NOW, and any
//                 new connection is refused before this proxy even
//                 accepts it read/write. The peer sees the socket die.
//   - blackhole(): TIMEOUT-shaped — live connections stop being pumped
//                 (no RST, no FIN — the bytes just stop moving) and new
//                 connections are accepted but never forwarded. The peer
//                 sees nothing at all, which is the state a slow/wedged
//                 relay would put it in.
//   - restore():  back to normal for NEW connections. Connections that
//                 lived through sever() or blackhole() do NOT come back —
//                 sever() already destroyed them, and restore() itself
//                 destroys every connection blackhole() found TAINTED
//                 (every connection it was still pumping when the mode
//                 flipped, whether or not any bytes actually got
//                 dropped on it) or PARKED unforwarded (accepted during
//                 blackhole but never given an upstream at all) — see
//                 PUMP LOOP and restore() below. A caller that needs
//                 the same logical connection to keep working across
//                 restore() must have the peer open a new one; that is
//                 the point, not an omission — resuming a connection
//                 that lived through a hang, with or without a byte
//                 actually silently dropped mid-stream, would replay
//                 corrupted or merely unverifiable framing state onto
//                 whatever protocol rides it (a WebSocket most of all).

/** What a scenario gets back from `startTcpProxy`/`ctx.relayProxy()`. */
export interface SeverableProxy {
  /** `http://127.0.0.1:<port>` — hand this to a page as `?relay=`. */
  readonly url: string;
  readonly port: number;
  /** RST-shaped: kill every live connection now, refuse every new one. */
  sever(): void;
  /** TIMEOUT-shaped: stop forwarding on live connections (without
   * closing them) and accept-but-never-forward new ones. */
  blackhole(): void;
  /** Back to normal FORWARDING for new connections. Connections that
   * lived through sever()/blackhole() stay dead/stalled — see the file
   * banner above. */
  restore(): void;
  close(): Promise<void>;
}

type Mode = "forward" | "sever" | "blackhole";

/** One accepted connection this proxy is (or was) pumping. */
interface Conn {
  client: Deno.Conn;
  upstream: Deno.Conn | null;
  /** Set once destroy() has run, so a racing pump iteration does not
   * double-close an already-closed socket (Deno throws on that). */
  dead: boolean;
  /** Set when this connection lived through a blackhole() window while
   * actually pumping — either `blackhole()` itself found it live (the
   * common case: it was already forwarding when the mode flipped) or,
   * for the narrow connect-in-flight race `blackhole()`'s own sweep
   * cannot see, a shovel dropped a chunk on it after the fact. A
   * tainted connection may have had bytes vanish mid-stream, or may
   * simply have gone quiet for a while with no guarantee the other side
   * agrees on where the stream now stands — either way restore()
   * destroys it rather than letting it resume forwarding on state
   * nobody can vouch for. See the file banner. Never cleared: taint is
   * a one-way fact about this connection's history, not its current
   * mode. */
  tainted: boolean;
}

export async function startTcpProxy(targetPort: number): Promise<SeverableProxy> {
  // Port 0: EPHEMERAL, always — a hand-picked port collides with a
  // sibling worktree running this same suite (see the global shell
  // note this repo's scenarios already follow for MinIO/the relay).
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const state: { mode: Mode } = { mode: "forward" };
  const live = new Set<Conn>();

  const destroy = (c: Conn) => {
    if (c.dead) return;
    c.dead = true;
    live.delete(c);
    try {
      c.client.close();
    } catch { /* already gone */ }
    if (c.upstream) {
      try {
        c.upstream.close();
      } catch { /* already gone */ }
    }
  };

  // PUMP LOOP. A MANUAL byte-shovel, not `readable.pipeTo(writable)` —
  // `pipeTo` locks the streams into an uninterruptible pipe with no
  // hook to stop mid-flight, and `blackhole()`'s whole claim is that a
  // connection ALREADY BEING PUMPED goes silent without being closed.
  // So each direction re-checks `mode` before every write: once
  // blackholed, a chunk already read from one side is simply dropped
  // rather than written to the other — the bytes vanish, the sockets
  // stay open, nothing answers. Errors are swallowed PER CONNECTION: a
  // client that resets is an expected, per-connection event in a proxy
  // whose entire job is letting connections die on purpose — an
  // unhandled rejection here must never take the proxy (or, under
  // Deno, the whole harness process) down with it.
  //
  // DROPPING ALSO TAINTS THE CONNECTION, belt-and-suspenders alongside
  // `blackhole()`'s own proactive sweep (below) marking every then-live
  // connection tainted the moment mode flips: THIS site catches the one
  // case that sweep cannot — a connection whose `Deno.connect()` to the
  // upstream was in flight, started under "forward", finishing (and
  // only THEN entering `live`) after `blackhole()` already ran its
  // sweep. `state.mode` can flip back to "forward" between one read and
  // the next (that is exactly what restore() does), and this loop does
  // NOT exit when that happens — it would otherwise silently resume
  // shovelling bytes on a connection that already lost some in the
  // middle, handing whatever rides it (a WebSocket, most concretely) a
  // stream with a hole punched in it. Marking `conn.tainted` instead
  // lets the loop keep running (destroying mid-iteration would race the
  // other direction's shovel over the same sockets) while making the
  // taint visible to restore(), which is where the connection actually
  // dies.
  const shovel = async (from: Deno.Conn, to: Deno.Conn, conn: Conn) => {
    const buf = new Uint8Array(65536);
    for (;;) {
      let n: number | null;
      try {
        n = await from.read(buf);
      } catch {
        return;
      }
      if (n === null) return; // EOF
      if (state.mode === "blackhole") {
        conn.tainted = true; // drop: the timeout shape
        continue;
      }
      try {
        await to.write(buf.subarray(0, n));
      } catch {
        return;
      }
    }
  };
  const pump = async (conn: Conn) => {
    const { client, upstream } = conn;
    if (!upstream) return;
    await Promise.race([shovel(client, upstream, conn), shovel(upstream, client, conn)]);
    destroy(conn);
  };

  const acceptLoop = (async () => {
    for await (const client of listener) {
      if (state.mode === "sever") {
        // Refuse before the peer even gets a byte back: the closest a
        // userspace proxy gets to an RST for a connection it never
        // pumped. (A true RST would need SO_LINGER=0, which Deno's std
        // `Deno.listen` does not expose; closing unread is the honest
        // approximation and is what actually reaches the peer as a
        // reset in practice on a fresh accept.)
        try {
          client.close();
        } catch { /* already gone */ }
        continue;
      }
      const conn: Conn = { client, upstream: null, dead: false, tainted: false };
      if (state.mode === "blackhole") {
        // Accepted, but forwarded to nowhere: the peer's bytes vanish
        // and nothing ever answers — the TIMEOUT shape. Tracked in
        // `live` so a later sever() can still kill it.
        live.add(conn);
        continue;
      }
      try {
        conn.upstream = await Deno.connect({ hostname: "127.0.0.1", port: targetPort });
      } catch {
        destroy(conn);
        continue;
      }
      live.add(conn);
      pump(conn);
    }
  })().catch(() => {
    // The loop only exits via listener.close() (from `close()` below);
    // any other rejection is a proxy bug worth seeing once, but must
    // not become an unhandled rejection under Deno.
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sever() {
      state.mode = "sever";
      // RST-shaped for connections already live too: kill them now
      // rather than waiting for their next read/write to notice.
      for (const c of [...live]) destroy(c);
    },
    blackhole() {
      state.mode = "blackhole";
      // Do NOT close anything here — the whole point is a hang, not a
      // refusal. A connection already mid-pump keeps its sockets open;
      // the manual shovel above simply stops writing what it reads,
      // so nothing new arrives at the other side once its shovel has
      // consumed whatever was already in flight (the proxy cannot make
      // the relay itself go silent, only stop relaying what does
      // arrive). New connections accepted from here on are parked,
      // unforwarded, in `live`. Nothing is CLOSED here — that is
      // deliberate: blackhole() must stay non-destructive while it is
      // in force (the hang is the point).
      //
      // BUT EVERY CURRENTLY-PUMPING CONNECTION IS TAINTED HERE, not
      // only when a shovel later actually drops a chunk on it. An idle
      // keep-alive connection (a request/response already finished,
      // nothing more queued) sees no traffic at all during a blackhole
      // window — no chunk is ever read, so the shovel's own drop-and-
      // taint never fires — yet it no less "lived through" the
      // blackhole per the documented contract, and a client sitting on
      // it has no way to distinguish "this proxy is about to heal me"
      // from "this proxy dropped my last three frames". Marking it
      // here, at the moment forwarding stops, is what makes taint track
      // "was this connection's normal service interrupted" rather than
      // "did the dice happen to roll traffic during the interruption".
      // (No NEW pumping connection can appear while mode is already
      // "blackhole" — the accept loop parks them instead, never calling
      // `pump` — so every connection this could ever need to catch is
      // already in `live` with a live `upstream` at the instant this
      // runs; nothing added afterwards needs a second sweep.)
      for (const c of live) {
        if (c.upstream !== null) c.tainted = true;
      }
    },
    restore() {
      state.mode = "forward";
      // NEW connections only — see the file banner. Anything that
      // lived through blackhole() dies HERE rather than resuming:
      //   - TAINTED connections — every connection blackhole() found
      //     already pumping, whether or not a chunk was actually
      //     dropped on it (see blackhole()'s own comment) — must not
      //     silently resume forwarding as if nothing happened.
      //   - PARKED connections (accepted during blackhole with no
      //     upstream ever connected) never got a chance to forward at
      //     all; their peer has been hanging since accept, so healing
      //     means they die too and the peer re-dials — the same
      //     contract as a tainted one, for the same reason.
      // A connection that stayed in "forward" mode for its whole life
      // (never touched by a blackhole() in between) is untouched.
      for (const c of [...live]) {
        if (c.tainted || c.upstream === null) destroy(c);
      }
    },
    async close() {
      state.mode = "sever";
      for (const c of [...live]) destroy(c);
      try {
        listener.close();
      } catch { /* already closed */ }
      await acceptLoop;
    },
  };
}
