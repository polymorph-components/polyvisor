# polyvisor

A framework for building PWAs that inverts the standard web application
architecture: applications run client-side, as WebAssembly
component-model components, under user-controlled capability
confinement — a permissions model in the spirit of modern mobile OSes,
but cross-platform because the "OS" is a set of browser primitives the
framework composes.

**Status: nothing here is finally decided; the entire framework is
unstable until declared otherwise.** [NOTES.md](NOTES.md) is the living
design record and the authority behind everything on this page; open
questions live in the issue tracker.

## Trust model

The organizing invariant:

> **Nothing in the system is both live and trusted.**
> Trusted ⇒ static (the home origin's content, release artifacts).
> Live ⇒ untrusted by construction (relays, push services, storage
> backends, peers), covered by end-to-end crypto and capability
> confinement.

## Actors, realms, and trust domains

```mermaid
flowchart TB
    User(["User"])

    subgraph static ["TRUSTED ⇒ STATIC — remote"]
        Pub["Framework publisher<br/>root keys · TUF-style rotation"]
        AppPub["App publishers<br/>append-only sigchains"]
        Origin["Home origin<br/>static bytes + security headers"]
        SandboxO["Sandbox origin<br/>app-frame skeleton"]
        Wit["Monitors · witnesses ·<br/>contact-graph gossip"]
    end

    subgraph device ["USER DEVICE — client TCB: browser + OS + framework release"]
        Visor["Visor — main window realm<br/>trusted pixels: strip, drawer, sheets;<br/>consent UI outside app rectangles"]
        subgraph confined ["Sandboxed — untrusted by construction"]
            Frame["App UI frame<br/>opaque-origin iframe · zero direct network"]
            Apps["App components — wasm<br/>imports = grants; the linker is<br/>the permission system"]
            Services["Data services<br/>schema authorities over doc partitions"]
            Providers["Provider components<br/>s3 / dropbox / gdrive stores + panels<br/>egress scoped to own backend · ciphertext only"]
        end
        Runtime["Runtime — SharedWorker realm, per device<br/>device store · keystore · store-egress ·<br/>seal/unseal (DEK under keyslots)"]
        Engine["Engine composite — wasm, in TCB<br/>automerge · keyhive/BeeKEM · subduction<br/>one non-extractable Ed25519 device identity"]
    end

    subgraph infra ["LIVE ⇒ UNTRUSTED infra — pull tier at most: may fetch, never read"]
        Relay["iroh relays<br/>realtime sync path"]
        Store["Storage backends<br/>S3 / R2 / B2 / MinIO · Dropbox · Drive<br/>dumb ciphertext stores"]
        Broker["Notification broker<br/>keyed-tag equality match · budgeted"]
        Push["Web Push service"]
        OAuth["OAuth providers"]
    end

    subgraph peers ["PEERS — live; trust = exactly the keys they hold"]
        Own["User's other devices<br/>user = keyhive group of device identities"]
        Contacts["Contacts<br/>other users' device-groups"]
        Revoked["Revoked / stolen devices"]
    end

    Pub -->|"signed release manifest"| Origin
    Wit -.->|"constant-root canary checks<br/>(detection, not prevention)"| Origin
    Wit -.->|"head cosigning · gossip"| AppPub
    Origin -->|"static fetch — bootstrap SW<br/>verifies release (TOFU)"| Visor
    SandboxO -->|"frame skeleton + headers"| Frame
    AppPub -.->|"app versions verified against sigchain:<br/>no fork, no rollback"| Visor

    User <-->|"ceremonies + grants: powerbox picks,<br/>petnames, pairing SAS, unseal login"| Visor
    Visor <-->|"MessagePort DOM-op protocol"| Frame
    Apps -.->|"embedded UI bundle, via RPC"| Frame
    Apps -->|"WIT imports<br/>(granted capabilities)"| Engine
    Services -->|"WIT imports"| Engine
    Visor <-->|"engine RPC — nothing secret<br/>crosses the port"| Runtime
    Runtime -->|"hosts · seals state"| Engine
    Engine -->|"store strategies"| Providers

    Providers -->|"signed PUT / GET<br/>at unguessable names"| Store
    Engine <-->|"ciphertext blobs +<br/>membership ops — iroh QUIC"| Relay
    Runtime <-->|"PKCE exchange; tokens<br/>live in worker memory"| OAuth
    Runtime -->|"opaque wake tags (HMAC-keyed)"| Broker
    Broker -->|"match fires"| Push
    Push -->|"service-worker wake"| Runtime

    Relay <-->|"E2E sync"| Own
    Relay <--> Contacts
    Store <--> Own
    Store <--> Contacts
    Visor <-.->|"pairing ceremony (QR + SAS)"| Own
    User <-.->|"contact cards, out-of-band"| Contacts
    Relay -.->|"ciphertext at most"| Revoked
    Store -.->|"rotated names — nothing fetchable"| Revoked

    classDef trustedPlan fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20,stroke-dasharray: 6 4
    classDef tcb fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef confinedC fill:#fff3e0,stroke:#ef6c00,color:#e65100
    classDef untrusted fill:#ffebee,stroke:#c62828,color:#b71c1c
    classDef untrustedPlan fill:#ffebee,stroke:#c62828,color:#b71c1c,stroke-dasharray: 6 4
    classDef peer fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef actor fill:#fffde7,stroke:#f9a825,color:#f57f17

    class Pub,AppPub,Origin,SandboxO,Wit trustedPlan
    class Visor,Runtime,Engine tcb
    class Frame,Apps,Services,Providers confinedC
    class Relay,Store,OAuth untrusted
    class Broker,Push untrustedPlan
    class Own,Contacts,Revoked peer
    class User actor
```

**Solid borders are built** — in-tree and gated (the engine's native
batteries, the device-store matrix, the demo e2e suite). **Dashed
borders are planned** — designed in NOTES.md, no code yet: the entire
release-integrity story
([#3](https://github.com/polymorph-components/polyvisor/issues/3) —
publisher keys, signed manifests, the verifying bootstrap service
worker; the demo today is served as plain static files with none of
it), app-publisher sigchains and witnessing
([#52](https://github.com/polymorph-components/polyvisor/issues/52)),
the dedicated sandbox origin (an open decision — frames today are
opaque-origin `srcdoc`), and the notification broker + Web Push wake
path. Solid does not mean finished, either: the permission machinery
behind "imports = grants" exists as fragments (host-scoped fetch
imports, the egress-grant factories) while the general grant table and
consent surface are still design, and exactly one data service exists
(`polyvisor:tasks`).

Reading the diagram:

- **Realms on the device.** The visor owns the main window (trusted
  pixels: the strip, drawer, and sheets where every consequential act
  happens). App UI lives in an opaque-origin sandboxed iframe with zero
  direct network — all state and assets arrive over RPC. The runtime is
  a SharedWorker per device hosting the engine composite; wasm guest
  realms inside it split into the in-TCB engine and the confined
  apps/services/providers.
- **The linker is the permission system.** A component's authority is
  its import set: deny = unlinked or stubbed, prompt = the async import
  suspends on consent, revoke = a defined error, never a trap. Grants
  flow through the powerbox pattern — picking the thing *is* the grant.
- **Remote access tiers** use keyhive's vocabulary: *pull / read /
  mutate / manage*. Infra (relays, storage, broker) sits at pull — it
  may fetch ciphertext, never read it. Contacts sit at read and above,
  exactly as granted: read = BeeKEM epoch keys, pull = name-keys,
  write = signed operations validated at merge time.
- **The consent surface is the deliberate exception.** Mechanically it
  is the most confinable component in the system, but it holds *kernel
  capabilities* (grant-table write, trusted surface), granted only via
  the signed-release appointment path, never via the powerbox — TCB
  membership, not blast radius.
- **Static trust is detection-shaped.** The web platform has no pinning
  primitive; the bootstrap service worker verifies releases after a
  TOFU first visit, and monitors, witnesses, and contact-graph gossip
  make targeted substitution, rollback, and freezes detectable rather
  than impossible.
- **Headless compute** (the same engine at an always-on node or
  provider) is a conscious powerbox decision: that host holds keys for
  whatever it is granted, moving it from "infra" to "peer" in this
  picture.

## Repository layout

| Path | Contents |
| --- | --- |
| [NOTES.md](NOTES.md) | The living design record — authoritative |
| [engine/](engine/) | The engine composite: guest crates, fetcher component, native host harness |
| [runtime/](runtime/) | Embedding runtime: engine adapter, device store, keystore, pairing engine, storage egress |
| [visor/](visor/) | The visor: curated-DOM surface, frame isolation, system UI |
| [providers/](providers/) | Storage provider strategies and config panels (common, s3, dropbox, gdrive) |
| [wit/](wit/) | Framework-owned WIT contracts (surface, panel, tasks, fetch, blobstore draft) |
| [demo/](demo/) | The reference browser embedding and its e2e suite |
| [examples/](examples/) | Example app guests (todomvc) |
| [spikes/](spikes/) | Pure archive of executed validation spikes |
| [docs/](docs/) | GitHub Pages build |

## The substrate

The polymorph family de-risks the bottom of the stack:

- [polyengine](https://github.com/polymorph-components/polyengine) —
  components runtime-linked on stock browsers and Deno
- [component-iroh](https://github.com/polymorph-components/polymorph-iroh)
  — browser peers speaking end-to-end QUIC, one Ed25519 identity across
  all paths
- [polymorph:webcrypto](https://github.com/polymorph-components/polymorph-webcrypto)
  — identity keys as non-extractable platform handles behind
  capability-shaped WIT
- [polymorph:tls](https://github.com/polymorph-components/polymorph-tls)
  — in-guest crypto under a wasm timing-class policy
- [polymorph:test](https://github.com/polymorph-components/polymorph-test)
  — cross-implementation conformance machinery

The framework layer — the visor, the linker-as-permission-system, the
data services, and the consent UX — is what this repository builds.
