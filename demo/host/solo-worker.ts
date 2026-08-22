// THE SOLO PAGE'S DEVICE HOST — a bundling entry, and nothing else.
//
// `runtime/device-store/worker.ts` is a SharedWorker ENTRY POINT rather
// than a library module: it is its own module graph with its own global
// scope, constructed as `new SharedWorker(url, {type:"module", name:
// "pm-device-<id>"})` by device-store/client.ts. It is deliberately not
// re-exported from the device store's `mod.ts` (that file says why: it
// imports ../engine.ts, whose bare `@polyengine`/`@polymorph` specifiers
// only an embedder can map).
//
// THIS FILE IS THAT EMBEDDER'S MAPPING, and it is one line long on
// purpose. `deno bundle` needs an entry inside the demo's own module
// resolution (demo/deno.json holds the pins) to produce
// `serve/solo-worker.js`; the page then constructs the worker from that
// URL. The same `--external` set as the other bundles applies, for the
// same reason demo/justfile's `site` recipe spells out — the webrtc
// port's node backends must stay bare specifiers or the browser is asked
// to fetch `node:url`.
import "../../runtime/device-store/worker.ts";
