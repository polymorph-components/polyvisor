//! THE TRUST TABLE: the pet icon, the first-sight timestamp and the user's own
//! word for one component (`createSurfaceMarks`, sheets.ts:118-373).
//!
//! # Why the mark is a USER CHOICE and not a derivation
//!
//! Two derivations died before this one, both to the same attack, and
//! sheets.ts:74-85 is the record: making THE VISOR'S OWN STRIP vouch the wrong
//! mark. Deriving from component bytes let an impersonator grind its artifact
//! until the strip assigned it the target's mark; deriving from
//! `HMAC(user-secret, name)` fixed the grind and reopened it through the other
//! input, because names are self-declared. Anything copyable is trivially
//! fakeable INSIDE an attacker's rectangle, and the strip is the only place a
//! mark means anything — so what renders there must not be a function of
//! anything an attacker chooses. User choice is the strongest version of that:
//! the mark is a function of a gesture made in visor pixels.
//!
//! Assignment also buys what no derivation can: LOCAL UNIQUENESS. Icons are
//! offered from the unused set, so two records on this device never share a
//! mark while the vocabulary lasts.
//!
//! # THE THREE NAMES, STRICTLY SEPARATED (sheets.ts:105-116)
//!
//!   KEY      — the artifact name the visor fetched itself. Unforgeable
//!              provenance; the ONLY thing that may address a record. A name
//!              that could look up someone else's record is the same attack
//!              through the table.
//!   NICKNAME — what the component calls itself. Self-declared, so it is
//!              [`crate::voice::AppVoice`] and never a key. It is not in this
//!              module at all: the table does not store it.
//!   PETNAME  — what the USER calls it, typed in the visor's pixels. The visor
//!              speaks this one in its own voice, so it is [`UserVoice`].
//!
//! # Statelessness
//!
//! `wit/world.wit:254-257`: every function on the `marks` interface reads and
//! writes the slot afresh and holds nothing between calls. That is what made
//! two facades over one key the same TABLE rather than two caches that can
//! disagree, and it is why this module is a set of free functions over a
//! parsed-and-reserialised [`MarkTable`] rather than a cached struct. The
//! export in `sheets/mod.rs` is the only caller and it loads, mutates and
//! saves inside one call every time.
//!
//! Pure, like [`crate::state`] and [`crate::drawer`]: the slot's bytes come in
//! as a `&str` and go out as a `String`, so `cargo test` exercises the rules on
//! the host with no `store` underneath them.

use crate::voice::{MarkIcon, UserVoice, NAME_MAX};

/// How many marks the naming ceremony offers (sheets.ts:223-226). Six: enough
/// that the choice feels like a choice and a nomination cannot be the only
/// thing on screen, few enough to scan in one glance on a phone.
pub const ICON_OFFERS: usize = 6;

/// ONE RECORD (`SurfaceMark`, sheets.ts:118-138).
#[derive(Clone, PartialEq, Debug)]
pub struct PetMark {
    /// `None` IS A REAL, HONEST STATE — sheets.ts:119-127's "unmarked", not a
    /// missing value. A record can have a first-sight timestamp and even a
    /// petname with no icon. Three things look like this and all three render
    /// the same way (no glyph): a component the user has not marked yet, a
    /// record MIGRATED from the old `hue` schema, and a record whose icon the
    /// account's conflict repair cleared.
    ///
    /// `Option<MarkIcon>` rather than a `String` is what makes the migration
    /// safe by construction: a `hue` was a palette INDEX, and there is no
    /// `MarkIcon` a number can become, so it cannot be reinterpreted as a
    /// glyph even by accident.
    pub icon: Option<MarkIcon>,
    pub first_seen: u64,
    /// USER VOICE, or none. Records written before petnames existed stay valid
    /// and simply have none, so there is no migration (sheets.ts:130-137).
    pub petname: Option<UserVoice>,
}

/// The whole table.
///
/// INSERTION-ORDERED, a `Vec` of pairs and not a map, for [`Conditions`]'
/// reason (state.rs:315-319): the order records were first seen is the order
/// `list-all` reports them in, a `BTreeMap` would sort by provenance key and a
/// `HashMap` would not order at all, and a device holds a handful of records
/// rather than a lookup problem.
///
/// [`Conditions`]: crate::state::Conditions
#[derive(Clone, Default, PartialEq, Debug)]
pub struct MarkTable(Vec<(String, PetMark)>);

impl MarkTable {
    /// Read the slot, NORMALISING every record on the way out
    /// (sheets.ts:231-271).
    ///
    /// THE READ-SIDE GATE. Storage is hand-editable, so an icon that is not a
    /// member of the curated vocabulary is read as UNMARKED rather than
    /// rendered — see [`MarkIcon::app_mark`] for what that refuses and why.
    ///
    /// NORMALISATION IS NOT WRITTEN BACK — a read is a read — so it is
    /// idempotent and cannot corrupt a record it merely displayed. That falls
    /// out of the shape here: nothing calls `save` unless it also mutated.
    ///
    /// TOLERANT, exactly as [`crate::state::EventStore::parse`] is: absent,
    /// unparseable and hand-mangled all answer the same way, because a visor
    /// that failed to boot over a devtools typo would be bricked by one.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw else { return Self::default() };
        let mut out = Vec::new();
        for (key, obj) in json_entries(raw) {
            if key.is_empty() {
                continue;
            }
            // A record with no readable timestamp keeps its OTHER fields and
            // gets a zero first-sight rather than being dropped: the petname is
            // the user's and outranks a number nobody typed. sheets.ts
            // substitutes `Date.now()` here; a clock read inside a pure parse
            // would make the same record parse differently on every call, so
            // the sentinel is 0 and the render site words it (see
            // `sheets::naming`, which omits the "first seen" line for 0).
            let first_seen = json_number(&obj, "firstSeen").filter(|n| n.is_finite());
            out.push((
                key,
                PetMark {
                    icon: json_string(&obj, "icon").and_then(|s| MarkIcon::app_mark(&s)),
                    first_seen: first_seen.map_or(0, |n| n.max(0.0) as u64),
                    petname: json_string(&obj, "petname")
                        .and_then(|p| UserVoice::new(&p, NAME_MAX)),
                },
            ));
        }
        Self(out)
    }

    /// The stored shape. An unmarked record stores `""` — the same real state
    /// it was read from — rather than omitting the field, so a table this crate
    /// wrote round-trips through `sheets.ts`'s reader unchanged.
    pub fn to_json(&self) -> String {
        let entries: Vec<String> = self
            .0
            .iter()
            .map(|(key, m)| {
                let mut fields = vec![
                    format!("\"icon\":{}", json_escape(m.icon.map_or("", |i| i.as_str()))),
                    format!("\"firstSeen\":{}", m.first_seen),
                ];
                if let Some(p) = &m.petname {
                    fields.push(format!("\"petname\":{}", json_escape(p.as_str())));
                }
                format!("{}:{{{}}}", json_escape(key), fields.join(","))
            })
            .collect();
        format!("{{{}}}", entries.join(","))
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &PetMark)> {
        self.0.iter().map(|(k, m)| (k.as_str(), m))
    }

    pub fn get(&self, provenance: &str) -> Option<&PetMark> {
        self.0.iter().find(|(k, _)| k == provenance).map(|(_, m)| m)
    }

    /// The record for this provenance, CREATING one if there is none — and the
    /// bool is the first-sight moment: true exactly on the call that created it
    /// (sheets.ts:294-304).
    ///
    /// NO ICON IS ROLLED HERE, deliberately. A fresh record is UNMARKED: a mark
    /// the user did not choose is a mark they cannot recognise, and inventing
    /// one would put a glyph on the anchor in the visor's own voice about a
    /// component the user has never said a word about. The ceremony is where
    /// marks come from.
    pub fn mark(&mut self, provenance: &str, now: u64) -> (PetMark, bool) {
        if let Some(existing) = self.get(provenance) {
            return (existing.clone(), false);
        }
        let mark = PetMark { icon: None, first_seen: now, petname: None };
        self.0.push((provenance.to_string(), mark.clone()));
        (mark, true)
    }

    /// Commit a petname and a pet icon (sheets.ts:305-315).
    ///
    /// THE WRITE-SIDE GATE, mirroring `parse`'s read-side one: a glyph outside
    /// the curated vocabulary is stored as UNMARKED rather than persisted and
    /// rendered later. `Option<MarkIcon>` makes that unwritable here — the
    /// caller had to pass the firewall to get one — so the gate lives at the
    /// export, which is the site that sees the raw string.
    pub fn set_petname(
        &mut self,
        provenance: &str,
        petname: Option<UserVoice>,
        icon: Option<MarkIcon>,
        now: u64,
    ) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == provenance) {
            slot.1.icon = icon;
            slot.1.petname = petname;
            return;
        }
        self.0.push((provenance.to_string(), PetMark { icon, first_seen: now, petname }));
    }

    /// Delete the WHOLE record (sheets.ts:316-320). Forgetting must be honest:
    /// a component whose petname was dropped but whose mark survived would
    /// still be greeted as familiar, so the next mount is genuinely NEW again.
    pub fn forget(&mut self, provenance: &str) {
        self.0.retain(|(k, _)| k != provenance);
    }

    /// The pet icons no OTHER record is using (sheets.ts:273-284). THIS
    /// record's own is included: re-picking what you already wear is not a
    /// collision.
    pub fn free_icons(&self, provenance: &str) -> Vec<MarkIcon> {
        let used: Vec<MarkIcon> = self
            .0
            .iter()
            .filter(|(k, _)| k != provenance)
            .filter_map(|(_, m)| m.icon)
            .collect();
        MarkIcon::app_marks().filter(|g| !used.contains(g)).collect()
    }

    /// THE CEREMONY'S SIX OFFERS, in render order (sheets.ts:327-362).
    ///
    /// `nomination` is the glyph the component asked to wear. It is offered
    /// FIRST, and flagged so the sheet can attribute it to the component rather
    /// than to the visor — but ONLY IF IT IS GENUINELY FREE. A nomination for a
    /// glyph another record already wears is DROPPED SILENTLY, exactly like an
    /// invalid one, and the component learns nothing either way: telling the
    /// user "the app wanted a glyph somebody else has" would be the visor
    /// relaying a component's request in the visor's own voice, for no decision
    /// the user has to make.
    ///
    /// When this record already HAS a mark, that glyph is always among the
    /// offers, so opening the ceremony to fix a typo in a petname cannot
    /// silently cost a component its mark.
    ///
    /// THE REST ARE DRAWN AT RANDOM from the free set, freshly per ceremony,
    /// and the randomness is deliberate and ECOSYSTEM-SCALE (sheets.ts:203-209,
    /// wit/world.wit:296-301): a stable global ordering would mean every user
    /// on every device sees the same first few glyphs, so an app's nomination
    /// would win by default-bias alone and a de-facto brand would form out of
    /// nothing but list order. Marks are the USER's vocabulary, not a namespace
    /// to be squatted.
    ///
    /// Fisher-Yates over a COPY of the free set, through [`crate::rng`] — the
    /// crate's one entropy source, whose threat model (`rng.rs`'s header) is
    /// parity with the `Math.random` this replaces.
    pub fn icon_offers(
        &self,
        provenance: &str,
        nomination: Option<MarkIcon>,
    ) -> Vec<(MarkIcon, bool)> {
        let free = self.free_icons(provenance);
        let mine = self.get(provenance).and_then(|m| m.icon);
        let mut offers: Vec<(MarkIcon, bool)> = Vec::new();
        let push = |glyph: MarkIcon, nominated: bool, offers: &mut Vec<(MarkIcon, bool)>| {
            if offers.iter().any(|(g, _)| *g == glyph) {
                return;
            }
            offers.push((glyph, nominated));
        };
        // FIRST, and only if it survives BOTH tests: valid (the firewall at the
        // export gave us a `MarkIcon` at all) and unclaimed.
        if let Some(n) = nomination.filter(|n| free.contains(n)) {
            push(n, true, &mut offers);
        }
        // The mark this record already wears, so a rename cannot lose it.
        if let Some(mine) = mine {
            push(mine, false, &mut offers);
        }
        let mut pool: Vec<MarkIcon> =
            free.into_iter().filter(|g| !offers.iter().any(|(o, _)| o == g)).collect();
        for i in (1..pool.len()).rev() {
            pool.swap(i, crate::rng::below(i + 1));
        }
        for g in pool {
            if offers.len() >= ICON_OFFERS {
                break;
            }
            push(g, false, &mut offers);
        }
        offers.truncate(ICON_OFFERS);
        offers
    }

    /// Is this word already the user's name for a DIFFERENT component
    /// (sheets.ts:363-371)? Two records answering to one word would defeat the
    /// whole point of a petname — the user would have no way to tell which one
    /// is speaking.
    ///
    /// COMPARED TRIMMED AND CASE-INSENSITIVELY, and it returns the colliding
    /// record — its petname as the user wrote it, and its unforgeable
    /// provenance key — so the visor can say, in its own words, what the clash
    /// is.
    pub fn collision(&self, provenance: &str, petname: &str) -> Option<(String, String)> {
        let want = petname.trim().to_lowercase();
        if want.is_empty() {
            return None;
        }
        self.0
            .iter()
            .filter(|(k, _)| k != provenance)
            .find_map(|(k, m)| {
                let other = m.petname.as_ref()?.as_str();
                (other.to_lowercase() == want).then(|| (k.clone(), other.to_string()))
            })
    }
}

// --- a reader for one shape state.rs's does not cover -------------------------
//
// `state.rs`'s helpers read a FIXED key out of a known object. This table is a
// map whose keys are provenance strings nobody enumerated, so it needs an
// entry-walker instead; the scalar readers below are the same tolerant shape
// and are kept local rather than made `pub(crate)` there, because widening a
// deliberately-small parser's surface is how it stops being small.

/// The top-level `"key": {…}` pairs, as their own object sources. Depth- and
/// string-aware: a petname may legitimately contain a brace or a quote.
fn json_entries(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    // Enter the outer object.
    while i < bytes.len() && bytes[i] != '{' {
        if !bytes[i].is_whitespace() {
            return out;
        }
        i += 1;
    }
    if i == bytes.len() {
        return out;
    }
    i += 1;
    loop {
        while i < bytes.len() && (bytes[i].is_whitespace() || bytes[i] == ',') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == '}' {
            return out;
        }
        if bytes[i] != '"' {
            return out;
        }
        let Some((key, next)) = read_string(&bytes, i) else { return out };
        i = next;
        while i < bytes.len() && bytes[i].is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != ':' {
            return out;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return out;
        }
        if bytes[i] != '{' {
            // A non-object value where a record belongs: skip the whole entry
            // rather than the whole table (sheets.ts's `continue`).
            let Some(next) = skip_value(&bytes, i) else { return out };
            i = next;
            continue;
        }
        let start = i;
        let Some(next) = skip_value(&bytes, i) else { return out };
        out.push((key, bytes[start..next].iter().collect()));
        i = next;
    }
}

/// The string literal starting at `at` (which must be the opening quote), with
/// JSON escapes resolved, and the index just past its closing quote.
fn read_string(b: &[char], at: usize) -> Option<(String, usize)> {
    let mut i = at + 1;
    let mut out = String::new();
    while i < b.len() {
        match b[i] {
            '"' => return Some((out, i + 1)),
            '\\' => {
                i += 1;
                let esc = *b.get(i)?;
                out.push(match esc {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    'u' => {
                        let hex: String = b.get(i + 1..i + 5)?.iter().collect();
                        i += 4;
                        char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?
                    }
                    other => other,
                });
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    None
}

/// The index just past the JSON value starting at `at`.
fn skip_value(b: &[char], at: usize) -> Option<usize> {
    match b[at] {
        '"' => read_string(b, at).map(|(_, i)| i),
        '{' | '[' => {
            let mut depth = 0usize;
            let mut i = at;
            while i < b.len() {
                match b[i] {
                    '"' => i = read_string(b, i)?.1,
                    '{' | '[' => {
                        depth += 1;
                        i += 1;
                    }
                    '}' | ']' => {
                        depth -= 1;
                        i += 1;
                        if depth == 0 {
                            return Some(i);
                        }
                    }
                    _ => i += 1,
                }
            }
            None
        }
        _ => {
            let mut i = at;
            while i < b.len() && !matches!(b[i], ',' | '}' | ']') {
                i += 1;
            }
            Some(i)
        }
    }
}

/// The string value of `"key"` inside one record's source.
fn json_string(obj: &str, key: &str) -> Option<String> {
    let b: Vec<char> = obj.chars().collect();
    let at = find_key(&b, key)?;
    (b.get(at) == Some(&'"')).then(|| read_string(&b, at))?.map(|(s, _)| s)
}

/// The numeric value of `"key"` inside one record's source.
fn json_number(obj: &str, key: &str) -> Option<f64> {
    let b: Vec<char> = obj.chars().collect();
    let at = find_key(&b, key)?;
    let end = skip_value(&b, at)?;
    b[at..end].iter().collect::<String>().trim().parse::<f64>().ok()
}

/// The index of the value of `"key"` at DEPTH 1 of `b` — a record's own field,
/// never one nested inside a petname-shaped decoy. `state.rs`'s reader answers
/// this with a substring search and documents the looseness as acceptable
/// because it only reads keys the crate itself wrote; here the surrounding
/// values include a free-text petname, so the walk is depth-aware.
fn find_key(b: &[char], key: &str) -> Option<usize> {
    let mut i = 0usize;
    while i < b.len() && b[i] != '{' {
        i += 1;
    }
    i += 1;
    loop {
        while i < b.len() && (b[i].is_whitespace() || b[i] == ',') {
            i += 1;
        }
        if i >= b.len() || b[i] != '"' {
            return None;
        }
        let (found, next) = read_string(b, i)?;
        i = next;
        while i < b.len() && b[i].is_whitespace() {
            i += 1;
        }
        if b.get(i) != Some(&':') {
            return None;
        }
        i += 1;
        while i < b.len() && b[i].is_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        if found == key {
            return Some(i);
        }
        i = skip_value(b, i)?;
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A calendar date from a millisecond epoch stamp, as `YYYY-MM-DD`.
///
/// CONTRACT: sheets.ts:780 renders this with `toLocaleDateString()`. A
/// component has no locale and no date formatter — neither is on the world, and
/// asking for one would be a WIT change this spike may not make — so the format
/// is the unambiguous international one rather than a guessed locale's. It
/// loses the user's own date conventions and keeps the property the line exists
/// for: which day the visor first saw this component.
///
/// Days-to-civil is Howard Hinnant's `civil_from_days`, which is exact over the
/// whole proleptic Gregorian range and needs no table.
pub fn iso_date(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod date_tests {
    use super::iso_date;

    /// The one piece of arithmetic in this file, checked at the boundaries the
    /// civil-from-days algorithm is easy to get wrong at: an epoch date, a leap
    /// day, and a century that is not a leap year.
    #[test]
    fn the_first_sight_date_is_the_right_day() {
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(86_399_999), "1970-01-01", "the last millisecond of the day");
        assert_eq!(iso_date(86_400_000), "1970-01-02");
        assert_eq!(iso_date(951_782_400_000), "2000-02-29", "a leap day in a leap century");
        assert_eq!(iso_date(1_709_164_800_000), "2024-02-29");
        assert_eq!(iso_date(4_107_542_400_000), "2100-03-01", "1900-style non-leap century");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(raw: &str) -> MarkTable {
        MarkTable::parse(Some(raw))
    }

    fn pet(t: &MarkTable, k: &str) -> String {
        t.get(k).unwrap().petname.as_ref().map_or(String::new(), |p| p.as_str().to_string())
    }

    /// sheets.ts:294-304 and wit/world.wit:278-282: first sight creates the
    /// record and the timestamp; the MARK is the user's to choose.
    #[test]
    fn a_fresh_record_is_deliberately_unmarked() {
        let mut t = MarkTable::default();
        let (mark, is_new) = t.mark("pkg:a", 1_000);
        assert!(is_new, "the first-sight moment");
        assert!(mark.icon.is_none(), "the visor does not roll a mark on the user's behalf");
        assert_eq!(mark.first_seen, 1_000);
        assert!(mark.petname.is_none());

        // Idempotent, and the timestamp is the FIRST one: a second boot must
        // not move the date the record answers "have I seen this before?" with.
        let (again, is_new) = t.mark("pkg:a", 9_999);
        assert!(!is_new);
        assert_eq!(again.first_seen, 1_000);
    }

    /// sheets.ts:119-127 and :231-248 — the migration is deliberately LOSSY,
    /// and the loss is the honest half: a `hue` was a palette INDEX and there
    /// is no honest way to turn a number into a glyph the user would recognise,
    /// so the record becomes unmarked. The petname and the first-sight date —
    /// the parts that ARE the user's — survive untouched.
    #[test]
    fn a_hue_schema_record_migrates_to_unmarked_and_keeps_what_is_the_users() {
        let t = table(r#"{"pkg:a":{"hue":210,"firstSeen":42,"petname":"mail"}}"#);
        let rec = t.get("pkg:a").unwrap();
        assert!(rec.icon.is_none(), "a hue is never reinterpreted as a glyph");
        assert_eq!(rec.first_seen, 42);
        assert_eq!(pet(&t, "pkg:a"), "mail");
    }

    /// The read-side gate. Hand-editable storage, so the interesting inputs are
    /// not typos — voice.rs's firewall test argues the set, this checks the
    /// table honours it rather than storing the raw string.
    #[test]
    fn the_read_side_gate_refuses_a_glyph_outside_the_vocabulary() {
        for forged in ["\u{202E}\u{2709}", "\u{2709}\u{FE0F}", "Verified", "", "\u{26E8}"] {
            let raw = format!(r#"{{"pkg:a":{{"icon":{},"firstSeen":1}}}}"#, json_escape(forged));
            assert!(table(&raw).get("pkg:a").unwrap().icon.is_none(), "{forged:?}");
        }
        assert_eq!(
            table(r#"{"pkg:a":{"icon":"\u2709","firstSeen":1}}"#)
                .get("pkg:a")
                .unwrap()
                .icon
                .map(|i| i.as_str()),
            Some("\u{2709}"),
        );
    }

    /// state.rs's tolerance contract, on this shape: a corrupt table loses
    /// records, never the visor, and a half-written entry is dropped
    /// INDIVIDUALLY rather than wholesale (sheets.ts:254-255's `continue`).
    #[test]
    fn a_mangled_table_reads_as_empty_rather_than_failing() {
        for raw in ["", "not json", "{", "[]", "null", r#"{"pkg:a"}"#] {
            assert_eq!(table(raw).iter().count(), 0, "{raw:?}");
        }
        let t = table(r#"{"pkg:a":"nope","pkg:b":{"icon":"\u2709","firstSeen":7},"":{}}"#);
        assert_eq!(t.iter().count(), 1, "the scalar entry and the empty key both dropped");
        assert_eq!(t.get("pkg:b").unwrap().first_seen, 7);
    }

    /// A petname may contain the punctuation the reader walks over; the entry
    /// walker is depth- and string-aware precisely so that it does not become a
    /// way to smuggle a field into a neighbouring record.
    #[test]
    fn a_petname_full_of_json_punctuation_round_trips_and_smuggles_nothing() {
        let mut t = MarkTable::default();
        t.set_petname(
            "pkg:a",
            UserVoice::new(r#"{"icon":"x"} , "}"#, NAME_MAX),
            MarkIcon::app_mark("\u{2709}"),
            5,
        );
        t.set_petname("pkg:b", UserVoice::new("plain", NAME_MAX), None, 6);
        let back = MarkTable::parse(Some(&t.to_json()));
        assert_eq!(back, t);
        assert_eq!(back.get("pkg:a").unwrap().icon.map(|i| i.as_str()), Some("\u{2709}"));
        assert!(back.get("pkg:b").unwrap().icon.is_none(), "the decoy did not leak sideways");
    }

    /// sheets.ts:316-320: the WHOLE record, or a mark would still greet the
    /// component as familiar.
    #[test]
    fn forgetting_takes_the_mark_and_the_date_with_the_name() {
        let mut t = MarkTable::default();
        t.mark("pkg:a", 1);
        t.set_petname("pkg:a", UserVoice::new("mail", NAME_MAX), MarkIcon::app_mark("\u{2709}"), 1);
        t.forget("pkg:a");
        assert!(t.get("pkg:a").is_none());
        // And the next sight is honestly new again.
        assert!(t.mark("pkg:a", 2).1);
    }

    /// sheets.ts:182-186: this record's own icon is included — re-picking what
    /// you already wear is not a collision — and every other record's is gone.
    #[test]
    fn free_icons_subtract_only_other_records() {
        let mut t = MarkTable::default();
        let mine = MarkIcon::app_mark("\u{2709}").unwrap();
        let theirs = MarkIcon::app_mark("\u{2708}").unwrap();
        t.set_petname("pkg:a", None, Some(mine), 1);
        t.set_petname("pkg:b", None, Some(theirs), 1);
        let free = t.free_icons("pkg:a");
        assert!(free.contains(&mine), "my own mark stays offerable");
        assert!(!free.contains(&theirs), "local uniqueness");
        assert_eq!(free.len(), MarkIcon::app_marks().count() - 1);
    }

    /// wit/world.wit:266-271 and sheets.ts:337-345: the nomination is offered
    /// FIRST and ONLY IF FREE; a claimed one is dropped in silence, exactly
    /// like an invalid one, and the component learns nothing either way.
    #[test]
    fn a_nomination_is_offered_first_and_only_if_free() {
        let want = MarkIcon::app_mark("\u{2709}").unwrap();

        let t = MarkTable::default();
        let offers = t.icon_offers("pkg:a", Some(want));
        assert_eq!(offers[0], (want, true), "first, and attributed");
        assert_eq!(offers.iter().filter(|(_, n)| *n).count(), 1);

        // Claimed by somebody else: dropped, and NOTHING marks the difference —
        // the list is six unattributed visor offers, indistinguishable from a
        // ceremony with no nomination at all.
        let mut t = MarkTable::default();
        t.set_petname("pkg:other", None, Some(want), 1);
        let offers = t.icon_offers("pkg:a", Some(want));
        assert!(offers.iter().all(|(g, n)| !n && *g != want));
        assert_eq!(offers.len(), ICON_OFFERS);
    }

    /// sheets.ts:346-347 and :199-202: opening the ceremony to fix a typo in a
    /// petname must never silently cost a component its mark.
    #[test]
    fn this_records_own_mark_is_always_among_the_offers() {
        let mine = MarkIcon::app_mark("\u{2709}").unwrap();
        let mut t = MarkTable::default();
        t.set_petname("pkg:a", UserVoice::new("mail", NAME_MAX), Some(mine), 1);
        for _ in 0..40 {
            let offers = t.icon_offers("pkg:a", None);
            assert!(offers.iter().any(|(g, _)| *g == mine));
            assert_eq!(offers.len(), ICON_OFFERS);
        }
        // And it appears exactly ONCE even when the component nominates the
        // glyph the user already wears. It is attributed in that case, which is
        // sheets.ts:343's behaviour exactly and not an accident of the port:
        // `freeIcons` includes this record's own mark, so the nomination
        // survives the free test, and the attribution line is the honest
        // sentence — the component really did ask for it, and the user learning
        // that about a glyph they already chose is information rather than
        // noise. The `push` guard is what keeps it from being offered twice.
        let offers = t.icon_offers("pkg:a", Some(mine));
        assert_eq!(offers.iter().filter(|(g, _)| *g == mine).count(), 1);
        assert_eq!(offers[0], (mine, true));
    }

    /// wit/world.wit:296-301: the order must NOT be stable, or an app's
    /// nomination would win by default-bias alone. The property is that the
    /// non-nominated tail differs across ceremonies; a fixed list would make
    /// every draw identical.
    #[test]
    fn the_offers_are_drawn_freshly_per_ceremony() {
        let t = MarkTable::default();
        let first = t.icon_offers("pkg:a", None);
        assert_eq!(first.len(), ICON_OFFERS);
        let differs = (0..40).any(|_| t.icon_offers("pkg:a", None) != first);
        assert!(differs, "a stable global ordering is the failure this rules out");
        // Every offer is a distinct member of the vocabulary.
        for (g, _) in &first {
            assert!(MarkIcon::app_marks().any(|m| m == *g));
        }
        assert_eq!(
            first.iter().filter(|(g, _)| first.iter().filter(|(h, _)| h == g).count() > 1).count(),
            0,
        );
    }

    /// The vocabulary can run out; the ceremony must offer what is left rather
    /// than pad the row or repeat a glyph.
    #[test]
    fn the_offers_shrink_when_the_vocabulary_is_nearly_spent() {
        let mut t = MarkTable::default();
        let all: Vec<MarkIcon> = MarkIcon::app_marks().collect();
        for (i, g) in all.iter().enumerate().skip(2) {
            t.set_petname(&format!("pkg:{i}"), None, Some(*g), 1);
        }
        let offers = t.icon_offers("pkg:new", None);
        assert_eq!(offers.len(), 2, "only the two unclaimed glyphs are offerable");
    }

    /// sheets.ts:363-371 / wit/world.wit:303-306: trimmed and
    /// case-insensitive, and it names the colliding record BOTH ways so the
    /// visor can say what the clash is.
    #[test]
    fn a_collision_is_trimmed_case_insensitive_and_names_the_other_record() {
        let mut t = MarkTable::default();
        t.set_petname("pkg:mail", UserVoice::new("Mail", NAME_MAX), None, 1);
        assert_eq!(
            t.collision("pkg:other", "  mAiL "),
            Some(("pkg:mail".into(), "Mail".into())),
            "the petname as the USER wrote it, and the unforgeable key",
        );
        assert_eq!(t.collision("pkg:mail", "Mail"), None, "a record never clashes with itself");
        assert_eq!(t.collision("pkg:other", "notes"), None);
        // An unnamed record is not a collision target, and a blank probe finds
        // nothing rather than matching every unnamed record.
        t.set_petname("pkg:blank", None, None, 1);
        assert_eq!(t.collision("pkg:other", "   "), None);
    }

    /// The order records were first seen is the order `list-all` reports them
    /// in, and re-writing a record keeps its place (state.rs's `Conditions`
    /// rule: a re-assert is a refresh, not a re-ordering).
    #[test]
    fn the_table_is_insertion_ordered_and_a_rewrite_keeps_its_place() {
        let mut t = MarkTable::default();
        t.mark("pkg:a", 1);
        t.mark("pkg:b", 2);
        t.mark("pkg:c", 3);
        t.set_petname("pkg:a", UserVoice::new("first", NAME_MAX), None, 9);
        assert_eq!(t.iter().map(|(k, _)| k).collect::<Vec<_>>(), ["pkg:a", "pkg:b", "pkg:c"]);
        assert_eq!(t.get("pkg:a").unwrap().first_seen, 1, "a rewrite is not a re-sighting");
        assert_eq!(MarkTable::parse(Some(&t.to_json())), t);
    }
}
