//! Headless pairing + user-system acts (PAIRING.md §6).
//!
//! Six behaviours, each asserted rather than printed: a full pairing over
//! the local relay with the profile and a later mark reaching the new
//! device; the short authentication string agreeing on both sides; a
//! joiner refusing a commitment that does not open; a second claim on the
//! same code being refused and the offer burned; an offer expiring; two
//! devices picking the same petname concurrently and repairing to
//! byte-identical state with an announcement on both; and a revoked
//! device re-pairing as a NEW individual.
//!
//! The negative acts run in their own `Store` so their guest-side
//! verification hooks (`PM_PAIR_FAULT`, `PM_PAIR_TTL_MS`) cannot leak
//! into the positive ones.

use std::time::{Duration, Instant};

use wasmtime::component::Accessor;
use wasmtime::{bail, format_err, Result};

use crate::bindings::exports::polyvisor::engine::driver::{
    Guest as Driver, PairAddState, PairJoinState, S3Config, StoreConfig, UsEvent, UsMark,
    UsProfile, UsStorage, UsStorageGdrive, UsStorageS3,
};
use crate::resume_acts::{flushed_chunks, S3Probe};
use crate::bindings::exports::polyvisor::tasks::tasks::Guest as Tasks;
use crate::Ctx;

const POLLS: u32 = 4000;
const POLL_MS: u64 = 5;

fn ok(label: &str, t: Instant) {
    println!("[{:>9.2?}] {label}", t.elapsed());
}

async fn wait_join(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&PairJoinState) -> bool,
) -> Result<PairJoinState> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        let state = d
            .call_pair_join_status(acc)
            .await?
            .map_err(|e| format_err!("{what}: join-status: {e}"))?;
        if want(&state) {
            ok(what, t);
            return Ok(state);
        }
        last = Some(describe_join(&state));
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never reached (last state: {last:?})")
}

async fn wait_add(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&PairAddState) -> bool,
) -> Result<PairAddState> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        let state = d
            .call_pair_add_status(acc)
            .await?
            .map_err(|e| format_err!("{what}: add-status: {e}"))?;
        if want(&state) {
            ok(what, t);
            return Ok(state);
        }
        last = Some(describe_add(&state));
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never reached (last state: {last:?})")
}

fn describe_join(s: &PairJoinState) -> String {
    match s {
        PairJoinState::Waiting => "waiting".into(),
        PairJoinState::Claimed(sas) => format!("claimed({sas})"),
        PairJoinState::ConfirmedWaiting => "confirmed-waiting".into(),
        PairJoinState::Enrolled(_) => "enrolled".into(),
        PairJoinState::Expired => "expired".into(),
        PairJoinState::Failed(e) => format!("failed({e})"),
    }
}

fn describe_add(s: &PairAddState) -> String {
    match s {
        PairAddState::Connecting => "connecting".into(),
        PairAddState::SasReady(sas) => format!("sas-ready({sas})"),
        PairAddState::WaitingPeer => "waiting-peer".into(),
        PairAddState::Enrolled => "enrolled".into(),
        PairAddState::Failed(e) => format!("failed({e})"),
    }
}

/// Run one pairing ceremony to completion and return
/// `(sas, user-group-id, user-system-partition-id)`.
///
/// `expect_adder`, when given, is `(adder agent id, adder endpoint id
/// hex)` and gates the enrollment's two OBSERVED peer id fields against
/// what the adder actually is. Those fields exist so an embedder can
/// wire subduction after the ceremony (PAIRING.md §2 step 7) without
/// smuggling the adder's ids in out of band, and a WRONG id there fails
/// the way a missing one does not: the dial succeeds against the wrong
/// expectations and nothing ever flows. Only the caller that holds the
/// adder's real ids can check it, so it passes them in.
async fn pair(
    acc: &Accessor<Ctx>,
    adder: &Driver,
    joiner: &Driver,
    device_name: &str,
    expect_adder: Option<(&[u8], &str)>,
) -> Result<(String, Vec<u8>, Vec<u8>)> {
    let offer = joiner
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    if offer.code.len() != 79 {
        bail!(
            "pairing code is {} chars, contract says 79: {}",
            offer.code.len(),
            offer.code
        );
    }
    // The trusted device consumes the code exactly as a user would retype
    // it off the other screen: grouped in fours.
    let typed = offer
        .code
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect::<Vec<_>>()
        .join(" ");
    adder
        .call_pair_add_start(acc, typed)
        .await?
        .map_err(|e| format_err!("pair-add-start: {e}"))?;

    let join_state = wait_join(acc, joiner, "joiner shows the SAS", |s| {
        !matches!(s, PairJoinState::Waiting)
    })
    .await?;
    let add_state = wait_add(acc, adder, "adder shows the SAS", |s| {
        !matches!(s, PairAddState::Connecting)
    })
    .await?;
    let (PairJoinState::Claimed(sas_j), PairAddState::SasReady(sas_a)) = (&join_state, &add_state)
    else {
        bail!(
            "ceremony did not reach the SAS: joiner {}, adder {}",
            describe_join(&join_state),
            describe_add(&add_state)
        );
    };
    // The whole point of the ceremony: two users read the same string.
    if sas_j != sas_a {
        bail!("SAS MISMATCH: joiner {sas_j} != adder {sas_a}");
    }
    if sas_j.len() != 6 || !sas_j.chars().all(|c| c.is_ascii_digit()) {
        bail!("SAS is not six decimal digits: {sas_j}");
    }
    println!("            SAS agrees on both sides ({sas_j}), six digits");

    joiner
        .call_pair_join_confirm(acc)
        .await?
        .map_err(|e| format_err!("pair-join-confirm: {e}"))?;
    adder
        .call_pair_add_confirm(acc, device_name.to_string())
        .await?
        .map_err(|e| format_err!("pair-add-confirm: {e}"))?;

    let enrolled = wait_join(acc, joiner, "joiner enrolled", |s| {
        matches!(s, PairJoinState::Enrolled(_) | PairJoinState::Failed(_))
    })
    .await?;
    let PairJoinState::Enrolled(enrollment) = enrolled else {
        bail!("joiner did not enrol: {}", describe_join(&enrolled));
    };
    wait_add(acc, adder, "adder enrolled", |s| {
        matches!(s, PairAddState::Enrolled | PairAddState::Failed(_))
    })
    .await?;
    if let Some((want_agent, want_ep)) = expect_adder {
        // Observed, not asserted: the endpoint id is the dialer iroh
        // authenticated, and the agent id is the ISSUER of the delegation
        // in the ENROLL card (guest/src/pairing.rs's
        // `adder_agent_from_enroll_card`).
        if enrollment.peer_agent_id != want_agent {
            bail!(
                "pair-enrollment.peer-agent-id is not the adder's agent id \
                 (got {} bytes, {}; want {})",
                enrollment.peer_agent_id.len(),
                hex::encode(&enrollment.peer_agent_id),
                hex::encode(want_agent)
            );
        }
        if hex::encode(&enrollment.peer_endpoint_id) != want_ep {
            bail!(
                "pair-enrollment.peer-endpoint-id is not the adder's endpoint id \
                 (got {}; want {want_ep})",
                hex::encode(&enrollment.peer_endpoint_id)
            );
        }
        println!(
            "            enrollment carries the adder's observed agent + endpoint ids"
        );
    }
    Ok((
        sas_j.clone(),
        enrollment.user_group_id,
        enrollment.partition_id,
    ))
}

/// Wire subduction between two paired devices and subscribe both ways to
/// the user-system tree.
async fn wire_us(
    acc: &Accessor<Ctx>,
    hub: (&Driver, &str, &[u8], &str),
    member: (&Driver, &str, &[u8]),
    tree: &[u8],
    relay: &str,
) -> Result<()> {
    let (h, h_name, h_id, h_ep) = hub;
    let (m, m_name, m_id) = member;
    crate::connect(acc, (m, m_name, h_id), (h, h_name, h_ep), relay).await?;
    for (d, name, peer) in [(m, m_name, h_id), (h, h_name, m_id)] {
        let handle = d
            .call_sync_start(acc, peer.to_vec(), tree.to_vec(), true)
            .await?
            .map_err(|e| format_err!("{name} sync-start: {e}"))?;
        for _ in 0..POLLS {
            match d.call_sync_status(acc, handle).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(Duration::from_millis(3)).await,
                Err(e) => bail!("{name} sync: {e}"),
            }
        }
    }
    Ok(())
}

/// Subscribe both ends of an ALREADY-wired pair to one more tree. The
/// iroh connection is `wire_us`'s; only the per-tree subscription is new.
async fn sync_tree(
    acc: &Accessor<Ctx>,
    a: (&Driver, &str, &[u8]),
    b: (&Driver, &str, &[u8]),
    tree: &[u8],
) -> Result<()> {
    let (ad, a_name, a_id) = a;
    let (bd, b_name, b_id) = b;
    for (d, name, peer) in [(ad, a_name, b_id), (bd, b_name, a_id)] {
        let handle = d
            .call_sync_start(acc, peer.to_vec(), tree.to_vec(), true)
            .await?
            .map_err(|e| format_err!("{name} sync-start: {e}"))?;
        for _ in 0..POLLS {
            match d.call_sync_status(acc, handle).await? {
                Ok(Some(_)) => break,
                Ok(None) => tokio::time::sleep(Duration::from_millis(3)).await,
                Err(e) => bail!("{name} sync: {e}"),
            }
        }
    }
    Ok(())
}

async fn wait_marks(
    acc: &Accessor<Ctx>,
    d: &Driver,
    what: &str,
    want: impl Fn(&[UsMark]) -> bool,
) -> Result<Vec<UsMark>> {
    let t = Instant::now();
    let mut last = None;
    for _ in 0..POLLS {
        match d.call_us_marks_list(acc).await? {
            Ok(marks) => {
                if want(&marks) {
                    ok(what, t);
                    return Ok(marks);
                }
                last = Some(format!("{} marks {marks:?}", marks.len()));
            }
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!("{what}: never held (last: {last:?})")
}

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

/// THE ACCOUNT'S STORAGE RECORD, both halves of the ruling in DRIVE.md
/// ("The account syncs its storage config; devices keep their
/// credentials"): the destination and the client pair SYNC, and a
/// destination change on one device is ANNOUNCED on the others — never
/// silently adopted, and never echoed back to the device that wrote it.
///
/// Three beats:
///
///  1. The laptop binds a Google Drive destination. Every field of the
///     record reaches the phone, byte for byte — including the client
///     pair, which is app identity riding the account's E2E channel.
///     (The values here are SYNTHETIC and labelled as such; nothing in
///     this act is, or resembles, real credential material. What the
///     record CANNOT carry is the point: there is no token field and no
///     consent field in the shape at all.)
///  2. The phone re-binds to S3 — the arm that structurally carries no
///     secret, since the SigV4 secret exists only as a non-extractable
///     handle. The laptop reads the new destination back.
///  3. The laptop is TOLD ("storage-changed(s3)"), and the phone, which
///     wrote it, is not.
async fn act_storage_config(acc: &Accessor<Ctx>, l: &Driver, p: &Driver) -> Result<()> {
    // SYNTHETIC values throughout — labelled so that no reader mistakes
    // them for material worth protecting.
    let gdrive = UsStorageGdrive {
        root: "polyvisor-synthetic".into(),
        api_base: "https://www.googleapis.com".into(),
        // The STACK'S vocabulary for this field is "appdata" (the WIT
        // types it as a bare string, but every reader of the record —
        // `StoreBinding.space`, the sheet's radio values, the gdrive
        // strategy — spells the hidden space this way; "appDataFolder"
        // is the PROVIDER's wire word for the same place, and does not
        // belong in the record).
        space: "appdata".into(),
        client_id: "SYNTHETIC-CLIENT".into(),
        client_secret: "synthetic-client-secret-0000".into(),
    };

    // Beat 1: the laptop binds, and reads back its own write.
    l.call_us_storage_put(acc, UsStorage::Gdrive(gdrive.clone()))
        .await?
        .map_err(|e| format_err!("us-storage-put(gdrive): {e}"))?;
    match l.call_us_storage_get(acc).await?.map_err(|e| format_err!("{e}"))? {
        Some(UsStorage::Gdrive(v)) if same_gdrive(&v, &gdrive) => {}
        other => bail!("the writer does not read back its own storage record: {}", describe_storage(&other)),
    }

    let t = Instant::now();
    let mut announced: Vec<UsEvent> = Vec::new();
    let mut synced = None;
    for _ in 0..POLLS {
        let got = p.call_us_storage_get(acc).await?.map_err(|e| format_err!("{e}"))?;
        announced.extend(p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
        if let Some(UsStorage::Gdrive(v)) = got {
            synced = Some(v);
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    let Some(synced) = synced else {
        bail!("the account's storage record never reached the second device");
    };
    if !same_gdrive(&synced, &gdrive) {
        bail!("the storage record arrived with different fields than were written");
    }
    ok("gdrive storage record syncs to the second device, field for field", t);
    if !announced
        .iter()
        .any(|e| matches!(e, UsEvent::StorageChanged(prov) if prov == "gdrive"))
    {
        bail!(
            "the account's first storage bind was not announced on the other device: {:?}",
            describe_events(&announced)
        );
    }

    // The WRITER gets no echo of its own bind. Drained here (destructively)
    // so beat 3's drain on this device can only contain what beat 2 causes.
    let l_events = l.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?;
    if l_events.iter().any(|e| matches!(e, UsEvent::StorageChanged(_))) {
        bail!(
            "the binding device was announced its own storage write: {:?}",
            describe_events(&l_events)
        );
    }
    ok("the binding device receives no event for its own storage write", Instant::now());

    // Beat 2: the phone re-binds the account to S3 — the arm with no
    // secret in it, by construction.
    let s3 = UsStorageS3 {
        endpoint: "http://127.0.0.1:9000".into(),
        bucket: "synthetic-bucket".into(),
        access_key: "SYNTHETIC-ACCESS-KEY-ID".into(),
    };
    p.call_us_storage_put(acc, UsStorage::S3(s3.clone()))
        .await?
        .map_err(|e| format_err!("us-storage-put(s3): {e}"))?;

    // Beat 3: the laptop reads the new destination AND is told about it.
    let t = Instant::now();
    let mut l_announced: Vec<UsEvent> = Vec::new();
    let mut switched = None;
    for _ in 0..POLLS {
        let got = l.call_us_storage_get(acc).await?.map_err(|e| format_err!("{e}"))?;
        l_announced.extend(l.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
        if let Some(UsStorage::S3(v)) = got {
            switched = Some(v);
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    let Some(switched) = switched else {
        bail!("the re-bound destination never reached the other device");
    };
    if switched.endpoint != s3.endpoint
        || switched.bucket != s3.bucket
        || switched.access_key != s3.access_key
    {
        bail!("the re-bound s3 record arrived with different addressing than was written");
    }
    ok("the other device reads the re-bound destination (gdrive -> s3)", t);

    if !l_announced
        .iter()
        .any(|e| matches!(e, UsEvent::StorageChanged(prov) if prov == "s3"))
    {
        bail!(
            "the remote destination change was not announced: {:?}",
            describe_events(&l_announced)
        );
    }
    ok("the remote destination change is ANNOUNCED, never silently adopted", Instant::now());

    let p_events = p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?;
    if p_events.iter().any(|e| matches!(e, UsEvent::StorageChanged(_))) {
        bail!(
            "the re-binding device was announced its own storage write: {:?}",
            describe_events(&p_events)
        );
    }
    ok("the re-binding device drains no storage-changed of its own", Instant::now());
    Ok(())
}

/// Field-for-field, including the client pair: this is the assertion
/// that the account carries the whole destination, not a summary of it.
fn same_gdrive(a: &UsStorageGdrive, b: &UsStorageGdrive) -> bool {
    a.root == b.root
        && a.api_base == b.api_base
        && a.space == b.space
        && a.client_id == b.client_id
        && a.client_secret == b.client_secret
}

/// Provider + addressing only. Deliberately never prints the client
/// pair, even though these are synthetic values: act output is a log.
fn describe_storage(s: &Option<UsStorage>) -> String {
    match s {
        None => "none".into(),
        Some(UsStorage::S3(v)) => format!("s3({}, {})", v.endpoint, v.bucket),
        Some(UsStorage::Gdrive(v)) => format!("gdrive({}, {})", v.api_base, v.space),
    }
}

fn describe_events(events: &[UsEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| match e {
            UsEvent::ProfileChanged => "profile-changed".to_string(),
            UsEvent::MarkAdded(p) => format!("mark-added({p})"),
            UsEvent::MarkChanged(p) => format!("mark-changed({p})"),
            UsEvent::MarkConflictRepaired((p, k)) => format!("mark-conflict-repaired({p},{k})"),
            UsEvent::DeviceAdded(n) => format!("device-added({n})"),
            UsEvent::DeviceRevoked(n) => format!("device-revoked({n})"),
            UsEvent::StorageChanged(p) => format!("storage-changed({p})"),
        })
        .collect()
}

/// The positive act set. Each gate is recorded rather than aborting the
/// run, so one blocked gate does not hide the state of the others; the
/// caller fails if any of them failed.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn positive_acts(
    acc: &Accessor<Ctx>,
    laptop: crate::bindings::Engine,
    phone: crate::bindings::Engine,
    stranger: crate::bindings::Engine,
    rejoin: crate::bindings::Engine,
    relay: String,
    probe: &S3Probe,
) -> Result<()> {
    let l: &Driver = laptop.polyvisor_engine_driver();
    let p: &Driver = phone.polyvisor_engine_driver();
    let x: &Driver = stranger.polyvisor_engine_driver();
    let r: &Driver = rejoin.polyvisor_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("laptop init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("phone init: {e}"))?;
    x.call_init(acc, false).await?.map_err(|e| format_err!("stranger init: {e}"))?;
    r.call_init(acc, false).await?.map_err(|e| format_err!("rejoin init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;

    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    for d in [p, x, r] {
        d.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    }

    let group = l
        .call_user_create(
            acc,
            UsProfile {
                display_name: "Alice".into(),
                // Palette INDEX, not an angle (PAIRING.md §4).
                hue: 3,
                icon: None,
            },
        )
        .await?
        .map_err(|e| format_err!("user-create: {e}"))?;
    println!("            user group created, user-system partition sealed");

    let mut results: Vec<(&str, std::result::Result<(), String>)> = Vec::new();

    // --- gates 1+2: the ceremony itself, and the SAS agreeing ---
    let (sas, joined_group, partition) = pair(acc, l, p, "alice phone", Some((&l_bytes, &l_ep))).await?;
    results.push(("full pair over the local relay", Ok(())));
    // `pair` compares the two sides' strings and bails on any mismatch,
    // on a non-six-digit string, or on a non-numeric one, so reaching
    // here IS the assertion; recorded separately because it is the
    // property the whole ceremony exists to establish.
    results.push((
        "SAS equal on both sides",
        if sas.len() == 6 {
            Ok(())
        } else {
            Err(format!("SAS is not six digits: {sas}"))
        },
    ));
    results.push((
        "enrollment carries the adder's own user group",
        if joined_group == group {
            Ok(())
        } else {
            Err("enrollment carried a different user group than the adder holds".into())
        },
    ));

    // Local-echo suppression: the adder wrote the devices entry itself,
    // so it must not be told about it.
    let l_events = l.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?;
    results.push((
        "adder receives no event for its own write",
        if l_events
            .iter()
            .any(|e| matches!(e, UsEvent::DeviceAdded(n) if n == "alice phone"))
        {
            Err(format!(
                "the adder was announced its own devices write: {:?}",
                describe_events(&l_events)
            ))
        } else {
            Ok(())
        },
    ));

    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    results.push((
        "the new device is recorded in us-devices-list",
        if devices.iter().any(|d| d.name == "alice phone" && !d.revoked) {
            Ok(())
        } else {
            Err(format!(
                "missing: {:?}",
                devices.iter().map(|d| d.name.clone()).collect::<Vec<_>>()
            ))
        },
    ));

    // The joiner needs the wire to pull the partition it just adopted.
    wire_us(
        acc,
        (l, "laptop", &l_bytes, l_ep.as_str()),
        (p, "phone", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    let adoption = act_adoption(acc, l, p).await;
    let adopted = adoption.is_ok();
    results.push((
        "joiner adopts the profile; a later mark reaches it",
        adoption.map_err(|e| e.to_string()),
    ));

    if adopted {
        results.push((
            "concurrent same-petname and same-icon repairs identically on both devices",
            act_repair(acc, l, p).await.map_err(|e| e.to_string()),
        ));
    } else {
        results.push((
            "concurrent same-petname and same-icon repairs identically on both devices",
            Err("not reached: the joiner never became a reader of the partition".into()),
        ));
    }

    let mut shared_partition: Option<Vec<u8>> = None;
    if adopted {
        let outcome = act_partition_pointer(
            acc,
            (l, laptop.polyvisor_tasks_tasks(), &l_bytes),
            (p, phone.polyvisor_tasks_tasks(), &p_bytes),
            &group,
        )
        .await;
        results.push((
            "partition pointer syncs; group-delegated partition is readable by the joiner",
            match outcome {
                Ok(id) => {
                    shared_partition = Some(id);
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            },
        ));
    } else {
        results.push((
            "partition pointer syncs; group-delegated partition is readable by the joiner",
            Err("not reached: the joiner never became a reader of the user-system partition".into()),
        ));
    }

    // SYNC.md §1: the name-key chain is account state, so two devices of
    // one account address the SAME objects.
    results.push((
        "the bucket name-key chain syncs with the account: both devices flush to          identical object names (structural dedupe)",
        match &shared_partition {
            Some(partition) => act_bucket_chain(
                acc,
                (l, laptop.polyvisor_tasks_tasks(), &l_bytes),
                (p, phone.polyvisor_tasks_tasks()),
                partition,
                probe,
            )
            .await
            .map_err(|e| e.to_string()),
            None => Err("not reached: the two devices never came to share a partition".into()),
        },
    ));

    if adopted {
        results.push((
            "the account's storage record syncs; a remote destination change is \
             announced, never echoed to its writer",
            act_storage_config(acc, l, p).await.map_err(|e| e.to_string()),
        ));
    } else {
        results.push((
            "the account's storage record syncs; a remote destination change is \
             announced, never echoed to its writer",
            Err("not reached: the joiner never became a reader of the user-system partition".into()),
        ));
    }

    results.push((
        "a second claim on the same code is refused",
        act_second_claim(acc, l, x, r).await.map_err(|e| e.to_string()),
    ));

    results.push((
        "revoke a device, then re-pair the same hardware as a NEW individual",
        act_revoke_and_repair(acc, l, r, &p_bytes, &group, &partition)
            .await
            .map_err(|e| e.to_string()),
    ));

    println!("\n--- positive pairing gates ---");
    let mut failed = 0;
    for (name, outcome) in &results {
        match outcome {
            Ok(()) => println!("  PASS  {name}"),
            Err(e) => {
                failed += 1;
                println!("  FAIL  {name}\n          {e}");
            }
        }
    }
    if failed > 0 {
        bail!("{failed} positive pairing gate(s) failed");
    }
    println!("\nPAIRING ACTS (positive) PASSED");
    Ok(())
}

/// Adoption + marks propagation: the joiner takes on the account's
/// profile, is told about it (#22: remotely-caused changes are
/// announced), and sees a mark written afterwards on the other device.
async fn act_adoption(acc: &Accessor<Ctx>, l: &Driver, p: &Driver) -> Result<()> {
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://recipes.example/".into(),
            petname: "Recipes".into(),
            icon: "🥕".into(),
            nickname: None,
            created_at: 1_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put: {e}"))?;

    let t = Instant::now();
    let mut adopted = false;
    for _ in 0..POLLS {
        let profile = p.call_us_profile_get(acc).await?.map_err(|e| format_err!("{e}"))?;
        if profile.display_name == "Alice" && profile.hue == 3 {
            adopted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !adopted {
        // Which half is broken: can the joiner WRITE into the doc (i.e.
        // does it hold a usable CGKA position at all), and if so can the
        // founder read what it wrote?
        // Diagnostic, failure path only: which DIRECTION is broken. It
        // writes, which is why it never runs on a passing gate.
        match p
            .call_us_profile_set(
                acc,
                UsProfile { display_name: "from-joiner".into(), hue: 9, icon: None },
            )
            .await?
        {
            Ok(()) => {
                println!(
                    "            DIAGNOSTIC: the joiner CAN encrypt into the partition \
                     (it holds a usable epoch of its own)"
                );
                let mut seen = false;
                for _ in 0..600 {
                    if let Ok(pr) = l.call_us_profile_get(acc).await? {
                        if pr.display_name == "from-joiner" { seen = true; break; }
                    }
                    tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
                }
                println!(
                    "            DIAGNOSTIC: founder reads the joiner's write = {seen} \
                     (the founder's own writes stay unreadable to the joiner)"
                );
            }
            Err(e) => println!("            DIAGNOSTIC: the joiner cannot encrypt either: {e}"),
        }
        bail!(
            "the joiner never became able to read the user-system partition \
             (every chunk stays undecryptable: see the report's finding on \
             enrolment into a doc that was sealed before the device joined)"
        );
    }
    ok("joiner adopted the profile (name + hue)", t);

    // Drains are destructive, and adoption plus the mark can land in the
    // SAME apply — so the announcements are ACCUMULATED across the act
    // rather than asserted against whichever drain happens to catch them.
    // (Splitting them was a latent assumption that the two arrive in
    // separate rounds; faster delivery merges them.)
    let mut announced: Vec<UsEvent> = Vec::new();
    announced.extend(p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);

    let devices = p.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !devices.iter().any(|d| d.name == "alice phone" && !d.revoked) {
        bail!("the joiner does not see itself in us-devices-list");
    }

    let t = Instant::now();
    let mut seen_mark = false;
    for _ in 0..POLLS {
        let marks = p.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
        announced.extend(p.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
        if marks.iter().any(|m| m.petname == "Recipes") {
            seen_mark = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !seen_mark {
        bail!("the mark written on the laptop never reached the phone");
    }
    ok("mark written on the laptop reaches the phone", t);

    if !announced.iter().any(|e| matches!(e, UsEvent::ProfileChanged)) {
        bail!(
            "adoption was not announced to the joiner: {:?}",
            describe_events(&announced)
        );
    }
    if !announced
        .iter()
        .any(|e| matches!(e, UsEvent::MarkAdded(prov) if prov == "https://recipes.example/"))
    {
        bail!(
            "the remote mark was not announced: {:?}",
            describe_events(&announced)
        );
    }
    println!("            joiner announcements: {:?}", describe_events(&announced));
    Ok(())
}

/// Two races against the same pair of devices, neither having seen the
/// other's write before the merge:
///
///  1. Two devices name different sites the same thing (petname
///     collision, case-insensitive). Both must land on identical
///     repaired state — announced, never silent, never blocking. The
///     loser keeps its petname bytes and is flagged for reconfirm.
///  2. Two devices mark different provenances with the SAME pet icon
///     (icon collision, #22). The engine cannot invent a replacement
///     glyph (the curated vocabulary is the visor's), so the loser's
///     icon is cleared to "" and flagged for reconfirm — the visor
///     re-offers its picker on reconfirm.
async fn act_repair(acc: &Accessor<Ctx>, l: &Driver, p: &Driver) -> Result<()> {
    let _ = l.call_us_events(acc).await?;
    let _ = p.call_us_events(acc).await?;

    // --- race 1: same petname, DIFFERENT icons (isolates the petname
    // repair from the icon repair below) ---
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://notes-a.example/".into(),
            petname: "Notes".into(),
            icon: "🍇".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(a): {e}"))?;
    p.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://notes-b.example/".into(),
            // Case-insensitive collision, deliberately: "notes" and
            // "Notes" are the same name to a person.
            petname: "notes".into(),
            icon: "🍎".into(),
            nickname: None,
            created_at: 3_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(b): {e}"))?;

    let want = |m: &[UsMark]| {
        m.len() == 3
            && m.iter()
                .any(|x| x.provenance == "https://notes-b.example/" && x.needs_reconfirm)
            && m.iter()
                .any(|x| x.provenance == "https://notes-a.example/" && x.petname == "Notes")
    };
    let l_marks = wait_marks(acc, l, "laptop repaired the petname collision", want).await?;
    let p_marks = wait_marks(acc, p, "phone repaired the petname collision", want).await?;
    if !same_marks(&l_marks, &p_marks) {
        bail!("PETNAME REPAIR DIVERGED:\n  laptop {l_marks:?}\n  phone  {p_marks:?}");
    }
    let loser = p_marks
        .iter()
        .find(|m| m.provenance == "https://notes-b.example/")
        .ok_or_else(|| format_err!("petname loser mark vanished"))?;
    if loser.petname != "notes" {
        bail!("the petname loser lost its name bytes: {}", loser.petname);
    }
    println!("            older mark keeps petname; younger loser flagged for reconfirm");

    for (d, name) in [(l, "laptop"), (p, "phone")] {
        let mut announced = Vec::new();
        let t = Instant::now();
        for _ in 0..POLLS {
            announced.extend(d.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
            if announced.iter().any(
                |e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "petname"),
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
        if !announced
            .iter()
            .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "petname"))
        {
            bail!(
                "{name} repaired the petname collision silently — no announcement: {:?}",
                describe_events(&announced)
            );
        }
        ok(&format!("{name} announced the petname repair"), t);
        println!("            {name}: {:?}", describe_events(&announced));
    }

    // --- race 2: DIFFERENT petnames, same icon (#22 icon collision) ---
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://icon-a.example/".into(),
            petname: "Alpha".into(),
            icon: "🐝".into(),
            nickname: None,
            created_at: 4_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(icon-a): {e}"))?;
    p.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://icon-b.example/".into(),
            petname: "Bravo".into(),
            icon: "🐝".into(),
            nickname: None,
            created_at: 5_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("us-mark-put(icon-b): {e}"))?;

    let icon_want = |m: &[UsMark]| {
        m.len() == 5
            && m.iter()
                .any(|x| x.provenance == "https://icon-b.example/" && x.needs_reconfirm)
            && m.iter()
                .any(|x| x.provenance == "https://icon-a.example/" && x.icon == "🐝")
    };
    let l_marks = wait_marks(acc, l, "laptop repaired the icon collision", icon_want).await?;
    let p_marks = wait_marks(acc, p, "phone repaired the icon collision", icon_want).await?;
    if !same_marks(&l_marks, &p_marks) {
        bail!("ICON REPAIR DIVERGED:\n  laptop {l_marks:?}\n  phone  {p_marks:?}");
    }
    let icon_loser = p_marks
        .iter()
        .find(|m| m.provenance == "https://icon-b.example/")
        .ok_or_else(|| format_err!("icon loser mark vanished"))?;
    // The engine cannot invent a replacement glyph — the loser is
    // cleared to "" (unmarked), not reassigned to some other glyph.
    if !icon_loser.icon.is_empty() {
        bail!(
            "the icon loser was not cleared: still {:?}",
            icon_loser.icon
        );
    }
    if icon_loser.petname != "Bravo" {
        bail!("the icon loser lost its petname bytes: {}", icon_loser.petname);
    }
    println!(
        "            older mark keeps icon 🐝; younger loser cleared to \"\" and flagged for reconfirm"
    );

    for (d, name) in [(l, "laptop"), (p, "phone")] {
        let mut announced = Vec::new();
        let t = Instant::now();
        for _ in 0..POLLS {
            announced.extend(d.call_us_events(acc).await?.map_err(|e| format_err!("{e}"))?);
            if announced
                .iter()
                .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "icon"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        }
        if !announced
            .iter()
            .any(|e| matches!(e, UsEvent::MarkConflictRepaired((_, k)) if k == "icon"))
        {
            bail!(
                "{name} repaired the icon collision silently — no announcement: {:?}",
                describe_events(&announced)
            );
        }
        ok(&format!("{name} announced the icon repair"), t);
        println!("            {name}: {:?}", describe_events(&announced));
    }
    Ok(())
}

/// The partition-pointer map, and the group-delegation path the solo
/// page depends on (#36).
///
/// Two beats, in the order a real account performs them:
///
///  1. **The pointer syncs.** The founder publishes
///     `us-partition-put("tasks", id)` into the user-system doc; the
///     joined device reads it back out of `us-partitions` after sync.
///     Without this the joiner has membership and no name for the data.
///  2. **The group delegation actually grants access.** The partition is
///     delegated to the USER GROUP — `kh-add-member(partition, group,
///     "edit")`, the group id, never the joiner's individual — and the
///     joiner, which is a member of that group by enrollment alone,
///     adopts the partition it learned in beat 1 and READS content the
///     founder wrote. That is the whole premise of "every enrolled
///     device sees the todo list": transitive membership, no per-device
///     delegation.
///
/// Ordering is the same load-bearing create -> add-member -> seal the
/// WIT documents: epoch membership at seal time is what decides
/// readability.
async fn act_partition_pointer(
    acc: &Accessor<Ctx>,
    l: (&Driver, &Tasks, &[u8]),
    p: (&Driver, &Tasks, &[u8]),
    group: &[u8],
) -> Result<Vec<u8>> {
    let (l, lt, l_bytes) = l;
    let (p, pt, p_bytes) = p;

    let partition = l
        .call_create_partition(acc)
        .await?
        .map_err(|e| format_err!("create-partition: {e}"))?;
    // The GROUP, not an individual: this is the delegation the joiner's
    // access has to come through.
    l.call_kh_add_member(acc, partition.clone(), group.to_vec(), "edit".to_string())
        .await?
        .map_err(|e| format_err!("kh-add-member(partition, USER GROUP, edit): {e}"))?;
    l.call_seal_partition(acc, partition.clone())
        .await?
        .map_err(|e| format_err!("seal-partition: {e}"))?;
    println!("            tasks partition created, delegated to the user group, sealed");

    // Beat 1: publish the pointer, and read it back on the other device.
    l.call_us_partition_put(acc, "tasks".to_string(), partition.clone())
        .await?
        .map_err(|e| format_err!("us-partition-put: {e}"))?;
    let mine = l.call_us_partitions(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !mine.iter().any(|x| x.name == "tasks" && x.id == partition) {
        bail!(
            "the writer does not read back its own pointer: {:?}",
            mine.iter().map(|x| x.name.clone()).collect::<Vec<_>>()
        );
    }

    let t = Instant::now();
    let mut seen = None;
    for _ in 0..POLLS {
        let listed = p.call_us_partitions(acc).await?.map_err(|e| format_err!("{e}"))?;
        if let Some(entry) = listed.iter().find(|x| x.name == "tasks") {
            seen = Some(entry.id.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    let Some(seen) = seen else {
        bail!("the partition pointer never reached the joined device");
    };
    if seen != partition {
        bail!("the joined device read a DIFFERENT partition id than was published");
    }
    ok("joined device discovers the tasks partition via us-partitions", t);

    // Beat 2: adopt what was discovered, and read through the group
    // delegation alone.
    p.call_adopt_partition(acc, seen.clone())
        .await?
        .map_err(|e| format_err!("adopt-partition (as a GROUP member): {e}"))?;
    sync_tree(acc, (l, "laptop", l_bytes), (p, "phone", p_bytes), &partition).await?;

    lt.call_add(acc, "milk (written by the founder)".to_string())
        .await?
        .map_err(|e| format_err!("tasks-add: {e}"))?;

    let t = Instant::now();
    let mut last = String::new();
    for _ in 0..POLLS {
        match pt.call_items(acc).await? {
            Ok(snap) => {
                if snap.items.iter().any(|i| i.title == "milk (written by the founder)") {
                    ok(
                        "joined device READS the group-delegated partition (no per-device delegation)",
                        t,
                    );
                    // Handed back for the chain act, which needs a
                    // partition BOTH devices already hold.
                    return Ok(partition);
                }
            }
            Err(e) => last = e,
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    bail!(
        "GROUP-DELEGATION FINDING: the joined device adopted the partition it \
         discovered but never read the founder's content. The partition was \
         delegated to the USER GROUP only; the device is a member of that group \
         by enrollment. Last tasks error on the joiner: {last:?}"
    )
}

/// THE NAME-KEY CHAIN IS ACCOUNT STATE (runtime/SYNC.md §1).
///
/// The defect this pins: the chain used to be minted per DEVICE, from
/// `rand::random()`, with the pickup object as its only distribution
/// channel — and nothing on the solo path reads a pickup. Two devices of
/// ONE account bound to ONE bucket therefore wrote two parallel keyed
/// namespaces: different derived names for the same content, the whole
/// history duplicated once per flusher, and neither able to read the
/// other's objects. The fix moves the chain into the user-system
/// document, where the account's devices already sync everything else
/// they must agree on.
///
/// WHY THE ASSERTION IS OVER NAMES AND NOT OVER KEYS. A name-key is
/// secret material and never leaves the guest — there is no WIT call
/// that returns one, deliberately. What IS observable is the bucket: an
/// object name is an HMAC of a name-key over a public content ref, so
/// two devices land on the same name if and only if they hold the same
/// chain. The store is the oracle, and it is the one that matters —
/// equal chains that somehow produced unequal names would be a fix that
/// fixed nothing.
///
/// The shape, in three counts:
///
///  1. The laptop flushes. The bucket holds its chunks, its oplog, its
///     manifest.
///  2. The phone — same account, same partition, content already
///     received OVER THE WIRE, and with an empty dedup map of its own —
///     flushes the same history. It really does upload chunks (count
///     asserted non-zero, from the flush summary, because the bucket
///     cannot see a re-upload that lands on an existing name).
///  3. Those uploads add ZERO new chunk objects. The only two objects
///     that appear are the phone's own oplog and manifest, which are
///     keyed by device on purpose (the single-writer-per-name invariant).
///
/// Count 3 is the claim. Under the old per-device minting it would have
/// been "every chunk again, under names the laptop cannot derive".
async fn act_bucket_chain(
    acc: &Accessor<Ctx>,
    l: (&Driver, &Tasks, &[u8]),
    p: (&Driver, &Tasks),
    partition: &[u8],
    probe: &S3Probe,
) -> Result<()> {
    let (l, lt, l_id) = l;
    let (p, _pt) = p;

    let store_cfg = || {
        StoreConfig::S3(S3Config {
            endpoint: probe.endpoint.clone(),
            bucket: probe.bucket.clone(),
            access_key: probe.access.clone(),
        })
    };

    // Both devices, one destination. (The account syncs the storage
    // RECORD, but each device applies its own credentials — DRIVE.md —
    // so the rig binds both explicitly, exactly as an embedder would.)
    l.call_init_store(acc, store_cfg())
        .await?
        .map_err(|e| format_err!("laptop init-store: {e}"))?;
    p.call_init_store(acc, store_cfg())
        .await?
        .map_err(|e| format_err!("phone init-store: {e}"))?;
    l.call_ensure_bucket(acc)
        .await?
        .map_err(|e| format_err!("ensure-bucket: {e}"))?;

    // A little history to duplicate, if the chains disagree.
    for title in ["chain: buy milk", "chain: name the objects"] {
        lt.call_add(acc, title.to_string())
            .await?
            .map_err(|e| format_err!("tasks-add: {e}"))?;
    }

    // NO BARRIER BETWEEN THE TWO FLUSHES, AND THAT IS THE ASSERTION
    // (SYNC.md §1, amended).
    //
    // An earlier draft of this act had to WAIT between the flushes —
    // write a marker into the account doc after the laptop's flush and
    // poll until the phone saw it — because the chain was minted at
    // FIRST FLUSH, so there was a real window in which the phone would
    // mint a fork of its own. That window is closed at the source:
    // `us-partition-put` now SEEDS the chain in the same atomic
    // automerge change as the pointer. A device cannot flush a doc whose
    // pointer it has not seen, so pointer-visible implies
    // chain-visible, and no chain-specific waiting can be necessary.
    //
    // THE PRECONDITION IS CHECKED HERE, BEFORE THE LAPTOP FLUSHES, and
    // that placement is the whole discipline. Every driver call pumps
    // the account document, so a check made BETWEEN the two flushes
    // would hand the phone exactly the sync opportunity the seeding is
    // supposed to make unnecessary — the act would pass whether or not
    // the seed existed (confirmed empirically: it did). Checked here,
    // nothing at all runs between the laptop's flush and the phone's,
    // so the only way the phone can hold a matching chain is to have
    // had it before the laptop ever flushed — which is what the seed
    // means.
    let listed = p.call_us_partitions(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !listed.iter().any(|x| x.id == partition) {
        bail!(
            "PRECONDITION: the phone does not hold the pointer for this partition, so the \
             seeding guarantee does not apply to it and this act would be asserting nothing. \
             It lists: {:?}",
            listed.iter().map(|x| x.name.clone()).collect::<Vec<_>>()
        );
    }
    ok(
        "the phone holds the partition's pointer BEFORE either device flushes — so by \
         construction it already holds the chain seeded in the pointer's own change",
        Instant::now(),
    );

    let empty = probe.keys().await?;
    if !empty.is_empty() {
        bail!(
            "this act's bucket is not empty before it starts ({} object(s)): the counts below \
             would be measuring someone else's run",
            empty.len()
        );
    }

    // THE TWO FLUSHES RUN CONCURRENTLY, AND THAT IS WHAT MAKES THIS
    // GATE DISCRIMINATE.
    //
    // Sequencing them cannot do it, and the empirics say so plainly: with
    // the seeding removed, back-to-back sequential flushes still agreed
    // on names 2 runs in 3, because every driver call pumps the account
    // document and the laptop's flush-time mint had simply already
    // arrived over the wire. A gate that passes two thirds of the time
    // without the mechanism it is gating is measuring the relay, not the
    // design.
    //
    // Concurrency removes the sync opportunity BY CONSTRUCTION rather
    // than by being quick. Neither device can have observed a chain the
    // other minted during a flush that has not finished. So:
    //
    //  - SEEDED (SYNC.md §1, amended): both already hold the chain that
    //    came with the pointer, before either call starts. Concurrency
    //    is irrelevant and the names agree.
    //  - MINTED AT FIRST FLUSH: both find no chain, both mint, and the
    //    namespaces fork — not sometimes, but necessarily.
    let t = Instant::now();
    let (l_res, p_res) = tokio::join!(
        l.call_bucket_flush(acc, partition.to_vec()),
        p.call_bucket_flush(acc, partition.to_vec()),
    );
    let laptop_summary = l_res?.map_err(|e| format_err!("laptop bucket-flush: {e}"))?;
    let phone_summary = p_res?.map_err(|e| format_err!("phone bucket-flush: {e}"))?;
    let laptop_chunks = flushed_chunks(&laptop_summary)?;
    let phone_chunks = flushed_chunks(&phone_summary)?;
    println!("            laptop: {laptop_summary}");
    println!("            phone:  {phone_summary}");

    if laptop_chunks == 0 {
        bail!("the laptop's first flush sent no chunks; there is nothing for the phone to match");
    }
    if phone_chunks == 0 {
        bail!(
            "the phone's flush sent ZERO chunks, so this act proved nothing: it has to upload \
             under its own chain for the name comparison to mean anything (it holds no dedup \
             entries of its own — the flush should have re-sent the history it received over \
             the wire)"
        );
    }

    // The whole claim as one count. The bucket started empty, so:
    // laptop_chunks chunk objects + the laptop's oplog and manifest + the
    // phone's oplog and manifest. The phone's chunks add NOTHING because
    // every one of them lands on a name the laptop already wrote.
    let after_phone = probe.keys().await?;
    let expected = laptop_chunks as usize + 4;
    if after_phone.len() != expected {
        bail!(
            "the bucket holds {} object(s); {expected} are expected ({laptop_chunks} chunks + \
             two device-keyed oplog/manifest pairs). The phone uploaded {phone_chunks} chunk(s) \
             and {} of them landed on names the laptop had not written, so the two devices are \
             deriving different names for the same content — the chain seeded with the \
             partition pointer did not reach this device (SYNC.md §1). Names: {:?}",
            after_phone.len(),
            after_phone.len().saturating_sub(expected),
            after_phone
        );
    }

    ok(
        &format!(
            "phone re-flushed {phone_chunks} chunk(s) of wire-received history and added ZERO \
             new chunk objects (bucket holds {}, = {laptop_chunks} shared chunks + two \
             device-keyed oplog/manifest pairs): both devices derived the SAME names, with no \
             sync opportunity between the flushes",
            after_phone.len()
        ),
        t,
    );

    // --- THE ACCOUNT PULL PATH (SYNC.md §2) -------------------------------
    //
    // The defect this closes: owner-tier pull used to be PICKUP-GATED on
    // both providers, and an account device grants a pickup only to
    // ITSELF. So a sibling pull — which is every pull the worker's
    // (partition × sibling) fan-out makes — could only ever answer "kp
    // missing (404): revoked or never granted". Nothing in this act has
    // called `store-grant` for the phone, deliberately: under the old
    // gating the pull below fails, and under the fork it must not need
    // a pickup at all.
    let t = Instant::now();
    let summary = p
        .call_bucket_pull(acc, partition.to_vec(), l_id.to_vec(), None)
        .await?
        .map_err(|e| {
            format_err!(
                "a sibling pull FAILED, and no pickup was ever granted to this device — which \
                 is the ordinary state of every account device (SYNC.md §2): {e}"
            )
        })?;
    println!("            phone pull: {summary}");
    // Naming the branch in the summary is what separates "the fork
    // worked" from "a K_p happened to be lying around".
    if !summary.contains("s3(account)") {
        bail!(
            "the pull did not take the ACCOUNT branch; it answered {summary:?}, so it either \
             found a pickup or fell through to the link tier"
        );
    }
    ok(
        &format!("a sibling pull succeeds with no pickup anywhere: {summary}"),
        t,
    );

    // A SIBLING THAT HAS NEVER FLUSHED IS ABSENCE, NOT FAILURE — the
    // state the boot-time fan-out hits for most (partition, sibling)
    // pairs, and the one that must never reach the scheduler's failure
    // counter or the visor's three-strikes announcement.
    let fresh = l
        .call_create_partition(acc)
        .await?
        .map_err(|e| format_err!("create-partition: {e}"))?;
    l.call_seal_partition(acc, fresh.clone())
        .await?
        .map_err(|e| format_err!("seal-partition: {e}"))?;
    let t = Instant::now();
    let summary = p
        .call_bucket_pull(acc, fresh, l_id.to_vec(), None)
        .await?
        .map_err(|e| {
            format_err!("a pull of a never-flushed partition ERRORED instead of reading empty: {e}")
        })?;
    if !summary.contains("chunks=0") {
        bail!("a never-flushed partition pulled {summary:?}, which is not an empty read");
    }
    ok(
        &format!("a sibling that has never flushed reads as absence, not error: {summary}"),
        t,
    );
    Ok(())
}

/// A code that reaches a second party has leaked, so the offer dies
/// rather than continuing under a claim the user cannot audit.
async fn act_second_claim(
    acc: &Accessor<Ctx>,
    adder: &Driver,
    stranger: &Driver,
    joiner: &Driver,
) -> Result<()> {
    let offer = joiner
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    adder
        .call_pair_add_start(acc, offer.code.clone())
        .await?
        .map_err(|e| format_err!("first claim: {e}"))?;
    wait_add(acc, adder, "first claim binds the session", |s| {
        matches!(s, PairAddState::SasReady(_) | PairAddState::Failed(_))
    })
    .await?;
    stranger
        .call_pair_add_start(acc, offer.code)
        .await?
        .map_err(|e| format_err!("second claim start: {e}"))?;
    let second = wait_add(acc, stranger, "second claim refused", |s| {
        matches!(s, PairAddState::Failed(_))
    })
    .await?;
    let PairAddState::Failed(why) = &second else {
        unreachable!()
    };
    if !why.contains("already claimed") {
        bail!("the second claim failed for the wrong reason: {why}");
    }
    println!("            second claim: {why}");
    let burned = wait_join(acc, joiner, "the offer is burned on the joiner", |s| {
        matches!(s, PairJoinState::Failed(_))
    })
    .await?;
    println!("            joiner: {}", describe_join(&burned));
    for d in [adder, stranger, joiner] {
        let _ = d.call_pair_abort(acc).await?;
    }
    Ok(())
}

/// "Same hardware, new individual": a revoked device does not come back
/// as itself. It pairs again as a fresh principal, and the old entry
/// stays in the list, marked revoked.
async fn act_revoke_and_repair(
    acc: &Accessor<Ctx>,
    l: &Driver,
    rejoin: &Driver,
    revoked: &[u8],
    group: &[u8],
    partition: &[u8],
) -> Result<()> {
    l.call_us_device_revoke(acc, revoked.to_vec())
        .await?
        .map_err(|e| format_err!("us-device-revoke: {e}"))?;
    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !devices.iter().any(|d| d.agent_id == revoked && d.revoked) {
        bail!("the revoked device is not marked revoked in us-devices-list");
    }
    println!("            phone revoked from the user group and marked in the devices list");

    let (_sas, group2, partition2) = pair(acc, l, rejoin, "alice phone (re-paired)", None).await?;
    if group2 != group {
        bail!("the re-pair enrolled into a different account");
    }
    // One lineage: enrollment no longer regenerates the doc, so ENROLL
    // carries the ORIGINAL partition id (PAIRING.md §2, §4b).
    if partition2 != partition {
        bail!("enrollment handed out a different partition than the account's own");
    }
    let devices = l.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    let fresh = devices
        .iter()
        .find(|d| d.name == "alice phone (re-paired)")
        .ok_or_else(|| format_err!("the re-paired device is missing from the list"))?;
    if fresh.agent_id == revoked {
        bail!("the re-paired device reused the revoked individual");
    }
    if fresh.revoked {
        bail!("the re-paired device came back revoked");
    }
    println!("            re-paired as a NEW individual; the revoked entry is still recorded");
    Ok(())
}

/// Act 3: a joiner refuses a commitment that does not open.
///
/// The adder in this store runs with the verification hook set, so it
/// reveals a nonce it never committed to. That is exactly the move a
/// party grinding the 20-bit SAS would need, and the joiner must end the
/// ceremony rather than display a string.
pub(crate) async fn commitment_act(
    acc: &Accessor<Ctx>,
    adder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let a: &Driver = adder.polyvisor_engine_driver();
    let j: &Driver = joiner.polyvisor_engine_driver();
    a.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    j.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    a.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    j.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    a.call_user_create(
        acc,
        UsProfile {
            display_name: "Alice".into(),
            hue: 3,
            icon: None,
        },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    let offer = j
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    a.call_pair_add_start(acc, offer.code)
        .await?
        .map_err(|e| format_err!("pair-add-start: {e}"))?;

    let state = wait_join(acc, j, "joiner refuses the bad commitment", |s| {
        matches!(s, PairJoinState::Failed(_) | PairJoinState::Claimed(_))
    })
    .await?;
    match state {
        PairJoinState::Failed(why) => {
            if !why.contains("commitment") {
                bail!("the joiner aborted for the wrong reason: {why}");
            }
            println!("            joiner: {why}");
        }
        other => bail!(
            "COMMITMENT FAILURE: the joiner accepted a nonce that does not open the commitment ({})",
            describe_join(&other)
        ),
    }
    println!("\nPAIRING ACT (commitment violation) PASSED");
    Ok(())
}

/// Act 4: an offer expires.
///
/// The store running this act carries a shortened TTL so the act is
/// seconds rather than two minutes; the expiry PATH is the same one the
/// contract's 120 s uses.
pub(crate) async fn expiry_act(
    acc: &Accessor<Ctx>,
    joiner: crate::bindings::Engine,
    relay: String,
    ttl_ms: u64,
) -> Result<()> {
    let j: &Driver = joiner.polyvisor_engine_driver();
    j.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    j.call_iroh_bind(acc, relay).await?.map_err(|e| format_err!("{e}"))?;
    let offer = j
        .call_pair_join_start(acc)
        .await?
        .map_err(|e| format_err!("pair-join-start: {e}"))?;
    let state = j.call_pair_join_status(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !matches!(state, PairJoinState::Waiting) {
        bail!("a fresh offer should be waiting, got {}", describe_join(&state));
    }
    println!("            offer minted, expires-ms={}", offer.expires_ms);
    tokio::time::sleep(Duration::from_millis(ttl_ms + 500)).await;
    let state = j.call_pair_join_status(acc).await?.map_err(|e| format_err!("{e}"))?;
    if !matches!(state, PairJoinState::Expired) {
        bail!(
            "an unclaimed offer past its expiry must report expired, got {}",
            describe_join(&state)
        );
    }
    println!("            unclaimed offer expired; a new offer mints a new token");
    println!("\nPAIRING ACT (offer expiry) PASSED");
    Ok(())
}

/// Post-seal add on the account's document: the boundary act.
///
/// Enrollment adds a device to the group long after the doc was sealed,
/// and this act pins what that device can and cannot reach on it. Since
/// regeneration retired there is only one lineage, so this is simply the
/// normal flow examined closely — which is the point: the boundary is a
/// property of every enrollment, not of a special configuration.
///
/// Two assertions, and the boundary between them is the point:
///
/// - **post-rotation content is readable** — the joiner opens the
///   envelope of a chunk the founder wrote after the add and the forced
///   rotation. Asserted at the keyhive/envelope level, because that is
///   where the access question lives.
/// - **pre-join content stays dark, by design** — BeeKEM adds are not
///   retroactive, and without the Envelope content format there are no
///   causal keys to walk back through. Asserted as EXPECTED-unreadable so
///   the act documents the boundary rather than leaving it folded into a
///   pass.
pub(crate) async fn post_seal_add_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let l: &Driver = founder.polyvisor_engine_driver();
    let p: &Driver = joiner.polyvisor_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("founder init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("joiner init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    p.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    // Pre-join content: written before the joiner exists at all.
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://before.example/".into(),
            petname: "Before".into(),
            icon: "🐦".into(),
            nickname: None,
            created_at: 1_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("pre-join mark: {e}"))?;

    // Enrollment: same doc, joiner added long after the seal.
    let (_sas, _group, partition) = pair(acc, l, p, "late device", None).await?;
    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (p, "joiner", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    // Baseline the joiner's envelope counter BEFORE the founder's
    // post-join write, so the assertion is "it opened THAT chunk" rather
    // than "it opened something at some point".
    let mut before = 0u32;
    for _ in 0..200 {
        let _ = p.call_us_marks_list(acc).await?;
        before = parse_stat(&p.call_stats(acc).await?, "us-decrypted");
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    println!("            joiner envelopes opened before the post-join write: {before}");

    // Post-join content, written after the add and the forced rotation
    // the enrollment path performs.
    l.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://after.example/".into(),
            petname: "After".into(),
            icon: "🦋".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("post-join mark: {e}"))?;

    // Assertion 1: the joiner opens envelopes written after it joined.
    let t = Instant::now();
    let mut opened = 0u32;
    let mut last = String::new();
    for _ in 0..POLLS {
        // Any us-* read drives the apply pipeline.
        let _ = p.call_us_marks_list(acc).await?;
        last = p.call_stats(acc).await?;
        opened = parse_stat(&last, "us-decrypted");
        if opened > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if opened <= before {
        bail!(
            "the late joiner never opened the post-rotation chunk on the \
             original doc (envelopes opened stayed at {before}) — the \
             event-delivery gap is back. joiner stats: {last}"
        );
    }
    ok(
        &format!(
            "late joiner opened the post-rotation chunk ({before} -> {opened} envelopes)"
        ),
        t,
    );
    println!("            joiner: {last}");

    // Set-level attribution (spikes/keyhive-addwedge): what the joiner
    // HOLDS versus what the founder would offer it, computed on the
    // founder at this instant. The earlier investigation compared op
    // COUNTS and found them equal; counts are not sets, and this is that
    // upgrade. Sampled AFTER the readability assertion above, so it can
    // never be the thing that makes the act pass.
    if std::env::var("PM_EVENT_DIFF").is_ok() {
        let authoritative = l
            .call_kh_export_card(acc, p_bytes.clone())
            .await?
            .map_err(|e| format_err!("founder export card: {e}"))?;
        // Reported by the guest as kinds and counts (never contents).
        p.call_kh_ingest_card(acc, authoritative)
            .await?
            .map_err(|e| format_err!("joiner ingest: {e}"))?;
    }

    // Assertion 2: the boundary has MOVED, and both halves are asserted.
    //
    // Pre-join chunks are sealed under an epoch this device will never
    // hold, so a direct decrypt of them must still fail — and they must
    // nevertheless materialize, because a readable descendant carries
    // their keys (PAIRING.md §4b). Materialization alone would not
    // distinguish the walk from a lucky epoch; the walk counter is what
    // makes "recovered where direct decrypt failed" observable, and the
    // engine increments it only for chunks whose direct decrypt failed.
    //
    // The pre-join ancestry here is the creation change plus the "Before"
    // mark: at least two chunks must come back through the walk.
    const PRE_JOIN_CHUNKS: u32 = 2;
    let t = Instant::now();
    let mut marks = Vec::new();
    let mut walked = 0u32;
    let mut last = String::new();
    for _ in 0..POLLS {
        marks = p.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
        last = p.call_stats(acc).await?;
        walked = parse_stat(&last, "us-walked");
        if marks.iter().any(|m| m.petname == "Before") && walked >= PRE_JOIN_CHUNKS {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
    if !marks.iter().any(|m| m.petname == "Before") {
        bail!(
            "pre-join content did not materialize through the causal walk \
             (joiner sees {} mark(s); stats: {last})",
            marks.len()
        );
    }
    if walked < PRE_JOIN_CHUNKS {
        bail!(
            "pre-join content materialized WITHOUT the causal walk \
             (us-walked={walked}, expected at least {PRE_JOIN_CHUNKS}) — the act \
             would be passing for the wrong reason. stats: {last}"
        );
    }
    ok(
        &format!("pre-join content recovered by causal walk ({walked} chunk(s)) and materialized"),
        t,
    );
    println!("            joiner: {last}");

    println!("\nPAIRING ACT (post-seal add, original doc) PASSED");
    Ok(())
}

/// Pull one `name=<u32>` counter out of the driver's stats line.
fn parse_stat(stats: &str, name: &str) -> u32 {
    stats
        .split([';', ' '])
        .find_map(|field| field.strip_prefix(&format!("{name}=")))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

/// A late joiner materializes the account's FULL pre-join history.
///
/// This is the property the Envelope format buys (PAIRING.md §4b): the
/// joiner's epochs cannot open pre-join chunks, but the anchor chunk
/// written at enrollment carries its parents' keys, and each recovered
/// chunk carries its own parents' — so the whole ancestry unwinds from
/// one readable descendant.
///
/// `seed` varies arrival order across runs: how much history exists
/// before the join, whether the founder writes again before the joiner
/// first pulls, and whether the joiner is subscribed before or after that
/// write. The previous implementation of this area was order-dependent,
/// so order is the thing to vary.
pub(crate) async fn full_history_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
    seed: u32,
) -> Result<()> {
    let l: &Driver = founder.polyvisor_engine_driver();
    let p: &Driver = joiner.polyvisor_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("founder init: {e}"))?;
    let p_id = p.call_init(acc, false).await?.map_err(|e| format_err!("joiner init: {e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let p_bytes = hex::decode(&p_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    p.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;

    // 1..=3 pre-join marks, plus a profile edit, so the ancestry the walk
    // must cover is several chunks deep and varies by seed.
    let depth = 1 + (seed % 3);
    for i in 0..depth {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: format!("https://pre-{i}.example/"),
                petname: format!("Pre{i}"),
                icon: format!("{i}"),
                nickname: None,
                created_at: 1_000 + i as u64,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("pre-join mark {i}: {e}"))?;
    }
    l.call_us_profile_set(
        acc,
        UsProfile { display_name: "Alice Renamed".into(), hue: 4, icon: None },
    )
    .await?
    .map_err(|e| format_err!("pre-join profile edit: {e}"))?;

    let (_sas, _group, partition) = pair(acc, l, p, "late device", None).await?;

    // Order variation: does the founder write again before the joiner is
    // wired, or after?
    let write_before_wire = seed.is_multiple_of(2);
    if write_before_wire {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: "https://post.example/".into(),
                petname: "Post".into(),
                icon: "📮".into(),
                nickname: None,
                created_at: 5_000,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("post-join mark: {e}"))?;
    }

    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (p, "joiner", &p_bytes),
        &partition,
        &relay,
    )
    .await?;

    if !write_before_wire {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: "https://post.example/".into(),
                petname: "Post".into(),
                icon: "📮".into(),
                nickname: None,
                created_at: 5_000,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("post-join mark: {e}"))?;
    }

    // Everything the founder ever wrote must materialize on the joiner:
    // the pre-join marks, the pre-join profile EDIT (not just the initial
    // value), and the post-join mark.
    let want_all = move |m: &[UsMark]| {
        (0..depth).all(|i| m.iter().any(|x| x.petname == format!("Pre{i}")))
            && m.iter().any(|x| x.petname == "Post")
    };
    let marks = wait_marks(
        acc,
        p,
        &format!("seed {seed}: joiner materialized all {} pre-join mark(s) + the post-join one", depth),
        want_all,
    )
    .await?;
    let profile = p.call_us_profile_get(acc).await?.map_err(|e| format_err!("{e}"))?;
    if profile.display_name != "Alice Renamed" || profile.hue != 4 {
        bail!(
            "seed {seed}: the joiner did not materialize the pre-join profile EDIT \
             (sees {:?}/{})",
            profile.display_name,
            profile.hue
        );
    }
    println!(
        "            seed {seed}: {} marks, profile '{}' — full history via walk",
        marks.len(),
        profile.display_name
    );
    Ok(())
}

/// Concurrent writes from a device that did not see another device's
/// enrollment survive the merge — including a DELETION.
///
/// The value-copy handoff this replaces could resurrect a forgotten mark
/// (the copy was taken from a state that still contained it) and could
/// lose a rename (the copy carried the old name). With one document
/// lineage both are ordinary CRDT merges, and this act is the proof.
///
/// Driver limitation, stated exactly rather than overclaimed: there is no
/// disconnect verb, so this act cannot force a partition. What the
/// ordering DOES guarantee, and what is asserted below, is one direction:
/// the second device authors its three writes before the enrollment
/// writes exist at all, so it cannot have seen them. The other direction
/// — that the founder had not yet received the second device's writes
/// when it authored the enrollment entry — is NOT guaranteed here, since
/// a fast sync may deliver them first; it is reported, not asserted.
/// Either way the merge properties under test (a deletion that must not
/// resurrect, a rename that must not be lost) are exercised.
pub(crate) async fn partitioned_writer_act(
    acc: &Accessor<Ctx>,
    founder: crate::bindings::Engine,
    second: crate::bindings::Engine,
    joiner: crate::bindings::Engine,
    relay: String,
) -> Result<()> {
    let l: &Driver = founder.polyvisor_engine_driver();
    let b: &Driver = second.polyvisor_engine_driver();
    let c: &Driver = joiner.polyvisor_engine_driver();

    let l_id = l.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    let b_id = b.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    c.call_init(acc, false).await?.map_err(|e| format_err!("{e}"))?;
    let l_bytes = hex::decode(&l_id)?;
    let b_bytes = hex::decode(&b_id)?;
    let l_ep = l.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    b.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;
    c.call_iroh_bind(acc, relay.clone()).await?.map_err(|e| format_err!("{e}"))?;

    l.call_user_create(
        acc,
        UsProfile { display_name: "Alice".into(), hue: 3, icon: None },
    )
    .await?
    .map_err(|e| format_err!("user-create: {e}"))?;
    for (prov, name, icon, at) in [
        ("https://keep.example/", "Keep", "1", 1_000u64),
        ("https://rename.example/", "OldName", "2", 1_100),
        ("https://forget.example/", "Doomed", "6", 1_200),
    ] {
        l.call_us_mark_put(
            acc,
            UsMark {
                provenance: prov.into(),
                petname: name.into(),
                icon: icon.into(),
                nickname: None,
                created_at: at,
                needs_reconfirm: false,
            },
        )
        .await?
        .map_err(|e| format_err!("seed mark {name}: {e}"))?;
    }

    // The second device joins and catches up.
    let (_s, _g, partition) = pair(acc, l, b, "second device", None).await?;
    wire_us(
        acc,
        (l, "founder", &l_bytes, l_ep.as_str()),
        (b, "second", &b_bytes),
        &partition,
        &relay,
    )
    .await?;
    wait_marks(acc, b, "second device caught up", |m| m.len() == 3).await?;

    // Concurrency window: the second device makes its three writes from
    // its own frontier while the founder enrols a third device.
    b.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://added.example/".into(),
            petname: "AddedOffline".into(),
            icon: "9".into(),
            nickname: None,
            created_at: 2_000,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("offline add: {e}"))?;
    b.call_us_mark_put(
        acc,
        UsMark {
            provenance: "https://rename.example/".into(),
            petname: "NewName".into(),
            icon: "2".into(),
            nickname: None,
            created_at: 1_100,
            needs_reconfirm: false,
        },
    )
    .await?
    .map_err(|e| format_err!("offline rename: {e}"))?;
    b.call_us_mark_forget(acc, "https://forget.example/".into())
        .await?
        .map_err(|e| format_err!("offline forget: {e}"))?;

    // The guaranteed direction: the second device wrote before the third
    // device existed, so its writes were authored against a frontier that
    // cannot contain the enrollment.
    let b_devices = b.call_us_devices_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    if b_devices.iter().any(|d| d.name == "third device") {
        bail!("ordering violated: the second device saw the enrollment before authoring");
    }
    // The other direction, reported rather than asserted (see the doc
    // comment): had the founder already merged the second device's work?
    let l_before = l.call_us_marks_list(acc).await?.map_err(|e| format_err!("{e}"))?;
    let founder_had_merged = l_before.iter().any(|m| m.petname == "AddedOffline");
    println!(
        "            at enrollment time the founder had{} already merged the second device's writes",
        if founder_had_merged { "" } else { " NOT" }
    );

    let (_s2, _g2, partition2) = pair(acc, l, c, "third device", None).await?;
    if partition2 != partition {
        bail!("the second enrollment moved the partition");
    }

    // Heal, and assert all three survive on BOTH the founder and the
    // device that made them.
    let converged = |m: &[UsMark]| {
        m.iter().any(|x| x.petname == "AddedOffline")
            && m.iter().any(|x| x.petname == "NewName")
            && !m.iter().any(|x| x.provenance == "https://forget.example/")
            && m.iter().any(|x| x.petname == "Keep")
    };
    let l_marks = wait_marks(acc, l, "founder converged on the concurrent writes", converged).await?;
    let b_marks = wait_marks(acc, b, "second device converged", converged).await?;
    if !same_marks(&l_marks, &b_marks) {
        bail!("replicas diverged:\n  founder {l_marks:?}\n  second  {b_marks:?}");
    }
    if l_marks.iter().any(|m| m.petname == "OldName") {
        bail!("the rename was lost: the old name is still present");
    }
    println!(
        "            add survived, rename survived, forget did NOT resurrect ({} marks)",
        l_marks.len()
    );
    println!("\nPAIRING ACT (partitioned writer) PASSED");
    Ok(())
}
