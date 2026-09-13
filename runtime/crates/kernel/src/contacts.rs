//! Root-authenticated identity and the private contacts document.

use crate::{Error, ErrorCode, Event, IdentityContext, Kernel, engine_failed};
use ed25519_dalek::SigningKey;
use polyvisor_contacts_model as model;

pub const CONTACTS_APP: &str = "polyvisor:contacts";

pub use model::{
    AuthenticatedIdentity, Claim, ClaimedTime, Contact, ImportReview, Introduction, MeetingRecord,
    Observation, Party, Profile, Provenance, SelfProfile, VerifiedIntroduction,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdentityStatus {
    pub root: [u8; 32],
    pub group: [u8; 32],
    pub has_root: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub index: u32,
    pub claims: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedIdentityReview {
    pub root: [u8; 32],
    pub group: [u8; 32],
    /// Whole signed-profile variants, decoded only for accurate display.
    pub profiles: Vec<Vec<Claim>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedIntroductionReview {
    pub identities: Vec<AuthenticatedIdentityReview>,
    pub parties: Vec<Party>,
    pub issued_at: ClaimedTime,
}

impl Kernel {
    /// Establish identity only when the contacts document has no root. The
    /// root seed is freshly random and independent of the device seed.
    pub(crate) async fn initialize_contacts(&self) -> Result<bool, Error> {
        let engine = self.engine()?;
        let group = engine.authority_group().await.map_err(engine_failed)?;
        if let Some(profile) = engine
            .document_read(CONTACTS_APP, model::self_profile)
            .await
            .map_err(engine_failed)?
        {
            self.validate_profile_context(&profile, group)?;
            return Ok(false);
        }
        let mut root_seed = [0; 32];
        self.seams.rng.fill(&mut root_seed);
        let root = SigningKey::from_bytes(&root_seed);
        let binding = model::sign_root_binding(&root, model::GroupId::from_bytes(group));
        let name = self
            .state
            .borrow()
            .device
            .as_ref()
            .and_then(|device| device.meta.user.get("name"))
            .cloned()
            .unwrap_or_default();
        let profile = model::sign_profile(
            &root,
            (!name.is_empty())
                .then_some(Claim {
                    name: "name".into(),
                    value: name,
                })
                .into_iter()
                .collect(),
        )
        .map_err(refused)?;
        engine
            .document_mutate(CONTACTS_APP, move |doc| {
                model::bind_root(doc, binding)?;
                model::write_self_profile(doc, profile)
            })
            .await
            .map_err(engine_failed)?;
        self.with_device(|device| {
            device.root_seed = Some(root_seed);
            Ok(())
        })?;
        Ok(true)
    }

    pub async fn identity_status(&self) -> Result<IdentityStatus, Error> {
        let profile = self.contacts_profile().await?;
        let binding = model::verify_root_binding(&profile.binding).map_err(refused)?;
        Ok(IdentityStatus {
            root: profile.root.to_bytes(),
            group: binding.group.to_bytes(),
            has_root: self.root_seed().is_some(),
        })
    }

    pub async fn contacts_items(&self) -> Result<Vec<Contact>, Error> {
        self.identity_open()?;
        self.engine()?
            .document_read(CONTACTS_APP, model::contacts)
            .await
            .map_err(engine_failed)
    }

    pub async fn contacts_get(&self, id: String) -> Result<Contact, Error> {
        self.identity_open()?;
        self.engine()?
            .document_read(CONTACTS_APP, move |doc| model::contact(doc, &id))
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "no such contact"))
    }

    pub async fn contacts_profile(&self) -> Result<SelfProfile, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let engine = self.engine()?;
        let profile = engine
            .document_read(CONTACTS_APP, model::self_profile)
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::Unavailable, "the user identity is not ready"))?;
        let group = engine.authority_group().await.map_err(engine_failed)?;
        if !self.identity_context_is(context) {
            return Err(identity_changed());
        }
        self.validate_profile_context(&profile, group)?;
        Ok(profile)
    }

    pub async fn contacts_resolve_profile(
        &self,
        mut observed_variants: Vec<Vec<u8>>,
        claims: Vec<Claim>,
    ) -> Result<SelfProfile, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let current_profile = self.contacts_profile().await?;
        let mut current: Vec<_> = current_profile
            .variants
            .iter()
            .map(|v| v.as_bytes().to_vec())
            .collect();
        current.sort();
        observed_variants.sort();
        if current != observed_variants {
            return Err(Error::new(
                ErrorCode::Refused,
                "the self-profile changed; review every current variant again",
            ));
        }
        let root = SigningKey::from_bytes(&self.require_root_seed()?);
        self.contacts_mutate_in(context, move |doc| {
            model::resolve_self_profile(doc, &root, &current_profile.variants, claims).map(|_| ())
        })
        .await?;
        self.contacts_profile().await
    }

    pub async fn contacts_create(
        &self,
        public_key: Vec<u8>,
        mut petname: String,
        glyph: String,
    ) -> Result<String, Error> {
        self.identity_open()?;
        if petname.is_empty() {
            petname = crate::device::generate_petname(self.seams.rng.as_ref(), "");
        }
        let public_key = optional_key(public_key)?;
        let entropy = self.fresh_contacts_entropy();
        self.contacts_mutate(move |doc| {
            model::create_contact(doc, public_key, petname, glyph, entropy)
        })
        .await
    }

    pub async fn contacts_meetings(&self) -> Result<Vec<MeetingRecord>, Error> {
        self.identity_open()?;
        self.engine()?
            .document_read(CONTACTS_APP, model::meetings)
            .await
            .map_err(engine_failed)
    }

    pub async fn contacts_set_label(
        &self,
        id: String,
        petname: String,
        glyph: String,
    ) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::set_label(doc, &id, petname, glyph))
            .await
    }

    pub async fn contacts_set_observation(
        &self,
        id: String,
        name: String,
        value: String,
    ) -> Result<(), Error> {
        let received = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        self.contacts_mutate(move |doc| {
            let meeting = model::create_meeting(
                doc,
                "entered by hand".into(),
                String::new(),
                None,
                received,
                false,
                entropy,
            )?;
            model::write_observation(
                doc,
                &id,
                Observation {
                    name,
                    value,
                    provenance: Provenance::Local,
                    issuer: None,
                    claimed: None,
                    received,
                    meeting,
                },
            )
        })
        .await
    }

    pub async fn contacts_remove_observation(
        &self,
        id: String,
        name: String,
        value: String,
    ) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::remove_observation(doc, &id, &name, &value))
            .await
    }

    pub async fn contacts_set_preferred(
        &self,
        id: String,
        name: String,
        value: Option<String>,
    ) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::set_preferred(doc, &id, &name, value))
            .await
    }

    pub async fn contacts_delete(&self, id: String) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::delete_contact(doc, &id))
            .await
    }

    pub async fn contacts_merge(&self, keyless: String, into: String) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::merge(doc, &keyless, &into))
            .await
    }

    pub async fn contacts_import_preview(&self, bytes: Vec<u8>) -> Result<ImportReview, Error> {
        self.identity_open()?;
        model::parse_unsigned_import(&bytes).map_err(refused)
    }

    pub async fn contacts_import_unsigned(
        &self,
        bytes: Vec<u8>,
        source: String,
        selections: Vec<Selection>,
    ) -> Result<Vec<String>, Error> {
        self.identity_open()?;
        let review = model::parse_unsigned_import(&bytes).map_err(refused)?;
        let received = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        self.contacts_mutate(move |doc| {
            let meeting = model::create_meeting(
                doc,
                "imported from a file".into(),
                source,
                None,
                received,
                false,
                entropy,
            )?;
            let mut ids = Vec::new();
            for selection in selections {
                let party = review
                    .parties
                    .iter()
                    .find(|p| p.index == selection.index)
                    .ok_or_else(|| "an import selection names no reviewed party".to_string())?;
                if !selection.claims.iter().all(|(name, value)| {
                    party
                        .claims
                        .iter()
                        .any(|c| c.name == *name && c.value == *value)
                }) {
                    return Err("a selected claim was not in the preview".into());
                }
                let mut per_contact = entropy;
                per_contact[..4].copy_from_slice(&(selection.index + 1).to_le_bytes());
                let id = model::create_contact(
                    doc,
                    party.public_key,
                    String::new(),
                    String::new(),
                    per_contact,
                )?;
                for (name, value) in selection.claims {
                    model::write_observation(
                        doc,
                        &id,
                        Observation {
                            name,
                            value,
                            provenance: Provenance::Imported,
                            issuer: None,
                            claimed: None,
                            received,
                            meeting: meeting.clone(),
                        },
                    )?;
                }
                ids.push(id);
            }
            Ok(ids)
        })
        .await
    }

    /// Device-signed introduction containing the complete current official
    /// profile variants and public Keyhive authority proof. Root custody is
    /// deliberately unnecessary.
    pub async fn contacts_share(
        &self,
        expected_root: [u8; 32],
        expected_profiles: Vec<Vec<u8>>,
        forwarded_contact_ids: Vec<String>,
        expected_forwarded: Vec<AuthenticatedIdentity>,
        parties: Vec<model::Party>,
    ) -> Result<Vec<u8>, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let profile = self.contacts_profile().await?;
        let mut current_profiles = profile
            .variants
            .iter()
            .map(|profile| profile.as_bytes().to_vec())
            .collect::<Vec<_>>();
        let mut expected_profiles = expected_profiles;
        current_profiles.sort();
        expected_profiles.sort();
        if profile.root.to_bytes() != expected_root || current_profiles != expected_profiles {
            return Err(Error::new(
                ErrorCode::Refused,
                "the displayed self identity changed before sharing",
            ));
        }
        let engine = self.engine()?;
        let proof = engine.membership_proof().await.map_err(engine_failed)?;
        let contacts = self.contacts_items().await?;
        let mut authenticated_identities = Vec::with_capacity(forwarded_contact_ids.len());
        for id in forwarded_contact_ids {
            let retained = contacts
                .iter()
                .find(|contact| contact.id == id)
                .and_then(|contact| contact.retained_identity.clone())
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::Refused,
                        "a selected contact has no authenticated identity to forward",
                    )
                })?;
            let authority = retained.authorities.first().ok_or_else(|| {
                Error::new(
                    ErrorCode::Refused,
                    "a selected contact has no retained authority proof",
                )
            })?;
            authenticated_identities.push(AuthenticatedIdentity {
                binding: retained.binding,
                profiles: retained.profiles,
                authority_device: authority.device,
                keyhive_authority_proof: authority.keyhive_authority_proof.clone(),
            });
        }
        if authenticated_identities != expected_forwarded {
            return Err(Error::new(
                ErrorCode::Refused,
                "a displayed forwarded identity changed before sharing",
            ));
        }
        // Proof generation and contact reads both await. Re-read the complete
        // displayed identity and capture the device seed only after those
        // operations, immediately before signing.
        let current_profile = self.contacts_profile().await?;
        if current_profile != profile {
            return Err(Error::new(
                ErrorCode::Refused,
                "the displayed self identity changed before sharing",
            ));
        }
        let device_seed = self.state.borrow().seed;
        if !self.identity_context_is(context) {
            return Err(identity_changed());
        }
        let introduction = Introduction {
            issuer: AuthenticatedIdentity {
                binding: profile.binding,
                profiles: profile.variants,
                authority_device: model::DeviceSigningKey::from_bytes(
                    engine.verifying_key().to_bytes(),
                ),
                keyhive_authority_proof: proof,
            },
            device: model::DeviceSigningKey::from_bytes(engine.verifying_key().to_bytes()),
            authenticated_identities,
            parties,
            issued_at: claimed_time(self.seams.clock.now_ms())?,
        };
        model::sign_introduction(&introduction, &SigningKey::from_bytes(&device_seed))
            .map_err(refused)
    }

    pub(crate) async fn contacts_validate_introduction(
        &self,
        bytes: &[u8],
    ) -> Result<VerifiedIntroduction, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let pending = model::verify_introduction(bytes).map_err(refused)?;
        let engine = self.engine()?;
        let verified = model::validate_authority(pending, |request| {
            let engine = engine.clone();
            async move {
                engine
                    .verify_membership(
                        request.keyhive_authority_proof.as_slice(),
                        request.group.to_bytes(),
                        request.device.to_bytes(),
                    )
                    .await
            }
        })
        .await
        .map_err(refused)?;
        if !self.identity_context_is(context) {
            return Err(identity_changed());
        }
        Ok(verified)
    }

    pub(crate) async fn contacts_validate_meeting_introduction(
        &self,
        bytes: &[u8],
    ) -> Result<VerifiedIntroduction, Error> {
        let verified = self.contacts_validate_introduction(bytes).await?;
        let introduction = verified.introduction();
        if !introduction.authenticated_identities.is_empty() || !introduction.parties.is_empty() {
            return Err(Error::new(
                ErrorCode::Refused,
                "a meeting card must contain only its issuer identity",
            ));
        }
        Ok(verified)
    }

    pub async fn contacts_signed_preview(
        &self,
        bytes: Vec<u8>,
    ) -> Result<SignedIntroductionReview, Error> {
        self.identity_open()?;
        let verified = self.contacts_validate_introduction(&bytes).await?;
        let introduction = verified.introduction();
        let identities = std::iter::once(&introduction.issuer)
            .chain(&introduction.authenticated_identities)
            .map(|identity| {
                let binding = model::verify_root_binding(&identity.binding)?;
                let profiles = identity
                    .profiles
                    .iter()
                    .map(model::verify_profile)
                    .map(|profile| profile.map(|profile| profile.claims))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(AuthenticatedIdentityReview {
                    root: binding.root.to_bytes(),
                    group: binding.group.to_bytes(),
                    profiles,
                })
            })
            .collect::<Result<Vec<_>, String>>()
            .map_err(refused)?;
        Ok(SignedIntroductionReview {
            identities,
            parties: introduction.parties.clone(),
            issued_at: introduction.issued_at,
        })
    }

    pub(crate) async fn contacts_accept_meeting(
        &self,
        generation: u32,
        verified: VerifiedIntroduction,
    ) -> Result<String, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let issuer = model::verify_root_binding(&verified.introduction().issuer.binding)
            .map_err(refused)?
            .root;
        if !self.meeting_is_generation(generation) {
            return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
        }
        let received = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        self.contacts_mutate_in(context, move |doc| {
            if !self.meeting_is_generation(generation) {
                return Err("that meeting was replaced".into());
            }
            let selected = verified.select(&[issuer], &[])?;
            model::persist_verified_introduction(
                doc,
                selected,
                String::new(),
                String::new(),
                entropy,
                received,
            )
        })
        .await
    }

    /// Verify both signatures and each identity's supplied complete Keyhive
    /// authority proof before retaining anything.
    pub async fn contacts_import_accept(
        &self,
        bytes: Vec<u8>,
        selected_roots: Vec<[u8; 32]>,
        selected_parties: Vec<u32>,
        petname: String,
        glyph: String,
    ) -> Result<String, Error> {
        self.identity_open()?;
        let context = self.identity_context();
        let verified = self.contacts_validate_introduction(&bytes).await?;
        if !self.identity_context_is(context) {
            return Err(identity_changed());
        }
        let selected_roots = selected_roots
            .into_iter()
            .map(model::RootIdentity::from_bytes)
            .collect::<Vec<_>>();
        let selected = verified
            .select(&selected_roots, &selected_parties)
            .map_err(refused)?;
        let entropy = self.fresh_contacts_entropy();
        let received = self.seams.clock.now_ms();
        self.contacts_mutate_in(context, move |doc| {
            model::persist_verified_introduction(doc, selected, petname, glyph, entropy, received)
        })
        .await
    }

    pub async fn contacts_decode_link(&self, body: String) -> Result<Vec<u8>, Error> {
        self.identity_open()?;
        if body.len() > model::MAX_SIGNED_BYTES.saturating_mul(2) {
            return Err(Error::new(
                ErrorCode::Refused,
                "that contact link is too large",
            ));
        }
        data_encoding::BASE64URL_NOPAD
            .decode(body.as_bytes())
            .map_err(|_| {
                Error::new(
                    ErrorCode::Refused,
                    "that contact link is not valid base64url",
                )
            })
    }

    pub(crate) fn clear_root_custody(&self) -> Result<(), Error> {
        self.with_device(|device| {
            if let Some(mut seed) = device.root_seed.take() {
                seed.fill(0);
            }
            Ok(())
        })
    }

    pub(crate) fn root_seed(&self) -> Option<[u8; 32]> {
        self.state
            .borrow()
            .device
            .as_ref()
            .and_then(|device| device.root_seed)
    }

    pub(crate) fn install_root_seed(&self, seed: [u8; 32]) -> Result<(), Error> {
        self.replace_root_seed(Some(seed))
    }

    pub(crate) fn replace_root_seed(&self, seed: Option<[u8; 32]>) -> Result<(), Error> {
        self.with_device(|device| {
            device.root_seed = seed;
            Ok(())
        })
    }

    pub(crate) fn require_root_seed(&self) -> Result<[u8; 32], Error> {
        self.root_seed().ok_or_else(|| {
            Error::new(
                ErrorCode::Refused,
                "this device does not hold the user root; transfer or unlock it first",
            )
        })
    }

    async fn contacts_changed(&self) -> Result<(), Error> {
        self.checkpoint_durable().await?;
        self.push_event(Event::ContactsChanged);
        Ok(())
    }

    async fn contacts_mutate<T>(
        &self,
        change: impl FnOnce(&mut polyvisor_document_history::Document) -> Result<T, String>,
    ) -> Result<T, Error> {
        self.identity_open()?;
        self.contacts_mutate_in(self.identity_context(), change)
            .await
    }

    async fn contacts_mutate_in<T>(
        &self,
        context: IdentityContext,
        change: impl FnOnce(&mut polyvisor_document_history::Document) -> Result<T, String>,
    ) -> Result<T, Error> {
        let result = self
            .engine()?
            .document_mutate(CONTACTS_APP, move |doc| {
                if !self.identity_context_is(context) {
                    return Err("the user identity changed during a contacts update".into());
                }
                change(doc)
            })
            .await
            .map_err(refused)?;
        self.contacts_changed().await?;
        Ok(result)
    }

    fn fresh_contacts_entropy(&self) -> [u8; 32] {
        let mut entropy = [0; 32];
        self.seams.rng.fill(&mut entropy);
        entropy
    }

    fn validate_profile_context(
        &self,
        profile: &SelfProfile,
        group: [u8; 32],
    ) -> Result<(), Error> {
        let binding = model::verify_root_binding(&profile.binding).map_err(refused)?;
        if binding.root != profile.root || binding.group.to_bytes() != group {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the public identity does not match this device's Keyhive group",
            ));
        }
        if let Some(seed) = self.root_seed()
            && SigningKey::from_bytes(&seed).verifying_key().to_bytes() != profile.root.to_bytes()
        {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "local root custody does not match the public identity",
            ));
        }
        Ok(())
    }
}

fn optional_key(bytes: Vec<u8>) -> Result<Option<[u8; 32]>, Error> {
    if bytes.is_empty() {
        return Ok(None);
    }
    bytes
        .try_into()
        .map(Some)
        .map_err(|_| Error::new(ErrorCode::Refused, "a contact public key must be 32 bytes"))
}

fn claimed_time(now_ms: u64) -> Result<ClaimedTime, Error> {
    Ok(ClaimedTime {
        seconds: i64::try_from(now_ms / 1_000)
            .map_err(|_| Error::new(ErrorCode::Failed, "the system clock is out of range"))?,
        nanos: ((now_ms % 1_000) * 1_000_000) as u32,
    })
}

fn refused(why: String) -> Error {
    Error::new(ErrorCode::Refused, why)
}

fn identity_changed() -> Error {
    Error::new(
        ErrorCode::Unavailable,
        "the user identity changed during this operation",
    )
}
