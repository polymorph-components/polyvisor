//! Root-authenticated user profiles and device-authenticated introductions.
//!
//! Keyhive authority is intentionally opaque here. Introduction signature
//! verification produces [`PendingIntroduction`]; authenticated values become
//! available only through a callback that the kernel fulfills with Keyhive.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
};

use automerge::{ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use polyvisor_document_history::Document;
use prost::Message;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/polyvisor.introduction.v0.rs"));
}

const VERSION: u32 = 0;
const BINDING_DOMAIN: &[u8] = b"polyvisor:root-group-binding:v0\0";
const PROFILE_DOMAIN: &[u8] = b"polyvisor:self-profile:v0\0";
const INTRODUCTION_DOMAIN: &[u8] = b"polyvisor:introduction:v0\0";
const ROOT_BINDING: &str = "identity:root-group-binding";
const SELF_PROFILE: &str = "identity:self-profile";
const ALIAS_PREFIX: &str = "alias:";
const MIN_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
const MAX_TIMESTAMP_SECONDS: i64 = 253_402_300_799;

pub const MAX_SIGNED_BYTES: usize = 256 * 1024;
pub const MAX_PARTIES: usize = 64;
pub const MAX_CLAIMS_PER_PARTY: usize = 128;
pub const MAX_NAME_BYTES: usize = 256;
pub const MAX_VALUE_BYTES: usize = 4096;

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; 32]);

        impl $name {
            pub const fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            pub const fn to_bytes(self) -> [u8; 32] {
                self.0
            }
        }
    };
}

identifier!(RootIdentity);
identifier!(GroupId);
identifier!(DeviceSigningKey);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimedTime {
    pub seconds: i64,
    pub nanos: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Party {
    pub public_key: [u8; 32],
    /// The introduction issuer's observations about this party. These are not
    /// official claims by `public_key`'s holder.
    pub observations: Vec<Claim>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Local,
    Imported,
    Verified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub name: String,
    pub value: String,
    pub provenance: Provenance,
    pub issuer: Option<RootIdentity>,
    pub claimed: Option<ClaimedTime>,
    pub received: u64,
    pub meeting: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewParty {
    pub index: u32,
    pub public_key: Option<[u8; 32]>,
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReview {
    pub parties: Vec<ReviewParty>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootBinding {
    pub root: RootIdentity,
    pub group: GroupId,
}

/// Exact, redistributable root-signed binding bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRootBinding(Vec<u8>);

impl SignedRootBinding {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, String> {
        verify_root_binding_bytes(&bytes)?;
        Ok(Self(bytes))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub subject: RootIdentity,
    pub issuer: RootIdentity,
    pub claims: Vec<Claim>,
}

/// Exact, redistributable root-signed whole-profile bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedProfile(Vec<u8>);

impl SignedProfile {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, String> {
        verify_profile_bytes(&bytes)?;
        Ok(Self(bytes))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Introduction {
    pub issuer: AuthenticatedIdentity,
    pub device: DeviceSigningKey,
    pub authenticated_identities: Vec<AuthenticatedIdentity>,
    pub parties: Vec<Party>,
    pub issued_at: ClaimedTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedIdentity {
    pub binding: SignedRootBinding,
    /// Selection is at identity granularity: all supplied current variants
    /// are disclosed whole, never individual claims.
    pub profiles: Vec<SignedProfile>,
    pub authority_device: DeviceSigningKey,
    pub keyhive_authority_proof: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityRequest {
    pub root: RootIdentity,
    pub group: GroupId,
    pub device: DeviceSigningKey,
    pub keyhive_authority_proof: Vec<u8>,
}

/// Signature-valid but not yet authenticated by Keyhive authority.
pub struct PendingIntroduction {
    introduction: Introduction,
    requests: Vec<AuthorityRequest>,
}

impl PendingIntroduction {
    pub fn authority_requests(&self) -> &[AuthorityRequest] {
        &self.requests
    }
}

/// The only introduction form accepted by authenticated persistence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIntroduction {
    introduction: Introduction,
}

impl VerifiedIntroduction {
    pub fn introduction(&self) -> &Introduction {
        &self.introduction
    }

    /// Selects only complete authenticated identities and explicitly indexed
    /// issuer observations that were present in the verified payload.
    pub fn select(
        self,
        identity_roots: &[RootIdentity],
        party_indices: &[u32],
    ) -> Result<SelectedIntroduction, String> {
        let available_roots = self
            .introduction
            .all_identities()
            .map(|identity| verify_root_binding(&identity.binding).map(|binding| binding.root))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let roots = identity_roots.iter().copied().collect::<BTreeSet<_>>();
        if roots.len() != identity_roots.len() || !roots.is_subset(&available_roots) {
            return Err("identity selection was not present in the verified introduction".into());
        }
        let parties = party_indices.iter().copied().collect::<BTreeSet<_>>();
        if parties.len() != party_indices.len()
            || parties
                .iter()
                .any(|index| *index as usize >= self.introduction.parties.len())
        {
            return Err("party selection was not present in the verified introduction".into());
        }
        Ok(SelectedIntroduction {
            introduction: self.introduction,
            roots,
            parties,
        })
    }
}

pub struct SelectedIntroduction {
    introduction: Introduction,
    roots: BTreeSet<RootIdentity>,
    parties: BTreeSet<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfProfile {
    pub root: RootIdentity,
    pub binding: SignedRootBinding,
    /// All current Automerge register values. Multiple values are unresolved
    /// concurrent official profiles, not candidates for a clock-based winner.
    pub variants: Vec<SignedProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedIdentity {
    pub root: RootIdentity,
    pub binding: SignedRootBinding,
    pub profiles: Vec<SignedProfile>,
    pub authorities: Vec<RetainedAuthority>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedAuthority {
    pub device: DeviceSigningKey,
    pub keyhive_authority_proof: Vec<u8>,
}

impl RetainedIdentity {
    pub fn official_profiles(&self) -> Vec<Profile> {
        self.profiles
            .iter()
            .filter_map(|profile| verify_profile(profile).ok())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contact {
    pub id: String,
    pub public_key: Option<[u8; 32]>,
    pub petname: String,
    pub glyph: String,
    pub retained_identity: Option<RetainedIdentity>,
    pub observations: Vec<Observation>,
    pub preferred: Vec<(String, String)>,
}

pub fn sign_root_binding(root: &SigningKey, group: GroupId) -> SignedRootBinding {
    let binding = proto::RootBinding {
        version: VERSION,
        root_public_key: root.verifying_key().to_bytes().to_vec(),
        group_id: group.0.to_vec(),
    }
    .encode_to_vec();
    let signature = root.sign(&domain_message(BINDING_DOMAIN, &binding));
    SignedRootBinding(
        proto::SignedRootBinding {
            binding,
            signature: signature.to_bytes().to_vec(),
        }
        .encode_to_vec(),
    )
}

pub fn verify_root_binding(binding: &SignedRootBinding) -> Result<RootBinding, String> {
    verify_root_binding_bytes(&binding.0)
}

fn verify_root_binding_bytes(bytes: &[u8]) -> Result<RootBinding, String> {
    bounded(bytes)?;
    let signed = proto::SignedRootBinding::decode(bytes)
        .map_err(|_| "invalid root binding envelope".to_string())?;
    let value = proto::RootBinding::decode(signed.binding.as_slice())
        .map_err(|_| "invalid root binding payload".to_string())?;
    require_version(value.version, "root binding")?;
    let root = RootIdentity(key32(&value.root_public_key, "root identity")?);
    let group = GroupId(key32(&value.group_id, "group id")?);
    verify_signature(root.0, BINDING_DOMAIN, &signed.binding, &signed.signature)?;
    Ok(RootBinding { root, group })
}

pub fn sign_profile(root: &SigningKey, claims: Vec<Claim>) -> Result<SignedProfile, String> {
    validate_claims(&claims)?;
    let identity = root.verifying_key().to_bytes();
    let profile = proto::Profile {
        version: VERSION,
        subject_root: identity.to_vec(),
        issuer_root: identity.to_vec(),
        claims: claims.iter().map(proto_claim).collect(),
    }
    .encode_to_vec();
    let signature = root.sign(&domain_message(PROFILE_DOMAIN, &profile));
    Ok(SignedProfile(
        proto::SignedProfile {
            profile,
            signature: signature.to_bytes().to_vec(),
        }
        .encode_to_vec(),
    ))
}

pub fn verify_profile(profile: &SignedProfile) -> Result<Profile, String> {
    verify_profile_bytes(&profile.0)
}

fn verify_profile_bytes(bytes: &[u8]) -> Result<Profile, String> {
    bounded(bytes)?;
    let signed = proto::SignedProfile::decode(bytes)
        .map_err(|_| "invalid signed profile envelope".to_string())?;
    let value = proto::Profile::decode(signed.profile.as_slice())
        .map_err(|_| "invalid profile payload".to_string())?;
    require_version(value.version, "profile")?;
    let subject = RootIdentity(key32(&value.subject_root, "profile subject")?);
    let issuer = RootIdentity(key32(&value.issuer_root, "profile issuer")?);
    if subject != issuer {
        return Err("an official self-profile must have identical subject and issuer".into());
    }
    let claims = extract_claims(value.claims)?;
    verify_signature(issuer.0, PROFILE_DOMAIN, &signed.profile, &signed.signature)?;
    Ok(Profile {
        subject,
        issuer,
        claims,
    })
}

pub fn sign_introduction(value: &Introduction, device: &SigningKey) -> Result<Vec<u8>, String> {
    validate_introduction(value)?;
    if value.device.0 != device.verifying_key().to_bytes() {
        return Err("introduction device key does not match signer".into());
    }
    let payload = protobuf_introduction(value).encode_to_vec();
    let signature = device.sign(&domain_message(INTRODUCTION_DOMAIN, &payload));
    let envelope = proto::SignedIntroduction {
        introduction: payload,
        signature: signature.to_bytes().to_vec(),
    }
    .encode_to_vec();
    bounded(&envelope)?;
    Ok(envelope)
}

pub fn verify_introduction(bytes: &[u8]) -> Result<PendingIntroduction, String> {
    bounded(bytes)?;
    let signed = proto::SignedIntroduction::decode(bytes)
        .map_err(|_| "invalid introduction envelope".to_string())?;
    let wire = proto::Introduction::decode(signed.introduction.as_slice())
        .map_err(|_| "invalid introduction payload".to_string())?;
    let introduction = extract_introduction(wire)?;
    validate_introduction(&introduction)?;
    verify_signature(
        introduction.device.0,
        INTRODUCTION_DOMAIN,
        &signed.introduction,
        &signed.signature,
    )?;
    let requests = introduction
        .all_identities()
        .map(authority_request)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PendingIntroduction {
        introduction,
        requests,
    })
}

pub async fn validate_authority<F, Fut>(
    pending: PendingIntroduction,
    mut kernel_validate: F,
) -> Result<VerifiedIntroduction, String>
where
    F: FnMut(AuthorityRequest) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    for request in pending.requests {
        kernel_validate(request).await?;
    }
    Ok(VerifiedIntroduction {
        introduction: pending.introduction,
    })
}

fn validate_introduction(value: &Introduction) -> Result<(), String> {
    valid_time(value.issued_at)?;
    if value.parties.len() + 1 > MAX_PARTIES {
        return Err("introduction has too many parties".into());
    }
    valid_key(value.device.0, "device signing key")?;
    let issuer = validate_authenticated_identity(&value.issuer)?;
    if value.issuer.authority_device != value.device {
        return Err("issuer authority device does not match introduction signer".into());
    }
    let mut identities = BTreeSet::from([issuer.root]);
    for identity in &value.authenticated_identities {
        let binding = validate_authenticated_identity(identity)?;
        if !identities.insert(binding.root) {
            return Err("introduction repeats an authenticated identity".into());
        }
    }
    let mut parties = BTreeSet::new();
    parties.insert(issuer.root.0);
    for party in &value.parties {
        valid_key(party.public_key, "observed party key")?;
        if !parties.insert(party.public_key) {
            return Err("introduction repeats a party".into());
        }
        validate_claims(&party.observations)?;
    }
    Ok(())
}

fn protobuf_introduction(value: &Introduction) -> proto::Introduction {
    proto::Introduction {
        version: VERSION,
        issuer: Some(proto_authenticated_identity(&value.issuer)),
        device_signing_key: value.device.0.to_vec(),
        authenticated_identities: value
            .authenticated_identities
            .iter()
            .map(proto_authenticated_identity)
            .collect(),
        parties: value
            .parties
            .iter()
            .map(|party| proto::Party {
                public_key: party.public_key.to_vec(),
                claims: party.observations.iter().map(proto_claim).collect(),
            })
            .collect(),
        issued_at: Some(prost_types::Timestamp {
            seconds: value.issued_at.seconds,
            nanos: value.issued_at.nanos as i32,
        }),
    }
}

fn extract_introduction(value: proto::Introduction) -> Result<Introduction, String> {
    require_version(value.version, "introduction")?;
    let time = value
        .issued_at
        .ok_or_else(|| "introduction has no issued time".to_string())?;
    let issued_at = ClaimedTime {
        seconds: time.seconds,
        nanos: u32::try_from(time.nanos).map_err(|_| "invalid introduction time".to_string())?,
    };
    valid_time(issued_at)?;
    Ok(Introduction {
        issuer: extract_authenticated_identity(
            value
                .issuer
                .ok_or_else(|| "introduction has no issuer".to_string())?,
        )?,
        device: DeviceSigningKey(key32(&value.device_signing_key, "device signing key")?),
        authenticated_identities: value
            .authenticated_identities
            .into_iter()
            .map(extract_authenticated_identity)
            .collect::<Result<_, _>>()?,
        parties: value
            .parties
            .into_iter()
            .map(|party| {
                Ok(Party {
                    public_key: key32(&party.public_key, "observed party key")?,
                    observations: extract_claims(party.claims)?,
                })
            })
            .collect::<Result<_, String>>()?,
        issued_at,
    })
}

impl Introduction {
    fn all_identities(&self) -> impl Iterator<Item = &AuthenticatedIdentity> {
        std::iter::once(&self.issuer).chain(&self.authenticated_identities)
    }
}

fn validate_authenticated_identity(value: &AuthenticatedIdentity) -> Result<RootBinding, String> {
    let binding = verify_root_binding(&value.binding)?;
    if value.profiles.is_empty() || value.keyhive_authority_proof.is_empty() {
        return Err("authenticated identity lacks profile or authority proof".into());
    }
    valid_key(value.authority_device.0, "authority device")?;
    let mut profiles = BTreeSet::new();
    for signed in &value.profiles {
        let profile = verify_profile(signed)?;
        if profile.subject != binding.root || profile.issuer != binding.root {
            return Err("profile does not match its root binding".into());
        }
        if !profiles.insert(signed.0.clone()) {
            return Err("authenticated identity repeats a profile variant".into());
        }
    }
    Ok(binding)
}

fn authority_request(value: &AuthenticatedIdentity) -> Result<AuthorityRequest, String> {
    let binding = validate_authenticated_identity(value)?;
    Ok(AuthorityRequest {
        root: binding.root,
        group: binding.group,
        device: value.authority_device,
        keyhive_authority_proof: value.keyhive_authority_proof.clone(),
    })
}

fn proto_authenticated_identity(value: &AuthenticatedIdentity) -> proto::AuthenticatedIdentity {
    proto::AuthenticatedIdentity {
        root_binding: value.binding.0.clone(),
        profiles: value.profiles.iter().map(|p| p.0.clone()).collect(),
        authority_device: value.authority_device.0.to_vec(),
        keyhive_authority_proof: value.keyhive_authority_proof.clone(),
    }
}

fn extract_authenticated_identity(
    value: proto::AuthenticatedIdentity,
) -> Result<AuthenticatedIdentity, String> {
    Ok(AuthenticatedIdentity {
        binding: SignedRootBinding::from_bytes(value.root_binding)?,
        profiles: value
            .profiles
            .into_iter()
            .map(SignedProfile::from_bytes)
            .collect::<Result<_, _>>()?,
        authority_device: DeviceSigningKey(key32(&value.authority_device, "authority device")?),
        keyhive_authority_proof: value.keyhive_authority_proof,
    })
}

/// Establishes the public root and its one immutable group binding. No signing
/// seed is accepted or written to replicated history.
pub fn bind_root(doc: &mut Document, binding: SignedRootBinding) -> Result<bool, String> {
    let verified = verify_root_binding(&binding)?;
    let bindings = all_root_bytes(doc, ROOT_BINDING);
    if bindings.len() > 1 {
        return Err("contacts root binding is conflicted".into());
    }
    if let Some(existing) = bindings
        .into_iter()
        .next()
        .and_then(|bytes| SignedRootBinding::from_bytes(bytes).ok())
    {
        let existing_value = verify_root_binding(&existing)?;
        return if existing_value == verified && existing == binding {
            Ok(false)
        } else {
            Err("the established root/group binding cannot be replaced".into())
        };
    }
    let bytes = binding.0;
    doc.transact(move |tx| {
        tx.put(ROOT, ROOT_BINDING, ScalarValue::Bytes(bytes))
            .map_err(|e| e.to_string())
    })?;
    Ok(true)
}

pub fn root_identity(doc: &Document) -> Option<RootIdentity> {
    root_binding(doc)
        .and_then(|binding| verify_root_binding(&binding).ok())
        .map(|binding| binding.root)
}

pub fn root_binding(doc: &Document) -> Option<SignedRootBinding> {
    let values = all_root_bytes(doc, ROOT_BINDING);
    (values.len() == 1)
        .then(|| values.into_iter().next())
        .flatten()
        .and_then(|bytes| SignedRootBinding::from_bytes(bytes).ok())
}

pub fn write_self_profile(doc: &mut Document, profile: SignedProfile) -> Result<(), String> {
    let root = root_identity(doc).ok_or_else(|| "contacts root is not established".to_string())?;
    let decoded = verify_profile(&profile)?;
    if decoded.subject != root || decoded.issuer != root {
        return Err("profile is not signed by the established root".into());
    }
    doc.transact(move |tx| {
        tx.put(ROOT, SELF_PROFILE, ScalarValue::Bytes(profile.0))
            .map_err(|e| e.to_string())
    })
}

/// Root-holder conflict resolution: one causally later put overwrites every
/// profile variant observed by this document. It never chooses an Automerge
/// clock winner.
pub fn resolve_self_profile(
    doc: &mut Document,
    root: &SigningKey,
    expected_variants: &[SignedProfile],
    claims: Vec<Claim>,
) -> Result<SignedProfile, String> {
    let established =
        root_identity(doc).ok_or_else(|| "contacts root is not established".to_string())?;
    if established.0 != root.verifying_key().to_bytes() {
        return Err("profile resolver does not hold the established root".into());
    }
    let current =
        self_profile(doc).ok_or_else(|| "contacts root is not established".to_string())?;
    let mut expected = expected_variants.to_vec();
    expected.sort_by(|a, b| a.0.cmp(&b.0));
    expected.dedup();
    if current.variants != expected {
        return Err("self-profile variants changed while editing".into());
    }
    let signed = sign_profile(root, claims)?;
    write_self_profile(doc, signed.clone())?;
    Ok(signed)
}

/// Pairing adoption changes only the public self identity/profile registers;
/// unrelated local contacts and observations remain intact.
pub fn adopt(current: &mut Document, source: &Document) -> Result<(), String> {
    self_profile(source).ok_or_else(|| "source contacts identity is not ready".to_string())?;
    let current_keys: Vec<_> = current
        .read()
        .keys(ROOT)
        .filter(|key| *key == ROOT_BINDING || *key == SELF_PROFILE)
        .collect();
    current.transact(|tx| {
        for key in current_keys {
            tx.delete(ROOT, key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    // CONTRACT: Engine::document_adopt invokes this callback before it merges
    // anything (runtime/crates/engine/src/lib.rs:684-698). Deleting the local
    // registers first and then merging the source imports the source's actual
    // concurrent profile operations. Sequentially replaying variants would
    // collapse them to one register value.
    current.merge_snapshot(&source.save())
}

pub fn self_profile(doc: &Document) -> Option<SelfProfile> {
    let root = root_identity(doc)?;
    let binding = root_binding(doc)?;
    let mut variants: Vec<_> = doc
        .read()
        .get_all(ROOT, SELF_PROFILE)
        .ok()?
        .into_iter()
        .filter_map(|(value, _)| scalar_bytes(value))
        .filter_map(|bytes| SignedProfile::from_bytes(bytes).ok())
        .filter(|signed| {
            verify_profile(signed)
                .is_ok_and(|profile| profile.subject == root && profile.issuer == root)
        })
        .collect();
    variants.sort_by(|a, b| a.0.cmp(&b.0));
    variants.dedup();
    Some(SelfProfile {
        root,
        binding,
        variants,
    })
}

/// Local ids are random-input derived and deliberately unrelated to any root
/// or observed public key.
pub fn create_contact(
    doc: &mut Document,
    public_key: Option<[u8; 32]>,
    petname: String,
    glyph: String,
    entropy: [u8; 32],
) -> Result<String, String> {
    if let Some(key) = public_key {
        valid_key(key, "contact public key")?;
    }
    let id = local_id(b"polyvisor:local-contact:v0\0", &entropy, doc.actor_id());
    if contact(doc, &id).is_some() {
        return Err("contact entropy was reused".into());
    }
    let fields = [
        ("exists", "true".to_string()),
        ("petname", petname),
        ("glyph", glyph),
        (
            "public-key",
            public_key.map(|k| hex(&k)).unwrap_or_default(),
        ),
    ];
    doc.transact(|tx| {
        for (field, value) in fields {
            tx.put(ROOT, contact_key(&id, field), value)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })?;
    Ok(id)
}

/// Persists reusable root-authenticated artifacts and the authority bytes that
/// the kernel successfully validated. The transient introduction signature is
/// structurally absent from [`VerifiedIntroduction`] persistence fields.
pub fn persist_verified_introduction(
    doc: &mut Document,
    selected: SelectedIntroduction,
    petname: String,
    glyph: String,
    entropy: [u8; 32],
    received: u64,
) -> Result<String, String> {
    let intro = selected.introduction;
    let selected_identities = intro
        .all_identities()
        .filter(|identity| {
            verify_root_binding(&identity.binding)
                .is_ok_and(|binding| selected.roots.contains(&binding.root))
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_identities.is_empty() && selected.parties.is_empty() {
        return Err("introduction selection is empty".into());
    }
    for identity in &selected_identities {
        ensure_unique_root_group(doc, identity)?;
    }
    let issuer_root = verify_root_binding(&intro.issuer.binding)?.root;
    let mut first_affected = None;
    for (index, identity) in selected_identities.into_iter().enumerate() {
        let root = verify_root_binding(&identity.binding)?.root;
        let identity_id = match retained_root_contact(doc, root)
            .or_else(|| contact_with_public_key(doc, root.0))
        {
            Some(id) => id,
            None => create_contact(
                doc,
                Some(root.0),
                if root == issuer_root {
                    petname.clone()
                } else {
                    String::new()
                },
                if root == issuer_root {
                    glyph.clone()
                } else {
                    String::new()
                },
                derived_entropy(entropy, index as u64 + 1),
            )?,
        };
        retain_identity(doc, &identity_id, identity)?;
        first_affected.get_or_insert(identity_id);
    }
    for (index, party) in intro
        .parties
        .into_iter()
        .enumerate()
        .filter(|(index, _)| selected.parties.contains(&(*index as u32)))
    {
        let party_id = match contact_with_public_key(doc, party.public_key) {
            Some(id) => id,
            None => create_contact(
                doc,
                Some(party.public_key),
                String::new(),
                String::new(),
                derived_entropy(entropy, index as u64 + 1 + MAX_PARTIES as u64),
            )?,
        };
        first_affected.get_or_insert(party_id.clone());
        let meeting = create_meeting(
            doc,
            "verified introduction".into(),
            String::new(),
            Some(issuer_root.0),
            received,
            true,
            derived_entropy(entropy, index as u64 + 1 + (MAX_PARTIES as u64 * 2)),
        )?;
        for claim in party.observations {
            write_observation(
                doc,
                &party_id,
                Observation {
                    name: claim.name,
                    value: claim.value,
                    provenance: Provenance::Verified,
                    issuer: Some(issuer_root),
                    claimed: Some(intro.issued_at),
                    received,
                    meeting: meeting.clone(),
                },
            )?;
        }
    }
    first_affected.ok_or_else(|| "introduction selection is empty".into())
}

fn retained_root_contact(doc: &Document, root: RootIdentity) -> Option<String> {
    contact_ids(doc)
        .into_iter()
        .find(|id| retained_identity_at(doc, id).is_some_and(|identity| identity.root == root))
}

fn contact_with_public_key(doc: &Document, key: [u8; 32]) -> Option<String> {
    contacts(doc)
        .into_iter()
        .find(|contact| contact.public_key == Some(key))
        .map(|contact| contact.id)
}

fn ensure_unique_root_group(
    doc: &Document,
    identity: &AuthenticatedIdentity,
) -> Result<(), String> {
    let candidate = verify_root_binding(&identity.binding)?;
    let mut groups = BTreeSet::new();
    let self_bindings = all_root_bytes(doc, ROOT_BINDING);
    if self_bindings.len() > 1
        && self_bindings
            .iter()
            .filter_map(|bytes| SignedRootBinding::from_bytes(bytes.clone()).ok())
            .filter_map(|binding| verify_root_binding(&binding).ok())
            .any(|binding| binding.root == candidate.root)
    {
        return Err("self root binding is conflicted".into());
    }
    for bytes in self_bindings {
        if let Ok(binding) = SignedRootBinding::from_bytes(bytes)
            && let Ok(binding) = verify_root_binding(&binding)
            && binding.root == candidate.root
        {
            groups.insert(binding.group);
        }
    }
    for id in contact_ids(doc) {
        let key = contact_key(&id, "retained-identity");
        let values = all_root_bytes(doc, &key);
        for bytes in values {
            if let Ok(wire) = proto::AuthenticatedIdentity::decode(bytes.as_slice())
                && let Ok(identity) = extract_authenticated_identity(wire)
                && let Ok(binding) = verify_root_binding(&identity.binding)
                && binding.root == candidate.root
            {
                groups.insert(binding.group);
            }
        }
    }
    if groups.iter().any(|group| *group != candidate.group) {
        Err("that root is already accepted for another group".into())
    } else {
        Ok(())
    }
}

fn retain_identity(
    doc: &mut Document,
    id: &str,
    identity: AuthenticatedIdentity,
) -> Result<(), String> {
    let bytes = proto_authenticated_identity(&identity).encode_to_vec();
    doc.transact(|tx| {
        tx.put(
            ROOT,
            contact_key(id, "retained-identity"),
            ScalarValue::Bytes(bytes),
        )
        .map_err(|e| e.to_string())
    })
}

pub fn contact(doc: &Document, id: &str) -> Option<Contact> {
    if root_string(doc, &contact_key(id, "exists")).as_deref() != Some("true") {
        return None;
    }
    let public_key = root_string(doc, &contact_key(id, "public-key"))
        .filter(|s| !s.is_empty())
        .and_then(|s| decode_hex32(&s).ok());
    let retained_identity = retained_identity_at(doc, id);
    Some(Contact {
        id: id.into(),
        public_key,
        petname: root_string(doc, &contact_key(id, "petname")).unwrap_or_default(),
        glyph: root_string(doc, &contact_key(id, "glyph")).unwrap_or_default(),
        retained_identity,
        observations: observations(doc, id),
        preferred: preferred_values(doc, id),
    })
}

fn retained_identity_at(doc: &Document, id: &str) -> Option<RetainedIdentity> {
    let variants = all_root_bytes(doc, &contact_key(id, "retained-identity"))
        .into_iter()
        .map(|bytes| proto::AuthenticatedIdentity::decode(bytes.as_slice()).ok())
        .map(|wire| wire.and_then(|wire| extract_authenticated_identity(wire).ok()))
        .collect::<Option<Vec<_>>>()?;
    let first = variants.first()?;
    let first_binding = verify_root_binding(&first.binding).ok()?;
    let signed_binding = first.binding.clone();
    if variants.iter().any(|identity| {
        validate_authenticated_identity(identity).is_err()
            || !verify_root_binding(&identity.binding).is_ok_and(|binding| {
                binding.root == first_binding.root && binding.group == first_binding.group
            })
    }) {
        return None;
    }
    let mut profiles = variants
        .iter()
        .flat_map(|identity| identity.profiles.clone())
        .collect::<Vec<_>>();
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles.dedup();
    let mut authorities = variants
        .into_iter()
        .map(|identity| RetainedAuthority {
            device: identity.authority_device,
            keyhive_authority_proof: identity.keyhive_authority_proof,
        })
        .collect::<Vec<_>>();
    authorities.sort_by(|a, b| {
        a.device
            .cmp(&b.device)
            .then_with(|| a.keyhive_authority_proof.cmp(&b.keyhive_authority_proof))
    });
    authorities.dedup();
    Some(RetainedIdentity {
        root: first_binding.root,
        binding: signed_binding,
        profiles,
        authorities,
    })
}

pub fn contacts(doc: &Document) -> Vec<Contact> {
    contact_ids(doc)
        .into_iter()
        .filter_map(|id| contact(doc, &id))
        .collect()
}

fn contact_ids(doc: &Document) -> BTreeSet<String> {
    doc.read()
        .keys(ROOT)
        .filter_map(|key| {
            let rest = key.strip_prefix("contact:")?;
            let (id, field) = rest.split_once(':')?;
            (field == "exists").then(|| id.to_string())
        })
        .collect()
}

pub fn set_label(
    doc: &mut Document,
    id: &str,
    petname: String,
    glyph: String,
) -> Result<(), String> {
    require_contact(doc, id)?;
    doc.transact(|tx| {
        tx.put(ROOT, contact_key(id, "petname"), petname)
            .map_err(|e| e.to_string())?;
        tx.put(ROOT, contact_key(id, "glyph"), glyph)
            .map_err(|e| e.to_string())
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
    let id = local_id(b"polyvisor:meeting:v0\0", &entropy, doc.actor_id());
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

pub fn meeting_record(doc: &Document, id: &str) -> Option<MeetingRecord> {
    meeting(doc, id)
}

pub fn meetings(doc: &Document) -> Vec<MeetingRecord> {
    let mut ids = BTreeSet::new();
    for key in doc.read().keys(ROOT) {
        if let Some(rest) = key.strip_prefix("meeting:")
            && let Some((id, _)) = rest.split_once(':')
        {
            ids.insert(id.to_string());
        }
    }
    let mut out: Vec<_> = ids.into_iter().filter_map(|id| meeting(doc, &id)).collect();
    out.sort_by(|a, b| b.occurred.cmp(&a.occurred).then_with(|| a.id.cmp(&b.id)));
    out
}

pub fn write_observation(
    doc: &mut Document,
    id: &str,
    observation: Observation,
) -> Result<(), String> {
    require_contact(doc, id)?;
    validate_claims(&[Claim {
        name: observation.name.clone(),
        value: observation.value.clone(),
    }])?;
    let meeting = meeting(doc, &observation.meeting)
        .ok_or_else(|| "observation has no meeting".to_string())?;
    match observation.provenance {
        Provenance::Verified
            if observation.issuer.is_some()
                && observation.claimed.is_some()
                && meeting.verified
                && meeting.source_key == observation.issuer.map(|issuer| issuer.0) => {}
        Provenance::Verified => return Err("verified observation lacks verified provenance".into()),
        Provenance::Local | Provenance::Imported
            if observation.issuer.is_none() && observation.claimed.is_none() => {}
        Provenance::Local | Provenance::Imported => {
            return Err("local/imported observation cannot claim authentication".into());
        }
    }
    let disc = observation_discriminator(&observation);
    let prefix = format!("observation:{id}:{disc}:");
    let fields = observation_fields(observation);
    doc.transact(|tx| {
        for (field, value) in fields {
            tx.put(ROOT, format!("{prefix}{field}"), value)
                .map_err(|e| e.to_string())?;
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
    let sources = observation_sources(doc, id);
    let prefixes: Vec<_> = sources
        .iter()
        .flat_map(|source| observation_prefixes(doc, source))
        .filter(|prefix| {
            root_string(doc, &format!("{prefix}name")).as_deref() == Some(name)
                && root_string(doc, &format!("{prefix}value")).as_deref() == Some(value)
        })
        .collect();
    let preferences: Vec<_> = sources
        .iter()
        .map(|source| preferred_key(source, name))
        .filter(|key| root_string(doc, key).as_deref() == Some(value))
        .collect();
    doc.transact(|tx| {
        for prefix in prefixes {
            for field in OBS_FIELDS {
                tx.delete(ROOT, format!("{prefix}{field}"))
                    .map_err(|e| e.to_string())?;
            }
        }
        for preference in preferences {
            if tx
                .get(ROOT, &preference)
                .map_err(|e| e.to_string())?
                .is_some()
            {
                tx.delete(ROOT, preference).map_err(|e| e.to_string())?;
            }
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
    if let Some(wanted) = &value
        && !observations(doc, id)
            .iter()
            .any(|o| o.name == name && &o.value == wanted)
    {
        return Err("preferred value is not an observation".into());
    }
    let key = preferred_key(id, name);
    match value {
        Some(value) => doc.transact(|tx| tx.put(ROOT, key, value).map_err(|e| e.to_string())),
        None => {
            let keys = observation_sources(doc, id)
                .into_iter()
                .map(|source| preferred_key(&source, name))
                .filter(|key| root_string(doc, key).is_some())
                .collect::<Vec<_>>();
            doc.transact(|tx| {
                for key in keys {
                    tx.delete(ROOT, key).map_err(|e| e.to_string())?;
                }
                Ok(())
            })
        }
    }
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

pub fn merge(doc: &mut Document, keyless: &str, into: &str) -> Result<(), String> {
    let source = contact(doc, keyless).ok_or_else(|| "no such keyless contact".to_string())?;
    let target = contact(doc, into).ok_or_else(|| "no such keyed contact".to_string())?;
    if source.public_key.is_some() || target.public_key.is_none() {
        return Err("contacts can only merge keyless into keyed".into());
    }
    let alias = format!("{ALIAS_PREFIX}{keyless}");
    let destination = into.to_string();
    doc.transact(|tx| tx.put(ROOT, alias, destination).map_err(|e| e.to_string()))?;
    if target.petname.is_empty() || target.glyph.is_empty() {
        set_label(
            doc,
            into,
            if target.petname.is_empty() {
                source.petname
            } else {
                target.petname
            },
            if target.glyph.is_empty() {
                source.glyph
            } else {
                target.glyph
            },
        )?;
    }
    let keys: Vec<_> = doc
        .read()
        .keys(ROOT)
        .filter(|key| key.starts_with(&format!("contact:{keyless}:")))
        .collect();
    doc.transact(|tx| {
        for key in keys {
            tx.delete(ROOT, key).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
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

pub fn parse_unsigned_import(bytes: &[u8]) -> Result<ImportReview, String> {
    bounded(bytes)?;
    let rows: Vec<JsonParty> =
        serde_json::from_slice(bytes).map_err(|_| "invalid contact JSON".to_string())?;
    if rows.len() > MAX_PARTIES {
        return Err("too many imported contacts".into());
    }
    rows.into_iter()
        .enumerate()
        .map(|(index, row)| {
            let claims = row
                .claims
                .into_iter()
                .map(|c| Claim {
                    name: c.name,
                    value: c.value,
                })
                .collect::<Vec<_>>();
            validate_claims(&claims)?;
            let public_key = row
                .public_key
                .map(|key| {
                    decode_hex32(&key)
                        .and_then(|key| valid_key(key, "contact key").map(|key| key.to_bytes()))
                })
                .transpose()?;
            Ok(ReviewParty {
                index: index as u32,
                public_key,
                claims,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parties| ImportReview { parties })
}

fn meeting(doc: &Document, id: &str) -> Option<MeetingRecord> {
    Some(MeetingRecord {
        id: id.into(),
        method: root_string(doc, &meeting_key(id, "method"))?,
        source: root_string(doc, &meeting_key(id, "source")).unwrap_or_default(),
        source_key: root_string(doc, &meeting_key(id, "source-key"))
            .filter(|s| !s.is_empty())
            .and_then(|s| decode_hex32(&s).ok()),
        occurred: root_string(doc, &meeting_key(id, "occurred"))?
            .parse()
            .ok()?,
        verified: root_string(doc, &meeting_key(id, "verified")).as_deref() == Some("true"),
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
        ("issuer", o.issuer.map(|k| hex(&k.0)).unwrap_or_default()),
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
    let mut hash = Sha256::new();
    hash.update(b"polyvisor:observation:v0\0");
    let issuer = o
        .issuer
        .as_ref()
        .map(|root| root.0.as_slice())
        .unwrap_or(&[]);
    for field in [
        issuer,
        o.name.as_bytes(),
        o.value.as_bytes(),
        o.meeting.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field);
    }
    hex(&hash.finalize()[..16])
}
fn observation_prefixes(doc: &Document, id: &str) -> BTreeSet<String> {
    let start = format!("observation:{id}:");
    doc.read()
        .keys(ROOT)
        .filter_map(|key| {
            let rest = key.strip_prefix(&start)?;
            let (disc, _) = rest.split_once(':')?;
            Some(format!("{start}{disc}:"))
        })
        .collect()
}
fn observations(doc: &Document, id: &str) -> Vec<Observation> {
    let mut seen = BTreeSet::new();
    let mut out = observation_sources(doc, id)
        .into_iter()
        .flat_map(|source| observation_prefixes(doc, &source))
        .filter_map(|prefix| {
            let discriminator = prefix.rsplit(':').nth(1)?.to_string();
            if !seen.insert(discriminator) {
                return None;
            }
            if root_string(doc, &format!("{prefix}present")).as_deref() != Some("true") {
                return None;
            }
            let provenance = match root_string(doc, &format!("{prefix}provenance")).as_deref()? {
                "Local" => Provenance::Local,
                "Imported" => Provenance::Imported,
                "Verified" => Provenance::Verified,
                _ => return None,
            };
            let claimed_seconds = root_string(doc, &format!("{prefix}claimed-seconds"));
            let claimed_nanos = root_string(doc, &format!("{prefix}claimed-nanos"));
            Some(Observation {
                name: root_string(doc, &format!("{prefix}name"))?,
                value: root_string(doc, &format!("{prefix}value"))?,
                provenance,
                issuer: root_string(doc, &format!("{prefix}issuer"))
                    .filter(|s| !s.is_empty())
                    .and_then(|s| decode_hex32(&s).ok())
                    .map(RootIdentity),
                claimed: claimed_seconds.filter(|s| !s.is_empty()).and_then(|s| {
                    Some(ClaimedTime {
                        seconds: s.parse().ok()?,
                        nanos: claimed_nanos?.parse().ok()?,
                    })
                }),
                received: root_string(doc, &format!("{prefix}received"))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                meeting: root_string(doc, &format!("{prefix}meeting")).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.value.cmp(&b.value)));
    out
}
fn preferred_values(doc: &Document, id: &str) -> Vec<(String, String)> {
    let observed = observations(doc, id);
    let mut preferred = BTreeMap::new();
    let sources = observation_sources(doc, id);
    for source in sources.iter().filter(|source| source.as_str() != id) {
        let prefix = format!("preferred:{source}:");
        for key in doc.read().keys(ROOT) {
            if let Some(encoded) = key.strip_prefix(&prefix)
                && let (Ok(name), Some(value)) = (decode_text(encoded), root_string(doc, &key))
            {
                preferred.insert(name, value);
            }
        }
    }
    let prefix = format!("preferred:{id}:");
    for key in doc.read().keys(ROOT) {
        if let Some(encoded) = key.strip_prefix(&prefix)
            && let (Ok(name), Some(value)) = (decode_text(encoded), root_string(doc, &key))
        {
            preferred.insert(name, value);
        }
    }
    preferred
        .into_iter()
        .filter(|(name, value)| {
            observed
                .iter()
                .any(|observation| observation.name == *name && observation.value == *value)
        })
        .collect()
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
fn preferred_key(id: &str, name: &str) -> String {
    format!("preferred:{id}:{}", hex(name.as_bytes()))
}
fn meeting_key(id: &str, field: &str) -> String {
    format!("meeting:{id}:{field}")
}
fn require_contact(doc: &Document, id: &str) -> Result<(), String> {
    contact(doc, id)
        .map(|_| ())
        .ok_or_else(|| format!("no contact with id {id}"))
}
fn decode_text(value: &str) -> Result<String, String> {
    if !value.len().is_multiple_of(2) {
        return Err("invalid text encoding".into());
    }
    let bytes = value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|part| u8::from_str_radix(part, 16).ok())
                .ok_or_else(|| "invalid text encoding".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    String::from_utf8(bytes).map_err(|_| "invalid text encoding".into())
}
fn derived_entropy(entropy: [u8; 32], index: u64) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"polyvisor:forwarded-contact:v0\0");
    hash.update(entropy);
    hash.update(index.to_be_bytes());
    hash.finalize().into()
}

fn proto_claim(claim: &Claim) -> proto::Claim {
    proto::Claim {
        name: claim.name.clone(),
        value: claim.value.clone(),
    }
}

fn extract_claims(claims: Vec<proto::Claim>) -> Result<Vec<Claim>, String> {
    let claims = claims
        .into_iter()
        .map(|claim| Claim {
            name: claim.name,
            value: claim.value,
        })
        .collect::<Vec<_>>();
    validate_claims(&claims)?;
    Ok(claims)
}

fn validate_claims(claims: &[Claim]) -> Result<(), String> {
    if claims.len() > MAX_CLAIMS_PER_PARTY {
        return Err("too many claims".into());
    }
    for claim in claims {
        if claim.name.len() > MAX_NAME_BYTES || claim.value.len() > MAX_VALUE_BYTES {
            return Err("claim is too large".into());
        }
    }
    Ok(())
}

fn valid_time(time: ClaimedTime) -> Result<(), String> {
    if !(MIN_TIMESTAMP_SECONDS..=MAX_TIMESTAMP_SECONDS).contains(&time.seconds)
        || time.nanos >= 1_000_000_000
    {
        return Err("invalid introduction time".into());
    }
    Ok(())
}

fn verify_signature(
    key: [u8; 32],
    domain: &[u8],
    payload: &[u8],
    signature: &[u8],
) -> Result<(), String> {
    let key = valid_key(key, "signing key")?;
    let signature =
        Signature::from_slice(signature).map_err(|_| "invalid signature".to_string())?;
    key.verify_strict(&domain_message(domain, payload), &signature)
        .map_err(|_| "signature does not verify".to_string())
}

fn valid_key(bytes: [u8; 32], what: &str) -> Result<VerifyingKey, String> {
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| format!("invalid {what}"))?;
    if key.is_weak() {
        Err(format!("weak {what}"))
    } else {
        Ok(key)
    }
}

fn key32(bytes: &[u8], what: &str) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| format!("invalid {what} length"))
}

fn require_version(version: u32, what: &str) -> Result<(), String> {
    (version == VERSION)
        .then_some(())
        .ok_or_else(|| format!("unsupported {what} version"))
}

fn bounded(bytes: &[u8]) -> Result<(), String> {
    (bytes.len() <= MAX_SIGNED_BYTES)
        .then_some(())
        .ok_or_else(|| "signed value is too large".into())
}

fn domain_message(domain: &[u8], payload: &[u8]) -> Vec<u8> {
    [domain, payload].concat()
}

fn scalar_bytes(value: Value<'_>) -> Option<Vec<u8>> {
    match value {
        Value::Scalar(value) => match value.as_ref() {
            ScalarValue::Bytes(bytes) => Some(bytes.clone()),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

fn all_root_bytes(doc: &Document, key: &str) -> BTreeSet<Vec<u8>> {
    doc.read()
        .get_all(ROOT, key)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|(value, _)| scalar_bytes(value))
        .collect()
}

fn root_string(doc: &Document, key: &str) -> Option<String> {
    doc.read()
        .get(ROOT, key)
        .ok()
        .flatten()
        .and_then(|(value, _)| value.to_str().map(str::to_string))
}

fn contact_key(id: &str, field: &str) -> String {
    format!("contact:{id}:{field}")
}

fn local_id(domain: &[u8], entropy: &[u8; 32], actor: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(entropy);
    hash.update((actor.len() as u64).to_le_bytes());
    hash.update(actor);
    hex(&hash.finalize()[..16])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("invalid public key encoding".into());
    }
    let mut out = [0; 32];
    for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        out[index] = std::str::from_utf8(pair)
            .ok()
            .and_then(|part| u8::from_str_radix(part, 16).ok())
            .ok_or_else(|| "invalid public key encoding".to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::ActorId;
    use sedimentree_core::id::SedimentreeId;
    use std::{
        pin::pin,
        task::{Context, Poll, Waker},
    };

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        let mut future = pin!(future);
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("test future unexpectedly pending"),
        }
    }

    fn doc(actor: u8) -> Document {
        Document::empty(ActorId::from(&[actor][..]), SedimentreeId::new([2; 32]))
    }

    fn signer(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn claim(value: &str) -> Claim {
        Claim {
            name: "name".into(),
            value: value.into(),
        }
    }

    fn introduction(root: &SigningKey, device: &SigningKey) -> Introduction {
        Introduction {
            issuer: authenticated_identity(root, device, 9, "Ada"),
            device: DeviceSigningKey(device.verifying_key().to_bytes()),
            authenticated_identities: vec![],
            parties: vec![],
            issued_at: ClaimedTime {
                seconds: 1,
                nanos: 2,
            },
        }
    }

    fn authenticated_identity(
        root: &SigningKey,
        device: &SigningKey,
        group: u8,
        name: &str,
    ) -> AuthenticatedIdentity {
        AuthenticatedIdentity {
            binding: sign_root_binding(root, GroupId([group; 32])),
            profiles: vec![sign_profile(root, vec![claim(name)]).unwrap()],
            authority_device: DeviceSigningKey(device.verifying_key().to_bytes()),
            keyhive_authority_proof: vec![1, 2, 3],
        }
    }

    #[test]
    fn domains_prevent_signature_type_confusion() {
        let root = signer(1);
        let binding = sign_root_binding(&root, GroupId([9; 32]));
        let signed_binding = proto::SignedRootBinding::decode(binding.as_bytes()).unwrap();
        let confused = proto::SignedProfile {
            profile: signed_binding.binding,
            signature: signed_binding.signature,
        }
        .encode_to_vec();
        assert!(SignedProfile::from_bytes(confused).is_err());

        let profile = sign_profile(&root, vec![claim("Ada")]).unwrap();
        let signed_profile = proto::SignedProfile::decode(profile.as_bytes()).unwrap();
        let confused = proto::SignedRootBinding {
            binding: signed_profile.profile,
            signature: signed_profile.signature,
        }
        .encode_to_vec();
        assert!(SignedRootBinding::from_bytes(confused).is_err());
    }

    #[test]
    fn substitution_of_root_group_profile_or_device_is_rejected() {
        let root = signer(1);
        let other_root = signer(2);
        let device = signer(3);
        let other_device = signer(4);
        let mut intro = introduction(&root, &device);

        intro.issuer.binding = sign_root_binding(&other_root, GroupId([9; 32]));
        assert!(sign_introduction(&intro, &device).is_err());
        intro.issuer.binding = sign_root_binding(&root, GroupId([9; 32]));
        intro.issuer.profiles = vec![sign_profile(&other_root, vec![claim("Mallory")]).unwrap()];
        assert!(sign_introduction(&intro, &device).is_err());
        intro.issuer.profiles = vec![sign_profile(&root, vec![claim("Ada")]).unwrap()];
        assert!(sign_introduction(&intro, &other_device).is_err());

        let bytes = sign_introduction(&intro, &device).unwrap();
        let mut envelope = proto::SignedIntroduction::decode(bytes.as_slice()).unwrap();
        let mut payload = proto::Introduction::decode(envelope.introduction.as_slice()).unwrap();
        payload.device_signing_key = other_device.verifying_key().to_bytes().to_vec();
        envelope.introduction = payload.encode_to_vec();
        assert!(verify_introduction(&envelope.encode_to_vec()).is_err());
    }

    #[test]
    fn profile_concurrency_is_explicit_and_root_resolution_overwrites_observed_variants() {
        let root = signer(1);
        let binding = sign_root_binding(&root, GroupId([9; 32]));
        let mut base = doc(1);
        bind_root(&mut base, binding).unwrap();
        let snapshot = base.save();
        let tree = base.tree();
        let mut left = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut right = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);
        write_self_profile(&mut left, sign_profile(&root, vec![claim("Left")]).unwrap()).unwrap();
        write_self_profile(
            &mut right,
            sign_profile(&root, vec![claim("Right")]).unwrap(),
        )
        .unwrap();
        left.merge_snapshot(&right.save()).unwrap();
        assert_eq!(self_profile(&left).unwrap().variants.len(), 2);

        let observed = self_profile(&left).unwrap().variants;
        resolve_self_profile(&mut left, &root, &observed, vec![claim("Chosen")]).unwrap();
        let resolved = self_profile(&left).unwrap();
        assert_eq!(resolved.variants.len(), 1);
        assert_eq!(
            verify_profile(&resolved.variants[0]).unwrap().claims,
            vec![claim("Chosen")]
        );

        let stale = resolved.variants.clone();
        write_self_profile(&mut left, sign_profile(&root, vec![claim("New")]).unwrap()).unwrap();
        assert!(resolve_self_profile(&mut left, &root, &stale, vec![claim("Stale")]).is_err());
    }

    #[test]
    fn profile_subject_and_issuer_must_be_the_same_root() {
        let root = signer(1);
        let other = signer(2);
        let payload = proto::Profile {
            version: VERSION,
            subject_root: root.verifying_key().to_bytes().to_vec(),
            issuer_root: other.verifying_key().to_bytes().to_vec(),
            claims: vec![proto_claim(&claim("Ada"))],
        }
        .encode_to_vec();
        let signature = other.sign(&domain_message(PROFILE_DOMAIN, &payload));
        let bytes = proto::SignedProfile {
            profile: payload,
            signature: signature.to_bytes().to_vec(),
        }
        .encode_to_vec();
        assert!(SignedProfile::from_bytes(bytes).is_err());
    }

    #[test]
    fn one_group_per_root_and_root_is_not_device_signer() {
        let root = signer(1);
        let device = signer(3);
        let mut document = doc(1);
        let binding = sign_root_binding(&root, GroupId([9; 32]));
        assert!(bind_root(&mut document, binding.clone()).unwrap());
        assert!(!bind_root(&mut document, binding).unwrap());
        assert!(bind_root(&mut document, sign_root_binding(&root, GroupId([8; 32]))).is_err());

        let intro = introduction(&root, &device);
        assert_ne!(
            verify_root_binding(&intro.issuer.binding).unwrap().root.0,
            intro.device.0
        );
        let verified = verify_introduction(&sign_introduction(&intro, &device).unwrap()).unwrap();
        assert_eq!(verified.authority_requests()[0].device, intro.device);

        let snapshot = doc(8).save();
        let tree = document.tree();
        let mut left = Document::load(&snapshot, ActorId::from(&[8_u8][..]), tree);
        let mut right = Document::load(&snapshot, ActorId::from(&[9_u8][..]), tree);
        bind_root(&mut left, sign_root_binding(&root, GroupId([9; 32]))).unwrap();
        bind_root(&mut right, sign_root_binding(&root, GroupId([8; 32]))).unwrap();
        left.merge_snapshot(&right.save()).unwrap();
        assert!(root_binding(&left).is_none());
        assert!(bind_root(&mut left, sign_root_binding(&root, GroupId([9; 32]))).is_err());
    }

    #[test]
    fn authority_success_is_explicit_and_exact_before_persistence() {
        let root = signer(1);
        let device = signer(3);
        let bytes = sign_introduction(&introduction(&root, &device), &device).unwrap();
        let pending = verify_introduction(&bytes).unwrap();
        let request = pending.authority_requests()[0].clone();
        assert!(
            block_on(validate_authority(pending, |actual| async move {
                if actual.group != GroupId([8; 32]) || actual.device != request.device {
                    Err("Keyhive rejected exact group/device binding".into())
                } else {
                    Ok(())
                }
            }))
            .is_err()
        );

        let pending = verify_introduction(&bytes).unwrap();
        let request = pending.authority_requests()[0].clone();
        let verified = block_on(validate_authority(pending, |actual| {
            let request = request.clone();
            async move {
                assert_eq!(actual, request);
                Ok(())
            }
        }))
        .unwrap();
        let verified = verified.select(&[request.root], &[]).unwrap();
        let mut document = doc(7);
        let id = persist_verified_introduction(
            &mut document,
            verified,
            "friend".into(),
            "🐈".into(),
            [7; 32],
            7,
        )
        .unwrap();
        let retained = contact(&document, &id).unwrap().retained_identity.unwrap();
        assert_eq!(
            retained.authorities[0].keyhive_authority_proof,
            vec![1, 2, 3]
        );

        let intro_signature = proto::SignedIntroduction::decode(bytes.as_slice())
            .unwrap()
            .signature;
        let intro_payload = proto::SignedIntroduction::decode(bytes.as_slice())
            .unwrap()
            .introduction;
        for key in document.read().keys(ROOT) {
            for (value, _) in document.read().get_all(ROOT, &key).unwrap() {
                if let Some(bytes) = scalar_bytes(value) {
                    assert_ne!(bytes, intro_signature);
                    assert_ne!(bytes, intro_payload);
                }
            }
        }
    }

    #[test]
    fn forwards_foreign_root_signed_profile() {
        let alice = signer(1);
        let alice_device = signer(3);
        let bob = signer(2);
        let bob_device = signer(4);
        let mut intro = introduction(&alice, &alice_device);
        intro
            .authenticated_identities
            .push(authenticated_identity(&bob, &bob_device, 8, "Bob"));
        let pending =
            verify_introduction(&sign_introduction(&intro, &alice_device).unwrap()).unwrap();
        assert_eq!(pending.authority_requests().len(), 2);
        let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
        let verified = verified
            .select(
                &[
                    RootIdentity(alice.verifying_key().to_bytes()),
                    RootIdentity(bob.verifying_key().to_bytes()),
                ],
                &[],
            )
            .unwrap();
        let mut document = doc(1);
        persist_verified_introduction(
            &mut document,
            verified,
            "Alice".into(),
            String::new(),
            [7; 32],
            7,
        )
        .unwrap();
        let bob_contact = contacts(&document)
            .into_iter()
            .find(|contact| contact.public_key == Some(bob.verifying_key().to_bytes()))
            .unwrap();
        assert_eq!(
            bob_contact.retained_identity.unwrap().official_profiles()[0].claims,
            vec![claim("Bob")]
        );
        assert!(bob_contact.observations.is_empty());
    }

    #[test]
    fn retained_root_group_substitution_and_conflicts_fail_closed() {
        let root = signer(1);
        let device = signer(3);
        let persist = |document: &mut Document, group, entropy| {
            let mut intro = introduction(&root, &device);
            intro.issuer = authenticated_identity(&root, &device, group, "Ada");
            let pending =
                verify_introduction(&sign_introduction(&intro, &device).unwrap()).unwrap();
            let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
            let verified = verified
                .select(&[RootIdentity(root.verifying_key().to_bytes())], &[])
                .unwrap();
            persist_verified_introduction(
                document,
                verified,
                String::new(),
                String::new(),
                entropy,
                1,
            )
        };
        let mut document = doc(1);
        persist(&mut document, 9, [1; 32]).unwrap();
        assert!(persist(&mut document, 8, [2; 32]).is_err());
        let mut left = doc(2);
        let mut right = doc(3);
        persist(&mut left, 9, [3; 32]).unwrap();
        persist(&mut right, 8, [3; 32]).unwrap();
        left.merge_snapshot(&right.save()).unwrap();
        assert!(persist(&mut left, 9, [4; 32]).is_err());
    }

    #[test]
    fn concurrent_same_root_group_authorities_and_profiles_remain_usable() {
        let root = signer(1);
        let first_device = signer(2);
        let second_device = signer(3);
        let mut base = doc(1);
        let persist = |document: &mut Document, device: &SigningKey, name: &str, entropy| {
            let mut intro = introduction(&root, device);
            intro.issuer = authenticated_identity(&root, device, 9, name);
            let pending = verify_introduction(&sign_introduction(&intro, device).unwrap()).unwrap();
            let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
            let selected = verified
                .select(&[RootIdentity(root.verifying_key().to_bytes())], &[])
                .unwrap();
            persist_verified_introduction(
                document,
                selected,
                String::new(),
                String::new(),
                entropy,
                1,
            )
        };
        persist(&mut base, &first_device, "First", [1; 32]).unwrap();
        let snapshot = base.save();
        let tree = base.tree();
        let mut left = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut right = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);
        persist(&mut left, &first_device, "Left", [2; 32]).unwrap();
        persist(&mut right, &second_device, "Right", [3; 32]).unwrap();
        left.merge_snapshot(&right.save()).unwrap();
        let retained = contacts(&left)
            .into_iter()
            .find_map(|contact| contact.retained_identity)
            .unwrap();
        assert_eq!(retained.authorities.len(), 2);
        assert_eq!(retained.profiles.len(), 2);
        assert!(persist(&mut left, &first_device, "Refresh", [4; 32]).is_ok());
    }

    #[test]
    fn persistence_honors_verified_identity_and_party_selection() {
        let alice = signer(1);
        let alice_device = signer(2);
        let bob = signer(3);
        let bob_device = signer(4);
        let observed = signer(5).verifying_key().to_bytes();
        let mut intro = introduction(&alice, &alice_device);
        intro
            .authenticated_identities
            .push(authenticated_identity(&bob, &bob_device, 8, "Bob"));
        intro.parties.push(Party {
            public_key: observed,
            observations: vec![claim("Observed")],
        });
        let pending =
            verify_introduction(&sign_introduction(&intro, &alice_device).unwrap()).unwrap();
        let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
        assert!(
            verified
                .clone()
                .select(&[RootIdentity([0; 32])], &[])
                .is_err()
        );
        let selected = verified
            .select(&[RootIdentity(bob.verifying_key().to_bytes())], &[0])
            .unwrap();
        let mut document = doc(1);
        persist_verified_introduction(
            &mut document,
            selected,
            String::new(),
            String::new(),
            [7; 32],
            9,
        )
        .unwrap();
        let stored = contacts(&document);
        assert!(stored.iter().any(|contact| {
            contact.retained_identity.as_ref().is_some_and(|identity| {
                identity.root == RootIdentity(bob.verifying_key().to_bytes())
            })
        }));
        assert!(
            stored
                .iter()
                .all(|contact| contact
                    .retained_identity
                    .as_ref()
                    .is_none_or(
                        |identity| identity.root != RootIdentity(alice.verifying_key().to_bytes())
                    ))
        );
        let observation = stored
            .iter()
            .find(|contact| contact.public_key == Some(observed))
            .unwrap()
            .observations
            .first()
            .unwrap();
        assert_eq!(
            observation.issuer,
            Some(RootIdentity(alice.verifying_key().to_bytes()))
        );
    }

    #[test]
    fn empty_and_forward_only_selection_do_not_create_issuer_rows() {
        let alice = signer(1);
        let alice_device = signer(2);
        let bob = signer(3);
        let bob_device = signer(4);
        let mut intro = introduction(&alice, &alice_device);
        intro
            .authenticated_identities
            .push(authenticated_identity(&bob, &bob_device, 8, "Bob"));
        let bytes = sign_introduction(&intro, &alice_device).unwrap();

        let pending = verify_introduction(&bytes).unwrap();
        let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
        let empty = verified.select(&[], &[]).unwrap();
        let mut document = doc(1);
        assert!(
            persist_verified_introduction(
                &mut document,
                empty,
                String::new(),
                String::new(),
                [1; 32],
                1
            )
            .is_err()
        );
        assert!(contacts(&document).is_empty());

        let pending = verify_introduction(&bytes).unwrap();
        let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
        let selected = verified
            .select(&[RootIdentity(bob.verifying_key().to_bytes())], &[])
            .unwrap();
        persist_verified_introduction(
            &mut document,
            selected,
            String::new(),
            String::new(),
            [2; 32],
            1,
        )
        .unwrap();
        let stored = contacts(&document);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].public_key, Some(bob.verifying_key().to_bytes()));
    }

    #[test]
    fn selected_identity_reuses_existing_public_key_contact() {
        let root = signer(1);
        let device = signer(2);
        let mut document = doc(1);
        let existing = create_contact(
            &mut document,
            Some(root.verifying_key().to_bytes()),
            "known".into(),
            String::new(),
            [1; 32],
        )
        .unwrap();
        let bytes = sign_introduction(&introduction(&root, &device), &device).unwrap();
        let pending = verify_introduction(&bytes).unwrap();
        let verified = block_on(validate_authority(pending, |_| async { Ok(()) })).unwrap();
        let selected = verified
            .select(&[RootIdentity(root.verifying_key().to_bytes())], &[])
            .unwrap();
        let affected = persist_verified_introduction(
            &mut document,
            selected,
            String::new(),
            String::new(),
            [2; 32],
            1,
        )
        .unwrap();
        assert_eq!(affected, existing);
        assert_eq!(contacts(&document).len(), 1);
        assert!(
            contact(&document, &existing)
                .unwrap()
                .retained_identity
                .is_some()
        );
    }

    #[test]
    fn crud_and_provenance_remain_available() {
        let mut document = doc(1);
        let keyless =
            create_contact(&mut document, None, "import".into(), String::new(), [1; 32]).unwrap();
        let meeting = create_meeting(
            &mut document,
            "file".into(),
            "contacts.json".into(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        write_observation(
            &mut document,
            &keyless,
            Observation {
                name: "name".into(),
                value: "Ada".into(),
                provenance: Provenance::Imported,
                issuer: None,
                claimed: None,
                received: 2,
                meeting,
            },
        )
        .unwrap();
        set_preferred(&mut document, &keyless, "name", Some("Ada".into())).unwrap();
        let keyed = create_contact(
            &mut document,
            Some(signer(5).verifying_key().to_bytes()),
            "friend".into(),
            String::new(),
            [3; 32],
        )
        .unwrap();
        merge(&mut document, &keyless, &keyed).unwrap();
        assert_eq!(
            contact(&document, &keyed).unwrap().preferred,
            vec![("name".into(), "Ada".into())]
        );
        assert_eq!(
            contact(&document, &keyed).unwrap().observations[0].provenance,
            Provenance::Imported
        );
        set_label(&mut document, &keyed, "renamed".into(), "🐈".into()).unwrap();
        delete_contact(&mut document, &keyed).unwrap();
        assert!(contact(&document, &keyed).is_none());
        assert_eq!(
            parse_unsigned_import(br#"[{"claims":[{"name":"name","value":"A"}]}]"#)
                .unwrap()
                .parties
                .len(),
            1
        );
    }

    #[test]
    fn verified_provenance_requires_matching_meeting_issuer() {
        let mut document = doc(1);
        let id =
            create_contact(&mut document, None, String::new(), String::new(), [1; 32]).unwrap();
        let issuer = RootIdentity(signer(2).verifying_key().to_bytes());
        let other = signer(3).verifying_key().to_bytes();
        let meeting = create_meeting(
            &mut document,
            "intro".into(),
            String::new(),
            Some(other),
            1,
            true,
            [2; 32],
        )
        .unwrap();
        assert!(
            write_observation(
                &mut document,
                &id,
                Observation {
                    name: "name".into(),
                    value: "Ada".into(),
                    provenance: Provenance::Verified,
                    issuer: Some(issuer),
                    claimed: Some(ClaimedTime {
                        seconds: 1,
                        nanos: 0
                    }),
                    received: 1,
                    meeting
                }
            )
            .is_err()
        );
    }

    #[test]
    fn keyless_merge_preserves_concurrent_source_observation() {
        let mut base = doc(1);
        let target = create_contact(
            &mut base,
            Some(signer(5).verifying_key().to_bytes()),
            String::new(),
            String::new(),
            [1; 32],
        )
        .unwrap();
        let source =
            create_contact(&mut base, None, String::new(), String::new(), [2; 32]).unwrap();
        let snapshot = base.save();
        let tree = base.tree();
        let mut merger = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut writer = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);
        merge(&mut merger, &source, &target).unwrap();
        let meeting = create_meeting(
            &mut writer,
            "manual".into(),
            String::new(),
            None,
            1,
            false,
            [3; 32],
        )
        .unwrap();
        write_observation(
            &mut writer,
            &source,
            Observation {
                name: "late".into(),
                value: "arrived".into(),
                provenance: Provenance::Local,
                issuer: None,
                claimed: None,
                received: 1,
                meeting,
            },
        )
        .unwrap();
        merger.merge_snapshot(&writer.save()).unwrap();
        assert_eq!(
            contact(&merger, &target).unwrap().observations[0].value,
            "arrived"
        );
    }

    #[test]
    fn alias_preferences_keep_destination_precedence_and_clear_exactly() {
        let mut document = doc(1);
        let target = create_contact(
            &mut document,
            Some(signer(5).verifying_key().to_bytes()),
            String::new(),
            String::new(),
            [1; 32],
        )
        .unwrap();
        let source =
            create_contact(&mut document, None, String::new(), String::new(), [2; 32]).unwrap();
        let meeting = create_meeting(
            &mut document,
            "manual".into(),
            String::new(),
            None,
            1,
            false,
            [3; 32],
        )
        .unwrap();
        for (id, value) in [(&source, "source"), (&target, "destination")] {
            write_observation(
                &mut document,
                id,
                Observation {
                    name: "name".into(),
                    value: value.into(),
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received: 1,
                    meeting: meeting.clone(),
                },
            )
            .unwrap();
            set_preferred(&mut document, id, "name", Some(value.into())).unwrap();
        }
        merge(&mut document, &source, &target).unwrap();
        assert_eq!(
            contact(&document, &target).unwrap().preferred,
            vec![("name".into(), "destination".into())]
        );
        remove_observation(&mut document, &target, "name", "source").unwrap();
        assert_eq!(
            contact(&document, &target).unwrap().preferred,
            vec![("name".into(), "destination".into())]
        );
        set_preferred(&mut document, &target, "name", None).unwrap();
        assert!(contact(&document, &target).unwrap().preferred.is_empty());
    }

    #[test]
    fn adoption_preserves_source_profile_conflicts_and_local_contacts() {
        let root = signer(1);
        let binding = sign_root_binding(&root, GroupId([9; 32]));
        let mut source = doc(1);
        bind_root(&mut source, binding).unwrap();
        let snapshot = source.save();
        let tree = source.tree();
        let mut left = Document::load(&snapshot, ActorId::from(&[2_u8][..]), tree);
        let mut right = Document::load(&snapshot, ActorId::from(&[3_u8][..]), tree);
        write_self_profile(&mut left, sign_profile(&root, vec![claim("Left")]).unwrap()).unwrap();
        write_self_profile(
            &mut right,
            sign_profile(&root, vec![claim("Right")]).unwrap(),
        )
        .unwrap();
        left.merge_snapshot(&right.save()).unwrap();
        let mut joiner = doc(4);
        let local =
            create_contact(&mut joiner, None, "local".into(), String::new(), [4; 32]).unwrap();
        adopt(&mut joiner, &left).unwrap();
        assert_eq!(self_profile(&joiner).unwrap().variants.len(), 2);
        assert!(contact(&joiner, &local).is_some());
    }

    #[test]
    fn replicated_document_has_no_seed_and_local_ids_ignore_root_keys() {
        let root = signer(1);
        let mut first = doc(1);
        bind_root(&mut first, sign_root_binding(&root, GroupId([9; 32]))).unwrap();
        let id = create_contact(
            &mut first,
            Some(root.verifying_key().to_bytes()),
            String::new(),
            String::new(),
            [5; 32],
        )
        .unwrap();
        assert_ne!(id, hex(&root.verifying_key().to_bytes()[..16]));
        let saved = first.save();
        assert!(!saved.windows(32).any(|window| window == root.as_bytes()));

        let mut second = doc(1);
        let other_root = signer(2);
        bind_root(
            &mut second,
            sign_root_binding(&other_root, GroupId([9; 32])),
        )
        .unwrap();
        let other_id = create_contact(
            &mut second,
            Some(other_root.verifying_key().to_bytes()),
            String::new(),
            String::new(),
            [5; 32],
        )
        .unwrap();
        assert_eq!(id, other_id);
    }
}
