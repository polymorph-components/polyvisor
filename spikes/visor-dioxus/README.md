# spikes/visor-dioxus — the visor's strip and drawer host as a component

**The question.** The visor is the framework's trusted UI: the pinned strip,
the drawer, the pixels an app cannot reproduce. Today it is TypeScript running
as the page's own script (`visor/ui/`). Could it instead be a wasm component
rendering through `polymorph:dioxus`, the same mutation surface apps use?

**The answer: yes, it works — and it costs about eight times the download, in
the one place the project has decided download size means audit surface.**
Everything below is measured, not estimated. Nothing here is adopted; this
directory is a spike and the decision is open.

Scope: `visor/ui/visor.ts:1211-2786` — the strip and the drawer host, 1,576
lines. Sheets, pairing and entry stay in TypeScript and arrive in the drawer as
foreign DOM, which is what makes the seam question real rather than academic.

## What was built

A Rust/Dioxus component (`src/`, 4,228 lines) rendering the whole of the
visor's territory — `#visor-zone`, `#visor-drawer`, `#visor-strip`,
`#visor-dim` — against **the unmodified `visor/ui/visor.css`**. The stylesheet
is served, not copied (`e2e/server.ts`), so there is exactly one file the
component is measured against.

`wit/world.wit` extends the base `polymorph:dioxus/app` world with three
imports (`store`, `chrome`, `embedder`) and one export (`control`). 13
Playwright gates in real Chromium, ported from `demo/e2e/scenarios/`; 46 native
`cargo test`s covering the tenancy machine, the word roll, the event record and
the voice types.

## The costs

### Download, and therefore audit surface

| | raw | gzipped |
| --- | --- | --- |
| this component (strip + drawer host only) | 963,908 | **281,415** |
| `visor/ui/visor.ts` — the same scope, today | 46,082 | **13,843** |
| all of `visor/ui/` — strip, drawer, sheets, pairing, entry, QR codegen | 137,947 | **36,141** |

**~20x the ported scope; ~8x the entire current visor including everything
this spike did not port.** The floor is not our code: an empty dioxus
component that renders one div measured 435 KB raw / 144 KB gzipped, and the
sibling's own `counter` example is 383 KB. The build already runs `lto = fat`,
`opt-level = "s"`, `panic = "abort"`, `strip`; `wasm-tools strip` recovers
0.5%. The clock cost 1.2% of it.

This matters more here than in an app because the visor is the signed,
third-party-monitored release artifact (#3). The trade is ~1,600 lines of
reviewable TypeScript for a ~950 KB binary plus a Rust dependency tree
(dioxus-core, dioxus-html, wit-bindgen, wasi-libc).

### Expressiveness lost at the boundary

The TypeScript API is closures over live objects; WIT is data. Everything in
this table worked before and does not work now, and none of it is a bug in the
implementation — each is the boundary charging rent:

| `visor.ts` | what the data-only interface cost |
| --- | --- |
| `VisorConfig.appSurface` (:862) | the strip's **top line goes empty** over the visor's own sheets. TS falls back to the installed app's identity; a component cannot ask. |
| `VisorConfig.contextOverride` (:865) | `restore-context` can no longer consult the consumer's live surface first. |
| `DrawerTenantSpec.dim` (:721) | predicate → `bool`. The discipline survives (resolved once at open, undone by the remembered value); the predicate does not. |
| `DrawerTenantSpec.suspendable` (:735) | predicate → `bool`. The demo's "band suspends, expanded picker does not" is inexpressible. |
| `DrawerHost.note`/`setNote` (:820-826) | absent entirely — they take `HTMLElement`. |
| `committedHue`/`applyHue`/`speakWord` while unclaimed (:2713-2746) | TS **throws**. WIT has no error channel and a trap kills the instance, so these no-op — strictly weaker than the guard they replace. |
| `embedder.request-naming` | round-trips lossily: `AppVoice` has no text accessor, so the nickname cannot be echoed back. That is the enforcement working, but the embedder must re-derive. |

## The wins

### App voice is enforced by the type system, not by a grep

`demo/scripts/check-invariants.sh` check (h) asserts by grep that
`foreignToken()` is the only site assigning the `foreign` class. Here
`AppVoice` is a newtype with a private field, **no text accessor**, and one
`render()` that is the only place naming the class. `Surface.nickname` is an
`AppVoice`, not a `String`. `FrameworkText` — what `announce`, `speak`,
`spoken` and `add_event` all take — has `From<&str>` and deliberately no
`From<AppVoice>`.

Two `compile_fail` doctests run in `cargo test` (`src/voice.rs`). The honest
claim: **the grep checked the door; the type system checks the string.** An
app-influenced value cannot reach an announcement or render unmarked, because
no accessor exists. What is still not a compile error is writing
`class: "foreign"` beside a framework-voice literal — the direction
`visor/README.md` calls "ugly but not dangerous", which the grep did not catch
either.

`MarkIcon` went further: its field is a `&'static str` from the crate's own
vetted table, so an unvetted glyph is *unrepresentable* rather than filtered.

### Storage is capability-scoped

`store` names a `slot` enum — hue, word, identity, events, legacy-hue — and the
host maps slots to its own prefixed keys. **A component that cannot spell a key
cannot read the origin's other storage.** The TypeScript visor, running as page
script, has the whole origin's `localStorage` in reach and no way to promise
otherwise. This is a real trust improvement and it is free.

### The anchor word stays secret structurally

There is no getter in the WIT and none in Rust; `speak-word` and `reroll-word`
are the only doors and both end in the live region. Same discipline as the
TypeScript interface, one layer harder.

## The seam findings

**The `.visor-slide` leaf rule holds.** The renderer's applier walks paths by
child index (`polyengine-dioxus/host/src/applier.ts:194-204`), so foreign DOM
interleaved among guest-rendered siblings would corrupt addressing. Rendering
the slide as a childless leaf and appending the sheet beneath it is sufficient:
verified across guest re-renders, the drawer's height changing, a full swap
travel, and resume.

The real hazard turned out to be **node reuse, not path addressing** — if
Dioxus reused a slide element across two tenants, the incoming foreign root
would land beside the outgoing one. `Slide::key` is bumped per presentation to
forbid it, with a test.

**Suspension must unmount.** The guest emits `tenant-unmount` on suspend as
well as close, a deliberate divergence from `visor.ts`: resume *rebuilds*
rather than restores (:2392-2396), so a suspended sheet is dead immediately and
a host holding its reference would leak a detached tree. Nothing outside the
TypeScript visor held the sheet, so the original had no such obligation.

**A synchronous export races the async renderer.** `control.open-tenant` is a
plain export; the mutation that creates the `.visor-slide` flushes on the
renderer's async task afterwards. A host that queries the DOM synchronously
inside `embedder.tenant-build` finds nothing — or worse, the *stale* still-
occupied slide from the previous presentation. The fix is host-side sequencing
(poll for a slide that is both `:not(.visor-swap-out)` and empty; the leaf rule
is what makes "empty" a safe disambiguator), not a contract change. Any host
implementation would hit this.

**The ElementId problem.** `dom.get-client-rect` needs an ElementId and
`MountedData` will not surrender one (accessors async, backing type not
nameable downstream). The strip learns its own id by stashing `handle-event`'s
`target` in a thread-local for the duration of the synchronous dispatch
(`component.rs`'s `EVENT_TARGET`, ~6 lines). Worth fixing upstream.

## Corrections made during the spike

Recorded because both were nearly shipped as findings:

- **"The world has no clock" was wrong.** `wit-bindgen`'s `async_support` has
  no pollable→future bridge, but the bridge lives outside it: the sibling
  patches `dioxus-sdk-time` to a fork whose `wasip3` feature waits on
  `wasi:clocks/monotonic-clock`, and `examples/primitives` uses it. Dropping
  that patch as "unused" during the skeleton step made `ARM_MS` — a security
  control, the arming delay that defeats a baited mis-tap — look impossible
  rather than merely absent. Restored and measured: 702.5 ms, and **705.6 ms
  under `prefers-reduced-motion`**, which is the case that decides it
  (`visor.css:519` forbids driving the delay off the reveal transition
  precisely because reduced motion drops the animation and must keep the
  delay).
- **`#visor-back` was inert** because the first cut of `wit/world.wit` had no
  back notification — a contract bug of mine, on the control `visor.css`
  calls the unforgeable exit, and exactly what `visor.ts:1294-1297` forbids.
  `embedder.request-back` now exists.

`chrome.measure-sheet` was built, found to have no caller from either side, and
**deleted**: the host mounts the sheet, so the host already holds the
measurement, and every path gets it in-band through `mount-sheet`/
`resize-sheet`. The reasoning generalises and is recorded in the WIT at the
site where the function used to be.

## Does the TypeScript shrink?

Partly, and less than the raw diff suggests. 1,576 lines of `visor.ts` become
~341 lines of host wiring (`host/mount.ts`) — the rest of `host/` is test
fixture standing in for sheets that stay TypeScript either way. So roughly a
78% reduction **of the ported scope**, against 4,228 lines of Rust. Total
source goes up substantially; what moves is where the logic lives and what
tests it — the tenancy machine is now 46 native `cargo test`s instead of
browser-only assertions, which is a genuine gain in gate density.

## Assertions that could not be ported

Costs of the approach, listed rather than hidden:

- `strip-geometry`'s line-height/wrap check — its slop constants are tuned
  against the demo page's cascade context; re-deriving them here would be
  fitting noise. The load-bearing claims (45/45/10, the 44 px tap floor,
  zero document overflow, ellipsis-not-hide, zero layout shift with the badge
  lit) are ported and pass.
- `drawer-overflow`'s click/wheel/dim-gesture acts — they drive the demo's real
  storage sheet controls, which this spike deliberately does not build. Its
  height-budget and internal-scroll half is ported and passes.
- `drawer-announcements`' word-never-drawn probe — needs `claim()` plus a
  seeded word; flagged as a genuine gap rather than folded in.

## Running it

```
just build   # cargo → wasm32-wasip2 → validate → translate to a plan.json
just e2e     # 13 Playwright gates in real Chromium
cargo test   # 46 native tests, no browser
```

Two environment notes. The crate depends on the sibling renderer by relative
path (`../../../polyengine-dioxus`), which is correct for the canonical
checkout and **wrong inside a git worktree** — cargo cannot express "sibling of
my repo root", so a worktree needs a symlink beside it. And `mountApp` has no
seam for extra imports and does not expose `instance.exports`, so `host/`
duplicates ~40 lines of instantiation; two small upstream additions to
polyengine-dioxus (`imports?` on `MountOptions`, `exports` on `Mounted`) would
delete that duplication and are worth doing regardless of what happens here.
