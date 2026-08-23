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
modeled on Dropbox's plain-derivable-path strategy with the entire link
machinery removed: every call runs Route::Owner, and the grant an
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
- `store-grant(doc, member)` still writes the member's K_p pickup object
  at a derivable path — the pull layer's key bootstrap, which the
  ACCOUNT'S OWN DEVICES need (each device is its own agent with its own
  prekeys) — and returns NONE: there is no link to carry because there
  is nothing a link could grant. (Recorded fact from implementation: at
  this revision the pickup record is WRITE-ONLY — the owner-tier pull
  derives the device set from the doc folder's own listing, and keys
  arrive through the keyhive op stream — so it is the mandated bootstrap
  record, not yet a dependency. It becomes load-bearing the moment a
  pull path exists that cannot list the folder.)
- `store-revoke` deletes the pickup and returns the honest note: this
  store never minted a capability, so there is nothing server-side to
  revoke; a party holding the user's own Drive credential is outside
  this store's reach, and credential rotation at Google is the real
  lever. (A consequence that follows from grant-returns-none and is
  accepted: the engine's pickup-link table stays empty on this provider,
  so revoking a member who was never granted deletes nothing and
  succeeds quietly. A louder refusal would need a grantee list the
  provider deliberately does not keep.)
- `bucket-pull` is owner-tier only. A call carrying a `pickup` link is
  refused by name — a link-tier pull is not a thing this provider has.

### 2. The strategy: Dropbox's shape over an id-addressed API

- Scope is `drive.file` — files created by this app only. That is the
  minimal honest scope, and it carries a fact worth stating twice: the
  confinement is PER CLIENT ID, so every device of an account must use
  the SAME client id or they cannot see each other's store. The client
  id is part of the store's identity, beside the root folder name.
- Drive is id-addressed and names are not unique. The strategy resolves
  name→id with `files.list` queries scoped to a parent folder, caches
  folder ids in instance memory, and never creates duplicates itself
  (upload is list-then-create-or-update: multipart create when absent,
  media PATCH when present).
- Layout mirrors Dropbox's: root folder (the binding's `root`) →
  `docs/<hex(doc)>` folders holding `<kind>-<hex(id)>` children;
  `pickup/<hex(doc)>` folders holding per-member pickup objects.
- `gdrive-config` is `{ root, api-base }` — ADDRESSING ONLY, like every
  other arm. `api-base` defaults to `https://www.googleapis.com` and
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
  `gdriveConsent: boolean` — false while sealed or absent, so the sheet
  can offer bind-without-ceremony when a consent already rests sealed.

### 6. v1 surface: the solo page only

The solo sheet grows a provider choice (S3-compatible | Google Drive);
the Drive form is chrome-owned fields — root folder, client id, client
secret (masked; it is an app identifier, but it is also not something to
paint on a screen) — a Connect ceremony that runs consent → bind →
activation beats, and the same sync/change/disconnect controls. The solo
boot grows the popup-relay branch the demo page already has. The demo
page does NOT grow a Drive panel: its storage theatre exists to show the
sharing tiers, and a no-sharing provider adds nothing it can show.
Recorded, not forgotten.

## Gates

- **Engine**: clippy + wasm build + compose + translate; a new headless
  bringup phase `gdrive` — the full owner beat (initStore → ensureBucket
  → grant self → flush) plus a cold second engine pulling from the
  bucket alone, against an in-process fake Drive. Existing `solo`,
  `resume`, `pair` batteries unchanged.
- **The fake** (demo/host/fake-drive.ts, one module for bringup, the
  devstore harness and e2e): minimal files API (`files.list` with the
  q-subset the strategy emits, multipart create, media update,
  `alt=media` get, folder metadata) plus the OAuth half — `/auth` 302s
  straight back with a synthetic code (headless consent), `/token`
  verifies the PKCE verifier against the challenge it saw (OUR PKCE is
  what it gates), issues synthetic labeled tokens, supports refresh
  with rotation and on-demand expiry.
- **Devstore rows**: ceremony tokens sealed and never in `status()`;
  bind refusals by code (no consent; client-id mismatch); bind + flush
  with Bearer egress observed; kill/`__die` + re-unseal with no
  re-ceremony (binding AND tokens survive sealed; initStore re-applied);
  401→refresh→retry with the re-sealed token surviving a second kill;
  reseal/unseal; unbind keeps consent, forget deletes it (+revoke
  observed at the fake).
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

## Parked, explicitly

Drive in the demo page/picker; shared/team drives; resumable uploads
(multipart only — chunks are small by construction); proactive token
expiry (lazy 401 is the shape); a general OAuth-provider framework (this
is one provider's ceremony, recorded concretely; abstract after the
second one exists); Dropbox-on-worker (unchanged from the egress
record — and now cheaper, since the exchange machinery exists).
