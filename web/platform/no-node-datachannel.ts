// `node-datachannel`'s W3C polyfill, as it exists in a browser: it does not.
//
// `@polymorph/webrtc-datachannels` resolves `RTCPeerConnection` from the
// global and falls back to this npm polyfill under Deno/Node, reaching it
// through a DYNAMIC import so the bare specifier "never has to resolve in
// the browser". That is true of the fallback *branch*, but not of the
// bundle: `deno bundle` inlines dynamic imports, so shipping the real module
// drags `node:url`/`node:path`/`node:module`/`node:stream`/`node:events`
// into `worker.js` and leaves a module no browser can load at all.
//
// `--external` avoided that but left the bare `npm:` specifier in the
// bundle, and a module SharedWorker whose graph names an unresolvable
// specifier intermittently fails to start in headless Chromium — silently:
// no `connect` event, no `error` event, just a worker that never runs
// (measured at 6 stalls in 32 fresh contexts, versus 0 in 32 with the
// specifier gone). deno.json maps the specifier here instead, so the
// bundler inlines this file: no `node:*`, no unresolved specifier, and the
// fallback branch keeps the shape it had — a rejected import.
//
// This is not a stub standing in for something a browser could do. WebRTC's
// API is not exposed to workers at all, so a SharedWorker reaching this
// branch has no peer connection available by any route, and saying so
// plainly is the honest answer.

// No exports: the module body throws, so nothing downstream of the import
// ever runs and a named binding would only be a shape suggesting otherwise.
throw new Error(
  "node-datachannel is not available in a browser build; " +
    "RTCPeerConnection must come from the global",
);
