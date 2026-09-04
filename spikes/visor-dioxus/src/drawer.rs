//! THE DRAWER HOST: tenancy with precedence, the swap, the height budget and
//! the spoken lifecycle. Ported from `visor/ui/visor.ts:2044-2605`.
//!
//! # Why this is pure data
//!
//! The TypeScript drawer host does its work by touching the DOM directly —
//! `drawerInner.replaceChildren(slide)`, `dim.hidden = true`, `setTimeout`. A
//! guest cannot: it describes a tree and the renderer diffs it. So the machine
//! here computes two things and touches nothing:
//!
//!   - the DRAWER'S VIEW ([`DrawerState::visible`], `height`, `dimmed`,
//!     `slides`), which `app.rs` renders declaratively; and
//!   - a list of [`Effect`]s — the `embedder` notifications, the spoken
//!     lifecycle sentences, and the recomputed strip context — which `lib.rs`
//!     drains at the edge.
//!
//! That split is what makes the precedence rules testable by `cargo test`
//! instead of only through a browser, which is the point: the eviction order,
//! the exclusive refusal, the suspend/resume pairing and the
//! ownership-aware restore are where this design is easy to get subtly wrong.
//!
//! # Timers, and why they are effects rather than calls
//!
//! The three deferrals of `visor/ui/visor.ts` — the arming delay, the deferred
//! blank, the end of a travel — are all present, on a real clock
//! (`dioxus-sdk-time`'s `wasip3` backend, which waits on
//! `wasi:clocks/monotonic-clock`; see `Cargo.toml`). They are expressed here as
//! [`Effect::Schedule`], so this module stays pure: `component.rs` owns the
//! sleeping, and `cargo test` drives the timer EDGES directly
//! ([`DrawerState::arm_elapsed`], [`DrawerState::swap_settled`],
//! [`DrawerState::collapse_settled`]) without a clock underneath it. The rules
//! a delay has to obey — is it still the same presentation, is the drawer still
//! unoccupied — are therefore checkable natively; only the duration is not.
//!
//! EVERY DEFERRED CALLBACK IS GUARDED BY STATE, NEVER BY THE FACT THAT IT WAS
//! SCHEDULED. That is visor.ts's discipline throughout (`session !== s ||
//! suspended` at :2364, `if (!occupied())` at :2491, `token !== announceToken`
//! at :1931), and it is what makes a late or superseded timer harmless instead
//! of a bug.

use crate::state::Context;
use crate::voice::FrameworkText;

/// THE STRIP OF APP THAT ALWAYS SHOWS (visor.ts:2044-2053). The visor's whole
/// claim is that its pixels are somewhere else than the page's, and a drawer
/// allowed to grow until it covers the last of the app surface makes that claim
/// uncheckable: a full-screen sheet is indistinguishable from a page that has
/// drawn one. A sheet that wants more scrolls internally; it does not get the
/// last 48px.
pub const APP_REVEAL: f64 = 48.0;

/// THE ARMING DELAY (visor.ts:627-638). Controls and inputs stay disabled until
/// it elapses, which defeats a baited mis-tap — an app training rapid taps at a
/// position where a visor control is about to appear.
///
/// THE TIMER IS THE ENFORCEMENT; THE SLIDE IS ONLY ITS VISIBLE FORM, so
/// `prefers-reduced-motion` drops the animation and never the delay. visor.css:519
/// says the same thing from the other side and forbids the obvious shortcut:
/// the reveal's 700ms height transition must NOT be used as a proxy for this,
/// precisely because reduced motion sets `transition: none` and would then
/// arm instantly.
///
/// It is ALSO the deferred-teardown delay: a close animates for this long, so
/// the drawer is only blanked after it — and only if no other tenant claimed it
/// meanwhile (see [`DrawerState::collapse_settled`]).
pub const ARM_MS: u64 = 700;

/// The length of one occupant-swap travel. PAIRED WITH CSS: it must equal the
/// `.swapping` duration of `#visor-drawer-inner` (visor.css:542-544), which is
/// what makes the height change and the horizontal travel one motion rather
/// than two of different lengths.
pub const SWAP_MS: u64 = 420;

/// `DrawerCloseOptions`, reduced to what the drawer host itself reads
/// (wit/world.wit:118-121).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct CloseReason {
    /// `false` = close WITHOUT touching the strip's context, because the caller
    /// is about to claim it.
    pub restore_context: bool,
}

/// `DrawerTenantSpec` minus its callbacks and its closures (wit/world.wit:174-190).
#[derive(Clone, Debug)]
pub struct TenantSpec {
    pub name: String,
    /// FRAMEWORK VOCABULARY, fixed at registration — the noun phrase the
    /// drawer's spoken lifecycle sentence uses. Typed as [`FrameworkText`]
    /// because the one-directional rule binds harder here than anywhere else:
    /// the string is baked in at registration and arrives in the user's ear
    /// prefixed by their own anchor word, which is precisely the provenance
    /// claim the word exists to make unforgeable (visor.ts:685-695).
    pub spoken: FrameworkText,
    pub exclusive: bool,
    pub armed: bool,
    /// CONTRACT / TRANSLATION LOSS. `DrawerTenantSpec.dim` is
    /// `boolean | ((session) => boolean)` in TypeScript (visor.ts:721) — a
    /// predicate for "the same ceremony opened over a consumer's NESTED PLACE
    /// must bracket it". A closure cannot cross the component boundary, so the
    /// WIT record carries a plain `bool`. What SURVIVES is the discipline the
    /// predicate existed for: the value is resolved once at open and the close
    /// undoes the REMEMBERED value — see `Tenant::dimmed_now`.
    pub dim: bool,
    /// CONTRACT / TRANSLATION LOSS, same shape: `suspendable` is
    /// `(session) => boolean` in TypeScript (visor.ts:735), so the demo's
    /// picker suspends while collapsed to a band and not while expanded. A
    /// `bool` here means a suspendable tenant is suspendable always.
    pub suspendable: bool,
}

/// What the machine asks the edge to do. Every arm is either a one-way
/// `embedder` notification (wit/world.wit:131-155), a sentence for the live
/// region, or the recomputed strip context.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Into `#visor-live` ONLY, never `announce`: the visual bottom line
    /// already says what the drawer is doing by SHOWING the sheet, and the
    /// anchor word must never reach pixels at all (visor.ts:2237-2241).
    Speak(String),
    BeforeShow(String),
    BeforeCollapse(String, CloseReason),
    AfterCollapse(String, CloseReason),
    AfterRestore(String, CloseReason),
    /// The arming delay ELAPSED — not "the sheet mounted". `embedder.tenant-armed`
    /// means the sheet's controls are now live (wit/world.wit:146-147), so
    /// emitting it at mount would be a false statement about a security
    /// control.
    Armed(String),
    Build(String),
    Unmount(String),
    /// Come back and try this edge again in `ms`. The edge re-checks its own
    /// guards, so a scheduled callback that has been overtaken does nothing.
    Schedule(Deadline, u64),
    /// The strip's context, RECOMPUTED — never asserted by a caller. See
    /// [`DrawerState::restore_context`].
    SetContext(Context),
}

/// A deferred edge, and everything the callback needs to know whether it is
/// still the current one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Deadline {
    /// `presentation` is the token [`DrawerState::arm_elapsed`] checks: arming
    /// is PER PRESENTATION, so a sheet rebuilt during the delay arms from zero
    /// and the older timer must not fire for it (visor.ts:780-784, 2361-2369).
    Arm { tenant: String, presentation: u64 },
    /// The end of a travel: drop the outgoing slide and settle the classes.
    Swap,
    /// The deferred blank, gated on OCCUPANCY rather than on the session that
    /// scheduled it (visor.ts:2487-2495).
    Blank,
}

/// Which way a slide travels. The page track's grammar replayed at drawer
/// scale: the occupant leaves to the LEFT while the arriving sheet comes in
/// from the RIGHT, and the reverse when the arriving one closes and the
/// suspended occupant returns (visor.css:553-577).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    Left,
    Right,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Motion {
    /// In flow, at rest — the slide the drawer's height is aimed at.
    Settled,
    /// `.visor-swap-in` plus `.from-left`/`.from-right` for one style
    /// resolution, then released.
    In(Dir),
    /// `.visor-swap-out` plus `.to-left`/`.to-right`. ABSOLUTELY POSITIONED, so
    /// it contributes no height and the drawer's curve animates to the INCOMING
    /// sheet's height while both are on screen.
    Out(Dir),
}

/// One occupant's full-width wrapper.
///
/// THE ELEMENT THAT MUST BE A LEAF. The renderer's applier walks paths by child
/// index (`polyengine-dioxus/host/src/applier.ts:194-204`), so a foreign child
/// interleaved among guest-rendered siblings would corrupt addressing. The
/// host appends the built sheet root INTO this element, and `app.rs` renders it
/// with no children at all — see the note there.
#[derive(Clone, PartialEq, Debug)]
pub struct Slide {
    pub tenant: String,
    /// A fresh key per presentation, so Dioxus never reuses a slide node
    /// across two different sheets — reuse would leave the previous tenant's
    /// foreign DOM inside a slide the new tenant is about to be appended to.
    pub key: u64,
    pub motion: Motion,
    /// Set for the one render after the slide appears, then cleared: the
    /// direction class has to be present for a style resolution and removed
    /// for the transition to run on its removal (visor.ts:2298-2302).
    pub offstage: bool,
}

impl Slide {
    fn is_out(&self) -> bool {
        matches!(self.motion, Motion::Out(_))
    }
}

#[derive(Clone, Debug)]
struct Tenant {
    spec: TenantSpec,
    /// Session alive. There is no session VALUE across the boundary — the
    /// TypeScript `S` was a consumer-owned object — so "open" is the whole of
    /// what a session is here, and the context handed to `open-tenant` stands
    /// in for `spec.context(session)`.
    open: bool,
    /// Session alive, drawer held by somebody else.
    suspended: bool,
    /// What `dim` RESOLVED to at open. The undo must match the do.
    dimmed_now: bool,
    /// Bumped by every presentation. ARMING IS PER PRESENTATION, so this is
    /// what an in-flight arm timer is checked against.
    presentation: u64,
    /// The context this tenant claims while it holds the drawer; also what
    /// `restore_context` recomputes from.
    ctx: Context,
}

#[derive(Default)]
pub struct DrawerState {
    /// REGISTRATION ORDER IS PRECEDENCE ORDER (wit/world.wit:239-241): the
    /// order `restore_context` consults, and the order evictions run in.
    tenants: Vec<Tenant>,
    slides: Vec<Slide>,
    next_key: u64,
    /// `#visor-drawer[hidden]` is the closed state.
    pub visible: bool,
    /// The inline pixel height of `#visor-drawer-inner`. NEVER `auto`: `auto`
    /// is not interpolable against a length, so per CSS Transitions the running
    /// height transition would be CANCELLED and the drawer would snap
    /// (visor.css:511-520, visor.ts:2126-2148).
    pub height: f64,
    /// `--visor-sheet-max` on `#visor-drawer`: the measured
    /// viewport-minus-strip-minus-`APP_REVEAL` budget.
    pub sheet_max: f64,
    pub dimmed: bool,
    /// `.swapping` on the inner for the length of a travel, which is what runs
    /// the height change and the horizontal travel on one duration and one
    /// curve (visor.css:542-544).
    pub swapping: bool,
    /// Which tenant's `tenant-build` is outstanding; a `mount-sheet` naming
    /// anything else is a stale build and is dropped.
    awaiting: Option<(String, u64)>,
    /// The last natural height a sheet reported, so a budget change re-clamps
    /// without asking the host again.
    natural: f64,
}

impl DrawerState {
    fn index(&self, name: &str) -> Option<usize> {
        self.tenants.iter().position(|t| t.spec.name == name)
    }

    /// Register a tenant. Re-registering an existing name UPDATES its spec in
    /// place rather than appending a second entry: precedence is positional, so
    /// a duplicate would silently give one tenant two places in the eviction
    /// order.
    pub fn register(&mut self, spec: TenantSpec) {
        if let Some(i) = self.index(&spec.name) {
            self.tenants[i].spec = spec;
            return;
        }
        self.tenants.push(Tenant {
            spec,
            open: false,
            suspended: false,
            dimmed_now: false,
            presentation: 0,
            ctx: Context::None,
        });
    }

    pub fn is_open(&self, name: &str) -> bool {
        self.index(name).is_some_and(|i| self.tenants[i].open)
    }

    pub fn is_suspended(&self, name: &str) -> bool {
        self.index(name).is_some_and(|i| self.tenants[i].suspended)
    }

    /// ONE occupancy test for every tenant (visor.ts:797-801): the teardown is
    /// DRAWER-scoped work, so it asks about the drawer and not about one
    /// session.
    pub fn occupied(&self) -> bool {
        self.tenants.iter().any(|t| t.open)
    }

    pub fn slides(&self) -> &[Slide] {
        &self.slides
    }

    /// The height budget every sheet shares. Measured rather than hardcoded
    /// because the strip wraps to two rows on a phone (visor.ts:2055-2069).
    ///
    /// `ceil` on the strip: a fractional strip height would otherwise leave the
    /// bar hanging a subpixel off the bottom.
    pub fn budget(viewport_height: f64, strip_height: f64) -> f64 {
        (viewport_height - strip_height.ceil() - APP_REVEAL).max(0.0)
    }

    /// Re-measure. Called at every open, at every mount and whenever the host
    /// reports a resize.
    pub fn fit(&mut self, budget: f64) {
        self.sheet_max = budget;
        if self.occupied() && self.natural > 0.0 {
            self.height = self.natural.min(budget);
        }
    }

    // --- the strip's context -------------------------------------------------

    /// PUT THE STRIP BACK IN THE HANDS OF WHOEVER ACTUALLY OWNS IT NOW
    /// (visor.ts:802-819, 2007-2042).
    ///
    /// No caller states what the context should become. Each says only "I am
    /// done", and the answer is recomputed here from what is live — because
    /// every path that ENDS something is deferred in one way or another, so
    /// "something else claimed the strip in the meantime" is not hypothetical.
    ///
    /// A SUSPENDED TENANT IS NOT A CLAIMANT (visor.ts:2014-2033): its session is
    /// alive but its claim is dormant, and naming it here would have the anchor
    /// describe a sheet the user cannot see while the visible one goes unnamed.
    ///
    /// CONTRACT / TRANSLATION LOSS: `VisorConfig.contextOverride` (visor.ts:865)
    /// — the consumer's live component surface, consulted FIRST and described
    /// as "the one tenant that is not the visor's own, which makes mislabelling
    /// it the one error with a victim" — is a closure and has no expression on
    /// `control`. The scan therefore starts at the tenants. See the report.
    pub fn restore_context(&self) -> Vec<Effect> {
        for t in &self.tenants {
            if t.suspended || !t.open {
                continue;
            }
            return vec![Effect::SetContext(t.ctx.clone())];
        }
        vec![Effect::SetContext(Context::None)]
    }

    // --- presentation --------------------------------------------------------

    /// PUT THIS TENANT'S SHEET ON SCREEN and ask the host to build it.
    ///
    /// The one place a slide is mounted: a fresh open (`Up`, growing out of the
    /// bar from zero), a rebuild at a new shape (`Settled`), or an occupant swap
    /// (`Right` for a sheet arriving over a suspended one, `Left` for a
    /// suspended one coming back).
    fn present(&mut self, i: usize, enter: Option<Dir>, effects: &mut Vec<Effect>) {
        let name = self.tenants[i].spec.name.clone();
        self.next_key += 1;
        let key = self.next_key;
        // A new presentation invalidates the previous one's arm timer.
        self.tenants[i].presentation += 1;

        // THE CURRENT OCCUPANT, which is NOT simply the last child: a slide
        // already travelling out is still mounted for the length of its own
        // motion, and a second swap started inside that window would otherwise
        // animate the wrong element (visor.ts:2273-2281).
        let occupant = self.slides.iter().rposition(|s| !s.is_out());
        // Anything already on its way out has been superseded: its travel is
        // over, whatever its timer thinks.
        let keep = occupant;
        let mut n = 0usize;
        self.slides.retain(|s| {
            let this = n;
            n += 1;
            !s.is_out() || Some(this) == keep
        });
        let occupant = self.slides.iter().rposition(|s| !s.is_out());

        match (enter, occupant) {
            (Some(dir), Some(o)) => {
                // OUT OF FLOW for the travel, so the drawer's height animates to
                // the INCOMING sheet's height while both are visible.
                self.slides[o].motion =
                    Motion::Out(if dir == Dir::Right { Dir::Left } else { Dir::Right });
                self.slides[o].offstage = false;
                self.swapping = true;
                self.slides.push(Slide { tenant: name.clone(), key, motion: Motion::In(dir), offstage: true });
                effects.push(Effect::Schedule(Deadline::Swap, SWAP_MS));
            }
            _ => {
                self.slides.clear();
                self.slides.push(Slide { tenant: name.clone(), key, motion: Motion::Settled, offstage: false });
            }
        }
        self.awaiting = Some((name.clone(), key));
        // The sheet itself arrives later: the host cannot render into the
        // guest's tree, so the guest asks and waits for `mount-sheet`
        // (wit/world.wit:149-152).
        effects.push(Effect::Build(name));
    }

    /// One render after a slide appeared off-stage, the direction class comes
    /// off and the transition runs on its removal. Called by `app.rs` from the
    /// effect that follows the render that mounted it.
    pub fn release_offstage(&mut self) -> bool {
        let mut changed = false;
        for s in &mut self.slides {
            if s.offstage {
                s.offstage = false;
                changed = true;
            }
        }
        changed
    }

    /// THE END OF A TRAVEL — `SWAP_MS` after the presentation that started it,
    /// exactly as visor.ts:2303-2307 schedules it.
    ///
    /// ON A TIMER RATHER THAN ON `transitionend`, and the deciding case is
    /// REDUCED MOTION: visor.css:592-608 drops the transform transition
    /// entirely there, so no `transitionend` would ever arrive and the outgoing
    /// slide would stay mounted until the next presentation. visor.css's
    /// discipline is "the swap still HAPPENS — it is a state change, not a
    /// decoration — it simply does not travel", i.e. motion drops and timing
    /// does not, which a timer honours and an animation event cannot. (Two
    /// lesser reasons, both real: `TransitionData` exposes no `property_name`
    /// downstream, so the listener could not tell WHICH property finished; and
    /// `transitionend` bubbles, so a foreign sheet's own arming fade —
    /// `.cred-sheet .cred-row button { transition: opacity 200ms }` — would
    /// have ended the travel early.)
    ///
    /// Idempotent and self-guarded, so a superseded timer is harmless.
    pub fn swap_settled(&mut self) -> bool {
        if !self.slides.iter().any(|s| s.is_out()) && !self.swapping {
            return false;
        }
        self.slides.retain(|s| !s.is_out());
        for s in &mut self.slides {
            s.motion = Motion::Settled;
        }
        self.swapping = false;
        true
    }

    /// THE DEFERRED BLANK: `ARM_MS` after a close, gated on OCCUPANCY rather
    /// than on the session that scheduled it, so it cannot erase a live sheet
    /// belonging to somebody else (visor.ts:2487-2495). Both halves are
    /// visor.ts's verbatim.
    ///
    /// On a timer for the same reduced-motion reason as [`Self::swap_settled`]:
    /// with `transition: none` the height reaches zero with no `transitionend`
    /// at all, and the assembly would stay mounted — leaving `#visor-zone`'s
    /// box-shadow and the strip's top border on over a closed drawer.
    pub fn collapse_settled(&mut self) -> bool {
        if self.occupied() || !self.visible {
            return false;
        }
        self.slides.clear();
        self.visible = false;
        self.swapping = false;
        self.awaiting = None;
        self.natural = 0.0;
        true
    }

    // --- the lifecycle -------------------------------------------------------

    /// Opens (or re-presents) `tenant` with `ctx` on the strip. Returns false
    /// when an exclusive tenant refused it (wit/world.wit:244-245).
    pub fn open(
        &mut self,
        name: &str,
        ctx: Context,
        prefix: &str,
        budget: f64,
    ) -> (bool, Vec<Effect>) {
        let Some(i) = self.index(name) else { return (false, Vec::new()) };
        let mut effects = Vec::new();

        // MUTUAL EXCLUSION. An exclusive tenant holding the drawer refuses every
        // other opener outright (visor.ts:2509-2514).
        for (j, other) in self.tenants.iter().enumerate() {
            if j != i && other.open && other.spec.exclusive {
                return (false, effects);
            }
        }

        // Everything else gives way — in registration (precedence) order, and
        // WITHOUT touching the strip context, which this tenant is about to
        // claim. A SUSPENDABLE tenant gives way without dying.
        //
        // KNOWN WART, PORTED RATHER THAN GUARDED — a PHANTOM "back"
        // (visor.ts:2521-2544). The two branches interact through `close`, which
        // resumes whatever is suspended: if this loop suspends tenant A and then
        // evicts tenant B, B's close finds A waiting and RESUMES it, mid-loop,
        // on behalf of an opener that is about to displace A again — so the user
        // hears "«word»: «A» back" for a sheet that never came back. It needs a
        // tenant configuration no consumer builds (an open non-suspendable,
        // non-exclusive occupant, a suspended suspendable one, and a third
        // opening over both), and the structure is pre-existing: the spurious
        // resume always happened, the announcement only made it perceptible.
        let mut displaced = false;
        for j in 0..self.tenants.len() {
            if j == i || !self.tenants[j].open || self.tenants[j].suspended {
                continue;
            }
            if self.tenants[j].spec.suspendable {
                self.suspend(j, &mut effects);
                displaced = true;
                continue;
            }
            effects.extend(self.close_at(j, CloseReason { restore_context: false }, prefix));
        }

        // Re-entry closes the old session first, so the old sheet's foreign DOM
        // is unmounted before a second one is asked for. visor.ts:2561-2565's
        // CONTRACT note reads the same way: "a second secret-collecting session
        // must not inherit the first one's state".
        if self.tenants[i].open {
            effects.extend(self.close_at(i, CloseReason { restore_context: false }, prefix));
        }

        let t = &mut self.tenants[i];
        t.open = true;
        t.suspended = false;
        t.ctx = ctx.clone();
        let spoken = t.spec.spoken.as_str().to_string();
        let dim = t.spec.dim;
        let name = t.spec.name.clone();

        effects.push(Effect::BeforeShow(name.clone()));
        // Resolved ONCE at open; the close undoes this remembered value.
        self.tenants[i].dimmed_now = dim;
        if dim {
            self.dimmed = true;
        }
        self.visible = true;
        self.sheet_max = budget;
        // The strip names the sheet hanging off it.
        effects.push(Effect::SetContext(ctx));
        // A sheet arriving OVER a suspended occupant enters from the right; one
        // opening into an empty (or evicted) drawer grows up out of the bar.
        self.present(i, displaced.then_some(Dir::Right), &mut effects);
        if !displaced {
            // The reveal animates 0 -> the measured height. Starting from zero
            // is what makes the sheet appear by pushing the real bar down, which
            // is the half of the drawer's story an app cannot forge.
            self.height = 0.0;
        }
        // AFTER the presentation, so the sentence is emitted only once the open
        // has actually succeeded: every refusal path above returned before here,
        // and a listener must not be told a sheet opened that an exclusive
        // occupant turned away (visor.ts:2581-2599).
        effects.push(Effect::Speak(format!("{prefix}: {spoken} open")));
        (true, effects)
    }

    /// SUSPEND: keep the session, give up the drawer. Called by the tenant that
    /// is displacing this one, which owns the travel — the outgoing element only
    /// slides once the incoming sheet is there to slide in over it.
    ///
    /// SILENT: the displacing tenant's own "open" is what tells the user
    /// something new took the drawer (visor.ts:2375-2390, 2586-2591).
    ///
    /// IT DOES UNMOUNT, and that is a DIVERGENCE from the TypeScript, forced by
    /// the seam and verified in the browser. In TypeScript the suspended sheet's
    /// DOM is simply dropped when the swap's timer removes its slide, and
    /// nothing has to be told because nothing outside the visor held a reference
    /// to it. Here the HOST built that sheet and holds it (wit/world.wit:64-73),
    /// and the suspended tenant's `resume` REBUILDS rather than restores
    /// (visor.ts:2392-2396), so the sheet in the outgoing slide is dead the
    /// moment it is suspended. Without this the host would keep a reference to a
    /// detached tree for the life of the session — observed as
    /// `tenant-unmount` never being called for a suspended tenant.
    fn suspend(&mut self, i: usize, effects: &mut Vec<Effect>) {
        let t = &mut self.tenants[i];
        if !t.open || t.suspended {
            return;
        }
        t.suspended = true;
        if t.dimmed_now {
            self.dimmed = false;
            self.tenants[i].dimmed_now = false;
        }
        effects.push(Effect::Unmount(self.tenants[i].spec.name.clone()));
    }

    /// RESUME: the tenant that displaced this one has closed, so the suspended
    /// sheet comes back from the left, REBUILT from its builder — rebuilt, not
    /// restored, because the world moved while it was away (visor.ts:2392-2424).
    fn resume(&mut self, i: usize, prefix: &str, effects: &mut Vec<Effect>) {
        if !self.tenants[i].open || !self.tenants[i].suspended {
            return;
        }
        self.tenants[i].suspended = false;
        self.visible = true;
        let dim = self.tenants[i].spec.dim;
        self.tenants[i].dimmed_now = dim;
        if dim {
            self.dimmed = true;
        }
        // RECOMPUTED, NEVER ASSERTED. A resuming tenant knows what IT is about;
        // it does not know what the strip should say, because something with a
        // stronger claim may have arrived while it was suspended
        // (visor.ts:2404-2415).
        effects.extend(self.restore_context());
        self.present(i, Some(Dir::Left), effects);
        // "back" rather than "open": it is the second half of a displacement the
        // user already heard the first half of.
        let spoken = self.tenants[i].spec.spoken.as_str().to_string();
        effects.push(Effect::Speak(format!("{prefix}: {spoken} back")));
    }

    pub fn close(&mut self, name: &str, reason: CloseReason, prefix: &str) -> Vec<Effect> {
        let Some(i) = self.index(name) else { return Vec::new() };
        self.close_at(i, reason, prefix)
    }

    fn close_at(&mut self, i: usize, reason: CloseReason, prefix: &str) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !self.tenants[i].open {
            return effects;
        }
        let was_suspended = self.tenants[i].suspended;
        let name = self.tenants[i].spec.name.clone();
        let spoken = self.tenants[i].spec.spoken.as_str().to_string();
        self.tenants[i].open = false;
        self.tenants[i].suspended = false;

        effects.push(Effect::BeforeCollapse(name.clone(), reason));
        // A SUSPENDED tenant does not own the drawer, so closing it must not
        // touch the drawer's height, its content, or the dim — all three belong
        // to whoever displaced it (visor.ts:2448-2453).
        if !was_suspended {
            // THE SLIDE HOLDING THE FOREIGN SHEET IS GOING AWAY: the host drops
            // its reference BEFORE the element can be removed, which is the
            // whole of the guest's half of the sheet-slot contract
            // (wit/world.wit:153-154).
            effects.push(Effect::Unmount(name.clone()));
            self.height = 0.0;
            self.natural = 0.0;
            self.awaiting = None;
            // By the REMEMBERED value, not by re-asking.
            if self.tenants[i].dimmed_now {
                self.dimmed = false;
            }
        }
        self.tenants[i].dimmed_now = false;
        effects.push(Effect::AfterCollapse(name.clone(), reason));
        // Ownership-aware, never a bare "set the context to nothing": this close
        // may be running late, and the strip may already belong to somebody else.
        if reason.restore_context && !was_suspended {
            effects.extend(self.restore_context());
        }
        effects.push(Effect::AfterRestore(name.clone(), reason));
        if !was_suspended {
            // SPOKEN ONLY ON THE NON-SUSPENDED PATH, and STRICTLY BEFORE the
            // resume below — the pair that forced `speak` to stop being a bare
            // write to a one-slot live region (visor.ts:2468-2486). Both
            // sentences are emitted in the same activation; see `lib.rs`'s
            // `speak` for how they are made to survive that here.
            effects.push(Effect::Speak(format!("{prefix}: {spoken} closed")));
            if let Some(j) = self.tenants.iter().position(|t| t.open && t.suspended) {
                self.resume(j, prefix, &mut effects);
            }
            // The collapse animates for `ARM_MS`; the drawer is blanked after
            // it, and only if nobody has claimed it meanwhile.
            effects.push(Effect::Schedule(Deadline::Blank, ARM_MS));
        }
        effects
    }

    /// Re-present at a new shape for the same session (wit/world.wit:247-248).
    ///
    /// ARMING IS PER PRESENTATION, which is the rule the demo's collapsed band
    /// needs: a picker armed before a configuration detour must not still be
    /// armed when it re-expands on the user's return (visor.ts:780-784).
    ///
    /// No-op while closed; a SUSPENDED tenant rebuilds when it resumes, from the
    /// same builder, so this is a no-op there too.
    pub fn rebuild(&mut self, name: &str) -> Vec<Effect> {
        let Some(i) = self.index(name) else { return Vec::new() };
        if !self.tenants[i].open || self.tenants[i].suspended {
            return Vec::new();
        }
        let mut effects = Vec::new();
        // The outgoing sheet's foreign DOM goes before the slide holding it is
        // replaced — the same ordering the close path owes the host.
        effects.push(Effect::Unmount(name.to_string()));
        self.present(i, None, &mut effects);
        effects
    }

    /// The host has appended the built sheet root into the live slide and
    /// measured it (wit/world.wit:255-257). This completes the `tenant-build`
    /// round trip and starts the reveal.
    pub fn mount_sheet(&mut self, name: &str, height: f64, budget: f64) -> Vec<Effect> {
        // A `mount-sheet` naming a tenant whose build we are not waiting for is
        // a late answer to a superseded question; the sheet it measured is
        // already gone.
        if self.awaiting.as_ref().is_none_or(|(t, _)| t != name) {
            return Vec::new();
        }
        let Some(i) = self.index(name) else { return Vec::new() };
        if !self.tenants[i].open || self.tenants[i].suspended {
            return Vec::new();
        }
        self.sheet_max = budget;
        self.natural = height.max(0.0);
        // CLAMPED STRUCTURALLY, not only by the sheet's own max-height: the cap
        // has to hold for whatever is in the drawer, and the sheet is not
        // guaranteed to have finished resolving its max-height when it was
        // measured (visor.ts:2144-2148).
        self.height = self.natural.min(budget);

        // THE ARMING DELAY STARTS HERE, which is the moment the sheet first
        // exists on screen. In TypeScript `present` builds, mounts, measures,
        // reveals and starts the timer in one synchronous run (visor.ts:2264-2372);
        // across this boundary the build is a round trip, so `mount-sheet` is
        // where TypeScript's `present` ends and is the faithful start of the
        // 700ms. Anything earlier would be timing a sheet the user cannot see
        // or tap, which would give back part of the delay it exists to spend.
        if self.tenants[i].spec.armed {
            return vec![Effect::Schedule(
                Deadline::Arm {
                    tenant: name.to_string(),
                    presentation: self.tenants[i].presentation,
                },
                ARM_MS,
            )];
        }
        Vec::new()
    }

    /// THE ARMING DELAY ELAPSED. The sheet's controls may go live, and the
    /// embedder is told so.
    ///
    /// GUARDED, NOT TRUSTED — visor.ts:2364's `if (session !== s || suspended)
    /// return`, plus the per-presentation token this port adds because it has
    /// no session object to compare. Three ways a timer can be stale by the
    /// time it fires, and each must arm nothing:
    ///   - the tenant closed while the delay ran;
    ///   - it was suspended out from under the sheet;
    ///   - the sheet was REBUILT, which re-arms from zero — the rule the demo's
    ///     collapsed band needs, so a control armed before a configuration
    ///     detour is not still armed when the user comes back
    ///     (visor.ts:780-784).
    pub fn arm_elapsed(&mut self, tenant: &str, presentation: u64) -> Vec<Effect> {
        let Some(i) = self.index(tenant) else { return Vec::new() };
        let t = &self.tenants[i];
        // `spec.armed` is re-read HERE and not merely trusted from whoever
        // scheduled the wait: a tenant re-registered during the delay may have
        // stopped being an armed one, and `tenant-armed` for a sheet that was
        // never disarmed in the first place is a claim about a control the
        // embedder never held.
        if !t.spec.armed || !t.open || t.suspended || t.presentation != presentation {
            return Vec::new();
        }
        vec![Effect::Armed(tenant.to_string())]
    }

    /// The sheet's content changed size, or the viewport did
    /// (wit/world.wit:258-260).
    pub fn resize_sheet(&mut self, height: f64, budget: f64) {
        if !self.occupied() {
            return;
        }
        self.sheet_max = budget;
        self.natural = height.max(0.0);
        self.height = self.natural.min(budget);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{surface_from_parts, Context};

    fn spec(name: &str) -> TenantSpec {
        TenantSpec {
            name: name.into(),
            spoken: FrameworkText::from(name),
            exclusive: false,
            armed: false,
            dim: false,
            suspendable: false,
        }
    }

    fn host(specs: Vec<TenantSpec>) -> DrawerState {
        let mut d = DrawerState::default();
        for s in specs {
            d.register(s);
        }
        d
    }

    fn ctx(name: &str) -> Context {
        Context::Panel(surface_from_parts(name.into(), "", "", false, None))
    }

    const B: f64 = 500.0;

    fn open(d: &mut DrawerState, name: &str) -> (bool, Vec<Effect>) {
        d.open(name, ctx(name), "walrus", B)
    }

    fn spoken(effects: &[Effect]) -> Vec<&str> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Speak(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn registration_order_is_precedence_order_for_restore() {
        let mut d = host(vec![spec("first"), spec("second")]);
        open(&mut d, "second");
        // Both open at once is not reachable through `open` (the second evicts
        // the first), so the property is asserted through the scan itself.
        assert!(matches!(&d.restore_context()[0], Effect::SetContext(c) if c.same_subject(&ctx("second"))));
        d.tenants[0].open = true;
        d.tenants[0].ctx = ctx("first");
        assert!(
            matches!(&d.restore_context()[0], Effect::SetContext(c) if c.same_subject(&ctx("first"))),
            "the earlier registration wins the scan"
        );
    }

    #[test]
    fn a_suspended_tenant_is_not_a_claimant_for_the_strip() {
        let mut d = host(vec![
            TenantSpec { suspendable: true, ..spec("settings") },
            spec("erase"),
        ]);
        open(&mut d, "settings");
        open(&mut d, "erase");
        assert!(d.is_suspended("settings"));
        // Registration order would give "settings" the strip; suspension takes
        // its claim away, which is the whole of visor.ts:2014-2033.
        assert!(
            matches!(&d.restore_context()[0], Effect::SetContext(c) if c.same_subject(&ctx("erase")))
        );
    }

    #[test]
    fn an_exclusive_tenant_refuses_every_other_open() {
        let mut d = host(vec![TenantSpec { exclusive: true, ..spec("creds") }, spec("naming")]);
        assert!(open(&mut d, "creds").0);
        let (ok, effects) = open(&mut d, "naming");
        assert!(!ok, "the exclusive occupant refused it");
        assert!(effects.is_empty(), "a refusal does nothing at all");
        assert!(d.is_open("creds") && !d.is_open("naming"));
        // And its own open evicts everything else.
        d.close("creds", CloseReason { restore_context: true }, "walrus");
        d.collapse_settled();
        assert!(open(&mut d, "naming").0);
        assert!(open(&mut d, "creds").0);
        assert!(!d.is_open("naming"), "the exclusive open evicted it");
    }

    #[test]
    fn an_ordinary_tenant_closes_and_a_suspendable_one_suspends() {
        let mut d = host(vec![spec("plain"), TenantSpec { suspendable: true, ..spec("band") }]);
        open(&mut d, "plain");
        open(&mut d, "band");
        assert!(!d.is_open("plain"), "not suspendable: closed outright");

        let mut d = host(vec![TenantSpec { suspendable: true, ..spec("band") }, spec("over")]);
        open(&mut d, "band");
        open(&mut d, "over");
        assert!(d.is_open("band") && d.is_suspended("band"), "session kept, drawer lost");
    }

    #[test]
    fn eviction_runs_in_registration_order() {
        let mut d = host(vec![spec("a"), spec("b"), spec("c")]);
        // Force two occupants so the order of the eviction sweep is observable.
        open(&mut d, "a");
        d.tenants[1].open = true;
        d.tenants[1].ctx = ctx("b");
        let (_, effects) = open(&mut d, "c");
        let collapsed: Vec<&str> = effects
            .iter()
            .filter_map(|e| match e {
                Effect::BeforeCollapse(n, _) => Some(n.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(collapsed, ["a", "b"]);
    }

    #[test]
    fn a_displacement_swaps_and_the_close_brings_the_occupant_back() {
        let mut d = host(vec![TenantSpec { suspendable: true, ..spec("band") }, spec("over")]);
        open(&mut d, "band");
        d.mount_sheet("band", 200.0, B);
        assert_eq!(d.height, 200.0);

        let (_, effects) = open(&mut d, "over");
        assert_eq!(d.slides().len(), 2, "both occupants are mounted for the travel");
        assert_eq!(d.slides()[0].motion, Motion::Out(Dir::Left), "the occupant leaves left");
        assert_eq!(d.slides()[1].motion, Motion::In(Dir::Right), "the arrival comes from the right");
        assert!(d.swapping);
        assert_eq!(spoken(&effects), ["walrus: over open"], "suspend is silent");

        // The out-of-flow slide contributes no height, so the drawer aims at the
        // arriving sheet.
        d.mount_sheet("over", 320.0, B);
        assert_eq!(d.height, 320.0);
        d.swap_settled();
        assert_eq!(d.slides().len(), 1);

        let effects = d.close("over", CloseReason { restore_context: true }, "walrus");
        assert_eq!(
            spoken(&effects),
            ["walrus: over closed", "walrus: band back"],
            "closed strictly before back, and both in one activation"
        );
        assert!(!d.is_suspended("band") && d.is_open("band"));
        assert_eq!(d.slides()[1].motion, Motion::In(Dir::Left), "it returns from the left");
        // Rebuilt, not restored: the world moved while it was away.
        assert!(effects.contains(&Effect::Build("band".into())));
    }

    /// The host holds the sheet it built; a suspended tenant's sheet is dead
    /// (its resume rebuilds), so the reference has to be dropped even though no
    /// slide is removed yet.
    #[test]
    fn suspension_unmounts_the_sheet_the_host_is_holding() {
        let mut d = host(vec![TenantSpec { suspendable: true, ..spec("band") }, spec("over")]);
        open(&mut d, "band");
        d.mount_sheet("band", 200.0, B);
        let (_, effects) = open(&mut d, "over");
        assert!(effects.contains(&Effect::Unmount("band".into())));
        let unmount = effects.iter().position(|e| *e == Effect::Unmount("band".into())).unwrap();
        let build = effects.iter().position(|e| *e == Effect::Build("over".into())).unwrap();
        assert!(unmount < build, "dropped before the drawer is asked for another sheet");
    }

    #[test]
    fn closing_a_suspended_tenant_touches_neither_the_drawer_nor_the_dim() {
        let mut d = host(vec![
            TenantSpec { suspendable: true, dim: true, ..spec("band") },
            TenantSpec { dim: true, ..spec("over") },
        ]);
        open(&mut d, "band");
        open(&mut d, "over");
        d.mount_sheet("over", 300.0, B);
        assert!(d.dimmed);

        let effects = d.close("band", CloseReason { restore_context: true }, "walrus");
        assert!(d.dimmed, "the dim belongs to whoever displaced it");
        assert_eq!(d.height, 300.0, "so does the height");
        assert!(spoken(&effects).is_empty(), "nothing a listener can perceive happened");
        assert!(!effects.iter().any(|e| matches!(e, Effect::Unmount(_))), "no sheet of its own on screen");
        // And now nothing comes back when the ceremony over it closes.
        let effects = d.close("over", CloseReason { restore_context: true }, "walrus");
        assert_eq!(spoken(&effects), ["walrus: over closed"]);
        assert!(!d.dimmed);
    }

    #[test]
    fn the_dim_is_undone_by_the_remembered_value() {
        let mut d = host(vec![TenantSpec { dim: true, ..spec("erase") }]);
        open(&mut d, "erase");
        assert!(d.dimmed);
        // The spec flipping under a live sheet must not change what the close
        // undoes: the resolved value is the tenant's, not the spec's.
        d.register(TenantSpec { dim: false, ..spec("erase") });
        d.close("erase", CloseReason { restore_context: true }, "walrus");
        assert!(!d.dimmed, "the undo matched the do");
    }

    #[test]
    fn the_foreign_sheet_is_unmounted_before_its_slide_can_go() {
        let mut d = host(vec![spec("sheet")]);
        open(&mut d, "sheet");
        d.mount_sheet("sheet", 100.0, B);
        let effects = d.close("sheet", CloseReason { restore_context: true }, "walrus");
        let unmount = effects.iter().position(|e| *e == Effect::Unmount("sheet".into()));
        assert!(unmount.is_some(), "the host must be told to drop its reference");
        assert!(!d.slides().is_empty(), "the slide survives the collapse animation");
        assert!(d.collapse_settled(), "and goes when the collapse lands");
        assert!(d.slides().is_empty() && !d.visible);
    }

    #[test]
    fn the_close_lifecycle_runs_in_the_documented_order() {
        let mut d = host(vec![spec("sheet")]);
        open(&mut d, "sheet");
        let reason = CloseReason { restore_context: true };
        let effects = d.close("sheet", reason, "walrus");
        let order: Vec<&str> = effects
            .iter()
            .map(|e| match e {
                Effect::BeforeCollapse(..) => "before-collapse",
                Effect::AfterCollapse(..) => "after-collapse",
                Effect::AfterRestore(..) => "after-restore",
                Effect::SetContext(_) => "restore-context",
                Effect::Unmount(_) => "unmount",
                Effect::Speak(_) => "speak",
                Effect::Schedule(Deadline::Blank, _) => "schedule-blank",
                _ => "other",
            })
            .collect();
        assert_eq!(
            order,
            [
                "before-collapse",
                "unmount",
                "after-collapse",
                "restore-context",
                "after-restore",
                "speak",
                // LAST, and after the resume: the blank is drawer-scoped work
                // that must not run until everything this close might hand the
                // drawer to has had its turn.
                "schedule-blank"
            ]
        );
    }

    #[test]
    fn a_close_without_context_leaves_the_strip_alone() {
        let mut d = host(vec![spec("sheet")]);
        open(&mut d, "sheet");
        let effects = d.close("sheet", CloseReason { restore_context: false }, "walrus");
        assert!(!effects.iter().any(|e| matches!(e, Effect::SetContext(_))));
    }

    #[test]
    fn the_height_budget_keeps_a_band_of_app_visible() {
        assert_eq!(DrawerState::budget(800.0, 60.4), 800.0 - 61.0 - APP_REVEAL);
        assert_eq!(DrawerState::budget(40.0, 60.0), 0.0, "never negative");

        let mut d = host(vec![spec("tall")]);
        open(&mut d, "tall");
        d.mount_sheet("tall", 5_000.0, 400.0);
        assert_eq!(d.height, 400.0, "clamped structurally, not only by the sheet's max-height");
        assert_eq!(d.sheet_max, 400.0);
        // A viewport change re-clamps from the remembered natural height.
        d.fit(200.0);
        assert_eq!(d.height, 200.0);
        d.fit(9_000.0);
        assert_eq!(d.height, 5_000.0);
    }

    #[test]
    fn a_stale_mount_is_dropped() {
        let mut d = host(vec![spec("a"), spec("b")]);
        open(&mut d, "a");
        open(&mut d, "b");
        // "a" was evicted; a late measurement of its sheet must not aim the
        // drawer at a sheet that is gone.
        d.mount_sheet("a", 999.0, B);
        assert_eq!(d.height, 0.0);
        d.mount_sheet("b", 120.0, B);
        assert_eq!(d.height, 120.0);
    }

    #[test]
    fn the_reveal_starts_from_zero() {
        let mut d = host(vec![spec("a")]);
        open(&mut d, "a");
        assert_eq!(d.height, 0.0, "0 -> measured, never auto -> measured");
        assert!(d.visible);
        d.mount_sheet("a", 180.0, B);
        assert_eq!(d.height, 180.0);
    }

    /// The token a `mount-sheet` schedules its arm against.
    fn arm_deadline(effects: &[Effect]) -> (String, u64) {
        effects
            .iter()
            .find_map(|e| match e {
                Effect::Schedule(Deadline::Arm { tenant, presentation }, ms) => {
                    assert_eq!(*ms, ARM_MS, "the arming delay is ARM_MS and nothing else");
                    Some((tenant.clone(), *presentation))
                }
                _ => None,
            })
            .expect("an armed tenant schedules its arm at mount")
    }

    /// THE DELAY IS A SECURITY CONTROL, so the thing worth pinning is that
    /// `tenant-armed` is NOT emitted at mount — an armed sheet whose controls
    /// are live immediately has silently lost the defence while still looking
    /// ported.
    #[test]
    fn arming_is_deferred_and_never_announced_at_mount() {
        let mut d = host(vec![TenantSpec { armed: true, ..spec("creds") }]);
        open(&mut d, "creds");
        let at_mount = d.mount_sheet("creds", 200.0, B);
        assert!(
            !at_mount.iter().any(|e| matches!(e, Effect::Armed(_))),
            "the sheet is on screen; its controls are not yet live"
        );
        let (tenant, presentation) = arm_deadline(&at_mount);
        assert_eq!(d.arm_elapsed(&tenant, presentation), [Effect::Armed("creds".into())]);
    }

    /// An UNARMED tenant pays no delay at all: arming defends secret entry, and
    /// paying the tax where nothing secret is typed would train users to click
    /// through a delay that means something elsewhere (visor.ts:703-707).
    #[test]
    fn an_unarmed_tenant_schedules_nothing() {
        let mut d = host(vec![spec("naming")]);
        open(&mut d, "naming");
        let effects = d.mount_sheet("naming", 120.0, B);
        assert!(!effects.iter().any(|e| matches!(e, Effect::Schedule(Deadline::Arm { .. }, _))));
        assert!(d.arm_elapsed("naming", 1).is_empty(), "and nothing arms it late either");
    }

    /// The three ways a timer can be stale when it fires. Each must arm nothing
    /// — visor.ts:2364's guard, plus the presentation token this port needs
    /// because it has no session object to compare.
    #[test]
    fn a_stale_arm_timer_arms_nothing() {
        // (a) closed while the delay ran.
        let mut d = host(vec![TenantSpec { armed: true, ..spec("creds") }]);
        open(&mut d, "creds");
        let (t, p) = arm_deadline(&d.mount_sheet("creds", 200.0, B));
        d.close("creds", CloseReason { restore_context: true }, "walrus");
        assert!(d.arm_elapsed(&t, p).is_empty(), "closed");

        // (b) suspended out from under the sheet.
        let mut d = host(vec![
            TenantSpec { armed: true, suspendable: true, ..spec("band") },
            spec("over"),
        ]);
        open(&mut d, "band");
        let (t, p) = arm_deadline(&d.mount_sheet("band", 200.0, B));
        open(&mut d, "over");
        assert!(d.is_suspended("band"));
        assert!(d.arm_elapsed(&t, p).is_empty(), "suspended");

        // (c) never registered.
        assert!(d.arm_elapsed("nobody", 1).is_empty());
    }

    #[test]
    fn a_rebuild_re_asks_for_the_sheet_and_re_arms_from_zero() {
        let mut d = host(vec![TenantSpec { armed: true, ..spec("picker") }]);
        open(&mut d, "picker");
        let (t, first) = arm_deadline(&d.mount_sheet("picker", 200.0, B));
        let effects = d.rebuild("picker");
        assert!(effects.contains(&Effect::Build("picker".into())));
        assert!(effects.contains(&Effect::Unmount("picker".into())));

        // ARMING IS PER PRESENTATION: a control the user armed before a
        // configuration detour must not still be armed when they return, so the
        // older timer is dead and the rebuilt sheet gets its own full delay.
        let (_, second) = arm_deadline(&d.mount_sheet("picker", 90.0, B));
        assert_ne!(first, second, "a rebuild is a new presentation");
        assert!(d.arm_elapsed(&t, first).is_empty(), "the pre-detour timer arms nothing");
        assert_eq!(d.arm_elapsed(&t, second), [Effect::Armed("picker".into())]);
        assert_eq!(d.height, 90.0);
    }

    /// A resume is a fresh presentation too, so a sheet coming back from a
    /// displacement re-arms rather than returning already armed.
    #[test]
    fn a_resumed_sheet_re_arms_from_zero() {
        let mut d = host(vec![
            TenantSpec { armed: true, suspendable: true, ..spec("band") },
            spec("over"),
        ]);
        open(&mut d, "band");
        let (t, before) = arm_deadline(&d.mount_sheet("band", 200.0, B));
        open(&mut d, "over");
        d.close("over", CloseReason { restore_context: true }, "walrus");
        let (_, after) = arm_deadline(&d.mount_sheet("band", 200.0, B));
        assert_ne!(before, after);
        assert!(d.arm_elapsed(&t, before).is_empty());
        assert_eq!(d.arm_elapsed(&t, after), [Effect::Armed("band".into())]);
    }

    /// The deferred blank is gated on OCCUPANCY, not on the session that
    /// scheduled it: another tenant may have claimed the drawer while the
    /// collapse ran, and blanking then would erase a live sheet.
    #[test]
    fn a_late_blank_cannot_erase_a_live_sheet() {
        let mut d = host(vec![spec("first"), spec("second")]);
        open(&mut d, "first");
        d.mount_sheet("first", 200.0, B);
        let effects = d.close("first", CloseReason { restore_context: true }, "walrus");
        assert!(effects.contains(&Effect::Schedule(Deadline::Blank, ARM_MS)));
        // Somebody claims the drawer before the timer lands.
        open(&mut d, "second");
        d.mount_sheet("second", 150.0, B);
        assert!(!d.collapse_settled(), "occupied: the blank declines");
        assert_eq!(d.slides().len(), 1);
        assert!(d.visible);
        // And once it really is empty, it lands.
        d.close("second", CloseReason { restore_context: true }, "walrus");
        assert!(d.collapse_settled());
        assert!(!d.visible && d.slides().is_empty());
    }

    /// A travel schedules its own end, at the duration visor.css pairs with.
    #[test]
    fn a_travel_schedules_its_own_end() {
        let mut d = host(vec![TenantSpec { suspendable: true, ..spec("band") }, spec("over")]);
        open(&mut d, "band");
        let (_, effects) = open(&mut d, "over");
        assert!(effects.contains(&Effect::Schedule(Deadline::Swap, SWAP_MS)));
        assert_eq!(d.slides().len(), 2);
        assert!(d.swap_settled());
        assert_eq!(d.slides().len(), 1);
        assert_eq!(d.slides()[0].motion, Motion::Settled);
        assert!(!d.swapping);
        assert!(!d.swap_settled(), "idempotent: a second, superseded timer does nothing");
    }

    #[test]
    fn a_rebuild_is_a_no_op_while_closed_or_suspended() {
        let mut d = host(vec![TenantSpec { suspendable: true, ..spec("band") }, spec("over")]);
        assert!(d.rebuild("band").is_empty(), "closed");
        open(&mut d, "band");
        open(&mut d, "over");
        assert!(d.rebuild("band").is_empty(), "suspended: it rebuilds when it resumes");
        assert!(d.rebuild("nobody").is_empty(), "unregistered");
    }

    #[test]
    fn a_superseded_travel_is_dropped_rather_than_animating_the_wrong_element() {
        let mut d = host(vec![
            TenantSpec { suspendable: true, ..spec("a") },
            TenantSpec { suspendable: true, ..spec("b") },
            spec("c"),
        ]);
        open(&mut d, "a");
        open(&mut d, "b");
        assert_eq!(d.slides().len(), 2);
        // A second swap inside the first one's window.
        open(&mut d, "c");
        assert_eq!(d.slides().len(), 2, "the superseded outgoing slide is gone");
        assert_eq!(d.slides()[0].tenant, "b", "the real occupant is the one that travels");
        assert_eq!(d.slides()[1].tenant, "c");
    }

    #[test]
    fn re_opening_a_live_tenant_unmounts_the_old_sheet_first() {
        let mut d = host(vec![spec("sheet")]);
        open(&mut d, "sheet");
        d.mount_sheet("sheet", 100.0, B);
        let (ok, effects) = open(&mut d, "sheet");
        assert!(ok);
        let unmount = effects.iter().position(|e| *e == Effect::Unmount("sheet".into()));
        let build = effects.iter().position(|e| *e == Effect::Build("sheet".into()));
        assert!(unmount < build, "the host drops its reference before it is asked for another");
    }

    #[test]
    fn a_slide_never_reuses_its_key_across_two_sheets() {
        let mut d = host(vec![spec("a"), spec("b")]);
        open(&mut d, "a");
        let first = d.slides()[0].key;
        open(&mut d, "b");
        assert_ne!(d.slides()[0].key, first);
    }
}
