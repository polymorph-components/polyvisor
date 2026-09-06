//! Small async wrappers over the kernel imports.
//!
//! Two jobs, both about keeping the UI honest: every `result<_, error>`
//! collapses to `Result<_, String>` carrying the kernel's framework-voice
//! `message` (which is what the strip shows on failure), and everything the
//! kernel calls a title becomes an [`AppText`] right here, at the import
//! boundary, so no publisher string can reach a render slot unplated.

use crate::component::polyvisor::internal as api;
use crate::voice::AppText;

pub(crate) type SessionId = u32;

/// An installed app as the strip needs it: an id to launch, and a title
/// that is already marked as someone else's words.
#[derive(Clone, PartialEq)]
pub(crate) struct App {
    pub(crate) id: String,
    pub(crate) title: AppText,
}

/// The device identity the strip and the settings tenant show.
pub(crate) struct Status {
    pub(crate) name: String,
    pub(crate) hue: u16,
    pub(crate) word: String,
}

fn message(e: api::types::Error) -> String {
    e.message
}

pub(crate) async fn status() -> Result<Status, String> {
    api::device::status()
        .await
        .map_err(message)
        .map(|s| Status {
            name: s.name,
            hue: s.hue,
            word: s.word,
        })
}

pub(crate) async fn set_name(name: String) -> Result<(), String> {
    api::device::set_name(name).await.map_err(message)
}

pub(crate) async fn set_hue(hue: u16) -> Result<(), String> {
    api::device::set_hue(hue).await.map_err(message)
}

pub(crate) async fn reroll_word() -> Result<String, String> {
    api::device::reroll_word().await.map_err(message)
}

pub(crate) async fn installed() -> Result<Vec<App>, String> {
    Ok(api::apps::installed()
        .await
        .map_err(message)?
        .into_iter()
        .map(|a| App {
            id: a.id,
            title: AppText::from_kernel(a.title),
        })
        .collect())
}

pub(crate) async fn launch(app: &str) -> Result<SessionId, String> {
    api::apps::launch(app.to_string()).await.map_err(message)
}

pub(crate) async fn close(session: SessionId) -> Result<(), String> {
    api::apps::close(session).await.map_err(message)
}

pub(crate) async fn open_frame(session: SessionId) -> Result<(), String> {
    api::shell::open_frame(session).await.map_err(message)
}

pub(crate) async fn close_frame(session: SessionId) -> Result<(), String> {
    api::shell::close_frame(session).await.map_err(message)
}

/// The next kernel event.
pub(crate) enum Event {
    /// internal.wit's `events.session-ended` settles the voice: "the reason,
    /// framework voice: the kernel or the glue composed it, so the visor
    /// renders it unplated and plates only the app title". So the reason is
    /// carried as a plain `String` here. If it ever came to relay publisher
    /// text, the contract would have to change first, and this would have to
    /// become an `AppText`.
    SessionEnded(SessionId, String),
}

pub(crate) async fn next_event() -> Event {
    match api::events::next().await {
        api::events::Event::SessionEnded((session, reason)) => Event::SessionEnded(session, reason),
    }
}
