# Bucket sync: when storage moves without being asked

The design record for the round that turns the bucket from a write-only
backup button into the product claim: a solo device that syncs through
its bucket while its siblings are asleep. Rulings settled 2026-08-23
(discussion with the project owner); the constraint measurements this
rests on are recorded inline. Sibling records:
[STORAGE-EGRESS.md](./STORAGE-EGRESS.md) (the worker's seams),
[DRIVE.md](./DRIVE.md) (the provider, the spaces, the account-synced
config). Where this document and reality disagree, report the friction,
do not edit around it.

## What exists going in

Flush happens exactly twice: once at the connect ceremony and when the
user presses "Sync to storage now". Pull never happens on the solo page
at all. The object model is single-writer-per-name by construction —
`oplog-*`/`manifest-*` carry the writing device's verifying key in the
keyed name, pickups carry (owner, member), chunks are content-addressed
— which is why no ETag/If-Match exists anywhere and why this round must
preserve that invariant rather than add locking. The manifest is
written LAST per flush: the layout already has a commit point.

## The three pillars, in dependency order

### 1. The name-keychain derives from keyhive — one chain per doc, not per device

TODAY `ensure_bucket_state` mints `name_keys` from `rand::random()` per
device, and the only distribution channel is the pickup object, which
nothing on the solo page reads. Two devices bound to one bucket
therefore write two parallel keyed namespaces — different doc-folder
names, disjoint object sets, full content duplicated per flusher —
cross-readable only by naming the other device as pull owner. This is
the respawn defect's shape (#93) made cross-device and permanent, and
automating flushes against it would industrialize the duplication.

THE RULING (amended 2026-08-23, after the feasibility caveat below
FIRED): the per-doc name chain becomes ACCOUNT STATE — a guest-internal
map in the user-system doc (docid → chain), synced E2E between the
account's devices exactly as the profile, marks and storage config
already are, and never exposed through WIT. Every member device holds
the identical chain because the account syncs it; rotation stays where
it is today (`store_revoke` appends an epoch, and the sync distributes
it); a revoked device stops learning new epochs because its us-doc
sync stops — keyhive membership enforcing the boundary, one layer up
from where the first ruling wanted it. The pickup keeps carrying the
chain for NON-account readers (S3's link tier), unchanged.

- CONCURRENT FIRST-MINT: the race is wider than "two devices at setup"
  — ANY device flushing before the chain's automerge change reaches it
  would mint a fork, and pillar 3 makes early flushes ordinary. RULED
  CLOSED BY CAUSAL ORDERING: `us-partition-put` seeds the chain
  (mint-if-absent) BEFORE writing the pointer, in the same us-doc —
  automerge applies same-doc changes causally, so pointer-visible ⇒
  chain-visible, and a device cannot flush a doc whose pointer it has
  not seen. The residue is legacy docs (pointer published before this
  code) and account-less devices, where first-flush mint-if-absent
  remains: one flush's worth of orphans, self-healing, recorded.
- Device-revoke does not yet rotate chains (only store-revoke does).
  Recorded as a follow-up rather than built: a revoked OWN device still
  holding the user's OAuth is already outside this provider's threat
  reach (DRIVE.md §1's honest revocation note), so chain rotation adds
  little until that story changes.
- THE SELF-ADDRESSED CHAIN DROP (added 2026-08-25, closing #110). A
  us-doc rotation used to strand a bucket-only lagging sibling
  PERMANENTLY: the new epoch's objects sit under names only the new
  chain derives, and the chain lives in the very document those names
  gate — the sibling silently reads the rotator's stale old-epoch
  manifest forever, until wire contact. Now `store_revoke` on the
  us-doc writes every NON-REVOKED account device a sealed copy of the
  new chain at `kp_location(us, member, member)` — the K_p machinery
  self-addressed: one derivable location per member, any rotator
  writes it, payload sealed to the member's contact-card prekeys
  exactly like a grantee K_p (same payload, same sealing, different
  addressee derivation) — and the S3 sibling pull PROBES ITS OWN DROP
  before deriving any name, adopting a strictly longer chain
  (idempotent: chains only extend). The revoked member's drop is
  deleted beside its K_p. Concurrent rotators last-writer-win the
  drop, exactly as the chain register itself is LWW under concurrent
  rotation — the drop is a best-effort freshness channel; us-doc sync
  over the wire remains the truth channel. Drive writes and probes no
  drop BECAUSE its store-revoke arm never rotates (names there are not
  access control, by its own ruling) — the reading half is
  provider-neutral and the re-add is three lines per side if a trigger
  ever exists. Gates: the recover battery's act 9 (one pull across a
  missed rotation, with a runnable `PM_NO_CHAIN_DROP` negative control
  reproducing the strand), devstore row 67 (the same claim through the
  worker's own pull path; row 63's no-revocation pair constraint is
  now historical). Parked: the change-board epoch-ordinal
  optimization (probe only when the board says the chain moved).

THE FIRST RULING — derive from keyhive epoch secrets, G4's coupling
sketch — is RECORDED AS THE BLOCKED IDEAL, not deleted: it would make
rotation align with membership epochs automatically and for shared
docs across accounts. It fired its stated feasibility caveat:
keyhive_core exposes a per-doc secret for the CURRENT epoch only
(`Cgka::new_app_secret_for`, deterministic per head), has no integer
epoch indexing at all (`pcs_keys` is an unordered, evictable
content-addressed cache), and gates historical reconstruction
(`Cgka::secret`) behind `test_utils` — while the one public
epoch-stable value (`try_pcs_key_hash`) travels IN CLEARTEXT inside
every envelope this design uploads, so naming with it would hand the
storage provider the name key. The unblock is a two-line upstream
promotion (`pub fn pcs_key_for_op`); if upstream ever takes it, the
derivation can replace the synced map without changing any observable
name (the chain values would differ; the architecture would not).

MIGRATION IS A CLEAN BREAK. Derived chains rename every object, so
pre-derivation stores are simply not readable by the new code. The
deployment reality is one tester's experimental stores; the honest cost
is "reconnect and re-flush", and the record says so instead of building
a compatibility ladder nobody would climb. (A device with old state
re-uploads everything under derived names on its next flush; orphaned
old folders are the user's to delete.)

### 2. Pull: at bring-up, then on a slow cadence, cheap when idle

- PULL AT BRING-UP: after the worker re-applies the binding and the
  engine is up, one `bucketPull` per partition in the account's pointer
  map, BEHIND readiness — boot never blocks on the network. This is the
  beat that makes "my other device wrote while this one was closed"
  true.
- THEN A SLOW CADENCE while unsealed (45s), and the cadence is dumb ON
  PURPOSE: the scheduler just calls `bucketPull`; cheapness-when-idle
  lives INSIDE the provider strategy, not in the scheduler —
  - Drive: the doc folder's `appProperties` become the CHANGE BOARD.
    Each device PATCHes its own key at flush commit (metadata-only
    `files.update`, 50 quota units; key = truncated device tag, value =
    flush seqno — inside the 124-byte pair budget); `bucket_pull`
    consults the board first (one metadata `files.get`, 5 units) and
    short-circuits to "unchanged" when no sibling's seqno moved.
    `appProperties` are per-key-merge on update (each device owns its
    key — the single-writer invariant extends to the board), private to
    the client id (which the BYO ruling already makes account-uniform),
    and work in the appdata space. THE BOARD IS A HINT, NEVER TRUTH:
    correctness must survive a lost, stale, or clobbered property — the
    manifests remain the source, a full pull remains complete without
    the board, and a wrong hint costs one extra or one delayed poll,
    self-healing at the next flush. (Concurrent disjoint-key patches
    both landing is the documented per-key-merge model; it is on the
    live-beat checklist because the fake cannot prove Google's
    serialization. The 30-properties cap means ~30 devices per doc
    board; parked, not designed for.)
  - S3: no appProperties; the short-circuit is a HEAD/metadata check of
    the sibling manifests, or nothing at all — an idle S3 pull is cheap
    enough to just run.
- THE ACCOUNT PULL PATH (ruled 2026-08-23, after the round's own e2e
  exposed the gap): pulls between ACCOUNT SIBLINGS do not use pickup
  objects at all. A pickup exists to bootstrap a reader who cannot
  derive — but a sibling's puller already holds the chain (account
  state, §1) and the sibling's identity (`us-devices-list`), and the
  sibling's oplog/manifest names are derivable from exactly those two.
  So `bucket_pull` forks internally on "is the named owner an account
  device": sibling → derive and read directly, no pickup; non-account
  owner → the pickup path, unchanged (S3's link tier lives there). A
  sibling that has never flushed reads as absence — an empty pull,
  never an error. The rejected alternative (publish pickups for every
  directory device at bind/flush) is recorded with its costs:
  per-flush write amplification and a bootstrap ordering problem (a
  new device needs a pickup written FOR it before it can pull) that
  the us-doc path structurally lacks.
- No new WIT surface: flush already no-ops on nothing-new (the
  `flushed` map), and pull learns to no-op on nothing-new. The
  scheduler stays a timer.

### 3. Flush: scheduled by the worker, backed off like Google asks

- The WORKER owns the schedule (it owns the engine, the binding, and
  outlives tabs): a TRAILING DEBOUNCE (~20s) armed by the same
  mutation notifications that arm the 500ms checkpoint — flush is the
  checkpoint's slower sibling, and deliberately far from the hot-file
  429 heuristics (the one Drive limit that binds; the documented quota
  units are three orders of magnitude away at our volumes — measured
  2026-08-23: one flush ≈ 750 units against 325k/min/user). Plus the
  two moments the checkpoint already honors: last-client-disconnect
  (best-effort) and BEFORE RESEAL (the reseal-saves-first discipline
  extends: seal means everything the account should have crossed the
  wire or the bucket... flush-before-reseal is BEST-EFFORT, not a
  refusal condition — reseal must not become hostage to an unreachable
  bucket; the checkpoint half stays mandatory).
- BACKOFF: the scheduler treats ANY failed background flush/pull as
  backoff-with-jitter (truncated exponential, factor 2, cap 10min) —
  transient-vs-permanent triage is not worth string-matching error
  text for a background loop; Google's 429/403-rate contract is
  thereby honored as a special case of honoring everything. After
  three consecutive failures the visor ANNOUNCES (the seam's own error
  sentence), because a sync that has silently stopped is a lie of
  omission. A USER-initiated Sync-now bypasses the backoff and reports
  its refusal immediately — an explicit act deserves an explicit
  answer.
- Scope: the partitions flushed/pulled are the account pointer map's
  (`usPartitions`). The us-doc itself still travels only the wire;
  account bootstrap from bucket alone remains the identity-bundle
  story, parked.
- Surface: `DeviceStatus` grows a `sync` record (last flush, last
  pull, backoff state, per the picker-safe rules — timestamps and
  booleans, nothing secret); the sheet renders "last synced" beside
  the Sync-now button it keeps.

## Gates

- Engine: the derivation lands under the existing acts — the gdrive
  bringup's cold pull now ALSO asserts one doc folder and zero
  duplicate chunk names across the two devices (the dedupe claim);
  `just pair`/`just resume` stay green; a derivation unit row pins
  chain-equality across two engines sharing a doc.
- Devstore: rows for the scheduler mechanics on one device — a
  mutation flushes within the debounce window with no button press;
  an injected failure backs off (fake grows an on-demand refusal) and
  the announcement fires after three; boot pull runs behind readiness;
  the board patch lands at flush commit and the short-circuit answers
  "unchanged" without touching manifests (fake asserts request
  counts).
- e2e, the money shot — OFFLINE SYNC: pair A and B; close B; A authors
  and (auto-)flushes; CLOSE A; reopen B with no live peer anywhere —
  the todo appears via boot pull alone. Plus the account-storage
  scenario keeps passing (adopt-connect now also inherits the derived
  chain implicitly).
- The live beat gains: two real devices against real Drive, and the
  disjoint-key patch check (two devices flushing near-simultaneously;
  both board keys present afterwards).

## Parked, explicitly

The us-doc through the bucket (account bootstrap without a live peer —
the identity-bundle story); >30 devices per board; `changes.list` as a
finer-grained hint (adopt only if per-object granularity ever pays);
push-style change notification (needs a server); flush-priority tiers
between partitions.
