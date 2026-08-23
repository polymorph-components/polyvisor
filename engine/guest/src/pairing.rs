//! Device pairing (#10), implementing PAIRING.md §1–§2.
//!
//! Both sides start the ceremony interactively: the NEW device displays a
//! code (typed or QR), the TRUSTED device consumes it. There is no pairing
//! link and nothing enrollment-shaped is reachable from a URL.
//!
//! The transport is iroh, so both endpoint keys are transport-authenticated
//! (key-is-address). The joiner listens on a pairing-only ALPN; the adder
//! dials the endpoint id carried in the code. Messages are length-framed
//! bincode on one bidi stream.
//!
//! Two defensive properties carry the ceremony, and both are load-bearing:
//!
//! - **Commitment ordering.** The adder commits to `nonce_a` before it
//!   learns `nonce_j`, so it cannot search for a transcript that produces
//!   a chosen 20-bit short authentication string. The joiner verifies the
//!   commitment on REVEAL and ends the ceremony on any mismatch.
//! - **Reject-on-unknown.** Every step has exactly one legal next wire
//!   message. An unknown message kind, an undecodable frame, or a
//!   well-formed message arriving out of order tears the stream down and
//!   fails the session (NOTES: reject-on-unknown is state, not hygiene).
//!
//!
//! Plus the offer's own limits: single-claim (the first claim binds the
//! session; a later one refuses and burns the offer, because a second
//! claim means the code leaked) and a 120 s expiry.

use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use data_encoding::BASE32_NOPAD_VISUAL;
use keyhive_core::event::static_event::StaticEvent;
use serde::{Deserialize, Serialize};

use crate::exports::polyvisor::engine::driver::{
    PairAddState, PairEnrollment, PairJoinState, PairOffer,
};
use crate::polymorph::iroh::endpoint::{Connection, Endpoint};
use crate::polymorph::iroh::types::{EndpointAddr, TransportAddr};
use crate::{arr32, iroh_reader, iroh_writer, with_state};

/// Pairing runs on its own ALPN: a pairing dial can never be mistaken for
/// (or consumed as) an engine sync connection.
pub(crate) const PAIR_ALPN: &[u8] = b"polyvisor/pair/0";

/// Code payload version (PAIRING.md §1).
const CODE_VERSION: u8 = 0x01;

/// QUIC application close codes this protocol uses.
///
/// The endpoint carries application close codes and reasons faithfully
/// (u62, plus the peer's reason string, read through
/// `connection.wait-closed`), so a refusal can travel as a property of
/// the CONNECTION as well as an in-band message. That redundancy is the
/// point: the in-band `REFUSED` remains the contract's mechanism
/// (PAIRING.md §2), and the close carries the same fact on a channel that
/// cannot be truncated by the frame racing the teardown.
const PAIR_CLOSE_ALREADY_CLAIMED: u64 = 1;

/// The words the visor shows when a code was already claimed.
///
/// OURS, always. The peer that says so is whatever endpoint the scanned
/// code named — an attacker who controls the code controls the peer, so
/// any string it sends is attacker text. The FACT is identified by the
/// close code (or by the `Refused` variant itself); the wording is
/// substituted here. The peer's own bytes are diagnostics at most, and
/// never become state the visor renders as its own voice.
const REFUSED_ALREADY_CLAIMED: &str =
    "this pairing code was already claimed by another device";

/// Offer expiry (PAIRING.md §1). Overridable ONLY so the headless
/// harness can exercise the expiry path without a two-minute wait; the
/// contract value is what ships.
fn offer_ttl_ms() -> u64 {
    std::env::var("PM_PAIR_TTL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(OFFER_TTL_MS)
}

const OFFER_TTL_MS: u64 = 120_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- the wire protocol (PAIRING.md §2) ---

/// One length-framed bincode message. The variant order is the protocol
/// order; nothing here is optional and nothing may repeat.
#[derive(Serialize, Deserialize)]
enum PairMsg {
    /// 1. add → join.
    Claim { token: [u8; 16], commit: [u8; 32] },
    /// 2. join → add. The card materializes the joiner's individual on
    ///    the adder, which is what enrollment then grants against.
    Accept {
        nonce_j: [u8; 32],
        contact_card: Vec<u8>,
    },
    /// 3. add → join. Verified against the CLAIM's commitment.
    Reveal { nonce_a: [u8; 32] },
    /// 5. join → add.
    ConfirmJoin,
    /// 6. add → join.
    Enroll {
        user_group_id: Vec<u8>,
        group_card: Vec<u8>,
        partition_id: Vec<u8>,
    },
    /// CONTRACT: §1 requires that a second claim be "refused with a
    /// distinct error" but §2 lists no refusal message. This carries that
    /// error to the second dialer; it is legal only add-ward, and the
    /// joiner rejects it like any other out-of-order message.
    Refused(String),
}

impl PairMsg {
    fn kind(&self) -> &'static str {
        match self {
            PairMsg::Claim { .. } => "CLAIM",
            PairMsg::Accept { .. } => "ACCEPT",
            PairMsg::Reveal { .. } => "REVEAL",
            PairMsg::ConfirmJoin => "CONFIRM-JOIN",
            PairMsg::Enroll { .. } => "ENROLL",
            PairMsg::Refused(_) => "REFUSED",
        }
    }
}

// --- the code (PAIRING.md §1) ---

/// `BASE32_NOPAD_VISUAL(0x01 ‖ endpoint-id(32) ‖ token(16))` — 79 chars.
/// The alphabet is the confusable-free one, so a code read off a screen
/// and typed on another device survives the usual transcription slips.
fn mint_code(endpoint_id: &[u8; 32], token: &[u8; 16]) -> String {
    let mut payload = Vec::with_capacity(49);
    payload.push(CODE_VERSION);
    payload.extend_from_slice(endpoint_id);
    payload.extend_from_slice(token);
    BASE32_NOPAD_VISUAL.encode(&payload)
}

/// The inverse. Whitespace and separators are dropped first: the code is
/// displayed in groups of four, and a user retyping it will include them.
fn parse_code(code: &str) -> Result<([u8; 32], [u8; 16]), String> {
    let cleaned: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let payload = BASE32_NOPAD_VISUAL
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("pairing code is not a valid code: {e}"))?;
    if payload.len() != 49 {
        return Err(format!(
            "pairing code has the wrong length ({} payload bytes, want 49)",
            payload.len()
        ));
    }
    if payload[0] != CODE_VERSION {
        return Err(format!(
            "pairing code version {} is not supported",
            payload[0]
        ));
    }
    Ok((
        arr32(&payload[1..33], "join endpoint id")?,
        payload[33..49].try_into().map_err(|_| "token".to_string())?,
    ))
}

// --- the short authentication string (PAIRING.md §2) ---

/// `transcript = 0x01 ‖ token ‖ join-endpoint-id ‖ add-endpoint-id ‖
/// nonce_j ‖ nonce_a`, then the first four bytes of BLAKE3 over it read
/// big-endian and reduced mod 10^6 (PAIRING.md §2). Both endpoint ids are
/// in the transcript, so the string the two users compare is bound to the
/// two authenticated keys and to the offer, not merely to the nonces.
fn sas_digits(
    token: &[u8; 16],
    join_ep: &[u8; 32],
    add_ep: &[u8; 32],
    nonce_j: &[u8; 32],
    nonce_a: &[u8; 32],
) -> String {
    let mut transcript = Vec::with_capacity(1 + 16 + 32 + 32 + 32 + 32);
    transcript.push(CODE_VERSION);
    transcript.extend_from_slice(token);
    transcript.extend_from_slice(join_ep);
    transcript.extend_from_slice(add_ep);
    transcript.extend_from_slice(nonce_j);
    transcript.extend_from_slice(nonce_a);
    let digest = blake3::hash(&transcript);
    let head = u32::from_be_bytes(
        digest.as_bytes()[..4]
            .try_into()
            .expect("BLAKE3 output is 32 bytes"),
    );
    format!("{:06}", head % 1_000_000)
}

// --- the adder's agent id, read out of the ENROLL card ---

/// WHO GRANTED US MEMBERSHIP, taken from the grant itself.
///
/// `pair-enrollment.peer-agent-id` must be the adder's AGENT id, and the
/// joiner has no other name for it at this point in the ceremony: the
/// transport authenticates an ENDPOINT key (a different key), the
/// us-doc's `devices` map is keyed by agent id but has not synced yet
/// (that sync is the very thing this field exists to enable), and no
/// wire message carries a self-declared identity — deliberately, since a
/// field the peer fills in is a name it merely claimed.
///
/// The honest source is the ENROLL card. `usdoc::enroll_device` adds the
/// joiner to the user group BEFORE exporting the card (its step 1, so
/// the card carries the delegation), and a delegation is
/// `Signed<StaticDelegation<T>>` — `issuer` is the ed25519 verifying key
/// that signed it, i.e. the adder's individual, which is exactly what
/// `own-agent-id` is on the other side (lib.rs:1972 — `my_peer`, built
/// from the identity's verifying key at lib.rs:2318). So we look for the
/// delegation whose `delegate` is US and report its issuer.
///
/// The signature is VERIFIED here rather than assumed. Ingest verifies
/// too, but this read must not depend on that: `PM_SKIP_ENROLL_CARD`
/// suppresses the ingest entirely, and a value derived from an
/// unverified blob would be a peer-asserted name wearing a proof's
/// clothes.
///
/// Sources: keyhive_crypto/src/signed.rs (`issuer`, `try_verify`),
/// keyhive_core/src/principal/group/delegation.rs:154
/// (`StaticDelegation.delegate`),
/// keyhive_core/src/event/static_event.rs:29 (`Delegated`).
fn adder_agent_from_enroll_card(card: &[u8], me: &[u8]) -> Option<Vec<u8>> {
    let me = crate::identifier(me).ok()?;
    let events: Vec<StaticEvent<crate::T>> = bincode::deserialize(card).ok()?;
    for ev in events {
        let StaticEvent::Delegated(signed) = ev else {
            continue;
        };
        if signed.payload.delegate != me {
            continue;
        }
        if signed.try_verify().is_err() {
            // A delegation naming us that does not verify is not evidence
            // of anything; keep looking rather than trusting it.
            continue;
        }
        let issuer = signed.issuer().to_bytes().to_vec();
        // A self-delegation would name US, not the adder. It cannot arise
        // from `enroll_device` (the joiner is not yet a member and so
        // cannot have issued its own grant), but reporting our own id as
        // "the peer" would send the embedder dialling itself, so the case
        // is excluded explicitly rather than argued away.
        if issuer == crate::own_agent_id().ok()? {
            continue;
        }
        return Some(issuer);
    }
    None
}

// --- session state ---

/// What a running session is waiting for, delivered on one channel so the
/// state machine has a single await point.
enum Ev {
    /// A length-framed wire frame, undecoded.
    Frame(Vec<u8>),
    /// The local user confirmed (the adder's confirm carries the device
    /// name it chose — the visor's voice, never the joiner's).
    Confirm(String),
    /// `pair-abort`, or a superseding `pair-join-start`.
    Abort,
    /// The peer's stream ended. Every step of the ceremony has a next
    /// message, so a close is always a failure — and one that must be
    /// reported, not waited out: a session parked forever on a dead
    /// stream looks exactly like a slow peer to the user.
    Closed,
}

pub(crate) struct JoinSession {
    /// Session generation. A superseded session's task may still be
    /// unwinding; without this its final state would land on the session
    /// that replaced it.
    generation: u64,
    expires_ms: u64,
    /// Set once a connection has taken the session: later dialers are
    /// refused, and the offer is burned.
    bound: bool,
    state: PairJoinState,
    ev_tx: async_channel::Sender<Ev>,
    /// Taken by the acceptor when a dialer binds this offer.
    ev_rx: Option<async_channel::Receiver<Ev>>,
}

pub(crate) struct AddSession {
    generation: u64,
    state: PairAddState,
    ev_tx: async_channel::Sender<Ev>,
}

#[derive(Default)]
pub(crate) struct PairState {
    pub(crate) join: Option<JoinSession>,
    pub(crate) add: Option<AddSession>,
    generation: u64,
    /// The live offer's token, read by the acceptor.
    token: Option<[u8; 16]>,
    acceptor_running: bool,
}

fn next_generation() -> Result<u64, String> {
    with_state(|s| {
        s.pair.generation += 1;
        s.pair.generation
    })
}

/// Terminal states latch. A ceremony that has failed (or an offer that
/// has expired) must not un-fail: the burn path and the bound session run
/// concurrently, so a session still working through its next message
/// would otherwise overwrite the refusal that just killed the offer — and
/// the user would be shown a string to confirm for an offer someone else
/// had already claimed.
fn set_join(generation: u64, state: PairJoinState) {
    let _ = with_state(|s| {
        if let Some(j) = s.pair.join.as_mut() {
            if j.generation == generation
                && !matches!(
                    j.state,
                    PairJoinState::Failed(_) | PairJoinState::Expired
                )
            {
                j.state = state;
            }
        }
    });
}

fn set_add(generation: u64, state: PairAddState) {
    let _ = with_state(|s| {
        if let Some(a) = s.pair.add.as_mut() {
            if a.generation == generation && !matches!(a.state, PairAddState::Failed(_)) {
                a.state = state;
            }
        }
    });
}

// --- framing helpers ---

/// Run the write pump and report when it has finished flushing.
///
/// The returned receiver fires after the channel drained and the stream
/// was finished. Callers need this before dropping the connection:
/// dropping it implies `close(0, "")`, and a QUIC connection close
/// DISCARDS pending stream data — so a message queued and not yet
/// written is simply lost. The last message a side sends before it
/// returns must therefore be flushed explicitly, not merely queued.
fn spawn_writer(
    out_rx: async_channel::Receiver<Vec<u8>>,
    send: crate::polymorph::iroh::endpoint::SendStream,
) -> async_channel::Receiver<()> {
    let (done_tx, done_rx) = async_channel::bounded(1);
    wit_bindgen::spawn_local(async move {
        iroh_writer(out_rx, send).await;
        let _ = done_tx.send(()).await;
    });
    done_rx
}

/// Forward wire frames into the session's event channel, and report the
/// stream's end rather than letting the session wait on a dead peer.
fn pump_frames(in_rx: async_channel::Receiver<Vec<u8>>, ev_tx: async_channel::Sender<Ev>) {
    wit_bindgen::spawn_local(async move {
        while let Ok(frame) = in_rx.recv().await {
            if ev_tx.send(Ev::Frame(frame)).await.is_err() {
                return;
            }
        }
        let _ = ev_tx.send(Ev::Closed).await;
    });
}

/// The peer's application close reason, when it sent one.
///
/// `wait-closed` resolves with the peer's `close-info` only if its
/// application close actually arrived; a connection that ended any other
/// way has none, and the endpoint never invents one — so `None` here
/// means "no stated reason", not "no close".
async fn close_reason(conn: &Connection) -> Option<String> {
    let info = conn.wait_closed().await?;
    if info.code == PAIR_CLOSE_ALREADY_CLAIMED {
        // The peer's reason is logged, never returned: what the user is
        // shown comes from the CODE.
        if !info.reason.is_empty() {
            eprintln!(
                "[pair] peer close reason (diagnostic, not shown): {:?}",
                info.reason
            );
        }
        return Some(REFUSED_ALREADY_CLAIMED.to_string());
    }
    None
}

/// Length-prefix one frame. The wire framing has exactly one definition;
/// `iroh_writer` and the direct-write refusal path both go through it.
pub(crate) fn frame_bytes(payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    framed.extend_from_slice(payload);
    framed
}

async fn send_msg(tx: &async_channel::Sender<Vec<u8>>, msg: &PairMsg) -> Result<(), String> {
    let bytes = bincode::serialize(msg).map_err(|e| format!("encode {}: {e}", msg.kind()))?;
    tx.send(bytes)
        .await
        .map_err(|_| "pairing stream closed".to_string())
}

fn decode(frame: &[u8]) -> Result<PairMsg, String> {
    // Reject-on-unknown starts here: an undecodable frame is an unknown
    // message kind, and unknown means abort, never ignore.
    bincode::deserialize(frame).map_err(|e| format!("unknown pairing message: {e}"))
}

fn unexpected(got: &PairMsg, want: &str) -> String {
    format!(
        "out-of-order pairing message: got {}, expected {want}",
        got.kind()
    )
}

/// The next wire message. A local confirm arriving early is remembered
/// rather than treated as a protocol violation: reject-on-unknown governs
/// the WIRE, and a user who taps confirm a beat early is not an attack.
async fn next_frame(
    ev_rx: &async_channel::Receiver<Ev>,
    early_confirm: &mut Option<String>,
    want: &str,
) -> Result<PairMsg, String> {
    loop {
        match ev_rx
            .recv()
            .await
            .map_err(|_| "pairing session ended".to_string())?
        {
            Ev::Frame(f) => return decode(&f),
            Ev::Confirm(name) => *early_confirm = Some(name),
            Ev::Abort => return Err("aborted".to_string()),
            Ev::Closed => {
                return Err(format!("the peer closed the pairing stream awaiting {want}"))
            }
        }
    }
}

/// Wait for the local confirm. A wire frame here IS a violation: the peer
/// is running ahead of the ceremony.
async fn await_confirm(
    ev_rx: &async_channel::Receiver<Ev>,
    early_confirm: &mut Option<String>,
) -> Result<String, String> {
    if let Some(name) = early_confirm.take() {
        return Ok(name);
    }
    match ev_rx
        .recv()
        .await
        .map_err(|_| "pairing session ended".to_string())?
    {
        Ev::Confirm(name) => Ok(name),
        Ev::Frame(f) => {
            let msg = decode(&f)?;
            Err(unexpected(&msg, "nothing (awaiting the local confirm)"))
        }
        Ev::Abort => Err("aborted".to_string()),
        Ev::Closed => Err("the peer closed the pairing stream".to_string()),
    }
}

// --- the join side (the NEW device) ---

/// Mint an offer and start listening. Idempotent by construction: a
/// previous offer is aborted first, and its token dies with it.
pub(crate) async fn join_start() -> Result<PairOffer, String> {
    abort_all();
    let endpoint = with_state(|s| s.endpoint.clone())?.ok_or("iroh-bind first")?;
    let my_ep = arr32(&endpoint.id(), "endpoint id")?;
    let token: [u8; 16] = rand::random();
    let expires_ms = now_ms() + offer_ttl_ms();
    let (ev_tx, ev_rx) = async_channel::unbounded();
    let code = mint_code(&my_ep, &token);
    let generation = next_generation()?;
    with_state(|s| {
        s.pair.token = Some(token);
        s.pair.join = Some(JoinSession {
            generation,
            expires_ms,
            bound: false,
            state: PairJoinState::Waiting,
            ev_tx,
            ev_rx: Some(ev_rx),
        })
    })?;
    ensure_acceptor(endpoint, my_ep)?;
    Ok(PairOffer { code, expires_ms })
}

/// One pairing acceptor per endpoint, for the endpoint's whole life.
///
/// Deliberately NOT one per offer: an acceptor that belongs to a
/// superseded offer would still be parked in `accept`, and would swallow
/// the dial meant for the offer that replaced it. It also has to stay
/// armed while a claimed session runs, because refusing a SECOND claim
/// promptly is the whole single-claim guarantee — an unanswered dial is
/// indistinguishable from a slow network, which is exactly the ambiguity
/// the refusal exists to remove.
fn ensure_acceptor(endpoint: Rc<Endpoint>, my_ep: [u8; 32]) -> Result<(), String> {
    if with_state(|s| std::mem::replace(&mut s.pair.acceptor_running, true))? {
        return Ok(());
    }
    wit_bindgen::spawn_local(async move {
        loop {
            let conn = match endpoint.accept().await {
                Ok(c) => c,
                Err(_) => return,
            };
            if conn.alpn() != PAIR_ALPN {
                continue;
            }
            // Claim the live offer synchronously, before yielding, so two
            // dials in flight cannot both believe they bound it.
            let claim = with_state(|s| match s.pair.join.as_mut() {
                Some(j) if !j.bound && now_ms() <= j.expires_ms => {
                    j.bound = true;
                    Some(Claim {
                        generation: j.generation,
                        ev_tx: j.ev_tx.clone(),
                        ev_rx: j.ev_rx.take(),
                        expires_ms: j.expires_ms,
                    })
                }
                _ => None,
            })
            .ok()
            .flatten();
            wit_bindgen::spawn_local(handle_pair_conn(conn, claim, my_ep));
        }
    });
    Ok(())
}

/// A dialer that successfully bound the live offer.
struct Claim {
    generation: u64,
    ev_tx: async_channel::Sender<Ev>,
    ev_rx: Option<async_channel::Receiver<Ev>>,
    expires_ms: u64,
}

async fn handle_pair_conn(conn: Connection, claim: Option<Claim>, my_ep: [u8; 32]) {
    let Ok((send, recv)) = conn.accept_bi().await else {
        if let Some(claim) = claim {
            set_join(
                claim.generation,
                PairJoinState::Failed("pairing stream never opened".into()),
            );
        }
        return;
    };
    match claim {
        Some(Claim {
            generation,
            ev_tx,
            ev_rx: Some(ev_rx),
            expires_ms,
        }) => {
            let (out_tx, out_rx) = async_channel::unbounded::<Vec<u8>>();
            let (in_tx, in_rx) = async_channel::unbounded::<Vec<u8>>();
            wit_bindgen::spawn_local(iroh_writer(out_rx, send));
            wit_bindgen::spawn_local(iroh_reader(in_tx, recv, Vec::new()));
            pump_frames(in_rx, ev_tx);
            let token = match with_state(|s| s.pair.token) {
                Ok(Some(t)) => t,
                _ => return,
            };
            if let Err(e) =
                join_session(conn, out_tx, ev_rx, token, my_ep, expires_ms, generation).await
            {
                set_join(generation, PairJoinState::Failed(e));
            }
        }
        Some(Claim { generation, .. }) => {
            // Should not happen: the offer was bound without a receiver.
            set_join(
                generation,
                PairJoinState::Failed("pairing session state lost".into()),
            );
        }
        None => {
            // Write the refusal DIRECTLY rather than through the writer
            // pump: owning the send half here makes the ordering
            // observable, so the frame is known to be accepted and the
            // stream finished BEFORE the connection close. A QUIC
            // connection close discards pending stream data, so
            // "send then close" without this ordering is exactly the
            // truncated-refusal race — a refusal indistinguishable from
            // a timeout, which is the ambiguity the distinct error
            // exists to remove.
            let refusal = PairMsg::Refused(REFUSED_ALREADY_CLAIMED.into());
            if let Ok(bytes) = bincode::serialize(&refusal) {
                if send.write(frame_bytes(&bytes)).await.is_ok() {
                    let _ = send.finish();
                }
            }
            let generation =
                with_state(|s| s.pair.join.as_ref().map(|j| j.generation)).ok().flatten();
            if let Some(generation) = generation {
                // The user's code reached a second party, so the honest
                // UI is "someone already tried this code" plus a fresh
                // offer, not a silent continuation.
                set_join(
                    generation,
                    PairJoinState::Failed(
                        "this pairing code was already claimed — someone else tried it; \
                         generate a new code"
                            .into(),
                    ),
                );
            }
            // The same fact, as a connection close the dialer can read
            // even if it never saw the frame.
            conn.close(PAIR_CLOSE_ALREADY_CLAIMED, REFUSED_ALREADY_CLAIMED);
        }
    }
}

async fn join_session(
    conn: Connection,
    out_tx: async_channel::Sender<Vec<u8>>,
    ev_rx: async_channel::Receiver<Ev>,
    token: [u8; 16],
    my_ep: [u8; 32],
    expires_ms: u64,
    generation: u64,
) -> Result<(), String> {
    // Transport-authenticated: iroh proves the dialer holds the private
    // half of this endpoint id before the connection is delivered.
    let add_ep = arr32(&conn.peer(), "peer endpoint id")?;
    let mut early_confirm: Option<String> = None;

    // 1. CLAIM.
    let (their_token, commit) = match next_frame(&ev_rx, &mut early_confirm, "CLAIM").await? {
        PairMsg::Claim { token, commit } => (token, commit),
        other => return Err(unexpected(&other, "CLAIM")),
    };
    if now_ms() > expires_ms {
        set_join(generation, PairJoinState::Expired);
        return Ok(());
    }
    if their_token != token {
        return Err("claim carries a token this device never minted".into());
    }

    // 2. ACCEPT.
    let nonce_j: [u8; 32] = rand::random();
    let contact_card = crate::contact_card_bytes().await?;
    send_msg(
        &out_tx,
        &PairMsg::Accept {
            nonce_j,
            contact_card,
        },
    )
    .await?;

    // 3. REVEAL — verify the adder was bound to this nonce before it
    // could see nonce_j.
    let nonce_a = match next_frame(&ev_rx, &mut early_confirm, "REVEAL").await? {
        PairMsg::Reveal { nonce_a } => nonce_a,
        other => return Err(unexpected(&other, "REVEAL")),
    };
    if blake3::hash(&nonce_a).as_bytes() != &commit {
        return Err(
            "commitment violation: the revealed nonce does not match the committed one".into(),
        );
    }
    let sas = sas_digits(&token, &my_ep, &add_ep, &nonce_j, &nonce_a);
    set_join(generation, PairJoinState::Claimed(sas));

    // 4/5. The user compares the string and confirms; only then do we
    // tell the adder it may enroll us.
    await_confirm(&ev_rx, &mut early_confirm).await?;
    send_msg(&out_tx, &PairMsg::ConfirmJoin).await?;
    set_join(generation, PairJoinState::ConfirmedWaiting);

    // 6. ENROLL.
    let (user_group_id, group_card, partition_id) =
        match next_frame(&ev_rx, &mut early_confirm, "ENROLL").await? {
            PairMsg::Enroll {
                user_group_id,
                group_card,
                partition_id,
            } => (user_group_id, group_card, partition_id),
            other => return Err(unexpected(&other, "ENROLL")),
        };

    // 7. Ingest the card (it carries the delegation that makes this
    // device a member), adopt the user-system partition, sync.
    //
    // The adder's agent id is read from the card FIRST, so it is
    // available even under `PM_SKIP_ENROLL_CARD` (which suppresses only
    // the ingest) and so the read is over the bytes as they arrived.
    let peer_agent_id =
        adder_agent_from_enroll_card(&group_card, &crate::own_agent_id()?).unwrap_or_default();
    if peer_agent_id.is_empty() {
        // Not fatal to the ceremony — the membership is real either way —
        // but the embedder cannot wire subduction without it, and a
        // silent empty field would surface later as a mute connection.
        eprintln!(
            "[pair] ENROLL card carried no verifiable delegation to this device; \
             pair-enrollment.peer-agent-id is empty and post-enrollment sync cannot be wired"
        );
    }
    if std::env::var("PM_SKIP_ENROLL_CARD").is_ok() {
        // Verification hook: suppress the hand-delivered card so the act
        // measures what the BRIDGE delivers on its own.
        eprintln!("[enroll] ENROLL card suppressed (bridge-only delivery test)");
    } else {
        let pending = crate::ingest_static_card(group_card).await?;
        if std::env::var("PM_EVENT_DIFF").is_ok() {
            eprintln!("[enroll] joiner ingested the ENROLL card: pending={pending}");
        }
    }
    crate::usdoc::adopt(&partition_id, &user_group_id).await?;
    set_join(generation, PairJoinState::Enrolled(PairEnrollment {
        user_group_id,
        partition_id,
        peer_agent_id,
        // Transport-authenticated, and bound at the top of this function:
        // the dialer iroh delivered is the adder by construction.
        peer_endpoint_id: add_ep.to_vec(),
    }));
    Ok(())
}

pub(crate) fn join_status() -> Result<PairJoinState, String> {
    let expired = with_state(|s| {
        s.pair
            .join
            .as_ref()
            .map(|j| !j.bound && now_ms() > j.expires_ms)
            .unwrap_or(false)
    })?;
    if expired {
        let generation = with_state(|s| s.pair.join.as_ref().map(|j| j.generation))?.unwrap_or(0);
        set_join(generation, PairJoinState::Expired);
    }
    with_state(|s| s.pair.join.as_ref().map(|j| j.state.clone()))?
        .ok_or_else(|| "no pairing offer (call pair-join-start)".to_string())
}

pub(crate) async fn join_confirm() -> Result<(), String> {
    let tx = with_state(|s| s.pair.join.as_ref().map(|j| j.ev_tx.clone()))?
        .ok_or("no pairing offer (call pair-join-start)")?;
    tx.send(Ev::Confirm(String::new()))
        .await
        .map_err(|_| "pairing session ended".to_string())
}

// --- the add side (the TRUSTED device) ---

pub(crate) async fn add_start(code: String) -> Result<(), String> {
    let (peer_ep, token) = parse_code(&code)?;
    let endpoint = with_state(|s| s.endpoint.clone())?.ok_or("iroh-bind first")?;
    let relay = with_state(|s| s.relay_url.clone())?
        .ok_or("no configured relay (iroh-bind first)")?;
    let my_ep = arr32(&endpoint.id(), "endpoint id")?;
    let (ev_tx, ev_rx) = async_channel::unbounded();
    let generation = next_generation()?;
    with_state(|s| {
        s.pair.add = Some(AddSession {
            generation,
            state: PairAddState::Connecting,
            ev_tx: ev_tx.clone(),
        })
    })?;
    wit_bindgen::spawn_local(async move {
        if let Err(e) =
            add_session(endpoint, relay, ev_tx, ev_rx, token, peer_ep, my_ep, generation).await
        {
            set_add(generation, PairAddState::Failed(e));
        }
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn add_session(
    endpoint: Rc<Endpoint>,
    relay: String,
    ev_tx: async_channel::Sender<Ev>,
    ev_rx: async_channel::Receiver<Ev>,
    token: [u8; 16],
    join_ep: [u8; 32],
    my_ep: [u8; 32],
    generation: u64,
) -> Result<(), String> {
    let conn = endpoint
        .connect(
            EndpointAddr {
                endpoint_id: join_ep.to_vec(),
                addrs: vec![TransportAddr::Relay(relay)],
            },
            PAIR_ALPN.to_vec(),
        )
        .await
        .map_err(|e| format!("pairing connect: {e:?}"))?;
    let (send, recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("pairing open-bi: {e:?}"))?;
    let (out_tx, out_rx) = async_channel::unbounded::<Vec<u8>>();
    let (in_tx, in_rx) = async_channel::unbounded::<Vec<u8>>();
    let flushed = spawn_writer(out_rx, send);
    wit_bindgen::spawn_local(iroh_reader(in_tx, recv, Vec::new()));
    pump_frames(in_rx, ev_tx.clone());

    // 1. CLAIM, carrying the commitment. Committing BEFORE nonce_j is
    // revealed is what denies this side any search over the transcript.
    let nonce_a: [u8; 32] = rand::random();
    let commit = *blake3::hash(&nonce_a).as_bytes();
    send_msg(&out_tx, &PairMsg::Claim { token, commit }).await?;

    // 2. ACCEPT.
    let mut early_confirm: Option<String> = None;
    let (nonce_j, contact_card) = match next_frame(&ev_rx, &mut early_confirm, "ACCEPT").await {
        Ok(PairMsg::Accept {
            nonce_j,
            contact_card,
        }) => (nonce_j, contact_card),
        // Same rule as the close path: the variant is the fact, the
        // payload is the peer's text and is not shown.
        Ok(PairMsg::Refused(why)) => {
            if !why.is_empty() {
                eprintln!("[pair] peer REFUSED text (diagnostic, not shown): {why:?}");
            }
            return Err(REFUSED_ALREADY_CLAIMED.to_string());
        }
        Ok(other) => return Err(unexpected(&other, "ACCEPT")),
        // The stream ended without an answer. The peer's application
        // close carries WHY when it set one, so a refusal whose in-band
        // frame was missed still reaches the user as the distinct error
        // rather than as an unexplained timeout.
        Err(e) => return Err(close_reason(&conn).await.unwrap_or(e)),
    };

    // 3. REVEAL, then the string both users will read out.
    //
    // VERIFICATION HOOK (harness only, PAIRING.md §6): with
    // `PM_PAIR_FAULT=commit` set, this side reveals a nonce it never
    // committed to, so the headless acts can prove the JOINER refuses a
    // mismatched commitment rather than assuming it does. The hook can
    // only ever weaken this side's own position — it cannot make a
    // joiner accept anything.
    let revealed = if std::env::var("PM_PAIR_FAULT").as_deref() == Ok("commit") {
        let mut other = nonce_a;
        other[0] ^= 0x01;
        other
    } else {
        nonce_a
    };
    send_msg(&out_tx, &PairMsg::Reveal { nonce_a: revealed }).await?;
    let sas = sas_digits(&token, &join_ep, &my_ep, &nonce_j, &nonce_a);
    set_add(generation, PairAddState::SasReady(sas));

    // The joiner's individual, materialized from the card it sent. This
    // is what the enrollment grant is made against.
    let joiner = crate::ingest_contact_card(contact_card).await?;

    // 4/5. ENROLL waits on BOTH confirms, in either arrival order.
    let mut device_name: Option<String> = early_confirm.take();
    let mut peer_confirmed = false;
    if device_name.is_some() {
        set_add(generation, PairAddState::WaitingPeer);
    }
    while device_name.is_none() || !peer_confirmed {
        match ev_rx
            .recv()
            .await
            .map_err(|_| "pairing session ended".to_string())?
        {
            Ev::Confirm(name) => {
                if device_name.is_some() {
                    return Err("duplicate local confirm".into());
                }
                device_name = Some(name);
                if !peer_confirmed {
                    set_add(generation, PairAddState::WaitingPeer);
                }
            }
            Ev::Frame(f) => match decode(&f)? {
                PairMsg::ConfirmJoin if !peer_confirmed => peer_confirmed = true,
                other => return Err(unexpected(&other, "CONFIRM-JOIN")),
            },
            Ev::Abort => return Err("aborted".into()),
            Ev::Closed => return Err("the peer closed the pairing stream".into()),
        }
    }
    let device_name = device_name.unwrap_or_default();

    // 6. Enrollment writes, in the order §2 pins: group membership at
    // admin FIRST, so the card exported next carries the delegation.
    //
    // `join_ep` rides along into the devices entry: it is the endpoint
    // this side DIALED to get here, so the ceremony that just completed
    // is itself the proof that the id belongs to the joiner (iroh's
    // key-is-address). Nothing else about the ceremony changes.
    let (user_group_id, group_card, partition_id) =
        crate::usdoc::enroll_device(&joiner, &device_name, &join_ep).await?;
    send_msg(
        &out_tx,
        &PairMsg::Enroll {
            user_group_id,
            group_card,
            partition_id,
        },
    )
    .await?;

    // ENROLL is the last thing this side says, and returning drops the
    // connection. Two separate hazards, both of which have to be closed:
    //
    // 1. a message merely QUEUED is lost when the connection closes, so
    //    the write pump is drained and the stream finished first;
    // 2. writing is still not delivery. A QUIC connection close discards
    //    stream bytes the peer has not read yet, so closing promptly
    //    after the FIN can take the payload with it. The endpoint is
    //    faithful about closing when the resource drops, which turns
    //    that into a reliable loss rather than a rare one.
    //
    // So this side stays open until the JOINER hangs up, which it does
    // once it has ingested the enrollment. The peer's departure is the
    // completion signal; there is nothing to guess at.
    out_tx.close();
    let _ = flushed.recv().await;
    set_add(generation, PairAddState::Enrolled);
    linger_until_peer_closes(&conn, &ev_rx).await;
    Ok(())
}

/// Wait for the peer to hang up, but do not wait forever.
///
/// This is task-leak hygiene, not a protocol timeout: the state is
/// already `Enrolled` and latched before this runs, so overshooting or
/// giving up early is invisible to the visor either way. What it prevents
/// is a joiner that vanishes leaving this task alive for the life of the
/// instance.
///
/// The bound must be a real await, never a wall-clock spin. An earlier
/// version polled `now-ms` between `yield`s, and that DELETED the
/// enrollment it had just written: the iroh endpoint is a component
/// composed into this instance, so it shares this guest's cooperative
/// scheduler, and a task that only yields to the guest's own queue never
/// lets the endpoint's I/O progress. Measured under the browser-profile
/// embedding: with the spin in place ZERO bytes left this side for the
/// whole linger — the joiner never received ENROLL and its connection
/// idle-timed out; with the spin removed, ENROLL arrived in ~78 ms.
/// (Native `just pair` hid it: there the endpoint is driven by the host
/// outside this instance's scheduler.)
///
/// Both arms of the select are awaits that resolve when the connection
/// ends, for any reason: `wait-closed` for the peer's close, and the
/// session's event channel reporting `Closed` when the read side ends —
/// which covers a peer that vanishes without closing, since QUIC's idle
/// timeout terminates that connection on its own. So the bound comes
/// from the transport rather than from a clock the guest does not hold.
async fn linger_until_peer_closes(conn: &Connection, ev_rx: &async_channel::Receiver<Ev>) {
    let closed = Box::pin(conn.wait_closed());
    let stream_ended = Box::pin(async move {
        while let Ok(ev) = ev_rx.recv().await {
            if matches!(ev, Ev::Closed) {
                return;
            }
        }
    });
    let _ = futures::future::select(closed, stream_ended).await;
}

pub(crate) fn add_status() -> Result<PairAddState, String> {
    with_state(|s| s.pair.add.as_ref().map(|a| a.state.clone()))?
        .ok_or_else(|| "no pairing attempt (call pair-add-start)".to_string())
}

pub(crate) async fn add_confirm(device_name: String) -> Result<(), String> {
    let tx = with_state(|s| s.pair.add.as_ref().map(|a| a.ev_tx.clone()))?
        .ok_or("no pairing attempt (call pair-add-start)")?;
    tx.send(Ev::Confirm(device_name))
        .await
        .map_err(|_| "pairing session ended".to_string())
}

// --- abort ---

/// Tear both sides down. On the join side this expires the offer: a new
/// offer mints a new token (PAIRING.md §2).
pub(crate) fn abort_all() {
    let _ = with_state(|s| {
        for tx in [
            s.pair.join.as_ref().map(|j| j.ev_tx.clone()),
            s.pair.add.as_ref().map(|a| a.ev_tx.clone()),
        ]
        .into_iter()
        .flatten()
        {
            let _ = tx.try_send(Ev::Abort);
            tx.close();
        }
        s.pair.join = None;
        s.pair.add = None;
        s.pair.token = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_round_trips_and_is_79_chars() {
        // Obviously-synthetic inputs: a sequential endpoint id and an
        // all-zero token. Never realistic-looking key material in tests.
        let ep: [u8; 32] = core::array::from_fn(|i| i as u8);
        let token = [0u8; 16];
        let code = mint_code(&ep, &token);
        assert_eq!(code.len(), 79);
        assert_eq!(parse_code(&code).unwrap(), (ep, token));
    }

    #[test]
    fn code_parses_after_display_grouping() {
        let ep: [u8; 32] = core::array::from_fn(|i| (255 - i) as u8);
        let token: [u8; 16] = core::array::from_fn(|i| i as u8);
        let code = mint_code(&ep, &token);
        let grouped = code
            .as_bytes()
            .chunks(4)
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(parse_code(&grouped).unwrap(), (ep, token));
    }

    #[test]
    fn sas_is_six_digits_and_binds_both_endpoints() {
        let token = [0u8; 16];
        let a = [1u8; 32];
        let b = [2u8; 32];
        let nj = [3u8; 32];
        let na = [4u8; 32];
        let s = sas_digits(&token, &a, &b, &nj, &na);
        assert_eq!(s.len(), 6);
        assert!(s.chars().all(|c| c.is_ascii_digit()));
        // Swapping the endpoint roles must change the string: the
        // transcript is directional, so a reflected ceremony cannot
        // produce a matching comparison.
        assert_ne!(s, sas_digits(&token, &b, &a, &nj, &na));
    }
}
