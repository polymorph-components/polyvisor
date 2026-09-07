//! The keyhive instance this device seals its app content with
//! (docs/design.md, Milestones **M3c**).
//!
//! ## What is enveloped, and what is not
//!
//! App trees are enveloped; the user-system document (`polyvisor:us`) is not.
//! The reason is bootstrap, not laziness: `us` is what tells a device who its
//! group is, and the group is what the keyhive membership is *derived from* —
//! a device that could not read `us` until it had keyhive state, and could not
//! build keyhive state until it knew the group, would never start. It also
//! gives away nothing new: `us` holds endpoint public keys and petnames, and a
//! relay watching the connections already sees every endpoint id in the group.
//! The content — the user's actual documents — is what the relay must not see,
//! and that is exactly what is sealed here.
//!
//! ## One keyhive document per group, not per app
//!
//! Every app tree of one device group has the *same* membership (the group),
//! so per-app keyhive documents would buy no confidentiality — and they would
//! buy a race: two paired devices that open an app neither has seen would each
//! generate a document for it, and the loser's commits would be sealed to a
//! document nobody else holds. The group's single document has no such moment:
//! it is generated once, with the group, and its id travels in `us`.
//!
//! ## Identity
//!
//! The keyhive signer is `ed25519_dalek::SigningKey::from_bytes(seed)` — the
//! same key as the subduction peer id and the iroh endpoint id. Keyhive
//! implements `AsyncSigner` for `SigningKey` directly
//! (keyhive_crypto/src/signer/sync_signer.rs:28), so no adapter is needed. One
//! device, one long-term key: a second identity would have to be enrolled,
//! displayed and revoked separately, and the group already names the device by
//! this one.
//!
//! ## Read-back, and its cost
//!
//! BeeKEM gives a member the *current* epoch key when it is added; content
//! sealed before that is not derivable from it. A device that has just been
//! paired would therefore see the group's history as undecryptable noise. The
//! fix, taken from the archived engine's PAIRING.md §4b ("causal-key
//! read-back"), is to seal each commit's plaintext together with the keys of
//! its parents, so a reader that can open any commit can walk backwards from
//! it. The container is keyhive's own [`Envelope`] and the walk is keyhive's
//! own `CiphertextStoreExt::try_causal_decrypt` — PAIRING.md §4b is explicit
//! that this must not be a parallel format, and it is right: the walk
//! `bincode`-deserializes an `Envelope` out of every plaintext it opens
//! (keyhive_core store/ciphertext.rs:189), so a look-alike struct with a
//! different `ancestors` encoding would fail on every non-genesis commit.
//!
//! Worth stating plainly rather than discovering later: this makes possession
//! of one commit key transitively grant the whole ancestry behind it. Within
//! one person's own devices — which is the entire membership model here — that
//! is the intent. It would be a policy decision to revisit for shared
//! documents, which do not exist yet.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use beekem::encrypted::EncryptedContent;
use ed25519_dalek::SigningKey;
use future_form::Local;
use futures::lock::Mutex;
use keyhive_core::access::Access;
use keyhive_core::archive::Archive;
use keyhive_core::contact_card::ContactCard;
use keyhive_core::crypto::envelope::Envelope;
use keyhive_core::event::Event;
use keyhive_core::event::static_event::StaticEvent;
use keyhive_core::keyhive::Keyhive;
use keyhive_core::listener::no_listener::NoListener;
use keyhive_core::principal::agent::Agent;
use keyhive_core::principal::document::id::DocumentId;
use keyhive_core::principal::group::id::GroupId;
use keyhive_core::principal::identifier::Identifier;
use keyhive_core::principal::membered::Membered;
use keyhive_core::principal::peer::Peer;
use keyhive_core::store::ciphertext::memory::MemoryCiphertextStore;
use keyhive_core::store::ciphertext::{CausalDecryptionState, CiphertextStoreExt};
use keyhive_crypto::symmetric_key::SymmetricKey;
use nonempty::NonEmpty;
use rand_chacha::ChaCha20Rng;
use rand_chacha::rand_core::SeedableRng;
use serde::{Deserialize, Serialize};

/// A commit id, which is what keyhive calls a content reference. Identical to
/// keyhive's own default `ContentRef`, and identical to the automerge change
/// hash a sedimentree `CommitId` already is (see `crate::document`).
type Cref = [u8; 32];

/// The plaintext keyhive seals. Not the automerge change alone: see the
/// read-back note in the module docs.
type Plaintext = Vec<u8>;

type Store = MemoryCiphertextStore<Cref, Plaintext>;
type Kh = Keyhive<Local, SigningKey, Cref, Plaintext, Store, NoListener, ChaCha20Rng>;

/// One sealed commit as it rests in a sedimentree blob and crosses the wire.
pub type Ciphertext = EncryptedContent<Plaintext, Cref>;

/// The keyhive state a checkpoint carries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultState {
    /// `bincode` of keyhive's own `Archive`.
    pub archive: Vec<u8>,
    pub group: [u8; 32],
    pub doc: [u8; 32],
    /// The content keys this device has learned, which is what lets it seal a
    /// commit whose parents it did not author. Secret, and sealed with the
    /// rest of the checkpoint.
    pub chunk_keys: Vec<(Cref, [u8; 32])>,
}

/// This device's keyhive: its own identity, the device group, and the one
/// document every app tree is sealed to.
pub struct Vault {
    kh: Kh,
    store: Store,
    /// Which group and document this device seals to. `Cell` rather than a
    /// field: a joiner switches both when it adopts an adder's group, and the
    /// engine holds the vault behind an `Rc` it clones before every await.
    group: Cell<GroupId>,
    doc: Cell<DocumentId>,
    /// Content keys, by commit id. See [`VaultState::chunk_keys`].
    chunk_keys: RefCell<HashMap<Cref, SymmetricKey>>,
    /// Digests of the static events already carried into the keyhive-events
    /// tree, so republishing is a no-op rather than a re-commit of the whole
    /// op graph on every turn.
    published: RefCell<HashSet<[u8; 32]>>,
}

impl Vault {
    /// A brand new keyhive: this device's identity, a group of one, and the
    /// group's document.
    pub async fn create(seed: [u8; 32], rng_seed: [u8; 32]) -> Result<Vault, String> {
        let store = Store::new();
        let kh = Kh::generate(
            SigningKey::from_bytes(&seed),
            store.clone(),
            NoListener,
            ChaCha20Rng::from_seed(rng_seed),
        )
        .await
        .map_err(|e| format!("keyhive: {e}"))?;
        let group = kh
            .generate_group(Vec::new())
            .await
            .map_err(|e| format!("keyhive group: {e}"))?;
        let group_id = group.lock().await.group_id();
        // The document's members are the group, so every later enrollment is
        // one `add_member` on the group rather than one per document.
        let doc = kh
            .generate_doc(
                vec![Peer::Group(group_id, group)],
                NonEmpty::new(*group_id.as_bytes()),
            )
            .await
            .map_err(|e| format!("keyhive document: {e}"))?;
        let doc_id = doc.lock().await.doc_id();
        Ok(Vault {
            store,
            kh,
            group: Cell::new(group_id),
            doc: Cell::new(doc_id),
            chunk_keys: RefCell::new(HashMap::new()),
            published: RefCell::new(HashSet::new()),
        })
    }

    /// The keyhive a checkpoint held.
    pub async fn restore(
        state: &VaultState,
        seed: [u8; 32],
        rng_seed: [u8; 32],
    ) -> Result<Vault, String> {
        let archive: Archive<Cref> =
            bincode::deserialize(&state.archive).map_err(|e| format!("keyhive archive: {e}"))?;
        let store = Store::new();
        let kh = Kh::try_from_archive(
            &archive,
            SigningKey::from_bytes(&seed),
            store.clone(),
            NoListener,
            Arc::new(Mutex::new(ChaCha20Rng::from_seed(rng_seed))),
        )
        .await
        .map_err(|e| format!("keyhive restore: {e:?}"))?;
        Ok(Vault {
            kh,
            store,
            group: Cell::new(GroupId::new(identifier(state.group)?)),
            doc: Cell::new(DocumentId::from(identifier(state.doc)?)),
            chunk_keys: RefCell::new(
                state
                    .chunk_keys
                    .iter()
                    .map(|(cref, key)| (*cref, SymmetricKey::from(*key)))
                    .collect(),
            ),
            published: RefCell::new(HashSet::new()),
        })
    }

    /// Everything a checkpoint needs to bring this vault back.
    pub async fn state(&self) -> Result<VaultState, String> {
        let archive = self.kh.into_archive().await;
        Ok(VaultState {
            archive: bincode::serialize(&archive).map_err(|e| format!("keyhive archive: {e}"))?,
            group: self.group.get().to_bytes(),
            doc: self.doc.get().to_bytes(),
            chunk_keys: self
                .chunk_keys
                .borrow()
                .iter()
                .map(|(cref, key)| {
                    let mut bytes = [0u8; 32];
                    bytes.copy_from_slice(key.as_slice());
                    (*cref, bytes)
                })
                .collect(),
        })
    }

    #[must_use]
    pub fn group_id(&self) -> [u8; 32] {
        self.group.get().to_bytes()
    }

    #[must_use]
    pub fn doc_id(&self) -> [u8; 32] {
        self.doc.get().to_bytes()
    }

    // -- enrollment ----------------------------------------------------------

    /// This device's keyhive contact card, for the ACCEPT frame. A prekey the
    /// adder needs in order to seal the group's current epoch key to us.
    pub async fn contact_card(&self) -> Result<Vec<u8>, String> {
        let card = self
            .kh
            .contact_card()
            .await
            .map_err(|e| format!("contact card: {e}"))?;
        bincode::serialize(&card).map_err(|e| format!("contact card: {e}"))
    }

    /// Adder: take the joiner's contact card and add it to the device group as
    /// an admin. Returns the whole op stream, for the ENROLL frame.
    ///
    /// `Access::Admin` because a device of this user is not a guest: it must be
    /// able to enrol the next device itself, which is a membership write.
    pub async fn enroll(&self, card_bytes: &[u8], joiner_key: [u8; 32]) -> Result<Vec<u8>, String> {
        let card: ContactCard =
            bincode::deserialize(card_bytes).map_err(|e| format!("bad contact card: {e}"))?;
        // The card is bound to the key the SAS ceremony authenticated. Without
        // this check the ceremony would authenticate one device and the
        // membership grant would land on whichever keyhive identity the card
        // happened to name — which is the substitution the six digits exist to
        // prevent, one layer down.
        if card.id().to_bytes() != joiner_key {
            return Err("that device's keyhive card is for a different key".to_string());
        }
        let individual = self
            .kh
            .receive_contact_card(&card)
            .await
            .map_err(|e| format!("contact card: {e:?}"))?;
        let id = individual.lock().await.id();
        let group = self
            .kh
            .get_group(self.group.get())
            .await
            .ok_or_else(|| "this device has no keyhive group".to_string())?;
        let _update = self
            .kh
            .add_member(
                Agent::Individual(id, individual),
                &Membered::Group(self.group.get(), group),
                Access::Admin,
                &[],
            )
            .await
            .map_err(|e| format!("keyhive add_member: {e:?}"))?;
        // Forced key rotation at the enrollment boundary (PAIRING.md §2). The
        // next seal would advance the epoch anyway, but "anyway" is not a
        // boundary: doing it here means the joiner's first readable epoch
        // begins at the moment it was admitted rather than at whenever someone
        // next happened to write.
        let doc = self
            .kh
            .get_document(self.doc.get())
            .await
            .ok_or_else(|| "this device has no keyhive document".to_string())?;
        let (_op, _share, _secret) = self
            .kh
            .force_pcs_update(doc)
            .await
            .map_err(|e| format!("keyhive key rotation: {e:?}"))?;
        self.static_events().await
    }

    /// The content keys this device holds, for the device it is enrolling.
    ///
    /// BeeKEM hands a new member the *current* epoch key and nothing earlier,
    /// so a freshly paired device sees the group's whole history as noise. The
    /// ancestor keys in each [`Envelope`] let it read backwards — but only from
    /// a commit it can open, and immediately after joining there is none. This
    /// is that first foothold: the adder gives the joiner the keys it already
    /// holds, over the pairing channel the two users just compared six digits
    /// on.
    ///
    /// The consequence is worth stating rather than discovering: enrolling a
    /// device grants it the group's *entire* readable history, not just what
    /// follows. That includes keys for commits sealed to the adder's own
    /// pre-pairing document — the group-of-one it had before it ever met
    /// anyone — because this map does not distinguish which keyhive document a
    /// commit belonged to. Intended: total read-back is total. For a person's
    /// own devices — the only membership this system has — that is the point,
    /// and it is what the e2e pairing ceremony expects. It would be a policy
    /// question for shared documents, which do not exist.
    ///
    /// The map only grows, and it grows with every commit anyone in the group
    /// ever writes. That is the standing cost of total read-back: it is
    /// checkpointed on every device and copied to every device enrolled after
    /// it. Bounding it *is* the chain-cut policy decision, which this milestone
    /// does not make.
    pub fn export_content_keys(&self) -> Result<Vec<u8>, String> {
        let keys: Vec<(Cref, [u8; 32])> = self
            .chunk_keys
            .borrow()
            .iter()
            .map(|(cref, key)| {
                let mut bytes = [0u8; 32];
                bytes.copy_from_slice(key.as_slice());
                (*cref, bytes)
            })
            .collect();
        bincode::serialize(&keys).map_err(|e| format!("content keys: {e}"))
    }

    fn import_content_keys(&self, bytes: &[u8]) -> Result<(), String> {
        let keys: Vec<(Cref, [u8; 32])> =
            bincode::deserialize(bytes).map_err(|e| format!("bad content keys: {e}"))?;
        self.chunk_keys.borrow_mut().extend(
            keys.into_iter()
                .map(|(cref, key)| (cref, SymmetricKey::from(key))),
        );
        Ok(())
    }

    /// Joiner: take the adder's op stream and the group/document the adopted
    /// user-system document names.
    ///
    /// This device's own keyhive identity is kept — its prekeys are its own and
    /// its contact card is what the adder just enrolled. What is replaced is
    /// which group and document it seals to; the group of one it generated at
    /// first boot stays in the op graph, unreferenced, which is what keeps its
    /// own pre-pairing content readable *to itself*.
    pub async fn adopt(
        &self,
        events: &[u8],
        content_keys: &[u8],
        group: [u8; 32],
        doc: [u8; 32],
    ) -> Result<(), String> {
        self.ingest(events).await?;
        self.import_content_keys(content_keys)?;
        let group = GroupId::new(identifier(group)?);
        let doc = DocumentId::from(identifier(doc)?);
        if self.kh.get_group(group).await.is_none() {
            return Err("that device sent a group this one cannot see".to_string());
        }
        if self.kh.get_document(doc).await.is_none() {
            return Err("that device sent a document this one cannot see".to_string());
        }
        self.group.set(group);
        self.doc.set(doc);
        Ok(())
    }

    /// Whether the event a keyhive-tree commit carries is still unknown. The
    /// commit id *is* the event's digest, so this needs no decode — which is
    /// what keeps re-absorbing a tree of ops cheap.
    #[must_use]
    pub fn unseen(&self, commit: Cref) -> bool {
        !self.published.borrow().contains(&commit)
    }

    /// Apply a batch of keyhive static events (the keyhive-events tree, or an
    /// ENROLL frame). Events whose dependencies have not arrived are held by
    /// keyhive itself and replayed on the next ingest.
    pub async fn ingest(&self, bytes: &[u8]) -> Result<(), String> {
        let events: Vec<StaticEvent<Cref>> =
            bincode::deserialize(bytes).map_err(|e| format!("bad keyhive events: {e}"))?;
        for event in &events {
            let _published = self.published.borrow_mut().insert(digest(event));
        }
        let _pending = self.kh.ingest_unsorted_static_events(events).await;
        Ok(())
    }

    /// Every static event this keyhive knows: membership, prekeys, CGKA. The
    /// whole graph rather than a delta — keyhive's ingest is idempotent and
    /// content-addressed, and a delta would need a per-peer watermark the
    /// engine does not have.
    pub async fn static_events(&self) -> Result<Vec<u8>, String> {
        bincode::serialize(&self.all_events().await).map_err(|e| format!("keyhive events: {e}"))
    }

    /// The static events not yet carried into the keyhive-events tree, each
    /// with the commit id it should travel under (its own digest).
    pub async fn unpublished(&self) -> Result<Vec<(Cref, Vec<u8>)>, String> {
        let mut out = Vec::new();
        for event in self.all_events().await {
            let id = digest(&event);
            if self.published.borrow().contains(&id) {
                continue;
            }
            let bytes = bincode::serialize(&vec![event]).map_err(|e| format!("event: {e}"))?;
            let _published = self.published.borrow_mut().insert(id);
            out.push((id, bytes));
        }
        Ok(out)
    }

    // -- content -------------------------------------------------------------

    /// Seal one automerge change as the sedimentree blob that carries it.
    pub async fn seal(
        &self,
        cref: Cref,
        preds: &[Cref],
        change: Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        let doc = self
            .kh
            .get_document(self.doc.get())
            .await
            .ok_or_else(|| "this device has no keyhive document".to_string())?;
        // Parent keys travel with the change so a later member can read
        // backwards (module docs). A parent whose key we do not hold is not an
        // error: it is a commit this device absorbed but could not open, and
        // authoring on top of it merely means the chain is cut there — for
        // everyone, equally, which is what we would want if it happened.
        let ancestors: HashMap<Cref, SymmetricKey> = {
            let keys = self.chunk_keys.borrow();
            preds
                .iter()
                .filter_map(|parent| keys.get(parent).map(|key| (*parent, *key)))
                .collect()
        };
        let plaintext = bincode::serialize(&Envelope {
            plaintext: change,
            ancestors,
        })
        .map_err(|e| format!("envelope: {e}"))?;

        let (sealed, key) = self
            .kh
            .try_encrypt_content_keyed(doc, &cref, &preds.to_vec(), &plaintext)
            .await
            .map_err(|e| format!("encrypt: {e:?}"))?;
        let _replaced = self.chunk_keys.borrow_mut().insert(cref, key);
        self.store
            .insert(Arc::new(sealed.encrypted_content().clone()))
            .await;
        bincode::serialize(sealed.encrypted_content()).map_err(|e| format!("envelope: {e}"))
    }

    /// Open as many of `blobs` as this device can.
    ///
    /// Two mechanisms, in order. The document's current epoch key opens
    /// anything written since this device joined, and every envelope it opens
    /// yields its parents' content keys. Whatever is left is handed to
    /// keyhive's own causal walk seeded with the content keys this device
    /// holds — from enrollment, or from a descendant opened a moment ago — and
    /// the walk follows each envelope's ancestors down through the ciphertext
    /// store on its own.
    ///
    /// Undecryptable commits are dropped rather than reported: a device that
    /// has not yet ingested the epoch material sees them again on the next
    /// absorb, which is what the keyhive-events tree exists to fix.
    pub async fn open(&self, blobs: Vec<(Cref, Vec<u8>)>) -> Result<Vec<(Cref, Vec<u8>)>, String> {
        let Some(doc) = self.kh.get_document(self.doc.get()).await else {
            // Commits are here but the document's keyhive state is not. Not an
            // error — the keyhive-events tree has not caught up.
            return Ok(Vec::new());
        };
        let wanted: Vec<(Cref, Ciphertext)> = decode(blobs);

        // Refill the ciphertext store before every walk: keyhive EVICTS what it
        // has decrypted (`mark_decrypted`), so the store is a working set and
        // the sedimentree stays the authoritative copy (mined from the archived
        // engine's `apply_new_chunks`).
        for (_, encrypted) in &wanted {
            self.store.insert(Arc::new(encrypted.clone())).await;
        }

        let mut opened: Vec<(Cref, Vec<u8>)> = Vec::new();
        let mut dark: Vec<&(Cref, Ciphertext)> = Vec::new();
        for item in &wanted {
            let (cref, encrypted) = item;
            match self
                .kh
                .try_decrypt_content_keyed(doc.clone(), encrypted)
                .await
            {
                Ok((plain, key)) => {
                    let envelope: Envelope<Cref, Vec<u8>> =
                        bincode::deserialize(&plain).map_err(|e| format!("chunk envelope: {e}"))?;
                    self.remember(*cref, key, &envelope);
                    opened.push((*cref, envelope.plaintext));
                }
                Err(_) => dark.push(item),
            }
        }

        if !dark.is_empty() {
            // Seeded from held keys rather than from a decryptable entrypoint:
            // immediately after enrollment there IS no decryptable entrypoint,
            // which is what the keys handed over at enrollment are for. This is
            // the same walk `Keyhive::try_causal_decrypt_content` runs, entered
            // one level down so the seed can be a key rather than an epoch.
            let mut seeds: Vec<(Arc<Ciphertext>, SymmetricKey)> = {
                let held = self.chunk_keys.borrow();
                dark.iter()
                    .filter_map(|(cref, encrypted)| {
                        held.get(cref)
                            .map(|key| (Arc::new(encrypted.clone()), *key))
                    })
                    .collect()
            };
            if !seeds.is_empty() {
                let walked: CausalDecryptionState<Cref, Vec<u8>> =
                    match CiphertextStoreExt::<Local, Cref, Vec<u8>>::try_causal_decrypt(
                        &self.store,
                        &mut seeds,
                    )
                    .await
                    {
                        Ok(state) => state,
                        // A partial walk is still progress; take what it reached.
                        Err(failed) => failed.progress,
                    };
                // `complete` is already the envelopes' payloads: the walk
                // unwraps each `Envelope` itself (keyhive_core
                // store/ciphertext.rs:222).
                let reached: HashMap<Cref, Vec<u8>> = walked.complete.into_iter().collect();
                let mut learned: Vec<(Cref, SymmetricKey)> = walked.next.into_iter().collect();
                for (cref, _) in &dark {
                    if let Some(plain) = reached.get(cref) {
                        // Keys only for chunks that actually opened: `keys` also
                        // records the key of a ciphertext whose decrypt FAILED,
                        // and keeping one of those would let a later seal name a
                        // parent key that opens nothing.
                        if let Some(key) = walked.keys.get(cref) {
                            learned.push((*cref, *key));
                        }
                        opened.push((*cref, plain.clone()));
                    }
                }
                self.chunk_keys.borrow_mut().extend(learned);
            }
        }
        Ok(opened)
    }

    // -- internals -----------------------------------------------------------

    /// Record a commit's own content key and the ancestor keys its envelope
    /// carried. This map is the read-back state: it only grows, one entry per
    /// commit this device has ever opened, and it is both checkpointed and
    /// handed to the next device enrolled. That growth is the standing cost of
    /// total read-back (see `export_content_keys`) — 64 bytes per commit, and
    /// nothing prunes it, because pruning it is the chain-cut policy decision
    /// this milestone does not make.
    fn remember(&self, cref: Cref, key: SymmetricKey, envelope: &Envelope<Cref, Vec<u8>>) {
        let mut keys = self.chunk_keys.borrow_mut();
        let _replaced = keys.insert(cref, key);
        keys.extend(envelope.ancestors.iter().map(|(a, k)| (*a, *k)));
    }

    async fn all_events(&self) -> Vec<StaticEvent<Cref>> {
        let membership = self.kh.membership_ops_for_all_agents().await;
        let prekeys = self.kh.reachable_prekey_ops_for_all_agents().await;
        let cgka = self.kh.cgka_ops_for_all_agents().await;

        let mut seen: HashSet<[u8; 32]> = HashSet::new();
        let mut events: Vec<StaticEvent<Cref>> = Vec::new();
        let mut push = |event: StaticEvent<Cref>| {
            if seen.insert(digest(&event)) {
                events.push(event);
            }
        };
        for ops in membership.ops.values() {
            for op in ops.values() {
                push(StaticEvent::from(Event::<
                    Local,
                    SigningKey,
                    Cref,
                    NoListener,
                >::from(op.clone())));
            }
        }
        for ops in prekeys.ops.values() {
            for op in ops.iter() {
                push(StaticEvent::from(Event::<
                    Local,
                    SigningKey,
                    Cref,
                    NoListener,
                >::from(
                    op.as_ref().clone()
                )));
            }
        }
        for ops in cgka.ops.values() {
            for op in ops.iter() {
                push(StaticEvent::from(Event::<
                    Local,
                    SigningKey,
                    Cref,
                    NoListener,
                >::from(op.clone())));
            }
        }
        events
    }
}

fn decode(blobs: Vec<(Cref, Vec<u8>)>) -> Vec<(Cref, Ciphertext)> {
    blobs
        .into_iter()
        .filter_map(|(cref, blob)| {
            bincode::deserialize::<Ciphertext>(&blob)
                .ok()
                .map(|encrypted| (cref, encrypted))
        })
        .collect()
}

fn identifier(bytes: [u8; 32]) -> Result<Identifier, String> {
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map(Identifier::from)
        .map_err(|e| format!("not a keyhive identifier: {e}"))
}

fn digest<T: Serialize>(value: &T) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&keyhive_crypto::digest::Digest::hash(value).as_slice()[..32]);
    out
}
