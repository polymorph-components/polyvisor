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
use std::collections::BTreeSet;
use std::rc::Rc;

use future_form::{FutureForm as _, Local};
use sedimentree_core::id::SedimentreeId;
use subduction_protocol::storage::Provenance;
use subduction_runtime::policy::{Policy, StorageAction, Verdict};

/// The member keys, shared between the engine (which rewrites it whenever the
/// user-system document changes) and the policy (which reads it on every
/// storage operation).
pub type Members = Rc<RefCell<BTreeSet<[u8; 32]>>>;

/// Allows this device's own operations, and a remote peer's exactly while it
/// is in the group.
#[derive(Debug, Clone)]
pub struct GroupPolicy {
    members: Members,
}

impl GroupPolicy {
    #[must_use]
    pub fn new(members: Members) -> GroupPolicy {
        GroupPolicy { members }
    }
}

impl Policy<Local> for GroupPolicy {
    fn authorize(
        &self,
        provenance: &Provenance,
        _tree: SedimentreeId,
        _action: StorageAction,
    ) -> <Local as future_form::FutureForm>::Future<'_, Verdict> {
        let verdict = match provenance {
            Provenance::Local => Verdict::Allow,
            Provenance::Remote(peer) => {
                if self.members.borrow().contains(peer.as_bytes()) {
                    Verdict::Allow
                } else {
                    Verdict::Deny
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
        let policy = GroupPolicy::new(Rc::clone(&members));
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
}
