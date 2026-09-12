//! Contacts and introduction wire model over synchronized Automerge history.
//!
//! Unsigned contact files are a JSON array of objects shaped as
//! `{ "public_key": "<optional lowercase 32-byte hex>", "claims":
//! [{"name":"...", "value":"..."}] }`. Their labels and claims are local
//! import assertions; they cannot supply authenticated issuer or claimed time.

use std::collections::BTreeSet;

use automerge::{ROOT, ReadDoc, transaction::Transactable};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use polyvisor_document_history::Document;
use prost::Message;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/polyvisor.introduction.v0.rs"));
}

const DOMAIN: &[u8] = b"polyvisor:introduction:v0\0";
const MIN_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
const MAX_TIMESTAMP_SECONDS: i64 = 253_402_300_799;
pub const MAX_SIGNED_BYTES: usize = 256 * 1024;
pub const MAX_PARTIES: usize = 64;
pub const MAX_CLAIMS_PER_PARTY: usize = 128;
pub const MAX_NAME_BYTES: usize = 256;
pub const MAX_VALUE_BYTES: usize = 4096;
const IDENTITY: &str = "identity:seed";
const ALIAS_PREFIX: &str = "alias:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimedTime {
    pub seconds: i64,
    pub nanos: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Local,
    Imported,
    Verified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Party {
    pub public_key: [u8; 32],
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Introduction {
    pub issuer: Party,
    pub parties: Vec<Party>,
    pub issued_at: ClaimedTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewParty {
    pub index: u32,
    pub public_key: Option<[u8; 32]>,
    pub issuer: Option<[u8; 32]>,
    pub claimed: Option<ClaimedTime>,
    pub provenance: Provenance,
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReview {
    pub signed: bool,
    pub parties: Vec<ReviewParty>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub name: String,
    pub value: String,
    pub provenance: Provenance,
    pub issuer: Option<[u8; 32]>,
    pub claimed: Option<ClaimedTime>,
    pub received: u64,
    pub meeting: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    pub id: String,
    pub public_key: Option<[u8; 32]>,
    pub petname: String,
    pub glyph: String,
    pub observations: Vec<Observation>,
    pub preferred: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfProfile {
    pub public_key: [u8; 32],
    pub observations: Vec<Observation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingRecord {
    pub id: String,
    pub method: String,
    pub source: String,
    pub source_key: Option<[u8; 32]>,
    pub occurred: u64,
    pub verified: bool,
}

/// Selected, already-reviewed model values. This type deliberately has no raw
/// envelope, payload, signature, or generic byte field, making those artifacts
/// structurally unavailable to the persistence API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedObservation {
    pub contact_id: String,
    pub observation: Observation,
}

pub fn sign(introduction: &Introduction, signer: &SigningKey) -> Result<Vec<u8>, String> {
    validate(introduction)?;
    if introduction.issuer.public_key != signer.verifying_key().to_bytes() {
        return Err("the introduction issuer is not this contact identity".into());
    }
    let message = protobuf_introduction(introduction);
    let payload_len = message.encoded_len();
    if signed_envelope_len(payload_len, 64) > MAX_SIGNED_BYTES {
        return Err("that introduction is too large".into());
    }
    let payload = message.encode_to_vec();
    let signature = signer.sign(&signing_message(&payload)).to_bytes().to_vec();
    Ok(proto::SignedIntroduction {
        introduction: payload,
        signature,
    }
    .encode_to_vec())
}

pub fn verify(bytes: &[u8]) -> Result<Introduction, String> {
    if bytes.len() > MAX_SIGNED_BYTES {
        return Err("that introduction is too large".into());
    }
    let signed = proto::SignedIntroduction::decode(bytes)
        .map_err(|_| "that introduction is not valid protobuf".to_string())?;
    if signed_envelope_len(signed.introduction.len(), signed.signature.len()) > MAX_SIGNED_BYTES {
        return Err("that introduction is too large".into());
    }
    let decoded = proto::Introduction::decode(signed.introduction.as_slice())
        .map_err(|_| "that introduction payload is not valid protobuf".to_string())?;
    let introduction = extract(decoded)?;
    validate(&introduction)?;
    let signature = Signature::from_slice(&signed.signature)
        .map_err(|_| "that introduction has an invalid signature".to_string())?;
    let key = VerifyingKey::from_bytes(&introduction.issuer.public_key)
        .map_err(|_| "that introduction has an invalid issuer key".to_string())?;
    key.verify_strict(&signing_message(&signed.introduction), &signature)
        .map_err(|_| "that introduction signature does not verify".to_string())?;
    Ok(introduction)
}

pub fn parse_import(bytes: &[u8]) -> Result<ImportReview, String> {
    if let Ok(intro) = verify(bytes) {
        let issuer = intro.issuer.public_key;
        let claimed = intro.issued_at;
        let parties = std::iter::once(intro.issuer)
            .chain(intro.parties)
            .enumerate()
            .map(|(index, p)| ReviewParty {
                index: index as u32,
                public_key: Some(p.public_key),
                issuer: Some(issuer),
                claimed: Some(claimed),
                provenance: Provenance::Verified,
                claims: p.claims,
            })
            .collect();
        return Ok(ImportReview {
            signed: true,
            parties,
            summary: "Signature verified; review the asserted contact details".into(),
        });
    }
    parse_unsigned_json(bytes)
}

fn signing_message(payload: &[u8]) -> Vec<u8> {
    [DOMAIN, payload].concat()
}

#[cfg(test)]
fn encode_introduction(value: &Introduction) -> Vec<u8> {
    protobuf_introduction(value).encode_to_vec()
}

fn protobuf_introduction(value: &Introduction) -> proto::Introduction {
    proto::Introduction {
        issuer: Some(encode_party(&value.issuer)),
        parties: value.parties.iter().map(encode_party).collect(),
        issued_at: Some(prost_types::Timestamp {
            seconds: value.issued_at.seconds,
            nanos: value.issued_at.nanos as i32,
        }),
    }
}

fn signed_envelope_len(payload_len: usize, signature_len: usize) -> usize {
    let payload_field = if payload_len == 0 {
        0
    } else {
        1 + prost::length_delimiter_len(payload_len) + payload_len
    };
    let signature_field = if signature_len == 0 {
        0
    } else {
        1 + prost::length_delimiter_len(signature_len) + signature_len
    };
    payload_field + signature_field
}
fn encode_party(p: &Party) -> proto::Party {
    proto::Party {
        public_key: p.public_key.to_vec(),
        claims: p
            .claims
            .iter()
            .map(|c| proto::Claim {
                name: c.name.clone(),
                value: c.value.clone(),
            })
            .collect(),
    }
}
fn extract(value: proto::Introduction) -> Result<Introduction, String> {
    let issuer = value
        .issuer
        .ok_or_else(|| "that introduction has no issuer".to_string())?;
    let time = value
        .issued_at
        .ok_or_else(|| "that introduction has no issued time".to_string())?;
    if !(MIN_TIMESTAMP_SECONDS..=MAX_TIMESTAMP_SECONDS).contains(&time.seconds)
        || !(0..1_000_000_000).contains(&time.nanos)
    {
        return Err("that introduction has an invalid issued time".into());
    }
    Ok(Introduction {
        issuer: extract_party(issuer)?,
        parties: value
            .parties
            .into_iter()
            .map(extract_party)
            .collect::<Result<_, _>>()?,
        issued_at: ClaimedTime {
            seconds: time.seconds,
            nanos: time.nanos as u32,
        },
    })
}
fn extract_party(p: proto::Party) -> Result<Party, String> {
    let public_key = p
        .public_key
        .try_into()
        .map_err(|_| "that introduction has a key of the wrong length".to_string())?;
    Ok(Party {
        public_key,
        claims: p
            .claims
            .into_iter()
            .map(|c| Claim {
                name: c.name,
                value: c.value,
            })
            .collect(),
    })
}
fn validate(value: &Introduction) -> Result<(), String> {
    if value.parties.len() + 1 > MAX_PARTIES {
        return Err("that introduction has too many parties".into());
    }
    if !(MIN_TIMESTAMP_SECONDS..=MAX_TIMESTAMP_SECONDS).contains(&value.issued_at.seconds)
        || value.issued_at.nanos >= 1_000_000_000
    {
        return Err("that introduction has an invalid issued time".into());
    }
    let mut keys = BTreeSet::new();
    for party in std::iter::once(&value.issuer).chain(&value.parties) {
        let key = VerifyingKey::from_bytes(&party.public_key)
            .map_err(|_| "that introduction has an invalid public key".to_string())?;
        if key.is_weak() {
            return Err("that introduction has a weak public key".into());
        }
        if !keys.insert(party.public_key) {
            return Err("that introduction repeats a public key".into());
        }
        if party.claims.len() > MAX_CLAIMS_PER_PARTY {
            return Err("that introduction has too many claims".into());
        }
        for claim in &party.claims {
            if claim.name.len() > MAX_NAME_BYTES {
                return Err("that introduction has a claim name that is too long".into());
            }
            if claim.value.len() > MAX_VALUE_BYTES {
                return Err("that introduction has a claim value that is too long".into());
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonParty {
    public_key: Option<String>,
    claims: Vec<JsonClaim>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonClaim {
    name: String,
    value: String,
}
fn parse_unsigned_json(bytes: &[u8]) -> Result<ImportReview, String> {
    if bytes.len() > MAX_SIGNED_BYTES {
        return Err("that contact file is too large".into());
    }
    let rows: Vec<JsonParty> = serde_json::from_slice(bytes).map_err(|_| {
        "that contact file is neither a signed introduction nor valid contact JSON".to_string()
    })?;
    if rows.len() > MAX_PARTIES {
        return Err("that contact file has too many contacts".into());
    }
    let mut parties = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        if row.claims.len() > MAX_CLAIMS_PER_PARTY {
            return Err("that contact file has too many claims".into());
        }
        let public_key = row
            .public_key
            .map(|s| decode_key(&s).and_then(valid_contact_key))
            .transpose()?;
        let claims = row
            .claims
            .into_iter()
            .map(|c| {
                if c.name.len() > MAX_NAME_BYTES || c.value.len() > MAX_VALUE_BYTES {
                    Err("that contact file has an oversized claim".to_string())
                } else {
                    Ok(Claim {
                        name: c.name,
                        value: c.value,
                    })
                }
            })
            .collect::<Result<_, _>>()?;
        parties.push(ReviewParty {
            index: index as u32,
            public_key,
            issuer: None,
            claimed: None,
            provenance: Provenance::Imported,
            claims,
        });
    }
    Ok(ImportReview {
        signed: false,
        parties,
        summary: "Unsigned contact file; review these locally supplied details".into(),
    })
}

pub fn identity_seed(doc: &Document) -> Option<[u8; 32]> {
    root_string(doc, IDENTITY).and_then(|s| decode_key(&s).ok())
}
pub fn identity_public_key(doc: &Document) -> Option<[u8; 32]> {
    identity_seed(doc).map(|s| SigningKey::from_bytes(&s).verifying_key().to_bytes())
}
pub fn identity_or_create(
    doc: &mut Document,
    device_seed: [u8; 32],
    entropy: [u8; 32],
) -> Result<([u8; 32], bool), String> {
    if let Some(seed) = identity_seed(doc) {
        return Ok((seed, false));
    }
    let seed = digest(b"polyvisor:contact-identity:", &[&device_seed, &entropy]);
    let encoded = hex(&seed);
    doc.transact(move |tx| tx.put(ROOT, IDENTITY, encoded).map_err(|e| e.to_string()))?;
    Ok((seed, true))
}
pub fn adopt(current: &mut Document, source: &Document) -> Result<(), String> {
    let seed = identity_seed(source)
        .ok_or_else(|| "that contacts document has no identity".to_string())?;
    let source_profile = observations(source, "self");
    current.merge_snapshot(&source.save())?;
    let encoded = hex(&seed);
    let old_profile_keys: Vec<_> = current
        .read()
        .keys(ROOT)
        .filter(|key| key.starts_with("observation:self:"))
        .collect();
    current.transact(move |tx| {
        tx.put(ROOT, IDENTITY, encoded).map_err(|e| e.to_string())?;
        for key in old_profile_keys {
            tx.delete(ROOT, key).map_err(|e| e.to_string())?;
        }
        for observation in source_profile {
            let prefix = format!(
                "observation:self:{}:",
                observation_discriminator(&observation)
            );
            for (field, value) in observation_fields(observation) {
                tx.put(ROOT, format!("{prefix}{field}"), value)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}

pub fn keyed_contact_id(public_key: [u8; 32]) -> String {
    hex(&digest(b"polyvisor:contact:", &[&public_key])[..16])
}
pub fn create_contact(
    doc: &mut Document,
    public_key: Option<[u8; 32]>,
    petname: String,
    glyph: String,
    entropy: [u8; 32],
) -> Result<String, String> {
    if let Some(key) = public_key {
        valid_contact_key(key)?;
    }
    let id = public_key.map(keyed_contact_id).unwrap_or_else(|| {
        hex(&digest(b"polyvisor:keyless-contact:", &[&entropy, doc.actor_id()])[..16])
    });
    let existed = contact(doc, &id).is_some();
    let marker = contact_key(&id, "exists");
    let pet = contact_key(&id, "petname");
    let glyph_key = contact_key(&id, "glyph");
    let key = contact_key(&id, "public-key");
    doc.transact(|tx| {
        tx.put(ROOT, marker, true).map_err(|e| e.to_string())?;
        if !existed && !petname.is_empty() {
            tx.put(ROOT, pet, petname).map_err(|e| e.to_string())?;
        }
        if !existed && !glyph.is_empty() {
            tx.put(ROOT, glyph_key, glyph).map_err(|e| e.to_string())?;
        }
        if let Some(k) = public_key {
            tx.put(ROOT, key, hex(&k)).map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    Ok(id)
}
pub fn set_label(
    doc: &mut Document,
    id: &str,
    petname: String,
    glyph: String,
) -> Result<(), String> {
    require_contact(doc, id)?;
    let petname_key = contact_key(id, "petname");
    let glyph_key = contact_key(id, "glyph");
    doc.transact(move |tx| {
        tx.put(ROOT, petname_key, petname)
            .map_err(|e| e.to_string())?;
        tx.put(ROOT, glyph_key, glyph).map_err(|e| e.to_string())
    })
}
pub fn create_meeting(
    doc: &mut Document,
    method: String,
    source: String,
    source_key: Option<[u8; 32]>,
    occurred: u64,
    verified: bool,
    entropy: [u8; 32],
) -> Result<String, String> {
    let id = hex(&digest(
        b"polyvisor:meeting:",
        &[&entropy, doc.actor_id(), &occurred.to_be_bytes()],
    )[..16]);
    let fields = [
        ("method", method),
        ("source", source),
        (
            "source-key",
            source_key.map(|k| hex(&k)).unwrap_or_default(),
        ),
        ("occurred", occurred.to_string()),
        ("verified", verified.to_string()),
    ];
    doc.transact(|tx| {
        for (field, value) in fields {
            tx.put(ROOT, meeting_key(&id, field), value)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    Ok(id)
}
pub fn write_extracted(doc: &mut Document, rows: Vec<ExtractedObservation>) -> Result<(), String> {
    for row in &rows {
        require_contact(doc, &row.contact_id)?;
        let Some(record) = meeting(doc, &row.observation.meeting) else {
            return Err("that observation has no provenance record".into());
        };
        match row.observation.provenance {
            Provenance::Verified
                if row.observation.issuer.is_some()
                    && row.observation.claimed.is_some()
                    && record.verified
                    && record.source_key == row.observation.issuer => {}
            Provenance::Verified => {
                return Err("a verified observation needs matching verified provenance".into());
            }
            Provenance::Local | Provenance::Imported
                if row.observation.issuer.is_none() && row.observation.claimed.is_none() => {}
            Provenance::Local | Provenance::Imported => {
                return Err("a local observation cannot claim a remote signature".into());
            }
        }
    }
    doc.transact(move |tx| {
        for row in rows {
            let discr = observation_discriminator(&row.observation);
            let prefix = format!("observation:{}:{discr}:", row.contact_id);
            for (field, value) in observation_fields(row.observation) {
                tx.put(ROOT, format!("{prefix}{field}"), value)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}
pub fn remove_observation(
    doc: &mut Document,
    id: &str,
    name: &str,
    value: &str,
) -> Result<(), String> {
    remove_observations_at(doc, id, name, value, true)
}

fn remove_observations_at(
    doc: &mut Document,
    id: &str,
    name: &str,
    value: &str,
    clear_preference: bool,
) -> Result<(), String> {
    let sources = if id == "self" {
        vec![id.to_string()]
    } else {
        observation_sources(doc, id)
    };
    let prefixes: BTreeSet<String> = sources
        .iter()
        .flat_map(|source| direct_observation_prefixes(doc, source))
        .filter(|p| {
            root_string(doc, &format!("{p}name")).as_deref() == Some(name)
                && root_string(doc, &format!("{p}value")).as_deref() == Some(value)
        })
        .collect();
    let preferred_keys: Vec<_> = sources
        .iter()
        .map(|source| format!("preferred:{source}:{}", hex(name.as_bytes())))
        .filter(|key| clear_preference && root_string(doc, key).as_deref() == Some(value))
        .collect();
    doc.transact(|tx| {
        for prefix in prefixes {
            for field in OBS_FIELDS {
                tx.delete(ROOT, format!("{prefix}{field}"))
                    .map_err(|e| e.to_string())?;
            }
        }
        for preferred_key in preferred_keys {
            tx.delete(ROOT, preferred_key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}
pub fn set_preferred(
    doc: &mut Document,
    id: &str,
    name: &str,
    value: Option<String>,
) -> Result<(), String> {
    require_contact(doc, id)?;
    if let Some(ref wanted) = value
        && !observations(doc, id)
            .iter()
            .any(|o| o.name == name && &o.value == wanted)
    {
        return Err("that preferred value is not an observation".into());
    }
    let field = hex(name.as_bytes());
    let key = format!("preferred:{id}:{field}");
    match value {
        Some(value) => doc.transact(move |tx| tx.put(ROOT, key, value).map_err(|e| e.to_string())),
        None => {
            let keys: Vec<_> = observation_sources(doc, id)
                .into_iter()
                .map(|source| format!("preferred:{source}:{field}"))
                .filter(|key| root_string(doc, key).is_some())
                .collect();
            doc.transact(move |tx| {
                for key in keys {
                    tx.delete(ROOT, key).map_err(|e| e.to_string())?;
                }
                Ok(())
            })
        }
    }
}
pub fn contacts(doc: &Document) -> Vec<Contact> {
    let mut ids = BTreeSet::new();
    for k in doc.read().keys(ROOT) {
        if let Some(rest) = k.strip_prefix("contact:")
            && let Some((id, "exists")) = rest.split_once(':')
        {
            ids.insert(id.to_string());
        }
    }
    ids.into_iter().filter_map(|id| contact(doc, &id)).collect()
}
pub fn contact(doc: &Document, id: &str) -> Option<Contact> {
    if root_bool(doc, &contact_key(id, "exists")) != Some(true) {
        return None;
    }
    let public_key =
        root_string(doc, &contact_key(id, "public-key")).and_then(|s| decode_key(&s).ok());
    let petname = root_string(doc, &contact_key(id, "petname")).unwrap_or_default();
    let glyph = root_string(doc, &contact_key(id, "glyph")).unwrap_or_default();
    Some(Contact {
        id: id.into(),
        public_key,
        petname,
        glyph,
        observations: observations(doc, id),
        preferred: preferred_values(doc, id),
    })
}
pub fn meetings(doc: &Document) -> Vec<MeetingRecord> {
    let mut ids = BTreeSet::new();
    for k in doc.read().keys(ROOT) {
        if let Some(rest) = k.strip_prefix("meeting:")
            && let Some((id, _)) = rest.split_once(':')
        {
            ids.insert(id.to_string());
        }
    }
    let mut out: Vec<_> = ids.into_iter().filter_map(|id| meeting(doc, &id)).collect();
    out.sort_by(|a, b| b.occurred.cmp(&a.occurred).then_with(|| a.id.cmp(&b.id)));
    out
}
pub fn meeting_record(doc: &Document, id: &str) -> Option<MeetingRecord> {
    meeting(doc, id)
}
pub fn delete_contact(doc: &mut Document, id: &str) -> Result<(), String> {
    require_contact(doc, id)?;
    let sources = observation_sources(doc, id);
    let contact_prefix = format!("contact:{id}:");
    let keys: Vec<_> = doc
        .read()
        .keys(ROOT)
        .filter(|key| {
            key.starts_with(&contact_prefix)
                || sources.iter().any(|source| {
                    key.starts_with(&format!("observation:{source}:"))
                        || key.starts_with(&format!("preferred:{source}:"))
                        || key == &format!("{ALIAS_PREFIX}{source}")
                })
        })
        .collect();
    doc.transact(|tx| {
        for key in keys {
            tx.delete(ROOT, key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}
pub fn self_profile(doc: &Document) -> Option<SelfProfile> {
    let public_key = identity_public_key(doc)?;
    Some(SelfProfile {
        public_key,
        observations: observations(doc, "self"),
    })
}
/// Self-profile claims belong to the adopted signing identity. [`adopt`]
/// replaces the joiner's self observations with the established document's
/// observations rather than combining claims belonging to different keys.
pub fn write_self_observation(doc: &mut Document, observation: Observation) -> Result<(), String> {
    if identity_seed(doc).is_none() {
        return Err("this contacts document has no identity".into());
    }
    if observation.provenance != Provenance::Local
        || observation.issuer.is_some()
        || observation.claimed.is_some()
    {
        return Err("a self-profile edit must be a local observation".into());
    }
    if observation.meeting.is_empty() || !meeting_exists(doc, &observation.meeting) {
        return Err("that observation has no provenance record".into());
    }
    let discr = observation_discriminator(&observation);
    let prefix = format!("observation:self:{discr}:");
    doc.transact(move |tx| {
        for (field, value) in observation_fields(observation) {
            tx.put(ROOT, format!("{prefix}{field}"), value)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}
pub fn remove_self_observation(doc: &mut Document, name: &str, value: &str) -> Result<(), String> {
    remove_observations_at(doc, "self", name, value, false)
}
pub fn merge(doc: &mut Document, keyless: &str, into: &str) -> Result<(), String> {
    let from = contact(doc, keyless).ok_or_else(|| "no such keyless contact".to_string())?;
    let target = contact(doc, into).ok_or_else(|| "no such keyed contact".to_string())?;
    if from.public_key.is_some() || target.public_key.is_none() {
        return Err("contacts can only merge from keyless into keyed".into());
    }
    let source_petname = from.petname.clone();
    let source_glyph = from.glyph.clone();
    let alias = format!("{ALIAS_PREFIX}{keyless}");
    let destination = into.to_string();
    doc.transact(|tx| tx.put(ROOT, alias, destination).map_err(|e| e.to_string()))?;
    let label_changed = (target.petname.is_empty() && !source_petname.is_empty())
        || (target.glyph.is_empty() && !source_glyph.is_empty());
    let petname = if target.petname.is_empty() {
        source_petname
    } else {
        target.petname
    };
    let glyph = if target.glyph.is_empty() {
        source_glyph
    } else {
        target.glyph
    };
    if label_changed {
        set_label(doc, into, petname, glyph)?;
    }
    let keys: Vec<_> = doc
        .read()
        .keys(ROOT)
        .filter(|k| k.starts_with(&format!("contact:{keyless}:")))
        .collect();
    doc.transact(|tx| {
        for key in keys {
            tx.delete(ROOT, key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

const OBS_FIELDS: [&str; 9] = [
    "name",
    "value",
    "provenance",
    "issuer",
    "claimed-seconds",
    "claimed-nanos",
    "received",
    "meeting",
    "present",
];
fn observation_fields(o: Observation) -> [(&'static str, String); 9] {
    [
        ("name", o.name),
        ("value", o.value),
        ("provenance", format!("{:?}", o.provenance)),
        ("issuer", o.issuer.map(|k| hex(&k)).unwrap_or_default()),
        (
            "claimed-seconds",
            o.claimed.map(|t| t.seconds.to_string()).unwrap_or_default(),
        ),
        (
            "claimed-nanos",
            o.claimed.map(|t| t.nanos.to_string()).unwrap_or_default(),
        ),
        ("received", o.received.to_string()),
        ("meeting", o.meeting),
        ("present", "true".into()),
    ]
}
fn observation_discriminator(o: &Observation) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"polyvisor:observation:");
    let issuer = o.issuer.as_ref().map(<[u8; 32]>::as_slice).unwrap_or(&[]);
    for field in [
        issuer,
        o.name.as_bytes(),
        o.value.as_bytes(),
        o.meeting.as_bytes(),
    ] {
        hasher.update((field.len() as u64).to_le_bytes());
        hasher.update(field);
    }
    hex(&hasher.finalize()[..16])
}
fn direct_observation_prefixes(doc: &Document, id: &str) -> BTreeSet<String> {
    let start = format!("observation:{id}:");
    doc.read()
        .keys(ROOT)
        .filter_map(|k| {
            let rest = k.strip_prefix(&start)?;
            let (disc, _) = rest.split_once(':')?;
            Some(format!("{start}{disc}:"))
        })
        .collect()
}
fn observations(doc: &Document, id: &str) -> Vec<Observation> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for source in observation_sources(doc, id) {
        for p in direct_observation_prefixes(doc, &source) {
            let Some(discriminator) = p
                .strip_prefix(&format!("observation:{source}:"))
                .and_then(|rest| rest.strip_suffix(':'))
            else {
                continue;
            };
            if !seen.insert(discriminator.to_string()) {
                continue;
            }
            if root_string(doc, &format!("{p}present")).as_deref() != Some("true") {
                continue;
            }
            let prov = match root_string(doc, &format!("{p}provenance")).as_deref() {
                Some("Local") => Provenance::Local,
                Some("Imported") => Provenance::Imported,
                Some("Verified") => Provenance::Verified,
                _ => continue,
            };
            let issuer = root_string(doc, &format!("{p}issuer"))
                .filter(|s| !s.is_empty())
                .and_then(|s| decode_key(&s).ok());
            let cs = root_string(doc, &format!("{p}claimed-seconds"));
            let cn = root_string(doc, &format!("{p}claimed-nanos"));
            let claimed = cs.filter(|s| !s.is_empty()).and_then(|s| {
                Some(ClaimedTime {
                    seconds: s.parse().ok()?,
                    nanos: cn?.parse().ok()?,
                })
            });
            out.push(Observation {
                name: root_string(doc, &format!("{p}name")).unwrap_or_default(),
                value: root_string(doc, &format!("{p}value")).unwrap_or_default(),
                provenance: prov,
                issuer,
                claimed,
                received: root_string(doc, &format!("{p}received"))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                meeting: root_string(doc, &format!("{p}meeting")).unwrap_or_default(),
            });
        }
    }
    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.value.cmp(&b.value))
            .then_with(|| a.meeting.cmp(&b.meeting))
    });
    out
}

fn observation_sources(doc: &Document, id: &str) -> Vec<String> {
    let mut sources = vec![id.to_string()];
    for key in doc.read().keys(ROOT) {
        if let Some(source) = key.strip_prefix(ALIAS_PREFIX)
            && root_string(doc, &key).as_deref() == Some(id)
        {
            sources.push(source.to_string());
        }
    }
    sources.sort();
    sources
}

fn preferred_values(doc: &Document, id: &str) -> Vec<(String, String)> {
    let mut preferred = std::collections::BTreeMap::new();
    for source in observation_sources(doc, id) {
        if source != id {
            collect_preferred(doc, &source, &mut preferred);
        }
    }
    collect_preferred(doc, id, &mut preferred);
    let observations = observations(doc, id);
    preferred
        .into_iter()
        .filter(|(name, value)| {
            observations
                .iter()
                .any(|observation| observation.name == *name && observation.value == *value)
        })
        .collect()
}

fn collect_preferred(
    doc: &Document,
    id: &str,
    preferred: &mut std::collections::BTreeMap<String, String>,
) {
    let prefix = format!("preferred:{id}:");
    for key in doc.read().keys(ROOT) {
        if let Some(encoded) = key.strip_prefix(&prefix)
            && let (Ok(name), Some(value)) = (decode_text(encoded), root_string(doc, &key))
        {
            preferred.insert(name, value);
        }
    }
}
fn meeting(doc: &Document, id: &str) -> Option<MeetingRecord> {
    Some(MeetingRecord {
        id: id.into(),
        method: root_string(doc, &meeting_key(id, "method"))?,
        source: root_string(doc, &meeting_key(id, "source")).unwrap_or_default(),
        source_key: root_string(doc, &meeting_key(id, "source-key"))
            .filter(|s| !s.is_empty())
            .and_then(|s| decode_key(&s).ok()),
        occurred: root_string(doc, &meeting_key(id, "occurred"))?
            .parse()
            .ok()?,
        verified: root_string(doc, &meeting_key(id, "verified")).as_deref() == Some("true"),
    })
}
fn meeting_exists(doc: &Document, id: &str) -> bool {
    meeting(doc, id).is_some()
}
fn require_contact(doc: &Document, id: &str) -> Result<(), String> {
    contact(doc, id)
        .map(|_| ())
        .ok_or_else(|| format!("no contact with id {id}"))
}
fn contact_key(id: &str, field: &str) -> String {
    format!("contact:{id}:{field}")
}
fn meeting_key(id: &str, field: &str) -> String {
    format!("meeting:{id}:{field}")
}
fn root_string(doc: &Document, key: &str) -> Option<String> {
    doc.read()
        .get(ROOT, key)
        .ok()
        .flatten()
        .and_then(|(v, _)| v.to_str().map(str::to_string))
}
fn root_bool(doc: &Document, key: &str) -> Option<bool> {
    doc.read()
        .get(ROOT, key)
        .ok()
        .flatten()
        .and_then(|(v, _)| v.to_bool())
}
fn digest(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for p in parts {
        h.update(p)
    }
    h.finalize().into()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode_key(s: &str) -> Result<[u8; 32], String> {
    decode_hex(s)?
        .try_into()
        .map_err(|_| "a contact public key must be 32 bytes".into())
}
fn valid_contact_key(key: [u8; 32]) -> Result<[u8; 32], String> {
    let key = VerifyingKey::from_bytes(&key)
        .map_err(|_| "that contact has an invalid public key".to_string())?;
    if key.is_weak() {
        Err("that contact has a weak public key".into())
    } else {
        Ok(key.to_bytes())
    }
}
fn decode_text(s: &str) -> Result<String, String> {
    String::from_utf8(decode_hex(s)?).map_err(|_| "invalid encoded field".into())
}
fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("invalid hexadecimal value".into());
    }
    s.as_bytes()
        .chunks(2)
        .map(|p| {
            std::str::from_utf8(p)
                .ok()
                .and_then(|x| u8::from_str_radix(x, 16).ok())
                .ok_or_else(|| "invalid hexadecimal value".into())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::ActorId;
    use sedimentree_core::id::SedimentreeId;
    fn doc(actor: u8) -> Document {
        Document::empty(ActorId::from(&[actor][..]), SedimentreeId::new([2; 32]))
    }
    fn signer(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    fn intro() -> Introduction {
        let s = signer(1);
        Introduction {
            issuer: Party {
                public_key: s.verifying_key().to_bytes(),
                claims: vec![Claim {
                    name: "name".into(),
                    value: "Ada".into(),
                }],
            },
            parties: vec![],
            issued_at: ClaimedTime {
                seconds: -1,
                nanos: 2,
            },
        }
    }
    #[test]
    fn codec_roundtrip_and_rejections() {
        let i = intro();
        let bytes = sign(&i, &signer(1)).unwrap();
        assert_eq!(verify(&bytes).unwrap(), i);
        let mut bad = bytes.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(verify(&bad).is_err());
        assert!(sign(&i, &signer(2)).is_err());
        let mut dup = i.clone();
        dup.parties.push(dup.issuer.clone());
        assert!(sign(&dup, &signer(1)).is_err());
        let mut weak = i.clone();
        weak.issuer.public_key = [0; 32];
        assert!(validate(&weak).is_err());
        assert!(verify(b"bad").is_err())
    }
    #[test]
    fn missing_time_and_bounds_rejected() {
        let mut p = proto::Introduction {
            issuer: Some(encode_party(&intro().issuer)),
            parties: vec![],
            issued_at: None,
        };
        let payload = p.encode_to_vec();
        let sig = signer(1).sign(&signing_message(&payload));
        let env = proto::SignedIntroduction {
            introduction: payload,
            signature: sig.to_bytes().to_vec(),
        }
        .encode_to_vec();
        assert!(verify(&env).is_err());
        p.issued_at = Some(prost_types::Timestamp {
            seconds: 0,
            nanos: 1_000_000_000,
        });
        assert!(extract(p).is_err());
        for seconds in [MIN_TIMESTAMP_SECONDS - 1, MAX_TIMESTAMP_SECONDS + 1] {
            let mut invalid = intro();
            invalid.issued_at.seconds = seconds;
            assert!(sign(&invalid, &signer(1)).is_err());
        }
        let mut many = intro();
        many.parties = vec![many.issuer.clone(); MAX_PARTIES];
        assert!(validate(&many).is_err());
        let mut claims = intro();
        claims.issuer.claims = vec![
            Claim {
                name: "x".into(),
                value: "y".into()
            };
            MAX_CLAIMS_PER_PARTY + 1
        ];
        assert!(validate(&claims).is_err());
        let mut names = intro();
        names.issuer.claims[0].name = "x".repeat(MAX_NAME_BYTES + 1);
        assert!(validate(&names).is_err());
        let mut values = intro();
        values.issuer.claims[0].value = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(validate(&values).is_err());

        let mut envelope = intro();
        envelope.issuer.claims = (0..MAX_CLAIMS_PER_PARTY)
            .map(|index| Claim {
                name: index.to_string(),
                value: "x".repeat(MAX_VALUE_BYTES),
            })
            .collect();
        assert!(sign(&envelope, &signer(1)).is_err());
    }
    #[test]
    fn exact_bytes_and_domain_are_required() {
        let i = intro();
        let payload = encode_introduction(&i);
        let raw = signer(1).sign(&payload);
        let env = proto::SignedIntroduction {
            introduction: payload.clone(),
            signature: raw.to_bytes().to_vec(),
        }
        .encode_to_vec();
        assert!(verify(&env).is_err());
        let mut with_unknown = payload;
        with_unknown.extend_from_slice(&[0xa0, 0x06, 0x01]);
        let sig = signer(1).sign(&signing_message(&with_unknown));
        let env = proto::SignedIntroduction {
            introduction: with_unknown,
            signature: sig.to_bytes().to_vec(),
        }
        .encode_to_vec();
        assert!(verify(&env).is_ok())
    }
    #[test]
    fn unsigned_json_is_imported_and_keyless() {
        let r = parse_import(br#"[{"claims":[{"name":"name","value":"A"}]}]"#).unwrap();
        assert!(!r.signed);
        assert_eq!(r.parties[0].public_key, None);
        assert_eq!(r.parties[0].provenance, Provenance::Imported);
        let weak = format!(r#"[{{"public_key":"{}","claims":[]}}]"#, "00".repeat(32));
        assert!(parse_import(weak.as_bytes()).is_err());
    }
    #[test]
    fn verified_import_retains_only_extracted_values() {
        let mut d = doc(1);
        let signed = sign(&intro(), &signer(1)).unwrap();
        let envelope = proto::SignedIntroduction::decode(signed.as_slice()).unwrap();
        let review = parse_import(&signed).unwrap();
        let key = review.parties[0].public_key.unwrap();
        let id = create_contact(&mut d, Some(key), "pet".into(), "🐈".into(), [1; 32]).unwrap();
        let m = create_meeting(
            &mut d,
            "imported from a file".into(),
            "contacts.json".into(),
            Some(key),
            7,
            true,
            [2; 32],
        )
        .unwrap();
        let claim = &review.parties[0].claims[0];
        let o = Observation {
            name: claim.name.clone(),
            value: claim.value.clone(),
            provenance: Provenance::Verified,
            issuer: Some(key),
            claimed: review.parties[0].claimed,
            received: 8,
            meeting: m,
        };
        write_extracted(
            &mut d,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: o.clone(),
            }],
        )
        .unwrap();
        write_extracted(
            &mut d,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: o,
            }],
        )
        .unwrap();
        assert_eq!(contact(&d, &id).unwrap().observations.len(), 1);

        let mut replay = automerge::Automerge::new();
        for change in d.read().get_changes(&[]) {
            replay.apply_changes([change]).unwrap();
            for key_name in replay.keys(ROOT) {
                assert!(!key_name.contains("signature"));
                if let Some((value, _)) = replay.get(ROOT, &key_name).unwrap() {
                    if let Some(bytes) = value.to_bytes() {
                        assert_ne!(bytes, envelope.introduction.as_slice());
                        assert_ne!(bytes, envelope.signature.as_slice());
                    }
                    if let Some(text) = value.to_str() {
                        assert_ne!(text.as_bytes(), envelope.introduction.as_slice());
                        assert_ne!(text.as_bytes(), envelope.signature.as_slice());
                    }
                }
            }
        }
    }

    #[test]
    fn observation_tuple_encoding_is_unambiguous() {
        let mut d = doc(1);
        let id = create_contact(&mut d, None, String::new(), String::new(), [1; 32]).unwrap();
        let meeting = create_meeting(
            &mut d,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        let row = |name: &str, value: &str| ExtractedObservation {
            contact_id: id.clone(),
            observation: Observation {
                name: name.into(),
                value: value.into(),
                provenance: Provenance::Local,
                issuer: None,
                claimed: None,
                received: 1,
                meeting: meeting.clone(),
            },
        };
        write_extracted(&mut d, vec![row("ab", "c"), row("a", "bc")]).unwrap();
        assert_eq!(contact(&d, &id).unwrap().observations.len(), 2);
    }

    #[test]
    fn concurrent_claims_preserve_local_choices() {
        let key = signer(4).verifying_key().to_bytes();
        let mut local = doc(1);
        let id =
            create_contact(&mut local, Some(key), "friend".into(), "🐕".into(), [1; 32]).unwrap();
        let local_meeting = create_meeting(
            &mut local,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        write_extracted(
            &mut local,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: Observation {
                    name: "name".into(),
                    value: "Local".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting: local_meeting,
                },
            }],
        )
        .unwrap();
        set_preferred(&mut local, &id, "name", Some("Local".into())).unwrap();

        let mut remote = doc(2);
        create_contact(
            &mut remote,
            Some(key),
            String::new(),
            String::new(),
            [3; 32],
        )
        .unwrap();
        let remote_meeting = create_meeting(
            &mut remote,
            "imported from a file".into(),
            "card".into(),
            Some(key),
            2,
            true,
            [4; 32],
        )
        .unwrap();
        write_extracted(
            &mut remote,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: Observation {
                    name: "email".into(),
                    value: "remote@example.test".into(),
                    provenance: Provenance::Verified,
                    issuer: Some(key),
                    claimed: Some(ClaimedTime {
                        seconds: 2,
                        nanos: 0,
                    }),
                    received: 2,
                    meeting: remote_meeting,
                },
            }],
        )
        .unwrap();
        local.merge_snapshot(&remote.save()).unwrap();
        let merged = contact(&local, &id).unwrap();
        assert_eq!(merged.observations.len(), 2);
        assert_eq!(merged.petname, "friend");
        assert_eq!(merged.glyph, "🐕");
        assert_eq!(merged.preferred, vec![("name".into(), "Local".into())]);
    }
    #[test]
    fn label_fields_persist_independently_and_existing_import_does_not_replace_them() {
        let mut d = doc(1);
        let key = signer(9).verifying_key().to_bytes();
        let id = create_contact(&mut d, Some(key), "friend".into(), "🐈".into(), [1; 32]).unwrap();
        set_label(&mut d, &id, "renamed".into(), "🐕".into()).unwrap();
        create_contact(&mut d, Some(key), String::new(), String::new(), [2; 32]).unwrap();
        let restored = Document::load(&d.save(), ActorId::from(&[2][..]), d.tree());
        let label = contact(&restored, &id).unwrap();
        assert_eq!(
            (label.petname.as_str(), label.glyph.as_str()),
            ("renamed", "🐕")
        );

        let keyed = signer(10).verifying_key().to_bytes();
        let target = create_contact(
            &mut d,
            Some(keyed),
            "target name".into(),
            String::new(),
            [3; 32],
        )
        .unwrap();
        let source =
            create_contact(&mut d, None, "source name".into(), "🐇".into(), [4; 32]).unwrap();
        merge(&mut d, &source, &target).unwrap();
        let merged = contact(&d, &target).unwrap();
        assert_eq!(
            (merged.petname.as_str(), merged.glyph.as_str()),
            ("target name", "🐇")
        );
    }
    #[test]
    fn convergence_keyless_merge_and_identity_adoption() {
        let key = signer(4).verifying_key().to_bytes();
        let mut a = doc(1);
        let mut b = doc(2);
        let ida = create_contact(&mut a, Some(key), "a".into(), String::new(), [1; 32]).unwrap();
        let idb = create_contact(&mut b, Some(key), "b".into(), String::new(), [2; 32]).unwrap();
        assert_eq!(ida, idb);
        a.merge_snapshot(&b.save()).unwrap();
        assert_eq!(contacts(&a).len(), 1);
        let kid = create_contact(&mut a, None, "old".into(), "🐁".into(), [5; 32]).unwrap();
        let meeting = create_meeting(
            &mut a,
            "entered by hand".into(),
            "".into(),
            None,
            1,
            false,
            [6; 32],
        )
        .unwrap();
        write_extracted(
            &mut a,
            vec![ExtractedObservation {
                contact_id: kid.clone(),
                observation: Observation {
                    name: "name".into(),
                    value: "Old".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting,
                },
            }],
        )
        .unwrap();
        set_preferred(&mut a, &kid, "name", Some("Old".into())).unwrap();
        set_label(&mut a, &ida, String::new(), String::new()).unwrap();
        merge(&mut a, &kid, &ida).unwrap();
        assert!(contact(&a, &kid).is_none());
        let merged = contact(&a, &ida).unwrap();
        assert_eq!(merged.observations.len(), 1);
        assert_eq!(
            (merged.petname.as_str(), merged.glyph.as_str()),
            ("old", "🐁")
        );
        assert_eq!(merged.preferred, vec![("name".into(), "Old".into())]);
        let first = identity_or_create(&mut a, [7; 32], [8; 32]).unwrap();
        assert!(first.1);
        assert_eq!(
            identity_or_create(&mut a, [9; 32], [10; 32]).unwrap(),
            (first.0, false)
        );
        let mut group = doc(3);
        let group_seed = identity_or_create(&mut group, [11; 32], [12; 32])
            .unwrap()
            .0;
        let local_provenance = create_meeting(
            &mut a,
            "entered by hand".into(),
            String::new(),
            None,
            3,
            false,
            [13; 32],
        )
        .unwrap();
        write_self_observation(
            &mut a,
            Observation {
                name: "name".into(),
                value: "Joiner".into(),
                provenance: Provenance::Local,
                issuer: None,
                claimed: None,
                received: 3,
                meeting: local_provenance,
            },
        )
        .unwrap();
        let group_provenance = create_meeting(
            &mut group,
            "entered by hand".into(),
            String::new(),
            None,
            4,
            false,
            [14; 32],
        )
        .unwrap();
        write_self_observation(
            &mut group,
            Observation {
                name: "name".into(),
                value: "Group".into(),
                provenance: Provenance::Local,
                issuer: None,
                claimed: None,
                received: 4,
                meeting: group_provenance,
            },
        )
        .unwrap();
        adopt(&mut a, &group).unwrap();
        assert_eq!(identity_seed(&a), Some(group_seed));
        assert_eq!(
            identity_public_key(&a),
            Some(
                SigningKey::from_bytes(&group_seed)
                    .verifying_key()
                    .to_bytes()
            )
        );
        let profile = self_profile(&a).unwrap();
        assert_eq!(profile.observations.len(), 1);
        assert_eq!(profile.observations[0].value, "Group")
    }

    #[test]
    fn removing_observation_clears_its_preference() {
        let mut d = doc(1);
        let id = create_contact(&mut d, None, String::new(), String::new(), [1; 32]).unwrap();
        let meeting = create_meeting(
            &mut d,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        write_extracted(
            &mut d,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: Observation {
                    name: "name".into(),
                    value: "Ada".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting,
                },
            }],
        )
        .unwrap();
        set_preferred(&mut d, &id, "name", Some("Ada".into())).unwrap();
        remove_observation(&mut d, &id, "name", "Ada").unwrap();
        assert!(contact(&d, &id).unwrap().preferred.is_empty());
    }

    #[test]
    fn empty_preferred_value_is_distinct_from_clear() {
        let mut d = doc(1);
        let id = create_contact(&mut d, None, String::new(), String::new(), [1; 32]).unwrap();
        let meeting = create_meeting(
            &mut d,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        write_extracted(
            &mut d,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: Observation {
                    name: "note".into(),
                    value: String::new(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting,
                },
            }],
        )
        .unwrap();
        set_preferred(&mut d, &id, "note", Some(String::new())).unwrap();
        assert_eq!(
            contact(&d, &id).unwrap().preferred,
            vec![("note".into(), String::new())]
        );
        set_preferred(&mut d, &id, "note", None).unwrap();
        assert!(contact(&d, &id).unwrap().preferred.is_empty());
    }

    #[test]
    fn alias_preserves_observation_added_concurrently_to_keyless_source() {
        let mut base = doc(1);
        let key = signer(5).verifying_key().to_bytes();
        let keyed =
            create_contact(&mut base, Some(key), "known".into(), String::new(), [1; 32]).unwrap();
        let keyless =
            create_contact(&mut base, None, "import".into(), String::new(), [2; 32]).unwrap();
        let snapshot = base.save();
        let tree = base.tree();
        let mut merger = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut writer = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);

        merge(&mut merger, &keyless, &keyed).unwrap();
        let meeting = create_meeting(
            &mut writer,
            "entered by hand".into(),
            String::new(),
            None,
            3,
            false,
            [3; 32],
        )
        .unwrap();
        write_extracted(
            &mut writer,
            vec![ExtractedObservation {
                contact_id: keyless.clone(),
                observation: Observation {
                    name: "late".into(),
                    value: "arrived".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 3,
                    meeting,
                },
            }],
        )
        .unwrap();

        merger.merge_snapshot(&writer.save()).unwrap();
        writer.merge_snapshot(&merger.save()).unwrap();
        for converged in [&merger, &writer] {
            assert!(contact(converged, &keyless).is_none());
            assert_eq!(
                contact(converged, &keyed).unwrap().observations[0].name,
                "late"
            );
        }

        let reloaded = Document::load(&merger.save(), ActorId::from(&[4_u8][..]), tree);
        assert_eq!(
            contact(&reloaded, &keyed).unwrap().observations[0].value,
            "arrived"
        );
    }

    #[test]
    fn alias_preference_order_and_explicit_clear_are_stable() {
        for source_before_destination in [true, false] {
            let mut d = doc(if source_before_destination { 10 } else { 11 });
            let key = signer(if source_before_destination { 6 } else { 7 })
                .verifying_key()
                .to_bytes();
            let destination =
                create_contact(&mut d, Some(key), String::new(), String::new(), [1; 32]).unwrap();
            let source = (0_u16..=u8::MAX as u16)
                .find_map(|n| {
                    let mut entropy = [0; 32];
                    entropy[0] = n as u8;
                    let id = create_contact(&mut d, None, String::new(), String::new(), entropy)
                        .unwrap();
                    ((id < destination) == source_before_destination).then_some(id)
                })
                .unwrap();
            let meeting = create_meeting(
                &mut d,
                "entered by hand".into(),
                String::new(),
                None,
                1,
                false,
                [2; 32],
            )
            .unwrap();
            write_extracted(
                &mut d,
                vec![ExtractedObservation {
                    contact_id: source.clone(),
                    observation: Observation {
                        name: "name".into(),
                        value: "source".into(),
                        provenance: Provenance::Local,
                        issuer: None,
                        claimed: None,
                        received: 1,
                        meeting,
                    },
                }],
            )
            .unwrap();
            set_preferred(&mut d, &source, "name", Some("source".into())).unwrap();
            merge(&mut d, &source, &destination).unwrap();
            assert_eq!(
                contact(&d, &destination).unwrap().preferred,
                vec![("name".into(), "source".into())]
            );
            set_preferred(&mut d, &destination, "name", None).unwrap();
            assert!(contact(&d, &destination).unwrap().preferred.is_empty());
        }
    }

    #[test]
    fn delete_and_recreate_does_not_resurrect_aliased_claims() {
        let mut d = doc(1);
        let key = signer(8).verifying_key().to_bytes();
        let destination =
            create_contact(&mut d, Some(key), "known".into(), String::new(), [1; 32]).unwrap();
        let source = create_contact(&mut d, None, "import".into(), String::new(), [2; 32]).unwrap();
        let meeting = create_meeting(
            &mut d,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [3; 32],
        )
        .unwrap();
        write_extracted(
            &mut d,
            vec![ExtractedObservation {
                contact_id: source.clone(),
                observation: Observation {
                    name: "name".into(),
                    value: "deleted".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting,
                },
            }],
        )
        .unwrap();
        set_preferred(&mut d, &source, "name", Some("deleted".into())).unwrap();
        merge(&mut d, &source, &destination).unwrap();
        let before_delete = d.save();
        delete_contact(&mut d, &destination).unwrap();
        create_contact(&mut d, Some(key), "new".into(), String::new(), [4; 32]).unwrap();
        let tree = d.tree();
        let mut reloaded = Document::load(&d.save(), ActorId::from(&[5_u8][..]), tree);
        reloaded.merge_snapshot(&before_delete).unwrap();
        let recreated = contact(&reloaded, &destination).unwrap();
        assert!(recreated.observations.is_empty());
        assert!(recreated.preferred.is_empty());
    }

    #[test]
    fn concurrent_removal_hides_dangling_preference() {
        let mut base = doc(1);
        let id = create_contact(&mut base, None, String::new(), String::new(), [1; 32]).unwrap();
        let meeting = create_meeting(
            &mut base,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        write_extracted(
            &mut base,
            vec![ExtractedObservation {
                contact_id: id.clone(),
                observation: Observation {
                    name: "name".into(),
                    value: "gone".into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting,
                },
            }],
        )
        .unwrap();
        let snapshot = base.save();
        let tree = base.tree();
        let mut remover = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut chooser = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);
        remove_observation(&mut remover, &id, "name", "gone").unwrap();
        set_preferred(&mut chooser, &id, "name", Some("gone".into())).unwrap();
        remover.merge_snapshot(&chooser.save()).unwrap();
        assert!(contact(&remover, &id).unwrap().observations.is_empty());
        assert!(contact(&remover, &id).unwrap().preferred.is_empty());
    }
}
