// The demo page: TodoMVC on a selectable backend
// (?backend=direct|queued|channel|frame, default frame — the real
// sandboxed-surface split (#16); harness.ts/bench.ts stay on the three
// same-realm kinds for their own reasons, see those files).
//
// TWO APP SURFACES, split by what the app is written in (see ../README.md):
// `?guest=hand` and `?guest=preact` are `polyvisor:surface` apps and take the
// backend switch below; `?guest=dioxus` is a `polymorph:dioxus` app on the
// sibling renderer and takes ./dioxus-frame.ts instead. The two are different
// worlds, not two configurations of one.

import { isBackendKind, type BackendKind } from "../../../visor/surface/backend.ts";
import { startTodoApp } from "./app.ts";
import { mountDioxusFrame } from "./dioxus-frame.ts";
import { initTodoVisor } from "./visor.ts";

export async function runDemo(): Promise<void> {
  const container = document.getElementById("app") as HTMLElement;

  const showError = (e: unknown) => {
    console.error(e);
    const pre = document.createElement("pre");
    pre.style.cssText =
      "color:#b83f45;white-space:pre-wrap;padding:16px;font-size:12px";
    pre.textContent = `spike failed:\n${
      e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)
    }`;
    container.replaceChildren(pre);
  };

  try {
    const params = new URLSearchParams(location.search);
    const param = params.get("backend");
    const kind: BackendKind = isBackendKind(param) ? param : "frame";
    const guestParam = params.get("guest");
    const guest = guestParam === "dioxus" || guestParam === "preact"
      ? guestParam
      : "hand";
    const artifact = guest === "hand" ? "todomvc" : `todomvc-${guest}`;

    const note = document.querySelector("#backend-note");

    if (guest === "dioxus") {
      // THE DIOXUS GUEST: a different world, and only one placement.
      //
      // `?backend=` does not apply and is not faked. `direct` has a real
      // analogue — the sibling's own `mountApp`, which applies into the
      // document it runs in — but `queued` and `channel` are
      // surface-specific: they are two application strategies for the
      // `polyvisor:surface` op protocol, and `polymorph:dioxus` has exactly
      // one op protocol with the transport chosen by where the applier
      // lives. Saying so in the page note beats offering a switch that
      // silently ignores three of its four values.
      initTodoVisor(artifact);
      container.textContent = "";
      const [envelope, bytes] = await Promise.all([
        fetch(`./${artifact}.plan.json`).then((r) => {
          if (!r.ok) throw new Error(`${artifact} plan fetch: HTTP ${r.status}`);
          return r.text();
        }),
        fetch(`./${artifact}.component.wasm`).then(async (r) => {
          if (!r.ok) throw new Error(`${artifact} component fetch: HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        }),
      ]);
      await mountDioxusFrame({ container, envelope, bytes, onError: showError });
      if (note) {
        note.textContent =
          "backend: frame (sandboxed, opaque origin) · guest: dioxus on polyengine-dioxus";
      }
      return;
    }

    const route = () => location.hash.replace(/^#\/?/, "");
    // The visor is a pure consumer of the shared system UI now — it
    // draws the strip and registers the framework's own sheets, and has
    // no hold on the running app at all. (It used to be handed the
    // runner and the surface teardown for its "kill" tenant, and the
    // hashchange listener had to ask whether that tenant had killed the
    // app before delivering a route. Both are gone with the tenant;
    // `TodoApp.teardown` itself stays in app.ts, unused here.)
    initTodoVisor(artifact);
    container.textContent = "";
    const app = await startTodoApp(kind, container, route, showError, artifact);
    addEventListener("hashchange", () => {
      app.sendRoute(route()).catch(showError);
    });

    if (note) note.textContent = `backend: ${kind} · guest: ${guest}`;
  } catch (e) {
    showError(e);
  }
}

