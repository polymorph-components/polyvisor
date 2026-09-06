//! Device identity: minted once on first boot, then read back from kv.

use serde::{Deserialize, Serialize};

use std::cell::RefCell;
use std::sync::LazyLock;

use crate::{Error, ErrorCode, Platform, Rng};

/// The single kv key the device record lives under.
pub const KV_KEY: &str = "device";

/// Bumped when the record's shape changes; a record from the future is an
/// error rather than a silent partial read.
const SCHEMA: u32 = 1;

const WORDS: &str = include_str!("../eff_short_wordlist.txt");

/// `polyvisor:internal/device.device-status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub hue: u16,
    pub word: String,
}

#[derive(Serialize, Deserialize)]
pub struct Device {
    v: u32,
    pub id: String,
    pub name: String,
    pub hue: u16,
    pub word: String,
}

impl Device {
    pub async fn load_or_mint(platform: &dyn Platform, rng: &dyn Rng) -> Result<Device, Error> {
        if let Some(bytes) = platform.get(KV_KEY.to_string()).await {
            let device: Device = serde_json::from_slice(&bytes).map_err(|e| {
                Error::new(
                    ErrorCode::Failed,
                    format!("the stored device record could not be read: {e}"),
                )
            })?;
            if device.v != SCHEMA {
                return Err(Error::new(
                    ErrorCode::Failed,
                    format!(
                        "the stored device record is version {}; this runtime speaks {SCHEMA}",
                        device.v
                    ),
                ));
            }
            return Ok(device);
        }
        let device = Device {
            v: SCHEMA,
            id: mint_id(rng),
            name: String::new(),
            hue: (draw(rng) % 360) as u16,
            word: word_at(draw(rng)),
        };
        platform.set(KV_KEY.to_string(), device.encode()?).await;
        Ok(device)
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(self).map_err(|e| {
            Error::new(
                ErrorCode::Failed,
                format!("the device record could not be written: {e}"),
            )
        })
    }

    pub fn status(&self) -> DeviceStatus {
        DeviceStatus {
            id: self.id.clone(),
            name: self.name.clone(),
            hue: self.hue,
            word: self.word.clone(),
        }
    }
}

/// A word other than the current one: rerolling to the same word would read
/// as a broken button.
pub fn reroll(device: &RefCell<Device>, rng: &dyn Rng) -> String {
    let current = device.borrow().word.clone();
    loop {
        let word = word_at(draw(rng));
        if word != current {
            return word;
        }
    }
}

/// The wordlist, split once: `reroll` calls this in a loop.
static WORD_LIST: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| WORDS.lines().filter(|w| !w.is_empty()).collect());

fn word_at(draw: u32) -> String {
    WORD_LIST[draw as usize % WORD_LIST.len()].to_string()
}

fn draw(rng: &dyn Rng) -> u32 {
    let mut bytes = [0u8; 4];
    rng.fill(&mut bytes);
    u32::from_le_bytes(bytes)
}

fn mint_id(rng: &dyn Rng) -> String {
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
