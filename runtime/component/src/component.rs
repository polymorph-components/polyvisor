use std::cell::RefCell;
use std::rc::Rc;

use futures::future::LocalBoxFuture;
use polyvisor_kernel::{
    BootConfig, Clock, Fetch, Files, HttpResponse, Kernel, LocalFuture, Locks, Platform, Rng,
    Seams, Spawn,
};

use crate::net::IrohNet;

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
// `features`: `polymorph:iroh/identity-from-seed` is
// `@unstable(feature = guest-ed25519-signing)` (iroh.wit), and `world
// runtime` imports it. Unstable items are invisible to the resolver unless
// their feature is named, so without this the world fails to resolve
// (wit-bindgen-rust-macro 0.60 lib.rs:205 — the listed features are pushed
// into `Resolve::features`). The endpoint component is built with the
// matching cargo feature; justfile `endpoint`.
wit_bindgen::generate!({
    path: "../wit",
    world: "runtime",
    features: ["guest-ed25519-signing"],
    generate_all,
});

use exports::polyvisor::internal as guest;
use polyvisor::internal::types::{Error, ErrorCode};
use polyvisor::internal::{kv, locks};
use wasi::filesystem::preopens;
use wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};

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
    /// The sync driver's deadlines (`Clock::sleep`) come off the MONOTONIC
    /// clock, not the one `now_ms` reads: a duration measured against a
    /// clock that can be stepped backwards is a deadline that can be armed
    /// for never.
    fn sleep(&self, ms: u64) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            wasi::clocks0_3_1::monotonic_clock::wait_for(ms.saturating_mul(1_000_000)).await;
        })
    }

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

/// Where the kernel's long-lived futures run: the sync driver, the accept
/// loop and each connection's read loop.
///
/// wit-bindgen's `spawn_local` puts the future on the component's own task
/// set, so it is polled by the same async ABI machinery that resumes an
/// export's activation — no second executor, and no host call outstanding
/// that the host would have to keep alive.
struct WitSpawn;

impl Spawn for WitSpawn {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        wit_bindgen::rt::async_support::spawn_local(future);
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
    fn request(
        &self,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalFuture<'_, Result<HttpResponse, String>> {
        Box::pin(async move { http_request(method, url, headers, body).await })
    }
}

/// `wasi:http/client@0.3.1`, as the kernel's one HTTP seam
/// (`polyvisor_kernel::Fetch`).
///
/// `Err` is reserved for "nothing was answered": a URL this host will not
/// send, a transmission that failed. Every status the host DID answer with
/// comes back as an `HttpResponse` — the store reads 401 to decide to
/// refresh and 404 to decide a name is absent, so collapsing a status into
/// an error here would take the decision away from the only code that can
/// make it.
async fn http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<HttpResponse, String> {
    use wasi::http::types::{Fields, Method, Request, Response, Scheme};

    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("{url} is not an absolute URL"))?;
    let scheme = match scheme {
        "https" => Scheme::Https,
        "http" => Scheme::Http,
        other => Scheme::Other(other.to_string()),
    };
    // The path AND the query: `set-path-with-query` takes them together,
    // and the store's every read is a query (`files.list`'s `q`, `alt=media`).
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority.to_string(), format!("/{path}")),
        None => (rest.to_string(), "/".to_string()),
    };

    // Field VALUES are bytes in the 0.3 track, not strings: a header value
    // is not required to be UTF-8. Everything this kernel sends is, so the
    // conversion is one-way and lossless here.
    let fields: Vec<(String, Vec<u8>)> = headers
        .into_iter()
        .map(|(name, value)| (name, value.into_bytes()))
        .collect();
    let headers = Fields::from_list(&fields)
        .map_err(|e| format!("{url}: these request headers were refused: {e:?}"))?;

    // The request's trailers future is completed with the empty answer its
    // writer defaults to when dropped: nothing here sends trailers.
    let (trailers_tx, trailers) = wit_future::new(|| Ok(None));
    drop(trailers_tx);

    // A body is a STREAM the host reads while the request is in flight, so
    // the writer cannot be filled before `send` is running — the write parks
    // until the host reads, and awaiting it first would deadlock. An empty
    // body is `none`, which is the contract's own spelling for a zero-length
    // content stream rather than an empty stream nobody closes.
    let (writer, contents) = if body.is_empty() {
        (None, None)
    } else {
        let (writer, reader) = wit_stream::new();
        (Some(writer), Some(reader))
    };
    let (request, transmit) = Request::new(headers, contents, trailers, None);
    let method = match method.as_str() {
        "GET" => Method::Get,
        "HEAD" => Method::Head,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "PATCH" => Method::Patch,
        other => Method::Other(other.to_string()),
    };
    request
        .set_method(&method)
        .map_err(|()| format!("{url}: this host will not send that method"))?;
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

    // Sent and filled together, for the reason above. `join` rather than two
    // awaits: whichever the host wants first, it gets.
    let send = wasi::http::client::send(request);
    let fill = async move {
        match writer {
            None => Vec::new(),
            Some(mut writer) => {
                let unwritten = writer.write_all(body).await;
                // The host sees the end of the body when the writer goes.
                drop(writer);
                unwritten
            }
        }
    };
    let (response, unwritten) = futures::join!(send, fill);
    let response: Response = response.map_err(|e| format!("{url}: {e}"))?;
    if !unwritten.is_empty() {
        return Err(format!(
            "{url}: the host stopped reading the request body with {} byte(s) left",
            unwritten.len()
        ));
    }

    // Both read before `consume-body`, which moves the response.
    let status = response.get_status_code();
    let headers = response
        .get_headers()
        // `copy-all`, not a borrow: the response's headers are immutable
        // and the kernel wants owned pairs.
        .copy_all()
        .into_iter()
        .map(|(name, value)| (name, String::from_utf8_lossy(&value).into_owned()))
        .collect();

    let (body_result_tx, body_result) = wit_future::new(|| Ok(()));
    drop(body_result_tx);
    let (body, _trailers) = Response::consume_body(response, body_result);
    Ok(HttpResponse {
        status,
        headers,
        body: body.collect().await,
    })
}

// -- the state root ------------------------------------------------------------

// `wasi:filesystem@0.3` over the OPFS root the glue preopens at `/`.
//
// Nothing here lists a directory. `read-directory` is one of the four
// stream-returning functions the 0.3 track left sync in WIT, and the OPFS
// host answers it with a Promise, which traps a worker that runs without
// JSPI (internal.wit `world runtime`). Every path below arrives named from
// the kernel, which keeps its generation pointer in `kv` for exactly this
// reason.
//
// The kernel's `Files` seam has no error channel either (see its docs): a
// read that fails is `None`, a write that fails is a generation the pointer
// never advances to, and a removal that fails is a path the next write
// overwrites.

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
    // internal.wit `world runtime`: "the glue preopens the origin's OPFS at
    // `/`". Only that name. Falling back to whatever came first would mean
    // writing a device's state into some other host's directory on the
    // strength of a guess; no preopen at `/` is a glue that has not held up
    // its end, and the honest answer is that there is no state root.
    let mut preopens = preopens::get_directories();
    let index = preopens.iter().position(|(_, path)| path == "/")?;
    let root = Rc::new(preopens.swap_remove(index).0);
    ROOT.with(|r| *r.borrow_mut() = Some(root.clone()));
    Some(root)
}

/// The kernel speaks absolute paths within the root; `open-at` and its
/// siblings speak relative ones.
fn relative(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

struct StateRoot;

impl Files for StateRoot {
    fn read(&self, path: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { read_file(&path).await })
    }
    fn write(&self, path: String, bytes: Vec<u8>) -> LocalFuture<'_, Result<(), ()>> {
        Box::pin(async move { write_file(&path, bytes).await })
    }
    fn remove_file(&self, path: String) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            if let Some(root) = root() {
                let _ = root.unlink_file_at(relative(&path)).await;
            }
        })
    }
    fn remove_dir(&self, path: String) -> LocalFuture<'_, ()> {
        Box::pin(async move {
            if let Some(root) = root() {
                let _ = root.remove_directory_at(relative(&path)).await;
            }
        })
    }
}

async fn read_file(path: &str) -> Option<Vec<u8>> {
    let root = root()?;
    let file = root
        .open_at(
            PathFlags::empty(),
            relative(path),
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

/// `Err(())` for anything that kept the whole buffer from reaching the file.
/// The kernel turns that into a checkpoint that does not advance its pointer,
/// so the distinction between "no root", "would not open" and "the stream
/// closed early" buys nothing downstream.
async fn write_file(path: &str, bytes: Vec<u8>) -> Result<(), ()> {
    let root = root().ok_or(())?;
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
        // `exist` is the normal answer on every write after the first, and a
        // real failure here surfaces as the `open-at` below failing.
        let _ = root.create_directory_at(prefix.clone()).await;
    }

    let file = root
        .open_at(
            PathFlags::empty(),
            path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE,
            DescriptorFlags::WRITE,
        )
        .await
        .map_err(|_| ())?;

    // `write-via-stream` is a sync function returning the completion future:
    // hand the host the readable end first, then fill it, then drop the
    // writer so the host sees the end of the data, then await the result.
    let (mut writer, reader) = wit_stream::new();
    let done = file.write_via_stream(reader, 0);
    let unwritten = writer.write_all(bytes).await;
    drop(writer);
    let completed = done.await.is_ok();
    // A non-empty remainder means the host closed the stream early: the file
    // now holds a prefix of what was asked for, which is precisely the torn
    // write the pointer must not advance over.
    if unwritten.is_empty() && completed {
        Ok(())
    } else {
        Err(())
    }
}

// -- exports -----------------------------------------------------------------

struct Component;

impl guest::lifecycle::Guest for Component {
    async fn boot(config: guest::lifecycle::BootConfig) -> Result<(), Error> {
        let kernel = Kernel::boot(
            BootConfig {
                home_origin: config.home_origin,
                device: config.device,
                // The redirect the storage ceremony comes back to, and the
                // two bases the e2e harness points at its fake: all three
                // are the glue's knowledge, not the kernel's
                // (internal.wit `lifecycle.boot-config`).
                page_url: config.page_url,
                drive_api: config.drive_api,
                drive_oauth: config.drive_oauth,
            },
            Seams {
                platform: Box::new(Kv),
                files: Box::new(StateRoot),
                locks: Box::new(WebLocks),
                clock: Rc::new(SystemClock),
                fetch: Box::new(Http),
                rng: Box::new(Random),
                spawn: Rc::new(WitSpawn),
                // `boot-config.relay` stops here: the kernel asks for an
                // endpoint, not for a relay, and the only things that need
                // the URL are the bind and the dial addresses.
                net: Box::new(IrohNet::new(config.relay)),
            },
        )
        .await
        .map_err(map_error)?;
        KERNEL.with(|k| *k.borrow_mut() = Some(kernel));
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
        let kernel = kernel()?;
        if !matches!(
            kernel.device_status().map_err(map_error)?.state,
            polyvisor_kernel::State::Sealed
        ) {
            kernel
                .initialize_personalization()
                .await
                .map_err(map_error)?;
        }
        let status = kernel.device_status().map_err(map_error)?;
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
            endpoint_id: status.endpoint_id,
        })
    }
    async fn set_name(name: String) -> Result<(), Error> {
        kernel()?.set_name(name).await.map_err(map_error)
    }
    async fn set_hue(hue: u16) -> Result<(), Error> {
        kernel()?.set_hue(hue).await.map_err(map_error)
    }
    async fn meta(scope: guest::device::MetaScope) -> Result<Vec<(String, String)>, Error> {
        let scope = match scope {
            guest::device::MetaScope::User => polyvisor_kernel::MetaScope::User,
            guest::device::MetaScope::App(id) => polyvisor_kernel::MetaScope::App(id),
        };
        Ok(kernel()?
            .meta(scope)
            .map_err(map_error)?
            .into_iter()
            .collect())
    }
    async fn patch_meta(
        scope: guest::device::MetaScope,
        fields: Vec<(String, Option<String>)>,
    ) -> Result<(), Error> {
        let scope = match scope {
            guest::device::MetaScope::User => polyvisor_kernel::MetaScope::User,
            guest::device::MetaScope::App(id) => polyvisor_kernel::MetaScope::App(id),
        };
        kernel()?.patch_meta(scope, fields).await.map_err(map_error)
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

impl guest::sync::Guest for Component {
    async fn connect(endpoint_id: String) -> Result<(), Error> {
        kernel()?.sync_connect(endpoint_id).await.map_err(map_error)
    }
    async fn peers() -> Result<Vec<guest::sync::Peer>, Error> {
        Ok(kernel()?
            .sync_peers()
            .map_err(map_error)?
            .into_iter()
            .map(|p| guest::sync::Peer {
                endpoint_id: p.endpoint_id,
                state: p.state,
            })
            .collect())
    }
    async fn members() -> Result<Vec<guest::sync::Member>, Error> {
        Ok(kernel()?
            .sync_members()
            .await
            .map_err(map_error)?
            .into_iter()
            .map(|m| guest::sync::Member {
                endpoint_id: m.endpoint_id,
                petname: m.petname,
                enrolled: m.enrolled,
                me: m.me,
            })
            .collect())
    }
}

/// The kernel's ceremony phase as the WIT spells it. One arm per case and
/// no default: a phase the kernel grows must be given words here rather
/// than quietly rendered as some neighbouring state.
fn phase(p: polyvisor_kernel::Phase) -> polyvisor::internal::types::Phase {
    use polyvisor::internal::types::Phase as Wit;
    match p {
        polyvisor_kernel::Phase::Idle => Wit::Idle,
        polyvisor_kernel::Phase::Offering(code) => Wit::Offering(code),
        polyvisor_kernel::Phase::Claiming => Wit::Claiming,
        polyvisor_kernel::Phase::AwaitingConfirm(sas) => Wit::AwaitingConfirm(sas),
        polyvisor_kernel::Phase::AwaitingPeer => Wit::AwaitingPeer,
        polyvisor_kernel::Phase::Done => Wit::Done,
        polyvisor_kernel::Phase::Failed(why) => Wit::Failed(why),
    }
}

impl guest::pairing::Guest for Component {
    async fn offer() -> Result<String, Error> {
        kernel()?.pairing_offer().await.map_err(map_error)
    }
    async fn claim(code: String) -> Result<(), Error> {
        kernel()?.pairing_claim(code).await.map_err(map_error)
    }
    async fn confirm() -> Result<(), Error> {
        kernel()?.pairing_confirm().map_err(map_error)
    }
    async fn cancel() -> Result<(), Error> {
        kernel()?.pairing_cancel().await.map_err(map_error)
    }
    async fn status() -> Result<polyvisor::internal::types::Phase, Error> {
        kernel()?.pairing_status().map(phase).map_err(map_error)
    }
}

impl guest::storage::Guest for Component {
    async fn status() -> Result<guest::storage::Binding, Error> {
        let binding = kernel()?.storage_status().map_err(map_error)?;
        Ok(guest::storage::Binding {
            provider: binding.provider,
            state: binding.state,
            last_pull: binding.last_pull,
            last_push: binding.last_push,
        })
    }
    async fn oauth_start(client: guest::storage::OauthClient) -> Result<String, Error> {
        kernel()?
            .oauth_start(client.client_id, client.client_secret)
            .map_err(map_error)
    }
    async fn oauth_complete(code: String, state: String) -> Result<(), Error> {
        kernel()?
            .oauth_complete(code, state)
            .await
            .map_err(map_error)
    }
    async fn disconnect() -> Result<(), Error> {
        kernel()?.storage_disconnect().await.map_err(map_error)
    }
    async fn sync_now() -> Result<(), Error> {
        kernel()?.sync_now().await.map_err(map_error)
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
        kernel()?.launch(&app).await.map_err(map_error)
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
    async fn route_encode(session: u32, route: String) -> Result<String, Error> {
        kernel()?
            .route_encode(session, route)
            .await
            .map_err(map_error)
    }
    async fn route_decode(fragment: String) -> Result<guest::apps::RouteTarget, Error> {
        let (app, route) = kernel()?.route_decode(fragment).await.map_err(map_error)?;
        Ok(guest::apps::RouteTarget {
            app: app_info(app),
            route,
        })
    }
    async fn install_fragment(app: String) -> Result<String, Error> {
        kernel()?.install_fragment(&app).map_err(map_error)
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
        // Before boot there is no queue and nothing can be pushed onto one,
        // and `next` has no error channel: parking is the honest answer.
        // The worker starts its pump only after `lifecycle.boot` returns
        // anyway, so nothing waits here in practice.
        let Ok(kernel) = kernel() else {
            return std::future::pending().await;
        };
        match kernel.next_event().await {
            polyvisor_kernel::Event::SessionEnded(session, why) => {
                guest::events::Event::SessionEnded((session, why))
            }
            polyvisor_kernel::Event::PairingChanged(p) => {
                guest::events::Event::PairingChanged(phase(p))
            }
            polyvisor_kernel::Event::PersonalizationChanged => {
                guest::events::Event::PersonalizationChanged
            }
        }
    }
}

fn unavailable_service() -> String {
    "the runtime has not booted".to_string()
}

impl guest::app_services::Guest for Component {
    async fn tasks_items(session: u32) -> Result<guest::app_services::Snapshot, String> {
        let snapshot = kernel()
            .map_err(|_| unavailable_service())?
            .tasks_items(session)
            .await?;
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
    async fn tasks_watch(
        session: u32,
        after: u64,
    ) -> Result<guest::app_services::Snapshot, String> {
        let snapshot = kernel()
            .map_err(|_| unavailable_service())?
            .tasks_watch(session, after)
            .await?;
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
