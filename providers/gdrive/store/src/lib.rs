//! The Google Drive provider: the USER-ONLY store.
//!
//! Dropbox's folder-shaped strategy (providers/dropbox/store) over an
//! id-addressed API, with the ENTIRE LINK TIER REMOVED and S3's
//! NAME-KEYED NAMES put in place of Dropbox's plain ones. Every call in
//! this crate runs `Route::Owner`; there is no `Route::Shared` and no
//! `Route::Public` path here, because this provider mints NO capability
//! a non-credentialed party could use (DRIVE.md §1). The only readers of
//! the store are holders of the user's own OAuth, wired to
//! `store-owner-fetch`. "No sharing" is structural: the other two seams
//! are wired over empty origin sets and these paths never call them.
//!
//! Blob CONTENTS are identical to the S3 and Dropbox paths — same
//! envelope bytes, same op-stream blob, same signed manifest; only
//! addressing and transport change. Object and folder NAMES are the S3
//! path's: keyed hashes under a per-epoch name-key, for the reasons set
//! out at the naming section near the bottom of this file.
//!
//! Two Drive facts shape everything below (DRIVE.md §2):
//!
//! 1. Drive is ID-ADDRESSED and names are not unique. There is no
//!    `GET /path/to/file`; every path segment is a `files.list` query
//!    scoped to a parent id. Callers cache the folder ids (the engine
//!    guest does, in instance state) so the walk is paid once.
//! 2. `drive.file` scope means this app sees only the files it created.
//!    The confinement is PER CLIENT ID — which is why the client id is
//!    part of the store's identity at the seam, and deliberately not
//!    guest config: the guest has no use for an app identity it must
//!    never wield itself.

use provider_common::{do_fetch, hmac, request_label, sha256, FetchPort, Route};

/// Google Drive store config: ADDRESSING ONLY, like every other arm.
/// There is no credential here at all — not even a public identifier
/// like S3's access key: the user's OAuth tokens, their refresh, and the
/// app identifiers all live in the wired `store-owner-fetch` instance
/// (#7, DRIVE.md §2). `api_base` defaults to `https://www.googleapis.com`
/// at the embedder and exists for the same reason S3's `endpoint` is
/// config: a self-hosted (or fake) backend is ordinary addressing, not a
/// probe hack. `space` is addressing too — WHICH of the user's Drive
/// spaces the root folder sits in — and is the only field that changes
/// what a request looks like rather than merely where it points.
pub struct GdriveCfg {
    pub root: String,
    pub api_base: String,
    /// WHICH DRIVE SPACE the root folder lives in. See `GdSpace`.
    pub space: GdSpace,
}

/// The storage SPACE: where in the user's Drive this store's root
/// folder sits. A LOCATION CHOICE, not a second strategy — everything
/// below the root folder (the `docs`/`pickup` layout, the keyed names,
/// the pickup's unkeyed flat location) is byte-for-byte identical
/// between the two, and the only things this selects are the ROOT
/// PARENT the walk starts from and whether `files.list` carries
/// `spaces=appDataFolder`.
///
/// WHY APPDATA IS THE DEFAULT, and why it fits this provider better
/// than a visible folder does:
///
///   * NO SHARING BECOMES PLATFORM-ENFORCED. Files in the app data
///     folder cannot be shared at all — Drive has no sharing surface
///     for them. DRIVE.md §1 rules that this provider mints no
///     capability, and until now that was true because these paths
///     never call the sharing seams. In the appdata space it is true
///     because there is nothing to call: the same structural-not-
///     checked principle the empty-origin-set wiring already follows,
///     one layer further down.
///   * THE USER CANNOT BREAK IT BY ACCIDENT. This strategy resolves
///     every object by KEYED NAME inside a specific parent (see the
///     naming section below). A visible folder is editable from the
///     Drive UI, and a rename or a move there makes a file
///     PERMANENTLY UNFINDABLE — there is no fallback lookup, because
///     the name IS the address. Hidden storage removes the hand.
///   * AND SINCE NAME-KEYS LANDED, THERE IS NOTHING TO LOOK AT. The
///     visible store is a folder of meaningless hex under two fixed
///     words. Hiding it is now the more coherent choice rather than
///     merely the tidier one.
///
/// WHY VISIBLE STAYS AVAILABLE, because appdata has a real cost that
/// is not worth hiding:
///
///   * THE USER CANNOT INSPECT. Nothing in drive.google.com shows the
///     app data folder; the store's existence is taken on faith.
///   * AN APP/CLIENT ROTATION ORPHANS THE STORE INVISIBLY. The appdata
///     space is scoped to the APP, so a new Cloud project (the exact
///     rotation DRIVE.md §3 says to expect when the borrowed client
///     pair lapses) sees an EMPTY appdata folder with no sign that the
///     old one still holds the bytes. With a visible folder the data
///     at least stays legible to its owner and can be re-adopted.
///   * IT IS WHAT MAKES A LIVE BEAT CHECKABLE BY EYE. DRIVE.md's
///     manual gate — "verify in drive.google.com that the app's folder
///     exists and holds ciphertext objects" — can only be run against
///     a visible folder.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GdSpace {
    /// The hidden per-app space. Default and preferred.
    AppData,
    /// A visible folder in the user's My Drive.
    Drive,
}

impl GdSpace {
    /// Parse the wire value. The WIT field is a PLAIN STRING (matching
    /// `s3-config`'s plain-string fields rather than introducing a
    /// WIT-enum value-mapping convention this codebase has not
    /// exercised), so this is where an unknown value is REFUSED BY
    /// NAME — loudly at `init-store`, never silently defaulted, because
    /// a typo that fell back to a default would put the store in the
    /// wrong space and look like data loss.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "appdata" => Ok(GdSpace::AppData),
            "drive" => Ok(GdSpace::Drive),
            other => Err(format!(
                "gdrive space: unknown value {other:?} (expected \"appdata\" or \"drive\")"
            )),
        }
    }

    /// The ROOT PARENT the folder walk starts from. Both are Drive's
    /// own reserved aliases: `appDataFolder` stands for the hidden
    /// per-app folder and `root` for My Drive's root.
    pub fn root_parent(self) -> &'static str {
        match self {
            GdSpace::AppData => "appDataFolder",
            GdSpace::Drive => "root",
        }
    }

    /// The `spaces` query parameter for `files.list`, when one is
    /// needed.
    ///
    /// THE FAILURE MODE THIS EXISTS TO PREVENT: `files.list` defaults
    /// to `spaces=drive`, and a query that searches the wrong space
    /// does not error — it returns an EMPTY file list. On this
    /// strategy an empty list means "absent", so a forgotten `spaces`
    /// parameter would make every resolve miss, every upload take the
    /// create branch, and the store silently fork into duplicates that
    /// no read can ever find. Hence: the parameter is attached in
    /// `gd_list`, the ONE function every query in this crate goes
    /// through, and not at the seven call sites that build a `q`.
    pub fn spaces_param(self) -> Option<&'static str> {
        match self {
            GdSpace::AppData => Some("appDataFolder"),
            // Omitted rather than sent explicitly: `drive` is the
            // documented default, and sending it would suggest the
            // other spaces (`photos`) are ones this store might mean.
            GdSpace::Drive => None,
        }
    }
}

/// The multipart/related boundary. Local and fixed: the bodies this
/// crate sends are ciphertext blobs, and a boundary collision inside one
/// would be a 400 from Drive rather than a silent corruption — but the
/// blobs are sealed envelope bytes whose framing this token cannot
/// appear in by accident at any meaningful probability.
const BOUNDARY: &str = "pmgdrive7c1f4a2e";

/// Percent-encode for a query-string VALUE (RFC 3986 unreserved set kept,
/// everything else escaped). A local four-line helper rather than a new
/// dependency: the only thing this crate puts in a query string is a
/// Drive `q` expression built from hex names and ids.
fn q_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 3);
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Escape a name for a single-quoted Drive query literal. Drive's query
/// language escapes `\` and `'` with a backslash. Every name this crate
/// writes is hex or a fixed ASCII word, so this can only matter for a
/// hostile `root` — which is exactly why it is here.
fn q_literal(name: &str) -> String {
    name.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Owner-tier request: authority arrives from the WIRING, not from this
/// function. The guest sets no authorization header — the wired
/// `store-owner-fetch` instance injects the user's bearer at the seam and
/// owns the 401→refresh→retry (DRIVE.md §4), so an expired token never
/// becomes guest business. A tierless instance refuses; its error string
/// surfaces through the normal error paths.
///
/// `do_fetch` retries TRANSPORT failures three times and never retries a
/// status; every call this crate makes is idempotent by construction
/// (list, overwrite-in-place upload, resolve-then-create folder, read,
/// delete-if-present).
async fn gd_fetch(
    port: &impl FetchPort,
    method: &str,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    do_fetch(port, Route::Owner, method, url, headers, body).await
}

/// A request whose answer must be 200 and must be JSON. Drive's error
/// bodies are JSON carrying `error.message`, so they go into the error
/// verbatim — after `request_label` has stripped the query string, which
/// on this provider carries the `q` expression and no diagnostic needs.
async fn gd_json(
    port: &impl FetchPort,
    method: &str,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let label = request_label(method, &url);
    let (status, resp) = gd_fetch(port, method, url, headers, body).await?;
    if status != 200 {
        return Err(format!(
            "{label}: {status} {}",
            String::from_utf8_lossy(&resp)
        ));
    }
    if resp.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&resp).map_err(|e| format!("{label}: decode response: {e}"))
}

fn json_headers() -> Vec<(String, String)> {
    vec![("content-type".into(), "application/json".into())]
}

/// `files.list` over one parent, returning `(id, name)` pairs and
/// following `nextPageToken`. `q` is built by the callers below.
///
/// THE SPACE IS ATTACHED HERE AND ONLY HERE. Every query this crate
/// emits funnels through this function, so the `spaces` parameter
/// cannot be forgotten at a call site — see `GdSpace::spaces_param`
/// for why forgetting it would fail silently rather than loudly.
async fn gd_list(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    q: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut url = format!(
            "{}/drive/v3/files?q={}&fields={}&pageSize=1000",
            cfg.api_base,
            q_encode(q),
            q_encode("nextPageToken,files(id,name)"),
        );
        if let Some(spaces) = cfg.space.spaces_param() {
            url.push_str(&format!("&spaces={}", q_encode(spaces)));
        }
        if let Some(token) = &page {
            url.push_str(&format!("&pageToken={}", q_encode(token)));
        }
        let value = gd_json(port, "GET", url, Vec::new(), Vec::new()).await?;
        if let Some(files) = value.get("files").and_then(|f| f.as_array()) {
            for f in files {
                let (Some(id), Some(name)) = (
                    f.get("id").and_then(|v| v.as_str()),
                    f.get("name").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                out.push((id.to_string(), name.to_string()));
            }
        }
        page = value
            .get("nextPageToken")
            .and_then(|t| t.as_str())
            .map(|t| t.to_string());
        if page.is_none() {
            break;
        }
    }
    Ok(out)
}

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

/// Resolve one name under one parent to an id. Names are not unique in
/// Drive, so this is deliberately "the first match": this crate never
/// creates duplicates itself (every create is preceded by exactly this
/// resolution), and a duplicate planted by another client is not
/// something a store can adjudicate.
///
/// `files.list` does not promise an order, so "the first match" is not a
/// stable choice when duplicates DO exist — see `gd_ensure_folder` for
/// the one way this store's own devices can produce them.
pub async fn gd_resolve(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
    name: &str,
    folder: bool,
) -> Result<Option<String>, String> {
    let mut q = format!(
        "name = '{}' and '{}' in parents and trashed = false",
        q_literal(name),
        q_literal(parent),
    );
    if folder {
        q.push_str(&format!(" and mimeType = '{FOLDER_MIME}'"));
    }
    Ok(gd_list(cfg, port, &q).await?.into_iter().next().map(|(id, _)| id))
}

/// Resolve-or-create a folder under `parent`. The walk's first
/// `parent` is the space's root alias — `root` for My Drive,
/// `appDataFolder` for the hidden per-app space
/// (`GdSpace::root_parent`); a create in the appdata space needs no
/// parameter beyond that alias appearing in `parents`, because
/// parentage is what places a file in a space. Idempotent by
/// construction: the create
/// only runs when the resolve found nothing, so a re-`ensure-bucket` or a
/// re-flush costs one list and nothing else.
///
/// IDEMPOTENT, NOT ATOMIC — an accepted v1 limitation. Resolve-then-create
/// is two requests with no compare-and-swap between them (Drive offers
/// none), so two DEVICES OF THE SAME ACCOUNT running their first
/// `ensure-bucket` concurrently can each resolve nothing and each create
/// a `<root>` — and then `docs`/`pickup` under their own copy. Nothing
/// errors; the store simply FORKS, and because `files.list` returns no
/// defined order, each device may thereafter resolve a different winner
/// and write into a tree the other never lists. The symptom is a cold
/// pull that finds fewer devices than exist, not corruption or a leak.
///
/// Accepted because it is the same class of thing DRIVE.md §2 already
/// rules on — Drive is id-addressed, names are not unique, and this
/// strategy's answer is "never create duplicates yourself" rather than
/// "adjudicate them" — and because the window is one round trip, once
/// per account, on a store whose devices consent one at a time (§4).
/// Closing it properly wants a de-duplication pass (list all matches,
/// keep the lowest id, re-parent the rest) or a single device
/// designated to run `ensure-bucket`; both are provider-design calls,
/// not something to slip in under a comment.
pub async fn gd_ensure_folder(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
    name: &str,
) -> Result<String, String> {
    if let Some(id) = gd_resolve(cfg, port, parent, name, true).await? {
        return Ok(id);
    }
    let meta = serde_json::json!({
        "name": name,
        "mimeType": FOLDER_MIME,
        "parents": [parent],
    });
    let value = gd_json(
        port,
        "POST",
        format!("{}/drive/v3/files?fields=id", cfg.api_base),
        json_headers(),
        meta.to_string().into_bytes(),
    )
    .await?;
    value
        .get("id")
        .and_then(|i| i.as_str())
        .map(|i| i.to_string())
        .ok_or_else(|| format!("create folder {name}: no id in response"))
}

/// Owner write, overwrite-in-place (`dbx_upload`'s semantics over an
/// id-addressed API): list by name under the parent, then multipart
/// CREATE when absent or media PATCH when present. Two requests instead
/// of Dropbox's one, and the reason is #2 at the top of this file — there
/// is no path to overwrite, only an id to find.
pub async fn gd_upload(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
    name: &str,
    body: Vec<u8>,
) -> Result<(), String> {
    if let Some(id) = gd_resolve(cfg, port, parent, name, false).await? {
        let url = format!(
            "{}/upload/drive/v3/files/{}?uploadType=media",
            cfg.api_base,
            q_encode(&id),
        );
        let label = request_label("PATCH", &url);
        let (status, resp) = gd_fetch(
            port,
            "PATCH",
            url,
            vec![("content-type".into(), "application/octet-stream".into())],
            body,
        )
        .await?;
        return if status == 200 {
            Ok(())
        } else {
            Err(format!(
                "{label} ({name}): {status} {}",
                String::from_utf8_lossy(&resp)
            ))
        };
    }

    // multipart/related: a JSON metadata part, then the media part.
    // Built by hand because the parts are two fixed shapes and a
    // multipart crate would be a dependency for eight lines of framing.
    let meta = serde_json::json!({ "name": name, "parents": [parent] });
    let mut multi = Vec::new();
    multi.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n",
            meta
        )
        .as_bytes(),
    );
    multi.extend_from_slice(
        format!("--{BOUNDARY}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
    );
    multi.extend_from_slice(&body);
    multi.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let url = format!(
        "{}/upload/drive/v3/files?uploadType=multipart&fields=id",
        cfg.api_base
    );
    let label = request_label("POST", &url);
    let (status, resp) = gd_fetch(
        port,
        "POST",
        url,
        vec![(
            "content-type".into(),
            format!("multipart/related; boundary={BOUNDARY}"),
        )],
        multi,
    )
    .await?;
    if status == 200 {
        Ok(())
    } else {
        Err(format!(
            "{label} ({name}): {status} {}",
            String::from_utf8_lossy(&resp)
        ))
    }
}

/// Owner read by name under a parent. ABSENCE IS `None`, mirroring
/// `dbx_download`'s 409: a name that resolves to nothing is a doc nothing
/// has flushed yet, not an error. A 404 on the media GET is the same
/// answer for the race where the file went away between the two calls.
pub async fn gd_download(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(id) = gd_resolve(cfg, port, parent, name, false).await? else {
        return Ok(None);
    };
    let url = format!(
        "{}/drive/v3/files/{}?alt=media",
        cfg.api_base,
        q_encode(&id),
    );
    let label = request_label("GET", &url);
    let (status, body) = gd_fetch(port, "GET", url, Vec::new(), Vec::new()).await?;
    match status {
        200 => Ok(Some(body)),
        404 => Ok(None),
        other => Err(format!(
            "{label} ({name}): {other} {}",
            String::from_utf8_lossy(&body)
        )),
    }
}

/// Owner list: a folder's child NAMES (`dbx_list_folder`'s answer). Doc
/// folders are small, but the page loop in `gd_list` is the correct
/// shape.
pub async fn gd_list_children(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
) -> Result<Vec<String>, String> {
    let q = format!("'{}' in parents and trashed = false", q_literal(parent));
    Ok(gd_list(cfg, port, &q)
        .await?
        .into_iter()
        .map(|(_, name)| name)
        .collect())
}

/// Delete one named child if it exists. Absence is success: a revoke
/// whose pickup object is already gone has nothing to do.
pub async fn gd_delete(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    parent: &str,
    name: &str,
) -> Result<(), String> {
    let Some(id) = gd_resolve(cfg, port, parent, name, false).await? else {
        return Ok(());
    };
    let url = format!("{}/drive/v3/files/{}", cfg.api_base, q_encode(&id));
    let label = request_label("DELETE", &url);
    let (status, resp) = gd_fetch(port, "DELETE", url, Vec::new(), Vec::new()).await?;
    // 204 is the documented answer; 200 is accepted for the same reason
    // the S3 path accepts both. 404 is the already-deleted race.
    if status == 200 || status == 204 || status == 404 {
        Ok(())
    } else {
        Err(format!(
            "{label} ({name}): {status} {}",
            String::from_utf8_lossy(&resp)
        ))
    }
}

// --- names: keyed, because on this provider names are the disclosure ---
//
// WHAT AN OBSERVER IS PREVENTED FROM LEARNING, and why it is worth the
// derivation. Object CONTENTS here are already keyhive ciphertext, so
// names were the remaining disclosure — and the two properties plain
// names have are exactly the two that hurt:
//
//   * doc ids are GLOBAL. The same shared document carries the same id
//     in every member's store, so anyone who can list two accounts
//     learns from the names alone that those accounts share a document.
//   * doc ids are STABLE. A name never changes, so activity on one
//     document is trackable indefinitely from the naming alone.
//
// It matters HERE in particular because this provider's threat surface
// is metadata-only BY CONSTRUCTION: `drive.file` confines the token to
// app-created files and those files are ciphertext, so a hostile Drive,
// a hostile broker, or anyone who obtains the user's OAuth gets
// availability and metadata and never content (DRIVE.md, "The broker,
// parked with its measurements"). Names were the semantically rich part
// of that metadata; keying them leaves counts, sizes, timing and folder
// grouping, which are traffic shape rather than labels.
//
// The construction is PORTED, NOT INVENTED: it is the S3 provider's,
// character for character — `provider_s3::object_name`
// (providers/s3/store/src/lib.rs:181-185) is
// `hex(HMAC-SHA256(name-key, kind || id))` over a per-epoch name-key,
// and `provider_s3::kp_location` (lines 192-198) is the plain
// `hex(SHA-256("kp" || doc || owner || member))` bootstrap. Both are
// re-derived below rather than imported, because a gdrive crate that
// depended on the s3 crate for two string functions would be a worse
// coupling than a duplicated four-line body; the citation is the
// contract.

/// The per-doc folder NAME (its parent is the `docs` folder id).
///
/// Name-keyed like every child under it — leaving the FOLDER plain
/// would disclose the doc id and defeat the whole derivation, since a
/// folder name is exactly as listable as an object name.
///
/// Keyed under the doc's FOUNDING name-key (epoch 0) rather than the
/// current one, deliberately. S3 has no folders — its bucket is flat,
/// so every name there is per-epoch and nothing has to stay put. A
/// Drive folder is a CONTAINER, and a container that renamed itself on
/// an epoch boundary would strand every object already inside it. Epoch
/// 0 is the one epoch every holder of the keychain has, so the
/// container is stable and the objects inside it stay per-epoch exactly
/// as S3's are. The cost, stated: a member who once held the keychain
/// keeps the ability to DERIVE the folder name forever — but on this
/// provider deriving a name grants no read (there is no anonymous tier;
/// reads need the user's own OAuth), so it costs nothing this provider
/// was offering.
pub async fn gd_doc_name(name_key: &[u8; 32], doc: &[u8]) -> Result<String, String> {
    keyed_name(name_key, b"doc", doc).await
}

/// The child object name for `chunk`/`oplog`/`manifest`.
///
/// Same framing as `provider_s3::object_name`
/// (providers/s3/store/src/lib.rs:181-185): the kind's bytes
/// concatenated with the id's, HMAC'd under the epoch's name-key. Not a
/// second scheme — the same one, so the two providers cannot drift into
/// disagreeing about what a name means.
pub async fn gd_child(name_key: &[u8; 32], kind: &str, id: &[u8]) -> Result<String, String> {
    keyed_name(name_key, kind.as_bytes(), id).await
}

/// `hex(HMAC(name-key, kind || id))` — the one derivation both names
/// above go through.
async fn keyed_name(name_key: &[u8; 32], kind: &[u8], id: &[u8]) -> Result<String, String> {
    let mut data = kind.to_vec();
    data.extend_from_slice(id);
    Ok(hex::encode(hmac(name_key, &data).await?))
}

/// The pickup object's name — DELIBERATELY NOT NAME-KEYED, and the
/// exception is the reason the rest can be keyed at all.
///
/// The chicken-and-egg: the pickup object is where a member LEARNS the
/// name-key keychain. A member who does not yet hold the keychain
/// cannot derive a keyed name, so if the bootstrap object were itself
/// keyed there would be no first step — a second device of the account
/// could never find its own way in. So this one location is derived
/// from PUBLIC IDS only, exactly as `provider_s3::kp_location` is
/// (providers/s3/store/src/lib.rs:192-198), for exactly that reason:
/// `hex(SHA-256("kp" || doc || owner || member))`.
///
/// What that costs, honestly: this name is a hash of the triple, so it
/// discloses nothing to an observer who cannot already guess all three
/// ids — but a party who KNOWS the triple can confirm the object's
/// existence. That is S3's accepted position too ("Production wants a
/// pairwise-secret location (existence privacy)"), and the same #19/#10
/// design item covers both.
///
/// Note the object lives FLAT under `<root>/pickup`, with no per-doc
/// subfolder. A per-doc pickup folder would have to be derivable
/// without the keychain — i.e. named from the doc id, plain or hashed —
/// and either shape is a global, stable per-document label visible in
/// every member's store: precisely the disclosure this whole change
/// removes. Flat, like S3's bucket, is the only shape that does not
/// reintroduce it.
pub async fn gd_pickup_name(doc: &[u8], owner: &[u8], member: &[u8]) -> Result<String, String> {
    let mut data = b"kp".to_vec();
    data.extend_from_slice(doc);
    data.extend_from_slice(owner);
    data.extend_from_slice(member);
    Ok(hex::encode(sha256(&data).await?))
}

/// The ONE way to reach a doc's objects on this provider: as the owner,
/// by folder id.
///
/// Single-variant on purpose, and the variant is the point. Dropbox's
/// equivalent enum has a `Link` arm because a link tier exists there; a
/// gdrive pull that could name a second tier would be a lie about what
/// this store mints (DRIVE.md §1). Keeping the enum keeps the call sites
/// shaped like their Dropbox siblings, and makes the absence legible
/// rather than silent.
pub enum GdSource {
    Owner(String),
}

pub async fn gd_fetch_child(
    cfg: &GdriveCfg,
    port: &impl FetchPort,
    src: &GdSource,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    match src {
        GdSource::Owner(folder_id) => gd_download(cfg, port, folder_id, name).await,
    }
}
