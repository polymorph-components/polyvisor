//! Task schema and operations over a platform-synchronized Automerge history.

use automerge::{ObjType, ROOT, ReadDoc, ScalarValue, transaction::Transactable};
use polyvisor_document_history::Document;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<TodoItem>,
}

const TITLE: &str = "title";
const COMPLETED: &str = "completed";
const CREATED: &str = "created";

pub fn snapshot(doc: &Document) -> Snapshot {
    let read = doc.read();
    let mut items = Vec::new();
    for id in read.keys(ROOT) {
        let Ok(Some((_value, item))) = read.get(ROOT, &id) else {
            continue;
        };
        let title = read
            .get(&item, TITLE)
            .ok()
            .flatten()
            .and_then(|(v, _)| v.to_str().map(str::to_string))
            .unwrap_or_default();
        let completed = read
            .get(&item, COMPLETED)
            .ok()
            .flatten()
            .and_then(|(v, _)| v.to_bool())
            .unwrap_or(false);
        let created = read
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
    Snapshot {
        revision: doc.revision(),
        items: items.into_iter().map(|(_, item)| item).collect(),
    }
}

pub fn add(doc: &mut Document, title: String) -> Result<String, String> {
    let created = i64::try_from(doc.revision()).unwrap_or(i64::MAX);
    let id = mint_id(doc.revision(), doc.actor_id());
    let key = id.clone();
    doc.transact(move |tx| {
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

pub fn set_completed(doc: &mut Document, id: &str, value: bool) -> Result<(), String> {
    put(doc, id, COMPLETED, value.into())
}
pub fn set_title(doc: &mut Document, id: &str, value: String) -> Result<(), String> {
    put(doc, id, TITLE, value.into())
}
pub fn remove(doc: &mut Document, id: &str) -> Result<(), String> {
    require(doc, id)?;
    doc.transact(|tx| tx.delete(ROOT, id).map_err(|e| e.to_string()))
}

fn put(doc: &mut Document, id: &str, field: &str, value: ScalarValue) -> Result<(), String> {
    let item = require(doc, id)?;
    doc.transact(|tx| tx.put(&item, field, value).map_err(|e| e.to_string()))
}
fn require(doc: &Document, id: &str) -> Result<automerge::ObjId, String> {
    doc.read()
        .get(ROOT, id)
        .ok()
        .flatten()
        .map(|(_, obj)| obj)
        .ok_or_else(|| format!("no task with id {id}"))
}
fn mint_id(revision: u64, actor: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(b"polyvisor:task-id:");
    h.update(actor);
    h.update(revision.to_be_bytes());
    h.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::ActorId;
    use sedimentree_core::id::SedimentreeId;

    fn doc() -> Document {
        Document::empty(ActorId::from(&[1_u8][..]), SedimentreeId::new([2; 32]))
    }

    #[test]
    fn crud_preserves_creation_order() {
        let mut doc = doc();
        let first = add(&mut doc, "first".into()).unwrap();
        let second = add(&mut doc, "second".into()).unwrap();
        set_completed(&mut doc, &first, true).unwrap();
        set_title(&mut doc, &second, "renamed".into()).unwrap();
        let seen = snapshot(&doc);
        assert_eq!(
            seen.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [&first, &second]
        );
        assert!(seen.items[0].completed);
        assert_eq!(seen.items[1].title, "renamed");
        remove(&mut doc, &first).unwrap();
        assert_eq!(snapshot(&doc).items.len(), 1);
    }
}
