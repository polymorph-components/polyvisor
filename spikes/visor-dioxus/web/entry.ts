/// <reference lib="dom" />
// Browser entry for the spike harness: fetch the component plus its
// build-time translation envelope, mount it, and park the handle on
// `window` for the Playwright test.
//
// Bundled by `deno bundle --platform browser` into web/dist/entry.js (same
// mechanism as ../../../polyengine-dioxus/harness/build.ts).

import { artifactsFromEnvelope } from "@deltic/runtime/embedder";
import { mountVisor } from "../host/mount.ts";
import type { MountedVisor } from "../host/mount.ts";

interface Stamp {
  componentSha256: string;
  builtAt: string;
}

declare global {
  interface Window {
    __visor?: MountedVisor;
    __mounted?: boolean;
    __mountFailed?: string;
    __e2eErrors: string[];
    __buildStamp?: Stamp;
  }
}

const errors: string[] = [];
(globalThis as unknown as Window).__e2eErrors = errors;
globalThis.addEventListener("error", (ev) => errors.push(String(ev.error ?? ev.message)));
globalThis.addEventListener(
  "unhandledrejection",
  (ev) => errors.push(String((ev as PromiseRejectionEvent).reason)),
);

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("web/index.html must have <div id=app>");

  // Build-identity probe: the stamp carries the sha-256 the build step
  // computed over visor-spike.component.wasm, and the test re-hashes the
  // served bytes against it. Verifying the SERVED BUILD, not merely that a
  // server answered, is mandatory — a sibling worktree's server on a
  // colliding port would otherwise pass every other assertion.
  const stampRes = await fetch(new URL("./build-stamp.json", import.meta.url));
  if (stampRes.ok) (globalThis as unknown as Window).__buildStamp = await stampRes.json();

  const [res, planRes] = await Promise.all([
    fetch("./visor-spike.component.wasm"),
    fetch("./visor-spike.plan.json"),
  ]);
  if (!res.ok) throw new Error(`component fetch failed: ${res.status}`);
  if (!planRes.ok) throw new Error(`envelope fetch failed: ${planRes.status} — run \`just build\``);

  const source = artifactsFromEnvelope(
    await planRes.text(),
    new Uint8Array(await res.arrayBuffer()),
  );

  const visor = await mountVisor({
    source,
    root,
    onError: (err) => errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  });
  (globalThis as unknown as Window).__visor = visor;

  // KNOWN BROKEN, FIXED: the component renders `#visor-zone` (app.rs),
  // not `#visor-spike` — the skeleton's placeholder id.
  await waitFor(() => root.querySelector("#visor-zone") !== null);
  (globalThis as unknown as Window).__mounted = true;
  const status = document.getElementById("status");
  if (status) status.textContent = "mounted";
}

function waitFor(cond: () => boolean, maxIters = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = () => {
      if (cond()) return resolve();
      if (++i >= maxIters) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 0);
    };
    tick();
  });
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  errors.push(detail);
  (globalThis as unknown as Window).__mountFailed = detail;
  const status = document.getElementById("status");
  if (status) status.textContent = `error: ${detail}`;
});
