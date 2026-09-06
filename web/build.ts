// Build the site: `web/dist/` is exactly what a home origin serves.
//
// Three components, three realms (internal.wit "Realms"), and each is
// shipped the same way: the component bytes plus the polyengine translation
// envelope `web/translate.ts` produced for it, so no realm ever loads the
// translator. The app bundle additionally follows the layout the kernel
// fetches, documented in runtime/crates/kernel/src/apps.rs ("Bundle
// layout"): `/apps/index.json`, `/apps/{id}/manifest.json`, and every path
// the manifest names relative to `/apps/{id}/`.
//
// A missing artifact is an error, never an empty file: a site that boots
// into a blank page because a component silently was not there is worse
// than one that failed to build.

import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = join(ROOT, "web", "dist");
const WASM_DIR = join(ROOT, "target", "wasm32-wasip2", "release");

function fail(message: string): never {
  console.error(`build: ${message}`);
  Deno.exit(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) fail(`${cmd.join(" ")} exited ${code}`);
}

/** Bundle one entry point into `dist/<name>.js`.
 *
 * `frame.js` is inlined verbatim into the srcdoc web/boot.ts builds and
 * hashed for that frame's CSP, so it must be a single self-contained script
 * with nothing left to fetch — which is what a no-code-splitting bundle is.
 */
async function bundle(entry: string, out: string): Promise<void> {
  await run([
    Deno.execPath(),
    "bundle",
    "--allow-import",
    "--platform",
    "browser",
    "-o",
    join(DIST, out),
    join(ROOT, "web", entry),
  ]);
}

/** Component bytes + translation envelope, under `dest` in dist. */
async function component(cargoName: string, dest: string): Promise<void> {
  const wasm = join(WASM_DIR, `${cargoName}.wasm`);
  if (!await exists(wasm)) {
    fail(
      `${wasm} is missing — run \`cargo build --workspace ` +
        `--target wasm32-wasip2 --release\` first`,
    );
  }
  await ensureDir(dirname(join(DIST, dest)));
  await copy(wasm, join(DIST, `${dest}.wasm`), { overwrite: true });
  const plan = join(DIST, `${dest}.plan.json`);
  await run([
    Deno.execPath(),
    "run",
    "-A",
    join(ROOT, "web", "translate.ts"),
    join(DIST, `${dest}.wasm`),
    "-o",
    plan,
  ]);
  // The translator reports a refusal INSIDE the envelope and still exits 0.
  // Shipping that envelope produces a site that boots to a blank page and
  // explains itself only in a console, which is the failure this build is
  // supposed to make impossible.
  const envelope = JSON.parse(await Deno.readTextFile(plan));
  if (typeof envelope.error === "string") {
    fail(
      `${cargoName}: the translator refused the component: ${envelope.error}`,
    );
  }
}

interface Manifest {
  id: string;
  title: string;
  component: string;
  plan: string;
  assets: { handle: string; path: string; media_type: string }[];
}

/** One app bundle, per apps.rs "Bundle layout". */
async function app(id: string): Promise<void> {
  const src = join(ROOT, "apps", id);
  const manifestPath = join(src, "manifest.json");
  if (!await exists(manifestPath)) fail(`${manifestPath} is missing`);
  const manifest: Manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  const dest = join(DIST, "apps", id);
  await ensureDir(dest);

  // `component`/`plan` are what the kernel will fetch; the manifest names
  // them, so the bundler must put them exactly there rather than at a name
  // of its own choosing.
  const stem = manifest.component.replace(/\.wasm$/, "");
  if (manifest.plan !== `${stem}.plan.json`) {
    fail(
      `${id}: manifest 'plan' (${manifest.plan}) must be ` +
        `'${stem}.plan.json' — web/translate.ts names it off the component`,
    );
  }
  await component(`polyvisor_${id}`, join("apps", id, stem));

  for (const asset of manifest.assets) {
    const from = join(src, "assets", asset.path);
    if (!await exists(from)) fail(`${id}: asset ${from} is missing`);
    await copy(from, join(dest, asset.path), { overwrite: true });
  }
  await copy(manifestPath, join(dest, "manifest.json"), { overwrite: true });
}

const APPS = ["todomvc"];

// A rebuild is a fresh tree: a stale artifact left behind by a build that
// dropped a component is exactly the silent-blank-page failure above.
await Deno.remove(DIST, { recursive: true }).catch(() => {});
await ensureDir(DIST);

await bundle("boot.ts", "boot.js");
await bundle("worker.ts", "worker.js");
await bundle("frame.ts", "frame.js");
await copy(join(ROOT, "web", "index.html"), join(DIST, "index.html"));

await component("polyvisor_runtime", "runtime.component");
await component("polyvisor_visor", "visor.component");
for (const id of APPS) await app(id);
await Deno.writeTextFile(
  join(DIST, "apps", "index.json"),
  JSON.stringify(APPS) + "\n",
);

console.log(`build: web/dist ready (${APPS.length} app(s))`);
