// The probe PAGE: an RPC client and nothing else.
//
// Every capability under test is exercised in the worker (worker.ts);
// this file only opens the port, exposes a promise-returning `probe(op)`
// on `window` for the Playwright driver, and adds the one observation
// that must be made from OUTSIDE the worker — `navigator.locks.query()`
// seeing the worker's lock (question 5).

const params = new URLSearchParams(location.search);

function log(line: string) {
  const el = document.getElementById("log");
  if (el) el.textContent += `${line}\n`;
  console.log(`[page] ${line}`);
}

/** Question 5, page half: can a PAGE see a lock held inside the worker?
 * Also the ONLY observer available in `?noworker=1` mode. */
async function locksQuery(): Promise<unknown> {
  const q = await navigator.locks.query();
  return {
    held: (q.held ?? []).map((l) => ({
      name: l.name,
      mode: l.mode,
      clientId: l.clientId,
    })),
    pending: (q.pending ?? []).map((l) => ({ name: l.name })),
  };
}

// MODULE SharedWorker. If Chromium refused module shared workers this
// construction (or the first message) is where it would show.
//
// `?extended=1` adds `extendedLifetime: true` (Chrome 148 desktop/android/
// webview — chromestatus 5138641357373440): "keep this worker alive after
// all clients have unloaded". Question 4's respawn is exactly a
// zero-client window, so the option is tested as its candidate fix — under
// a DIFFERENT worker name, since a worker is keyed by (origin, url, name)
// and reusing the name would just re-attach to the plain one.
// `?noworker=1`: load the page WITHOUT constructing the SharedWorker, so
// `navigator.locks.query()` can be asked whether the lock is held at a
// moment when no worker exists. Without this the release claim is only
// inferred — any page that could ask the question would itself have
// spawned a worker that immediately re-acquires the lock.
if (params.get("noworker") === "1") {
  Object.assign(globalThis, { locksQuery });
  document.body.dataset.ready = "noworker";
  log("no-worker mode: locks observer only");
} else {
  boot();
}

function boot() {
  const extended = params.get("extended") === "1";

  // FEATURE DETECTION BY OBSERVATION, because a SharedWorker option that the
  // engine does not know is silently ignored — an unsupported option and a
  // supported-but-ineffective one look identical from the outside. A getter
  // on the dictionary fires exactly when the implementation READS the member,
  // which is the only signal available.
  let extendedLifetimeRead = false;
  const options = {
    type: "module",
    name: extended ? "spike-worker-host-extended" : "spike-worker-host",
    get extendedLifetime() {
      extendedLifetimeRead = true;
      return extended;
    },
  };
  const worker = new SharedWorker(
    "./worker.js",
    options as unknown as WorkerOptions,
  );
  (globalThis as unknown as { extendedLifetimeRead: boolean })
    .extendedLifetimeRead = extendedLifetimeRead;

  interface Reply {
    id: number;
    ok: boolean;
    value?: unknown;
    error?: string;
    stack?: string;
  }

  let nextId = 1;
  const pending = new Map<
    number,
    { res: (v: unknown) => void; rej: (e: unknown) => void }
  >();

  worker.port.onmessage = (ev: MessageEvent<Reply>) => {
    const { id, ok, value, error, stack } = ev.data;
    if (id === 0) {
      log(`worker connected: ${JSON.stringify(value)}`);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.res(value) : p.rej(new Error(`${error}\n${stack ?? ""}`));
  };
  worker.port.onmessageerror = (ev) => log(`messageerror: ${String(ev)}`);
  worker.port.start();

  function probe(
    op: string,
    arg?: unknown,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      worker.port.postMessage({ id, op, arg });
      setTimeout(() => {
        if (pending.delete(id)) {
          rej(new Error(`probe ${op}: timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  // The driver's whole surface.
  Object.assign(globalThis, { probe, locksQuery });

  // A page load always says hello, so the reload experiment (question 4)
  // needs no per-load driving: the counters are on the page by boot.
  probe("hello").then((v) => {
    (globalThis as unknown as { hello: unknown }).hello = v;
    log(`hello ${JSON.stringify(v)}`);
    document.body.dataset.ready = "1";
  }).catch((e) => {
    log(`hello FAILED: ${e}`);
    document.body.dataset.ready = "error";
    (globalThis as unknown as { helloError: string }).helloError = String(e);
  });

  if (params.get("relay")) log(`relay: ${params.get("relay")}`);
}
