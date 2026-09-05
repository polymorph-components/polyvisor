//! TodoMVC as a dioxus app on **polyengine-dioxus** (`polymorph:dioxus`),
//! the sibling renderer — not on `polyvisor:surface`, which the hand-written
//! and Preact guests still use. See ../README.md for the two-surface ruling.
//!
//! # Provenance
//!
//! The app body is taken over from the sibling's own example,
//! `polyengine-dioxus/examples/todomvc/src/lib.rs`, which is itself a
//! near-verbatim port of DioxusLabs/dioxus @ v0.7.10
//! `examples/01-app-demos/todomvc.rs` (MIT/Apache-2.0). Taking it over rather
//! than keeping this spike's own former `app.rs` is deliberate: one TodoMVC in
//! dioxus is enough, and a second copy that drifts is worse than a shared
//! ancestor. The sibling's three documented deviations from upstream (no
//! `asset!` stylesheet, `launch!` instead of `main`, `values_mut()` for
//! clippy) carry over unchanged.
//!
//! # The one deliberate divergence: the filter is a ROUTE
//!
//! Upstream — and the sibling's example — keep the All/Active/Completed
//! filter as in-guest state (`use_signal(|| FilterState::All)`), and the
//! three `#/`, `#/active`, `#/completed` anchors merely `prevent_default()`
//! and set that signal. This guest instead drives the filter from
//! `polymorph:dioxus/history`, because that is the interface the re-target
//! exists to exercise: the host owns the encoding (here the URL fragment,
//! `fragmentHistory` — wit/world.wit's `interface history` names exactly this
//! shape for "a host that does not own the path, such as polyvisor's apps"),
//! and the guest never sees it.
//!
//! Deliberately NO `dioxus-router`. Three filter states reachable by three
//! literal routes do not need a routing table, a `Routable` derive and a
//! `Router` component; `history()` is already root context (the renderer
//! installs `WitHistory` there — polyengine-dioxus/src/driver.rs:269), so
//! reading `current_route()` and subscribing to `updater` is the whole job.
//!
//! Both directions are wired, and they are genuinely different paths:
//!
//!   - GUEST → HOST: a filter click calls `history().push(route)`. The host's
//!     `push` deliberately does NOT come back on `changes` ("the guest asked,
//!     so the guest already knows" — host/src/history.ts), so the handler also
//!     sets `filter` itself. That is not redundancy; it is the contract.
//!   - HOST → GUEST: a back button, or the shell's own hash edit, arrives on
//!     the `changes` stream and reaches us as the `updater` callback. The
//!     callback cannot read the route itself (see `route_version` below), so
//!     it invalidates and the effect re-reads.

use dioxus::prelude::*;
// Not via `dioxus::prelude`: its re-export of these two is behind dioxus's
// `document` feature (dioxus-0.7.10/src/lib.rs:153), which this guest does not
// enable. See Cargo.toml.
use dioxus_history::history;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(PartialEq, Eq, Clone, Copy)]
enum FilterState {
    All,
    Active,
    Completed,
}

/// The abstract route for each filter, as `history` spells routes
/// (`/path?query#fragment` — wit/world.wit, `interface history`). The host's
/// `fragmentHistory` encodes `/active` as the document fragment `#/active`,
/// which is why the anchors' `href`s below carry the extra `#`: the `href` is
/// a real URL for the browser, the pushed route is not.
impl FilterState {
    fn route(self) -> &'static str {
        match self {
            FilterState::All => "/",
            FilterState::Active => "/active",
            FilterState::Completed => "/completed",
        }
    }

    /// Parse a route back to a filter. Anything unrecognised is `All` — a
    /// bad fragment is a user typo, not an error condition, and TodoMVC's
    /// own reference behaviour is to show everything.
    fn from_route(route: &str) -> Self {
        match route.trim_end_matches('/') {
            "/active" | "active" => FilterState::Active,
            "/completed" | "completed" => FilterState::Completed,
            _ => FilterState::All,
        }
    }
}

struct TodoItem {
    checked: bool,
    contents: String,
}

fn app() -> Element {
    // We store the todos in a HashMap in a Signal.
    // Each key is the id of the todo, and the value is the todo itself.
    let mut todos = use_signal(HashMap::<u32, TodoItem>::new);

    // Seeded from the CURRENT route rather than from `FilterState::All`, so a
    // deep link (`#/completed` in the address bar at load) renders correctly
    // on the FIRST paint. `use_signal`'s initializer runs during the first
    // render with this component's scope current, which is what `history()`'s
    // `try_consume_context` needs.
    let filter = use_signal(|| FilterState::from_route(&history().current_route()));

    // THE HOST→GUEST INVALIDATION. `History::updater` takes an
    // `Arc<dyn Fn() + Send + Sync>`, so the callback cannot capture the
    // `Rc<dyn History>` needed to read the new route — and the renderer's
    // `WitHistory::updater` deliberately drops the route the `changes` stream
    // carried ("the host has already moved to it, so the router's re-read of
    // `current_route()` is the authoritative answer" —
    // polyengine-dioxus/src/history.rs:71-78). So the callback carries no
    // data: it bumps a counter, and the effect below re-reads the route from
    // a place where `history()` resolves. This is the same shape
    // dioxus-router uses.
    //
    // `use_signal_sync` (not `use_signal`): `Signal<T, SyncStorage>` is the
    // one that satisfies the callback's `Send + Sync` bound.
    let route_version = use_signal_sync(|| 0u32);
    use_hook(|| {
        history().updater(Arc::new(move || {
            // `peek`, not a read: this runs outside any reactive context and
            // must not try to subscribe one. Read into a local first — the
            // peek guard must be dropped before the write borrow is taken.
            let next = route_version.peek().wrapping_add(1);
            let mut version = route_version;
            version.set(next);
        }));
    });

    use_effect(move || {
        // Subscribe. The first run is at mount and is a no-op (the signal was
        // already seeded from this same route above); every later run is a
        // host-driven navigation.
        route_version();
        let mut filter = filter;
        filter.set(FilterState::from_route(&history().current_route()));
    });

    // We use a simple memoized signal to calculate the number of active todos.
    // Whenever the todos change, the active_todo_count will be recalculated.
    let active_todo_count =
        use_memo(move || todos.read().values().filter(|item| !item.checked).count());

    // We use a memoized signal to filter the todos based on the current filter state.
    // Whenever the todos or filter change, the filtered_todos will be recalculated.
    // Note that we're only storing the IDs of the todos, not the todos themselves.
    let filtered_todos = use_memo(move || {
        let mut filtered_todos = todos
            .read()
            .iter()
            .filter(|(_, item)| match filter() {
                FilterState::All => true,
                FilterState::Active => !item.checked,
                FilterState::Completed => item.checked,
            })
            .map(|f| *f.0)
            .collect::<Vec<_>>();

        filtered_todos.sort_unstable();

        filtered_todos
    });

    // Toggle all the todos to the opposite of the current state.
    // If all todos are checked, uncheck them all. If any are unchecked, check them all.
    let toggle_all = move |_| {
        let check = active_todo_count() != 0;
        for item in todos.write().values_mut() {
            item.checked = check;
        }
    };

    rsx! {
        section { class: "todoapp",
            TodoHeader { todos }
            section { class: "main",
                if !todos.read().is_empty() {
                    input {
                        id: "toggle-all",
                        class: "toggle-all",
                        r#type: "checkbox",
                        onchange: toggle_all,
                        checked: active_todo_count() == 0
                    }
                    label { r#for: "toggle-all" }
                }

                // Render the todos using the filtered_todos signal
                // We pass the ID into the TodoEntry component so it can access the todo from the todos signal.
                // Since we store the todos in a signal too, we also need to send down the todo list
                ul { class: "todo-list",
                    for id in filtered_todos() {
                        TodoEntry { key: "{id}", id, todos }
                    }
                }

                // We only show the footer if there are todos.
                if !todos.read().is_empty() {
                    ListFooter { active_todo_count, todos, filter }
                }
            }
        }

        // A simple info footer
        footer { class: "info",
            p { "Double-click to edit a todo" }
            p {
                "Created by "
                a { href: "http://github.com/jkelleyrtp/", "jkelleyrtp" }
            }
            p {
                "Part of "
                a { href: "http://todomvc.com", "TodoMVC" }
            }
        }
    }
}

#[component]
fn TodoHeader(mut todos: WriteSignal<HashMap<u32, TodoItem>>) -> Element {
    let mut draft = use_signal(|| "".to_string());
    let mut todo_id = use_signal(|| 0);

    let onkeydown = move |evt: KeyboardEvent| {
        if evt.key() == Key::Enter && !draft.is_empty() {
            let id = todo_id();
            let todo = TodoItem {
                checked: false,
                contents: draft.to_string(),
            };
            todos.insert(id, todo);
            todo_id += 1;
            draft.set("".to_string());
        }
    };

    rsx! {
        header { class: "header",
            h1 { "todos" }
            input {
                class: "new-todo",
                placeholder: "What needs to be done?",
                value: "{draft}",
                autofocus: "true",
                oninput: move |evt| draft.set(evt.value()),
                onkeydown
            }
        }
    }
}

/// A single todo entry
/// This takes the ID of the todo and the todos signal as props
/// We can use these together to memoize the todo contents and checked state
#[component]
fn TodoEntry(mut todos: WriteSignal<HashMap<u32, TodoItem>>, id: u32) -> Element {
    let mut is_editing = use_signal(|| false);

    // To avoid re-rendering this component when the todo list changes, we isolate our reads to memos
    // This way, the component will only re-render when the contents of the todo change, or when the editing state changes.
    // This does involve taking a local clone of the todo contents, but it allows us to prevent this component from re-rendering
    let checked = use_memo(move || todos.read().get(&id).unwrap().checked);
    let contents = use_memo(move || todos.read().get(&id).unwrap().contents.clone());

    rsx! {
        li {
            // Dioxus lets you use if statements in rsx to conditionally render attributes
            // These will get merged into a single class attribute
            class: if checked() { "completed" },
            class: if is_editing() { "editing" },

            // Some basic controls for the todo
            div { class: "view",
                input {
                    class: "toggle",
                    r#type: "checkbox",
                    id: "cbg-{id}",
                    checked: "{checked}",
                    oninput: move |evt| todos.get_mut(&id).unwrap().checked = evt.checked()
                }
                label {
                    r#for: "cbg-{id}",
                    ondoubleclick: move |_| is_editing.set(true),
                    onclick: |evt| evt.prevent_default(),
                    "{contents}"
                }
                button {
                    class: "destroy",
                    onclick: move |evt| {
                        evt.prevent_default();
                        todos.remove(&id);
                    },
                }
            }

            // Only render the actual input if we're editing
            if is_editing() {
                input {
                    class: "edit",
                    value: "{contents}",
                    oninput: move |evt| todos.get_mut(&id).unwrap().contents = evt.value(),
                    autofocus: "true",
                    onfocusout: move |_| is_editing.set(false),
                    onkeydown: move |evt| {
                        match evt.key() {
                            Key::Enter | Key::Escape | Key::Tab => is_editing.set(false),
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn ListFooter(
    mut todos: WriteSignal<HashMap<u32, TodoItem>>,
    active_todo_count: ReadSignal<usize>,
    mut filter: WriteSignal<FilterState>,
) -> Element {
    // We use a memoized signal to calculate whether we should show the "Clear completed" button.
    // This will recompute whenever the todos change, and if the value is true, the button will be shown.
    let show_clear_completed = use_memo(move || todos.read().values().any(|todo| todo.checked));

    rsx! {
        footer { class: "footer",
            span { class: "todo-count",
                strong { "{active_todo_count} " }
                span {
                    match active_todo_count() {
                        1 => "item",
                        _ => "items",
                    }
                    " left"
                }
            }
            ul { class: "filters",
                for state in [FilterState::All, FilterState::Active, FilterState::Completed] {
                    li {
                        a {
                            href: "#{state.route()}",
                            class: if filter() == state { "selected" },
                            onclick: move |evt| {
                                // NOTE: across the sandboxed-frame transport
                                // this call is a NO-OP (the frame's native
                                // listener returned long before the shell saw
                                // the event — see host/dioxus-frame.ts). It is
                                // kept because it is correct on a same-realm
                                // mount, and because letting the anchor's
                                // default action run in the frame only moves
                                // the FRAME's own fragment, which nothing
                                // reads.
                                evt.prevent_default();
                                // GUEST → HOST. `push` does not echo back on
                                // `changes`, so the local set below is the
                                // other half of the same navigation, not a
                                // duplicate of it.
                                history().push(state.route().to_string());
                                filter.set(state);
                            },
                            {
                                match state {
                                    FilterState::All => "All",
                                    FilterState::Active => "Active",
                                    FilterState::Completed => "Completed",
                                }
                            }
                        }
                    }
                }
            }
            if show_clear_completed() {
                button {
                    class: "clear-completed",
                    onclick: move |_| todos.retain(|_, todo| !todo.checked),
                    "Clear completed"
                }
            }
        }
    }
}

polyengine_dioxus::launch!(app);
