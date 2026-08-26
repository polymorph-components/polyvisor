// The visor's SYSTEM UI: the strip, the identity cluster, the context
// cluster, and the drawer that unfolds above the strip.
//
// This is the framework layer, extracted whole out of the demo spike
// (demo/host/demo.ts) so a second spike can consume the same
// anchor rather than reimplement one. What lives here is everything a
// visor IS — the anchor colour, the identity record, the two-line
// context, the announce discipline, and the drawer host with its
// tenancy, arming delay and height budget. What does NOT live here is
// any particular sheet's CONTENT: a consumer registers a tenant and
// builds its own sheet, and the host does the rest.
//
// SCOPING DISCIPLINE, which is the whole security argument of this file:
// nothing here is ever written to the document root, handed to a guest,
// or put on the frame seam. The anchor colour is set on the visor's own
// ELEMENTS; the identity record is rendered only into visor pixels. See
// demo/scripts/check-invariants.sh checks (b), (c) and (e), which
// grep this file for exactly that.
//
// PER-INSTANCE STATE. Every mutable value below lives on the object
// `initVisor` returns; the module holds only constants. Two visors in
// two documents therefore cannot collide.

// The anchor colour's AUDIBLE TWIN lives next door, in its own module,
// because it is 1296 lines of borrowed wordlist and one roll helper —
// but it is the same idea on the other channel, and visor.ts is the only
// file that ever reads it. See words.ts's header for the threat (screen
// readers linearise the page, so the three voices are marked in pixels
// and silent in speech) and for what the word deliberately is NOT.
import { loadVisorWord, rollVisorWord } from "./words.ts";

// --- visor appearance: the personal, undisclosed anchor -----------------------
//
// The strip's colour is the user's own: RANDOMISED on first run, pickable
// from a constrained palette, and never handed to app code. It is a
// SECONDARY anchor — position is the primary one (apps cannot paint the
// strip at all) — and it is deliberately NOT the dropped #22
// personalization secret: it demands no user action at a decision point
// and no per-prompt verification, so it fails toward "something looks
// off" rather than "I forgot to check".
//
// Why the palette is constrained: fixed lightness and chroma in OKLCH
// means every choice keeps the same text contrast, so the anchor can
// never be customised into an unreadable or a look-alike state.
//
// Why apps cannot learn it: nothing in the surface API carries a colour;
// the app rectangle is opaque so visor pixels and app pixels never
// composite (blend/backdrop-filter pixel-stealing has nothing to
// sample); and the framework's curated DOM must additionally withhold
// blend modes, backdrop filters, CSSOM read-back and system-colour
// keywords — see the #5 ruling table. The demo enforces the structural
// half: this value is never passed to a guest, and the component tint
// is derived from component bytes instead.
export const VISOR_HUES = [265, 210, 175, 140, 95, 60, 35, 10, 330, 300];

/** Read the committed anchor hue, or roll a fresh one.
 *
 * `legacyKey`, when given, is a RENAME-ONLY migration source (chrome ->
 * visor, GitHub issue #22): it is read once and then removed, never
 * re-created. The palette is the framework's; the KEYS are the
 * consumer's, so two spikes on one origin do not share an anchor. */
export function loadVisorHue(
  hueKey: string,
  legacyKey?: string,
): { hue: number; fresh: boolean } {
  try {
    // One-time migration: carry an existing user's hue to the new key
    // without a re-roll (see the no-quiet-reset note below), then drop
    // the old key so this runs at most once per device.
    if (legacyKey !== undefined) {
      if (localStorage.getItem(hueKey) === null) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy !== null) localStorage.setItem(hueKey, legacy);
      }
      localStorage.removeItem(legacyKey);
    }
    const raw = localStorage.getItem(hueKey);
    if (raw !== null) {
      const hue = Number(raw);
      if (VISOR_HUES.includes(hue)) return { hue, fresh: false };
    }
  } catch { /* storage unavailable: fall through to a fresh pick */ }
  // First run (or eviction). A silently-reset anchor would train users
  // that "visor colour changes sometimes", which inverts the training —
  // so a reset is ANNOUNCED, never quiet. In the framework this value
  // belongs with durable device state (#11's identity bundle).
  const hue = VISOR_HUES[Math.floor(Math.random() * VISOR_HUES.length)];
  try {
    localStorage.setItem(hueKey, String(hue));
  } catch { /* nothing durable to write to */ }
  return { hue, fresh: true };
}

/** Paint the anchor colour.
 *
 * Scoped to the strip ELEMENT and to the drawer (the only other surface
 * the visor paints in the user's own colour), never to :root. A custom
 * property on the document root is ambient authority: it inherits into
 * every app region, so a component that ever gained a `style` attribute
 * (or a visor class resolving var(--visor-bg)) could paint the visor's
 * exact colour without ever reading it. Keeping the value out of scope
 * makes the secrecy structural instead of a property of the allowlist. */
export function applyVisorHue(hue: number) {
  for (const id of ["visor-strip", "visor-drawer"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.setProperty("--visor-bg", `oklch(38% .07 ${hue})`);
    el.style.setProperty("--visor-fg", "#f4f6fc");
  }
}

// --- the identity record: the user's own words, in the visor's voice -------------
//
// The user's name for themselves, their word for THIS DEVICE, and the
// glyph they chose for the visor's own button. All three are user-typed or
// user-picked, and all three obey exactly the scoping discipline the
// anchor colour obeys: they are rendered ONLY in visor pixels (the
// strip and the sheets that hang off it), never written to a :root
// custom property, never passed to a panel, an engine, or across the
// frame seam. Nothing in the surface API can carry them, and the
// invariant check (e) in demo/scripts/check-invariants.sh keeps
// it that way by grepping the seam files.
//
// Why this is worth anything: it gives the anchor a second thing an
// impersonating rectangle cannot reproduce. Position is primary, the
// colour is secondary, and these are words an app can only guess at.
//
// NO FABRICATION. An unset field renders NOTHING — never "user", never
// "this device". A default visor invented would be a word the visor says
// in its own voice that the user never wrote, which is the same
// authority-lending mistake the petname/nickname split exists to
// prevent.

/** THE CORE of the user's own vocabulary, and the source of the default.
 * `VISOR_ICONS` — the set actually offered and validated against — is
 * this followed by the whole pet-icon vocabulary, and is declared below
 * `APP_MARK_ICONS` because it is built from it. Order matters here: the
 * shield is [0] and therefore `DEFAULT_ICON`. */
const VISOR_ICON_CORE = ["⛨", "✶", "✦", "◆", "▲", "☘", "⚑", "✿", "☾", "⚙"];
export const DEFAULT_ICON = VISOR_ICON_CORE[0];

// --- the pet icons: the user's recognition mark for a COMPONENT ---------------
//
// WHAT REPLACED THE COLOUR SWATCH, and why (#22 discussion). A surface
// mark used to be a hue out of the anchor palette, shown as a small chip
// beside the component's quoted nickname. That device is gone. The
// ANCHOR colour stays exactly as it was — it is doing a different job
// (visor-vs-app contrast, plus a spoof lottery an impersonator has to
// win) — but per-app colour MEMORY was the weak half: "the blue one" is
// not a thing a user can name, rehearse, or check, and ten hues run out
// after ten components. A glyph is nameable ("the little envelope"),
// discriminable at a glance, and the vocabulary is large enough to keep
// local uniqueness real.
//
// THE CURATION CRITERIA ARE INVARIANTS, not taste. Every member of this
// array satisfies all of them, and a candidate that fails any one is
// out — there is no "but it looks nice" exception, because each rule is
// closing a concrete failure:
//
//   (1) ONE Unicode scalar, in the BMP. Not a sequence, not a
//       surrogate pair, not a ZWJ join. `isAppMarkIcon` can then decide
//       membership by exact string equality against a fixed list, and a
//       mark is a fixed-width thing at every render site.
//
//   (2) TEXT PRESENTATION BY DEFAULT (Emoji_Presentation=No, UTS #51).
//       A glyph that renders as full-colour emoji by default is a
//       PICTURE the platform draws, in colours the visor did not choose,
//       with a shape that changes between OS versions and vendors — a
//       recognition device the user has to re-learn on a new device is
//       not a recognition device. It also composites badly against the
//       anchor colour. So ☕ U+2615, ⌛ U+231B, ⚡ U+26A1 and ⚓ U+2693
//       are DISQUALIFIED however apt they look; the members below all
//       need a VS16 they will never be given to go colour.
//
//   (3) LONG LEGACY FONT COVERAGE. Preference for Geometric Shapes,
//       Miscellaneous Symbols and Dingbats, and for codepoints that
//       existed by Unicode 5.2 — a mark that renders as a tofu box on
//       somebody's machine is worse than no mark, because two different
//       components then wear the same empty rectangle.
//
//   (4) ONE GLYPH PER VISUAL-CONFUSABILITY CLASS, and NO class overlap
//       with VISOR_ICON_CORE (the ten glyphs the visor's own button
//       shipped with). Marks exist to be told apart at 14px in
//       peripheral vision, so near-duplicates are worse than useless.
//       Since that core spans shields, stars, diamonds, triangles,
//       clovers, flags, flowers, moons and gears, there are NO stars,
//       shields, diamonds, triangles, clovers/clubs, flags, flowers,
//       moons or gears here AT ALL — which is why the obvious ☀ ❄ ☄ ⚜ ♠
//       are absent (sun/snowflake/comet read as stars; fleur-de-lis as a
//       flower; the spade as a clover).
//
//       WHAT THIS RULE IS NO LONGER DOING: it used to be half of a
//       claim that the user's set and the app-nominable set were
//       DISJOINT, so that a component could never wear a glyph the visor
//       wears. That claim is gone by decision — the user may now pick
//       their own glyph from this whole vocabulary as well (see
//       `VISOR_ICONS` below), so the two sets deliberately overlap. What
//       distinguishes "me" from "it" is POSITION — the identity cluster
//       on the strip's right versus the context cluster on its left,
//       and no component can draw in either — and SHAPE: the user's
//       glyph is rendered in a CIRCLE (the avatar convention), a
//       component's mark never is. Set membership was never doing that
//       work as well as position does, and it cost the user nine tenths
//       of the vetted vocabulary.
//
//   (5) NO SECURITY OR UI SEMANTICS: no locks, keys, chains, warning
//       signs, check or cross marks, arrows. The visor must never appear
//       to be VOUCHING for a component, and a padlock beside a name is
//       exactly that claim — made in the visor's pixels, about a
//       component, on the user's own authority. THIS RULE IS ASYMMETRIC
//       and stays that way: it binds the APP-nominable set only. The
//       user's own set may hold security-semantic glyphs — ⛨ always did
//       — because a user awarding themselves a shield is a statement
//       about themselves, on their own authority, in the cluster that is
//       theirs. An app wearing one would be a claim about the app, made
//       by the app, in the visor's pixels. Invariant (g)/[7/8] in
//       demo/scripts/check-invariants.sh pins the app half. (Also no religious or
//       political symbols: a mark is a label, and the visor does not put
//       words in the user's mouth. ☯ went out on this rule.)
//
//   (6) FILLED SILHOUETTES PREFERRED. Outline glyphs lose their
//       interior detail first as size drops.
//
// Local uniqueness is what the SIZE buys: the naming ceremony only ever
// offers icons no other record holds, so two components on this device
// never wear the same mark while the vocabulary lasts.
export const APP_MARK_ICONS: readonly string[] = [
  // Geometric Shapes — the two plainest silhouettes there are.
  "●", // U+25CF BLACK CIRCLE
  "■", // U+25A0 BLACK SQUARE
  // Miscellaneous Technical / Symbols — everyday objects.
  "⌂", // U+2302 HOUSE
  "⌨", // U+2328 KEYBOARD
  "☎", // U+260E BLACK TELEPHONE
  "☁", // U+2601 CLOUD
  "☂", // U+2602 UMBRELLA
  "☃", // U+2603 SNOWMAN  (NOT ⛄ U+26C4, which is Emoji_Presentation=Yes)
  "☻", // U+263B BLACK SMILING FACE
  "♥", // U+2665 BLACK HEART SUIT  (NOT ❤ + VS16)
  "♨", // U+2668 HOT SPRINGS
  "♪", // U+266A EIGHTH NOTE
  "⚒", // U+2692 HAMMER AND PICK
  "⛏", // U+26CF PICK
  "⚖", // U+2696 SCALES
  "⚗", // U+2697 ALEMBIC
  "⚛", // U+269B ATOM SYMBOL
  "⚄", // U+2684 DIE FACE-5
  // Chess pieces: five silhouettes that stay distinct when small.
  "♛", // U+265B BLACK CHESS QUEEN
  "♜", // U+265C BLACK CHESS ROOK
  "♝", // U+265D BLACK CHESS BISHOP
  "♞", // U+265E BLACK CHESS KNIGHT
  "♟", // U+265F BLACK CHESS PAWN
  // Dingbats — the old, well-covered end of the block.
  "✂", // U+2702 BLACK SCISSORS
  "✇", // U+2707 TAPE DRIVE
  "✈", // U+2708 AIRPLANE
  "✉", // U+2709 ENVELOPE
  "✎", // U+270E LOWER RIGHT PENCIL
];

/** THE USER'S OWN VOCABULARY — the glyph on the visor's own button.
 *
 * The button face is THE VISOR'S VOCABULARY, not free text. The record
 * lives in localStorage, so it is hand-editable; if the face were an
 * arbitrary string, a record edited to say "Verified" or "polymorph"
 * would put attacker- (or accident-) chosen WORDS into the anchor, in
 * the visor's own voice, at the one position that is supposed to be
 * unspoofable. A fixed glyph set has no such reading: anything outside
 * it falls back to the default shield.
 *
 * IT IS THE WIDE SET: the ten the button shipped with, in their original
 * order (so ⛨ is still [0] and still `DEFAULT_ICON`), followed by every
 * pet icon not already among them. The vetting is not loosened by this —
 * every added glyph already passed the six criteria above, which are
 * strictly stronger than anything the button needs. What is loosened is
 * the CHOICE: the user picks from the whole vetted vocabulary rather
 * than from ten.
 *
 * A SUPERSET IS BACKWARD-COMPATIBLE BY CONSTRUCTION. `loadIdentity`,
 * `saveIdentity` and `identityIcon` all validate by membership here, so
 * every record valid under the old ten is still valid, and nothing
 * stored can be invalidated by growing the set.
 *
 * The reverse direction is NOT symmetric: this set may contain
 * security-semantic glyphs (⛨ does), and `APP_MARK_ICONS` may not — see
 * criterion (5). "Me" and "it" are told apart by position (identity
 * cluster vs context cluster) and by shape (the user's glyph is drawn in
 * a circle), not by set membership. */
export const VISOR_ICONS: readonly string[] = [
  ...VISOR_ICON_CORE,
  ...APP_MARK_ICONS.filter((g) => !VISOR_ICON_CORE.includes(g)),
];

/** THE VALIDATION GATE for every pet icon that did not come out of
 * `APP_MARK_ICONS` itself — and that is every interesting one.
 *
 * This is the bidi/ZWJ/confusable FIREWALL, and it is a membership test
 * rather than a sanitiser on purpose. A pet icon can arrive from three
 * places the visor does not control: a component's own NOMINATION (see
 * `SurfaceIdentity.nomination` — an app asking to wear a particular
 * glyph), a mark SYNCED from the user-system partition (written by
 * another device, possibly a different visor build), and a trust record
 * HAND-EDITED in devtools. Each of those is an attacker-influenceable
 * string in the visor's own pixels, at the position that is supposed to
 * be unspoofable, so the interesting inputs are not typos:
 *
 *   - RTL overrides and other bidi controls (U+202E and friends), which
 *     reorder the text AROUND the mark and can make a foreign-quoted
 *     nickname read as though it were in the visor's voice;
 *   - ZWJ sequences and variation selectors, which turn several
 *     codepoints into one rendered picture — including a colour emoji
 *     the curation rules exclude, arrived at by composition;
 *   - combining marks, which stack arbitrary ink onto a neighbour;
 *   - homoglyphs of the visor's own button core (`VISOR_ICON_CORE`),
 *     which is the component impersonating the visor's button. (The
 *     user's full vocabulary is a SUPERSET of this list now, so a
 *     nominated glyph may legitimately be one the user could also wear
 *     — what a component still cannot do is reach the identity cluster,
 *     or be drawn in the round "me" shape.)
 *   - anything long enough to stretch the strip.
 *
 * Trying to enumerate those is a losing game. Membership in a fixed,
 * hand-vetted list of single BMP scalars refuses all of them at once,
 * including the ones nobody has thought of yet — and it degrades safely:
 * a mark that fails renders as NO ICON ANYWHERE (never as a placeholder,
 * never as the raw string), so the worst outcome is a surface the user
 * has not marked yet, which is a state the visor already handles
 * honestly.
 *
 * CALL IT AT THE SEAM, not at the render site. A consumer reading a
 * component's nomination validates it the moment it crosses (see
 * demo/host/demo.ts's `mark-nomination` read, and invariant (g)
 * in demo/scripts/check-invariants.sh, which greps for exactly
 * that adjacency): an invalid string must never reach a render path at
 * all, not even the picker's. */
export function isAppMarkIcon(s: string): boolean {
  return APP_MARK_ICONS.includes(s);
}

/** One pet icon, rendered. Returns null for the unmarked case — an
 * empty string, an absent value, or anything `isAppMarkIcon` refuses —
 * so a caller appends nothing rather than a blank slot.
 *
 * NO FABRICATION, the same rule the identity record follows: an
 * unmarked surface gets NO glyph. The visor does not invent a mark for a
 * component the user has never named; the strip simply says nothing
 * before the user has said anything. */
export function markIcon(icon: string | undefined): HTMLElement | null {
  if (icon === undefined || !isAppMarkIcon(icon)) return null;
  const el = document.createElement("span");
  el.className = "mark-icon";
  el.textContent = icon;
  return el;
}

/** Cap for the user's own words on the strip. CSS ellipsis handles the
 * visual overflow; this stops a hand-edited record from being long
 * enough to matter in the first place. */
export const IDENTITY_MAX = 24;

export interface VisorIdentity {
  name?: string;
  device?: string;
  icon?: string;
}

export function loadIdentity(identityKey: string): VisorIdentity {
  try {
    const raw = JSON.parse(localStorage.getItem(identityKey) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const rec = raw as Record<string, unknown>;
    const word = (v: unknown) =>
      typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, IDENTITY_MAX) : undefined;
    return {
      name: word(rec.name),
      device: word(rec.device),
      // Out-of-vocabulary icons are dropped here rather than rendered;
      // `identityIcon` supplies the default.
      icon: typeof rec.icon === "string" && VISOR_ICONS.includes(rec.icon) ? rec.icon : undefined,
    };
  } catch {
    return {};
  }
}

export function saveIdentity(identityKey: string, rec: VisorIdentity): void {
  // Empty fields are stored as ABSENT, not as "": unset must round-trip
  // as unset, so the strip keeps rendering nothing for them.
  const out: VisorIdentity = {};
  if (rec.name && rec.name.trim() !== "") out.name = rec.name.trim().slice(0, IDENTITY_MAX);
  if (rec.device && rec.device.trim() !== "") out.device = rec.device.trim().slice(0, IDENTITY_MAX);
  if (rec.icon && VISOR_ICONS.includes(rec.icon)) out.icon = rec.icon;
  try {
    localStorage.setItem(identityKey, JSON.stringify(out));
  } catch { /* nothing durable to write to */ }
}

// --- the event record (#132) --------------------------------------------------

/** ONE THING THAT HAPPENED, kept after the line that said it expired.
 *
 * `text` is exactly what an announcement said — a FLAT STRING under
 * `announce`'s three-voices policy (framework voice, user-voice words
 * admissible inline, an app-influenced string never), which is what lets
 * the list render it with no dressing at all. `at` is wall-clock
 * milliseconds, used only to sort and to word a coarse age; nothing here
 * is a clock the user is asked to trust. */
export interface VisorEvent {
  at: number;
  text: string;
}

/** How many records the visor keeps. The list is a RECENT-EVENTS list,
 * not a log: past a screenful or two nobody scrolls, and an unbounded
 * array in localStorage is a slow leak on the one storage the visor owns
 * on this device. Oldest drops first — the newest news is the news. */
export const EVENTS_MAX = 50;

/** The persisted shape at `VisorConfig.eventsKey`: the records, plus the
 * watermark that says which of them have been seen. Both halves in ONE
 * key, because they are one fact — a seen-mark without its records is
 * meaningless, and records without their mark would re-light the badge on
 * every boot. */
interface EventRecord {
  seenAt: number;
  events: VisorEvent[];
}

/** Read the record, TOLERANTLY. Missing, unparseable or hand-mangled all
 * answer the same way — an empty record — for the same reason
 * `loadIdentity` does: this is hand-editable storage, and a visor that
 * threw on boot because a string in localStorage was not JSON would be
 * bricked by a devtools typo. A corrupt record loses history; it must
 * never lose the visor. */
export function loadEvents(eventsKey: string): EventRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(eventsKey) ?? "{}");
    if (!raw || typeof raw !== "object") return { seenAt: 0, events: [] };
    const rec = raw as Record<string, unknown>;
    const list = Array.isArray(rec.events) ? rec.events : [];
    const events: VisorEvent[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      // Both fields or neither: a record with no text is a badge with
      // nothing behind it, which is the one failure the badge cannot
      // afford (see the events sheet's empty state).
      if (typeof e.text !== "string" || e.text === "") continue;
      if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      events.push({ at: e.at, text: e.text });
    }
    const seenAt = typeof rec.seenAt === "number" && Number.isFinite(rec.seenAt) ? rec.seenAt : 0;
    return { seenAt, events: events.slice(-EVENTS_MAX) };
  } catch {
    return { seenAt: 0, events: [] };
  }
}

/** The glyph the visor's own button wears. Unknown/absent → the default
 * shield (see VISOR_ICONS). */
export function identityIcon(rec: VisorIdentity): string {
  return rec.icon && VISOR_ICONS.includes(rec.icon) ? rec.icon : DEFAULT_ICON;
}

// --- what the visor knows about a surface, and what it shows ------------------

/** What the visor knows about one component surface. `name` is the
 * unforgeable provenance key the visor fetched the artifact by; `nickname`
 * is what the component says about itself; `petname` is what the user
 * decided to call it. Only the last of the three is ever spoken in
 * the visor's own voice. */
export interface SurfaceIdentity {
  name: string;
  nickname: string;
  /** THE PET ICON: the user's own recognition mark for this component,
   * chosen in the naming ceremony from `APP_MARK_ICONS`. "" = UNMARKED,
   * and unmarked renders as nothing at all (see `markIcon`) — the visor
   * says nothing in its own voice about a component the user has not
   * spoken about yet. Replaces the mark hue and its colour chip (#22
   * discussion): the anchor colour keeps its job, per-app colour memory
   * was never doing one. */
  icon: string;
  isNew: boolean;
  petname?: string;
  /** WHAT THIS COMPONENT ASKED TO WEAR — a glyph the component itself
   * nominated (`mark-nomination` in the demo's WIT). PRE-VALIDATED
   * VISOR-SIDE: a consumer puts a value here only after `isAppMarkIcon`
   * has accepted it at the seam, so nothing downstream re-checks and
   * nothing downstream may assume it is unclaimed — the ceremony still
   * drops it if another record already wears it.
   *
   * It is NEVER a key, never rendered in the visor's own voice, and
   * appears in exactly one place: the naming ceremony's picker, first,
   * foreign-attributed. The component is never told the outcome. */
  nomination?: string;
  /** When the visor first assigned this record its mark, from the stored
   * trust record. Shown on the App settings sheet as a locale date — a
   * "you have seen this before, since <date>" the user can check. */
  firstSeen?: number;
  /** One line of visor-known metadata about this surface, for the App
   * settings sheet. `label` is THE VISOR'S word (never a component's);
   * `value` may be component-influenced (a panel's declared
   * destination), so the sheet renders it in APP VOICE — through
   * `foreignToken`, quoted, monospaced and plated. `foreign` says
   * which. */
  meta?: { label: string; value: string; foreign: boolean };
}

/** WHAT THE STRIP'S BACK CHEVRON DOES, and what it is called. `label` is
 * THE VISOR'S OWN WORDING for the return, used as the control's `title`
 * and `aria-label` (never rendered as text beside the glyph — the strip
 * has no room for a word there, and the glyph is the affordance). It may
 * embed USER-voice vocabulary such as a petname, exactly as an
 * announcement may; it must never carry an app-influenced string, which
 * could not be plated in an attribute. */
export interface BackAction {
  onBack: () => void;
  label?: string;
}

/** The visor's context slot: what secondary surface, if any, is on screen.
 * Called with null for "no secondary surface" — which is no longer
 * "nothing": the strip falls back to THE APP's own identity, the
 * artifact the visor fetched and drew into the three regions. `kind` says
 * whose pixels the secondary surface is: a component's config panel,
 * the visor's own credential sheet, the visor's own naming/App-settings sheet,
 * the visor's own settings sheet, or the visor's own reset ceremony. The last
 * two have no component behind them at all, which is why they are bare
 * `kind`s rather than surfaces. */
export type VisorContext =
  | (SurfaceIdentity & { kind?: "panel" | "credentials" | "naming" | "storage" })
  | { kind: "settings" }
  // THE ERASE CEREMONY (sheets.ts's third sheet). Like "settings" it is
  // about the VISOR, not about any component, so it carries no surface —
  // and unlike "settings" it is a destructive act, which changes the
  // tenant's weight class (armed, dimmed) but not what the context means.
  | { kind: "reset" }
  // THE EVENT LIST (#132, sheets.ts's "recent events" tenant). A bare
  // kind for the same reason "settings" is: it is the visor telling the
  // user what has happened to their own account and devices, and no
  // component stands behind any of it.
  | { kind: "events" }
  // THE ENTRY CEREMONIES (entry.ts): the device picker and the first-run
  // fork. Bare kinds for the same reason "settings" and "reset" are —
  // there is no component behind either. The picker is the only context
  // that can be on the strip BEFORE the claim (see `deferClaim`), which
  // is exactly why it must be describable without a surface: at that
  // moment the visor knows nothing about the user and nothing about an
  // app, and the strip's honest answer is the name of the ceremony and
  // nothing else.
  | { kind: "device-picker" }
  | { kind: "first-run" }
  | null;

/** USER VOICE: the user's word for a component, in THE VISOR'S voice —
 * not quoted, not monospaced, full opacity, weight 600, because the user
 * wrote it and the visor is entitled to say it. Clamped anyway — the
 * naming sheet caps input at 40, but a record hand-edited in devtools
 * should not be able to stretch the strip. */
export function petnameSpan(petname: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "petname";
  el.textContent = petname.slice(0, 40);
  return el;
}

/** THE APP-VOICE CONSTRUCTOR — the only door in the visor through which
 * an app-influenced string reaches the screen.
 *
 * THREE VOICES (visor/README.md, visor/ui/visor.css's header): every
 * piece of content the visor renders belongs to exactly one provenance
 * class, and the class is visible.
 *
 *   - FRAMEWORK VOICE — the unmarked baseline: the visor's own headings,
 *     labels, hints, `.said` commentary, announcements, SAS digits,
 *     pairing codes, the `.fresh` badge. No marker; it is what the visor
 *     looks like.
 *   - USER VOICE — the user's own vocabulary spoken by the visor:
 *     `.petname`, `.who` (`.who.device` as its quieter half), and pet
 *     icons, which are user voice BY CONSTRUCTION (a nominated glyph is
 *     never rendered outside the naming ceremony's picker) and therefore
 *     carry no extra marker. Weight 600, full opacity, never quoted,
 *     never monospace. NOT italics: CJK has only synthetic oblique,
 *     Arabic has no italics at all, 12px italic legibility is poor, and
 *     italics read as quotation — the wrong connotation for the one
 *     voice that is not being quoted.
 *   - APP VOICE — component-influenced strings: quoted, monospaced,
 *     textually attributed, and PLATED (a recessed background so they
 *     read as embedded tokens rather than as words in the visor's own
 *     sentence). This function, and only this function, assigns the
 *     `foreign` class that carries all of it.
 *
 * THE ONE-DIRECTIONAL SECURITY RULE: app-influenced strings must only be
 * renderable through the app-voice constructor; the reverse direction
 * (visor text accidentally styled as a plate) is ugly but not dangerous.
 * That asymmetry is why the enforcement is a construction funnel rather
 * than a style audit, and why invariant (h) in
 * demo/scripts/check-invariants.sh pins the `foreign`
 * class-assignment count in this file at exactly one.
 *
 * `maxLen` clamps at the render site (defaults to 40, the petname cap);
 * `quoted` picks the element kind — a `<q>` renders quote marks around
 * the text and is the default, `{ quoted: false }` gives a plain span for
 * a site whose surrounding sentence already supplies the punctuation. */
export function foreignToken(
  text: string,
  { maxLen = 40, quoted = true }: { maxLen?: number; quoted?: boolean } = {},
): HTMLElement {
  const el = document.createElement(quoted ? "q" : "span");
  el.className = "foreign";
  el.textContent = text.slice(0, maxLen);
  return el;
}

/** The component's own account of itself, always app voice: quoted,
 * monospaced, plated, clamped, never joined into a visor sentence. A
 * named wrapper over `foreignToken` because "what it calls itself" is
 * the most-repeated app-voice site in the UI and deserves to read as
 * itself at the call sites. */
export function nicknameQuote(nickname: string): HTMLElement {
  return foreignToken(nickname, { maxLen: 40 });
}

// --- the drawer host's timing ------------------------------------------------

/** The arming delay, ported from the todomvc visor spike
 * (spikes/todomvc/host/visor.ts:18): controls and inputs stay disabled
 * until it elapses, which defeats a baited mis-tap — an app training
 * rapid taps at a position where a visor control is about to appear.
 * The TIMER is the enforcement; the slide is only its visible form, so
 * prefers-reduced-motion drops the animation and never the delay.
 *
 * It is ALSO the deferred-teardown delay: a close animates for this long,
 * so the drawer is only blanked after it (and only if no other tenant
 * claimed it meanwhile — see `occupied`). */
export const ARM_MS = 700;

// --- the drawer host ----------------------------------------------------------

/** One sheet, as a tenant builds it. The host owns the drawer's geometry,
 * arming and teardown; this is the tenant's half of the contract. */
export interface DrawerSheet {
  /** The sheet's root element; the host mounts exactly this. */
  root: HTMLElement;
  /** Controls to hold disabled until the arming delay elapses. Ignored
   * for a tenant that is not `armed`. */
  controls?: Array<HTMLButtonElement | HTMLInputElement>;
  /** Run when the arming delay elapses, after the controls are enabled
   * and before `.armed` lands on the root. Only the still-current
   * session ever reaches this. */
  onArmed?: () => void;
  /** Run once the reveal animation has been started — where a sheet
   * takes focus, IF it should: only when typing into one specific input
   * is the interaction the user asked for (the naming sheet), never
   * merely because the sheet contains inputs — on mobile an autofocused
   * input raises the keyboard over the drawer it belongs to. */
  onShown?: () => void;
}

/** Close options every tenant understands, plus whatever the tenant's own
 * hooks read off it (the demo's settings sheet reads `commit`). */
export interface DrawerCloseOptions {
  /** False = close WITHOUT touching the strip context, because the caller
   * is about to claim it. */
  context?: boolean;
  [key: string]: unknown;
}

export interface DrawerTenantSpec<S> {
  /** Diagnostic only; the host does not render it. */
  name: string;
  /** WHAT THIS SHEET IS CALLED OUT LOUD — the noun the drawer's
   * lifecycle announcements put after the anchor word ("walrus: storage
   * picker open"). Lower-case, a short noun phrase, no punctuation and
   * no verb: the host supplies the verb.
   *
   * REQUIRED, and required rather than defaulted from `name` on purpose.
   * `name` is a diagnostic identifier ("add-device", "first-run"); this
   * is a sentence fragment a person hears. Defaulting would have shipped
   * hyphenated identifiers into a user's ear and nobody would have
   * noticed, because the people it fails are the people who cannot see
   * the sheet it mislabels.
   *
   * VOICE — THE SAME ONE-DIRECTIONAL RULE AS `announce`, and it binds
   * harder here because the string is baked in at registration. This is
   * FRAMEWORK VOICE. It may embed USER-voice words inline (the user's
   * own word for a device), because the user's vocabulary is already
   * something the visor may say in its own sentence. An APP-INFLUENCED
   * string must NEVER appear here: the announcement is a flat spoken
   * sentence, so there is no `foreignToken` to plate it with and no
   * marking a listener could hear — a component's nickname placed here
   * would arrive prefixed by the user's own anchor word, which is
   * precisely the provenance claim the word exists to make
   * unforgeable. Describe the sheet in the visor's vocabulary instead. */
  spoken: string;
  /** THE HIGHEST PRECEDENCE. An exclusive tenant is never evicted — every
   * other tenant's `open` refuses while it holds the drawer — and its own
   * open evicts everything else. In the demo this is the credential
   * sheet: a sheet that is collecting (or about to accept) secrets is
   * never displaced by a convenience. */
  exclusive?: boolean;
  /** Apply the arming delay (see ARM_MS). The LIGHTWEIGHT tenants do not:
   * arming defends SECRET ENTRY against a baited mis-tap, and paying the
   * tax where nothing secret is typed would train users to click through
   * a delay that means something elsewhere. */
  armed?: boolean;
  /** Dim and freeze the page behind the sheet (the host owns #visor-dim;
   * freezing whatever else the consumer runs is `beforeShow`/
   * `afterCollapse` work).
   *
   * A PREDICATE when the answer depends on what is on screen. The
   * lightweight ceremonies dim NOTHING at home — nothing secret is typed
   * there and the tax would be noise — but the same ceremony opened over
   * a consumer's NESTED PLACE (the demo's provider-config page) must
   * bracket it: the place dims and goes inert for the ceremony's
   * duration, which closes the interleaving where a live component
   * solicits input while a visor ceremony is on screen. The resolved
   * value is REMEMBERED for the close, so a predicate that flips while
   * the sheet is up still undoes exactly what the open did. */
  dim?: boolean | ((session: S) => boolean);
  /** MAY THIS TENANT BE SUSPENDED RATHER THAN CLOSED when another one
   * opens over it? Undefined = the ordinary rule (an opening tenant
   * evicts every other one).
   *
   * A suspended tenant keeps its SESSION and loses only the drawer: it
   * slides out to the left, waits, and slides back from the left when
   * the tenant that displaced it closes. This is not stacking — "one
   * expanded occupant at a time" stays literally true — but it stops a
   * ceremony the user is in the middle of from being silently destroyed
   * by a ceremony they start from the strip. The demo suspends its
   * storage picker while it is collapsed to a band (a breadcrumb during
   * a configuration detour) and not while it is expanded, where ordinary
   * eviction is what a user would expect. */
  suspendable?: (session: S) => boolean;
  /** The strip context this tenant claims while it holds the drawer. Also
   * what `restoreContext` recomputes from. */
  context: (session: S) => VisorContext;
  /** Before the drawer is revealed (the demo pauses every runner here, so
   * no component code is live while a secret is on screen). */
  beforeShow?: (session: S) => void;
  /** After the session is dropped and the resize listener removed, before
   * the sheet collapses (the demo's settings sheet reverts its live
   * colour preview here — an uncommitted preview must not survive the
   * sheet). */
  beforeCollapse?: (session: S, opts: DrawerCloseOptions) => void;
  /** After the collapse and the un-dim, before the context is restored
   * (the demo resumes its runners here). */
  afterCollapse?: (session: S, opts: DrawerCloseOptions) => void;
  /** After the context has been restored (the demo drops its held
   * credentials here — the visor keeps nothing after the interaction it
   * collected them for is over). */
  afterRestore?: (session: S, opts: DrawerCloseOptions) => void;
}

export interface DrawerTenant<S> {
  readonly name: string;
  isOpen(): boolean;
  session(): S | null;
  /** The still-the-current-session guard every deferred handler needs. */
  owns(session: S): boolean;
  /** Take (or drop) the session WITHOUT any DOM work. The demo claims the
   * credential session before retiring the panel, so the panel's
   * retirement — and any late `close` event from the dialog — leaves the
   * held values alone. A subsequent `open` with the SAME session object
   * is then a reveal, not a re-entry. */
  claim(session: S | null): void;
  /** Reveal the sheet. Returns false when a higher-precedence tenant
   * holds the drawer (see `exclusive`), in which case nothing happened. */
  open(session: S, build: (session: S) => DrawerSheet): boolean;
  /** REBUILD THE SHEET FOR THE SAME SESSION, at whatever size its
   * builder now produces, animating the drawer from the current height
   * to the new one.
   *
   * It is how a sheet CHANGES SHAPE without ceasing to exist: the demo's
   * picker collapses to a band when it sends the user off to a config
   * page and re-expands when they come back, and it is the same ceremony
   * throughout — a close-and-reopen would drop the session, and with it
   * the answer to "what step of MY ceremony is this".
   *
   * Arming is PER PRESENTATION: a rebuilt sheet arms from zero, so a
   * control the user armed before a detour is not already armed when
   * they return. No-op while closed; a SUSPENDED tenant rebuilds when it
   * resumes, from the same builder, so this is a no-op there too. */
  rebuild(): void;
  /** Session alive, drawer held by somebody else (see `suspendable`). */
  isSuspended(): boolean;
  close(opts?: DrawerCloseOptions): void;
}

export interface DrawerHost {
  /** Register a tenant. REGISTRATION ORDER IS PRECEDENCE ORDER: it is the
   * order `restoreContext` consults, and the order evictions run in.
   * Adding a tenant is then one call instead of an audit of every timer
   * and every close path. */
  tenant<S>(spec: DrawerTenantSpec<S>): DrawerTenant<S>;
  /** ONE occupancy test for every tenant. Every deferred
   * `drawer.hidden = true` is gated on this rather than on the session
   * that scheduled it: the teardown is DRAWER-scoped work, so it must ask
   * about the drawer, not about one session. */
  occupied(): boolean;
  /** PUT THE STRIP BACK IN THE HANDS OF WHOEVER ACTUALLY OWNS IT NOW.
   *
   * The strip is the trust anchor, and its top line answers "whose
   * rectangle is this". Every path that ENDS something — a sheet
   * closing, a panel retiring — has to restore that line, and the naive
   * restore ("back to the app") is a lie whenever something else has
   * claimed the strip in the meantime. Since the ending paths are all
   * DEFERRED in one way or another (a close runs on an animation, a
   * retirement runs off a dialog event that at least one embedding
   * delivers late), "in the meantime" is not hypothetical.
   *
   * So no caller states what the context should become. Each one says
   * only "I am done", and the answer is recomputed HERE from what is
   * live: the consumer's `contextOverride` first (a live component
   * surface is the only tenant that is not the visor's own, which makes
   * mislabelling it the one error with a victim), then each registered
   * tenant in precedence order, then nothing. */
  restoreContext(): void;
  /** The open sheet's refusal line, in the visor's own words. A no-op
   * while no sheet has declared one. */
  note(text: string): void;
  /** Declare the element `note` writes into. Called by a tenant while it
   * builds its sheet; cleared by the host on close, so a note aimed at a
   * sheet that is gone cannot land in the next one. */
  setNote(el: HTMLElement | null): void;
}

// --- the visor instance -------------------------------------------------------

export interface VisorConfig {
  /** Where the committed anchor hue lives. */
  hueKey: string;
  /** Rename-only migration source, read once and removed. */
  legacyHueKey?: string;
  /** Where the committed anchor WORD lives — the audible twin of
   * `hueKey`, and REQUIRED for the same reason that one is: a visor
   * whose non-visual users have no provenance token is a visor with a
   * hole in exactly the population that cannot see the colour, and an
   * optional key would let an embedder ship that hole by omission.
   *
   * Its own key, not a field inside the identity record, so it obeys the
   * same per-embedder rule the hue does: two pages on one origin are two
   * devices and must not share a word. */
  wordKey: string;
  /** Where the identity record lives. */
  identityKey: string;
  /** Where the EVENT RECORD lives (#132) — the list behind the badge,
   * plus its seen-watermark, under one key.
   *
   * OPTIONAL, and what its absence means is "this session only", not
   * "off". The records still accumulate, the badge still lights, the
   * sheet still lists them; nothing survives the reload. That is the
   * honest degradation for an embedder that has not thought about where
   * this belongs (the todomvc spike), and it keeps the feature from
   * being a second thing a consumer can forget to turn on. A visor that
   * silently dropped the whole mechanism because a key was missing would
   * make announced-never-silent depend on configuration. */
  eventsKey?: string;
  /** THE APP'S OWN ROW IN THE TRUST TABLE — what the strip's top line
   * falls back to when no secondary surface is on screen. */
  appSurface?: () => SurfaceIdentity | null;
  /** Consulted FIRST by `restoreContext`: a live component surface, if
   * the consumer has one. Undefined/null = nothing claimed here. */
  contextOverride?: () => VisorContext | null | undefined;
  /** BOOT UNCLAIMED: build the whole visor EXCEPT the two things that
   * are the user's own — the anchor colour and the identity cluster.
   *
   * WHY A VISOR WOULD WANT THIS. A consumer whose boot passes through a
   * login (the solo page's device picker — runtime/PERSISTENCE.md's
   * "Unseal UX") may render nothing personal until the seal opens, and
   * the picker is itself trusted UI that has to live in the drawer:
   * identity/account/ceremony surfaces appear only in visor territory,
   * because the drawer's spatial mechanics — a sheet attached to the
   * pinned strip, the page dimmed around it — are the one thing a
   * component confined to its own rect cannot forge. Those two demands
   * used to be in tension (the strip had to exist for the picker, and
   * the strip painted a colour). This splits them: the SHELL boots
   * (strip, context, announce, drawer host, live region) wearing the
   * CSS's generic grey fallback dress, and `claim()` at unseal is when
   * colour and identity arrive together.
   *
   * Under it, `initVisor` reads no hue, writes no `--visor-bg`, and
   * renders no identity cluster — so `stripPersonal`-style assertions
   * ("nothing of the user's is on screen before the seal opens") hold
   * against the DOM and not merely against the page's own account of
   * itself. Default false: an ordinary embedder claims at boot. */
  deferClaim?: boolean;
}

/** Late-installed handlers for controls the STRIP renders. The strip is
 * built by `initVisor`, before a consumer's sheets exist, so the controls
 * it draws call through here. */
export interface VisorHandlers {
  /** The strip's "name it" control and its context cluster. */
  requestNaming?: (surface: SurfaceIdentity) => void;
  /** The strip's own settings button. */
  requestSettings?: () => void;
}

export interface Visor {
  /** True when this boot rolled a FRESH anchor colour — the consumer is
   * expected to announce it (a reset is announced, never quiet).
   *
   * FALSE WHILE UNCLAIMED (see `VisorConfig.deferClaim`): before the
   * claim no hue has been read or rolled at all, so there is no honest
   * "yes" to give. The real answer arrives with `claim()`. */
  readonly fresh: boolean;
  /** THE MOMENT THE VISOR BECOMES YOURS — the other half of
   * `deferClaim`. Reads (or rolls, and persists) the anchor hue, paints
   * it, and renders the identity cluster: colour, name, device and the
   * settings button all arrive in one frame, which is what makes
   * unseal-as-login legible rather than merely successful
   * (runtime/PERSISTENCE.md, "Unseal UX").
   *
   * IDEMPOTENT, and a no-op on a visor that was never deferred: a
   * consumer may call it unconditionally at its own "the seal opened"
   * point. The returned `fresh` is the same value `visor.fresh` reports
   * afterwards — the caller usually wants it right here, because the
   * announcement belongs to the claim. */
  claim(): { fresh: boolean };
  install(handlers: VisorHandlers): void;
  /** Move the context: a MOVE preempts any live announcement. */
  setContext(ctx: VisorContext): void;
  /** Repaint the CONTEXT cluster from whatever context is current —
   * for when something the current context is drawn from changes
   * underneath it (the app surface being registered at boot, for
   * instance) without the context itself moving. A mere repaint does NOT
   * preempt a live announcement. */
  renderContext(): void;
  /** Repaint the identity cluster from the stored record. */
  renderIdentity(): void;
  /** Say something in THE VISOR'S OWN VOICE on the strip's bottom line,
   * for `ms`, and then put the line back by RE-RENDERING the live
   * context.
   *
   * The re-render is the whole design of this helper. The obvious version
   * saves the line's previous content and restores it — which is wrong
   * here, because the thing the line is about can change while the
   * announcement is showing: a sheet opens or closes, a petname is
   * assigned, the context moves to another surface. Restoring a saved
   * string would then put a stale sentence back on the anchor, in the
   * visor's voice, which is the one place a wrong word costs something.
   *
   * ANNOUNCEMENT POLICY (the three voices, see `foreignToken`): this
   * takes a FLAT STRING, so it cannot carry class marking — an
   * announcement is therefore spoken entirely in FRAMEWORK VOICE, and
   * may embed USER-voice words inline (a petname, the user's word for a
   * device), because the user's vocabulary is already something the
   * visor is entitled to say in its own sentence. An APP-INFLUENCED
   * string must NEVER be passed here: there is no way to plate it, so it
   * would arrive on the anchor's own line indistinguishable from the
   * visor's words. A fact about a component is announced by DESCRIBING
   * it in the visor's vocabulary; the component's own string belongs on
   * a surface where `foreignToken` can dress it.
   *
   * SCREEN-READER MIRROR: the text is also written to the strip's
   * visually-hidden `#visor-live` region, so an announcement reaches
   * assistive tech and not only sighted users. */
  announce(text: string, ms?: number): void;
  /** THE VISOR POINTING AT ITS OWN CONTEXT LINES: a timed background
   * pulse on the context cluster, meaning "what you are looking at just
   * changed meaning — read me".
   *
   * It does NOT touch the lines' contents. That is the whole point, and
   * it is what a timed announcement could not do: an announcement takes
   * the bottom line away for its window, so the very content a user
   * should be reading at an arrival (the surface's plated nickname, the
   * NEW marker, the offer to name it) is hidden during exactly the
   * seconds it matters. Pure attention direction leaves the lines up and
   * says only "look here".
   *
   * VOICE: framework voice by construction, and trivially so — it
   * carries NO WORDS ON SCREEN, so there is no string to mark and
   * therefore no way for it to leak any voice class onto the anchor. Its
   * only text channel is `srText`, which goes ONLY to the visually-
   * hidden live region and is subject to the same policy as `announce`:
   * a flat string, framework voice, user-voice words allowed inline, an
   * app-influenced string never.
   *
   * Calling it during a live pulse RESTARTS the animation. */
  pulseContext(srText?: string): void;
  /** THE STRIP'S OWN WAY OUT of a nested place. Non-null renders a back
   * chevron at the strip's far left; null removes it entirely.
   *
   * WHY IT LIVES ON THE ANCHOR. A page's own Cancel button is visor
   * pixels by construction, but it sits in scrollable content — and an
   * app can paint a pixel-perfect copy of it inside its own rectangle,
   * so a user cannot tell the real exit from a decoy by looking. The
   * strip is the one region no component can draw in, which makes a
   * control here STRUCTURALLY unforgeable: the guarantee "you can always
   * leave through the bar" replaces the convention "the page offers a
   * cancel button". The browser's own Back does the same job but is
   * outside the visor's vocabulary — nothing on screen promises it, and
   * an embedded surface may not have it at all.
   *
   * IT IS ALSO THE ONLY PERSISTENT NESTING SIGNAL. The arrival cue is a
   * timed pulse (`pulseContext`) and the NEW badge is about naming;
   * without this, nothing on the anchor says "you are somewhere, not
   * home" for the whole stay.
   *
   * PAGES, NOT SHEETS. A drawer sheet is an overlay BRACKETED by the
   * strip, with its own dismissal and (for the credential sheet)
   * exclusive, armed semantics that must not gain a second cancel path.
   * The chevron marks PLACE nesting only, so a consumer sets it when it
   * navigates and clears it when it comes back — never around a sheet.
   *
   * SHEETS ARE ORTHOGONAL TO IT. Clicking back navigates the page under
   * an open sheet without touching the sheet: a sheet is about a
   * SURFACE and says which one, and names outlive visits.
   *
   * ONE LEVEL, NOT A STACK. The shape is null-or-one on purpose — the
   * demo nests exactly one page deep, and a stack whose only user has
   * depth one is a guess about the second case. Growing this into a
   * stack later is a change to this one function's body plus a `depth`
   * on the rendered control; nothing else reads it. */
  setBack(action: BackAction | null): void;
  identity(): VisorIdentity;
  saveIdentity(rec: VisorIdentity): void;
  /** RECORD SOMETHING THAT HAPPENED, so it stands until the user has
   * seen it (#132). Appends the line to the event record, drops the
   * oldest past `EVENTS_MAX`, persists best-effort at
   * `VisorConfig.eventsKey`, and lights the badge.
   *
   * IT NEVER SPEAKS. Not `announce`, not `speak`, not a pulse — this is
   * the MEMORY half of an announcement, and the arrival push stays the
   * caller's. That separation is the whole shape of the split: a
   * consequential arrival still owes the user the spoken sentence and
   * the strip line at the moment it happens; the record is what makes
   * announced-never-silent survive a user who was not looking. Calling
   * this INSTEAD of announcing would trade a loud twelve seconds for a
   * silent dot, which is the opposite of the trade.
   *
   * VOICE — EXACTLY `announce`'s POLICY, and for exactly its reason.
   * `text` is a flat string and therefore cannot carry class marking, so
   * it is spoken in FRAMEWORK VOICE and may embed USER-voice words
   * inline (a petname, the user's word for a device). An APP-INFLUENCED
   * string must NEVER be passed here: the sheet renders these lines
   * undressed, so a component's own words would sit in the visor's list
   * wearing the visor's authority. Describe the fact in the visor's
   * vocabulary instead.
   *
   * THE AUTHOR RULE (#132): only the VISOR and the ENGINE author events.
   * The SUBJECT of a record may well be an app — an update landed, a
   * component was revoked — but the AUTHOR never is. An app that could
   * light the user's own identity circle would have been handed "look at
   * me!" as a primitive, which is the one attention channel the visor
   * exists to keep unforgeable. Nothing here can check provenance, so
   * the rule is stated at the door and enforced by who is on the visor's
   * side of the app seam.
   *
   * SILENT BEFORE THE CLAIM, never a refusal. The identity cluster
   * renders nothing while unclaimed, so there is no button to badge and
   * the dot simply does not exist yet — the record is still kept, and
   * the badge appears with the cluster at `claim()`. */
  addEvent(text: string): void;
  /** The event record, NEWEST FIRST — the order the sheet reads them in,
   * so the list is not something every caller re-sorts. */
  events(): readonly VisorEvent[];
  /** ACKNOWLEDGE EVERYTHING CURRENTLY RECORDED: move the seen-watermark
   * to now (or to the newest record, whichever is later — a record whose
   * clock ran ahead must not stay permanently unseen), persist, and
   * re-sync the badge.
   *
   * v1's whole acknowledgment model is "opening the list marks it seen".
   * Per-entry dismissal waits until entries carry actions, because a
   * dismiss control on an entry that does nothing else is a control
   * whose only function is to make the user do the visor's filing.
   *
   * SILENT, like every method here: the badge un-lights, and nothing is
   * said about it. */
  markEventsSeen(): void;
  /** How many records are newer than the seen-watermark — the number the
   * settings row says out loud, and half of what lights the badge. */
  unseenEventCount(): number;
  /** RAISE A STANDING CONDITION under `key`: a state, not a moment
   * ("sync is failing"), which stays lit for as long as it stands.
   *
   * THE RETURN VALUE IS THE EDGE, and it is the whole reason this
   * returns anything: true ONLY when the key was not already standing.
   * A poller can therefore call this on every failing tick and announce
   * only on the crossing, which is the hand-rolled `syncFailureAnnounced`
   * boolean (#132) moved into the one place that can hold it honestly.
   * Re-setting a standing key UPDATES its text — a condition's wording
   * gets better as the seam learns more — and returns false.
   *
   * SESSION-LIVE, NEVER PERSISTED, and that is deliberate: a persisted
   * condition could outlive the thing that caused it with nothing left
   * running to clear it, leaving a badge lit forever over a fault that
   * ended while the tab was closed. Whoever raises a condition is a
   * poller, and a poller re-asserts it a tick after the next boot.
   *
   * VOICE and AUTHOR: `text` is under `addEvent`'s policy, word for
   * word. Silent, like everything here — the crossing's announcement is
   * the caller's to make, guarded by this return. */
  setCondition(key: string, text: string): boolean;
  /** LOWER A STANDING CONDITION. True only if it WAS standing — the
   * other edge, so a recovery sentence is said once and only when a
   * failure sentence was said (the visor does not congratulate itself
   * for fixing something nobody was told was broken). Silent. */
  clearCondition(key: string): boolean;
  /** The conditions currently standing, in the order they were raised —
   * insertion order, because the sheet lists them in the order they
   * arrived and re-sorting standing facts by anything else would make a
   * stable list jump. */
  conditions(): ReadonlyMap<string, string>;
  /** The hue currently COMMITTED as the user's anchor colour — as opposed
   * to a live preview a settings sheet is painting. `applyHue` paints;
   * this moves only where the choice is persisted, so a Cancel has
   * something truthful to revert to even in a browser where storage is
   * unavailable (and a re-read would otherwise re-roll).
   *
   * THROWS WHILE UNCLAIMED (`deferClaim`), rather than answering. There
   * is no committed hue before the claim — nothing has been read and
   * nothing rolled — and every plausible placeholder is a lie a caller
   * would then persist or paint. No caller exists that early; a loud
   * failure keeps it that way. */
  committedHue(): number;
  /** Paint, without committing (live preview).
   *
   * THROWS WHILE UNCLAIMED (`deferClaim`) — there is nothing to preview
   * before the claim rolls the first colour; see `committedHue`. */
  applyHue(hue: number): void;
  /** Commit: remember, paint, persist.
   *
   * THROWS WHILE UNCLAIMED (`deferClaim`) — a pre-claim commit would
   * persist a choice the user never made; see `committedHue`. */
  commitHue(hue: number): void;
  /** SAY THE USER'S ANCHOR WORD, to assistive tech only — "remind me
   * what my word is", for a user who has stopped hearing it as a word
   * and started hearing it as noise, or who has just switched devices.
   *
   * NOTE WHAT IS MISSING HERE, and that its absence is the design: there
   * is NO `committedWord()` to match `committedHue()`. The hue can be
   * returned because a consumer needs to paint with it; the word has no
   * such use — the only thing anyone does with it is HEAR it — so the
   * value never crosses this interface at all. A getter would let a
   * consumer render the word into pixels, and a rendered word is a word
   * that a screenshot, a screen-recording or a screen-share hands
   * straight to an app, which is the one thing that would end the
   * mechanism. The channel is audible-only by construction, not by
   * convention.
   *
   * THROWS WHILE UNCLAIMED (`deferClaim`), same discipline as
   * `committedHue`: pre-claim there is no word, and speaking a
   * placeholder would teach the user a token the visor will not use. */
  speakWord(): void;
  /** MINT A NEW ANCHOR WORD and say it, for a user who believes the old
   * one was overheard.
   *
   * The word's accepted residual leak is AUDIO — a screen-share carrying
   * system sound, a call, a person within earshot (see words.ts). None
   * of those are defended against, so the answer to all of them is the
   * same one the anchor colour has: the user can change it. The new word
   * is GUARANTEED DIFFERENT from the old one — a re-roll that returned
   * the same word would look like a control that does nothing, and, far
   * worse, would leave a user believing they had rotated away from a
   * token that is still live.
   *
   * Persisted immediately (there is no Save step and no preview: unlike
   * a colour, there is nothing to look at while deciding), and spoken —
   * never rendered, and never through `announce`.
   *
   * THROWS WHILE UNCLAIMED (`deferClaim`) — a pre-claim re-roll would
   * write the consumer's word key before the seal opens, exactly as
   * `commitHue` would write the hue key. */
  rerollWord(): void;
  /** FORGET EVERYTHING THIS VISOR HOLDS ON THIS DEVICE — the storage half
   * of the reset ceremony. The identity record, the committed anchor hue,
   * the committed anchor WORD, the EVENT RECORD and (when the consumer
   * configured one) the legacy hue key are removed; nothing else is
   * touched.
   *
   * The event record goes with the rest because it is the visor's memory
   * of what happened TO THIS USER on this device — a list of sentences
   * naming their devices and their account, which is exactly the class
   * of thing the ceremony promised to forget. Leaving it would produce
   * the sharpest possible contradiction: a freshly erased visor whose
   * first badge points at a list of the previous owner's news.
   *
   * The word goes with the colour, deliberately: they are the two halves
   * of one anchor, and an erase that took the colour but left the word
   * would leave a re-minted visor still answering to the old one.
   *
   * THE CEREMONY IS NOT HERE. sheets.ts owns it — the statement of
   * consequence, the arming delay, the typed confirmation, and the OTHER
   * half of the wipe, the trust table (`SurfaceMarks.eraseAll`). This is
   * the small, infallible piece it calls last.
   *
   * IT DOES NOT REPAINT, ANNOUNCE, OR RESTORE ANYTHING, and that is not
   * an omission. The caller reloads the page immediately afterwards, and
   * a fresh boot rolls a fresh anchor colour and announces it through the
   * existing `fresh` mechanics — every component NEW again, a new colour
   * on the bar, said out loud. THAT RELOAD IS THE ANNOUNCED-NEVER-SILENT
   * STORY HERE: repainting a live visor from now-deleted records would
   * only produce a half-erased screen to announce over, and every
   * in-memory cache in the consumer would still be speaking names that no
   * longer exist. */
  erase(): void;
  readonly drawer: DrawerHost;
  // NO CONSUMER-CONTROL SLOT. There was one — an optional strip element
  // a consumer could mount its own buttons into, exposed here as a
  // nullable node. Its only user was the todomvc spike's
  // pair of demonstration buttons, and both are gone. It is not
  // reinstated on demand either — every control the strip carries is one
  // more thing on the trust anchor whose provenance a user has to
  // reason about, so a new one is a framework decision with a framework
  // argument behind it, not a slot a consumer fills.
}

export function initVisor(config: VisorConfig): Visor {
  // THE UNCLAIMED SHELL, and what is missing from it. Under `deferClaim`
  // the two personal things — the anchor hue and the identity record —
  // are not read, not painted and not rendered; everything else below
  // (context machinery, announce, drawer host, live region, back
  // chevron) is built exactly as always, because a picker that is a
  // drawer sheet needs all of it. The strip and drawer then wear the
  // zero-chroma grey FALLBACK in visor.css, so the claim reads as the
  // arrival of colour.
  const deferred = config.deferClaim === true;
  let claimed = !deferred;
  let committedHue = 0;
  let fresh = false;
  const rollHue = () => {
    const rolled = loadVisorHue(config.hueKey, config.legacyHueKey);
    committedHue = rolled.hue;
    fresh = rolled.fresh;
    applyVisorHue(rolled.hue);
  };
  if (!deferred) rollHue();

  /** THE COMMITTED ANCHOR WORD, or "" while unclaimed.
   *
   * IT IS NEVER EXPOSED AS A STRING. There is no getter for it on the
   * `Visor` interface and there deliberately never will be: the moment a
   * consumer can read the word, a consumer can RENDER the word, and a
   * word that reaches pixels is a word a screenshot, a screen-share or a
   * compositing trick can carry to an app. Everything a caller may do
   * with it — hear it, replace it — is a method that SPEAKS, and speech
   * is a channel no app-side code can read back. This module-private
   * binding is the whole extent of its reach.
   *
   * The empty string is not a placeholder to be spoken: every read site
   * below either runs post-claim or falls back to the literal word
   * "visor" (see `wordPrefix`). */
  let committedWord = "";
  let wordFresh = false;
  /** Rolled EXACTLY WHERE `rollHue` is rolled, and for the same reason —
   * the colour and the word are one identity arriving, and a word that
   * could be rolled at a second site could be rolled twice. */
  const rollWord = () => {
    const rolled = loadVisorWord(config.wordKey);
    committedWord = rolled.word;
    wordFresh = rolled.fresh;
  };
  if (!deferred) rollWord();
  // FIXED IDS. They are part of the trust model and of the e2e contract —
  // "the visor's pixels" is a claim about named elements a component
  // cannot reach — so they are not parameterised.
  const context = document.getElementById("visor-context")!;
  const ctxTop = context.querySelector(".ctx-top") as HTMLElement;
  const ctxBottom = context.querySelector(".ctx-bottom") as HTMLElement;
  const identityBox = document.getElementById("visor-identity")!;
  const drawer = document.getElementById("visor-drawer") as HTMLElement;
  const drawerInner = document.getElementById("visor-drawer-inner") as HTMLElement;
  /** The bar the sheet opens above — measured for the sheet's height
   * budget, so the anchor can never be pushed off-screen. */
  const strip = document.getElementById("visor-strip") as HTMLElement | null;
  const dim = document.getElementById("visor-dim") as HTMLElement;

  const handlers: VisorHandlers = {};
  const requestNaming = (surface: SurfaceIdentity) => handlers.requestNaming?.(surface);
  const requestSettings = () => handlers.requestSettings?.();

  // --- the back chevron: the strip's own way out of a nested place -------
  //
  // WHERE IT LIVES, AND WHY THAT IS THE WHOLE TRICK. The button is
  // inserted as `.bar-inner`'s FIRST CHILD at runtime, so no consumer's
  // markup has to carry a slot for it — a slot in two index.htmls would
  // be two places to forget, and an empty one would be a hole in the
  // strip that only the framework can explain.
  //
  // `.bar-inner` is also the one strip element NEITHER RENDER CYCLE
  // CLEARS: `renderContext` replaces the children of `.ctx-top` and
  // `.ctx-bottom`, `renderIdentity` replaces the children of
  // `#visor-identity`, and both live INSIDE `.bar-inner` rather than
  // being it. So the chevron survives every context flip, every identity
  // repaint and every timed announcement without being recreated —
  // which is the behaviour the control has to have: its presence means
  // "you are in a nested place", a fact about WHERE the user is and not
  // about what the strip currently says. A control that blinked out
  // during an announcement would be a promise that lapses.
  //
  // NULL RENDERS NOTHING AT ALL — no disabled button, no empty slot,
  // the same rule the mark icon obeys. An affordance that is present but
  // inert teaches the user to distrust the ones that are present and
  // live.
  const barInner = (strip?.querySelector(".bar-inner") ?? null) as HTMLElement | null;
  let backBtn: HTMLButtonElement | null = null;
  /** The live action, read at CLICK TIME rather than captured in the
   * handler: a consumer may replace the destination without the control
   * flickering out and back. */
  let backAction: BackAction | null = null;
  const setBack = (action: BackAction | null) => {
    if (action === null) {
      backBtn?.remove();
      backBtn = null;
      backAction = null;
      return;
    }
    if (backBtn === null) {
      const btn = document.createElement("button");
      btn.id = "visor-back";
      btn.type = "button";
      // THE GLYPH: U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK. The
      // pet-icon curation lessons apply to every glyph the visor puts in
      // its own pixels, and this one passes them: a single BMP scalar
      // (no sequence, no variation selector), text presentation by
      // default so no platform paints it as colour emoji, and coverage
      // in every legacy font since it is a Latin-1-era punctuation
      // character rather than a symbol-block arrow. The obvious
      // alternatives lose on exactly those grounds — U+276E HEAVY
      // LEFT-POINTING ANGLE ORNAMENT is a Dingbats codepoint with
      // patchier coverage, and "←" reads as "undo/previous item" rather
      // than "up and out of here", which is the iOS chevron's whole
      // meaning. A CSS-drawn chevron (a rotated border box) renders
      // identically everywhere but is invisible to a text-only reading
      // of the strip, and the strip's contents being READABLE AS TEXT is
      // something several of this framework's checks depend on.
      btn.textContent = "\u2039";
      btn.onclick = () => backAction?.onBack();
      // FIRST CHILD, so it is at the strip's leading edge — before the
      // context cluster, which is what the user is going back FROM.
      barInner?.prepend(btn);
      backBtn = btn;
    }
    // THE VISOR'S OWN WORDING, always: `label` is framework voice and may
    // embed the user's vocabulary, never a component's (see `BackAction`).
    const label = action.label ?? "back";
    backBtn.title = label;
    backBtn.setAttribute("aria-label", label);
    backAction = action;
  };
  const appSurface = () => config.appSurface?.() ?? null;

  // THE IDENTITY CLUSTER, rebuilt from the record on every commit. Every
  // word here is the user's own, said in the visor's voice (plain, full
  // opacity) — and every word here stays inside the visor's pixels: nothing
  // below is written to a custom property, handed to a panel, or put on
  // the frame seam. Same discipline as `applyVisorHue`, for the same
  // reason: an ambient value is a disclosed value.
  //
  // TWO LINES: the user's name above their word for this device,
  // each ellipsizing in place. They are not hidden on a narrow
  // viewport — the cluster's 45% cap and the per-line ellipsis handle
  // narrowness, and dropping them was dropping half of what an
  // impersonating rectangle cannot reproduce, at the width where the
  // strip is most crowded.
  // --- the event record and the standing conditions (#132) -------------
  //
  // TWO KINDS OF NEWS, one badge. RECORDS are moments that already
  // happened and are kept until acknowledged; CONDITIONS are states that
  // are true right now and clear themselves when they stop being true.
  // They are held separately because they answer to different clocks —
  // a record's clock is the user's attention (seen or not seen), a
  // condition's is the world's (standing or not standing) — and the one
  // thing they share is the dot.
  //
  // WHY THE STATE LIVES HERE rather than in a consumer: the badge hangs
  // on the identity circle, which is the visor's own pixels, and the
  // author rule (`addEvent`) is only meaningful if the list is not
  // something an app-facing surface can reach at all.
  const eventStore = config.eventsKey === undefined
    // NO KEY, STILL A FEATURE: the in-memory record. See
    // `VisorConfig.eventsKey` — the degradation is durability, not
    // function.
    ? { seenAt: 0, events: [] as VisorEvent[] }
    : loadEvents(config.eventsKey);
  /** Standing conditions, keyed, INSERTION-ORDERED by the Map itself —
   * and deliberately not persisted (see `setCondition`). */
  const conditions = new Map<string, string>();
  /** The button the badge hangs on, or null while unclaimed. Held rather
   * than looked up each time because `renderIdentity` RECREATES the
   * button, and a stale node would silently swallow every later badge
   * update. */
  let settingsBtn: HTMLButtonElement | null = null;

  const persistEvents = () => {
    if (config.eventsKey === undefined) return;
    try {
      localStorage.setItem(config.eventsKey, JSON.stringify(eventStore));
    } catch { /* nothing durable to write to — the session copy still stands */ }
  };

  const unseenEventCount = () => eventStore.events.filter((e) => e.at > eventStore.seenAt).length;

  /** The button's standing sentence, extended while the dot is lit. The
   * dot itself carries no text (see `syncBadge`), so this is the ONLY
   * channel that tells a non-sighted user the badge is on — and it is a
   * `title`/`aria-label` rather than an announcement because the badge
   * is a standing state, not an arrival. */
  const SETTINGS_LABEL = "your visor: name, device, colour";
  const SETTINGS_LABEL_LIT = `${SETTINGS_LABEL} — recent events waiting`;

  /** Put the dot on (or take it off) the CURRENT settings button.
   *
   * LIT = UNSEEN RECORDS ∪ STANDING CONDITIONS (#132). One predicate, so
   * there is never a state where something is waiting and nothing shows.
   *
   * IT IS A DOT AND NEVER A COUNT, and the span is EMPTY: framework
   * voice by construction, exactly as `pulseContext` is — there is no
   * string here, so there is no way for any voice to leak onto the
   * anchor. `aria-hidden` keeps it out of the accessibility tree
   * entirely; the label above is the non-visual channel, because a bare
   * decorative node announced as content would be noise.
   *
   * ZERO LAYOUT SHIFT: the span is absolutely positioned inside the
   * button (visor.css), so it is out of flow and the strip's measured
   * geometry — a property the `strip-geometry` scenario pins — cannot
   * move whether the dot is there or not. Called by every mutator AND by
   * `renderIdentity`, which is what keeps the two in step across a
   * re-render. */
  const syncBadge = () => {
    const btn = settingsBtn;
    if (!btn) return;
    const lit = unseenEventCount() > 0 || conditions.size > 0;
    const existing = btn.querySelector(".visor-badge");
    if (lit && !existing) {
      const dot = document.createElement("span");
      dot.className = "visor-badge";
      dot.setAttribute("aria-hidden", "true");
      btn.append(dot);
    } else if (!lit && existing) {
      existing.remove();
    }
    const label = lit ? SETTINGS_LABEL_LIT : SETTINGS_LABEL;
    btn.title = label;
    btn.setAttribute("aria-label", label);
  };

  const renderIdentity = () => {
    // NOTHING PERSONAL BEFORE THE CLAIM, enforced HERE rather than at
    // the call sites. The cluster is the one place the user's own name,
    // their word for this device and their glyph are rendered, so a
    // stray external `renderIdentity()` from a consumer that has not
    // claimed yet — a device-label refresh, a settings commit racing the
    // unseal — must be inert rather than merely unlikely. An unclaimed
    // cluster is EMPTY: no name, no device, and no settings button
    // either, because the settings sheet is about a visor that is not
    // yours yet.
    if (!claimed) return;
    const rec = loadIdentity(config.identityKey);
    identityBox.replaceChildren();
    const lines = document.createElement("span");
    lines.className = "id-lines";
    // textContent, never innerHTML: the record is hand-editable storage,
    // so it is treated as data even though it is the user's own.
    // An unset field renders NOTHING — no fabricated "user"/"this
    // device", and no leftover punctuation (the separator the one-line
    // cluster needed is gone with the line).
    if (rec.name) {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = rec.name.slice(0, IDENTITY_MAX);
      lines.append(who);
    }
    if (rec.device) {
      const dev = document.createElement("span");
      dev.className = "who device";
      dev.textContent = rec.device.slice(0, IDENTITY_MAX);
      lines.append(dev);
    }
    identityBox.append(lines);
    const btn = document.createElement("button");
    btn.id = "visor-settings";
    btn.type = "button";
    // The face is a glyph from the visor's fixed vocabulary — never a
    // string out of the record (see VISOR_ICONS).
    btn.textContent = identityIcon(rec);
    btn.title = SETTINGS_LABEL;
    btn.setAttribute("aria-label", SETTINGS_LABEL);
    btn.onclick = () => requestSettings();
    identityBox.append(btn);
    // THE BADGE IS RE-HUNG HERE, not carried over: the button above is a
    // NEW node, and the dot is a child of it. `syncBadge` also owns the
    // label (lit or not), which is why the two assignments above are the
    // unlit default rather than the final word — this call is. It runs
    // AFTER `textContent`, which replaces every child the button has.
    settingsBtn = btn;
    syncBadge();
  };
  renderIdentity();

  /** The context currently on the strip, kept so an expiring
   * announcement can re-render it rather than restore a saved string. */
  let current: VisorContext = null;
  /** Bumped by every render and every announcement: a revert timer whose
   * token is stale has been overtaken and must do nothing. */
  let announceToken = 0;
  let announceTimer = 0;
  /** True while an announcement owns the bottom line. A CONTEXT MOVE
   * preempts it (a sheet opening is more urgent than any timed note),
   * but a mere repaint of the same context must not: the app surface
   * being registered a second after boot would otherwise silently eat
   * the "new visor colour" announcement. */
  let announcing = false;

  /** WHICH SURFACE THE CLUSTER IS ABOUT — both its lines, since the
   * split between them is by VOICE and not by subject. The visor's own
   * settings sheet has no component behind it, so the cluster keeps
   * naming the app: which component the strip is about is a property of
   * what is INSTALLED, not of which visor sheet happens to be open. The
   * erase ceremony is the same answer for the same reason — it is the
   * visor talking about itself, and the strip's top line is not the
   * place to stop naming what is drawn underneath. */
  const topSurface = (ctx: VisorContext): SurfaceIdentity | null => {
    if (ctx === null) return appSurface();
    if (ctx.kind === "settings" || ctx.kind === "reset" || ctx.kind === "events") {
      return appSurface();
    }
    // THE ENTRY CEREMONIES, same answer for the same reason: they are
    // the visor talking about the device and the account, not about a
    // component, so the cluster keeps naming whatever is installed. In
    // practice, at picker time, that is NOTHING — the app has not been
    // fetched and `appSurface()` is null — and an empty top line is the
    // correct pre-unseal screen rather than a special case.
    if (ctx.kind === "device-picker" || ctx.kind === "first-run") return appSurface();
    return ctx;
  };

  const renderContext = ({ keepAnnouncement = false }: { keepAnnouncement?: boolean } = {}) => {
    const holdBottom = keepAnnouncement && announcing;
    if (!holdBottom) {
      announceToken++;
      clearTimeout(announceTimer);
      announcing = false;
    }
    const ctx = current;
    const surface = topSurface(ctx);
    ctxTop.replaceChildren();
    if (!holdBottom) ctxBottom.replaceChildren();
    // WHICH VISOR SHEET IS OPEN, if any. Computed before either line is
    // built because BOTH consult it now: the top line withholds its
    // controls while a sheet owns the drawer (a control whose ceremony is
    // already on screen must not offer to open it again), and the bottom
    // line names the sheet.
    const kind = ctx === null ? "app" : (ctx.kind ?? "panel");
    const sheet = kind === "credentials" || kind === "naming" ||
      kind === "settings" || kind === "storage" || kind === "reset" ||
      kind === "events" || kind === "device-picker" || kind === "first-run";

    // --- the TOP line: THE USER'S RECOGNITION PAIR ---------------------
    // The mark the user picked and the word the user chose, side by side,
    // on the strip's first line — or, when they do not exist yet, the
    // visor's offer to create them. Two reasons the pair belongs together
    // and belongs first: a glyph and a name are ONE recognition act, and
    // reading them apart is the user doing a join the visor could have
    // done for them; and THE OFFER SITS WHERE THE ANSWER WILL LIVE — the
    // "name it" button occupies the position the petname will occupy, so
    // the ceremony's result appears where the invitation was, rather than
    // somewhere else on the strip.
    //
    // WHY THE LINES ARE FREE TO BE REORGANIZED AT ALL: the three voices
    // (see `foreignToken`) mark provenance ON THE TOKEN — the plate and
    // the monospace say "a component said this", the 600 weight says "you
    // said this" — so provenance travels with the word and not with the
    // row it happens to sit in. Before that marking existed, the row WAS
    // the marking, and moving a token between lines would have moved what
    // it claimed. It no longer does.
    if (surface) {
      // THE PET ICON, or nothing. A marked surface wears the glyph the
      // USER picked for it, in plain text inheriting --visor-fg — not a
      // coloured chip, and not a swatch the visor chose on its own. An
      // UNMARKED surface renders NO glyph: before the user has said
      // anything about this component, the visor has nothing of its own
      // to say about it either, and a placeholder in the visor's pixels
      // would be the visor speaking first.
      const icon = markIcon(surface.icon);
      if (icon) ctxTop.append(icon);
      const petname = (surface.petname ?? "").trim();
      if (petname !== "") {
        const named = petnameSpan(petname);
        if (!sheet) {
          // The click target is visor pixels in the strip — a place no
          // component can draw — so the ceremony cannot be baited from
          // inside an app rectangle. (The whole cluster is a tap target
          // too; this inner one stops the event so one gesture is one
          // opening.)
          named.setAttribute("role", "button");
          named.setAttribute("tabindex", "0");
          named.classList.add("clickable");
          named.title = "app settings: rename, re-mark, forget";
          named.onclick = (ev: MouseEvent) => {
            ev.stopPropagation();
            requestNaming(surface);
          };
          // A control that announces itself as a button to assistive tech
          // must BE one: Enter and Space activate it, exactly as they
          // would a real <button>. (Space is prevented from scrolling the
          // page out from under the ceremony it is about to open.)
          named.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            if (ev.key === " ") ev.preventDefault();
            ev.stopPropagation();
            requestNaming(surface);
          };
        }
        ctxTop.append(named);
      }
      // CONTRACT: each of these keeps the exact condition it had before
      // the lines were swapped — `.fresh` on `isNew && !sheet`, "name it"
      // on `petname === "" && !sheet` — so the swap moves elements and
      // changes nothing about WHEN they appear. In practice the two are
      // the unnamed case together: naming a component clears `isNew`.
      if (surface.isNew && !sheet) {
        // The TOFU moment is the one worth interrupting for: recognition
        // marks mean nothing the first time, and the first time is when
        // impersonation would land. NEW sits beside the offer it
        // motivates: the reason to name this component is that the visor
        // has never seen it before, and the two read as one sentence.
        const freshEl = document.createElement("span");
        freshEl.className = "fresh";
        freshEl.textContent = "NEW — first time this component draws here";
        ctxTop.append(freshEl);
      }
      if (petname === "" && !sheet) {
        // The visor's own control, in the visor's own pixels: the offer to stop
        // relying on what the component says about itself.
        const nameIt = document.createElement("button");
        nameIt.id = "visor-name-it";
        nameIt.type = "button";
        nameIt.textContent = "name it";
        nameIt.title = "give this component your own name";
        nameIt.onclick = (ev: MouseEvent) => {
          ev.stopPropagation();
          requestNaming(surface);
        };
        ctxTop.append(nameIt);
      }
    }

    // --- the BOTTOM line: CLAIMS AND STATUS ----------------------------
    // What the component says about itself, plus what the visor has to
    // say about right now: which of its own sheets is open, and any timed
    // announcement, which replaces this whole line for its window.
    //
    // The component's claim is DOWNSTAIRS from the user's own words, and
    // that is the demotion made structural: the strip answers "what is
    // this, to me?" before it answers "what does it call itself?". A
    // component that declares no nickname simply leaves this line empty
    // outside sheets and announcements — an empty second row is a better
    // outcome than a filler sentence, and it leaves the user's line above
    // reading clean and alone.
    //
    // What is NOT here any more: the sentence "— provider configuration
    // panel · drawn by the component, not by the visor". It was a standing
    // description competing for a line that had to hold the petname, the
    // first-sight marker and the open sheet's name in one ellipsizing
    // row; and the claim it made is made better by the sheets
    // themselves, at the moment they open.
    if (sheet && !holdBottom) {
      // While a visor sheet is open the strip NAMES it: the anchor and
      // the surface hanging off it say the same thing, so "which pixels
      // am I typing into" has a visor-side answer. This is the part of
      // the deleted standing-rule line that was worth keeping.
      const lead = document.createElement("span");
      lead.className = "said";
      lead.textContent = kind === "credentials"
        ? "storage credentials"
        : kind === "naming"
        ? "naming"
        // The storage PICKER: the sheet where a provider is chosen and
        // the app is connected to it. Named on the strip like every
        // other sheet, so "which pixels am I choosing in" has a
        // visor-side answer.
        : kind === "storage"
        ? "storage"
        // The visor's own words for its own destructive ceremony, and
        // deliberately the same words the button that opened it used:
        // the anchor and the sheet hanging off it must not describe the
        // act differently while the user decides whether to go through
        // with it.
        : kind === "reset"
        ? "erase this visor"
        // THE EVENT LIST, named on the strip with the same words its
        // entry row and its spoken name use — the anchor, the button
        // that opened the sheet and the sentence a screen reader hears
        // must not each have their own name for one place.
        : kind === "events"
        ? "recent events"
        // THE ENTRY CEREMONIES. Both lines are the visor naming its own
        // sheet, in the plainest words it has: at picker time the strip
        // is the ONLY thing on screen that is not the sheet, so this
        // line is the whole of what the anchor can say — and it must say
        // nothing personal, which "choose a device" does not.
        : kind === "device-picker"
        ? "choose a device"
        : kind === "first-run"
        ? "no account on this device yet"
        : "visor settings";
      ctxBottom.append(lead);
    }
    if (surface && !holdBottom) {
      // A component that declares nothing gets nothing quoted: an empty
      // app-voice token would render as a bare plate with quote marks —
      // punctuation in the visor's pixels standing for a claim nobody
      // made.
      if (surface.nickname !== "") ctxBottom.append(nicknameQuote(surface.nickname));
    }

    // THE CLUSTER IS ONE TAP TARGET, opening the visor's App settings sheet
    // for the surface both its lines are about. Offered only when there is a
    // surface and no credential/naming sheet already owns the drawer —
    // a control that would be a no-op must not announce itself as a
    // button to assistive tech.
    // "storage" joins the two ceremonies that are NOT tappable: the
    // picker owns the drawer, and offering to open the naming sheet from
    // the cluster would evict the very sheet the user is choosing in.
    //
    // "reset" joins them for a heavier reason, twice over. TRUST: a tap
    // on the cluster opens the NAMING ceremony, and a destructive
    // ceremony the user is mid-decision on must not be displaceable by a
    // stray tap on the anchor it hangs from — the erase sheet is the one
    // sheet where "I brushed the bar and my question went away" is a
    // real cost. MECHANICS: the erase sheet is opened from settings,
    // which SUSPENDS beneath it (visor/ui/sheets.ts's settings tenant),
    // so naming's eviction of reset would resume the settings sheet
    // mid-open and then immediately clobber it — `present("up")`
    // replaces the drawer's children — leaving a tenant that believes it
    // is open with no DOM of its own. There is no ordering of those two
    // that ends well, so the tap is refused instead.
    // The two ENTRY ceremonies join them on the mechanical half of the
    // same argument: the picker owns the drawer exclusively and the fork
    // is the resting state of an account-less device, so a tap that
    // opened the naming sheet would evict (or suspend) a ceremony that
    // is the only thing the user can currently be doing. Pre-claim there
    // is not even a surface to name.
    const tappable = surface !== null && kind !== "credentials" && kind !== "naming" &&
      kind !== "storage" && kind !== "reset" && kind !== "device-picker" &&
      kind !== "first-run";
    if (tappable) {
      context.setAttribute("role", "button");
      context.setAttribute("tabindex", "0");
      context.title = "app settings for this component";
      context.onclick = () => requestNaming(surface!);
      context.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        if (ev.key === " ") ev.preventDefault();
        requestNaming(surface!);
      };
    } else {
      context.removeAttribute("role");
      context.removeAttribute("tabindex");
      context.removeAttribute("title");
      context.onclick = null;
      context.onkeydown = null;
    }
  };

  /** THE STRIP'S SCREEN-READER CHANNEL, built here rather than in a
   * consumer's markup: the strip's internals are the visor's, and a
   * consumer that had to remember to add a live region is a consumer
   * that can forget to.
   *
   * VISUALLY HIDDEN, NOT `display:none` — a display:none (or hidden)
   * live region is not announced at all, so the clip-rect recipe is the
   * only correct one here. The styling lives in visor/ui/visor.css
   * (`#visor-live`); the element is created here so it exists in every
   * embedding. */
  const liveRegion = (() => {
    const host = strip ?? document.body;
    const existing = host.querySelector("#visor-live") as HTMLElement | null;
    if (existing) return existing;
    const el = document.createElement("span");
    el.id = "visor-live";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    host.append(el);
    return el;
  })();

  /** THE MINIMUM TIME A SENTENCE OWNS THE LIVE REGION, in ms. Long
   * enough that a typical screen reader has begun (and mostly finished)
   * speaking it before the next one replaces the text. */
  const SPEAK_DWELL_MS = 1400;
  /** How many sentences may wait. A cap rather than an unbounded queue:
   * a burst that outruns speech is a burst nobody can listen to anyway,
   * and an unbounded one would keep talking about the past long after
   * the screen moved on. OLDEST IS DROPPED, not newest — the most
   * recent sentences are the ones describing what is on screen now. */
  const SPEAK_QUEUE_MAX = 8;
  const speakQueue: string[] = [];
  let speaking = false;

  /** Say something to assistive tech only. CLEAR THEN SET, in two turns:
   * writing the same string a live region already holds is not a change,
   * and an unchanged live region announces nothing — so a repeated
   * identical sentence would be silently dropped.
   *
   * AND A FIFO QUEUE AROUND THAT, which is the part that is not obvious.
   * A live region has ONE slot, and the screen reader reads it
   * asynchronously, on its own schedule; writing twice in quick
   * succession does not queue two announcements, it destroys the first.
   * Two sites in this file do exactly that, synchronously, and both are
   * correct behaviour that must not be made to take turns by hand:
   *
   *   (a) `close()` on a non-suspended tenant speaks its own "closed"
   *       and then, in the same synchronous block, resumes the
   *       occupant that was waiting underneath — which speaks "back".
   *       Unqueued, a non-visual user hears only "back" and is never
   *       told the ceremony they were in ended.
   *   (b) `claim()` teaches a freshly-rolled word, and the consumer's
   *       very next statement is the fresh-anchor colour announcement.
   *       Unqueued, the teach — the one sentence the whole mechanism
   *       depends on the user hearing — is the one that loses.
   *
   * So each message holds the region for `SPEAK_DWELL_MS` before the
   * next is written. `announce` and `pulseContext` call this exactly as
   * they did and are ordered by it for free. */
  const speak = (text: string) => {
    if (!text) return;
    speakQueue.push(text);
    // Drop from the FRONT when full: see SPEAK_QUEUE_MAX.
    while (speakQueue.length > SPEAK_QUEUE_MAX) speakQueue.shift();
    if (speaking) return;
    const pump = () => {
      const next = speakQueue.shift();
      if (next === undefined) {
        speaking = false;
        return;
      }
      speaking = true;
      liveRegion.textContent = "";
      setTimeout(() => {
        liveRegion.textContent = next;
        // The dwell is measured from the moment the text LANDS, not from
        // the enqueue — the 30ms blank is part of delivering this
        // sentence, not part of the previous one's time on air.
        setTimeout(pump, SPEAK_DWELL_MS);
      }, 30);
    };
    pump();
  };

  /** THE PROVENANCE PREFIX every drawer lifecycle sentence opens with:
   * the user's own word once there is one, and the literal word "visor"
   * before that.
   *
   * THE PRE-CLAIM CASE IS REAL, not a defensive default. A `deferClaim`
   * embedder (the solo page) puts its UNSEAL PICKER in the drawer — the
   * login is trusted UI and trusted UI lives in visor territory — so the
   * drawer opens and closes, and therefore speaks, before any identity
   * exists. There is deliberately NO WORD YET at that point: the word is
   * the user's, and nothing of the user's may be on screen (or in the
   * ear) before the seal opens. "visor: this device open" is the honest
   * sentence there — it names the speaker without claiming a provenance
   * token that has not been minted. A user learns quickly that the
   * generic prefix belongs to the pre-login world; an app that imitates
   * it gains nothing, because after the claim the generic prefix is
   * exactly what a spoofed sentence sounds like. */
  const wordPrefix = () => (committedWord === "" ? "visor" : committedWord);

  /** True once the fresh-word teach has been spoken, so it cannot be
   * said twice by a second claim (or by a consumer that claims a visor
   * that was never deferred). */
  let wordTaught = false;
  /** THE ONE SENTENCE THE WHOLE MECHANISM DEPENDS ON. A word the user
   * was never told is a word they cannot use to tell the visor from an
   * app imitating it, so a FRESH roll teaches itself out loud.
   *
   * `speak`, NEVER `announce`: the visual line is not this sentence's to
   * take. Sighted users already have the anchor colour, and an
   * announcement here would spend the strip's bottom line — the line a
   * fresh boot owes to the fresh-COLOUR announcement — on words that
   * mean nothing to someone reading them. And the word must never reach
   * pixels at all (see `committedWord`), which rules the visual channel
   * out on its own. Routing through the queue is what guarantees the
   * consumer's colour announcement, which follows within the same tick,
   * does not clobber it. */
  const teachFreshWord = () => {
    if (!wordFresh || wordTaught || committedWord === "") return;
    wordTaught = true;
    speak(`your visor's word is ${committedWord} — it will start everything your visor says`);
  };

  /** The pulse's total on-screen life, in ms. MUST match the
   * `visor-ctx-pulse` animation in visor/ui/visor.css (.9s × 2). Used
   * only for the belt-and-braces cleanup timer below. */
  const PULSE_MS = 1800;
  let pulseTimer = 0;
  // `animationend` fires ONCE at the end of the last iteration (the
  // per-cycle event is `animationiteration`), so it is the natural end
  // of the pulse. ONE PERSISTENT LISTENER, guarded by target: the event
  // BUBBLES, so a future animation ending on a child of the cluster
  // must not cut the pulse short (and a per-call `once` listener would
  // both accumulate across restarts and be consumed by exactly such a
  // bubbled event). The timer below is the fallback for the cases where
  // the event never arrives at all — a backgrounded tab, an engine that
  // drops it.
  context.addEventListener("animationend", (e) => {
    if (e.target === context) context.classList.remove("pulse");
  });
  const pulseContext = (srText?: string) => {
    // RESTART CLEANLY. Re-adding a class that is already present does
    // not restart a CSS animation, so: remove, force a reflow (the
    // offsetWidth read is the flush), re-add.
    context.classList.remove("pulse");
    void context.offsetWidth;
    context.classList.add("pulse");
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => context.classList.remove("pulse"), PULSE_MS + 400);
    if (srText) speak(srText);
  };

  const announce = (text: string, ms = 8000) => {
    const token = ++announceToken;
    announcing = true;
    ctxBottom.replaceChildren();
    const said = document.createElement("span");
    said.className = "said announce";
    said.textContent = text;
    ctxBottom.append(said);
    // The same words to assistive tech. Sighted users get the line; this
    // is the other half, and it was missing entirely until the pulse
    // needed a screen-reader channel of its own.
    speak(text);
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      // Overtaken by a newer render or announcement: that one owns the
      // line now.
      if (token !== announceToken) return;
      announcing = false;
      // REVERT BY RE-RENDER, never by restoring what was there: the
      // context may have moved while this was showing.
      renderContext();
    }, ms);
  };

  /** Same strip subject? A context MOVE preempts a live announcement; a
   * repaint that does NOT move the context must let it finish. The
   * distinction earns its keep on the close paths: teardown restores are
   * DEFERRED (a dialog retirement waits a macrotask for in-flight frame
   * messages), so a restore from an EARLIER gesture can land milliseconds
   * after a LATER gesture's announcement — observed with the forget
   * announcement, clobbered after 4ms by the storage dialog's retirement
   * restoring the same app context it was announced over. Contexts are
   * recomputed objects, so compare by subject (kind + surface name), not
   * identity. */
  const sameContext = (a: VisorContext, b: VisorContext): boolean => {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if ((a.kind ?? "panel") !== (b.kind ?? "panel")) return false;
    return (a as { name?: string }).name === (b as { name?: string }).name;
  };

  const setContext = (ctx: VisorContext) => {
    const moved = !sameContext(current, ctx);
    current = ctx;
    renderContext({ keepAnnouncement: !moved });
  };
  setContext(null);

  // The colour picker used to live on the strip, as a button plus an
  // inline swatch row. It moved WHOLE into the consumer's settings sheet
  // (same constrained palette, same fixed lightness/chroma, same storage
  // key): the strip is the anchor, and an anchor with its own editing
  // controls dangling off it is a busier target than one control that
  // opens the visor's own surface.

  // --- the drawer host --------------------------------------------------------
  //
  // The sheet unfolds ABOVE the pinned strip, painted in the user's own
  // anchor colour.
  //
  // ABOVE, not below, and the distinction is the whole defence. A sheet
  // BENEATH the strip is forgeable by adjacency: the strip floats over
  // scrollable content, so an app frame can be scrolled flush to the
  // strip's bottom edge and paint a counterfeit that appears attached to
  // the real bar. The band ABOVE the strip is unreachable at every scroll
  // offset — the strip is pinned to the viewport's top edge, so there is
  // no position an app can occupy there. And the sheet ARRIVES by pushing
  // the real strip down: an app can paint a sheet, but it cannot move
  // the visor's bar, so the reveal motion is itself unforgeable. Position
  // is the anchor, the motion is its proof, and the colour is secondary.

  // deno-lint-ignore no-explicit-any
  const tenants: TenantImpl<any>[] = [];

  interface TenantImpl<S> extends DrawerTenant<S> {
    readonly spec: DrawerTenantSpec<S>;
    /** May this tenant be suspended INSTEAD of closed, right now? Asked
     * by whichever tenant is about to displace it (see `suspendable`). */
    suspendableNow(): boolean;
    /** Give up the drawer, keep the session. */
    suspend(): void;
    /** Take the drawer back, rebuilt, from the left. */
    resume(): void;
  }

  let noteEl: HTMLElement | null = null;
  const drawerNote = (text: string) => {
    if (noteEl) noteEl.textContent = text;
  };

  const occupied = () => tenants.some((t) => t.isOpen());

  const restoreContext = () => {
    const override = config.contextOverride?.();
    if (override !== undefined && override !== null) {
      setContext(override);
      return;
    }
    for (const t of tenants) {
      // A SUSPENDED TENANT IS NOT A CLAIMANT. Its session is alive, but
      // its claim to the strip is DORMANT: its sheet is off-screen and
      // the drawer belongs to whoever displaced it, so naming it here
      // would have the anchor describe a sheet the user cannot see while
      // the visible one goes unnamed — the exact false statement
      // `restoreContext` exists to prevent. Eligibility comes back on
      // its own: `resume` clears the flag BEFORE it calls in here, so a
      // returning tenant is a claimant again precisely when its sheet is
      // on its way back.
      //
      // GENERAL, not a fix for one sheet. The demo's picker suspension
      // never tripped this only because every tenant that displaces the
      // picker is registered BEFORE it and therefore wins the scan
      // anyway — masked by registration order, not immune to the bug.
      // The settings sheet suspending under the erase ceremony is the
      // opposite order (settings is registered first), and any consumer
      // `restoreContext` while that ceremony is up — the demo restores
      // the strip when a panel retires, which can happen mid-ceremony
      // because the erase sheet does not pause runners — would have put
      // "visor settings" on the anchor above the erase sheet.
      if (t.isSuspended()) continue;
      const s = t.session();
      if (s !== null) {
        setContext(t.spec.context(s));
        return;
      }
    }
    setContext(null);
  };

  /** THE STRIP OF APP THAT ALWAYS SHOWS. The visor's whole claim is that
   * its pixels are somewhere else than the page's — and a drawer allowed
   * to grow until it covers the last of the app surface makes that claim
   * uncheckable: a full-screen sheet is indistinguishable from a page
   * that has drawn one, which is the exact confusion the visor exists to
   * prevent. So the budget keeps a band of (dimmed) app visible under
   * the assembly at every size, and the boundary between the two
   * surfaces stays perceivable. A sheet that wants more scrolls
   * internally; it does not get the last 48px. */
  const APP_REVEAL = 48;

  /** The height budget every sheet shares. The sheet grows ABOVE the
   * strip inside one sticky assembly, so a sheet taller than the viewport
   * would push the strip off the bottom of the screen — losing the anchor
   * at the exact moment a secret is on screen. The sheet is therefore
   * capped at viewport-minus-strip-minus-APP_REVEAL and scrolls
   * internally past that (see .cred-sheet's --visor-sheet-max). Measured
   * rather than hardcoded because the strip wraps to two rows on a phone,
   * and re-measured on resize/rotation.
   *
   * ceil: a fractional strip height would otherwise leave the bar hanging
   * a subpixel off the bottom. */
  const budget = () => {
    const stripH = Math.ceil(strip?.getBoundingClientRect().height ?? 0);
    return Math.max(0, globalThis.innerHeight - stripH - APP_REVEAL);
  };

  const fit = () => {
    drawer.style.setProperty("--visor-sheet-max", `${budget()}px`);
  };

  /** THE GESTURE STOPS AT THE VISOR'S EDGE — the JS half of the
   * containment `.cred-sheet`/`#visor-drawer-inner`/`#visor-dim` declare
   * in CSS, and the half that is actually load-bearing.
   *
   * `overscroll-behavior` only ends a chain at an element that HAS
   * SCROLL RANGE, and most sheets have none: they fit. Measured in
   * Chromium at 390×664 — a wheel over a short open sheet, and a wheel
   * over the dim, both scrolled the DOCUMENT by 117px with `contain`
   * declared the whole way up. That is the reported surprise: a drag
   * inside the visor moving the app underneath it, the two surfaces
   * answering one gesture, which is the distinction the drawer exists to
   * make. So the chain is refused here instead.
   *
   * What is allowed through is exactly what the sheet itself can
   * consume: a sheet with room left in the direction of travel scrolls
   * normally (and the CSS `contain` ends the chain at its edges for
   * touch, smoothly, without a cancelled gesture). Everything else —
   * the drawer's own chrome, a sheet already at its end, the dim in its
   * entirety — is refused. Non-passive by necessity: a passive listener
   * may not preventDefault. */
  const consumable = (target: EventTarget | null, dy: number): boolean => {
    const el = (target as Element | null)?.closest?.(".cred-sheet") as HTMLElement | null;
    if (!el) return false;
    const room = el.scrollHeight - el.clientHeight;
    if (room <= 1) return false;
    if (dy < 0) return el.scrollTop > 0;
    if (dy > 0) return el.scrollTop < room - 1;
    return false;
  };
  drawer.addEventListener("wheel", (e) => {
    if (!consumable(e.target, (e as WheelEvent).deltaY)) e.preventDefault();
  }, { passive: false });
  dim.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
  // TOUCH: the dim is already refused wholesale by its `touch-action:
  // none`, and a scrolling sheet is handled natively by `contain`. What
  // is left is a drag that starts on the drawer's own chrome rather than
  // in a sheet, which no CSS declaration covers.
  drawer.addEventListener("touchmove", (e) => {
    const el = (e.target as Element | null)?.closest?.(".cred-sheet") as HTMLElement | null;
    if (el === null || el.scrollHeight - el.clientHeight <= 1) e.preventDefault();
  }, { passive: false });

  /** Animate 0 → the measured content height. One property drives the
   * whole assembly: the sheet's growth pushes the strip down and the
   * page content with it, on one curve (spikes/todomvc/host/visor.ts:82-90
   * — scrollHeight misses the flex-end top-overflow, so measure at auto).
   *
   * CLAMPED STRUCTURALLY, not only by the sheet's own max-height: the
   * cap has to hold for whatever is in the drawer, and the sheet is not
   * guaranteed to be the only child of the inner (a swap puts two there
   * for the length of a travel) nor to have finished resolving its
   * max-height at the moment we measure. */
  const reveal = () => {
    drawerInner.style.height = "auto";
    const target = Math.min(drawerInner.offsetHeight, budget());
    drawerInner.style.height = "0px";
    void drawerInner.offsetHeight;
    drawerInner.style.height = `${target}px`;
  };

  /** Animate the CURRENT height to a newly measured one, for a drawer
   * that is already open (a rebuilt sheet, an occupant swap, a resize,
   * or a sheet whose content arrived late — see `contentWatch`). Same
   * single-property curve as `reveal`, same structural clamp; the
   * momentary `auto` is never rendered, since style is only resolved at
   * frame time. Which is also why this is safe to call DURING a reveal:
   * the transition simply re-aims from wherever it currently is. */
  const retarget = () => {
    drawerInner.style.height = "auto";
    drawerInner.style.height = `${Math.min(drawerInner.offsetHeight, budget())}px`;
  };

  /** THE SWAP: how one occupant replaces another INSIDE the drawer.
   *
   * The grammar is the page track's, replayed at drawer scale — the
   * outgoing occupant leaves to the left, the incoming arrives from the
   * right, and the reverse when the incoming one closes and the
   * suspended occupant comes back. Same motion, so a user reads it as
   * the same thing: you have gone one step further in, and now you are
   * back. Entirely inside trusted pixels; nothing about it is a second
   * drawer region.
   *
   * The outgoing element is taken OUT OF FLOW for the duration
   * (`.visor-swap-out` is absolutely positioned), so the drawer's height
   * animates to the INCOMING sheet's height while both are on screen —
   * one height curve, the existing one, and a real frame in which the
   * two occupants are side by side. Under prefers-reduced-motion the
   * transforms are dropped and the outgoing element simply goes. */
  const SWAP_MS = 420;

  function makeTenant<S>(spec: DrawerTenantSpec<S>): TenantImpl<S> {
    let session: S | null = null;
    let anchor: (() => void) | null = null;
    /** Watches the mounted sheet for LATE CONTENT — see `present`. */
    let contentWatch: ResizeObserver | null = null;
    let armTimer = 0;
    /** Kept so the sheet can be rebuilt (a shape change) or re-presented
     * (a resume) for the SAME session. */
    let builder: ((session: S) => DrawerSheet) | null = null;
    /** Session alive, drawer held by somebody else. */
    let suspended = false;
    /** What `dim` RESOLVED to at open. The undo must match the do even
     * if the predicate's answer changed while the sheet was up. */
    let dimmedNow = false;

    /** THE DRAWER'S NON-VISUAL LIFECYCLE LINE: "«word»: «sheet» «verb»".
     *
     * IMPLEMENTED IN THE HOST, ONCE, rather than left to each tenant —
     * which is the same argument the live region itself was built on. A
     * tenant that has to remember to announce its own open is a tenant
     * that can forget to, and the failure is invisible to everyone who
     * reviews the sheet by looking at it. Registering a tenant is what
     * buys the announcement; `spoken` being REQUIRED is what makes it
     * impossible to register one that cannot be announced.
     *
     * The prefix is the whole reason this exists. A sighted user knows
     * this sheet is the visor's because it hangs off a strip no
     * component can draw in; a listening user knows it because the
     * sentence opens with a word only their visor knows. Everything
     * after the colon is FRAMEWORK VOCABULARY (see `spoken`), so the
     * sentence carries no string an app could have influenced.
     *
     * `speak`, never `announce`: the visual bottom line already says
     * what the drawer is doing by SHOWING the sheet, and spending it on
     * a lifecycle sentence at every sheet transition would trample the
     * context the strip is meant to be holding — plus the word must
     * never reach pixels at all. */
    const speakDrawer = (verb: string) => speak(`${wordPrefix()}: ${spec.spoken} ${verb}`);

    const detach = () => {
      if (anchor) {
        globalThis.removeEventListener("resize", anchor);
        globalThis.visualViewport?.removeEventListener("resize", anchor);
      }
      anchor = null;
      contentWatch?.disconnect();
      contentWatch = null;
    };

    /** PUT THIS TENANT'S SHEET ON SCREEN, from its builder, and animate
     * the drawer to fit it. The one place a sheet is mounted: a fresh
     * open (`enter: "up"`, growing out of the bar from zero), a rebuild
     * at a new shape (`"none"`, height only), or an occupant swap
     * (`"right"` for a sheet arriving over a suspended one, `"left"` for
     * a suspended one coming back).
     *
     * Arming is re-run on EVERY presentation, which is the rule the band
     * needs: a picker that was armed before a configuration detour must
     * not still be armed when it re-expands on the user's return. */
    const present = (s: S, enter: "up" | "none" | "right" | "left") => {
      const sheet = builder!(s);
      // THE CURRENT OCCUPANT, which is NOT simply the first child: a
      // sheet that is already travelling out is still in the DOM for the
      // length of its own motion, and a second swap started inside that
      // window would otherwise animate the wrong element and leave the
      // real occupant sitting there. Ceremonies opened and closed in
      // quick succession do exactly this.
      const occupantEl = Array.from(drawerInner.children).reverse().find(
        (el) => !el.classList.contains("visor-swap-out"),
      ) as HTMLElement | undefined;
      // Anything already on its way out has been superseded: its travel
      // is over, whatever its timer thinks.
      for (const el of Array.from(drawerInner.children)) {
        if (el !== occupantEl && el.classList.contains("visor-swap-out")) el.remove();
      }
      const outgoing = (enter === "right" || enter === "left") ? occupantEl ?? null : null;
      if (outgoing) {
        // OUT OF FLOW for the travel, so the drawer's height animates to
        // the INCOMING sheet's height while both are visible.
        outgoing.classList.add("visor-swap-out", enter === "right" ? "to-left" : "to-right");
        drawerInner.append(sheet.root);
        // Start off-stage, then release in the next style resolution:
        // the class removal is what the transition runs on.
        sheet.root.classList.add("visor-swap-in", enter === "right" ? "from-right" : "from-left");
        void sheet.root.offsetWidth;
        sheet.root.classList.remove("from-right", "from-left");
        setTimeout(() => {
          outgoing.remove();
          sheet.root.classList.remove("visor-swap-in");
        }, SWAP_MS);
      } else if (enter !== "none") {
        drawerInner.replaceChildren(sheet.root);
      } else {
        drawerInner.replaceChildren(sheet.root);
      }

      const refit = () => {
        fit();
        // The animated height is a pixel target, so it goes stale when
        // the budget changes under it; re-measure at auto and retarget.
        if (session !== s) return;
        retarget();
      };
      detach();
      fit();
      anchor = refit;
      globalThis.addEventListener("resize", refit);
      // ALSO the visual viewport where there is one. On a phone the
      // window's `resize` is the unreliable half of this pair: a URL bar
      // sliding away or a keyboard coming up changes the space the sheet
      // actually has and both engines report it here first, sometimes
      // only here. Feature-detected, same handler — a second delivery of
      // the same news costs one re-measure.
      globalThis.visualViewport?.addEventListener("resize", refit);
      // THE SHEET THAT FILLS IN LATER. The revealed height is a pixel
      // target measured ONCE, at present-time — and a sheet whose fields
      // arrive from an async round-trip is measured as its own skeleton
      // and never told it grew. The inner clips from the TOP (flex-end),
      // so what a user gets is a drawer hanging half out of view with
      // its heading cut off: the visor apparently half-closed, which is
      // exactly the state the anchor is supposed to make unambiguous.
      // Watching the mounted sheet's box closes the whole class — async
      // sheets, adopt/manual re-renders, a field appearing under a
      // radio — not just the one that was reported. `retarget` re-aims a
      // reveal already in flight rather than fighting it, so this is
      // safe during the 700ms curve.
      if (typeof ResizeObserver !== "undefined") {
        contentWatch = new ResizeObserver(() => {
          if (session !== s || suspended) return;
          retarget();
        });
        contentWatch.observe(sheet.root);
      }

      const controls = sheet.controls ?? [];
      if (spec.armed) {
        // Disabled BEFORE the first frame, inputs included: a secret must
        // not be typeable into a sheet the user has not yet had time to
        // see.
        for (const c of controls) c.disabled = true;
      }

      if (enter === "up") reveal();
      else retarget();

      clearTimeout(armTimer);
      if (spec.armed) {
        armTimer = setTimeout(() => {
          if (session !== s || suspended) return;
          for (const c of controls) c.disabled = false;
          sheet.onArmed?.();
          sheet.root.classList.add("armed");
        }, ARM_MS);
      }
      // Where a sheet takes focus, if its interaction warrants taking it
      // at all (see `DrawerSheet.onShown`).
      sheet.onShown?.();
    };

    /** SUSPEND: keep the session, give up the drawer. Called by the
     * tenant that is displacing this one, which owns the travel (it has
     * to: the outgoing element only slides once the incoming sheet is
     * there to slide in over it). Bookkeeping only. */
    const suspend = () => {
      if (session === null || suspended) return;
      suspended = true;
      clearTimeout(armTimer);
      detach();
      // A note belongs to the sheet that declared it.
      noteEl = null;
      if (dimmedNow) {
        dim.hidden = true;
        dimmedNow = false;
      }
    };

    /** RESUME: the tenant that displaced this one has closed, so the
     * suspended sheet comes back from the left, rebuilt from its builder
     * — rebuilt, not restored, because the world moved while it was away
     * (the demo's band re-expands with its lists refreshed, which is the
     * point of the whole detour). */
    const resume = () => {
      const s = session;
      if (s === null || !suspended) return;
      suspended = false;
      drawer.hidden = false;
      dimmedNow = typeof spec.dim === "function" ? spec.dim(s) : spec.dim === true;
      if (dimmedNow) dim.hidden = false;
      // RECOMPUTED, NEVER ASSERTED — the discipline `restoreContext`
      // exists for, and this is exactly the site that gets it wrong if
      // nobody says so. A resuming tenant knows what IT is about; it
      // does not know what the strip should say, because something with
      // a stronger claim may have arrived while it was suspended. It
      // routinely has: the demo's band resumes over a live component
      // surface, and `setContext(spec.context(s))` here took the panel's
      // name off the anchor while the panel was still drawing the page
      // below — the anchor making a false statement about who draws
      // there, plus the loss of the "name it" offer that goes with a
      // named surface.
      restoreContext();
      present(s, "left");
      // THE SHEET IS BACK, said out loud. A resume is invisible to a
      // non-visual user otherwise: nothing about it changes focus, and
      // the strip context it restores is RECOMPUTED (it may not even be
      // this tenant's). "back" rather than "open" because it is the
      // second half of a displacement the user already heard the first
      // half of — the displacing tenant's own open.
      speakDrawer("back");
    };

    const tenant: TenantImpl<S> = {
      spec,
      name: spec.name,
      isOpen: () => session !== null,
      session: () => session,
      owns: (s) => session === s,
      claim: (s) => {
        session = s;
      },
      close(opts: DrawerCloseOptions = {}) {
        const s = session;
        if (s === null) return;
        const wasSuspended = suspended;
        session = null;
        suspended = false;
        builder = null;
        clearTimeout(armTimer);
        detach();
        // A note aimed at a sheet that is gone must not land in the next
        // one; the tenant re-declares its own on the way up.
        noteEl = null;
        spec.beforeCollapse?.(s, opts);
        // A SUSPENDED tenant does not own the drawer, so closing it must
        // not touch the drawer's height, its content, or the dim — all
        // three belong to whoever displaced it. It is a session ending
        // off-screen (the demo's band, dismissed while a ceremony is up
        // over it), and the only thing it changes is that nothing comes
        // back when that ceremony closes.
        if (!wasSuspended) {
          drawerInner.style.height = "0px";
          // By the REMEMBERED value, not by re-asking: `dim` may be a
          // predicate whose answer changed while the sheet was up, and
          // the undo has to match the do.
          if (dimmedNow) dim.hidden = true;
        }
        dimmedNow = false;
        spec.afterCollapse?.(s, opts);
        // Ownership-aware, never a bare `setContext(null)`: this close may
        // be running late, and the strip may already belong to somebody
        // else (see restoreContext).
        if (opts.context !== false && !wasSuspended) restoreContext();
        spec.afterRestore?.(s, opts);
        if (!wasSuspended) {
          // SPOKEN ONLY ON THE NON-SUSPENDED PATH. A suspended tenant
          // does not own the drawer — its session is ending off-screen,
          // and nothing a listener can perceive is happening — so
          // announcing "closed" there would describe a sheet that left
          // the screen some time ago, under a ceremony that is still up.
          //
          // STRICTLY BEFORE the resume below, and the pair is the reason
          // `speak` had to become a queue: these two sentences are
          // emitted in the same synchronous block, and against a bare
          // live region the second would silently destroy the first.
          speakDrawer("closed");
          // THE SUSPENDED OCCUPANT COMES BACK, if there is one: this
          // close is the end of the ceremony that displaced it. Done
          // synchronously, before the deferred blank below, so the
          // drawer never flashes empty between the two.
          const waiting = tenants.find((t) => t !== tenant && t.isSuspended());
          waiting?.resume();
        }
        setTimeout(() => {
          // Occupancy-aware, not tenant-scoped: another tenant may have
          // claimed the drawer in the meantime, and blanking it here
          // would erase a live sheet belonging to somebody else.
          if (!occupied()) {
            drawerInner.replaceChildren();
            drawer.hidden = true;
          }
        }, ARM_MS);
      },
      rebuild() {
        const s = session;
        // A suspended tenant rebuilds when it RESUMES, from the same
        // builder, so there is nothing to do here.
        if (s === null || suspended || builder === null) return;
        present(s, "none");
      },
      isSuspended: () => suspended,
      suspendableNow: () => session !== null && spec.suspendable?.(session) === true,
      suspend,
      resume,
      open(s, build) {
        // MUTUAL EXCLUSION. An exclusive tenant holding the drawer refuses
        // every other opener outright.
        for (const other of tenants) {
          if (other === tenant) continue;
          if (other.isOpen() && other.spec.exclusive) return false;
        }
        // Everything else gives way — in registration (precedence) order,
        // and WITHOUT touching the strip context, which this tenant is
        // about to claim. A SUSPENDABLE tenant gives way without dying:
        // it keeps its session and slides out (the travel is run by the
        // presentation below, which needs both sheets in the DOM at
        // once), and it comes back when this one closes.
        // KNOWN WART, RECORDED RATHER THAN GUARDED — a PHANTOM "back".
        // The two branches below interact through `close`, which resumes
        // whatever is suspended: if this loop suspends tenant A (the
        // first branch) and then evicts tenant B (the second), B's
        // `close` finds A waiting and RESUMES it — mid-loop, on behalf
        // of an opener that is itself about to displace A again. A is
        // therefore suspended, resumed and re-suspended inside one
        // `open`, and since the word change the resume is AUDIBLE: the
        // user hears "«word»: «A» back" for a sheet that never came back.
        //
        // It needs a tenant configuration the demo never builds — an
        // open NON-SUSPENDABLE, NON-EXCLUSIVE occupant, a suspended
        // SUSPENDABLE one, and a third tenant opening over both — so
        // there is nothing to fix against today. Note also that the
        // STRUCTURE is pre-existing: the spurious resume (with its
        // rebuild and its `restoreContext`) has always happened here;
        // the announcement only made it perceptible, which is arguably
        // the announcement doing its job.
        //
        // THE FOLLOW-UP SHAPE, if a real embedder ever grows that
        // configuration: a suppress-during-eviction flag raised around
        // this loop and read by `close`'s resume (and by `speakDrawer`),
        // so a resume that is immediately undone by the same `open`
        // neither speaks nor rebuilds.
        let displaced = false;
        for (const other of tenants) {
          if (other === tenant) continue;
          if (!other.isOpen() || other.isSuspended()) continue;
          if (other.suspendableNow()) {
            other.suspend();
            displaced = true;
            continue;
          }
          other.close({ context: false });
        }
        // Re-entry with a NEW session closes the old one first (the
        // lightweight tenants are re-opened this way, and the old sheet's
        // resize listener must go with it). Re-entry with the SAME session
        // object is a claim being revealed — see `claim` — so it is not a
        // close.
        // CONTRACT: an exclusive tenant re-opened with a DIFFERENT session
        // would therefore run its full close (dropping whatever it held).
        // The demo never does this; the conservative reading is that a
        // second secret-collecting session must not inherit the first
        // one's state.
        if (session !== null && session !== s) tenant.close({ context: false });
        session = s;
        suspended = false;
        builder = build;
        spec.beforeShow?.(s);
        dimmedNow = typeof spec.dim === "function" ? spec.dim(s) : spec.dim === true;
        if (dimmedNow) dim.hidden = false;
        drawer.hidden = false;
        // The strip names the sheet hanging off it, in the same colour it
        // has always had (the anchor never changes colour per surface).
        setContext(spec.context(s));
        // A sheet arriving OVER a suspended occupant enters from the
        // right; one opening into an empty (or evicted) drawer grows up
        // out of the bar as it always has.
        present(s, displaced ? "right" : "up");
        // AFTER `present`, so the sentence is emitted only once the open
        // has actually succeeded — every refusal path above returns
        // before here, and a listener must not be told a sheet opened
        // that an exclusive occupant turned away.
        //
        // A DISPLACEMENT SPEAKS ONCE, not twice: `suspend` is silent by
        // design, because this very sentence is what tells the user
        // something new took the drawer. `update` and `rebuild` are
        // silent for the same economy — the sheet did not arrive or
        // leave, it changed, and narrating every re-present would bury
        // the transitions that matter.
        //
        // CONTRACT: this fires on every successful `open`, including the
        // re-entry-with-the-same-session case (a reserved `claim` being
        // revealed). That is the sheet's first appearance on screen, so
        // one announcement is correct there; a caller that re-opened an
        // ALREADY-PRESENTED session would get a second one, and should
        // be calling `rebuild` instead.
        speakDrawer("open");
        return true;
      },
    };
    tenants.push(tenant);
    return tenant;
  }

  const drawerHost: DrawerHost = {
    tenant: makeTenant,
    occupied,
    restoreContext,
    note: drawerNote,
    setNote: (el) => {
      noteEl = el;
    },
  };

  // THE TEACH FOR AN ORDINARY (NON-DEFERRED) EMBEDDER. Its word was
  // rolled up at `rollWord()` above, where `speak` did not exist yet, so
  // the teaching half waits until here — the last thing `initVisor`
  // does, and still strictly BEFORE the consumer's own fresh-anchor
  // announcement, which cannot run until this function has returned.
  // (A deferred embedder is taught by `claim()` instead; see there.)
  if (!deferred) teachFreshWord();

  return {
    // A GETTER, not the boot's value captured: under `deferClaim` the
    // answer legitimately changes once, at the claim, and a consumer
    // that read the property early would otherwise hold a stale `false`
    // forever — silently swallowing the one announcement a reset owes
    // the user.
    get fresh() {
      return fresh;
    },
    claim() {
      // IDEMPOTENT AND ORDER-INSENSITIVE. A second call (or a call on a
      // visor that was never deferred) reports the boot's answer and
      // touches nothing: the hue must be rolled EXACTLY once, or a
      // "fresh" that is announced twice would train users that the
      // anchor colour changes on its own.
      if (claimed) return { fresh };
      claimed = true;
      rollHue();
      // THE WORD ARRIVES WITH THE COLOUR, in the same call, for the same
      // reason the identity cluster does: they are one identity becoming
      // this user's, and a word rolled at any other moment would either
      // exist before the seal opened (something personal, pre-login) or
      // arrive later as a second, unexplained event. Same once-only
      // guarantee, too — `claimed` gates both rolls, so neither the
      // colour nor the word can be re-minted by a second call.
      rollWord();
      // Taught BEFORE `renderIdentity`, and — because `speak` is a
      // queue — strictly before whatever the consumer announces about
      // the fresh colour on the very next line of its own claim
      // handler.
      teachFreshWord();
      renderIdentity();
      return { fresh };
    },
    install(h) {
      if (h.requestNaming) handlers.requestNaming = h.requestNaming;
      if (h.requestSettings) handlers.requestSettings = h.requestSettings;
    },
    setContext,
    renderContext: () => renderContext({ keepAnnouncement: true }),
    renderIdentity,
    announce,
    pulseContext,
    setBack,
    identity: () => loadIdentity(config.identityKey),
    saveIdentity: (rec) => saveIdentity(config.identityKey, rec),
    addEvent: (text) => {
      eventStore.events.push({ at: Date.now(), text });
      // OLDEST OUT, and only ever by one per call, so the cap is a
      // sliding window rather than a periodic purge.
      if (eventStore.events.length > EVENTS_MAX) {
        eventStore.events.splice(0, eventStore.events.length - EVENTS_MAX);
      }
      persistEvents();
      syncBadge();
    },
    // A COPY, REVERSED: the caller gets newest-first without the stored
    // array — the one the cap and the watermark are computed against —
    // being handed out to be mutated from outside.
    events: () => [...eventStore.events].reverse(),
    markEventsSeen: () => {
      const newest = eventStore.events.length === 0
        ? 0
        : eventStore.events[eventStore.events.length - 1].at;
      // MAX, not `Date.now()`: a record written by a machine whose clock
      // is ahead (or restored from storage across a clock change) would
      // otherwise sit permanently above the watermark, and the badge
      // would re-light the instant it was cleared.
      eventStore.seenAt = Math.max(Date.now(), newest);
      persistEvents();
      syncBadge();
    },
    unseenEventCount,
    setCondition: (key, text) => {
      const fresh = !conditions.has(key);
      // `set` on an existing key keeps its INSERTION position, which is
      // what makes a re-assert a text refresh rather than a re-ordering
      // of a list the user is reading.
      conditions.set(key, text);
      syncBadge();
      return fresh;
    },
    clearCondition: (key) => {
      const had = conditions.delete(key);
      syncBadge();
      return had;
    },
    conditions: () => new Map(conditions),
    committedHue: () => {
      // A LOUD REFUSAL, not a plausible number. Pre-claim there is no
      // committed hue; anything returned here would be painted or
      // persisted as though the user had chosen it.
      if (!claimed) throw new Error("the visor is unclaimed: no committed hue before claim()");
      return committedHue;
    },
    applyHue: (h) => {
      // #89: THROWS WHILE UNCLAIMED, same reasoning as `committedHue` —
      // exactly one code path may put the first colour on the strip, and
      // it is `claim()`'s `rollHue()` (which calls `applyVisorHue`
      // directly, unguarded). A pre-claim preview would paint that first
      // colour instead.
      if (!claimed) throw new Error("the visor is unclaimed: no live preview before claim()");
      applyVisorHue(h);
    },
    commitHue: (h) => {
      // #89: THROWS WHILE UNCLAIMED — same single-first-paint invariant
      // as `applyHue`/`committedHue`, plus a persistence half: a
      // pre-claim commit would also write the consumer's hue key before
      // the seal opens.
      if (!claimed) throw new Error("the visor is unclaimed: no hue commit before claim()");
      committedHue = h;
      applyVisorHue(h);
      try {
        localStorage.setItem(config.hueKey, String(h));
      } catch { /* not durable here */ }
    },
    speakWord: () => {
      // A LOUD REFUSAL, not silence and not a placeholder: same reasoning
      // as `committedHue`. Pre-claim there is no word to say, and a
      // sentence naming any other token would teach the user something
      // false about what the visor will sound like.
      if (!claimed) throw new Error("the visor is unclaimed: no anchor word before claim()");
      speak(`your visor's word is ${committedWord}`);
    },
    rerollWord: () => {
      if (!claimed) throw new Error("the visor is unclaimed: no word re-roll before claim()");
      // DIFFERENT BY CONSTRUCTION (see `rollVisorWord`'s `avoid`): the
      // whole point of the control is that the old token stops working,
      // and the user has to be able to hear that it did.
      committedWord = rollVisorWord(committedWord);
      try {
        localStorage.setItem(config.wordKey, committedWord);
      } catch { /* not durable here */ }
      // "new", so a user who fires this twice can tell the second
      // sentence from an echo of the first — and so the sentence itself
      // says what just happened rather than merely reporting state.
      speak(`your visor's new word is ${committedWord}`);
    },
    erase() {
      // Best-effort per key, and each in its own try: storage can throw
      // (a locked-down embedding, a quota-ish failure on some engines),
      // and one key refusing must not leave the others behind — a
      // partial erase should be as small as the failure, not as large as
      // whatever happened to be first in the list.
      for (
        const key of [
          config.identityKey,
          config.hueKey,
          config.legacyHueKey,
          config.wordKey,
          config.eventsKey,
        ]
      ) {
        if (key === undefined) continue;
        try {
          localStorage.removeItem(key);
        } catch { /* nothing durable to remove from */ }
      }
    },
    drawer: drawerHost,
  };
}
