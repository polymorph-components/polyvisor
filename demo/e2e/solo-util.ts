// Shared driving helpers for the SOLO page's scenarios.
//
// Three scenarios now drive `/solo.html` — `solo-pairing` (two
// independent devices meeting over the relay), `solo-persistence` (a
// device that is kept, reloaded, and sealed again) and `solo-ephemeral`
// (a device that is not kept, and the strip rule about how many there
// are). They act as a user in the same two places, so those two places
// live here rather than in whichever scenario was written first:
//
//   * the TODOMVC SURFACE inside the sandboxed frame, which is a genuine
//     cross-document drive (the frame has an opaque origin) and which
//     has one non-obvious rule about pacing — see `addTodo`;
//   * the page's own `__solo` driving root, and the poll loop that
//     drains its single-shot timers while waiting.
//
// Nothing here asserts. A helper that asserted would be a claim made
// somewhere other than in the scenario making it.

import type { Page } from "npm:playwright@1.57.0";
import { hookOn, sleep } from "./util.ts";

/** The solo page's driving root. Named rather than sniffed, so a call
 * against a page that booted the wrong document fails loudly. */
export const R = "__solo";
export const solo = (page: Page, path: string, ...args: unknown[]) =>
  hookOn(page, R, path, ...args);

/** How long each cross-page step may take. Every one of these crosses
 * the relay; the ceremony's own steps are bounded by PAIRING.md §1's
 * 120s offer expiry, and the convergence ones by however long a
 * subduction subscription takes to deliver a change. */
export const WAITS = {
  code: 30_000,
  sas: 60_000,
  enrolled: 90_000,
  converge: 90_000,
  /** A boot that has to instantiate the engine inside the device's
   * worker, resume from a checkpoint and mount an app. */
  boot: 90_000,
};

/** Poll `f` until it answers something other than `false`, driving the
 * pages' own single-shot drains meanwhile so a slow machine cannot turn
 * a real assertion into a flake. */
export async function until<T>(
  pages: Page[],
  what: string,
  f: () => Promise<T | false>,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    for (const p of pages) await solo(p, "tick").catch(() => {});
    try {
      const v = await f();
      if (v !== false) return v;
      last = v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** The todomvc surface inside the sandboxed frame. `#solo-app iframe` is
 * the frame the visor drew; everything below it is the app's own DOM,
 * which the visor cannot reach and Playwright can. */
export const appFrame = (page: Page) => page.frameLocator("#solo-app iframe");
export const todoRows = (page: Page) => appFrame(page).locator("ul.todo-list li");

/** Type one todo the way a user does — and WAIT FOR THE APP BOTH SIDES
 * OF IT, which is not defensive padding but the only correct way to
 * drive this surface.
 *
 * The app clears the input by sending a `value` op back through the
 * surface protocol once it has consumed an Enter. That op is
 * asynchronous with respect to the driver, so typing the next todo
 * immediately races it: the clear lands AFTER the second `fill`, the
 * Enter then carries an empty string, and the app correctly ignores it.
 * Measured, not theorised — with an iroh endpoint bound (i.e. under the
 * harness, but not in a quick local probe without a relay) the second of
 * two back-to-back todos was dropped every time.
 *
 * So each entry waits for the box to be EMPTY before typing (the app's
 * own "I am ready for the next one" signal — exactly what a human reads
 * off the screen) and for the row to APPEAR after (the app's "I took
 * it"). A driver that does not look at the screen between keystrokes is
 * not modelling a user. */
export async function addTodo(page: Page, title: string) {
  const input = appFrame(page).locator("input.new-todo");
  await input.waitFor({ state: "visible", timeout: WAITS.converge });
  const before = await todoRows(page).count();
  const deadline = Date.now() + WAITS.converge;
  while ((await input.inputValue()) !== "") {
    if (Date.now() > deadline) throw new Error("the todo input never cleared");
    await sleep(50);
  }
  await input.fill(title);
  await input.press("Enter");
  while ((await todoRows(page).count()) <= before) {
    if (Date.now() > deadline) throw new Error(`the app never rendered a row for ${title}`);
    await sleep(50);
  }
}

/** WHAT THE STRIP IS SHOWING OF THE USER, read straight off the DOM.
 *
 * The anti-spoofing claim (PERSISTENCE.md, "The index: what may exist
 * before unseal") is about PIXELS, not about the page's own account of
 * itself, so this reads the two things a user would recognise: the
 * anchor colour, as the inline custom property `applyVisorHue` scopes to
 * the strip element, and the identity cluster's text. Both are empty
 * before a seal opens and both are present after — that ordering IS the
 * property. */
export function stripPersonal(
  page: Page,
): Promise<{ anchorColour: string; identityText: string }> {
  return page.evaluate(() => {
    const strip = document.getElementById("visor-strip");
    return {
      anchorColour: strip?.style.getPropertyValue("--visor-bg") ?? "",
      identityText: (document.getElementById("visor-identity")?.textContent ?? "").trim(),
    };
  });
}
