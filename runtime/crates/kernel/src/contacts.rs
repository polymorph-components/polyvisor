//! The user's private contacts document and signed introduction boundary.

use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use ed25519_dalek::SigningKey;
use polyvisor_contacts_model as model;

use crate::{Error, ErrorCode, Event, Kernel, engine_failed};

pub const CONTACTS_APP: &str = "polyvisor:contacts";

pub use model::{
    Claim, ClaimedTime, Contact, ImportReview, Introduction, MeetingRecord, Observation, Party,
    Provenance, SelfProfile,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub index: u32,
    pub claims: Vec<(String, String)>,
}

impl Kernel {
    /// Initialize the user identity only for the group's founder. A joining
    /// device adopts the established identity in `pairing::run_claimed`.
    pub(crate) async fn initialize_contacts(&self) -> Result<bool, Error> {
        let engine = self.engine()?;
        let members = engine.members().await.map_err(engine_failed)?;
        let me = engine.verifying_key().to_bytes();
        let am_founder = members.first().is_none_or(|member| member.key == me);
        let (name, device_seed) = {
            let state = self.state.borrow();
            let device = state
                .device
                .as_ref()
                .ok_or_else(|| Error::new(ErrorCode::Unavailable, "device is sealed"))?;
            (
                device.meta.user.get("name").cloned().unwrap_or_default(),
                state.seed,
            )
        };
        if !am_founder {
            return Ok(false);
        }
        let entropy = engine.model_entropy();
        let occurred = self.seams.clock.now_ms();
        let (_, wrote) = engine
            .document_mutate(CONTACTS_APP, move |doc| {
                let (seed, identity_wrote) = model::identity_or_create(doc, device_seed, entropy)?;
                if !identity_wrote || name.is_empty() || name.len() > model::MAX_VALUE_BYTES {
                    return Ok((seed, identity_wrote));
                }
                let meeting = model::create_meeting(
                    doc,
                    "entered by hand".into(),
                    String::new(),
                    None,
                    occurred,
                    false,
                    entropy,
                )?;
                model::write_self_observation(
                    doc,
                    Observation {
                        name: "name".into(),
                        value: name,
                        provenance: Provenance::Local,
                        issuer: None,
                        claimed: None,
                        received: occurred,
                        meeting,
                    },
                )?;
                Ok((seed, true))
            })
            .await
            .map_err(engine_failed)?;
        Ok(wrote)
    }

    pub async fn contacts_items(&self) -> Result<Vec<Contact>, Error> {
        self.open()?;
        self.engine()?
            .document_read(CONTACTS_APP, model::contacts)
            .await
            .map_err(engine_failed)
    }

    pub async fn contacts_get(&self, id: String) -> Result<Contact, Error> {
        self.open()?;
        self.engine()?
            .document_read(CONTACTS_APP, move |doc| model::contact(doc, &id))
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "no such contact"))
    }

    pub async fn contacts_profile(&self) -> Result<SelfProfile, Error> {
        self.open()?;
        self.engine()?
            .document_read(CONTACTS_APP, model::self_profile)
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::Unavailable, "the contacts identity is not ready"))
    }

    pub async fn contacts_meetings(&self) -> Result<Vec<MeetingRecord>, Error> {
        self.open()?;
        self.engine()?
            .document_read(CONTACTS_APP, model::meetings)
            .await
            .map_err(engine_failed)
    }

    pub async fn contacts_create(
        &self,
        public_key: Vec<u8>,
        mut petname: String,
        glyph: String,
    ) -> Result<String, Error> {
        self.open()?;
        if petname.is_empty() {
            petname = crate::device::generate_petname(self.seams.rng.as_ref(), "");
        }
        let public_key = optional_key(public_key)?;
        let entropy = self.fresh_contacts_entropy();
        let id = self
            .engine()?
            .document_mutate(CONTACTS_APP, move |doc| {
                model::create_contact(doc, public_key, petname, glyph, entropy)
            })
            .await
            .map_err(refused)?;
        self.contacts_changed().await?;
        Ok(id)
    }

    pub async fn contacts_set_label(
        &self,
        id: String,
        mut petname: String,
        glyph: String,
    ) -> Result<(), Error> {
        self.open()?;
        if petname.is_empty() {
            let id_for_read = id.clone();
            let previous = self
                .engine()?
                .document_read(CONTACTS_APP, move |doc| model::contact(doc, &id_for_read))
                .await
                .map_err(engine_failed)?
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "no such contact"))?
                .petname;
            petname = crate::device::generate_petname(self.seams.rng.as_ref(), &previous);
        }
        self.contacts_mutate(move |doc| model::set_label(doc, &id, petname, glyph))
            .await
    }

    pub async fn contacts_set_observation(
        &self,
        id: String,
        name: String,
        value: String,
    ) -> Result<(), Error> {
        self.open()?;
        validate_claim(&name, &value)?;
        self.require_contact(&id).await?;
        let occurred = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        self.engine()?
            .document_mutate(CONTACTS_APP, move |doc| {
                let meeting = model::create_meeting(
                    doc,
                    "entered by hand".into(),
                    String::new(),
                    None,
                    occurred,
                    false,
                    entropy,
                )?;
                model::write_extracted(
                    doc,
                    vec![model::ExtractedObservation {
                        contact_id: id,
                        observation: Observation {
                            name,
                            value,
                            provenance: Provenance::Local,
                            issuer: None,
                            claimed: None,
                            received: occurred,
                            meeting,
                        },
                    }],
                )
            })
            .await
            .map_err(refused)?;
        self.contacts_changed().await
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

    pub async fn contacts_set_self_observation(
        &self,
        name: String,
        value: String,
    ) -> Result<(), Error> {
        self.open()?;
        validate_claim(&name, &value)?;
        let occurred = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        self.engine()?
            .document_mutate(CONTACTS_APP, move |doc| {
                if model::identity_seed(doc).is_none() {
                    return Err("this device has not established a contacts identity yet".into());
                }
                let meeting = model::create_meeting(
                    doc,
                    "entered by hand".into(),
                    String::new(),
                    None,
                    occurred,
                    false,
                    entropy,
                )?;
                model::write_self_observation(
                    doc,
                    Observation {
                        name,
                        value,
                        provenance: Provenance::Local,
                        issuer: None,
                        claimed: None,
                        received: occurred,
                        meeting,
                    },
                )
            })
            .await
            .map_err(refused)?;
        self.contacts_changed().await
    }

    pub async fn contacts_remove_self_observation(
        &self,
        name: String,
        value: String,
    ) -> Result<(), Error> {
        self.contacts_mutate(move |doc| model::remove_self_observation(doc, &name, &value))
            .await
    }

    pub async fn contacts_share(&self, introduction: Introduction) -> Result<Vec<u8>, Error> {
        self.open()?;
        let now = claimed_time(self.seams.clock.now_ms())?;
        let seed = self
            .engine()?
            .document_read(CONTACTS_APP, model::identity_seed)
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| {
                Error::new(ErrorCode::Unavailable, "the contacts identity is not ready")
            })?;
        let own_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        if introduction.issuer.public_key != own_key {
            return Err(Error::new(
                ErrorCode::Refused,
                "the introduction issuer is not this user's contact identity",
            ));
        }
        model::sign(
            &Introduction {
                issued_at: now,
                ..introduction
            },
            &SigningKey::from_bytes(&seed),
        )
        .map_err(refused)
    }

    pub async fn contacts_decode_link(&self, body: String) -> Result<Vec<u8>, Error> {
        self.open()?;
        if body.len() > model::MAX_SIGNED_BYTES {
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

    pub async fn contacts_import_preview(&self, bytes: Vec<u8>) -> Result<ImportReview, Error> {
        self.open()?;
        model::parse_import(&bytes).map_err(refused)
    }

    pub async fn contacts_import_accept(
        &self,
        bytes: Vec<u8>,
        source: String,
        selections: Vec<Selection>,
    ) -> Result<Vec<String>, Error> {
        self.open()?;
        let review = model::parse_import(&bytes).map_err(refused)?;
        let parties: BTreeMap<_, _> = review.parties.into_iter().map(|p| (p.index, p)).collect();
        let mut selected_indices = BTreeSet::new();
        for selection in &selections {
            if !selected_indices.insert(selection.index) {
                return Err(Error::new(
                    ErrorCode::Refused,
                    "an import party was selected more than once",
                ));
            }
            let party = parties.get(&selection.index).ok_or_else(|| {
                Error::new(
                    ErrorCode::Refused,
                    "an import selection names no reviewed party",
                )
            })?;
            ensure_claim_subset(&selection.claims, &party.claims)?;
            for (name, value) in &selection.claims {
                validate_claim(name, value)?;
            }
        }
        if selections.is_empty() {
            return Ok(Vec::new());
        }
        let received = self.seams.clock.now_ms();
        let entropies = (0..selections.len())
            .map(|_| self.fresh_contacts_entropy())
            .collect::<Vec<_>>();
        let ids = self
            .engine()?
            .document_mutate(CONTACTS_APP, move |doc| {
                let mut ids = BTreeSet::new();
                let signed = parties
                    .values()
                    .next()
                    .is_some_and(|p| p.provenance == Provenance::Verified);
                let source_key = if signed {
                    parties.values().next().and_then(|p| p.issuer)
                } else {
                    None
                };
                let meeting = model::create_meeting(
                    doc,
                    "imported from a file".into(),
                    source,
                    source_key,
                    received,
                    signed,
                    entropies.first().copied().unwrap_or([0; 32]),
                )?;
                for (selection, entropy) in selections.into_iter().zip(entropies) {
                    let party = parties.get(&selection.index).expect("validated above");
                    let id = model::create_contact(
                        doc,
                        party.public_key,
                        String::new(),
                        String::new(),
                        entropy,
                    )?;
                    let observations = selection
                        .claims
                        .into_iter()
                        .map(|(name, value)| model::ExtractedObservation {
                            contact_id: id.clone(),
                            observation: Observation {
                                name,
                                value,
                                provenance: party.provenance,
                                issuer: party.issuer,
                                claimed: party.claimed,
                                received,
                                meeting: meeting.clone(),
                            },
                        })
                        .collect();
                    model::write_extracted(doc, observations)?;
                    ids.insert(id);
                }
                Ok(ids.into_iter().collect::<Vec<_>>())
            })
            .await
            .map_err(refused)?;
        self.contacts_changed().await?;
        Ok(ids)
    }

    pub(crate) async fn contacts_sign_card(self: &Rc<Self>, card: Party) -> Result<Vec<u8>, Error> {
        if card.public_key != self.contacts_own_public_key().await? {
            return Err(Error::new(
                ErrorCode::Refused,
                "the meeting card is not this user's contact identity",
            ));
        }
        self.contacts_share(Introduction {
            issuer: card,
            parties: Vec::new(),
            issued_at: ClaimedTime {
                seconds: 0,
                nanos: 0,
            },
        })
        .await
    }

    pub(crate) async fn contacts_own_public_key(self: &Rc<Self>) -> Result<[u8; 32], Error> {
        self.engine()?
            .document_read(CONTACTS_APP, model::identity_public_key)
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::Unavailable, "the contacts identity is not ready"))
    }

    pub(crate) async fn contacts_accept_meeting(
        self: &Rc<Self>,
        generation: u32,
        introduction: Introduction,
        keep: Vec<(String, String)>,
    ) -> Result<String, Error> {
        self.open()?;
        ensure_claim_subset(&keep, &introduction.issuer.claims)?;
        for (name, value) in &keep {
            validate_claim(name, value)?;
        }
        let received = self.seams.clock.now_ms();
        let entropy = self.fresh_contacts_entropy();
        let peer_key = introduction.issuer.public_key;
        let claimed = introduction.issued_at;
        let id = self
            .engine()?
            .document_mutate(CONTACTS_APP, |doc| {
                if !self.meeting_is_generation(generation) {
                    return Err("that meeting was replaced".into());
                }
                if self.meeting_identity(generation) != model::identity_public_key(doc) {
                    return Err("the contacts identity changed during this meeting".into());
                }
                let id = model::create_contact(
                    doc,
                    Some(peer_key),
                    String::new(),
                    String::new(),
                    entropy,
                )?;
                let meeting = model::create_meeting(
                    doc,
                    "met in real time".into(),
                    String::new(),
                    Some(peer_key),
                    received,
                    true,
                    entropy,
                )?;
                let rows = keep
                    .into_iter()
                    .map(|(name, value)| model::ExtractedObservation {
                        contact_id: id.clone(),
                        observation: Observation {
                            name,
                            value,
                            provenance: Provenance::Verified,
                            issuer: Some(peer_key),
                            claimed: Some(claimed),
                            received,
                            meeting: meeting.clone(),
                        },
                    })
                    .collect();
                model::write_extracted(doc, rows)?;
                Ok(id)
            })
            .await
            .map_err(refused)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::ContactsChanged);
        Ok(id)
    }

    async fn contacts_mutate(
        &self,
        change: impl FnOnce(&mut polyvisor_document_history::Document) -> Result<(), String>,
    ) -> Result<(), Error> {
        self.open()?;
        self.engine()?
            .document_mutate(CONTACTS_APP, change)
            .await
            .map_err(refused)?;
        self.contacts_changed().await
    }

    async fn contacts_changed(&self) -> Result<(), Error> {
        self.checkpoint_durable().await?;
        self.push_event(Event::ContactsChanged);
        Ok(())
    }

    fn fresh_contacts_entropy(&self) -> [u8; 32] {
        let mut entropy = [0; 32];
        self.seams.rng.fill(&mut entropy);
        entropy
    }

    async fn require_contact(&self, id: &str) -> Result<(), Error> {
        let id = id.to_string();
        if self
            .engine()?
            .document_read(CONTACTS_APP, move |doc| model::contact(doc, &id).is_some())
            .await
            .map_err(engine_failed)?
        {
            Ok(())
        } else {
            Err(Error::new(ErrorCode::NotFound, "no such contact"))
        }
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

fn ensure_claim_subset(selected: &[(String, String)], offered: &[Claim]) -> Result<(), Error> {
    if selected.iter().all(|(name, value)| {
        offered
            .iter()
            .any(|claim| claim.name == *name && claim.value == *value)
    }) {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::Refused,
            "a selected claim was not in the reviewed introduction",
        ))
    }
}

fn validate_claim(name: &str, value: &str) -> Result<(), Error> {
    if name.len() > model::MAX_NAME_BYTES || value.len() > model::MAX_VALUE_BYTES {
        Err(Error::new(ErrorCode::Refused, "that claim is too large"))
    } else {
        Ok(())
    }
}

fn refused(why: String) -> Error {
    Error::new(ErrorCode::Refused, why)
}

#[cfg(test)]
mod tests {
    use automerge::ActorId;
    use ed25519_dalek::SigningKey;
    use polyvisor_document_history::Document;
    use sedimentree_core::id::SedimentreeId;

    use super::*;

    fn doc(actor: u8) -> Document {
        Document::empty(ActorId::from(&[actor][..]), SedimentreeId::new([actor; 32]))
    }

    #[test]
    fn identity_initialization_is_idempotent() {
        let mut document = doc(1);
        let first = model::identity_or_create(&mut document, [2; 32], [3; 32]).unwrap();
        let second = model::identity_or_create(&mut document, [4; 32], [5; 32]).unwrap();
        assert!(first.1);
        assert_eq!(second, (first.0, false));
    }

    #[test]
    fn selected_multi_party_import_uses_one_meeting_and_drops_raw_envelope() {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[8; 32]);
        let introduction = Introduction {
            issuer: Party {
                public_key: signer.verifying_key().to_bytes(),
                claims: vec![Claim {
                    name: "name".into(),
                    value: "Ada".into(),
                }],
            },
            parties: vec![Party {
                public_key: other.verifying_key().to_bytes(),
                claims: vec![
                    Claim {
                        name: "name".into(),
                        value: "Grace".into(),
                    },
                    Claim {
                        name: "email".into(),
                        value: "g@example.test".into(),
                    },
                ],
            }],
            issued_at: ClaimedTime {
                seconds: 4,
                nanos: 5,
            },
        };
        let raw = model::sign(&introduction, &signer).unwrap();
        let review = model::parse_import(&raw).unwrap();
        let mut document = doc(2);
        let meeting = model::create_meeting(
            &mut document,
            "imported from a file".into(),
            "contacts.card".into(),
            Some(introduction.issuer.public_key),
            6,
            true,
            [9; 32],
        )
        .unwrap();
        let selected = [(0_u32, "name", "Ada"), (1, "email", "g@example.test")];
        let mut ids = Vec::new();
        for (index, name, value) in selected {
            let party = &review.parties[index as usize];
            let id = model::create_contact(
                &mut document,
                party.public_key,
                String::new(),
                String::new(),
                [10 + index as u8; 32],
            )
            .unwrap();
            model::write_extracted(
                &mut document,
                vec![model::ExtractedObservation {
                    contact_id: id.clone(),
                    observation: Observation {
                        name: name.into(),
                        value: value.into(),
                        provenance: party.provenance,
                        issuer: party.issuer,
                        claimed: party.claimed,
                        received: 7,
                        meeting: meeting.clone(),
                    },
                }],
            )
            .unwrap();
            ids.push(id);
        }
        assert_eq!(model::meetings(&document).len(), 1);
        assert!(ids.iter().all(|id| {
            let contact = model::contact(&document, id).unwrap();
            contact.observations.len() == 1 && contact.observations[0].meeting == meeting
        }));
        let saved = document.save();
        assert!(!saved.windows(raw.len()).any(|window| window == raw));
    }

    #[test]
    fn preferred_value_survives_document_reload() {
        let mut document = doc(3);
        let id = model::create_contact(&mut document, None, "friend".into(), "🐈".into(), [1; 32])
            .unwrap();
        let meeting = model::create_meeting(
            &mut document,
            "entered by hand".into(),
            String::new(),
            None,
            1,
            false,
            [2; 32],
        )
        .unwrap();
        model::write_extracted(
            &mut document,
            vec![model::ExtractedObservation {
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
        model::set_preferred(&mut document, &id, "name", Some("Ada".into())).unwrap();
        let restored = Document::load(
            &document.save(),
            ActorId::from(&[4][..]),
            SedimentreeId::new([3; 32]),
        );
        assert_eq!(
            model::contact(&restored, &id).unwrap().preferred,
            vec![("name".into(), "Ada".into())]
        );
        assert_eq!(model::contact(&restored, &id).unwrap().glyph, "🐈");
    }
}
