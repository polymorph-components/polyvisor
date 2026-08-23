# Device pairing + user-system partition — pinned contract

Governing doc for the two parallel tracks (engine: `engine`;
visor: `demo`). Tracks build against THIS file; changes to it are
design decisions and go through the dispatcher, not either track.

References: #10 (enrollment ceremony), #36 (user-system partition),
#22 (visor rulings: announced-never-silent, naming voices, ceremony
weight classes), NOTES §Identity and devices, §Key lifecycle, the G3–G5
records in §Provisional plan.

Rulings from the 2026-08-19 session this contract encodes:

- **New device displays** a QR or typed code; the trusted device scans or
  types it. **No pairing links.** Pairing is started interactively on
  BOTH devices; nothing enrollment-shaped is ever reachable from a URL.
- Typed-code alphabet: `data_encoding::BASE32_NOPAD_VISUAL`
  (confusable-free variant; see docs.rs). QR carries the same string.
- Mark-invariant violations after merge: **deterministic auto-repair +
  announcement**, never silent, never blocking.
- Devices join the user group at level **admin** (any of the owner's
  devices can add/revoke others — matches the K_p-deletion posture).

## 1. Pairing code

```
payload = version(1 byte, 0x01) ‖ join-endpoint-id(32) ‖ token(16)
code    = BASE32_NOPAD_VISUAL(payload)        // 79 chars, display in groups of 4
```

- No relay hint in v1: both sides use their configured relay (demo has
  one). Production relay discovery is an open item on #10, recorded, not
  solved here.
- Offer expiry: **120 s**. Token is **single-claim**: the first CLAIM
  binds the session; a second CLAIM is refused AND burns the bound
  in-flight session (a code that reached a second party has leaked —
  the joiner UI says "someone already tried this code" and
  regenerates).
## 2. Wire protocol (one bidi stream on the pairing iroh connection)

Transport is iroh: both endpoint keys are transport-authenticated
(key-is-address). The joiner listens; the adder dials the endpoint id
from the code. Messages are length-framed bincode; unknown message kind
or out-of-order message ⇒ abort with error (this is load-bearing state:
reject-on-unknown, per NOTES).

```
1. add  → join : CLAIM   { token, commit = H(nonce_a) }
     (a CLAIM on an already-claimed or expired offer is answered with
      REFUSED — distinct error, add-ward only)
2. join → add  : ACCEPT  { nonce_j, contact-card }      // keyhive contact card
3. add  → join : REVEAL  { nonce_a }                    // join verifies commit
     transcript = 0x01 ‖ token ‖ join-endpoint-id ‖ add-endpoint-id ‖ nonce_j ‖ nonce_a
     sas        = (first 4 bytes of BLAKE3(transcript), read u32 big-endian)
                  mod 10^6, zero-padded to 6 digits
4. both display SAS; both users confirm in the visor (weight classes: §5)
5. join → add  : CONFIRM-JOIN {}
6. add  → join : ENROLL  { user-group-id, group-card, partition-id }
     (sent only after BOTH the adder's local confirm and CONFIRM-JOIN;
      group-card = kh-export-card for the new individual, exported AFTER
      kh-add-to-group so the delegation is inside)
7. join side: ingest card, adopt partition, sync; done.
```

- The **commitment ordering** (H(nonce_a) before nonce_j is revealed)
  prevents the dialing side from grinding the 20-bit SAS.
- Abort at any step tears down the stream and, on the join side, expires
  the offer (a new offer mints a new token).
- Enrollment writes on the add side, in order: `kh-add-to-group(user,
  new-individual, "admin")` → forced key rotation (defence in depth: a
  deliberate epoch boundary at enrollment) → devices-doc entry
  {agent-id, name, enrolled-at} written to the doc — this write is
  also the **walk anchor**: a chunk guaranteed sealed under a
  post-add epoch, from which the joiner's causal read-back starts →
  flush ops. ENROLL carries the ORIGINAL partition-id; there is no
  regeneration (see §4b).
- **Retired (2026-08-19, Envelope slice)**: doc regeneration, forward
  pointers, value-reconciliation, and generation-fork handling. With
  one doc lineage, a partitioned device's writes — including
  deletions — merge natively as CRDT changes on heal; the
  forget-resurrection hazard the value-copy design carried is gone by
  construction. The retired design and its measurements remain in git
  history (PR #40) and the README.
- History note: late joiners materialize pre-join history via
  causal-key read-back (§4b). The read-back window for the
  user-system doc is deliberately TOTAL — these are the user's own
  devices. The chain-cut policy for shared partitions (what a newly
  added collaborator may walk) is a #36/#9 decision-memo item, out of
  scope here.
- Historical record (superseded 2026-08-19 by §4b; kept because its
  measurements still bind): the attribution investigation
  (spikes/keyhive-addwedge + engine instrumentation) established that
  a post-seal add yields the joiner readable epochs — keyhive
  propagates the CGKA add, the bridge delivers the event set, and
  post-join envelopes open with the rotation off and the ENROLL card
  suppressed (10/10, order-independent). What a late joiner could not
  do without the Envelope format was materialize pre-join automerge
  history (designed non-retroactivity + automerge buffering changes
  with missing deps). The interim answer was doc regeneration
  (value-copy state handoff); it is now retired in favour of
  causal-key read-back.
- After ENROLL the joiner pulls the user-system doc, decrypts the
  anchor chunk, causal-walks the ancestry, materializes, and adopts
  profile state; the visor announces the adoption (profile hue + name
  arriving is a remotely-caused change, #22: announced).

Threat notes (carry into #1 later): shoulder-surfed/photographed code ⇒
attacker can race the claim; SAS mismatch + single-claim + dual-confirm
is the defense; the residual is a same-room adversary racing both, out
of scope for v1. Enrollment is THE consequential grant (a device is
admin of everything); the adder's confirm carries the heavy ceremony.

## 3. WIT additions (exact; Track A applies to `guest/wit/engine.wit`)

Added to `interface driver`:

```wit
    // --- device pairing (#10) ---

    record pair-offer {
        code: string,        // BASE32_NOPAD_VISUAL(version ‖ endpoint-id ‖ token)
        expires-ms: u64,
    }

    record pair-enrollment {
        user-group-id: list<u8>,
        partition-id: list<u8>,
    }

    variant pair-join-state {
        waiting,
        claimed(string),          // SAS — display, await pair-join-confirm
        confirmed-waiting,
        enrolled(pair-enrollment),
        expired,
        failed(string),
    }

    variant pair-add-state {
        connecting,
        sas-ready(string),        // SAS — display, await pair-add-confirm
        waiting-peer,
        enrolled,
        failed(string),
    }

    pair-join-start:   async func() -> result<pair-offer, string>;
    pair-join-status:  async func() -> result<pair-join-state, string>;
    pair-join-confirm: async func() -> result<_, string>;

    pair-add-start:    async func(code: string) -> result<_, string>;
    pair-add-status:   async func() -> result<pair-add-state, string>;
    /// device-name: the user's own word for the new device (the visor's
    /// voice, #22) — recorded in the devices annotations by the ADDER.
    pair-add-confirm:  async func(device-name: string) -> result<_, string>;

    pair-abort:        async func() -> result<_, string>;

    // --- user-system partition (#36) ---

    record us-profile {
        display-name: string,
        hue: u16,                 // OKLCH hue index per #22 palette
        icon: option<list<u8>>,   // small; blob-attachment pattern later
    }

    record us-mark {
        provenance: string,
        petname: string,
        /// The canonical pet-icon glyph: a single Unicode scalar from
        /// the visor's curated set (#22). The ENGINE treats this as an
        /// opaque string and repairs uniqueness on exact equality only
        /// — confusability across glyphs is handled visor-side, by
        /// construction of the curated set (one glyph per visual
        /// class).
        icon: string,
        nickname: option<string>,
        created-at: u64,
        needs-reconfirm: bool,    // set by conflict repair; cleared by us-mark-confirm
    }

    record us-device {
        agent-id: list<u8>,
        name: string,
        enrolled-at: u64,
        revoked: bool,
    }

    variant us-event {
        profile-changed,
        mark-added(string),                       // provenance
        mark-changed(string),
        mark-conflict-repaired(tuple<string, string>), // (provenance, "petname"|"icon")
        device-added(string),                     // name
        device-revoked(string),
    }

    /// First device only: create user group + user-system partition,
    /// write the initial profile. Returns the user group id.
    user-create:     async func(profile: us-profile) -> result<list<u8>, string>;

    us-profile-get:  async func() -> result<us-profile, string>;
    us-profile-set:  async func(profile: us-profile) -> result<_, string>;

    us-marks-list:   async func() -> result<list<us-mark>, string>;
    us-mark-put:     async func(mark: us-mark) -> result<_, string>;
    us-mark-forget:  async func(provenance: string) -> result<_, string>;
    us-mark-confirm: async func(provenance: string) -> result<_, string>;

    us-contacts-list: async func() -> result<list<tuple<list<u8>, string>>, string>;
    us-contact-put:   async func(card: list<u8>, petname: string) -> result<_, string>;

    us-devices-list:  async func() -> result<list<us-device>, string>;
    us-device-revoke: async func(agent-id: list<u8>) -> result<_, string>;

    /// Drain remotely-caused changes the visor must announce (#22).
    /// Local-echo suppression is engine-side: a device never receives
    /// events for its own writes.
    us-events: async func() -> result<list<us-event>, string>;
```

## 4. User-system doc semantics (engine side)

- **One automerge doc** in v1 backing all four families (`profile`,
  `marks`, `contacts`, `devices` as top-level maps). The WIT surface
  hides the partitioning, so the production split (per-family docs, #36)
  is a later engine change with zero visor impact. Doc is delegated to
  the user group only; created by `user-create`; sealed immediately
  (single founding member — no add-before-seal window needed; the
  pairing path adds devices to the GROUP, which CGKA-propagates).
- **Marks invariants + repair** (runs after every remote apply):
  petname uniqueness (case-insensitive) and pet-icon uniqueness are
  cross-record invariants. **Icons are a single Unicode scalar** from a
  visor-curated set (#22); the engine treats an icon as an opaque
  string and repairs on exact equality only — confusability across
  glyphs is handled by the visor's curation, not the engine. On
  violation, the **older record wins** (`created-at`, tie-break
  lexicographic provenance):
  - petname collision: loser keeps its petname bytes but reports
    `needs-reconfirm = true` (derived, not stored, is acceptable —
    the visor renders NEW-with-explanation at next mount; `us-mark-confirm`
    records the exact petname confirmed and clears until it changes);
  - icon collision: the engine cannot invent a replacement glyph (the
    curated vocabulary is the visor's), so the loser's icon is cleared
    to `""` (empty = unmarked/needs-reassignment) and `needs-reconfirm`
    is set — the visor re-offers its picker on reconfirm. `""` is
    derived as always needing reconfirm (whether freshly-created with
    no icon, or cleared by a repair): the flag is self-stable across
    repeated repair computation, unlike a hue reassignment would be.
  Both emit `mark-conflict-repaired`. Repair must be deterministic:
  every device computes the same outcome from the same doc state, no
  repair-write ping-pong (repair writes only from the device that
  observes a violation involving its OWN losing write; others render
  the computed outcome without writing).
- **Founding device**: `user-create` records the founding device in the
  devices map with `name: ""` — the visor treats empty as "this device"
  until a rename surface exists (#36 production item).
- **Events**: per-instance drained queue; only remotely-caused changes;
  emitted after apply + repair.

## 4b. Envelope content format (added 2026-08-19)

The engine's content spine switches what it seals, at the single
seal/open boundary (one seal site, one open site; nothing above or
below changes — WIT, the visor, subduction, sedimentree, storage all
carry opaque bytes either way):

- **Write path**: the plaintext handed to keyhive encryption becomes a
  keyhive `Envelope { content: chunk-bytes, ancestor keys: keys of the
  chunk's parent chunks }` instead of raw chunk bytes. The writer
  holds its parents' keys by construction (it wrote or read them). Use
  keyhive's own Envelope type/API at the pinned rev; if the API
  requires a materially different integration shape than described
  here, STOP and report — do not invent a parallel envelope format.
- **Read path**: a chunk that fails direct decryption is reached by
  **causal walk**: decrypt any readable descendant, take the ancestor
  keys from inside its plaintext, step down one hop, recurse
  (`try_causal_decrypt_content` or the equivalent at the pinned rev).
  A late joiner therefore materializes the complete history from its
  walk anchor (§2).
- **Scope**: the WHOLE content spine — tasks partition and user-system
  doc alike — so the existing G1–G5 acts ride the new format and
  double as coverage.
- **Format generation**: the plaintext layout change is a format
  generation bump. The spike carries no deployed data, so no migration
  is implemented; the production migration seam is #8's business and
  is recorded, not solved, here.
- **Read-back window**: total for the user-system doc (own devices).
  Chain-cut policy for shared partitions (what a late-added
  collaborator may walk; natural cut points are compaction/summary
  boundaries) is deferred to a #36/#9 decision memo.
- **Shipping gate, restated from NOTES**: keyhive's content-envelope
  scheme is CAUTION-flagged in upstream's own design doc; independent
  review gates any polymorph data shipping under it. This spike
  implements; it does not ship.

## 5. Visor semantics (Track B; #22 rulings apply throughout)

- **Marks/hue/name move to the partition**; localStorage demotes to a
  boot cache (render from cache, reconcile after engine init, announce
  diffs). The keystore (CryptoKey handles) stays device-local — never
  synced, unchanged.
- **Join flow** (new device): "join existing account" → shows QR
  (data-URL) + the 79-char code grouped by 4 → SAS screen → light
  confirm ("I initiated this" + SAS match) → adoption announcement
  ("this device now follows your profile: ‹name›, your colour"). On the
  solo page the pane mounts INSIDE the visor drawer — it is the second
  phase of the first-run sheet (`visor/ui/entry.ts`), reached from that
  sheet's "join another device" choice — so the code and the SAS are
  rendered in a sheet hanging off the pinned strip over a dimmed page,
  which is a geometry no component frame can produce.
- **Add flow** (trusted device): strip menu → "add a device" → code
  entry (paste/typed) → SAS screen → **heavy ceremony**: statement of
  consequence ("full access to everything in your account"), the #22
  arming delay, and the device-name field (user's own word, the visor's
  voice, never prefilled from anything the joiner sent).
- **Announcements** drain `us-events` into the strip's rule line /
  status surface with priority over ambient telemetry (#22: the
  revocation-note-erased-by-stats-tick lesson).
- **Demo beat**: the tablet's scripted card-paste is replaced by live
  pairing against alice-laptop; bob (separate user) keeps the contact
  card path.
- New CI invariant (`scripts/check-invariants.sh`): the pairing code and
  SAS render only in visor-owned surfaces, never inside a component
  frame; grep-enforceable markers to be chosen by Track B. Check (i)
  joins it and extends the same argument one step outward: the surfaces
  the join flow is REACHED from — the device picker and the first-run
  fork — are pinned to `visor/ui/entry.ts` by the same marker pattern,
  and no embedder page may carry their markup below the strip.

## 6. Gates

Track A (engine): `cargo build --target wasm32-wasip2` for the guest;
headless host harness (existing acts pattern) covering: full pair
between two instances over the local relay → marks write on A visible
on B; SAS values equal on both sides; commitment violation aborts;
second CLAIM refused; expiry; concurrent same-petname assignment on two
devices → identical deterministic repair on both + events emitted;
revoke device → re-pair same hardware as a NEW individual succeeds.

Envelope-slice additions (2026-08-19), replacing the
regeneration-specific gates:

- **Late joiner materializes FULL history**: founder writes state
  BEFORE the add; joiner enrolls; joiner's materialized view includes
  the pre-join values (via causal walk, not copy) — 10 runs,
  order-varied.
- **Partitioned writes merge natively**: a device offline during
  another device's enrollment writes a mark, RENAMES an existing mark,
  and FORGETS a mark; on heal, all three survive — in particular the
  forget does NOT resurrect and the rename is not lost. This gate is
  the proof the value-copy hazards are gone.
- The post-seal-add boundary act flips its second assertion: pre-join
  content is now EXPECTED-readable through the walk (assert the walk
  succeeds where direct decrypt fails).
- G1–G5 regression on the new format.

Track B (visor): demo builds; Playwright drive of both flows against
the mock driver (join + add panes side by side, SAS equality asserted
across panes, arming delay enforced, announcements render);
`scripts/check-invariants.sh` green including the new invariant.

Integration (after A): swap mock for the composite, run the full demo
beats, then the NOTES/issue design records.

### Status — Track B integration (2026-08-20)

Recorded here because §6 is where the gates live; the CONTRACT above is
unchanged.

Track B's visor half is done and gated: the pairing UI now lives in
`visor/ui/pairing.ts` (so §5's "renders only in visor-owned surfaces" is
a property of the framework layer — invariant (f) greps it there), the
demo reaches the ADD ceremony from the visor's settings sheet and the
JOIN ceremony from the tablet pane, and `demo/e2e` covers both
ceremonies plus the marks write-through (`device-pairing`, 14 acts).

**The demo's in-page ceremony runs against the MOCK driver by default.**
`?pairing=engine` selects the real composite through
`runtime/pairing-engine.ts`, and everything above the driver is identical —
but the real path cannot complete a ceremony yet:

- `user-create` **traps the guest** in a real browser: a panic inside
  wit-bindgen's async support (`async_support.rs:578: assertion failed:
  !state.is_null()`), reproduced on an otherwise idle instance with a
  single sequential call, so it is not a host-concurrency artefact. With
  no user group there is no ENROLL (§2 step 6).
- The same call also fails under Deno (`just pairing-bringup`), where the
  BASELINE `just bringup wire` — which contains no pairing at all —
  reproduces the identical host trap
  (`resumeWith: parked thread's instance is not enterable from the host`,
  via the webcrypto signing import). That fault predates this track.
- What DOES work against the real engine in the browser, verified:
  `pair-join-start` (79-char code, with the tablet iroh-bound),
  `us-events`, and the WIT error path
  (`us-profile-get` -> "no user-system partition").

So the remaining integration work is Track A's: `user-create` is the one
call standing between this UI and a live ceremony.

### Status — the live ceremony is the default (2026-08-22)

Both blockers named in the 2026-08-20 note are CLOSED, and the demo's
default pairing backend is now the real engine. `?pairing=mock` selects
the in-page mock; there is no longer any `?pairing=engine` to opt into.

- **`user-create` no longer traps.** The panic was a SCHEDULER
  MISATTRIBUTION in the runtime's async support — the context a resumed
  task was attributed to was not instance-scoped — fixed upstream as
  polyengine#213 and shipped in `@polyengine/runtime` 0.3.1, which this
  tree pins. (The Deno-side `resumeWith: parked thread's instance is
  not enterable from the host` that the baseline `just bringup wire`
  reproduced was the OTHER #49 trap, closed earlier by the 0.2.1
  jspi hop-quiescence gate, deltic#82.)
- **The add side's post-grant linger is a real await**, not a yield
  spin. The spin never let the joiner's ingest run, so a ceremony that
  had gone all the way to the grant could still fail to ENROLL.

What is gated now:

- `demo/e2e`'s `device-pairing` runs the FULL ceremony against the
  composite — offer code, SAS on both surfaces, arming delay, grant,
  ENROLL, and the marks write-through reaching the joined device — in a
  real headless Chromium, over a relay the harness spawns itself
  (`iroh-relay --dev` with an ephemeral `http_bind_addr`, so the suite
  no longer touches the public relay at all). 15 acts.
- `device-pairing-mock` runs the SAME acts (shared
  `e2e/scenarios/device-pairing-acts.ts`) against the in-page mock. The
  mock is retained deliberately: it is the visor-only regression
  harness — no wasm, no transport, no convergence waits — and it is what
  separates "the visor's ceremonies broke" from "the engine, the
  transport or the embedder's sync broke". It is not a fallback for the
  real path.
- `just pairing-bringup` (headless, Deno) and `cd engine && just pair`
  (native acts) both pass unchanged.
- `demo/e2e`'s `solo-pairing` runs the ceremony ACROSS TWO INDEPENDENT
  BROWSER PAGES (`demo/host/solo.ts`, two isolated contexts meeting only
  over the harness's relay) — the case a one-page suite cannot fail,
  since the joiner there has no out-of-band access to the adder's ids or
  to the account's tasks partition. It is what `pair-enrollment`'s
  `peer-agent-id`/`peer-endpoint-id` exist for. 10 acts.

**The embedder owes the pair a sync path.** §2 step 7 ends the ceremony
with "sync", and the engine leaves that to whoever embeds it: pairing
grants MEMBERSHIP and nothing more. So `demo/host/demo.ts` wires
subduction when a join completes — connect, then `sync-start` with
`subscribe` in both directions on the enrollment's partition — exactly
as `engine/host/src/pairing_acts.rs:187`'s `wire_us` and
`demo/host/pairing-bringup.ts` do. Without it the joined device holds a
membership and an empty user-system doc.

One finding worth recording for whoever wires the next embedder: the
DIRECTION is not symmetric in practice. With the writer accepting and
the reader dialling (the direction both existing harnesses use) the doc
converges in about a second. With the roles reversed, the handshake
still reports connected on both sides and both sync handles still report
ready — and nothing ever arrives: the reader's replica stays at revision
0 while the writer's advances. Measured in the browser over a local
relay, 2026-08-22.
