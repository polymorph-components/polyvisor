//! THE ADD FLOW: THIS DEVICE ADMITS ANOTHER
//! (`mountAddPane`, visor/ui/pairing.ts:608-869). THE HEAVY CEREMONY.
//!
//! Enrollment gives the new device admin over EVERYTHING in the account, so
//! this is the consequential grant in the whole pairing story and it pays the
//! full price (pairing.ts:770-776, PAIRING.md §5):
//!
//!   - A STATEMENT OF CONSEQUENCE, said BEFORE the control that acts on it and
//!     said concretely — the same rule `sheets/reset.rs` follows, for the same
//!     reason: "you are granting access" is a sentence a user clicks through,
//!     "this device will get full access to everything in your account" is one
//!     they read.
//!   - THE ARMING DELAY, so that a baited tap sequence cannot reach a control
//!     that does not exist yet.
//!   - A DEVICE NAME THE USER TYPES, which nothing ever prefills — not from
//!     anything the joiner sent, and not from a default the visor invented.
//!
//! # WHERE THE ARMING DELAY HAS TO START, which is NOT where a sheet's is
//!
//! **This is the interpretation call in this file and it is a security one.**
//!
//! The drawer host's built-in arming (`TenantSpec::armed`) starts when the
//! drawer PRESENTS the sheet, and `crate::sheets::SheetRoot` draws `.armed`
//! from it. That is exactly right for the erase ceremony, where the dangerous
//! control is on screen from the first frame.
//!
//! It would be USELESS HERE. The add ceremony's dangerous control — "grant
//! full access" — does not exist when the sheet is presented. The user first
//! pastes a code, waits for a connection, and compares digits; by the time the
//! statement of consequence is drawn, tens of seconds have passed and a
//! presentation-scoped delay elapsed long ago. Wiring the grant button to
//! `sheets.armed` would produce a control that is ALREADY ARMED the instant it
//! appears — an arming delay that is present in the code, visible in the spec,
//! and buys nothing. That is precisely the failure this wave was warned about:
//! a security control silently going dead on the guest-rendered path.
//!
//! So the delay is started WHEN THE STATEMENT OF CONSEQUENCE MOUNTS, which is
//! what `visor/ui/pairing.ts:796-805` does — it sets its own `setTimeout` in
//! `renderConsequenceScreen`, not at pane mount. The duration is
//! `crate::drawer::ARM_MS`, THE framework's one arming duration
//! (pairing.ts:33-37: this file used to redeclare 700ms with a comment saying
//! it must match, and importing removed the "must"), so there is no second
//! constant that could drift.
//!
//! Consequently `super::specs` registers this tenant with `armed: false`. The
//! sheet's ORDINARY controls — the code field, "codes match — continue",
//! Cancel — are light and must not be held behind a delay; only the grant is
//! consequential, and the grant carries its own. See [`ArmedGrant`].
//!
//! # WHAT OUTLIVES THE SHEET
//!
//! After the grant the user has nothing left to do on this device: the ceremony
//! is waiting on a confirm only the OTHER device can make. A surface that holds
//! the screen must come down at that point (pairing.ts:648-667) — on real
//! hardware you put the laptop down, and on a one-page demo the dim over the
//! "other device" intercepts the very click the ceremony is waiting for, which
//! is a pointer deadlock found by driving the demo with real clicks.
//!
//! But THE SESSION MUST NOT STOP. So the grant closes the sheet and hands the
//! rest to [`watch_after_grant`], an app-scoped task that holds no UI and
//! exists only to say the two things still owed: that it completed, or that it
//! failed.

use dioxus::prelude::*;

use super::devices::{device_rows, DeviceRow};
use super::phase::{
    add_confirm_failed, add_line, add_start_failed, AddPhase, AddStatus, Line, NEEDS_NAME,
};
use super::render::Sas;
use super::{owns, presentation_of, say, Frame, ADD, POLL_MS};
use crate::component::polymorph::visor_spike::pairing_driver as driver;
use crate::component::spawn;
use crate::drawer::ARM_MS;
use crate::sheets::SheetRoot;
use crate::voice::{UserVoice, NAME_MAX};

/// `pair-add-state` -> the local machine's alphabet.
fn status_in(st: driver::PairAddState) -> AddStatus {
    match st {
        driver::PairAddState::Connecting => AddStatus::Connecting,
        driver::PairAddState::SasReady(sas) => AddStatus::SasReady(sas),
        driver::PairAddState::WaitingPeer => AddStatus::WaitingPeer,
        driver::PairAddState::Enrolled => AddStatus::Enrolled,
        driver::PairAddState::Failed(m) => AddStatus::Failed(m),
    }
}

/// HOW LONG THE POST-GRANT WATCH WAITS before saying the peer never came.
///
/// `demo/host/demo.ts:3536-3541`'s `ADD_PEER_DEADLINE_MS`, and its argument is
/// the reason this exists at all: "A grant that is never answered must not be a
/// silence. The driver reports `failed` for a session that breaks; it has no
/// state for a peer that simply never confirms, so the deadline is the visor's."
/// PAIRING.md §1 puts the offer's own expiry at 120s; this waits a little past
/// it before saying so.
const PEER_DEADLINE_MS: u64 = 150_000;

#[component]
pub fn AddSheet() -> Element {
    // TRANSIENT, ALL OF IT — and here the rule is doing its most literal work.
    // A half-typed device name and a pending grant MUST die with the
    // presentation; a drawer that went away and came back is a ceremony the
    // user has to make again, deliberately.
    let mut phase = use_signal(|| AddPhase::CodeEntry);
    let mut typed_code = use_signal(String::new);
    let mut connecting = use_signal(|| false);

    // THE POLL. Started only once `pair-add-start` has been accepted, which is
    // pairing.ts:846's `if (!started ...) return` guard: there is no session to
    // read before the code has been submitted.
    let mut started = use_signal(|| false);
    use_future(move || async move {
        let presentation = presentation_of(ADD);
        loop {
            dioxus_sdk_time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
            if !owns(ADD) || presentation_of(ADD) != presentation {
                return;
            }
            if !*started.peek() {
                continue;
            }
            let Ok(st) = driver::pair_add_status().await else {
                // A failed READ is not a failed session (pairing.ts:848).
                continue;
            };
            let next = phase.peek().clone().advance(status_in(st));
            if next == *phase.peek() {
                continue;
            }
            if let Some(line) = add_line(&next) {
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
        SheetRoot { tenant: ADD.to_string(), class: "pair-sheet pair-add-sheet",
            // KEYED BY THE SCREEN — see `super::Frame`, and `join.rs`'s twin.
            // The heavy screen is much taller than the code field above it, so
            // without this the statement of consequence and the name field
            // would be drawn outside the drawer's clamped height.
            Frame { key_for: screen_key(&current),
            h2 { "Add another device to your account" }

            match current {
                // --- the code from the other device -------------------------
                AddPhase::CodeEntry => rsx! {
                    div { class: "cred-field",
                        label { r#for: "visor-pair-code",
                            "paste or type the code shown on the new device:"
                        }
                        textarea {
                            id: "visor-pair-code",
                            rows: "2",
                            autocomplete: "off",
                            // NEVER PREFILLED either, though for a duller
                            // reason than the device name below: there is
                            // nothing this device could know to put here.
                            value: "{typed_code}",
                            disabled: *connecting.read(),
                            oninput: move |e| typed_code.set(e.value()),
                        }
                    }
                    div { class: "cred-row",
                        button {
                            r#type: "button",
                            disabled: *connecting.read() || typed_code.read().trim().is_empty(),
                            onclick: move |_| {
                                if !owns(ADD) || *connecting.peek() {
                                    return;
                                }
                                let raw = typed_code.peek().trim().to_string();
                                if raw.is_empty() {
                                    return;
                                }
                                connecting.set(true);
                                spawn(async move {
                                    let res = driver::pair_add_start(raw).await;
                                    if !owns(ADD) {
                                        return;
                                    }
                                    match res {
                                        Err(e) => {
                                            say(add_start_failed(&e));
                                            phase.set(AddPhase::Failed(e));
                                        }
                                        Ok(()) => {
                                            started.set(true);
                                            phase.set(AddPhase::Connecting);
                                            if let Some(line) = add_line(&AddPhase::Connecting) {
                                                say(line);
                                            }
                                        }
                                    }
                                    connecting.set(false);
                                });
                            },
                            "connect"
                        }
                        CancelButton {}
                    }
                },

                AddPhase::Connecting => rsx! {
                    div { class: "cred-line said", "connecting…" }
                    div { class: "cred-row", CancelButton {} }
                },

                // --- THE COMPARISON SCREEN ----------------------------------
                //
                // The same act as the join flow's, from the other side. Note
                // that pressing "continue" here does NOT grant anything: it
                // only moves to the statement of consequence, which is where
                // the grant lives and where the arming delay starts. The
                // comparison and the grant are two presses on purpose
                // (pairing.ts:764-767).
                AddPhase::Comparing(sas) => rsx! {
                    div { class: "cred-line said",
                        "confirm this code matches the new device:"
                    }
                    { Sas::from_driver(sas.clone()).render() }
                    div { class: "cred-note",
                        "these digits are drawn by your visor, in the bar's own pixels — an app cannot draw here and cannot read them. If the new device shows something different, stop."
                    }
                    div { class: "cred-row",
                        button {
                            r#type: "button",
                            onclick: move |_| {
                                if owns(ADD) {
                                    phase.set(AddPhase::Consequence(sas.clone()));
                                }
                            },
                            "codes match — continue"
                        }
                        CancelButton {}
                    }
                },

                // --- THE HEAVY HALF -----------------------------------------
                AddPhase::Consequence(_) => rsx! { ConsequenceScreen { phase } },

                AddPhase::WaitingPeer => rsx! {
                    div { class: "cred-line",
                        "granted — finish on the new device. You can put this one down."
                    }
                },

                AddPhase::Enrolled => rsx! {
                    div { class: "cred-line", "done." }
                    EnrolledDevices {}
                    div { class: "cred-row", CloseButton {} }
                },

                AddPhase::Failed(reason) => rsx! {
                    div { class: "cred-reason", "{reason}" }
                    div { class: "cred-row", CloseButton {} }
                },
            }
            }
        }
    }
}

/// THE SCREEN'S IDENTITY, for `super::Frame`'s key — `join.rs`'s twin, and here
/// the payload's exclusion is load-bearing rather than merely tidy: a key that
/// carried the digits would remount `ConsequenceScreen` whenever the driver
/// re-reported them, which would restart the arming delay AND discard the
/// half-typed device name.
fn screen_key(phase: &AddPhase) -> String {
    match phase {
        AddPhase::CodeEntry => "code-entry",
        AddPhase::Connecting => "connecting",
        AddPhase::Comparing(_) => "comparing",
        AddPhase::Consequence(_) => "consequence",
        AddPhase::WaitingPeer => "waiting-peer",
        AddPhase::Enrolled => "enrolled",
        AddPhase::Failed(_) => "failed",
    }
    .to_string()
}

/// THE STATEMENT OF CONSEQUENCE, THE NAME FIELD, AND THE ARMING DELAY.
///
/// A COMPONENT OF ITS OWN, and that is what makes the arming delay correct
/// rather than decorative: the timer is started from a `use_hook`, which runs
/// ONCE PER MOUNT — and this mounts exactly when the screen it guards appears,
/// which is the semantics `visor/ui/pairing.ts:796-805` has and a
/// presentation-scoped delay does not. See the module header.
///
/// It also makes the delay unskippable by the obvious route: there is no path
/// back into `Comparing` from here that would let a user bounce out and in to
/// find the control already live, because re-entering would remount this and
/// restart the hook.
#[component]
fn ConsequenceScreen(phase: Signal<AddPhase>) -> Element {
    let mut phase = phase;
    // NEVER PREFILLED. Not from anything the joiner sent — a name the far side
    // chose is a name an attacker chose — and not from a default the visor
    // invented, which is `crate::state::Identity`'s NO-FABRICATION rule:
    // a default would be a word the visor says in its own voice that the user
    // never wrote (pairing.ts:770-776, :789).
    let mut name = use_signal(String::new);
    let mut armed = use_signal(|| false);
    let mut granting = use_signal(|| false);
    let mut reason = use_signal(String::new);

    // THE ARMING DELAY ITSELF. `use_hook` so it is started exactly once, on
    // the mount of the screen it guards.
    //
    // Nothing here checks whether the wait is still wanted, which is this
    // crate's standing pattern for a timer (`component::later`'s header): the
    // callback re-checks its own guards instead. If the ceremony was closed the
    // signal write lands on a dead scope and nothing renders; if it was closed
    // and reopened, this component is a different instance with its own
    // `armed`.
    use_hook(move || {
        spawn(async move {
            dioxus_sdk_time::sleep(std::time::Duration::from_millis(ARM_MS)).await;
            armed.set(true);
        });
    });

    let is_armed = *armed.read();
    let in_flight = *granting.read();
    // The name field is held disabled too, for `sheets/reset.rs`'s reason:
    // nothing on this screen is typeable before the user has had time to see
    // what it says. Both go dead again while the grant is in flight — no
    // second chance to press either control while it runs.
    let inert = !is_armed || in_flight;

    rsx! {
        // SAID BEFORE THE CONTROL THAT ACTS ON IT. `.cred-warning` is shared
        // `.cred-sheet` vocabulary (visor.css:734) rather than `.cred-danger`,
        // which visor.css scopes to `.reset-sheet` alone (:1028): this is a
        // consequential grant, not a destruction, and dressing it as the erase
        // ceremony would flatten a distinction the user needs.
        div { class: "cred-warning",
            "this device will get full access to everything in your account. Only continue if you started this from a device you trust."
        }

        div { class: "cred-field",
            label { r#for: "visor-pair-name", "your word for this device:" }
            input {
                id: "visor-pair-name",
                r#type: "text",
                autocomplete: "off",
                maxlength: "{NAME_MAX}",
                disabled: inert,
                value: "{name}",
                oninput: move |e| name.set(e.value()),
            }
            // USER VOICE, and the hint says whose word it is. The name is
            // typed here and then spoken back by the visor in later
            // announcements ("device added: …", `us::describe`), which is only
            // honest if the user is the one who wrote it.
            div { class: "hint",
                "your own word for it — the visor will use this when it tells you about the device later"
            }
        }

        div { class: "cred-note",
            "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and cannot see what you type"
        }

        // Always present, empty or not: `.cred-reason` reserves its own
        // min-height (visor.css:734-735), so the row below does not jump when
        // the ceremony refuses.
        div { class: "cred-reason", "{reason}" }

        div { class: "cred-row",
            ArmedGrant { armed: is_armed, inert, on_grant: move |_| {
                if !owns(ADD) {
                    return;
                }
                // DEFENCE IN DEPTH (pairing.ts:806-810): the `disabled`
                // attribute is the enforcement and this is the second refusal
                // for anything that got past it — a synthetic click, or
                // accessibility tooling driving the DOM. Even if something
                // raced the attribute, the handler itself refuses to act
                // before the timer fired.
                if !*armed.peek() || *granting.peek() {
                    return;
                }
                let device_name = name.peek().trim().to_string();
                if device_name.is_empty() {
                    // CONSEQUENTIAL: it is a thing the user must act on before
                    // the ceremony goes anywhere (pairing.ts:812-814).
                    say(Line { text: NEEDS_NAME.to_string(), consequential: true });
                    reason.set(NEEDS_NAME.to_string());
                    return;
                }
                reason.set(String::new());
                granting.set(true);
                spawn(async move {
                    if let Err(e) = driver::pair_add_confirm(device_name).await {
                        say(add_confirm_failed(&e));
                        if owns(ADD) {
                            granting.set(false);
                            phase.set(AddPhase::Failed(e));
                        }
                        return;
                    }
                    // THE GRANT LANDED. Say so, hand the rest to a task that
                    // outlives this sheet, and take the sheet down — see the
                    // module header on why the surface must not stay up.
                    if let Some(line) = add_line(&AddPhase::WaitingPeer) {
                        say(line);
                    }
                    watch_after_grant();
                    if owns(ADD) {
                        phase.set(AddPhase::WaitingPeer);
                        super::close(ADD, true);
                    }
                });
            } }
            CancelButton {}
        }
    }
}

/// THE ACCOUNT'S DEVICE LIST, drawn once enrollment lands.
///
/// `renderDevices` (`visor/ui/pairing.ts:713-722`), whose one call site
/// (:859) is exactly here — the moment `AddPhase::Enrolled` renders — so the
/// user sees the device they just admitted actually present in the account,
/// not merely told "done.".
///
/// A COMPONENT OF ITS OWN, for the same reason [`ConsequenceScreen`] is:
/// `use_hook` fetches ONCE PER MOUNT, and this mounts exactly when the
/// `Enrolled` screen appears — `screen_key` forces a remount on every phase
/// change, so re-fetching on a later poll (there is none, `Enrolled` is
/// terminal) is not a concern in the first place.
///
/// SILENT ON FAILURE, on purpose and not by omission: pairing.ts's own
/// `if (!res.ok) return;` (:715) leaves the confirmation list simply absent
/// rather than drawing an error, and that is kept rather than "fixed" into an
/// error line, because the reasoning still holds — `add_line(&AddPhase::Enrolled)`
/// has already announced "device added" (pairing.ts:854) by the time this
/// runs, so a failure to draw a confirmation LIST must not read as the
/// enrollment itself having failed. The worst outcome of a listing failure is
/// the list staying absent; "done." and the Close button are unaffected.
#[component]
fn EnrolledDevices() -> Element {
    let mut rows = use_signal(|| None::<Vec<DeviceRow>>);
    use_hook(move || {
        spawn(async move {
            let Ok(list) = driver::us_devices_list().await else {
                // See the doc above: a listing failure is silent, not an
                // error line drawn over a ceremony that already succeeded.
                return;
            };
            rows.set(Some(device_rows(list.iter().map(|d| (d.name.as_str(), d.revoked)))));
        });
    });

    let Some(rows) = rows.read().clone() else { return rsx! {} };
    rsx! {
        ul { class: "cred-devices",
            for row in rows {
                li {
                    // USER VOICE / FRAMEWORK VOICE, kept apart — see
                    // `pure::devices`'s header. `row.name` is the word the
                    // user typed for THIS device in this very ceremony
                    // (`pair-add-confirm`'s doc: typed by the user, never
                    // prefilled) when it is `Some`; the unnamed fallback and
                    // the revoked qualifier are the visor DESCRIBING the
                    // record, so they are framework voice and never joined
                    // into the same string as the name.
                    match row.name {
                        Some(name) => {
                            // THROUGH `UserVoice`, not a bare string: this is
                            // the word the user typed for THIS device in this
                            // very ceremony (`pair-add-confirm`'s doc), the
                            // same class of content the identity strip
                            // renders as `.who`/`.who.device` (app.rs).
                            // `pure::devices` already trimmed and clamped it,
                            // so `UserVoice::new` only re-validates — but
                            // going through the type is what makes a bare
                            // string here a thing that had to be deliberately
                            // unwrapped, not a thing that could slip in in a
                            // later edit.
                            let voice = UserVoice::new(&name, NAME_MAX);
                            let shown = voice.map(|v| v.as_str().to_string()).unwrap_or_default();
                            rsx! {
                                span {
                                    class: "who",
                                    // `.who`'s weight-600 dress is scoped to
                                    // `#visor-identity`/`.reset-sheet
                                    // .cred-field label` (visor.css:406,
                                    // :1036) and this row is neither —
                                    // `visor.css` is read-only and has no
                                    // pairing vocabulary, so the value is
                                    // transcribed inline, the same reason
                                    // `render.rs` dresses the code and the
                                    // SAS inline (`ArmedGrant`'s doc, above).
                                    style: "font-weight: 600; letter-spacing: .01em;",
                                    "{shown}"
                                }
                            }
                        }
                        None => rsx! { "(unnamed)" },
                    }
                    if row.revoked {
                        " — revoked"
                    }
                }
            }
        }
    }
}

/// THE ONE CONSEQUENTIAL CONTROL, and the only thing on this sheet the arming
/// delay holds.
///
/// Split out so the two halves of the arming state are impossible to get out of
/// step: the `disabled` ATTRIBUTE is the enforcement and the LABEL is what
/// tells the user the control is coming rather than broken
/// (visor.css:754-757's rule, and `sheets/reset.rs`'s note on which party
/// writes the attribute now).
///
/// THE DIM IS INLINE, and it is not decoration. `visor.css` dims a disabled
/// button only under `.reset-sheet` (`:1059`), and `.cred-sheet.armed .cred-row
/// button { opacity: 1 }` (`:757`) actively restores full opacity here —
/// because this sheet's ROOT is armed from the first frame, the delay being the
/// grant's own rather than the tenant's (see the module header). Left alone, a
/// control that refuses every press would be drawn looking perfectly live,
/// which is sheets.ts:1459-1463's honesty rule broken in the direction that
/// matters: the user presses, nothing happens, and the visor has told them
/// nothing. Caught in the browser probe, not in review. The declaration is
/// `.reset-sheet`'s own value, inline because visor.css is read-only and has
/// no pairing vocabulary — the same reason `render.rs` styles the code and the
/// SAS inline.
#[component]
fn ArmedGrant(armed: bool, inert: bool, on_grant: EventHandler<MouseEvent>) -> Element {
    rsx! {
        button {
            r#type: "button",
            class: "pair-grant",
            disabled: inert,
            // BOTH BRANCHES SPELLED OUT. Setting this to "" for the live
            // state does NOT clear the previous declaration on this seam —
            // measured: the button stayed at opacity .45 after arming, so a
            // control that had become live went on being drawn dead. The
            // honesty rule cuts both ways (sheets.ts:1459-1463), and an
            // inline style is only reliably undone by another inline style.
            style: if inert {
                "opacity: .45; cursor: default;"
            } else {
                "opacity: 1; cursor: pointer;"
            },
            onclick: move |e| on_grant.call(e),
            if armed { "grant full access" } else { "arming…" }
        }
    }
}

/// THE SESSION AFTER THE SHEET.
///
/// App-scoped (`component::spawn`), so it survives the sheet closing — and it
/// deliberately does NOT check `owns(ADD)`, because by the time it runs the
/// ceremony has been closed on purpose. What it checks instead is the only
/// question left: has the session settled, and has it taken too long?
///
/// It holds no UI state and renders nothing. Everything it has left to say, it
/// says through the announcement sink, which is a surface that outlives any
/// sheet (pairing.ts:664-667).
fn watch_after_grant() {
    spawn(async move {
        let mut waited = 0u64;
        loop {
            dioxus_sdk_time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
            waited += POLL_MS;
            if waited >= PEER_DEADLINE_MS {
                // A grant that is never answered must not be a silence — see
                // `PEER_DEADLINE_MS`. Consequential, because it is a standing
                // fact the user has to decide what to do about.
                say(Line {
                    text: "the new device never finished joining — check it, or add it again"
                        .to_string(),
                    consequential: true,
                });
                return;
            }
            let Ok(st) = driver::pair_add_status().await else { continue };
            match status_in(st) {
                AddStatus::Enrolled => {
                    // THE ARCHETYPAL CONSEQUENTIAL LINE: a device gained full
                    // access to the account, so it is announced AND recorded.
                    if let Some(line) = add_line(&AddPhase::Enrolled) {
                        say(line);
                    }
                    return;
                }
                AddStatus::Failed(m) => {
                    say(Line { text: m, consequential: true });
                    return;
                }
                _ => {}
            }
        }
    });
}

/// The way out while a session is live. `pair-abort` first, then the close —
/// see `join.rs`'s twin for the ordering argument.
///
/// NOT HELD BEHIND THE ARMING DELAY, and that is a rule rather than an
/// oversight: `sheets/reset.rs` states it — the way out is never behind the
/// delay, or the delay becomes a trap rather than a guard.
#[component]
fn CancelButton() -> Element {
    rsx! {
        button {
            r#type: "button",
            onclick: move |_| {
                if !owns(ADD) {
                    return;
                }
                spawn(async move {
                    let _ = driver::pair_abort().await;
                });
                super::close(ADD, true);
            },
            "Cancel"
        }
    }
}

#[component]
fn CloseButton() -> Element {
    rsx! {
        button {
            r#type: "button",
            onclick: move |_| {
                if owns(ADD) {
                    super::close(ADD, true);
                }
            },
            "Close"
        }
    }
}
