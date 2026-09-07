//! Device identity and the index row: what a device *is*, split into the part
//! that may be read before any seal opens (the index row, in `kv`) and the
//! part that may not (the record, in the encrypted checkpoint).

use serde::{Deserialize, Serialize};

use std::sync::LazyLock;

use crate::{Error, ErrorCode};

/// Bumped when a stored shape changes; a record from the future is an error
/// rather than a silent partial read.
pub const SCHEMA: u32 = 2;

const WORDS: &str = include_str!("../eff_short_wordlist.txt");

/// `polyvisor:internal/device.state`, plus the terminal state an erased
/// device sits in. `Erased` has no WIT spelling on purpose: after `erase`
/// there is no device left to describe, so every export answers
/// `unavailable` (see `Kernel::live`).
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
    pub word: String,
}

/// `polyvisor:internal/store.entry` — the one unsealed record (docs/design.md
/// "Devices"). Lives in `kv` under `index/<id>`; carries nothing personal
/// beyond the petname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexRow {
    v: u32,
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
            v: SCHEMA,
            id: id.to_string(),
            petname: String::new(),
            tier: Tier::Ephemeral,
            rest: Rest::RestsOpen,
            created: now,
            last_used: now,
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<IndexRow, Error> {
        let row: IndexRow = serde_json::from_slice(bytes).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("a device index row could not be read: {e}"),
            )
        })?;
        if row.v != SCHEMA {
            return Err(Error::new(
                ErrorCode::Failed,
                format!(
                    "a device index row is version {}; this runtime speaks {SCHEMA}",
                    row.v
                ),
            ));
        }
        Ok(row)
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

/// The personal half: name, hue, anchor word. Never in `kv` — it rides in the
/// encrypted checkpoint (docs/design.md "Devices": the index carries "never
/// the name, hue, word or any key").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    pub hue: u16,
    pub word: String,
}

impl Device {
    /// A fresh device's anchor, derived from the id the glue minted.
    ///
    /// CONTRACT: the dispatch says "mint id-derived state as M1 (hue, word,
    /// name \"\")". M1 drew both from `wasi:random`; there was no id to derive
    /// from, because M1 minted the id itself. Deriving from the id is the
    /// reading that makes the adjective true and costs nothing: the id is 16
    /// random bytes from the glue, so a hue/word derived from it is exactly as
    /// unpredictable, and a device's anchor is then reproducible from its id
    /// alone. Domain-separated so the two draws are independent.
    pub fn mint(id: &str) -> Device {
        Device {
            name: String::new(),
            hue: (draw(id, "hue") % 360) as u16,
            word: word_at(draw(id, "word")),
        }
    }

    /// A word other than the current one: rerolling to the same word would
    /// read as a broken button.
    pub fn reroll(&self, rng: &dyn crate::Rng) -> String {
        loop {
            let mut bytes = [0u8; 4];
            rng.fill(&mut bytes);
            let word = word_at(u32::from_le_bytes(bytes));
            if word != self.word {
                return word;
            }
        }
    }
}

/// The wordlist, split once: `reroll` calls this in a loop.
static WORD_LIST: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| WORDS.lines().filter(|w| !w.is_empty()).collect());

fn word_at(draw: u32) -> String {
    WORD_LIST[draw as usize % WORD_LIST.len()].to_string()
}

fn draw(id: &str, domain: &str) -> u32 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new()
        .chain_update(domain.as_bytes())
        .chain_update(b":")
        .chain_update(id.as_bytes())
        .finalize();
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}
