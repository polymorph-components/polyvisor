//! Sedimentree item storage that can be snapshotted into the kernel's sealed
//! checkpoint and restored from it.
//!
//! `subduction_runtime::memory::storage::MemoryStorage` has the right shape
//! but exposes only its commit *ids* (test introspection), so it cannot be
//! serialized; this is that shape with the two accessors the engine needs —
//! the stored bytes, and the decoded metadata `hydrate_tree` wants on a
//! restore.
//!
//! Items are held as their signed wire bytes rather than as decoded values:
//! `Signed<T>` is a self-describing envelope with `as_bytes`/`try_decode`
//! (legacy/subduction_crypto/src/signed.rs:118), so a snapshot preserves the
//! original author's signature exactly. Re-signing a peer's commit on
//! restore would be cheaper and is what replaying the automerge history would
//! do — and it would quietly relabel their authorship as ours.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use future_form::{FutureForm as _, Local};
use futures::future::LocalBoxFuture;
use sedimentree_core::{
    depth::CountLeadingZeroBytes,
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
    sedimentree::Sedimentree,
};
use serde::{Deserialize, Serialize};
use subduction_crypto::signed::Signed;
use subduction_protocol::storage::StorageFailure;
use subduction_runtime::storage::{FetchedItems, Storage};

/// Everything needed to reconstruct an engine, for the kernel's checkpoint.
///
/// The device's seed is deliberately not here: the kernel holds it, in the
/// same sealed checkpoint, and hands it to `Engine::new`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub apps: Vec<AppState>,
    /// The user-system document and its tree.
    pub us: Option<TreeState>,
    /// The keyhive-events tree (`crate::keyhive_tree`): the membership and
    /// CGKA operations that let this device's peers open its envelopes. It has
    /// no automerge document — `TreeState::doc` is empty — because its commits
    /// *are* the state.
    pub keyhive: Option<TreeState>,
    /// This device's keyhive itself, including secrets. Sealed with the rest
    /// of the checkpoint.
    pub vault: Option<crate::vault::VaultState>,
    /// The group's store-name key (docs/design.md M4, the Drive record): the
    /// 32 bytes every name in the user's own store is HMAC'd under, so two
    /// devices of one group derive the same names and nobody else derives any
    /// of them. Minted with the group and carried to a joiner inside ENROLL,
    /// which is why it rests here rather than being derived from the seed:
    /// it belongs to the *group*, and the seed is one device's.
    ///
    /// `None` while a device has not opened its group document.
    pub name_key: Option<[u8; 32]>,
    /// Raw opaque trees. Their lifecycle descriptors are in `us`; only trees
    /// current at snapshot time are emitted here.
    #[serde(default)]
    pub opaque: Vec<OpaqueState>,
    #[serde(default)]
    pub unbound: Vec<UnboundState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpaqueState {
    pub tree: [u8; 32],
    pub commits: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnboundState {
    pub tree: [u8; 32],
    pub commits: Vec<Item>,
    pub fragments: Vec<Item>,
}

/// One app's document and the tree behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppState {
    pub app: String,
    #[serde(flatten)]
    pub state: TreeState,
    /// Signed Keyhive operations scoped to this shareable document.
    #[serde(default)]
    pub authority: Vec<Item>,
}

/// One document and the sedimentree items backing it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeState {
    /// `automerge::Automerge::save` bytes.
    pub doc: Vec<u8>,
    pub commits: Vec<Item>,
    pub fragments: Vec<Item>,
}

/// Which sedimentree item a [`StoreItem`] carries.
///
/// The store is names plus opaque bytes, but the two item kinds decode into
/// different envelopes (`Signed<LooseCommit>` vs `Signed<Fragment>`) and are
/// checked differently, so the record has to say which it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    /// One automerge change.
    Commit,
    /// A roll-up of a commit range: one automerge bundle.
    Fragment,
}

/// A stored sedimentree item: its signed envelope and its payload blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub signed: Vec<u8>,
    pub blob: Vec<u8>,
}

/// One sedimentree item as the durable store carries it: the tree and item id
/// that name it, and the bytes.
///
/// Ids are raw bytes rather than `SedimentreeId`/`CommitId` so the kernel can
/// name, serialize and re-ingest an item without depending on sedimentree's
/// types at all — the store is addressing plus opaque bytes to it, and that
/// is the whole of what it should know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreItem {
    pub tree: [u8; 32],
    /// The commit id for a commit, the head for a fragment.
    pub commit: [u8; 32],
    pub signed: Vec<u8>,
    pub blob: Vec<u8>,
    pub kind: ItemKind,
}

impl StoreItem {
    pub fn key(&self) -> ([u8; 32], [u8; 32], ItemKind) {
        (self.tree, self.commit, self.kind)
    }
}

/// Map-backed item storage. Interior mutability is a `RefCell`: the driver
/// task is the only accessor, and this crate is single-threaded throughout.
#[derive(Debug, Default)]
pub struct SnapshotStorage {
    trees: RefCell<BTreeMap<SedimentreeId, Tree>>,
    pending: RefCell<Vec<crate::StorageMutation>>,
    settled: Cell<usize>,
    lifecycle: crate::opaque::Lifecycle,
    shared: RefCell<Option<crate::policy::SharedAuthorities>>,
}

#[derive(Debug, Default)]
struct Tree {
    commits: BTreeMap<CommitId, (Signed<LooseCommit>, Vec<u8>)>,
    fragments: BTreeMap<CommitId, (Signed<Fragment>, Vec<u8>)>,
}

impl SnapshotStorage {
    pub(crate) fn new(lifecycle: crate::opaque::Lifecycle) -> Self {
        Self {
            trees: RefCell::new(BTreeMap::new()),
            pending: RefCell::new(Vec::new()),
            settled: Cell::new(0),
            lifecycle,
            shared: RefCell::new(None),
        }
    }

    pub(crate) fn set_shared_authorities(&self, shared: crate::policy::SharedAuthorities) {
        *self.shared.borrow_mut() = Some(shared);
    }

    fn shared_authorized<T>(&self, tree: SedimentreeId, signed: &Signed<T>) -> bool
    where
        T: sedimentree_core::codec::schema::Schema
            + sedimentree_core::codec::encode::EncodeFields
            + sedimentree_core::codec::decode::DecodeFields,
    {
        let shared = self.shared.borrow();
        let Some(authority) = shared
            .as_ref()
            .and_then(|shared| shared.borrow().get(&tree).cloned())
        else {
            // The reserved namespace must fail closed even before a descriptor
            // arrives; otherwise own-group authority treats an unknown shared
            // tree as an ordinary private partition.
            return !matches!(
                tree.as_bytes()[0],
                crate::SHARED_TREE_TAG | crate::SHARED_AUTHORITY_TREE_TAG
            );
        };
        if tree.as_bytes()[0] == crate::SHARED_AUTHORITY_TREE_TAG {
            authority.readers.contains(&signed.issuer().to_bytes())
        } else {
            authority.editors.contains(&signed.issuer().to_bytes())
        }
    }
    /// Every stored commit of `tree` as `(id, blob)`, for the automerge
    /// document to apply what it has not seen.
    pub fn commit_blobs(&self, tree: SedimentreeId) -> Vec<(CommitId, Vec<u8>)> {
        self.trees
            .borrow()
            .get(&tree)
            .map(|t| {
                t.commits
                    .iter()
                    .map(|(id, (_signed, blob))| (*id, blob.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every stored fragment of `tree` as `(head, blob)`. The blob is an
    /// automerge *bundle* (or, on an app tree, an envelope around one) —
    /// see `polyvisor_document_history::Document::apply_bundles`.
    pub fn fragment_blobs(&self, tree: SedimentreeId) -> Vec<(CommitId, Vec<u8>)> {
        self.trees
            .borrow()
            .get(&tree)
            .map(|t| {
                t.fragments
                    .iter()
                    .map(|(head, (_signed, blob))| (*head, blob.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether `tree` already holds a fragment headed at `head`. What
    /// compaction asks before building one: a fragment is identified by its
    /// head, so a head we hold is a fragment we have already built or
    /// received.
    pub fn holds_fragment(&self, tree: SedimentreeId, head: CommitId) -> bool {
        self.trees
            .borrow()
            .get(&tree)
            .is_some_and(|t| t.fragments.contains_key(&head))
    }

    /// Every item of every tree, as the durable store carries them.
    ///
    /// What the durable store pushes (docs/design.md "Storage"): one object
    /// per item, content-addressed by the pair that names it. Fragments go up
    /// beside commits — a device that pulls one gets the whole range in a
    /// single object, which is the saving compaction exists for.
    pub fn all_items(&self) -> Vec<StoreItem> {
        self.trees
            .borrow()
            .iter()
            .filter(|(tree, _)| {
                crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(false)
            })
            .flat_map(|(tree, t)| {
                let commits = t.commits.iter().map(|(id, (signed, blob))| StoreItem {
                    tree: *tree.as_bytes(),
                    commit: *id.as_bytes(),
                    signed: signed.as_bytes().to_vec(),
                    blob: blob.clone(),
                    kind: ItemKind::Commit,
                });
                let fragments = t.fragments.iter().map(|(head, (signed, blob))| StoreItem {
                    tree: *tree.as_bytes(),
                    commit: *head.as_bytes(),
                    signed: signed.as_bytes().to_vec(),
                    blob: blob.clone(),
                    kind: ItemKind::Fragment,
                });
                commits.chain(fragments).collect::<Vec<_>>()
            })
            .collect()
    }

    /// Compute the bincode size of `Vec<StoreItem>` for one tree without
    /// cloning any payload, then clone only if it fits.
    pub fn inline_items(
        &self,
        tree: SedimentreeId,
        budget: usize,
    ) -> Result<Option<Vec<StoreItem>>, String> {
        let trees = self.trees.borrow();
        let Some(stored) = trees.get(&tree) else {
            return Ok(Some(Vec::new()));
        };
        let count = stored.commits.len() + stored.fragments.len();
        let mut size = bincode::serialized_size(&vec![(); count]).map_err(|e| e.to_string())?;
        for (id, (signed, blob)) in &stored.commits {
            let item = StoreItemRef {
                tree: tree.as_bytes(),
                commit: id.as_bytes(),
                signed: signed.as_bytes(),
                blob,
                kind: ItemKind::Commit,
            };
            size = size
                .checked_add(bincode::serialized_size(&item).map_err(|e| e.to_string())?)
                .ok_or_else(|| "inline item size overflow".to_string())?;
            if size > budget as u64 {
                return Ok(None);
            }
        }
        for (id, (signed, blob)) in &stored.fragments {
            let item = StoreItemRef {
                tree: tree.as_bytes(),
                commit: id.as_bytes(),
                signed: signed.as_bytes(),
                blob,
                kind: ItemKind::Fragment,
            };
            size = size
                .checked_add(bincode::serialized_size(&item).map_err(|e| e.to_string())?)
                .ok_or_else(|| "inline item size overflow".to_string())?;
            if size > budget as u64 {
                return Ok(None);
            }
        }
        let commits = stored.commits.iter().map(|(id, (signed, blob))| StoreItem {
            tree: *tree.as_bytes(),
            commit: *id.as_bytes(),
            signed: signed.as_bytes().to_vec(),
            blob: blob.clone(),
            kind: ItemKind::Commit,
        });
        let fragments = stored
            .fragments
            .iter()
            .map(|(id, (signed, blob))| StoreItem {
                tree: *tree.as_bytes(),
                commit: *id.as_bytes(),
                signed: signed.as_bytes().to_vec(),
                blob: blob.clone(),
                kind: ItemKind::Fragment,
            });
        Ok(Some(commits.chain(fragments).collect()))
    }

    /// Whether `tree` holds `commit`.
    pub fn holds(&self, tree: SedimentreeId, commit: CommitId) -> bool {
        self.trees
            .borrow()
            .get(&tree)
            .is_some_and(|t| t.commits.contains_key(&commit))
    }

    /// Drop every loose commit of `tree` that a fragment we hold carries.
    ///
    /// The decision is sedimentree's own, not ours:
    /// `Sedimentree::minimize(&CountLeadingZeroBytes)` keeps a loose commit
    /// unless every range it belongs to is covered by a kept fragment
    /// (sedimentree_core/src/sedimentree/commit_dag.rs:128). Anything it
    /// keeps stays, so a commit concurrent with the range — a branch this
    /// device could not see when it built the fragment — is never dropped.
    ///
    /// **The invariant this adds on top.** `minimize` is asked only about
    /// *anchored* fragments: those whose every boundary id is the head of
    /// another fragment we hold, plus those whose boundary is empty (they
    /// reach the root). A fragment whose boundary hangs on a commit we hold
    /// nothing for is a fragment nobody can walk below, and letting it
    /// authorise a drop would strand the commits under it — readable in the
    /// document, gone from the tree, and with no item left naming a way down.
    /// That is not hypothetical once fragments arrive from peers, where a
    /// middle one of a chain can turn up before the one under it.
    ///
    /// Fragments themselves are only ever added here, never removed.
    /// `minimize` would also drop a level-1 fragment subsumed by a level-2
    /// one, and level-2 fragments do exist (one commit in 65 536) — not
    /// dropping them is the conservative side of that trade: a redundant
    /// item costs storage and a little sync chatter, and dropping one on a
    /// judgement this code did not make could cost the range it carried.
    ///
    /// Answers how many commits went.
    pub fn prune(&self, tree: SedimentreeId) -> usize {
        let (commits, fragments) = self.metadata(tree);
        let heads: BTreeSet<CommitId> = fragments.iter().map(Fragment::head).collect();
        let anchored: Vec<Fragment> = fragments
            .into_iter()
            .filter(|f| f.boundary().iter().all(|id| heads.contains(id)))
            .collect();
        if anchored.is_empty() {
            return 0;
        }
        let keep = Sedimentree::new(anchored, commits).minimize(&CountLeadingZeroBytes);
        let kept: BTreeSet<CommitId> = keep.loose_commits().map(LooseCommit::head).collect();
        let mut trees = self.trees.borrow_mut();
        let Some(entry) = trees.get_mut(&tree) else {
            return 0;
        };
        let doomed: Vec<CommitId> = entry
            .commits
            .keys()
            .filter(|id| !kept.contains(id))
            .copied()
            .collect();
        for id in &doomed {
            let _dropped = entry.commits.remove(id);
            self.pending
                .borrow_mut()
                .push(crate::StorageMutation::Remove {
                    tree: *tree.as_bytes(),
                    commit: *id.as_bytes(),
                    kind: ItemKind::Commit,
                });
        }
        doomed.len()
    }

    /// The tree's decoded metadata, for `Handle::hydrate_tree` after a
    /// restore. Items that no longer decode are dropped: a resident tree
    /// missing an item re-syncs it, where a decode panic would lose the
    /// device.
    pub fn metadata(&self, tree: SedimentreeId) -> (Vec<LooseCommit>, Vec<Fragment>) {
        let trees = self.trees.borrow();
        let Some(t) = trees.get(&tree) else {
            return (Vec::new(), Vec::new());
        };
        (
            t.commits
                .values()
                .filter_map(|(signed, _)| signed.try_decode_trusted_payload().ok())
                .collect(),
            t.fragments
                .values()
                .filter_map(|(signed, _)| signed.try_decode_trusted_payload().ok())
                .collect(),
        )
    }

    /// Reinstate a snapshot's items for one tree. Items whose envelope no
    /// longer decodes are skipped, as in [`Self::metadata`].
    pub fn restore(&self, tree: SedimentreeId, commits: Vec<Item>, fragments: Vec<Item>) {
        let opaque = crate::opaque::is_opaque_tree(tree.as_bytes());
        if opaque
            && (crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(true)
                || !fragments.is_empty())
        {
            return;
        }
        let mut accepted_commits = Vec::new();
        for item in commits {
            if let Ok(signed) = Signed::<LooseCommit>::try_decode(&item.signed)
                && let Ok(payload) = signed.try_decode_trusted_payload()
                && (!opaque
                    || crate::opaque::mode(&self.lifecycle, tree.as_bytes())
                        != Some(crate::opaque::OpaqueMode::CallerEncrypted)
                    || valid_raw_commit(tree, &payload, &item.blob))
            {
                accepted_commits.push((payload.head(), signed, item.blob));
            }
        }
        let mut accepted_fragments = Vec::new();
        for item in fragments {
            if let Ok(signed) = Signed::<Fragment>::try_decode(&item.signed)
                && let Ok(payload) = signed.try_decode_trusted_payload()
            {
                accepted_fragments.push((payload.head(), signed, item.blob));
            }
        }
        // Eligibility is checked again at the execution point, immediately
        // before mutating storage.
        if opaque && crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(true) {
            return;
        }
        let mut trees = self.trees.borrow_mut();
        let entry = trees.entry(tree).or_default();
        for (head, signed, blob) in accepted_commits {
            let _previous = entry.commits.insert(head, (signed, blob));
            let item = entry.commits.get(&head).expect("just inserted");
            self.pending
                .borrow_mut()
                .push(crate::StorageMutation::Put(StoreItem {
                    tree: *tree.as_bytes(),
                    commit: *head.as_bytes(),
                    signed: item.0.as_bytes().to_vec(),
                    blob: item.1.clone(),
                    kind: ItemKind::Commit,
                }));
        }
        for (head, signed, blob) in accepted_fragments {
            let _previous = entry.fragments.insert(head, (signed, blob));
            let item = entry.fragments.get(&head).expect("just inserted");
            self.pending
                .borrow_mut()
                .push(crate::StorageMutation::Put(StoreItem {
                    tree: *tree.as_bytes(),
                    commit: *head.as_bytes(),
                    signed: item.0.as_bytes().to_vec(),
                    blob: item.1.clone(),
                    kind: ItemKind::Fragment,
                }));
        }
    }

    /// Drop every item of `tree`. The engine's answer to adopting another
    /// device's user-system document: the group-of-one document this device
    /// was carrying is discarded, and its commits must go with it — left in
    /// place they would be absorbed back into the adopted document (a
    /// different automerge lineage) and pushed to the group on the first
    /// sync.
    pub fn forget_tree(&self, tree: SedimentreeId) {
        let _removed = self.trees.borrow_mut().remove(&tree);
        self.pending
            .borrow_mut()
            .push(crate::StorageMutation::ForgetTree(*tree.as_bytes()));
    }

    pub(crate) fn settled_len(&self) -> usize {
        self.settled.get()
    }
    pub(crate) fn pending_prefix(&self, len: usize) -> Vec<crate::StorageMutation> {
        self.pending.borrow()[..len].to_vec()
    }
    pub(crate) fn acknowledge(&self, len: usize) {
        self.pending.borrow_mut().drain(..len);
        self.settled.set(self.settled.get().saturating_sub(len));
    }
    pub(crate) fn mark_restored(&self) {
        self.pending.borrow_mut().clear();
        self.settled.set(0);
    }
    pub(crate) fn settle(&self) {
        self.settled.set(self.pending.borrow().len());
    }
    pub(crate) fn has_unsettled(&self) -> bool {
        self.pending.borrow().len() > self.settled.get()
    }

    /// The whole store, keyed by the app ids the caller supplies alongside
    /// each tree and its saved document.
    pub fn snapshot(
        &self,
        apps: impl Iterator<Item = (String, SedimentreeId, Vec<u8>)>,
        us: Option<(SedimentreeId, Vec<u8>)>,
        keyhive: Option<SedimentreeId>,
        vault: Option<crate::vault::VaultState>,
        name_key: Option<[u8; 32]>,
    ) -> Snapshot {
        Snapshot {
            apps: apps
                .map(|(app, tree, doc)| AppState {
                    authority: crate::shared_document(&app)
                        .ok()
                        .flatten()
                        .map(|_| {
                            self.tree_state(crate::shared_authority_tree(&app), Vec::new())
                                .commits
                        })
                        .unwrap_or_default(),
                    app,
                    state: self.tree_state(tree, doc),
                })
                .collect(),
            us: us.map(|(tree, doc)| self.tree_state(tree, doc)),
            keyhive: keyhive.map(|tree| self.tree_state(tree, Vec::new())),
            vault,
            name_key,
            opaque: self
                .trees
                .borrow()
                .iter()
                .filter(|(tree, _)| {
                    crate::opaque::status(&self.lifecycle, tree.as_bytes()) == Some(true)
                })
                .map(|(tree, stored)| OpaqueState {
                    tree: *tree.as_bytes(),
                    commits: items(stored.commits.values()),
                })
                .collect(),
            unbound: Vec::new(),
        }
    }

    fn tree_state(&self, tree: SedimentreeId, doc: Vec<u8>) -> TreeState {
        let trees = self.trees.borrow();
        let stored = trees.get(&tree);
        TreeState {
            doc,
            commits: stored
                .map(|t| items(t.commits.values()))
                .unwrap_or_default(),
            fragments: stored
                .map(|t| items(t.fragments.values()))
                .unwrap_or_default(),
        }
    }
}

#[derive(Serialize)]
struct StoreItemRef<'a> {
    tree: &'a [u8; 32],
    commit: &'a [u8; 32],
    signed: &'a [u8],
    blob: &'a [u8],
    kind: ItemKind,
}

fn items<'a, T>(stored: impl Iterator<Item = &'a (Signed<T>, Vec<u8>)>) -> Vec<Item>
where
    T: 'a
        + sedimentree_core::codec::schema::Schema
        + sedimentree_core::codec::encode::EncodeFields
        + sedimentree_core::codec::decode::DecodeFields,
{
    stored
        .map(|(signed, blob)| Item {
            signed: signed.as_bytes().to_vec(),
            blob: blob.clone(),
        })
        .collect()
}

impl Storage<Local> for SnapshotStorage {
    fn persist_items(
        &self,
        tree: SedimentreeId,
        commits: Vec<(Signed<LooseCommit>, Vec<u8>)>,
        fragments: Vec<(Signed<Fragment>, Vec<u8>)>,
    ) -> LocalBoxFuture<'_, Result<u32, StorageFailure>> {
        Local::from_future(async move {
            if crate::opaque::is_opaque_tree(tree.as_bytes()) {
                if crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(true) {
                    return Err(StorageFailure::Retryable);
                }
                if !fragments.is_empty() {
                    return Err(StorageFailure::Permanent);
                }
            }
            let mut trees = self.trees.borrow_mut();
            let entry = trees.entry(tree).or_default();
            let mut stored = 0u32;
            for (signed, blob) in commits {
                if !self.shared_authorized(tree, &signed) {
                    return Err(StorageFailure::Permanent);
                }
                let Ok(payload) = signed.try_decode_trusted_payload() else {
                    return Err(StorageFailure::Permanent);
                };
                if payload.sedimentree_id() != tree
                    || *payload.blob_meta()
                        != sedimentree_core::blob::BlobMeta::new(
                            &sedimentree_core::blob::Blob::new(blob.clone()),
                        )
                {
                    return Err(StorageFailure::Permanent);
                }
                if tree.as_bytes()[0] == crate::SHARED_TREE_TAG {
                    let Ok(ciphertext) = bincode::deserialize::<crate::vault::Ciphertext>(&blob)
                    else {
                        return Err(StorageFailure::Permanent);
                    };
                    let cref = crate::shared_cref(tree, *payload.head().as_bytes());
                    let preds: Vec<_> = payload
                        .parents()
                        .iter()
                        .map(|parent| crate::shared_cref(tree, *parent.as_bytes()))
                        .collect();
                    if ciphertext.content_ref != cref
                        || ciphertext.pred_refs != keyhive_crypto::digest::Digest::hash(&preds)
                    {
                        return Err(StorageFailure::Permanent);
                    }
                }
                if crate::opaque::is_opaque_tree(tree.as_bytes())
                    && crate::opaque::mode(&self.lifecycle, tree.as_bytes())
                        == Some(crate::opaque::OpaqueMode::CallerEncrypted)
                    && !valid_raw_commit(tree, &payload, &blob)
                {
                    return Err(StorageFailure::Permanent);
                }
                let _previous = entry.commits.insert(payload.head(), (signed, blob));
                let stored_item = entry.commits.get(&payload.head()).expect("just inserted");
                self.pending
                    .borrow_mut()
                    .push(crate::StorageMutation::Put(StoreItem {
                        tree: *tree.as_bytes(),
                        commit: *payload.head().as_bytes(),
                        signed: stored_item.0.as_bytes().to_vec(),
                        blob: stored_item.1.clone(),
                        kind: ItemKind::Commit,
                    }));
                stored += 1;
            }
            for (signed, blob) in fragments {
                if matches!(
                    tree.as_bytes()[0],
                    crate::SHARED_TREE_TAG | crate::SHARED_AUTHORITY_TREE_TAG
                ) || !self.shared_authorized(tree, &signed)
                {
                    return Err(StorageFailure::Permanent);
                }
                let Ok(payload) = signed.try_decode_trusted_payload() else {
                    return Err(StorageFailure::Permanent);
                };
                let _previous = entry.fragments.insert(payload.head(), (signed, blob));
                let stored_item = entry.fragments.get(&payload.head()).expect("just inserted");
                self.pending
                    .borrow_mut()
                    .push(crate::StorageMutation::Put(StoreItem {
                        tree: *tree.as_bytes(),
                        commit: *payload.head().as_bytes(),
                        signed: stored_item.0.as_bytes().to_vec(),
                        blob: stored_item.1.clone(),
                        kind: ItemKind::Fragment,
                    }));
                stored += 1;
            }
            Ok(stored)
        })
    }

    fn fetch_items(
        &self,
        tree: SedimentreeId,
        commit_ids: Vec<CommitId>,
        fragment_heads: Vec<CommitId>,
    ) -> LocalBoxFuture<'_, Result<Option<FetchedItems>, StorageFailure>> {
        Local::from_future(async move {
            if crate::opaque::is_opaque_tree(tree.as_bytes())
                && crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(true)
            {
                return Ok(None);
            }
            let trees = self.trees.borrow();
            let Some(t) = trees.get(&tree) else {
                return Ok(None);
            };
            let mut items = FetchedItems::default();
            for id in commit_ids {
                if let Some(found) = t.commits.get(&id) {
                    items.commits.push(found.clone());
                }
            }
            for head in fragment_heads {
                if let Some(found) = t.fragments.get(&head) {
                    items.fragments.push(found.clone());
                }
            }
            Ok(Some(items))
        })
    }

    fn delete_tree(&self, tree: SedimentreeId) -> LocalBoxFuture<'_, Result<(), StorageFailure>> {
        Local::from_future(async move {
            let _removed = self.trees.borrow_mut().remove(&tree);
            self.pending
                .borrow_mut()
                .push(crate::StorageMutation::ForgetTree(*tree.as_bytes()));
            Ok(())
        })
    }
}

fn valid_raw_commit(tree: SedimentreeId, payload: &LooseCommit, blob: &[u8]) -> bool {
    let mut parents: Vec<_> = payload
        .parents()
        .iter()
        .map(|parent| *parent.as_bytes())
        .collect();
    parents.sort_unstable();
    parents.dedup();
    parents.len() == payload.parents().len()
        && crate::opaque::item_id(*tree.as_bytes(), &parents, blob) == *payload.head().as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opaque::{LifecycleState, OpaqueMode, RegisterValue, slot_hash, tree_id};
    use futures::executor::block_on;
    use std::rc::Rc;

    #[test]
    fn queued_raw_persist_rechecks_lifecycle_when_polled() {
        let lifecycle = Rc::new(RefCell::new(LifecycleState::default()));
        let slot = slot_hash("queued");
        let nonce = [3; 16];
        lifecycle.borrow_mut().registers.insert(
            slot,
            RegisterValue {
                sequence: 1,
                nonce,
                mode: Some(OpaqueMode::CallerEncrypted),
            },
        );
        let storage = SnapshotStorage::new(Rc::clone(&lifecycle));
        let tree = SedimentreeId::new(tree_id(slot, nonce));
        let future = storage.persist_items(tree, Vec::new(), Vec::new());
        lifecycle.borrow_mut().registers.insert(
            slot,
            RegisterValue {
                sequence: 2,
                nonce: [4; 16],
                mode: None,
            },
        );
        assert_eq!(block_on(future), Err(StorageFailure::Retryable));
    }
}
