# polyvisor

**Exploratory, unstable, and has no users.** APIs, storage formats, and UI
may change without compatibility support. Implementation choices favor
cheap revision over preserving existing behavior; see
[project maturity and tradeoffs](docs/design.md#project-maturity-and-tradeoffs).

A framework for PWAs that inverts the usual architecture: applications run
client-side as WebAssembly component-model components under
user-controlled capability confinement. The organizing invariant: nothing
in the system is both live and trusted. Trusted ⇒ static (the home
origin's content, release artifacts). Live ⇒ untrusted by construction
(relays, storage, peers), covered by end-to-end crypto and capability
confinement.

## Realms

| Realm | Component (Rust) | Glue (TypeScript) |
|---|---|---|
| SharedWorker, one per device | **runtime** — kernel + engine: device store, sealing, sync, grants, app sessions, data services | `web/worker.ts` + `web/platform/*`: IndexedDB `kv`, OPFS preopen, Web Locks, fetch, polymorph hosts; RPC server over MessagePorts |
| Main thread | **visor** — the trusted pixels (strip, drawer, sheets, ceremonies), a stream-dom producer | `web/boot.ts`: polyengine instantiation, stream-dom receiver (no policy), frame factory, `shell` |
| Opaque-origin `srcdoc` frame | **app** — a polyvisor:app world, a stream-dom producer | `web/frame.ts`: a constant loader; polyengine instantiation, stream-dom receiver under a declared policy, asset resolver, import proxy over a port |

## Repository layout

| Path | What |
|---|---|
| `wit/` | `polyvisor:app` — the public contract, versioned deliberately |
| `runtime/wit/` | `polyvisor:internal` — the private contract between this repo's own components and glue |
| `runtime/` | the `runtime` component: `crates/kernel` (devices, sealing, checkpoints, pairing, sessions), `crates/engine` (automerge over subduction's sans-IO node), `component/` (the world, the iroh transport) |
| `visor/` | the `visor` component (trusted pixels) |
| `apps/` | example/reference apps (`todomvc`) |
| `web/` | glue TypeScript |
| `e2e/` | Playwright scenarios |
| `docs/` | `design.md`, the authority for everything above |

`docs/design.md` is the authority for architecture and contracts;
read it before arguing with anything here.

Run `just --list` for the available recipes; `just e2e` runs the Playwright
suite against a local iroh relay.

**Implemented:** three realms with TodoMVC; devices with two
tiers of rest, sealed OPFS checkpoints and a swept index; `tasks` as an
automerge document synced between devices over subduction and the iroh
relay; pairing by code + SAS into a device group that is the sync policy;
app content sealed as keyhive/BeeKEM envelopes; Google Drive as a dumb
ciphertext store (OAuth split between kernel and shell; a fake Drive in
e2e); app history rolled up as sedimentree fragments. Passkey unseal
(#166) and recovery kits (#167) are parked as issues. The settings UI is
deliberately minimal pending a redesign.
