//! The one spelling of a glyph throughout the visor.

use unicode_segmentation::UnicodeSegmentation;

/// Strip leading Unicode whitespace and retain one extended grapheme.
///
/// There is deliberately no normalization and no trailing trim: the first
/// grapheme is copied byte-for-byte from what the user supplied.
pub(crate) fn normalize_glyph(value: &str) -> &str {
    value.trim_start().graphemes(true).next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::normalize_glyph;

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
