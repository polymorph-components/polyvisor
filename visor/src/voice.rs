//! Voices as types.
//!
//! docs/design.md's rule for the trusted pixels: the user must be able to
//! tell, without reading, who is speaking. Three voices, three CSS classes,
//! and — for the one voice that is hostile input — a newtype whose only
//! constructor sits at the kernel import boundary.

use dioxus::prelude::*;

/// Who is speaking in a piece of rendered text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Voice {
    /// polyvisor itself: the framework's own words.
    Framework,
    /// The user's own words, echoed back (the device name).
    User,
    /// A publisher's words, arriving through the kernel. Always plated.
    App,
}

impl Voice {
    /// Every voice's rendering lives in exactly one CSS rule, named by this
    /// class.
    pub(crate) const fn class(self) -> &'static str {
        match self {
            Voice::Framework => "framework",
            Voice::User => "user",
            Voice::App => "app",
        }
    }

    /// Every voice, so a test can cover the whole set.
    #[cfg(test)]
    pub(crate) const ALL: [Voice; 3] = [Voice::Framework, Voice::User, Voice::App];
}

/// Text a publisher chose. Constructible only from a kernel response, so a
/// literal in this crate can never reach [`AppVoice`], and app text can
/// never reach a plain string slot without an explicit `.expose()`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct AppText(String);

impl AppText {
    /// The single import-boundary constructor: `apps`/`events` responses.
    pub(crate) fn from_kernel(s: String) -> Self {
        AppText(s)
    }

    /// Read the raw characters. Callers must plate whatever they do with
    /// them; the only in-crate caller is [`AppVoice`].
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

/// The one and only rendering of app-voice text: a quotation chip. The
/// `<q>` element is the whole point — it is the semantic marker for "these
/// are someone else's words", and grepping `<q` in `visor/src` must find
/// exactly this one site.
#[component]
pub(crate) fn AppVoice(text: AppText) -> Element {
    rsx! {
        q { class: "{Voice::App.class()}", "{text.expose()}" }
    }
}

/// How long ago, coarsely, in the framework's own voice.
///
/// Deliberately not a locale-formatted date. The entry picker runs before
/// any seal opens, so this text sits next to a petname on a screen that is
/// otherwise anonymous: an exact timestamp would be both a needless detail
/// and a fingerprintable one, and a locale-formatted one would drag a
/// formatting dependency into the trusted pixels. Coarse and English is
/// what the sheet needs to tell two devices apart.
///
/// Both arguments are epoch milliseconds (`store.entry.last-used`). A
/// timestamp in the future — clock skew, a row written by another tab —
/// reads as "just now" rather than as nonsense.
pub(crate) fn coarse_age(now_ms: u64, then_ms: u64) -> String {
    let secs = now_ms.saturating_sub(then_ms) / 1_000;
    let mins = secs / 60;
    let hours = mins / 60;
    let days = hours / 24;
    if mins == 0 {
        "just now".into()
    } else if hours == 0 {
        format!("{mins} min")
    } else if days == 0 {
        format!("{hours} h")
    } else {
        format!("{days} d")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_text_round_trips_kernel_input() {
        let t = AppText::from_kernel("Todos".into());
        assert_eq!(t.expose(), "Todos");
    }

    #[test]
    fn voices_have_distinct_classes() {
        let mut classes: Vec<&str> = Voice::ALL.iter().map(|v| v.class()).collect();
        classes.sort_unstable();
        classes.dedup();
        assert_eq!(classes.len(), Voice::ALL.len());
    }

    #[test]
    fn coarse_age_steps_through_its_four_words() {
        const S: u64 = 1_000;
        const M: u64 = 60 * S;
        const H: u64 = 60 * M;
        const D: u64 = 24 * H;
        let now = 1_000 * D;
        for (ago, want) in [
            (0, "just now"),
            (59 * S, "just now"),
            (M, "1 min"),
            (59 * M + 59 * S, "59 min"),
            (H, "1 h"),
            (23 * H, "23 h"),
            (D, "1 d"),
            (400 * D, "400 d"),
        ] {
            assert_eq!(coarse_age(now, now - ago), want, "{ago} ms ago");
        }
    }

    /// A row stamped in the future must not underflow into a huge age.
    #[test]
    fn coarse_age_clamps_the_future() {
        assert_eq!(coarse_age(0, 9_999_999), "just now");
    }
}
