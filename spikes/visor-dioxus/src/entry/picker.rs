//! THE DEVICE PICKER, guest-rendered (`mountDevicePicker`, entry.ts:184-497).
//!
//! # THE ONE SHEET THAT OPENS BEFORE THE VISOR IS CLAIMED
//!
//! Everything here renders on the UNCLAIMED grey dress: `Visor::boot` defers
//! the claim (see `component.rs`'s boot, and visor.css's zero-chroma
//! fallback), so at picker time there is no hue and no anchor word to leak,
//! and this sheet must not manufacture either. Concretely: [`Row`] carries
//! only what `entry-host.picker-row` gives it — an opaque id, the user's own
//! petname, a last-used time, two policy bits — and nothing here ever reads a
//! colour, an account name or an icon. That is the whole of the anti-spoofing
//! property (entry.ts:29-40): a page imitating this screen has nothing of the
//! user's to copy, because at this moment neither does the real one.
//!
//! # WHY THE SUBJECT IS A `GlobalSignal` AND NOT ON `Visor`
//!
//! `crate::sheets::SheetsState` is exactly the place this would live if it
//! were this wave's to extend — see `naming.rs`'s `Subject` for the identical
//! shape, "arrives from outside through an export, lives where the render can
//! subscribe to it". But `sheets/mod.rs` is off-limits to this dispatch, so
//! [`SUBJECT`] is the same shape one level below `Visor`'s own signal instead
//! of a field on it: set once, from the `entry` export, before the ceremony
//! opens (`super::mod`'s `EntryGuest::mount_device_picker`), and read here,
//! subscribed, in the render body.
//!
//! # THE FALLBACK, PORTED FAITHFULLY (entry.ts:261-287, :382-423)
//!
//! `asks-passphrase` and `asks-passkey` are mutually exclusive BY
//! CONSTRUCTION — a policy names exactly ONE ceremony to OFFER
//! (wit/world.wit:691-698) — but the offered one is not the only door: a
//! passkey row's own screen carries a SECONDARY "use your passphrase
//! instead" control that reaches the passphrase field anyway, because the
//! rungs are additive. [`Screen::Passkey`]'s fallback button is that door,
//! and it is wired unconditionally — a device that also carries no
//! user-origin passphrase simply refuses at the host, exactly as a wrong one
//! would (entry.ts:280-281).
//!
//! # RE-MEASURING, and why this sheet needs it and the visor's own four do not
//!
//! `crate::sheets::SheetRoot` measures itself once, and `mount-sheet` refuses
//! any later call — sound for a sheet whose shape is fixed for its whole
//! presentation. This one is not: revealing the passphrase or passkey block,
//! or a problem line appearing under either, changes the rendered height
//! (`resize()`, entry.ts:317-321, called after every state change). This is
//! the identical shape `crate::pairing::Frame` exists for — a
//! `resize-sheet`-driven re-measure on a keyed remount — so it is reused
//! rather than re-invented: `crate::pairing` is a public sibling module, not
//! this wave's file to edit, and importing its `Frame` is not a duplication
//! of the pattern, it is the ONE case where the thing already built is
//! exactly the thing wanted. Keyed on [`Screen`] plus whether a problem line
//! is showing, which is every dimension entry.ts's `resize()` call sites
//! actually change.

use dioxus::prelude::*;

use super::pure::{initial_action, last_used_line, InitialAction, Row};
use super::{close, owns, PICKER};
use crate::component::polymorph::visor_spike::entry_host as host;
use crate::pairing::Frame;
use crate::sheets::SheetRoot;

/// WHAT THE CEREMONY IS ABOUT: the on-device index, and any pre-seeded
/// refusal (`opts.problem` — entry.ts:177-182, the auto-unseal failure path:
/// a single kept device is opened with no sheet at all, so when that attempt
/// fails there is no surface for the refusal to land on until this one
/// mounts already carrying it).
#[derive(Clone, PartialEq, Debug)]
struct Subject {
    rows: Vec<Row>,
    problem: Option<String>,
}

static SUBJECT: GlobalSignal<Option<Subject>> = GlobalSignal::new(|| None);

fn row_in(r: host::PickerRow) -> Row {
    Row {
        id: r.id,
        petname: r.petname,
        last_used: r.last_used,
        asks_passphrase: r.asks_passphrase,
        asks_passkey: r.asks_passkey,
    }
}

fn row_out(r: &Row) -> host::PickerRow {
    host::PickerRow {
        id: r.id.clone(),
        petname: r.petname.clone(),
        last_used: r.last_used,
        asks_passphrase: r.asks_passphrase,
        asks_passkey: r.asks_passkey,
    }
}

/// Set the subject. Called from `entry.mount-device-picker`, BEFORE the
/// ceremony opens (`super`'s `EntryGuest` impl) — so that by the time the
/// drawer presents the slide and this component's render body runs, the
/// value is already there to read.
pub(crate) fn mount(rows: Vec<host::PickerRow>, problem: Option<String>) {
    let subject = Subject { rows: rows.into_iter().map(row_in).collect(), problem };
    // NOT a render body: an export function. The write needs a `Runtime`
    // installed (`GlobalSignal::write` reaches `Runtime::current()`
    // underneath, same as `component::with_visor`'s own header explains for
    // the reason it exists at all), and `with_visor` is the door this crate
    // already has for exactly that — the `Visor` value itself is untouched
    // here, only the guard it installs is wanted.
    crate::component::with_visor(|_| {
        *SUBJECT.write() = Some(subject);
    });
}

/// THE SCREEN CURRENTLY SHOWING, for `Frame`'s key (see the module header).
/// The payload is deliberately PART of the key here, unlike
/// `pairing::join::screen_key`'s comparison screen: a passphrase/passkey
/// screen is keyed by which ROW it is for, and switching rows (there is no
/// path back to the list without a re-mount in practice, but the type should
/// not lie about it) is exactly a shape change the drawer must be re-told
/// about.
#[derive(Clone, PartialEq, Debug)]
enum Screen {
    List,
    Passphrase(Row),
    Passkey(Row),
}

fn screen_key(screen: &Screen, problem_shown: bool) -> String {
    let base = match screen {
        Screen::List => "list".to_string(),
        Screen::Passphrase(r) => format!("pass-{}", r.id),
        Screen::Passkey(r) => format!("passkey-{}", r.id),
    };
    format!("{base}-{}", problem_shown as u8)
}

#[component]
pub fn PickerSheet() -> Element {
    // A `GlobalSignal` read, not `read_visor`: this state lives beside
    // `Visor`, not on it — see the module header. It still obeys the same
    // rule (render bodies read and write nothing): this is a read.
    let Some(subject) = SUBJECT.read().clone() else { return rsx! {} };

    let mut screen = use_signal(|| Screen::List);
    let mut busy = use_signal(|| false);
    let mut problem = use_signal(|| subject.problem.clone());
    // TRANSIENT, and cleared on every transition INTO the passphrase screen
    // (entry.ts:340's `passInput.value = ""`) — a value typed for one row
    // must not survive to prefill another's field.
    let mut passphrase_value = use_signal(String::new);
    // READ ONCE PER MOUNT, and a mount is a presentation (naming.rs's
    // `use_hook` idiom for the identical reason): these are sync host
    // queries and cannot change mid-ceremony.
    let supports_passkey = use_hook(host::supports_passkey);
    let supports_restore = use_hook(host::supports_restore);

    let mut go_passphrase = move |row: Row| {
        passphrase_value.set(String::new());
        screen.set(Screen::Passphrase(row));
    };

    let mut do_open = move |row: Row, passphrase: Option<String>| {
        if !owns(PICKER) || *busy.read() {
            return;
        }
        busy.set(true);
        problem.set(None);
        let wit_row = row_out(&row);
        crate::component::spawn(async move {
            let result = host::open(wit_row, passphrase).await;
            if !owns(PICKER) {
                return;
            }
            match result {
                Ok(()) => close(PICKER, true),
                Err(refusal) => {
                    busy.set(false);
                    problem.set(Some(refusal.message));
                    // THE ONE THING A REFUSAL CAN DO BESIDES REPORT
                    // (entry.ts:363-369): reveal the field, when the device
                    // is ASKING rather than FAILING.
                    if refusal.needs_passphrase {
                        go_passphrase(row);
                    }
                }
            }
        });
    };

    let do_open_new = move |_| {
        if !owns(PICKER) || *busy.read() {
            return;
        }
        busy.set(true);
        problem.set(None);
        crate::component::spawn(async move {
            let result = host::open_new().await;
            if !owns(PICKER) {
                return;
            }
            match result {
                Ok(()) => close(PICKER, true),
                Err(message) => {
                    busy.set(false);
                    problem.set(Some(message));
                }
            }
        });
    };

    let do_restore = move |_| {
        if !owns(PICKER) || *busy.read() {
            return;
        }
        // THE HANDOVER (entry.ts:472-484): close first, then call. The
        // picker is exclusive, so the drawer has to be given up before a
        // ceremony that needs it can open, and closing first means a host
        // whose ceremony throws immediately cannot leave two sheets
        // contending for the same slot. Busy is set so a second tap on a
        // control that is about to vanish is a no-op, not a second call.
        busy.set(true);
        close(PICKER, true);
        crate::component::spawn(async move {
            let _ = host::restore().await;
        });
    };

    let current = screen.read().clone();
    let problem_line = problem.read().clone();

    rsx! {
        SheetRoot { tenant: PICKER.to_string(), class: "cred-sheet",
            Frame { key_for: screen_key(&current, problem_line.is_some()),
            h2 { "Which device is this?" }
            p { class: "cred-note",
                "This browser holds more than one. Pick the one you want to open; nothing of yours is shown until it is."
            }

            match &current {
                Screen::List => rsx! {
                    div {
                        for row in subject.rows.iter().cloned() {
                            div { key: "{row.id}", class: "device-row",
                                {
                                    let tap_row = row.clone();
                                    rsx! {
                                        button {
                                            r#type: "button",
                                            class: "device-pick",
                                            "data-petname": "{row.petname}",
                                            onclick: move |_| {
                                                match initial_action(&tap_row) {
                                                    InitialAction::AskPasskey => screen.set(Screen::Passkey(tap_row.clone())),
                                                    InitialAction::AskPassphrase => go_passphrase(tap_row.clone()),
                                                    InitialAction::ChooseNow => do_open(tap_row.clone(), None),
                                                }
                                            },
                                            // USER VOICE: the petname, plain, unquoted — the strip's own rule.
                                            "{row.petname}"
                                        }
                                    }
                                }
                                span { class: "device-when", "{last_used_line(row.last_used)}" }
                            }
                        }
                    }

                    div { class: "entry-problem", hidden: problem_line.is_none(),
                        if let Some(p) = &problem_line { "{p}" }
                    }

                    button {
                        r#type: "button",
                        id: "device-new",
                        disabled: *busy.read(),
                        onclick: do_open_new,
                        "Set up a new device here"
                    }
                    // SECONDARY, not primary (entry.ts:299-312): recovery is
                    // the rare door, drawn WHATEVER `rows` holds — the
                    // question it answers is independent of what this
                    // browser happens to remember.
                    if supports_restore {
                        button {
                            r#type: "button",
                            class: "entry-secondary",
                            disabled: *busy.read(),
                            onclick: do_restore,
                            "Restore from a recovery kit…"
                        }
                    }
                },

                Screen::Passphrase(row) => {
                    let row = row.clone();
                    let row_for_submit = row.clone();
                    rsx! {
                        div { class: "cred-field",
                            label { r#for: "device-pass-input",
                                "The passphrase for "
                                span { "{row.petname}" }
                            }
                            input {
                                id: "device-pass-input",
                                r#type: "password",
                                autocomplete: "off",
                                value: "{passphrase_value}",
                                oninput: move |e| passphrase_value.set(e.value()),
                            }
                        }
                        div { class: "entry-problem", hidden: problem_line.is_none(),
                            if let Some(p) = &problem_line { "{p}" }
                        }
                        button {
                            r#type: "button",
                            disabled: *busy.read(),
                            onclick: move |_| do_open(row_for_submit.clone(), Some(passphrase_value.read().clone())),
                            "Open this device"
                        }
                    }
                },

                Screen::Passkey(row) => {
                    let row = row.clone();
                    let row_for_open = row.clone();
                    let row_for_fallback = row.clone();
                    rsx! {
                        div { class: "cred-line",
                            "The passkey for "
                            span { "{row.petname}" }
                        }
                        div { class: "entry-problem", hidden: problem_line.is_none(),
                            if let Some(p) = &problem_line { "{p}" }
                        }
                        button {
                            r#type: "button",
                            disabled: *busy.read(),
                            onclick: move |_| {
                                if !supports_passkey {
                                    // AN EMBEDDER THAT CANNOT: honest degrade,
                                    // not a silent swap to a ceremony the user
                                    // did not ask for (entry.ts:388-399).
                                    problem.set(Some("this page cannot open devices with a passkey".into()));
                                    return;
                                }
                                if !owns(PICKER) || *busy.read() {
                                    return;
                                }
                                busy.set(true);
                                problem.set(None);
                                let row = row_for_open.clone();
                                let wit_row = row_out(&row);
                                crate::component::spawn(async move {
                                    let result = host::open_with_passkey(wit_row).await;
                                    if !owns(PICKER) {
                                        return;
                                    }
                                    match result {
                                        Ok(()) => close(PICKER, true),
                                        Err(refusal) => {
                                            busy.set(false);
                                            problem.set(Some(refusal.message));
                                            if refusal.needs_passphrase {
                                                go_passphrase(row);
                                            }
                                        }
                                    }
                                });
                            },
                            "Use your passkey"
                        }
                        // THE FALLBACK — see the module header. Offered
                        // unconditionally: a device with no user-origin
                        // passphrase simply refuses at the host.
                        button {
                            r#type: "button",
                            class: "entry-secondary",
                            disabled: *busy.read(),
                            onclick: move |_| {
                                if !owns(PICKER) || *busy.read() {
                                    return;
                                }
                                go_passphrase(row_for_fallback.clone());
                            },
                            "use your passphrase instead"
                        }
                    }
                },
            }
            }
        }
    }
}
