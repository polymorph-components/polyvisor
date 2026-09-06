// The vocabulary an app frame may name.
//
// docs/design.md "M1": "frame loader under policy" — the frame is an opaque
// origin with a hash-pinned CSP, and this is the second wall: even a
// producer that has taken over its own guest cannot name a DOM construct
// outside this table. Confinement (node ids, template arena validity) is the
// receiver's own protocol business; this seam is only about WHAT vocabulary
// a producer may use (receiver/src/policy.ts's header).
//
// A rejection closes the mutation stream and reports a `PolicyError` through
// `onError`, which web/frame.ts turns into a teardown — so every reason
// string here is user-invisible and exists to be read in a report.
//
// `version` pins `PROTOCOL_VERSION`: `createDriver` throws synchronously
// unless it matches, so upgrading the receiver library cannot silently widen
// what this table never reviewed.

import { PROTOCOL_VERSION } from "@polymorph/stream-dom-receiver/mod.ts";
import type { Policy, PolicyOp } from "@polymorph/stream-dom-receiver/mod.ts";

const TAGS = new Set([
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "button",
  "input",
  "label",
  "form",
  "section",
  "header",
  "footer",
  "main",
  "nav",
  "strong",
  "em",
  "small",
  "q",
  "code",
  "pre",
  "br",
  "hr",
  "img",
  "link",
]);

const ATTRS = new Set([
  "class",
  "id",
  "type",
  "value",
  "placeholder",
  "checked",
  "disabled",
  "autofocus",
  "for",
  "name",
  "href",
  "src",
  "rel",
  "role",
]);

const ATTR_PREFIXES = ["aria-", "data-"];

/** The only `type` values M1's vocabulary needs: TodoMVC's checkbox and
 * text inputs, plus the two button kinds. Anything else (`file`,
 * `password`, `image`, ...) is a control this table has never reviewed. */
const INPUT_TYPES = new Set(["checkbox", "text", "submit", "button"]);

/** Attributes whose value is a URL: only the receiver's own asset handles
 * (the producer never names a URL — web/frame.ts mints the blob) and
 * same-document fragments. */
const URL_ATTRS = new Set(["href", "src"]);

const PROPERTIES = new Set(["value", "checked", "disabled", "className"]);

const LISTENERS = new Set([
  "click",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "blur",
  "focus",
  "dblclick",
]);

function attrAllowed(name: string): boolean {
  return ATTRS.has(name) || ATTR_PREFIXES.some((p) => name.startsWith(p));
}

export function checkOp(op: PolicyOp): string | undefined {
  switch (op.op) {
    case "createElement": {
      if (op.ns !== undefined) return `namespaced element <${op.tag}>`;
      if (!TAGS.has(op.tag)) return `tag <${op.tag}>`;
      return undefined;
    }
    case "setAttribute": {
      if (op.ns !== undefined) return `namespaced attribute '${op.name}'`;
      if (!attrAllowed(op.name)) return `attribute '${op.name}'`;
      if (op.name === "type" && op.value !== undefined) {
        if (op.value.kind !== "text" || !INPUT_TYPES.has(op.value.value)) {
          return "'type' must be checkbox, text, submit or button";
        }
      }
      if (URL_ATTRS.has(op.name)) {
        const v = op.value;
        if (v === undefined) return undefined; // removal
        if (v.kind === "asset") {
          // A <link> is a fetch the frame would otherwise have no way to
          // make; only a stylesheet, and only from the bundle's own assets.
          // An `<a href>` naming an asset would be a navigation to a blob
          // the parent minted, which is not what an asset handle is for.
          if (op.name === "href" && op.tag !== "link") {
            return `'href' may only name an asset on <link>, not <${op.tag}>`;
          }
          return undefined;
        }
        if (!v.value.startsWith("#")) {
          return `'${op.name}' must be an asset or a '#' fragment`;
        }
      }
      if (op.tag === "link") {
        if (
          op.name === "rel" && !(op.value?.kind === "text" &&
            op.value.value === "stylesheet")
        ) {
          return "<link> may only be rel=stylesheet";
        }
        if (op.name === "href" && op.value?.kind !== "asset") {
          return "<link href> must be an asset";
        }
      }
      return undefined;
    }
    case "setProperty": {
      if (!PROPERTIES.has(op.name)) return `property '${op.name}'`;
      return undefined;
    }
    case "addListener": {
      if (!LISTENERS.has(op.name)) return `listener '${op.name}'`;
      return undefined;
    }
    case "bindMarker":
      // Hydration binding to pre-existing host nodes: the frame's document
      // is the loader's, and an app has no business naming any of it.
      return "bind-marker";
  }
}

/** The policy every app frame mounts under (web/frame.ts). */
export const appPolicy: Policy = {
  version: PROTOCOL_VERSION,
  check: checkOp,
  // `queries` is geometry of the producer's own tree inside its own frame:
  // nothing crosses the sandbox, so all four are answerable.
  query: () => true,
};
