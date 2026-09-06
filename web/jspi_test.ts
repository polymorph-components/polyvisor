// No JSPI, pinned at the source level (docs/design.md "No JSPI").
//
// Every realm-crossing import in this repository is an `async func` that
// suspends through the component model's async ABI, so no realm needs
// JSPI — and `instantiate(..., { jspi: false })` makes polyengine refuse
// loudly if a sync-typed import ever returns a Promise. That guarantee is
// only as good as the option being passed at EVERY call site, and an
// omission is invisible at runtime: it just silently permits the
// suspending path. So the glue's own text is the gate — every
// `instantiate(` call in web/ must carry `jspi: false` inside it.

import { assert } from "@std/assert";

const SOURCES = ["boot.ts", "frame.ts", "worker.ts", "mount.ts"];

/** Index just past the `)` closing the parenthesis opened at `open`. */
function balanced(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced parentheses");
}

Deno.test("every instantiate() in the glue passes jspi: false", async () => {
  let sites = 0;
  for (const name of SOURCES) {
    const text = await Deno.readTextFile(new URL(name, import.meta.url));
    for (let i = text.indexOf("instantiate("); i >= 0;) {
      const line = text.slice(text.lastIndexOf("\n", i) + 1, i).trimStart();
      // Prose naming the function is not a call site.
      if (!line.startsWith("//") && !line.startsWith("*")) {
        sites++;
        const call = text.slice(i, balanced(text, i + "instantiate".length));
        assert(
          /jspi:\s*false/.test(call),
          `${name}: an instantiate( call without jspi: false:\n${call}`,
        );
      }
      i = text.indexOf("instantiate(", i + 1);
    }
  }
  // The worker instantiates the runtime; mount.ts instantiates both
  // producers (visor and app). A drop to zero would make this vacuous.
  assert(sites >= 2, `expected instantiate call sites, found ${sites}`);
});
