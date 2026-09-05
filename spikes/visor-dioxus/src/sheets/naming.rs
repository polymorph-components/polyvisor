//! THE NAMING CEREMONY (`buildNameSheet`, sheets.ts:736-1033): where a
//! component stops being what it calls itself and becomes what the user calls
//! it.
//!
//! The sheet is the naming ceremony GROWN into the one place the visor says
//! everything it knows about a component (sheets.ts:724-735), so it is the same
//! tenant the old naming sheet was — evolved, not added to.
//!
//! # THE NOMINATED GLYPH IS APP VOICE, and that is the whole subtlety here
//!
//! A component may NOMINATE a mark. The nomination is not a derivation and not
//! an assignment: it is one offer among six, and the component is never told
//! whether it was taken (sheets.ts:87-90). Three things follow, and all three
//! are visible in this file:
//!
//!   1. A merely-nominated glyph is NEVER RENDERED OUTSIDE THIS PICKER. There
//!      is no path from a nomination to the strip; only [`crate::marks`] feeds
//!      the strip, and only the user's Save writes to it.
//!   2. INSIDE the picker it is dressed as not-the-visor's: the button keeps
//!      its border but wears it DASHED, because it is a button and a border is
//!      honest on a control, and takes the app-voice plate's background and
//!      inset shadow so the offer and its attribution line speak one vocabulary
//!      (visor.css:857-884). Above the row, an app-voice ATTRIBUTION LINE says
//!      the visor's sentence around the component's glyph, quoted and plated
//!      like every other thing a component said.
//!   3. ADOPTION IS THE USER'S ACT, and it is what converts the glyph from app
//!      voice to user voice. Nothing here does it on their behalf.
//!
//! [`AppVoice`] carries (2)'s attribution and needed no weakening to do it. The
//! reason is worth stating because it looks like a hole and is not: the glyph
//! on the BUTTON is a [`MarkIcon`], and a `MarkIcon` is a `&'static str` out of
//! `voice.rs`'s own vetted table (`voice.rs:180-192`). The component chose
//! WHICH of twenty-eight constants to point at; it did not supply a string. So
//! the button renders a `MarkIcon` — structurally incapable of being anything
//! else — while the attribution line, which is the visor saying "a component
//! asked for this", renders an [`AppVoice`] built from that same vetted glyph.
//! One door, used as intended, and the `compile_fail` doctests in `voice.rs`
//! are untouched.

use dioxus::prelude::*;

use crate::component::{embedder, read_visor, with_visor};
use crate::marks::iso_date;
use crate::sheets::{close_ceremony, load_marks, owns, save_marks, SheetRoot, NAMING};
use crate::state::Surface;
use crate::voice::{AppVoice, MarkIcon, UserVoice, NAME_MAX};

/// WHAT THE CEREMONY IS ABOUT, held on `SheetsState` because it arrives from
/// outside through `sheets.request-naming` and must survive a rebuild.
///
/// One field, and it used to be two: `first_seen` sat beside the surface back
/// when `types.surface` had no field for it. It has one now
/// (wit/world.wit:155-157), so the timestamp rides on the `Surface` like every
/// other thing the sheet says about the component — one value, which cannot
/// disagree with itself. `export.rs`'s `request_naming` is what fills it, from
/// the TRUST TABLE rather than from the caller; the reason is at that site.
#[derive(Clone, PartialEq, Debug)]
pub struct Subject {
    pub surface: Surface,
}

/// The glyph the component asked to wear, or `None`.
///
/// It reaches here as a [`MarkIcon`] — the component chose which of the
/// curated constants to point at and supplied no string — so there is nothing
/// to re-validate and nothing unvetted to drop. What still happens below it is
/// the ceremony's own rule, which no caller can pre-empt: `icon_offers` offers
/// it FIRST, and drops it in silence if another record already wears it
/// (wit/world.wit:266-271).
fn nomination_for(subject: &Subject) -> Option<MarkIcon> {
    subject.surface.nomination
}

#[component]
pub fn NamingSheet() -> Element {
    let Some(subject) = read_visor(|v| v.sheets.naming.clone()).flatten() else {
        return rsx! {};
    };
    let surface = subject.surface.clone();
    let provenance = surface.name.clone();

    // ROLLED ONCE PER MOUNT, and a mount is a presentation — which is exactly
    // sheets.ts's "freshly per ceremony" (:203-209). A `use_hook` rather than a
    // `use_memo`: the offers must not be recomputed when anything on this sheet
    // changes, or typing a letter into the petname field would reshuffle the
    // row under the user's finger.
    let offers: Vec<(MarkIcon, bool)> = use_hook(|| {
        load_marks().icon_offers(&provenance, nomination_for(&subject))
    });
    let nominated: Option<MarkIcon> = offers.iter().find(|(_, n)| *n).map(|(g, _)| *g);

    // NEVER PREFILLED FROM THE NICKNAME (sheets.ts:813-819). A prefilled
    // self-declared name would let attacker-chosen words walk into the visor's
    // voice by accept-the-default — the user would "assign" a petname they
    // never wrote, and the visor would then speak it unquoted, which is exactly
    // the authority the whole three-name split exists to withhold. An EXISTING
    // petname is prefilled, because that one the user typed.
    let existing = surface.petname.as_ref().map(|p| p.as_str().to_string());
    let mut typed = use_signal(|| existing.clone().unwrap_or_default());
    // The record's current mark comes PRESELECTED, so opening this sheet to fix
    // a typo in a petname can never cost a component its mark by accident.
    let mut picked = use_signal(|| surface.icon);
    let mut reason = use_signal(String::new);

    let key = provenance.clone();
    let commit = move |_| {
        if !owns(NAMING) {
            return;
        }
        let petname = typed.read().trim().to_string();
        if petname.is_empty() {
            // REFUSED rather than treated as "forget": clearing the field is an
            // ambiguous gesture, and Cancel is the unambiguous way out.
            reason.set("type a name, or Cancel to leave it unnamed".into());
            return;
        }
        let mut table = load_marks();
        if let Some((clash_key, clash_name)) = table.collision(&key, &petname) {
            // THE VISOR'S OWN WORDS, naming the colliding record by BOTH its
            // petname and its unforgeable provenance key — the user needs to
            // know which component already answers to this word.
            reason.set(format!(
                "you already call another component \"{clash_name}\" (fetched as {clash_key}) — pick a different name"
            ));
            return;
        }
        let icon = *picked.read();
        // THE TABLE FIRST, then the consumer's caches: `embedder.on-named`
        // fires AFTER the write (wit/world.wit:200-204), so a consumer that
        // fails cannot leave the visor's own record half-committed.
        table.set_petname(
            &key,
            UserVoice::new(&petname, NAME_MAX),
            icon,
            crate::component::now_ms(),
        );
        save_marks(&table);
        // FIRST SIGHT IS OVER, and `is-new` is deliberately absent from the
        // notification (wit/world.wit:202-203): the ceremony IS the first-sight
        // moment completing, so every live copy of this identity should clear
        // its NEW badge. "First time this component draws here" and the user's
        // own name for it are contradictory claims to make side by side.
        embedder::on_named(&key, &petname, icon.map_or("", |i| i.as_str()));
        finish(&format!("saved — the visor will call this component {petname} from now on"));
    };

    let key = provenance.clone();
    let forget = move |_| {
        if !owns(NAMING) {
            return;
        }
        // THE WHOLE RECORD. Forgetting must be honest on the strip too: the
        // cached petname goes with the record, so the anchor stops speaking a
        // name the visor no longer holds.
        let mut table = load_marks();
        table.forget(&key);
        save_marks(&table);
        embedder::on_forgotten(&key);
        finish("forgotten — this component will be announced as NEW next time");
    };

    let has_petname = existing.as_deref().map(str::trim).is_some_and(|p| !p.is_empty());

    rsx! {
        SheetRoot { tenant: NAMING.to_string(), class: "name-sheet",
            h2 { "App settings" }

            // THE IDENTITY BLOCK — the two voices that are not the user's: what
            // the component says about itself, and what the visor fetched it as.
            div { class: "cred-line",
                // The record's pet icon, when it has one — same rule as the
                // strip: no mark, no glyph, no placeholder.
                if let Some(icon) = surface.icon {
                    {icon.render()}
                }
                span { class: "said", "calls itself" }
                // APP VOICE through the one door.
                if !surface.nickname.is_empty() {
                    {surface.nickname.render()}
                }
            }
            div { class: "cred-line",
                span { class: "said", "the visor fetched it as" }
                // APP VOICE: the provenance key is machine-supplied, so it is
                // plated rather than spoken in the visor's sentence.
                //
                // CONTRACT: sheets.ts:767 clamps this one at 60 rather than at
                // the default 40, being a key rather than a declared name.
                // `AppVoice::token` has ONE clamp and gains no parameter here —
                // widening the app-voice door for a cosmetic length would be
                // paying in the currency this crate's whole voice argument is
                // denominated in. 40 is the stricter reading and the overflow
                // is already ellipsised by `.cred-sheet q.foreign`.
                {AppVoice::token(&surface.name).render()}
            }

            // FIRST SIGHT, from the trust record itself: the visor's own memory
            // of the component, and the only thing on the sheet that answers
            // "have I really seen this before?" with something other than a
            // colour. Omitted when the record does not say, rather than shown
            // as an epoch date nobody's component was installed on.
            if let Some(seen) = surface.first_seen.filter(|t| *t > 0) {
                div { class: "cred-line",
                    span { class: "said", "first seen" }
                    span { "{iso_date(seen)}" }
                }
            }

            // THE METADATA BLOCK — one line of visor-KNOWN fact about this
            // surface, when there is one: a panel's declared destination, or
            // the region the visor drew the app into (sheets.ts:785-802).
            //
            // `label` is THE VISOR'S OWN WORD, always, and never
            // component-supplied — so it is spoken plainly, in the visor's
            // sentence.
            //
            // CONTRACT: `value` IS ALWAYS PLATED, even when the WIT record says
            // `foreign: false`. sheets.ts:795-801 branches — a visor-sourced
            // value renders as a bare span — and that branch is not
            // representable here, because `SurfaceMeta::value` is an
            // [`AppVoice`] with no text accessor, which is the whole of the
            // app-voice enforcement (`voice.rs`'s header). Rendering every
            // value through the one door is the SAFE direction of that
            // asymmetry: over-plating the visor's own string is what
            // visor/README.md:127 calls "ugly but not dangerous", while the
            // branch that would need widening the door is the dangerous one.
            // The alternative — splitting `value` into a two-voice enum so the
            // type carries the flag — is a `state.rs` change this fix does not
            // need. Reported.
            if let Some(meta) = surface.meta.as_ref() {
                div { class: "cred-line",
                    span { class: "said", "{meta.label}" }
                    {meta.value.render()}
                }
            }

            div { class: "cred-field",
                label { "Your name for it" }
                input {
                    r#type: "text",
                    autocomplete: "off",
                    maxlength: "{NAME_MAX}",
                    placeholder: "a word you will recognise",
                    value: "{typed}",
                    oninput: move |e| typed.set(e.value()),
                }
                div { class: "hint",
                    "the visor will use this name in its own voice; what the component calls itself stays quoted"
                }
            }

            div { class: "cred-line said", "a mark you will recognise" }

            // THE FOREIGN ATTRIBUTION. The visor says the sentence; the
            // component's glyph is quoted, the same way its nickname is.
            if let Some(glyph) = nominated {
                div { class: "cred-line name-nomination",
                    span { class: "said", "it asks to wear" }
                    {AppVoice::token(glyph.as_str()).render()}
                    span { class: "said", "— offered first below; the rest are the visor's own" }
                }
            }

            div { class: "name-icons",
                for (glyph, is_nominated) in offers.iter().copied() {
                    button {
                        key: "{glyph.as_str()}",
                        r#type: "button",
                        "data-glyph": "{glyph.as_str()}",
                        "data-nominated": if is_nominated { Some("true") } else { None },
                        // THE VISOR'S OWN WORDS on both, and no component string
                        // in either: the nominated one is DESCRIBED, never
                        // quoted, here.
                        title: if is_nominated { "the component asked for this one" } else { "use this mark" },
                        class: match (is_nominated, *picked.read() == Some(glyph)) {
                            (true, true) => "nominated picked",
                            (true, false) => "nominated",
                            (false, true) => "picked",
                            (false, false) => "",
                        },
                        onclick: move |_| picked.set(Some(glyph)),
                        // A `MarkIcon`, not a string: the value is one of
                        // `voice.rs`'s own constants and cannot be anything
                        // else, which is why this is not a second app-voice
                        // door. See the module header.
                        "{glyph.as_str()}"
                    }
                }
            }

            div { class: "cred-note",
                "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and the name you choose is never given back to it"
            }
            div { class: "cred-reason", "{reason}" }

            div { class: "cred-row",
                button { r#type: "button", onclick: commit, "Save" }
                button {
                    r#type: "button",
                    onclick: move |_| {
                        if owns(NAMING) {
                            // No announcement: nothing happened, and saying so
                            // on the anchor would spend the bottom line on a
                            // non-event (sheets.ts:1004-1007, 1633-1637).
                            finish("");
                        }
                    },
                    "Cancel"
                }
            }

            // Forgetting is offered only when there is something to forget.
            if has_petname {
                div { class: "name-forget",
                    button { r#type: "button", class: "forget", onclick: forget,
                        "forget this component"
                    }
                    span { class: "hint", "drops the name AND the mark — next time it is NEW again" }
                }
            }
        }
    }
}

/// Close the ceremony and, when there is something true to say, say it
/// (sheets.ts:953-964).
///
/// The announcement is THE VISOR'S OWN LINE in the visor's own bar — a
/// statement about the shell's trust table, not about anybody's replica. It
/// expires by RE-RENDERING the strip, which matters exactly here: the thing the
/// bottom line shows has just changed — a petname was assigned, or a whole
/// record was forgotten — so restoring what the line said before would put a
/// stale claim back on the anchor.
fn finish(status: &str) {
    close_ceremony(NAMING, true);
    with_visor(|v| v.sheets.naming = None);
    if !status.is_empty() {
        crate::component::announce_framework(status);
    }
}
