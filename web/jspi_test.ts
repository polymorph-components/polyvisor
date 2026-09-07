// JSPI, pinned at the source level (docs/design.md "No JSPI").
//
// Every realm-crossing import in this repository is an `async func` that
// suspends through the component model's async ABI, so nothing polyvisor
// writes needs JSPI — and `instantiate(..., { jspi: false })` makes
// polyengine refuse loudly if a sync-typed import ever returns a Promise.
// That guarantee is only as good as the option being passed at every call
// site, and an omission is invisible at runtime: it just silently permits
// the suspending path. So the glue's own text is the gate.
//
// There is no exception. The worker was one through M3a, because the
// composed iroh endpoint authenticated QUIC with rustls over an async
// webcrypto sign import and the accepting side stalled in
// `CertificateVerify` without JSPI; polymorph-iroh's `identity-from-seed`
// signs in-guest and closed that hole.

import { assert } from "@std/assert";

/** Every realm's embedder. `boot.ts` and `frame.ts` reach theirs through
 * `mount.ts` today and have no `instantiate(` of their own; they are
 * scanned so that a direct call added later is caught by this test rather
 * than by nothing. */
const REALMS = ["boot.ts", "frame.ts", "mount.ts", "worker.ts"];

/** Index just past the `)` closing the parenthesis opened at `open`. */
function balanced(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced parentheses");
}

/** Every `instantiate(...)` call in `name`, prose mentions excluded. */
async function callSites(name: string): Promise<string[]> {
  const text = await Deno.readTextFile(new URL(name, import.meta.url));
  const sites: string[] = [];
  for (let i = text.indexOf("instantiate("); i >= 0;) {
    const line = text.slice(text.lastIndexOf("\n", i) + 1, i).trimStart();
    // Prose naming the function is not a call site.
    if (!line.startsWith("//") && !line.startsWith("*")) {
      sites.push(text.slice(i, balanced(text, i + "instantiate".length)));
    }
    i = text.indexOf("instantiate(", i + 1);
  }
  return sites;
}

Deno.test("every realm instantiates with jspi: false", async () => {
  let sites = 0;
  for (const name of REALMS) {
    for (const call of await callSites(name)) {
      sites++;
      assert(
        /jspi:\s*false/.test(call),
        `${name}: an instantiate( call without jspi: false:\n${call}`,
      );
    }
  }
  // `mount.ts` instantiates both producers (the visor and every app) and
  // `worker.ts` the runtime. A drop to zero would make this vacuous.
  assert(sites >= 2, `expected instantiate call sites, found ${sites}`);
});
