//! THE JOIN FLOW: THIS DEVICE JOINS AN EXISTING ACCOUNT
//! (`mountJoinPane`, visor/ui/pairing.ts:482-606).
//!
//! Three screens, in order: the code and its QR while the other device has not
//! answered; THE COMPARISON SCREEN; then the wait for the other side.
//!
//! # THE COMPARISON SCREEN IS THE WHOLE POINT
//!
//! Everything else on this sheet is transport. The digits, and the press that
//! says they matched, are the ceremony: a relay that has full control of the
//! wire is defeated here and nowhere else, because it cannot make two people
//! read the same string to each other over a channel it is not on
//! (wit/world.wit:548-553).
//!
//! Two properties follow, and both are structural rather than advisory:
//!
//!   - THE DIGITS APPEAR WHERE AN APP CANNOT DRAW. They are rendered by
//!     `super::render`, in a `SheetRoot` hanging off the pinned strip over a
//!     dimmed page — the geometry visor.css:128-143 calls unforgeable. The
//!     string never exists as a bare `String` in this crate for anything else
//!     to render (see `render.rs`'s header).
//!   - CONFIRMING IS A DELIBERATE PRESS. There is no path from a driver read
//!     to a confirm: `phase::JoinPhase::advance` has no arm that reaches
//!     `Confirmed` except the driver reporting that the confirm ALREADY
//!     happened, and the only thing that calls `pair-join-confirm` is the
//!     button's `onclick`.
//!
//! # AND IT IS DELIBERATELY LIGHT
//!
//! No arming delay (pairing.ts:556-561): nothing secret is typed here, the
//! gesture starts from pixels the visor drew, and the worst a mis-tap costs is
//! a cancelled join the user starts again. See `super::specs` for why paying
//! the tax where it buys nothing is an active harm.

use dioxus::prelude::*;

use super::phase::{join_line, join_start_failed, JoinPhase, JoinStatus};
use super::render::{PairingCode, Sas};
use super::{owns, presentation_of, say, Frame, JOIN, POLL_MS};
use crate::component::polymorph::visor_spike::pairing_driver as driver;
use crate::sheets::SheetRoot;

/// `pair-join-state` -> the local machine's alphabet. The one seam that names
/// the generated variants; everything downstream is pure.
fn status_in(st: driver::PairJoinState) -> JoinStatus {
    match st {
        driver::PairJoinState::Waiting => JoinStatus::Waiting,
        driver::PairJoinState::Claimed(sas) => JoinStatus::Claimed(sas),
        driver::PairJoinState::ConfirmedWaiting => JoinStatus::ConfirmedWaiting,
        // The enrollment record (`user-group-id`, `partition-id`) is DROPPED
        // here and that is not a loss. Both fields are the backend's own
        // identifiers; neither is anything the visor renders, and the visor
        // deliberately reads no profile on this edge — see
        // `phase::join_line`'s `Enrolled` arm and pairing.ts:584-594.
        driver::PairJoinState::Enrolled(_) => JoinStatus::Enrolled,
        driver::PairJoinState::Expired => JoinStatus::Expired,
        driver::PairJoinState::Failed(m) => JoinStatus::Failed(m),
    }
}

/// HOW LONG THE OFFER IS GOOD FOR, in words.
///
/// `pair-offer.expires-ms` is a DURATION, not a deadline (the mock answers
/// `120_000`, and PAIRING.md §1 puts the offer's window at 120s). Rounded to
/// whole minutes deliberately: the number's job is to tell the user whether to
/// go and fetch the other device or start again, and a live countdown would be
/// a second clock on screen that the DRIVER — not the visor — is the authority
/// on. `pair-join-state::expired` remains that authority; this line is only a
/// warning that it is coming.
///
/// CONTRACT / FINDING: `expiresMs` IS NEVER READ IN `visor/ui/pairing.ts`. The
/// field is destructured nowhere (:534 takes `res.value.code` alone), so the
/// TypeScript pane showed a code with no indication of how long it was good
/// for and simply waited for `expired` to arrive. Rendering it is an addition
/// traced to the WIT record and to this wave's dispatch, not a port. Reported.
fn window_line(expires_ms: u64) -> String {
    let minutes = expires_ms / 60_000;
    match minutes {
        0 => "this code stops working in under a minute".into(),
        1 => "this code stops working in about a minute".into(),
        n => format!("this code stops working in about {n} minutes"),
    }
}

#[component]
pub fn JoinSheet() -> Element {
    // TRANSIENT, ALL OF IT, and it must die with the presentation (the sheets
    // header's rule 2): a pending comparison and a half-finished offer are
    // exactly the things that must not survive the drawer going away.
    let mut phase = use_signal(|| JoinPhase::Starting);
    let mut code = use_signal(|| None::<PairingCode>);
    let mut window = use_signal(String::new);
    // The port of pairing.ts:519's `confirmed` latch: the press is disabled on
    // the way in, and this is the second refusal for anything that got past the
    // attribute.
    let mut confirming = use_signal(|| false);

    // THE SESSION: ask for an offer, then read the driver until it settles.
    //
    // `use_future` rather than `component::spawn`: there IS a scope on the
    // stack here, and the task dies with the presentation — which is what
    // should happen to a join session whose sheet went away.
    use_future(move || async move {
        match driver::pair_join_start().await {
            Err(e) => {
                let line = join_start_failed(&e);
                say(line);
                phase.set(JoinPhase::Failed(e));
                return;
            }
            Ok(offer) => {
                window.set(window_line(offer.expires_ms));
                // THE CODE'S ONE MOMENT AS A BARE STRING, immediately wrapped
                // — see `render.rs`. Nothing downstream can get it back out.
                let wrapped = PairingCode::from_driver(offer.code);
                // THE QR, ENCODED HERE AND DRAWN AS SVG. Synchronous now:
                // there is no host round trip left in it, so the code and its
                // picture necessarily arrive in the same render rather than
                // the sheet growing a second time under the user. `None` is
                // survivable — the text code alone is a ceremony that
                // completes (see `qr::Matrix::encode`).
                code.set(Some(wrapped));
                phase.set(JoinPhase::Waiting);
                if let Some(line) = join_line(&JoinPhase::Waiting) {
                    say(line);
                }
            }
        }

        // THE POLL. Every iteration re-checks its own guards, which is this
        // crate's standing rule for anything on the clock (`component::later`'s
        // header): the ceremony may have been closed, evicted, or closed and
        // re-opened as a different presentation while the driver was answering.
        let presentation = presentation_of(JOIN);
        loop {
            dioxus_sdk_time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
            if !owns(JOIN) || presentation_of(JOIN) != presentation {
                return;
            }
            let Ok(st) = driver::pair_join_status().await else {
                // A FAILED READ IS NOT A FAILED SESSION (pairing.ts:577): the
                // driver may be momentarily unavailable, and tearing the
                // ceremony down over one unanswered poll would lose a code the
                // user is mid-way through transcribing.
                continue;
            };
            let next = phase.peek().clone().advance(status_in(st));
            // ON THE EDGE, NOT THE LEVEL. The driver reports the same state on
            // every poll; announcing per read rather than per change would
            // repeat "waiting for the other device…" five times a second.
            if next == *phase.peek() {
                continue;
            }
            if let Some(line) = join_line(&next) {
                say(line);
            }
            let settled = next.settled();
            phase.set(next);
            if settled {
                return;
            }
        }
    });

    let current = phase.read().clone();

    rsx! {
        SheetRoot { tenant: JOIN.to_string(), class: "pair-sheet pair-join-sheet",
            // KEYED BY THE SCREEN, so the drawer is re-told the sheet's height
            // every time the ceremony moves — see `super::Frame`. The heading
            // is INSIDE it because the frame measures itself and the heading is
            // part of what the drawer has to make room for.
            Frame { key_for: screen_key(&current),
            h2 { "Join this device to your account" }

            match current {
                JoinPhase::Starting => rsx! {
                    div { class: "cred-line said", "asking for a code…" }
                },

                // --- the code and its QR ------------------------------------
                JoinPhase::Waiting => rsx! {
                    div { class: "cred-line said",
                        "on your trusted device: add a device, then enter this code"
                    }
                    { code.read().as_ref().map(|c| c.render_qr()) }
                    // THE SINGLE DEFINITION SITE, reached through the wrapper.
                    { code.read().as_ref().map(|c| c.render()) }
                    div { class: "cred-note", "{window}" }
                },

                // --- THE COMPARISON SCREEN ----------------------------------
                JoinPhase::Comparing(sas) => rsx! {
                    div { class: "cred-line said",
                        "confirm this code matches the other device:"
                    }
                    { Sas::from_driver(sas).render() }
                    div { class: "cred-note",
                        "these digits are drawn by your visor, in the bar's own pixels — an app cannot draw here and cannot read them. If the other device shows something different, stop."
                    }
                    div { class: "cred-row",
                        button {
                            r#type: "button",
                            disabled: *confirming.read(),
                            onclick: move |_| {
                                if !owns(JOIN) {
                                    return;
                                }
                                // Defence in depth, pairing.ts:563's latch:
                                // `disabled` is the enforcement and this is the
                                // second refusal for a synthetic click or
                                // accessibility tooling driving the DOM.
                                if *confirming.peek() {
                                    return;
                                }
                                confirming.set(true);
                                crate::component::spawn(async move {
                                    // The result is not branched on, which is
                                    // pairing.ts:566's behaviour: the driver's
                                    // own status is the authority on whether
                                    // the confirm landed, and it is being
                                    // polled. A refusal arrives as
                                    // `failed`, with the driver's reason.
                                    let _ = driver::pair_join_confirm().await;
                                    if !owns(JOIN) {
                                        return;
                                    }
                                    if let Some(line) = join_line(&JoinPhase::Confirmed) {
                                        say(line);
                                    }
                                    phase.set(JoinPhase::Confirmed);
                                });
                            },
                            // THE SENTENCE IS THE CEREMONY. "I initiated this"
                            // is the half a relay cannot supply: it asserts
                            // that the user, not something on the wire, began
                            // this (pairing.ts:557).
                            "I initiated this — codes match"
                        }
                        CancelButton {}
                    }
                },

                JoinPhase::Confirmed => rsx! {
                    div { class: "cred-line said",
                        "confirmed — waiting for the other device to confirm…"
                    }
                    div { class: "cred-row", CancelButton {} }
                },

                JoinPhase::Enrolled => rsx! {
                    div { class: "cred-line", "joined." }
                    // NO PROFILE IS READ HERE, and the omission is deliberate:
                    // the account document this device just adopted is empty
                    // until the embedder's sync path delivers it, so a name or
                    // a colour shown now would be the empty one
                    // (pairing.ts:495-507, :584-590). The visor says the
                    // ceremony finished and leaves the adoption sentence to the
                    // moment the value exists.
                    div { class: "cred-note",
                        "your account's name and colour will arrive in a moment."
                    }
                    div { class: "cred-row", CloseButton { label: "Close" } }
                },

                JoinPhase::Expired => rsx! {
                    div { class: "cred-reason", "this code expired — start again" }
                    div { class: "cred-row", CloseButton { label: "Close" } }
                },

                // THE DRIVER'S OWN REASON, rendered undressed — admissible for
                // the reason `phase::join_line` states at its `Failed` arm.
                JoinPhase::Failed(reason) => rsx! {
                    div { class: "cred-reason", "{reason}" }
                    div { class: "cred-row", CloseButton { label: "Close" } }
                },
            }
            }
        }
    }
}

/// THE SCREEN'S IDENTITY, for `super::Frame`'s key. The PAYLOAD IS DELIBERATELY
/// NOT PART OF IT: a re-render carrying the same digits must not remount the
/// comparison screen, because a remount would take the user's press back — the
/// same property `phase::JoinPhase::advance`'s guards buy one level up.
fn screen_key(phase: &JoinPhase) -> String {
    match phase {
        JoinPhase::Starting => "starting",
        JoinPhase::Waiting => "waiting",
        JoinPhase::Comparing(_) => "comparing",
        JoinPhase::Confirmed => "confirmed",
        JoinPhase::Enrolled => "enrolled",
        JoinPhase::Expired => "expired",
        JoinPhase::Failed(_) => "failed",
    }
    .to_string()
}

/// THE WAY OUT WHILE A SESSION IS LIVE: tell the driver, then close.
///
/// `pair-abort` first and the close afterwards, because the close is the
/// infallible half — the same ordering argument `sheets/reset.rs`'s header
/// makes, in its milder form. An abandoned session on the backend is a code
/// that goes on being claimable for its whole window, which is the one thing
/// the user pressing Cancel is trying to prevent.
#[component]
fn CancelButton() -> Element {
    rsx! {
        button {
            r#type: "button",
            onclick: move |_| {
                if !owns(JOIN) {
                    return;
                }
                crate::component::spawn(async move {
                    let _ = driver::pair_abort().await;
                });
                // A plain close and NO announcement, the settings-cancel
                // precedent (`sheets/reset.rs`): nothing happened, and saying
                // so on the strip would spend the bottom line on a non-event.
                super::close(JOIN, true);
            },
            "Cancel"
        }
    }
}

/// The way out once the session is over. No abort — there is nothing left to
/// abort, and calling it on an enrolled session would be asking the backend to
/// undo the thing that just succeeded.
#[component]
fn CloseButton(label: String) -> Element {
    rsx! {
        button {
            r#type: "button",
            onclick: move |_| {
                if owns(JOIN) {
                    super::close(JOIN, true);
                }
            },
            "{label}"
        }
    }
}
