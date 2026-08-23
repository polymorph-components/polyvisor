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

export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
}

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
  /** Every file currently in the store (folders included). */
  files(): FakeFile[];
  /** Resolve a `/`-separated path from My Drive's root, or undefined. */
  byPath(path: string): FakeFile | undefined;
  /** Child names of a `/`-separated folder path (empty if absent). */
  childNames(path: string): string[];
  /** Recorded request log, oldest first. */
  requests(): FakeRequest[];
  /** Invalidate every access token issued so far: the next files-API
   * call with one gets a 401, which is what drives the seam's
   * refresh-and-retry (DRIVE.md §4). Refresh tokens survive. */
  expireNow(): void;
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

function driveError(status: number, message: string): Response {
  return json({ error: { code: status, message } }, status);
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
  if (opts.seedAccessToken) accessTokens.add(opts.seedAccessToken);

  function create(name: string, parents: string[], mimeType: string, bytes: Uint8Array): FakeFile {
    const f: FakeFile = { id: `file-${nextFile++}`, name, parents, mimeType, bytes };
    store.set(f.id, f);
    return f;
  }

  function resolvePath(path: string): FakeFile | undefined {
    let parent = "root";
    let found: FakeFile | undefined;
    for (const seg of path.split("/").filter((s) => s.length)) {
      found = [...store.values()].find((f) => f.name === seg && f.parents.includes(parent));
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
      const files = [...store.values()].filter((f) =>
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
    if (one && req.method === "GET") {
      const f = store.get(decodeURIComponent(one[1]));
      if (!f) return driveError(404, "File not found");
      if (url.searchParams.get("alt") !== "media") {
        return json({ id: f.id, name: f.name, mimeType: f.mimeType });
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
    files: () => [...store.values()].map((f) => ({ ...f, bytes: f.bytes.slice() })),
    byPath: (p: string) => {
      const f = resolvePath(p);
      return f ? { ...f, bytes: f.bytes.slice() } : undefined;
    },
    childNames: (p: string) => {
      const parent = p.split("/").filter((s) => s.length).length === 0
        ? { id: "root" }
        : resolvePath(p);
      if (!parent) return [];
      return [...store.values()].filter((f) => f.parents.includes(parent.id)).map((f) => f.name);
    },
    requests: () => log.map((r) => ({ ...r })),
    expireNow: () => accessTokens.clear(),
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
