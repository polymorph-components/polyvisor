//! THE ERASE CEREMONY (`buildResetSheet`/`openResetDrawer`, sheets.ts:1457-1661).
//!
//! The visor's one destructive act, and the heaviest of the four sheets. What
//! it is made of, each piece traced to its site in sheets.ts:
//!
//!   - `.cred-danger`, the STATEMENT OF CONSEQUENCE said BEFORE the control
//!     that destroys it and said concretely (:1472-1486), plus the consumer's
//!     own extra lines from `SheetsState::reset_consequences`.
//!   - THE TYPED CONFIRMATION (:1498-1540): the challenge is the user's OWN
//!     NAME when the record holds one, falling back to the fixed word "erase"
//!     when it does not — the step is not skipped, because petnames and pet
//!     icons exist regardless and the deliberateness is still worth buying.
//!     Compared trimmed and case-insensitively: DELIBERATENESS, NOT
//!     AUTHENTICATION (:1586-1593). NEVER PREFILLED — a prefilled confirmation
//!     is a second Save button wearing a text field's clothes.
//!   - The root ships WITHOUT `.armed` (:1459-1463) — `SheetRoot` already does
//!     the right thing, because this is the one tenant whose spec sets `armed`.
//!     The erase button reads "arming…" until `embedder.tenant-armed` fires and
//!     then "erase everything"; Cancel is deliberately NOT held behind the
//!     delay, or the delay becomes a trap rather than a guard (:1649-1653).
//!
//! # WHAT THE ARMING DELAY RESTS ON HERE
//!
//! In TypeScript the sheet handed the drawer host a `controls` list and the
//! host set `disabled` on each when it armed and unset it when it did not
//! (sheets.ts:1645-1648). A guest-rendered sheet has no such list to hand over:
//! it draws its own `disabled`, from the same `SheetsState::armed` fact that
//! `SheetRoot` draws `.armed` from. The ATTRIBUTE remains the enforcement and
//! the class remains only its visible form (visor.css:754-757, :1059) — what
//! changed is which party writes the attribute, not what enforces anything.
//!
//! `armed` is cleared on `Effect::Build` (`component::apply_effects`), and
//! `Build` is emitted by `DrawerState::present` on ALL THREE presentation paths
//! — fresh open (drawer.rs:547), resume (:611) and rebuild (:694). So a
//! re-presented reset sheet always draws its erase control dead and waits out
//! the delay that is really running underneath it.
//!
//! # THE ORDERING IS THE WHOLE DESIGN
//!
//! `wit/world.wit:230-247` and sheets.ts:1601-1616: the CONSUMER'S half runs
//! FIRST because it is the FALLIBLE half. On `err` the ceremony refuses with
//! the reason line and NOTHING has been forgotten yet — the user is looking at
//! a visor that still holds everything it held a second ago, which is a true
//! sentence the sheet can say. Doing the infallible half first would buy a
//! state nobody can describe: a visor with no name, no colour and no marks, in
//! front of a consumer that still has every cache it had.
//!
//! It is the exact inverse of `on-identity-committed`, deliberately: a mirror
//! can only ever be LATE, never contradictory, but a late erase is a record
//! that survived a wipe, so the rule inverts with it.
//!
//! # THE RELOAD IS PART OF THE CEREMONY, not a convenience
//!
//! `chrome.reload` is the last step of the ok arm, and sheets.ts:1618-1637 is
//! the argument for it. Two reasons, either alone enough. First, honesty about
//! the end state: a fresh boot rolls a fresh anchor and announces it, and every
//! component comes back genuinely NEW — which is what was just promised, said
//! by the same machinery that says it on a first run. Second, nothing that
//! survived that line may keep rendering: `control.erase` empties the store,
//! but the running instance still holds the identity record, the anchor hue and
//! the event record in memory, and a visor still speaking a name it has
//! forgotten is precisely the failure this ceremony was about.
//!
//! So there is no close and no announcement after it, and that is not an
//! omission. The suspended settings sheet goes the same way — its session is
//! page state, and the page is about to be replaced by a fresh boot of a visor
//! that remembers nothing to settle.

use dioxus::prelude::*;

use crate::component::{
    embedder, exports::polymorph::visor_spike::control::Guest as ControlGuest,
    exports::polymorph::visor_spike::marks::Guest as MarksGuest,
    polymorph::visor_spike::chrome, read_visor, spawn, VisorComponent,
};
use crate::sheets::{close_ceremony, owns, SheetRoot, RESET};
use crate::voice::IDENTITY_MAX;

/// THE VISOR'S OWN LINES OF THE STATEMENT OF CONSEQUENCE, said first and said
/// concretely (sheets.ts:1477-1481): "your settings will be reset" is the
/// sentence a user clicks through, an itemised list is the one they read.
const DANGER_LINES: [&str; 2] = [
    "this erases what the visor holds on this device: your name, your word for this device, the bar's colour and mark, and every petname and pet icon you gave a component.",
    "every component will be NEW again, and there is no undo.",
];

/// The fallback challenge when the identity record holds no name
/// (sheets.ts:1508-1512).
const FALLBACK_CHALLENGE: &str = "erase";

#[component]
pub fn ResetSheet() -> Element {
    // THE CHALLENGE, FIXED FOR THE PRESENTATION. `use_hook`, so it is read once
    // per mount and a mount is a presentation — the same reason events.rs reads
    // its list once. Nothing can move the identity record while this ceremony
    // holds the drawer (the settings sheet that opened it is suspended, and its
    // only writer is a Save that ends it).
    let want = use_hook(|| {
        read_visor(|v| v.identity.name.as_ref().map(|n| n.as_str().to_string()))
            .flatten()
            .unwrap_or_default()
    });
    let named = !want.is_empty();
    let want = if named { want } else { FALLBACK_CHALLENGE.to_string() };

    // TRANSIENT, AND MUST DIE WITH THE PRESENTATION (module rule 2): what was
    // typed, what the sheet last refused with, and whether a wipe is in flight.
    let mut typed = use_signal(String::new);
    let mut reason = use_signal(String::new);
    let mut wiping = use_signal(|| false);

    // THE SAME FACT `SheetRoot` DRAWS `.armed` FROM. Read here as well rather
    // than threaded down from the root: the root owns the class, this owns the
    // attribute, and the attribute is the enforcement.
    let armed = read_visor(|v| v.sheets.armed.as_deref() == Some(RESET)).unwrap_or(false);
    let wipe_running = *wiping.read();
    // The input is held disabled too — nothing on this sheet is typeable before
    // the user has had time to see what it says (sheets.ts:1641-1648). Both go
    // dead again for the duration of the wipe: no second chance to press either
    // control while it runs (:1595-1597).
    let inert = !armed || wipe_running;

    let consequences = read_visor(|v| v.sheets.reset_consequences.clone()).unwrap_or_default();

    // One clone: the label below renders the challenge, the handler compares
    // against it.
    let challenge = want.clone();
    let erase = move |_| {
        if !owns(RESET) {
            return;
        }
        // DEFENCE IN DEPTH (sheets.ts:1569-1573): `disabled` is the
        // enforcement and this is the second refusal for anything that got past
        // it — a synthetic click, accessibility tooling driving the DOM.
        if !armed || *wiping.read() {
            return;
        }
        // DELIBERATENESS, NOT AUTHENTICATION (sheets.ts:1577-1585). Compared
        // trimmed and case-insensitively — nothing here is a secret, the user's
        // name is on the strip in front of them. What the field buys is that
        // the erase cannot be reached by a gesture, only by a sentence, and
        // refusing it over a capital letter would teach the user that the visor
        // is fussy rather than serious.
        if typed.read().trim().to_lowercase() != challenge.to_lowercase() {
            reason.set("that doesn't match — nothing has been erased".to_string());
            return;
        }
        reason.set(String::new());
        wiping.set(true);
        // THE FALLIBLE HALF FIRST, and everything below hangs off which arm
        // this settles on — see the module header.
        run_consumer_erase(move |refused| {
            if refused.is_some() {
                // NOTHING HAS BEEN ERASED. The sheet says so and stays usable:
                // this is a refusal, not a dead end (sheets.ts:1606-1612).
                //
                // CONTRACT: the consumer's own reason string is NOT rendered.
                // sheets.ts catches without reading the error and says one
                // fixed sentence in the visor's own voice; `on-reset`'s `err`
                // payload has no vetted door onto this sheet the way
                // `reset-consequences` does (it is a rejection message, not a
                // string the consumer offered through `sheets.configure`).
                // Conservative reading: keep the visor's sentence, drop the
                // payload. Reported.
                if !owns(RESET) {
                    return;
                }
                wiping.set(false);
                reason.set(
                    "could not erase — the visor still holds everything; try again".to_string(),
                );
                return;
            }
            // THE INFALLIBLE HALF, UNCONDITIONALLY — deliberately NOT guarded
            // on `owns`, unlike the refusal arm above and unlike every other
            // deferred edge in this crate. The consumer has already dropped its
            // half by the time this runs; abandoning the visor's half because
            // the ceremony was closed or evicted underneath us would leave
            // exactly the state the whole ordering exists to prevent — a record
            // that survived a wipe (wit/world.wit:266-269). sheets.ts:1615-1617
            // runs both of these after its `await` with no second guard for the
            // same reason.
            //
            // IN TWO PIECES AND IN THIS ORDER: the trust table (this module's),
            // then the visor's own keys. `erase_all` drops the KEY rather than
            // writing an empty table, so what is left is indistinguishable from
            // a device that never had one (`sheets/export.rs`'s `erase_all`).
            VisorComponent::erase_all();
            VisorComponent::erase();
            // AND THE PAGE GOES — see the module header. Nothing follows: no
            // close, no announcement. The ceremony does not end, the page it
            // was drawn on does.
            chrome::reload();
        });
    };

    rsx! {
        SheetRoot { tenant: RESET.to_string(), class: "reset-sheet",
            h2 { "Erase this visor" }

            // THE STATEMENT OF CONSEQUENCE, in framework voice, said BEFORE the
            // control that destroys it.
            div { class: "cred-danger",
                for line in DANGER_LINES {
                    div { "{line}" }
                }
                // THE CONSUMER'S OWN EXTRA LINES, after the framework's own
                // (wit/world.wit:336-341). The visor draws them in its own
                // chrome and speaks them undressed — they are `FrameworkText`,
                // never the app-voice door — and that the WORDS are the
                // consumer's own, never component-influenced, is the consumer's
                // rule to keep: nothing here can check it, so it is stated at
                // the option instead (sheets.ts:1483-1486).
                for line in consequences.iter() {
                    div { "{line.as_str()}" }
                }
            }

            div { class: "cred-field",
                label { r#for: "visor-reset-confirm",
                    if named {
                        // BUILT FROM SPANS rather than one string, because the
                        // user's name is USER VOICE inside a framework-voice
                        // sentence: the user wrote it, the visor is entitled to
                        // say it, and `.who` carries the weight-600 dress it
                        // already wears in the identity cluster
                        // (sheets.ts:1518-1531, visor.css:1036).
                        span { "type your name — " }
                        span { class: "who", "{want}" }
                        span { " — to confirm" }
                    } else {
                        "type erase to confirm"
                    }
                }
                input {
                    id: "visor-reset-confirm",
                    r#type: "text",
                    autocomplete: "off",
                    maxlength: "{IDENTITY_MAX}",
                    disabled: inert,
                    // NEVER PREFILLED, and here the rule does its most literal
                    // work: a prefilled confirmation is not a confirmation at
                    // all, it is a second Save button wearing a text field's
                    // clothes (sheets.ts:1535-1538).
                    value: "{typed}",
                    oninput: move |e| typed.set(e.value()),
                }
            }

            div { class: "cred-note",
                "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and cannot see what you type"
            }

            // ALWAYS PRESENT, empty or not: `.cred-reason` reserves its own
            // min-height (visor.css:734-735), so the row below does not jump
            // when the sheet refuses.
            div { class: "cred-reason", "{reason}" }

            div { class: "cred-row",
                button {
                    r#type: "button",
                    class: "erase-confirm",
                    disabled: inert,
                    onclick: erase,
                    // The arming state says so in words as well as in dress:
                    // the disabled attribute is the enforcement, the text is
                    // what tells the user the control is coming rather than
                    // broken (sheets.ts:1550-1554, :1655).
                    if armed { "erase everything" } else { "arming…" }
                }
                button {
                    r#type: "button",
                    // THE WAY OUT IS NEVER BEHIND THE ARMING DELAY, or the
                    // delay becomes a trap rather than a guard
                    // (sheets.ts:1649-1653). It is dead only while a wipe is
                    // actually in flight.
                    disabled: wipe_running,
                    onclick: move |_| {
                        if !owns(RESET) {
                            return;
                        }
                        // A plain close and NO announcement, the
                        // settings-cancel precedent: nothing happened, and
                        // saying so on the anchor would spend the bottom line
                        // on a non-event.
                        //
                        // THE RETURN TRAVEL IS NOT THIS SHEET'S
                        // (sheets.ts:1660-1666). The settings sheet that opened
                        // this one is SUSPENDED, not closed, and the drawer
                        // resumes it on this close — rebuilt, sliding back in.
                        // Re-opening it here would race the drawer into a
                        // second settings presentation.
                        close_ceremony(RESET, true);
                    },
                    "Cancel"
                }
            }
        }
    }
}

/// THE CONSUMER'S HALF OF THE ERASE — the one import on this world that is both
/// ASYNC AND FALLIBLE (`embedder.on-reset`, wit/world.wit:247).
///
/// `settled` is handed `None` on success and `Some(reason)` on refusal, and the
/// caller must handle both: on refusal NOTHING has been erased, which is what
/// makes the ceremony's reason line ("could not erase — the visor still holds
/// everything; try again", sheets.ts:1610) a true sentence rather than a guess.
///
/// # Why this needs [`crate::component::spawn`] and not an ordinary call
///
/// Awaiting a WASIp3 import requires a `wit-bindgen` async task to be current,
/// which is the case only for code reached from a component's ASYNC EXPORTS. A
/// `sheets` call — and a Dioxus event handler, which is reached through
/// `handle-event` but runs inside a synchronous VirtualDom dispatch — is not
/// such a place: there is no scope on the stack and nothing to await into. So
/// the future is spawned onto the renderer's scheduler task, which IS the async
/// export, exactly as every ported `setTimeout` is (`component::later` is this
/// function plus a sleep). The `RuntimeGuard` `spawn` installs is the same one
/// `with_visor` needs and for the same reason.
///
/// The callback runs back on that task, so it must reach the live state through
/// `with_visor` like every other deferred edge in this crate, and — like every
/// other one — it must RE-CHECK ITS OWN GUARDS: the ceremony may have been
/// closed, or the whole tenant evicted, while the consumer's IndexedDB wipe was
/// running. `sheets::owns` is that check.
pub fn run_consumer_erase(settled: impl FnOnce(Option<String>) + 'static) {
    spawn(async move {
        match embedder::on_reset().await {
            Ok(()) => settled(None),
            Err(reason) => settled(Some(reason)),
        }
    });
}
