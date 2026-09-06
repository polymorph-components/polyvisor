//! The kernel's outbound event queue. `next` parks while the queue is empty;
//! one waker suffices because the runtime has exactly one consumer (the
//! worker glue long-polls `events.next`) on one thread.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

/// `polyvisor:internal/events.event`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A session ended other than through `apps.close`, and why.
    SessionEnded(u32, String),
}

#[derive(Default)]
pub struct Events {
    queue: RefCell<VecDeque<Event>>,
    waiter: RefCell<Option<Waker>>,
}

impl Events {
    pub fn push(&self, event: Event) {
        self.queue.borrow_mut().push_back(event);
        if let Some(waker) = self.waiter.borrow_mut().take() {
            waker.wake();
        }
    }

    pub fn next(&self) -> Next<'_> {
        Next { events: self }
    }
}

pub struct Next<'a> {
    events: &'a Events,
}

impl Future for Next<'_> {
    type Output = Event;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Event> {
        if let Some(event) = self.events.queue.borrow_mut().pop_front() {
            return Poll::Ready(event);
        }
        *self.events.waiter.borrow_mut() = Some(cx.waker().clone());
        Poll::Pending
    }
}
