# Google Drive: the user-only store

The design record for the round after
[STORAGE-EGRESS.md](./STORAGE-EGRESS.md): the engine's third provider
strategy, the worker host's second bindable one, and the first with NO
SHARING TIER by design. It is also the round that BUILDS the OAuth shape
the egress record parked as v2 — the worker-run token exchange — because
Drive is bearer-based and a bearer must never exist in page memory or
cross the RPC port. Rulings settled 2026-08-22; authorities: issue #7
(authority in the instance), the egress record's §§2/5/6 (what may cross
the port, the bearer ban, the escrow tiers), providers/dropbox/store
(the strategy template), engine.wit's storage section. Where this
document and reality disagree, report the friction, do not edit around
it.

## The shape in one paragraph

`gdrive` is a guest provider crate statically linked into the engine
composite (a `store-config` arm and six match sites; no wac change),
modeled on Dropbox's folder-shaped strategy with the entire link
machinery removed and S3's name-keyed object naming in place of
Dropbox's plain paths: every call runs Route::Owner, and the grant an
embedder derives for it is owner = the API origin, public = ∅,
shared = ∅ — the unused tiers are EMPTY, refusing by construction. The
OAuth ceremony splits across the port along capability lines: the PAGE
owns the popup (a window is a page capability; the consent renders in
provider pixels), the WORKER owns the verifier, the exchange, and the
tokens — which are born in worker memory, rest DEK-sealed in the device
namespace, and are refreshed behind the owner seam with the new token
re-sealed. The solo page's storage sheet grows a provider choice; the
demo page deliberately does not (its storage theatre is the sharing
story, and this provider's point is that there is none).

## Rulings

### 1. User-only means no capability is ever minted — not a checked flag

- The strategy mints NOTHING a non-credentialed party could use: no
  shared links, no anonymous reads, no app-auth tier. The only readers
  of the store are holders of the user's own OAuth. "No sharing" is
  therefore structural, in exactly #7's sense: `store-public-fetch` and
  `store-shared-fetch` are wired over empty origin sets, and the guest's
  gdrive paths never call them.
- `store-grant(doc, member)` still writes the member's pickup object at
  a derivable path — the pull layer's key bootstrap, which the
  ACCOUNT'S OWN DEVICES need (each device is its own agent with its own
  prekeys) — and returns NONE: there is no link to carry because there
  is nothing a link could grant. (Recorded fact, UPDATED once names
  became keyed (§2): this record WAS write-only, because the owner-tier
  pull derived its device set from the doc folder's own listing. Keyed
  names make that listing unparseable, so the pickup is now the only
  bootstrap — it carries the name-key keychain and the device set, the
  same pair S3's K_p carries, and the pull cannot start without it. The
  clause that predicted this — "it becomes load-bearing the moment a
  pull path exists that cannot list the folder" — came due by way of a
  pull that can list the folder and learn nothing from it. Note the
  keychain is a SECRET but still not a CAPABILITY: knowing a name lets
  you derive where an object sits, never read it, because every read on
  this provider goes through the owner seam's OAuth.)
- `store-revoke` deletes the pickup and returns the honest note: this
  store never minted a capability, so there is nothing server-side to
  revoke; a party holding the user's own Drive credential is outside
  this store's reach, and credential rotation at Google is the real
  lever. It does NOT rotate the name-key epoch, and the difference from
  S3 — whose revoke does — is deliberate: on S3, names ARE the read tier
  (the bucket serves unsigned public GETs, so a name is sufficient
  authority), and a fresh epoch is the hard forward boundary that stops
  a revoked holder of the old key from reading new writes. Here there is
  no anonymous tier at all, so a name is authority for nothing and
  rotating it would be ceremony with no boundary behind it. The reading
  side still walks a keychain newest-first exactly as S3's does, so a
  future revision that grows a reason to rotate needs only the trigger.
  (A consequence that follows from grant-returns-none and is
  accepted: the engine's pickup-link table stays empty on this provider,
  so revoking a member who was never granted deletes nothing and
  succeeds quietly. A louder refusal would need a grantee list the
  provider deliberately does not keep.)
- `bucket-pull` is owner-tier only. A call carrying a `pickup` link is
  refused by name — a link-tier pull is not a thing this provider has.

### 2. The strategy: Dropbox's shape over an id-addressed API

- Scope is `drive.file` in the VISIBLE space — files created by this app
  only — and `drive.appdata` in the hidden one, which is narrower still
  and is the default (§5b). `drive.file` is the minimal honest scope for
  a folder a user can see, and it carries a fact worth stating twice: the
  confinement is PER CLIENT ID, so every device of an account must use
  the SAME client id or they cannot see each other's store. The client
  id is part of the store's identity, beside the root folder name.
- Drive is id-addressed and names are not unique. The strategy resolves
  name→id with `files.list` queries scoped to a parent folder, caches
  folder ids in instance memory, and never creates duplicates itself
  (upload is list-then-create-or-update: multipart create when absent,
  media PATCH when present).
- Layout mirrors Dropbox's SHAPE with S3's NAMES: root folder (the
  binding's `root`) → a `docs` folder holding one folder per document,
  and a flat `pickup` folder holding per-member bootstrap objects. Doc
  folder names and their children's names are KEYED — `hex(HMAC(
  name-key, kind ‖ id))`, the S3 provider's construction verbatim — so
  the fixed words `docs` and `pickup` are the only labels an observer
  reads. The doc folder is keyed under the doc's FOUNDING name-key
  (epoch 0) rather than the current one, because a Drive folder is a
  container and a container that renamed itself on an epoch boundary
  would strand everything inside it; the objects within stay per-epoch
  exactly as S3's are.
- The reason names are keyed here rather than left plain like Dropbox's:
  contents are keyhive ciphertext already, so names were the remaining
  disclosure, and doc ids have the two properties that hurt. They are
  GLOBAL — the same shared document carries the same id in every
  member's store, so anyone who can list two accounts learns from the
  names alone that those accounts share a document — and STABLE, so
  activity on one document is trackable indefinitely. This provider's
  threat surface is metadata-only by construction (`drive.file` plus
  ciphertext), which is exactly why the metadata was worth spending a
  derivation on.
- THE PICKUP OBJECT IS THE ONE UNKEYED LOCATION, and the exception is
  what makes the rest possible: it is where a member LEARNS the
  keychain, so a member who does not hold the keychain yet must still be
  able to find it. Its name mirrors S3's `kp_location` —
  `hex(SHA-256("kp" ‖ doc ‖ owner ‖ member))` — and it sits FLAT under
  `pickup`, with no per-doc subfolder, because any unkeyed per-doc
  folder name (the doc id plain, or hashed) would be a global, stable
  per-document label in every member's store: the precise disclosure the
  keying removes. What it costs is S3's cost, unchanged: a party who
  already knows the whole (doc, owner, member) triple can confirm the
  object exists. Existence privacy wants a pairwise-secret location and
  is the same #19/#10 item for both providers.
- CONSEQUENCE FOR THE PULL, recorded because it moved a load-bearing
  part: the owner-tier pull used to derive its device set by parsing
  `oplog-<hex>` off the doc folder's own listing. Keyed names make that
  listing opaque, so the device set and the keychain now arrive inside
  the sealed pickup object, exactly as S3's K_p delivers them. The
  bootstrap record described in §1 is therefore no longer write-only.
- `gdrive-config` is `{ root, api-base, space }` — ADDRESSING ONLY, like
  every other arm (`space` is §5b's, and the guest refuses an unknown
  value by name). `api-base` defaults to `https://www.googleapis.com` and
  exists for the same reason S3's endpoint is config: a self-hosted (or
  fake) backend is ordinary addressing, not a probe hack. The client id
  is NOT guest config — auth is entirely the seam's, and the guest has
  no use for an app identity it must never wield itself.

### 3. The worker runs the OAuth; the page runs the popup

The v2 shape from the egress record's §5, now built:

- `oauthStart(spec)` (host RPC): the worker mints the PKCE verifier,
  challenge and state — held in worker memory, one pending ceremony at a
  time — and returns the authorization URL. The page opens the popup on
  it; the popup lands back on the page URL with `?code&state`, and the
  page relays both to `oauthComplete(code, state)`.
- THE CODE MAY CROSS THE PORT, and the ruling says why: it is a
  one-shot artifact, bound to a verifier that never left the worker,
  consumed within the ceremony. It is not a standing credential; the
  bearer ban is about standing credentials.
- `oauthComplete` verifies the state, exchanges code + verifier
  (+ client id/secret) at the token endpoint — the WORKER's own fetch —
  and seals `{access, refresh, clientId, clientSecret}` into the
  namespace. Binding remains `bindStore`'s job; consent and commitment
  stay two acts.
- CLIENT ID/SECRET CLASSIFICATION: installed-app identifiers. Google's
  own documentation says an installed app's client secret is "not
  treated as a secret"; the pair identifies the APP, gates nothing
  without the user's consent, and is the same class as the Dropbox
  appKey/appSecret the demo's grant already carries in page memory. It
  may cross the port as data and rest sealed beside the tokens.
- THE TEST PAIR IS PICKED UP, NEVER SHIPPED: rclone's published desktop
  client (id `202264815644.apps.googleusercontent.com`; secret published
  in their source under their own reversible obscure scheme — AES-CTR
  under a fixed committed key, which `rclone reveal` emits) is the
  candidate. PROBED LIVE 2026-08-23 AND ALIVE, by a method worth
  recording because the pair is expected to lapse: the token endpoint
  answers `invalid_grant` (400) for this pair with a deliberately bogus
  code — meaning the client authenticated and only the code failed —
  against `invalid_client` (401) for a wrong secret or an unknown id,
  which is the control that makes the probe non-vacuous. The authorize
  endpoint separately renders a sign-in page rather than an error,
  which is where Google validates the REDIRECT URI: a loopback URI WITH
  A PATH (`http://127.0.0.1:8600/solo.html`) is accepted for a desktop
  client. Neither probe can say whether consent completes and issues
  tokens — that needs a real account and is the operator's live beat.
  rclone's own docs say the shared id is being retired DURING 2026, so
  it is expiring rather than stable; re-run the probe before trusting
  it.
- WHEN IT LAPSES, MINT ONE — do not hunt for another published pair.
  `googleworkspace/cli` (`gws`) was examined for one and deliberately
  ships none (its `oauth_config.rs` hits are a format doc-comment and
  test fixtures): its model is bring-your-own, and `gws auth setup`
  automates exactly the console ceremony this fallback needs — it
  creates a Cloud project, mints a Desktop-app OAuth client and enables
  APIs, leaving the pair in `~/.config/gws/client_secret.json`. Either
  path lands in the same two sheet fields. Testing-mode clients carry
  three operator obligations that are not our bugs: add yourself as a
  test user (else "Access blocked"), enable the Drive API on the
  project (else `accessNotConfigured` 403s), and click through
  "Google hasn't verified this app". If a Desktop client ever refuses
  our redirect, a Web-application client with the page URL registered
  verbatim is the shape to use.
- Nothing is baked into source, bundles, or defaults; the fields are
  typed (or URL-param prefilled — `gdclient`/`gdsecret`/`gdroot`) at
  test time. Baking the borrowed pair in was considered and dropped in
  favour of the params, which already existed and cost nothing.
- THE LIVE BEAT IS LOCAL, NECESSARILY — measured 2026-08-23, not
  assumed. A desktop-type client accepts LOOPBACK redirects only: the
  authorize endpoint renders a sign-in page for
  `http://127.0.0.1:8600/solo.html` and answers `redirect_uri_mismatch`
  for the deployed Pages URL, with the same client id. So the borrowed
  pair cannot drive the ceremony from the public site by any delivery
  mechanism, and the two errands are separate: the Pages deploy ships
  the page, the Drive beat happens at a loopback origin. The deployed
  site needs a WEB-application client registered with its exact URL —
  which is the same client that replaces the borrowed one, so the
  replacement and the public Drive path arrive together.

### 4. Tokens rest sealed, device-scoped; refresh writes back

- The sealed oauth row is DEVICE-scoped — deliberately unlike the SigV4
  escrow, which is origin-shared. There is no platform handle for a
  bearer, so the DEK seal is the best rest available (honest tier: as
  strong as the device's rung, weaker than the SigV4 handle, which
  never exists as bytes after escrow). Sharing a bearer across devices
  would be credential sharing between agents; each device runs its own
  consent ceremony instead. Multi-device = same client id + same root,
  separate consents.
- The owner seam's 401→refresh→retry (the Dropbox shape, generalized
  per provider: Google's exchange includes the client secret) refreshes
  behind the seam; the refreshed access token — and a rotated refresh
  token, when Google issues one — is RE-SEALED through the grant
  callback, so a worker respawn resumes on the newest tokens.
- Reseal: the in-memory bearer drops with the grant and the DEK
  (`clearGrant`, the existing mechanism); the sealed row rests sealed
  and returns at unseal, when `bringUpEngine` re-arms the grant and
  re-applies `initStore`.
- `unbindStore` keeps the oauth row, exactly as it keeps the SigV4
  escrow: forgetting the destination is not forgetting the account. A
  separate FORGET ceremony (`forgetOauth`) deletes the row and
  best-effort revokes the token at Google — the honest disconnect, and
  the only place revocation belongs.

### 5. The binding's gdrive arm

- `StoreBinding` gains `{kind:"gdrive", root, apiBase, clientId}` —
  addressing plus app identifiers, still nothing user-secret.
- `bindStore` refuses: sealed (`no-rung`); empty root/clientId or an
  unusable apiBase (`bad-destination`); no sealed consent, or a sealed
  consent whose clientId differs from the binding's (`no-credential` —
  the access-key-mismatch rule's exact analog: fail at bind, never as a
  provider 403 later).
- Grant derivation stays derived-never-accepted: owner =
  {origin(apiBase)}, public = shared = ∅, signer = the refusing one (no
  SigV4 on this provider).
- `DeviceStatus` reports the binding as it does S3's, and grows
  `gdriveConsent: {space} | null` — null while sealed or absent, so the
  sheet can offer bind-without-ceremony when a consent already rests
  sealed. IT IS A NULLABLE RECORD RATHER THAN A BOOLEAN, mirroring
  `storage: StoreBinding | null` beside it and for the same reason: a
  boolean plus a separate space field is two facts that can disagree,
  and one of them would eventually be read without the other. The space
  is addressing, not a secret; nothing else derived from the sealed row
  ever appears here.

#### 5b. BOTH SPACES, AND THE USER CHOOSES (settled 2026-08-23)

- The binding's gdrive arm carries `space: "appdata" | "drive"`, and the
  guest's `gdrive-config` carries the same string, which it validates and
  refuses by name. It is ADDRESSING, like `root` and `apiBase`: it picks
  the root folder's parent (`appDataFolder` vs `root`) and adds
  `spaces=appDataFolder` to list queries, and everything below the root
  folder — the `docs`/`pickup` layout, the keyed names, the pickup
  construction — is identical between the two. This is a location
  choice, not a second strategy.
- **APPDATA IS THE DEFAULT**, and the reasons are the ones a user cannot
  give themselves: the hidden per-app space CANNOT BE SHARED at all, so
  §1's "no sharing" becomes platform-enforced rather than a property this
  strategy promises about itself; the Drive UI offers no rename or move
  for those files, which matters here more than usual, because a store
  addressed by KEYED NAME (§2) cannot find a file a user renamed — the
  visible-folder version of that mistake strands data permanently; and it
  keeps a folder of meaningless hex out of the user's own Drive, which is
  the thing they would otherwise have to look at forever. Drive's
  settings still offer the one bulk lever that matters — remove all of
  this app's hidden data — so "hidden" is not "unremovable".
- **VISIBLE STAYS ON OFFER**, and not as a courtesy. Appdata cannot be
  INSPECTED by its own owner: there is no way to look at it, count it, or
  confirm with your own eyes that the thing you were told is happening is
  happening. It is also orphaned INVISIBLY by an app/client rotation — a
  new client id sees an empty app-data space and the old one's contents
  are unreachable AND unseeable, where the same rotation over a visible
  folder leaves a folder the user can still find. And the manual live
  beat against real Google (see Gates) is only checkable by eye in a
  visible folder. Inspectability is a real property; the ruling is that
  it is not the DEFAULT one.
- **THE SPACE IS COUPLED TO THE CONSENT, so it rides on `OauthStartSpec`
  too.** The space selects the SCOPE: `appdata` asks for
  `drive.appdata`, `drive` asks for `drive.file`. Those are two
  different permissions on two different consent screens, so choosing a
  space is a consent-time decision and not merely a bind-time one — and
  the narrowing is a benefit in its own right, since `drive.appdata`
  cannot reach anything in the user's Drive at all, not even files this
  app made there. `bindStore` therefore refuses a binding whose space
  differs from the sealed consent's with `no-credential`, the client-id
  mismatch's exact analog (§5): the consent granted was for a different
  permission, so this browser cannot act for that destination, and the
  message tells the user to run the consent again. The sheet's
  bind-without-ceremony skip is space-aware for the same reason —
  it reuses a sealed consent only when the space matches, and otherwise
  runs the ceremony and says why.
- **AN API FINDING FROM THE STRATEGY SIDE, recorded because it decides
  the failure mode**: a `files.list` that OMITS `spaces=appDataFolder`
  does not error — it returns an EMPTY LIST. On a list-then-create
  strategy that reads as "absent", so the store does not fail loudly; it
  FORKS, re-creating everything under a second root and diverging from
  the one that already exists. The fake reproduces this exactly (an
  empty list, never an error), which is what makes the space rows
  non-vacuous.

### 6. v1 surface: the solo page only

The solo sheet grows a provider choice (S3-compatible | Google Drive);
the Drive form is chrome-owned fields — the space choice (§5b; hidden
app data DEFAULT, visible folder the alternative, both described in the
visor's own words including what each one costs, plus the one line that
changing it later asks for a new consent because it is a different
permission), root folder, client id, client secret (masked; it is an app
identifier, but it is also not something to paint on a screen) — a Connect ceremony that runs consent → bind →
activation beats, and the same sync/change/disconnect controls. The solo
boot grows the popup-relay branch the demo page already has. The demo
page does NOT grow a Drive panel: its storage theatre exists to show the
sharing tiers, and a no-sharing provider adds nothing it can show.
Recorded, not forgotten.

## Gates

- **Engine**: clippy + wasm build + compose + translate; a new headless
  bringup phase `gdrive` — the full owner beat (initStore → ensureBucket
  → grant self → flush) plus a cold second engine pulling from the
  bucket alone, against an in-process fake Drive. The cold pull is also
  what proves the keyed naming did not cost findability: a second device
  reconstructs the whole document from a store whose every name it can
  only derive, never read. Existing `solo`, `resume`, `pair` batteries
  unchanged.
- **The fake** (demo/host/fake-drive.ts, one module for bringup, the
  devstore harness and e2e): minimal files API (`files.list` with the
  q-subset the strategy emits, multipart create, media update,
  `alt=media` get, folder metadata) plus the OAuth half — `/auth` 302s
  straight back with a synthetic code (headless consent), `/token`
  verifies the PKCE verifier against the challenge it saw (OUR PKCE is
  what it gates), issues synthetic labeled tokens, supports refresh
  with rotation and on-demand expiry.
- **Devstore rows**: ceremony tokens sealed and never in `status()`;
  bind refusals by code (no consent; client-id mismatch; SPACE mismatch
  — a consent for one space cannot bind the other); an appdata bind
  landing its objects in the HIDDEN space and nowhere in the visible one
  (the isolation property proven through the worker, not only in
  bringup); `status().gdriveConsent` naming the space it was granted for
  and reporting null while sealed; bind + flush
  with Bearer egress observed; kill/`__die` + re-unseal with no
  re-ceremony (binding AND tokens survive sealed; initStore re-applied);
  401→refresh→retry with the re-sealed token surviving a second kill;
  reseal/unseal; unbind keeps consent, forget deletes it (+revoke
  observed at the fake); and the naming regression row — after a flush,
  the structure still resolves (`docs`/`pickup`, a doc folder with
  objects in it) while the doc id's hex appears in NO stored name
  anywhere in the fake's tree, folders included.
- **e2e** `solo-gdrive`: the full ceremony headless through the real
  popup path (the fake's `/auth` redirect), tokens appearing NOWHERE in
  page storage, objects landing in the fake's store, reload → sync with
  nothing re-entered, reseal seals it, forget revokes.
- Existing batteries stay green throughout: devstore matrix, e2e suite,
  invariants (nothing widens), pairing-bringup, resume-bringup, S3 acts.
- **The live beat is manual and the operator's**: serve locally, solo →
  storage → Google Drive, the picked-up pair (or a minted one — see §3
  for both paths and the freshness probe), real consent, real flush;
  verify in drive.google.com that the app's folder exists and holds
  ciphertext objects. Documented here, not automated — a real Google
  account cannot and should not sit in CI.

## The public-deploy constraint (measured 2026-08-23)

The §3 classification — client id and secret as installed-app
identifiers, public by nature — is Google's own, and it holds for
DESKTOP clients. It does NOT transfer to the deployed site, and the
difference is structural rather than a policy nuance:

- A desktop client accepts LOOPBACK redirects only (probed: sign-in page
  for `http://127.0.0.1:8600/solo.html`, `redirect_uri_mismatch` for the
  Pages URL under the same client id). So the honest-secret client type
  is exactly the one that cannot serve a public page.
- A public page therefore needs a WEB-APPLICATION client, whose secret
  Google DOES treat as confidential — and the token endpoint demands it:
  probed, an authorization-code exchange with PKCE and no
  `client_secret` is refused outright (`invalid_request:
  client_secret is missing`). There is no secretless browser flow to
  fall back to.

The consequence, stated rather than discovered later: a browser-hosted
Drive client cannot keep a confidential client secret, so the provider
is honest at a loopback origin and, on a public origin, only in one of
two postures — a TESTING-MODE app, where the test-user list is the real
gate and the secret gates nothing beyond it, or behind a
token-exchange broker that holds the secret, which this project does
not have and which would put a server in the middle of a design whose
whole point is that there isn't one. v1 ships the loopback posture and
records the rest; a public Drive beat runs testing-mode with the
operator as the only test user.

This is a fact about GOOGLE'S OAUTH, not about the worker-run ceremony:
the worker still owns the verifier and the tokens, and the secret it
holds is the app's identity, never the user's. What changes on a public
origin is only how much that app identity is worth protecting.

### The ruling: BRING YOUR OWN CLIENT

The shipping posture for a served page is the user's OWN
web-application client, minted by them and typed into the sheet — which
is what the sheet already asks for, so this is a ruling rather than a
feature. It is the SAME BARGAIN THE S3 PROVIDER MAKES and should be read
beside it: bring your own bucket, bring your own keys, the visor escrows
them. The Google secret then protects the user's own app identity, sits
in the user's own browser, and names the user's own app on the consent
screen — so the confidentiality Google expects becomes a promise the
user is making to themselves, which is the only version of it a browser
can keep.

The alternative Google offers browser apps — the TOKEN MODEL
(implicit-style: an access token straight to the page, no secret, NO
REFRESH TOKEN) — is recorded and rejected for v1 with its cost named:
one-hour access and no unattended renewal means a device closed for an
hour cannot sync until someone puts a foreground gesture in front of it,
which is precisely the property the worker host exists to provide. It
becomes the right answer only if zero-setup Drive ever outweighs
background sync.

Note that §3's classification is DROPBOX-SHAPED and does not
generalize: Dropbox issues PKCE public clients, so the demo's owner seam
refreshes with a client id and no secret at all. Google has no such
client type for the code flow. A seam that grows a third OAuth backend
should model "does this provider issue public clients" rather than
assume either shape.

### The broker, parked with its measurements

An opt-in token-exchange broker — holding the secret, so zero-setup
Drive becomes possible — is a direction, not a plan. What the probes
settled about its shape:

- **A broker is PERMANENT in the token path, not one-time.** Google
  demands `client_secret` on the REFRESH grant as well as the initial
  exchange (probed: `client_secret is missing` without it,
  `invalid_grant` with it). There is no "use the broker once, then run
  independently".
- **The one shape where a broker never sees a token** is client
  assertions (`private_key_jwt`): the broker signs a short-lived
  assertion and the worker presents it to Google itself. Google's
  support on USER-consent grants is UNPROVEN — a junk assertion produced
  `internal_failure` (500) rather than the missing-secret refusal, so
  the parameter takes some branch, which is suggestive and nothing more.
  One experiment with a properly registered key settles it; nothing
  should be designed on it before that.
- **The trust at stake is smaller than it looks, and structurally so.**
  `drive.file` confines the token to app-created files, and those files
  are keyhive ciphertext by construction. A wholly malicious broker
  therefore gets availability (delete, withhold) and METADATA — never
  content. The storage credential is not a data-confidentiality
  credential in this design, and that is the sentence any broker's
  consent copy has to be able to say honestly.
- **Which made the metadata the lever — and the lever is now shorter.**
  This bullet used to say that plain derivable names were the gap and
  that porting S3's name-key scheme was the change that would blind it.
  That change is DONE (§2): doc folder names and every object name under
  them are keyed hashes, and the one unkeyed location is the pickup
  object, whose name is a hash of the (doc, owner, member) triple. So a
  broker, or Drive itself, no longer sees doc ids or chunk ids in any
  name. WHAT REMAINS VISIBLE, stated plainly because a shorter lever is
  not no lever: the fixed container words `docs` and `pickup`; the
  NUMBER of documents this account stores; per-document object counts
  and byte sizes; write and read TIMING; and the GROUPING itself — which
  objects belong together, since the folder still gathers one document's
  objects even though it is not labelled with which. Name-keys blind
  labels, not traffic shape. Two further honest limits: a member who
  once held the keychain can go on deriving names (harmless here — a
  name is not a read, since every read needs the user's own OAuth), and
  an observer who already knows a (doc, owner, member) triple can
  confirm that pickup object's existence, which is the same existence-
  privacy gap S3 carries and the same #19/#10 item.

## Parked, explicitly

Drive in the demo page/picker; shared/team drives; resumable uploads
(multipart only — chunks are small by construction); proactive token
expiry (lazy 401 is the shape); a general OAuth-provider framework (this
is one provider's ceremony, recorded concretely; abstract after the
second one exists); Dropbox-on-worker (unchanged from the egress
record — and now cheaper, since the exchange machinery exists).
