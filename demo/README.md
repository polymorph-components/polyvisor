# The end-to-end TodoMVC demo (#20, G6 + G7)

**The #20 target artifact, in a browser**: TodoMVC where the app is a
wasm component driving a curated DOM surface (the todomvc spike), the
model is the `polyvisor:tasks` data service, and the service is
the real engine composite — automerge change-DAG + keyhive (BeeKEM
epochs) + subduction sync + the SigV4 bucket client + the iroh
endpoint — running **under polyengine in the page**. Three panes, one page:

| pane | role | sync path |
|---|---|---|
| Alice — laptop | wire hub, bucket owner | live (n0's public relay by default) + bucket |
| Bob | collaborator | live (n0's public relay by default) + bucket (link tier) |
| Alice — tablet | second device, **zero connections ever** | your bucket (Storage… page) |

**Two storage providers behind one engine surface** (#19): S3-compatible
(name secrecy + K_p, cooperative revocation) and **Dropbox** (shared
links as pull capabilities, hard server-side revocation) — chosen on the
storage page, same beats either way (chosen in the picker sheet above the
bar, configured on the page below it).

Demo beats, all driven through the real UIs and verified:
adds/toggles/edits converge across all three replicas; the tablet cold
boots from the bucket and authors through it; **Bob: bucket pull** shows
the pull tier directly (he holds no storage account — S3: unsigned GETs
by derived name; Dropbox: his standing pickup link under app auth);
**Revoke Bob** mid-demo: alice's next task reaches the tablet while
bob's pane holds ciphertext it can no longer decrypt (`undecryptable: 1`
in his status line) *and* his bucket pull is refused — on S3 the
cooperative K_p darkness, on Dropbox a hard `pickup link refused (409)`
from the provider. Cryptographic exclusion and pull-tier exclusion,
visible in a todo list.

## Storage config as a sandboxed component (#22)

The #22 provisional ruling says the visor is trusted shell code, with one
named exception: *"third-party visor-ish things (a storage backend's
config panel) are **apps** — own sandboxed region, own grants, launched
from the visor, never rendered as the visor."* This demo implements exactly
that, and it is the first place the framework's capability story is
visible in UI:

```
visor (page JS, trusted)           panel component (sandboxed, per-provider)
  Storage… button ─► PICKER SHEET    guest-panel-s3       — dom/events/shell ONLY
    (above the bar: the CHOICE)        "pure component: cannot reach the network"
  storage page, one provider         guest-panel-dropbox — + oauth-broker
  #panel-region (the grant) ────────►                      + fetch scoped to
  page Save writes the record                               api.dropboxapi.com
  picker BINDS it, then connects
  to engine.init-store
```

- The panel is mounted through the **same curated-DOM surface machinery
  as the app** (`createBackend`/`createSurface`, a `root()` grant that
  is the panel region) — position, not style, marks the boundary; the
  region is visibly inset and labeled "sandboxed panel".
- **The provider CHOICE happens above the bar** (#22 "the storage picker
  moves above the bar; commitment never leaves it"). The page used to
  carry two provider tabs, so the most consequential act in the demo —
  deciding where the user's data goes — was made in scrollable content
  beside a component's own rectangle, the most forgeable position on the
  screen: an app can paint that row of tabs. The choice is a visor
  drawer sheet now, with two lists on two orthogonal axes: **(a)
  configured** providers, offered for an ARMED selection (the same
  `ARM_MS` discipline as the credential sheet, because selection is the
  act that spends), and **(b) installed but unconfigured** providers,
  offered for configuration. *Which list* follows CONFIG state; *which
  voice* follows NAMING state — so a configured-but-unnamed provider
  sits in (a) wearing app voice and the NEW marker, and naming it later
  changes its voice in place without changing its list. Consequences:
  - **Save is demoted to a config write.** The page stores that
    provider's record and walks back; it binds nothing, releases nothing
    and opens no sheet. The trust sentence is *configuration happens on
    the page; commitment only above the bar.*
  - **The credential sheet follows SELECTION, not save** — and the
    ordering invariant comes with it: the visor retires the panel and
    leaves the config page before a secret is on screen, which now holds
    even when the selection is made from a picker sitting open over that
    page.
  - **Commit-time destination refusals moved into the sheet**, in
    framework voice, leaving it open with nothing bound.
  - **The opener carries no payload**: the page's *Storage…* button
    requests the picker and passes nothing — no preselection, no filter
    — the `requestNaming` shape. App influence must not reach system UI
    unmarked.
  - **The config store is plural**: one record per configured provider,
    keyed by provider, plus which one is `bound`. The pre-existing single
    record adopts its own provider as its key *and* as the binding on
    migration, so a returning device stays connected to what it was.
  - **The picker survives the config detour, COLLAPSED to a band.**
    Sheets are orthogonal to navigation, so walking to a provider's page
    does not end the ceremony — but the picker does not sit at full
    height over the place it just sent the user to either. It
    shrink-wraps to the chosen entry plus one line of status
    (*configuring — save on the page below*), which puts the whole visor
    assembly at about two strip-heights: the strip answers "who is
    drawing below", the band answers "what step of my own ceremony is
    this". The band is inert by construction — its entry is not a
    control, so there is nothing to select, arm or navigate — and keeps
    exactly one interaction, dismissal, which ends the ceremony. Any
    return path re-expands it with the lists **rebuilt**, so a
    just-configured provider is seen to move from (b) to (a), and arming
    restarts with the new presentation.
  - **A ceremony started mid-detour swaps the band out rather than
    stacking on it or destroying it.** Naming is the invited case (the
    arriving panel is NEW and the strip offers to name it): the band
    slides out left, the ceremony slides in from the right — the page
    track's grammar at drawer scale — and the band returns from the left
    when the ceremony closes. It is *suspended*, not closed: same
    session, rebuilt on return. "One expanded occupant at a time" stays
    literally true. While such a ceremony is up the nested place is
    **bracketed**: the visor's dim goes up and the page goes inert,
    while **the panel stays live** — inert is not retirement, and the
    user is coming back to that session. If the page is left mid-
    ceremony the band waits for the ceremony rather than the page, and
    re-expands only when the drawer is given back.
- **The storage configuration is a PAGE, not a modal** (`#page-track` in
  `web/index.html`). It used to be a `<dialog>` opened with
  `showModal()`, and the reason it is not any more is the anchor: a modal
  paints in the TOP LAYER — above `#visor-zone` — and its `::backdrop`
  dims everything under it, so the strip's identity flip to the arriving
  panel (its NEW marker, the offer to name it: the entire TOFU beat this
  demo is built around) happened in the one place the user was being
  pushed away from. **Nothing may paint over or dim a component
  surface's anchor except the visor itself.** As a sibling page the panel
  becomes a PLACE: the whole page slides sideways while the strip stays
  exactly where it is, so the motion points AT the anchor instead of
  covering it, the browser's Back button becomes an honest way out, and
  the arrival is MARKED on the anchor itself: the strip's left text
  cluster PULSES (a 1.8s alpha-white background wash, `pulseContext` in
  `visor/ui/visor.ts`, `visor-ctx-pulse` in `visor/ui/visor.css`) while a
  visually-hidden `aria-live` region on the strip (`#visor-live`) says
  the same thing to a screen reader. It used to be a timed announcement
  on the strip's bottom line, and that was backwards: the announcement
  spent eight seconds paraphrasing the strip ("the strip above says
  NEW") while covering the very line that carried the answer — the
  arriving panel's plated nickname. A pulse POINTS at the lines instead
  of talking over them, so the whole TOFU beat is readable exactly when
  it happens. Under `prefers-reduced-motion` the wash appears once and
  fades, with no oscillation. It also deleted
  machinery rather than adding it — see the `<dialog>` findings below,
  every one of which is now moot by construction.
- **The way out is on the anchor**: while the storage page is up, the
  strip carries a back chevron at its leading edge (`#visor-back`,
  `visor.setBack(...)`). The page's own *Cancel* is visor pixels by
  construction, but it sits in scrollable content — and an app can paint
  a pixel-perfect copy of it inside its own rectangle, so a user cannot
  tell the real exit from a decoy by looking. A control in STRIP pixels
  can't be copied: the guarantee "you can always leave through the bar"
  replaces the convention "the page offers a cancel button", which is
  what makes it the trust-grade exit. It is also the strip's only
  PERSISTENT nesting signal — the arrival cue is a timed pulse and the
  NEW badge is about naming, so without it nothing says "you are
  somewhere, not home" for the whole stay. All three doors (chevron,
  Cancel, browser Back) run the same `closeStorage`, and the chevron is
  orthogonal to sheets: clicking it navigates the page under an open
  sheet without disturbing it, because a sheet is about a surface and
  names outlive visits. Pages only — a drawer sheet is bracketed by the
  strip and has its own dismissal, and the credential sheet must not
  gain a second cancel path.
- **The visor brokers OAuth.** Navigation, popups and redirect handling are
  visor capabilities a sandboxed panel must not have, so the Dropbox
  panel calls `oauth-broker.authorize(app-key)` and the visor runs the
  whole PKCE ceremony (S256 challenge, popup, `postMessage` relay
  through the redirect, code exchange) and returns only the tokens. The
  panel never sees the ceremony; the app guests never see any of it.
- The panel's `fetch` import **is** the per-destination network grant:
  the visor's shim refuses any host but `api.dropboxapi.com` with a WIT err
  (`__demo.panelFetch` exposes it so the refusal is demonstrable, not
  merely asserted). Its S3 sibling gets no fetch import at all — the
  #21 pure-vs-egress capability-profile contrast, on one page.

## Architecture

```
per pane (×3, one browser page):
  app component (109 KB)            engine composite (10.8 MB)
  todomvc surface guest             keyhive+automerge+subduction+
  imports: dom/events/shell         bridge+S3/Dropbox client+iroh
  + polyvisor:tasks       ────────► exports: tasks + driver
        │  (import wired DIRECTLY to the engine instance's export —
        │   same embedder, same value conventions, same exception brand)
  polyengine runtime (jsr @polyengine/runtime 0.3.0) + @polyengine/wasi (incl. the
  fetch-backed wasi:http fragment) + polyengine ports from JSR
  (webcrypto / websocket / webrtc, all `jsr:@polymorph/*@0.3.0`) + sockets stub
```

- The engine composite is byte-identical to `engine`'s
  (`just engine` delegates there). Translation: ~200 ms, 253 KB envelope.
- The app guest is `spikes/todomvc`'s hand-written guest with the model
  swapped from in-guest memory to the tasks service (async exports + a
  `poll` export for remote-change re-render; string task ids; the
  surface protocol untouched). wasm32-unknown-unknown, no WASI.
- Boot choreography (`host/demo.ts`): identities → tablet enrollment by
  pasted contact card → alice⇄bob wire over the relay → partition
  create → members (individual grants; the group form is proven
  headless in tasks-engine G3) → seal → pulls gated on
  `kh-knows-agent(doc)` → subscriptions → bucket grant/flush → tablet
  cold boot → apps mounted.

## The visor, and where untrusted pixels live

Two changes make the trust boundary legible rather than implied.

**A persistent visor strip** (#22) carries identity in the one region a
component can never paint. Its background is the **user's own colour** —
randomised on first run, changeable from a constrained palette (fixed
lightness/chroma in OKLCH, so contrast cannot be customised away), and
never disclosed to components. It stays CONSTANT while secondary
surfaces come and go: an anchor that changed per component would stop
being an anchor. While a provider panel is open, the strip names it — its
**pet icon** if the user has given it one, its name QUOTED and clamped,
then the visor's own words — plus a loud **"NEW — first time this
component draws here"** marker on first sight, which is the moment
impersonation would land.

**Marks are pet icons, not colours** (the #22 discussion change). A
component's recognition mark is one Unicode glyph the USER picks in the
naming ceremony, from a vocabulary the visor curates
(`APP_MARK_ICONS`, `visor/ui/visor.ts`). The anchor COLOUR is untouched
— it is doing a different job (visor-vs-app contrast, plus a spoof
lottery an impersonator has to win) — but the per-app colour chip is
gone, because colour memory was the weak half: "the blue one" is not
something a user can name, rehearse or check, and ten hues run out after
ten components. A glyph is nameable and discriminable. The curation
rules are invariants, not taste: one BMP scalar, **text presentation by
default** (so no glyph the platform redraws as colour emoji — ☕ ⌛ ⚡ ⚓
are disqualified), long font coverage, ONE glyph per visual-
confusability class with no overlap at all with the user's own set
(hence no stars, shields, diamonds, triangles, clovers, flags, flowers,
moons or gears), no security or UI semantics (no locks, warnings, ticks,
arrows — the visor must never look like it is VOUCHING), and filled
silhouettes for small-size legibility. `isAppMarkIcon` is the gate every
glyph from outside the visor passes before it renders anywhere; a
failure renders as no icon at all. Invariant (g) in
`scripts/check-invariants.sh` pins both halves.

A component may **nominate** a glyph (`mark-nomination` in the WIT): the
app asks for ♜, the S3 panel for ⚗, the Dropbox panel for nothing. A
nomination is offered FIRST in the ceremony's six-icon picker and
foreign-attributed ("it asks to wear …", the glyph quoted like a
nickname) — and only if it is valid AND unclaimed; otherwise it is
dropped in silence. The other five are random per ceremony, so no app's
nomination becomes a de-facto brand by default-bias. The component is
never told the outcome.

An unmarked surface renders **no glyph at all** — never a placeholder,
never a mark the visor picked. That is also how a record migrated from
the old `hue` schema arrives (a number is not honestly reinterpretable
as a glyph), and how a mark comes back from the account's conflict
repair, which CLEARS the loser's icon rather than reassigning one: the
vocabulary is the visor's, so the ceremony re-offers.

Marks are **never derived**. Two derivations died here to one attack —
making the visor's own strip vouch the wrong mark: deriving
from component bytes let an impersonator grind its artifact until the
strip assigned it the target's mark (and reshuffled on every
legitimate update); deriving from HMAC(user-secret, name) closed the
grind but reopened it through the other input, since names are
self-declared. User choice is the strongest form of that: the mark is a
function of a gesture made in visor pixels. Assignment also buys local
uniqueness — icons are offered from the unused set, so two trust
records on one device never share a mark while the vocabulary lasts. The
trust-record key must be unforgeable provenance (here: the artifact
name as fetched by the visor from its own origin; with #3/#10, the
publisher's verifying key) — a self-declared name must never be able to
look up someone else's record. A reset (storage eviction) is
ANNOUNCED, never silent — an anchor that quietly changes trains the user
that it changes.

This is deliberately NOT the personalization secret #22 dropped: it
demands no user action at a decision point and no per-prompt
verification, so it fails toward "something looks off" rather than "I
forgot to check". It is a SECONDARY anchor behind position.

**Component surfaces run in real sandboxed iframes** (#16):
`sandbox="allow-scripts"` with no `allow-same-origin`, so each surface
has an opaque origin, and the op protocol crosses a `MessagePort` to a
frame-side applier that re-validates independently. Apps and panels no
longer render into the visor's document at all. `__demo.frameProbe()`
asserts the property (`sameOriginReachable: false`), and the anchor is
now out of reach by construction rather than by allowlist — verified:
`--visor-bg` is scoped to the strip ELEMENT, not `:root`, so it does
not even inherit into a region.

The visor also owns the **commit**: Save/Cancel live outside the granted
region and call the panel's `commit()`, which returns a config or
refuses with its own reason. A panel owning its own Save button owns the
user's sense of what saving means.

## Device pairing + user-system partition (#10, #36)

`host/pairing-mock.ts` implements the async surface pinned in
`engine/PAIRING.md` §3 (`pair-*`/`us-*`/`user-create`) as
an in-page mock: two mock "devices" share one `MockPairingNetwork`, so a
code offered on one pane is claimable on the other and both compute the
same SAS from the same transcript — real UI development without the
real engine composite. `../../visor/ui/pairing.ts` is the visor-owned
rendering of both ceremonies (it is also the ONLY module allowed to
render a pairing code or a SAS — `scripts/check-invariants.sh`'s new
check [6/6] holds that line), and `../../visor/ui/pairing-driver.ts` is
the backend contract it is written against:

- **Join** (new device): "join existing account" → QR (a vendored,
  self-contained encoder, `../../visor/ui/vendor/qrcodegen.ts`) + the 79-char code
  in groups of 4 → SAS screen → **light** confirm ("I initiated this" +
  SAS match — nothing secret is typed, no arming delay) → the adoption
  announcement ("this device now follows your profile: ‹name›, your
  colour"), with the pane's hue visibly repainted to the synced value.
- **Add** (trusted device): "add a device" → paste/type the code → SAS
  screen → **heavy** ceremony: a statement of consequence ("full access
  to everything in your account"), the #22 arming delay (ported
  verbatim, same 700ms constant as the credential drawer), and a
  device-name field that is never prefilled from anything the joiner
  sent — the visor's own words are the user's own words. Completion adds
  the new device to a devices list.
- **State migration**: visor hue, display name and the petname/marks
  table move to `us-*` driver calls; `localStorage` demotes to a **boot
  cache** (`../../visor/ui/pairing.ts`'s `loadBootCache`/
  `reconcileFromDriver`) — render from cache, reconcile after driver
  init, announce any diff (never silent). The keystore (device-local
  signing key handles) is untouched by this.
- **Announcements** drain `us-events` into a status surface with the
  same priority-over-ambient-telemetry pattern as the three-pane demo's
  beat statuses (sticky for 12s once a consequential message writes it):
  `profile-changed`, `mark-conflict-repaired` (renders as
  NEW-with-explanation for a `needs-reconfirm` mark), `device-added`,
  `device-revoked`.

Try it: `just pairing-site && just pairing-serve`, then open
`http://127.0.0.1:8601/pairing-demo.html` — two panes, one page, no
engine/wasm/relay/bucket dependency (that is the point: this gate is
independent of Track A's engine work landing). Playwright gate (real
headless Chromium): `demo/tests/pairing.spec.mjs` (see that
file's header for the exact run recipe) asserts SAS equality across
panes, that the arming delay actually gates the add-side confirm, that
announcements render, and that the join pane's hue visibly adopts the
synced value.

### In the three-pane demo

The ceremonies are wired into the main demo too, in the two places
PAIRING.md §5 puts them:

- **Add** opens as a visor DRAWER SHEET, reached from "Your visor" →
  "add a device…" — a button the visor draws on its own sheet, from the
  strip. The sheet is an EXCLUSIVE drawer tenant: while a device is
  being granted admin over the account, a click on the strip cannot
  slide another sheet over the ceremony.
- **Join** is a pane-local affordance in the TABLET pane.
- **The grant is the user's last act on the granting device**, so the
  sheet comes down the moment it is made; the session keeps running with
  nothing on screen and announces its outcome — enrolled, failed, or a
  peer that never finished — on the strip. (That is right for real
  hardware, where you put the laptop down after granting. It also
  un-deadlocks this one-page demo, where the sheet's dim lies over the
  rectangle standing in for the other device: a sheet that stayed up
  would make the joiner's confirm unclickable.)
- One-page artifact, deliberately not "fixed": BEFORE the grant, that
  same dim also covers the tablet pane, so start the join FIRST (the new
  device displays its code first anyway, per §5) — on real hardware the
  laptop's dim does not exist on the tablet.
- Naming a component, forgetting it, and saving the settings sheet now
  WRITE THROUGH to the partition (`us-mark-put`, `us-mark-forget`,
  `us-profile-set`); boot renders from `localStorage` and then
  `reconcileFromDriver` announces any difference on the strip.
  `us-events` drains onto the strip through `visorAnnounceSink`.
  The localStorage keys and formats are unchanged — that IS the
  demotion: the same bytes, no longer the source of truth.

**Which driver.** The in-page ceremony runs against the REAL ENGINE by
default (`../runtime/pairing-engine.ts`, one composite instance per
pane, over iroh); `?pairing=mock` overrides it with the in-page mock.
Everything above the driver is the same code either way. The engine path
completes a full ceremony now — code, SAS, grant, ENROLL — since the
`user-create` guest trap (a scheduler misattribution in the runtime's
async support, polyengine#213) and the add side's yield-spinning linger
were both fixed; PAIRING.md §6 carries the dated status. The page still
says which backend is live rather than pretending, and a user-system
that fails to come up is reported on the laptop pane rather than being
fatal.

**Pairing grants membership; the embedder wires sync.** When a join
completes, `host/demo.ts` connects the two panes and `sync-start`s the
enrollment's partition with `subscribe` in both directions — otherwise
the joined device holds a membership and an empty user-system doc, and
no petname written on the laptop could ever reach it.

e2e coverage, two scenarios over the same acts
(`e2e/scenarios/device-pairing-acts.ts`):

- `just e2e device-pairing` — the LIVE ceremony over the engine, against
  a relay the harness spawns itself on an ephemeral port (the suite
  never touches the public relay);
- `just e2e device-pairing-mock` — the same acts against the mock: fast,
  transport-free, and the half that says whether a failure is the
  visor's or the engine's.

Both assert both ceremonies, SAS equality across the two surfaces, the
arming delay, the empty device-name field, the adoption announcement,
and a petname written on the laptop arriving on the tablet.

## The solo page — one device, pairing across two browser pages

`serve/solo.html` (built from `web/solo.html` + `host/solo.ts`, linked
from the demo's own control bar as "one device") is a **second, smaller
embedder** over the same served artifacts: ONE engine instance, ONE
visor, the todomvc app in its sandboxed frame. It is not another view of
the three-pane demo — it is the deployment shape the demo deliberately
is not.

The demo puts a whole account on one page so both ends of every beat are
watchable at once, which is good theatre and a poor model: the two
"devices" share a process, a document, a storage origin and a boot, so
several things a real second device must do for itself are simply
variables in scope. On the solo page they are not. Two solo pages, in
two independent browser contexts, meet only over the relay, and
everything that crosses between them had to cross a wire:

- the **adder's endpoint and agent ids**, which the joiner learns only
  from `pair-enrollment` (the record grew `peer-agent-id` /
  `peer-endpoint-id` for exactly this; both are OBSERVED — the endpoint
  is the transport-authenticated dialer, the agent is the issuer of the
  signed delegation in the ENROLL card — never a name the peer claimed);
- the **tasks partition id**, read out of the synced user-system doc's
  partition-pointer map (#36), which is a joined device's only channel
  for it;
- the todos, and the account's petnames, over the subduction the
  embedder wires after the ceremony — **writer accepts, reader dials**
  (reversed, everything reports healthy and nothing flows).

First run offers two affordances plainly, neither dressed as the
default: **new account** (create the user, create the tasks partition,
delegate it to the USER GROUP — never to a device — seal, publish the
pointer) and **join another device** (the visor's join pane, then the
sync-and-adopt flow above). Adding a device is the same heavy ceremony
as the demo's, reached from the visor's own settings sheet.

Its storage keys are `pm-solo-*`: the two pages share an origin, and an
identity shared between them would make the "separate device" claim
false. Those keys are now only the visor's **boot cache** (a colour, a
name, the trust table) — which devices exist and what opens them is the
device store's, in IndexedDB and OPFS.

### The device survives (G5)

The engine no longer runs in the page. It runs in the device's
**SharedWorker** — one per device, owning the engine instance, the
namespace, the device lock and the unsealed key — and the page is a view
onto it over a MessagePort (`runtime/device-store/`, designed in
`runtime/PERSISTENCE.md`). The three storage seams and the signer still
REFUSE; what changed is only that they refuse in the worker.

- **Try, then keep.** A first visit asks nothing: a device exists, it is
  T0 (ephemeral), and it survives a *reload* — the tab holds the only
  pointer to its namespace, in sessionStorage, and hands it to the fresh
  worker, which rehydrates from the checkpoint. A pointer to a namespace
  the sweep has collected is a fresh device, silently, never an error.
- **"Keep this device"** is a settings-sheet ceremony, and it is where
  the seal choices are asked: a **petname** — which the sheet says out
  loud rests *unencrypted*, because the picker has to read it before
  anything is open — and one of two rungs. `until-reseal` opens the
  device with no interaction, and the sheet gives the honest sentence
  for it: *login convenience, not protection against someone holding
  this browser profile.* `every-session` derives the key from a
  passphrase that is never stored, and is the real tier.
- **Unseal is the login**, and the ordering is the anti-spoofing tell:
  the picker is generic chrome — petnames and last-used, nothing else —
  and the visor is not even constructed until the seal opens. Your
  colour, your name and your icon appear at that moment and not one
  pixel before, so a page imitating the picker has nothing of yours to
  copy.
- **Reseal** is an explicit control: it deletes the key kept here, drops
  the worker's key material and returns you to the picker. On a device
  that opens itself and has no passphrase anybody knows, it is an
  **upgrade ceremony** rather than a plain exit — *sealing this device
  means choosing what unseals it.* The worker re-keys the data key from
  the platform rung (which is still there, which is why reseal time is
  when this is possible) and only then deletes that rung, so the device
  comes back as an `every-session` one under the same name. Reseal never
  destroys a device by omission: an empty ceremony is refused, and
  forgetting a device is a separate, explicit act.
- **The device name on the strip** appears exactly when this browser
  holds more than one device (pickable, not merely active). One device:
  no label, it is noise.

**What v1 does not have**, and does not pretend to: no bucket — the
three storage seams and the signer are wired to REFUSE, which is the
honest wiring for an instance with no destination — and therefore no
storage picker and no provider panels; no collaborator; no three-pane
theatre. (The "no identity across reloads" caveat is gone: that was
exactly what G5 fixed.)

`just e2e` drives all three of the page's scenarios:

- `solo-pairing` — two `ctx.fresh()` contexts, todos typed into the real
  todomvc input inside the sandboxed frame, SAS equality asserted across
  two documents, convergence in both directions plus a petname. Both
  devices now run in their own workers, cross-context.
- `solo-persistence` — try, keep as "laptop", a REAL reload, the picker
  offering the name, a silent unseal, the todo list intact, then the
  reseal upgrade: an empty ceremony refused, a passphrase chosen, and a
  picker that afterwards demands it (wrong one refused cleanly, right one
  opening the device with the todos intact and nothing personal on screen
  until it does).
- `solo-ephemeral` — a T0 device surviving a reload through its anchor,
  and both halves of the device-name rule, with the second device made
  from the picker in a second tab.

## Deployment

The hosted build is **continuously deployed**: `.github/workflows/pages.yml`
runs `scripts/setup.sh` (sibling ports pinned by commit, toolchain from
`rust-toolchain.toml`, `wasm-tools`/`wac`/`just` pinned), builds the site
from source on every push, and deploys `docs/` to Pages from `main`. PRs
build the site too but do not deploy — a broken demo fails the PR
instead of the site.

`docs/demo/` is **generated, not committed** (cutover completed
2026-08-18: Actions deploy proven via the served build stamp, Pages
source switched, then the artifacts deleted from git — four rebuilds of
an ~11 MB engine composite had landed in history before that). `just
pages` writes the same tree locally for preview. Bumping a sibling pin
in `scripts/setup.sh` is deliberate: those ports carry embedder
conventions that have broken this demo before.

## Run it

```
just serve    # build engine+app, translate, bundle, serve on :8600
```

Open http://127.0.0.1:8600/. The live path rides n0's public relay
(`?relay=…` overrides, e.g. a local `iroh-relay --dev`); the bucket
pane activates through the **Storage…** page — either an
S3-compatible endpoint whose CORS admits the page origin (`just infra`
runs a local MinIO with open CORS, plus a local relay), or **Dropbox**:
paste an app key + secret from a Dropbox app (App folder access;
scopes `files.content.*`, `sharing.*`, `account_info.read`) and press
*Connect Dropbox* for the PKCE flow, or paste a console-generated
access token. Add `http://127.0.0.1:8600/` as an OAuth redirect URI in
the app console for the Connect path. Hosted build:
https://polymorph-components.github.io/polyvisor/demo/
— same story: public relay out of the box, bring your own bucket.

Requires `engine`'s pinned iroh-relay + endpoint wasm
(`just -f ../engine/justfile relay-bin`; endpoint wasm still via
`IROH_CHECKOUT` — see that spike's README "JSR pins" section for why)
and its MinIO fetch (run that spike once). The polyengine ports
(webcrypto/websocket/webrtc-datachannels) are JSR pins now, no sibling
checkout (see `deno.json`'s header comment).

Headless bring-up phases (`just bringup solo|wire|bucket`) retire the
platform layers one at a time under Deno; `wire soak` runs a 30 s
post-revocation stress loop.

Memory/backpressure probes (added while chasing a reported lockup):

```sh
deno run -A host/leak-probe.ts 90 pulls   # engines + live subscriptions, RSS
deno run -A host/table-probe.ts           # 400 pulls, guest table sizes + RSS
deno run -A host/cdp-heap.ts <url> 300    # real headless Chromium heap via CDP
```

`cdp-heap.ts` needs a Chromium binary (`CHROME=…`, or the Playwright
cache default) and forces a GC at the end — the only reading that
separates retention from uncollected garbage. In-page, `__demo.health()`
reports background queue depth and per-timer skip counts.

## Findings

- **deltic 0.1.0 renamed the embedder conventions** (`WitError` →
  `ComponentException`; variant envelopes `{tag, val}` → `{kind,
  value}`). This USED TO be a problem: earlier sibling-checkout pins of
  the three deltic ports predated the rename, so websocket was vendored
  here with a mechanical migration while webcrypto/webrtc happened to be
  shape-compatible on the engine's paths. Resolved (jsr-pins branch):
  `jsr:@polymorph/{webcrypto,websocket,webrtc-datachannels}@0.1.0` all
  publish against `@deltic/runtime@^0.1.0` — confirmed by reading each
  package's source, including `websocket.ts`, which already imports
  `ComponentException` (the exact migration the vendored copy was
  performing by hand). All three now come straight from JSR; the
  vendored `host/ports/websocket.ts` is retired (deno.json's import map
  points at the JSR package instead).
- **Browser bundling of the webrtc port** drags its lazy node backend
  (`node:*` statics from werift) into the bundle; `--external
  node-datachannel --external werift` keeps the lazy import lazy — the
  browser never evaluates it (native `RTCPeerConnection` wins).
- The engine composite **instantiates in ~30–50 ms** in the page; the
  full crypto stack (BeeKEM seal/open, SigV4, Ed25519 via the webcrypto
  port) runs at interactive latency.
- The first-sync **policy race** (recorded in the tasks-engine spike)
  reproduces at browser timings: gate the first pull on
  `kh-knows-agent(doc)`.
- **One in-browser subscription-push miss was observed** (a task
  authored right after boot never pushed; a fresh boot delivered
  pushes fine). Background reconciliation pulls (2.5 s, empty diff when
  in sync) bound the staleness; a 30 s Deno soak of the same loops
  (88 cycles, post-revocation refusals included) shows no engine-side
  defect. Needs a minimal repro upstream.
- **Background driver calls are serialized page-wide** (one promise
  chain): an earlier build with overlapping interval-driven calls into
  the same instances froze the page once. Not reproduced under Deno;
  suspected interaction with the embedder's instance scheduling —
  serialize until understood.
- Screenshot/capture tooling against the page (paseo webview) times out
  — background tabs never paint; validation is DOM-assertion-based.
- **The `{kind, value}` variant envelope bit again.** The rename was
  already recorded above, and the first cut of the new `store-config`
  variant still shipped `{tag, val}` (a TS union modeled on a *port's*
  internal error type, not on the embedder's wire convention). It
  surfaced only at the first live `init-store`:
  `expected a { kind, value? } value, got a Object`. Host-side variant
  construction has no type-level protection against this — the
  embedder's convention is a runtime contract, so the check belongs in
  a smoke path, not in review.
- **Transient beat results were being erased by the stats refresh.**
  Pull outcomes and the revocation guarantee note are the *payload* of
  those beats, and a 4 s `stats()` tick overwrote them within one frame.
  Status lines are now **sticky for 12 s** when a beat writes them
  (stats stand down). Worth carrying into the framework's visor: a
  status surface that mixes ambient telemetry with consequential
  one-shot messages needs priority, not last-writer-wins.
- **A bare transport error is undiagnosable, and one of them killed the
  whole setup.** A live run failed with
  `fetch: send: ErrorCode::InternalError(Some("NetworkError…"))` — no
  method, no host, no operation — after ~20 s of a single
  "configuring storage…" line. Three fixes, all in this commit: every
  provider request **names itself** in transport errors
  (`PUT host/path: transport failed after 3 attempts: …`); transport
  failures (never statuses — 429/5xx go to the caller untouched) **retry
  up to 3×**, which is safe because every provider call here is
  idempotent by construction; and setup **announces each step**
  (`configuring storage: grant: bob (pickup link)…`), so a failure says
  *which* of the ~20 sequential calls died and the remaining message is
  actionable advice rather than "check endpoint + CORS".
- **A duplicate "Save & connect" re-ran the entire setup**, re-minting
  container links and republishing pickups under the first run. The
  guard's placement is the subtle part: the background chain serializes
  work, so a flag checked *inside* the job always finds the previous run
  finished — it has to be claimed **synchronously at call time**.
  (Verified by driving two calls in one tick; the second is refused.)
- **Unversioned assets served returning visitors a stale bundle.** The
  page loaded `demo.js` by bare name, so a rebuilt demo kept running the
  cached script against fresh components — it cost an hour of chasing a
  fix that was already deployed. The build now stamps a mutable root
  (`<meta name="pm-build">` + `demo.js?v=…`) and artifacts inherit the
  stamp: NOTES §Release integrity's bootloader shape in miniature, and
  the thing that makes a Pages republish actually take effect.
- **Console-generated Dropbox tokens expire in ~4 h**, and the failure
  is now legible (`create_folder_v2 …: 401 expired_access_token`). The
  OAuth path is the real fix: PKCE with `token_access_type=offline`
  returns a refresh token, and the engine refreshes on 401 and retries
  once. Paste-a-token remains the dev fallback with a stated cliff.
- **Fixed-rate timers with no in-flight guard were the lockup.** Every
  periodic driver — app `poll` (400 ms x 3 panes), reconciliation pulls
  (2.5 s), auto bucket-sync (4 s), stats (4 s) — appended to an
  unbounded promise chain unconditionally, while the work behind them
  routinely outlives the period (consumer-API storage runs 1-3 s/op).
  Fixed-rate scheduling + slower-than-period work diverges: the queue
  *is* the leak, and user input ends up behind hundreds of pending jobs
  (sluggish, then wedged, then dead). All periodic work now **skips a
  tick whose predecessor is still running** — correct semantics anyway:
  a reconciliation pull is a refresh, not a transaction. Measured with a
  1.5 s/op delay proxy in front of MinIO: **180 ticks skipped in 3
  minutes** (jobs the old code would have queued), background depth
  bounded at 3-4, and a UI-path task add still completing in **3 ms**
  while storage churns. `__demo.health()` exposes depth + per-timer skip
  counts.
- **The "leak" was the queue, plus a measurement artifact — chased to
  ground.** After the backpressure fix, growth persisted in the paseo
  webview (~1 MB/s, monotonic over 5 minutes), so it was bisected:
  500 driver/tasks calls leak nothing; app polls at 400 ms x 3 for 75 s
  are flat; **reconciliation pulls leak** (35 MB / 75 s). Two independent
  checks then cleared the engine: `host/table-probe.ts` runs 400 pulls
  headless and shows every guest table flat with **RSS plateauing at
  ~300 MB**, and a real headless **Chromium via CDP** (`cdp-heap.ts`)
  runs the identical page for 150 s — heap sawtooths normally and
  **returns to 7.5 MB after a forced GC, net -1.5 MB**. So there is no
  leak in the engine, in subduction, or in the polyengine browser ports; the
  unbounded growth was (a) the queue divergence above, which retains one
  closure per queued job, and (b) the paseo webview's own instrumentation
  retaining objects (and/or never idling long enough to GC). **Measure
  memory in a real browser, not in the automation webview** — the
  earlier version of this section blamed the port layer on the strength
  of webview numbers, and was wrong.
- **One real leak was found and fixed on the way**: the engine's `syncs`
  table inserted a result per sync and never removed it, while
  `sync-status` only read it — unbounded by construction at ~48 syncs a
  minute. Statuses are one-shot by contract, so the entry is now removed
  as it is read, and `stats()` publishes the guest's table sizes
  (`tables syncs=… conns=… parts=…`) precisely because a growth bug in
  them is invisible from outside the component.
- **Four bugs surfaced by moving surfaces into frames**, all of the same
  family — a surface's lifetime and its measurements stop being things
  the shell can observe directly:
  1. **A component frame outlived its dialog.** Mounting is async
     (artifact fetch + frame handshake) and `<dialog>` closed natively on
     ESC, so a late mount, or any close path other than the buttons,
     left a LIVE component holding a granted rectangle nobody could see.
     Fixed with a generation counter checked after every await, plus
     retirement hung off the dialog's `close` event — the one place that
     saw every path. The generation counter is still load-bearing (mounts
     are still async); the close-event half is gone with the dialog, and
     leaving the storage page is now a function call with nothing to
     race.
  2. **Height reporting raced the render-blocking stylesheet.** The
     frame's first (and only) height report was taken before layout
     existed, so it truthfully said 0, the shell clamped to its floor,
     and a quiet app never corrected it. Now a `ResizeObserver` reports
     continuously.
  3. **`scrolling="no"` collapses `scrollHeight`.** Under
     `overflow:hidden` it equals the clipped viewport, so the frame kept
     reporting the shell's own clamp back to it. Measure the body's flow
     box instead.
  4. **The frame accepted a port from any sender.** Sibling frames are
     reachable via `parent.frames[i]`, so the first sibling to post a
     port could have become another frame's shell. The embedder check is
     `e.source === window.parent`; origin cannot be used, because every
     sandboxed frame reports "null".
- **The paseo webview does not deliver `<dialog>` close events.** Native
  `close()` flips `.open`, manual `dispatchEvent` delivers fine, but the
  engine-queued close event never arrives — and modals also close
  spuriously without any event. Retirement therefore triggered on the
  **state change** (a MutationObserver on the `open` attribute) with the
  close event kept as belt-and-braces. Same lesson as the memory-leak
  hunt: the automation webview is not a reference environment — the
  companion CDP probe confirmed real Chromium delivers the event and
  tears down correctly.

  **This finding is why the demo no longer uses a dialog at all.** Two
  mechanisms and four ordering guards existed to reconcile one engine's
  close semantics with another's; none of them was making the product
  better, and the modal was simultaneously hiding the anchor at the
  moment the anchor mattered most. A sibling page has no close event, no
  top layer and no engine-specific behaviour to reconcile — the bug class
  was deleted rather than defended against. The claim the machinery
  protected is still gated, by `e2e/scenarios/storage-page-navigation.ts`
  (formerly `dialog-close-retirement.ts`): no path out of the storage
  page — Cancel, browser Back, or the Save handoff — may leave a live
  panel session off-screen.
- **Isolation costs the old verification path**: the visor (and any test
  driver) can no longer read into surfaces, and `browser_snapshot` stops
  at the iframe. Driving is now engine-level assertions plus frame
  self-reports; UI-level driving needs an explicit frame-side hook.
- **A diagnostic that dies with the handshake reports "no faults" for a
  frame that is on fire**: the fault channel first hung off the same
  window listener the handshake removed. It gets its own listener now.
- **Panel teardown is a polyengine open question** (same one #22 lists for
  app kill): remounting a provider panel clears the region and drops the
  references, but there is no explicit instance-terminate API — the
  panel's engine-side resources are released by GC, not by contract.
- **Dropbox provider timings in-page**: `store-grant` (seal pickup +
  upload + mint link) ~1.5–2 s, `bucket-flush` ~1.5 s, link-tier pull
  ~2 s, revoke (revoke pickup link + delete + revoke container link +
  re-mint + rewrite remaining pickups) ~5 s — consumer-API latency, on
  the deliberately non-realtime path.

## Scope cuts (deliberate, recorded)

- **Individual membership instead of user groups** in the browser
  choreography (groups + cards + both revocation flavors are proven in
  `engine` G3; the browser demo exercises engine+UI+sync).
- **Share-at-boot**: BeeKEM adds are not retroactive, so a mid-demo
  *first* share would (correctly) show Bob a partial history — honest
  but confusing in a demo; the mid-demo trust-change beat is the
  revocation instead.
- **No G5 unlock UI**: the identity bundle + restart is proven headless
  (tasks-engine act 10); the browser leg (passkey-PRF / file picker)
  needs user-gesture ceremonies that an autonomous run can't exercise.
