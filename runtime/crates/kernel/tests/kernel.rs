//! Native tests for the kernel. Everything the runtime component does is
//! reachable here because the component holds no logic of its own.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

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
        self.store.borrow_mut().insert(path, bytes);
        Box::pin(async { Ok(()) })
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
fn boot() -> Kernel {
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
