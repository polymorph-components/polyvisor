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
| `runtime/` | the `runtime` component: `crates/kernel` (devices, sealing, checkpoints, pairing, contacts, sessions), `crates/engine` (history sync over subduction's sans-IO node), `crates/document-history` (shared Automerge adapter), `crates/{todo,visor,contacts}-model` (domain schemas), `component/` (the world, the iroh transport) |
| `proto/` | signed introduction wire schema; Rust bindings generated with prost |
| `visor/` | the `visor` component (trusted pixels) |
| `apps/` | example/reference apps (`todomvc`) |
| `web/` | glue TypeScript |
| `e2e/` | Playwright scenarios |
| `docs/` | `design.md`, the authority for everything above |

`docs/design.md` is the authority for architecture and contracts;
read it before arguing with anything here.

Run `just --list` for the available recipes; `just e2e` runs the Playwright
suite against a local iroh relay. Building the introduction codec requires
`protoc` (`protobuf-compiler` on Debian/Ubuntu).

## Contacts

The visor's Contacts section manages a private address book shared among
your paired devices. It records who asserted each claim and how it arrived,
with local petnames and preferred values kept separately. Original signed
introductions are verified on import and discarded; only selected claims
and their provenance are saved.

Use **Share** to choose claims, review an introduction, and export a contact
file or link. Keys are always included; name is the default shared claim.
**Meet now** exchanges self-introductions over a live encrypted connection:
share the QR/link, compare the displayed code, and confirm on both devices.
Meeting another user does not pair their device into your private group.

**Import** also accepts an unsigned JSON contact list, with optional public
keys encoded as 64 hexadecimal characters:

```json
[
  {
    "claims": [
      { "name": "name", "value": "Carol" },
      { "name": "email", "value": "carol@example.test" }
    ]
  }
]
```

Unsigned imports are labeled as imported information, not authenticated
claims from those contacts. Review which identities and claims to keep.
Keyless entries can be explicitly merged into an established keyed contact.

**Implemented:** three realms with TodoMVC; devices with two
tiers of rest, sealed OPFS checkpoints and a swept index; `tasks` as an
automerge document synced between devices over subduction and the iroh
relay with live revision watches; pairing by code + SAS into a device group
that is the sync policy; shared visor personalization in the same sealed
app-document machinery, with device-specific member labels;
app content sealed as keyhive/BeeKEM envelopes; Google Drive as a dumb
ciphertext store (OAuth split between kernel and shell; a fake Drive in
e2e); app history rolled up as sedimentree fragments; private contacts and
signed introductions in a drawer with responsive sidebar navigation.
Passkey unseal (#166) and recovery kits (#167) are parked as issues.
