// CDP helpers — CHROMIUM ONLY. A firefox-lane scenario (`engine:
// "firefox"` in a Scenario) must never import this file: Firefox's
// remote-debugging protocol is not CDP, and playwright's Firefox pages
// have no `browser.newBrowserCDPSession()`/page-level CDP session to
// hand back.
//
// THE KILL SEQUENCE WAS SPIKED, not assumed — see
// /tmp/opencode/cdp-sw-spike/spike.ts for the throwaway probe this
// finding came from (page.html loads a SharedWorker over a `data:` URL
// so the spike needs no server). It tried the two candidate sequences
// the polyvisor-e2e dispatch named as genuinely uncertain:
//   (a) Target.closeTarget(targetId) on the shared_worker's own target
//   (b) Target.attachToTarget(flatten:true) + Runtime.evaluate("self.close()")
//       routed to the flattened sub-session
// MEASURED 2026-08-24, headless Chromium under playwright@1.57.0:
// (a) ALONE is sufficient. `Target.closeTarget` returned
// `{ success: true }`, the worker's targetId immediately stopped
// appearing in `Target.getTargets`, and a page-side
// `port.postMessage("ping")` round-trip that answered before the call
// (1 pong for 1 ping) stopped answering after it (0 pongs for 1 ping).
// (b) was never attempted: (a) already satisfied both verification
// criteria the dispatch asked for, and playwright's `CDPSession.send`
// has no `sessionId` parameter to route a flattened sub-session's
// commands through in the first place — pursuing it would have meant
// reimplementing CDP session routing by hand for a path this repo does
// not need.

import type { Browser, Page } from "npm:playwright@1.57.0";

export interface SharedWorkerTarget {
  targetId: string;
  url: string;
}

/** Every `shared_worker`-typed CDP target in this browser (all
 * contexts, not just one page's — `Target.getTargets` is browser-wide).
 *
 * DETACHES the browser-level session it opens, in a `finally`: a
 * long-running scenario that polls this (or `killSharedWorker`, which
 * calls it) repeatedly would otherwise accumulate one CDP session per
 * call for the life of the browser — `newBrowserCDPSession()` has no
 * implicit lifetime tied to this function's return. */
export async function listSharedWorkers(browser: Browser): Promise<SharedWorkerTarget[]> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets") as {
      targetInfos: { targetId: string; type: string; url: string }[];
    };
    return targetInfos
      .filter((t) => t.type === "shared_worker")
      .map((t) => ({ targetId: t.targetId, url: t.url }));
  } finally {
    await cdp.detach().catch(() => { /* already gone */ });
  }
}

/** Terminate the one shared worker whose URL contains `urlSubstring`,
 * and return what was killed. `Target.closeTarget` is sufficient by
 * itself — see the file banner's spike finding — so this needs no
 * attach/evaluate fallback. Throws, NAMING the live targets, if no
 * worker matches: a scenario asserting "the device host's worker died"
 * must fail loudly rather than silently killing the wrong one (or
 * nothing) when a URL is renamed out from under it. Detaches its own
 * browser-level session in a `finally`, same reasoning as
 * `listSharedWorkers`. */
export async function killSharedWorker(
  browser: Browser,
  urlSubstring: string,
): Promise<SharedWorkerTarget> {
  const workers = await listSharedWorkers(browser);
  const target = workers.find((w) => w.url.includes(urlSubstring));
  if (!target) {
    throw new Error(
      `no shared worker matching ${JSON.stringify(urlSubstring)} — live targets: ${
        JSON.stringify(workers.map((w) => w.url))
      }`,
    );
  }
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await cdp.detach().catch(() => { /* already gone */ });
  }
  return target;
}

/** `Page.setWebLifecycleState` (CDP), for the beat that needs a real
 * frozen-tab timer stall rather than a network partition.
 *
 * THE SESSION IS DELIBERATELY LEFT ATTACHED — unlike the two helpers
 * above, this one does NOT detach its CDP session when it returns.
 * SPIKED 2026-08-24 (/tmp/opencode/cdp-sw-spike/lifecycle-detach-spike3.ts):
 * freeze a page with a live `setInterval` counter, `page.evaluate()` the
 * counter while still attached (returns the STALE pre-freeze value — the
 * timer is genuinely stalled, not just slow), `cdp.detach()`, then
 * `page.evaluate()` again — the counter had RESUMED CLIMBING. Detaching
 * the very session that issued `setWebLifecycleState` reverts the
 * freeze; it is a session-scoped override (like an `Emulation` domain
 * override), not a one-shot imperative action. So a caller wanting the
 * page to STAY frozen after this function returns needs a session to
 * stay open, and this function's own session is what stays open.
 *
 * THIS DOES NOT COMPOUND INTO THE LEAK THE NIT NAMES for the other two
 * helpers: `page.context().newCDPSession(page)` mints a genuinely NEW
 * session object on every call (verified in the same spike session:
 * two calls on one page are `===`-distinct) rather than handing back a
 * shared one, so calling this twice on one page (freeze, then thaw)
 * leaves two sessions attached — bounded by how many times a SCENARIO
 * calls this, not by how many times anything polls, which is the shape
 * that made `listSharedWorkers`/`killSharedWorker` worth fixing. The
 * harness's own browser teardown (`browser.close()`) reclaims whatever
 * is left regardless.
 *
 * THE HAZARD, spelled out because it will bite the first caller who
 * doesn't read this far: a FROZEN page stops its own timers (and, per
 * Chromium's freeze semantics, its own script execution generally), so
 * `page.evaluate`/`page.waitForFunction` AGAINST THAT SAME PAGE can
 * stall indefinitely once frozen — there is nothing left running in it
 * to answer the probe. A caller that needs to observe a frozen page's
 * state must do it through ANOTHER page (a second device's view of the
 * same account, a SharedWorker another tab can still reach) or must
 * thaw it (`setWebLifecycleState(page, "active")`) before evaluating
 * against it again. */
export async function setWebLifecycleState(
  page: Page,
  state: "frozen" | "active",
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setWebLifecycleState", { state });
  // NO detach() here — see the file banner above for why leaving it
  // attached is load-bearing rather than an oversight.
}
