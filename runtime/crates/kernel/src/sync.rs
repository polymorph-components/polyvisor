//! The sync half of the kernel: bringing the engine and the endpoint up,
//! dialing peers by endpoint id, and the peer list `sync.peers` reports.
//!
//! internal.wit `sync`: "Pairing (who may connect, what they may read) is the
//! next milestone; for now a dialed peer is trusted with everything, and the
//! visor says so." So there is no gate here — every accepted connection is
//! handed straight to the engine, whose policy is allow-all until M3b.

use std::rc::{Rc, Weak};

use futures::future::LocalBoxFuture;
use polyvisor_engine::{
    DynTransport, EngineClock, EngineEvent, EngineNotify, LocalFuture, PeerId, Spawner,
    VerifyingKey,
};
use subduction_protocol::event::Direction;

use crate::{Clock, EngineTransport, Error, ErrorCode, Kernel, NetHandle, State, SyncEngine};

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

        let spawner: Spawner = {
            let spawn = Rc::clone(&self.seams.spawn);
            Rc::new(move |future: LocalBoxFuture<'static, ()>| spawn.spawn(future))
        };
        let (engine, driver) = SyncEngine::new(
            seed,
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

    /// `sync.connect`: dial a device by its endpoint id.
    pub async fn sync_connect(&self, endpoint_id: String) -> Result<(), Error> {
        self.open()?;
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

        let (key, transport) = match endpoint.connect(endpoint_id.clone()).await {
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
        let Ok((endpoint_id, key, transport)) = accepted else {
            return;
        };
        kernel.note_peer(&endpoint_id, key, PeerState::Connecting);
        kernel.seams.spawn.spawn(Box::pin(admit(
            Rc::clone(&kernel),
            endpoint_id,
            key,
            transport,
        )));
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
        Ok(peer) if peer.as_bytes() == &key => PeerState::Connected,
        Ok(peer) => {
            engine.disconnect(peer).await;
            PeerState::Closed("it authenticated as a different device".to_string())
        }
        Err(why) => PeerState::Closed(why),
    };
    kernel.note_peer(&endpoint_id, key, state);
}
