//! The app registry: what is installed, and the bundle bytes behind it.
//!
//! # Bundle layout (the contract with `web/build.ts`)
//!
//! Everything is fetched from the home origin under `/apps`:
//!
//! - `/apps/index.json` — a JSON array of app ids: `["todomvc"]`.
//! - `/apps/{id}/manifest.json` — one app:
//!
//! ```json
//! { "id": "todomvc", "title": "TodoMVC",
//!   "component": "app.component.wasm", "plan": "app.component.plan.json",
//!   "assets": [ { "handle": "<sha256 hex of the bytes>",
//!                 "path": "todomvc-app.css", "media_type": "text/css" } ] }
//! ```
//!
//! `component`, `plan` and each asset `path` are relative to `/apps/{id}/`.
//!
//! # Asset handles
//!
//! **`handle = sha256(asset bytes)`** — the raw 32-byte digest. The manifest's
//! `handle` field is the lowercase hex spelling of it, for human legibility;
//! the kernel decodes it when it loads the manifest, and `apps.assets` /
//! `apps.asset` speak the raw bytes throughout. Whoever writes the manifest
//! must compute the handle the same way, or the handle the app puts on the
//! stream will not resolve; the agreement is checked natively by the
//! manifest/asset digest test in `apps/todomvc/src/lib.rs`.
//!
//! The kernel re-hashes the bytes on every fetch, so a mismatch is a build or
//! delivery fault and never something a frame is asked to render.

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{Error, ErrorCode, Fetch};

/// `polyvisor:internal/apps.app-info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    pub id: String,
    pub title: String,
}

/// `polyvisor:internal/apps.asset-info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetInfo {
    pub handle: Vec<u8>,
    pub media_type: String,
}

/// `polyvisor:internal/apps.component-artifacts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentArtifacts {
    pub wasm: Vec<u8>,
    pub plan: String,
}

/// The manifest as it is written: handles in hex.
#[derive(Debug, Deserialize)]
struct ManifestJson {
    id: String,
    title: String,
    component: String,
    plan: String,
    assets: Vec<AssetJson>,
}

#[derive(Debug, Deserialize)]
struct AssetJson {
    handle: String,
    path: String,
    media_type: String,
}

/// The manifest as the kernel holds it: handles decoded once, so nothing
/// downstream has to know the hex spelling exists.
#[derive(Debug)]
struct Manifest {
    id: String,
    title: String,
    component: String,
    plan: String,
    assets: Vec<Asset>,
}

#[derive(Debug)]
struct Asset {
    handle: Vec<u8>,
    path: String,
    media_type: String,
}

impl ManifestJson {
    fn decode(self, url: &str) -> Result<Manifest, Error> {
        let mut assets = Vec::with_capacity(self.assets.len());
        for asset in self.assets {
            let handle = unhex(&asset.handle).ok_or_else(|| {
                failed(
                    url,
                    &format!("{} has a handle that is not a sha256 in hex", asset.path),
                )
            })?;
            assets.push(Asset {
                handle,
                path: asset.path,
                media_type: asset.media_type,
            });
        }
        Ok(Manifest {
            id: self.id,
            title: self.title,
            component: self.component,
            plan: self.plan,
            assets,
        })
    }
}

pub struct Registry {
    /// Keyed by app id; `installed` and `assets` are therefore in id order.
    apps: BTreeMap<String, Manifest>,
    /// Fetched once per app: the bytes are large and never change within a
    /// runtime instance.
    components: RefCell<BTreeMap<String, ComponentArtifacts>>,
}

impl Registry {
    pub async fn fetch(fetch: &dyn Fetch, home_origin: &str) -> Result<Registry, Error> {
        let index_url = format!("{home_origin}/apps/index.json");
        let index = fetch
            .get(index_url.clone())
            .await
            .map_err(|e| failed(&index_url, &e))?;
        let ids: Vec<String> = serde_json::from_slice(&index)
            .map_err(|e| failed(&index_url, &format!("not a list of app ids: {e}")))?;

        let mut apps = BTreeMap::new();
        for id in ids {
            let url = format!("{home_origin}/apps/{id}/manifest.json");
            let bytes = fetch.get(url.clone()).await.map_err(|e| failed(&url, &e))?;
            let manifest = serde_json::from_slice::<ManifestJson>(&bytes)
                .map_err(|e| failed(&url, &format!("not an app manifest: {e}")))?
                .decode(&url)?;
            if manifest.id != id {
                return Err(failed(
                    &url,
                    &format!(
                        "the manifest names itself {} but sits under {id}",
                        manifest.id
                    ),
                ));
            }
            apps.insert(id, manifest);
        }
        Ok(Registry {
            apps,
            components: RefCell::new(BTreeMap::new()),
        })
    }

    pub fn contains(&self, app: &str) -> bool {
        self.apps.contains_key(app)
    }

    pub fn installed(&self) -> Vec<AppInfo> {
        self.apps
            .values()
            .map(|m| AppInfo {
                id: m.id.clone(),
                title: m.title.clone(),
            })
            .collect()
    }

    pub fn info(&self, app: &str) -> Option<AppInfo> {
        self.apps.get(app).map(|m| AppInfo {
            id: m.id.clone(),
            title: m.title.clone(),
        })
    }

    pub fn assets(&self, app: &str) -> Result<Vec<AssetInfo>, Error> {
        let manifest = self.manifest(app)?;
        Ok(manifest
            .assets
            .iter()
            .map(|a| AssetInfo {
                handle: a.handle.clone(),
                media_type: a.media_type.clone(),
            })
            .collect())
    }

    pub async fn component(
        &self,
        fetch: &dyn Fetch,
        home_origin: &str,
        app: &str,
    ) -> Result<ComponentArtifacts, Error> {
        if let Some(cached) = self.components.borrow().get(app) {
            return Ok(cached.clone());
        }
        let (component, plan) = {
            let manifest = self.manifest(app)?;
            (manifest.component.clone(), manifest.plan.clone())
        };
        let wasm_url = format!("{home_origin}/apps/{app}/{component}");
        let wasm = fetch
            .get(wasm_url.clone())
            .await
            .map_err(|e| failed(&wasm_url, &e))?;
        let plan_url = format!("{home_origin}/apps/{app}/{plan}");
        let plan_bytes = fetch
            .get(plan_url.clone())
            .await
            .map_err(|e| failed(&plan_url, &e))?;
        let plan = String::from_utf8(plan_bytes)
            .map_err(|_| failed(&plan_url, "the translation envelope is not text"))?;

        let artifacts = ComponentArtifacts { wasm, plan };
        self.components
            .borrow_mut()
            .insert(app.to_string(), artifacts.clone());
        Ok(artifacts)
    }

    pub async fn asset(
        &self,
        fetch: &dyn Fetch,
        home_origin: &str,
        app: &str,
        handle: &[u8],
    ) -> Result<Vec<u8>, Error> {
        let (path, expected) = {
            let manifest = self.manifest(app)?;
            let asset = manifest
                .assets
                .iter()
                .find(|a| a.handle == handle)
                .ok_or_else(|| {
                    Error::new(
                        ErrorCode::NotFound,
                        format!("{app} has no asset under that handle"),
                    )
                })?;
            (asset.path.clone(), asset.handle.clone())
        };
        let url = format!("{home_origin}/apps/{app}/{path}");
        let bytes = fetch.get(url.clone()).await.map_err(|e| failed(&url, &e))?;
        if Sha256::digest(&bytes).as_slice() != expected {
            return Err(Error::new(
                ErrorCode::Failed,
                format!("{path} does not hash to the handle the manifest gives it"),
            ));
        }
        Ok(bytes)
    }

    fn manifest(&self, app: &str) -> Result<&Manifest, Error> {
        self.apps.get(app).ok_or_else(|| {
            Error::new(
                ErrorCode::UnknownApp,
                format!("no app named {app} is installed"),
            )
        })
    }
}

fn failed(url: &str, reason: &str) -> Error {
    Error::new(ErrorCode::Failed, format!("{url}: {reason}"))
}

/// Hex to bytes. `None` for anything that is not exactly a sha256 digest's
/// worth of hex digits.
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
