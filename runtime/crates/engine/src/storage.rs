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

use std::cell::RefCell;
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
    /// The user-system document and its tree. `#[serde(default)]` because
    /// checkpoints written before the group existed have no such field, and
    /// a device must still boot from one.
    #[serde(default)]
    pub us: Option<TreeState>,
    /// The keyhive-events tree (`crate::keyhive_tree`): the membership and
    /// CGKA operations that let this device's peers open its envelopes. It has
    /// no automerge document — `TreeState::doc` is empty — because its commits
    /// *are* the state.
    #[serde(default)]
    pub keyhive: Option<TreeState>,
    /// This device's keyhive itself, including secrets. Sealed with the rest
    /// of the checkpoint.
    #[serde(default)]
    pub vault: Option<crate::vault::VaultState>,
    /// The group's store-name key (docs/design.md M4, the Drive record): the
    /// 32 bytes every name in the user's own store is HMAC'd under, so two
    /// devices of one group derive the same names and nobody else derives any
    /// of them. Minted with the group and carried to a joiner inside ENROLL,
    /// which is why it rests here rather than being derived from the seed:
    /// it belongs to the *group*, and the seed is one device's.
    ///
    /// `Option` because a checkpoint written before M4 has no such field, and
    /// because a device that has never opened its group document has no group
    /// to have a key for.
    #[serde(default)]
    pub name_key: Option<[u8; 32]>,
}

/// One app's document and the tree behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppState {
    pub app: String,
    #[serde(flatten)]
    pub state: TreeState,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    /// One automerge change.
    #[default]
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
    /// `#[serde(default)]` — `Commit` — because objects written before
    /// fragments existed carry no such field, and a device must still read
    /// its group's older objects.
    #[serde(default)]
    pub kind: ItemKind,
}

/// Map-backed item storage. Interior mutability is a `RefCell`: the driver
/// task is the only accessor, and this crate is single-threaded throughout.
#[derive(Debug, Default)]
pub struct SnapshotStorage {
    trees: RefCell<BTreeMap<SedimentreeId, Tree>>,
}

#[derive(Debug, Default)]
struct Tree {
    commits: BTreeMap<CommitId, (Signed<LooseCommit>, Vec<u8>)>,
    fragments: BTreeMap<CommitId, (Signed<Fragment>, Vec<u8>)>,
}

impl SnapshotStorage {
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
    /// see `crate::document::Document::apply_bundles`.
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
        let mut trees = self.trees.borrow_mut();
        let entry = trees.entry(tree).or_default();
        for item in commits {
            if let Ok(signed) = Signed::<LooseCommit>::try_decode(&item.signed)
                && let Ok(payload) = signed.try_decode_trusted_payload()
            {
                let _previous = entry.commits.insert(payload.head(), (signed, item.blob));
            }
        }
        for item in fragments {
            if let Ok(signed) = Signed::<Fragment>::try_decode(&item.signed)
                && let Ok(payload) = signed.try_decode_trusted_payload()
            {
                let _previous = entry.fragments.insert(payload.head(), (signed, item.blob));
            }
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
                    app,
                    state: self.tree_state(tree, doc),
                })
                .collect(),
            us: us.map(|(tree, doc)| self.tree_state(tree, doc)),
            keyhive: keyhive.map(|tree| self.tree_state(tree, Vec::new())),
            vault,
            name_key,
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
            let mut trees = self.trees.borrow_mut();
            let entry = trees.entry(tree).or_default();
            let mut stored = 0u32;
            for (signed, blob) in commits {
                let Ok(payload) = signed.try_decode_trusted_payload() else {
                    return Err(StorageFailure::Permanent);
                };
                let _previous = entry.commits.insert(payload.head(), (signed, blob));
                stored += 1;
            }
            for (signed, blob) in fragments {
                let Ok(payload) = signed.try_decode_trusted_payload() else {
                    return Err(StorageFailure::Permanent);
                };
                let _previous = entry.fragments.insert(payload.head(), (signed, blob));
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
            Ok(())
        })
    }
}
