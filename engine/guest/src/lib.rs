//! The engine spike (#20 G2): the walking skeleton's content spine
//! generalized to the real automerge change DAG, serving the
//! `polyvisor:tasks@0.1.0` data service from inside the engine
//! composite.
//!
//! One DAG across three layers: chunk identity = automerge `ChangeHash`;
//! chunk parents = the change's `deps()` = keyhive predecessor refs =
//! sedimentree parents. Authoring merges remote changes first (so deps
//! capture the frontier), commits one automerge change, seals it under the
//! current BeeKEM epoch, and commits the envelope to the sedimentree.
//! Reading applies newly synced chunks in causal order; chunks the current
//! epoch cannot decrypt (revoked readers) are counted and skipped.
//!
//! Everything else — one platform-held identity backing keyhive and
//! subduction, the subduction_keyhive bridge on a second QUIC stream, the
//! keyhive-gated pull policy — is the skeleton spike unchanged.

wit_bindgen::generate!({
    path: "wit",
    world: "engine",
    generate_all,
    // The world now NAMES `polymorph:webcrypto` types (the
    // `device-identity` import hands over `signing-key`/`verifying-key`),
    // so those interfaces must be remapped onto the bindings
    // `polymorph-webcrypto-guest` already generated. Binding them a second
    // time here would produce distinct, unconvertible resource types — the
    // crate's own doc says exactly this ("Do not bind the same interfaces
    // with a second `generate!` without that remapping", rust/guest/src/lib.rs:18).
    // `signature` is what `device-identity` uses; `types` and `wrapping`
    // are what `signature` itself uses, so they come along.
    with: {
        "polymorph:webcrypto/signature@0.1.0": polymorph_webcrypto_guest::bindings::signature,
        "polymorph:webcrypto/types@0.1.0": polymorph_webcrypto_guest::bindings::types,
        "polymorph:webcrypto/wrapping@0.1.0": polymorph_webcrypto_guest::bindings::wrapping,
    },
});

mod pairing;
mod persist;
mod usdoc;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, Change, ObjType, ReadDoc, ScalarValue, Value, ROOT};
use ed25519_dalek::VerifyingKey as DalekVerifyingKey;
use future_form::{FutureForm, Local};
use futures::future::{AbortHandle, Abortable, LocalBoxFuture};

use polymorph_webcrypto_guest::{
    aes_gcm::{self, AesVariant},
    ed25519, Aead, AeadKeyOptions, SigningKey, SigningKeyOptions, VerifyingKey,
};

// The storage providers: protocol only. They handle opaque blobs at
// derivable locations and reach the network through the ports defined
// below (`EngineFetch`, `EngineSigner`) — the world's fetch/signer
// imports are inline anonymous interfaces, so their bindings cannot
// leave this crate. All sealing stays here.
use provider_common::{hmac, FetchPort, Route, Sigv4SignPort};
use provider_dropbox::{
    dbx_child, dbx_create_folder, dbx_delete, dbx_doc_folder, dbx_fetch_child, dbx_link_fetch,
    dbx_list_folder, dbx_mint_link, dbx_pickup_path, dbx_revoke_link, dbx_upload, DbxCfg,
    DbxSource,
};
use provider_gdrive::{
    gd_child, gd_delete, gd_doc_name, gd_download, gd_ensure_folder, gd_fetch_child,
    gd_pickup_name, gd_upload, GdSource, GdSpace, GdriveCfg,
};
use provider_s3::{
    delete_object, get_object_unsigned, kp_location, object_name, put_object, s3_signed, S3Cfg,
};

use beekem::encrypted::EncryptedContent;
use keyhive_core::access::Access;
use keyhive_core::contact_card::ContactCard;
use keyhive_core::event::static_event::StaticEvent;
use keyhive_core::event::Event;
use keyhive_core::keyhive::Keyhive;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::principal::document::id::DocumentId;
use keyhive_core::principal::group::id::GroupId;
use keyhive_core::principal::identifier::Identifier;
use keyhive_core::principal::individual::id::IndividualId;
use keyhive_core::principal::membered::Membered;
use keyhive_core::crypto::envelope::Envelope;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use keyhive_crypto::share_key::{ShareKey, ShareSecretKey};
use keyhive_crypto::symmetric_key::SymmetricKey;
use keyhive_crypto::signed::SigningError;
use keyhive_crypto::signer::async_signer::AsyncSigner;
use keyhive_crypto::verifiable::Verifiable;
use serde::{Deserialize, Serialize};

use sedimentree_core::{
    blob::Blob, depth::CountLeadingZeroBytes, id::SedimentreeId, loose_commit::id::CommitId,
    loose_commit::LooseCommit,
};
use subduction_core::{
    handler::sync::SyncHandler,
    handshake::{self, audience::Audience, Handshake},
    nonce_cache::NonceCache,
    peer::id::PeerId,
    spawn::Spawn,
    storage::{memory::MemoryStorage, traits::Storage},
    subduction::{builder::SubductionBuilder, Subduction},
    timeout::{call::CallTimeout, TimedOut, Timeout},
    timestamp::TimestampSeconds,
    transport::{message::MessageTransport, Transport},
};
use subduction_crypto::{nonce::Nonce, signer::Signer};
use subduction_keyhive::connection::KeyhiveConnection;
use subduction_keyhive::peer_id::KeyhivePeerId;
use subduction_keyhive::policy::SubductionKeyhive;
use subduction_keyhive::protocol::KeyhiveProtocol;
use subduction_keyhive::signed_message::SignedMessage;
use subduction_keyhive::storage::MemoryKeyhiveStorage;

use exports::polyvisor::engine::driver::{
    Guest as DriverGuest, PairAddState, PairJoinState, PairOffer, StoreConfig, UsDevice, UsEvent,
    UsMark, UsPartition, UsProfile,
};
use exports::polyvisor::tasks::tasks::{Guest as TasksGuest, Snapshot, TodoItem};
use polymorph::iroh::endpoint::{Endpoint, EndpointOptions, RecvStream, SendStream};
use polymorph::iroh::identity_generate;
use polymorph::iroh::types::{EndpointAddr, TransportAddr};

/// The iroh ALPN for the engine's subduction wire.
const ALPN: &[u8] = b"polyvisor/0";

// --- types ---

type T = [u8; 32];
/// One manifest entry: (cref, parents, epoch).
type Entry = ([u8; 32], Vec<[u8; 32]>, u32);
type P = Vec<u8>;
type KhStore = MemoryCiphertextStore<T, P>;
type Kh = Keyhive<Local, WebcryptoSigner, T, P, KhStore, NoListener, rand::rngs::OsRng>;

type Auth = SubductionKeyhive<Local, WebcryptoSigner, T, P, KhStore, NoListener, rand::rngs::OsRng>;
type Conn = MessageTransport<QueueTransport>;
type Hdl = SyncHandler<Local, MemoryStorage, Conn, Auth, CountLeadingZeroBytes, WitSpawn, 256>;
type Sd = Subduction<
    'static,
    Local,
    MemoryStorage,
    Conn,
    Hdl,
    Auth,
    WebcryptoSigner,
    NeverTimeout,
    WitSpawn,
    CountLeadingZeroBytes,
    256,
>;
type KhProto = KeyhiveProtocol<
    WebcryptoSigner,
    T,
    P,
    KhStore,
    NoListener,
    rand::rngs::OsRng,
    KhWire,
    MemoryKeyhiveStorage,
    Local,
>;

// --- one signer, two traits ---

/// The device identity key. `Platform` is the default posture (webcrypto
/// mints it; the private half never enters guest memory — and at this
/// rev the interface has NO private-key export at all: extractability is
/// recorded policy awaiting the platform keystore, a #11 data point).
/// `Soft` is the G5 demo-grade posture: an in-guest key that identity
/// bundles can carry; the browser keystore slice later replaces it.
enum IdentityKey {
    Platform(SigningKey),
    Soft(Box<ed25519_dalek::SigningKey>),
}

impl IdentityKey {
    async fn sign_bytes(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        match self {
            IdentityKey::Platform(k) => k
                .sign(data)
                .await
                .map_err(|e| format!("webcrypto sign: {e}")),
            IdentityKey::Soft(k) => {
                use ed25519_dalek::Signer as _;
                Ok(k.sign(data).to_bytes().to_vec())
            }
        }
    }
}

/// Consult the embedder's `device-identity` import (engine.wit).
///
/// `Ok(None)` is "this embedding persists no device identity" — the
/// default every host gets from a stub fragment, and the unchanged
/// mint-a-fresh-key path. `Ok(Some(..))` is the embedder-held pair,
/// already resolved to the agent id the rest of the engine keys off.
///
/// The verifying half is exported here rather than trusted as handed:
/// `export-key-raw` on a `verifying-key` is secret-free and always
/// permitted (webcrypto.wit's `verifying-key.export-key-raw` — "There is
/// no extractability gate on this resource"), and the 32 raw bytes ARE
/// the agent id, so deriving it is the same operation a minted pair goes
/// through in `init`. CONTRACT: the pair is NOT cross-checked (that the
/// verifying key is the signing key's public half) — the port exposes no
/// accessor that could, which is exactly why the pair travels together.
async fn embedder_device_key() -> Result<Option<(IdentityKey, DalekVerifyingKey)>, String> {
    let Some((signing, verifying)) = polyvisor::engine::device_identity::device_key_pair().await
    else {
        return Ok(None);
    };
    let vk_raw = VerifyingKey::from_raw(verifying)
        .export_key_raw()
        .await
        .map_err(|e| format!("device-identity: export verifying key: {e}"))?;
    let vk = DalekVerifyingKey::from_bytes(&arr32(&vk_raw, "device-identity verifying key")?)
        .map_err(|e| format!("device-identity: parse verifying key: {e:?}"))?;
    Ok(Some((IdentityKey::Platform(SigningKey::from_raw(signing)), vk)))
}

struct SignerInner {
    key: IdentityKey,
    verifying: DalekVerifyingKey,
    sign_count: Cell<u64>,
}

#[derive(Clone)]
struct WebcryptoSigner(Rc<SignerInner>);

impl std::fmt::Debug for WebcryptoSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebcryptoSigner")
            .field("verifying", &hex::encode(self.0.verifying.to_bytes()))
            .finish()
    }
}

impl Verifiable for WebcryptoSigner {
    fn verifying_key(&self) -> DalekVerifyingKey {
        self.0.verifying
    }
}

impl AsyncSigner<Local> for WebcryptoSigner {
    fn try_sign_bytes_async<'a>(
        &'a self,
        payload_bytes: &'a [u8],
    ) -> LocalBoxFuture<'a, Result<ed25519_dalek::Signature, SigningError>> {
        Box::pin(async move {
            self.0.sign_count.set(self.0.sign_count.get() + 1);
            let sig = self
                .0
                .key
                .sign_bytes(payload_bytes)
                .await
                .map_err(|_| SigningError::SigningFailed(ed25519_dalek::SignatureError::new()))?;
            ed25519_dalek::Signature::from_slice(&sig).map_err(SigningError::SigningFailed)
        })
    }
}

impl Signer<Local> for WebcryptoSigner {
    fn sign(&self, message: &[u8]) -> LocalBoxFuture<'_, ed25519_dalek::Signature> {
        let message = message.to_vec();
        Box::pin(async move {
            self.0.sign_count.set(self.0.sign_count.get() + 1);
            let sig = self
                .0
                .key
                .sign_bytes(message.as_slice())
                .await
                .expect("identity signing failed (Signer trait is infallible)");
            ed25519_dalek::Signature::from_slice(&sig).expect("64-byte signature")
        })
    }

    fn verifying_key(&self) -> DalekVerifyingKey {
        self.0.verifying
    }
}

// --- spawn + timeout ---

#[derive(Clone, Debug, PartialEq)]
struct WitSpawn;

impl Spawn<Local> for WitSpawn {
    fn spawn(&self, fut: <Local as FutureForm>::Future<'static, ()>) -> AbortHandle {
        let (handle, reg) = AbortHandle::new_pair();
        wit_bindgen::spawn_local(async move {
            let _ = Abortable::new(fut, reg).await;
        });
        handle
    }
}

#[derive(Clone, Debug, PartialEq)]
struct NeverTimeout;

impl Timeout<Local> for NeverTimeout {
    fn timeout<'a, T2: 'a>(
        &'a self,
        _dur: Duration,
        fut: <Local as FutureForm>::Future<'a, T2>,
    ) -> <Local as FutureForm>::Future<'a, Result<T2, TimedOut>> {
        Box::pin(async move { Ok(fut.await) })
    }
}

// --- the frame-queue transport (fed by iroh stream pumps) ---

#[derive(Debug)]
struct ChannelClosed(&'static str);

impl std::fmt::Display for ChannelClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "queue channel closed ({})", self.0)
    }
}

impl std::error::Error for ChannelClosed {}

#[derive(Clone, Debug)]
struct QueueTransport {
    id: u32,
    out_tx: async_channel::Sender<Vec<u8>>,
    out_rx: async_channel::Receiver<Vec<u8>>,
    in_tx: async_channel::Sender<Vec<u8>>,
    in_rx: async_channel::Receiver<Vec<u8>>,
}

impl PartialEq for QueueTransport {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl QueueTransport {
    fn new(id: u32) -> Self {
        let (out_tx, out_rx) = async_channel::unbounded();
        let (in_tx, in_rx) = async_channel::unbounded();
        Self {
            id,
            out_tx,
            out_rx,
            in_tx,
            in_rx,
        }
    }
}

impl Transport<Local> for QueueTransport {
    type SendError = ChannelClosed;
    type RecvError = ChannelClosed;
    type DisconnectionError = ChannelClosed;

    fn send_bytes(&self, bytes: &[u8]) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        let frame = bytes.to_vec();
        Box::pin(async move {
            self.out_tx
                .send(frame)
                .await
                .map_err(|_| ChannelClosed("send"))
        })
    }

    fn recv_bytes(&self) -> LocalBoxFuture<'_, Result<Vec<u8>, ChannelClosed>> {
        Box::pin(async move { self.in_rx.recv().await.map_err(|_| ChannelClosed("recv")) })
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        Box::pin(async move {
            self.out_tx.close();
            self.in_rx.close();
            Ok(())
        })
    }
}

#[derive(Debug)]
struct KhWireError(String);

impl std::fmt::Display for KhWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "keyhive wire: {}", self.0)
    }
}

impl std::error::Error for KhWireError {}

#[derive(Clone, Debug)]
struct KhWire {
    peer: KeyhivePeerId,
    out_tx: async_channel::Sender<Vec<u8>>,
    in_rx: async_channel::Receiver<Vec<u8>>,
}

impl KeyhiveConnection<Local> for KhWire {
    type SendError = KhWireError;
    type RecvError = KhWireError;
    type DisconnectError = KhWireError;

    fn peer_id(&self) -> KeyhivePeerId {
        self.peer.clone()
    }

    fn send(&self, message: SignedMessage) -> LocalBoxFuture<'_, Result<(), KhWireError>> {
        Box::pin(async move {
            let bytes =
                bincode::serialize(&message).map_err(|e| KhWireError(format!("encode: {e}")))?;
            self.out_tx
                .send(bytes)
                .await
                .map_err(|_| KhWireError("closed".into()))
        })
    }

    fn recv(&self) -> LocalBoxFuture<'_, Result<SignedMessage, KhWireError>> {
        Box::pin(async move {
            let bytes = self
                .in_rx
                .recv()
                .await
                .map_err(|_| KhWireError("closed".into()))?;
            bincode::deserialize(&bytes).map_err(|e| KhWireError(format!("decode: {e}")))
        })
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, Result<(), KhWireError>> {
        Box::pin(async move {
            self.out_tx.close();
            self.in_rx.close();
            Ok(())
        })
    }
}

struct QueueHandshake(QueueTransport);

impl Handshake<Local> for QueueHandshake {
    type Error = ChannelClosed;

    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, Result<(), ChannelClosed>> {
        Box::pin(async move {
            self.0
                .out_tx
                .send(bytes)
                .await
                .map_err(|_| ChannelClosed("hs send"))
        })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Result<Vec<u8>, ChannelClosed>> {
        Box::pin(async move { self.0.in_rx.recv().await.map_err(|_| ChannelClosed("hs recv")) })
    }
}

// --- instance state ---

/// One partition's live replica.
struct Partition {
    am: AutoCommit,
    /// Chunk crefs (automerge change hashes) already applied.
    applied: HashSet<[u8; 32]>,
    /// Monotonic per-replica revision: applied-change count.
    revision: u64,
    /// Chunks seen in the sedimentree but undecryptable under held epochs.
    undecryptable: u32,
    /// Chunks whose ENVELOPE this replica has opened. Tracked separately
    /// from `revision` because opening a chunk and materializing it are
    /// different things: a late joiner can hold the epoch for a chunk
    /// whose automerge dependencies it will never have, and conflating
    /// the two hides exactly that boundary.
    decrypted: u32,
    /// Chunks recovered by CAUSAL WALK — i.e. ones whose direct decrypt
    /// failed and which were reached through a readable descendant's
    /// ancestor keys.
    ///
    /// Distinct from `decrypted` on purpose. "It materialized" and "it
    /// materialized through the walk" are different claims, and this
    /// spike has already once mistaken one observation for another; a
    /// gate that cannot tell them apart cannot assert §4b.
    walked: u32,
}


/// The two provider strategies behind one bucket surface: S3 (name
/// secrecy + cooperative deletion) and Dropbox (link capabilities,
/// revoked server-side, hard and retroactively).
enum StoreCfg {
    S3(S3Cfg),
    Dropbox(DbxCfg),
    /// Google Drive: Dropbox's layout over an id-addressed API with the
    /// entire link tier removed — owner route only, no capability ever
    /// minted (runtime/DRIVE.md §1).
    Gdrive(GdriveCfg),
}

/// One partition's bucket-side state (the #19 pull layer).
struct BucketState {
    /// Per-epoch name-keys; index = epoch. Rotated on store-revoke.
    name_keys: Vec<[u8; 32]>,
    /// cref -> epoch it was flushed under.
    flushed: HashMap<[u8; 32], u32>,
    /// Append-ordered manifest entries: (cref, parents, epoch).
    entries: Vec<([u8; 32], Vec<[u8; 32]>, u32)>,
    /// Member individuals holding a K_p.
    grantees: Vec<Vec<u8>>,
    /// Dropbox only: the container capability minted on the doc folder
    /// (the pull tier). Re-minted on every revoke.
    doc_link: Option<String>,
    /// Dropbox only: (member, that member's standing pickup-file link).
    /// The pickup file is rewritten in place across rotations, so these
    /// links never change once minted.
    pickup_links: Vec<(Vec<u8>, String)>,
}

struct State {
    kh: Kh,
    /// A clone of the ciphertext store keyhive was built with. Clones
    /// share internal state, so inserting here is inserting into
    /// keyhive's own store — which is where the causal walk looks for
    /// ancestors (§4b). The sedimentree remains the authoritative copy;
    /// this is a working set, and keyhive EVICTS from it on a successful
    /// walk (`mark_decrypted` removes), so it is refilled on demand.
    ciphertexts: KhStore,
    /// cref -> the symmetric key that chunk's envelope was sealed under.
    ///
    /// Populated three ways, and the invariant that makes the write path
    /// sound is that all three are the only ways a chunk becomes an
    /// automerge dependency: we sealed it, we opened it directly, or we
    /// reached it through a walk. A device can therefore always name the
    /// keys of its own change's parents.
    chunk_keys: HashMap<[u8; 32], SymmetricKey>,
    sd: Arc<Sd>,
    sd_storage: MemoryStorage,
    signer: WebcryptoSigner,
    my_peer: PeerId,
    nonce_cache: Rc<NonceCache>,
    proto: Rc<KhProto>,
    conn_results: HashMap<u32, Result<String, String>>,
    syncs: HashMap<u32, Result<String, String>>,
    endpoint: Option<Rc<Endpoint>>,
    /// The relay this endpoint bound to. Pairing has no relay hint in the
    /// code (PAIRING.md §1), so both sides use their configured one.
    relay_url: Option<String>,
    iroh_identity: Option<Rc<polymorph::iroh::identity::Identity>>,
    iroh_conns: HashMap<u32, Rc<polymorph::iroh::endpoint::Connection>>,
    partitions: HashMap<Vec<u8>, Partition>,
    /// Creation changes awaiting `seal-partition`.
    pending: HashMap<Vec<u8>, (Vec<u8>, [u8; 32])>,
    /// The partition the tasks service is bound to.
    active: Option<Vec<u8>>,
    /// Rate limiter for `nudge_keyhive_sync` (fires when it reaches 0).
    kh_nudge: u32,
    store: Option<StoreCfg>,
    buckets: HashMap<Vec<u8>, BucketState>,
    /// Google Drive folder-id cache: `"<root>/docs/<hex(doc)>"` -> id.
    /// Drive is id-addressed and every path segment costs a `files.list`,
    /// so the walk is paid once per folder per instance (DRIVE.md §2).
    /// Instance memory only: ids are public addressing, never persisted
    /// and never a capability.
    gd_folders: HashMap<String, String>,
    /// Device pairing (#10).
    pair: pairing::PairState,
    /// The user-system partition (#36).
    us: usdoc::UsDoc,
    fetches: u32,
    next_id: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    STATE.with(|s| {
        s.borrow_mut()
            .as_mut()
            .map(f)
            .ok_or_else(|| "not initialized (call init first)".to_string())
    })
}

fn now_ts() -> TimestampSeconds {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs();
    TimestampSeconds::new(secs)
}

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| format!("{what} must be 32 bytes"))
}

fn kh_doc_id(bytes: &[u8]) -> Result<DocumentId, String> {
    Ok(DocumentId::from(identifier(bytes)?))
}

fn identifier(bytes: &[u8]) -> Result<Identifier, String> {
    let arr = arr32(bytes, "agent id")?;
    let vk = DalekVerifyingKey::from_bytes(&arr).map_err(|e| format!("bad agent id: {e:?}"))?;
    Ok(Identifier::from(vk))
}

fn parse_access(level: &str) -> Result<Access, String> {
    match level {
        "read" => Ok(Access::Read),
        "edit" => Ok(Access::Edit),
        "admin" => Ok(Access::Admin),
        other => Err(format!("unknown access level {other}")),
    }
}

fn tree_id(bytes: &[u8]) -> Result<SedimentreeId, String> {
    Ok(SedimentreeId::new(arr32(bytes, "tree id")?))
}

async fn breathe() {
    wit_bindgen::yield_async().await;
    wit_bindgen::yield_async().await;
}

/// Refresh the bridge's event cache, then sync.
///
/// Finding (this spike): `KeyhiveProtocol::sync_keyhive` serves the
/// per-peer event set from a `PeriodicEventCache` once one exists.
/// Upstream's runtime refreshes that cache on an interval; an embedder
/// that skips the runtime (us) and creates keyhive ops locally (member
/// changes, encrypt-time CGKA rotations) must refresh before syncing, or
/// every op created after the cache first fills is silently never offered
/// to peers — post-revocation rotations never reach remaining members,
/// and their decrypts fail `KeyNotFound` forever.
async fn refreshed_sync(
    proto: &KhProto,
    target: Option<&KeyhivePeerId>,
) -> Result<(), String> {
    proto
        .refresh_cache()
        .await
        .map_err(|e| format!("refresh cache: {e:?}"))?;
    proto
        .sync_keyhive(target)
        .await
        .map_err(|e| format!("sync keyhive: {e:?}"))
}

/// Rate-limited keyhive re-sync, driven by read polls that find themselves
/// still waiting on keyhive state (missing doc, undecryptable chunks).
///
/// The bridge's syncs are one-shot request/response rounds with no retry;
/// upstream runs them from a periodic runtime loop. A lost or ill-timed
/// round would otherwise strand a member forever.
async fn nudge_keyhive_sync() {
    let fire = with_state(|s| {
        if s.kh_nudge == 0 {
            s.kh_nudge = 20;
            true
        } else {
            s.kh_nudge -= 1;
            false
        }
    })
    .unwrap_or(false);
    if fire {
        if let Ok(proto) = with_state(|s| s.proto.clone()) {
            if let Err(e) = refreshed_sync(&proto, None).await {
                eprintln!("[kh nudge] {e}");
            }
        }
    }
}

// --- shared handshake + iroh pumps (unchanged from the skeleton) ---

#[allow(clippy::too_many_arguments)]
async fn subduction_handshake(
    transport: QueueTransport,
    initiator: bool,
    expected_peer: Vec<u8>,
    sd: Arc<Sd>,
    signer: WebcryptoSigner,
    my_peer: PeerId,
    nonce_cache: Rc<NonceCache>,
) -> Result<String, String> {
    let now = now_ts();
    let result = if initiator {
        let expected = arr32(&expected_peer, "expected peer")?;
        let audience = Audience::known(PeerId::new(expected));
        let nonce = Nonce::from_bytes(rand::random::<[u8; 16]>());
        handshake::initiate::<Local, _, _, _, _>(
            QueueHandshake(transport),
            |h, _peer| (MessageTransport::new(h.0), ()),
            &signer,
            audience,
            now,
            nonce,
        )
        .await
        .map_err(|e| format!("initiate: {e:?}"))
    } else {
        handshake::respond::<Local, _, _, _, _>(
            QueueHandshake(transport),
            |h, _peer| (MessageTransport::new(h.0), ()),
            &signer,
            &nonce_cache,
            my_peer,
            None,
            now,
            Duration::from_secs(300),
        )
        .await
        .map_err(|e| format!("respond: {e:?}"))
    };

    match result {
        Ok((authenticated, ())) => {
            let peer_hex = authenticated.peer_id().to_string();
            match sd.add_connection(authenticated).await {
                Ok(_) => Ok(peer_hex),
                Err(e) => Err(format!("add_connection: {e:?}")),
            }
        }
        Err(e) => Err(e),
    }
}

async fn iroh_writer(out_rx: async_channel::Receiver<Vec<u8>>, send: SendStream) {
    while let Ok(frame) = out_rx.recv().await {
        if send.write(pairing::frame_bytes(&frame)).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
}

async fn iroh_reader(in_tx: async_channel::Sender<Vec<u8>>, recv: RecvStream, seed: Vec<u8>) {
    let mut buf: Vec<u8> = seed;
    loop {
        while buf.len() >= 4 {
            let len = u32::from_le_bytes(buf[0..4].try_into().expect("4 bytes")) as usize;
            if buf.len() < 4 + len {
                break;
            }
            let frame: Vec<u8> = buf[4..4 + len].to_vec();
            buf.drain(0..4 + len);
            if in_tx.send(frame).await.is_err() {
                return;
            }
        }
        match recv.read(64 * 1024).await {
            Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
}

// --- the bucket path (#19's pull layer; adapted from spikes/storage) ---

#[derive(Serialize, Deserialize)]
struct KpObject {
    /// The owner prekey the DH used (member looks up nothing for it).
    owner_pk: ShareKey,
    /// The member prekey the DH used (member looks up its secret by it).
    member_pk: ShareKey,
    sealed: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct KpPayload {
    /// (epoch, name-key) keychain: current epoch grants history names.
    name_keys: Vec<(u32, [u8; 32])>,
    /// Devices whose oplogs/manifests to fetch (absent ones are skipped).
    devices: Vec<[u8; 32]>,
}

/// The Dropbox pickup payload, sealed to the member exactly as K_p is.
/// No name-key keychain: this provider has no name secrecy to key, so
/// the standing secret a member needs is the container capability.
#[derive(Serialize, Deserialize)]
struct DbxPickup {
    /// The shared link minted on the doc folder (the pull capability).
    doc_link: String,
    /// Devices whose oplogs/manifests to fetch (absent ones are skipped).
    devices: Vec<[u8; 32]>,
}

/// The Google Drive pickup payload, sealed to the member exactly as K_p
/// is. NO capability inside, and that is the ruling rather than an
/// omission (DRIVE.md §1): this store mints nothing a link could carry.
/// What it carries instead is the same bootstrap S3's `KpPayload`
/// carries — the name-key keychain and the device set — for the
/// ACCOUNT'S OWN DEVICES, each of which is its own agent with its own
/// prekeys and reads the store with the user's own OAuth.
///
/// The keychain is a SECRET but still not a capability, and the
/// distinction is the provider's whole shape: knowing a name lets you
/// DERIVE where an object sits, not READ it. On S3 the two collapse
/// (name secrecy IS the read tier, over anonymous GETs); here they do
/// not, because every read goes through the owner seam's OAuth. So the
/// keychain blinds an observer's labels without granting anything to
/// whoever holds it.
///
/// This record was WRITE-ONLY before names were keyed — the pull
/// derived its device set by parsing `oplog-<hex>` / `manifest-<hex>`
/// out of the doc folder's own listing. Keyed names make those listings
/// opaque (which is the point), so the parse is gone and this payload
/// is now the ONLY bootstrap: DRIVE.md §1's "it becomes load-bearing
/// the moment a pull path exists that cannot list the folder" has come
/// due, by way of a pull path that can list the folder and learn
/// nothing from it.
#[derive(Serialize, Deserialize)]
struct GdrivePickup {
    /// (epoch, name-key) keychain, sorted by epoch — the same shape
    /// `KpPayload::name_keys` carries, so the two providers' bootstraps
    /// cannot drift.
    name_keys: Vec<(u32, [u8; 32])>,
    /// Devices whose oplogs/manifests to fetch (absent ones are skipped).
    devices: Vec<[u8; 32]>,
}

#[derive(Serialize, Deserialize)]
struct BucketManifest {
    doc: Vec<u8>,
    /// Append-ordered (cref, parents, epoch).
    entries: Vec<([u8; 32], Vec<[u8; 32]>, u32)>,
    device: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct SignedManifest {
    manifest: Vec<u8>,
    sig: Vec<u8>,
}

// --- the identity bundle (G5): one sealed payload, LUKS-style keyslots ---

#[derive(Serialize, Deserialize)]
enum BundleSlot {
    /// argon2id(passphrase) — the downloadable-file wrap. Parameters
    /// and salt travel with the slot (agility, per-device calibration).
    Passphrase {
        salt: [u8; 16],
        m_cost_kib: u32,
        t_cost: u32,
        p_cost: u32,
        wrapped: Vec<u8>,
    },
    /// A caller-provided 32-byte secret: the passkey-PRF output or a
    /// generated recovery code, depending on what the host wires in.
    Secret { label: String, wrapped: Vec<u8> },
}

#[derive(Serialize, Deserialize)]
struct IdentityBundle {
    /// Cleartext, human-auditable ("whose device file is this").
    label: String,
    created: u64,
    slots: Vec<BundleSlot>,
    /// AES-GCM(bundle-key) of a bincoded `BundlePayload`.
    sealed: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct BundlePayload {
    /// The soft identity key's 32-byte seed (Soft posture only —
    /// platform-held identities have no export path at this rev).
    signing_key_seed: [u8; 32],
    verifying: [u8; 32],
    keyhive_archive: Vec<u8>,
    partition: Vec<u8>,
    owner: Vec<u8>,
}

fn argon2id_key(
    pass: &str,
    salt: &[u8],
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(m_cost_kib, t_cost, p_cost, Some(32))
        .map_err(|e| format!("argon2 params: {e}"))?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; 32];
    a.hash_password_into(pass.as_bytes(), salt, &mut out)
        .map_err(|e| format!("argon2: {e}"))?;
    Ok(out)
}

/// Spike-scale argon2id parameters (OWASP-baseline shape; production
/// calibrates per device class).
const ARGON_M_KIB: u32 = 19_456;
const ARGON_T: u32 = 2;
const ARGON_P: u32 = 1;

async fn aead_from_raw(raw: &[u8]) -> Result<Aead, String> {
    aes_gcm::import_key_raw(
        AesVariant::Aes256,
        raw.to_vec(),
        AeadKeyOptions {
            seal: true,
            open: true,
            wrap: false,
            unwrap: false,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("aead import: {e}"))
}

async fn aead_seal(aead: &Aead, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; 12] = rand::random();
    let ct = aead
        .seal(nonce.as_slice(), aad, plaintext)
        .await
        .map_err(|e| format!("seal: {e}"))?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(blob)
}

async fn aead_open(aead: &Aead, aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 12 {
        return Err("blob too short".into());
    }
    let stream = aead
        .open(&blob[..12], aad, &blob[12..])
        .await
        .map_err(|e| format!("open: {e}"))?;
    Ok(stream.collect().await)
}

// --- the S3 provider ---
//
// SigV4 signing, the object ops built on it, and the name-secrecy
// derivations live in `provider-s3`; the ports they travel through
// (`EngineFetch`, `EngineSigner`) are defined below. What stays here is
// the config snapshot, which reads engine state.

fn store() -> Result<S3Cfg, String> {
    with_state(|s| match s.store.as_ref() {
        Some(StoreCfg::S3(c)) => Ok(S3Cfg {
            endpoint: c.endpoint.clone(),
            bucket: c.bucket.clone(),
            access: c.access.clone(),
        }),
        Some(StoreCfg::Dropbox(_)) => Err("s3 path called on a dropbox store".to_string()),
        Some(StoreCfg::Gdrive(_)) => Err("s3 path called on a gdrive store".to_string()),
        None => Err("store not configured (init-store first)".to_string()),
    })?
}

/// The engine's `FetchPort`: Route selects WHICH WORLD IMPORT the call
/// travels through (#7). The imports are inline anonymous interfaces in
/// the `engine` world, so their bindings exist only here — which is why
/// the provider crates take a port rather than generating their own.
///
/// The per-attempt fetch counter lives here, and `do_fetch` calls this
/// exactly once per attempt, so the count the harness observes is
/// unchanged by the extraction.
struct EngineFetch;

impl FetchPort for EngineFetch {
    async fn request(
        &self,
        route: Route,
        method: &str,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), String> {
        let _ = with_state(|s| s.fetches += 1);
        let result = match route {
            Route::Owner => {
                store_owner_fetch::request(method.to_string(), url.to_string(), headers, body).await
            }
            Route::Shared => {
                store_shared_fetch::request(method.to_string(), url.to_string(), headers, body)
                    .await
            }
            Route::Public => {
                store_public_fetch::request(method.to_string(), url.to_string(), headers, body)
                    .await
            }
        };
        match result {
            Ok(resp) => Ok((resp.status, resp.body)),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The engine's `Sigv4SignPort`: the escrowed-credential seam (#11). The
/// credential's key bytes never enter guest memory; only the string-to-
/// sign and its scope cross over, and both are public request metadata.
struct EngineSigner;

impl Sigv4SignPort for EngineSigner {
    async fn sign(
        &self,
        string_to_sign: String,
        date: String,
        region: String,
        service: String,
    ) -> Result<String, String> {
        store_signer::sign(string_to_sign, date, region, service)
            .await
            .map_err(|e| e.to_string())
    }
}

/// My prekey pairs, out of keyhive's Active.
async fn my_prekey_pairs(kh: &Kh) -> Result<std::collections::BTreeMap<ShareKey, ShareSecretKey>, String> {
    let blob = kh
        .active()
        .lock()
        .await
        .export_prekey_secrets()
        .await
        .map_err(|e| format!("export prekeys: {e}"))?;
    bincode::deserialize(&blob).map_err(|e| format!("prekeys decode: {e}"))
}

/// AEAD from a prekey-DH shared secret (HMAC as the KDF step).
async fn ikm_aead(ikm: &[u8; 32], info: &[u8]) -> Result<Aead, String> {
    let key = hmac(ikm, info).await?;
    aead_from_raw(&key).await
}

/// Serialize everything this keyhive knows as static events: membership
/// ops (every group/doc it holds, including ingested foreign groups),
/// reachable prekey ops, and CGKA ops. This is the bucket's op stream:
/// sufficient state for a cold member to join, gated by name secrecy at
/// rest and by BeeKEM for the content it unlocks.
async fn export_oplog(kh: &Kh) -> Result<Vec<u8>, String> {
    let mem = kh.membership_ops_for_all_agents().await;
    let pre = kh.reachable_prekey_ops_for_all_agents().await;
    let cg = kh.cgka_ops_for_all_agents().await;

    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    let mut events: Vec<StaticEvent<T>> = Vec::new();
    let push = |se: StaticEvent<T>, seen: &mut HashSet<[u8; 32]>, out: &mut Vec<StaticEvent<T>>| {
        let digest = keyhive_crypto::digest::Digest::hash(&se);
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest.as_slice()[..32]);
        if seen.insert(key) {
            out.push(se);
        }
    };

    for source_ops in mem.ops.values() {
        for op in source_ops.values() {
            let ev: Event<Local, WebcryptoSigner, T, NoListener> = op.clone().into();
            push(StaticEvent::from(ev), &mut seen, &mut events);
        }
    }
    for key_ops in pre.ops.values() {
        for op in key_ops.iter() {
            let ev: Event<Local, WebcryptoSigner, T, NoListener> = Event::from(op.as_ref().clone());
            push(StaticEvent::from(ev), &mut seen, &mut events);
        }
    }
    for cgka_ops in cg.ops.values() {
        for op in cgka_ops.iter() {
            let ev: Event<Local, WebcryptoSigner, T, NoListener> = Event::from(op.clone());
            push(StaticEvent::from(ev), &mut seen, &mut events);
        }
    }
    bincode::serialize(&events).map_err(|e| format!("oplog serialize: {e}"))
}

/// Seal a payload to one member: a DH between one of my keyhive
/// contact-card prekeys and one of theirs, both picks recorded in the
/// object so the member can look their secret up. `info` separates the
/// purposes (S3's K_p vs Dropbox's pickup file); `doc` is the AAD.
async fn seal_to_member(
    kh: &Kh,
    doc: &[u8],
    member: &[u8],
    info: &[u8],
    plaintext: &[u8],
) -> Result<KpObject, String> {
    let did = kh_doc_id(doc)?;
    let my_id_bytes = with_state(|s| s.my_peer.as_bytes().to_vec())?;

    // The member's prekey, picked from their ingested card.
    let member_ident = identifier(member)?;
    let member_agent = kh
        .get_agent(member_ident)
        .await
        .ok_or("member agent unknown (ingest their contact card first)")?;
    let member_picks = member_agent.pick_individual_prekeys(did).await;
    let member_pk = *member_picks
        .get(&IndividualId::from(member_ident))
        .ok_or("no prekey for member")?;

    // My own pick + its secret.
    let my_agent = kh
        .get_agent(identifier(&my_id_bytes)?)
        .await
        .ok_or("own agent missing")?;
    let my_picks = my_agent.pick_individual_prekeys(did).await;
    let owner_pk = *my_picks
        .get(&IndividualId::from(identifier(&my_id_bytes)?))
        .ok_or("no own prekey")?;
    let pairs = my_prekey_pairs(kh).await?;
    let owner_sk = pairs.get(&owner_pk).ok_or("own prekey secret missing")?;

    let ikm = owner_sk.derive_new_secret_key(&member_pk).to_bytes();
    let aead = ikm_aead(&ikm, info).await?;
    let sealed = aead_seal(&aead, doc, plaintext).await?;
    Ok(KpObject {
        owner_pk,
        member_pk,
        sealed,
    })
}

/// The inverse of `seal_to_member`, run by the recipient: look up the
/// secret for the recorded member prekey and DH against the owner's.
async fn unseal_from_owner(
    kh: &Kh,
    doc: &[u8],
    obj: &KpObject,
    info: &[u8],
) -> Result<Vec<u8>, String> {
    let pairs = my_prekey_pairs(kh).await?;
    let sk = pairs
        .get(&obj.member_pk)
        .ok_or("pickup not sealed to any of my prekeys")?;
    let ikm = sk.derive_new_secret_key(&obj.owner_pk).to_bytes();
    let aead = ikm_aead(&ikm, info).await?;
    aead_open(&aead, doc, &obj.sealed).await
}

/// The grantee set as 32-byte device ids (the devices whose oplogs and
/// manifests a recipient should fetch).
fn grantee_devices(doc: &[u8]) -> Result<Vec<[u8; 32]>, String> {
    with_state(|s| {
        let b = s.buckets.get(doc).ok_or("no bucket state".to_string())?;
        let mut devices: Vec<[u8; 32]> = Vec::new();
        for g in &b.grantees {
            if let Ok(arr) = arr32(g, "grantee") {
                devices.push(arr);
            }
        }
        Ok::<_, String>(devices)
    })?
}

/// Publish one member's K_p: the name-key keychain + device list, sealed
/// to a prekey DH (see `seal_to_member`).
async fn publish_kp(st: &S3Cfg, kh: &Kh, doc: &[u8], member: &[u8]) -> Result<(), String> {
    let my_id_bytes = with_state(|s| s.my_peer.as_bytes().to_vec())?;
    let devices = grantee_devices(doc)?;
    let payload = with_state(|s| {
        let b = s.buckets.get(doc).ok_or("no bucket state".to_string())?;
        Ok::<_, String>(KpPayload {
            name_keys: b
                .name_keys
                .iter()
                .enumerate()
                .map(|(e, nk)| (e as u32, *nk))
                .collect(),
            devices,
        })
    })??;
    let obj = seal_to_member(
        kh,
        doc,
        member,
        b"kp-wrap",
        &bincode::serialize(&payload).map_err(|e| e.to_string())?,
    )
    .await?;
    let name = kp_location(doc, &my_id_bytes, member).await?;
    put_object(
        st,
        &EngineFetch,
        &EngineSigner,
        &name,
        bincode::serialize(&obj).map_err(|e| e.to_string())?,
    )
    .await
}

// --- the Dropbox provider ---
//
// The protocol itself (RPC shapes, uploads, downloads, link mint/revoke,
// path derivation) lives in `provider-dropbox`; what stays here is the
// part entangled with engine state and group crypto: the config
// snapshot, the container-link cache, and the sealed pickup file.

fn dbx() -> Result<DbxCfg, String> {
    with_state(|s| match s.store.as_ref() {
        Some(StoreCfg::Dropbox(c)) => Ok(DbxCfg {
            root: c.root.clone(),
        }),
        Some(StoreCfg::S3(_)) => Err("dropbox path called on an s3 store".to_string()),
        Some(StoreCfg::Gdrive(_)) => Err("dropbox path called on a gdrive store".to_string()),
        None => Err("store not configured (init-store first)".to_string()),
    })?
}

/// Ensure the doc folder exists and its container link is minted,
/// caching the link in per-doc bucket state. Called on the first grant
/// or flush for a doc.
async fn dbx_ensure_doc_container(cfg: &DbxCfg, doc: &[u8]) -> Result<String, String> {
    ensure_bucket_state(doc)?;
    if let Some(link) = with_state(|s| s.buckets.get(doc).and_then(|b| b.doc_link.clone()))? {
        return Ok(link);
    }
    dbx_create_folder(cfg, &EngineFetch, &format!("/{}", cfg.root), true).await?;
    dbx_create_folder(cfg, &EngineFetch, &format!("/{}/docs", cfg.root), true).await?;
    let folder = dbx_doc_folder(&cfg.root, doc);
    // The container link must be minted on the FOLDER, so the folder has
    // to exist before any file lands in it (uploads create parents
    // implicitly, but silently). Tolerating the conflict keeps re-grant
    // and re-flush idempotent.
    dbx_create_folder(cfg, &EngineFetch, &folder, true).await?;
    let link = dbx_mint_link(cfg, &EngineFetch, &folder).await?;
    with_state(|s| {
        if let Some(b) = s.buckets.get_mut(doc) {
            b.doc_link = Some(link.clone());
        }
    })?;
    Ok(link)
}

/// Write one member's pickup file: the current container link plus the
/// device set, sealed to their prekey exactly as K_p is. Overwrite in
/// place, so a re-grant (or a post-revocation rewrite) refreshes the
/// contents without disturbing the member's standing pickup link.
async fn dbx_publish_pickup(cfg: &DbxCfg, kh: &Kh, doc: &[u8], member: &[u8]) -> Result<(), String> {
    let doc_link = dbx_ensure_doc_container(cfg, doc).await?;
    let payload = DbxPickup {
        doc_link,
        devices: grantee_devices(doc)?,
    };
    let obj = seal_to_member(
        kh,
        doc,
        member,
        b"pickup-wrap",
        &bincode::serialize(&payload).map_err(|e| e.to_string())?,
    )
    .await?;
    dbx_upload(
        cfg,
        &EngineFetch,
        &dbx_pickup_path(&cfg.root, doc, member),
        bincode::serialize(&obj).map_err(|e| e.to_string())?,
    )
    .await
}

// --- the Google Drive provider ---
//
// The protocol itself (files.list resolution, multipart create / media
// update, alt=media reads, deletes, child naming) lives in
// `provider-gdrive`; what stays here is the part entangled with engine
// state and group crypto: the config snapshot, the folder-id cache, and
// the sealed pickup object.

fn gd() -> Result<GdriveCfg, String> {
    with_state(|s| match s.store.as_ref() {
        Some(StoreCfg::Gdrive(c)) => Ok(GdriveCfg {
            root: c.root.clone(),
            api_base: c.api_base.clone(),
            space: c.space,
        }),
        Some(StoreCfg::S3(_)) => Err("gdrive path called on an s3 store".to_string()),
        Some(StoreCfg::Dropbox(_)) => Err("gdrive path called on a dropbox store".to_string()),
        None => Err("store not configured (init-store first)".to_string()),
    })?
}

/// Resolve-or-create a folder path under My Drive, one `files.list` per
/// segment, memoized in instance state. Drive has no paths (DRIVE.md
/// §2), so this walk IS the path; the cache is what keeps a flush from
/// re-walking it per object.
/// THE SPACE ENTERS HERE, as the walk's starting parent: `root` for a
/// visible My Drive folder, `appDataFolder` for the hidden per-app
/// space (`GdSpace::root_parent`). Everything after that first segment
/// is identical between the spaces, which is what makes the space a
/// storage LOCATION and not a second strategy.
///
/// The folder-id cache is keyed by path only, which is safe because a
/// store's space is fixed at `init-store` and an instance holds one
/// store config at a time.
// CONTRACT: DRIVE.md predates the space choice and says nothing about
// re-`init-store` into a DIFFERENT space on a live instance; the
// conservative reading is that this cache would have to be cleared for
// that, and no caller does it today.
async fn gd_folder_path(cfg: &GdriveCfg, segments: &[String]) -> Result<String, String> {
    let mut parent = cfg.space.root_parent().to_string();
    let mut key = String::new();
    for seg in segments {
        key.push('/');
        key.push_str(seg);
        if let Some(id) = with_state(|s| s.gd_folders.get(&key).cloned())? {
            parent = id;
            continue;
        }
        let id = gd_ensure_folder(cfg, &EngineFetch, &parent, seg).await?;
        with_state(|s| s.gd_folders.insert(key.clone(), id.clone()))?;
        parent = id;
    }
    Ok(parent)
}

/// This doc's name-key keychain, oldest epoch first, from bucket state.
/// `ensure_bucket_state` must have run.
fn doc_keychain(doc: &[u8]) -> Result<Vec<(u32, [u8; 32])>, String> {
    with_state(|s| {
        let b = s.buckets.get(doc).ok_or("no bucket state".to_string())?;
        Ok::<_, String>(
            b.name_keys
                .iter()
                .enumerate()
                .map(|(e, nk)| (e as u32, *nk))
                .collect(),
        )
    })?
}

/// The doc's FOUNDING name-key (epoch 0) — what the doc folder's name is
/// derived under, so the container never has to move. See
/// `provider_gdrive::gd_doc_name` for why the folder is keyed at all and
/// why epoch 0 specifically.
fn doc_founding_key(doc: &[u8]) -> Result<[u8; 32], String> {
    with_state(|s| {
        let b = s.buckets.get(doc).ok_or("no bucket state".to_string())?;
        b.name_keys.first().copied().ok_or("empty keychain".to_string())
    })?
}

/// The per-doc object folder: `<root>/docs/<keyed(doc)>`. The last
/// segment is a keyed hash, not the doc id — an observer listing `docs`
/// learns how many documents this account stores and nothing about
/// which ones (DRIVE.md §2).
async fn gd_doc_folder(cfg: &GdriveCfg, doc: &[u8]) -> Result<String, String> {
    let name = gd_doc_name(&doc_founding_key(doc)?, doc).await?;
    gd_folder_path(cfg, &[cfg.root.clone(), "docs".to_string(), name]).await
}

/// The pickup folder: `<root>/pickup`, FLAT — no per-doc subfolder.
///
/// Deliberate, and the reasoning is in `provider_gdrive::gd_pickup_name`:
/// pickup objects must be findable by a device that does not yet hold
/// the keychain, so their location cannot be keyed; and any unkeyed
/// per-doc folder name — the doc id plain, or hashed — would be a
/// global, stable per-document label sitting in every member's store,
/// which is exactly the disclosure the keyed names remove. One flat
/// folder of triple-hashed object names is S3's shape and the only one
/// that does not put the label back.
async fn gd_pickup_folder(cfg: &GdriveCfg) -> Result<String, String> {
    gd_folder_path(cfg, &[cfg.root.clone(), "pickup".to_string()]).await
}

/// Write one member's pickup object: the name-key keychain and the
/// device set, sealed to their prekey exactly as K_p is. Overwrite in
/// place, so a re-grant refreshes the contents without disturbing
/// anything else.
async fn gd_publish_pickup(
    cfg: &GdriveCfg,
    kh: &Kh,
    doc: &[u8],
    member: &[u8],
) -> Result<(), String> {
    let my_id_bytes = with_state(|s| s.my_peer.as_bytes().to_vec())?;
    let folder = gd_pickup_folder(cfg).await?;
    let payload = GdrivePickup {
        name_keys: doc_keychain(doc)?,
        devices: grantee_devices(doc)?,
    };
    let obj = seal_to_member(
        kh,
        doc,
        member,
        b"pickup-wrap",
        &bincode::serialize(&payload).map_err(|e| e.to_string())?,
    )
    .await?;
    gd_upload(
        cfg,
        &EngineFetch,
        &folder,
        &gd_pickup_name(doc, &my_id_bytes, member).await?,
        bincode::serialize(&obj).map_err(|e| e.to_string())?,
    )
    .await
}

/// Ensure bucket-side state exists for a partition.
fn ensure_bucket_state(doc: &[u8]) -> Result<(), String> {
    with_state(|s| {
        s.buckets.entry(doc.to_vec()).or_insert_with(|| BucketState {
            name_keys: vec![rand::random()],
            flushed: HashMap::new(),
            entries: Vec::new(),
            grantees: Vec::new(),
            doc_link: None,
            pickup_links: Vec::new(),
        });
    })
}

// --- provider dispatch: one bucket surface, two strategies ---

enum Provider {
    S3,
    Dropbox,
    Gdrive,
}

fn provider() -> Result<Provider, String> {
    with_state(|s| match s.store.as_ref() {
        Some(StoreCfg::S3(_)) => Ok(Provider::S3),
        Some(StoreCfg::Dropbox(_)) => Ok(Provider::Dropbox),
        Some(StoreCfg::Gdrive(_)) => Ok(Provider::Gdrive),
        None => Err("store not configured (init-store first)".to_string()),
    })?
}

/// Where a flush writes. The providers differ in addressing and
/// transport only — the blob CONTENTS (envelope bytes, op-stream blob,
/// signed manifest) are produced by the same pipeline either way.
enum PutSink {
    /// S3: object names HMAC-derived from the current name-key.
    S3 { st: S3Cfg, nk: [u8; 32] },
    /// Dropbox: plain `{kind}-{hex}` children of the doc folder.
    Dbx { cfg: DbxCfg, folder: String },
    /// Google Drive: the SAME name-keyed child names S3 writes, under a
    /// doc folder whose own name is keyed too (Drive has no paths to
    /// write to, so the folder id is resolved once and carried here).
    Gd {
        cfg: GdriveCfg,
        folder_id: String,
        nk: [u8; 32],
    },
}

impl PutSink {
    async fn put(&self, kind: &str, id: &[u8], body: Vec<u8>) -> Result<(), String> {
        match self {
            PutSink::S3 { st, nk } => {
                let name = object_name(nk, kind.as_bytes(), id).await?;
                put_object(st, &EngineFetch, &EngineSigner, &name, body).await
            }
            PutSink::Dbx { cfg, folder } => {
                dbx_upload(
                    cfg,
                    &EngineFetch,
                    &format!("{folder}/{}", dbx_child(kind, id)),
                    body,
                )
                .await
            }
            PutSink::Gd {
                cfg,
                folder_id,
                nk,
            } => {
                let name = gd_child(nk, kind, id).await?;
                gd_upload(cfg, &EngineFetch, folder_id, &name, body).await
            }
        }
    }
}

/// Check a device's signed manifest against that device's verifying key
/// and return the manifest it carries.
async fn verify_manifest(blob: &[u8], device: &[u8; 32]) -> Result<BucketManifest, String> {
    let signed: SignedManifest =
        bincode::deserialize(blob).map_err(|e| format!("manifest decode: {e}"))?;
    let vk = ed25519::import_verifying_key_raw(device.to_vec())
        .await
        .map_err(|e| format!("vk import: {e}"))?;
    vk.verify(signed.manifest.as_slice(), signed.sig.as_slice())
        .await
        .map_err(|_| "manifest signature invalid".to_string())?;
    bincode::deserialize(&signed.manifest).map_err(|e| format!("manifest decode: {e}"))
}

/// Push new chunks, the op-stream blob, and the signed manifest through
/// whichever sink the configured provider gives us.
async fn flush_to(sink: &PutSink, doc_id: &[u8], epoch: u32) -> Result<String, String> {
    let (kh, sd, storage, signer, device_vk) = with_state(|s| {
        (
            s.kh.clone(),
            s.sd.clone(),
            s.sd_storage.clone(),
            s.signer.clone(),
            *s.my_peer.as_bytes(),
        )
    })?;
    let tree = tree_id(doc_id)?;

    // New chunks: the same envelope bytes the sedimentree holds.
    let commits = causal_order(sd.get_commits(tree).await.unwrap_or_default());
    let mut new_chunks = 0u32;
    for commit in commits {
        let cref = *commit.head().as_bytes();
        let already = with_state(|s| {
            s.buckets
                .get(doc_id)
                .map(|b| b.flushed.contains_key(&cref))
                .unwrap_or(false)
        })?;
        if already {
            continue;
        }
        let verified =
            <MemoryStorage as Storage<Local>>::load_loose_commit(&storage, tree, commit.head())
                .await
                .map_err(|e| format!("load: {e:?}"))?
                .ok_or("commit blob not found")?;
        sink.put("chunk", &cref, verified.blob().as_slice().to_vec())
            .await?;
        let parents: Vec<[u8; 32]> = commit.parents().iter().map(|p| *p.as_bytes()).collect();
        with_state(|s| {
            let b = s.buckets.get_mut(doc_id).expect("bucket state");
            b.flushed.insert(cref, epoch);
            b.entries.push((cref, parents, epoch));
        })?;
        new_chunks += 1;
    }

    // The op stream, then the signed manifest — per device (and, on S3,
    // under the current name-key).
    let oplog = export_oplog(&kh).await?;
    let oplog_len = oplog.len();
    sink.put("oplog", &device_vk, oplog).await?;

    let entries = with_state(|s| {
        s.buckets
            .get(doc_id)
            .map(|b| b.entries.clone())
            .unwrap_or_default()
    })?;
    let manifest = BucketManifest {
        doc: doc_id.to_vec(),
        entries,
        device: device_vk,
    };
    let manifest_bytes = bincode::serialize(&manifest).map_err(|e| e.to_string())?;
    let sig = signer
        .0
        .key
        .sign_bytes(manifest_bytes.as_slice())
        .await
        .map_err(|e| format!("manifest sign: {e}"))?;
    let signed = bincode::serialize(&SignedManifest {
        manifest: manifest_bytes,
        sig,
    })
    .map_err(|e| e.to_string())?;
    sink.put("manifest", &device_vk, signed).await?;

    Ok(format!(
        "flushed chunks={new_chunks} oplog={oplog_len}B epoch={epoch}"
    ))
}

/// Record pulled manifest entries as flushed state, so a later flush
/// from this instance uploads only genuinely new chunks (and its own
/// manifest carries the full known set).
fn adopt_entries(doc_id: &[u8], entries: &[Entry]) -> Result<(), String> {
    with_state(|s| {
        let b = s.buckets.get_mut(doc_id).expect("bucket state");
        for (cref, parents, epoch) in entries {
            if !b.flushed.contains_key(cref) {
                b.flushed.insert(*cref, *epoch);
                b.entries.push((*cref, parents.clone(), *epoch));
            }
        }
    })
}

/// The Dropbox pull. Tier is chosen by the CALLER's argument alone: a
/// `pickup` link means "read as a link-tier recipient" (anonymous route),
/// its absence means "read as the owner" (owner route). Deliberately NOT
/// keyed on whether a token is present in guest state — the guest cannot
/// see its credentials any more (#7), and inferring the tier from
/// credential presence is exactly the ambient-authority shape the design
/// memo rejects. Owner tier lists the doc folder and downloads by path;
/// link tier rides the standing pickup link, which yields the container
/// link and the device set. Past
/// point the ingest pipeline is the S3 one: op streams into keyhive,
/// signed manifests into entries, chunks into the sedimentree, apply.
async fn dbx_pull(doc_id: Vec<u8>, pickup: Option<String>) -> Result<String, String> {
    let cfg = dbx()?;
    let (kh, sd) = with_state(|s| (s.kh.clone(), s.sd.clone()))?;
    let tree = tree_id(&doc_id)?;
    ensure_bucket_state(&doc_id)?;

    let (src, devices, tier) = if let Some(pickup) = pickup {
        let blob = dbx_link_fetch(&cfg, &EngineFetch, &pickup, None)
            .await?
            .ok_or("pickup link refused (409): revoked or never granted")?;
        let obj: KpObject =
            bincode::deserialize(&blob).map_err(|e| format!("pickup decode: {e}"))?;
        let payload: DbxPickup = bincode::deserialize(
            &unseal_from_owner(&kh, &doc_id, &obj, b"pickup-wrap").await?,
        )
        .map_err(|e| format!("pickup payload decode: {e}"))?;
        // Session pull material: the resolved container link stays a
        // function-local and is never written to state (the design's
        // no-persist rule). The pickup link arrives as a parameter on
        // every call — that, not the container link, is the standing
        // capability.
        (DbxSource::Link(payload.doc_link), payload.devices, "link")
    } else {
        // Owner tier: the doc folder's own listing is the device set.
        let folder = dbx_doc_folder(&cfg.root, &doc_id);
        let mut devices: Vec<[u8; 32]> = Vec::new();
        for name in dbx_list_folder(&cfg, &EngineFetch, &folder).await? {
            for prefix in ["manifest-", "oplog-"] {
                let Some(id_hex) = name.strip_prefix(prefix) else {
                    continue;
                };
                let Ok(raw) = hex::decode(id_hex) else { continue };
                let Ok(device) = arr32(&raw, "device") else {
                    continue;
                };
                if !devices.contains(&device) {
                    devices.push(device);
                }
            }
        }
        (DbxSource::Owner(folder), devices, "owner")
    };

    // 1. Op streams into keyhive.
    let mut ingested = 0usize;
    for device in &devices {
        let Some(blob) = dbx_fetch_child(&cfg, &EngineFetch, &src, &dbx_child("oplog", device)).await?
        else {
            continue;
        };
        let events: Vec<StaticEvent<T>> =
            bincode::deserialize(&blob).map_err(|e| format!("oplog decode: {e}"))?;
        ingested += events.len();
        kh.ingest_unsorted_static_events(events).await;
    }

    // 2. Manifests -> union of entries.
    let mut entries: Vec<Entry> = Vec::new();
    for device in &devices {
        let Some(blob) =
            dbx_fetch_child(&cfg, &EngineFetch, &src, &dbx_child("manifest", device)).await?
        else {
            continue;
        };
        let manifest = verify_manifest(&blob, device).await?;
        for e in manifest.entries {
            if !entries.iter().any(|(c, _, _)| *c == e.0) {
                entries.push(e);
            }
        }
    }
    adopt_entries(&doc_id, &entries)?;

    // 3. Chunks -> the sedimentree (envelope bytes verbatim), then the
    // normal apply path.
    let have: HashSet<[u8; 32]> = sd
        .get_commits(tree)
        .await
        .unwrap_or_default()
        .iter()
        .map(|c| *c.head().as_bytes())
        .collect();
    let mut fetched = 0u32;
    for (cref, parents, _epoch) in &entries {
        if have.contains(cref) {
            continue;
        }
        let blob = dbx_fetch_child(&cfg, &EngineFetch, &src, &dbx_child("chunk", cref))
            .await?
            .ok_or("chunk object missing or refused (409)")?;
        let parent_set: BTreeSet<CommitId> = parents.iter().map(|p| CommitId::new(*p)).collect();
        sd.add_commit(tree, CommitId::new(*cref), parent_set, Blob::new(blob))
            .await
            .map_err(|e| format!("add_commit: {e:?}"))?;
        fetched += 1;
    }
    if with_state(|s| s.partitions.contains_key(&doc_id))? {
        apply_new_chunks(&doc_id).await?;
    }
    Ok(format!(
        "pulled dropbox({tier}) devices={} events={ingested} chunks={fetched}",
        devices.len()
    ))
}

/// The Google Drive pull: OWNER TIER ONLY (DRIVE.md §1). A `pickup`
/// argument is refused BY NAME rather than ignored — on Dropbox its
/// presence selects the link tier, and this provider has no link tier to
/// select, so silently ignoring it would answer a question the caller
/// asked with a different question's answer. Past the tier decision the
/// ingest pipeline is the Dropbox one, which is the S3 one: op streams
/// into keyhive, signed manifests into entries, chunks into the
/// sedimentree, apply.
///
/// The BOOTSTRAP is now S3's rather than Dropbox's, and that is what
/// keyed names cost and buy. Dropbox's owner arm reads its device set
/// out of the doc folder's listing, by parsing `oplog-<hex(device)>`
/// off each child name; this pull used to do the same. Keyed names make
/// that listing opaque — which is the entire point of keying them — so
/// the device set and the keychain now arrive the way S3's do, out of
/// the member's own sealed pickup object at a location derived from
/// public ids alone (`gd_pickup_name`). A second device of the account
/// can therefore still FIND everything under names it cannot read: the
/// unkeyed bootstrap is the one step, and the keychain inside it opens
/// the rest.
async fn gd_pull(doc_id: Vec<u8>, owner: Vec<u8>, pickup: Option<String>) -> Result<String, String> {
    if pickup.is_some() {
        return Err(
            "bucket-pull(pickup): this store mints no pickup capability (gdrive is owner-tier \
             only); pull as the owner instead"
                .to_string(),
        );
    }
    let cfg = gd()?;
    let (kh, sd) = with_state(|s| (s.kh.clone(), s.sd.clone()))?;
    let my_id = with_state(|s| s.my_peer.as_bytes().to_vec())?;
    let tree = tree_id(&doc_id)?;
    ensure_bucket_state(&doc_id)?;

    // 1. The pickup object: located by public ids, unwrapped by prekey
    //    DH, exactly as `s3_pull` does with K_p.
    let pickup_folder = gd_pickup_folder(&cfg).await?;
    let name = gd_pickup_name(&doc_id, &owner, &my_id).await?;
    let blob = gd_download(&cfg, &EngineFetch, &pickup_folder, &name)
        .await?
        .ok_or("pickup object missing: revoked, or never granted to this device")?;
    let obj: KpObject = bincode::deserialize(&blob).map_err(|e| format!("pickup decode: {e}"))?;
    let pairs = my_prekey_pairs(&kh).await?;
    let sk = pairs
        .get(&obj.member_pk)
        .ok_or("pickup not sealed to any of my prekeys")?;
    let ikm = sk.derive_new_secret_key(&obj.owner_pk).to_bytes();
    let aead = ikm_aead(&ikm, b"pickup-wrap").await?;
    let payload: GdrivePickup =
        bincode::deserialize(&aead_open(&aead, &doc_id, &obj.sealed).await?)
            .map_err(|e| format!("pickup payload decode: {e}"))?;
    let mut keychain: Vec<(u32, [u8; 32])> = payload.name_keys.clone();
    keychain.sort_by_key(|(e, _)| *e);
    if keychain.is_empty() {
        return Err("pickup carried no name-key keychain".to_string());
    }
    let name_keys: HashMap<u32, [u8; 32]> = keychain.iter().copied().collect();

    // Adopt the shared keychain BEFORE resolving any folder — the same
    // reason `s3_pull` adopts it before touching a name. This instance's
    // own keychain was minted locally at `ensure_bucket_state` and is
    // nobody else's; flushing or reading under it would address names no
    // other device can derive.
    with_state(|s| {
        let b = s.buckets.get_mut(&doc_id).expect("bucket state");
        b.name_keys = keychain.iter().map(|(_, nk)| *nk).collect();
    })?;

    let folder = gd_doc_folder(&cfg, &doc_id).await?;
    let src = GdSource::Owner(folder);
    let devices = payload.devices.clone();

    // 2. Op streams into keyhive (newest epoch first: a device's oplog
    //    lives under the newest name-key it flushed with — S3's rule,
    //    kept identical even though this provider does not currently
    //    rotate, so the two cannot drift).
    let mut ingested = 0usize;
    for device in &devices {
        for (_, nk) in keychain.iter().rev() {
            let child = gd_child(nk, "oplog", device).await?;
            if let Some(blob) = gd_fetch_child(&cfg, &EngineFetch, &src, &child).await? {
                let events: Vec<StaticEvent<T>> =
                    bincode::deserialize(&blob).map_err(|e| format!("oplog decode: {e}"))?;
                ingested += events.len();
                kh.ingest_unsorted_static_events(events).await;
                break;
            }
        }
    }

    // 3. Manifests -> union of entries.
    let mut entries: Vec<Entry> = Vec::new();
    for device in &devices {
        for (_, nk) in keychain.iter().rev() {
            let child = gd_child(nk, "manifest", device).await?;
            let Some(blob) = gd_fetch_child(&cfg, &EngineFetch, &src, &child).await? else {
                continue;
            };
            let manifest = verify_manifest(&blob, device).await?;
            for e in manifest.entries {
                if !entries.iter().any(|(c, _, _)| *c == e.0) {
                    entries.push(e);
                }
            }
            break;
        }
    }
    adopt_entries(&doc_id, &entries)?;

    // 4. Chunks -> the sedimentree (envelope bytes verbatim), then the
    // normal apply path.
    let have: HashSet<[u8; 32]> = sd
        .get_commits(tree)
        .await
        .unwrap_or_default()
        .iter()
        .map(|c| *c.head().as_bytes())
        .collect();
    let mut fetched = 0u32;
    for (cref, parents, epoch) in &entries {
        if have.contains(cref) {
            continue;
        }
        let nk = name_keys
            .get(epoch)
            .ok_or(format!("keychain missing epoch {epoch}"))?;
        let child = gd_child(nk, "chunk", cref).await?;
        let blob = gd_fetch_child(&cfg, &EngineFetch, &src, &child)
            .await?
            .ok_or("chunk object missing")?;
        let parent_set: BTreeSet<CommitId> = parents.iter().map(|p| CommitId::new(*p)).collect();
        sd.add_commit(tree, CommitId::new(*cref), parent_set, Blob::new(blob))
            .await
            .map_err(|e| format!("add_commit: {e:?}"))?;
        fetched += 1;
    }
    if with_state(|s| s.partitions.contains_key(&doc_id))? {
        apply_new_chunks(&doc_id).await?;
    }
    Ok(format!(
        "pulled gdrive(owner) epochs={} devices={} events={ingested} chunks={fetched}",
        keychain.len(),
        devices.len()
    ))
}

/// The S3 pull: K_p at the derivable location, unwrapped by prekey
/// DH, yields the name-key keychain and the device set; everything
/// after that rides name-keyed unsigned GETs.
async fn s3_pull(doc_id: Vec<u8>, owner: Vec<u8>) -> Result<String, String> {
    let st = store()?;
    let (kh, sd) = with_state(|s| (s.kh.clone(), s.sd.clone()))?;
    let my_id = with_state(|s| s.my_peer.as_bytes().to_vec())?;
    let tree = tree_id(&doc_id)?;

    // 1. K_p: locate by ids, unwrap by prekey DH.
    let loc = kp_location(&doc_id, &owner, &my_id).await?;
    let blob = get_object_unsigned(&st, &EngineFetch, &loc)
        .await?
        .ok_or("kp missing (404): revoked or never granted")?;
    let obj: KpObject = bincode::deserialize(&blob).map_err(|e| format!("kp decode: {e}"))?;
    let pairs = my_prekey_pairs(&kh).await?;
    let sk = pairs
        .get(&obj.member_pk)
        .ok_or("K_p not sealed to any of my prekeys")?;
    let ikm = sk.derive_new_secret_key(&obj.owner_pk).to_bytes();
    let aead = ikm_aead(&ikm, b"kp-wrap").await?;
    let payload: KpPayload =
        bincode::deserialize(&aead_open(&aead, &doc_id, &obj.sealed).await?)
            .map_err(|e| format!("kp payload decode: {e}"))?;
    let mut keychain: Vec<(u32, [u8; 32])> = payload.name_keys.clone();
    keychain.sort_by_key(|(e, _)| *e);
    let name_keys: HashMap<u32, [u8; 32]> = keychain.iter().copied().collect();

    // Adopt the shared keychain: any flush from this instance must
    // place objects under the DOC's name-keys (a privately minted
    // keychain would publish to names nobody else can derive).
    ensure_bucket_state(&doc_id)?;
    with_state(|s| {
        let b = s.buckets.get_mut(&doc_id).expect("bucket state");
        b.name_keys = keychain.iter().map(|(_, nk)| *nk).collect();
    })?;

    // 2. Op streams (newest epoch first; a device's oplog lives under
    // the newest name-key it flushed with).
    let mut ingested = 0usize;
    for device in &payload.devices {
        for (_, nk) in keychain.iter().rev() {
            let name = object_name(nk, b"oplog", device).await?;
            if let Some(blob) = get_object_unsigned(&st, &EngineFetch, &name).await? {
                let events: Vec<StaticEvent<T>> =
                    bincode::deserialize(&blob).map_err(|e| format!("oplog decode: {e}"))?;
                ingested += events.len();
                kh.ingest_unsorted_static_events(events).await;
                break;
            }
        }
    }

    // 3. Manifests -> union of entries.
    let mut entries: Vec<([u8; 32], Vec<[u8; 32]>, u32)> = Vec::new();
    for device in &payload.devices {
        for (_, nk) in keychain.iter().rev() {
            let name = object_name(nk, b"manifest", device).await?;
            let Some(blob) = get_object_unsigned(&st, &EngineFetch, &name).await? else {
                continue;
            };
            let signed: SignedManifest =
                bincode::deserialize(&blob).map_err(|e| format!("manifest decode: {e}"))?;
            let vk = ed25519::import_verifying_key_raw(device.to_vec())
                .await
                .map_err(|e| format!("vk import: {e}"))?;
            vk.verify(signed.manifest.as_slice(), signed.sig.as_slice())
                .await
                .map_err(|_| "manifest signature invalid".to_string())?;
            let manifest: BucketManifest =
                bincode::deserialize(&signed.manifest).map_err(|e| e.to_string())?;
            for e in manifest.entries {
                if !entries.iter().any(|(c, _, _)| *c == e.0) {
                    entries.push(e);
                }
            }
            break;
        }
    }

    // Objects already in the bucket are flushed state: record them so
    // a later flush from this instance uploads only genuinely new
    // chunks (and its manifest carries the full known set).
    with_state(|s| {
        let b = s.buckets.get_mut(&doc_id).expect("bucket state");
        for (cref, parents, epoch) in &entries {
            if !b.flushed.contains_key(cref) {
                b.flushed.insert(*cref, *epoch);
                b.entries.push((*cref, parents.clone(), *epoch));
            }
        }
    })?;

    // 4. Chunks -> the sedimentree (envelope bytes verbatim), then the
    // normal apply path.
    let have: HashSet<[u8; 32]> = sd
        .get_commits(tree)
        .await
        .unwrap_or_default()
        .iter()
        .map(|c| *c.head().as_bytes())
        .collect();
    let mut fetched = 0u32;
    for (cref, parents, epoch) in &entries {
        if have.contains(cref) {
            continue;
        }
        let nk = name_keys
            .get(epoch)
            .ok_or(format!("keychain missing epoch {epoch}"))?;
        let name = object_name(nk, b"chunk", cref).await?;
        let blob = get_object_unsigned(&st, &EngineFetch, &name)
            .await?
            .ok_or(format!("chunk object missing for epoch {epoch}"))?;
        let parent_set: BTreeSet<CommitId> =
            parents.iter().map(|p| CommitId::new(*p)).collect();
        sd.add_commit(tree, CommitId::new(*cref), parent_set, Blob::new(blob))
            .await
            .map_err(|e| format!("add_commit: {e:?}"))?;
        fetched += 1;
    }
    if with_state(|s| s.partitions.contains_key(&doc_id))? {
        apply_new_chunks(&doc_id).await?;
    }
    Ok(format!(
        "pulled kp epochs={} events={ingested} chunks={fetched}",
        keychain.len()
    ))
}

// --- the DAG content spine ---

/// The plaintext this engine seals: the chunk, plus the keys of the
/// chunk's parents (PAIRING.md §4b).
///
/// `Envelope` is keyhive's own type; there is no envelope-aware encrypt
/// API at the pinned rev, so the embedder serializes it and hands the
/// bytes to `try_encrypt_content` — which is exactly the shape
/// `try_causal_decrypt` expects to find on the way back.
type ChunkEnvelope = Envelope<[u8; 32], Vec<u8>>;

/// Encrypt one automerge change under the doc's current epoch and commit
/// its envelope to the sedimentree with the change's deps as parents. Any
/// CGKA update the encryption produced is synced over the bridge.
///
/// The sealed plaintext carries the parents' content keys, which is what
/// lets a device that arrives later read backwards from anything it can
/// read forwards. Consequence worth stating plainly: possession of one
/// chunk key transitively grants the whole ancestry behind it, so the
/// read-back window is a POLICY question, not an accident of the format.
/// It is total here by intent (the user's own devices, §4b); the chain-cut
/// policy for shared partitions is a #36/#9 decision-memo item.
async fn encrypt_and_commit(
    id: &[u8],
    chunk: Vec<u8>,
    preds: Vec<[u8; 32]>,
    cref: [u8; 32],
) -> Result<(), String> {
    let (kh, sd, proto, ciphertexts) = with_state(|s| {
        (
            s.kh.clone(),
            s.sd.clone(),
            s.proto.clone(),
            s.ciphertexts.clone(),
        )
    })?;
    let did = kh_doc_id(id)?;
    let doc = kh
        .get_document(did)
        .await
        .ok_or("keyhive doc not found".to_string())?;

    // The writer holds its parents' keys by construction: a change's deps
    // are chunks it has already materialized, and every path to
    // materialization records the key.
    let mut ancestors: std::collections::HashMap<[u8; 32], SymmetricKey> =
        std::collections::HashMap::new();
    let missing: Vec<[u8; 32]> = with_state(|s| {
        let mut missing = Vec::new();
        for parent in &preds {
            match s.chunk_keys.get(parent) {
                Some(key) => {
                    ancestors.insert(*parent, *key);
                }
                None => missing.push(*parent),
            }
        }
        missing
    })?;
    if !missing.is_empty() {
        // Authoring on a parent whose key we do not hold would mint a
        // chunk nobody can walk past. It should be unreachable — authoring
        // merges first — so it is an error, not a silent omission.
        return Err(format!(
            "cannot seal: {} parent chunk key(s) unknown; authoring on \
             unmaterialized history would cut the causal chain",
            missing.len()
        ));
    }

    let plaintext = bincode::serialize(&ChunkEnvelope {
        plaintext: chunk,
        ancestors,
    })
    .map_err(|e| format!("envelope serialize: {e}"))?;

    let (out, key) = kh
        .try_encrypt_content_keyed(doc, &cref, &preds, &plaintext)
        .await
        .map_err(|e| format!("encrypt: {e:?}"))?;
    let envelope =
        bincode::serialize(out.encrypted_content()).map_err(|e| format!("serialize: {e}"))?;
    let had_update = out.update_op().is_some();

    // Remember our own chunk's key (our successors will name it), and put
    // the ciphertext where the walk looks for ancestors.
    with_state(|s| s.chunk_keys.insert(cref, key))?;
    ciphertexts
        .insert(Arc::new(out.encrypted_content().clone()))
        .await;

    let tree = tree_id(id)?;
    let parents: BTreeSet<CommitId> = preds.into_iter().map(CommitId::new).collect();
    sd.add_commit(tree, CommitId::new(cref), parents, Blob::new(envelope))
        .await
        .map_err(|e| format!("add_commit: {e:?}"))?;
    if had_update {
        refreshed_sync(&proto, None).await?;
    }
    breathe().await;
    Ok(())
}

/// Causal order: parents before children, ties by head bytes.
fn causal_order(mut commits: Vec<LooseCommit>) -> Vec<LooseCommit> {
    let mut done: HashSet<CommitId> = HashSet::new();
    let mut out = Vec::new();
    while !commits.is_empty() {
        let mut ready: Vec<LooseCommit> = Vec::new();
        let mut rest: Vec<LooseCommit> = Vec::new();
        for c in commits {
            if c.parents().iter().all(|p| done.contains(p)) {
                ready.push(c);
            } else {
                rest.push(c);
            }
        }
        if ready.is_empty() {
            rest.sort_by_key(|c| *c.head().as_bytes());
            out.extend(rest);
            break;
        }
        ready.sort_by_key(|c| *c.head().as_bytes());
        for c in ready {
            done.insert(c.head());
            out.push(c);
        }
        commits = rest;
    }
    out
}

/// Apply every newly synced chunk this replica can reach, in causal
/// order.
///
/// Two ways to reach one (PAIRING.md §4b):
///
/// - **direct** — the chunk's epoch is one this device holds;
/// - **causal walk** — the chunk predates this device's membership, so
///   its epoch is dark, but a readable DESCENDANT carries its key inside
///   its own plaintext. `try_causal_decrypt_content` walks that chain.
///
/// The walk is only attempted when a direct decrypt has failed AND some
/// chunk was readable, because the walk needs an entrypoint. Arrival
/// order therefore matters: until a readable descendant exists, dark
/// chunks stay counted and unapplied, and are retried on the next poll.
/// Enrollment guarantees the entrypoint (the devices-entry write is
/// sealed under a post-add epoch — the walk anchor, §2).
async fn apply_new_chunks(id: &[u8]) -> Result<(), String> {
    breathe().await;
    let (kh, sd, storage, ciphertexts) = with_state(|s| {
        (
            s.kh.clone(),
            s.sd.clone(),
            s.sd_storage.clone(),
            s.ciphertexts.clone(),
        )
    })?;
    let tree = tree_id(id)?;
    let did = kh_doc_id(id)?;

    let commits = causal_order(sd.get_commits(tree).await.unwrap_or_default());
    let already = with_state(|s| {
        s.partitions
            .get(id)
            .map(|p| p.applied.clone())
            .ok_or("unknown partition".to_string())
    })??;
    if commits.iter().all(|c| already.contains(c.head().as_bytes())) {
        return Ok(());
    }

    let Some(kh_doc) = kh.get_document(did).await else {
        // Commits are here but keyhive hasn't learned the doc yet: not an
        // error, just not-synced-yet. Ask the bridge to try again.
        eprintln!("[apply] commits waiting, keyhive doc unknown; nudging");
        nudge_keyhive_sync().await;
        return Ok(());
    };

    // Load every chunk's ciphertext once. The walk resolves ancestors
    // through keyhive's ciphertext store, and keyhive EVICTS entries it
    // has decrypted (`mark_decrypted` removes), so the store is refilled
    // from the sedimentree — which stays the authoritative copy — rather
    // than treated as durable.
    let mut envelopes: Vec<([u8; 32], EncryptedContent<P, T>)> = Vec::new();
    for commit in &commits {
        let verified =
            <MemoryStorage as Storage<Local>>::load_loose_commit(&storage, tree, commit.head())
                .await
                .map_err(|e| format!("load: {e:?}"))?
                .ok_or("commit blob not found")?;
        let encrypted: EncryptedContent<P, T> = bincode::deserialize(verified.blob().as_slice())
            .map_err(|e| format!("bad envelope: {e}"))?;
        envelopes.push((*commit.head().as_bytes(), encrypted));
    }

    // Pass 1: direct decryption.
    let mut recovered: HashMap<[u8; 32], Vec<u8>> = HashMap::new();
    let mut keys: Vec<([u8; 32], SymmetricKey)> = Vec::new();
    let mut entrypoints: Vec<EncryptedContent<P, T>> = Vec::new();
    let mut dark = 0u32;
    let mut walked_now: HashSet<[u8; 32]> = HashSet::new();
    for (cref, encrypted) in &envelopes {
        if already.contains(cref) {
            // Applied already; it may still serve as a walk entrypoint,
            // but only if THIS device can open it directly. A chunk that
            // was itself recovered by a walk cannot start one.
            continue;
        }
        match kh.try_decrypt_content_keyed(kh_doc.clone(), encrypted).await {
            Ok((plain, key)) => {
                let envelope: ChunkEnvelope = bincode::deserialize(&plain)
                    .map_err(|e| format!("chunk envelope decode: {e}"))?;
                keys.push((*cref, key));
                // The ancestor keys travel with the chunk: record them so
                // this device can both walk backwards and, later, name
                // them as parents of its own writes.
                for (ancestor, ancestor_key) in &envelope.ancestors {
                    keys.push((*ancestor, *ancestor_key));
                }
                recovered.insert(*cref, envelope.plaintext);
                entrypoints.push(encrypted.clone());
            }
            Err(_) => dark += 1,
        }
    }

    // Pass 2: the causal walk, from anything readable, for anything not.
    if dark > 0 {
        // Widen the entrypoint set to already-applied chunks this device
        // can still open directly — after a restart or a late sync the
        // only readable chunk may be one applied several polls ago.
        for (cref, encrypted) in &envelopes {
            if !already.contains(cref) {
                continue;
            }
            if kh
                .try_decrypt_content_keyed(kh_doc.clone(), encrypted)
                .await
                .is_ok()
            {
                entrypoints.push(encrypted.clone());
            }
        }
    }
    if dark > 0 && !entrypoints.is_empty() {
        for (_, encrypted) in &envelopes {
            ciphertexts.insert(Arc::new(encrypted.clone())).await;
        }
        for entry in &entrypoints {
            let walked = match kh.try_causal_decrypt_content(kh_doc.clone(), entry).await {
                Ok(state) => state,
                // A partial walk still yields progress; take it and move
                // on rather than discarding what was reached.
                Err(e) => match e {
                    keyhive_core::principal::document::DocCausalDecryptionError::CausalDecryptionError(inner) => inner.progress,
                    other => {
                        eprintln!("[walk] {other}");
                        continue;
                    }
                },
            };
            for (cref, plaintext) in walked.complete {
                // Keys are recorded only for chunks that actually opened.
                // `CausalDecryptionState::keys` also holds keys for
                // ciphertexts whose decrypt FAILED (keyhive records the
                // key before attempting), and storing those would let a
                // later seal name a parent key that does not open it.
                if let Some(key) = walked.keys.get(&cref) {
                    keys.push((cref, *key));
                }
                if already.contains(&cref) || recovered.contains_key(&cref) {
                    continue;
                }
                walked_now.insert(cref);
                recovered.insert(cref, plaintext);
            }
            // `next` is sound and worth keeping: these keys came out of a
            // successfully decrypted envelope's ancestor map, for chunks
            // this device does not hold YET. Recording them saves the hop
            // when the chunk arrives.
            for (cref, key) in walked.next.iter() {
                keys.push((*cref, *key));
            }
        }
        // Everything the walk resolved is now applied below, so recount
        // what genuinely remains out of reach.
        dark = envelopes
            .iter()
            .filter(|(cref, _)| !already.contains(cref) && !recovered.contains_key(cref))
            .count() as u32;
        if dark > 0 {
            eprintln!("[walk] {dark} chunk(s) still unreachable after the walk");
        }
    }

    with_state(|s| s.chunk_keys.extend(keys))?;

    // Apply in causal order: automerge buffers changes whose deps are
    // missing, so order is what turns decryption into materialization.
    let mut changes: Vec<Change> = Vec::new();
    let mut applied_now: Vec<[u8; 32]> = Vec::new();
    for commit in &commits {
        let cref = *commit.head().as_bytes();
        if already.contains(&cref) {
            continue;
        }
        if let Some(bytes) = recovered.remove(&cref) {
            changes.push(Change::from_bytes(bytes).map_err(|e| format!("bad change: {e}"))?);
            applied_now.push(cref);
        }
    }

    with_state(|s| -> Result<(), String> {
        let p = s.partitions.get_mut(id).ok_or("unknown partition")?;
        if !changes.is_empty() {
            let n = changes.len() as u64;
            p.am.apply_changes(changes)
                .map_err(|e| format!("apply: {e}"))?;
            p.applied.extend(applied_now.iter().copied());
            p.revision += n;
            // Envelopes opened, whether or not automerge could then
            // materialize them (missing deps buffer silently).
            p.decrypted += n as u32;
            p.walked += applied_now
                .iter()
                .filter(|cref| walked_now.contains(*cref))
                .count() as u32;
        }
        p.undecryptable = dark;
        Ok(())
    })??;
    if dark > 0 {
        // Waiting on epoch material (e.g. a post-revocation rotation op):
        // ask the bridge to try again.
        nudge_keyhive_sync().await;
    }
    Ok(())
}

/// Merge remote changes, run one mutation as a single automerge change,
/// seal it, and commit it to the DAG.
async fn author<R>(
    id: &[u8],
    mutate: impl FnOnce(&mut AutoCommit) -> Result<R, String>,
) -> Result<R, String> {
    apply_new_chunks(id).await?;
    let (result, chunk, cref, deps) = with_state(|s| -> Result<_, String> {
        let p = s.partitions.get_mut(id).ok_or("unknown partition")?;
        let result = mutate(&mut p.am)?;
        p.am.commit();
        let change = p
            .am
            .get_last_local_change()
            .ok_or("mutation produced no change")?;
        let cref = change.hash().0;
        let deps: Vec<[u8; 32]> = change.deps().iter().map(|h| h.0).collect();
        let chunk = change.raw_bytes().to_vec();
        p.applied.insert(cref);
        p.revision += 1;
        Ok((result, chunk, cref, deps))
    })??;
    encrypt_and_commit(id, chunk, deps, cref).await?;
    Ok(result)
}

fn active_partition() -> Result<Vec<u8>, String> {
    with_state(|s| s.active.clone())?.ok_or("no partition bound (seal or adopt first)".into())
}

// --- keyhive operations shared by the driver surface and the pairing /
// --- user-system modules. The driver methods below delegate here so the
// --- ceremony performs exactly the same writes a host call would.

fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn own_agent_id() -> Result<Vec<u8>, String> {
    with_state(|s| s.my_peer.as_bytes().to_vec())
}

/// Refresh the bridge's event cache and offer everything to every peer.
async fn flush_keyhive() -> Result<(), String> {
    let proto = with_state(|s| s.proto.clone())?;
    refreshed_sync(&proto, None).await
}

async fn contact_card_bytes() -> Result<Vec<u8>, String> {
    let kh = with_state(|s| s.kh.clone())?;
    let card = kh
        .contact_card()
        .await
        .map_err(|e| format!("contact card: {e:?}"))?;
    bincode::serialize(&card).map_err(|e| e.to_string())
}

/// Ingest a contact card and return the individual it materializes. The
/// id comes from the card itself, which is signed — the sender does not
/// get to name a different principal than the one it proves it holds.
async fn ingest_contact_card(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let card: ContactCard = bincode::deserialize(&bytes).map_err(|e| format!("bad card: {e}"))?;
    let id = card.id().to_bytes().to_vec();
    kh.receive_contact_card(&card)
        .await
        .map_err(|e| format!("receive contact card: {e:?}"))?;
    refreshed_sync(&proto, None).await?;
    Ok(id)
}

/// Keyhive's own op accounting, by kind. Used to measure whether an
/// authoritative event set actually delivers anything this instance did
/// not already hold.
///
/// This replaced a hand-rolled digest diff, which was NOT a sound
/// measurement: it hashed locally-reconstructed `StaticEvent`s, and those
/// digests are not stable across two instances' constructions, so it
/// reported "everything missing" for an instance that demonstrably held
/// the ops. Counting through keyhive's own stats avoids inventing an
/// identity scheme that the library does not use.
async fn op_stats(kh: &Kh) -> (u64, u64, u64, u64, u64) {
    let s = kh.stats().await;
    (
        s.delegations,
        s.revocations,
        s.prekeys_expanded,
        s.prekey_rotations,
        s.cgka_operations,
    )
}

fn report_delta(label: &str, before: (u64, u64, u64, u64, u64), after: (u64, u64, u64, u64, u64), offered: usize) {
    let names = [
        "delegations",
        "revocations",
        "prekeys-expanded",
        "prekey-rotations",
        "cgka-operations",
    ];
    let deltas = [
        after.0 as i64 - before.0 as i64,
        after.1 as i64 - before.1 as i64,
        after.2 as i64 - before.2 as i64,
        after.3 as i64 - before.3 as i64,
        after.4 as i64 - before.4 as i64,
    ];
    let shape: Vec<String> = (0..5)
        .filter(|i| deltas[*i] != 0)
        .map(|i| format!("{}+{}", names[i], deltas[i]))
        .collect();
    let total: i64 = deltas.iter().sum();
    eprintln!(
        "[eventdiff] {label}: {} event(s) offered by the founder; ops NEW to this \
         instance: {} [{}]",
        offered,
        total,
        if shape.is_empty() {
            "none — the instance already held the authoritative set".to_string()
        } else {
            shape.join(" ")
        }
    );
}

async fn ingest_static_card(bytes: Vec<u8>) -> Result<u32, String> {
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let events: Vec<StaticEvent<T>> =
        bincode::deserialize(&bytes).map_err(|e| format!("bad card: {e}"))?;
    let diagnose = std::env::var("PM_EVENT_DIFF").is_ok();
    let offered = events.len();
    let before = if diagnose {
        Some(op_stats(&kh).await)
    } else {
        None
    };
    let pending = kh.ingest_unsorted_static_events(events).await;
    if let Some(before) = before {
        report_delta("ingest-card", before, op_stats(&kh).await, offered);
        eprintln!("[eventdiff]   pending-after-ingest={}", pending.len());
    }
    refreshed_sync(&proto, None).await?;
    Ok(pending.len() as u32)
}

async fn export_static_card(agent_id: &[u8]) -> Result<Vec<u8>, String> {
    let kh = with_state(|s| s.kh.clone())?;
    if std::env::var("PM_EVENT_DIFF").is_ok() {
        // What would the BRIDGE offer this peer, versus what keyhive says
        // is reachable to it? The two should agree; a gap here is the
        // engine's, not keyhive's.
        let proto = with_state(|s| s.proto.clone())?;
        let peer = KeyhivePeerId::from_bytes(arr32(agent_id, "agent id")?);
        let offerable = proto
            .get_events_for_agent(&peer)
            .await
            .ok()
            .flatten()
            .map(|m| m.len());
        let me = KeyhivePeerId::from_bytes(arr32(&own_agent_id()?, "own id")?);
        let mine = proto
            .get_events_for_agent(&me)
            .await
            .ok()
            .flatten()
            .map(|m| m.len());
        eprintln!(
            "[bridge] reachable-to-peer({})={:?} reachable-to-self={:?}",
            &hex::encode(agent_id)[..8],
            offerable,
            mine
        );
    }
    let agent = kh
        .get_agent(identifier(agent_id)?)
        .await
        .ok_or("agent not found".to_string())?;
    let events: Vec<StaticEvent<T>> = kh
        .static_events_for_agent(&agent)
        .await
        .into_values()
        .collect();
    bincode::serialize(&events).map_err(|e| format!("serialize card: {e}"))
}

async fn create_user_group() -> Result<Vec<u8>, String> {
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let group = kh
        .generate_group(vec![])
        .await
        .map_err(|e| format!("generate group: {e:?}"))?;
    let id = { group.lock().await.group_id().to_bytes().to_vec() };
    refreshed_sync(&proto, None).await?;
    Ok(id)
}

async fn add_to_group(group_id: &[u8], member: &[u8], level: &str) -> Result<(), String> {
    let access = parse_access(level)?;
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let gid = GroupId::new(identifier(group_id)?);
    let group = kh
        .get_group(gid)
        .await
        .ok_or("group not found".to_string())?;
    let agent = kh
        .get_agent(identifier(member)?)
        .await
        .ok_or("member agent not found (no card yet)".to_string())?;
    kh.add_member(agent, &Membered::Group(gid, group), access, &[])
        .await
        .map_err(|e| format!("add to group: {e:?}"))?;
    refreshed_sync(&proto, None).await?;
    Ok(())
}

async fn revoke_from_group(group_id: &[u8], member: &[u8]) -> Result<(), String> {
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let gid = GroupId::new(identifier(group_id)?);
    let group = kh
        .get_group(gid)
        .await
        .ok_or("group not found".to_string())?;
    kh.revoke_member(identifier(member)?, true, &Membered::Group(gid, group))
        .await
        .map_err(|e| format!("revoke from group: {e:?}"))?;
    refreshed_sync(&proto, None).await?;
    Ok(())
}

async fn add_doc_member(doc_id: &[u8], agent_id: &[u8], level: &str) -> Result<(), String> {
    let access = parse_access(level)?;
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let did = kh_doc_id(doc_id)?;
    let agent = kh
        .get_agent(identifier(agent_id)?)
        .await
        .ok_or("agent not found (bridge has not synced its card yet)".to_string())?;
    let doc = kh
        .get_document(did)
        .await
        .ok_or("doc not found".to_string())?;
    kh.add_member(agent, &Membered::Document(did, doc), access, &[])
        .await
        .map_err(|e| format!("add member: {e:?}"))?;
    refreshed_sync(&proto, None).await?;
    Ok(())
}

/// Force a fresh epoch on every doc delegated to `group`.
///
/// The enrollment counterpart of the revocation rotation: a deliberate
/// epoch boundary at the moment a device joins.
///
/// It is NOT required for the new member to read post-join content —
/// keyhive's `add_member` already propagates the CGKA add to every doc
/// that transitively contains the group, and the measurement behind the
/// README finding shows post-join content readable with this switched
/// off. Kept per PAIRING.md §2 as defence in depth. Every op this
/// produces goes out through
/// `refreshed_sync`, because the bridge serves peers from a cache that
/// upstream refreshes on a timer we do not run (the G4 finding: a
/// rotation created locally and never refreshed is silently never
/// offered, and the peer waits on epoch material forever).
async fn rotate_docs_for_group(group_id: &[u8]) -> Result<(), String> {
    let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
    let group_identifier = identifier(group_id)?;
    let docs: Vec<_> = kh.reachable_docs().await.into_values().collect();
    let mut rotated = 0u32;
    for ability in docs {
        let doc = ability.doc().clone();
        let contains_group = {
            let locked = doc.lock().await;
            locked
                .transitive_members()
                .await
                .contains_key(&group_identifier)
        };
        if !contains_group {
            continue;
        }
        kh.force_pcs_update(doc)
            .await
            .map_err(|e| format!("forced epoch rotation: {e:?}"))?;
        rotated += 1;
    }
    if rotated > 0 {
        refreshed_sync(&proto, None).await?;
    }
    Ok(())
}

/// Peers this instance has completed a subduction handshake with.
fn known_peers() -> Result<Vec<Vec<u8>>, String> {
    with_state(|s| {
        s.conn_results
            .values()
            .filter_map(|r| r.as_ref().ok())
            .filter_map(|hex_peer| hex::decode(hex_peer).ok())
            .collect()
    })
}

/// Subscribe to a tree with one peer, fire-and-forget.
///
/// Engine-driven on purpose: the user-system surface hides doc identity
/// (PAIRING.md §4), so the host has no name for the tree to subscribe
/// to.
fn subscribe_tree(peer: Vec<u8>, tree: Vec<u8>) -> Result<(), String> {
    let peer = PeerId::new(arr32(&peer, "peer")?);
    let tree = tree_id(&tree)?;
    let sd = with_state(|s| s.sd.clone())?;
    wit_bindgen::spawn_local(async move {
        if let Err(e) = sd
            .sync_with_peer(&peer, tree, true, CallTimeout::Default)
            .await
        {
            eprintln!("[us subscribe] {e:?}");
        }
    });
    Ok(())
}

/// Mint a keyhive doc whose first content head is `cref`. Held unsealed:
/// the caller adds members before the first encryption, because BeeKEM
/// adds are not retroactive.
async fn create_doc_for(cref: [u8; 32]) -> Result<Vec<u8>, String> {
    let kh = with_state(|s| s.kh.clone())?;
    let doc = kh
        .generate_doc(vec![], nonempty::nonempty![cref])
        .await
        .map_err(|e| format!("generate doc: {e:?}"))?;
    let id = { doc.lock().await.doc_id().as_slice().to_vec() };
    Ok(id)
}

fn todos_object(am: &AutoCommit) -> Result<automerge::ObjId, String> {
    match am.get(ROOT, "todos").map_err(|e| format!("get todos: {e}"))? {
        Some((Value::Object(ObjType::Map), id)) => Ok(id),
        _ => Err("no todos map (creation chunk not applied)".into()),
    }
}

fn read_snapshot(am: &AutoCommit) -> Result<Vec<TodoItem>, String> {
    // No todos map yet: an adopted partition whose creation chunk has not
    // arrived (or not become decryptable) is an empty list at revision 0.
    let Ok(todos) = todos_object(am) else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for key in am.keys(&todos) {
        let Some((Value::Object(_), item)) =
            am.get(&todos, &key).map_err(|e| format!("get item: {e}"))?
        else {
            continue;
        };
        let title = match am.get(&item, "title").map_err(|e| e.to_string())? {
            Some((Value::Scalar(s), _)) => match s.into_owned() {
                ScalarValue::Str(t) => t.to_string(),
                other => format!("{other:?}"),
            },
            _ => String::new(),
        };
        let completed = matches!(
            am.get(&item, "completed").map_err(|e| e.to_string())?,
            Some((Value::Scalar(s), _)) if matches!(s.as_ref(), ScalarValue::Boolean(true))
        );
        items.push(TodoItem {
            id: key.to_string(),
            title,
            completed,
        });
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}

/// Assemble instance state around an identity + keyhive (fresh from
/// `init` or restored from a bundle by `identity-import`).
fn finish_init(
    signer: WebcryptoSigner,
    verifying: DalekVerifyingKey,
    kh: Kh,
    ciphertexts: KhStore,
) -> Result<(), String> {
    let my_peer = PeerId::from(verifying);
    #[allow(clippy::arc_with_non_send_sync)] // upstream APIs take Arc; single-threaded wasm
    let shared_kh = Arc::new(async_lock::Mutex::new(kh.clone()));
    let proto: Rc<KhProto> = Rc::new(KeyhiveProtocol::new(
        shared_kh,
        MemoryKeyhiveStorage::new(),
        KeyhivePeerId::from_bytes(verifying.to_bytes()),
        // Placeholder card slot: the protocol wants OUR contact card to
        // answer card requests; minted lazily below.
        CARD.with(|c| c.borrow().clone().expect("card set before finish_init")),
    ));

    let sd_storage = MemoryStorage::new();
    #[allow(clippy::arc_with_non_send_sync)] // upstream APIs take Arc; single-threaded wasm
    let policy = Arc::new(SubductionKeyhive::new(kh.clone()));
    let (sd, _handler, listener, manager) = SubductionBuilder::new()
        .signer(signer.clone())
        .storage(sd_storage.clone(), policy)
        .spawner(WitSpawn)
        .timer(NeverTimeout)
        .build::<Local, Conn>();
    wit_bindgen::spawn_local(async move {
        let _ = listener.await;
    });
    wit_bindgen::spawn_local(async move {
        let _ = manager.await;
    });

    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            kh,
            ciphertexts,
            chunk_keys: HashMap::new(),
            sd,
            sd_storage,
            signer,
            my_peer,
            nonce_cache: Rc::new(NonceCache::default()),
            proto,
            conn_results: HashMap::new(),
            syncs: HashMap::new(),
            endpoint: None,
            relay_url: None,
            iroh_identity: None,
            iroh_conns: HashMap::new(),
            partitions: HashMap::new(),
            pending: HashMap::new(),
            active: None,
            kh_nudge: 0,
            store: None,
            buckets: HashMap::new(),
            gd_folders: HashMap::new(),
            pair: pairing::PairState::default(),
            us: usdoc::UsDoc::default(),
            fetches: 0,
            next_id: 0,
        })
    });
    Ok(())
}

thread_local! {
    /// Our contact card, staged for `finish_init`.
    static CARD: RefCell<Option<keyhive_core::contact_card::ContactCard>> =
        const { RefCell::new(None) };
}

// --- the exported driver ---

struct Component;

impl DriverGuest for Component {
    async fn init(exportable_identity: bool) -> Result<String, String> {
        let (key, verifying) = if exportable_identity {
            // G5 demo-grade posture: a soft in-guest key the identity
            // bundle can carry. UNCHANGED, in every respect: the seed
            // posture never consults `device-identity` (engine.wit).
            let sk = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
            let vk = sk.verifying_key();
            (IdentityKey::Soft(Box::new(sk)), vk)
        } else if let Some(handed) = embedder_device_key().await? {
            // Platform posture, and this embedding persists a device
            // identity: ADOPT it rather than minting. Everything
            // downstream is identical to the minted path — the agent id
            // comes from the handed verifying key exactly as it would
            // from a freshly minted one — which is what makes the second
            // boot the SAME device (engine.wit `device-identity`).
            handed
        } else {
            // Platform posture, no persistence granted: mint through the
            // port. The behavior of every embedding that predates the
            // `device-identity` import.
            let options = SigningKeyOptions {
                sign: true,
                extractable: false,
            };
            let (key, vk) = ed25519::generate_key(options)
                .await
                .map_err(|e| format!("webcrypto generate-key: {e}"))?;
            let vk_raw = vk
                .export_key_raw()
                .await
                .map_err(|e| format!("webcrypto export verifying key: {e}"))?;
            let verifying = DalekVerifyingKey::from_bytes(&arr32(&vk_raw, "verifying key")?)
                .map_err(|e| format!("parse verifying key: {e:?}"))?;
            (IdentityKey::Platform(key), verifying)
        };
        let signer = WebcryptoSigner(Rc::new(SignerInner {
            key,
            verifying,
            sign_count: Cell::new(0),
        }));

        let ciphertexts: KhStore = MemoryCiphertextStore::new();
        let kh = Kh::generate(
            signer.clone(),
            ciphertexts.clone(),
            NoListener,
            rand::rngs::OsRng,
        )
        .await
        .map_err(|e| format!("keyhive generate: {e:?}"))?;

        let card = kh
            .contact_card()
            .await
            .map_err(|e| format!("contact card: {e:?}"))?;
        CARD.with(|c| *c.borrow_mut() = Some(card));
        finish_init(signer, verifying, kh, ciphertexts)?;
        Ok(hex::encode(verifying.to_bytes()))
    }

    async fn kh_knows_agent(agent: Vec<u8>) -> Result<bool, String> {
        breathe().await;
        let kh = with_state(|s| s.kh.clone())?;
        Ok(kh.get_agent(identifier(&agent)?).await.is_some())
    }

    async fn kh_create_group() -> Result<Vec<u8>, String> {
        create_user_group().await
    }

    async fn kh_add_to_group(
        group_id: Vec<u8>,
        member: Vec<u8>,
        level: String,
    ) -> Result<(), String> {
        add_to_group(&group_id, &member, &level).await
    }

    async fn kh_revoke_from_group(group_id: Vec<u8>, member: Vec<u8>) -> Result<(), String> {
        revoke_from_group(&group_id, &member).await
    }

    async fn kh_export_card(agent_id: Vec<u8>) -> Result<Vec<u8>, String> {
        export_static_card(&agent_id).await
    }

    async fn kh_ingest_card(card: Vec<u8>) -> Result<u32, String> {
        ingest_static_card(card).await
    }

    async fn kh_add_member(doc_id: Vec<u8>, agent_id: Vec<u8>, level: String) -> Result<(), String> {
        add_doc_member(&doc_id, &agent_id, &level).await
    }

    async fn kh_revoke_member(doc_id: Vec<u8>, agent_id: Vec<u8>) -> Result<(), String> {
        let (kh, proto) = with_state(|s| (s.kh.clone(), s.proto.clone()))?;
        let did = kh_doc_id(&doc_id)?;
        let doc = kh
            .get_document(did)
            .await
            .ok_or("doc not found".to_string())?;
        kh.revoke_member(identifier(&agent_id)?, true, &Membered::Document(did, doc))
            .await
            .map_err(|e| format!("revoke member: {e:?}"))?;
        refreshed_sync(&proto, None).await?;
        Ok(())
    }

    async fn kh_contact_card() -> Result<Vec<u8>, String> {
        contact_card_bytes().await
    }

    async fn kh_ingest_contact(card: Vec<u8>) -> Result<(), String> {
        ingest_contact_card(card).await.map(|_| ())
    }

    async fn init_store(config: StoreConfig) -> Result<(), String> {
        let cfg = match config {
            StoreConfig::S3(c) => StoreCfg::S3(S3Cfg {
                endpoint: c.endpoint.trim_end_matches('/').to_string(),
                bucket: c.bucket,
                access: c.access_key,
            }),
            // Addressing only: whether this instance can write is a
            // property of what its `store-owner-fetch` import is wired
            // to, which config cannot see and must not second-guess.
            StoreConfig::Dropbox(c) => StoreCfg::Dropbox(DbxCfg {
                root: c.root.trim_matches('/').to_string(),
            }),
            // Same rule, and here there is not even an access key to
            // carry: no credential of any kind crosses this boundary
            // (DRIVE.md §2). `api-base` is addressing, exactly like
            // S3's endpoint.
            //
            // `space` is the one field validated here rather than
            // carried through: it is a plain WIT string, and an unknown
            // value is refused BY NAME at init-store. Defaulting a typo
            // would put the store in the other space, where the walk
            // finds nothing and a re-flush rebuilds the whole tree —
            // indistinguishable from data loss to the user.
            StoreConfig::Gdrive(c) => StoreCfg::Gdrive(GdriveCfg {
                root: c.root.trim_matches('/').to_string(),
                api_base: c.api_base.trim_end_matches('/').to_string(),
                space: GdSpace::parse(&c.space)?,
            }),
        };
        with_state(|s| s.store = Some(cfg))
    }

    async fn ensure_bucket() -> Result<(), String> {
        match provider()? {
            Provider::S3 => {
                let st = store()?;
                // An explicit location body: some servers reject a bodyless
                // CreateBucket arriving without a Content-Length.
                let create = br#"<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>us-east-1</LocationConstraint></CreateBucketConfiguration>"#.to_vec();
                let (status, resp) =
                    s3_signed(&st, &EngineFetch, &EngineSigner, "PUT", "", "", create).await?;
                if status != 200 && status != 409 {
                    return Err(format!(
                        "create bucket: {status} {}",
                        String::from_utf8_lossy(&resp)
                    ));
                }
                let policy = format!(
                    r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":{{"AWS":["*"]}},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{}/*"]}}]}}"#,
                    st.bucket
                );
                let (status, resp) =
                    s3_signed(
                        &st,
                        &EngineFetch,
                        &EngineSigner,
                        "PUT",
                        "",
                        "policy=",
                        policy.into_bytes(),
                    )
                    .await?;
                if status == 200 || status == 204 {
                    Ok(())
                } else {
                    Err(format!(
                        "put bucket policy: {status} {}",
                        String::from_utf8_lossy(&resp)
                    ))
                }
            }
            Provider::Dropbox => {
                // Only the roots: doc folders and every link are minted
                // lazily, on the first grant or flush for a doc.
                let cfg = dbx()?;
                dbx_create_folder(&cfg, &EngineFetch, &format!("/{}", cfg.root), true).await?;
                dbx_create_folder(&cfg, &EngineFetch, &format!("/{}/docs", cfg.root), true).await?;
                dbx_create_folder(&cfg, &EngineFetch, &format!("/{}/pickup", cfg.root), true)
                    .await?;
                Ok(())
            }
            Provider::Gdrive => {
                // Only the roots. Doc folders are resolved-or-created
                // lazily on the first grant or flush, and nothing is
                // minted here or anywhere else on this provider
                // (DRIVE.md §1). Resolve-then-create makes this
                // idempotent without a tolerated-conflict status.
                let cfg = gd()?;
                gd_folder_path(&cfg, std::slice::from_ref(&cfg.root)).await?;
                gd_folder_path(&cfg, &[cfg.root.clone(), "docs".to_string()]).await?;
                gd_folder_path(&cfg, &[cfg.root.clone(), "pickup".to_string()]).await?;
                Ok(())
            }
        }
    }

    async fn store_grant(doc_id: Vec<u8>, member: Vec<u8>) -> Result<Option<String>, String> {
        let kh = with_state(|s| s.kh.clone())?;
        ensure_bucket_state(&doc_id)?;
        with_state(|s| {
            let b = s.buckets.get_mut(&doc_id).expect("bucket state");
            if !b.grantees.contains(&member) {
                b.grantees.push(member.clone());
            }
        })?;
        let grantees = with_state(|s| s.buckets.get(&doc_id).map(|b| b.grantees.clone()))?
            .ok_or("no bucket state")?;

        match provider()? {
            Provider::S3 => {
                let st = store()?;
                // Republish every grantee's K_p: the keychain (and device
                // list) may have grown since their K_p was written.
                for g in grantees {
                    publish_kp(&st, &kh, &doc_id, &g).await?;
                }
                // The K_p sits at a location the member derives from public
                // ids: there is no capability to hand back.
                Ok(None)
            }
            Provider::Dropbox => {
                let cfg = dbx()?;
                // Same reason as S3: every pickup carries the device set.
                for g in &grantees {
                    dbx_publish_pickup(&cfg, &kh, &doc_id, g).await?;
                }
                // The pickup FILE now exists, so its own link can be
                // minted: the member's standing capability, carried by the
                // caller in lieu of an E2E channel. A re-grant refreshes
                // the file in place and returns the same link.
                if let Some(link) = with_state(|s| {
                    s.buckets.get(&doc_id).and_then(|b| {
                        b.pickup_links
                            .iter()
                            .find(|(m, _)| m == &member)
                            .map(|(_, l)| l.clone())
                    })
                })? {
                    return Ok(Some(link));
                }
                let link =
                    dbx_mint_link(&cfg, &EngineFetch, &dbx_pickup_path(&cfg.root, &doc_id, &member))
                        .await?;
                with_state(|s| {
                    if let Some(b) = s.buckets.get_mut(&doc_id) {
                        b.pickup_links.push((member.clone(), link.clone()));
                    }
                })?;
                Ok(Some(link))
            }
            Provider::Gdrive => {
                let cfg = gd()?;
                // Same reason as the other two: every pickup carries the
                // device set, which may have grown since it was written.
                for g in &grantees {
                    gd_publish_pickup(&cfg, &kh, &doc_id, g).await?;
                }
                // NONE, and the none is the ruling (DRIVE.md §1): this
                // store mints no capability, so there is no link to hand
                // back — there is nothing a link could grant. The pickup
                // object exists for the ACCOUNT'S OWN DEVICES, which
                // read it with the user's own OAuth at a location they
                // derive from public ids.
                Ok(None)
            }
        }
    }

    async fn store_revoke(doc_id: Vec<u8>, member: Vec<u8>) -> Result<String, String> {
        let kh = with_state(|s| s.kh.clone())?;
        match provider()? {
            Provider::S3 => {
                let st = store()?;
                let my_id = with_state(|s| s.my_peer.as_bytes().to_vec())?;

                // Cooperative immediacy: the pickup object goes away.
                delete_object(
                    &st,
                    &EngineFetch,
                    &EngineSigner,
                    &kp_location(&doc_id, &my_id, &member).await?,
                )
                .await?;

                // Hard forward boundary: rotate the name-key epoch alongside
                // the BeeKEM rotation the keyhive revocation causes.
                let remaining = with_state(|s| {
                    let b = s
                        .buckets
                        .get_mut(&doc_id)
                        .ok_or("no bucket state".to_string())?;
                    b.grantees.retain(|g| g != &member);
                    b.name_keys.push(rand::random());
                    Ok::<_, String>(b.grantees.clone())
                })??;
                for g in remaining {
                    publish_kp(&st, &kh, &doc_id, &g).await?;
                }
                Ok("K_p deleted (cooperative now); name-key epoch rotated (hard forward)".into())
            }
            Provider::Dropbox => {
                let cfg = dbx()?;
                let (their_link, doc_link) = with_state(|s| {
                    let b = s
                        .buckets
                        .get(&doc_id)
                        .ok_or("no bucket state".to_string())?;
                    Ok::<_, String>((
                        b.pickup_links
                            .iter()
                            .find(|(m, _)| m == &member)
                            .map(|(_, l)| l.clone()),
                        b.doc_link.clone(),
                    ))
                })??;
                let their_link = their_link.ok_or("unknown grantee (no pickup link)")?;
                let doc_link = doc_link.ok_or("no container link for this doc")?;

                // 1. Their standing capability dies, and the object behind
                //    it goes away too.
                dbx_revoke_link(&cfg, &EngineFetch, &their_link).await?;
                dbx_delete(
                    &cfg,
                    &EngineFetch,
                    &dbx_pickup_path(&cfg.root, &doc_id, &member),
                )
                .await?;

                // 2. The hard boundary this strategy exists for: revoking
                //    the container link kills pull-now AND pull-past,
                //    server-side, against arbitrarily modified clients —
                //    including one that hoarded this exact URL.
                dbx_revoke_link(&cfg, &EngineFetch, &doc_link).await?;

                // 3. Pull-forward: a FRESH link on the SAME folder. Zero
                //    data movement, no re-encryption, no compaction.
                let folder = dbx_doc_folder(&cfg.root, &doc_id);
                let new_link = dbx_mint_link(&cfg, &EngineFetch, &folder).await?;
                let remaining = with_state(|s| {
                    let b = s
                        .buckets
                        .get_mut(&doc_id)
                        .ok_or("no bucket state".to_string())?;
                    b.grantees.retain(|g| g != &member);
                    b.pickup_links.retain(|(m, _)| m != &member);
                    b.doc_link = Some(new_link);
                    Ok::<_, String>(b.grantees.clone())
                })??;

                // 4. The remaining members ride the rotation in place:
                //    their pickup files are overwritten with the new
                //    container link, and their own file links — untouched
                //    — keep serving.
                for g in remaining {
                    dbx_publish_pickup(&cfg, &kh, &doc_id, &g).await?;
                }
                Ok("revoked server-side (hard, retroactive); container link re-minted".into())
            }
            Provider::Gdrive => {
                let cfg = gd()?;
                let my_id = with_state(|s| s.my_peer.as_bytes().to_vec())?;
                // The pickup object goes away (cooperative immediacy,
                // as on S3), and that is the whole server-side story.
                let folder = gd_pickup_folder(&cfg).await?;
                gd_delete(
                    &cfg,
                    &EngineFetch,
                    &folder,
                    &gd_pickup_name(&doc_id, &my_id, &member).await?,
                )
                .await?;
                // NO NAME-KEY EPOCH ROTATION HERE, and the omission is
                // the ruling rather than an oversight — recorded because
                // the S3 arm directly above DOES rotate at this exact
                // point, so the difference has to be accounted for.
                //
                // What rotation buys on S3: names there ARE the read
                // tier. The bucket serves unsigned public GETs, so
                // knowing an object's name is sufficient authority to
                // read it, and a revoked member who kept the old
                // name-key could keep reading new writes forever. A
                // fresh epoch is the hard forward boundary that stops
                // that.
                //
                // Why it buys nothing here: this provider serves NO
                // anonymous tier (DRIVE.md §1) — every read goes through
                // the owner seam's OAuth. A revoked member either holds
                // the user's Drive credential, in which case they can
                // list and read every object regardless of what it is
                // called, or they do not, in which case a name gets them
                // nothing. Names on this provider blind an OBSERVER's
                // labels; they are not an access-control mechanism, so
                // rotating them would be ceremony with no boundary
                // behind it. The honest note this arm returns already
                // says where the real lever is: credential rotation at
                // Google.
                //
                // The keychain machinery is still carried (the pickup
                // payload is a Vec of (epoch, key), and the pull walks
                // it newest-first exactly as S3's does), so if a future
                // revision ever does grow a reason to rotate, the
                // reading side already handles it. What is deliberately
                // absent is only the trigger.
                let remaining = with_state(|s| {
                    let b = s
                        .buckets
                        .get_mut(&doc_id)
                        .ok_or("no bucket state".to_string())?;
                    b.grantees.retain(|g| g != &member);
                    Ok::<_, String>(b.grantees.clone())
                })??;
                for g in remaining {
                    gd_publish_pickup(&cfg, &kh, &doc_id, &g).await?;
                }
                // The honest note, verbatim from DRIVE.md §1: no
                // capability was ever minted, so there is nothing
                // server-side to revoke, and a party holding the user's
                // own Drive credential is outside this store's reach.
                Ok("pickup deleted; this store never minted a capability, so there is nothing \
                    server-side to revoke — a holder of the user's own Drive credential is \
                    outside this store's reach, and credential rotation at Google is the real \
                    lever"
                    .into())
            }
        }
    }

    async fn bucket_flush(doc_id: Vec<u8>) -> Result<String, String> {
        ensure_bucket_state(&doc_id)?;
        let (nk_current, epoch) = with_state(|s| {
            let b = s.buckets.get(&doc_id).expect("bucket state");
            (
                *b.name_keys.last().expect("epoch"),
                (b.name_keys.len() - 1) as u32,
            )
        })?;
        let sink = match provider()? {
            Provider::S3 => PutSink::S3 {
                st: store()?,
                nk: nk_current,
            },
            Provider::Dropbox => {
                // No local gate on "do we have a token": the guest cannot
                // know, and refusing early would be guessing. Attempt the
                // write; a link-tier instance's own refusal surfaces
                // through the existing error paths.
                let cfg = dbx()?;
                // Lazy container: the folder and its link are minted on
                // whichever comes first, a grant or this flush.
                dbx_ensure_doc_container(&cfg, &doc_id).await?;
                let folder = dbx_doc_folder(&cfg.root, &doc_id);
                PutSink::Dbx { cfg, folder }
            }
            Provider::Gdrive => {
                // Same non-gate as Dropbox: the guest cannot know
                // whether the wired seam holds a token, and refusing
                // early would be guessing. Attempt the write; an
                // uncredentialed instance's own refusal surfaces
                // through the existing error paths.
                let cfg = gd()?;
                let folder_id = gd_doc_folder(&cfg, &doc_id).await?;
                PutSink::Gd {
                    cfg,
                    folder_id,
                    nk: nk_current,
                }
            }
        };
        flush_to(&sink, &doc_id, epoch).await
    }

    async fn bucket_pull(
        doc_id: Vec<u8>,
        owner: Vec<u8>,
        pickup: Option<String>,
    ) -> Result<String, String> {
        match provider()? {
            // S3 derives the K_p location from public ids; Dropbox
            // owner-tier pulls by path. Both ignore `pickup`.
            Provider::S3 => s3_pull(doc_id, owner).await,
            Provider::Dropbox => dbx_pull(doc_id, pickup).await,
            // Google Drive is owner tier only and REFUSES a `pickup` by
            // name rather than ignoring it (DRIVE.md §1). It DOES use
            // `owner`, unlike the Dropbox arm: since names became keyed,
            // the bootstrap object is located from the (doc, owner,
            // member) triple exactly as S3's K_p is.
            Provider::Gdrive => gd_pull(doc_id, owner, pickup).await,
        }
    }

    async fn identity_export(
        label: String,
        passphrase: Option<String>,
        secret_slot: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        if passphrase.is_none() && secret_slot.is_none() {
            return Err("at least one keyslot required".into());
        }
        let (kh, signer, verifying, owner) = with_state(|s| {
            (
                s.kh.clone(),
                s.signer.clone(),
                s.signer.0.verifying.to_bytes(),
                s.my_peer.as_bytes().to_vec(),
            )
        })?;
        let partition = active_partition()?;
        let seed = match &signer.0.key {
            IdentityKey::Soft(sk) => sk.to_bytes(),
            IdentityKey::Platform(_) => {
                return Err(
                    "identity not exportable: platform-held key (init with \
                     exportable-identity, or wait for the platform keystore)"
                        .into(),
                )
            }
        };
        let archive = kh.into_archive().await;
        let payload = BundlePayload {
            signing_key_seed: seed,
            verifying,
            keyhive_archive: bincode::serialize(&archive)
                .map_err(|e| format!("archive serialize: {e}"))?,
            partition,
            owner,
        };

        let bundle_key: [u8; 32] = rand::random();
        let aead = aead_from_raw(&bundle_key).await?;
        let sealed = aead_seal(
            &aead,
            b"identity-bundle",
            &bincode::serialize(&payload).map_err(|e| e.to_string())?,
        )
        .await?;

        let mut slots = Vec::new();
        if let Some(pass) = passphrase {
            let salt: [u8; 16] = rand::random();
            let slot_key = argon2id_key(&pass, &salt, ARGON_M_KIB, ARGON_T, ARGON_P)?;
            let slot_aead = aead_from_raw(&slot_key).await?;
            slots.push(BundleSlot::Passphrase {
                salt,
                m_cost_kib: ARGON_M_KIB,
                t_cost: ARGON_T,
                p_cost: ARGON_P,
                wrapped: aead_seal(&slot_aead, b"bundle-slot", &bundle_key).await?,
            });
        }
        if let Some(secret) = secret_slot {
            let slot_key = arr32(&secret, "secret slot")?;
            let slot_aead = aead_from_raw(&slot_key).await?;
            slots.push(BundleSlot::Secret {
                label: "external-secret".into(),
                wrapped: aead_seal(&slot_aead, b"bundle-slot", &bundle_key).await?,
            });
        }

        bincode::serialize(&IdentityBundle {
            label,
            created: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            slots,
            sealed,
        })
        .map_err(|e| e.to_string())
    }

    async fn identity_import(
        bundle: Vec<u8>,
        passphrase: Option<String>,
        secret: Option<Vec<u8>>,
    ) -> Result<String, String> {
        if STATE.with(|s| s.borrow().is_some()) {
            return Err("already initialized".into());
        }
        let bundle: IdentityBundle =
            bincode::deserialize(&bundle).map_err(|e| format!("bad bundle: {e}"))?;

        // Try every slot the caller has material for.
        let mut bundle_key: Option<[u8; 32]> = None;
        for slot in &bundle.slots {
            match slot {
                BundleSlot::Passphrase {
                    salt,
                    m_cost_kib,
                    t_cost,
                    p_cost,
                    wrapped,
                } => {
                    let Some(pass) = &passphrase else { continue };
                    let slot_key = argon2id_key(pass, salt, *m_cost_kib, *t_cost, *p_cost)?;
                    let slot_aead = aead_from_raw(&slot_key).await?;
                    if let Ok(k) = aead_open(&slot_aead, b"bundle-slot", wrapped).await {
                        bundle_key = Some(arr32(&k, "bundle key")?);
                        break;
                    }
                }
                BundleSlot::Secret { wrapped, .. } => {
                    let Some(sec) = &secret else { continue };
                    let slot_key = arr32(sec, "secret")?;
                    let slot_aead = aead_from_raw(&slot_key).await?;
                    if let Ok(k) = aead_open(&slot_aead, b"bundle-slot", wrapped).await {
                        bundle_key = Some(arr32(&k, "bundle key")?);
                        break;
                    }
                }
            }
        }
        let bundle_key = bundle_key.ok_or("unlock failed: no keyslot opened")?;

        let aead = aead_from_raw(&bundle_key).await?;
        let payload: BundlePayload =
            bincode::deserialize(&aead_open(&aead, b"identity-bundle", &bundle.sealed).await?)
                .map_err(|e| format!("payload decode: {e}"))?;

        let sk = ed25519_dalek::SigningKey::from_bytes(&payload.signing_key_seed);
        let verifying = DalekVerifyingKey::from_bytes(&payload.verifying)
            .map_err(|e| format!("bad verifying key: {e:?}"))?;
        if sk.verifying_key() != verifying {
            return Err("bundle inconsistent: seed does not match verifying key".into());
        }
        let signer = WebcryptoSigner(Rc::new(SignerInner {
            key: IdentityKey::Soft(Box::new(sk)),
            verifying,
            sign_count: Cell::new(0),
        }));

        let archive: keyhive_core::archive::Archive<T> =
            bincode::deserialize(&payload.keyhive_archive)
                .map_err(|e| format!("archive decode: {e}"))?;
        #[allow(clippy::arc_with_non_send_sync)] // upstream API shape; single-threaded wasm
        let csprng = Arc::new(futures::lock::Mutex::new(rand::rngs::OsRng));
        let ciphertexts: KhStore = MemoryCiphertextStore::new();
        let kh = Kh::try_from_archive(
            &archive,
            signer.clone(),
            ciphertexts.clone(),
            NoListener,
            csprng,
        )
        .await
        .map_err(|e| format!("archive restore: {e:?}"))?;

        let card = kh
            .contact_card()
            .await
            .map_err(|e| format!("contact card: {e:?}"))?;
        CARD.with(|c| *c.borrow_mut() = Some(card));
        finish_init(signer, verifying, kh, ciphertexts)?;

        // Bind the tasks service to the bundled partition; content
        // rehydrates from the bucket (G4 cold boot).
        with_state(|s| {
            s.partitions.insert(
                payload.partition.clone(),
                Partition {
                    am: AutoCommit::new(),
                    applied: HashSet::new(),
                    revision: 0,
                    undecryptable: 0,
                    decrypted: 0,
                    walked: 0,
                },
            );
            s.active = Some(payload.partition.clone());
        })?;
        Ok(hex::encode(payload.verifying))
    }

    // --- state persistence (#20 G5; see persist.rs for the layout and
    // --- the crash-consistency argument) ---

    async fn state_checkpoint() -> Result<(), String> {
        persist::checkpoint().await
    }

    async fn state_resume() -> Result<bool, String> {
        persist::resume().await
    }

    async fn iroh_bind(relay_url: String) -> Result<String, String> {
        let identity = identity_generate::generate()
            .await
            .map_err(|e| format!("identity-generate: {e:?}"))?;
        let options = EndpointOptions::new(&identity);
        options.add_alpn(ALPN);
        // Pairing runs on its own ALPN, so a pairing dial can never be
        // consumed by the sync acceptor (or the reverse).
        options.add_alpn(pairing::PAIR_ALPN);
        options.relay_url(&relay_url);
        let endpoint = Endpoint::bind(options)
            .await
            .map_err(|e| format!("bind: {e:?}"))?;
        let id = endpoint.id();
        with_state(|s| {
            s.endpoint = Some(Rc::new(endpoint));
            s.relay_url = Some(relay_url.clone());
            s.iroh_identity = Some(Rc::new(identity));
        })?;
        Ok(hex::encode(id))
    }

    async fn iroh_start(
        initiator: bool,
        peer_endpoint_id: Vec<u8>,
        relay_url: String,
        expected_peer: Vec<u8>,
    ) -> Result<u32, String> {
        let (id, sd, signer, my_peer, nonce_cache, endpoint) = with_state(|s| {
            let id = s.next_id;
            s.next_id += 1;
            (
                id,
                s.sd.clone(),
                s.signer.clone(),
                s.my_peer,
                s.nonce_cache.clone(),
                s.endpoint.clone(),
            )
        })?;
        let endpoint = endpoint.ok_or("iroh-bind first")?;
        let proto = with_state(|s| s.proto.clone())?;

        wit_bindgen::spawn_local(async move {
            let wire = async {
                if initiator {
                    let conn = endpoint
                        .connect(
                            EndpointAddr {
                                endpoint_id: peer_endpoint_id,
                                addrs: vec![TransportAddr::Relay(relay_url)],
                            },
                            ALPN.to_vec(),
                        )
                        .await
                        .map_err(|e| format!("connect: {e:?}"))?;
                    let (s_send, s_recv) =
                        conn.open_bi().await.map_err(|e| format!("open-bi S: {e:?}"))?;
                    s_send
                        .write(vec![b'S'])
                        .await
                        .map_err(|e| format!("tag S: {e:?}"))?;
                    let (k_send, k_recv) =
                        conn.open_bi().await.map_err(|e| format!("open-bi K: {e:?}"))?;
                    k_send
                        .write(vec![b'K'])
                        .await
                        .map_err(|e| format!("tag K: {e:?}"))?;
                    Ok::<_, String>((
                        conn,
                        (s_send, s_recv, Vec::new()),
                        (k_send, k_recv, Vec::new()),
                    ))
                } else {
                    // Skip anything that is not a sync dial: a pairing
                    // connection belongs to the pairing acceptor, and
                    // swallowing it here would strand both ceremonies.
                    let conn = loop {
                        let conn =
                            endpoint.accept().await.map_err(|e| format!("accept: {e:?}"))?;
                        if conn.alpn() == ALPN {
                            break conn;
                        }
                    };
                    let mut s_stream = None;
                    let mut k_stream = None;
                    for _ in 0..2 {
                        let (send, recv) = conn
                            .accept_bi()
                            .await
                            .map_err(|e| format!("accept-bi: {e:?}"))?;
                        let first = recv
                            .read(64 * 1024)
                            .await
                            .map_err(|e| format!("read tag: {e:?}"))?
                            .ok_or("stream closed before tag".to_string())?;
                        let (tag, seed) = (first[0], first[1..].to_vec());
                        match tag {
                            b'S' => s_stream = Some((send, recv, seed)),
                            b'K' => k_stream = Some((send, recv, seed)),
                            other => return Err(format!("unknown stream tag {other}")),
                        }
                    }
                    Ok((
                        conn,
                        s_stream.ok_or("no S stream".to_string())?,
                        k_stream.ok_or("no K stream".to_string())?,
                    ))
                }
            }
            .await;
            let (conn, (s_send, s_recv, s_seed), (k_send, k_recv, k_seed)) = match wire {
                Ok(t) => t,
                Err(e) => {
                    let _ = with_state(|s| s.conn_results.insert(id, Err(e)));
                    return;
                }
            };

            let transport = QueueTransport::new(id);
            wit_bindgen::spawn_local(iroh_writer(transport.out_rx.clone(), s_send));
            wit_bindgen::spawn_local(iroh_reader(transport.in_tx.clone(), s_recv, s_seed));
            let _ = with_state(|s| s.iroh_conns.insert(id, Rc::new(conn)));

            let outcome = subduction_handshake(
                transport,
                initiator,
                expected_peer,
                sd,
                signer,
                my_peer,
                nonce_cache,
            )
            .await;

            if let Ok(peer_hex) = &outcome {
                match hex::decode(peer_hex)
                    .ok()
                    .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                {
                    Some(peer32) => {
                        let (kh_out_tx, kh_out_rx) = async_channel::unbounded();
                        let (kh_in_tx, kh_in_rx) = async_channel::unbounded();
                        wit_bindgen::spawn_local(iroh_writer(kh_out_rx, k_send));
                        wit_bindgen::spawn_local(iroh_reader(kh_in_tx, k_recv, k_seed));
                        let kh_peer = KeyhivePeerId::from_bytes(peer32);
                        let kh_wire = KhWire {
                            peer: kh_peer.clone(),
                            out_tx: kh_out_tx,
                            in_rx: kh_in_rx,
                        };
                        proto.add_peer(kh_peer.clone(), kh_wire.clone()).await;
                        let recv_proto = proto.clone();
                        let recv_wire = kh_wire.clone();
                        let recv_peer = kh_peer.clone();
                        wit_bindgen::spawn_local(async move {
                            while let Ok(msg) = recv_wire.recv().await {
                                // Spike posture: a failed round is dropped,
                                // not fatal — but say so on stderr.
                                if let Err(e) = recv_proto
                                    .handle_message(&recv_peer, msg, Some(recv_wire.clone()))
                                    .await
                                {
                                    eprintln!("[kh recv] handle_message error: {e:?}");
                                }
                            }
                        });
                        let _ = refreshed_sync(&proto, Some(&kh_peer)).await;
                    }
                    None => {
                        let _ = with_state(|s| {
                            s.conn_results
                                .insert(id, Err("bad peer id from handshake".into()))
                        });
                        return;
                    }
                }
            }
            let _ = with_state(|s| s.conn_results.insert(id, outcome));
        });

        Ok(id)
    }

    async fn conn_status(conn: u32) -> Result<Option<String>, String> {
        breathe().await;
        match with_state(|s| s.conn_results.get(&conn).cloned())? {
            Some(Ok(peer)) => Ok(Some(peer)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    async fn sync_start(peer: Vec<u8>, tree: Vec<u8>, subscribe: bool) -> Result<u32, String> {
        let peer = PeerId::new(arr32(&peer, "peer")?);
        let id = tree_id(&tree)?;
        let (handle, sd) = with_state(|s| {
            let h = s.next_id;
            s.next_id += 1;
            (h, s.sd.clone())
        })?;
        wit_bindgen::spawn_local(async move {
            let outcome = match sd
                .sync_with_peer(&peer, id, subscribe, CallTimeout::Default)
                .await
            {
                Ok((success, stats, errors)) => Ok(format!(
                    "success={success} stats={stats:?} errors={}",
                    errors.len()
                )),
                Err(e) => Err(format!("sync_with_peer: {e:?}")),
            };
            let _ = with_state(|s| s.syncs.insert(handle, outcome));
        });
        Ok(handle)
    }

    async fn sync_status(handle: u32) -> Result<Option<String>, String> {
        breathe().await;
        // One-shot by contract (see the note on `syncs`): the outcome is
        // REMOVED as it is read, so the table holds only in-flight syncs.
        // Leaving completed entries in made the map grow without bound —
        // the demo starts ~48 syncs/minute, forever.
        match with_state(|s| s.syncs.remove(&handle))? {
            Some(Ok(summary)) => Ok(Some(summary)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    async fn create_partition() -> Result<Vec<u8>, String> {
        let kh = with_state(|s| s.kh.clone())?;

        let mut am = AutoCommit::new();
        am.put_object(ROOT, "todos", ObjType::Map)
            .map_err(|e| format!("automerge init: {e}"))?;
        am.commit();
        let change = am
            .get_last_local_change()
            .ok_or("creation produced no change")?;
        let cref = change.hash().0;
        let chunk = change.raw_bytes().to_vec();

        let doc = kh
            .generate_doc(vec![], nonempty::nonempty![cref])
            .await
            .map_err(|e| format!("generate doc: {e:?}"))?;
        let id = { doc.lock().await.doc_id().as_slice().to_vec() };

        with_state(|s| {
            let mut applied = HashSet::new();
            applied.insert(cref);
            s.partitions.insert(
                id.clone(),
                Partition {
                    am,
                    applied,
                    revision: 1,
                    undecryptable: 0,
                    decrypted: 0,
                    walked: 0,
                },
            );
            s.pending.insert(id.clone(), (chunk, cref));
        })?;
        Ok(id)
    }

    async fn seal_partition(id: Vec<u8>) -> Result<(), String> {
        // Only the CREATION change may be pending here. Anything authored
        // between create and seal would have parents whose keys do not
        // exist yet (nothing has been sealed, so no chunk key has been
        // minted), and `encrypt_and_commit` now refuses that rather than
        // sealing an envelope with a missing ancestor key. No current
        // flow does it; the refusal is the guard for one that tries.
        let (chunk, cref) =
            with_state(|s| s.pending.remove(&id))?.ok_or("no pending creation chunk")?;
        encrypt_and_commit(&id, chunk, vec![], cref).await?;
        with_state(|s| s.active = Some(id))?;
        Ok(())
    }

    async fn adopt_partition(id: Vec<u8>) -> Result<(), String> {
        with_state(|s| {
            s.partitions.insert(
                id.clone(),
                Partition {
                    am: AutoCommit::new(),
                    applied: HashSet::new(),
                    revision: 0,
                    undecryptable: 0,
                    decrypted: 0,
                    walked: 0,
                },
            );
            s.active = Some(id);
        })?;
        Ok(())
    }

    async fn chunk_stats(id: Vec<u8>) -> Result<(u32, u32), String> {
        let sd = with_state(|s| s.sd.clone())?;
        let tree = tree_id(&id)?;
        let commits = sd.get_commits(tree).await.unwrap_or_default();
        let chunks = commits.len() as u32;
        let max_parents = commits
            .iter()
            .map(|c| c.parents().len() as u32)
            .max()
            .unwrap_or(0);
        Ok((chunks, max_parents))
    }

    // --- device pairing (#10; PAIRING.md §1–§2) ---

    async fn pair_join_start() -> Result<PairOffer, String> {
        pairing::join_start().await
    }

    async fn pair_join_status() -> Result<PairJoinState, String> {
        breathe().await;
        pairing::join_status()
    }

    async fn pair_join_confirm() -> Result<(), String> {
        pairing::join_confirm().await
    }

    async fn pair_add_start(code: String) -> Result<(), String> {
        pairing::add_start(code).await
    }

    async fn pair_add_status() -> Result<PairAddState, String> {
        breathe().await;
        pairing::add_status()
    }

    async fn pair_add_confirm(device_name: String) -> Result<(), String> {
        pairing::add_confirm(device_name).await
    }

    async fn pair_abort() -> Result<(), String> {
        pairing::abort_all();
        Ok(())
    }

    // --- the user-system partition (#36; PAIRING.md §4) ---

    async fn user_create(profile: UsProfile) -> Result<Vec<u8>, String> {
        usdoc::create(profile).await
    }

    async fn us_profile_get() -> Result<UsProfile, String> {
        usdoc::profile_get().await
    }

    async fn us_profile_set(profile: UsProfile) -> Result<(), String> {
        usdoc::profile_set(profile).await
    }

    async fn us_marks_list() -> Result<Vec<UsMark>, String> {
        usdoc::marks_list().await
    }

    async fn us_mark_put(mark: UsMark) -> Result<(), String> {
        usdoc::mark_put(mark).await
    }

    async fn us_mark_forget(provenance: String) -> Result<(), String> {
        usdoc::mark_forget(provenance).await
    }

    async fn us_mark_confirm(provenance: String) -> Result<(), String> {
        usdoc::mark_confirm(provenance).await
    }

    async fn us_partition_put(name: String, id: Vec<u8>) -> Result<(), String> {
        usdoc::partition_put(name, id).await
    }

    async fn us_partitions() -> Result<Vec<UsPartition>, String> {
        usdoc::partitions_list().await
    }

    async fn us_contacts_list() -> Result<Vec<(Vec<u8>, String)>, String> {
        usdoc::contacts_list().await
    }

    async fn us_contact_put(card: Vec<u8>, petname: String) -> Result<(), String> {
        usdoc::contact_put(card, petname).await
    }

    async fn us_devices_list() -> Result<Vec<UsDevice>, String> {
        usdoc::devices_list().await
    }

    async fn us_device_revoke(agent_id: Vec<u8>) -> Result<(), String> {
        usdoc::device_revoke(agent_id).await
    }

    async fn us_events() -> Result<Vec<UsEvent>, String> {
        usdoc::events().await
    }

    async fn stats() -> String {
        with_state(|s| {
            let (rev, undec) = s
                .active
                .as_ref()
                .and_then(|id| s.partitions.get(id))
                .map(|p| (p.revision, p.undecryptable))
                .unwrap_or((0, 0));
            // Table sizes are part of the line on purpose: a growth bug
            // in any of these is invisible from outside the guest, and
            // one (the syncs map) already shipped.
            // The user-system doc is never the "active" partition (that
            // binding belongs to the tasks service), so its counters are
            // reported separately — they are what the enrollment gates
            // assert against.
            let us = s
                .us
                .doc
                .as_ref()
                .and_then(|id| s.partitions.get(id))
                .map(|p| (p.decrypted, p.undecryptable, p.revision, p.walked))
                .unwrap_or((0, 0, 0, 0));
            format!(
                "webcrypto sign calls: {}; iroh conns: {}; revision: {rev}; undecryptable: {undec}; \
                 us-decrypted={} us-undecryptable={} us-revision={} us-walked={}; \
                 tables syncs={} conns={} parts={} pending={} buckets={} fetches={}",
                s.signer.0.sign_count.get(),
                s.iroh_conns.len(),
                us.0,
                us.1,
                us.2,
                us.3,
                s.syncs.len(),
                s.conn_results.len(),
                s.partitions.len(),
                s.pending.len(),
                s.buckets.len(),
                s.fetches,
            )
        })
        .unwrap_or_else(|e| e)
    }
}

// --- the tasks data service (served from inside the engine composite) ---

impl TasksGuest for Component {
    async fn partition() -> Result<Vec<u8>, String> {
        active_partition()
    }

    async fn revision() -> Result<u64, String> {
        let id = active_partition()?;
        apply_new_chunks(&id).await?;
        with_state(|s| s.partitions.get(&id).map(|p| p.revision))?.ok_or("unknown partition".into())
    }

    async fn items() -> Result<Snapshot, String> {
        let id = active_partition()?;
        apply_new_chunks(&id).await?;
        with_state(|s| -> Result<Snapshot, String> {
            let p = s.partitions.get(&id).ok_or("unknown partition")?;
            Ok(Snapshot {
                revision: p.revision,
                items: read_snapshot(&p.am)?,
            })
        })?
    }

    async fn add(title: String) -> Result<String, String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let item_id = hex::encode(rand::random::<[u8; 8]>());
            let item = am
                .put_object(&todos, &item_id, ObjType::Map)
                .map_err(|e| format!("put item: {e}"))?;
            am.put(&item, "title", title.as_str())
                .map_err(|e| format!("put title: {e}"))?;
            am.put(&item, "completed", false)
                .map_err(|e| format!("put completed: {e}"))?;
            Ok(item_id)
        })
        .await
    }

    async fn set_completed(item: String, completed: bool) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let Some((Value::Object(_), obj)) =
                am.get(&todos, &item).map_err(|e| e.to_string())?
            else {
                return Err(format!("no item {item}"));
            };
            am.put(&obj, "completed", completed)
                .map_err(|e| format!("put completed: {e}"))?;
            Ok(())
        })
        .await
    }

    async fn set_title(item: String, title: String) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            let Some((Value::Object(_), obj)) =
                am.get(&todos, &item).map_err(|e| e.to_string())?
            else {
                return Err(format!("no item {item}"));
            };
            am.put(&obj, "title", title.as_str())
                .map_err(|e| format!("put title: {e}"))?;
            Ok(())
        })
        .await
    }

    async fn remove(item: String) -> Result<(), String> {
        let id = active_partition()?;
        author(&id, |am| {
            let todos = todos_object(am)?;
            am.delete(&todos, &item)
                .map_err(|e| format!("delete: {e}"))?;
            Ok(())
        })
        .await
    }
}

export!(Component);
