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
/// `name`/`hue` are empty and zero while sealed (internal.wit
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

/// Which map `meta`/`patch-meta` addresses (internal.wit `meta-scope`).
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum MetaScope {
    User,
    App(String),
}

fn meta_scope(scope: MetaScope) -> api::device::MetaScope {
    match scope {
        MetaScope::User => api::device::MetaScope::User,
        MetaScope::App(id) => api::device::MetaScope::App(id),
    }
}

pub(crate) type Meta = std::collections::BTreeMap<String, String>;

/// The user's own labels for themself or one app (internal.wit `device.meta`).
pub(crate) async fn meta(scope: MetaScope) -> Result<Meta, String> {
    Ok(api::device::meta(meta_scope(scope))
        .await
        .map_err(message)?
        .into_iter()
        .collect())
}

/// Apply field changes for `scope` (internal.wit `device.patch-meta`).
pub(crate) async fn patch_meta(
    scope: MetaScope,
    fields: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    api::device::patch_meta(meta_scope(scope), fields)
        .await
        .map_err(message)
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

/// Show a session's frame. `route` is what the frame answers
/// `polyvisor:app/route.get` with (internal.wit `shell.open-frame`): the
/// route a bookmark carried, or "" for a plain launch.
pub(crate) async fn open_frame(session: SessionId, route: &str) -> Result<(), String> {
    api::shell::open_frame(session, route.to_string())
        .await
        .map_err(message)
}

/// This page's fragment without its `#`, or `None` when there is none.
///
/// Sync in the contract (internal.wit `shell.fragment`) because it is a
/// read of the page's own URL, which the glue already has.
pub(crate) fn fragment() -> Option<String> {
    api::shell::fragment()
}

/// What a bookmark resolves to: the app to launch, and the route to hand
/// its frame.
///
/// The visor never looks inside `fragment`. The kernel owns the grammar
/// and the token is opaque — install id and route sealed under the user's
/// route key (internal.wit `apps.route-decode`) — so a fragment this
/// device cannot open is a kernel `not-found`, with the kernel's own
/// framework-voice message, and not a shape this file could recognise.
pub(crate) async fn route_decode(fragment: &str) -> Result<(App, String), String> {
    api::apps::route_decode(fragment.to_string())
        .await
        .map_err(message)
        .map(|t| {
            (
                App {
                    id: t.app.id,
                    title: AppText::from_kernel(t.app.title),
                },
                t.route,
            )
        })
}

/// The fragment an installed app's window opens at (internal.wit
/// `apps.install-fragment`): `launch/<app-id>`, plaintext and keyless
/// (docs/design.md "Routing", the `launch/` bullet — it must outlive
/// route-key convergence, and names a package the launcher already shows).
pub(crate) async fn install_fragment(app: &str) -> Result<String, String> {
    api::apps::install_fragment(app.to_string())
        .await
        .map_err(message)
}

/// How an install request ended on the page (internal.wit
/// `shell.install-outcome`). Re-exported rather than wrapped in a crate
/// enum: the two variants are already the whole shape the UI needs to
/// branch on.
pub(crate) type InstallOutcome = api::shell::InstallOutcome;

/// Install `app` as its own installed web app (internal.wit
/// `shell.install-app`).
///
/// `glyph` is the app's SAVED glyph (`meta-scope.app`), never the sheet's
/// unsaved draft: an install writes into the OS's app registry, so the mark
/// it carries has to be one the user committed to. "" means none, and the
/// glue falls back to the framework's static icons.
pub(crate) async fn install_app(
    fragment: String,
    title: String,
    hue: u16,
    glyph: String,
) -> Result<InstallOutcome, String> {
    api::shell::install_app(api::shell::InstallRequest {
        fragment,
        title,
        hue,
        glyph,
    })
    .await
    .map_err(message)
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

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Provenance {
    Local,
    Imported,
    Verified,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ClaimedTime {
    pub(crate) seconds: i64,
    pub(crate) nanos: u32,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Observation {
    pub(crate) name: AppText,
    pub(crate) value: AppText,
    pub(crate) provenance: Provenance,
    pub(crate) issuer: Vec<u8>,
    pub(crate) claimed: Option<ClaimedTime>,
    pub(crate) received: u64,
    pub(crate) meeting: String,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Contact {
    pub(crate) id: String,
    pub(crate) public_key: Vec<u8>,
    pub(crate) petname: String,
    pub(crate) glyph: String,
    pub(crate) observations: Vec<Observation>,
    pub(crate) preferred: Vec<(String, String)>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct SelfProfile {
    pub(crate) public_key: Vec<u8>,
    pub(crate) observations: Vec<Observation>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Party {
    pub(crate) public_key: Vec<u8>,
    pub(crate) claims: Vec<(String, String)>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Introduction {
    pub(crate) issuer: Party,
    pub(crate) parties: Vec<Party>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct MeetingRecord {
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) source: String,
    pub(crate) source_key: Vec<u8>,
    pub(crate) occurred: u64,
    pub(crate) verified: bool,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ImportParty {
    pub(crate) index: u32,
    pub(crate) public_key: Vec<u8>,
    pub(crate) issuer: Vec<u8>,
    pub(crate) claimed: Option<ClaimedTime>,
    pub(crate) provenance: Provenance,
    pub(crate) claims: Vec<(AppText, AppText)>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ImportReview {
    pub(crate) parties: Vec<ImportParty>,
    pub(crate) signed: bool,
    pub(crate) summary: String,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Selection {
    pub(crate) index: u32,
    pub(crate) claims: Vec<(String, String)>,
}

#[derive(Clone, PartialEq)]
pub(crate) enum MeetingPhase {
    Idle,
    Offering {
        generation: u32,
        link: String,
    },
    Dialing(u32),
    AwaitingConfirm {
        generation: u32,
        sas: String,
        peer_key: Vec<u8>,
        claims: Vec<(AppText, AppText)>,
    },
    AwaitingPeer(u32),
    Done(String),
    Failed(String),
}

impl MeetingPhase {
    pub(crate) fn generation(&self) -> Option<u32> {
        match self {
            Self::Offering { generation, .. }
            | Self::Dialing(generation)
            | Self::AwaitingConfirm { generation, .. }
            | Self::AwaitingPeer(generation) => Some(*generation),
            Self::Idle | Self::Done(_) | Self::Failed(_) => None,
        }
    }
}

fn provenance(value: api::contacts::Provenance) -> Provenance {
    match value {
        api::contacts::Provenance::Local => Provenance::Local,
        api::contacts::Provenance::Imported => Provenance::Imported,
        api::contacts::Provenance::Verified => Provenance::Verified,
    }
}
fn observation(value: api::contacts::Observation) -> Observation {
    Observation {
        name: AppText::from_kernel(value.name),
        value: AppText::from_kernel(value.value),
        provenance: provenance(value.provenance),
        issuer: value.issuer,
        claimed: value.claimed.map(|t| ClaimedTime {
            seconds: t.seconds,
            nanos: t.nanos,
        }),
        received: value.received,
        meeting: value.meeting,
    }
}
fn contact(value: api::contacts::Contact) -> Contact {
    Contact {
        id: value.id,
        public_key: value.public_key,
        petname: value.petname,
        glyph: crate::glyph::normalize_glyph(&value.glyph).to_string(),
        observations: value.observations.into_iter().map(observation).collect(),
        preferred: value.preferred,
    }
}
fn raw_party(value: Party) -> api::contacts::Party {
    api::contacts::Party {
        public_key: value.public_key,
        claims: value.claims,
    }
}
fn meeting_phase(status: api::types::MeetingStatus) -> MeetingPhase {
    match status.phase {
        api::types::MeetingPhase::Idle => MeetingPhase::Idle,
        api::types::MeetingPhase::Offering(link) => MeetingPhase::Offering {
            generation: status
                .generation
                .expect("active meeting status has a generation"),
            link,
        },
        api::types::MeetingPhase::Dialing => MeetingPhase::Dialing(
            status
                .generation
                .expect("active meeting status has a generation"),
        ),
        api::types::MeetingPhase::AwaitingConfirm(review) => MeetingPhase::AwaitingConfirm {
            generation: status
                .generation
                .expect("active meeting status has a generation"),
            sas: review.sas,
            peer_key: review.peer_key,
            claims: review
                .claims
                .into_iter()
                .map(|(n, v)| (AppText::from_kernel(n), AppText::from_kernel(v)))
                .collect(),
        },
        api::types::MeetingPhase::AwaitingPeer => MeetingPhase::AwaitingPeer(
            status
                .generation
                .expect("active meeting status has a generation"),
        ),
        api::types::MeetingPhase::Done(id) => MeetingPhase::Done(id),
        api::types::MeetingPhase::Failed(error) => MeetingPhase::Failed(error),
    }
}

pub(crate) async fn contacts_items() -> Result<Vec<Contact>, String> {
    Ok(api::contacts::items()
        .await
        .map_err(message)?
        .into_iter()
        .map(contact)
        .collect())
}
pub(crate) async fn contacts_profile() -> Result<SelfProfile, String> {
    api::contacts::profile()
        .await
        .map_err(message)
        .map(|p| SelfProfile {
            public_key: p.public_key,
            observations: p.observations.into_iter().map(observation).collect(),
        })
}
pub(crate) async fn contacts_meetings() -> Result<Vec<MeetingRecord>, String> {
    Ok(api::contacts::meetings()
        .await
        .map_err(message)?
        .into_iter()
        .map(|m| MeetingRecord {
            id: m.id,
            method: m.method,
            source: m.source,
            source_key: m.source_key,
            occurred: m.occurred,
            verified: m.verified,
        })
        .collect())
}
pub(crate) async fn contacts_create(
    key: Vec<u8>,
    petname: String,
    glyph: String,
) -> Result<String, String> {
    api::contacts::create(key, petname, glyph)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_set_label(
    id: String,
    petname: String,
    glyph: String,
) -> Result<(), String> {
    api::contacts::set_label(id, petname, glyph)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_set_observation(
    id: String,
    name: String,
    value: String,
) -> Result<(), String> {
    api::contacts::set_observation(id, name, value)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_remove_observation(
    id: String,
    name: String,
    value: String,
) -> Result<(), String> {
    api::contacts::remove_observation(id, name, value)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_set_preferred(
    id: String,
    name: String,
    value: Option<String>,
) -> Result<(), String> {
    api::contacts::set_preferred(id, name, value)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_delete(id: String) -> Result<(), String> {
    api::contacts::delete(id).await.map_err(message)
}
pub(crate) async fn contacts_merge(from: String, into: String) -> Result<(), String> {
    api::contacts::merge(from, into).await.map_err(message)
}
pub(crate) async fn contacts_set_self_observation(
    name: String,
    value: String,
) -> Result<(), String> {
    api::contacts::set_self_observation(name, value)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_remove_self_observation(
    name: String,
    value: String,
) -> Result<(), String> {
    api::contacts::remove_self_observation(name, value)
        .await
        .map_err(message)
}
pub(crate) async fn contacts_share(value: Introduction) -> Result<Vec<u8>, String> {
    api::contacts::share(api::contacts::Introduction {
        issuer: raw_party(value.issuer),
        parties: value.parties.into_iter().map(raw_party).collect(),
    })
    .await
    .map_err(message)
}
pub(crate) async fn contacts_import_preview(bytes: &[u8]) -> Result<ImportReview, String> {
    api::contacts::import_preview(bytes.to_vec())
        .await
        .map_err(message)
        .map(|r| ImportReview {
            parties: r
                .parties
                .into_iter()
                .map(|p| ImportParty {
                    index: p.index,
                    public_key: p.public_key,
                    issuer: p.issuer,
                    claimed: p.claimed.map(|t| ClaimedTime {
                        seconds: t.seconds,
                        nanos: t.nanos,
                    }),
                    provenance: provenance(p.provenance),
                    claims: p
                        .claims
                        .into_iter()
                        .map(|(n, v)| (AppText::from_kernel(n), AppText::from_kernel(v)))
                        .collect(),
                })
                .collect(),
            signed: r.signed,
            summary: r.summary,
        })
}
pub(crate) async fn decode_link(body: String) -> Result<Vec<u8>, String> {
    api::contacts::decode_link(body).await.map_err(message)
}
pub(crate) async fn contacts_import_accept(
    bytes: &[u8],
    source: String,
    selections: Vec<Selection>,
) -> Result<Vec<String>, String> {
    api::contacts::import_accept(
        bytes.to_vec(),
        source,
        selections
            .into_iter()
            .map(|s| api::contacts::Selection {
                index: s.index,
                claims: s.claims,
            })
            .collect::<Vec<_>>(),
    )
    .await
    .map_err(message)
}
pub(crate) async fn meeting_offer(card: Party) -> Result<MeetingPhase, String> {
    api::meeting::offer(raw_party(card))
        .await
        .map_err(message)
        .map(meeting_phase)
}
pub(crate) async fn meeting_join(fragment: String, card: Party) -> Result<MeetingPhase, String> {
    api::meeting::join(fragment, raw_party(card))
        .await
        .map_err(message)
        .map(meeting_phase)
}
pub(crate) async fn meeting_confirm(
    generation: u32,
    keep: Vec<(String, String)>,
) -> Result<(), String> {
    api::meeting::confirm(generation, keep)
        .await
        .map_err(message)
}
pub(crate) async fn meeting_cancel(generation: u32) -> Result<(), String> {
    api::meeting::cancel(generation).await.map_err(message)
}
pub(crate) async fn meeting_status() -> Result<MeetingPhase, String> {
    api::meeting::status()
        .await
        .map_err(message)
        .map(meeting_phase)
}
pub(crate) fn page_url() -> String {
    api::shell::page_url()
}
pub(crate) async fn copy_text(text: String) -> Result<(), String> {
    api::shell::copy_text(text).await.map_err(message)
}
pub(crate) async fn read_contact_file() -> Result<Option<(String, Vec<u8>)>, String> {
    api::shell::read_contact_file().await.map_err(message)
}
pub(crate) async fn save_contact_file(name: String, bytes: &[u8]) -> Result<(), String> {
    api::shell::save_contact_file(name, bytes.to_vec())
        .await
        .map_err(message)
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
    PersonalizationChanged,
    ContactsChanged,
    MeetingChanged(MeetingPhase),
}

pub(crate) async fn next_event() -> Event {
    match api::events::next().await {
        api::events::Event::SessionEnded((session, reason)) => Event::SessionEnded(session, reason),
        api::events::Event::PairingChanged(p) => Event::PairingChanged(phase(p)),
        api::events::Event::PersonalizationChanged => Event::PersonalizationChanged,
        api::events::Event::ContactsChanged => Event::ContactsChanged,
        api::events::Event::MeetingChanged(p) => Event::MeetingChanged(meeting_phase(p)),
    }
}
