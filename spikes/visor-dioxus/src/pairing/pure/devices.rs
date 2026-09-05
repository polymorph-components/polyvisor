//! THE ACCOUNT'S DEVICE LIST, shaped for the row `add.rs` draws once
//! enrollment lands. The port of `renderDevices` (`visor/ui/pairing.ts:713-722`)
//! and its one call site (:859) — see `add.rs`'s `EnrolledDevices` for the
//! rest of the story (the fetch, the silent-on-failure rule, the rendering).
//!
//! Pure by the same discipline as this directory's other files (`pure/mod.rs`'s
//! header): the shaping decision — which half of a row is the word the user
//! typed and which half is the visor describing the record — names no binding
//! and belongs here so it runs under `cargo test` rather than merely
//! typechecking.
//!
//! # THE TWO VOICES IN ONE ROW, and why the split happens here rather than at
//! the render site
//!
//! `pairing.ts:719` builds the row as one interpolated string:
//! `` `${d.name || "(unnamed)"}${d.revoked ? " — revoked" : ""}` ``. That is
//! exactly the thing `visor/README.md`'s three-voices table exists to make
//! visible as a mistake: `d.name` is the word the admitting user typed for
//! this very device, moments earlier, in this ceremony's own name field
//! (wit/world.wit's `pair-add-confirm` doc: typed by the user, never
//! prefilled) — USER VOICE. `"(unnamed)"` and `" — revoked"` are the visor
//! describing the record when there is no user word, or qualifying it — the
//! visor's own words, i.e. FRAMEWORK VOICE. Concatenating them into one
//! string is how a `q.foreign`-shaped bug gets built one wave at a time: the
//! type that keeps a user-voice word out of an announcement
//! (`crate::voice::UserVoice`) only helps if callers stop before they reach
//! for `format!` to join it with something else.
//!
//! So [`DeviceRow`] keeps the two apart: `name` is `Some` only for a real,
//! trimmed, non-empty word (never fabricated — the same rule
//! `crate::voice::UserVoice::new` enforces), and it is `add.rs`'s job to
//! render it through `UserVoice`/`.who` and render the framework-voice
//! fallback and qualifier as separate framework-voice text alongside it.

use crate::voice::NAME_MAX;

/// ONE ROW OF THE ACCOUNT'S DEVICE LIST, split into its two voices.
///
/// `name: None` means the account's record for this device carries no word —
/// either the field is genuinely empty or (defensively) whitespace-only, the
/// same "blank is unset" rule `crate::voice::UserVoice::new` applies to every
/// hand-editable record in this crate. The caller renders that case as the
/// framework-voice `"(unnamed)"` (pairing.ts:719); this module never invents
/// the word itself, only reports its absence.
#[derive(Clone, PartialEq, Debug)]
pub struct DeviceRow {
    pub name: Option<String>,
    pub revoked: bool,
}

/// ONE DEVICE, SHAPED. Trims and clamps at `NAME_MAX` — this crate's cap on
/// every cross-device word (`us.rs`'s `device_word`, `voice.rs`'s
/// `UserVoice::new`) — because a device record can arrive from another
/// build, or a partition another device wrote to directly, and the strip's
/// row must not be stretchable by either.
pub fn device_row(name: &str, revoked: bool) -> DeviceRow {
    let trimmed = name.trim();
    DeviceRow {
        name: if trimmed.is_empty() { None } else { Some(trimmed.chars().take(NAME_MAX).collect()) },
        revoked,
    }
}

/// THE WHOLE LIST, shaped. `add.rs` maps the driver's `us-device` records
/// down to `(name, revoked)` pairs at the one seam that touches the
/// generated binding, so nothing in this module ever names it.
pub fn device_rows<'a>(devices: impl Iterator<Item = (&'a str, bool)>) -> Vec<DeviceRow> {
    devices.map(|(name, revoked)| device_row(name, revoked)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE UNNAMED BRANCH: a blank name is reported as absence, never
    /// fabricated into a placeholder word — `add.rs` supplies the
    /// framework-voice `"(unnamed)"` itself.
    #[test]
    fn a_blank_name_is_reported_as_absent() {
        assert_eq!(device_row("", false).name, None);
        assert_eq!(device_row("   ", false).name, None);
    }

    /// THE NAMED BRANCH: a real word survives trimmed, and is kept apart from
    /// the revoked qualifier — `revoked` is its own field, not folded into
    /// the string, which is the whole point of the split.
    #[test]
    fn a_real_name_is_kept_trimmed_and_separate_from_the_revoked_flag() {
        let row = device_row("  the laptop  ", true);
        assert_eq!(row.name.as_deref(), Some("the laptop"));
        assert!(row.revoked);
    }

    /// A cross-device name must not be able to stretch the row — the same cap
    /// every other cross-device word in this crate obeys.
    #[test]
    fn a_long_cross_device_name_is_clamped() {
        let long = "x".repeat(NAME_MAX * 3);
        let row = device_row(&long, false);
        assert_eq!(row.name.unwrap().chars().count(), NAME_MAX);
    }

    /// THE WHOLE LIST, in order, both branches represented — the two gates
    /// the e2e is asked to exercise.
    #[test]
    fn the_list_preserves_order_and_both_branches() {
        let input = [("Ada's laptop", false), ("", true), ("phone", false)];
        let rows = device_rows(input.into_iter());
        assert_eq!(
            rows,
            vec![
                DeviceRow { name: Some("Ada's laptop".into()), revoked: false },
                DeviceRow { name: None, revoked: true },
                DeviceRow { name: Some("phone".into()), revoked: false },
            ]
        );
    }
}
