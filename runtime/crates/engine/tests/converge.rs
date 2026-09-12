//! Two and three engines converging over in-memory transports, and a
//! snapshot restored into a fresh engine — the shape of
//! `subduction_runtime/tests/e2e.rs`: single-threaded `LocalPool`, no tokio,
//! `MemoryTransport::pair()` for the wire.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::task::Poll;

use automerge::{ROOT, ReadDoc, transaction::Transactable};
use future_form::Local;
use futures::future::LocalBoxFuture;
use futures::{executor::LocalPool, task::LocalSpawnExt as _};
use polyvisor_engine::{
    AppState, Engine, EngineClock, EngineEvent, EngineNotify, ItemKind, LocalFuture, OpaqueMode,
    Snapshot, Spawner, StoreItem, TreeState, document_tree,
};
use polyvisor_todo_model::Snapshot as TaskSnapshot;
use polyvisor_visor_model as visor;
use sedimentree_core::{
    blob::{Blob, BlobMeta},
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use sha2::Digest as _;
use subduction_crypto::{signed::Signed, signer::memory::MemorySigner};
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

#[test]
fn opaque_modes_round_trip_and_restore_without_fragments() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 80, None);
    let ea = Rc::clone(&a.engine);
    let snapshot = pool.run_until(async move {
        let sealed = ea
            .opaque_replace("sealed", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        let first = ea
            .opaque_publish(sealed, vec![], b"first".to_vec())
            .await
            .unwrap();
        let second = ea
            .opaque_publish(sealed, vec![first], b"second".to_vec())
            .await
            .unwrap();
        let caller = ea
            .opaque_replace("caller", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(caller, vec![], b"already encrypted".to_vec())
            .await
            .unwrap();
        assert_eq!(
            ea.opaque_read(sealed)
                .await
                .unwrap()
                .iter()
                .find(|i| i.id == second)
                .unwrap()
                .parents,
            vec![first]
        );
        assert_eq!(
            ea.opaque_read(caller).await.unwrap()[0].bytes,
            b"already encrypted"
        );
        assert!(
            !ea.items()
                .iter()
                .any(|item| item.tree == sealed && item.kind == ItemKind::Fragment)
        );

        (ea.snapshot().await.unwrap(), sealed)
    });
    let restored = device(&pool, 80, Some(snapshot.0));
    pool.run_until(async move {
        assert_eq!(
            restored.engine.opaque_current("sealed").await.unwrap(),
            Some(snapshot.1)
        );
        assert_eq!(
            restored.engine.opaque_read(snapshot.1).await.unwrap().len(),
            2
        );
    });
}

#[test]
fn opaque_retirement_purges_and_does_not_resurrect_from_store() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 81, None);
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        let old = ea
            .opaque_replace("slot", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(old, vec![], b"old".to_vec())
            .await
            .unwrap();
        let stale = ea
            .items()
            .into_iter()
            .filter(|item| item.tree == old)
            .collect::<Vec<_>>();
        let current = ea
            .opaque_replace("slot", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        assert_eq!(ea.opaque_status(&old), Some(false));
        assert_eq!(ea.opaque_status(&current), Some(true));
        assert!(ea.opaque_read(old).await.is_err());
        assert!(!ea.ingest_items(stale).await.unwrap());
        assert!(!ea.items().iter().any(|item| item.tree == old));
        ea.opaque_disable("slot").await.unwrap();
        assert_eq!(ea.opaque_current("slot").await.unwrap(), None);
        assert_eq!(ea.opaque_status(&current), Some(false));
    });
}

#[test]
fn opaque_peer_content_and_causal_references_converge_and_notify() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 82, None);
    let b = device(&pool, 83, None);
    let (ea, eb, changed) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&b.changes),
    );
    pool.run_until(async move {
        let tree = ea
            .opaque_replace("peer", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        enroll(&ea, &eb).await;
        assert_eq!(eb.opaque_current("peer").await.unwrap(), Some(tree));
        wire_only(&ea, &eb).await;
        let first = ea
            .opaque_publish(tree, vec![], b"first".to_vec())
            .await
            .unwrap();
        assert!(
            ea.items()
                .iter()
                .find(|item| item.tree == tree && item.commit == first)
                .is_some_and(|item| item.blob != b"first"),
            "group-sealed opaque plaintext reached storage"
        );
        let second = ea
            .opaque_publish(tree, vec![first], b"second".to_vec())
            .await
            .unwrap();
        let seen = until(|| async {
            let items = eb.opaque_read(tree).await.ok()?;
            (items.len() == 2).then_some(items)
        })
        .await;
        assert_eq!(
            seen.iter().find(|item| item.id == second).unwrap().parents,
            vec![first]
        );
        assert!(
            changed.get() > 0,
            "opaque receipt did not notify the kernel"
        );
    });
}

#[test]
fn opaque_parent_identity_is_a_canonical_set() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 84, None);
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        let tree = ea
            .opaque_replace("canonical", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        let parent_a = ea
            .opaque_publish(tree, vec![], b"parent a".to_vec())
            .await
            .unwrap();
        let parent_b = ea
            .opaque_publish(tree, vec![], b"parent b".to_vec())
            .await
            .unwrap();
        let first = ea
            .opaque_publish(
                tree,
                vec![parent_b, parent_a, parent_b],
                b"payload".to_vec(),
            )
            .await
            .unwrap();
        let second = ea
            .opaque_publish(tree, vec![parent_a, parent_b], b"payload".to_vec())
            .await
            .unwrap();
        assert_eq!(first, second);
        let item = ea
            .opaque_read(tree)
            .await
            .unwrap()
            .into_iter()
            .find(|item| item.id == first)
            .unwrap();
        let mut expected = vec![parent_a, parent_b];
        expected.sort_unstable();
        assert_eq!(item.parents, expected);
    });
}

#[test]
fn group_sealed_multi_parent_set_survives_peer_and_restore() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 106, None);
    let b = device(&pool, 107, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    let (snapshot, tree, child, expected) = pool.run_until(async move {
        enroll(&ea, &eb).await;
        let tree = ea
            .opaque_replace("sealed-canonical", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        eb.ingest_items(ea.items()).await.unwrap();
        let parent_a = ea
            .opaque_publish(tree, vec![], b"parent a".to_vec())
            .await
            .unwrap();
        let parent_b = ea
            .opaque_publish(tree, vec![], b"parent b".to_vec())
            .await
            .unwrap();
        let child = ea
            .opaque_publish(
                tree,
                vec![parent_b, parent_a, parent_b],
                b"multi-parent".to_vec(),
            )
            .await
            .unwrap();
        eb.ingest_items(ea.items()).await.unwrap();
        let mut expected = vec![parent_a, parent_b];
        expected.sort_unstable();
        assert_eq!(
            eb.opaque_read(tree)
                .await
                .unwrap()
                .into_iter()
                .find(|item| item.id == child)
                .unwrap()
                .parents,
            expected
        );
        (ea.snapshot().await.unwrap(), tree, child, expected)
    });
    let restored = device(&pool, 106, Some(snapshot));
    pool.run_until(async move {
        assert_eq!(
            restored
                .engine
                .opaque_read(tree)
                .await
                .unwrap()
                .into_iter()
                .find(|item| item.id == child)
                .unwrap()
                .parents,
            expected
        );
    });
}

fn tree_items(engine: &TestEngine, tree: [u8; 32]) -> Vec<StoreItem> {
    engine
        .items()
        .into_iter()
        .filter(|item| item.tree == tree)
        .collect()
}

#[test]
fn concurrent_opaque_register_winners_do_not_roll_back_on_stale_replay() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 85, None);
    let b = device(&pool, 86, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        let baseline_a: std::collections::BTreeSet<_> =
            tree_items(&ea, *polyvisor_engine::us_tree().as_bytes())
                .into_iter()
                .map(|item| item.commit)
                .collect();
        let baseline_b: std::collections::BTreeSet<_> =
            tree_items(&eb, *polyvisor_engine::us_tree().as_bytes())
                .into_iter()
                .map(|item| item.commit)
                .collect();
        let a_tree = ea
            .opaque_replace("race", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        let _b_tree = eb
            .opaque_replace("race", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        let a_control = tree_items(&ea, *polyvisor_engine::us_tree().as_bytes())
            .into_iter()
            .filter(|item| !baseline_a.contains(&item.commit))
            .collect::<Vec<_>>();
        let b_control = tree_items(&eb, *polyvisor_engine::us_tree().as_bytes())
            .into_iter()
            .filter(|item| !baseline_b.contains(&item.commit))
            .collect::<Vec<_>>();
        ea.ingest_items(b_control.clone()).await.unwrap();
        eb.ingest_items(a_control.clone()).await.unwrap();
        let winner = ea.opaque_current("race").await.unwrap();
        assert_eq!(winner, eb.opaque_current("race").await.unwrap());

        // A causally later disable beats either concurrent replacement. Old
        // controls replayed afterwards cannot resurrect either tree.
        ea.opaque_disable("race").await.unwrap();
        let disable = tree_items(&ea, *polyvisor_engine::us_tree().as_bytes());
        eb.ingest_items(disable).await.unwrap();
        ea.ingest_items(a_control).await.unwrap();
        ea.ingest_items(b_control).await.unwrap();
        assert_eq!(ea.opaque_current("race").await.unwrap(), None);
        assert_eq!(eb.opaque_current("race").await.unwrap(), None);
        assert_eq!(ea.opaque_status(&a_tree), Some(false));
    });
}

#[test]
fn unknown_raw_becomes_eligible_when_control_is_in_the_same_import() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 87, None);
    let b = device(&pool, 88, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        let tree = ea
            .opaque_replace("drive", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(tree, vec![], b"synthetic encrypted envelope".to_vec())
            .await
            .unwrap();
        assert_eq!(eb.opaque_status(&tree), None);
        let import = ea.items();
        assert!(eb.ingest_items(import).await.unwrap());
        assert_eq!(eb.opaque_current("drive").await.unwrap(), Some(tree));
        assert_eq!(eb.opaque_read(tree).await.unwrap().len(), 1);
    });
}

#[test]
fn opaque_created_after_connection_is_discovered_without_explicit_open() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 89, None);
    let b = device(&pool, 90, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        wire(&ea, &eb).await;
        let tree = ea
            .opaque_replace("late", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(tree, vec![], b"synthetic encrypted envelope".to_vec())
            .await
            .unwrap();
        until(|| async {
            (eb.opaque_current("late").await.ok()? == Some(tree)
                && eb.opaque_read(tree).await.ok()?.len() == 1)
                .then_some(())
        })
        .await;
    });
}

#[test]
fn preexisting_reverse_side_document_crosses_control_phases() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 91, None);
    let b = device(&pool, 92, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        ea.tasks_items("reverse-only").await.unwrap();
        eb.tasks_add("reverse-only", "from inbound".into())
            .await
            .unwrap();
        wire_only(&ea, &eb).await;
        until(|| async {
            (ea.tasks_items("reverse-only").await.ok()?.items.len() == 1).then_some(())
        })
        .await;
    });
}

#[test]
fn preexisting_reverse_side_raw_tree_crosses_catalog_phase() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 101, None);
    let b = device(&pool, 102, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        let tree = eb
            .opaque_replace("reverse-raw", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.ingest_items(tree_items(&eb, *polyvisor_engine::us_tree().as_bytes()))
            .await
            .unwrap();
        eb.opaque_publish(tree, vec![], b"synthetic encrypted envelope".to_vec())
            .await
            .unwrap();
        wire_only(&ea, &eb).await;
        until(|| async { (ea.opaque_read(tree).await.ok()?.len() == 1).then_some(()) }).await;
    });
}

#[test]
fn duplicate_peer_connection_is_rejected_without_revoking_ready_connection() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 103, None);
    let b = device(&pool, 104, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        wire(&ea, &eb).await;
        let (ta, tb) = MemoryTransport::pair();
        let attempts = futures::join!(
            ea.connect(ta, Direction::Outbound, Some(eb.verifying_key())),
            eb.connect(tb, Direction::Inbound, None),
        );
        assert!(attempts.0.is_ok() && attempts.1.is_ok());
        let tree = ea
            .opaque_replace("after-duplicate", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(tree, vec![], b"synthetic encrypted envelope".to_vec())
            .await
            .unwrap();
        until(|| async { (eb.opaque_read(tree).await.ok()?.len() == 1).then_some(()) }).await;
    });
}

#[test]
fn stale_snapshot_reconnect_learns_retirement_before_old_content_can_publish() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 93, None);
    let b = device(&pool, 94, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    let (stale, old, current) = pool.run_until(async move {
        enroll(&ea, &eb).await;
        let old = ea
            .opaque_replace("reconnect", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        eb.ingest_items(ea.items()).await.unwrap();
        let stale = eb.snapshot().await.unwrap();
        let current = ea
            .opaque_replace("reconnect", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        (stale, old, current)
    });
    let stale_peer = device(&pool, 94, Some(stale));
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        wire_only(&ea, &stale_peer.engine).await;
        until(|| async {
            (stale_peer.engine.opaque_current("reconnect").await.ok()? == Some(current))
                .then_some(())
        })
        .await;
        assert!(
            stale_peer
                .engine
                .opaque_publish(old, vec![], b"stale".to_vec())
                .await
                .is_err()
        );
        assert_eq!(stale_peer.engine.opaque_status(&old), Some(false));
    });
}

#[test]
fn raw_identity_and_blob_tampering_are_rejected() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 95, None);
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        let tree = ea
            .opaque_replace("identity", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        ea.opaque_publish(tree, vec![], b"synthetic encrypted envelope".to_vec())
            .await
            .unwrap();
        let item = tree_items(&ea, tree).pop().unwrap();
        assert!(ea.valid_store_item(&item));
        let mut relabelled = item.clone();
        relabelled.commit = [7; 32];
        assert!(!ea.valid_store_item(&relabelled));
        let mut swapped = item;
        swapped.blob.push(0);
        assert!(!ea.valid_store_item(&swapped));

        // A member can sign arbitrary metadata. Signature validity is not
        // enough: CallerEncrypted identity is derived from tree/parents/blob.
        let blob = b"synthetic encrypted envelope".to_vec();
        let forged = LooseCommit::new(
            SedimentreeId::new(tree),
            CommitId::new([9; 32]),
            Default::default(),
            BlobMeta::new(&Blob::new(blob.clone())),
        );
        let signed = Signed::seal::<Local, _>(&MemorySigner::from_bytes(&[95; 32]), forged)
            .await
            .into_signed();
        let forged = StoreItem {
            tree,
            commit: [9; 32],
            signed: signed.as_bytes().to_vec(),
            blob,
            kind: ItemKind::Commit,
        };
        assert!(!ea.ingest_items(vec![forged]).await.unwrap());
        assert!(
            !ea.items()
                .iter()
                .any(|item| item.tree == tree && item.commit == [9; 32])
        );
    });
}

#[test]
fn concurrent_replace_and_disable_choose_one_winner_and_stale_control_cannot_reverse_it() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 96, None);
    let b = device(&pool, 97, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        let baseline: std::collections::BTreeSet<_> =
            tree_items(&ea, *polyvisor_engine::us_tree().as_bytes())
                .into_iter()
                .map(|item| item.commit)
                .collect();
        ea.opaque_replace("mixed-race", OpaqueMode::CallerEncrypted)
            .await
            .unwrap();
        eb.opaque_disable("mixed-race").await.unwrap();
        let a_control = tree_items(&ea, *polyvisor_engine::us_tree().as_bytes())
            .into_iter()
            .filter(|item| !baseline.contains(&item.commit))
            .collect::<Vec<_>>();
        let b_control = tree_items(&eb, *polyvisor_engine::us_tree().as_bytes())
            .into_iter()
            .filter(|item| !baseline.contains(&item.commit))
            .collect::<Vec<_>>();
        ea.ingest_items(b_control.clone()).await.unwrap();
        eb.ingest_items(a_control.clone()).await.unwrap();
        let winner = ea.opaque_current("mixed-race").await.unwrap();
        assert_eq!(winner, eb.opaque_current("mixed-race").await.unwrap());
        ea.ingest_items(a_control).await.unwrap();
        eb.ingest_items(b_control).await.unwrap();
        assert_eq!(ea.opaque_current("mixed-race").await.unwrap(), winner);
        assert_eq!(eb.opaque_current("mixed-race").await.unwrap(), winner);
    });
}

#[test]
fn queued_same_slot_replacements_take_distinct_increasing_sequences() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 105, None);
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        let (first, second) = futures::join!(
            ea.opaque_replace("serialized", OpaqueMode::CallerEncrypted),
            ea.opaque_replace("serialized", OpaqueMode::GroupSealed),
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first, second);
        let winner = ea.opaque_current("serialized").await.unwrap().unwrap();
        assert!(winner == first || winner == second);
        let loser = if winner == first { second } else { first };
        assert_eq!(ea.opaque_status(&winner), Some(true));
        assert_eq!(ea.opaque_status(&loser), Some(false));
    });
}

#[test]
fn publication_racing_replacement_leaves_no_retired_payload() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 98, None);
    let ea = Rc::clone(&a.engine);
    pool.run_until(async move {
        let old = ea
            .opaque_replace("publish-race", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        let (published, replacement) = futures::join!(
            ea.opaque_publish(old, vec![], b"racing payload".to_vec()),
            ea.opaque_replace("publish-race", OpaqueMode::GroupSealed),
        );
        let current = replacement.unwrap();
        assert_ne!(old, current);
        assert_eq!(ea.opaque_status(&old), Some(false));
        assert!(tree_items(&ea, old).is_empty());
        if published.is_ok() {
            assert!(ea.opaque_read(old).await.is_err());
        }
    });
}

#[test]
fn retirement_clears_missing_ancestor_frontier_entries() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 99, None);
    let b = device(&pool, 100, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        enroll(&ea, &eb).await;
        let tree = ea
            .opaque_replace("missing-parent", OpaqueMode::GroupSealed)
            .await
            .unwrap();
        eb.ingest_items(ea.items()).await.unwrap();
        let parent = ea
            .opaque_publish(tree, vec![], b"parent".to_vec())
            .await
            .unwrap();
        let child = ea
            .opaque_publish(tree, vec![parent], b"child".to_vec())
            .await
            .unwrap();
        let mut child_only: Vec<_> = ea
            .items()
            .into_iter()
            .filter(|item| item.tree == *polyvisor_engine::keyhive_tree().as_bytes())
            .collect();
        child_only.extend(
            tree_items(&ea, tree)
                .into_iter()
                .filter(|item| item.commit == child),
        );
        eb.ingest_items(child_only).await.unwrap();
        assert_eq!(eb.opaque_read(tree).await.unwrap().len(), 1);
        assert!(
            eb.has_opaque_entry_point(tree, parent),
            "missing ancestor key was not retained"
        );
        eb.opaque_disable("missing-parent").await.unwrap();
        assert!(
            !eb.has_opaque_entry_point(tree, parent),
            "retirement retained the missing ancestor key"
        );
        assert!(
            !eb.has_opaque_entry_point(tree, child),
            "retirement retained the child key"
        );
    });
}

type TestEngine = Engine<MemoryTransport>;

/// Domain conveniences for sync integration tests. Production composition
/// lives in the kernel; the engine API itself remains schema-neutral.
trait Models {
    async fn tasks_items(&self, app: &str) -> Result<TaskSnapshot, String>;
    async fn tasks_add(&self, app: &str, title: String) -> Result<String, String>;
    async fn tasks_set_completed(&self, app: &str, id: &str, value: bool) -> Result<(), String>;
    async fn visor_personalization(&self) -> Result<visor::Personalization, String>;
    async fn set_visor_personalization(
        &self,
        hue: Option<Option<u16>>,
        fields: Vec<(Option<String>, String, Option<String>)>,
    ) -> Result<(), String>;
    async fn visor_save(&self) -> Result<Vec<u8>, String>;
    async fn adopt_visor(&self, bytes: &[u8]) -> Result<(), String>;
    async fn visor_route_key(&self) -> Result<([u8; 32], bool), String>;
    async fn visor_install(&self, app: &str) -> Result<([u8; 16], bool), String>;
    async fn visor_installs(&self) -> Result<Vec<([u8; 16], String)>, String>;
}

impl Models for TestEngine {
    async fn tasks_items(&self, app: &str) -> Result<TaskSnapshot, String> {
        self.document_read(app, polyvisor_todo_model::snapshot)
            .await
    }
    async fn tasks_add(&self, app: &str, title: String) -> Result<String, String> {
        self.document_mutate(app, move |doc| polyvisor_todo_model::add(doc, title))
            .await
    }
    async fn tasks_set_completed(&self, app: &str, id: &str, value: bool) -> Result<(), String> {
        let id = id.to_string();
        self.document_mutate(app, move |doc| {
            polyvisor_todo_model::set_completed(doc, &id, value)
        })
        .await
    }
    async fn visor_personalization(&self) -> Result<visor::Personalization, String> {
        self.document_read(visor::VISOR_APP, visor::personalization)
            .await
    }
    async fn set_visor_personalization(
        &self,
        hue: Option<Option<u16>>,
        fields: Vec<(Option<String>, String, Option<String>)>,
    ) -> Result<(), String> {
        self.document_mutate(visor::VISOR_APP, move |doc| {
            visor::set_personalization(doc, hue, fields)
        })
        .await
    }
    async fn visor_save(&self) -> Result<Vec<u8>, String> {
        self.document_save(visor::VISOR_APP).await
    }
    async fn adopt_visor(&self, bytes: &[u8]) -> Result<(), String> {
        self.document_adopt(visor::VISOR_APP, bytes, visor::adopt)
            .await
    }
    async fn visor_route_key(&self) -> Result<([u8; 32], bool), String> {
        let entropy = self.model_entropy();
        self.document_mutate(visor::VISOR_APP, move |doc| {
            let device = sha2::Sha256::digest(doc.actor_id()).into();
            visor::route_key_or_create(doc, device, entropy)
        })
        .await
    }
    async fn visor_install(&self, app: &str) -> Result<([u8; 16], bool), String> {
        let entropy = self.model_entropy();
        let app = app.to_string();
        self.document_mutate(visor::VISOR_APP, move |doc| {
            let device = sha2::Sha256::digest(doc.actor_id()).into();
            visor::install_or_create(doc, device, entropy, &app)
        })
        .await
    }
    async fn visor_installs(&self) -> Result<Vec<([u8; 16], String)>, String> {
        self.document_read(visor::VISOR_APP, visor::installs).await
    }
}

/// An engine with its driver and event pump spawned on `pool`. `changes`
/// counts the remote changes the pump absorbed — the kernel's checkpoint
/// trigger.
struct Device {
    engine: Rc<TestEngine>,
    changes: Rc<Cell<u64>>,
    /// How many connections the pump reported closed.
    closed: Rc<Cell<u64>>,
}

/// Node entropy for one start of one device: distinct per device and
/// distinct per start, as the kernel's `Rng` would give it.
fn entropy(seed: u8) -> [u8; 32] {
    use std::cell::Cell as StdCell;
    thread_local! {
        static STARTS: StdCell<u8> = const { StdCell::new(0) };
    }
    let nth = STARTS.with(|n| {
        n.set(n.get().wrapping_add(1));
        n.get()
    });
    let mut bytes = [0u8; 32];
    bytes[0] = seed;
    bytes[1] = nth;
    bytes
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
        // A device's node entropy is drawn fresh at every start, so a
        // restart is a *different* value with the same seed — which is the
        // whole point of the parameter (`Engine::new`). `restarts` counts
        // the times this seed has been brought up in one test.
        entropy(seed),
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

#[test]
fn personalization_fields_merge_and_clears_survive_reload() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 71, None);
    let b = device(&pool, 72, None);
    pool.run_until(async {
        wire(&a.engine, &b.engine).await;
        a.engine
            .set_visor_personalization(
                Some(Some(42)),
                vec![(None, "petname".into(), Some("A".into()))],
            )
            .await
            .unwrap();
        b.engine
            .set_visor_personalization(
                None,
                vec![(Some(APP.into()), "glyph".into(), Some("✓".into()))],
            )
            .await
            .unwrap();
        until(|| async {
            let pa = a.engine.visor_personalization().await.ok()?;
            let pb = b.engine.visor_personalization().await.ok()?;
            (pa == pb && pa.hue == Some(42)).then_some(())
        })
        .await;
        a.engine
            .set_visor_personalization(None, vec![(Some(APP.into()), "glyph".into(), None)])
            .await
            .unwrap();
        until(|| async {
            b.engine
                .visor_personalization()
                .await
                .ok()?
                .apps
                .get(APP)
                .is_none_or(|m| !m.contains_key("glyph"))
                .then_some(())
        })
        .await;
    });
    let saved = pool.run_until(a.engine.snapshot()).unwrap();
    let restored = device(&pool, 71, Some(saved));
    let p = pool
        .run_until(restored.engine.visor_personalization())
        .unwrap();
    assert_eq!(p.hue, Some(42));
    assert!(p.apps.get(APP).is_none_or(|m| !m.contains_key("glyph")));
}

#[test]
fn concurrent_same_personalization_field_resolves_identically() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 73, None);
    let b = device(&pool, 74, None);
    pool.run_until(async {
        wire(&a.engine, &b.engine).await;
        a.engine
            .set_visor_personalization(None, vec![(None, "petname".into(), Some("alpha".into()))])
            .await
            .unwrap();
        b.engine
            .set_visor_personalization(None, vec![(None, "petname".into(), Some("beta".into()))])
            .await
            .unwrap();
        until(|| async {
            let pa = a.engine.visor_personalization().await.ok()?;
            let pb = b.engine.visor_personalization().await.ok()?;
            (pa.user.get("petname") == pb.user.get("petname")).then_some(())
        })
        .await;
    });
}

#[test]
fn joining_device_adopts_group_personalization_not_its_prior_values() {
    let mut pool = LocalPool::new();
    let group = device(&pool, 75, None);
    let joiner = device(&pool, 76, None);
    pool.run_until(async {
        group
            .engine
            .set_visor_personalization(
                Some(Some(25)),
                vec![(None, "petname".into(), Some("owner".into()))],
            )
            .await
            .unwrap();
        joiner
            .engine
            .set_visor_personalization(
                Some(Some(300)),
                vec![
                    (None, "petname".into(), Some("other".into())),
                    (
                        Some("joiner-only".into()),
                        "petname".into(),
                        Some("local app".into()),
                    ),
                ],
            )
            .await
            .unwrap();
        enroll(&group.engine, &joiner.engine).await;
        let bytes = group.engine.visor_save().await.unwrap();
        joiner.engine.adopt_visor(&bytes).await.unwrap();
        let adopted = joiner.engine.visor_personalization().await.unwrap();
        assert_eq!(adopted.hue, Some(25));
        assert_eq!(
            adopted.user.get("petname").map(String::as_str),
            Some("owner")
        );
        assert_eq!(
            adopted
                .apps
                .get("joiner-only")
                .and_then(|m| m.get("petname"))
                .map(String::as_str),
            Some("local app")
        );
        wire_only(&group.engine, &joiner.engine).await;
        joiner
            .engine
            .set_visor_personalization(
                None,
                vec![(None, "petname".into(), Some("after join".into()))],
            )
            .await
            .unwrap();
        until(|| async {
            (group
                .engine
                .visor_personalization()
                .await
                .ok()?
                .user
                .get("petname")
                .map(String::as_str)
                == Some("after join"))
            .then_some(())
        })
        .await;
    });
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
    // The engine syncs within its group and nowhere else (`GroupPolicy`), so
    // the two devices are in one first — `a` enrolling `b` exactly as an
    // adder does at the end of pairing, and `b` adopting the document rather
    // than merging its own group of one into it.
    enroll(a, b).await;

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

/// The enrollment half of pairing, driven through the engine API exactly as
/// `kernel::pairing` drives it: the joiner's keyhive contact card goes to the
/// adder, the adder writes the joiner into the group document and into the
/// keyhive group, and the joiner adopts both.
async fn enroll(adder: &TestEngine, joiner: &TestEngine) {
    let card = joiner.keyhive_card().await.unwrap();
    adder
        .add_member(joiner.verifying_key().to_bytes(), String::new(), 0)
        .await
        .unwrap();
    let (keyhive, read_back) = adder
        .enroll_keyhive(&card, joiner.verifying_key().to_bytes())
        .await
        .unwrap();
    joiner
        .adopt_us(
            &adder.us_save().await.unwrap(),
            adder.verifying_key().to_bytes(),
            adder.name_key().expect("the adder founded a group"),
        )
        .await
        .unwrap();
    joiner.adopt_keyhive(&keyhive, &read_back).await.unwrap();
}

/// Wire two engines together without enrolling: the group is already shared.
async fn wire_only(a: &TestEngine, b: &TestEngine) {
    let (ta, tb) = MemoryTransport::pair();
    let b_key = b.verifying_key();
    let inbound = RefCell::new(None);
    let _ = futures::future::join(a.connect(ta, Direction::Outbound, Some(b_key)), async {
        *inbound.borrow_mut() = Some(b.connect(tb, Direction::Inbound, None).await);
    })
    .await;
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

        // The reverse direction: B toggles and A sees the changed item.
        let id = seen.items[0].id.clone();
        eb.tasks_set_completed(APP, &id, true).await.unwrap();

        let after = until(|| async {
            let items = ea.tasks_items(APP).await.unwrap();
            items.items[0].completed.then_some(items)
        })
        .await;
        assert!(after.items[0].completed);
        assert!(a.changes.get() > 0, "a's pump saw the remote change");
    });
}

#[test]
fn generic_mutation_publishes_every_transaction_even_before_a_domain_error() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 41, None);
    let b = device(&pool, 42, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    let saved = pool.run_until(async move {
        eb.document_read("generic", |_| ()).await.unwrap();
        wire(&ea, &eb).await;
        ea.document_mutate("generic", |doc| {
            doc.transact(|tx| tx.put(ROOT, "one", 1).map_err(|e| e.to_string()))?;
            doc.transact(|tx| tx.put(ROOT, "two", 2).map_err(|e| e.to_string()))
        })
        .await
        .unwrap();
        let error = ea
            .document_mutate("generic", |doc| {
                doc.transact(|tx| tx.put(ROOT, "before-error", 3).map_err(|e| e.to_string()))?;
                Err::<(), _>("domain refused the rest".to_string())
            })
            .await
            .unwrap_err();
        assert_eq!(error, "domain refused the rest");
        until(|| async {
            eb.document_read("generic", |doc| {
                ["one", "two", "before-error"]
                    .into_iter()
                    .all(|key| doc.read().get(ROOT, key).ok().flatten().is_some())
            })
            .await
            .ok()
            .filter(|seen| *seen)
        })
        .await;
        ea.snapshot().await.unwrap()
    });

    let restored = device(&pool, 41, Some(saved));
    pool.run_until(async {
        let count = restored
            .engine
            .document_read("generic", |doc| {
                ["one", "two", "before-error"]
                    .into_iter()
                    .filter(|key| doc.read().get(ROOT, *key).ok().flatten().is_some())
                    .count()
            })
            .await
            .unwrap();
        assert_eq!(count, 3);
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
        (
            ea.snapshot().await.unwrap(),
            ea.tasks_items(APP).await.unwrap(),
        )
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
    let snapshot = pool.run_until(async move {
        ea.tasks_add(APP, "survives".into()).await.unwrap();
        ea.snapshot().await.unwrap()
    });

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
        (ea.snapshot().await.unwrap(), first)
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
fn a_dead_connection_notifies_the_caller_once() {
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
        // B goes away: its end of the wire closes, which A's read loop sees
        // as a clean close and reports as `ConnectionClosed`.
        Transport::<Local>::disconnect(&b_wire).await;
        until(|| async { (a.closed.get() == 1).then_some(()) }).await;
        assert_eq!(
            a.closed.get(),
            1,
            "and the caller was told once, so the kernel can close the row"
        );
    });
}

/// One device's group, keyed and ordered as the document reports it.
async fn members(engine: &TestEngine) -> Vec<(Vec<u8>, String, u64)> {
    engine
        .members()
        .await
        .unwrap()
        .into_iter()
        .map(|m| (m.key.to_vec(), m.petname, m.enrolled))
        .collect()
}

#[test]
fn the_group_a_joiner_adopts_is_the_group_the_adder_has() {
    // Adoption is a replace, and what replaces the joiner's group of one has
    // to be the adder's group exactly — not a merge of the two, and not a
    // document that then drifts. The third enrollment proves the joiner is
    // on the same lineage: it arrives over the tree, with nobody adopting
    // anything.
    let mut pool = LocalPool::new();
    let a = device(&pool, 20, None);
    let b = device(&pool, 21, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        wire(&ea, &eb).await;
        assert_eq!(members(&ea).await, members(&eb).await);
        assert_eq!(members(&ea).await.len(), 2);

        ea.add_member([9u8; 32], "the third".into(), 77)
            .await
            .unwrap();
        let seen = until(|| async {
            let group = members(&eb).await;
            (group.len() == 3).then_some(group)
        })
        .await;
        assert_eq!(seen, members(&ea).await);
        assert!(
            seen.iter().any(|(_, petname, _)| petname == "the third"),
            "the petname the adder wrote travelled with the key: {seen:?}",
        );
    });
}

#[test]
fn a_group_this_device_is_not_in_is_not_adopted() {
    // ENROLL is checked before anything local is discarded. A document that
    // does not open, or that does not hold both this device and the one that
    // sent it, leaves the joiner with the group of one it started with —
    // still able to show a fresh code and try again.
    let mut pool = LocalPool::new();
    let a = device(&pool, 22, None);
    let b = device(&pool, 23, None);
    let c = device(&pool, 24, None);
    let (ea, eb, ec) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&c.engine),
    );

    pool.run_until(async move {
        // A's group of one, which B was never enrolled into.
        let orphan = ea.us_save().await.unwrap();
        let adder = ea.verifying_key().to_bytes();
        let why = eb.adopt_us(&orphan, adder, [7u8; 32]).await.unwrap_err();
        assert!(why.contains("this one is not in"), "{why}");

        let why = eb
            .adopt_us(b"not a document at all", adder, [7u8; 32])
            .await
            .unwrap_err();
        assert!(why.contains("cannot read"), "{why}");

        // B enrolled itself and A into a group A knows nothing about, then
        // claims A sent it: A is not in it, so it is not the group B just
        // compared six digits over.
        ec.add_member(eb.verifying_key().to_bytes(), "b".into(), 1)
            .await
            .unwrap();
        let stranger = ec.us_save().await.unwrap();
        let why = eb.adopt_us(&stranger, adder, [7u8; 32]).await.unwrap_err();
        assert!(why.contains("not in itself"), "{why}");

        assert_eq!(members(&eb).await.len(), 1, "B is still its own group");
    });
}

/// What rests in storage — and so what crosses the wire and sits on a relay —
/// is a keyhive envelope, and a party holding those bytes without being in the
/// group gets nothing from them.
#[test]
fn commits_at_rest_are_envelopes_a_stranger_cannot_open() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 12, None);
    let ea = Rc::clone(&a.engine);
    let sealed = pool.run_until(async move {
        ea.tasks_add(APP, "buy milk".into()).await.unwrap();
        ea.snapshot().await.unwrap()
    });

    let blobs: Vec<Vec<u8>> = sealed
        .apps
        .iter()
        .flat_map(|app| app.state.commits.iter().map(|item| item.blob.clone()))
        .collect();
    assert!(!blobs.is_empty(), "the task produced no commit");
    for blob in &blobs {
        assert!(
            !blob.windows(8).any(|w| w == b"buy milk"),
            "a commit blob carries the plaintext title"
        );
    }

    // A store or relay that ended up with the blobs and nothing else: the
    // sedimentree items, without the saved automerge document (which is the
    // kernel's sealed checkpoint, not anything that crosses a wire), without
    // this group's user-system document, and without its keyhive.
    let stranger = Snapshot {
        apps: sealed
            .apps
            .iter()
            .map(|app| AppState {
                app: app.app.clone(),
                state: TreeState {
                    doc: Vec::new(),
                    ..app.state.clone()
                },
            })
            .collect(),
        us: None,
        name_key: None,
        keyhive: None,
        vault: None,
        opaque: Vec::new(),
    };
    let mut pool = LocalPool::new();
    let outsider = device(&pool, 13, Some(stranger));
    let engine = Rc::clone(&outsider.engine);
    let items = pool.run_until(async move { engine.tasks_items(APP).await.unwrap() });
    assert!(
        items.items.is_empty(),
        "a non-member opened the group's envelopes: {:?}",
        titles(&items)
    );
}

/// The causal walk, pinned: a joiner given the content key of the *newest*
/// commit only — not the whole read-back set — still materializes the entire
/// ancestry behind it.
///
/// This causal-key read-back is why the sealed plaintext is keyhive's own
/// `Envelope` rather than a look-alike: the walk deserializes an `Envelope`
/// out of every plaintext it opens, so a parallel format would fail here and
/// nowhere else.
#[test]
fn a_joiner_walks_the_ancestry_from_a_single_key() {
    use sedimentree_core::loose_commit::LooseCommit;
    use subduction_crypto::signed::Signed;

    let mut pool = LocalPool::new();
    let a = device(&pool, 14, None);
    let ea = Rc::clone(&a.engine);
    let sealed = pool.run_until(async move {
        for title in ["first", "second", "third"] {
            ea.tasks_add(APP, title.into()).await.unwrap();
        }
        ea.snapshot().await.unwrap()
    });

    // The newest commit is the one no other commit names as a parent. Read
    // structurally out of the sedimentree rather than assumed from write
    // order, so the test pins the walk and not the engine's bookkeeping.
    let commits: Vec<LooseCommit> = sealed
        .apps
        .iter()
        .flat_map(|app| app.state.commits.iter())
        .map(|item| {
            Signed::<LooseCommit>::try_decode(&item.signed)
                .expect("a stored commit envelope decodes")
                .try_decode_trusted_payload()
                .expect("a stored commit decodes")
        })
        .collect();
    assert_eq!(commits.len(), 3, "three tasks, three commits");
    let newest = commits
        .iter()
        .find(|commit| {
            !commits
                .iter()
                .any(|other| other.parents().contains(&commit.head()))
        })
        .expect("the history has a head")
        .head();

    let mut pool = LocalPool::new();
    let a = device(&pool, 14, Some(sealed));
    let b = device(&pool, 15, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));
    pool.run_until(async move {
        let card = eb.keyhive_card().await.unwrap();
        ea.add_member(eb.verifying_key().to_bytes(), String::new(), 0)
            .await
            .unwrap();
        let (keyhive, read_back) = ea
            .enroll_keyhive(&card, eb.verifying_key().to_bytes())
            .await
            .unwrap();

        // Everything the adder would normally hand over, cut down to the one
        // key the newest commit was sealed under.
        let all: Vec<([u8; 32], [u8; 32])> = bincode::deserialize(&read_back).unwrap();
        let only_newest: Vec<([u8; 32], [u8; 32])> = all
            .into_iter()
            .filter(|(cref, _)| cref == newest.as_bytes())
            .collect();
        assert_eq!(
            only_newest.len(),
            1,
            "the head's own key is in the hand-over"
        );
        let trimmed = bincode::serialize(&only_newest).unwrap();

        eb.adopt_us(
            &ea.us_save().await.unwrap(),
            ea.verifying_key().to_bytes(),
            ea.name_key().expect("A founded a group"),
        )
        .await
        .unwrap();
        eb.adopt_keyhive(&keyhive, &trimmed).await.unwrap();

        let (ta, tb) = MemoryTransport::pair();
        let b_key = eb.verifying_key();
        let inbound = RefCell::new(None);
        let _ = futures::future::join(ea.connect(ta, Direction::Outbound, Some(b_key)), async {
            *inbound.borrow_mut() = Some(eb.connect(tb, Direction::Inbound, None).await);
        })
        .await;

        let items = until(|| async {
            let items = eb.tasks_items(APP).await.unwrap();
            (items.items.len() == 3).then_some(items)
        })
        .await;
        let mut seen = titles(&items);
        seen.sort();
        assert_eq!(
            seen,
            vec!["first", "second", "third"],
            "the walk did not reach the whole ancestry"
        );
    });
}

/// ENROLL hands over the group's *operations*, never the adder's keyhive
/// archive: an archive carries `active.prekey_pairs`, which are the adder's
/// own secrets. The strong form of the check is the round-trip — re-encoding
/// the decoded operation list reproduces the payload byte for byte, so there
/// is nothing else in it.
#[test]
fn the_enrollment_payload_is_an_operation_list_and_nothing_else() {
    use keyhive_core::archive::Archive;
    use keyhive_core::event::static_event::StaticEvent;

    let mut pool = LocalPool::new();
    let a = device(&pool, 16, None);
    let b = device(&pool, 17, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        ea.tasks_add(APP, "already here".into()).await.unwrap();
        let card = eb.keyhive_card().await.unwrap();
        ea.add_member(eb.verifying_key().to_bytes(), String::new(), 0)
            .await
            .unwrap();
        let (keyhive, _read_back) = ea
            .enroll_keyhive(&card, eb.verifying_key().to_bytes())
            .await
            .unwrap();

        let events: Vec<StaticEvent<[u8; 32]>> = bincode::deserialize(&keyhive)
            .expect("the enrollment payload is a list of keyhive operations");
        assert!(!events.is_empty(), "an enrollment with no operations");
        assert_eq!(
            bincode::serialize(&events).unwrap(),
            keyhive,
            "the payload carries something besides the operation list"
        );
        assert!(
            bincode::deserialize::<Archive<[u8; 32]>>(&keyhive).is_err(),
            "the enrollment payload is a keyhive archive, which carries the adder's prekey secrets"
        );
    });
}

/// The keyhive card is bound to the key the SAS ceremony authenticated. A card
/// naming any other identity is refused, so the membership grant cannot land
/// on a device other than the one the two users compared digits for.
#[test]
fn a_card_for_another_key_is_not_enrolled() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 18, None);
    let b = device(&pool, 19, None);
    let c = device(&pool, 20, None);
    let (ea, eb, ec) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&c.engine),
    );

    pool.run_until(async move {
        // C's card offered under B's key: the ceremony authenticated B.
        let elsewhere = ec.keyhive_card().await.unwrap();
        let refused = ea
            .enroll_keyhive(&elsewhere, eb.verifying_key().to_bytes())
            .await;
        assert!(
            refused.is_err(),
            "a card for another key was enrolled: {refused:?}"
        );
        // And the honest card still works, so the check is not simply refusing.
        let card = eb.keyhive_card().await.unwrap();
        ea.enroll_keyhive(&card, eb.verifying_key().to_bytes())
            .await
            .unwrap();
    });
}

// -- what a store hands back -------------------------------------------------

/// The app-tree item A authored for its one task, as the store carries it.
fn app_item(engine: &TestEngine) -> StoreItem {
    let tree = *polyvisor_engine::document_tree(APP).as_bytes();
    engine
        .items()
        .into_iter()
        .find(|item| item.tree == tree)
        .expect("the task's commit is in the app tree")
}

#[test]
fn a_store_does_not_get_to_decide_what_an_item_is() {
    // A store is not a peer: nothing has checked a signature, a membership or
    // a name on the way in, so `ingest_items` checks all of them. Each case
    // here is one of those checks, and the pristine item at the end is the
    // control that says the rejections were the tampering and not the harness.
    let mut pool = LocalPool::new();
    let a = device(&pool, 1, None);
    let b = device(&pool, 2, None);
    // A third device, in nobody's group: what an item authored by a stranger
    // and filed under the group's own name looks like.
    let outsider = device(&pool, 3, None);
    let (ea, eb, eo) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&outsider.engine),
    );

    pool.run_until(async move {
        enroll(&ea, &eb).await;
        ea.tasks_add(APP, "buy milk".into()).await.unwrap();
        eo.tasks_add(APP, "not from the group".into())
            .await
            .unwrap();
        let good = app_item(&ea);
        let stranger = app_item(&eo);

        // B holds A's group and A's keyhive, and nothing of the task yet.
        assert!(eb.tasks_items(APP).await.unwrap().items.is_empty());

        let forged = StoreItem {
            signed: {
                let mut bytes = good.signed.clone();
                // The last bytes are the signature (subduction_crypto's
                // envelope is schema ‖ issuer ‖ fields ‖ signature).
                let last = bytes.len() - 1;
                bytes[last] ^= 0x01;
                bytes
            },
            ..good.clone()
        };
        let unsigned = StoreItem {
            signed: b"not an envelope at all".to_vec(),
            ..good.clone()
        };
        let relabelled_tree = StoreItem {
            tree: *polyvisor_engine::us_tree().as_bytes(),
            ..good.clone()
        };
        let relabelled_commit = StoreItem {
            commit: [9u8; 32],
            ..good.clone()
        };
        let swapped_blob = StoreItem {
            blob: {
                let mut blob = good.blob.clone();
                blob.push(0);
                blob
            },
            ..good.clone()
        };

        for (what, item) in [
            ("a signature that does not verify", forged),
            ("bytes that are not an envelope", unsigned),
            ("an item filed under another tree", relabelled_tree),
            ("an item named by another commit id", relabelled_commit),
            ("a blob the commit did not commit to", swapped_blob),
            ("an item authored outside the group", stranger),
        ] {
            assert!(
                !eb.ingest_items(vec![item]).await.unwrap(),
                "{what} was installed"
            );
            assert!(
                eb.tasks_items(APP).await.unwrap().items.is_empty(),
                "{what} reached the document"
            );
        }

        // The control: the same item, untouched, does land — and the
        // document it lands in is the one the group is sharing.
        assert!(eb.ingest_items(vec![good.clone()]).await.unwrap());
        assert_eq!(
            titles(&eb.tasks_items(APP).await.unwrap()),
            vec!["buy milk"]
        );
        // And again is not news: the store re-offering what this device holds
        // must not read as a change to checkpoint.
        assert!(!eb.ingest_items(vec![good]).await.unwrap());
    });
}

/// The frontier is a set, and divergence is what makes it bigger than one.
///
/// Two devices write while apart, so the document has two branches off one
/// root; each device then holds an entry point per branch it cannot reach from
/// the other (`design/causal_encryption.md` §"Multiple Heads"). What it does
/// *not* hold is a key per commit: the root's key rides inside its children's
/// envelopes and is dropped from the frontier as soon as one of them is read.
#[test]
fn concurrent_branches_leave_one_entry_point_each() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 40, None);
    let b = device(&pool, 41, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        ea.tasks_add(APP, "root".into()).await.unwrap();
        enroll(&ea, &eb).await;
        assert_eq!(
            ea.entry_points().await.unwrap(),
            1,
            "a linear history is one entry point"
        );

        // Apart: B has never synced, so its write branches from nothing while
        // A's extends the root.
        ea.tasks_add(APP, "branch a".into()).await.unwrap();
        eb.tasks_add(APP, "branch b".into()).await.unwrap();
        assert_eq!(
            ea.entry_points().await.unwrap(),
            1,
            "A extended its own history and stayed at one entry point"
        );
        assert_eq!(
            eb.entry_points().await.unwrap(),
            2,
            "B holds the root it was enrolled with and its own concurrent branch"
        );

        wire_only(&ea, &eb).await;
        let merged = until(|| async {
            let items = ea.tasks_items(APP).await.unwrap();
            (items.items.len() == 3).then_some(items)
        })
        .await;
        let mut seen = titles(&merged);
        seen.sort();
        assert_eq!(seen, vec!["branch a", "branch b", "root"]);
        for _ in 0..500 {
            yield_now().await;
        }

        // Both anchored the merge, and those two anchors are themselves
        // concurrent — two branches, two entry points, and no third anchor:
        // an anchor is not content, and only content is worth anchoring for.
        // Bounded by concurrency, not by history length, which is the whole
        // claim.
        for engine in [&ea, &eb] {
            assert_eq!(
                engine.entry_points().await.unwrap(),
                2,
                "the frontier grew past the number of live branches"
            );
        }
    });
}

/// A device enrolled while another was offline still reads that device's
/// branch, without waiting for anyone to write again.
///
/// This is the partition case: B's writes were sealed under an epoch that
/// predates C's enrolment, so C can decrypt neither them nor anything automerge
/// buffers behind them. The device that *can* read both — A — republishes the
/// branch by anchoring the merge, and C walks in from there
/// (`design/causal_encryption.md` §"Multiple Heads": a branch is connected "by
/// supplying a new head for it").
#[test]
fn a_branch_written_before_a_joiner_existed_reaches_it_through_the_anchor() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 30, None);
    let b = device(&pool, 31, None);
    let c = device(&pool, 32, None);
    let (ea, eb, ec) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&c.engine),
    );

    pool.run_until(async move {
        ea.tasks_add(APP, "from a".into()).await.unwrap();
        enroll(&ea, &eb).await;
        // B never connects: it writes into a partition. It has never synced,
        // so its app tree holds exactly this one commit.
        eb.tasks_add(APP, "from b offline".into()).await.unwrap();
        let b_commit = {
            let mut own: Vec<[u8; 32]> = eb
                .items()
                .iter()
                .filter(|item| item.tree == *document_tree(APP).as_bytes())
                .map(|item| item.commit)
                .collect();
            assert_eq!(own.len(), 1, "B wrote more than the one commit");
            own.pop().expect("B's own commit")
        };
        // C is enrolled meanwhile, so its epoch begins after B's write.
        enroll(&ea, &ec).await;

        wire_only(&ea, &eb).await;
        let _merged = until(|| async {
            let items = ea.tasks_items(APP).await.unwrap();
            (items.items.len() == 2).then_some(items)
        })
        .await;

        // Delivered to C through the store, in two batches with the anchor
        // first — so the claim "without anyone writing again" is pinned across
        // separate deliveries and not just within one sync.
        assert!(ec.tasks_items(APP).await.unwrap().items.is_empty());
        let (branch, rest): (Vec<_>, Vec<_>) = ea
            .items()
            .into_iter()
            .partition(|item| item.commit == b_commit);
        assert_eq!(branch.len(), 1, "B's offline commit is not in what A holds");

        let _landed = ec.ingest_items(rest).await.unwrap();
        for _ in 0..200 {
            yield_now().await;
        }
        let _landed = ec.ingest_items(branch).await.unwrap();
        let seen = until(|| async {
            let items = ec.tasks_items(APP).await.unwrap();
            (items.items.len() == 2).then_some(items)
        })
        .await;
        let mut seen = titles(&seen);
        seen.sort();
        assert_eq!(
            seen,
            vec!["from a", "from b offline"],
            "the joiner never reached the branch written before it existed"
        );
    });
}

/// Out-of-order delivery: the child arrives in one batch and its parents in
/// the next, and the parents still open.
///
/// This is the store path rather than the peer path, because a store hands back
/// whatever it happened to list — there is no causal order in a bucket (keyhive
/// `design/causal_encryption.md` §"Crypt Store": "there is no dependency on
/// ordering between encrypted blobs").
///
/// The joiner holds one entry point, the head. Batch one gives it that head and
/// nothing below; the walk opens it and reads out the keys of ancestors whose
/// ciphertext has not arrived (`CausalDecryptionState::next`). Those keys are
/// the only way those commits will ever be opened: they predate the joiner's
/// enrolment, so no epoch of its own reaches them, and once the head is applied
/// no later batch can re-derive them. Batch two delivers them and nothing else,
/// with nobody writing anything.
#[test]
fn parents_delivered_after_their_child_still_open() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 50, None);
    let c = device(&pool, 52, None);
    let (ea, ec) = (Rc::clone(&a.engine), Rc::clone(&c.engine));

    pool.run_until(async move {
        let app_tree = *document_tree(APP).as_bytes();
        let app_commits = |engine: &TestEngine| -> Vec<[u8; 32]> {
            engine
                .items()
                .iter()
                .filter(|item| item.tree == app_tree)
                .map(|item| item.commit)
                .collect()
        };

        ea.tasks_add(APP, "first".into()).await.unwrap();
        ea.tasks_add(APP, "second".into()).await.unwrap();
        let older = app_commits(&ea);
        assert_eq!(older.len(), 2, "two commits so far");
        ea.tasks_add(APP, "third".into()).await.unwrap();

        // C is enrolled now, so every one of those three commits predates its
        // epoch: the head's key, handed over at enrolment, is its only way in.
        enroll(&ea, &ec).await;

        let (parents, first): (Vec<_>, Vec<_>) = ea
            .items()
            .into_iter()
            .partition(|item| item.tree == app_tree && older.contains(&item.commit));
        assert_eq!(
            parents.len(),
            2,
            "exactly the two older commits are held back"
        );

        // C opens the app before either delivery: without a document the
        // items would just sit in storage and both batches would be opened
        // together on the first read, which is not what this is testing.
        assert!(ec.tasks_items(APP).await.unwrap().items.is_empty());

        let _landed = ec.ingest_items(first).await.unwrap();
        for _ in 0..200 {
            yield_now().await;
        }
        assert!(
            ec.tasks_items(APP).await.unwrap().items.is_empty(),
            "the head alone should materialize nothing: its parents are missing"
        );
        // Batch two: the parents, alone. Nothing writes.
        let _landed = ec.ingest_items(parents).await.unwrap();
        let seen = until(|| async {
            let items = ec.tasks_items(APP).await.unwrap();
            (items.items.len() == 3).then_some(items)
        })
        .await;
        assert_eq!(
            titles(&seen),
            vec!["first", "second", "third"],
            "the parents delivered after their child were never opened"
        );
    });
}

// -- compaction ---------------------------------------------------------------

/// Add tasks until automerge closes a level-1 fragment over the app tree.
///
/// A commit heads a level-1 fragment when its hash starts with a zero byte,
/// so this is a geometric draw with p = 1/256 — about 256 mutations, and the
/// bound is generous rather than tuned. It is also the only way to reach the
/// case: the threshold is the hash's own, there is no knob, and picking
/// titles to hit it would be testing a rigged document.
async fn until_compacted(engine: &TestEngine) -> usize {
    until_fragments(engine, 1).await
}

/// Add tasks until the tree holds `n` fragments — a chain of ranges, each
/// one's boundary the previous one's head.
async fn until_fragments(engine: &TestEngine, n: usize) -> usize {
    for written in 1..=8192 {
        let _id = engine
            .tasks_add(APP, format!("task {written}"))
            .await
            .unwrap();
        if engine
            .items()
            .iter()
            .filter(|item| item.kind == ItemKind::Fragment)
            .count()
            >= n
        {
            return written;
        }
    }
    panic!("8192 commits without {n} level-1 fragments; the depth metric moved");
}

fn kinds(engine: &TestEngine) -> (usize, usize) {
    let items = engine.items();
    let fragments = items
        .iter()
        .filter(|item| item.kind == ItemKind::Fragment)
        .count();
    (items.len() - fragments, fragments)
}

#[test]
fn a_closed_range_becomes_one_fragment_and_the_commits_it_carries_go() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 20, None);
    let ea = Rc::clone(&a.engine);

    pool.run_until(async move {
        let before = ea.entry_points().await.unwrap();
        // A few of the commits this run will later prune, captured as the
        // durable store would have them.
        let _first = ea.tasks_add(APP, "first".into()).await.unwrap();
        let early = ea.items();
        let written = 1 + until_compacted(&ea).await;
        let (_commits, fragments) = kinds(&ea);
        assert_eq!(fragments, 1, "one level-1 fragment closed");
        assert!(
            !ea.read_not_held().is_empty(),
            "the pruned commits are still changes this device has read",
        );
        // Every task is still readable — the document keeps its full history
        // whatever the tree drops.
        assert_eq!(ea.tasks_items(APP).await.unwrap().items.len(), written);

        // The app tree is now the fragment and whatever was written after it
        // closed; the loose commits left in `items()` belong to the group and
        // keyhive trees, which have no fragment.
        // The saving, stated as the inequality it is rather than as a
        // predicted number: how many commits one fragment covers is the hash
        // draw's business.
        let tree = *document_tree(APP).as_bytes();
        let loose = ea
            .items()
            .iter()
            .filter(|item| item.tree == tree && item.kind == ItemKind::Commit)
            .count();
        assert!(
            loose < written,
            "the fragment's range left storage: {loose} loose commits from {written} mutations",
        );

        // The store deletes nothing, so those objects are still under their
        // names and the next pull will hand them straight back. A commit this
        // device pruned on purpose is not news, and reinstating it would undo
        // the compaction on every pass, forever.
        assert!(
            !ea.ingest_items(early).await.unwrap(),
            "commits pruned by compaction are not reinstalled from the store",
        );

        let after = ea.entry_points().await.unwrap();
        eprintln!("PROBE2 written={written} before={before} after={after}");
        assert!(
            after <= before + 1,
            "compaction adds at most the fragment's own entry point: {before} -> {after}",
        );
    });
}

#[test]
fn a_compacted_tree_restores_from_its_checkpoint() {
    // The checkpoint carries the fragment and the loose commits that survived
    // it, and nothing else — the covered range's bytes are gone. Restoring
    // has to read the whole list back out of the bundle.
    let mut pool = LocalPool::new();
    let a = device(&pool, 21, None);
    let ea = Rc::clone(&a.engine);
    let (snapshot, written) = pool.run_until(async move {
        let written = until_compacted(&ea).await;
        (ea.snapshot().await.unwrap(), written)
    });

    let mut pool = LocalPool::new();
    let restored = device(&pool, 21, Some(snapshot));
    let engine = Rc::clone(&restored.engine);
    let items = pool.run_until(async move { engine.tasks_items(APP).await.unwrap() });
    assert_eq!(
        items.items.len(),
        written,
        "the restored device reads the compacted range",
    );
}

#[test]
fn a_device_enrolled_after_compaction_reads_the_range_from_the_fragment() {
    // The read-back case, at range scale. B is enrolled *after* the fragment
    // was sealed, so it never held the epoch keys the covered commits were
    // written under — and their envelopes are not in A's storage to send any
    // more. What reaches B is the fragment: one envelope, sealed under the
    // group's current epoch, carrying every change of the range.
    let mut pool = LocalPool::new();
    let a = device(&pool, 22, None);
    let b = device(&pool, 23, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        let written = until_compacted(&ea).await;
        assert!(eb.tasks_items(APP).await.unwrap().items.is_empty());
        wire(&ea, &eb).await;

        let seen = until(|| async {
            let items = eb.tasks_items(APP).await.unwrap();
            (items.items.len() == written).then_some(items)
        })
        .await;
        assert_eq!(seen.items.len(), written);
        assert!(
            eb.items()
                .iter()
                .any(|item| item.kind == ItemKind::Fragment),
            "B holds the fragment itself, not the range unrolled into commits",
        );
    });
}

#[test]
fn two_devices_build_the_same_fragment_from_the_same_history() {
    // Identity is head + boundary (`design/sedimentree.md`), and both are
    // functions of the change graph — so a second device holding the same
    // history builds a fragment the first one's tree already has, and adding
    // it is a no-op locally. On the store the two land under one name and the
    // last write wins; what makes that harmless is asserted here, that they
    // are the same fragment.
    let mut pool = LocalPool::new();
    let a = device(&pool, 24, None);
    let ea = Rc::clone(&a.engine);
    let snapshot = pool.run_until(async move {
        let _written = until_compacted(&ea).await;
        ea.snapshot().await.unwrap()
    });
    let mine = snapshot
        .apps
        .iter()
        .find(|app| app.app == APP)
        .expect("the app was compacted")
        .state
        .fragments
        .clone();
    assert_eq!(mine.len(), 1);

    // The same document, on a device whose tree has never seen the fragment:
    // the commits it covered are gone with it, which is exactly the state a
    // rebuild has to work from.
    let mut naked = snapshot.clone();
    for app in &mut naked.apps {
        app.state.fragments.clear();
    }

    let mut pool = LocalPool::new();
    let rebuilt = device(&pool, 24, Some(naked));
    let engine = Rc::clone(&rebuilt.engine);
    let items = pool.run_until(async move {
        // Compaction runs on a mutation; one more task is the cheapest
        // trigger, and a level-0 commit on top does not move the level-1
        // fragment underneath it.
        let _id = engine.tasks_add(APP, "one more".into()).await.unwrap();
        engine.items()
    });
    let theirs: Vec<&StoreItem> = items
        .iter()
        .filter(|item| item.kind == ItemKind::Fragment)
        .collect();
    assert_eq!(theirs.len(), 1, "the same one fragment, rebuilt");
    let signed =
        subduction_crypto::signed::Signed::<sedimentree_core::fragment::Fragment>::try_decode(
            &mine[0].signed,
        )
        .expect("the checkpoint's fragment decodes");
    let original = signed
        .try_decode_trusted_payload()
        .expect("and its payload does");
    let signed =
        subduction_crypto::signed::Signed::<sedimentree_core::fragment::Fragment>::try_decode(
            &theirs[0].signed,
        )
        .expect("the rebuilt fragment decodes");
    let rebuilt = signed
        .try_decode_trusted_payload()
        .expect("and its payload does");
    assert_eq!(original.head(), rebuilt.head(), "same head");
    assert_eq!(
        original.boundary(),
        rebuilt.boundary(),
        "same boundary — the two are the same fragment",
    );
    // The envelopes are byte-identical here, which the design did not
    // predict: keyhive derives the content key and nonce from the group's
    // epoch key and the payload rather than from fresh randomness, so two
    // devices of one group seal one plaintext to one ciphertext. It is not
    // asserted, because nothing in the contract promises it — the sealed
    // plaintext is a `bincode` `Envelope` whose `ancestors` is a `HashMap`,
    // and two devices with the same ancestors in a different iteration order
    // would produce different bytes. Both cases are fine, and for the same
    // reason: the two objects decrypt to the same range.
}

#[test]
fn a_chain_of_fragments_is_still_one_entry_point() {
    // Two ranges, so the second fragment's boundary is the first fragment's
    // head — the case where naming the boundary *commit* would embed nothing
    // (its envelope was pruned with its range and its key left the frontier
    // when the first fragment covered it). What the second envelope names is
    // the first *fragment*, and that is what a joiner walks down.
    //
    // So: the head set does not grow one entry per fragment, and a device
    // enrolled after both were sealed reads both ranges from the single
    // entry point it was handed.
    let mut pool = LocalPool::new();
    let a = device(&pool, 25, None);
    let b = device(&pool, 26, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        // One entry point before any compaction: a linear history is one
        // readable branch (docs/design.md §"Read-back and partitions").
        let _first = ea.tasks_add(APP, "first".into()).await.unwrap();
        let before = ea.entry_points().await.unwrap();
        let written = 1 + until_fragments(&ea, 2).await;
        let (_commits, fragments) = kinds(&ea);
        assert_eq!(fragments, 2, "two fragments, chained");
        // The loop stops on the commit that closed the second fragment, so
        // that commit is a member and its key is covered: what is left is the
        // fragment chain's single newest entry. Naming the boundary *commit*
        // rather than the boundary *fragment* would leave the first fragment
        // a head too, and this reads 2.
        let after = ea.entry_points().await.unwrap();
        assert!(
            after <= before,
            "the head set does not grow one entry per fragment: {before} -> {after}",
        );

        // B is enrolled now — after both ranges were sealed, under epochs it
        // never held.
        assert!(eb.tasks_items(APP).await.unwrap().items.is_empty());
        wire(&ea, &eb).await;
        let seen = until(|| async {
            let items = eb.tasks_items(APP).await.unwrap();
            (items.items.len() == written).then_some(items)
        })
        .await;
        assert_eq!(
            seen.items.len(),
            written,
            "the joiner read both ranges, walking from the newest fragment down",
        );
        // Scoped to the app tree: B also holds a fragment over the group
        // document it adopted at enrollment (`Engine::adopt_fragment`).
        let app = *document_tree(APP).as_bytes();
        assert_eq!(
            eb.items()
                .iter()
                .filter(|item| item.tree == app && item.kind == ItemKind::Fragment)
                .count(),
            2,
            "and holds them as fragments, not as the ranges unrolled",
        );
    });
}

// -- the adopted group document, as an item -----------------------------------

/// The `us` tree's items, as (loose commits, fragments).
fn us_items(engine: &TestEngine) -> (usize, usize) {
    let tree = *polyvisor_engine::us_tree().as_bytes();
    let mut commits = 0;
    let mut fragments = 0;
    for item in engine.items().iter().filter(|item| item.tree == tree) {
        match item.kind {
            ItemKind::Commit => commits += 1,
            ItemKind::Fragment => fragments += 1,
        }
    }
    (commits, fragments)
}

#[test]
fn a_joiner_can_serve_the_history_it_adopted() {
    // `adopt_us` installs the adder's document whole and empties the tree
    // that used to back it, so without this the joiner would hold the
    // group's whole past as something it can read and cannot hand to anyone
    // — no item of that era is in its tree, and the pull will not fetch the
    // objects back because the changes are already in its document.
    let mut pool = LocalPool::new();
    let a = device(&pool, 30, None);
    let b = device(&pool, 31, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    let (snapshot, before) = pool.run_until(async move {
        // Some group history to adopt: a second member, and the keyhive
        // pointer the founder writes.
        wire(&ea, &eb).await;
        let (_commits, fragments) = us_items(&eb);
        assert_eq!(fragments, 1, "the joiner rolled the adopted history up");
        (eb.snapshot().await.unwrap(), members(&eb).await)
    });
    assert_eq!(before.len(), 2, "the adopted group is the adder's, plus us");

    // The document blanked, the tree kept: what a device holds if it has the
    // items and nothing else. If the fragment's bundle is a real automerge
    // bundle of the adopted history, the group comes back from it alone.
    let mut naked = snapshot;
    if let Some(us) = naked.us.as_mut() {
        us.doc.clear();
    }
    let mut pool = LocalPool::new();
    let restored = device(&pool, 31, Some(naked));
    let engine = Rc::clone(&restored.engine);
    let after = pool.run_until(async move { members(&engine).await });
    assert_eq!(
        after, before,
        "the group came back out of the fragment, with no document to help",
    );
}

#[test]
fn a_third_device_learns_the_first_era_from_the_second() {
    // A enrols B; B enrols C; C never meets A. Everything C learns of the
    // group's first era — the era before B existed — comes from B, and B
    // holds it as the one fragment it built when it adopted.
    let mut pool = LocalPool::new();
    let a = device(&pool, 32, None);
    let b = device(&pool, 33, None);
    let c = device(&pool, 34, None);
    let (ea, eb, ec) = (
        Rc::clone(&a.engine),
        Rc::clone(&b.engine),
        Rc::clone(&c.engine),
    );

    pool.run_until(async move {
        wire(&ea, &eb).await;
        // B is now a member and has A's history as a fragment. C pairs with
        // B, and B — not A — is the only device it is ever wired to.
        wire(&eb, &ec).await;

        let seen = until(|| async {
            let seen = members(&ec).await;
            (seen.len() == 3).then_some(seen)
        })
        .await;
        assert_eq!(seen.len(), 3, "C sees the whole group, A included");
        let (_commits, fragments) = us_items(&ec);
        assert!(
            fragments >= 1,
            "and holds that history as a fragment of its own",
        );
    });
}

#[test]
fn the_route_key_is_minted_once() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 40, None);
    let ea = Rc::clone(&a.engine);

    pool.run_until(async move {
        let (first, wrote) = ea.visor_route_key().await.unwrap();
        assert!(wrote, "the first call mints, and the kernel checkpoints");
        let (second, wrote) = ea.visor_route_key().await.unwrap();
        assert!(!wrote, "the second call finds the key already there");
        assert_eq!(first, second, "and it is the same key");
    });
}

#[test]
fn an_install_id_is_per_app_and_stable() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 41, None);
    let ea = Rc::clone(&a.engine);

    pool.run_until(async move {
        let (todo, wrote) = ea.visor_install("polyvisor:app/todomvc").await.unwrap();
        assert!(wrote);
        let (again, wrote) = ea.visor_install("polyvisor:app/todomvc").await.unwrap();
        assert!(
            !wrote,
            "the same app resolves to the install it already has"
        );
        assert_eq!(todo, again);

        let (other, wrote) = ea.visor_install("polyvisor:app/notes").await.unwrap();
        assert!(wrote);
        assert_ne!(todo, other, "a different app is a different install");

        let mut listed = ea.visor_installs().await.unwrap();
        listed.sort_by_key(|(_, app)| app.clone());
        assert_eq!(
            listed,
            vec![
                (other, "polyvisor:app/notes".to_string()),
                (todo, "polyvisor:app/todomvc".to_string()),
            ],
        );
    });
}

#[test]
fn a_snapshot_restores_the_route_key_and_the_installs() {
    let mut pool = LocalPool::new();
    let a = device(&pool, 42, None);
    let ea = Rc::clone(&a.engine);
    let (snapshot, key, installs) = pool.run_until(async move {
        let (key, _wrote) = ea.visor_route_key().await.unwrap();
        let _install = ea.visor_install("polyvisor:app/todomvc").await.unwrap();
        (
            ea.snapshot().await.unwrap(),
            key,
            ea.visor_installs().await.unwrap(),
        )
    });

    let mut pool = LocalPool::new();
    let restored = device(&pool, 42, Some(snapshot));
    let engine = Rc::clone(&restored.engine);
    pool.run_until(async move {
        let (after, wrote) = engine.visor_route_key().await.unwrap();
        assert!(!wrote, "a restored device does not mint a second key");
        assert_eq!(after, key);
        assert_eq!(engine.visor_installs().await.unwrap(), installs);
    });
}

#[test]
fn two_founders_converge_on_one_route_key() {
    // Each device mints before it has ever met the other, and the schema's
    // answer is last-writer-wins on a scalar (`engine::visor`): after pairing
    // both devices read one key — the loser's pre-pairing bookmarks are the
    // documented cost.
    let mut pool = LocalPool::new();
    let a = device(&pool, 43, None);
    let b = device(&pool, 44, None);
    let (ea, eb) = (Rc::clone(&a.engine), Rc::clone(&b.engine));

    pool.run_until(async move {
        let (key_a, _wrote) = ea.visor_route_key().await.unwrap();
        let (key_b, _wrote) = eb.visor_route_key().await.unwrap();
        assert_ne!(key_a, key_b, "two devices mint different keys");

        wire(&ea, &eb).await;

        let (seen_a, seen_b) = until(|| async {
            let (seen_a, _) = ea.visor_route_key().await.unwrap();
            let (seen_b, _) = eb.visor_route_key().await.unwrap();
            (seen_a == seen_b).then_some((seen_a, seen_b))
        })
        .await;
        assert_eq!(seen_a, seen_b);
        assert!(
            seen_a == key_a || seen_a == key_b,
            "the survivor is one of the two that were minted",
        );
    });
}
