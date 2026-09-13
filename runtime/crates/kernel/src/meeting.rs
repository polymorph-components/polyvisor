//! Ephemeral, SAS-authenticated contact meetings.
//!
//! Meetings have their own ALPN and never enroll an endpoint or transfer a
//! document. Both peers sign the exact card selected by their user, verify the
//! other's signed self-introduction before showing it, compare a transcript-
//! bound SAS, and persist that whole authenticated issuer identity.

use std::cell::Cell;
use std::rc::Rc;

use futures::channel::{mpsc, oneshot};
use futures::future::Either;
use futures::{SinkExt as _, StreamExt as _};
use polyvisor_contacts_model::{Claim, Introduction};
use serde::{Deserialize, Serialize};

use crate::{EngineTransport, Error, ErrorCode, Kernel};

pub const MEETING_ALPN: &str = "polyvisor/meeting/0";

/// Two minutes permits scanning and comparison while bounding forgotten links,
/// stalled human review, and the transports attached to either.
const MEETING_TTL_MS: u64 = 120_000;
/// Cleanup frames are courtesy, not progress conditions. A peer that does not
/// read them gets the same terminal signal when the transport closes.
const CLEANUP_SEND_MS: u64 = 1_000;
const CODE_VERSION: u8 = 1;
const READER_CAPACITY: usize = 4;
/// Contacts-model accepts introductions up to 256 KiB. 300 KiB leaves room
/// for JSON's byte-array expansion only when bytes serialize compactly is not
/// guaranteed, so frames encode binary fields as JSON arrays and need a wider
/// bound. Four times the model limit admits their worst practical JSON form
/// while still placing a fixed bound on one message.
const MAX_FRAME_BYTES: usize = 4 * 300 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    Offering(MeetingOffer),
    Dialing(u32),
    AwaitingConfirm(MeetingReview),
    AwaitingPeer,
    Done(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingOffer {
    pub generation: u32,
    pub link: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingReview {
    pub generation: u32,
    pub sas: String,
    pub peer_key: Vec<u8>,
    pub claims: Vec<(String, String)>,
}

/// The event payload keeps the generation beside every phase, including idle
/// and terminal phases whose WIT payload does not carry it itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub generation: u32,
    pub phase: Phase,
}

struct Offer {
    token: [u8; 16],
    expires: u64,
    claimed: bool,
    introduction: Vec<u8>,
}

struct Session {
    generation: u32,
    transport: Rc<dyn EngineTransport>,
    confirm: Option<oneshot::Sender<()>>,
    cancelled: Rc<Cell<bool>>,
}

type Bound = (
    Rc<dyn EngineTransport>,
    mpsc::Receiver<Frame>,
    oneshot::Receiver<()>,
);

enum Join {
    Ignored,
    Ceremony(u32, Result<String, String>),
}

enum Verdict {
    Ignore,
    Refuse,
    Burn(u32, Option<Session>),
    Claim(u32, Vec<u8>),
}

#[derive(Default)]
pub struct Meeting {
    generation: u32,
    phase: Phase,
    offer: Option<Offer>,
    session: Option<Session>,
}

impl Kernel {
    /// Host one meeting and return its absolute bootstrap link.
    pub async fn meeting_offer(
        self: &Rc<Self>,
        expected_root: [u8; 32],
        expected_profiles: Vec<Vec<u8>>,
    ) -> Result<Status, Error> {
        self.identity_open()?;
        let endpoint_key = self.engine()?.verifying_key().to_bytes();
        if self.endpoint.borrow().is_none() {
            return Err(Error::new(
                ErrorCode::Unavailable,
                "this device is still binding its endpoint; try again in a moment",
            ));
        }
        let generation = self.meeting_reserve()?;
        let introduction = match self
            .contacts_share(
                expected_root,
                expected_profiles,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.meeting_set_phase(generation, Phase::Failed(error.message.clone()));
                return Err(error);
            }
        };
        if !self.meeting_is_current(generation) {
            return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
        }
        let mut token = [0; 16];
        self.seams.rng.fill(&mut token);
        let fragment = encode_fragment(&endpoint_key, &token);
        let page = self
            .drive_config
            .page_url
            .split(['?', '#'])
            .next()
            .unwrap_or_default();
        let link = format!("{page}#meet/{fragment}");
        let expires = self.seams.clock.now_ms().saturating_add(MEETING_TTL_MS);
        {
            let mut meeting = self.meeting.borrow_mut();
            if meeting.generation != generation {
                return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
            }
            meeting.offer = Some(Offer {
                token,
                expires,
                claimed: false,
                introduction,
            });
        }
        let offer = MeetingOffer { generation, link };
        self.meeting_set_phase(generation, Phase::Offering(offer.clone()));
        self.meeting_arm_expiry(generation, expires);
        self.meeting_status_for(generation)
    }

    /// Join from the fragment handed over by the visor after unseal.
    pub async fn meeting_join(
        self: &Rc<Self>,
        fragment: String,
        expected_root: [u8; 32],
        expected_profiles: Vec<Vec<u8>>,
    ) -> Result<Status, Error> {
        self.identity_open()?;
        let self_endpoint_key = self.engine()?.verifying_key().to_bytes();
        let endpoint = self.endpoint.borrow().clone().ok_or_else(|| {
            Error::new(
                ErrorCode::Unavailable,
                "this device is still binding its endpoint; try again in a moment",
            )
        })?;
        let (host_key, token) =
            decode_fragment(&fragment).map_err(|why| Error::new(ErrorCode::Refused, why))?;
        if host_key == self_endpoint_key {
            return Err(Error::new(
                ErrorCode::Refused,
                "that is this device's own meeting link",
            ));
        }
        let generation = self.meeting_reserve()?;
        self.meeting_set_phase(generation, Phase::Dialing(generation));
        let introduction = match self
            .contacts_share(
                expected_root,
                expected_profiles,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.meeting_set_phase(generation, Phase::Failed(error.message.clone()));
                return Err(error);
            }
        };
        if !self.meeting_is_current(generation) {
            return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
        }
        let expires = self.seams.clock.now_ms().saturating_add(MEETING_TTL_MS);
        self.meeting_arm_expiry(generation, expires);

        let kernel = Rc::clone(self);
        self.seams.spawn.spawn(Box::pin(async move {
            let endpoint_id = kernel.seams.net.endpoint_id(host_key);
            let connect = endpoint.connect(endpoint_id, MEETING_ALPN.to_string());
            let timeout = kernel.seams.clock.sleep(MEETING_TTL_MS);
            let outcome = match futures::future::select(connect, timeout).await {
                Either::Right(_) => Err("that meeting connection timed out".into()),
                Either::Left((Ok((dialed, transport)), _)) if dialed == host_key => {
                    if !kernel.meeting_is_current(generation) {
                        transport.close().await;
                        return;
                    }
                    kernel
                        .meeting_run_guest(generation, host_key, token, introduction, transport)
                        .await
                }
                Either::Left((Ok(_), _)) => {
                    Err("that device answered with a different endpoint key".into())
                }
                Either::Left((Err(why), _)) => Err(why),
            };
            kernel.meeting_finish(generation, outcome);
        }));
        self.meeting_status_for(generation)
    }

    /// Confirm exactly the reviewed generation and its whole issuer identity.
    pub async fn meeting_confirm(&self, generation: u32) -> Result<(), Error> {
        self.identity_open()?;
        let mut meeting = self.meeting.borrow_mut();
        let Phase::AwaitingConfirm(review) = &meeting.phase else {
            return Err(Error::new(
                ErrorCode::Refused,
                "there is nothing to confirm",
            ));
        };
        if generation != meeting.generation || generation != review.generation {
            return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
        }
        let Some(confirm) = meeting.session.as_mut().and_then(|s| s.confirm.take()) else {
            return Err(Error::new(
                ErrorCode::Refused,
                "there is nothing to confirm",
            ));
        };
        let _sent = confirm.send(());
        Ok(())
    }

    pub async fn meeting_cancel(&self, generation: u32) -> Result<(), Error> {
        self.identity_open()?;
        let (new_generation, session) = {
            let mut meeting = self.meeting.borrow_mut();
            if meeting.generation != generation {
                return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
            }
            // Invalidate before awaiting transport shutdown: no completion
            // captured under the cancelled generation may act afterwards.
            meeting.generation = next_generation(meeting.generation)?;
            meeting.offer = None;
            meeting.phase = Phase::Idle;
            (meeting.generation, meeting.session.take())
        };
        self.push_event(crate::Event::MeetingChanged(Status {
            generation: new_generation,
            phase: Phase::Idle,
        }));
        self.meeting_dispose(session);
        Ok(())
    }

    pub async fn meeting_status(&self) -> Result<Status, Error> {
        self.identity_open()?;
        let (generation, expired) = {
            let meeting = self.meeting.borrow();
            (
                meeting.generation,
                meeting.offer.as_ref().is_some_and(|offer| {
                    self.seams.clock.now_ms() >= offer.expires
                        && matches!(meeting.phase, Phase::Offering(_))
                }),
            )
        };
        if expired {
            self.meeting_expire(generation);
        }
        let meeting = self.meeting.borrow();
        Ok(Status {
            generation: meeting.generation,
            phase: meeting.phase.clone(),
        })
    }

    /// Pairing may replace the user's contacts identity. Invalidate any
    /// meeting before adoption so no old signed card can be accepted under the
    /// newly adopted identity.
    pub(crate) async fn meeting_invalidate(&self) {
        let generation = {
            let meeting = self.meeting.borrow();
            self.meeting_is_active(meeting.generation)
                .then_some(meeting.generation)
        };
        if let Some(generation) = generation {
            let _ignored = self.meeting_cancel(generation).await;
        }
    }

    pub(crate) async fn meeting_accept(
        self: &Rc<Self>,
        _guest_id: String,
        guest_endpoint_key: [u8; 32],
        transport: Box<dyn EngineTransport>,
    ) {
        let Join::Ceremony(generation, outcome) =
            self.meeting_run_host(guest_endpoint_key, transport).await
        else {
            return;
        };
        self.meeting_finish(generation, outcome);
    }

    async fn meeting_run_guest(
        self: &Rc<Self>,
        generation: u32,
        host_endpoint_key: [u8; 32],
        token: [u8; 16],
        guest_bytes: Vec<u8>,
        transport: Box<dyn EngineTransport>,
    ) -> Result<String, String> {
        let (transport, mut frames, mut confirm) =
            self.meeting_bind_session(generation, Rc::from(transport))?;
        let guest_endpoint_key = self
            .engine()
            .map_err(|error| error.message)?
            .verifying_key()
            .to_bytes();
        let mut guest_nonce = [0; 32];
        self.seams.rng.fill(&mut guest_nonce);
        send_frame(
            transport.as_ref(),
            &Frame::Claim {
                token: token.to_vec(),
                endpoint_key: guest_endpoint_key.to_vec(),
                introduction: guest_bytes.clone(),
                commit: commitment(&guest_nonce).to_vec(),
            },
        )
        .await?;
        let (host_bytes, host_commit) = match frames.next().await {
            Some(Frame::Accept {
                endpoint_key,
                introduction,
                commit,
            }) if endpoint_key.as_slice() == host_endpoint_key.as_slice() => {
                (introduction, fixed32(&commit, "commitment")?)
            }
            Some(Frame::Refused) => return Err("that meeting link is spent or expired".into()),
            Some(Frame::Cancel) => return Err(cancelled()),
            Some(_) => return Err(out_of_order()),
            None => return Err(gone()),
        };
        let host_intro = self
            .contacts_validate_meeting_introduction(&host_bytes)
            .await
            .map_err(|error| error.message)?;
        send_frame(
            transport.as_ref(),
            &Frame::Reveal {
                nonce: guest_nonce.to_vec(),
            },
        )
        .await?;
        let host_nonce = next_reveal(&mut frames).await?;
        if commitment(&host_nonce) != host_commit {
            return Err("that device's nonce did not match its commitment".into());
        }
        let sas = sas(
            &token,
            &guest_endpoint_key,
            &host_endpoint_key,
            &guest_bytes,
            &host_bytes,
            &guest_nonce,
            &host_nonce,
        );
        self.meeting_confirm_and_persist(
            generation,
            transport,
            &mut frames,
            &mut confirm,
            sas,
            host_intro,
        )
        .await
    }

    async fn meeting_run_host(
        self: &Rc<Self>,
        guest_endpoint_key: [u8; 32],
        transport: Box<dyn EngineTransport>,
    ) -> Join {
        let transport: Rc<dyn EngineTransport> = Rc::from(transport);
        let first = recv_frame(transport.as_ref());
        let timeout = self.seams.clock.sleep(MEETING_TTL_MS);
        let (token, wire_key, guest_bytes, guest_commit) =
            match futures::future::select(Box::pin(first), timeout).await {
                Either::Left((
                    Ok(Some(Frame::Claim {
                        token,
                        endpoint_key,
                        introduction,
                        commit,
                    })),
                    _,
                )) => (token, endpoint_key, introduction, commit),
                _ => {
                    transport.close().await;
                    return Join::Ignored;
                }
            };
        if wire_key.as_slice() != guest_endpoint_key.as_slice() {
            transport.close().await;
            return Join::Ignored;
        }
        let verdict = {
            let now = self.seams.clock.now_ms();
            let mut meeting = self.meeting.borrow_mut();
            let generation = meeting.generation;
            match meeting.offer.as_ref() {
                None => Verdict::Ignore,
                Some(offer) if token.as_slice() != offer.token.as_slice() => Verdict::Ignore,
                Some(offer) if offer.claimed => {
                    let new_generation = match burn_generation(&mut meeting) {
                        Ok(generation) => generation,
                        Err(_) => return Join::Ignored,
                    };
                    Verdict::Burn(new_generation, meeting.session.take())
                }
                Some(offer) if now >= offer.expires => Verdict::Refuse,
                Some(offer) => {
                    let introduction = offer.introduction.clone();
                    meeting.offer.as_mut().expect("offer just matched").claimed = true;
                    Verdict::Claim(generation, introduction)
                }
            }
        };
        let (generation, host_bytes) = match verdict {
            Verdict::Ignore => {
                transport.close().await;
                return Join::Ignored;
            }
            Verdict::Refuse => {
                self.meeting_reject(transport, Frame::Refused);
                return Join::Ignored;
            }
            Verdict::Burn(generation, original) => {
                self.push_event(crate::Event::MeetingChanged(Status {
                    generation,
                    phase: Phase::Failed(
                        "someone else used this meeting link; make a new one".into(),
                    ),
                }));
                self.meeting_dispose(original);
                self.meeting_reject(transport, Frame::Refused);
                return Join::Ignored;
            }
            Verdict::Claim(generation, bytes) => (generation, bytes),
        };
        let outcome = self
            .meeting_run_claimed(
                generation,
                guest_endpoint_key,
                token,
                guest_bytes,
                guest_commit,
                host_bytes,
                transport,
            )
            .await;
        if self.meeting_is_current(generation) {
            self.meeting.borrow_mut().offer = None;
        }
        Join::Ceremony(generation, outcome)
    }

    #[allow(clippy::too_many_arguments)]
    async fn meeting_run_claimed(
        self: &Rc<Self>,
        generation: u32,
        guest_endpoint_key: [u8; 32],
        token: Vec<u8>,
        guest_bytes: Vec<u8>,
        guest_commit: Vec<u8>,
        host_bytes: Vec<u8>,
        transport: Rc<dyn EngineTransport>,
    ) -> Result<String, String> {
        let token: [u8; 16] = token
            .as_slice()
            .try_into()
            .map_err(|_| "that meeting token is malformed".to_string())?;
        let guest_commit = fixed32(&guest_commit, "commitment")?;
        let guest_intro = self
            .contacts_validate_meeting_introduction(&guest_bytes)
            .await
            .map_err(|error| error.message)?;
        let host_endpoint_key = self
            .engine()
            .map_err(|error| error.message)?
            .verifying_key()
            .to_bytes();
        let (transport, mut frames, mut confirm) =
            self.meeting_bind_session(generation, transport)?;
        let mut host_nonce = [0; 32];
        self.seams.rng.fill(&mut host_nonce);
        send_frame(
            transport.as_ref(),
            &Frame::Accept {
                endpoint_key: host_endpoint_key.to_vec(),
                introduction: host_bytes.clone(),
                commit: commitment(&host_nonce).to_vec(),
            },
        )
        .await?;
        let guest_nonce = next_reveal(&mut frames).await?;
        if commitment(&guest_nonce) != guest_commit {
            return Err("that device's nonce did not match its commitment".into());
        }
        send_frame(
            transport.as_ref(),
            &Frame::Reveal {
                nonce: host_nonce.to_vec(),
            },
        )
        .await?;
        let sas = sas(
            &token,
            &guest_endpoint_key,
            &host_endpoint_key,
            &guest_bytes,
            &host_bytes,
            &guest_nonce,
            &host_nonce,
        );
        self.meeting_confirm_and_persist(
            generation,
            transport,
            &mut frames,
            &mut confirm,
            sas,
            guest_intro,
        )
        .await
    }

    async fn meeting_confirm_and_persist(
        self: &Rc<Self>,
        generation: u32,
        transport: Rc<dyn EngineTransport>,
        frames: &mut mpsc::Receiver<Frame>,
        confirm: &mut oneshot::Receiver<()>,
        sas: String,
        peer_intro: polyvisor_contacts_model::VerifiedIntroduction,
    ) -> Result<String, String> {
        let review = review(generation, sas, peer_intro.introduction());
        if !self.meeting_set_phase(generation, Phase::AwaitingConfirm(review)) {
            return Err("that meeting was replaced".into());
        }
        let (mut confirmed, mut peer_confirmed) = (false, false);
        while !confirmed || !peer_confirmed {
            let woke = if confirmed {
                Wake::Frame(frames.next().await)
            } else {
                wait(confirm, frames).await
            };
            if !self.meeting_is_current(generation) {
                return Err("that meeting was replaced".into());
            }
            match woke {
                Wake::Confirmed => {
                    confirmed = true;
                    send_frame(transport.as_ref(), &Frame::Confirm).await?;
                    if !peer_confirmed {
                        self.meeting_set_phase(generation, Phase::AwaitingPeer);
                    }
                }
                Wake::Frame(Some(Frame::Confirm)) => peer_confirmed = true,
                Wake::Frame(Some(Frame::Cancel)) => return Err(cancelled()),
                Wake::Frame(Some(_)) => return Err(out_of_order()),
                Wake::Frame(None) => return Err(gone()),
            }
        }

        if !self.meeting_is_current(generation) {
            return Err("that meeting was replaced".into());
        }
        // The hook repeats the generation check inside its document mutation,
        // then checkpoints before returning the local contact id.
        let contact_id = self
            .contacts_accept_meeting(generation, peer_intro)
            .await
            .map_err(|error| error.message)?;
        if !self.meeting_is_current(generation) {
            // Persistence may already have completed. Its result must not
            // overwrite the replacement meeting's phase or transport state.
            return Err("that meeting was replaced".into());
        }
        self.meeting_set_phase(generation, Phase::Done(contact_id.clone()));

        // ACCEPTED is sent only after the local checkpoint. Each peer then
        // waits for the other's receipt before normal close, preventing QUIC
        // close from overtaking unread final bytes. A missing peer receipt is
        // not failure: this side's contact is already durable and remains Done.
        let receipt = async {
            let _sent = send_frame(transport.as_ref(), &Frame::Accepted).await;
            frames.next().await
        };
        let timeout = self.seams.clock.sleep(MEETING_TTL_MS);
        let _best_effort = futures::future::select(Box::pin(receipt), timeout).await;
        Ok(contact_id)
    }

    fn meeting_bind_session(
        self: &Rc<Self>,
        generation: u32,
        transport: Rc<dyn EngineTransport>,
    ) -> Result<Bound, String> {
        let (tx, rx) = mpsc::channel(READER_CAPACITY);
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let cancelled = Rc::new(Cell::new(false));
        {
            let mut meeting = self.meeting.borrow_mut();
            if generation != meeting.generation || meeting.session.is_some() {
                return Err("this device is already meeting".into());
            }
            meeting.session = Some(Session {
                generation,
                transport: Rc::clone(&transport),
                confirm: Some(confirm_tx),
                cancelled: Rc::clone(&cancelled),
            });
        }
        let reader = Rc::clone(&transport);
        let weak = Rc::downgrade(self);
        self.seams.spawn.spawn(Box::pin(async move {
            let mut tx = tx;
            loop {
                let frame = match recv_frame(reader.as_ref()).await {
                    Ok(Some(frame)) => frame,
                    Ok(None) => return,
                    Err(()) => {
                        reader.close().await;
                        return;
                    }
                };
                let Some(kernel) = weak.upgrade() else { return };
                if !kernel.meeting_is_current(generation) {
                    return;
                }
                drop(kernel);
                if tx.send(frame).await.is_err() {
                    return;
                }
            }
        }));
        Ok((transport, rx, confirm_rx))
    }

    fn meeting_reserve(&self) -> Result<u32, Error> {
        let (generation, old) = {
            let mut meeting = self.meeting.borrow_mut();
            meeting.generation = next_generation(meeting.generation)?;
            meeting.offer = None;
            meeting.phase = Phase::Idle;
            (meeting.generation, meeting.session.take())
        };
        self.meeting_dispose(old);
        Ok(generation)
    }

    fn meeting_arm_expiry(self: &Rc<Self>, generation: u32, expires: u64) {
        let kernel = Rc::clone(self);
        let delay = expires.saturating_sub(self.seams.clock.now_ms());
        self.seams.spawn.spawn(Box::pin(async move {
            kernel.seams.clock.sleep(delay).await;
            if kernel.meeting_is_active(generation) && kernel.seams.clock.now_ms() >= expires {
                kernel.meeting_expire(generation);
            }
        }));
    }

    fn meeting_expire(&self, generation: u32) {
        if !self.meeting_is_active(generation) {
            return;
        }
        let (new_generation, transport) = {
            let mut meeting = self.meeting.borrow_mut();
            let Ok(next) = next_generation(meeting.generation) else {
                meeting.offer = None;
                meeting.phase = Phase::Failed("meeting generations exhausted".into());
                return;
            };
            meeting.generation = next;
            meeting.offer = None;
            meeting.phase = Phase::Failed("this meeting expired".into());
            let transport = meeting.session.take().map(|session| {
                session.cancelled.set(true);
                session.transport
            });
            (next, transport)
        };
        self.push_event(crate::Event::MeetingChanged(Status {
            generation: new_generation,
            phase: Phase::Failed("this meeting expired".into()),
        }));
        if let Some(transport) = transport {
            self.seams
                .spawn
                .spawn(Box::pin(async move { transport.close().await }));
        }
    }

    fn meeting_finish(&self, generation: u32, outcome: Result<String, String>) {
        if !self.meeting_is_current(generation) {
            return;
        }
        let session = {
            let mut meeting = self.meeting.borrow_mut();
            match meeting.session.as_ref() {
                Some(session) if session.generation == generation => meeting.session.take(),
                _ => None,
            }
        };
        if session
            .as_ref()
            .is_some_and(|session| session.cancelled.get())
        {
            return;
        }
        if !matches!(self.meeting.borrow().phase, Phase::Done(_)) {
            self.meeting_set_phase(
                generation,
                match outcome {
                    Ok(contact_id) => Phase::Done(contact_id),
                    Err(why) => Phase::Failed(why),
                },
            );
        }
        if let Some(session) = session {
            let transport = session.transport;
            self.seams
                .spawn
                .spawn(Box::pin(async move { transport.close().await }));
        }
    }

    fn meeting_is_current(&self, generation: u32) -> bool {
        self.meeting.borrow().generation == generation
    }

    fn meeting_status_for(&self, generation: u32) -> Result<Status, Error> {
        let meeting = self.meeting.borrow();
        if meeting.generation != generation {
            return Err(Error::new(ErrorCode::Refused, "that meeting was replaced"));
        }
        Ok(Status {
            generation,
            phase: meeting.phase.clone(),
        })
    }

    pub(crate) fn meeting_is_generation(&self, generation: u32) -> bool {
        self.meeting_is_current(generation)
    }

    fn meeting_dispose(&self, session: Option<Session>) {
        let Some(session) = session else { return };
        session.cancelled.set(true);
        let clock = Rc::clone(&self.seams.clock);
        self.seams.spawn.spawn(Box::pin(async move {
            let send = send_frame(session.transport.as_ref(), &Frame::Cancel);
            let timeout = clock.sleep(CLEANUP_SEND_MS);
            let _attempted = futures::future::select(Box::pin(send), timeout).await;
            session.transport.close().await;
        }));
    }

    fn meeting_reject(&self, transport: Rc<dyn EngineTransport>, frame: Frame) {
        let clock = Rc::clone(&self.seams.clock);
        self.seams.spawn.spawn(Box::pin(async move {
            let send = send_frame(transport.as_ref(), &frame);
            let timeout = clock.sleep(CLEANUP_SEND_MS);
            let _attempted = futures::future::select(Box::pin(send), timeout).await;
            transport.close().await;
        }));
    }

    fn meeting_is_active(&self, generation: u32) -> bool {
        let meeting = self.meeting.borrow();
        meeting.generation == generation
            && !matches!(
                meeting.phase,
                Phase::Idle | Phase::Done(_) | Phase::Failed(_)
            )
    }

    fn meeting_set_phase(&self, generation: u32, phase: Phase) -> bool {
        let mut meeting = self.meeting.borrow_mut();
        if !transition(&mut meeting, generation, phase.clone()) {
            return false;
        }
        drop(meeting);
        self.push_event(crate::Event::MeetingChanged(Status { generation, phase }));
        true
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Frame {
    Claim {
        token: Vec<u8>,
        endpoint_key: Vec<u8>,
        introduction: Vec<u8>,
        commit: Vec<u8>,
    },
    Accept {
        endpoint_key: Vec<u8>,
        introduction: Vec<u8>,
        commit: Vec<u8>,
    },
    Reveal {
        nonce: Vec<u8>,
    },
    Confirm,
    Accepted,
    Refused,
    Cancel,
}

async fn send_frame(transport: &dyn EngineTransport, frame: &Frame) -> Result<(), String> {
    let bytes = serde_json::to_vec(frame).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("that meeting frame is too large".into());
    }
    transport.send(bytes).await
}

async fn recv_frame(transport: &dyn EngineTransport) -> Result<Option<Frame>, ()> {
    let Some(bytes) = transport.recv().await else {
        return Ok(None);
    };
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}

async fn next_reveal(frames: &mut mpsc::Receiver<Frame>) -> Result<[u8; 32], String> {
    match frames.next().await {
        Some(Frame::Reveal { nonce }) => fixed32(&nonce, "nonce"),
        Some(Frame::Cancel) => Err(cancelled()),
        Some(_) => Err(out_of_order()),
        None => Err(gone()),
    }
}

enum Wake {
    Confirmed,
    Frame(Option<Frame>),
}

async fn wait(confirm: &mut oneshot::Receiver<()>, frames: &mut mpsc::Receiver<Frame>) -> Wake {
    match futures::future::select(confirm, frames.next()).await {
        Either::Left((Ok(()), _)) => Wake::Confirmed,
        Either::Left((Err(_), _)) => Wake::Frame(None),
        Either::Right((frame, _)) => Wake::Frame(frame),
    }
}

fn review(generation: u32, sas: String, introduction: &Introduction) -> MeetingReview {
    let binding = polyvisor_contacts_model::verify_root_binding(&introduction.issuer.binding)
        .expect("validated introduction has a valid binding");
    let claims = introduction
        .issuer
        .profiles
        .iter()
        .filter_map(|profile| polyvisor_contacts_model::verify_profile(profile).ok())
        .flat_map(|profile| profile.claims)
        .collect::<Vec<_>>();
    MeetingReview {
        generation,
        sas,
        peer_key: binding.root.to_bytes().to_vec(),
        claims: claim_pairs(&claims),
    }
}

fn claim_pairs(claims: &[Claim]) -> Vec<(String, String)> {
    claims
        .iter()
        .map(|claim| (claim.name.clone(), claim.value.clone()))
        .collect()
}

fn next_generation(current: u32) -> Result<u32, Error> {
    current.checked_add(1).ok_or_else(|| {
        Error::new(
            ErrorCode::Unavailable,
            "this runtime has exhausted meeting generations",
        )
    })
}

fn transition(meeting: &mut Meeting, generation: u32, phase: Phase) -> bool {
    if meeting.generation != generation || matches!(meeting.phase, Phase::Done(_)) {
        return false;
    }
    if matches!(phase, Phase::Done(_)) {
        meeting.offer = None;
    }
    meeting.phase = phase;
    true
}

fn burn_generation(meeting: &mut Meeting) -> Result<u32, Error> {
    meeting.generation = next_generation(meeting.generation)?;
    meeting.offer = None;
    meeting.phase = Phase::Failed("someone else used this meeting link; make a new one".into());
    Ok(meeting.generation)
}

fn commitment(nonce: &[u8; 32]) -> [u8; 32] {
    *blake3::hash(nonce).as_bytes()
}

fn fixed32(bytes: &[u8], name: &str) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| format!("that device sent a malformed {name}"))
}

fn cancelled() -> String {
    "the other person cancelled".into()
}

fn gone() -> String {
    "the other device went away".into()
}

fn out_of_order() -> String {
    "that device did not speak meeting".into()
}

fn encode_fragment(key: &[u8; 32], token: &[u8; 16]) -> String {
    let mut payload = Vec::with_capacity(49);
    payload.push(CODE_VERSION);
    payload.extend_from_slice(key);
    payload.extend_from_slice(token);
    data_encoding::BASE32_NOPAD_VISUAL.encode(&payload)
}

fn decode_fragment(fragment: &str) -> Result<([u8; 32], [u8; 16]), String> {
    let fragment = fragment.strip_prefix("meet/").unwrap_or(fragment);
    let cleaned: String = fragment
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .collect();
    let payload = data_encoding::BASE32_NOPAD_VISUAL
        .decode(cleaned.as_bytes())
        .map_err(|_| "that is not a meeting fragment".to_string())?;
    if payload.len() != 49 || payload[0] != CODE_VERSION {
        return Err("that meeting fragment has the wrong version or length".into());
    }
    Ok((
        payload[1..33].try_into().expect("length checked"),
        payload[33..49].try_into().expect("length checked"),
    ))
}

#[allow(clippy::too_many_arguments)]
fn sas(
    token: &[u8; 16],
    guest_endpoint_key: &[u8; 32],
    host_endpoint_key: &[u8; 32],
    guest_introduction: &[u8],
    host_introduction: &[u8],
    guest_nonce: &[u8; 32],
    host_nonce: &[u8; 32],
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"polyvisor:meeting:sas:v0\0");
    for field in [
        token.as_slice(),
        guest_endpoint_key.as_slice(),
        host_endpoint_key.as_slice(),
        guest_introduction,
        host_introduction,
        guest_nonce.as_slice(),
        host_nonce.as_slice(),
    ] {
        hasher.update(&(field.len() as u32).to_be_bytes());
        hasher.update(field);
    }
    let digest = hasher.finalize();
    let head = u32::from_be_bytes(digest.as_bytes()[..4].try_into().expect("four bytes"));
    format!("{:06}", head % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_round_trips_with_or_without_kind_prefix() {
        let key = [7; 32];
        let token = [9; 16];
        let fragment = encode_fragment(&key, &token);
        assert_eq!(decode_fragment(&fragment).unwrap(), (key, token));
        assert_eq!(
            decode_fragment(&format!("meet/{fragment}")).unwrap(),
            (key, token)
        );
    }

    #[test]
    fn frames_preserve_exact_introduction_bytes() {
        let frame = Frame::Accept {
            endpoint_key: vec![1; 32],
            introduction: vec![0, 255, 4, 0, 7],
            commit: vec![2; 32],
        };
        let encoded = serde_json::to_vec(&frame).unwrap();
        assert_eq!(serde_json::from_slice::<Frame>(&encoded).unwrap(), frame);
    }

    #[test]
    fn sas_binds_keys_exact_introductions_and_nonces() {
        let values = ([1; 16], [2; 32], [3; 32], [4; 32], [5; 32]);
        let base = sas(
            &values.0, &values.1, &values.2, b"a", b"bc", &values.3, &values.4,
        );
        assert_eq!(base.len(), 6);
        assert_ne!(
            base,
            sas(
                &values.0, &values.1, &values.2, b"ab", b"c", &values.3, &values.4
            )
        );
        assert_ne!(
            base,
            sas(
                &values.0, &values.2, &values.1, b"a", b"bc", &values.3, &values.4
            )
        );
        assert_ne!(
            base,
            sas(
                &values.0, &values.1, &values.2, b"a", b"bc", &values.4, &values.3
            )
        );
    }

    #[test]
    fn second_claim_invalidates_the_original_generation_before_cleanup() {
        let mut meeting = Meeting {
            generation: 4,
            phase: Phase::AwaitingConfirm(MeetingReview {
                generation: 4,
                sas: "123456".into(),
                peer_key: vec![1; 32],
                claims: Vec::new(),
            }),
            offer: Some(Offer {
                token: [2; 16],
                expires: 10,
                claimed: true,
                introduction: Vec::new(),
            }),
            session: None,
        };
        assert_eq!(burn_generation(&mut meeting).unwrap(), 5);
        assert!(!transition(&mut meeting, 4, Phase::Done("stale".into())));
        assert!(matches!(meeting.phase, Phase::Failed(_)));
    }

    #[test]
    fn done_retires_the_offer_and_is_final_during_receipt_wait() {
        let mut meeting = Meeting {
            generation: 8,
            phase: Phase::AwaitingPeer,
            offer: Some(Offer {
                token: [2; 16],
                expires: 10,
                claimed: true,
                introduction: Vec::new(),
            }),
            session: None,
        };
        assert!(transition(&mut meeting, 8, Phase::Done("contact".into())));
        assert!(meeting.offer.is_none());
        assert!(!transition(&mut meeting, 8, Phase::Failed("replay".into())));
        assert_eq!(meeting.phase, Phase::Done("contact".into()));
    }
}
