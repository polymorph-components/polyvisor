// THE WINDOW HALF OF THE PASSKEY RUNG (PERSISTENCE.md, "The PRF rung:
// passkey unseal"; the platform facts are spikes/prf-unseal/README.md's
// executed matrix).
//
// WEBAUTHN CANNOT RUN IN A WORKER. `navigator.credentials` is exposed on
// Window and nowhere else, so the enrollment and unseal ceremonies must
// happen on the PAGE. This module runs them, derives the AES-KW key
// encryption key from the assertion's PRF output, and hands the worker a
// NON-EXTRACTABLE handle across the port — never the output, never the
// DEK. seal.ts validates that handle on arrival (`requirePrfKek`) rather
// than trusting where it came from.
//
// THE TRUST SENTENCE, said here because this is where it applies: the
// RAW PRF OUTPUT TRANSITS PAGE JS for the length of the derivation. The
// extension hands it back as an ArrayBuffer and there is no way to ask
// the browser to keep it on the platform's side; what this module can do
// — import it into WebCrypto immediately, derive, and drop it — it does.
// That is the SAME CLASS OF EXPOSURE as the passphrase rung, whose
// secret is typed into a page input and crosses the port raw
// (PERSISTENCE.md, "The window/worker split, and the trust sentence").
// What the rung removes is the human secret and the wrap's offline
// guessability; what it cannot remove is "script running on this origin
// at unseal time observes the ceremony". What it adds over `until-reseal`
// is that possession of the profile alone does not open the device: the
// authenticator demands a fresh presence-plus-verification per
// assertion.
//
// THIS MODULE MUST NEVER BE IMPORTED BY worker.ts. Every symbol here
// touches `window`/`navigator`, so an import would be a module that
// cannot evaluate in the host's global — and the split above is the
// reason it is a separate file rather than a branch inside seal.ts.
//
// IT IMPORTS NO PACKAGE — DOM globals and sibling modules only, which is
// runtime/README.md's resolution model for the device-store core, kept.

import { openNamespace } from "./namespace.ts";
import { getPrfEnrollment, type PrfEnrollment, SealError } from "./seal.ts";

/**
 * Can this browser do the PRF extension at all — asked BEFORE offering
 * the rung, so a user is never walked into a ceremony that cannot
 * finish (PERSISTENCE.md: "No PRF support at all → the choice is simply
 * not offered, with a plain sentence, never a broken ceremony").
 *
 *   "no"     — no WebAuthn here, or the client says it has no PRF.
 *   "yes"    — `getClientCapabilities()` reports `extension:prf`
 *              (spikes/prf-unseal row 1: this Chromium answers cleanly,
 *              so no probe ceremony is needed).
 *   "maybe"  — the method is absent, which is a browser too old to be
 *              asked. OFFER, and let enrollment verify: `prf.enabled`
 *              at `create()` is the authoritative answer, and a refusal
 *              there writes nothing.
 */
export async function prfCapability(): Promise<"yes" | "no" | "maybe"> {
  const pkc = (globalThis as unknown as {
    PublicKeyCredential?: {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    };
  }).PublicKeyCredential;
  if (!pkc) return "no";
  if (!pkc.getClientCapabilities) return "maybe";
  try {
    const caps = await pkc.getClientCapabilities();
    return caps["extension:prf"] === true ? "yes" : "no";
  } catch {
    // A method that exists and throws tells us nothing either way.
    return "maybe";
  }
}

/** What an enrollment ceremony produces: the handle the worker wraps
 * under, and the metadata it must record so a later unseal can name the
 * same credential and evaluate the same input. */
export interface PrfGrant {
  kek: CryptoKey;
  enrollment: PrfEnrollment;
}

const SALT_BYTES = 32;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * ENROLL A PASSKEY FOR THIS DEVICE. Returns the derived KEK and the
 * enrollment metadata; WRITES NOTHING — the durable half is the worker's
 * `promote({policy: "passkey", prf: ...})`, which is what makes a failed
 * ceremony leave the device exactly as it was.
 *
 * `userVerification: "required"` IS PINNED HERE AND AT EVERY UNSEAL, and
 * the pin is not cosmetic. CTAP2's hmac-secret keeps TWO per-credential
 * secrets — one used when user verification was performed, one when it
 * was not — so a ceremony that ran with a different effective UV state
 * than enrollment could derive a WRONG KEY on a real authenticator and
 * surface as a wrong-passkey refusal on a device nothing is wrong with.
 * The virtual authenticator answered identically either way
 * (spikes/prf-unseal row 6, INFO), which is exactly why this is pinned
 * rather than assumed from what the matrix observed.
 *
 * A RESIDENT (discoverable) CREDENTIAL is required, the wosh discipline
 * (~/p/wosh/site/passkey-store.ts's `enroll`): the device's wrap must
 * remain openable even if the browser's own hint is lost, and a
 * discoverable credential is findable by the authenticator without an
 * allow-list.
 */
export async function enrollPasskey(deviceId: string, petname: string): Promise<PrfGrant> {
  const prfInput = random(SALT_BYTES);
  const hkdfSalt = random(SALT_BYTES);
  const rpId = location.hostname;
  const name = petname.trim().length > 0 ? petname.trim() : "this device";

  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "polyvisor" },
      user: { id: random(16), name, displayName: name },
      // NOTHING VERIFIES THIS CHALLENGE, and it is honest to say so:
      // attestation is "none" and there is no server-side ceremony state
      // for a challenge to defend. It is present because the API
      // requires one (wosh's `enroll` records the same).
      challenge: random(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      // The cast is the spike's (spikes/prf-unseal/run.ts): the DOM lib
      // this repo checks against has no `prf` member on the extension
      // inputs, although the runtime shape is exactly this.
      extensions: {
        prf: { eval: { first: prfInput as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new SealError("unsupported", "the browser returned no credential");

  const ext = cred.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  if (ext.prf?.enabled !== true) {
    // NOTHING HAS BEEN WRITTEN and the device is untouched. The one
    // residue is the credential the authenticator may have minted, which
    // only its owner can delete there (wosh's `forget` note) — the copy
    // that shows this message has to say so.
    throw new SealError(
      "unsupported",
      "this authenticator declined to serve a passkey key for this device; " +
        "nothing was changed here, but it may have saved a passkey you can delete from it",
    );
  }

  const response = cred.response as AuthenticatorAttestationResponse;
  // THE ONE MOMENT WEBAUTHN SAYS WHERE THIS CREDENTIAL LIVES. Recorded
  // once at registration and replayed in every later `allowCredentials`
  // so the browser goes straight to the right authenticator instead of
  // opening a "where is your passkey?" chooser — the wosh capture/replay
  // discipline (~/p/wosh/site/passkey-store.ts's `enroll`/`assert`).
  const transports = response.getTransports?.() ?? [];

  // CREATE-TIME EVAL WHERE THE CLIENT OFFERS IT (spikes/prf-unseal row
  // 8: this Chromium returns `results.first` at registration, one
  // ceremony instead of two). The spec makes it optional, so a client
  // that returned only `{enabled: true}` gets the one follow-up
  // assertion below — the rung does both rather than relying on either.
  let output = ext.prf.results?.first;
  if (!output) {
    const allow: PublicKeyCredentialDescriptor = {
      type: "public-key",
      id: cred.rawId,
      ...(transports.length ? { transports: transports as AuthenticatorTransport[] } : {}),
    };
    const asserted = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId,
        userVerification: "required",
        allowCredentials: [allow],
        extensions: {
          prf: { eval: { first: prfInput as BufferSource } },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    output = (asserted?.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } };
    })?.prf?.results?.first;
  }
  if (!output) {
    throw new SealError(
      "unsupported",
      "this browser enabled the passkey extension but returned no key material for it; " +
        "nothing was changed here",
    );
  }

  const enrollment: PrfEnrollment = { credentialId: new Uint8Array(cred.rawId), rpId, prfInput, hkdfSalt };
  if (transports.length) enrollment.transports = transports;
  return { kek: await deriveKek(output, hkdfSalt, deviceId), enrollment };
}

/**
 * THE UNSEAL CEREMONY: assert the device's enrolled passkey and derive
 * the KEK the worker will unwrap with. One authenticator prompt.
 *
 * The enrollment metadata is read from the device's own `seal` store,
 * which rests unsealed by design — the credential id and the salts are
 * exactly the exposure `PrfWrap`'s contract already prices in. The
 * WRAPPED BYTES are not read and are not needed here: this side never
 * touches the DEK.
 */
export async function assertPasskey(deviceId: string): Promise<CryptoKey> {
  const meta = await getPrfEnrollment(openNamespace(deviceId));
  if (!meta) throw new SealError("no-rung", "this device has no passkey rung");

  const allow: PublicKeyCredentialDescriptor = {
    type: "public-key",
    id: meta.credentialId as BufferSource,
    ...(meta.transports?.length
      ? { transports: meta.transports as AuthenticatorTransport[] }
      : {}),
  };
  const asserted = await navigator.credentials.get({
    publicKey: {
      // NOTHING VERIFIES THIS CHALLENGE EITHER, and the reason is worth
      // stating rather than leaving to be inferred: the signature is not
      // what this rung consumes. The PRF output is. The assertion's
      // authentication value here is that the authenticator would not
      // produce that output without a fresh presence-plus-verification.
      challenge: random(32),
      rpId: meta.rpId,
      userVerification: "required",
      allowCredentials: [allow],
      extensions: {
        prf: { eval: { first: meta.prfInput as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  const output = (asserted?.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  })?.prf?.results?.first;
  if (!output) {
    throw new SealError(
      "unsupported",
      "this browser or authenticator did not produce key material for this device's passkey",
    );
  }
  return await deriveKek(output, meta.hkdfSalt, deviceId);
}

/**
 * PRF output → HKDF-SHA-256 → the AES-KW key encryption key, v1
 * (PERSISTENCE.md, "The derivation, ruled"; spikes/prf-unseal row 9
 * measured the round trip and the refusal).
 *
 * NON-EXTRACTABLE, `wrapKey`/`unwrapKey` ONLY. It is the one CryptoKey
 * that crosses to the worker, and both properties are what make that
 * crossing narrow: the receiver can ask the platform to unwrap with it
 * and can do nothing else, and it cannot be read back as bytes by
 * either side. seal.ts re-checks both on arrival.
 *
 * THE DEVICE ID IS BOUND INTO `info`, and that is the record's ruling
 * rather than decoration: a wrap record copied from one namespace into
 * another derives a different key, so it REFUSES at the unwrap as a
 * clean `wrong-passkey` instead of opening a foreign DEK and surfacing
 * as GCM tamper noise somewhere downstream.
 */
async function deriveKek(
  prfOutput: ArrayBuffer,
  hkdfSalt: Uint8Array,
  deviceId: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    false,
    ["deriveKey"],
  );
  // HYGIENE, NOT A GUARANTEE, and the comment says which it is: the
  // engine may already have copied this buffer, and JS offers no way to
  // scrub what it copied. Overwriting the one reference we hold shortens
  // the window in which a heap snapshot of this page contains the
  // output; it does not close it.
  new Uint8Array(prfOutput).fill(0);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: hkdfSalt as BufferSource,
      info: new TextEncoder().encode(`pm-device-store prf-kek v1|${deviceId}`) as BufferSource,
    },
    material,
    // `length` is REQUIRED for a derived AES key even though AES-KW-256
    // is implied by the usages — seal.ts's `kekFromPassphrase` records
    // the same Chromium refusal.
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}
