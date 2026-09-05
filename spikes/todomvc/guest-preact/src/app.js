// TodoMVC in unmodified Preact (10.27) + htm, on the curated surface via
// the DOM shim. Nothing here knows about WIT beyond reading the initial
// route; it's the app a Preact developer would write, constrained to the
// spike's attribute allowlist (no style props, no autofocus).

import { h, options } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { route as currentRoute } from "polyvisor:surface/shell@0.1.0";

// Synchronous rerenders: state updates flush inside the same guest
// invocation, matching the surface's flush-per-invocation ordering spec.
options.debounceRendering = (f) => f();

const html = htm.bind(h);

let externalSetRoute = null;
export function setRoute(route) {
  externalSetRoute?.(route);
}

let nextId = 1;

function EditInput({ title, commit, cancel }) {
  const ref = useRef(null);
  // Layout effects run synchronously in the commit, after insertion —
  // the deterministic focus the surface spec wants (and the capability
  // the dioxus guest still lacks).
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  return html`<input
    class="edit"
    ref=${ref}
    value=${title}
    onKeyDown=${(e) => {
      if (e.key === "Enter") commit(e.target.value);
      else if (e.key === "Escape") cancel();
    }}
    onBlur=${(e) => commit(e.target.value)}
  />`;
}

export function App() {
  const [todos, setTodos] = useState([]);
  const [route, setRouteState] = useState(() => currentRoute());
  const [editing, setEditing] = useState(null);
  externalSetRoute = setRouteState;

  const total = todos.length;
  const active = todos.filter((t) => !t.completed).length;
  const completed = total - active;
  const visible = todos.filter((t) =>
    route === "active" ? !t.completed : route === "completed" ? t.completed : true
  );

  const addOnEnter = (e) => {
    if (e.key !== "Enter") return;
    const title = e.target.value.trim();
    if (!title) return;
    setTodos((ts) => [...ts, { id: nextId++, title, completed: false }]);
    e.target.value = "";
  };

  const toggle = (id, checked) =>
    setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, completed: checked } : t)));
  const destroy = (id) => {
    setEditing((cur) => (cur === id ? null : cur));
    setTodos((ts) => ts.filter((t) => t.id !== id));
  };
  const commitEdit = (id, value) => {
    setEditing((cur) => {
      if (cur !== id) return cur;
      const title = value.trim();
      if (title === "") setTodos((ts) => ts.filter((t) => t.id !== id));
      else setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)));
      return null;
    });
  };

  return html`<section class="todoapp">
    <header class="header">
      <h1>todos</h1>
      <input
        class="new-todo"
        placeholder="What needs to be done?"
        onKeyDown=${addOnEnter}
      />
    </header>
    <section class=${total === 0 ? "main hidden" : "main"}>
      <input
        class="toggle-all"
        id="toggle-all"
        type="checkbox"
        checked=${total > 0 && active === 0}
        onChange=${(e) =>
          setTodos((ts) => ts.map((t) => ({ ...t, completed: e.target.checked })))}
      />
      <label for="toggle-all">Mark all as complete</label>
      <ul class="todo-list">
        ${visible.map(
          (t) => html`<li
            key=${t.id}
            class=${[t.completed ? "completed" : "", editing === t.id ? "editing" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <div class="view">
              <input
                class="toggle"
                type="checkbox"
                checked=${t.completed}
                onChange=${(e) => toggle(t.id, e.target.checked)}
              />
              <label onDblClick=${() => setEditing(t.id)}>${t.title}</label>
              <button class="destroy" onClick=${() => destroy(t.id)}></button>
            </div>
            ${editing === t.id &&
            html`<${EditInput}
              title=${t.title}
              commit=${(v) => commitEdit(t.id, v)}
              cancel=${() => setEditing(null)}
            />`}
          </li>`
        )}
      </ul>
    </section>
    <footer class=${total === 0 ? "footer hidden" : "footer"}>
      <span class="todo-count">
        <strong>${active}</strong> ${active === 1 ? "item left" : "items left"}
      </span>
      <ul class="filters">
        <li><a class=${route === "" ? "selected" : ""} href="#/">All</a></li>
        <li>
          <a class=${route === "active" ? "selected" : ""} href="#/active">Active</a>
        </li>
        <li>
          <a class=${route === "completed" ? "selected" : ""} href="#/completed"
            >Completed</a
          >
        </li>
      </ul>
      <button
        class=${completed === 0 ? "clear-completed hidden" : "clear-completed"}
        onClick=${() => setTodos((ts) => ts.filter((t) => !t.completed))}
      >
        Clear completed
      </button>
    </footer>
  </section>`;
}
