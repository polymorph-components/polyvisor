//! Two and three engines converging over in-memory transports, and a
//! snapshot restored into a fresh engine — the shape of
//! `subduction_runtime/tests/e2e.rs`: single-threaded `LocalPool`, no tokio,
//! `MemoryTransport::pair()` for the wire.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::task::Poll;

use future_form::Local;
use futures::future::LocalBoxFuture;
use futures::{executor::LocalPool, task::LocalSpawnExt as _};
use polyvisor_engine::{
    Engine, EngineClock, EngineEvent, EngineNotify, LocalFuture, Snapshot, Spawner, TaskSnapshot,
};
use subduction_protocol::event::Direction;
use subduction_runtime::memory::transport::MemoryTransport;
use subduction_runtime::transport::Transport;

const APP: &str = "todomvc";

/// A clock whose `sleep` never resolves: no protocol deadline should fire on
/// a happy path, and one that did would otherwise make the test hang rather
/// than fail (subduction_runtime/tests/common/mod.rs:36).
struct TestClock(Cell<u64>);

impl EngineClock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.set(self.0.get() + 1);
        self.0.get()
    }

    fn sleep(&self, _ms: u64) -> LocalFuture<'_, ()> {
        Box::pin(futures::future::pending())
    }
}

type TestEngine = Engine<MemoryTransport>;

/// An engine with its driver and event pump spawned on `pool`. `changes`
/// counts the remote changes the pump absorbed — the kernel's checkpoint
/// trigger.
struct Device {
    engine: Rc<TestEngine>,
    changes: Rc<Cell<u64>>,
    /// How many connections the pump reported closed.
    closed: Rc<Cell<u64>>,
}

fn device(pool: &LocalPool, seed: u8, snapshot: Option<Snapshot>) -> Device {
    let spawner = pool.spawner();
    let spawn: Spawner = {
        let spawner = spawner.clone();
        Rc::new(move |future: LocalBoxFuture<'static, ()>| {
            spawner
                .spawn_local(future)
                .expect("the local pool accepts tasks");
        })
    };
    let (engine, driver) = TestEngine::new(
        [seed; 32],
        Rc::new(TestClock(Cell::new(0))),
        Rc::clone(&spawn),
        snapshot,
    );
    let engine = Rc::new(engine);
    spawn(Box::pin(driver));

    let changes = Rc::new(Cell::new(0));
    let closed = Rc::new(Cell::new(0));
    let pump = {
        let engine = Rc::clone(&engine);
        let changes = Rc::clone(&changes);
        let closed = Rc::clone(&closed);
        let notify: EngineNotify = Rc::new(move |event| {
            match event {
                EngineEvent::Changed => changes.set(changes.get() + 1),
                EngineEvent::PeerClosed(_) => closed.set(closed.get() + 1),
            }
            Box::pin(async {})
        });
        async move { engine.pump_events(notify).await }
    };
    spawn(Box::pin(pump));
    Device {
        engine,
        changes,
        closed,
    }
}

/// Let every spawned task make progress until `check` answers `Some`.
///
/// `LocalPool::run_until` drives the whole pool, so yielding here is what
/// gives the drivers, read loops and event pumps their turns. Bounded, so a
/// wedged engine fails the test instead of hanging it.
async fn until<F, Fut, T>(mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..4096 {
        if let Some(found) = check().await {
            return found;
        }
        yield_now().await;
    }
    panic!("the engines never converged");
}

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

/// Wire two engines together, outbound from `a`, and wait for both
/// handshakes.
async fn wire(a: &TestEngine, b: &TestEngine) {
    let (ta, tb) = MemoryTransport::pair();
    let b_key = b.verifying_key();
    let inbound = RefCell::new(None);
    let (peer_a, ()) =
        futures::future::join(a.connect(ta, Direction::Outbound, Some(b_key)), async {
            *inbound.borrow_mut() = Some(b.connect(tb, Direction::Inbound, None).await);
        })
        .await;
    assert_eq!(
        peer_a.expect("a authenticates b"),
        b.peer_id(),
        "the dialed peer is the one we pinned"
    );
    assert_eq!(
        inbound
            .into_inner()
            .expect("b's connect resolved")
            .expect("b authenticates a"),
        a.peer_id(),
    );
}

fn titles(snapshot: &TaskSnapshot) -> Vec<String> {
    snapshot.items.iter().map(|i| i.title.clone()).collect()
}

#[test]
fn two_devices_converge_in_both_directions() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 1, None);
    let b = device(&pool, 2, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        ea.tasks_add(APP, "buy milk".into()).await.unwrap();
        ea.tasks_add(APP, "walk the dog".into()).await.unwrap();

        // B opens the app before dialing, as a kernel does for a session:
        // holding the document is what makes it ask for the tree.
        assert!(eb.tasks_items(APP).await.unwrap().items.is_empty());
        wire(&ea, &eb).await;

        let seen = until(|| async {
            let items = eb.tasks_items(APP).await.unwrap();
            (items.items.len() == 2).then_some(items)
        })
        .await;
        assert_eq!(titles(&seen), vec!["buy milk", "walk the dog"]);
        assert!(b.changes.get() > 0, "the pump reported the remote change");

        // The reverse direction: B toggles, A sees it, and A's revision moves.
        let before = ea.tasks_revision(APP).await.unwrap();
        let id = seen.items[0].id.clone();
        eb.tasks_set_completed(APP, &id, true).await.unwrap();

        let after = until(|| async {
            let items = ea.tasks_items(APP).await.unwrap();
            items.items[0].completed.then_some(items)
        })
        .await;
        assert!(
            after.revision > before,
            "a remote change advances the revision: {before} -> {}",
            after.revision
        );
        assert!(a.changes.get() > 0, "a's pump saw the remote change");
    });
}

#[test]
fn a_snapshot_restores_the_same_items() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 3, None);
    let ea = Rc::clone(&a.engine);

    let snapshot = pool.run_until(async move {
        ea.tasks_add(APP, "kept".into()).await.unwrap();
        let id = ea.tasks_add(APP, "toggled".into()).await.unwrap();
        ea.tasks_set_completed(APP, &id, true).await.unwrap();
        (ea.snapshot(), ea.tasks_items(APP).await.unwrap())
    });
    let (snapshot, before) = snapshot;

    let mut pool = LocalPool::new();
    let restored = device(&pool, 3, Some(snapshot));
    let engine = Rc::clone(&restored.engine);
    let after = pool.run_until(async move { engine.tasks_items(APP).await.unwrap() });
    assert_eq!(after, before, "the restored engine holds the same document");
}

#[test]
fn a_restored_device_still_converges() {
    // The snapshot must carry the tree, not just the document: a peer that
    // dials a rebooted device has to be able to pull its history.
    let mut pool = LocalPool::new();
    let a = device(&pool, 4, None);
    let ea = Rc::clone(&a.engine);
    let snapshot = pool
        .run_until(async move {
            ea.tasks_add(APP, "survives".into())
                .await
                .map(|_| ea.snapshot())
        })
        .unwrap();

    let mut pool = LocalPool::new();
    let a = device(&pool, 4, Some(snapshot));
    let b = device(&pool, 5, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        wire(&ea, &eb).await;
        let seen = until(|| async {
            let items = eb.tasks_items(APP).await.unwrap();
            (items.items.len() == 1).then_some(items)
        })
        .await;
        assert_eq!(titles(&seen), vec!["survives"]);
    });
}

#[test]
fn three_devices_converge_through_the_middle() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 6, None);
    let b = device(&pool, 7, None);
    let c = device(&pool, 8, None);
    let (ea, eb, ec) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&c.engine),
    );

    pool.run_until(async move {
        // A—B and B—C; A and C never meet.
        wire(&ea, &eb).await;
        wire(&eb, &ec).await;
        // Every device opens the app, so every device asks for the tree.
        for engine in [&ea, &eb, &ec] {
            let _items = engine.tasks_items(APP).await.unwrap();
        }

        ea.tasks_add(APP, "from a".into()).await.unwrap();
        ec.tasks_add(APP, "from c".into()).await.unwrap();

        for engine in [&ea, &eb, &ec] {
            let items = until(|| async {
                let items = engine.tasks_items(APP).await.unwrap();
                (items.items.len() == 2).then_some(items)
            })
            .await;
            let mut seen = titles(&items);
            seen.sort();
            assert_eq!(seen, vec!["from a", "from c"]);
        }
    });
}

#[test]
fn a_restored_engine_does_not_re_mint_the_id_it_last_used() {
    // The id used to come from a counter held beside the engine, which reset
    // to zero on restore: the first add after a reboot re-minted the first
    // id of the previous run and overwrote that task. The revision is a
    // property of the document, so it comes back with it.
    let mut pool = LocalPool::new();
    let a = device(&pool, 9, None);
    let ea = Rc::clone(&a.engine);
    let (snapshot, first) = pool.run_until(async move {
        let first = ea.tasks_add(APP, "before the reboot".into()).await.unwrap();
        (ea.snapshot(), first)
    });

    let mut pool = LocalPool::new();
    let restored = device(&pool, 9, Some(snapshot));
    let engine = Rc::clone(&restored.engine);
    pool.run_until(async move {
        let second = engine
            .tasks_add(APP, "after the reboot".into())
            .await
            .unwrap();
        assert_ne!(first, second, "a restored engine mints a fresh id");
        let items = engine.tasks_items(APP).await.unwrap();
        assert_eq!(
            titles(&items),
            vec!["before the reboot", "after the reboot"],
            "both tasks are present: the second did not overwrite the first"
        );
    });
}

#[test]
fn a_dead_connection_leaves_the_registry() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 10, None);
    let b = device(&pool, 11, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        let (ta, tb) = MemoryTransport::pair();
        // A second handle on B's end, to close the wire from outside.
        let b_wire = tb.clone();
        let b_key = eb.verifying_key();
        let inbound = RefCell::new(None);
        let _both =
            futures::future::join(ea.connect(ta, Direction::Outbound, Some(b_key)), async {
                *inbound.borrow_mut() = Some(eb.connect(tb, Direction::Inbound, None).await);
            })
            .await;
        assert_eq!(ea.live_connections(), 1);

        // B goes away: its end of the wire closes, which A's read loop sees
        // as a clean close and reports as `ConnectionClosed`.
        Transport::<Local>::disconnect(&b_wire).await;
        until(|| async { (ea.live_connections() == 0).then_some(()) }).await;
        assert_eq!(
            a.closed.get(),
            1,
            "and the caller was told once, so the kernel can close the row"
        );
    });
}
