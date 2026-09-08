//! Bookmarkable URLs: the grammar of the page fragment, and the sealing it
//! rides under (docs/design.md "Routing").
//!
//! The grammar is one production and no options:
//!
//! ```text
//! fragment := "app/" token
//! token    := base64url-nopad( 0x01 ‖ nonce(12) ‖ AES-256-GCM ciphertext )
//! plaintext:= install-id(16) ‖ route-len(u16 BE) ‖ route ‖ zero pad to 256
//! ```
//!
//! `app/` is a *kind* prefix, not a path: a later kind is a new prefix, and a
//! fragment written by anything else is refused here rather than guessed at.
//! The key is the user's route key (`Engine::visor_route_key`), so a fragment
//! is meaningful only on this user's devices — sharing a link with someone
//! else is foreclosed by construction, not by a policy check that could be
//! forgotten.
//!
//! **Why deterministic.** The nonce is not drawn; it is
//! `HMAC-SHA256(k_siv, plaintext)[..12]` (SIV-style synthetic IV). Equal state
//! therefore gives an equal URL, which is what makes the fragment usable at
//! all: the glue rewrites it with `history.replaceState` on every `route.set`
//! an app relays, and a fresh nonce per write would make every keystroke a
//! new URL — history churn, and a bookmark that stops matching the page it
//! was taken from. Determinism is also what lets decode reject a
//! non-canonical encoding: it recomputes the nonce and requires equality, so
//! there is exactly one token per (install, route).
//!
//! **Why fixed length.** The plaintext is padded to 256 bytes, so every token
//! is the same length and the URL says nothing about how long the route is —
//! and a route is app state (a task id, a filter, a document name). What
//! padding does not close is that an update happened at a given moment, and
//! whether the state behind it changed (an unchanged route re-encodes to the
//! same token). That residual channel is accepted, named here, and not fixed.
//!
//! **Why the version byte is inside the AAD's protection.** `0x01` is the
//! first byte of the sealed blob and the AAD is `polyvisor:route:v1`, so the
//! version is authenticated twice over: an attacker cannot rewrite the byte
//! to steer a future runtime at a different construction, because the tag was
//! computed over an AAD naming this one. A v2 fragment is a new AAD, and a v1
//! device reading it fails authentication rather than mis-parsing it.
//!
//! Every failure on the way in is one error — [`RouteError::Unreadable`] —
//! which the kernel answers `not-found` with a single message. A wrong key, a
//! flipped bit, a foreign prefix and a truncated token are not told apart,
//! because the answer to all four is the same: this device cannot open this
//! link.
//!
//! **The second kind, `launch/<app-id>`.** docs/design.md "Routing" explains
//! why an installed app's `start_url` cannot be an `app/` token: it is
//! written once into the OS's app registry and replayed for months, so it
//! must outlive route-key convergence, and it names a package the launcher
//! already displays, so there is nothing to hide. `launch/` is plaintext and
//! keyless — the app id verbatim, nothing sealed — and decodes to this
//! user's install of that package at route `""`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use data_encoding::BASE64URL_NOPAD;
use hmac::{Hmac, Mac as _};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// The one fragment kind there is, with its separator.
const KIND: &str = "app/";

/// The version byte, first in the sealed blob.
const VERSION: u8 = 1;

/// Authenticated, not encrypted: names the construction the tag was computed
/// under (see the module docs on the version byte).
const AAD: &[u8] = b"polyvisor:route:v1";

const INSTALL_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const PLAINTEXT_LEN: usize = 256;

/// The longest route that fits: the padded plaintext less the install id and
/// the length prefix (internal.wit `apps.route-encode`).
pub const MAX_ROUTE: usize = PLAINTEXT_LEN - INSTALL_LEN - 2;

/// Why a fragment did not encode or decode. Two variants because the kernel
/// answers them differently: a route the caller can shorten is `refused` and
/// says so, and everything else is `not-found` and says nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteError {
    /// The route is over [`MAX_ROUTE`] bytes.
    TooLong,
    /// Anything else: wrong prefix, wrong key, wrong version, bad base64,
    /// a failed tag, a non-canonical nonce, non-zero padding, invalid UTF-8.
    Unreadable,
}

/// The whole fragment text for `install` at `route` — `app/<token>`, without
/// the `#`, which belongs to whoever writes the URL.
pub fn encode(
    key: &[u8; 32],
    install: [u8; INSTALL_LEN],
    route: &str,
) -> Result<String, RouteError> {
    if route.len() > MAX_ROUTE {
        return Err(RouteError::TooLong);
    }
    let mut plaintext = [0u8; PLAINTEXT_LEN];
    plaintext[..INSTALL_LEN].copy_from_slice(&install);
    plaintext[INSTALL_LEN..INSTALL_LEN + 2].copy_from_slice(&(route.len() as u16).to_be_bytes());
    plaintext[INSTALL_LEN + 2..INSTALL_LEN + 2 + route.len()].copy_from_slice(route.as_bytes());

    let (k_enc, k_siv) = subkeys(key);
    let nonce = siv(&k_siv, &plaintext);
    let ct = Aes256Gcm::new((&k_enc).into())
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &plaintext,
                aad: AAD,
            },
        )
        // Only a message longer than the AEAD's limit fails, and this one is
        // a fixed 256 bytes.
        .map_err(|_| RouteError::Unreadable)?;

    let mut blob = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    blob.push(VERSION);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{KIND}{}", BASE64URL_NOPAD.encode(&blob)))
}

/// The inverse: the install id the fragment names and the route it carries.
pub fn decode(key: &[u8; 32], fragment: &str) -> Result<([u8; INSTALL_LEN], String), RouteError> {
    let token = fragment.strip_prefix(KIND).ok_or(RouteError::Unreadable)?;
    let blob = BASE64URL_NOPAD
        .decode(token.as_bytes())
        .map_err(|_| RouteError::Unreadable)?;
    if blob.len() < 1 + NONCE_LEN || blob[0] != VERSION {
        return Err(RouteError::Unreadable);
    }
    let (head, ct) = blob[1..].split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = head.try_into().expect("split at NONCE_LEN");

    let (k_enc, k_siv) = subkeys(key);
    let plaintext = Aes256Gcm::new((&k_enc).into())
        .decrypt(&Nonce::from(nonce), Payload { msg: ct, aad: AAD })
        .map_err(|_| RouteError::Unreadable)?;
    if plaintext.len() != PLAINTEXT_LEN {
        return Err(RouteError::Unreadable);
    }
    // Canonicality: a token whose nonce is not the one this plaintext derives
    // is a second spelling of a fragment that already has one (module docs).
    if siv(&k_siv, &plaintext) != nonce {
        return Err(RouteError::Unreadable);
    }

    let mut install = [0u8; INSTALL_LEN];
    install.copy_from_slice(&plaintext[..INSTALL_LEN]);
    let len = u16::from_be_bytes([plaintext[INSTALL_LEN], plaintext[INSTALL_LEN + 1]]) as usize;
    if len > MAX_ROUTE {
        return Err(RouteError::Unreadable);
    }
    let body = &plaintext[INSTALL_LEN + 2..];
    let (route, pad) = body.split_at(len);
    if pad.iter().any(|b| *b != 0) {
        return Err(RouteError::Unreadable);
    }
    let route = std::str::from_utf8(route).map_err(|_| RouteError::Unreadable)?;
    Ok((install, route.to_string()))
}

/// The second kind's prefix (module docs): plaintext, keyless, no token.
pub const LAUNCH_PREFIX: &str = "launch/";

/// The fragment an installed app's window opens at: `launch/<app>`.
pub fn launch_fragment(app: &str) -> String {
    format!("{LAUNCH_PREFIX}{app}")
}

/// The app id a `launch/` fragment names, or `None` if `fragment` is not one
/// (wrong prefix, or an empty id — `launch/` alone names nothing).
pub fn launch_app(fragment: &str) -> Option<&str> {
    let app = fragment.strip_prefix(LAUNCH_PREFIX)?;
    if app.is_empty() { None } else { Some(app) }
}

/// The two subkeys, so the SIV computation and the encryption never share a
/// key: `k_enc = HMAC(route-key, "polyvisor:route:enc")`, `k_siv` likewise.
fn subkeys(key: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (
        mac(key, b"polyvisor:route:enc"),
        mac(key, b"polyvisor:route:siv"),
    )
}

fn mac(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

/// The synthetic IV: the plaintext's own MAC, truncated.
fn siv(k_siv: &[u8; 32], plaintext: &[u8]) -> [u8; NONCE_LEN] {
    let full = mac(k_siv, plaintext);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&full[..NONCE_LEN]);
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic key material: all zeros, and an install id of 00 01 02… —
    /// test vectors, never anything a device could have minted.
    const KEY: [u8; 32] = [0u8; 32];
    const INSTALL: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    #[test]
    fn round_trip() {
        let fragment = encode(&KEY, INSTALL, "todo/active").unwrap();
        assert_eq!(
            decode(&KEY, &fragment).unwrap(),
            (INSTALL, "todo/active".to_string())
        );
    }

    #[test]
    fn empty_route_round_trips() {
        let fragment = encode(&KEY, INSTALL, "").unwrap();
        assert_eq!(decode(&KEY, &fragment).unwrap(), (INSTALL, String::new()));
    }

    #[test]
    fn deterministic() {
        assert_eq!(
            encode(&KEY, INSTALL, "todo/active").unwrap(),
            encode(&KEY, INSTALL, "todo/active").unwrap()
        );
    }

    #[test]
    fn different_route_different_fragment() {
        assert_ne!(
            encode(&KEY, INSTALL, "todo/active").unwrap(),
            encode(&KEY, INSTALL, "todo/done").unwrap()
        );
    }

    #[test]
    fn tampering_is_unreadable() {
        let fragment = encode(&KEY, INSTALL, "todo/active").unwrap();
        // Flip one token character to another of the alphabet, well past the
        // version byte, so the failure is the tag and not the framing.
        let mut bytes = fragment.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(decode(&KEY, &tampered), Err(RouteError::Unreadable));
    }

    #[test]
    fn another_key_is_unreadable() {
        let fragment = encode(&KEY, INSTALL, "todo/active").unwrap();
        let mut other = KEY;
        other[0] = 1;
        assert_eq!(decode(&other, &fragment), Err(RouteError::Unreadable));
    }

    #[test]
    fn foreign_prefix_is_unreadable() {
        let fragment = encode(&KEY, INSTALL, "todo/active").unwrap();
        let foreign = fragment.replace(KIND, "doc/");
        assert_eq!(decode(&KEY, &foreign), Err(RouteError::Unreadable));
        assert_eq!(decode(&KEY, ""), Err(RouteError::Unreadable));
    }

    #[test]
    fn the_longest_route_fits_and_one_more_does_not() {
        let route = "r".repeat(MAX_ROUTE);
        let fragment = encode(&KEY, INSTALL, &route).unwrap();
        assert_eq!(decode(&KEY, &fragment).unwrap(), (INSTALL, route.clone()));
        assert_eq!(
            encode(&KEY, INSTALL, &format!("{route}r")),
            Err(RouteError::TooLong)
        );
    }

    /// The fragment goes into a URL unescaped, so every byte of it must be
    /// one a fragment may hold verbatim.
    #[test]
    fn fragment_is_url_safe() {
        for route in ["", "todo/active", &"r".repeat(MAX_ROUTE)] {
            let fragment = encode(&KEY, INSTALL, route).unwrap();
            assert!(
                fragment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'/')),
                "fragment holds a character a URL would have to escape"
            );
        }
    }

    /// Every route encodes to the same length: the padding's whole point.
    #[test]
    fn every_fragment_is_the_same_length() {
        let short = encode(&KEY, INSTALL, "a").unwrap();
        let long = encode(&KEY, INSTALL, &"r".repeat(MAX_ROUTE)).unwrap();
        assert_eq!(short.len(), long.len());
    }

    #[test]
    fn launch_round_trips() {
        let fragment = launch_fragment("todomvc");
        assert_eq!(fragment, "launch/todomvc");
        assert_eq!(launch_app(&fragment), Some("todomvc"));
    }

    /// An `app/` token is not a launch, even though both share the `/`
    /// separator — the kind prefixes must not be confused.
    #[test]
    fn app_fragment_is_not_a_launch() {
        let fragment = encode(&KEY, INSTALL, "todo/active").unwrap();
        assert_eq!(launch_app(&fragment), None);
    }

    #[test]
    fn empty_launch_remainder_is_none() {
        assert_eq!(launch_app("launch/"), None);
        assert_eq!(launch_app("launch"), None);
    }
}
