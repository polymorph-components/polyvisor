//! The kernel's outbound event queue.
//!
//! A queue and one waker (internal.wit `interface events`): [`Events::next`]
//! answers immediately while something is queued and parks otherwise, and
//! [`Events::push`] wakes whoever is parked. That is what lets an event born
//! of network activity alone — a peer confirming, an enrollment landing —
//! reach a visor with no call made on this device.
//!
//! One waiter is the design, not a limitation worked around: the worker glue
//! runs a single pump over the runtime's `events.next` export. A second
//! `next` polled while another is parked therefore just replaces the stored
//! waker, and the displaced future is left for its own caller to re-poll.
//! There is deliberately no waiter list.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::future::poll_fn;
use std::task::{Poll, Waker};

/// `polyvisor:internal/events.event`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A session ended other than through `apps.close`, and why.
    SessionEnded(u32, String),
    /// The pairing ceremony moved to this phase.
    ///
    /// Pushed on every transition, including the ones no export of ours
    /// caused — a peer confirming, an offer expiring, an enrollment landing.
    /// The visor has no timer and `pairing.status` may not park, so this is
    /// the only way a transition the OTHER device drove reaches a screen
    /// (internal.wit `events.pairing-changed`).
    PairingChanged(crate::pairing::Phase),
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Event>,
    waker: Option<Waker>,
}

#[derive(Default)]
pub struct Events(RefCell<Inner>);

impl Events {
    pub fn push(&self, event: Event) {
        // The waker is taken while the cell is borrowed and woken after it is
        // released: `wake` may poll the waiting task synchronously, and that
        // poll borrows this same cell.
        let waker = {
            let mut inner = self.0.borrow_mut();
            inner.queue.push_back(event);
            inner.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// The next event, parking while there is none.
    pub fn next(&self) -> impl Future<Output = Event> + '_ {
        poll_fn(|cx| {
            let mut inner = self.0.borrow_mut();
            match inner.queue.pop_front() {
                Some(event) => Poll::Ready(event),
                None => {
                    inner.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        })
    }
}
