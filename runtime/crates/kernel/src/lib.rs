//! The polyvisor kernel: everything the runtime component does, with no WIT
//! and no wasm dependency. The component crate (`runtime/component`) is a
//! thin adapter that implements [`Platform`], [`Fetch`] and [`Rng`] over its
//! generated bindings and forwards each exported call here.
//!
//! Single-threaded by construction (the runtime lives in one SharedWorker),
//! so nothing here is `Send`: the trait futures are boxed without a `Send`
//! bound and shared state is `RefCell`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

mod apps;
mod device;
mod events;
mod tasks;

pub use apps::{AppInfo, AssetInfo, ComponentArtifacts};
pub use device::DeviceStatus;
pub use events::Event;

use apps::Registry;
use device::Device;
use events::Events;
use tasks::TaskList;

/// A future that borrows its owner and is never sent between threads.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The unsealed key/value store (`polyvisor:internal/kv`). Arguments are
/// owned so the returned future borrows only the store.
pub trait Platform {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>>;
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()>;
}

/// HTTP GET. `Err` carries a framework-voice reason (transport failure or a
/// non-2xx status); the kernel never inspects it beyond passing it on.
pub trait Fetch {
    fn get(&self, url: String) -> LocalFuture<'_, Result<Vec<u8>, String>>;
}

/// Cryptographic randomness (`wasi:random/random`). Synchronous: the WIT
/// function is a plain `func`, and the component's bindings follow their own
/// WIT declaration (no blanket `async:` option), so nothing here suspends.
pub trait Rng {
    fn fill(&self, dest: &mut [u8]);
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
}

pub type SessionId = u32;

pub struct Kernel {
    platform: Box<dyn Platform>,
    fetch: Box<dyn Fetch>,
    rng: Box<dyn Rng>,
    home_origin: String,
    device: RefCell<Device>,
    registry: Registry,
    /// Live sessions, session id -> app id.
    sessions: RefCell<BTreeMap<SessionId, String>>,
    /// Monotonic; ids are never reused within a runtime instance
    /// (internal.wit `types.session-id`).
    next_session: RefCell<SessionId>,
    /// One task list per app id: every session of an app shares it.
    tasks: RefCell<BTreeMap<String, TaskList>>,
    events: Events,
}

impl Kernel {
    /// Load or mint the device identity, then build the app registry from
    /// the home origin. Both must succeed for the runtime to be usable, so
    /// this is the constructor rather than a method on a half-built kernel.
    pub async fn boot(
        config: BootConfig,
        platform: Box<dyn Platform>,
        fetch: Box<dyn Fetch>,
        rng: Box<dyn Rng>,
    ) -> Result<Kernel, Error> {
        let home_origin = config.home_origin.trim_end_matches('/').to_string();
        let device = Device::load_or_mint(platform.as_ref(), rng.as_ref()).await?;
        let registry = Registry::fetch(fetch.as_ref(), &home_origin).await?;
        Ok(Kernel {
            platform,
            fetch,
            rng,
            home_origin,
            device: RefCell::new(device),
            registry,
            sessions: RefCell::new(BTreeMap::new()),
            next_session: RefCell::new(1),
            tasks: RefCell::new(BTreeMap::new()),
            events: Events::default(),
        })
    }

    // -- device ------------------------------------------------------------

    pub fn device_status(&self) -> DeviceStatus {
        self.device.borrow().status()
    }

    pub async fn set_name(&self, name: String) -> Result<(), Error> {
        self.mutate_device(|d| {
            d.name = name;
            Ok(())
        })
        .await
    }

    pub async fn set_hue(&self, hue: u16) -> Result<(), Error> {
        self.mutate_device(|d| {
            if hue >= 360 {
                return Err(Error::new(
                    ErrorCode::Refused,
                    format!("hue must be below 360 degrees; got {hue}"),
                ));
            }
            d.hue = hue;
            Ok(())
        })
        .await
    }

    pub async fn reroll_word(&self) -> Result<String, Error> {
        let word = device::reroll(&self.device, self.rng.as_ref());
        self.mutate_device(|d| {
            d.word = word.clone();
            Ok(())
        })
        .await?;
        Ok(word)
    }

    /// Apply a change and persist. The borrow is dropped before the await:
    /// a `RefCell` borrow held across a suspension point would be visible to
    /// any re-entrant call the host makes while the write is in flight.
    async fn mutate_device(
        &self,
        change: impl FnOnce(&mut Device) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let bytes = {
            let mut device = self.device.borrow_mut();
            change(&mut device)?;
            device.encode()?
        };
        self.platform.set(device::KV_KEY.to_string(), bytes).await;
        Ok(())
    }

    // -- apps --------------------------------------------------------------

    pub fn installed(&self) -> Vec<AppInfo> {
        self.registry.installed()
    }

    pub fn launch(&self, app: &str) -> Result<SessionId, Error> {
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
        let app = self.session_app_id(session)?;
        self.registry.info(&app).ok_or_else(|| {
            Error::new(
                ErrorCode::UnknownApp,
                format!("session {session} names an app that is no longer installed"),
            )
        })
    }

    pub async fn component(&self, session: SessionId) -> Result<ComponentArtifacts, Error> {
        let app = self.session_app_id(session)?;
        self.registry
            .component(self.fetch.as_ref(), &self.home_origin, &app)
            .await
    }

    pub fn assets(&self, session: SessionId) -> Result<Vec<AssetInfo>, Error> {
        let app = self.session_app_id(session)?;
        self.registry.assets(&app)
    }

    pub async fn asset(&self, session: SessionId, handle: &[u8]) -> Result<Vec<u8>, Error> {
        let app = self.session_app_id(session)?;
        self.registry
            .asset(self.fetch.as_ref(), &self.home_origin, &app, handle)
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

    // -- app services ------------------------------------------------------

    pub fn tasks_revision(&self, session: SessionId) -> Result<u64, String> {
        self.with_tasks(session, |list| Ok(list.revision))
    }

    pub fn tasks_items(&self, session: SessionId) -> Result<Snapshot, String> {
        self.with_tasks(session, |list| Ok(list.snapshot()))
    }

    pub fn tasks_add(&self, session: SessionId, title: String) -> Result<String, String> {
        self.with_tasks(session, |list| Ok(list.add(title)))
    }

    pub fn tasks_set_completed(
        &self,
        session: SessionId,
        id: &str,
        completed: bool,
    ) -> Result<(), String> {
        self.with_tasks(session, |list| list.set_completed(id, completed))
    }

    pub fn tasks_set_title(
        &self,
        session: SessionId,
        id: &str,
        title: String,
    ) -> Result<(), String> {
        self.with_tasks(session, |list| list.set_title(id, title))
    }

    pub fn tasks_remove(&self, session: SessionId, id: &str) -> Result<(), String> {
        self.with_tasks(session, |list| list.remove(id))
    }

    fn with_tasks<T>(
        &self,
        session: SessionId,
        f: impl FnOnce(&mut TaskList) -> Result<T, String>,
    ) -> Result<T, String> {
        // The session id comes from the port the call arrived on, never from
        // the app (internal.wit header), so an unknown one is a glue bug or a
        // race with `close`, not an app error worth naming further.
        let app = self
            .session_app_id(session)
            .map_err(|_| "unknown session".to_string())?;
        let mut tasks = self.tasks.borrow_mut();
        f(tasks.entry(app).or_default())
    }

    // -- events ------------------------------------------------------------

    /// Parks until an event exists.
    pub fn next_event(&self) -> impl Future<Output = Event> + '_ {
        self.events.next()
    }

    /// The other half of [`Kernel::abort`]: an ending the visor did not ask
    /// for goes on the queue the worker glue long-polls, which is the whole
    /// of internal.wit's `events` contract.
    pub fn push_event(&self, event: Event) {
        self.events.push(event);
    }
}

pub use tasks::{Snapshot, TodoItem};
