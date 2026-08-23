// The strip's geometry, at a desk width and a phone width.
//
// The two-line strip is an ANCHOR: it has to stay legible, tappable and
// on-screen no matter what words are in it — and the words are not all
// the visor's. A component's self-declared nickname and the user's own
// petname are both variable-length, and a pathological one must ellipsize
// rather than push the identity cluster (the half a rectangle cannot
// reproduce) off the edge of the bar.
//
// These are the claims a hand-drive checks by squinting. Here they are
// numbers: cluster widths as a fraction of the bar, a real tap-target
// floor, and zero horizontal overflow on the DOCUMENT.

import type { Scenario } from "../run.ts";
import { act, assert, hook, KEYS, waitForSheet } from "../util.ts";
import type { Page } from "npm:playwright@1.57.0";

/** A name long enough to be hostile at any width, but within the 40-char
 * clamp the visor applies when RENDERING — so this tests the layout, not
 * the clamp (`petnameSpan`/`nicknameQuote` slice at 40). */
const LONG_PETNAME = "the quarterly planning board for everyone";

interface Metrics {
  barInner: number;
  stripHeight: number;
  lineHeight: number;
  context: { w: number; h: number };
  identity: { w: number; h: number };
  gap: number;
  settingsBtn: { w: number; h: number };
  lines: { h: number; scrollW: number; clientW: number }[];
  docOverflow: number;
  idLines: { scrollW: number; clientW: number }[];
}

function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const strip = document.getElementById("visor-strip")!;
    const inner = strip.querySelector(".bar-inner") as HTMLElement;
    const context = document.getElementById("visor-context")!;
    const identity = document.getElementById("visor-identity")!;
    const btn = document.getElementById("visor-settings")!;
    // The CONTENT box, not the border box: `.bar-inner` carries
    // horizontal padding, and the CSS caps (`max-width: 45%`) resolve
    // against the content width. Measuring the border box makes every
    // fraction read ~5% low and turns the exact 45/45/10 split the
    // layout is built on into a spurious failure.
    const istyle = getComputedStyle(inner);
    const innerContent = inner.clientWidth -
      parseFloat(istyle.paddingLeft) - parseFloat(istyle.paddingRight);
    const ir = { width: innerContent };
    const cr = context.getBoundingClientRect();
    const idr = identity.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const top = context.querySelector(".ctx-top") as HTMLElement;
    const lines = [".ctx-top", ".ctx-bottom"].map((sel) => {
      const el = context.querySelector(sel) as HTMLElement;
      return { h: el.getBoundingClientRect().height, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    return {
      barInner: ir.width,
      stripHeight: strip.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(top).lineHeight) ||
        top.getBoundingClientRect().height,
      lines,
      context: { w: cr.width, h: cr.height },
      identity: { w: idr.width, h: idr.height },
      // The visual separation between the two clusters: what stops the
      // component's words from appearing to be part of the visor's.
      gap: idr.left - cr.right,
      settingsBtn: { w: br.width, h: br.height },
      // Zero tolerance: a horizontal scrollbar on the DOCUMENT means the
      // anchor can be scrolled out of view.
      docOverflow: document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      idLines: Array.from(document.querySelectorAll("#visor-identity .id-lines .who")).map(
        (e) => ({ scrollW: (e as HTMLElement).scrollWidth, clientW: (e as HTMLElement).clientWidth }),
      ),
    };
  });
}

/** Seeded state shared by both widths: pathological words in every
 * variable slot the strip has. */
const hostileStorage = {
  [KEYS.identity]: JSON.stringify({
    name: "Ada Lovelace-Byron the Countess",
    device: "the study PC under the stairs",
    icon: "⚑",
  }),
};

const scenario: Scenario = {
  name: "strip-geometry",
  why: "at 1280 and 390 the strip stays two lines, tappable, balanced and free of horizontal overflow",
  page: { storage: hostileStorage },

  async run(page, ctx) {
    /** The claims that must hold at EVERY width. */
    const checkAt = async (p: Page, label: string, width: number) => {
      const m = await measure(p);

      // TWO LINES, AND ONLY TWO. The claim is about `.ctx-top` and
      // `.ctx-bottom` individually: each is `white-space: nowrap` with
      // an ellipsis (web/index.html), so each must stay exactly one line
      // however long the words in it are. A wrap here is the anchor
      // growing under the user's pointer. (The strip's own height is set
      // by the 44px tap target, which is taller than two 14px lines, so
      // measuring the strip against line-height would measure the
      // button rather than the wrapping.)
      for (const [i, line] of m.lines.entries()) {
        const which = i === 0 ? ".ctx-top" : ".ctx-bottom";
        assert(
          line.h <= m.lineHeight * 1.6,
          `${label}: ${which} is ${line.h.toFixed(1)}px — it wrapped (one line is ${
            m.lineHeight.toFixed(1)
          }px)`,
        );
      }
      const budget = Math.max(m.lineHeight * 2, m.settingsBtn.h);
      assert(
        m.stripHeight <= budget + 16,
        `${label}: strip height ${m.stripHeight.toFixed(1)}px exceeds ${
          budget.toFixed(1)
        }px + padding — something wrapped`,
      );

      // A real tap target. 44×44 is the floor a thumb needs, and this
      // button is the way into the visor's own settings.
      assert(
        m.settingsBtn.w >= 44 && m.settingsBtn.h >= 44,
        `${label}: the settings button is ${m.settingsBtn.w.toFixed(1)}×${
          m.settingsBtn.h.toFixed(1)
        }px, under the 44×44 floor`,
      );

      // NEITHER cluster may take the bar. The component's words are
      // capped so they cannot crowd out the identity; the identity is
      // capped so it cannot crowd out the context.
      // A subpixel tolerance on every fraction: the caps are hit EXACTLY
      // at 390 (45.0/45.0/10.0 — the gap is the arithmetic complement of
      // the two caps), and layout rounding must not make an exact fit
      // read as an overflow.
      const EPS = 0.002;
      const ctxFrac = m.context.w / m.barInner;
      const idFrac = m.identity.w / m.barInner;
      assert(
        ctxFrac <= 0.45 + EPS,
        `${label}: the context cluster is ${(ctxFrac * 100).toFixed(1)}% of the bar (cap 45%)`,
      );
      assert(
        idFrac <= 0.45 + EPS,
        `${label}: the identity cluster is ${(idFrac * 100).toFixed(1)}% of the bar (cap 45%)`,
      );

      // And they must be visibly SEPARATE: adjacency is how a component's
      // words would read as part of the visor's sentence.
      const gapFrac = m.gap / m.barInner;
      assert(
        gapFrac >= 0.10 - EPS,
        `${label}: the clusters are ${(gapFrac * 100).toFixed(1)}% apart (floor 10%)`,
      );

      // The anchor cannot be scrolled off the screen.
      assert(
        m.docOverflow <= 0,
        `${label}: the document overflows horizontally by ${m.docOverflow}px`,
      );
      return m;
    };

    await act("at 1280 the strip holds its shape with pathological names", async () => {
      // Give every variable slot a hostile value first: the app's
      // petname is the longest thing the visor itself will say.
      await hook(page, "naming.openCluster");
      await waitForSheet(page, "naming", true);
      await hook(page, "naming.type", LONG_PETNAME);
      await hook(page, "naming.save");
      await waitForSheet(page, "naming", false);
      await checkAt(page, "1280", 1280);
    });

    await act("at 1280 the identity lines are NOT truncated (there is room)", async () => {
      const m = await measure(page);
      assert(m.idLines.length === 2, `expected two identity lines, got ${m.idLines.length}`);
      for (const l of m.idLines) {
        assert(
          l.scrollW <= l.clientW + 1,
          `an identity line ellipsized at 1280 (scrollWidth ${l.scrollW} > clientWidth ${l.clientW})`,
        );
      }
    });

    let narrow: Page;
    await act("at 390 the strip still holds its shape", async () => {
      // A fresh context at phone width, carrying the same hostile
      // storage plus the petname just committed.
      const stored = await page.evaluate(() => localStorage.getItem("pm-demo-surface-marks"));
      narrow = await ctx.fresh({
        viewport: { width: 390, height: 844 },
        storage: { ...hostileStorage, [KEYS.marks]: stored ?? "{}" },
      });
      const m = await checkAt(narrow, "390", 390);
      // The petname really is on the line being measured — otherwise
      // the geometry above would be trivially satisfied.
      const top = await narrow.evaluate(() =>
        document.querySelector("#visor-context .ctx-top")?.textContent ?? ""
      );
      assert(
        top.includes("quarterly planning"),
        `the long petname was not on the strip at 390: ${JSON.stringify(top)}`,
      );
      assert(m.identity.w > 0, "the identity cluster vanished at 390");
    });

    await act("at 390 the identity lines ellipsize IN PLACE rather than disappearing", async () => {
      // The #22 change this checks: the two identity lines used to be
      // HIDDEN on a narrow viewport, which dropped half of what an
      // impersonating rectangle cannot reproduce at exactly the width
      // where the strip is most crowded. They ellipsize instead.
      const m = await measure(narrow);
      assert(m.idLines.length === 2, `expected two identity lines at 390, got ${m.idLines.length}`);
      const truncated = m.idLines.filter((l) => l.scrollW > l.clientW + 1).length;
      assert(
        truncated > 0,
        `no identity line ellipsized at 390 — the cap is not biting: ${JSON.stringify(m.idLines)}`,
      );
      // Still visible, and still inside the strip.
      const visible = await narrow.evaluate(() => {
        const el = document.querySelector("#visor-identity .id-lines .who") as HTMLElement | null;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      });
      assert(visible, "an identity line was hidden rather than ellipsized at 390");
    });

    await act("a sheet never pushes the anchor off-screen at 390", async () => {
      // The height budget every sheet computes (`fit`): the strip is the
      // anchor, and a drawer that shoved it past the viewport would take
      // away the thing the user is meant to check against.
      await hook(narrow, "settings.openSheet");
      await waitForSheet(narrow, "settings", true);
      const ok = await narrow.evaluate(() => {
        const r = document.getElementById("visor-strip")!.getBoundingClientRect();
        const zone = document.getElementById("visor-zone")!.getBoundingClientRect();
        return {
          onScreen: r.bottom <= globalThis.innerHeight + 1 && r.top >= -1,
          // What is left of the app under the whole assembly.
          appBand: globalThis.innerHeight - zone.bottom,
          overflow: document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      assert(ok.onScreen, "the strip was pushed off-screen by an open sheet at 390");
      // AND THE BAND BELOW IT (visor.ts's APP_REVEAL): the anchor being
      // on screen is not enough on its own — a sheet allowed to grow
      // until the assembly fills the viewport leaves nothing of the app
      // showing, and a visor covering everything is indistinguishable
      // from a page that has drawn one. 40 rather than the constant's
      // 48, so layout rounding cannot read as a regression.
      assert(
        ok.appBand >= 40,
        `an open sheet at 390 left only ${ok.appBand.toFixed(1)}px of app surface below the ` +
          `assembly — the boundary between the visor's pixels and the page's stops being visible`,
      );
      assert(ok.overflow <= 0, `an open sheet overflowed horizontally by ${ok.overflow}px at 390`);
    });
  },
};

export default scenario;
