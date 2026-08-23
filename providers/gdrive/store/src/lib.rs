//! The Google Drive provider: the USER-ONLY store.
//!
//! Dropbox's plain-derivable-layout strategy (providers/dropbox/store)
//! over an id-addressed API, with the ENTIRE LINK TIER REMOVED. Every
//! call in this crate runs `Route::Owner`; there is no `Route::Shared`
//! and no `Route::Public` path here, because this provider mints NO
//! capability a non-credentialed party could use (DRIVE.md §1). The only
//! readers of the store are holders of the user's own OAuth, wired to
//! `store-owner-fetch`. "No sharing" is structural: the other two seams
//! are wired over empty origin sets and these paths never call them.
//!
//! Blob CONTENTS are identical to the S3 and Dropbox paths — same
//! envelope bytes, same op-stream blob, same signed manifest; only
//! addressing and transport change.
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

use provider_common::{do_fetch, request_label, FetchPort, Route};

/// Google Drive store config: ADDRESSING ONLY, like every other arm.
/// There is no credential here at all — not even a public identifier
/// like S3's access key: the user's OAuth tokens, their refresh, and the
/// app identifiers all live in the wired `store-owner-fetch` instance
/// (#7, DRIVE.md §2). `api_base` defaults to `https://www.googleapis.com`
/// at the embedder and exists for the same reason S3's `endpoint` is
/// config: a self-hosted (or fake) backend is ordinary addressing, not a
/// probe hack.
pub struct GdriveCfg {
    pub root: String,
    pub api_base: String,
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

/// Resolve-or-create a folder under `parent` (`"root"` is Drive's alias
/// for the user's My Drive root). Idempotent by construction: the create
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

// Names: plain and client-derivable — no name secrecy on this provider,
// so no name-key epochs either. Identical to the Dropbox layout with the
// path separators replaced by parent ids (DRIVE.md §2).

/// The per-doc folder NAME (its parent is the `docs` folder id).
pub fn gd_doc_name(doc: &[u8]) -> String {
    hex::encode(doc)
}

/// `chunk-{cref}` / `oplog-{device}` / `manifest-{device}` — the same
/// child names `dbx_child` produces, deliberately.
pub fn gd_child(kind: &str, id: &[u8]) -> String {
    format!("{kind}-{}", hex::encode(id))
}

/// The pickup object's name inside `pickup/<hex(doc)>`.
pub fn gd_pickup_name(member: &[u8]) -> String {
    hex::encode(member)
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
