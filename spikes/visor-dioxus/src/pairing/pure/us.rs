//! THE USER-SYSTEM EVENT DRAIN, and the boot cache that reconciles against the
//! account (`visor/ui/pairing.ts:147-480`, PAIRING.md §5).
//!
//! # ANNOUNCED-NEVER-SILENT
//!
//! A change to the user's own identity — their colour, their name, a trust
//! record, a device gaining or losing access — that was caused by something
//! OTHER than the user's action in front of THIS visor is ALWAYS announced. It
//! is the #22 ruling the anchor colour already carries (`control.claim`'s
//! `fresh`): a thing that quietly changes on its own trains the user that it
//! changes on its own, which is exactly the training an impersonator wants.
//!
//! LOCAL-ECHO SUPPRESSION IS THE BACKEND'S JOB (wit/world.wit:610-612), so
//! every event drained here may be announced without the visor second-guessing
//! where it came from. That is not laziness: a visor that tried to recognise
//! its own writes would have to hold a model of what it had just written, and
//! the failure mode of that model being wrong is a REMOTE change announced as
//! nothing at all — silently the worst direction.
//!
//! # THE ONE HARD RULE ABOUT WHAT AN ANNOUNCEMENT MAY SAY
//!
//! Announcements are FRAMEWORK VOICE and take a flat string
//! (`component::announce_framework`, visor/README.md:138). A flat string has
//! no way to carry class marking, so there is no way to dress an
//! app-influenced token as app voice inside one — it would arrive in the
//! visor's own sentence wearing the visor's own authority.
//!
//! Concretely, and this is `visor/ui/pairing.ts:260-287`'s account of a bug it
//! actually had: THE PROVENANCE KEY NEVER RIDES AN ANNOUNCEMENT. A component
//! is named by THE USER'S WORD for it — the petname, which is user voice and
//! therefore admissible inline — or it is DESCRIBED WITHOUT NAMING. A mark
//! event can arrive from another device running another build, so that key is
//! attacker-influenceable input.
//!
//! `storage-changed`'s payload is the exception that proves it, and the WIT
//! says so at the variant (wit/world.wit:621-625): the provider is THE
//! ENGINE'S OWN WORD, framework vocabulary rather than anything an app
//! influenced. Even then it is rendered through the visor's own display word
//! and NOT echoed raw, with an unnamed fallback for a provider this build has
//! no word for (pairing.ts:322-341) — same discipline everywhere else in this
//! file: name a fact in the visor's vocabulary, or do not name it.

use crate::voice::NAME_MAX;

/// `us-event` (wit/world.wit:613-626), as a local value. Mapped at the driver
/// seam in [`super::export`] so everything below stays pure.
#[derive(Clone, PartialEq, Debug)]
pub enum UsEvent {
    ProfileChanged,
    MarkAdded(String),
    MarkChanged(String),
    /// Provenance, then which field the partition's conflict repair cleared.
    MarkConflictRepaired(String, String),
    DeviceAdded(String),
    DeviceRevoked(String),
    /// The engine's own word for the account's new storage provider.
    StorageChanged(String),
}

impl UsEvent {
    /// Does this event mention a trust record? `visor/ui/pairing.ts:366` asks
    /// the same question with `"provenance" in ev`, to decide whether the
    /// batch needs the account's marks fetched at all — the drain runs on a
    /// poll and most batches are empty, so the common path stays one round
    /// trip.
    pub fn provenance(&self) -> Option<&str> {
        match self {
            UsEvent::MarkAdded(p) | UsEvent::MarkChanged(p) => Some(p),
            UsEvent::MarkConflictRepaired(p, _) => Some(p),
            _ => None,
        }
    }
}

/// THE VISOR'S OWN DISPLAY WORDS for the storage providers it knows
/// (pairing.ts:336). A provider outside this table is not echoed — see
/// [`describe`]'s `storage-changed` arm.
const PROVIDERS: [(&str, &str); 2] = [("gdrive", "Google Drive"), ("s3", "S3")];

/// ONE EVENT, AS A SENTENCE. The port of `visor/ui/pairing.ts:288-343`.
///
/// `petname_of` resolves a provenance key to the user's word for that record,
/// or `None` when the account has none. The fallback is expected to be rare —
/// a petname-conflict repair keeps the loser's petname and an icon-conflict
/// repair clears only its icon, so a lookup succeeds in both repair cases —
/// but it must exist, because the visor never assumes the partition's shape.
///
/// EVERY SENTENCE THAT REPORTS A REPAIR SAYS WHAT THE USER HAS TO DO. A
/// conflict the partition resolved on its own is not information, it is a
/// pending decision: the visor's whole claim about naming is that the user
/// picked the name, so a name a repair picked has to come back to them.
pub fn describe(ev: &UsEvent, petname_of: impl Fn(&str) -> Option<String>) -> String {
    match ev {
        UsEvent::ProfileChanged => "profile updated on another device".into(),
        UsEvent::MarkAdded(p) => match petname_of(p) {
            Some(name) => format!("new trust record: {name}"),
            None => "a new trust record arrived from another device".into(),
        },
        UsEvent::MarkChanged(p) => match petname_of(p) {
            Some(name) => format!("trust record changed: {name}"),
            None => "a trust record changed on another device".into(),
        },
        UsEvent::MarkConflictRepaired(p, field) => {
            let named = petname_of(p);
            if field == "petname" {
                match named {
                    Some(name) => format!(
                        "NEW — two components were both named {name}; re-confirm which is which"
                    ),
                    None => {
                        "NEW — a naming conflict was found and repaired (re-confirm the name)"
                            .into()
                    }
                }
            } else {
                // An icon repair CLEARS the losing record's mark rather than
                // reassigning it — the glyph vocabulary is the visor's, not
                // the partition's — so the honest sentence is that the mark is
                // gone and the naming ceremony will offer a new one.
                match named {
                    Some(name) => format!(
                        "NEW — two components claimed the same mark; {name} lost its mark and needs a new one"
                    ),
                    None => "NEW — two components claimed the same mark; one lost its mark and needs a new one"
                        .into(),
                }
            }
        }
        // THE DEVICE NAME IS THE USER'S OWN WORD, typed by the admitting human
        // in the add ceremony's never-prefilled field — user voice, and
        // therefore admissible inline in a framework-voice sentence. It is
        // clamped for the same reason a petname is (below).
        UsEvent::DeviceAdded(name) => format!("device added: {}", device_word(name)),
        UsEvent::DeviceRevoked(name) => format!("device revoked: {}", device_word(name)),
        UsEvent::StorageChanged(provider) => {
            // ANNOUNCE, NEVER SILENTLY ADOPT. This device's own store is
            // untouched; the second clause says what the user has to do.
            match PROVIDERS.iter().find(|(key, _)| key == provider) {
                Some((_, word)) => format!(
                    "your account now syncs its storage through {word} — connect this device from the storage sheet"
                ),
                // DELIBERATELY NOT A RAW ECHO. Another build's provider string
                // has no word in this visor's vocabulary, and the fallback is
                // the unnamed sentence rather than the string.
                None => "your account now syncs its storage somewhere new — connect this device from the storage sheet"
                    .into(),
            }
        }
    }
}

/// NO FABRICATION, and the clamp. `visor/ui/pairing.ts:319` renders an empty
/// device name as the literal `(unnamed)`; that is kept, because it is a
/// description of an absence rather than a name the visor invented — the same
/// distinction `crate::state::Identity`'s "NO FABRICATION" note draws.
///
/// The clamp is `NAME_MAX`, the naming sheet's own cap: a record hand-edited
/// in devtools or written by another build must not be able to stretch the
/// strip's one line (pairing.ts:285-287 applies the same cap to petnames).
fn device_word(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "(unnamed)".into();
    }
    trimmed.chars().take(NAME_MAX).collect()
}

/// Clamp a petname arriving from the partition, before it is offered to
/// [`describe`]. Empty becomes `None`, so the sentence takes its unnamed form
/// rather than saying "trust record changed: ".
pub fn clamp_petname(petname: &str) -> Option<String> {
    let trimmed = petname.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(NAME_MAX).collect())
}

// --- the boot cache ----------------------------------------------------------

/// WHAT THE LAST BOOT SAW. `localStorage` is a BOOT CACHE now and not the
/// source of truth — the us-* partition is (PAIRING.md §5) — so this exists
/// only to notice that the account disagrees with it and to say so.
///
/// Persisted in `store.slot::account`, which the contract gained for exactly
/// this (wit/world.wit:50-59). NOT a corner of `marks`: that is the LOCAL trust
/// table keyed by provenance, and this is account state replicated between the
/// user's devices.
///
/// CONTRACT / SCOPE. The slot's doc names "the last-known profile, device list
/// and account marks". Only the two fields the visor RECONCILES AND ANNOUNCES
/// ON are stored — the hue and the display name. Caching the device list or the
/// account marks would be storage with no reader: nothing announces a diff on
/// either (`reconcileFromDriver` refreshed them for a consumer's `onMarks`
/// callback, pairing.ts:473-479, and this world has no such door), and a cache
/// nobody compares against is a second copy that can only go stale. Reported;
/// the shape is additive if a reader ever appears.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct BootCache {
    /// A PALETTE INDEX, not an angle (`us-profile.hue` is `u16` 0-9, and the
    /// angle is purely a visor rendering choice — pairing.ts:48-64).
    pub hue: Option<u16>,
    pub display_name: Option<String>,
}

impl BootCache {
    /// TOLERANT PARSE, the contract every stored record in this crate follows
    /// (`Identity::parse`, `EventStore::parse`): a corrupt cache loses the
    /// ability to notice one change; it must never lose the visor.
    ///
    /// A MISSING FIELD IS `None`, WHICH MEANS "NO OPINION" — and that is
    /// load-bearing rather than incidental. [`reconcile`] announces nothing
    /// against a `None`, so a cache that failed to parse degrades to a first
    /// boot: silent, not wrong. The alternative — defaulting to 0 and "" —
    /// would announce a colour change and a rename on every corrupt read.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw else { return Self::default() };
        Self {
            hue: crate::state::json_number(raw, "hue")
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as u16),
            display_name: crate::state::json_string(raw, "name"),
        }
    }

    /// AN UNSET FIELD IS OMITTED, never written as a placeholder, so it
    /// round-trips as "no opinion" — `Identity::to_json`'s rule and for the
    /// same reason.
    pub fn to_json(&self) -> String {
        let mut fields: Vec<String> = Vec::new();
        if let Some(h) = self.hue {
            fields.push(format!("\"hue\":{h}"));
        }
        if let Some(n) = &self.display_name {
            fields.push(format!("\"name\":{}", crate::state::json_escape(n)));
        }
        format!("{{{}}}", fields.join(","))
    }
}

/// RECONCILE, AND ANNOUNCE THE DIFFERENCE. The port of
/// `visor/ui/pairing.ts:453-480`'s announcing half.
///
/// THE OTHER HALF OF ANNOUNCED-NEVER-SILENT. The `us-event` drain covers
/// changes made while this device was running; this covers the ones made while
/// it was NOT, which produce no event to drain and would otherwise be adopted
/// in complete silence on the next boot. A silently-changed hue or name is
/// exactly the "anchor that quietly changes" failure the visor's own `fresh`
/// mechanism exists to prevent, so both lines are consequential.
///
/// Returns the lines to say, oldest first, and the cache to write back.
///
/// NOTHING IS ANNOUNCED WHEN THE CACHE HAS NO OPINION. A first boot, or a boot
/// after the cache was cleared or failed to parse, has nothing to have changed
/// FROM — and announcing "your colour is X" to a user who has never seen
/// another one is a sentence about nothing. pairing.ts guards on `!== undefined`
/// for the same reason (:464, :467).
pub fn reconcile(cache: &BootCache, hue: u16, display_name: &str) -> (Vec<String>, BootCache) {
    let mut lines = Vec::new();
    if cache.hue.is_some_and(|cached| cached != hue) {
        lines.push("your colour changed to match your account (was device-local)".to_string());
    }
    if cache.display_name.as_deref().is_some_and(|cached| cached != display_name) {
        // THE ACCOUNT'S OWN DISPLAY NAME, quoted inline. It is USER VOICE —
        // the user typed it, on one of their own devices — which is the class
        // that may appear inside a framework-voice sentence. Clamped for the
        // same reason every other cross-device string here is.
        let shown = clamp_petname(display_name).unwrap_or_else(|| "(unnamed)".into());
        lines.push(format!("your name is now \"{shown}\" (synced from your account)"));
    }
    (lines, BootCache { hue: Some(hue), display_name: Some(display_name.to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Obviously-synthetic provenance keys throughout: these stand for
    /// component identities and nothing about their content matters except
    /// that the visor must never say them out loud.
    const KEY: &str = "provenance-0001";

    fn unnamed(_: &str) -> Option<String> {
        None
    }

    /// THE BUG pairing.ts:260-287 records, as a test: a provenance key is
    /// app-influenceable input and an announcement has no way to dress it, so
    /// it must not appear in one — named or unnamed form.
    #[test]
    fn a_provenance_key_never_reaches_an_announcement() {
        let events = [
            UsEvent::MarkAdded(KEY.into()),
            UsEvent::MarkChanged(KEY.into()),
            UsEvent::MarkConflictRepaired(KEY.into(), "petname".into()),
            UsEvent::MarkConflictRepaired(KEY.into(), "icon".into()),
        ];
        for ev in &events {
            let named = describe(ev, |_| Some("the label maker".into()));
            let anon = describe(ev, unnamed);
            assert!(!named.contains(KEY), "named form leaked the key: {named}");
            assert!(!anon.contains(KEY), "unnamed form leaked the key: {anon}");
        }
    }

    /// The user's own word for a component IS admissible inline — that is the
    /// whole point of resolving the key to a petname rather than dropping the
    /// identification.
    #[test]
    fn a_petname_is_spoken_and_an_absent_one_degrades_to_a_description() {
        let ev = UsEvent::MarkAdded(KEY.into());
        assert_eq!(
            describe(&ev, |_| Some("the label maker".into())),
            "new trust record: the label maker"
        );
        assert_eq!(describe(&ev, unnamed), "a new trust record arrived from another device");
    }

    /// Both repair wordings have to say what the user must DO: a conflict the
    /// partition resolved by itself is a pending decision, not news.
    #[test]
    fn every_repair_sentence_asks_the_user_to_act() {
        for field in ["petname", "icon"] {
            for resolve in [
                &(|_: &str| Some("the label maker".to_string())) as &dyn Fn(&str) -> Option<String>,
                &unnamed,
            ] {
                let s = describe(&UsEvent::MarkConflictRepaired(KEY.into(), field.into()), resolve);
                assert!(s.starts_with("NEW — "), "{s}");
                assert!(
                    s.contains("re-confirm") || s.contains("needs a new one"),
                    "no call to action: {s}"
                );
            }
        }
    }

    /// An unknown provider is DESCRIBED, never echoed: another build's word is
    /// not this visor's vocabulary.
    #[test]
    fn an_unknown_storage_provider_is_described_rather_than_echoed() {
        let known = describe(&UsEvent::StorageChanged("gdrive".into()), unnamed);
        assert!(known.contains("Google Drive"), "{known}");
        let unknown = describe(&UsEvent::StorageChanged("wildcat".into()), unnamed);
        assert!(!unknown.contains("wildcat"), "echoed a foreign provider word: {unknown}");
        assert!(unknown.contains("storage sheet"), "still says what to do: {unknown}");
    }

    /// Announce, never silently adopt: every storage sentence tells the user
    /// this device was NOT reconfigured.
    #[test]
    fn a_storage_change_tells_the_user_this_device_is_untouched() {
        for provider in ["gdrive", "s3", "wildcat"] {
            let s = describe(&UsEvent::StorageChanged(provider.into()), unnamed);
            assert!(s.contains("connect this device"), "{s}");
        }
    }

    #[test]
    fn an_empty_device_name_is_described_and_never_invented() {
        assert_eq!(describe(&UsEvent::DeviceAdded(String::new()), unnamed), "device added: (unnamed)");
        assert_eq!(
            describe(&UsEvent::DeviceRevoked("   ".into()), unnamed),
            "device revoked: (unnamed)"
        );
    }

    /// A record written by another build must not be able to stretch the
    /// strip's one line.
    #[test]
    fn cross_device_names_are_clamped() {
        let long = "x".repeat(NAME_MAX * 3);
        let s = describe(&UsEvent::DeviceAdded(long), unnamed);
        assert_eq!(s.chars().count(), "device added: ".chars().count() + NAME_MAX);
        assert_eq!(clamp_petname(&"y".repeat(NAME_MAX * 3)).unwrap().chars().count(), NAME_MAX);
        assert_eq!(clamp_petname("   "), None);
    }

    // --- the boot cache -----------------------------------------------------

    #[test]
    fn a_first_boot_announces_nothing_because_nothing_changed() {
        let (lines, next) = reconcile(&BootCache::default(), 3, "Ada");
        assert!(lines.is_empty(), "{lines:?}");
        assert_eq!(next, BootCache { hue: Some(3), display_name: Some("Ada".into()) });
    }

    #[test]
    fn an_anchor_colour_that_changed_elsewhere_is_never_adopted_quietly() {
        let cache = BootCache { hue: Some(1), display_name: Some("Ada".into()) };
        let (lines, _) = reconcile(&cache, 7, "Ada");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("colour changed"), "{}", lines[0]);
    }

    #[test]
    fn a_name_that_changed_elsewhere_is_announced_and_the_cache_catches_up() {
        let cache = BootCache { hue: Some(1), display_name: Some("Ada".into()) };
        let (lines, next) = reconcile(&cache, 1, "Grace");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"Grace\""), "{}", lines[0]);
        assert_eq!(next.display_name.as_deref(), Some("Grace"));
        // And a second reconcile against the same account says nothing.
        assert!(reconcile(&next, 1, "Grace").0.is_empty());
    }

    #[test]
    fn both_halves_can_change_at_once() {
        let cache = BootCache { hue: Some(1), display_name: Some("Ada".into()) };
        assert_eq!(reconcile(&cache, 7, "Grace").0.len(), 2);
    }

    // --- the slot's stored shape --------------------------------------------

    #[test]
    fn the_cache_round_trips_through_its_slot() {
        let c = BootCache { hue: Some(7), display_name: Some("Grace".into()) };
        assert_eq!(BootCache::parse(Some(&c.to_json())), c);
    }

    /// An unset field is OMITTED and comes back as "no opinion", so a cache
    /// written before a name existed does not later announce a rename from "".
    #[test]
    fn an_unset_field_round_trips_as_no_opinion() {
        let c = BootCache { hue: Some(3), display_name: None };
        let json = c.to_json();
        assert!(!json.contains("name"), "{json}");
        assert_eq!(BootCache::parse(Some(&json)), c);
        assert!(reconcile(&BootCache::parse(Some(&json)), 3, "Ada").0.is_empty());
    }

    /// A NAME WITH JSON IN IT round-trips rather than corrupting the slot — the
    /// display name comes from another device and is not this visor's to trust
    /// the shape of.
    #[test]
    fn a_hostile_display_name_round_trips_intact() {
        let nasty = "a\",\"hue\":9,\"x\":\"";
        let c = BootCache { hue: Some(1), display_name: Some(nasty.into()) };
        let back = BootCache::parse(Some(&c.to_json()));
        assert_eq!(back.hue, Some(1), "an embedded key did not overwrite the hue");
        assert_eq!(back.display_name.as_deref(), Some(nasty));
    }

    /// A CORRUPT CACHE DEGRADES TO A FIRST BOOT — silent, not wrong.
    #[test]
    fn a_corrupt_cache_announces_nothing_rather_than_everything() {
        for raw in [None, Some(""), Some("{"), Some("not json at all")] {
            let c = BootCache::parse(raw);
            assert_eq!(c, BootCache::default(), "{raw:?}");
            assert!(reconcile(&c, 5, "Ada").0.is_empty(), "{raw:?}");
        }
    }
}
