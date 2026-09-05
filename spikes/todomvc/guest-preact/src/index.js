// World exports: wire Preact + the DOM shim to the todomvc world.

import { h, render } from "preact";
import { createElement } from "polyvisor:surface/dom@0.1.0";
import { root } from "polyvisor:surface/shell@0.1.0";
import { dispatchRecord, document, wrapRoot } from "./shim.js";
import { App, setRoute } from "./app.js";

// Preact's renderer reaches for the global document.
globalThis.document = document;

// Guest-side error reporting: with WASI stdio disabled there is no stderr,
// so before letting an uncaught exception become an opaque trap, smuggle
// the message out through the surface (class values are free-form).
function reporting(f) {
  return (...args) => {
    try {
      return f(...args);
    } catch (e) {
      try {
        const beacon = createElement("div");
        beacon.setAttribute("class", `guest-error: ${e && (e.stack || e.message || e)}`);
      } catch (_) {
        // surface unavailable; the trap alone will have to do
      }
      throw e;
    }
  };
}

export const run = reporting(() => {
  render(h(App, {}), wrapRoot(root()));
});

export const onEvent = reporting((record) => {
  dispatchRecord(record);
});

export const onRoute = reporting((route) => {
  setRoute(route);
});

