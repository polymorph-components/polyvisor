//! Typed, device-authenticated document invitations.
//!
//! The wire is deliberately one-way after the sender grants: the receiver
//! checkpoints an inbox record before acknowledging delivery, and adoption is
//! a later local trusted-UI action (`docs/design.md`, document sharing).

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use polyvisor_contacts_model as contacts;
use polyvisor_engine::{DocumentAccess, DocumentGrant, StoreItem};
use polyvisor_visor_model as visor_model;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{EngineTransport, Error, ErrorCode, Event, Kernel, SessionId, engine_failed};

pub const SHARING_ALPN: &str = "polyvisor/sharing/0";
pub const INVITATION_BUDGET: usize = 512 * 1024;
const DOMAIN: &[u8] = b"polyvisor:document-invitation:v0\0";

pub const fn sharing_wire_budget() -> usize {
    INVITATION_BUDGET - 4
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareAccess {
    Read,
    Edit,
}

impl From<ShareAccess> for DocumentAccess {
    fn from(value: ShareAccess) -> Self {
        match value {
            ShareAccess::Read => Self::Read,
            ShareAccess::Edit => Self::Edit,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryState {
    Queued,
    Delivering,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharePrompt {
    pub id: String,
    pub label: String,
    pub app: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareOutgoing {
    pub id: String,
    pub label: String,
    pub recipient: String,
    pub access: ShareAccess,
    pub state: DeliveryState,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareInvitation {
    pub id: String,
    pub label: String,
    pub sender: String,
    pub app: String,
    pub access: ShareAccess,
    pub adopted_instance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentInstance {
    pub id: String,
    pub label: String,
    pub personal: bool,
    pub access: ShareAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InvitationBody {
    version: u8,
    id: [u8; 32],
    sender_root: [u8; 32],
    sender_group: [u8; 32],
    sender_device: [u8; 32],
    /// Existing self-contained contact introduction: root-signed group
    /// binding and profile, device signer, and exact Keyhive member proof.
    sender_identity: Vec<u8>,
    recipient_root: [u8; 32],
    recipient_group: [u8; 32],
    document_type: String,
    service: String,
    label: String,
    access: ShareAccess,
    history_and_resharing: bool,
    grant: DocumentGrant,
    inline: Vec<StoreItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SignedInvitation {
    body: Vec<u8>,
    signature: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum Frame {
    Invitation(SignedInvitation),
    Received,
    Refused(String),
    Done,
}

impl Kernel {
    /// Public task-service method. The session decides the document; no app
    /// argument can select a different contact or partition.
    pub async fn tasks_share(&self, session: SessionId) -> Result<(), String> {
        let app = self
            .session_app_id(session)
            .map_err(|_| "unknown session".to_string())?;
        if app != "todomvc" {
            return Err("only TodoMVC lists are shareable".into());
        }
        let partition = self
            .session_documents
            .borrow()
            .get(&session)
            .cloned()
            .ok_or_else(|| {
                "this personal list predates shareable document instances".to_string()
            })?;
        let mut id = [0; 32];
        self.seams.rng.fill(&mut id);
        let app_label = self
            .meta(crate::MetaScope::App(app.clone()))
            .ok()
            .and_then(|meta| meta.get("petname").cloned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Personal".into());
        let selected_partition = self.session_documents.borrow().get(&session).cloned();
        let label = match selected_partition {
            Some(partition) => self
                .engine()
                .map_err(|error| error.message)?
                .document_read(visor_model::VISOR_APP, move |doc| {
                    visor_model::label_for_partition(doc, &partition)
                })
                .await?
                .unwrap_or_else(|| app_label.clone()),
            None => app_label,
        };
        let prompt = visor_model::SharePromptRecord {
            id: hex(&id),
            partition,
            app,
            label,
        };
        self.engine()
            .map_err(|error| error.message)?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                visor_model::queue_share_prompt(doc, prompt)
            })
            .await?;
        self.checkpoint_service().await?;
        self.push_event(Event::SharingChanged);
        Ok(())
    }

    pub async fn sharing_prompts(&self) -> Result<Vec<SharePrompt>, Error> {
        self.open()?;
        let rows = self
            .engine()?
            .document_read(visor_model::VISOR_APP, visor_model::share_prompts)
            .await
            .map_err(engine_failed)?;
        Ok(rows
            .into_iter()
            .map(|p| SharePrompt {
                id: p.id,
                label: p.label,
                app: p.app,
            })
            .collect())
    }

    pub async fn sharing_inbox(&self) -> Result<Vec<ShareInvitation>, Error> {
        self.open()?;
        let rows = self
            .engine()?
            .document_read(visor_model::VISOR_APP, visor_model::share_inbox)
            .await
            .map_err(engine_failed)?;
        Ok(rows
            .into_iter()
            .map(|i| ShareInvitation {
                id: i.id,
                label: i.label,
                sender: i.sender,
                app: i.app,
                access: if i.edit {
                    ShareAccess::Edit
                } else {
                    ShareAccess::Read
                },
                adopted_instance: i.adopted_instance,
            })
            .collect())
    }

    pub async fn sharing_instances(&self, app: &str) -> Result<Vec<DocumentInstance>, Error> {
        self.open()?;
        if !self.registry.contains(app) {
            return Err(Error::new(
                ErrorCode::UnknownApp,
                "that app is not installed",
            ));
        }
        let app = app.to_string();
        let personal_label = self
            .meta(crate::MetaScope::App(app.clone()))
            .ok()
            .and_then(|meta| meta.get("petname").cloned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Personal".into());
        self.engine()?
            .document_read(visor_model::VISOR_APP, move |doc| {
                let mut out = Vec::new();
                if visor_model::personal_partition(doc, &app).is_some() {
                    out.push(DocumentInstance {
                        id: String::new(),
                        label: personal_label,
                        personal: true,
                        access: ShareAccess::Edit,
                    });
                }
                out.extend(
                    visor_model::share_instances(doc)
                        .into_iter()
                        .filter(|(_, row)| row.app == app)
                        .map(|(id, row)| DocumentInstance {
                            id,
                            label: row.label,
                            personal: false,
                            access: if row.edit {
                                ShareAccess::Edit
                            } else {
                                ShareAccess::Read
                            },
                        }),
                );
                out
            })
            .await
            .map_err(engine_failed)
    }

    pub async fn sharing_outgoing(&self) -> Result<Vec<ShareOutgoing>, Error> {
        self.open()?;
        let rows = self
            .engine()?
            .document_read(visor_model::VISOR_APP, visor_model::share_outgoing)
            .await
            .map_err(engine_failed)?;
        Ok(rows
            .into_iter()
            .map(|o| ShareOutgoing {
                id: o.id,
                label: o.label,
                recipient: o.recipient,
                access: if o.edit {
                    ShareAccess::Edit
                } else {
                    ShareAccess::Read
                },
                state: match o.state.as_str() {
                    "delivering" => DeliveryState::Delivering,
                    "delivered" => DeliveryState::Delivered,
                    "failed" => DeliveryState::Failed,
                    _ => DeliveryState::Queued,
                },
                detail: o.detail,
            })
            .collect())
    }

    pub async fn sharing_cancel(&self, prompt: &str) -> Result<(), Error> {
        let _write = self.sharing_write.lock().await;
        let prompt = prompt.to_string();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                visor_model::remove_share_prompt(doc, &prompt)
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        Ok(())
    }

    pub async fn sharing_dismiss(&self, invitation: &str) -> Result<(), Error> {
        let _write = self.sharing_write.lock().await;
        let invitation = invitation.to_string();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                visor_model::remove_share_invitation(doc, &invitation)
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        Ok(())
    }

    pub async fn sharing_confirm(
        &self,
        prompt: &str,
        contact_id: &str,
        access: ShareAccess,
    ) -> Result<(), Error> {
        let write = self.sharing_write.lock().await;
        let context = self.identity_context();
        if self
            .engine()?
            .document_read(visor_model::VISOR_APP, {
                let prompt = prompt.to_string();
                move |doc| visor_model::share_outgoing_record(doc, &prompt)
            })
            .await
            .map_err(engine_failed)?
            .is_some()
        {
            self.checkpoint_durable().await?;
            drop(write);
            return self.sharing_retry(prompt).await;
        }
        let contact = self.contacts_get(contact_id.to_string()).await?;
        let recipient = contact_display_name(&contact);
        let retained = contact.retained_identity.ok_or_else(|| {
            Error::new(
                ErrorCode::Refused,
                "that contact has no authenticated group authority",
            )
        })?;
        let binding = contacts::verify_root_binding(&retained.binding)
            .map_err(|e| Error::new(ErrorCode::Refused, e))?;
        let authority = retained.authorities.first().ok_or_else(|| {
            Error::new(
                ErrorCode::Refused,
                "that contact has no retained authority device",
            )
        })?;
        let prompt_record = self
            .engine()?
            .document_read(visor_model::VISOR_APP, {
                let prompt = prompt.to_string();
                move |doc| visor_model::share_prompt(doc, &prompt)
            })
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "that share prompt no longer exists"))?;

        // Prepare every fallible identity/display input before granting. Once
        // `grant_document` returns, the recipient has authority and the next
        // durable checkpoint must also contain an outgoing record that tells
        // the truth about that irreversible fact.
        let sender = self.contacts_profile().await?;
        let sender_identity = self
            .contacts_share(
                sender.root.to_bytes(),
                sender
                    .variants
                    .iter()
                    .map(|profile| profile.as_bytes().to_vec())
                    .collect(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .await?;
        let sender_group = self
            .engine()?
            .authority_group()
            .await
            .map_err(engine_failed)?;
        let sender_device = self.engine()?.verifying_key().to_bytes();
        let target = self.seams.net.endpoint_id(authority.device.to_bytes());
        let invitation_id = digest_id(prompt.as_bytes(), contact_id.as_bytes());

        let grant = self
            .engine()?
            .grant_document(
                &prompt_record.partition,
                binding.group.to_bytes(),
                authority.device.to_bytes(),
                &authority.keyhive_authority_proof,
                access.into(),
            )
            .await
            .map_err(engine_failed)?;
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the user identity changed during sharing confirmation",
            ));
        }
        let mut body = InvitationBody {
            version: 0,
            id: invitation_id,
            sender_root: sender.root.to_bytes(),
            sender_group,
            sender_device,
            sender_identity,
            recipient_root: retained.root.to_bytes(),
            recipient_group: binding.group.to_bytes(),
            document_type: "polyvisor.todo/v0".into(),
            service: prompt_record.app.clone(),
            label: prompt_record.label.clone(),
            access,
            history_and_resharing: true,
            grant,
            inline: Vec::new(),
        };
        let rebuild_body = bincode::serialize(&body).map_err(failed_bincode)?;
        let built = self
            .build_invitation_wire(&prompt_record.partition, &mut body)
            .await;
        let (retained_wire, state, detail) = match built {
            Ok(wire) => (wire, "queued".to_string(), String::new()),
            Err(error) => (
                Vec::new(),
                "failed".to_string(),
                format!(
                    "access was granted, but its invitation could not be prepared: {}",
                    error.message
                ),
            ),
        };
        let deliverable = !retained_wire.is_empty();
        let prompt_id = prompt.to_string();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                if !self.identity_context_is(context) {
                    return Err("the user identity changed during sharing confirmation".into());
                }
                visor_model::finish_share_prompt(
                    doc,
                    &prompt_id,
                    visor_model::ShareOutgoingRecord {
                        id: String::new(),
                        label: String::new(),
                        recipient,
                        edit: access == ShareAccess::Edit,
                        state,
                        detail,
                        endpoint: target,
                        envelope: retained_wire,
                        rebuild_body,
                        recipient_device: authority.device.to_bytes(),
                    },
                )
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        drop(write);
        if !deliverable {
            Err(Error::new(
                ErrorCode::Failed,
                "access was granted, but its invitation could not be prepared",
            ))
        } else {
            self.sharing_retry(prompt).await
        }
    }

    async fn build_invitation_wire(
        &self,
        partition: &str,
        body: &mut InvitationBody,
    ) -> Result<Vec<u8>, Error> {
        let key = SigningKey::from_bytes(&self.state.borrow().seed);
        let empty = bincode::serialize(&Frame::Invitation(sign_invitation(&key, body.clone())?))
            .map_err(failed_bincode)?;
        let remaining = INVITATION_BUDGET.saturating_sub(4 + empty.len());
        if let Some(items) = self
            .engine()?
            .document_inline_items(partition, remaining)
            .await
            .map_err(engine_failed)?
        {
            body.inline = items;
        }
        let mut wire = bincode::serialize(&Frame::Invitation(sign_invitation(&key, body.clone())?))
            .map_err(failed_bincode)?;
        if wire.len().saturating_add(4) > INVITATION_BUDGET {
            body.inline.clear();
            wire = bincode::serialize(&Frame::Invitation(sign_invitation(&key, body.clone())?))
                .map_err(failed_bincode)?;
        }
        if wire.len().saturating_add(4) > INVITATION_BUDGET {
            return Err(Error::new(
                ErrorCode::Refused,
                "the encoded invitation exceeds 512 KiB",
            ));
        }
        Ok(wire)
    }

    pub async fn sharing_retry(&self, id: &str) -> Result<(), Error> {
        let _write = self.sharing_write.lock().await;
        let context = self.identity_context();
        let mut row = self
            .engine()?
            .document_read(visor_model::VISOR_APP, {
                let id = id.to_string();
                move |doc| visor_model::share_outgoing_record(doc, &id)
            })
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "no such outgoing invitation"))?;
        if row.envelope.is_empty() && !row.rebuild_body.is_empty() {
            let mut body: InvitationBody =
                bincode::deserialize(&row.rebuild_body).map_err(|_| {
                    Error::new(ErrorCode::Failed, "stored invitation input is malformed")
                })?;
            match self
                .build_invitation_wire(&body.grant.document.partition.clone(), &mut body)
                .await
            {
                Ok(envelope) => {
                    row.envelope = envelope.clone();
                    let id = id.to_string();
                    self.engine()?
                        .document_mutate(visor_model::VISOR_APP, move |doc| {
                            visor_model::set_share_envelope(doc, &id, envelope)
                        })
                        .await
                        .map_err(engine_failed)?;
                    self.checkpoint_durable().await?;
                }
                Err(error) => {
                    self.record_delivery_failure(id, &error.message).await?;
                    return Err(error);
                }
            }
        }
        if row.envelope.len().saturating_add(4) > INVITATION_BUDGET {
            return Err(Error::new(
                ErrorCode::Refused,
                "stored invitation exceeds 512 KiB",
            ));
        }
        if row.envelope.is_empty() {
            return Err(Error::new(
                ErrorCode::Failed,
                "access was granted, but this invitation has no deliverable payload",
            ));
        }
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the user identity changed before invitation delivery",
            ));
        }
        // CONTRACT: dispatch.md:32 requires the grant and complete retained
        // envelope to be durable before every send. This is intentionally
        // unconditional: a previous checkpoint may have reported failure
        // while leaving the outgoing row live in the in-memory document.
        self.checkpoint_durable().await?;
        let endpoint = self.endpoint.borrow().clone();
        let endpoint = match endpoint {
            Some(endpoint) => endpoint,
            None => {
                let why = "this device has no network endpoint".to_string();
                self.record_delivery_failure(id, &why).await?;
                return Err(Error::new(ErrorCode::Unavailable, why));
            }
        };
        let (key, transport) = match timed(
            self.seams.clock.as_ref(),
            endpoint.connect(row.endpoint.clone(), SHARING_ALPN.into()),
        )
        .await
        {
            Ok(connection) => connection,
            Err(why) => {
                self.record_delivery_failure(id, &why).await?;
                return Err(Error::new(ErrorCode::Unavailable, why));
            }
        };
        let transport: std::rc::Rc<dyn EngineTransport> = std::rc::Rc::from(transport);
        let delivery = if key != row.recipient_device {
            Err("the recipient endpoint authenticated as another device".into())
        } else {
            timed(self.seams.clock.as_ref(), async {
                transport.send(row.envelope).await?;
                match transport.recv().await {
                    Some(bytes)
                        if bytes.len().saturating_add(4) <= INVITATION_BUDGET
                            && bincode::deserialize::<Frame>(&bytes).ok()
                                == Some(Frame::Received) =>
                    {
                        Ok(())
                    }
                    Some(bytes) => match bincode::deserialize::<Frame>(&bytes) {
                        Ok(Frame::Refused(why)) => {
                            Err(format!("the recipient refused the invitation: {why}"))
                        }
                        _ => Err("the recipient did not checkpoint the invitation".into()),
                    },
                    None => Err("the recipient did not checkpoint the invitation".into()),
                }
            })
            .await
        };
        // `transport` lives outside the cancelled send/receive future, so a
        // timeout still performs protocol close rather than relying on Drop.
        if delivery.is_ok()
            && let Ok(done) = bincode::serialize(&Frame::Done)
        {
            let _ = timed(self.seams.clock.as_ref(), transport.send(done)).await;
        }
        transport.close().await;
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the user identity changed during invitation delivery",
            ));
        }
        let delivered = delivery.is_ok();
        let id = id.to_string();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                visor_model::set_share_delivery(doc, &id, delivered)
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        if delivered {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::Failed,
                delivery
                    .err()
                    .unwrap_or_else(|| "document delivery failed".into()),
            ))
        }
    }

    async fn record_delivery_failure(&self, id: &str, why: &str) -> Result<(), Error> {
        let id = id.to_string();
        let why = why.to_string();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                visor_model::set_share_delivery_detail(doc, &id, false, why)
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        Ok(())
    }

    pub async fn sharing_adopt(&self, id: &str) -> Result<String, Error> {
        let _write = self.sharing_write.lock().await;
        let context = self.identity_context();
        let row = self
            .engine()?
            .document_read(visor_model::VISOR_APP, {
                let id = id.to_string();
                move |doc| visor_model::share_inbox_record(doc, &id)
            })
            .await
            .map_err(engine_failed)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "no such invitation"))?;
        let signed: SignedInvitation = bincode::deserialize(&row.envelope)
            .map_err(|_| Error::new(ErrorCode::Refused, "the stored invitation is malformed"))?;
        let body = verify_invitation(&signed)?;
        self.verify_sender_identity(&body).await?;
        let own = self.contacts_profile().await?;
        let own_group = self
            .engine()?
            .authority_group()
            .await
            .map_err(engine_failed)?;
        if body.recipient_root != own.root.to_bytes() || body.recipient_group != own_group {
            return Err(Error::new(
                ErrorCode::Refused,
                "invitation names another recipient",
            ));
        }
        self.engine()?
            .validate_document_grant(&body.grant, body.sender_group, body.sender_device)
            .await
            .map_err(|why| Error::new(ErrorCode::Refused, why))?;
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the user identity changed during invitation adoption",
            ));
        }
        self.engine()?
            .adopt_document(&body.grant, body.sender_group, body.sender_device)
            .await
            .map_err(engine_failed)?;
        if !body.inline.is_empty() {
            self.engine()?
                .document_import_inline(&body.grant.document.partition, body.inline)
                .await
                .map_err(engine_failed)?;
        }
        let existing = self
            .engine()?
            .document_read(visor_model::VISOR_APP, {
                let partition = body.grant.document.partition.clone();
                move |doc| visor_model::instance_for_partition(doc, &partition)
            })
            .await
            .map_err(engine_failed)?;
        let instance = match existing {
            Some(instance) => instance,
            None => {
                let mut entropy = [0; 32];
                self.seams.rng.fill(&mut entropy);
                hex(&entropy[..16])
            }
        };
        let id = id.to_string();
        let instance_out = instance.clone();
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                if !self.identity_context_is(context) {
                    return Err("the user identity changed during invitation adoption".into());
                }
                visor_model::adopt_share_invitation(
                    doc,
                    &id,
                    instance,
                    body.grant.document.partition,
                    body.service,
                )
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        let weak = self.me.borrow().clone();
        let sender = body.sender_device;
        self.seams.spawn.spawn(Box::pin(async move {
            if let Some(kernel) = weak.upgrade() {
                let _ = timed(kernel.seams.clock.as_ref(), async {
                    kernel
                        .sync_connect_hint(sender)
                        .await
                        .map_err(|error| error.message)
                })
                .await;
            }
        }));
        Ok(instance_out)
    }

    pub(crate) async fn sharing_instance_partition(
        &self,
        instance: &str,
        app: &str,
    ) -> Result<String, Error> {
        let engine = self.engine()?;
        let found = engine
            .document_read(visor_model::VISOR_APP, {
                let instance = instance.to_string();
                move |doc| visor_model::share_instance(doc, &instance)
            })
            .await
            .map_err(engine_failed)?;
        match found {
            Some(i) if i.app == app => Ok(i.partition),
            _ => Err(Error::new(
                ErrorCode::NotFound,
                "no compatible adopted document instance",
            )),
        }
    }

    pub(crate) async fn sharing_accept(&self, peer: [u8; 32], transport: Box<dyn EngineTransport>) {
        let received = timed(self.seams.clock.as_ref(), async {
            transport
                .recv()
                .await
                .ok_or_else(|| "the invitation connection closed".to_string())
        })
        .await;
        let invitation = received
            .ok()
            .and_then(|bytes| (bytes.len().saturating_add(4) <= INVITATION_BUDGET).then_some(bytes))
            .and_then(|bytes| bincode::deserialize::<Frame>(&bytes).ok());
        let answer = match invitation {
            Some(Frame::Invitation(signed)) => match self.receive_invitation(peer, signed).await {
                Ok(()) => Frame::Received,
                Err(error) => Frame::Refused(error.message),
            },
            _ => Frame::Refused("malformed or oversized invitation".into()),
        };
        if let Ok(bytes) = bincode::serialize(&answer)
            && timed(self.seams.clock.as_ref(), transport.send(bytes))
                .await
                .is_ok()
            && answer == Frame::Received
        {
            let _ = timed(self.seams.clock.as_ref(), async {
                match transport.recv().await {
                    Some(bytes)
                        if bincode::deserialize::<Frame>(&bytes).ok() == Some(Frame::Done) =>
                    {
                        Ok(())
                    }
                    _ => Err("the invitation sender did not acknowledge receipt".into()),
                }
            })
            .await;
        }
        transport.close().await;
    }

    async fn receive_invitation(
        &self,
        peer: [u8; 32],
        signed: SignedInvitation,
    ) -> Result<(), Error> {
        let context = self.identity_context();
        let body = verify_invitation(&signed)?;
        if body.sender_device != peer {
            return Err(Error::new(
                ErrorCode::Refused,
                "invitation signer does not match the transport peer",
            ));
        }
        let own = self.contacts_profile().await?;
        let own_group = self
            .engine()?
            .authority_group()
            .await
            .map_err(engine_failed)?;
        if body.recipient_root != own.root.to_bytes() || body.recipient_group != own_group {
            return Err(Error::new(
                ErrorCode::Refused,
                "invitation names another recipient",
            ));
        }
        self.verify_sender_identity(&body).await?;
        self.engine()?
            .validate_document_grant(&body.grant, body.sender_group, body.sender_device)
            .await
            .map_err(|why| Error::new(ErrorCode::Refused, why))?;
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "the user identity changed during invitation verification",
            ));
        }
        let envelope = bincode::serialize(&signed).map_err(failed_bincode)?;
        let record = visor_model::ShareInboxRecord {
            id: hex(&body.id),
            label: body.label,
            sender: hex(&body.sender_root),
            app: body.service,
            edit: body.access == ShareAccess::Edit,
            envelope,
            adopted_instance: None,
            sender_endpoint: self.seams.net.endpoint_id(body.sender_device),
            sender_device: body.sender_device,
        };
        self.engine()?
            .document_mutate(visor_model::VISOR_APP, move |doc| {
                if !self.identity_context_is(context) {
                    return Err("the user identity changed during invitation receipt".into());
                }
                visor_model::receive_share_invitation(doc, record)
            })
            .await
            .map_err(engine_failed)?;
        self.checkpoint_durable().await?;
        self.push_event(Event::SharingChanged);
        Ok(())
    }

    async fn verify_sender_identity(&self, body: &InvitationBody) -> Result<(), Error> {
        let verified = self
            .contacts_validate_introduction(&body.sender_identity)
            .await?;
        let intro = verified.introduction();
        let binding = contacts::verify_root_binding(&intro.issuer.binding)
            .map_err(|why| Error::new(ErrorCode::Refused, why))?;
        if binding.root.to_bytes() != body.sender_root
            || binding.group.to_bytes() != body.sender_group
            || intro.device.to_bytes() != body.sender_device
            || intro.issuer.authority_device.to_bytes() != body.sender_device
            || !intro.authenticated_identities.is_empty()
            || !intro.parties.is_empty()
        {
            return Err(Error::new(
                ErrorCode::Refused,
                "invitation sender identity does not match its authenticated proof",
            ));
        }
        if body.service != "todomvc"
            || body.document_type != "polyvisor.todo/v0"
            || body.grant.document.partition != body.grant.document.partition.to_ascii_lowercase()
            || body.grant.recipient_group != body.recipient_group
            || body.grant.access != body.access.into()
        {
            return Err(Error::new(
                ErrorCode::Refused,
                "invitation grant metadata is inconsistent",
            ));
        }
        Ok(())
    }
}

fn sign_invitation(key: &SigningKey, body: InvitationBody) -> Result<SignedInvitation, Error> {
    let body = bincode::serialize(&body).map_err(failed_bincode)?;
    let signature = key.sign(&[DOMAIN, &body].concat()).to_bytes().to_vec();
    Ok(SignedInvitation { body, signature })
}

fn verify_invitation(signed: &SignedInvitation) -> Result<InvitationBody, Error> {
    if signed.body.len() + signed.signature.len() > INVITATION_BUDGET {
        return Err(Error::new(ErrorCode::Refused, "invitation exceeds 512 KiB"));
    }
    let body: InvitationBody = bincode::deserialize(&signed.body)
        .map_err(|_| Error::new(ErrorCode::Refused, "invalid invitation body"))?;
    let key = VerifyingKey::from_bytes(&body.sender_device)
        .map_err(|_| Error::new(ErrorCode::Refused, "invalid sender device"))?;
    let signature = Signature::from_slice(&signed.signature)
        .map_err(|_| Error::new(ErrorCode::Refused, "invalid invitation signature"))?;
    key.verify(&[DOMAIN, &signed.body].concat(), &signature)
        .map_err(|_| Error::new(ErrorCode::Refused, "invitation signature did not verify"))?;
    if body.version != 0 || !body.history_and_resharing {
        return Err(Error::new(
            ErrorCode::Refused,
            "unsupported invitation semantics",
        ));
    }
    Ok(body)
}

fn digest_id(a: &[u8], b: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(DOMAIN)
        .chain_update(a)
        .chain_update(b)
        .finalize()
        .into()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn contact_display_name(contact: &contacts::Contact) -> String {
    if !contact.petname.is_empty() {
        return contact.petname.clone();
    }
    if let Some((_, value)) = contact.preferred.iter().find(|(name, _)| name == "name") {
        return value.clone();
    }
    if let Some(value) = contact
        .retained_identity
        .as_ref()
        .into_iter()
        .flat_map(contacts::RetainedIdentity::official_profiles)
        .flat_map(|profile| profile.claims)
        .find(|claim| claim.name == "name" && !claim.value.is_empty())
        .map(|claim| claim.value)
    {
        return value;
    }
    if let Some(value) = contact
        .observations
        .iter()
        .find(|observation| observation.name == "name" && !observation.value.is_empty())
        .map(|observation| observation.value.clone())
    {
        return value;
    }
    contact
        .public_key
        .map(|key| format!("contact {}…", hex(&key[..4])))
        .unwrap_or_else(|| "an unnamed contact".into())
}
fn failed_bincode(error: Box<bincode::ErrorKind>) -> Error {
    Error::new(ErrorCode::Failed, error.to_string())
}

async fn timed<T>(
    clock: &dyn crate::Clock,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    futures::pin_mut!(work);
    let timeout = clock.sleep(120_000);
    futures::pin_mut!(timeout);
    match futures::future::select(work, timeout).await {
        futures::future::Either::Left((result, _)) => result,
        futures::future::Either::Right(((), _)) => Err("document delivery timed out".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(key: &SigningKey) -> InvitationBody {
        InvitationBody {
            version: 0,
            id: [1; 32],
            sender_root: [2; 32],
            sender_group: [3; 32],
            sender_device: key.verifying_key().to_bytes(),
            sender_identity: vec![4],
            recipient_root: [5; 32],
            recipient_group: [6; 32],
            document_type: "polyvisor.todo/v0".into(),
            service: "todomvc".into(),
            label: "list".into(),
            access: ShareAccess::Edit,
            history_and_resharing: true,
            grant: DocumentGrant {
                document: polyvisor_engine::SharedDocument {
                    partition: format!("document:{}", hex(&[7; 32])),
                    document: [7; 32],
                },
                recipient_group: [6; 32],
                access: DocumentAccess::Edit,
                authority: vec![8],
                frontier: vec![9],
            },
            inline: Vec::new(),
        }
    }

    #[test]
    fn invitation_signature_binds_every_body_byte() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let signed = sign_invitation(&key, body(&key)).unwrap();
        assert!(verify_invitation(&signed).is_ok());
        let mut tampered = signed;
        tampered.body[0] ^= 1;
        assert!(verify_invitation(&tampered).is_err());
    }

    #[test]
    fn invitation_decoder_rejects_oversize_before_body_decode() {
        let signed = SignedInvitation {
            body: vec![0; INVITATION_BUDGET],
            signature: vec![0; 64],
        };
        assert!(verify_invitation(&signed).is_err());
    }
}
