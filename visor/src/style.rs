//! The visor's stylesheet.
//!
//! Shipped as a `<style>` element the visor creates itself, first thing:
//! the trusted pixels run under no stream-dom policy and must not depend on
//! anything the page provides, so there is exactly one stylesheet and it is
//! this string.
//!
//! Every colour here is a function of one number the stylesheet does not
//! contain: `--hue`, which `#visor-root` carries as an inline style and
//! only in the arm that saw `device.status` say the device is open
//! (docs/design.md "Devices"). So the palette cascades — strip, drawer,
//! buttons and voices all shift together — while the fact that decides
//! whether anything is painted at all stays one expression in one place.

pub(crate) const CSS: &str = r#"
/* The two arms of the anchor rule, and the only place either is spelled.
   Claimed: every colour is `--hue` at a fixed lightness/chroma. Unclaimed:
   the same lightnesses at zero chroma, so an unpainted visor is the same
   shape in grey rather than a second design. */
#visor-root {
  position: relative;
  font: 14px/1.4 system-ui, sans-serif;
  color: oklch(0.2 0.02 var(--hue));
  --strip: oklch(0.62 0.14 var(--hue));
  --drawer: oklch(0.7 0.11 var(--hue));
  --accent: oklch(0.71 0.16 var(--hue));
  --edge: oklch(0.45 0.09 var(--hue));
  --quiet: oklch(0.38 0.05 var(--hue));
  --plate: oklch(0.93 0.03 var(--hue));
  --plate-ink: oklch(0.25 0.06 var(--hue));
  --field: oklch(0.88 0.04 var(--hue));
}
#visor-root.unclaimed {
  color: oklch(0.2 0 0);
  --strip: oklch(0.62 0 0);
  --drawer: oklch(0.7 0 0);
  --accent: oklch(0.71 0 0);
  --edge: oklch(0.45 0 0);
  --quiet: oklch(0.38 0 0);
  --plate: oklch(0.93 0 0);
  --plate-ink: oklch(0.25 0 0);
  --field: oklch(0.88 0 0);
}

/* Fixed on all three axes so no content can push the anchor around, and
   the one thing in this tree that is never overlaid: the drawer is
   absolutely positioned below it rather than in flow, so opening anything
   moves no pixel of the strip (docs/design.md M1: "strip geometry immobile
   with the app mounted"). */
#visor-strip {
  box-sizing: border-box;
  height: 56px; min-height: 56px; max-height: 56px;
  display: flex; align-items: center;
  padding: 0 8px;
  position: relative; z-index: 3;
  background: var(--strip);
  border-bottom: 1px solid var(--edge);
}

/* The two halves. Each is a whole button so the target is the half, not
   the glyph: one is "what is running", the other "who this is". */
#visor-app, #visor-self {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 8px;
  background: none; border: 0; border-radius: 8px;
  padding: 4px 8px; text-align: left;
}
#visor-self { flex-direction: row-reverse; text-align: right; }
#visor-app[aria-pressed="true"], #visor-self[aria-pressed="true"] { background: var(--drawer); }
#visor-divider { width: 1px; align-self: stretch; margin: 5px; background: var(--edge); }
#visor-app-glyph, #visor-circle {
  width: 28px; height: 28px; flex: none;
  display: flex; align-items: center; justify-content: center;
  /* The plate, not the drawer colour: a pressed half wears the drawer
     colour, and a glyph the same colour as its half vanishes. */
  background: var(--plate); color: var(--plate-ink);
}
#visor-app-glyph { border-radius: 6px; }
#visor-circle { border-radius: 50%; }
.stack { flex: 1; min-width: 0; }
.stack .top, .stack .bottom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stack .bottom { font-size: 12px; }

/* Everything below the strip is an overlay on the app zone, never a push:
   the scrim covers the app, the drawer covers the scrim, and both start
   exactly where the strip ends. */
#visor-scrim { position: fixed; inset: 56px 0 0 0; z-index: 1; background: oklch(0 0 0 / 0.25); }
#visor-drawer {
  position: absolute; top: 56px; left: 0; right: 0; z-index: 2;
  box-sizing: border-box;
  height: min(60vh, 480px);
  overflow: hidden;
  background: var(--drawer);
  border-bottom: 1px solid var(--edge);
  animation: visor-drawer-open 180ms ease-out;
}
#visor-drawer.closing { animation: visor-drawer-close 180ms ease-in forwards; }

/* One pane per tenant, stacked so two can be on screen at once while one
   slides out. The drawer's height is fixed and the pane scrolls inside it,
   so no sheet's length can move anything.

   The four backgrounds are the local/scroll shadow technique: the first two
   are drawer-coloured covers pinned to the content (`local`), the second
   two are shadows pinned to the viewport (`scroll`). Where there is more
   content above or below, the cover has scrolled away and the shadow shows
   — so "there is more" is visible without a scrollbar being trusted to say
   it. */
.pane {
  position: absolute; inset: 0;
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
  background:
    linear-gradient(var(--drawer) 30%, transparent) center top / 100% 32px,
    linear-gradient(transparent, var(--drawer) 70%) center bottom / 100% 32px,
    radial-gradient(farthest-side at 50% 0, oklch(0 0 0 / 0.35), transparent) center top / 100% 12px,
    radial-gradient(farthest-side at 50% 100%, oklch(0 0 0 / 0.35), transparent) center bottom / 100% 12px;
  background-repeat: no-repeat;
  background-attachment: local, local, scroll, scroll;
  background-color: var(--drawer);
}
.pane.enter-from-right { animation: visor-enter-right 200ms ease-out; }
.pane.enter-from-left { animation: visor-enter-left 200ms ease-out; }
.pane.leave-to-left { animation: visor-leave-left 200ms ease-in forwards; }
.pane.leave-to-right { animation: visor-leave-right 200ms ease-in forwards; }

@keyframes visor-drawer-open { from { height: 0; } }
@keyframes visor-drawer-close { to { height: 0; } }
@keyframes visor-enter-right { from { transform: translateX(100%); } }
@keyframes visor-enter-left { from { transform: translateX(-100%); } }
@keyframes visor-leave-left { to { transform: translateX(-100%); } }
@keyframes visor-leave-right { to { transform: translateX(100%); } }

/* Movement is decoration; the states it moves between are not. Zeroing the
   duration keeps every `animationend` the visor unmounts on firing. */
@media (prefers-reduced-motion: reduce) {
  #visor-root * { animation-duration: 0s !important; }
}

/* Unsaved changes, over the drawer: the only thing in this tree that takes
   the press away from what raised it. */
#visor-confirm {
  position: absolute; top: 56px; left: 0; right: 0; z-index: 4;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  background: var(--drawer);
  border-bottom: 1px solid var(--edge);
}

/* The line at the top of every pane. Only the pane that is staying
   carries the id — during a slide there are two of these on screen. */
.notice { margin-bottom: 8px; min-height: 1.4em; }

button { font: inherit; color: inherit; background: var(--accent); border: 1px solid var(--edge); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
button[aria-pressed="true"] { border-color: var(--plate-ink); }
button[disabled] { opacity: 0.5; cursor: default; }
input[type="text"], input[type="password"] { font: inherit; color: inherit; background: var(--field); border: 1px solid var(--edge); border-radius: 6px; padding: 6px 8px; }
label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }

.app-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.app-row-title { flex: 1; min-width: 0; }

/* The device ceremonies: unseal, keep, the entry picker, erase. Minimal
   on purpose — this chrome is slated for a redesign. */
.sheet { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--edge); }
.sheet-head { margin-bottom: 4px; }
.sheet-error { margin-top: 2px; }
.choice { display: flex; gap: 8px; }
.device-row { display: flex; align-items: center; gap: 8px; align-self: stretch; }
.device-row-name { flex: 1; min-width: 0; }

/* Sync. An endpoint id is machine text, not a voice: monospace so it can be
   read off a screen character by character, and `user-select: all` so one
   click takes the whole id — the visor has no clipboard capability, so
   selection is the only copy it can offer.

   It is also kept to one line (`nowrap`, scrolled rather than wrapped)
   because of *when* it arrives: the bind completes after first paint, so
   the id replaces the "binding…" placeholder in a sheet the user already
   has open. A wrapping id would be one line as a placeholder and two or
   three as an id, and everything below it in the drawer — "Other devices",
   erase — would jump under the pointer at an arbitrary moment. One line
   either way makes that swap layout-neutral. `user-select: all` still takes
   the whole id, scrolled or not. */
.sync-self { display: flex; align-items: center; gap: 8px; }
.endpoint-id {
  font-family: ui-monospace, monospace;
  user-select: all;
  white-space: nowrap;
  overflow-x: auto;
}
.peer-row { display: flex; align-items: center; gap: 8px; align-self: stretch; }
.member-row { display: flex; align-items: center; gap: 8px; align-self: stretch; }
.member-row-name { flex: 1; min-width: 0; }

/* Pairing. The code is 79 characters shown in groups of four: monospace so
   the groups line up, selectable as a whole, and wrapped at the spaces
   between groups (the only place it may break — a group broken mid-way is
   a group read wrong). */
.pairing-code {
  font-family: ui-monospace, monospace;
  user-select: all;
  align-self: stretch;
  line-height: 1.6;
}

/* The six digits both users compare. The largest thing in the drawer on
   purpose: the entire security of the ceremony is one person reading them
   off this screen and another agreeing they match, so they are sized to be
   read across a desk, spaced so no two digits run together, and selectable
   like every other machine text here. */
.pairing-sas {
  font-family: ui-monospace, monospace;
  font-size: 40px;
  letter-spacing: 6px;
  user-select: all;
}

/* The three voices. polyvisor speaking. */
.framework { color: var(--quiet); font-style: italic; }
/* The user's own words, echoed: upright, weighted, never quoted. */
.user { font-weight: 600; font-style: normal; color: inherit; }
/* A publisher's words: plated, monospace, quoted, so foreign text is
   visibly foreign wherever it lands. The plate is derived from the hue
   like everything else, but far lighter than the drawer it sits on, so it
   stays a plate at every hue. */
.app {
  font-family: ui-monospace, monospace;
  background: var(--plate); color: var(--plate-ink);
  border-radius: 4px; padding: 2px 6px;
  quotes: '"' '"';
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::Voice;

    /// Every voice must have a rule; a voice that renders like its
    /// neighbours is the failure this whole module exists to prevent.
    #[test]
    fn stylesheet_rules_every_voice() {
        for voice in Voice::ALL {
            let selector = format!(".{}", voice.class());
            assert!(
                CSS.contains(&selector),
                "stylesheet has no rule for the {voice:?} voice ({selector})"
            );
        }
    }

    /// The strip is the trust anchor: its height is pinned on all three
    /// axes so nothing inside or beside it can resize it. e2e measures
    /// `#visor-strip` against this same 56.
    #[test]
    fn stylesheet_pins_the_strip_height() {
        assert!(CSS.contains("height: 56px; min-height: 56px; max-height: 56px;"));
    }

    /// The anchor rule, as a property of the stylesheet: no colour with any
    /// chroma in it names a hue of its own. Every one of them reads
    /// `var(--hue)`, and `--hue` is set at exactly one site — the inline
    /// style on `#visor-root` that the open arm of `Ident` emits — so a
    /// visor that never saw `device.status` say "open" cannot show the
    /// user's colour, whatever else it renders (docs/design.md "Devices").
    /// Achromatic colours (the greys of the unclaimed dress, the scroll
    /// shadows) carry a hue component too, but it decides nothing.
    #[test]
    fn no_colour_with_chroma_names_its_own_hue() {
        let mut chromatic = 0;
        for tail in CSS.split("oklch(").skip(1) {
            let args = &tail[..tail.find(')').expect("unclosed oklch()")];
            let parts: Vec<&str> = args.split_whitespace().collect();
            assert!(parts.len() >= 3, "oklch({args}) has too few components");
            if parts[1] == "0" {
                continue;
            }
            chromatic += 1;
            assert!(
                parts[2].starts_with("var(--hue"),
                "oklch({args}) has chroma and yet names its own hue"
            );
        }
        assert!(chromatic > 0, "the stylesheet paints nothing from the hue");
        // The palette both arms of the rule define, spelled once each.
        assert!(CSS.contains("#visor-root.unclaimed"));
        assert!(CSS.contains("--strip: oklch(0.62 0.14 var(--hue));"));
        assert!(CSS.contains("--strip: oklch(0.62 0 0);"));
        // No second colour syntax to smuggle a hue through.
        assert!(!CSS.contains("hsl("));
    }

    /// The six digits are the ceremony: two people compare them across two
    /// screens, so they are sized to be read at a distance rather than
    /// styled like the framework's own prose.
    #[test]
    fn stylesheet_shows_the_sas_large() {
        assert!(CSS.contains(".pairing-sas"));
        let rule = CSS.split(".pairing-sas").nth(1).unwrap();
        let rule = &rule[..rule.find('}').unwrap()];
        assert!(
            rule.contains("font-size: 40px"),
            "the SAS must be far larger than the 14px base: {rule}"
        );
        assert!(
            rule.contains("letter-spacing"),
            "digits must not run together"
        );
    }

    /// An endpoint id lands in an already-open Settings sheet: the bind
    /// completes after first paint, so the id replaces the "binding…"
    /// placeholder under the user's pointer. It must not change the row's
    /// height doing it, or the controls below it move mid-click — so the
    /// id is scrolled on one line and never wrapped.
    #[test]
    fn stylesheet_keeps_the_endpoint_id_on_one_line() {
        assert!(
            CSS.contains("white-space: nowrap;"),
            "the endpoint id must not wrap: it arrives late, and a row that \
             grows moves everything below it"
        );
        assert!(!CSS.contains("overflow-wrap: anywhere"));
        // Scrolled, not clipped: the whole id has to remain readable.
        assert!(CSS.contains("overflow-x: auto;"));
    }
}
