// Bundle web/entry.ts into web/dist/entry.js and write the build stamp.
//
// The stamp is the sha-256 of build/visor-spike.component.wasm: the E2E
// test re-hashes the bytes the SERVER actually returned and compares, which
// is what makes "the served build is this build" a checked fact rather than
// an assumption.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { encodeHex } from "jsr:@std/encoding@1/hex";

const root = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const webDir = join(root, "web");
const distDir = join(webDir, "dist");
const component = join(root, "build", "visor-spike.component.wasm");

await Deno.mkdir(distDir, { recursive: true });

const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform",
    "browser",
    "--format",
    "esm",
    "-o",
    join(distDir, "entry.js"),
    join(webDir, "entry.ts"),
  ],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await bundle.output();
if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);

const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(component));
await Deno.writeTextFile(
  join(distDir, "build-stamp.json"),
  JSON.stringify(
    { componentSha256: encodeHex(new Uint8Array(digest)), builtAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log("web bundle built at", distDir);
