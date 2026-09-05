// The differential harness: drives the SAME guests with the SAME scripts
// over every backend and asserts identical DOM serializations per step,
// identical trap vectors, and the flush-on-trap rule. This is what makes
// "semantically equivalent fast path" a checked property instead of a
// slogan (#15 fast-path plan).

import type { BackendKind } from "../../../visor/surface/backend.ts";
import { startLab, startTodoApp, type TodoApp } from "./app.ts";
import type { UiEvent } from "../../../visor/surface/events.ts";

// "frame" is deliberately excluded here even though BackendKind now
// includes it: the harness reads the DOM DIRECTLY (serializeEl below) to
// compare backends, and a sandboxed frame's document is on an OPAQUE
// ORIGIN — unreachable from this realm by construction (visor/frame's
// whole point). The frame path is covered instead by the demo spike's
// e2e frameProbe, which only needs to confirm unreachability, not
// compare DOM shape against the other three.
const BACKENDS: BackendKind[] = ["queued", "direct", "channel"];

// --- the behavior script -------------------------------------------------------
// Tokens per the guest's scheme: item_token(id, slot) = 8 + id*4 + slot.

type Step =
  | { name: string; ev: UiEvent }
  | { name: string; route: string }
  | { name: string; click: string };

const SCRIPT: Step[] = [
  { name: "add alpha", ev: { token: 1, kind: "keydown", key: "Enter", value: "alpha" } },
  { name: "add beta", ev: { token: 1, kind: "keydown", key: "Enter", value: "beta" } },
  { name: "add gamma", ev: { token: 1, kind: "keydown", key: "Enter", value: "gamma" } },
  { name: "toggle alpha", ev: { token: 12, kind: "change", checked: true } },
  { name: "route completed", route: "completed" },
  { name: "route active", route: "active" },
  { name: "route all", route: "" },
  { name: "edit beta (dblclick)", ev: { token: 18, kind: "dblclick" } },
  { name: "commit beta", ev: { token: 19, kind: "keydown", key: "Enter", value: "beta edited" } },
  { name: "edit gamma (dblclick)", ev: { token: 22, kind: "dblclick" } },
  { name: "cancel gamma (Escape)", ev: { token: 23, kind: "keydown", key: "Escape" } },
  { name: "destroy first via real DOM click", click: ".todo-list li button.destroy" },
  { name: "toggle-all", ev: { token: 2, kind: "change", checked: true } },
  { name: "clear completed", ev: { token: 3, kind: "click" } },
  { name: "add final", ev: { token: 1, kind: "keydown", key: "Enter", value: "final" } },
];

// --- DOM serialization -----------------------------------------------------------

function serializeEl(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attributes]
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
    .join(" ");
  let props = "";
  if (el instanceof HTMLInputElement) {
    props = ` {value=${JSON.stringify(el.value)} checked=${el.checked}}`;
  }
  const focus = el === document.activeElement ? " *FOCUS*" : "";
  const kids = [...el.childNodes]
    .map((n) =>
      n.nodeType === Node.TEXT_NODE
        ? JSON.stringify(n.textContent)
        : n.nodeType === Node.ELEMENT_NODE
        ? serializeEl(n as Element)
        : ""
    )
    .join(",");
  return `<${tag}${attrs ? " " + attrs : ""}${props}${focus}>[${kids}]`;
}

const snapshot = (c: HTMLElement) =>
  [...c.children].map(serializeEl).join("\n");

// --- quiescence (channel events round-trip asynchronously) -----------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function quiesce(app: TodoApp): Promise<void> {
  for (;;) {
    // `runner!`: this sweep is same-realm kinds only (BACKENDS above),
    // and only the frame kind lacks one (app.ts's TodoApp.runner).
    const g = app.runner!.generation;
    await app.runner!.settle();
    await sleep(0);
    if (app.runner!.generation === g) return;
  }
}

// --- harness proper ---------------------------------------------------------------

interface BackendRun {
  kind: BackendKind;
  steps: string[]; // serialized DOM after each step
  traps: string[]; // probe outcome per id ("ok" or normalized error)
  probeDom: string[]; // serialized DOM after probe 0 and probe 7
}

function normalizeError(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const m = s.match(/surface: [^\n"]*/);
  return m ? m[0] : s;
}

async function runBehavior(kind: BackendKind, host: HTMLElement) {
  const container = document.createElement("div");
  host.appendChild(container);
  const routeRef = { value: "" };
  const errors: unknown[] = [];
  const app = await startTodoApp(
    kind,
    container,
    () => routeRef.value,
    (e) => errors.push(e),
  );
  await quiesce(app);

  const steps: string[] = [];
  for (const step of SCRIPT) {
    if ("ev" in step) {
      await app.sendEvent(step.ev);
    } else if ("route" in step) {
      routeRef.value = step.route;
      await app.sendRoute(step.route);
    } else {
      await quiesce(app); // ops applied before we query the DOM
      const target = container.querySelector(step.click) as HTMLElement | null;
      if (!target) throw new Error(`harness: no target for '${step.click}'`);
      target.click();
    }
    await quiesce(app);
    steps.push(snapshot(container));
  }
  if (errors.length) {
    throw new Error(`harness: event errors on ${kind}: ${errors[0]}`);
  }
  return steps;
}

const PROBE_CASES = 10;

async function runTraps(kind: BackendKind, host: HTMLElement) {
  const traps: string[] = [];
  const probeDom: string[] = [];
  for (let id = 0; id < PROBE_CASES; id++) {
    const container = document.createElement("div");
    host.appendChild(container);
    const lab = await startLab(kind, container);
    let outcome: string;
    try {
      await lab.runner!.call(() => lab.exports.probe(id));
      outcome = "ok";
    } catch (e) {
      outcome = normalizeError(e);
    }
    await lab.runner!.settle();
    traps.push(outcome);
    if (id === 0 || id === 7) probeDom.push(snapshot(container));
    container.remove();
  }
  return { traps, probeDom };
}

function diffIndex(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

export async function runHarness(): Promise<void> {
  const out = document.getElementById("out") as HTMLElement;
  const log = (html: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    out.appendChild(div);
  };

  try {
    const host = document.getElementById("containers") as HTMLElement;
    const runs: BackendRun[] = [];
    for (const kind of BACKENDS) {
      log(`running <b>${kind}</b>…`);
      const steps = await runBehavior(kind, host);
      const { traps, probeDom } = await runTraps(kind, host);
      runs.push({ kind, steps, traps, probeDom });
    }

    const failures: string[] = [];
    const base = runs[0];

    // Stepwise DOM equality across backends.
    for (const run of runs.slice(1)) {
      const i = diffIndex(base.steps, run.steps);
      if (i !== -1) {
        failures.push(
          `step ${i} (“${SCRIPT[i].name}”): ${base.kind} vs ${run.kind}\n--- ${base.kind}\n${base.steps[i]}\n--- ${run.kind}\n${run.steps[i]}`,
        );
      }
    }

    // Trap-vector equality + expectations.
    for (const run of runs.slice(1)) {
      const i = diffIndex(base.traps, run.traps);
      if (i !== -1) {
        failures.push(
          `probe ${i}: ${base.kind} → ${base.traps[i]} | ${run.kind} → ${run.traps[i]}`,
        );
      }
      const j = diffIndex(base.probeDom, run.probeDom);
      if (j !== -1) {
        failures.push(
          `probe DOM ${j === 0 ? "(case 0)" : "(case 7)"}: ${base.kind} vs ${run.kind}\n--- ${base.kind}\n${base.probeDom[j]}\n--- ${run.kind}\n${run.probeDom[j]}`,
        );
      }
    }
    if (base.traps[0] !== "ok") {
      failures.push(`probe 0 should be legal, got: ${base.traps[0]}`);
    }
    for (let id = 1; id < PROBE_CASES; id++) {
      if (!base.traps[id].startsWith("surface:") && base.traps[id] === "ok") {
        failures.push(`probe ${id} should trap, got ok`);
      }
    }
    if (!base.probeDom[1]?.includes("pre-trap")) {
      failures.push(
        `flush-on-trap violated: pre-trap ops missing from case-7 DOM: ${
          base.probeDom[1]
        }`,
      );
    }

    // Report.
    const pass = failures.length === 0;
    log(
      `<h2 style="color:${pass ? "#2a2" : "#b83f45"}">HARNESS: ${
        pass ? "PASS" : "FAIL"
      }</h2>`,
    );
    log(
      `<p>${runs.length} backends × ${SCRIPT.length} scripted steps + ${PROBE_CASES} probe cases.</p>`,
    );
    const esc = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    log(
      `<details><summary>trap vector (${base.kind})</summary><pre>${
        esc(base.traps.map((t, i) => `${i}: ${t}`).join("\n"))
      }</pre></details>`,
    );
    log(
      `<details><summary>final DOM (${base.kind})</summary><pre>${
        esc(base.steps[base.steps.length - 1])
      }</pre></details>`,
    );
    for (const f of failures) log(`<pre style="color:#b83f45">${esc(f)}</pre>`);

    (globalThis as Record<string, unknown>).__harnessResult = {
      pass,
      failures,
      traps: base.traps,
    };
  } catch (e) {
    log(`<pre style="color:#b83f45">harness crashed: ${e}</pre>`);
    (globalThis as Record<string, unknown>).__harnessResult = {
      pass: false,
      failures: [String(e)],
    };
  }
}
