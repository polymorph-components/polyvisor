// The frame's vocabulary policy. These cases ARE the M1 policy gate: the
// integration path needs a hostile component, which is M2 work, so what an
// app may name is pinned here.

import { assert, assertEquals } from "@std/assert";
import type { PolicyOp } from "@polymorph/stream-dom-receiver/mod.ts";
import { PROTOCOL_VERSION } from "@polymorph/stream-dom-receiver/mod.ts";

import { appPolicy, checkOp } from "./policy.ts";

function allowed(op: PolicyOp) {
  assertEquals(checkOp(op), undefined, `expected allow: ${JSON.stringify(op)}`);
}
function rejected(op: PolicyOp) {
  assert(
    checkOp(op) !== undefined,
    `expected reject: ${JSON.stringify(op)}`,
  );
}

const text = (value: string) => ({ kind: "text" as const, value });
const asset = { kind: "asset" as const, handle: new Uint8Array([1, 2]) };

Deno.test("the policy pins the receiver's protocol version", () => {
  assertEquals(appPolicy.version, PROTOCOL_VERSION);
});

Deno.test("the TodoMVC vocabulary is allowed", () => {
  for (const tag of ["div", "ul", "li", "input", "label", "button", "h1"]) {
    allowed({ op: "createElement", tag, ns: undefined });
  }
  allowed({
    op: "setAttribute",
    tag: "input",
    name: "class",
    ns: undefined,
    value: text("toggle"),
  });
  allowed({
    op: "setAttribute",
    tag: "input",
    name: "data-id",
    ns: undefined,
    value: text("7"),
  });
  allowed({
    op: "setAttribute",
    tag: "li",
    name: "aria-label",
    ns: undefined,
    value: text("todo"),
  });
  allowed({ op: "setProperty", tag: "input", name: "value", value: text("x") });
  allowed({
    op: "addListener",
    target: "node",
    name: "click",
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  });
});

Deno.test("Markdown editor vocabulary is allowed without navigation", () => {
  allowed({ op: "createElement", tag: "textarea", ns: undefined });
  allowed({
    op: "setAttribute",
    tag: "textarea",
    name: "readonly",
    ns: undefined,
    value: text("true"),
  });
  // Dioxus removes boolean attributes when their props become false.
  allowed({
    op: "setAttribute",
    tag: "textarea",
    name: "readonly",
    ns: undefined,
    value: undefined,
  });
  allowed({
    op: "setProperty",
    tag: "textarea",
    name: "value",
    value: text("remote"),
  });
  allowed({
    op: "setTextControlState",
    tag: "textarea",
    state: {
      value: "A💡B",
      selectionStart: 1,
      selectionEnd: 3,
      direction: "backward",
    },
  });
  rejected({
    op: "setTextControlState",
    tag: "input",
    state: {
      value: "nope",
      selectionStart: 0,
      selectionEnd: 0,
      direction: "none",
    },
  });
  for (const name of [
    "select",
    "selectionchange",
    "compositionstart",
    "compositionend",
  ]) {
    allowed({
      op: "addListener",
      target: "node",
      name,
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    });
  }
  rejected({
    op: "setAttribute",
    tag: "textarea",
    name: "formaction",
    ns: undefined,
    value: text("https://example.invalid"),
  });
});

Deno.test("tags outside the table are rejected", () => {
  for (const tag of ["script", "iframe", "object", "embed", "style", "base"]) {
    rejected({ op: "createElement", tag, ns: undefined });
  }
});

Deno.test("a namespaced element is rejected (no SVG/MathML vocabulary)", () => {
  rejected({
    op: "createElement",
    tag: "svg",
    ns: "http://www.w3.org/2000/svg",
  });
});

Deno.test("a javascript: href is rejected; an asset or fragment is not", () => {
  rejected({
    op: "setAttribute",
    tag: "a",
    name: "href",
    ns: undefined,
    value: text("javascript:alert(1)"),
  });
  rejected({
    op: "setAttribute",
    tag: "a",
    name: "href",
    ns: undefined,
    value: text("https://example.invalid/"),
  });
  allowed({
    op: "setAttribute",
    tag: "a",
    name: "href",
    ns: undefined,
    value: text("#/active"),
  });
  allowed({
    op: "setAttribute",
    tag: "img",
    name: "src",
    ns: undefined,
    value: asset,
  });
  rejected({
    op: "setAttribute",
    tag: "img",
    name: "src",
    ns: undefined,
    value: text("data:image/svg+xml,<svg/>"),
  });
});

Deno.test("an asset href is a <link> thing only", () => {
  // `<a href>` naming an asset would navigate the frame to a blob the
  // parent minted. The only fetch an app may name is its own stylesheet.
  rejected({
    op: "setAttribute",
    tag: "a",
    name: "href",
    ns: undefined,
    value: asset,
  });
  allowed({
    op: "setAttribute",
    tag: "link",
    name: "href",
    ns: undefined,
    value: asset,
  });
});

Deno.test("'type' is restricted to the controls M1 renders", () => {
  for (const value of ["checkbox", "text", "submit", "button"]) {
    allowed({
      op: "setAttribute",
      tag: "input",
      name: "type",
      ns: undefined,
      value: text(value),
    });
  }
  for (const value of ["file", "password", "image", "hidden"]) {
    rejected({
      op: "setAttribute",
      tag: "input",
      name: "type",
      ns: undefined,
      value: text(value),
    });
  }
  rejected({
    op: "setAttribute",
    tag: "input",
    name: "type",
    ns: undefined,
    value: asset,
  });
});

Deno.test("an onclick ATTRIBUTE is rejected", () => {
  rejected({
    op: "setAttribute",
    tag: "button",
    name: "onclick",
    ns: undefined,
    value: text("alert(1)"),
  });
});

Deno.test("markup-injecting properties are rejected", () => {
  for (const name of ["innerHTML", "outerHTML", "textContent", "onclick"]) {
    rejected({ op: "setProperty", tag: "div", name, value: text("<b>") });
  }
});

Deno.test("<link> may only be a stylesheet from the bundle's assets", () => {
  allowed({
    op: "setAttribute",
    tag: "link",
    name: "rel",
    ns: undefined,
    value: text("stylesheet"),
  });
  rejected({
    op: "setAttribute",
    tag: "link",
    name: "rel",
    ns: undefined,
    value: text("preload"),
  });
  allowed({
    op: "setAttribute",
    tag: "link",
    name: "href",
    ns: undefined,
    value: asset,
  });
  rejected({
    op: "setAttribute",
    tag: "link",
    name: "href",
    ns: undefined,
    value: text("#nope"),
  });
});

Deno.test("listeners outside the table are rejected", () => {
  for (const name of ["load", "message", "beforeunload", "wheel"]) {
    rejected({
      op: "addListener",
      target: "node",
      name,
      capture: false,
      passive: false,
      preventDefault: false,
      stopPropagation: false,
    });
  }
});

Deno.test("window and document listeners are allowed only for the table", () => {
  allowed({
    op: "addListener",
    target: "window",
    name: "keydown",
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  });
  rejected({
    op: "addListener",
    target: "document",
    name: "message",
    capture: false,
    passive: false,
    preventDefault: false,
    stopPropagation: false,
  });
});

Deno.test("bindMarker is rejected: the frame's document is not the app's", () => {
  rejected({ op: "bindMarker" });
});

Deno.test("queries are answerable inside the frame", () => {
  assertEquals(appPolicy.query?.("get-client-rect"), true);
});
