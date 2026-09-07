// A fake Google Drive: exactly the requests the kernel's store makes, and
// nothing else (m4-context.md "Fake Drive").
//
// WHAT THIS IS NOT: a Drive emulator. It implements the OAuth half the
// ceremony needs (`/auth`'s headless consent, `/token`'s two grants) and
// the files-API subset `runtime/crates/kernel/src/drive.rs`'s module doc
// documents and this fake mirrors exactly: `files.list` restricted to the
// `q` clauses the kernel builds, a JSON folder create, a multipart create,
// an `alt=media` read — and answers anything else with a 400 naming the
// shape it was given. A permissive stub would let a store that outgrew
// this fake pass here and fail at Google; a loud 400 is the whole point.
//
// EVERY TOKEN AND CODE HERE IS SYNTHETIC AND LABELLED AS SUCH
// (`synthetic-access-1`, `synthetic-refresh-1`, `synthetic-code-1`).
// Nothing in this file resembles real credential material, and nothing real
// should ever be typed into it.

/** One object in the fake's store. Folders are objects too — that is what
 * `appDataFolder` parentage is modelled with — and carry no bytes. */
export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
}

export interface FakeDrive {
  /** Origin, e.g. `http://127.0.0.1:41234`. The harness publishes it as
   * BOTH `config.json` bases: this one server answers the API paths and
   * the OAuth paths. */
  url: string;
  /** Objects that carry bytes — the sedimentree items, without the folder
   * that holds them. What a scenario counts when it asks whether a push
   * happened. */
  objects(): FakeFile[];
  /** How many objects have been READ back out of the store
   * (`alt=media`). A device that converged through the store had to read
   * what it did not have; a device that converged over the wire read
   * nothing. It is the one number that tells the two apart from outside. */
  mediaReads(): number;
  stop(): Promise<void>;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

// THE REAL ENDPOINTS SEND CORS, SO THE FAKE MUST TOO. The store runs in a
// SharedWorker, which has an origin and full CORS enforcement; Google's
// token endpoint and `www.googleapis.com` both answer browser origins
// permissively, and a fake without these headers is not stricter but wrong
// — the fetch fails with nothing naming CORS as the reason.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "*",
};
const PREFLIGHT: Record<string, string> = {
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

/** Drive's own error envelope, so a store that reads the body reads the
 * shape it would read live. */
function driveError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The `q` subset the kernel builds, and nothing else: a parent clause and
 * a name clause, `and`-joined. `null` means "this fake does not implement
 * that query", which is a 400 rather than a silently empty answer. */
interface ParsedQuery {
  name?: string;
  parent?: string;
}

function parseQuery(q: string): ParsedQuery | null {
  const out: ParsedQuery = {};
  for (const raw of q.split(" and ")) {
    const clause = raw.trim();
    if (clause === "") continue;
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^name\s*=\s*'(.*)'$/))) {
      out.name = unescapeLiteral(m[1]);
    } else if ((m = clause.match(/^'(.*)'\s+in\s+parents$/))) {
      out.parent = unescapeLiteral(m[1]);
    } else if (clause === "trashed = false") {
      // Harmless and common; the fake trashes nothing, so it filters
      // nothing.
    } else {
      return null;
    }
  }
  return out;
}

function unescapeLiteral(s: string): string {
  return s.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

/** One part of a `multipart/related` body: its headers are ignored beyond
 * the blank line that ends them, because the two parts the kernel sends are
 * positional (metadata first, media second) exactly as Drive requires. */
function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const marker = enc.encode(`--${boundary}`);
  const parts: Uint8Array[] = [];
  let i = indexOf(body, marker, 0);
  while (i >= 0) {
    const start = i + marker.length;
    // `--` right after the marker is the closing delimiter.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    const next = indexOf(body, marker, start);
    if (next < 0) break;
    const chunk = body.subarray(start, next);
    // Headers end at the first blank line; everything after it is the
    // part's body, minus the CRLF that belongs to the delimiter.
    const blank = indexOf(chunk, enc.encode("\r\n\r\n"), 0);
    const from = blank >= 0 ? blank + 4 : 0;
    let to = next - start;
    if (chunk[to - 2] === 0x0d && chunk[to - 1] === 0x0a) to -= 2;
    parts.push(chunk.subarray(from, Math.max(from, to)));
    i = next;
  }
  return parts;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function startFakeDrive(): FakeDrive {
  const store = new Map<string, FakeFile>();
  let nextFile = 1;
  let mediaReads = 0;
  let nextToken = 1;
  let nextCode = 1;

  /** code → the PKCE challenge `/auth` recorded, consumed by the
   * exchange. */
  const codes = new Map<string, { challenge: string; method: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  function issueTokens(withRefresh: boolean): Response {
    const n = nextToken++;
    const access = `synthetic-access-${n}`;
    accessTokens.add(access);
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/drive.appdata",
    };
    if (withRefresh) {
      const refresh = `synthetic-refresh-${n}`;
      refreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return json(body);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Matched by SUFFIX, not by whole path: the kernel composes its URLs
    // from the two bases `config.json` supplies, and how much path a base
    // carries is the kernel's business. The set of shapes recognised is
    // still closed — anything not matched below is a 400.
    const path = url.pathname;
    const auth = req.headers.get("authorization") ?? "";

    // Answered before the bearer gate, and it must be: a preflight never
    // carries the header it is asking permission to send.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: PREFLIGHT });
    }

    // --- the fake's own control surface ---------------------------------
    //
    // Invalidates the access tokens and keeps the refresh tokens, which is
    // an access token that expired — the one refusal the store has a
    // recovery for.
    if (path.endsWith("/_fake/revoke-access")) {
      if (req.method !== "POST") {
        return driveError(400, "fake-drive: _fake/revoke-access is POST only");
      }
      accessTokens.clear();
      return json({ revoked: true });
    }

    // --- the OAuth half -------------------------------------------------
    //
    // Headless consent: no page, no button. `/auth` records the challenge
    // and 302s straight back to the redirect with a synthetic code, so what
    // this fake actually verifies is OUR PKCE — the only part of the
    // ceremony a fake can meaningfully check.
    if (path.endsWith("/auth")) {
      const redirect = url.searchParams.get("redirect_uri");
      if (!redirect) return driveError(400, "fake-drive: /auth has no redirect_uri");
      const code = `synthetic-code-${nextCode++}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        method: url.searchParams.get("code_challenge_method") ?? "plain",
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) back.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: { location: back.toString() },
      });
    }

    if (path.endsWith("/token")) {
      if (req.method !== "POST") {
        return driveError(400, "fake-drive: /token is POST only");
      }
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const recorded = codes.get(form.get("code") ?? "");
        if (!recorded) return json({ error: "invalid_grant" }, 400);
        // S256 only. A `plain` challenge is refused rather than waved
        // through: accepting it would make this gate unable to fail.
        if (recorded.method !== "S256") {
          return json(
            { error: "invalid_request", detail: "S256 required" },
            400,
          );
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            enc.encode(form.get("code_verifier") ?? "") as BufferSource,
          ),
        );
        if (base64url(digest) !== recorded.challenge) {
          return json(
            { error: "invalid_grant", detail: "pkce verifier mismatch" },
            400,
          );
        }
        codes.delete(form.get("code") ?? ""); // one-shot, as a real code is
        return issueTokens(true);
      }
      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        if (!refreshTokens.has(rt)) return json({ error: "invalid_grant" }, 400);
        // NO ROTATION: the refresh token survives the exchange, so a
        // scenario that revokes access twice refreshes twice with the
        // token it already sealed.
        return issueTokens(false);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    // --- the files API --------------------------------------------------
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token || !accessTokens.has(token)) {
      return driveError(401, "Invalid Credentials");
    }

    // files.list
    if (path.endsWith("/drive/v3/files") && req.method === "GET") {
      // The kernel always asks for the hidden space (`drive.rs`'s module
      // doc: "Every list is `spaces=appDataFolder`") — this fake has no
      // ordinary My Drive space to be isolated from, but a request that
      // forgot the parameter is still a request this fake does not
      // implement, and a silent pass here would hide the same drift the
      // rest of this file exists to catch.
      if (url.searchParams.get("spaces") !== "appDataFolder") {
        return driveError(
          400,
          `fake-drive: files.list wants spaces=appDataFolder, got ` +
            `${url.searchParams.get("spaces")}`,
        );
      }
      const q = url.searchParams.get("q") ?? "";
      const parsed = parseQuery(q);
      if (!parsed) return driveError(400, `fake-drive: unsupported q: ${q}`);
      const files = [...store.values()].filter((f) =>
        (parsed.name === undefined || f.name === parsed.name) &&
        (parsed.parent === undefined || f.parents.includes(parsed.parent))
      );
      // One page, no `nextPageToken`: the fake's folders are small, and
      // omitting the token is the honest "that was all of it".
      return json({ files: files.map((f) => ({ id: f.id, name: f.name })) });
    }

    // The multipart create: metadata part, then media part. Checked BEFORE
    // the JSON create below, because the upload path ends in the same
    // `/drive/v3/files`.
    if (path.endsWith("/upload/drive/v3/files") && req.method === "POST") {
      if (url.searchParams.get("uploadType") !== "multipart") {
        return driveError(
          400,
          "fake-drive: upload implements uploadType=multipart only",
        );
      }
      const boundary = (req.headers.get("content-type") ?? "").match(
        /boundary=([^;]+)/,
      );
      if (!boundary) return driveError(400, "fake-drive: no multipart boundary");
      const body = new Uint8Array(await req.arrayBuffer());
      const parts = splitMultipart(body, boundary[1].trim().replace(/^"|"$/g, ""));
      if (parts.length !== 2) {
        return driveError(
          400,
          `fake-drive: multipart create wants 2 parts, got ${parts.length}`,
        );
      }
      let meta: { name?: string; parents?: string[]; mimeType?: string };
      try {
        meta = JSON.parse(dec.decode(parts[0]));
      } catch (e) {
        return driveError(400, `fake-drive: metadata part is not JSON: ${e}`);
      }
      if (!meta.name) return driveError(400, "fake-drive: create has no name");
      const f: FakeFile = {
        id: `file-${nextFile++}`,
        name: meta.name,
        parents: meta.parents ?? ["appDataFolder"],
        mimeType: meta.mimeType ?? "application/octet-stream",
        bytes: parts[1],
      };
      store.set(f.id, f);
      return json({ id: f.id, name: f.name });
    }

    // files.create, JSON metadata only — the folder path.
    if (path.endsWith("/drive/v3/files") && req.method === "POST") {
      const meta = await req.json().catch(() => null) as
        | { name?: string; mimeType?: string; parents?: string[] }
        | null;
      if (!meta?.name) return driveError(400, "fake-drive: create has no name");
      const f: FakeFile = {
        id: `file-${nextFile++}`,
        name: meta.name,
        parents: meta.parents ?? ["appDataFolder"],
        mimeType: meta.mimeType ?? FOLDER_MIME,
        bytes: new Uint8Array(),
      };
      store.set(f.id, f);
      return json({ id: f.id, name: f.name, mimeType: f.mimeType });
    }

    const one = path.match(/\/drive\/v3\/files\/([^/]+)$/);
    if (one && req.method === "GET") {
      const f = store.get(decodeURIComponent(one[1]));
      if (!f) return driveError(404, "File not found");
      if (url.searchParams.get("alt") !== "media") {
        return driveError(
          400,
          "fake-drive: reading a file implements alt=media only",
        );
      }
      mediaReads++;
      return new Response(f.bytes.slice() as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    // Everything else, named: a store that grew a request this fake does
    // not implement fails here rather than passing against a stub that
    // shrugged.
    return driveError(
      400,
      `fake-drive: unimplemented ${req.method} ${path}${url.search}`,
    );
  }

  /** Every answer leaves with CORS attached — done once here rather than at
   * a dozen construction sites, so a new endpoint cannot forget. */
  async function withCors(req: Request): Promise<Response> {
    const res = await handle(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    withCors,
  );
  const port = (server.addr as Deno.NetAddr).port;

  const copy = (f: FakeFile): FakeFile => ({ ...f, bytes: f.bytes.slice() });
  return {
    url: `http://127.0.0.1:${port}`,
    objects: () =>
      [...store.values()].filter((f) => f.mimeType !== FOLDER_MIME).map(copy),
    mediaReads: () => mediaReads,
    stop: () => server.shutdown(),
  };
}
