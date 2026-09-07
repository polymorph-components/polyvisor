//! Native tests for the kernel. Everything the runtime component does is
//! reachable here because the component holds no logic of its own.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Wake, Waker};

use polyvisor_kernel::{
    BootConfig, Clock, Error, ErrorCode, Event, Fetch, Files, IndexRow, Kernel, LEASE_TTL_MS,
    LocalFuture, Locks, Platform, Rest, Rng, Seams, State, Tier,
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

type Store = Rc<RefCell<BTreeMap<String, Vec<u8>>>>;

#[derive(Default, Clone)]
struct FakeKv(Store);

impl Platform for FakeKv {
    fn get(&self, key: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        let value = self.0.borrow().get(&key).cloned();
        Box::pin(async move { value })
    }
    fn set(&self, key: String, value: Vec<u8>) -> LocalFuture<'_, ()> {
        self.0.borrow_mut().insert(key, value);
        Box::pin(async {})
    }
    fn delete(&self, key: String) -> LocalFuture<'_, ()> {
        self.0.borrow_mut().remove(&key);
        Box::pin(async {})
    }
    fn keys(&self, prefix: String) -> LocalFuture<'_, Vec<String>> {
        let keys: Vec<String> = self
            .0
            .borrow()
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        Box::pin(async move { keys })
    }
}

/// A flat path -> bytes map, which is what OPFS is behind its directory
/// handles: a directory exists exactly where a file is under it.
#[derive(Default, Clone)]
struct FakeFiles(Store);

impl FakeFiles {
    fn paths(&self) -> Vec<String> {
        self.0.borrow().keys().cloned().collect()
    }
    fn under(&self, prefix: &str) -> bool {
        self.paths().iter().any(|p| p.starts_with(prefix))
    }
}

impl Files for FakeFiles {
    fn read(&self, path: String) -> LocalFuture<'_, Option<Vec<u8>>> {
        let value = self.0.borrow().get(&path).cloned();
        Box::pin(async move { value })
    }
    fn write(&self, path: String, bytes: Vec<u8>) -> LocalFuture<'_, ()> {
        self.0.borrow_mut().insert(path, bytes);
        Box::pin(async {})
    }
    fn remove_dir_all(&self, path: String) -> LocalFuture<'_, ()> {
        let prefix = format!("{path}/");
        self.0.borrow_mut().retain(|k, _| !k.starts_with(&prefix));
        Box::pin(async {})
    }
    fn list(&self, dir: String) -> LocalFuture<'_, Vec<String>> {
        let prefix = format!("{dir}/");
        let names: BTreeSet<String> = self
            .0
            .borrow()
            .keys()
            .filter_map(|k| k.strip_prefix(&prefix))
            .map(|rest| rest.split('/').next().unwrap_or(rest).to_string())
            .collect();
        let names: Vec<String> = names.into_iter().collect();
        Box::pin(async move { names })
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

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

#[derive(Default, Clone)]
struct FakeFetch(Rc<RefCell<BTreeMap<String, Vec<u8>>>>);

impl FakeFetch {
    fn route(self, url: &str, body: impl AsRef<[u8]>) -> Self {
        self.0
            .borrow_mut()
            .insert(url.to_string(), body.as_ref().to_vec());
        self
    }
}

impl Fetch for FakeFetch {
    fn get(&self, url: String) -> LocalFuture<'_, Result<Vec<u8>, String>> {
        let found = self.0.borrow().get(&url).cloned();
        Box::pin(async move { found.ok_or_else(|| "404".to_string()) })
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

    fn with_fetch(fetch: FakeFetch) -> World {
        World {
            fetch,
            ..World::default()
        }
    }

    fn try_boot_as(&self, id: &str) -> Result<Kernel, Error> {
        block_on(Kernel::boot(
            BootConfig {
                home_origin: ORIGIN.to_string(),
                device: id.to_string(),
            },
            Seams {
                platform: Box::new(self.kv.clone()),
                files: Box::new(self.files.clone()),
                locks: Box::new(self.locks.clone()),
                clock: Box::new(self.clock.clone()),
                fetch: Box::new(self.fetch.clone()),
                rng: Box::new(self.rng.clone()),
            },
        ))
    }

    fn try_boot(&self) -> Result<Kernel, Error> {
        self.try_boot_as(ID)
    }

    fn boot(&self) -> Kernel {
        self.try_boot().unwrap()
    }

    fn kv_has(&self, key: &str) -> bool {
        self.kv.0.borrow().contains_key(key)
    }

    fn kv_put(&self, key: &str, value: Vec<u8>) {
        self.kv.0.borrow_mut().insert(key.to_string(), value);
    }

    fn row(&self, id: &str) -> Option<IndexRow> {
        self.kv
            .0
            .borrow()
            .get(&format!("index/{id}"))
            .map(|bytes| IndexRow::decode(bytes).unwrap())
    }

    fn put_row(&self, row: &IndexRow) {
        self.kv_put(&format!("index/{}", row.id), row.encode().unwrap());
    }

    /// The generation directory names on disk, ascending.
    fn generations(&self, id: &str) -> Vec<String> {
        block_on(self.files.list(format!("/{id}")))
    }
}

/// The default world booted once: the shape most app/session tests want.
fn boot() -> Kernel {
    World::default().boot()
}

fn session(kernel: &Kernel) -> u32 {
    kernel.launch("todomvc").unwrap()
}

// -- boot, identity, checkpoint ----------------------------------------------

#[test]
fn a_fresh_boot_writes_a_row_and_a_key_and_no_checkpoint() {
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
    // Nothing reaches the state root until there is something to save.
    assert!(world.files.paths().is_empty());

    block_on(kernel.set_name("study".into())).unwrap();
    assert_eq!(world.generations(ID), ["gen-1"]);
}

#[test]
fn the_anchor_is_derived_from_the_id_and_survives_a_reload() {
    let world = World::default();
    let minted = world.boot().device_status().unwrap();
    assert_eq!(world.boot().device_status().unwrap(), minted);

    // A different id is a different device, anchor and all.
    let other = world.try_boot_as("beef").unwrap().device_status().unwrap();
    assert_ne!(other.word, minted.word);
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
        kernel.tasks_revision(1),
        Err("unknown session".into()),
        "sessions are not persisted: a reload ends them"
    );
    let s = session(&kernel);
    let items = kernel.tasks_items(s).unwrap();
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
fn erase_destroys_the_namespace_and_the_row_and_is_terminal() {
    let world = World::default();
    let kernel = world.boot();
    block_on(kernel.set_name("study".into())).unwrap();
    assert!(!world.files.paths().is_empty());

    block_on(kernel.erase()).unwrap();
    assert!(world.files.paths().is_empty());
    assert!(!world.kv_has(&format!("index/{ID}")));
    assert!(!world.kv_has(&format!("dev/{ID}/dek")));

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
    );
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
fn a_complete_generation_replaces_every_older_one() {
    let world = World::default();
    let kernel = world.boot();
    for (n, name) in [(1, "one"), (2, "two"), (3, "three")] {
        block_on(kernel.set_name(name.into())).unwrap();
        assert_eq!(world.generations(ID), [format!("gen-{n}")]);
    }
    assert_eq!(world.boot().device_status().unwrap().name, "three");
}

#[test]
fn a_torn_newest_generation_falls_back_to_the_last_complete_one() {
    let world = World::default();
    {
        let kernel = world.boot();
        block_on(kernel.set_name("complete".into())).unwrap();
    }

    // The crash the MANIFEST-last rule exists for: a `gen-2/state` that
    // landed and a `gen-2/MANIFEST` that never did.
    block_on(
        world
            .files
            .write(format!("/{ID}/gen-2/state"), b"half a write".to_vec()),
    );
    assert_eq!(world.generations(ID), ["gen-1", "gen-2"]);
    assert_eq!(world.boot().device_status().unwrap().name, "complete");

    // Same answer when the MANIFEST is there but disagrees with the bytes.
    block_on(world.files.write(
        format!("/{ID}/gen-2/MANIFEST"),
        br#"{"v":2,"generation":2,"sha256":"00"}"#.to_vec(),
    ));
    assert_eq!(world.boot().device_status().unwrap().name, "complete");

    // And the next checkpoint continues past the torn generation rather than
    // writing half of it again.
    let kernel = world.boot();
    block_on(kernel.set_name("after".into())).unwrap();
    assert_eq!(world.generations(ID), ["gen-3"]);
    assert_eq!(world.boot().device_status().unwrap().name, "after");
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
        .0
        .borrow()
        .iter()
        .map(|(k, v)| (k.replace(&format!("/{ID}/"), "/other/"), v.clone()))
        .collect();
    for (path, bytes) in moved {
        block_on(world.files.write(path, bytes));
    }
    let dek = world.kv.0.borrow()[&format!("dev/{ID}/dek")].clone();
    world.kv_put("dev/other/dek", dek);
    world.put_row(&IndexRow::fresh("other", world.clock.0.get()));

    // It boots — with nothing restored.
    let status = world.try_boot_as("other").unwrap().device_status().unwrap();
    assert_eq!(status.name, "");
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
    assert_eq!(kernel.tasks_revision(99), Err("unknown session".into()));
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
    assert_eq!(kernel.tasks_items(b).unwrap().items[0].id, id);
}

#[test]
fn every_mutation_advances_the_revision_and_ids_order_the_items() {
    let kernel = boot();
    let s = session(&kernel);
    assert_eq!(kernel.tasks_revision(s).unwrap(), 0);

    let first = block_on(kernel.tasks_add(s, "milk".into())).unwrap();
    let second = block_on(kernel.tasks_add(s, "bread".into())).unwrap();
    assert!(first < second, "ids sort in creation order");
    assert_eq!(kernel.tasks_revision(s).unwrap(), 2);

    block_on(kernel.tasks_set_completed(s, &first, true)).unwrap();
    block_on(kernel.tasks_set_title(s, &second, "rye".into())).unwrap();
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

    block_on(kernel.tasks_remove(s, &first)).unwrap();
    assert_eq!(kernel.tasks_revision(s).unwrap(), 5);
    assert_eq!(kernel.tasks_items(s).unwrap().items.len(), 1);

    // A failed mutation is not a mutation.
    assert!(block_on(kernel.tasks_remove(s, &first)).is_err());
    assert!(block_on(kernel.tasks_set_title(s, "nope", "x".into())).is_err());
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
