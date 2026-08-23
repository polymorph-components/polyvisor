# Storage egress from the worker host (the round after G5)

The design record for the seam issue #20's G5 close-out named and
runtime/device-store/worker.ts refuses today: a worker-hosted device has
no bucket path, because the four `EngineNet` seams are FUNCTIONS and
functions do not cross the RPC port. This round gives the worker host
real storage egress — G4's browser leg meets the worker host. Rulings
settled 2026-08-22; the authorities are issue #7 (the egress-grant memo
and its engine retrofit), issue #11/#22 (credential escrow, destination
binding, the one-moment-of-cleartext rule), engine.wit's storage-egress
imports, and [PERSISTENCE.md](./PERSISTENCE.md) (the worker host this
builds on). Where this document and reality disagree, report the
friction, do not edit around it.

## The shape in one paragraph

The store closures live INSIDE the worker, built over a worker-held
mutable grant exactly as the demo page builds them over its own
(rebind-not-relink, verbatim). The factories that build them move out of
demo/host/demo.ts into `runtime/store-egress.ts` — one implementation,
two embedders; the demo page remains the in-page reference consumer and
its behavior does not change. The credential ceremony stays on the PAGE,
in visor pixels; the escrow is the same origin keystore
(runtime/keystore.ts, IndexedDB), which a SharedWorker on the same
origin can read directly — so NOTHING SECRET CROSSES THE PORT, in either
direction. What crosses is a `StoreBinding`: addressing plus the public
access-key identifier, as data. The binding persists in the device's
SEALED namespace and the worker re-applies it at every engine bring-up,
because the engine's checkpoint deliberately excludes store CONFIG
("the embedder's `init-store` ADDRESSING, re-applied by the embedder" —
engine/guest/src/persist.rs) and the worker IS the embedder.

AMENDED 2026-08-23 (#93): that sentence is about the ADDRESSING, and for
a while it was doing double duty. Per-doc bucket STATE — the name-key
chain, the flushed-chunk map, manifest entries, grantees, the Dropbox
links — is minted inside the engine, cannot be re-supplied by any
embedder, and now rides the checkpoint beside the keyhive archive. Until
that change it was instance memory, so every worker respawn (a page
reload included) re-minted a keychain and the next flush re-uploaded the
whole store under all-new names. The worker's job is unchanged: re-apply
the binding, and let `stateResume()` bring back everything else. One
consequence lands in rpc.ts: `storeGrant` left `READONLY_METHODS`,
because a grant now mutates checkpointed state.

## Rulings

### 1. The closures live in the worker

`bringUpEngine` wires `newEngine`'s `net` from
`runtime/store-egress.ts`'s factories — `makeOwnerFetch`,
`makePublicFetch`, `makeSharedFetch` over one module-scoped
`EgressGrant`, plus a `store-signer` built by `makeSigner(origin)` from
runtime/keystore.ts. The grant starts empty and every seam refuses (the
same observable posture `NO_STORE` had; the refusal texts change to the
factories' own — "no storage grant configured yet",
"store-signer: no signing credential wired…" — and nothing may depend on
the old strings). The wiring is fixed at instantiation; a bind mutates
the grant's CONTENTS. One consequence stated rather than implied:
selection is still by import name and authority still lives in the
instance (#7) — the worker adds no request-time credential choice
anywhere.

### 2. Nothing crosses the RPC but addressing

The visor's credential ceremony runs on the page, where it always has:
the secret exists for one moment in the credential sheet because the
user typed it, `putSigningKey(origin, accessKey, secret)` escrows it as
a non-extractable HMAC handle, and the string goes out of scope. The
worker reads the handle back BY DESTINATION ORIGIN from the same
IndexedDB database. rpc.ts's serialization discipline survives intact:
no method on the wire moves a CryptoKey, a function, or a secret string.
(A CryptoKey handle would in fact structured-clone across the port —
that is how IndexedDB persists it — and it is still not done: the
keystore is the one home for escrowed material, and a second path would
be a second thing to audit.)

The keystore is ORIGIN scope, deliberately, and the honest description
is a profile keychain: records are keyed by DESTINATION, not by device;
the demo page and every solo device on the origin share it; it is
already only as strong as profile access control (keystore.ts's honest
limit). The DB name stays `pm-demo-keystore` — renaming a stored-data
key buys a migration and no property.

### 3. The binding is device state, sealed

The `StoreBinding` persists via `sealedPut(ns, "storage", …)` under the
device's DEK. Pre-unseal, nothing on disk names the destination (the
index is untouched; the sealed kv is ciphertext). At every
`bringUpEngine` the worker reads the binding, populates the grant,
builds the signer, and — after `stateResume()`/`init` — re-applies
`driver.initStore(config)`. A device therefore syncs to its bucket on
every unseal with no page-side state and no re-entry of anything;
the demo's localStorage config store is page furniture the solo device
does not grow.

### 4. Worker-side enforcement: the grant is derived, never accepted

The host RPC is `bindStore(binding)` (and `unbindStore()`), and the
worker DERIVES the allowlists from the destination —
`normalizeOrigin(endpoint)` becomes the owner and public origin sets,
the shared set stays empty (S3 has no app tier) — so a client cannot
hand an allowlist wider than the destination implies. `bindStore`
refuses when the device is sealed, when the endpoint is not a usable
origin, and when NO CREDENTIAL IS ESCROWED for that origin (fail at
bind, not as a 403 twenty provider calls later — the demo's own rule).
Origin confinement at request time is the factories', structural
(scheme+host+port via the platform parser, never a prefix test).

### 5. v1 is S3 only, chrome only

The solo page grows ONE storage sheet — a visor drawer tenant opened
from the settings sheet, chrome-owned fields (endpoint, bucket, access
key, secret behind the masking type), a step-announced connect that
escrows, binds, and runs `ensureBucket`/`storeGrant`/`bucketFlush`, and
a sync-now control. No picker, no provider panels: with one worker-side
provider there is nothing to pick, and the picker/panels registry stays
the demo page's until a second provider forces it. The invariants hold
by construction — the secret is typed in visor pixels, no component is
even present on the path.

**Dropbox is PARKED for the worker, with the reason recorded**: a bearer
is a disclosed string with no platform escrow (the SigV4-vs-bearer
asymmetry on #22), so handing one across the port is exactly the
cleartext crossing this design bans, and sealing one into the namespace
still requires that crossing at deposit. The v2 shape, recorded not
built: the WORKER runs the token exchange — it mints the PKCE verifier,
the page relays only the one-shot authorization code, and the bearer
then never exists in page memory at all.

### 6. Reseal, and what happens to the credentials

Reseal drops the device's IN-WORKER egress authority with everything
else: the grant contents are emptied, the signer and its scope-key
cache are dropped alongside the DEK and the engine. The sealed binding
rests sealed and returns at the next unseal. The keystore record
PERSISTS: it is profile-tier escrow, destination-bound, shared by every
device on the origin, and deleting it at one device's reseal would take
the other devices' signing with it. The honest sentence, for the UI and
for review: sealing a device does not seal the escrow — it takes away
this device's name for it. Deleting the escrow is the erase ceremony's
job (keystore.ts's `eraseKeystore`), as it already was.

Two edges ruled with it: a sealed binding whose escrow was erased
underneath it unseals fine and refuses at first signature with the
signer's named refusal (recoverable: re-enter the secret in the sheet,
which re-runs the bind and mints a fresh signer — never a stale
scope-key cache); `unbindStore` clears the sealed binding and empties
the grant immediately, while the live engine instance keeps its
addressing until the next bring-up — every subsequent egress refuses at
the seam, which is the property that matters and the one the matrix
checks.

### 7. What moves, what must not change

`EgressGrant`, `emptyGrant`, `normalizeOrigin`, `requestOriginOf`,
`sendRequest`, the three fetch factories, `refusingOwnerFetch`, the
Dropbox origin tables and the refresh path move VERBATIM in semantics
from demo/host/demo.ts to runtime/store-egress.ts; the bearer-refresh
mirror hook becomes a parameter instead of a module-scoped `let`. The
engine, its WIT, and the guest are untouched. The invariant scans
already cover the new territory (`../runtime/*.ts` and
`../runtime/device-store/*.ts` are in checks (c), (d), (h)); no scan
widens this round, and that was checked rather than assumed.

## Gates

- **runtime/tests/devstore**: the existing 26-row matrix stays green;
  new rows cover — bind refused sealed / unescrowed / bad origin; bind
  succeeds and `status().storage` reports addressing; the binding
  survives `__die` + re-unseal (and the seam is live again: a bucket
  call fails at TRANSPORT, not at "store not initialized"); reseal hides
  it, re-unseal restores it; unbind refuses at the seam; and the moved
  factories gate directly (origin confinement, authorization stripping,
  the public tier's anonymity) against an in-harness echo server.
  Synthetic labeled credentials only.
- **demo just check**: 8/8, no widening.
- **just site**, **just e2e**: 16/16 existing plus `solo-storage` —
  MinIO-backed, drives the real sheet: escrow lands non-extractable in
  IndexedDB and NOWHERE in localStorage, objects appear in the bucket
  (MinIO's data dir is the harness's own filesystem), the binding
  survives a real reload with no re-entry, reseal reports it sealed.
  credential-flow remains the page-side reference.
- **pairing-bringup**, **resume-bringup**: untouched paths, stay green.

## Parked, explicitly

Dropbox-from-the-worker (the v2 worker-run token exchange above — since
BUILT for Google Drive, see [DRIVE.md](./DRIVE.md), which makes the
Dropbox retrofit cheap when wanted); the solo storage picker/panels
registry; per-device keystore partitioning
(would break the shared-escrow model for no strength gain at this
tier); bucket-only sync between two solo devices as an e2e scenario
(wants a relay the harness can drop mid-scenario); widening the
signer's fixed region/service scope (a design decision, not a
configuration one — keystore.ts's constants stand).
