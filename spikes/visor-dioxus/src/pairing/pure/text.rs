//! HOW A PAIRING CODE IS CHUNKED FOR A HUMAN TO READ OUT AND TYPE IN.
//!
//! The one part of `render.rs` with a rule worth stating on its own, split out
//! here so it can be tested natively (see this directory's header). `render.rs`
//! keeps the rendering; this keeps the arithmetic.

/// GROUPS OF FOUR (`visor/ui/pairing.ts:83-85`). The 79-character code is read
/// aloud and transcribed by a human on another device, so it is chunked.
const GROUP: usize = 4;

/// A trailing partial group is KEPT AS IS rather than padded — the code is what
/// it is, and a padded group would be transcribed with the padding.
///
/// Chunked over BYTES, matching the TypeScript's `slice`. A pairing code is
/// backend-generated from a restricted alphabet, so bytes and characters
/// coincide; `from_utf8_lossy` is the honest way to say "if that ever stops
/// being true, do not panic in the middle of a live ceremony".
pub fn group(code: &str) -> String {
    code.as_bytes()
        .chunks(GROUP)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::group;

    /// The chunking a human transcribes from. All-synthetic input.
    #[test]
    fn groups_of_four_with_a_short_tail() {
        assert_eq!(group("0123456789"), "0123 4567 89");
        assert_eq!(group("01234567"), "0123 4567");
        assert_eq!(group("012"), "012");
        assert_eq!(group(""), "");
    }
}
