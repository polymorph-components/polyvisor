# Parse both WIT packages (docs/design.md "Contracts": the public and
# private halves). -o /dev/null: we only want the parse/resolve check.
wit:
    wasm-tools component wit wit/ -o /dev/null
    wasm-tools component wit runtime/wit/ -o /dev/null

check:
    cargo fmt --check
    cargo clippy --workspace --all-targets -- -D warnings
    deno task check

test:
    cargo test --workspace
    deno task test

build-wasm:
    cargo build --workspace --target wasm32-wasip2 --release

# Plug polymorph-iroh's endpoint component into the runtime.
#
# The runtime imports `polymorph:iroh/{endpoint,identity-from-keys}` and
# nothing in this repository implements them (internal.wit `world runtime`:
# "the endpoint component ... composed in at build time with `wac plug`").
# What the worker instantiates is therefore never the cargo artifact but this
# composition, whose remaining imports are the endpoint's own — websocket,
# webrtc-datachannels, webcrypto, a sockets stub — which the worker glue
# provides.
compose:
    deno run -A web/fetch-endpoint.ts
    wac plug target/wasm32-wasip2/release/polyvisor_runtime.wasm \
        --plug target/iroh_endpoint-0.6.0.wasm \
        -o target/polyvisor_runtime.composed.wasm

# web/dist: exactly what a home origin serves.
site:
    deno task build

# web/dist plus the test fixtures the e2e scenarios need (apps/hostile). NOT
# what a home origin serves: the production Pages build runs `site`.
site-fixtures:
    deno task build:fixtures

e2e: build-wasm compose site-fixtures
    deno task e2e

# Everything CI runs, in order (docs/design.md "Delivery": cargo test,
# deno test, Playwright). `site` is a gate, not just packaging: it runs
# polyengine's translator over every component, which catches canonical-ABI
# errors `wasm-tools validate` accepts (an async lowering of a sync WIT
# function, M1).
ci: wit check test build-wasm compose site
