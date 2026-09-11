//! The user-system document (`polyvisor:us`): who this device's group is.
//!
//! Shape — a `members` map at the root, keyed by the member's Ed25519 public
//! key in lowercase hex:
//!
//! ```text
//! members: { <hex key>: { petname: str, enrolled: int } }
//! ```
//!
//! One tree for every device of one user, `sha256("polyvisor:us")`, so two
//! devices that have paired converge on it with no naming step.
//!
//! The nested `members` map is safe here in a way the tasks document's would
//! not have been (see `crate::doc`): the two `members` objects that would
//! conflict are the ones two *unrelated* documents create, and unrelated
//! user-system documents never merge. A fresh device is its own group of
//! one, and joining a group **replaces** that document rather than merging
//! into it ([`crate::Engine::adopt_us`]) — so every document that ever syncs
//! with another descends from one founder's, and the `members` object is
//! that founder's, shared by construction.

use automerge::{ObjType, ROOT, ReadDoc, transaction::Transactable};
use sedimentree_core::{id::SedimentreeId, loose_commit::id::CommitId};
use sha2::{Digest as _, Sha256};
use subduction_protocol::command::NewCommit;

use crate::document::{Document, actor};
use crate::storage::SnapshotStorage;

/// One device of this user's group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The device's Ed25519 public key: its subduction peer id and, spelled
    /// in z-base-32, its iroh endpoint id.
    pub key: [u8; 32],
    /// User voice; the petname the device was kept under, or "".
    pub petname: String,
    /// Epoch milliseconds.
    pub enrolled: u64,
}

const MEMBERS: &str = "members";
const PETNAME: &str = "petname";
const ENROLLED: &str = "enrolled";
/// The keyhive group and document this group's app content is sealed to
/// (`crate::vault`), as lowercase hex of their 32-byte ids.
const KEYHIVE: &str = "keyhive";
const GROUP: &str = "group";
const DOC: &str = "doc";

/// The tree every device of one user keeps its group in.
#[must_use]
pub fn us_tree() -> SedimentreeId {
    SedimentreeId::new(Sha256::digest(b"polyvisor:us").into())
}

pub struct UsDoc {
    core: Document,
}

impl UsDoc {
    pub fn empty(seed: [u8; 32]) -> UsDoc {
        UsDoc {
            core: Document::empty(actor(b"polyvisor:us-actor:", seed, b""), us_tree()),
        }
    }

    /// A document from a checkpoint's bytes.
    pub fn load(bytes: &[u8], seed: [u8; 32]) -> UsDoc {
        UsDoc {
            core: Document::load(bytes, actor(b"polyvisor:us-actor:", seed, b""), us_tree()),
        }
    }

    /// The adder's snapshot, at enrollment — checked before anything local
    /// is thrown away.
    ///
    /// Three things have to hold, and each of them is a way the ceremony
    /// could have gone wrong or been lied to:
    ///
    /// - the bytes are an automerge document at all (a truncated or
    ///   corrupted ENROLL must not read as an empty group);
    /// - **this device is in it** — that is what enrollment *is*, and a
    ///   document without it would leave the joiner in a group that has
    ///   never heard of it, unable to connect to anyone;
    /// - **the adder is in it** — the device that ran the ceremony is the
    ///   one whose group this is, and a document without it is not the group
    ///   the user just confirmed six digits with.
    ///
    /// A failure here is a ceremony that failed, with the joiner's own group
    /// of one still intact.
    pub fn adopt(
        bytes: &[u8],
        seed: [u8; 32],
        me: [u8; 32],
        adder: [u8; 32],
    ) -> Result<UsDoc, String> {
        let core =
            Document::try_load(bytes, actor(b"polyvisor:us-actor:", seed, b""), us_tree())
                .map_err(|why| format!("that device sent a group this one cannot read: {why}"))?;
        let doc = UsDoc { core };
        let members = doc.members();
        let has = |key: [u8; 32]| members.iter().any(|member| member.key == key);
        if !has(me) {
            return Err("that device sent a group this one is not in".to_string());
        }
        if !has(adder) {
            return Err("that device sent a group it is not in itself".to_string());
        }
        Ok(doc)
    }

    pub const fn tree(&self) -> SedimentreeId {
        self.core.tree()
    }

    pub fn save(&self) -> Vec<u8> {
        self.core.save()
    }

    pub fn absorb(&mut self, storage: &SnapshotStorage) -> bool {
        self.core.absorb(storage)
    }

    /// The fragments automerge draws over this document at level 1 and
    /// deeper. See `crate::document::Document::fragments`.
    pub fn fragments(&self) -> Vec<automerge::Fragment> {
        self.core.fragments()
    }

    /// The commits this document has applied — its own history, whether or
    /// not the tree still holds the items that carried it.
    pub fn applied_ids(&self) -> std::collections::BTreeSet<CommitId> {
        self.core.applied_ids()
    }

    /// This document's heads, and every change hash in its history. See
    /// `crate::document::Document::heads`.
    pub fn heads(&self) -> Vec<automerge::ChangeHash> {
        self.core.heads()
    }

    pub fn change_hashes(&self) -> Vec<automerge::ChangeHash> {
        self.core.change_hashes()
    }

    /// An empty change depending on every current head — automerge's own
    /// merge commit. See `crate::document::Document::merge_anchor`.
    pub fn merge_anchor(&mut self) -> Option<NewCommit> {
        self.core.merge_anchor()
    }

    /// The bundle bytes for those fragments. See
    /// `crate::document::Document::bundle`.
    pub fn bundle(&self, fragments: Vec<automerge::Fragment>) -> Vec<Vec<u8>> {
        self.core.bundle(fragments)
    }

    pub fn last_local_commit(&mut self) -> Option<NewCommit> {
        self.core.last_local_commit()
    }

    /// The group, oldest enrollment first and the key breaking ties — an
    /// order identical on every device.
    pub fn members(&self) -> Vec<Member> {
        let doc = self.core.read();
        let Ok(Some((_value, members))) = doc.get(ROOT, MEMBERS) else {
            return Vec::new();
        };
        let mut found: Vec<Member> = doc
            .keys(&members)
            .filter_map(|hex_key| {
                let key = unhex(&hex_key)?;
                let (_value, entry) = doc.get(&members, &hex_key).ok().flatten()?;
                let petname = doc
                    .get(&entry, PETNAME)
                    .ok()
                    .flatten()
                    .and_then(|(v, _)| v.to_str().map(str::to_string))
                    .unwrap_or_default();
                let enrolled = doc
                    .get(&entry, ENROLLED)
                    .ok()
                    .flatten()
                    .and_then(|(v, _)| v.to_i64())
                    .unwrap_or(0);
                Some(Member {
                    key,
                    petname,
                    enrolled: u64::try_from(enrolled).unwrap_or(0),
                })
            })
            .collect();
        found.sort_by(|a, b| a.enrolled.cmp(&b.enrolled).then_with(|| a.key.cmp(&b.key)));
        found
    }

    /// The keyhive group and document ids this group seals its app content to.
    pub fn keyhive(&self) -> Option<([u8; 32], [u8; 32])> {
        let doc = self.core.read();
        let (_value, keyhive) = doc.get(ROOT, KEYHIVE).ok().flatten()?;
        let read = |field: &str| -> Option<[u8; 32]> {
            let (value, _id) = doc.get(&keyhive, field).ok().flatten()?;
            unhex(value.to_str()?)
        };
        Some((read(GROUP)?, read(DOC)?))
    }

    /// Record the keyhive group and document. Written once, by the device that
    /// founded the group; a joiner adopts the whole document rather than
    /// writing this.
    pub fn set_keyhive(&mut self, group: [u8; 32], doc: [u8; 32]) -> Result<(), String> {
        let (group, doc) = (hex(&group), hex(&doc));
        self.core.transact(move |tx| {
            let keyhive = match tx.get(ROOT, KEYHIVE).map_err(|e| e.to_string())? {
                Some((_value, keyhive)) => keyhive,
                None => tx
                    .put_object(ROOT, KEYHIVE, ObjType::Map)
                    .map_err(|e| e.to_string())?,
            };
            tx.put(&keyhive, GROUP, group).map_err(|e| e.to_string())?;
            tx.put(&keyhive, DOC, doc).map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// Write a member in. Idempotent on the key: re-adding a member the
    /// document already has rewrites its petname and enrollment stamp rather
    /// than authoring a second entry.
    pub fn add_member(
        &mut self,
        key: [u8; 32],
        petname: String,
        enrolled: u64,
    ) -> Result<(), String> {
        let hex_key = hex(&key);
        let stamp = i64::try_from(enrolled).unwrap_or(i64::MAX);
        self.core.transact(move |tx| {
            // `get` before `put_object`: creating a second `members` map over
            // the first would orphan every member already in it.
            let members = match tx.get(ROOT, MEMBERS).map_err(|e| e.to_string())? {
                Some((_value, members)) => members,
                None => tx
                    .put_object(ROOT, MEMBERS, ObjType::Map)
                    .map_err(|e| e.to_string())?,
            };
            let entry = match tx.get(&members, &hex_key).map_err(|e| e.to_string())? {
                Some((_value, entry)) => entry,
                None => tx
                    .put_object(&members, &hex_key, ObjType::Map)
                    .map_err(|e| e.to_string())?,
            };
            tx.put(&entry, PETNAME, petname)
                .map_err(|e| e.to_string())?;
            tx.put(&entry, ENROLLED, stamp).map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(key)
}
