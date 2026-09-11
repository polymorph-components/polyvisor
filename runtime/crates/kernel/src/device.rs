//! Device identity and the index row: what a device *is*, split into the part
//! that may be read before any seal opens (the index row, in `kv`) and the
//! part that may not (the record, in the encrypted checkpoint).

use serde::{Deserialize, Serialize};

use std::collections::BTreeMap;

use crate::{Error, ErrorCode};

/// `polyvisor:internal/device.state`, plus the terminal state an erased
/// device sits in. `Erased` has no WIT spelling on purpose: after `erase`
/// there is no device left to describe, so every export answers
/// `unavailable` (see `Kernel::not_erased`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Fresh,
    Sealed,
    Open,
    Erased,
}

/// `polyvisor:internal/device.tier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Ephemeral,
    Durable,
}

/// `polyvisor:internal/device.rest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Rest {
    RestsOpen,
    Passphrase,
}

/// `polyvisor:internal/device.device-status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceStatus {
    pub id: String,
    pub state: State,
    pub tier: Tier,
    pub rest: Rest,
    pub petname: String,
    pub name: String,
    pub hue: u16,
    /// This device's iroh endpoint id; `""` while sealed and until the
    /// endpoint is bound.
    pub endpoint_id: String,
}

/// `polyvisor:internal/store.entry` — the one unsealed record (docs/design.md
/// "Devices"). Lives in `kv` under `index/<id>`; carries nothing personal
/// beyond the petname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexRow {
    pub id: String,
    pub petname: String,
    pub tier: Tier,
    pub rest: Rest,
    /// Epoch milliseconds.
    pub created: u64,
    /// Epoch milliseconds. The lease: refreshed at boot and on every
    /// checkpoint, and read by the sweep (`crate::store::sweep`).
    pub last_used: u64,
}

impl IndexRow {
    /// A fresh device: ephemeral, resting open, unnamed.
    pub fn fresh(id: &str, now: u64) -> IndexRow {
        IndexRow {
            id: id.to_string(),
            petname: String::new(),
            tier: Tier::Ephemeral,
            rest: Rest::RestsOpen,
            created: now,
            last_used: now,
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<IndexRow, Error> {
        serde_json::from_slice(bytes).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("a device index row could not be read: {e}"),
            )
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(self).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the device index row could not be written: {e}"),
            )
        })
    }
}

/// Device-local state plus an in-memory cache of the shared visor document.
/// The cache fields are skipped by serde: the sealed engine snapshot is their
/// sole durable source and refreshes them before the component returns status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    #[serde(skip)]
    pub hue: u16,
    #[serde(skip)]
    pub meta: Meta,
}

/// One map per `MetaScope`; see internal.wit `meta-scope`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Meta {
    pub user: BTreeMap<String, String>,
    pub app: BTreeMap<String, BTreeMap<String, String>>,
}

/// Which map `meta`/`patch_meta` addresses.
#[derive(Clone)]
pub enum MetaScope {
    User,
    App(String),
}

impl Device {
    /// A fresh device's identity.
    ///
    /// Drawn from the RNG, not derived from the id: the id is public (it
    /// names the SharedWorker and sits in every index row), and internal.wit
    /// `device` says nothing personal is readable before unseal. A hue and a
    /// petname that is a pure function of the id would be readable by anyone
    /// who knows the id. Because it is drawn rather than derived, the identity has to
    /// be checkpointed at once — see `Kernel::boot`'s mint path.
    pub fn mint(rng: &dyn crate::Rng) -> Device {
        Device {
            name: generate_petname(rng, ""),
            hue: (draw(rng) % 360) as u16,
            meta: Meta {
                user: BTreeMap::from([("petname".into(), generate_petname(rng, ""))]),
                app: BTreeMap::new(),
            },
        }
    }
}

/// A candidate petname distinct from `previous`. Generation has no storage
/// side effect; callers decide whether a candidate is a draft or persisted.
pub fn generate_petname(rng: &dyn crate::Rng, previous: &str) -> String {
    polyvisor_petname::generate(|| draw(rng), previous)
}

fn draw(rng: &dyn crate::Rng) -> u32 {
    let mut bytes = [0u8; 4];
    rng.fill(&mut bytes);
    u32::from_le_bytes(bytes)
}
