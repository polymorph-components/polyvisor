//! Native tests for the kernel. Everything the runtime component does is
//! reachable here because the component holds no logic of its own.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Wake, Waker};

use polyvisor_kernel::{
    BootConfig, Error, ErrorCode, Event, Fetch, Kernel, LocalFuture, Platform, Rng,
};

// -- harness -----------------------------------------------------------------

/// Every fake resolves immediately, so a `Pending` here means the kernel
/// awaited something that cannot complete — a bug, not a stall.
fn block_on<F: Future>(fut: F) -> F::Output {
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    let mut fut = std::pin::pin!(fut);
    match fut.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("the kernel parked on a fake that answers immediately"),
    }
}

#[derive(Default, Clone)]
struct FakeKv(Rc<RefCell<BTreeMap<String, Vec<u8>>>>);

impl Platform for FakeKv {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        let value = self.0.borrow().get(&key).cloned();
        Box::pin(async move { value })
    }
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()> {
        self.0.borrow_mut().insert(key, value);
        Box::pin(async {})
    }
}

#[derive(Default)]
struct FakeFetch {
    routes: BTreeMap<String, Vec<u8>>,
}

impl FakeFetch {
    fn route(mut self, url: &str, body: impl AsRef<[u8]>) -> Self {
        self.routes.insert(url.to_string(), body.as_ref().to_vec());
        self
    }
}

impl Fetch for FakeFetch {
    fn get(&self, url: String) -> LocalFuture<'_, Result<Vec<u8>, String>> {
        let found = self.routes.get(&url).cloned();
        Box::pin(async move { found.ok_or_else(|| "404".to_string()) })
    }
}

/// Hands out scripted bytes so word/hue draws are reproducible; runs out to
/// zeroes, which is fine for every test that does not care.
#[derive(Default)]
struct ScriptRng(RefCell<VecDeque<u8>>);

impl ScriptRng {
    /// Each value is one four-byte little-endian draw. The device mint
    /// spends four of them on the 16-byte id before the hue and the word.
    fn draws(values: &[u32]) -> ScriptRng {
        ScriptRng(RefCell::new(
            values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        ))
    }
}

impl Rng for ScriptRng {
    fn fill(&self, dest: &mut [u8]) {
        let mut queue = self.0.borrow_mut();
        for slot in dest.iter_mut() {
            *slot = queue.pop_front().unwrap_or(0);
        }
    }
}

const ORIGIN: &str = "https://home.example";
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

fn boot_with(kv: FakeKv, fetch: FakeFetch, rng: ScriptRng) -> Result<Kernel, Error> {
    block_on(Kernel::boot(
        BootConfig {
            home_origin: ORIGIN.to_string(),
        },
        Box::new(kv),
        Box::new(fetch),
        Box::new(rng),
    ))
}

fn boot() -> Kernel {
    boot_with(
        FakeKv::default(),
        fetch_with(CSS_HANDLE_HEX),
        ScriptRng::default(),
    )
    .unwrap()
}

fn session(kernel: &Kernel) -> u32 {
    kernel.launch("todomvc").unwrap()
}

// -- device ------------------------------------------------------------------

#[test]
fn device_is_minted_once_and_reread() {
    let kv = FakeKv::default();
    let first = boot_with(
        kv.clone(),
        fetch_with(CSS_HANDLE_HEX),
        ScriptRng::draws(&[0, 0, 0, 0, 42, 7]),
    )
    .unwrap();
    let minted = first.device_status();
    assert_eq!(minted.id.len(), 32, "16 random bytes as hex");
    assert_eq!(minted.name, "");
    assert_eq!(minted.hue, 42);

    // A second boot on the same store must not mint again, even though the
    // rng would hand out different values.
    let second = boot_with(
        kv,
        fetch_with(CSS_HANDLE_HEX),
        ScriptRng::draws(&[9, 9, 9, 9, 1, 2]),
    )
    .unwrap();
    assert_eq!(second.device_status(), minted);
}

#[test]
fn name_and_hue_persist_and_out_of_range_hue_is_refused() {
    let kv = FakeKv::default();
    let kernel = boot_with(kv.clone(), fetch_with(CSS_HANDLE_HEX), ScriptRng::default()).unwrap();
    block_on(kernel.set_name("kitchen".into())).unwrap();
    block_on(kernel.set_hue(200)).unwrap();

    let refused = block_on(kernel.set_hue(360)).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Refused);
    assert_eq!(
        kernel.device_status().hue,
        200,
        "the refusal changed nothing"
    );

    let reread = boot_with(kv, fetch_with(CSS_HANDLE_HEX), ScriptRng::default()).unwrap();
    assert_eq!(reread.device_status().name, "kitchen");
    assert_eq!(reread.device_status().hue, 200);
}

#[test]
fn reroll_never_repeats_the_current_word() {
    // Draw 5 twice, then 6: the repeat must be rejected and redrawn.
    let kernel = boot_with(
        FakeKv::default(),
        fetch_with(CSS_HANDLE_HEX),
        ScriptRng::draws(&[0, 0, 0, 0, 0, 5, 5, 6]),
    )
    .unwrap();
    let first = kernel.device_status().word;
    let rerolled = block_on(kernel.reroll_word()).unwrap();
    assert_ne!(rerolled, first);
    assert_eq!(kernel.device_status().word, rerolled);
}

// -- apps --------------------------------------------------------------------

#[test]
fn registry_lists_what_the_home_origin_serves() {
    let kernel = boot();
    let installed = kernel.installed();
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
    assert!(pending(&kernel));
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
    let wrong = "0".repeat(64);
    let kernel = boot_with(FakeKv::default(), fetch_with(&wrong), ScriptRng::default()).unwrap();
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
    assert_eq!(kernel.tasks_revision(99), Err("unknown session".into()));
}

#[test]
fn a_manifest_handle_that_is_not_hex_is_a_boot_failure() {
    let Err(err) = boot_with(
        FakeKv::default(),
        fetch_with("not hex"),
        ScriptRng::default(),
    ) else {
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
    let id = kernel.tasks_add(a, "milk".into()).unwrap();
    assert_eq!(kernel.tasks_items(b).unwrap().items[0].id, id);
}

#[test]
fn every_mutation_advances_the_revision_and_ids_order_the_items() {
    let kernel = boot();
    let s = session(&kernel);
    assert_eq!(kernel.tasks_revision(s).unwrap(), 0);

    let first = kernel.tasks_add(s, "milk".into()).unwrap();
    let second = kernel.tasks_add(s, "bread".into()).unwrap();
    assert!(first < second, "ids sort in creation order");
    assert_eq!(kernel.tasks_revision(s).unwrap(), 2);

    kernel.tasks_set_completed(s, &first, true).unwrap();
    kernel.tasks_set_title(s, &second, "rye".into()).unwrap();
    let snapshot = kernel.tasks_items(s).unwrap();
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

    kernel.tasks_remove(s, &first).unwrap();
    assert_eq!(kernel.tasks_revision(s).unwrap(), 5);
    assert_eq!(kernel.tasks_items(s).unwrap().items.len(), 1);

    // A failed mutation is not a mutation.
    assert!(kernel.tasks_remove(s, &first).is_err());
    assert!(kernel.tasks_set_title(s, "nope", "x".into()).is_err());
    assert_eq!(kernel.tasks_revision(s).unwrap(), 5);
}

// -- events ------------------------------------------------------------------

struct Flag(AtomicBool);

impl Wake for Flag {
    fn wake(self: Arc<Self>) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// True while `next_event` has nothing to hand over.
fn pending(kernel: &Kernel) -> bool {
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    let mut next = std::pin::pin!(kernel.next_event());
    next.as_mut().poll(&mut cx).is_pending()
}

#[test]
fn next_parks_until_an_event_arrives_and_wakes_the_waiter() {
    let kernel = boot();
    let flag = Arc::new(Flag(AtomicBool::new(false)));
    let waker = Waker::from(flag.clone());
    let mut cx = Context::from_waker(&waker);
    let mut next = std::pin::pin!(kernel.next_event());

    assert!(next.as_mut().poll(&mut cx).is_pending());
    assert!(!flag.0.load(Ordering::SeqCst));

    kernel.push_event(Event::SessionEnded(1, "gone".into()));
    assert!(flag.0.load(Ordering::SeqCst), "the parked waiter was woken");
    assert_eq!(
        next.as_mut().poll(&mut cx),
        Poll::Ready(Event::SessionEnded(1, "gone".into()))
    );
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
        block_on(kernel.next_event()),
        Event::SessionEnded(s, "the app's frame was closed: policy".into())
    );

    // Idempotent: a second abort of the same session announces nothing.
    kernel.abort(s, "again".into());
    assert!(pending(&kernel));
}

#[test]
fn aborting_an_unknown_session_is_a_no_op() {
    let kernel = boot();
    kernel.abort(404, "never existed".into());
    assert!(pending(&kernel));
}

#[test]
fn close_then_abort_announces_nothing() {
    // The visor closed the session itself; a frame teardown message racing
    // behind it must not manufacture an ending the visor did not cause.
    let kernel = boot();
    let s = session(&kernel);
    kernel.close(s);
    kernel.abort(s, "the app's frame was closed: gone".into());
    assert!(pending(&kernel));
}
