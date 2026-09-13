//! The device's transport: `polymorph:iroh` under the kernel's net seams.
//!
//! What this file is responsible for is one wire, end to end:
//!
//!   * an identity built from the device's own Ed25519 seed, so the endpoint
//!     id is stable across boots and another device can dial this one by a
//!     string a person wrote down;
//!   * one bidirectional QUIC stream per connection, carrying
//!     length-prefixed frames in subduction's own framing, so a native
//!     subduction peer is a peer (docs/design.md "Sync engine": "framing per
//!     `subduction_iroh` so native subduction peers interoperate");
//!   * a clean end that reads as a clean end rather than as a failure.
//!
//! The identity comes from `polymorph:iroh/identity-from-seed`, which is the
//! one constructor interface whose identity keeps its private key inside the
//! endpoint component and signs there ("an identity made by
//! `identity-from-seed` holds its private key in the component's memory
//! instead" — iroh.wit, `interface identity`). The alternative,
//! `identity-from-keys`, keeps the key in the platform's store and reaches
//! it through an async import, which means rustls's `Signer::sign` — a
//! synchronous call on the handshake path — blocks, and the worker realm
//! has to be instantiated with JSPI to let it. The trade, recorded in
//! docs/design.md "No JSPI": TLS signatures now run in wasm ed25519-dalek
//! rather than in the browser's native crypto, and the seed sits in the
//! endpoint's memory for the endpoint's lifetime. It already passed through
//! guest memory here at every bind — this widens where it rests, not
//! whether it is there.
//!
//! Nothing here is subduction-aware: frames in, frames out.

use std::cell::{Cell, RefCell};

use polyvisor_kernel::{
    Accepted, Bound, Dialed, EngineTransport, LocalFuture, MEETING_ALPN, Net, NetHandle,
    PAIRING_ALPN, ROOT_TRANSFER_ALPN, SUBDUCTION_ALPN,
};

// The generated bindings live where `wit_bindgen::generate!` was invoked.
use crate::component::polymorph::iroh::endpoint::{
    Connection, Endpoint, EndpointOptions, RecvStream, SendStream,
};
use crate::component::polymorph::iroh::identity::Identity;
use crate::component::polymorph::iroh::identity_from_seed;
use crate::component::polymorph::iroh::types::{EndpointAddr, TransportAddr};
use crate::z32;

/// Both wires this endpoint serves, in the kernel's spelling
/// (`polyvisor_kernel::{SUBDUCTION_ALPN, PAIRING_ALPN}`): subduction's
/// frames, and pairing's ceremony. The endpoint announces both, and an
/// accepted connection carries the one it negotiated back to the kernel,
/// whose accept loop routes on it. The strings are the kernel's because the
/// kernel is what decides which wire a dial belongs on; this file only
/// spells them for `polymorph:iroh`, which takes ALPNs as bytes.
const ALPNS: [&str; 4] = [
    SUBDUCTION_ALPN,
    PAIRING_ALPN,
    MEETING_ALPN,
    ROOT_TRANSFER_ALPN,
];

/// Largest frame either direction, matching `subduction_iroh`'s
/// `MAX_FRAME_SIZE` (50 MiB). A peer that announces more is not sending a
/// frame we could hold anyway; refusing at the prefix is what keeps a bad
/// length from becoming a 4 GiB allocation.
const MAX_FRAME: usize = 50 * 1024 * 1024;

/// How much of the stream to ask for per read. The frame reassembler cares
/// only about throughput here, not boundaries.
const READ_CHUNK: u32 = 64 * 1024;

/// The kernel's [`Net`] over `polymorph:iroh`.
///
/// The relay lives here rather than in the kernel: it is `boot-config.relay`,
/// deployment configuration the glue read from the home origin, and the only
/// things that ever need it are the bind and the dial addresses — both here.
pub struct IrohNet {
    relay: String,
}

impl IrohNet {
    pub fn new(relay: String) -> Self {
        Self { relay }
    }
}

impl Net for IrohNet {
    fn bind(&self, seed: [u8; 32]) -> LocalFuture<'_, Result<Bound, String>> {
        Box::pin(async move {
            let (id, endpoint) = bind(&seed, &self.relay).await?;
            Ok((id, Box::new(endpoint) as Box<dyn NetHandle>))
        })
    }

    /// An iroh endpoint id *is* the peer's Ed25519 public key, in iroh's
    /// z-base-32 spelling — so this is that spelling and nothing else. No
    /// endpoint is needed for it, which is the point of the seam: a device
    /// whose bind failed still has a group to show, and every row in it is
    /// recorded by key.
    fn endpoint_id(&self, key: [u8; 32]) -> String {
        z32::encode(&key)
    }
}

/// Bind this device's endpoint.
///
/// `seed` is the device's Ed25519 seed from the sealed checkpoint — the same
/// seed the engine signs with, so a device's endpoint id and its subduction
/// peer id are one key.
///
/// The public half is never computed here: an identity from a seed derives
/// it itself ("the expansion of the seed to the signing scalar happens
/// here" — iroh.wit, `identity-from-seed.from-seed`), and `endpoint.id()`
/// below is what this device is known by. A seed of any length but 32 is
/// `error.invalid-argument`; every 32-byte value is a valid seed, so the
/// only way this fails is a caller bug.
///
/// Returns the endpoint id as `device-status.endpoint-id` spells it,
/// alongside the handle everything else goes through.
async fn bind(seed: &[u8; 32], relay: &str) -> Result<(String, IrohEndpoint), String> {
    let identity = identity_from_seed::from_seed(seed)
        .map_err(|e| format!("this device's identity was refused: {e:?}"))?;

    let options = EndpointOptions::new(&identity);
    // Both, before the bind: `accept` delivers only connections whose
    // negotiated ALPN was announced here (iroh.wit `endpoint.accept`), so an
    // ALPN missing from this list is a wire that silently never answers.
    for alpn in ALPNS {
        options.add_alpn(alpn.as_bytes());
    }
    options.relay_url(relay);
    // The browser profile has no UDP, so `udp-bind-addr` stays unset and the
    // relay is the dial path. WebRTC would be the upgrade off it, but this
    // component runs in a SharedWorker, where `RTCPeerConnection` does not
    // exist: the host backend never resolves there and a peer-connection
    // constructed against it throws (seen as a boot-order race in e2e). Off
    // until the endpoint has a realm with WebRTC — every dial and accept
    // stays on the relay.
    options.webrtc(false);
    let endpoint = Endpoint::bind(options)
        .await
        .map_err(|e| format!("this device could not reach the relay {relay}: {e:?}"))?;

    let id = z32::encode(&endpoint.id());
    Ok((
        id,
        IrohEndpoint {
            endpoint,
            // Held for the endpoint's life. The WIT lets one identity
            // configure any number of endpoints and says nothing about the
            // bound endpoint keeping it alive, so dropping it here would be
            // a bet on an implementation detail of the identity's lifetime
            // — and this identity is what holds the signing key.
            _identity: identity,
            relay: relay.to_string(),
        },
    ))
}

/// A bound endpoint: what dials and what answers.
pub struct IrohEndpoint {
    endpoint: Endpoint,
    _identity: Identity,
    relay: String,
}

impl NetHandle for IrohEndpoint {
    fn connect(
        &self,
        endpoint_id: String,
        alpn: String,
    ) -> LocalFuture<'_, Result<Dialed, String>> {
        Box::pin(async move { self.dial(&endpoint_id, &alpn).await })
    }

    fn accept(&self) -> LocalFuture<'_, Result<Accepted, String>> {
        Box::pin(async move { self.answer().await })
    }
}

impl IrohEndpoint {
    /// Dial a peer by the id text a person pasted.
    ///
    /// The only address offered is this device's own relay: two devices meet
    /// there or not at all until pairing carries addresses (M3b). A peer on
    /// another relay is reachable when it holds a connection to ours too —
    /// which is the relay's job, not this call's.
    ///
    /// The peer's raw key comes back with the transport: an iroh endpoint id
    /// IS that key, and the engine needs it to name who it believes it is
    /// dialing (`polyvisor_kernel::Dialed`). Decoding it here is the whole
    /// reason the kernel never has to know this spelling.
    async fn dial(&self, endpoint_id: &str, alpn: &str) -> Result<Dialed, String> {
        let bytes = z32::decode(endpoint_id.trim())?;
        if bytes.len() != 32 {
            // Said here rather than left to `invalid-argument`: the caller is
            // a person who pasted something, and "not an endpoint id" is the
            // useful half of the answer.
            return Err(format!(
                "an endpoint id is 32 bytes; this one is {}",
                bytes.len()
            ));
        }
        let key: [u8; 32] = bytes[..].try_into().expect("32 bytes, just checked");
        let addr = EndpointAddr {
            endpoint_id: bytes,
            addrs: vec![TransportAddr::Relay(self.relay.clone())],
        };
        let connection = self
            .endpoint
            .connect(addr, alpn.as_bytes().to_vec())
            .await
            .map_err(|e| format!("that device did not answer: {e:?}"))?;
        let (send, recv) = connection
            .open_bi()
            .await
            .map_err(|e| format!("that device answered but opened no stream: {e:?}"))?;
        Ok((key, Box::new(IrohTransport::new(connection, send, recv))))
    }

    /// The next connection dialed to this device, and which wire it is on.
    ///
    /// The ALPN is one of [`ALPNS`] by construction — `accept` delivers only
    /// connections whose negotiated ALPN was announced — but *which* one is
    /// the whole question now that the endpoint serves two, so it is read off
    /// the connection (iroh.wit:332) and handed to the kernel, whose accept
    /// loop routes on it. An ALPN that is not valid UTF-8 cannot be one of
    /// ours: it is reported as the connection being unusable rather than
    /// lossily transliterated into a wire name that might match.
    async fn answer(&self) -> Result<Accepted, String> {
        let connection = self
            .endpoint
            .accept()
            .await
            .map_err(|e| format!("this device stopped accepting connections: {e:?}"))?;
        let (send, recv) = connection
            .accept_bi()
            .await
            .map_err(|e| format!("a peer connected but opened no stream: {e:?}"))?;
        // The handshake authenticated it, so `peer` is who this is —
        // spelled the way `device-status.endpoint-id` spells it, because
        // the kernel matches inbound peers against ids people exchanged.
        // The raw key travels alongside: the kernel checks that the peer
        // subduction authenticates is this same one, and z-base-32 is our
        // spelling to undo, not its.
        let raw = connection.peer();
        let key: [u8; 32] = raw[..]
            .try_into()
            .map_err(|_| "a peer connected with a malformed endpoint id".to_string())?;
        let peer = z32::encode(&raw);
        let alpn = String::from_utf8(connection.alpn())
            .map_err(|_| "a peer connected on a wire this device does not serve".to_string())?;
        Ok((
            peer,
            key,
            alpn,
            Box::new(IrohTransport::new(connection, send, recv)),
        ))
    }
}

/// One connection's frames.
///
/// Framing is `subduction_iroh`'s: a u32 big-endian length, then that many
/// bytes, one frame per message
/// (legacy/subduction_iroh/src/tasks.rs:30-32, :58-61 at the pinned rev).
/// Byte-compatible on purpose — a native subduction peer speaks this and
/// nothing else.
///
/// Not `Clone`, though the upstream `Transport` is: the engine's
/// `DynTransport` already puts a `Box<dyn EngineTransport>` behind an `Rc`
/// for exactly that, so a second layer of sharing here would buy nothing.
pub struct IrohTransport {
    connection: Connection,
    send: SendStream,
    recv: RecvStream,
    /// Bytes read past the end of the last frame returned.
    pending: RefCell<Vec<u8>>,
    /// Latched once the peer's FIN (or a failure) has been seen: the WIT
    /// says the outcome repeats on every later `read`, and re-reading a
    /// closed stream to rediscover that is noise on the host.
    ended: Cell<bool>,
    closed: Cell<bool>,
}

impl EngineTransport for IrohTransport {
    fn send(&self, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), String>> {
        Box::pin(async move { self.send_frame(bytes).await })
    }

    fn recv(&self) -> LocalFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { self.next_frame().await })
    }

    fn close(&self) -> LocalFuture<'_, ()> {
        Box::pin(async move { self.hang_up() })
    }
}

impl IrohTransport {
    fn new(connection: Connection, send: SendStream, recv: RecvStream) -> Self {
        Self {
            connection,
            send,
            recv,
            pending: RefCell::new(Vec::new()),
            ended: Cell::new(false),
            closed: Cell::new(false),
        }
    }

    /// Send one frame.
    ///
    /// One `write` for prefix and payload together: the WIT permits one
    /// in-flight write per stream and refuses a second with
    /// `error.in-use`, so a prefix and a body written separately would be
    /// two chances to interleave. Concurrent senders are not a case that
    /// arises — subduction's driver sends from one `&mut self` loop
    /// (subduction_runtime/src/driver.rs:294 `async fn send(&mut self, …)`)
    /// — and if one ever did, the host refuses it loudly rather than
    /// corrupting the stream.
    async fn send_frame(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_FRAME {
            return Err(format!(
                "a {} byte message is past this wire's {MAX_FRAME} byte limit",
                bytes.len()
            ));
        }
        let mut frame = Vec::with_capacity(4 + bytes.len());
        frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        frame.extend_from_slice(&bytes);
        self.send
            .write(frame)
            .await
            .map_err(|e| format!("the connection would not carry a message: {e:?}"))
    }

    /// The next frame, or `None` once the peer is done.
    ///
    /// `None` is the clean end AND every unclean one. Upstream's contract:
    /// "a receive error is terminal: the read loop treats any error as the
    /// end of the connection" (subduction_runtime/src/transport.rs). A
    /// truncated frame — bytes still buffered when the stream ends — is an
    /// end too: there is no message there, and reporting it as a message
    /// would be inventing one.
    async fn next_frame(&self) -> Option<Vec<u8>> {
        loop {
            if let Some(frame) = self.take_frame()? {
                return Some(frame);
            }
            if self.ended.get() {
                return None;
            }
            match self.recv.read(READ_CHUNK).await {
                Ok(Some(chunk)) => self.pending.borrow_mut().extend_from_slice(&chunk),
                // The FIN, a reset, or the connection going away. All three
                // are the end of this connection's messages.
                Ok(None) | Err(_) => self.ended.set(true),
            }
        }
    }

    /// A whole frame from the buffer, `Ok(None)` when there is not one yet,
    /// and `None` (the outer option) when the length prefix is unusable —
    /// which is terminal, because there is no way to resynchronize a byte
    /// stream whose framing is wrong.
    fn take_frame(&self) -> Option<Option<Vec<u8>>> {
        let mut pending = self.pending.borrow_mut();
        if pending.len() < 4 {
            return Some(None);
        }
        let len = u32::from_be_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
        if len > MAX_FRAME {
            self.ended.set(true);
            pending.clear();
            return None;
        }
        if pending.len() < 4 + len {
            return Some(None);
        }
        let frame = pending[4..4 + len].to_vec();
        pending.drain(..4 + len);
        Some(Some(frame))
    }

    /// Close: FIN the send half so the peer's `recv` sees a clean end, then
    /// close the connection. Idempotent — the driver disconnects a
    /// connection it has already torn down.
    fn hang_up(&self) {
        if self.closed.replace(true) {
            return;
        }
        // The FIN is what turns the peer's next `read` into `none` rather
        // than a reset; a dropped `send-stream` would imply `reset(0)`
        // instead (iroh.wit, `resource send-stream`).
        let _ = self.send.finish();
        // Code 0, no reason: this is an ordinary hang-up, and the peer reads
        // it as one.
        self.connection.close(0, "");
    }
}
