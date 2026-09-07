//! The clock seam and its adaptation to `subduction_runtime::clock::Clock`.

use core::time::Duration;
use std::cell::Cell;
use std::rc::Rc;

use future_form::{FutureForm as _, Local};
use futures::future::LocalBoxFuture;
use subduction_protocol::{
    timestamp::{Now, Timestamp},
    wall_clock::TimestampSeconds,
};
use subduction_runtime::clock::Clock;

/// What the engine needs from the world's clock: epoch milliseconds and an
/// async sleep. The runtime component serves these from
/// `wasi:clocks/{system-clock,monotonic-clock}@0.3.1`; tests serve them from
/// a virtual clock.
pub trait EngineClock {
    /// Epoch milliseconds. Not required to be monotonic — see
    /// [`ClockAdapter`].
    fn now_ms(&self) -> u64;

    /// Resolve after `ms` milliseconds.
    fn sleep(&self, ms: u64) -> LocalFuture<'_, ()>;
}

use crate::LocalFuture;

/// Presents an [`EngineClock`] as subduction's [`Clock`].
///
/// The node's `monotonic` reading drives protocol deadlines, and the browser
/// clock behind `now_ms` is a wall clock that can step backwards (NTP, a
/// laptop waking up). A backwards step would make an armed deadline fire late
/// by the size of the step, so the adapter carries a high-water mark and
/// never reports less than it has already reported. The wall reading is the
/// raw value: it is meant to be wall time.
pub struct ClockAdapter {
    inner: Rc<dyn EngineClock>,
    high_water: Cell<u64>,
}

impl ClockAdapter {
    pub fn new(inner: Rc<dyn EngineClock>) -> ClockAdapter {
        ClockAdapter {
            inner,
            high_water: Cell::new(0),
        }
    }
}

impl Clock<Local> for ClockAdapter {
    fn now(&self) -> Now {
        let raw = self.inner.now_ms();
        let monotonic = raw.max(self.high_water.get());
        self.high_water.set(monotonic);
        Now {
            monotonic: Timestamp::from_millis(monotonic),
            wall: TimestampSeconds::new(raw / 1000),
        }
    }

    fn sleep(&self, duration: Duration) -> LocalBoxFuture<'_, ()> {
        let ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        Local::from_future(async move { self.inner.sleep(ms).await })
    }
}
