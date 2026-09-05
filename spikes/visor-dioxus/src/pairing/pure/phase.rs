//! THE TWO STATE MACHINES, and every sentence the ceremony says.
//!
//! Pure: no bindings, no DOM, no clock. The `pairing-driver` variants are
//! mapped onto the local enums below at the one seam that touches them
//! (`join.rs` and `add.rs`), for the reason `crate::state` and `crate::drawer`
//! are separated from `crate::component` at all — the rules a ceremony obeys
//! are checkable without a host, and only the durations need a browser.
//!
//! # CONTRACT / GATE-DENSITY COST, reported rather than worked around
//!
//! This module is inside `src/pairing/`, which `src/lib.rs` gates on
//! `target_arch = "wasm32"` (lib.rs:88-92) exactly as it gates `src/sheets/`.
//! `src/lib.rs` is outside this wave's territory, so the gate could not be
//! lifted here, and the consequence is that the tests at the bottom of this
//! file and of `qr.rs`/`render.rs`/`us.rs` DO NOT RUN under `cargo test` —
//! they are typechecked by `cargo clippy --target wasm32-wasip2 --all-targets`
//! and nothing more. They are written anyway, and written to be pure, so that
//! ungating costs one line: everything they touch is already free of the
//! bindings. Flagged in the wave report.
//!
//! # THE TWO WEIGHT CLASSES, which is why there are two machines and not one
//!
//! `visor/ui/pairing.ts:32-38`: the JOIN ceremony's local confirm is LIGHT —
//! nothing secret is typed, and the worst a mis-tap costs is a cancelled join
//! the user restarts. The ADD ceremony is HEAVY, because the device it admits
//! becomes admin of everything in the account. The machines differ in exactly
//! that: [`AddPhase`] has a `Consequence` state between the comparison and the
//! grant, and [`JoinPhase`] has nothing between the comparison and the
//! confirm.

/// `pair-join-state` (wit/world.wit:568-575), as a local value.
#[derive(Clone, PartialEq, Debug)]
pub enum JoinStatus {
    Waiting,
    /// Carries the digits to compare.
    Claimed(String),
    ConfirmedWaiting,
    Enrolled,
    Expired,
    Failed(String),
}

/// `pair-add-state` (wit/world.wit:579-585), as a local value.
#[derive(Clone, PartialEq, Debug)]
pub enum AddStatus {
    Connecting,
    /// The same digits the other side is showing.
    SasReady(String),
    WaitingPeer,
    Enrolled,
    Failed(String),
}

/// WHERE THE JOINING DEVICE IS. `visor/ui/pairing.ts:517`'s `phase`, with the
/// pane's `"entry"` replaced by [`JoinPhase::Starting`]: the entry button was
/// the pane's own, and here the ceremony is entered through `pairing.request-join`
/// — a consumer's call from the visor's own pixels — so by the time a sheet
/// exists the offer is already being asked for.
#[derive(Clone, PartialEq, Debug)]
pub enum JoinPhase {
    /// `pair-join-start` is in flight.
    Starting,
    /// The code and its QR are up; the other device has not claimed it yet.
    Waiting,
    /// THE COMPARISON SCREEN. The digits are on the sheet and the user has not
    /// pressed yet — the whole of the visor's contribution to the ceremony's
    /// security is this state and the press that leaves it.
    Comparing(String),
    /// The user pressed. Waiting on the other device to do the same.
    Confirmed,
    Enrolled,
    /// The offer's window closed without the other device claiming it.
    Expired,
    Failed(String),
}

impl JoinPhase {
    /// TERMINAL: no driver read can move this session further, so the poll
    /// loop stops. `Expired` is terminal too — `visor/ui/pairing.ts:595-597`
    /// folds it into `phase = "failed"`; it is kept distinct here only so the
    /// sheet can say the more useful sentence.
    pub fn settled(&self) -> bool {
        matches!(self, JoinPhase::Enrolled | JoinPhase::Expired | JoinPhase::Failed(_))
    }

    /// ONE DRIVER READ, APPLIED. The port of `visor/ui/pairing.ts:574-603`,
    /// guards included — and the guards are the interesting part.
    ///
    /// `claimed` MOVES THE SHEET ONLY OUT OF `Waiting` (:579). The driver goes
    /// on reporting `claimed` for as long as the session sits there, so
    /// without that guard every poll would rebuild the comparison screen — and
    /// rebuilding it is not cosmetic, it would take the user's press back and
    /// re-arm a decision they had already made.
    ///
    /// `confirmed-waiting` is likewise ignored once [`JoinPhase::Confirmed`]
    /// (:581): the local press already moved the sheet there, and the driver
    /// merely agrees a moment later.
    pub fn advance(self, status: JoinStatus) -> Self {
        if self.settled() {
            return self;
        }
        match status {
            JoinStatus::Claimed(sas) if self == JoinPhase::Waiting => JoinPhase::Comparing(sas),
            JoinStatus::ConfirmedWaiting if self != JoinPhase::Confirmed => JoinPhase::Confirmed,
            JoinStatus::Enrolled => JoinPhase::Enrolled,
            JoinStatus::Expired => JoinPhase::Expired,
            JoinStatus::Failed(m) => JoinPhase::Failed(m),
            // Every other pairing — `waiting` at any point, a repeated
            // `claimed`, a `confirmed-waiting` that agrees with the press —
            // is a level rather than an edge, and levels change nothing.
            _ => self,
        }
    }
}

/// WHERE THE ADMITTING DEVICE IS. `visor/ui/pairing.ts:690-698`'s `phase`.
///
/// `Entry` is dropped for the same reason `JoinPhase` drops it, and so is the
/// `"button"` half of `AddEntry` (:630-643): the pane's own "add a device"
/// button existed for the standalone pairing page, and the visor is by
/// definition the `"immediate"` case — the ceremony is reached from visor
/// pixels the user already pressed, and asking them to press "add a device"
/// again on the sheet that opened BECAUSE they pressed "add a device" is the
/// exact thing :636-641 refuses.
#[derive(Clone, PartialEq, Debug)]
pub enum AddPhase {
    /// The code from the other device is being typed or pasted.
    CodeEntry,
    /// `pair-add-start` was accepted; waiting for the digits.
    Connecting,
    /// THE COMPARISON SCREEN, same act as [`JoinPhase::Comparing`].
    Comparing(String),
    /// THE HEAVY HALF: the statement of consequence, the arming delay and the
    /// device-name field. Reached only by an explicit press from `Comparing`.
    Consequence(String),
    /// Granted. The user is done on this device.
    WaitingPeer,
    Enrolled,
    Failed(String),
}

impl AddPhase {
    pub fn settled(&self) -> bool {
        matches!(self, AddPhase::Enrolled | AddPhase::Failed(_))
    }

    /// The port of `visor/ui/pairing.ts:845-866`.
    ///
    /// `sas-ready` MOVES THE SHEET ONLY OUT OF `Connecting` (:850), and here
    /// the guard is doing more work than its twin in [`JoinPhase::advance`]:
    /// the admitting user walks from the comparison to the statement of
    /// consequence to a name field they are typing into, and the driver
    /// reports `sas-ready` throughout. Without the guard, a poll landing while
    /// they type would throw them back to the comparison screen, discard the
    /// half-typed device name, and restart the arming delay.
    ///
    /// CONTRACT: `pair-add-state::waiting-peer` HAS NO ARM, and that is
    /// pairing.ts's behaviour rather than an omission — :845-866 has no branch
    /// for it either. The phase is reached LOCALLY, by the grant press
    /// ([`AddPhase::WaitingPeer`]), because the grant is the thing the visor
    /// knows happened and the driver's echo of it carries nothing extra. An
    /// arm here would also be actively wrong: it would be a second way into a
    /// state the arming delay and the name field guard the entrance to.
    pub fn advance(self, status: AddStatus) -> Self {
        if self.settled() {
            return self;
        }
        match status {
            AddStatus::SasReady(sas) if self == AddPhase::Connecting => AddPhase::Comparing(sas),
            AddStatus::Enrolled => AddPhase::Enrolled,
            AddStatus::Failed(m) => AddPhase::Failed(m),
            _ => self,
        }
    }
}

// --- what the ceremony says --------------------------------------------------
//
// FRAMEWORK VOICE, every one of them, and flat strings by construction: an
// announcement cannot carry class marking, so it is spoken entirely in the
// visor's own voice (`component::announce_framework`, visor/README.md:138).
// The strings are `visor/ui/pairing.ts`'s, verbatim where it had one.
//
// CONSEQUENTIAL vs AMBIENT is the second half of each of these and is not
// decoration: a consequential line holds the strip against ambient traffic for
// its window and LEAVES A RECORD in the event list (#132, pairing.ts:228-253).
// The gate is "would the user need to know this happened if they looked away"
// — a failure they must act on, or the ceremony completing. A "connecting…"
// is not that.

/// A line for the strip, and whether it outranks ambient traffic.
#[derive(Clone, PartialEq, Debug)]
pub struct Line {
    pub text: String,
    pub consequential: bool,
}

impl Line {
    fn ambient(text: impl Into<String>) -> Self {
        Self { text: text.into(), consequential: false }
    }
    fn loud(text: impl Into<String>) -> Self {
        Self { text: text.into(), consequential: true }
    }
}

/// THE JOIN FLOW'S SENTENCES. `None` where the phase says nothing — the sheet
/// itself is the message, and spending the strip's one line on "the screen you
/// are looking at is on screen" is how a rule line becomes noise.
pub fn join_line(phase: &JoinPhase) -> Option<Line> {
    Some(match phase {
        JoinPhase::Starting => return None,
        // pairing.ts:547.
        JoinPhase::Waiting => Line::ambient("waiting for the other device…"),
        // NOTHING. The comparison screen is the one moment the user must be
        // looking at the sheet, and an announcement would move their eye to
        // the strip and read digits at them that are not the ones on the
        // sheet. pairing.ts says nothing here either (:550-571).
        JoinPhase::Comparing(_) => return None,
        // pairing.ts:568, :583.
        JoinPhase::Confirmed => Line::ambient("confirmed — waiting for the other device to confirm…"),
        // NOT pairing.ts's, which says nothing on the joining side because
        // :584-594 leaves the §5 adoption announcement to the caller — the
        // account's profile has not arrived yet and a name read here would be
        // the empty one this device just adopted (:495-507). The visor still
        // owes the user the fact that the ceremony finished, so it says THAT
        // and only that: no name, no colour, nothing it would have to invent.
        JoinPhase::Enrolled => Line::loud("this device has joined your account"),
        // pairing.ts:597.
        JoinPhase::Expired => Line::loud("this code expired — start again"),
        // THE DRIVER'S OWN REASON, said undressed (pairing.ts:600). Admissible
        // for the reason pairing.ts:176-185 gives: a `pairing-driver` is HOST
        // code on the visor's side of the app seam — here, an interface the
        // embedder implements — not a sandboxed component. The rule bites on
        // strings that crossed the app seam, and nothing on this path did.
        JoinPhase::Failed(m) => Line::loud(m.clone()),
    })
}

/// THE ADD FLOW'S SENTENCES.
pub fn add_line(phase: &AddPhase) -> Option<Line> {
    Some(match phase {
        // The code field is the message; the strip stays on whatever it was
        // saying.
        AddPhase::CodeEntry => return None,
        // pairing.ts:748.
        AddPhase::Connecting => Line::ambient("connecting…"),
        // Silent for the same reason the join flow is silent while comparing.
        AddPhase::Comparing(_) | AddPhase::Consequence(_) => return None,
        // pairing.ts:825.
        AddPhase::WaitingPeer => Line::ambient("waiting for the new device to finish joining…"),
        // pairing.ts:854. CONSEQUENTIAL, and this is the archetype of the
        // rule: a device gaining full access to the account is precisely the
        // thing a user must be able to find later if they looked away when it
        // happened.
        AddPhase::Enrolled => Line::loud("device added"),
        AddPhase::Failed(m) => Line::loud(m.clone()),
    })
}

/// The refusal when the grant is pressed with an empty name field
/// (pairing.ts:813). CONSEQUENTIAL: it is a thing the user must act on before
/// the ceremony can go anywhere.
pub const NEEDS_NAME: &str = "give the new device a name first";

/// `pair-join-start` refused (pairing.ts:531).
pub fn join_start_failed(error: &str) -> Line {
    Line::loud(format!("could not start join: {error}"))
}

/// `pair-add-start` refused (pairing.ts:743).
pub fn add_start_failed(error: &str) -> Line {
    Line::loud(format!("could not start pairing: {error}"))
}

/// `pair-add-confirm` refused (pairing.ts:819).
pub fn add_confirm_failed(error: &str) -> Line {
    Line::loud(format!("could not confirm: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SYNTHETIC DIGITS THROUGHOUT. A short authentication string is not
    /// secret material — it is meant to be read out loud — but a fixture that
    /// looks like a real one is still the wrong thing to write down, so these
    /// are obviously counted sequences.
    fn sas() -> String {
        "00 01 02".to_string()
    }

    // --- the join machine ---------------------------------------------------

    #[test]
    fn the_comparison_screen_is_reached_from_waiting_and_only_from_waiting() {
        assert_eq!(
            JoinPhase::Waiting.advance(JoinStatus::Claimed(sas())),
            JoinPhase::Comparing(sas())
        );
        // The starting phase has not shown a code yet, so there is nothing for
        // the other device to have claimed.
        assert_eq!(
            JoinPhase::Starting.advance(JoinStatus::Claimed(sas())),
            JoinPhase::Starting
        );
    }

    /// The guard that protects a decision the user has already made: the
    /// driver keeps reporting `claimed` while the comparison screen is up, and
    /// a re-entry would take the press back.
    #[test]
    fn a_repeated_claimed_does_not_rebuild_the_comparison_screen() {
        let p = JoinPhase::Comparing(sas());
        assert_eq!(p.clone().advance(JoinStatus::Claimed(sas())), p);
        let p = JoinPhase::Confirmed;
        assert_eq!(p.clone().advance(JoinStatus::Claimed(sas())), p);
    }

    #[test]
    fn the_drivers_confirmed_echo_does_not_disturb_a_local_confirm() {
        assert_eq!(
            JoinPhase::Confirmed.advance(JoinStatus::ConfirmedWaiting),
            JoinPhase::Confirmed
        );
        // But it IS how a confirm made on the other side of a reload arrives.
        assert_eq!(
            JoinPhase::Waiting.advance(JoinStatus::ConfirmedWaiting),
            JoinPhase::Confirmed
        );
    }

    #[test]
    fn a_settled_join_session_absorbs_every_later_read() {
        for terminal in
            [JoinPhase::Enrolled, JoinPhase::Expired, JoinPhase::Failed("no".into())]
        {
            assert!(terminal.settled());
            assert_eq!(terminal.clone().advance(JoinStatus::Claimed(sas())), terminal);
            assert_eq!(terminal.clone().advance(JoinStatus::Waiting), terminal);
        }
    }

    // --- the add machine ----------------------------------------------------

    /// The guard that matters most in the whole port: the admitting user is
    /// typing a device name inside `Consequence` while the driver reports
    /// `sas-ready` on every poll. Re-entering the comparison screen would
    /// discard what they typed AND restart the arming delay.
    #[test]
    fn a_repeated_sas_ready_does_not_interrupt_the_heavy_ceremony() {
        let typing = AddPhase::Consequence(sas());
        assert_eq!(typing.clone().advance(AddStatus::SasReady(sas())), typing);
        let comparing = AddPhase::Comparing(sas());
        assert_eq!(comparing.clone().advance(AddStatus::SasReady(sas())), comparing);
    }

    /// The grant is reached by a press, never by a driver read — see
    /// `AddPhase::advance`'s CONTRACT note.
    #[test]
    fn the_driver_cannot_grant_on_the_users_behalf() {
        for phase in [
            AddPhase::CodeEntry,
            AddPhase::Connecting,
            AddPhase::Comparing(sas()),
            AddPhase::Consequence(sas()),
        ] {
            assert_eq!(
                phase.clone().advance(AddStatus::WaitingPeer),
                phase,
                "waiting-peer must not move the ceremony past the arming delay"
            );
        }
    }

    #[test]
    fn connecting_is_the_only_way_into_the_comparison_screen() {
        assert_eq!(
            AddPhase::Connecting.advance(AddStatus::SasReady(sas())),
            AddPhase::Comparing(sas())
        );
        assert_eq!(
            AddPhase::CodeEntry.advance(AddStatus::SasReady(sas())),
            AddPhase::CodeEntry
        );
    }

    // --- the words ----------------------------------------------------------

    /// The comparison screens say NOTHING on the strip: the user's eye belongs
    /// on the digits, and a rule line is a competing place to look.
    #[test]
    fn nothing_is_announced_while_the_digits_are_being_compared() {
        assert!(join_line(&JoinPhase::Comparing(sas())).is_none());
        assert!(add_line(&AddPhase::Comparing(sas())).is_none());
        assert!(add_line(&AddPhase::Consequence(sas())).is_none());
    }

    /// A ceremony completing or failing leaves a record; ambient progress does
    /// not (#132 — otherwise the list becomes junk mail).
    #[test]
    fn completion_and_failure_are_consequential_and_progress_is_not() {
        assert!(join_line(&JoinPhase::Enrolled).unwrap().consequential);
        assert!(join_line(&JoinPhase::Expired).unwrap().consequential);
        assert!(join_line(&JoinPhase::Failed("x".into())).unwrap().consequential);
        assert!(add_line(&AddPhase::Enrolled).unwrap().consequential);
        assert!(add_line(&AddPhase::Failed("x".into())).unwrap().consequential);

        assert!(!join_line(&JoinPhase::Waiting).unwrap().consequential);
        assert!(!join_line(&JoinPhase::Confirmed).unwrap().consequential);
        assert!(!add_line(&AddPhase::Connecting).unwrap().consequential);
        assert!(!add_line(&AddPhase::WaitingPeer).unwrap().consequential);
    }

    /// The joining device says the ceremony finished and NOTHING about the
    /// account's name or colour — that document has not arrived yet, and a
    /// visor that named it here would be naming the empty one it just
    /// adopted (pairing.ts:495-507).
    #[test]
    fn the_join_completion_line_names_nothing_it_has_not_seen() {
        let line = join_line(&JoinPhase::Enrolled).unwrap();
        assert!(!line.text.contains("colour"), "{}", line.text);
        assert!(!line.text.contains('"'), "no quoted name: {}", line.text);
    }
}
