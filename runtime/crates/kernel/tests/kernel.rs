//! Native tests for the kernel. Everything the runtime component does is
//! reachable here because the component holds no logic of its own.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::task::Poll;

use futures::channel::mpsc;
use futures::future::LocalBoxFuture;
use futures::stream::StreamExt as _;
use futures::{executor::LocalPool, task::LocalSpawnExt as _};
use polyvisor_kernel::{
    Accepted, BootConfig, Bound, Clock, Dialed, EngineTransport, Error, ErrorCode, Event, Fetch,
    Files, HttpResponse, IndexRow, Kernel, LEASE_TTL_MS, LocalFuture, Locks, Net, NetHandle, Phase,
    Platform, Rest, Rng, Seams, Spawn, State, Tier,
};

// -- harness -----------------------------------------------------------------

/// One executor per test thread. The kernel's sync engine is a driver task,
/// an event pump and a read loop per connection, all spawned rather than
/// awaited; every `block_on` here therefore has to drive the whole pool, not
/// just the future it was handed.
///
/// The spawner is held beside the pool rather than taken from it on demand:
/// the kernel spawns *while* a `run_until` is in flight, and the pool's cell
/// is mutably borrowed for the whole of that.
struct TestPool {
    pool: RefCell<LocalPool>,
    spawner: futures::executor::LocalSpawner,
}

thread_local! {
    static POOL: TestPool = {
        let pool = LocalPool::new();
        let spawner = pool.spawner();
        TestPool { pool: RefCell::new(pool), spawner }
    };
}

/// Run `fut` to completion, giving every spawned task its turns.
fn block_on<F: Future>(fut: F) -> F::Output {
    POOL.with(|pool| pool.pool.borrow_mut().run_until(fut))
}

/// The `Spawn` seam over the test's pool.
struct PoolSpawn;

impl Spawn for PoolSpawn {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        POOL.with(|pool| {
            pool.spawner
                .spawn_local(future)
                .expect("the local pool accepts tasks")
        });
    }
}

/// Let every spawned task make progress until `check` answers `Some`.
/// Bounded, so a wedged engine fails the test instead of hanging it.
fn settle_until<F, Fut, T>(mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    block_on(async {
        for _ in 0..8192 {
            if let Some(found) = check().await {
                return found;
            }
            yield_now().await;
        }
        panic!("the kernels never converged");
    })
}

/// Hand the pool back one turn, so spawned tasks run.
async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            return Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    })
    .await;
}

/// Run every spawned task until it has nothing left to do this instant.
fn settle() {
    block_on(async {
        for _ in 0..64 {
            yield_now().await;
        }
    });
}

// -- the network fake --------------------------------------------------------

/// One end of an in-memory connection, as the kernel's transport seam.
struct Pipe {
    tx: RefCell<mpsc::UnboundedSender<Vec<u8>>>,
    rx: RefCell<mpsc::UnboundedReceiver<Vec<u8>>>,
}

/// One end of a connection, and the sending half it talks through — kept
/// beside it so a test can cut that end's wire (see [`FakeNet::unplug`]).
struct End {
    transport: Box<dyn EngineTransport>,
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

impl Pipe {
    fn pair() -> (End, End) {
        let (a_tx, a_rx) = mpsc::unbounded();
        let (b_tx, b_rx) = mpsc::unbounded();
        (
            End {
                transport: Box::new(Pipe {
                    tx: RefCell::new(a_tx.clone()),
                    rx: RefCell::new(b_rx),
                }),
                tx: a_tx,
            },
            End {
                transport: Box::new(Pipe {
                    tx: RefCell::new(b_tx.clone()),
                    rx: RefCell::new(a_rx),
                }),
                tx: b_tx,
            },
        )
    }
}

impl EngineTransport for Pipe {
    fn send(&self, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.tx
                .borrow()
                .unbounded_send(bytes)
                .map_err(|_| "the peer is gone".to_string())
        })
    }

    fn recv(&self) -> LocalFuture<'_, Option<Vec<u8>>> {
        // Polled rather than awaited on a held borrow: the receiver's cell is
        // borrowed for the poll only.
        Box::pin(futures::future::poll_fn(move |cx| {
            self.rx.borrow_mut().poll_next_unpin(cx)
        }))
    }

    fn close(&self) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            self.tx.borrow_mut().close_channel();
            self.rx.borrow_mut().close();
        })
    }
}

/// Every endpoint on the fake network, by endpoint id.
type Switchboard = Rc<RefCell<BTreeMap<String, mpsc::UnboundedSender<Accepted>>>>;

/// Every end each endpoint owns, by endpoint id, so a test can cut them.
type Wires = Rc<RefCell<BTreeMap<String, Vec<mpsc::UnboundedSender<Vec<u8>>>>>>;

/// Endpoint ids that announce a key other than their own.
type Liars = Rc<RefCell<BTreeMap<String, [u8; 32]>>>;

/// Endpoints whose inbound connections are queued rather than delivered, and
/// the queue. What a test needs to put two dials in flight at once: without
/// it the first dial is answered before the second is made, and the race the
/// single-claim rule exists for cannot be staged at all.
type Held = Rc<RefCell<BTreeMap<String, Vec<Accepted>>>>;

/// A rewrite applied to everything an endpoint sends.
type Mangler = Rc<dyn Fn(Vec<u8>) -> Vec<u8>>;
type Manglers = Rc<RefCell<BTreeMap<String, Mangler>>>;

/// One end of a connection whose outgoing messages are rewritten in flight.
struct Mangled {
    inner: Box<dyn EngineTransport>,
    mangle: Mangler,
}

impl EngineTransport for Mangled {
    fn send(&self, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), String>> {
        self.inner.send((self.mangle)(bytes))
    }
    fn recv(&self) -> LocalFuture<'_, Option<Vec<u8>>> {
        self.inner.recv()
    }
    fn close(&self) -> LocalFuture<'_, ()> {
        self.inner.close()
    }
}

/// Distinct `World`s share one [`FakeNet`] when a test wants two devices that
/// can see each other.
/// The `Net` seam: endpoints on a shared switchboard, each connection a
/// [`Pipe`] pair.
///
/// `gate` stands in for the relay handshake a real bind waits on: `bind` does
/// not resolve until it is open. A gate that is never opened is a relay that
/// never answers, which is the case the kernel must not boot behind.
#[derive(Clone)]
struct FakeNet {
    switchboard: Switchboard,
    gate: Rc<Cell<bool>>,
    /// Every end each endpoint owns, so [`FakeNet::unplug`] can cut them all
    /// at once.
    wires: Wires,
    /// Endpoint ids that announce a key other than the one they hold — a
    /// dialer claiming to be a device it is not. Real iroh cannot produce
    /// this (the id *is* the key), but the kernel does not get to assume the
    /// endpoint component is the only thing on the other side of the seam.
    liars: Liars,
    /// Endpoint ids whose outgoing frames are rewritten (see
    /// [`FakeNet::tamper`]).
    manglers: Manglers,
    /// Endpoint ids not answering their door yet (see [`FakeNet::hold`]).
    held: Held,
}

impl Default for FakeNet {
    fn default() -> Self {
        FakeNet {
            switchboard: Switchboard::default(),
            gate: Rc::new(Cell::new(true)),
            wires: Rc::default(),
            liars: Rc::default(),
            manglers: Rc::default(),
            held: Rc::default(),
        }
    }
}

impl FakeNet {
    /// A network whose bind waits until [`FakeNet::open_gate`].
    fn gated() -> FakeNet {
        FakeNet {
            gate: Rc::new(Cell::new(false)),
            ..FakeNet::default()
        }
    }

    fn open_gate(&self) {
        self.gate.set(true);
    }

    /// Pull an endpoint off the network: it stops answering dials, and every
    /// pipe it handed out closes — a worker that died, from its peers' side.
    /// Make `endpoint_id` announce `key` when it dials, instead of its own.
    fn impersonate(&self, endpoint_id: &str, key: [u8; 32]) {
        let _previous = self.liars.borrow_mut().insert(endpoint_id.to_string(), key);
    }

    fn unplug(&self, endpoint_id: &str) {
        let _sender = self.switchboard.borrow_mut().remove(endpoint_id);
        self.cut(endpoint_id);
    }

    /// Cut every wire an endpoint holds while leaving it on the network: the
    /// connections drop, and the device still answers new dials. A relay
    /// hiccup, rather than a worker that died.
    fn cut(&self, endpoint_id: &str) {
        for wire in self
            .wires
            .borrow_mut()
            .remove(endpoint_id)
            .unwrap_or_default()
        {
            wire.close_channel();
        }
    }

    /// Rewrite what `endpoint_id` puts on the wire. The only way to put a
    /// *misbehaving* peer on the other side of a ceremony: both kernels here
    /// are honest, so the frame has to be tampered with in flight.
    fn tamper(&self, endpoint_id: &str, f: Mangler) {
        let _previous = self
            .manglers
            .borrow_mut()
            .insert(endpoint_id.to_string(), f);
    }

    /// Queue every connection dialed to `endpoint_id` instead of delivering
    /// it, until [`FakeNet::release`].
    fn hold(&self, endpoint_id: &str) {
        let _previous = self
            .held
            .borrow_mut()
            .insert(endpoint_id.to_string(), Vec::new());
    }

    /// Deliver everything that piled up, in one go.
    fn release(&self, endpoint_id: &str) {
        let waiting = self
            .held
            .borrow_mut()
            .remove(endpoint_id)
            .unwrap_or_default();
        let switchboard = self.switchboard.borrow();
        let Some(peer) = switchboard.get(endpoint_id) else {
            return;
        };
        for accepted in waiting {
            peer.unbounded_send(accepted)
                .expect("the held endpoint is still listening");
        }
    }
}

/// The endpoint id a key spells, and its inverse.
///
/// The real spelling is z-base-32 of the device's Ed25519 public key; the
/// property everything here depends on is that the id and the key determine
/// each other, so the fake spells the key in hex.
fn id_of_key(key: [u8; 32]) -> String {
    key.iter().map(|b| format!("{b:02x}")).collect()
}

fn endpoint_id_of(seed: [u8; 32]) -> String {
    id_of_key(
        ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .to_bytes(),
    )
}

fn key_of(endpoint_id: &str) -> Option<[u8; 32]> {
    if endpoint_id.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(endpoint_id.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(key)
}

impl Net for FakeNet {
    fn bind(&self, seed: [u8; 32]) -> LocalFuture<'_, Result<Bound, String>> {
        Box::pin(async move {
            while !self.gate.get() {
                yield_now().await;
            }
            let id = endpoint_id_of(seed);
            let (tx, rx) = mpsc::unbounded();
            let _previous = self.switchboard.borrow_mut().insert(id.clone(), tx);
            let handle: Box<dyn NetHandle> = Box::new(FakeEndpoint {
                id: id.clone(),
                key: key_of(&id).expect("a bound endpoint id spells a key"),
                wires: Rc::clone(&self.wires),
                liars: Rc::clone(&self.liars),
                manglers: Rc::clone(&self.manglers),
                held: Rc::clone(&self.held),
                switchboard: Rc::clone(&self.switchboard),
                inbound: RefCell::new(rx),
            });
            Ok((id, handle))
        })
    }

    fn endpoint_id(&self, key: [u8; 32]) -> String {
        id_of_key(key)
    }
}

struct FakeEndpoint {
    id: String,
    wires: Wires,
    liars: Liars,
    manglers: Manglers,
    held: Held,
    /// The key this endpoint id spells — what a dialer's side of the wire
    /// tells the accepting kernel, so it can check who authenticates.
    key: [u8; 32],
    switchboard: Switchboard,
    inbound: RefCell<mpsc::UnboundedReceiver<Accepted>>,
}

impl NetHandle for FakeEndpoint {
    fn connect(
        &self,
        endpoint_id: String,
        alpn: String,
    ) -> LocalFuture<'_, Result<Dialed, String>> {
        Box::pin(async move {
            let key = key_of(&endpoint_id)
                .ok_or_else(|| format!("{endpoint_id} is not an endpoint id"))?;
            let peer = self
                .switchboard
                .borrow()
                .get(&endpoint_id)
                .cloned()
                .ok_or_else(|| format!("no device answers at {endpoint_id}"))?;
            let (here, there) = Pipe::pair();
            {
                // Each end is owned by the device at its own side of the
                // wire, which is what makes `unplug` cut the right ones.
                let mut wires = self.wires.borrow_mut();
                wires.entry(self.id.clone()).or_default().push(here.tx);
                wires.entry(endpoint_id.clone()).or_default().push(there.tx);
            }
            let announced = self
                .liars
                .borrow()
                .get(&self.id)
                .copied()
                .unwrap_or(self.key);
            let accepted = (self.id.clone(), announced, alpn, there.transport);
            match self.held.borrow_mut().get_mut(&endpoint_id) {
                Some(queue) => queue.push(accepted),
                None => peer
                    .unbounded_send(accepted)
                    .map_err(|_| "the peer is gone".to_string())?,
            }
            let mine = match self.manglers.borrow().get(&self.id) {
                Some(mangle) => Box::new(Mangled {
                    inner: here.transport,
                    mangle: Rc::clone(mangle),
                }) as Box<dyn EngineTransport>,
                None => here.transport,
            };
            Ok((key, mine))
        })
    }

    fn accept(&self) -> LocalFuture<'_, Result<Accepted, String>> {
        Box::pin(async move {
            futures::future::poll_fn(|cx| self.inbound.borrow_mut().poll_next_unpin(cx))
                .await
                .ok_or_else(|| "this endpoint is closed".to_string())
        })
    }
}

type Store = Rc<RefCell<BTreeMap<String, Vec<u8>>>>;

/// The kv, with a one-shot trap: `abort_on(key)` makes the *next* `set` of
/// that key panic, which is how a test stands in for the worker dying
/// mid-sequence. `Kernel::boot` and the mutation paths are plain `async fn`s
/// over these fakes, so an unwind here leaves exactly the persisted prefix
/// the crash would have left.
#[derive(Default, Clone)]
struct FakeKv {
    store: Store,
    abort_on: Rc<RefCell<Option<String>>>,
}

impl FakeKv {
    fn abort_on(&self, key: &str) {
        *self.abort_on.borrow_mut() = Some(key.to_string());
    }
}

impl Platform for FakeKv {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        let value = self.store.borrow().get(&key).cloned();
        Box::pin(async move { value })
    }
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()> {
        if self.abort_on.borrow().as_deref() == Some(key.as_str()) {
            self.abort_on.borrow_mut().take();
            panic!("the worker died before `set {key}`");
        }
        self.store.borrow_mut().insert(key, value);
        Box::pin(async {})
    }
    fn delete(&self, key: String) -> LocalFuture<'_, ()> {
        self.store.borrow_mut().remove(&key);
        Box::pin(async {})
    }
    fn keys(&self, prefix: String) -> LocalFuture<'_, Vec<String>> {
        let keys: Vec<String> = self
            .store
            .borrow()
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        Box::pin(async move { keys })
    }
}

/// A flat path -> bytes map, which is what OPFS is behind its directory
/// handles: a directory exists exactly where a file is under it. There is no
/// `list`, because the kernel has none — the seam is `read`/`write`/
/// `remove_file`/`remove_dir` and every path is named.
#[derive(Default, Clone)]
struct FakeFiles {
    store: Store,
    /// How many of the next writes report failure without storing anything.
    failures: Rc<Cell<u32>>,
    /// Writes in flight now, and the most there have ever been at once.
    ///
    /// The OPFS host refuses concurrent access handles, so "two writes
    /// overlapping" is not a performance question here — it is the error the
    /// glue reported. A write therefore yields between taking the count up
    /// and putting it down, which is where a second writer would slot in if
    /// the kernel let one.
    in_flight: Rc<Cell<u32>>,
    peak_in_flight: Rc<Cell<u32>>,
    /// Paths written, in order, for counting checkpoints.
    written: Rc<RefCell<Vec<String>>>,
}

impl FakeFiles {
    fn paths(&self) -> Vec<String> {
        self.store.borrow().keys().cloned().collect()
    }
    fn under(&self, prefix: &str) -> bool {
        self.paths().iter().any(|p| p.starts_with(prefix))
    }
    fn has(&self, path: &str) -> bool {
        self.store.borrow().contains_key(path)
    }
    fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.store.borrow().get(path).cloned()
    }
    /// The next `n` writes fail — a full disk, a revoked handle, an evicted
    /// OPFS. The kernel may not advance its pointer over any of them.
    fn fail_next_writes(&self, n: u32) {
        self.failures.set(n);
    }
}

impl Files for FakeFiles {
    fn read(&self, path: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        let value = self.store.borrow().get(&path).cloned();
        Box::pin(async move { value })
    }
    fn write(&self, path: String, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), ()>> {
        if self.failures.get() > 0 {
            self.failures.set(self.failures.get() - 1);
            return Box::pin(async { Err(()) });
        }
        Box::pin(async move {
            let depth = self.in_flight.get() + 1;
            self.in_flight.set(depth);
            self.peak_in_flight
                .set(self.peak_in_flight.get().max(depth));
            // Several turns, not one: the window a second writer would have
            // to slip into has to be wide enough for the engine's driver and
            // event pump to get their turns inside it.
            for _ in 0..8 {
                yield_now().await;
            }
            self.written.borrow_mut().push(path.clone());
            self.store.borrow_mut().insert(path, bytes);
            self.in_flight.set(self.in_flight.get() - 1);
            Ok(())
        })
    }
    fn remove_file(&self, path: String) -> LocalFuture<'_, ()> {
        self.store.borrow_mut().remove(&path);
        Box::pin(async {})
    }
    fn remove_dir(&self, _path: String) -> LocalFuture<'_, ()> {
        // Directories are implied by the files under them here, so removing
        // one is a no-op — and removing a *non-empty* one has to stay a
        // no-op, or these tests would hide the kernel forgetting a file.
        Box::pin(async {})
    }
}

#[derive(Default, Clone)]
struct FakeLocks(Rc<RefCell<BTreeSet<String>>>);

impl Locks for FakeLocks {
    fn is_held(&self, name: String) -> LocalFuture<'_, bool> {
        let held = self.0.borrow().contains(&name);
        Box::pin(async move { held })
    }
}

#[derive(Clone)]
struct FakeClock(Rc<Cell<u64>>);

impl Default for FakeClock {
    fn default() -> Self {
        // Far enough from zero that a stale lease can be expressed by
        // subtracting the TTL without underflowing.
        FakeClock(Rc::new(Cell::new(1_700_000_000_000)))
    }
}

impl FakeClock {
    fn advance(&self, ms: u64) {
        self.0.set(self.0.get() + ms);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }

    /// Never resolves: no protocol deadline should fire on a happy path, and
    /// one that did would make a test hang rather than fail
    /// (subduction_runtime/tests/common/mod.rs:36).
    fn sleep(&self, _ms: u64) -> LocalFuture<'_, ()> {
        Box::pin(futures::future::pending())
    }
}

#[derive(Default, Clone)]
struct FakeFetch {
    routes: Rc<RefCell<BTreeMap<String, Vec<u8>>>>,
    /// The store this world's requests reach, when it has one. Shared between
    /// worlds by cloning the `Rc`: that is what "the same Google account" is
    /// here.
    drive: Option<Rc<FakeDrive>>,
}

impl FakeFetch {
    fn route(self, url: &str, body: impl AsRef<[u8]>) -> Self {
        self.routes
            .borrow_mut()
            .insert(url.to_string(), body.as_ref().to_vec());
        self
    }

    fn with_drive(self, drive: Rc<FakeDrive>) -> Self {
        FakeFetch {
            drive: Some(drive),
            ..self
        }
    }
}

impl Fetch for FakeFetch {
    fn request(
        &self,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalFuture<'_, Result<HttpResponse, String>> {
        let answer = match &self.drive {
            Some(drive) if !url.starts_with(ORIGIN) => drive.answer(&method, &url, &headers, &body),
            _ => {
                let found = self.routes.borrow().get(&url).cloned();
                match found {
                    Some(body) => HttpResponse {
                        status: 200,
                        headers: Vec::new(),
                        body,
                    },
                    None => HttpResponse {
                        status: 404,
                        headers: Vec::new(),
                        body: Vec::new(),
                    },
                }
            }
        };
        Box::pin(async move { Ok(answer) })
    }
}

/// Randomness for keys and nonces. `scripted` hands out four-byte draws for
/// the tests that care what `reroll-word` sees; everything else runs on
/// xorshift64*, which is not cryptographic and does not need to be — the only
/// property the kernel depends on is that two draws differ.
#[derive(Clone)]
struct FakeRng {
    scripted: Rc<RefCell<VecDeque<u8>>>,
    state: Rc<Cell<u64>>,
}

impl Default for FakeRng {
    fn default() -> Self {
        FakeRng {
            scripted: Rc::new(RefCell::new(VecDeque::new())),
            state: Rc::new(Cell::new(0x9E37_79B9_7F4A_7C15)),
        }
    }
}

impl FakeRng {
    /// A generator that draws differently from [`FakeRng::default`] — what a
    /// second browser profile needs, so the two devices do not mint the same
    /// signing seed and therefore the same identity.
    fn seeded(state: u64) -> FakeRng {
        FakeRng {
            state: Rc::new(Cell::new(state)),
            ..FakeRng::default()
        }
    }

    /// Each value is one four-byte little-endian draw, handed out before the
    /// generator takes over.
    fn draws(values: &[u32]) -> FakeRng {
        let rng = FakeRng::default();
        *rng.scripted.borrow_mut() = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        rng
    }
}

impl Rng for FakeRng {
    fn fill(&self, dest: &mut [u8]) {
        for slot in dest.iter_mut() {
            if let Some(byte) = self.scripted.borrow_mut().pop_front() {
                *slot = byte;
                continue;
            }
            let mut x = self.state.get();
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.state.set(x);
            *slot = (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u8;
        }
    }
}

// -- the store fake ----------------------------------------------------------

/// Google Drive and its OAuth endpoints, in process.
///
/// It answers exactly the subset `polyvisor_kernel::drive`'s module docs
/// write down, and `e2e/fake-drive.ts` answers the same one over HTTP: two
/// fakes, one list, so a request that works here works there. Anything else
/// is a 400 naming the shape, which is how a kernel that grew a new request
/// finds out that both fakes have to follow.
///
/// EVERY TOKEN IT MINTS IS SYNTHETIC AND LABELLED AS SUCH: they are counters
/// with a prefix, never anything resembling a real credential.
#[derive(Default)]
struct FakeDrive {
    files: RefCell<BTreeMap<String, FakeFile>>,
    minted: Cell<u64>,
    /// Access tokens that still work. `revoke_access` empties it, which is
    /// how a test stands in for an expired token.
    access: RefCell<BTreeSet<String>>,
    /// Refresh tokens that still work.
    refresh: RefCell<BTreeSet<String>>,
    /// Every request, as `METHOD path`, so a test can count uploads.
    log: RefCell<Vec<String>>,
}

#[derive(Clone)]
struct FakeFile {
    name: String,
    parent: String,
    folder: bool,
    body: Vec<u8>,
}

const DRIVE_API: &str = "https://drive.example";
const DRIVE_OAUTH: &str = "https://oauth.example";
const PAGE_URL: &str = "https://home.example/";

impl FakeDrive {
    fn shared() -> Rc<FakeDrive> {
        Rc::default()
    }

    /// Every access token stops working — the state Google leaves a client in
    /// when its access token lapses. The refresh token is untouched, so the
    /// kernel's one refresh is what recovers.
    fn revoke_access(&self) {
        self.access.borrow_mut().clear();
    }

    /// The refresh tokens stop working too: a consent the user withdrew.
    fn revoke_refresh(&self) {
        self.refresh.borrow_mut().clear();
    }

    /// The names of every object in the one folder this group writes to.
    fn objects(&self) -> Vec<String> {
        self.files
            .borrow()
            .values()
            .filter(|file| !file.folder)
            .map(|file| file.name.clone())
            .collect()
    }

    fn folders(&self) -> Vec<String> {
        self.files
            .borrow()
            .values()
            .filter(|file| file.folder)
            .map(|file| file.name.clone())
            .collect()
    }

    /// Every request this fake has answered, for a test that cares whether a
    /// round trip happened at all.
    fn requests(&self) -> usize {
        self.log.borrow().len()
    }

    /// How many times one object's bytes were read.
    fn reads_of(&self, name: &str) -> usize {
        let id = self
            .files
            .borrow()
            .iter()
            .find(|(_, file)| file.name == name)
            .map(|(id, _)| id.clone())
            .expect("a planted object");
        self.log
            .borrow()
            .iter()
            .filter(|entry| entry == &&format!("GET /drive/v3/files/{id}"))
            .count()
    }

    /// Put a file in the group's folder that is not one of ours — the case
    /// the folder is the user's own Drive makes ordinary.
    fn plant(&self, name: &str, body: &[u8]) {
        let folder = self
            .files
            .borrow()
            .iter()
            .find(|(_, file)| file.folder)
            .map(|(id, _)| id.clone())
            .expect("the group's folder");
        let id = self.mint("id");
        self.files.borrow_mut().insert(
            id,
            FakeFile {
                name: name.to_string(),
                parent: folder,
                folder: false,
                body: body.to_vec(),
            },
        );
    }

    fn uploads(&self) -> usize {
        self.log
            .borrow()
            .iter()
            .filter(|entry| entry.starts_with("POST /upload/"))
            .count()
    }

    fn mint(&self, what: &str) -> String {
        self.minted.set(self.minted.get() + 1);
        format!("synthetic-{what}-{}", self.minted.get())
    }

    fn answer(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> HttpResponse {
        let (base, rest) = split_base(url);
        let (path, query) = match rest.split_once('?') {
            Some((path, query)) => (path, query),
            None => (rest, ""),
        };
        self.log.borrow_mut().push(format!("{method} {path}"));
        match (base.as_str(), method, path) {
            (DRIVE_OAUTH, "POST", "/token") => self.token(body),
            (DRIVE_API, _, _) => {
                if !self.authorized(headers) {
                    return json_response(401, r#"{"error":{"message":"invalid bearer"}}"#);
                }
                match (method, path) {
                    ("GET", "/drive/v3/files") => self.list(query),
                    ("POST", "/drive/v3/files") => self.create_folder(body),
                    ("POST", "/upload/drive/v3/files") => self.create_object(body),
                    ("GET", _) if path.starts_with("/drive/v3/files/") => {
                        self.read(&path["/drive/v3/files/".len()..], query)
                    }
                    _ => json_response(400, r#"{"error":{"message":"no such Drive request"}}"#),
                }
            }
            _ => json_response(400, r#"{"error":{"message":"no such endpoint"}}"#),
        }
    }

    fn authorized(&self, headers: &[(String, String)]) -> bool {
        headers.iter().any(|(name, value)| {
            name == "authorization"
                && value
                    .strip_prefix("Bearer ")
                    .is_some_and(|token| self.access.borrow().contains(token))
        })
    }

    /// Both grants. A code is accepted whatever it says: the popup is the
    /// page's business and the fake never rendered one, so there is nothing
    /// for the code to be wrong about — what the ceremony proves here is that
    /// the kernel sent a verifier and a redirect at all.
    fn token(&self, body: &[u8]) -> HttpResponse {
        let form: BTreeMap<String, String> = String::from_utf8_lossy(body)
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (percent_decode(k), percent_decode(v)))
            .collect();
        match form.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                for wanted in ["code", "code_verifier", "redirect_uri", "client_id"] {
                    if !form.contains_key(wanted) {
                        return json_response(400, r#"{"error":"invalid_request"}"#);
                    }
                }
                let access = self.mint("access");
                let refresh = self.mint("refresh");
                self.access.borrow_mut().insert(access.clone());
                self.refresh.borrow_mut().insert(refresh.clone());
                json_response(
                    200,
                    &format!(
                        r#"{{"access_token":"{access}","refresh_token":"{refresh}","expires_in":3600}}"#
                    ),
                )
            }
            Some("refresh_token") => {
                let held = form.get("refresh_token").cloned().unwrap_or_default();
                if !self.refresh.borrow().contains(&held) {
                    return json_response(400, r#"{"error":"invalid_grant"}"#);
                }
                let access = self.mint("access");
                self.access.borrow_mut().insert(access.clone());
                json_response(
                    200,
                    &format!(r#"{{"access_token":"{access}","expires_in":3600}}"#),
                )
            }
            _ => json_response(400, r#"{"error":"unsupported_grant_type"}"#),
        }
    }

    /// `files.list` over the two `q` shapes the kernel emits, and no others.
    fn list(&self, query: &str) -> HttpResponse {
        let params = params(query);
        if params.get("spaces").map(String::as_str) != Some("appDataFolder") {
            return json_response(
                400,
                r#"{"error":{"message":"the space is not appDataFolder"}}"#,
            );
        }
        let Some(q) = params.get("q") else {
            return json_response(400, r#"{"error":{"message":"no q"}}"#);
        };
        let Some((name, parent)) = parse_q(q) else {
            return json_response(400, r#"{"error":{"message":"unrecognised q"}}"#);
        };
        let files: Vec<String> = self
            .files
            .borrow()
            .iter()
            .filter(|(_, file)| file.parent == parent)
            .filter(|(_, file)| name.as_ref().is_none_or(|name| &file.name == name))
            .map(|(id, file)| format!(r#"{{"id":"{id}","name":"{}"}}"#, file.name))
            .collect();
        // One page: the kernel follows `nextPageToken` and this fake never
        // sets one, which is the shape the e2e fake matches. The paging loop
        // itself is exercised by neither — it is the archive's, verbatim.
        json_response(200, &format!(r#"{{"files":[{}]}}"#, files.join(",")))
    }

    fn create_folder(&self, body: &[u8]) -> HttpResponse {
        let Ok(meta) = serde_json::from_slice::<serde_json::Value>(body) else {
            return json_response(400, r#"{"error":{"message":"not JSON"}}"#);
        };
        let name = meta["name"].as_str().unwrap_or_default().to_string();
        let parent = meta["parents"][0].as_str().unwrap_or_default().to_string();
        if meta["mimeType"] != "application/vnd.google-apps.folder" {
            return json_response(400, r#"{"error":{"message":"not a folder"}}"#);
        }
        let id = self.mint("id");
        self.files.borrow_mut().insert(
            id.clone(),
            FakeFile {
                name,
                parent,
                folder: true,
                body: Vec::new(),
            },
        );
        json_response(200, &format!(r#"{{"id":"{id}"}}"#))
    }

    fn create_object(&self, body: &[u8]) -> HttpResponse {
        let Some((meta, content)) = multipart(body) else {
            return json_response(400, r#"{"error":{"message":"not multipart/related"}}"#);
        };
        let name = meta["name"].as_str().unwrap_or_default().to_string();
        let parent = meta["parents"][0].as_str().unwrap_or_default().to_string();
        let id = self.mint("id");
        self.files.borrow_mut().insert(
            id.clone(),
            FakeFile {
                name,
                parent,
                folder: false,
                body: content,
            },
        );
        json_response(200, &format!(r#"{{"id":"{id}"}}"#))
    }

    fn read(&self, id: &str, query: &str) -> HttpResponse {
        if params(query).get("alt").map(String::as_str) != Some("media") {
            return json_response(400, r#"{"error":{"message":"only alt=media"}}"#);
        }
        match self.files.borrow().get(id) {
            Some(file) => HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: file.body.clone(),
            },
            None => json_response(404, r#"{"error":{"message":"no such file"}}"#),
        }
    }
}

fn json_response(status: u16, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: body.as_bytes().to_vec(),
    }
}

/// `https://host` and the rest of the URL.
fn split_base(url: &str) -> (String, &str) {
    let (scheme, rest) = url.split_once("://").expect("an absolute URL");
    match rest.find('/') {
        Some(cut) => (format!("{scheme}://{}", &rest[..cut]), &rest[cut..]),
        None => (format!("{scheme}://{rest}"), "/"),
    }
}

fn params(query: &str) -> BTreeMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (percent_decode(k), percent_decode(v)))
        .collect()
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&raw[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The two `q` shapes: `(name, parent)` for a resolve, `(None, parent)` for a
/// folder listing. Anything else is `None` and answers 400 — the point of the
/// fake is that it refuses a query the kernel is not documented to send.
fn parse_q(q: &str) -> Option<(Option<String>, String)> {
    let q = q.strip_suffix(" and trashed = false")?;
    if let Some(rest) = q.strip_prefix("name = '") {
        let (name, rest) = rest.split_once("' and '")?;
        let parent = rest.strip_suffix("' in parents")?;
        return Some((Some(name.to_string()), parent.to_string()));
    }
    let parent = q.strip_prefix('\'')?.strip_suffix("' in parents")?;
    Some((None, parent.to_string()))
}

/// The metadata part and the media part of a `multipart/related` body.
fn multipart(body: &[u8]) -> Option<(serde_json::Value, Vec<u8>)> {
    let text = String::from_utf8_lossy(body).to_string();
    let boundary = format!("--{}", text.lines().next()?.trim_start_matches("--").trim());
    let separator = format!("\r\n{boundary}");
    let head = find(body, b"\r\n\r\n")? + 4;
    let meta_end = find(&body[head..], separator.as_bytes())? + head;
    let meta: serde_json::Value = serde_json::from_slice(&body[head..meta_end]).ok()?;
    let media_head = find(&body[meta_end..], b"\r\n\r\n")? + meta_end + 4;
    let media_end = find(&body[media_head..], separator.as_bytes())? + media_head;
    Some((meta, body[media_head..media_end].to_vec()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

const ORIGIN: &str = "https://home.example";
const ID: &str = "0123456789abcdef0123456789abcdef";
const CSS: &[u8] = b"body{}";
/// sha256 of `CSS` in hex, as `web/build.ts` writes it into the manifest.
/// The handle on the wire is the raw digest these 64 characters spell.
const CSS_HANDLE_HEX: &str = "7c98040a541657584690ae2a1cc3b42a8b53b159cc60c5d3abbfecbaeac6c94a";

fn css_handle() -> Vec<u8> {
    (0..32)
        .map(|i| u8::from_str_radix(&CSS_HANDLE_HEX[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn manifest_json(asset_handle: &str) -> String {
    format!(
        r#"{{"id":"todomvc","title":"TodoMVC","component":"app.component.wasm",
             "plan":"app.component.plan.json",
             "assets":[{{"handle":"{asset_handle}","path":"todomvc-app.css",
                         "media_type":"text/css"}}]}}"#
    )
}

fn fetch_with(asset_handle: &str) -> FakeFetch {
    FakeFetch::default()
        .route(&format!("{ORIGIN}/apps/index.json"), r#"["todomvc"]"#)
        .route(
            &format!("{ORIGIN}/apps/todomvc/manifest.json"),
            manifest_json(asset_handle),
        )
        .route(
            &format!("{ORIGIN}/apps/todomvc/app.component.wasm"),
            b"\0asm",
        )
        .route(
            &format!("{ORIGIN}/apps/todomvc/app.component.plan.json"),
            r#"{"plan":true}"#,
        )
        .route(&format!("{ORIGIN}/apps/todomvc/todomvc-app.css"), CSS)
}

/// One browser profile. The seams outlive any one `Kernel`, so a second
/// `boot` against the same `World` is a page reload with a fresh worker —
/// the normal case, not the exception (docs/design.md "Devices").
#[derive(Clone)]
struct World {
    kv: FakeKv,
    files: FakeFiles,
    locks: FakeLocks,
    clock: FakeClock,
    rng: FakeRng,
    fetch: FakeFetch,
    net: FakeNet,
}

impl Default for World {
    fn default() -> Self {
        World {
            kv: FakeKv::default(),
            files: FakeFiles::default(),
            locks: FakeLocks::default(),
            clock: FakeClock::default(),
            rng: FakeRng::default(),
            fetch: fetch_with(CSS_HANDLE_HEX),
            net: FakeNet::default(),
        }
    }
}

impl World {
    fn with_rng(rng: FakeRng) -> World {
        World {
            rng,
            ..World::default()
        }
    }

    fn with_net(net: FakeNet) -> World {
        World {
            net,
            ..World::default()
        }
    }

    fn with_fetch(fetch: FakeFetch) -> World {
        World {
            fetch,
            ..World::default()
        }
    }

    /// This browser profile, talking to `drive` as the user's own account.
    fn with_drive(&self, drive: &Rc<FakeDrive>) -> World {
        World {
            fetch: self.fetch.clone().with_drive(Rc::clone(drive)),
            ..self.clone()
        }
    }

    /// A second browser profile on the same fake network: separate storage,
    /// shared switchboard, so the two devices can dial each other.
    fn peer(&self) -> World {
        self.peer_seeded(0x1234_5678_9abc_def0)
    }

    fn peer_seeded(&self, seed: u64) -> World {
        World {
            net: self.net.clone(),
            rng: FakeRng::seeded(seed),
            ..World::default()
        }
    }

    fn try_boot_as(&self, id: &str) -> Result<Rc<Kernel>, Error> {
        block_on(Kernel::boot(
            BootConfig {
                home_origin: ORIGIN.to_string(),
                device: id.to_string(),
                page_url: PAGE_URL.to_string(),
                drive_api: Some(DRIVE_API.to_string()),
                drive_oauth: Some(DRIVE_OAUTH.to_string()),
            },
            Seams {
                platform: Box::new(self.kv.clone()),
                files: Box::new(self.files.clone()),
                locks: Box::new(self.locks.clone()),
                clock: Rc::new(self.clock.clone()),
                fetch: Box::new(self.fetch.clone()),
                rng: Box::new(self.rng.clone()),
                spawn: Rc::new(PoolSpawn),
                net: Box::new(self.net.clone()),
            },
        ))
    }

    fn try_boot(&self) -> Result<Rc<Kernel>, Error> {
        self.try_boot_as(ID)
    }

    fn boot(&self) -> Rc<Kernel> {
        self.try_boot().unwrap()
    }

    fn kv_has(&self, key: &str) -> bool {
        self.kv.store.borrow().contains_key(key)
    }

    fn kv_put(&self, key: &str, value: Vec<u8>) {
        self.kv.store.borrow_mut().insert(key.to_string(), value);
    }

    fn row(&self, id: &str) -> Option<IndexRow> {
        self.kv
            .store
            .borrow()
            .get(&format!("index/{id}"))
            .map(|bytes| IndexRow::decode(bytes).unwrap())
    }

    fn put_row(&self, row: &IndexRow) {
        self.kv_put(&format!("index/{}", row.id), row.encode().unwrap());
    }

    /// The committed generation, as the kv pointer records it. 0 before the
    /// first checkpoint.
    fn pointer(&self, id: &str) -> u64 {
        self.kv
            .store
            .borrow()
            .get(&format!("dev/{id}/gen"))
            .map(|bytes| String::from_utf8(bytes.clone()).unwrap().parse().unwrap())
            .unwrap_or(0)
    }

    /// Which generation directories still have files in them, ascending.
    fn generations(&self, id: &str) -> Vec<u64> {
        let mut found: Vec<u64> = self
            .files
            .paths()
            .iter()
            .filter_map(|p| {
                p.strip_prefix(&format!("/{id}/gen-"))?
                    .split('/')
                    .next()?
                    .parse()
                    .ok()
            })
            .collect();
        found.sort_unstable();
        found.dedup();
        found
    }
}

/// The default world booted once: the shape most app/session tests want.
fn boot() -> Rc<Kernel> {
    World::default().boot()
}

fn session(kernel: &Kernel) -> u32 {
    kernel.launch("todomvc").unwrap()
}

// -- boot, identity, checkpoint ----------------------------------------------

#[test]
fn a_fresh_boot_writes_a_row_a_key_and_its_anchor() {
    let world = World::default();
    let kernel = world.boot();

    let status = kernel.device_status().unwrap();
    assert_eq!(status.id, ID, "the glue owns the id; the kernel takes it");
    assert_eq!(status.state, State::Fresh);
    assert_eq!(status.tier, Tier::Ephemeral);
    assert_eq!(status.rest, Rest::RestsOpen);
    assert_eq!(status.petname, "");
    assert_eq!(status.name, "");
    assert!(!status.word.is_empty());

    assert!(world.kv_has(&format!("index/{ID}")));
    assert!(
        world.kv_has(&format!("dev/{ID}/dek")),
        "rests-open is the ephemeral default: the key sits unwrapped"
    );
    // Generation 1 is written by `boot`, not deferred to the first mutation:
    // the anchor is drawn, so it has to be durable before anyone sees it.
    assert_eq!(world.generations(ID), [1]);
    assert_eq!(world.pointer(ID), 1);

    block_on(kernel.set_name("study".into())).unwrap();
    assert_eq!(world.generations(ID), [2]);
    assert_eq!(world.pointer(ID), 2);
}

#[test]
fn the_anchor_is_drawn_once_and_survives_an_untouched_reload() {
    // The anchor is drawn from the RNG, never derived from the id: the id is
    // public, and a hue and word anyone could compute from it would be the
    // visor's anti-impostor signal given away. Drawn means it must be
    // checkpointed at mint, or a reload would repaint the device.
    let world = World::default();
    let minted = world.boot().device_status().unwrap();
    assert_eq!(
        world.boot().device_status().unwrap(),
        minted,
        "a reload with no mutation in between restores the same anchor"
    );

    // A second device draws its own, from the same generator.
    let other = world.try_boot_as("beef").unwrap().device_status().unwrap();
    assert_ne!(other.word, minted.word);
    assert_ne!(other.hue, minted.hue);
}

#[test]
fn an_anchor_whose_first_checkpoint_failed_is_re_minted() {
    // The one case in which a missing state is legal: an ephemeral device
    // whose mint never committed (pointer 0). There is nothing to lose, so
    // the next boot draws again rather than refusing.
    let world = World::default();
    // One failure is enough: `checkpoint::write` stops at the first, so the
    // MANIFEST is never attempted.
    world.files.fail_next_writes(1);
    let first = world.boot().device_status().unwrap();
    assert_eq!(world.pointer(ID), 0, "the pointer never advanced");
    assert!(world.files.paths().is_empty());

    let second = world.boot().device_status().unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(world.pointer(ID), 1, "this boot's mint did commit");
    assert_eq!(world.boot().device_status().unwrap(), second);
}

#[test]
fn a_durable_device_whose_state_does_not_open_refuses_to_boot() {
    // The opposite case: a kept device has been checkpointed, so a state that
    // will not open is storage loss. Handing back a blank device with a new
    // colour would be indistinguishable from the one the user kept.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.keep("desk".into(), None)).unwrap();
    }
    for path in world.files.paths() {
        block_on(world.files.remove_file(path));
    }
    let Err(err) = world.try_boot() else {
        panic!("a durable device with no readable state must not boot");
    };
    assert_eq!(err.code, ErrorCode::Failed);
    assert_eq!(err.message, "this device's state did not open");
}

#[test]
fn name_and_hue_persist_across_a_reload_and_an_out_of_range_hue_is_refused() {
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.set_name("kitchen".into())).unwrap();
    block_on(kernel.set_hue(200)).unwrap();

    let refused = block_on(kernel.set_hue(360)).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Refused);
    assert_eq!(
        kernel.device_status().unwrap().hue,
        200,
        "the refusal changed nothing"
    );

    let reread = world.boot().device_status().unwrap();
    assert_eq!(reread.name, "kitchen");
    assert_eq!(reread.hue, 200);
}

#[test]
fn tasks_survive_a_reload_but_sessions_do_not() {
    let world = World::default();
    {
        let kernel = world.boot();
        let s = session(&kernel);
        block_on(kernel.tasks_add(s, "water the plants".into())).unwrap();
        assert_eq!(s, 1);
    }

    let kernel = world.boot();
    // The old session id is gone with the worker that minted it.
    assert_eq!(
        block_on(kernel.tasks_revision(1)),
        Err("unknown session".into()),
        "sessions are not persisted: a reload ends them"
    );
    let s = session(&kernel);
    let items = block_on(kernel.tasks_items(s)).unwrap();
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].title, "water the plants");
}

#[test]
fn reroll_never_repeats_the_current_word_and_survives_a_reload() {
    // Draw 5, then 5 again, then 6: the repeat must be rejected and redrawn.
    let world = World::with_rng(FakeRng::draws(&[5, 5, 6]));
    let kernel = world.boot();
    let minted = kernel.device_status().unwrap().word;

    let first = block_on(kernel.reroll_word()).unwrap();
    assert_ne!(first, minted);
    let second = block_on(kernel.reroll_word()).unwrap();
    assert_ne!(second, first, "the redraw skipped the repeated word");

    assert_eq!(world.boot().device_status().unwrap().word, second);
}

#[test]
fn every_mutation_refreshes_the_lease() {
    let world = World::default();
    let kernel = world.boot();
    let booted = world.row(ID).unwrap().last_used;
    world.clock.0.set(booted + 5_000);
    block_on(kernel.set_name("study".into())).unwrap();
    assert_eq!(world.row(ID).unwrap().last_used, booted + 5_000);
}

// -- keeping and unsealing ---------------------------------------------------

#[test]
fn keeping_under_a_passphrase_wraps_the_key_and_the_next_boot_is_sealed() {
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("study".into())).unwrap();
        block_on(kernel.keep("desk".into(), Some("open sesame".into()))).unwrap();
        assert!(!world.kv_has(&format!("dev/{ID}/dek")));
        assert!(world.kv_has(&format!("dev/{ID}/dek-wrapped")));
        assert_eq!(
            kernel.device_status().unwrap().state,
            State::Open,
            "the key is still in worker memory: keeping is not sealing"
        );
    }

    let kernel = world.boot();
    let status = kernel.device_status().unwrap();
    assert_eq!(status.state, State::Sealed);
    assert_eq!(status.tier, Tier::Durable);
    assert_eq!(status.rest, Rest::Passphrase);
    // The petname is readable in the clear; nothing else personal is.
    assert_eq!(status.petname, "desk");
    assert_eq!(status.name, "");
    assert_eq!(status.hue, 0);
    assert_eq!(status.word, "");

    // Every other export is unavailable until the seal opens...
    assert_eq!(
        block_on(kernel.set_name("den".into())).unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(kernel.installed().unwrap_err().code, ErrorCode::Unavailable);
    // ...but the index is not: it is what the entry picker shows.
    assert_eq!(block_on(kernel.devices()).unwrap().len(), 1);

    let refused = block_on(kernel.unseal("not it".into())).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Refused);
    assert_eq!(refused.message, "the passphrase did not open this device");
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);

    block_on(kernel.unseal("open sesame".into())).unwrap();
    let status = kernel.device_status().unwrap();
    assert_eq!(status.state, State::Open);
    assert_eq!(status.name, "study");
}

#[test]
fn keeping_open_leaves_the_key_in_place_and_the_next_boot_opens() {
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.keep("desk".into(), None)).unwrap();
    }
    assert!(world.kv_has(&format!("dev/{ID}/dek")));
    assert!(!world.kv_has(&format!("dev/{ID}/dek-wrapped")));

    let status = world.boot().device_status().unwrap();
    assert_eq!(status.state, State::Open);
    assert_eq!(status.tier, Tier::Durable);
    assert_eq!(status.rest, Rest::RestsOpen);
    assert_eq!(status.petname, "desk");
}

#[test]
fn a_kept_device_may_be_renamed_but_not_resealed() {
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.keep("desk".into(), None)).unwrap();
    block_on(kernel.keep("study desk".into(), None)).unwrap();
    assert_eq!(kernel.device_status().unwrap().petname, "study desk");
    assert_eq!(
        block_on(kernel.keep("desk".into(), Some("late".into())))
            .unwrap_err()
            .code,
        ErrorCode::Refused,
        "reseal is a later milestone"
    );
}

#[test]
fn a_device_that_is_already_open_cannot_be_unsealed() {
    let kernel = boot();
    assert_eq!(
        block_on(kernel.unseal("anything".into())).unwrap_err().code,
        ErrorCode::Refused
    );
}

// -- erase -------------------------------------------------------------------

#[test]
fn a_sealed_device_can_still_be_erased() {
    // internal.wit `device`: erase "needs no key (a forgotten passphrase must
    // not make a device un-erasable)".
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("study".into())).unwrap();
        block_on(kernel.keep("desk".into(), Some("open sesame".into()))).unwrap();
    }
    let kernel = world.boot();
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);

    block_on(kernel.erase()).unwrap();
    assert!(!world.files.under(&format!("/{ID}/")));
    assert!(!world.kv_has(&format!("index/{ID}")));
    assert!(!world.kv_has(&format!("dev/{ID}/dek-wrapped")));
    assert!(!world.kv_has(&format!("dev/{ID}/gen")));
}

#[test]
fn every_export_works_on_a_fresh_device() {
    // internal.wit `device`: "`fresh` is not a gate: an ephemeral device is
    // fully usable". The M1 e2e run never keeps a device, so this is the
    // whole of it working.
    let world = World::default();
    let kernel = world.boot();
    assert_eq!(kernel.device_status().unwrap().state, State::Fresh);
    block_on(kernel.set_name("study".into())).unwrap();
    block_on(kernel.set_hue(120)).unwrap();
    block_on(kernel.reroll_word()).unwrap();
    assert_eq!(block_on(kernel.devices()).unwrap().len(), 1);
    assert_eq!(kernel.installed().unwrap().len(), 1);
    let s = session(&kernel);
    block_on(kernel.component(s)).unwrap();
    kernel.assets(s).unwrap();
    block_on(kernel.tasks_add(s, "milk".into())).unwrap();
}

#[test]
fn erase_destroys_the_namespace_and_the_row_and_is_terminal() {
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.set_name("study".into())).unwrap();
    assert!(!world.files.paths().is_empty());

    block_on(kernel.erase()).unwrap();
    assert!(
        world.files.paths().is_empty(),
        "every named path was removed"
    );
    assert!(!world.kv_has(&format!("index/{ID}")));
    assert!(!world.kv_has(&format!("dev/{ID}/dek")));
    assert!(!world.kv_has(&format!("dev/{ID}/gen")));

    for code in [
        kernel.device_status().unwrap_err().code,
        block_on(kernel.set_name("den".into())).unwrap_err().code,
        block_on(kernel.devices()).unwrap_err().code,
        kernel.installed().unwrap_err().code,
    ] {
        assert_eq!(code, ErrorCode::Unavailable);
    }
}

// -- the sweep ---------------------------------------------------------------

/// Plant a neighbouring device with a namespace, a key and a row.
fn plant(world: &World, id: &str, tier: Tier, last_used: u64) {
    let mut row = IndexRow::fresh(id, last_used);
    row.tier = tier;
    world.put_row(&row);
    block_on(
        world
            .files
            .write(format!("/{id}/gen-1/state"), b"whatever".to_vec()),
    )
    .unwrap();
    world.kv_put(&format!("dev/{id}/gen"), b"1".to_vec());
    world.kv_put(&format!("dev/{id}/dek"), vec![0; 32]);
}

#[test]
fn the_sweep_takes_only_stale_unlocked_ephemeral_devices() {
    let world = World::default();
    let now = world.clock.0.get();
    let stale = now - LEASE_TTL_MS - 1;

    plant(&world, "abandoned", Tier::Ephemeral, stale);
    plant(&world, "alive", Tier::Ephemeral, stale);
    plant(&world, "kept", Tier::Durable, stale);
    plant(&world, "recent", Tier::Ephemeral, now - LEASE_TTL_MS + 1);
    // Only `alive` still has a worker: a lock releases when its holder dies.
    world.locks.0.borrow_mut().insert("pm-device-alive".into());

    world.boot();

    assert!(world.row("abandoned").is_none(), "swept");
    assert!(!world.kv_has("dev/abandoned/dek"));
    assert!(!world.files.under("/abandoned/"));

    for spared in ["alive", "kept", "recent"] {
        assert!(world.row(spared).is_some(), "{spared} was swept");
        assert!(world.files.under(&format!("/{spared}/")));
    }
}

#[test]
fn the_sweep_never_takes_the_device_it_is_booting() {
    let world = World::default();
    let stale = world.clock.0.get() - LEASE_TTL_MS - 1;
    let mut row = IndexRow::fresh(ID, stale);
    row.petname = "mine".into();
    world.put_row(&row);
    world.kv_put(&format!("dev/{ID}/dek"), vec![7; 32]);

    let kernel = world.boot();
    assert_eq!(kernel.device_status().unwrap().petname, "mine");
    assert!(world.row(ID).is_some());
}

// -- generations -------------------------------------------------------------

#[test]
fn a_committed_generation_replaces_the_one_before_it() {
    let world = World::default();
    let kernel = world.boot();
    // Generation 1 is the mint, so the first mutation is 2.
    for (n, name) in [(2, "one"), (3, "two"), (4, "three")] {
        block_on(kernel.set_name(name.into())).unwrap();
        assert_eq!(world.generations(ID), [n], "only the newest is kept");
        assert_eq!(world.pointer(ID), n);
    }
    assert_eq!(world.boot().device_status().unwrap().name, "three");
}

/// The two files of a generation, so a test can put back what the kernel's
/// cleanup removed and reconstruct a crash state exactly.
fn snapshot_generation(world: &World, id: &str, n: u64) -> (Vec<u8>, Vec<u8>) {
    let files = world.files.store.borrow();
    (
        files[&format!("/{id}/gen-{n}/state")].clone(),
        files[&format!("/{id}/gen-{n}/MANIFEST")].clone(),
    )
}

fn restore_generation(world: &World, id: &str, n: u64, bytes: (Vec<u8>, Vec<u8>)) {
    block_on(world.files.write(format!("/{id}/gen-{n}/state"), bytes.0)).unwrap();
    block_on(
        world
            .files
            .write(format!("/{id}/gen-{n}/MANIFEST"), bytes.1),
    )
    .unwrap();
}

#[test]
fn a_generation_the_pointer_never_reached_falls_back_to_the_committed_one() {
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("one".into())).unwrap();
        block_on(kernel.set_name("committed".into())).unwrap();
    }
    assert_eq!(world.pointer(ID), 3);
    let committed = snapshot_generation(&world, ID, 3);

    // The crash the pointer-last rule exists for: `gen-4` landed whole, the
    // pointer never advanced to it, and the cleanup that would have removed
    // `gen-3` never ran either.
    {
        let kernel = world.boot();
        block_on(kernel.set_name("uncommitted".into())).unwrap();
    }
    restore_generation(&world, ID, 3, committed);
    world.kv_put(&format!("dev/{ID}/gen"), b"3".to_vec());
    assert!(world.files.has(&format!("/{ID}/gen-4/MANIFEST")));

    // The pointer is the commit point, so the whole `gen-4` is invisible.
    assert_eq!(world.boot().device_status().unwrap().name, "committed");

    // And the next write reuses generation 4, overwriting what was there.
    let kernel = world.boot();
    block_on(kernel.set_name("after".into())).unwrap();
    assert_eq!(world.pointer(ID), 4);
    assert_eq!(world.generations(ID), [4]);
    assert_eq!(world.boot().device_status().unwrap().name, "after");
}

#[test]
fn a_torn_pointed_generation_falls_back_to_its_predecessor() {
    // A crash *during* `gen-3/state` leaves the pointer at 3 only if the
    // pointer write also happened — it cannot here, but a half-written file
    // under a pointer that did advance is the shape the fallback exists for,
    // and `gen-2` is guaranteed intact because the pointer only left it once
    // `gen-3` was whole.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("one".into())).unwrap();
        block_on(kernel.set_name("two".into())).unwrap();
    }
    // Keep gen-2 alive past the cleanup by re-planting it, then corrupt the
    // generation the pointer names.
    let previous = snapshot_generation(&world, ID, 3);
    {
        let kernel = world.boot();
        block_on(kernel.set_name("three".into())).unwrap();
    }
    restore_generation(&world, ID, 3, previous);
    block_on(
        world
            .files
            .write(format!("/{ID}/gen-4/state"), b"half a write".to_vec()),
    )
    .unwrap();
    assert_eq!(world.pointer(ID), 4);

    assert_eq!(world.boot().device_status().unwrap().name, "two");
}

#[test]
fn a_write_that_fails_does_not_advance_the_pointer() {
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.set_name("committed".into())).unwrap();
    assert_eq!(world.pointer(ID), 2);
    let intact = snapshot_generation(&world, ID, 2);

    world.files.fail_next_writes(1);
    let err = block_on(kernel.set_name("lost".into())).unwrap_err();
    assert_eq!(err.code, ErrorCode::Failed);
    assert_eq!(err.message, "this device's state could not be written");

    // The pointer did not move, the generation it names is untouched, and no
    // cleanup ran: the previous checkpoint is still exactly what a boot gets.
    assert_eq!(world.pointer(ID), 2);
    assert_eq!(snapshot_generation(&world, ID, 2), intact);
    assert_eq!(world.boot().device_status().unwrap().name, "committed");

    // The next write takes the same generation number and succeeds.
    block_on(kernel.set_name("after".into())).unwrap();
    assert_eq!(world.pointer(ID), 3);
    assert_eq!(world.generations(ID), [3]);
    assert_eq!(world.boot().device_status().unwrap().name, "after");
}

#[test]
fn a_crash_between_wrapping_the_key_and_deleting_it_still_seals() {
    // `keep` writes the wrapped key, then the row, then deletes the
    // unwrapped one. Die on the row write: the wrapped key is durable and
    // the plaintext one is still sitting in `kv`.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("study".into())).unwrap();
        world.kv.abort_on(&format!("index/{ID}"));
        let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            block_on(kernel.keep("desk".into(), Some("open sesame".into())))
        }));
        assert!(died.is_err(), "the fake was supposed to abort the worker");
    }
    assert!(world.kv_has(&format!("dev/{ID}/dek-wrapped")));
    assert!(
        world.kv_has(&format!("dev/{ID}/dek")),
        "the delete never ran"
    );

    // The row still says rests-open, so this boot opens on the plaintext key
    // — which is the honest state: the promotion never committed.
    let kernel = world.boot();
    assert_eq!(kernel.device_status().unwrap().rest, Rest::RestsOpen);

    // Retrying the keep is the recovery, and it commits this time.
    block_on(kernel.keep("desk".into(), Some("open sesame".into()))).unwrap();
    assert!(!world.kv_has(&format!("dev/{ID}/dek")));

    let kernel = world.boot();
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);
    block_on(kernel.unseal("open sesame".into())).unwrap();
    assert_eq!(kernel.device_status().unwrap().name, "study");
}

#[test]
fn a_row_that_says_passphrase_loses_any_lingering_plaintext_key() {
    // The other side of the same window: the row landed and the delete did
    // not. A plaintext key beside a `passphrase` row opens the device without
    // the passphrase, so `resume` finishes the job before anything reads it.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("study".into())).unwrap();
        let dek = world.kv.store.borrow()[&format!("dev/{ID}/dek")].clone();
        block_on(kernel.keep("desk".into(), Some("open sesame".into()))).unwrap();
        // Put it back, as a crash before the delete would have left it.
        world.kv_put(&format!("dev/{ID}/dek"), dek);
    }

    let kernel = world.boot();
    assert!(
        !world.kv_has(&format!("dev/{ID}/dek")),
        "resume deleted the stale plaintext key"
    );
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);
    block_on(kernel.unseal("open sesame".into())).unwrap();
    assert_eq!(kernel.device_status().unwrap().name, "study");
}

#[test]
fn two_checkpoints_of_the_same_state_are_different_bytes() {
    // Every seal draws a fresh nonce. Identical plaintext producing identical
    // ciphertext would leak "nothing changed" to anyone who can see the
    // state root, and reusing a nonce under one key is worse than that.
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.set_name("study".into())).unwrap();
    let first = world.files.get(&format!("/{ID}/gen-2/state")).unwrap();
    block_on(kernel.set_name("study".into())).unwrap();
    let second = world.files.get(&format!("/{ID}/gen-3/state")).unwrap();

    assert_eq!(
        world.boot().device_status().unwrap().name,
        "study",
        "the same state, written twice"
    );
    assert_ne!(first, second, "same plaintext, different ciphertext");
    assert_ne!(first[..12], second[..12], "the nonce prefix is fresh");
}

#[test]
fn a_wrapped_key_copied_under_another_id_does_not_unwrap() {
    // The wrap's associated data is the device id, so moving the record into
    // another device's namespace does not let that device's passphrase
    // prompt open it — the same binding the checkpoint has.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.keep("desk".into(), Some("open sesame".into()))).unwrap();
    }
    let wrapped = world.kv.store.borrow()[&format!("dev/{ID}/dek-wrapped")].clone();

    let mut row = IndexRow::fresh("other", world.clock.0.get());
    row.tier = Tier::Durable;
    row.rest = Rest::Passphrase;
    world.put_row(&row);
    world.kv_put("dev/other/dek-wrapped", wrapped);

    let kernel = world.try_boot_as("other").unwrap();
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);
    let refused = block_on(kernel.unseal("open sesame".into())).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Refused);
    assert_eq!(refused.message, "the passphrase did not open this device");
}

#[test]
fn a_checkpoint_moved_into_another_namespace_does_not_open() {
    // The checkpoint's associated data is the device id, so the same bytes
    // under another id do not authenticate — even with the same key.
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("study".into())).unwrap();
    }
    let moved: Vec<(String, Vec<u8>)> = world
        .files
        .store
        .borrow()
        .iter()
        .map(|(k, v)| (k.replace(&format!("/{ID}/"), "/other/"), v.clone()))
        .collect();
    for (path, bytes) in moved {
        block_on(world.files.write(path, bytes)).unwrap();
    }
    let dek = world.kv.store.borrow()[&format!("dev/{ID}/dek")].clone();
    world.kv_put("dev/other/dek", dek);
    world.kv_put("dev/other/gen", world.pointer(ID).to_string().into_bytes());
    world.put_row(&IndexRow::fresh("other", world.clock.0.get()));

    // It does not boot: the pointer names a generation, so an unreadable one
    // is loss, not absence. Silently blanking it is what rule 5 forbids.
    let Err(err) = world.try_boot_as("other") else {
        panic!("a checkpoint that does not authenticate must not be ignored");
    };
    assert_eq!(err.message, "this device's state did not open");
}

#[test]
fn a_rests_open_device_whose_key_is_gone_does_not_boot() {
    let world = World::default();
    world.put_row(&IndexRow::fresh(ID, world.clock.0.get()));
    let Err(err) = world.try_boot() else {
        panic!("a device whose data key is missing must not boot");
    };
    assert_eq!(err.code, ErrorCode::Failed);
}

// -- the index ---------------------------------------------------------------

#[test]
fn devices_lists_every_row_on_the_origin() {
    let world = World::default();
    plant(&world, "aaa", Tier::Durable, world.clock.0.get());
    let kernel = world.boot();
    let ids: Vec<String> = block_on(kernel.devices())
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, [ID, "aaa"], "sorted by id");
}

// -- apps --------------------------------------------------------------------

#[test]
fn registry_lists_what_the_home_origin_serves() {
    let kernel = boot();
    let installed = kernel.installed().unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(installed[0].id, "todomvc");
    assert_eq!(installed[0].title, "TodoMVC");
}

#[test]
fn sessions_are_monotonic_and_close_is_idempotent() {
    let kernel = boot();
    let a = session(&kernel);
    let b = session(&kernel);
    assert_eq!((a, b), (1, 2));
    assert_eq!(kernel.session_app(a).unwrap().id, "todomvc");

    kernel.close(a);
    assert_eq!(
        kernel.session_app(a).unwrap_err().code,
        ErrorCode::UnknownSession
    );
    kernel.close(a); // idempotent per internal.wit

    // Ids are never reused: the next launch is 3, not the freed 1.
    assert_eq!(session(&kernel), 3);
    // And closing emits nothing — it is the visor's own act.
    assert!(quiet(&kernel));
}

#[test]
fn launching_an_unknown_app_is_refused() {
    let kernel = boot();
    assert_eq!(
        kernel.launch("nope").unwrap_err().code,
        ErrorCode::UnknownApp
    );
}

#[test]
fn component_and_assets_come_from_the_bundle() {
    let kernel = boot();
    let s = session(&kernel);
    let artifacts = block_on(kernel.component(s)).unwrap();
    assert_eq!(artifacts.wasm, b"\0asm");
    assert_eq!(artifacts.plan, r#"{"plan":true}"#);

    let assets = kernel.assets(s).unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].media_type, "text/css");
    assert_eq!(
        assets[0].handle,
        css_handle(),
        "the raw digest, not its hex"
    );

    let bytes = block_on(kernel.asset(s, &assets[0].handle)).unwrap();
    assert_eq!(bytes, CSS);
}

#[test]
fn an_asset_that_does_not_hash_to_its_handle_is_rejected() {
    let kernel = World::with_fetch(fetch_with(&"0".repeat(64))).boot();
    let s = session(&kernel);
    let err = block_on(kernel.asset(s, &[0u8; 32])).unwrap_err();
    assert_eq!(err.code, ErrorCode::Failed);
    assert!(
        err.message.contains("todomvc-app.css"),
        "the message names the file: {}",
        err.message
    );
}

#[test]
fn unknown_sessions_are_rejected_everywhere() {
    let kernel = boot();
    assert_eq!(
        kernel.session_app(99).unwrap_err().code,
        ErrorCode::UnknownSession
    );
    assert_eq!(
        block_on(kernel.component(99)).unwrap_err().code,
        ErrorCode::UnknownSession
    );
    assert_eq!(
        kernel.assets(99).unwrap_err().code,
        ErrorCode::UnknownSession
    );
    assert_eq!(
        block_on(kernel.asset(99, b"x")).unwrap_err().code,
        ErrorCode::UnknownSession
    );
    assert_eq!(
        block_on(kernel.tasks_revision(99)),
        Err("unknown session".into())
    );
}

#[test]
fn a_manifest_handle_that_is_not_hex_is_a_boot_failure() {
    let Err(err) = World::with_fetch(fetch_with("not hex")).try_boot() else {
        panic!("a manifest with an unreadable handle must not boot");
    };
    assert_eq!(err.code, ErrorCode::Failed);
    assert!(
        err.message.contains("todomvc-app.css"),
        "the message names the file: {}",
        err.message
    );
}

// -- tasks -------------------------------------------------------------------

#[test]
fn tasks_are_shared_by_every_session_of_one_app() {
    let kernel = boot();
    let a = session(&kernel);
    let b = session(&kernel);
    let id = block_on(kernel.tasks_add(a, "milk".into())).unwrap();
    assert_eq!(block_on(kernel.tasks_items(b)).unwrap().items[0].id, id);
}

#[test]
fn every_mutation_advances_the_revision_and_ids_order_the_items() {
    let kernel = boot();
    let s = session(&kernel);
    assert_eq!(block_on(kernel.tasks_revision(s)).unwrap(), 0);

    let first = block_on(kernel.tasks_add(s, "milk".into())).unwrap();
    let second = block_on(kernel.tasks_add(s, "bread".into())).unwrap();
    // Ids no longer carry order: they are per-device and opaque, because a
    // shared counter is not safe across two authors. The document records
    // each item's place instead, and `items` comes back in that order.
    assert_ne!(first, second);
    assert_eq!(block_on(kernel.tasks_revision(s)).unwrap(), 2);

    block_on(kernel.tasks_set_completed(s, &first, true)).unwrap();
    block_on(kernel.tasks_set_title(s, &second, "rye".into())).unwrap();
    let snapshot = block_on(kernel.tasks_items(s)).unwrap();
    assert_eq!(snapshot.revision, 4);
    assert_eq!(
        snapshot
            .items
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.as_str(), second.as_str()]
    );
    assert!(snapshot.items[0].completed);
    assert_eq!(snapshot.items[1].title, "rye");

    block_on(kernel.tasks_remove(s, &first)).unwrap();
    assert_eq!(block_on(kernel.tasks_revision(s)).unwrap(), 5);
    assert_eq!(block_on(kernel.tasks_items(s)).unwrap().items.len(), 1);

    // A failed mutation is not a mutation.
    assert!(block_on(kernel.tasks_remove(s, &first)).is_err());
    assert!(block_on(kernel.tasks_set_title(s, "nope", "x".into())).is_err());
    assert_eq!(block_on(kernel.tasks_revision(s)).unwrap(), 5);
}

// -- events ------------------------------------------------------------------

/// True while nothing is queued. Draining is the only way to ask, and it is
/// destructive, which is the whole of the `event-source` contract.
fn quiet(kernel: &Kernel) -> bool {
    kernel.drain_events().is_empty()
}

#[test]
fn drain_returns_everything_queued_in_order_and_empties_the_queue() {
    // internal.wit `event-source`: non-parking. The glue drains after every
    // export call it dispatches, so `drain` must answer immediately and must
    // not hand the same event over twice.
    let kernel = boot();
    assert!(quiet(&kernel));

    kernel.push_event(Event::SessionEnded(1, "first".into()));
    kernel.push_event(Event::SessionEnded(2, "second".into()));
    assert_eq!(
        kernel.drain_events(),
        vec![
            Event::SessionEnded(1, "first".into()),
            Event::SessionEnded(2, "second".into()),
        ]
    );
    assert!(quiet(&kernel), "a drained event is gone");
}

#[test]
fn abort_ends_the_session_and_announces_it_once() {
    // internal.wit `apps.abort`: the glue reports a session that died on its
    // own. It ends and emits `session-ended`; the reason crosses verbatim
    // because it is framework voice the glue composed.
    let kernel = boot();
    let s = session(&kernel);
    kernel.abort(s, "the app's frame was closed: policy".into());

    assert_eq!(
        kernel.session_app(s).unwrap_err().code,
        ErrorCode::UnknownSession,
        "the session is no longer live"
    );
    assert_eq!(
        kernel.drain_events(),
        vec![Event::SessionEnded(
            s,
            "the app's frame was closed: policy".into()
        )]
    );

    // Idempotent: a second abort of the same session announces nothing.
    kernel.abort(s, "again".into());
    assert!(quiet(&kernel));
}

#[test]
fn aborting_an_unknown_session_is_a_no_op() {
    let kernel = boot();
    kernel.abort(404, "never existed".into());
    assert!(quiet(&kernel));
}

#[test]
fn close_then_abort_announces_nothing() {
    // The visor closed the session itself; a frame teardown message racing
    // behind it must not manufacture an ending the visor did not cause.
    let kernel = boot();
    let s = session(&kernel);
    kernel.close(s);
    kernel.abort(s, "the app's frame was closed: gone".into());
    assert!(quiet(&kernel));
}

// -- sync --------------------------------------------------------------------

/// Run the whole pairing ceremony between two booted devices: `joiner` shows
/// a code, `adder` claims it, both users compare the digits and confirm.
/// Answers the SAS both sides displayed — the same six digits, or the
/// ceremony did not happen.
fn pair(joiner: &Rc<Kernel>, adder: &Rc<Kernel>) -> String {
    let code = block_on(joiner.pairing_offer()).unwrap();
    assert_eq!(
        joiner.pairing_status().unwrap(),
        Phase::Offering(code.clone())
    );
    block_on(adder.pairing_claim(code)).unwrap();

    let (here, there) = settle_until(|| async {
        match (
            joiner.pairing_status().unwrap(),
            adder.pairing_status().unwrap(),
        ) {
            (Phase::AwaitingConfirm(here), Phase::AwaitingConfirm(there)) => Some((here, there)),
            (Phase::Failed(why), _) | (_, Phase::Failed(why)) => panic!("pairing failed: {why}"),
            _ => None,
        }
    });
    assert_eq!(here, there, "both devices show the same six digits");

    joiner.pairing_confirm().unwrap();
    adder.pairing_confirm().unwrap();
    settle_until(|| async {
        (joiner.pairing_status().unwrap() == Phase::Done
            && adder.pairing_status().unwrap() == Phase::Done)
            .then_some(())
    });
    settle();
    here
}

/// The todo list one session of `APP` sees.
async fn titles(kernel: &Kernel, session: u32) -> Vec<String> {
    kernel
        .tasks_items(session)
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.title)
        .collect()
}

#[test]
fn two_devices_on_one_network_converge_on_tasks() {
    let here = World::default();
    let there = here.peer();
    let a = here.boot();
    let b = there.boot();
    let (sa, sb) = (session(&a), session(&b));
    // The endpoints bind on spawned tasks; give them their turns.
    settle();

    block_on(a.tasks_add(sa, "buy milk".into())).unwrap();
    // Opening the list on B is what makes it ask for the tree.
    assert!(block_on(titles(&b, sb)).is_empty());

    let endpoint = b.device_status().unwrap().endpoint_id;
    assert!(!endpoint.is_empty(), "an open device binds an endpoint");
    // Sync is within the group and nowhere else, so the two devices pair
    // first — B shows the code, A claims it.
    let _sas = pair(&b, &a);
    block_on(a.sync_connect(endpoint.clone())).unwrap();
    assert_eq!(
        a.sync_peers().unwrap(),
        vec![polyvisor_kernel::Peer {
            endpoint_id: endpoint,
            state: "connected".into()
        }]
    );

    let seen = settle_until(|| async {
        let items = titles(&b, sb).await;
        (!items.is_empty()).then_some(items)
    });
    assert_eq!(seen, vec!["buy milk"]);

    // And back the other way.
    let id = block_on(b.tasks_items(sb)).unwrap().items[0].id.clone();
    block_on(b.tasks_set_completed(sb, &id, true)).unwrap();
    settle_until(|| async {
        a.tasks_items(sa).await.unwrap().items[0]
            .completed
            .then_some(())
    });
}

#[test]
fn a_remote_change_is_checkpointed_so_a_reboot_still_has_it() {
    // The engine's event pump checkpoints what no export call witnessed: a
    // change that arrived from a peer. Without that, B's reload would forget
    // A's todo — the device would have shown it and then lost it.
    let here = World::default();
    let there = here.peer();
    let a = here.boot();
    {
        let b = there.boot();
        let sb = session(&b);
        let sa = session(&a);
        settle();
        assert!(block_on(titles(&b, sb)).is_empty());
        let _sas = pair(&b, &a);
        block_on(a.sync_connect(b.device_status().unwrap().endpoint_id)).unwrap();
        block_on(a.tasks_add(sa, "from a".into())).unwrap();
        settle_until(|| async {
            let items = titles(&b, sb).await;
            (!items.is_empty()).then_some(items)
        });
    }

    // B reboots: a fresh worker over the same storage. A is still up, but the
    // reboot must not need it — what B shows comes off its own disk.
    let rebooted = there.boot();
    let session = session(&rebooted);
    assert_eq!(block_on(titles(&rebooted, session)), vec!["from a"]);
}

#[test]
fn a_relay_that_never_answers_does_not_hold_up_the_device() {
    // The bind is a relay handshake, and a relay that never answers must cost
    // the device nothing but its ability to dial: booting behind one froze
    // `device.status`, and with it every visor on the origin.
    let world = World::with_net(FakeNet::gated());
    let kernel = world.boot();
    settle();

    let status = kernel.device_status().unwrap();
    assert_eq!(
        status.state,
        State::Fresh,
        "the device is open for business"
    );
    assert_eq!(status.endpoint_id, "", "and has no endpoint id yet");

    // Tasks, the whole point of the device, work regardless.
    let s = session(&kernel);
    block_on(kernel.tasks_add(s, "works offline".into())).unwrap();
    assert_eq!(block_on(titles(&kernel, s)), vec!["works offline"]);

    let refused = block_on(kernel.sync_connect("whoever".into())).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unavailable);
    assert!(
        refused.message.contains("still binding"),
        "the reason names the bind, not the peer: {}",
        refused.message
    );
}

#[test]
fn an_endpoint_that_binds_late_shows_up_in_status_when_it_does() {
    let net = FakeNet::gated();
    let world = World::with_net(net.clone());
    let kernel = world.boot();
    settle();
    assert_eq!(kernel.device_status().unwrap().endpoint_id, "");

    net.open_gate();
    settle();
    assert!(
        !kernel.device_status().unwrap().endpoint_id.is_empty(),
        "status reports the endpoint id from the moment the bind lands"
    );
    // And dialing stops answering "still binding". What it answers instead
    // is the group: a device this one has never paired with is refused
    // before it is dialed at all (internal.wit `sync.connect`).
    let nobody = "ab".repeat(32);
    let refused = block_on(kernel.sync_connect(nobody)).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Refused);
    assert!(
        refused.message.contains("not a member"),
        "the endpoint is up, so the failure is the group's: {}",
        refused.message
    );
}

// -- checkpoint serialisation ------------------------------------------------

impl World {
    /// The most writes this world ever had in flight at once.
    fn peak_writes(&self) -> u32 {
        self.files.peak_in_flight.get()
    }

    /// How many generations were sealed: one `state` file per checkpoint.
    fn checkpoints(&self) -> usize {
        self.files
            .written
            .borrow()
            .iter()
            .filter(|path| path.ends_with("/state"))
            .count()
    }

    fn forget_writes(&self) {
        self.files.written.borrow_mut().clear();
        self.files.peak_in_flight.set(0);
    }
}

#[test]
fn two_export_calls_at_once_do_not_write_two_checkpoints_at_once() {
    // The OPFS host refuses concurrent access handles, and two runs of
    // `checkpoint::write` racing would also advance `dev/<id>/gen` out of
    // order. The glue dispatches exports concurrently, so this is the plain
    // case: two mutations in flight together.
    let world = World::default();
    let kernel = world.boot();
    let s = session(&kernel);
    world.forget_writes();

    block_on(async {
        let (first, second) = futures::future::join(
            kernel.tasks_add(s, "milk".into()),
            kernel.tasks_add(s, "bread".into()),
        )
        .await;
        first.unwrap();
        second.unwrap();
    });

    assert_eq!(world.peak_writes(), 1, "checkpoints never overlap");
    // Two mutations, but the second arrives while the first is writing and is
    // coalesced into one further pass: one checkpoint per loop iteration.
    assert!(
        world.checkpoints() <= 2,
        "two rapid mutations coalesce; wrote {} checkpoints",
        world.checkpoints()
    );

    // And nothing was lost by coalescing: the last generation written holds
    // both todos, which a reload proves.
    let rebooted = world.boot();
    let s = session(&rebooted);
    let mut titles = block_on(titles(&rebooted, s));
    titles.sort();
    assert_eq!(titles, vec!["bread", "milk"]);
}

#[test]
fn a_remote_change_checkpointing_does_not_overlap_a_local_one() {
    // The two callers that are not ordered with respect to each other: the
    // export path, and the engine's event pump.
    let here = World::default();
    let there = here.peer();
    let a = here.boot();
    let b = there.boot();
    let (sa, sb) = (session(&a), session(&b));
    settle();
    assert!(block_on(titles(&b, sb)).is_empty());
    let _sas = pair(&b, &a);
    block_on(a.sync_connect(b.device_status().unwrap().endpoint_id)).unwrap();

    there.forget_writes();

    // Both devices mutate in the same turn of the pool: A's change reaches B
    // while B is already writing its own. B's pump checkpoints the remote
    // one, B's export path the local one, and neither knows about the other.
    block_on(async {
        let (from_a, from_b) = futures::future::join(
            a.tasks_add(sa, "from a".into()),
            b.tasks_add(sb, "from b".into()),
        )
        .await;
        from_a.unwrap();
        from_b.unwrap();
    });
    settle();

    assert_eq!(
        there.peak_writes(),
        1,
        "B never wrote two checkpoints at once"
    );
    let mut seen = block_on(titles(&b, sb));
    seen.sort();
    assert_eq!(seen, vec!["from a", "from b"]);

    // Both survive B's reload, so the coalesced checkpoint carried both.
    let rebooted = there.boot();
    let s = session(&rebooted);
    let mut titles = block_on(titles(&rebooted, s));
    titles.sort();
    assert_eq!(titles, vec!["from a", "from b"]);
}

#[test]
fn a_peer_that_goes_away_stops_being_reported_as_connected() {
    // The engine's connection registry shrinks on `ConnectionClosed`, and the
    // kernel's peer list has to follow it: a row stuck at "connected" is the
    // visor telling the user they are syncing with a device that is gone.
    let here = World::default();
    let there = here.peer();
    let a = here.boot();
    let b = there.boot();
    settle();

    let endpoint = b.device_status().unwrap().endpoint_id;
    let _sas = pair(&b, &a);
    block_on(a.sync_connect(endpoint.clone())).unwrap();
    assert_eq!(
        a.sync_peers().unwrap(),
        vec![polyvisor_kernel::Peer {
            endpoint_id: endpoint.clone(),
            state: "connected".into()
        }]
    );

    // B's worker dies: every pipe it held closes.
    there.net.unplug(&endpoint);
    let state = settle_until(|| async {
        let peers = a.sync_peers().unwrap();
        let state = peers.first().map(|p| p.state.clone()).unwrap_or_default();
        (state != "connected").then_some(state)
    });
    assert_eq!(state, "closed: the peer went away");
}

#[test]
fn an_inbound_peer_that_authenticates_as_someone_else_is_dropped() {
    // An inbound connection cannot pin its audience — it learns who dialed it
    // from the handshake — so the check the outbound path gets for free has
    // to happen after: the peer subduction authenticated must be the key the
    // endpoint id spelled. Otherwise anyone could arrive wearing a trusted
    // device's endpoint id and take its row in the peer list.
    let here = World::default();
    let there = here.peer();
    let a = here.boot();
    let b = there.boot();
    settle();

    let _sas = pair(&b, &a);
    let a_endpoint = a.device_status().unwrap().endpoint_id;
    // A dials B announcing a key that is not A's.
    here.net.impersonate(&a_endpoint, [7u8; 32]);
    let _attempt = block_on(a.sync_connect(b.device_status().unwrap().endpoint_id));

    let state = settle_until(|| async {
        let peers = b.sync_peers().unwrap();
        let row = peers.first()?;
        row.state.starts_with("closed").then(|| row.state.clone())
    });
    assert_eq!(state, "closed: it authenticated as a different device");
}

// -- pairing -----------------------------------------------------------------

/// The group as `sync.members` reports it, endpoint ids only, sorted so two
/// devices' answers compare directly.
fn member_ids(kernel: &Kernel) -> Vec<String> {
    let mut ids: Vec<String> = block_on(kernel.sync_members())
        .unwrap()
        .into_iter()
        .map(|member| member.endpoint_id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn pairing_enrolls_the_joiner_and_the_two_devices_then_sync() {
    // The whole ceremony, end to end: the joiner shows a code, the adder
    // claims it, both users see the same six digits and confirm, the adder
    // enrolls the joiner and sends the group over, and the joiner adopts it
    // and dials. Only then do the two devices sync at all.
    let here = World::default();
    let there = here.peer();
    let joiner = here.boot();
    let adder = there.boot();
    let (sj, sa) = (session(&joiner), session(&adder));
    settle();

    // Before pairing each device is its own group of one, and neither knows
    // the other.
    assert_eq!(
        member_ids(&joiner),
        vec![joiner.device_status().unwrap().endpoint_id]
    );
    assert_eq!(
        member_ids(&adder),
        vec![adder.device_status().unwrap().endpoint_id]
    );

    let sas = pair(&joiner, &adder);
    assert_eq!(sas.len(), 6, "six digits, in trusted pixels on both sides");

    // Every transition was announced. The visor has no timer, so the phases
    // the *other* device drove — the SAS arriving, the enrollment landing —
    // reach a screen only as events.
    for kernel in [&joiner, &adder] {
        let phases: Vec<Phase> = kernel
            .drain_events()
            .into_iter()
            .map(|event| match event {
                Event::PairingChanged(phase) => phase,
                other => panic!("unexpected event: {other:?}"),
            })
            .collect();
        assert!(
            phases.contains(&Phase::AwaitingConfirm(sas.clone())),
            "the digits were pushed: {phases:?}"
        );
        assert_eq!(phases.last(), Some(&Phase::Done));
    }

    let mut expected = vec![
        joiner.device_status().unwrap().endpoint_id,
        adder.device_status().unwrap().endpoint_id,
    ];
    expected.sort();
    assert_eq!(
        member_ids(&joiner),
        expected,
        "the joiner adopted the group"
    );
    assert_eq!(member_ids(&adder), expected, "the adder wrote it");
    // And each device knows which row is itself.
    for kernel in [&joiner, &adder] {
        let mine: Vec<String> = block_on(kernel.sync_members())
            .unwrap()
            .into_iter()
            .filter(|m| m.me)
            .map(|m| m.endpoint_id)
            .collect();
        assert_eq!(mine, vec![kernel.device_status().unwrap().endpoint_id]);
    }

    // The joiner dialed the adder as the last step of the ceremony, so tasks
    // converge with no further `sync.connect`.
    block_on(adder.tasks_add(sa, "after pairing".into())).unwrap();
    let seen = settle_until(|| async {
        let items = titles(&joiner, sj).await;
        (!items.is_empty()).then_some(items)
    });
    assert_eq!(seen, vec!["after pairing"]);
}

#[test]
fn a_second_claim_is_refused_and_burns_the_ceremony_it_interrupted() {
    // PAIRING.md §1: the token is single-claim. A code that reached a second
    // party has leaked, so the second claim is refused *and* the bound
    // session dies — both users start over rather than one of them finishing
    // a ceremony an eavesdropper watched.
    let here = World::default();
    let there = here.peer();
    let elsewhere = here.peer_seeded(0x0fed_cba9_8765_4321);
    let joiner = here.boot();
    let first = there.boot();
    let second = elsewhere.boot();
    settle();

    let code = block_on(joiner.pairing_offer()).unwrap();
    block_on(first.pairing_claim(code.clone())).unwrap();
    settle_until(|| async {
        matches!(joiner.pairing_status().unwrap(), Phase::AwaitingConfirm(_)).then_some(())
    });

    block_on(second.pairing_claim(code)).unwrap();
    let (joiner_phase, second_phase) = settle_until(|| async {
        match (
            joiner.pairing_status().unwrap(),
            second.pairing_status().unwrap(),
        ) {
            (Phase::Failed(a), Phase::Failed(b)) => Some((a, b)),
            _ => None,
        }
    });
    assert!(
        joiner_phase.contains("already tried this code"),
        "the joiner's ceremony was burned: {joiner_phase}"
    );
    assert!(
        second_phase.contains("spent or expired"),
        "the second claimer was refused: {second_phase}"
    );
    // And nobody was enrolled.
    assert_eq!(member_ids(&joiner).len(), 1);
    assert_eq!(member_ids(&first).len(), 1);
    assert_eq!(member_ids(&second).len(), 1);
}

#[test]
fn a_reveal_that_does_not_match_the_commitment_aborts() {
    // The commitment ordering is what stops the dialing side grinding the
    // 20-bit SAS: it is committed to its nonce before it learns the
    // joiner's. Both kernels here are honest, so the REVEAL is rewritten in
    // flight — a peer that picked its nonce after the fact looks exactly
    // like this.
    let here = World::default();
    let there = here.peer();
    let joiner = here.boot();
    let adder = there.boot();
    settle();

    there.net.tamper(
        &adder.device_status().unwrap().endpoint_id,
        Rc::new(|bytes: Vec<u8>| {
            if bytes.starts_with(br#"{"Reveal""#) {
                let zeros = ["0"; 32].join(",");
                return format!(r#"{{"Reveal":{{"nonce":[{zeros}]}}}}"#).into_bytes();
            }
            bytes
        }),
    );

    let code = block_on(joiner.pairing_offer()).unwrap();
    block_on(adder.pairing_claim(code.clone())).unwrap();
    let why = settle_until(|| async {
        match joiner.pairing_status().unwrap() {
            Phase::Failed(why) => Some(why),
            _ => None,
        }
    });
    assert!(
        why.contains("did not match what it committed to"),
        "the joiner refused the reveal: {why}"
    );
    assert_eq!(member_ids(&joiner).len(), 1, "nothing was enrolled");

    // And the code died with the ceremony: it was claimed once, that claim
    // failed, and a code that outlived its ceremony is a second chance for
    // whoever else has seen it. The joiner is not answering that door.
    block_on(adder.pairing_cancel()).unwrap();
    assert_eq!(adder.pairing_status().unwrap(), Phase::Idle);
    block_on(adder.pairing_claim(code)).unwrap();
    let why = settle_until(|| async {
        match adder.pairing_status().unwrap() {
            Phase::Failed(why) => Some(why),
            _ => None,
        }
    });
    assert_eq!(why, "the other device went away");
}

#[test]
fn a_cancel_before_the_confirm_tells_the_other_side() {
    // internal.wit `pairing.cancel`: "Either side, at any point; the other
    // side sees `failed`." A ceremony that just went quiet would leave the
    // other user staring at six digits forever.
    let here = World::default();
    let there = here.peer();
    let joiner = here.boot();
    let adder = there.boot();
    settle();

    let code = block_on(joiner.pairing_offer()).unwrap();
    block_on(adder.pairing_claim(code)).unwrap();
    settle_until(|| async {
        match (
            joiner.pairing_status().unwrap(),
            adder.pairing_status().unwrap(),
        ) {
            (Phase::AwaitingConfirm(_), Phase::AwaitingConfirm(_)) => Some(()),
            _ => None,
        }
    });

    block_on(adder.pairing_cancel()).unwrap();
    assert_eq!(
        adder.pairing_status().unwrap(),
        Phase::Idle,
        "the side that cancelled is back to nothing in flight"
    );
    let why = settle_until(|| async {
        match joiner.pairing_status().unwrap() {
            Phase::Failed(why) => Some(why),
            _ => None,
        }
    });
    assert_eq!(why, "the other device cancelled");
    assert_eq!(member_ids(&joiner).len(), 1);
    assert_eq!(member_ids(&adder).len(), 1);

    // A cancel takes the code with it. The user who cancelled believes they
    // revoked what was on their screen; an offer left standing would keep
    // answering dials for the rest of its two minutes.
    let code = block_on(joiner.pairing_offer()).unwrap();
    block_on(joiner.pairing_cancel()).unwrap();
    block_on(adder.pairing_claim(code)).unwrap();
    let why = settle_until(|| async {
        match adder.pairing_status().unwrap() {
            Phase::Failed(why) => Some(why),
            _ => None,
        }
    });
    assert_eq!(why, "the other device went away");
}

#[test]
fn an_offer_expires_after_two_minutes() {
    // PAIRING.md §1: the offer stands 120 s. After that the code is dead on
    // both sides — the joiner says so, and a claim that arrives late is
    // refused rather than quietly honoured.
    let here = World::default();
    let there = here.peer();
    let joiner = here.boot();
    let adder = there.boot();
    settle();

    let code = block_on(joiner.pairing_offer()).unwrap();
    here.clock.advance(120_000);
    match joiner.pairing_status().unwrap() {
        Phase::Failed(why) => assert!(why.contains("expired"), "{why}"),
        other => panic!("the offer should have lapsed: {other:?}"),
    }

    // The adder's clock is its own, so it dials in good faith and is
    // refused by the device that minted the code.
    block_on(adder.pairing_claim(code)).unwrap();
    let why = settle_until(|| async {
        match adder.pairing_status().unwrap() {
            Phase::Failed(why) => Some(why),
            _ => None,
        }
    });
    assert!(
        why.contains("spent or expired"),
        "the late claim was refused: {why}"
    );
    assert_eq!(member_ids(&joiner).len(), 1);
}

#[test]
fn a_device_outside_the_group_is_closed_on_the_subduction_wire() {
    // The post-handshake check. A device can believe it is a member — the
    // group document reaches devices at different times — and still be a
    // stranger to the device it dials. What it must not be is synced with.
    let here = World::default();
    let there = here.peer();
    let elsewhere = here.peer_seeded(0x0fed_cba9_8765_4321);
    let b = here.boot();
    let a = there.boot();
    let c = elsewhere.boot();
    settle();

    // A adds B, then loses touch with it.
    let _sas = pair(&b, &a);
    let b_endpoint = b.device_status().unwrap().endpoint_id;
    here.net.cut(&b_endpoint);
    settle();

    // A adds C. C's group now has three devices; B's still has two, because
    // B has not been reachable since.
    let _sas = pair(&c, &a);
    assert_eq!(member_ids(&c).len(), 3);
    assert_eq!(member_ids(&b).len(), 2, "B has not heard about C");

    // So C dials B in good faith, and B closes it with the reason.
    let _attempt = block_on(c.sync_connect(b_endpoint));
    let c_endpoint = c.device_status().unwrap().endpoint_id;
    let state = settle_until(|| async {
        let peers = b.sync_peers().unwrap();
        let row = peers.iter().find(|p| p.endpoint_id == c_endpoint)?;
        row.state.starts_with("closed").then(|| row.state.clone())
    });
    assert_eq!(state, "closed: not a member of this device's group");
}

#[test]
fn a_device_dials_its_group_when_it_comes_back_up() {
    // The group is the address book: no `sync.connect` from the visor is
    // needed after the first pairing, or a reload would leave two paired
    // devices sitting next to each other doing nothing.
    let here = World::default();
    let there = here.peer();
    let b = here.boot();
    let a = there.boot();
    settle();
    let _sas = pair(&b, &a);
    let a_endpoint = a.device_status().unwrap().endpoint_id;

    // B reloads: the old worker dies with every wire it held, and a fresh
    // one comes up over the same storage. Nobody tells it to dial anything.
    let b_endpoint = b.device_status().unwrap().endpoint_id;
    drop(b);
    here.net.cut(&b_endpoint);
    // A has to have *noticed*: a dial that arrives while the peer still
    // holds the dead connection is a second connection from one peer id,
    // which subduction closes.
    settle_until(|| async {
        let peers = a.sync_peers().unwrap();
        peers.first()?.state.starts_with("closed").then_some(())
    });
    let rebooted = here.boot();
    let state = settle_until(|| async {
        let peers = rebooted.sync_peers().unwrap();
        let row = peers.iter().find(|p| p.endpoint_id == a_endpoint)?;
        (row.state == "connected").then(|| row.state.clone())
    });
    assert_eq!(state, "connected");

    // And it is a working connection, not just a row.
    let sa = session(&a);
    let sb = session(&rebooted);
    block_on(a.tasks_add(sa, "while you were out".into())).unwrap();
    let seen = settle_until(|| async {
        let items = titles(&rebooted, sb).await;
        (!items.is_empty()).then_some(items)
    });
    assert_eq!(seen, vec!["while you were out"]);
}

#[test]
fn two_claims_that_arrive_together_still_leave_one_ceremony() {
    // The single-claim rule has to hold when the two dials *overlap*, not
    // just when one follows the other: a code shown on a screen can be
    // claimed by two devices in the same instant. Both connections are held
    // at the joiner's door and released together, so neither has read its
    // CLAIM when the other arrives — which is precisely the window in which
    // a second session could otherwise be bound over the first and be handed
    // this user's confirmation.
    let here = World::default();
    let there = here.peer();
    let elsewhere = here.peer_seeded(0x0fed_cba9_8765_4321);
    let joiner = here.boot();
    let first = there.boot();
    let second = elsewhere.boot();
    settle();

    let joiner_endpoint = joiner.device_status().unwrap().endpoint_id;
    let code = block_on(joiner.pairing_offer()).unwrap();
    here.net.hold(&joiner_endpoint);
    block_on(first.pairing_claim(code.clone())).unwrap();
    block_on(second.pairing_claim(code)).unwrap();
    settle();
    assert_eq!(
        joiner.pairing_status().unwrap(),
        Phase::Offering(code_of(&joiner)),
        "neither claim has been read yet",
    );

    here.net.release(&joiner_endpoint);
    let (claimer, refused) = settle_until(|| async {
        let (a, b) = (
            first.pairing_status().unwrap(),
            second.pairing_status().unwrap(),
        );
        match (&a, &b) {
            (Phase::AwaitingConfirm(_), Phase::Failed(_))
            | (Phase::Failed(_), Phase::AwaitingConfirm(_)) => Some((a, b)),
            // Both failing is also an answer, and a legal one: whichever
            // read second burned the ceremony the first had bound.
            (Phase::Failed(_), Phase::Failed(_)) => Some((a, b)),
            _ => None,
        }
    });
    assert!(
        !matches!(
            (&claimer, &refused),
            (Phase::AwaitingConfirm(_), Phase::AwaitingConfirm(_))
        ),
        "only one of the two can have claimed the code",
    );

    // Whatever the joiner's screen says, it is one ceremony's worth of
    // state, and the code is spent: nothing further can claim it.
    let third = joiner.pairing_status().unwrap();
    assert!(
        matches!(third, Phase::AwaitingConfirm(_) | Phase::Failed(_)),
        "the joiner is in exactly one ceremony or none: {third:?}",
    );
    // And no device was enrolled by the overlap alone.
    for kernel in [&joiner, &first, &second] {
        assert_eq!(member_ids(kernel).len(), 1);
    }
}

/// The code the joiner is currently showing.
fn code_of(kernel: &Kernel) -> String {
    match kernel.pairing_status().unwrap() {
        Phase::Offering(code) => code,
        other => panic!("this device is not showing a code: {other:?}"),
    }
}

// -- the durable store -------------------------------------------------------

/// The state parameter the kernel put in the authorization URL: the popup
/// carries it back, and the exchange refuses an answer that does not.
fn oauth_state(url: &str) -> String {
    let (_, rest) = split_base(url);
    let query = rest.split_once('?').expect("an authorization URL").1;
    params(query).get("state").cloned().expect("a state")
}

/// The whole consent ceremony, as the visor drives it: `oauth-start`, the
/// popup (the page's, so here just the code coming back), `oauth-complete`.
fn connect_store(kernel: &Rc<Kernel>) -> String {
    let url = kernel
        .oauth_start("client-id".to_string(), "client-secret".to_string())
        .unwrap();
    let state = oauth_state(&url);
    block_on(kernel.oauth_complete("synthetic-code-1".to_string(), state)).unwrap();
    settle();
    url
}

#[test]
fn consent_seals_tokens_that_survive_a_reload() {
    let drive = FakeDrive::shared();
    let world = World::default().with_drive(&drive);
    let kernel = world.boot();
    settle();
    assert_eq!(kernel.storage_status().unwrap().state, "not connected");

    let url = connect_store(&kernel);

    // The authorization URL is PKCE's: a challenge, its method, the redirect
    // the glue told the kernel about, and the appdata scope — the narrowest
    // one Drive offers, which is what makes "user-only" the platform's rule
    // rather than this code's promise.
    let (base, rest) = split_base(&url);
    assert_eq!(base, DRIVE_OAUTH);
    let query = params(rest.split_once('?').unwrap().1);
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(!query["code_challenge"].is_empty());
    assert_eq!(query["redirect_uri"], PAGE_URL);
    assert_eq!(query["client_id"], "client-id");
    assert_eq!(
        query["scope"],
        "https://www.googleapis.com/auth/drive.appdata"
    );
    assert_eq!(query["access_type"], "offline");

    let status = kernel.storage_status().unwrap();
    assert_eq!(status.state, "connected");
    assert_eq!(status.provider, "gdrive");

    // Sealed, not merely in memory: a reload must not send the user back
    // through a consent they already gave.
    drop(kernel);
    let again = world.boot();
    settle();
    assert_eq!(again.storage_status().unwrap().state, "connected");
}

#[test]
fn a_second_answer_to_a_ceremony_is_refused_and_a_wrong_state_is_not_it() {
    let drive = FakeDrive::shared();
    let kernel = World::default().with_drive(&drive).boot();
    settle();
    let url = kernel
        .oauth_start("client-id".to_string(), "client-secret".to_string())
        .unwrap();
    let state = oauth_state(&url);

    // A popup answering with somebody else's state is not this ceremony's,
    // and it does not get to cancel it.
    let why =
        block_on(kernel.oauth_complete("c".to_string(), "not-the-state".to_string())).unwrap_err();
    assert_eq!(why.code, ErrorCode::Refused);
    block_on(kernel.oauth_complete("synthetic-code-1".to_string(), state.clone())).unwrap();
    settle();

    // The code is one-shot, and so is the verifier it was bound to.
    let why = block_on(kernel.oauth_complete("synthetic-code-1".to_string(), state)).unwrap_err();
    assert_eq!(why.code, ErrorCode::Refused);
    assert_eq!(kernel.storage_status().unwrap().state, "connected");
}

#[test]
fn a_push_writes_one_object_per_item_and_never_writes_one_twice() {
    let drive = FakeDrive::shared();
    let world = World::default().with_drive(&drive);
    let kernel = world.boot();
    let session = session(&kernel);
    settle();

    connect_store(&kernel);
    settle();
    let founding = drive.objects().len();
    assert!(founding > 0, "the group's own items are pushed at once");
    assert_eq!(drive.folders().len(), 1, "one folder, named under the key");
    assert!(drive.folders()[0].starts_with("polyvisor-"));

    // A local mutation is its own trigger: nothing asked for this sync.
    block_on(kernel.tasks_add(session, "buy milk".to_string())).unwrap();
    settle();
    let after = drive.objects();
    assert!(
        after.len() > founding,
        "the task's commit reached the store: {founding} -> {}",
        after.len()
    );
    let mut names = after.clone();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), after.len(), "no name is written twice");
    assert_eq!(
        drive.uploads(),
        after.len(),
        "every upload created an object nothing had"
    );

    // Asked again with nothing new: the listing already holds every name this
    // device can derive, so not one byte goes up.
    let uploads = drive.uploads();
    block_on(kernel.sync_now()).unwrap();
    settle();
    assert_eq!(drive.uploads(), uploads, "a second sync re-uploads nothing");
    assert_eq!(drive.objects().len(), after.len());
    assert_eq!(kernel.storage_status().unwrap().state, "connected");
    assert!(kernel.storage_status().unwrap().last_push > 0);
}

#[test]
fn a_device_of_the_group_converges_through_the_store_with_no_peer() {
    // The store's whole point: a device that was never online at the same
    // moment as its peers still gets their changes.
    let drive = FakeDrive::shared();
    let here = World::default().with_drive(&drive);
    let there = here.peer().with_drive(&drive);
    let a = here.boot();
    let b = there.boot();
    let (sa, sb) = (session(&a), session(&b));
    settle();

    // Paired, so B holds A's group *and* A's store-name key: the second is
    // what makes the two devices derive the same object names.
    let _sas = pair(&b, &a);
    connect_store(&a);
    connect_store(&b);
    settle();

    // Now cut the network entirely. Anything B learns from here on came
    // through the user's Drive and nowhere else.
    let (ida, idb) = (
        a.device_status().unwrap().endpoint_id,
        b.device_status().unwrap().endpoint_id,
    );
    here.net.unplug(&ida);
    here.net.unplug(&idb);
    settle();

    block_on(a.tasks_add(sa, "from A".to_string())).unwrap();
    settle();
    assert!(
        drive.objects().len() > 1,
        "A pushed the change it just made"
    );

    let seen = settle_until(|| async {
        let _synced = b.sync_now().await;
        let seen = titles(&b, sb).await;
        (!seen.is_empty()).then_some(seen)
    });
    assert_eq!(seen, vec!["from A".to_string()]);
    assert!(b.storage_status().unwrap().last_pull > 0);

    // And it stayed: a pull is a change like any other, so it is
    // checkpointed, so a reload still has it.
    drop(b);
    let again = there.boot();
    let reopened = session(&again);
    settle();
    assert_eq!(
        block_on(titles(&again, reopened)),
        vec!["from A".to_string()]
    );
}

#[test]
fn a_device_outside_the_group_pulls_nothing_from_the_same_account() {
    // The same Google account, and nothing crosses between the two groups:
    // the names are derived under a key a stranger does not have, so a
    // stranger's listing does not even name the objects — never mind that
    // their contents are envelopes it could not open.
    let drive = FakeDrive::shared();
    let here = World::default().with_drive(&drive);
    let elsewhere = here.peer_seeded(0xfeed_face_dead_beef).with_drive(&drive);
    let a = here.boot();
    let stranger = elsewhere.boot();
    let (sa, ss) = (session(&a), session(&stranger));
    settle();

    connect_store(&a);
    block_on(a.tasks_add(sa, "from A".to_string())).unwrap();
    settle();
    let theirs = drive.objects().len();

    connect_store(&stranger);
    block_on(stranger.sync_now()).unwrap();
    settle();

    assert!(
        block_on(titles(&stranger, ss)).is_empty(),
        "a device of another group learns nothing"
    );
    assert_eq!(
        drive.folders().len(),
        2,
        "two groups, two folders, neither name derivable from the other"
    );
    assert!(
        drive.objects().len() > theirs,
        "the stranger wrote its own items, under its own names"
    );
}

#[test]
fn an_expired_token_is_refreshed_once_and_the_push_lands() {
    let drive = FakeDrive::shared();
    let world = World::default().with_drive(&drive);
    let kernel = world.boot();
    let live = session(&kernel);
    settle();
    connect_store(&kernel);
    settle();
    let before = drive.objects().len();

    // The access token lapses; the refresh token still works, which is the
    // ordinary case an hour into a session.
    drive.revoke_access();
    block_on(kernel.tasks_add(live, "after the lapse".to_string())).unwrap();
    settle();

    assert!(
        drive.objects().len() > before,
        "the 401 was answered with a refresh and the request retried"
    );
    assert_eq!(kernel.storage_status().unwrap().state, "connected");

    // The new access token was sealed too: a reload resumes on it rather than
    // on the one Google has already forgotten.
    drop(kernel);
    let again = world.boot();
    let reopened = session(&again);
    settle();
    block_on(again.tasks_add(reopened, "after the reload".to_string())).unwrap();
    settle();
    assert_eq!(again.storage_status().unwrap().state, "connected");
}

#[test]
fn a_refresh_that_fails_asks_for_re_authorization_and_stops_trying_unprompted() {
    let drive = FakeDrive::shared();
    let kernel = World::default().with_drive(&drive).boot();
    let live = session(&kernel);
    settle();
    connect_store(&kernel);
    settle();

    // The consent itself is gone — the user withdrew it at Google. The
    // access token is refused, and so is the refresh that would have fixed
    // it.
    drive.revoke_access();
    drive.revoke_refresh();
    block_on(kernel.sync_now()).unwrap();
    settle();

    let state = kernel.storage_status().unwrap().state;
    assert!(
        state.starts_with("needs re-authorization: "),
        "framework voice, and it says what to do: {state}"
    );
    // The endpoint's own reason, and only the two fields OAuth defines for
    // it: the answer is an untrusted service's bytes, so what reaches the
    // visor is read out of them rather than echoed.
    assert!(state.contains("invalid_grant"), "{state}");
    assert!(!state.contains('{'), "the raw body was echoed: {state}");
    // Still bound: the tokens are kept so the state can say what is wrong.
    // Only `disconnect` forgets them.
    assert_ne!(state, "not connected");

    // And now nothing happens on its own. This state ends when the user
    // acts, so a mutation that scheduled a sync would spend a round trip
    // re-proving a token the endpoint has already refused — every mutation,
    // for as long as the device runs.
    let quiet = drive.requests();
    block_on(kernel.tasks_add(live, "buy milk".to_string())).unwrap();
    settle();
    assert_eq!(
        drive.requests(),
        quiet,
        "a local mutation kept asking a store that said no"
    );

    // Asked to, it tries again: "sync now" is the button someone presses to
    // find out whether it is still true.
    block_on(kernel.sync_now()).unwrap();
    settle();
    assert!(drive.requests() > quiet, "an explicit sync retries");
    assert!(
        kernel
            .storage_status()
            .unwrap()
            .state
            .starts_with("needs re-authorization: "),
        "and it is still true"
    );

    // A fresh consent is the other act that clears it, and the mutation that
    // was never pushed goes up with the next pass.
    connect_store(&kernel);
    settle();
    assert_eq!(kernel.storage_status().unwrap().state, "connected");
    assert!(drive.objects().len() > 1);
}

#[test]
fn an_object_that_is_not_ours_is_read_once_and_not_again() {
    // The folder is the user's own Drive: something else may leave a file in
    // it, and it must not become a download on every sync for the life of
    // the worker.
    let drive = FakeDrive::shared();
    let kernel = World::default().with_drive(&drive).boot();
    settle();
    connect_store(&kernel);
    settle();
    drive.plant("not-one-of-ours", b"a text file someone dropped in here");

    block_on(kernel.sync_now()).unwrap();
    settle();
    assert_eq!(drive.reads_of("not-one-of-ours"), 1);

    block_on(kernel.sync_now()).unwrap();
    settle();
    assert_eq!(
        drive.reads_of("not-one-of-ours"),
        1,
        "the second pass fetched it again to reach the same conclusion"
    );
    assert_eq!(kernel.storage_status().unwrap().state, "connected");
}

#[test]
fn disconnect_forgets_the_tokens_and_leaves_the_store_alone() {
    let drive = FakeDrive::shared();
    let world = World::default().with_drive(&drive);
    let kernel = world.boot();
    let session = session(&kernel);
    settle();
    connect_store(&kernel);
    block_on(kernel.tasks_add(session, "buy milk".to_string())).unwrap();
    settle();
    let objects = drive.objects();
    assert!(!objects.is_empty());

    block_on(kernel.storage_disconnect()).unwrap();
    settle();
    assert_eq!(kernel.storage_status().unwrap().state, "not connected");
    assert_eq!(
        drive.objects(),
        objects,
        "forgetting an account is not deleting what it holds"
    );

    // Nothing pushes any more, and the reload agrees.
    let uploads = drive.uploads();
    block_on(kernel.tasks_add(session, "and bread".to_string())).unwrap();
    settle();
    assert_eq!(drive.uploads(), uploads);
    drop(kernel);
    let again = world.boot();
    settle();
    assert_eq!(again.storage_status().unwrap().state, "not connected");
}

#[test]
fn a_device_that_unseals_catches_up_with_the_store() {
    // A device that rests under a passphrase has been off; unsealing is the
    // first moment it can pull what its group wrote meanwhile, so it is a
    // boot trigger like any other.
    let drive = FakeDrive::shared();
    let world = World::default().with_drive(&drive);
    {
        let kernel = world.boot();
        settle();
        connect_store(&kernel);
        block_on(kernel.keep("desk".to_string(), Some("open sesame".to_string()))).unwrap();
        settle();
    }

    let kernel = world.boot();
    settle();
    assert_eq!(kernel.device_status().unwrap().state, State::Sealed);
    // Nothing has been asked of the store: a sealed device has no tokens in
    // memory, and no engine to have items for.
    let asleep = drive.requests();

    block_on(kernel.unseal("open sesame".to_string())).unwrap();
    settle();
    assert!(
        drive.requests() > asleep,
        "unsealing did not reach the store"
    );
    assert_eq!(kernel.storage_status().unwrap().state, "connected");
}
