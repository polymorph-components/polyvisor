//! The transport seam and its adaptation to
//! `subduction_runtime::transport::Transport`.

use std::rc::Rc;

use future_form::{FutureForm as _, Local};
use futures::future::LocalBoxFuture;
use subduction_runtime::transport::Transport;

use crate::LocalFuture;

/// One framed, bidirectional byte connection, object-safe.
///
/// This is what the runtime component implements over `polymorph:iroh`
/// streams (one `send` is one length-prefixed frame on the bidi stream) and
/// what a test implements over a channel pair. Arguments are owned so the
/// returned future borrows only the transport.
///
/// Contract, mirroring subduction_runtime/src/transport.rs:5:
///
/// - `send` delivers the whole message or fails; there are no partial sends;
/// - `recv` answers one complete frame, or `None` once no further frame will
///   arrive. A transport failure is *also* `None`: the read loop ends the
///   connection on any error anyway, so a distinct error channel here would
///   only be discarded (subduction_runtime/src/driver/handle.rs:215).
/// - `close` is idempotent.
pub trait EngineTransport {
    fn send(&self, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), String>>;
    fn recv(&self) -> LocalFuture<'_, Option<Vec<u8>>>;
    fn close(&self) -> LocalFuture<'_, ()>;
}

/// A [`EngineTransport`] as a subduction [`Transport`].
///
/// `Transport` is `Clone` (the driver keeps one copy and the read loop
/// another), and a `Box<dyn EngineTransport>` is not, so the wrapper is an
/// `Rc`. Cloning it shares the one connection, which is exactly right: both
/// copies are ends of the same stream.
#[derive(Clone)]
pub struct DynTransport(Rc<dyn EngineTransport>);

impl DynTransport {
    #[must_use]
    pub fn new(inner: Box<dyn EngineTransport>) -> DynTransport {
        DynTransport(Rc::from(inner))
    }
}

impl core::fmt::Debug for DynTransport {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("DynTransport")
    }
}

impl Transport<Local> for DynTransport {
    type Error = TransportError;

    fn send_bytes(&self, bytes: Vec<u8>) -> LocalBoxFuture<'_, Result<(), Self::Error>> {
        Local::from_future(async move { self.0.send(bytes).await.map_err(TransportError) })
    }

    fn recv_bytes(&self) -> LocalBoxFuture<'_, Result<Option<Vec<u8>>, Self::Error>> {
        Local::from_future(async move { Ok(self.0.recv().await) })
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, ()> {
        Local::from_future(async move { self.0.close().await })
    }
}

/// A terminal transport failure, in the seam's own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError(pub String);

impl core::fmt::Display for TransportError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

impl core::error::Error for TransportError {}
