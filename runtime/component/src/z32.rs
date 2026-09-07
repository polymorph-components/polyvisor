//! z-base-32, iroh's spelling of an endpoint id.
//!
//! `polymorph:iroh/types.endpoint-id` is 32 raw bytes — an Ed25519 public
//! key — and `polyvisor:internal/device.device-status.endpoint-id` is the
//! text a person copies and another device dials, "z-base-32, iroh's
//! spelling". So the conversion is ours to do, and it has to be iroh's,
//! byte for byte: an id in another alphabet is an id no iroh peer can parse.
//!
//! iroh has two spellings and this is deliberately the second one:
//! `PublicKey`'s `Display`/`FromStr` are hex and RFC 4648 base32, while
//! `PublicKey::to_z32`/`from_z32` are z-base-32 — the human-oriented
//! alphabet pkarr uses for endpoint-id domain names
//! (iroh-base-1.1.0/src/key.rs:19-22, :162-175). The alphabet below is
//! transcribed from that constant, and the bit order is `data_encoding`'s
//! default, most-significant-first (iroh builds the encoding with
//! `new_encoding! { symbols: ... }` and overrides nothing else).
//!
//! Padding: none, and 32 bytes is 256 bits, which is 51 whole symbols plus
//! one bit. The 52nd symbol carries that bit in its high position and four
//! zero bits below it, and `data_encoding` rejects a decode whose trailing
//! bits are not zero (`check_trailing_bits` defaults to true). [`decode`]
//! does the same: an id that differs only in bits nobody encoded is not a
//! second spelling of the same key, it is a typo.

/// iroh-base-1.1.0/src/key.rs:20 — `Z_BASE_32`'s symbols.
const ALPHABET: &[u8; 32] = b"ybndrfg8ejkmcpqxot1uwisza345h769";

/// z-base-32 of `bytes`, most-significant bit first, unpadded.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in bytes {
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        // The leftover bits sit in the symbol's HIGH positions, zero-filled
        // below — the same place `data_encoding` puts them.
        out.push(ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// The inverse. `Err` carries a framework-voice reason, because the only
/// caller is `sync.connect`, whose argument is text a person pasted.
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    for symbol in text.bytes() {
        let value = ALPHABET
            .iter()
            .position(|&c| c == symbol)
            .ok_or_else(|| format!("{:?} is not part of an endpoint id", symbol as char))?;
        acc = (acc << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    // Whatever is left is shorter than a byte: it must be the zero padding
    // `encode` wrote, or the text is not an encoding of these bytes.
    if bits >= 5 || acc & ((1 << bits) - 1) != 0 {
        return Err("this endpoint id is not a whole number of bytes".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The alphabet is the whole contract; a rotated or reordered one still
    /// round-trips through this module and matches nothing iroh prints.
    #[test]
    fn alphabet_is_irohs() {
        assert_eq!(ALPHABET, b"ybndrfg8ejkmcpqxot1uwisza345h769");
        // Every symbol distinct, or decode is ambiguous.
        let mut seen = ALPHABET.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 32);
    }

    /// The all-zero key: 51 symbols of the zero digit plus the padding
    /// symbol, which is the zero digit too. 32 bytes is 52 symbols.
    #[test]
    fn all_zero_key() {
        let text = encode(&[0u8; 32]);
        assert_eq!(text.len(), 52);
        assert_eq!(text, "y".repeat(52));
        assert_eq!(decode(&text).unwrap(), vec![0u8; 32]);
    }

    /// The bit order is most-significant-first: byte `0xff` is five ones
    /// (symbol 31, `9`) then three ones in the HIGH positions of the next
    /// symbol (`0b11100` = 28, `h`). A least-significant-first reading of
    /// the same bytes produces different text, which is the mistake this
    /// pins against.
    #[test]
    fn most_significant_bit_first() {
        assert_eq!(encode(&[0xff]), "9h");
        assert_eq!(encode(&[0x00, 0xff]), "yd9o");
    }

    #[test]
    fn round_trips_an_obviously_synthetic_key() {
        let key: Vec<u8> = (0u8..32).collect();
        let text = encode(&key);
        assert_eq!(text.len(), 52);
        assert_eq!(decode(&text).unwrap(), key);
    }

    #[test]
    fn rejects_a_foreign_symbol() {
        // `l`, `v`, `2` and `0` are the symbols z-base-32 leaves out.
        for bad in ["l", "v", "2", "0", "A", " "] {
            let text = format!("{}{}", "y".repeat(51), bad);
            assert!(decode(&text).is_err(), "{bad} should not decode");
        }
    }

    #[test]
    fn rejects_nonzero_trailing_bits() {
        // 51 symbols is 255 bits — not a whole number of bytes.
        assert!(decode(&"y".repeat(51)).is_err());
        // 52 symbols whose last carries bits below the one real bit.
        let text = format!("{}{}", "y".repeat(51), ALPHABET[1] as char);
        assert!(decode(&text).is_err());
    }

    #[test]
    fn empty_is_empty() {
        assert_eq!(encode(&[]), "");
        assert_eq!(decode("").unwrap(), Vec::<u8>::new());
    }
}
