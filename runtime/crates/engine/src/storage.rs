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
use std::collections::BTreeMap;

use future_form::{FutureForm as _, Local};
use futures::future::LocalBoxFuture;
use sedimentree_core::{
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
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
}

/// One app's document and the tree behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppState {
    pub app: String,
    /// `automerge::Automerge::save` bytes.
    pub doc: Vec<u8>,
    pub commits: Vec<Item>,
    pub fragments: Vec<Item>,
}

/// A stored sedimentree item: its signed envelope and its payload blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub signed: Vec<u8>,
    pub blob: Vec<u8>,
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

    /// The whole store, keyed by the app ids the caller supplies alongside
    /// each tree and its saved document.
    pub fn snapshot(
        &self,
        apps: impl Iterator<Item = (String, SedimentreeId, Vec<u8>)>,
    ) -> Snapshot {
        let trees = self.trees.borrow();
        Snapshot {
            apps: apps
                .map(|(app, tree, doc)| {
                    let stored = trees.get(&tree);
                    AppState {
                        app,
                        doc,
                        commits: stored
                            .map(|t| items(t.commits.values()))
                            .unwrap_or_default(),
                        fragments: stored
                            .map(|t| items(t.fragments.values()))
                            .unwrap_or_default(),
                    }
                })
                .collect(),
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
