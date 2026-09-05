// A minimal DOM shim over the curated surface — just enough of the DOM
// contract for Preact 10's renderer (undom-inspired, written for this
// surface). Structure (parent/children/siblings) is answered from
// guest-side shadow bookkeeping; every mutation writes through to the
// surface handles. Input value/checked are shadow-mirrored from event
// records BEFORE dispatch, so `e.target.value` works without host reads.

import {
  createElement as surfaceCreateElement,
  createTextNode as surfaceCreateTextNode,
} from "polyvisor:surface/dom@0.1.0";
import { listen } from "polyvisor:surface/events@0.1.0";

const tokens = new Map(); // token -> SNode
let nextToken = 1;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const HTML_NS = "http://www.w3.org/1999/xhtml";

class SNode {
  constructor(handle, nodeType, localName) {
    this.h = handle;
    this.nodeType = nodeType;
    this.localName = localName;
    this.parentNode = null;
    this.childNodes = [];
  }

  // Preact threads the parent's namespace into createElementNS.
  get namespaceURI() {
    return HTML_NS;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return p.childNodes[i + 1] ?? null;
  }

  _unlink(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode._unlink(child);
    child.parentNode = this;
    this.childNodes.push(child);
    this.h.appendChild(child.h);
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode._unlink(child);
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    ref.h.before(child.h);
    return child;
  }

  removeChild(child) {
    this._unlink(child);
    child.h.remove();
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode._unlink(this);
    this.h.remove();
  }

  // --- events -----------------------------------------------------------
  // Preact manages its own `dom._listeners` proxy map, so the shim keeps
  // its handler lists under a separate key. Preact also passes
  // un-lowercased names (`DblClick`) when `on<type>` properties don't
  // exist on the node — normalize here.
  addEventListener(type, fn) {
    type = String(type).toLowerCase();
    (this._shimListeners ??= {})[type] ??= [];
    this._shimListeners[type].push(fn);
    this._listened ??= new Set();
    if (!this._listened.has(type)) {
      this._listened.add(type);
      if (this._token === undefined) {
        this._token = nextToken++;
        tokens.set(this._token, this);
      }
      listen(this.h, type, this._token);
    }
  }

  removeEventListener(type, fn) {
    const arr = this._shimListeners?.[String(type).toLowerCase()];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    // The surface has no unlisten; an empty handler list is equivalent.
  }

  _dispatch(record) {
    // Mirror live input state from the record before handlers read it.
    if (record.value !== undefined) this._value = record.value;
    if (record.checked !== undefined) this._checked = record.checked;
    const event = {
      type: record.kind,
      target: this,
      currentTarget: this,
      key: record.key,
      preventDefault() {},
      stopPropagation() {},
    };
    const handlers = this._shimListeners?.[record.kind];
    if (handlers) for (const fn of [...handlers]) fn.call(this, event);
  }
}

class SElement extends SNode {
  setAttribute(name, value) {
    this.h.setAttribute(name, String(value));
  }

  removeAttribute(name) {
    this.h.removeAttribute(name);
  }

  focus() {
    this.h.focus();
  }

  // IDL attributes Preact assigns as properties (`name in dom`).
  get value() {
    return this._value ?? "";
  }
  set value(v) {
    this._value = String(v ?? "");
    this.h.setValue(this._value);
  }

  get checked() {
    return !!this._checked;
  }
  set checked(v) {
    this._checked = !!v;
    this.h.setChecked(!!v);
  }
}

// Preact lowercases an event prop's name only when `on<lowercase>` exists
// on the node ("name.toLowerCase() in dom"); its internal handler map is
// keyed by whatever survives. Declare the surface's event vocabulary so
// names normalize to lowercase and record dispatch finds the handlers.
for (const k of ["click", "dblclick", "input", "change", "keydown", "blur"]) {
  Object.defineProperty(SElement.prototype, `on${k}`, {
    value: null,
    writable: true,
    configurable: true,
  });
}

class SText extends SNode {
  get data() {
    return this._data ?? "";
  }
  set data(v) {
    this._data = String(v);
    this.h.setTextContent(this._data);
  }
  // Preact also touches nodeValue in places.
  get nodeValue() {
    return this.data;
  }
  set nodeValue(v) {
    this.data = v;
  }
}

export const document = {
  createElement(tag) {
    return new SElement(surfaceCreateElement(tag), ELEMENT_NODE, tag);
  },
  createElementNS(ns, tag) {
    if (ns && ns !== HTML_NS) {
      throw new Error(`shim: namespace '${ns}' unsupported`);
    }
    return this.createElement(tag);
  },
  createTextNode(data) {
    const t = new SText(surfaceCreateTextNode(String(data)), TEXT_NODE, "#text");
    t._data = String(data);
    return t;
  },
};

export function wrapRoot(handle) {
  return new SElement(handle, ELEMENT_NODE, "#root");
}

export function dispatchRecord(record) {
  tokens.get(record.token)?._dispatch(record);
}
