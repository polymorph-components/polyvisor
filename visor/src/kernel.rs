//! Small async wrappers over the kernel imports.
//!
//! Two jobs, both about keeping the UI honest: every `result<_, error>`
//! collapses to `Result<_, String>` carrying the kernel's framework-voice
//! `message` (which is what the strip shows on failure), and everything the
//! kernel calls a title becomes an [`AppText`] right here, at the import
//! boundary, so no publisher string can reach a render slot unplated.

use crate::component::polyvisor::internal as api;
use crate::state::{DeviceState, Phase, Rest, Tier};
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
///
/// `name`/`hue`/`word` are empty and zero while sealed (internal.wit
/// `device`), which is exactly why the strip keys its dress off `state`
/// and never off "is the name empty": an unpainted anchor must be
/// unpaintable while the seal is shut, not merely usually blank.
///
/// `PartialEq` so a re-read can be compared against what is on screen and
/// dropped when it says the same thing: `Signal::set` marks its scope dirty
/// unconditionally, so an unguarded re-read on every Settings press would
/// re-render the whole visor to produce the identical DOM.
#[derive(PartialEq)]
pub(crate) struct Status {
    pub(crate) id: String,
    pub(crate) state: DeviceState,
    pub(crate) tier: Tier,
    pub(crate) rest: Rest,
    pub(crate) petname: String,
    pub(crate) name: String,
    pub(crate) hue: u16,
    pub(crate) word: String,
    /// This device's iroh endpoint id, z-base-32 (internal.wit `device`).
    /// "" while sealed, and until the endpoint is bound — so the sync
    /// section has to have something to say about an empty one.
    pub(crate) endpoint_id: String,
}

impl Status {
    /// The seal is shut. internal.wit `device`: `status` then answers with
    /// the id and state only, and every other kernel call is `unavailable`
    /// until `unseal` — except `erase` and `store.devices`. This is the
    /// visor's one gate, because the same doc rules that "`fresh` is not a
    /// gate: an ephemeral device is fully usable".
    pub(crate) fn is_sealed(&self) -> bool {
        self.state == DeviceState::Sealed
    }
}

/// One row of the device index (`store.entry`), as the picker needs it.
/// `created` is in the contract and not on any screen, so it is dropped
/// here rather than carried unused.
#[derive(Clone, PartialEq)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) petname: String,
    pub(crate) tier: Tier,
    pub(crate) last_used: u64,
}

fn message(e: api::types::Error) -> String {
    e.message
}

fn device_state(s: api::device::State) -> DeviceState {
    match s {
        api::device::State::Fresh => DeviceState::Fresh,
        api::device::State::Sealed => DeviceState::Sealed,
        api::device::State::Open => DeviceState::Open,
    }
}

fn tier(t: api::device::Tier) -> Tier {
    match t {
        api::device::Tier::Ephemeral => Tier::Ephemeral,
        api::device::Tier::Durable => Tier::Durable,
    }
}

fn rest(r: api::device::Rest) -> Rest {
    match r {
        api::device::Rest::RestsOpen => Rest::RestsOpen,
        api::device::Rest::Passphrase => Rest::Passphrase,
    }
}

pub(crate) async fn status() -> Result<Status, String> {
    api::device::status()
        .await
        .map_err(message)
        .map(|s| Status {
            id: s.id,
            state: device_state(s.state),
            tier: tier(s.tier),
            rest: rest(s.rest),
            petname: s.petname,
            name: s.name,
            hue: s.hue,
            word: s.word,
            endpoint_id: s.endpoint_id,
        })
}

/// One dialed device, as the sync section lists it (internal.wit `sync`).
/// `state` is the kernel's own framework voice ("connecting", "connected",
/// "closed: <why>") and is rendered unplated for exactly that reason.
#[derive(Clone, PartialEq)]
pub(crate) struct Peer {
    pub(crate) endpoint_id: String,
    pub(crate) state: String,
}

/// Dial another device. Returning is not converging: the contract only
/// promises the dial was accepted, so the devices section re-reads `peers`
/// afterwards rather than inventing a row of its own.
///
/// Only ever called with a member's endpoint id (internal.wit `sync`: "a
/// non-member is refused with `refused`"), which is why there is no box to
/// paste a stranger's id into any more.
pub(crate) async fn connect(endpoint_id: String) -> Result<(), String> {
    api::sync::connect(endpoint_id).await.map_err(message)
}

pub(crate) async fn peers() -> Result<Vec<Peer>, String> {
    Ok(api::sync::peers()
        .await
        .map_err(message)?
        .into_iter()
        .map(|p| Peer {
            endpoint_id: p.endpoint_id,
            state: p.state,
        })
        .collect())
}

/// One device of this user's group (internal.wit `sync.member`).
///
/// `petname` is the user's own word for that device and is rendered in the
/// user voice; the endpoint id is what stands in for it when there is
/// none, in the monospace the ids are always shown in. `enrolled` is epoch
/// milliseconds, shown coarsely ([`crate::voice::coarse_age`]).
#[derive(Clone, PartialEq)]
pub(crate) struct Member {
    pub(crate) endpoint_id: String,
    pub(crate) petname: String,
    pub(crate) enrolled: u64,
    pub(crate) me: bool,
}

/// The device group, this device included.
pub(crate) async fn members() -> Result<Vec<Member>, String> {
    Ok(api::sync::members()
        .await
        .map_err(message)?
        .into_iter()
        .map(|m| Member {
            endpoint_id: m.endpoint_id,
            petname: m.petname,
            enrolled: m.enrolled,
            me: m.me,
        })
        .collect())
}

fn phase(p: api::types::Phase) -> Phase {
    match p {
        api::types::Phase::Idle => Phase::Idle,
        api::types::Phase::Offering(code) => Phase::Offering(code),
        api::types::Phase::Claiming => Phase::Claiming,
        api::types::Phase::AwaitingConfirm(sas) => Phase::AwaitingConfirm(sas),
        api::types::Phase::AwaitingPeer => Phase::AwaitingPeer,
        api::types::Phase::Done => Phase::Done,
        api::types::Phase::Failed(why) => Phase::Failed(why),
    }
}

/// Joiner: mint an offer. The code it answers is dropped on purpose — the
/// ceremony's one authority is `pairing.status`, and the visor reads it
/// back rather than keeping a second copy that could disagree with the
/// kernel about which offer is open.
pub(crate) async fn pairing_offer() -> Result<(), String> {
    api::pairing::offer().await.map(|_| ()).map_err(message)
}

/// Adder: claim the code the other device is showing.
pub(crate) async fn pairing_claim(code: String) -> Result<(), String> {
    api::pairing::claim(code).await.map_err(message)
}

/// Either side, after comparing the six digits.
pub(crate) async fn pairing_confirm() -> Result<(), String> {
    api::pairing::confirm().await.map_err(message)
}

/// Either side, at any point.
pub(crate) async fn pairing_cancel() -> Result<(), String> {
    api::pairing::cancel().await.map_err(message)
}

pub(crate) async fn pairing_status() -> Result<Phase, String> {
    api::pairing::status().await.map_err(message).map(phase)
}

/// The device index: every device on this origin, petname and tier only.
pub(crate) async fn devices() -> Result<Vec<Entry>, String> {
    Ok(api::store::devices()
        .await
        .map_err(message)?
        .into_iter()
        .map(|e| Entry {
            id: e.id,
            petname: e.petname,
            tier: tier(e.tier),
            last_used: e.last_used,
        })
        .collect())
}

/// The login. A wrong passphrase comes back as an error whose framework
/// voice message is what the sheet shows; the device stays sealed.
pub(crate) async fn unseal(passphrase: String) -> Result<(), String> {
    api::device::unseal(passphrase).await.map_err(message)
}

/// Promote to durable. `None` is "rests open".
pub(crate) async fn keep(petname: String, passphrase: Option<String>) -> Result<(), String> {
    api::device::keep(petname, passphrase)
        .await
        .map_err(message)
}

pub(crate) async fn erase() -> Result<(), String> {
    api::device::erase().await.map_err(message)
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

/// Re-anchor this tab to another device, or with `None` to a fresh one.
/// Sync in the contract, and terminal in effect: the page reloads.
pub(crate) fn switch_device(device: Option<String>) {
    api::shell::switch_device(device.as_deref());
}

/// `navigator.storage.persist()`. `false` only means the browser declined
/// to exempt this origin from eviction — the device is durable either way,
/// so the caller notes it and carries on.
pub(crate) async fn request_persistence() -> bool {
    api::shell::request_persistence().await
}

/// One store binding, as the Storage section shows it (internal.wit
/// `storage.binding`).
///
/// `state` is the kernel's own framework voice — "not connected",
/// "connected", "connected; the last sync did not finish: <why>", "needs
/// re-authorization: <why>" — and is rendered exactly as it arrived, like a
/// peer's state. The visor composes no sentence of its own about a store.
#[derive(Clone, PartialEq)]
pub(crate) struct Binding {
    pub(crate) provider: String,
    pub(crate) state: String,
    /// Epoch milliseconds, 0 if never.
    pub(crate) last_pull: u64,
    pub(crate) last_push: u64,
}

impl Binding {
    /// Is there a store to sync with?
    ///
    // CONTRACT: internal.wit `storage.binding` carries no boolean — the
    // connectedness of a binding is only in `state`, whose four spellings
    // the contract enumerates. So the visor matches the two that mean "the
    // ceremony has to be run": "not connected", and the
    // "needs re-authorization: <why>" prefix. Anything else is a binding
    // that has tokens, which is the conservative reading: a state this
    // visor does not recognise still shows the store's own words, and
    // still offers "Disconnect", so nothing is stranded by a vocabulary
    // that grew.
    pub(crate) fn connected(&self) -> bool {
        self.state != "not connected"
    }

    /// Does the user have to run the ceremony (again)?
    pub(crate) fn needs_ceremony(&self) -> bool {
        !self.connected() || self.state.starts_with("needs re-authorization")
    }
}

pub(crate) async fn storage_status() -> Result<Binding, String> {
    api::storage::status()
        .await
        .map_err(message)
        .map(|b| Binding {
            provider: b.provider,
            state: b.state,
            last_pull: b.last_pull,
            last_push: b.last_push,
        })
}

/// Mint a PKCE ceremony; the answer is the authorization URL for the
/// popup. The redirect is the kernel's own (`boot-config.page-url`), which
/// is why the visor supplies only the client pair.
pub(crate) async fn oauth_start(
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    api::storage::oauth_start(api::storage::OauthClient {
        client_id,
        client_secret,
    })
    .await
    .map_err(message)
}

/// The popup landed back: hand the kernel the pair and let it exchange and
/// seal. The one-shot code crosses here; no token ever does.
pub(crate) async fn oauth_complete(code: String, state: String) -> Result<(), String> {
    api::storage::oauth_complete(code, state)
        .await
        .map_err(message)
}

pub(crate) async fn storage_disconnect() -> Result<(), String> {
    api::storage::disconnect().await.map_err(message)
}

pub(crate) async fn sync_now() -> Result<(), String> {
    api::storage::sync_now().await.map_err(message)
}

/// Open the authorization URL in a popup and wait for the `code`/`state`
/// it comes back with. `None` is a window the user closed — not a failure,
/// and nothing for the kernel to hear about.
pub(crate) async fn open_popup(url: String) -> Option<(String, String)> {
    api::shell::open_popup(url).await
}

/// Wall-clock now, epoch milliseconds, for [`crate::voice::coarse_age`].
///
/// `std`'s clock, not an import of our own: the visor world declares no
/// clock, but a wasip2 component links the WASI baselines regardless
/// (`wasi:clocks/wall-clock` is already among this component's imports at
/// M1) and the glue already supplies them. A clock that will not read is
/// reported as the epoch, which makes every age "very old" rather than
/// killing the sheet.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The next kernel event.
pub(crate) enum Event {
    /// The pairing ceremony moved (internal.wit `events.pairing-changed`).
    /// The push exists because a ceremony advances when the *other* device
    /// acts, and this world has no timer to notice that with.
    PairingChanged(Phase),
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
        api::events::Event::PairingChanged(p) => Event::PairingChanged(phase(p)),
    }
}
