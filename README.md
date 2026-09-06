# polyvisor

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
| `runtime/` | the `runtime` component (kernel + engine) |
| `visor/` | the `visor` component (trusted pixels) |
| `apps/` | example/reference apps (`todomvc`) |
| `web/` | glue TypeScript |
| `e2e/` | Playwright scenarios |
| `docs/` | `design.md`, the authority for everything above |

`docs/design.md` is the authority for rulings, contracts and milestones;
read it before arguing with anything here.

Run `just --list` for the available recipes. This is **M0**: skeleton
only.
