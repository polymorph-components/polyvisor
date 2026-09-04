//! THE THREE VOICES, ENFORCED BY CONSTRUCTION.
//!
//! Every piece of content the visor renders belongs to exactly one provenance
//! class, and the class is visible (visor/README.md "Three voices",
//! visor/ui/visor.css's header):
//!
//!   - FRAMEWORK VOICE — the unmarked baseline: the visor's own headings,
//!     labels, `.said` commentary, announcements, the `.fresh` badge. No
//!     marker; it is what the visor looks like.
//!   - USER VOICE (`.petname`, `.who`, and pet icons) — the user's own
//!     vocabulary spoken by the visor. Weight 600, full opacity, never quoted,
//!     never monospace.
//!   - APP VOICE (`.foreign`) — component-influenced strings: quoted,
//!     monospaced, textually attributed, and PLATED, so they read as embedded
//!     tokens rather than as words in the visor's own sentence.
//!
//! THE ONE-DIRECTIONAL SECURITY RULE (README:126-128): *app-influenced strings
//! must only be renderable through the app-voice constructor; the reverse
//! direction (visor text accidentally styled as a plate) is ugly but not
//! dangerous.*
//!
//! # What this module changes about how that rule is enforced
//!
//! In TypeScript the rule is a GREP. `foreignToken()` (visor.ts:606) is
//! declared the only door, and check (h) of `demo/scripts/check-invariants.sh`
//! pins the count of `foreign` class assignments in `visor/ui/` at exactly
//! one. That check can only see the door; it cannot see the string. Nothing in
//! the TypeScript type system stops `ctxBottom.textContent = surface.nickname`
//! — a plain assignment of an app-influenced string into the visor's own
//! sentence — because `nickname` is a `string` like any other, and a `string`
//! is renderable everywhere.
//!
//! Here the string is not a `String`. [`AppVoice`] wraps it in a newtype with a
//! PRIVATE FIELD AND NO TEXT ACCESSOR: `render` is the only thing you can do
//! with one, and `render` is the site that emits the `foreign` class. So the
//! dangerous direction is a COMPILE ERROR rather than a review finding:
//!
//! ```compile_fail
//! # use visor_spike::voice::AppVoice;
//! let token = AppVoice::token("evil");
//! let plain: &str = token.text();   // no such method: private field, no getter
//! ```
//!
//! ```compile_fail
//! # use visor_spike::voice::{AppVoice, FrameworkText};
//! let token = AppVoice::token("evil");
//! let said: FrameworkText = token.into();  // no such conversion exists
//! ```
//!
//! And because [`crate::state::Surface`] holds its nickname as an `AppVoice`
//! rather than as a `String` — the conversion out of the WIT record being the
//! single site where the raw value is seen at all — there is no second copy of
//! the string anywhere in the crate for a second door to reach.
//!
//! # What it deliberately does NOT claim
//!
//! It is still possible to write `class: "foreign"` beside a framework-voice
//! literal. Rust cannot forbid a string literal, and neither could the grep.
//! That is the direction README:127 calls "ugly but not dangerous", and it is
//! the only direction left unguarded — which is the exact asymmetry the rule
//! asks for.
//!
//! # Announcements
//!
//! `control.announce` takes a flat string (wit/world.wit:221-222): it cannot
//! carry class marking, so it cannot carry an app-influenced token. That
//! property is visible in the types here — [`FrameworkText`] is what the
//! announce path accepts, `AppVoice` cannot become one, and [`UserVoice`] can,
//! because the user's vocabulary is already something the visor is entitled to
//! say in its own sentence (README:139-148).

use dioxus::prelude::*;

/// Cap for the user's own words on the strip. CSS ellipsis handles the visual
/// overflow; this stops a hand-edited record from being long enough to matter
/// in the first place. visor.ts:360.
pub const IDENTITY_MAX: usize = 24;

/// The petname cap, and `foreignToken`'s default `maxLen` (visor.ts:564, 608):
/// the naming sheet caps input at 40, and a record hand-edited in devtools
/// should not be able to stretch the strip.
pub const NAME_MAX: usize = 40;

/// Clamp by CHARACTERS, not bytes. `String::truncate` panics on a non-char
/// boundary, and every one of these strings can be non-ASCII — a petname, a
/// device word, a component's nickname.
fn clamp(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// --- APP VOICE ---------------------------------------------------------------

/// THE APP-VOICE CONSTRUCTOR'S OUTPUT — the only form in which a
/// component-influenced string exists inside this crate.
///
/// The field is private and there is no accessor. See the module header for
/// what that buys over the TypeScript grep.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AppVoice(String);

impl AppVoice {
    /// THE ONLY DOOR. Clamped at the render site, exactly as `foreignToken`'s
    /// `maxLen` is (visor.ts:606-614).
    pub fn token(text: &str) -> Self {
        Self(clamp(text, NAME_MAX))
    }

    /// Whether the component declared anything at all. A component that
    /// declares nothing gets nothing quoted: an empty app-voice token renders
    /// as a bare plate with quote marks — punctuation in the visor's pixels
    /// standing for a claim nobody made (visor.ts:1704-1708).
    ///
    /// This is the ONE thing that may be learned about the string without
    /// rendering it, and it is a bit rather than a substring on purpose.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// APP VOICE ON THE STRIP: quoted, monospaced, clamped and plated. The
    /// dressing is `#visor-context q.foreign` in visor.css:67-74, 226-229.
    ///
    /// THE SINGLE SITE IN THIS CRATE THAT NAMES THE `foreign` CLASS.
    pub fn render(&self) -> Element {
        rsx! { q { class: "foreign", "{self.0}" } }
    }
}

// --- USER VOICE --------------------------------------------------------------

/// USER VOICE: the user's word for a component, spoken in THE VISOR'S voice —
/// not quoted, not monospaced, full opacity, weight 600, because the user
/// wrote it and the visor is entitled to say it (visor.ts:556-566).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UserVoice(String);

impl UserVoice {
    /// `None` for the unset case, which renders NOTHING — no fabricated
    /// "user", no fabricated "this device" (visor.ts:128-132). Blank-only
    /// input is unset: the record is hand-editable storage.
    pub fn new(text: &str, max: usize) -> Option<Self> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(clamp(trimmed, max)))
    }

    /// USER-VOICE WORDS ARE ADMISSIBLE INLINE IN AN ANNOUNCEMENT, and this
    /// accessor is where that permission lives. It is the deliberate asymmetry
    /// with [`AppVoice`], which has no such method: "an announcement speaks in
    /// the visor's own voice and may embed user-voice words inline (a petname,
    /// a device word); an app-influenced string must never be passed to one"
    /// (README:139-148).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The set of pet icons a COMPONENT may be marked with — `APP_MARK_ICONS`,
/// visor.ts:227-260, transcribed verbatim and in order.
///
/// The six curation criteria are stated in full at that site and are not
/// restated here; what matters to this port is criterion (1), one Unicode
/// scalar in the BMP, because it is what lets membership be decided by exact
/// string equality — and membership is the whole firewall.
const APP_MARK_ICONS: [&str; 28] = [
    "●", "■", "⌂", "⌨", "☎", "☁", "☂", "☃", "☻", "♥", "♨", "♪", "⚒", "⛏", "⚖", "⚗", "⚛", "⚄",
    "♛", "♜", "♝", "♞", "♟", "✂", "✇", "✈", "✉", "✎",
];

/// THE CORE of the user's own vocabulary — the ten glyphs the visor's own
/// button shipped with, in their original order, so the shield is `[0]` and
/// therefore the default (visor.ts:139-140).
const VISOR_ICON_CORE: [&str; 10] = ["⛨", "✶", "✦", "◆", "▲", "☘", "⚑", "✿", "☾", "⚙"];

/// The glyph the visor's own button wears when the record names none.
pub const DEFAULT_ICON: &str = VISOR_ICON_CORE[0];

/// A GLYPH THAT PASSED THE FIREWALL — and, because the field is a
/// `&'static str` out of one of this module's own tables, a glyph that
/// STRUCTURALLY cannot be anything else.
///
/// visor.ts:295-339 argues the firewall at length: a pet icon can arrive from a
/// component's nomination, from another device's sync, or from a hand-edited
/// record, so the interesting inputs are bidi overrides, ZWJ sequences,
/// variation selectors, combining marks, homoglyphs of the visor's own button
/// core, and anything long enough to stretch the strip. Enumerating those is a
/// losing game; membership in a fixed hand-vetted list refuses all of them at
/// once, including the ones nobody has thought of yet.
///
/// USER VOICE BY CONSTRUCTION, which is why it carries no marker of its own: a
/// glyph reaches the strip only after the user adopted it (README:185-192).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct MarkIcon(&'static str);

impl MarkIcon {
    /// A COMPONENT's mark. Returns `None` for the unmarked case — an empty
    /// string, or anything the vetted list refuses — so a caller appends
    /// nothing rather than a blank slot. Ported from `markIcon`, visor.ts:349.
    ///
    /// DEGRADES SAFELY: a mark that fails renders as NO ICON ANYWHERE, never
    /// as a placeholder and never as the raw string, so the worst outcome is a
    /// surface the user has not marked yet — a state the visor already handles
    /// honestly.
    pub fn app_mark(icon: &str) -> Option<Self> {
        APP_MARK_ICONS.iter().find(|g| **g == icon).map(|g| Self(g))
    }

    /// THE VISOR'S OWN BUTTON FACE. The wide set: the ten the button shipped
    /// with, plus every pet icon not already among them (`VISOR_ICONS`,
    /// visor.ts:290-293). Unknown or absent falls back to the shield —
    /// deliberately, because the record is hand-editable localStorage and an
    /// arbitrary string here would put attacker-chosen WORDS ("Verified",
    /// "polymorph") into the anchor in the visor's own voice.
    pub fn identity_icon(icon: Option<&str>) -> Self {
        let Some(icon) = icon else { return Self(DEFAULT_ICON) };
        VISOR_ICON_CORE
            .iter()
            .chain(APP_MARK_ICONS.iter())
            .find(|g| **g == icon)
            .map_or(Self(DEFAULT_ICON), |g| Self(g))
    }

    /// The glyph, for the render sites and for the identity record's
    /// round-trip. Safe to expose where `AppVoice`'s text is not: the value is
    /// always one of this module's own constants, so there is no untrusted
    /// string to leak.
    pub fn as_str(&self) -> &'static str {
        self.0
    }

    /// THE PET ICON: the user's own recognition mark for a component, in the
    /// visor's own foreground colour — plain text, not a painted chip
    /// (visor.css:203-221).
    pub fn render(&self) -> Element {
        rsx! { span { class: "mark-icon", "{self.0}" } }
    }
}

// --- FRAMEWORK VOICE ---------------------------------------------------------

/// A SENTENCE IN THE VISOR'S OWN VOICE, bound for a channel that cannot carry
/// class marking: the strip's announcement line, the `#visor-live` region, the
/// event record, a standing condition, a tenant's `spoken` noun phrase, a back
/// action's label.
///
/// The type exists to make one thing unwritable: there is no conversion from
/// [`AppVoice`], and `AppVoice` has no accessor, so an app-influenced string
/// cannot reach any of those channels. Everything else can — this is a plain
/// wrapper over a `String`, on purpose, because the visor's own words are the
/// ones it may say freely.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FrameworkText(String);

impl FrameworkText {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl From<String> for FrameworkText {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for FrameworkText {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The clamp is by characters: a byte truncation of a multi-byte glyph
    /// would panic, and every one of these fields can be non-ASCII.
    #[test]
    fn clamping_is_by_characters() {
        let long = "é".repeat(80);
        assert_eq!(clamp(&long, NAME_MAX).chars().count(), NAME_MAX);
        assert_eq!(UserVoice::new(&long, IDENTITY_MAX).unwrap().as_str().chars().count(), 24);
    }

    /// visor.ts:388-390: empty fields are stored as ABSENT, not as "" — unset
    /// must round-trip as unset so the strip keeps rendering nothing.
    #[test]
    fn blank_user_voice_is_unset() {
        assert!(UserVoice::new("", IDENTITY_MAX).is_none());
        assert!(UserVoice::new("   ", IDENTITY_MAX).is_none());
        assert_eq!(UserVoice::new("  ada ", IDENTITY_MAX).unwrap().as_str(), "ada");
    }

    /// The firewall, stated as the tests visor.ts:295-339 argues for: the
    /// interesting inputs are not typos.
    #[test]
    fn the_mark_firewall_refuses_everything_outside_the_list() {
        assert!(MarkIcon::app_mark("✉").is_some());
        assert!(MarkIcon::app_mark("").is_none());
        // A bidi override wrapped around a legitimate glyph.
        assert!(MarkIcon::app_mark("\u{202E}✉").is_none());
        // The same glyph plus VS16 — the colour-emoji presentation criterion
        // (2) excludes.
        assert!(MarkIcon::app_mark("✉\u{FE0F}").is_none());
        // A ZWJ sequence, and a string long enough to stretch the strip.
        assert!(MarkIcon::app_mark("✉\u{200D}✉").is_none());
        assert!(MarkIcon::app_mark(&"●".repeat(50)).is_none());
        // The visor's OWN button core is not a component-nominable mark:
        // criterion (4) keeps the two sets free of confusability overlap.
        assert!(MarkIcon::app_mark("⛨").is_none());
    }

    /// The button face falls back to the shield rather than rendering a
    /// hand-edited record's string (visor.ts:262-289).
    #[test]
    fn the_button_face_is_vocabulary_or_the_shield() {
        assert_eq!(MarkIcon::identity_icon(None).as_str(), "⛨");
        assert_eq!(MarkIcon::identity_icon(Some("Verified")).as_str(), "⛨");
        assert_eq!(MarkIcon::identity_icon(Some("☾")).as_str(), "☾");
        // The wide set: a pet icon is a legitimate button face too.
        assert_eq!(MarkIcon::identity_icon(Some("✈")).as_str(), "✈");
    }

    /// An empty declaration renders nothing rather than an empty plate
    /// (visor.ts:1704-1708).
    #[test]
    fn an_empty_nickname_is_visible_as_empty_without_being_readable() {
        assert!(AppVoice::token("").is_empty());
        assert!(!AppVoice::token("calls itself this").is_empty());
    }
}
