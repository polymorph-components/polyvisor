// The visor's OWN THREE CEREMONIES: naming a component, the user's
// settings for the visor itself, and erasing everything the visor holds
// on this device — plus the trust table all three read and write.
//
// This is the second half of the framework layer. visor/ui/visor.ts holds
// what a visor IS (the strip, the anchor colour, the identity record, the
// context line, the drawer host and its tenancy); this file holds the
// sheets EVERY consumer of that visor wants, because they are not any one
// app's content — they are the visor talking about itself and about the
// components it drew. A consumer that had to reimplement them would
// reimplement the petname triangle, the local-uniqueness rule and the
// live-preview/revert discipline, and would get one of them subtly wrong;
// the todomvc spike proved the milder version of that failure by
// rendering a clickable petname with no ceremony behind it at all.
//
// THE THIRD CEREMONY IS THE HEAVY ONE. Naming and settings are
// lightweight tenants (a mis-tap costs a form the user closes); the reset
// sheet destroys the user's whole visor-side memory of this device, so it
// wears the full weight — arming delay, page dim, a statement of
// consequence and a typed confirmation, in the shape pairing's add flow
// established (visor/ui/pairing.ts:700-770).
//
// It is a SEPARATE MODULE from visor.ts on purpose: visor.ts is the
// mechanism (geometry, tenancy, timing) and is consumed by things that
// register their own sheets; this is policy built ON that mechanism. A
// consumer takes visor.ts alone if it wants only the anchor, and both if
// it wants the ceremonies.
//
// WHAT IS PARAMETERISED AND WHAT IS NOT. The storage KEY of the trust
// table is the consumer's (two spikes on one origin must not share a
// table, exactly as they must not share an anchor hue or an identity
// record). Everything else — the palette, the assignment rule, the
// wording, the refusals — is the framework's, because those are the
// parts that carry the security argument.
//
// SCOPING DISCIPLINE, inherited unchanged from visor.ts: nothing here is
// written to the document root, handed to a guest, or put on the frame
// seam. Petnames in particular never cross it — see
// demo/scripts/check-invariants.sh check (a), and check (b), whose
// VISOR_RENDERERS list includes this file precisely because it renders
// visor-voiced strings.

import {
  APP_MARK_ICONS,
  foreignToken,
  identityIcon,
  IDENTITY_MAX,
  isAppMarkIcon,
  markIcon,
  nicknameQuote,
  type SurfaceIdentity,
  type Visor,
  VISOR_HUES,
  VISOR_ICONS,
  type VisorIdentity,
} from "./visor.ts";

// --- the trust table: pet icons, first sight, and the user's word -------------
//
// Surface marks: the recognition mark the visor shows for a component is
// a PET ICON the USER picks in the naming ceremony, from the visor's
// curated vocabulary (visor.ts's APP_MARK_ICONS) — never derived, and
// never chosen by the visor on the user's behalf.
//
// WHAT THIS REPLACED. The mark used to be a hue out of the anchor
// palette, rendered as a colour chip. The chip is gone (#22 discussion):
// the ANCHOR colour keeps every job it had — visor-vs-app contrast and
// the spoof lottery — but per-app colour MEMORY was the weak half of the
// scheme. "The blue one" is not something a user can name, rehearse or
// check, and ten hues run out after ten components. A glyph is nameable
// and discriminable, and the vocabulary is big enough that local
// uniqueness stays real.
//
// Two derivations died here BEFORE that change, both to the same attack,
// and the reasoning transfers to glyphs unchanged: making THE VISOR'S
// OWN STRIP vouch the wrong mark. Deriving from component bytes let an
// impersonator grind its artifact until the strip assigned it the
// target's mark (and reshuffled every legitimate update). Deriving from
// HMAC(user-secret, name) fixed the grind only to reopen it through the
// other input: names are self-declared, so declaring the target's name
// yields the target's mark. Anything copyable is trivially fakeable
// INSIDE an attacker's rectangle; the strip is the only place it means
// anything, so what renders there must not be a function of anything an
// attacker chooses. USER CHOICE is the strongest version of that: the
// mark is a function of a gesture made in visor pixels.
//
// A component may NOMINATE a glyph (see `SurfaceIdentity.nomination`),
// which is not a derivation and not an assignment: the nomination is one
// offer among six inside the ceremony, foreign-attributed, and the
// component is never told whether it was taken.
//
// Assignment also buys the property no derivation can: LOCAL
// UNIQUENESS. Icons are offered from the unused set, so two trust
// records on this device never share a mark while the vocabulary lasts.
//
// The record key must be unforgeable PROVENANCE, never self-declared
// identity — a name that can look up someone else's record is the same
// attack through the table. In the spikes the key is the artifact name AS
// FETCHED BY THE VISOR from its own origin (visor-verified provenance);
// when signed releases and publisher identity land (#3, #10), it becomes
// the publisher's verifying key. Durability follows the visor-hue story:
// these live with device state (#11), and a lost table means reassignment
// — visible, so it must be announced, never silent.
//
// THREE NAMES, STRICTLY SEPARATED (the petname triangle):
//   KEY       — the artifact name the visor fetched itself. Unforgeable
//               provenance; the only thing that may address a record.
//   NICKNAME  — what the component calls itself (`nickname()`).
//               Self-declared, so it is rendered as foreign-quoted text
//               and is never a key, never the visor's own voice.
//   PETNAME   — what the USER calls it, typed in the visor's pixels and
//               stored in the record. The visor speaks this one in its own
//               voice, because the user wrote it.
// The demotion is the point: once a petname exists, the component's
// self-description drops to a footnote ("calls itself …") and the name
// with authority is the one the user chose.

export interface SurfaceMark {
  /** THE PET ICON, a member of `APP_MARK_ICONS` — or "" for UNMARKED.
   *
   * "" IS A REAL, HONEST STATE, not a missing value: a record can have a
   * first-sight timestamp, and even a petname, with no icon. That is
   * what a component looks like before the user has picked a mark for
   * it, what a record MIGRATED from the old `hue` schema looks like
   * (see `load` — a hue is not silently reinterpreted as a glyph), and
   * what a mark looks like after the partition's conflict repair cleared
   * the losing side's icon. All three render the same way: no glyph. */
  icon: string;
  firstSeen: number;
  /** THE PETNAME: the user's own word for this component, typed in
   * the visor's own pixels and stored beside the mark. Optional — records
   * written before petnames existed stay valid and simply have none, so
   * there is no migration and an unnamed component keeps working exactly
   * as it did. It is NEVER a key (the key is provenance, above) and it
   * NEVER crosses the frame seam: no component may learn, influence, or
   * collide with the word the user chose for it. */
  petname?: string;
}

/** The trust table, as a consumer sees it.
 *
 * EVERY METHOD IS STATELESS: each one reads (and writes) localStorage
 * afresh, holding nothing between calls. That is what makes it safe for a
 * consumer to build one of these early — before the drawer tenants can be
 * registered in their precedence order — and for `registerVisorSheets` to
 * build its own over the same key: two facades on one key are the same
 * table, not two caches that can disagree. (The demo depends on exactly
 * this: it registers the app's row at boot, long before the sheets are
 * registered behind the credential tenant.) */
export interface SurfaceMarks {
  /** The whole table, for a consumer that renders from it (the demo
   * looks petnames up per pane) and for driving/inspection. */
  load(): Record<string, SurfaceMark>;
  /** The record for this provenance key, CREATING one — first-sight
   * timestamp, and NO icon — if there is none yet. `isNew` is the TOFU
   * moment: true exactly on the boot that created the record.
   *
   * A fresh record is deliberately UNMARKED: the visor does not roll a
   * pet icon on the user's behalf. A mark the user did not choose is a
   * mark they cannot recognise, and inventing one would put a glyph on
   * the anchor in the visor's own voice about a component the user has
   * never said a word about. The ceremony is where marks come from. */
  mark(provenance: string): { mark: SurfaceMark; isNew: boolean };
  /** Commit a petname + pet icon for one record. `icon` must be a member
   * of `APP_MARK_ICONS`, or "" for unmarked; anything else is stored as
   * "" rather than trusted. */
  setPetname(provenance: string, petname: string, icon: string): void;
  /** Delete the WHOLE record — mark, first-sight timestamp and petname
   * together. Forgetting must be honest: a component whose petname was
   * dropped but whose mark survived would still be greeted as familiar.
   * After this the next mount is genuinely NEW again. */
  forget(provenance: string): void;
  /** DROP THE WHOLE TABLE — the marks half of the reset ceremony, and
   * nothing else's business. Per-record forgetting stays `forget`; this
   * one exists because the erase ceremony must not have to enumerate
   * records to be complete (a record the enumeration missed would come
   * back wearing a mark and a name after a wipe the user was told was
   * total). The key itself is removed rather than overwritten with an
   * empty table, so what is left behind is indistinguishable from a
   * device that never had one. */
  eraseAll(): void;
  /** The pet icons no OTHER record is using. Local uniqueness is the
   * property assignment buys, so the ceremony only ever offers marks
   * that keep it. This record's OWN icon is included (re-picking what
   * you already wear is not a collision). */
  freeIcons(provenance: string): string[];
  /** THE CEREMONY'S SIX OFFERS, in render order.
   *
   * `nomination` is the glyph the component asked to wear, ALREADY
   * VALIDATED by the consumer at the seam (`isAppMarkIcon` — see
   * `SurfaceIdentity.nomination`). It is offered FIRST, and flagged so
   * the sheet can attribute it to the component rather than to the
   * visor — but only if it is genuinely free; a nomination for a glyph
   * another record already wears is DROPPED SILENTLY, exactly like an
   * invalid one. The component learns nothing either way: nothing about
   * the picker or its outcome ever crosses the seam (the same discipline
   * as invariant (e)).
   *
   * When this record already HAS a mark, that glyph is always among the
   * offers (the sheet preselects it), so opening the ceremony to change
   * a petname cannot silently cost a component its mark.
   *
   * The rest are drawn AT RANDOM from the free set, freshly per
   * ceremony. That randomness is deliberate and ecosystem-scale: a
   * stable global ordering would mean every user on every device sees
   * the same first few glyphs, so an app's nomination would win by
   * default-bias alone and a de-facto brand would form out of nothing
   * but list order. Marks are the USER's vocabulary, not a namespace to
   * be squatted. */
  iconOffers(
    provenance: string,
    nomination?: string,
  ): Array<{ glyph: string; nominated: boolean }>;
  /** Is this word already the user's name for a DIFFERENT component?
   * Two records answering to one word would defeat the whole point of a
   * petname — the user would have no way to tell which one is speaking.
   * Compared trimmed and case-insensitively; returns the colliding record
   * (its petname as the user wrote it, and its unforgeable provenance key)
   * so the visor can say, in its own words, what the clash is. */
  collision(provenance: string, petname: string): { key: string; petname: string } | null;
}

/** How many marks the naming ceremony offers. Six: enough that the
 * choice feels like a choice and a nomination cannot be the only thing
 * on screen, few enough to scan in one glance on a phone. */
export const ICON_OFFERS = 6;

/** Build a facade over one consumer's trust table. Stateless — see
 * `SurfaceMarks`. */
export function createSurfaceMarks(marksKey: string): SurfaceMarks {
  /** Read the table, NORMALISING every record on the way out.
   *
   * This is also the `hue` -> `icon` MIGRATION (#22 discussion), and it
   * is deliberately a lossy one: a record written under the old schema
   * carries a palette index, and there is no honest way to turn a number
   * into a glyph the user would recognise. So it becomes UNMARKED. The
   * visor does not invent a mark and pretend the user picked it — that
   * would be the announced-never-silent rule broken by a schema change,
   * which is the quietest possible way to break it. The strip simply
   * shows no glyph until the user next opens the ceremony, and the
   * petname and first-sight date (the parts that ARE the user's) survive
   * untouched.
   *
   * Storage is hand-editable, so this is ALSO the read-side gate: an
   * icon that is not a member of the curated vocabulary is read as ""
   * rather than rendered (see `isAppMarkIcon` for what that refuses and
   * why). Normalisation is not written back — a read is a read — so it
   * is idempotent and cannot corrupt a record it merely displayed. */
  const load = (): Record<string, SurfaceMark> => {
    try {
      const raw = JSON.parse(localStorage.getItem(marksKey) ?? "{}");
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, SurfaceMark> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const rec = value as Record<string, unknown>;
        const icon = typeof rec.icon === "string" && isAppMarkIcon(rec.icon) ? rec.icon : "";
        const mark: SurfaceMark = {
          icon,
          firstSeen: typeof rec.firstSeen === "number" ? rec.firstSeen : Date.now(),
        };
        if (typeof rec.petname === "string" && rec.petname.trim() !== "") {
          mark.petname = rec.petname;
        }
        out[key] = mark;
      }
      return out;
    } catch {
      return {};
    }
  };

  /** The icons no OTHER record wears — see `SurfaceMarks.freeIcons`. A
   * plain function rather than a method so that neither the facade's own
   * `iconOffers` nor a destructuring consumer depends on `this`. */
  const freeIcons = (provenance: string): string[] => {
    const used = new Set(
      Object.entries(load())
        .filter(([k]) => k !== provenance)
        .map(([, m]) => m.icon)
        .filter((i) => i !== ""),
    );
    return APP_MARK_ICONS.filter((g) => !used.has(g));
  };

  const save = (table: Record<string, SurfaceMark>): void => {
    try {
      localStorage.setItem(marksKey, JSON.stringify(table));
    } catch { /* nothing durable to write to */ }
  };

  return {
    load,
    mark(provenance) {
      const table = load();
      const existing = table[provenance];
      if (existing) return { mark: existing, isNew: false };
      // NO ICON IS ROLLED HERE. First sight creates the record and the
      // timestamp; the MARK is the user's to choose, in the ceremony.
      const mark: SurfaceMark = { icon: "", firstSeen: Date.now() };
      table[provenance] = mark;
      save(table);
      return { mark, isNew: true };
    },
    setPetname(provenance, petname, icon) {
      const table = load();
      const mark = table[provenance] ?? { icon: "", firstSeen: Date.now() };
      // The write-side gate, mirroring `load`'s read-side one: a glyph
      // that is not in the curated vocabulary is stored as UNMARKED
      // rather than persisted and rendered later.
      mark.icon = isAppMarkIcon(icon) ? icon : "";
      mark.petname = petname;
      table[provenance] = mark;
      save(table);
    },
    forget(provenance) {
      const table = load();
      delete table[provenance];
      save(table);
    },
    eraseAll() {
      try {
        localStorage.removeItem(marksKey);
      } catch { /* nothing durable to remove from */ }
    },
    freeIcons,
    iconOffers(provenance, nomination) {
      const free = freeIcons(provenance);
      const mine = load()[provenance]?.icon ?? "";
      const offers: Array<{ glyph: string; nominated: boolean }> = [];
      const taken = new Set<string>();
      const push = (glyph: string, nominated: boolean) => {
        if (glyph === "" || taken.has(glyph)) return;
        taken.add(glyph);
        offers.push({ glyph, nominated });
      };
      // FIRST, and only if it survives BOTH tests: valid (the consumer
      // checked that at the seam) and unclaimed. A claimed nomination is
      // dropped in silence — telling the user "the app wanted a glyph
      // somebody else has" would be the visor relaying a component's
      // request in the visor's own voice, for no decision the user has
      // to make.
      if (nomination !== undefined && isAppMarkIcon(nomination) && free.includes(nomination)) {
        push(nomination, true);
      }
      // The mark this record already wears, so a rename cannot lose it.
      push(mine, false);
      // The rest: a fresh shuffle of the free set, per ceremony (see
      // `iconOffers` on the interface for why the order must not be
      // stable). Fisher-Yates over a copy — the pool is the caller's
      // array, and shuffling it in place would be a surprise.
      const pool = free.filter((g) => !taken.has(g));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const g of pool) {
        if (offers.length >= ICON_OFFERS) break;
        push(g, false);
      }
      return offers.slice(0, ICON_OFFERS);
    },
    collision(provenance, petname) {
      const want = petname.trim().toLowerCase();
      for (const [key, mark] of Object.entries(load())) {
        if (key === provenance) continue;
        const other = (mark.petname ?? "").trim();
        if (other !== "" && other.toLowerCase() === want) return { key, petname: other };
      }
      return null;
    },
  };
}

// --- the two sheets -----------------------------------------------------------

export interface VisorSheetsConfig {
  /** Where THIS consumer's trust table lives. The pet-icon vocabulary
   * and the assignment rule are the framework's; the key is the
   * consumer's, so two spikes on one origin do not share a table. */
  marksKey: string;
  /** Asked before either ceremony opens; false refuses the open outright.
   * This is where a consumer states a precedence its own tenants impose —
   * the demo refuses while its exclusive credential sheet holds the
   * drawer, so a click on the strip while secrets are on screen is a
   * no-op. The drawer host enforces the same rule a second time on
   * `open`; this one exists so the consumer's own preconditions
   * (`beforeOpen`) do not run for an open that is going to be refused. */
  canOpen?: () => boolean;
  /** Run just before either ceremony opens, once `canOpen` has agreed.
   * The demo takes the page back here: a modal <dialog> paints in the TOP
   * LAYER — above the pinned visor zone, and therefore above the sheet
   * the strip is about to reveal — so its panel is retired and the dialog
   * closed first. */
  beforeOpen?: () => void;
  /** A petname + pet icon were just committed for `provenance`. The
   * table is already written; this is for the consumer's IN-MEMORY
   * CACHES of the record (the strip renders from those, so a commit that
   * only touched storage would leave the anchor showing yesterday's
   * answer).
   *
   * `isNew` is deliberately not passed: FIRST SIGHT IS OVER — the naming
   * ceremony IS the TOFU moment completing, so every live copy of this
   * identity should clear its NEW badge. "First time this component draws
   * here" and the user's own name for it are contradictory claims to make
   * side by side. */
  onNamed?: (provenance: string, petname: string, icon: string) => void;
  /** The whole record for `provenance` was just deleted. The consumer's
   * caches must stop speaking a name the visor no longer holds. */
  onForgotten?: (provenance: string) => void;
  /** The identity record and the anchor hue were just COMMITTED from the
   * settings sheet (Save, never Cancel and never a live preview). The
   * visor has already stored and painted both; this is for a consumer
   * that must MIRROR the commit somewhere else — the demo writes it
   * through to the user-system partition, where the profile is the
   * source of truth and localStorage is the boot cache (PAIRING.md §5).
   *
   * It fires AFTER the write, so a consumer that fails cannot leave the
   * visor's own record half-committed; a mirror that fails is the
   * consumer's problem to announce. */
  onIdentityCommitted?: (rec: VisorIdentity, hue: number) => void;
  /** THE CONSUMER'S NESTED PLACE, if it has one on screen.
   *
   * A lightweight ceremony at HOME dims nothing and freezes nothing:
   * naming a component is not secret entry, and a tax paid where nothing
   * is spent teaches users to click through delays that mean something
   * elsewhere. A ceremony over a NESTED PLACE is different — the demo's
   * provider-config page has a live component surface on it, and a
   * component soliciting input underneath a visor ceremony is exactly
   * the interleaving the anchor exists to stop. So while the consumer
   * says it is showing such a place, the ceremony BRACKETS it: the
   * visor's own dim goes up (the host, from `dim`) and the consumer
   * freezes the place itself (`freeze`, undone by `thaw`).
   *
   * FREEZE IS NOT RETIREMENT. The component stays live and keeps its
   * grants; what it loses for the duration is the user's input. A
   * ceremony is not a reason to destroy a session the user is in the
   * middle of — they are coming back to it. */
  nestedPlace?: {
    active(): boolean;
    freeze(): void;
    thaw(): void;
  };
  /** THE CONSUMER'S OWN HALF OF THE ERASE. The reset ceremony wipes what
   * the VISOR holds (the identity record, the anchor hue, the trust
   * table); a consumer holds the rest — boot caches, its storage
   * configuration, keystores, whatever it built on top. This is where it
   * drops them, and it may be async because most of those live in
   * IndexedDB.
   *
   * IT RUNS FIRST, BEFORE THE VISOR ERASES ANYTHING OF ITS OWN, and the
   * ordering is the whole design: this is the FALLIBLE half. If it
   * throws, the ceremony refuses with a reason line and NOTHING has been
   * forgotten yet — the user is looking at a visor that still holds
   * everything it held a second ago, which is a true sentence the sheet
   * can say. Doing the infallible half first would buy a state nobody can
   * describe: a visor with no name, no colour and no marks, in front of a
   * consumer that still has every cache it had.
   *
   * THIS IS THE EXACT INVERSE OF `onIdentityCommitted`, deliberately.
   * There the visor writes FIRST and the consumer mirrors after, because
   * a mirror can only ever be LATE, never contradictory. An erase inverts
   * the risk — a late erase is a record that survived a wipe — so the
   * rule inverts with it: fallible first, infallible last. */
  onReset?: () => void | Promise<void>;
  /** EXTRA LINES IN THE RESET SHEET'S STATEMENT OF CONSEQUENCE — what
   * ELSE this particular consumer is about to destroy, which only it
   * knows ("your saved storage provider", "the devices you paired").
   * Rendered by the visor, in the visor's own chrome, one line each,
   * after the framework's own lines.
   *
   * SAME DISCIPLINE AS `SheetAction.label`: these must be the CONSUMER'S
   * OWN WORDS. A consumer that put a component-influenced string here
   * would be lending the visor's voice — and worse than on a button,
   * because these lines are the sentence the user is about to act on.
   * The visor cannot check it; the rule is the consumer's to keep
   * (nothing on this path is component-influenced in either spike). */
  resetConsequences?: string[];
  /** Consumer-supplied actions on the settings sheet.
   *
   * THE ONE EXTENSION POINT ON A VISOR-OWNED SHEET, and deliberately a
   * narrow one: a consumer contributes a LABEL and a callback, never a
   * node. The visor draws the button, in the visor's own chrome, so a
   * consumer cannot paint anything on a sheet whose whole claim is that
   * no one but the visor draws there — the same reason the identity
   * button's face is a fixed glyph set rather than free text.
   *
   * The demo uses exactly one: "add a device…", the entry to the pairing
   * ceremony (PAIRING.md §5's "strip menu → add a device"). TodoMVC
   * passes none, and an empty list renders NOTHING — no heading, no
   * container, no separator — so the sheet is byte-identical to what it
   * was before this hook existed. */
  extraActions?: SheetAction[];
}

/** One consumer-contributed action on the settings sheet (see
 * `VisorSheetsConfig.extraActions`). */
export interface SheetAction {
  /** The button's face. The visor renders it as its own words — a
   * consumer that puts a component's self-declared string here would be
   * lending the visor's voice, which is the consumer's error to avoid
   * (nothing on this path is component-influenced in either spike). */
  label: string;
  /** One line under the button, in the visor's explanatory voice. */
  hint?: string;
  /** Stable key for driving/tests (`data-action`). Defaults to `label`. */
  key?: string;
  onSelect(): void;
}

export interface VisorSheets {
  /** The trust table these sheets read and write — the same key, so a
   * consumer can render from it. */
  readonly marks: SurfaceMarks;
  /** Open the naming ceremony (the App settings sheet) for one surface.
   * Installed as the strip's `requestNaming` handler, so the ceremony is
   * reachable from visor pixels; exposed here for a consumer's own
   * driving hooks. */
  requestNaming(surface: SurfaceIdentity): void;
  /** Open the visor's own settings sheet. Installed as the strip's
   * `requestSettings` handler. */
  requestSettings(): void;
  /** Open the erase ceremony. Reachable in the UI ONLY from the settings
   * sheet's danger entry; exposed here for a consumer's driving hooks and
   * for the e2e suite. */
  requestReset(): void;
  closeNaming(opts?: { context?: boolean }): void;
  closeSettings(opts?: { context?: boolean; commit?: boolean }): void;
  closeReset(opts?: { context?: boolean }): void;
  namingOpen(): boolean;
  settingsOpen(): boolean;
  resetOpen(): boolean;
}

/** Register the visor's naming and settings ceremonies on a visor.
 *
 * REGISTRATION ORDER IS PRECEDENCE ORDER (see `DrawerHost.tenant`), so
 * WHERE a consumer calls this matters: a consumer with an EXCLUSIVE
 * tenant of its own — the demo's credential sheet — must register that
 * one FIRST, so the sheet that may be holding secrets outranks both of
 * these. Both tenants registered here are LIGHTWEIGHT: they take the
 * reveal above the strip (the unforgeable part) but not the arming delay,
 * the runner suspension or the page dim, because nothing secret is typed
 * on either, both are opened from strip pixels an app can neither draw
 * nor reach, and the worst a mis-tap costs is a form the user closes.
 * Paying the arming tax where it buys nothing would train users to click
 * through a delay that means something elsewhere, which is the real cost.
 *
 * This also INSTALLS the strip's two handlers (`requestNaming`,
 * `requestSettings`), which is what makes the strip's petname and settings
 * button live. */
export function registerVisorSheets(visor: Visor, config: VisorSheetsConfig): VisorSheets {
  const marks = createSurfaceMarks(config.marksKey);

  /** The bracket a ceremony puts around a consumer's nested place — see
   * `nestedPlace`. Shared by both lightweight tenants, because "a
   * ceremony over a place freezes that place" is a property of
   * ceremonies, not of which one. */
  const overNestedPlace = () => config.nestedPlace?.active() === true;
  const freezePlace = () => {
    if (overNestedPlace()) config.nestedPlace?.freeze();
  };
  // Unconditional, and idempotent on the consumer's side: the place may
  // have been LEFT while the ceremony was up (the demo's chevron walks
  // the page out from under an open naming sheet — sheets are orthogonal
  // to navigation), so "are we still over it?" is the wrong question to
  // ask when undoing.
  const thawPlace = () => config.nestedPlace?.thaw();

  /** THE NAMING SESSION. The session's `surface` is REASSIGNED after a
   * Save (the sheet may outlive the click, and a re-open is built from
   * this object), so the host holds the object rather than a copy. */
  const namingTenant = visor.drawer.tenant<{ surface: SurfaceIdentity; icon: string }>({
    name: "naming",
    // The sheet is the naming ceremony GROWN into everything the visor
    // knows about one component, so it is announced by what it IS now,
    // not by the identifier it kept. Framework vocabulary throughout:
    // the component's own nickname is app-influenced and must never
    // reach a flat spoken sentence.
    spoken: "app settings",
    context: (s) => ({ ...s.surface, kind: "naming" }),
    dim: overNestedPlace,
    beforeShow: freezePlace,
    afterCollapse: thawPlace,
  });

  /** TRUE ONLY FOR THE SYNCHRONOUS DURATION OF THE ERASE ENTRY (raised
   * and lowered around `requestReset()` in the reset button's handler),
   * and read by the tenant's `suspendable` below.
   *
   * The flag is what scopes suspension to exactly the settings→reset
   * step. Suspension means "one step further into a ceremony you will
   * come back from", which is true of the erase entry — the user leaves
   * settings to answer a question settings asked, and Cancel means
   * "back to what I was doing" — and NOT true of anything else that
   * displaces this sheet. A naming ceremony opened from the strip, the
   * storage picker, an add-device flow and a consumer's own exclusive
   * sheet are all separate errands started from outside; for those,
   * plain eviction (and a deliberate re-open) is what a user expects,
   * and a settings sheet sliding back in afterwards would be a ghost. */
  let settingsSuspends = false;

  /** THE SETTINGS SESSION. `hueAtOpen` is the colour the anchor had when
   * the sheet opened: the swatch row previews LIVE, so Cancel (and
   * eviction) must be able to put the anchor back exactly as it was.
   * `commit` — passed by Save and by nothing else — is what distinguishes
   * them. An uncommitted preview must not survive the sheet: a credential
   * sheet that evicts this one is painted in the anchor colour, and it
   * must be painted in the REAL one. */
  const settingsTenant = visor.drawer.tenant<{ hueAtOpen: number }>({
    name: "settings",
    // "visor settings", not "settings": the app-settings sheet above is
    // also settings, and a listener told only "settings open" cannot
    // tell which of the two arrived.
    spoken: "visor settings",
    context: () => ({ kind: "settings" }),
    suspendable: () => settingsSuspends,
    dim: overNestedPlace,
    beforeShow: freezePlace,
    beforeCollapse: (s, opts) => {
      if (!opts.commit) visor.applyHue(s.hueAtOpen);
    },
    afterCollapse: thawPlace,
  });

  /** THE ERASE SESSION, registered AFTER settings so the two lightweight
   * tenants keep the precedence they had and this one sits behind them
   * in `restoreContext`'s order. It carries no state: there is nothing to
   * preview, nothing to revert, and the only thing the user can put into
   * it is the typed confirmation, which must never outlive the sheet.
   *
   * IT IS THE OPPOSITE WEIGHT CLASS FROM THE OTHER TWO, and deliberately
   * so. The registration comment above explains why naming and settings
   * refuse the arming tax: nothing secret is typed on either and the
   * worst a mis-tap costs is a form the user closes — and paying the tax
   * where it buys nothing would train users to click through a delay that
   * means something elsewhere. THIS SHEET IS THE CASE THAT RATIONALE
   * RESERVES THE DELAY FOR. A mis-tap here is not a form; it is the
   * user's whole visor-side memory of this device, with no undo. So it
   * pays the full price: `armed` (a baited tap sequence cannot reach the
   * erase button, which does not exist as a live control until ARM_MS has
   * passed) and `dim` (the page behind it stops competing for the gesture
   * while the user reads a statement of consequence). */
  const resetTenant = visor.drawer.tenant<Record<string, never>>({
    name: "reset",
    // Named by the ACT, not by the noun: this is the one sheet where a
    // user who mis-navigated needs to know it from the first syllable.
    spoken: "erase this visor",
    armed: true,
    dim: true,
    context: () => ({ kind: "reset" }),
  });

  const closeNaming = (opts: { context?: boolean } = {}) => namingTenant.close(opts);
  const closeSettings = (opts: { context?: boolean; commit?: boolean } = {}) =>
    settingsTenant.close(opts);
  const closeReset = (opts: { context?: boolean } = {}) => resetTenant.close(opts);

  /** Build the visor's App settings sheet — the naming ceremony GROWN into
   * the one place the visor says everything it knows about a component.
   * EVERY pixel here is the visor's. The only component-influenced strings
   * are the nickname, the provenance key and (for a panel) its declared
   * destination — all in APP VOICE through `foreignToken`: quoted,
   * clamped, monospaced and plated.
   *
   * It is the SAME tenant and the same session variable as the old
   * naming sheet: evolved, not added to. A fourth drawer tenant would
   * have meant a fourth entry in every occupancy test (see
   * the host's occupancy test), for a sheet that is about exactly what naming was
   * about — this component, and what the user wants to call it. */
  const buildNameSheet = (surface: SurfaceIdentity, icon: string) => {
    const root = document.createElement("div");
    root.className = "cred-sheet name-sheet armed";
    root.style.maxWidth = "72rem";
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "App settings";

    // THE IDENTITY BLOCK — the two voices that are not the user's: what
    // the component says about itself, and what the visor fetched it as.
    const says = document.createElement("div");
    says.className = "cred-line";
    const saysLead = document.createElement("span");
    saysLead.className = "said";
    saysLead.textContent = "calls itself";
    // The record's pet icon, when it has one — same rule as the strip:
    // no mark, no glyph, no placeholder.
    const currentIcon = markIcon(icon);
    if (currentIcon) says.append(currentIcon);
    says.append(saysLead, nicknameQuote(surface.nickname));

    const from = document.createElement("div");
    from.className = "cred-line";
    const fromLead = document.createElement("span");
    fromLead.className = "said";
    fromLead.textContent = "the visor fetched it as";
    // APP VOICE through the one door: `<q>` as before, same clamp, same
    // rendered text — the provenance key is machine-supplied, so it is
    // plated rather than spoken in the visor's sentence.
    from.append(fromLead, foreignToken(surface.name, { maxLen: 60 }));

    // FIRST SIGHT, from the trust record itself: the date the mark was
    // assigned. This is the visor's own memory of the component, and the
    // only thing on the sheet that answers "have I really seen this
    // before?" with something other than a colour.
    const seen = document.createElement("div");
    seen.className = "cred-line";
    if (surface.firstSeen !== undefined) {
      const seenLead = document.createElement("span");
      seenLead.className = "said";
      seenLead.textContent = "first seen";
      const when = document.createElement("span");
      when.textContent = new Date(surface.firstSeen).toLocaleDateString();
      seen.append(seenLead, when);
    }

    // THE METADATA BLOCK — visor-known facts about this surface, when
    // there are any: a panel's declared destination, or the regions
    // the visor drew the app into. A component-influenced value is
    // rendered in app voice like every other thing a component said.
    const meta = document.createElement("div");
    meta.className = "cred-line";
    if (surface.meta) {
      const metaLead = document.createElement("span");
      metaLead.className = "said";
      // THE VISOR'S word, always — `label` is never component-supplied.
      metaLead.textContent = surface.meta.label;
      if (surface.meta.foreign) {
        meta.append(metaLead, foreignToken(surface.meta.value, { maxLen: 120 }));
      } else {
        const value = document.createElement("span");
        value.textContent = surface.meta.value.slice(0, 120);
        meta.append(metaLead, value);
      }
    }

    const field = document.createElement("div");

    field.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = "Your name for it";
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 40;
    // NEVER PREFILLED FROM THE NICKNAME. A prefilled self-declared name
    // would let attacker-chosen words walk into the visor's voice by
    // accept-the-default — the user would "assign" a petname they never
    // wrote, and the visor would then speak it unquoted, which is exactly
    // the authority the whole three-name split exists to withhold. An
    // EXISTING petname is prefilled, because that one the user typed.
    input.value = surface.petname ?? "";
    input.placeholder = "a word you will recognise";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "the visor will use this name in its own voice; what the component calls itself stays quoted";
    field.append(label, input, hint);

    // THE PET ICON PICKER (was the recognition-colour swatch row).
    //
    // Six offers, every one of them a glyph no other trust record wears
    // (local uniqueness — see `iconOffers`), in a fresh random order per
    // ceremony. The record's CURRENT mark is always among them and comes
    // preselected, so opening this sheet to fix a typo in a petname can
    // never cost a component its mark by accident.
    //
    // A record with NO mark starts with nothing selected, and Save is
    // perfectly happy with that: "" is a real state, and a user who does
    // not want to think about glyphs today gets a petname and no mark
    // rather than a mark the visor picked for them. THIS IS ALSO THE
    // RE-OFFER PATH for a mark the account's conflict repair cleared:
    // the engine resolves an icon collision by clearing the LOSER's icon
    // and setting needs-reconfirm, and it does not choose a replacement
    // — it cannot, because the vocabulary and the curation rules are the
    // VISOR's, not the partition's. So the repaired record arrives here
    // unmarked and the ceremony simply offers six free glyphs again.
    const iconLabel = document.createElement("div");
    iconLabel.className = "cred-line said";
    iconLabel.textContent = "a mark you will recognise";
    const offers = marks.iconOffers(surface.name, surface.nomination);

    // THE FOREIGN ATTRIBUTION. A component may ask to wear a particular
    // glyph, and when the ask survives validation and is unclaimed it is
    // offered FIRST — but it is never offered in the visor's own voice.
    // The visor says the sentence; the component's glyph is quoted, the
    // same way its nickname is, and the button carries `.nominated` so
    // it is visually not one of the visor's own offers. Adoption is the
    // USER's act, and the component is never told the outcome.
    const nominationLine = document.createElement("div");
    nominationLine.className = "cred-line name-nomination";
    const nominated = offers.find((o) => o.nominated);
    if (nominated) {
      const asksLead = document.createElement("span");
      asksLead.className = "said";
      asksLead.textContent = "it asks to wear";
      const asksTail = document.createElement("span");
      asksTail.className = "said";
      asksTail.textContent = "— offered first below; the rest are the visor's own";
      // The nominated glyph is the one component-influenced string in the
      // ceremony: app voice, quoted and plated, clamped by the validated
      // vocabulary anyway (a single BMP scalar — `isAppMarkIcon`).
      nominationLine.append(asksLead, foreignToken(nominated.glyph), asksTail);
    }

    const iconRow = document.createElement("div");
    iconRow.className = "name-icons";
    let picked = isAppMarkIcon(icon) ? icon : "";
    const buttons: HTMLButtonElement[] = [];
    for (const offer of offers) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = offer.glyph;
      b.dataset.glyph = offer.glyph;
      if (offer.nominated) b.dataset.nominated = "true";
      // THE VISOR'S OWN WORDS on both, and no component string in
      // either: the nominated one is described, never quoted, here.
      b.title = offer.nominated ? "the component asked for this one" : "use this mark";
      b.classList.toggle("nominated", offer.nominated);
      b.classList.toggle("picked", offer.glyph === picked);
      b.onclick = () => {
        picked = offer.glyph;
        for (const other of buttons) other.classList.toggle("picked", other === b);
      };
      buttons.push(b);
      iconRow.append(b);
    }

    const reason = document.createElement("div");
    reason.className = "cred-reason";

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and the name you choose is never given back to it";

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    // Forgetting is offered only when there is something to forget.
    let forgetBtn: HTMLButtonElement | null = null;
    const forgetRow = document.createElement("div");
    forgetRow.className = "name-forget";
    if ((surface.petname ?? "").trim() !== "") {
      forgetBtn = document.createElement("button");
      forgetBtn.type = "button";
      forgetBtn.className = "forget";
      forgetBtn.textContent = "forget this component";
      const forgetNote = document.createElement("span");
      forgetNote.className = "hint";
      forgetNote.textContent = "drops the name AND the mark — next time it is NEW again";
      forgetRow.append(forgetBtn, forgetNote);
    }

    root.append(h, says, from);
    if (surface.firstSeen !== undefined) root.append(seen);
    if (surface.meta) root.append(meta);
    root.append(field, iconLabel);
    if (nominated) root.append(nominationLine);
    root.append(iconRow, note, reason, row);

    if (forgetBtn) root.append(forgetRow);
    return { root, input, saveBtn, cancelBtn, forgetBtn, reason, icon: () => picked };
  };

  const openNamingDrawer = (surface: SurfaceIdentity) => {
    // MUTUAL EXCLUSION is the host's: it refuses this open outright while
    // an exclusive tenant holds the drawer (a sheet that is collecting —
    // or about to accept — secrets is never displaced by a naming
    // ceremony), and it evicts the settings sheet and any previous naming
    // sheet, in that order, WITHOUT touching the strip context, which
    // this sheet is about to claim. The two LIGHTWEIGHT tenants evict
    // each other freely — neither holds anything a user would lose by a
    // click on the strip.
    const session = { surface, icon: surface.icon };
    namingTenant.open(session, () => {
      const built = buildNameSheet(surface, surface.icon);

      const finish = (status: string) => {
        closeNaming();
        // The visor's own line in the visor's own bar — not a consumer's
        // status line: this is a statement about the shell's trust table,
        // not about anybody's replica. It expires by RE-RENDERING the
        // strip (see `announce`), which matters exactly here: the thing
        // the bottom line shows has just changed — a petname was
        // assigned, or a whole record was forgotten — so restoring what
        // the line said before would put a stale claim back on the
        // anchor.
        if (status) visor.announce(status);
      };

      built.saveBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        const petname = built.input.value.trim();
        if (petname === "") {
          // Refused rather than treated as "forget": clearing the field is
          // an ambiguous gesture, and Cancel is the unambiguous way out.
          built.reason.textContent = "type a name, or Cancel to leave it unnamed";
          return;
        }
        const clash = marks.collision(surface.name, petname);
        if (clash) {
          // The visor's own words, naming the colliding record by BOTH its
          // petname and its unforgeable provenance key — the user needs to
          // know which component already answers to this word.
          built.reason.textContent =
            `you already call another component "${clash.petname}" (fetched as ${clash.key}) — pick a different name`;
          return;
        }
        marks.setPetname(surface.name, petname, built.icon());
        // The consumer's in-memory surfaces are a CACHE of the record; the
        // strip renders from them, so a commit that only touched storage
        // would leave the anchor showing yesterday's answer.
        //
        // FIRST SIGHT IS OVER: the naming ceremony IS the TOFU moment
        // completing, so the NEW badge is cleared on every live copy of
        // this identity. "First time this component draws here —
        // recognition means nothing yet" and the user's own name for it
        // are contradictory claims to make side by side; once the user has
        // decided what to call it, they have done the recognising the
        // badge was asking for. (Forgetting is untouched: it deletes the
        // record, so the next mount is honestly NEW again.)
        config.onNamed?.(surface.name, petname, built.icon());
        // The session's own surface object: the sheet may outlive this
        // click (Save leaves it up only briefly, but the object is also
        // what a re-open would be built from).
        session.surface = { ...session.surface, petname, icon: built.icon(), isNew: false };
        finish(`saved — the visor will call this component ${petname} from now on`);
      };
      built.cancelBtn.onclick = () => {
        if (!namingTenant.owns(session)) return;
        finish("");
      };
      if (built.forgetBtn) {
        built.forgetBtn.onclick = () => {
          if (!namingTenant.owns(session)) return;
          marks.forget(surface.name);
          // Forgetting must be honest on the strip too: the cached petname
          // goes with the record, so the anchor stops speaking a name
          // the visor no longer holds. (`isNew` stays as it is — this session
          // has seen the component; the NEXT mount is the one that is
          // genuinely new again, and the sheet says so.)
          config.onForgotten?.(surface.name);
          finish("forgotten — this component will be announced as NEW next time");
        };
      }

      // The height budget (the anchor must never be pushed off-screen by a
      // sheet that hangs off it) and the reveal are the host's.
      return {
        root: built.root,
        // Focus is taken here because typing the petname IS the requested
        // interaction — the sheet exists for that one field — and taking
        // it is safe because there is no arming delay to respect (see the
        // naming tenant's spec): nothing here a mis-tap could spend.
        onShown: () => built.input.focus(),
      };
    });
  };

  /** The visor's settings sheet. EVERY string on it is the visor's own or the
   * user's own — there is no component in this interaction at all, which
   * makes it the only sheet with no foreign-quoted text anywhere. */
  const buildSettingsSheet = (rec: VisorIdentity, hueAtOpen: number) => {
    const root = document.createElement("div");
    // `.armed` from the start: there is no arming delay here (see the
    // settings tenant's spec), so the button row must never be drawn dimmed for
    // a wait that does not exist.
    root.className = "cred-sheet settings-sheet armed";
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Your visor";

    const lead = document.createElement("div");
    lead.className = "cred-line said";
    lead.textContent =
      "these are yours: the visor says them in its own voice, and no component is ever told them";

    // Both text fields are PREFILLED with the current value. That is the
    // same exception the naming sheet makes for an existing petname: the
    // prefill is the user's OWN prior word, not a self-declared name
    // walking into the visor's voice by accept-the-default.
    const mkField = (labelText: string, hint: string, value: string, id: string) => {
      const field = document.createElement("div");
      field.className = "cred-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      label.htmlFor = id;
      const input = document.createElement("input");
      input.id = id;
      input.type = "text";
      input.autocomplete = "off";
      input.maxLength = IDENTITY_MAX;
      input.value = value;
      const hintEl = document.createElement("div");
      hintEl.className = "hint";
      hintEl.textContent = hint;
      field.append(label, input, hintEl);
      return { field, input };
    };

    const nameField = mkField(
      "Your name",
      "shown at the right of this bar — leave it empty and the visor shows nothing there",
      rec.name ?? "",
      "visor-settings-name",
    );
    const deviceField = mkField(
      "This device",
      "your word for the machine you are on — e.g. laptop, study PC",
      rec.device ?? "",
      "visor-settings-device",
    );

    // The icon row: the visor's fixed vocabulary, nothing else (see
    // VISOR_ICONS — a free-text face could spoof words in the visor's
    // voice at the one position that cannot be spoofed).
    const iconLabel = document.createElement("div");
    iconLabel.className = "cred-line said";
    iconLabel.textContent = "the visor's mark on this bar";
    const iconRow = document.createElement("div");
    iconRow.className = "settings-icons";
    let pickedIcon = identityIcon(rec);
    const iconButtons: HTMLButtonElement[] = [];
    for (const glyph of VISOR_ICONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = glyph;
      b.dataset.glyph = glyph;
      b.title = `use ${glyph}`;
      b.classList.toggle("picked", glyph === pickedIcon);
      b.onclick = () => {
        pickedIcon = glyph;
        for (const other of iconButtons) other.classList.toggle("picked", other === b);
      };
      iconButtons.push(b);
      iconRow.append(b);
    }

    // The colour row, moved here whole from the old strip picker.
    // Constrained customisation: same lightness and chroma for every
    // choice, so contrast can never be customised away.
    const hueLabel = document.createElement("div");
    hueLabel.className = "cred-line said";
    hueLabel.textContent = "this bar's colour — yours, and never disclosed to an app";
    const hueRow = document.createElement("div");
    hueRow.className = "settings-hues";
    let pickedHue = hueAtOpen;
    const hueButtons: HTMLButtonElement[] = [];
    for (const hue of VISOR_HUES) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = `oklch(38% .07 ${hue})`;
      b.dataset.hue = String(hue);
      b.title = `hue ${hue}`;
      b.classList.toggle("picked", hue === hueAtOpen);
      b.onclick = () => {
        pickedHue = hue;
        for (const other of hueButtons) other.classList.toggle("picked", other === b);
        // LIVE PREVIEW: the strip and this sheet repaint immediately, so
        // the user judges the anchor colour on the anchor rather than on
        // a swatch. Nothing is ANNOUNCED for this: the announced-reset
        // rule exists for changes the user did NOT make (a lost or
        // evicted record), and telling someone about the change they are
        // in the middle of making would devalue the announcement that
        // matters. Save commits it; Cancel puts it back.
        visor.applyHue(hue);
      };
      hueButtons.push(b);
      hueRow.append(b);
    }

    // THE AUDIBLE ANCHOR — the colour row's twin, sitting directly under
    // it because they are the same setting on two channels: one for
    // people who see the bar, one for people who hear it. Everything
    // above says "this is yours and no app learns it"; this row says the
    // same thing about the word that opens every sentence the visor
    // speaks.
    //
    // PIXEL POLICY, AND IT IS THE WHOLE DESIGN OF THIS ROW: THE WORD IS
    // NEVER RENDERED. Not here, not as a hint, not in a `title`, not in
    // an aria-label — the buttons SAY it and nothing draws it. The visor
    // interface makes that structural rather than merely observed (there
    // is no getter that returns the word; `speakWord`/`rerollWord` are
    // the only doors, and both end in the live region). The reason is
    // the leak this whole channel is chosen to avoid: pixels travel. A
    // screenshot, a screen-recording, a shared window or a support
    // session carries a rendered word straight to whoever is watching —
    // and an app that learns the word can prefix its own text with it
    // and sound exactly like the visor, which is the single failure the
    // word exists to prevent. Audio leaks too (see words.ts), but it
    // leaks to whoever is in the room rather than into a file, and the
    // re-roll button is the answer when it does.
    const wordLabel = document.createElement("div");
    wordLabel.className = "cred-line said";
    wordLabel.textContent =
      "this visor's spoken word — said out loud, shown to nobody, and never given to an app";
    const wordRow = document.createElement("div");
    wordRow.className = "settings-word";
    const hearWordBtn = document.createElement("button");
    hearWordBtn.type = "button";
    hearWordBtn.id = "visor-settings-hear-word";
    // The text content IS the label — "hear your visor's word" says what
    // the control does and what it produces — so no aria-label is added.
    // A redundant one would only be a second string to keep in sync.
    hearWordBtn.textContent = "hear your visor's word";
    hearWordBtn.onclick = () => visor.speakWord();
    const rollWordBtn = document.createElement("button");
    rollWordBtn.type = "button";
    rollWordBtn.id = "visor-settings-roll-word";
    rollWordBtn.textContent = "roll a new word";
    // NO ARMING AND NO CONFIRMATION, deliberately: a re-roll spends
    // nothing and destroys nothing (the old word had no authority to
    // lose), and the user who reaches for it is usually the user who
    // just realised they were overheard — a delay there is a delay on a
    // remedy. It COMMITS IMMEDIATELY for the same reason, unlike the
    // colour swatches above: there is nothing to preview by ear, so a
    // Save step would only be a way to forget to finish.
    rollWordBtn.onclick = () => visor.rerollWord();
    wordRow.append(hearWordBtn, rollWordBtn);

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and none of this is ever given to one";

    // CONSUMER ACTIONS (see `extraActions`). Nothing is rendered at all
    // when there are none, so a consumer that passes no actions gets the
    // sheet exactly as it was before this hook existed.
    const actions = config.extraActions ?? [];
    const actionsBlock = document.createElement("div");
    // NOT `cred-row`: that class is the Save/Cancel pair, and both this
    // sheet's own driving hooks and the demo's select it positionally
    // (`.cred-row button:first-child`). A second `.cred-row` earlier in
    // the sheet would silently steal those clicks.
    actionsBlock.className = "settings-extra";
    for (const action of actions) {
      const line = document.createElement("div");
      line.className = "cred-field";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-extra-action";
      b.dataset.action = action.key ?? action.label;
      b.textContent = action.label;
      // The action LEAVES this sheet: closing first means the drawer is
      // free for whatever the action opens, and that the settings
      // session cannot be left owning a sheet nobody is looking at. The
      // close is a plain one (no `commit`), so an uncommitted colour
      // preview reverts exactly as Cancel would.
      b.onclick = () => {
        closeSettings();
        action.onSelect();
      };
      line.append(b);
      if (action.hint !== undefined) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = action.hint;
        line.append(hint);
      }
      actionsBlock.append(line);
    }

    const row = document.createElement("div");
    row.className = "cred-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(saveBtn, cancelBtn);

    // THE DANGER ENTRY, in the sheet's UPPER-RIGHT CORNER, beside the
    // heading. It used to sit last, past the Save/Cancel row, buying
    // distance from the routine controls by making the user travel to
    // it. The corner buys the same distance a different way: the button
    // has NO interactive neighbour at all — the heading beside it is
    // inert text, so a mis-aim anywhere near it costs nothing, which is
    // more than "below the way out" ever guaranteed (a fat-fingered
    // Cancel is one row away from the old position).
    //
    // And the corner is VISIBLE ON ARRIVAL rather than discovered by
    // travel, which is what an exit deserves: a visor whose way out has
    // to be found by scrolling is a visor that keeps you by inertia. The
    // ceremony behind the button — the arming delay plus the typed word
    // — is the actual guard, so once it exists, discoverability stops
    // trading against safety and the two can both be had.
    //
    // It is FRAMEWORK POLICY, not a consumer `extraAction`: what it
    // erases is the visor's own record, and a consumer that had to
    // contribute this button could also decline to, leaving a visor whose
    // memory of the user has no exit. It is rendered here for every
    // consumer, exactly like the naming and settings sheets themselves.
    const resetBlock = document.createElement("div");
    resetBlock.className = "settings-reset";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.id = "visor-settings-reset";
    resetBtn.className = "reset";
    // THE ELLIPSIS IS THE PROMISE: this button opens a ceremony, it does
    // not perform the act. The hint says the same thing in words, because
    // a typographic convention is not a warning.
    resetBtn.textContent = "erase this visor…";
    const resetHint = document.createElement("div");
    resetHint.className = "hint";
    resetHint.textContent =
      "wipes your name, this device's word, the colour and every petname — a confirmation explains first";
    resetBtn.onclick = () => {
      // THE PREVIEW IS REVERTED BY HAND HERE, because this path no
      // longer closes the settings sheet — it SUSPENDS it, and
      // suspension deliberately bypasses `beforeCollapse` (the session
      // is not ending, so the tenant's revert never runs). Two things
      // would otherwise go wrong, and either alone would be enough: an
      // uncommitted colour would ride INTO the erase ceremony's frame,
      // painting a statement of consequence in a colour the user never
      // saved; and on resume the rebuilt sheet re-preselects `hueAtOpen`
      // in the swatch row, so the applied colour and the picked swatch
      // would disagree. Both are fixed by the same line: applied and
      // picked must both be hueAtOpen.
      visor.applyHue(hueAtOpen);
      // SUSPEND, NOT CLOSE, for exactly this one step (see
      // `settingsSuspends`): the host's `suspend` runs synchronously
      // inside the reset tenant's `open`, so the flag is raised for the
      // duration of that call and lowered again immediately — try/finally
      // so a throw on the way in cannot leave every later displacer
      // suspending settings instead of evicting it.
      //
      // Unsaved name/device edits still drop: the sheet is REBUILT on
      // resume, not restored, which is the host's ruling ("the world
      // moved while it was away"). No regression — the old
      // close-and-reopen dropped precisely the same edits.
      settingsSuspends = true;
      try {
        requestReset();
      } finally {
        settingsSuspends = false;
      }
    };
    resetBlock.append(resetBtn, resetHint);

    // The header row: the sheet's own title on the left, the way out on
    // the right (see the danger-entry comment above). One row, so the
    // corner is the corner at every width the sheet is drawn at.
    const head = document.createElement("div");
    head.className = "settings-head";
    head.append(h, resetBlock);

    root.append(
      head,
      lead,
      nameField.field,
      deviceField.field,
      iconLabel,
      iconRow,
      hueLabel,
      hueRow,
      wordLabel,
      wordRow,
      note,
    );
    if (actions.length > 0) root.append(actionsBlock);
    root.append(row);
    return {
      root,
      nameInput: nameField.input,
      deviceInput: deviceField.input,
      saveBtn,
      cancelBtn,
      icon: () => pickedIcon,
      hue: () => pickedHue,
    };
  };

  const openSettingsDrawer = () => {
    // Precedence and eviction are the host's (see openNamingDrawer): an
    // exclusive tenant refuses this open outright, and the naming sheet
    // is evicted context-free.
    //
    // The committed colour: the anchor to revert to if this sheet does
    // not end in Save. Read from the visor's committed value rather than
    // re-reading storage, so a live preview from an earlier (evicted)
    // sheet can never be mistaken for the user's committed choice.
    const hueAtOpen = visor.committedHue();
    const session = { hueAtOpen };
    settingsTenant.open(session, () => {
      const built = buildSettingsSheet(visor.identity(), hueAtOpen);

      built.saveBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        visor.saveIdentity({
          name: built.nameInput.value,
          device: built.deviceInput.value,
          icon: built.icon(),
        });
        // Remember, paint, persist — in that order.
        visor.commitHue(built.hue());
        // Mirror the commit outward (see `onIdentityCommitted`): the
        // visor's own record is already written, so a consumer's mirror
        // can only ever be late, never contradictory.
        config.onIdentityCommitted?.(visor.identity(), built.hue());
        // The strip is repainted from the RECORD, not from the inputs, so
        // what the bar shows is exactly what was persisted (clamping and
        // the unset-is-absent rule included).
        visor.renderIdentity();
        closeSettings({ commit: true });
      };
      built.cancelBtn.onclick = () => {
        if (!settingsTenant.owns(session)) return;
        // commit:false — the live colour preview is reverted (by the
        // tenant's own beforeCollapse) and the typed edits are simply
        // dropped with the sheet.
        closeSettings();
      };

      // No `onShown` focus: the user asked for SETTINGS, not for any one
      // field of it — name, device, icon and colour are all equally the
      // errand, so pre-focusing the name input would be a guess. On
      // mobile the guess also costs pixels: focusing an input raises the
      // keyboard, which covers part of the sheet it was raised over.
      // (Contrast the naming sheet, where typing IS the interaction.)
      return { root: built.root };
    });
  };

  /** THE ERASE CEREMONY. Same construction style as the other two sheets,
   * a different weight class: this one is armed and dimmed (see the reset
   * tenant), states its consequence before it offers the control, and
   * asks the user to TYPE something before the control does anything.
   *
   * The shape is pairing's heavy ceremony (visor/ui/pairing.ts:700-770),
   * for the same reason it was heavy there: an irreversible, total act
   * deserves a statement of consequence, an arming delay and a typed
   * confirmation, and none of the three is a substitute for the others. */
  const buildResetSheet = (rec: VisorIdentity) => {
    const root = document.createElement("div");
    // NO `.armed` here, unlike the other two sheets. This tenant IS
    // armed, so the drawer host adds the class itself once ARM_MS has
    // elapsed (visor.ts:1462-1470) — shipping it pre-armed would draw the
    // buttons at full strength for a delay that is really running, which
    // is the exact inverse of the honesty the class exists for.
    root.className = "cred-sheet reset-sheet";
    root.style.maxWidth = "72rem"; // rem: aligns with the page's --content-max column
    root.style.marginLeft = "auto";
    root.style.marginRight = "auto";

    const h = document.createElement("h2");
    h.textContent = "Erase this visor";

    // THE STATEMENT OF CONSEQUENCE, in framework voice: what is about to
    // be destroyed, said BEFORE the control that destroys it, and said
    // concretely — "your settings will be reset" is the sentence a user
    // clicks through, an itemised list is the one they read.
    const danger = document.createElement("div");
    danger.className = "cred-danger";
    const dangerLines = [
      "this erases what the visor holds on this device: your name, your word for this device, the bar's colour and mark, and every petname and pet icon you gave a component.",
      "every component will be NEW again, and there is no undo.",
    ];
    for (const line of dangerLines) {
      const el = document.createElement("div");
      el.textContent = line;
      danger.append(el);
    }
    // THE CONSUMER'S OWN EXTRA LINES (see `resetConsequences`): what else
    // this consumer is about to destroy, which only it knows. The visor
    // draws them in its own chrome; the WORDS are the consumer's, and
    // must be the consumer's own (never component-influenced) — nothing
    // here can check that, so it is stated at the option instead.
    for (const line of config.resetConsequences ?? []) {
      const el = document.createElement("div");
      el.textContent = line;
      danger.append(el);
    }

    // THE TYPED CONFIRMATION. The challenge is the user's OWN NAME when
    // the record holds one: it is a word the user chose, in the visor's
    // pixels, and typing it is a signature nothing on the page could
    // supply for them.
    //
    // WHEN THERE IS NO NAME the ceremony does NOT simply skip the step —
    // the name is optional, but petnames, pet icons and (for a consumer
    // that paired) rather more than that may exist regardless, so the
    // deliberateness is still worth buying. It falls back to the visor's
    // own fixed word.
    const challenge = (rec.name ?? "").trim();
    const named = challenge !== "";
    const want = named ? challenge : "erase";

    const field = document.createElement("div");
    field.className = "cred-field";
    const label = document.createElement("label");
    label.htmlFor = "visor-reset-confirm";
    if (named) {
      // Built from spans rather than one string, because the user's name
      // is USER VOICE inside a framework-voice sentence: the user wrote
      // it, the visor is entitled to say it, and `.who` carries the
      // weight-600 dress it already wears in the identity cluster.
      const leadSpan = document.createElement("span");
      leadSpan.textContent = "type your name — ";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = challenge.slice(0, IDENTITY_MAX);
      const tail = document.createElement("span");
      tail.textContent = " — to confirm";
      label.append(leadSpan, who, tail);
    } else {
      label.textContent = "type erase to confirm";
    }
    const input = document.createElement("input");
    input.id = "visor-reset-confirm";
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = IDENTITY_MAX;
    // NEVER PREFILLED, and here the rule is doing its most literal work:
    // a prefilled confirmation is not a confirmation at all, it is a
    // second Save button wearing a text field's clothes.
    field.append(label, input);

    const reason = document.createElement("div");
    reason.className = "cred-reason";

    const note = document.createElement("div");
    note.className = "cred-note";
    note.textContent =
      "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and cannot see what you type";

    const row = document.createElement("div");
    row.className = "cred-row";
    const eraseBtn = document.createElement("button");
    eraseBtn.type = "button";
    eraseBtn.className = "erase-confirm";
    // The arming state says so in words as well as in dress (pairing.ts's
    // countdown courtesy): the disabled attribute is the enforcement, the
    // text is what tells the user the control is coming rather than
    // broken.
    eraseBtn.textContent = "arming…";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    row.append(eraseBtn, cancelBtn);

    root.append(h, danger, field, note, reason, row);
    return { root, input, eraseBtn, cancelBtn, reason, want };
  };

  const openResetDrawer = () => {
    // The session carries nothing: there is no preview to revert and the
    // typed confirmation must not outlive the sheet. It is still an
    // OBJECT rather than a boolean, because `owns` is identity-compared
    // and every handler below is guarded on it.
    const session: Record<string, never> = {};
    resetTenant.open(session, () => {
      const built = buildResetSheet(visor.identity());
      // Defence-in-depth, exactly as in pairing.ts:736-740: the host's
      // `disabled` is the enforcement, and this flag is the second
      // refusal for anything that got past it (a synthetic click,
      // accessibility tooling driving the DOM).
      let armed = false;

      built.eraseBtn.onclick = async () => {
        if (!resetTenant.owns(session)) return;
        if (!armed) return;
        // DELIBERATENESS, NOT AUTHENTICATION. The challenge is compared
        // trimmed and case-insensitively — the same posture the petname
        // collision check takes — because nothing here is a secret: the
        // user's name is on the strip in front of them. What the field
        // buys is that the erase cannot be reached by a gesture, only by
        // a sentence; typing your own name modulo case is exactly the
        // signature we want, and refusing it over a capital letter would
        // teach the user that the visor is fussy rather than serious.
        if (built.input.value.trim().toLowerCase() !== built.want.toLowerCase()) {
          built.reason.textContent = "that doesn't match — nothing has been erased";
          return;
        }
        // No second chance to press either control while the wipe runs.
        built.eraseBtn.disabled = true;
        built.cancelBtn.disabled = true;
        try {
          // THE FALLIBLE HALF FIRST (see `onReset`): if the consumer's
          // own wipe throws, the ceremony refuses and everything the
          // visor holds is still held — a state the sheet can describe
          // truthfully and the user can retry from.
          await config.onReset?.();
        } catch {
          built.eraseBtn.disabled = false;
          built.cancelBtn.disabled = false;
          built.reason.textContent = "could not erase — the visor still holds everything; try again";
          return;
        }
        // THE INFALLIBLE HALF, in two pieces: the trust table (this
        // file's), then the visor's own keys (visor.ts's `erase`).
        marks.eraseAll();
        visor.erase();
        // THE RELOAD IS PART OF THE CEREMONY, not a convenience. Two
        // reasons, and either alone would be enough. First, honesty about
        // the end state: a fresh boot rolls a fresh anchor colour and
        // announces it (the `fresh` mechanics), and every component comes
        // back genuinely NEW — which is what was just promised, said by
        // the same machinery that says it on a first run. Second, nothing
        // that survived this line may keep rendering: every in-memory
        // cache on the page — the consumer's surfaces, the strip's own
        // context — is now a copy of records that no longer exist, and a
        // visor still speaking a name it has forgotten is precisely the
        // failure this ceremony was about. (The suspended settings sheet
        // goes the same way — its session is page state, and the page is
        // about to be replaced by a fresh boot of a visor that remembers
        // nothing to settle.)
        location.reload();
      };
      built.cancelBtn.onclick = () => {
        if (!resetTenant.owns(session)) return;
        // A plain close and NO announcement, the settings-cancel
        // precedent: nothing happened, and saying so on the anchor would
        // spend the bottom line on a non-event.
        //
        // THE RETURN TRAVEL IS NOT THIS SHEET'S. The settings sheet that
        // opened this one is suspended, not closed, and the drawer host
        // resumes it on this close — rebuilt, sliding back in from the
        // left. So there is nothing to re-open here; adding one would
        // race the host into a second settings session.
        closeReset();
      };

      return {
        root: built.root,
        // The input is held disabled too — nothing on this sheet is
        // typeable before the user has had time to see what it says. The
        // Cancel button deliberately is NOT in this list: the way out
        // must never be behind the arming delay, or the delay becomes a
        // trap rather than a guard.
        controls: [built.input, built.eraseBtn],
        onArmed: () => {
          armed = true;
          built.eraseBtn.textContent = "erase everything";
        },
      };
    });
  };

  // The visor's naming ceremony, reachable ONLY from the strip's own
  // pixels — and the consumer's preconditions, in that order: the refusal
  // first (so a click while an exclusive sheet is up is a pure no-op),
  // then whatever the consumer must do to get the page back.
  const requestNaming = (surface: SurfaceIdentity) => {
    if (config.canOpen && !config.canOpen()) return;
    config.beforeOpen?.();
    openNamingDrawer(surface);
  };

  // The visor's settings sheet, reachable ONLY from the strip's own
  // button (rendered by the visor's identity cluster — visor pixels,
  // unreachable from any app rectangle). Same precedence as naming,
  // enforced twice: here, and again by the drawer host on `open`.
  const requestSettings = () => {
    if (config.canOpen && !config.canOpen()) return;
    config.beforeOpen?.();
    openSettingsDrawer();
  };

  // THE ERASE CEREMONY, and it does NOT re-run the consumer's
  // preconditions. `canOpen`/`beforeOpen` are the price of entry to a
  // visor sheet from OUTSIDE — from the strip's own pixels, where a
  // consumer may be holding an exclusive sheet or a modal dialog that has
  // to be taken down first. This one is reached only from the settings
  // sheet, which already paid both a moment ago: re-running `beforeOpen`
  // would ask the consumer to retire a page it has already retired, and
  // re-running `canOpen` would ask about a precondition that has not
  // changed. The refusal that still applies is the drawer host's own —
  // an exclusive tenant that claimed the drawer in between refuses this
  // `open` outright, and nothing happens.
  const requestReset = () => openResetDrawer();

  // THE STRIP'S LATE-BOUND CONTROLS. The strip is built by `initVisor`,
  // long before the drawer's tenants exist, so the "name it" affordance,
  // the context cluster and the settings button call through the visor's
  // handler slots.
  visor.install({ requestNaming, requestSettings });

  return {
    marks,
    requestNaming,
    requestSettings,
    requestReset,
    closeNaming,
    closeSettings,
    closeReset,
    namingOpen: () => namingTenant.isOpen(),
    settingsOpen: () => settingsTenant.isOpen(),
    resetOpen: () => resetTenant.isOpen(),
  };
}
