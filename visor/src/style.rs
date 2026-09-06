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
input[type="text"] { font: inherit; color: inherit; background: #18181b; border: 1px solid #52525b; border-radius: 6px; padding: 6px 8px; }
label { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }

.app-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.app-row-title { flex: 1; min-width: 0; }

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
}
