//! THE TWO EXPORTS THIS MODULE OWNS: `marks` (the trust table, consumer-facing)
//! and `sheets` (the four ceremonies).
//!
//! They live here rather than in `component.rs` for the reason `component.rs`
//! exists at all — it is the WIT seam for the STRIP and the drawer host, and
//! the ceremonies are a second layer built on that mechanism, exactly as
//! sheets.ts is a separate module from visor.ts and for the same stated reason
//! (sheets.ts:23-27). `wit_bindgen`'s `export!` is indifferent to which module
//! an `impl ... for VisorComponent` is written in.
//!
//! EVERY `marks` FUNCTION IS STATELESS (wit/world.wit:254-257): each loads the
//! slot, does one thing and — if it changed anything — saves. There is no
//! cached table in this crate, which is what makes two facades over one key the
//! same TABLE rather than two caches that can disagree.

use crate::component::exports::polymorph::visor_spike::marks::{
    Clash, Entry as WitEntry, Guest as MarksGuest, Marked, Offer, PetMark as WitPetMark,
};
use crate::component::exports::polymorph::visor_spike::sheets::{
    Action as WitAction, Guest as SheetsGuest,
};
use crate::component::polymorph::visor_spike::types::Surface as WitSurface;
use crate::component::{now_ms, store, with_visor, VisorComponent};
use crate::marks::PetMark;
use crate::sheets::{
    close_ceremony, ensure_registered, load_marks, naming, open_ceremony, save_marks, Action,
    Entry, EVENTS, NAMING, RESET, SETTINGS,
};
use crate::state::{surface_with, Context};
use crate::voice::{FrameworkText, MarkIcon, UserVoice, NAME_MAX};

fn mark_out(m: &PetMark) -> WitPetMark {
    WitPetMark {
        // "" IS THE UNMARKED STATE and is what crosses the boundary for it —
        // a real, honest value rather than an absent one (wit/world.wit:260-262).
        icon: m.icon.map_or(String::new(), |i| i.as_str().to_string()),
        first_seen: m.first_seen,
        petname: m.petname.as_ref().map(|p| p.as_str().to_string()),
    }
}

impl MarksGuest for VisorComponent {
    fn list_all() -> Vec<WitEntry> {
        load_marks()
            .iter()
            .map(|(k, m)| WitEntry { provenance: k.to_string(), mark: mark_out(m) })
            .collect()
    }

    fn mark(provenance: String) -> Marked {
        let mut table = load_marks();
        let (mark, is_new) = table.mark(&provenance, now_ms());
        // SAVED ONLY WHEN IT CREATED SOMETHING. A read is a read: normalisation
        // is never written back, so a table this call merely displayed cannot
        // be rewritten — and a `hue`-schema record keeps its old bytes until
        // the user actually names the component (marks.rs's `parse`).
        if is_new {
            save_marks(&table);
        }
        Marked { mark: mark_out(&mark), is_new }
    }

    /// THE WRITE-SIDE GATE lives here, because this is the site that sees the
    /// raw string: `icon` must be a member of the curated table, or "" for
    /// unmarked, and ANYTHING ELSE IS STORED AS "" RATHER THAN TRUSTED
    /// (wit/world.wit:283-285). `MarkIcon::app_mark` is that gate and it
    /// returns `None` for every refusal, so the untrusted string has nowhere to
    /// go from here.
    fn set_petname(provenance: String, petname: String, icon: String) {
        let mut table = load_marks();
        table.set_petname(
            &provenance,
            UserVoice::new(&petname, NAME_MAX),
            MarkIcon::app_mark(&icon),
            now_ms(),
        );
        save_marks(&table);
    }

    fn forget(provenance: String) {
        let mut table = load_marks();
        table.forget(&provenance);
        save_marks(&table);
    }

    /// THE KEY IS REMOVED, not overwritten with an empty table
    /// (wit/world.wit:290-292, sheets.ts:177-180), so what is left behind is
    /// indistinguishable from a device that never had one.
    fn erase_all() {
        store::remove(store::Slot::Marks);
    }

    fn free_icons(provenance: String) -> Vec<String> {
        load_marks()
            .free_icons(&provenance)
            .into_iter()
            .map(|g| g.as_str().to_string())
            .collect()
    }

    /// `nomination` passes the SAME firewall as any other mark before it is
    /// offered: an invalid one becomes `None` here and is therefore dropped in
    /// exactly the silence a CLAIMED one is dropped in, which is the property
    /// wit/world.wit:268-271 asks for — "the component learns nothing either
    /// way".
    fn icon_offers(provenance: String, nomination: Option<String>) -> Vec<Offer> {
        load_marks()
            .icon_offers(&provenance, nomination.as_deref().and_then(MarkIcon::app_mark))
            .into_iter()
            .map(|(glyph, nominated)| Offer { glyph: glyph.as_str().to_string(), nominated })
            .collect()
    }

    fn collision(provenance: String, petname: String) -> Option<Clash> {
        load_marks()
            .collision(&provenance, &petname)
            .map(|(key, petname)| Clash { key, petname })
    }
}

impl SheetsGuest for VisorComponent {
    /// The consumer's static contributions — and THE DOCUMENTED PLACE THE FOUR
    /// TENANTS GET REGISTERED. See `sheets::ensure_registered` for why
    /// registration is here and not at boot: registration order is precedence
    /// order, and a consumer with an exclusive tenant of its own has to be able
    /// to register it FIRST.
    fn configure(reset_consequences: Vec<String>, extra_actions: Vec<WitAction>) {
        ensure_registered();
        with_visor(|v| {
            v.sheets.reset_consequences =
                reset_consequences.into_iter().map(FrameworkText::from).collect();
            v.sheets.extra_actions = extra_actions
                .into_iter()
                .map(|a| Action {
                    label: FrameworkText::from(a.label),
                    hint: a.hint.map(FrameworkText::from),
                    key: a.key,
                })
                .collect();
        });
    }

    /// THE NAMING CEREMONY. The trust table is read HERE rather than in the
    /// sheet, and the record is CREATED if there is none: opening the ceremony
    /// for a component is a sighting, and the first-sight timestamp the sheet
    /// shows has to exist before the sheet can show it.
    fn request_naming(target: WitSurface) {
        let mut table = load_marks();
        let (mark, is_new) = table.mark(&target.name, now_ms());
        if is_new {
            save_marks(&table);
        }
        let surface = surface_with(
            target.name.clone(),
            &target.nickname,
            &target.icon,
            target.is_new,
            target.petname.as_deref(),
            // THE COMPONENT'S NOMINATION, carried through to the picker. It is
            // re-validated by `surface_with` (`MarkIcon::app_mark` is the only
            // constructor), and the ceremony still drops it if another record
            // wears the glyph — the caller pre-validating changes neither.
            target.nomination.as_deref(),
            // `meta.value` may be component-influenced, so it crosses as a bare
            // string exactly once, here, and becomes `AppVoice` inside
            // `surface_with`. `label` is the visor's own word and stays plain.
            target.meta.as_ref().map(|m| (m.label.clone(), m.value.as_str(), m.foreign)),
            // FIRST SIGHT IS THE VISOR'S OWN MEMORY, so the TRUST TABLE wins
            // over whatever the caller put on `types.surface.first-seen`. The
            // line it feeds says "you have seen this before, since …" in the
            // visor's own voice, and a consumer-supplied date would be the
            // visor vouching for a number it did not observe. The record was
            // just created or read three lines above, so it always has one.
            Some(mark.first_seen).filter(|t| *t > 0),
        );
        let subject = naming::Subject { surface: surface.clone() };
        with_visor(|v| v.sheets.naming = Some(subject));
        // THE STRIP NAMES THE SHEET hanging off it: `Context::Naming` is what
        // puts "naming" on the bottom line while this ceremony holds the
        // drawer, and it carries the surface both lines are about.
        if !open_ceremony(NAMING, Context::Naming(surface), Entry::FromOutside) {
            // Refused — by the consumer's `can-open`, or by an exclusive tenant
            // holding the drawer. The subject must not be left behind: a stale
            // one would be what the NEXT ceremony rendered.
            with_visor(|v| v.sheets.naming = None);
        }
    }

    fn request_settings() {
        open_ceremony(SETTINGS, Context::Settings, Entry::FromOutside);
    }

    /// Reachable in the UI ONLY from the settings sheet's danger entry
    /// (wit/world.wit:346-347), which is why it does NOT re-run the consumer's
    /// preconditions — see `sheets::Entry`. A consumer's own driving hook and
    /// the e2e suite reach it here too, and get the same treatment: the refusal
    /// that still applies is the drawer host's own.
    fn request_reset() {
        open_ceremony(RESET, Context::Reset, Entry::FromSettings);
    }

    fn request_events() {
        open_ceremony(EVENTS, Context::Events, Entry::FromSettings);
    }

    fn close_naming(restore_context: bool) {
        close_ceremony(NAMING, restore_context);
        with_visor(|v| v.sheets.naming = None);
    }

    /// CONTRACT: `commit` is the settings sheet's own Save-versus-Cancel
    /// (wit/world.wit:355-356) and the hue revert it selects is
    /// `beforeCollapse`'s (sheets.ts:654-657). `TenantSpec` carries no
    /// callbacks — they became `embedder` notifications — so the revert has no
    /// home in the drawer machine and belongs to the settings sheet, which
    /// commits the hue on Save and is wave two's. Accepted and forwarded here
    /// so the signature is complete and the sheet can honour it.
    fn close_settings(restore_context: bool, _commit: bool) {
        close_ceremony(SETTINGS, restore_context);
    }

    fn close_reset(restore_context: bool) {
        close_ceremony(RESET, restore_context);
    }

    fn close_events(restore_context: bool) {
        close_ceremony(EVENTS, restore_context);
    }

    fn naming_open() -> bool {
        with_visor(|v| v.drawer.is_open(NAMING)).unwrap_or(false)
    }

    fn settings_open() -> bool {
        with_visor(|v| v.drawer.is_open(SETTINGS)).unwrap_or(false)
    }

    fn reset_open() -> bool {
        with_visor(|v| v.drawer.is_open(RESET)).unwrap_or(false)
    }

    fn events_open() -> bool {
        with_visor(|v| v.drawer.is_open(EVENTS)).unwrap_or(false)
    }
}
