// Materialize the iroh endpoint component under `target/`, for `just
// compose` to plug into the runtime.
//
// The runtime imports `polymorph:iroh/{endpoint,identity-from-keys}`
// (internal.wit `world runtime`) and nothing in this repository implements
// them: the implementation is polymorph-iroh's own component, composed in at
// build time with `wac plug`. So the bytes have to be on disk before `wac`
// runs, and they are not in the repository — a two-megabyte binary is a
// dependency, not a source file.
//
// The bytes come from the jsr package's PUBLIC surface. `loadArtifacts()`
// hands back the packaged build's `componentBytes`; the package's own
// `endpointComponentBytes()` lives in a module the package does not export
// (`src/endpoint_component.ts`), so reaching it means deep-linking past the
// export map — an undeclared path that can move in any patch release. The
// cost of the public path is that `loadArtifacts` also translates the
// component, which is wasted work here. It is build-time work, once.
//
// Idempotent and cached: a materialized file of the pinned version is left
// alone, so `just compose` in a loop does not decode two megabytes each
// time.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";

import { loadArtifacts } from "@polymorph/iroh";

// The pin is `import.meta.resolve`, not a literal here: deno.json maps
// `@polymorph/iroh` to a jsr semver range, and `deno.lock` is what actually
// resolves it to a concrete version each install. Resolving the specifier
// yields `https://jsr.io/@polymorph/iroh/<version>/...`; parsing <version>
// out of that URL means the cache filename always names the version deno.lock
// actually picked, so a lockfile bump cannot silently reuse a stale artifact.
// `wac plug` (justfile `compose`) can't name a versioned path without
// re-deriving the version itself, so after fetching we also copy to a
// version-free stable path (`iroh_endpoint.wasm`) that's the one the
// justfile plugs.
const resolved = import.meta.resolve("@polymorph/iroh");
const match = resolved.match(/^https:\/\/jsr\.io\/@polymorph\/iroh\/([^/]+)\//);
if (!match) {
  throw new Error(
    `fetch-endpoint: could not parse a version out of resolved specifier ${resolved}`,
  );
}
const VERSION = match[1];

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, "target", `iroh_endpoint-${VERSION}.wasm`);
const STABLE = join(ROOT, "target", `iroh_endpoint.wasm`);

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

if (await exists(OUT)) {
  console.log(`fetch-endpoint: ${OUT} is already there`);
} else {
  const { componentBytes } = await loadArtifacts();
  await ensureDir(join(ROOT, "target"));
  await Deno.writeFile(OUT, componentBytes);
  console.log(`fetch-endpoint: wrote ${OUT} (${componentBytes.length} bytes)`);
}
await Deno.copyFile(OUT, STABLE);
