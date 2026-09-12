//! Disposable opaque Sedimentree trees and their current-slot register.
//!
//! The register itself lives in the plaintext user-system document.  Payloads
//! remain ordinary signed Sedimentree commits, but are never interpreted as
//! Automerge changes and are never passed to the fragment compactor.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

const OPAQUE_PREFIX: [u8; 4] = *b"OPQ1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum OpaqueMode {
    /// The trusted caller supplies plaintext; the engine seals it under the
    /// current device group's keyhive document.
    GroupSealed,
    /// The trusted caller supplies an already encrypted envelope. The engine
    /// treats the bytes as ciphertext and never provides a plaintext bypass
    /// to an untrusted app.
    CallerEncrypted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueItem {
    pub id: [u8; 32],
    pub parents: Vec<[u8; 32]>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct RegisterValue {
    pub sequence: u64,
    pub nonce: [u8; 16],
    pub mode: Option<OpaqueMode>,
}

impl RegisterValue {
    pub(crate) fn encode(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(25);
        out.extend_from_slice(&self.sequence.to_be_bytes());
        out.extend_from_slice(&self.nonce);
        out.push(match self.mode {
            None => 0,
            Some(OpaqueMode::GroupSealed) => 1,
            Some(OpaqueMode::CallerEncrypted) => 2,
        });
        out
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != 25 {
            return None;
        }
        let sequence = u64::from_be_bytes(bytes[..8].try_into().ok()?);
        let nonce = bytes[8..24].try_into().ok()?;
        let mode = match bytes[24] {
            0 => None,
            1 => Some(OpaqueMode::GroupSealed),
            2 => Some(OpaqueMode::CallerEncrypted),
            _ => return None,
        };
        Some(Self {
            sequence,
            nonce,
            mode,
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct LifecycleState {
    pub registers: BTreeMap<[u8; 12], RegisterValue>,
    pub ready_peers: BTreeMap<[u8; 32], usize>,
}

pub(crate) type Lifecycle = Rc<RefCell<LifecycleState>>;

pub(crate) fn slot_hash(slot: &str) -> [u8; 12] {
    let digest = Sha256::new()
        .chain_update(b"polyvisor:opaque-slot:v1\0")
        .chain_update(slot.as_bytes())
        .finalize();
    digest[..12].try_into().expect("fixed digest slice")
}

pub(crate) fn tree_id(slot: [u8; 12], nonce: [u8; 16]) -> [u8; 32] {
    let mut id = [0; 32];
    id[..4].copy_from_slice(&OPAQUE_PREFIX);
    id[4..16].copy_from_slice(&slot);
    id[16..].copy_from_slice(&nonce);
    id
}

pub(crate) fn tree_slot(tree: &[u8; 32]) -> Option<[u8; 12]> {
    is_opaque_tree(tree).then(|| tree[4..16].try_into().expect("fixed tree slice"))
}

#[must_use]
pub fn is_opaque_tree(tree: &[u8; 32]) -> bool {
    tree[..4] == OPAQUE_PREFIX
}

pub(crate) fn status(lifecycle: &Lifecycle, tree: &[u8; 32]) -> Option<bool> {
    let slot = tree_slot(tree)?;
    let current = lifecycle.borrow().registers.get(&slot).copied()?;
    Some(current.mode.is_some() && tree_id(slot, current.nonce) == *tree)
}

pub(crate) fn mode(lifecycle: &Lifecycle, tree: &[u8; 32]) -> Option<OpaqueMode> {
    status(lifecycle, tree)
        .filter(|current| *current)
        .and_then(|_| {
            lifecycle
                .borrow()
                .registers
                .get(&tree_slot(tree)?)
                .and_then(|v| v.mode)
        })
}

pub(crate) fn item_id(tree: [u8; 32], parents: &[[u8; 32]], bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"polyvisor:opaque-item:v1\0");
    hasher.update(tree);
    hasher.update((parents.len() as u64).to_be_bytes());
    for parent in parents {
        hasher.update(parent);
    }
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    hasher.finalize().into()
}
