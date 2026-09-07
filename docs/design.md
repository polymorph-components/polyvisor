# polyvisor — design record

Rulings for the rebooted tree. Each entry states what is decided and why,
so later work argues with the reason instead of re-deriving it. Nothing
here is a compatibility promise: **the whole framework is unstable until
declared otherwise.** Open questions live in the issue tracker.

## What this is

A framework for PWAs that inverts the usual architecture: applications
run client-side as WebAssembly component-model components under
user-controlled capability confinement. The organizing invariant:

> Nothing in the system is both live and trusted. Trusted ⇒ static (the
> home origin's content, release artifacts). Live ⇒ untrusted by
> construction (relays, storage, peers), covered by end-to-end crypto and
> capability confinement.

The linker is the permission system: a component's authority is its
import set. Deny = unlinked or stubbed; prompt = the async import
suspends on consent; revoke = a defined error, never a trap.

## Realms

Three browser realms, three components, one thin glue layer.

| Realm | Component (Rust) | Glue (TypeScript) |
|---|---|---|
| SharedWorker, one per device | **runtime** — kernel + engine: device store, sealing, sync, grants, app sessions, data services | `web/worker.ts` + `web/platform/*`: IndexedDB `kv`, OPFS preopen, Web Locks, fetch, polymorph hosts; RPC server over MessagePorts |
| Main thread | **visor** — the trusted pixels (strip, drawer, sheets, ceremonies), a stream-dom producer | `web/boot.ts`: polyengine instantiation, stream-dom receiver (no policy), frame factory, `shell` |
| Opaque-origin `srcdoc` frame | **app** — a polyvisor:app world, a stream-dom producer | `web/frame.ts`: a constant loader; polyengine instantiation, stream-dom receiver under a declared policy, asset resolver, import proxy over a port |

**Ports.** The visor's glue asks the worker for a `MessageChannel` per
app session; one end is bound to the session in the worker's dispatch
table, the other is posted into the frame. App imports go frame → worker
directly. The main thread is never in an app's data path.

**TS is glue.** The test for whether something may live in TypeScript:
it wraps a browser API, or it moves bytes between realms. State
machines, protocols, policy decisions and crypto orchestration live in
the components. This is what makes a native shell possible: `runtime`
and `visor` run unchanged under wasmtime with a Rust implementation of
the same platform interfaces, and stream-dom frames cross process IPC to
a receiver in a webview. The seam is bought now; the shell is not built
in this plan.

## Contracts

Two WIT packages, one per audience.

- `wit/` — **`polyvisor:app`**, public. What code from outside this
  repository links against: the `app` world (stream-dom `producer` +
  granted services), data services (`tasks` first), later providers and
  panels. Versioned deliberately; grows additively.
- `runtime/wit/` — **`polyvisor:internal`**, private. Platform
  interfaces the glue implements (`kv`, later locks), kernel interfaces
  the runtime exports and the visor imports (`lifecycle`, `device`,
  `apps`, `events`, `app-services`), and `shell` (page capabilities the
  visor imports). Both sides are built from one commit, so it changes
  freely; its digest is a consistency check.

Rules for `polyvisor:internal`:

1. **Anything that crosses a realm is `async func`.** The guest suspends
   through the component model's async ABI (wit-bindgen's callback ABI,
   stackless). The glue never wraps an import in `suspending()`.
2. **No resources cross the seams.** Plain data only, so the same call
   serializes over a MessagePort and over IPC.
3. **Caller identity comes from the glue**, taken from the port a call
   arrived on and supplied as a `session-id` parameter; never from the
   caller. Each public service interface has an internal mirror with the
   session first (`app-services`).
4. **Kernel events reach the visor as a long poll** (`events.next`,
   served by each visor's glue from a local queue). The runtime's side is
   a non-parking `event-source.drain` the worker glue calls after every
   export it dispatches: polyengine traps an async export parked on a
   guest-internal waker with no host call outstanding as a deadlock
   (polyengine#292; wasmtime stays pending), and until the engine lands
   every event is born inside a glue-dispatched export anyway. No
   callbacks, no second mechanism. What the glue itself observes (a frame torn down by
   the receiver) enters the same path through `apps.abort`, so the visor
   has one source of truth for session endings; `apps.close` — the
   visor's own act — emits nothing.

Vendored dependencies live under each package's `deps/`
(`runtime/wit/deps/polyvisor-app` is a symlink to `../../../wit`). Two
versions of `wasi:clocks` and `wasi:sockets` are present (0.3.0 via
polymorph:iroh, 0.3.1 via WASI's consolidated release); polyengine keys
providers by semver track (`@0.3`), so both resolve to one host.

## No JSPI

Verified against polyengine's source: `NeedsJspi` is raised only for
(a) a sync-typed import whose host returns a Promise (requires a
`suspending()` mark), (b) a stackful async lift, (c) a sync lower onto an
unresolved subtask, (d) blocking built-ins from a frame that cannot
return a code. The callback ABI — what wit-bindgen emits — needs none of
it. The old tree required JSPI for one reason: `std::fs` in the engine's
checkpoint path bound `wasi:filesystem@0.2` (sync WIT) over OPFS
(Promise-only).

Ruling: the runtime uses `wasi:filesystem@0.3` (async in WIT) through
generated bindings, not `std::fs`; every glue-implemented import is
async in WIT; the visor and frame embedders force `jspi: false`, so a
regression there fails loudly.

**The worker is the one exception, for now.** The composed iroh endpoint
authenticates its QUIC connections with rustls, and rustls has no async
signing path: `Signer::sign` is synchronous, and polymorph-iroh
implements it as `block_on` over the async `polymorph:webcrypto` sign
import (`core/src/crypto/sign.rs`). A sync lower of an async import is
exactly what JSPI exists for, so the accept side of every connection
needs it (found in M3a: with `jspi: false` the acceptor stalls in
`CertificateVerify`). The general fact: a platform-held, non-extractable
key as the TLS identity implies JSPI in a browser. So the worker is
instantiated with `jspi: true`, tolerated only until the transport's
signer is in-guest (polymorph-iroh: an identity built from a seed, which
is the posture the kernel already holds); then the worker returns to
`jspi: false` and the browser floor is wasm multi-memory alone. The
visor and frame realms never needed JSPI and stay without it.

## The app frame

- An opaque-origin `srcdoc` document carrying its own `<meta>` CSP
  (`default-src 'none'`; `script-src` the loader's hash plus
  `'wasm-unsafe-eval'`; `style-src`/`img-src`/`font-src`/`media-src
  blob:` — the asset stylesheet is a `blob:`). CSP
  policies compose with the embedder's header policy, so the frame is
  network-dead regardless. `sandbox="allow-scripts allow-forms"`;
  `form-action 'none'`. The loader is a constant; everything variable
  (component bytes, port) arrives by `postMessage`.
- **The app component runs in the frame's main thread.** The stream-dom
  receiver binds to the frame's own DOM same-realm.
- **No worker inside the frame.** Dedicated workers must be same-origin
  with their creator and an opaque origin matches nothing in practice
  (`blob:` workers fail in sandboxed frames; a `data:` worker is the one
  variant that could work and is not planned). When apps move off the
  main thread (#45, honest `worker.terminate()`), the design is the
  stream-dom worker tier laid out across the sandbox: the component runs
  in a dedicated Worker spawned by the visor on the home origin; the
  frame holds only the receiver, the policy and the asset resolver, fed
  frames over a port. Recorded trade: a polyengine bug that let guest
  code escape to JS would land on the home origin rather than a
  storage-less, network-less one. The component's own authority is
  unchanged either way. `web/frame.ts` keeps its polyengine use behind
  one seam so that move is a deletion.
- **Policy** is stream-dom's `Policy` object: pinned to the receiver's
  `PROTOCOL_VERSION`, `check(op)` over a table-driven allowlist (tags,
  attributes per tag, properties — never `innerHTML` — event names, URL
  schemes: `href`/`src` are asset handles or fragments), `bindMarker`
  refused (no hydration for apps), the four `queries` allowed. A
  violation aborts the stream and tears the frame down. Confinement
  below the vocabulary (ids, template arenas, mount-root inviolability)
  is the receiver's own and is fuzzed upstream.
- **Assets.** An app bundle is a component plus content-addressed static
  assets (handle = raw SHA-256 of the bytes; the manifest spells it in
  hex). The producer names an asset by handle in an attribute value; the
  receiver's `resolveAsset(handle)` must answer synchronously, so the
  frame fetches every asset over its session port (`apps.asset`) before
  the producer runs and mints one `blob:` URL per handle. Asset `href` is
  legal only on `<link>`; an `<a href>` is a fragment. The kernel is the
  only fetcher and re-hashes what it serves; until installation lands
  (M2) it fetches bundles from the home origin over `wasi:http`.

## The kernel is one component

Kernel (device store, sealing, sync scheduler, grants, sessions) and
engine (CRDT, group crypto, sync protocol) are crates in one `runtime`
component. Component-model linking is reserved for the untrusted tier
— providers, data services, apps — where a boundary buys confinement.
Inside the TCB it would buy a second WIT surface and marshalling for
nothing.

## Sync engine: subduction sans-IO

The engine crate is a driver for `subduction_protocol::Node` (the
`sansio` branch: a pure state machine — `handle(now, event)`,
`poll_effect()`, `poll_timeout()` — with no IO, clock, locks or spawns)
through `subduction_runtime`'s traits in their single-threaded `Local`
form. Polyvisor owns five implementations:

| Trait | Implementation |
|---|---|
| `Transport` | one per connection over `polymorph:iroh` streams, relay-only: WebRTC is off in the worker because a SharedWorker has no `RTCPeerConnection` (the host backend never resolves there). Framing per `subduction_iroh` (u32 BE length prefix) so native subduction peers interoperate |
| `Storage` | M3a: an in-memory item store serialized into the sealed checkpoint with the automerge docs. Items in their own files under the state root is the follow-up once checkpoint size matters |
| `Policy` | the keyhive pull/read gate — ours, since `subduction_keyhive` is still legacy upstream; mined from it for semantics |
| `Signer` / `NodeEffect::Sign` | M3a: `ed25519-dalek` over a seed held in the sealed checkpoint (the seed posture; the same seed, imported through `polymorph:webcrypto`, builds the iroh identity). Later: a non-extractable platform key — signing is an effect with external custody, which is exactly what that needs |
| `Clock` | `wasi:clocks@0.3` |

Why the branch rather than the released crates: one driver loop the
checkpoint can stop the world against (the legacy core spawned its own
tasks and slept on Rust channels — the source of a whole class of old
wedges), signing as an effect (the legacy `Signer` was infallible, so a
platform key could only trap), and a wire that is byte-compatible with
legacy by design. Cost: an unreleased tree with moving APIs; the five
trait impls are the whole exposure, and every rev bump is its own PR
behind the interop gate. `subduction_iroh` itself is native-only (upstream
iroh + tokio) and cannot be used in a component; its conventions are the
reference, not its code.

keyhive is pinned to git `main` for the CGKA transitive-authority fix
(66a6632: relay access no longer grants CGKA membership) that the
released 0.5.0 lacks; the pull ≠ read tier separation depends on it.

## Devices

A device is one kernel identity and everything it holds; a browser may
hold many, and one SharedWorker serves one device. The glue owns only
what has to exist before the kernel does: the device **id** (the tab's
sessionStorage anchor, or a fresh id it mints), because the worker is
named after it. Everything else — the index, tiers, sealing, the sweep —
is kernel logic over `kv`, `locks` and the OPFS state root.

- **The index** (`store`) is the one unsealed record: id, petname, tier,
  how the device rests, timestamps. Never the name, hue, word or any key.
  The visor boots unclaimed (grey, no identity) and paints the user's
  colour only after the seal opens, so a page imitating the picker cannot
  paint it.
- **Tiers as a promotion.** Every device starts *ephemeral*: state is
  checkpointed so a reload survives (the worker respawns on every
  single-tab reload — checkpoint + rehydrate, not worker-memory luck),
  and the namespace is garbage once its lock is free and its lease stale.
  "Keep this device" makes it durable and asks how it rests.
- **Two honest tiers of rest.** *Rests open*: the data key sits in the
  namespace; protection is the profile's access control and the visor
  says exactly that. *Passphrase*: the key is wrapped under Argon2id and
  unsealing is the login, every session; the unwrapped key lives in
  worker memory only. Sealing is pure Rust in the kernel (`aes-gcm`,
  `argon2`) with the key as bytes: a non-extractable WebCrypto handle
  persisted in IndexedDB would rest under the same profile protection,
  so it buys nothing at this tier. The signing identity is a seed in the
  same sealed checkpoint (M3a); platform-held keys enter with the passkey
  PRF rung (M5) and, for the transport, once its TLS signer is in-guest.
- **Checkpoints** are AES-GCM over the kernel's serialized state, written
  to `/<id>/gen-<n>/` on the OPFS root through `wasi:filesystem@0.3` after
  every mutation (state is small until the engine lands; a debounce is a
  later optimization). Commit protocol: state, then MANIFEST (generation +
  digest), then the generation pointer in `kv` — the pointer is the commit
  point, a failed write never advances it, and a load falls back one
  generation. The kernel never lists a directory: `read-directory` is one
  of four sync functions left on the 0.3 track and its OPFS host answers
  with a Promise (JSPI), so every path is named from the pointer and
  removal reaches n+1 down to n-2 by name. The anchor (hue, word) is drawn
  from the RNG and checkpointed at mint — a value derived from the public
  id would be readable before unseal.
- **Switching devices is a reload** (`shell.switch-device`): the anchor
  changes and the page restarts against another worker. Erase destroys
  the namespace and the index row, then switches to a fresh device.

## Visor and apps render through stream-dom

Both are Dioxus producers via `stream-dom-dioxus`. The visor runs with
no vocabulary policy (it is trusted); apps run under the frame policy
above. The visor is close to stateless: identity, hue, anchor word,
trust table and boot cache are kernel state served over `device`/`apps`,
so the visor has no persistence import of its own and the same component
runs under a native shell.

Known costs carried from the visor-dioxus spike: ~400 KB gzipped
floor; predicates become bools at the WIT boundary; a Dioxus component
that writes a signal it never reads renders once forever — invisible to
native tests, so browser gates are mandatory for every visor change.

## Pins, with reasons

| Dependency | Pin | Reason |
|---|---|---|
| Rust | 1.98.1 | current stable; satisfies stream-dom (1.98), subduction (1.91), keyhive (1.90) |
| `wit-bindgen` | `=0.60.0`, workspace-wide | must equal stream-dom's pin: `StreamReader<u8>` (a wit-bindgen runtime type) crosses the delegation from our world's `run` into `stream_dom_dioxus::driver::run`. Different wit-bindgen versions *can* coexist in one component (the `wasip3_task_set` weak-symbol ABI exists for exactly that), but not across a shared runtime type. Bumps follow stream-dom's. `generate!` never sets `async: true`: that lowers sync WIT functions (resource constructors) async, which the canonical ABI forbids and only the translator catches; WIT's own `async func` annotations are the source of truth |
| `@polyengine/*` | git rev `80ee6cb` (raw.githubusercontent) + `pre-80ee6cb` translator asset | carries the #289 driver fix; see "polyengine is consumed at a git revision" |
| `dioxus` | `=0.7.10` | dioxus-core state is shared with `stream-dom-dioxus`; skew breaks the build |
| polymorph-stream-dom | git rev (see Cargo.toml / deno.json) | unpublished, moving; policy object and asset handles landed in #15 |
| subduction | git `sansio` rev | above |
| keyhive | git `main` rev | above |
| `@polymorph/*` | 0.6.0 | the 2026-09-05 cut matching polyengine 0.6.3 |
| polymorph:iroh WIT | provisional | being upgraded upstream in parallel; re-checked before M3a, the first milestone that exercises it |
| `wasi:*` WIT | 0.3.1 (consolidated WASI release) | what `@polyengine/wasi` serves on the `@0.3` track |

## Delivery

- Same repository; the pre-reboot tree is tag `pre-reboot` / branch
  `archive/v0`. Nothing carries verbatim; it is mined by reading.
- One embedding: one device per page, the runtime in a SharedWorker.
  Multi-device and multi-user scenarios are several browser contexts
  against one relay.
- Rust producers only (Dioxus). A JS producer on-ramp waits for a
  stream-dom JS adapter.
- Gates: `cargo test` (native, per crate), `deno test` (glue), and
  Playwright on real Chromium for every claim about pixels or realms.
  The archive's 38 e2e scenario names are the parity checklist; each
  milestone re-derives its slice as new scenarios against the new build.

### Milestones

- **M0** archive, skeleton, this record, both WIT packages, CI.
- **M1** three realms, one TodoMVC: stub kernel with in-memory `tasks`;
  visor strip + settings sheet; frame loader under policy; ports.
  Gates: app renders in the opaque frame; strip geometry immobile with
  the app mounted; zero network requests from the frame; `jspi: false`;
  the frame policy's unit tests. (The frame-teardown integration test
  waits for a hostile fixture component — M2. The path was exercised
  anyway: the policy caught the TodoMVC example's outbound `href`.)
- **M2** devices survive: the index, namespaces, the two tiers of rest,
  checkpoint/resume on OPFS, locks and the sweep, entry/keep/unseal/erase
  in the visor, and the hostile-fixture frame-teardown scenario. Reload
  survival with worker respawn as the normal case.
- **M3a** the engine in the loop: `tasks` becomes an automerge document
  from the start, the sans-IO subduction driver with polyvisor's trait
  implementations, an iroh transport over the composed endpoint
  component, manual dial by endpoint id, two devices converging over a
  local relay in e2e. Policy is allow-all until M3b. Wire compatibility
  with native subduction peers is a gate only when a native peer exists
  (headless, parked). **M3b** pairing (code + commit/reveal SAS + dual
  confirm), the device group as the user-system document, sync policy =
  group membership, reconnect at boot. **M3c** keyhive/BeeKEM: envelope
  encryption of every tree so relays and stores hold ciphertext only;
  the group's keyhive membership derived from the user-system document.
  Sequenced after M3b because device↔device sync already runs inside
  authenticated QUIC — content encryption is what untrusted *storage*
  (M4) needs, and building the group first gives keyhive a membership
  to key.
- **M4** storage: per-destination egress, S3 provider component, bucket
  sync, picker, provider panel in a frame.
- **M5** passkey PRF rung, recovery kits, Drive provider.
- Parked: app worker (above); native shell; JS producers.

## polyengine is consumed at a git revision

Found in M1: an import awaited from a Dioxus event handler never resumed
until the next event. Root cause (polyengine, fixed upstream in #289): a
`driveAsync` loop parked on `Promise.race([...pendingHostCalls, ...])`
holds a snapshot; an export entered through the synchronous `drive` path
fires no driver-arrival, so a host call registered during it is
invisible to the parked race, and the settlement pump stands down while
the parked driver counts. A stream-dom producer is the routine victim —
its `readDirect` session keeps a driver parked whenever one long poll
(`events.next`) is outstanding.

The fix is in polyengine `main`; polyengine publishes to JSR only on cut
releases, and a release is a human act. So this tree consumes polyengine
by git revision: `deno.json` maps every `@polyengine/*` specifier to
raw.githubusercontent at one sha, and `web/translate.ts` fetches the
matching `pre-<sha>` release's translator wasm (digest-checked against its
SHA256SUMS, cached under `target/`). The sha is spelled in `deno.json` and
in `web/translate.ts`; the two must agree, and a bump is its own PR. Return to a caret JSR pin when a release carrying #289 exists.
