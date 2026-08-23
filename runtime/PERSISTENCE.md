# Persistence: the device store, sealing, and the worker host (G5)

The design record for issue #20's G5 — the gap between "every page load
is a fresh device" and devices that survive. Rulings settled 2026-08-22
(discussion with the project owner); platform facts from
[spikes/worker-host/](../spikes/worker-host/) (the executed matrix) and
the wosh project's validated key-persistence patterns
(`~/p/wosh/site/identity-store.ts`, `passkey-store.ts` — cited per
finding below). This document governs the implementation tracks; where
it and reality disagree, report the friction, do not edit around it.

## Vocabulary

- **Device** — one engine identity plus everything it holds: keyhive
  archive, chunk store, us-doc state, visor cache. A browser may hold
  many devices; a device belongs to one browser (it never syncs as
  bytes — accounts sync through the engine, devices do not).
- **Device store** — the browser-side home of all devices on an origin:
  the index plus one namespace per device.
- **Index** — the one unsealed database: the list of devices a boot can
  offer. Contents are strictly bounded (below).
- **Namespace** — one device's storage: an IndexedDB database
  `pm-device-<id>` (sealed blobs, key handles) and an OPFS directory
  `pm-device-<id>/` (chunk store, archives — bulk bytes).
- **Tier** — how long a device lives: T0 (tab-ephemeral) or T1
  (durable). A promotion, not a menu (below).
- **Seal / unseal** — encryption at rest for a device's state, and the
  ceremony that opens it. Unseal is the login.
- **Posture** — how the device's signing identity rests: `platform`
  (non-extractable WebCrypto handles, persisted as handles) or `seed`
  (extractable seed inside the sealed bundle). Platform is the target;
  seed is the recovery/export format and the fallback posture.

## The index: what may exist before unseal

The index is readable by exactly the adversary the sealing defends
against (disk, backups, synced profiles), so it carries the minimum a
picker needs and nothing personal:

- device id (opaque), **device petname** (user-typed at creation,
  e.g. "laptop" — ruled acceptable in the clear), tier, posture,
  created/last-used timestamps, and the unseal-policy tag (so the
  picker knows which ceremony to offer).
- NEVER: the anchor colour (invariantly undisclosed — check (c) already
  enforces that it is not even ambient in the DOM), the user's name,
  the user's icon, any account identifier, any key material.

Pre-unseal chrome is therefore generic. The user's colour, name and
icon appear at the moment of unseal — which gives unseal-as-login a
real anti-spoofing property: a page imitating the picker cannot paint
your colour. Render nothing personal until the seal opens.

## Namespaces: strict partitioning

One namespace per device; no sharing, ever, in v1 — two devices are two
replicas, and coupling their storage would shortcut the epoch and
membership story the engine exists to enforce. (Door deliberately left
open: the chunk store is ciphertext keyed by cref, so a future
privacy-preserving dedupe across same-account devices has a plausible
shape. Parked, recorded, not designed.)

localStorage is not used for device state at all: it cannot hold
CryptoKey handles (no structured clone), it does not exist in workers
(the device host lives in one), and it buys no eviction advantage —
modern eviction is origin-granular, so nothing survives differentially.
At most it may carry a non-personal boot hint (last-used device id).

## Tiers, as a promotion

- **T0 (ephemeral)** — where every device starts. State lives in the
  worker's memory; a checkpoint (below) makes it survive RELOAD but not
  tab close. Nothing about it is durable and nothing personal touches
  disk unsealed.
- **T1 (durable)** — "keep this device": the promotion moment is where
  the seal choices are asked (unseal policy, posture), the namespace
  becomes durable, and `navigator.storage.persist()` is requested.

This is the first-run shape (#37): try, then keep. No upfront ceremony.

### T0 reload survival: the sessionStorage anchor

The spike measured Chromium respawning the SharedWorker on every
single-tab reload (the zero-client window at navigation), so reload
survival is checkpoint + rehydrate, not worker-memory luck:

- The tab holds the ONLY pointer to a T0 namespace in sessionStorage;
  on reconnect after reload, the tab hands the pointer to the fresh
  worker, which rehydrates from the checkpoint.
- **Sweep**: a T0 namespace is garbage exactly when its device lock is
  FREE and its lease is stale. Web Locks make this sound: the worker
  holds `pm-device-<id>` for its lifetime; locks release on death.
  bfcache would complicate lock lifetimes, but the page already holds a
  live relay WebSocket and is bfcache-ineligible regardless — the cost
  is pre-paid.
- **Degrade rule**: a restored tab (crash restore, reopen-closed-tab)
  can present a pointer to a legitimately swept namespace. That is a
  fresh device, silently — never an error.
- Chrome 148+ ships `extendedLifetime` (the standard's answer to the
  zero-client window). Re-measure when the pinned browser reaches it;
  it may shrink the checkpoint path to an optimization. (Spike row 4c:
  BLOCKED on Chromium 143.)

## The worker host

One SharedWorker per device (`pm-device-<id>` in the worker URL hash or
name) owns the engine instance, the namespace, and the device lock.
Tabs attach over MessagePort and are views. This is what makes
"multiple devices permitted, one active by default" structural: the
dangerous case (two tabs, one device) becomes two clients of one
engine, and same-browser multi-device is just two workers.

- **RPC envelope**: the driver/tasks/pairing surfaces cross the port as
  structured-clone data. `ComponentException` does not clone; the
  envelope carries `{ok:false, error:{message, witPayload?}}` and the
  client rehydrates a branded error. The envelope is the embedder API —
  design it once, in runtime/, not per page.
- The app frame's op-stream port can later be transferred worker→frame
  directly (#45's shape); not required for v1.
- **Unseal state lives in the worker**: the KEK (or unwrapped DEK) is
  worker memory. "Unsealed while the app is open anywhere" is exactly
  the worker's lifetime — no extra machinery.
- **Fallback**: Chrome-for-Android gained SharedWorker in 148 (Baseline
  2026-05); Samsung Internet and the long tail still lack it. A
  no-worker degraded mode (per-tab engine + Web Locks single-owner) is
  PARKED, not built — recorded so nobody designs it in by accident.
- **Storage egress** — the bucket path from a worker-hosted device,
  which this record's round left refusing — landed in the following
  round and is governed by its own sibling record,
  [STORAGE-EGRESS.md](./STORAGE-EGRESS.md): the store closures live in
  the worker, the binding crosses as sealed device state, the escrow
  stays the page-side keystore.

## Sealing

Two protected classes, deliberately split:

**Bulk state** — keyhive archive, checkpoint blobs, us-doc working
state, visor cache: sealed under a per-device DEK (AES-GCM, random,
never leaves the worker unwrapped). Note the at-rest surface is smaller
than it looks: sedimentree/keyhive envelopes are already ciphertext by
construction; the crown jewel is the keyhive archive (epoch secrets,
membership). The OPFS chunk store holds envelope ciphertext and may
rest unsealed in v1 — sealing it buys little and costs a re-encryption
pass on every chunk; record the choice in the track if it changes.

**Device signing identity** — posture `platform`: non-extractable
WebCrypto handles, structured-cloned into the namespace and re-handed
by id (the wosh-validated pattern: reload-stable, extractability
enforced on load, race-free first mint — identity-store.ts). Never
passphrase-derived: a wrapped seed is offline-guessable at passphrase
strength; a non-extractable handle cannot leave the profile at all.
The `seed` posture (extractable seed inside the sealed bundle — the
engine's existing identity-export format) remains as the
export/recovery format, and as the resting posture only until the
platform-posture engine path lands.

**The KEK ladder** (per-device choice at promotion; governs the DEK
wrap, not the identity key):

| unseal persistence | mechanism | honest strength |
|---|---|---|
| every session | passphrase→KDF (or WebAuthn PRF, later) held in worker memory only | the real tier |
| while open | first unseal parks the KEK in the worker; dies with it | ≈ browser session; closest the platform gets |
| until reseal | KEK wrapped by a non-extractable platform key in the namespace | convenience tier: degrades to profile access control; reseal deletes the wrap |

The UI copy for the last tier says the honest sentence: it is login
convenience, not protection against someone holding your profile.
WebAuthn PRF is the passphrase-free rung and #11's recovery direction;
wosh has the passkey ceremonies (enroll/adopt/assert/recover)
validated, PRF itself is new construction — its own track, not a
blocker.

## Unseal UX

- Boot: index read → picker (generic chrome; device petnames only).
  One device in the index and a policy that permits it: auto-unseal
  straight to the app.
- Unseal success is when the visor becomes yours: colour, name, icon.
- **Device-name display rule** (ruled): the strip shows the device
  petname whenever this browser's index holds MORE THAN ONE device —
  pickable, not merely active. One device: no label, it is noise.
- Reseal: an explicit control (settings sheet); deletes the persisted
  KEK wrap, tells the worker to drop key material, returns to the
  picker.

## Engine contract additions (the engine track owns the details)

- **Resume**: beside `identity-import(bundle)`, a platform-posture
  resume. Shape per webcrypto#391's ruling (the WIT keystore fell:
  store-a-handle is browser-specific, so persistence is an EMBEDDER
  library and the guest-facing function is APP-OWNED WIT): the engine
  world grows its own `device-identity`-shaped import returning an
  optional signing-key; the embedder implements it by loading the
  persisted non-extractable handle from the device namespace (the
  device store's identity library — the wosh pattern) and turning it
  into the port's typed handle via `SigningKey.fromCryptoKey` (the
  merged webcrypto#392 seams — by-value, structured-clone laundered).
  The checkpoint records posture only;
  no key reference travels in engine state.
- **State persistence**: the engine world gains wasi:filesystem
  imports; chunk store / keyhive archive / us state persist into the
  mounted per-device OPFS directory (browser) or real files (wasmtime —
  native parity is the point). The published @polyengine/wasi
  filesystem defaults READ-ONLY; mounts must pass `writable: true`
  (spike finding). Deno has a filesystem binding, so the headless gates
  can run the same path.
- **Checkpoint semantics**: crash-consistent, not write-through-perfect:
  a checkpoint the engine can be restored from after `worker.terminate()`
  at any moment. The acts battery gains a kill-and-resume act.

## Eviction and degradation

- T1 promotion requests `navigator.storage.persist()`; the result is
  surfaced, not assumed.
- Eviction is origin-granular: if the index is gone, everything is.
  The account outlives the device by design (bucket + peers + the
  export bundle); the UI says "this device was evicted", never
  pretends otherwise.
- Private mode: storage refusals degrade to T0-only with a warning
  (wosh's pattern), never an error.
- Safari (ITP 7-day, storage quirks) stays in the parked
  browser-floor note; nothing here designs for it.

## Parked, explicitly

Quota accounting/GC beyond the T0 sweep; cross-device content dedupe;
the no-worker Android-long-tail fallback; `extendedLifetime`
re-measure; the PRF unseal rung; sealing the OPFS chunk store; multi-
account UX beyond the picker.

## Tracks and gates

- **T-A (polymorph-webcrypto)**: DONE as webcrypto#392 (merged;
  superseding this round's #390 draft) — `fromCryptoKey`/`toCryptoKey`
  seams on SigningKey/VerifyingKey/Ikm: by-value crossing with
  structured-clone laundering, token-gated constructors, kind validated
  at the wrap, policy read off the platform key. The IndexedDB
  persistence library moved OUT of the port and into T-C (this repo
  owns it; honestly browser-only).
- **T-B (engine)**: wasi:filesystem persistence + kill-and-resume act
  (landed); platform-posture resume via the app-owned device-identity
  import + the fromCryptoKey seam, once webcrypto's #392 releases.
  Gates: native acts with a restart act, pairing-bringup restart smoke,
  engine clippy.
- **T-C (runtime/device-store)**: index, namespaces, locks, DEK/KEK
  ladder, checkpoint anchor + sweep, the identity-key library
  (persist/load non-extractable handles with validate-on-load — the
  wosh pattern, absorbed here per the #391 pivot), the worker host +
  RPC envelope.
  Gate: a browser-driven test page (spike-style) covering mint/unseal/
  reload/rehydrate/sweep/reseal.
- **T-D (solo page)**: picker, promotion, unseal ceremony,
  device-name strip rule. Gate: e2e.
- **T-E (e2e)**: reload-survival, promote-then-restart, reseal, two-
  device index, swept-pointer degrade. Suite stays green throughout.

## The next-release bump checklist — EXECUTED 2026-08-22

The releases rolled as **0.4.0 across the board**, not the 0.3.x patches
this checklist guessed when it was written: a breaking minor, because
A19 breaks the brand key and webcrypto#392 gates the constructors. Every
item below is recorded as executed, at the versions that actually
shipped.

- **Pins** (done): demo/deno.json and runtime/tests/devstore/deno.json —
  @polyengine runtime/translator/wasi 0.3.1 → **0.4.0**;
  @polymorph webcrypto/websocket 0.3.0 → **0.4.0** (webcrypto carries
  the #392 fromCryptoKey/toCryptoKey seams). The webrtc sibling checkout
  was already on its 0.4.0 main with an internal `^0.4.0`, so the graph
  is one @polyengine/runtime@0.4.0 with no 0.3.x residue.
- **rpc.ts** (done): the error-envelope walk and the hand-rolled brand
  are gone, replaced by the embedder's `toCloneable`/`fromCloneable`.
  Note the amendment split the checklist ran together: **A19** is the
  brand rename (`witError` → `componentException`), **A20** ships the
  forms — with this seam as their named consumer driver. The swap is
  NOT total, and the part that stayed is the point: only the ENGINE's
  errors take the forms. Host-surface conditions keep a typed envelope,
  because the cloneable form's unbranded-`Error` row carries
  name/message/stack/cause and would silently drop `SealError.code` —
  which is what every unseal ceremony branches on. Rows 18 (engine arm +
  host arm contrast), 13, 16, 19 and 20 arbitrate.
- **#147's may_leave tightening** (watched): the full battery ran green
  — devstore matrix, demo check/site/e2e, pairing-bringup,
  resume-bringup, engine check/pair/resume. No new guest trap anywhere,
  as expected for this engine's plain cabi_realloc.
- sealed-fs assumptions unaffected (no wasi/ changes in the window) —
  confirmed by the sealed-fs and host rows staying green.
- The platform-posture slice: **LANDED**, both halves. The engine's
  app-owned `device-identity` import (commit addbca8) and the worker
  host's fragment over it — `loadOrMintIdentity` out of the device
  namespace, laundered through `SigningKey.fromCryptoKey` /
  `VerifyingKey.fromCryptoKey` (the merged webcrypto#392 seams) and
  handed to `newEngine`. The worker now inits `platform` posture, so a
  new device's private key never enters its checkpoint at all; existing
  `seed` checkpoints still resume through the unchanged seed path,
  because the engine forks on the manifest's recorded posture rather
  than on the embedder's current preference. Gate rows 21 (identity
  stable across a kill, confirmed from the restored archive), 22 (a
  rival key in the namespace refused by name, never a silent fresh
  device) and 23 (seed back-compat). `toCryptoKey` — the extraction
  half — is still unused here: nothing needs to hand a device key back
  out yet.
- POLYVISOR-1 (#83): the docs spike's vendored deltic-0.1.0 bundle —
  still its own turn, untouched by this bump.
