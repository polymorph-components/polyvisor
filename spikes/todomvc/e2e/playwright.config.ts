// Playwright config for the TodoMVC spike's real-browser E2E lane. Chromium
// only. Setup, from a fresh checkout:
//   cd e2e && npm install && npx playwright install chromium
//
// The spike had NO automated gate before this lane; these are its two.
//
//   tests/harness.spec.ts      — wraps the existing differential harness
//                                (web/harness.html), turning a manual check
//                                into a gate. This is what proves the runtime
//                                bump did not break the three surface guests.
//   tests/dioxus-frame.spec.ts — the re-targeted dioxus guest on its default
//                                (frame) backend, driven through real
//                                interaction inside the sandboxed frame.
//
// Server: global-setup.ts spawns e2e/server.ts (a Deno static file server)
// bound to port 0 and exposes the resolved port via process.env.E2E_BASE_URL;
// global-teardown.ts kills it by PID with a /proc/<pid>/cwd check. Playwright's
// built-in `webServer` is not used because it has no first-class "parse the
// real port out of stdout" support.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // baseURL is deliberately NOT set: globalSetup resolves the server's
  // ephemeral port, but this config object is evaluated BEFORE globalSetup
  // runs, so a `use.baseURL` read here would freeze on `undefined`. Tests read
  // process.env.E2E_BASE_URL directly.
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
