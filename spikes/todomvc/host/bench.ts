// The churn benchmark: measures the per-backend cost of the same guest
// workload (row create / sparse update / clear), one flush batch per
// invocation. ?n= sets the row count (default 1000).

import type { BackendKind } from "../../../visor/surface/backend.ts";
import { startLab } from "./app.ts";

// "frame" is excluded from the bench sweep for the same reason it is
// excluded from the harness (host/harness.ts): a sandboxed frame's
// document is opaque-origin and this file measures via same-realm
// `startLab`/DOM timing, not a channel this bench cares to add.
const BACKENDS: BackendKind[] = ["queued", "direct", "channel"];

interface Sample {
  kind: BackendKind;
  n: number;
  createMs: number;
  updateMs: number; // median of iterations
  clearMs: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function benchBackend(kind: BackendKind, n: number): Promise<Sample> {
  const container = document.createElement("div");
  container.style.display = "none"; // isolate boundary cost from layout
  document.body.appendChild(container);
  const { runner, exports } = await startLab(kind, container);

  const timed = async (f: () => Promise<void>): Promise<number> => {
    const t0 = performance.now();
    // `runner!`: BACKENDS above is same-realm only; see app.ts's LabApp.
    await runner!.call(f);
    await runner!.settle();
    return performance.now() - t0;
  };

  // Warmup.
  await timed(() => exports.bench(1, 50));
  await timed(() => exports.bench(3, 0));

  const createMs = await timed(() => exports.bench(1, n));
  const updates: number[] = [];
  for (let i = 0; i < 10; i++) {
    updates.push(await timed(() => exports.bench(2, 0)));
  }
  const clearMs = await timed(() => exports.bench(3, 0));

  container.remove();
  return { kind, n, createMs, updateMs: median(updates), clearMs };
}

export async function runBench(): Promise<void> {
  const out = document.getElementById("out") as HTMLElement;
  const n = Number(new URLSearchParams(location.search).get("n") ?? "1000");

  try {
    const samples: Sample[] = [];
    for (const kind of BACKENDS) {
      out.textContent = `running ${kind}…`;
      samples.push(await benchBackend(kind, n));
    }

    // ~5 surface calls per created row (li, class, span, text, 2 appends → 6
    // actually; keep the constant honest):
    const CALLS_PER_ROW = 6;
    const lines = [
      `rows: ${n}   (create ≈ ${CALLS_PER_ROW} surface calls/row, one invocation per phase)`,
      "",
      "backend  create(ms)  µs/call  update-med(ms)  clear(ms)",
      ...samples.map((s) =>
        [
          s.kind.padEnd(8),
          s.createMs.toFixed(1).padStart(10),
          ((s.createMs * 1000) / (n * CALLS_PER_ROW)).toFixed(2).padStart(8),
          s.updateMs.toFixed(1).padStart(14),
          s.clearMs.toFixed(1).padStart(9),
        ].join("  ")
      ),
    ];
    out.textContent = lines.join("\n");
    (globalThis as Record<string, unknown>).__benchResult = { n, samples };
  } catch (e) {
    out.textContent = `bench failed: ${e}`;
    (globalThis as Record<string, unknown>).__benchResult = {
      error: String(e),
    };
  }
}
