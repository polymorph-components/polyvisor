// `web/rpc.ts` against a real MessageChannel — the same transport the
// control and session ports are.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ComponentException } from "@polyengine/protocol";

import { proxyInterfaces, serveInterfaces } from "./rpc.ts";

const IFACE = "polyvisor:app/tasks@0.1.0";

function pair(
  impls: Parameters<typeof serveInterfaces>[1],
  ifaces: string[] = [IFACE],
) {
  const { port1, port2 } = new MessageChannel();
  serveInterfaces(port1, impls);
  const client = proxyInterfaces(port2, ifaces);
  return {
    client,
    close() {
      port1.close();
      port2.close();
    },
  };
}

Deno.test("a call round-trips arguments and the return value", async () => {
  const { client, close } = pair({
    [IFACE]: { add: (title: string) => `id:${title}` },
  });
  const tasks = client[IFACE] as { add(t: string): Promise<string> };
  assertEquals(await tasks.add("milk"), "id:milk");
  close();
});

Deno.test("list<u8> crosses as a Uint8Array", async () => {
  const { client, close } = pair({
    [IFACE]: { echo: (b: Uint8Array) => b },
  });
  const tasks = client[IFACE] as { echo(b: Uint8Array): Promise<Uint8Array> };
  const out = await tasks.echo(new Uint8Array([0, 1, 2]));
  assert(out instanceof Uint8Array);
  assertEquals([...out], [0, 1, 2]);
  close();
});

Deno.test("calls are matched by id, not by order", async () => {
  const gates = new Map<string, () => void>();
  const { client, close } = pair({
    [IFACE]: {
      slow: (key: string) =>
        new Promise<string>((resolve) => gates.set(key, () => resolve(key))),
    },
  });
  const tasks = client[IFACE] as { slow(k: string): Promise<string> };
  const a = tasks.slow("a");
  const b = tasks.slow("b");
  // Wait until both have arrived, then answer in reverse.
  while (gates.size < 2) await new Promise((r) => setTimeout(r, 0));
  gates.get("b")!();
  gates.get("a")!();
  assertEquals(await Promise.all([a, b]), ["a", "b"]);
  close();
});

Deno.test("a ComponentException crosses with its payload", async () => {
  const { client, close } = pair({
    [IFACE]: {
      add: () => {
        // The WIT error arm of `result<string, string>`.
        throw new ComponentException("refused");
      },
    },
  });
  const tasks = client[IFACE] as { add(): Promise<string> };
  const err = await assertRejects(() => tasks.add());
  assert(err instanceof ComponentException);
  assertEquals(err.payload, "refused");
  close();
});

Deno.test("a record payload survives the crossing", async () => {
  const { client, close } = pair({
    [IFACE]: {
      add: () => {
        throw new ComponentException({
          code: "unknown-session",
          message: "no",
        });
      },
    },
  });
  const tasks = client[IFACE] as { add(): Promise<string> };
  const err = await assertRejects(() => tasks.add()) as ComponentException;
  assertEquals(err.payload, { code: "unknown-session", message: "no" });
  close();
});

Deno.test("any other throw crosses as a plain error", async () => {
  const { client, close } = pair({
    [IFACE]: {
      add: () => {
        throw new TypeError("glue is broken");
      },
    },
  });
  const tasks = client[IFACE] as { add(): Promise<string> };
  const err = await assertRejects(() => tasks.add());
  assert(!(err instanceof ComponentException));
  assertEquals((err as Error).message, "glue is broken");
  close();
});

Deno.test("an interface the port does not serve is refused", async () => {
  const { client, close } = pair({ [IFACE]: { add: () => "x" } }, [
    IFACE,
    "polyvisor:internal/device@0.1.0",
  ]);
  const device = client["polyvisor:internal/device@0.1.0"] as {
    status(): Promise<unknown>;
  };
  const err = await assertRejects(() => device.status());
  assert((err as Error).message.includes("not served here"));
  close();
});

Deno.test("an unknown member of a served interface is refused", async () => {
  const { client, close } = pair({ [IFACE]: { add: () => "x" } });
  const tasks = client[IFACE] as Record<string, () => Promise<unknown>>;
  const err = await assertRejects(() => tasks.nope());
  assert((err as Error).message.includes("has no 'nope'"));
  close();
});

Deno.test("non-RPC traffic on the port is left to other listeners", async () => {
  const { port1, port2 } = new MessageChannel();
  serveInterfaces(port1, { [IFACE]: { add: () => "x" } });
  const seen: unknown[] = [];
  port1.addEventListener("message", (ev: MessageEvent) => {
    if ((ev.data as { t?: string })?.t === "frame-port") seen.push(ev.data);
  });
  const client = proxyInterfaces(port2, [IFACE]);
  port2.postMessage({ t: "frame-port", session: 7 });
  assertEquals(await (client[IFACE] as { add(): Promise<string> }).add(), "x");
  assertEquals(seen, [{ t: "frame-port", session: 7 }]);
  port1.close();
  port2.close();
});

Deno.test("symbol keys are not manufactured (brand probes stay unmarked)", () => {
  const { port1, port2 } = new MessageChannel();
  const client = proxyInterfaces(port2, [IFACE]);
  const iface = client[IFACE] as Record<symbol, unknown>;
  assertEquals(iface[Symbol.for("polyengine.suspending/1")], undefined);
  port1.close();
  port2.close();
});

Deno.test("Object.prototype members are not reachable as functions", async () => {
  // `constructor`, `toString` and `__proto__` are on every object literal's
  // prototype chain: a plain index lookup would find them and the server
  // would happily invoke one. Every name must be refused as unknown, and
  // nothing may run.
  let invoked = false;
  const { client, close } = pair({
    [IFACE]: {
      add: () => {
        invoked = true;
        return "x";
      },
    },
  });
  const tasks = client[IFACE] as Record<string, () => Promise<unknown>>;
  for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
    const err = await assertRejects(() => tasks[name]());
    assert(
      (err as Error).message.includes(`has no '${name}'`),
      `${name}: ${(err as Error).message}`,
    );
  }
  assert(!invoked, "nothing on the served interface ran");
  close();
});

Deno.test("a session port does not serve apps.abort", async () => {
  // internal.wit `apps.abort` is control-port only: the reason it carries is
  // framework voice composed by the glue, so a session must not be able to
  // end itself with words of its own. `web/worker.ts`'s `mintSessionPort`
  // serves three `apps` members; this is that set, standing in for it.
  const APPS = "polyvisor:internal/apps@0.1.0";
  const { client, close } = pair({
    [APPS]: {
      component: () => ({ wasm: new Uint8Array(), plan: "{}" }),
      assets: () => [],
      asset: () => new Uint8Array(),
    },
  }, [APPS]);
  const apps = client[APPS] as Record<string, (...a: unknown[]) => Promise<
    unknown
  >>;
  const err = await assertRejects(() => apps.abort(1, "mine"));
  assert((err as Error).message.includes("has no 'abort'"));
  // ...while what the frame IS allowed to ask for still works.
  assertEquals(await apps.assets(), []);
  close();
});
