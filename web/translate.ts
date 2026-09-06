// Build-time translation CLI. The site never ships the translator
// (~0.5 MB gzip) — each component is translated once here, producing an
// envelope that `artifactsFromEnvelope` (web/mount.ts's `source`)
// reconstitutes at load time.
//
// THE TRANSLATOR ASSET. polyengine is consumed at a git revision, not a
// registry release (deno.json's import map; docs/design.md "Pins, with
// reasons"), and its translator wasm is not a source file: the packaged
// `defaultTranslator()` only knows how to load it from a file: URL. So
// this fetches `polyengine-translator-shim.wasm` from the `pre-<sha>`
// GitHub release polyengine cuts for every green main commit, verifies it
// against that release's SHA256SUMS, and caches it under target/. The
// revision here and the import map's must agree — the runtime refuses an
// envelope from another plan format version.
//
// Usage:
//   deno run -A web/translate.ts <component.wasm> [-o <out.plan.json>]

import { Translator } from "@polyengine/runtime/shim";

/** The polyengine git revision this tree consumes (docs/design.md "Pins,
 * with reasons"). The other place it is written is `deno.json`'s import
 * map, which spells the same sha in every `@polyengine/*` URL; bump both
 * together. */
const POLYENGINE_REV = "80ee6cb8a3471c4e136b0b061b4f8f75fef85c8b";

function usage(): never {
  console.error("usage: translate <component.wasm> [-o <out.plan.json>]");
  Deno.exit(2);
}

let input: string | undefined;
let output: string | undefined;

const args = [...Deno.args];
while (args.length) {
  const a = args.shift()!;
  if (a === "-o") output = args.shift() ?? usage();
  else if (a.startsWith("-")) usage();
  else if (input === undefined) input = a;
  else usage();
}
if (input === undefined) usage();
output ??= input.replace(/\.wasm$/, "") + ".plan.json";

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function translatorShim(): Promise<Uint8Array> {
  const short = POLYENGINE_REV.slice(0, 7);
  const root = new URL("../", import.meta.url);
  const cache = new URL(`target/polyengine-translator-shim-${short}.wasm`, root);
  try {
    return await Deno.readFile(cache);
  } catch {
    // not cached
  }
  const release =
    `https://github.com/polymorph-components/polyengine/releases/download/pre-${short}/`;
  const [sums, wasm] = await Promise.all([
    fetch(release + "SHA256SUMS").then((r) => {
      if (!r.ok) throw new Error(`SHA256SUMS: ${r.status} (is pre-${short} published?)`);
      return r.text();
    }),
    fetch(release + "polyengine-translator-shim.wasm").then((r) => {
      if (!r.ok) throw new Error(`translator shim: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  const want = sums.split("\n").find((l) => l.endsWith("polyengine-translator-shim.wasm"))
    ?.split(/\s+/)[0];
  const got = hex(await crypto.subtle.digest("SHA-256", wasm));
  if (want === undefined || want !== got) {
    throw new Error(`translator shim digest mismatch: want ${want}, got ${got}`);
  }
  await Deno.mkdir(new URL("target/", root), { recursive: true });
  await Deno.writeFile(cache, new Uint8Array(wasm));
  return new Uint8Array(wasm);
}

const componentBytes = await Deno.readFile(input);
const translator = await Translator.create(await translatorShim());

const t0 = performance.now();
const envelope = translator.translateRaw(componentBytes);
const ms = (performance.now() - t0).toFixed(1);

await Deno.writeTextFile(output, envelope);
console.log(
  `${output}: ${envelope.length} bytes envelope from ` +
    `${componentBytes.length} bytes component in ${ms}ms`,
);
