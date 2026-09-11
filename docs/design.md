# polyvisor — design record

Current architecture and constraints. Open questions live in the issue
tracker; implementation history lives in Git.

## Project maturity and tradeoffs

**This is an exploratory project with no users.** Architecture, APIs,
storage formats, and UI are unstable. Optimize for learning and cheap
revision, not production completeness. Existing implementation and tests
do not establish a requirement to preserve their behavior.

- Prefer the smallest implementation that establishes the requested
  behavior. Deletion, replacement, and narrower scope are valid outcomes.
  New abstractions, dependencies, configuration, and recovery machinery
  need a current requirement or demonstrated problem, not a possible
  future consumer or failure mode.
- Breaking changes are acceptable, including to public WIT and persisted
  formats. Update known consumers together; do not add compatibility
  layers or migrations unless a concrete consumer or data-preservation
  requirement is identified.
- Keep the stated correctness and confinement invariants. Where meeting
  them would require disproportionate machinery, narrow the feature or
  raise the tradeoff rather than silently weakening the invariant.
- Tests should buy confidence in a current claim at reasonable maintenance
  cost. Use the narrowest boundary that establishes it, with representative
  full-path coverage for integration. Real Chromium remains required for
  claims about pixels or browser realms; that does not require every
  runtime edge case to navigate the UI. Separate harnesses and mocks also
  have a cost: add them only when they simplify concrete testing needs.
- Fix races rather than teaching tests to repeat lost user actions. Revise
  or remove tests of superseded behavior instead of preserving it for the
  suite. Run relevant gates; scenario count and historical parity are not
  goals in themselves.

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
  panels. Versioned deliberately; breaking changes are allowed under the
  maturity policy above. Public describes the audience, not stability.
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
    this device. What the glue itself observes (a frame torn down by
   the receiver) enters the same path through `apps.abort`, so the visor
   has one source of truth for session endings; `apps.close` — the
   visor's own act — emits nothing.

Vendored dependencies live under each package's `deps/`
(`runtime/wit/deps/polyvisor-app` is a symlink to `../../../wit`). Two
versions of `wasi:clocks` and `wasi:sockets` are present (0.3.0 via
polymorph:iroh, 0.3.1 via WASI's consolidated release); polyengine keys
providers by semver track (`@0.3`), so both resolve to one host.

## No JSPI

Every embedder forces `jspi: false`; the browser floor is wasm
multi-memory. Use wit-bindgen's callback ABI and async host imports.
Filesystem operations use generated `wasi:filesystem@0.3` bindings,
not `std::fs` (whose synchronous imports cannot host OPFS promises).

The iroh endpoint uses `identity-from-seed`, enabled by
`guest-ed25519-signing`. Its synchronous TLS signer runs in guest memory;
a platform-held key requiring an async host call would need JSPI. The
trade is wasm signing and a copy of the device seed in the endpoint for
its lifetime, alongside the kernel's copy.

## The app frame

- An opaque-origin `srcdoc` document carrying its own `<meta>` CSP
  (`default-src 'none'`; `script-src` the loader's hash plus
  `'wasm-unsafe-eval'`; `style-src`/`img-src`/`font-src`/`media-src
  blob:` — the asset stylesheet is a `blob:`; `img-src` also `data:`, for
  the stylesheet's inline SVG backgrounds, which fetch nothing). CSP
  policies compose with the embedder's header policy, so the frame is
  network-dead regardless. `sandbox="allow-scripts allow-forms"`;
  `form-action 'none'`. The loader is a constant; everything variable
  (component bytes, port) arrives by `postMessage`.
- **The app component runs in the frame's main thread.** The stream-dom
  receiver binds to the frame's own DOM same-realm.
- **No worker inside the frame.** Dedicated workers require a matching
  origin; the sandbox has an opaque origin. Moving execution into a
  home-origin worker is deferred (#45) and would weaken containment of a
  guest-to-JS escape while enabling `worker.terminate()`.
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
  only fetcher and re-hashes what it serves. Bundles currently come from
  the home origin over `wasi:http`.

## The kernel is one component

Kernel (device store, sealing, sync scheduler, grants, sessions) and
engine (CRDT, group crypto, sync protocol) are crates in one `runtime`
component. Component-model linking is reserved for the untrusted tier
— providers, data services, apps — where a boundary buys confinement.
Inside the TCB it would buy a second WIT surface and marshalling for
nothing.

## Component-owned data models (direction)

Task semantics will move out of the engine into an ordinary service component.
There is no special "data model component" kind or elevated runtime trust tier.

- Components can export domain services, consume services through granted
  bindings, and hold partition-scoped document-history capabilities.
- Domain providers own their schemas, operations, migrations and domain access
  controls. They may be developed outside Polyvisor's core. The additional
  trust is the user's reliance on a provider to faithfully process data and
  mediate access for multiple consumers, not runtime privilege.
- Providers use Automerge directly as a library. The platform exposes history
  synchronization, not a generic Automerge object/transaction WIT API;
  synchronization is an implementation detail of the domain service.
- Apps can also access app-private document partitions directly through the
  same history interface. Service providers and UI apps follow the same
  component and partition confinement rules.
- A service binding does **not** grant access to the provider's underlying
  document history. The platform enforces partition access and service
  bindings and supplies trustworthy caller context; the provider enforces
  domain policy.

The first, trusted-Rust stage of this split is in place. `todo-model` owns the
task schema and operations, `visor-model` owns the encrypted visor route,
install, personalization, and adoption policy, and both operate on the
`document-history` crate's Automerge document adapter. The engine owns one live
document per partition plus subscriptions, encrypted publication/receipt,
in-memory history storage, compaction, and history snapshots; the kernel
composes model operations with that schema-neutral Rust interface and schedules
browser checkpoint persistence. These crates still run together inside the
trusted runtime component. No history WIT interface or separate provider
component is introduced yet.

## Sync engine: subduction sans-IO

The engine crate is a driver for `subduction_protocol::Node` (the
`sansio` branch: a pure state machine — `handle(now, event)`,
`poll_effect()`, `poll_timeout()` — with no IO, clock, locks or spawns)
through `subduction_runtime`'s traits in their single-threaded `Local`
form. Polyvisor owns five implementations:

| Trait | Implementation |
|---|---|
| `Transport` | one per connection over `polymorph:iroh` streams, relay-only: WebRTC is off in the worker because a SharedWorker has no `RTCPeerConnection` (the host backend never resolves there). Framing per `subduction_iroh` (u32 BE length prefix) so native subduction peers interoperate |
| `Storage` | an in-memory item store serialized into the sealed checkpoint with the automerge docs |
| `Policy` | group membership, read off the user-system document (`polyvisor:us`): a remote peer may read/write exactly while its key is a member. App-tree envelopes are keyhive's (M3c, `engine/src/vault.rs`) |
| `Signer` / `NodeEffect::Sign` | `ed25519-dalek` over the sealed device seed, also used by the iroh identity |
| `Clock` | `wasi:clocks@0.3` |

The sans-IO branch provides one driver loop that checkpointing can pause
and explicit signing effects. `subduction_iroh` is native-only; its wire
conventions are the reference, not its implementation. Native-peer
interop is deferred until a native peer exists.

App trees are keyhive-sealed. Two system trees remain plaintext:
`polyvisor:us` (group membership: endpoint public keys and petnames), and
the keyhive-events tree (signed, content-free operations). Keyhive's git
pin includes the transitive-authority fix separating relay access from
group membership. Pairing enrolls a device with the group's current
decryption heads, allowing it to read the group's history.

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

- **The index** (`store`) is the one unsealed record: id, local picker
  petname, tier, how the device rests, timestamps. Never the member label,
  shared hue/metadata or any key.
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
  same sealed checkpoint; the transport's TLS signer is in-guest (see
  "No JSPI"). Passkey unseal is deferred.
- **Checkpoints** are AES-GCM over the kernel's serialized state, written
  to `/<id>/gen-<n>/` on the OPFS root through `wasi:filesystem@0.3` after
  every mutation. Commit protocol: state, then MANIFEST (generation +
  digest), then the generation pointer in `kv` — the pointer is the commit
  point, a failed write never advances it, and a load falls back one
  generation. The kernel never lists a directory: `read-directory` is one
  of four sync functions left on the 0.3 track and its OPFS host answers
  with a Promise (JSPI), so every path is named from the pointer and
  removal reaches n+1 down to n-2 by name. A founder draws the hue and a
  random user petname from the RNG and writes them to the sealed visor document before
  exposure; later devices adopt that document during pairing. The kernel's
  device record only caches these fields in memory.
- **Switching devices is a reload** (`shell.switch-device`): the anchor
  changes and the page restarts against another worker. Erase destroys
  the namespace and the index row, then switches to a fresh device.
- **A tab with no anchor adopts the last kept device.** The glue keeps
  its id in `localStorage`, updated when `device.status` reports a durable
  device. Without this pointer, or after `switch-device(none)` clears it,
  a fresh tab mints a device. The pointer grants no authority: passphrase
  devices still open sealed. Explicit switching supports multiple devices
  in one profile.

## Visor and apps render through stream-dom

Both are Dioxus producers via `stream-dom-dioxus`. The visor runs with
no vocabulary policy (it is trusted); apps run under the frame policy
above. The visor is close to stateless: identity, hue,
trust table and boot cache are kernel state served over `device`/`apps`,
so the visor has no persistence import of its own and the same component
runs under a native shell.

A Dioxus component that writes a signal it never reads does not subscribe
to updates. Native tests cannot catch the resulting frozen UI, so visor
changes require browser verification.

## Routing

The page URL gains one thing: a fragment, `#app/<token>`, naming a
running app and a route the app chose, so "this app, here" can be
bookmarked. The fragment is the only place for it — it never reaches the
server, and it is the one part of the URL an app frame's `href` policy
already treats as same-document (`web/policy.ts`). Two parts, two
owners: the visor owns the grammar (`app/<token>` or `launch/<app-id>`;
unknown kinds are refused by `route-decode`), and the app owns the
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
  The same sealed visor document is the authority for the shared hue,
  user labels and per-app labels. User and device petnames are generated at
  founding/device creation; an app petname is generated before its first
  launch. Explicitly saving an empty petname generates and persists a
  replacement. Draft re-rolls happen synchronously in the visor from the same
  EFF generator using its own `wasi:random` import; no naming policy crosses
  the internal API. They are root scalar
  keys in collision-safe namespaces (`identity:`, `user:`, `app:`), so edits
  to different fields do not replace a nested map. Device labels remain
  member records keyed by endpoint public key in plaintext `us`; the local
  index petname remains only the browser-profile picker label. Pairing sends
  the established group's visor snapshot inside the SAS-authenticated
  enrollment exchange. The joiner merges its route/install history, then
  adopts the group's personalization with a causally later field patch,
  retaining its own device label. A new founder seeds the empty
  shared document once; a non-empty document is never reseeded, so a field
  deleted remotely stays deleted.
  The kernel may cache these values in memory for its synchronous core API,
  but does not serialize that cache; the engine snapshot is the sole durable
  copy.
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
- **The second kind, `launch/<app-id>`, is for installed apps.** A web
  app manifest's `start_url` is written once into the OS's app registry
  and replayed unchanged for months, and it names an app the launcher
  displays by name and icon anyway. The `app/` token fits that badly
  twice over: its opacity hides what the taskbar shows, and its key
  binding turns a route-key convergence — an engine event the user never
  sees — into an installed app that opens to a refusal. So an install
  opens at `launch/<package>`: plaintext, keyless, resolved by
  `route-decode` to this user's install of the package at route "". It
  carries no app-controlled data, so the residual channel of `app/` does
  not exist for it, and it *is* shareable — another user's visor opens
  their own copy — which is the correct meaning of "open this app" and
  the sharing `app/` refuses. Once the frame is up the bar switches to
  `app/` as for any launch. Each package installs as its own app
  (`shell.install-app`): the manifest's `id`, `start_url` and `scope`
  are written absolute against the page's base (`new URL(".",
  location.href)`, the same base the OAuth return uses — never `/`,
  which on a project Pages site is somebody else's page), so a `blob:`
  manifest resolves nothing relative to itself and the same package on
  the same origin is the same installed app on every device. The icon is
  the user's saved glyph for that package, painted white on the user's
  hue at 512 and 192. The PNGs are not files the build ships: the page
  paints them at install time and puts them in a dedicated versioned
  Cache Storage cache (`polyvisor-launcher-icons-v1`) under
  `launcher-icons/<sha-256-of-the-image>.png` URLs — real `https:` URLs
  under the page's base, never `blob:` — and a service worker registered
  lazily on that same press answers them. The digest names an icon by
  its content, so a repaint gets a new URL instead of overwriting art
  something may still hold; it is not a secret, since the space of
  glyph-on-hue images is small enough to enumerate. The fetch handler
  intercepts exactly those URLs and passes everything else through
  untouched — not an offline cache — and a URL it has no image for is a
  404, never the app shell. No saved glyph, or a worker that does not
  come up in time, falls back to the framework's static icons; art never
  blocks an install. The cached art is **unsealed** (plain PNG bytes
  readable by anything with the browser profile, unlike everything the
  kernel stores) and **evictable** (dropped under storage pressure, and
  the URLs 404 until the next install repaints them). It carries one
  glyph on one hue, and no app data, key material or identifier.
  What this does NOT settle is Android. A remote WebAPK-minting server
  cannot reach a service worker at all — its responses exist only inside
  this browser — so a worker-served icon reaches the launcher only if
  the install uses image bytes the browser itself fetched. Which of the
  two the Android path does is the open question, and only a real device
  install answers it: nothing observed in desktop Chromium is evidence
  either way, and a previous install having succeeded says nothing about
  why. The `blob:` manifest is untouched meanwhile — kept as the working
  Android baseline rather than traded for a guess. Apps distributed off
  the home origin will need that answer, and a global app identity,
  before `launch/` can name anything but a registry id. Chromium only; iOS
  partitions storage per home-screen app, so a per-app install there
  would be a device of its own. Unverified and to be probed: that the
  fragment survives in `start_url` (a `?launch=` query is an acceptable
  fallback for this kind exactly because the package id is public).

## Pins, with reasons

Versions live in the manifests, lockfiles, `rust-toolchain.toml`, and
`justfile`. Constraints on changing them:

- `wit-bindgen` and Dioxus must match stream-dom's versions: Rust types
  cross their shared boundary. WIT's `async func` annotations control
  lowering; never blanket-enable `generate!`'s `async: true` for sync
  resource constructors.
- Polyengine packages sharing branded runtime values must resolve to the
  same version. The tree consumes releases from JSR; dependency age is
  zero so fixes can be tested immediately.
- Keyhive owns the stored envelope format; upgrading it may change that
  format. Subduction's sans-IO APIs are also unreleased and moving.
- The iroh endpoint is built from the revision in `justfile` with
  `guest-ed25519-signing`; the published artifact omits that feature.
  Its vendored WIT must match the source revision.

## Delivery

- Rust producers (Dioxus), browser embedding. One SharedWorker per device;
  tabs may share a device. Multi-device tests use isolated browser contexts
  against a local relay and fake Drive.
- Gates: `cargo test` (native, per crate), `deno test` (glue), and
  Playwright on real Chromium for every claim about pixels or realms.
  The archive's scenarios are reference material, not a parity obligation;
  retain coverage for current claims rather than historical scenario names.

### Deferred scope

Passkey unseal (#166), recovery kits (#167), app worker (#45), native
shell, JS producers, and additional stores. Drive is the only provider;
a provider-component abstraction waits for a second one. Shared-document
history policy is undecided; shared documents do not exist yet.
