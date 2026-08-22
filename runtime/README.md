# runtime/ — the embedding runtime

This is what any polyvisor embedder needs to run an engine composite,
with or without the visor UI (#73's ruling: graduated out of
`demo/host` — the visor's demo was the only consumer, but the code
itself is not visor-specific). It began life inside `demo/host/` and
`demo/tools/`; the demo (`demo/host/demo.ts` and its bringup/probe
entrypoints) is still its one consumer, importing these modules by
relative path.

- **`engine.ts`** — the polyengine embedding adapter for the engine
  composite: envelope loading, import-record assembly (WASI batteries,
  a fetch-backed `wasi:http`, polyengine ports, a sockets stub), typed
  `driver`/`tasks` views over the composite's exports, and the
  per-instance import-fragment freshness bookkeeping that makes
  repeated instantiation cheap.

- **`keystore.ts`** — the #11 escrow slice: signing credentials held as
  non-extractable WebCrypto handles, with exactly one moment of
  cleartext (the escrow ceremony itself). `exportKey` is banned from
  this file and grep-enforced — see `demo/scripts/check-invariants.sh`
  invariant (d).

- **`pairing-engine.ts`** — the real `PairingDriver` over the engine
  composite. The `PairingDriver` CONTRACT type itself stays in
  `visor/ui/pairing-driver.ts` (the visor owns the contract); this file
  is the implementation. The mock alternative used to exercise the
  visor without a running engine stays with the demo, at
  `demo/host/pairing-mock.ts` — it isn't a runtime concern.

- **`stubs.ts`** — the browser-profile `wasi:sockets` stub the
  composite's imports need to satisfy, even though nothing in a
  browser embedding actually opens a socket.

- **`device-store/`** — the browser-side home of all devices on an
  origin (#20's G5, track T-C). **`PERSISTENCE.md` is the governing
  design record: read it first, and its vocabulary — index, namespace,
  tier, seal/unseal, posture, the KEK ladder, the T0 anchor and sweep —
  is this module family's vocabulary.** The unsealed `index.ts` (what
  may exist before unseal, and the long list of what may never),
  `namespace.ts` (one IndexedDB database plus one OPFS directory per
  device, strictly partitioned), `seal.ts` (the per-device DEK and the
  KEK ladder's v1 rungs), `identity-keys.ts` (non-extractable signing
  handles persisted per device, with validate-on-load — absorbed here
  from the webcrypto port by the #391 ruling: storing a handle is a
  browser capability, not a WebCrypto one), `sealed-fs.ts` (an OPFS
  directory proxy that seals the engine's state root while the guest
  sees plaintext), `locks.ts` (the device lock, the lease, and the T0
  sweep) and `anchor.ts` (the tab's sessionStorage pointer). The worker
  host and its RPC envelope are the NEXT track; everything here is
  callable from a page or a worker and holds no long-lived connection.

  Its gate is `just test` in this directory: a browser-driven probe
  matrix (Playwright over a bundled page, spike-style — none of
  IndexedDB, OPFS, Web Locks, CryptoKey persistence or sessionStorage
  can be asserted in Deno).

- **`tools/translate.ts`** — build-time translation from a component
  binary to an envelope (plan + FACT adapters). This runs at build
  time, not at import time, but it's an embedder concern like the
  rest: whoever embeds the engine has to produce the envelope somehow.

## Resolution model

These modules import `@polyengine/*` and `@polymorph/*` packages by BARE
specifier. They are not resolved here — the EMBEDDER's own deno config
maps them (see `demo/deno.json`'s module-identity comment for why: the
mapping has to live with the consumer, not the runtime, or two
embedders in the same process tree could get two different identities
for what should be the same module). `demo/deno.json` is the only
example of that mapping so far.

`device-store/` imports NO package at all — only the platform and its
own siblings — so it type-checks under any embedder's config and cannot
be mis-pinned. `sealed-fs.ts` declares the OPFS handle interfaces
`@polyengine/wasi/filesystem-web` consumes rather than importing them,
which is what buys that. The one place a pin is needed is the probe
harness, which mounts the REAL published fragment; it carries its own
`tests/devstore/deno.json` with the pins copied from `demo/deno.json`,
exactly as each spike does.
