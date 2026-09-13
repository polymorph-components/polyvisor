//! The durable store: Google Drive, user-only (internal.wit `storage`,
//! docs/design.md "Storage").
//!
//! Everything the group holds — every sedimentree item of every tree — is
//! written to the user's own Drive as one object per item, under names only
//! the group can derive, in the hidden `appDataFolder` space. The store sees
//! ciphertext at unguessable names and nothing else: app blobs are keyhive
//! envelopes already, and the names carry no id an observer could correlate.
//! Sync through the store is the non-realtime path — a device that was never
//! online at the same moment as its peers still converges by pulling what
//! they pushed.
//!
//! # The API subset this speaks
//!
//! Written down once, here, because `e2e/fake-drive.ts` mirrors exactly this
//! and the native tests' fake (`runtime/crates/kernel/tests/kernel.rs`,
//! `FakeDrive`) implements the same shapes in process. A request the kernel
//! does not make is a request neither fake needs to answer; if this list
//! grows, both follow.
//!
//! OAuth, against `<oauth>` ([`DRIVE_OAUTH`], or `boot-config.drive-oauth`):
//!
//! - `GET <oauth>/auth?client_id&redirect_uri&response_type=code&scope&
//!   code_challenge&code_challenge_method=S256&state&access_type=offline&
//!   prompt=consent` — the authorization URL. The kernel only *builds* it;
//!   the popup is the page's ([`crate::Kernel::oauth_start`]).
//! - `POST <oauth>/token`, `application/x-www-form-urlencoded`:
//!   `grant_type=authorization_code` with `code`, `code_verifier`,
//!   `redirect_uri`, `client_id`, `client_secret`; and
//!   `grant_type=refresh_token` with `refresh_token`, `client_id`,
//!   `client_secret`. Both answer JSON `{access_token, refresh_token?,
//!   expires_in?}`.
//!
//! Drive v3, against `<api>` ([`DRIVE_API`], or `boot-config.drive-api`).
//! Every list is `spaces=appDataFolder`, and `q` is one of exactly two
//! shapes:
//!
//! - `GET <api>/drive/v3/files?q=name = '<name>' and '<parent>' in parents
//!   and trashed = false&fields=nextPageToken,files(id,name)&pageSize=1000&
//!   spaces=appDataFolder[&pageToken=…]` — resolve a name;
//! - the same with `q='<parent>' in parents and trashed = false` — list the
//!   folder, following `nextPageToken`.
//! - `POST <api>/drive/v3/files?fields=id`, JSON `{name, mimeType, parents}`
//!   — create the folder.
//! - `POST <api>/upload/drive/v3/files?uploadType=multipart&fields=id`,
//!   `multipart/related` of a JSON metadata part `{name, parents}` and an
//!   `application/octet-stream` media part — create an object.
//! - `GET <api>/drive/v3/files/<id>?alt=media` — read one;
//! - `DELETE <api>/drive/v3/files/<id>` — remove one (204 or an idempotent
//!   404).
//!
//! An unknown bearer answers 401, which is what drives the one refresh
//! attempt ([`Kernel::drive_request`]). Objects are never updated. Opaque
//! payloads are deleted after their lifecycle register retires them; ordinary
//! sedimentree history remains append-only.

use std::collections::BTreeSet;
use std::rc::Rc;

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use hmac::{Hmac, Mac as _};
use polyvisor_engine::{ItemKind, StoreItem, is_opaque_tree};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{Checkpointing, Error, ErrorCode, Kernel};

/// Google's own, when `boot-config` names no other. The authorization
/// endpoint and the token endpoint are on two different hosts at Google, so
/// they are two constants; an override collapses them to one base with
/// `/auth` and `/token` under it, which is what the fake serves.
pub const DRIVE_API: &str = "https://www.googleapis.com";
pub const DRIVE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const DRIVE_TOKEN: &str = "https://oauth2.googleapis.com/token";
/// The hidden per-app space. Narrower than `drive.file`: it cannot reach
/// anything in the user's Drive, and Drive itself refuses to share what is in
/// it — so "user-only" is the platform's rule here, not a promise this code
/// makes about itself (docs/design.md "Storage").
const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
/// The space's own reserved parent alias: parentage is what places a file in
/// a space.
const APP_DATA: &str = "appDataFolder";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
/// The `multipart/related` boundary. Fixed and local: every media part here
/// is a signed envelope or a keyhive envelope, in which this token cannot
/// appear by accident at any meaningful probability.
const BOUNDARY: &str = "polyvisordrive1f4a2e7c";
/// Drive's cap, and the page loop follows `nextPageToken` regardless.
const PAGE_SIZE: u32 = 1000;

/// `polyvisor:internal/lifecycle.boot-config`'s store half.
pub struct Config {
    /// The OAuth redirect: this page's URL, without query or fragment.
    pub page_url: String,
    pub api: Option<String>,
    pub oauth: Option<String>,
}

impl Config {
    fn api(&self) -> &str {
        self.api.as_deref().unwrap_or(DRIVE_API)
    }

    fn auth_url(&self) -> String {
        match &self.oauth {
            Some(base) => format!("{}/auth", base.trim_end_matches('/')),
            None => DRIVE_AUTH.to_string(),
        }
    }

    fn token_url(&self) -> String {
        match &self.oauth {
            Some(base) => format!("{}/token", base.trim_end_matches('/')),
            None => DRIVE_TOKEN.to_string(),
        }
    }
}

/// What `Fetch::request` answers: a status, headers, and a body. A status the
/// caller dislikes is an answer — see [`crate::Fetch`].
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The user's consent, as it rests: sealed in the checkpoint beside the
/// device seed and never anywhere else. A bearer must not exist in page
/// memory or cross the port (internal.wit `storage`), which is why the whole
/// ceremony happens in here and only the one-shot code crosses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    /// The installed-app client pair the consent was given for. Kept with the
    /// tokens because a refresh needs it and nothing else holds it.
    pub client_id: String,
    pub client_secret: String,
    /// Epoch milliseconds; 0 when the token endpoint said nothing about it.
    pub expires_at_ms: u64,
}

/// The store's checkpointed half.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sealed {
    pub tokens: Option<Tokens>,
    pub last_pull: u64,
    pub last_push: u64,
}

/// `polyvisor:internal/storage.binding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub provider: String,
    /// Framework voice — see [`Drive::state`].
    pub state: String,
    pub last_pull: u64,
    pub last_push: u64,
}

/// A consent ceremony in flight. One at a time: a second `oauth-start`
/// replaces the first, because the state a popup comes back with must name
/// the verifier it was minted beside or the exchange is a different ceremony.
struct Ceremony {
    verifier: String,
    state: String,
    client_id: String,
    client_secret: String,
}

/// Why the last sync did not finish.
enum Trouble {
    /// The tokens no longer work and a refresh did not fix it. The user has
    /// to consent again; nothing retries this on its own.
    Reauthorize(String),
    /// Anything else — the network, a 500, a body that did not parse. The
    /// next trigger tries again (there is no timer in this runtime, so the
    /// next mutation or `sync-now` is the retry).
    Hiccup(String),
}

/// Everything the store keeps.
#[derive(Default)]
pub struct Drive {
    tokens: Option<Tokens>,
    last_pull: u64,
    last_push: u64,
    pending: Option<Ceremony>,
    trouble: Option<Trouble>,
    /// The group's folder id, and the name key it was resolved under. Ids are
    /// public addressing and re-resolvable in one list, so this is a cache and
    /// never state: a worker that lost it costs one request.
    ///
    /// **Keyed by the name key, and that is the whole point.** Pairing
    /// replaces the group and its name key at once (`Engine::adopt_us`), so a
    /// folder id resolved before an adoption names the *previous* group's
    /// folder — this device's own group of one. Kept unkeyed, the next pass
    /// listed that folder, found this device's own pre-pairing objects under
    /// names the new key does not derive, took them for a peer's, and
    /// installed them: the group-of-one commits `adopt_us` had just deleted
    /// came back through the store and overwrote the adopted group document.
    /// The device then held a group of one again, checkpointed it, and read
    /// every real member's item as an outsider's.
    folder: Option<([u8; 32], String)>,
    /// Object ids whose bytes were not an item at all. Beside `folder` and
    /// for the same reason — a cache, not state: the folder is the user's own
    /// Drive and something else may have left a file in it, and without this
    /// every sync for the rest of the worker's life would download it again
    /// to reach the same conclusion. Dropped on a reload, which costs one
    /// read and is the honest answer if the object changed.
    rejected: BTreeSet<String>,
}

impl Drive {
    pub fn restore(sealed: Option<Sealed>) -> Drive {
        let Some(sealed) = sealed else {
            return Drive::default();
        };
        Drive {
            tokens: sealed.tokens,
            last_pull: sealed.last_pull,
            last_push: sealed.last_push,
            ..Drive::default()
        }
    }

    /// What rides the next checkpoint. `None` for a device that has never
    /// connected, so a checkpoint carries no empty record.
    pub fn sealed(&self) -> Option<Sealed> {
        self.tokens.as_ref()?;
        Some(Sealed {
            tokens: self.tokens.clone(),
            last_pull: self.last_pull,
            last_push: self.last_push,
        })
    }

    pub fn bound(&self) -> bool {
        self.tokens.is_some()
    }

    /// The framework-voice state line internal.wit `storage.binding.state`
    /// describes. ("connected as <email>" is unused: this device asks for
    /// `drive.appdata` and nothing else, so it is never told the address.)
    fn state(&self) -> String {
        match (&self.tokens, &self.trouble) {
            (None, _) => "not connected".to_string(),
            (Some(_), Some(Trouble::Reauthorize(why))) => {
                format!("needs re-authorization: {why}")
            }
            (Some(_), Some(Trouble::Hiccup(why))) => {
                format!("connected; the last sync did not finish: {why}")
            }
            (Some(_), None) => "connected".to_string(),
        }
    }

    fn binding(&self) -> Binding {
        Binding {
            provider: "gdrive".to_string(),
            state: self.state(),
            last_pull: self.last_pull,
            last_push: self.last_push,
        }
    }
}

// -- the exports -------------------------------------------------------------

impl Kernel {
    /// How many sedimentree fragments this device holds over one tree — the
    /// app's, or (`None`) the group document's. A fragment is a commit range
    /// carried as one item (`docs/design.md` §"Read-back and partitions").
    ///
    /// Test introspection: which commit closes a fragment is the hash's
    /// decision, so a test that
    /// wants the compacted case has to write until one appears and cannot
    /// predict the number. Nothing in the WIT world reads this.
    ///
    /// Per-tree because the two have nothing to do with each other: an app's
    /// fragments arrive on the hash's schedule, while the group document gets
    /// exactly one the moment a device adopts it (`Engine::adopt_fragment`).
    #[must_use]
    pub fn fragments_held(&self, app: Option<&str>) -> usize {
        let tree = match app {
            Some(app) => *polyvisor_engine::document_tree(app).as_bytes(),
            None => *polyvisor_engine::us_tree().as_bytes(),
        };
        self.engine().map_or(0, |engine| {
            engine
                .items()
                .iter()
                .filter(|item| item.tree == tree && item.kind == ItemKind::Fragment)
                .count()
        })
    }

    /// `storage.status`.
    pub fn storage_status(&self) -> Result<Binding, Error> {
        self.open()?;
        Ok(self.drive.borrow().binding())
    }

    /// `storage.oauth-start`: mint a PKCE ceremony and answer the URL the
    /// popup opens. The redirect is `boot-config.page-url` — the kernel never
    /// sees a window, so the glue's own URL is the only one it can name.
    pub fn oauth_start(&self, client_id: String, client_secret: String) -> Result<String, Error> {
        self.open()?;
        if client_id.trim().is_empty() {
            return Err(Error::new(
                ErrorCode::Refused,
                "a Google OAuth client id is needed before this device can connect a store",
            ));
        }
        // 32 bytes, base64url: RFC 7636 §4.1 allows 43–128 characters of the
        // unreserved set, and 32 bytes of randomness is 43 of them.
        let mut verifier_bytes = [0u8; 32];
        self.seams.rng.fill(&mut verifier_bytes);
        let verifier = BASE64URL_NOPAD.encode(&verifier_bytes);
        let challenge = BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes()));
        let mut state_bytes = [0u8; 16];
        self.seams.rng.fill(&mut state_bytes);
        let state = HEXLOWER.encode(&state_bytes);

        let url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}\
             &code_challenge={}&code_challenge_method=S256&state={}\
             &access_type=offline&prompt=consent",
            self.drive_config.auth_url(),
            query(&client_id),
            query(&self.drive_config.page_url),
            query(SCOPE),
            query(&challenge),
            query(&state),
        );
        self.drive.borrow_mut().pending = Some(Ceremony {
            verifier,
            state,
            client_id,
            client_secret,
        });
        Ok(url)
    }

    /// `storage.oauth-complete`: the popup came back. Check the state,
    /// exchange the one-shot code for tokens, seal them.
    pub async fn oauth_complete(self: &Rc<Self>, code: String, state: String) -> Result<(), Error> {
        self.open()?;
        let ceremony = {
            let mut drive = self.drive.borrow_mut();
            match drive.pending.take() {
                // Taken, not borrowed: a code is one-shot, so a second
                // `oauth-complete` for the same ceremony must not find a
                // verifier to try it with.
                Some(ceremony) if ceremony.state == state => ceremony,
                Some(ceremony) => {
                    // Put it back: a `state` that does not match is not this
                    // ceremony's popup, and it does not get to cancel one.
                    drive.pending = Some(ceremony);
                    return Err(Error::new(
                        ErrorCode::Refused,
                        "that sign-in answer does not belong to the request this device made",
                    ));
                }
                None => {
                    return Err(Error::new(
                        ErrorCode::Refused,
                        "this device is not waiting for a sign-in",
                    ));
                }
            }
        };
        let form = form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("code_verifier", &ceremony.verifier),
            ("redirect_uri", &self.drive_config.page_url),
            ("client_id", &ceremony.client_id),
            ("client_secret", &ceremony.client_secret),
        ]);
        let issued = self
            .token_request(form)
            .await
            .map_err(|failure| Error::new(ErrorCode::Failed, failure.why()))?;
        let refresh = issued.refresh_token.ok_or_else(|| {
            // Without one this device is connected until the access token
            // lapses and then silently is not. Google issues one for
            // `access_type=offline&prompt=consent`, which is what the
            // authorization URL asks for.
            Error::new(
                ErrorCode::Failed,
                "that sign-in returned no refresh token, so this device could not stay connected",
            )
        })?;
        {
            let mut drive = self.drive.borrow_mut();
            drive.tokens = Some(Tokens {
                access: issued.access_token,
                refresh,
                client_id: ceremony.client_id,
                client_secret: ceremony.client_secret,
                expires_at_ms: expiry(self.seams.clock.now_ms(), issued.expires_in),
            });
            drive.trouble = None;
            // Both caches are the previous connection's: a different account
            // has a different folder, and an object this one could not read
            // is not this one's answer.
            drive.folder = None;
            drive.rejected.clear();
        }
        // Sealed at once, and the sync that follows is the checkpoint gate's
        // (see `Kernel::checkpoint`): a consent that survived only in worker
        // memory would be one the user has to give again after a reload.
        self.checkpoint().await
    }

    /// `storage.disconnect`: forget the tokens. The store keeps everything it
    /// has — forgetting an account is not deleting what it holds, and the
    /// group's other devices are still writing there.
    pub async fn storage_disconnect(&self) -> Result<(), Error> {
        self.open()?;
        *self.drive.borrow_mut() = Drive::default();
        self.checkpoint().await
    }

    /// `storage.sync-now`, and every unprompted run: push what the store
    /// lacks, then pull what this device lacks.
    ///
    /// Asked for, so it tries again whatever the last pass concluded: this is
    /// the one entry a person drives, and "needs re-authorization" is exactly
    /// the state someone presses "sync now" to find out about again (the
    /// unprompted triggers do not — see [`Kernel::schedule_store_sync`]).
    pub async fn sync_now(self: &Rc<Self>) -> Result<(), Error> {
        self.open()?;
        self.drive.borrow_mut().trouble = None;
        self.sync_gated().await
    }

    /// Gated exactly as [`Kernel::checkpoint`] is: one pass in flight, and a
    /// request that arrives during one is coalesced into a single further
    /// pass. Two overlapping passes would push the same item twice — the
    /// listing each read is stale the moment the other creates an object.
    async fn sync_gated(self: &Rc<Self>) -> Result<(), Error> {
        {
            let mut gate = self.syncing.borrow_mut();
            if gate.running {
                gate.dirty = true;
                return Ok(());
            }
            gate.running = true;
        }
        let result = self.sync_loop().await;
        *self.syncing.borrow_mut() = Checkpointing::default();
        result
    }

    /// Schedule a pass and return. The trigger after every local mutation, at
    /// boot and at unseal: all paths that must not wait on a network, and
    /// none of which has anyone to tell if the store is unreachable — the
    /// state line says so at the next `storage.status`.
    ///
    /// Not scheduled while the store is waiting for a re-authorization: that
    /// state ends only when the user acts, so every mutation until then would
    /// spend a round trip re-proving a token the endpoint has already
    /// refused. `oauth-complete` and `sync-now` are the two acts that clear
    /// it, and both are the user's.
    pub(crate) fn schedule_store_sync(&self) {
        {
            let drive = self.drive.borrow();
            if !drive.bound() || matches!(drive.trouble, Some(Trouble::Reauthorize(_))) {
                return;
            }
        }
        let Some(kernel) = self.me.borrow().upgrade() else {
            return;
        };
        self.seams.spawn.spawn(Box::pin(async move {
            let _synced = kernel.sync_gated().await;
        }));
    }

    // -- the pass ------------------------------------------------------------

    async fn sync_loop(self: &Rc<Self>) -> Result<(), Error> {
        loop {
            self.syncing.borrow_mut().dirty = false;
            self.sync_once().await?;
            if !self.syncing.borrow().dirty {
                return Ok(());
            }
        }
    }

    /// One push and one pull. Failures land in the state line rather than
    /// unwinding the caller: `sync-now` is also the boot trigger and the
    /// after-a-mutation trigger, and neither has a caller who could act on an
    /// error — the mutation itself succeeded.
    async fn sync_once(self: &Rc<Self>) -> Result<(), Error> {
        if !self.drive.borrow().bound() {
            return Ok(());
        }
        let engine = self.engine()?;
        // No name key is no group document, and a device with no group has
        // nothing a second device of the group could want (see
        // `Engine::name_key`).
        let Some(name_key) = engine.name_key() else {
            return Ok(());
        };
        match self.sync_attempt(&name_key).await {
            Ok(ingested) => {
                self.drive.borrow_mut().trouble = None;
                if ingested {
                    // Store imports bypass the engine's live event pump, so
                    // perform the same UI notifications here after apply.
                    let apps: Vec<String> = self.sessions.borrow().values().cloned().collect();
                    for app in apps {
                        self.wake_documents(&app);
                    }
                    let _ = self.refresh_personalization().await;
                    self.push_event(crate::Event::PersonalizationChanged);
                    self.push_event(crate::Event::ContactsChanged);
                    // What the store handed back is now this device's, and a
                    // reload must not have to fetch it again. This checkpoint
                    // schedules one more pass through the gate above, which
                    // finds nothing new and stops.
                    self.checkpoint().await?;
                }
                Ok(())
            }
            Err(trouble) => {
                self.drive.borrow_mut().trouble = Some(trouble);
                Ok(())
            }
        }
    }

    /// Pull control, pull eligible opaque content, push control then content,
    /// and finally clean up validated retired opaque objects. Answers whether
    /// either pull landed anything.
    ///
    /// The order matters, and it is the read-back order
    /// (`docs/design.md` §"Read-back and partitions"). A device coming back
    /// online holds writes sealed under whatever epoch it last knew. If it
    /// pushed first, those objects would reach the store ahead of any head that
    /// connects them, and a member enrolled since would find them
    /// undecryptable. Pulling first means this device ingests the group's
    /// current keyhive state and merges before it publishes, so where its
    /// writes are *concurrent* with the group's they go up alongside the merge
    /// anchor that names their keys.
    ///
    /// It does not close the linear case, and that is worth naming rather than
    /// implying: a device that was merely behind — its writes sit on top of
    /// what the group already had, so the ingest produces no divergence and no
    /// anchor — pushes commits that a later-enrolled member still cannot open
    /// until somebody writes on top of them. That write happens on the next
    /// local mutation, whose envelope names this frontier; until then the
    /// branch is latency, not loss.
    async fn sync_attempt(self: &Rc<Self>, name_key: &[u8; 32]) -> Result<bool, Trouble> {
        let folder = self.drive_folder(name_key).await?;
        let engine = self
            .engine()
            .map_err(|e| Trouble::Hiccup(e.message.clone()))?;

        let remote = self.drive_list(&folder).await?;

        // Names reveal nothing about object kind. Download the unknown batch,
        // then separate lifecycle control from opaque payload. In particular,
        // do not cache an opaque object merely because its slot is unknown:
        // the control object in this same or a later pass can make it eligible.
        let held: BTreeSet<String> = engine
            .items()
            .iter()
            .map(|item| object_name(name_key, &item.tree, &item.commit, item.kind))
            .chain(
                engine
                    .read_not_held()
                    .iter()
                    .map(|(tree, commit)| object_name(name_key, tree, commit, ItemKind::Commit)),
            )
            .collect();
        let mut downloaded = Vec::new();
        for (id, name) in &remote {
            if engine.name_key().as_ref() != Some(name_key) {
                return Ok(false);
            }
            if held.contains(name) || self.drive.borrow().rejected.contains(id) {
                continue;
            }
            let Some(bytes) = self.drive_read(id).await? else {
                continue;
            };
            // An object that does not decode is skipped, not fatal: this
            // folder is the user's own Drive and something else may have put
            // a file in it. The items that do decode still land — and the id
            // is remembered, so the next pass does not fetch it again to
            // reach the same conclusion.
            match serde_json::from_slice::<StoreItem>(&bytes) {
                Ok(item) => downloaded.push((id.clone(), name.clone(), item)),
                Err(_) => {
                    let _first = self.drive.borrow_mut().rejected.insert(id.clone());
                }
            }
        }
        // The group this pass was reading for must still be this device's
        // group. Pairing replaces both at once — the group document and the
        // name key with it (`Engine::adopt_us`) — so a pass that started before
        // that landed is holding objects named under the group this device has
        // just *stopped* being: its own group of one. Installing them would put
        // the commits `adopt_us` deliberately removed back into the adopted
        // document's tree, which is the one thing that function exists to
        // prevent, and the device would end up in neither group cleanly.
        //
        // Checked before the push as well as the pull, and for the mirror
        // reason: the push writes objects under `name_key`, and a device that
        // has just joined a group must not scatter its abandoned group-of-one's
        // commits into that group's folder under the old names. The pass is
        // dropped; the next one reads and writes the new group's names.
        if engine.name_key().as_ref() != Some(name_key) {
            return Ok(false);
        }

        // The user-system register is ordinary signed sedimentree control, so
        // it is indistinguishable by HMAC name and has to be decoded first.
        // Ingest all non-opaque items before making any payload decision; the
        // engine orders keyhive and `us` internally.
        let control: Vec<StoreItem> = downloaded
            .iter()
            .filter(|(_, _, item)| !is_opaque_tree(&item.tree))
            .map(|(_, _, item)| item.clone())
            .collect();
        let mut landed = if control.is_empty() {
            false
        } else {
            engine
                .ingest_items(control)
                .await
                .map_err(Trouble::Hiccup)?
        };
        if engine.name_key().as_ref() != Some(name_key) {
            return Ok(landed);
        }

        let payload: Vec<StoreItem> = downloaded
            .iter()
            .filter(|(_, name, item)| {
                is_opaque_tree(&item.tree)
                    && *name == object_name(name_key, &item.tree, &item.commit, item.kind)
                    && engine.valid_store_item(item)
                    && engine.opaque_status(&item.tree) == Some(true)
            })
            .map(|(_, _, item)| item.clone())
            .collect();
        if !payload.is_empty() {
            landed |= engine
                .ingest_items(payload)
                .await
                .map_err(Trouble::Hiccup)?;
        }
        if landed {
            self.drive.borrow_mut().last_pull = self.seams.clock.now_ms();
        }

        // Push: control first, then opaque payload. One object per item the store lacks, and never a second
        // upload of a name it has — the name *is* the item's digest pair, so
        // an object that exists is already these bytes. Read after the pull,
        // so a merge anchor the ingest just authored goes up in this same
        // pass rather than waiting for the next one.
        let mut present: BTreeSet<String> = remote.iter().map(|(_, name)| name.clone()).collect();
        let us = *polyvisor_engine::us_tree().as_bytes();

        // A lifecycle mutation can happen while any POST is awaiting Drive.
        // Keep refreshing the user-system batch until every currently held
        // control object is physically present. This is the barrier before
        // opaque content and, separately below, before each cleanup.
        let mut pushed = self
            .drive_push_control(&engine, name_key, &folder, &mut present)
            .await?;

        for item in engine.items().into_iter().filter(|item| item.tree != us) {
            if engine.name_key().as_ref() != Some(name_key) {
                return Ok(landed);
            }
            if !engine.item_publishable(&item) {
                continue;
            }
            let name = object_name(name_key, &item.tree, &item.commit, item.kind);
            if present.contains(&name) {
                continue;
            }
            let body = serde_json::to_vec(&item)
                .map_err(|e| Trouble::Hiccup(format!("an item could not be written: {e}")))?;
            let id = self.drive_create(&folder, &name, body).await?;
            present.insert(name);
            pushed = true;
            // Publication can race a replacement while the POST is in flight.
            // The returned id is the only safe way to retire that exact object
            // without waiting for another listing.
            if engine.name_key().as_ref() != Some(name_key) {
                // Group adoption invalidates the old pass, but does not grant
                // authority to erase ordinary history (or even old-group
                // opaque content) from the folder resolved under the old key.
                // Leave the completed upload in that old group and retry only
                // the new group on the next pass.
                return Ok(landed);
            }
            if is_opaque_tree(&item.tree) && !engine.item_publishable(&item) {
                self.drive_push_control(&engine, name_key, &folder, &mut present)
                    .await?;
                if engine.name_key().as_ref() != Some(name_key) {
                    return Ok(landed);
                }
                if engine.opaque_status(&item.tree) == Some(false) {
                    self.drive_delete(&id).await?;
                }
            }
        }
        if pushed {
            self.drive.borrow_mut().last_push = self.seams.clock.now_ms();
        }

        // Delete only objects proved to be ours: the HMAC name agrees with the
        // signed item, every signed-field/blob check passes, and final control
        // says the opaque tree is obsolete. Unknown lifecycle state is left
        // alone and retried on the next pass.
        for (id, name, item) in downloaded {
            if engine.name_key().as_ref() != Some(name_key) {
                return Ok(landed);
            }
            if is_opaque_tree(&item.tree)
                && name == object_name(name_key, &item.tree, &item.commit, item.kind)
                && engine.valid_store_item(&item)
                && engine.opaque_status(&item.tree) == Some(false)
            {
                self.drive_push_control(&engine, name_key, &folder, &mut present)
                    .await?;
                if engine.name_key().as_ref() != Some(name_key) {
                    return Ok(landed);
                }
                if engine.opaque_status(&item.tree) == Some(false) {
                    self.drive_delete(&id).await?;
                }
            }
        }

        Ok(landed)
    }

    /// Upload the current user-system item batch and repeat if it changed
    /// while a POST was in flight. Returning is the control-before-content /
    /// control-before-delete barrier for this pass.
    async fn drive_push_control(
        self: &Rc<Self>,
        engine: &Rc<polyvisor_engine::Engine<polyvisor_engine::DynTransport>>,
        name_key: &[u8; 32],
        folder: &str,
        present: &mut BTreeSet<String>,
    ) -> Result<bool, Trouble> {
        let us = *polyvisor_engine::us_tree().as_bytes();
        let mut pushed = false;
        loop {
            if engine.name_key().as_ref() != Some(name_key) {
                return Ok(pushed);
            }
            // The register becomes visible to admission before its signed us
            // commit is submitted. Wait for that submission before taking the
            // batch that authorizes any following content upload or deletion.
            engine.control_barrier().await.map_err(Trouble::Hiccup)?;
            if engine.name_key().as_ref() != Some(name_key) {
                return Ok(pushed);
            }
            let revision = engine.control_revision();
            let control: Vec<StoreItem> = engine
                .items()
                .into_iter()
                .filter(|item| item.tree == us && engine.item_publishable(item))
                .collect();
            for item in control {
                let name = object_name(name_key, &item.tree, &item.commit, item.kind);
                if present.contains(&name) {
                    continue;
                }
                let body = serde_json::to_vec(&item)
                    .map_err(|e| Trouble::Hiccup(format!("an item could not be written: {e}")))?;
                self.drive_create(folder, &name, body).await?;
                present.insert(name);
                pushed = true;
                if engine.name_key().as_ref() != Some(name_key) {
                    return Ok(pushed);
                }
            }
            if engine.control_revision() != revision {
                continue;
            }
            // Stable revision means the batch just scanned still represents
            // current control, and every absent object in it was uploaded.
            return Ok(pushed);
        }
    }

    // -- the Drive client ----------------------------------------------------

    /// The group's folder id, resolved once and created if absent.
    ///
    /// Resolve-then-create is not atomic (Drive offers no compare-and-swap),
    /// so two devices of one account running their first sync at the same
    /// moment can each create a folder and thereafter write into different
    /// ones. The symptom is a slow convergence, not corruption: both folders
    /// hold correctly named items and the loser's are picked up as soon as
    /// either device resolves the other. Closing it properly wants a
    /// de-duplication pass, which is a design call and not a comment.
    async fn drive_folder(self: &Rc<Self>, name_key: &[u8; 32]) -> Result<String, Trouble> {
        if let Some((cached_key, id)) = self.drive.borrow().folder.clone()
            && &cached_key == name_key
        {
            return Ok(id);
        }
        let name = folder_name(name_key);
        let found = self
            .drive_query(&format!(
                "name = '{}' and '{APP_DATA}' in parents and trashed = false",
                literal(&name)
            ))
            .await?;
        let id = match found.into_iter().next() {
            Some((id, _)) => id,
            None => {
                let meta = serde_json::json!({
                    "name": name,
                    "mimeType": FOLDER_MIME,
                    "parents": [APP_DATA],
                })
                .to_string();
                let response = self
                    .drive_request(
                        "POST",
                        format!("{}/drive/v3/files?fields=id", self.drive_config.api()),
                        vec![("content-type".to_string(), "application/json".to_string())],
                        meta.into_bytes(),
                    )
                    .await?;
                let value = json(&response, "create the store's folder")?;
                value
                    .get("id")
                    .and_then(|id| id.as_str())
                    .ok_or_else(|| {
                        Trouble::Hiccup("the store answered a folder with no id".to_string())
                    })?
                    .to_string()
            }
        };
        {
            let mut drive = self.drive.borrow_mut();
            drive.folder = Some((*name_key, id.clone()));
            // The rejected ids were that folder's: an id names a file in one
            // Drive, and nothing says the two folders number theirs apart.
            drive.rejected.clear();
        }
        Ok(id)
    }

    /// Every `(id, name)` in the folder.
    async fn drive_list(self: &Rc<Self>, folder: &str) -> Result<Vec<(String, String)>, Trouble> {
        self.drive_query(&format!(
            "'{}' in parents and trashed = false",
            literal(folder)
        ))
        .await
    }

    /// `files.list`, following `nextPageToken`.
    async fn drive_query(self: &Rc<Self>, q: &str) -> Result<Vec<(String, String)>, Trouble> {
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!(
                "{}/drive/v3/files?q={}&fields={}&pageSize={PAGE_SIZE}&spaces={APP_DATA}",
                self.drive_config.api(),
                query(q),
                query("nextPageToken,files(id,name)"),
            );
            if let Some(token) = &page {
                url.push_str(&format!("&pageToken={}", query(token)));
            }
            let response = self
                .drive_request("GET", url, Vec::new(), Vec::new())
                .await?;
            let value = json(&response, "list the store")?;
            if let Some(files) = value.get("files").and_then(|f| f.as_array()) {
                for file in files {
                    let (Some(id), Some(name)) = (
                        file.get("id").and_then(|v| v.as_str()),
                        file.get("name").and_then(|v| v.as_str()),
                    ) else {
                        continue;
                    };
                    out.push((id.to_string(), name.to_string()));
                }
            }
            page = value
                .get("nextPageToken")
                .and_then(|t| t.as_str())
                .map(str::to_string);
            if page.is_none() {
                return Ok(out);
            }
        }
    }

    /// One object, created. Never an update: see the module docs.
    async fn drive_create(
        self: &Rc<Self>,
        folder: &str,
        name: &str,
        body: Vec<u8>,
    ) -> Result<String, Trouble> {
        let meta = serde_json::json!({ "name": name, "parents": [folder] }).to_string();
        let mut multipart = Vec::new();
        multipart.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
            )
            .as_bytes(),
        );
        multipart.extend_from_slice(
            format!("--{BOUNDARY}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
        );
        multipart.extend_from_slice(&body);
        multipart.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let response = self
            .drive_request(
                "POST",
                format!(
                    "{}/upload/drive/v3/files?uploadType=multipart&fields=id",
                    self.drive_config.api()
                ),
                vec![(
                    "content-type".to_string(),
                    format!("multipart/related; boundary={BOUNDARY}"),
                )],
                multipart,
            )
            .await?;
        json(&response, "write to the store")?
            .get("id")
            .and_then(|id| id.as_str())
            .map(str::to_string)
            .ok_or_else(|| Trouble::Hiccup("the store answered an object with no id".to_string()))
    }

    /// Delete one object. A missing object means this cleanup already landed,
    /// either in an earlier pass or on another device.
    async fn drive_delete(self: &Rc<Self>, id: &str) -> Result<(), Trouble> {
        let response = self
            .drive_request(
                "DELETE",
                format!("{}/drive/v3/files/{}", self.drive_config.api(), query(id)),
                Vec::new(),
                Vec::new(),
            )
            .await?;
        match response.status {
            200..=299 | 404 => Ok(()),
            status => Err(refusal(status, "delete from the store").unwrap_or_else(|| {
                Trouble::Hiccup(format!("the store answered {status} deleting an object"))
            })),
        }
    }

    /// One object's bytes. `None` for a 404: an object that went away between
    /// the listing and the read is a race, not a failure.
    async fn drive_read(self: &Rc<Self>, id: &str) -> Result<Option<Vec<u8>>, Trouble> {
        let response = self
            .drive_request(
                "GET",
                format!(
                    "{}/drive/v3/files/{}?alt=media",
                    self.drive_config.api(),
                    query(id)
                ),
                Vec::new(),
                Vec::new(),
            )
            .await?;
        // 404 is the race between the listing and the read, and it is the
        // only status here that is not a failure. Everything else follows the
        // same rule `json` applies, including the 401 that survived the one
        // refresh: a body this call does not parse must not classify
        // differently from one that does.
        match response.status {
            200 => Ok(Some(response.body)),
            404 => Ok(None),
            status => Err(refusal(status, "read from the store").unwrap_or_else(|| {
                Trouble::Hiccup(format!("the store answered {status} reading an object"))
            })),
        }
    }

    /// One authorized request, with the single refresh a 401 buys.
    ///
    /// Once, deliberately: a second 401 after a fresh access token is not a
    /// token problem, and a loop would spend the user's quota re-proving it.
    /// A refresh that itself fails is the one failure that stops retrying on
    /// its own — the user has to consent again, and the state line says so.
    async fn drive_request(
        self: &Rc<Self>,
        method: &str,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<HttpResponse, Trouble> {
        // The recorded expiry is used as a cheap pre-check, not as the
        // authority: clocks skew and Google's answer is what decides.
        let stale = {
            let drive = self.drive.borrow();
            drive.tokens.as_ref().is_some_and(|tokens| {
                tokens.expires_at_ms != 0 && self.seams.clock.now_ms() >= tokens.expires_at_ms
            })
        };
        if stale {
            self.refresh_tokens().await?;
        }
        let response = self
            .authorized(method, &url, &headers, body.clone())
            .await?;
        if response.status != 401 {
            return Ok(response);
        }
        self.refresh_tokens().await?;
        self.authorized(method, &url, &headers, body).await
    }

    async fn authorized(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<HttpResponse, Trouble> {
        let access = self
            .drive
            .borrow()
            .tokens
            .as_ref()
            .map(|tokens| tokens.access.clone())
            .ok_or_else(|| Trouble::Reauthorize("this device is not connected".to_string()))?;
        let mut headers = headers.to_vec();
        headers.push(("authorization".to_string(), format!("Bearer {access}")));
        self.seams
            .fetch
            .request(method.to_string(), url.to_string(), headers, body)
            .await
            .map_err(Trouble::Hiccup)
    }

    /// Trade the refresh token for a new access token, and keep a rotated
    /// refresh token when Google issues one.
    async fn refresh_tokens(self: &Rc<Self>) -> Result<(), Trouble> {
        let tokens = self
            .drive
            .borrow()
            .tokens
            .clone()
            .ok_or_else(|| Trouble::Reauthorize("this device is not connected".to_string()))?;
        let form = form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &tokens.refresh),
            ("client_id", &tokens.client_id),
            ("client_secret", &tokens.client_secret),
        ]);
        // The classification the two kinds exist for: an endpoint that
        // refused this refresh token is a consent that is gone, and only a
        // new one fixes it; an endpoint nothing reached is the network, and
        // the next trigger retries.
        let issued = self
            .token_request(form)
            .await
            .map_err(|failure| match failure {
                TokenFailure::Refused(why) => Trouble::Reauthorize(why),
                TokenFailure::Unreachable(why) => Trouble::Hiccup(why),
            })?;
        {
            let mut drive = self.drive.borrow_mut();
            if let Some(held) = drive.tokens.as_mut() {
                held.access = issued.access_token;
                if let Some(rotated) = issued.refresh_token {
                    held.refresh = rotated;
                }
                held.expires_at_ms = expiry(self.seams.clock.now_ms(), issued.expires_in);
            }
        }
        // Sealed at once: a worker that respawns must resume on the newest
        // tokens, and a rotated refresh token that was never written down is
        // a device that quietly stops being connected.
        self.checkpoint()
            .await
            .map_err(|e| Trouble::Hiccup(e.message))
    }

    /// The token endpoint, both grants.
    ///
    /// The two failure kinds are kept apart because they mean opposite things
    /// to the caller: the endpoint *answering* a refusal is the consent being
    /// gone (only a new consent fixes it), while never reaching the endpoint
    /// is the network (the next trigger is the retry). Collapsing them would
    /// send a user through a consent ceremony because their wifi dropped.
    async fn token_request(&self, form: String) -> Result<Issued, TokenFailure> {
        let response = self
            .seams
            .fetch
            .request(
                "POST".to_string(),
                self.drive_config.token_url(),
                vec![(
                    "content-type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                )],
                form.into_bytes(),
            )
            .await
            .map_err(TokenFailure::Unreachable)?;
        if !(200..300).contains(&response.status) {
            return Err(TokenFailure::Refused(format!(
                "the sign-in service answered {}{}",
                response.status,
                oauth_error(&response.body)
            )));
        }
        serde_json::from_slice(&response.body).map_err(|e| {
            TokenFailure::Refused(format!(
                "the sign-in service's answer could not be read: {e}"
            ))
        })
    }
}

/// Why a token request did not yield tokens.
enum TokenFailure {
    /// The endpoint answered, and its answer was a refusal.
    Refused(String),
    /// Nothing answered.
    Unreachable(String),
}

impl TokenFailure {
    fn why(&self) -> &str {
        match self {
            TokenFailure::Refused(why) | TokenFailure::Unreachable(why) => why,
        }
    }
}

/// OAuth 2.0 §5.2's two fields out of an error body, and nothing else.
///
/// The raw body is never echoed: it is an untrusted endpoint's bytes on their
/// way into a string the visor renders, it can be any size, and the parts
/// that carry meaning are exactly these two. Truncated for the same reason a
/// message is written for a person rather than a log.
fn oauth_error(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::new();
    };
    let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let detail = value
        .get("error_description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let joined = match (code, detail) {
        ("", "") => return String::new(),
        (code, "") => code.to_string(),
        ("", detail) => detail.to_string(),
        (code, detail) => format!("{code}: {detail}"),
    };
    format!(": {}", clip(&joined, 120))
}

/// At most `limit` characters, cut on a character boundary.
fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// The token endpoint's answer.
#[derive(Debug, Deserialize)]
struct Issued {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    /// Seconds. Absent on some answers, which is why the stored expiry is 0
    /// then and the 401 path is the authority.
    #[serde(default)]
    expires_in: Option<u64>,
}

fn expiry(now: u64, expires_in: Option<u64>) -> u64 {
    match expires_in {
        // A minute of slack: the pre-check exists to save a round trip, and
        // refreshing slightly early costs one request against an access token
        // that expires mid-flight costing two.
        Some(seconds) => now.saturating_add(seconds.saturating_mul(1000).saturating_sub(60_000)),
        None => 0,
    }
}

/// How a status that is not success is classified, in one place so every call
/// agrees.
///
/// Only 401 is a re-authorization: it is the status that means "this bearer
/// is not accepted", and it has already survived the one refresh
/// (`Kernel::drive_request`) by the time it is seen here. **403 is not.**
/// Drive answers 403 for a quota, a rate limit and a project whose Drive API
/// is not enabled — all of which the same consent recovers from on its own,
/// and none of which a consent ceremony would fix.
fn refusal(status: u16, what: &str) -> Option<Trouble> {
    (status == 401).then(|| {
        Trouble::Reauthorize(format!(
            "the store no longer accepts this device's sign-in, so it cannot {what}"
        ))
    })
}

/// A 2xx JSON body, or framework voice about what came instead.
fn json(response: &HttpResponse, what: &str) -> Result<serde_json::Value, Trouble> {
    if let Some(trouble) = refusal(response.status, what) {
        return Err(trouble);
    }
    if !(200..300).contains(&response.status) {
        return Err(Trouble::Hiccup(format!(
            "the store answered {} trying to {what}",
            response.status
        )));
    }
    if response.body.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&response.body)
        .map_err(|e| Trouble::Hiccup(format!("the store's answer could not be read: {e}")))
}

// -- names -------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

/// `hex(HMAC-SHA256(name_key, tree ‖ item id [‖ "fragment"]))` — the object's
/// name.
///
/// Derived rather than descriptive, and that is the point (docs/design.md
/// "Storage"): a tree id is global and stable, so a plain name would tell
/// anyone who can list two accounts that those accounts share a document, and
/// would make one document's activity trackable forever. Under the group's
/// key the store sees unguessable hex and nothing else.
///
/// It is also the deduplication: the name is a function of the item's own
/// digests, so an object that exists under it is already these bytes and the
/// push skips it.
///
/// Which is exactly why the kind is mixed in for a fragment. A fragment is
/// named by its *head*, and that head is also a commit — two different
/// payloads for one `(tree, id)` pair. Left undistinguished they would race
/// for one name and the dedup would silently keep whichever landed first. The
/// commit case is left byte-for-byte as it was, so objects a group wrote
/// before fragments existed keep their names.
#[must_use]
pub fn object_name(
    name_key: &[u8; 32],
    tree: &[u8; 32],
    commit: &[u8; 32],
    kind: ItemKind,
) -> String {
    let mut mac = HmacSha256::new_from_slice(name_key).expect("HMAC takes a key of any length");
    mac.update(tree);
    mac.update(commit);
    if kind == ItemKind::Fragment {
        mac.update(b"fragment");
    }
    HEXLOWER.encode(&mac.finalize().into_bytes())
}

/// `polyvisor-<16 hex>` — the group's one folder, under `appDataFolder`.
///
/// Keyed like the objects, but shortened: a folder is a container and its
/// name is the one label a person browsing their own app data could see, so
/// it is long enough to be unguessable and short enough to read. The word
/// "polyvisor" is deliberate — the space is this app's alone, so a fixed
/// prefix discloses nothing that the space itself does not.
#[must_use]
pub fn folder_name(name_key: &[u8; 32]) -> String {
    let mut mac = HmacSha256::new_from_slice(name_key).expect("HMAC takes a key of any length");
    mac.update(b"folder");
    let hex = HEXLOWER.encode(&mac.finalize().into_bytes());
    format!("polyvisor-{}", &hex[..16])
}

// -- encoding ----------------------------------------------------------------

/// Percent-encode a query-string value (RFC 3986: the unreserved set survives,
/// everything else escapes). Four lines rather than a dependency: what this
/// puts in a query string is hex names, ids and one fixed `q` grammar.
fn query(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `application/x-www-form-urlencoded`, which is the same escaping with `&`
/// and `=` between the pairs. (A form body escapes a space as `+`; nothing
/// here sends one, and `%20` is accepted everywhere either is.)
fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", query(key), query(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Escape a name for a single-quoted Drive query literal: Drive escapes `\`
/// and `'` with a backslash. Every name this kernel writes is hex or a fixed
/// word, so this can only matter for an id the store itself chose — which is
/// exactly why it is here.
fn literal(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('\'', "\\'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_keyed_to_the_group_and_to_the_item() {
        let key = [3u8; 32];
        let other = [4u8; 32];
        let (tree, commit) = ([1u8; 32], [2u8; 32]);
        let name = object_name(&key, &tree, &commit, ItemKind::Commit);
        assert_eq!(name.len(), 64, "hex of an HMAC-SHA256");
        assert_eq!(
            name,
            object_name(&key, &tree, &commit, ItemKind::Commit),
            "derived, not drawn"
        );
        // A different group derives a different name for the same item, which
        // is what keeps two accounts' stores uncorrelatable.
        assert_ne!(name, object_name(&other, &tree, &commit, ItemKind::Commit));
        // The tree and the commit are separate inputs, not one concatenated
        // blob a shift could confuse.
        assert_ne!(name, object_name(&key, &commit, &tree, ItemKind::Commit));
        // A fragment is named by its head, and that head is also a commit:
        // the two must not land on one object.
        assert_ne!(name, object_name(&key, &tree, &commit, ItemKind::Fragment));
        assert_ne!(folder_name(&key), folder_name(&other));
        assert!(folder_name(&key).starts_with("polyvisor-"));
        assert_eq!(folder_name(&key).len(), "polyvisor-".len() + 16);
    }

    #[test]
    fn query_values_survive_the_grammar_they_travel_in() {
        assert_eq!(query("abc-_.~"), "abc-_.~");
        assert_eq!(query("a b"), "a%20b");
        assert_eq!(query("'x' in parents"), "%27x%27%20in%20parents");
        assert_eq!(
            form(&[("grant_type", "refresh_token"), ("client_id", "a/b")]),
            "grant_type=refresh_token&client_id=a%2Fb"
        );
        assert_eq!(literal("it's\\here"), "it\\'s\\\\here");
    }
}
