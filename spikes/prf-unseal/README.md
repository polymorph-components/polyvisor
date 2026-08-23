# prf-unseal — can the PRF rung's browser gate exist? (PRF unseal round)

An executed validation record, not a design. The PRF unseal rung
(PERSISTENCE.md's parked passphrase-free rung) needs a browser gate
driven through Playwright's CDP virtual authenticator; wosh validated
every passkey ceremony EXCEPT the PRF extension, so whether that
authenticator can produce PRF outputs at all was the question gating
the whole round. It can. The probe that measured it is in this
directory and re-runs with `just run`.

```
just run     # drive the matrix, verdict per row (writes last-run.json)
just check   # type-check the runner
```

Run of record: 2026-08-22, **Chromium 143.0.7499.4** (playwright
1.57.0), page served and navigated on `http://localhost:<ephemeral>` —
a WebAuthn RP ID must be a domain, so 127.0.0.1 is a synchronous
SecurityError (wosh's browser-passkey.mjs finding, re-confirmed by
construction here). All PRF inputs are labeled synthetic constants
(0x01×32 and friends); outputs are reported as lengths, equality bits
and 8-char prefixes only.

## The matrix

| # | Question | Verdict | Evidence (one line) |
|---|---|---|---|
| 0 | CDP `addVirtualAuthenticator` accepts `hasPrf: true` | **PASS** | ctap2/internal, resident keys, UV, automatic presence — the option is real in this Chromium |
| 1 | Detection a page can run before offering the rung | **INFO** | `PublicKeyCredential.getClientCapabilities()` exists and reports `"extension:prf": true` (and `userVerifyingPlatformAuthenticator: true`) — a clean capability answer, no probe ceremony needed |
| 2 | `create()` with `prf: {}` enables PRF on the credential | **PASS** | `getClientExtensionResults().prf = {enabled: true}`; credentialId 32 bytes; `transports=["internal"]` (the wosh capture/replay discipline applies unchanged) |
| 3 | `get()` with `prf.eval` produces an output | **PASS** | `results.first` is 32 bytes |
| 4 | **Determinism** — same credential + same input, across ceremonies | **PASS** | two independent `get()` calls agree byte-for-byte; without this the wrap could never re-open |
| 5 | Separation — a different input is a different output | **PASS** | 0x01×32 vs 0x02×32 differ |
| 6 | Does the effective UV state change the output? | **INFO** | `uv: required` and `uv: discouraged` answered IDENTICALLY here — but hmac-secret's two-credRandom shape says a real authenticator MAY differ, so the design pins `userVerification: "required"` at enrollment and every unseal anyway |
| 7 | Dual-input eval (`first` + `second`) | **INFO** | both outputs returned (32 bytes each) — the future re-wrap/rotation seam: one ceremony can evaluate old and new inputs together |
| 8 | PRF eval at `create()` time | **INFO** | **this Chromium returns `results.first` (32 bytes) at registration** — enrollment can wrap without a follow-up assertion here; older/other clients may return `enabled` only, so the design keeps the one-assertion fallback |
| 9 | PRF output → HKDF-SHA-256 → non-extractable AES-KW KEK; round-trip; refusal; the crossing | **PASS** | re-derived KEK unwraps the wrap; a KEK from a different PRF output refuses cleanly (AES-KW integrity check, no partial key); the non-extractable KEK handle structured-clones through `postMessage` into a Worker and unwraps THERE |
| 10 | Credential + authenticator survive a REAL reload; empty `allowCredentials` works | **PASS** | discoverable-credential assertion with PRF output after `page.reload()` — the CDP authenticator is session-bound and the navigation does not tear it down (wosh's empirical note, re-measured with PRF) |

Nothing blocks the rung. The browser gate can drive enrollment,
unseal, wrong-key refusal and reload-survival end to end against the
virtual authenticator.

## The findings that matter

### Row 4 is the rung's existence proof

WebAuthn PRF is hmac-secret: a per-credential secret HMAC'd over the
(hashed, context-separated) input. Deterministic per (credential,
input) is the property that makes it a KEK source at all — the same
ceremony next week must derive the same AES-KW key or the DEK wrap
written today can never open. Measured, not assumed, because the whole
rung rests on it.

### Row 6 forces a pinned `userVerification`

CTAP2's hmac-secret keeps TWO per-credential secrets — one used when
user verification was performed, one when it was not. This virtual
authenticator answered identically either way, but a real one is
allowed to differ, and an unseal that ran with a different effective
UV state than enrollment would derive a wrong key and read as
tampered. The design therefore pins `userVerification: "required"` on
both the enrolling ceremony and every unseal assertion. (UV=required
also matches the rung's honest-strength story: the authenticator
gates the secret behind presence + verification.)

### Row 8 improves enrollment UX but must not be relied on

Chromium evaluates PRF at `create()` time, so enrollment here can
derive the KEK and wrap the DEK with a single ceremony. The spec makes
this optional; a client that returns only `{enabled: true}` needs one
follow-up `get()` naming the fresh credential. The rung does both:
use create-time results when present, fall back to one assertion.

### Row 9 is the page→worker crossing, validated

`navigator.credentials` is window-only, so the assertion must run on
the PAGE; what crosses to the device worker is the HKDF-derived
NON-EXTRACTABLE AES-KW handle — a CryptoKey structured-clones through
`postMessage` exactly as it does into IndexedDB. The raw PRF output
exists briefly in page JS (unavoidable — the extension returns an
ArrayBuffer), which is the same trust posture as the passphrase rung
(typed into a page input, sent over the port); what the handle
crossing buys is that the material entering the worker cannot be
exported there either.
