# visor/ — the framework layer, graduating out of the spikes

The visor is the framework-owned trusted UI and the isolation seams
around sandboxed apps (#22's rulings; #16's per-surface frames; #5's
disclosure model). It began life inside the spikes — the DOM-op seam in
`spikes/todomvc/host/`, the frame isolation and system UI in what is
now `demo/` — and both consumers (the demo and the archived todomvc
spike) now take it from here instead of reaching into each other's
directories.

Three layers, one trust story:

- **`surface/`** — the app seam. The `Backend` protocol and its
  implementations (`direct`, `queued`, `channel`, plus the frame side
  of `frame`), the op `applier` with independent re-validation
  (`validate.ts`), the guest-facing WIT `surface`, the serialized
  guest-call `runner` (whose `pause`/`resume` is the visor's input
  suspension), and the `events` records. Everything an app's DOM ops
  and events cross, validated on both sides of every seam.

- **`frame/`** — iframe isolation. `frame-backend.ts` (trusted side)
  creates a `sandbox="allow-scripts"` iframe — no `allow-same-origin`,
  so the app's document gets an OPAQUE ORIGIN and structurally cannot
  read the visor's DOM, styles, or storage. `frame.ts` + `frame.html`
  are the code the visor ships INTO that frame: the applier wired to a
  MessagePort, height reporting, coarse theme (never the anchor
  colour). The queued-op protocol is identical to `channel`; only the
  realm changes.

- **`ui/`** — the system UI core. `initVisor()` renders the strip
  (two-line context, identity cluster), announcements
  (re-render-not-restore), the anchor-colour discipline (scoped custom
  properties, never `:root`; announced-never-silent resets), the
  identity record, and the drawer host (tenancy with precedence,
  arming delay, ownership-aware context restore). Storage keys are the
  consumer's (`pm-demo-*`, `pm-todomvc-*`); the element ids
  (`#visor-strip` and friends) are fixed — position is a trust anchor.
  `visor.css` carries the visor-owned styles both pages link.

  THE EVENT RECORD lives here too (#132), because the strip's
  announcement was doing three jobs on one transient line. Moment cues
  stay push; **standing conditions** become keyed state the visor holds
  (`setCondition`/`clearCondition`, whose return value is the EDGE, so a
  poller announces once per crossing instead of once per tick) and are
  session-live, never persisted — a stored condition could outlive the
  poller that would have cleared it; **event records** become a
  persistent, acknowledgeable list under the consumer's `eventsKey`,
  wiped with everything else by `erase()`. The mechanical rule is one
  line per host: EVERY CONSEQUENTIAL ANNOUNCEMENT LEAVES A RECORD, and
  ambient lines never do — it sits inside `visorAnnounceSink`, which
  already carried the flag, so a new event source is recorded the day it
  is written and ambient telemetry cannot silt the list up. What
  advertises it is a DOT on the identity circle (`#visor-settings`):
  absolutely positioned so the strip's measured geometry cannot move,
  carrying no text at all so it is framework voice by construction, and
  lit exactly when there are unseen records OR a condition standing.
  Behind it is the "recent events" sheet, reached from a visor-owned row
  on the settings sheet through the erase entry's suspend/resume motion,
  and OPENING IT MARKS EVERYTHING SEEN (the badge then goes out unless a
  condition still stands). Entries are flat strings under `announce()`'s
  voice policy exactly — framework voice, user-voice words inline, app
  voice never — and under one further rule: THE AUTHOR IS ALWAYS THE
  VISOR OR THE ENGINE. The subject of a record may be an app; letting an
  app light the user's own identity circle would be handing components
  "look at me!" as a primitive.

  Device pairing lives here too (`pairing.ts`, PAIRING.md §5): the join
  flow's QR and 79-char code, the SAS screens, the add flow's heavy
  ceremony (statement of consequence, the drawer host's own `ARM_MS`
  arming delay, a device name the user types and nothing ever
  prefills), and the user-system machinery around them — the
  `us-events` drain that makes remote changes announced-never-silent,
  and the localStorage boot cache that reconciles against the partition
  and announces the diff. It is here rather than in a consumer because
  that is what the invariant claims: a pairing code or a SAS renders
  only in visor pixels, and `renderPairingCode`/`renderSas` are defined
  exactly once, in this file. What a backend must provide is
  `pairing-driver.ts` — a contract the UI states and the demo satisfies
  twice (a mock, an engine adapter); the announcement sink and the
  storage keys are the consumer's, as everywhere else here.

  The ENTRY ceremonies are here too (`entry.ts`): the device picker and
  the first-run fork — how a browser becomes a device with an account.
  They live here for the same reason the pairing UI does, one step
  earlier in the boot: identity, account and ceremony UI appears only in
  visor territory, and the drawer is where that claim is spatially real
  (a sheet attached to the pinned strip, the page dimmed around it —
  neither reproducible from inside a component frame). The picker is the
  one sheet that opens before the visor has been claimed, so it renders
  on the unclaimed grey dress with index content only (petnames and
  times); `initVisor({ deferClaim: true })` and `visor.claim()` are the
  two halves that let a shell exist without anything personal in it.
  One definition, drawer-only, pinned by check (i) of
  `demo/scripts/check-invariants.sh` — the same marker pattern check (f)
  uses for the pairing renderers.

Consumers: `demo` (full flows: petnames, credentials, storage
dialog, pairing) and `spikes/todomvc` (consent/kill tenants, frame
backend by default). Source-level invariants for all of it are
enforced by `demo/scripts/check-invariants.sh`, whose greps
follow the code here (each check names its files); the demo's
Playwright e2e suite (`demo/e2e/`) is the behavioral gate.

## Three voices

Every piece of content the visor renders belongs to exactly one
provenance class, and the class is visible. The design language is
three voices, no more:

| class | meaning | marking | examples |
| --- | --- | --- | --- |
| *(unmarked)* | **framework voice** — the visor's own words | none; it is what the visor looks like. `.said` commentary is slightly muted (.85), headings and labels are full strength | sheet headings, labels, hints, `.said` lines, announcements, SAS digits, the pairing code, the `.fresh` badge |
| `.petname`, `.who` (and pet icons, `.mark-icon`) | **user voice** — the user's own vocabulary, spoken by the visor | weight 600, full opacity, never quoted, never monospace, no plate; `.who.device` is the quieter half at 500 | the petname on the strip and on sheets, the user's name, their word for this device, the pet icon |
| `.foreign` | **app voice** — component-influenced strings | quoted (`<q>`) + monospace + textual attribution + a recessed *plate* (an alpha background with an inset shadow), so it reads as an embedded token rather than as a word in the visor's sentence | "calls itself", the provenance key the visor fetched an artifact by, a panel's declared destination, a nominated glyph |

User voice is deliberately **not** italics: CJK has only synthetic
oblique, Arabic has no italics at all, italic legibility at 12px is
poor, and italics read as quotation — the wrong connotation for the one
voice that is not being quoted. The plate is alpha-based on purpose (it
must read on all ten anchor hues at 38% lightness) and carries **no
border**: a bordered light rectangle is this visor's *button* dress, and
a non-interactive token must not wear a control's clothes. The inset
shadow says recessed, not raised. It also carries no vertical padding —
the strip's line height is a measured property.

**The one-directional security rule: app-influenced strings must only be
renderable through the app-voice constructor; the reverse direction
(visor text accidentally styled as a plate) is ugly but not dangerous.**

That asymmetry is why app voice is enforced by CONSTRUCTION rather than
by style review. `foreignToken()` in `ui/visor.ts` is the only door: the
single site in the codebase that assigns the `foreign` class (its thin
wrapper `nicknameQuote()` goes through it too). Invariant (h) of
`demo/scripts/check-invariants.sh` pins both halves — zero
hand-written `foreign` class assignments in consumer host code and in
the rest of `visor/ui/`, and exactly one inside `ui/visor.ts`.

**Announcements are framework voice.** `Visor.announce()` and the
`AnnounceSink` of `ui/pairing.ts` take a flat string, so they cannot
carry class marking at all. An announcement therefore speaks in the
visor's own voice and may embed user-voice words inline (a petname, a
device word); an app-influenced string must never be passed to one,
because it would land on the anchor's own line indistinguishable from
the visor's words. A fact about a component is announced by describing
it in the visor's vocabulary. Concretely: a component is referred to by
the user's word for it — its petname, clamped at 40 — or described
without naming when there is no petname; its provenance key and its
nickname never ride an announcement.

**The three voices are marked in pixels — and a screen reader has
none.** AT linearizes the page: app-frame text and visor text arrive in
one undifferentiated stream, the plate and the weight and the quoting
are gone, and iframe boundaries are not announced at all. An app can
therefore render, inside its own rectangle, a sentence that *sounds*
exactly like the visor speaking. The answer is the **audible anchor
word** (`ui/words.ts`): a word rolled once per identity by the same
`claim()` that rolls the hue, from the EFF short wordlist 2.0 (chosen
for phonetic distinctness) minus the visor's own spoken vocabulary. It
prefixes every drawer lifecycle sentence the host speaks — "«word»:
storage picker open", `closed`, `back` — with everything after the
colon coming from `DrawerTenantSpec.spoken`, framework vocabulary fixed
at registration and subject to the same one-directional rule as
`announce()`. Before the claim there is no word yet and the prefix is
the literal "visor", which is the honest sentence for a `deferClaim`
embedder whose unseal picker lives in the drawer.

**The channel decision: `speak()`, never `announce()`, and never
pixels.** These sentences go only to the visually-hidden `#visor-live`
region. Not `announce()`, because that spends the strip's bottom line,
and a lifecycle sentence at every sheet transition would steal the
visual line from the context it is meant to be holding. And never
rendered at all — not in a sheet, not in a `title`, not in an
`aria-label` — because pixels travel: a screenshot, a recording or a
screen-share hands a drawn word straight to whoever is watching, and an
app that learns the word can wear it. That is enforced structurally
rather than by convention: there is deliberately **no getter** for the
word on the `Visor` interface (contrast `committedHue()`, which exists
because consumers must paint with it). `speakWord()` and `rerollWord()`
are the only doors, and both end in the live region. Audio capture and
shoulder-listening remain accepted residual leaks; `rerollWord()` is
the remedy. `speak()` is a FIFO queue with a short dwell so that two
sentences emitted in one synchronous block — a close that resumes the
sheet underneath — both survive.

**Pet icons are user voice by construction**, which is why they carry no
marker of their own: a glyph reaches the strip or a sheet only after the
user adopted it in the naming ceremony. A component may *nominate* a
glyph, and a merely nominated glyph is never rendered outside that
ceremony's picker — where it is dashed (it is a button, so a border is
honest), plated with the app-voice background and inset shadow, and
introduced by an app-voice attribution line ("it asks to wear <q>…</q>").
Adoption is the user's act, and it converts the glyph from app voice to
user voice.
