//! THE `pairing` EXPORT (wit/world.wit:708-723), and the router that grows the
//! right ceremony inside a slide.
//!
//! It lives here rather than in `component.rs` for `sheets/export.rs`'s reason:
//! `component.rs` is the WIT seam for the STRIP and the drawer host, and the
//! ceremonies are a layer built on that mechanism. `wit_bindgen`'s `export!` is
//! indifferent to which module an `impl ... for VisorComponent` is written in.

use dioxus::prelude::*;

use super::us::{clamp_petname, describe, BootCache, UsEvent};
use super::{context_for, phase::Line, say_all, ADD, JOIN};
use crate::component::exports::polymorph::visor_spike::pairing::Guest as PairingGuest;
use crate::component::polymorph::visor_spike::pairing_driver as driver;
use crate::component::{read_visor, store, VisorComponent};

/// THE SHEET LIVING IN ONE SLIDE, for the two pairing tenants.
///
/// `crate::sheets::Sheet`'s twin, and reached from the same router: a slide
/// whose tenant `super::is_pairing_tenant` recognises is grown by the guest,
/// exactly as the visor's own four are, rather than left as a leaf awaiting
/// foreign DOM.
///
/// Nothing is rendered for a name that is neither — an empty sheet is a slide
/// with no height, which the drawer already handles.
#[component]
pub fn PairingSheet(tenant: String) -> Element {
    match tenant.as_str() {
        JOIN => rsx! { super::join::JoinSheet {} },
        ADD => rsx! { super::add::AddSheet {} },
        _ => rsx! {},
    }
}

/// `us-event` -> the local value. The one seam that names the generated
/// variants; `super::us` is pure below it.
fn event_in(ev: driver::UsEvent) -> UsEvent {
    match ev {
        driver::UsEvent::ProfileChanged => UsEvent::ProfileChanged,
        driver::UsEvent::MarkAdded(p) => UsEvent::MarkAdded(p),
        driver::UsEvent::MarkChanged(p) => UsEvent::MarkChanged(p),
        driver::UsEvent::MarkConflictRepaired((p, field)) => {
            UsEvent::MarkConflictRepaired(p, field)
        }
        driver::UsEvent::DeviceAdded(name) => UsEvent::DeviceAdded(name),
        driver::UsEvent::DeviceRevoked(name) => UsEvent::DeviceRevoked(name),
        driver::UsEvent::StorageChanged(provider) => UsEvent::StorageChanged(provider),
    }
}

impl PairingGuest for VisorComponent {
    /// JOIN THIS DEVICE TO AN EXISTING ACCOUNT.
    ///
    /// The ceremony's own work — asking for an offer, drawing the code and the
    /// QR, polling — belongs to the sheet, which starts it from a `use_future`
    /// on mount. This does nothing but open the drawer, for the reason
    /// `crate::sheets`'s rule 2 gives: a session that outlived its sheet would
    /// be state that did not die with the presentation, and a pairing session
    /// is the last thing that should survive its own screen going away.
    fn request_join() {
        request_join_from_entry();
    }

    /// ADMIT ANOTHER DEVICE. Same shape; the heavy half is `add.rs`'s.
    fn request_add() {
        super::open(ADD, context_for(ADD));
    }

    fn join_open() -> bool {
        read_visor(|v| v.drawer.is_open(JOIN)).unwrap_or(false)
    }

    fn add_open() -> bool {
        read_visor(|v| v.drawer.is_open(ADD)).unwrap_or(false)
    }

    /// CONTRACT: ONE CLOSE FOR BOTH, because `pairing.close-pairing` takes no
    /// tenant (wit/world.wit:719). The two are mutually exclusive in practice —
    /// both are registered `exclusive`, so the drawer cannot be holding both —
    /// and closing a tenant that is not open is a no-op in the drawer machine.
    /// So closing both unconditionally is exact rather than merely safe.
    ///
    /// NO `pair-abort` HERE, and the asymmetry with the sheets' own Cancel
    /// buttons is deliberate. This is the CONSUMER closing the visor's sheet —
    /// a page navigating away, a host tearing down — not the user abandoning a
    /// ceremony. Aborting a live session on the consumer's behalf would destroy
    /// a pairing the user may be mid-way through on the other device, and the
    /// consumer never said to. The user's own way out is the Cancel button,
    /// which does abort.
    fn close_pairing(restore_context: bool) {
        super::close(JOIN, restore_context);
        super::close(ADD, restore_context);
    }

    /// DRAIN THE ACCOUNT'S REMOTE-CHANGE EVENTS ONCE, AND ANNOUNCE EVERY ONE.
    ///
    /// ANNOUNCED-NEVER-SILENT (wit/world.wit:610-612, PAIRING.md §5). Local-echo
    /// suppression is the backend's job, so every drained event is announced
    /// without second-guessing provenance — see `super::us`'s header for why
    /// the visor trying to recognise its own writes would fail in the worse
    /// direction.
    ///
    /// EVERY ONE IS CONSEQUENTIAL. That is `visor/ui/pairing.ts:376`'s
    /// judgement (`status(describeEvent(...), true)` — the flag is hard-coded
    /// true for the whole batch) and it is right: nothing reaches this drain
    /// except a change to the user's own identity, trust records or devices
    /// made somewhere they were not looking. There is no ambient traffic on
    /// this path to protect. As a consequence each one also LEAVES A RECORD
    /// (`super::say`, rule 2), which is what makes "I was told about this at
    /// the time" checkable later.
    ///
    /// A FAILED DRAIN IS SILENT. `us-events` erring is a backend that is
    /// momentarily unreachable; the consumer polls, and the next drain gets the
    /// same events (they have not been consumed). Announcing the error would
    /// put a line the user can do nothing about on the strip once per poll.
    async fn drain_us_events() {
        let Ok(events) = driver::us_events().await else { return };
        if events.is_empty() {
            return;
        }
        let events: Vec<UsEvent> = events.into_iter().map(event_in).collect();

        // A COMPONENT IS NAMED BY THE USER'S WORD FOR IT, so a batch carrying
        // any mark event needs the account's marks. ONE list call per batch,
        // and only when the batch actually mentions a record
        // (pairing.ts:357-374): the drain runs on a poll and most batches are
        // empty, so the common path stays a single round trip.
        //
        // A FAILED LIST IS NOT A FAILED DRAIN — the sentences fall back to
        // their unnamed forms, which is the same degradation as a record the
        // list does not return.
        let mut names: Vec<(String, String)> = Vec::new();
        if events.iter().any(|e| e.provenance().is_some()) {
            if let Ok(marks) = driver::us_marks_list().await {
                for m in marks {
                    if let Some(petname) = clamp_petname(&m.petname) {
                        names.push((m.provenance, petname));
                    }
                }
            }
        }
        let petname_of = |provenance: &str| {
            names.iter().find(|(k, _)| k == provenance).map(|(_, n)| n.clone())
        };

        // ONE WRITE FOR THE WHOLE BATCH — see `super::say_all`. A drain that
        // reported three changes and announced only the third would be
        // announced-never-silent broken by the announcing mechanism. Each still
        // leaves its own event record.
        say_all(
            events
                .iter()
                .map(|ev| Line { text: describe(ev, petname_of), consequential: true })
                .collect(),
        );
    }

    /// RECONCILE THE BOOT CACHE AGAINST THE PARTITION, and announce the
    /// difference (wit/world.wit:747-754).
    ///
    /// THE OTHER HALF OF ANNOUNCED-NEVER-SILENT. `drain-us-events` covers what
    /// changed while this device was running. This covers what changed while it
    /// was NOT — a colour or a name set on another device between boots
    /// produces no event to drain, so without this the visor would come up
    /// wearing it and say nothing, which is precisely the "anchor that quietly
    /// changes" failure the whole rule exists to prevent.
    ///
    /// # The ordering, which is the opposite of the TypeScript's
    ///
    /// `visor/ui/pairing.ts:470` writes the cache and THEN hands the profile to
    /// the consumer. Here the announcement goes first and the cache is written
    /// after, because the two failure modes are not symmetric under this
    /// module's own rule:
    ///
    ///   - cache first, then announce: a failure between them leaves the cache
    ///     agreeing with the account and the user never told. The change is
    ///     lost permanently — no later boot will see a difference.
    ///   - announce first, then cache: the same failure means the user is told
    ///     TWICE, once now and once on the next boot.
    ///
    /// Being told twice about a real change is a nuisance; not being told at
    /// all is the thing this function exists to prevent. Same reasoning as
    /// `super::say`'s record-before-announce, and as `sheets/reset.rs`'s
    /// fallible-half-first: when an ordering can only be wrong one way, take
    /// the way that fails loudly.
    ///
    /// A FAILED READ IS SILENT and writes nothing. An unreachable partition is
    /// not a changed one, and adopting its silence into the cache would make
    /// the next boot believe it had already reported a difference it never saw.
    async fn reconcile() {
        let Ok(profile) = driver::us_profile_get().await else { return };
        let cache = BootCache::parse(store::get(store::Slot::Account).as_deref());
        let (lines, next) = super::us::reconcile(&cache, profile.hue, &profile.display_name);
        // CONSEQUENTIAL, every one: a change to the user's own identity made
        // somewhere they were not looking is the archetype of the class. Each
        // leaves a record; the announcement is ONE write, because a colour
        // change followed by a rename would otherwise announce only the rename
        // (`super::say_all`).
        say_all(lines.into_iter().map(|text| Line { text, consequential: true }).collect());
        store::set(store::Slot::Account, &next.to_json());
    }
}


/// The join ceremony, reachable from the first-run fork's third choice as well
/// as from the `pairing` export.
///
/// A FREE FUNCTION because `entry::fork` cannot call a `Guest` trait method
/// without naming `VisorComponent` and the trait — a lot of coupling for one
/// press — and because the two callers must not drift: the fork opening a
/// *differently configured* join ceremony than the export does is exactly the
/// kind of divergence that would only show up in one of the two paths.
pub fn request_join_from_entry() {
    super::open(JOIN, context_for(JOIN));
}
