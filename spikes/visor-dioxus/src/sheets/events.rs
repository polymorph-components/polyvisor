//! THE EVENT LIST (`buildEventsSheet`, sheets.ts:1691-1804): what the visor has
//! said, kept after the line that said it expired.
//!
//! `Visor`'s event record and standing conditions (`events`, `conditions`)
//! are PRIVATE fields on `component.rs`'s `Visor` — no accessor exists for
//! them outside that module, by construction (nothing outside `component.rs`
//! should hold a second copy of either). The reads and the one write this
//! sheet needs (`list_events`, `list_conditions`, `unseen_event_count`,
//! `mark_events_seen`) go straight through [`VisorComponent`]'s own
//! `ControlGuest` implementation, exactly as `settings.rs` reaches
//! `speak_word`/`reroll_word` for the anchor word — see that module's header
//! for why that is the right seam and not a shortcut around one.

use dioxus::prelude::*;

use crate::component::{exports::polymorph::visor_spike::control::Guest as ControlGuest, now_ms, VisorComponent};
use crate::sheets::{close_ceremony, owns, SheetRoot, EVENTS};

/// A COARSE AGE, in the visor's own words (`agoWords`, sheets.ts:558-567).
///
/// DELIBERATELY COARSE and deliberately not a clock: see the module's own
/// governing comment at that site for why an exact timestamp is the wrong
/// thing to show. A future timestamp (a record written by a device whose
/// clock ran ahead) reads as "just now" rather than as a negative age, via
/// the same `max(0, …)` sheets.ts uses.
fn ago_words(at: u64, now: u64) -> String {
    let secs = now.saturating_sub(at) / 1000;
    if secs < 60 {
        return "just now".to_string();
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins} minute{} ago", if mins == 1 { "" } else { "s" });
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours} hour{} ago", if hours == 1 { "" } else { "s" });
    }
    let days = hours / 24;
    format!("{days} day{} ago", if days == 1 { "" } else { "s" })
}

#[component]
pub fn EventsSheet() -> Element {
    // OPENING IS THE ACKNOWLEDGMENT (sheets.ts:1782-1791), and it must run
    // BEFORE the list below is captured: the rows carry no seen/unseen
    // marking of their own, so marking afterwards would be indistinguishable
    // from marking before, and marking first is what makes the badge already
    // correct by the time the sheet finishes sliding in. `EVENTS` is not
    // suspendable (`sheets/mod.rs`'s specs), so every mount of this sheet is a
    // genuine open, never a resume — there is no second call to guard
    // against.
    //
    // CONTRACT: this is a WRITE reached from a render body, which
    // `component::with_visor`'s header forbids — and it is bounded only
    // because it sits inside a `use_hook`. The write marks the signal dirty and
    // this component is subscribed (the three reads below), so the first mount
    // costs one extra render pass; on that pass every `use_hook` returns its
    // cached value, nothing writes, and it settles. The settings sheet made the
    // same call UNCONDITIONALLY in its body and looped forever for it (the
    // browser found it as "SettingsSheet never renders").
    //
    // Left as it is rather than moved, because the acknowledgment belongs to
    // OPENING and sheets.ts:1782-1791 runs it in `openEventsDrawer` before the
    // build — so its real home is `export.rs`'s `request_events`, which is a
    // move, not a fix, and this dispatch is three defects wide. Reported.
    use_hook(VisorComponent::mark_events_seen);

    // RENDERED ONCE, AT OPEN — no ticking timer behind either the ages or the
    // list itself (sheets.ts:1687-1690). `use_hook` runs once per mount, and a
    // mount is a presentation, exactly as naming.rs's offer row is "freshly
    // per ceremony" for the same reason.
    let now = use_hook(now_ms);
    let conditions = use_hook(VisorComponent::list_conditions);
    let events = use_hook(VisorComponent::list_events);

    rsx! {
        SheetRoot { tenant: EVENTS.to_string(), class: "events-sheet",
            h2 { "Recent events" }

            // THE STANDING CONDITIONS, first — they are true RIGHT NOW
            // (sheets.ts:1673-1677). Session-live only: `list_conditions`
            // never touches storage, so nothing here persists across a
            // reload, which is correct — a condition is a state, not a
            // record.
            if !conditions.is_empty() {
                div { class: "events-standing",
                    for (_key , text) in conditions.iter() {
                        div { class: "events-standing-line",
                            span { class: "said", "ongoing:" }
                            span { "{text}" }
                        }
                    }
                }
            }

            if !events.is_empty() {
                div { class: "events-list",
                    for e in events.iter() {
                        div { class: "events-row",
                            span { class: "said events-when", "{ago_words(e.at, now)}" }
                            // EVERY LINE IS FRAMEWORK VOICE, rendered
                            // undressed — `control.add-event` takes a flat
                            // string, so an app-influenced one is not
                            // admissible into the record in the first place
                            // (sheets.ts:1678-1685). No plate, no quoting.
                            span { "{e.text}" }
                        }
                    }
                }
            }

            // THE EMPTY STATE, said plainly and said at all: a sheet that
            // opened onto a heading and nothing else would read as a failure
            // to load rather than as good news (sheets.ts:1749-1757).
            if conditions.is_empty() && events.is_empty() {
                div { class: "cred-note", "nothing to report" }
            }

            div { class: "cred-note",
                "this list is the visor's own — every line here was said by the visor or the system behind it, never by an app"
            }

            div { class: "cred-row",
                button {
                    r#type: "button",
                    onclick: move |_| {
                        if !owns(EVENTS) {
                            return;
                        }
                        // A plain close: the settings sheet that opened this
                        // one was SUSPENDED, not closed, so the drawer resumes
                        // it here (sheets.ts:1793-1800).
                        close_ceremony(EVENTS, true);
                    },
                    "Close"
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: `sheets` is wasm32-only (`lib.rs`), so these do not run under a
    // host `cargo test` — see the spike report.

    #[test]
    fn just_now_covers_zero_to_just_under_a_minute() {
        assert_eq!(ago_words(1_000, 1_000), "just now");
        assert_eq!(ago_words(1_000, 1_000 + 59_000), "just now");
    }

    #[test]
    fn a_future_timestamp_reads_as_just_now_not_negative() {
        assert_eq!(ago_words(10_000, 1_000), "just now");
    }

    #[test]
    fn minute_boundary() {
        assert_eq!(ago_words(0, 60_000), "1 minute ago");
        assert_eq!(ago_words(0, 61_000), "1 minute ago");
        assert_eq!(ago_words(0, 120_000), "2 minutes ago");
    }

    #[test]
    fn hour_boundary() {
        assert_eq!(ago_words(0, 59 * 60_000), "59 minutes ago");
        assert_eq!(ago_words(0, 60 * 60_000), "1 hour ago");
        assert_eq!(ago_words(0, 2 * 60 * 60_000), "2 hours ago");
    }

    #[test]
    fn day_boundary() {
        assert_eq!(ago_words(0, 23 * 60 * 60_000), "23 hours ago");
        assert_eq!(ago_words(0, 24 * 60 * 60_000), "1 day ago");
        assert_eq!(ago_words(0, 3 * 24 * 60 * 60_000), "3 days ago");
    }
}
