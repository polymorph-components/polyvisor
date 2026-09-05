//! THE PARKED DEK.
//!
//! Where seal.ts handed a non-extractable `CryptoKey` back to the worker
//! for it to hold, this component parks it here (world.wit:210-215).
//! Dropping the component re-seals the device exactly as dropping the
//! handle did, and `forget` is the explicit form of the same thing.
//!
//! `Rc`, not a bare `Aead`, so a ceremony can take a counted reference
//! out of the cell and hold it across an `await` without holding the
//! `RefCell` borrow — the rule the async exports would otherwise break
//! the first time two of them overlapped.

use std::cell::RefCell;
use std::rc::Rc;

use polymorph_webcrypto_guest::Aead;

thread_local! {
    /// The DEK, non-extractable, for as long as this instance lives.
    /// `None` means the component is sealed.
    static PARKED: RefCell<Option<Rc<Aead>>> = const { RefCell::new(None) };
}

/// Park the DEK. THE PARKED HANDLE IS NEVER THE WRAPPABLE ONE
/// (world.wit:220-224): every caller here passes the key it re-unwrapped
/// `extractable: false`, never the ceremony's local.
pub fn park(dek: Aead) {
    PARKED.with(|slot| *slot.borrow_mut() = Some(Rc::new(dek)));
}

/// Drop the parked DEK. The namespace is untouched.
pub fn forget() {
    PARKED.with(|slot| *slot.borrow_mut() = None);
}

/// Whether a DEK is parked in this component.
pub fn unsealed() -> bool {
    PARKED.with(|slot| slot.borrow().is_some())
}

/// A counted reference to the parked DEK, or `None` when the component is
/// sealed. The borrow ends inside this function, so the caller may hold
/// the result across an `await`.
pub fn dek() -> Option<Rc<Aead>> {
    PARKED.with(|slot| slot.borrow().clone())
}
