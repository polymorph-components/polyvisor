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
  sweep) and `anchor.ts` (the tab's sessionStorage pointer).

  **The worker host** sits on top of all of it and changes none of it:
  `worker.ts` is a SharedWorker ENTRY POINT — one worker per device, the
  device id in its name — owning the device lock and its lease, the
  namespace, the unseal state machine, the unwrapped DEK, and one engine
  instance mounted on the sealed state root. `client.ts` is the tab's
  half (`connectDevice()` → a typed remote `driver`/`tasks` pair plus
  `unseal`/`reseal`/`checkpoint`/`status`), and `rpc.ts` is the wire
  between them. Three things are worth knowing before reading it:

  - **`worker.ts` is not exported from `mod.ts`, deliberately.** It
    imports `../engine.ts`, whose bare `@polyengine`/`@polymorph`
    specifiers only an embedder can map; re-exporting it would put those
    pins in front of every consumer of the index. `client.ts` and
    `rpc.ts` import no package at all, so a picker stays package-free.
  - **The error envelope, not the exception.** `ComponentException` does
    not survive structured clone — clone carries an `Error`'s `name`,
    `message` and `stack` and drops every own property, which is the
    entire content of a WIT err. So a rejection crosses as
    `{message, name, isWitError, witPayload?, code?}` and the client
    re-throws a `DeviceHostError` exposing them. **Branch on those
    fields, never on the `ComponentException` brand and never on
    `instanceof`**: module identity does not cross a worker boundary.
    The client does mint the brand locally from the envelope's
    `isWitError` bit, so an adapter written against the in-process
    driver (`pairing-engine.ts`) works over the remote one unmodified —
    a bridge for existing consumers, not the contract.
  - **Checkpoint cadence is the embedder's**, and it is three triggers:
    a 500 ms trailing debounce after any mutating call, an explicit
    `checkpoint()` RPC, and a best-effort one when the last client
    detaches. "Best-effort" is meant literally — a killed tab never says
    goodbye and the worker has no unload hook of its own, so the
    debounce is what actually protects the data.

  Its gate is `just test` in this directory: a browser-driven probe
  matrix (Playwright over a bundled page, spike-style — none of
  IndexedDB, OPFS, Web Locks, CryptoKey persistence or sessionStorage
  can be asserted in Deno). Rows 11-18 drive the host end to end
  against the REAL engine artifacts: a killed worker, two genuine page
  reloads, two tabs sharing one worker, and the T0 sweep.

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
own siblings — with ONE exception, and the exception is the reason the
rule is worth stating. The core modules (index, namespace, seal,
sealed-fs, identity-keys, locks, anchor, plus the host's `client.ts` and
`rpc.ts`) type-check under any embedder's config and cannot be
mis-pinned; `sealed-fs.ts` declares the OPFS handle interfaces
`@polyengine/wasi/filesystem-web` consumes rather than importing them,
which is what buys that. `device-store/worker.ts` is the exception: it
imports `../engine.ts` because hosting a device means instantiating the
engine, so it needs the embedder's pins like any other consumer — which
is exactly why it is an entry point the embedder bundles rather than
something `mod.ts` re-exports.

The other place a pin is needed is the probe harness, which mounts the
REAL published filesystem fragment and bundles the real worker; it
carries its own `tests/devstore/deno.json` with the pins copied from
`demo/deno.json`, exactly as each spike does.
