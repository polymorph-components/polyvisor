// The engine's storage egress: three named seams per instance (#7).
//
// ONE IMPLEMENTATION, TWO EMBEDDERS. This module used to live inline in
// demo/host/demo.ts; it is extracted here so the in-page demo and the
// device-store worker host (runtime/device-store/worker.ts) build their
// `EngineNet` over the SAME factories rather than a lookalike. Authority
// lives in the instance, selection is by import name, and a rebind
// mutates a grant's CONTENTS rather than relinking the wiring — see
// runtime/STORAGE-EGRESS.md §1 and §7, and issue #7 for the original
// egress-grant memo. The moved comments below carry the semantic detail;
// this header only orients the reader to why the file exists.
//
// CONSTRAINT: this module must run inside a SharedWorker as well as the
// page, so it imports no `node:` builtins and no DOM-only surface beyond
// `fetch`/`URL`/`TextEncoder`/`TextDecoder`/`btoa` (all present in
// workers).

import { ComponentException } from "@polyengine/protocol";
import type { StoreFetch } from "./engine.ts";

/** `throw new ComponentException(payload)` is the err side of a
 * `result<_, string>` (embedder-api §"Error model"; same brand the
 * webcrypto/websocket ports use). An UNBRANDED throw would trap the
 * caller instead of letting it render the refusal. */
function witErr(message: string): never {
  throw new ComponentException(message);
}

/** Extract the WIT err payload from a caught ComponentException, falling
 * back to the exception's own string form. */
function err(e: unknown): string {
  const p = (e as { payload?: unknown }).payload;
  return typeof p === "string" ? p : String(e);
}

// --- the engine's storage egress: three named seams per instance (#7) --------
//
// The engine composite no longer imports a generic fetch. It imports
// `store-owner-fetch`, `store-public-fetch` and `store-signer`, and what
// each one is wired to IS the grant. Selection is by IMPORT NAME: a call
// site that wants to act as the user had to be written against the owner
// import when the guest was compiled, so attaching the wrong credential
// is inexpressible rather than checked. The near-miss the memo names is
// live here — on Dropbox the owner tier, the link tier and anonymous
// reads all talk to the SAME hosts, so destination-based injection would
// silently deanonymize the recipient path.
//
// REBIND, NOT RELINK. The wiring is fixed at instantiation; what changes
// when the user saves new storage settings is the CONTENTS of the mutable
// grant object each seam closes over. The handle names the relationship,
// not the token bytes — which is also why a refreshed Dropbox bearer
// needs no re-instantiation, and why an instance wired without authority
// can never acquire it by a later save.
export interface EgressGrant {
  provider: "s3" | "dropbox" | "gdrive" | null;
  /** Origins reachable AS THE USER. */
  origins: Set<string>;
  /** Origins reachable anonymously. gdrive: always empty — no capability
   * is ever minted for this provider (DRIVE.md §1). */
  publicOrigins: Set<string>;
  /** Origins reachable as the APP (app auth, never user identity).
   * gdrive: always empty, same reason as above — there is no app tier
   * to reach. */
  sharedOrigins: Set<string>;
  /** Dropbox/gdrive owner tier only; never in a config, never in a
   * component. */
  bearer?: string;
  refresh?: string;
  /** The app identifiers. Public by nature, and held by EVERY tier's
   * grant including the recipient's — app auth is the link tier's only
   * credential, and it says nothing about who is reading.
   *
   * For gdrive these fields carry the OAuth CLIENT id/secret —
   * installed-app identifiers, the same public-by-nature class as
   * Dropbox's appKey/appSecret (DRIVE.md §3: Google's own docs say an
   * installed app's client secret is "not treated as a secret"). Bearer
   * and refresh carry the user's own tokens, exactly as for Dropbox. */
  appKey?: string;
  appSecret?: string;
  /** The token endpoint the owner seam refreshes against. Defaults per
   * provider (DROPBOX_TOKEN_URL / GOOGLE_TOKEN_URL) when unset; set by
   * embedders whose backend is self-hosted or fake (the devstore
   * harness's fake Drive, DRIVE.md's Gates section). Ordinary
   * addressing, the same reason gdrive-config carries `api-base`. */
  tokenUrl?: string;
}

export function emptyGrant(): EgressGrant {
  return {
    provider: null,
    origins: new Set(),
    publicOrigins: new Set(),
    sharedOrigins: new Set(),
  };
}

export function normalizeOrigin(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const origin = url.origin;
  // data:/blob:-style schemes serialize to "null" — not a destination.
  if (!origin || origin === "null") return null;
  return origin;
}

/** The visor's own reading of where a request is going. Structural
 * (scheme+host+port via the platform's URL parser), never a string
 * prefix test — prefix matching on URLs is how origin confinement is
 * usually gotten wrong. */
function requestOriginOf(url: string, tier: string): string {
  const o = normalizeOrigin(url);
  if (o === null) witErr(`${tier}: unparseable url`);
  return o;
}

/** One outbound request. The body is copied out of the guest's view
 * before it crosses back, and the dom lib wants a plain ArrayBuffer. */
async function sendRequest(
  /** Which seam is speaking — the brand on a transport refusal, so the
   * guest's error text names the import the call travelled through. */
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
      body: empty ? undefined : body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer,
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    // A NETWORK CONDITION IS A RESULT, NOT A TRAP. `fetch` rejects with a
    // bare TypeError when the endpoint is down, DNS fails, CORS refuses
    // or the body read is cut short — and an UNBRANDED throw out of a
    // host import traps the component, killing an engine that was fully
    // prepared to cope: the guest retries transport failures three times
    // and labels them (`request_label`). Pre-retrofit the wasip3 http
    // shim returned the err side here, and losing that turned "MinIO is
    // not running" into a dead instance. So the throw is re-branded as
    // the err side of `result<response, string>`, which is the guest's
    // to handle.
    //
    // ONLY the transport call is wrapped. Origin refusals and the other
    // named errors above are already branded and must keep their own
    // words.
    witErr(`${tier}: transport: ${err(e)}`);
  }
}

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
/** Google's OAuth2 token endpoint — the refresh target for the gdrive
 * provider (DRIVE.md §3/§4). Overridable per-grant via `tokenUrl` for
 * self-hosted/fake backends (the devstore harness's fake Drive). */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Percent-encode one `application/x-www-form-urlencoded` value — the
 * refresh body the guest used to build for itself. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `store-owner-fetch` for an instance holding `grant`. Acts as the user,
 * and the two providers differ in HOW:
 *
 * - S3: the request passes through untouched. The authority is the
 *   SIGNER — the guest built the x-amz headers and an Authorization
 *   value out of public parts plus a signature it had to ask for. There
 *   is nothing here to inject.
 * - Dropbox/gdrive: a bearer token is disclosed to the destination by
 *   design (the SigV4-vs-bearer asymmetry recorded on #22), so this seam
 *   owns it: any component-supplied `authorization` is DROPPED — it
 *   could only be a guess or an attempt to echo something to the wire —
 *   and the visor attaches the token it holds, on the way out. The
 *   401→refresh→retry shape is the same for both providers; the refresh
 *   sub-request's shape differs (DRIVE.md §4: "the Dropbox shape,
 *   generalized per provider").
 *
 * `onBearerRefreshed` mirrors CONTRACT: this used to be a module-scoped
 * `let` the embedder assigned after instantiation (the demo installs it
 * late, in `boot`, once its own local state exists to forward into); as
 * a factory parameter it is now an ordinary optional callback instead of
 * mutable module state shared across embedders. It takes a second,
 * optional argument: a rotated refresh token, when the provider issued
 * one (DRIVE.md §4 — Google may rotate; Dropbox's refresh response never
 * has, so that path passes `undefined`).
 */
export function makeOwnerFetch(
  grant: EgressGrant,
  onBearerRefreshed?: (token: string, refreshToken?: string) => void,
): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-owner-fetch: no storage grant configured yet");
    }
    const target = requestOriginOf(url, "store-owner-fetch");
    if (!grant.origins.has(target)) {
      witErr(`store-owner-fetch: origin not granted: ${target}`);
    }
    if (grant.provider === "s3") {
      return await sendRequest("store-owner-fetch", method, url, headers, body);
    }
    const outbound = (token: string): Array<[string, string]> => {
      const h = headers.filter(([k]) => k.toLowerCase() !== "authorization");
      h.unshift(["authorization", `Bearer ${token}`]);
      return h;
    };
    const bearer = grant.bearer ?? "";
    if (bearer === "") {
      witErr("store-owner-fetch: no bearer token held for this instance");
    }
    const first = await sendRequest("store-owner-fetch", method, url, outbound(bearer), body);
    if (first.status !== 401 || !grant.refresh || !grant.appKey) return first;
    // TOKEN REFRESH IS THE SEAM'S BUSINESS NOW: the guest deleted its own
    // 401-refresh-retry along with the token it used to hold, so an
    // expired token must never become guest business again. Request shape
    // ported verbatim from what the guest deleted (see
    // engine/guest/src/lib.rs `dbx_refresh` in this branch's
    // diff): form-encoded, `client_id` in the body.
    //
    // CONTRACT: the dispatch described this as "Basic app auth". The
    // deleted guest code — and the visor's own PKCE authorization-code
    // exchange — use the public-client shape instead, with no
    // Authorization header at all. The conservative reading is to
    // reproduce the code path that is known to have worked; a PKCE
    // public client cannot use an app secret anyway.
    const isGdrive = grant.provider === "gdrive";
    const refreshUrl = grant.tokenUrl ?? (isGdrive ? GOOGLE_TOKEN_URL : DROPBOX_TOKEN_URL);
    const refreshBody = isGdrive
      // gdrive: Google's installed-app exchange. `client_secret` rides
      // along when the grant holds one (DRIVE.md §3: an installed app's
      // secret "is not treated as a secret", so including it here is not
      // a confidentiality claim, just matching Google's own token-
      // endpoint shape for this client class).
      ? `grant_type=refresh_token&refresh_token=${formEncode(grant.refresh)}&client_id=${
        formEncode(grant.appKey)
      }${grant.appSecret ? `&client_secret=${formEncode(grant.appSecret)}` : ""}`
      : `grant_type=refresh_token&refresh_token=${formEncode(grant.refresh)}&client_id=${
        formEncode(grant.appKey)
      }`;
    // The refresh sub-request is transport too: a token endpoint that is
    // unreachable must not trap the component either. It also must not
    // REPLACE the answer the guest already has — an unreachable token
    // endpoint is not news about the request that 401'd — so a transport
    // failure here falls back to the honest 401, exactly like a non-200
    // refresh response does.
    let res: { status: number; body: Uint8Array };
    try {
      res = await sendRequest(
        "store-owner-fetch: refresh",
        "POST",
        refreshUrl,
        [["content-type", "application/x-www-form-urlencoded"]],
        new TextEncoder().encode(refreshBody),
      );
    } catch {
      return first;
    }
    if (res.status !== 200) return first;
    let fresh = "";
    let rotatedRefresh: string | undefined;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
        access_token?: string;
        refresh_token?: string;
      };
      fresh = parsed.access_token ?? "";
      // REFRESH-TOKEN ROTATION (DRIVE.md §4): Google may return a new
      // refresh_token alongside the access token. When present, it
      // replaces the one this grant holds — the old one may no longer
      // be valid — and is handed to the callback so the caller can
      // re-seal it.
      rotatedRefresh = parsed.refresh_token;
    } catch { /* an unparseable refresh answer is just a failed refresh */ }
    if (fresh === "") return first;
    // Rebind: the grant's CONTENTS change, the wiring does not.
    grant.bearer = fresh;
    if (rotatedRefresh) grant.refresh = rotatedRefresh;
    onBearerRefreshed?.(fresh, rotatedRefresh);
    // Exactly ONE retry: a second 401 is an answer, not a race.
    return await sendRequest("store-owner-fetch", method, url, outbound(fresh), body);
  };
}

/**
 * `store-shared-fetch`: the APP-IDENTITY tier, and the third distinct
 * answer to "who is this request from". Dropbox will not serve a
 * shared-link read to an unauthenticated caller, but the credential it
 * wants identifies the APP — an app key and secret that ship inside every
 * copy of a public client, which is exactly why confidentiality can never
 * rest on them. Injecting them here is CALLER IDENTIFICATION, not
 * secrecy.
 *
 * What makes this worth its own import rather than a flag: the user's
 * bearer is wired to `store-owner-fetch`, so a recipient-path read cannot
 * identify the user BY CONSTRUCTION — there is no code path from this
 * seam to that credential. The memo's live near-miss (owner, link and
 * anonymous calls all going to the same host) is defused by the wiring
 * rather than by remembering to check.
 */
export function makeSharedFetch(grant: EgressGrant): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-shared-fetch: no storage grant configured yet");
    }
    if (grant.provider !== "dropbox") {
      // S3 has no app tier at all, and gdrive mints NOTHING a
      // non-credentialed party could use (DRIVE.md §1: "no shared
      // links, no anonymous reads, no app-auth tier" — structural, not
      // a checked flag). A request here on either provider is a call
      // site asking for an identity this provider cannot mint.
      witErr("store-shared-fetch: no app tier on this provider");
    }
    const target = requestOriginOf(url, "store-shared-fetch");
    if (!grant.sharedOrigins.has(target)) {
      witErr(`store-shared-fetch: origin not granted: ${target}`);
    }
    // Any guest-supplied authorization is dropped first: what goes out is
    // the app identity the visor holds, or nothing at all.
    const outbound = headers.filter(([k]) => k.toLowerCase() !== "authorization");
    const appKey = grant.appKey ?? "";
    const appSecret = grant.appSecret ?? "";
    if (appKey !== "" && appSecret !== "") {
      // Standard HTTP Basic app auth. NOTE the deliberate asymmetry with
      // the refresh path in `makeOwnerFetch`: the PKCE token endpoint
      // takes `client_id` in the form body and no Authorization header,
      // whereas `get_shared_link_file` wants the Basic header. Two
      // endpoints, two shapes — neither is the other's bug.
      outbound.unshift(["authorization", `Basic ${btoa(`${appKey}:${appSecret}`)}`]);
    }
    // With nothing held, the request goes out unauthenticated and the
    // provider's refusal is honest — the same rule the owner shim's
    // missing-token path follows.
    return await sendRequest("store-shared-fetch", method, url, outbound, body);
  };
}

/**
 * `store-public-fetch`: the anonymous tier. It holds no identity, so
 * there is nothing it could attach; what it actively does is STRIP any
 * `authorization` the guest set. Anonymity is then a property of which
 * import the call site went through, not of a runtime check that could
 * be forgotten.
 */
export function makePublicFetch(grant: EgressGrant): StoreFetch {
  return async (method, url, headers, body) => {
    if (grant.provider === null) {
      witErr("store-public-fetch: no storage grant configured yet");
    }
    const target = requestOriginOf(url, "store-public-fetch");
    if (!grant.publicOrigins.has(target)) {
      witErr(`store-public-fetch: origin not granted: ${target}`);
    }
    // Note the honest limit: `fetch` follows redirects itself, so the
    // allowlist governs the FIRST hop only. It is not a credential leak
    // (nothing is attached on this tier), which is exactly why the
    // Dropbox link tier's redirect chain is tolerable here and would not
    // be on the owner tier.
    return await sendRequest(
      "store-public-fetch",
      method,
      url,
      headers.filter(([k]) => k.toLowerCase() !== "authorization"),
      body,
    );
  };
}

/** The owner seam for an instance wired NO storage authority. It exists
 * and refuses — bob's read-only confinement is now visible in the
 * WIRING, where an auditor can see it, instead of being inferred from an
 * empty credential field in a config he could have filled in himself. */
export const refusingOwnerFetch: StoreFetch = () =>
  Promise.reject(
    new ComponentException("store-owner-fetch: no storage credential wired for this instance"),
  );

/** Where a Dropbox instance may go, by tier. The owner tier talks to the
 * RPC host and the content host (uploads/downloads); the link tier's
 * pickup read goes to the content host, whose redirect hops land on
 * www.dropbox.com / dl.dropboxusercontent.com (spikes/dropbox/README.md:
 * "Network grant for this provider"). */
export const DROPBOX_OWNER_ORIGINS = [
  "https://api.dropboxapi.com",
  "https://content.dropboxapi.com",
];
export const DROPBOX_PUBLIC_ORIGINS = [
  "https://content.dropboxapi.com",
  "https://www.dropbox.com",
  "https://dl.dropboxusercontent.com",
];
/** The app tier reaches exactly one endpoint: the shared-link read. */
export const DROPBOX_SHARED_ORIGINS = ["https://content.dropboxapi.com"];
