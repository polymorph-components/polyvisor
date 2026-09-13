//! Contacts UI: claim selection, QR rendering, and fragment routing.

use dioxus::prelude::*;

use crate::voice::coarse_age;

/// A claim the user may include in an introduction, with its selected state.
/// Selection is per exact `(name, value)`. Only `name` is on by default.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct ClaimChoice {
    pub(crate) name: String,
    pub(crate) value: String,
    pub(crate) selected: bool,
}

impl ClaimChoice {
    pub(crate) fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        let name = name.into();
        let selected = name == "name";
        ClaimChoice {
            name,
            value: value.into(),
            selected,
        }
    }
}

/// The selected `(name, value)` pairs, in order. What the preview shows and
/// what is signed are this same list — no re-derivation between them.
pub(crate) fn selected(claims: &[ClaimChoice]) -> Vec<(String, String)> {
    claims
        .iter()
        .filter(|c| c.selected)
        .map(|c| (c.name.clone(), c.value.clone()))
        .collect()
}

/// Meeting acceptance is whole-profile: preserve every displayed value while
/// matching the kernel's set comparison (sort + deduplicate).
pub(crate) fn complete_claims(mut claims: Vec<(String, String)>) -> Vec<(String, String)> {
    claims.sort();
    claims.dedup();
    claims
}

/// An incoming fragment's kind. The visor routes; it never decodes the body.
pub(crate) enum FragmentRoute {
    Meet(String),
    Contact(String),
    Other,
}

pub(crate) fn classify_fragment(fragment: &str) -> FragmentRoute {
    if let Some(body) = fragment.strip_prefix("meet/") {
        FragmentRoute::Meet(body.to_string())
    } else if let Some(body) = fragment.strip_prefix("contact/") {
        FragmentRoute::Contact(body.to_string())
    } else {
        FragmentRoute::Other
    }
}

pub(crate) fn key_short(key: &[u8]) -> String {
    if key.is_empty() {
        return "no key".into();
    }
    key.iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub(crate) fn qr_matrix(bytes: &[u8]) -> Result<Vec<Vec<bool>>, String> {
    let code = qrcode::QrCode::new(bytes).map_err(|error| error.to_string())?;
    let width = code.width();
    Ok((0..width)
        .map(|y| {
            (0..width)
                .map(|x| code[(x, y)] == qrcode::Color::Dark)
                .collect()
        })
        .collect())
}

pub(crate) fn accept_signed(captured: u64, current: u64) -> bool {
    captured == current
}

pub(crate) fn artifact_matches<T: PartialEq>(stored: &T, current: &T) -> bool {
    stored == current
}

pub(crate) fn generation_changed(previous: Option<u32>, current: u32) -> bool {
    previous != Some(current)
}

pub(crate) fn draft_is_clean(draft: &str, baseline: &str) -> bool {
    draft == baseline
}

pub(crate) fn should_rebase(draft: &str, baseline: Option<&str>) -> bool {
    baseline.is_none_or(|accepted| draft_is_clean(draft, accepted))
}

pub(crate) fn status_response_is_current(captured: u64, current: u64) -> bool {
    captured == current
}

pub(crate) fn submission_is_current(request: u64, current: u64) -> bool {
    request == current
}

pub(crate) fn default_name<'a>(
    preferred: Option<&'a str>,
    local_names: impl Iterator<Item = (&'a str, u64)>,
) -> String {
    preferred
        .map(str::to_owned)
        .or_else(|| {
            local_names
                .max_by_key(|(_, received)| *received)
                .map(|(value, _)| value.to_owned())
        })
        .unwrap_or_default()
}

pub(crate) fn name_claim(value: &str) -> Option<(String, String)> {
    (!value.is_empty()).then(|| ("name".into(), value.into()))
}

pub(crate) fn received_label(now_ms: u64, then_ms: u64) -> String {
    let age = coarse_age(now_ms, then_ms);
    if age == "just now" {
        age
    } else {
        format!("{age} ago")
    }
}

pub(crate) fn issuer_display<'a>(
    key: &[u8],
    contacts: impl Iterator<Item = (&'a [u8], &'a str)>,
) -> Option<String> {
    contacts
        .filter(|(public_key, _)| !public_key.is_empty())
        .find(|(public_key, _)| *public_key == key)
        .map(|(_, petname)| petname.to_string())
}

/// A QR code as one SVG `<path>`: the dark modules become a `d` string of
/// unit squares. A path `d` is a plain attribute value (not innerHTML) and
/// one node instead of hundreds of rects. `modules[y][x]` dark = true.
#[component]
pub(crate) fn Qr(modules: Vec<Vec<bool>>) -> Element {
    let size = modules.len();
    let canvas = size + 8;
    let mut d = String::new();
    for (y, row) in modules.iter().enumerate() {
        for (x, &dark) in row.iter().enumerate() {
            if dark {
                d.push_str(&format!("M{x} {y}h1v1h-1z"));
            }
        }
    }
    rsx! {
        svg {
            class: "qr",
            view_box: "-4 -4 {canvas} {canvas}",
            "shape-rendering": "crispEdges",
            rect { x: "-4", y: "-4", width: "{canvas}", height: "{canvas}", fill: "#fff" }
            path { d: "{d}", fill: "#000" }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_name_is_selected_by_default() {
        let claims = [
            ClaimChoice::new("name", "Ada"),
            ClaimChoice::new("email", "ada@example"),
        ];
        assert_eq!(selected(&claims), vec![("name".into(), "Ada".into())]);
    }

    #[test]
    fn meeting_acceptance_keeps_every_reviewed_value_canonically() {
        assert_eq!(
            complete_claims(vec![
                ("phone".into(), "2".into()),
                ("name".into(), "Ada".into()),
                ("phone".into(), "2".into()),
                ("email".into(), "a@example".into()),
            ]),
            vec![
                ("email".into(), "a@example".into()),
                ("name".into(), "Ada".into()),
                ("phone".into(), "2".into()),
            ]
        );
    }

    #[test]
    fn short_keys_are_safe_for_empty_and_long_values() {
        assert_eq!(key_short(&[]), "no key");
        assert_eq!(key_short(&[0, 1, 2, 3, 4, 5, 6]), "000102030405");
    }

    #[test]
    fn signed_completion_only_applies_to_its_generation() {
        assert!(accept_signed(7, 7));
        assert!(!accept_signed(7, 8));
    }

    #[test]
    fn signed_artifact_only_matches_its_exact_preview() {
        assert!(artifact_matches(&("name", "Ada"), &("name", "Ada")));
        assert!(!artifact_matches(&("name", "Ada"), &("name", "Grace")));
    }

    #[test]
    fn peer_selection_resets_only_for_a_new_generation() {
        assert!(!generation_changed(Some(4), 4));
        assert!(generation_changed(Some(4), 5));
        assert!(generation_changed(None, 1));
    }

    #[test]
    fn petname_rebases_only_while_clean_and_save_advances_baseline() {
        assert!(should_rebase("", None));
        assert!(should_rebase("", Some("")));
        assert!(!should_rebase("typing", Some("")));
        assert!(should_rebase("typing", Some("typing")));
    }

    #[test]
    fn status_response_only_applies_without_an_intervening_event() {
        assert!(status_response_is_current(3, 3));
        assert!(!status_response_is_current(3, 4));
    }

    #[test]
    fn submission_completion_only_applies_to_its_request() {
        assert!(submission_is_current(9, 9));
        assert!(!submission_is_current(9, 10));
    }

    #[test]
    fn default_name_prefers_override_then_latest_local_observation() {
        assert_eq!(
            default_name(Some("Chosen"), [("Old", 1), ("New", 2)].into_iter()),
            "Chosen"
        );
        assert_eq!(
            default_name(None, [("Old", 1), ("New", 2)].into_iter()),
            "New"
        );
    }

    #[test]
    fn empty_shared_name_is_omitted() {
        assert_eq!(name_claim(""), None);
        assert_eq!(name_claim("Ada"), Some(("name".into(), "Ada".into())));
    }

    #[test]
    fn received_age_does_not_say_just_now_ago() {
        assert_eq!(received_label(10_000, 10_000), "just now");
        assert_eq!(received_label(70_000, 10_000), "1 min ago");
    }

    #[test]
    fn issuer_uses_only_a_known_contacts_petname() {
        let key = [0, 1, 2];
        let other = [3, 4, 5];
        assert_eq!(
            issuer_display(&key, [(key.as_slice(), "Alice")].into_iter()),
            Some("Alice".into())
        );
        assert_eq!(
            issuer_display(&key, [(other.as_slice(), "Bob")].into_iter()),
            None
        );
    }
}
