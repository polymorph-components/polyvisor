//! Kill-and-resume acts (#20 G5; runtime/PERSISTENCE.md "Checkpoint
//! semantics" — "a checkpoint the engine can be restored from after
//! `worker.terminate()` at any moment. The acts battery gains a
//! kill-and-resume act").
//!
//! Native parity is the point: the guest persists through `std::fs`, so
//! under wasmtime it writes REAL FILES into a real preopened directory,
//! exercising the same guest code path the browser drives over OPFS.
//!
//! # What "kill" means here
//!
//! A second component instance. Component instances do not share linear
//! memory, so `resumed` starts with an empty `thread_local! STATE` and
//! nothing but the state root in common with `device` — which is exactly
//! what survives a `worker.terminate()`. (The battery already uses this
//! idiom for the identity-bundle restart shells, main.rs's `laptop2`.)
//! The Deno bringup's `resume` phase takes the harsher variant and kills
//! a whole OS PROCESS between the halves.
//!
//! # Why the peer is wired only AFTER the resume
//!
//! Deliberate, and it is what makes the sedimentree half of the
//! checkpoint assertable. The peer is a member of the partition from
//! creation but never syncs before the kill, so every pre-kill todo
//! reaches it only if the RESUMED instance still holds those chunks. An
//! act that synced first would have the peer holding the history already
//! and could not tell a restored chunk store from an empty one.

use std::time::{Duration, Instant};

use wasmtime::component::Accessor;
use wasmtime::{bail, format_err, Result};

use crate::bindings::exports::polyvisor::engine::driver::{Guest as Driver, UsMark, UsProfile};
use crate::bindings::exports::polyvisor::tasks::tasks::Guest as Tasks;
use crate::Ctx;

const POLLS: u32 = 4000;

fn ok(label: &str, t: Instant) {
    println!("[{:>9.2?}] {label}", t.elapsed());
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

fn mark(provenance: &str, petname: &str, icon: &str, created_at: u64) -> UsMark {
    UsMark {
        provenance: provenance.to_string(),
        petname: petname.to_string(),
        icon: icon.to_string(),
        nickname: None,
        created_at,
        needs_reconfirm: false,
    }
}

/// Compare marks by content (generated WIT records derive no `PartialEq`).
fn same_marks(a: &[UsMark], b: &[UsMark]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.provenance == y.provenance
                && x.petname == y.petname
                && x.icon == y.icon
                && x.nickname == y.nickname
                && x.created_at == y.created_at
                && x.needs_reconfirm == y.needs_reconfirm
        })
}

async fn wait_items(
    acc: &Accessor<Ctx>,
    t: &Tasks,
    what: &str,
    want: impl Fn(&[crate::TodoItem]) -> bool,
) -> Result<Vec<crate::TodoItem>> {
    let start = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        match t.call_items(acc).await? {
            Ok(snap) => {
                if want(&snap.items) {
                    ok(what, start);
                    return Ok(snap.items);
                }
                last = Some(format!("{} items", snap.items.len()));
            }
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    bail!("{what}: never held (last: {last:?})")
}

/// FRESH-BOOT COMPATIBILITY, asserted rather than assumed.
///
/// Runs in a store with NO preopened directory — the shape every existing
/// consumer has (demo.ts, solo.ts, the bringup phases, the e2e scenarios,
/// and every other act set here), and the shape `@polyengine/wasi`'s
/// batteries `wasi()` produces, whose filesystem fragment answers
/// `get-directories -> []`.
///
/// `state-resume` must answer `false` — "no state, go and `init`" — and
/// NOT an error, because an embedder that always calls resume-then-init
/// is the intended usage and must sail straight through. `init` after it
/// must still work, which is the real claim: an engine that is never
/// given a state root behaves exactly as it did before this feature
/// existed.
pub(crate) async fn no_state_root_act(acc: &Accessor<Ctx>, fresh: crate::bindings::Engine) -> Result<()> {
    let d: &Driver = fresh.polyvisor_engine_driver();
    let t = Instant::now();

    let resumed = d
        .call_state_resume(acc)
        .await?
        .map_err(|e| format_err!("state-resume with no state root should answer false, got: {e}"))?;
    if resumed {
        bail!("state-resume answered true with no preopened state root");
    }
    ok("no state root: state-resume -> false (fresh boot, not an error)", t);

    // The mirror claim: checkpointing without a state root is a REFUSAL,
    // not a silent success that loses the device.
    let t = Instant::now();
    match d.call_state_checkpoint(acc).await? {
        Ok(()) => bail!("state-checkpoint succeeded with no state root"),
        Err(e) => {
            if !e.contains("no state root") {
                bail!("state-checkpoint refused with an unhelpful message: {e}");
            }
            ok(&format!("no state root: state-checkpoint refused ({e})"), t);
        }
    }

    // And the engine still boots the old way.
    let id = step!("no state root: init still works", d.call_init(acc, false));
    if id.len() != 64 {
        bail!("init returned a malformed identity: {id}");
    }
    Ok(())
}

/// The kill-and-resume act.
///
/// `device` authors a device's worth of state, checkpoints it, and is
/// then abandoned; `resumed` is a fresh instance over the same state
/// root; `peer` is a live collaborator that only ever meets the RESUMED
/// instance.
#[allow(clippy::too_many_lines)]
pub(crate) async fn resume_act(
    acc: &Accessor<Ctx>,
    device: crate::bindings::Engine,
    resumed: crate::bindings::Engine,
    peer: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let d: &Driver = device.polyvisor_engine_driver();
    let r: &Driver = resumed.polyvisor_engine_driver();
    let p: &Driver = peer.polyvisor_engine_driver();
    let dt: &Tasks = device.polyvisor_tasks_tasks();
    let rt: &Tasks = resumed.polyvisor_tasks_tasks();
    let pt: &Tasks = peer.polyvisor_tasks_tasks();

    // --- the device, before the kill ---------------------------------------
    //
    // `exportable-identity: true` is REQUIRED for a resumable device at
    // this rev: the default platform posture rests as a non-extractable
    // WebCrypto handle the guest cannot write down, and `state-resume`
    // refuses such a checkpoint rather than silently minting a new
    // identity (engine.wit's documented seam; PERSISTENCE.md T-A).
    let dev_id_hex = step!("device.init(exportable)", d.call_init(acc, true));
    let dev_id = hex::decode(&dev_id_hex).map_err(|e| format_err!("{e}"))?;
    let peer_id_hex = step!("peer.init", p.call_init(acc, false));
    let peer_id = hex::decode(&peer_id_hex).map_err(|e| format_err!("{e}"))?;

    // Contact cards are host-carried: the two never share a wire before
    // the kill (module header).
    let card = step!("device.kh-contact-card", d.call_kh_contact_card(acc));
    step!("peer.kh-ingest-contact(device)", p.call_kh_ingest_contact(acc, card));
    let card = step!("peer.kh-contact-card", p.call_kh_contact_card(acc));
    step!("device.kh-ingest-contact(peer)", d.call_kh_ingest_contact(acc, card));

    step!(
        "device.user-create",
        d.call_user_create(
            acc,
            UsProfile {
                display_name: "Resumed Rita".to_string(),
                hue: 210,
                icon: None,
            },
        )
    );
    step!(
        "device.us-mark-put(alpha)",
        d.call_us_mark_put(acc, mark("app://alpha", "Alpha", "\u{1f34e}", 1_000))
    );
    step!(
        "device.us-mark-put(beta)",
        d.call_us_mark_put(acc, mark("app://beta", "Beta", "\u{1f34c}", 2_000))
    );
    let marks_before = step!("device.us-marks-list", d.call_us_marks_list(acc));
    if marks_before.len() != 2 {
        bail!("expected 2 marks before the kill, got {}", marks_before.len());
    }

    let part = step!("device.create-partition", d.call_create_partition(acc));
    step!(
        "device.kh-add-member(peer, edit)",
        d.call_kh_add_member(acc, part.clone(), peer_id.clone(), "edit".to_string())
    );
    step!("device.seal-partition", d.call_seal_partition(acc, part.clone()));
    step!(
        "device.us-partition-put(tasks)",
        d.call_us_partition_put(acc, "tasks".to_string(), part.clone())
    );

    let milk = step!("device.tasks.add(buy milk)", dt.call_add(acc, "buy milk".to_string()));
    step!("device.tasks.add(write the act)", dt.call_add(acc, "write the act".to_string()));
    step!("device.tasks.add(kill the worker)", dt.call_add(acc, "kill the worker".to_string()));
    step!(
        "device.tasks.set-completed(buy milk)",
        dt.call_set_completed(acc, milk.clone(), true)
    );
    let items_before = step!("device.tasks.items", dt.call_items(acc));
    if items_before.items.len() != 3 {
        bail!("expected 3 items before the kill, got {}", items_before.items.len());
    }

    step!("device.state-checkpoint", d.call_state_checkpoint(acc));

    // --- THE KILL ----------------------------------------------------------
    //
    // Nothing below touches `device` again, and that is enforced by the
    // BORROW CHECKER rather than by discipline: `d` and `dt` borrow from
    // `device`, so this move-and-drop only compiles while neither is used
    // again. `resumed` is a distinct component instance — separate linear
    // memory, empty guest state, only the state root in common (module
    // header).
    let _abandoned = device;
    let t = Instant::now();
    ok("*** kill: the device instance is abandoned ***", t);

    // --- the resumed device ------------------------------------------------

    let did_resume = step!("resumed.state-resume", r.call_state_resume(acc));
    if !did_resume {
        bail!("state-resume answered false over a state root that was just checkpointed");
    }

    // Partition bindings.
    let bound = rt
        .call_partition(acc)
        .await?
        .map_err(|e| format_err!("resumed.tasks.partition: {e}"))?;
    if bound != part {
        bail!(
            "resumed bound the wrong partition: {} != {}",
            hex::encode(&bound),
            hex::encode(&part)
        );
    }
    let pointers = step!("resumed.us-partitions", r.call_us_partitions(acc));
    if !pointers.iter().any(|q| q.name == "tasks" && q.id == part) {
        bail!("resumed lost the `tasks` partition pointer: {pointers:?}");
    }
    ok("resumed: active partition + us-partition pointer intact", Instant::now());

    // Todos, including the completion flag.
    let items = step!("resumed.tasks.items", rt.call_items(acc));
    if items.items.len() != 3 {
        bail!("resumed holds {} todos, expected 3", items.items.len());
    }
    if !items
        .items
        .iter()
        .any(|i| i.title == "buy milk" && i.completed)
    {
        bail!("resumed lost the completion toggle: {:?}", items.items);
    }
    ok("resumed: 3 todos intact, completion toggle intact", Instant::now());

    // Marks, byte-for-byte.
    let marks_after = step!("resumed.us-marks-list", r.call_us_marks_list(acc));
    if !same_marks(&marks_before, &marks_after) {
        bail!("marks changed across the kill:\n  before {marks_before:?}\n  after  {marks_after:?}");
    }
    ok("resumed: both marks intact", Instant::now());

    // RESUME IS NOT A JOIN: the restored profile/marks/devices were
    // announced before the kill, so the first drain must be EMPTY rather
    // than replaying the whole document as remote news (persist.rs's
    // baseline note; #22 "announced, never silently adopted" is the
    // joiner's rule, not the resumer's).
    let events = step!("resumed.us-events", r.call_us_events(acc));
    if !events.is_empty() {
        bail!("resume replayed {} stale us-events: {events:?}", events.len());
    }
    ok("resumed: us-events drain is empty (resume is not a join)", Instant::now());

    // AUTHORING after resume is the chunk-key assertion. `encrypt_and_commit`
    // refuses to seal on a parent whose envelope key it does not hold, and
    // after a resume every parent is inherited history — so this call is
    // exactly what a checkpoint missing `chunk_keys` would fail.
    step!(
        "resumed.tasks.add(after the kill)",
        rt.call_add(acc, "after the kill".to_string())
    );
    let items = step!("resumed.tasks.items", rt.call_items(acc));
    if items.items.len() != 4 {
        bail!("resumed authored but holds {} todos", items.items.len());
    }
    ok("resumed: authored a new change on restored history (chunk keys survived)", Instant::now());

    // --- the live peer -----------------------------------------------------

    let peer_ep = step!("peer.iroh-bind", p.call_iroh_bind(acc, relay.clone()));
    let resumed_ep = step!("resumed.iroh-bind", r.call_iroh_bind(acc, relay.clone()));
    let _ = peer_ep;

    // IDENTITY, ASSERTED CRYPTOGRAPHICALLY. The peer DIALS the resumed
    // instance with `expected-peer = dev_id` — the identity the device
    // had before the kill — and subduction's handshake refuses a peer
    // that cannot prove that key. A resume that had minted a fresh
    // identity (or restored the wrong one) fails here, not in a string
    // comparison we wrote ourselves.
    crate::connect(
        acc,
        (p, "peer", &dev_id),
        (r, "resumed", &resumed_ep),
        &relay,
    )
    .await?;
    ok("peer dialled the resumed device under its PRE-KILL identity", Instant::now());

    step!("peer.adopt-partition", p.call_adopt_partition(acc, part.clone()));
    let t = Instant::now();
    for _ in 0..POLLS {
        if p.call_kh_knows_agent(acc, part.clone())
            .await?
            .map_err(|e| format_err!("peer kh-knows-agent: {e}"))?
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    ok("peer's keyhive learned the partition over the bridge", t);

    for (who, drv, target) in [("resumed", r, &peer_id), ("peer", p, &dev_id)] {
        let h = drv
            .call_sync_start(acc, target.clone(), part.clone(), true)
            .await?
            .map_err(|e| format_err!("{who} sync-start: {e}"))?;
        for _ in 0..POLLS {
            match drv.call_sync_status(acc, h).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(Duration::from_millis(3)).await,
                Err(e) => bail!("{who} sync: {e}"),
            }
        }
    }
    ok("subscriptions up in both directions", Instant::now());

    // THE SEDIMENTREE ASSERTION. The peer never saw a byte of this
    // partition before the kill, so the three PRE-KILL todos can only
    // reach it out of the resumed instance's restored chunk store.
    let seen = wait_items(acc, pt, "peer received all 4 todos from the resumed device", |i| {
        i.len() == 4
    })
    .await?;
    if !seen.iter().any(|i| i.title == "buy milk" && i.completed) {
        bail!("peer received the todos but lost the completion flag: {seen:?}");
    }
    if !seen.iter().any(|i| i.title == "after the kill") {
        bail!("peer missed the post-resume change: {seen:?}");
    }

    // And the receive direction: a resumed device is a full participant,
    // not a read-only replica.
    step!("peer.tasks.add(from the peer)", pt.call_add(acc, "from the peer".to_string()));
    wait_items(acc, rt, "resumed received the peer's change", |i| i.len() == 5).await?;

    Ok(())
}

/// THE CRASH-CONSISTENCY CLAIM, ASSERTED — the half of this track that is
/// prose everywhere else.
///
/// The engine's atomicity story is "generation directories plus a manifest
/// written LAST": a kill during a checkpoint leaves the new generation
/// without a valid manifest, and resume falls back to the previous one.
/// This act stages exactly that failure. The device checkpoints twice, the
/// HOST then truncates the newest MANIFEST (what a kill mid-write leaves
/// behind — the file exists, its tail does not), and a fresh instance
/// resumes. It must land on generation 1, holding the FIRST checkpoint's
/// todo and not the second's.
///
/// Two halves, two stores, with the damage done in between — see
/// `resume_scenarios`. This is the first half.
pub(crate) async fn torn_write_act(
    acc: &Accessor<Ctx>,
    device: crate::bindings::Engine,
) -> Result<()> {
    let d: &Driver = device.polyvisor_engine_driver();
    let t: &Tasks = device.polyvisor_tasks_tasks();

    step!("torn: device.init(exportable)", d.call_init(acc, true));
    let part = step!("torn: device.create-partition", d.call_create_partition(acc));
    step!("torn: device.seal-partition", d.call_seal_partition(acc, part));

    step!("torn: tasks.add(before)", t.call_add(acc, "before".to_string()));
    step!("torn: state-checkpoint #1", d.call_state_checkpoint(acc));

    step!("torn: tasks.add(after)", t.call_add(acc, "after".to_string()));
    step!("torn: state-checkpoint #2", d.call_state_checkpoint(acc));
    Ok(())
}

/// The second half: resume over the state root whose newest manifest the
/// host truncated between the two calls.
pub(crate) async fn torn_resume_act(
    acc: &Accessor<Ctx>,
    resumed: crate::bindings::Engine,
) -> Result<()> {
    let d: &Driver = resumed.polyvisor_engine_driver();
    let t: &Tasks = resumed.polyvisor_tasks_tasks();

    let did = step!("torn: state-resume over a torn newest generation", d.call_state_resume(acc));
    if !did {
        bail!("resume gave up entirely on a torn manifest instead of falling back");
    }
    let items = step!("torn: resumed.tasks.items", t.call_items(acc));
    let titles: Vec<&str> = items.items.iter().map(|i| i.title.as_str()).collect();
    if titles != ["before"] {
        bail!(
            "expected the PREVIOUS generation's single todo, got {titles:?} — a torn \
             checkpoint was treated as valid"
        );
    }
    ok("torn: fell back to the last intact generation (1 todo, not 2)", Instant::now());
    Ok(())
}
