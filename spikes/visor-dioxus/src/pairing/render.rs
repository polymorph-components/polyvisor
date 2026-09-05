//! THE ONE PLACE A PAIRING CODE OR A SAS BECOMES PIXELS.
//!
//! This is the port of `visor/ui/pairing.ts:66-94` — "THE GREP MARKER
//! (invariant (f), scripts/check-invariants.sh)" — and it is the same property
//! bought a stronger way.
//!
//! # What the invariant is FOR
//!
//! The pairing ceremony's whole security claim is that a relay which can see
//! and modify everything on the wire still cannot get a device enrolled,
//! because two humans compare a short authentication string out of band. That
//! claim only holds if the digits the humans compare were drawn somewhere an
//! app cannot draw and cannot read. So: a pairing code or a SAS renders in
//! visor pixels, and nowhere else.
//!
//! # How TypeScript pins it, and why that is the weaker form
//!
//! `demo/scripts/check-invariants.sh` (f) greps for the literal substrings
//! `renderPairingCode(` and `renderSas(` and asserts they appear only in
//! `visor/ui/pairing.ts` — both the definitions (:183-189) and every call
//! (:172-180). It is a good check for a language where any `string` is
//! renderable anywhere, and pairing.ts:66-79 states its own limits: it pins the
//! CALL SITE, not the string, and it can only see the door.
//!
//! # THE STRUCTURAL FORM, which is what this module is
//!
//! The dispatch asked for module privacy over documentation, and there is a
//! stronger construction available here — the one [`crate::voice::AppVoice`]
//! already uses for the mirror-image problem, applied to the mirror-image
//! direction.
//!
//! A pairing code and a SAS enter this crate as `String` at exactly one seam
//! each (the `pairing-driver` import, in `join.rs` and `add.rs`) and are
//! immediately wrapped in [`PairingCode`] / [`Sas`]. Both are newtypes with a
//! PRIVATE FIELD AND NO TEXT ACCESSOR. What you can do with one is:
//!
//!   - [`PairingCode::render`] / [`Sas::render`] — this module's two
//!     functions, which are the port of `renderPairingCode`/`renderSas` and
//!     the only definitions of either rendering in the crate;
//!   - [`PairingCode::render_qr`] — the same code as a QR. The bytes reach an
//!     encoder and come back as a bit matrix; nothing on the way out is text,
//!     and the rendering lives behind the same wall because a QR IS a
//!     rendering of the code.
//!
//! There is no third thing, and no `as_str`. So a second rendering site is not
//! a review finding or a grep failure, it is A COMPILE ERROR: a would-be
//! renderer elsewhere has no way to get at the characters to render. That
//! closes the gap pairing.ts:74-79 names — the grep sees the door, this sees
//! the string.
//!
//! ```text
//! let sas = Sas::from_driver("00 01 02".into());
//! let leaked: &str = sas.as_str();   // no such method: private field, no getter
//! ```
//!
//! `text` and not `compile_fail`, deliberately: this module is inside
//! `lib.rs`'s `wasm32` gate, so rustdoc on the host never collects a doctest
//! here and a `compile_fail` block would claim a check that does not run. The
//! property is real and is enforced by the type, not by this block — see
//! `voice.rs`, whose equivalent blocks ARE collected because that module is
//! natively compiled.
//!
//! WHAT IS NOT CLAIMED, stated for the same reason `voice.rs` states its own
//! residue: nothing stops someone writing a THIRD `fn` in THIS file. Privacy
//! bounds where a definition may live, not how many may live there. That is a
//! one-file, one-module review surface instead of a whole-crate grep, which is
//! the improvement actually on offer.

use dioxus::prelude::*;

use super::qr::Matrix;
use super::text::group;

/// FRAMEWORK VOICE, both of these (visor/README.md:112 lists "SAS digits, the
/// pairing code" in the unmarked baseline row). They are the visor's own words
/// in the strict sense that matters: no app influenced them, they came from
/// the backend over the ceremony's own channel. So they carry no `.foreign`
/// plate and no `.petname` weight — they are simply the visor talking.
///
/// The dress is inline rather than a class because `visor/ui/visor.css` is
/// read-only and has no pairing vocabulary in it: the TypeScript pane injected
/// its own `.pm-code`/`.pm-sas` rules at runtime (pairing.ts:96-124), which a
/// guest rendering through a mutation channel cannot do. The declarations are
/// pairing.ts:106-109's, transcribed.
const CODE_STYLE: &str =
    "font: 20px/1.4 ui-monospace, monospace; letter-spacing: .04em; \
     word-break: break-all; margin: .5em 0;";
const SAS_STYLE: &str =
    "font: 28px/1.2 ui-monospace, monospace; letter-spacing: .1em; margin: .5em 0;";

/// THE JOIN CODE, from the moment it crossed the driver seam.
///
/// No text accessor — see the module header. `Clone` so the sheet's transient
/// signal can hold one; cloning a wrapper moves no capability, because there
/// was never a way out of the wrapper to begin with.
#[derive(Clone, PartialEq)]
pub struct PairingCode(String);

/// THE SHORT AUTHENTICATION STRING the two humans compare out loud. Same
/// construction, and the one that matters most: this is the value the whole
/// ceremony's resistance to a relay rests on.
#[derive(Clone, PartialEq)]
pub struct Sas(String);

impl PairingCode {
    /// THE ONE SEAM. Called only where `pairing-driver` hands the code over
    /// (`join.rs`'s start), so the bare `String` has a lifetime of one
    /// expression before it is inside the wrapper for good.
    pub fn from_driver(code: String) -> Self {
        Self(code)
    }

    /// THE CODE AS A QR, drawn as SVG through ordinary DOM mutations.
    ///
    /// THE ENCODER IS NOT A READER: the bytes reach a Reed-Solomon encoder and
    /// come back as a bit matrix. This is the only method that touches the
    /// characters and it cannot return them, which is why the drawing lives
    /// here rather than in `qr.rs` — `qr.rs` never sees the code at all, only
    /// the matrix.
    ///
    /// NOTHING IS RENDERED when the payload will not encode. The text code
    /// below it is the transcribable form and the ceremony completes on it
    /// alone; an empty box where a QR should be would be worse than no box.
    ///
    /// THE WHOLE SYMBOL IS ONE `<path>`. See `qr.rs`'s header for why this is
    /// SVG and not the canvas the TypeScript used, and why one path rather
    /// than 362 rects.
    pub fn render_qr(&self) -> Element {
        let Some(matrix) = Matrix::encode(&self.0) else {
            return rsx! {};
        };
        let span = matrix.span();
        rsx! {
            svg {
                class: "pair-qr",
                // The intrinsic box. `viewBox` is in MODULE units, so the
                // symbol scales with the rendered size and there is no
                // device-pixel factor to get wrong; 132px is
                // `visor/ui/pairing.ts:540-541`'s rendered size, kept.
                width: "132",
                height: "132",
                view_box: "0 0 {span} {span}",
                style: "display: block; margin: .5em 0; border: 1px solid #999;",
                // FRAMEWORK VOICE, and it names the picture without reading
                // the code out: a screen-reader user is served by the grouped
                // text beside it, which is transcribable, rather than by a QR
                // they cannot scan.
                // Spelled as raw attributes: `dioxus_elements::svg` carries no
                // `role`/`aria_label` field, and these are the two that make a
                // decorative-looking `<svg>` announce itself as a picture.
                "role": "img",
                "aria-label": "the same code as a QR, to scan with the other device",
                // THE QUIET ZONE, drawn as the background rather than left to
                // whatever is behind the sheet. A QR on a dark surface with no
                // margin does not scan.
                rect { width: "{span}", height: "{span}", fill: "#fff" }
                path { d: "{matrix.svg_path()}", fill: "#000" }
            }
        }
    }

    /// The port of `renderPairingCode` (pairing.ts:80-87). ONE OF THE TWO
    /// DEFINITIONS THIS MODULE EXISTS TO BE THE ONLY HOME OF.
    pub fn render(&self) -> Element {
        let grouped = group(&self.0);
        rsx! {
            div {
                class: "pair-code",
                style: CODE_STYLE,
                // Read aloud as digits-and-letters rather than as a word: the
                // whole point of the code is that a human transcribes it to
                // another device, and a screen reader running the groups
                // together as a pronounceable token would be transcribed
                // wrong. `.pm-code` had no such treatment in TypeScript, where
                // the pane was not on the strip's accessibility path at all.
                aria_label: "pairing code, in groups of four: {grouped}",
                "{grouped}"
            }
        }
    }
}

impl Sas {
    /// THE ONE SEAM, as [`PairingCode::from_driver`]. Two call sites, because
    /// both halves of the ceremony show the same digits: the joining device
    /// gets them on `pair-join-state::claimed`, the admitting device on
    /// `pair-add-state::sas-ready`.
    pub fn from_driver(sas: String) -> Self {
        Self(sas)
    }

    /// The port of `renderSas` (pairing.ts:89-94). THE OTHER OF THE TWO.
    pub fn render(&self) -> Element {
        rsx! {
            div {
                class: "pair-sas",
                style: SAS_STYLE,
                // The comparison is the ceremony, so a non-sighted user has to
                // be able to make it too — and to make it they must hear the
                // characters, not a rendering of them as a number.
                aria_label: "the digits to compare: {self.0}",
                "{self.0}"
            }
        }
    }
}
