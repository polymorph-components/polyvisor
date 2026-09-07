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

# web/dist: exactly what a home origin serves.
site:
    deno task build

# web/dist plus the test fixtures the e2e scenarios need (apps/hostile). NOT
# what a home origin serves: the production Pages build runs `site`.
site-fixtures:
    deno task build:fixtures

e2e: build-wasm site-fixtures
    deno task e2e

# Everything CI runs, in order (docs/design.md "Delivery": cargo test,
# deno test, Playwright). `site` is a gate, not just packaging: it runs
# polyengine's translator over every component, which catches canonical-ABI
# errors `wasm-tools validate` accepts (an async lowering of a sync WIT
# function, M1).
ci: wit check test build-wasm site
