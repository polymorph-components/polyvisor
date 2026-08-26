// TodoMVC's own consumption of the shared visor
// (visor/ui/visor.ts + visor/ui/sheets.ts).
//
// This file is now THIN, and that is the point. The strip, the identity
// cluster, the context cluster and the drawer host are the framework's
// (visor/ui/visor.ts); so are the two ceremonies that hang off the strip
// — the naming/App-settings sheet and the "Your visor" settings sheet —
// and the trust table behind them (visor/ui/sheets.ts). What stays here
// is exactly what is this page's own: its storage KEYS, and its one row
// in the trust table.
//
// WHY THE CEREMONIES ARE NO LONGER LOCAL. Before this, the strip drew a
// clickable petname titled "app settings: rename, recolour, forget" and
// installed no handler for it — a dead affordance on the trust anchor,
// which is the worst place to have one. The alternative to consuming the
// shared ceremonies would have been reimplementing them here, and a
// second implementation of the petname triangle is a second chance to get
// the demotion, the collision refusal or the local-uniqueness rule
// subtly wrong.
//
// WHAT WENT AWAY WITH IT: the "consent demo" and "kill" strip buttons and
// their two drawer tenants. They were a pre-shared-core demonstration of
// drawer mechanics — a simulated permission prompt and a simulated app
// teardown — and the mechanics they demonstrated (arming, dimming,
// tenancy, the reveal above the strip) are demonstrated by the shared
// sheets themselves now, against real state instead of a mock. (The
// app's own `TodoApp.teardown` stays in app.ts: it is a framework-real
// capability, and nothing about removing a spike button argues against
// having it.)

import { initVisor, type SurfaceIdentity } from "../../../visor/ui/visor.ts";
import { registerVisorSheets } from "../../../visor/ui/sheets.ts";

// --- this page's own storage keys ---------------------------------------------
//
// Two spikes on one origin must not share an anchor colour, an identity
// record or a trust table: the palette, the identity vocabulary and the
// mark-assignment rule are the framework's, the KEYS are the consumer's.
// No legacy key here — todomvc never had a pre-rename ("chrome") key to
// migrate, unlike the demo spike's #22 migration.
const HUE_KEY = "pm-todomvc-visor-hue";
// The AUDIBLE anchor: the spoken twin of the colour, on its own key for
// exactly the same reason — two embedders on one origin are two devices
// and must not sound alike (visor/ui/words.ts).
const WORD_KEY = "pm-todomvc-visor-word";
const IDENTITY_KEY = "pm-todomvc-identity";
const MARKS_KEY = "pm-todomvc-surface-marks";

/** The word this page has always shown for itself on the strip
 * (pre-shared-core `initVisor("TodoMVC", ...)`). It is now a SEEDED
 * PETNAME rather than a hardcoded label: it goes into the trust table on
 * first run so the historical name is what a new user sees, and from
 * then on it is an ordinary petname — the naming ceremony can rename it,
 * and the rename sticks. */
const DEFAULT_PETNAME = "TodoMVC";

export function initTodoVisor(artifactName: string): void {
  /** THE APP'S ROW IN THE TRUST TABLE. Declared before `initVisor`
   * because the strip resolves its fallback surface through the arrow
   * below during construction — null until the row is built from the
   * trust record a few lines down, exactly as the demo spike does it. */
  let appSurface: SurfaceIdentity | null = null;

  const visor = initVisor({
    hueKey: HUE_KEY,
    wordKey: WORD_KEY,
    identityKey: IDENTITY_KEY,
    // The strip's fallback surface: this page has exactly one artifact,
    // so there is exactly one row, and it is always the one on the strip.
    appSurface: () => appSurface,
  });

  const sheets = registerVisorSheets(visor, {
    marksKey: MARKS_KEY,
    // No exclusive tenant on this page and no modal dialog to take the
    // page back from, so neither precondition hook is needed: the drawer
    // host's own tenancy is the whole story here.
    onNamed: (provenance, petname, icon) => {
      if (appSurface?.name === provenance) appSurface = { ...appSurface, petname, icon };
    },
    onForgotten: (provenance) => {
      // The mark goes with the name: a record that is forgotten must
      // stop being worn, or the strip keeps a glyph with nothing behind
      // it (see the demo's `onForgotten` for the full argument).
      if (appSurface?.name === provenance) {
        appSurface = { ...appSurface, petname: undefined, icon: "" };
      }
    },
  });

  // The row itself, resolved exactly as a demo surface is: created at
  // first sight and UNMARKED, because the pet icon is the user's to pick
  // in the ceremony (visor/ui/sheets.ts) and never the visor's to roll.
  //
  // The tint-from-artifact-bytes hash this file used to carry is gone,
  // and the reason is not the old grind argument (which genuinely did not
  // bite with one artifact per boot) — it is that the naming ceremony
  // owns the recognition mark. A mark painted from a hash of the artifact
  // name would ignore what the user picked, so the visor would be showing
  // one thing and remembering another. Single implementation is the
  // point: this row behaves like any other.
  const { mark } = sheets.marks.mark(artifactName);

  // SEED THE HISTORICAL NAME. A record with no petname yet gets
  // DEFAULT_PETNAME, so a first-run user sees the word this page has
  // always shown rather than a bare "NEW … name it" offer for the only
  // app on the page.
  //
  // CONTRACT: the dispatch says "seed on first run, then user renames
  // stick". A rename sticks because the record then HAS a petname and
  // this branch does not fire. A FORGET deletes the record, so the next
  // reload seeds again — i.e. forgetting restores the default name
  // rather than leaving the app permanently unnamed. That is the
  // conservative reading (the seeded word is this page's factory
  // default, and re-seeding it is the same act as seeding it), but it is
  // a visible choice: forgetting is honest for the rest of the session —
  // the strip drops the name and offers "name it" — and the default
  // returns on reload.
  //
  // NO SEEDED MARK, only a seeded NAME. The petname is this page's own
  // factory default and the visor has always spoken it; a pet icon is
  // not, and inventing one would be the visor putting a recognition mark
  // on the anchor that the user never chose — the same honesty rule that
  // makes a migrated record arrive unmarked. So the strip shows the name
  // and no glyph until the user opens the ceremony, which then offers
  // six free marks.
  if (mark.petname === undefined) {
    sheets.marks.setPetname(artifactName, DEFAULT_PETNAME, mark.icon);
    mark.petname = DEFAULT_PETNAME;
  }

  appSurface = {
    name: artifactName,
    // The guest declares nothing about itself here — there is no
    // separate self-description surface in this spike, unlike the
    // demo's panel `nickname()` export.
    nickname: "",
    icon: mark.icon,
    // Never NEW: this row always arrives with the seeded petname, and
    // "first time this component draws here" beside a name the visor is
    // already speaking would be two contradictory claims on one line
    // (the same rule that makes the naming ceremony clear the badge).
    isNew: false,
    petname: mark.petname,
    firstSeen: mark.firstSeen,
  };

  // A silently-reset anchor trains the user that it changes sometimes;
  // a reset is therefore announced, on the visor's own line — identical
  // wording to the demo spike's boot announcement, because it is the
  // same event under the same rule.
  if (visor.fresh) {
    visor.announce("new visor colour set for this device — remember it", 15000);
  }

  // The context was rendered once at construction, before `appSurface`
  // existed; repaint it now that the row does. A repaint, not a context
  // move, so the fresh-anchor announcement above keeps its line.
  visor.renderContext();
}
