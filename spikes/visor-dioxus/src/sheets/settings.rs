//! THE VISOR'S SETTINGS SHEET (`buildSettingsSheet`, sheets.ts:1038-1446): who
//! you are, what this device is called, the anchor colour, the anchor word,
//! and the ways out to the other two ceremonies.
//!
//! # Reaching the runtime `Visor` from a guest-internal caller
//!
//! `sheets/mod.rs`'s pattern gives ceremonies `with_visor`/`store`/`embedder`
//! to write with. Four things this sheet needs — the anchor word's two doors,
//! and reading the event/condition counts — live on fields `component.rs`
//! keeps PRIVATE on `Visor` (`word`, `events`, `conditions`), on purpose: the
//! anchor word's no-getter rule (wit/world.wit:209-215) and the fact that
//! nothing outside `component.rs` should cache a copy of the record. The only
//! doors are the ones `control`'s own guest implementation already is —
//! [`VisorComponent`]'s `ControlGuest` (`exports::…::control::Guest`) impl —
//! so this sheet calls straight through that impl exactly as a host would call
//! `control.speak-word()` / `control.list-events()`, except the call never
//! leaves the process. Nothing here reads `word` itself; the two doors stay
//! the only two doors.
//!
//! Everything else (`hue`, `claimed`, `identity`) IS `pub` on `Visor`, so those
//! are written directly through `with_visor`, table/store first — the same
//! discipline `naming.rs` and `sheets/mod.rs`'s own `load_marks`/`save_marks`
//! keep.

use dioxus::prelude::*;

use crate::component::{
    embedder, exports::polymorph::visor_spike::control::Guest as ControlGuest,
    polymorph::visor_spike::types::Identity as WitIdentity, read_visor, store, with_visor,
    VisorComponent,
};
use crate::sheets::{close_ceremony, open_ceremony, owns, Entry, SheetRoot, EVENTS, RESET, SETTINGS};
use crate::state::{identity_face, Context, Identity, VISOR_HUES};
use crate::voice::{MarkIcon, IDENTITY_MAX, UserVoice};

/// THE VISOR'S OWN BUTTON-FACE VOCABULARY, drawn as a picker (`VISOR_ICONS`,
/// visor.ts:290-293: `VISOR_ICON_CORE` followed by every `APP_MARK_ICONS`
/// glyph not already in it).
///
/// CONTRACT: transcribed rather than obtained from `voice.rs`, which exposes
/// `identity_icon` (a point lookup) and `app_marks` (just the 28) but no
/// iterator over the UNION `VISOR_ICONS` actually needs — the ten-glyph core
/// itself is a private const there. `naming.rs` transcribes `APP_MARK_ICONS`
/// for the same reason (its own module header says so). The
/// `core_icons_transcribed_correctly` test below is what catches a copy error
/// here: a mistyped glyph would silently fail to round-trip through
/// `identity_icon` and fall back to the shield instead of being caught at
/// compile time, because `MarkIcon`'s constructor is private.
const CORE_ICONS: [&str; 10] = ["⛨", "✶", "✦", "◆", "▲", "☘", "⚑", "✿", "☾", "⚙"];

fn identity_icons() -> impl Iterator<Item = MarkIcon> {
    CORE_ICONS.iter().map(|g| MarkIcon::identity_icon(Some(g))).chain(MarkIcon::app_marks())
}

#[component]
pub fn SettingsSheet() -> Element {
    // THE COMMITTED HUE, READ AT MOUNT — the port of sheets.ts's
    // `session.hueAtOpen`. `SheetsState` carries no field for it (unlike
    // naming's `Subject`) because nothing else can move the committed hue
    // while this ceremony holds (or is suspended holding) it: only this
    // sheet's own Save does, and Save always ends the ceremony. So a re-mount
    // on resume from the events/reset detour recomputes the identical value
    // rather than needing to remember it across the remount — a plain
    // `use_hook`, not a `SheetsState` field, does the job rule 2 asks for.
    let hue_at_open = use_hook(VisorComponent::committed_hue);

    let current = read_visor(|v| v.identity.clone()).unwrap_or_default();
    let initial_name = current.name.as_ref().map_or(String::new(), |n| n.as_str().to_string());
    let initial_device = current.device.as_ref().map_or(String::new(), |d| d.as_str().to_string());
    let initial_icon = identity_face(&current);
    let mut typed_name = use_signal(move || initial_name);
    let mut typed_device = use_signal(move || initial_device);
    let mut picked_icon = use_signal(move || initial_icon);
    let mut picked_hue = use_signal(move || hue_at_open);

    let revert_hue_preview = move || {
        // BY HAND, because suspension (see below) deliberately bypasses
        // whatever a "Cancel" would otherwise run — sheets.ts:1330-1359's
        // comment is the authority for both call sites this appears at.
        with_visor(|v| {
            if v.claimed {
                v.hue = Some(hue_at_open);
            }
        });
    };

    let commit = move |_| {
        if !owns(SETTINGS) {
            return;
        }
        let icon = *picked_icon.read();
        let name = UserVoice::new(&typed_name.read(), IDENTITY_MAX);
        let device = UserVoice::new(&typed_device.read(), IDENTITY_MAX);
        // THE TABLE FIRST: the identity record, then the committed hue, then
        // the embedder mirror, then close — `sheets/mod.rs`'s write order.
        let wit_identity = with_visor(|v| {
            v.identity = Identity { name, device, icon: Some(icon) };
            store::set(store::Slot::Identity, &v.identity.to_json());
            WitIdentity {
                name: v.identity.name.as_ref().map_or(String::new(), |n| n.as_str().to_string()),
                device: v.identity.device.as_ref().map_or(String::new(), |d| d.as_str().to_string()),
                icon: icon.as_str().to_string(),
            }
        });
        let hue = *picked_hue.read();
        // REMEMBER, PAINT, PERSIST — visor.ts:1418-1419's order, and
        // `commit_hue`'s own body inlined for the reason the module header
        // gives: `hue` is `pub`, so this needs no second door.
        with_visor(|v| {
            if v.claimed {
                v.hue = Some(hue);
                store::set(store::Slot::Hue, &hue.to_string());
            }
        });
        if let Some(rec) = wit_identity {
            // `on-identity-committed` fires AFTER both writes above, so a
            // consumer's mirror can only ever be late, never contradictory.
            embedder::on_identity_committed(&rec, hue);
        }
        close_ceremony(SETTINGS, true);
    };

    let cancel = move |_| {
        if !owns(SETTINGS) {
            return;
        }
        revert_hue_preview();
        close_ceremony(SETTINGS, true);
    };

    let open_events = move |_| {
        if !owns(SETTINGS) {
            return;
        }
        // THE ERASE ENTRY'S MOTION, EXACTLY: revert the live preview by hand
        // (suspension bypasses it), then let the drawer suspend this tenant
        // — `TenantSpec.suspendable` on `SETTINGS` (`sheets/mod.rs`'s specs)
        // already does that the moment `EVENTS` opens over it, so nothing
        // here has to ask for it.
        revert_hue_preview();
        open_ceremony(EVENTS, Context::Events, Entry::FromSettings);
    };

    let open_reset = move |_| {
        if !owns(SETTINGS) {
            return;
        }
        revert_hue_preview();
        open_ceremony(RESET, Context::Reset, Entry::FromSettings);
    };

    let unseen = VisorComponent::unseen_event_count();
    let events_label = if unseen > 0 {
        format!("recent events — {unseen} unseen")
    } else {
        "recent events".to_string()
    };

    let extra_actions = read_visor(|v| v.sheets.extra_actions.clone()).unwrap_or_default();

    rsx! {
        SheetRoot { tenant: SETTINGS.to_string(), class: "settings-sheet",
            div { class: "settings-head",
                h2 { "Your visor" }
                // THE DANGER ENTRY: upper-right corner, beside the heading and
                // with no interactive neighbour — see the module's governing
                // comment at `sheets.ts:1295-1315` for why the corner and not
                // the foot of the sheet.
                div { class: "settings-reset",
                    button {
                        r#type: "button",
                        id: "visor-settings-reset",
                        class: "reset",
                        onclick: open_reset,
                        "erase this visor…"
                    }
                    div { class: "hint",
                        "wipes your name, this device's word, the colour and every petname — a confirmation explains first"
                    }
                }
            }

            div { class: "cred-line said",
                "these are yours: the visor says them in its own voice, and no component is ever told them"
            }

            div { class: "cred-field",
                label { r#for: "visor-settings-name", "Your name" }
                input {
                    id: "visor-settings-name",
                    r#type: "text",
                    autocomplete: "off",
                    maxlength: "{IDENTITY_MAX}",
                    value: "{typed_name}",
                    oninput: move |e| typed_name.set(e.value()),
                }
                div { class: "hint",
                    "shown at the right of this bar — leave it empty and the visor shows nothing there"
                }
            }
            div { class: "cred-field",
                label { r#for: "visor-settings-device", "This device" }
                input {
                    id: "visor-settings-device",
                    r#type: "text",
                    autocomplete: "off",
                    maxlength: "{IDENTITY_MAX}",
                    value: "{typed_device}",
                    oninput: move |e| typed_device.set(e.value()),
                }
                div { class: "hint", "your word for the machine you are on — e.g. laptop, study PC" }
            }

            div { class: "cred-line said", "the visor's mark on this bar" }
            div { class: "settings-icons",
                for glyph in identity_icons() {
                    button {
                        key: "{glyph.as_str()}",
                        r#type: "button",
                        "data-glyph": "{glyph.as_str()}",
                        title: "use {glyph.as_str()}",
                        class: if *picked_icon.read() == glyph { "picked" } else { "" },
                        onclick: move |_| picked_icon.set(glyph),
                        "{glyph.as_str()}"
                    }
                }
            }

            div { class: "cred-line said", "this bar's colour — yours, and never disclosed to an app" }
            div { class: "settings-hues",
                for hue in VISOR_HUES {
                    button {
                        key: "{hue}",
                        r#type: "button",
                        style: "background: oklch(38% .07 {hue});",
                        "data-hue": "{hue}",
                        title: "hue {hue}",
                        class: if *picked_hue.read() == hue { "picked" } else { "" },
                        onclick: move |_| {
                            picked_hue.set(hue);
                            // LIVE PREVIEW, uncommitted — `apply_hue`'s own
                            // body inlined for the same reason `commit_hue`'s
                            // is above: `hue` is `pub`, `claimed` is `pub`,
                            // and there is nothing more to it. No announce:
                            // the announced-reset rule is for changes the
                            // user did NOT make.
                            with_visor(|v| {
                                if v.claimed {
                                    v.hue = Some(hue);
                                }
                            });
                        },
                    }
                }
            }

            // THE AUDIBLE ANCHOR. `speak_word`/`reroll_word` are the visor's
            // only two doors onto the word (wit/world.wit:209-215); this sheet
            // has no other way to touch it and asks for none — see the module
            // header.
            div { class: "cred-line said",
                "this visor's spoken word — said out loud, shown to nobody, and never given to an app"
            }
            div { class: "settings-word",
                button {
                    r#type: "button",
                    id: "visor-settings-hear-word",
                    onclick: move |_| { VisorComponent::speak_word(); },
                    "hear your visor's word"
                }
                button {
                    r#type: "button",
                    id: "visor-settings-roll-word",
                    onclick: move |_| { VisorComponent::reroll_word(); },
                    "roll a new word"
                }
            }

            div { class: "cred-note",
                "this sheet is the visor's, opened from the bar below it — a component cannot draw here, and none of this is ever given to one"
            }

            // THE RECENT-EVENTS ROW: framework policy, not a consumer action
            // (see the module header on `sheets/mod.rs`'s `settings.ts:1207-1213`
            // rationale) — it sits BEFORE the consumer's own actions.
            div { class: "cred-field",
                button {
                    r#type: "button",
                    id: "visor-settings-events",
                    class: "settings-extra-action",
                    onclick: open_events,
                    "{events_label}"
                }
            }

            // CONSUMER-CONTRIBUTED ACTIONS. An empty list renders NOTHING —
            // no heading, no container, no separator (wit/world.wit:326-332).
            if !extra_actions.is_empty() {
                div { class: "settings-extra",
                    for action in extra_actions {
                        div { class: "cred-field",
                            button {
                                r#type: "button",
                                class: "settings-extra-action",
                                "data-action": "{action.key}",
                                onclick: {
                                    let key = action.key.clone();
                                    move |_| {
                                        if !owns(SETTINGS) {
                                            return;
                                        }
                                        // THE ACTION LEAVES THIS SHEET: close
                                        // first (a plain close — no commit,
                                        // so an uncommitted colour reverts
                                        // exactly as Cancel would), THEN
                                        // report the key.
                                        close_ceremony(SETTINGS, true);
                                        embedder::on_action(&key);
                                    }
                                },
                                "{action.label.as_str()}"
                            }
                            if let Some(hint) = &action.hint {
                                div { class: "hint", "{hint.as_str()}" }
                            }
                        }
                    }
                }
            }

            div { class: "cred-row",
                button { r#type: "button", onclick: commit, "Save" }
                button { r#type: "button", onclick: cancel, "Cancel" }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the transcription in [`CORE_ICONS`]: every glyph must be a
    /// member of `voice.rs`'s own `VISOR_ICON_CORE`, or it would silently
    /// render as the shield instead of itself (`MarkIcon`'s constructor is
    /// private, so a typo cannot be caught any other way than round-tripping
    /// it through the one public lookup).
    ///
    /// NOTE: `sheets` is wasm32-only (`lib.rs`), so this test does not run
    /// under a host `cargo test` — see the spike report for why the crate is
    /// split that way and what that costs this file's test coverage.
    #[test]
    fn core_icons_transcribed_correctly() {
        for glyph in CORE_ICONS {
            assert_eq!(MarkIcon::identity_icon(Some(glyph)).as_str(), glyph);
        }
    }
}
