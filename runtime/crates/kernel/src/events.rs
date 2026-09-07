//! The kernel's outbound event queue.
//!
//! Non-parking by contract (internal.wit `event-source`): the worker glue
//! drains after every export call it dispatches, and until the engine lands
//! every event is born inside an export activation the glue made, so draining
//! there misses nothing. The first design was a parking `next` — polyengine
//! traps an async export parked on a guest-internal waker with no host call
//! outstanding as a deadlock (polyengine#292), so there is no waker here at
//! all, only a queue.

use std::cell::RefCell;
use std::collections::VecDeque;

/// `polyvisor:internal/events.event`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A session ended other than through `apps.close`, and why.
    SessionEnded(u32, String),
}

#[derive(Default)]
pub struct Events(RefCell<VecDeque<Event>>);

impl Events {
    pub fn push(&self, event: Event) {
        self.0.borrow_mut().push_back(event);
    }

    /// Everything queued, in order, leaving the queue empty.
    pub fn drain(&self) -> Vec<Event> {
        self.0.borrow_mut().drain(..).collect()
    }
}
