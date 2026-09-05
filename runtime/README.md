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
  device, strictly partitioned), `seal-records.ts` (the record shapes the
  seal writes, the IndexedDB keys they rest under, the typed `SealError`,
  and `getPrfEnrollment` — the one reader that needs no key),
  `seal-component.ts` (the adapter over the DEVICE SEAL COMPONENT, which
  is where the per-device DEK, the KEK ladder's v1 rungs, the PMSEALv1
  file format and the non-extractable signing handles now live —
  `device-seal/`, `polyvisor:device-seal@0.1.0`), `sealed-fs.ts` (an OPFS
  directory proxy that seals the engine's state root while the guest sees
  plaintext, calling the component for the bytes), `locks.ts` (the device
  lock, the lease, and the T0 sweep) and `anchor.ts` (the tab's
  sessionStorage pointer).

  **The seal is a component** (`device-seal/wit/world.wit` is its
  contract, and every doc comment in it is normative). What the boundary
  buys is that THE UNSEALED DEK EXISTS NOWHERE IN JAVASCRIPT: the worker
  holds a component and asks it to seal and open bytes, with no handle to
  export. Its reach is its imports — it can spell five record kinds and
  four key slots of ONE device's namespace, through the host-implemented
  `namespace` interface seal-component.ts builds, and cannot name
  another. The on-disk format is UNCHANGED, which is a requirement rather
  than a convenience: `tests/devstore/fixtures/legacy-seal-v1.json` is a
  device sealed by the pre-component TypeScript, and the matrix's
  `legacy-unseal` row opens it through the component every run.

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
    pins in front of every consumer of the index.
  - **Two kinds of rejection, two paths** (since the 0.4.0 bump —
    polyengine amendments A19/A20). *The engine's* errors cross as the
    embedder's **sanctioned cloneable form**: the worker sends
    `toCloneable(error)`, the client rehydrates with `fromCloneable`,
    and what an app catches is a REAL `ComponentException` minted by its
    own copy — `isComponentException(e)` true, `payload` intact, cause
    chain to full depth, the worker's stack carried verbatim. *The
    host's own* conditions keep a typed envelope and arrive as a
    `DeviceHostError` with a `code` (`wrong-passphrase`, `no-rung`,
    `timeout`, …). The split is not decoration: the cloneable form
    encodes any unbranded `Error` through a row carrying only
    `name`/`message`/`stack`/`cause`, so a `SealError`'s `code` — the
    thing the unseal ceremony branches on — would be dropped silently.
    Branch on the brand predicate for the first and on `code` for the
    second; never on `instanceof` across a bundle boundary.
    The cloneable form is **version-internal and never persisted**: it
    lives for one `postMessage` between two realms of one page load, and
    nothing in the device store writes one to storage.
  - **Platform posture is the default.** At attach the worker loads (or
    mints) the device's non-extractable Ed25519 pair from the namespace
    (the seal component's `identity` interface) and hands it to the
    engine through the app-owned
    `polyvisor:engine/device-identity@0.1.0` import. The pair arrives
    ALREADY as `SigningKey`/`VerifyingKey`, because seal-component.ts
    instantiates the seal with the SAME `@polymorph/webcrypto` module
    `newEngine` builds the port's own fragment from — module identity
    matters here, because a wrapper from a second copy of the package is
    not one the port recognizes, and one class family for both
    components is what makes the handoff a no-op. So the
    device's private key is never written into a checkpoint; a resumed
    device is the same device because the platform still holds its key.
    A checkpoint written in the older `seed` posture still resumes: the
    engine forks on the manifest, not on what the embedder prefers now.
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

`device-store/` is MOSTLY package-free, and the boundary moved at the
0.4.0 bump, so it is worth stating exactly where it now runs.

**Package-free** (only the platform and their own siblings, so they
type-check under any embedder's config and cannot be mis-pinned):
`index.ts`, `namespace.ts`, `names.ts`, `idb.ts`, `seal-records.ts`,
`sealed-fs.ts`, `locks.ts`, `anchor.ts` — and `rpc.ts`, whose only
imports are types, which erase. `sealed-fs.ts` declares the OPFS handle
interfaces `@polyengine/wasi/filesystem-web` consumes rather than
importing them, which is what buys its place here; it takes the sealing
functions as a parameter for the same reason, so the proxy stays
package-free while the bytes come from the component.

**Needs the embedder pin**: `seal-component.ts` does, and unavoidably —
instantiating the seal means the polyengine embedder and the webcrypto
port, so it is NOT re-exported from `mod.ts` (a consumer that only reads
the index to render a picker still needs no pins). `worker.ts` always did — hosting a device
means instantiating the engine, which is exactly why it is an entry
point the embedder bundles rather than something `mod.ts` re-exports.
`client.ts` joined it at 0.4.0, for one import: `fromCloneable`, which
is what turns the worker's engine rejection back into a real branded
`ComponentException` in the tab's realm. That was a deliberate trade —
the alternative was keeping a hand-rolled brand key in sync with a wire
constant that has now been renamed twice (A18, A19), silently both
times.

**The consequence for a picker.** Rendering the device list needs only
the index, and that path is still pin-free — but it must import
`index.ts` (and `anchor.ts`) DIRECTLY. Reaching them through `mod.ts`
pulls `client.ts` and therefore the pin, because a barrel re-exports
everything it names.

The other place a pin is needed is the probe harness, which mounts the
REAL published filesystem fragment and bundles the real worker; it
carries its own `tests/devstore/deno.json` with the pins copied from
`demo/deno.json`, exactly as each spike does.
