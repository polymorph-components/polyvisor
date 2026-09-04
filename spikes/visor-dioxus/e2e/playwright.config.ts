// Playwright config for the visor-spike real-browser E2E lane
// (owned by e2e/ + harness/). Chromium only.
//
// Setup: from a fresh checkout, install the browser once:
//   npx playwright install chromium --with-deps
// (documented here rather than in a separate README per dispatch.)
//
// Server: global-setup.ts spawns e2e/server.ts (a Deno static file
// server) bound to port 0 and exposes the resolved port via
// process.env.E2E_BASE_URL; global-teardown.ts kills it by PID with a
// cwd check (see that file's header). We do NOT use Playwright's built-in
// `webServer` option because it has no first-class "parse the real port
// out of stdout" support — global-setup/-teardown gives us that plus the
// mandatory kill-by-PID-with-cwd-check discipline directly.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // NOTE: baseURL is deliberately NOT set here — globalSetup resolves the
  // server's ephemeral port (bind port 0) and writes it to
  // process.env.E2E_BASE_URL, but this config object is evaluated before
  // globalSetup runs, so a `use.baseURL` read here would freeze on
  // `undefined`. Tests read `process.env.E2E_BASE_URL` directly instead
  // (see tests/spike.spec.ts).
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
