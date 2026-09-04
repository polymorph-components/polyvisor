// Playwright global setup: starts e2e/server.ts (a Deno static file
// server) bound to port 0, parses the real port from its own stdout, and
// exposes it to tests via process.env.E2E_BASE_URL.
//
// Port/PID discipline (dispatch mandatory rules):
//   - bind port 0, parse the real port from the server's own output —
//     never hard-code a port (parallel worktrees collide silently).
//   - kill by PID with a /proc/<pid>/cwd check inside THIS worktree in
//     global-teardown.ts, never by port-pattern pkill.
//
// State (pid + expected cwd) is handed to teardown via a temp JSON file
// rather than process.env, since Playwright's global teardown runs in a
// fresh Node invocation in some configurations and env alone isn't
// guaranteed to survive that boundary.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverScript = join(repoRoot, "e2e", "server.ts");

export interface E2EServerState {
  pid: number;
  expectedCwd: string;
  baseUrl: string;
  stateFile: string;
}

const STATE_ENV_VAR = "E2E_SERVER_STATE_FILE";

export default async function globalSetup(): Promise<void> {
  const child = spawn("deno", ["run", "--allow-net", "--allow-read", serverScript], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/^LISTENING (\d+)$/m);
      if (m) {
        child.stdout?.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`e2e/server.ts exited early with code ${code}`)));
    setTimeout(() => reject(new Error("timed out waiting for e2e/server.ts to report its port")), 15_000);
  });

  const stateDir = mkdtempSync(join(tmpdir(), "visor-spike-e2e-"));
  const stateFile = join(stateDir, "server-state.json");
  const state: E2EServerState = {
    pid: child.pid!,
    expectedCwd: repoRoot,
    baseUrl: `http://localhost:${port}`,
    stateFile,
  };
  writeFileSync(stateFile, JSON.stringify(state));

  process.env.E2E_BASE_URL = state.baseUrl;
  process.env[STATE_ENV_VAR] = stateFile;
  // Detach from this process's stdio lifecycle but keep the reference for
  // teardown's kill-by-PID step (teardown reads the pid back from
  // stateFile, not from this in-memory handle, in case Playwright forks a
  // separate process for teardown).
  child.unref();
}

export { STATE_ENV_VAR };
