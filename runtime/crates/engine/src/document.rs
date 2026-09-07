//! An automerge document carried as sedimentree commits — the machinery both
//! document kinds share.
//!
//! One local mutation is one automerge change, and one automerge change is
//! one sedimentree commit whose blob is the change's raw bytes. The commit's
//! identity *is* the change hash: `CommitId` is caller-supplied and explicitly
//! meant for this ("typically the hash of the underlying document change (e.g.
//! an Automerge `ChangeHash`)" — legacy/sedimentree_core/src/loose_commit/id.rs:6),
//! so the `ChangeHash → CommitId` correspondence is the identity function and
//! the commit's parents are the change's `deps` under the same mapping. No
//! side table is needed, and two devices name the same change identically.
//!
//! Every method here is synchronous — there is not an `await` in this file —
//! which is what keeps a document safe under the engine's two callers. The
//! export path and the event pump both reach it through a `RefCell` on the
//! engine, and each `await` is a yield point where the other could run; a
//! borrow that spanned one would be a panic waiting for the two to
//! interleave. Because a transaction cannot suspend, the borrow is always
//! taken and dropped inside one turn.

use std::collections::BTreeSet;

use automerge::{ActorId, Automerge};
use sedimentree_core::{blob::Blob, id::SedimentreeId, loose_commit::id::CommitId};
use subduction_protocol::command::NewCommit;

use crate::storage::SnapshotStorage;

/// One automerge document and the tree its changes travel in.
pub struct Document {
    doc: Automerge,
    tree: SedimentreeId,
    /// Commit ids already in the document: local ones as they are authored,
    /// remote ones as they are absorbed. Automerge itself is idempotent about
    /// re-applied changes; this is what makes "did anything land?" — and so
    /// "must the kernel checkpoint?" — answerable without re-decoding every
    /// stored blob.
    applied: BTreeSet<CommitId>,
    /// The commit for the last local change, until the engine takes it.
    pending: Option<NewCommit>,
}

impl Document {
    /// An empty document under `actor`.
    pub fn empty(actor: ActorId, tree: SedimentreeId) -> Document {
        Document {
            doc: Automerge::new().with_actor(actor),
            tree,
            applied: BTreeSet::new(),
            pending: None,
        }
    }

    /// A document from a checkpoint's bytes. Bytes that do not load are
    /// treated as an empty document: the tree's items are still in storage
    /// and are absorbed on the first touch, so the content comes back either
    /// way.
    ///
    /// That leniency is right for our own storage and wrong for anything
    /// that arrived over a wire — see [`Document::try_load`].
    pub fn load(bytes: &[u8], actor: ActorId, tree: SedimentreeId) -> Document {
        Document::adopt(
            Automerge::load(bytes).unwrap_or_else(|_| Automerge::new()),
            actor,
            tree,
        )
    }

    /// A document from bytes that must parse: what a peer sent, where
    /// "unreadable" has to be an answer rather than an empty document
    /// silently taking its place.
    pub fn try_load(bytes: &[u8], actor: ActorId, tree: SedimentreeId) -> Result<Document, String> {
        let doc = Automerge::load(bytes).map_err(|e| e.to_string())?;
        Ok(Document::adopt(doc, actor, tree))
    }

    fn adopt(mut doc: Automerge, actor: ActorId, tree: SedimentreeId) -> Document {
        let _actor = doc.set_actor(actor);
        let applied = doc
            .get_changes(&[])
            .iter()
            .map(|change| CommitId::new(change.hash().0))
            .collect();
        Document {
            doc,
            tree,
            applied,
            pending: None,
        }
    }

    /// The document, for reads.
    pub const fn read(&self) -> &Automerge {
        &self.doc
    }

    pub const fn tree(&self) -> SedimentreeId {
        self.tree
    }

    pub fn save(&self) -> Vec<u8> {
        self.doc.save()
    }

    /// The number of changes in the document's history. Monotonic (changes
    /// are only ever added) and identical on every device that has seen the
    /// same history, so a remote change advances it exactly as a local one
    /// does.
    pub fn revision(&self) -> u64 {
        self.doc.get_changes_meta(&[]).len() as u64
    }

    /// Take the sedimentree commit for the last local change, if the last
    /// mutation produced one.
    pub fn last_local_commit(&mut self) -> Option<NewCommit> {
        self.pending.take()
    }

    /// Apply every stored change of this tree the document has not seen.
    /// Returns whether anything landed. The plaintext path, for the
    /// user-system document — an app document's blobs are envelopes, and the
    /// engine decrypts them before calling [`Document::apply`].
    pub fn absorb(&mut self, storage: &SnapshotStorage) -> bool {
        let items = self.unapplied(storage);
        self.apply(items)
    }

    /// The stored blobs of this tree the document has not applied yet, raw.
    /// For an app document these are keyhive envelopes.
    pub fn unapplied(&self, storage: &SnapshotStorage) -> Vec<(CommitId, Vec<u8>)> {
        storage
            .commit_blobs(self.tree)
            .into_iter()
            .filter(|(id, _)| !self.applied.contains(id))
            .collect()
    }

    /// Apply decoded changes to the document. Returns whether anything landed.
    ///
    /// Changes may arrive before their dependencies (sync is a set
    /// reconciliation, not a topological replay); automerge queues a change
    /// whose deps are missing and applies it when they arrive, so the whole
    /// batch goes in as one call and order does not matter.
    pub fn apply(&mut self, items: Vec<(CommitId, Vec<u8>)>) -> bool {
        let mut ids = Vec::new();
        let mut changes = Vec::new();
        for (id, blob) in items {
            if self.applied.contains(&id) {
                continue;
            }
            let Ok(change) = automerge::Change::from_bytes(blob) else {
                continue;
            };
            ids.push(id);
            changes.push(change);
        }
        if changes.is_empty() {
            return false;
        }
        if self.doc.apply_changes(changes).is_err() {
            return false;
        }
        self.applied.extend(ids);
        true
    }

    /// Run one transaction and, if it produced a change, record the commit
    /// that carries it. `Success::hash` is `None` exactly when the
    /// transaction created no operations, which is how a no-op mutation
    /// avoids authoring an empty commit.
    pub fn transact(
        &mut self,
        f: impl FnOnce(&mut automerge::transaction::Transaction<'_>) -> Result<(), String>,
    ) -> Result<(), String> {
        let hash = self.doc.transact(f).map_err(|failure| failure.error)?.hash;
        if hash.is_none() {
            return Ok(());
        }
        let Some(change) = self.doc.get_last_local_change() else {
            return Ok(());
        };
        let head = CommitId::new(change.hash().0);
        let _known = self.applied.insert(head);
        self.pending = Some(NewCommit {
            head,
            parents: change.deps().iter().map(|h| CommitId::new(h.0)).collect(),
            blob: Blob::new(change.raw_bytes().to_vec()),
        });
        Ok(())
    }
}

/// A document actor id: distinct per device *and* per document, so two
/// devices never share an actor id (which automerge treats as one author's
/// sequence and would reject as a fork).
pub fn actor(domain: &[u8], seed: [u8; 32], scope: &[u8]) -> ActorId {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(seed);
    hasher.update(scope);
    ActorId::from(&hasher.finalize()[..16])
}
