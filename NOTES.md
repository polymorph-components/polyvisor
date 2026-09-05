# polyvisor design notes

Consolidated from the founding design discussion (2026-08-16).

**Status: nothing in this document is finally decided.** It records the
design sketch, the analysis, and the current leanings that the tracking
issues start from. Open questions live in the issue tracker, not here;
when a topic is resolved, the ruling and its rationale land in this
document (or a dedicated doc it links) and the issue closes. Sections
marked **provisional plan** sit between leaning and ruling: adopted as
the working plan, converted only by their named checkpoints. There are
no per-surface `@unstable` gates: **the entire framework is unstable
until declared otherwise**, so a stability annotation would state
nothing — a gate that does not bind produces the wart without buying
the compatibility.

## What this is

A framework for building PWAs that inverts the standard web application
architecture: applications run client-side under user-controlled
capability confinement — a permissions model in the spirit of modern
mobile OSes, but cross-platform because the "OS" is a set of browser
primitives the framework composes.

The moving parts, as sketched:

- The user selects a **home origin**, trusted to faithfully serve the
  framework as static content and to act as an isolated browser origin.
- **Applications are WebAssembly component-model components.** The
  framework instantiates them against designed host interfaces; what an
  application can reach — network, user data, peers — is exactly what
  the user granted.
- **Application UI is embedded in the component** and rendered in a
  sandboxed iframe (srcdoc/blob-style documents, minimal sandbox
  flags), talking to the framework over postMessage RPC. All external
  interaction goes through managed RPC; the UI frame itself has no
  direct network.
- The framework provides **data services**: realtime synchronization
  (component-iroh + automerge), durable backup and non-realtime sync
  (pluggable storage backends), and fine-grained application access
  control under user consent.
- **Peer-to-peer interaction** between users is mediated by the
  framework: a common contact list, data sharing, and realtime
  collaboration (iroh + automerge again), end-to-end encrypted.
  Multi-device sync for one user plausibly unifies with multi-user
  sharing by modeling a user's devices as identities in a permissive
  group.

### Why components

The wasm component layer is an expensive bet; what it buys, explicitly:

1. **Capability enforcement by construction.** Permissions are the
   linker: an application's imports are satisfied, stubbed, or left
   unlinked according to grants. There is no ambient authority to
   confiscate — the interface *is* the sandbox (see
   [Permission model](#permission-model)).
2. **The same application logic runs headless** — on the user's other
   devices, an always-on personal node, or (consciously; see
   [Compute placement and push](#compute-placement-and-push)) a
   provider. Background execution is the classic PWA weakness;
   component-iroh's deployment matrix (browser / native / in-guest)
   exists for exactly this.
3. **Language-agnostic applications** with typed, versioned interfaces
   (WIT) instead of an ad-hoc JS API.
4. **Merge and agent logic stays portable and confined** — app-supplied
   code that must run where the data is can be run without trusting it.

The cost is developer experience; that is a first-class topic
([Developer experience](#developer-experience)), because porting
friction is what killed the closest prior system (Sandstorm).

## The substrate

The polymorph family already de-risks the bottom of the stack:

- [polyengine](https://github.com/polymorph-components/polyengine) runs components
  runtime-linked on stock browsers and Deno — no transpile step, no
  engine flags.
- [component-iroh](https://github.com/polymorph-components/polymorph-iroh)
  gives browser peers real end-to-end QUIC over WebRTC data channels,
  relays, and UDP, with one Ed25519 endpoint identity across all paths,
  interoperable with upstream iroh.
- [polymorph:webcrypto](https://github.com/polymorph-components/polymorph-webcrypto)
  holds identity keys as non-extractable platform handles behind
  capability-shaped WIT (keys are resources; minting is separate from
  use).
- [polymorph:tls](https://github.com/polymorph-components/polymorph-tls)
  carries in-guest crypto under a wasm timing-class policy.
- [polymorph:test](https://github.com/polymorph-components/polymorph-test)
  is the cross-implementation conformance machinery.

The framework layer is the part that does not exist yet: the shell, the
linker-as-permission-system, the data services, and the consent UX.
Most of its hard problems are web-platform trust problems and
group-crypto problems, not wasm problems.

**Browser floor.** Recorded 2026-08-26 from design discussion;
direction, not final ruling. The execution model stands on two wasm
features: **JSPI** (the scheduler's park/resume — already a hard
runtime requirement; the worker host refuses to boot without it, and
the refusal is loud: the `no-jspi` code in
runtime/device-store/worker.ts) and **wasm multi-memory**
(runtime-linked composition). That pair is the floor, and it answers
the Safari headline question: **Safari does not gate launch**. The
Safari floor is a future release shipping JSPI and multi-memory —
hopefully early 2027 — and until it exists, Safari is out of scope
rather than half-supported. Launch targets the engines that ship the
pair today (Chromium-class; Firefox availability varies by build and
is tracked empirically by the worker host's refusal, never by silent
degradation). The Safari worst cases parked below (`webrtc 'block'`
verification, PRF availability, the 7-day eviction rule) are
second-order behind the wasm floor: they become the re-evaluation
checklist for the day such a Safari ships.

## Trust model

Proposed organizing invariant:

> **Nothing in the system is both live and trusted.**
> Trusted ⇒ static (the home origin's content, release artifacts).
> Live ⇒ untrusted by construction (relay, push service, storage
> backends, peers), covered by end-to-end crypto and capability
> confinement.

The invariant is checkable and forces the right question every time a
feature wants a server: *can this be static, or can it be untrusted?*
If neither, the feature changes shape.

The home origin is **completely trusted** — it ships the code that
holds every key — but it is only required to faithfully serve static
content. Two statements, both true, kept distinct:

1. Static-only makes the origin much *harder to compromise*: no request
   handlers, no injection surface, no sessions, no database, no
   per-user code paths.
2. Static-only does *not reduce the damage* of a compromise. Exposure
   is total either way.

The design buys (1) and accepts (2) consciously.

Residual attack surface of a static origin: the DNS/registrar account,
TLS issuance (CAA records and CT-log monitoring are the cheap
mitigations; key pinning is dead in browsers), CDN/cache poisoning, and
— realistically the largest — the framework's own release/build
pipeline. Static-only has one structural consolation: every user is
supposed to receive byte-identical releases, so third-party monitoring
("does this origin serve the published hashes?") is meaningful in a way
it never is for a dynamic origin. Caveat: per-user subdomains weaken
naive canary monitoring — a compromised wildcard origin can serve clean
bytes to `canary.host` and different bytes to `alice.host`.

Client-side TCB: the framework release, the browser, the OS.

Candidate explicit non-goals (to be confirmed in the threat-model doc):
metadata privacy (relays, push services, and the origin see traffic
timing and contact-graph shape), browser/OS compromise, covert channels
between colluding same-browser code.

## Home origin contract

"Static" is not just bytes; the load-bearing fine print:

- **Headers are security configuration, not content.** CSP must arrive
  as headers (the app-frame story depends on header-CSP inheritance;
  meta CSP cannot express `frame-ancestors`/`sandbox`/reporting and has
  parse-order caveats), plus COOP/COEP if `crossOriginIsolated` is ever
  needed (wasm threads / SharedArrayBuffer), `Permissions-Policy`,
  HSTS, `X-Content-Type-Options`, correct `application/wasm` MIME for
  streaming compilation, CORP on assets fetched cross-origin (the
  sandbox origin pulls from the framework origin).
- The **service worker** is a static file, but its scope and update
  behavior are part of the contract.
- The real hosting requirement is therefore "static host **with header
  control**" — naive S3/GitHub-Pages setups do not qualify unmodified.

Natural artifact: an **origin conformance checker** — a page/CLI that
probes a candidate home origin and passes/fails it against the pinned
contract (headers, MIME, SW scope, subdomain/PSL posture). Self-hosters
get a gate instead of a footgun list.

Static-only dividends worth actively exploiting:

- **Accountless multi-tenancy.** If every subdomain serves identical
  framework bytes and all state is client-side/E2E, "signing up" at a
  hosted provider is a purely client-side act. The only dynamic control
  plane a multi-tenant host needs is wildcard DNS plus a wildcard cert.
  Squatting is moot when the server holds no identity.
- **Static share-link viewing for non-users**: a reader page plus
  ciphertext from a storage backend plus the key in the URL fragment.
- **Push without a server** (see
  [Compute placement and push](#compute-placement-and-push)).

**Per-user content: answered.** Recorded 2026-08-26 from design
discussion; direction, not final ruling. The home origin serves
per-user content **never by default**: the byte-identical model above
is the trust story, and a host that can serve one user different
bytes is a host that can target them — the accountless dividend and
the constant-digest monitoring predicate
([Release integrity](#release-integrity)) hold precisely because
there is nothing user-specific to vary. Where per-user serving exists
at all, it is an **explicit opt-in to a lower trust regime** — the
"third origin class" already named under
[Addressing and discovery](#addressing-and-discovery): live-ish,
user-controlled, untrusted, never sharing the framework origin. The
expectation on record: this opt-in is a **developer-oriented option**
(publishing one's own records and content) rather than an end-user
surface; users who never opt in keep the full trust story untouched.

## Release integrity

Positioned as supply-chain hygiene and publisher/host separation — not
as the trust-model foundation (the origin is trusted; see above).

**The bootloader shape, refined to a constant root.** Recorded
2026-08-17 from design discussion; leaning, not ruling; tracked in
[#3](../../issues/3), writeup on the thread. Nearly everything
content-addressed and immutable (hash-named assets,
`Cache-Control: immutable`). The founding sketch had a single tiny
mutable root changing per release; the refinement makes the root
**constant**: a trivial entry HTML (registers the SW, nothing else)
plus a bootstrap service worker, both immutable-forever in the honest
case. The SW embeds the publisher root keys, fetches a small mutable
**signed release manifest**, verifies it via WebCrypto (Ed25519 +
SHA-256 — no crypto code frozen into the bootstrap), fills the Cache
API with content-addressed assets verified at cache-fill time, and
serves everything — including navigations, so post-install even the
entry HTML comes from verified cache — at real URLs with real headers
(correct wasm MIME for streaming compilation, strict CSP with no
eval/blob loading; execution semantics stay boring). A release ships
new assets plus a new signed manifest; the root files never change.
Floor note: two files, not one — a SW must be a same-origin
URL-addressed script registered from a document, so the HTML shell can
only be made trivial enough to inline-audit, not eliminated.

What it buys: the canary predicate for every monitor collapses to a
**constant** — "this origin serves digest X at these two URLs,
forever" — instead of a moving target tracked against a release feed;
any root change is prima facie compromise or a rare, loud, signed
bootstrap upgrade. And publisher/host separation gets teeth: in the
honest-root case the **publisher key gates what code runs**; an origin
operator deploys releases but cannot author them. Users trust the
project, then pick any host.

What it cannot buy, stated plainly: **the web platform has no pinning
primitive**. SW registration takes no integrity metadata (no SRI for
SW scripts), and the browser's SW update check fetches the script
directly, bypassing the SW's own fetch handler by spec — a compromised
origin ships a replacement bootstrap within ~24h or next navigation.
First visit and post-eviction are TOFU from the origin. The founding
sketch's circularity acknowledgment therefore stands: this is
detection-shaped, not prevention-shaped, and acceptable under the
trust statement. Detection layers that stack on top, roughly in order
of cost: CT-log monitoring of origin certs; third-party monitors
comparing origins to the pinned root digests (now a constant check);
peers gossiping (release version, root digest) over iroh — targeted
delivery, freezes, and rollbacks become detectable by cross-checking
with contacts; an optional verification extension (the Code Verify
precedent — cheaper here, pinning two constant hashes rather than
tracking releases). Isolated Web Apps (Chromium signed web bundles)
are the real install-time fix but sacrifice cross-platform PWA
delivery — a possible future tier, not the baseline.

The hard sub-problems, named (crib TUF's role structure rather than
re-derive it):

- **Rollback**: signatures alone admit replay of an old signed
  manifest; the SW persists a monotonic release version and hard-fails
  on regression.
- **Freshness**: advisory only — hard manifest expiry would brick
  offline use, which local-first exists to serve. Staleness warnings
  plus the multi-device gossip cross-check ("your origin served v37,
  mine saw v42") cover targeted freezes.
- **Root rotation inside a never-changing file**: embed k-of-n root
  keys and accept TUF-style signed root-rotation chains from the
  baked-in set — otherwise key loss is pin suicide (the HPKP lesson)
  and key compromise forces the alarm event.
- **Eviction = re-TOFU**: storage eviction (see
  [Key lifecycle](#key-lifecycle)) silently wipes the rollback counter
  and verified cache; detect and surface the downgrade, never paper
  over it.
- **Frozen bugs**: every bootstrap bug lives until a root change — the
  exact event monitors alarm on. The bootstrap stays tiny,
  dependency-free, and format-versioned from day one, with a defined
  loud upgrade path: a new root signed by the root chain, so monitors
  verify continuity rather than merely noticing change.

## Origin topology

Under the static-only model there is no server-side tenant state, so
per-user subdomains are about **client-side** isolation:

- On a shared browser/machine, each user's device keys and grants live
  in a different origin's IndexedDB/OPFS — a sandbox escape or
  framework bug in one user's session has a bounded blast radius.
  Quota separation comes along for free.
- A dedicated **app-sandbox origin** (serving the iframe skeleton with
  its own headers) is wanted regardless of per-user subdomains — see
  [App-frame sandboxing](#app-frame-sandboxing).

Mechanism note: browser process isolation is per **site** (eTLD+1), not
per origin — subdomains of one registrable domain may share a process
(`Origin-Agent-Cluster` is only a hint), and siblings can set
`Domain=`-wide cookies at each other. **Listing the parent domain on
the Public Suffix List fixes both**: each subdomain becomes its own
site (real site isolation, no cross-subdomain cookies, separate
storage-partitioning treatment; the github.io model). Costs: a PSL PR,
propagation lag, effective irreversibility, wildcard DNS + wildcard
cert (fine with ACME DNS-01).

Browser storage is origin-rooted, so **origin migration = device
re-enrollment**: new origin, empty storage, and non-extractable device
keys do not move — by design. That is acceptable iff
enrollment-from-another-device is a polished, cheap ceremony (wanted
anyway; see [Identity and devices](#identity-and-devices)). Identity
must not be made origin-portable by making device keys extractable.

## Who runs home origins

Recorded 2026-08-26 from design discussion; direction, not final
ruling. The former headline open question, answered: **both, from day
one** — a project-affiliated public instance and first-class
self-hosting, with the explicit goal that neither is the degraded tier.

- **The flagship instance.** 1.0 ships with at least one
  project-affiliated public instance with per-user subdomain isolation
  (the `alice.polyvisor.app` shape): the accountless-multi-tenancy
  dividend cashed ([Home origin contract](#home-origin-contract)) under
  a PSL-listed parent ([Origin topology](#origin-topology),
  [#4](../../issues/4)). Possibly, some day, à la carte paid services
  on top — turnkey storage backend first — as the instance paying its
  own bills and as an ecosystem booster, not as the point.
- **Self-hosting is first class.** Minimal — ideally zero — capability
  gap against the public instance, in two supported shapes: **turnkey
  static deployment** (Netlify-class hosts, subject to the
  header-control fine print above; the conformance checker
  ([#2](../../issues/2)) is the gate, not a footgun list) and
  **full-stack self-hosting** (home origin + iroh relay + storage
  backend, docker-compose-class). One structural gap to state
  honestly: per-user subdomain isolation needs wildcard DNS + cert
  control, which turnkey static hosts do not delegate — a turnkey
  deployment is a single origin, fine for a personal instance, and the
  checker should report which posture it verified rather than pretend
  the two are identical.
- **Relay posture follows the delivery artifact.** Recorded 2026-08-26
  from design discussion; direction, not final ruling. The turnkey
  static scripts/instructions default to a public relay instance
  (project-affiliated), so the static path keeps the **split view**
  from the metadata note under
  [Parked and candidate non-goals](#parked-and-candidate-non-goals) by
  default: the origin operator sees code fetches, an unrelated relay
  sees contact timing, and no one party holds both. The full-stack
  self-host bundles its own relay and skips the public default — one
  operator does see both halves there, and that is acceptable because
  the operator is the user. A configurable default, not a hardwired
  one, in both artifacts.
- **Shells beyond the tab.** A "native" (webview) app shell,
  eventually. A webextension is on the table in two roles, separately
  decidable: an app shell, and a **visor trust root for hosted
  instances** — the Code-Verify-shaped detection layer already named
  in [Release integrity](#release-integrity), grown from monitor to
  root. The extension-as-shell half keeps its question mark.
- **Onboarding teaches the trust relationship.** New-user docs and the
  first-run tutorial ([#37](../../issues/37)) state plainly what a
  host can and cannot do — serves static bytes anyone can verify, sees
  traffic timing, holds no keys and no content — the trust statement
  in the user's own language, not the threat model's.

## App-frame sandboxing

Mechanics:

- **The app frame is an opaque-origin `srcdoc` document carrying its
  own `<meta>` CSP** (ruled 2026-09-05, [#142](../../issues/142),
  measured in Chromium and Firefox). `srcdoc` documents inherit the
  embedder's header policy — which must allow `connect-src` to the home
  origin and relays — but CSP policies COMPOSE: every policy must pass,
  so a meta `default-src 'none'` inside the frame makes it network-dead
  regardless (zero requests out, against three for the meta-less
  control). The formerly "clean" alternative, a dedicated sandbox
  origin serving the skeleton with real headers, is ruled out on a
  different axis: a service worker never sees a sandboxed frame's
  navigation, so a real-URL skeleton is served raw by the host, outside
  the release-integrity path and unpinnable. `srcdoc` is pinned by
  value. A second origin therefore buys only Firefox process isolation,
  never confinement. Standing constraint: the srcdoc's inline script
  must also satisfy the visor's own header `script-src`, so its hash is
  known to whoever emits that header (build time on a static host,
  serve time from the bootstrap SW) — the loader is a constant;
  everything variable arrives by `postMessage`.
- The app UI frame gets **zero direct network**; assets arrive via
  RPC/blob injection from the component's embedded bundle.
- App logic runs in workers on the framework side (polyengine,
  runtime-linked); UI ↔ shell ↔ component is a two-hop RPC path,
  acceptable for UI latencies.

Residual channels, each needing a recorded ruling (allow/block/why) in
a **ruling table per sandbox flag and CSP directive** — the same
discipline as webcrypto's WPT-deviation registry:

- WebRTC: a sandboxed frame can open a data channel with no permission
  prompt; CSP3's `webrtc 'block'` covers it where supported (Safari
  support to verify).
- Speculation rules / prefetch / DNS prefetch; anchor `ping`;
  downloads (`allow-downloads` withheld); popups / top-navigation /
  form submission (sandbox flags withheld); fullscreen / pointer lock
  (withheld); favicon and other UA-initiated fetches.
- Covert timing/contention channels between colluding code: candidate
  explicit non-goal, stated rather than discovered.

Anti-spoofing: consent UI renders in the framework visor (formerly
"chrome") strictly outside
any app pixel rectangle; an app frame can always draw a *fake* prompt,
so real prompts must be distinguishable by position/visor, never by
content alone.

## Permission model

Enforcement **is** the linker:

- **Deny** = the import is never linked (fails at instantiation) or is
  linked to a stub returning a capability error (fails at call time) —
  which of the two, per interface, is a design decision.
- **Prompt-on-first-use** = sensitive host imports are async, so a call
  can suspend on a consent dialog with no app-visible API difference.
- **Revocation** = invalidate the resource handle with a defined,
  closed error case (the webcrypto error-variant discipline), never a
  trap.
- **Durable grants** keyed by (app, resource), reviewable and revocable
  in one place, with an audit trail.

Grant UX follows the **powerbox pattern** (Sandstorm's term): the
picker is the security boundary. Choosing a file/contact/document *is*
the grant, which kills prompt fatigue for the common cases; naked
permission prompts are the fallback, not the norm.

Dogfooding: storage backends (S3/WebDAV/Drive/...) and later protocol
bridges are themselves components whose network grant is scoped to
their own backend host and which only ever see ciphertext. "Pluggable
backends" is then the same plugin model with the same confinement
story, not framework code.

## Network capabilities

The honest exfiltration claim: **no unconsented flows — all flows
enumerable and auditable.** Not "exfiltration impossible": any app
granted both a data capability and any network/peer capability can
encode the former into the latter, and an attacker-controlled
destination is an exfil sink. (Mobile OSes quietly conceded this:
Android auto-grants INTERNET.) CSP and the sandbox get the UI frame to
genuinely zero *direct* network; the semantic leak through granted
channels is bounded by consent, not eliminated.

Design directions:

- **Per-destination grants** from a declarative app manifest ("talks to
  api.example.com"), not a blanket fetch capability.
- All app traffic through **framework-proxied fetch**, yielding an
  audit log a user can actually read ("this app sent 40MB to X
  today").
- **Capability-lattice install tiers**: pure-local apps install
  frictionlessly; "reads contacts + talks to the internet" gets a
  scary compound prompt. Flow-aware prompting (data classes ×
  destinations) is the differentiator over mobile-OS models.

## Data services

- **The ACL unit is the automerge document.** CRDT sync shares document
  history; sub-document read ACLs do not survive contact with the sync
  layer. Keep documents small (per-collection / per-object);
  cross-document indexing and query is the framework's job.
- **The framework owns automerge, host-side**, behind a typed WIT
  surface (a `polymorph:automerge`-shaped package): one implementation,
  one version, merge logic inside the TCB. Apps do not bring their own
  CRDT (version skew between peers, merge logic outside the TCB).
- Three distinct mechanisms, kept separate in the design:
  - **App read grants**: framework-enforced (it materializes what the
    app sees).
  - **Peer read grants**: encryption-group membership — cryptography,
    not policy code.
  - **Write grants**: signed operations validated at merge time by
    readers.
- **Backup**: encrypted snapshots + incremental chunks to dumb storage
  via provider components; iroh-blobs content addressing beneath;
  per-document keys; avoid convergent encryption. Design worked out in
  [Storage backends and the cryptographic pull layer](#storage-backends-and-the-cryptographic-pull-layer).
- **Multi-tab**: one sync engine per origin (SharedWorker / Web Locks);
  automerge tolerates the races, the write path shouldn't invite them.

Investigated 2026-08-16 (subduction as the replication layer): findings
on the [#8 thread](../../issues/8); direction in
[Provisional plan: group crypto and sync](#provisional-plan-group-crypto-and-sync).

## The content CRDT: the field, reviewed

Reviewed 2026-08-22 (automerge-repo, Loro, and the field) for adoption
or first-class support. Outcome: nothing adopted, no second CRDT gains
first-class support; automerge stays — now a checked choice, not a
default. Two risk-register updates at the end. Upstream facts below
carry their as-of date; they will go stale.

**The filter is the DAG spine, not CRDT quality.** The engine's unit is
chunk = one automerge change, cref = its `ChangeHash`, chunk parents =
`deps()` = keyhive pred-refs = sedimentree parents — a
content-addressed causal DAG — under the TCB rule above (one Rust
implementation, one version, in-guest). So the test a candidate must
pass: a Rust, wasm32-wasip2-viable document CRDT whose native change
unit is a content-addressed node in an exposed causal DAG. Only
automerge passes it.

- **automerge-repo — not a candidate; it is the co-embedder.** It is
  the JS host-side embedding of this same stack (Repo/DocHandle,
  storage/network adapters): adopting it moves merge and crypto out of
  the wasm TCB, and its classic sync protocol is the thing this design
  exists to replace (per-doc sync states, plaintext at the sync
  server, doc-ID-as-capability). Its live roadmap is this
  architecture: the subduction rebase ships from a parallel npm
  channel (`2.6.0-subduction.48` as of 2026-08-20, ahead of `latest`;
  tracking PR automerge-repo #601) with keyhive E2EE plumbing — blob
  interceptors, application secret chains — merged on that branch.
  Read: the provisional plan's bet is upstream's official direction,
  and automerge-repo is now a second production embedder of the same
  stack (subduction #274, wasm memory corruption, was reported from
  automerge-repo 2.6.0-subduction.44 — someone else is finding bugs
  on this path). Watch items: the application-secret-chain direction
  (keyhive #207) is the same envelope-delivery problem the
  `subduction_keyhive` bridge solves — re-check envelope compatibility
  when keyhive's bincode→bijoux encoding migration lands; the wire
  lineage stays shared, so cross-stack interop is a later option, not
  a rewrite. The Rust ports do not change the answer: automerge-repo-rs
  is dormant (last push 2025-10), samod is author-labeled experimental
  with wasm runtime support an open issue (samod #29).
- **Loro — the one credible rival, disqualified by its identity
  model.** Credit first: Loro 1.13.x is format-stable since 1.0,
  actively maintained, and ahead of automerge on types — movable tree,
  movable list, mergeable containers, shallow snapshots (a native
  strata analogue), history redaction, Peritext-criteria rich text —
  and it compiles unpatched for wasm32-wasip2 and runs under wasmtime
  (verified 2026-08-22; ~1.5 MB size-optimized), though upstream has
  no wasip2 CI target or support commitment (loro #655, #881). The
  disqualifier: change identity is (peer-id, counter); deps are OpID
  frontiers; there is no content hash anywhere in the model; change
  boundaries auto-merge over time (unstable units), and export bytes
  carry no canonicality guarantee. The whole spine would move into
  the framework — hash the emitted blob at seal time, carry an
  OpID-span → hash index as replicated state. Worse, and decisive: no
  Byzantine fault tolerance (Loro's own comparison table concedes the
  row to automerge). Write grants put members in the threat model
  (§Data services), and a member equivocating an OpID — two ops, one
  (peer, counter), shown to different peers — diverges replicas
  permanently; a content-address veneer can detect it (two blobs
  claiming one span) but cannot repair merge, which consumes OpIDs
  internally. Automerge excludes this structurally (identity = hash).
  Adopting Loro is a security downgrade paid for in features. A
  second first-class CRDT behind a data-service facade fails the same
  review from the other side: it spends the one-implementation rule
  and doubles the envelope, adapter, and cross-version-compat
  surfaces — for features, not properties. Keep Loro as the feature
  pressure list on automerge's roadmap: movable tree, mergeable
  containers (the concurrent child-container-creation footgun exists
  in automerge too), shallow snapshots, redaction.
- **The field, one line each.** yrs: healthy (NLnet/Ably/AppFlowy
  behind it), wrong model — state-vector deltas plus GC that rewrites
  history; no per-change identity to address. Jazz/cojson: the
  nearest rival *bundle* (content-addressed CoValue IDs, groups,
  E2EE), but history is per-session hash chains, not a change DAG; it
  replaces keyhive rather than composing, and 2.0 is an undocumented
  alpha mid-pivot. p2panda: content-addressed hash-DAG logs — the
  right shape — but no document CRDT at all (their own editor pairs
  p2panda with Loro). diamond-types: text-only, bus factor 1.
  json-joy: TS-only, now AGPL. cr-sqlite, Corrosion, Evolu,
  Fireproof, Willow, iroh-docs: LWW/KV models without causal history.
  DXOS: a TS platform *on* automerge — the layers it adds are the
  ones this framework already owns in-guest.
- **Risk-register update: the DCGKA fallback now has a shipping
  implementation.** `p2panda-encryption` 0.7.1 (Rust, MIT/Apache-2,
  NLnet-funded, transport-agnostic; DCGKA lineage, ~128-member
  groups; an audit by Radically Open Security announced) is a
  maintained group-keying crate that deliberately diverges from
  keyhive — and cites it. The fallback price recorded in the topology
  bullet (dropping keyhive means rebuilding op-sync and policy
  enforcement) still stands, but the group-keying half of that branch
  is no longer a from-scratch build. Watch item, not a dependency.
- **Risk-register update: automerge has no peer.** Nothing surveyed
  offers the Rust + wasm + content-addressed-causal-DAG combination,
  so the CRDT layer is load-bearing without an understudy — the
  conversion checkpoints gain weight accordingly. Upstream state as
  of 2026-08-22: core automerge is the healthy layer (0.11.0 current,
  ~6-week cadence, two funded full-time maintainers, format stable
  across 2→3, the Hexane engine rewrite landed); every layer above it
  is pre-release by its own authors' labels; subduction #268 (the
  ~2,400-doc freeze, on exactly this design's doc-count profile) has
  a candidate fix unmerged (subduction PR #273), #274 (wasm memory
  corruption) and #283 (transient false heads) are open; keyhive
  #136/#137/#206/#216 are open with zero comments (the first two ~15
  months); the threat-model doc is still a heading-only stub; the
  BeeKEM preprint ([eprint 2026/1434](https://eprint.iacr.org/2026/1434))
  formalizes the CGKA only — the content envelope remains unreviewed;
  and the bincode→bijoux encoding migration is announced, i.e.
  pinned-pair migrations are scheduled work, plural.
- **Why this stays cheap to revisit.** CRDT choice is app-invisible
  by construction — data-service facades, the WIT surface,
  migration-as-new-doc as the named schema tool — so a wholesale
  migration, if the checkpoints ever fail, is a framework-internal,
  bounded job. The option stays cheap *because* there is one CRDT;
  first-class support for a second would spend the property that
  keeps it cheap.

## Storage backends and the cryptographic pull layer

Recorded 2026-08-16 from design discussion. Leaning, not ruling;
tracked with the storage issue.

**The backend is live + untrusted and its contract collapses.** It
stores ciphertext and enforces nothing semantic. Because chunks are
content-addressed and append-only, and each device writes only its own
signed head manifest (readers merge all manifests), no backend needs
conditional writes, listing, or ACLs. The required contract is:
authenticated owner PUT/DELETE, plus GET by unguessable name. That
admits S3-anything (R2, B2, AWS, MinIO, Garage), consumer drives used
as dumb stores, static HTTP hosts, CDNs, IPFS. Non-realtime sync falls
out: a blob store populated this way is a passive replica, and it
provides the one thing relays do not — asynchronous sharing (the
recipient fetches while the sharer is offline).

**Sharing needs no backend ACLs: the pull tier is cryptographic.**
Read access is already keyhive's (BeeKEM epochs). The pull tier —
who can *fetch bytes* — becomes name secrecy: per (doc × epoch)
**name-keys**, object name = HMAC(name-key, cref), optionally an outer
in-guest AEAD hiding keyhive envelope metadata from name-holders.
Name-keys travel over the E2E contact channel like any capability
("signed URLs, self-issued"); recipients need no account on any
backend. Revocation rotates the name-key alongside the BeeKEM epoch —
future objects are unfindable — and compaction relocates old objects
(the same job as PCS re-encryption). A mirror/GC service can hold the
name-key alone: the relay role reconstructed on a backend that has no
concept of it, keeping keyhive's `Access::Relay` ≈ name-key possession
uniform across realtime and storage. Read keys keep flowing through
keyhive's op stream (itself stored as blobs); the pull layer never
carries them. Lineage: Tahoe-LAFS capability strings, Cryptree/Wuala,
Peergos.

**Cooperative fetch revocation (the K_p indirection).** Some of the
fetch-revocation ACLs provided is restored by indirecting pull-key
pickup through a small deletable object: per recipient device, the
current name-key wrapped at a location derived from the pairwise
prekey secret — deleted by any of the owner's devices upon ingesting a
revocation. The honest-client discipline: **pull-layer keying material
is never persisted** — fetched per session, held in memory; content
caching is untouched (local-first requires it). Effect, by adversary:
an honest-but-uninformed revoked client (offline during revocation, or
withheld the ops — the normal delivery posture) goes dark on its next
session rather than polling until rotation; a modified client that
persisted the name-key keeps fetching already-named objects until
relocation — rotation + GC remain the only hard boundary; a
provider-colluding peer voids the pull layer wholesale (out of scope
by construction, which is also why object-versioning resurrecting a
deleted K_p is a config note, not a break — the Vanish failure mode
does not transfer). This is **cooperative revocation** — a
protocol-honesty assumption about remote clients, categorically weaker
than every other guarantee here — and the UX must not imply hard
denial. Revocation is then four layers behind one button: BeeKEM
rotation (read, hard), name-key rotation (pull-forward, hard), K_p
deletion (pull-now, cooperative), compaction relocation (pull-past,
hard, eventual) — plus, for the owner's own devices, **storage
credential rotation** (see the scenario below).

**Motivating scenario: stolen device, cracked offline later.** Theft
at T0, revocation at T1, crack at T2 > T1. The thief gets content the
device had reached by T0 and the persisted keyhive state (BeeKEM
secrets are in-guest, necessarily), which decrypts already-reached
history — the irreducible floor. They do not get: post-T1 epochs
(PCS), any pull-layer material (never persisted — crefs on disk map to
no fetchable name), a K_p bootstrap (prekey secrets are on the device,
but the object was deleted at T1), or the owner's bucket (credential
rotation at T1). Compromise narrows from *everything the device could
reach* to *everything it had reached* — and the layers act at T1,
independent of T2: revocation races the crack, not the theft, which is
what disk encryption and platform key storage buy time for. Caveats:
a crack or undetected theft before revocation is just an authorized
device (forward layers only); hardware-held identity keys survive a
crack (the webcrypto posture), BeeKEM secrets cannot — epoch rotation,
not key hardware, carries history-forward safety.

**Accepted losses vs backend ACLs** (for the threat model): no
retroactive fetch-denial against modified clients until relocation;
harvest-now-decrypt-later exposure widens from provider+members to
provider+name-holders (bounded by rotation; names leak like URLs —
logs, history — unlike keys, so prefer *expiring* URL minting as
hygiene where the backend offers it); egress abuse by name-holders on
paid-egress backends (default to private buckets + minted URLs there;
name-secrecy mode where egress is free or flat); provider metadata
unchanged (sizes, timing, and now recipient *counts* via K_p objects;
tree-ids in paths pseudonymized by the name-key already).

**Spike executed 2026-08-16 and passed**
([spikes/storage/](spikes/storage/README.md), tracked in #19): SigV4
signed in-guest via polymorph:webcrypto against a real MinIO; the
dumb-store contract confirmed sufficient (unsigned LIST and PUT
refused); an account-less recipient read via K_p → name-keys →
manifests → chunks over pure name secrecy; and the stolen-device
scenario ran as an executable assertion — a cracked-image resurrection
reads successfully *before* revocation and retrieves nothing after it
(K_p 404, no derivable names), while the owner's second device rides
the rotation. The wasip3 http client's wit-bindgen runtime (0.57) is
isolated in its own fetch component composed via `wac plug` — the
component model resolving runtime-version conflicts, and the fetch
import doubling as the per-destination network-grant seam.

**The provider contract generalized 2026-08-17** (capability profile and
per-backend analysis on the [#19 thread](../../issues/19)): what varies
across consumer backends is which *pull-tier mechanics* they can enforce
— client-chosen names, derivable addresses, anonymous fetch, revocable
bearer capabilities, per-identity grants, expiring URLs. The pull tier
becomes a strategy chosen per profile; the E2E-travelling capability
becomes a tagged union; revocation-shaped operations report their
guarantee class (hard/cooperative × immediate/eventual) so the
cooperative-revocation UX rule is machine-carried. Draft WIT:
[wit/blobstore.wit](wit/blobstore.wit) — required floor (put/delete with
overwrite-in-place at stable addresses, fetch-under-capability,
owner-only listing) plus profiled `pull`, with the name-secrecy strategy
as a framework-core component composed above floor-only providers.
**Dropbox spike executed 2026-08-17 and passed**
([spikes/dropbox/](spikes/dropbox/README.md)): the link-capability
strategy over live consumer Dropbox — folder shared link as container
capability, plain derivable names beneath it, pickup objects as stable
per-recipient files with their own revocable links, overwritten in place
on rotation. Revocation is **hard, retroactive, sub-second**: a cracked
image that deliberately hoarded the container link (labeled no-persist
violation) reads before revocation and retrieves nothing after — the
assertion name secrecy cannot make; pull-now + pull-past collapse into
one `revoke_shared_link`, pull-forward is a re-mint on the same folder
(zero data movement, relocation/compaction unnecessary for revocation on
this backend). A 27-assertion raw-HTTP probe suite pins the platform
facts (ancestor-link leaf rule; no existence oracle; refusal statuses
wobble 400/401 — assert classes, not codes; API-host CORS clean for
browser recipients; app secret degrades to a public identifier in any
shipped client; free tier gates expiring links and caps at 2 GB).
Provider order updated: Dropbox and OneDrive lead the consumer-drive
tier (path-addressable, revocable links; OneDrive adds
`redeemSharingLink` durable grants — Azure-signup friction gates its
probe); **Google Drive drops to last** — server-assigned fileIds break
derivable addresses, and its candidate shapes (Apps-Script adapter
restoring GET-by-derived-name with no OAuth surface; account-ACL
folders; link-shared folders with fileId indirection) are recorded on
the #19 thread.

**Both strategies now run under the engine, in the browser**
(2026-08-17, [spikes/demo/](spikes/demo/README.md)): the engine's
storage surface takes a `store-config` **variant** (`s3 | dropbox`),
`store-grant` returns an optional pull capability (none under name
secrecy; the minted pickup link under Dropbox), `store-revoke` returns
its **guarantee note** as prose (the blobstore draft's guarantee class,
surfaced to the UI), and `bucket-pull` takes an optional pickup link so
a link-tier recipient can pull with no storage account. Verified live in
the page: three replicas converge over Dropbox + iroh; the tablet cold
boots from the bucket with `iroh conns: 0`; a *collaborator* pulls the
bucket through his standing pickup link under app auth alone
(`pulled dropbox(link)`); and after revocation the same button reports
`pickup link refused (409)` — hard, provider-enforced — while the same
peer holds live-wire ciphertext he cannot decrypt (`undecryptable: 1`).
Both exclusions, both tiers, in one UI.

**Provider order.** First: one **S3-compatible provider component**
(R2 and B2 as documented defaults — real 10 GB free tiers, R2 free
egress; MinIO/Garage cover self-host) — no external approval gates,
SigV4 is HMAC via polymorph:webcrypto (class A), network grant scoped
to one backend host (the dogfooded confinement). Fast follow: Google
Drive **as a dumb store** (15 GB, broadest accounts, `drive.file`
scope, appDataFolder; start the OAuth-verification clock early) — its
native ACLs are no longer required for sharing. WebDAV/Nextcloud
later for self-host breadth (CORS is the dragon). The #11 recovery
bundle is the special case that needs public-fetch mode: its name and
KEK both derive from the recovery phrase — fetchable with no prior
keys, by construction.

## Group crypto

The MLS question, structurally: MLS assumes a delivery service imposing
a linear order on group-changing commits; concurrent commits fork the
group. This system is partition-tolerant and peer-to-peer — concurrency
is the *normal case* — so raw MLS fights the architecture.

Candidates for the decision memo:

- **MLS** (RFC 9420) plus some ordering layer over gossip — fights the
  grain; forks and retries need connectivity to a sequencer.
- **DCGKA** (Weidner/Kleppmann et al., ["Key Agreement for Decentralized
  Secure Group Messaging with Strong Security
  Guarantees"](https://eprint.iacr.org/2020/1281)) — group keying
  designed for causal broadcast and concurrent membership changes.
- **Keyhive / BeeKEM** ([Ink & Switch](https://www.inkandswitch.com/keyhive/))
  — capability-based auth plus concurrency-tolerant group keying
  purpose-built for automerge sync. Closest-fit prior art; at minimum
  steal its decomposition, possibly track as a dependency.

CRDT-specific considerations MLS discussions won't surface:

- **History handoff**: what a new member/device receives (full history
  vs snapshot) is a policy knob with security meaning — it sets the
  read-back window.
- **Post-compromise security is weaker in practice** on a CRDT
  workload: history persists, so recovering from compromise includes
  re-encrypting the past — a rotation job, not a ratchet step.

Evaluation criteria: concurrency tolerance, spec/implementation
maturity, wasm-portability (must run in-guest or over
polymorph:webcrypto), and the FS/PCS actually delivered on a
sync-history workload rather than on paper.

Investigated 2026-08-16 (Keyhive code + design docs): findings on the
[#9 thread](../../issues/9); direction in
[Provisional plan: group crypto and sync](#provisional-plan-group-crypto-and-sync).

## Provisional plan: group crypto and sync

Recorded 2026-08-16 from the Keyhive/subduction investigation
([#9](../../issues/9), [#8](../../issues/8) carry the detailed
findings). Provisional: adopted as the working plan, converted to a
ruling only by the checkpoints at the end of this section. No
`@unstable` gates anywhere — the whole framework is unstable until
declared otherwise (see the status note at the top).

- **Group crypto (#9): Keyhive primary, DCGKA the named fallback, raw
  MLS eliminated.** MLS's delivery-service sequencing assumption is
  disqualifying for a partition-tolerant P2P system, and BeeKEM now has
  formal analysis for the decentralized case (cross-fork security;
  eprint 2026/1434) that DCGKA-era designs lacked. `keyhive_core`
  wraps behind a `polymorph:groups`-shaped WIT surface so the
  implementation stays swappable; identity signing routes through
  `polymorph:webcrypto` via keyhive's `AsyncSigner` seam (upstream
  already ships a WebCrypto signer holding a non-extractable platform
  Ed25519 key). Verified: `keyhive_core` + `beekem` + `keyhive_crypto`
  compile clean for wasm32-wasip2.
- **Sync (#8): v1 provisionally matches subduction — at three distinct
  layers.** The *domain model* is matched (sedimentree
  commits/fragments/summaries, pull policy, subscriptions: the
  vocabulary carries two paid design iterations — Beelay was scrapped
  wholesale, and the current tracker previews the mistakes a
  from-scratch design would repeat). The *WIT API* is ours, with
  subduction as the first provider behind it — mirroring its Rust API
  would export upstream churn to every consumer; the adapter absorbs
  it. The *wire and storage formats* are provisionally subduction's,
  pinned and tagged: upstream framing carries per-type schema-version
  bytes with reject-on-unknown — tagged, not negotiated. Verified:
  `subduction_core` + `sedimentree_core` + `subduction_crypto` compile
  clean for wasm32-wasip2; transports are thin (upstream's iroh 1.0
  adapter is ~1k LOC, so a `polymorph:iroh` transport is a small
  seam).
- **Cross-version compat is a day-one seam requirement.** The
  "framework ships both endpoints" mitigator holds within one user's
  devices under one origin, not across origins: release skew across
  the P2P graph is structural (origin A at release N syncs with origin
  B at N−3). The seam speaks N and accepts a defined window back;
  format generations are recorded; re-chunking/migration is a
  framework job.
- **Vocabulary adopted: pull / read / mutate / manage** (keyhive's
  access tiers). *Pull* — may fetch ciphertext, cannot decrypt — is
  the missing name for the untrusted-relay tier the trust-model
  invariant implies: it is precisely what a live-and-untrusted party
  checks.
- **Co-evolution posture.** Pin by exact version/rev; upstream
  protocol changes are migrations, not bumps (keyhive #213 — a BeeKEM
  change altering what trees mean, merged the day before the
  investigation — is the template). Track both repos and the
  keyhive-beelay Discord channel; upstream filings are individual
  decisions.
- **Recorded properties for the threat model (#1).** No forward
  secrecy, by design (causal keys: a chunk key discloses predecessor
  keys; the read-back window is a policy knob). The actual guarantees
  are PCS plus cross-fork security. Keyhive's bespoke content envelope
  (XChaCha20-Poly1305 with a keyed-BLAKE3 synthetic-nonce /
  key-commitment scheme, flagged CAUTION in their own design doc)
  requires independent review before polymorph data ships under it.
- **Spike sequence.** (1) `keyhive_core` as a wasip2 component,
  `AsyncSigner` over `polymorph:webcrypto`, membership/CGKA ops
  exchanged between two component instances over any dumb channel —
  the transport here is throwaway scaffolding, because production op
  sync belongs to the subduction bridge; the spike validates signing,
  embedding, persistence, and op semantics, and must not grow its own
  sync protocol. **Executed 2026-08-16 and passed**
  ([spikes/keyhive/](spikes/keyhive/README.md)): unpatched keyhive at
  pinned main runs as a component; cryptographic exclusion after
  revocation held under adversarial full delivery; the causal-keys
  no-FS trade observed; archive/restore works with the platform-held
  signer, and surfaced the dependency that durable browser state needs
  **platform key persistence** (feeds #11 and the webcrypto keystore
  design). (2) Subduction with a `polymorph:iroh` Transport
  implementation. **Phase 2a executed 2026-08-16 and passed**
  ([spikes/subduction/](spikes/subduction/README.md)): unpatched
  subduction at pinned main runs as a component — real handshake, sync
  convergence, and live subscription push between two instances over a
  host-shuttled wire; identity signing via `polymorph:webcrypto`. Two
  findings: wit-bindgen's `inter-task-wakeup` feature is load-bearing
  for the engine composite (without it, channel-sleeping tasks panic;
  with it, wasmtime serves them — the polymorph-iroh-era wakeup
  uncertainty resolves for the wasmtime leg), and
  `subduction_crypto::Signer::sign` is infallible, so platform-signer
  failures can only trap (keyhive's fallible `AsyncSigner` is the
  better shape; upstream-issue candidate). **Phase 2b executed
  2026-08-16 and passed**: the same guest composed with the
  component-iroh endpoint via `wac plug` runs the identical scenario —
  subduction handshake, sync convergence, live subscription push — over
  a length-framed bidirectional QUIC stream through a stock iroh relay.
  Swapping wires touched zero subduction code (two ~30-line stream-pump
  tasks feed the same frame queues), which validates the transport seam
  the plan bet on. (3) The walking skeleton — automerge ↔ subduction ↔
  keyhive over component-iroh, all components — as the #8/#9
  validation artifact, which also measures the topology question
  below. **Phase 3a executed 2026-08-16 and passed**
  ([spikes/skeleton/](spikes/skeleton/README.md)): the full content
  path in one engine composite per peer — automerge chunks encrypted
  under BeeKEM epochs, ciphertext envelopes as sedimentree blobs,
  synced over the iroh wire — with **one platform-held identity
  backing both layers**, and the **pull/read separation enforced by
  cryptography**: a revoked member keeps receiving ciphertext over the
  live subscription and cannot read it, while readable history stays
  readable. Design finding: epoch membership at *seal* time determines
  readability (a BeeKEM add is not retroactive), so the data layer
  must encode "create → add members → first seal", and late joiners
  read history only through causal keys via post-join chunks. **Phase
  3b executed 2026-08-16 and passed**: the `subduction_keyhive` bridge
  wired in — membership travels over a second stream of the same iroh
  connection, and the keyhive auth graph gates subduction's pull
  policy. Both tiers demonstrated: pre-membership and post-revocation
  pulls refused (empty diff, no information leak); crypto exclusion
  unchanged beneath. Two upstream findings: **subscriptions bypass the
  pull gate after revocation** (push path does not re-check fetch
  policy; explicit pulls refuse correctly — upstream-issue candidate),
  and **the two upstreams version-skew** (the bridge pins released
  keyhive, which predates the BeeKEM ratcheting change; a
  `[patch.crates-io]` onto the git rev compiled clean — pin keyhive and
  subduction as a *pair*).   The bridge also assumes the identity
  unification (peer id = 32-byte verifying key = keyhive identifier),
  confirming the one-key-per-device design. (4) The engine spike
  (#20 G1+G2). **Executed 2026-08-16 and passed**
  ([spikes/tasks-engine/](spikes/tasks-engine/README.md)): the
  skeleton's content spine generalized to the real automerge change
  DAG — chunk = one automerge change, cref = its `ChangeHash`, chunk
  parents = the change's `deps()` = keyhive pred-refs = sedimentree
  parents, one DAG across all three layers — with the first data
  service, `polymorph-data:tasks@0.1.0`, served from inside the engine
  composite (demo-v1 topology). Three instances (two devices + a
  collaborator) over a real relay: a genuine concurrency fork merges
  (a chunk with two parents exists), replicas converge, a revoked
  member is crypto-excluded while a remaining member rides the
  rotation in ~100 ms. Two integration findings:
  **`KeyhiveProtocol`'s event cache must be refreshed after locally
  created ops** (`sync_keyhive` serves a `PeriodicEventCache` once one
  exists; upstream's runtime refreshes on an interval — embedders that
  skip the runtime must `refresh_cache()` before syncing or every
  post-cache local op, e.g. the post-revocation rotation, is silently
  never offered to peers), and **one-shot bridge syncs need a retry
  discipline** (the spike re-syncs from read polls that find
  themselves waiting; upstream intends a periodic loop).   With the
  cache refreshed, the post-revocation ciphertext did *not* reach the
  revoked subscriber — the 3b "subscriptions bypass the pull gate"
  observation is timing-dependent, not unconditional (context for the
  #17 draft). **G3 executed 2026-08-16 and passed** (same spike): users
  are keyhive GROUPS of device individuals — the partition is delegated
  to groups, devices decrypt transitively, subduction's policies
  resolve access transitively, and the two demo failure stories are one
  mechanic at different graph nodes (removed collaborator = revoke
  bob's group from the doc, zero ciphertext bytes even reached him;
  lost phone = revoke the device from the user group, ciphertext
  arrives and decrypt refuses). Cross-user linking is by **card**
  (export the *individual's* reachable events — the group-agent export
  excludes the group's own constitutive ops); the bridge's reachability
  model offers a group's ops only to its members, so **cards must be
  distributed to every member instance** — a one-device paste
  intermittently wedged the un-carded device at `KeyNotFound`
  permanently (~1/3 of runs; op-arrival order dependent; open upstream
  question whether a pending foreign-group delegation should wedge
  epoch derivation).   Product consequence for #10: received cards are
  replicated state (carry them in a doc the user's devices share), and
  the individual-card export leaks every membership the person can
  reach — scope before product exposure. **G4 executed 2026-08-16 and
  passed** (same spike): one engine, both sync paths. The same keyhive
  envelope bytes feed sedimentree (realtime, iroh) and bucket objects
  (non-realtime, MinIO via the storage spike's in-guest SigV4 +
  fetcher component — three wit-bindgen runtimes in one composite);
  name-key epochs rotate with revocations; **K_p is wrapped to keyhive
  contact-card prekeys** (`Active::export_prekey_secrets` +
  `ShareSecretKey::derive_new_secret_key`; the picked prekeys ride in
  the object, so no prekey-set agreement is needed); **the keyhive op
  stream is stored as per-device name-keyed blobs**, which makes cold
  start real: a tablet with zero lifetime connections K_p-bootstraps,
  ingests the oplog, decrypts history, authors through the bucket
  (its chunk reaches live members over the wire — one DAG, both
  surfaces), rides a revocation epoch via K_p republish, and ends at
  full state (`iroh conns: 0`). The revoked collaborator is dark on
  both surfaces (no live bytes; `kp missing (404)` at the bucket).
  Findings: the name-key keychain is DOC state (pulls adopt it before
  any flush — a privately minted keychain publishes to underivable
  names); K_p locations are id-derived in the spike (existence
  probeable; production wants a pairwise-secret location — needs a
  stable pairwise-DH story over rotating prekeys, #19/#10); the
  storage spike's dumb-store contract needed nothing new.   Remaining
  #19-scope items unchanged (R2/B2 quirks, TLS, GC/compaction,
  credential rotation, Drive provider).   **G5 executed 2026-08-16 and
  passed** (same spike): the identity-bundle/keyslot design (see §Key
  lifecycle, "The identity bundle and unlock spectrum") — export with
  argon2id-passphrase + PRF-shaped slots, wrong passphrase refused,
  restart from bundle + bucket alone, restored device authors and the
  tablet accepts (8 tasks end state). **G6+G7 executed 2026-08-17 and
  passed** ([spikes/demo/](spikes/demo/README.md)): the end-to-end
  TodoMVC demo — the SAME engine composite translated (~200 ms) and
  instantiated (~30–50 ms) under polyengine **in the browser**, three panes
  (alice laptop, bob live over the iroh websocket relay, alice tablet
  bucket-only with zero connections), the todomvc surface guest's model
  swapped to `polymorph-data:tasks` with the app's import wired
  directly to the engine instance's export, every demo beat driven
  through the real UIs: three-replica convergence over both sync
  paths, tablet cold boot + cold authoring, live revocation (bob holds
  ciphertext he cannot decrypt — `undecryptable: 1` visible in-page —
  while the tablet rides the rotation). Findings recorded in the spike
  README: deltic 0.1.0 embedder-convention renames vs the sibling
  ports' stale pins (websocket port vendored+migrated; upstream
  migration owed), browser bundling needs the webrtc node backend
  externalized, the first-sync policy race reproduces at browser
  timings (gate on kh-knows-agent(doc)), one observed
  subscription-push miss (bounded by reconciliation pulls; Deno soak
  clean — upstream repro owed), background driver calls serialized
  page-wide after an overlap freeze.
- **Topology leaning: one engine composite, one keyhive instance.**
  `subduction_keyhive` is an in-process wrapper that *holds* the
  `Keyhive` instance, implementing subduction's connection/storage
  policy traits against it and carrying membership-op sync. Keyhive
  therefore instantiates once, inside the same component as
  subduction; the framework-facing groups surface
  (`polymorph:groups`) and the sync surface are separate WIT exports
  of that composite — consumers cannot tell it is one component.
  Splitting groups and sync into separate components would either
  duplicate keyhive state or rebuild the ~9.7k-LOC bridge across a
  component boundary that sits on per-request policy hot paths.
  Failure asymmetry, named: dropping subduction leaves the groups
  surface untouched (op transport gets rebuilt or forked); dropping
  keyhive drops the bridge too, so the DCGKA fallback includes
  rebuilding op-sync and policy enforcement — the fallback's true
  cost. One more consequence: a relay is the same composite in a
  second role — membership view plus pull policy, no content keys.
- **Conversion checkpoints (provisional → ruling).** The spikes prove
  component embeddability; convergence/partition gates expressed in
  polymorph-test go green; scaling is measured against our doc-count
  profile — doc-as-ACL-unit multiplies document count, and upstream
  subduction #268 (collections freezing at ~2,400 documents) sits on
  exactly that path. Risk facts that stay visible while provisional:
  subduction's bus factor (one primary contributor) and open semantic
  bugs (wasm memory corruption on reconnect, transient false heads);
  keyhive's empty upstream threat-model doc and open zeroization
  audit.

## Identity and devices

Leaning: **devices as leaves, a user = a group of devices, sharing
groups contain user groups.** The unification holds under failure:
"lost phone" and "removed collaborator" have the same mechanics
(rotate forward, treat history as exposed).

- Device identity substrate is already in the family: iroh endpoint IDs
  (Ed25519, the key is the address) held as polymorph:webcrypto
  non-extractable handles.
- User identity = a **signed device-list chain** (Keybase-sigchain-ish),
  wanting a small gossip/transparency story rather than a global
  directory.
- **Enrollment ceremony** (QR / short-authentication-string between
  devices) must be cheap and polished — it is also the origin-migration
  path and part of the recovery path.
- **Contact exchange**: out-of-band verification (QR/link), petnames,
  TOFU plus gossip cross-checks; no global directory in v1 (see
  [Addressing and discovery](#addressing-and-discovery)).

## Key lifecycle

Browser storage is evictable (Safari's 7-day script-writable-storage
rule for non-installed sites; `navigator.storage.persist()` is
best-effort; installed-PWA exemptions vary). Design assuming any single
device can vanish:

- **Device signing keys**: non-extractable and *disposable* —
  re-enrollment is the recovery, so it must be cheap.
- **The data-encryption root**: separate and *recoverable* — wrapped
  under a KEK derived from a recovery phrase and/or the WebAuthn **PRF
  extension** (hardware-backed; platform support floor to verify),
  backup bundle stored on the dumb storage layer.
- **Losing the last device must not mean losing the data.** Conversely
  the recovery path is the crown jewels and gets its own threat-model
  section. Escrow options (none / social / provider) deliberately
  deferred.

### The identity bundle and unlock spectrum (G5 record, 2026-08-16)

Decided for the demo, designed for the framework; executed in
[spikes/tasks-engine/](spikes/tasks-engine/README.md). G4's bucket
cold-boot collapses persistence to one question — *where does the key
live between sessions* — because all content rehydrates from the
bucket. The answer is **one sealed identity bundle** (keyhive archive +
identity key + partition refs) under a random bundle key held in
**keyslots**, LUKS-style; unlock methods are slots, not formats:

| slot | material | notes |
|---|---|---|
| passkey-PRF | 32B from the authenticator, one gesture | synced (vendor-trusting, survives eviction + new device) or hardware-bound (no vendor); support: current Chromium/Apple/Android yes, Firefox/Win10 tail no — feature-detect at enrollment, never at recovery |
| generated recovery phrase | ~8–10 diceware words (~100+ bits), argon2id as depth | the no-hardware fallback; never user-invented for replicated copies |
| passphrase + argon2id | human-chosen, work-factored | **downloadable device file / local unlock only** |

**The exposure rule (structural, not policy prose): wrap strength must
match ciphertext exposure.** Bucket-replicated bundle copies omit the
passphrase slot — nothing the *system* replicates is ever crackable via
human memory (brainwallet/LastPass lesson; we have no trusted server to
rate-limit guesses *by design*). The user's downloaded file may carry
the passphrase slot: custody makes it have+know. Local device copies:
either. Eviction reality: no browser artifact is durable — durability =
multiple devices + the recovery bundle; passkeys and files survive
storage eviction, IndexedDB (and the future keystore slice) do not.

Spike results and #11 data points: restart via bundle+bucket works
end-to-end (wrong passphrase refused; restored device authors and
others accept — CGKA leaf secrets ride the archive); polymorph:webcrypto
has **no private-key export at this rev** (extractability is recorded
mint-time policy awaiting the platform keystore slice), so exportable
identities are an explicit demo-grade `Soft` variant until the keystore
lands; **self-rotation secrets exist only in the archive** — a stale
bundle cannot reach epochs its own authoring created, so persisted
bundles refresh after authoring (or #11 designs a re-join path);
passkeys are origin-bound, so the origin-migration story must carry
re-enrollment, not credential portability.

## Compute placement and push

"One artifact across environments" tempts running app components
headless at a provider: always-on sync peer, push generation, agents.
The cost is stated plainly: **a headless host holds plaintext (keys)
for everything that component is granted.** Not a reason to skip the
feature — a reason to surface compute placement as a powerbox decision
("run an always-on copy at your provider: it will hold keys to X and
Y"), defaulting to user-owned always-on nodes (old laptop, phone
runtime), which component-iroh's deployment matrix was built for.

**Usable without the powerbox.** Recorded 2026-08-26 from design
discussion; a goal, not a v1 ruling. At least many apps must be
**usefully usable with no headless copy anywhere** — either because
they implicitly don't depend on always-on sync (local-first by
temperament, single user, one device at a time), or because
**asynchronous sharing through a storage backend** covers their
collaboration: the bucket path — ciphertext put/pull, offline
authoring reconciled later, cold-start from the bucket alone — is
exactly the machinery
[Storage backends](#storage-backends-and-the-cryptographic-pull-layer)
builds and the #20 demo proves. The powerbox decision above is an
enhancement for apps that genuinely need liveness, never a
prerequisite for ordinary use; a design where basic collaboration
silently assumes an always-on peer is out. What stays open is only
the smaller question: whether the powerbox version itself ships in
v1 at all.

Push, keeping the origin static: **the subscription is a capability.**
Web Push senders need only the subscription endpoint + VAPID key —
hand them (encrypted) to your contact group over the sync layer and
peers can wake your service worker directly, payloads E2E on top of
RFC 8291's transport encryption. Metadata cost: contacts learn your
push endpoint; the push service sees sender IPs. Open sub-question:
*who decides to notify* — peer-side decision logic covers
peer-triggered events; anything else needs something always-on. Taken
up in
[Wake hints and the notification broker](#wake-hints-and-the-notification-broker),
which also relocates the endpoint: registered with the user's chosen
broker rather than replicated across the contact graph (smaller
spread, one revocation point).

## Wake hints and the notification broker

Recorded 2026-08-19 from design discussion (triggered by the
Holepunch/Pear investigation — blind-peer / protomux-wakeup are the
deployed prior art for the relay-shaped half). Leaning, not ruling.
Extends [Compute placement and push](#compute-placement-and-push); the
relay role from the
[provisional plan](#provisional-plan-group-crypto-and-sync) gains a
second function: matching opaque wake tags against registered push
capabilities, alongside pull policy. Still ciphertext-blind.

**Three delivery regimes, one vocabulary.** "Tell a peer something
changed" splits by device state, with different cost models:

| regime | channel | hint form | false-positive budget |
|---|---|---|---|
| online | gossip topics / existing iroh conns | keyed tags; busy-window summaries may be AMQ | generous — a wasted dial |
| dormant | broker → Web Push → SW wake | exact, author-minted, wake-worthy only | ~zero — platform silent-push budgets |
| neither | — | maintenance defers to next wake/open | — |

Web Push is a notification channel, not a sync channel: every
SW-waking push must render a real notification (iOS strictly; Chrome
tolerates a trickle of silent ones), so **wake-worthiness is
author-declared at mint time** — the blind broker cannot classify;
the author can, for free. Every visible push is a full-reconcile
opportunity (the `waitUntil` window syncs *everything* pending, not
just the triggering doc): maintenance piggybacks on user-visible
events, and pure-maintenance latency is bounded by (next visible
event, next app open, periodic background sync where granted) —
acceptable by the local-first bet. Honest loss, stated: a dormant
device with a quiet social graph stays stale.

**Hint tags.** `tag = HMAC(k, class:value ‖ window)`. Keyed, or the
tiny attribute vocabulary makes the broker a dictionary oracle;
window-nonced, or tags are linkable across windows. Authors mint at
multiple granularities (doc, partition/service, scope) — the
hierarchy is load-bearing, not garnish: doc-as-ACL-unit puts
doc-granularity coverage at 10^3–10^5 tags, and per-recipient keying
(below) is affordable only at coarse granularity (O(scopes ×
recipients) per window, amortized over the window's events;
O(docs × recipients) is dead). Conjunctions are precomposed compound
atoms (bounded — tags-per-event is small; depth 2 has sufficed in
every case worked); general subset matching is not needed so far;
negation is inexpressible in positive tags — parked as an extension.

**Keying tiers and the clustering leak.** Scope-keyed tags (one key
shared by a group) let the broker cluster co-subscribers by identical
match history — contact-graph-shaped leakage. Pairwise per-recipient
tags are unlinkable and removal-free (removal = author stops minting
that recipient's tags; nobody else's registrations move) but cost
O(recipients) per mint. Leaning: **pairwise on the push path** (the
coarse tier makes it affordable), **scope-keyed on the gossip path**
(members are mutually known; the leak adds nothing). Broadcast-shaped
uses (power-law head, many-follower feeds) sit fine on scope keys —
following a head author is the least-secret fact in the graph — and
their fan-out economics (budgets force digest cadence; muting matters
most exactly where volume is highest) are the worked example behind
several rulings here.

**The wake tier gets its own rotation clock — the laxest one.**
Derived-tag registrations parked at the broker go stale on epoch
rotation, and a device asleep through rotation misses the very wake
that would tell it to re-register: epoch-coupled wake tags are
self-defeating for exactly their target devices (the dormant-wake
gap). BeeKEM makes read rotation O(log N), but that efficiency does
not extend to broker-parked derived state (N lazy re-registrations
plus the gap). So the tier table becomes: **read** — rotate on
removal, hard, O(log N); **pull** — per the name-key design; **wake**
— stable across removals, slow background rotation. A removed member
whose wake tags keep matching learns activity timing only — already
inside the metadata non-goal. Pairwise push tags are epoch-independent
by construction.

**The broker: minimal by force — the storage-floor collapse applied
again.** Everything sophisticated is expressible above an
equality-match primitive *if the broker makes scarcity explicit*.
Platform push budgets are the real constraint; the broker quota
propagates that scarcity upstream instead of simulating abundance the
browser will deny anyway. Quotas are the forcing function that pushes
throughput-heavy uses into richer layers, not ops hygiene. Irreducible
core: (1) fire push capabilities — dormant devices cannot wake
themselves; (2) exact-match opaque tags; (3) price abuse — verify
submissions against enrolled mint-keys with per-source and
per-registration budgets (unsigned submission = wake-bombing that
burns the victim's platform budget until the browser revokes the
subscription). Contract sketch:

```
register(tag, push-capability, budget-request, ttl) -> registration
unregister(registration)
enroll-mint-key(scope-key, rate-policy)
submit(tags[], signature)   // matches set per-registration dirty bits
```

Fire when dirty ∧ budget available; payload = matched tags up to a
small cap, else "something matched". No retention, no replay, no
ordering; at-most-once; lossy under budget — the guarantee class
declared in the contract (the `store-revoke` discipline). Sync
correctness never leans on wakes; reconciliation is the backstop.
Registration TTL is load-bearing: it bounds broker storage and imposes
a small re-registration heartbeat on live devices — a standing
liveness requirement, stated here rather than discovered as churn.
Budgets are subscriber-requested, broker-capped, cap discoverable
(the provider capability-profile shape).

**What the broker does NOT do, and where each job lands:**

- **Digests/batching** — author-side window-cadence minting, or a
  digest data service on an always-on node under the compute-placement
  powerbox (holds keys, filters for real, mints one exact wake). The
  budget forces high-volume feeds there.
- **Mutes/exclusion** — service-side filtering after a coarse wake, or
  channel-sharded tags minted upstream; the budget caps the
  wasted-wake cost of client-side discard.
- **Priority** — registration granularity: a pairwise high-priority
  tag with a generous budget beside bulk tags with stingy ones.
  Multiple registrations with independent budgets *are* the priority
  system; no broker feature.
- **Presence, read-state, ordering, replay** — data services and the
  sync layer, where they always belonged.

**Forward compatibility: degrade-to-floor.** v1 payload = exact tags
or the bit. One type byte inside the decrypted payload; unknown
encoding ⇒ "something changed" ⇒ over-sync. Invariant for every future
encoding: **narrowing hints only** — anything whose safe default is
not "sync all" (suppressions, obligations) is banned from this
channel. Recorded as the general rule alongside the subduction
posture: **reject-on-unknown for load-bearing state, degrade-to-floor
for advisory optimization** — misinterpreting state corrupts;
misinterpreting advice wastes a fetch.

**Extensions parked for re-examination, each with its trigger:**

- **Compressed payload middle tier** (Golomb/Bloom over matched tags,
  ~1.2 B/element vs 8): semantically inert, ships without a flag day
  under degrade-to-floor. Trigger: sustained overflow of the exact-tag
  cap — but instrument overflow as a client-side smell first (it
  usually means fine-grained registrations on the tier designed to
  exclude them; a comfortable overflow path would subsidize the
  misuse). Pad payloads to size buckets regardless — push services
  see ciphertext length.
- **Broker-side suppress-sets** (negation/mutes at the matcher): the
  first feature whose semantics depend on subscriber *intent* rather
  than tag equality — the camel's nose; priorities, digests, and
  read-state have equal claim once it's in. Trigger: evidence that
  service-side muting burns real budget at scale.
- **Conjunctive (subset) matching at the broker**: precomposed
  compound atoms have sufficed at depth 2 (e.g. author × tag).
  Trigger: a real consumer needing dynamic conjunctions an author
  cannot pre-mint.
- **Cross-scope atoms** ("author:X anywhere"): fundamental tension —
  cross-scope testability needs broadly shared keys, which collapse
  toward dictionary-testable. Revisit only with a mechanism in hand,
  not a wish.
- **AMQ window summaries on the gossip path**: already the right call
  where windows are busy (fixed size also hides activity cardinality);
  belongs to the gossip design rather than the broker contract.

**Metadata position (for #1).** The broker sees tags, timing, volume,
and match fan-out shape; with pairwise push tags it cannot link
recipients into groups beyond timing correlation. Within the declared
non-goal. Push services additionally see wake timing and unpadded
payload sizes — hence the bucket padding. The wake-worthy bit itself
leaks "this event was notification-grade" to the broker: one more bit
inside the same concession.

Prior art: blind-peer / blind-peering (Holepunch) — the deployed
ciphertext-blind always-on peer, with disk budgets and authorized
announce; protomux-wakeup — connection-scoped activity hinting; DP5 —
PRF-keyed presence queries against an untrusted server.

## Developer experience

Sandstorm's postmortem lesson: porting friction killed the app
ecosystem. This is existential for the app side of the design.

**Target developer: answered.** Recorded 2026-08-26 from design
discussion; direction, not final ruling. **Component-native is the
target persona** — the WIT-first surface is the product. Porting gets
real but bounded effort: componentize-js is the on-ramp, and the
expectation on record is that it supports everything this design
requires within the next few months. Framework compatibility
(React/Angular/Vue/Svelte) with minimal adaptations would be ideal and
is worth probing — but **drop-in compatibility is expected for nothing
of significant complexity**, and the porting story must not promise
it: "minimal adaptations" is the ceiling of the claim, measured
against real apps, not toy ones.

- A **componentize-js SDK** that makes a normal web app port
  mechanically: a `fetch` shim mapping to capability-checked host
  fetch, a storage shim (IndexedDB/KV-shaped) mapping to framework data
  services, templates (`polymorph create-app`). The in-family precedent
  is webcrypto-componentize (crypto.subtle over WIT imports).
- A **WIT-first surface** for component-native developers (Rust, ...)
  — the primary surface, now the persona question is answered; the
  SDK above is the on-ramp, not the center of gravity.
- The embedded-UI story needs an asset pipeline (bundle →
  srcdoc/blob injection) and a dev loop (local shell, hot reload).

## App publishing: transparency without a registry authority

Recorded 2026-08-21 from design discussion; leaning, not ruling;
tracked in [#52](../../issues/52). The framework-release half of this
story is [Release integrity](#release-integrity) (#3, one publisher,
constant root); this is the many-publishers half: how third-party app
versions publish such that targeted substitution, rollback and
freezes are DETECTABLE, without a registry anyone must trust.

The primitive is the **per-publisher append-only sigchain**: a
hash-linked chain of `(seq, prev, version, component-hash,
manifest-hash, timestamp)` signed by the publisher key, blake3
content addressing (iroh-native), carried as iroh blobs.
Offline-verifiable and self-certifying — Keybase's sigchain shape,
hypercore/SSB's fork semantics (a forked feed is invalid to anyone
who sees both branches). The visor enforces locally: linkage,
monotonic seq, **no fork ever observed, no rollback below
last-seen**. Every transparency design then reduces to one question —
who else's view do you compare against, since a lone client can be
shown a consistent lie (equivocation) or a consistent stale one
(freeze).

Layered answers, cheapest first, each subsuming none of the others:

- **Contact-graph gossip.** App heads piggyback on the contact/us-*
  sync that already exists; the visor alarms when a contact saw a
  different head for the same publisher. CT gossip famously never
  shipped in browsers — partly because browsers have no trust
  topology to gossip over; this design has one, and it maps to who
  the user would actually believe.
- **Witness cosigning.** k-of-n independent witnesses countersign a
  head before the visor offers the upgrade
  ([Sigsum](https://www.sigsum.org)'s minimalist shape; CoSi
  lineage). Witnesses attest extension, never content. Federated
  home-origin operators are the natural witness set — small,
  semi-independent, self-hostable, anyone can join.
- **Cross-entanglement.** Logs periodically embed heads of other logs
  they have seen (Haber–Stornetta linking; KSI's calendar
  industrially): rewriting one history means unweaving everyone who
  ever quoted it. No protocol beyond "include what you saw";
  detection strength grows with degree.
- **External anchors as witnesses, not authorities.** JSR (immutable
  versions, per-file sha256 manifests, sigstore provenance — measured
  2026-08-21: raw wasm served with open CORS and immutable caching),
  Rekor, OpenTimestamps: each is one more witness, none is solely
  trusted. The live registry serves bytes; belief comes from the
  offline-verifiable chain plus multi-path witnessing — "nothing is
  both live and trusted", applied to publishing.

**Freshness stays advisory** (same ruling as #3: hard expiry bricks
the offline use local-first exists to serve): witness timestamps with
expiry degrade to staleness warnings, and the gossip cross-check
covers targeted freezes. **Detection requires a response path**, or
the log is a diary: fork and rollback alarms are consequential
announcements in the visor's own voice (#22), and the petname table's
provenance line — "the visor fetched it as" — gains a verifiable
history rather than a bare name. Steal
[Chainiac](https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/nikitin)'s
skipchain forward-links so an offline client verifies an update chain
from ANY copy of it, no log query. Full-consensus registries are
ruled out: a token economy or a permissioned committee, plus
governance, for value the witness and entanglement layers already
buy. Open questions (log granularity, witness-set composition, fork
response semantics, publisher-key rotation via the TUF root-rotation
crib) are enumerated in #52.

**Delegated 2026-08-26: the mechanism half of this section moves to
polymorph-pkg.** The per-publisher log, witnessing, and anchoring
sketched above are now that project's design (an RFC 6962 Merkle log
in tlog-tiles layout rather than a bare sigchain, riding the existing
transparency-witness ecosystem; signed deployment manifests as the
unit of trust; work-in-progress and pre-publication at this writing).
[#52](../../issues/52) rescopes to what stays polyvisor's: the
contact-graph gossip layer (polyvisor has a trust topology pkg does
not — users comparing deployment pins over the contact graph covers
the split-view case against *this* user), the visor's fork/rollback
alarm and response UX, and the install-time consumption story
([Installing and managing apps](#installing-and-managing-apps)).

## Installing and managing apps

Recorded 2026-08-26 from design discussion; leaning, not ruling;
tracked in [#134](../../issues/134). The
[App publishing](#app-publishing-transparency-without-a-registry-authority)
entry is the many-publishers half of distribution; this is the client
half: what "install" means under a static origin, and what living
with many apps requires of the visor. Packaging is delegated: the
publishing/verification/delivery stack — per-publisher transparency
logs, signed deployment manifests (curator key, monotonic seq,
generation-scoped rollback floors, key succession and quorum
recovery), verified fetch by digest over untrusted mirrors
(https/OCI/iroh, streaming verification, unverified bytes never
entering wasm APIs), immutable caching with re-verify-on-load,
offline launch from a cached manifest — is **polymorph-pkg**'s design
(DISTRO-MANIFESTO.md / DISTRO-DESIGN.md in that repo; pre-publication
at this writing, so this entry binds to its manifesto-level shape,
never its schemas). Polyvisor extends the deployment manifest **by
reference, never by fields** (pkg's own ruling): app-level metadata —
requested capabilities/destinations (#7's manifest), service
dependencies, partition declarations, UI entry — is a polyvisor-typed
statement binding the manifest by digest.

**Install = adopting a deployment.** Under a static byte-identical
origin, installation cannot touch the origin; it is a purely
client-side act: the user adopts a deployment — manifest location
plus curator root pin — in one TOFU-shaped ceremony, and everything
downstream is pure mechanism. The ceremony is the user's one judgment
act, and it is the ceremony the visor already has: capability grants
per the install-tier lattice (pure-local near-frictionless, the
computed egress badge saying so; data+egress compounds get the scary
compound prompt; services stay the HealthKit-shaped moment) plus the
petname/mark naming ceremony — recognition vocabulary assigned before
the first pixel. After adoption the trust-compiles rule holds:
verification failure presents like a 404, and there is no "continue
anyway?", because a question the user cannot evaluate is a question
that must not be asked. One mechanism for apps, data services, and
providers — one component kind, consent weight varying by computed
profile — which retroactively gives the storage picker's "installed
but unconfigured" list its missing install mechanism. The v1 ambition
on record: full third-party install exercised end to end — launcher
plus install/update/uninstall of curator-signed apps — not merely the
release-carried set.

**The us-apps record.** An install is an entry in replicated account
state (a user-system partition doc, sibling to profile/marks/devices —
[#36](../../issues/36)): deployment identity, manifest location,
curator root pin, seq/generation floors, the grant set, partition
bindings, and the recognition pair. Install on the laptop, appear on
the phone; cold boot from the bucket restores the app set with the
account. Making the rollback floors ACCOUNT state is strictly
stronger than any single browser's storage: pkg's floors are
per-runtime persisted state whose loss resets to TOFU, and here an
evicted device re-learns the floor from its siblings — eviction stops
being a rollback window.

**Updates: silent adoption.** Manifest freshness IS revocation (pkg's
posture): holding an update back re-opens the revocation hole, and
version choice is a question users can't evaluate. The visor
announces, never asks — framework voice, petname inline per the
announcement policy, subject to priority-not-LWW (an update or
equivocation notice is exactly the consequential one-shot the
revocation-guarantee-note bug was about). Curator-root generation
changes (succession/supersession) are announcement-grade. A root that
changes WITHOUT a verifiable succession chain is not an update but a
different deployment — a re-install decision, never a silent
continuation. Pkg's manifest `version` is display-only, which lands
exactly on the three-voices rule: manifest-derived strings — display
name, version, self-description — are app voice (plated, quoted,
attributed) until the user has named the thing, and announcements
never carry them.

**The origin stays app-agnostic.** The release-carried core set ships
inside the framework's own deployment (today that set is honest: the
todomvc example and the provider panels; the split trigger is the
first core app needing off-cycle updates or uninstallability —
release-carried pieces are not uninstallable). No operator catalogs: a
mutable catalog reintroduces per-operator content variance, and
discovery is already parked as web-of-trust shaped. Third-party apps
are fetched from their curators' locations and verified client-side,
so the origin never learns the install set. Two tensions recorded
rather than hidden: **manifest polling is a per-curator phone-home**
(each installed app's mutable-fetch endpoint learns IP, install
status, and usage cadence — inside the metadata non-goal, but it
deserves the explicit line in #1), and **the #2 header contract needs
a connect-src ruling** (third-party manifest/mirror fetches from the
visor/worker want breadth the enumerated-hosts posture doesn't have;
app UI frames stay at zero network regardless).

**Bucket replication of app bytes: deferred, with the guard.** Pkg's
mirror model makes the user's own bucket a legal future mirror — a
mirror is a pure content-addressed byte store, which is the
dumb-store contract nearly verbatim — so offline independence from
the publisher is a transport-configuration line whenever it is
wanted, and nothing built meanwhile may preclude it. Until then,
per-device offline is covered by pkg's cached-manifest launch plus
immutable caching.

**Lifecycle and the launcher.** Runtime linking finally exercises
permissions-are-the-linker at launch time rather than build time:
each app instantiates against exactly its granted imports. Apps are
NOT visor pages: the launcher swaps the app rectangle beneath the
persistent strip — one foreground app at a time in v1, because
multi-window multiplies the anti-spoofing surface the strip was
designed for — and the strip stays the one anchor across apps. A
suspended app loses nothing by being suspended: the engine keeps
syncing its partitions regardless, because sync was never the app's
job. Commitment stays above the bar (the storage-picker template):
the grant act lives in drawer sheets, armed for the heavy tiers; the
OPENER CARRIES NO PAYLOAD rule extends to installs — an app or page
may request the install surface but passes nothing, which closes
app-driven install funnels by construction. The audible anchor word's
stated growth path ("every consent ceremony") covers install and
uninstall sheets. Suspend/kill affordances are honest only once
[#45](../../issues/45)'s workers land — a dependency of the
management UI, not just of execution. Two scale notes for the
launcher pass: the back chevron's null-or-one ruling meets its second
nesting level (launcher → management page → ceremony), and the
28-glyph app vocabulary meets many installs — collision repair
(us-mark already handles it) becomes routine, so the launcher leans
on petname and glyph together. Sub-question recorded in #134: whether
mark nomination moves from its mount-time read to the install-time
app statement — same `isAppMarkIcon` firewall, arrival before any
code runs.

**Uninstall is two ceremonies, and data outlives the app.** Per-app
partitions are the durable thing; apps are projections over them.
Keep-data uninstall (grants revoked, bytes dropped, the partition
orphaned with keep/rebind/erase) is an ordinary armed sheet;
uninstall-with-data-erase is heavy-tenant grade — armed + dimmed +
typed confirmation, framework policy, the erase-ceremony grammar.

**Governance made install-visible.** Browser quota is origin-wide, so
the framework does its own accounting, surfaced where installs
happen: per-app storage attribution (partitions make it natural),
doc-count budgets (the ~2,400-doc subduction wall multiplies with app
count), push/wake-tag budgets, and the egress audit ("this app sent
40MB to X today") hanging off the same per-app record.

**Parked, each with its trigger:** multi-window (its own design pass —
already parked); app-to-app intents (powerbox pickers cover the near
term; trigger: a real consumer); background app execution (trigger:
an app that genuinely needs liveness — #12 territory); app discovery
(web-of-trust recommendation shaped, never adjacent-equal to
installed lists — the picker ruling's discovery clause unchanged).

## Addressing and discovery

`user@host` addressing keeps trying to sneak a dynamic lookup back onto
the origin. Options:

- **Pure out-of-band contact exchange** (QR / links through the sharing
  layer): honest, static-clean, changes the product.
- **Per-user static records** (`.well-known` JSON, DNS TXT): a third
  origin class — live-ish, user-controlled, untrusted — which must
  never share the framework origin if it exists at all, and which
  complicates the byte-identical monitoring story and the accountless
  model.
- Nothing in v1.

**Answered: deferred, with a guard.** Recorded 2026-08-26 from design
discussion; direction, not final ruling. "Nothing in v1" is the
selection — contact exchange stays out-of-band (QR / links through
the sharing layer) — **unless deferral would preclude the feature
architecturally**, which is the actual content of this ruling: nothing
built in the meantime may foreclose `user@host` later. What the guard
means with today's vocabulary: the per-user static records option
stays adoptable (per-user serving is already specced as an opt-in
lower trust regime — see
[Home origin contract](#home-origin-contract) — and a discovery record
would be a developer/user opt-in of exactly that class); contact cards
remain self-certifying artifacts whose delivery channel is orthogonal,
so a host-served record later is a new transport for the same bytes,
not a new format; and first-contact verification ceremonies bind
regardless of how the card arrived, so a future host-served
introduction path inherits the existing backstop against prekey
substitution rather than needing a new one.

Related: the static share-link viewer (reader page + ciphertext + key
in fragment) covers "share with a non-user" without discovery
infrastructure.

## System services: one component kind, capability profiles

Recorded 2026-08-17 from design discussion. Leaning, not ruling;
tracked with the system-services issue.

**Data services.** The mobile-OS analogy has a second half beyond app
sandboxing: shared, permission-gated data models (Contacts, Calendar,
HealthKit, ContentProviders). Here they are **schema-authority
components**: a versioned service (e.g. `polymorph-data:tasks`) owns a
partition of automerge documents — schema, policy, migrations — and
multiple apps project it (list, board, velocity chart). User-space and
sandboxed (not TCB), extensible (not vendor-blessed), E2E-synced.
Refines the #8 wording rather than reversing it: the **engine owns
CRDT/crypto/sync mechanics** (one implementation, engine-held doc
handles behind the #8 WIT surface); **each doc has exactly one schema
authority** — its service, a singleton instance per partition serving
multi-version facades (never two service versions live over one
partition); **apps never touch doc surfaces at all**.

**One component kind.** Data services and egress providers (storage
backends, LLM APIs, protocol bridges) are not structural kinds — a
component's authority is its import set, and a parallel kind taxonomy
would be a second source of truth that can lie. They are **system
services** distinguished by *computed capability profiles*: the linker
derives and displays what a component can reach. The load-bearing
badge is **transitive egress-reachability** over the composition graph
— "pure: this code cannot reach the network" — which cannot lie and
correctly handles compositions (a pure service linked to an egress
adapter is not pure; the adapter is an exfil proxy and the graph says
so). Caveat recorded: the badge covers code paths; data a pure service
writes may still travel via other components holding read + egress —
that is #7's flow matrix (data classes × destinations), the badge's
complement. Obligations attach to capabilities, not kinds: doc-partition
authority ⇒ singleton/schema-authority/facade rules; egress ⇒
destination scoping, proxied fetch, audit, and the compound prompt when
combined with data authority. Splitting one service into
pure-data + egress-adapter is an **engineering choice where it buys
failure tolerance** (high-sensitivity data with peripheral egress,
user-swappable destinations, differing trust tiers), made cheap by
composition and incentivized (purity earns lighter review) — never a
forced classification. Where the egress is the purpose (LLM chat,
CalDAV bridge), a split boundary protects nothing.

**Defaults and rules that generalize:**

- **Per-app partitions by default, everywhere** (from the calendar
  observation): a service defaults each app to its own partition;
  shared scopes are explicit user grants. Stronger than the mobile-OS
  whole-store grant, nearly free since partitions are docs (the ACL
  unit).
- **Cross-service references cross ACL units**: refs-by-id with
  graceful absence, never embedded joins.
- **Bulk data** (photos): metadata docs + blob attachments via the
  storage layer's existing chunk/name-key machinery — a
  service-declarable pattern, already spiked.
- Consent UX gains the right granularity: installing a service is the
  big HealthKit-shaped moment; app↔service grants are semantic
  ("Kanban: Tasks read/write"); service compromise is bounded by
  partition blast radius plus the egress badge.

**Hard parts, ranked:** (1) **schema migration in a multi-version,
multi-peer CRDT world** — a v3 service migrating while an offline v2
peer writes v2 shapes is concurrent schema mutation; candidate tools:
forward-compatible schemas, write-new-read-both windows,
migration-as-new-doc with forwarding, and Cambria (Ink & Switch's
schema lenses); deserves its own decision memo, the data-layer
equivalent of the group-crypto memo. (2) **Governance/fragmentation**
— competing schemas kill interop (the WinFS/semantic-desktop failure);
the ContentProviders/HealthKit lesson: ship a small curated core set
(contacts, calendar, tasks, files/photos), each arriving with apps
that prove it; community services namespaced, not blessed. (3)
Services as high-value targets — bounded by the egress badge,
partition blast radius, and install-time consent weight. File systems
are the maximal case and must not shape v1 (doc-count scale wall).

Demo tie-in: #20's G1 contract should be `polymorph-data:tasks@0.1.0`,
the first data service; the follow-on demo is **three apps, one
service** (todomvc + kanban + velocity chart over one shared task
partition — the chart reading automerge history), which exhibits the
differentiator no platform has.

**The config-panel exception, executed 2026-08-17**
([spikes/demo/](spikes/demo/README.md)): #22's named exception — a
storage backend's config panel is an *app*, not the visor — is now real in
the browser demo, and it is the first place the capability story is
visible in UI. The visor owns the Storage dialog frame and provider tabs;
each provider ships a **panel component** mounted through the same
curated-DOM surface as the app (the dialog region is its `root()`
grant), which returns an opaque config blob the visor carries to the
engine. Two panels, deliberately unequal: the S3 panel imports only
dom/events/shell (**pure — cannot reach the network**, and says so),
while the Dropbox panel additionally holds a `fetch` import the visor
scopes to `api.dropboxapi.com` (refusing every other host with a WIT
err — the per-destination grant *is* the import) plus an
**oauth-broker** import, because navigation/popups/redirect handling
are visor capabilities: the visor runs the entire PKCE ceremony and hands
back only tokens. That is the powerbox shape at the provider boundary —
the sensitive authority (a network destination, an authorization
ceremony) stays outside the sandbox, and what crosses in is exactly the
capability. Recorded UI finding with framework reach: a status surface
mixing ambient telemetry with consequential one-shot messages needs
**priority, not last-writer-wins** (the revocation guarantee note was
being erased by a 4 s stats tick).

**The consent surface and kernel capabilities** (2026-08-17). Does the
unification extend to the permission dialog itself — a regular
component distinguished only by a sensitive import? **Yes at the
mechanism level, no at the trust level.** Mechanically the consent
renderer is the most confinable component in the system: its profile
is `grant-table` (propose/commit) + `trusted-surface` (visor-owned
rendering, exclusive input) + pending-request metadata — no doc
access, no egress, the "pure" badge on the thing that grants
everything else; and the curated-DOM surface mechanism (#16) can host
it in visor space unchanged. But three things break the "just a
sensitive capability" framing: (1) **self-reference** — every grant is
mediated by the consent surface except its own; its authority is
axiomatic, appointed by the release, the fixed point of the grant
system; (2) **the badge bottoms out** — computed profiles are
*displayed by* the consent surface, so a malicious renderer defeats
the display layer that would warn about it: at this boundary
derivation hands off to **attestation** (named in the signed release,
pinned by the shell — #3 doing what the badge cannot); (3) **failure
is different in kind** — a grant-table holder mints arbitrary
authority; that is TCB membership, not blast radius. Resolution:
**one component kind, stratified capabilities.** Ordinary
capabilities are consent-grantable; **kernel capabilities**
(grant-table write, trusted-surface, linker control, keystore root,
updater) are holdable by components — keeping the kernel
micro-kernel-shaped and the consent UI swappable — but granted only
through the **appointment path** (signed release + ceremony flows the
powerbox cannot itself perform), with holders enumerated in the #1
TCB statement. Precedent both ways: Android IMEs/accessibility
services prove regular-app-with-extraordinary-capability works and
warn that its grant path must be different in kind, not just
scarier-looking. The stratification is a gradient, not a wall:
grant-minting authority is **attenuable** ("mint grants only for
scopes this service governs"), so service-shipped **picker
components** (tasks-read + grant-mint(tasks:*) on a trusted surface)
realize the powerbox — the picking is the granting — with the
sensitive authority narrowed to the vocabulary the service already
owns.

**The visor graduates out of the spikes** (2026-08-20, [visor/](visor/README.md)):
the framework layer NOTES has been calling "the part that does not
exist yet" now has a directory. The DOM-op seam (backends, applier +
independent validation, guest surface, the serialized runner whose
pause/resume is input suspension), the frame isolation trio
(sandbox="allow-scripts", opaque origin, MessagePort op protocol), and
the system-UI core (strip, announcements, anchor colour, identity,
drawer tenancy with arming) moved to top-level `visor/{surface,frame,ui}`,
extracted from where they grew inside `spikes/todomvc` and
`spikes/demo`. Both spikes consume it: the demo keeps its flows
(petnames, credentials, pairing) as drawer tenants and sheet content
on the shared machinery, and the todomvc spike — previously
same-document rendering with a toy strip — now runs the SAME visor and
defaults to the **frame backend**, so the equivalence harness's app
renders into an opaque-origin iframe like the demo's panes (the
harness itself keeps the three same-realm backends: a differential
that needs to read the DOM cannot reach into the frame, which is the
point of the frame). "Kill" became real teardown: suspending the app
destroys its frame rather than blanking a div. Storage keys are
per-consumer config (`pm-demo-*` untouched, migration intact);
element ids stay fixed because position is a trust anchor; the
check-invariants greps follow the moved code (and were
canary-tested against it), and the demo e2e suite passed unchanged
throughout — no scenario edits, which was the extraction's definition
of "identical".

Blast-zone honesty, recorded after the fact
([#45](https://github.com/polymorph-components/polyvisor/issues/45)):
the isolation above is for PIXELS and FAULTS, not time or memory. A
guest trap is a promise rejection the runner survives by construction
(differentially tested — identical trap vectors across backends), but
the guest still executes on the visor's own thread, so a spinning app
wedges the kill button that would kill it. Apps run in workers
*eventually* — the surface's handle-table/op-queue split already fits
(ops could stream worker → frame with the visor's thread out of the
data path), and `worker.terminate()` is what makes the #22 kill
ceremony honest against a guest that never yields.

**Marks are glyphs, not colours; the anchor colour's job restated**
(2026-08-21, #22, executed same day). The per-app colour swatch is
gone: ten hues were never a discrimination vocabulary, and the
recognition-indicator literature (Schechter et al. 2007) says colour
RECALL carries little weight. The anchor colour STAYS, with its
rationale restated: its primary job is visor-vs-app contrast (mostly
structural — the frame's opaque background rule), its secondary job a
spoof lottery an app cannot read and can only guess. Per-app
recognition moves to a **pet icon** — the user's glyph for a surface,
sibling to the petname, chosen in the naming ceremony from a CURATED
Unicode vocabulary (`APP_MARK_ICONS`, 28 glyphs): single BMP scalars,
text-presentation-default (no default-emoji codepoints — ⚓ failed
this test), one glyph per visual-confusability class, no class
overlap with the user's own icon set, no security-semantic or
UI-meaning glyphs. Raw Unicode rather than a shipped font,
deliberately: glyphs travel where fonts cannot (notifications,
titles, OS surfaces), and curation carries the reliability burden.
`isAppMarkIcon` is the firewall — nothing from outside the visor
(nomination, synced mark, hand-edited record) renders anywhere
without passing it, which is what keeps bidi controls and ZWJ
sequences out of trusted pixels. A component may NOMINATE one glyph
(`mark-nomination`, read once at mount, write-only — it never learns
the outcome): shown FIRST in the picker but foreign-attributed ("it
asks to wear …"), only if curated and unclaimed, among genuinely
random alternatives — the user knowingly adopting an app's claim is
the petname philosophy applied to glyphs; the app's claim wearing the
visor's voice by default-bias is not. Unmarked surfaces show NO glyph
(nothing in the visor's voice before the user has spoken).
Engine-side, `us-mark` carries the glyph and repair clears a
collision loser to "" + needs-reconfirm — the engine never invents
vocabulary; the visor re-offers its picker.

**Three voices: provenance as a design language** (2026-08-21, #22,
executed same day). Every string the visor renders belongs to exactly
one provenance class, and the class is visible: **framework voice**
(unmarked — it is what the visor looks like; `.said` commentary
slightly muted), **user voice** (the user's own vocabulary spoken by
the visor: `.petname`/`.who`, weight 600, full opacity, never quoted,
never monospace — NOT italics, which CJK renders as synthetic oblique,
Arabic lacks entirely, and which reads as quotation, the wrong
connotation for the one voice not being quoted), and **app voice**
(component-influenced strings: quoted + monospace + textual
attribution + a recessed PLATE — alpha background so it reads on all
ten anchor hues, inset shadow, NO border because a bordered light
rectangle is the visor's button dress and NOT dark because a dark
recessed box is the visor's input dress; a non-interactive foreign
token wears neither). Pet icons outside the picker are user voice BY
CONSTRUCTION (a nominated glyph never renders outside the ceremony)
and so carry no marker. This is not anti-spoofing — an app can copy
any styling inside its own rectangle; it defends against confusion
WITHIN visor pixels, and the rule that carries the security weight is
one-directional: app-influenced strings are only renderable through
the app-voice constructor (`foreignToken`, the single site assigning
`.foreign`, pinned by invariant (h)); the reverse direction is ugly,
not dangerous. The constructor funnel promptly earned its keep: the
audit it forced found `describeEvent` interpolating the PROVENANCE KEY
— app voice by the visor's own classification, synced from another
device — into flat announcements on the anchor line, undressed and
unclamped. Announcements take flat strings and cannot carry marking,
so the policy is: framework voice, user-voice words permitted inline,
app voice never — a component is referred to by the user's word for
it (the petname, resolved per drained batch) or described without
naming; its provenance key and nickname never ride an announcement.

**Non-visual provenance: the audible anchor word** (2026-08-25). The
three voices above are marked in PIXELS, and a screen reader has no
pixels. AT linearizes the document: app-frame text and visor text
arrive in one stream, the plate and the weight and the quoting are all
gone, and iframe boundaries are not announced at all — so the entire
visor/app boundary, which sighted users read off position and colour
and an opaque frame background, is simply absent. An app can render,
inside its own rectangle, a sentence that SOUNDS exactly like the
visor speaking, and nothing in the audio stream contradicts it. The
anchor colour's whole secondary job — a spoof lottery an app cannot
read and can only guess — had no counterpart on this channel.

So the colour gets an audible twin. A **word** is rolled once per
identity, at the same moment and by the same `claim()` the hue is
(`visor/ui/words.ts`, `loadVisorWord`), out of the EFF short wordlist
2.0 minus the visor's own spoken vocabulary — the EFF list really does
contain "visor", "device" and "anchor", and a word that IS vocabulary
destroys the seam the mechanism runs on. That list was chosen for
PHONETIC distinctness (unique three-letter prefixes, edit distance ≥
2), which is the property a token learned by ear needs and a random
dictionary sample does not have. The word becomes the first token of
every drawer lifecycle sentence the host speaks — "«word»: storage
picker open", closed, back — with everything after the colon drawn
from `DrawerTenantSpec.spoken`, framework vocabulary fixed at tenant
registration. The announcements are emitted BY THE HOST, once, so no
tenant can forget one, and `spoken` is required rather than defaulted
from the diagnostic `name` because a default would have shipped
hyphenated identifiers into the ear of exactly the people who cannot
see the sheet it mislabels. Suspends are silent (audibly covered by
the displacing tenant's own open); the resume closes the pair with
"back".

What makes it unguessable is the same structure that protects the
hue, one step stricter. It is **never rendered in pixels** — not in a
sheet, not in a title, not in an aria-label — so no screenshot,
recording, screen-share or compositing trick carries it; it never
leaves the device; it lives in visor-realm `localStorage` an
opaque-origin frame cannot read; and — the strictest part — **it never
crosses the visor API at all**. There is deliberately no
`committedWord()` to match `committedHue()`: the hue is returned
because consumers must paint with it, the word has no such use, and a
getter would be a door to rendering it. `speakWord()` and
`rerollWord()` are the only doors and both end in the live region.
Pre-claim the prefix is the literal word "visor" — a `deferClaim`
embedder puts its unseal picker in the drawer, so the drawer speaks
before any identity exists, and there is deliberately nothing personal
to say yet.

The delivery needed one mechanism change: `speak()` became a FIFO
queue with a ~1.4s dwell. A live region holds one string and is read
asynchronously, so two writes in one synchronous block are not two
announcements — the second destroys the first. Two real sites do
exactly that: a close that resumes the occupant underneath (else the
user is never told the ceremony they were in ended), and the
fresh-word teach followed immediately by the consumer's fresh-colour
announcement. The queue is capped at 8, dropping oldest — a burst that
outruns speech is a burst nobody can listen to, and the recent
sentences are the ones describing the screen now.

**Accepted residual leaks, recorded rather than hidden.** Anything
that captures AUDIO captures the word: a screen-share carrying system
sound, a call, a person in earshot. This is the same class of limit
the anchor colour has against someone looking over the user's
shoulder, and it is why `rerollWord()` exists — a user who believes
they were overheard can mint a new one (guaranteed different) without
erasing the visor. The word also does nothing for an app that never
tries to imitate the visor's voice; it is a provenance token, not a
capability.

**Growth path.** The word currently prefixes drawer lifecycle
announcements only. It should extend to every CONSENT CEREMONY —
anything where the answer to "is this really the visor asking?"
decides whether a secret gets typed — which is the same reasoning that
put those ceremonies in the drawer in the first place. Beyond that,
the missing piece is a chokepoint for APP voice on the audio channel:
`foreignToken` is the visual funnel and has no spoken counterpart, so
there is currently no way to hear that a string came from a component.
A labeled landmark region around the app rectangle (so AT announces
entering and leaving app territory, which iframes fail to do) is the
structural half of the same fix, and the two together would give the
spoken channel something like the three voices rather than one token.

**The strip reorganized around the user's pair; "me" is a circle; the
user's vocabulary opens wide** (2026-08-21, #22, executed same day).
Three rulings. (1) The context cluster's lines SWAP: the top line is
now the user's recognition pair — pet icon beside petname, one
recognition act read as one unit — or, before they exist, the visor's
offer to create them (NEW + "name it" sit exactly where the answer
will land); the bottom line is claims-and-status (the component's
plated quote, the open sheet's name, timed announcements). "What is
this, to me?" answers above "what does it call itself?" — the
demotion of self-description made structural. The swap is SAFE ONLY
BECAUSE of the three-voices marking: provenance rides the token
(plate/weight), not the row, so lines are free to reorganize — before
that, the row WAS the marking. (2) The user's identity glyph renders
in a CIRCLE (`#visor-settings` and the settings picker) — the avatar
convention; pet-icon pickers stay rectangular. "Me" vs "it" is now
carried by position and shape. (3) Which retired the disjointness
rule: `VISOR_ICONS` (the user's own choices) is now the full vetted
vocabulary — the ten core glyphs plus all 28 pet icons, 38 total —
CORRECTING the entry above: the app-nominable set keeps every
curation rule including no-security-semantics (an app never wears
authority), but the user may wear anything vetted, shields included —
a user awarding themselves ⛨ is a statement on their own authority in
the cluster that is theirs. The vetting (single BMP scalar,
text-presentation, confusability classes) is unchanged; only the
CHOICE widened.

**Storage config is a page, not a modal** (2026-08-21, #22, executed
same day). The provider-config `<dialog>` is gone: a modal paints in
the top layer ABOVE the visor zone and its backdrop dims the page, so
the strip's identity flip — the panel's NEW + "name it", the TOFU
moment — happened exactly where the user could not see it. The rule
made explicit: NOTHING may paint over or dim the anchor except the
visor itself. The config panel is now a sibling PAGE under the same
pinned strip (a 200%-wide track sliding horizontally; the strip is
the one element not moving, so the motion itself points at the
anchor), with the arrival ANNOUNCED on the visor's line and the
off-screen page `inert`. Browser Back is a close path (pushState on
entry; every exit — cancel, save, popstate — tears the panel down; no
path leaves a live panel session off-screen, e2e-gated). The
`<dialog>` contortions died by construction: no close-event
unreliability (the retirement machinery's findings stay in the README
as history), no "take the page back" hook — a naming sheet now opens
ABOVE the storage page without disturbing it, which is strictly
better. NEW WINDOW/TAB was considered and rejected: a fresh window
has no visor — neither the position anchor nor the colour — and the
arrival gesture is forgeable (any app can window.open something that
paints a convincing strip). The discriminator: a popup is right
exactly when browser chrome IS the authority (the foreign-origin
OAuth ceremony keeps its window); never for same-origin component
surfaces whose anchor is the visor. Multi-window visors would need
their own design pass; parked.

**The strip's own back chevron** (2026-08-21, #22, executed same
day; addendum to the entry above). Nested places get a visor-owned
back control at the strip's leading edge — "‹" (U+2039: single BMP
scalar, text-presentation, Latin-1-era coverage; ← reads as
"previous item", not "up and out"). Two jobs: a STRUCTURALLY
UNFORGEABLE EXIT (the page's own Cancel is visor pixels by
construction but sits in scrollable content an app can counterfeit;
browser Back is outside the visor's vocabulary; strip pixels are the
one region no component can draw) and the strip's only PERSISTENT
nesting signal (the arrival cue is timed). Scope rulings:
PAGES ONLY, never sheets (the credential sheet's exclusive/armed
semantics must not gain a second cancel path); sheets are orthogonal
— back navigates the page under an open sheet without touching it
(names outlive visits); null-or-one API (`setBack`), not a stack,
until a second nesting level exists. Rectangular on purpose: round
means "me" in this visor and back is a place verb. All exits — Cancel,
Save, popstate, chevron — share the one `closeStorage` teardown, and
the affordance is cleared there: an exit control that outlived its
place would be the anchor making a false statement.

**The arrival cue is a pulse, not a sentence** (2026-08-21, #22,
executed same day, in parallel with the chevron). Correcting the
storage-page entry above: the arrival is no longer announced on the
visor's line. The announcement
paraphrased the strip while covering it — "the strip above says NEW"
owned the bottom line for 8 seconds, and the bottom line is where the
arriving panel's plated nickname had just landed, so the design
pointed at the answer by hiding it. The cue is now `pulseContext` (a
visor API): a 1.8s alpha-white background wash on the context
cluster, two cycles — the visor pointing at its own lines, framework
voice BY CONSTRUCTION since it puts no words on screen and so has no
string to mark. The lines stay up, and the TOFU beat is readable at
the moment it happens; the e2e now asserts the nickname is on the
line AT THE INSTANT the cue fires, an assertion the old design could
not make because the line was necessarily covered until expiry.
Explicitly not the plate's dress (no border, no inset shadow — an
attention cue must not dress the cluster as a quoted token) and
alpha-only for the ten hues; single decaying wash, no oscillation,
under prefers-reduced-motion; zero layout shift (padding cancelled by
equal negative margin), gated by `strip-geometry`. The sentence moved
to the right medium rather than dying: a visually-hidden `aria-live`
region on the strip (`#visor-live`, created by the visor, never
`display:none`) speaks the arrival to assistive tech — closing a gap
that predates this change, in which no strip announcement had EVER
reached a screen reader; `announce()` now mirrors its text there too.
The division of labour after both same-day changes: the PULSE marks
the moment of arrival, the CHEVRON marks the state of being away —
timed cue and persistent signal, neither doing the other's job.

**The erase ceremony — the visor's third sheet** (2026-08-21, #22,
executed same day). "Your visor" gains a danger entry ("erase this
visor…", the `.forget` idiom escalated: alpha-red for the ten hues,
placed AFTER Save/Cancel — danger past the ordinary way out) opening
the framework's first HEAVY tenant in `visor/ui/sheets.ts`: armed +
dimmed, a statement of consequence, and a TYPED confirmation — the
user's own name, or the visor's fixed word "erase" when the record
holds none (the name is optional; petnames and pairing are not
therefore erasable by gesture). Compare is trimmed/case-insensitive:
deliberateness, not authentication — the name is on the strip in
front of them; the field buys that the erase is reached by a
sentence, not a tap. Rulings: FRAMEWORK POLICY, not a consumer
`extraAction` (a consumer that could contribute the exit could also
decline to, leaving a visor whose memory of the user has no exit);
consumer halves are two config hooks — `onReset` (its own wipe, run
FIRST because it is the fallible half: a throw refuses the ceremony
with nothing visor-held lost — the deliberate inverse of
`onIdentityCommitted`'s visor-writes-first, because a late mirror is
harmless and a late erase is a record that survived a wipe) and
`resetConsequences` (extra statement lines, consumer's own words,
never component-influenced). The reload IS the announced-never-silent
story: a fresh boot rolls and announces a fresh anchor and every
component is honestly NEW; repainting a live visor from deleted
records would leave every in-memory cache speaking names that no
longer exist. DEMO SCOPE RULING: reset means THIS DEVICE LEAVES the
account — storage config, boot caches, legacy keys and the signing
keystore (whole IndexedDB dropped; `onblocked` rejects rather than
silently part-erasing) — NOT an account-wide erase; other paired
devices keep their copies. Deferred, deliberately unpromised in the
sheet's text: a "download a backup first" affordance once export
exists (#5-adjacent), and revoke-on-leave (the departed device stays
in the grant table until another device revokes it); account-wide
erase, if ever, is its own ceremony with its own statement.

**The erase entry moves to the corner; settings suspends beneath the
ceremony** (2026-08-21, addendum to the entry above, after the picker
entry's suspension machinery landed). Two revisions. PLACEMENT: the
danger button moves from danger-last (below Save/Cancel) to the
sheet's UPPER-RIGHT, beside the heading in a `.settings-head` row.
The corner buys the old placement's distance a better way — the
button's only neighbour is inert text, so a mis-aim costs nothing,
where the old position sat one row from a fat-fingered Cancel — and
an exit deserves to be visible on arrival rather than discovered by
travel; the ceremony (arming + typed word) is the actual guard, so
discoverability no longer trades against safety. MOTION: entering
the ceremony now SUSPENDS the settings sheet (the picker entry's
second motion, adopted): settings slides out left, the erase sheet
slides in from the right, and Cancel brings settings back rebuilt —
"one step further in, and now you are back", which is exactly what
the erase entry is and what a naming ceremony opened from the strip
is not, so the suspension is flag-scoped to this one step and every
other displacer keeps plain eviction. Consequences handled by hand:
the live hue preview is reverted at entry (suspension bypasses the
tenant's cancel-revert, and an uncommitted colour must neither paint
the statement of consequence nor disagree with the rebuilt sheet's
swatches); the strip cluster is NOT tappable while the erase sheet
is up (kind "reset" joins credentials/naming/storage — a stray tap
on the anchor must not displace a destructive ceremony mid-decision,
and naming's eviction would resume settings mid-open and clobber
it). One general host fix fell out: `restoreContext` now SKIPS
suspended tenants — a suspended session is alive but its claim to
the strip is dormant, and the picker's own suspension was only ever
saved from the same false statement by registration order.

**The storage picker moves above the bar; commitment never leaves it**
(2026-08-21, #22, ruling set — implementation follows). The provider
CHOICE was the last consequential act living in forgeable territory
(the config page's tabs). It moves into a visor drawer sheet with two
voice-marked lists: (a) providers the user has CONFIGURED, offered
for immediate ARMED selection; (b) INSTALLED but unconfigured
providers, offered for configuration, which only then navigates to
that provider's config page. Voice follows naming state, list follows
config state — orthogonal axes: a configured-but-unnamed provider
sits in (a) wearing app voice + NEW. Rulings:
- SAVE IS DEMOTED to a config-write: the page's save stores the
  record and walks back. BINDING — the app's storage destination —
  only ever happens in the picker, as an armed confirmation, and the
  credential sheet follows SELECTION, not save. Commit-time
  destination refusals move into the sheet (framework voice). The
  page's trust sentence collapses to: configuration happens on the
  page; COMMITMENT ONLY ABOVE THE BAR.
- The picker STAYS OPEN across the config detour (the existing
  sheets-are-orthogonal-to-navigation ruling does the work; no
  close-and-reopen machinery). During the detour it COLLAPSES to a
  band shrink-wrapping the chosen entry — inert, visually disabled,
  ~2-3 strip heights of total trusted chrome: a ceremony breadcrumb
  in trust-grade pixels, answering "what step of MY ceremony is this"
  where the strip answers "who draws below". Return re-expands;
  closing the band dismisses the ceremony and return lands plain.
- MID-CONFIG CEREMONIES (naming is invited — NEW + "name it" sit on
  the strip during config): the drawer gains a SECOND MOTION, not a
  second region. The occupant slides out left, the ceremony slides in
  from the right — the page-nesting grammar replayed at drawer scale,
  entirely inside trusted pixels — and the suspended band returns
  from the left when the ceremony closes. "One expanded occupant at a
  time" stays literally true. The app area DIMS AND INERTS for the
  ceremony's duration (the existing per-sheet dim option; the panel
  stays LIVE — inert is not retirement, and it closes the
  decoy-input interleaving where a live panel solicits text while a
  ceremony is up). Sheets stay orthogonal to history and the chevron
  still marks place nesting only: the ceremony exits through its own
  controls, no new exit machinery.
- SHEET-IN-APP-AREA was proposed and REJECTED: positional bracketing
  ("visor business happens attached to the bar") is the one binding
  users can operate; a sanctioned exception is the precedent a
  phishing page needs, and a page that dims itself can fake the rest.
  The strip naming the open sheet is a label binding, not a
  substitute for position.
- THE OPENER CARRIES NO PAYLOAD: any page or app affordance may
  REQUEST the picker (the requestNaming pattern) but passes nothing —
  no preselection, no filter. App influence must not reach system UI
  unmarked; the requesting UI explains its own purpose in its own
  pixels.
- The config store becomes PLURAL: one record per configured
  provider, keyed by provider; the existing single record adopts its
  key on migration.
- DISCOVERY is parked as its own future pass (web-of-trust
  recommendation shaped, never app-driven, never a public-store
  free-for-all) — and whenever it lands, a discovered entry is never
  visually adjacent-equal to lists (a)/(b): a recommender's words for
  a provider are still not the user's words.

**Spike-to-alpha: the repo restructures; spikes/ becomes a pure
archive** (2026-08-21). The layout stops pretending the live code is
provisional. The engine composite graduates wholesale —
`spikes/tasks-engine` → [engine/](engine/) (guest + fetcher + the
G1–G5 host harness; pins and toolchain untouched). The demo splits
into its three owners: the browser shell, e2e suite and local infra
stay one buildable unit at [demo/](demo/) (the framework's reference
embedding and its behavioral gate); the TodoMVC app guest moves to
[examples/todomvc/](examples/todomvc/) (its CSS copied from the
todomvc spike so the archive stays intact); the provider config
panels move to `providers/{s3,dropbox}/panel`; the shared WIT package
moves to [wit/todomvc/](wit/todomvc/) (package ids unchanged at this
step). `spikes/` is now a pure archive of the executed validation
record — nothing outside it consumes anything inside it, so
delete-at-will is finally literal. CI, setup.sh and the Pages build
follow the moved paths (`docs/spike-demo` → `docs/demo`); the
definition of "identical" was the visor extraction's: every invariant
grep still fires and the demo e2e suite passed unchanged, 12/12. The
provider protocol then extracted out of the engine guest (same day):
`providers/common` carries the egress-route taxonomy, the transport
retry, and the two port seams (`FetchPort`, `Sigv4SignPort`);
`providers/s3/store` the SigV4 signing, object ops and name-secrecy
derivation; `providers/dropbox/store` the RPC/link/pickup protocol.
The engine keeps the world bindings (its fetch imports are inline
anonymous interfaces, so the ports are the seam), the config
snapshots, and ALL sealing — provider crates handle opaque blobs at
derivable locations and depend on nothing from
keyhive/subduction/automerge. Behavior identical to the counter: the
G1–G5 harness's per-replica fetch counts match the pre-extraction
build exactly, e2e 12/12 unchanged. The spike-era names then renamed
(same day, closing the round) — and the project took its provisional
name: **polyvisor**. Polyvisor is the namespace for every identifier
the project mints; anything needing a unique stable identifier hangs
off it. Concretely: WIT packages `polymorph:engine-spike` →
`polyvisor:engine` (world `spike` → `engine`),
`polymorph:todomvc-spike` → `polyvisor:todomvc`,
`polymorph:fetchspike` → `polyvisor:fetch`, `polymorph-data:tasks` →
`polyvisor:tasks`; the iroh ALPNs `engine-spike/0`,
`engine-spike/pair/0` → `polyvisor/0`, `polyvisor/pair/0`
(wire-visible, safe while every peer builds from this tree and the
Pages demo rebuilds per push); the `spike-*` crate names → `engine-*`
(internal, so not polyvisor-prefixed); the harness's default bucket
de-spiked. External `polymorph:*` packages (webcrypto, iroh,
websocket, webrtc-datachannels) are other projects' identifiers and
keep their names, as do consumer-scoped storage keys (`pm-demo-*`).
Versions unchanged; the spike-execution records in engine/README.md
and the citations of the archived probe suites keep their words. The
GitHub repo renames polymorph-apps → polyvisor to match (in-tree URLs
already point at the new name; old links redirect).

**The contracts split and the embedding runtime graduates**
(2026-08-21, #74 × #73 — the two structural debts the restructure round
deliberately deferred). The spike-era single WIT package splits along
its three owners: [wit/surface/](wit/surface/) is `polyvisor:surface@0.1.0`
(dom/events/shell — the visor's curated DOM surface, the package #15's
WebIDL-mirroring bet applies to; the backend ordering spec moved into
its header, since it binds every implementation of the contract, not
the lab harness that exercises it); [wit/panel/](wit/panel/) is
`polyvisor:panel@0.1.0` (credentials, oauth-broker, the s3-panel and
dropbox-panel worlds, importing the surface package); and
`polyvisor:todomvc@0.0.1` keeps only the example app's worlds and moves
to [examples/todomvc/wit/](examples/todomvc/wit/), so wit/ now holds
only framework-owned contracts — tasks and fetch graduate out of the
old `deps/` tree to [wit/tasks/](wit/tasks/) and [wit/fetch/](wit/fetch/)
with ids unchanged. No vendored WIT copies: guests build through
wit-bindgen 0.59's multi-path `generate!` (dependencies listed first,
worlds fully qualified now that the resolve holds several packages).
The embedding runtime then graduates out of the demo (the last
"framework code lives in the demo" cleanup): `engine.ts` (the deltic
embedding adapter), `keystore.ts` (the #11 escrow slice),
`pairing-engine.ts` (the real PairingDriver; the mock stays with the
demo it exists to serve), `stubs.ts` and the build-time
`tools/translate.ts` move to a new top-level [runtime/](runtime/) —
the naming ruling from #73's open question, chosen over `host/` (which
already means two other things) and `visor/embed/` (a headless embedder
needs none of the visor). Floor scope on purpose: `demo/host/demo.ts`
keeps consuming the moved modules by import path, and its own
embedder-wiring/demo-content split waits for a second consumer to
force the seam honestly. The runtime's bare `@deltic/*`/`@polymorph/*`
specifiers stay peer-resolved by the EMBEDDER's deno config
(demo/deno.json's module-identity constraint); the justfile's translate
invocations pass `--config deno.json` explicitly because deno discovers
config from the entrypoint's directory, which the move changed. Every
check-invariants.sh grep follows the moved code — canary-tested per the
visor-extraction precedent: a planted `exportKey` in runtime/keystore.ts
and a planted `renderSas` definition in runtime/pairing-engine.ts both
fail the suite. The definition of identical is the restructure round's:
zero behavioral scenario edits (two comment-only wit-path citations),
invariants 8/8, e2e 12/12 unchanged.

**Real pairing becomes the demo default** (2026-08-22, closing #49 —
the milestone "todomvc as a real sandboxed app on the real engine and
real visor with real pairing"; the first three clauses were already
true, so the round is the fourth). The gap analysis found exactly one
mock left in the demo (the pairing driver) behind exactly one blocker
(#49 trap 1), and the investigation root-caused that trap NOT to
wit-bindgen or the engine guest but to the runtime's scheduler: a JSPI
continuation chunk — wit-bindgen's callback epilogue restoring its task
pointer via `context.set` — runs outside the thread-stack bracket with
no re-anchoring edge, and ambient attribution handed the restore to the
newest SIBLING claim. Deterministic in Chromium (a wider settle-to-
resume gap than Deno's V8), captured with the runtime's own context-
slot trace, and fixed upstream as polyengine#213: context intrinsics
resolve their thread BY DECLARING INSTANCE — sound because one instance
has at most one activation mid-frame at a time, so racing activations
are necessarily of different instances; static because the plan already
names the declaring instance. Shipped in `@polyengine/runtime` 0.3.1
(the deltic→polyengine rename landed in between; this tree migrated to
the new scope, ports to 0.3.0 under their plain names, one runtime copy
in the graph — the webrtc port stays a sibling checkout, re-verified:
its published graph still breaks the `--external` bundling trick).
Behind the trap sat two more embedding-layer bugs, both ground out by
the headless smoke: the pairing adapter decoded WIT variants by a
`{tag,val}` shape the wire never had (runtime/engine.ts's types now
state the real `{kind,value}` convention), and the add side's
post-grant linger was a `yield` SPIN that never let the composed iroh
endpoint's I/O run — ENROLL bytes sat untransmitted for the whole
linger while the joiner idle-timed out (invisible natively, where
wasmtime drives the endpoint outside the guest's scheduler; a real
`wait-closed` await now, [engine/guest/src/pairing.rs]). Pairing grants
membership only, so the embedder wires the sync it owes (§2 step 7):
demo.ts's `wireUsSubduction` mirrors the native acts' `wire_us` —
writer accepts, reader dials, `subscribe` both ways on the enrollment's
partition (direction measured, not assumed: reversed, the handshake
reports connected and the reader's replica stays at revision 0
forever — recorded in PAIRING.md §6 for the next embedder). The e2e
suite went hermetic in the same round: the harness spawns its own
pinned iroh-relay on an ephemeral port (config-file bind; `--dev`
hard-codes 3340) next to MinIO, every page rides `?relay=…`, and
nothing in the suite touches the public relay any more. The ceremony
scenario runs TWICE off one shared act module — `device-pairing` drives
the full live ceremony (code, SAS both surfaces, arming delay, grant,
ENROLL, marks write-through reaching the joined device) against the
composite, `device-pairing-mock` drives the same acts against the
in-page mock, kept deliberately as the visor-only regression harness
that separates "the visor's ceremonies broke" from "the engine or the
transport broke". 13/13 scenarios, `just pairing-bringup` and the
native `just pair` battery green, invariants 8/8.

**Devices survive: the device store, sealing, and the worker host**
(2026-08-22, the G5 round — #20's persistence gap, paying #11 down on
the way; design record [runtime/PERSISTENCE.md](runtime/PERSISTENCE.md),
platform matrix [spikes/worker-host/](spikes/worker-host/)). The round
opened with a spike — the engine composite runs under JSPI inside a
SharedWorker, OPFS mounts through the polyengine wasi filesystem (async
handles; the published pin defaults READ-ONLY), non-extractable keys
structured-clone into IndexedDB and survive a worker restart, and the
worker RESPAWNS on every single-tab reload, which is what made T0
reload-survival a checkpoint-and-rehydrate design rather than
worker-memory luck. The engine learned `state-checkpoint`/`state-resume`
(wasi:filesystem@0.2 imports arrive from `std::fs` itself; generation
directories with a digest-verified manifest written last, no rename
relied on — OPFS renames are emulated; a torn-manifest act falls back a
generation; resume is not a join — the us-events drain is empty; commit
signatures round-trip as stored attestations, never re-signed). The
identity plumbing pivoted mid-round: webcrypto#389's WIT keystore fell
(store-a-handle is browser-specific — real keystores mint inside and
refuse import), superseded by webcrypto#391 — persistence is an
embedder library (absorbed here as
runtime/device-store/identity-keys.ts, the wosh-validated pattern),
the guest-facing function is app-owned WIT per consumer, and the port
ships only the key seams (`fromCryptoKey`/`toCryptoKey`, webcrypto#392,
which superseded this round's own #390 draft mid-flight).
runtime/device-store/ is the embedder half: an unsealed index carrying
exactly seven ruled fields (the anchor colour may never appear before
unseal — the colour arriving IS the login's anti-spoofing tell), one
IndexedDB database plus one OPFS directory per device, a per-device
AES-GCM DEK under a two-rung KEK ladder (passphrase/PBKDF2 and a
platform-wrapped convenience rung whose UI copy says the honest
sentence), AES-KW wraps so a wrong passphrase is a refusal with no
partial state, sealed-fs sealing the engine's state root beneath the
digests it verifies, Web-Locks-sound T0 sweep, and one SharedWorker per
device owning the engine, the lock, and the unseal state — tabs are
views over an error envelope that re-mints the WIT brand client-side
(symbols do not clone; a stale brand key interops wrong WITHOUT a
diagnostic by design, and a matrix row pins the live pairing adapter
against exactly that). The solo page becomes the consumer: first run is
a T0 device with no ceremony, "keep this device" is the promotion that
asks the seal questions, the picker renders nothing personal, unseal is
the login, and resealing a device whose only rung is the platform wrap
is an UPGRADE ceremony (choose what unseals it) rather than a disguised
destroy — a zombie picker row demanding a passphrase that never existed
is the trap the ruling closed. Gates: a 22-row browser matrix on the
device store, e2e 16/16 (solo-persistence: reload → auto-unseal →
todos intact; solo-ephemeral: the anchor round trip and the >1-device
strip label), native and headless batteries unchanged. When the 0.4.0
releases rolled (A19's componentException brand break; A20's
toCloneable/fromCloneable, built with this worker seam as the named
consumer driver), the RPC error path adopted the sanctioned forms —
engine errors rehydrate client-side as real branded
ComponentExceptions, host conditions keep their typed envelope because
the cloneable error row carries no own properties — and the
platform-posture slice closed: the engine's app-owned device-identity
import (pairs, verified against the manifest's agent id on resume),
the worker minting and persisting non-extractable pairs through
identity-keys and handing them over the #392 seams, init(false) as the
worker's resting posture, seed kept for back-compat and for the native
acts (the wasmtime webcrypto host has no Rust-held-key seam yet —
webcrypto#395). The mismatch row surfaced and fixed an unseal
atomicity bug: key AND engine, or neither. 26 matrix rows, e2e 16/16
throughout.

**The passkey rung: WebAuthn PRF unseal** (2026-08-22, the PRF-unseal
round — the KEK ladder's parked passphrase-free rung, recorded in the
G5 close-out; design record: the "The PRF rung: passkey unseal"
section of [runtime/PERSISTENCE.md](runtime/PERSISTENCE.md); platform
facts [spikes/prf-unseal/](spikes/prf-unseal/)). The round opened with
the spike that gated it: Playwright's CDP virtual authenticator serves
hmac-secret/PRF (`hasPrf`), outputs are deterministic per
(credential, input) and separated per input, this Chromium evaluates
PRF at `create()` time (optional elsewhere — the rung keeps the
one-assertion fallback), and a derived non-extractable KEK
structured-clones through `postMessage` — so the whole browser gate
story existed before any design writing. The rung itself: enroll a
passkey for the device (resident key, ES256, uv REQUIRED and pinned at
both ceremonies — hmac-secret keeps two per-credential secrets, so a
drifting effective-UV state would derive a wrong key on a real
authenticator); unseal asserts it with `prf.eval` over a stored
32-byte input; the output feeds HKDF-SHA-256 (stored salt, info bound
to the device id so a wrap copied between namespaces refuses as a
typed `wrong-passkey` instead of unwrapping a foreign DEK); the
derived KEK wraps the DEK with AES-KW exactly as the passphrase rung
does. `PrfWrap` is `PassphraseWrap`'s sibling (`wrap:prf`, no `origin`
field — a PRF rung is always a walkable door, by construction), and
the window/worker split is stated honestly: `navigator.credentials` is
window-only, so the assertion runs on the PAGE and what crosses the
port is the non-extractable KEK handle — the raw PRF output transits
page JS exactly as a typed passphrase does; what the rung removes is
the human secret and the wrap's offline guessability, and unlike
`until-reseal`, profile possession alone does not open it. Enrollment
is a third promotion choice (authorized by the platform rung, which is
then DELETED — asked-to-be-asked, the every-session arm's rule) plus a
kept-device switch (authorized by the passphrase when no platform wrap
exists); the wosh ceremonies were the validated scaffolding
(transports capture/replay, resident-key discipline), the PRF
extension the new construction. Reseal leaves the PRF wrap standing
(an assertion per unseal is the point) and the reseal-upgrade guard
generalized: any reachable rung — user passphrase OR passkey — means
no upgrade question. Rungs stay additive: a switched device's
passphrase remains an explicit picker fallback. Recovery is a recorded
seam, not built: a synced passkey makes the credential portable, never
the wrap; #11's direction (an account bundle in bucket storage under a
domain-separated second PRF input — the dual-eval seam) is written
down in the record. The round crossed #88 mid-flight (the entry
ceremonies became visor drawer sheets), so the picker's passkey surface
was re-expressed in visor/ui/entry.ts's drawer picker behind an
optional host seam — `openWithPasskey` beside `open` — keeping the
visor free of any device-store import: the visor renders the door, the
embedder walks it. Gates: the devstore matrix grew to 28 rows —
passkey promotion/login across a worker kill, wrong-key as one clean
AES-KW bit, reseal survival with both doors, and a planted platform
wrap NEVER walked silently by a passkey device; e2e 17/17 with a
solo-passkey scenario (real enrollment and login ceremonies against
the CDP authenticator on a localhost RP — WebAuthn refuses IP
origins); invariants green, the entry-markup check extended to the
passkey ids; the e2e round caught a real picker busy-guard collision
before it shipped.

**Storage egress from the worker host: G4's browser leg meets the
device store** (2026-08-22, the round after G5 — the seam the G5
close-out named: a worker-hosted device had no bucket path, because the
four `EngineNet` seams are functions and functions do not cross the RPC
port; design record
[runtime/STORAGE-EGRESS.md](runtime/STORAGE-EGRESS.md)). The conclusion
drawn from that fact inverted: rather than a callback protocol, the
store closures live INSIDE the worker, built over a worker-held mutable
grant exactly as the demo page builds them over its own — #7's
egress-grant machinery (the three tier factories, the structural origin
confinement, rebind-not-relink) extracted verbatim from host/demo.ts
into runtime/store-egress.ts, one implementation under two embedders,
the demo page unchanged as the in-page reference. NOTHING SECRET
CROSSES THE PORT in either direction: the credential ceremony stays on
the page (the one moment of cleartext is still the sheet input),
`putSigningKey` escrows into the origin keystore, and the worker reads
the non-extractable handle back by destination origin — same origin,
same IndexedDB, so the RPC carries only a `StoreBinding` (addressing
plus the public access-key identifier) and rpc.ts's
serialization discipline survives untouched. The binding is DEVICE
state: DEK-sealed in the namespace (pre-unseal, nothing on disk names
the destination), re-applied at every bring-up — the checkpoint
deliberately excludes store config ("embedder-supplied addressing,
re-applied by the embedder", persist.rs) and the worker IS the
embedder, so a device returns to its bucket on every unseal with
nothing re-entered. Worker-side enforcement derives the grant from the
destination rather than accepting anything wire-shaped: `bindStore`
refuses an unusable origin, a missing escrow, and an access key the
escrowed record was not stored under — all at bind, never as a
provider 403 twenty calls later. Reseal drops the in-worker authority
(grant, signer, scope-key cache) with the DEK; the ESCROW persists,
profile-tier and destination-bound, shared by every device on the
origin — sealing a device takes away its name for the credential, and
only the erase ceremony deletes the credential itself. v1 is S3-only
and chrome-only on the solo page: one storage sheet in visor pixels, no
picker, no panels, no component anywhere on the path; Dropbox is parked
with the reason recorded (a bearer is a disclosed string with no
platform escrow — handing one over the port is exactly the banned
cleartext crossing; the recorded v2 shape runs the token exchange in
the worker so the bearer never exists in page memory). Gates: the
devstore matrix grew by six rows (renumbered 28–33 on integration, the
PRF round having taken 24–27 in parallel; seams refuse before any binding even
when a client sneaks `initStore` past the ceremony; a bind's
`ensureBucket` egress observed by an in-harness recorder carrying
`AWS4-HMAC-SHA256 Credential=<synthetic key>` — the page escrowed, the
worker signed; the binding survives `__die` with no rebind; reseal
seals it, unseal restores it, unbind refuses at the seam; the factories
gate directly on origin confinement and authorization stripping), e2e
16→17 with solo-storage against real MinIO (MinIO accepting the signed
requests is the signature verification; the escrow lands
non-extractable and appears NOWHERE in localStorage; bucket objects
witnessed in MinIO's own data dir; a real reload re-arms storage from
the sealed binding alone; disconnect leaves the escrow standing),
invariants 8/8 with no scan widened, pairing-bringup and
resume-bringup green, engine and WIT untouched.

**Google Drive: the user-only store** (2026-08-22, the round after
storage egress; design record [runtime/DRIVE.md](runtime/DRIVE.md)).
The engine's third provider strategy and the worker host's second
bindable one — and the first with NO SHARING TIER by design: it mints
no capability a non-credentialed party could use (no links, no
anonymous reads, no app tier — the unused seams are wired over EMPTY
origin sets, refusing by construction), so the only readers are holders
of the user's own OAuth. The provider is a statically-linked guest
crate (providers/gdrive/store) modeled on Dropbox's plain-derivable-path
strategy with the link machinery removed: everything runs Route::Owner;
`drive.file` scope, whose per-app confinement makes the CLIENT ID part
of the store's identity (every device of an account must use the same
one); name→id resolution over Drive's id-addressed API with
resolve-then-create-or-update uploads; `gdrive-config` carries `{root,
api-base}` — addressing only, the api-base being config for the same
reason S3's endpoint is, which is what lets a fake Drive gate the whole
path as ordinary addressing. `store-grant` writes the K_p pickup record
and returns NONE (nothing a link could grant); `store-revoke` returns
the honest note (nothing server-side to revoke was ever minted;
credential rotation at Google is the real lever); `bucket-pull` refuses
a pickup by name. Because Drive is bearer-based, the round BUILT the
OAuth shape the egress record had parked as v2: the WORKER mints the
PKCE verifier and runs the token exchange with its own fetch; the PAGE
owns only the popup and relays the one-shot, verifier-bound
authorization code (ruled crossable: it is not a standing credential);
tokens are born in worker memory, rest DEK-sealed in the device
namespace — DEVICE-scoped, deliberately unlike the origin-shared SigV4
escrow, since there is no platform handle for a bearer and sharing one
across devices would be credential sharing between agents — and the
401→refresh→retry seam re-seals rotated tokens so a respawned worker
resumes on the newest ones (made falsifiable by a two-kill matrix row
against a rotating fake). `bindStore` grew the gdrive arm with the same
fail-at-bind discipline (no consent, or a consent under a different
client id, refuses `no-credential` — the access-key-mismatch analog);
`forgetOauth` is the honest disconnect (best-effort revoke at the
provider, sealed row deleted, grant dropped; the BINDING stays —
forgetting the account is not forgetting the destination, the mirror of
unbind keeping the escrow). The solo sheet grew the provider choice
(chrome-owned fields; the client secret masked and named for what it
is — an installed-app identifier, not the user's secret); the demo page
deliberately did not (its storage theatre exists to show the sharing
tiers). Gates, all against demo/host/fake-drive.ts — a minimal Drive
files API plus an OAuth half that VERIFIES OUR PKCE (S256 only, one-shot
codes, rotation invalidating predecessors) and serves CORS because real
googleapis.com does: a new headless `just bringup gdrive` (owner beat
plus a cold engine reconstructing from the fake alone), devstore matrix grew by
eight rows (renumbered 34–41 on integration, the PRF round having
taken 24–27 and storage egress 28–33; ceremony seals tokens the port never sees; refusals by
code; egress carries the consent; kill-survival with no re-ceremony;
rotation sealed; forget revokes; reseal seals the consent), e2e 17→18
with solo-gdrive driving the REAL popup path headless, invariants 8/8,
engine clippy + native pair/resume acts + all four bringups green. The
LIVE beat against real Google is manual and the operator's, with a
picked-up published client id (rclone's, with the recorded caveat that
Google is retiring it during 2026; any registered installed-app pair
slots into the same fields) — nothing baked into source or bundles.

**Bucket sync: storage moves without being asked** (2026-08-23; design
record [runtime/SYNC.md](runtime/SYNC.md)). The round that turned the
bucket from a write-only backup button into the product claim — a solo
device that syncs through its bucket while its siblings sleep — in
three pillars whose order was the dependency graph. FIRST, the name
chain stopped forking: per-device random minting meant two devices on
one bucket wrote parallel keyed namespaces (the #93 respawn defect made
cross-device and permanent), and the ruled fix — derive from keyhive
epoch secrets, G4's old coupling sketch — fired its own feasibility
caveat (keyhive exposes a current-epoch secret only; historical
reconstruction is test_utils-gated; no integer epoch indexing exists;
and the one public epoch-stable value ships in cleartext inside every
uploaded envelope, so naming with it would hand the provider the name
key — recorded as the blocked ideal with the two-line upstream unblock
named). The amended ruling uses the channel the account already had:
the chain is a guest-internal us-doc register, synced E2E like the
profile, SEEDED AT POINTER PUBLICATION inside one automerge change so
pointer-visible ⇒ chain-visible and a device cannot flush a doc whose
pointer it has not seen — a gate proven non-vacuous by concurrent
flushes that fork deterministically with seeding disabled. SECOND,
cheap-when-idle lives in the provider, not the scheduler: each Drive
doc folder's appProperties are a change board (per-device key, decimal
flush counter — per-key merge extends single-writer-per-name to
metadata; hint never truth, correctness survives a lost board), so an
idle pull is ONE metadata request, measured off the fake's log; S3
declines the optimization with arithmetic in the comment. BucketState
growth got its standing rule: bincode is not self-describing, so a
checkpoint member that validates but no longer decodes reads as empty
with a loud note — pinned by a resume act that corrupts the element
count and re-seals both digests, testing decode and not the digest
path. THIRD, the worker owns the schedule: a 20s trailing flush
debounce off the same mutation hook as the checkpoint's 500ms (the two
timers deliberately far apart — the hot-file 429 heuristics are the one
Drive limit that binds; documented quota is three orders of magnitude
away), boot pull armed BEHIND readiness at unseal, a 45s cadence,
truncated-exponential backoff whose deadline a busy user cannot clobber
(a mutation mid-backoff changes what flushes, never when), and the page
announcing after three consecutive failures. The round's own money-shot
scenario went RED as registered and forced the fourth ruling: Drive
pulls were pickup-gated while no account device grants siblings
pickups, so sibling pulls could only refuse — the ACCOUNT PULL PATH now
derives a sibling's oplog/manifest names from the synced chain and the
device directory with no pickup at all (agent id and object-name key
verified to be the same 32 bytes, corroborated by manifest signature
verification), pickups remaining the bootstrap for non-account readers
only, and a never-flushed sibling reading as absence, never an error —
the ordinary state of most (partition × sibling) pairs at every boot.
Gates: solo-offline-sync green end to end (pair, close B, A authors
with nobody pressing anything, close A, reopen B with no live peer —
the todo is there via boot pull alone), e2e 25/25, devstore 53 rows
(a mutation flushes itself; backoff real, announced-shaped, and reset
by recovery; boot pull never awaited by unseal), the pairing battery's
chain act asserting zero duplicate chunk names across concurrent
sibling flushes, resume/pair/check green, invariants 9/9.

**Recovery: the account outlives its last device** (2026-08-25; design
record [runtime/RECOVERY.md](runtime/RECOVERY.md)). The round that
closed SYNC.md's parked us-doc-through-the-bucket and #11's recovery
body. The ruling: **recovery is a DEVICE, not a resurrection** — the
kit ceremony mints a dormant member leaf through the ordinary
`enroll_device` path (visible in the devices sheet, revocable like a
lost phone) whose secrets exist only in a sealed bundle; dormancy is
what kills bundle staleness (the G5 self-rotation finding never fires
for a leaf that never authors — the proven G4 tablet path with the
tablet replaced by a blob), and the K_p pickup answers the us-doc
bootstrap chicken-and-egg (one pickup, sealed to prekeys that ride the
bundle, bootstraps everything; `KpPayload.devices` became directory ∪
grantees on the way, without which a post-SYNC.md account's pickup
named no real author). Two kit kinds, one mechanism: a BUCKET kit
under a generated 10-word EFF-short phrase (argon2id at a fixed
context salt → HKDF → both the object name and the KEK — the exposure
rule made structural: replicated copies get generated-secret slots
only; S3-only at this rev, names being locations only there) and a
FILE kit under a user passphrase (the custody exception, warned
loudly, provider-neutral; the owner's amendment — disallowing custody
would be paternalism). **Single-use, consumed at restore**: dormancy
ends at first authoring, double-restore is an identity fork against
the single-writer-per-name invariant, and a phrase captured during
the ceremony must be worthless afterward; the K_p's deletion enforces
single-use even for a file we cannot delete (a second restore is a
404, never a fork). The us-doc now rides the ordinary flush/pull
cycle via an empty-doc-id sentinel; restore is a two-stage worker
ceremony (bind with fail-at-bind, engine born from the bundle instead
of init, fan-out, checkpoint, then consume) ending at the claim —
colour, name, icon from the pulled profile. Three defects found and
pinned during the round, each with a regression owner: the solo
page's nested-`enqueue` self-deadlock (a file-kit mint wedged the
page-wide chain forever; the sheet's own "measured" comment had
recorded the symptom as an engine bug), the consume-outlives-its-
checkpoint strand (internal driver mutations bypass the client-call
debounce, and the pull fan-out's self-filter keeps a device's own
flushed clear permanently out of reach — every internal mutation now
checkpoints explicitly; devstore row 64 pins it with a negative
control), and the same stranding for kit create/revoke. Known
limitation recorded, follow-up owed: a name-key rotation strands a
bucket-only lagging sibling on the us-doc until wire contact —
pre-existing SYNC.md territory that kit revocation now makes
reachable. Parked: Drive bucket kits, the PRF second-input slot, kit
migration on storage rebind, platform-posture migration for restored
devices. Gates: a new `just recover` battery (8 acts: both kinds
round-trip against MinIO with a post-kit revocation epoch crossed
before restore, refusals as classes, consume verified by object
set-difference and idempotent retry, the restored device's own-view
registry agreement), devstore 64-row matrix, e2e 27/27 (`solo-recovery`
destroys the browser context and restores from phrase + re-entered
credentials alone; `solo-recovery-file` catches the real download and
proves the wrong passphrase is one clean keyslot miss),
pair/resume/check green, invariants 9/9.

**The event record: announcements split three ways; a badge on the
identity circle** (2026-08-26; design memo
[#132](https://github.com/polymorph-components/polyvisor/issues/132),
executed same day). The strip's timed announcement was one transient
line multiplexing three jobs, and every patch it has accumulated —
the sticky/priority windows, the pulseContext retreat, the spoken
FIFO, solo.ts's `syncFailureAnnounced` edge-trigger — was contention
between them. Worse, ANNOUNCED-NEVER-SILENT was hollow: a remote
revocation got 12 seconds on a strip nobody may be watching, and
multi-device means consequential events happen while you're away by
construction (the transparency roadmap's fork alarms make this acute:
"detection requires a response path", and a timed line is not one).
The split: **moment cues** stay push (announce/pulse/speak,
record-less — the fresh-colour teach is about NOW); **standing
conditions** become visor-held keyed state (set/clear, lit while
standing, session-live so a stale condition cannot outlive its
poller); **event records** become a persistent, acknowledgeable list.
The mechanical rule that makes wiring one-line-per-host: EVERY
CONSEQUENTIAL ANNOUNCEMENT LEAVES A RECORD — the sink already carries
the flag, so arrival push is unchanged and the badge is the memory,
not the alarm. The badge is a DOT (never a count) on
`#visor-settings`: zero layout shift (strip geometry is a measured
property), framework voice by construction (no words), lit = unseen
records ∪ standing conditions. THE SYMMETRY RULE: the badge sits on
the anchor of whoever the news is about — identity circle for
me/my-system news (built now); the PET ICON for system-authored news
about one surface (update landed, a pending version requests new
grants — specified in #132, dormant until such events exist). THE
AUTHOR RULE: only visor/engine-authored events light it — the subject
may be an app, the author never is; a self-badging primitive is "look
at me!" handed to components. Two more rules keep it meaningful:
entry is gated to the consequential class (ambient telemetry never
enters, or the one alarm that matters drowns in junk mail), and A
NOTIFICATION NEVER GRANTS — an entry may point at a ceremony, the
grant path stays the powerbox. The list itself is "recent events", a
light drawer tenant reached from a visor-owned settings-sheet row via
the erase entry's suspend/resume motion; conditions first, records
newest-first with coarse ages; OPENING MARKS SEEN (per-entry
dismissal waits for entries that carry actions); entries are flat
framework-voice strings under exactly `announce()`'s three-voices
policy — typed slots (petname/plated-foreign) are the recorded growth
path and the prerequisite for the surface scope. Records persist
under a consumer key (`erase()` wipes them); solo's sync watch now
sets/clears a condition and the edge return replaced its hand-rolled
boolean. Gates: e2e 36/36 (`visor-events` new — a seeded stale boot
cache drives a real reconcile-announced event into badge → list →
seen → reload persistence; `store-outage-recovery` extended to pin
the condition lighting the badge, the failure record outliving the
ambient recovery announce, and the condition block clearing;
`strip-geometry` now takes every measurement with the badge LIT),
invariants green, harness and hosts type-check green.

## Parked and candidate non-goals

- **Metadata privacy**: relays, push services, and origins see traffic
  timing and contact-graph shape. State as an explicit v1 non-goal
  rather than let it be discovered. The related relay question is
  answered — see the relay-posture bullet in
  [Who runs home origins](#who-runs-home-origins): the static path
  keeps the split view by default (origin sees code fetches, an
  independent relay sees contact timing); the full-stack self-host
  knowingly collapses it onto the user themselves.
- **Browser support floor**: answered — see the Browser floor note in
  [The substrate](#the-substrate). Safari's floor is a future JSPI +
  wasm multi-memory release (hoped early 2027); the worst cases that
  lived in this bullet (the `webrtc` CSP directive, PRF availability,
  storage persistence) become that day's re-evaluation checklist.
- **Multi-tab / concurrency plumbing**: folded into data services.
- **Origin portability**: design before the first user exists; folded
  into origin topology.

## Prior art

- [Sandstorm](https://sandstorm.io) — grain isolation, per-grain random
  hostnames, the powerbox; postmortem: porting cost, server-hosted
  model.
- [Solid](https://solidproject.org) — data pods, but ~no app
  confinement (apps get tokens and talk to pods directly); confinement
  is this design's differentiator.
- [Peergos](https://peergos.org) — capability-based E2E filesystem
  (cryptree).
- [UCAN](https://github.com/ucan-wg/spec) / Fission — capability tokens
  for user-owned storage.
- remoteStorage / unhosted — same era and weakness as Solid.
- [Ink & Switch](https://www.inkandswitch.com/local-first/) — the
  local-first canon; [Keyhive](https://www.inkandswitch.com/keyhive/).
- [Holepunch / Pear](https://docs.pears.com) — hypercore-family stack
  (signed single-writer logs, Autobase multiwriter linearization,
  Hyperswarm DHT); browser-incapable by construction, so roles and
  protocols transfer, not code. Mined 2026-08-19:
  [blind-peer](https://github.com/holepunchto/blind-peer)
  (ciphertext-blind availability peers → the relay role),
  protomux-wakeup (activity hints → wake tier), quorum-multisig
  release lines (→ #3), Keet identity keys (mnemonic-attested device
  keys — weaker shape than the device-group design, kept as
  validation).
- [DP5](https://cacr.uwaterloo.ca/techreports/2014/cacr2014-10.pdf) —
  private presence via PRF-keyed queries against an untrusted server;
  the wake-tag trick's citation trail.
- [Isolated Web Apps](https://github.com/WICG/isolated-web-apps) —
  Chromium signed web bundles; install-time code integrity, not
  cross-platform.
- [Code Verify](https://github.com/facebookincubator/meta-code-verify)
  — extension-checked hash manifests for web-delivered E2E clients.
- Transparency-log canon (mined 2026-08-21 for #52): Certificate
  Transparency ([RFC 9162](https://www.rfc-editor.org/rfc/rfc9162) —
  inclusion/consistency proofs, the undeployed gossip half);
  [Sigsum](https://www.sigsum.org) — minimalist witnessed log,
  self-hostable, witnesses attest extension not content;
  [CoSi](https://arxiv.org/abs/1503.08768) — decentralized witness
  cosigning;
  [Chainiac](https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/nikitin)
  — software-update transparency via collectively signed skipchains,
  offline-verifiable update chains (the single closest fit); Keybase
  sigchains — per-publisher append-only chains under a globally
  anchored root, the production precedent; Haber–Stornetta linking /
  Guardtime KSI / [OpenTimestamps](https://opentimestamps.org) —
  cross-entanglement and anchoring; TUF — role separation and the
  freshness/rollback vocabulary (crib, don't re-derive).
- Object-capability literature — E, CapTP, capability UX ("user
  interaction is the grant"); SES/Endo as the JS-confinement road not
  taken (components chosen instead).

## Open questions

Tracked as issues; the headline ones, verbatim from the discussion:

- Who runs home origins in practice — answered, see
  [Who runs home origins](#who-runs-home-origins).
- Target app developer — answered: component-native, with a real
  porting on-ramp and no drop-in promises; see
  [Developer experience](#developer-experience).
- Is headless-at-provider execution in scope for v1? — narrowed: at
  least many apps must be usefully usable with no headless copy at all
  (see [Compute placement and push](#compute-placement-and-push));
  only whether the powerbox version itself ships in v1 stays open.
- Does Safari have to work at launch — answered: no; see the Browser
  floor note in [The substrate](#the-substrate) (a future JSPI + wasm
  multi-memory Safari, hoped early 2027).
- Relay — answered: posture follows the delivery artifact; see
  [Who runs home origins](#who-runs-home-origins). Turnkey static
  defaults to a public relay instance (split view preserved);
  full-stack self-hosting bundles its own and skips the public
  default.
- Does the home origin ever serve per-user content? — answered: not
  without an explicit opt-in to a lower trust regime, expected to be a
  developer-oriented option rather than an end-user surface; see
  [Home origin contract](#home-origin-contract).
- `user@host` discovery — deferred: out-of-band only for now, with the
  explicit guard that nothing built meanwhile may preclude it
  architecturally; see
  [Addressing and discovery](#addressing-and-discovery).
