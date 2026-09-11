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
//! The automerge/sedimentree machinery under this is [`Document`], shared
//! with the user-system document (`crate::us`).

use automerge::{ObjType, ROOT, ReadDoc, ScalarValue, transaction::Transactable};
use sedimentree_core::{id::SedimentreeId, loose_commit::id::CommitId};
use serde::{Deserialize, Serialize};
use subduction_protocol::command::NewCommit;

use crate::document::{Absorbed, Document, actor};
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
    pub items: Vec<TodoItem>,
}

const TITLE: &str = "title";
const COMPLETED: &str = "completed";
const CREATED: &str = "created";

pub struct AppDoc {
    core: Document,
    /// The device's signing seed and this app's id — the two halves of what
    /// makes a task id unique. See [`AppDoc::mint_id`].
    seed: [u8; 32],
    app: String,
}

impl AppDoc {
    /// An empty document for an app this device has not seen.
    pub fn empty(app: &str, tree: SedimentreeId, seed: [u8; 32]) -> AppDoc {
        AppDoc {
            core: Document::empty(actor(b"polyvisor:actor:", seed, app.as_bytes()), tree),
            seed,
            app: app.to_string(),
        }
    }

    /// A document from a checkpoint.
    pub fn restore(app: &str, tree: SedimentreeId, bytes: &[u8], seed: [u8; 32]) -> AppDoc {
        AppDoc {
            core: Document::load(
                bytes,
                actor(b"polyvisor:actor:", seed, app.as_bytes()),
                tree,
            ),
            seed,
            app: app.to_string(),
        }
    }

    pub const fn tree(&self) -> SedimentreeId {
        self.core.tree()
    }

    /// The automerge machinery under this document, for a schema that is not
    /// the tasks one: `crate::visor` writes its own keys at the same ROOT of
    /// its own (reserved-id) app document.
    pub(crate) const fn document(&mut self) -> &mut Document {
        &mut self.core
    }

    pub fn save(&self) -> Vec<u8> {
        self.core.save()
    }

    /// The number of changes in the document's history. Used to order and
    /// uniquely name local additions.
    pub fn revision(&self) -> u64 {
        self.core.revision()
    }

    /// The items, ordered by creation and then by id.
    ///
    /// The old in-memory list got creation order free from a zero-padded
    /// counter; ids are now per-device (see [`AppDoc::mint_id`]) and carry no
    /// order, so each item records the document's length at its creation.
    /// Concurrent creations on two devices tie, and the id breaks the tie —
    /// arbitrary, but identical on both devices.
    pub fn snapshot(&self) -> TaskSnapshot {
        let doc = self.core.read();
        let mut items: Vec<(i64, TodoItem)> = Vec::new();
        for id in doc.keys(ROOT) {
            let Ok(Some((_value, item))) = doc.get(ROOT, &id) else {
                continue;
            };
            let title = doc
                .get(&item, TITLE)
                .ok()
                .flatten()
                .and_then(|(v, _)| v.to_str().map(str::to_string))
                .unwrap_or_default();
            let completed = doc
                .get(&item, COMPLETED)
                .ok()
                .flatten()
                .and_then(|(v, _)| v.to_bool())
                .unwrap_or(false);
            let created = doc
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
            items: items.into_iter().map(|(_, item)| item).collect(),
        }
    }

    /// Append a task, answering the id it was given.
    pub fn add(&mut self, title: String) -> Result<String, String> {
        let created = i64::try_from(self.revision()).unwrap_or(i64::MAX);
        let id = self.mint_id();
        let key = id.clone();
        self.core.transact(move |tx| {
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
        let _item = self.require(id)?;
        self.core
            .transact(|tx| tx.delete(ROOT, id).map_err(|e| e.to_string()))
    }

    /// Take the sedimentree commit for the last local change.
    pub fn last_local_commit(&mut self) -> Option<NewCommit> {
        self.core.last_local_commit()
    }

    /// The tree's stored envelopes this document has not opened yet, and the
    /// ones it already has (walk entrypoints). Decryption is the engine's:
    /// it is async, and a document may not suspend (see `crate::document`).
    pub fn unapplied(&self, storage: &SnapshotStorage) -> Vec<(CommitId, Vec<u8>)> {
        self.core.unapplied(storage)
    }

    /// Apply decrypted automerge changes.
    pub fn apply(&mut self, items: Vec<(CommitId, Vec<u8>)>) -> Absorbed {
        self.core.apply(items)
    }

    /// The tree's stored fragment envelopes this document has not opened.
    pub fn unapplied_fragments(&self, storage: &SnapshotStorage) -> Vec<(CommitId, Vec<u8>)> {
        self.core.unapplied_fragments(storage)
    }

    /// Apply decrypted automerge bundles.
    pub fn apply_bundles(&mut self, bundles: Vec<(CommitId, Vec<u8>)>) -> Absorbed {
        self.core.apply_bundles(bundles)
    }

    /// The fragments automerge draws over this document at level 1 and
    /// deeper. See `crate::document::Document::fragments`.
    pub fn fragments(&self) -> Vec<automerge::Fragment> {
        self.core.fragments()
    }

    /// The bundle bytes for those fragments. See
    /// `crate::document::Document::bundle`.
    pub fn bundle(&self, fragments: Vec<automerge::Fragment>) -> Vec<Vec<u8>> {
        self.core.bundle(fragments)
    }

    pub fn applied_ids(&self) -> std::collections::BTreeSet<CommitId> {
        self.core.applied_ids()
    }

    pub fn diverged(&self) -> bool {
        self.core.diverged()
    }

    pub fn merge_anchor(&mut self) -> Option<NewCommit> {
        self.core.merge_anchor()
    }

    fn put_field(&mut self, id: &str, field: &str, value: ScalarValue) -> Result<(), String> {
        let item = self.require(id)?;
        self.core
            .transact(|tx| tx.put(&item, field, value).map_err(|e| e.to_string()))
    }

    /// The item's object id, or the same message the in-memory list gave.
    fn require(&self, id: &str) -> Result<automerge::ObjId, String> {
        self.core
            .read()
            .get(ROOT, id)
            .ok()
            .flatten()
            .map(|(_value, item)| item)
            .ok_or_else(|| format!("no task with id {id}"))
    }
}
