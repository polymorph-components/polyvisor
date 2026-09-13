//! Device pairing: the ceremony that enrolls a device into the group
//! (internal.wit `interface pairing`).
//!
//! The protocol rules are:
//!
//! - The **joiner** shows a code — `0x01 ‖ its endpoint key(32) ‖ token(16)`
//!   in `BASE32_NOPAD_VISUAL`, 79 characters. The **adder** types or scans it
//!   and dials. No links: pairing is started interactively on both devices,
//!   so nothing enrollment-shaped is ever reachable from a URL.
//! - The offer lives 120 s and is **single-claim**: the first CLAIM binds the
//!   session, a second is refused *and burns the bound one*, because a code
//!   that reached a second party has leaked.
//! - CLAIM carries `blake3(nonce_a)` and REVEAL carries `nonce_a`, so the
//!   dialing side is committed to its nonce before it learns the joiner's —
//!   which is what stops it grinding the 20-bit SAS.
//! - Both sides derive the same six digits from the same transcript, both
//!   users compare them, and **both** confirm. Only then does the adder write
//!   the joiner into the user-system document and send it over.
//! - The joiner **adopts** that document — its group of one is discarded —
//!   acknowledges with ENROLLED, and only
//!   then dials the adder on the subduction ALPN. That order is load-bearing:
//!   the membership check on a subduction connection consults the group, and
//!   both sides must already agree on it before the dial.
//! - The adder does not return until that acknowledgement arrives or the wire
//!   ends. Ending the ceremony closes the transport, and on QUIC a close that
//!   overtakes the peer's read throws away the bytes it has not read — which
//!   silently cost the joiner the ENROLL frame itself. The ack is the read
//!   receipt; nothing about it is a timeout or a sleep.
//!
//! Pairing has its own ALPN ([`crate::PAIRING_ALPN`]) so the accept loop can
//! route by it; a pairing connection is answered only while an offer is open.
//!
//! Framing: one [`Frame`] is one `serde_json` message is one
//! `EngineTransport::send`, and that seam is already the contract's u32-BE
//! length prefix (`runtime/component/src/net.rs`). Unknown or undecodable
//! bytes end the connection rather than being skipped — reject-on-unknown, so
//! a peer that speaks something else is not silently tolerated.

use std::cell::Cell;
use std::rc::Rc;

use futures::StreamExt as _;
use futures::channel::{mpsc, oneshot};
use futures::future::Either;
use serde::{Deserialize, Serialize};

use crate::{EngineTransport, Error, ErrorCode, Kernel, PAIRING_ALPN};

/// How long an offer stands.
const OFFER_TTL_MS: u64 = 120_000;

/// The code's version byte. A different first byte is a different ceremony,
/// and is refused rather than guessed at.
const CODE_VERSION: u8 = 0x01;

/// `polyvisor:internal/pairing.phase`, one for one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    /// Joiner: showing the code.
    Offering(String),
    /// Adder: dialing and claiming.
    Claiming,
    /// Both: the SAS to compare; confirm or cancel.
    AwaitingConfirm(String),
    /// Confirmed here, waiting for the other side.
    AwaitingPeer,
    /// Enrolled (joiner) or enrolled the peer (adder).
    Done,
    /// Framework voice.
    Failed(String),
}

/// The open offer this device is showing.
struct Offer {
    token: [u8; 16],
    /// Epoch milliseconds; the offer is dead at and after this.
    expires: u64,
    /// Single-claim: set by the CLAIM that binds the session.
    claimed: bool,
}

/// The live exchange, whichever side we are.
struct Session {
    transport: Rc<dyn EngineTransport>,
    /// Fired by `pairing.confirm`; the session task is awaiting it.
    confirm: Option<oneshot::Sender<()>>,
    /// Set by `pairing.cancel`, so the session task's tear-down leaves the
    /// phase this device chose rather than reporting the wire going quiet.
    cancelled: Rc<Cell<bool>>,
}

struct AdoptionPayload<'a> {
    adder_key: [u8; 32],
    name_key: [u8; 32],
    us: &'a [u8],
    keyhive: &'a [u8],
    read_back: &'a [u8],
    visor: &'a [u8],
    contacts: &'a [u8],
}

/// A bound session's three handles: the shared transport, the frames its
/// reader task delivers, and the confirmation `pairing.confirm` fires.
type Bound = (
    Rc<dyn EngineTransport>,
    mpsc::UnboundedReceiver<Frame>,
    oneshot::Receiver<()>,
);

/// What one inbound pairing connection came to.
pub(crate) enum Join {
    /// Nothing of this device's happened: no session was bound, and the
    /// phase is not this connection's to set.
    Ignored,
    /// This connection *was* the claim, and here is how it ended.
    Ceremony(Result<(), String>),
}

/// What a CLAIM that arrived turns out to be, decided under one borrow.
enum Verdict {
    /// Not for us: no offer, or a token this device never minted.
    Ignore,
    /// Ours, but the code has run out of time.
    Refuse,
    /// Ours, and already claimed — the code has leaked.
    Burn,
    /// Ours, unspent, in time. The offer is spent from that moment.
    Claim,
}

/// Everything pairing keeps, in one cell.
#[derive(Default)]
pub struct Pairing {
    phase: Phase,
    offer: Option<Offer>,
    session: Option<Session>,
}

// -- the exports -------------------------------------------------------------

impl Kernel {
    /// `pairing.offer`: mint an offer and answer the code. Replaces any open
    /// offer, and cancels any exchange in flight — a device shows one code.
    pub async fn pairing_offer(self: &Rc<Self>) -> Result<String, Error> {
        self.open()?;
        let engine = self.engine()?;
        // The code names the endpoint the adder must dial, so there has to be
        // one. A device still binding says so rather than minting a code
        // nobody can reach.
        if self.endpoint.borrow().is_none() {
            return Err(Error::new(
                ErrorCode::Unavailable,
                match self.bind_error.borrow().as_ref() {
                    Some(why) => format!("this device has no endpoint: {why}"),
                    None => "this device is still binding its endpoint; \
                             try again in a moment"
                        .to_string(),
                },
            ));
        }
        self.tear_down_session().await;

        let mut token = [0u8; 16];
        self.seams.rng.fill(&mut token);
        let key = engine.verifying_key().to_bytes();
        let code = encode_code(&key, &token);
        let expires = self.seams.clock.now_ms().saturating_add(OFFER_TTL_MS);
        {
            let mut pairing = self.pairing.borrow_mut();
            pairing.offer = Some(Offer {
                token,
                expires,
                claimed: false,
            });
        }
        self.set_phase(Phase::Offering(code.clone()));
        Ok(code)
    }

    /// `pairing.claim`: dial the device showing `code` and run the adder's
    /// side.
    pub async fn pairing_claim(self: &Rc<Self>, code: String) -> Result<(), Error> {
        self.open()?;
        let _engine = self.engine()?;
        let endpoint = self.endpoint.borrow().clone().ok_or_else(|| {
            Error::new(
                ErrorCode::Unavailable,
                "this device is still binding its endpoint; try again in a moment",
            )
        })?;
        let (key, token) = decode_code(&code).map_err(|why| Error::new(ErrorCode::Refused, why))?;
        if key == self.self_key()? {
            return Err(Error::new(
                ErrorCode::Refused,
                "that is this device's own code",
            ));
        }
        self.tear_down_session().await;
        {
            let mut pairing = self.pairing.borrow_mut();
            // The adder is not showing a code; an offer left over from a
            // previous attempt would keep answering dials.
            pairing.offer = None;
        }
        self.set_phase(Phase::Claiming);
        let kernel = Rc::clone(self);
        self.seams.spawn.spawn(Box::pin(async move {
            let id = kernel.seams.net.endpoint_id(key);
            let outcome = match endpoint.connect(id.clone(), PAIRING_ALPN.to_string()).await {
                Ok((dialed, transport)) if dialed == key => {
                    kernel.run_adder(key, token, transport).await
                }
                // Cannot happen through the iroh endpoint, where the id
                // *is* the key — but the seam is a trait, and a peer that
                // answered as somebody else is exactly what pairing is
                // supposed to notice.
                Ok(_) => Err("that device answered with a different key".to_string()),
                Err(why) => Err(why),
            };
            kernel.finish(outcome);
        }));
        Ok(())
    }

    /// `pairing.confirm`: this user has compared the digits.
    pub fn pairing_confirm(&self) -> Result<(), Error> {
        self.open()?;
        let mut pairing = self.pairing.borrow_mut();
        if !matches!(pairing.phase, Phase::AwaitingConfirm(_)) {
            return Err(Error::new(
                ErrorCode::Refused,
                "there is nothing to confirm",
            ));
        }
        let Some(confirm) = pairing.session.as_mut().and_then(|s| s.confirm.take()) else {
            return Err(Error::new(
                ErrorCode::Refused,
                "there is nothing to confirm",
            ));
        };
        // The session task is awaiting this; the phase moves when it does.
        let _dropped = confirm.send(());
        Ok(())
    }

    /// `pairing.cancel`: at any point, from either side. The other side is
    /// told, so it reports `failed` rather than waiting on a device that has
    /// walked away.
    pub async fn pairing_cancel(&self) -> Result<(), Error> {
        self.open()?;
        self.tear_down_session().await;
        // The code goes with the ceremony. A cancelled offer left standing is
        // a code the user believes they revoked, still answering dials.
        self.pairing.borrow_mut().offer = None;
        self.set_phase(Phase::Idle);
        Ok(())
    }

    /// `pairing.status`. Lapses an expired offer on the way past: the clock
    /// is the only thing that ends an offer nobody claimed, and nothing else
    /// is running to notice.
    pub fn pairing_status(&self) -> Result<Phase, Error> {
        self.open()?;
        let now = self.seams.clock.now_ms();
        let mut pairing = self.pairing.borrow_mut();
        let expired = pairing.offer.as_ref().is_some_and(|o| now >= o.expires);
        if expired && matches!(pairing.phase, Phase::Offering(_)) {
            // The offer itself stays. It is dead either way, and keeping it
            // is what lets a claim that arrives late be answered REFUSED
            // rather than met with silence — the difference between the
            // other device saying "ask for a new code" and it hanging.
            let lapsed = Phase::Failed("this code expired; make a new one".to_string());
            pairing.phase = lapsed.clone();
            drop(pairing);
            self.push_event(crate::Event::PairingChanged(lapsed.clone()));
            return Ok(lapsed);
        }
        Ok(pairing.phase.clone())
    }

    // -- the accept loop's half ----------------------------------------------

    /// Whether a connection on the pairing ALPN should be answered at all:
    /// this device is showing a code, spent or not.
    ///
    /// Deliberately the *only* thing decided before a byte is read. Whether
    /// the offer is still claimable is a question that can change between
    /// two dials arriving and either of their CLAIMs being read, so it is
    /// asked once, under one borrow, against the token that arrived — in
    /// [`Kernel::run_joiner`]. Splitting it across the two would be exactly
    /// the window that let two dials both be admitted as *the* claim.
    pub(crate) fn pairing_offering(&self) -> bool {
        self.pairing.borrow().offer.is_some()
    }

    /// The joiner's side of one pairing connection.
    pub(crate) async fn pairing_join(
        self: &Rc<Self>,
        adder_id: String,
        adder_key: [u8; 32],
        transport: Box<dyn EngineTransport>,
    ) {
        let Join::Ceremony(outcome) = self.run_joiner(adder_key, transport).await else {
            // Nothing of this device's became of that connection: no session
            // was bound and the phase is whatever it already was, or what the
            // burn set. Reporting a failure here would let a stranger who
            // dials this ALPN take a ceremony down with a wrong token.
            return;
        };
        let joined = outcome.is_ok();
        self.finish(outcome);
        if joined {
            // Adopt, *then* dial: the membership check on a subduction
            // connection consults the group, and the joiner has only just
            // learned what the group is.
            let _dialed = self.sync_connect(adder_id).await;
        }
    }

    // -- the two roles -------------------------------------------------------

    /// Adder: CLAIM, REVEAL, both confirmations, ENROLL.
    async fn run_adder(
        self: &Rc<Self>,
        joiner_key: [u8; 32],
        token: [u8; 16],
        transport: Box<dyn EngineTransport>,
    ) -> Result<(), String> {
        let (transport, mut frames, mut confirm) = self.bind_session(Rc::from(transport))?;

        let mut nonce_a = [0u8; 32];
        self.seams.rng.fill(&mut nonce_a);
        send_frame(
            transport.as_ref(),
            &Frame::Claim {
                token: token.to_vec(),
                commit: blake3::hash(&nonce_a).as_bytes().to_vec(),
            },
        )
        .await?;

        let (nonce_j, petname, card) = match frames.next().await {
            Some(Frame::Accept {
                nonce,
                key,
                petname,
                card,
            }) => {
                if key.as_slice() != joiner_key.as_slice() {
                    return Err("that device answered for a different key".to_string());
                }
                (nonce32(&nonce)?, petname, card)
            }
            Some(Frame::Refused) => {
                return Err(
                    "that code is spent or expired; ask that device for a new one".to_string(),
                );
            }
            Some(Frame::Cancel) => return Err(cancelled()),
            Some(_) => return Err(out_of_order()),
            None => return Err(gone()),
        };

        send_frame(
            transport.as_ref(),
            &Frame::Reveal {
                nonce: nonce_a.to_vec(),
            },
        )
        .await?;

        let adder_key = self.self_key().map_err(|e| e.message)?;
        let sas = sas(&token, &joiner_key, &adder_key, &nonce_j, &nonce_a);
        self.set_phase(Phase::AwaitingConfirm(sas));

        // Both confirmations, in either order: the user here may compare the
        // digits before or after the user there.
        let (mut here, mut there) = (false, false);
        while !(here && there) {
            // Only wait on the confirmation until it has come: a `oneshot`
            // that has fired reports *cancelled* on the next poll, which
            // would read as the wire going quiet.
            let woke = if here {
                Wake::Frame(frames.next().await)
            } else {
                wait(&mut confirm, &mut frames).await
            };
            match woke {
                Wake::Confirmed => {
                    here = true;
                    if !there {
                        self.set_phase(Phase::AwaitingPeer);
                    }
                }
                Wake::Frame(Some(Frame::ConfirmJoin)) => there = true,
                Wake::Frame(Some(Frame::Cancel)) => return Err(cancelled()),
                Wake::Frame(Some(_)) => return Err(out_of_order()),
                Wake::Frame(None) => return Err(gone()),
            }
        }

        // The consequential grant, and it happens exactly once, here: the
        // joiner is written into this device's group and the whole document
        // goes over. Enrollment is the adder's act — the joiner never writes
        // its own membership.
        let engine = self.engine().map_err(|e| e.message)?;
        self.initialize_personalization()
            .await
            .map_err(|e| e.message)?;
        self.initialize_contacts().await.map_err(|e| e.message)?;
        let enrolled = self.seams.clock.now_ms();
        engine.add_member(joiner_key, petname, enrolled).await?;
        // The keyhive half of the same grant, and in this order: the group
        // document is what names the keyhive group, so a joiner that got the
        // operations first would have nothing to attach them to.
        let (keyhive, read_back) = engine.enroll_keyhive(&card, joiner_key).await?;
        let us = engine.us_save().await?;
        let visor = engine
            .document_save(polyvisor_visor_model::VISOR_APP)
            .await?;
        let contacts = engine.document_save(crate::contacts::CONTACTS_APP).await?;
        // The group's store-name key travels here and nowhere else: it is a
        // group secret, and this connection is the one the two users have
        // just compared six digits over. Without it the joiner would be a
        // member of the group that writes to a *different* set of names in
        // the same Drive folder — two stores, neither converging.
        let name_key = engine
            .name_key()
            .ok_or_else(|| "this device has no group to enroll into".to_string())?;
        send_frame(
            transport.as_ref(),
            &Frame::Enroll {
                us,
                keyhive,
                read_back,
                name_key: name_key.to_vec(),
                visor,
                contacts,
            },
        )
        .await?;

        // **Wait for the joiner's ENROLLED before returning.** Returning here
        // ends the ceremony, and `finish` closes the transport — which on the
        // iroh path is `send.finish()` followed immediately by
        // `connection.close()`. A QUIC CONNECTION_CLOSE that arrives before
        // the peer has read the stream's final bytes discards them (quinn
        // drops unread stream data on close), so an adder that closed the
        // moment ENROLL was *written* raced the joiner into reading EOF
        // instead of the enrollment — the joiner ended `failed("the other
        // device went away")` while the adder's group already held both
        // devices. The ack is the read receipt: it cannot arrive until the
        // joiner has consumed ENROLL, so waiting for it is what keeps the
        // connection open exactly long enough.
        //
        // Every way of not getting it is still `Done`, and that is not
        // laxity. The grant already happened on this device — the joiner is
        // in the group document and in the keyhive group, and both are
        // checkpointed below whatever the wire does next. A joiner that
        // adopted and lost the ack is enrolled; a joiner that never adopted
        // will be told it is a member by the group document itself on the
        // first sync. Failing here would report a ceremony that did happen as
        // one that did not, and leave the two devices disagreeing about it.
        // Any answer ends the wait, `Cancel` included: a joiner that walked
        // away after this point walked away from a membership it already has.
        let _receipt = frames.next().await;
        self.checkpoint().await.map_err(|e| e.message)?;
        Ok(())
    }

    /// Joiner: verify the claim, ACCEPT, check the commitment, confirm,
    /// adopt.
    ///
    /// The CLAIM is read **before** any session is bound, and the offer is
    /// spent in the same borrow that accepts it. That ordering is the whole
    /// of the single-claim guarantee: two dials that arrive together both
    /// reach this function, both read their own CLAIM, and exactly one of
    /// them finds `claimed == false`.
    async fn run_joiner(
        self: &Rc<Self>,
        adder_key: [u8; 32],
        transport: Box<dyn EngineTransport>,
    ) -> Join {
        let transport: Rc<dyn EngineTransport> = Rc::from(transport);
        // Read directly, not through a session's reader task: there is no
        // session yet, and this is a single read with nothing to race it.
        let (token, commit) = match recv_frame(transport.as_ref()).await {
            Some(Frame::Claim { token, commit }) => (token, commit),
            _ => {
                transport.close().await;
                return Join::Ignored;
            }
        };

        // Decided under one borrow, answered outside it: a `RefCell` held
        // across an await is a panic waiting for a re-entrant export call.
        //
        // `claimed` is tested before `expires` on purpose. A second claim on
        // a code that has *also* run out of time is still a leaked code, and
        // the ceremony it interrupted must still be burned; ordering it the
        // other way would let a claim arriving one tick late walk away with
        // a plain refusal and leave the bound session running.
        let verdict = {
            let now = self.seams.clock.now_ms();
            let mut pairing = self.pairing.borrow_mut();
            match pairing.offer.as_mut() {
                None => Verdict::Ignore,
                // Not this device's code: a stranger dialing the pairing
                // ALPN. It learns nothing and changes nothing — in
                // particular it cannot end a ceremony it knows no token for.
                Some(offer) if token.as_slice() != offer.token.as_slice() => Verdict::Ignore,
                Some(offer) if offer.claimed => Verdict::Burn,
                Some(offer) if now >= offer.expires => Verdict::Refuse,
                Some(offer) => {
                    offer.claimed = true;
                    Verdict::Claim
                }
            }
        };
        match verdict {
            Verdict::Ignore => {
                transport.close().await;
                return Join::Ignored;
            }
            // The offer stays: it is dead either way, and keeping it is what
            // lets a *later* claim be answered REFUSED rather than met with
            // silence.
            Verdict::Refuse => {
                let _sent = send_frame(transport.as_ref(), &Frame::Refused).await;
                transport.close().await;
                return Join::Ignored;
            }
            Verdict::Burn => {
                let _sent = send_frame(transport.as_ref(), &Frame::Refused).await;
                transport.close().await;
                // A code that reached a second party has leaked, and the
                // ceremony it bound is no longer trustworthy: the session
                // dies, the offer dies, and both users start over.
                self.tear_down_session().await;
                self.pairing.borrow_mut().offer = None;
                self.set_phase(Phase::Failed(
                    "someone already tried this code; make a new one".to_string(),
                ));
                return Join::Ignored;
            }
            Verdict::Claim => {}
        }

        Join::Ceremony(
            self.claimed_ceremony(adder_key, token, commit, transport)
                .await,
        )
    }

    /// The joiner's side once the claim is accepted and the code is spent.
    ///
    /// Every exit from here clears the offer: the code named a ceremony that
    /// is now over, one way or the other, and a code that outlived its
    /// ceremony is a second chance for whoever else has seen it.
    async fn claimed_ceremony(
        self: &Rc<Self>,
        adder_key: [u8; 32],
        token: Vec<u8>,
        commit: Vec<u8>,
        transport: Rc<dyn EngineTransport>,
    ) -> Result<(), String> {
        let outcome = self.run_claimed(adder_key, token, commit, transport).await;
        self.pairing.borrow_mut().offer = None;
        outcome
    }

    async fn run_claimed(
        self: &Rc<Self>,
        adder_key: [u8; 32],
        token: Vec<u8>,
        commit: Vec<u8>,
        transport: Rc<dyn EngineTransport>,
    ) -> Result<(), String> {
        let (transport, mut frames, mut confirm) = self.bind_session(transport)?;

        let token: [u8; 16] = token
            .as_slice()
            .try_into()
            .map_err(|_| "that code's token is malformed".to_string())?;

        let joiner_key = self.self_key().map_err(|e| e.message)?;
        let card = self.engine().map_err(|e| e.message)?.keyhive_card().await?;
        let petname = self
            .state
            .borrow()
            .device
            .as_ref()
            .map(|device| device.name.clone())
            .unwrap_or_default();
        let mut nonce_j = [0u8; 32];
        self.seams.rng.fill(&mut nonce_j);
        send_frame(
            transport.as_ref(),
            &Frame::Accept {
                nonce: nonce_j.to_vec(),
                key: joiner_key.to_vec(),
                petname,
                card,
            },
        )
        .await?;

        let nonce_a = match frames.next().await {
            Some(Frame::Reveal { nonce }) => nonce32(&nonce)?,
            Some(Frame::Cancel) => return Err(cancelled()),
            Some(_) => return Err(out_of_order()),
            None => return Err(gone()),
        };
        // The commitment check. Without it the dialing side could pick
        // `nonce_a` after seeing `nonce_j` and grind the six digits.
        if blake3::hash(&nonce_a).as_bytes().as_slice() != commit.as_slice() {
            return Err("that device's nonce did not match what it committed to".to_string());
        }

        let sas = sas(&token, &joiner_key, &adder_key, &nonce_j, &nonce_a);
        self.set_phase(Phase::AwaitingConfirm(sas));

        match wait(&mut confirm, &mut frames).await {
            Wake::Confirmed => {}
            Wake::Frame(Some(Frame::Cancel)) => return Err(cancelled()),
            Wake::Frame(Some(_)) => return Err(out_of_order()),
            Wake::Frame(None) => return Err(gone()),
        }
        send_frame(transport.as_ref(), &Frame::ConfirmJoin).await?;
        self.set_phase(Phase::AwaitingPeer);

        let (us, keyhive, read_back, name_key, visor, contacts) = match frames.next().await {
            Some(Frame::Enroll {
                us,
                keyhive,
                read_back,
                name_key,
                visor,
                contacts,
            }) => (us, keyhive, read_back, name_key, visor, contacts),
            Some(Frame::Cancel) => return Err(cancelled()),
            Some(_) => return Err(out_of_order()),
            None => return Err(gone()),
        };
        let name_key: [u8; 32] = name_key
            .as_slice()
            .try_into()
            .map_err(|_| "that device sent a malformed store key".to_string())?;
        let engine = self.engine().map_err(|error| error.message)?;
        let expected_group = engine.adoption_group(&us, adder_key)?;
        let adopted = polyvisor_document_history::Document::try_load(
            &contacts,
            polyvisor_document_history::actor(
                b"polyvisor:actor:",
                self.state.borrow().seed,
                crate::contacts::CONTACTS_APP.as_bytes(),
            ),
            polyvisor_engine::document_tree(crate::contacts::CONTACTS_APP),
        )?;
        let profile = polyvisor_contacts_model::self_profile(&adopted)
            .ok_or_else(|| "that device sent no usable user identity".to_string())?;
        let bound = polyvisor_contacts_model::verify_root_binding(&profile.binding)?;
        if bound.group.to_bytes() != expected_group {
            return Err("the adopted identity is bound to another Keyhive group".into());
        }
        let meeting_active = !matches!(
            self.meeting_status().await.map_err(|e| e.message)?.phase,
            crate::MeetingPhase::Idle
                | crate::MeetingPhase::Done(_)
                | crate::MeetingPhase::Failed(_)
        );
        if meeting_active {
            self.meeting_invalidate().await;
        }
        let adoption = self
            .begin_identity_adoption()
            .map_err(|error| error.message)?;
        let outcome = self
            .adopt_pairing_payload(AdoptionPayload {
                adder_key,
                name_key,
                us: &us,
                keyhive: &keyhive,
                read_back: &read_back,
                visor: &visor,
                contacts: &contacts,
            })
            .await;
        self.finish_identity_adoption(adoption, outcome.is_ok());
        outcome?;
        self.push_event(crate::Event::ContactsChanged);
        // The read receipt, and it is sent *after* the adoption is on disk:
        // it says "the enrollment landed here", so it may not run ahead of
        // the enrollment landing. The adder is parked on this and closes the
        // connection when it arrives — see the wait in `run_adder` for the
        // discarded-bytes race it exists to close.
        //
        // A send that fails is not a failed ceremony: this device has adopted
        // the group and checkpointed it, and the adder treats a missing ack
        // as enrollment all the same.
        let _acked = send_frame(transport.as_ref(), &Frame::Enrolled).await;
        Ok(())
    }

    async fn adopt_pairing_payload(&self, payload: AdoptionPayload<'_>) -> Result<(), String> {
        let engine = self.engine().map_err(|e| e.message)?;
        engine
            .adopt_us(payload.us, payload.adder_key, payload.name_key)
            .await?;
        engine
            .adopt_keyhive(payload.keyhive, payload.read_back)
            .await?;
        engine
            .document_adopt(
                polyvisor_visor_model::VISOR_APP,
                payload.visor,
                polyvisor_visor_model::adopt,
            )
            .await?;
        engine
            .document_adopt(
                crate::contacts::CONTACTS_APP,
                payload.contacts,
                polyvisor_contacts_model::adopt,
            )
            .await?;
        self.refresh_personalization()
            .await
            .map_err(|e| e.message)?;
        self.push_event(crate::Event::PersonalizationChanged);
        self.checkpoint_durable().await.map_err(|e| e.message)
    }

    // -- session plumbing ----------------------------------------------------

    /// Register a session: share the transport, start the reader task, and
    /// hand back the frame stream and the confirmation the export path fires.
    ///
    /// The reader is its own task rather than a `recv` awaited inline because
    /// the state machine has to wait on *two* things at once (a frame and
    /// this user's confirmation), and dropping a half-polled `recv` on the
    /// real transport would drop bytes the host had already produced. A
    /// channel drops nothing.
    fn bind_session(self: &Rc<Self>, transport: Rc<dyn EngineTransport>) -> Result<Bound, String> {
        let (tx, rx) = mpsc::unbounded();
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let cancelled = Rc::new(Cell::new(false));
        {
            let mut pairing = self.pairing.borrow_mut();
            // Never overwritten. The confirmation this device's user is
            // about to give belongs to the ceremony whose digits they are
            // looking at, and a second session slotted in over the first
            // would be handed that confirmation instead. Refusing is also
            // not a tear-down: a caller that could take the ceremony down by
            // arriving would be the same hazard from the other direction.
            if pairing.session.is_some() {
                return Err("this device is already pairing".to_string());
            }
            pairing.session = Some(Session {
                transport: Rc::clone(&transport),
                confirm: Some(confirm_tx),
                cancelled: Rc::clone(&cancelled),
            });
        }
        let reader = Rc::clone(&transport);
        self.seams.spawn.spawn(Box::pin(async move {
            while let Some(frame) = recv_frame(reader.as_ref()).await {
                if tx.unbounded_send(frame).is_err() {
                    return;
                }
            }
        }));
        Ok((transport, rx, confirm_rx))
    }

    /// End whatever exchange is in flight, telling the other side.
    async fn tear_down_session(&self) {
        let session = self.pairing.borrow_mut().session.take();
        let Some(session) = session else {
            return;
        };
        session.cancelled.set(true);
        let _sent = send_frame(session.transport.as_ref(), &Frame::Cancel).await;
        session.transport.close().await;
    }

    /// Record how a session ended, unless this device is the one that ended
    /// it — a cancel has already said what the phase should be.
    fn finish(&self, outcome: Result<(), String>) {
        let session = self.pairing.borrow_mut().session.take();
        // No session left, or one this device tore down itself: the phase
        // has already been set by whatever ended it, and the wire going
        // quiet afterwards is that tear-down's own echo.
        let Some(session) = session else {
            return;
        };
        if session.cancelled.get() {
            return;
        }
        self.set_phase(match outcome {
            Ok(()) => Phase::Done,
            Err(why) => Phase::Failed(why),
        });
        // Spawned, not dropped on the floor: `finish` is synchronous (it is
        // called from paths that must not park) and an unpolled future
        // closes nothing at all — the peer would be left reading a stream
        // that never ends.
        let transport = Rc::clone(&session.transport);
        self.seams
            .spawn
            .spawn(Box::pin(async move { transport.close().await }));
    }

    /// Move to `phase` and announce it.
    ///
    /// Every transition goes through here, and that is the point: the visor
    /// has no timer, so a phase the *other* device drove — its confirmation,
    /// its cancel, the enrollment landing — reaches a screen only as an
    /// event (internal.wit `events.event.pairing-changed`). A transition
    /// written straight into the cell would be one the user never sees until
    /// they touched something.
    fn set_phase(&self, phase: Phase) {
        self.pairing.borrow_mut().phase = phase.clone();
        self.push_event(crate::Event::PairingChanged(phase));
    }

    /// This device's own endpoint key.
    fn self_key(&self) -> Result<[u8; 32], Error> {
        Ok(self.engine()?.verifying_key().to_bytes())
    }
}

// -- the wire ----------------------------------------------------------------

/// One pairing message. `Vec<u8>` rather than fixed arrays: the lengths are
/// checked where they are used, and a peer that sends the wrong length is a
/// peer to abort on, not a deserialization panic.
#[derive(Debug, Serialize, Deserialize)]
enum Frame {
    Claim {
        token: Vec<u8>,
        commit: Vec<u8>,
    },
    Accept {
        nonce: Vec<u8>,
        key: Vec<u8>,
        petname: String,
        /// The joiner's keyhive contact card (`polyvisor_engine::Engine::keyhive_card`).
        /// Enrollment is not just a row in the group document any more: without
        /// this the adder cannot seal the group's epoch key to the joiner, and
        /// the joiner would arrive a member who can read nothing.
        card: Vec<u8>,
    },
    Reveal {
        nonce: Vec<u8>,
    },
    ConfirmJoin,
    Enroll {
        us: Vec<u8>,
        /// The group's keyhive operation stream, as the adder holds it after
        /// adding the joiner. Public data — signed membership, prekey and CGKA
        /// operations — and specifically *not* the adder's keyhive archive,
        /// which would hand the joiner the adder's own prekey secrets.
        keyhive: Vec<u8>,
        /// The content keys the joiner needs to read what the group wrote
        /// before it existed — the read-back foothold BeeKEM does not give a
        /// new member (`polyvisor_engine`'s `Vault::export_content_keys`).
        /// Secret, and it travels here rather than on the sync path because
        /// this connection is the one the two users just compared six digits
        /// over.
        read_back: Vec<u8>,
        /// The group's store-name key (`polyvisor_engine::Engine::name_key`):
        /// what every object in the user's durable store is named under. A
        /// group secret, on the same connection and for the same reason as
        /// `read_back` — a joiner that minted its own would write a second,
        /// invisible store beside the group's.
        name_key: Vec<u8>,
        /// Serialized visor document bytes. They are plaintext inside this
        /// SAS-authenticated encrypted transport, never persisted plaintext;
        /// keyhive protects the document on sync and storage paths.
        visor: Vec<u8>,
        /// Serialized contacts document, adopted so the established group's
        /// user signing identity replaces any solo identity on the joiner.
        contacts: Vec<u8>,
    },
    /// Joiner → adder, last: the enrollment has been adopted *and*
    /// checkpointed here. It carries nothing — the
    /// message is that it arrived at all.
    ///
    /// It exists for the connection's sake rather than the protocol's: the
    /// adder waits for it before returning, because returning closes the
    /// transport and a close that overtakes the peer's read discards the
    /// bytes it has not read yet (see [`Kernel::run_adder`]). An
    /// acknowledgement is the only thing that can prove ENROLL was consumed.
    Enrolled,
    Refused,
    Cancel,
}

async fn send_frame(transport: &dyn EngineTransport, frame: &Frame) -> Result<(), String> {
    let bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    transport.send(bytes).await
}

/// The next frame, or `None` for a clean end, a dead connection, or bytes
/// that are not a frame at all. Unknown frames are rejected.
async fn recv_frame(transport: &dyn EngineTransport) -> Option<Frame> {
    let bytes = transport.recv().await?;
    serde_json::from_slice(&bytes).ok()
}

/// What woke a side that is waiting on both its own user and the wire.
enum Wake {
    Confirmed,
    Frame(Option<Frame>),
}

async fn wait(
    confirm: &mut oneshot::Receiver<()>,
    frames: &mut mpsc::UnboundedReceiver<Frame>,
) -> Wake {
    match futures::future::select(confirm, frames.next()).await {
        Either::Left((Ok(()), _)) => Wake::Confirmed,
        // The sender was dropped: the session was torn down under us.
        Either::Left((Err(_), _)) => Wake::Frame(None),
        Either::Right((frame, _)) => Wake::Frame(frame),
    }
}

fn cancelled() -> String {
    "the other device cancelled".to_string()
}

fn gone() -> String {
    "the other device went away".to_string()
}

fn out_of_order() -> String {
    "that device did not speak pairing".to_string()
}

fn nonce32(bytes: &[u8]) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| "that device sent a malformed nonce".to_string())
}

// -- code and SAS ------------------------------------------------------------

/// `BASE32_NOPAD_VISUAL(0x01 ‖ key ‖ token)` — 79 characters.
/// The visor displays it in groups of four; the groups are not part of it.
fn encode_code(key: &[u8; 32], token: &[u8; 16]) -> String {
    let mut payload = Vec::with_capacity(49);
    payload.push(CODE_VERSION);
    payload.extend_from_slice(key);
    payload.extend_from_slice(token);
    data_encoding::BASE32_NOPAD_VISUAL.encode(&payload)
}

/// The inverse, forgiving of how a person retyped it: the grouping
/// whitespace and dashes come out, and the alphabet itself takes lower case
/// and corrects the four confusables (`0`→`O`, `1`→`I`, `l`→`I`, `8`→`B`).
///
/// Nothing here upper-cases the input, and that is deliberate: a typed `l` is
/// *defined* to mean `I`, so folding it to `L` first would silently read a
/// different code than the person typed.
fn decode_code(code: &str) -> Result<([u8; 32], [u8; 16]), String> {
    let cleaned: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let payload = data_encoding::BASE32_NOPAD_VISUAL
        .decode(cleaned.as_bytes())
        .map_err(|_| "that is not a pairing code".to_string())?;
    if payload.len() != 49 {
        return Err("that pairing code is the wrong length".to_string());
    }
    if payload[0] != CODE_VERSION {
        return Err("that code is from a different version of pairing".to_string());
    }
    let key: [u8; 32] = payload[1..33].try_into().expect("49 bytes, just checked");
    let token: [u8; 16] = payload[33..49].try_into().expect("49 bytes, just checked");
    Ok((key, token))
}

/// The six digits both users compare.
///
/// `transcript = 0x01 ‖ token ‖ joiner-key ‖ adder-key ‖ nonce_j ‖ nonce_a`;
/// the SAS is the first four bytes of its BLAKE3 read big-endian, modulo
/// 10^6, zero-padded. Every value that identifies this exchange is in there,
/// so two devices agree exactly when they ran the *same* exchange with each
/// other.
fn sas(
    token: &[u8; 16],
    joiner_key: &[u8; 32],
    adder_key: &[u8; 32],
    nonce_j: &[u8; 32],
    nonce_a: &[u8; 32],
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&[CODE_VERSION]);
    hasher.update(token);
    hasher.update(joiner_key);
    hasher.update(adder_key);
    hasher.update(nonce_j);
    hasher.update(nonce_a);
    let digest = hasher.finalize();
    let head = u32::from_be_bytes(digest.as_bytes()[..4].try_into().expect("four bytes"));
    format!("{:06}", head % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_round_trips_through_the_alphabet_a_person_types() {
        let key = [7u8; 32];
        let token = [9u8; 16];
        let code = encode_code(&key, &token);
        assert_eq!(code.len(), 79);
        assert_eq!(decode_code(&code).unwrap(), (key, token));
        // Grouped in fours for display, and hyphenated: the same code.
        let grouped: String = code
            .as_bytes()
            .chunks(4)
            .map(|chunk| String::from_utf8_lossy(chunk).to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(decode_code(&grouped).unwrap(), (key, token));
        assert_eq!(
            decode_code(&grouped.replace(' ', "-")).unwrap(),
            (key, token)
        );
        // The alphabet's own visual correction, which is why the code is in
        // this alphabet at all: a person who read `O` as `0` still lands on
        // the same 49 bytes.
        assert_eq!(decode_code(&code.replace('O', "0")).unwrap(), (key, token));
    }

    #[test]
    fn the_sas_is_six_digits_and_binds_the_whole_transcript() {
        let (token, jk, ak) = ([1u8; 16], [2u8; 32], [3u8; 32]);
        let (nj, na) = ([4u8; 32], [5u8; 32]);
        let digits = sas(&token, &jk, &ak, &nj, &na);
        assert_eq!(digits.len(), 6);
        assert!(digits.chars().all(|c| c.is_ascii_digit()));
        // Swap the two nonces and the digits move: the transcript is ordered,
        // so a peer replaying one side's nonce into the other's slot does not
        // land on the same number.
        assert_ne!(digits, sas(&token, &jk, &ak, &na, &nj));
        assert_ne!(digits, sas(&token, &ak, &jk, &nj, &na));
    }
}
