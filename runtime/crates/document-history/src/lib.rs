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

/// What one batch of [`Document::apply`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Absorbed {
    /// Anything at all landed, so the kernel must checkpoint.
    pub landed: bool,
    /// At least one landed change carried operations, as opposed to being a
    /// merge anchor. Only content is worth anchoring for.
    pub content: bool,
}

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
    /// Local changes not yet handed to the history publisher, in transaction
    /// order. A model callback may deliberately author more than one change.
    pending: Vec<NewCommit>,
}

impl Document {
    /// An empty document under `actor`.
    pub fn empty(actor: ActorId, tree: SedimentreeId) -> Document {
        Document {
            doc: Automerge::new().with_actor(actor),
            tree,
            applied: BTreeSet::new(),
            pending: Vec::new(),
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
            pending: Vec::new(),
        }
    }

    /// The document, for reads.
    pub const fn read(&self) -> &Automerge {
        &self.doc
    }

    /// This document's per-device, per-partition Automerge actor identifier.
    pub fn actor_id(&self) -> &[u8] {
        self.doc.get_actor().to_bytes()
    }

    pub const fn tree(&self) -> SedimentreeId {
        self.tree
    }

    pub fn save(&self) -> Vec<u8> {
        self.doc.save()
    }

    pub fn merge_snapshot(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut other = Automerge::load(bytes).map_err(|e| e.to_string())?;
        self.doc.merge(&mut other).map_err(|e| e.to_string())?;
        self.applied = self
            .doc
            .get_changes(&[])
            .iter()
            .map(|change| CommitId::new(change.hash().0))
            .collect();
        Ok(())
    }

    /// The number of changes in the document's history. Monotonic (changes
    /// are only ever added) and identical on every device that has seen the
    /// same history, so a remote change advances it exactly as a local one
    /// does.
    pub fn revision(&self) -> u64 {
        self.doc.get_changes_meta(&[]).len() as u64
    }

    /// Take all unpublished local commits in transaction order.
    pub fn drain_local_commits(&mut self) -> Vec<NewCommit> {
        std::mem::take(&mut self.pending)
    }

    /// The commits this document has already applied. The vault needs them to
    /// tell "an ancestor key I should keep, because that commit has not
    /// arrived" from "an ancestor key I can drop, because I already read that
    /// commit and its key rides in a descendant I hold".
    pub fn applied_ids(&self) -> BTreeSet<CommitId> {
        self.applied.clone()
    }

    /// Whether this history already contains `id`. The engine uses this to
    /// select stored encrypted items before it releases its document borrow
    /// and awaits decryption.
    pub fn contains(&self, id: &CommitId) -> bool {
        self.applied.contains(id)
    }

    /// Apply fragment payloads: automerge *bundles*, each carrying every
    /// change of one commit range.
    ///
    /// `load_incremental` takes a bundle exactly as it takes a save or a
    /// single change (automerge `change_graph.rs:1454`,
    /// `bundle_fragments_roundtrips_through_load_incremental`), and it
    /// buffers what it cannot yet apply, so a bundle whose boundary has not
    /// arrived is not an error.
    ///
    /// The `applied` set is re-read from the document afterwards rather than
    /// predicted from the fragment's member list: the document is the
    /// authority on what it holds, and a bundle names hundreds of changes
    /// whose ids we would otherwise be copying out of an envelope nobody has
    /// checked.
    pub fn apply_bundles(&mut self, bundles: Vec<(CommitId, Vec<u8>)>) -> Absorbed {
        let mut loaded = false;
        for (head, bytes) in bundles {
            if self.applied.contains(&head) {
                continue;
            }
            if self.doc.load_incremental(&bytes).is_ok() {
                loaded = true;
            }
        }
        if !loaded {
            return Absorbed::default();
        }
        let mut content = false;
        let mut landed = false;
        for change in self.doc.get_changes(&[]) {
            let id = CommitId::new(change.hash().0);
            if self.applied.insert(id) {
                landed = true;
                // As in `apply`: an empty change is a merge anchor and is not
                // a reason to author another.
                content |= !change.is_empty();
            }
        }
        Absorbed { landed, content }
    }

    /// The fragments automerge would draw over this document's history at
    /// level 1 and deeper, oldest first.
    ///
    /// `#[doc(hidden)]`/EXPERIMENTAL upstream, and used anyway: automerge's
    /// fragments are co-designed with sedimentree — `ChangeHash`'s
    /// `fragment_level` counts leading zero *bytes* (automerge
    /// `types.rs:680`), which is `CountLeadingZeroBytes` exactly
    /// (sedimentree_core `depth.rs`) — so this is the one decomposition whose
    /// heads, boundaries and checkpoints line up with the tree the sync
    /// engine already keeps. Reimplementing it over `get_changes` would be a
    /// second implementation of the same partition, free to disagree.
    /// Ink & Switch's own adapter does exactly this mapping
    /// (`legacy/automerge_subduction_ingest/src/main.rs`, `ingest_automerge`).
    pub fn fragments(&self) -> Vec<automerge::Fragment> {
        self.doc.fragments(1..)
    }

    /// The document's current heads, and every change hash in its history.
    ///
    /// For the one caller that has to describe a whole document as a single
    /// sedimentree fragment rather than take automerge's own partition of it
    /// when publishing an adopted document as one fragment.
    pub fn heads(&self) -> Vec<automerge::ChangeHash> {
        self.doc.get_heads()
    }

    pub fn change_hashes(&self) -> Vec<automerge::ChangeHash> {
        self.doc
            .get_changes(&[])
            .iter()
            .map(automerge::Change::hash)
            .collect()
    }

    /// The bundle bytes for each fragment, in the order given. Separate from
    /// [`Document::fragments`] because bundling re-encodes every member of
    /// every fragment handed to it, and the caller drops all but the ones it
    /// has not already stored.
    pub fn bundle(&self, fragments: Vec<automerge::Fragment>) -> Vec<Vec<u8>> {
        self.doc.bundle_fragments(fragments)
    }

    /// Whether the document has more than one head — concurrent branches that
    /// nothing has merged yet. See [`Document::merge_anchor`].
    pub fn diverged(&self) -> bool {
        self.doc.get_heads().len() > 1
    }

    /// An empty change whose dependencies are every current head: automerge's
    /// own merge commit (`Automerge::empty_commit` — "the main reason to do
    /// this is if you want to create a merge commit").
    ///
    /// It carries no operations, so it changes nothing a model reads.
    pub fn merge_anchor(&mut self) -> Option<NewCommit> {
        let _hash = self
            .doc
            .empty_commit(automerge::transaction::CommitOptions::default());
        let change = self.doc.get_last_local_change()?;
        let head = CommitId::new(change.hash().0);
        let _known = self.applied.insert(head);
        Some(NewCommit {
            head,
            parents: change.deps().iter().map(|h| CommitId::new(h.0)).collect(),
            blob: Blob::new(change.raw_bytes().to_vec()),
        })
    }

    /// Apply decoded changes to the document.
    ///
    /// Changes may arrive before their dependencies (sync is a set
    /// reconciliation, not a topological replay); automerge queues a change
    /// whose deps are missing and applies it when they arrive, so the whole
    /// batch goes in as one call and order does not matter.
    pub fn apply(&mut self, items: Vec<(CommitId, Vec<u8>)>) -> Absorbed {
        let mut ids = Vec::new();
        let mut changes = Vec::new();
        let mut content = false;
        for (id, blob) in items {
            if self.applied.contains(&id) {
                continue;
            }
            let Ok(change) = automerge::Change::from_bytes(blob) else {
                continue;
            };
            // A change with no operations is a merge anchor, somebody else's
            // or an older one of ours. It is not a reason to author another.
            content |= !change.is_empty();
            ids.push(id);
            changes.push(change);
        }
        if changes.is_empty() {
            return Absorbed::default();
        }
        if self.doc.apply_changes(changes).is_err() {
            return Absorbed::default();
        }
        self.applied.extend(ids);
        Absorbed {
            landed: true,
            content,
        }
    }

    /// Validate and accept an application-authored batch as one atomic unit.
    /// Every dependency must already be present or occur in this batch;
    /// retries containing changes already accepted are harmless.
    pub fn publish(&mut self, blobs: Vec<Vec<u8>>) -> Result<bool, String> {
        let mut batch = BTreeSet::new();
        let mut changes = Vec::new();
        for blob in blobs {
            let change = automerge::Change::from_bytes(blob)
                .map_err(|error| format!("invalid Automerge change: {error}"))?;
            let id = CommitId::new(change.hash().0);
            if self.applied.contains(&id) || !batch.insert(id) {
                continue;
            }
            changes.push(change);
        }
        for change in &changes {
            for dependency in change.deps() {
                let dependency = CommitId::new(dependency.0);
                if !self.applied.contains(&dependency) && !batch.contains(&dependency) {
                    return Err("an Automerge change dependency is missing".to_string());
                }
            }
        }
        if changes.is_empty() {
            return Ok(false);
        }

        // Validate against a clone first: even if Automerge rejects an actor
        // sequence or another graph invariant, the live document is untouched.
        let mut candidate = self.doc.clone();
        candidate
            .apply_changes(changes.clone())
            .map_err(|error| format!("invalid Automerge change batch: {error}"))?;

        let mut remaining = changes;
        let mut ordered = Vec::with_capacity(remaining.len());
        let mut available = self.applied.clone();
        while !remaining.is_empty() {
            let Some(index) = remaining.iter().position(|change| {
                change
                    .deps()
                    .iter()
                    .all(|hash| available.contains(&CommitId::new(hash.0)))
            }) else {
                return Err("the Automerge change batch is not causally ordered".to_string());
            };
            let change = remaining.remove(index);
            available.insert(CommitId::new(change.hash().0));
            ordered.push(change);
        }

        for change in ordered {
            let head = CommitId::new(change.hash().0);
            self.pending.push(NewCommit {
                head,
                parents: change
                    .deps()
                    .iter()
                    .map(|hash| CommitId::new(hash.0))
                    .collect(),
                blob: Blob::new(change.raw_bytes().to_vec()),
            });
            self.applied.insert(head);
        }
        self.doc = candidate;
        Ok(true)
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
        self.pending.push(NewCommit {
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

#[cfg(test)]
mod tests {
    use automerge::{Automerge, ROOT, transaction::Transactable as _};
    use sedimentree_core::id::SedimentreeId;

    use super::Document;

    fn document() -> Document {
        Document::empty(
            automerge::ActorId::from(&[1][..]),
            SedimentreeId::new([7; 32]),
        )
    }

    fn change(doc: &mut Automerge, key: &str, value: &str) -> Vec<u8> {
        doc.transact(|tx| tx.put(ROOT, key, value)).unwrap();
        doc.get_last_local_change().unwrap().raw_bytes().to_vec()
    }

    #[test]
    fn publish_accepts_concurrent_histories_and_duplicate_retries() {
        let mut left = Automerge::new().with_actor(automerge::ActorId::from(&[2][..]));
        let mut right = Automerge::new().with_actor(automerge::ActorId::from(&[3][..]));
        let left = change(&mut left, "left", "one");
        let right = change(&mut right, "right", "two");
        let mut history = document();

        assert!(history.publish(vec![left.clone(), right]).unwrap());
        assert_eq!(history.revision(), 2);
        assert!(!history.publish(vec![left]).unwrap());
        assert_eq!(history.revision(), 2);
    }

    #[test]
    fn invalid_batch_and_missing_dependency_leave_history_unchanged() {
        let mut author = Automerge::new().with_actor(automerge::ActorId::from(&[4][..]));
        let first = change(&mut author, "first", "one");
        let second = change(&mut author, "second", "two");
        let mut history = document();
        let before = history.save();

        assert!(history.publish(vec![first, vec![0, 1, 2]]).is_err());
        assert_eq!(history.save(), before);
        assert!(history.publish(vec![second]).is_err());
        assert_eq!(history.save(), before);
        assert_eq!(history.revision(), 0);
    }
}
