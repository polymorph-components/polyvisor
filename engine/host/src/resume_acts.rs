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

use crate::bindings::exports::polyvisor::engine::driver::{
    Guest as Driver, S3Config, StoreConfig, UsMark, UsProfile,
};
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

/// PLATFORM POSTURE, WITH NO DEVICE IDENTITY GRANTED — the half of the
/// app-owned `device-identity` import this host CAN assert natively.
///
/// `polymorph-webcrypto-wasmtime` at the pinned rev exposes no way to
/// build a `signing-key` resource from Rust-held material (main.rs's
/// BLOCKED note), so this host fills the import with `none`. That is not
/// a degenerate configuration: it is exactly "an embedding that grants no
/// persistence", which the contract gives its own behavior.
///
/// The two claims:
///
/// 1. `init(exportable-identity: false)` still works and still MINTS.
///    Consulting the import first must not have changed the no-persistence
///    path — that is the compatibility claim for every existing consumer.
/// 2. Resuming that device's checkpoint is an EXPLICIT REFUSAL naming the
///    import, not `false` (which would send the embedder to `init` and
///    silently mint a new device, losing every membership) and not a
///    silent downgrade.
pub(crate) async fn platform_no_identity_act(
    acc: &Accessor<Ctx>,
    device: crate::bindings::Engine,
    resumed: crate::bindings::Engine,
) -> Result<()> {
    let d: &Driver = device.polyvisor_engine_driver();
    let dt: &Tasks = device.polyvisor_tasks_tasks();

    let id = step!(
        "platform: device.init(platform posture, import answers none)",
        d.call_init(acc, false)
    );
    if id.len() != 64 {
        bail!("init returned a malformed identity: {id}");
    }
    ok("platform: init minted through the port (no identity granted)", Instant::now());

    let part = step!("platform: create-partition", d.call_create_partition(acc));
    step!("platform: seal-partition", d.call_seal_partition(acc, part));
    step!("platform: tasks.add", dt.call_add(acc, "platform todo".to_string()));
    step!("platform: state-checkpoint", d.call_state_checkpoint(acc));

    let r: &Driver = resumed.polyvisor_engine_driver();
    let t = Instant::now();
    match r.call_state_resume(acc).await? {
        Ok(true) => bail!(
            "state-resume RESUMED a platform-posture checkpoint while the \
             device-identity import answered `none` — it cannot have the key"
        ),
        Ok(false) => bail!(
            "state-resume answered `false` on a platform-posture checkpoint: the \
             embedder would go on to `init` and silently mint a NEW device"
        ),
        Err(e) => {
            if !e.contains("granted no device identity") || !e.contains("device-identity") {
                bail!("refusal did not name the missing import: {e}");
            }
            ok(&format!("platform: resume refused, naming the import ({e})"), t);
        }
    }
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

// --- the bucket-state act (#93) ----------------------------------------------

/// Host-side, read-only S3 access, used ONLY to count what the engine
/// left in the bucket.
///
/// Deliberately not routed through the guest's egress seams: the claim
/// under test is about what is IN the store, and asking the engine would
/// be asking the component under test to grade itself. This is the same
/// SigV4 the escrowed signer performs (`store_signer::sign` in main.rs),
/// assembled here over the rig's synthetic MinIO credential.
#[derive(Clone)]
pub(crate) struct S3Probe {
    pub endpoint: String,
    pub bucket: String,
    pub access: String,
    pub secret: String,
    pub http: reqwest::Client,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    hex::encode(sha2::Sha256::digest(bytes))
}

fn hmac256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::Mac as _;
    let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(key)
        .expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

impl S3Probe {
    /// Every object key in the bucket, sorted.
    ///
    /// The rig's buckets hold at most a handful of objects, so the
    /// single (unpaginated) ListObjectsV2 page is the whole truth; a
    /// truncated response would be a rig failure and is reported as one.
    pub(crate) async fn keys(&self) -> Result<Vec<String>> {
        let host = self
            .endpoint
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/');
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        // The same civil-from-days shape provider-s3 uses; the host has
        // no date crate and needs exactly this one format.
        let days = (now / 86_400) as i64;
        let (y, mo, d) = {
            let z = days + 719_468;
            let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
            let doe = (z - era * 146_097) as u64;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe as i64 + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
            let m = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 })?;
            (if m <= 2 { y + 1 } else { y }, m, d)
        };
        let rem = now % 86_400;
        let date = format!("{y:04}{mo:02}{d:02}");
        let amz = format!(
            "{date}T{:02}{:02}{:02}Z",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        );
        let path = format!("/{}", self.bucket);
        let query = "list-type=2";
        let payload_hash = sha256_hex(b"");
        let canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz}\n");
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "GET\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/us-east-1/s3/aws4_request");
        let sts = format!(
            "AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",
            sha256_hex(canonical.as_bytes())
        );
        let mut key = format!("AWS4{}", self.secret).into_bytes();
        for part in [date.as_str(), "us-east-1", "s3", "aws4_request"] {
            key = hmac256(&key, part.as_bytes());
        }
        let signature = hex::encode(hmac256(&key, sts.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access
        );
        let resp = self
            .http
            .get(format!("{}{path}?{query}", self.endpoint))
            .header("x-amz-date", amz)
            .header("x-amz-content-sha256", payload_hash)
            .header("authorization", authorization)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let body = resp.text().await?;
        if status != 200 {
            bail!("list {}: {status} {body}", self.bucket);
        }
        if body.contains("<IsTruncated>true</IsTruncated>") {
            bail!("list {}: truncated — the act's counts would be wrong", self.bucket);
        }
        let mut out: Vec<String> = body
            .split("<Key>")
            .skip(1)
            .filter_map(|s| s.split("</Key>").next())
            .map(str::to_string)
            .collect();
        out.sort();
        Ok(out)
    }
}

/// How many chunks a `bucket-flush` decided to upload, out of the
/// summary string the engine returns.
///
/// The summary is the engine's own account of the work it chose to do
/// (`flush_to`: `"flushed chunks={n} oplog={n}B epoch={n}"`), and it is
/// the only window onto the dedup decision — the bucket cannot show it,
/// because a re-upload of an already-stored chunk lands on the SAME
/// name. Parsed strictly: an unrecognised summary is a failure, never a
/// silently-zero assertion.
pub(crate) fn flushed_chunks(summary: &str) -> Result<u32> {
    summary
        .split_whitespace()
        .find_map(|w| w.strip_prefix("chunks="))
        .ok_or_else(|| format_err!("flush summary has no `chunks=` field: {summary:?}"))?
        .parse::<u32>()
        .map_err(|e| format_err!("unparseable chunk count in {summary:?}: {e}"))
}

/// BUCKET STATE SURVIVES THE KILL — the act #93 asked for.
///
/// The defect: `State.buckets` (per-doc name-key chains, the flushed
/// dedup map, manifest entries, grantees, the Dropbox links) lived only
/// in instance memory. persist.rs classified it with `store` as
/// "embedder-supplied addressing, re-applied by the embedder", which is
/// true of the ADDRESSING and false of the STATE: no embedder can
/// re-supply a keychain the engine minted. So every respawn minted a
/// fresh one, every derived object name changed, and the next flush
/// wrote a complete second copy of the store — and even at equal names,
/// a lost `flushed` map re-uploads every chunk.
///
/// The assertion is therefore an OBJECT COUNT, taken host-side out of
/// the bucket itself:
///
///  1. device flushes, checkpoints, and is abandoned;
///  2. a fresh instance resumes and RE-APPLIES ONLY THE ADDRESSING
///     (`init-store` — that half of the note was right) and flushes
///     again: the key set must be UNCHANGED, byte for byte, AND the
///     engine must report ZERO chunks sent. The two are different
///     claims — a lost dedup map with a surviving keychain re-uploads
///     everything to the same names, which the key set cannot see —
///     so the keychain and the `flushed` map are pinned separately.
///     Pre-fix the key set roughly doubles.
///  3. one real mutation, then a third flush: the delta must be the new
///     chunk and nothing else — the dedup map survived too, so the
///     device uploads what changed rather than the world.
///
/// Name-keys are secret material and never appear here: the evidence is
/// counts and set equality over opaque object names.
#[allow(clippy::too_many_lines)]
pub(crate) async fn bucket_state_act(
    acc: &Accessor<Ctx>,
    device: crate::bindings::Engine,
    resumed: crate::bindings::Engine,
    probe: &S3Probe,
) -> Result<()> {
    let d: &Driver = device.polyvisor_engine_driver();
    let dt: &Tasks = device.polyvisor_tasks_tasks();

    let store_cfg = || {
        StoreConfig::S3(S3Config {
            endpoint: probe.endpoint.clone(),
            bucket: probe.bucket.clone(),
            access_key: probe.access.clone(),
        })
    };

    // --- before the kill ---------------------------------------------------
    let dev_id_hex = step!("buckets: device.init(exportable)", d.call_init(acc, true));
    let dev_id = hex::decode(&dev_id_hex).map_err(|e| format_err!("{e}"))?;
    step!(
        "buckets: device.init-store(s3)",
        d.call_init_store(acc, store_cfg())
    );
    step!("buckets: device.ensure-bucket", d.call_ensure_bucket(acc));

    step!(
        "buckets: device.user-create",
        d.call_user_create(
            acc,
            UsProfile {
                display_name: "Bucketed Bella".to_string(),
                hue: 40,
                icon: None,
            },
        )
    );
    let part = step!("buckets: device.create-partition", d.call_create_partition(acc));
    step!(
        "buckets: device.seal-partition",
        d.call_seal_partition(acc, part.clone())
    );
    step!(
        "buckets: device.us-partition-put(tasks)",
        d.call_us_partition_put(acc, "tasks".to_string(), part.clone())
    );
    for title in ["buy milk", "write the act", "count the objects"] {
        step!(
            format!("buckets: device.tasks.add({title})"),
            dt.call_add(acc, title.to_string())
        );
    }

    // The grant is in the act because it is now a CHECKPOINTED mutation:
    // it appends to this doc's `grantees` and republishes K_p under the
    // current name-key epoch (hence rpc.ts dropping `storeGrant` from
    // READONLY_METHODS in the same change).
    let _ = step!(
        "buckets: device.store-grant(self)",
        d.call_store_grant(acc, part.clone(), dev_id.clone())
    );
    let summary = step!(
        "buckets: device.bucket-flush",
        d.call_bucket_flush(acc, part.clone())
    );
    println!("            {summary}");
    step!("buckets: device.state-checkpoint", d.call_state_checkpoint(acc));

    let before = probe.keys().await?;
    if before.len() < 4 {
        bail!(
            "the pre-kill flush left only {} object(s) — too few for the count to mean anything",
            before.len()
        );
    }
    println!(
        "[  buckets ] pre-kill bucket holds {} object(s) (3 chunks + oplog + manifest + K_p, names elided)",
        before.len()
    );

    // --- THE KILL ----------------------------------------------------------
    // Same idiom as `resume_act`: a distinct component instance, so the
    // borrow checker enforces that nothing below touches `device`.
    let _abandoned = device;
    ok("*** kill: the device instance is abandoned ***", Instant::now());

    let r: &Driver = resumed.polyvisor_engine_driver();
    let rt: &Tasks = resumed.polyvisor_tasks_tasks();
    let did = step!("buckets: resumed.state-resume", r.call_state_resume(acc));
    if !did {
        bail!("state-resume answered false over a state root that was just checkpointed");
    }
    // THE ADDRESSING, AND ONLY THE ADDRESSING. This is the embedder's
    // half of the config/state split, re-applied exactly as the worker
    // host re-applies it at every bring-up. Nothing here hands back a
    // name-key, a flushed set, or a grantee — if the count below holds,
    // it holds because the CHECKPOINT carried them.
    step!(
        "buckets: resumed.init-store(s3) [addressing re-applied by the embedder]",
        r.call_init_store(acc, store_cfg())
    );

    let summary = step!(
        "buckets: resumed.bucket-flush [no mutation since the checkpoint]",
        r.call_bucket_flush(acc, part.clone())
    );
    println!("            {summary}");
    // THE DEDUP HALF, PINNED SEPARATELY — the key set alone cannot see
    // it. `flushed` (cref -> epoch) is the upload dedup map, and losing
    // it while KEEPING the keychain re-uploads every chunk to the SAME
    // names: same key set, same count, a full re-upload. Set equality
    // below would pass straight through that, so the engine's own count
    // of what it decided to send is the observable that catches it.
    let chunks = flushed_chunks(&summary)?;
    if chunks != 0 {
        bail!(
            "a re-flush with no mutation since the checkpoint re-uploaded {chunks} chunk(s): the \
             keychain survived but the flushed-chunk map did not, so the device re-sent history \
             it had already stored — over the same names, which is why the object count cannot \
             see it (#93)"
        );
    }
    ok(
        "buckets: the no-change re-flush sent ZERO chunks (the dedup map survived, not just the keychain)",
        Instant::now(),
    );
    let after = probe.keys().await?;
    if after != before {
        let added = after.iter().filter(|k| !before.contains(k)).count();
        bail!(
            "a re-flush after resume changed the store: {} object(s) before, {} after, {added} new \
             — the resumed instance minted a fresh keychain (or lost the flushed map) and \
             re-uploaded the world (#93)",
            before.len(),
            after.len()
        );
    }
    ok(
        &format!(
            "buckets: re-flush after the kill uploaded nothing new — the bucket still holds \
             exactly {} object(s), the SAME key set (the keychain and the dedup map survived)",
            after.len()
        ),
        Instant::now(),
    );

    // --- and a real mutation moves exactly the delta ------------------------
    step!(
        "buckets: resumed.tasks.add(after the kill)",
        rt.call_add(acc, "after the kill".to_string())
    );
    let summary = step!(
        "buckets: resumed.bucket-flush [one new change]",
        r.call_bucket_flush(acc, part.clone())
    );
    println!("            {summary}");
    // The mirror of the zero above: the delta flush must send the ONE
    // new chunk, not the whole history again. Together the two counts
    // say the dedup map is being consulted, not merely present.
    let chunks = flushed_chunks(&summary)?;
    if chunks != 1 {
        bail!(
            "one new todo should flush exactly one chunk; the engine sent {chunks} — the dedup \
             map was not consulted (#93)"
        );
    }
    let delta = probe.keys().await?;
    let new: Vec<&String> = delta.iter().filter(|k| !after.contains(k)).collect();
    let gone: Vec<&String> = after.iter().filter(|k| !delta.contains(k)).collect();
    if !gone.is_empty() {
        bail!("the delta flush ORPHANED {} object(s)", gone.len());
    }
    if new.len() != 1 {
        bail!(
            "a single new todo should add exactly one object (its chunk; the oplog and manifest \
             are rewritten under their existing names) — it added {}: the store was re-uploaded \
             rather than extended",
            new.len()
        );
    }
    ok(
        &format!(
            "buckets: one new change added exactly 1 object ({} -> {}), not another whole copy",
            after.len(),
            delta.len()
        ),
        Instant::now(),
    );
    Ok(())
}

// --- the BucketState growth rule (SYNC.md §2) --------------------------------

/// Damage one generation's `buckets.bin` into a member that VALIDATES but
/// does not DECODE, and repair the manifest so the generation still
/// selects. Host-side surgery, the `torn_write_act` idiom taken one layer
/// deeper.
///
/// WHY THIS SHAPE. `buckets.bin` is bincode, which is not
/// self-describing, so adding a field to `BucketState` makes every
/// previously-written member undecodable — and the rig has no old build
/// to write one with. The honest stand-in is a member whose framing is
/// wrong in exactly that way: the map's leading `u64` element count is
/// raised, so the decoder runs off the end of the buffer looking for
/// entries that were never there. Same class of failure, same error
/// (unexpected end of file), no old binary required.
///
/// 65535 rather than `u64::MAX`: serde caps a size-hinted `reserve` at a
/// few thousand elements, so this is guaranteed to hit EOF cheaply
/// instead of asking the allocator for an absurd map first.
///
/// The manifest repair is what makes it a DECODE failure rather than a
/// torn generation: `validate` checks every member's length and BLAKE3,
/// and a mismatch there makes the whole generation step aside — which is
/// the OTHER path (`torn_resume_act`), already covered, and not this one.
/// Length is preserved and the digest is patched in place, so nothing but
/// the buckets member's CONTENT is different from what the engine wrote.
pub(crate) fn spoil_buckets_member(root: &std::path::Path) -> Result<(u64, usize)> {
    const MAGIC: &[u8] = b"POLYVISOR-ENGINE-CHECKPOINT-1\n";

    let mut gens: Vec<u64> = std::fs::read_dir(root)?
        .filter_map(std::result::Result::ok)
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_prefix("gen-"))
                .and_then(|n| n.parse::<u64>().ok())
        })
        .filter(|n| root.join(format!("gen-{n}")).join("buckets.bin").exists())
        .collect();
    gens.sort_unstable();
    let newest = *gens
        .last()
        .ok_or_else(|| format_err!("no generation carries a buckets member to spoil"))?;
    let dir = root.join(format!("gen-{newest}"));

    let mut bytes = std::fs::read(dir.join("buckets.bin"))?;
    if bytes.len() < 8 {
        bail!("buckets.bin is {} B — too short to be a bincode map", bytes.len());
    }
    let was = blake3::hash(&bytes);
    bytes[..8].copy_from_slice(&65_535u64.to_le_bytes());
    let now = blake3::hash(&bytes);
    std::fs::write(dir.join("buckets.bin"), &bytes)?;

    // Patch the manifest's recorded digest for that member (the length is
    // unchanged), then re-seal the manifest's own trailing digest.
    let manifest = dir.join("MANIFEST");
    let whole = std::fs::read(&manifest)?;
    let rest = whole
        .strip_prefix(MAGIC)
        .ok_or_else(|| format_err!("MANIFEST does not carry the expected magic"))?;
    if rest.len() < 32 {
        bail!("MANIFEST is too short to hold a payload and a digest");
    }
    let mut payload = rest[..rest.len() - 32].to_vec();
    let at = payload
        .windows(32)
        .position(|w| w == was.as_bytes())
        .ok_or_else(|| format_err!("the manifest does not record the buckets member's digest"))?;
    payload[at..at + 32].copy_from_slice(now.as_bytes());
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&payload);
    out.extend_from_slice(blake3::hash(&payload).as_bytes());
    std::fs::write(&manifest, &out)?;
    Ok((newest, bytes.len()))
}

/// AN UNDECODABLE `buckets.bin` IS ABSENCE, NOT AN ERROR — the compat
/// rule for growing `BucketState` (SYNC.md §2, and the struct's own
/// header in engine/guest/src/lib.rs).
///
/// The claim under test has two halves, and the second is what makes the
/// first affordable:
///
///  1. RESUME STILL SUCCEEDS. Everything else in the generation —
///     identity, keyhive, the partitions, the us-doc — restores exactly
///     as it would have; only the bucket map lands empty, with a note on
///     stderr. Before this rule, a `BucketState` field addition turned
///     every existing checkpoint into a device that refuses to start.
///  2. THE STORE DOES NOT FORK. The name chain is ACCOUNT state now
///     (SYNC.md §1), so the resumed device re-derives the SAME names from
///     its us-doc rather than minting a fresh chain. The re-flush is
///     therefore a re-UPLOAD (the `flushed` dedup map is genuinely gone,
///     so it sends chunks again) that lands on the key set already
///     there — one flush's worth of wasted bytes, self-healing, and no
///     second copy of the store. That is the entire cost this rule
///     accepts, and it is asserted here as SET EQUALITY over the bucket's
///     opaque object names.
pub(crate) async fn bucket_decode_tolerance_act(
    acc: &Accessor<Ctx>,
    revived: crate::bindings::Engine,
    probe: &S3Probe,
    before: &[String],
) -> Result<()> {
    let d: &Driver = revived.polyvisor_engine_driver();
    let t: &Tasks = revived.polyvisor_tasks_tasks();

    let did = step!(
        "spoiled-buckets: revived.state-resume",
        d.call_state_resume(acc)
    );
    if !did {
        bail!(
            "resume gave up on a generation whose buckets member does not decode — the growth \
             rule says treat it as absent, not as a broken checkpoint"
        );
    }
    let items = step!("spoiled-buckets: revived.tasks.items", t.call_items(acc));
    if items.items.is_empty() {
        bail!("the rest of the generation did not restore: zero todos after resume");
    }
    ok(
        &format!(
            "spoiled-buckets: resume survived an undecodable buckets member ({} todo(s) intact)",
            items.items.len()
        ),
        Instant::now(),
    );

    // The bucket map came back EMPTY, which is only observable through
    // behaviour: the dedup map is gone, so a re-flush with no mutation
    // sends chunks again. (A device that had kept its map sends zero —
    // that is `bucket_state_act`'s assertion, three lines from here in
    // spirit and the exact opposite in expected value.)
    step!(
        "spoiled-buckets: revived.init-store(s3) [addressing re-applied]",
        d.call_init_store(
            acc,
            StoreConfig::S3(S3Config {
                endpoint: probe.endpoint.clone(),
                bucket: probe.bucket.clone(),
                access_key: probe.access.clone(),
            })
        )
    );
    let pointers = step!(
        "spoiled-buckets: revived.us-partitions",
        d.call_us_partitions(acc)
    );
    let part = pointers
        .iter()
        .find(|p| p.name == "tasks")
        .ok_or_else(|| format_err!("the us-doc pointer map did not survive the resume"))?
        .id
        .clone();
    let summary = step!(
        "spoiled-buckets: revived.bucket-flush",
        d.call_bucket_flush(acc, part)
    );
    println!("            {summary}");
    let chunks = flushed_chunks(&summary)?;
    if chunks == 0 {
        bail!(
            "the re-flush sent zero chunks, so the dedup map survived — the buckets member was \
             not treated as absent and this act is proving nothing"
        );
    }

    let after = probe.keys().await?;
    let new: Vec<&String> = after.iter().filter(|k| !before.contains(k)).collect();
    if !new.is_empty() {
        bail!(
            "the re-flush wrote {} object(s) under names nobody had derived — the chain was \
             re-minted rather than re-read from the account, i.e. the store FORKED",
            new.len()
        );
    }
    ok(
        &format!(
            "spoiled-buckets: re-flush re-uploaded {chunks} chunk(s) onto the SAME {} names \
             (self-healing, one flush's cost, no second copy)",
            after.len()
        ),
        Instant::now(),
    );
    Ok(())
}
