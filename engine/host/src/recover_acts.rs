//! The recovery acts (#11; runtime/RECOVERY.md's T-A gate).
//!
//! "Losing every device does not lose the account", made executable.
//! Every claim the record makes about the recovery kit is asserted here
//! against a REAL MinIO bucket and a REAL keyhive delegation graph:
//!
//!  1. The ceremony mints a member DEVICE — it shows up in the account's
//!     device directory and in the kit registry, and its bundle is an
//!     object in the bucket at an opaque name.
//!  2. A post-kit REVOCATION EPOCH is crossed before the restore. This
//!     is the CGKA catch-up claim, and it is the whole reason the record
//!     dares to call the dormant leaf non-stale: the kit's leaf never
//!     self-rotates, so every later epoch reaches it through CGKA ops in
//!     the flushed oplogs. An act that restored across no epoch boundary
//!     would assert nothing about that.
//!  3. A FRESH ENGINE with no live peer anywhere restores from phrase +
//!     credentials alone and holds the account's content INCLUDING the
//!     writes that happened after the kit was minted.
//!  4. The restored device AUTHORS and the original sees it: a real
//!     member, not a read-only replica.
//!  5. CONSUME removes the artifacts, and the removal is observed from
//!     the bucket and from the other device's copy of the account.
//!  6. DOUBLE RESTORE refuses — by the missing bundle for a bucket kit,
//!     by the missing K_p for a file kit. Both are asserted as error
//!     CLASSES, never as exact strings: the wording is the engine's to
//!     improve, the class is the contract.
//!  7. Wrong passphrase and wrong phrase are clean refusals.
//!
//! # No relay, no peer, deliberately
//!
//! Nothing in this battery dials anything. That is the point of the
//! feature: the bucket is the only channel, and a restore that quietly
//! depended on a live sibling would pass an act that had one.
//!
//! # Secret material never appears in an assertion
//!
//! Object names are opaque hex derived from name-keys; the evidence is
//! set membership and counts over them. The phrase crosses this file
//! because the host is standing in for the user's eyes and fingers, and
//! it is compared against the wordlist and then used, never printed.

use std::time::Instant;

use wasmtime::component::Accessor;
use wasmtime::{bail, format_err, Result};

use crate::bindings::exports::polyvisor::engine::driver::{
    Guest as Driver, S3Config, StoreConfig, UsProfile,
};
use crate::bindings::exports::polyvisor::tasks::tasks::Guest as Tasks;
use crate::resume_acts::S3Probe;
use crate::Ctx;

/// The EFF short wordlist, embedded HOST-SIDE TOO.
///
/// Duplication with the guest's `wordlist.rs`, and it is the deliberate
/// kind: an act that took the word set from the same array the generator
/// draws from could not tell a correct phrase from a phrase drawn out of
/// a corrupted list. The two copies come from the same upstream file
/// (<https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>,
/// CC-BY-3.0, EFF), and a drift between them fails act 1 — which is the
/// behaviour wanted.
const WORDLIST: &str = include_str!("eff_short_wordlist.txt");

/// A DECOY PHRASE for the wrong-phrase act: ten real wordlist words that
/// are not the generated ones. Obviously synthetic (the first ten words
/// of the list, in order) so nobody mistakes it for captured material.
const DECOY_PHRASE: &str = "acid acorn acre acts afar affix aged agile aging agony";

/// The file kit's passphrase in these acts. Obviously synthetic and
/// labelled as such: nothing here is a credential anybody holds.
const FILE_PASSPHRASE: &str = "test-file-kit-passphrase-0001";
const WRONG_PASSPHRASE: &str = "test-file-kit-passphrase-9999";

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

/// The recovery bundle's object-name prefix (guest `recovery.rs`). The
/// only thing about a bundle object the host can recognise — its name is
/// otherwise a hash of a phrase-derived key.
const NAME_PREFIX: &str = "recovery/";

fn bundle_objects(keys: &[String]) -> Vec<&String> {
    keys.iter().filter(|k| k.starts_with(NAME_PREFIX)).collect()
}

/// Titles of a todo snapshot, sorted — the comparable shape.
fn titles(items: &[crate::TodoItem]) -> Vec<String> {
    let mut out: Vec<String> = items.iter().map(|i| i.title.clone()).collect();
    out.sort();
    out
}

/// Assert an error is of a CLASS, by a substring the engine's refusal is
/// built around. Never the whole string: the wording is free to improve.
fn refused(what: &str, e: &str, class: &str) -> Result<()> {
    if !e.contains(class) {
        bail!("{what}: refused, but not as the {class:?} class: {e}");
    }
    println!("[  refused] {what}: {e}");
    Ok(())
}

/// The six FRESH BROWSERS this battery needs.
///
/// Each is a distinct component instance — separate linear memory, empty
/// guest state — which is what makes "a fresh browser with no live peer
/// anywhere" an honest description of them. Grouped in a record because
/// six of anything in a parameter list stops being readable, not because
/// they share anything: they never meet.
pub(crate) struct Shells {
    /// Restores the bucket kit and becomes a real member.
    pub(crate) restored: crate::bindings::Engine,
    /// Tries the SAME phrase again after the kit is consumed.
    pub(crate) double: crate::bindings::Engine,
    /// Tries a phrase that was never a kit's.
    pub(crate) wrong_phrase: crate::bindings::Engine,
    /// Tries the file kit with the wrong passphrase.
    pub(crate) file_wrong_pass: crate::bindings::Engine,
    /// Restores the file kit.
    pub(crate) file_restored: crate::bindings::Engine,
    /// Tries the same file bytes again after that kit is consumed.
    pub(crate) file_double: crate::bindings::Engine,
}

/// The engine's whole recovery surface, act by act.
#[allow(clippy::too_many_lines)]
pub(crate) async fn recover_act(
    acc: &Accessor<Ctx>,
    account: crate::bindings::Engine,
    shells: Shells,
    probe: &S3Probe,
) -> Result<()> {
    let Shells {
        restored,
        double,
        wrong_phrase,
        file_wrong_pass,
        file_restored,
        file_double,
    } = shells;
    let a: &Driver = account.polyvisor_engine_driver();
    let at: &Tasks = account.polyvisor_tasks_tasks();

    let store_cfg = || {
        StoreConfig::S3(S3Config {
            endpoint: probe.endpoint.clone(),
            bucket: probe.bucket.clone(),
            access_key: probe.access.clone(),
        })
    };

    // === act 1: the ceremony ==============================================

    let a_id_hex = step!("account.init", a.call_init(acc, false));
    let a_id = hex::decode(&a_id_hex).map_err(|e| format_err!("{e}"))?;
    step!("account.init-store(s3)", a.call_init_store(acc, store_cfg()));
    step!("account.ensure-bucket", a.call_ensure_bucket(acc));
    let group = step!(
        "account.user-create",
        a.call_user_create(
            acc,
            UsProfile {
                display_name: "Recovered Rose".to_string(),
                hue: 300,
                icon: None,
            },
        )
    );
    let tasks = step!("account.create-partition", a.call_create_partition(acc));
    // DELEGATED TO THE USER GROUP, before the seal. This is the account
    // shape every consumer builds (the group is what pairing and the kit
    // ceremony both add devices to), and the ordering is the one
    // engine.wit pins: BeeKEM adds are not retroactive, so the doc's
    // first epoch must already cover its intended readership. A
    // partition delegated to the founding DEVICE instead would be
    // unreadable by the restored kit, which is the whole point of
    // asserting content equality here.
    step!(
        "account.kh-add-member(tasks, user group, edit)",
        a.call_kh_add_member(acc, tasks.clone(), group.clone(), "edit".to_string())
    );
    step!(
        "account.seal-partition",
        a.call_seal_partition(acc, tasks.clone())
    );
    step!(
        "account.us-partition-put(tasks)",
        a.call_us_partition_put(acc, "tasks".to_string(), tasks.clone())
    );
    for title in ["buy milk", "write the recovery act"] {
        step!(
            format!("account.tasks.add({title})"),
            at.call_add(acc, title.to_string())
        );
    }
    step!(
        "account.bucket-flush(us)",
        a.call_bucket_flush(acc, Vec::new())
    );
    step!(
        "account.bucket-flush(tasks)",
        a.call_bucket_flush(acc, tasks.clone())
    );

    let phrase = step!(
        "account.recovery-kit-create-bucket",
        a.call_recovery_kit_create_bucket(acc, "the recovery kit".to_string())
    );

    // The phrase's SHAPE is the contract (RECOVERY.md, "Derivation,
    // pinned"): 10 words, every one of them from the EFF short wordlist,
    // normalized (single spaces, lowercase) so that what is displayed is
    // exactly what re-derives the name.
    let words: Vec<&str> = phrase.split(' ').collect();
    if words.len() != 10 {
        bail!("recovery phrase has {} words, expected 10", words.len());
    }
    let list: std::collections::HashSet<&str> =
        WORDLIST.lines().map(str::trim).filter(|w| !w.is_empty()).collect();
    if list.len() != 1296 {
        bail!("the embedded wordlist has {} entries, expected 1296", list.len());
    }
    for w in &words {
        if !list.contains(w) {
            bail!("recovery phrase contains {w:?}, which is not in the EFF short wordlist");
        }
    }
    if phrase != phrase.trim().to_lowercase() {
        bail!("recovery phrase is not normalized (trim + lowercase)");
    }
    ok("act 1: phrase is 10 normalized words, all from the EFF short wordlist", Instant::now());

    let keys = probe.keys().await?;
    let bundles = bundle_objects(&keys);
    if bundles.len() != 1 {
        bail!(
            "expected exactly one recovery bundle object in the bucket, found {}",
            bundles.len()
        );
    }
    ok("act 1: the sealed bundle is an object in the bucket", Instant::now());

    let devices = step!("account.us-devices-list", a.call_us_devices_list(acc));
    if devices.len() != 2 {
        bail!(
            "expected the founding device + the kit device in the directory, got {}",
            devices.len()
        );
    }
    let kit_id = devices
        .iter()
        .find(|d| d.agent_id != a_id)
        .ok_or_else(|| format_err!("the kit device is not in the account's directory"))?
        .agent_id
        .clone();
    let kits = step!("account.recovery-kits", a.call_recovery_kits(acc));
    if kits.len() != 1 || kits[0].agent_id != kit_id || kits[0].kind != "bucket" {
        bail!("recovery-kits does not name exactly the bucket kit just minted: {kits:?}");
    }
    ok("act 1: the kit is a DEVICE in the directory and a row in the registry", Instant::now());

    // === act 2: a post-kit revocation epoch, and revoke-a-live-kit =========
    //
    // Two claims in one beat. A SECOND bucket kit is minted and then
    // REVOKED, which (a) forces a fresh epoch on every doc the user group
    // reaches plus a name-key rotation on the us-doc — the boundary the
    // first kit must later catch up across — and (b) is itself the
    // revoke-a-live-kit assertion: bundle object gone, kit device flagged
    // revoked, registry row gone.

    step!(
        "account.tasks.add(after the kit was minted)",
        at.call_add(acc, "after the kit was minted".to_string())
    );

    let _second_kit_phrase = step!(
        "account.recovery-kit-create-bucket(second kit)",
        a.call_recovery_kit_create_bucket(acc, "the doomed kit".to_string())
    );
    let devices = step!("account.us-devices-list", a.call_us_devices_list(acc));
    let doomed = devices
        .iter()
        .find(|d| d.agent_id != a_id && d.agent_id != kit_id)
        .ok_or_else(|| format_err!("the second kit device is not in the directory"))?
        .agent_id
        .clone();
    let keys = probe.keys().await?;
    if bundle_objects(&keys).len() != 2 {
        bail!("expected two bundle objects with two live kits");
    }

    let note = step!(
        "account.recovery-kit-revoke(second kit)",
        a.call_recovery_kit_revoke(acc, doomed.clone())
    );
    if note.is_empty() {
        bail!("recovery-kit-revoke returned no guarantee note");
    }
    let keys = probe.keys().await?;
    let bundles = bundle_objects(&keys);
    if bundles.len() != 1 {
        bail!(
            "revoke should have deleted exactly the revoked kit's bundle; {} remain",
            bundles.len()
        );
    }
    let devices = step!("account.us-devices-list", a.call_us_devices_list(acc));
    if !devices.iter().any(|d| d.agent_id == doomed && d.revoked) {
        bail!("the revoked kit device is not flagged revoked in the directory");
    }
    let kits = step!("account.recovery-kits", a.call_recovery_kits(acc));
    if kits.len() != 1 || kits[0].agent_id != kit_id {
        bail!("the revoked kit is still in the registry: {kits:?}");
    }
    ok("act 2: revoking a live kit removed bundle + registry row and flagged the device", Instant::now());

    step!(
        "account.bucket-flush(us) [post-rotation]",
        a.call_bucket_flush(acc, Vec::new())
    );
    step!(
        "account.bucket-flush(tasks) [post-rotation]",
        a.call_bucket_flush(acc, tasks.clone())
    );
    let want_titles = titles(
        &step!("account.tasks.items", at.call_items(acc)).items,
    );
    if want_titles.len() != 3 {
        bail!("expected 3 todos on the account device, got {want_titles:?}");
    }
    ok("act 2: a revocation epoch was crossed AFTER the kit was minted, and flushed", Instant::now());

    // === act 3: a wrong phrase finds nothing ==============================

    let w: &Driver = wrong_phrase.polyvisor_engine_driver();
    match w
        .call_recovery_restore_bucket(
            acc,
            store_cfg(),
            DECOY_PHRASE.to_string(),
            "never".to_string(),
        )
        .await?
    {
        Ok(id) => bail!("a wrong phrase restored an account: {id}"),
        // The derived name simply misses. The refusal cannot distinguish
        // "wrong phrase" from "already consumed", and that is the design:
        // absence is the only fact either case establishes.
        Err(e) => refused("act 3: wrong phrase", &e, "no recovery kit at this name")?,
    }

    // === act 4: the restore ===============================================

    let r: &Driver = restored.polyvisor_engine_driver();
    let rt: &Tasks = restored.polyvisor_tasks_tasks();

    let restored_id_hex = step!(
        "restored.recovery-restore-bucket",
        r.call_recovery_restore_bucket(
            acc,
            store_cfg(),
            phrase.clone(),
            "the restored laptop".to_string(),
        )
    );
    if restored_id_hex != hex::encode(&kit_id) {
        bail!(
            "restore booted the wrong identity: {restored_id_hex} != {}",
            hex::encode(&kit_id)
        );
    }
    ok("act 4: the restored instance IS the kit device", Instant::now());

    // The account state arrived through ONE K_p pickup and the bucket.
    let profile = step!("restored.us-profile-get", r.call_us_profile_get(acc));
    if profile.display_name != "Recovered Rose" || profile.hue != 300 {
        bail!("the restored profile is not the account's: {profile:?}");
    }
    let devices = step!("restored.us-devices-list", r.call_us_devices_list(acc));
    if devices.len() != 3 {
        bail!("the restored device sees {} devices, expected 3", devices.len());
    }
    if !devices
        .iter()
        .any(|d| d.agent_id == kit_id && d.name == "the restored laptop")
    {
        bail!("the restore did not rename its own devices entry: {devices:?}");
    }
    ok("act 4: profile + device directory match the account (and the kit was renamed)", Instant::now());

    // THE WORKER'S FAN-OUT, driven here: the pointer map times the device
    // directory. Deliberately not in the guest (RECOVERY.md: the content
    // fan-out is the worker's existing pull machinery).
    let pointers = step!("restored.us-partitions", r.call_us_partitions(acc));
    if !pointers.iter().any(|p| p.name == "tasks" && p.id == tasks) {
        bail!("the restored device did not learn the account's tasks pointer: {pointers:?}");
    }
    for p in &pointers {
        step!(
            format!("restored.adopt-partition({})", p.name),
            r.call_adopt_partition(acc, p.id.clone())
        );
        let summary = step!(
            format!("restored.bucket-pull({}, account)", p.name),
            r.call_bucket_pull(acc, p.id.clone(), a_id.clone(), None)
        );
        println!("           {}: {summary}", p.name);
    }

    let got = titles(&step!("restored.tasks.items", rt.call_items(acc)).items);
    if got != want_titles {
        bail!("restored content differs from the account's:\n  want {want_titles:?}\n  got  {got:?}");
    }
    if !got.iter().any(|t| t == "after the kit was minted") {
        bail!("the restore did not catch up across the post-kit epoch: {got:?}");
    }
    ok("act 4: content equal to the account's, INCLUDING the post-kit write", Instant::now());

    // === act 5: the restored device is a real member ======================

    step!(
        "restored.tasks.add(from the restored device)",
        rt.call_add(acc, "from the restored device".to_string())
    );
    step!(
        "restored.bucket-flush(tasks)",
        r.call_bucket_flush(acc, tasks.clone())
    );
    step!(
        "account.bucket-pull(tasks, restored)",
        a.call_bucket_pull(acc, tasks.clone(), kit_id.clone(), None)
    );
    let seen = titles(&step!("account.tasks.items", at.call_items(acc)).items);
    if !seen.iter().any(|t| t == "from the restored device") {
        bail!("the account never saw the restored device's write: {seen:?}");
    }
    ok("act 5: the restored device authored and the account read it", Instant::now());

    // === act 6: consume ===================================================

    let before = probe.keys().await?;
    step!("restored.recovery-consume", r.call_recovery_consume(acc));
    let after = probe.keys().await?;
    if !bundle_objects(&after).is_empty() {
        bail!("consume left a bundle object in the bucket: {:?}", bundle_objects(&after));
    }
    // The K_p is an opaque hash like every other object, so it is
    // identified by DIFFERENCE rather than by name: exactly two objects
    // went away (the bundle and the K_p) and nothing else did.
    let gone: Vec<&String> = before.iter().filter(|k| !after.contains(k)).collect();
    if gone.len() != 2 {
        bail!("consume removed {} objects, expected exactly 2 (bundle + K_p): {gone:?}", gone.len());
    }
    ok("act 6: consume removed the bundle and the K_p, and nothing else", Instant::now());

    // Seen from the RESTORED device itself: its own registry read must
    // agree with the consume it just performed (found disagreeing on the
    // solo page — this pins where the disagreement lives).
    let own = step!("restored.recovery-kits (own view)", r.call_recovery_kits(acc));
    if !own.is_empty() {
        bail!("the restored device still lists the kit it consumed: {own:?}");
    }
    ok("act 6: the restored device's own registry agrees with its consume", Instant::now());

    // IDEMPOTENT: the retry the embedder's backoff loop will make.
    step!(
        "restored.recovery-consume (retry: absence is success)",
        r.call_recovery_consume(acc)
    );

    // Observed from the OTHER device, through the account: the registry
    // row is gone everywhere, not just locally.
    step!(
        "account.bucket-pull(us, restored)",
        a.call_bucket_pull(acc, Vec::new(), kit_id.clone(), None)
    );
    let kits = step!("account.recovery-kits", a.call_recovery_kits(acc));
    if !kits.is_empty() {
        bail!("the consumed kit is still in the account's registry: {kits:?}");
    }
    ok("act 6: the account's kit registry is empty, seen from the other device", Instant::now());

    // === act 7: double restore refuses ====================================

    let dbl: &Driver = double.polyvisor_engine_driver();
    match dbl
        .call_recovery_restore_bucket(
            acc,
            store_cfg(),
            phrase.clone(),
            "the fork that must not be".to_string(),
        )
        .await?
    {
        Ok(id) => bail!("a consumed bucket kit restored a SECOND instance of {id} — an identity fork"),
        Err(e) => refused("act 7: double restore (bucket)", &e, "no recovery kit at this name")?,
    }

    // === act 8: the file kit ==============================================

    let bundle = step!(
        "account.recovery-kit-create-file",
        a.call_recovery_kit_create_file(
            acc,
            "the downloaded kit".to_string(),
            FILE_PASSPHRASE.to_string(),
        )
    );
    if bundle.is_empty() {
        bail!("the file kit returned no bytes");
    }
    // A file kit stores NO object: its single-use enforcement is the K_p.
    let keys = probe.keys().await?;
    if !bundle_objects(&keys).is_empty() {
        bail!("a file kit wrote a bundle object into the bucket");
    }
    ok("act 8: the file kit returned bytes and stored no object", Instant::now());
    // The registry must name the file kit — revocability is the record's
    // stated answer to a leaked kit, and an unlisted kit cannot be
    // revoked (found unasserted by T-C's sheet, which saw file kits
    // silently missing).
    let kits = step!("account.recovery-kits [file kit]", a.call_recovery_kits(acc));
    if kits.len() != 1 || kits[0].kind != "file" {
        bail!("recovery-kits does not name exactly the file kit just minted: {kits:?}");
    }
    step!(
        "account.bucket-flush(us) [file kit]",
        a.call_bucket_flush(acc, Vec::new())
    );
    step!(
        "account.bucket-flush(tasks) [file kit]",
        a.call_bucket_flush(acc, tasks.clone())
    );
    let want_titles = titles(&step!("account.tasks.items", at.call_items(acc)).items);

    let fw: &Driver = file_wrong_pass.polyvisor_engine_driver();
    match fw
        .call_recovery_restore_file(
            acc,
            store_cfg(),
            bundle.clone(),
            WRONG_PASSPHRASE.to_string(),
            "never".to_string(),
        )
        .await?
    {
        Ok(id) => bail!("a wrong passphrase opened the file kit: {id}"),
        Err(e) => refused("act 8: wrong passphrase", &e, "unlock failed")?,
    }

    let f: &Driver = file_restored.polyvisor_engine_driver();
    let ft: &Tasks = file_restored.polyvisor_tasks_tasks();
    let file_id_hex = step!(
        "file-restored.recovery-restore-file",
        f.call_recovery_restore_file(
            acc,
            store_cfg(),
            bundle.clone(),
            FILE_PASSPHRASE.to_string(),
            "the restored tablet".to_string(),
        )
    );
    let pointers = step!("file-restored.us-partitions", f.call_us_partitions(acc));
    for p in &pointers {
        step!(
            format!("file-restored.adopt-partition({})", p.name),
            f.call_adopt_partition(acc, p.id.clone())
        );
        step!(
            format!("file-restored.bucket-pull({}, account)", p.name),
            f.call_bucket_pull(acc, p.id.clone(), a_id.clone(), None)
        );
    }
    let got = titles(&step!("file-restored.tasks.items", ft.call_items(acc)).items);
    if got != want_titles {
        bail!("file-kit restore content differs:\n  want {want_titles:?}\n  got  {got:?}");
    }
    ok(
        &format!("act 8: the file kit restored {} with the account's content", &file_id_hex[..8]),
        Instant::now(),
    );

    step!(
        "file-restored.recovery-consume",
        f.call_recovery_consume(acc)
    );

    // The FILE cannot be deleted — the user holds it — so single-use is
    // carried by the K_p alone. A second restore therefore refuses one
    // step later than the bucket kind's does: it unlocks fine and then
    // finds no pickup at the us bootstrap. A 404, never a fork.
    let fd: &Driver = file_double.polyvisor_engine_driver();
    match fd
        .call_recovery_restore_file(
            acc,
            store_cfg(),
            bundle,
            FILE_PASSPHRASE.to_string(),
            "the second fork that must not be".to_string(),
        )
        .await?
    {
        Ok(id) => bail!("a consumed file kit restored a SECOND instance of {id} — an identity fork"),
        Err(e) => refused("act 8: double restore (file)", &e, "kp missing")?,
    }

    // === act 9: a rotation does not strand a bucket-only sibling (#110) ===
    //
    // THE STRAND THIS CLOSES. `store_revoke` on the us-doc appends a
    // name-key epoch. The rotator's later flushes land under the NEW
    // epoch's names. A sibling holding only the OLD chain scans its
    // keychain newest-first, finds the rotator's STALE old-epoch
    // manifest, and reads stale account state — silently, forever,
    // because the chain that would correct it lives in the us-doc whose
    // newest objects are exactly the ones it cannot name.
    //
    // THE CAST IS ALREADY RIGHT. `restored` is a real account device
    // that is CURRENT as of its consume, and no wire exists between it
    // and `account` anywhere in this battery — so "bucket-only lagging
    // sibling" is what it is, not what it is pretending to be.
    //
    // THE NEGATIVE CONTROL IS RUNNABLE, not quoted: with
    // `PM_NO_CHAIN_DROP=1 just recover` the guest writes no drops and
    // this act fails at the profile comparison below, the lagging device
    // still holding the pre-rotation profile. That is the pre-fix
    // behaviour, reproducible on demand rather than asserted in prose.

    // (a) A fresh kit, revoked — a us-chain rotation `restored` was not
    //     present for. File kits, so no bundle object joins the object
    //     set and the deltas below stay about pickups and drops alone.
    // The account's registry may still carry act 8's row: that kit was
    // consumed by the RESTORING device, and this device has not pulled
    // the clear. Harmless and not this act's business — so the two new
    // kits are identified by DIFFERENCE against what was already listed,
    // rather than by assuming an empty registry.
    let pre_kits: std::collections::HashSet<Vec<u8>> =
        step!("act 9: account.recovery-kits (before)", a.call_recovery_kits(acc))
            .into_iter()
            .map(|k| k.agent_id)
            .collect();
    let kit_a = step!(
        "act 9: account.recovery-kit-create-file(rotation trigger)",
        a.call_recovery_kit_create_file(
            acc,
            "the rotation trigger".to_string(),
            FILE_PASSPHRASE.to_string(),
        )
    );
    let kit_b = step!(
        "act 9: account.recovery-kit-create-file(the drop witness)",
        a.call_recovery_kit_create_file(
            acc,
            "the drop witness".to_string(),
            FILE_PASSPHRASE.to_string(),
        )
    );
    if kit_a.is_empty() || kit_b.is_empty() {
        bail!("act 9: a kit ceremony returned no bytes");
    }
    let fresh: Vec<Vec<u8>> = step!("act 9: account.recovery-kits", a.call_recovery_kits(acc))
        .into_iter()
        .map(|k| k.agent_id)
        .filter(|id| !pre_kits.contains(id))
        .collect();
    if fresh.len() != 2 {
        bail!("act 9: expected two NEW kits before the rotation, got {}", fresh.len());
    }
    let trigger = fresh[0].clone();
    let witness = fresh[1].clone();

    step!(
        "act 9: account.recovery-kit-revoke(rotation trigger)",
        a.call_recovery_kit_revoke(acc, trigger.clone())
    );

    // (b) A us-visible change AFTER the rotation, and a flush. Both the
    //     registry (the revoke cleared a row) and the profile move, so
    //     the assertion does not rest on one key.
    step!(
        "act 9: account.us-profile-set(after the rotation)",
        a.call_us_profile_set(
            acc,
            UsProfile {
                display_name: "Rose, post-rotation".to_string(),
                hue: 42,
                icon: None,
            },
        )
    );
    step!(
        "act 9: account.bucket-flush(us) [under the NEW epoch]",
        a.call_bucket_flush(acc, Vec::new())
    );

    // (c) The lagging sibling pulls. ONE pull: the probe adopts the
    //     longer chain before a single manifest name is derived, so the
    //     scan that follows is the scan it would have done had it never
    //     lagged. No second pull is permitted here — needing one would
    //     mean the probe landed after the names it was supposed to fix.
    let summary = step!(
        "act 9: restored.bucket-pull(us, account) [one pull, lagging by an epoch]",
        r.call_bucket_pull(acc, Vec::new(), a_id.clone(), None)
    );
    println!("           us: {summary}");

    let profile = step!("act 9: restored.us-profile-get", r.call_us_profile_get(acc));
    if profile.display_name != "Rose, post-rotation" || profile.hue != 42 {
        bail!(
            "act 9: THE STRAND — the lagging sibling read stale state across the rotation: \
             got {:?}/{}, expected \"Rose, post-rotation\"/42",
            profile.display_name,
            profile.hue
        );
    }
    let kits = step!("act 9: restored.recovery-kits", r.call_recovery_kits(acc));
    if kits.iter().any(|k| k.agent_id == trigger) {
        bail!("act 9: the lagging sibling still lists the revoked kit: {kits:?}");
    }
    if !kits.iter().any(|k| k.agent_id == witness) {
        bail!("act 9: the lagging sibling lost the surviving kit: {kits:?}");
    }
    ok("act 9: one pull across a missed rotation — profile AND registry are current", Instant::now());

    // (d) THE REVOKED PARTY'S DROP IS DELETED, beside its K_p. Asserted
    //     by set difference, the act-6 discipline: the witness kit was
    //     enrolled BEFORE the rotation above, so that rotation wrote it a
    //     drop, and revoking it now must take exactly two objects away —
    //     its pickup and its drop.
    //
    //     EXACTLY TWO is the whole assertion, and it is a sharp one:
    //     nothing else in this flow deletes anything, so the count
    //     distinguishes the two deletions from the one a build without
    //     the drop would perform.
    //
    //     WHAT IS DELIBERATELY NOT ASSERTED is that nothing is ADDED. It
    //     is not true and must not be: this revoke rotates, and the
    //     account's flush right after it rewrites the us-doc's oplog,
    //     manifest and chunks under the NEW epoch's names. That rewrite
    //     is exactly the phenomenon that stranded the sibling in the
    //     first place — asserting it away would be asserting the absence
    //     of the bug this act exists to prove is handled. The drop
    //     REFRESHES for surviving devices do land on the names they
    //     already occupy, but they are indistinguishable host-side from
    //     the flush's own opaque names, so the claim is left to the
    //     mechanism rather than dressed up as a measurement.
    let before = probe.keys().await?;
    step!(
        "act 9: account.recovery-kit-revoke(the drop witness)",
        a.call_recovery_kit_revoke(acc, witness.clone())
    );
    let after = probe.keys().await?;
    let gone: Vec<&String> = before.iter().filter(|k| !after.contains(k)).collect();
    if gone.len() != 2 {
        bail!(
            "act 9: revoking a kit that had a drop removed {} object(s), expected exactly 2 \
             (its pickup + its drop): {gone:?}",
            gone.len()
        );
    }
    ok("act 9: the revoked kit's pickup AND its chain drop are gone (exactly two)", Instant::now());

    Ok(())
}
