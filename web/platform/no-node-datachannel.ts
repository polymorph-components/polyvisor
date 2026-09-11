// Browser-bundle replacement for `node-datachannel`. Deno's bundler otherwise
// pulls Node modules into worker.js; SharedWorkers have neither that fallback
// nor a global RTCPeerConnection.

// No exports: the module body throws, so nothing downstream of the import
// ever runs and a named binding would only be a shape suggesting otherwise.
throw new Error(
  "node-datachannel is not available in a browser build; " +
    "RTCPeerConnection must come from the global",
);
