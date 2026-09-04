//! THE VISOR'S PIXELS. Every element the strip and the drawer are made of,
//! rendered by the guest into its mount root.
//!
//! # The DOM contract
//!
//! `visor/ui/visor.css` is the authority and it is not this crate's to change:
//! every selector in it must match what is rendered here. The ids are part of
//! the trust model — "the visor's pixels" is a claim about NAMED elements a
//! component cannot reach — which is why moving them out of each consumer's
//! `index.html` and into the component is half the point of the port
//! (wit/world.wit:23-30): the ids become one definition rather than one per
//! consumer page, and a trust anchor duplicated across consumer HTML is a trust
//! anchor each consumer can get wrong.
//!
//! ```text
//! #visor-zone
//!   #visor-drawer [hidden when closed]        --visor-bg, --visor-sheet-max
//!     #visor-drawer-inner                     inline height px, 0 <-> measured
//!       .visor-slide                          A LEAF — see below
//!   #visor-strip                              --visor-bg
//!     .bar-inner
//!       #visor-back        (optional, FIRST child)
//!       #visor-context     > .ctx-top, .ctx-bottom
//!       #visor-identity    > .id-lines > .who, .who.device;  #visor-settings > .visor-badge
//!       #visor-live
//! #visor-dim [hidden when not dimming]
//! ```
//!
//! # `--visor-bg` GOES ON `#visor-strip` AND `#visor-drawer` ONLY
//!
//! Never on `:root`, never on the document element. This is check (c) of
//! `demo/scripts/check-invariants.sh` and it is a security property, not a style
//! preference: a custom property on the document root is ambient authority — it
//! inherits into every app region, so a component that ever gained a `style`
//! attribute could paint the visor's exact colour without ever reading it
//! (visor.ts:94-110). A guest cannot reach the document element through
//! `polymorph:dioxus` at all, which makes the invariant structural here rather
//! than merely observed; the two `style=` sites below are the whole of it.
//!
//! # `.visor-slide` IS A LEAF, AND THAT IS THE SHEET-SLOT CONTRACT
//!
//! Drawer sheets are built by TypeScript and handed over as live DOM; they are
//! not part of this tree. The renderer's applier walks template paths by CHILD
//! INDEX (`polyengine-dioxus/host/src/applier.ts:194-204`, `#loadChild`), so a
//! foreign child interleaved among guest-rendered siblings would corrupt
//! addressing — the guest would ask for "the second child" and get the host's
//! sheet. The slide therefore has NO children in this tree: no text, no
//! conditional, no dynamic node. Everything that varies about it varies through
//! ATTRIBUTES (`class`), which the applier addresses by ElementId and not by
//! path.
//!
//! What is safe, and worth writing down because it is the non-obvious half:
//! `#visor-drawer-inner`'s own children ARE addressed by path when the slide
//! list goes empty and Dioxus materialises a placeholder — but every one of
//! those children is a guest-rendered slide, and the foreign DOM sits one level
//! further down, INSIDE a slide. The applier never walks into it.
//!
//! The remaining hazard is NODE REUSE: if Dioxus reused a slide element for a
//! different tenant's sheet, the incoming foreign root would be appended beside
//! the outgoing one. `Slide::key` is bumped on every presentation to forbid
//! that, and `embedder.tenant-unmount` is emitted before any path that can drop
//! a slide (`drawer.rs`'s `close_at` and `rebuild`).
//!
//! It also means the slide carries no `transitionend` listener: a bubbling
//! transition from the foreign sheet inside it (`.cred-sheet .cred-row button`
//! fades over 200ms while arming) is indistinguishable from the slide's own
//! travel, because `TransitionData` exposes no `property_name` downstream. The
//! travel is timed instead; see `drawer.rs`.

use dioxus::prelude::*;

use crate::component::{dispatching_target, install_live, with_visor, Visor};
use crate::drawer::{Dir, Motion, Slide};
use crate::state::identity_face;
use crate::state::visor_bg;

/// The class list one slide wears, spelled once. The vocabulary is
/// visor.css:553-608's and nothing here may invent a member of it.
fn slide_class(slide: &Slide) -> &'static str {
    match (slide.motion, slide.offstage) {
        (Motion::Settled, _) => "visor-slide",
        // Start off-stage, then release on the next render: the class REMOVAL
        // is what the transition runs on (visor.ts:2298-2302).
        (Motion::In(Dir::Right), true) => "visor-slide visor-swap-in from-right",
        (Motion::In(Dir::Left), true) => "visor-slide visor-swap-in from-left",
        (Motion::In(_), false) => "visor-slide visor-swap-in",
        (Motion::Out(Dir::Left), _) => "visor-slide visor-swap-out to-left",
        (Motion::Out(Dir::Right), _) => "visor-slide visor-swap-out to-right",
    }
}

/// The anchor colour, scoped to one element. `None` while unclaimed, so the
/// element wears visor.css's zero-chroma grey FALLBACK and the claim reads as
/// the arrival of colour rather than as a shade changing (visor.css:92-108).
fn hue_style(hue: Option<u16>, extra: &str) -> Option<String> {
    let mut out = String::new();
    if let Some(hue) = hue {
        out.push_str(&format!("--visor-bg: {}; --visor-fg: #f4f6fc;", visor_bg(hue)));
    }
    out.push_str(extra);
    (!out.is_empty()).then_some(out)
}

#[allow(non_snake_case)]
pub fn App() -> Element {
    let visor = use_hook(|| {
        let signal = Signal::new(Visor::boot());
        install_live(signal);
        signal
    });

    // Read once, and clone out everything the rsx below needs: the handlers are
    // `move` closures that outlive this borrow, and they reach the live state
    // through `with_visor` at click time rather than capturing a snapshot of it
    // (the same reason `backAction` is read at CLICK TIME in visor.ts:1300-1303
    // — a consumer may replace the destination without the control flickering
    // out and back).
    let v = visor.read();
    let hue = v.hue;
    let claimed = v.claimed;
    let live_text = v.live.clone();
    let pulsing = v.pulsing;
    let back = v.back.clone();
    let ctx = v.context.clone();
    let announcement = v.announcement.clone();
    let identity = v.identity.clone();
    let badge_lit = v.badge_lit();
    let settings_label = v.settings_label();
    let drawer_visible = v.drawer.visible;
    let drawer_height = v.drawer.height;
    let sheet_max = v.drawer.sheet_max;
    let swapping = v.drawer.swapping;
    let dimmed = v.drawer.dimmed;
    let slides: Vec<Slide> = v.drawer.slides().to_vec();
    drop(v);

    let sheet = ctx.sheet_is_open();
    let surface = ctx.top_surface().cloned();
    let tappable = ctx.is_tappable();
    let lead = ctx.sheet_lead();

    rsx! {
        // PINNED, and the whole assembly rides one sticky box: the sheet hangs
        // ABOVE the strip, so both must be in the same pinned element or the
        // sheet could be scrolled away from the bar it hangs off
        // (visor.css:83-91).
        div { id: "visor-zone",

            // --- the drawer -------------------------------------------------
            div {
                id: "visor-drawer",
                hidden: !drawer_visible,
                // `--visor-sheet-max` is the measured viewport-minus-strip
                // budget the sheets' own `max-height` resolves against
                // (visor.css:699-716). It rides here with the anchor colour
                // because both are drawer-scoped and neither may be ambient.
                style: hue_style(hue, &format!(" --visor-sheet-max: {sheet_max}px;")),

                div {
                    id: "visor-drawer-inner",
                    class: if swapping { "swapping" } else { "" },
                    // A PIXEL HEIGHT, NEVER `auto`: `auto` is not interpolable
                    // against a length, so per CSS Transitions a running height
                    // transition would be CANCELLED and the drawer would snap to
                    // full height instead of animating (visor.css:511-520,
                    // visor.ts:2126-2148).
                    style: "height: {drawer_height}px;",
                    // NO `ontransitionend` HERE, and that is a decision rather
                    // than an omission. The two deferred teardowns this element
                    // would be the natural signal for — the blank after a close
                    // and the end of a travel — are on visor.ts's own timers
                    // instead (`drawer.rs`'s `ARM_MS`/`SWAP_MS`). Reduced motion
                    // is what decides it: visor.css:550-552 and :592-608 set
                    // `transition: none`, so under it no event would EVER
                    // arrive and the assembly would stay mounted at zero height
                    // with `#visor-zone`'s box-shadow still on. "Motion drops,
                    // timing does not" is the stylesheet's own rule (:588-591),
                    // and only a clock can keep it.

                    for slide in slides.iter() {
                        // THE LEAF. No children, ever — see this module's
                        // header. `key` is per PRESENTATION, so a slide node is
                        // never reused across two sheets.
                        div {
                            key: "{slide.key}",
                            class: slide_class(slide),
                            // The reflow TypeScript forces with an `offsetWidth`
                            // read (visor.ts:2301) is a render turn here: the
                            // slide mounts wearing its direction class, and this
                            // is the signal that it is safe to take off.
                            onmounted: move |_| {
                                with_visor(|v| v.drawer.release_offstage());
                            },
                        }
                    }
                }
            }

            // --- the strip --------------------------------------------------
            //
            // THE ONE REGION AN APP CAN NEVER PAINT, so it is where identity
            // lives. Its background is the user's own colour: randomised on
            // first run, changeable, and never disclosed to app code
            // (visor.css:76-91).
            div {
                id: "visor-strip",
                style: hue_style(hue, ""),
                // The strip is a GUEST-RENDERED element, so `dom.get-client-rect`
                // can measure it — which is the half of the drawer's height
                // budget the guest owns (wit/world.wit:57-61). The id arrives
                // here and nowhere else; see `component::EVENT_TARGET`.
                onmounted: move |_| {
                    let id = dispatching_target();
                    with_visor(|v| v.strip_id = Some(id));
                },

                div { class: "bar-inner",

                    // THE BACK CHEVRON, FIRST CHILD. `.bar-inner` is the one
                    // strip element no render cycle clears, which is the
                    // behaviour the control has to have: its presence means "you
                    // are in a nested place", a fact about WHERE the user is and
                    // not about what the strip currently says — a control that
                    // blinked out during an announcement would be a promise that
                    // lapses (visor.ts:1275-1297). Here that is structural: the
                    // chevron is a sibling of `#visor-context`, so neither the
                    // context re-render nor an announcement can reach it.
                    //
                    // NULL RENDERS NOTHING AT ALL — no disabled button, no empty
                    // slot. An affordance that is present but inert teaches the
                    // user to distrust the ones that are present and live.
                    if let Some(back) = back.as_ref() {
                        button {
                            id: "visor-back",
                            r#type: "button",
                            // THE VISOR'S OWN WORDING, always: framework voice,
                            // may embed the user's vocabulary, never a
                            // component's — and never rendered as TEXT beside
                            // the glyph (visor.ts:510-516).
                            title: "{back.label.as_str()}",
                            "aria-label": "{back.label.as_str()}",
                            onclick: move |_| crate::component::report_back(),
                            // U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK.
                            // A single BMP scalar with text presentation by
                            // default and coverage in every legacy font, which
                            // is what the pet-icon curation rules demand of any
                            // glyph in the visor's own pixels (visor.ts:1315-1330).
                            "\u{2039}"
                        }
                    }

                    // LEFT CLUSTER — two lines, ordered by WHOSE QUESTION THEY
                    // ANSWER: the user's recognition pair above, the
                    // component's claims and the visor's status below
                    // (visor.css:169-190).
                    div {
                        id: "visor-context",
                        class: if pulsing { "pulse" } else { "" },
                        // THE CLUSTER IS ONE TAP TARGET, opening the visor's App
                        // settings sheet for the surface both its lines are
                        // about. Offered only where it would not displace a
                        // ceremony the user is already in — `Context::is_tappable`
                        // carries that argument.
                        role: if tappable { Some("button") } else { None },
                        tabindex: if tappable { Some("0") } else { None },
                        title: if tappable { Some("app settings for this component") } else { None },
                        onclick: {
                            let surface = surface.clone();
                            move |_| {
                                if tappable {
                                    if let Some(s) = surface.as_ref() {
                                        crate::component::report_naming(s);
                                    }
                                }
                            }
                        },
                        onkeydown: {
                            let surface = surface.clone();
                            move |e: KeyboardEvent| {
                                if !tappable || !is_activation(&e) {
                                    return;
                                }
                                // Space is prevented from scrolling the page out
                                // from under the ceremony it is about to open.
                                if e.key() == Key::Character(" ".into()) {
                                    e.prevent_default();
                                }
                                if let Some(s) = surface.as_ref() {
                                    crate::component::report_naming(s);
                                }
                            }
                        },
                        // THE PULSE ends on its own `animationend`, guarded by
                        // target exactly as visor.ts:1900-1902 guards it: the
                        // event BUBBLES, so an animation ending on a child must
                        // not cut the pulse short.
                        onanimationend: move |_| {
                            with_visor(|v| v.pulsing = false);
                        },

                        div { class: "ctx-top",
                            if let Some(surface) = surface.as_ref() {
                                // THE PET ICON, or nothing. An UNMARKED surface
                                // renders NO glyph: before the user has said
                                // anything about this component the visor has
                                // nothing of its own to say either, and a
                                // placeholder in the visor's pixels would be the
                                // visor speaking first (visor.ts:1571-1577).
                                if let Some(icon) = surface.icon {
                                    {icon.render()}
                                }
                                if let Some(pet) = surface.petname.as_ref() {
                                    span {
                                        class: if sheet { "petname" } else { "petname clickable" },
                                        role: if sheet { None } else { Some("button") },
                                        tabindex: if sheet { None } else { Some("0") },
                                        title: if sheet { None } else { Some("app settings: rename, re-mark, forget") },
                                        onclick: {
                                            let surface = surface.clone();
                                            move |e: MouseEvent| {
                                                if sheet { return }
                                                // The whole cluster is a tap
                                                // target too; this inner one
                                                // stops the event so one gesture
                                                // is one opening.
                                                e.stop_propagation();
                                                crate::component::report_naming(&surface);
                                            }
                                        },
                                        // A control that announces itself as a
                                        // button to assistive tech must BE one:
                                        // Enter and Space activate it, exactly
                                        // as they would a real <button>
                                        // (visor.ts:1597-1606).
                                        onkeydown: {
                                            let surface = surface.clone();
                                            move |e: KeyboardEvent| {
                                                if sheet || !is_activation(&e) { return }
                                                if e.key() == Key::Character(" ".into()) {
                                                    e.prevent_default();
                                                }
                                                e.stop_propagation();
                                                crate::component::report_naming(&surface);
                                            }
                                        },
                                        "{pet.as_str()}"
                                    }
                                }
                                // THE TOFU MOMENT is the one worth interrupting
                                // for: recognition marks mean nothing the first
                                // time, and the first time is when impersonation
                                // would land. NEW sits beside the offer it
                                // motivates (visor.ts:1615-1625).
                                if surface.is_new && !sheet {
                                    span { class: "fresh", "NEW — first time this component draws here" }
                                }
                                if surface.petname.is_none() && !sheet {
                                    // The visor's own control, in the visor's own
                                    // pixels: the offer to stop relying on what
                                    // the component says about itself.
                                    button {
                                        id: "visor-name-it",
                                        r#type: "button",
                                        title: "give this component your own name",
                                        onclick: {
                                            let surface = surface.clone();
                                            move |e: MouseEvent| {
                                                e.stop_propagation();
                                                crate::component::report_naming(&surface);
                                            }
                                        },
                                        "name it"
                                    }
                                }
                            }
                        }

                        // THE BOTTOM LINE: claims and status. An announcement
                        // REPLACES this whole line for its window, and the line
                        // then comes back by RE-RENDERING from the live context
                        // — never by restoring a saved string, because what
                        // belongs there may have changed underneath
                        // (visor.ts:933-943). That is free here: there is no
                        // saved string anywhere, only `Visor::context`.
                        div { class: "ctx-bottom",
                            if let Some(said) = announcement.as_ref() {
                                // FRAMEWORK VOICE at full strength: `said
                                // announce`, so the explicit `opacity: 1` undoes
                                // `.said`'s muting, which is for standing
                                // commentary and not for a line that arrived
                                // just now (visor.css:348-364).
                                span { class: "said announce", "{said.as_str()}" }
                            } else {
                                // While a visor sheet is open the strip NAMES it,
                                // so "which pixels am I typing into" has a
                                // visor-side answer.
                                if let Some(lead) = lead {
                                    span { class: "said", "{lead}" }
                                }
                                if let Some(surface) = surface.as_ref() {
                                    // APP VOICE, and the only way to render it:
                                    // `AppVoice::render` is the single site in
                                    // the crate that names the `foreign` class,
                                    // and the string is not reachable any other
                                    // way. A component that declares nothing gets
                                    // nothing quoted — an empty token would be a
                                    // bare plate with quote marks, punctuation
                                    // standing for a claim nobody made.
                                    if !surface.nickname.is_empty() {
                                        {surface.nickname.render()}
                                    }
                                }
                            }
                        }
                    }

                    // THE IDENTITY CLUSTER. Nothing here is ever handed to a
                    // component, so it is a second thing an impersonating
                    // rectangle cannot reproduce: it would have to guess words it
                    // can never read (visor.css:382-400).
                    //
                    // NOTHING PERSONAL BEFORE THE CLAIM: an unclaimed cluster is
                    // EMPTY — no name, no device, and no settings button either,
                    // because the settings sheet is about a visor that is not
                    // yours yet (visor.ts:1442-1451).
                    div { id: "visor-identity",
                        if claimed {
                            span { class: "id-lines",
                                // An unset field renders NOTHING — no fabricated
                                // "user", no fabricated "this device", and no
                                // leftover punctuation.
                                if let Some(name) = identity.name.as_ref() {
                                    span { class: "who", "{name.as_str()}" }
                                }
                                if let Some(device) = identity.device.as_ref() {
                                    span { class: "who device", "{device.as_str()}" }
                                }
                            }
                            button {
                                id: "visor-settings",
                                r#type: "button",
                                title: "{settings_label}",
                                "aria-label": "{settings_label}",
                                onclick: move |_| crate::component::report_settings(),
                                // The face is a glyph from the visor's FIXED
                                // vocabulary — never a string out of the record.
                                "{identity_face(&identity).as_str()}"
                                // THE EVENT BADGE: a dot, never a count, and the
                                // element is EMPTY — framework voice by
                                // construction, because there is no string here
                                // that could carry another voice's marking onto
                                // the anchor. ABSOLUTE in visor.css:466-470, so
                                // the strip's MEASURED GEOMETRY is identical lit
                                // and unlit; `aria-hidden` keeps it out of the
                                // accessibility tree and the button's own label
                                // is the non-visual channel.
                                if badge_lit {
                                    span { class: "visor-badge", "aria-hidden": "true" }
                                }
                            }
                        }
                    }

                    // THE STRIP'S SCREEN-READER CHANNEL. Visually hidden, NEVER
                    // `display:none` — a display:none live region is not
                    // announced at all, so visor.css:302-314's clip-rect recipe
                    // is the only correct one. `aria-atomic` is what lets several
                    // sentences emitted in one activation be delivered as one
                    // write; see `Visor::speak`.
                    span {
                        id: "visor-live",
                        "aria-live": "polite",
                        "aria-atomic": "true",
                        "{live_text}"
                    }
                }
            }
        }

        // The dim sits BETWEEN the page and the visor assembly: the zone (30)
        // above, every app surface below. It ABSORBS THE GESTURE — the visor
        // saying "the page is not what you are talking to right now", and a drag
        // on it that scrolled the page underneath would contradict that in the
        // most literal way available (visor.css:610-625).
        div { id: "visor-dim", hidden: !dimmed }
    }
}

/// Enter or Space: the two keys a `role="button"` owes assistive tech.
fn is_activation(e: &KeyboardEvent) -> bool {
    matches!(e.key(), Key::Enter) || e.key() == Key::Character(" ".into())
}
