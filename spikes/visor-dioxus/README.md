# spikes/visor-dioxus — the visor as a component

**The question.** The visor is the framework's trusted UI: the pinned strip,
the drawer, the ceremonies, the pixels an app cannot reproduce. Today it is
TypeScript running as the page's own script (`visor/ui/`). Could it instead be
a wasm component rendering through `polymorph:dioxus`, the same mutation
surface apps use?

**The answer: yes, it works. The download cost is large but it is a FLOOR, not
a slope — and the second round is what showed that.** Everything below is
measured, not estimated. Nothing here is adopted; this directory is a spike and
the decision is open.

Ported so far, in three rounds — **`visor/ui/` is now ported in full**:

- **round one** — `visor/ui/visor.ts:1211-2786`, the strip and the drawer host
  (1,576 lines). Sheets arrived in the drawer as foreign DOM, which is what
  made the seam question real rather than academic.
- **round two** — `visor/ui/sheets.ts` in full (1,866 lines): the naming
  ceremony, the settings sheet, the erase ceremony, the event list, and the
  trust table. These are now guest-rendered and no longer cross the seam.

- **round three** — `visor/ui/pairing.ts` and `entry.ts` (1,574 lines, plus the
  997-line vendored QR generator, which became a dependency rather than a hand
  port): device enrollment, and the two entry ceremonies that decide how a
  browser becomes a device with an account.

Still TypeScript, deliberately: a consumer's own sheets (the demo's credential
sheet and storage picker). **Keeping one foreign tenant is a feature of the
spike, not an omission** — the mixed case, guest sheets and a consumer's
foreign DOM in one drawer, is what the real system looks like and is the thing
most likely to break.

## What was built

A Rust/Dioxus component (`src/`, 11,378 lines) rendering the whole of the
visor's territory — `#visor-zone`, `#visor-drawer`, `#visor-strip`,
`#visor-dim`, and now the four ceremonies — against **the unmodified
`visor/ui/visor.css`**. The stylesheet is served, not copied
(`e2e/server.ts`), so there is exactly one file the component is measured
against.

`wit/world.wit` extends the base `polymorph:dioxus/app` world (now `@0.6.0`)
with five imports (`store`, `chrome`, `embedder`, `pairing-driver`,
`entry-host`) and five exports (`control`, `marks`, `sheets`, `pairing`,
`entry`). **35 Playwright gates** in real Chromium ported from
`demo/e2e/scenarios/`, and **100 native `cargo test`s** covering the tenancy
machine, the trust table, the word roll, the event record, the voice types, the
two enrollment state machines and the QR matrix.

## The costs

### Download, and therefore audit surface

| | raw | gzipped |
| --- | --- | --- |
| empty dioxus component (renders one div) | 435,281 | **144,247** |
| + strip and drawer host (round one) | 963,908 | **281,415** |
| + all four ceremonies and the trust table (round two) | 1,220,168 | **334,200** |
| + pairing and the entry ceremonies (round three) | 1,637,011 | **414,211** |
| **all of `visor/ui/` — the same scope, today** | 137,947 | **36,141** |

**THE SHAPE OF THE COST IS THE RESULT.** Round one read as a 20x multiplier.
It is not a multiplier — it is a floor plus a small slope:

- the floor is **144 KB gzipped** before a line of visor code exists, and it
  is not our code (the sibling's `counter` example is 383 KB raw)
- the strip and drawer host cost **+137 KB** on top of it
- **1,866 further lines of TypeScript — the whole of `sheets.ts` — cost
  +53 KB**, against the ~6 KB gzipped those lines occupy today
- pairing and entry cost **+80 KB**, of which 16 KB is the `qrcode` crate

The ratio therefore improves monotonically as more moves in: **~20x** for the
strip alone, **~16x** with the sheets, **~11.5x** for the whole of `visor/ui/`.
Anyone deciding this should decide about the **floor**, because that is where
the money is; arguing about the slope is arguing about the small half.

### The capability that turned out not to be needed

`document::eval` was turned on in round three and turned back off in the same
round. The reasoning is worth keeping because it is the only place this spike
reversed itself on evidence.

It was enabled on the belief that `pairing.ts:133-144`'s 2D canvas — building
the join code's QR and reading it back as a PNG data URL — was the one thing in
all of `visor/ui/` that a DOM-mutation surface could not express. That belief
was wrong. A 79-character join code is a 37-module symbol, which reduces to
**362 row-wise runs**: one `<path>`, **two DOM nodes**, **26.5 ms** from
`request-join()` to painted, 0.05 ms to re-layout — and it decodes back to the
same code under a real scanner (`jsQR`, against the rasterised SVG).

Retiring it bought back **~37 KB gzipped**, about 70% of what the entire
1,866-line `sheets.ts` port cost, for a capability that reaches the page's own
realm (`globalThis`, `document`). In a trusted computing base that is a good
trade, and re-enabling it is one feature flag on the day something demonstrates
a need. The finding generalises: **eval is an escape hatch, and the visor —
having now been ported in full — does not currently need it.**

The build already runs `lto = fat`, `opt-level = "s"`, `panic = "abort"`,
`strip`; `wasm-tools strip` recovers 0.5%. The clock cost 1.2%.

This matters more here than in an app because the visor is the signed,
third-party-monitored release artifact (#3). The trade is the whole of
`visor/ui/` — ~6,100 lines of reviewable TypeScript — for a ~1.6 MB binary plus
a Rust dependency tree (dioxus-core, dioxus-html, wit-bindgen, wasi-libc,
qrcode).

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

Round two added two more, both from the ceremonies:

| `sheets.ts` | what the data-only interface cost |
| --- | --- |
| `DrawerTenantSpec.suspendable` as a predicate (:621-635) | still a `bool`, so the settings sheet suspends under *every* displacer, not only the settings→reset/events steps |
| `SurfaceMeta.value` rendering unplated when `foreign: false` (:795-801) | the TypeScript branches; here `value` is an `AppVoice` with no text accessor, so the plain branch is **unrepresentable** and the value is always plated. Over-plating is the "ugly but not dangerous" direction, so it stands — but it is the enforcement being *too* strong, and the honest fix is a two-voice enum rather than widening the door |
| `toLocaleDateString()` (:780) | no locale or date formatter on the world; renders ISO `YYYY-MM-DD` |

And one it did **not** cost, because I extended the contract instead:
`location.reload()` (:1618-1637) had no expression, which left the erase
ceremony wiping storage while the running instance went on saying the name it
had just forgotten. `chrome.reload` now exists and the ceremony ends with it.

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

### The ceremonies deleted the seam for themselves — and kept it for others

The four visor ceremonies no longer emit `embedder.tenant-build` /
`tenant-unmount`: they render themselves, so for them the foreign-DOM
machinery is simply gone. A consumer's own sheets still use it. That mixed
case — guest-rendered ceremonies and a consumer's foreign sheet in one drawer
— is what the real system looks like, and it holds (`spike.spec.ts`'s slot
gates pass unchanged alongside the new ones).

The visible consequence: the host side barely grew. `host/mount.ts` went from
~341 to ~396 lines of real wiring while 1,866 lines of TypeScript ceremony
moved into Rust, because nothing about those ceremonies crosses the boundary
any more.

### A failure mode with no TypeScript analogue

Round two produced two defects that looked unrelated — the settings sheet
hanging forever on first render, and the erase ceremony's arming delay never
firing — and they were one mistake: **render bodies reading state through the
WRITE door.**

`with_visor` takes `signal.write()`, which marks the signal dirty
unconditionally (that is what lets a `control` call arriving on a bare export
task repaint the strip). `read_visor` takes `signal.read()`, which subscribes
the calling component. Reading through the writer therefore does one of two
things:

- a component that **writes but never subscribes** renders once and never
  learns anything again — the erase control stayed dead after the machine had
  armed it (`embedder.tenant-armed` was observed firing on time)
- a component that **subscribes and writes** dirties itself every pass —
  dirty, render, dirty — so the guest never returned from the export and the
  host awaited it forever

The arming one is the one to dwell on: **a security control went dead on
exactly the path this port proposes to ship**, while the same control worked
on the foreign-sheet path. It failed closed, which is the right direction, and
it was invisible to all 60 native tests because the fault was downstream of
every effect a test without a renderer can observe. Only the browser gate
caught it. Measured after the fix, guest-rendered path: 706.0 / 710.5 /
708.5 ms against `ARM_MS = 700`.

Worth weighing honestly against the type-system wins above: the boundary buys
real static guarantees about *voice*, and introduces a new class of
runtime-only reactivity bug that TypeScript's direct DOM writes cannot have.

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

Yes, and round two sharpened the answer. **3,442 lines of TypeScript**
(`visor.ts`'s strip and drawer host, plus all of `sheets.ts`) become **~396
lines of host wiring** in `host/mount.ts`; the remaining 261 lines of `host/`
are fixture tenants standing in for a consumer's own sheets, which stay
TypeScript either way.

The telling number is the DELTA: round two moved 1,866 lines of ceremony into
Rust and grew the host by ~55 lines — because a guest-rendered ceremony has
almost no boundary. Against that, 7,319 lines of Rust. Total source goes up
substantially; what moves is where the logic lives and what tests it.

Gate density is the clearest gain: **100 native `cargo test`s** now hold the
tenancy machine, the trust table, the word roll and the voice types with no
browser at all. The clearest loss sits right beside it — `src/sheets/` is
wasm32-gated, so tests written inside it do **not** run under host
`cargo test`, and the reactivity defects above were invisible to every native
test by construction. Whatever is true of the ceremonies is held by the
browser gates or not at all.

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
- `petname-ceremony`'s full nomination path was initially untestable through
  `sheets.request-naming` because `types.surface` had no `nomination` field —
  a contract omission, since fixed; the mechanism is now exercised end to end
  (offered first, `data-nominated`, and silently dropped when another record
  wears the glyph).

## Running it

```
just build   # cargo → wasm32-wasip2 → validate → translate to a plan.json
just e2e     # 35 Playwright gates in real Chromium
cargo test   # 100 native tests, no browser
```

Two environment notes. The crate depends on the sibling renderer by relative
path (`../../../polyengine-dioxus`), which is correct for the canonical
checkout and **wrong inside a git worktree** — cargo cannot express "sibling of
my repo root", so a worktree needs a symlink beside it. And `mountApp` has no
seam for extra imports and does not expose `instance.exports`, so `host/`
duplicates ~40 lines of instantiation; two small upstream additions to
polyengine-dioxus (`imports?` on `MountOptions`, `exports` on `Mounted`) would
delete that duplication and are worth doing regardless of what happens here.

## What is still TypeScript, and what the contract refuses to carry

A consumer's own sheets — the demo's credential sheet and storage picker —
stay TypeScript and arrive through the foreign-DOM seam. That is deliberate:
the mixed case is what the real system looks like.

`pairing-driver` was first transcribed whole from `visor/ui/pairing-driver.ts`
— nineteen functions — and the port calls ten. The other nine are called by
consumer surfaces that are not in `visor/ui/` and are not ported here, so they
were **deleted from the contract** rather than kept for completeness. An import
is a capability the host must grant and a promise the guest may call; a
contract wider than its caller is a standing invitation to widen the caller.
`us-devices-list` was kept despite having no Rust caller, because the
TypeScript visor does call it — its absence is a gap in the port, not evidence
the visor does not need it.

Two things the contract gained this round because the port demonstrated the
need: `types.context` grew `pairing-join`/`pairing-add` (without them the strip
read "visor settings" while a comparison screen was up — safe, since the
cluster stayed untappable, but not true), and `store.slot` grew `account` for
the user-system boot cache, which the pairing wave correctly refused to
overload onto `marks`.
