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
4. **Kernel events reach the visor as a long poll** (`events.next`). The
   runtime exports it and it parks while its queue is empty; the worker
   glue runs one pump over that export and fans each event into every
   connected tab's queue, and each visor's glue serves the visor's own
   `events.next` import from that queue. So an event born of network
   activity alone — the other device confirming a pairing, an enrollment
   landing, a peer closing — reaches the screen with nothing pressed on
   this device. (This was briefly a non-parking `event-source.drain`
   while polyengine#292 stood; 0.6.6 fixed it and 0.6.7 fixes the lift
   regression that fix introduced, polyengine#312.) No callbacks, no
   second mechanism. What the glue itself observes (a frame torn down by
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
async in WIT; every embedder forces `jspi: false`, so a regression
anywhere fails loudly.

**No realm is an exception.** The worker was one through M3a: the composed
iroh endpoint authenticates its QUIC connections with rustls, whose
`Signer::sign` is synchronous, and an identity built from platform key
handles (`polymorph:iroh/identity-from-keys`) reaches its key through an
async import — a sync lower of an async import, which is exactly what JSPI
exists for, so the accept side of every connection needed it (with
`jspi: false` the acceptor stalled in `CertificateVerify`). The general
fact stands: a platform-held, non-extractable key as the TLS identity
implies JSPI in a browser. polymorph-iroh's `identity-from-seed` (behind
the `guest-ed25519-signing` feature) takes the other side of that: the
identity holds its private key in the endpoint component's memory and
signs there with ed25519-dalek. So every realm is `jspi: false` and the
browser floor is wasm multi-memory alone. The trade, recorded: identity
signatures run in wasm rather than in the platform's native crypto, and
the device seed rests in the endpoint's memory for the endpoint's
lifetime — it was already in the kernel's, and passed through guest memory
at every bind, so this widens where it rests and not whether it is
there.

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
| `Policy` | group membership, read off the user-system document (`polyvisor:us`): a remote peer may read/write exactly while its key is a member. App-tree envelopes are keyhive's (M3c, `engine/src/vault.rs`) |
| `Signer` / `NodeEffect::Sign` | M3a: `ed25519-dalek` over a seed held in the sealed checkpoint (the seed posture; the same seed builds the iroh identity, through `polymorph:iroh/identity-from-seed`). Later: a non-extractable platform key — signing is an effect with external custody, which is exactly what that needs |
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

## Read-back and partitions

App-tree envelopes are causal: keyhive's premise is that granting an
entry point to a document at a point in history reveals the whole
history behind it, so each envelope carries the content keys of its own
direct causal ancestors (keyhive `design/causal_encryption.md`, §"Key
Management"). What a device therefore keeps — and checkpoints, and hands
to the next device it enrols — is not a key per commit but a *set of
heads*: one ⟨pointer, key⟩ pair per readable branch, from which
everything prior is discovered by following the ancestor keys inside
each envelope (§"Decryption Head"). The design doc is blunt that the
full map is "possible, but fragile and unwieldy"; the head set grows
with live concurrency instead of with history, so a linear history of
any length is one pair. A commit whose key a device does not hold is not
lost, it is *under partition* — latency, in keyhive's framing — and it
is connected "by supplying a new head for it" (§"Multiple Heads"). That
is what the engine does on absorb: when a batch of content lands
concurrent with what a device already had, it writes an automerge merge
commit — an empty change whose dependencies are every current head —
whose envelope names both branches' keys and is sealed under the group's
current epoch. A member enrolled after the branch was written, who could
decrypt neither it nor anything automerge buffers behind it, walks in
from that anchor. Anchors are content-free, and a batch that is nothing
but somebody else's anchor is not a reason to author another, which is
what keeps two devices from anchoring each other forever. For the same
reason the Drive pass pulls before it pushes: a device coming back
online learns the group's current epoch and merges before it publishes,
so writes that are concurrent with the group's go up alongside the
anchor that names their keys. That does not close the linear case — a
device that was merely behind produces no divergence and so no anchor,
and its commits stay unreadable to a later-enrolled member until the
next local mutation, whose envelope names this frontier, is written on
top of them; latency again, not loss.

**Fragments.** Wire and store growth is bounded by sedimentree
fragments: a closed range of commits rolled up into one item whose
payload is an automerge *bundle* of every change in it. Automerge draws
the ranges, and its metric is sedimentree's — a commit heads a level-1
fragment when its hash starts with a zero byte, about one in 256 — so
the two agree on head, boundary and checkpoints with nothing in between
to disagree. Compaction runs after a local mutation and after an absorb
that landed; only a device that can read the whole range can build one,
which falls out of the construction rather than being enforced (a
commit it could not open was never applied, so no fragment was drawn
over it). The roll-up is sealed like any commit, and its envelope names
the key of whatever *carries* its boundary — the fragment below it,
under that fragment's own reference, since the boundary commit's
envelope went with its range and its key left the frontier when that
range was covered. So the fragments form a chain a reader walks down:
a member enrolled afterwards opens the newest, reads its whole range
out of the bundle, and follows the embedded key to the one below.
Sealing a fragment also retires the entry it names, so the head set
stays one pair per readable branch rather than growing one per
fragment. The loose commits the fragment carries are then dropped from
local storage —
sedimentree's own `minimize` decides which, so a commit concurrent with
the range is never one of them — while the automerge document keeps its
full history. Identity is head plus boundary, both functions of the
change graph, so two devices build the same fragment; the second
arrival is a no-op locally, and on the store the two land under one
name and the last write wins, harmlessly, because they carry the same
range. Nothing deletes from the store, so a device that pushed a range
before compacting leaves those objects behind: correct, and no smaller
— the saving is in what is written from then on, and in what a device
that compacts before publishing sends at all. The pull skips those
names on the strength of the document rather than a ledger: a change
the document has applied and the tree no longer holds as an item is one
a fragment carries, and fetching it back would undo the compaction on
every pass.

## Storage

The store is dumb and untrusted: it holds ciphertext at unguessable
names. What goes to it is exactly what the sync engine already carries —
sedimentree items (app-tree keyhive envelopes, the group document's
signed commits, keyhive's signed ops) — so a device that pulls from the
store converges the same way it would from a peer, and the store needs no
schema of its own. Object names are `hex(HMAC(name-key, tree-id ‖ item
id))` under one folder per group in the user's Drive `appDataFolder`;
the name key is minted by the group's founding device (from its seed
mixed with boot entropy), rests in the sealed engine snapshot, and
reaches joiners inside the SAS-authenticated ENROLL frame, so every
device in the group derives the same names and a store operator learns
only that N objects exist. Tokens rest sealed beside the device seed;
the OAuth code is the one artifact that crosses the port, bound to a PKCE
verifier that never left the kernel.

## Windows and handles

A document holding a WindowProxy to the visor's window can assign its
`location` cross-origin — trusted pixels under someone else's control.
Two holders exist: a parent (the visor framed in another page) and an
opener (a page that opened us, or a provider page in a popup *we* open).
Phishing in general is answered by the visor's identity mechanisms (grey
until unseal, the hue painted only after); what is ruled here is
narrower: refuse to give a controllable window trusted pixels, and stop
handing out handles.

- **The visor refuses to boot in a window something else may control**:
  `self !== top` or `window.opener !== null`. The opener test is
  one-sided — a positive is reliable, a null is not, because a hostile
  opener can null its popup's `opener` on the initial `about:blank`
  before navigating it to us and keep its own handle working. This
  catches the naive case only, and the record says so. Browsers have
  defaulted `target=_blank` to `noopener` since ~2020, so a non-null
  opener today means someone opened us deliberately.
- **On refusal**: a framework-voice notice in `#visor` — nothing
  personal, no worker, no device anchor read — and a button that reopens
  `location.href` with `window.open(href, "_blank", "noopener")`: a
  fresh browsing context nobody holds a handle to, not even us. A user
  gesture is what popup blockers want, hence a button. The refusing
  window is left as it is; blanking it undoes nothing a handle-holder
  could not redo.
- **Our own OAuth popup opens with `noopener`.** `window.open` then
  returns null, so nothing on our side holds a handle either; the
  returning page (provider → redirect → our URL) has no opener and
  reports over a same-origin `BroadcastChannel` instead of
  `opener.postMessage`. The waiting side matches the message's `state`
  against the `state` of the URL it opened, so another tab's ceremony —
  or a stale one — is ignored; the kernel checks state again at
  `oauth-complete`. A leaked code is inert without the PKCE verifier the
  kernel holds.
- **Closed-detection went with the handle; there is none.** The
  returning page broadcasts the outcome both for a code and for a
  declined consent (RFC 6749 §4.1.2.1 echoes `state` on the error
  redirect too), then tries `window.close()` and, if it is still open,
  says "You can close this window." — a `noopener` window is
  script-closable only while its history has one entry, which a real
  provider's multi-page consent breaks and the e2e fake's single 302
  does not. The one silent case, a user closing the popup mid-flow, is
  covered by a ten-minute bound on the waiting side; provider codes do
  not outlive that.
- **No kernel change.** The pending ceremony in the kernel is replaced
  by the next `oauth-start`; its state is random and its code one-shot,
  so a stale one costs nothing.
- **COOP `same-origin` on the home origin is the general form** of all
  of this: the browsing-context-group swap makes a null opener actually
  mean "no handle", and it covers windows we never opened. It is an
  OPTIONAL enhancement for hosts that can set response headers — GitHub
  Pages cannot, and `<meta>` does not carry COOP — never a requirement.
  Not `same-origin-allow-popups`, which keeps the very link this cuts.

## Devices

A device is one kernel identity and everything it holds; a browser may
hold many, and one SharedWorker serves one device. The glue owns only
what has to exist before the kernel does: the device **id** (the tab's
sessionStorage anchor, or a fresh id it mints), because the worker is
named after it. Everything else — the index, tiers, sealing, the sweep —
is kernel logic over `kv`, `locks` and the OPFS state root. A device
starts as a group of one; pairing replaces the joiner's group with the
adder's, members reconnect at boot, and non-members are closed after
the handshake.

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
  PRF rung (M5); the transport's TLS signer is in-guest instead (see
  "No JSPI").
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

## Routing

The page URL gains one thing: a fragment, `#app/<token>`, naming a
running app and a route the app chose, so "this app, here" can be
bookmarked. The fragment is the only place for it — it never reaches the
server, and it is the one part of the URL an app frame's `href` policy
already treats as same-document (`web/policy.ts`). Two parts, two
owners: the visor owns the grammar (`<kind>/<rest>`, `app` the only kind
today; anything else is refused by `route-decode` exactly as an
unreadable token is), and the app owns the
text inside `route`, which the visor carries byte-for-byte and never
interprets.

- **The token is ciphertext, and deterministic.** `install-id ‖ route`,
  zero-padded to 256 bytes, sealed under a *user* route key with
  AES-256-GCM and a synthetic nonce (`HMAC(k_siv, plaintext)`), so equal
  state is equal text: bookmarks dedupe, `replaceState` does not churn
  the bar, and browser history sees one entry per state rather than one
  per keystroke (`runtime/crates/kernel/src/route.rs`). What this buys
  is both directions of the trust problem at once. Inbound, a route
  that decrypts is one this user's visor wrote for this install — the
  app is handed its own prior output, not attacker-typed input.
  Outbound, the app never holds the key, so the URL bar, history sync,
  screenshots and "recently closed" learn nothing of the route. The
  fixed length closes the length channel; what remains is *that* an
  update happened, when, and whether state changed — a bit or two per
  update, to a reader who already holds the user's browser account. That
  is the accepted residue, and it applies only to apps that import
  `route` at all.
- **The key is user-level and lives sealed.** Bookmarks made on one
  device should open on the user's others, so the key cannot be
  device-derived; and the group document `us` is plaintext to relays by
  ruling (`engine/src/vault.rs`), so it cannot live there. It lives in a
  visor-owned document that rides the app-document machinery under the
  reserved id `polyvisor:visor` (`engine/src/visor.rs`) — keyhive-sealed,
  synced and checkpointed like any app tree, for free. The same
  document holds the **install table**: a random 16-byte id per (user,
  app), minted on first launch. The URL names the install, not the
  package, so the concept of "an install" exists before installs are a
  user-visible act; two devices that mint before pairing converge on one
  key by automerge's last-writer-wins, and the loser's pre-pairing
  bookmarks stop opening — stated, not fixed.
- **The glue owns the URL bar.** `shell.open-frame` writes the fragment
  for the one open session, `close-frame` clears it, and an app's
  `route.set` is relayed by the frame to the glue, debounced, encoded by
  the kernel, and written with `history.replaceState` — never
  `pushState`. The back button is the visor's; an app gets no history
  entry. Routes over the cap (238 bytes) are refused and the bar does not
  move.
- **Consumed once, after unseal.** The visor reads `shell.fragment`
  exactly once per page load, at the first identity read that finds the
  device open, and hands it to `apps.route-decode`; a sealed device
  consumes it after the unseal ceremony. Nothing about the fragment runs
  before the hue is painted, so a URL cannot influence the
  grey-until-unseal sequence. `hashchange` is ignored: there is one
  launch path.
- **Sharing is foreclosed here, by construction.** Only this user's
  devices hold the key; another device answers "this link is not one
  this device can open". A future shareable form is a different `kind`
  with its own envelope and its own policy, not a relaxation of `app/`.
- **Struck: pairing codes in the fragment.** A code is either short
  enough to type or key material that does not belong in a URL at all;
  the fragment was a transport looking for a route.

## Pins, with reasons

| Dependency | Pin | Reason |
|---|---|---|
| Rust | 1.98.1 | current stable; satisfies stream-dom (1.98), subduction (1.91), keyhive (1.90) |
| `wit-bindgen` | `=0.60.0`, workspace-wide | must equal stream-dom's pin: `StreamReader<u8>` (a wit-bindgen runtime type) crosses the delegation from our world's `run` into `stream_dom_dioxus::driver::run`. Different wit-bindgen versions *can* coexist in one component (the `wasip3_task_set` weak-symbol ABI exists for exactly that), but not across a shared runtime type. Bumps follow stream-dom's. `generate!` never sets `async: true`: that lowers sync WIT functions (resource constructors) async, which the canonical ABI forbids and only the translator catches; WIT's own `async func` annotations are the source of truth |
| `@polyengine/*` | 0.6.7, one version across the graph | first release where an async export may park on a guest waker (#292) without the 0.6.6 lift regression (#312); brand symbols are per-version, so a partial upgrade fails at `instanceof` |
| `dioxus` | `=0.7.10` | dioxus-core state is shared with `stream-dom-dioxus`; skew breaks the build |
| polymorph-stream-dom | git rev (see Cargo.toml / deno.json) | unpublished, moving; policy object and asset handles landed in #15; the Dioxus `asset:<hex>` attribute spelling landed in #19 |
| subduction | git `sansio` rev | above |
| keyhive | git rev `a509a2d` | `keyhive_core` / `keyhive_crypto` / `beekem`, unreleased and moving. The sealed plaintext is keyhive's own `Envelope` and the read-back walk is keyhive's own `try_causal_decrypt`, so a rev bump is a wire-format change for every stored blob: its own PR |
| `@polymorph/*` | 0.6.1 (webcrypto, websocket), 0.6.2 (webrtc-datachannels) | the cuts current at the polyengine 0.6.7 pin; taken within the `^0.6` range |
| polymorph-iroh | git rev `8ca991e` | the endpoint component is built from source, not taken from the jsr package: the runtime binds its identity through `identity-from-seed`, which the package gates behind the cargo feature `guest-ed25519-signing` and its published artifact excludes. `just endpoint` clones and builds the pin; the vendored `runtime/wit/deps/polymorph-iroh/iroh.wit` is that revision's |
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
  encryption of every *app* tree, so relays and stores hold app content
  as ciphertext only; the group's keyhive membership derived from the
  user-system document. Two trees stay plaintext by ruling:
  `polyvisor:us`, because it is what tells a device which group — and so
  which keyhive document — it belongs to, and it carries only endpoint
  public keys and petnames a relay already sees; and the keyhive-events
  tree, keyhive's own signed, content-free operation log. Enrollment is
  total read-back: the adder hands the joiner every content key it holds
  over the SAS-authenticated pairing connection, so a new device reads
  the group's entire history; the read-back window for shared documents
  is an open policy item, and shared documents do not exist yet.
  Sequenced after M3b because device↔device sync already runs inside
  authenticated QUIC — content encryption is what untrusted *storage*
  (M4) needs, and building the group first gives keyhive a membership
  to key.
- **M4** storage: Google Drive as the first (and, for now, only) dumb
  store — user-only, keyed object names, the OAuth ceremony split
  between kernel (PKCE, exchange, sealed tokens) and shell (the popup),
  push and pull after every local change, at boot, and on demand; a fake
  Drive in e2e. Provider-as-component (the `provider` world, per-
  destination egress, the picker) waits for a second provider: one
  backend does not justify a boundary. S3 is deferred; Drive is what a
  person has.
- Parked, as issues: the passkey PRF unseal rung (#166), recovery kits
  (#167); app worker (above); native shell; JS producers; S3 and the
  provider component boundary (a second provider).

## polyengine is consumed from JSR

Found in M1: an import awaited from a Dioxus event handler never resumed
until the next event. Root cause (polyengine, fixed upstream in #289): a
`driveAsync` loop parked on `Promise.race([...pendingHostCalls, ...])`
holds a snapshot; an export entered through the synchronous `drive` path
fires no driver-arrival, so a host call registered during it is
invisible to the parked race, and the settlement pump stands down while
the parked driver counts. A stream-dom producer is the routine victim —
its `readDirect` session keeps a driver parked whenever one long poll
is outstanding. The fix shipped in polyengine 0.6.4; the tree consumes
it at a caret JSR pin. `deno.json` sets `minimumDependencyAge` to zero:
polyengine releases are cut minutes before this tree takes them, and
Deno's 24 h age gate would otherwise refuse them.
