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
// The worker is the one exception, and it is pinned just as hard in the
// other direction. The composed iroh endpoint authenticates QUIC with
// rustls, whose `Signer::sign` is synchronous, over an async webcrypto
// import; with `jspi: false` the accepting side of every connection stalls
// in `CertificateVerify`. So `worker.ts` must pass `jspi: true` — asserted
// explicitly, so that returning it to `false` (which is the plan, once the
// transport's signer is in-guest) is a deliberate edit of this test and not
// something that can drift in unnoticed either way.

import { assert, assertEquals } from "@std/assert";

/** Realms that must never suspend a wasm frame. `boot.ts` and `frame.ts`
 * reach the embedder through `mount.ts` today and have no `instantiate(` of
 * their own; they are scanned so that a direct call added later is caught
 * by this test rather than by nothing. */
const WITHOUT_JSPI = ["boot.ts", "frame.ts", "mount.ts"];

/** The realm that must have it, until the endpoint's signer is in-guest. */
const WITH_JSPI = "worker.ts";

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

Deno.test("the visor and frame realms instantiate with jspi: false", async () => {
  let sites = 0;
  for (const name of WITHOUT_JSPI) {
    for (const call of await callSites(name)) {
      sites++;
      assert(
        /jspi:\s*false/.test(call),
        `${name}: an instantiate( call without jspi: false:\n${call}`,
      );
    }
  }
  // `mount.ts` instantiates both producers (the visor and every app). A drop
  // to zero would make this vacuous.
  assert(sites >= 1, `expected instantiate call sites, found ${sites}`);
});

Deno.test("the worker realm instantiates with jspi: true, deliberately", async () => {
  const sites = await callSites(WITH_JSPI);
  // Exactly one: a second, unannotated instantiate in the worker would be a
  // realm this test says nothing about.
  assertEquals(
    sites.length,
    1,
    `${WITH_JSPI}: expected exactly one instantiate( call site`,
  );
  assert(
    /jspi:\s*true/.test(sites[0]),
    `${WITH_JSPI}: the worker is the documented JSPI exception (design.md ` +
      `"No JSPI") and must pass jspi: true until polymorph-iroh's TLS ` +
      `signer is in-guest. If that landed, this test is what you edit:\n` +
      sites[0],
  );
});
