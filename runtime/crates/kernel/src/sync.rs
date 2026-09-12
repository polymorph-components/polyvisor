//! The sync half of the kernel: bringing the engine and the endpoint up,
//! dialing peers by endpoint id, and the peer list `sync.peers` reports.
//!
//! Who may connect is the device group, and nothing else: `sync.connect`
//! refuses an endpoint id that is not a member's, and an accepted subduction
//! connection is disconnected the moment the handshake names a peer outside
//! the group (internal.wit `sync`, `pairing`). The engine's storage policy is
//! the same rule applied one layer down.
//!
//! The endpoint serves two wires, so the accept loop routes by ALPN:
//! `polyvisor/subduction/0` is sync, `polyvisor/pairing/0` is the enrollment
//! ceremony and is answered only while this device is showing a code.

use std::rc::{Rc, Weak};

use futures::future::LocalBoxFuture;
use polyvisor_engine::{
    DynTransport, EngineClock, EngineEvent, EngineNotify, LocalFuture, PeerId, Spawner,
    VerifyingKey,
};
use subduction_protocol::event::Direction;

use crate::{
    Clock, EngineTransport, Error, ErrorCode, Kernel, MEETING_ALPN, NetHandle, PAIRING_ALPN,
    SUBDUCTION_ALPN, State, SyncEngine,
};

/// `polyvisor:internal/sync.member`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub endpoint_id: String,
    /// User voice; the petname the device was kept under, or "".
    pub petname: String,
    /// Epoch milliseconds.
    pub enrolled: u64,
    /// This device.
    pub me: bool,
}

/// `polyvisor:internal/sync.peer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub endpoint_id: String,
    /// Framework voice: "connecting", "connected", "closed: <why>".
    pub state: String,
}

/// How a peer's connection is going. Framework voice lives in
/// [`PeerState::describe`], so the strings the visor renders are written once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerState {
    Connecting,
    Connected,
    Closed(String),
}

impl PeerState {
    fn describe(&self) -> String {
        match self {
            PeerState::Connecting => "connecting".to_string(),
            PeerState::Connected => "connected".to_string(),
            PeerState::Closed(why) => format!("closed: {why}"),
        }
    }
}

/// One row of what `sync.peers` reports, kept per peer endpoint id.
#[derive(Debug, Clone)]
pub struct PeerRecord {
    pub endpoint_id: String,
    /// The Ed25519 key that endpoint id spells. Kept because the engine
    /// reports a closed connection by `PeerId`, which is that key, and the
    /// row the visor reads is keyed by the id — see [`Kernel::close_peer`].
    pub key: [u8; 32],
    pub state: PeerState,
}

/// The kernel's [`Clock`] seam presented as the engine's.
pub struct ClockSeam(pub Rc<dyn Clock>);

impl EngineClock for ClockSeam {
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }

    fn sleep(&self, ms: u64) -> LocalFuture<'_, ()> {
        self.0.sleep(ms)
    }
}

impl Kernel {
    /// Build the engine from the checkpointed state and spawn its driver, its
    /// event pump, and the task that binds the endpoint.
    ///
    /// Called at open — a fresh or rests-open boot, or an `unseal` — because
    /// all of it needs the seed, which is sealed. Idempotent: a second call
    /// finds an engine already there and does nothing.
    ///
    /// Synchronous, and that is the point: **nothing on the boot path waits
    /// for the network.** Binding an iroh endpoint means a relay handshake,
    /// which can be slow or never finish at all; awaiting it here froze
    /// `device.status` — and with it the whole visor — behind a relay the
    /// device does not need in order to work alone. So the bind runs on its
    /// own spawned task and the device opens with `endpoint-id = ""`, which
    /// is exactly what internal.wit already promises: `""` "until the
    /// endpoint is bound".
    pub(crate) fn start_sync(self: &Rc<Self>) {
        if self.engine.borrow().is_some() {
            return;
        }
        let (seed, restored) = {
            let mut state = self.state.borrow_mut();
            // Taken, not cloned: the engine is the authority from here on.
            (state.seed, state.engine_state.take())
        };
        // Fresh at every start and deliberately *not* checkpointed: it seeds
        // the node's handshake nonces, and a peer that saw the same nonce
        // before reads the second one as a replay. See `Engine::new`.
        let mut entropy = [0u8; 32];
        self.seams.rng.fill(&mut entropy);

        let spawner: Spawner = {
            let spawn = Rc::clone(&self.seams.spawn);
            Rc::new(move |future: LocalBoxFuture<'static, ()>| spawn.spawn(future))
        };
        let (engine, driver) = SyncEngine::new(
            seed,
            entropy,
            Rc::new(ClockSeam(Rc::clone(&self.seams.clock))),
            Rc::clone(&spawner),
            restored,
        );
        let engine = Rc::new(engine);
        self.seams.spawn.spawn(Box::pin(driver));

        // The pump carries everything that happens with no export call in
        // flight: a remote change to write down, and a peer that went away.
        let pump = {
            let engine = Rc::clone(&engine);
            let weak = Rc::downgrade(self);
            let notify: EngineNotify = Rc::new(move |event| {
                let weak = weak.clone();
                Box::pin(async move {
                    let Some(kernel) = weak.upgrade() else {
                        return;
                    };
                    match event {
                        // A checkpoint that fails here has no caller to tell.
                        // The next mutation checkpoints again, over the same
                        // pointed generation.
                        EngineEvent::Changed => {
                            let _written = kernel.checkpoint().await;
                            // A keyhive event can unlock an app envelope that
                            // arrived earlier, so the reporting tree alone is
                            // insufficient. Re-read snapshots; task watches
                            // compare revisions and the visor compares fields.
                            let apps: Vec<String> =
                                kernel.sessions.borrow().values().cloned().collect();
                            for app in apps {
                                kernel.wake_tasks(&app);
                            }
                            let _ = kernel.refresh_personalization().await;
                            kernel.push_event(crate::Event::PersonalizationChanged);
                            // Engine events do not identify the changed
                            // partition; harmlessly prompt both authoritative
                            // readers rather than miss a remote contacts edit.
                            kernel.push_event(crate::Event::ContactsChanged);
                        }
                        EngineEvent::PeerClosed(peer) => kernel.close_peer(peer),
                    }
                })
            });
            async move { engine.pump_events(notify).await }
        };
        self.seams.spawn.spawn(Box::pin(pump));
        *self.engine.borrow_mut() = Some(engine);

        self.seams
            .spawn
            .spawn(Box::pin(bind_endpoint(Rc::clone(self), seed)));
    }

    /// `sync.connect`: dial a member by its endpoint id.
    ///
    /// A non-member is refused before anything is dialed. That is not
    /// belt-and-braces over the post-handshake check: dialing a stranger at
    /// all would announce this device to it, and the group is the whole of
    /// who this device talks to (internal.wit `sync.connect`).
    pub async fn sync_connect(&self, endpoint_id: String) -> Result<(), Error> {
        self.open()?;
        let endpoint_id = endpoint_id.trim().to_string();
        let endpoint = match self.endpoint.borrow().clone() {
            Some(endpoint) => endpoint,
            // The bind is a spawned task, so "no endpoint" is two different
            // answers: still working on it, or it failed and said why.
            None => {
                return Err(Error::new(
                    ErrorCode::Unavailable,
                    match self.bind_error.borrow().as_ref() {
                        Some(why) => format!("this device has no endpoint: {why}"),
                        None => "this device is still binding its endpoint; \
                                 try again in a moment"
                            .to_string(),
                    },
                ));
            }
        };
        let engine = self.engine()?;
        if !self.is_member_id(&endpoint_id).await? {
            return Err(Error::new(
                ErrorCode::Refused,
                "that device is not a member of this device's group",
            ));
        }

        let (key, transport) = match endpoint
            .connect(endpoint_id.clone(), SUBDUCTION_ALPN.to_string())
            .await
        {
            Ok(dialed) => dialed,
            Err(why) => {
                // No row: nothing was ever reached, so there is no peer to
                // report a state for. The caller gets the reason.
                return Err(Error::new(ErrorCode::Unavailable, why));
            }
        };
        self.note_peer(&endpoint_id, key, PeerState::Connecting);
        // The dialed peer is pinned: subduction requires an outbound
        // connection to name its audience, and a dial that reached a
        // different key than the endpoint id promised must fail the
        // handshake rather than sync with whoever answered.
        let Ok(expected) = VerifyingKey::from_bytes(&key) else {
            let why = "that endpoint id is not a valid device key".to_string();
            self.note_peer(&endpoint_id, key, PeerState::Closed(why.clone()));
            return Err(Error::new(ErrorCode::Refused, why));
        };
        match engine
            .connect(
                DynTransport::new(transport),
                Direction::Outbound,
                Some(expected),
            )
            .await
        {
            Ok(_peer) => {
                // No identity check needed here that the handshake did not
                // already do: the audience was pinned to `expected` above, so
                // a peer that authenticated as anyone else never got this
                // far.
                self.note_peer(&endpoint_id, key, PeerState::Connected);
                Ok(())
            }
            Err(why) => {
                self.note_peer(&endpoint_id, key, PeerState::Closed(why.clone()));
                Err(Error::new(ErrorCode::Failed, why))
            }
        }
    }

    /// `sync.peers`.
    pub fn sync_peers(&self) -> Result<Vec<Peer>, Error> {
        self.open()?;
        Ok(self
            .peers
            .borrow()
            .iter()
            .map(|record| Peer {
                endpoint_id: record.endpoint_id.clone(),
                state: record.state.describe(),
            })
            .collect())
    }

    /// `sync.members`: the device group, this device included.
    pub async fn sync_members(&self) -> Result<Vec<Member>, Error> {
        self.open()?;
        let engine = self.engine()?;
        let me = engine.verifying_key().to_bytes();
        let members = engine
            .members()
            .await
            .map_err(|why| Error::new(ErrorCode::Failed, why))?;
        let mine = self
            .state
            .borrow()
            .device
            .as_ref()
            .map(|d| d.name.clone())
            .unwrap_or_default();
        Ok(members
            .into_iter()
            .map(|member| {
                let is_me = member.key == me;
                Member {
                    endpoint_id: self.seams.net.endpoint_id(member.key),
                    // This device's own row is named from the index, not from
                    // the document: the petname is what the user last kept
                    // this device under, and it changes without the group
                    // being rewritten. Every other row is whatever the device
                    // that enrolled it wrote.
                    petname: if is_me { mine.clone() } else { member.petname },
                    enrolled: member.enrolled,
                    me: is_me,
                }
            })
            .collect())
    }

    /// Whether `endpoint_id` spells a member's key.
    ///
    /// Compared in the id spelling rather than by decoding it: decoding is
    /// the endpoint component's, and the kernel deliberately never learns
    /// z-base-32 (see [`crate::Net::endpoint_id`]).
    async fn is_member_id(&self, endpoint_id: &str) -> Result<bool, Error> {
        Ok(self
            .sync_members()
            .await?
            .iter()
            .any(|member| member.endpoint_id == endpoint_id))
    }

    /// Whether `key` is in the group. The post-handshake check's half: the
    /// handshake proves a key, so this is the comparison that decides whether
    /// a connection may live.
    pub(crate) async fn is_member_key(&self, key: [u8; 32]) -> bool {
        let Ok(engine) = self.engine() else {
            return false;
        };
        engine
            .members()
            .await
            .map(|members| members.iter().any(|member| member.key == key))
            .unwrap_or(false)
    }

    /// This device's endpoint id, or `""` while sealed or unbound.
    pub(crate) fn endpoint_id(&self) -> String {
        if self.state() == State::Sealed {
            return String::new();
        }
        self.endpoint_id.borrow().clone()
    }

    /// The engine, or the reason there is none.
    pub(crate) fn engine(&self) -> Result<Rc<SyncEngine>, Error> {
        self.engine.borrow().clone().ok_or_else(|| {
            Error::new(
                ErrorCode::Unavailable,
                "this device's sync engine is not running",
            )
        })
    }

    /// Record a peer's state, keyed by endpoint id: one row per peer, in the
    /// order they were first seen.
    fn note_peer(&self, endpoint_id: &str, key: [u8; 32], state: PeerState) {
        let mut peers = self.peers.borrow_mut();
        match peers.iter_mut().find(|p| p.endpoint_id == endpoint_id) {
            Some(existing) => existing.state = state,
            None => peers.push(PeerRecord {
                endpoint_id: endpoint_id.to_string(),
                key,
                state,
            }),
        }
    }

    /// A connection died; close whichever row it belonged to.
    ///
    /// The engine names the peer by its `PeerId`, which *is* the Ed25519 key
    /// the endpoint id spells, so the row is found by key. A connection that
    /// died before authenticating names nobody, and there is no row to close:
    /// whatever `sync.connect` recorded already says how that attempt ended.
    pub(crate) fn close_peer(&self, peer: Option<PeerId>) {
        let Some(peer) = peer else {
            return;
        };
        for record in self.peers.borrow_mut().iter_mut() {
            // A row that already says why it closed keeps its reason. This
            // one is the generic follow-on — the engine reports every
            // connection closed, including the ones this kernel dropped on
            // purpose — and "the peer went away" over "not a member of this
            // device's group" would lose the only answer the user can act on.
            if matches!(record.state, PeerState::Closed(_)) {
                continue;
            }
            if &record.key == peer.as_bytes() {
                record.state = PeerState::Closed("the peer went away".to_string());
            }
        }
    }
}

/// Bind the device's endpoint and, once it is up, start accepting on it.
///
/// A bind that fails is not a device that failed: it works alone, and every
/// later `sync.connect` says why it cannot dial (see [`Kernel::sync_connect`]).
/// There is no retry, because the reason a relay handshake fails is rarely
/// transient within one worker's life; a reload binds again.
async fn bind_endpoint(kernel: Rc<Kernel>, seed: [u8; 32]) {
    // A strong reference, not a `Weak`: the bind future borrows the seams the
    // kernel owns, so the kernel has to outlive it. That keeps a kernel whose
    // bind never resolves alive for the worker's lifetime — which is what the
    // driver and event-pump tasks do anyway, and a worker outliving its one
    // device is not a thing that happens.
    let bound = kernel.seams.net.bind(seed).await;
    match bound {
        Ok((endpoint_id, handle)) => {
            let handle: Rc<dyn NetHandle> = Rc::from(handle);
            *kernel.endpoint_id.borrow_mut() = endpoint_id;
            *kernel.endpoint.borrow_mut() = Some(Rc::clone(&handle));
            kernel
                .seams
                .spawn
                .spawn(Box::pin(accept_loop(Rc::downgrade(&kernel), handle)));
            // The group is the address book: a device that comes up dials
            // every other device of its user, best effort. Errors are not
            // fatal and not announced beyond the peer row `sync_connect`
            // already closes — a device that is not on right now is the
            // ordinary case.
            kernel
                .seams
                .spawn
                .spawn(Box::pin(reconnect(Rc::clone(&kernel))));
        }
        Err(why) => *kernel.bind_error.borrow_mut() = Some(why),
    }
}

/// Hand every inbound connection to the engine until the endpoint is gone.
///
/// Each handshake runs on its own spawned task and the loop goes straight
/// back to `accept`. Awaiting the handshake here would serialise them: one
/// peer whose handshake stalls would hold every other dialer in the
/// endpoint's backlog, which is exactly the failure a relay hiccup produces.
///
/// An accept error is terminal: the endpoint answered that it will not accept
/// again, and a loop that retried would spin. Connections already up are
/// unaffected — they are their own transports.
async fn accept_loop(kernel: Weak<Kernel>, endpoint: Rc<dyn NetHandle>) {
    loop {
        let accepted = endpoint.accept().await;
        let Some(kernel) = kernel.upgrade() else {
            return;
        };
        let Ok((endpoint_id, key, alpn, transport)) = accepted else {
            return;
        };
        match alpn.as_str() {
            SUBDUCTION_ALPN => {
                kernel.note_peer(&endpoint_id, key, PeerState::Connecting);
                kernel.seams.spawn.spawn(Box::pin(admit(
                    Rc::clone(&kernel),
                    endpoint_id,
                    key,
                    transport,
                )));
            }
            // Pairing is answered only while this device is showing a code,
            // and never becomes a peer row: a pairing connection is not a
            // sync connection and the device on it is not (yet) a member.
            PAIRING_ALPN => {
                if kernel.pairing_offering() {
                    let spawn = Rc::clone(&kernel.seams.spawn);
                    spawn.spawn(Box::pin(async move {
                        kernel.pairing_join(endpoint_id, key, transport).await;
                    }));
                } else {
                    kernel
                        .seams
                        .spawn
                        .spawn(Box::pin(async move { transport.close().await }));
                }
            }
            MEETING_ALPN => {
                // Admission remains inside the meeting state machine; this
                // read also keeps the offer predicate available to routing
                // diagnostics without changing that unconditional handoff.
                let _offering = kernel.meeting_offering();
                let spawn = Rc::clone(&kernel.seams.spawn);
                spawn.spawn(Box::pin(async move {
                    kernel.meeting_accept(endpoint_id, key, transport).await;
                }));
            }
            // An ALPN this device never advertised. The endpoint should not
            // deliver one; if something does, it is not a wire we speak.
            _ => kernel
                .seams
                .spawn
                .spawn(Box::pin(async move { transport.close().await })),
        }
    }
}

/// Run one inbound handshake and record how it went.
///
/// An inbound connection cannot pin its audience — it learns who dialed it
/// from the handshake — so the check the outbound path gets for free happens
/// here instead: the peer subduction authenticated must be the key the
/// endpoint id spelled. A mismatch is a connection that arrived claiming one
/// endpoint and proved another, and it is dropped rather than synced with.
async fn admit(
    kernel: Rc<Kernel>,
    endpoint_id: String,
    key: [u8; 32],
    transport: Box<dyn EngineTransport>,
) {
    let Ok(engine) = kernel.engine() else {
        return;
    };
    let state = match engine
        .connect(DynTransport::new(transport), Direction::Inbound, None)
        .await
    {
        Ok(peer) if peer.as_bytes() == &key => {
            // The group gate, and it is here rather than before the
            // handshake because the handshake is what *proves* the key. A
            // device that is not one of this user's syncs nothing: it is
            // disconnected with the reason the visor shows.
            if kernel.is_member_key(key).await {
                PeerState::Connected
            } else {
                engine.disconnect(peer).await;
                PeerState::Closed("not a member of this device's group".to_string())
            }
        }
        Ok(peer) => {
            engine.disconnect(peer).await;
            PeerState::Closed("it authenticated as a different device".to_string())
        }
        Err(why) => PeerState::Closed(why),
    };
    kernel.note_peer(&endpoint_id, key, state);
}

/// Dial every member but this device, once, at bind.
async fn reconnect(kernel: Rc<Kernel>) {
    let Ok(members) = kernel.sync_members().await else {
        return;
    };
    for member in members {
        if member.me {
            continue;
        }
        // The failure is already recorded as that peer's row state, and a
        // device that is not on right now is the ordinary case.
        let _dialed = kernel.sync_connect(member.endpoint_id).await;
    }
}
