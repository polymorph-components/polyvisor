# TodoMVC surface spike

TodoMVC where the **entire application is a WebAssembly component** driving a
curated DOM surface — no app JS, no app HTML, no app CSS-with-URLs. The first
conversion-checkpoint artifact for [#16] (app execution model: no app JS),
under the shape rules of [#15], running on [deltic].

**Live demo (mobile-friendly):**
https://polymorph-components.github.io/polymorph-apps/spike-todomvc/

**Scope.** Validates the wasm→DOM plumbing only: the WIT surface, the
validated op protocol, and the event-record path. The worker/frame split,
permission linker, and asset pipeline are deliberately left as seams.
Quarantined, delete-at-will, wired into no CI. The built demo is committed
at `docs/spike-todomvc/` (the repo's Pages root).

[#16]: https://github.com/polymorph-components/polyvisor/issues/16
[#15]: https://github.com/polymorph-components/polyvisor/issues/15
[deltic]: https://github.com/polymorph-components/polyengine

## Architecture

```
guest (Rust → wasm component)            trusted host (JS)
┌──────────────────────────┐   WIT    ┌───────────────────────────┐
│ TodoMVC model + render   │ imports  │ surface: validate calls,  │
│ calls dom/events/shell   ├─────────>│ allocate handles, queue   │
│                          │          │ serializable ops          │
│ exports: run / on-event  │          └────────────┬──────────────┘
│          / on-route      │            op batches │ structuredClone
└────────────▲─────────────┘            (the seam) ▼
             │                        ┌───────────────────────────┐
             │  event records         │ applier: re-validate,     │
             └────────────────────────┤ id→Node map, addEventLis- │
                (token, kind,         │ tener → event records     │
                 key?/value?/checked?)│ ...applies to real DOM    │
                                      └───────────────────────────┘
```

- **`wit/todomvc.wit`** is the contract. `dom` is a WebIDL-mirror subset
  (#15 rules: `set-attribute` → `setAttribute`, get-x/set-x for IDL
  attributes, handles are resources). `events`/`shell` are framework-shaped:
  record events correlated by guest-chosen tokens (no callbacks), and the
  capability grant (`root()` hands the app its subtree; the shell owns
  routing).
- **The seam**: the surface front-end never touches the DOM; it emits plain
  op arrays which are `structuredClone`d into the applier on every batch.
  Moving the applier into a sandboxed UI frame (postMessage) or the guest
  into a worker changes *where* the two halves run, not the protocol —
  handles are allocated on the surface side, so every op is fire-and-forget
  and there is no synchronous read-back to block on across a future hop.
- **Batching**: one op batch per guest invocation (event in → ops out) —
  the "chunky protocol" posture from #15/#16.
- **Validation twice**: both halves import the same tables
  (`visor/surface/validate.ts`) and enforce independently — tag allowlist,
  per-(tag, attribute) checks, event-kind allowlist, and the one URL-typed
  attribute (`a[href]`) admitting fragment routes only. String HTML never
  crosses the boundary anywhere.

## Backends: the semantically-equivalent fast paths

Per the fast-path plan recorded on [#15], the surface front-end owns all
guest-facing validation and drives one of four **backends** implementing
the same ordering spec (written in `wit/todomvc.wit` on the `lab` world):
ops apply in call order; a flush boundary falls at the end of each export
invocation and at each guest suspension point; ops emitted before a trap
are applied; within a boundary, application is atomic w.r.t. paint.

| backend | what | role |
|---|---|---|
| `frame` | the queued protocol carried to a REAL sandboxed iframe on an opaque origin (`visor/frame/`) | **default** — the real worker/frame split (#16), no longer a placeholder |
| `direct` | validate → mutate the Node held as the resource rep; no ops, no clone, no id map | same-realm production path — the shape of a future native WebIDL binding |
| `queued` | serializable op batches + `structuredClone` + re-validating applier | debug/canary configuration; proves the seam every batch |
| `channel` | the queued protocol over a real `MessageChannel` (postMessage clones; events round-trip) | faithful stand-in for the worker/frame split, one realm |

The demo takes `?backend=` (default `frame`, as of the visor extraction's
Phase C).

**The equivalence harness** ([harness.html](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/harness.html))
makes "semantically equivalent" a checked property: the same guests run the
same scripts on every backend — 15 TodoMVC steps (synthetic event records
plus real DOM clicks) with full-DOM serialization compared stepwise
(attributes, input value/checked props, focus marker), and 8 probe cases
from a violation guest (`lab/`) compared as trap vectors, including the
flush-on-trap rule (a visible legal mutation before the violating call must
land on every backend). Status: **PASS**, 3 backends.

`frame` is deliberately EXCLUDED from the harness (and from `bench.ts`'s
churn sweep): both compare backends by reading the DOM directly, and a
sandboxed frame's document is on an opaque origin — unreachable from this
realm by construction (the whole point of `visor/frame/`). The frame
path's own correctness — that it really is unreachable, and that it
renders the same app — is covered by the demo spike's e2e suite
(`spikes/demo/e2e`'s `frameProbe` and boot scenarios), not by this
same-realm harness.

**The churn bench** ([bench.html](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/bench.html),
`?n=` rows; li+span per row ≈ 6 surface calls) — Chromium, aarch64 linux,
2026-08-16, n=5000 (30k surface calls in one invocation):

| backend | create 5000 (ms) | µs/call | update med (ms) | clear (ms) |
|---|---|---|---|---|
| direct | 31.7 | 1.06 | 1.0 | 1.1 |
| channel | 32.8 | 1.09 | 1.3 | 2.5 |
| queued | 46.8 | 1.56 | 1.5 | 2.7 |

Readings: the postMessage hop costs ~3% at batch sizes UI code never
reaches; the explicit-clone canary costs ~47% and stays a debug
configuration; a heavy real frame (hundreds of ops) is ~0.1 ms of
boundary+DOM cost on any backend. The #15 expectation holds — the glue tax
is a VDOM-op-rate problem, not a UI-rate problem, so the contract-level
accel option stays shelved and the bridge position is "delete scaffolding
when native bindings arrive".

## Three guests, one world

| guest | tech | size (raw / gz) | notes |
|---|---|---|---|
| `guest/` | hand-written Rust | 37 KB / 14 KB | baseline; naive rebuild |
| `guest-dioxus/` | dioxus 0.7 rsx (VDOM) | 352 KB / 130 KB | `?guest=dioxus`; JS boundary severed at build |
| `guest-preact/` | **unmodified Preact 10.27** in StarlingMonkey (componentize-js) | 12.7 MB / 4.1 MB | `?guest=preact`; JS-as-userland proof |

### The dioxus guest

`guest-dioxus/` implements the same WIT world with the app written in
[dioxus](https://dioxuslabs.com) 0.7 `rsx!` — a real framework's VDOM
diffing running in-guest, its patch stream applied through the surface
(demo: [`?guest=dioxus`](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/?guest=dioxus)).
The framework-support research and decision (2026-08-16):

- **Dioxus chosen.** `dioxus-core` is renderer-agnostic in practice, not
  just in theory: `WriteMutations` is a public seam (Blitz/dioxus-native
  ship on it), the crate graph is wasm-bindgen-free, and the VirtualDom
  drives synchronously (`handle_event` → `process_events` →
  `render_immediate`) — a perfect fit for a reactor guest. The glue is
  ~450 lines: a `WriteMutations` impl over surface imports (stack machine
  with guest-side shadow children for template paths, cribbed from
  dioxus-native-dom), an `HtmlEventConverter` mapping surface event
  records to dioxus event data, and listener tokens = dioxus `ElementId`s.
- **Leptos rejected for now.** tachys 0.2 (leptos 0.8) hardcodes
  `pub type Rndr = dom::Dom` — the 0.7-era generic renderer was
  monomorphized away for compile times, and the alternate renderers are
  commented out in the source. Supporting it means forking its view
  layer. Its standalone `reactive_graph` remains attractive for a future
  hand-rolled fine-grained renderer.
- **One dependency lie needed severing**: dioxus-core's mandatory
  `subsecond` (hot-patch runtime) links js-sys/wasm-bindgen on *all*
  wasm32 targets — "wasm32 implies browser" strikes again — which poisons
  componentization. Solved generically at composition time:
  [`../no-js-bindgen`](../no-js-bindgen)'s `wbg-sever` replaces every
  JS-boundary import with a trapping body and strips the describe
  machinery (4 imports severed, 1930 describe exports stripped here).
  A bespoke source-level subsecond stub predated it and was deleted once
  severing proved sufficient.
- **Surface additions the framework forced** (the exact prerequisite list
  predicted): `create-text-node` (mixed content like the
  `<strong>{n}</strong> items left` counter), and `before`/`after`
  (ChildNode mirrors) for positional insertion — all structural, all
  validator-checked, two new probe cases pin text-node restrictions.
- **Sizes**: dioxus component 366 KB raw / **130 KB gz** vs 37 KB / 14 KB
  hand-written — the framework tax, paid once per app.
- **Known gaps** (documented, not hidden): no `onmounted`/focus bridging
  (the edit field doesn't auto-focus in the dioxus guest — needs a
  mounted-data story over the surface), `preventDefault`/
  `stopPropagation` from handlers don't cross the record boundary
  (bubbling is delegated to the real DOM; dioxus is told `bubbles=false`),
  and only the six surface event families convert.

### The preact guest (JS as userland)

`guest-preact/` runs **unmodified Preact + htm** inside a StarlingMonkey
component (`jco componentize`, `--disable all`), proving the #16 claim
that JS is a userland choice: the interpreter ships inside the app's own
capability boundary. With all WASI features disabled the emitted world
imports **only the three surface interfaces** — a 12.7 MB component with
zero ambient authority, translated by deltic in ~200 ms.

The glue is `src/shim.js` (~230 lines, undom-inspired): a guest-side DOM
shim whose structure reads (`parentNode`/`childNodes`/`nextSibling`) are
answered from shadow bookkeeping, whose mutations write through to
surface handles, and whose input `value`/`checked` are mirrored from
event records *before* dispatch so `e.target.value` works with no host
reads. Findings:

- **Preact renders exclusively via `document.createElementNS`** (threading
  `parent.namespaceURI`) — a shim must supply both, not just
  `createElement`.
- **Event-name casing is capability-probed**: Preact lowercases `onKeyDown`
  only if `'onkeydown' in dom`, and keys its internal handler map with
  whatever survives — the shim declares the six `on*` properties so names
  normalize. Exactly the "framework probes the DOM's shape" behavior a
  shim must anticipate.
- **Deterministic edit focus works** (`useLayoutEffect` + ref →
  `focus()` op, synchronously inside the commit) — closing the gap the
  dioxus guest still has, and validating the surface's focus-as-explicit-op
  ruling from the framework side.
- **Debugging without stderr**: with stdio disabled, uncaught guest
  exceptions are opaque traps. The exports wrap handlers to smuggle
  `error.stack` out through a surface op (a `guest-error:` class value)
  before rethrowing — a pattern worth keeping until the framework has a
  real diagnostics channel. `tools/diag-preact.ts` drives any guest
  headlessly under Deno.
- **Preact's diff emits targeted ops** (`["text", id, "1"]` on the counter
  text node) — fine-grained updates, no rebuilds, straight through the
  seam.


## Framework visor: a consumer of the shared system-UI core (#22)

The visor's own UI — the strip, the identity cluster, the context
cluster, the drawer host with its tenancy, arming delay and height
budget, AND the two ceremonies that hang off the strip (the naming /
App-settings sheet and the "Your visor" settings sheet, with the trust
table behind them) — is not reimplemented here. `host/visor.ts` is a thin
CONSUMER of `visor/ui/visor.ts` plus `visor/ui/sheets.ts`, the same
shared modules the `spikes/demo` spike uses.

What stays in this spike's own `host/visor.ts` is this page's OWN storage
keys (`pm-todomvc-visor-hue`, `pm-todomvc-identity`,
`pm-todomvc-surface-marks` — no legacy migration key, unlike the demo's
#22 rename) and its one row in the trust table: one artifact, one record,
created UNMARKED at first sight like any other (the recognition mark is a
PET ICON the user picks in the ceremony — the colour chip is gone, see
the demo spike's README), and its petname SEEDED with this page's
historical word `"TodoMVC"` on first run. The NAME is seeded; the MARK is
not — inventing a glyph the user never chose would be the visor putting a
recognition mark on its own anchor, so the strip shows the word and no
glyph until the ceremony is opened. From there it is an ordinary petname — clicking
it on the strip opens the real naming ceremony, a rename persists in this
page's own marks table, and the identity button opens the real settings
sheet (name, device, glyph, anchor hue with live preview and revert).
Before this the strip drew a clickable petname with no handler behind it:
a dead affordance on the trust anchor, which is the worst place to have
one.

WHAT WAS REMOVED: the "consent demo" and "kill" strip buttons and their
two drawer tenants — a simulated permission prompt and a simulated app
teardown from the pre-shared-core spike. The drawer mechanics they existed
to demonstrate (arming, dimming, tenancy, the reveal above the strip) are
demonstrated by the shared sheets themselves now, against real state
rather than a mock. The strip's consumer-owned button slot went with them:
every control on the trust anchor is one more thing whose provenance a
user has to reason about, so adding one is a framework decision rather
than a slot a consumer fills. (`app.ts`'s `TodoApp.teardown` stays — it is
a framework-real capability; nothing about dropping a spike button argues
against having it.)

Style is deliberately shared-looking: position and absolute interaction
rules are the trust anchors, never CSS. Secret entry is out of scope for
drawers by rule (the visor never asks for typed secrets here; that
belongs to a dedicated identity surface — see #22, which also records
dropping the earlier personalization-secret experiment).

**Interaction-emergence experiment**: visor interactions are revealed by
the strip sliding down, exposing the interaction surface *above* it — the
prompt visibly grows out of the trusted pixel region (provenance), and the
slide doubles as an enforced **arming delay** (700 ms, `visor/ui/
visor.ts`'s `ARM_MS`): controls stay disabled until it elapses, defeating
baited mis-taps (an app training rapid taps where a visor control is
about to appear). The timer is the enforcement; the animation is its
visible form — `prefers-reduced-motion` removes the motion, never the
delay.

## What the artifact itself shows

`wasm-tools component wit build/todomvc.component.wasm` prints the world the
component actually imports — and it is *smaller* than the WIT: methods the
guest never calls (`remove-attribute`, `remove`) were pruned by the
toolchain. The #16 claim "the import list is the boundary, enumerable from
the artifact" is directly inspectable here: what this app can do to the
page is exactly what its binary imports.

## Findings (2026-08-16)

- **It works, everywhere the runtime does.** All imports are sync host
  functions: no JSPI, no COOP/COEP, no SharedArrayBuffer — nothing that
  excludes iOS WebKit. `Symbol.dispose` needs a polyfill on engines without
  explicit resource management (`host/polyfill.ts`, imported first).
- **Sizes** (gzip): runtime bundle 52 KB, component 14 KB, translation
  envelope 1.5 KB — ~68 KB transfer total. Translation happens at build
  time (`tools/translate.ts`); production ships no translator.
- **Interface import keys are versioned** (`polymorph:todomvc-spike/dom@0.0.1`)
  — the imports record must match the WIT id verbatim, version included.
- **Ordering semantics surface honestly**: `focus()` no-ops on elements not
  yet connected to the document, so the guest must focus *after* appending
  the subtree — found by test, fixed in the guest, and exactly the class of
  DOM semantics a worker-hop design has to keep explicit.
- **Handle lifecycle maps cleanly**: guest drops → `[Symbol.dispose]` →
  `free` op → applier table entry released, while DOM nodes live or die
  with the tree. Skeleton handles are retained for the app's lifetime;
  per-render `li` handles are dropped on each rebuild.
- **`autofocus` is not expressible on the surface** (2026-08-16, found by
  the harness on its first run): UA-initiated focus is processed at
  rendering opportunities and only when nothing else holds focus, so it
  diverges across backends by timing, not semantics. The attribute is
  rejected; focus is the explicit `focus()` op. General rule: attributes
  that *trigger UA behaviors* (autofocus and friends) are outside the
  equivalence envelope until specced op-like.
- **Backend equivalence is cheap to hold**: the three backends share the
  validation tables and the event-record builder, differ only in
  application strategy, and the harness pinned them identical on the first
  honest run (after the autofocus fix). Trap messages surface deltic's
  unbranded-throw guidance — expected: surface violations are deliberate
  traps, not WIT errors, per #16.

## Deliberately out of scope (the framework wires up here)

- The real worker/frame split (the `channel` backend proves the protocol
  over a genuine MessageChannel; moving its two halves into a worker and a
  sandboxed frame is placement, not design).
- The permission linker (#16: imports satisfied/stubbed per grant) — here
  the boot script links everything unconditionally.
- Asset pipeline (this app has no images/fonts; CSS is a *host* asset).
- Persistence (framework data services, not localStorage).
- A richer a11y vocabulary than native element semantics.

## Build

Requires Rust (`wasm32-unknown-unknown`), `wasm-tools`, and Deno.

```sh
just build    # → ../../docs/spike-todomvc (the Pages root)
just serve    # build + serve docs/ on :8931
```

Pipeline: `cargo build` (todomvc + lab guests) → `wasm-tools component new`
+ `validate` → build-time translate (envelopes) → `deno bundle` the host
(one bundle, three pages: demo / harness / bench) → assemble the demo dir.

## Pins

| what | version |
|---|---|
| deltic (`@deltic/runtime`, `@deltic/translator`) | `0.1.0-pre.gc4043e6` (JSR) |
| wit-bindgen (Rust crate) | `=0.60.0` |
| dioxus (`dioxus`, `dioxus-core`, `dioxus-html`) | `=0.7.10` (JS boundary severed at build, see `../no-js-bindgen`) |
| preact / htm / componentize-js / jco | `10.27.2` / `3.1.1` / `0.18.4` / `1.29.0` (npm, `guest-preact/package.json`) |
| Rust | 1.96.0, `wasm32-unknown-unknown` |

`web/todomvc-app.css` is vendored from
[todomvc-app-css](https://github.com/tastejs/todomvc-app-css) 2.4.3 (MIT,
© TasteJS).
