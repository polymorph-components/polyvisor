// Storage-egress seams for the DENO-SIDE PROBES (bringup, leak-probe,
// table-probe) — not part of the browser bundle.
//
// The browser demo wires the real thing: grants held by the visor and a
// signer over an escrowed non-extractable key (../../runtime/keystore.ts). A CLI
// probe has no visor, no IndexedDB and no user to type a secret, so it
// wires the same three seams over a credential passed on the command
// line. This mirrors the native rig's `Egress`
// (engine/host/src/main.rs) and is honest about being a rig:
// the SHAPE under test is which import a call site travels through and
// what each seam will refuse, not per-user authority.

import { ComponentException } from "@polyengine/protocol";
import type { EngineNet, StoreFetch, StoreSign } from "../../runtime/engine.ts";

function refuse(message: string): never {
  throw new ComponentException(message);
}

function originOf(url: string, tier: string): string {
  try {
    return new URL(url).origin;
  } catch {
    refuse(`${tier}: unparseable url`);
  }
}

async function send(
  tier: string,
  method: string,
  url: string,
  headers: Array<[string, string]>,
  body: Uint8Array,
): Promise<{ status: number; body: Uint8Array }> {
  const empty = method === "GET" || method === "HEAD" || body.length === 0;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: empty ? undefined : body.slice() as unknown as BodyInit,
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    // The rig shares the browser seams' rule: a network condition is the
    // err side of the result, never an unbranded throw (which would trap
    // the component instead of feeding its retry loop).
    refuse(`${tier}: transport: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();

/** The rig's signer: same derivation as the browser's, over a raw secret
 * the probe was handed. No escrow here — a CLI process has nowhere to
 * escrow to; the confinement being exercised is the SEAM's scope refusal. */
function probeSigner(secret: string): StoreSign {
  return async (stringToSign, date, region, service) => {
    if (service !== "s3") refuse(`store-signer: out of scope: service ${service} != s3`);
    if (region !== "us-east-1") {
      refuse(`store-signer: out of scope: region ${region} != us-east-1`);
    }
    let raw = enc.encode(`AWS4${secret}`);
    for (const step of [date, region, service, "aws4_request"]) {
      const k = await crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      raw = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(step) as BufferSource));
    }
    const k = await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(
      new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(stringToSign) as BufferSource)),
    );
  };
}

/** Owner + public + signer for an S3 endpoint the probe may reach. */
export function probeNet(endpoint: string, secret: string): EngineNet {
  const granted = new URL(endpoint).origin;
  const owner: StoreFetch = (method, url, headers, body) => {
    const target = originOf(url, "store-owner-fetch");
    if (target !== granted) refuse(`store-owner-fetch: origin not granted: ${target}`);
    return send("store-owner-fetch", method, url, headers, body);
  };
  const publicFetch: StoreFetch = (method, url, headers, body) => {
    const target = originOf(url, "store-public-fetch");
    if (target !== granted) refuse(`store-public-fetch: origin not granted: ${target}`);
    // Structural anonymity: nothing is injected and anything the guest
    // set is dropped.
    return send(
      "store-public-fetch",
      method,
      url,
      headers.filter(([k]) => k.toLowerCase() !== "authorization"),
      body,
    );
  };
  // The rig's S3 endpoint has no app tier; the seam exists and says so.
  const shared: StoreFetch = () =>
    refuse("store-shared-fetch: no app tier on this provider");
  return { ownerFetch: owner, publicFetch, sharedFetch: shared, signer: probeSigner(secret) };
}

/** A reader instance: it may pull anonymously and can do nothing else.
 * The refusals are real seams, not absent imports — that is what makes
 * the confinement visible in the wiring. */
export function probeReaderNet(endpoint: string): EngineNet {
  const full = probeNet(endpoint, "");
  return {
    ownerFetch: () =>
      Promise.reject(
        new ComponentException("store-owner-fetch: no storage credential wired for this instance"),
      ),
    publicFetch: full.publicFetch,
    sharedFetch: full.sharedFetch,
    signer: () =>
      Promise.reject(
        new ComponentException("store-signer: no signing credential wired for this instance"),
      ),
  };
}

/** For probes that never touch storage at all. */
export const probeNoNet: EngineNet = {
  ownerFetch: () =>
    Promise.reject(
      new ComponentException("store-owner-fetch: no storage credential wired for this instance"),
    ),
  publicFetch: () =>
    Promise.reject(
      new ComponentException("store-public-fetch: no storage grant wired for this instance"),
    ),
  sharedFetch: () =>
    Promise.reject(
      new ComponentException("store-shared-fetch: no storage grant wired for this instance"),
    ),
  signer: () =>
    Promise.reject(
      new ComponentException("store-signer: no signing credential wired for this instance"),
    ),
};
