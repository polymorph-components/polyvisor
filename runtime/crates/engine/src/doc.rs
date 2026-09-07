//! The tasks document: `polyvisor:app/tasks` as an automerge map.
//!
//! Shape: each task is a map at the document root, keyed by its id.
//!
//! ```text
//! <task id>: { title: str, completed: bool, created: int }
//! ```
//!
//! At the *root*, not under an `items` map, and that is load-bearing: two
//! devices that each create an `items` map before meeting create two distinct
//! objects at one key, and automerge resolves that conflict by picking one —
//! silently discarding the loser's whole subtree. The root object is created
//! by automerge itself and is the same object on every device, so there is
//! nothing to conflict.
//!
//! One local mutation is one automerge change, and one automerge change is
//! one sedimentree commit whose blob is the change's raw bytes. The commit's
//! identity *is* the change hash: `CommitId` is caller-supplied and explicitly
//! meant for this ("typically the hash of the underlying document change (e.g.
//! an Automerge `ChangeHash`)" — legacy/sedimentree_core/src/loose_commit/id.rs:6),
//! so the `ChangeHash → CommitId` correspondence is the identity function and
//! the commit's parents are the change's `deps` under the same mapping. No
//! side table is needed, and two devices name the same change identically.

//! Every method here is synchronous — there is not an `await` in this file —
//! which is what keeps the document safe under the engine's two callers. The
//! export path and the event pump both reach `AppDoc` through a `RefCell` on
//! `Engine::apps`, and each `await` is a yield point where the other could
//! run; a borrow that spanned one would be a panic waiting for the two to
//! interleave. Because a transaction cannot suspend, the borrow is always
//! taken and dropped inside one turn.

use std::collections::BTreeSet;

use automerge::{
    ActorId, Automerge, ObjType, ROOT, ReadDoc, ScalarValue, transaction::Transactable,
};
use sedimentree_core::{blob::Blob, id::SedimentreeId, loose_commit::id::CommitId};
use serde::{Deserialize, Serialize};
use subduction_protocol::command::NewCommit;

use crate::storage::SnapshotStorage;

/// `polyvisor:app/tasks.todo-item`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

/// `polyvisor:app/tasks.snapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSnapshot {
    pub revision: u64,
    pub items: Vec<TodoItem>,
}

const TITLE: &str = "title";
const COMPLETED: &str = "completed";
const CREATED: &str = "created";

pub struct AppDoc {
    doc: Automerge,
    tree: SedimentreeId,
    /// The device's signing seed and this app's id — the two halves of what
    /// makes a task id unique. See [`AppDoc::mint_id`].
    seed: [u8; 32],
    app: String,
    /// Commit ids already in the document: local ones as they are authored,
    /// remote ones as they are absorbed. Automerge itself is idempotent about
    /// re-applied changes; this is what makes "did anything land?" — and so
    /// "must the kernel checkpoint?" — answerable without re-decoding every
    /// stored blob.
    applied: BTreeSet<CommitId>,
    /// The commit for the last local change, until the engine takes it.
    pending: Option<NewCommit>,
}

impl AppDoc {
    /// An empty document for an app this device has not seen.
    pub fn empty(app: &str, tree: SedimentreeId, seed: [u8; 32]) -> AppDoc {
        AppDoc {
            doc: Automerge::new().with_actor(actor(app, seed)),
            tree,
            seed,
            app: app.to_string(),
            applied: BTreeSet::new(),
            pending: None,
        }
    }

    /// A document from a checkpoint. Bytes that do not load are treated as an
    /// empty document: the tree's items are still in storage and are absorbed
    /// on the first touch, so the content comes back either way.
    pub fn restore(app: &str, tree: SedimentreeId, bytes: &[u8], seed: [u8; 32]) -> AppDoc {
        let mut doc = match Automerge::load(bytes) {
            Ok(doc) => doc,
            Err(_) => Automerge::new(),
        };
        let _actor = doc.set_actor(actor(app, seed));
        let applied = doc
            .get_changes(&[])
            .iter()
            .map(|change| CommitId::new(change.hash().0))
            .collect();
        AppDoc {
            doc,
            tree,
            seed,
            app: app.to_string(),
            applied,
            pending: None,
        }
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
    /// does — which is what `tasks.revision` promises an app.
    pub fn revision(&self) -> u64 {
        self.doc.get_changes_meta(&[]).len() as u64
    }

    /// The items, ordered by creation and then by id.
    ///
    /// The old in-memory list got creation order free from a zero-padded
    /// counter; ids are now per-device (see `Engine::mint_id`) and carry no
    /// order, so each item records the document's length at its creation.
    /// Concurrent creations on two devices tie, and the id breaks the tie —
    /// arbitrary, but identical on both devices.
    pub fn snapshot(&self) -> TaskSnapshot {
        let mut items: Vec<(i64, TodoItem)> = Vec::new();
        for id in self.doc.keys(ROOT) {
            let Ok(Some((_value, item))) = self.doc.get(ROOT, &id) else {
                continue;
            };
            let title = self
                .doc
                .get(&item, TITLE)
                .ok()
                .flatten()
                .and_then(|(v, _)| v.to_str().map(str::to_string))
                .unwrap_or_default();
            let completed = self
                .doc
                .get(&item, COMPLETED)
                .ok()
                .flatten()
                .and_then(|(v, _)| v.to_bool())
                .unwrap_or(false);
            let created = self
                .doc
                .get(&item, CREATED)
                .ok()
                .flatten()
                .and_then(|(v, _)| v.to_i64())
                .unwrap_or(0);
            items.push((
                created,
                TodoItem {
                    id,
                    title,
                    completed,
                },
            ));
        }
        items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
        TaskSnapshot {
            revision: self.revision(),
            items: items.into_iter().map(|(_, item)| item).collect(),
        }
    }

    /// Append a task, answering the id it was given.
    pub fn add(&mut self, title: String) -> Result<String, String> {
        let created = i64::try_from(self.revision()).unwrap_or(i64::MAX);
        let id = self.mint_id();
        let key = id.clone();
        self.transact(move |tx| {
            let item = tx
                .put_object(ROOT, &key, ObjType::Map)
                .map_err(|e| e.to_string())?;
            tx.put(&item, TITLE, title).map_err(|e| e.to_string())?;
            tx.put(&item, COMPLETED, false).map_err(|e| e.to_string())?;
            tx.put(&item, CREATED, created).map_err(|e| e.to_string())?;
            Ok(())
        })?;
        Ok(id)
    }

    /// A task id no other device will mint, and this device will not mint
    /// twice.
    ///
    /// `sha256("polyvisor:task-id:" ‖ seed ‖ app ‖ revision)`, truncated to
    /// 16 bytes and spelled in hex. Three things have to hold, and each is
    /// carried by one of the inputs:
    ///
    /// - **Two devices never collide**: the seed is 32 bytes of the device's
    ///   own randomness and is secret, so two devices at the same revision of
    ///   the same app still hash differently.
    /// - **One device never collides with itself**: [`AppDoc::revision`] is
    ///   the number of changes in the document's history, and every `add`
    ///   appends one, so the revision read before an add is a value no later
    ///   add can read again. (Remote changes only push it up faster.)
    /// - **A restart does not repeat**: the revision is a property of the
    ///   document, so it is restored with the document. This replaces a
    ///   counter held beside the engine, which reset to zero on every restore
    ///   and re-minted — and so overwrote — the first task of the previous
    ///   run.
    ///
    /// A zero-padded counter, which is what the in-memory list used, is not
    /// an option at all: two devices would both mint `00000001` for different
    /// tasks and automerge would merge them into one.
    fn mint_id(&self) -> String {
        use sha2::{Digest as _, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(b"polyvisor:task-id:");
        hasher.update(self.seed);
        hasher.update(self.app.as_bytes());
        hasher.update(self.revision().to_be_bytes());
        let digest = hasher.finalize();
        digest[..16].iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn set_completed(&mut self, id: &str, completed: bool) -> Result<(), String> {
        self.put_field(id, COMPLETED, completed.into())
    }

    pub fn set_title(&mut self, id: &str, title: String) -> Result<(), String> {
        self.put_field(id, TITLE, title.into())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.require(id)?;
        self.transact(|tx| tx.delete(ROOT, id).map_err(|e| e.to_string()))
    }

    /// Take the sedimentree commit for the last local change, if the last
    /// mutation produced one.
    pub fn last_local_commit(&mut self) -> Option<NewCommit> {
        self.pending.take()
    }

    /// Apply every stored change of this tree the document has not seen.
    /// Returns whether anything landed.
    ///
    /// Changes may arrive before their dependencies (sync is a set
    /// reconciliation, not a topological replay); automerge queues a change
    /// whose deps are missing and applies it when they arrive, so the whole
    /// batch goes in as one call and order does not matter.
    pub fn absorb(&mut self, storage: &SnapshotStorage) -> bool {
        let mut ids = Vec::new();
        let mut changes = Vec::new();
        for (id, blob) in storage.commit_blobs(self.tree) {
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

    fn put_field(&mut self, id: &str, field: &str, value: ScalarValue) -> Result<(), String> {
        let item = self.require(id)?;
        self.transact(|tx| tx.put(&item, field, value).map_err(|e| e.to_string()))
    }

    /// The item's object id, or the same message the in-memory list gave.
    fn require(&self, id: &str) -> Result<automerge::ObjId, String> {
        self.doc
            .get(ROOT, id)
            .ok()
            .flatten()
            .map(|(_value, item)| item)
            .ok_or_else(|| format!("no task with id {id}"))
    }

    /// Run one transaction and, if it produced a change, record the commit
    /// that carries it. `Success::hash` is `None` exactly when the
    /// transaction created no operations, which is how a no-op mutation
    /// avoids authoring an empty commit.
    fn transact(
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
        self.applied.insert(head);
        self.pending = Some(NewCommit {
            head,
            parents: change.deps().iter().map(|h| CommitId::new(h.0)).collect(),
            blob: Blob::new(change.raw_bytes().to_vec()),
        });
        Ok(())
    }
}

/// The document actor: distinct per device *and* per app, so two devices
/// never share an actor id (which automerge treats as one author's sequence
/// and would reject as a fork).
fn actor(app: &str, seed: [u8; 32]) -> ActorId {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"polyvisor:actor:");
    hasher.update(seed);
    hasher.update(app.as_bytes());
    ActorId::from(&hasher.finalize()[..16])
}
