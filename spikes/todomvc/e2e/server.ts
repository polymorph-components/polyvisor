// Static file server for the TodoMVC spike's E2E lane.
//
// Serves the BUILT demo directory (`just build`'s output, ../../../docs/
// spike-todomvc) rather than web/: the pages under test load `app.js`,
// `frame.js`, `frame-dioxus.js` and the four component/envelope pairs, and
// only the built directory has all of them side by side — which is also
// exactly the layout GitHub Pages serves.
//
// MANDATORY: bind port 0 and print the real port. A hand-picked port collides
// silently with a sibling worktree's server and the test then probes someone
// else's build.
//
// CORS IS NOT OPTIONAL HERE. Both frame documents are loaded into iframes
// sandboxed WITHOUT `allow-same-origin`, so they run on an opaque origin and
// their `<script type="module">` fetch of frame.js / frame-dioxus.js is a
// cross-origin request. Without `access-control-allow-origin` the module never
// loads, the frame never posts `frame-ready`, and the mount hangs — with no
// error in the shell, because the shell cannot see into the frame. The
// justfile's `serve` recipe uses `jsr:@std/http/file-server` precisely because
// it sends these by default (GitHub Pages does too; python's http.server does
// not).
//
// Prints exactly one line: `LISTENING <port>`

import { dirname, extname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const spikeRoot = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const siteDir = normalize(join(spikeRoot, "..", "..", "docs", "spike-todomvc"));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  // Without this Chromium fetches the stylesheets as
  // application/octet-stream and parses ZERO rules, silently.
  ".css": "text/css; charset=utf-8",
};

async function serveFile(path: string): Promise<Response> {
  try {
    const data = await Deno.readFile(path);
    return new Response(data, {
      headers: {
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        // See the header: the sandboxed frames are on an opaque origin.
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response(`not found: ${path}`, { status: 404 });
    }
    throw e;
  }
}

function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  // Path-traversal guard.
  const target = normalize(join(siteDir, pathname));
  if (!target.startsWith(siteDir)) {
    return Promise.resolve(new Response("forbidden", { status: 403 }));
  }
  return serveFile(target);
}

const server = Deno.serve({
  port: 0,
  onListen: ({ port }) => console.log(`LISTENING ${port}`),
}, handler);

await server.finished;
