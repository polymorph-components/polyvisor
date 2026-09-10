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
//!
//! Two rules the e2e gates measure rather than this file asserting them:
//! every selector is under `#visor-root`, because the `<style>` element
//! lands in the page's own document and a bare `button {}` would dress the
//! host page; and text states an opaque colour rather than fading, so its
//! contrast does not depend on what happens to be behind it.

pub(crate) const CSS: &str = r#"
/* The two arms of the anchor rule, and the only place either is spelled.
   Claimed: every colour is `--hue` at a fixed lightness/chroma. Unclaimed:
   the same lightnesses at zero chroma, so an unpainted visor is the same
   shape in grey rather than a second design. */
#visor-root {
  position: relative;
  font: 14px/1.5 system-ui, sans-serif;
  color: oklch(0.22 0.02 var(--hue));
  max-width: 100%;
  /* The strip is saturated on purpose: it is the line between trusted and
     untrusted pixels, and should read as one. Everything behind it is a
     pale tint of the same hue, with the chroma spent on the accent alone. */
  --strip: oklch(0.62 0.14 var(--hue));
  --strip-edge: oklch(0.45 0.09 var(--hue));
  /* Dark ink is what lets the strip keep its saturated colour: light ink on
     a mid-lightness plate falls near 3:1 at some hues, this holds above
     4.5:1 at every one of them, pressed half or not. */
  --strip-ink: oklch(0.16 0.04 var(--hue));
  --drawer: oklch(0.95 0.02 var(--hue));
  --accent: oklch(0.48 0.12 var(--hue));
  --accent-ink: oklch(0.98 0.01 var(--hue));
  --edge: oklch(0.8 0.04 var(--hue));
  --quiet: oklch(0.45 0.04 var(--hue));
  --plate: oklch(0.99 0.005 var(--hue));
  --plate-ink: oklch(0.3 0.06 var(--hue));
  --field: oklch(0.99 0.005 var(--hue));
  /* Wide views centre content to ~720px via inline padding; `vw` so nested
     surfaces don't compound a `%`. `max(12px, …)` keeps this sheet's old
     small-screen gutter (the strip's own is narrower, set where it's used). */
  --visor-gutter: max(12px, calc((100vw - 720px) / 2));
}
#visor-root.unclaimed {
  color: oklch(0.22 0 0);
  --strip: oklch(0.62 0 0);
  --strip-edge: oklch(0.45 0 0);
  --strip-ink: oklch(0.16 0 0);
  --drawer: oklch(0.95 0 0);
  --accent: oklch(0.48 0 0);
  --accent-ink: oklch(0.98 0 0);
  --edge: oklch(0.8 0 0);
  --quiet: oklch(0.45 0 0);
  --plate: oklch(0.99 0 0);
  --plate-ink: oklch(0.3 0 0);
  --field: oklch(0.99 0 0);
}

/* The ring sits OUTSIDE its control, so it is drawn against the strip or the
   drawer rather than against a button's own fill — which is what lets one
   colour be visible on all of them. */
#visor-root :focus-visible {
  outline: 3px solid var(--strip-ink);
  outline-offset: 2px;
}

/* Fixed height on all three axes so no content can push the anchor
   around. */
#visor-strip {
  box-sizing: border-box;
  height: 56px; min-height: 56px; max-height: 56px;
  display: flex; align-items: center;
  padding: 0 max(8px, calc((100vw - 720px) / 2));
  position: relative; z-index: 3;
  background: var(--strip);
  border-bottom: 1px solid var(--strip-edge);
  color: var(--strip-ink);
}
/* Italic, not faded. Two ids on purpose: the voice rules at the foot of the
   sheet are `#visor-root .framework` — equal specificity and later in source
   order — so an override of equal weight would silently lose. */
#visor-root #visor-strip .framework { color: inherit; }

/* The two halves. Each is a whole button so the target is the half, not the
   glyph. Two ids again: `#visor-root button` (an id and an element) outranks
   a bare `#visor-app`, and the halves are not drawer buttons. */
#visor-root #visor-app, #visor-root #visor-self {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 8px;
  color: var(--strip-ink);
  background: none; border: 0; border-radius: 8px;
  padding: 4px 8px; text-align: left;
}
#visor-root #visor-self { flex-direction: row-reverse; text-align: right; }
#visor-root #visor-app[aria-pressed="true"], #visor-root #visor-self[aria-pressed="true"] { background: oklch(1 0 0 / 0.18); box-shadow: none; }
#visor-divider { width: 1px; align-self: stretch; margin: 5px; background: var(--strip-edge); }
#visor-root .glyph-tile-face, #visor-circle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--strip-edge);
  color: var(--accent-ink);
  font-size: 28px; line-height: 1; font-weight: 600;
  width: 36px; height: 36px; 
}
#visor-root .glyph-tile-face {
   border-radius: 6px; 
}
#visor-circle {
  border-radius: 50%;
  overflow: clip;
}
#visor-root .stack { flex: 1; min-width: 0; }
#visor-root .stack .top, #visor-root .stack .bottom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#visor-root .stack .bottom { font-size: 12px; }

/* The drawer is in normal flow, above the strip: it pushes the strip (and
   the app zone under it) down when it opens rather than covering the app.
   The scrim covers the app zone behind the strip and drawer alike, fixed
   to the viewport since neither the strip nor the drawer moves it. */
#visor-scrim { position: fixed; inset: 0; z-index: 1; background: oklch(0 0 0 / 0.25); }
/* `svh`, not `vh`: a handheld's own toolbar can collapse to expand the
   viewport, and `vh` tracks that larger size — sizing against it lets the
   toolbar sit over the strip. `max-height` caps whatever `height` asks for
   so at least 96px stays below the strip (the `max(0px, …)` floor is for
   screens too short to have that room at all). */
#visor-drawer {
  position: relative; z-index: 2;
  display: flex; flex-direction: column;
  box-sizing: border-box;
  height: 80svh;
  max-height: max(0px, calc(100svh - 56px - 96px));
  overflow: hidden;
  background: var(--drawer);
  border-bottom: 1px solid var(--edge);
  animation: visor-drawer-open 180ms ease-out;
}
#visor-drawer.closing { animation: visor-drawer-close 180ms ease-in forwards; }

/* One pane per tenant, stacked so two can be on screen at once while one
   slides out. The drawer's height is fixed and the pane scrolls inside it,
   so no sheet's length can move anything.

   `overflow-x: hidden`: the long machine texts each carry their own local
   horizontal scroll, so nothing may make the drawer or the page scroll
   sideways.

   The four backgrounds are the local/scroll shadow technique: the first two
   are drawer-coloured covers pinned to the content (`local`), the second
   two are shadows pinned to the viewport (`scroll`). Where there is more
   content above or below, the cover has scrolled away and the shadow shows
   — so "there is more" is visible without a scrollbar being trusted to say
   it. */
#visor-root .pane-host { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
#visor-root .pane {
  position: absolute; inset: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 12px var(--visor-gutter);
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
/* Where the caret lands when a pane opens; quiet, since it is a container. */
#visor-root .pane:focus-visible { outline: 2px dashed var(--quiet); outline-offset: -6px; }
#visor-root .pane.enter-from-right { animation: visor-enter-right 200ms ease-out; }
#visor-root .pane.enter-from-left { animation: visor-enter-left 200ms ease-out; }
#visor-root .pane.leave-to-left { animation: visor-leave-left 200ms ease-in forwards; }
#visor-root .pane.leave-to-right { animation: visor-leave-right 200ms ease-in forwards; }

@keyframes visor-drawer-open { from { height: 0; } }
@keyframes visor-drawer-close { to { height: 0; } }
@keyframes visor-enter-right { from { transform: translateX(100%); } }
@keyframes visor-enter-left { from { transform: translateX(-100%); } }
@keyframes visor-leave-left { to { transform: translateX(-100%); } }
@keyframes visor-leave-right { to { transform: translateX(100%); } }

/* Movement is decoration; the states it moves between are not. 1ms, not 0s:
   a zero-duration animation can finish without ever dispatching the
   `animationend` the visor unmounts on (observed 9 runs in 10 on a throttled
   CPU, leaving the drawer stuck mid-switch), and 1ms is imperceptible while
   still being an animation the browser reports the end of. */
@media (prefers-reduced-motion: reduce) {
  #visor-root * { animation-duration: 1ms !important; }
}

/* Unsaved changes, resting on the strip: the only thing in this tree that
   takes the press away from what raised it, so it sits where the eye
   already is — at the line, not at the top of the screen. */
#visor-confirm {
  position: absolute; bottom: 56px; left: 0; right: 0; z-index: 4;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 12px var(--visor-gutter);
  box-sizing: border-box;
  background: var(--drawer);
  border-top: 2px solid var(--strip-ink);
}
#visor-confirm:focus { outline: none; }
#visor-confirm .framework { font-weight: 600; font-size: 16px; flex: 1 1 100%; }

/* The drawer's non-scrolling last row. Its own content determines its
   height, so the pane gives up exactly that much room without a duplicated
   offset. The confirmation dialog is positioned at this same strip edge and
   the drawer is inert beneath it. */
#visor-actions {
  flex: none;
  display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px;
  padding: 8px var(--visor-gutter);
  box-sizing: border-box;
  background: var(--drawer);
  border-top: 1px solid var(--edge);
}

/* The line at the top of every pane. Only the pane that is staying
   carries the id — during a slide there are two of these on screen. */
#visor-root .notice { margin-bottom: 8px; min-height: 1.4em; overflow-wrap: break-word; }

/* Controls are at least 44px on both axes; the strip's pinned 56px is
   unaffected, its halves being taller than that already. */
#visor-root button {
  font: inherit; color: var(--accent-ink); background: var(--accent);
  border: 1px solid var(--accent); border-radius: 6px;
  padding: 8px 12px; min-height: 44px;
  cursor: pointer;
  max-width: 100%;
}
#visor-root button[aria-pressed="true"] { border-color: var(--plate-ink); box-shadow: inset 0 0 0 1px var(--accent-ink); }
/* Disabled is said with the fill and the cursor rather than with an opacity. */
#visor-root button[disabled] { background: var(--edge); color: var(--plate-ink); border-color: var(--edge); cursor: default; }
/* The colour slider is the hue wheel itself, unrolled: a gradient
   interpolated in oklch around the long way so it visits every hue once at
   the strip's lightness/chroma, and the thumb sits on the one chosen. It
   names hues 0 and 360 — every hue, which is why it reveals none.

   The control is 44px tall while the track it paints stays a 14px band
   centred in it: `background-size` separates the target from the
   decoration. */
#visor-root input[type="range"] {
  appearance: none; -webkit-appearance: none;
  flex: 1 1 12ch; min-width: 120px; max-width: 320px;
  height: 44px; margin: 0;
  border: 0; background-color: transparent;
  background-image: linear-gradient(to right in oklch longer hue, oklch(0.62 0.14 0), oklch(0.62 0.14 360));
  background-repeat: no-repeat;
  background-position: center center;
  background-size: 100% 14px;
  accent-color: var(--accent);
}
#visor-root input[type="range"]::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--strip); border: 2px solid var(--plate);
  box-shadow: 0 0 0 1px var(--strip-edge);
}
#visor-root input[type="range"]::-moz-range-thumb {
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--strip); border: 2px solid var(--plate);
  box-shadow: 0 0 0 1px var(--strip-edge);
}
#visor-root input[type="text"], #visor-root input[type="password"] {
  font: inherit; color: inherit; background: var(--field);
  border: 1px solid var(--edge); border-radius: 6px;
  padding: 8px; min-height: 44px; box-sizing: border-box;
  /* Shrinks to nothing rather than pushing a row wider than the drawer, and
     stops growing at a field's worth: a petname box spanning a 1280px window
     is harder to read, not easier. */
  min-width: 0; max-width: min(24rem, 100%);
}
#visor-root input[type="search"] {
  font: inherit; color: inherit; background: var(--field);
  border: 1px solid var(--edge); border-radius: 6px;
  padding: 8px; min-height: 44px; min-width: 0; box-sizing: border-box;
}
#visor-root label input { flex: 1 1 16ch; }
#visor-root .sheet > input { align-self: stretch; }
#visor-root label {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  margin-bottom: 12px;
  align-self: stretch;
}
#visor-root label > span:first-child { flex: 0 0 auto; }
#visor-root .glyph-control {
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  align-self: flex-start; width: min(32rem, 100%); margin-bottom: 12px;
}
#visor-root .glyph-control-row { display: flex; align-items: center; gap: 8px; }
#visor-root .glyph-control-row > span { flex: none; }
#visor-root .glyph-tile-button {
  flex: none; padding: 4px; min-width: 44px; min-height: 44px;
  border: 0; background: transparent;
}
#visor-root .glyph-tile-button .glyph-tile-face { pointer-events: none; }
#visor-root .glyph-picker {
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  padding: 8px; border: 1px solid var(--edge);
  border-radius: 6px; background: var(--field);
}
#visor-root .glyph-picker label { margin: 0; }
#visor-root .glyph-results {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 4px; max-height: min(16rem, 36vh); overflow-y: auto;
}
#visor-root .glyph-results button { padding: 4px; font-size: 24px; }
#visor-root .glyph-picker .glyph-clear { align-self: flex-start; font-size: inherit; }

/* Rows wrap rather than overlap: a name and some framework-voice facts about
   it do not fit on one 320px line, so the facts follow under the name. */
#visor-root .app-row, #visor-root .device-row,
#visor-root .member-row, #visor-root .peer-row, #visor-root .sync-self {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  align-self: stretch; padding: 6px 0;
}
#visor-root .app-row-title, #visor-root .device-row-name, #visor-root .member-row-name {
  flex: 1 1 12ch; min-width: 0;
}

/* The device ceremonies: unseal, keep, the entry picker, erase. The
   negative margin cancels `.pane`'s own gutter (viewport-relative, so it
   doesn't compound), making the separator full-bleed under the column. */
#visor-root .sheet {
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  padding: 12px var(--visor-gutter);
  margin: 0 calc(-1 * var(--visor-gutter));
  box-sizing: border-box;
  border-top: 1px solid var(--edge);
}
/* Larger and weighted, and still in whichever voice the sentence belongs to:
   the framework's italic is not traded away for a heading style. */
#visor-root .sheet-head { font-size: 16px; margin-bottom: 4px; }
#visor-root .sheet-head .framework, #visor-root .sheet-head .user { font-weight: 600; }
#visor-root .sheet-error { margin-top: 2px; }
#visor-root .choice { display: flex; flex-wrap: wrap; gap: 8px; }

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
   either way makes that swap layout-neutral.

   `min-width: 0` and `max-width: 100%` are what make the scroll local:
   without them the nowrap text sets the row's minimum width and pushes the
   drawer sideways at 320px instead of scrolling inside its own box.
   `tabindex="0"` on the element itself is not needed — Chromium focuses
   overflowing scroll containers for the keyboard — but the e2e gate checks
   that, since it is a recent behaviour. */
#visor-root .endpoint-id {
  font-family: ui-monospace, monospace;
  user-select: all;
  white-space: nowrap;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  display: block;
  flex: 1 1 12ch;
  min-width: 0; max-width: 100%;
}

/* Pairing. The code is 79 characters shown in groups of four: monospace so
   the groups line up, selectable as a whole, and wrapped at the spaces
   between groups (the only place it may break — a group broken mid-way is
   a group read wrong). */
#visor-root .pairing-code {
  font-family: ui-monospace, monospace;
  user-select: all;
  align-self: stretch;
  max-width: 100%;
  line-height: 1.6;
}

/* The six digits both users compare. The largest thing in the drawer on
   purpose: the entire security of the ceremony is one person reading them
   off this screen and another agreeing they match, so they are sized to be
   read across a desk, spaced so no two digits run together, and selectable
   like every other machine text here. */
#visor-root .pairing-sas {
  font-family: ui-monospace, monospace;
  font-size: 40px;
  letter-spacing: 6px;
  user-select: all;
  max-width: 100%;
}

/* The three voices. polyvisor speaking. */
#visor-root .framework { color: var(--quiet); font-style: italic; overflow-wrap: break-word; }
/* The user's own words, echoed: upright, weighted, never quoted. A long name
   wraps rather than being truncated or laid over the facts beside it. */
#visor-root .user { font-weight: 600; font-style: normal; color: inherit; overflow-wrap: break-word; }
/* A publisher's words: plated, monospace, quoted, so foreign text is
   visibly foreign wherever it lands. The plate is derived from the hue
   like everything else, but far lighter than the drawer it sits on, so it
   stays a plate at every hue. */
#visor-root .app {
  font-family: ui-monospace, monospace;
  background: var(--plate); color: var(--plate-ink);
  border: 1px solid var(--edge);
  border-radius: 4px; padding: 1px 5px;
  overflow-wrap: break-word;
  quotes: '"' '"';
}
"#;
