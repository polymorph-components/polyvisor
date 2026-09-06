// Dependency probe (docs/design.md "Contracts"): a deliberate import of the
// two external pieces glue code will need in M1, kept solely so `deno check`
// verifies the import map resolves them before any glue code exists.
import "@polymorph/stream-dom-receiver/mod.ts";
import "@polyengine/runtime/embedder";
