# Recovery: the account outlives its last device

The design record for the round that closes SYNC.md's parked item —
account bootstrap without a live peer — and #11's recovery-path body.
Rulings settled 2026-08-25 (discussion with the project owner; the
file-kit amendment is the owner's). Sibling records:
[PERSISTENCE.md](./PERSISTENCE.md) (the device store, the KEK ladder,
the recorded PRF dual-eval seam), [SYNC.md](./SYNC.md) (the name-chain
account state and the account pull path this design bootstraps into),
[STORAGE-EGRESS.md](./STORAGE-EGRESS.md) (the worker's seams the restore
ceremony rides). Where this document and reality disagree, report the
friction, do not edit around it.

## The claim

Losing every device does not lose the account. A recovery kit — a
generated phrase, or a downloaded file plus its passphrase — together
with access to the account's storage bucket restores the account on a
fresh browser with **no live peer anywhere**. The bucket is already the
account's durable half (SYNC.md); this round gives it a durable key.

Honest floor, stated: bucket + all devices lost = the account is gone.
No copies exist anywhere by construction; that is what local-first with
an E2E bucket means. The kit is the bucket's key, not a second bucket.

## The core ruling: recovery is a DEVICE, not a resurrection

The kit ceremony mints a **dormant member device** — a real leaf in the
account's delegation graph, visible in the devices sheet under the
user's own label, revocable like any device. Its secrets exist only
inside a sealed bundle (in the bucket, or in the user's downloaded
file). Restore boots that device.

Why not export the live device's own identity (the G5 bundle's shape):

- **Platform posture survives.** A kept device's signing key is a
  non-extractable platform handle — that is the point of it. An
  exportable kit from that device would require a posture downgrade for
  every device that wants recovery coverage. A minted-for-export soft
  identity leaves every real device's posture untouched.
- **Dormancy kills staleness.** The G5 finding stands: self-rotation
  secrets exist only in the archive — a bundle exported before its
  device's own authoring cannot reach epochs that authoring created.
  The recovery device NEVER AUTHORS between mint and restore, so its
  leaf never self-rotates, so the bundle's archived leaf secrets stay
  valid indefinitely: every later epoch reaches it through CGKA ops in
  the flushed oplogs, addressed to a leaf it still holds. This is the
  proven G4 tablet path (enrolled, offline through rotations,
  bucket-bootstrapped) with the tablet's browser replaced by a sealed
  blob. No refresh daemon exists because none is needed.
- **Its own revocation story comes free.** A leaked phrase or file is
  answered by revoking the kit device in the devices sheet — the same
  mechanic as a lost phone, because it IS the same thing.

## The bootstrap: K_p answers the us-doc chicken-and-egg

SYNC.md moved the per-doc name chains into the us-doc (account state)
and removed pickups between account siblings — which is exactly why a
cold restore could not start: the us-doc's own chain is inside the
us-doc. The kit ceremony closes the loop with machinery that already
exists: `store-grant(us-doc, recovery-id)` writes the recovery device a
**K_p pickup** — the non-account-reader bootstrap object, carrying the
us-doc's name-key chain and the author device list, sealed to the
recovery device's contact-card prekeys (which ride the bundle).

Restore order: import bundle → adopt the us partition (id and user
group ride the bundle) → `bucket-pull(us, owner, none)` takes the
pickup fork (`account_sibling` reads the still-empty local directory
and correctly answers no) → chain + authors in hand → us-doc content
applies → the account pull path (SYNC.md §2) now works for every
partition in the pointer map. ONE pickup bootstraps everything.

**`KpPayload.devices` fix, riding along.** `publish_kp` fills the
payload's device list from `grantees` — pre-SYNC.md that was the author
set, because every member got a pickup. Post-SYNC.md account devices
are not granted pickups, so a fresh account's us-doc K_p would name no
real author and the restore would pull from nobody. The payload's
device list becomes the union of the account device directory
(`usdoc::devices_list`) and the grantees — the honest author set for
account docs, unchanged in meaning for the link tier.

**The us-doc through the bucket, unparked (settled in T-A).** SYNC.md
scoped the flush/pull cycle to the pointer map and parked the us-doc;
this round unparks it. The WIT surface: an EMPTY `doc-id` on
`bucket-flush`/`bucket-pull` names the account's user-system document
(previously meaningless on every arm; the us id itself stays hidden).
The worker's flush/pull cycle MUST include it — the engine flushes the
us-doc only at the moments it controls (kit create, revoke, consume),
and a restore can only be as fresh as the last us flush.

## Two kit kinds, one mechanism

| | bucket kit | file kit |
|---|---|---|
| artifact | sealed bundle at a phrase-derived bucket name | sealed bundle as a downloaded file |
| unlock | generated recovery phrase (~10 diceware words, 100+ bits) | user-chosen passphrase (argon2id, random salt) |
| exposure rule | replicated ⇒ generated-secret slot ONLY (the brainwallet/LastPass lesson: nothing the system replicates is crackable via human memory) | custody makes it have+know — the passphrase slot is sanctioned for a file the user holds (PERSISTENCE.md's table, unchanged) |
| finds the bundle | name derives from the phrase — nothing else needed | the file IS the bundle |
| single-use enforcement | bundle object + K_p deleted at restore | K_p deleted at restore (the file cannot be deleted; without the K_p a second restore refuses cleanly at the us bootstrap — a 404, never a fork) |

**Bucket kits are S3-only at this rev (settled in T-A).** The bucket
kind needs an owner-tier PUT at a NAME the guest derives, and only S3
addresses objects by name — Dropbox and Drive resolve ids through a
folder walk, so a phrase-derived name is not a location there without
a design decision this round does not make. Refused by name at both
create and restore; the FILE kit stores no object and works on every
provider, so no provider loses recovery coverage. Drive bucket kits
are PARKED, not precluded. One more provider edge, recorded:
`recovery-consume` forks by provider (S3 and Drive arms exist;
Dropbox refuses by name because its pickup delete has no
absence-as-success path and a non-idempotent consume would spin the
retry loop — `recovery-kit-revoke` from the devices sheet is the
equivalent end state there).

The file kit is the owner's amendment: disallowing custody would be
paternalism, so the ceremony WARNS LOUDLY instead — the passphrase's
strength is the user's own; the file plus its passphrase open the
account; the file is dead the day it is used or its device revoked.
Both kinds still require a bound store at creation (a kit without a
bucket restores nothing — content rehydrates from the bucket) and
storage credentials at restore (credentials never ride bundles: the S3
secret is a non-extractable handle with no bytes to carry, and OAuth
tokens are device-scoped by DRIVE.md's ruling).

## Single-use, consumed at restore

Restore consumes the kit: the bundle object (bucket kind) and the K_p
(both kinds) are deleted after the restore fully succeeds, the us-doc
kit record is cleared, and the visor announces "your recovery kit was
used — create a new one". Rationale, recorded in full on the #11
thread and compressed here:

1. **Dormancy is what makes the kit trustworthy, and restore ends it.**
   The restored device authors; its leaf rotates; the bundle is now
   permanently behind the device it claims to restore. A reusable kit
   therefore needs a silent background re-exporter of the crown-jewels
   artifact whose failure is invisible until the disaster it exists
   for. Single-use plus a cheap re-mint ceremony reaches the same end
   state through an explicit, announced, user-witnessed act.
2. **Double-restore is an identity fork.** Two live instances of one
   identity clobber each other's keyed oplog/manifest names — the
   single-writer-per-name invariant SYNC.md requires preserving.
   Consumption makes the fork structurally impossible.
3. **The phrase is spent at restore time.** Recovery happens on the
   machine and at the moment least favorable to secret hygiene. With
   consumption, a phrase passively captured during the ceremony is
   worthless afterward.

The honest cost: a window with NO kit after restore, until the user
mints a fresh one. "No kit, loudly" is recoverable by a ceremony;
"bad kit, quietly" is discovered at the disaster. Consume failures
(unreachable bucket at the end of a restore) never block the restore:
they announce and retry on the flush cadence's backoff loop.

**The consume-checkpoint discipline (settled in T-B's revision, pinned
by devstore row 64 with a negative control).** The restore's FIRST
checkpoint deliberately precedes the consume — a crash between them
burns the kit with nothing durable, a lockout on a last device. But a
consume that outlives its checkpoint is RESURRECTED by the next worker
respawn: internal driver calls bypass the mutation-armed checkpoint
debounce (which dispatches client requests only), and the consume's
flushed clear sits under the device's OWN keyed names, which the pull
fan-out self-filters — durable in the bucket, permanently invisible to
its author. So every successful consume is followed by a second
checkpoint, `consumePending` clears only after it lands, and the same
rule covers the ceremony's other internal mutations: kit CREATE and
REVOKE checkpoint explicitly too (a respawn forgetting a kit whose
phrase the user just wrote down, or resurrecting a revocation the
provider already executed, are the same stranding). The scheduler's
own bucket-state mutations stay un-checkpointed on purpose: that state
self-heals from the account document and the next pull's manifests,
and the cost is one duplicate upload, never an unrecoverable fact.

## The kit ceremony (account device, guest-side)

1. Mint a fresh soft Ed25519 identity — the recovery identity — and a
   THROWAWAY keyhive for it: contact card (prekeys minted), then
   archive it immediately. The archive is tiny and signed by the
   recovery key, which is what `try_from_archive`'s same-signer rule
   requires at restore.
2. Ingest the recovery contact card into the account keyhive; enroll
   through the existing `enroll_device` path — admin membership, the
   deliberate epoch rotation, the devices entry (walk anchor for the
   us-doc), `anchor_data_partitions` (walk anchors everywhere else).
   The kit appears in the devices sheet under the user's label.
3. `store-grant(us-doc, recovery-id)` — the K_p, with the fixed device
   list.
4. Build the bundle (payload below); seal under the kind's slot;
   bucket kind uploads at the derived name (owner tier), file kind
   returns the bytes for download.
5. Record the kit in the us-doc (`recovery` map: agent-id-hex →
   {kind, bucket object name or empty, created}) — any account device
   can then revoke or supersede it; the object NAME is not secret
   material (the provider sees the object regardless; the payload is
   sealed under the phrase-derived KEK).
6. Scrub the recovery seed and the throwaway keyhive from memory. The
   worker then flushes the us-doc and every named partition, so the
   kit is valid the moment the ceremony reports success.

Bundle payload (extending G5's `BundlePayload`): recovery seed +
verifying key, the recovery keyhive archive, the ENROLL CARD (the
static events exported for the recovery individual — belt and
suspenders against op-arrival-order wedges; the oplogs carry the same
events), the us partition id, the user group id, the granting device's
agent id (the K_p location's owner component), and the account's
storage ADDRESSING snapshot (the us-storage record's secret-free
shape) so a file restore can pre-fill the destination fields after
unlock. The bucket kind cannot use the snapshot for the fetch itself —
finding the bundle needs the destination first — so its ceremony asks
for destination and credentials, as the file kind's asks for
credentials only.

## Restore (fresh browser, worker-driven)

Fresh T0 device namespace; engine instantiated with NO init; the
storage ceremony binds the store (the existing bindStore path — S3
escrow or the Drive OAuth popup); then the guest restore: derive (or
receive) the bundle → open the slot → verify seed/verifying
consistency → `try_from_archive` with the recovery signer → ingest the
bundled enroll card → adopt the us partition → K_p pull → the account
pull fan-out (pointer map × device directory) → the restored device
writes its own devices entry (the ceremony's device name — the kit's
label gives way to the user's word for the machine it became) → first
checkpoint → consume. The visor claims at the end: colour, name, icon
arrive from the pulled profile — unseal-as-login's anti-spoofing
property holds for restore too, and nothing personal renders before
the account state is genuinely in hand.

The restored device runs SEED posture (its identity came from a
bundle; the checkpoint carries it, DEK-sealed, exactly as the existing
seed back-compat path does). Recorded honestly: that is one notch
below platform posture, and the platform-posture migration for a
restored device is PARKED with #11's rotation design.

## Derivation, pinned

Phrase: 10 words, uniform from the EFF short wordlist (1296 words,
CC-BY — attribution in source), ~103.4 bits; generated IN-GUEST
(single authority for format and derivation), displayed once in visor
pixels, never persisted anywhere; normalization at entry is trim +
lowercase + collapse-internal-whitespace.

- root = argon2id(normalized phrase, salt = fixed context string
  `polyvisor-recovery-v1`, the existing spike-scale params). The salt
  is fixed BECAUSE the name must be derivable from the phrase alone;
  the phrase's generated entropy is the security, argon2id is depth
  (the brainwallet objection applies to human-chosen secrets, which
  this slot never holds).
- bucket object name = `recovery/` + hex(HKDF-SHA-256(root,
  info = "polyvisor recovery name v1")).
- slot secret (KEK) = HKDF-SHA-256(root,
  info = "polyvisor recovery kek v1") into the existing
  `BundleSlot::Secret` machinery.

File kit: the existing `BundleSlot::Passphrase` (argon2id, random
per-file salt riding the slot), unchanged.

## Threat model deltas (for #1)

- The provider sees: one more member leaf's worth of CGKA ops, a K_p
  object, and (bucket kind) one sealed bundle object at an
  opaque name — metadata inside the declared non-goal.
- The phrase/file+passphrase is a full-account credential (read AND
  write once restored). The kit device's revocability is the answer to
  leakage; the devices sheet is the interface.
- A phrase-holder can also DENY: restore consumes the kit, and a
  malicious restore both takes the account state and burns the kit.
  Not new authority — the same holder could already read everything —
  but the denial edge is recorded.
- The restore ceremony types the secret into page script: the same
  exposure class as the passphrase unseal rung, priced identically
  (PERSISTENCE.md's trust sentence).
- Storage rebind strands kits in the old bucket (K_p and bundle do not
  migrate). RECORDED CAVEAT: the storage ceremony's copy tells the
  user to re-mint kits after a destination change; no migration
  machinery.

## Parked, explicitly

The PRF second-input slot on the bucket kit (the dual-eval seam,
PERSISTENCE.md — recorded, not built); kit auto-refresh of any kind;
account-wide kit migration on storage rebind; multiple restores as
enrollment (pairing owns that); platform-posture migration for
restored devices; escrow spectra (social/provider) — #11's original
deferral, unchanged.

## Tracks and gates

- **T-A (engine, first — it defines the WIT):** the recovery surface
  (`recovery-kit-create` bucket/file arms, `recovery-restore`
  bucket/file arms, `recovery-kit-revoke`), the throwaway-keyhive mint
  + enroll + K_p grant, the payload extension, the derivation, the
  consume path, the `KpPayload.devices` union fix, the us-doc
  `recovery` map. Gate: a NEW `just recover` acts battery — bucket-kit
  and file-kit restores against MinIO with content equality asserted;
  a post-kit revocation epoch crossed before restore (the CGKA
  catch-up claim made executable); wrong phrase and wrong passphrase
  refused as clean slot failures; double-restore refused at the
  missing K_p; consumed artifacts verified gone; `just pair`,
  `just resume`, clippy stay green.
- **T-B (worker/runtime):** the restore bring-up mode (fresh
  namespace, defer-init, bindStore-then-restore sequencing), the kit
  RPC (phrase crossing once, scrubbed, never persisted — the
  passphrase rung's discipline), consume-retry on the backoff loop,
  post-restore checkpoint + schedule arming. Gate: devstore rows —
  kit create/restore round-trip against the harness store; the phrase
  appears NOWHERE in IndexedDB/localStorage/OPFS after the ceremony
  (scan row); double-restore refusal typed; consume-failure announced
  and retried.
- **T-C (solo page + visor):** the kit ceremony sheets (kind choice,
  phrase display-once with confirm, file download + passphrase with
  the loud-warning copy), the picker's "Restore from recovery…" path
  (destination + credentials, progress, claim-at-end), kit management
  in the devices/storage surface (list from the us `recovery` map,
  revoke). Gate: e2e — `solo-recovery` creates a kit, captures the
  phrase from the sheet, DESTROYS the browser context, restores in a
  virgin context from phrase + re-entered credentials, and finds the
  todos; a file-kit variant covers download/upload restore; the
  existing suite stays green.
