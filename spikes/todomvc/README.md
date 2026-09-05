# TodoMVC surface spike

TodoMVC where the **entire application is a WebAssembly component** driving a
curated DOM surface — no app JS, no app HTML, no app CSS-with-URLs. The first
conversion-checkpoint artifact for [#16] (app execution model: no app JS),
under the shape rules of [#15], running on [deltic].

**Live demo (mobile-friendly):**
https://polymorph-components.github.io/polymorph-apps/spike-todomvc/

**Scope.** Validates the wasm→DOM plumbing only: the WIT surface, the
validated op protocol, and the event-record path. The permission linker and
asset pipeline are deliberately left as seams; the worker/frame split is no
longer one (both surfaces mount into a real sandboxed frame). Quarantined
and delete-at-will, but no longer gate-less: see [Gates](#gates), two
Playwright suites, both green. The built demo is committed at
`docs/spike-todomvc/` (the repo's Pages root).

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

- **`../../wit/surface/surface.wit`** is the contract — the framework's, not
  a copy of it. `wit/todomvc.wit` here declares only this spike's two
  *worlds* and imports `polyvisor:surface@0.1.0` through
  `wit/deps/polyvisor-surface`, which is a **symlink** to that file. `dom` is
  a WebIDL-mirror subset
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
Phase C). **These four are the `polyvisor:surface` guests' backends only**
— the dioxus guest is a different world with one transport; see
[Two surfaces, four guests](#two-surfaces-four-guests).

**The equivalence harness** ([harness.html](https://polymorph-components.github.io/polymorph-apps/spike-todomvc/harness.html))
makes "semantically equivalent" a checked property: the same guests run the
same scripts on every backend — 15 TodoMVC steps (synthetic event records
plus real DOM clicks) with full-DOM serialization compared stepwise
(attributes, input value/checked props, focus marker), and 8 probe cases
from a violation guest (`lab/`) compared as trap vectors, including the
flush-on-trap rule (a visible legal mutation before the violating call must
land on every backend).

Status: **PASS**, 3 backends — including across the runtime bump (see
[Gates](#gates)). It was RED from 2026-08-21 to 2026-09-05 and nobody knew,
because the harness had no gate behind it; see
[Once-broken](#once-broken-the-surface-guests-could-not-instantiate-for-15-days).

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

## Two surfaces, four guests

The spike no longer has "one world". It has **two app surfaces, split by
what the app is written in** — and demonstrating both in one page is now
the point of the `?guest=` toggle:

| surface | for | guests here |
|---|---|---|
| **`polyvisor:surface`** (`wit/todomvc.wit`) — the WebIDL-mirror surface, [#15]'s bet | hand-written, Preact, componentize-js apps | `guest/`, `guest-preact/`, `lab/` |
| **`polymorph:dioxus`** ([polyengine-dioxus], the sibling renderer) | dioxus apps, and the visor itself | `guest-dioxus/` |

They are different worlds, not two configurations of one. The surface is a
curated DOM API an app calls; `polymorph:dioxus` is a batched mutation
channel a VDOM renders through. Neither subsumes the other and both are
kept.

| guest | tech | size (raw / gz) | notes |
|---|---|---|---|
| `guest/` | hand-written Rust | 36 KB / 13 KB | baseline; naive rebuild |
| `guest-dioxus/` | dioxus 0.7 rsx on **polyengine-dioxus** | 644 KB / 219 KB | `?guest=dioxus`; wasm32-wasip2, mounted in a sandboxed frame |
| `guest-preact/` | **unmodified Preact 10.27** in StarlingMonkey (componentize-js) | 12.4 MB / 4.0 MB | `?guest=preact`; JS-as-userland proof |
| `lab/` | hand-written Rust | 28 KB / 10 KB | violation probes for the harness |

[polyengine-dioxus]: https://github.com/lannbot/polyengine-dioxus

### The dioxus guest: re-targeted onto polyengine-dioxus

`guest-dioxus/` used to implement the *surface* world with a hand-rolled
`renderer.rs` (a `WriteMutations` impl over the surface imports, ~285
lines) and `events.rs` (an `HtmlEventConverter`, ~249 lines). **Those were
the prototype of polyengine-dioxus**, which is the generalised, maintained,
independently-tested version of exactly that idea. Both files are now
**deleted in its favour**, along with `app.rs`: the app body is taken over
from the sibling's own `examples/todomvc`, because one TodoMVC in dioxus is
enough and a second copy that drifts is worse than a shared ancestor.

What the guest is now: `polyengine_dioxus::launch!(app)`, built for
**wasm32-wasip2** — which emits a component directly, so this guest needs
no `wasm-tools component new` and, notably, **no `wbg-sever`**: on that
target wasm-bindgen compiles to off-target stubs and emits no imports at
all, so the JS-boundary lie the old pipeline had to sever generically
([`../no-js-bindgen`](../no-js-bindgen), still used by nothing here) does
not arise. The artifact imports `dom`, `events`, `head`, `history` and
`mutations`, and **not `eval`** — apps never get eval, and the justfile
asserts its absence rather than assuming it.

**The filter is a route now.** Upstream's TodoMVC keeps All/Active/
Completed as in-guest state; this guest drives it from
`polymorph:dioxus/history`, encoded by the host into the URL fragment
(`fragmentHistory` — the WIT names this exact case, "a host that does not
own the path, such as polyvisor's apps"). Deliberately **no
dioxus-router**: three filter states reachable by three literal routes do
not need a routing table when `history()` is already root context. Both
directions are wired and they are genuinely different paths — a click is a
guest-initiated `push` (which deliberately does *not* echo back on
`changes`), the back button is a host-initiated move that arrives on the
`changes` stream.

#### The three documented gaps: two closed, and honestly

The old prototype had three recorded gaps. The re-target does **not** close
all three "for free", and the difference matters:

- **Only six event families converted** — **CLOSED, outright.** The sibling
  converts the whole dioxus-html vocabulary (13 payload families plus the
  ResizeObserver/IntersectionObserver-backed `resize` and `visible`).
- **`bubbles` was always told `false`** — **CLOSED, outright.** The renderer
  sends dioxus-core's real `event_bubbles` verdict and does synthetic
  bubbling guest-side.
- **No `onmounted`/focus bridging** — **closed in the renderer, reopened by
  the frame.** The renderer implements `mounted` and the whole `MountedData`
  backing (`interface dom`), so a *same-realm* mount auto-focuses correctly.
  Across the sandboxed frame those imports are synchronous and cannot cross
  postMessage (see below), so the edit field still does not auto-focus on
  the default backend. Same visible symptom as before, entirely different
  cause: it was missing plumbing, it is now a structural property of the
  trust boundary.
- **`preventDefault`/`stopPropagation`** — same shape: real in the renderer,
  no-ops across the frame.

#### What the prototype taught, and is still true

The 2026-08-16 framework-support investigation produced findings that
outlived the code it produced. Kept because they are about the *surface* and
the *choice*, not about the deleted renderer:

- **Surface additions the framework forced** (the exact prerequisite list
  predicted): `create-text-node` (mixed content like the
  `<strong>{n}</strong> items left` counter), and `before`/`after`
  (ChildNode mirrors) for positional insertion — all structural, all
  validator-checked, two probe cases pin text-node restrictions. These are
  in `wit/todomvc.wit` today and the hand-written and Preact guests use
  them.
- **Leptos rejected, and the reason has not changed.** tachys 0.2 (leptos
  0.8) hardcodes `pub type Rndr = dom::Dom` — the 0.7-era generic renderer
  was monomorphized away for compile times, and the alternate renderers are
  commented out in the source. Supporting it means forking its view layer.
  Its standalone `reactive_graph` remains attractive for a future
  hand-rolled fine-grained renderer.
- **`wbg-sever` is no longer in this guest's path**, and the reason is worth
  recording because it looks like the problem went away on its own. It did
  not: dioxus-core's mandatory `subsecond` still links js-sys/wasm-bindgen
  on *all* wasm32 targets ("wasm32 implies browser"). What changed is the
  target — on `wasm32-wasip2` wasm-bindgen compiles to off-target stubs and
  emits no imports to sever. [`../no-js-bindgen`](../no-js-bindgen) remains
  the generic answer for anything still built for
  `wasm32-unknown-unknown`.

### The frame transport (`host/dioxus-frame.ts` + `host/frame-dioxus.ts`)

The page's default backend is `frame`, and the dioxus guest keeps it. That
is not decoration: the visor's strip carries the user's personal anchor
colour, and non-disclosure of it is **structural** — a document on an opaque
origin has nothing to read, as opposed to nothing it is *allowed* to read
(`visor/frame/frame-backend.ts` explains at length). A re-target that
mounted the app same-realm would have silently traded that away.

The sibling's `mountApp` applies into the document it runs in, so the two
halves are split here:

- **the shell** runs the wasm instance, owns the import table, and reads the
  mutation stream — and never touches the app's DOM;
- **the frame** owns the app's document: `DomApplier`, `applyOperations`,
  `EventDispatcher`, `serializePayload`, all of them the sibling's code
  rather than a reimplementation.

Op batches cross as-is (lifted `operation` values are plain data, `Uint8Array`
paths and `bigint`s included, so `structuredClone` carries them); events are
serialized frame-side and posted back with the ids `handle-event` wants. The
handshake, the height reporting and the teardown-with-completion mirror
`frame-backend.ts`'s discipline exactly. It stays **in the spike**: it is the
first consumer of this shape, and it moves upstream if a second appears.

**The honest degradations**, each marked at its site in the source:

1. **`dom-event.prevent-default` / `stop-propagation` are no-ops.** The
   frame's native listener returned before the shell saw the event. The WIT
   already covers the shape ("calling either method after the originating
   dispatch has completed is a harmless no-op").
2. **The `dom` queries cannot cross.** `get-client-rect`, `set-focus` and the
   rest are synchronous imports; postMessage is not. They answer the
   interface's own documented miss values (`none` / `false`), which is a real
   specified state and not an error.
3. **`eval` is not granted** — a rule, not a degradation. No import supplied,
   none imported.
4. **A fourth, found by building it rather than predicted:** an event payload
   carrying a *resource* — `form-data.files`, `drag-data.transfer` — cannot
   cross either, because the serializer builds live `HostFile`/
   `HostDataTransfer` instances and `structuredClone` flattens a class
   instance into a method-less object. TodoMVC never produces one (its inputs
   are text and checkbox, so `files` is always `[]`), so it costs this app
   nothing today.

One consequence of (1) needed a frame-side fix rather than just a note: an
un-prevented in-page anchor click navigates the *frame's* fragment, and a
same-document navigation in a subframe still appends to the browsing
context group's **joint session history** — so the shell's back button
stepped through fragment entries of a frame whose URL nobody reads. Found
by the e2e suite, whose second `history.back()` moved nothing. The frame
now refuses in-page anchor defaults on the guest's behalf: a framed app's
own fragment is unobservable by construction, so navigating it can only be
noise.

`?backend=` does not apply to this guest and is **not faked**. `direct` has
a real analogue (the sibling's own `mountApp`); `queued` and `channel` are
surface-specific — two application strategies for the surface's op protocol
— and `polymorph:dioxus` has one op protocol whose transport is decided by
where the applier lives. The page note says so rather than offering a
switch that ignores three of its four values.

## Gates

The spike had **no automated gate** before this wave — which is why the
break recorded under "Once-broken" below sat undetected for 15 days. It now
has two, in `e2e/` (Playwright, real Chromium), and both are green:

```sh
cd e2e && npm install && npx playwright install chromium   # first run
just e2e                                                    # build + both gates
```

- **`tests/harness.spec.ts`** wraps the existing differential harness
  (`web/harness.html`): the same guests over the three same-realm surface
  backends, 15 scripted steps compared stepwise plus 8 trap-vector probes,
  asserted PASS. **Green**, 1/1 — and this is the gate that proves the
  **runtime bump** left the surface guests alone. That verification could not
  actually run until the package rename below landed: before it, the guests
  failed to instantiate for an unrelated reason, which masked the question
  entirely. Now it has run, on the new runtime, and the three backends are
  stepwise identical.
- **`tests/dioxus-frame.spec.ts`** drives the re-targeted dioxus guest on
  the default frame backend through real interaction — add, toggle, edit via
  dblclick+Enter, cancel via Escape, destroy, and the three hash routes in
  both directions — and asserts the two properties a re-target could silently
  lose: that the app frame **cannot resolve the shell's `--visor-bg`** (it is
  opaque-origin), and that the artifact **does not import `eval`**. **Green**,
  4/4.

## Once-broken: the surface guests could not instantiate, for 15 days

**Kept as a record, not deleted.** From **2026-08-21** (commit `4ec8d2f`,
"Split the WIT contracts: polyvisor:surface, polyvisor:panel…", #74) to
**2026-09-05**, `guest/`, `guest-preact/` and `lab/` could not instantiate
*at all*. Not "behaved oddly" — the demo page and the harness both died on
the first import resolution:

```
PlanError: host import 'polymorph:todomvc-spike/dom@0.0.1/element' not provided
  (no key 'polymorph:todomvc-spike/dom@0.0.1' in imports;
   registered: polyvisor:surface/dom@0.1.0, …)
```

**What broke.** #74 moved the surface's real definitions to the repo root as
`polyvisor:surface@0.1.0` and moved `visor/surface/surface.ts` onto those
import keys. `wit/todomvc.wit` here was a *second copy* of the same
interfaces under `package polymorph:todomvc-spike@0.0.1`, and it was not
moved with them. The two definitions were byte-identical in body, so nothing
looked wrong on inspection; only the package name differed, and the package
name is exactly what the import key is made of.

**Why it survived 15 days.** Because nothing ran. The spike was explicitly
"wired into no CI", its correctness lived in a harness page a human had to
open, and nobody opened it. This is the whole argument for the gates above,
made concretely and at this spike's expense.

**A gate would have caught it — and did.** `e2e/tests/harness.spec.ts` was
written for a different purpose (proving the runtime bump harmless) and
found this on its very first honest run, before it could serve that purpose
at all.

**Not the runtime bump.** Ruled out by isolation rather than by argument: the
identical failure reproduces on the old
`jsr:@deltic/runtime@0.1.0-pre.gc4043e6` with old-format envelopes
regenerated by the old translator.

**The fix**: stop keeping a second definition. `wit/todomvc.wit` now declares
**only this spike's two worlds** and imports `polyvisor:surface@0.1.0`
through `wit/deps/polyvisor-surface`, which is a **symlink** to
`<repo>/wit/surface` — not a vendored copy, because the surface lives in
this same repository and a snapshot is just a future drift waiting to
happen. (`spikes/visor-dioxus/wit/deps` vendors a copy only because its
dependency is a checkout outside this repo.) The consequences were
mechanical and are the entire remainder of the change:

| where | from | to |
|---|---|---|
| `guest/`, `lab/` (Rust) | `crate::polymorph::todomvc_spike::*` | `crate::polyvisor::surface::*` |
| `guest/`, `lab/` (bindgen) | — | `generate_all` added: wit-bindgen will not generate bindings for a *dependency* package without it |
| `guest-preact/` (JS) | `"polymorph:todomvc-spike/dom@0.0.1"` | `"polyvisor:surface/dom@0.1.0"` |
| `guest-preact/package.json` | `--external:polymorph:*` | `--external:polyvisor:*` |

No guest *behaviour* was touched, which is what let the harness's stepwise
DOM comparison serve as the check that the rename was purely mechanical.



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

Requires Rust (`wasm32-unknown-unknown` **and** `wasm32-wasip2`),
`wasm-tools`, Deno, and — for the dioxus guest — a
[polyengine-dioxus][polyengine-dioxus] checkout as a sibling of this repo's
root (`../../../polyengine-dioxus`; inside a git worktree a symlink next to
the worktree restores that invariant, as `spikes/visor-dioxus` documents).

```sh
just build    # → ../../docs/spike-todomvc (the Pages root)
just serve    # build + serve docs/ on :8931
just e2e      # build + both Playwright gates
just size     # the dioxus component, raw and gzipped
```

**Two pipelines**, because there are two surfaces:

- surface guests (`guest/`, `lab/`, `guest-preact/`): `cargo build` for
  `wasm32-unknown-unknown` → `wasm-tools component new` + `validate`;
- the dioxus guest: `cargo build` for `wasm32-wasip2`, which **emits a
  component directly** — no `wasm-tools component new`, no `wbg-sever` —
  then `validate --features component-model,cm-async` (the mutation channel
  is a `stream`, so `cm-async` is required) and an assertion that the
  artifact does not import `eval`.

Both then get build-time translation into envelopes (the blessed deploy
artifact; nothing ships a translator), and `deno bundle` produces the host
bundle plus **two** frame entries — the surface's and the dioxus guest's.

## Pins

| what | version |
|---|---|
| deltic runtime + translator | the sibling's pinned `.deps/polyengine` checkout (`polyengine-dioxus/justfile`'s `POLYENGINE_REV`), reached through `deno.json` — **not** JSR any more |
| polyengine-dioxus | the sibling checkout, by path (`polymorph:dioxus@0.6.0`) |
| wit-bindgen (Rust crate) | `=0.60.0`, features `async-spawn`, `inter-task-wakeup` |
| dioxus (`dioxus`, `dioxus-history`) | `=0.7.10` — mirrored EXACTLY from the sibling; `dioxus-core` is shared state with the renderer and a skew compiles two incompatible copies |
| preact / htm / componentize-js / jco | `10.27.2` / `3.1.1` / `0.18.4` / `1.29.0` (npm, `guest-preact/package.json`) |
| Playwright | `1.62.1` (`e2e/package.json`) |
| Rust | 1.96.0, `wasm32-unknown-unknown` + `wasm32-wasip2` |

**Why the runtime moved.** The spike pinned
`jsr:@deltic/runtime@0.1.0-pre.gc4043e6`, which predates
component-model-async; the dioxus guest's mutation stream needs `cm-async`,
so `deno.json` now maps `@deltic/*` onto the sibling's `.deps/polyengine`
checkout exactly as `spikes/visor-dioxus/deno.json` does, and the build uses
its translate tool. (The spike's own `tools/translate.ts` is deleted — it
wrapped the JSR translator and had no remaining caller.)

`web/todomvc-app.css` is vendored from
[todomvc-app-css](https://github.com/tastejs/todomvc-app-css) 2.4.3 (MIT,
© TasteJS).
