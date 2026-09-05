//! WHAT THE VISOR KNOWS AND WHAT IT SHOWS: the surface record, the context
//! slot, the identity record, the event record and the standing conditions.
//!
//! Everything here is pure data plus its rules, so it is exercised by
//! `cargo test` on the host rather than only through a browser. The WIT
//! conversions live at the edges of this module; the rules do not name the
//! bindings.

use crate::voice::{AppVoice, FrameworkText, MarkIcon, UserVoice, IDENTITY_MAX, NAME_MAX};

// --- the surface -------------------------------------------------------------

/// WHAT THE VISOR KNOWS ABOUT ONE COMPONENT SURFACE (`types.surface`,
/// wit/world.wit:87-98; `SurfaceIdentity`, visor.ts:473).
///
/// THE THREE FIELDS ARE THREE VOICES, and the types say so. `name` is the
/// unforgeable provenance key the visor fetched the artifact by; `nickname` is
/// what the component says about itself and is therefore an [`AppVoice`] and
/// never a `String`; `petname` is what the user decided to call it. Only the
/// last of the three is ever spoken in the visor's own voice.
#[derive(Clone, PartialEq, Debug)]
pub struct Surface {
    /// NOT RENDERED BY THE STRIP AT ALL, and kept only because
    /// `same_context` compares by subject rather than by identity (visor.ts:1949).
    /// The sheets render it in app voice; the strip has no line for it.
    pub name: String,
    /// APP VOICE. Held as the marked type, so there is no bare copy of the
    /// component's own words anywhere in the crate — see `voice.rs`'s header.
    pub nickname: AppVoice,
    /// USER VOICE, or unmarked. `""` renders nothing at all: before the user
    /// has said anything about this component the visor has nothing of its own
    /// to say either (visor.ts:1571-1577).
    pub icon: Option<MarkIcon>,
    pub is_new: bool,
    /// USER VOICE.
    pub petname: Option<UserVoice>,
    /// WHAT THE COMPONENT ASKED TO WEAR. Held as a [`MarkIcon`], so an
    /// unvetted glyph is unrepresentable rather than filtered: the component
    /// chose which of the curated constants to point at, and supplied no
    /// string. Rendered in exactly one place, the naming ceremony's picker,
    /// and the component is never told the outcome.
    pub nomination: Option<MarkIcon>,
    /// One line of visor-known metadata for the App settings sheet. `value`
    /// is APP VOICE because it may be component-influenced (a panel's
    /// declared destination); `label` is the visor's own word.
    pub meta: Option<SurfaceMeta>,
    /// When the visor first assigned this record its mark, from the trust
    /// table. Rendered as a date the user can check.
    pub first_seen: Option<u64>,
}

/// One line of visor-known metadata about a surface (`types.surface-meta`).
#[derive(Clone, PartialEq, Debug)]
pub struct SurfaceMeta {
    /// THE VISOR'S OWN WORD for what this line is. Never a component's.
    pub label: String,
    /// Possibly component-influenced, so it is held marked and can only be
    /// rendered through the app-voice door.
    pub value: AppVoice,
    /// Whether the value is genuinely app-influenced. A visor-sourced value
    /// still renders in the visor's voice; the flag is what says which.
    pub foreign: bool,
}

/// The visor's context slot: what secondary surface, if any, is on screen
/// (`types.context`, wit/world.wit:102-113; `VisorContext`, visor.ts:531).
#[derive(Clone, PartialEq, Debug)]
pub enum Context {
    None,
    Panel(Surface),
    Credentials(Surface),
    Naming(Surface),
    Storage(Surface),
    Settings,
    Reset,
    Events,
    DevicePicker,
    FirstRun,
}

impl Context {
    /// The discriminant `render_context` branches on, spelled once.
    fn kind(&self) -> &'static str {
        match self {
            Context::None => "app",
            Context::Panel(_) => "panel",
            Context::Credentials(_) => "credentials",
            Context::Naming(_) => "naming",
            Context::Storage(_) => "storage",
            Context::Settings => "settings",
            Context::Reset => "reset",
            Context::Events => "events",
            Context::DevicePicker => "device-picker",
            Context::FirstRun => "first-run",
        }
    }

    /// IS ONE OF THE VISOR'S OWN SHEETS OPEN? Both lines consult it: the top
    /// line withholds its controls while a sheet owns the drawer (a control
    /// whose ceremony is already on screen must not offer to open it again),
    /// and the bottom line names the sheet (visor.ts:1542-1550).
    pub fn sheet_is_open(&self) -> bool {
        !matches!(self, Context::None | Context::Panel(_))
    }

    /// WHICH SURFACE THE CLUSTER IS ABOUT — both its lines, since the split
    /// between them is by VOICE and not by subject (visor.ts:1508-1529).
    ///
    /// CONTRACT / TRANSLATION LOSS. In TypeScript the bare kinds
    /// (settings/reset/events/device-picker/first-run) and the null context
    /// fall back to `config.appSurface()` — "which component the strip is
    /// about is a property of what is INSTALLED, not of which visor sheet
    /// happens to be open" (visor.ts:1511-1515). There is no `app-surface` on
    /// `control` and no way to register one, so the fallback has nothing to
    /// return and those contexts render an EMPTY top line. The conservative
    /// reading is taken: render nothing rather than invent a surface. See the
    /// spike report.
    pub fn top_surface(&self) -> Option<&Surface> {
        match self {
            Context::Panel(s)
            | Context::Credentials(s)
            | Context::Naming(s)
            | Context::Storage(s) => Some(s),
            _ => None,
        }
    }

    /// THE `.said` LEAD: while a visor sheet is open the strip NAMES it, so
    /// the anchor and the surface hanging off it say the same thing and "which
    /// pixels am I typing into" has a visor-side answer (visor.ts:1661-1701).
    /// The strings are that switch, verbatim.
    pub fn sheet_lead(&self) -> Option<&'static str> {
        Some(match self {
            Context::Credentials(_) => "storage credentials",
            Context::Naming(_) => "naming",
            Context::Storage(_) => "storage",
            Context::Reset => "erase this visor",
            Context::Events => "recent events",
            Context::DevicePicker => "choose a device",
            Context::FirstRun => "no account on this device yet",
            Context::Settings => "visor settings",
            Context::None | Context::Panel(_) => return None,
        })
    }

    /// IS THE CLUSTER ONE TAP TARGET? Offered only when there is a surface and
    /// no ceremony already owns the drawer — a control that would be a no-op
    /// must not announce itself as a button to assistive tech.
    ///
    /// The refusals are visor.ts:1738-1740's list and its argument: "storage"
    /// because offering to open the naming sheet would evict the very sheet
    /// the user is choosing in; "reset" because a destructive ceremony the
    /// user is mid-decision on must not be displaceable by a stray tap on the
    /// anchor it hangs from; the two entry ceremonies because they are the
    /// only thing the user can currently be doing.
    pub fn is_tappable(&self) -> bool {
        self.top_surface().is_some()
            && !matches!(
                self,
                Context::Credentials(_)
                    | Context::Naming(_)
                    | Context::Storage(_)
                    | Context::Reset
                    | Context::DevicePicker
                    | Context::FirstRun
            )
    }

    /// SAME STRIP SUBJECT? A context MOVE preempts a live announcement; a
    /// repaint that does not move the context must let it finish
    /// (visor.ts:1939-1954). Contexts are recomputed values, so the comparison
    /// is by SUBJECT — kind plus provenance key — not by identity.
    pub fn same_subject(&self, other: &Context) -> bool {
        self.kind() == other.kind()
            && self.top_surface().map(|s| &s.name) == other.top_surface().map(|s| &s.name)
    }
}

// --- the identity record -----------------------------------------------------

/// The user's name for themselves, their word for THIS DEVICE, and the glyph
/// they chose for the visor's own button (visor.ts:112-132).
///
/// NO FABRICATION: an unset field renders NOTHING — never "user", never "this
/// device". A default the visor invented would be a word it says in its own
/// voice that the user never wrote, which is the same authority-lending
/// mistake the petname/nickname split exists to prevent.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Identity {
    pub name: Option<UserVoice>,
    pub device: Option<UserVoice>,
    /// `None` = the record names no glyph; the button then wears the shield.
    /// An out-of-vocabulary value is dropped HERE rather than rendered.
    pub icon: Option<MarkIcon>,
}

impl Identity {
    /// Read a record out of the `store` slot's JSON, TOLERANTLY — missing,
    /// unparseable and hand-mangled all answer the same way, for the same
    /// reason `loadIdentity` does (visor.ts:368-385): this is hand-editable
    /// storage, and a visor that failed to boot because a string in it was not
    /// JSON would be bricked by a devtools typo.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw else { return Self::default() };
        Self {
            name: json_string(raw, "name").and_then(|v| UserVoice::new(&v, IDENTITY_MAX)),
            device: json_string(raw, "device").and_then(|v| UserVoice::new(&v, IDENTITY_MAX)),
            icon: json_string(raw, "icon")
                .and_then(|v| MarkIcon::identity_icon_strict(&v)),
        }
    }

    /// The stored shape. Empty fields are stored as ABSENT, not as `""`: unset
    /// must round-trip as unset so the strip keeps rendering nothing for them
    /// (visor.ts:387-397).
    pub fn to_json(&self) -> String {
        let mut fields: Vec<String> = Vec::new();
        if let Some(n) = &self.name {
            fields.push(format!("\"name\":{}", json_escape(n.as_str())));
        }
        if let Some(d) = &self.device {
            fields.push(format!("\"device\":{}", json_escape(d.as_str())));
        }
        if let Some(i) = &self.icon {
            fields.push(format!("\"icon\":{}", json_escape(i.as_str())));
        }
        format!("{{{}}}", fields.join(","))
    }
}

/// The glyph the visor's own button wears: the record's, or the shield.
pub fn identity_face(rec: &Identity) -> MarkIcon {
    rec.icon.unwrap_or_else(|| MarkIcon::identity_icon(None))
}

// --- the event record (#132) -------------------------------------------------

/// ONE THING THAT HAPPENED, kept after the line that said it expired
/// (`event-record`, wit/world.wit:192; `VisorEvent`, visor.ts:409).
///
/// `text` is exactly what an announcement said — framework voice, user-voice
/// words admissible inline, an app-influenced string never — which is what
/// lets the list render it with no dressing at all.
#[derive(Clone, PartialEq, Debug)]
pub struct Event {
    pub at: u64,
    pub text: FrameworkText,
}

/// How many records the visor keeps (visor.ts:418). The list is a
/// RECENT-EVENTS list, not a log: past a screenful or two nobody scrolls, and
/// an unbounded array in the one storage the visor owns on this device is a
/// slow leak. Oldest drops first — the newest news is the news.
pub const EVENTS_MAX: usize = 50;

/// The records plus the watermark that says which of them have been seen.
/// BOTH HALVES IN ONE SLOT, because they are one fact: a seen-mark without its
/// records is meaningless, and records without their mark would re-light the
/// badge on every boot (visor.ts:420-428).
#[derive(Clone, Default, Debug, PartialEq)]
pub struct EventStore {
    pub seen_at: u64,
    pub events: Vec<Event>,
}

impl EventStore {
    /// Tolerant parse, exactly `loadEvents`' contract (visor.ts:430-458): a
    /// corrupt record loses history; it must never lose the visor. Both fields
    /// or neither — a record with no text is a badge with nothing behind it.
    pub fn parse(raw: Option<&str>) -> Self {
        let Some(raw) = raw else { return Self::default() };
        let seen_at = json_number(raw, "seenAt").unwrap_or(0.0).max(0.0) as u64;
        let mut events = Vec::new();
        for obj in json_object_array(raw, "events") {
            let (Some(text), Some(at)) = (json_string(&obj, "text"), json_number(&obj, "at"))
            else {
                continue;
            };
            if text.is_empty() || !at.is_finite() {
                continue;
            }
            events.push(Event { at: at.max(0.0) as u64, text: FrameworkText::from(text) });
        }
        if events.len() > EVENTS_MAX {
            events.drain(..events.len() - EVENTS_MAX);
        }
        Self { seen_at, events }
    }

    pub fn to_json(&self) -> String {
        let items: Vec<String> = self
            .events
            .iter()
            .map(|e| format!("{{\"at\":{},\"text\":{}}}", e.at, json_escape(e.text.as_str())))
            .collect();
        format!("{{\"seenAt\":{},\"events\":[{}]}}", self.seen_at, items.join(","))
    }

    /// Append, dropping the oldest past the cap — ONE PER CALL, so the cap is a
    /// sliding window rather than a periodic purge (visor.ts:2671-2680).
    pub fn push(&mut self, at: u64, text: FrameworkText) {
        self.events.push(Event { at, text });
        if self.events.len() > EVENTS_MAX {
            self.events.drain(..self.events.len() - EVENTS_MAX);
        }
    }

    /// How many records are newer than the seen-watermark — half of what lights
    /// the badge.
    pub fn unseen(&self) -> u32 {
        self.events.iter().filter(|e| e.at > self.seen_at).count() as u32
    }

    /// Acknowledge everything currently recorded. MAX, not merely "now": a
    /// record written by a machine whose clock is ahead would otherwise sit
    /// permanently above the watermark and the badge would re-light the instant
    /// it was cleared (visor.ts:2685-2696).
    pub fn mark_seen(&mut self, now: u64) {
        let newest = self.events.last().map_or(0, |e| e.at);
        self.seen_at = now.max(newest);
    }

    /// A COPY, NEWEST FIRST — the order the sheet reads them in, without the
    /// stored vector being handed out to be mutated from outside.
    pub fn newest_first(&self) -> Vec<Event> {
        self.events.iter().rev().cloned().collect()
    }
}

/// STANDING CONDITIONS: states, not moments ("sync is failing"), which stay lit
/// for as long as they stand.
///
/// SESSION-LIVE, NEVER PERSISTED, and there is no code path here that could
/// persist one — the type holds no store key and `Visor::erase` has nothing to
/// remove for it. visor.ts:1087-1091 states why: a persisted condition could
/// outlive the thing that caused it with nothing left running to clear it,
/// leaving a badge lit forever over a fault that ended while the tab was
/// closed. Whoever raises a condition is a poller, and a poller re-asserts it a
/// tick after the next boot.
///
/// INSERTION-ORDERED, because the sheet lists them in the order they arrived
/// and re-sorting standing facts by anything else would make a stable list
/// jump. A `Vec` of pairs rather than a map: `BTreeMap` would sort by key and
/// `HashMap` would not order at all, and fifteen entries is not a lookup
/// problem.
#[derive(Clone, Default, Debug)]
pub struct Conditions(Vec<(String, FrameworkText)>);

impl Conditions {
    /// THE RETURN VALUE IS THE EDGE (wit/world.wit:232): true ONLY when the key
    /// was not already standing, so a poller can call this on every failing
    /// tick and announce only on the crossing. Re-setting a standing key
    /// UPDATES its text and KEEPS ITS POSITION — a re-assert is a text refresh,
    /// not a re-ordering of a list the user is reading (visor.ts:2698-2706).
    pub fn set(&mut self, key: String, text: FrameworkText) -> bool {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = text;
            return false;
        }
        self.0.push((key, text));
        true
    }

    /// The OTHER edge: true only if it WAS standing, so a recovery sentence is
    /// said once and only when a failure sentence was said — the visor does not
    /// congratulate itself for fixing something nobody was told was broken.
    pub fn clear(&mut self, key: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|(k, _)| k != key);
        before != self.0.len()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn list(&self) -> impl Iterator<Item = (&str, &FrameworkText)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
}

// --- the anchor colour -------------------------------------------------------

/// The anchor palette (visor.ts:54). FIXED LIGHTNESS AND CHROMA in OKLCH means
/// every choice keeps the same text contrast, so the anchor can never be
/// customised into an unreadable or a look-alike state.
pub const VISOR_HUES: [u16; 10] = [265, 210, 175, 140, 95, 60, 35, 10, 330, 300];

/// Is this a hue the visor may be wearing? A stored value outside the palette
/// is a fresh roll, not a rendered colour.
pub fn is_visor_hue(hue: u16) -> bool {
    VISOR_HUES.contains(&hue)
}

/// The inline value for `--visor-bg`.
///
/// SCOPED TO `#visor-strip` AND `#visor-drawer`, NEVER TO `:root` — this is
/// check (c) of `demo/scripts/check-invariants.sh` and a security property, not
/// a style preference. A custom property on the document root is ambient
/// authority: it inherits into every app region, so a component that ever
/// gained a `style` attribute could paint the visor's exact colour without ever
/// reading it (visor.ts:94-110). The two render sites in `app.rs` are the only
/// consumers of this function, and neither is the root.
pub fn visor_bg(hue: u16) -> String {
    format!("oklch(38% .07 {hue})")
}

// --- a JSON reader small enough to be worth not depending on -----------------
//
// The three stored shapes are `{"name":"…","device":"…","icon":"…"}`,
// `{"seenAt":N,"events":[{"at":N,"text":"…"}]}` and two bare scalars. Pulling
// in `serde` + `serde_json` for that would add ~40kB to an artifact whose size
// is one of the numbers this spike reports, to parse two object shapes the
// visor itself wrote. What the reader must be is TOLERANT — every caller above
// treats a parse miss as "absent", which is the documented behaviour of the
// TypeScript originals — so a strict parser buys nothing either.

/// The string value of a top-level `"key"` in `raw`, with JSON escapes
/// resolved. `None` when absent or not a string.
fn json_string(raw: &str, key: &str) -> Option<String> {
    let rest = after_key(raw, key)?;
    let mut chars = rest.char_indices();
    if chars.next()?.1 != '"' {
        return None;
    }
    let mut out = String::new();
    while let Some((_, c)) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                let (_, esc) = chars.next()?;
                out.push(match esc {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    'u' => {
                        let hex: String = (0..4).filter_map(|_| chars.next().map(|(_, c)| c)).collect();
                        char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?
                    }
                    other => other,
                });
            }
            other => out.push(other),
        }
    }
    None
}

/// The numeric value of a top-level `"key"`. `None` when absent or not a
/// number.
fn json_number(raw: &str, key: &str) -> Option<f64> {
    let rest = after_key(raw, key)?;
    let end = rest
        .find(|c: char| !matches!(c, '0'..='9' | '-' | '+' | '.' | 'e' | 'E'))
        .unwrap_or(rest.len());
    rest[..end].parse::<f64>().ok()
}

/// The elements of a top-level `"key": [ {…}, {…} ]` as their own object
/// sources, so the scalar readers above can be run against each in turn.
/// Depth-counted rather than regex-split: an event's `text` may legitimately
/// contain a brace.
fn json_object_array(raw: &str, key: &str) -> Vec<String> {
    let Some(rest) = after_key(raw, key) else { return Vec::new() };
    if !rest.starts_with('[') {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, c) in rest.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    out.push(rest[start..=i].to_string());
                }
            }
            ']' if depth == 0 => break,
            _ => {}
        }
    }
    out
}

/// The slice just after `"key":`, skipping whitespace. Only ever asked for keys
/// this crate itself writes, so a nested object carrying the same key would
/// have to have been hand-planted — and the readers above are tolerant by
/// contract, so the worst outcome is a field read as absent.
fn after_key<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let at = raw.find(&needle)? + needle.len();
    let rest = raw[at..].trim_start();
    rest.strip_prefix(':').map(str::trim_start)
}

/// A JSON string literal. Escapes the two characters that would break the
/// document plus the C0 range, which is what a hand-edited record could carry.
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

impl MarkIcon {
    /// The identity record's own validation: an out-of-vocabulary icon is
    /// DROPPED here rather than rendered, and `identity_face` supplies the
    /// default (visor.ts:378-380). Distinct from `identity_icon`, which is the
    /// render-site fallback.
    pub(crate) fn identity_icon_strict(icon: &str) -> Option<Self> {
        let resolved = MarkIcon::identity_icon(Some(icon));
        (resolved.as_str() == icon).then_some(resolved)
    }
}

// --- the surface's clamp ------------------------------------------------------

/// Build the guest-side surface from the WIT record. THE SINGLE SITE where a
/// component's own nickname is seen as a bare string: from here on it exists
/// only as an [`AppVoice`].
pub fn surface_from_parts(
    name: String,
    nickname: &str,
    icon: &str,
    is_new: bool,
    petname: Option<&str>,
) -> Surface {
    surface_with(name, nickname, icon, is_new, petname, None, None, None)
}

/// The full constructor. `surface_from_parts` is the four-field shorthand the
/// strip's own paths use; the naming ceremony needs the rest.
#[allow(clippy::too_many_arguments)]
pub fn surface_with(
    name: String,
    nickname: &str,
    icon: &str,
    is_new: bool,
    petname: Option<&str>,
    nomination: Option<&str>,
    meta: Option<(String, &str, bool)>,
    first_seen: Option<u64>,
) -> Surface {
    Surface {
        name,
        nickname: AppVoice::token(nickname),
        icon: MarkIcon::app_mark(icon),
        is_new,
        petname: petname.and_then(|p| UserVoice::new(p, NAME_MAX)),
        // A nomination outside the curated table is DROPPED, exactly as an
        // invalid one is: `app_mark` is the only constructor.
        nomination: nomination.and_then(MarkIcon::app_mark),
        meta: meta.map(|(label, value, foreign)| SurfaceMeta {
            label,
            value: AppVoice::token(value),
            foreign,
        }),
        first_seen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(name: &str) -> Surface {
        surface_from_parts(name.into(), "calls itself", "✉", false, Some("mail"))
    }

    #[test]
    fn the_event_record_caps_at_fifty_oldest_first() {
        let mut store = EventStore::default();
        for i in 0..60u64 {
            store.push(i, FrameworkText::from(format!("event {i}")));
        }
        assert_eq!(store.events.len(), EVENTS_MAX);
        assert_eq!(store.events[0].at, 10, "the oldest ten dropped, not the newest");
        assert_eq!(store.events[EVENTS_MAX - 1].at, 59);
    }

    #[test]
    fn unseen_counts_only_records_past_the_watermark() {
        let mut store = EventStore::default();
        for i in 1..=5u64 {
            store.push(i, FrameworkText::from("x"));
        }
        assert_eq!(store.unseen(), 5);
        store.mark_seen(3);
        assert_eq!(store.unseen(), 0, "a clock behind the newest record still clears the badge");
        store.push(9, FrameworkText::from("later"));
        assert_eq!(store.unseen(), 1);
    }

    /// visor.ts:2689-2692: a record written by a machine whose clock ran ahead
    /// must not stay permanently unseen.
    #[test]
    fn marking_seen_never_leaves_a_future_record_unseen() {
        let mut store = EventStore::default();
        store.push(9_000, FrameworkText::from("from the future"));
        store.mark_seen(1);
        assert_eq!(store.unseen(), 0);
        assert_eq!(store.seen_at, 9_000);
    }

    #[test]
    fn the_event_record_round_trips_through_its_slot() {
        let mut store = EventStore::default();
        store.push(7, FrameworkText::from("a \"quoted\" line\nand a break"));
        store.push(8, FrameworkText::from("plain"));
        store.mark_seen(8);
        let back = EventStore::parse(Some(&store.to_json()));
        assert_eq!(back, store);
    }

    /// visor.ts:430-435: hand-editable storage, so a corrupt record loses
    /// history and never the visor.
    #[test]
    fn a_mangled_record_reads_as_empty_rather_than_failing() {
        for raw in ["", "not json", "{", "{\"events\":\"nope\"}", "[]"] {
            let store = EventStore::parse(Some(raw));
            assert!(store.events.is_empty(), "{raw:?}");
        }
        // Half-written entries are dropped individually, not wholesale.
        let store = EventStore::parse(Some(
            r#"{"seenAt":2,"events":[{"at":1},{"text":"kept","at":3},{"text":""}]}"#,
        ));
        assert_eq!(store.events.len(), 1);
        assert_eq!(store.events[0].text.as_str(), "kept");
        assert_eq!(store.seen_at, 2);
    }

    #[test]
    fn the_identity_record_round_trips_and_drops_what_it_cannot_wear() {
        let rec = Identity {
            name: UserVoice::new("Ada", IDENTITY_MAX),
            device: UserVoice::new("the laptop", IDENTITY_MAX),
            icon: MarkIcon::identity_icon_strict("☾"),
        };
        let back = Identity::parse(Some(&rec.to_json()));
        assert_eq!(back.name.as_ref().map(UserVoice::as_str), Some("Ada"));
        assert_eq!(back.device.as_ref().map(UserVoice::as_str), Some("the laptop"));
        assert_eq!(back.icon.map(|i| i.as_str()), Some("☾"));

        // A hand-edited face outside the vocabulary is dropped, and the button
        // then wears the shield rather than the string.
        let forged = Identity::parse(Some(r#"{"name":"Ada","icon":"Verified"}"#));
        assert!(forged.icon.is_none());
        assert_eq!(identity_face(&forged).as_str(), "⛨");

        // Unset round-trips as unset: no fabricated "user"/"this device".
        let empty = Identity::parse(Some(r#"{"name":"   ","device":""}"#));
        assert!(empty.name.is_none() && empty.device.is_none());
    }

    #[test]
    fn conditions_are_edge_triggered_and_insertion_ordered() {
        let mut c = Conditions::default();
        assert!(c.set("sync".into(), "sync is failing".into()), "the crossing");
        assert!(!c.set("sync".into(), "sync is still failing".into()), "a re-assert is not");
        assert!(c.set("quota".into(), "storage is nearly full".into()));
        let keys: Vec<&str> = c.list().map(|(k, _)| k).collect();
        assert_eq!(keys, ["sync", "quota"], "a re-assert must not re-order");
        assert_eq!(c.list().next().unwrap().1.as_str(), "sync is still failing");
        assert!(c.clear("sync"));
        assert!(!c.clear("sync"), "the other edge fires once too");
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn a_context_move_is_by_subject_not_by_identity() {
        let a = Context::Panel(surface("pkg:a"));
        assert!(a.same_subject(&Context::Panel(surface("pkg:a"))), "recomputed, same subject");
        assert!(!a.same_subject(&Context::Panel(surface("pkg:b"))));
        assert!(!a.same_subject(&Context::Naming(surface("pkg:a"))), "the kind moved");
        assert!(Context::Settings.same_subject(&Context::Settings));
        assert!(!Context::Settings.same_subject(&Context::Reset));
    }

    /// The lead strings are a contract with the sheets and the spoken names —
    /// "the anchor, the button that opened the sheet and the sentence a screen
    /// reader hears must not each have their own name for one place".
    #[test]
    fn every_sheet_context_names_itself_and_no_other_does() {
        assert_eq!(Context::None.sheet_lead(), None);
        assert_eq!(Context::Panel(surface("a")).sheet_lead(), None);
        assert_eq!(Context::Reset.sheet_lead(), Some("erase this visor"));
        assert_eq!(Context::Settings.sheet_lead(), Some("visor settings"));
        assert_eq!(Context::FirstRun.sheet_lead(), Some("no account on this device yet"));
        assert_eq!(Context::Credentials(surface("a")).sheet_lead(), Some("storage credentials"));
    }

    /// visor.ts:1738-1740 and its argument: the cluster is a tap target only
    /// where opening the naming ceremony could not displace a ceremony the user
    /// is already in.
    #[test]
    fn the_cluster_refuses_to_be_a_button_over_a_ceremony() {
        assert!(Context::Panel(surface("a")).is_tappable());
        for ctx in [
            Context::Credentials(surface("a")),
            Context::Naming(surface("a")),
            Context::Storage(surface("a")),
            Context::Reset,
            Context::DevicePicker,
            Context::FirstRun,
            Context::None,
        ] {
            assert!(!ctx.is_tappable());
        }
    }

    #[test]
    fn the_anchor_colour_is_a_scoped_value_and_never_a_root_one() {
        assert_eq!(visor_bg(265), "oklch(38% .07 265)");
        assert!(is_visor_hue(265) && !is_visor_hue(266));
    }
}
