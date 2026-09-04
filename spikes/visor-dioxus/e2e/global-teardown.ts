// Playwright global teardown: kill the e2e/server.ts process started by
// global-setup.ts.
//
// Kill-by-PID discipline (dispatch mandatory rule): verify
// /proc/<pid>/cwd resolves inside this worktree before sending a signal —
// never kill by a port/pattern match, since the port may by now belong to
// an entirely different process (this repo's own conventions doc:
// ~/.config/opencode/AGENTS.md "Ad-hoc dev servers").

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import type { E2EServerState } from "./global-setup.ts";

export default async function globalTeardown(): Promise<void> {
  const stateFile = process.env.E2E_SERVER_STATE_FILE;
  if (!stateFile || !existsSync(stateFile)) return;

  const state = JSON.parse(readFileSync(stateFile, "utf8")) as E2EServerState;

  const cwdLink = `/proc/${state.pid}/cwd`;
  if (!existsSync(cwdLink)) return; // already gone

  let actualCwd: string;
  try {
    actualCwd = readlinkSync(cwdLink);
  } catch {
    return; // process exited between the existsSync check and readlink
  }

  if (actualCwd !== state.expectedCwd) {
    console.warn(
      `e2e global-teardown: refusing to kill pid ${state.pid} — cwd is ${actualCwd}, expected ${state.expectedCwd} (not our server)`,
    );
    return;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already exited
  }
}
