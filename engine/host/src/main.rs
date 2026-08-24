//! Engine host: three engine instances — Alice's laptop and phone
//! (device stand-in: both direct members) and Bob (collaborator) — over
//! iroh, exercising the tasks data service on the automerge change DAG.
//!
//! Asserts: creation → members (edit) → seal ordering; convergence of the
//! task list across all three; a genuine concurrency fork (laptop and
//! phone author from the same frontier) merged by a later change (a chunk
//! with two parents exists); collaborator edits propagate; revocation cuts
//! Bob off from new epochs while laptop and phone ride the rotation.

use std::path::{Path, PathBuf};
use std::time::Instant;

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{Accessor, Component, HasData, Linker, ResourceTable};
use wasmtime::error::Context as _;
use wasmtime::{bail, format_err, Config, Engine, Result, Store};
use wasmtime_wasi::{DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_webrtc_datachannels::{self as webrtc_host, WebrtcCtx, WebrtcCtxView, WebrtcView};
use wasmtime_websocket::{WasiWebsocketCtx, WasiWebsocketCtxView, WasiWebsocketView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../guest/wit",
        world: "engine",
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
        // The world names `polymorph:webcrypto` types now (the
        // `device-identity` import carries `signing-key`/`verifying-key`),
        // so those interfaces are remapped onto the bindings
        // `polymorph-webcrypto-wasmtime` already generated and already
        // links (`add_to_linker` below). Generating them a second time
        // here would mint distinct resource types and a second, unwired
        // host trait. `signature` is what `device-identity` uses; `types`
        // and `wrapping` are what `signature` uses.
        with: {
            "polymorph:webcrypto/signature": polymorph_webcrypto_wasmtime::bindings::webcrypto::signature,
            "polymorph:webcrypto/types": polymorph_webcrypto_wasmtime::bindings::webcrypto::types,
            "polymorph:webcrypto/wrapping": polymorph_webcrypto_wasmtime::bindings::webcrypto::wrapping,
        },
    });
}

mod pairing_acts;
mod resume_acts;

use bindings::exports::polyvisor::engine::driver::{Guest as Driver, S3Config, StoreConfig};
use bindings::polyvisor::engine::store_fetch_types::Response as FetchResponse;
use bindings::exports::polyvisor::tasks::tasks::{Guest as Tasks, TodoItem};

struct Ctx {
    wasi: WasiCtx,
    webcrypto: WasiWebcryptoCtx,
    websocket: WasiWebsocketCtx,
    webrtc: WebrtcCtx,
    http: wasmtime_wasi_http::WasiHttpCtx,
    egress: Egress,
    table: ResourceTable,
}

impl HasData for Ctx {
    type Data<'a> = &'a mut Self;
}

impl wasmtime_wasi_http::p3::WasiHttpView for Ctx {
    fn http(&mut self) -> wasmtime_wasi_http::p3::WasiHttpCtxView<'_> {
        wasmtime_wasi_http::p3::WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: wasmtime_wasi_http::p3::default_hooks(),
        }
    }
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiWebcryptoView for Ctx {
    fn webcrypto(&mut self) -> WasiWebcryptoCtxView<'_> {
        WasiWebcryptoCtxView {
            ctx: &mut self.webcrypto,
            table: &mut self.table,
        }
    }
}

impl WasiWebsocketView for Ctx {
    fn websocket(&mut self) -> WasiWebsocketCtxView<'_> {
        WasiWebsocketCtxView {
            ctx: &mut self.websocket,
            table: &mut self.table,
        }
    }
}

impl WebrtcView for Ctx {
    fn webrtc(&mut self) -> WebrtcCtxView<'_> {
        WebrtcCtxView {
            ctx: &mut self.webrtc,
            table: &mut self.table,
        }
    }
}


// --- storage egress: what the guest's three named imports are wired to ---
//
// The retrofit's host half (#7 "authority in the instance, selection by
// import name"; #11 escrowed signing credential). The guest builds
// requests and asks for signatures; the credential bytes live only here.
//
// HONEST LIMITATION OF THIS RIG: all six instances in the act share one
// `Store<Ctx>` and therefore one credential set. That is fine for a test
// rig — the acts exercise the SHAPE (which import a call site travels
// through, and what each seam will and will not do), not per-user
// authority. The browser host wires per-instance authority for real; the
// asymmetry is deliberate, not an oversight.

/// A scheme+host+port triple: the unit of "which network destination this
/// grant reaches". Compared structurally, never by string prefix — prefix
/// matching on URLs is how origin confinement is usually gotten wrong.
#[derive(Clone, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

impl Origin {
    fn parse(url: &str) -> Result<Self> {
        let u = reqwest::Url::parse(url).with_context(|| format!("parsing origin from {url}"))?;
        let host = u
            .host_str()
            .ok_or_else(|| format_err!("{url} has no host"))?
            .to_string();
        let port = u
            .port_or_known_default()
            .ok_or_else(|| format_err!("{url} has no port and no default for its scheme"))?;
        Ok(Origin { scheme: u.scheme().to_string(), host, port })
    }
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}://{}:{}", self.scheme, self.host, self.port)
    }
}

/// The rig's storage authority, held host-side.
#[derive(Clone)]
struct Egress {
    /// The one origin these grants reach (from `--endpoint`).
    granted: Origin,
    /// The escrowed SigV4 signing credential. It never leaves this
    /// struct: `store-signer` returns a signature, never key material.
    secret: std::sync::Arc<String>,
    http: reqwest::Client,
}

impl Egress {
    fn new(endpoint: &str, secret: String) -> Result<Self> {
        Ok(Egress {
            granted: Origin::parse(endpoint)?,
            secret: std::sync::Arc::new(secret),
            http: reqwest::Client::builder()
                .build()
                .context("building the egress HTTP client")?,
        })
    }
}

/// Which of the three egress seams a request arrived on. The host learns
/// this from WHICH IMPORT was called, never from the request — that is
/// the whole mechanism (#7).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tier {
    /// Acts as the user (SigV4 here; a bearer on Dropbox).
    Owner,
    /// Acts as the app, never as the user.
    Shared,
    /// Carries no identity at all.
    Public,
}

impl Tier {
    fn label(self) -> &'static str {
        match self {
            Tier::Owner => "owner-fetch",
            Tier::Shared => "shared-fetch",
            Tier::Public => "public-fetch",
        }
    }

    /// Only the owner tier may carry a guest-supplied authorization
    /// header (the SigV4 Authorization the guest assembled from a
    /// signature it was given). On the other two, whatever authority
    /// applies is the seam's to inject, so anything the guest set is
    /// dropped rather than forwarded.
    fn strips_authorization(self) -> bool {
        !matches!(self, Tier::Owner)
    }
}

/// The shared body of all three fetch seams. Origin confinement is
/// common; the tier decides authorization handling, and that decision is
/// made by which import was called, which is why the anonymity property
/// is structural rather than a convention.
async fn egress_request(
    eg: Egress,
    tier: Tier,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<FetchResponse, String> {
    let strip_authorization = tier.strips_authorization();
    let tier = tier.label();
    let target = Origin::parse(&url).map_err(|e| format!("{tier}: {e}"))?;
    if target != eg.granted {
        // Destination confinement, checked before anything is sent: a
        // grant names an origin, and a request outside it is refused
        // rather than sent unauthenticated.
        return Err(format!("{tier}: origin not granted: {target}"));
    }
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("{tier}: bad method {method}: {e}"))?;
    let mut req = eg.http.request(m, &url);
    for (name, value) in headers {
        if strip_authorization && name.eq_ignore_ascii_case("authorization") {
            // Boundary hygiene: a component-supplied authorization header
            // is dropped, not forwarded. Whether anything replaces it is
            // the seam's business (app-auth on the shared tier; nothing
            // at all on the public tier), never the guest's.
            continue;
        }
        req = req.header(name, value);
    }
    let resp = req
        .body(body)
        .send()
        .await
        // Transport failures come back as an error string, which is what
        // the guest's 3-attempt retry loop is looking for.
        .map_err(|e| format!("{tier}: send: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("{tier}: body: {e}"))?;
    Ok(FetchResponse { status, body: bytes.to_vec() })
}

impl bindings::store_owner_fetch::Host for Ctx {}
impl bindings::store_shared_fetch::Host for Ctx {}
impl bindings::store_public_fetch::Host for Ctx {}
impl bindings::store_signer::Host for Ctx {}
impl bindings::polyvisor::engine::store_fetch_types::Host for Ctx {}

impl bindings::store_owner_fetch::HostWithStore<Ctx> for Ctx {
    async fn request(
        accessor: &Accessor<Ctx, Self>,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Result<FetchResponse, String>> {
        let eg = accessor.with(|mut a| a.get().egress.clone());
        Ok(egress_request(eg, Tier::Owner, method, url, headers, body).await)
    }
}

/// The app tier. In THIS RIG it behaves exactly like the public seam:
/// origin-confined, guest-supplied authorization stripped, nothing
/// injected. That is not the tier's definition — a host wiring a real
/// Dropbox grant injects the app key/secret here, which is what makes
/// shared-link fetches work at all. The act rig exercises S3 only, where
/// no call site takes this route, so there is no app credential to wire
/// and injecting a placeholder would be worse than injecting nothing.
impl bindings::store_shared_fetch::HostWithStore<Ctx> for Ctx {
    async fn request(
        accessor: &Accessor<Ctx, Self>,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Result<FetchResponse, String>> {
        let eg = accessor.with(|mut a| a.get().egress.clone());
        Ok(egress_request(eg, Tier::Shared, method, url, headers, body).await)
    }
}

impl bindings::store_public_fetch::HostWithStore<Ctx> for Ctx {
    async fn request(
        accessor: &Accessor<Ctx, Self>,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Result<FetchResponse, String>> {
        let eg = accessor.with(|mut a| a.get().egress.clone());
        Ok(egress_request(eg, Tier::Public, method, url, headers, body).await)
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::Mac as _;
    let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(key)
        .expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

impl bindings::store_signer::HostWithStore<Ctx> for Ctx {
    /// The escrowed-credential seam (#11). What the guest hands over is
    /// public request metadata (a string-to-sign plus its scope); what
    /// comes back is one signature. The credential is never returned, so
    /// a compromised guest can only obtain signatures this function
    /// agrees to produce.
    async fn sign(
        accessor: &Accessor<Ctx, Self>,
        string_to_sign: String,
        date: String,
        region: String,
        service: String,
    ) -> Result<Result<String, String>> {
        let secret = accessor.with(|mut a| a.get().egress.secret.clone());
        // Scope refusal is the point of the handle: a raw SigV4 secret
        // signs for every service and region in the account, whereas this
        // capability signs only S3 requests in the granted region. The
        // handle is strictly narrower than the key it wraps.
        if service != "s3" {
            return Ok(Err(format!("signer: out of scope: service {service} != s3")));
        }
        if region != "us-east-1" {
            return Ok(Err(format!(
                "signer: out of scope: region {region} != us-east-1"
            )));
        }
        // SigV4 key derivation: AWS4<secret> chained through date, region,
        // service, "aws4_request", then the final MAC over the
        // string-to-sign (AWS SigV4, "Calculate the signature").
        let mut key = format!("AWS4{secret}").into_bytes();
        for step in [date.as_str(), region.as_str(), service.as_str(), "aws4_request"] {
            key = hmac_sha256(&key, step.as_bytes());
        }
        Ok(Ok(hex::encode(hmac_sha256(&key, string_to_sign.as_bytes()))))
    }
}

// --- the app-owned device identity (#20 G5) ---
//
// BLOCKED, PRECISELY, and the reason this seam answers `none`:
//
//   crate:   polymorph-webcrypto-wasmtime 0.1.0
//            (git polymorph-components/polymorph-webcrypto @ b13d2523,
//            the rev this host pins)
//   missing: any public way to construct a `signature.signing-key` /
//            `signature.verifying-key` resource from Rust-held key
//            material. The backing types ARE public
//            (`polymorph_webcrypto_wasmtime::{SigningKey, VerifyingKey}`),
//            but they are minted only through the crate-private
//            `Minted` trait (rust/wasmtime/src/lib.rs:~226,
//            `pub(crate) trait Minted`), their payload fields are
//            `pub(crate)`, and the hidden `_retention` field is a
//            `pub(crate) type Reservation` from `limits.rs`. So a host
//            cannot build a value to push into the table, and nothing
//            like an `import_signing_key_pkcs8`-from-Rust entry point
//            exists. This is the Rust-side counterpart of webcrypto#392's
//            JS `SigningKey.fromCryptoKey`, which shipped for the browser
//            (0.4.0) and not for wasmtime.
//
// What the gap costs: the native act battery cannot exercise a
// platform-posture RESUME with a real embedder-held key, so those acts
// stay on seed posture. What it does NOT cost: the import is real, the
// guest consults it, and the `none` branch — an embedding that grants no
// persistence — IS asserted natively (resume_acts::platform_no_identity_act).
//
// Deliberately NOT worked around by hacking resources into the crate's
// table: the retention accounting is the crate's own invariant.
impl bindings::polyvisor::engine::device_identity::HostWithStore<Ctx> for Ctx {
    async fn device_key_pair(
        _accessor: &Accessor<Ctx, Self>,
    ) -> Result<
        Option<(
            wasmtime::component::Resource<polymorph_webcrypto_wasmtime::SigningKey>,
            wasmtime::component::Resource<polymorph_webcrypto_wasmtime::VerifyingKey>,
        )>,
    > {
        Ok(None)
    }

    /// The TRANSPORT identity, and `none` for the same reason as above:
    /// this host cannot construct `signature` resources from Rust-held
    /// material. The guest's `none` branch mints a fresh iroh identity
    /// per bind — which is what this host has always done, so nothing
    /// native regresses; what it cannot exercise is the STABLE endpoint
    /// id across binds, and that lives in the browser act battery.
    async fn endpoint_key_pair(
        _accessor: &Accessor<Ctx, Self>,
    ) -> Result<
        Option<(
            wasmtime::component::Resource<polymorph_webcrypto_wasmtime::SigningKey>,
            wasmtime::component::Resource<polymorph_webcrypto_wasmtime::VerifyingKey>,
        )>,
    > {
        Ok(None)
    }
}

/// The sync half of the same interface: empty (every function here is
/// `async`), but `add_to_linker` still requires it.
impl bindings::polyvisor::engine::device_identity::Host for Ctx {}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/composed.wasm"));
    let mut relay = "http://127.0.0.1:3340".to_string();
    let mut endpoint = "http://127.0.0.1:9000".to_string();
    let mut bucket = "pm-tasks".to_string();
    let mut access = "minioadmin".to_string();
    let mut secret = "minioadmin".to_string();
    // Which act set to run. `full` is the G1–G5 scenario (needs a relay
    // AND MinIO); `pairing` is the PAIRING.md §6 set (relay only).
    let mut acts = "full".to_string();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--relay" => relay = args.next().ok_or_else(|| format_err!("--relay needs a URL"))?,
            "--endpoint" => {
                endpoint = args.next().ok_or_else(|| format_err!("--endpoint needs a URL"))?
            }
            "--bucket" => bucket = args.next().ok_or_else(|| format_err!("--bucket needs a name"))?,
            "--access" => access = args.next().ok_or_else(|| format_err!("--access needs a key"))?,
            "--secret" => secret = args.next().ok_or_else(|| format_err!("--secret needs a key"))?,
            "--acts" => acts = args.next().ok_or_else(|| format_err!("--acts needs a name"))?,
            other => bail!("unknown argument {other}"),
        }
    }
    // The credential leaves the CLI and goes straight into the host-side
    // egress/signer seams; nothing below ever puts it in guest config.
    let egress = Egress::new(&endpoint, secret)?;
    let s3 = S3Args {
        endpoint,
        bucket,
        access,
    };

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;

    let component = Component::from_file(&engine, &path)
        .with_context(|| format!("loading component {}", path.display()))?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    wasmtime_wasi_http::p3::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;
    wasmtime_websocket::add_to_linker(&mut linker)?;
    webrtc_host::add_to_linker(&mut linker)?;
    // The three storage-egress imports. Each is a separately NAMED world
    // import satisfied by its own host implementation — the linker is
    // where authority is attached (#7).
    bindings::polyvisor::engine::store_fetch_types::add_to_linker::<Ctx, Ctx>(
        &mut linker,
        |c| c,
    )?;
    bindings::store_owner_fetch::add_to_linker::<Ctx, Ctx>(&mut linker, |c| c)?;
    bindings::store_shared_fetch::add_to_linker::<Ctx, Ctx>(&mut linker, |c| c)?;
    bindings::store_public_fetch::add_to_linker::<Ctx, Ctx>(&mut linker, |c| c)?;
    bindings::store_signer::add_to_linker::<Ctx, Ctx>(&mut linker, |c| c)?;
    // The app-owned device-identity import. Filled with the `none`
    // default (see the impl above's BLOCKED note); the import must still
    // be linked, because a world import is not optional.
    bindings::polyvisor::engine::device_identity::add_to_linker::<Ctx, Ctx>(&mut linker, |c| c)?;

    // One store per act set. The negative pairing acts need guest-side
    // verification hooks, and WASI environment is per-store, so isolating
    // them in their own store is what keeps those hooks from touching the
    // positive acts.
    // THE STATE ROOT, when one is asked for (#20 G5). `None` — every
    // existing act set — builds a WasiCtx with NO preopened directory at
    // all, which is the fresh-boot shape the guest's persistence treats
    // as "no state to resume": `wasi:filesystem/preopens.get-directories`
    // answers an empty list and `std::fs` fails at the first call. That
    // is deliberately the DEFAULT here, so nothing that existed before
    // this feature can accidentally acquire host filesystem access.
    let make_store_in = |env: &[(&str, &str)], state_root: Option<&Path>| {
        let mut wasi = WasiCtxBuilder::new();
        wasi.inherit_stdout().inherit_stderr();
        for (k, v) in env {
            wasi.env(k, v);
        }
        if let Some(root) = state_root {
            // Mounted at `/`: the ONE preopen the engine treats as its
            // state root (guest/src/persist.rs). Writable, because the
            // whole point is checkpointing — the browser side needs the
            // same grant spelled `writable: true` (the spike's trap).
            wasi.preopened_dir(root, "/", DirPerms::all(), FilePerms::all())
                .expect("preopen the state root");
        }
        Store::new(
            &engine,
            Ctx {
                wasi: wasi.build(),
                webcrypto: WasiWebcryptoCtx::new(),
                websocket: WasiWebsocketCtx::new(),
                webrtc: WebrtcCtx::new(),
                http: wasmtime_wasi_http::WasiHttpCtx::new(),
                egress: egress.clone(),
                table: ResourceTable::new(),
            },
        )
    };
    let make_store = |env: &[(&str, &str)]| make_store_in(env, None);

    if acts == "resume" {
        // The bucket-state act (#93) needs a real store. A bucket of its
        // OWN, named for this process: the counts it asserts are over
        // the whole bucket, so anything another run left behind would be
        // counted as this run's.
        let probe = resume_acts::S3Probe {
            endpoint: s3.endpoint.clone(),
            bucket: format!("pm-resume-{}", std::process::id()),
            access: s3.access.clone(),
            secret: (*egress.secret).clone(),
            http: reqwest::Client::new(),
        };
        return resume_scenarios(&component, &linker, &make_store_in, relay, &probe).await;
    }
    if acts == "pairing" {
        // The chain act (SYNC.md §1) flushes two paired devices into one
        // real bucket. Its own bucket, named for this process, for the
        // same reason the resume battery takes one: the act asserts over
        // the WHOLE key set, so a co-tenant's leftovers would be counted
        // as ours.
        let probe = resume_acts::S3Probe {
            endpoint: s3.endpoint.clone(),
            bucket: format!("pm-pair-{}", std::process::id()),
            access: s3.access.clone(),
            secret: (*egress.secret).clone(),
            http: reqwest::Client::new(),
        };
        return pairing_scenarios(&engine, &component, &linker, &make_store, relay, &probe).await;
    }
    if acts != "full" {
        bail!("unknown act set {acts} (want `full`, `pairing` or `resume`)");
    }

    let mut store = make_store(&[]);

    let t0 = Instant::now();
    let laptop = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    let phone = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    let bob = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    let tablet = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    let laptop2 = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    let laptop3 = bindings::Engine::instantiate_async(&mut store, &component, &linker).await?;
    println!(
        "[{:>9.2?}] instantiated laptop + phone + bob + tablet (+2 restart shells)",
        t0.elapsed()
    );

    store
        .run_concurrent(async move |acc| {
            scenario(acc, laptop, phone, bob, tablet, laptop2, laptop3, relay, s3).await
        })
        .await?
}

/// Builds a store with the given WASI environment and, optionally, a
/// preopened state root (see `make_store_in`).
type StateStoreFactory<'a> = dyn Fn(&[(&str, &str)], Option<&Path>) -> Store<Ctx> + 'a;

/// The kill-and-resume act set (#20 G5).
///
/// TWO STORES over ONE state root is the whole shape. `Store` owns the
/// WASI context, so a second store is a second view of the same host
/// directory with no other continuity — the closest a single process gets
/// to "the worker died and a new one opened the same namespace". The
/// device that checkpoints and the instance that resumes therefore share
/// nothing but files on disk.
async fn resume_scenarios(
    component: &Component,
    linker: &Linker<Ctx>,
    make_store_in: &StateStoreFactory<'_>,
    relay: String,
    probe: &resume_acts::S3Probe,
) -> Result<()> {
    let mut outcomes: Vec<(&str, std::result::Result<(), String>)> = Vec::new();

    // The state root: a real directory, created fresh so a rerun never
    // resumes the previous run's device.
    let root = std::env::temp_dir().join(format!("pm-engine-state-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    println!("state root: {}", root.display());

    // Fresh-boot compatibility, in a store with NO preopen.
    let mut store = make_store_in(&[], None);
    let fresh = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    outcomes.push((
        "no state root: resume answers false, init still works",
        store
            .run_concurrent(async move |acc| resume_acts::no_state_root_act(acc, fresh).await)
            .await?
            .map_err(|e| e.to_string()),
    ));

    let mut store = make_store_in(&[], Some(&root));
    let device = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let resumed = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let peer = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    outcomes.push((
        "kill and resume: state survives, identity holds, the peer still syncs",
        store
            .run_concurrent(async move |acc| {
                resume_acts::resume_act(acc, device, resumed, peer, relay).await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    // Platform posture with the import answering `none` (the native gap;
    // resume_acts.rs). Its own state root: this device's checkpoint is
    // deliberately unresumable here and must not pollute the seed root.
    let platform_root = std::env::temp_dir().join(format!("pm-engine-platform-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&platform_root);
    std::fs::create_dir_all(&platform_root)
        .with_context(|| format!("creating {}", platform_root.display()))?;
    let mut store = make_store_in(&[], Some(&platform_root));
    let device = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let resumed = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    outcomes.push((
        "platform posture, no device identity granted: init mints, resume refuses explicitly",
        store
            .run_concurrent(async move |acc| {
                resume_acts::platform_no_identity_act(acc, device, resumed).await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    // BACK-COMPAT, STRUCTURALLY. `resume_act`'s device never configured
    // a store, so `State.buckets` stayed empty and the checkpoint wrote
    // NO `buckets.bin` member — a generation shaped exactly like every
    // pre-#93 one. It resumed a moment ago (the act above passed), which
    // is the absence path taken end to end. Asserted rather than left to
    // the eye, because it is the only proof this build can give that an
    // old checkpoint still resumes: the rig has no old build to write
    // one with.
    let absent = (|| -> Result<String> {
        let mut carriers = Vec::new();
        let mut gens = Vec::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("gen-") {
                continue;
            }
            gens.push(name.clone());
            if entry.path().join("buckets.bin").exists() {
                carriers.push(name);
            }
        }
        if gens.is_empty() {
            bail!("the resumed device wrote no generations at all");
        }
        if !carriers.is_empty() {
            bail!(
                "generations {carriers:?} carry a buckets member, but that device never \
                 configured a store — the absence path was not exercised"
            );
        }
        Ok(format!(
            "{} generation(s), none with a buckets member",
            gens.len()
        ))
    })();
    match &absent {
        Ok(what) => println!("[  buckets ] pre-#93 generation shape: {what}"),
        Err(e) => println!("[  buckets ] pre-#93 generation shape: FAILED: {e}"),
    }
    outcomes.push((
        "a generation with no buckets member resumes (the pre-#93 shape)",
        absent.map(|_| ()).map_err(|e| e.to_string()),
    ));

    // Bucket state across a kill (#93). Its own state root and its own
    // bucket — the counts are over the whole bucket.
    let bucket_root = std::env::temp_dir().join(format!("pm-engine-buckets-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&bucket_root);
    std::fs::create_dir_all(&bucket_root)
        .with_context(|| format!("creating {}", bucket_root.display()))?;
    let mut store = make_store_in(&[], Some(&bucket_root));
    let device = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let resumed = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    outcomes.push((
        "bucket state survives the kill: a re-flush uploads nothing, a change uploads the delta",
        store
            .run_concurrent(async move |acc| {
                resume_acts::bucket_state_act(acc, device, resumed, probe).await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    // AND THE GROWTH RULE FOR THAT SAME STATE (SYNC.md §2): a
    // `buckets.bin` that validates but does not DECODE resumes as an
    // empty map with a note, not as a refusal. Run over the SAME root
    // and the same bucket the act above just used, deliberately — the
    // "no new object names" half of the claim is only meaningful against
    // a store this device already wrote.
    let spoiled = (async {
        let before = probe.keys().await?;
        let (gen, len) = resume_acts::spoil_buckets_member(&bucket_root)?;
        println!(
            "[ buckets- ] spoiled gen-{gen}/buckets.bin in place ({len} B, manifest re-sealed):              a member that validates and cannot decode"
        );
        let mut store = make_store_in(&[], Some(&bucket_root));
        let revived = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
        store
            .run_concurrent(async move |acc| {
                resume_acts::bucket_decode_tolerance_act(acc, revived, probe, &before).await
            })
            .await??;
        Ok::<(), wasmtime::Error>(())
    })
    .await;
    outcomes.push((
        "an undecodable buckets member resumes as an empty map (the BucketState growth rule)",
        spoiled.map_err(|e| e.to_string()),
    ));

    // Crash consistency, staged rather than asserted (resume_acts.rs).
    let torn = std::env::temp_dir().join(format!("pm-engine-torn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&torn);
    std::fs::create_dir_all(&torn).with_context(|| format!("creating {}", torn.display()))?;
    let torn_outcome = (async {
        let mut store = make_store_in(&[], Some(&torn));
        let device = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
        store
            .run_concurrent(async move |acc| resume_acts::torn_write_act(acc, device).await)
            .await??;

        // THE KILL, mid-manifest-write. Truncating the newest generation's
        // MANIFEST to a prefix is precisely what a process death during
        // that one file write leaves on disk: the bytes that made it, and
        // no trailing digest. The engine must notice and step back a
        // generation.
        let mut gens: Vec<u64> = std::fs::read_dir(&torn)?
            .filter_map(std::result::Result::ok)
            .filter_map(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_prefix("gen-"))
                    .and_then(|n| n.parse::<u64>().ok())
            })
            .collect();
        gens.sort_unstable();
        let newest = *gens
            .last()
            .ok_or_else(|| format_err!("the device wrote no generations at all"))?;
        if gens.len() < 2 {
            bail!("expected two generations to fall back between, got {gens:?}");
        }
        let manifest = torn.join(format!("gen-{newest}")).join("MANIFEST");
        let whole = std::fs::read(&manifest)?;
        std::fs::write(&manifest, &whole[..whole.len() / 2])?;
        println!(
            "[   torn  ] truncated gen-{newest}/MANIFEST: {} B -> {} B (a kill mid-write)",
            whole.len(),
            whole.len() / 2
        );

        let mut store = make_store_in(&[], Some(&torn));
        let resumed = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
        store
            .run_concurrent(async move |acc| resume_acts::torn_resume_act(acc, resumed).await)
            .await??;
        Ok::<(), wasmtime::Error>(())
    })
    .await;
    outcomes.push((
        "a kill mid-checkpoint resumes from the previous generation",
        torn_outcome.map_err(|e| e.to_string()),
    ));

    // What the engine actually left on disk — evidence for the report,
    // and a cheap tripwire on the layout.
    println!("\n=== STATE ROOT CONTENTS ===");
    let mut gens: Vec<_> = std::fs::read_dir(&root)?
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    gens.sort();
    for g in &gens {
        let mut files: Vec<String> = std::fs::read_dir(root.join(g))?
            .filter_map(std::result::Result::ok)
            .map(|e| {
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                format!("{} ({len} B)", e.file_name().to_string_lossy())
            })
            .collect();
        files.sort();
        println!("  {g}/  {}", files.join("  "));
    }

    println!("\n=== RESUME ACT SETS ===");
    let mut failed = 0;
    for (name, outcome) in &outcomes {
        match outcome {
            Ok(()) => println!("  PASS  {name}"),
            Err(e) => {
                failed += 1;
                println!("  FAIL  {name}: {e}");
            }
        }
    }
    if failed > 0 {
        bail!("{failed} resume act set(s) failed");
    }
    println!("\nRESUME ACTS PASSED");
    Ok(())
}

/// The PAIRING.md §6 act sets, each in its own store.
///
/// The shortened offer TTL below applies only to the expiry act's store:
/// the contract value (120 s) is what every other instance uses, and what
/// ships.
const TEST_TTL_MS: u64 = 2_000;

/// Builds a store with the given WASI environment (see `make_store`).
type StoreFactory<'a> = dyn Fn(&[(&str, &str)]) -> Store<Ctx> + 'a;

async fn pairing_scenarios(
    engine: &Engine,
    component: &Component,
    linker: &Linker<Ctx>,
    make_store: &StoreFactory<'_>,
    relay: String,
    probe: &resume_acts::S3Probe,
) -> Result<()> {
    let _ = engine;

    let mut outcomes: Vec<(&str, std::result::Result<(), String>)> = Vec::new();
    let relay_for_post_seal = relay.clone();

    let mut store = make_store(&[]);
    let laptop = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let phone = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let stranger = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let rejoin = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let r = relay.clone();
    let bucket_probe = probe.clone();
    outcomes.push((
        "positive acts",
        store
            .run_concurrent(async move |acc| {
                pairing_acts::positive_acts(acc, laptop, phone, stranger, rejoin, r, &bucket_probe)
                    .await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    let mut store = make_store(&[("PM_PAIR_FAULT", "commit")]);
    let adder = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let joiner = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let r = relay.clone();
    outcomes.push((
        "commitment violation aborts",
        store
            .run_concurrent(
                async move |acc| pairing_acts::commitment_act(acc, adder, joiner, r).await,
            )
            .await?
            .map_err(|e| e.to_string()),
    ));

    let relay_expiry = relay.clone();
    let mut store = make_store(&[("PM_PAIR_TTL_MS", &TEST_TTL_MS.to_string())]);
    let joiner = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    outcomes.push((
        "offer expiry",
        store
            .run_concurrent(async move |acc| {
                pairing_acts::expiry_act(acc, joiner, relay_expiry, TEST_TTL_MS).await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    // Post-seal add on the account's doc: the readability boundary a
    // late-joining device sits on (direct decrypt vs causal walk).
    let mut store = make_store(&[]);
    let founder = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let joiner = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let r = relay_for_post_seal;
    outcomes.push((
        "post-seal add readable on the original doc",
        store
            .run_concurrent(
                async move |acc| pairing_acts::post_seal_add_act(acc, founder, joiner, r).await,
            )
            .await?
            .map_err(|e| e.to_string()),
    ));

    // Late joiner materializes FULL pre-join history, order-varied.
    let mut history_failures: Vec<String> = Vec::new();
    for seed in 0..10u32 {
        let mut store = make_store(&[]);
        let founder = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
        let joiner = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
        let r = relay.clone();
        let outcome = store
            .run_concurrent(async move |acc| {
                pairing_acts::full_history_act(acc, founder, joiner, r, seed).await
            })
            .await?;
        if let Err(e) = outcome {
            history_failures.push(format!("seed {seed}: {e}"));
        }
    }
    outcomes.push((
        "late joiner materializes FULL pre-join history (10 seeds)",
        if history_failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{}/10 seeds failed: {}",
                history_failures.len(),
                history_failures.join(" | ")
            ))
        },
    ));

    // Concurrent writes across an enrollment, including a deletion.
    let mut store = make_store(&[]);
    let founder = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let second = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let third = bindings::Engine::instantiate_async(&mut store, component, linker).await?;
    let r = relay.clone();
    outcomes.push((
        "partitioned writes merge natively (add + rename + forget)",
        store
            .run_concurrent(async move |acc| {
                pairing_acts::partitioned_writer_act(acc, founder, second, third, r).await
            })
            .await?
            .map_err(|e| e.to_string()),
    ));

    println!("\n=== PAIRING ACT SETS ===");
    let mut failed = 0;
    for (name, outcome) in &outcomes {
        match outcome {
            Ok(()) => println!("  PASS  {name}"),
            Err(e) => {
                failed += 1;
                println!("  FAIL  {name}: {e}");
            }
        }
    }
    if failed > 0 {
        bail!("{failed} pairing act set(s) failed");
    }
    println!("\nPAIRING ACTS PASSED");
    Ok(())
}

struct S3Args {
    endpoint: String,
    bucket: String,
    access: String,
}

macro_rules! step {
    ($label:expr, $call:expr) => {{
        let t = Instant::now();
        let out = $call
            .await?
            .map_err(|e| format_err!("{}: {e}", $label))?;
        println!("[{:>9.2?}] {}", t.elapsed(), $label);
        out
    }};
}

/// Establish an iroh wire between two instances (initiator ← acceptor) and
/// wait for the subduction handshake on both ends.
async fn connect(
    acc: &Accessor<Ctx>,
    initiator: (&Driver, &str, &[u8]),
    acceptor: (&Driver, &str, &str),
    relay: &str,
) -> Result<()> {
    let (ini, ini_name, acceptor_sd_id) = initiator;
    let (acp, acp_name, acp_endpoint) = acceptor;
    let ep_bytes = hex::decode(acp_endpoint).map_err(|e| format_err!("{e}"))?;
    let ca = acp
        .call_iroh_start(acc, false, vec![], relay.to_string(), vec![])
        .await?
        .map_err(|e| format_err!("{acp_name} accept: {e}"))?;
    let cb = ini
        .call_iroh_start(acc, true, ep_bytes, relay.to_string(), acceptor_sd_id.to_vec())
        .await?
        .map_err(|e| format_err!("{ini_name} connect: {e}"))?;
    let t = Instant::now();
    let (mut a, mut b) = (None, None);
    for _ in 0..2000 {
        if a.is_none() {
            a = ini
                .call_conn_status(acc, cb)
                .await?
                .map_err(|e| format_err!("{ini_name} handshake: {e}"))?;
        }
        if b.is_none() {
            b = acp
                .call_conn_status(acc, ca)
                .await?
                .map_err(|e| format_err!("{acp_name} handshake: {e}"))?;
        }
        if a.is_some() && b.is_some() {
            println!(
                "[{:>9.2?}] wire up: {ini_name} <-> {acp_name}",
                t.elapsed()
            );
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    bail!("wire {ini_name}<->{acp_name} did not come up")
}

/// Poll a tasks view until `want` returns true for the snapshot. Errors are
/// treated as not-ready (e.g. epoch material still in flight on the bridge)
/// but remembered for the timeout report.
async fn wait_items(
    acc: &Accessor<Ctx>,
    t: &Tasks,
    what: &str,
    want: impl Fn(&[TodoItem]) -> bool,
) -> Result<Vec<TodoItem>> {
    let start = Instant::now();
    let mut last_err = None;
    for _ in 0..2000 {
        match t.call_items(acc).await? {
            Ok(snap) => {
                if want(&snap.items) {
                    println!("[{:>9.2?}] {what}", start.elapsed());
                    return Ok(snap.items);
                }
            }
            Err(e) => last_err = Some(e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    bail!("{what}: condition never held (last error: {last_err:?})")
}

/// Generated WIT records don't derive PartialEq; compare by content.
fn same(a: &[TodoItem], b: &[TodoItem]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.id == y.id && x.title == y.title && x.completed == y.completed)
}

fn render(items: &[TodoItem]) -> String {
    items
        .iter()
        .map(|i| {
            format!(
                "[{}] {}",
                if i.completed { "x" } else { " " },
                i.title
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[allow(clippy::too_many_arguments)]
async fn scenario(
    acc: &Accessor<Ctx>,
    laptop: bindings::Engine,
    phone: bindings::Engine,
    bob: bindings::Engine,
    tablet: bindings::Engine,
    laptop2: bindings::Engine,
    laptop3: bindings::Engine,
    relay: String,
    s3: S3Args,
) -> Result<()> {
    let l: &Driver = laptop.polyvisor_engine_driver();
    let p: &Driver = phone.polyvisor_engine_driver();
    let b: &Driver = bob.polyvisor_engine_driver();
    let tb: &Driver = tablet.polyvisor_engine_driver();
    let l2: &Driver = laptop2.polyvisor_engine_driver();
    let l3: &Driver = laptop3.polyvisor_engine_driver();
    let lt: &Tasks = laptop.polyvisor_tasks_tasks();
    let pt: &Tasks = phone.polyvisor_tasks_tasks();
    let bt: &Tasks = bob.polyvisor_tasks_tasks();
    let tt: &Tasks = tablet.polyvisor_tasks_tasks();
    let l2t: &Tasks = laptop2.polyvisor_tasks_tasks();

    // 1. Identities; hub topology (laptop is the wire hub). The TABLET
    // never binds, never connects: it will live entirely off the bucket.
    // Laptop uses the G5 demo-grade SOFT identity (bundle-exportable);
    // everyone else keeps the platform-held default.
    let l_id = step!("laptop.init (soft identity)", l.call_init(acc, true));
    let p_id = step!("phone.init ", p.call_init(acc, false));
    let b_id = step!("bob.init   ", b.call_init(acc, false));
    let t_id = step!("tablet.init", tb.call_init(acc, false));
    let l_id_bytes = hex::decode(&l_id).map_err(|e| format_err!("{e}"))?;
    let p_id_bytes = hex::decode(&p_id).map_err(|e| format_err!("{e}"))?;
    let b_id_bytes = hex::decode(&b_id).map_err(|e| format_err!("{e}"))?;
    let t_id_bytes = hex::decode(&t_id).map_err(|e| format_err!("{e}"))?;

    let _l_ep = step!("laptop.iroh-bind", l.call_iroh_bind(acc, relay.clone()));
    let p_ep = step!("phone.iroh-bind ", p.call_iroh_bind(acc, relay.clone()));
    let b_ep = step!("bob.iroh-bind   ", b.call_iroh_bind(acc, relay.clone()));

    connect(acc, (l, "laptop", &p_id_bytes), (p, "phone", p_ep.as_str()), &relay).await?;
    connect(acc, (l, "laptop", &b_id_bytes), (b, "bob", b_ep.as_str()), &relay).await?;

    // Contact cards travel over the bridge.
    let t = Instant::now();
    let mut known = false;
    for _ in 0..2000 {
        let kp = l
            .call_kh_knows_agent(acc, p_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?;
        let kb = l
            .call_kh_knows_agent(acc, b_id_bytes.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?;
        if kp && kb {
            known = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    if !known {
        bail!("contact cards did not propagate");
    }
    println!("[{:>9.2?}] contact cards exchanged over the bridge", t.elapsed());

    // 2. Users are groups of devices (G3, #10's minimal slice).
    // Alice: laptop creates her user group and enrolls the phone (its
    // contact card arrived over the bridge) and the tablet (its card is
    // pasted — it has no wire). Bob: his own user group.
    let alice_g = step!("laptop.kh-create-group (user 'alice')", l.call_kh_create_group(acc));
    step!(
        "laptop.kh-add-to-group(phone, edit) [enrollment]",
        l.call_kh_add_to_group(acc, alice_g.clone(), p_id_bytes.clone(), "edit".into())
    );
    let tablet_card = step!("tablet.kh-contact-card [QR paste]", tb.call_kh_contact_card(acc));
    step!(
        "laptop.kh-ingest-contact(tablet)",
        l.call_kh_ingest_contact(acc, tablet_card)
    );
    step!(
        "laptop.kh-add-to-group(tablet, edit) [enrollment, wireless]",
        l.call_kh_add_to_group(acc, alice_g.clone(), t_id_bytes.clone(), "edit".into())
    );
    // The tablet needs the owner's contact card for the K_p prekey DH.
    let laptop_card = step!("laptop.kh-contact-card", l.call_kh_contact_card(acc));
    step!(
        "tablet.kh-ingest-contact(laptop)",
        tb.call_kh_ingest_contact(acc, laptop_card)
    );
    let bob_g = step!("bob.kh-create-group (user 'bob')", b.call_kh_create_group(acc));

    // The bridge only offers a group's ops to its members, so Alice can't
    // resolve Bob's group from the wire alone. Bob exports HIS OWN card
    // (an agent's card carries the memberships it can reach — for bob:
    // his user group's constitutive ops plus his prekeys) and Alice
    // ingests it. QR/paste in the product; the host carries it here.
    let bob_card = step!(
        "bob.kh-export-card(bob) [self card: individual + group]",
        b.call_kh_export_card(acc, b_id_bytes.clone())
    );
    println!("            card: {} bytes", bob_card.len());
    let pending = step!(
        "laptop.kh-ingest-card(bob-group)",
        l.call_kh_ingest_card(acc, bob_card.clone())
    );
    println!("            events pending after ingest: {pending}");
    // The card must ALSO reach Alice's other devices: the bridge's
    // reachability model never offers a foreign group's constitutive ops
    // to non-members, so a paste on one device cannot propagate to the
    // rest over the wire. (Design note for the product: carry received
    // cards inside a doc the user's devices share.)
    let pending_p = step!(
        "phone.kh-ingest-card(bob-group)",
        p.call_kh_ingest_card(acc, bob_card.clone())
    );
    println!("            events pending after ingest (phone): {pending_p}");
    let pending_t = step!(
        "tablet.kh-ingest-card(bob-group)",
        tb.call_kh_ingest_card(acc, bob_card)
    );
    println!("            events pending after ingest (tablet): {pending_t}");
    // Contact exchange is mutual: bob gets Alice's card (her individual
    // reaches alice-group, so the card carries the group's ops).
    let alice_card = step!(
        "laptop.kh-export-card(alice) [self card]",
        l.call_kh_export_card(acc, l_id_bytes.clone())
    );
    let pending_b = step!(
        "bob.kh-ingest-card(alice-group)",
        b.call_kh_ingest_card(acc, alice_card)
    );
    println!("            events pending after ingest (bob): {pending_b}");
    let t = Instant::now();
    let mut known = false;
    for _ in 0..2000 {
        if l
            .call_kh_knows_agent(acc, bob_g.clone())
            .await?
            .map_err(|e| format_err!("{e}"))?
        {
            known = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    if !known {
        bail!("laptop never resolved bob's group from the ingested card");
    }
    println!("[{:>9.2?}] laptop resolves bob's group as an agent", t.elapsed());

    // 3. Partition lifecycle: create → delegate to GROUPS → seal. Phone
    // and bob get access transitively (individual → user group → doc);
    // the epoch at seal time covers all transitive individuals.
    let part = step!("laptop.create-partition", l.call_create_partition(acc));
    step!(
        "laptop.kh-add-member(alice-group, edit)",
        l.call_kh_add_member(acc, part.clone(), alice_g.clone(), "edit".into())
    );
    step!(
        "laptop.kh-add-member(bob-group, edit)",
        l.call_kh_add_member(acc, part.clone(), bob_g.clone(), "edit".into())
    );
    step!("laptop.seal-partition", l.call_seal_partition(acc, part.clone()));
    step!("phone.adopt-partition", p.call_adopt_partition(acc, part.clone()));
    step!("bob.adopt-partition  ", b.call_adopt_partition(acc, part.clone()));
    step!("tablet.adopt-partition", tb.call_adopt_partition(acc, part.clone()));

    // Members subscribe to the hub.
    for (d, name) in [(p, "phone"), (b, "bob")] {
        let h = d
            .call_sync_start(acc, l_id_bytes.clone(), part.clone(), true)
            .await?
            .map_err(|e| format_err!("{name} sync-start: {e}"))?;
        let t = Instant::now();
        loop {
            match d.call_sync_status(acc, h).await? {
                Ok(Some(summary)) => {
                    println!("[{:>9.2?}] {name} first sync: {summary}", t.elapsed());
                    break;
                }
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(3)).await,
                Err(e) => bail!("{name} sync: {e}"),
            }
        }
    }
    // The hub subscribes back so member-authored chunks flow to it.
    for (id, name) in [(p_id_bytes.clone(), "phone"), (b_id_bytes.clone(), "bob")] {
        let h = l
            .call_sync_start(acc, id, part.clone(), true)
            .await?
            .map_err(|e| format_err!("laptop sync-start({name}): {e}"))?;
        loop {
            match l.call_sync_status(acc, h).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(3)).await,
                Err(e) => bail!("laptop sync({name}): {e}"),
            }
        }
    }

    // Wait until both members can decrypt the creation chunk (revision 1).
    // This proves the bridge delivered doc membership + epoch material, so
    // subsequent subscription pushes pass the members' policy checks — a
    // push rejected by a not-yet-informed policy is not redelivered.
    for (t, name) in [(pt, "phone"), (bt, "bob")] {
        let start = Instant::now();
        let mut ok = false;
        for _ in 0..2000 {
            let rev = t
                .call_revision(acc)
                .await?
                .map_err(|e| format_err!("{name} revision: {e}"))?;
            if rev >= 1 {
                println!(
                    "[{:>9.2?}] {name} decrypted the creation chunk (revision {rev})",
                    start.elapsed()
                );
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        if !ok {
            bail!("{name} never decrypted the creation chunk");
        }
    }

    // 3. Tasks flow: laptop authors two.
    let milk = step!("laptop.tasks.add('buy milk')", lt.call_add(acc, "buy milk".into()));
    let _demo = step!(
        "laptop.tasks.add('write demo')",
        lt.call_add(acc, "write demo".into())
    );
    let items = wait_items(acc, pt, "phone sees both tasks", |i| i.len() == 2).await?;
    println!("            phone: {}", render(&items));
    wait_items(acc, bt, "bob sees both tasks", |i| i.len() == 2).await?;

    // 4. A real concurrency fork: phone toggles while laptop adds, both
    // from the same frontier; sync merges; phone's next change has two
    // parents.
    step!(
        "phone.tasks.set-completed('buy milk') [concurrent]",
        pt.call_set_completed(acc, milk.clone(), true)
    );
    step!(
        "laptop.tasks.add('laptop task') [concurrent]",
        lt.call_add(acc, "laptop task".into())
    );
    wait_items(acc, pt, "phone converged on fork", |i| {
        i.len() == 3 && i.iter().any(|x| x.title == "buy milk" && x.completed)
    })
    .await?;
    step!(
        "phone.tasks.add('phone task') [merges the fork]",
        pt.call_add(acc, "phone task".into())
    );

    let want4 = |i: &[TodoItem]| {
        i.len() == 4 && i.iter().any(|x| x.title == "buy milk" && x.completed)
    };
    let li = wait_items(acc, lt, "laptop converged (4 tasks)", want4).await?;
    let pi = wait_items(acc, pt, "phone converged (4 tasks)", want4).await?;
    let bi = wait_items(acc, bt, "bob converged (4 tasks)", want4).await?;
    if !same(&li, &pi) || !same(&pi, &bi) {
        bail!("replicas diverged:\n  laptop {li:?}\n  phone {pi:?}\n  bob {bi:?}");
    }
    println!("            all: {}", render(&li));

    let (chunks, max_parents) = step!("laptop.chunk-stats", l.call_chunk_stats(acc, part.clone()));
    println!("            chunks={chunks}, max-parents={max_parents}");
    if max_parents < 2 {
        bail!("expected a merge chunk with >= 2 parents (the DAG assertion)");
    }

    // 5. Collaborator edit propagates.
    let demo_id = bi
        .iter()
        .find(|x| x.title == "write demo")
        .map(|x| x.id.clone())
        .ok_or_else(|| format_err!("bob lost 'write demo'"))?;
    step!(
        "bob.tasks.set-completed('write demo')",
        bt.call_set_completed(acc, demo_id, true)
    );
    wait_items(acc, lt, "laptop sees bob's toggle", |i| {
        i.iter().any(|x| x.title == "write demo" && x.completed)
    })
    .await?;

    // 6. The bucket path (G4): the same envelope bytes, a second sync
    // surface. Laptop configures the store and grants K_p to every
    // member individual; the TABLET — which has never touched the wire —
    // cold-boots from the bucket alone.
    //
    // The access key is a public identifier, not a credential: bob's
    // empty one records "this instance is a reader" in the config, but
    // what actually confines bob is the wiring (in this rig, see the
    // Egress note: one credential set for all six instances, so bob's
    // read-only behaviour is a property of which imports his call sites
    // use, not of a separate grant).
    for (d, name, ak) in [
        (l, "laptop", s3.access.as_str()),
        (p, "phone ", s3.access.as_str()),
        (tb, "tablet", s3.access.as_str()),
        (b, "bob   ", ""),
    ] {
        d.call_init_store(
            acc,
            StoreConfig::S3(S3Config {
                endpoint: s3.endpoint.clone(),
                bucket: s3.bucket.clone(),
                access_key: ak.to_string(),
            }),
        )
        .await?
        .map_err(|e| format_err!("{name} init-store: {e}"))?;
    }
    println!("            stores configured (bob: pull-only, no creds)");
    step!("laptop.ensure-bucket", l.call_ensure_bucket(acc));
    for (member, name) in [
        (l_id_bytes.clone(), "laptop"),
        (p_id_bytes.clone(), "phone"),
        (t_id_bytes.clone(), "tablet"),
        (b_id_bytes.clone(), "bob"),
    ] {
        // S3 returns no capability: the K_p sits at a location the
        // member derives. (Dropbox returns the minted pickup link.)
        let _ = step!(
            format!("laptop.store-grant({name})"),
            l.call_store_grant(acc, part.clone(), member)
        );
    }
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");

    // Cold start: the tablet joins from the bucket alone.
    let summary = step!(
        "tablet.bucket-pull [cold start, zero connections]",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    let ti = wait_items(acc, tt, "tablet reads the full task list from the bucket", |i| {
        i.len() == 4
            && i.iter().any(|x| x.title == "buy milk" && x.completed)
            && i.iter().any(|x| x.title == "write demo" && x.completed)
    })
    .await?;
    let li_now = lt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("laptop items: {e}"))?;
    if !same(&ti, &li_now.items) {
        bail!(
            "tablet's bucket view diverges from laptop's live view:\n  tablet {ti:?}\n  laptop {:?}",
            li_now.items
        );
    }
    println!("            tablet == laptop, via bucket only");

    // 7. Cold authoring: the tablet writes through the bucket; the DAG
    // flows bucket -> laptop -> live wire -> phone and bob.
    step!(
        "tablet.tasks.add('tablet task') [cold author]",
        tt.call_add(acc, "tablet task".into())
    );
    let summary = step!("tablet.bucket-flush", tb.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "laptop.bucket-pull",
        l.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, lt, "laptop sees the tablet task (via bucket)", |i| i.len() == 5).await?;
    wait_items(acc, pt, "phone sees the tablet task (bucket -> laptop -> wire)", |i| {
        i.len() == 5
    })
    .await?;
    wait_items(acc, bt, "bob sees the tablet task", |i| i.len() == 5).await?;

    // 8. Revocation, flavor 1 — collaborator: revoke BOB'S GROUP from the
    // doc AND his K_p from the bucket (the name-key epoch rotates with
    // the BeeKEM epoch). Bob is cut off on both surfaces.
    step!(
        "laptop.kh-revoke-member(bob-group)",
        l.call_kh_revoke_member(acc, part.clone(), bob_g.clone())
    );
    let note = step!(
        "laptop.store-revoke(bob)",
        l.call_store_revoke(acc, part.clone(), b_id_bytes.clone())
    );
    println!("            {note}");
    step!(
        "laptop.tasks.add('secret task') [post-revocation]",
        lt.call_add(acc, "secret task".into())
    );
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    wait_items(acc, pt, "phone sees the post-revocation task (rode the rotation)", |i| {
        i.len() == 6 && i.iter().any(|x| x.title == "secret task")
    })
    .await?;
    let summary = step!(
        "tablet.bucket-pull [rides the rotation via K_p republish]",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees the post-revocation task", |i| {
        i.len() == 6 && i.iter().any(|x| x.title == "secret task")
    })
    .await?;

    // Bob: the live surface must never show it, and the bucket surface
    // must refuse at the K_p (deleted; nothing else is locatable).
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let snap = bt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("bob items: {e}"))?;
    if snap.items.iter().any(|x| x.title == "secret task") {
        bail!("REVOCATION FAILURE: bob sees the secret task");
    }
    if snap.items.len() != 5 {
        bail!("bob's view changed unexpectedly: {:?}", snap.items);
    }
    match b
        .call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
        .await?
    {
        Err(e) if e.contains("kp missing") => {
            println!("            bob.bucket-pull refused: {e}");
        }
        Err(e) => bail!("bob's pull failed for the wrong reason: {e}"),
        Ok(s) => bail!("REVOCATION FAILURE: bob's bucket pull succeeded: {s}"),
    }
    let b_stats = b.call_stats(acc).await?;
    println!("            bob still sees 5 tasks; {b_stats}");

    // 9. Revocation, flavor 2 — lost phone: revoke the PHONE from Alice's
    // user group. Same mechanic, different node of the delegation graph.
    step!(
        "laptop.kh-revoke-from-group(alice-group, phone) [lost phone]",
        l.call_kh_revoke_from_group(acc, alice_g.clone(), p_id_bytes.clone())
    );
    step!(
        "laptop.tasks.add('post-lost-phone task')",
        lt.call_add(acc, "post-lost-phone task".into())
    );
    wait_items(acc, lt, "laptop sees all 7 tasks", |i| i.len() == 7).await?;
    let summary = step!("laptop.bucket-flush", l.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "tablet.bucket-pull",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees all 7 tasks", |i| i.len() == 7).await?;

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let snap = pt
        .call_items(acc)
        .await?
        .map_err(|e| format_err!("phone items: {e}"))?;
    if snap.items.iter().any(|x| x.title == "post-lost-phone task") {
        bail!("LOST-PHONE FAILURE: the revoked phone reads the new task");
    }
    if snap.items.len() != 6 {
        bail!("phone's view changed unexpectedly: {:?}", snap.items);
    }
    let p_stats = p.call_stats(acc).await?;
    println!("            phone still sees 6 tasks; {p_stats}");

    // 10. G5: restart from the identity bundle. Laptop exports the
    // sealed bundle with two keyslots — an argon2id passphrase (the
    // downloadable-file wrap) and a raw 32-byte secret standing in for
    // a passkey-PRF output. A fresh instance restores from the bundle
    // plus the bucket: identity, epochs, and the full task list.
    let prf_secret: Vec<u8> = (0..32u8).collect(); // obviously-synthetic PRF stand-in
    let bundle = step!(
        "laptop.identity-export(passphrase slot + prf slot)",
        l.call_identity_export(
            acc,
            "alice-laptop".into(),
            Some("correct horse battery staple".into()),
            Some(prf_secret.clone())
        )
    );
    println!("            bundle: {} bytes, 2 keyslots", bundle.len());

    // Wrong passphrase must fail before any state is built.
    match l2
        .call_identity_import(acc, bundle.clone(), Some("wrong horse".into()), None)
        .await?
    {
        Err(e) => println!("            wrong passphrase refused: {e}"),
        Ok(_) => bail!("SLOT FAILURE: wrong passphrase opened the bundle"),
    }

    let restored = step!(
        "laptop2.identity-import(passphrase) [restart]",
        l2.call_identity_import(
            acc,
            bundle.clone(),
            Some("correct horse battery staple".into()),
            None
        )
    );
    if restored != l_id {
        bail!("restored identity differs: {restored} != {l_id}");
    }
    println!("            restored identity == laptop identity");
    l2.call_init_store(
        acc,
        StoreConfig::S3(S3Config {
            endpoint: s3.endpoint.clone(),
            bucket: s3.bucket.clone(),
            access_key: s3.access.clone(),
        }),
    )
    .await?
    .map_err(|e| format_err!("laptop2 init-store: {e}"))?;
    let summary = step!(
        "laptop2.bucket-pull [rehydrate: bundle + bucket only]",
        l2.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, l2t, "laptop2 reads all 7 tasks", |i| i.len() == 7).await?;

    // The restored device can still AUTHOR (its group-encryption leaf
    // secrets survived the archive) and others accept the result.
    step!(
        "laptop2.tasks.add('post-restart task')",
        l2t.call_add(acc, "post-restart task".into())
    );
    let summary = step!("laptop2.bucket-flush", l2.call_bucket_flush(acc, part.clone()));
    println!("            {summary}");
    let summary = step!(
        "tablet.bucket-pull",
        tb.call_bucket_pull(acc, part.clone(), l_id_bytes.clone(), None)
    );
    println!("            {summary}");
    wait_items(acc, tt, "tablet sees the restored device's task (8 total)", |i| {
        i.len() == 8
    })
    .await?;

    // The PRF-shaped slot opens the same bundle.
    let restored3 = step!(
        "laptop3.identity-import(prf slot)",
        l3.call_identity_import(acc, bundle, None, Some(prf_secret))
    );
    if restored3 != l_id {
        bail!("prf-slot restore differs: {restored3} != {l_id}");
    }
    println!("            prf-shaped slot opens the same bundle");

    for (name, d) in [("laptop", l), ("tablet", tb), ("laptop2", l2)] {
        let s = d.call_stats(acc).await?;
        println!("{name}: {s}");
    }
    println!("\nSPIKE PASSED");
    Ok(())
}
