// WIT async imports over a MessagePort.
//
// Every seam in this repository that crosses a realm (runtime/wit
// internal.wit "Realms") is a set of `async func`s on plain data: rule 2 of
// that header says no resources cross, so every argument and every result is
// structured-clone-safe by construction and a MessagePort is a sufficient
// transport.
//
// Server side: `serveInterfaces(port, { [interfaceId]: impl })` answers calls
// against `impl`'s camelCase methods. Client side: `proxyInterfaces(port,
// [interfaceId...])` returns a polyengine imports record — see the M1 context
// "polyengine facts": the embedder reads a member off the interface record by
// `camelCase(name)` first (embedder/instantiate.ts `#dispatcher` -> `pick`),
// so a Proxy that manufactures a function for any string key is exactly what
// the embedder wants, and returns `undefined` for symbol keys so the brand
// checks (`suspending`/`deferCancel`) see an unmarked import.
//
// Errors: a WIT `result<_, E>` surfaces as a thrown `ComponentException`
// whose `.payload` is E (M1 context "Value mapping"). That is the only error
// shape with meaning on the far side, so it crosses structurally and is
// re-thrown as a `ComponentException`; anything else is a glue fault and
// crosses as its message.

import { ComponentException, isComponentException } from "@polyengine/protocol";

interface Request {
  rpc: 1;
  id: number;
  iface: string;
  fn: string;
  args: unknown[];
}

type Failure =
  | { kind: "component-exception"; payload: unknown }
  | { kind: "error"; message: string };

interface Response {
  rpc: 1;
  id: number;
  ok: boolean;
  value?: unknown;
  error?: Failure;
}

function isRequest(d: unknown): d is Request {
  return typeof d === "object" && d !== null &&
    (d as Request).rpc === 1 && typeof (d as Request).iface === "string" &&
    typeof (d as Request).fn === "string";
}

function isResponse(d: unknown): d is Response {
  return typeof d === "object" && d !== null &&
    (d as Response).rpc === 1 && typeof (d as Response).id === "number" &&
    typeof (d as Response).ok === "boolean" &&
    (d as Request).iface === undefined;
}

function toFailure(err: unknown): Failure {
  if (isComponentException(err)) {
    return {
      kind: "component-exception",
      payload: (err as ComponentException).payload,
    };
  }
  return { kind: "error", message: String((err as Error)?.message ?? err) };
}

function fromFailure(f: Failure): unknown {
  return f.kind === "component-exception"
    ? new ComponentException(f.payload)
    : new Error(f.message);
}

/** Interface implementations, keyed by verbatim WIT interface id. */
export type Interfaces = Record<
  string,
  Record<string, (...args: never[]) => unknown>
>;

/**
 * Answer RPC requests arriving on `port` from `impls`.
 *
 * Messages that are not RPC requests are ignored, so a port may carry other
 * traffic beside this (the control port's `{t:"frame-port"}`). Requests for
 * an interface not in `impls` fail — the frame's session port serves exactly
 * two interfaces and nothing else is reachable from it (internal.wit
 * "Realms").
 */
export function serveInterfaces(port: MessagePort, impls: Interfaces): void {
  port.addEventListener("message", (ev: MessageEvent) => {
    const req = ev.data;
    if (!isRequest(req)) return;
    void (async () => {
      let res: Response;
      try {
        // `Object.hasOwn` on both lookups: a plain index would find
        // `constructor`, `toString` and the rest of Object.prototype, so an
        // interface id or member name from the far side could reach a
        // function nobody served here.
        if (!Object.hasOwn(impls, req.iface)) {
          throw new Error(`rpc: interface '${req.iface}' is not served here`);
        }
        const iface = impls[req.iface];
        if (!Object.hasOwn(iface, req.fn)) {
          throw new Error(`rpc: '${req.iface}' has no '${req.fn}'`);
        }
        const fn = iface[req.fn];
        if (typeof fn !== "function") {
          throw new Error(`rpc: '${req.iface}' has no '${req.fn}'`);
        }
        const value = await (fn as (...a: unknown[]) => unknown).apply(
          iface,
          req.args,
        );
        res = { rpc: 1, id: req.id, ok: true, value };
      } catch (err) {
        res = { rpc: 1, id: req.id, ok: false, error: toFailure(err) };
      }
      port.postMessage(res);
    })();
  });
  port.start();
}

/**
 * A polyengine imports record proxying `ifaceIds` over `port`.
 *
 * Every call is async; a `result`'s error arm arrives as a thrown
 * `ComponentException`, matching what a directly-linked import would do.
 */
export function proxyInterfaces(
  port: MessagePort,
  ifaceIds: readonly string[],
): Record<string, unknown> {
  const pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: unknown): void }
  >();
  let nextId = 1;

  port.addEventListener("message", (ev: MessageEvent) => {
    const res = ev.data;
    if (!isResponse(res)) return;
    const waiter = pending.get(res.id);
    if (waiter === undefined) return;
    pending.delete(res.id);
    if (res.ok) waiter.resolve(res.value);
    else waiter.reject(fromFailure(res.error!));
  });
  port.start();

  const record: Record<string, unknown> = {};
  for (const iface of ifaceIds) {
    record[iface] = new Proxy({}, {
      get(_t, key) {
        // Symbol keys are brand probes; an unmarked import answers undefined.
        if (typeof key !== "string") return undefined;
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const req: Request = { rpc: 1, id, iface, fn: key, args };
            try {
              port.postMessage(req);
            } catch (err) {
              pending.delete(id);
              reject(err);
            }
          });
      },
    });
  }
  return record;
}
