//! The polyvisor kernel: everything the runtime component does, with no WIT
//! and no wasm dependency. The component crate (`runtime/component`) is a
//! thin adapter that implements the seams below over its generated bindings
//! and forwards each exported call here.
//!
//! Single-threaded by construction (the runtime lives in one SharedWorker),
//! so nothing here is `Send`: the trait futures are boxed without a `Send`
//! bound and shared state is `RefCell`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::{Rc, Weak};

mod apps;
mod checkpoint;
mod device;
mod drive;
mod events;
mod pairing;
mod seal;
mod store;
mod sync;

pub use apps::{AppInfo, AssetInfo, ComponentArtifacts};
pub use device::{DeviceStatus, IndexRow, MetaScope, Rest, State, Tier};
pub use drive::{Binding, HttpResponse};
pub use events::Event;
pub use pairing::Phase;
/// The task types are the engine's: the kernel no longer holds a list of its
/// own, it holds an automerge document per app inside the engine.
pub use polyvisor_engine::{EngineTransport, TaskSnapshot as Snapshot, TodoItem};
pub use store::LEASE_TTL_MS;
pub use sync::{Member, Peer};

/// The subduction wire's ALPN, and pairing's. Versioned: a framing change is
/// a new ALPN, and a peer that speaks only the other one is refused at the
/// handshake rather than after a frame it cannot parse.
///
/// Both are the kernel's rather than the endpoint adapter's because the
/// kernel is what routes an accepted connection by the one it negotiated
/// (see `sync::accept_loop`).
pub const SUBDUCTION_ALPN: &str = "polyvisor/subduction/0";
pub const PAIRING_ALPN: &str = "polyvisor/pairing/0";

use apps::Registry;
use device::Device;
use events::Events;
use seal::{Dek, WrappedDek};

use futures::future::LocalBoxFuture;
use polyvisor_engine::{DynTransport, Engine};

/// A future that borrows its owner and is never sent between threads.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The engine, at the transport the kernel gives it.
type SyncEngine = Engine<DynTransport>;

/// The unsealed key/value store (`polyvisor:internal/kv`). Arguments are
/// owned so the returned future borrows only the store.
///
/// The kernel keeps exactly two kinds of key here:
///
/// - `index/<id>` — one JSON row per device, the only record readable before
///   any seal opens (docs/design.md "Devices");
/// - `dev/<id>/...` — the small records a device needs before its state root
///   is readable: `dek` or `dek-wrapped`, and `gen`, the generation pointer.
///
/// `gen` is here rather than in the state root because it is the checkpoint's
/// commit point and the kernel cannot list a directory to find it (see
/// [`Files`]). Everything else is in the sealed namespace.
pub trait Platform {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>>;
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()>;
    fn delete(&self, key: String) -> LocalFuture<'_, ()>;
    /// Keys with the given prefix, in unspecified order.
    fn keys(&self, prefix: String) -> LocalFuture<'_, Vec<String>>;
}

/// The state root: the origin's OPFS, preopened at `/` by the glue. Paths are
/// absolute within that root; the kernel only ever touches `/<id>/...`.
///
/// Four verbs and no listing. `read-directory` is one of the four
/// `wasi:filesystem@0.3` functions that stayed sync in WIT, and the OPFS host
/// answers it with a Promise, which traps a JSPI-free worker (internal.wit
/// `world runtime`). Every path the kernel touches is therefore named, from
/// the generation pointer it keeps in `kv`.
///
/// Only `write` reports failure, and only as `Err(())` — there is nothing to
/// say about it beyond that it did not happen, and the kernel's answer is the
/// same either way: refuse to advance the pointer, so the checkpoint the
/// caller was promised is not silently the previous one. `read` answers
/// `None` for anything absent or unreadable; `remove_file` and `remove_dir`
/// are best effort and succeed silently on nothing, because a path that
/// outlives its removal is collected by name on the next write or destroy.
/// `write` creates missing parent directories.
pub trait Files {
    fn read(&self, path: String) -> LocalFuture<'_, Option<Vec<u8>>>;
    fn write(&self, path: String, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), ()>>;
    fn remove_file(&self, path: String) -> LocalFuture<'_, ()>;
    fn remove_dir(&self, path: String) -> LocalFuture<'_, ()>;
}

/// Web Locks, read side (`polyvisor:internal/locks`). The kernel asks only
/// whether some *other* worker holds a device's lock; its own is held by its
/// glue for the worker's lifetime.
pub trait Locks {
    fn is_held(&self, name: String) -> LocalFuture<'_, bool>;
}

/// The system clock (`wasi:clocks/system-clock`), in epoch milliseconds, and
/// the monotonic clock's sleep (`wasi:clocks/monotonic-clock`).
///
/// `now_ms` is synchronous: `now` is a plain `func`. Not monotonic — every
/// comparison against it saturates. `sleep` is what the sync engine's driver
/// arms its protocol deadlines with; nothing else in the kernel sleeps.
pub trait Clock {
    fn now_ms(&self) -> u64;
    fn sleep(&self, ms: u64) -> LocalFuture<'_, ()>;
}

/// Where the kernel's long-lived futures run: the sync driver, the engine's
/// event pump, each connection's read loop, and the endpoint's accept loop.
///
/// The component implements this with wit-bindgen's
/// `rt::async_support::spawn_local`; tests implement it over a `LocalPool`
/// spawner. Nothing here joins or cancels: these futures live as long as the
/// worker does.
pub trait Spawn {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>);
}

/// The device's iroh endpoint (`polymorph:iroh`).
///
/// The seed is the device's Ed25519 seed: the same seed the engine signs with,
/// imported through `polymorph:webcrypto` to build the iroh identity, so a
/// device's endpoint id and its subduction peer id are one key (internal.wit
/// `world runtime`).
pub trait Net {
    /// Bind the endpoint, answering its id (z-base-32, iroh's spelling) and
    /// the handle that dials and accepts on it.
    fn bind(&self, seed: [u8; 32]) -> LocalFuture<'_, Result<Bound, String>>;

    /// How a raw Ed25519 public key is spelled as an endpoint id.
    ///
    /// Pure, and deliberately not on [`NetHandle`]: the group's members are
    /// recorded by key (that is what the subduction handshake proves and what
    /// the policy checks), while everything a person sees or dials is the id.
    /// A device that has not bound — or whose bind failed — still has a group
    /// to show, so the spelling cannot depend on an endpoint being up.
    ///
    /// The spelling itself belongs to the endpoint component, which is why
    /// this is a seam at all and not a function in the kernel.
    fn endpoint_id(&self, key: [u8; 32]) -> String;
}

/// A bound endpoint: its id, and the handle that dials and accepts on it.
pub type Bound = (String, Box<dyn NetHandle>);

/// An accepted connection: the endpoint id that opened it, that id's raw
/// Ed25519 public key, the ALPN it negotiated, and its transport.
///
/// The key travels with the id for the same reason it does in [`Dialed`] —
/// the z-base-32 spelling belongs to the endpoint component — and the kernel
/// needs it here to check that the peer subduction authenticates is the one
/// the endpoint id named (see `Kernel::sync_connect`'s inbound twin).
///
/// The ALPN travels with it because one endpoint now serves two wires
/// ([`SUBDUCTION_ALPN`] and [`PAIRING_ALPN`]) and the accept loop is what
/// routes between them.
pub type Accepted = (String, [u8; 32], String, Box<dyn EngineTransport>);

/// A dialed connection: the peer's raw Ed25519 public key, and its transport.
///
/// The key comes back with the connection because an iroh endpoint id *is*
/// that key, in iroh's z-base-32 spelling — and that spelling belongs to the
/// endpoint component, not to the kernel. The engine needs the key because
/// subduction requires an outbound connection to name who it believes it is
/// dialing (subduction_protocol/src/conn_machine.rs:96); an inbound one
/// learns its peer from the handshake, which is why [`NetHandle::accept`]
/// answers only an endpoint id.
pub type Dialed = ([u8; 32], Box<dyn EngineTransport>);

/// A bound endpoint. Arguments are owned so the returned future borrows only
/// the handle.
pub trait NetHandle {
    /// Dial `endpoint_id` on `alpn` and open the connection's stream.
    fn connect(&self, endpoint_id: String, alpn: String)
    -> LocalFuture<'_, Result<Dialed, String>>;

    /// The next inbound connection, with the endpoint id that opened it and
    /// the ALPN it negotiated.
    fn accept(&self) -> LocalFuture<'_, Result<Accepted, String>>;
}

/// HTTP. One method, because the store needs every verb and every status:
/// the Drive client reads 401 to decide to refresh and 404 to decide a name
/// is absent (`crate::drive`), so a seam that collapsed status into `Err`
/// could not carry it.
///
/// `Err` is a *transport* failure — nothing was answered — and carries a
/// framework-voice reason the kernel passes on unread. A status the caller
/// dislikes is an answer, not an error.
pub trait Fetch {
    fn request(
        &self,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalFuture<'_, Result<HttpResponse, String>>;

    /// The app registry's read (`crate::apps`): a GET whose non-2xx answer is
    /// the same nothing as a failed one. Provided in terms of
    /// [`Fetch::request`] so there is one implementation to write.
    fn get(&self, url: String) -> LocalFuture<'_, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let response = self
                .request("GET".to_string(), url.clone(), Vec::new(), Vec::new())
                .await?;
            if !(200..300).contains(&response.status) {
                return Err(format!("{url}: the host answered {}", response.status));
            }
            Ok(response.body)
        })
    }
}

/// Cryptographic randomness (`wasi:random/random`). Synchronous: the WIT
/// function is a plain `func`, and the component's bindings follow their own
/// WIT declaration (no blanket `async:` option), so nothing here suspends.
pub trait Rng {
    fn fill(&self, dest: &mut [u8]);
}

/// Everything the kernel reaches the world through, in one bundle so `boot`
/// keeps one parameter as the set grows.
pub struct Seams {
    pub platform: Box<dyn Platform>,
    pub files: Box<dyn Files>,
    pub locks: Box<dyn Locks>,
    /// `Rc` rather than `Box`: the engine's clock adapter outlives the call
    /// that builds it and is held by the driver task.
    pub clock: Rc<dyn Clock>,
    pub fetch: Box<dyn Fetch>,
    pub rng: Box<dyn Rng>,
    pub spawn: Rc<dyn Spawn>,
    pub net: Box<dyn Net>,
}

/// Mirrors `polyvisor:internal/types.error-code` one for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnknownApp,
    UnknownSession,
    Unavailable,
    Refused,
    NotFound,
    Failed,
}

/// Mirrors `polyvisor:internal/types.error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Error {
            code,
            message: message.into(),
        }
    }
}

/// `polyvisor:internal/lifecycle.boot-config`.
pub struct BootConfig {
    /// Absolute URL, no trailing slash.
    pub home_origin: String,
    /// The device this worker is. The glue owns the id because the worker is
    /// named after it (docs/design.md "Devices"); everything else is here.
    pub device: String,
    /// This page's URL without query or fragment: the OAuth redirect
    /// (internal.wit `lifecycle.boot-config.page-url`). The kernel never sees
    /// a window, so it cannot know its own page; the glue does, and the
    /// exchange needs the same redirect the authorization carried.
    pub page_url: String,
    /// Drive's API and OAuth bases; `None` is Google's
    /// ([`drive::DRIVE_API`], [`drive::DRIVE_AUTH`]/[`drive::DRIVE_TOKEN`]).
    /// An override is one base with `/auth` and `/token` under it; the e2e
    /// harness points both at its fake.
    pub drive_api: Option<String>,
    pub drive_oauth: Option<String>,
}

pub type SessionId = u32;

/// The device half of the kernel's state, in one cell so a mutation and its
/// checkpoint see one consistent picture.
struct DeviceState {
    row: IndexRow,
    /// `Some` exactly while the device is open: the unwrapped data key lives
    /// in worker memory only.
    dek: Option<Dek>,
    /// `Some` exactly while the device is sealed: the record a passphrase is
    /// tried against.
    wrapped: Option<WrappedDek>,
    /// `None` exactly while the device is sealed. Nothing personal is
    /// readable — or renderable — before the seal opens (internal.wit
    /// `device`), so it is not in memory either.
    device: Option<Device>,
    /// The device's Ed25519 seed: its subduction identity and, imported
    /// through `polymorph:webcrypto`, its iroh identity (docs/design.md
    /// "Sync engine", the `Signer` row: "a seed held in the sealed
    /// checkpoint"). Zero while sealed, like everything else personal.
    seed: [u8; 32],
    /// The engine state the checkpoint carried, until the engine is built
    /// from it — [`Kernel::start_sync`] takes it. Keeping a copy afterwards
    /// would be keeping a stale one: from that moment the engine is the only
    /// authority on its own state.
    engine_state: Option<polyvisor_engine::Snapshot>,
    /// The store binding the checkpoint carried, until [`Kernel::boot`] takes
    /// it. Like `engine_state`, keeping a copy afterwards would be keeping a
    /// stale one.
    storage: Option<drive::Sealed>,
    /// The pointed generation in `kv`; the next checkpoint is this + 1,
    /// whether or not it was the one that loaded (see `checkpoint`).
    generation: u64,
    /// Terminal after `erase`.
    erased: bool,
}

pub struct Kernel {
    seams: Seams,
    home_origin: String,
    id: String,
    /// This kernel, weakly, so a `&self` method can hand a spawned task a
    /// handle. Set once, immediately after the `Rc` exists (see
    /// [`Kernel::boot`]); the store's sync is scheduled from
    /// [`Kernel::checkpoint`], which has only `&self`.
    me: RefCell<Weak<Kernel>>,
    /// The OAuth redirect and the two Drive bases, from `boot-config`.
    drive_config: drive::Config,
    state: RefCell<DeviceState>,
    registry: Registry,
    /// Live sessions, session id -> app id.
    sessions: RefCell<BTreeMap<SessionId, String>>,
    /// Monotonic; ids are never reused within a runtime instance
    /// (internal.wit `types.session-id`).
    next_session: RefCell<SessionId>,
    events: Events,
    /// `Some` exactly while the device is open: the engine holds the tasks.
    engine: RefCell<Option<Rc<SyncEngine>>>,
    /// The bound endpoint, and what `sync.connect` dials through. `None`
    /// while sealed, and while the endpoint has not come up.
    endpoint: RefCell<Option<Rc<dyn NetHandle>>>,
    /// This device's endpoint id; `""` until the endpoint is bound
    /// (internal.wit `device.device-status.endpoint-id`).
    endpoint_id: RefCell<String>,
    /// Why the endpoint did not bind, once it is known to have failed.
    /// `None` both before the bind finishes and after it succeeds — the two
    /// are told apart by [`Kernel::endpoint`] being `Some`.
    bind_error: RefCell<Option<String>>,
    /// What `sync.peers` reports, in the order peers were first seen.
    peers: RefCell<Vec<sync::PeerRecord>>,
    /// The pairing ceremony, when one is running (internal.wit `pairing`).
    pairing: RefCell<pairing::Pairing>,
    /// Serialises checkpoints — see [`Kernel::checkpoint`].
    checkpointing: RefCell<Checkpointing>,
    /// The durable store: tokens, the pending consent ceremony, and how the
    /// last sync went (internal.wit `storage`).
    drive: RefCell<drive::Drive>,
    /// The store sync's gate. The checkpoint gate's twin, and for the same
    /// reason: one push/pull in flight, and a request made during one is
    /// coalesced into a single further pass.
    syncing: RefCell<Checkpointing>,
}

/// The checkpoint gate: at most one writer, and one bit of "someone asked
/// again while I was writing".
#[derive(Default)]
struct Checkpointing {
    running: bool,
    dirty: bool,
}

impl Kernel {
    /// Sweep, then bring this device up, then build the app registry from the
    /// home origin. All three must succeed for the runtime to be usable, so
    /// this is the constructor rather than a method on a half-built kernel.
    pub async fn boot(config: BootConfig, seams: Seams) -> Result<Rc<Kernel>, Error> {
        let home_origin = config.home_origin.trim_end_matches('/').to_string();
        let id = config.device;
        let now = seams.clock.now_ms();

        // Before anything of ours is on disk: another device's abandoned
        // namespace is storage we are about to compete for.
        store::sweep(
            seams.platform.as_ref(),
            seams.files.as_ref(),
            seams.locks.as_ref(),
            &id,
            now,
        )
        .await?;

        let mut state = match seams.platform.get(store::index_key(&id)).await {
            None => mint(&seams, &id, now).await?,
            Some(bytes) => resume(&seams, &id, IndexRow::decode(&bytes)?, now).await?,
        };
        // The lease, refreshed at boot. (`mint` wrote a row stamped `now`
        // already; writing it again is one redundant `kv.set` on first boot
        // and one code path for the invariant.)
        seams
            .platform
            .set(store::index_key(&id), state.row.encode()?)
            .await;

        let registry = Registry::fetch(seams.fetch.as_ref(), &home_origin).await?;
        let drive = drive::Drive::restore(state.storage.take());
        let kernel = Rc::new(Kernel {
            seams,
            home_origin,
            id,
            me: RefCell::new(Weak::new()),
            drive_config: drive::Config {
                page_url: config.page_url,
                api: config.drive_api,
                oauth: config.drive_oauth,
            },
            state: RefCell::new(state),
            registry,
            sessions: RefCell::new(BTreeMap::new()),
            next_session: RefCell::new(1),
            events: Events::default(),
            engine: RefCell::new(None),
            endpoint: RefCell::new(None),
            endpoint_id: RefCell::new(String::new()),
            bind_error: RefCell::new(None),
            peers: RefCell::new(Vec::new()),
            pairing: RefCell::new(pairing::Pairing::default()),
            checkpointing: RefCell::new(Checkpointing::default()),
            drive: RefCell::new(drive),
            syncing: RefCell::new(Checkpointing::default()),
        });
        *kernel.me.borrow_mut() = Rc::downgrade(&kernel);
        // A sealed device has no seed in memory, so it has no engine and no
        // endpoint until `unseal` (internal.wit `device`).
        if kernel.state() != State::Sealed {
            kernel.start_sync();
            // At boot, after `open`: a device that was off while its group
            // wrote catches up without anyone asking (internal.wit
            // `storage.sync-now`). Bound or not is the schedule's question.
            kernel.schedule_store_sync();
        }
        Ok(kernel)
    }

    // -- state gates ---------------------------------------------------------

    /// The state as `device.status` reports it.
    ///
    /// `fresh` and `open` are two tiers, not two degrees of readiness:
    /// `sealed` while a passphrase device is locked, `fresh` while the device
    /// has not been kept, `open` once it has. internal.wit `device`: "`fresh`
    /// is not a gate: an ephemeral device is fully usable" — which is why
    /// [`Kernel::open`] passes it.
    fn state(&self) -> State {
        let state = self.state.borrow();
        if state.erased {
            return State::Erased;
        }
        if state.dek.is_none() {
            return State::Sealed;
        }
        match state.row.tier {
            Tier::Ephemeral => State::Fresh,
            Tier::Durable => State::Open,
        }
    }

    /// The gate every export but `device.status`, `store.devices` and
    /// `device.erase` passes through: internal.wit `device` — "every other
    /// kernel call is `unavailable` until `unseal`". `fresh` passes: it is a
    /// tier, not a lock.
    fn open(&self) -> Result<(), Error> {
        match self.state() {
            State::Fresh | State::Open => Ok(()),
            State::Sealed => Err(Error::new(
                ErrorCode::Unavailable,
                "this device is sealed; unseal it first",
            )),
            State::Erased => Err(erased()),
        }
    }

    /// `status` and `devices` still refuse an erased device: there is nothing
    /// left to describe.
    fn not_erased(&self) -> Result<(), Error> {
        if self.state.borrow().erased {
            return Err(erased());
        }
        Ok(())
    }

    // -- device --------------------------------------------------------------

    /// Works in every state but erased. While sealed the personal fields are
    /// empty and the hue is zero — not blanked on the way out, but genuinely
    /// not in memory (see [`DeviceState::device`]).
    pub fn device_status(&self) -> Result<DeviceStatus, Error> {
        self.not_erased()?;
        let state = self.state();
        let endpoint_id = self.endpoint_id();
        let inner = self.state.borrow();
        let device = inner.device.clone();
        Ok(DeviceStatus {
            id: inner.row.id.clone(),
            state,
            tier: inner.row.tier,
            rest: inner.row.rest,
            petname: inner.row.petname.clone(),
            name: device.as_ref().map(|d| d.name.clone()).unwrap_or_default(),
            hue: device.as_ref().map(|d| d.hue).unwrap_or(0),
            word: device.map(|d| d.word).unwrap_or_default(),
            endpoint_id,
        })
    }

    pub async fn set_name(&self, name: String) -> Result<(), Error> {
        self.open()?;
        self.with_device(|d| {
            d.name = name;
            Ok(())
        })?;
        self.checkpoint().await
    }

    pub async fn set_hue(&self, hue: u16) -> Result<(), Error> {
        self.open()?;
        self.with_device(|d| {
            if hue >= 360 {
                return Err(Error::new(
                    ErrorCode::Refused,
                    format!("hue must be below 360 degrees; got {hue}"),
                ));
            }
            d.hue = hue;
            Ok(())
        })?;
        self.checkpoint().await
    }

    /// internal.wit `device.meta`: an unknown app id answers an empty map
    /// rather than an error — the visor asks before it knows whether the app
    /// has ever set anything.
    pub fn meta(&self, scope: MetaScope) -> Result<BTreeMap<String, String>, Error> {
        self.open()?;
        let state = self.state.borrow();
        let device = state.device.as_ref().expect("open implies a device");
        Ok(match scope {
            MetaScope::User => device.meta.user.clone(),
            MetaScope::Device => device.meta.device.clone(),
            MetaScope::App(id) => device.meta.app.get(&id).cloned().unwrap_or_default(),
        })
    }

    /// internal.wit `device.set-meta`: replaces the whole map for `scope`.
    /// An empty map for an app scope removes that app's entry rather than
    /// leaving an empty one behind.
    pub async fn set_meta(
        &self,
        scope: MetaScope,
        meta: BTreeMap<String, String>,
    ) -> Result<(), Error> {
        self.open()?;
        self.with_device(|d| {
            match scope {
                MetaScope::User => d.meta.user = meta,
                MetaScope::Device => d.meta.device = meta,
                MetaScope::App(id) => {
                    if meta.is_empty() {
                        d.meta.app.remove(&id);
                    } else {
                        d.meta.app.insert(id, meta);
                    }
                }
            }
            Ok(())
        })?;
        self.checkpoint().await
    }

    pub async fn reroll_word(&self) -> Result<String, Error> {
        self.open()?;
        let word = {
            let state = self.state.borrow();
            let device = state.device.as_ref().expect("open implies a device");
            device.reroll(self.seams.rng.as_ref())
        };
        self.with_device(|d| {
            d.word = word.clone();
            Ok(())
        })?;
        self.checkpoint().await?;
        Ok(word)
    }

    /// "Keep this device": promote to durable and fix how it rests.
    ///
    /// `passphrase = none` is `rests-open` — the data key stays in the
    /// namespace and the visor says exactly what that protects against.
    /// A passphrase wraps the key under Argon2id; the key itself stays in
    /// worker memory, so the device does not become sealed until it is next
    /// booted.
    pub async fn keep(&self, petname: String, passphrase: Option<String>) -> Result<(), Error> {
        self.open()?;
        let (tier, rest) = {
            let state = self.state.borrow();
            (state.row.tier, state.row.rest)
        };
        if tier == Tier::Durable {
            // internal.wit `device.keep`: "Idempotent on the petname;
            // changing the rest of a kept device is `refused` (reseal is a
            // later milestone)." The only call that changes no rest is one
            // asking for `rests-open` on a device that already rests open.
            if !(rest == Rest::RestsOpen && passphrase.is_none()) {
                return Err(Error::new(
                    ErrorCode::Refused,
                    "this device is already kept; how it rests cannot be changed yet",
                ));
            }
            self.state.borrow_mut().row.petname = petname;
            return self.checkpoint().await;
        }

        let dek = self
            .state
            .borrow()
            .dek
            .clone()
            .expect("open implies a data key");
        let rest = if passphrase.is_some() {
            Rest::Passphrase
        } else {
            Rest::RestsOpen
        };

        // Order matters, and the order is: wrapped key, then row, then delete
        // the unwrapped key. Every prefix of it is a device that still opens.
        // Writing the row first would leave a crash window in which the row
        // says `passphrase` and no wrapped key exists — a device sealed
        // against nothing, unrecoverable. Deleting the unwrapped key before
        // the row would leave a device the row calls `rests-open` whose key
        // is gone, which `resume` refuses to boot.
        if let Some(passphrase) = &passphrase {
            let wrapped = WrappedDek::wrap(self.seams.rng.as_ref(), &dek, passphrase, &self.id)?;
            self.seams
                .platform
                .set(self.dek_wrapped_key(), wrapped.encode()?)
                .await;
        }

        let row = {
            let mut state = self.state.borrow_mut();
            state.row.petname = petname;
            state.row.tier = Tier::Durable;
            state.row.rest = rest;
            state.row.encode()?
        };
        self.seams
            .platform
            .set(store::index_key(&self.id), row)
            .await;

        if rest == Rest::Passphrase {
            // Last. A crash before this leaves a device whose row already
            // says `passphrase`; `resume` finds the stale unwrapped key and
            // deletes it there, which is the same end state.
            self.seams.platform.delete(self.dek_key()).await;
        }

        self.checkpoint().await
    }

    /// The login. A wrong passphrase is `refused` and the device stays
    /// sealed; there is no counter and no lockout, because the cost of a
    /// guess is the Argon2id derivation itself.
    pub async fn unseal(self: &Rc<Self>, passphrase: String) -> Result<(), Error> {
        self.not_erased()?;
        if self.state() != State::Sealed {
            return Err(Error::new(
                ErrorCode::Refused,
                "this device is already open",
            ));
        }
        let wrapped = self
            .state
            .borrow()
            .wrapped
            .clone()
            .expect("sealed implies a wrapped key");
        let dek = wrapped.unwrap_with(&passphrase, &self.id).map_err(|_| {
            Error::new(
                ErrorCode::Refused,
                "the passphrase did not open this device",
            )
        })?;
        let (generation, snapshot) = checkpoint::load(
            self.seams.files.as_ref(),
            self.seams.platform.as_ref(),
            &dek,
            &self.id,
        )
        .await?;
        // A device that rests under a passphrase is durable by construction,
        // so `open_or_mint` refuses a missing state rather than inventing an
        // anchor: unsealing into a blank device would be indistinguishable
        // from unsealing into the right one.
        let (restored, generation) = open_or_mint(
            &self.seams,
            &self.id,
            &dek,
            Tier::Durable,
            generation,
            snapshot,
        )
        .await?;
        {
            let mut state = self.state.borrow_mut();
            state.seed = restored.seed;
            state.engine_state = restored.engine;
            *self.drive.borrow_mut() = drive::Drive::restore(restored.storage);
            state.device = Some(restored.device);
            state.generation = generation;
            state.dek = Some(dek);
            state.wrapped = None;
        }
        self.start_sync();
        // The boot trigger's other half: a device that rested under a
        // passphrase has been off, and unsealing is the moment it can catch
        // up with what its group wrote meanwhile (`Kernel::boot` does the
        // same for a device that opens without one).
        self.schedule_store_sync();
        self.touch_lease().await
    }

    /// Destroy this device: its namespace, its small records and its index
    /// row. Terminal — every later call answers `unavailable`, and the visor
    /// switches away (`shell.switch-device`).
    pub async fn erase(&self) -> Result<(), Error> {
        // Allowed while sealed: internal.wit `device` — "except `erase`,
        // which needs no key (a forgotten passphrase must not make a device
        // un-erasable)". Nothing here reads the DEK; the namespace is removed
        // by name and the row by key.
        self.not_erased()?;
        store::destroy(
            self.seams.platform.as_ref(),
            self.seams.files.as_ref(),
            &self.id,
        )
        .await;
        let mut state = self.state.borrow_mut();
        state.erased = true;
        state.dek = None;
        state.wrapped = None;
        state.device = None;
        state.seed = [0u8; 32];
        state.engine_state = None;
        drop(state);
        *self.drive.borrow_mut() = drive::Drive::default();
        // The engine and the endpoint go with the device: a torn-down device
        // must not keep syncing what it no longer has.
        let _engine = self.engine.borrow_mut().take();
        let _endpoint = self.endpoint.borrow_mut().take();
        self.endpoint_id.borrow_mut().clear();
        *self.bind_error.borrow_mut() = None;
        self.peers.borrow_mut().clear();
        *self.pairing.borrow_mut() = pairing::Pairing::default();
        Ok(())
    }

    // -- store ---------------------------------------------------------------

    /// Every device on this origin, for the entry picker. Readable while
    /// sealed on purpose: docs/design.md "Devices" — the index is "what a
    /// boot may show before any seal opens".
    pub async fn devices(&self) -> Result<Vec<IndexRow>, Error> {
        self.not_erased()?;
        store::rows(self.seams.platform.as_ref()).await
    }

    // -- checkpoint ----------------------------------------------------------

    /// Apply a change to the device record. Synchronous and separate from the
    /// checkpoint: a `RefCell` borrow held across a suspension point would be
    /// visible to any re-entrant call the host makes while the write is in
    /// flight.
    fn with_device(
        &self,
        change: impl FnOnce(&mut Device) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut state = self.state.borrow_mut();
        let device = state.device.as_mut().expect("open implies a device");
        change(device)
    }

    /// Seal the whole of the kernel's serializable state into a new
    /// generation, then refresh the lease.
    ///
    /// **At most one checkpoint is ever in flight, and requests made during
    /// one are coalesced into a single further write.** Since the engine
    /// landed there are two callers — the export path after a local mutation,
    /// and the engine's event pump after a remote change — and they are not
    /// ordered with respect to each other. Two overlapping writers would be
    /// wrong twice over: the OPFS host refuses concurrent access handles
    /// outright ("too many calls are being made on file resources"), and even
    /// if it did not, two runs of `checkpoint::write` racing would advance
    /// `dev/<id>/gen` out of order and could leave the pointer naming the
    /// *older* of two generations.
    ///
    /// A caller that arrives mid-write is told `Ok` and its data is written
    /// by the running loop, not by it. That is not a lie: the kernel's
    /// in-memory state is authoritative and is what every iteration
    /// serializes, so the loop's next pass carries the coalesced caller's
    /// change — it simply is not the one that wrote it. Only the caller that
    /// *started* the loop learns of a write failure, which is the caller that
    /// can still refuse to claim the mutation landed.
    async fn checkpoint(&self) -> Result<(), Error> {
        {
            let mut gate = self.checkpointing.borrow_mut();
            if gate.running {
                gate.dirty = true;
                return Ok(());
            }
            gate.running = true;
        }
        let result = self.checkpoint_loop().await;
        // Unconditionally, including on the error path: a gate left latched
        // would silently stop every later checkpoint.
        *self.checkpointing.borrow_mut() = Checkpointing::default();
        // The store's trigger, chained off this gate rather than off each
        // mutation site: every local change already ends here, and so does
        // every remote one (the engine's pump checkpoints). One place to
        // schedule from, and it is behind the same coalescing the writes are.
        //
        // Only on a write that landed: a checkpoint that failed did not
        // change what is on disk, and pushing state the device could not
        // record itself would put the store ahead of its own author.
        if result.is_ok() {
            self.schedule_store_sync();
        }
        result
    }

    /// Write until nobody has asked again. `dirty` is cleared *before* the
    /// write, so a request that arrives while it is in flight is seen.
    async fn checkpoint_loop(&self) -> Result<(), Error> {
        loop {
            // An erased device has no data key and nothing left to seal. The
            // pump can still be running — its engine outlives `erase` by a
            // turn — and a checkpoint here would panic reaching for the key.
            if self.state.borrow().erased {
                return Ok(());
            }
            self.checkpointing.borrow_mut().dirty = false;
            self.write_checkpoint().await?;
            if !self.checkpointing.borrow().dirty {
                return Ok(());
            }
        }
    }

    /// One generation, sealed and committed, then the lease.
    async fn write_checkpoint(&self) -> Result<(), Error> {
        // Taken before the state borrow: `Engine::snapshot` borrows the
        // engine's own cells, and nothing may hold two of ours at once. It is
        // also async since M3c (it carries the device's keyhive), so the
        // engine handle is cloned out and the borrow released before awaiting.
        let engine = self.engine.borrow().clone();
        let engine = match engine {
            Some(engine) => Some(
                engine
                    .snapshot()
                    .await
                    .map_err(|why| Error::new(ErrorCode::Failed, why))?,
            ),
            None => None,
        };
        let (dek, generation, snapshot) = {
            let state = self.state.borrow();
            let dek = state.dek.clone().expect("open implies a data key");
            let device = state.device.clone().expect("open implies a device");
            (
                dek,
                state.generation + 1,
                checkpoint::Snapshot::new(device, state.seed, engine, self.drive.borrow().sealed()),
            )
        };
        checkpoint::write(
            self.seams.files.as_ref(),
            self.seams.platform.as_ref(),
            self.seams.rng.as_ref(),
            &dek,
            &self.id,
            generation,
            &snapshot,
        )
        .await?;
        self.state.borrow_mut().generation = generation;
        self.touch_lease().await
    }

    /// Stamp the index row with the current time. The lease rides on
    /// mutations and on boot, which is all the sweep needs — see
    /// [`LEASE_TTL_MS`].
    async fn touch_lease(&self) -> Result<(), Error> {
        let bytes = {
            let mut state = self.state.borrow_mut();
            state.row.last_used = self.seams.clock.now_ms();
            state.row.encode()?
        };
        self.seams
            .platform
            .set(store::index_key(&self.id), bytes)
            .await;
        Ok(())
    }

    fn dek_key(&self) -> String {
        format!("{}dek", store::dev_prefix(&self.id))
    }

    fn dek_wrapped_key(&self) -> String {
        format!("{}dek-wrapped", store::dev_prefix(&self.id))
    }

    // -- apps ----------------------------------------------------------------

    pub fn installed(&self) -> Result<Vec<AppInfo>, Error> {
        self.open()?;
        Ok(self.registry.installed())
    }

    pub fn launch(&self, app: &str) -> Result<SessionId, Error> {
        self.open()?;
        if !self.registry.contains(app) {
            return Err(Error::new(
                ErrorCode::UnknownApp,
                format!("no app named {app} is installed"),
            ));
        }
        let mut next = self.next_session.borrow_mut();
        let session = *next;
        *next += 1;
        self.sessions.borrow_mut().insert(session, app.to_string());
        Ok(session)
    }

    pub fn session_app(&self, session: SessionId) -> Result<AppInfo, Error> {
        self.open()?;
        let app = self.session_app_id(session)?;
        self.registry.info(&app).ok_or_else(|| {
            Error::new(
                ErrorCode::UnknownApp,
                format!("session {session} names an app that is no longer installed"),
            )
        })
    }

    pub async fn component(&self, session: SessionId) -> Result<ComponentArtifacts, Error> {
        self.open()?;
        let app = self.session_app_id(session)?;
        self.registry
            .component(self.seams.fetch.as_ref(), &self.home_origin, &app)
            .await
    }

    pub fn assets(&self, session: SessionId) -> Result<Vec<AssetInfo>, Error> {
        self.open()?;
        let app = self.session_app_id(session)?;
        self.registry.assets(&app)
    }

    pub async fn asset(&self, session: SessionId, handle: &[u8]) -> Result<Vec<u8>, Error> {
        self.open()?;
        let app = self.session_app_id(session)?;
        self.registry
            .asset(self.seams.fetch.as_ref(), &self.home_origin, &app, handle)
            .await
    }

    /// Idempotent per internal.wit: closing an already-closed session is not
    /// an error. No event either — `session-ended` reports the endings the
    /// visor did not ask for, and this one it did.
    pub fn close(&self, session: SessionId) {
        self.sessions.borrow_mut().remove(&session);
    }

    /// The glue reports a session that died on its own (internal.wit
    /// `apps.abort`): end it and announce it, so every visor learns of it
    /// through the one event path. `reason` is framework voice, composed by
    /// the glue. Idempotent, and an unknown session is a no-op — an abort
    /// racing a `close` must not manufacture an ending that already
    /// happened.
    pub fn abort(&self, session: SessionId, reason: String) {
        if self.sessions.borrow_mut().remove(&session).is_none() {
            return;
        }
        self.push_event(Event::SessionEnded(session, reason));
    }

    fn session_app_id(&self, session: SessionId) -> Result<String, Error> {
        self.sessions
            .borrow()
            .get(&session)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::UnknownSession,
                    format!("session {session} is not live"),
                )
            })
    }

    // -- app services --------------------------------------------------------

    pub async fn tasks_revision(&self, session: SessionId) -> Result<u64, String> {
        let (app, engine) = self.app_engine(session)?;
        engine.tasks_revision(&app).await
    }

    pub async fn tasks_items(&self, session: SessionId) -> Result<Snapshot, String> {
        let (app, engine) = self.app_engine(session)?;
        engine.tasks_items(&app).await
    }

    pub async fn tasks_add(&self, session: SessionId, title: String) -> Result<String, String> {
        let (app, engine) = self.app_engine(session)?;
        let id = engine.tasks_add(&app, title).await?;
        self.checkpoint_service().await?;
        Ok(id)
    }

    pub async fn tasks_set_completed(
        &self,
        session: SessionId,
        id: &str,
        completed: bool,
    ) -> Result<(), String> {
        let (app, engine) = self.app_engine(session)?;
        engine.tasks_set_completed(&app, id, completed).await?;
        self.checkpoint_service().await
    }

    pub async fn tasks_set_title(
        &self,
        session: SessionId,
        id: &str,
        title: String,
    ) -> Result<(), String> {
        let (app, engine) = self.app_engine(session)?;
        engine.tasks_set_title(&app, id, title).await?;
        self.checkpoint_service().await
    }

    pub async fn tasks_remove(&self, session: SessionId, id: &str) -> Result<(), String> {
        let (app, engine) = self.app_engine(session)?;
        engine.tasks_remove(&app, id).await?;
        self.checkpoint_service().await
    }

    /// The gate every `app-services` call passes: the device is open, the
    /// session is live, and the engine is running. One list per app id, so
    /// every session of an app sees the same document.
    fn app_engine(&self, session: SessionId) -> Result<(String, Rc<SyncEngine>), String> {
        // `app-services` answers `result<_, string>`: an app never learns the
        // device's state beyond "this did not work".
        self.open().map_err(|e| e.message)?;
        // The session id comes from the port the call arrived on, never from
        // the app (internal.wit header), so an unknown one is a glue bug or a
        // race with `close`, not an app error worth naming further.
        let app = self
            .session_app_id(session)
            .map_err(|_| "unknown session".to_string())?;
        let engine = self.engine().map_err(|e| e.message)?;
        Ok((app, engine))
    }

    async fn checkpoint_service(&self) -> Result<(), String> {
        self.checkpoint().await.map_err(|e| e.message)
    }

    // -- events --------------------------------------------------------------

    /// The next queued event, parking while there is none (internal.wit
    /// `events.next`). One waiter: the worker glue runs a single pump over
    /// the runtime's export (see [`events`]).
    pub async fn next_event(&self) -> Event {
        self.events.next().await
    }

    /// The other half of [`Kernel::abort`]: an ending the visor did not ask
    /// for goes on the queue the worker glue long-polls, which is the whole
    /// of internal.wit's `events` contract.
    pub fn push_event(&self, event: Event) {
        self.events.push(event);
    }
}

/// A device the index has never heard of: mint its anchor and its data key,
/// write both, record the row, and checkpoint at once.
///
/// The checkpoint is not deferred to the first mutation, because the anchor
/// is *drawn* rather than derived (see [`Device::mint`]): an ephemeral device
/// that was booted and reloaded without being touched would otherwise come
/// back a different colour with a different word, which is the one thing the
/// anchor may not do. Ephemeral and resting open, because that is what "not
/// yet kept" means.
async fn mint(seams: &Seams, id: &str, now: u64) -> Result<DeviceState, Error> {
    let dek = Dek::mint(seams.rng.as_ref());
    seams
        .platform
        .set(format!("{}dek", store::dev_prefix(id)), dek.0.to_vec())
        .await;
    let row = IndexRow::fresh(id, now);
    seams
        .platform
        .set(store::index_key(id), row.encode()?)
        .await;

    let (snapshot, generation) = mint_anchor(seams, id, &dek).await;

    Ok(DeviceState {
        row,
        dek: Some(dek),
        wrapped: None,
        device: Some(snapshot.device),
        seed: snapshot.seed,
        engine_state: snapshot.engine,
        storage: snapshot.storage,
        generation,
        erased: false,
    })
}

/// Draw an anchor and commit it as generation 1, returning the generation
/// that actually landed. A failure here is not fatal — the device is usable
/// and its anchor is in memory — but it leaves the pointer at 0, which is
/// what makes the *next* boot's re-mint legal (see [`open_or_mint`]).
///
/// Outside [`Kernel::checkpoint`]'s gate, and safe to be: this runs inside
/// `boot`, before the `Kernel` exists at all. There is no engine, no event
/// pump and no export the glue could have dispatched, so there is nothing for
/// it to overlap with — the gate would be a lock with one possible holder.
async fn mint_anchor(seams: &Seams, id: &str, dek: &Dek) -> (checkpoint::Snapshot, u64) {
    let device = Device::mint(seams.rng.as_ref());
    // The device's signing seed, drawn with the anchor and, like it, never
    // drawn again once a checkpoint carries it: it is the identity every peer
    // knows this device by.
    let mut seed = [0u8; 32];
    seams.rng.fill(&mut seed);
    let snapshot = checkpoint::Snapshot::new(device, seed, None, None);
    let committed = checkpoint::write(
        seams.files.as_ref(),
        seams.platform.as_ref(),
        seams.rng.as_ref(),
        dek,
        id,
        1,
        &snapshot,
    )
    .await
    .is_ok();
    (snapshot, if committed { 1 } else { 0 })
}

/// A device the index knows. How it rests decides whether this boot can read
/// anything of it at all.
async fn resume(seams: &Seams, id: &str, row: IndexRow, now: u64) -> Result<DeviceState, Error> {
    let mut row = row;
    row.last_used = now;
    match row.rest {
        Rest::Passphrase => {
            let bytes = seams
                .platform
                .get(format!("{}dek-wrapped", store::dev_prefix(id)))
                .await
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::Failed,
                        "this device rests under a passphrase but its wrapped key is missing",
                    )
                })?;
            // The tail of `keep`: a crash between writing the row and
            // deleting the unwrapped key leaves both keys in `kv`, and the
            // unwrapped one opens the device without the passphrase. Finish
            // the job here, before anything else can read it.
            let stale = format!("{}dek", store::dev_prefix(id));
            if seams.platform.get(stale.clone()).await.is_some() {
                seams.platform.delete(stale).await;
            }
            Ok(DeviceState {
                row,
                dek: None,
                wrapped: Some(WrappedDek::decode(&bytes)?),
                device: None,
                seed: [0u8; 32],
                engine_state: None,
                storage: None,
                generation: 0,
                erased: false,
            })
        }
        Rest::RestsOpen => {
            let bytes = seams
                .platform
                .get(format!("{}dek", store::dev_prefix(id)))
                .await
                .ok_or_else(|| {
                    Error::new(ErrorCode::Failed, "this device's data key is missing")
                })?;
            let dek = Dek::decode(&bytes)?;
            let (generation, snapshot) =
                checkpoint::load(seams.files.as_ref(), seams.platform.as_ref(), &dek, id).await?;
            let (snapshot, generation) =
                open_or_mint(seams, id, &dek, row.tier, generation, snapshot).await?;
            Ok(DeviceState {
                row,
                dek: Some(dek),
                wrapped: None,
                device: Some(snapshot.device),
                seed: snapshot.seed,
                engine_state: snapshot.engine,
                storage: snapshot.storage,
                generation,
                erased: false,
            })
        }
    }
}

/// What to do when no generation verified.
///
/// For a durable device: nothing. It was kept, so it has been checkpointed,
/// so a missing state is storage loss — and silently handing the user a blank
/// device with a new colour would look exactly like the device they kept,
/// which is worse than refusing to boot.
///
/// For an ephemeral device the one legal case is a mint whose first
/// checkpoint failed (see [`mint`]), which the pointer still sitting at 0
/// identifies exactly: there is nothing to lose, so draw again and commit
/// this time. The anchor differs from the one the failed boot showed, which
/// is the cost of the draw not having landed.
async fn open_or_mint(
    seams: &Seams,
    id: &str,
    dek: &Dek,
    tier: Tier,
    generation: u64,
    snapshot: Option<checkpoint::Snapshot>,
) -> Result<(checkpoint::Snapshot, u64), Error> {
    match snapshot {
        Some(snapshot) => Ok((snapshot, generation)),
        None if tier == Tier::Ephemeral && generation == 0 => Ok(mint_anchor(seams, id, dek).await),
        None => Err(Error::new(
            ErrorCode::Failed,
            "this device's state did not open",
        )),
    }
}

fn erased() -> Error {
    Error::new(ErrorCode::Unavailable, "this device has been erased")
}
