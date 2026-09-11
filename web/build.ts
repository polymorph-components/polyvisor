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
//
// The site also carries `config.json` — the home origin's one piece of
// deployment configuration, the iroh relay its devices bind through
// (`lifecycle.boot-config.relay`). boot.ts fetches it before the hello.

import { copy, ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = join(ROOT, "web", "dist");
const WASM_DIR = join(ROOT, "target", "wasm32-wasip2", "release");

/** What the worker actually instantiates: the runtime with polymorph-iroh's
 * endpoint component plugged in (justfile `compose`). The cargo artifact on
 * its own has unimplemented `polymorph:iroh` imports, so shipping it would
 * be a site whose worker cannot instantiate. */
const COMPOSED_RUNTIME = join(
  ROOT,
  "target",
  "polyvisor_runtime.composed.wasm",
);

/** The iroh relay a device binds its endpoint through, as the home origin
 * publishes it (`dist/config.json`; `lifecycle.boot-config.relay`). It is
 * live and untrusted — it carries ciphertext and endpoint ids — so a public
 * one is the honest default; n0's `use1-1` is what polymorph-iroh's own
 * production interop script dials (scripts/interop-prod.sh). The e2e
 * harness overwrites this file with its own local relay. */
const DEFAULT_RELAY = "https://use1-1.relay.n0.iroh.link";

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
  // No `--external` here on purpose: the one npm fallback these bundles
  // would otherwise drag in (`@polymorph/webrtc-datachannels`' Deno/Node
  // `RTCPeerConnection` polyfill) is aliased away in deno.json — see
  // web/platform/no-node-datachannel.ts for why an external left a bare
  // `npm:` specifier that stalled the SharedWorker.
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

/** Component bytes + translation envelope, under `dest` in dist.
 *
 * `source` overrides where the bytes come from; it exists for the runtime,
 * which ships as the `wac plug` composition of the cargo artifact with
 * polymorph-iroh's endpoint component rather than as the cargo artifact
 * itself (justfile `compose`). */
async function component(
  cargoName: string,
  dest: string,
  source?: string,
): Promise<void> {
  const wasm = source ?? join(WASM_DIR, `${cargoName}.wasm`);
  if (!await exists(wasm)) {
    fail(
      source === undefined
        ? `${wasm} is missing — run \`cargo build --workspace ` +
          `--target wasm32-wasip2 --release\` first`
        : `${wasm} is missing — run \`just compose\` first`,
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

/** Test-only bundles, built by `deno task build:fixtures` (`--fixtures`) and
 * by nothing else. `apps/hostile` exists to be refused by the frame policy,
 * so it must never reach a home origin a user visits; the production Pages
 * build runs the flagless task. */
const FIXTURES = ["hostile"];

const apps = Deno.args.includes("--fixtures") ? [...APPS, ...FIXTURES] : APPS;

// A rebuild is a fresh tree: a stale artifact left behind by a build that
// dropped a component is exactly the silent-blank-page failure above.
await Deno.remove(DIST, { recursive: true }).catch(() => {});
await ensureDir(DIST);

await bundle("boot.ts", "boot.js");
await bundle("worker.ts", "worker.js");
await bundle("frame.ts", "frame.js");
// The launcher-icon service worker (web/icon-sw.ts). It lands beside
// `index.html` rather than inside `launcher-icons/` because a worker's
// default scope is its own directory and it needs the page's base: a
// broader scope would need a `Service-Worker-Allowed` response header,
// which a GitHub Pages deployment cannot set. It derives every path it uses
// from `registration.scope`, so a project-site subpath needs nothing here.
await bundle("icon-sw.ts", "icon-sw.js");
await copy(join(ROOT, "web", "index.html"), join(DIST, "index.html"));
// The framework's own launcher icons, at real https: URLs: the fallback
// whenever an install has no saved glyph to paint or the icon worker does
// not come up (docs/design.md "Routing", the `launch/` bullet).
for (const icon of ["icon-512.png", "icon-192.png"]) {
  await copy(join(ROOT, "web", icon), join(DIST, icon), { overwrite: true });
}
// The visor's last-resort animal face. Keep this local: glyph rendering must
// not acquire a runtime network dependency.
await ensureDir(join(DIST, "fonts"));
for (const file of ["noto-emoji-animals.woff2", "OFL.txt", "README.md"]) {
  await copy(join(ROOT, "web", "fonts", file), join(DIST, "fonts", file), {
    overwrite: true,
  });
}

await component(
  "polyvisor_runtime",
  "runtime.component",
  COMPOSED_RUNTIME,
);
await component("polyvisor_visor", "visor.component");
for (const id of apps) await app(id);
await Deno.writeTextFile(
  join(DIST, "apps", "index.json"),
  JSON.stringify(apps) + "\n",
);
await Deno.writeTextFile(
  join(DIST, "config.json"),
  JSON.stringify({ relay: DEFAULT_RELAY }) + "\n",
);

console.log(`build: web/dist ready (${apps.length} app(s))`);
