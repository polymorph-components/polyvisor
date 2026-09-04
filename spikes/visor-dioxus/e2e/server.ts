// Static file server for the spike's E2E lane. Serves web/ at "/" and maps
// /visor-spike.component.wasm and /visor-spike.plan.json to build/.
//
// MANDATORY: bind port 0 and print the real port. A hand-picked port
// collides silently with a sibling worktree's server and the test then
// probes someone else's build.
//
// Prints exactly one line: `LISTENING <port>`

import { dirname, extname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const root = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const webDir = join(root, "web");
const buildDir = join(root, "build");
// visor/ui/visor.css is READ-ONLY and lives outside this spike's tree
// entirely (governing doc 2): the harness serves it at a fixed path
// rather than copying it in, so there is exactly one file the component
// is measured against.
const visorCssPath = join(root, "..", "..", "visor", "ui", "visor.css");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  // KNOWN BROKEN, FIXED: without this, Chromium fetches visor.css as
  // application/octet-stream and parses ZERO rules, SILENTLY — the
  // drawer's timing-dependent behaviour (the height transition, the arm
  // delay's CSS-independent enforcement) then cannot be observed at all.
  ".css": "text/css; charset=utf-8",
};

async function serveFile(path: string): Promise<Response> {
  try {
    const data = await Deno.readFile(path);
    return new Response(data, {
      headers: {
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Response(`not found: ${path}`, { status: 404 });
    throw e;
  }
}

function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/visor-spike.component.wasm" || pathname === "/visor-spike.plan.json") {
    return serveFile(join(buildDir, pathname.slice(1)));
  }
  if (pathname === "/visor.css") {
    return serveFile(visorCssPath);
  }

  // Path-traversal guard.
  const target = normalize(join(webDir, pathname));
  if (!target.startsWith(webDir)) {
    return Promise.resolve(new Response("forbidden", { status: 403 }));
  }
  return serveFile(target);
}

const server = Deno.serve({
  port: 0,
  onListen: ({ port }) => console.log(`LISTENING ${port}`),
}, handler);

await server.finished;
