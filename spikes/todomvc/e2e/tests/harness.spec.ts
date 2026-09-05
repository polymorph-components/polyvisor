// GATE D1: the differential harness, as a gate.
//
// web/harness.html + host/harness.ts already ARE a differential harness: the
// same guests run the same scripts over the three same-realm surface backends
// (direct / queued / channel), with full-DOM serialization compared stepwise
// and 8 trap-vector probe cases from the violation guest (lab/) compared for
// equality, including the flush-on-trap rule. What it lacked was anybody
// automatically looking at the answer — it rendered PASS/FAIL into a page a
// human had to open.
//
// This test is that missing half, and nothing more: load the page, wait for
// the harness to publish its verdict, assert it. The assertions are on
// `__harnessResult` (the structured verdict host/harness.ts sets) AND on the
// rendered heading, because "renders PASS/FAIL into the page" is part of what
// the harness is for.
//
// WHY THIS IS THE RUNTIME-BUMP GATE. The spike moved off
// `jsr:@deltic/runtime@0.1.0-pre.gc4043e6` onto the sibling's pinned
// `.deps/polyengine` checkout, because the dioxus guest's mutation stream
// needs component-model-async. The hand-written, Preact and lab components
// were all built against the OLD runtime and are not rebuilt by that move —
// so "do they still instantiate and behave identically?" is a real question
// with a real way to be wrong. This harness answers it across three backends
// and 15 scripted steps at once.
//
// `frame` is deliberately absent from the harness (and so from this test):
// comparing backends means reading their DOM, and a sandboxed frame's document
// is on an opaque origin — unreachable from this realm by construction. The
// frame path's correctness is gate D2's job.

import { expect, test } from "@playwright/test";

const baseUrl = () => {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup did not run");
  return url;
};

interface HarnessResult {
  pass: boolean;
  failures: string[];
  traps?: string[];
}

test("backend equivalence harness reports PASS on every comparison", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${baseUrl()}/harness.html`);

  // The harness instantiates three components and drives 15 steps plus 8
  // probes through each; it publishes `__harnessResult` when done — including
  // on the crash path, so this wait distinguishes "still running" from
  // "failed" rather than timing out on both.
  await page.waitForFunction(
    () => (globalThis as Record<string, unknown>).__harnessResult !== undefined,
    undefined,
    { timeout: 60_000 },
  );

  const result = await page.evaluate(
    () => (globalThis as Record<string, unknown>).__harnessResult as HarnessResult,
  );

  // Report the failures in the assertion itself: a bare `expect(pass).toBe(
  // true)` would say "expected true, got false" about a 15-step differential
  // and leave the diff in a browser nobody kept.
  expect(result.failures, `harness failures:\n${result.failures.join("\n\n")}`)
    .toEqual([]);
  expect(result.pass).toBe(true);

  // The rendered verdict, which is the harness's own product.
  await expect(page.locator("#out h2")).toHaveText("HARNESS: PASS");

  // Probe 0 is the legal case; 1..7 are deliberate surface violations. A
  // runtime that stopped trapping would still pass the equality checks above
  // (all three backends would agree on "ok"), so the trap vector is asserted
  // separately — this is the assertion that a runtime bump cannot quietly
  // disarm the validator.
  expect(result.traps?.[0]).toBe("ok");
  expect(result.traps?.slice(1).every((t) => t !== "ok")).toBe(true);

  expect(consoleErrors).toEqual([]);
});
