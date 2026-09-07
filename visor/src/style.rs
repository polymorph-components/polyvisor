//! The visor's stylesheet.
//!
//! Shipped as a `<style>` element the visor creates itself, first thing:
//! the trusted pixels run under no stream-dom policy and must not depend on
//! anything the page provides, so there is exactly one stylesheet and it is
//! this string. No theming, no variables beyond the anchor hue (which is
//! per-element, since it is device identity and not decoration).

pub(crate) const CSS: &str = r#"
#visor-strip, #visor-drawer { font: 14px/1.4 system-ui, sans-serif; color: #f4f4f5; }

/* Fixed on all three axes so no content can push the anchor around. */
#visor-strip {
  box-sizing: border-box;
  height: 56px; min-height: 56px; max-height: 56px;
  display: flex; align-items: center; gap: 12px;
  padding: 0 12px;
  background: #18181b;
  border-top: 1px solid #3f3f46;
}

/* Content-sized, capped, and scrolling past the cap: growth is bounded so
   the drawer can never squeeze the strip out of the viewport. */
#visor-drawer {
  box-sizing: border-box;
  max-height: 60vh; overflow-y: auto;
  padding: 12px;
  background: #27272a;
  border-top: 1px solid #3f3f46;
}

#visor-identity { display: flex; align-items: center; gap: 8px; }
#visor-circle { width: 28px; height: 28px; border-radius: 50%; flex: none; }
#visor-context { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#visor-actions { display: flex; gap: 8px; flex: none; }

button { font: inherit; color: inherit; background: #3f3f46; border: 1px solid #52525b; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
button[aria-pressed="true"] { background: #52525b; }
button[disabled] { opacity: 0.5; cursor: default; }
input[type="text"], input[type="password"] { font: inherit; color: inherit; background: #18181b; border: 1px solid #52525b; border-radius: 6px; padding: 6px 8px; }
label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }

.app-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.app-row-title { flex: 1; min-width: 0; }

/* The device ceremonies: unseal, keep, the entry picker, erase. Minimal
   on purpose — this chrome is slated for a redesign. */
.sheet { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 8px 0; border-top: 1px solid #3f3f46; }
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

/* Unclaimed: before `device.status` reports `open` there is no identity to
   show, so the strip wears zero chroma — no hue, no name, no word. The
   circle gets its grey here and *only* here: the painted hue is an inline
   style the open branch alone emits (docs/design.md "Devices": a page
   imitating the picker must not be able to paint the user's colour). */
#visor-strip.unclaimed #visor-circle { background: #52525b; }

/* The three voices. polyvisor speaking. */
.framework { color: #a1a1aa; font-style: italic; }
/* The user's own words, echoed: upright, weighted, never quoted. */
.user { font-weight: 600; font-style: normal; color: #fafafa; }
/* A publisher's words: plated, monospace, quoted, so foreign text is
   visibly foreign wherever it lands. */
.app {
  font-family: ui-monospace, monospace;
  background: #e4e4e7; color: #18181b;
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

    /// The unclaimed dress is a stylesheet fact, not a per-element one:
    /// the strip carries the class and the circle's grey follows from it,
    /// so no code path can grey the strip and still paint the circle.
    #[test]
    fn stylesheet_greys_the_unclaimed_anchor() {
        assert!(CSS.contains("#visor-strip.unclaimed #visor-circle"));
        // ...and the stylesheet itself never names a hue: the anchor colour
        // reaches the DOM only through the inline style the open branch of
        // `Identity` emits.
        assert!(!CSS.contains("hsl("));
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
