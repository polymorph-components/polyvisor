//! The one spelling of a glyph throughout the visor.

use unicode_segmentation::UnicodeSegmentation;

const ANIMAL_FIRST: u32 = 0x1f400;
const ANIMAL_COUNT: u32 = 64;

/// Choose one of the 64 animal characters U+1F400..U+1F43F.
///
/// When `previous` is in that range, map over the other 63 rather than
/// retrying: a roll is synchronous and is guaranteed to change.
pub(crate) fn roll_animal(random: u32, previous: &str) -> String {
    let previous = previous
        .chars()
        .next()
        .filter(|_| previous.chars().count() == 1)
        .map(u32::from)
        .filter(|code| (ANIMAL_FIRST..ANIMAL_FIRST + ANIMAL_COUNT).contains(code));
    let offset = match previous {
        Some(code) => {
            let previous_offset = code - ANIMAL_FIRST;
            let candidate = random % (ANIMAL_COUNT - 1);
            candidate + u32::from(candidate >= previous_offset)
        }
        None => random % ANIMAL_COUNT,
    };
    char::from_u32(ANIMAL_FIRST + offset)
        .expect("the animal emoji range contains Unicode scalar values")
        .to_string()
}

/// Strip leading Unicode whitespace and retain one extended grapheme.
///
/// There is deliberately no normalization and no trailing trim: the first
/// grapheme is copied byte-for-byte from what the user supplied.
pub(crate) fn normalize_glyph(value: &str) -> &str {
    value.trim_start().graphemes(true).next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::{normalize_glyph, roll_animal};

    #[test]
    fn animal_roll_covers_range_boundaries_and_skips_previous() {
        assert_eq!(roll_animal(0, ""), "\u{1f400}");
        assert_eq!(roll_animal(63, ""), "\u{1f43f}");
        assert_eq!(roll_animal(64, ""), "\u{1f400}");
        assert_eq!(roll_animal(0, "\u{1f400}"), "\u{1f401}");
        assert_eq!(roll_animal(62, "\u{1f43f}"), "\u{1f43e}");
        for previous in 0..64 {
            let old = char::from_u32(0x1f400 + previous).unwrap().to_string();
            let rolls: std::collections::BTreeSet<_> =
                (0..63).map(|random| roll_animal(random, &old)).collect();
            assert_eq!(rolls.len(), 63);
            assert!(!rolls.contains(&old));
            assert!(rolls.iter().all(|glyph| {
                let code = u32::from(glyph.chars().next().unwrap());
                (0x1f400..=0x1f43f).contains(&code)
            }));
        }
    }

    #[test]
    fn keeps_one_extended_grapheme_after_leading_space() {
        let cases = [
            ("", ""),
            (" \u{a0}x", "x"),
            (" \u{a0}\t", ""),
            ("x trailing", "x"),
            ("e\u{301}x", "e\u{301}"),
            (
                "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}x",
                "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}",
            ),
            (
                "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}x",
                "\u{1f469}\u{1f3fd}\u{200d}\u{1f4bb}",
            ),
            ("\u{1f44d}\u{1f3ff}x", "\u{1f44d}\u{1f3ff}"),
            ("\u{1f1f3}\u{1f1ff}x", "\u{1f1f3}\u{1f1ff}"),
            ("1\u{fe0f}\u{20e3}x", "1\u{fe0f}\u{20e3}"),
            ("\u{2708}\u{fe0f}x", "\u{2708}\u{fe0f}"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_glyph(input), expected, "input {input:?}");
        }
    }
}
