#!/usr/bin/env bash
# Sibling checkouts and pinned tools for building the demo site — the
# single source of truth shared by local developers and CI (the same
# shape as polymorph-iroh's scripts/setup.sh).
#
# The demo's deno.json resolves the polyengine ports through SIBLING paths
# (../../../polymorph-*), so the checkouts must sit next to this repo.
# Idempotent: existing checkouts are fetched and pinned, never clobbered.
#
# Environment:
#   SIBLINGS_DIR         where sibling repos live (default: the parent dir)
#   WASM_TOOLS_VERSION   wasm-tools version (default below)
#   WAC_VERSION          wac-cli version (default below)
#   JUST_VERSION         just version (default below)
#   SKIP_TOOLS=1         skip tool installation (they are already present)
#   SIBLINGS_ONLY=1      check out the pinned siblings, then stop. CI runs
#                        this phase before restoring build caches: the
#                        cache is keyed on the siblings' lockfiles (so the
#                        checkouts must exist), and everything cargo-shaped
#                        belongs after the restore.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SIBLINGS_DIR="${SIBLINGS_DIR:-$(cd .. && pwd)}"
WASM_TOOLS_VERSION="${WASM_TOOLS_VERSION:-1.247.0}"
WAC_VERSION="${WAC_VERSION:-0.10.1}"
JUST_VERSION="${JUST_VERSION:-1.54.0}"

# Pinned to the revisions the demo was last verified against. Bumping one
# is a deliberate act: the polyengine ports carry embedder conventions that
# have already broken this demo once (see demo/README.md).
#
# polymorph-iroh is NOT checked out here (jsr-pins branch): the tasks-engine
# spike's default `compose` target consumes the endpoint from
# jsr:@polymorph/iroh (engine/justfile's PINS block), so no
# sibling clone/cargo-build of it is needed by any default-path target.
#
# polymorph-webcrypto is likewise NOT checked out here (jsr-pins branch):
# the demo's deno.json now resolves it from jsr:@polymorph/webcrypto@0.3.0
# (see demo/README.md's "polyengine ports ... JSR pins now, no sibling
# checkout" note), and every Rust consumer (dropbox/keyhive/storage/
# skeleton/subduction/tasks-engine) pulls it as a `git = "...", rev = "..."`
# Cargo dependency, not a sibling path. polymorph-webrtc-datachannels is
# still a live sibling consumer (demo/deno.json maps it there) and
# stays checked out below.
WEBRTC_REPO=https://github.com/polymorph-components/polymorph-webrtc-datachannels.git
WEBRTC_PIN=db187f4b7d9d72bdc673ddb91c3170f0d9c7e325 # v0.5.0 — A22-clean: no runtime pin of its own, couples to @polyengine/protocol; the 0.5.1 bump needs it

log() { printf '\n==> %s\n' "$1"; }

pin_repo() { # url pin dir
    local url="$1" pin="$2" dir="$3"
    if [ ! -d "$dir/.git" ]; then
        log "Cloning $(basename "$dir")"
        git clone --filter=blob:none "$url" "$dir"
    fi
    if ! git -C "$dir" cat-file -e "$pin^{commit}" 2>/dev/null; then
        git -C "$dir" fetch --filter=blob:none origin
    fi
    log "Pinning $(basename "$dir") at ${pin:0:12}"
    git -C "$dir" checkout --quiet --detach "$pin"
}

mkdir -p "$SIBLINGS_DIR"
pin_repo "$WEBRTC_REPO" "$WEBRTC_PIN" "$SIBLINGS_DIR/polymorph-webrtc-datachannels"

if [ "${SIBLINGS_ONLY:-0}" = "1" ]; then
    log "Siblings pinned (SIBLINGS_ONLY=1); stopping before tools and builds"
    exit 0
fi

if [ "${SKIP_TOOLS:-0}" != "1" ]; then
    log "Installing pinned Rust toolchain (rust-toolchain.toml) and wasm targets"
    (cd "$REPO_ROOT/engine" && (rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install))
    # The engine + fetcher are wasip2 (pinned by rust-toolchain.toml); the
    # app and panel guests are plain wasm32-unknown-unknown and carry no
    # toolchain file, so that target is added explicitly.
    rustup target add wasm32-unknown-unknown

    # cargo-binstall fetches prebuilt tool binaries (with a `cargo install`
    # fallback) instead of compiling each tool from source — the compiles
    # cost CI ~7 minutes per cold run. binstall is itself pinned: the
    # release asset for this platform is downloaded directly and verified
    # against scripts/cargo-binstall.sha256 before it runs — never a
    # floating bootstrap script. Bumping the version means re-recording
    # those digests deliberately. (Same pattern as polymorph-iroh.)
    BINSTALL_VERSION="1.21.1"

    sha256_of() {
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$1" | cut -d' ' -f1
        else
            shasum -a 256 "$1" | cut -d' ' -f1
        fi
    }

    install_binstall() {
        local asset
        case "$(uname -s)-$(uname -m)" in
        Linux-x86_64) asset="cargo-binstall-x86_64-unknown-linux-musl.tgz" ;;
        Linux-aarch64) asset="cargo-binstall-aarch64-unknown-linux-musl.tgz" ;;
        Darwin-*) asset="cargo-binstall-universal-apple-darwin.zip" ;;
        *) asset="" ;;
        esac
        if [ -z "$asset" ]; then
            echo "setup: no pinned cargo-binstall asset for $(uname -s)/$(uname -m); building from crates.io (registry checksums)" >&2
            cargo install cargo-binstall --locked --version "$BINSTALL_VERSION"
            return
        fi

        local want
        want="$(grep -v '^#' scripts/cargo-binstall.sha256 | awk -v a="$asset" '$2 == a { print $1 }')"
        if [ -z "$want" ]; then
            echo "setup: scripts/cargo-binstall.sha256 pins no digest for ${asset}; record it deliberately" >&2
            exit 1
        fi

        local tmp
        tmp="$(mktemp -d)"
        curl -fsSL --proto '=https' --tlsv1.2 -o "${tmp}/${asset}" \
            "https://github.com/cargo-bins/cargo-binstall/releases/download/v${BINSTALL_VERSION}/${asset}"

        local got
        got="$(sha256_of "${tmp}/${asset}")"
        if [ "$got" != "$want" ]; then
            rm -rf "$tmp"
            cat >&2 <<EOF
setup: ${asset} does not match the digest pinned for cargo-binstall ${BINSTALL_VERSION}.
  expected ${want}
  actual   ${got}

The download has been removed. Either the published asset was replaced,
the pin is stale, or the download was tampered with. Re-record the
digests deliberately after establishing why they changed.
EOF
            exit 1
        fi

        mkdir -p "$HOME/.cargo/bin"
        case "$asset" in
        *.tgz) tar -xzf "${tmp}/${asset}" -C "$HOME/.cargo/bin" cargo-binstall ;;
        *.zip) unzip -q -o "${tmp}/${asset}" cargo-binstall -d "$HOME/.cargo/bin" ;;
        esac
        rm -rf "$tmp"
    }

    log "Ensuring cargo-binstall ${BINSTALL_VERSION} is installed"
    if command -v cargo-binstall >/dev/null 2>&1; then
        echo "cargo-binstall already present: $(cargo-binstall -V)"
    else
        install_binstall
    fi

    # Install a crate binary with cargo-binstall (prebuilt artifact when one
    # exists, `cargo install` fallback otherwise). Only reached when the
    # `command -v` guard fails; `--force` covers a restored cargo cache that
    # has the install metadata without the binary.
    binstall() {
        cargo binstall --no-confirm --locked --force "$1"
    }

    log "Ensuring wasm-tools ${WASM_TOOLS_VERSION} is installed"
    if command -v wasm-tools >/dev/null 2>&1; then
        echo "wasm-tools already present: $(wasm-tools --version)"
    else
        binstall "wasm-tools@${WASM_TOOLS_VERSION}"
    fi

    log "Ensuring just ${JUST_VERSION} is installed"
    # Version-checked, not presence-checked: the justfiles carry a hard
    # version floor (module recipes as dependencies, just 1.42+), so a
    # stale just on PATH is replaced rather than tolerated.
    if command -v just >/dev/null 2>&1 && just --version 2>/dev/null | grep -qF "${JUST_VERSION}"; then
        echo "just already present: $(just --version)"
    else
        binstall "just@${JUST_VERSION}"
        hash -r
        just --version 2>/dev/null | grep -qF "${JUST_VERSION}" || {
            echo "setup: a different just still shadows ${JUST_VERSION} on PATH: $(command -v just) ($(just --version))" >&2
            exit 1
        }
    fi

    log "Ensuring wac ${WAC_VERSION} is installed"
    if command -v wac >/dev/null 2>&1; then
        echo "wac already present: $(wac --version)"
    else
        binstall "wac-cli@${WAC_VERSION}"
    fi
fi

log "Setup complete. Siblings in $SIBLINGS_DIR"
