//! PMSEALv1 — the per-file sealed format, ported from
//! runtime/device-store/sealed-fs.ts (the `MAGIC`/`HEADER`/`OVERHEAD`
//! constants at lines 120-131, `sealBytes` at 139-147, `openBytes` at
//! 149-167).
//!
//! BYTE-FOR-BYTE COMPATIBILITY IS THE REQUIREMENT, not a convenience: a
//! file written by sealed-fs.ts must open here and a file written here
//! must open there (world.wit:35-41, 320-328). Everything in this module
//! is the framing; the AEAD itself is the platform's and lives in
//! `src/component.rs`.
//!
//! The layout:
//!
//! ```text
//!   0                8               20                        len
//!   +----------------+---------------+-------------------------+
//!   | "PMSEALv1"     | IV (12 bytes) | ciphertext ‖ GCM tag    |
//!   +----------------+---------------+-------------------------+
//! ```

use crate::records::Refusal;

/// `PMSEALv1`, 8 ASCII bytes. Present so a file that is NOT sealed is
/// diagnosed as such instead of decrypted into noise (sealed-fs.ts:120).
pub const MAGIC: &[u8; 8] = b"PMSEALv1";
/// AES-GCM's nonce, fresh per commit of a file (sealed-fs.ts:121).
pub const IV_BYTES: usize = 12;
/// magic ‖ iv.
pub const HEADER: usize = MAGIC.len() + IV_BYTES;
/// AES-GCM's tag, trailing the ciphertext.
pub const TAG_BYTES: usize = 16;
/// What an empty file costs once sealed (sealed-fs.ts:124).
pub const OVERHEAD: usize = HEADER + TAG_BYTES;

/// THE ADDITIONAL DATA IS THE MAGIC, NOT THE WHOLE HEADER
/// (sealed-fs.ts:127-131, world.wit:321-324).
///
/// The magic is bound as AAD so an unsealed file cannot pass as a sealed
/// one and the version cannot be downgraded by an editor of the raw
/// bytes. The IV is not in the AAD because it does not need to be: GCM
/// authenticates its own nonce, so altering it fails the tag anyway.
pub const AAD: &[u8] = MAGIC;

/// The 20-byte header for a fresh write. Panics on a wrong-length IV,
/// which is a caller bug: the only producer is the platform CSPRNG asked
/// for exactly [`IV_BYTES`].
pub fn header(iv: &[u8]) -> [u8; HEADER] {
    assert_eq!(iv.len(), IV_BYTES, "PMSEALv1 iv must be 12 bytes");
    let mut out = [0u8; HEADER];
    out[..MAGIC.len()].copy_from_slice(MAGIC);
    out[MAGIC.len()..].copy_from_slice(iv);
    out
}

/// Frame a sealed body (ciphertext ‖ tag) behind its header — the
/// `sealBytes` tail (sealed-fs.ts:143-146).
///
/// NOTE THE EMPTY CASE: sealing an empty plaintext produces a full
/// [`OVERHEAD`]-byte file, because `sealBytes` has no empty special case.
/// Only the READ side treats zero length as an empty file (see
/// [`parse`]); the asymmetry is sealed-fs.ts's and is preserved.
pub fn frame(iv: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + body.len());
    out.extend_from_slice(&header(iv));
    out.extend_from_slice(body);
    out
}

/// What a sealed file's raw bytes are, once the framing is checked.
#[derive(Debug, PartialEq, Eq)]
pub enum Framed<'a> {
    /// A ZERO-LENGTH FILE IS AN EMPTY FILE, not a broken one: the OPFS
    /// provider's `openAt` creates the entry before anything is written
    /// to it, so a legitimately empty file has no header at all
    /// (sealed-fs.ts:149-153).
    Empty,
    /// The IV and the body (ciphertext ‖ tag) to hand to GCM.
    Sealed { iv: &'a [u8], body: &'a [u8] },
}

/// Check the framing of a file read back.
///
/// Bad magic and a short header are `tampered`, exactly as a GCM failure
/// is (world.wit:302-304): "not a sealed file" and "a sealed file that
/// was altered" are the same refusal to a caller and neither tells it
/// anything about the other.
pub fn parse(raw: &[u8]) -> Result<Framed<'_>, Refusal> {
    if raw.is_empty() {
        return Ok(Framed::Empty);
    }
    if raw.len() < OVERHEAD || &raw[..MAGIC.len()] != MAGIC {
        return Err(Refusal::not_a_sealed_file());
    }
    Ok(Framed::Sealed {
        iv: &raw[MAGIC.len()..HEADER],
        body: &raw[HEADER..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An obviously-synthetic IV: the byte sequence 00 01 02 … 0b.
    fn iv() -> Vec<u8> {
        (0u8..IV_BYTES as u8).collect()
    }

    #[test]
    fn the_known_layout_is_magic_then_iv_then_body() {
        assert_eq!(MAGIC.len(), 8);
        assert_eq!(HEADER, 20);
        assert_eq!(OVERHEAD, 36);

        let body = vec![0xAA; 5 + TAG_BYTES];
        let out = frame(&iv(), &body);
        assert_eq!(out.len(), HEADER + body.len());
        assert_eq!(&out[0..8], b"PMSEALv1");
        assert_eq!(&out[8..20], iv().as_slice());
        assert_eq!(&out[20..], body.as_slice());
    }

    #[test]
    fn the_additional_data_is_the_eight_magic_bytes() {
        // sealed-fs.ts:127-131, world.wit:322-324. Not the 20-byte
        // header: the IV is authenticated by GCM's own use of it.
        assert_eq!(AAD, b"PMSEALv1");
        assert_eq!(AAD.len(), 8);
    }

    #[test]
    fn a_zero_length_file_is_an_empty_file_not_a_broken_one() {
        assert_eq!(parse(&[]), Ok(Framed::Empty));
    }

    #[test]
    fn round_trips_the_framing_it_writes() {
        let body = vec![0x11; 3 + TAG_BYTES];
        let out = frame(&iv(), &body);
        match parse(&out).expect("framing rejected its own output") {
            Framed::Sealed { iv: got_iv, body: got_body } => {
                assert_eq!(got_iv, iv().as_slice());
                assert_eq!(got_body, body.as_slice());
            }
            Framed::Empty => panic!("a framed file parsed as empty"),
        }
    }

    #[test]
    fn an_empty_plaintext_still_costs_a_full_header_and_tag() {
        // `sealBytes` has no empty special case, so an empty file the
        // guest actually wrote is 36 bytes on disk, and opens back to
        // nothing. Only a file that was never written is zero length.
        let out = frame(&iv(), &[0u8; TAG_BYTES]);
        assert_eq!(out.len(), OVERHEAD);
        assert!(matches!(parse(&out), Ok(Framed::Sealed { .. })));
    }

    #[test]
    fn refuses_a_file_whose_magic_is_not_pmsealv1_as_tampered() {
        // An unsealed file is diagnosed as such rather than decrypted
        // into noise.
        let plain = b"a plain text file long enough to clear the overhead...".to_vec();
        assert_eq!(parse(&plain), Err(Refusal::not_a_sealed_file()));

        // The version cannot be downgraded by an editor of the raw bytes:
        // the magic is authenticated as AAD, and refused here besides.
        let mut downgraded = frame(&iv(), &[0u8; TAG_BYTES]);
        downgraded[7] = b'0';
        assert_eq!(parse(&downgraded), Err(Refusal::not_a_sealed_file()));
    }

    #[test]
    fn refuses_a_file_too_short_to_hold_a_header_and_tag_as_tampered() {
        let full = frame(&iv(), &[0u8; TAG_BYTES]);
        for len in 1..OVERHEAD {
            assert_eq!(
                parse(&full[..len]),
                Err(Refusal::not_a_sealed_file()),
                "a {len}-byte file was accepted"
            );
        }
    }

    #[test]
    #[should_panic(expected = "PMSEALv1 iv must be 12 bytes")]
    fn framing_refuses_a_wrong_length_iv() {
        let _ = header(&[0u8; 11]);
    }
}
