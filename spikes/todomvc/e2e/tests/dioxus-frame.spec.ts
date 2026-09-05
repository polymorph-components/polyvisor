// GATE D2: the re-targeted dioxus guest, on its DEFAULT (frame) backend,
// driven through real interaction inside the sandboxed frame.
//
// This is the gate for the re-target itself: TodoMVC written in dioxus,
// compiled to a `polymorph:dioxus` component, running on polyengine-dioxus,
// with its DOM applied inside an iframe on an OPAQUE ORIGIN and every event
// travelling back over a MessageChannel (host/dioxus-frame.ts).
//
// Playwright reaches into cross-origin frames over CDP, so `frameLocator`
// drives the app's real DOM and `Frame.evaluate` reads its real computed
// styles — neither of which the shell's own JS can do, which is the entire
// point of the arrangement being tested.
//
// Three things are asserted that are easy to lose in a re-target:
//
//   1. THE APP STILL WORKS, through real interaction rather than synthetic
//      events: add, toggle, edit-and-commit, cancel-an-edit, destroy, filter.
//   2. THE FRAME IS STILL OPAQUE. The shell paints the user's personal anchor
//      colour into `--visor-bg`; the app's document must not be able to
//      resolve it. That is the property the frame exists for
//      (visor/frame/frame-backend.ts's header), and a re-target that mounted
//      the app same-realm would silently lose it while every functional
//      assertion above still passed.
//   3. THE ARTIFACT DOES NOT IMPORT `eval`. Apps never get it.

import { expect, type FrameLocator, type Page, test } from "@playwright/test";

const baseUrl = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup did not run");
  return url;
};

/** The app's DOM lives in the sandboxed frame; everything below addresses it
 * through here. */
const app = (page: Page): FrameLocator => page.frameLocator("#app iframe");

/** The visible todo titles, in order. */
async function titles(page: Page): Promise<string[]> {
  return await app(page).locator(".todo-list li label").allTextContents();
}

async function addTodo(page: Page, text: string): Promise<void> {
  const input = app(page).locator(".new-todo");
  // NOT `.focus()` first: `dom.set-focus` is one of the imports that cannot
  // cross the frame (host/dioxus-frame.ts, degradation 2), so the app's
  // `autofocus` does nothing here and the click is what focuses the field.
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  (page as unknown as { __errors: string[] }).__errors = errors;
});

test("dioxus guest on the frame backend: full TodoMVC interaction", async ({ page }) => {
  await page.goto(`${baseUrl()}/index.html?guest=dioxus`);

  // The mount is a handshake plus an instantiation plus a first batch; the
  // first rendered node is the honest readiness signal.
  await expect(app(page).locator(".todoapp")).toBeVisible({ timeout: 60_000 });

  // -- add three ------------------------------------------------------------
  await addTodo(page, "write the renderer");
  await addTodo(page, "delete the prototype");
  await addTodo(page, "keep the frame opaque");

  await expect(app(page).locator(".todo-list li")).toHaveCount(3);
  expect(await titles(page)).toEqual([
    "write the renderer",
    "delete the prototype",
    "keep the frame opaque",
  ]);
  await expect(app(page).locator(".todo-count")).toContainText("3 items left");

  // -- toggle one -----------------------------------------------------------
  await app(page).locator(".todo-list li").nth(1).locator(".toggle").click();
  await expect(app(page).locator(".todo-list li").nth(1)).toHaveClass(/completed/);
  await expect(app(page).locator(".todo-count")).toContainText("2 items left");

  // -- edit one via dblclick + Enter ----------------------------------------
  const first = app(page).locator(".todo-list li").nth(0);
  await first.locator("label").dblclick();
  await expect(first).toHaveClass(/editing/);
  const edit = first.locator(".edit");
  // Explicit click: `autofocus` on the edit field cannot work across the
  // frame (degradation 2 again — this is the gap the README records, now with
  // a structural cause rather than a missing-plumbing one).
  await edit.click();
  await edit.fill("write the renderer (done)");
  await edit.press("Enter");
  await expect(first).not.toHaveClass(/editing/);
  expect(await titles(page)).toEqual([
    "write the renderer (done)",
    "delete the prototype",
    "keep the frame opaque",
  ]);

  // -- cancel an edit via Escape --------------------------------------------
  //
  // WHAT "CANCEL" MEANS IN THIS APP, precisely: Escape leaves edit mode. It
  // does NOT revert the text — the edit field's `oninput` writes straight
  // through to the model on every keystroke, so by the time Escape arrives
  // the change is already committed. That is upstream dioxus's own TodoMVC
  // example behaviour (inherited with the app body, see
  // ../../guest-dioxus/src/lib.rs's provenance note), and it diverges from
  // the TodoMVC spec, which requires Escape to restore the previous value.
  // Asserted as it actually behaves rather than as the spec wishes: a test
  // that asserted reversion would be testing a feature nobody wrote.
  const third = app(page).locator(".todo-list li").nth(2);
  await third.locator("label").dblclick();
  await expect(third).toHaveClass(/editing/);
  await third.locator(".edit").press("Escape");
  await expect(third).not.toHaveClass(/editing/);
  await expect(app(page).locator(".todo-list li")).toHaveCount(3);

  // -- destroy one ----------------------------------------------------------
  //
  // The destroy button is `display:none` until its row is hovered
  // (todomvc-app.css), so hover first: Playwright's actionability check
  // rejects a non-visible target before it would ever move the mouse there.
  const second = app(page).locator(".todo-list li").nth(1);
  await second.hover();
  await second.locator(".destroy").click();
  await expect(app(page).locator(".todo-list li")).toHaveCount(2);
  expect(await titles(page)).toEqual([
    "write the renderer (done)",
    "keep the frame opaque",
  ]);
});

test("dioxus guest: the filter is a route, in both directions", async ({ page }) => {
  await page.goto(`${baseUrl()}/index.html?guest=dioxus`);
  await expect(app(page).locator(".todoapp")).toBeVisible({ timeout: 60_000 });

  await addTodo(page, "active one");
  await addTodo(page, "completed one");
  await app(page).locator(".todo-list li").nth(1).locator(".toggle").click();
  await expect(app(page).locator(".todo-list li").nth(1)).toHaveClass(/completed/);

  // -- GUEST → HOST: clicking a filter pushes onto the shell's history -------
  //
  // The route reaches the SHELL's URL fragment because the host's provider is
  // `fragmentHistory(window)` and history runs shell-side (host/
  // dioxus-frame.ts). The guest never sees that encoding — wit/world.wit's
  // `interface history` is explicit that the encoding is the host's choice.
  await app(page).locator(".filters li a", { hasText: "Active" }).click();
  await expect(page).toHaveURL(/#\/active$/);
  expect(await titles(page)).toEqual(["active one"]);

  await app(page).locator(".filters li a", { hasText: "Completed" }).click();
  await expect(page).toHaveURL(/#\/completed$/);
  expect(await titles(page)).toEqual(["completed one"]);

  await app(page).locator(".filters li a", { hasText: "All" }).click();
  await expect(page).toHaveURL(/#\/$/);
  expect(await titles(page)).toEqual(["active one", "completed one"]);

  // -- HOST → GUEST: the back button ----------------------------------------
  //
  // A DIFFERENT PATH, and the one the `changes` stream exists for. The three
  // clicks above were guest-initiated pushes, which deliberately do NOT come
  // back on `changes`. Going back is the host moving without the guest
  // asking: popstate -> fragmentHistory.onChange -> the `changes` stream ->
  // `WitHistory::updater` -> the guest's re-render. If this leg were broken
  // the URL would change and the list would not.
  //
  // `history.back()` rather than `page.goBack()`: Playwright's navigation
  // helper waits for a `load` event, and these are same-document hash
  // navigations, which fire none. The browser action is identical — this is
  // the back button — and the assertions below do the waiting, by polling.
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/#\/completed$/);
  await expect(app(page).locator(".todo-list li label")).toHaveText(["completed one"]);

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/#\/active$/);
  await expect(app(page).locator(".todo-list li label")).toHaveText(["active one"]);
});

test("the app frame is opaque: it cannot resolve the shell's anchor colour", async ({ page }) => {
  await page.goto(`${baseUrl()}/index.html?guest=dioxus`);
  await expect(app(page).locator(".todoapp")).toBeVisible({ timeout: 60_000 });

  // The assertion is only meaningful if the shell actually HAS the colour, so
  // establish that first — otherwise "the frame sees nothing" would pass
  // vacuously on a page where nothing was ever painted.
  const shellColour = await page.evaluate(() => {
    const strip = document.getElementById("visor-strip");
    if (!strip) return null;
    return getComputedStyle(strip).getPropertyValue("--visor-bg").trim();
  });
  expect(shellColour, "the shell's visor strip should carry --visor-bg").toBeTruthy();

  const frame = page.frames().find((f) => f.url().includes("frame-dioxus.html"));
  expect(frame, "the app frame should be present").toBeTruthy();

  // Inside the frame: the custom property resolves to nothing. Checked on the
  // documentElement and on the app's own root, since inheritance is the
  // mechanism a leak would travel by.
  const seen = await frame!.evaluate(() => {
    const read = (el: Element) =>
      getComputedStyle(el).getPropertyValue("--visor-bg").trim();
    return {
      html: read(document.documentElement),
      body: read(document.body),
      app: read(document.getElementById("app")!),
      // Reaching the embedder's document at all is the other half of the
      // property: an opaque origin makes this throw rather than return.
      parentReachable: (() => {
        try {
          return !!(window.parent as Window & typeof globalThis).document;
        } catch {
          return false;
        }
      })(),
    };
  });

  expect(seen.html).toBe("");
  expect(seen.body).toBe("");
  expect(seen.app).toBe("");
  expect(seen.parentReachable).toBe(false);
});

test("the dioxus artifact does not import polymorph:dioxus/eval", async ({ page }) => {
  // The deployed artifact itself, fetched exactly as the page fetches it.
  // Interface ids are stored as plain UTF-8 in a component's import section,
  // so a byte scan is a faithful read of the import list — and the two
  // POSITIVE controls below are what make the negative meaningful: the same
  // scan finds the imports that ARE there.
  const res = await page.request.get(`${baseUrl()}/todomvc-dioxus.component.wasm`);
  expect(res.ok()).toBe(true);
  const text = new TextDecoder("latin1").decode(await res.body());

  expect(text.includes("polymorph:dioxus/history")).toBe(true);
  expect(text.includes("polymorph:dioxus/head")).toBe(true);
  expect(
    text.includes("polymorph:dioxus/eval"),
    "apps never get eval (wit/world.wit, `interface eval`) — the renderer's eval feature must stay off",
  ).toBe(false);
});
