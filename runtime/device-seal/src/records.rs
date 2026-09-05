//! THE RULES THE LADDER ENFORCES ON RECORDS IT READS BACK, as pure
//! functions over plain data.
//!
//! Everything here runs natively under `cargo test`. Nothing here names
//! `bindings`: the point of the split is that "absent origin means
//! generated", "a salt that is not 16 bytes is tampering", "an empty
//! passphrase is not a rung" stop being assertions in a browser matrix
//! and become unit tests.
//!
//! The `seal` store rests UNSEALED by design (seal.ts:75-81), so anything
//! else on the origin can write it. A record read back out is therefore
//! untrusted input, and validating its shape before handing it to a
//! ceremony is the whole reason these functions exist.

/// Why the sealing layer refused, as the closed set the WIT
/// `types.seal-code` enum spells (seal.ts `SealError.code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    WrongPassphrase,
    WrongPasskey,
    NoRung,
    AlreadySealed,
    Tampered,
    /// A request refused on principle — an empty passphrase, a KEK handle
    /// with the wrong shape — and also a platform operation that
    /// declined.
    Unsupported,
}

/// A refusal: the code a caller branches on, and THE SENTENCE THE VISOR
/// SHOWS (WIT `types.seal-error`).
///
/// THE SENTENCE IS THIS COMPONENT'S, not the host's. Only the code that
/// knows which refusal this is can say which refusal this is; a host
/// inventing prose from a bare code is how a sheet ends up telling a user
/// "an error occurred" about a wrong passphrase. seal.ts had eleven
/// distinct sentences and the sheets rendered them; they are ported here
/// verbatim, cited per constructor.
///
/// FRAMEWORK VOICE, and the two standing rules: never key material, and
/// never user-typed text. The single interpolation anywhere below is the
/// `sealed` store's KEY NAME, which is a program-chosen string and was
/// already interpolated by seal.ts:829 — not something a person typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: Code,
    pub message: String,
}

impl Refusal {
    fn new(code: Code, message: impl Into<String>) -> Self {
        Refusal {
            code,
            message: message.into(),
        }
    }

    // --- no-rung -------------------------------------------------------

    /// seal.ts:306, 373.
    pub fn no_passphrase_rung() -> Self {
        Self::new(Code::NoRung, "this device has no passphrase rung")
    }

    /// seal.ts:733.
    pub fn no_passkey_rung() -> Self {
        Self::new(Code::NoRung, "this device has no passkey rung")
    }

    /// seal.ts:517.
    pub fn no_platform_rung() -> Self {
        Self::new(
            Code::NoRung,
            "this device has no platform rung to re-key from",
        )
    }

    /// seal.ts:692-695 — the two-authority refusal `enablePrf` makes when
    /// neither door is open.
    pub fn no_prf_authority() -> Self {
        Self::new(
            Code::NoRung,
            "enrolling a passkey needs an authority: this device has no platform rung, \
             and no passphrase was offered",
        )
    }

    /// Nothing is parked: the component is sealed (WIT `sealed`'s header).
    /// seal.ts has no precedent — there the DEK was the caller's to hold,
    /// so "no DEK" was unrepresentable rather than refusable.
    pub fn device_sealed() -> Self {
        Self::new(Code::NoRung, "this device is sealed")
    }

    // --- already-sealed ------------------------------------------------

    /// seal.ts:333.
    pub fn already_sealed() -> Self {
        Self::new(
            Code::AlreadySealed,
            "this device already has a passphrase rung",
        )
    }

    // --- tampered ------------------------------------------------------

    /// seal.ts:531, 556.
    pub fn platform_wrap_did_not_open() -> Self {
        Self::new(Code::Tampered, "the platform wrap did not open")
    }

    /// seal.ts:525, 551.
    pub fn platform_kek_unusable() -> Self {
        Self::new(
            Code::Tampered,
            "the persisted platform key is not a usable non-extractable AES-KW key",
        )
    }

    /// seal.ts:647.
    pub fn prf_record_unreadable() -> Self {
        Self::new(
            Code::Tampered,
            "this device's passkey rung record is not readable",
        )
    }

    /// A record that failed shape validation. `record` names the record in
    /// the store's own vocabulary ("passphrase wrap", "platform wrap") and
    /// is a literal at every call site — never anything read back.
    pub fn record_unreadable(record: &str) -> Self {
        Self::new(Code::Tampered, format!("the {record} record is not readable"))
    }

    /// seal.ts:829. The key name is JSON-quoted exactly as
    /// `JSON.stringify` renders it.
    pub fn sealed_value_did_not_open(key: &str) -> Self {
        Self::new(
            Code::Tampered,
            format!("the sealed value {} did not open", json_quote(key)),
        )
    }

    /// The shape-validation sibling of [`Self::sealed_value_did_not_open`]:
    /// the record is present and is not the shape this layer writes.
    pub fn sealed_value_unreadable(key: &str) -> Self {
        Self::new(
            Code::Tampered,
            format!("the sealed value {} is not readable", json_quote(key)),
        )
    }

    /// sealed-fs.ts:156. That message is prefixed with the FILE NAME,
    /// which does not cross this boundary — `open-file` takes bytes — so
    /// "this file" stands in for the subject the prefix supplied.
    pub fn not_a_sealed_file() -> Self {
        Self::new(Code::Tampered, "this file is not a sealed file")
    }

    /// sealed-fs.ts:165, same substitution as
    /// [`Self::not_a_sealed_file`]. A wrong DEK and altered bytes are the
    /// same event to GCM and are reported as one.
    pub fn file_did_not_open() -> Self {
        Self::new(
            Code::Tampered,
            "this file did not open under this device key (wrong key or altered bytes)",
        )
    }

    // --- unsupported ---------------------------------------------------

    /// seal.ts:359.
    pub fn empty_passphrase() -> Self {
        Self::new(
            Code::Unsupported,
            "an empty passphrase cannot seal a device",
        )
    }

    /// seal.ts:590-592 (`requirePrfKek`). The sentence is seal.ts's; the
    /// CODE is the WIT's `unsupported` rather than the TypeScript's
    /// `tampered` — world.wit:66 names this exact case as `unsupported`'s
    /// reason for existing.
    pub fn prf_kek_unusable() -> Self {
        Self::new(
            Code::Unsupported,
            "the passkey KEK handed to this ceremony is not a usable non-extractable AES-KW key",
        )
    }

    /// The extractability re-check on a pair crossing the identity seam.
    pub fn extractable_identity() -> Self {
        Self::new(
            Code::Unsupported,
            "the stored device identity is extractable and was refused",
        )
    }

    /// The platform declined. Carries the platform's own sentence, which
    /// is prose about an algorithm or a keystore and never key material.
    pub fn platform(message: impl Into<String>) -> Self {
        Self::new(Code::Unsupported, message)
    }

    // --- the two one-bit refusals --------------------------------------

    /// seal.ts:311, 380.
    pub fn wrong_passphrase() -> Self {
        Self::new(
            Code::WrongPassphrase,
            "the passphrase did not open this device",
        )
    }

    /// seal.ts:740.
    pub fn wrong_passkey() -> Self {
        Self::new(Code::WrongPasskey, "that passkey did not open this device")
    }
}

/// Render `s` as a JSON string literal, as `JSON.stringify` does — the
/// quoting seal.ts:829 applied to the key name.
fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Whether anybody knows the passphrase (seal.ts `PassphraseWrap.origin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,
    Generated,
}

// --- the recorded parameters -------------------------------------------------

/// PBKDF2-HMAC-SHA-256 work factor written by THIS version. Read paths
/// take the count from the record instead, so raising this floor later
/// does not orphan existing devices (seal.ts:88-94).
pub const PBKDF2_ITERATIONS: u32 = 600_000;
/// 16 fresh random bytes per wrap (seal.ts:94; NIST SP 800-132's floor).
pub const SALT_BYTES: usize = 16;
/// AES-GCM's nonce, 96 bits, fresh per write (seal.ts:766-770).
pub const IV_BYTES: usize = 12;
/// Both PRF salts — the PRF input and HKDF's salt — are 32 bytes
/// (seal.ts:636-649, PERSISTENCE.md "The derivation, ruled").
pub const PRF_SALT_BYTES: usize = 32;

// --- the rules ---------------------------------------------------------------

/// ABSENT ORIGIN READS AS `generated` (seal.ts:120-125). The failure
/// modes are not symmetric: reading an unmarked rung as reachable risks
/// deleting the last door on a device whose passphrase nobody knows,
/// while reading it as unreachable costs one ceremony nobody needed.
pub fn origin_or_generated(origin: Option<Origin>) -> Origin {
    origin.unwrap_or(Origin::Generated)
}

/// Whether a stored passphrase rung is one a PERSON can walk through —
/// the bit `seal-state.user-passphrase` reports and the bit a ceremony
/// that deletes the platform wrap has to consult.
pub fn is_user_passphrase(origin: Option<Origin>) -> bool {
    origin_or_generated(origin) == Origin::User
}

/// An empty passphrase is the absence of a rung wearing a rung's costume;
/// refuse it at the door rather than derive a KEK anyone can reproduce
/// (seal.ts `requirePassphrase`, 354-361).
pub fn require_passphrase(passphrase: &str) -> Result<(), Refusal> {
    if passphrase.is_empty() {
        return Err(Refusal::empty_passphrase());
    }
    Ok(())
}

/// Shape-check a `wrap:passphrase` record before deriving anything from
/// it.
///
/// CONTRACT: seal.ts's read path (`unsealWithPassphrase`, `wrappableDek`)
/// validates NOTHING here — it feeds `rec.salt` and `rec.iterations`
/// straight to PBKDF2. The WIT pins the field ("16 bytes, fresh per
/// wrap", world.wit:148-149) and the dispatch requires a wrong-length
/// salt to refuse as `tampered`, so this is stricter than the TypeScript.
/// It cannot orphan a real device: every record seal.ts ever wrote
/// carries a 16-byte salt and a nonzero count.
pub fn validate_passphrase_wrap(
    iterations: u32,
    salt: &[u8],
    wrapped: &[u8],
) -> Result<(), Refusal> {
    if salt.len() != SALT_BYTES || iterations == 0 || wrapped.is_empty() {
        return Err(Refusal::record_unreadable("passphrase wrap"));
    }
    Ok(())
}

/// Shape-check a `wrap:platform` record.
///
/// CONTRACT: as above, seal.ts checks only that the record exists; the
/// wrapped bytes being non-empty is the one claim worth making before
/// asking the platform to unwrap them.
pub fn validate_platform_wrap(wrapped: &[u8]) -> Result<(), Refusal> {
    if wrapped.is_empty() {
        return Err(Refusal::record_unreadable("platform wrap"));
    }
    Ok(())
}

/// Shape-check a `wrap:prf` record — seal.ts `readPrfWrap` (636-649),
/// field for field.
///
/// The salts are pinned at the length this construction writes because a
/// planted one-byte PRF input would otherwise reach an authenticator
/// ceremony before anything refused it. `v` and `kdf` are checked on the
/// host side of the seam (world.wit:162-165 fixes `kdf` and reads another
/// tag as `none`), so they do not appear here.
pub fn validate_prf_wrap(
    credential_id: &[u8],
    rp_id: &str,
    prf_input: &[u8],
    hkdf_salt: &[u8],
    wrapped: &[u8],
) -> Result<(), Refusal> {
    let ok = !credential_id.is_empty()
        && !rp_id.is_empty()
        && prf_input.len() == PRF_SALT_BYTES
        && hkdf_salt.len() == PRF_SALT_BYTES
        && !wrapped.is_empty();
    if !ok {
        return Err(Refusal::prf_record_unreadable());
    }
    Ok(())
}

/// Shape-check a `sealed` store value before asking GCM to open it.
///
/// CONTRACT: the WIT pins the IV at 12 bytes (world.wit:177-178);
/// seal.ts passes whatever was stored. A wrong-length IV is a record
/// nothing in this repo wrote, so it is refused as `tampered` rather than
/// handed to the platform — the same fact GCM would report a moment
/// later, reported at the shape check instead.
pub fn validate_sealed_value(key: &str, iv: &[u8], ct: &[u8]) -> Result<(), Refusal> {
    if iv.len() != IV_BYTES || ct.is_empty() {
        return Err(Refusal::sealed_value_unreadable(key));
    }
    Ok(())
}

/// The additional data binding a sealed value to its key name
/// (seal.ts:778-786, 837). Not secret — it is the IndexedDB key, in the
/// clear — but binding it stops an attacker with write access to the
/// namespace moving a valid value from one name to another, a swap that
/// would otherwise be undetectable because every value rests under one
/// DEK.
pub fn sealed_aad(key: &str) -> &[u8] {
    key.as_bytes()
}

/// WHICH RUNGS THIS DEVICE HAS (seal.ts `sealState`, 214-226), asked
/// without opening anything.
///
/// `until_reseal` follows the PLATFORM WRAP alone, not the wrap-and-key
/// pair (seal.ts:223): a wrap whose key has gone missing still reports
/// the rung, and `unseal-from-platform` is where that mismatch surfaces.
pub fn seal_state(
    passphrase: Option<Option<Origin>>,
    platform_wrap: bool,
    prf_wrap: bool,
) -> (bool, bool, bool, bool) {
    let has_passphrase = passphrase.is_some();
    let user = passphrase.is_some_and(is_user_passphrase);
    (has_passphrase, user, platform_wrap, prf_wrap)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- the refusal sentences ------------------------------------------
    //
    // The visor renders these, so an empty one is a blank sheet and a
    // wrong code is a sheet offering the wrong door. Both are checked for
    // every constructor, together, because they are one fact.

    /// Every constructor, paired with the code it must report. Adding a
    /// constructor without adding it here leaves it unchecked, so the
    /// list is the inventory as well as the test.
    fn every_refusal() -> Vec<(&'static str, Refusal, Code)> {
        vec![
            ("no_passphrase_rung", Refusal::no_passphrase_rung(), Code::NoRung),
            ("no_passkey_rung", Refusal::no_passkey_rung(), Code::NoRung),
            ("no_platform_rung", Refusal::no_platform_rung(), Code::NoRung),
            ("no_prf_authority", Refusal::no_prf_authority(), Code::NoRung),
            ("device_sealed", Refusal::device_sealed(), Code::NoRung),
            ("already_sealed", Refusal::already_sealed(), Code::AlreadySealed),
            (
                "platform_wrap_did_not_open",
                Refusal::platform_wrap_did_not_open(),
                Code::Tampered,
            ),
            (
                "platform_kek_unusable",
                Refusal::platform_kek_unusable(),
                Code::Tampered,
            ),
            (
                "prf_record_unreadable",
                Refusal::prf_record_unreadable(),
                Code::Tampered,
            ),
            (
                "record_unreadable",
                Refusal::record_unreadable("passphrase wrap"),
                Code::Tampered,
            ),
            (
                "sealed_value_did_not_open",
                Refusal::sealed_value_did_not_open("keyhive/archive"),
                Code::Tampered,
            ),
            (
                "sealed_value_unreadable",
                Refusal::sealed_value_unreadable("keyhive/archive"),
                Code::Tampered,
            ),
            ("not_a_sealed_file", Refusal::not_a_sealed_file(), Code::Tampered),
            ("file_did_not_open", Refusal::file_did_not_open(), Code::Tampered),
            ("empty_passphrase", Refusal::empty_passphrase(), Code::Unsupported),
            ("prf_kek_unusable", Refusal::prf_kek_unusable(), Code::Unsupported),
            (
                "extractable_identity",
                Refusal::extractable_identity(),
                Code::Unsupported,
            ),
            (
                "platform",
                Refusal::platform("the platform declined to derive a key"),
                Code::Unsupported,
            ),
            ("wrong_passphrase", Refusal::wrong_passphrase(), Code::WrongPassphrase),
            ("wrong_passkey", Refusal::wrong_passkey(), Code::WrongPasskey),
        ]
    }

    #[test]
    fn every_refusal_carries_a_sentence_and_the_code_its_site_means() {
        for (name, refusal, code) in every_refusal() {
            assert_eq!(refusal.code, code, "{name} reports the wrong code");
            assert!(
                !refusal.message.trim().is_empty(),
                "{name} has no sentence for the visor to render"
            );
        }
    }

    #[test]
    fn the_sentences_are_framework_voice_not_shouting_or_prefixes() {
        // A sentence is rendered as-is in a sheet: no trailing
        // punctuation to double up, no leading capital to fight the
        // surrounding copy, no stray whitespace, and no `SealError:`-style
        // prefix left over from a thrown exception.
        for (name, refusal, _) in every_refusal() {
            let m = &refusal.message;
            assert_eq!(m.trim(), m, "{name} has stray whitespace");
            assert!(!m.ends_with('.'), "{name} ends with a full stop");
            assert!(
                !m.contains("Error") && !m.contains("error:"),
                "{name} carries an exception prefix"
            );
            assert!(
                m.chars().next().is_some_and(|c| !c.is_uppercase()),
                "{name} starts with a capital"
            );
        }
    }

    #[test]
    fn the_ported_sentences_are_seal_ts_word_for_word() {
        // The visor's copy is these strings; a paraphrase here is a
        // silent copy change. Cited sites are in the constructors.
        assert_eq!(
            Refusal::already_sealed().message,
            "this device already has a passphrase rung"
        );
        assert_eq!(
            Refusal::no_passphrase_rung().message,
            "this device has no passphrase rung"
        );
        assert_eq!(
            Refusal::no_passkey_rung().message,
            "this device has no passkey rung"
        );
        assert_eq!(
            Refusal::no_platform_rung().message,
            "this device has no platform rung to re-key from"
        );
        assert_eq!(
            Refusal::empty_passphrase().message,
            "an empty passphrase cannot seal a device"
        );
        assert_eq!(
            Refusal::wrong_passphrase().message,
            "the passphrase did not open this device"
        );
        assert_eq!(
            Refusal::wrong_passkey().message,
            "that passkey did not open this device"
        );
        assert_eq!(
            Refusal::platform_wrap_did_not_open().message,
            "the platform wrap did not open"
        );
        assert_eq!(
            Refusal::platform_kek_unusable().message,
            "the persisted platform key is not a usable non-extractable AES-KW key"
        );
        assert_eq!(
            Refusal::prf_record_unreadable().message,
            "this device's passkey rung record is not readable"
        );
        assert_eq!(
            Refusal::prf_kek_unusable().message,
            "the passkey KEK handed to this ceremony is not a usable non-extractable AES-KW key"
        );
    }

    #[test]
    fn the_sealed_key_name_is_json_quoted_as_seal_ts_quoted_it() {
        // seal.ts:829 interpolated `JSON.stringify(key)`. The key is a
        // program-chosen store key, never user-typed text.
        assert_eq!(
            Refusal::sealed_value_did_not_open("keyhive/archive").message,
            r#"the sealed value "keyhive/archive" did not open"#
        );
        assert_eq!(
            Refusal::sealed_value_unreadable("visor/cache").message,
            r#"the sealed value "visor/cache" is not readable"#
        );
    }

    #[test]
    fn json_quoting_escapes_what_json_stringify_escapes() {
        assert_eq!(json_quote("plain"), r#""plain""#);
        assert_eq!(json_quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(json_quote(r"a\b"), r#""a\\b""#);
        assert_eq!(json_quote("a\nb"), r#""a\nb""#);
        assert_eq!(json_quote("a\u{1}b"), r#""a\u0001b""#);
    }

    #[test]
    fn a_named_record_refusal_names_the_record() {
        assert_eq!(
            Refusal::record_unreadable("platform wrap").message,
            "the platform wrap record is not readable"
        );
    }

    #[test]
    fn a_platform_decline_carries_the_platforms_own_sentence() {
        // The platform's prose is about an algorithm or a keystore; the
        // component neither rewrites it nor invents one over it.
        let refusal = Refusal::platform("aes-kw unwrap is not supported by this provider");
        assert_eq!(refusal.code, Code::Unsupported);
        assert_eq!(
            refusal.message,
            "aes-kw unwrap is not supported by this provider"
        );
    }

    #[test]
    fn absent_origin_reads_as_generated() {
        assert_eq!(origin_or_generated(None), Origin::Generated);
        assert!(!is_user_passphrase(None));
    }

    #[test]
    fn a_recorded_origin_is_taken_at_its_word() {
        assert_eq!(origin_or_generated(Some(Origin::User)), Origin::User);
        assert!(is_user_passphrase(Some(Origin::User)));
        assert!(!is_user_passphrase(Some(Origin::Generated)));
    }

    #[test]
    fn refuses_an_empty_passphrase_as_unsupported() {
        assert_eq!(require_passphrase(""), Err(Refusal::empty_passphrase()));
        assert_eq!(require_passphrase(" "), Ok(()));
        assert_eq!(require_passphrase("a passphrase"), Ok(()));
    }

    #[test]
    fn accepts_a_passphrase_wrap_of_the_shape_this_version_writes() {
        // Obviously-synthetic stand-ins: an all-zero 16-byte salt and a
        // 40-byte all-zero wrap (AES-KW of a 256-bit key is 40 bytes).
        assert_eq!(
            validate_passphrase_wrap(PBKDF2_ITERATIONS, &[0u8; SALT_BYTES], &[0u8; 40]),
            Ok(())
        );
    }

    #[test]
    fn refuses_a_record_whose_salt_is_not_16_bytes_as_tampered() {
        for len in [0usize, 1, 8, 15, 17, 32] {
            assert_eq!(
                validate_passphrase_wrap(PBKDF2_ITERATIONS, &vec![0u8; len], &[0u8; 40]),
                Err(Refusal::record_unreadable("passphrase wrap")),
                "a {len}-byte salt was accepted"
            );
        }
    }

    #[test]
    fn refuses_a_zero_iteration_count_and_an_empty_wrap_as_tampered() {
        assert_eq!(
            validate_passphrase_wrap(0, &[0u8; SALT_BYTES], &[0u8; 40]),
            Err(Refusal::record_unreadable("passphrase wrap"))
        );
        assert_eq!(
            validate_passphrase_wrap(PBKDF2_ITERATIONS, &[0u8; SALT_BYTES], &[]),
            Err(Refusal::record_unreadable("passphrase wrap"))
        );
    }

    #[test]
    fn reads_the_iteration_count_from_the_record_not_the_constant() {
        // A device written under an older floor still validates: the
        // count is recorded precisely so raising the constant does not
        // orphan it.
        assert_eq!(
            validate_passphrase_wrap(100_000, &[0u8; SALT_BYTES], &[0u8; 40]),
            Ok(())
        );
    }

    #[test]
    fn refuses_an_empty_platform_wrap_as_tampered() {
        assert_eq!(validate_platform_wrap(&[0u8; 40]), Ok(()));
        assert_eq!(
            validate_platform_wrap(&[]),
            Err(Refusal::record_unreadable("platform wrap"))
        );
    }

    /// The shape `enablePrf` writes, with obviously-synthetic salts.
    fn good_prf() -> (Vec<u8>, String, Vec<u8>, Vec<u8>, Vec<u8>) {
        (
            vec![1u8; 16],
            "localhost".to_string(),
            vec![0u8; PRF_SALT_BYTES],
            vec![0u8; PRF_SALT_BYTES],
            vec![0u8; 40],
        )
    }

    #[test]
    fn accepts_a_prf_record_of_the_shape_enrollment_writes() {
        let (c, r, p, h, w) = good_prf();
        assert_eq!(validate_prf_wrap(&c, &r, &p, &h, &w), Ok(()));
    }

    #[test]
    fn refuses_a_prf_record_whose_salts_are_not_32_bytes_as_tampered() {
        let (c, r, _, h, w) = good_prf();
        // A planted one-byte PRF input must refuse HERE, before an
        // authenticator is ever asked to evaluate it.
        for len in [0usize, 1, 31, 33] {
            assert_eq!(
                validate_prf_wrap(&c, &r, &vec![0u8; len], &h, &w),
                Err(Refusal::prf_record_unreadable()),
                "a {len}-byte prf input was accepted"
            );
        }
        let (c, r, p, _, w) = good_prf();
        for len in [0usize, 1, 31, 33] {
            assert_eq!(
                validate_prf_wrap(&c, &r, &p, &vec![0u8; len], &w),
                Err(Refusal::prf_record_unreadable()),
                "a {len}-byte hkdf salt was accepted"
            );
        }
    }

    #[test]
    fn refuses_a_prf_record_missing_its_credential_rp_id_or_wrap() {
        let (c, r, p, h, w) = good_prf();
        assert_eq!(
            validate_prf_wrap(&[], &r, &p, &h, &w),
            Err(Refusal::prf_record_unreadable())
        );
        assert_eq!(
            validate_prf_wrap(&c, "", &p, &h, &w),
            Err(Refusal::prf_record_unreadable())
        );
        assert_eq!(
            validate_prf_wrap(&c, &r, &p, &h, &[]),
            Err(Refusal::prf_record_unreadable())
        );
    }

    #[test]
    fn a_prf_record_carries_no_origin_so_a_prf_rung_is_always_reachable() {
        // The rule is structural: `validate_prf_wrap` has no origin
        // parameter to consult, and `seal_state` reports `prf` from the
        // record's presence alone.
        let (_, _, _, _, _) = good_prf();
        let (_, _, _, prf) = seal_state(None, false, true);
        assert!(prf);
    }

    #[test]
    fn refuses_a_sealed_value_whose_iv_is_not_12_bytes_as_tampered() {
        assert_eq!(
            validate_sealed_value("k", &[0u8; IV_BYTES], &[0u8; 17]),
            Ok(())
        );
        for len in [0usize, 11, 13, 16] {
            assert_eq!(
                validate_sealed_value("k", &vec![0u8; len], &[0u8; 17]),
                Err(Refusal::sealed_value_unreadable("k")),
                "a {len}-byte iv was accepted"
            );
        }
    }

    #[test]
    fn refuses_a_sealed_value_with_no_ciphertext_as_tampered() {
        // Even an empty plaintext seals to at least a 16-byte tag, so an
        // empty `ct` is a record nothing here wrote.
        assert_eq!(
            validate_sealed_value("k", &[0u8; IV_BYTES], &[]),
            Err(Refusal::sealed_value_unreadable("k"))
        );
    }

    #[test]
    fn the_key_name_is_the_additional_data() {
        assert_eq!(sealed_aad("keyhive/archive"), b"keyhive/archive");
        assert_eq!(sealed_aad(""), b"");
    }

    #[test]
    fn seal_state_reports_existence_and_reachability_separately() {
        // A T0 device: a passphrase rung exists, nobody knows it.
        let (passphrase, user, until_reseal, prf) =
            seal_state(Some(Some(Origin::Generated)), true, false);
        assert!(passphrase && !user && until_reseal && !prf);

        // The same device after `rekey-from-platform`.
        let (passphrase, user, ..) = seal_state(Some(Some(Origin::User)), true, false);
        assert!(passphrase && user);

        // An unmarked rung reads as unreachable.
        let (passphrase, user, ..) = seal_state(Some(None), false, false);
        assert!(passphrase && !user);

        // A device with nothing.
        assert_eq!(seal_state(None, false, false), (false, false, false, false));
    }
}
