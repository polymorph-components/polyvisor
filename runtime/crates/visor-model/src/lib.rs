//! The visor's own document: the user's route key and the install ids that
//! bookmarkable URLs are written against.
//!
//! ## Why it rides the app-document machinery
//!
//! This is not a third document kind. It is the `apps` entry under a reserved
//! app id, [`VISOR_APP`], whose tree is `document_tree("polyvisor:visor")` like
//! any other app's — so keyhive sealing, sync, snapshot/restore, compaction
//! and the adoption path all apply to it unchanged, and nothing in the engine
//! needs a case for it. The id is reserved by being unspellable as a real app
//! id: an app is named `polyvisor:app/<name>`.
//!
//! ## Shape
//!
//! ```text
//! route-key: str                      # lowercase hex, 32 bytes
//! install:<install id hex>: { app: str }
//! identity:hue / identity:word        # shared anchor scalars
//! user:<hex field>                    # user metadata scalars
//! app:<hex app id>:<hex field>        # per-app metadata scalars
//! ```
//!
//! At the automerge ROOT: two devices that each create a nested map before
//! meeting create two distinct objects at one key, and automerge resolves that
//! by keeping one and silently dropping the loser's whole subtree. The root
//! object is automerge's own and is the same object everywhere.
//!
//! ## Two founders, and what it costs the loser
//!
//! `route-key` is a scalar, so two devices that each mint one before they are
//! paired do not merge: automerge picks a winner by last-writer-wins and the
//! other key is gone. That is deliberate — a merge would need a second key to
//! stay live, and then a URL would no longer name one key — and it has a
//! visible consequence: the losing device's bookmarks made before pairing no
//! longer decrypt, and open as "not a link this device can open". Bookmarks
//! taken after pairing are stable forever.
//!
//! Install ids do merge: both survive as separate root keys. Lookup by app
//! therefore picks the smallest id (a total order both devices agree on), and
//! lookup by id resolves either — an older URL keeps working.
//!
//! ## Why the key cannot live in `us`
//!
//! The user-system document is deliberately not enveloped: a device must be
//! able to read it before it has any keyhive
//! state, so `us` is plaintext on the wire and in the store, and a relay sees
//! it). It gives away nothing today because it holds only endpoint public keys
//! and petnames. A route key put there would be handed to every relay and to
//! the user's own storage provider in the clear, and with it every bookmark's
//! app and route. This document is an app document, so it is sealed.

use automerge::{ObjType, ROOT, ReadDoc, transaction::Transactable};

use polyvisor_document_history::Document;
use std::collections::BTreeSet;

/// The reserved app id the visor's own document lives under.
pub const VISOR_APP: &str = "polyvisor:visor";

/// The root key the user's route key is spelled at.
pub const ROUTE_KEY: &str = "route-key";
const INSTALL_PREFIX: &str = "install:";
const HUE: &str = "identity:hue";
const WORD: &str = "identity:word";
const USER_PREFIX: &str = "user:";
const APP_PREFIX: &str = "app:";

/// The field an install entry names its app in.
const APP: &str = "app";

pub fn route_key_or_create(
    doc: &mut Document,
    device: [u8; 32],
    entropy: [u8; 32],
) -> Result<([u8; 32], bool), String> {
    if let Some(key) = route_key(doc) {
        return Ok((key, false));
    }
    let key = digest(b"polyvisor:route-key", &[&device, &entropy]);
    set_route_key(doc, key)?;
    Ok((key, true))
}

pub fn install_or_create(
    doc: &mut Document,
    device: [u8; 32],
    entropy: [u8; 32],
    app: &str,
) -> Result<([u8; 16], bool), String> {
    if let Some((id, _)) = installs(doc).into_iter().find(|(_, held)| held == app) {
        return Ok((id, false));
    }
    let hash = digest(b"polyvisor:install", &[&device, &entropy, app.as_bytes()]);
    let id = hash[..16].try_into().expect("slice has install id length");
    add_install(doc, id, app)?;
    Ok((id, true))
}

/// The user's route key, if this document holds one.
///
/// A value that is not 32 bytes of hex is read as absent.
pub fn route_key(doc: &Document) -> Option<[u8; 32]> {
    let text = doc
        .read()
        .get(ROOT, ROUTE_KEY)
        .ok()
        .flatten()
        .and_then(|(value, _)| value.to_str().map(str::to_string))?;
    let bytes = unhex(&text)?;
    <[u8; 32]>::try_from(bytes).ok()
}

/// Write the user's route key. The caller has already established there is
/// none; writing over one would break every bookmark this user holds.
pub fn set_route_key(doc: &mut Document, key: [u8; 32]) -> Result<(), String> {
    let text = hex(&key);
    doc.transact(move |tx| tx.put(ROOT, ROUTE_KEY, text).map_err(|e| e.to_string()))
}

/// Every (install id, app id) this document holds, smallest id first.
pub fn installs(doc: &Document) -> Vec<([u8; 16], String)> {
    let read = doc.read();
    let mut found: Vec<([u8; 16], String)> = Vec::new();
    for key in read.keys(ROOT) {
        if key == ROUTE_KEY {
            continue;
        }
        let Some(id) = key
            .strip_prefix(INSTALL_PREFIX)
            .and_then(unhex)
            .and_then(|bytes| <[u8; 16]>::try_from(bytes).ok())
        else {
            continue;
        };
        let Ok(Some((_value, entry))) = read.get(ROOT, &key) else {
            continue;
        };
        let Some(app) = read
            .get(&entry, APP)
            .ok()
            .flatten()
            .and_then(|(value, _)| value.to_str().map(str::to_string))
        else {
            continue;
        };
        found.push((id, app));
    }
    // `keys` is automerge's own order over the root map; the smallest-id rule
    // this schema promises is ours to impose.
    found.sort();
    found
}

/// Record `id` as an install of `app`.
pub fn add_install(doc: &mut Document, id: [u8; 16], app: &str) -> Result<(), String> {
    let key = format!("{INSTALL_PREFIX}{}", hex(&id));
    let app = app.to_string();
    doc.transact(move |tx| {
        let entry = tx
            .put_object(ROOT, &key, ObjType::Map)
            .map_err(|e| e.to_string())?;
        tx.put(&entry, APP, app).map_err(|e| e.to_string())
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Personalization {
    pub hue: Option<u16>,
    pub word: Option<String>,
    pub user: std::collections::BTreeMap<String, String>,
    pub apps: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
}

pub fn personalization(doc: &Document) -> Personalization {
    let read = doc.read();
    let hue = read
        .get(ROOT, HUE)
        .ok()
        .flatten()
        .and_then(|(v, _)| v.to_i64())
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v < 360);
    let word = read
        .get(ROOT, WORD)
        .ok()
        .flatten()
        .and_then(|(v, _)| v.to_str().map(str::to_string));
    let mut out = Personalization {
        hue,
        word,
        ..Personalization::default()
    };
    for key in read.keys(ROOT) {
        let value = read
            .get(ROOT, &key)
            .ok()
            .flatten()
            .and_then(|(v, _)| v.to_str().map(str::to_string));
        if let (Some(field), Some(value)) = (
            key.strip_prefix(USER_PREFIX).and_then(unhex_text),
            value.clone(),
        ) {
            out.user.insert(field, value);
        } else if let Some(rest) = key.strip_prefix(APP_PREFIX) {
            let Some((app, field)) = rest
                .split_once(':')
                .and_then(|(a, f)| Some((unhex_text(a)?, unhex_text(f)?)))
            else {
                continue;
            };
            if let Some(value) = value {
                out.apps.entry(app).or_default().insert(field, value);
            }
        }
    }
    out
}

/// Apply a field-level patch. Root scalar keys avoid concurrently-created
/// nested-map conflicts (module schema warning above).
pub fn set_personalization(
    doc: &mut Document,
    hue: Option<Option<u16>>,
    word: Option<Option<String>>,
    fields: Vec<(Option<String>, String, Option<String>)>,
) -> Result<(), String> {
    doc.transact(move |tx| {
        if let Some(value) = hue {
            match value {
                Some(v) => tx.put(ROOT, HUE, i64::from(v)).map_err(|e| e.to_string())?,
                None => {
                    tx.delete(ROOT, HUE).map_err(|e| e.to_string())?;
                }
            }
        }
        if let Some(value) = word {
            match value {
                Some(v) => tx.put(ROOT, WORD, v).map_err(|e| e.to_string())?,
                None => {
                    tx.delete(ROOT, WORD).map_err(|e| e.to_string())?;
                }
            }
        }
        for (app, field, value) in fields {
            let key = match app {
                Some(app) => format!(
                    "{APP_PREFIX}{}:{}",
                    hex(app.as_bytes()),
                    hex(field.as_bytes())
                ),
                None => format!("{USER_PREFIX}{}", hex(field.as_bytes())),
            };
            match value {
                Some(v) => tx.put(ROOT, key, v).map_err(|e| e.to_string())?,
                None => {
                    tx.delete(ROOT, key).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })
}

/// Adopt the established history, then make its personalization causally
/// later than the joiner's pre-pairing values. Route and install entries are
/// merged without replacement policy beyond Automerge's schema rules.
pub fn adopt(current: &mut Document, source: &Document) -> Result<(), String> {
    let wanted = personalization(source);
    if wanted.hue.is_none() || wanted.word.as_deref().is_none_or(str::is_empty) {
        return Err("that device sent incomplete personalization".to_string());
    }
    let before = personalization(current);
    current.merge_snapshot(&source.save())?;
    let mut fields = Vec::new();
    let mut user_keys: BTreeSet<String> = before.user.keys().cloned().collect();
    user_keys.extend(wanted.user.keys().cloned());
    for key in user_keys {
        fields.push((None, key.clone(), wanted.user.get(&key).cloned()));
    }
    let mut app_ids: BTreeSet<String> = before.apps.keys().cloned().collect();
    app_ids.extend(wanted.apps.keys().cloned());
    for app in app_ids {
        let old = before.apps.get(&app);
        let new = wanted.apps.get(&app);
        let mut keys: BTreeSet<String> = old.into_iter().flat_map(|m| m.keys()).cloned().collect();
        keys.extend(new.into_iter().flat_map(|m| m.keys()).cloned());
        for key in keys {
            fields.push((
                Some(app.clone()),
                key.clone(),
                new.and_then(|m| m.get(&key)).cloned(),
            ));
        }
    }
    set_personalization(current, Some(wanted.hue), Some(wanted.word), fields)
}

fn digest(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(domain);
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}

fn unhex_text(text: &str) -> Option<String> {
    String::from_utf8(unhex(text)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::ActorId;
    use sedimentree_core::id::SedimentreeId;

    fn doc() -> Document {
        Document::empty(ActorId::from(&[1_u8][..]), SedimentreeId::new([2; 32]))
    }

    #[test]
    fn field_patch_sets_and_clears_independently() {
        let mut doc = doc();
        set_personalization(
            &mut doc,
            Some(Some(42)),
            Some(Some("word".into())),
            vec![(None, "theme".into(), Some("dark".into()))],
        )
        .unwrap();
        set_personalization(&mut doc, None, None, vec![(None, "theme".into(), None)]).unwrap();
        assert_eq!(
            personalization(&doc),
            Personalization {
                hue: Some(42),
                word: Some("word".into()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn get_or_create_values_are_stable() {
        let mut doc = doc();
        let route = route_key_or_create(&mut doc, [3; 32], [4; 32]).unwrap();
        assert!(route.1);
        assert_eq!(
            route_key_or_create(&mut doc, [5; 32], [6; 32]).unwrap(),
            (route.0, false)
        );
        let install = install_or_create(&mut doc, [3; 32], [4; 32], "app").unwrap();
        assert!(install.1);
        assert_eq!(
            install_or_create(&mut doc, [5; 32], [6; 32], "app").unwrap(),
            (install.0, false)
        );
    }
}
