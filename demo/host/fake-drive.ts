// A fake Google Drive: the files-API subset the gdrive strategy emits,
// plus the OAuth half the ceremony needs (runtime/DRIVE.md "Gates").
//
// ONE module, deliberately: the bringup phase, the devstore harness and
// the e2e suite all drive the same fake, and three near-copies of a
// server that must agree with one Rust strategy is how they drift.
//
// WHAT THIS IS NOT: a Drive emulator. It implements exactly the requests
// providers/gdrive/store makes — `files.list` restricted to the `q`
// subset that crate builds, multipart create, media update, `alt=media`
// read, folder metadata create, delete — and answers anything else with
// a 400 naming the unsupported shape, so a strategy change that outgrows
// the fake fails loudly instead of passing against a permissive stub.
//
// EVERY TOKEN AND CODE HERE IS SYNTHETIC AND LABELLED AS SUCH
// (`synthetic-access-1`, `synthetic-code-1`). Nothing in this file
// resembles real credential material, and nothing real should ever be
// typed into it.

/** Drive's storage SPACES, as the two values this store can use.
 *
 * `drive` is the ordinary visible My Drive; `appDataFolder` is the
 * hidden per-app space. THE FAKE ENFORCES ISOLATION between them
 * because that is the only thing that makes a space test non-vacuous:
 * a `files.list` defaults to `spaces=drive` and CANNOT see appdata
 * files, and a list carrying `spaces=appDataFolder` cannot see
 * ordinary ones. Real Drive answers a cross-space query with an empty
 * file list rather than an error, so the fake does too — a strategy
 * that forgot the `spaces` parameter must fail by finding nothing,
 * exactly as it would live. */
export type FakeSpace = "drive" | "appDataFolder";

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
  /** Which space this file landed in — INHERITED FROM ITS PARENT at
   * create time, as it is in Drive: parentage is what places a file in
   * a space, which is why a create in the hidden space needs no
   * parameter beyond the `appDataFolder` alias in `parents`. */
  space: FakeSpace;
  /** The file's `appProperties` — the private-to-this-client-id string
   * map that runtime/SYNC.md §2 makes the CHANGE BOARD on a doc folder.
   *
   * Modelled with the two behaviours the design leans on and one it must
   * not be allowed to outgrow: PER-KEY MERGE on `files.update` (each
   * device owns its key, so disjoint patches do not clobber), null-value
   * DELETE, and Drive's documented caps enforced as a 400. */
  appProperties: Record<string, string>;
}

/** Drive's documented `appProperties` limits, enforced by this fake so
 * that a regression which bloats the change board fails in a test rather
 * than against the real API. Mirrors
 * `provider_gdrive::APP_PROPERTY_PAIR_BYTES` / `APP_PROPERTIES_MAX`. */
export const APP_PROPERTY_PAIR_BYTES = 124;
export const APP_PROPERTIES_MAX = 30;

export interface FakeRequest {
  method: string;
  /** Path only — query strings are dropped, as they are in the
   * provider's own error labels. */
  path: string;
  /** Whether an `authorization` header was present at all. The VALUE is
   * never recorded: a test rig that writes bearers down is a test rig
   * that leaks them. */
  hasAuth: boolean;
  /** Whether the request was answered 401 for a bad/expired bearer. */
  refused: boolean;
  /** A CORS preflight rather than a request for anything. Preflights are
   * logged (dropping them would make the log lie about what the browser
   * did) but carry no authorization by definition, so a row counting
   * "Bearer-authorized files-API calls" filters them out already. */
  preflight: boolean;
}

export interface FakeDrive {
  /** Origin, e.g. `http://127.0.0.1:41234` — pass as `apiBase`. */
  url: string;
  port: number;
  /** Every file currently in the store (folders included), each
   * carrying the `space` it landed in. */
  files(): FakeFile[];
  /** Resolve a `/`-separated path from the given space's root
   * (default `drive`, i.e. My Drive's root), or undefined. The walk
   * stays inside that space throughout, so the same path can name two
   * different files in the two spaces — which is the case the
   * isolation assertions turn on. */
  byPath(path: string, space?: FakeSpace): FakeFile | undefined;
  /** The change board on a `/`-separated folder path — a convenience
   * over `byPath(...).appProperties` for the assertions that only care
   * about the board (SYNC.md §2). Empty for an absent path. */
  appProperties(path: string, space?: FakeSpace): Record<string, string>;
  /** Child names of a `/`-separated folder path within one space
   * (default `drive`); empty if the path is absent in that space. An
   * empty path means the space's own root. */
  childNames(path: string, space?: FakeSpace): string[];
  /** Recorded request log, oldest first. */
  requests(): FakeRequest[];
  /** Invalidate every access token issued so far: the next files-API
   * call with one gets a 401, which is what drives the seam's
   * refresh-and-retry (DRIVE.md §4). Refresh tokens survive. */
  expireNow(): void;
  /**
   * REFUSE THE NEXT `n` FILES-API REQUESTS WITH A 503 — an injected
   * provider outage, for the rows that are about what the worker's sync
   * scheduler does when a flush FAILS (runtime/SYNC.md §3's backoff and
   * its announcement threshold).
   *
   * WHY 503 AND NOT 401: a 401 is the one refusal the seam has a
   * recovery for (DRIVE.md §4's refresh-and-retry), so it would test the
   * token dance instead of the backoff. A 5xx is the untriaged
   * background failure the design deliberately does not string-match.
   *
   * SCOPE IS THE FILES API ONLY. `/auth`, `/token` and `/revoke` keep
   * answering, so an outage cannot be mistaken for a consent that fell
   * over — and a row can heal the store without re-running a ceremony.
   *
   * `n` is a COUNT rather than a boolean because "fail the next request"
   * and "fail until I say stop" are different experiments; pass
   * `Infinity` for the second and `refuseNextFiles(0)` to heal. Requests
   * refused this way are still LOGGED (a fake that hid them would make
   * the request log lie about what the worker attempted).
   *
   * A thin alias for `failFiles({ n, status: 503 })` — kept as its own
   * name because it is the common case and every existing caller
   * (runtime/tests/devstore/run.ts) already spells it this way.
   */
  refuseNextFiles(n: number): void;
  /**
   * FAIL THE NEXT MATCHING FILES-API REQUESTS with a targeted rule,
   * for partial-failure and crash-consistency experiments that
   * `refuseNextFiles`'s blanket 503 can't express (e.g. "only the
   * upload PATCH fails, everything else keeps working" — a device
   * dying mid-write, not a wholesale outage).
   *
   * `n` (default `Infinity`) counts down only on requests that MATCH
   * `method` (exact) and `path` (tested against the same path the
   * request log records); non-matching requests pass through untouched
   * and do not spend the budget — otherwise "fail just the uploads"
   * would be impossible to express without racing unrelated list calls.
   *
   * `status` defaults to 503, same as `refuseNextFiles`, for the same
   * reason (see its doc comment): the untriaged background failure the
   * design does not string-match. `retryAfterS`, when given, is sent
   * as a `Retry-After` header — for 429 experiments, where the worker's
   * backoff is deliberately untriaged today; the header is here so a
   * future triage has something honest to read rather than nothing.
   *
   * ONE RULE SLOT. Calling `failFiles` or `refuseNextFiles` REPLACES
   * whatever rule was standing — two overlapping fault rules is an
   * experiment nobody has asked for, and "which one wins" is exactly
   * the kind of ambiguity a fake should refuse to have an opinion on.
   * `failFiles({ n: 0 })` heals, exactly as `refuseNextFiles(0)` does.
   */
  failFiles(rule: { n?: number; status?: number; method?: string; path?: RegExp; retryAfterS?: number }): void;
  /** How many of the injected refusals are still owed — 0 once the
   * store has healed, `Infinity` if the standing rule is unbounded, so
   * a row can assert its outage was actually consumed rather than
   * slept through. */
  refusalsPending(): number;
  /** Access tokens currently accepted (labels only, for assertions like
   * "the engine is on the SECOND token now"). */
  liveAccessTokens(): string[];
  /** The PKCE challenges the `/auth` endpoint has recorded. */
  pendingCodes(): string[];
  close(): Promise<void>;
}

export interface FakeDriveOptions {
  /** Require a currently-valid Bearer on the files API (default true).
   * Turning it off is for probes that are testing addressing, not auth. */
  requireAuth?: boolean;
  /** Pre-seed one accepted access token, so a rig that injects a fixed
   * synthetic Bearer need not run the ceremony first. */
  seedAccessToken?: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** THE REAL ENDPOINTS SEND CORS, SO THE FAKE MUST TOO.
 *
 * `www.googleapis.com` and Google's token endpoint answer browser
 * origins with permissive CORS — that is what lets a page (or a
 * SharedWorker, which has its own origin and full CORS enforcement) run
 * the token exchange and the files API directly. A fake without these
 * headers is not "stricter", it is WRONG in a way that only shows up in
 * a real browser: the fetch rejects with a bare `TypeError: Failed to
 * fetch` and nothing names CORS. It cost the devstore track a
 * CORS-adding reverse proxy in front of this module before this was
 * fixed at the source.
 *
 * Spelling matches the house pattern in runtime/tests/devstore/run.ts's
 * `serveRecorder`/`serveCorsProxy`, widened to the methods and headers
 * this API actually uses. `expose-headers: *` is here because a browser
 * caller otherwise sees none of the response headers at all. */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
};

const PREFLIGHT_CORS: Record<string, string> = {
  ...CORS,
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const enc = new TextEncoder();
const dec = new TextDecoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function driveError(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function indexOfSub(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** The `q` subset providers/gdrive/store builds, and nothing else. */
interface ParsedQuery {
  name?: string;
  parent?: string;
  mimeType?: string;
  trashedFalse: boolean;
}

function parseQuery(q: string): ParsedQuery | null {
  const out: ParsedQuery = { trashedFalse: false };
  // Split on ` and ` at top level; every clause this strategy emits is a
  // simple binary term, so no parser is needed (and a general one would
  // be pretending to be Drive).
  for (const raw of q.split(" and ")) {
    const clause = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^name\s*=\s*'(.*)'$/))) {
      out.name = unescapeLiteral(m[1]);
    } else if ((m = clause.match(/^mimeType\s*=\s*'(.*)'$/))) {
      out.mimeType = unescapeLiteral(m[1]);
    } else if ((m = clause.match(/^'(.*)'\s+in\s+parents$/))) {
      out.parent = unescapeLiteral(m[1]);
    } else if (clause === "trashed = false") {
      out.trashedFalse = true;
    } else {
      return null;
    }
  }
  return out;
}

function unescapeLiteral(s: string): string {
  return s.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

export async function startFakeDrive(opts: FakeDriveOptions = {}): Promise<FakeDrive> {
  const requireAuth = opts.requireAuth !== false;

  const store = new Map<string, FakeFile>();
  const log: FakeRequest[] = [];
  let nextFile = 1;
  let nextToken = 1;
  let nextCode = 1;

  // code -> the PKCE challenge recorded at /auth. One entry per
  // ceremony; consumed by the token exchange.
  const codes = new Map<string, { challenge: string; method: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  /** The one standing fault rule — see `failFiles`. `undefined` means
   * healed. Exactly one slot: a new rule (from either `failFiles` or
   * `refuseNextFiles`) REPLACES it rather than stacking. */
  let faultRule: { n: number; status: number; method?: string; path?: RegExp; retryAfterS?: number } | undefined;
  if (opts.seedAccessToken) accessTokens.add(opts.seedAccessToken);

  /** A file's space is its PARENT's space, and the two root aliases are
   * the base cases. An unknown parent id is treated as `drive`: it can
   * only be a parent the fake never minted, and inventing a third
   * answer for it would hide the bug. */
  function spaceOfParent(parent: string): FakeSpace {
    if (parent === "appDataFolder") return "appDataFolder";
    if (parent === "root") return "drive";
    return store.get(parent)?.space ?? "drive";
  }

  function create(name: string, parents: string[], mimeType: string, bytes: Uint8Array): FakeFile {
    const f: FakeFile = {
      id: `file-${nextFile++}`,
      name,
      parents,
      mimeType,
      bytes,
      space: spaceOfParent(parents[0] ?? "root"),
      appProperties: {},
    };
    store.set(f.id, f);
    return f;
  }

  function rootId(space: FakeSpace): string {
    return space === "appDataFolder" ? "appDataFolder" : "root";
  }

  function resolvePath(path: string, space: FakeSpace): FakeFile | undefined {
    let parent = rootId(space);
    let found: FakeFile | undefined;
    for (const seg of path.split("/").filter((s) => s.length)) {
      found = [...store.values()].find((f) =>
        f.name === seg && f.space === space && f.parents.includes(parent)
      );
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  }

  function issueTokens(): Response {
    const n = nextToken++;
    const access = `synthetic-access-${n}`;
    const refresh = `synthetic-refresh-${n}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/drive.file",
    });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const auth = req.headers.get("authorization") ?? "";
    const entry: FakeRequest = {
      method: req.method,
      path,
      hasAuth: auth.length > 0,
      refused: false,
      preflight: req.method === "OPTIONS",
    };
    log.push(entry);

    // The preflight is answered BEFORE the bearer gate below, and must
    // be: a preflight never carries the authorization header it is
    // asking permission to send.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: PREFLIGHT_CORS });
    }

    // --- the OAuth half -------------------------------------------------
    //
    // Headless consent: /auth 302s straight back to the redirect with a
    // synthetic code. The CHALLENGE is recorded here, and /token gates on
    // it — so what this fake verifies is OUR PKCE, which is the only part
    // of the ceremony a fake can meaningfully check.
    if (path === "/auth") {
      const redirect = url.searchParams.get("redirect_uri");
      if (!redirect) return driveError(400, "auth: no redirect_uri");
      const code = `synthetic-code-${nextCode++}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        method: url.searchParams.get("code_challenge_method") ?? "plain",
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }

    if (path === "/token") {
      if (req.method !== "POST") return driveError(405, "token: POST only");
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = form.get("code") ?? "";
        const recorded = codes.get(code);
        if (!recorded) return json({ error: "invalid_grant" }, 400);
        const verifier = form.get("code_verifier") ?? "";
        // S256 is the only method worth gating; a `plain` challenge is
        // refused rather than waved through, because accepting it would
        // make the gate unable to fail.
        if (recorded.method !== "S256") {
          return json({ error: "invalid_request", detail: "S256 required" }, 400);
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", enc.encode(verifier) as BufferSource),
        );
        if (base64url(digest) !== recorded.challenge) {
          return json({ error: "invalid_grant", detail: "pkce verifier mismatch" }, 400);
        }
        codes.delete(code); // one-shot, as a real code is
        return issueTokens();
      }
      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        if (!refreshTokens.has(rt)) return json({ error: "invalid_grant" }, 400);
        // ROTATION: the old refresh token dies with the exchange, which
        // is what makes "the re-sealed token survives a kill" a real
        // assertion rather than a no-op.
        refreshTokens.delete(rt);
        return issueTokens();
      }
      // Revocation is NOT a `/token` grant: it has its own endpoint
      // below, which is where the forget ceremony posts.
      return json({ error: "unsupported_grant_type" }, 400);
    }

    if (path === "/revoke") {
      const form = new URLSearchParams(await req.text());
      const t = form.get("token") ?? "";
      accessTokens.delete(t);
      refreshTokens.delete(t);
      return new Response(null, { status: 200 });
    }

    // --- the files API --------------------------------------------------
    //
    // THE INJECTED OUTAGE COMES FIRST, before the bearer gate: a provider
    // that is down is down for a valid credential too, and a refusal
    // that depended on the token would be testing the wrong thing (see
    // `refuseNextFiles`/`failFiles`). Everything above this line — the
    // OAuth endpoints — keeps working throughout.
    //
    // MATCH BEFORE SPEND: `method`/`path` are checked before the budget
    // is decremented, so a rule scoped to (say) only PATCH requests does
    // not get eaten by unrelated GETs racing past it — "fail just the
    // uploads" has to mean that literally.
    if (
      faultRule &&
      (faultRule.method === undefined || faultRule.method === req.method) &&
      (faultRule.path === undefined || faultRule.path.test(path))
    ) {
      const { status, retryAfterS } = faultRule;
      if (faultRule.n > 0) {
        faultRule.n--;
        if (faultRule.n === 0) faultRule = undefined;
      }
      entry.refused = true;
      const headers: Record<string, string> = {};
      if (retryAfterS !== undefined) headers["retry-after"] = String(retryAfterS);
      return driveError(status, "The service is currently unavailable.", headers);
    }
    if (requireAuth) {
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token || !accessTokens.has(token)) {
        entry.refused = true;
        return driveError(401, "Invalid Credentials");
      }
    }

    // files.list
    if (path === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const parsed = parseQuery(q);
      if (!parsed) return driveError(400, `unsupported q expression: ${q}`);
      // THE SPACE GATE. `spaces` defaults to `drive`, exactly as the
      // real API does, and a file outside the requested space is
      // invisible here — no error, just absent. That is what lets a
      // test tell the two stores apart, and what makes a strategy that
      // omits the parameter fail the same way it would against Google
      // (every resolve misses, every upload re-creates).
      const spacesParam = url.searchParams.get("spaces") ?? "drive";
      if (spacesParam !== "drive" && spacesParam !== "appDataFolder") {
        return driveError(400, `fake-drive: unsupported spaces=${spacesParam}`);
      }
      const space: FakeSpace = spacesParam;
      const files = [...store.values()].filter((f) =>
        f.space === space &&
        (parsed.name === undefined || f.name === parsed.name) &&
        (parsed.parent === undefined || f.parents.includes(parsed.parent)) &&
        (parsed.mimeType === undefined || f.mimeType === parsed.mimeType)
      );
      // No pagination: the fake's folders are small, and the strategy
      // follows `nextPageToken` when it is there. Omitting the token is
      // the honest "one page" answer.
      return json({ files: files.map((f) => ({ id: f.id, name: f.name })) });
    }

    // files.create — JSON metadata only (this is the folder path).
    if (path === "/drive/v3/files" && req.method === "POST") {
      const meta = await req.json().catch(() => null) as
        | { name?: string; mimeType?: string; parents?: string[] }
        | null;
      if (!meta?.name) return driveError(400, "create: no name");
      const f = create(
        meta.name,
        meta.parents ?? ["root"],
        meta.mimeType ?? "application/octet-stream",
        new Uint8Array(),
      );
      return json({ id: f.id, name: f.name, mimeType: f.mimeType });
    }

    // multipart create (metadata + media in one request)
    if (path === "/upload/drive/v3/files" && req.method === "POST") {
      if (url.searchParams.get("uploadType") !== "multipart") {
        return driveError(400, "upload: only uploadType=multipart is implemented");
      }
      const ct = req.headers.get("content-type") ?? "";
      const bm = ct.match(/boundary=([^;]+)/);
      if (!bm) return driveError(400, "upload: no multipart boundary");
      const body = new Uint8Array(await req.arrayBuffer());
      const parts = splitMultipart(body, bm[1].trim());
      if (parts.length !== 2) {
        return driveError(400, `upload: expected 2 parts, got ${parts.length}`);
      }
      let meta: { name?: string; parents?: string[]; mimeType?: string };
      try {
        meta = JSON.parse(dec.decode(parts[0].body));
      } catch (e) {
        return driveError(400, `upload: metadata part is not JSON: ${e}`);
      }
      if (!meta.name) return driveError(400, "upload: metadata has no name");
      const f = create(
        meta.name,
        meta.parents ?? ["root"],
        meta.mimeType ?? "application/octet-stream",
        parts[1].body,
      );
      return json({ id: f.id, name: f.name });
    }

    // media update (PATCH the bytes of an existing id)
    const upd = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (upd && req.method === "PATCH") {
      if (url.searchParams.get("uploadType") !== "media") {
        return driveError(400, "update: only uploadType=media is implemented");
      }
      const f = store.get(decodeURIComponent(upd[1]));
      if (!f) return driveError(404, "File not found");
      f.bytes = new Uint8Array(await req.arrayBuffer());
      return json({ id: f.id, name: f.name });
    }

    const one = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    // files.update, METADATA-ONLY (no `/upload` prefix, no media part):
    // the change-board patch (SYNC.md §2). PER-KEY MERGE is the whole
    // semantic — the body's `appProperties` are folded INTO the existing
    // map, key by key, so two devices patching their own keys both
    // survive; a null value deletes the key, which is Drive's own
    // convention and the only way off the board.
    //
    // THE CAPS ARE ENFORCED WITH A 400, deliberately. A board that quietly
    // grew past 124 bytes a pair or 30 properties would work here and fail
    // at Google, which is the exact class of drift this fake exists to
    // catch — SYNC.md parks ">30 devices per board" as a known edge, and
    // parked is only honest if crossing it is loud.
    if (one && req.method === "PATCH") {
      const f = store.get(decodeURIComponent(one[1]));
      if (!f) return driveError(404, "File not found");
      const meta = await req.json().catch(() => null) as
        | { appProperties?: Record<string, string | null>; name?: string }
        | null;
      if (!meta) return driveError(400, "update: metadata body is not JSON");
      const keys = Object.keys(meta);
      const unsupported = keys.filter((k) => k !== "appProperties");
      if (unsupported.length > 0) {
        return driveError(
          400,
          `fake-drive: metadata update supports appProperties only, got ${unsupported.join(",")}`,
        );
      }
      const merged = { ...f.appProperties };
      for (const [k, v] of Object.entries(meta.appProperties ?? {})) {
        if (v === null) {
          delete merged[k];
          continue;
        }
        const pair = new TextEncoder().encode(k + v).length;
        if (pair > APP_PROPERTY_PAIR_BYTES) {
          return driveError(
            400,
            `Invalid value for appProperties: key+value is ${pair} bytes, the maximum is ` +
              `${APP_PROPERTY_PAIR_BYTES}`,
          );
        }
        merged[k] = v;
      }
      if (Object.keys(merged).length > APP_PROPERTIES_MAX) {
        return driveError(
          400,
          `The limit of ${APP_PROPERTIES_MAX} properties per file has been reached`,
        );
      }
      f.appProperties = merged;
      return json({ id: f.id, appProperties: { ...f.appProperties } });
    }
    if (one && req.method === "GET") {
      const f = store.get(decodeURIComponent(one[1]));
      if (!f) return driveError(404, "File not found");
      if (url.searchParams.get("alt") !== "media") {
        // The metadata read. `appProperties` is OMITTED when empty, as
        // the real API omits an empty map — which is why the provider
        // treats its absence as "no board" rather than as an error.
        const meta: Record<string, unknown> = {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
        };
        if (Object.keys(f.appProperties).length > 0) {
          meta.appProperties = { ...f.appProperties };
        }
        return json(meta);
      }
      return new Response(f.bytes.slice() as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (one && req.method === "DELETE") {
      const id = decodeURIComponent(one[1]);
      if (!store.has(id)) return driveError(404, "File not found");
      store.delete(id);
      return new Response(null, { status: 204 });
    }

    return driveError(404, `fake-drive: unimplemented ${req.method} ${path}`);
  }

  /** Every answer this fake gives — successes, Drive-shaped errors, the
   * 401s, `/token`, `/revoke`, and the `/auth` 302 (a navigation, where
   * the headers are harmless) — leaves with CORS attached. Done once
   * here rather than at ~15 construction sites, so a new endpoint cannot
   * forget. */
  async function withCors(req: Request): Promise<Response> {
    const res = await handle(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => withCors(req),
  );
  const port = (server.addr as Deno.NetAddr).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    files: () =>
      [...store.values()].map((f) => ({
        ...f,
        bytes: f.bytes.slice(),
        appProperties: { ...f.appProperties },
      })),
    byPath: (p: string, space: FakeSpace = "drive") => {
      const f = resolvePath(p, space);
      return f
        ? { ...f, bytes: f.bytes.slice(), appProperties: { ...f.appProperties } }
        : undefined;
    },
    appProperties: (p: string, space: FakeSpace = "drive") => ({
      ...(resolvePath(p, space)?.appProperties ?? {}),
    }),
    childNames: (p: string, space: FakeSpace = "drive") => {
      const parent = p.split("/").filter((s) => s.length).length === 0
        ? { id: rootId(space) }
        : resolvePath(p, space);
      if (!parent) return [];
      return [...store.values()]
        .filter((f) => f.space === space && f.parents.includes(parent.id))
        .map((f) => f.name);
    },
    requests: () => log.map((r) => ({ ...r })),
    expireNow: () => accessTokens.clear(),
    refuseNextFiles: (n: number) => {
      // A thin alias — see the doc comment on `failFiles`/`refuseNextFiles`
      // in the FakeDrive interface for why they share one slot.
      if (n <= 0) {
        faultRule = undefined;
        return;
      }
      faultRule = { n, status: 503 };
    },
    failFiles: (rule) => {
      const n = rule.n ?? Infinity;
      if (n <= 0) {
        faultRule = undefined;
        return;
      }
      faultRule = {
        n,
        status: rule.status ?? 503,
        method: rule.method,
        path: rule.path,
        retryAfterS: rule.retryAfterS,
      };
    },
    refusalsPending: () => faultRule?.n ?? 0,
    liveAccessTokens: () => [...accessTokens],
    pendingCodes: () => [...codes.keys()],
    close: () => server.shutdown(),
  };
}

interface MultipartPart {
  headers: string;
  body: Uint8Array;
}

/** Split a multipart/related body. Byte-level on purpose: the media part
 * is ciphertext and must survive verbatim, which a text round-trip would
 * not guarantee. */
function splitMultipart(body: Uint8Array, boundary: string): MultipartPart[] {
  const delim = enc.encode(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let i = indexOfSub(body, delim, 0);
  while (i >= 0) {
    let start = i + delim.length;
    // Terminal delimiter `--boundary--`.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d) start += 1;
    if (body[start] === 0x0a) start += 1;
    const next = indexOfSub(body, delim, start);
    let end = next < 0 ? body.length : next;
    // Trim the CRLF that belongs to the delimiter, not the payload.
    if (end >= 1 && body[end - 1] === 0x0a) end -= 1;
    if (end >= 1 && body[end - 1] === 0x0d) end -= 1;
    const chunk = body.subarray(start, end);
    const sep = indexOfSub(chunk, enc.encode("\r\n\r\n"), 0);
    if (sep < 0) {
      parts.push({ headers: "", body: chunk.slice() });
    } else {
      parts.push({
        headers: dec.decode(chunk.subarray(0, sep)),
        body: chunk.subarray(sep + 4).slice(),
      });
    }
    i = next;
  }
  return parts;
}
