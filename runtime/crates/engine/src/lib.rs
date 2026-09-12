//! The polyvisor sync engine: encrypted document histories carried by
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

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

mod clock;
mod opaque;
mod policy;
mod storage;
mod transport;
mod us;
mod vault;

pub use clock::EngineClock;
pub use ed25519_dalek::VerifyingKey;
pub use opaque::{OpaqueItem, OpaqueMode, is_opaque_tree};
pub use polyvisor_document_history::Document;
pub use storage::{AppState, Item, ItemKind, OpaqueState, Snapshot, StoreItem, TreeState};
pub use subduction_protocol::peer_id::PeerId;
pub use transport::{DynTransport, EngineTransport};
pub use us::{Member, us_tree};
pub use vault::VaultState;

use clock::ClockAdapter;
use policy::{GroupPolicy, Members};
use polyvisor_document_history::actor;
use storage::SnapshotStorage;
use us::UsDoc;
use vault::Vault;

use ed25519_dalek::SigningKey;
use future_form::Local;
use futures::future::LocalBoxFuture;
use sedimentree_core::{
    blob::{Blob, BlobMeta},
    id::SedimentreeId,
    loose_commit::id::CommitId,
};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlPhase {
    AwaitUs,
    AwaitKeyhive,
    Ready,
}

/// The sedimentree every device keeps a document partition in.
///
/// Derived from the app id alone, so two devices that dial each other
/// converge with no naming step; M3b replaces this with keyhive partitions.
#[must_use]
pub fn document_tree(partition: &str) -> SedimentreeId {
    let digest: [u8; 32] = Sha256::new()
        .chain_update(b"polyvisor:tasks:v2:")
        .chain_update(partition.as_bytes())
        .finalize()
        .into();
    let mut tree = digest;
    // The first byte is a namespace tag, not hash output. Opaque ids use a
    // different tag and therefore cannot alias a document tree.
    tree[0] = 0;
    SedimentreeId::new(tree)
}

/// The tree the group's keyhive operations travel in.
///
/// Keyhive's own membership and CGKA events have to reach the other devices
/// before their envelopes can be opened, and the engine already has exactly
/// one reliable multi-device channel: a sedimentree. So they get a tree of
/// their own — one commit per static event, the commit id being the event's
/// digest, no parents (keyhive's ingest is an unordered, content-addressed
/// merge, not a replay). The events are keyhive-signed already and carry no
/// content, so this tree is the one app-adjacent tree that is *not* enveloped:
/// enveloping the key material with the key material is a circle.
#[must_use]
pub fn keyhive_tree() -> SedimentreeId {
    SedimentreeId::new(Sha256::digest(b"polyvisor:keyhive-events").into())
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
    documents: RefCell<BTreeMap<String, Document>>,
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
    /// This device's keyhive (`crate::vault`). `None` until [`Engine::open_us`]
    /// creates or restores it, on the same first touch that opens the group.
    vault: RefCell<Option<Rc<Vault>>>,
    /// A restored vault's bytes, until the first async call can rebuild it —
    /// `Engine::new` is synchronous and keyhive's constructors are not.
    pending_vault: RefCell<Option<VaultState>>,
    /// The seed the vault's CSPRNG is built from: the device seed mixed with
    /// this boot's entropy.
    vault_rng_seed: [u8; 32],
    /// The group's store-name key (`storage::Snapshot::name_key`). `None`
    /// until the group document is opened, which mints one for a founder and
    /// [`Engine::adopt_us`] replaces for a joiner.
    name_key: RefCell<Option<[u8; 32]>>,
    /// What a founder mints its name key from: the device seed mixed with
    /// this boot's fresh entropy, domain-separated. The engine has no
    /// randomness seam of its own — `entropy` is drawn from the kernel's
    /// `Rng` at every start (see [`Engine::new`]) — and this is that draw,
    /// kept until the group document is first opened.
    name_key_seed: [u8; 32],
    /// This boot's fresh entropy, available to trusted in-process models that
    /// must mint values independently on each device.
    model_entropy: [u8; 32],
    /// Restored-but-not-yet-hydrated state. `Engine::new` cannot talk to its
    /// own driver — the caller has not spawned it yet — so a restored
    /// snapshot's trees are handed to the driver on the first async call.
    pending_hydration: RefCell<Option<Vec<SedimentreeId>>>,
    opaque: opaque::Lifecycle,
    opaque_nonce: RefCell<u64>,
    control_phases: RefCell<BTreeMap<subduction_protocol::id::ConnId, ControlPhase>>,
    control_initiators: RefCell<BTreeSet<subduction_protocol::id::ConnId>>,
    remote_catalogs: RefCell<BTreeMap<subduction_protocol::id::ConnId, Vec<SedimentreeId>>>,
    pending_catalogs: RefCell<BTreeMap<subduction_protocol::id::ConnId, Vec<SedimentreeId>>>,
    catalog_sent: RefCell<BTreeSet<subduction_protocol::id::ConnId>>,
    control_write: futures::lock::Mutex<()>,
    control_revision: Cell<u64>,
    pending_opaque_retire: RefCell<BTreeSet<[u8; 32]>>,
    pending_opaque_subscribe: RefCell<BTreeSet<[u8; 12]>>,
    group_generation: Cell<u64>,
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
        let opaque: opaque::Lifecycle = Rc::new(RefCell::new(Default::default()));
        let storage = Rc::new(SnapshotStorage::new(Rc::clone(&opaque)));

        let mut apps = BTreeMap::new();
        let mut hydrate = Vec::new();
        let mut us: Option<UsDoc> = None;
        let mut pending_vault: Option<VaultState> = None;
        let mut name_key: Option<[u8; 32]> = None;
        if let Some(state) = storage_state {
            name_key = state.name_key;
            for app in state.apps {
                let tree = document_tree(&app.app);
                storage.restore(tree, app.state.commits, app.state.fragments);
                hydrate.push(tree);
                // The document and its tree are checkpointed together, but a
                // crash between a commit landing in storage and the document
                // being saved leaves the tree ahead. Closing that gap is
                // `hydrate`'s job now rather than this one: an app tree's
                // blobs are keyhive envelopes, and opening them is async.
                let doc = Document::load(
                    &app.state.doc,
                    actor(b"polyvisor:actor:", seed, app.app.as_bytes()),
                    tree,
                );
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
            opaque.borrow_mut().registers =
                us.as_ref().map(UsDoc::opaque_registers).unwrap_or_default();
            for state in state.opaque {
                if opaque::status(&opaque, &state.tree) == Some(true) {
                    let tree = SedimentreeId::new(state.tree);
                    storage.restore(tree, state.commits, Vec::new());
                    hydrate.push(tree);
                }
            }
            if let Some(state) = state.keyhive {
                let tree = keyhive_tree();
                storage.restore(tree, state.commits, state.fragments);
                hydrate.push(tree);
            }
            pending_vault = state.vault;
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
            Policy::new(Rc::clone(&members), Rc::clone(&opaque)),
        );

        let engine = Engine {
            seed,
            clock,
            peer,
            handle,
            storage,
            spawn,
            documents: RefCell::new(apps),
            vault: RefCell::new(None),
            pending_vault: RefCell::new(pending_vault),
            vault_rng_seed: mix(b"polyvisor:keyhive-rng", &seed, &entropy),
            us: RefCell::new(us),
            name_key: RefCell::new(name_key),
            name_key_seed: mix(b"polyvisor:name-key", &seed, &entropy),
            model_entropy: entropy,
            members,
            conns: RefCell::new(Vec::new()),
            pending_hydration: RefCell::new((!hydrate.is_empty()).then_some(hydrate)),
            opaque,
            opaque_nonce: RefCell::new(0),
            control_phases: RefCell::new(BTreeMap::new()),
            control_initiators: RefCell::new(BTreeSet::new()),
            remote_catalogs: RefCell::new(BTreeMap::new()),
            pending_catalogs: RefCell::new(BTreeMap::new()),
            catalog_sent: RefCell::new(BTreeSet::new()),
            control_write: futures::lock::Mutex::new(()),
            control_revision: Cell::new(0),
            pending_opaque_retire: RefCell::new(BTreeSet::new()),
            pending_opaque_subscribe: RefCell::new(BTreeSet::new()),
            group_generation: Cell::new(0),
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

    // -- synchronized document histories ------------------------------------

    /// Read the partition's currently applied history. Remote history is
    /// applied asynchronously by the event pump. The closure is synchronous:
    /// its `RefCell` guard is always released before any engine await.
    pub async fn document_read<R>(
        &self,
        partition: &str,
        read: impl FnOnce(&Document) -> R,
    ) -> Result<R, String> {
        self.open_document(partition).await?;
        self.with_document(partition, |doc| Ok(read(doc)))
    }

    /// Mutate the authoritative live document and publish every transaction
    /// the callback authors, in order. Each transaction is independently
    /// committed: if the callback later returns a domain error, earlier
    /// transactions are still published before that error is returned.
    /// Success means acceptance into the engine's in-memory history storage;
    /// the kernel schedules persistence to its OPFS checkpoint separately.
    pub async fn document_mutate<R>(
        &self,
        partition: &str,
        change: impl FnOnce(&mut Document) -> Result<R, String>,
    ) -> Result<R, String> {
        self.mutate(partition, change).await
    }

    pub fn document_revision_open(&self, partition: &str) -> Option<u64> {
        self.documents
            .borrow()
            .get(partition)
            .map(Document::revision)
    }

    pub fn model_entropy(&self) -> [u8; 32] {
        self.model_entropy
    }

    /// Wait until every local `us` mutation submitted before this call has
    /// crossed the driver's storage barrier.
    pub async fn control_barrier(&self) -> Result<(), String> {
        let _serial = self.control_write.lock().await;
        let _heads = self
            .handle
            .tree_heads(us_tree())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[must_use]
    pub fn control_revision(&self) -> u64 {
        self.control_revision.get()
    }

    // -- opaque histories ---------------------------------------------------

    pub fn opaque_status(&self, tree: &[u8; 32]) -> Option<bool> {
        opaque::status(&self.opaque, tree)
    }

    pub fn item_publishable(&self, item: &StoreItem) -> bool {
        !is_opaque_tree(&item.tree) || self.opaque_status(&item.tree) == Some(true)
    }

    /// Structural/authenticity validation independent of lifecycle and
    /// novelty. Drive uses this before deleting a correctly named obsolete
    /// object, so eligibility must deliberately not be part of the answer.
    pub fn valid_store_item(&self, item: &StoreItem) -> bool {
        let members = self.members.borrow();
        valid_item(&members, item)
    }

    pub async fn opaque_current(&self, slot: &str) -> Result<Option<[u8; 32]>, String> {
        self.open_us().await?;
        Ok(self
            .with_us(|doc| doc.opaque_register(slot))
            .and_then(|value| {
                value
                    .mode
                    .map(|_| opaque::tree_id(opaque::slot_hash(slot), value.nonce))
            }))
    }

    pub async fn opaque_replace(&self, slot: &str, mode: OpaqueMode) -> Result<[u8; 32], String> {
        self.open_us().await?;
        let nonce = self.next_opaque_nonce(slot);
        self.us_mutate(|doc| {
            let sequence = doc.opaque_register(slot).map_or(Ok(1), |value| {
                value
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| "opaque sequence exhausted".to_string())
            })?;
            doc.set_opaque_register(
                slot,
                opaque::RegisterValue {
                    sequence,
                    nonce,
                    mode: Some(mode),
                },
            )
        })
        .await?;
        let tree = opaque::tree_id(opaque::slot_hash(slot), nonce);
        if self.opaque_status(&tree) != Some(true) {
            return Err("a concurrent opaque replacement won".to_string());
        }
        Ok(tree)
    }

    pub async fn opaque_disable(&self, slot: &str) -> Result<(), String> {
        self.open_us().await?;
        let nonce = self.next_opaque_nonce(slot);
        self.us_mutate(|doc| {
            let sequence = doc.opaque_register(slot).map_or(Ok(1), |value| {
                value
                    .sequence
                    .checked_add(1)
                    .ok_or_else(|| "opaque sequence exhausted".to_string())
            })?;
            doc.set_opaque_register(
                slot,
                opaque::RegisterValue {
                    sequence,
                    nonce,
                    mode: None,
                },
            )
        })
        .await?;
        Ok(())
    }

    pub async fn opaque_open(&self, tree: [u8; 32]) -> Result<(), String> {
        self.open_us().await?;
        self.require_current_opaque(&tree)?;
        let tree = SedimentreeId::new(tree);
        let conns: Vec<_> = self
            .conns
            .borrow()
            .iter()
            .filter(|conn| {
                self.control_phases.borrow().get(&conn.id()) == Some(&ControlPhase::Ready)
            })
            .cloned()
            .collect();
        for conn in conns {
            self.require_current_opaque(tree.as_bytes())?;
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn opaque_publish(
        &self,
        tree: [u8; 32],
        parents: Vec<[u8; 32]>,
        bytes: Vec<u8>,
    ) -> Result<[u8; 32], String> {
        self.open_us().await?;
        let mode = self.require_current_opaque(&tree)?;
        let mut parents = parents;
        parents.sort_unstable();
        parents.dedup();
        let sedimentree = SedimentreeId::new(tree);
        if parents
            .iter()
            .any(|parent| !self.storage.holds(sedimentree, CommitId::new(*parent)))
        {
            return Err("opaque parents must be commits in the same tree".to_string());
        }
        let id = opaque::item_id(tree, &parents, &bytes);
        let parent_ids = parents.iter().copied().map(CommitId::new).collect();
        let (blob, sealed, operation_refs) = match mode {
            OpaqueMode::CallerEncrypted => (Blob::new(bytes), None, Vec::new()),
            OpaqueMode::GroupSealed => {
                let cref = raw_cref(tree, id);
                let mut preds: Vec<_> = parents
                    .iter()
                    .map(|parent| raw_cref(tree, *parent))
                    .collect();
                // Signed parents are a set. BeeKEM hashes this vector, while
                // `open_raw` reconstructs it from a BTreeSet, so both sides
                // must use the scoped-reference order rather than raw-id order.
                preds.sort_unstable();
                let vault = self.require_vault()?;
                let sealed = match vault.seal(cref, &preds, bytes).await {
                    Ok(sealed) => sealed,
                    Err(error) => {
                        vault.forget(std::iter::once(cref)).await;
                        return Err(error);
                    }
                };
                if self.require_current_opaque(&tree).is_err() {
                    vault.forget(std::iter::once(cref)).await;
                    return Err("opaque tree was retired while sealing".to_string());
                }
                (
                    Blob::new(sealed.blob.clone()),
                    Some((vault, sealed)),
                    vec![cref],
                )
            }
        };
        let result = async {
            self.require_current_opaque(&tree)?;
            self.handle
                .add_commits(
                    sedimentree,
                    vec![subduction_protocol::command::NewCommit {
                        head: CommitId::new(id),
                        parents: parent_ids,
                        blob,
                    }],
                )
                .await
                .map_err(|e| e.to_string())?;
            self.require_current_opaque(&tree)?;
            let _heads = self
                .handle
                .tree_heads(sedimentree)
                .await
                .map_err(|e| e.to_string())?;
            self.require_current_opaque(&tree)?;
            if !self.storage.holds(sedimentree, CommitId::new(id)) {
                return Err("opaque publication did not persist".to_string());
            }
            if let Some((vault, sealed)) = &sealed {
                self.publish_keyhive().await?;
                self.require_current_opaque(&tree)?;
                // Frontier movement is last: storage is known durable and no
                // fallible await remains after the confirmation.
                vault.confirm(sealed);
            }
            Ok(id)
        }
        .await;
        if result.is_err()
            && let Some((vault, _)) = &sealed
        {
            vault.forget(operation_refs).await;
            if self.opaque_status(&tree) != Some(true) {
                let _retired = self.retire_tree(tree).await;
            }
        }
        result
    }

    pub async fn opaque_read(&self, tree: [u8; 32]) -> Result<Vec<OpaqueItem>, String> {
        self.open_us().await?;
        let mode = self.require_current_opaque(&tree)?;
        let sedimentree = SedimentreeId::new(tree);
        let metadata: BTreeMap<_, _> = self
            .storage
            .metadata(sedimentree)
            .0
            .into_iter()
            .map(|commit| {
                (
                    commit.head(),
                    commit
                        .parents()
                        .iter()
                        .map(|p| *p.as_bytes())
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        let owned_refs: BTreeSet<[u8; 32]> = metadata
            .iter()
            .flat_map(|(id, parents)| {
                std::iter::once(raw_cref(tree, *id.as_bytes()))
                    .chain(parents.iter().map(|parent| raw_cref(tree, *parent)))
            })
            .collect();
        let blobs = self.storage.commit_blobs(sedimentree);
        let opened: Vec<_> = match mode {
            OpaqueMode::CallerEncrypted => blobs
                .into_iter()
                .map(|(id, bytes)| (*id.as_bytes(), bytes))
                .collect(),
            OpaqueMode::GroupSealed => {
                let scoped_parents: BTreeMap<[u8; 32], BTreeSet<[u8; 32]>> = metadata
                    .iter()
                    .map(|(id, parents)| {
                        (
                            raw_cref(tree, *id.as_bytes()),
                            parents
                                .iter()
                                .map(|parent| raw_cref(tree, *parent))
                                .collect(),
                        )
                    })
                    .collect();
                self.require_vault()?
                    .open_raw(
                        blobs
                            .into_iter()
                            .map(|(id, bytes)| (raw_cref(tree, *id.as_bytes()), bytes))
                            .collect(),
                        &scoped_parents,
                    )
                    .await?
                    .into_iter()
                    .filter_map(|(cref, bytes)| {
                        metadata
                            .keys()
                            .find(|id| raw_cref(tree, *id.as_bytes()) == cref)
                            .map(|id| (*id.as_bytes(), bytes))
                    })
                    .collect()
            }
        };
        if self.require_current_opaque(&tree).is_err() {
            if let Some(vault) = self.vault() {
                vault.forget(owned_refs).await;
            }
            return Err("opaque tree was retired while reading".to_string());
        }
        let mut answer: Vec<_> = opened
            .into_iter()
            .filter_map(|(id, bytes)| {
                let parents = metadata.get(&CommitId::new(id))?.clone();
                if opaque::item_id(tree, &parents, &bytes) != id {
                    return None;
                }
                Some(OpaqueItem { id, parents, bytes })
            })
            .collect();
        answer.sort_by_key(|item| item.id);
        Ok(answer)
    }

    pub async fn document_save(&self, partition: &str) -> Result<Vec<u8>, String> {
        self.document_read(partition, Document::save).await
    }

    pub async fn document_adopt(
        &self,
        partition: &str,
        bytes: &[u8],
        adopt: impl FnOnce(&mut Document, &Document) -> Result<(), String>,
    ) -> Result<(), String> {
        self.hydrate().await?;
        let source = Document::try_load(
            bytes,
            actor(b"polyvisor:actor:", self.seed, partition.as_bytes()),
            document_tree(partition),
        )?;
        self.open_document(partition).await?;
        self.mutate(partition, |doc| adopt(doc, &source)).await?;
        self.adopt_app_fragment(partition).await
    }

    async fn adopt_app_fragment(&self, app: &str) -> Result<(), String> {
        let tree = document_tree(app);
        let heads = self.with_document(app, |doc| Ok(doc.heads()))?;
        if heads.len() > 1 {
            let anchor = self.with_document(app, |doc| Ok(doc.merge_anchor()))?;
            if let Some(anchor) = anchor {
                let (anchor, sealed) = self.seal(anchor).await?;
                self.handle
                    .add_commits(tree, vec![anchor])
                    .await
                    .map_err(|e| e.to_string())?;
                let _ = self
                    .handle
                    .tree_heads(tree)
                    .await
                    .map_err(|e| e.to_string())?;
                self.require_vault()?.confirm(&sealed);
            }
        }
        let (heads, members) =
            self.with_document(app, |doc| Ok((doc.heads(), doc.change_hashes())))?;
        let (Some(head), 1) = (heads.first().copied(), heads.len()) else {
            return Ok(());
        };
        let fragment = automerge::Fragment {
            head,
            level: head.0.iter().take_while(|byte| **byte == 0).count(),
            boundary: Vec::new(),
            checkpoints: members
                .iter()
                .filter(|hash| **hash != head)
                .copied()
                .collect(),
            members,
        };
        let bundle = self
            .with_document(app, |doc| {
                Ok(doc.bundle(vec![fragment.clone()]).into_iter().next())
            })?
            .ok_or_else(|| "the adopted document could not be bundled".to_string())?;
        self.install_fragment(tree, &fragment, bundle, true).await
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

    pub async fn set_member_petname(&self, key: [u8; 32], petname: String) -> Result<(), String> {
        self.us_mutate(move |doc| doc.set_member_petname(key, petname))
            .await
    }

    // -- keyhive enrollment ---------------------------------------------------

    /// This device's keyhive contact card, for the joiner's ACCEPT frame.
    ///
    /// A prekey, signed by this device: it is what lets the adder seal the
    /// group's current epoch key to a device it has never met. Without it the
    /// joiner would be a member of the group in `us` and unable to open a
    /// single one of its documents.
    pub async fn keyhive_card(&self) -> Result<Vec<u8>, String> {
        self.open_us().await?;
        self.require_vault()?.contact_card().await
    }

    /// Adder: add the joiner's keyhive identity to the device group, and
    /// answer with the operation stream the joiner must ingest. Goes in
    /// ENROLL, beside the user-system document.
    /// The second element is the content keys the joiner needs to read history
    /// authored before it existed (see `Vault::export_content_keys`).
    pub async fn enroll_keyhive(
        &self,
        card: &[u8],
        joiner_key: [u8; 32],
    ) -> Result<(Vec<u8>, Vec<u8>), String> {
        self.open_us().await?;
        let vault = self.require_vault()?;
        let events = vault.enroll(card, joiner_key).await?;
        let keys = vault.export_content_keys()?;
        // Also onto the wire: a third device that pairs later learns of the
        // second one from the tree, not from a frame it never saw.
        self.publish_keyhive().await?;
        Ok((events, keys))
    }

    /// Joiner: ingest the adder's keyhive operations and start sealing to the
    /// group's document.
    ///
    /// Runs *after* [`Engine::adopt_us`], because the group and document it
    /// switches to are the ones the adopted user-system document names — the
    /// adder's word on which document is the group's, carried in the same
    /// bytes the user just confirmed six digits over.
    pub async fn adopt_keyhive(&self, events: &[u8], content_keys: &[u8]) -> Result<(), String> {
        self.open_us().await?;
        let (group, doc) = self
            .with_us(UsDoc::keyhive)
            .ok_or_else(|| "that device sent a group with no keyhive state".to_string())?;
        self.require_vault()?
            .adopt(events, content_keys, group, doc)
            .await?;
        self.publish_keyhive().await?;
        // Everything already in storage was unopenable a moment ago.
        let apps: Vec<String> = self.documents.borrow().keys().cloned().collect();
        for app in apps {
            let _landed = self.absorb_app(&app).await;
        }
        Ok(())
    }

    /// How many entry points into the group's document this device holds —
    /// the size of the head set it checkpoints and hands to the next device it
    /// enrols. One per unmerged readable branch; a linear history is one.
    pub async fn entry_points(&self) -> Result<usize, String> {
        self.open_us().await?;
        Ok(self.require_vault()?.entry_points())
    }

    #[doc(hidden)]
    pub fn has_opaque_entry_point(&self, tree: [u8; 32], id: [u8; 32]) -> bool {
        self.vault()
            .is_some_and(|vault| vault.holds_entry_point(&raw_cref(tree, id)))
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
    /// `name_key` is the group's store-name key, from the same ENROLL frame:
    /// adopting a group means writing to — and reading from — the store that
    /// group already uses, and the names there are derived under this key.
    /// It replaces the group-of-one's key for the same reason the document
    /// does; the objects the old key named were this device's alone.
    pub async fn adopt_us(
        &self,
        bytes: &[u8],
        adder: [u8; 32],
        name_key: [u8; 32],
    ) -> Result<(), String> {
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
        *self.name_key.borrow_mut() = Some(name_key);
        self.group_generation
            .set(self.group_generation.get().saturating_add(1));
        self.refresh_members();
        self.refresh_opaque_admission();
        self.reconcile_opaque().await?;

        // Resubscribe: `remove_tree` took the tree out of the driver's
        // residency, and this device now wants every commit behind the
        // document it just adopted.
        let conns: Vec<_> = self.conns.borrow().clone();
        for conn in conns {
            conn.sync_tree(tree, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        self.adopt_fragment().await
    }

    /// Make the adopted group document servable: one sedimentree fragment
    /// over the whole of it.
    ///
    /// [`Engine::adopt_us`] installs an automerge *snapshot* — the adder's
    /// document, whole — and empties the tree that used to back it. That
    /// leaves this device holding history it can read and cannot hand to
    /// anyone: no loose commit of the group's past is in its tree, so a third
    /// device that syncs only with this one, or a store this one pushes to,
    /// gets nothing of the era before the pairing. The pull will not fetch
    /// those objects back either, and should not — the changes are already in
    /// the document (`Engine::read_not_held`).
    ///
    /// A fragment is exactly the item sedimentree has for this: a range of
    /// history carried as one blob by a member that can read the whole range.
    /// This device can — it just adopted it — so it builds one, with an empty
    /// boundary because the range reaches the root, and every change as a
    /// checkpoint because the fragment covers all of them
    /// (`Fragment::supports_block` answers coverage from head, checkpoints
    /// and boundary; `Fragment::new` truncates the checkpoints to 12 bytes).
    ///
    /// Identity is head plus boundary, so the adder — holding the same graph
    /// — builds the same fragment if it ever takes this path, and a deeper
    /// one automerge draws later subsumes neither: both are correct items
    /// over the same changes.
    async fn adopt_fragment(&self) -> Result<(), String> {
        let tree = us_tree();
        // A sedimentree fragment has one head; an automerge document may
        // have several. Where it does, the document is given one the way the
        // absorb path gives a partitioned app tree one: an empty change
        // depending on every current head. It goes in as a real signed `us`
        // commit rather than a bare automerge change, because that is what
        // every other device will read it as.
        if self.with_us(UsDoc::heads).len() > 1 {
            let anchor = {
                let mut cell = self.us.borrow_mut();
                let doc = cell
                    .as_mut()
                    .ok_or_else(|| "this device has no group document".to_string())?;
                doc.merge_anchor()
            };
            self.push_us_commits(anchor.into_iter().collect()).await?;
        }
        let (heads, members) = self.with_us(|doc| (doc.heads(), doc.change_hashes()));
        // One head, or none at all: a document with no changes has no
        // history to serve, which is not this function's problem to report.
        let (Some(head), 1) = (heads.first().copied(), heads.len()) else {
            return Ok(());
        };
        if self.storage.holds_fragment(tree, CommitId::new(head.0)) {
            return Ok(());
        }
        let fragment = automerge::Fragment {
            head,
            // What `ChangeHash::fragment_level` would say — leading zero
            // bytes, the same metric sedimentree's `CountLeadingZeroBytes`
            // uses (automerge types.rs:680). It is not the *stratum* this
            // fragment sits at, which sedimentree computes from the head
            // itself; the one thing automerge reads it for is whether a
            // one-member fragment may be encoded as a bare change rather
            // than a bundle, and both decode through `load_incremental`.
            level: head.0.iter().take_while(|byte| **byte == 0).count(),
            boundary: Vec::new(),
            checkpoints: members
                .iter()
                .filter(|hash| **hash != head)
                .copied()
                .collect(),
            members: members.clone(),
        };
        let Some(bundle) = self
            .with_us(|doc| doc.bundle(vec![fragment.clone()]))
            .into_iter()
            .next()
        else {
            return Ok(());
        };
        // Plaintext, like every other item of this tree (`crate::vault`
        // module docs: the group document is what tells a device who its
        // group is, and it cannot be sealed to a key that knowledge is
        // needed to derive).
        self.install_fragment(tree, &fragment, bundle, false).await
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
        let duplicate = self
            .conns
            .borrow()
            .iter()
            .any(|existing| existing.peer() == conn.peer());
        if duplicate {
            let peer = conn.peer();
            conn.disconnect().await;
            return Ok(peer);
        }

        // Register before requesting control: a fast in-memory peer can return
        // SyncFinished before this future is polled again, and the event pump
        // needs the capability to schedule the next (keyhive) phase.
        self.conns.borrow_mut().push(conn.clone());
        // Every connection runs its own control phase in both directions.
        // Marking the peer pending immediately also prevents a second live
        // connection from inheriting an earlier connection's readiness.
        self.control_phases
            .borrow_mut()
            .insert(conn.id(), ControlPhase::AwaitUs);
        if direction == Direction::Outbound {
            self.control_initiators.borrow_mut().insert(conn.id());
        }
        self.rebuild_ready_peers();
        // Control first. `SyncFinished` is queued before response persistence
        // (pinned Subduction core_machine/sync.rs:381-389), so it is not a
        // durability barrier. Keyhive is requested second; its completion can
        // only be observed by the pump after a preceding us `TreeUpdated`.
        conn.sync_tree(us_tree(), true)
            .await
            .map_err(|e| e.to_string())?;
        let peer = conn.peer();
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
                AppEvent::TreeUpdated { tree, .. } => {
                    let changed = if is_opaque_tree(tree.as_bytes()) {
                        self.opaque_status(tree.as_bytes()) == Some(true)
                    } else {
                        self.absorb(tree).await
                    };
                    if tree == us_tree() {
                        let _reconciled = self.reconcile_opaque().await;
                    }
                    if changed {
                        notify(EngineEvent::Changed).await;
                    }
                }
                AppEvent::SyncFinished { conn, tree, status }
                    if tree == us_tree()
                        && self.control_phases.borrow().get(&conn)
                            == Some(&ControlPhase::AwaitUs)
                        && status == subduction_protocol::effect::SyncStatus::Completed =>
                {
                    // CONTRACT: SyncFinished is emitted before the queued
                    // persist completes (pinned sync.rs:381-389). A handle
                    // round trip is the barrier; only then may keyhive, and
                    // later content, be requested from this peer.
                    let _barrier = self.handle.tree_heads(us_tree()).await;
                    let changed = self.absorb(us_tree()).await;
                    let _reconciled = self.reconcile_opaque().await;
                    if changed {
                        notify(EngineEvent::Changed).await;
                    }
                    self.control_phases
                        .borrow_mut()
                        .insert(conn, ControlPhase::AwaitKeyhive);
                    let connection = self.conns.borrow().iter().find(|c| c.id() == conn).cloned();
                    if let Some(connection) = connection {
                        let _queued = connection.sync_tree(keyhive_tree(), true).await;
                    }
                }
                AppEvent::SyncFinished { conn, tree, status }
                    if tree == keyhive_tree()
                        && self.control_phases.borrow().get(&conn)
                            == Some(&ControlPhase::AwaitKeyhive)
                        && status == subduction_protocol::effect::SyncStatus::Completed =>
                {
                    let _barrier = self.handle.tree_heads(keyhive_tree()).await;
                    let _absorbed = self.absorb(keyhive_tree()).await;
                    self.control_phases
                        .borrow_mut()
                        .insert(conn, ControlPhase::Ready);
                    self.rebuild_ready_peers();
                    let connection = self.conns.borrow().iter().find(|c| c.id() == conn).cloned();
                    let should_send = self.catalog_sent.borrow_mut().insert(conn);
                    if let Some(connection) = connection
                        && should_send
                    {
                        for batch in encode_catalog(&self.content_trees()) {
                            let _sent = connection.send_extension(batch).await;
                        }
                    }
                    self.maybe_sync_catalog(conn).await;
                }
                AppEvent::ExtensionMessage { conn, peer, bytes } => {
                    let registered = self.control_phases.borrow().contains_key(&conn);
                    let member = self.members.borrow().contains(peer.as_bytes());
                    if retain_catalog(
                        &mut self.remote_catalogs.borrow_mut(),
                        &mut self.pending_catalogs.borrow_mut(),
                        conn,
                        registered,
                        member,
                        &bytes,
                    ) {
                        self.maybe_sync_catalog(conn).await;
                    }
                }
                // The connection registry is the engine's, so this is where
                // it shrinks: without it a dead peer's `Connection` would sit
                // in `conns` forever, and every later `open_app` would try to
                // subscribe a tree on it.
                AppEvent::ConnectionClosed { conn, peer } => {
                    self.conns.borrow_mut().retain(|live| live.id() != conn);
                    self.control_phases.borrow_mut().remove(&conn);
                    self.control_initiators.borrow_mut().remove(&conn);
                    self.remote_catalogs.borrow_mut().remove(&conn);
                    self.pending_catalogs.borrow_mut().remove(&conn);
                    self.catalog_sent.borrow_mut().remove(&conn);
                    self.rebuild_ready_peers();
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

    // -- the durable store ---------------------------------------------------

    /// The group's store-name key, or `None` for a device with no group yet.
    ///
    /// The kernel derives every name it writes to the user's store from this
    /// (docs/design.md "Storage"), so `None` is also the answer to "is there
    /// anything to store": a device with no group document has nothing a
    /// second device of the group could want.
    #[must_use]
    pub fn name_key(&self) -> Option<[u8; 32]> {
        *self.name_key.borrow()
    }

    /// Every item this device holds, across every tree: what the durable
    /// store's push walks.
    ///
    /// The signed envelope is carried verbatim, exactly as the checkpoint
    /// carries it (`crate::storage`): re-signing another device's commit on
    /// the way to the store would relabel its authorship as ours.
    #[must_use]
    pub fn items(&self) -> Vec<StoreItem> {
        self.storage.all_items()
    }

    /// Every `(tree, commit)` this device has *read* but does not hold as an
    /// item: a change that is in the document and whose loose commit is not
    /// in the tree, because a fragment carries it instead.
    ///
    /// The store deletes nothing, so a commit pruned by compaction is still
    /// there under its name, and to a pull that only knows [`Engine::items`]
    /// it looks exactly like a commit some other device wrote and this one
    /// has never seen — so every pass would fetch the whole compacted range
    /// back, and `accept` would refuse it, forever. This is the set that
    /// closes that loop.
    ///
    /// Derived from the documents rather than remembered: the document *is*
    /// the record of what this device has read, rebuilt from its own changes
    /// on every load (`polyvisor_document_history::Document`), and it answers for a
    /// range that arrived as somebody else's fragment just as well as for one
    /// this device compacted itself.
    #[must_use]
    pub fn read_not_held(&self) -> Vec<([u8; 32], [u8; 32])> {
        let mut found = Vec::new();
        let mut walk = |tree: SedimentreeId, applied: std::collections::BTreeSet<CommitId>| {
            for id in applied {
                if !self.storage.holds(tree, id) {
                    found.push((*tree.as_bytes(), *id.as_bytes()));
                }
            }
        };
        for doc in self.documents.borrow().values() {
            walk(doc.tree(), doc.applied_ids());
        }
        if let Some(doc) = self.us.borrow().as_ref() {
            walk(us_tree(), doc.applied_ids());
        }
        found
    }

    /// Whether `tree`'s document has already applied `commit` — the change is
    /// in this device's history whether or not the commit that carried it is
    /// still an item. See [`Engine::read_not_held`].
    fn read(&self, tree: SedimentreeId, commit: CommitId) -> bool {
        if tree == us_tree() {
            return self
                .us
                .borrow()
                .as_ref()
                .is_some_and(|doc| doc.applied_ids().contains(&commit));
        }
        self.documents
            .borrow()
            .values()
            .find(|doc| doc.tree() == tree)
            .is_some_and(|doc| doc.applied_ids().contains(&commit))
    }

    /// Install items a *store* handed back — another device of this group
    /// pushed them — and apply whatever they unlock. Answers whether anything
    /// was new, which is the kernel's cue to checkpoint.
    ///
    /// This is the restore path, not the authoring path: the items go into
    /// storage as the signed envelopes they arrived as and the driver is told
    /// about them with `hydrate_tree`, exactly as `Engine::new` +
    /// [`Engine::hydrate`] do for a checkpoint's items. `add_commits` would
    /// have been wrong twice over — it re-signs the commit as this device's,
    /// and it re-seals an app blob that is already an envelope.
    ///
    /// Trees are ingested keyhive-first and then the group document, for the
    /// reason [`Engine::hydrate`] gives: the keyhive events are the material
    /// that turns a blob this device cannot open into one it can.
    pub async fn ingest_items(&self, items: Vec<StoreItem>) -> Result<bool, String> {
        let initial_generation = self.group_generation.get();
        self.hydrate().await?;
        if self.group_generation.get() != initial_generation {
            return Err("group changed during store import".to_string());
        }
        self.open_us().await?;
        if self.group_generation.get() != initial_generation {
            return Err("group changed during store import".to_string());
        }
        let group_generation = *self.name_key.borrow();
        let mut by_tree: BTreeMap<SedimentreeId, Vec<StoreItem>> = BTreeMap::new();
        let mut fresh = false;
        for item in items {
            by_tree
                .entry(SedimentreeId::new(item.tree))
                .or_default()
                .push(item);
        }
        let mut order: Vec<SedimentreeId> = by_tree.keys().copied().collect();
        order.sort_by_key(|tree| {
            if *tree == us_tree() {
                0
            } else if *tree == keyhive_tree() {
                1
            } else {
                2
            }
        });
        for tree in order {
            if *self.name_key.borrow() != group_generation {
                return Err("group changed during store import".to_string());
            }
            let members = self.members.borrow().clone();
            let mut commits = Vec::new();
            let mut fragments = Vec::new();
            for item in by_tree.remove(&tree).unwrap_or_default() {
                if !self.accept(&members, &item) {
                    continue;
                }
                fresh = true;
                let landing = match item.kind {
                    ItemKind::Commit => &mut commits,
                    ItemKind::Fragment => &mut fragments,
                };
                landing.push(Item {
                    signed: item.signed,
                    blob: item.blob,
                });
            }
            if commits.is_empty() && fragments.is_empty() {
                continue;
            }
            self.storage.restore(tree, commits, fragments);
            if is_opaque_tree(tree.as_bytes()) && self.opaque_status(tree.as_bytes()) != Some(true)
            {
                self.storage.forget_tree(tree);
                continue;
            }
            let (commits, fragments) = self.storage.metadata(tree);
            // Merged, not replaced: `Command::HydrateTree` adds each commit to
            // the resident tree (subduction_protocol/src/core_machine.rs:284),
            // so handing it the whole tree again is idempotent.
            self.handle
                .hydrate_tree(tree, commits, fragments)
                .await
                .map_err(|e| e.to_string())?;
            if *self.name_key.borrow() != group_generation {
                return Err("group changed during store import".to_string());
            }
            if tree == us_tree() {
                let _landed = self.absorb(tree).await;
                self.reconcile_opaque().await?;
            } else if !is_opaque_tree(tree.as_bytes()) {
                let _landed = self.absorb(tree).await;
            } else if self.opaque_status(tree.as_bytes()) != Some(true) {
                self.retire_tree(*tree.as_bytes()).await?;
            }
        }
        Ok(fresh)
    }

    /// Whether one item a store handed back may be installed, and is news.
    ///
    /// **A store is not a peer.** Everything arriving over a connection has
    /// been through the handshake (the peer proved its key), the kernel's
    /// membership check and `GroupPolicy`; an object read out of Drive has
    /// been through none of those, and the bytes are whatever was under that
    /// name. So every claim the object makes is checked here against the
    /// envelope itself, and the envelope against the group:
    ///
    /// - the **signature** verifies (`try_verify`, not the trusted-storage
    ///   decode: the trusted decode reads the fields of an envelope nobody
    ///   has checked, which is exactly the situation it documents itself as
    ///   being wrong for);
    /// - the **issuer is a member** — the same set `GroupPolicy` consults for
    ///   a remote peer's operations, and with no exception for the group
    ///   document, because the live path has none either. What that costs is
    ///   stated: a commit authored by a device this one has not yet learned
    ///   of is skipped, and lands on a later pass once the enrollment that
    ///   names it has been absorbed (the keyhive and `us` trees are ingested
    ///   before the app trees, so that pass is usually the same one);
    /// - the **tree** the object was filed under is the one the commit names
    ///   (`sedimentree_id`), so an item cannot be moved between trees;
    /// - the **item id** the object was named by is the item's own head;
    /// - the **blob** is the one the item committed to (`BlobMeta`), so the
    ///   signed metadata and the bytes beside it cannot be from two different
    ///   items.
    ///
    /// The same five checks for a fragment, against `Signed<Fragment>` — a
    /// fragment is a signed sedimentree item like any other, and a store that
    /// could hand back an unverified one would be handing back a whole range
    /// of forged history in a single object rather than one commit's worth.
    ///
    /// A failing item is skipped, not fatal: the folder is the user's own
    /// Drive and one bad object must not stop the rest from landing.
    fn accept(&self, members: &std::collections::BTreeSet<[u8; 32]>, item: &StoreItem) -> bool {
        if !valid_item(members, item) || !self.item_publishable(item) {
            return false;
        }
        if is_opaque_tree(&item.tree)
            && opaque::mode(&self.opaque, &item.tree) == Some(OpaqueMode::CallerEncrypted)
        {
            let Some(payload) =
                verify::<sedimentree_core::loose_commit::LooseCommit>(&item.signed, members)
            else {
                return false;
            };
            let parents: Vec<_> = payload.parents().iter().map(|id| *id.as_bytes()).collect();
            if opaque::item_id(item.tree, &parents, &item.blob) != item.commit {
                return false;
            }
        }
        let tree = SedimentreeId::new(item.tree);
        let id = CommitId::new(item.commit);
        match item.kind {
            ItemKind::Commit => {
                // Held is not the whole of "not news": a commit whose change
                // the document has already applied was read and then pruned
                // (or never held loose at all, having arrived inside somebody
                // else's fragment). Reinstating it would undo the compaction
                // on every pass. See [`Engine::read_not_held`].
                !self.storage.holds(tree, id) && !self.read(tree, id)
            }
            ItemKind::Fragment => !self.storage.holds_fragment(tree, id),
        }
    }

    // -- checkpointing -------------------------------------------------------

    /// Everything needed to reconstruct this engine: each app's automerge
    /// document, and the sedimentree items backing it.
    ///
    /// Not the seed — the kernel holds that, in the same sealed checkpoint,
    /// and two copies of an identity is one copy too many to keep in step.
    ///
    /// Async and fallible because it carries this device's keyhive, whose
    /// archive is an async read.
    pub async fn snapshot(&self) -> Result<Snapshot, String> {
        self.control_barrier().await?;
        // The vault's own state first, and outside the `apps` borrow: reading
        // keyhive's archive is async.
        let vault = match self.vault() {
            Some(vault) => Some(vault.state().await?),
            None => self.pending_vault.borrow().clone(),
        };
        let apps = self.documents.borrow();
        let us = self
            .us
            .borrow()
            .as_ref()
            .map(|doc| (doc.tree(), doc.save()));
        let keyhive = vault.is_some().then(keyhive_tree);
        let name_key = *self.name_key.borrow();
        Ok(self.storage.snapshot(
            apps.iter()
                .map(|(app, doc)| (app.clone(), doc.tree(), doc.save())),
            us,
            keyhive,
            vault,
            name_key,
        ))
    }

    // -- internals -----------------------------------------------------------

    fn content_trees(&self) -> Vec<SedimentreeId> {
        let mut trees: Vec<_> = self
            .documents
            .borrow()
            .values()
            .map(Document::tree)
            .collect();
        trees.extend(
            self.opaque
                .borrow()
                .registers
                .iter()
                .filter_map(|(slot, value)| {
                    value
                        .mode
                        .map(|_| SedimentreeId::new(opaque::tree_id(*slot, value.nonce)))
                }),
        );
        trees
    }

    /// Make sure this device holds a user-system document, and that every
    /// live peer is subscribed to its tree. The `open_app` shape, for the
    /// one document that is not per-app.
    async fn open_us(&self) -> Result<(), String> {
        self.hydrate().await?;
        // Before the early return: a restored device has its group document
        // already and would otherwise never build the keyhive that document
        // names.
        self.open_vault().await?;
        if self.us.borrow().is_some() {
            return Ok(());
        }
        *self.name_key.borrow_mut() = Some(self.name_key_seed);
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
                doc.drain_local_commits()
            };
            self.refresh_members();
            self.push_us_commits(commit).await?;
        }
        // The founder names its keyhive group and document in the one place
        // every device of the group will read: a joiner learns which document
        // to seal to by adopting this, not by guessing.
        if self.with_us(UsDoc::keyhive).is_none() {
            let vault = self.require_vault()?;
            let (group, doc_id) = (vault.group_id(), vault.doc_id());
            let commit = {
                let mut cell = self.us.borrow_mut();
                let doc = cell
                    .as_mut()
                    .ok_or_else(|| "this device has no group document".to_string())?;
                doc.set_keyhive(group, doc_id)?;
                doc.drain_local_commits()
            };
            self.push_us_commits(commit).await?;
        }
        self.publish_keyhive().await?;
        Ok(())
    }

    /// Make sure this device holds a keyhive: restored from the checkpoint if
    /// there was one, generated otherwise.
    async fn open_vault(&self) -> Result<(), String> {
        if self.vault.borrow().is_some() {
            return Ok(());
        }
        let restored = self.pending_vault.borrow_mut().take();
        let vault = match restored {
            Some(state) => Vault::restore(&state, self.seed, self.vault_rng_seed).await?,
            None => Vault::create(self.seed, self.vault_rng_seed).await?,
        };
        *self.vault.borrow_mut() = Some(Rc::new(vault));
        Ok(())
    }

    /// The vault, cloned out of its cell: every keyhive call is async, and a
    /// `RefCell` borrow may not span an await (see `Document`).
    fn vault(&self) -> Option<Rc<Vault>> {
        self.vault.borrow().clone()
    }

    fn require_vault(&self) -> Result<Rc<Vault>, String> {
        self.vault()
            .ok_or_else(|| "this device has no keyhive yet".to_string())
    }

    /// Carry every keyhive operation this device has not yet published into
    /// the keyhive-events tree. Idempotent, and cheap when there is nothing
    /// new: the vault remembers what it has already put on the wire.
    async fn publish_keyhive(&self) -> Result<(), String> {
        let Some(vault) = self.vault() else {
            return Ok(());
        };
        let events = vault.unpublished().await?;
        if events.is_empty() {
            return Ok(());
        }
        let commits: Vec<subduction_protocol::command::NewCommit> = events
            .into_iter()
            .map(|(id, bytes)| subduction_protocol::command::NewCommit {
                head: CommitId::new(id),
                parents: std::collections::BTreeSet::new(),
                blob: Blob::new(bytes),
            })
            .collect();
        self.handle
            .add_commits(keyhive_tree(), commits)
            .await
            .map_err(|e| e.to_string())?;
        let _heads = self
            .handle
            .tree_heads(keyhive_tree())
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Carry a user-system change into its tree, and wait for the driver to
    /// have persisted it (the barrier [`Engine::mutate`] documents).
    async fn push_us_commits(
        &self,
        commits: Vec<subduction_protocol::command::NewCommit>,
    ) -> Result<(), String> {
        if commits.is_empty() {
            return Ok(());
        }
        self.handle
            .add_commits(us_tree(), commits)
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
        let _serial = self.control_write.lock().await;
        let (answer, commits) = {
            let mut cell = self.us.borrow_mut();
            let doc = cell
                .as_mut()
                .ok_or_else(|| "this device has no group document".to_string())?;
            let answer = change(doc);
            (answer, doc.drain_local_commits())
        };
        self.refresh_members();
        self.control_revision
            .set(self.control_revision.get().saturating_add(1));
        // Admission changes before the first await. A queued remote storage
        // continuation must observe the new register even while its control
        // commit is still being persisted locally.
        self.refresh_opaque_admission();
        self.push_us_commits(commits).await?;
        self.reconcile_opaque().await?;
        // The group document is compacted on the same terms as an app's:
        // `Engine::absorb` covers what arrives, this covers what is written
        // here. A group that reaches a fragment's worth of membership edits
        // is not a case anyone expects, and the cost of saying so is one
        // walk of a very short change graph.
        let _compacted = self.compact(us_tree()).await;
        answer
    }

    /// Mirror the document's members into the set the policy reads.
    fn refresh_members(&self) {
        let keys = self.with_us(|doc| doc.members().into_iter().map(|m| m.key).collect());
        *self.members.borrow_mut() = keys;
    }

    fn rebuild_ready_peers(&self) {
        let phases = self.control_phases.borrow();
        let conns = self.conns.borrow();
        let mut live: BTreeMap<[u8; 32], (usize, usize)> = BTreeMap::new();
        for conn in conns.iter() {
            let counts = live.entry(*conn.peer().as_bytes()).or_default();
            counts.0 += 1;
            if phases.get(&conn.id()) == Some(&ControlPhase::Ready) {
                counts.1 += 1;
            }
        }
        // Conservative duplicate handling: every connection for a peer must
        // have independently completed control before any may touch opaque
        // storage. A newly connected duplicate therefore revokes readiness.
        self.opaque.borrow_mut().ready_peers = live
            .into_iter()
            .filter_map(|(peer, (all, ready))| (all == ready).then_some((peer, ready)))
            .collect();
    }

    async fn maybe_sync_catalog(&self, id: subduction_protocol::id::ConnId) {
        let phase = self.control_phases.borrow().get(&id).copied();
        let remote = self.remote_catalogs.borrow().get(&id).cloned();
        let Some(remote) = ready_catalog(phase, remote) else {
            return;
        };
        let Some(conn) = self
            .conns
            .borrow()
            .iter()
            .find(|conn| conn.id() == id)
            .cloned()
        else {
            return;
        };
        // Catalog exchange makes preexisting trees discoverable in both
        // directions. Only the dialer requests their union, avoiding
        // simultaneous Automerge absorb/anchor cycles while Subduction's diff
        // remains bidirectional.
        if !self.control_initiators.borrow().contains(&id) {
            return;
        }
        let mut trees = self.content_trees();
        trees.extend(remote);
        trees.sort_unstable();
        trees.dedup();
        for tree in trees {
            if !is_opaque_tree(tree.as_bytes()) || self.opaque_status(tree.as_bytes()) == Some(true)
            {
                let _queued = conn.sync_tree(tree, true).await;
            }
        }
    }

    fn next_opaque_nonce(&self, slot: &str) -> [u8; 16] {
        let mut counter = self.opaque_nonce.borrow_mut();
        *counter = counter.saturating_add(1);
        let digest = Sha256::new()
            .chain_update(b"polyvisor:opaque-nonce:v1\0")
            .chain_update(self.model_entropy)
            .chain_update(self.seed)
            .chain_update(slot.as_bytes())
            .chain_update(counter.to_be_bytes())
            .finalize();
        digest[..16].try_into().expect("fixed digest slice")
    }

    fn require_current_opaque(&self, tree: &[u8; 32]) -> Result<OpaqueMode, String> {
        opaque::mode(&self.opaque, tree)
            .ok_or_else(|| "opaque tree is unknown or retired".to_string())
    }

    fn refresh_opaque_admission(&self) {
        let next = self.with_us(UsDoc::opaque_registers);
        let old = std::mem::replace(&mut self.opaque.borrow_mut().registers, next.clone());
        for (slot, value) in &old {
            if value.mode.is_some() {
                let tree = opaque::tree_id(*slot, value.nonce);
                if opaque::status(&self.opaque, &tree) != Some(true) {
                    self.pending_opaque_retire.borrow_mut().insert(tree);
                }
            }
        }
        self.pending_opaque_subscribe.borrow_mut().extend(
            next.iter()
                .filter_map(|(slot, value)| (old.get(slot) != Some(value)).then_some(*slot)),
        );
    }

    async fn reconcile_opaque(&self) -> Result<(), String> {
        let retired = std::mem::take(&mut *self.pending_opaque_retire.borrow_mut());
        for tree in retired {
            self.retire_tree(tree).await?;
        }
        let changed = std::mem::take(&mut *self.pending_opaque_subscribe.borrow_mut());
        let next = self.opaque.borrow().registers.clone();
        let conns: Vec<_> = self
            .conns
            .borrow()
            .iter()
            .filter(|conn| {
                self.control_phases.borrow().get(&conn.id()) == Some(&ControlPhase::Ready)
            })
            .cloned()
            .collect();
        for (slot, value) in next {
            if value.mode.is_some() && changed.contains(&slot) {
                let tree = SedimentreeId::new(opaque::tree_id(slot, value.nonce));
                for conn in &conns {
                    if self.opaque_status(tree.as_bytes()) == Some(true) {
                        conn.sync_tree(tree, true)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }

    async fn retire_tree(&self, tree: [u8; 32]) -> Result<(), String> {
        let sedimentree = SedimentreeId::new(tree);
        let mut crefs: BTreeSet<_> = self
            .storage
            .metadata(sedimentree)
            .0
            .into_iter()
            .flat_map(|commit| {
                std::iter::once(raw_cref(tree, *commit.head().as_bytes()))
                    .chain(
                        commit
                            .parents()
                            .iter()
                            .map(|parent| raw_cref(tree, *parent.as_bytes())),
                    )
                    .collect::<Vec<_>>()
            })
            .collect();
        let conns: Vec<_> = self.conns.borrow().clone();
        for conn in conns {
            let _unsubscribed = conn.unsubscribe(vec![sedimentree]).await;
        }
        self.handle
            .remove_tree(sedimentree)
            .await
            .map_err(|e| e.to_string())?;
        let _barrier = self
            .handle
            .tree_heads(sedimentree)
            .await
            .map_err(|e| e.to_string())?;
        self.storage.forget_tree(sedimentree);
        if let Some(vault) = self.vault() {
            vault.forget(std::mem::take(&mut crefs)).await;
        }
        Ok(())
    }

    /// Hand a restored snapshot's trees to the driver, once. Idempotent: the
    /// pending list is taken before the first await, so a re-entrant call
    /// finds nothing to do rather than hydrating twice.
    async fn hydrate(&self) -> Result<(), String> {
        let Some(trees) = self.pending_hydration.borrow_mut().take() else {
            return Ok(());
        };
        for tree in &trees {
            let (commits, fragments) = self.storage.metadata(*tree);
            self.handle
                .hydrate_tree(*tree, commits, fragments)
                .await
                .map_err(|e| e.to_string())?;
        }
        // A restored device's app documents were NOT absorbed in
        // `Engine::new`: their blobs are envelopes and opening one is async.
        // The keyhive tree goes first — it carries the material the rest needs
        // — and the vault has to exist before either.
        if self.pending_vault.borrow().is_some() || self.vault.borrow().is_some() {
            self.open_vault().await?;
        }
        if trees.contains(&keyhive_tree()) {
            let _landed = self.absorb_keyhive().await;
        }
        for tree in trees {
            if tree == keyhive_tree() || tree == us_tree() {
                continue;
            }
            let _landed = self.absorb(tree).await;
        }
        Ok(())
    }

    /// Run `change` against the app's document, carry the resulting automerge
    /// change into the tree as one sedimentree commit, and subscribe every
    /// live connection to the tree in case this call created it.
    async fn mutate<R>(
        &self,
        app: &str,
        change: impl FnOnce(&mut Document) -> Result<R, String>,
    ) -> Result<R, String> {
        self.open_document(app).await?;
        let (answer, tree, commits) = self.with_document(app, |doc| {
            let answer = change(doc);
            Ok((answer, doc.tree(), doc.drain_local_commits()))
        })?;
        if !commits.is_empty() {
            let mut published = Vec::with_capacity(commits.len());
            let mut sealed_commits = Vec::with_capacity(commits.len());
            for commit in commits {
                let (commit, sealed) = self.seal(commit).await?;
                published.push(commit);
                sealed_commits.push(sealed);
            }
            self.handle
                .add_commits(tree, published)
                .await
                .map_err(|e| e.to_string())?;
            // Only now: until the driver has taken the commit, the parents
            // whose keys are inside it must stay on the frontier.
            let vault = self.require_vault()?;
            for sealed in &sealed_commits {
                vault.confirm(sealed);
            }
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
            // Encrypting may have advanced the document's CGKA epoch, and the
            // update op is what lets the other devices follow.
            self.publish_keyhive().await?;
            // One commit in ~256 closes a level-1 fragment (its hash starts
            // with a zero byte); the other 255 times this walks the change
            // graph, finds every fragment already held, and stops before
            // bundling anything. Not free — `fragments(1..)` is linear in the
            // history — but linear in a walk automerge does over its own
            // index, not in re-encoding the document.
            //
            // Not `?`: the mutation is already durable — the barrier above
            // saw to that — so a compaction that failed must not report the
            // user's write as failed. The roll-up waits for the next one.
            let _compacted = self.compact(tree).await;
        }
        answer
    }

    /// Roll every closed commit range of `tree` up into a sedimentree
    /// fragment, and drop the loose commits the roll-up carries.
    ///
    /// Called after a local mutation and after an absorb that landed
    /// (`Engine::mutate`, `Engine::absorb`), which between them cover every
    /// way this device's history grows.
    ///
    /// **Who may build one.** Only a device that can read the whole range:
    /// the fragment's payload is an automerge *bundle* of its members'
    /// changes, and building it means having those changes in the document.
    /// That falls out of the construction rather than being enforced — a
    /// device that could not open an envelope never applied it, so automerge
    /// never drew a fragment over it. A commit this device could not read is
    /// outside the fragment's members and stays loose, and sedimentree
    /// decides coverage by head/checkpoints/boundary
    /// (`Fragment::supports_block`), so nothing claims to carry it.
    ///
    /// The keyhive-events tree is skipped: it has no automerge document —
    /// its commits *are* the state, unordered and content-addressed (see
    /// [`keyhive_tree`]) — so there is no change graph to fragment.
    async fn compact(&self, tree: SedimentreeId) -> Result<(), String> {
        if tree == keyhive_tree() {
            return Ok(());
        }
        // Before anything else, and unconditionally: pruning is the last
        // step of building a fragment and every step before it can fail
        // (`publish_keyhive`, a storage write), which would leave a fragment
        // durable with its range still loose beside it. Re-running it here
        // costs one `minimize` and catches that on the next turn.
        let _pruned = self.storage.prune(tree);
        // The group document is plaintext by ruling (`crate::vault` module
        // docs), so its fragments are too; an app tree's are envelopes like
        // its commits.
        let enveloped = tree != us_tree();
        // A fragment whose head we already hold is one we have already built
        // or received — identity is head plus boundary
        // (`design/sedimentree.md`) and the tree is keyed by head, so two
        // devices with the same causal graph produce the same one and the
        // second is a no-op. Filtered *before* bundling: `bundle_fragments`
        // re-encodes every member of every fragment it is handed, so bundling
        // the whole history to throw all but the newest away would make each
        // mutation cost the whole document.
        let candidates: Vec<(automerge::Fragment, Vec<u8>)> = {
            let apps = self.documents.borrow();
            let doc: Option<&Document> = enveloped
                .then(|| apps.values().find(|doc| doc.tree() == tree))
                .flatten();
            if enveloped && doc.is_none() {
                return Ok(());
            }
            let fragments = match doc {
                Some(doc) => doc.fragments(),
                None => self.with_us(UsDoc::fragments),
            };
            let fresh: Vec<automerge::Fragment> = fragments
                .into_iter()
                .filter(|f| !self.storage.holds_fragment(tree, CommitId::new(f.head.0)))
                .collect();
            if fresh.is_empty() {
                return Ok(());
            }
            let bundles = match doc {
                Some(doc) => doc.bundle(fresh.clone()),
                None => self.with_us(|us| us.bundle(fresh.clone())),
            };
            fresh.into_iter().zip(bundles).collect()
        };
        for (fragment, bundle) in candidates {
            self.install_fragment(tree, &fragment, bundle, enveloped)
                .await?;
        }
        Ok(())
    }

    /// Put one fragment into the tree: seal it if the tree is enveloped, hand
    /// it to the driver, wait for it to be durable, move the frontier, and
    /// drop the loose commits it now carries.
    ///
    /// Shared by [`Engine::compact`], which builds fragments over ranges
    /// automerge closed on their own, and by [`Engine::adopt_fragment`],
    /// which builds one over a whole adopted history. The two differ only in
    /// where the `automerge::Fragment` came from; everything after that —
    /// including the ordering, which is what makes the drop safe — is this.
    async fn install_fragment(
        &self,
        tree: SedimentreeId,
        fragment: &automerge::Fragment,
        bundle: Vec<u8>,
        enveloped: bool,
    ) -> Result<(), String> {
        let head = CommitId::new(fragment.head.0);
        let boundary: BTreeSet<CommitId> = fragment
            .boundary
            .iter()
            .map(|hash| CommitId::new(hash.0))
            .collect();
        let checkpoints: Vec<CommitId> = fragment
            .checkpoints
            .iter()
            .map(|hash| CommitId::new(hash.0))
            .collect();
        let (blob, sealed) = if enveloped {
            let vault = self.require_vault()?;
            // What keeps the causal walk going below the fragment. The
            // boundary names the commits just under it, and for each one
            // the *carrier* is what has to be named: if we hold a
            // fragment headed at that commit, the thing a later reader
            // must be able to open is that fragment, under its own cref —
            // the boundary commit's own envelope was pruned along with
            // its range, and its content key left the frontier when it
            // was covered, so naming the commit would embed nothing at
            // all. `Vault::seal` embeds exactly those preds whose keys
            // this device still holds, and `Vault::confirm` then drops
            // them from the frontier, which is what keeps the head set
            // at one entry point per branch instead of one per fragment.
            let preds: Vec<[u8; 32]> = boundary
                .iter()
                .map(|id| {
                    if self.storage.holds_fragment(tree, *id) {
                        fragment_cref(tree, *id)
                    } else {
                        *id.as_bytes()
                    }
                })
                .collect();
            let sealed = vault
                .seal(fragment_cref(tree, head), &preds, bundle)
                .await?;
            (Blob::new(sealed.blob.clone()), Some(sealed))
        } else {
            (Blob::new(bundle), None)
        };
        self.handle
            .add_fragments(
                tree,
                vec![subduction_protocol::command::NewFragment {
                    head,
                    boundary,
                    checkpoints,
                    blob,
                }],
            )
            .await
            .map_err(|e| e.to_string())?;
        // The durability barrier `mutate` documents: the fragment must be
        // in storage before anything is dropped on the strength of it.
        let _heads = self
            .handle
            .tree_heads(tree)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(sealed) = sealed {
            let vault = self.require_vault()?;
            // `confirm` makes the fragment an entry point and drops the
            // preds it embedded — which is where the *previous* fragment
            // stops being one, since this envelope now carries its key.
            vault.confirm(&sealed);
            // And the members it carries stop being entry points too:
            // their changes are in the bundle (`Vault::cover`).
            vault.cover(fragment.members.iter().map(|hash| hash.0));
            self.publish_keyhive().await?;
        }
        let _pruned = self.storage.prune(tree);
        Ok(())
    }

    /// Replace an app commit's plaintext change with its keyhive envelope, so
    /// what reaches the driver, wire, relay and storage is ciphertext.
    async fn seal(
        &self,
        commit: subduction_protocol::command::NewCommit,
    ) -> Result<(subduction_protocol::command::NewCommit, vault::Sealed), String> {
        let vault = self.require_vault()?;
        let preds: Vec<[u8; 32]> = commit.parents.iter().map(|id| *id.as_bytes()).collect();
        let sealed = vault
            .seal(
                *commit.head.as_bytes(),
                &preds,
                commit.blob.as_slice().to_vec(),
            )
            .await?;
        Ok((
            subduction_protocol::command::NewCommit {
                blob: Blob::new(sealed.blob.clone()),
                ..commit
            },
            sealed,
        ))
    }

    /// Make sure this device holds a document for `app`, and that every live
    /// peer is syncing and subscribed to its tree.
    ///
    /// A device only learns of an app's tree by holding it: the tree id is
    /// derived from the partition id (see [`document_tree`]), so opening it is
    /// the discovery step, and both directions of a connection must ask for
    /// the tree before either sees the other's history. Every document access
    /// goes through here, which is why a session opening an app on a device
    /// that has never seen it pulls the other device's list.
    async fn open_document(&self, app: &str) -> Result<(), String> {
        self.hydrate().await?;
        // The group document names the keyhive document every app tree is
        // sealed to, so it is opened first even for a device whose caller only
        // ever asked about tasks.
        self.open_us().await?;
        if self.documents.borrow().contains_key(app) {
            return Ok(());
        }
        let tree = document_tree(app);
        {
            let doc = Document::empty(actor(b"polyvisor:actor:", self.seed, app.as_bytes()), tree);
            let _created = self.documents.borrow_mut().insert(app.to_string(), doc);
        }
        // The tree may already hold envelopes: a peer pushed them before this
        // device ever opened the app, and the event pump had no document to
        // put them in.
        let _absorbed = self.absorb(tree).await;
        // Cloned out of the cell first: `sync_tree` awaits into the driver,
        // and a borrow held across that await would collide with anything the
        // driver's own progress lets run.
        //
        // The document is in the map before this await, so a second caller
        // for the same app returns from the check above without waiting for
        // the subscription to be placed. That is deliberate: it reads an
        // empty-but-live document a moment early rather than blocking on the
        // network. A later service read observes what the event pump applies.
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
    ///
    /// Async because an app tree's blobs are keyhive envelopes and opening one
    /// is an async call into the vault. The `RefCell` borrows are taken and
    /// dropped around each await rather than across one.
    async fn absorb(&self, tree: SedimentreeId) -> bool {
        let landed = self.absorb_items(tree).await;
        if landed {
            // The second compaction trigger. Absorbing is how a device that
            // was behind catches up, and a batch of a few hundred commits is
            // exactly the case fragments exist for; a device that only ever
            // compacted its own writes would carry a peer's history loose
            // forever. Failure is not the caller's business — nothing here
            // is lost if the roll-up waits for the next batch.
            let _compacted = self.compact(tree).await;
        }
        landed
    }

    /// [`Engine::absorb`] without the compaction step: what actually applies
    /// the tree's stored items to its document.
    async fn absorb_items(&self, tree: SedimentreeId) -> bool {
        if tree == us_tree() {
            let landed = {
                let mut cell = self.us.borrow_mut();
                cell.as_mut().is_some_and(|doc| doc.absorb(&self.storage))
            };
            if landed {
                // A remote change to the group is a change to who may
                // connect at all: the policy's set moves with it.
                self.refresh_members();
                self.control_revision
                    .set(self.control_revision.get().saturating_add(1));
                // Synchronous admission refresh: no await may observe the new
                // control document with the old opaque eligibility map.
                self.refresh_opaque_admission();
            }
            return landed;
        }
        if tree == keyhive_tree() {
            return self.absorb_keyhive().await;
        }
        let Some(app) = self
            .documents
            .borrow()
            .iter()
            .find(|(_, doc)| doc.tree() == tree)
            .map(|(app, _)| app.clone())
        else {
            // A tree with no local document: this device has never opened
            // that app. The items stay in storage and are opened the moment
            // it does (`Document::load` on the next boot, or `open_document`).
            return false;
        };
        self.absorb_app(&app).await
    }

    /// Open one app document's outstanding envelopes and apply what came out.
    async fn absorb_app(&self, app: &str) -> bool {
        let Some(vault) = self.vault() else {
            // No keyhive yet, so nothing here can be opened. The envelopes
            // stay in storage and are tried again on the next event.
            return false;
        };
        let (wanted, bundles, tree, known) = {
            let apps = self.documents.borrow();
            let Some(doc) = apps.get(app) else {
                return false;
            };
            (
                self.storage
                    .commit_blobs(doc.tree())
                    .into_iter()
                    .filter(|(id, _)| !doc.contains(id))
                    .collect::<Vec<_>>(),
                self.storage
                    .fragment_blobs(doc.tree())
                    .into_iter()
                    .filter(|(id, _)| !doc.contains(id))
                    .collect::<Vec<_>>(),
                doc.tree(),
                doc.applied_ids()
                    .into_iter()
                    .map(|id| *id.as_bytes())
                    .collect(),
            )
        };
        if wanted.is_empty() && bundles.is_empty() {
            return false;
        }
        // Fragments first, as `Document::absorb` does and for the same
        // reason: a bundle that lands first turns every loose commit it
        // carries into a no-op. Their envelopes are keyed by the fragment
        // cref, not by the head — a fragment and its head commit are two
        // different plaintexts and may not share one content reference — so
        // the walk's answers are mapped back through `by_cref`.
        let by_cref: BTreeMap<[u8; 32], CommitId> = bundles
            .iter()
            .map(|(head, _)| (fragment_cref(tree, *head), *head))
            .collect();
        let opened_bundles = if bundles.is_empty() {
            Vec::new()
        } else {
            match vault
                .open(
                    bundles
                        .into_iter()
                        .map(|(head, blob)| (fragment_cref(tree, head), blob))
                        .collect(),
                    &known,
                )
                .await
            {
                Ok(opened) => opened
                    .into_iter()
                    .filter_map(|(cref, bundle)| Some((*by_cref.get(&cref)?, bundle)))
                    .collect(),
                Err(_) => Vec::new(),
            }
        };
        let Ok(opened) = vault
            .open(
                wanted
                    .into_iter()
                    .map(|(id, blob)| (*id.as_bytes(), blob))
                    .collect(),
                &known,
            )
            .await
        else {
            return false;
        };
        let (absorbed, tree, anchor) = {
            let mut apps = self.documents.borrow_mut();
            let Some(doc) = apps.get_mut(app) else {
                return false;
            };
            let from_fragments = doc.apply_bundles(opened_bundles);
            let mut absorbed = doc.apply(
                opened
                    .into_iter()
                    .map(|(id, change)| (CommitId::new(id), change))
                    .collect(),
            );
            absorbed.landed |= from_fragments.landed;
            absorbed.content |= from_fragments.content;
            // The partition case (`design/causal_encryption.md` §"Multiple
            // Heads"): what just landed was concurrent with what this device
            // already had, so it was sealed under an epoch some *other* member
            // may not hold — a device enrolled after that branch was written
            // can decrypt neither it nor anything automerge buffers behind it.
            // A merge anchor republishes the branch: its envelope names both
            // heads' content keys and is sealed under the current epoch, so
            // every current member walks in from it.
            //
            // Only for content, and only on divergence. A batch that is itself
            // nothing but somebody else's anchor is not a reason to author
            // one, which is what stops two devices anchoring each other
            // forever.
            let anchor = (absorbed.content && doc.diverged())
                .then(|| doc.merge_anchor())
                .flatten();
            (absorbed, doc.tree(), anchor)
        };
        if let Some(anchor) = anchor
            && let Ok((anchor, sealed)) = self.seal(anchor).await
        {
            let pushed = self.handle.add_commits(tree, vec![anchor]).await;
            if pushed.is_ok() {
                let _heads = self.handle.tree_heads(tree).await;
                vault.confirm(&sealed);
                let _published = self.publish_keyhive().await;
            }
        }
        absorbed.landed
    }

    /// Ingest the group's keyhive operations, then retry every app document:
    /// what just arrived is exactly the material that turns a blob this device
    /// could not open into one it can.
    async fn absorb_keyhive(&self) -> bool {
        let Some(vault) = self.vault() else {
            return false;
        };
        let mut ingested = false;
        for (id, blob) in self.storage.commit_blobs(keyhive_tree()) {
            if vault.unseen(*id.as_bytes()) && vault.ingest(&blob).await.is_ok() {
                ingested = true;
            }
        }
        if !ingested {
            return false;
        }
        let apps: Vec<String> = self.documents.borrow().keys().cloned().collect();
        let mut landed = false;
        for app in apps {
            landed |= self.absorb_app(&app).await;
        }
        landed
    }

    /// The app's document. Synchronous, and the borrow never crosses an
    /// await.
    ///
    /// Every caller runs [`Engine::open_app`] first, which is what creates the
    /// document *and* subscribes the live peers to its tree. Creating one
    /// here as a fallback would paper over a caller that skipped that, and
    /// hand back a document nothing is syncing.
    fn with_document<R>(
        &self,
        app: &str,
        f: impl FnOnce(&mut Document) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut apps = self.documents.borrow_mut();
        let doc = apps
            .get_mut(app)
            .ok_or_else(|| format!("no document is open for {app}"))?;
        f(doc)
    }
}

/// Where a fragment's envelope lives in the vault: `blake3("polyvisor:fragment"
/// ‖ tree ‖ head)`.
///
/// Not the head itself, which is what a fragment is *named* by. A content
/// reference indexes one plaintext in keyhive's ciphertext store, and the head
/// commit already owns that reference for its own change; a fragment stored
/// under it would collide with the commit whose range it closes — the walk
/// would find one where it wanted the other, and the key it holds would open
/// neither reliably. Domain-separated so the two can never coincide.
fn fragment_cref(tree: SedimentreeId, head: CommitId) -> [u8; 32] {
    *blake3::Hasher::new()
        .update(b"polyvisor:fragment")
        .update(tree.as_bytes())
        .update(head.as_bytes())
        .finalize()
        .as_bytes()
}

/// Decode a store object's envelope, check the signature, and check the
/// issuer is one of `members`. The half of [`Engine::accept`] that does not
/// depend on which item kind it is.
///
/// `try_verify`, not the trusted-storage decode: the trusted decode reads the
/// fields of an envelope nobody has checked, which is exactly the situation it
/// documents itself as being wrong for.
fn verify<T>(signed: &[u8], members: &std::collections::BTreeSet<[u8; 32]>) -> Option<T>
where
    T: sedimentree_core::codec::schema::Schema
        + sedimentree_core::codec::encode::EncodeFields
        + sedimentree_core::codec::decode::DecodeFields
        + Clone,
{
    let signed = subduction_crypto::signed::Signed::<T>::try_decode(signed).ok()?;
    let verified = signed.try_verify().ok()?;
    if !members.contains(&verified.issuer().to_bytes()) {
        return None;
    }
    Some(verified.payload().clone())
}

fn valid_item(members: &BTreeSet<[u8; 32]>, item: &StoreItem) -> bool {
    let tree = SedimentreeId::new(item.tree);
    let id = CommitId::new(item.commit);
    let blob = BlobMeta::new(&Blob::new(item.blob.clone()));
    match item.kind {
        ItemKind::Commit => {
            verify::<sedimentree_core::loose_commit::LooseCommit>(&item.signed, members)
                .is_some_and(|payload| {
                    payload.sedimentree_id() == tree
                        && payload.head() == id
                        && *payload.blob_meta() == blob
                })
        }
        ItemKind::Fragment => {
            if is_opaque_tree(&item.tree) {
                return false;
            }
            verify::<sedimentree_core::fragment::Fragment>(&item.signed, members).is_some_and(
                |payload| {
                    payload.sedimentree_id() == tree
                        && payload.head() == id
                        && payload.summary().blob_meta() == blob
                },
            )
        }
    }
}

fn raw_cref(tree: [u8; 32], id: [u8; 32]) -> [u8; 32] {
    *blake3::Hasher::new()
        .update(b"polyvisor:opaque-cref:v1\0")
        .update(&tree)
        .update(&id)
        .finalize()
        .as_bytes()
}

const CATALOG_PREFIX: &[u8; 4] = b"PVC1";
const CATALOG_BATCH_TREES: usize = 1024;

fn encode_catalog(trees: &[SedimentreeId]) -> Vec<Vec<u8>> {
    let batches = trees.len().div_ceil(CATALOG_BATCH_TREES).max(1);
    (0..batches)
        .map(|index| {
            let start = index * CATALOG_BATCH_TREES;
            let end = trees.len().min(start + CATALOG_BATCH_TREES);
            let chunk = &trees[start..end];
            let mut out = Vec::with_capacity(5 + chunk.len() * 32);
            out.extend_from_slice(CATALOG_PREFIX);
            out.push(u8::from(index + 1 == batches));
            for tree in chunk {
                out.extend_from_slice(tree.as_bytes());
            }
            out
        })
        .collect()
}

fn decode_catalog(bytes: &[u8]) -> Option<(bool, Vec<SedimentreeId>)> {
    let payload = bytes.strip_prefix(CATALOG_PREFIX)?;
    let (&final_batch, payload) = payload.split_first()?;
    if final_batch > 1 || payload.len() % 32 != 0 || payload.len() / 32 > CATALOG_BATCH_TREES {
        return None;
    }
    let (chunks, remainder) = payload.as_chunks::<32>();
    if !remainder.is_empty() {
        return None;
    }
    let trees: Vec<_> = chunks
        .iter()
        .map(|chunk| SedimentreeId::new(*chunk))
        .collect();
    if trees
        .iter()
        .any(|tree| *tree == us_tree() || *tree == keyhive_tree())
    {
        return None;
    }
    Some((final_batch == 1, trees))
}

fn retain_catalog(
    complete: &mut BTreeMap<subduction_protocol::id::ConnId, Vec<SedimentreeId>>,
    pending: &mut BTreeMap<subduction_protocol::id::ConnId, Vec<SedimentreeId>>,
    conn: subduction_protocol::id::ConnId,
    registered: bool,
    member: bool,
    bytes: &[u8],
) -> bool {
    if !registered || !member || complete.contains_key(&conn) {
        return false;
    }
    let Some((final_batch, trees)) = decode_catalog(bytes) else {
        pending.remove(&conn);
        return false;
    };
    let accumulated = pending.entry(conn).or_default();
    accumulated.extend(trees);
    if !final_batch {
        return false;
    }
    let mut trees = pending.remove(&conn).unwrap_or_default();
    trees.sort_unstable();
    trees.dedup();
    complete.insert(conn, trees);
    true
}

fn ready_catalog(
    phase: Option<ControlPhase>,
    catalog: Option<Vec<SedimentreeId>>,
) -> Option<Vec<SedimentreeId>> {
    (phase == Some(ControlPhase::Ready))
        .then_some(catalog)
        .flatten()
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

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use subduction_protocol::id::ConnId;

    #[test]
    fn catalog_batches_preserve_more_than_one_message_of_trees() {
        let trees: Vec<_> = (0..2050u32)
            .map(|index| {
                let mut id = [0; 32];
                id[..4].copy_from_slice(&index.to_be_bytes());
                SedimentreeId::new(id)
            })
            .collect();
        let batches = encode_catalog(&trees);
        assert_eq!(batches.len(), 3);
        let conn = ConnId::new(8);
        let mut complete = BTreeMap::new();
        let mut pending = BTreeMap::new();
        for (index, batch) in batches.iter().enumerate() {
            let completed = retain_catalog(&mut complete, &mut pending, conn, true, true, batch);
            assert_eq!(completed, index + 1 == batches.len());
        }
        assert_eq!(complete.get(&conn), Some(&trees));
        assert!(!decode_catalog(&batches[0]).unwrap().0);
        assert!(decode_catalog(&batches[2]).unwrap().0);
    }

    #[test]
    fn early_catalog_is_retained_until_local_phase_can_use_it() {
        let conn = ConnId::new(7);
        let trees = vec![SedimentreeId::new([7; 32])];
        let message = encode_catalog(&trees).pop().unwrap();
        let mut complete = BTreeMap::new();
        let mut pending = BTreeMap::new();

        // `registered` represents AwaitUs/AwaitKeyhive as well as Ready. The
        // handler retains this before its later `maybe_sync_catalog` Ready
        // guard, so an early one-shot catalog is not lost.
        assert!(retain_catalog(
            &mut complete,
            &mut pending,
            conn,
            true,
            true,
            &message,
        ));
        assert_eq!(complete.get(&conn), Some(&trees));
        assert_eq!(
            ready_catalog(
                Some(ControlPhase::AwaitKeyhive),
                complete.get(&conn).cloned()
            ),
            None,
            "an early catalog is retained but cannot be used before local control is ready"
        );
        assert_eq!(
            ready_catalog(Some(ControlPhase::Ready), complete.get(&conn).cloned()),
            Some(trees),
        );
    }
}
