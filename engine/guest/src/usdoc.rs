//! The user-system partition (#36), implementing PAIRING.md §4.
//!
//! One automerge doc backs all four families — `profile`, `marks`,
//! `contacts`, `devices` as top-level maps — so the WIT surface can hide
//! the partitioning and the production split into per-family docs stays a
//! later engine change with zero visor impact. The doc is created by
//! `user-create`, delegated to the USER GROUP only (never to a device),
//! and sealed immediately: the founding device is the only member, and
//! every later device joins the GROUP, which CGKA-propagates.
//!
//! Two pieces of semantics live here rather than in the visor:
//!
//! - **Invariant repair.** Petname uniqueness (case-insensitive) and icon
//!   uniqueness are cross-record invariants, so a merge can break them
//!   even though every individual write was valid. Repair is
//!   deterministic — the older record wins (`created-at`, ties broken by
//!   lexicographic provenance) — which means every device computes the
//!   same outcome from the same doc state and renders it whether or not
//!   anyone writes it. Only the device whose OWN write lost writes the
//!   repair back, which is what keeps two devices from repairing each
//!   other in a loop.
//! - **Local-echo suppression.** `us-events` reports remotely-caused
//!   changes only. That falls out of the shape here: local writes update
//!   the diff baseline as they are made, so they can never appear as a
//!   later remote delta.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ReadDoc, ScalarValue, Value, ROOT};

use crate::exports::polyvisor::engine::driver::{
    UsDevice, UsEvent, UsMark, UsPartition, UsProfile, UsStorage, UsStorageGdrive, UsStorageS3,
};
use crate::{arr32, with_state, Partition};

// --- instance state ---

#[derive(Default)]
pub(crate) struct UsDoc {
    /// The user-system partition id (a keyhive doc id). One lineage:
    /// enrollment no longer regenerates the doc (PAIRING.md §2/§4b), so
    /// a late device joins THIS document and reads its history by causal
    /// walk. The `us-*` surface never exposes the id.
    pub(crate) doc: Option<Vec<u8>>,
    /// The user group every device of this user belongs to.
    pub(crate) user_group: Option<Vec<u8>>,
    /// Provenances THIS instance wrote. The repair rule keys off it:
    /// only the owner of a losing write persists the repair.
    my_marks: HashSet<String>,
    /// Contact cards already handed to keyhive, so a synced contact is
    /// ingested exactly once per instance.
    ingested_contacts: HashSet<String>,
    /// (peer, tree) pairs already subscribed, so the poll loop does not
    /// start a fresh sync every time it runs.
    subscribed: HashSet<(Vec<u8>, Vec<u8>)>,
    /// The baseline the next drain diffs against.
    last: Option<Snap>,
    /// The drained event queue (per instance, per PAIRING.md §4).
    events: Vec<UsEvent>,
}

fn doc_id() -> Result<Vec<u8>, String> {
    with_state(|s| s.us.doc.clone())?
        .ok_or_else(|| "no user-system partition (user-create or pair first)".to_string())
}

// --- automerge shape ---

/// #22: pet icons are a single Unicode scalar from a visor-curated set.
/// The ENGINE never invents vocabulary — the curated glyph set lives
/// visor-side (spikes/visor). A curated single scalar encodes to at most
/// 4 bytes in UTF-8; 8 gives headroom for a trailing variation selector
/// without opening the door to arbitrary strings.
const MAX_ICON_BYTES: usize = 8;

const PROFILE: &str = "profile";
const MARKS: &str = "marks";
const CONTACTS: &str = "contacts";
const DEVICES: &str = "devices";
/// The PARTITION-POINTER map (#36): `name -> partition id (raw bytes)`,
/// a flat top-level map beside the other families so it syncs exactly
/// like them. ADDITIVE: a document written before this key existed has
/// no `partitions` entry, and every read path below turns a missing map
/// into an empty list rather than an error.
const PARTITIONS: &str = "partitions";
/// THE ACCOUNT'S STORAGE RECORD (DRIVE.md, "The account syncs its storage
/// config; devices keep their credentials"). A single top-level map, not
/// a family map: an account has one store, so this is overwrite
/// semantics like `profile`, not an upsert-by-key like `partitions`.
///
/// Encoding, version-tolerantly: `storage."provider"` is the
/// discriminant string ("s3" | "gdrive"), and each arm's fields live in
/// a SUBMAP NAMED FOR THE ARM (`storage."gdrive"."client-id"`, …). The
/// arms are namespaced rather than flattened so that a switch of
/// provider cannot interleave with a concurrent write into a half-read
/// record: the discriminant is one LWW register, and whichever arm it
/// names is read whole from its own submap. A stale sibling submap is
/// inert, a missing field reads as "", and an UNKNOWN discriminant reads
/// as `None` — a device that predates a future arm reports "no storage
/// record I understand" rather than erroring or inventing one.
///
/// ADDITIVE, like `partitions`: a document written before this key
/// existed simply has no `storage` entry.
///
/// What the shape does NOT have is the enforcement: there is no token
/// field and no consent field in any arm, and no s3 secret, so standing
/// user credentials cannot ride the account even by accident.
const STORAGE: &str = "storage";
/// THE WALK-ANCHOR MAP a data partition carries: `agent id (hex) ->
/// enrolled-at`. Written into every account partition when a device is
/// enrolled (see `anchor_data_partitions`). It lives at the document
/// ROOT beside the app's own keys and is invisible to the app — the
/// tasks service reads `ROOT."todos"` and nothing else (lib.rs:2270).
const ENROLLED: &str = "_enrolled";
/// THE PER-DOC BUCKET NAME-KEY CHAINS (runtime/SYNC.md §1, the amended
/// ruling). `doc id (hex) -> the whole chain as ONE bytes register`:
/// epoch `e` is bytes `[32*e .. 32*e+32)` of that register's value.
///
/// GUEST-INTERNAL AND NEVER WIT. Every other family here has a `us-*`
/// call behind it; this one deliberately has none. It is secret material
/// (the same kind as `BucketState::name_keys`, which it is now the
/// source of truth for), it is plumbing rather than user-facing state,
/// and the visor has no use it could put a name-key to. It rides the
/// account's E2E sync for exactly one reason: the account's devices are
/// precisely the set that must agree on object names, and the us-doc is
/// already the channel between exactly that set.
///
/// ONE REGISTER PER DOC, REPLACED WHOLESALE. The chain is NOT a list
/// object and NOT a submap of per-epoch registers, and the difference is
/// the whole safety argument: an automerge list/submap merges
/// element-wise, so two devices appending concurrently produce a chain
/// no single writer ever wrote, and a reader mid-write can observe a
/// half-built one. A single `ScalarValue::Bytes` register merges
/// last-writer-wins on the WHOLE value — a reader sees some writer's
/// complete chain, always, and a rotation either lands entire or not at
/// all. The cost is SYNC.md §1's recorded first-mint race: two devices
/// minting for one doc before they sync, one chain wins, and the loser's
/// flush is orphaned — one flush's worth, self-healing on the next.
///
/// ADDITIVE, like `partitions` and `storage`: a document written before
/// this key existed simply has no `bucket-chains` entry, and a missing
/// entry reads as "no chain yet", never as an error.
///
/// NOT IN `Snap`, so not in `diff`, so never an event: a chain change is
/// plumbing, and `us-events` is the user's channel. Nothing in the pump
/// forces otherwise — `snapshot` reads the families it announces and
/// this key is not one of them.
const BUCKET_CHAINS: &str = "bucket-chains";
/// THE ACCOUNT'S LIVE RECOVERY KITS (runtime/RECOVERY.md, step 5 of the
/// kit ceremony). `agent id (hex) -> { kind, name, created }`, a flat
/// top-level map modelled on `PARTITIONS`: ADDITIVE, so a document
/// written before this key existed simply has no `recovery` entry and
/// every read below turns a missing map into an empty list rather than
/// an error.
///
/// IT LIVES IN THE ACCOUNT so that ANY device can revoke or supersede a
/// kit — the devices sheet is the interface, and a kit that only its
/// minting device could see would be unrevocable from the device you
/// still have, which is the case recovery exists for.
///
/// WHAT IS IN IT IS NOT SECRET. `kind` and `created` are metadata; the
/// bucket object NAME is not secret material either — the provider sees
/// the object regardless, and the payload behind it is sealed under the
/// phrase-derived KEK. The PHRASE is nowhere: it is displayed once in
/// visor pixels and persisted by nothing, here least of all.
///
/// NO NEW `us-event` CASE, for the reason `us-partition-put` gives:
/// consumers poll, and a fresh arm through every adapter's exhaustive
/// match buys nothing nobody edge-triggers on. The devices map already
/// announces — a kit IS a device — so a kit's arrival and its revocation
/// are announced as `device-added` / `device-revoked` already.
const RECOVERY: &str = "recovery";

fn map_at(am: &AutoCommit, key: &str) -> Option<ObjId> {
    match am.get(ROOT, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn child_map(am: &AutoCommit, parent: &ObjId, key: &str) -> Option<ObjId> {
    match am.get(parent, key) {
        Ok(Some((Value::Object(ObjType::Map), id))) => Some(id),
        _ => None,
    }
}

fn get_str(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<String> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Str(v) => Some(v.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn get_u64(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<u64> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Int(v) => Some(v.max(0) as u64),
            ScalarValue::Uint(v) => Some(v),
            ScalarValue::Timestamp(v) => Some(v.max(0) as u64),
            _ => None,
        },
        _ => None,
    }
}

fn get_bool(am: &AutoCommit, obj: &ObjId, key: &str) -> bool {
    matches!(
        am.get(obj, key),
        Ok(Some((Value::Scalar(ref s), _))) if matches!(s.as_ref(), ScalarValue::Boolean(true))
    )
}

fn get_bytes(am: &AutoCommit, obj: &ObjId, key: &str) -> Option<Vec<u8>> {
    match am.get(obj, key) {
        Ok(Some((Value::Scalar(s), _))) => match s.into_owned() {
            ScalarValue::Bytes(v) => Some(v),
            _ => None,
        },
        _ => None,
    }
}

// --- raw records ---

#[derive(Clone, PartialEq)]
struct MarkRaw {
    provenance: String,
    petname: String,
    icon: String,
    nickname: Option<String>,
    created_at: u64,
    /// The petname the user last re-confirmed under. A confirmation is
    /// scoped to the exact name it was given for: renaming into a fresh
    /// collision must ask again, so this stores the string, not a flag.
    confirmed_for: Option<String>,
}

fn read_marks(am: &AutoCommit) -> Vec<MarkRaw> {
    let Some(marks) = map_at(am, MARKS) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in am.keys(&marks) {
        let Some(m) = child_map(am, &marks, &key) else {
            continue;
        };
        out.push(MarkRaw {
            provenance: key.to_string(),
            petname: get_str(am, &m, "petname").unwrap_or_default(),
            icon: get_str(am, &m, "icon").unwrap_or_default(),
            nickname: get_str(am, &m, "nickname"),
            created_at: get_u64(am, &m, "created-at").unwrap_or(0),
            confirmed_for: get_str(am, &m, "confirmed-for"),
        });
    }
    out
}

fn read_profile(am: &AutoCommit) -> (String, u16, Option<Vec<u8>>) {
    let Some(p) = map_at(am, PROFILE) else {
        return (String::new(), 0, None);
    };
    (
        get_str(am, &p, "display-name").unwrap_or_default(),
        get_u64(am, &p, "hue").unwrap_or(0) as u16,
        get_bytes(am, &p, "icon"),
    )
}

/// One entry of the devices map, as the document holds it.
///
/// A named record rather than a tuple because it grew past the point
/// where positional reads stayed honest — and because two of its fields
/// are ADDITIVE (engine.wit's `us-device`): `endpoint` and `enrolled_by`
/// are empty on every entry written before those keys existed, and the
/// read path must treat that as ordinary rather than as damage.
#[derive(Clone, PartialEq)]
struct DeviceRow {
    name: String,
    enrolled_at: u64,
    revoked: bool,
    endpoint: Vec<u8>,
    enrolled_by: Vec<u8>,
}

fn read_devices(am: &AutoCommit) -> BTreeMap<String, DeviceRow> {
    let mut out = BTreeMap::new();
    let Some(devices) = map_at(am, DEVICES) else {
        return out;
    };
    for key in am.keys(&devices) {
        let Some(d) = child_map(am, &devices, &key) else {
            continue;
        };
        out.insert(
            key.to_string(),
            DeviceRow {
                name: get_str(am, &d, "name").unwrap_or_default(),
                enrolled_at: get_u64(am, &d, "enrolled-at").unwrap_or(0),
                revoked: get_bool(am, &d, "revoked"),
                // ADDITIVE (engine.wit's `us-device`): an entry written
                // before these keys existed reads back empty, which is
                // the documented value for "not recorded", not an error.
                endpoint: get_bytes(am, &d, "endpoint").unwrap_or_default(),
                enrolled_by: get_bytes(am, &d, "enrolled-by").unwrap_or_default(),
            },
        );
    }
    out
}

fn read_contacts(am: &AutoCommit) -> BTreeMap<String, (Vec<u8>, String)> {
    let mut out = BTreeMap::new();
    let Some(contacts) = map_at(am, CONTACTS) else {
        return out;
    };
    for key in am.keys(&contacts) {
        let Some(c) = child_map(am, &contacts, &key) else {
            continue;
        };
        out.insert(
            key.to_string(),
            (
                get_bytes(am, &c, "card").unwrap_or_default(),
                get_str(am, &c, "petname").unwrap_or_default(),
            ),
        );
    }
    out
}

/// Name-ordered (`am.keys` yields a map's keys sorted), so two devices
/// that read the same doc state render the same list.
fn read_partitions(am: &AutoCommit) -> Vec<(String, Vec<u8>)> {
    let Some(partitions) = map_at(am, PARTITIONS) else {
        // Old document, written before the key existed: empty, not an
        // error. Same tolerance every other family read has.
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in am.keys(&partitions) {
        let Some(id) = get_bytes(am, &partitions, &key) else {
            continue;
        };
        out.push((key.to_string(), id));
    }
    out
}

/// The account's storage record as it sits in the document: the
/// discriminant plus the named arm's own fields, nothing interpreted.
/// Comparing this is what the event diff diffs.
#[derive(Clone, PartialEq)]
struct StorageRaw {
    provider: String,
    fields: BTreeMap<String, String>,
}

/// The arm submaps' field names, in the order the WIT records declare
/// them. The lists are the ONLY place a field name is spelled, so a
/// read and a write cannot drift apart.
const S3_FIELDS: [&str; 3] = ["endpoint", "bucket", "access-key"];
const GDRIVE_FIELDS: [&str; 5] = ["root", "api-base", "space", "client-id", "client-secret"];

fn arm_fields(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "s3" => Some(&S3_FIELDS),
        "gdrive" => Some(&GDRIVE_FIELDS),
        // A discriminant this build does not know: not an error, and not
        // guessed at. See STORAGE's note on version tolerance.
        _ => None,
    }
}

fn read_storage(am: &AutoCommit) -> Option<StorageRaw> {
    // Missing key: an account that never bound a store, or a document
    // written before this key existed. Same tolerance as `partitions`.
    let storage = map_at(am, STORAGE)?;
    let provider = get_str(am, &storage, "provider")?;
    let names = arm_fields(&provider)?;
    let arm = child_map(am, &storage, &provider)?;
    let mut fields = BTreeMap::new();
    for name in names {
        // A field the writer never wrote reads as "" rather than
        // dropping the whole record.
        fields.insert(
            (*name).to_string(),
            get_str(am, &arm, name).unwrap_or_default(),
        );
    }
    Some(StorageRaw { provider, fields })
}

fn storage_to_wit(raw: &StorageRaw) -> Option<UsStorage> {
    let f = |k: &str| raw.fields.get(k).cloned().unwrap_or_default();
    match raw.provider.as_str() {
        "s3" => Some(UsStorage::S3(UsStorageS3 {
            endpoint: f("endpoint"),
            bucket: f("bucket"),
            // The PUBLIC key identifier. There is no secret field here,
            // and cannot be: the SigV4 secret is a non-extractable
            // handle, so there are no bytes to sync (DRIVE.md).
            access_key: f("access-key"),
        })),
        "gdrive" => Some(UsStorage::Gdrive(UsStorageGdrive {
            root: f("root"),
            api_base: f("api-base"),
            space: f("space"),
            client_id: f("client-id"),
            // App identity, not a user credential — the one secret the
            // ruling lets ride the account's E2E state.
            client_secret: f("client-secret"),
        })),
        _ => None,
    }
}

/// The document form of a WIT record: `(provider, [(field, value)])`.
fn storage_from_wit(s: &UsStorage) -> (&'static str, Vec<(&'static str, String)>) {
    match s {
        UsStorage::S3(v) => (
            "s3",
            vec![
                ("endpoint", v.endpoint.clone()),
                ("bucket", v.bucket.clone()),
                ("access-key", v.access_key.clone()),
            ],
        ),
        UsStorage::Gdrive(v) => (
            "gdrive",
            vec![
                ("root", v.root.clone()),
                ("api-base", v.api_base.clone()),
                ("space", v.space.clone()),
                ("client-id", v.client_id.clone()),
                ("client-secret", v.client_secret.clone()),
            ],
        ),
    }
}

/// Keep a subscription open to the user-system doc with every peer.
///
/// Engine-driven because `us-*` hides doc identity by design, so the host
/// has no name for the tree to subscribe to.
fn ensure_subscriptions() -> Result<(), String> {
    let Some(tree) = with_state(|s| s.us.doc.clone())? else {
        return Ok(());
    };
    for peer in crate::known_peers()? {
        let key = (peer.clone(), tree.clone());
        if with_state(|s| s.us.subscribed.contains(&key))? {
            continue;
        }
        if crate::subscribe_tree(peer, tree.clone()).is_ok() {
            with_state(|s| s.us.subscribed.insert(key))?;
        }
    }
    Ok(())
}

// --- deterministic invariant repair (PAIRING.md §4) ---

/// The repaired rendering of the marks, plus the set of repairs it took
/// to get there. Both are pure functions of the doc state, which is what
/// makes every device agree without coordinating.
struct Repaired {
    marks: Vec<UsMark>,
    /// `(provenance, "petname" | "icon")`.
    repairs: BTreeSet<(String, String)>,
    /// The icon each mark should carry after repair, for the write-back
    /// rule (only the owner of a losing write persists it).
    icons: HashMap<String, String>,
}

fn repair(raw: &[MarkRaw]) -> Repaired {
    // Canonical order IS the conflict rule: older `created-at` wins, ties
    // broken lexicographically by provenance. Every device sorts the same
    // way, so every device picks the same winner.
    let mut order: Vec<&MarkRaw> = raw.iter().collect();
    order.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.provenance.cmp(&b.provenance))
    });

    let mut claimed_petnames: HashSet<String> = HashSet::new();
    let mut claimed_icons: HashSet<String> = HashSet::new();
    let mut repairs = BTreeSet::new();
    let mut icons = HashMap::new();
    let mut marks = Vec::new();

    for m in order {
        let petname_loser = !claimed_petnames.insert(m.petname.to_lowercase());
        let petname_needs_reconfirm = if petname_loser {
            repairs.insert((m.provenance.clone(), "petname".to_string()));
            // The loser keeps its petname bytes; what it loses is the
            // user's assumption that the name is unambiguous. The visor
            // re-introduces it, and `us-mark-confirm` clears the flag.
            m.confirmed_for.as_deref() != Some(m.petname.as_str())
        } else {
            false
        };
        // Icon collisions: unlike hues (a fixed engine-known palette),
        // icons are a visor-curated vocabulary the engine has no access
        // to. The engine cannot invent a replacement glyph, so the loser
        // is cleared to "" (unmarked) and flagged for reconfirm — the
        // visor re-offers its picker on reconfirm. This is a deliberate
        // asymmetry with the old hue-reassignment behavior, not an
        // oversight: see dispatch notes on #22 pet icons.
        let was_icon_collision = !m.icon.is_empty() && claimed_icons.contains(&m.icon);
        let icon = if was_icon_collision {
            repairs.insert((m.provenance.clone(), "icon".to_string()));
            String::new()
        } else {
            m.icon.clone()
        };
        if !icon.is_empty() {
            claimed_icons.insert(icon.clone());
        }
        // needs-reconfirm for an icon cannot be recomputed from the
        // collision itself once the write-back clears the icon to ""
        // (the collision disappears from the raw data on the very next
        // read). Deriving it from "icon is empty" instead is equivalent
        // AND self-stable: "" means unmarked/needs-reassignment either
        // way (freshly created with no icon, or cleared by a repair),
        // and both cases want the visor to re-offer its picker.
        let needs_reconfirm = petname_needs_reconfirm || icon.is_empty();
        icons.insert(m.provenance.clone(), icon.clone());
        marks.push(UsMark {
            provenance: m.provenance.clone(),
            petname: m.petname.clone(),
            icon,
            nickname: m.nickname.clone(),
            created_at: m.created_at,
            needs_reconfirm,
        });
    }
    Repaired {
        marks,
        repairs,
        icons,
    }
}

// --- snapshots and the event diff ---

#[derive(Clone, Default, PartialEq)]
struct Snap {
    profile: (String, u16, Option<Vec<u8>>),
    /// The REPAIRED view, keyed by provenance: diffing repaired views is
    /// what keeps a repair write from announcing itself twice.
    marks: BTreeMap<String, (String, String, Option<String>, u64, bool)>,
    repairs: BTreeSet<(String, String)>,
    devices: BTreeMap<String, DeviceRow>,
    /// The account's storage record. `None` until an account binds one;
    /// compared WHOLE, so a change of any field (not just of provider)
    /// is a change worth announcing.
    storage: Option<StorageRaw>,
}

fn snapshot(am: &AutoCommit) -> Snap {
    let repaired = repair(&read_marks(am));
    Snap {
        profile: read_profile(am),
        marks: repaired
            .marks
            .into_iter()
            .map(|m| {
                (
                    m.provenance,
                    (
                    m.petname,
                    m.icon,
                    m.nickname,
                        m.created_at,
                        m.needs_reconfirm,
                    ),
                )
            })
            .collect(),
        repairs: repaired.repairs,
        devices: read_devices(am),
        storage: read_storage(am),
    }
}

fn diff(pre: &Snap, post: &Snap) -> Vec<UsEvent> {
    let mut out = Vec::new();
    if pre.profile != post.profile {
        out.push(UsEvent::ProfileChanged);
    }
    let new_repairs: Vec<&(String, String)> =
        post.repairs.difference(&pre.repairs).collect();
    let repaired_now: HashSet<&String> = new_repairs.iter().map(|(p, _)| p).collect();
    for (prov, value) in &post.marks {
        match pre.marks.get(prov) {
            None => out.push(UsEvent::MarkAdded(prov.clone())),
            Some(before) if before != value && !repaired_now.contains(prov) => {
                out.push(UsEvent::MarkChanged(prov.clone()))
            }
            Some(_) => {}
        }
    }
    for (prov, kind) in new_repairs {
        out.push(UsEvent::MarkConflictRepaired((prov.clone(), kind.clone())));
    }
    // Devices announce APPEARANCE and REVOCATION, and nothing else: an
    // endpoint that moved is not news to a user, and every device
    // rewrites its own endpoint at boot, so an event on that field would
    // be a notification storm about plumbing.
    for (id, row) in &post.devices {
        match pre.devices.get(id) {
            None => out.push(UsEvent::DeviceAdded(row.name.clone())),
            Some(before) if !before.revoked && row.revoked => {
                out.push(UsEvent::DeviceRevoked(row.name.clone()))
            }
            Some(_) => {}
        }
    }
    // The account's storage destination changed somewhere else. The
    // visor ANNOUNCES it and never silently adopts it (DRIVE.md, "The
    // account syncs its storage config…": a bind that changes the
    // destination "is a change the OTHER devices announce (`us-events`),
    // never silently adopt"). Local-echo suppression is the same
    // mechanism as for the profile: `write` re-baselines after the local
    // author, so the writing device's own record never appears as a
    // delta here.
    //
    // Only a record that EXISTS is announced: `None -> Some` is the
    // account's first bind (announced), `Some -> Some` any later change,
    // and a hypothetical `Some -> None` has no provider to name and no
    // destination to warn about, so it stays silent rather than
    // announcing an empty string.
    if pre.storage != post.storage {
        if let Some(s) = &post.storage {
            out.push(UsEvent::StorageChanged(s.provider.clone()));
        }
    }
    out
}

// --- the pump: apply, repair, announce ---

fn read_us<R>(f: impl FnOnce(&AutoCommit) -> R) -> Result<R, String> {
    let id = doc_id()?;
    with_state(|s| {
        s.partitions
            .get(&id)
            .map(|p| f(&p.am))
            .ok_or_else(|| "user-system partition not held".to_string())
    })?
}

/// Take the announce-baseline from the document as it currently stands.
///
/// `pub(crate)` for the RESUME path (persist.rs): a device coming back
/// from a checkpoint already announced everything in the restored
/// document, so it must baseline rather than replay. A JOINING device
/// deliberately does the opposite (`enrolled`, below, sets `last = None`).
pub(crate) fn set_baseline() -> Result<(), String> {
    let snap = read_us(snapshot)?;
    with_state(|s| s.us.last = Some(snap))
}

/// The provenances this instance wrote, for the checkpoint (persist.rs).
/// The repair rule keys off this set — only the owner of a losing write
/// persists the repair — so a resumed device that dropped it would stop
/// repairing its own collisions.
pub(crate) fn my_marks(us: &UsDoc) -> Vec<String> {
    let mut out: Vec<String> = us.my_marks.iter().cloned().collect();
    out.sort();
    out
}

/// Restore the set above on resume.
pub(crate) fn set_my_marks(us: &mut UsDoc, marks: Vec<String>) {
    us.my_marks = marks.into_iter().collect();
}

/// Re-baseline after a LOCAL write, without swallowing an invariant
/// violation the write happened to complete.
///
/// A local write must not be echoed back to its author, which is what
/// re-baselining is for. But whether a mark COLLIDES is a property of the
/// whole document, not of this device's write: if the other device's
/// half of the collision landed while this write was in flight, taking a
/// fresh baseline would absorb the repair silently and the user would
/// never be told their name choice now clashes. So everything is
/// re-baselined except the repair set, which stays as it was before the
/// write and is therefore still a delta for the next drain to announce.
fn set_baseline_after_local_write(before: BTreeSet<(String, String)>) -> Result<(), String> {
    let mut snap = read_us(snapshot)?;
    snap.repairs = before;
    with_state(|s| s.us.last = Some(snap))
}

/// Apply whatever synced, re-derive the invariants, queue the events, and
/// persist this device's own losing repair (and only its own).
pub(crate) async fn pump() -> Result<(), String> {
    if with_state(|s| s.us.doc.is_none())? {
        return Ok(());
    }
    let id = doc_id()?;
    crate::apply_new_chunks(&id).await?;
    ensure_subscriptions()?;

    // Received cards are state that must reach every device (the G3
    // finding: the wire will not carry a foreign group's ops to
    // non-members), so contacts arriving through the doc are ingested
    // here rather than assumed present.
    let contacts = read_us(read_contacts)?;
    for (key, (card, _)) in contacts {
        if card.is_empty() {
            continue;
        }
        let fresh = with_state(|s| s.us.ingested_contacts.insert(key.clone()))?;
        if fresh {
            if let Err(e) = crate::ingest_static_card(card).await {
                eprintln!("[us] contact ingest: {e}");
            }
        }
    }

    let pre = with_state(|s| s.us.last.clone())?.unwrap_or_default();
    let post = read_us(snapshot)?;
    let events = diff(&pre, &post);
    with_state(|s| {
        s.us.last = Some(post);
        s.us.events.extend(events);
    })?;

    repair_writes().await
}

/// Persist repairs, but only the ones this device's own write caused.
/// Every device computed the same outcome; if all of them wrote it, the
/// doc would churn for no gain, so the loser's owner is the one that
/// commits it and everyone else just renders it.
async fn repair_writes() -> Result<(), String> {
    let (raw, mine) = {
        let raw = read_us(read_marks)?;
        let mine = with_state(|s| s.us.my_marks.clone())?;
        (raw, mine)
    };
    let repaired = repair(&raw);
    let mut pending: Vec<(String, String)> = Vec::new();
    for m in &raw {
        if !mine.contains(&m.provenance) {
            continue;
        }
        if repaired
            .repairs
            .contains(&(m.provenance.clone(), "icon".to_string()))
        {
            let want = repaired
                .icons
                .get(&m.provenance)
                .cloned()
                .unwrap_or_else(|| m.icon.clone());
            if want != m.icon {
                pending.push((m.provenance.clone(), want));
            }
        }
    }
    if pending.is_empty() {
        return Ok(());
    }
    let id = doc_id()?;
    for (provenance, icon) in pending {
        crate::author(&id, |am| {
            let marks = map_at(am, MARKS).ok_or("no marks map")?;
            let m = child_map(am, &marks, &provenance).ok_or("mark vanished")?;
            am.put(&m, "icon", icon.as_str())
                .map_err(|e| format!("repair icon: {e}"))?;
            Ok(())
        })
        .await?;
    }
    // The repair is this device's own write, so it must not come back as
    // an announcement on the next drain.
    set_baseline()
}

/// Every local write goes through here: pump first (so anything remote
/// that is already in flight is announced before the local change lands),
/// then author, then re-baseline so the local write is never echoed.
async fn write<R>(f: impl FnOnce(&mut AutoCommit) -> Result<R, String>) -> Result<R, String> {
    pump().await?;
    let repairs_before = with_state(|s| {
        s.us.last
            .as_ref()
            .map(|snap| snap.repairs.clone())
            .unwrap_or_default()
    })?;
    let id = doc_id()?;
    let out = crate::author(&id, f).await?;
    set_baseline_after_local_write(repairs_before)?;
    Ok(out)
}

// --- the driver surface ---

/// First device only: the user group, the user-system doc, the initial
/// profile. Ordering is load-bearing (create → delegate → seal): BeeKEM
/// adds are not retroactive, so the doc's first epoch must already cover
/// its intended readership.
pub(crate) async fn create(profile: UsProfile) -> Result<Vec<u8>, String> {
    if with_state(|s| s.us.doc.is_some())? {
        return Err("user-system partition already exists".into());
    }
    let group = crate::create_user_group().await?;

    let mut am = AutoCommit::new();
    let p = am
        .put_object(ROOT, PROFILE, ObjType::Map)
        .map_err(|e| format!("profile map: {e}"))?;
    am.put(&p, "display-name", profile.display_name.as_str())
        .map_err(|e| format!("display-name: {e}"))?;
    am.put(&p, "hue", profile.hue as i64)
        .map_err(|e| format!("hue: {e}"))?;
    if let Some(icon) = profile.icon.clone() {
        am.put(&p, "icon", icon).map_err(|e| format!("icon: {e}"))?;
    }
    for family in [MARKS, CONTACTS, DEVICES, PARTITIONS] {
        am.put_object(ROOT, family, ObjType::Map)
            .map_err(|e| format!("{family} map: {e}"))?;
    }
    am.commit();
    let change = am
        .get_last_local_change()
        .ok_or("user-system creation produced no change")?;
    let cref = change.hash().0;
    let chunk = change.raw_bytes().to_vec();

    let id = crate::create_doc_for(cref).await?;
    // Delegated to the user GROUP only, never to a device: membership of
    // the group is the whole access story, and pairing adds to the group.
    crate::add_doc_member(&id, &group, "edit").await?;

    with_state(|s| {
        let mut applied = HashSet::new();
        applied.insert(cref);
        s.partitions.insert(
            id.clone(),
            Partition {
                am,
                applied,
                revision: 1,
                undecryptable: 0,
                decrypted: 0,
                walked: 0,
            },
        );
        s.us.doc = Some(id.clone());
        s.us.user_group = Some(group.clone());
    })?;
    // Sealed immediately: a single founding member means there is no
    // add-before-seal window to keep open.
    crate::encrypt_and_commit(&id, chunk, vec![], cref).await?;

    // CONTRACT: §2 has the ADDER name every device it enrolls, but §3
    // gives `user-create` no name for the founding device. Recording it
    // with an empty name keeps `us-devices-list` complete (a missing
    // first device would be worse than an unnamed one) and leaves the
    // naming to the visor. Flagged to the dispatcher.
    // The founding device: `enrolled-by` is EMPTY because nobody
    // enrolled it, which is the record's documented reading of empty
    // rather than a gap. Its endpoint is recorded if the transport
    // happens to be bound already — the host's ordering, not ours — and
    // the boot-time `us_device_endpoint_put` covers the case where it is
    // not.
    device_entry(&crate::own_agent_id()?, "", &crate::own_endpoint_id()?, &[]).await?;
    set_baseline()?;
    Ok(group)
}

/// Adopt an existing user-system partition (the joiner's step 7).
pub(crate) async fn adopt(partition_id: &[u8], user_group_id: &[u8]) -> Result<(), String> {
    with_state(|s| {
        s.partitions
            .entry(partition_id.to_vec())
            .or_insert_with(|| Partition {
                am: AutoCommit::new(),
                applied: HashSet::new(),
                revision: 0,
                undecryptable: 0,
                decrypted: 0,
                walked: 0,
            });
        s.us.doc = Some(partition_id.to_vec());
        s.us.user_group = Some(user_group_id.to_vec());
        // No baseline: the profile, marks and devices this device is
        // about to learn ARE remotely-caused changes, and #22 says they
        // are announced, never silently adopted.
        s.us.last = None;
    })?;
    crate::flush_keyhive().await
}

/// A WALK ANCHOR IN EVERY ACCOUNT DATA PARTITION.
///
/// PAIRING.md §4b: a joining device reads a document's pre-join history
/// by CAUSAL WALK, and a walk has to start from a chunk the joiner can
/// actually open. BeeKEM adds are not retroactive, so every chunk sealed
/// before the joiner existed is sealed under an epoch it does not hold;
/// what makes the rest reachable is one chunk under the NEW epoch, from
/// which the whole ancestry can be walked.
///
/// `enroll_device` has always written that anchor for the user-system
/// doc — the devices entry, flagged as the walk anchor in step 5 below.
/// The account's DATA partitions had no equivalent, and the gap is not
/// theoretical: measured in the browser across two pages, a device that
/// joined an account whose todo list had been created and written BEFORE
/// the ceremony synced all of that partition's chunks and could decrypt
/// none of them — `chunk-stats` agreed on both sides while the joiner's
/// materialized view stayed empty, indefinitely. One post-enrollment
/// write on the adder's side made the whole history readable at once.
///
/// So the anchor is written here, for the same reason and by the same
/// mechanism. It goes in `_enrolled` rather than in any app-owned key:
/// the anchor must not be app-visible data, and inventing a todo item to
/// carry it would put a row in the user's list that the user did not
/// write.
///
/// Only partitions the account NAMES (the pointer map) and this device
/// actually HOLDS are touched — the ones a joiner can discover and will
/// try to read. Failure is reported per partition rather than aborting
/// the enrollment: the membership grant has already landed and is
/// correct, and losing it over an anchor would be the worse trade.
async fn anchor_data_partitions(agent: &[u8]) -> Result<(), String> {
    let us = doc_id()?;
    let named = read_us(read_partitions)?;
    let agent_key = hex::encode(agent);
    let enrolled_at = crate::now_ms_u64();
    for (name, id) in named {
        // The us doc gets its anchor from the devices entry; anchoring it
        // twice would be a second write for nothing.
        if id == us {
            continue;
        }
        if !with_state(|s| s.partitions.contains_key(&id))? {
            // Named but not held on this device: nothing to seal a chunk
            // from, and nothing this device could anchor honestly.
            continue;
        }
        let agent_key = agent_key.clone();
        let write = crate::author(&id, move |am| {
            let enrolled = match map_at(am, ENROLLED) {
                Some(e) => e,
                None => am
                    .put_object(ROOT, ENROLLED, ObjType::Map)
                    .map_err(|e| format!("enrolled map: {e}"))?,
            };
            am.put(&enrolled, agent_key.as_str(), enrolled_at as i64)
                .map_err(|e| format!("enrolled entry: {e}"))?;
            Ok(())
        })
        .await;
        if let Err(e) = write {
            eprintln!("[enroll] could not anchor partition {name:?} for the new device: {e}");
        }
    }
    Ok(())
}

/// The adder's enrollment writes, in the order PAIRING.md §2 pins.
///
/// `join_ep` is the joiner's iroh endpoint id AS THIS DEVICE OBSERVED
/// IT: the adder dialed that endpoint to run the ceremony, and in iroh
/// the key is the address, so the connection itself authenticates the
/// id. Recording it here is what lets the account re-find the new device
/// after both sides have been closed and reopened.
pub(crate) async fn enroll_device(
    joiner: &[u8],
    name: &str,
    join_ep: &[u8],
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    let group = with_state(|s| s.us.user_group.clone())?
        .ok_or("no user group on this device (user-create first)")?;
    // 1. Admin membership FIRST. Enrollment is the consequential grant —
    // a device of the user is admin of everything the user reaches — and
    // it must exist before the card is exported, or the card the joiner
    // ingests will not carry the delegation that makes it a member.
    crate::add_to_group(&group, joiner, "admin").await?;
    // 2. A forced fresh epoch on every doc delegated to the user group,
    // per PAIRING.md §2.
    //
    // Measured, and NOT load-bearing for readability: with this switched
    // off (and with the ENROLL card suppressed too) a device added after
    // the doc was sealed still reads content written afterwards, because
    // keyhive's own `add_member` already propagates the CGKA add to every
    // doc that transitively contains the group, and the next encryption
    // derives from it. It is kept as defence in depth — a deliberate
    // epoch boundary at the moment a device joins is a property worth
    // having independently of whether readability needs it.
    //
    // `PM_NO_ROTATE` exists to keep that measurement re-runnable rather
    // than a claim in a comment.
    if std::env::var("PM_NO_ROTATE").is_err() {
        crate::rotate_docs_for_group(&group).await?;
    }
    // 3. The ORIGINAL partition: there is no regeneration any more
    // (PAIRING.md §2). The joiner reads this document's history by causal
    // walk from the anchor written in step 5.
    let partition = doc_id()?;
    // 4. The card, exported for the new INDIVIDUAL (the G3 finding: an
    // individual's card carries every membership the person can reach;
    // a group's card carries the memberships the GROUP reaches, which
    // excludes its own constitutive ops).
    let card = crate::export_static_card(joiner).await?;
    // 5. The devices entry, then flush. This write is also the WALK
    // ANCHOR: it is sealed under an epoch the joiner holds, so it is
    // guaranteed to be a chunk the joiner can open directly — and from a
    // chunk it can open, the whole ancestry is reachable (§2, §4b).
    device_entry(joiner, name, join_ep, &crate::own_agent_id()?).await?;
    // 6. The same anchor, for the account's DATA partitions — the
    // devices entry only covers this document (see
    // `anchor_data_partitions`). AFTER the rotation in step 2, so the
    // chunk is sealed under an epoch the joiner holds; that ordering is
    // the whole mechanism.
    anchor_data_partitions(joiner).await?;
    crate::flush_keyhive().await?;
    Ok((group, card, partition))
}

/// Write (or refresh) one device's entry.
///
/// `endpoint` and `enrolled_by` are written ONLY when non-empty: an
/// empty argument means "nothing to say about this", and writing an
/// empty value would turn a silence into an assertion — a later, better
/// informed write (the joiner's own boot-time
/// `us_device_endpoint_put`) would then be overwriting a real key with
/// nothing on the losing side of a merge.
async fn device_entry(
    agent: &[u8],
    name: &str,
    endpoint: &[u8],
    enrolled_by: &[u8],
) -> Result<(), String> {
    let key = hex::encode(agent);
    let enrolled_at = crate::now_ms_u64();
    let name = name.to_string();
    // Raw bytes, as `us-partition`'s id and the profile icon are stored:
    // the map KEY is hex because automerge map keys are strings, the
    // values are not.
    let endpoint = endpoint.to_vec();
    let enrolled_by = enrolled_by.to_vec();
    write(move |am| {
        let devices = match map_at(am, DEVICES) {
            Some(d) => d,
            None => am
                .put_object(ROOT, DEVICES, ObjType::Map)
                .map_err(|e| format!("devices map: {e}"))?,
        };
        let d = match child_map(am, &devices, &key) {
            Some(d) => d,
            None => am
                .put_object(&devices, &key, ObjType::Map)
                .map_err(|e| format!("device entry: {e}"))?,
        };
        am.put(&d, "name", name.as_str())
            .map_err(|e| format!("device name: {e}"))?;
        am.put(&d, "enrolled-at", enrolled_at as i64)
            .map_err(|e| format!("enrolled-at: {e}"))?;
        am.put(&d, "revoked", false)
            .map_err(|e| format!("revoked: {e}"))?;
        if !endpoint.is_empty() {
            am.put(&d, "endpoint", endpoint)
                .map_err(|e| format!("device endpoint: {e}"))?;
        }
        if !enrolled_by.is_empty() {
            am.put(&d, "enrolled-by", enrolled_by)
                .map_err(|e| format!("enrolled-by: {e}"))?;
        }
        Ok(())
    })
    .await
}

pub(crate) async fn profile_get() -> Result<UsProfile, String> {
    pump().await?;
    let (display_name, hue, icon) = read_us(read_profile)?;
    Ok(UsProfile {
        display_name,
        hue,
        icon,
    })
}

pub(crate) async fn profile_set(profile: UsProfile) -> Result<(), String> {
    write(move |am| {
        let p = match map_at(am, PROFILE) {
            Some(p) => p,
            None => am
                .put_object(ROOT, PROFILE, ObjType::Map)
                .map_err(|e| format!("profile map: {e}"))?,
        };
        am.put(&p, "display-name", profile.display_name.as_str())
            .map_err(|e| format!("display-name: {e}"))?;
        am.put(&p, "hue", profile.hue as i64)
            .map_err(|e| format!("hue: {e}"))?;
        match profile.icon {
            Some(icon) => am.put(&p, "icon", icon).map_err(|e| format!("icon: {e}"))?,
            None => {
                let _ = am.delete(&p, "icon");
            }
        }
        Ok(())
    })
    .await
}

pub(crate) async fn marks_list() -> Result<Vec<UsMark>, String> {
    pump().await?;
    let raw = read_us(read_marks)?;
    Ok(repair(&raw).marks)
}

pub(crate) async fn mark_put(mark: UsMark) -> Result<(), String> {
    let provenance = mark.provenance.clone();
    if provenance.is_empty() {
        return Err("a mark needs a provenance".into());
    }
    // CONTRACT: dispatch says "reject empty petname as before" — no such
    // validation existed in the pre-#22 code (checked via rg); enforcing
    // it now is the conservative reading, not a regression.
    if mark.petname.is_empty() {
        return Err("a mark needs a petname".into());
    }
    // Icon MAY be empty (unmarked/needs-reassignment). A curated single
    // Unicode scalar is at most 4 bytes in UTF-8; 8 gives headroom for a
    // trailing variation selector without accepting arbitrary strings.
    if mark.icon.len() > MAX_ICON_BYTES {
        return Err(format!(
            "icon must be at most {MAX_ICON_BYTES} bytes, got {}",
            mark.icon.len()
        ));
    }
    with_state(|s| s.us.my_marks.insert(provenance.clone()))?;
    write(move |am| {
        let marks = match map_at(am, MARKS) {
            Some(m) => m,
            None => am
                .put_object(ROOT, MARKS, ObjType::Map)
                .map_err(|e| format!("marks map: {e}"))?,
        };
        let existing = child_map(am, &marks, &provenance);
        let m = match existing.clone() {
            Some(m) => m,
            None => am
                .put_object(&marks, &provenance, ObjType::Map)
                .map_err(|e| format!("mark entry: {e}"))?,
        };
        am.put(&m, "petname", mark.petname.as_str())
            .map_err(|e| format!("petname: {e}"))?;
        am.put(&m, "icon", mark.icon.as_str())
            .map_err(|e| format!("icon: {e}"))?;
        match mark.nickname {
            Some(n) => am
                .put(&m, "nickname", n.as_str())
                .map_err(|e| format!("nickname: {e}"))?,
            None => {
                let _ = am.delete(&m, "nickname");
            }
        }
        am.put(&m, "created-at", mark.created_at as i64)
            .map_err(|e| format!("created-at: {e}"))?;
        // `needs-reconfirm` is DERIVED, not stored: it is a property of
        // the collision, which every device recomputes identically. A
        // caller round-tripping a mark therefore cannot pin the flag on
        // (or off) by accident.
        Ok(())
    })
    .await
}

pub(crate) async fn mark_forget(provenance: String) -> Result<(), String> {
    with_state(|s| s.us.my_marks.remove(&provenance))?;
    write(move |am| {
        let marks = map_at(am, MARKS).ok_or("no marks map")?;
        am.delete(&marks, provenance.as_str())
            .map_err(|e| format!("forget mark: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn mark_confirm(provenance: String) -> Result<(), String> {
    write(move |am| {
        let marks = map_at(am, MARKS).ok_or("no marks map")?;
        let m = child_map(am, &marks, &provenance).ok_or("unknown mark")?;
        let petname = get_str(am, &m, "petname").unwrap_or_default();
        // Scoped to the exact name confirmed: a later rename into a new
        // collision asks again rather than inheriting this answer.
        am.put(&m, "confirmed-for", petname.as_str())
            .map_err(|e| format!("confirm mark: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn contacts_list() -> Result<Vec<(Vec<u8>, String)>, String> {
    pump().await?;
    Ok(read_us(read_contacts)?.into_values().collect())
}

pub(crate) async fn contact_put(card: Vec<u8>, petname: String) -> Result<(), String> {
    // Keyed by a digest of the card so the same card put twice is one
    // entry on every device, with no id parsing on the write path.
    let key = hex::encode(&blake3::hash(&card).as_bytes()[..16]);
    crate::ingest_static_card(card.clone()).await?;
    with_state(|s| s.us.ingested_contacts.insert(key.clone()))?;
    write(move |am| {
        let contacts = match map_at(am, CONTACTS) {
            Some(c) => c,
            None => am
                .put_object(ROOT, CONTACTS, ObjType::Map)
                .map_err(|e| format!("contacts map: {e}"))?,
        };
        let c = match child_map(am, &contacts, &key) {
            Some(c) => c,
            None => am
                .put_object(&contacts, &key, ObjType::Map)
                .map_err(|e| format!("contact entry: {e}"))?,
        };
        am.put(&c, "card", card)
            .map_err(|e| format!("contact card: {e}"))?;
        am.put(&c, "petname", petname.as_str())
            .map_err(|e| format!("contact petname: {e}"))?;
        Ok(())
    })
    .await
}

/// Upsert the pointer under `name`, SEEDING the doc's bucket name-key
/// chain in the same breath. Names are short UTF-8 strings and are the
/// map key; ids are raw bytes stored as an automerge `Bytes` scalar, so
/// a concurrent re-publish of the same name is an ordinary
/// last-writer-wins register merge rather than a structural conflict.
///
/// THE SEED IS THE FIRST-MINT RACE'S CLOSURE (SYNC.md §1, amended). A
/// device cannot flush a doc whose pointer it has not seen — the pointer
/// is how a partition becomes known to the account at all — so seeding
/// the chain no later than the pointer makes "has the pointer" imply
/// "has the chain", and the window in which a second device could mint a
/// fork of its own closes.
///
/// THE ORDERING SHAPE: SAME CHANGE, not merely an earlier one. Both puts
/// happen inside ONE `write` closure, and `crate::author` commits a
/// closure as exactly one automerge change, carried as one encrypted
/// chunk. So a peer either applies both keys or neither — atomicity,
/// which needs no argument about how faithfully causal order is
/// preserved end to end. (An earlier SEPARATE change would also have
/// worked, by causal precedence: automerge cannot apply a change before
/// its dependencies. Atomicity is the stronger of the two and costs
/// nothing here, so it is what is implemented. It also removes the
/// question of what a reader sees if the two changes are ever split
/// across a sync boundary, because they cannot be.)
///
/// MINT-IF-ABSENT, never overwrite: a doc that already has a chain has
/// objects under it, and replacing the chain here would orphan them.
/// Re-publishing a pointer is therefore a no-op for the chain.
pub(crate) async fn partition_put(name: String, id: Vec<u8>) -> Result<(), String> {
    if name.is_empty() {
        return Err("a partition pointer needs a name".into());
    }
    if id.is_empty() {
        return Err("a partition pointer needs an id".into());
    }
    let doc_hex = hex::encode(&id);
    // Minted OUTSIDE the closure because the closure is not the place to
    // decide anything: it draws the random bytes only if the read below
    // says there is no chain yet.
    let fresh: [u8; 32] = rand::random();
    write(move |am| {
        // The chain FIRST within the change. Order inside a single
        // automerge change is not itself observable — the change is
        // atomic — but writing it first keeps the code honest about
        // which of the two is the precondition for the other.
        if read_bucket_chain(am, &doc_hex).is_none() {
            let chains = match map_at(am, BUCKET_CHAINS) {
                Some(c) => c,
                None => am
                    .put_object(ROOT, BUCKET_CHAINS, ObjType::Map)
                    .map_err(|e| format!("bucket-chains map: {e}"))?,
            };
            am.put(&chains, doc_hex.as_str(), fresh.to_vec())
                .map_err(|e| format!("seed bucket chain: {e}"))?;
        }
        let partitions = match map_at(am, PARTITIONS) {
            Some(p) => p,
            None => am
                .put_object(ROOT, PARTITIONS, ObjType::Map)
                .map_err(|e| format!("partitions map: {e}"))?,
        };
        am.put(&partitions, name.as_str(), id)
            .map_err(|e| format!("partition pointer: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn partitions_list() -> Result<Vec<UsPartition>, String> {
    pump().await?;
    Ok(read_us(read_partitions)?
        .into_iter()
        .map(|(name, id)| UsPartition { name, id })
        .collect())
}

/// Write the account's storage record through (DRIVE.md, "The account
/// syncs its storage config; devices keep their credentials").
///
/// Overwrite semantics, like `profile_set`: an account has one store.
/// The discriminant and the arm's own submap are written together, and
/// the OTHER arm's submap is left where it is — inert, since nothing
/// reads a submap the discriminant does not name (see `STORAGE`).
///
/// Going through `write` is what suppresses the local echo: it pumps,
/// authors, then re-baselines, so the writing device never drains a
/// `storage-changed` for its own bind.
pub(crate) async fn storage_put(s: UsStorage) -> Result<(), String> {
    let (provider, fields) = storage_from_wit(&s);
    write(move |am| {
        let storage = match map_at(am, STORAGE) {
            Some(s) => s,
            None => am
                .put_object(ROOT, STORAGE, ObjType::Map)
                .map_err(|e| format!("storage map: {e}"))?,
        };
        let arm = match child_map(am, &storage, provider) {
            Some(a) => a,
            None => am
                .put_object(&storage, provider, ObjType::Map)
                .map_err(|e| format!("storage {provider} map: {e}"))?,
        };
        for (key, value) in &fields {
            am.put(&arm, *key, value.as_str())
                .map_err(|e| format!("storage {provider}.{key}: {e}"))?;
        }
        // Last, so a reader that observes the discriminant observes a
        // fully-written arm behind it.
        am.put(&storage, "provider", provider)
            .map_err(|e| format!("storage provider: {e}"))?;
        Ok(())
    })
    .await
}

/// The account's storage record, or `none` on an account that never
/// bound a store (and on a document written before the key existed, and
/// on a discriminant this build does not know).
pub(crate) async fn storage_get() -> Result<Option<UsStorage>, String> {
    pump().await?;
    Ok(read_us(read_storage)?
        .as_ref()
        .and_then(storage_to_wit))
}

// --- the per-doc bucket name-key chains (SYNC.md §1) ---
//
// No WIT surface: see `BUCKET_CHAINS`. The two functions below are the
// entire interface, and `crate::bucket_chain_sync` is their only caller.

/// One doc's chain out of the document, or `None` for "no chain yet".
///
/// A register whose length is not a whole number of 32-byte epochs is
/// treated as absent rather than truncated to fit. Nothing this build
/// writes can produce one, so it means either corruption or a future
/// encoding — and inventing a chain out of either would silently publish
/// objects under names no other device derives, which is the exact
/// failure this map exists to remove. "No chain yet" is the honest read:
/// the caller mints, writes through, and the register is well-formed
/// again.
fn read_bucket_chain(am: &AutoCommit, doc_hex: &str) -> Option<Vec<[u8; 32]>> {
    let chains = map_at(am, BUCKET_CHAINS)?;
    let packed = get_bytes(am, &chains, doc_hex)?;
    if packed.is_empty() || packed.len() % 32 != 0 {
        return None;
    }
    Some(
        packed
            .chunks_exact(32)
            .map(|c| crate::arr32(c, "a chain epoch").expect("chunks_exact(32) yields 32 bytes"))
            .collect(),
    )
}

/// This account's chain for `doc`, after taking in whatever synced.
pub(crate) async fn bucket_chain_get(doc: &[u8]) -> Result<Option<Vec<[u8; 32]>>, String> {
    pump().await?;
    let doc_hex = hex::encode(doc);
    read_us(|am| read_bucket_chain(am, &doc_hex))
}

/// Publish `chain` as this doc's chain, replacing whatever is there.
///
/// Wholesale replacement is the merge story (see `BUCKET_CHAINS`), so
/// callers pass the COMPLETE chain — a rotation passes epochs 0..=n, not
/// just the new one.
pub(crate) async fn bucket_chain_put(doc: &[u8], chain: &[[u8; 32]]) -> Result<(), String> {
    if chain.is_empty() {
        return Err("a bucket chain needs at least one epoch".into());
    }
    let doc_hex = hex::encode(doc);
    let mut packed = Vec::with_capacity(chain.len() * 32);
    for nk in chain {
        packed.extend_from_slice(nk);
    }
    write(move |am| {
        let chains = match map_at(am, BUCKET_CHAINS) {
            Some(c) => c,
            None => am
                .put_object(ROOT, BUCKET_CHAINS, ObjType::Map)
                .map_err(|e| format!("bucket-chains map: {e}"))?,
        };
        // ONE put of the whole chain: the register is the unit of merge.
        am.put(&chains, doc_hex.as_str(), packed)
            .map_err(|e| format!("bucket chain: {e}"))?;
        Ok(())
    })
    .await
}

/// Whether this device has an account document at all.
///
/// The bucket paths ask before reaching for a chain: a device that has
/// not run `user-create` (or paired) yet is the bring-up ordering case
/// in SYNC.md §1, not an error.
pub(crate) fn has_account() -> Result<bool, String> {
    with_state(|s| s.us.doc.is_some())
}

pub(crate) async fn devices_list() -> Result<Vec<UsDevice>, String> {
    pump().await?;
    let devices = read_us(read_devices)?;
    let mut out = Vec::new();
    for (key, row) in devices {
        let Ok(raw) = hex::decode(&key) else { continue };
        out.push(UsDevice {
            agent_id: raw,
            name: row.name,
            enrolled_at: row.enrolled_at,
            revoked: row.revoked,
            endpoint: row.endpoint,
            enrolled_by: row.enrolled_by,
        });
    }
    out.sort_by(|a, b| {
        a.enrolled_at
            .cmp(&b.enrolled_at)
            .then_with(|| a.agent_id.cmp(&b.agent_id))
    });
    Ok(out)
}

/// Record THIS device's own endpoint id (engine.wit's
/// `us-device-endpoint-put`).
///
/// THE NO-OP IS THE CONTRACT. The host calls this on every boot, and a
/// write that authored a chunk every time would grow the one document
/// every device syncs by one change per page load per device, forever,
/// carrying nothing new. So the stored value is read and compared FIRST,
/// and an equal value returns without touching the document at all.
///
/// CONTRACT: an ABSENT entry is left absent rather than created. The
/// devices map is keyed by agent id, and two devices concurrently
/// `put_object`-ing a fresh map under the same key is an automerge
/// conflict whose loser's fields vanish — so a device whose entry has
/// not synced yet would be racing the adder's enrollment write and could
/// silently drop the name that write carried. It costs nothing to wait:
/// the adder already recorded this device's endpoint at enrollment (from
/// an id it observed on the wire), and the next boot finds the entry.
pub(crate) async fn device_endpoint_put(endpoint: Vec<u8>) -> Result<(), String> {
    if endpoint.is_empty() {
        return Err("a device endpoint must not be empty".into());
    }
    pump().await?;
    let key = hex::encode(crate::own_agent_id()?);
    let stored = read_us(|am| read_devices(am).get(&key).map(|r| r.endpoint.clone()))?;
    match stored {
        // Already ours, byte for byte: nothing to author.
        Some(ref e) if *e == endpoint => return Ok(()),
        // No entry for this device yet — see the CONTRACT note above.
        None => return Ok(()),
        Some(_) => {}
    }
    write(move |am| {
        let devices = map_at(am, DEVICES).ok_or("no devices map")?;
        let d = child_map(am, &devices, &key).ok_or("no entry for this device")?;
        am.put(&d, "endpoint", endpoint)
            .map_err(|e| format!("device endpoint: {e}"))?;
        Ok(())
    })
    .await
}

/// Rename one device's entry — the restore ceremony's last write
/// (RECOVERY.md: "the kit's label gives way to the user's word for the
/// machine it became").
///
/// CONTRACT, the same one `device_endpoint_put` states and for the same
/// reason: an ABSENT entry is REFUSED rather than created. The devices
/// map is keyed by agent id, and two devices concurrently
/// `put_object`-ing a fresh map under one key is an automerge conflict
/// whose loser's fields vanish. A restore reaching this point has
/// already pulled the account state that contains its own entry, so an
/// absent one means the pull did not land — which is worth an error, not
/// a silently half-built device record.
pub(crate) async fn device_rename(agent: &[u8], name: &str) -> Result<(), String> {
    let key = hex::encode(agent);
    let name = name.to_string();
    write(move |am| {
        let devices = map_at(am, DEVICES).ok_or("no devices map")?;
        let d = child_map(am, &devices, &key)
            .ok_or("no devices entry for this device (the account state has not arrived)")?;
        am.put(&d, "name", name.as_str())
            .map_err(|e| format!("device name: {e}"))?;
        Ok(())
    })
    .await
}

// --- the account's recovery kits (RECOVERY.md) ---------------------------

/// One row of the `recovery` map, as the document holds it.
pub(crate) struct RecoveryRow {
    /// `"bucket"` or `"file"`.
    pub(crate) kind: String,
    /// The bucket object name; empty for a file kit.
    pub(crate) name: String,
    pub(crate) created: u64,
}

fn read_recovery(am: &AutoCommit) -> Vec<(String, RecoveryRow)> {
    let Some(kits) = map_at(am, RECOVERY) else {
        // ADDITIVE: no map is an empty list, never an error.
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in am.keys(&kits) {
        let Some(k) = child_map(am, &kits, &key) else {
            continue;
        };
        out.push((
            key.to_string(),
            RecoveryRow {
                kind: get_str(am, &k, "kind").unwrap_or_default(),
                name: get_str(am, &k, "name").unwrap_or_default(),
                created: get_u64(am, &k, "created").unwrap_or(0),
            },
        ));
    }
    out
}

/// Record a freshly minted kit.
pub(crate) async fn recovery_put(
    agent: &[u8],
    kind: &str,
    name: &str,
    created: u64,
) -> Result<(), String> {
    let key = hex::encode(agent);
    let kind = kind.to_string();
    let name = name.to_string();
    write(move |am| {
        let kits = match map_at(am, RECOVERY) {
            Some(k) => k,
            None => am
                .put_object(ROOT, RECOVERY, ObjType::Map)
                .map_err(|e| format!("recovery map: {e}"))?,
        };
        let k = match child_map(am, &kits, &key) {
            Some(k) => k,
            None => am
                .put_object(&kits, &key, ObjType::Map)
                .map_err(|e| format!("recovery entry: {e}"))?,
        };
        am.put(&k, "kind", kind.as_str())
            .map_err(|e| format!("kit kind: {e}"))?;
        am.put(&k, "name", name.as_str())
            .map_err(|e| format!("kit name: {e}"))?;
        am.put(&k, "created", created as i64)
            .map_err(|e| format!("kit created: {e}"))?;
        Ok(())
    })
    .await
}

/// Every live kit, oldest first (ties broken by agent id, so two
/// devices reading the same document list them in the same order).
pub(crate) async fn recovery_list() -> Result<Vec<(Vec<u8>, RecoveryRow)>, String> {
    pump().await?;
    let mut out: Vec<(Vec<u8>, RecoveryRow)> = read_us(read_recovery)?
        .into_iter()
        .filter_map(|(key, row)| hex::decode(&key).ok().map(|raw| (raw, row)))
        .collect();
    out.sort_by(|a, b| a.1.created.cmp(&b.1.created).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// One kit's row, or `None` when the account does not name it.
pub(crate) async fn recovery_get(agent: &[u8]) -> Result<Option<RecoveryRow>, String> {
    let key = hex::encode(agent);
    Ok(recovery_list()
        .await?
        .into_iter()
        .find(|(raw, _)| hex::encode(raw) == key)
        .map(|(_, row)| row))
}

/// Forget a kit: consumed at restore, or revoked from the devices sheet.
///
/// IDEMPOTENT — a missing entry is success, which is what
/// `recovery-consume`'s retry contract requires. `delete` on an absent
/// key is a no-op in automerge, and an absent MAP is nothing to delete
/// from.
pub(crate) async fn recovery_clear(agent: &[u8]) -> Result<(), String> {
    let key = hex::encode(agent);
    write(move |am| {
        let Some(kits) = map_at(am, RECOVERY) else {
            return Ok(());
        };
        let _ = am.delete(&kits, key.as_str());
        Ok(())
    })
    .await
}

pub(crate) async fn device_revoke(agent_id: Vec<u8>) -> Result<(), String> {
    let _ = arr32(&agent_id, "agent id")?;
    let group = with_state(|s| s.us.user_group.clone())?
        .ok_or("no user group on this device")?;
    // The membership revocation is the real one: docs containing the
    // group drop CGKA leaves for individuals no longer reachable. The
    // doc entry below is the annotation the visor renders.
    crate::revoke_from_group(&group, &agent_id).await?;
    let key = hex::encode(&agent_id);
    write(move |am| {
        let devices = map_at(am, DEVICES).ok_or("no devices map")?;
        let d = child_map(am, &devices, &key).ok_or("unknown device")?;
        am.put(&d, "revoked", true)
            .map_err(|e| format!("revoke device: {e}"))?;
        Ok(())
    })
    .await
}

pub(crate) async fn events() -> Result<Vec<UsEvent>, String> {
    pump().await?;
    with_state(|s| std::mem::take(&mut s.us.events))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(provenance: &str, petname: &str, icon: &str, created_at: u64) -> MarkRaw {
        MarkRaw {
            provenance: provenance.into(),
            petname: petname.into(),
            icon: icon.into(),
            nickname: None,
            created_at,
            confirmed_for: None,
        }
    }

    #[test]
    fn older_petname_wins_and_the_loser_is_flagged() {
        let raw = vec![mark("b", "Ada", "🐝", 200), mark("a", "ada", "🐝", 100)];
        let r = repair(&raw);
        let flagged: Vec<&UsMark> = r.marks.iter().filter(|m| m.needs_reconfirm).collect();
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0].provenance, "b");
        assert!(r.repairs.contains(&("b".into(), "petname".into())));
    }

    #[test]
    fn equal_timestamps_break_ties_lexicographically() {
        let raw = vec![mark("z", "Ada", "🐝", 100), mark("a", "ada", "🐝", 100)];
        let r = repair(&raw);
        assert!(r.repairs.contains(&("z".into(), "petname".into())));
    }

    #[test]
    fn icon_loser_is_cleared_and_flagged_for_reconfirm() {
        let raw = vec![
            mark("a", "one", "🐝", 100),
            mark("b", "two", "🐝", 200),
            mark("c", "three", "🐝🐝", 300),
        ];
        let r = repair(&raw);
        // The engine cannot invent a replacement glyph (the vocabulary is
        // the visor's), so the loser's icon is cleared to "" rather than
        // reassigned — this is the deliberate #22 shape, unlike the old
        // hue-reassignment behavior.
        assert_eq!(r.icons["a"], "🐝");
        assert_eq!(r.icons["b"], "");
        assert!(r.repairs.contains(&("b".into(), "icon".into())));
        let b = r.marks.iter().find(|m| m.provenance == "b").unwrap();
        assert!(b.needs_reconfirm);
    }

    #[test]
    fn empty_icons_never_collide_with_each_other() {
        // "" means unmarked/needs-reassignment, not a shared glyph: two
        // unmarked marks must not repair each other.
        let raw = vec![mark("a", "one", "", 100), mark("b", "two", "", 200)];
        let r = repair(&raw);
        assert!(!r.repairs.contains(&("b".into(), "icon".into())));
    }

    #[test]
    fn repair_is_order_independent() {
        let a = vec![mark("a", "same", "🐝", 100), mark("b", "same", "🐝", 200)];
        let b = vec![mark("b", "same", "🐝", 200), mark("a", "same", "🐝", 100)];
        let ra = repair(&a);
        let rb = repair(&b);
        assert_eq!(ra.repairs, rb.repairs);
        assert_eq!(ra.icons, rb.icons);
    }

    #[test]
    fn confirming_the_exact_name_clears_the_flag() {
        let mut raw = vec![mark("a", "same", "🐝", 100), mark("b", "same", "🐦", 200)];
        raw[1].confirmed_for = Some("same".into());
        let r = repair(&raw);
        assert!(r.marks.iter().all(|m| !m.needs_reconfirm));
        // The collision is still recorded, so a NEW collision later is
        // still edge-detectable.
        assert!(r.repairs.contains(&("b".into(), "petname".into())));
    }
}
