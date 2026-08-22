# worker-host — can a SharedWorker be the device host? (G5 persistence round)

An executed validation record, not a design. Everything below was
measured in a real headless Chromium on this workstation; the probe that
measured it is in this directory and re-runs with `just run`.

```
just run     # build (needs demo artifacts) + drive the matrix, verdict per row
just build   # bundle worker+page into serve/ only
just check   # type-check worker, page, driver
```

Run of record: 2026-08-22, **Chromium 143.0.7499.4** (playwright 1.57.0),
engine composite `../../engine/target/composed.wasm` + the demo's
translated `build/engine.plan.json` (`cd ../../demo && just translate`).
The last run's rows are also written to `last-run.json`.

## The matrix

| # | Question | Verdict | Evidence (one line) |
|---|---|---|---|
| 0 | Module SharedWorker + JSPI present in the worker | **PASS** | `scope=SharedWorkerGlobalScope jspi=true opfs=true locks=true`; `{type:"module"}` accepted with no fallback — `page.ts:70`, `worker.ts:451` |
| 1 | Engine composite instantiated and driven **inside** the SharedWorker | **PASS** | `instantiate 85ms \| init 71879a2b… \| create-partition e745544e… \| kh-add-member(self) accepted \| seal-partition \| tasks.add ×2 \| tasks.items rev=3 n=2` — `worker.ts:326` |
| 2 | OPFS from the SharedWorker, through the polyengine wasi filesystem | **PASS** | preopen `/` = `navigator.storage.getDirectory()`; open→`writeViaStream`→re-open→`readViaStream` round-trips byte-identically — `worker.ts:198` |
| 3 | Non-extractable Ed25519 pair in IndexedDB, across a **worker restart** | **PASS** | restart boot 1→2; same public key; `minted=false extractable=false exportRefused=true sign+verify=true` (64-byte signature) — `worker.ts:131`, `worker.ts:164` |
| 4 | SharedWorker lifetime across 5 single-tab reloads | **RESPAWNS** | boot counter `1,2,3,4,5,6`, a new instance nonce every reload, uptime ~1 ms at every hello — `run.ts:283` |
| 4b | …with a **second tab** holding the worker | **SURVIVES** | one reload with another client attached: same nonce, `bootSeq 6→6` — names the mechanism as the zero-client window — `run.ts:307` |
| 4c | …with `extendedLifetime: true` | **BLOCKED** | this Chromium never *read* the option (getter probe, `page.ts:61`) — Chrome 148+ only; untested, not disproved — `run.ts:339` |
| 5 | Web Lock acquired inside the worker, observed from the page | **PASS** | page `navigator.locks.query()` sees `{name:"spike-worker-host-device",mode:"exclusive",clientId:…}` — `worker.ts:92` |
| 5b | The lock is released when the worker dies | **PASS** | with no worker alive a `?noworker=1` page sees `{"held":[],"pending":[]}`; a later page respawns the worker and the lock returns under a **new** clientId — `run.ts:385` |
| 6 | Chrome for Android SharedWorker support | **SUPPORTED, RECENTLY** | re-enabled in Chrome 148 (chromestatus), caniuse lists Chrome-for-Android 151 as supported; see below |
| 7 | iroh bind over WebSocket from the worker (bonus) | **PASS** | `driver.irohBind(http://127.0.0.1:<ephemeral>)` → endpoint id, against a locally spawned `iroh-relay` — `worker.ts:380` |

Nothing in this matrix blocks the SharedWorker-as-device-host design.
The one result that changes the design is **Q4**.

## The findings that matter

### Q1 — the engine runs in a SharedWorker, JSPI and all

This was the real risk: the engine suspends through JSPI constantly, and
JSPI availability is per-global. `WebAssembly.Suspending` is present in
`SharedWorkerGlobalScope`, and the full `bringup.ts solo` sequence
(demo/host/bringup.ts:52-77) runs there unmodified — instantiate, init,
create-partition, seal, two `tasks.add`, `tasks.items` returning both
items at revision 3. Instantiation cost inside the worker is ~85 ms, in
the same band as the page.

`kh-add-member(self)` was **accepted** rather than refused. The bringup
solo phase never makes that call (a fresh partition is already delegated
to its creator), so the call was made here only because the dispatch asked
for it; "accepted" is recorded as an observation, not leant on.

### Q2 — OPFS: async handles, and therefore no dedicated-worker problem

`filesystem_web.ts:16` says it outright, in the module header:

> The synchronous OPFS access handles — `createSyncAccessHandle` — exist
> only in dedicated workers; this impl deliberately targets the portable
> async API.

So the API mode is **async handles** (`getFileHandle`/`createWritable`/
`getFile`), and the dedicated-worker-only restriction is designed around,
not merely avoided by luck. Empirically, in the SharedWorker,
`createSyncAccessHandle` was **not even present on the handle** (recorded
verbatim: `createSyncAccessHandle absent on the handle`) — the platform
does not expose it there at all, which is a cleaner signal than a runtime
refusal.

What was exercised: the wasi layer, not raw OPFS. The `@0.3` `Descriptor`
is async in WIT and therefore directly callable host-side with no guest
and no JSPI, so the probe mounts the real preopen
(`filesystemWeb({preopens:{"/": root}})`), takes the descriptor out of
`wasi:filesystem/preopens@0.3`.`getDirectories()`, and does
`openAt` → `writeViaStream` → *fresh* `openAt` → `readViaStream`. Only
the guest half is missing.

**Surprise, and a trap for the real host.** The first run failed with
`ComponentException: component error: read-only`. The pinned
`jsr:@polyengine/wasi@0.3.1` takes a third `access` argument
(`makeFilesystem(backend, preopens, {writable})`) and **defaults the whole
fragment to read-only**: any open with `create`/`truncate`/`write` throws
`read-only`. `filesystemWeb({preopens, writable: true})` is required.

The working-tree copy of the impl at
`~/p/polymorph/polyengine/wasi/src/filesystem_web.ts` has **no such
option** — it is a different revision from the published 0.3.1 the demo
pins. Read the pin for behavioural questions; the checkout is fine for the
design commentary (the header quoted above is still accurate).

Second, smaller trap: the DOM's `FileSystemDirectoryHandle` does not
structurally satisfy the impl's `OpfsDirectoryHandle` (writer parameter
form, plus `Uint8Array<ArrayBufferLike>` vs `ArrayBuffer`), so a cast is
needed at the preopen site. Runtime shapes match; see `worker.ts:198`.

### Q3 — key persistence works exactly as the wosh pattern predicts

Minted in the worker, stored by structured clone in IndexedDB, worker
killed by closing every page, then re-fetched by the *new* worker:
same public key, `extractable === false`, `exportKey("pkcs8")` refused,
`sign()` + `verify()` green. The load path validates the stored value
against exactly what `mint` makes and settles the two-client race inside
one readwrite transaction, per `~/p/wosh/site/identity-store.ts:66,79`.

This measurement needed a **persistent** browser context: a fresh
Playwright context is a fresh storage partition, so "close the context to
kill the worker" would also have thrown away the IndexedDB the claim is
about (`run.ts`, the persistent-profile block).

### Q4 — THE ONE THAT CHANGES THE DESIGN: a reload respawns the worker

Five reloads of a single tab, and the worker was replaced **every time**:
boot counter `1 → 6`, a new instance nonce each load, and an uptime of
about 1 ms at each hello. In this Chromium a SharedWorker gets no
reload-survival at all when a single tab is the only client.

The mechanism is named by Q4b, which is the discriminating experiment: with
a **second tab** attached, a reload of the first leaves the worker
untouched (`bootSeq 6→6`, same nonce). So the respawn is the *zero-client
window* between the old document detaching and the new one attaching —
not the script re-fetch (the harness serves `cache-control: no-store`,
which Q4b shows to be irrelevant).

MDN's own wording is permissive here — "Browsers **may** keep workers
alive between same-origin navigations to avoid the cost of restarting a
shared worker" — and this Chromium does not. Treat continuity as a
best-effort optimisation, never as a guarantee.

`extendedLifetime: true` (Q4c) is the standard's answer to exactly this
window, but is **untestable here**: Chromium 143 predates it (Chrome 148,
chromestatus 5138641357373440). The probe does not guess — it puts a
getter on the options dictionary and reports whether the constructor ever
*read* the member (it did not), so the row is BLOCKED rather than a false
negative. **Re-measure on Chrome ≥148 before designing around it.**

Consequence for T0: **reload-survival needs checkpoint + rehydrate.**
Worker-memory continuity is not free, and on today's Chromium it is not
even usual. Two follow-ons worth noting: keeping a second client attached
is a real, if ugly, continuity lever (Q4b); and a host that must persist
before dying has to do it during unload, which is what `extendedLifetime`
exists for.

### Q5 — Web Locks behave, including the death signal

The worker takes an exclusive lock whose callback never settles, so the
grant lasts exactly as long as the worker global. A page sees it in
`navigator.locks.query()` with the worker's `clientId`. When the worker
dies the lock is gone: observed **directly**, by a page loaded with
`?noworker=1` that constructs no worker at all and reports
`{"held":[],"pending":[]}`. A later normal page respawns the worker and
the lock is held again under a different `clientId`. No surprises — this
is a usable "the device host is alive" signal.

One implementation note that would otherwise bite: locks are origin-scoped,
so the `extendedLifetime` variant worker had to use a *differently named*
lock. Sharing the name would have parked the second worker forever behind
the first one's never-released exclusive grant (`worker.ts:92`).

### Q6 — Chrome for Android: supported, and only just

Not testable on this workstation; researched.

- **chromestatus "SharedWorker on Android"** (feature 6265472244514816):
  Android and WebView milestone **148**. Its own summary is the history:
  "For a long time, SharedWorker has been disabled on Android due to
  concerns about its unpredictable process lifecycle… Based on this, we
  plan to re-enable SharedWorker on Android while simultaneously
  investigating this behavior." (Discussion: whatwg/html#11205.)
- **caniuse.com/sharedworkers** (fetched 2026-08-22): *Chrome for
  Android ✅ 151: Supported*; Android Browser 151 supported; Firefox for
  Android 153 supported. Still **not** supported: Samsung Internet 30,
  Opera Mobile 80, UC Browser, QQ, Baidu, Opera Mini.
- **MDN `SharedWorker`**: Baseline **Newly available since May 2026**.

caniuse's 151 and chromestatus's 148 disagree by three milestones (caniuse
tracks verified support, chromestatus the shipping milestone); either way
this is a **2026 arrival on Android**, and the platform team's own stated
reason for the decade of absence — unpredictable process lifecycle — is
the same property Q4 just measured on desktop.

So: no no-worker fallback is needed for *current* Chrome/Firefox on
Android, but it is needed for Samsung Internet (a large Android share) and
for any not-yet-updated Chrome. The honest reading is that a device host
must be able to run without a SharedWorker, and should treat the worker as
an optimisation rather than a home.

### Q7 — iroh from the worker (bonus): works

`driver.irohBind(<local relay>)` from inside the worker returns an
endpoint id, i.e. the websocket port opened a real WebSocket to a locally
spawned `iroh-relay` (repo-pinned binary, ephemeral port, config-file
port trick from `demo/e2e/run.ts:286-296`, killed by PID). Not SKIPPED.

## What is in here

| File | What it is |
|---|---|
| `worker.ts` | the SharedWorker: every probe runs here (engine, OPFS, key, lock, relay), plus the boot counter and the RPC envelope |
| `page.ts` | RPC client; `?extended=1` (extendedLifetime variant), `?noworker=1` (locks observer that spawns nothing) |
| `probe.html` | the page shell |
| `run.ts` | Playwright driver: owns the static server (port 0) and the relay (port 0, killed by PID), runs the acts, prints the matrix, writes `last-run.json` |
| `deno.json` | the demo's pins verbatim — module identity with `../../runtime/engine.ts` |
| `justfile` | `build` (delegates to `demo just translate`), `run`, `check`, `serve`, `clean` |

The RPC envelope (`{id, op, arg}` → `{id, ok, value|error}`) is
deliberately throwaway: this spike answers platform questions and is not a
proposal for the device-host RPC.

## Caveats on this record

- One browser, one machine: headless Chromium 143 on Linux. Firefox and
  Safari are unmeasured; Q4's policy in particular is per-engine.
- Q4c is genuinely open. It is the row most likely to change the T0 design
  and it needs Chrome ≥148.
- The engine probe runs with all three storage seams and the signer wired
  to refusal (no bucket), like the solo page. Nothing here says anything
  about storage egress from a worker.
