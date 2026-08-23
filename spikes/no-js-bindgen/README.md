# no-js-bindgen

Tooling for running wasm-bindgen-contaminated Rust crate graphs as pure
WebAssembly components, with "the JS boundary is never reached" enforced as
a runtime trap instead of assumed. Incubating here per the placement ruling
on [#13](https://github.com/polymorph-components/polyvisor/issues/13#issuecomment-5310732507);
graduates to a standalone repo once proven (its audience is any Rust
component author, not just polymorph).

## The problem

"wasm32 implies browser" is the Rust ecosystem's big lie: crates link
js-sys/wasm-bindgen/web-sys on *all* wasm32 targets for functionality that
a component build never reaches (hot reload, telemetry, browser fast
paths). The module then carries `__wbindgen_placeholder__` /
`__wbindgen_externref_xform__` function imports plus ~thousands of describe
exports and custom sections that only the wasm-bindgen CLI consumes — and
`wasm-tools component new` rightly rejects it. First hit in this repo:
dioxus-core's mandatory `subsecond` dependency (see the todomvc spike).

## severer/ — composition-time trapping stub

`wbg-sever <in.wasm> <out.wasm>` post-processes the core module with walrus:

1. Every **function import** from a JS-boundary module (`__wbindgen*`,
   `./snippets/*`) is replaced in place by a local function of identical
   type whose body is `unreachable`. Call sites keep their indices; the
   shim name (which encodes the JS API, e.g.
   `__wbg_setAttribute_…`) is preserved in the name section, so a trap
   identifies exactly which API was reached.
2. `__wbindgen_describe*` exports and wasm-bindgen custom sections are
   stripped; walrus GC then drops the dead describe bodies.
3. Non-function JS-boundary imports (tables/globals) are an error — that
   graph genuinely needs JS glue semantics, and severing would be unsound.

Result on the todomvc dioxus guest: 4 imports severed, 1930 describe
exports stripped, componentizes clean, artifact *smaller* than with the
hand-written per-crate stub it replaced.

Key facts that make this sound:

- Describe exports are only ever *executed by the wasm-bindgen CLI* at
  post-processing time; no runtime path calls them. Strip freely.
- Pre-CLI, the externref-xform imports are plain functions (the table
  machinery is added later by the CLI, which never runs here).
- A trap has component-model semantics: instance dead, host notified —
  the same failure shape as a surface-validation violation.

## Stub grades (per the #13 ruling)

1. **Trapping** (default, this tool): "never reached" becomes a
   runtime-enforced invariant and an empirical reachability probe —
   linkage ≠ reachability, and `cargo tree` can't tell you which APIs fire.
2. **No-op / inert-correct** (source-level, per item, justification
   recorded): for APIs that *are* reached but are semantically inert in
   release builds. The todomvc spike's vendored subsecond stub was this
   grade — deleted once severing proved sufficient (subsecond's reached
   paths are pure Rust; its JS usage sits in the hot-patch path).
3. **Capability-routed** (not a stub): time/randomness/logging should be
   WIT imports (`getrandom` custom backend, `web-time` replacement) — the
   honest version of the dependency. SDK scope.

## What this does not do

Web-sys-welded *render paths* (leptos/sycamore) trap on the first frame:
loudly dead instead of silently broken, but not support. Framework
integration happens at real renderer seams (see the todomvc spike's dioxus
guest). If richer trap diagnostics or partial-linking ever justify it, the
fallback design is a wasm-bindgen macro fork that emits trapping Rust
bodies at expansion time — strictly more invasive, kept on the shelf.

## CI-gate pattern

- Pure guests: `cargo tree --target wasm32-unknown-unknown -i wasm-bindgen`
  must be empty.
- Framework guests: build → `wbg-sever` → `component new`, and the
  behavior suite is the reachability tripwire when a dependency upgrade
  starts touching JS somewhere new.
