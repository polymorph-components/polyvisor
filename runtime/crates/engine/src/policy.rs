//! Group membership as subduction's storage authorization.
//!
//! internal.wit `pairing`: a device's group is its user-system document, and
//! nothing outside it may read or write this device's trees. The kernel
//! disconnects a non-member after the handshake (`sync.rs`); this is the
//! second half of the same rule, applied to every storage operation the
//! driver performs on a remote peer's behalf, so a peer that slips past the
//! connection check still moves no data.
//!
//! Local operations are always allowed: `Provenance::Local` is this device's
//! own app calls, which are gated by the kernel long before they reach here
//! (subduction_runtime/src/policy.rs:15).

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use future_form::{FutureForm as _, Local};
use sedimentree_core::id::SedimentreeId;
use subduction_protocol::storage::Provenance;
use subduction_runtime::policy::{Policy, StorageAction, Verdict};

/// The member keys, shared between the engine (which rewrites it whenever the
/// user-system document changes) and the policy (which reads it on every
/// storage operation).
pub type Members = Rc<RefCell<BTreeSet<[u8; 32]>>>;

#[derive(Debug, Clone, Default)]
pub(crate) struct TreeAuthority {
    pub readers: BTreeSet<[u8; 32]>,
    pub editors: BTreeSet<[u8; 32]>,
}

pub(crate) type SharedAuthorities = Rc<RefCell<BTreeMap<SedimentreeId, TreeAuthority>>>;

/// Allows this device's own operations, and a remote peer's exactly while it
/// is in the group.
#[derive(Debug, Clone)]
pub struct GroupPolicy {
    members: Members,
    lifecycle: crate::opaque::Lifecycle,
    shared: SharedAuthorities,
}

impl GroupPolicy {
    #[must_use]
    pub fn new(
        members: Members,
        lifecycle: crate::opaque::Lifecycle,
        shared: SharedAuthorities,
    ) -> GroupPolicy {
        GroupPolicy {
            members,
            lifecycle,
            shared,
        }
    }
}

impl Policy<Local> for GroupPolicy {
    fn authorize(
        &self,
        provenance: &Provenance,
        tree: SedimentreeId,
        action: StorageAction,
    ) -> <Local as future_form::FutureForm>::Future<'_, Verdict> {
        let retired = crate::opaque::is_opaque_tree(tree.as_bytes())
            && crate::opaque::status(&self.lifecycle, tree.as_bytes()) != Some(true);
        let peer_not_ready = matches!(provenance, Provenance::Remote(peer)
            if crate::opaque::is_opaque_tree(tree.as_bytes())
                && !self.lifecycle.borrow().ready_peers.contains_key(peer.as_bytes()));
        let shared = self.shared.borrow().get(&tree).cloned();
        let verdict = if (retired || peer_not_ready) && action != StorageAction::Delete {
            Verdict::Deny
        } else {
            match provenance {
                Provenance::Local => Verdict::Allow,
                Provenance::Remote(peer) => {
                    // A known shared tree is governed only by its Keyhive
                    // document. Own-group membership must not bypass a
                    // document grant while a newly enrolled device races
                    // scoped authority delivery. Remote deletion is never
                    // part of document sharing v0.
                    let reserved = matches!(
                        tree.as_bytes()[0],
                        crate::SHARED_TREE_TAG | crate::SHARED_AUTHORITY_TREE_TAG
                    );
                    let allowed = if let Some(authority) = &shared {
                        action != StorageAction::Delete
                            && authority.readers.contains(peer.as_bytes())
                    } else if reserved {
                        false
                    } else {
                        self.members.borrow().contains(peer.as_bytes())
                    };
                    if allowed {
                        Verdict::Allow
                    } else {
                        Verdict::Deny
                    }
                }
            }
        };
        Local::ready(verdict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use futures::executor::block_on;
    use subduction_protocol::peer_id::PeerId;

    fn peer(seed: u8) -> PeerId {
        PeerId::from(SigningKey::from_bytes(&[seed; 32]).verifying_key())
    }

    #[test]
    fn only_the_group_may_touch_this_devices_storage() {
        let member = peer(1);
        let stranger = peer(2);
        let members: Members = Rc::new(RefCell::new(
            [*member.as_bytes()].into_iter().collect::<BTreeSet<_>>(),
        ));
        let policy = GroupPolicy::new(
            Rc::clone(&members),
            Rc::new(RefCell::new(Default::default())),
            Rc::new(RefCell::new(Default::default())),
        );
        let tree = SedimentreeId::new([9u8; 32]);

        for action in [
            StorageAction::Read,
            StorageAction::Write,
            StorageAction::Delete,
        ] {
            assert_eq!(
                block_on(policy.authorize(&Provenance::Local, tree, action)),
                Verdict::Allow,
                "this device's own operations are the kernel's to gate, not this",
            );
            assert_eq!(
                block_on(policy.authorize(&Provenance::Remote(member), tree, action)),
                Verdict::Allow,
            );
            assert_eq!(
                block_on(policy.authorize(&Provenance::Remote(stranger), tree, action)),
                Verdict::Deny,
                "a peer outside the group moves no data, in either direction",
            );
        }

        // And the verdict follows the document: enrolling the stranger is
        // what lets it read, and nothing else has to be rebuilt for that.
        let _added = members.borrow_mut().insert(*stranger.as_bytes());
        assert_eq!(
            block_on(policy.authorize(&Provenance::Remote(stranger), tree, StorageAction::Read)),
            Verdict::Allow,
        );
    }

    #[test]
    fn locally_completed_control_allows_opaque_without_catalog_pump_progress() {
        let member = peer(3);
        let members: Members = Rc::new(RefCell::new([*member.as_bytes()].into_iter().collect()));
        let lifecycle = Rc::new(RefCell::new(crate::opaque::LifecycleState::default()));
        let slot = crate::opaque::slot_hash("paused-pump");
        let nonce = [5; 16];
        lifecycle.borrow_mut().registers.insert(
            slot,
            crate::opaque::RegisterValue {
                sequence: 1,
                nonce,
                mode: Some(crate::OpaqueMode::CallerEncrypted),
            },
        );
        // This is set by the local SyncFinished phase before catalog send.
        // Catalog receipt belongs to discovery and is deliberately absent:
        // a paused app pump on the peer cannot race local admission.
        lifecycle
            .borrow_mut()
            .ready_peers
            .insert(*member.as_bytes(), 1);
        let policy = GroupPolicy::new(
            members,
            lifecycle,
            Rc::new(RefCell::new(Default::default())),
        );
        assert_eq!(
            block_on(policy.authorize(
                &Provenance::Remote(member),
                SedimentreeId::new(crate::opaque::tree_id(slot, nonce)),
                StorageAction::Write,
            )),
            Verdict::Allow
        );
    }

    #[test]
    fn shared_tree_never_allows_remote_delete_or_group_fallback() {
        let member = peer(4);
        let reader = peer(5);
        let tree = SedimentreeId::new([crate::SHARED_TREE_TAG; 32]);
        let members: Members = Rc::new(RefCell::new([*member.as_bytes()].into_iter().collect()));
        let shared = Rc::new(RefCell::new(BTreeMap::from([(
            tree,
            TreeAuthority {
                readers: [*reader.as_bytes()].into_iter().collect(),
                editors: BTreeSet::new(),
            },
        )])));
        let policy = GroupPolicy::new(members, Rc::new(RefCell::new(Default::default())), shared);
        assert_eq!(
            block_on(policy.authorize(&Provenance::Remote(reader), tree, StorageAction::Read)),
            Verdict::Allow
        );
        assert_eq!(
            block_on(policy.authorize(&Provenance::Remote(reader), tree, StorageAction::Delete)),
            Verdict::Deny
        );
        assert_eq!(
            block_on(policy.authorize(&Provenance::Remote(member), tree, StorageAction::Read)),
            Verdict::Deny,
            "own-group membership cannot bypass the shared document grant"
        );
    }
}
