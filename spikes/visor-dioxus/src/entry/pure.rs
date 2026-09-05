//! THE ENTRY CEREMONIES' PURE HALF: row shape, the initial-action rule and the
//! "never used" wording — everything checkable with no binding, no DOM and no
//! clock underneath it.
//!
//! # CONTRACT / GATE-DENSITY COST, reported rather than worked around
//!
//! `src/pairing/pure/`'s own header (and `crate::pairing`'s) records the same
//! situation this module is in, so the reasoning is inherited rather than
//! repeated in full: `src/lib.rs` gates `pub mod entry` on
//! `target_arch = "wasm32"`, and `src/lib.rs` is off-limits to this dispatch
//! (it names `lib.rs`, `state.rs`, `component.rs` and `sheets/` as territory
//! this wave may not touch). `crate::pairing`'s equivalent split escapes the
//! gate by having `crate::state` — which the host build already compiles —
//! declare the pure files via `#[path]`, so they are reachable as
//! `state::pairing_pure::…` on the host and re-exported as
//! `crate::pairing::phase::…` on wasm32. That fix lives in `state.rs`, which
//! is this wave's off-limits file too, so the identical move is not available
//! here.
//!
//! So: the tests at the bottom of this file are written, and ARE pure — every
//! function above them touches no binding — but they do not run under
//! `cargo test`. They typecheck under
//! `cargo clippy --target wasm32-wasip2 --all-targets -- -D warnings` and
//! nothing more, exactly as `src/pairing/pure/phase.rs`'s own header describes
//! for the state before its escape was wired in. The fix, if this wave's
//! territory is ever widened, is the same one-line move `crate::pairing`'s
//! header names: declare this file from `crate::state` with `#[path]` and
//! re-export it from `crate::entry`. Flagged in the wave report.

/// One index row, as the picker needs it — `entry-host.picker-row`
/// (wit/world.wit:686-701) reduced to owned fields with no binding attached,
/// so the rule below can be tested with no WIT type in scope at all.
#[derive(Clone, PartialEq, Debug)]
pub struct Row {
    pub id: String,
    pub petname: String,
    /// 0 = never opened.
    pub last_used: u64,
    pub asks_passphrase: bool,
    pub asks_passkey: bool,
}

/// WHICH DOOR A ROW'S OWN TAP OPENS FIRST (`entry.ts:449-453`'s `onclick`):
/// `if (row.asksPasskey) askForPasskey(row); else if (row.asksPassphrase)
/// askFor(row); else void choose(row);`
///
/// `asks-passphrase` and `asks-passkey` are MUTUALLY EXCLUSIVE BY
/// CONSTRUCTION (wit/world.wit:691-698) — a policy names exactly ONE
/// ceremony to OFFER — so this could have been an `if asks_passphrase` with
/// no `else if`. It is written as the TypeScript orders it anyway: the
/// passkey check goes FIRST, and if a future policy ever violated the
/// "mutually exclusive" contract this is the reading that survives — a row
/// that (incorrectly) claims both asks for the platform ceremony, never
/// silently for the weaker fallback.
///
/// The fallback itself — a passkey row still reaching the passphrase field
/// through the passkey screen's own secondary control — is NOT this enum's
/// concern: it is reached from INSIDE the passkey screen
/// (`entry.ts:418-423`), not from the row's initial tap, and is wired at the
/// call site in `picker.rs`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InitialAction {
    AskPasskey,
    AskPassphrase,
    ChooseNow,
}

pub fn initial_action(row: &Row) -> InitialAction {
    if row.asks_passkey {
        InitialAction::AskPasskey
    } else if row.asks_passphrase {
        InitialAction::AskPassphrase
    } else {
        InitialAction::ChooseNow
    }
}

/// THE TIME LINE (`entry.ts:444-446`):
/// ```text
/// row.lastUsed > 0 ? `last used ${new Date(row.lastUsed).toLocaleString()}` : "never used"
/// ```
///
/// CONTRACT / TRANSLATION LOSS. The TypeScript formats with the BROWSER'S OWN
/// LOCALE AND CLOCK-TIME (`toLocaleString`), which this crate has no
/// equivalent of — there is no `Intl` on `wasm32-wasip2` and no locale is
/// threaded through the WIT seam for one to consult. `crate::marks::iso_date`
/// is the port's existing answer to the identical problem (a first-sight
/// timestamp with no locale to render it in, `sheets/naming.rs`'s "first
/// seen" line), reused rather than a second date formatter being invented.
/// The date-only reading is the conservative direction: a wrong LOCALE would
/// be a wrong number, a wrong CALENDAR MATH would be a wrong day, and
/// `iso_date` is already exercised by `marks.rs`'s own tests. Reported.
pub fn last_used_line(last_used_ms: u64) -> String {
    if last_used_ms == 0 {
        "never used".into()
    } else {
        format!("last used {}", crate::marks::iso_date(last_used_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(asks_passphrase: bool, asks_passkey: bool) -> Row {
        Row {
            id: "d1".into(),
            petname: "laptop".into(),
            last_used: 0,
            asks_passphrase,
            asks_passkey,
        }
    }

    #[test]
    fn passphrase_row_asks_for_passphrase() {
        assert_eq!(initial_action(&row(true, false)), InitialAction::AskPassphrase);
    }

    #[test]
    fn passkey_row_asks_for_passkey() {
        assert_eq!(initial_action(&row(false, true)), InitialAction::AskPasskey);
    }

    #[test]
    fn plain_row_chooses_immediately() {
        assert_eq!(initial_action(&row(false, false)), InitialAction::ChooseNow);
    }

    #[test]
    fn passkey_outranks_passphrase_if_a_row_ever_claimed_both() {
        // The two flags are mutually exclusive by construction
        // (wit/world.wit:691-698); this pins the reading taken if that
        // construction is ever violated — see the doc comment above.
        assert_eq!(initial_action(&row(true, true)), InitialAction::AskPasskey);
    }

    #[test]
    fn zero_last_used_reads_never_used() {
        assert_eq!(last_used_line(0), "never used");
    }

    #[test]
    fn nonzero_last_used_reads_a_date() {
        // 1_700_000_000_000ms = 2023-11-14 (UTC), well inside iso_date's
        // already-tested range (marks.rs's own date_tests module).
        assert_eq!(last_used_line(1_700_000_000_000), "last used 2023-11-14");
    }
}
