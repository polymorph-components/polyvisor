use std::cell::RefCell;
use std::rc::Rc;

use polyvisor_kernel::{BootConfig, Fetch, Kernel, LocalFuture, Platform, Rng};

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
use polyvisor::internal::kv;
use polyvisor::internal::types::{Error, ErrorCode};

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

// -- exports -----------------------------------------------------------------

struct Component;

impl guest::lifecycle::Guest for Component {
    async fn boot(config: guest::lifecycle::BootConfig) -> Result<(), Error> {
        let kernel = Kernel::boot(
            BootConfig {
                home_origin: config.home_origin,
            },
            Box::new(Kv),
            Box::new(Http),
            Box::new(Random),
        )
        .await
        .map_err(map_error)?;
        KERNEL.with(|k| *k.borrow_mut() = Some(Rc::new(kernel)));
        Ok(())
    }
}

impl guest::device::Guest for Component {
    async fn status() -> Result<guest::device::DeviceStatus, Error> {
        let status = kernel()?.device_status();
        Ok(guest::device::DeviceStatus {
            id: status.id,
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
}

fn app_info(info: polyvisor_kernel::AppInfo) -> guest::apps::AppInfo {
    guest::apps::AppInfo {
        id: info.id,
        title: info.title,
    }
}

impl guest::apps::Guest for Component {
    async fn installed() -> Result<Vec<guest::apps::AppInfo>, Error> {
        Ok(kernel()?.installed().into_iter().map(app_info).collect())
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
    }
    async fn tasks_set_completed(session: u32, id: String, completed: bool) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_set_completed(session, &id, completed)
    }
    async fn tasks_set_title(session: u32, id: String, title: String) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_set_title(session, &id, title)
    }
    async fn tasks_remove(session: u32, id: String) -> Result<(), String> {
        kernel()
            .map_err(|_| unavailable_service())?
            .tasks_remove(session, &id)
    }
}

export!(Component);
