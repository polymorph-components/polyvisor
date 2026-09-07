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
//!
//! Because the ancestry rides in the envelopes, the state a device keeps is a
//! *set of heads* — one `⟨pointer, key⟩` pair per readable branch — and not a
//! key per commit. See [`Vault::advance`].

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
    /// This device's entry points into the group's document: one
    /// `(commit, content key)` pair per head of the readable frontier
    /// (`design/causal_encryption.md` §"Decryption Head"). Secret, and sealed
    /// with the rest of the checkpoint.
    ///
    /// `alias`: an M3c checkpoint wrote the whole key map under `chunk_keys`.
    /// Loading one is harmless — the full map is a superset of the head set,
    /// and the extra entries are pruned the first time their descendants are
    /// opened or sealed.
    #[serde(alias = "chunk_keys", default)]
    pub heads: Vec<(Cref, [u8; 32])>,
}

/// A sealed commit, and what the frontier owes it once it has landed.
///
/// Separate from [`Vault::seal`] because the frontier must not move until
/// the commit is in storage: `advance` prunes the parents whose keys went
/// into this envelope, and if the write then failed those keys would be
/// gone with nothing carrying them — the device would hold a head naming a
/// commit no storage has.
pub struct Sealed {
    pub blob: Vec<u8>,
    cref: Cref,
    key: SymmetricKey,
    embedded: Vec<Cref>,
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
    /// The readable frontier: a content key per head commit, and nothing
    /// below them. See [`VaultState::heads`] and [`Vault::advance`].
    heads: RefCell<HashMap<Cref, SymmetricKey>>,
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
            heads: RefCell::new(HashMap::new()),
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
            heads: RefCell::new(
                state
                    .heads
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
            heads: self
                .heads
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

    /// This device's entry points into the group's document, for the device it
    /// is enrolling.
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
    /// What is handed over is the *frontier*, not a key per commit: one
    /// `⟨pointer, key⟩` pair per readable branch, from which everything
    /// causally prior is discovered by following the ancestor keys inside each
    /// envelope. `design/causal_encryption.md` §"Key Management" is explicit
    /// that keeping them all is "possible, but fragile and unwieldy", and
    /// §"Decryption Head" gives this shape instead. So this grows with live
    /// concurrency and out-of-order delivery, not with history: a linear
    /// history delivered in order hands over one pair however long it is.
    pub fn export_content_keys(&self) -> Result<Vec<u8>, String> {
        let keys: Vec<(Cref, [u8; 32])> = self
            .heads
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
        self.heads.borrow_mut().extend(
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
    /// own pre-pairing content readable *to itself* — and readable to the group
    /// as soon as this device writes once, since that write's envelope names
    /// its old frontier as ancestors.
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

    /// How many entry points into the document this device holds: one per
    /// branch of the readable frontier it cannot reach from another
    /// (`design/causal_encryption.md` §"Multiple Heads"). This is the size of
    /// what the checkpoint carries and what the next device enrolled is
    /// handed, so it is the number this milestone exists to keep small.
    #[must_use]
    pub fn entry_points(&self) -> usize {
        self.heads.borrow().len()
    }

    // -- content -------------------------------------------------------------

    /// Seal one automerge change as the sedimentree blob that carries it.
    pub async fn seal(
        &self,
        cref: Cref,
        preds: &[Cref],
        change: Vec<u8>,
    ) -> Result<Sealed, String> {
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
            let keys = self.heads.borrow();
            preds
                .iter()
                .filter_map(|parent| keys.get(parent).map(|key| (*parent, *key)))
                .collect()
        };
        let embedded: Vec<Cref> = ancestors.keys().copied().collect();
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
        self.store
            .insert(Arc::new(sealed.encrypted_content().clone()))
            .await;
        let blob =
            bincode::serialize(sealed.encrypted_content()).map_err(|e| format!("envelope: {e}"))?;
        Ok(Sealed {
            blob,
            cref,
            key,
            embedded,
        })
    }

    /// The sealed commit is in storage. The frontier moves forward: it becomes
    /// a head, and the parents whose keys went INTO its envelope stop being
    /// ones. They are not lost — they are one hop below a head, which is where
    /// `design/causal_encryption.md` says a key belongs.
    pub fn confirm(&self, sealed: &Sealed) {
        self.advance(
            &[(sealed.cref, sealed.key)],
            sealed.embedded.iter().copied(),
        );
    }

    /// A fragment this device built and stored carries `members` bodily: its
    /// bundle *is* their changes. So their individual keys stop being entry
    /// points, exactly as a parent's does when a child's envelope names it —
    /// the carrier here is the fragment rather than a descendant commit.
    ///
    /// Only sound because the fragment's own envelope is a head (its
    /// [`Vault::confirm`] runs first) and names the *boundary* keys, so the
    /// walk below the fragment continues where the members' envelopes would
    /// have taken it. Called with the members and nothing else: a commit
    /// outside the fragment is not carried by it and must keep its key.
    pub fn cover(&self, members: impl Iterator<Item = Cref>) {
        self.advance(&[], members);
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
    /// `known` is the set of commits the caller has already applied. It is
    /// what makes an ancestor key droppable: a key for a commit this device has
    /// read is carried by the descendant that named it, while a key for a
    /// commit that has *not* arrived is the only way that commit will ever be
    /// opened, so it is kept.
    pub async fn open(
        &self,
        blobs: Vec<(Cref, Vec<u8>)>,
        known: &HashSet<Cref>,
    ) -> Result<Vec<(Cref, Vec<u8>)>, String> {
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
        // Commits that become heads, and commits whose key now rides inside
        // one — collected across the whole batch, applied once at the end.
        let mut reached: Vec<(Cref, SymmetricKey)> = Vec::new();
        let mut covered: HashSet<Cref> = HashSet::new();
        // Ancestor keys read out of the envelopes this batch opened, decided on
        // once at the end.
        let mut ancestors: HashMap<Cref, SymmetricKey> = HashMap::new();
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
                    // Deferred to one `advance` at the end of the batch:
                    // applying insert-then-prune commit by commit would let a
                    // parent opened later in the same batch re-enter the
                    // frontier after its child had already pruned it.
                    reached.push((*cref, key));
                    // Not covered yet: whether an ancestor's key can be dropped
                    // depends on whether that ancestor is reachable, which is
                    // not known until the walk below has run.
                    ancestors.extend(envelope.ancestors.iter().map(|(a, k)| (*a, *k)));
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
            // Seeded from every entry point that can reach into the dark: a
            // held key for a dark commit itself, and — the case that actually
            // carries a partition — a commit just opened under the current
            // epoch whose envelope names dark ancestors. The second is the
            // whole of `design/causal_encryption.md` §"Multiple Heads": a new
            // head supplied for a branch is what connects it, and here the new
            // head arrived as ordinary content.
            let by_cref: HashMap<Cref, &Ciphertext> =
                wanted.iter().map(|(cref, enc)| (*cref, enc)).collect();
            let mut seeds: Vec<(Arc<Ciphertext>, SymmetricKey)> = {
                let held = self.heads.borrow();
                dark.iter()
                    .filter_map(|(cref, encrypted)| {
                        held.get(cref)
                            .map(|key| (Arc::new(encrypted.clone()), *key))
                    })
                    .chain(reached.iter().filter_map(|(cref, key)| {
                        by_cref
                            .get(cref)
                            .map(|enc| (Arc::new((*enc).clone()), *key))
                    }))
                    .collect()
            };
            let seeded: HashSet<Cref> = seeds
                .iter()
                .map(|(encrypted, _)| encrypted.content_ref)
                .collect();
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
                let plaintexts: HashMap<Cref, Vec<u8>> = walked.complete.into_iter().collect();
                // Everything the walk touched below its seeds is covered by
                // definition: it got there by reading a seed's envelope, and so
                // will anyone else who holds that seed. `next` — ancestors whose
                // ciphertext has not arrived yet — is covered for the same
                // reason, which is why a key for a commit we do not hold is not
                // worth keeping either. The seeds themselves stay: they are the
                // frontier the walk descended from.
                // Only what actually opened. `walked.keys` also records the key
                // of a ciphertext whose decrypt FAILED — a corrupt or
                // wrongly-sealed blob — and pruning on one of those would drop a
                // key nothing carries.
                covered.extend(
                    plaintexts
                        .keys()
                        .filter(|cref| !seeded.contains(*cref))
                        .copied(),
                );
                // Ancestors the walk could not reach because their ciphertext is
                // not here yet. Same decision as the envelopes' own ancestors,
                // below.
                ancestors.extend(walked.next.iter().map(|(cref, key)| (*cref, *key)));
                for (cref, _) in &dark {
                    if let Some(plain) = plaintexts.get(cref) {
                        opened.push((*cref, plain.clone()));
                    }
                }
            }
        }
        // The ancestor keys, decided. An ancestor this device can already reach
        // — because it opened in this batch, because it is on the frontier, or
        // because the caller has long since applied it — is covered: its key
        // rides inside the descendant that just named it. An ancestor that has
        // simply not arrived is none of those, and dropping its key would strand
        // it: when its ciphertext turns up in a later batch there would be
        // nothing to seed a walk with, and every descendant already applied
        // would sit in automerge's buffer behind it forever.
        //
        // Keeping it costs one frontier entry per out-of-order arrival, and
        // that entry outlives the arrival: once the commit opens as a seed it
        // stays a head, because the descendant that would cover it was read
        // before it existed here. Bounded by how often delivery runs backwards,
        // not by history.
        {
            let held: HashSet<Cref> = self.heads.borrow().keys().copied().collect();
            let opened_now: HashSet<Cref> = opened.iter().map(|(cref, _)| *cref).collect();
            for (cref, key) in ancestors {
                if opened_now.contains(&cref) || held.contains(&cref) || known.contains(&cref) {
                    let _covered = covered.insert(cref);
                } else {
                    reached.push((cref, key));
                }
            }
        }
        self.advance(&reached, covered.into_iter());
        Ok(opened)
    }

    // -- internals -----------------------------------------------------------

    /// Move the readable frontier: `arrived` become heads, `covered` stop
    /// being ones.
    ///
    /// This is what keeps the entry point a *set of heads* rather than a key
    /// per commit ever seen. `design/causal_encryption.md` §"Key Management"
    /// is blunt that the latter is "possible, but fragile and unwieldy", and
    /// §"Decryption Head" gives the shape that replaces it: a
    /// `⟨pointer, key⟩` pair is an entry point, and everything causally prior
    /// is discovered by following the ancestor keys inside each envelope.
    ///
    /// Pruning is only sound because a covered commit's key demonstrably rides
    /// inside a head's envelope: `seal` prunes exactly the parents it wrote
    /// into `ancestors`, and `open` prunes exactly the crefs it read back out
    /// of one. A parent whose key this device did not hold is therefore never
    /// pruned — there is nothing carrying it.
    ///
    /// Inserts run before removals so that a batch containing both a parent
    /// and its child leaves the child, whatever order they were opened in.
    ///
    /// The frontier is therefore exact for in-order delivery and slightly
    /// conservative for out-of-order delivery: a commit whose key was kept
    /// because it had not arrived stays a head once it does, since the
    /// descendant that would have covered it was read before it got here. One
    /// extra entry per out-of-order arrival, and nothing that is not a
    /// legitimate entry point.
    fn advance(&self, arrived: &[(Cref, SymmetricKey)], covered: impl Iterator<Item = Cref>) {
        let mut heads = self.heads.borrow_mut();
        for (cref, key) in arrived {
            let _replaced = heads.insert(*cref, *key);
        }
        let fresh: HashSet<Cref> = arrived.iter().map(|(cref, _)| *cref).collect();
        for cref in covered {
            if !fresh.contains(&cref) {
                let _dropped = heads.remove(&cref);
            }
        }
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
