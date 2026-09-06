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
    /// class. [`crate::style::CSS`] is checked against these in a test.
    pub(crate) const fn class(self) -> &'static str {
        match self {
            Voice::Framework => "framework",
            Voice::User => "user",
            Voice::App => "app",
        }
    }

    /// Used by the stylesheet test to prove no voice lacks a rule.
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
}
