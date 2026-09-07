# polymorph-iroh, as a git revision rather than a jsr version: the endpoint
# component this repository plugs is built here, from source (see
# `endpoint`), because the interface the runtime needs is feature-gated.
iroh_rev := "8ca991e07cac01368f6df5abf4f96e0beaf6c223"
iroh_rev_short := replace_regex(iroh_rev, '^(.{7}).*$', '$1')
iroh_wasm := "target/iroh_endpoint-" + iroh_rev_short + ".wasm"

# Parse both WIT packages (docs/design.md "Contracts": the public and
# private halves). -o /dev/null: we only want the parse/resolve check.
#
# `--features guest-ed25519-signing`: `polymorph:iroh/identity-from-seed` is
# `@unstable(feature = guest-ed25519-signing)` (iroh.wit), and an unstable
# item is invisible — so an interface `world runtime` imports would resolve
# to "interface not found" — unless the feature is named here too.
wit:
    wasm-tools component wit wit/ -o /dev/null
    wasm-tools component wit runtime/wit/ --features guest-ed25519-signing -o /dev/null

check:
    cargo fmt --check
    cargo clippy --workspace --all-targets -- -D warnings
    deno task check

test:
    cargo test --workspace
    deno task test

build-wasm:
    cargo build --workspace --target wasm32-wasip2 --release

# Build polymorph-iroh's endpoint component, from source at `iroh_rev`.
#
# From source and not from the jsr package: the runtime binds the endpoint's
# identity through `polymorph:iroh/identity-from-seed`, which the package
# gates behind the cargo feature `guest-ed25519-signing` and its published
# artifact is built without. An identity from a seed signs in-guest, which
# is what lets the worker realm run without JSPI (docs/design.md "No JSPI").
#
# The build runs under this repository's toolchain, not polymorph-iroh's own
# `rust-toolchain.toml` (1.97.0): RUSTUP_TOOLCHAIN overrides the file, 1.98.1
# compiles it, and CI then needs no second toolchain installed.
#
# Idempotent twice over: the checkout is fetched-or-cloned, and a
# materialized artifact for this revision is left alone, so `just compose` in
# a loop neither talks to the network nor re-runs cargo.
endpoint:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f {{ iroh_wasm }} ]; then
        echo "endpoint: {{ iroh_wasm }} is already there"
        exit 0
    fi
    if [ -d target/polymorph-iroh/.git ]; then
        git -C target/polymorph-iroh fetch --quiet origin
    else
        mkdir -p target
        git clone --quiet https://github.com/polymorph-components/polymorph-iroh \
            target/polymorph-iroh
    fi
    git -C target/polymorph-iroh checkout --quiet --detach {{ iroh_rev }}
    cd target/polymorph-iroh
    RUSTUP_TOOLCHAIN=1.98.1 cargo build -p iroh-endpoint \
        --features guest-ed25519-signing --target wasm32-wasip2 --release
    cd ../..
    cp target/polymorph-iroh/target/wasm32-wasip2/release/iroh_endpoint.wasm {{ iroh_wasm }}
    echo "endpoint: wrote {{ iroh_wasm }}"

# Plug polymorph-iroh's endpoint component into the runtime.
#
# The runtime imports `polymorph:iroh/{endpoint,identity-from-seed}` and
# nothing in this repository implements them (internal.wit `world runtime`:
# "the endpoint component ... composed in at build time with `wac plug`").
# What the worker instantiates is therefore never the cargo artifact but this
# composition, whose remaining imports are the endpoint's own — websocket,
# webrtc-datachannels, webcrypto, a sockets stub — which the worker glue
# provides.
compose: endpoint
    wac plug target/wasm32-wasip2/release/polyvisor_runtime.wasm \
        --plug {{ iroh_wasm }} \
        -o target/polyvisor_runtime.composed.wasm

# web/dist: exactly what a home origin serves.
# The site ships the composed runtime, so `compose` is a prerequisite here
# and not only of `e2e`; pages.yml runs this recipe.
site: compose
    deno task build

# web/dist plus the test fixtures the e2e scenarios need (apps/hostile). NOT
# what a home origin serves: the production Pages build runs `site`.
site-fixtures: compose
    deno task build:fixtures

e2e: build-wasm site-fixtures
    deno task e2e

# Everything CI runs, in order (docs/design.md "Delivery": cargo test,
# deno test, Playwright). `site` is a gate, not just packaging: it runs
# polyengine's translator over every component, which catches canonical-ABI
# errors `wasm-tools validate` accepts (an async lowering of a sync WIT
# function, M1).
ci: wit check test build-wasm compose site
