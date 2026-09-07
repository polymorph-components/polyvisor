//! The polyvisor sync engine: an automerge task document per app, carried by
//! [`subduction_protocol`]'s sans-IO node through [`subduction_runtime`]'s
//! capability traits (docs/design.md "Sync engine: subduction sans-IO").
//!
//! No WIT and no wasm dependency: the engine reaches the world through
//! [`EngineTransport`], [`EngineClock`] and a spawn callback, so the whole of
//! it runs natively on a `LocalPool` in tests and inside the runtime
//! component in production.
//!
//! Single-threaded by construction (one SharedWorker per device): nothing
//! here is `Send`, every trait future is `Local`, and shared state is
//! `RefCell`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

mod clock;
mod doc;
mod document;
mod policy;
mod storage;
mod transport;
mod us;

pub use clock::EngineClock;
pub use doc::{TaskSnapshot, TodoItem};
pub use ed25519_dalek::VerifyingKey;
pub use storage::Snapshot;
pub use subduction_protocol::peer_id::PeerId;
pub use transport::{DynTransport, EngineTransport};
pub use us::{Member, us_tree};

use clock::ClockAdapter;
use doc::AppDoc;
use policy::{GroupPolicy, Members};
use storage::SnapshotStorage;
use us::UsDoc;

use ed25519_dalek::SigningKey;
use future_form::Local;
use futures::future::LocalBoxFuture;
use sedimentree_core::id::SedimentreeId;
use sha2::{Digest as _, Sha256};
use subduction_crypto::signer::memory::MemorySigner;
use subduction_protocol::{
    effect::AppEvent, event::Direction, handshake::audience::Audience, node::NodeConfig,
};
use subduction_runtime::{
    driver::{Driver, connection::Connection, handle::Handle},
    transport::Transport,
};

/// A future that borrows its owner and is never sent between threads — the
/// shape every seam in this crate and in the kernel speaks.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// What [`Engine::pump_events`] reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineEvent {
    /// A remote change was applied to a document. The kernel checkpoints.
    Changed,
    /// A connection is gone, with the peer it had authenticated as if it got
    /// that far. The kernel closes that peer's row.
    PeerClosed(Option<PeerId>),
}

/// How [`Engine::pump_events`] reaches its caller. Async because the kernel's
/// answer to `Changed` is a checkpoint, which is IO.
pub type EngineNotify = Rc<dyn Fn(EngineEvent) -> LocalBoxFuture<'static, ()>>;

/// Who spawns the engine's long-lived futures. The runtime component passes
/// `wit_bindgen`'s `spawn_local`; tests pass a `LocalPool` spawner.
///
/// The driver never schedules tasks (subduction_runtime/src/driver.rs:22
/// "Scheduling stays with the caller"), and neither does the engine: it hands
/// each connection's read loop to this callback because it must then await
/// that connection's handshake, which the read loop is what makes progress.
pub type Spawner = Rc<dyn Fn(LocalBoxFuture<'static, ()>)>;

/// The sedimentree every device keeps an app's tasks in.
///
/// Derived from the app id alone, so two devices that dial each other
/// converge with no naming step; M3b replaces this with keyhive partitions.
#[must_use]
pub fn tasks_tree(app: &str) -> SedimentreeId {
    let mut hasher = Sha256::new();
    hasher.update(b"polyvisor:tasks:");
    hasher.update(app.as_bytes());
    SedimentreeId::new(hasher.finalize().into())
}

/// Storage authorization: the device group, as the user-system document
/// records it (see [`policy::GroupPolicy`]).
type Policy = GroupPolicy;

/// One device's sync engine.
///
/// Generic in the transport so tests can drive it over
/// `subduction_runtime::memory::transport::MemoryTransport` directly; the
/// kernel instantiates it at [`DynTransport`], the object-safe wrapper over
/// [`EngineTransport`].
pub struct Engine<T: Transport<Local> + 'static> {
    seed: [u8; 32],
    /// Only for the enrollment stamp this device writes for itself; the
    /// driver has its own adapter over the same clock.
    clock: Rc<dyn EngineClock>,
    peer: PeerId,
    handle: Handle<T>,
    storage: Rc<SnapshotStorage>,
    spawn: Spawner,
    /// One automerge document per app id, keyed by app id.
    apps: RefCell<BTreeMap<String, AppDoc>>,
    /// The user-system document — this device's group. `None` until it is
    /// opened, which [`Engine::open_us`] does on the first touch and on
    /// every `connect`.
    us: RefCell<Option<UsDoc>>,
    /// The member keys, mirrored out of the user-system document so the
    /// policy can read them without borrowing it.
    members: Members,
    /// Every live authenticated connection, so a tree first touched after a
    /// peer was dialed still gets subscribed on it. Entries are removed when
    /// the driver reports the connection closed (see [`Engine::pump_events`]).
    conns: RefCell<Vec<Connection<T>>>,
    /// Restored-but-not-yet-hydrated state. `Engine::new` cannot talk to its
    /// own driver — the caller has not spawned it yet — so a restored
    /// snapshot's trees are handed to the driver on the first async call.
    pending_hydration: RefCell<Option<Vec<SedimentreeId>>>,
}

impl<T: Transport<Local> + 'static> Engine<T> {
    /// Build an engine and the driver future the caller must spawn.
    ///
    /// `storage_state` restores a snapshot taken by [`Engine::snapshot`]; its
    /// seed is ignored in favour of `seed`, which is the kernel's record.
    /// `entropy` is 32 bytes drawn fresh at every start, and it must be
    /// fresh: it seeds the node's handshake nonces, and subduction's peers
    /// keep a nonce cache that reads a repeat as a replay. A device whose
    /// node entropy came from its (stable) signing seed alone therefore
    /// produced the *same* first handshake nonce after every reboot, and the
    /// peer it had talked to before rejected its first reconnect.
    pub fn new(
        seed: [u8; 32],
        entropy: [u8; 32],
        clock: Rc<dyn EngineClock>,
        spawn: Spawner,
        storage_state: Option<Snapshot>,
    ) -> (Engine<T>, impl Future<Output = ()> + 'static)
    where
        T: 'static,
    {
        let signing_key = SigningKey::from_bytes(&seed);
        let peer = PeerId::from(signing_key.verifying_key());
        let storage = Rc::new(SnapshotStorage::default());

        let mut apps = BTreeMap::new();
        let mut hydrate = Vec::new();
        let mut us: Option<UsDoc> = None;
        if let Some(state) = storage_state {
            for app in state.apps {
                let tree = tasks_tree(&app.app);
                storage.restore(tree, app.state.commits, app.state.fragments);
                hydrate.push(tree);
                let mut doc = AppDoc::restore(&app.app, tree, &app.state.doc, seed);
                // The document and its tree are checkpointed together, but a
                // crash between a commit landing in storage and the document
                // being saved leaves the tree ahead; absorb closes that gap.
                let _absorbed = doc.absorb(&storage);
                let _replaced = apps.insert(app.app.clone(), doc);
            }
            if let Some(state) = state.us {
                let tree = us_tree();
                storage.restore(tree, state.commits, state.fragments);
                hydrate.push(tree);
                let mut doc = UsDoc::load(&state.doc, seed);
                let _absorbed = doc.absorb(&storage);
                us = Some(doc);
            }
        }
        // The policy reads this on every remote storage operation, so it is
        // populated before the driver exists rather than after: a restored
        // device is in its group from its first turn.
        let members: Members = Rc::new(RefCell::new(
            us.as_ref()
                .map(|doc| doc.members().into_iter().map(|m| m.key).collect())
                .unwrap_or_default(),
        ));

        let (driver, handle) = Driver::new(
            // The node's entropy is its own — fingerprint seeds for set
            // reconciliation, and the handshake nonces — so it is neither
            // the signing seed (domain separation costs one hash) nor a
            // function of it alone (see the `entropy` parameter).
            NodeConfig::new(peer, mix(b"polyvisor:node-entropy", &seed, &entropy)),
            ClockAdapter::new(Rc::clone(&clock)),
            MemorySigner::from_bytes(&seed),
            Rc::clone(&storage),
            Policy::new(Rc::clone(&members)),
        );

        let engine = Engine {
            seed,
            clock,
            peer,
            handle,
            storage,
            spawn,
            apps: RefCell::new(apps),
            us: RefCell::new(us),
            members,
            conns: RefCell::new(Vec::new()),
            pending_hydration: RefCell::new((!hydrate.is_empty()).then_some(hydrate)),
        };
        (engine, driver.run())
    }

    /// This device's subduction peer id — its Ed25519 verifying key.
    #[must_use]
    pub fn peer_id(&self) -> PeerId {
        self.peer
    }

    /// This device's verifying key, for a caller that wants to pin it as the
    /// expected peer of an outbound dial.
    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        SigningKey::from_bytes(&self.seed).verifying_key()
    }

    // -- tasks ---------------------------------------------------------------

    /// The app's tasks in stable order, with the document's revision.
    pub async fn tasks_items(&self, app: &str) -> Result<TaskSnapshot, String> {
        self.open_app(app).await?;
        self.with_app(app, |doc| Ok(doc.snapshot()))
    }

    /// The app document's revision: the number of changes in its history, so
    /// it advances on a remote change exactly as it does on a local one.
    pub async fn tasks_revision(&self, app: &str) -> Result<u64, String> {
        self.open_app(app).await?;
        self.with_app(app, |doc| Ok(doc.revision()))
    }

    /// Append a task, returning the id the document gave it.
    pub async fn tasks_add(&self, app: &str, title: String) -> Result<String, String> {
        self.mutate(app, move |doc| doc.add(title)).await
    }

    pub async fn tasks_set_completed(
        &self,
        app: &str,
        id: &str,
        completed: bool,
    ) -> Result<(), String> {
        let id = id.to_string();
        self.mutate(app, move |doc| doc.set_completed(&id, completed))
            .await
    }

    pub async fn tasks_set_title(&self, app: &str, id: &str, title: String) -> Result<(), String> {
        let id = id.to_string();
        self.mutate(app, move |doc| doc.set_title(&id, title)).await
    }

    pub async fn tasks_remove(&self, app: &str, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.mutate(app, move |doc| doc.remove(&id)).await
    }

    // -- the user-system document --------------------------------------------

    /// This device's group, oldest enrollment first.
    pub async fn members(&self) -> Result<Vec<Member>, String> {
        self.open_us().await?;
        Ok(self.with_us(UsDoc::members))
    }

    /// Write a member into the group. The adder's half of enrollment;
    /// idempotent on the key.
    pub async fn add_member(
        &self,
        key: [u8; 32],
        petname: String,
        enrolled: u64,
    ) -> Result<(), String> {
        self.us_mutate(move |doc| doc.add_member(key, petname, enrolled))
            .await
    }

    /// The user-system document's bytes, for the adder to put in ENROLL.
    pub async fn us_save(&self) -> Result<Vec<u8>, String> {
        self.open_us().await?;
        Ok(self.with_us(UsDoc::save))
    }

    /// **Replace** this device's user-system document with the one an adder
    /// enrolled it into.
    ///
    /// Not a merge. A device that has never paired is its own group of one,
    /// and that group is not a party to anything: the adder wrote this
    /// device's membership into *its* document, and that document is now the
    /// whole truth. Merging instead would keep the joiner's group-of-one
    /// entry alive as a second `members` object (see `crate::us`) and hand
    /// the group a member nobody enrolled.
    ///
    /// So the local tree goes with the local document: the group-of-one's
    /// commits are removed from the driver and from storage before the new
    /// document takes its place. Left behind they would be absorbed straight
    /// back in on the next turn — and pushed to the group on the first sync.
    pub async fn adopt_us(&self, bytes: &[u8], adder: [u8; 32]) -> Result<(), String> {
        self.hydrate().await?;
        // Parsed and checked *before* a byte of local state is touched: a
        // document that does not open, or that does not hold both this
        // device and the one that sent it, leaves this device exactly as it
        // was — its own group of one, still able to try again.
        let adopted = UsDoc::adopt(bytes, self.seed, self.verifying_key().to_bytes(), adder)?;
        let tree = us_tree();
        self.handle
            .remove_tree(tree)
            .await
            .map_err(|e| e.to_string())?;
        // The durability barrier `mutate` uses: `remove_tree` only queues a
        // command, and the deletion must have run before the new document's
        // items can arrive — otherwise the driver's delete lands on top of
        // them.
        let _heads = self
            .handle
            .tree_heads(tree)
            .await
            .map_err(|e| e.to_string())?;
        self.storage.forget_tree(tree);

        *self.us.borrow_mut() = Some(adopted);
        self.refresh_members();

        // Resubscribe: `remove_tree` took the tree out of the driver's
        // residency, and this device now wants every commit behind the
        // document it just adopted.
        let conns: Vec<_> = self.conns.borrow().clone();
        for conn in conns {
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // -- connections ---------------------------------------------------------

    /// Register `transport` as a connection, wait for the handshake, and
    /// subscribe to every tree this device knows.
    ///
    /// `expected_peer` pins who we believe we are dialing; an outbound dial
    /// without one is accepted by the protocol as an unpinned audience, which
    /// is what an inbound connection always is.
    pub async fn connect(
        &self,
        transport: T,
        direction: Direction,
        expected_peer: Option<VerifyingKey>,
    ) -> Result<PeerId, String> {
        self.hydrate().await?;
        // Before `trees()`: the group is the one document every device of a
        // user syncs unconditionally, so a connection subscribes to it even
        // on a device whose apps have never been opened.
        self.open_us().await?;
        let audience = expected_peer.map(|key| Audience::known(PeerId::from(key)));
        let (pending, read_loop) = self
            .handle
            .connect::<Local>(transport, direction, audience)
            .await
            .map_err(|e| e.to_string())?;
        // Before `authenticated()`: the handshake only completes because the
        // read loop is feeding the driver.
        (self.spawn)(Box::pin(read_loop));
        let conn = pending.authenticated().await.map_err(|e| e.to_string())?;

        for tree in self.trees() {
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        let peer = conn.peer();
        self.conns.borrow_mut().push(conn);
        Ok(peer)
    }

    /// Drain the driver's app events forever, applying every remote change to
    /// the matching automerge document and telling the caller what happened.
    /// The caller spawns this.
    ///
    /// This is the engine's only unprompted voice: everything it reports here
    /// happens with no export call in flight, so nothing else would write it
    /// down. The kernel checkpoints on [`EngineEvent::Changed`] and updates
    /// its peer list on [`EngineEvent::PeerClosed`].
    pub async fn pump_events(&self, notify: EngineNotify) {
        loop {
            let Ok(event) = self.handle.next_app_event().await else {
                return; // the driver stopped; so does the pump.
            };
            match event {
                // `TreeUpdated` is the durability report for remote data, and
                // `SyncFinished` closes a batch that may have ingested some;
                // neither carries the items, so the engine reads them back
                // out of its own storage
                // (subduction_protocol/src/effect.rs:93).
                AppEvent::TreeUpdated { tree, .. } | AppEvent::SyncFinished { tree, .. } => {
                    if self.absorb(tree) {
                        notify(EngineEvent::Changed).await;
                    }
                }
                // The connection registry is the engine's, so this is where
                // it shrinks: without it a dead peer's `Connection` would sit
                // in `conns` forever, and every later `open_app` would try to
                // subscribe a tree on it.
                AppEvent::ConnectionClosed { conn, peer } => {
                    self.conns.borrow_mut().retain(|live| live.id() != conn);
                    notify(EngineEvent::PeerClosed(peer)).await;
                }
                _ => continue,
            }
        }
    }

    /// Close every connection to `peer` and forget it.
    ///
    /// The kernel's answer to a peer that authenticated as somebody other
    /// than the endpoint id promised. The driver reports
    /// `ConnectionClosed` in turn, which is what removes the entry — this
    /// only asks.
    pub async fn disconnect(&self, peer: PeerId) {
        let doomed: Vec<Connection<T>> = self
            .conns
            .borrow()
            .iter()
            .filter(|conn| conn.peer() == peer)
            .cloned()
            .collect();
        for conn in doomed {
            conn.disconnect().await;
        }
    }

    // -- checkpointing -------------------------------------------------------

    /// Everything needed to reconstruct this engine: each app's automerge
    /// document, and the sedimentree items backing it.
    ///
    /// Not the seed — the kernel holds that, in the same sealed checkpoint,
    /// and two copies of an identity is one copy too many to keep in step.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let apps = self.apps.borrow();
        let us = self
            .us
            .borrow()
            .as_ref()
            .map(|doc| (doc.tree(), doc.save()));
        self.storage.snapshot(
            apps.iter()
                .map(|(app, doc)| (app.clone(), doc.tree(), doc.save())),
            us,
        )
    }

    // -- internals -----------------------------------------------------------

    /// How many authenticated connections are live. Test introspection for
    /// the registry `pump_events` shrinks.
    #[must_use]
    pub fn live_connections(&self) -> usize {
        self.conns.borrow().len()
    }

    /// Every tree this device holds a document for.
    fn trees(&self) -> Vec<SedimentreeId> {
        let mut trees: Vec<SedimentreeId> = self.apps.borrow().values().map(AppDoc::tree).collect();
        if self.us.borrow().is_some() {
            trees.push(us_tree());
        }
        trees
    }

    /// Make sure this device holds a user-system document, and that every
    /// live peer is subscribed to its tree. The `open_app` shape, for the
    /// one document that is not per-app.
    async fn open_us(&self) -> Result<(), String> {
        self.hydrate().await?;
        if self.us.borrow().is_some() {
            return Ok(());
        }
        let tree = us_tree();
        {
            let mut doc = UsDoc::empty(self.seed);
            let _absorbed = doc.absorb(&self.storage);
            *self.us.borrow_mut() = Some(doc);
        }
        self.refresh_members();
        let conns: Vec<_> = self.conns.borrow().clone();
        for conn in conns {
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }

        // A device is in its own group, and that holds from the moment the
        // document exists rather than from whenever some other task got a
        // turn. Every path to the document comes through here, so there is
        // no window in which this device's own membership check — or a
        // peer's — reads a group of nobody.
        //
        // The petname is empty and stays the kernel's to fill in for its own
        // row: it changes when the user renames the device, and a value
        // copied in here would be the one it had at first boot.
        if self.with_us(|doc| doc.members().is_empty()) {
            let key = self.verifying_key().to_bytes();
            let enrolled = self.clock.now_ms();
            let commit = {
                let mut cell = self.us.borrow_mut();
                let doc = cell
                    .as_mut()
                    .ok_or_else(|| "this device has no group document".to_string())?;
                doc.add_member(key, String::new(), enrolled)?;
                doc.last_local_commit()
            };
            self.refresh_members();
            self.push_us_commit(commit).await?;
        }
        Ok(())
    }

    /// Carry a user-system change into its tree, and wait for the driver to
    /// have persisted it (the barrier [`Engine::mutate`] documents).
    async fn push_us_commit(
        &self,
        commit: Option<subduction_protocol::command::NewCommit>,
    ) -> Result<(), String> {
        let Some(commit) = commit else {
            return Ok(());
        };
        self.handle
            .add_commits(us_tree(), vec![commit])
            .await
            .map_err(|e| e.to_string())?;
        let _heads = self
            .handle
            .tree_heads(us_tree())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read the user-system document. Empty-document defaults rather than an
    /// error: every caller runs [`Engine::open_us`] first, and a `None` here
    /// would mean a re-entrant call caught the cell mid-replacement.
    fn with_us<R: Default>(&self, f: impl FnOnce(&UsDoc) -> R) -> R {
        self.us.borrow().as_ref().map(f).unwrap_or_default()
    }

    /// Run `change` against the user-system document and carry the resulting
    /// automerge change into its tree. [`Engine::mutate`]'s twin; the two do
    /// not share code because the app path is keyed by app id and this one
    /// has exactly one document.
    async fn us_mutate<R>(
        &self,
        change: impl FnOnce(&mut UsDoc) -> Result<R, String>,
    ) -> Result<R, String> {
        self.open_us().await?;
        let (answer, commit) = {
            let mut cell = self.us.borrow_mut();
            let doc = cell
                .as_mut()
                .ok_or_else(|| "this device has no group document".to_string())?;
            let answer = change(doc)?;
            (answer, doc.last_local_commit())
        };
        self.refresh_members();
        self.push_us_commit(commit).await?;
        Ok(answer)
    }

    /// Mirror the document's members into the set the policy reads.
    fn refresh_members(&self) {
        let keys = self.with_us(|doc| doc.members().into_iter().map(|m| m.key).collect());
        *self.members.borrow_mut() = keys;
    }

    /// Hand a restored snapshot's trees to the driver, once. Idempotent: the
    /// pending list is taken before the first await, so a re-entrant call
    /// finds nothing to do rather than hydrating twice.
    async fn hydrate(&self) -> Result<(), String> {
        let Some(trees) = self.pending_hydration.borrow_mut().take() else {
            return Ok(());
        };
        for tree in trees {
            let (commits, fragments) = self.storage.metadata(tree);
            self.handle
                .hydrate_tree(tree, commits, fragments)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Run `change` against the app's document, carry the resulting automerge
    /// change into the tree as one sedimentree commit, and subscribe every
    /// live connection to the tree in case this call created it.
    async fn mutate<R>(
        &self,
        app: &str,
        change: impl FnOnce(&mut AppDoc) -> Result<R, String>,
    ) -> Result<R, String> {
        self.open_app(app).await?;
        let (answer, tree, commit) = self.with_app(app, |doc| {
            let answer = change(doc)?;
            Ok((answer, doc.tree(), doc.last_local_commit()))
        })?;
        if let Some(commit) = commit {
            self.handle
                .add_commits(tree, vec![commit])
                .await
                .map_err(|e| e.to_string())?;
            // A durability barrier, and the reason the kernel may checkpoint
            // the moment this returns. `add_commits` only queues a command;
            // the driver signs and persists it inside `drain_effects`, which
            // runs to completion before the driver takes its next input
            // (subduction_runtime/src/driver.rs:241). So a round-trip that
            // the driver answers after this one is proof the commit is in
            // storage — and therefore in the next `snapshot`.
            let _heads = self
                .handle
                .tree_heads(tree)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(answer)
    }

    /// Make sure this device holds a document for `app`, and that every live
    /// peer is syncing and subscribed to its tree.
    ///
    /// A device only learns of an app's tree by holding it: the tree id is
    /// derived from the app id (see [`tasks_tree`]), so opening the app *is*
    /// the discovery step, and both directions of a connection must ask for
    /// the tree before either sees the other's history. Every `tasks_*` call
    /// goes through here, which is why a session opening an app on a device
    /// that has never seen it pulls the other device's list.
    async fn open_app(&self, app: &str) -> Result<(), String> {
        self.hydrate().await?;
        if self.apps.borrow().contains_key(app) {
            return Ok(());
        }
        let tree = tasks_tree(app);
        {
            let mut doc = AppDoc::empty(app, tree, self.seed);
            // The tree may already hold items: a peer pushed them before this
            // device ever opened the app, and the event pump had no document
            // to put them in.
            let _absorbed = doc.absorb(&self.storage);
            let _created = self.apps.borrow_mut().insert(app.to_string(), doc);
        }
        // Cloned out of the cell first: `sync_tree` awaits into the driver,
        // and a borrow held across that await would collide with anything the
        // driver's own progress lets run.
        //
        // The document is in the map before this await, so a second caller
        // for the same app returns from the check above without waiting for
        // the subscription to be placed. That is deliberate: it reads an
        // empty-but-live document a moment early rather than blocking on the
        // network, and callers poll `revision` for what arrives after.
        let conns: Vec<_> = self.conns.borrow().clone();
        for conn in conns {
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Apply every stored-but-unapplied change of `tree` to its document.
    /// Returns whether anything landed.
    fn absorb(&self, tree: SedimentreeId) -> bool {
        if tree == us_tree() {
            let landed = {
                let mut cell = self.us.borrow_mut();
                cell.as_mut().is_some_and(|doc| doc.absorb(&self.storage))
            };
            if landed {
                // A remote change to the group is a change to who may
                // connect at all: the policy's set moves with it.
                self.refresh_members();
            }
            return landed;
        }
        let mut apps = self.apps.borrow_mut();
        let Some(doc) = apps.values_mut().find(|doc| doc.tree() == tree) else {
            // A tree with no local document: this device has never opened
            // that app. The items stay in storage and are applied the moment
            // it does (`AppDoc::restore` on the next boot, or `with_app`).
            return false;
        };
        doc.absorb(&self.storage)
    }

    /// The app's document. Synchronous, and the borrow never crosses an
    /// await.
    ///
    /// Every caller runs [`Engine::open_app`] first, which is what creates the
    /// document *and* subscribes the live peers to its tree. Creating one
    /// here as a fallback would paper over a caller that skipped that, and
    /// hand back a document nothing is syncing.
    fn with_app<R>(
        &self,
        app: &str,
        f: impl FnOnce(&mut AppDoc) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut apps = self.apps.borrow_mut();
        let doc = apps
            .get_mut(app)
            .ok_or_else(|| format!("no document is open for {app}"))?;
        f(doc)
    }
}

/// A domain-separated 32 bytes from the device seed and this run's
/// randomness.
fn mix(domain: &[u8], seed: &[u8; 32], entropy: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(seed);
    hasher.update(entropy);
    hasher.finalize().into()
}
