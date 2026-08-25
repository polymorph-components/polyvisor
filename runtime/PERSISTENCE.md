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

Pre-unseal chrome is therefore generic, and the visor itself is part of
what "generic" has to cover: it boots UNCLAIMED — the strip and drawer
in a zero-chroma grey dress, the identity cluster empty — so that the
picker can be a visor drawer sheet without any of this becoming
renderable early. The user's colour, name and icon appear at the moment
of unseal, which gives unseal-as-login a real anti-spoofing property: a
page imitating the picker cannot paint your colour. Render nothing
personal until the seal opens.

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
- **Erasure is the one ending where the device dies before the global
  (amended 2026-08-25, #112).** The lease ⇔ lock ⇔ global lifetime
  equivalence breaks at `destroy`: the heartbeat must be STOPPED there,
  or its next `touchLease` recreates the just-deleted database
  (IndexedDB open-on-missing). The general rule that fell out, three
  gates on one oracle: **the index row is the namespace's existence
  oracle, and no path may touch a namespace whose row is absent** — a
  worker constructed for an erased device counts no boot and writes
  nothing (module-evaluation `bootSeq` reads the row first), pre-attach
  `status` and `attach` refuse (an IndexedDB *read* creates the
  database too), and creation order is verified row-first on every
  constructing path so a legitimate first boot still counts. Devstore
  rows 65–66b pin all of it with negative controls.
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
| every session | passphrase→KDF held in worker memory only | the real tier |
| every session | passkey → WebAuthn PRF → HKDF → AES-KW; the derived KEK crosses as a non-extractable handle and is held in worker memory only | the real tier, without the human secret: the credential's secret rests in the authenticator, not the profile, so the wrap at rest is not guessable at any passphrase strength — but the assertion runs in page script, which the trust sentence below owns |
| while open | first unseal parks the KEK in the worker; dies with it | ≈ browser session; closest the platform gets |
| until reseal | KEK wrapped by a non-extractable platform key in the namespace | convenience tier: degrades to profile access control; reseal deletes the wrap |

The UI copy for the last tier says the honest sentence: it is login
convenience, not protection against someone holding your profile.
WebAuthn PRF — the passphrase-free rung — LANDED in the PRF-unseal
round (its own section below; platform facts in
[spikes/prf-unseal/](../spikes/prf-unseal/), the executed matrix).
wosh contributed the validated passkey ceremonies
(enroll/adopt/assert/recover, the transports capture/replay
discipline); the PRF extension itself was this repo's new
construction. It is NOT #11's recovery — the seam is recorded in the
section, not built.

## The PRF rung: passkey unseal

Rulings settled 2026-08-22 (the PRF-unseal round). Platform facts from
[spikes/prf-unseal/](../spikes/prf-unseal/) (executed matrix: the CDP
virtual authenticator serves hmac-secret/PRF; outputs are
deterministic per (credential, input) and separated per input; this
Chromium also evaluates PRF at `create()` time, which other clients
may not; a non-extractable derived KEK structured-clones through
`postMessage`). The wosh ceremonies (`~/p/wosh/site/passkey-store.ts`)
are the validated scaffolding for everything EXCEPT the extension:
resident key required, ES256, transports captured at registration and
replayed in `allowCredentials`, the empty-allow-list discoverable path.

**The shape.** The user enrolls a passkey for the device; unsealing
asserts it with the PRF extension; the output feeds HKDF; the derived
KEK unwraps the DEK by AES-KW exactly as the passphrase rung does.
"Login with your passkey" instead of a passphrase, same honest-strength
story: nothing persisted can open the device — the secret rests in the
authenticator, which demands user presence and verification per
ceremony.

**The wrap record** (`PrfWrap`, `wrap:prf` in the `seal` store, a
sibling of `PassphraseWrap` with the same at-rest posture): version,
a `kdf` tag naming this construction, `credentialId` and `transports`
(the wosh capture/replay discipline — an identifier and routing hints,
not secrets), `rpId`, two fresh-random 32-byte salts (the PRF input
and the HKDF salt), and the AES-KW-wrapped DEK. A reader of the store
learns the device has a passkey rung, which credential opens it, and
40-odd bytes of wrapped key it cannot brute-force: unlike the
passphrase wrap, there is no human-chosen secret to guess at. No
`origin` field — enrollment is always a ceremony a person ran, so a
PRF rung is always a door somebody can walk through (the fact the
reseal-upgrade guard consults).

**The derivation, ruled.** PRF input = the stored 32 random bytes
(`eval.first` only; fresh per wrap). KEK = HKDF-SHA-256(ikm = the
32-byte PRF output, salt = the stored HKDF salt, info = a version
string plus the DEVICE ID) → AES-KW-256, non-extractable,
`wrapKey`/`unwrapKey` only. Binding the device id into `info` means a
wrap record copied between namespaces refuses at the unwrap — a clean
`wrong-passkey` — instead of unwrapping a foreign DEK and surfacing as
GCM tamper noise downstream. `userVerification: "required"` is PINNED
at enrollment and at every unseal: hmac-secret keeps two per-credential
secrets (with and without UV), so an unseal that ran with a different
effective UV state than enrollment could derive a wrong key on a real
authenticator even though the virtual one answers identically (spike
row 6).

**The window/worker split, and the trust sentence.** WebAuthn cannot
run in a worker — `navigator.credentials` is window-only — so the
assertion runs on the PAGE, the page derives the KEK, and what crosses
the port is the NON-EXTRACTABLE KEK handle (CryptoKey structured-clones
across `postMessage` exactly as it does into IndexedDB; spike row 9).
Stated honestly: the raw PRF output transits page JS for the length of
the derivation — the same class of exposure as the passphrase rung,
whose secret is typed into a page input and crosses the port raw. What
the rung removes is the human secret and the wrap's offline
guessability; what it cannot remove is "script running on this origin
at unseal time observes the ceremony". And unlike `until-reseal`,
possession of the profile alone does not open it: the authenticator
demands a fresh presence-plus-verification per assertion, which
origin script cannot fake (test drivers simulate it through CDP, which
is not a thing a page can reach).

**Enrollment placement.** Two doors, one worker ceremony behind both:

- **At promotion** — a third unseal-policy choice beside the two
  shipped rungs, offered only when the capability probe says the
  browser can do it. The worker half is `rekeyFromPlatform`'s precedent
  verbatim: the re-wrap is authorized by the platform rung a T0 device
  always has at promotion time, and after the PrfWrap lands the
  platform wrap is DELETED — a user who asked to be asked must not
  leave a silent door standing (the `every-session` arm's reasoning,
  unchanged). `sealT0`'s generated passphrase wrap stays behind: a door
  with no key costs nothing, and deleting it would change
  `already-sealed` semantics for nothing.
- **On a kept device** ("switch this device to passkey unseal", in the
  this-device sheet): same worker ceremony, authorized by the platform
  wrap when the device has one, else by the passphrase (which the
  sheet asks for — it is the device's login anyway). The policy tag
  flips to `passkey`; a user-origin passphrase rung STAYS as the
  explicit fallback (rungs are additive — the `enableUntilReseal`
  precedent).

**Enrollment order and the degrade.** Capability first:
`PublicKeyCredential.getClientCapabilities()` answering
`"extension:prf"` (spike row 1); a browser without the method is a
MAYBE — offer, and verify at enrollment. The ceremony writes NOTHING
until `prf.enabled` is true and an output is in hand (create-time eval
where the client returns it, else one follow-up assertion naming the
fresh credential). A refusal leaves the device exactly as it was and
says so plainly; the one irreversible residue is the credential the
authenticator may have minted, which only its owner can delete there
(wosh's `forget` note), and the copy says that too. No PRF support at
all → the choice is simply not offered, with a plain sentence, never a
broken ceremony.

**Unseal.** The picker renders a "use your passkey" button for a
`passkey`-policy device (a user gesture, which some browsers demand
for `credentials.get` anyway). The page reads the wrap record — the
`seal` store rests unsealed by design, and the salts/credential id are
exactly the exposure the record's contract already prices in — asserts
naming the credential and its transports, derives, and hands the
worker the KEK handle. The worker unwraps; a wrong KEK is a typed
`wrong-passkey` refusal (AES-KW's integrity check — no partial key
ever exists, same as a wrong passphrase). A device that also carries a
user-origin passphrase rung gets a "use your passphrase instead" path
on the same screen: the policy tag names the ceremony to OFFER, not
the only door.

**Reseal.** Deletes the platform wrap and its key handle, as ever. The
PRF wrap SURVIVES reseal — an assertion per unseal is the rung's whole
point, so there is nothing persisted that opens the device alone. The
reseal-upgrade guard generalizes: reseal proceeds without ceremony
when ANY reachable rung remains (`userPassphrase` OR `prf`); the
upgrade question is only asked when the platform wrap is the last door
anybody can walk through.

**RP-id scoping, said plainly.** `rpId` is `location.hostname` at
enrollment and is recorded in the wrap. The namespace is origin-scoped
IndexedDB, so the record can never be presented from another origin —
the recorded value is a tripwire and a diagnostic, not a live degree
of freedom. Consequence for the demos: a device on `localhost` (dev,
e2e, the matrix) and a device on the Pages origin are different RPs
with different credentials, which widens nothing — a device is already
per-browser and per-origin by construction. The Pages origin is a
`github.io` subdomain, which is on the public-suffix list: the RP ID
cannot be widened to `github.io`, so no other Pages site can assert
the demo's credentials.

**What recovery means here, versus #11: the seam, recorded and not
built.** Passkey sync (platform credential managers) makes the
CREDENTIAL portable across a user's machines — but this rung's wrap
never leaves the device namespace, and devices never sync as bytes, so
the rung is NOT cross-device recovery and does not pretend to be. The
recorded direction for #11: an account-level recovery bundle (the
identity export format) resting in bucket storage, wrapped under a key
derived from the SAME credential with a domain-separated second input
— the PRF extension evaluates two inputs in one ceremony (spike row
7), which is also the future re-wrap/rotation seam. Nothing else about
it is designed here.

## Unseal UX

- Boot: index read → picker. The picker is a VISOR DRAWER SHEET in the
  UNCLAIMED dress: generic grey (no anchor colour has been read, let
  alone painted), an empty identity cluster, and index content only —
  device petnames and times. It is in the drawer rather than in page
  flow because the drawer's mechanics are the part a page-flow card
  could not offer: the sheet hangs off the pinned strip and the page is
  dimmed around it, neither of which a component confined to its own
  rectangle can reproduce. So the surface where the passphrase is typed
  is spatially distinguishable from anything an app can draw, even
  before there is a colour to compare.
  One device in the index and a policy that permits it: auto-unseal
  straight to the app, with no sheet at all (a picker that flickered
  open and shut for the fraction of a second an unseal takes would teach
  the user that visor motion is noise). A failed auto-unseal mounts the
  picker carrying the refusal.
- A `passkey`-policy device never auto-unseals: the picker offers the
  passkey button (and the passphrase fallback when a user-origin rung
  exists). The ceremony is one authenticator prompt.
- Unseal success is when the visor becomes yours: colour, name, icon.
  All three arrive together, at the claim.
- After the seal opens, an account-less device gets the same treatment:
  the fork ("new account" / "join another device") and the join
  ceremony's code + SAS are drawer sheets too. Identity, account and
  ceremony UI appears only in visor territory, without exception —
  that is the one boundary a user can be taught once.
- **Device-name display rule** (ruled): the strip shows the device
  petname whenever this browser's index holds MORE THAN ONE device —
  pickable, not merely active. One device: no label, it is noise.
- Reseal: an explicit control (settings sheet); deletes the persisted
  KEK wrap, tells the worker to drop key material, returns to the
  picker. **It saves first, and it may refuse — AMENDED 2026-08-23.**
  Sealing drops the engine, so a mutation inside the 500 ms debounce
  window had a checkpoint armed that would never fire: every seal
  silently discarded up to half a second of work. Reseal now clears that
  timer and takes a FINAL CHECKPOINT before dropping anything, and a
  failed checkpoint REFUSES the ceremony with the device left open —
  the erase ceremony's fallible-half-first discipline, and the sibling
  of `destroy`'s drain of the checkpoint chain. What raised the stakes
  was #93: the lost window used to cost a keystroke, and now costs the
  doc's name-key chain, which a respawned engine re-mints into a
  complete duplicate of the store. An open device with an untouched
  engine reseals cleanly — a checkpoint of an unmutated engine is an
  ordinary generation, not an error — and an already-sealed device has
  no engine to checkpoint.

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
- **Bucket state joins the checkpoint — AMENDED 2026-08-23 (#93)**. The
  original note in `persist.rs` classified `store` AND `buckets` together
  as "embedder-supplied addressing, re-applied by the embedder". Half
  right, and the elision was the bug:
  - **ADDRESSING stays the embedder's.** `init-store`'s config — the
    endpoint/bucket/root/apiBase and the public access-key identifier —
    is never checkpointed and is re-applied at every bring-up. The
    worker host already does exactly that from the sealed `StoreBinding`
    (STORAGE-EGRESS.md).
  - **STATE joins the checkpoint.** `State.buckets` — per-doc name-key
    chains, the flushed-chunk dedup map, manifest entries, grantees, the
    Dropbox pickup/container links — is GENERATED INSIDE the engine and
    cannot be re-supplied by anyone. It rides the same sealed state root
    as a new generation member (`buckets.bin`, digested in the manifest
    like every other), because `name_keys` is secret material comparable
    in kind to the keyhive archive already there.
  - **What it cost while it was missing**: a respawn re-minted the
    keychain, so every derived object name changed and the next flush
    wrote a complete duplicate store (on Drive the doc FOLDER is keyed
    too, so the duplicate was a whole second folder); a lost `flushed`
    map re-uploaded every chunk even at stable names; and losing
    `pickup_links` made `store_revoke` take its unknown-grantee path —
    a silent revocation gap on Dropbox. On the deployed page a reload is
    a respawn.
  - **Back-compat is absence-tolerated, and it is the ordinary path.**
    A checkpoint that lists no `buckets.bin` restores no bucket state and
    is never an error — the device resumes exactly as it did pre-fix and
    mints a fresh keychain on next use. `checkpoint` skips the member
    entirely when the map is empty, so every device that never touched a
    bucket keeps writing pre-#93-shaped generations, and the absence path
    is exercised by every act and row that checkpoints without a store.

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
re-measure; sealing the OPFS chunk store; multi-
account UX beyond the picker. From the PRF rung: removing a passkey
rung (needs the same never-delete-the-last-reachable-rung guard reseal
has), multiple credentials per device, PRF-input rotation via the
dual-eval seam, conditional mediation in the picker, and #11's
recovery-bundle direction (the seam is recorded in the rung's
section).

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
- **T-F (PRF rung, this round)**: seal.ts's `PrfWrap` + ceremonies,
  the worker/RPC crossing (the KEK handle), the page-side passkey
  module (window-only, the wosh ceremonies + the PRF extension), the
  solo page's third promotion choice + picker button + switch-to-
  passkey. Gates: the devstore matrix's PRF rows driven through the
  CDP virtual authenticator (spikes/prf-unseal is the feasibility
  record), demo `just check`/`just site`, e2e green with a solo
  passkey scenario.

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

### Addendum — 0.4.0 → 0.5.1, EXECUTED 2026-08-23

A second bump followed within the day, and it was a BUG FIX first and a
version-tracking exercise second.

- **Why**: polyengine#239 (af97c13, in v0.5.1). 0.4.0's `driveAsync` took
  its speculative pending-resumption entry UNCONDITIONALLY
  (0.4.0 `src/exec/boundary.ts:1064`), and that entry is a **store-wide**
  scheduling gate: `Store.tick` refuses while it is non-empty, and every
  `driveAsync` hops at its top under a 10,000-hop bound. Two of this
  device's OWN periodic drivers collide there. The worker's 500 ms
  debounced, **non-blocking** state-checkpoint (worker.ts's "Ordinary
  driver/tasks calls are NOT blocked behind a checkpoint" — a recorded
  design decision, not an accident) is near-always in flight; the solo
  page's 1 s `us-events` drain (demo/host/solo.ts) arrives into it and can
  only hop. Ten thousand hops later the internal-bug assert fires with the
  user-facing text `driveAsync: a resumed-activation claim was never
  released`. The fix guards exactly that line: the entry is taken only by
  the sole driver, plus a driver-arrival one-shot that wakes the incumbent
  promptly.
- **What it is NOT**, because the first diagnosis got this wrong and the
  retraction is worth keeping legible: there is **no latency threshold**
  and no egress involved — the storm reproduces with the harness
  answering instantly. There is **no Gecko differential**; a nine-case
  JSPI ordering probe found SpiderMonkey ≡ V8. It was field-reported from
  mobile Firefox only because slow OPFS widens the window between the two
  drivers. The fix is upstream, not a polyvisor-side serialization, which
  would have contradicted the non-blocking-checkpoint decision above.
- **The gate**: devstore **row 47b** — 12 s of back-to-back
  `state-checkpoint` and `us-events` calls on one store. RED on stock
  0.4.0 (21 checkpoints, **1** drain, then the trap); GREEN on 0.5.1 (107
  checkpoints, **108** drains, no trap). The drain count is the
  interesting half: it measures the starvation directly, and its recovery
  is what validates the shipped fix's driver-arrival wake rather than
  merely the removal of the entry.
- **Pins** (done): demo/deno.json and runtime/tests/devstore/deno.json —
  @polyengine runtime/wasi/translator 0.4.0 → **0.5.1**; @polymorph
  webcrypto/websocket 0.4.0 → **0.5.0**; plus a NEW
  **@polyengine/protocol@0.2.3** pin, which A22 makes necessary.
- **A22 is the breaking part** (polyengine 1e31210): `@polyengine/runtime
  /embedder` is application-only now — the A9 courtesy re-exports and the
  concrete handle classes are gone. `ComponentException`,
  `isComponentException`, `isTrap`, `toCloneable`, `fromCloneable` and
  `suspending` all moved to `@polyengine/protocol`. Eleven modules changed
  their import line and nothing else: pairing-engine, stubs, keystore,
  store-egress, device-store/{worker,client}, tests/devstore/page,
  demo/host/{demo,bringup,probe-net}, spikes/worker-host/worker.
  `instantiate`/`artifactsFromEnvelope` stayed in the embedder — that is
  A22's dividing line, and engine.ts and solo.ts were untouched.
  Consequently the ports no longer constrain our runtime version at all:
  webcrypto and websocket 0.5.0 name no `@polyengine/runtime` specifier
  anywhere.
- **wasi/fs** (watched, no change needed): f07a3b9 made directory-mutating
  ops require the `mutate-directory` flag specifically, refusing read-only
  with the WIT-mandated code. Every preopen this repo builds passes
  `writable: true`, which the provider turns into
  read+write+mutate-directory on the preopened descriptor
  (`fs_provider.ts`'s `PREOPEN_FLAGS`), so the sealed-fs wrapper and the
  engine's state root are unaffected — sealed-fs row 7 and the resume
  batteries confirm. Note this DOES invalidate the previous bump's "no
  wasi/ changes in the window" line; there were changes, they just landed
  on the permissive side of our usage.
- **The webrtc sibling checkout must now be at its v0.5.0**, and this is a
  hard prerequisite rather than hygiene: at 0.4.0 the sibling's own
  `polyengine-impl/deno.json` declares `@polyengine/runtime@^0.4.0`, and
  Deno **does** consult it for our relative import — `deno info` showed a
  second `@polyengine/runtime@0.4.0` beside our 0.5.1. Moving to the JSR
  copy instead is still blocked by the same `deno bundle --external`
  hazard the last bump recorded, re-measured here (the `node:` tripwire
  fires). At v0.5.0 the sibling is A22-clean — no runtime specifier at all
  — so one runtime serves the graph and lazy bundling is retained.
- **Harness findings folded in**: `demo/e2e/run.ts`'s FIREFOX_PREFS gains
  `"permissions.default.persistent-storage": 1` (headless Playwright
  Firefox never settles `navigator.storage.persist()` without it, wedging
  every kept-device ceremony), and the engine-selection machinery carries
  the measured Juggler hazard — calling a `WebAssembly.promising` export
  from inside a `page.evaluate` frame SIGSEGVs the Firefox content
  process, so Firefox-lane scenarios must drive through page
  scripts/hooks.
