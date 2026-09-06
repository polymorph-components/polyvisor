# wasm-tools lives outside PATH in this environment; CI installs it via
# taiki-e/install-action so `wasm-tools` resolves there without the prefix.
wasm-tools := "/home/lmartin/.cargo/bin/wasm-tools"

# Parse both WIT packages (docs/design.md "Contracts": the public and
# private halves). -o /dev/null: we only want the parse/resolve check.
wit:
    {{wasm-tools}} component wit wit/ -o /dev/null
    {{wasm-tools}} component wit runtime/wit/ -o /dev/null

check:
    cargo fmt --check
    cargo clippy --workspace --all-targets -- -D warnings
    deno task check

test:
    cargo test --workspace
    deno task test

build-wasm:
    cargo build --workspace --target wasm32-wasip2 --release

e2e:
    deno task e2e

# Everything CI runs, in order (docs/design.md "Delivery": cargo test,
# deno test, Playwright).
ci: wit check test build-wasm
