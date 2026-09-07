use std::cell::RefCell;
use std::rc::Rc;

use polyvisor_kernel::{
    BootConfig, Clock, Fetch, Files, Kernel, LocalFuture, Locks, Platform, Rng, Seams,
};

// No `async:` option on purpose. With it, wit-bindgen applies one blanket
// mode to every function; `async: true` then lowers WIT-sync functions (the
// `wasi:http/types` resource constructors and accessors, `wasi:random`'s
// getters) with the async canonical option, which the canonical ABI forbids
// on a non-async function type. `wasm-tools validate` does not catch it;
// wasmtime and polyengine's translator do. Omitting the option makes each
// function follow its own WIT declaration (wit-bindgen-core
// async_.rs:26 — "If a method is not listed in this option then the WIT's
// default bindings mode will be used"), which is exactly the contract:
// everything in `polyvisor:internal` is `async func`, as is
// `wasi:http/client.send`, and nothing else here is.
wit_bindgen::generate!({
    path: "../wit",
    world: "runtime",
    generate_all,
});

use exports::polyvisor::internal as guest;
use polyvisor::internal::types::{Error, ErrorCode};
use polyvisor::internal::{kv, locks};
use wasi::filesystem::preopens;
use wasi::filesystem::types::{Descriptor, DescriptorFlags, DescriptorType, OpenFlags, PathFlags};

thread_local! {
    /// `Rc` so a call can take a handle and await without holding the cell
    /// borrowed across a suspension point.
    static KERNEL: RefCell<Option<Rc<Kernel>>> = const { RefCell::new(None) };
}

fn kernel() -> Result<Rc<Kernel>, Error> {
    KERNEL.with(|k| k.borrow().clone()).ok_or_else(|| Error {
        code: ErrorCode::Unavailable,
        message: "the runtime has not booted".into(),
    })
}

fn map_error(e: polyvisor_kernel::Error) -> Error {
    Error {
        code: match e.code {
            polyvisor_kernel::ErrorCode::UnknownApp => ErrorCode::UnknownApp,
            polyvisor_kernel::ErrorCode::UnknownSession => ErrorCode::UnknownSession,
            polyvisor_kernel::ErrorCode::Unavailable => ErrorCode::Unavailable,
            polyvisor_kernel::ErrorCode::Refused => ErrorCode::Refused,
            polyvisor_kernel::ErrorCode::NotFound => ErrorCode::NotFound,
            polyvisor_kernel::ErrorCode::Failed => ErrorCode::Failed,
        },
        message: e.message,
    }
}

// -- seams -------------------------------------------------------------------

struct Kv;

impl Platform for Kv {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { kv::get(key).await })
    }
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()> {
        Box::pin(async move { kv::set(key, value).await })
    }
    fn delete(&self, key: String) -> LocalFuture<'_, ()> {
        Box::pin(async move { kv::delete(key).await })
    }
    fn keys(&self, prefix: String) -> LocalFuture<'_, Vec<String>> {
        Box::pin(async move { kv::keys(prefix).await })
    }
}

struct WebLocks;

impl Locks for WebLocks {
    fn is_held(&self, name: String) -> LocalFuture<'_, bool> {
        Box::pin(async move { locks::is_held(name).await })
    }
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        // Two `wasi:clocks` versions are in `wit/deps`, so the generated
        // module carries the version in its name.
        let now = wasi::clocks0_3_1::system_clock::now();
        // Before the epoch is not a time this kernel has an opinion about;
        // the lease arithmetic saturates anyway.
        let seconds = now.seconds.max(0) as u64;
        seconds * 1_000 + u64::from(now.nanoseconds) / 1_000_000
    }
}

struct Random;

impl Rng for Random {
    fn fill(&self, dest: &mut [u8]) {
        // wasi:random permits short reads, so accumulate until full.
        let mut filled = 0;
        while filled < dest.len() {
            let chunk = wasi::random::random::get_random_bytes((dest.len() - filled) as u64);
            dest[filled..filled + chunk.len()].copy_from_slice(&chunk);
            filled += chunk.len();
        }
    }
}

struct Http;

impl Fetch for Http {
    fn get(&self, url: String) -> LocalFuture<'_, Result<Vec<u8>, String>> {
        Box::pin(async move { http_get(&url).await })
    }
}

async fn http_get(url: &str) -> Result<Vec<u8>, String> {
    use wasi::http::types::{Method, Request, Response, Scheme};

    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("{url} is not an absolute URL"))?;
    let scheme = match scheme {
        "https" => Scheme::Https,
        "http" => Scheme::Http,
        other => Scheme::Other(other.to_string()),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority.to_string(), format!("/{path}")),
        None => (rest.to_string(), "/".to_string()),
    };

    // A GET has no body: the request's trailers future is completed with the
    // empty answer its writer defaults to when dropped.
    let (trailers_tx, trailers) = wit_future::new(|| Ok(None));
    drop(trailers_tx);
    let headers = wasi::http::types::Fields::new();
    let (request, transmit) = Request::new(headers, None, trailers, None);
    request
        .set_method(&Method::Get)
        .map_err(|()| "GET was refused as a method".to_string())?;
    request
        .set_scheme(Some(&scheme))
        .map_err(|()| format!("{url} has a scheme this host will not send"))?;
    request
        .set_authority(Some(&authority))
        .map_err(|()| format!("{url} has an authority this host will not send"))?;
    request
        .set_path_with_query(Some(&path))
        .map_err(|()| format!("{url} has a path this host will not send"))?;
    drop(transmit);

    let response: Response = wasi::http::client::send(request)
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let status = response.get_status_code();
    if !(200..300).contains(&status) {
        return Err(format!("{url}: the host answered {status}"));
    }

    let (body_result_tx, body_result) = wit_future::new(|| Ok(()));
    drop(body_result_tx);
    let (body, _trailers) = Response::consume_body(response, body_result);
    Ok(body.collect().await)
}

// -- the state root ------------------------------------------------------------

// `wasi:filesystem@0.3` over the OPFS root the glue preopens at `/`. The
// kernel's `Files` seam has no error channel on purpose (see its docs): a
// read that fails is `None`, a write that fails is a generation that will not
// verify, and the checkpoint loader already falls back.

thread_local! {
    /// The preopened root, looked up once. `get-directories` mints a fresh
    /// descriptor resource per call, so caching it is also what keeps the
    /// handle table from growing with every checkpoint.
    static ROOT: RefCell<Option<Rc<Descriptor>>> = const { RefCell::new(None) };
}

fn root() -> Option<Rc<Descriptor>> {
    if let Some(root) = ROOT.with(|r| r.borrow().clone()) {
        return Some(root);
    }
    // The glue preopens exactly one directory, the origin's OPFS, at `/`.
    // Prefer that name and fall back to the first preopen rather than
    // failing, so a host that spells its root differently still works.
    let mut preopens = preopens::get_directories();
    let index = preopens
        .iter()
        .position(|(_, path)| path == "/")
        .unwrap_or(0);
    if index >= preopens.len() {
        return None;
    }
    let root = Rc::new(preopens.swap_remove(index).0);
    ROOT.with(|r| *r.borrow_mut() = Some(root.clone()));
    Some(root)
}

/// The kernel speaks absolute paths within the root; `open-at` speaks
/// relative ones.
fn relative(path: &str) -> &str {
    path.trim_start_matches('/')
}

struct StateRoot;

impl Files for StateRoot {
    fn read(&self, path: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { read_file(&path).await })
    }
    fn write(&self, path: String, bytes: Vec<u8>) -> LocalFuture<'_, ()> {
        Box::pin(async move { write_file(&path, bytes).await })
    }
    fn remove_dir_all(&self, path: String) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            let Some(root) = root() else { return };
            remove_all(&root, relative(&path).to_string()).await;
        })
    }
    fn list(&self, dir: String) -> LocalFuture<'_, Vec<String>> {
        Box::pin(async move {
            let Some(root) = root() else {
                return Vec::new();
            };
            entries(&root, relative(&dir))
                .await
                .into_iter()
                .map(|(name, _)| name)
                .collect()
        })
    }
}

async fn read_file(path: &str) -> Option<Vec<u8>> {
    let root = root()?;
    let file = root
        .open_at(
            PathFlags::empty(),
            relative(path).to_string(),
            OpenFlags::empty(),
            DescriptorFlags::READ,
        )
        .await
        .ok()?;
    let (stream, result) = file.read_via_stream(0);
    let bytes = stream.collect().await;
    // The future is the error channel: a stream that ends early ends the same
    // way a complete one does, so a partial read is only visible here.
    result.await.ok()?;
    Some(bytes)
}

async fn write_file(path: &str, bytes: Vec<u8>) {
    let Some(root) = root() else { return };
    let path = relative(path);
    // `open-at` will not create the parents, and a checkpoint writes into a
    // generation directory that has never existed.
    let mut prefix = String::new();
    let mut components: Vec<&str> = path.split('/').collect();
    components.pop();
    for component in components {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        // `exist` is the normal answer on every write after the first.
        let _ = root.create_directory_at(prefix.clone()).await;
    }

    let Ok(file) = root
        .open_at(
            PathFlags::empty(),
            path.to_string(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE,
            DescriptorFlags::WRITE,
        )
        .await
    else {
        return;
    };

    // `write-via-stream` is a sync function returning the completion future:
    // hand the host the readable end first, then fill it, then drop the
    // writer so the host sees the end of the data, then await the result.
    let (mut writer, reader) = wit_stream::new();
    let done = file.write_via_stream(reader, 0);
    let unwritten = writer.write_all(bytes).await;
    drop(writer);
    let _ = done.await;
    debug_assert!(unwritten.is_empty(), "the host closed the stream early");
}

/// `(name, is_directory)` for everything directly under `dir`. Empty for a
/// directory that is not there, which is what the kernel's `list` promises.
async fn entries(root: &Descriptor, dir: &str) -> Vec<(String, bool)> {
    let Ok(handle) = root
        .open_at(
            PathFlags::empty(),
            dir.to_string(),
            OpenFlags::DIRECTORY,
            DescriptorFlags::READ,
        )
        .await
    else {
        return Vec::new();
    };
    let (stream, result) = handle.read_directory();
    let entries = stream.collect().await;
    if result.await.is_err() {
        return Vec::new();
    }
    entries
        .into_iter()
        .map(|entry| (entry.name, matches!(entry.type_, DescriptorType::Directory)))
        .collect()
}

/// Recursive removal: `wasi:filesystem` has no `rm -r`, only the two leaf
/// verbs, so the walk is ours. Boxed because it recurses.
fn remove_all<'a>(root: &'a Descriptor, dir: String) -> LocalFuture<'a, ()> {
    Box::pin(async move {
        for (name, is_dir) in entries(root, &dir).await {
            let child = format!("{dir}/{name}");
            if is_dir {
                remove_all(root, child).await;
            } else {
                let _ = root.unlink_file_at(child).await;
            }
        }
        let _ = root.remove_directory_at(dir).await;
    })
}

// -- exports -----------------------------------------------------------------

struct Component;

impl guest::lifecycle::Guest for Component {
    async fn boot(config: guest::lifecycle::BootConfig) -> Result<(), Error> {
        let kernel = Kernel::boot(
            BootConfig {
                home_origin: config.home_origin,
                device: config.device,
            },
            Seams {
                platform: Box::new(Kv),
                files: Box::new(StateRoot),
                locks: Box::new(WebLocks),
                clock: Box::new(SystemClock),
                fetch: Box::new(Http),
                rng: Box::new(Random),
            },
        )
        .await
        .map_err(map_error)?;
        KERNEL.with(|k| *k.borrow_mut() = Some(Rc::new(kernel)));
        Ok(())
    }
}

fn tier(tier: polyvisor_kernel::Tier) -> guest::device::Tier {
    match tier {
        polyvisor_kernel::Tier::Ephemeral => guest::device::Tier::Ephemeral,
        polyvisor_kernel::Tier::Durable => guest::device::Tier::Durable,
    }
}

fn rest(rest: polyvisor_kernel::Rest) -> guest::device::Rest {
    match rest {
        polyvisor_kernel::Rest::RestsOpen => guest::device::Rest::RestsOpen,
        polyvisor_kernel::Rest::Passphrase => guest::device::Rest::Passphrase,
    }
}

impl guest::device::Guest for Component {
    async fn status() -> Result<guest::device::DeviceStatus, Error> {
        let status = kernel()?.device_status().map_err(map_error)?;
        Ok(guest::device::DeviceStatus {
            id: status.id,
            // `erased` never reaches here: it answers `unavailable` above.
            state: match status.state {
                polyvisor_kernel::State::Fresh => guest::device::State::Fresh,
                polyvisor_kernel::State::Sealed => guest::device::State::Sealed,
                polyvisor_kernel::State::Open | polyvisor_kernel::State::Erased => {
                    guest::device::State::Open
                }
            },
            tier: tier(status.tier),
            rest: rest(status.rest),
            petname: status.petname,
            name: status.name,
            hue: status.hue,
            word: status.word,
        })
    }
    async fn set_name(name: String) -> Result<(), Error> {
        kernel()?.set_name(name).await.map_err(map_error)
    }
    async fn set_hue(hue: u16) -> Result<(), Error> {
        kernel()?.set_hue(hue).await.map_err(map_error)
    }
    async fn reroll_word() -> Result<String, Error> {
        kernel()?.reroll_word().await.map_err(map_error)
    }
    async fn keep(petname: String, passphrase: Option<String>) -> Result<(), Error> {
        kernel()?.keep(petname, passphrase).await.map_err(map_error)
    }
    async fn unseal(passphrase: String) -> Result<(), Error> {
        kernel()?.unseal(passphrase).await.map_err(map_error)
    }
    async fn erase() -> Result<(), Error> {
        kernel()?.erase().await.map_err(map_error)
    }
}

impl guest::store::Guest for Component {
    async fn devices() -> Result<Vec<guest::store::Entry>, Error> {
        let rows = kernel()?.devices().await.map_err(map_error)?;
        Ok(rows
            .into_iter()
            .map(|row| guest::store::Entry {
                id: row.id,
                petname: row.petname,
                tier: tier(row.tier),
                rest: rest(row.rest),
                created: row.created,
                last_used: row.last_used,
            })
            .collect())
    }
}

fn app_info(info: polyvisor_kernel::AppInfo) -> guest::apps::AppInfo {
    guest::apps::AppInfo {
        id: info.id,
        title: info.title,
    }
}

impl guest::apps::Guest for Component {
    async fn installed() -> Result<Vec<guest::apps::AppInfo>, Error> {
        Ok(kernel()?
            .installed()
            .map_err(map_error)?
            .into_iter()
            .map(app_info)
            .collect())
    }
    async fn launch(app: String) -> Result<u32, Error> {
        kernel()?.launch(&app).map_err(map_error)
    }
    async fn session_app(session: u32) -> Result<guest::apps::AppInfo, Error> {
        kernel()?
            .session_app(session)
            .map(app_info)
            .map_err(map_error)
    }
    async fn component(session: u32) -> Result<guest::apps::ComponentArtifacts, Error> {
        let artifacts = kernel()?.component(session).await.map_err(map_error)?;
        Ok(guest::apps::ComponentArtifacts {
            wasm: artifacts.wasm,
            plan: artifacts.plan,
        })
    }
    async fn assets(session: u32) -> Result<Vec<guest::apps::AssetInfo>, Error> {
        let assets = kernel()?.assets(session).map_err(map_error)?;
        Ok(assets
            .into_iter()
            .map(|a| guest::apps::AssetInfo {
                handle: a.handle,
                media_type: a.media_type,
            })
            .collect())
    }
    async fn asset(session: u32, handle: Vec<u8>) -> Result<Vec<u8>, Error> {
        kernel()?.asset(session, &handle).await.map_err(map_error)
    }
    async fn close(session: u32) -> Result<(), Error> {
        kernel()?.close(session);
        Ok(())
    }
    async fn abort(session: u32, reason: String) {
        // No error channel in the WIT: a report about a dead frame that the
        // kernel cannot act on (not booted, unknown session) is nothing the
        // glue could do anything with either.
        if let Ok(kernel) = kernel() {
            kernel.abort(session, reason);
        }
    }
}

impl guest::events::Guest for Component {
    async fn next() -> guest::events::Event {
        // `next` has no error channel, and its contract is to park while
        // there is nothing. Before boot there can never be anything, so
        // parking forever is the honest answer; the glue boots first.
        let Ok(kernel) = kernel() else {
            return std::future::pending().await;
        };
        match kernel.next_event().await {
            polyvisor_kernel::Event::SessionEnded(session, why) => {
                guest::events::Event::SessionEnded((session, why))
            }
        }
    }
}

fn unavailable_service() -> String {
    "the runtime has not booted".to_string()
}

impl guest::app_services::Guest for Component {
    async fn tasks_revision(session: u32) -> Result<u64, String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_revision(session)
    }
    async fn tasks_items(session: u32) -> Result<guest::app_services::Snapshot, String> {
        let snapshot = kernel()
            .map_err(|_| unavailable_service())?
            .tasks_items(session)?;
        Ok(guest::app_services::Snapshot {
            revision: snapshot.revision,
            items: snapshot
                .items
                .into_iter()
                .map(|i| polyvisor::app::tasks::TodoItem {
                    id: i.id,
                    title: i.title,
                    completed: i.completed,
                })
                .collect(),
        })
    }
    async fn tasks_add(session: u32, title: String) -> Result<String, String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_add(session, title)
            .await
    }
    async fn tasks_set_completed(session: u32, id: String, completed: bool) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_set_completed(session, &id, completed)
            .await
    }
    async fn tasks_set_title(session: u32, id: String, title: String) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_set_title(session, &id, title)
            .await
    }
    async fn tasks_remove(session: u32, id: String) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_remove(session, &id)
            .await
    }
}

export!(Component);
