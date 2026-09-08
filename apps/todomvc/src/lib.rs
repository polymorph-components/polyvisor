//! polyvisor's TodoMVC app: `world app` from `wit/app.wit`.
//!
//! Ported from polymorph-stream-dom's `guests/dioxus/todomvc/src/lib.rs`
//! (rev 1974923), which is itself DioxusLabs/dioxus @ v0.7.10
//! `examples/01-app-demos/todomvc.rs` (MIT/Apache-2.0). Components, names and
//! structure are kept recognisable; what changed is where the state lives.
//!
//! **The list is not ours.** The example keeps a `HashMap<u32, TodoItem>` in a
//! signal and mutates it in place. Here the schema authority is the `tasks`
//! service (`wit/app.wit`, interface `tasks`): the signal holds a *snapshot*,
//! every mutation is a service call, and the snapshot is re-fetched after it.
//! See [`refresh`] for what that costs and what is missing.
//!
//! The module is split the way `stream-dom-dioxus` splits its own: everything
//! that names WIT bindings is `#[cfg(target_arch = "wasm32")]`, so a plain
//! `cargo clippy --workspace` still type-checks the components against the
//! `#[cfg(not(target_arch = "wasm32"))]` stub in [`service`].

use dioxus::prelude::*;

// ---------------------------------------------------------------------------
// The component world
// ---------------------------------------------------------------------------

/// Bindings for `polyvisor:app/app`.
///
/// Generated here rather than reached through `stream_dom_dioxus::launch!`:
/// `launch!` exports the bare `polymorph:stream-dom/producer` world, which
/// has no `tasks` import. The `with:` remaps make this world's stream-dom
/// types *the same Rust types* as `stream_dom_guest::bindings`', so the
/// `EventTarget` / `DomEvent` this world's `handle-event` receives can be
/// handed straight to `stream_dom_dioxus::driver`.
#[cfg(target_arch = "wasm32")]
#[allow(clippy::empty_docs)]
mod bindings {
    // No `async:` option, for the reason spelled out in
    // `runtime/component/src/component.rs`: one blanket mode lowers WIT-sync
    // functions with the async canonical option, which the canonical ABI
    // forbids and only wasmtime and polyengine's translator catch. Omitting
    // it makes each function follow its own WIT declaration.
    wit_bindgen::generate!({
        path: "../../wit",
        world: "app",
        with: {
            "polymorph:stream-dom/types@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::types,
            "polymorph:stream-dom/queries@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::queries,
            "polymorph:stream-dom/events@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::events,
        },
    });
}

#[cfg(target_arch = "wasm32")]
struct Component;

#[cfg(target_arch = "wasm32")]
impl bindings::Guest for Component {
    async fn run(hydrate: bool) -> stream_dom_dioxus::driver::MutationStream {
        stream_dom_dioxus::driver::run(app, hydrate).await
    }

    async fn handle_event(
        target: bindings::EventTarget,
        name: u32,
        payload: Vec<u8>,
        ev: &bindings::DomEvent,
    ) {
        stream_dom_dioxus::driver::handle_event(target, name, payload, ev).await
    }
}

#[cfg(target_arch = "wasm32")]
bindings::export!(Component with_types_in bindings);

/// Keeps the root component reachable off the component target, so a native
/// `clippy -D warnings` type-checks it rather than dead-coding it away. Same
/// trick, and same reason, as `stream_dom_dioxus::launch!`'s non-wasm arm.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub fn __launch_root() {
    let _ = app;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/// One task, as the components see it. A plain mirror of
/// `polyvisor:app/tasks.todo-item` so the components name no bindings and the
/// `id` stays what the service says it is: an opaque `string`.
#[derive(Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

/// `polyvisor:app/tasks`, one thin layer up: the generated bindings' types
/// mapped onto [`TodoItem`], and every `result<_, string>` kept as
/// `Result<_, String>`.
#[cfg(target_arch = "wasm32")]
mod service {
    use super::TodoItem;
    use crate::bindings::polyvisor::app::tasks;

    pub async fn items() -> Result<Vec<TodoItem>, String> {
        Ok(tasks::items()
            .await?
            .items
            .into_iter()
            .map(|i| TodoItem {
                id: i.id,
                title: i.title,
                completed: i.completed,
            })
            .collect())
    }

    pub async fn add(title: String) -> Result<String, String> {
        tasks::add(title).await
    }

    pub async fn set_completed(id: String, completed: bool) -> Result<(), String> {
        tasks::set_completed(id, completed).await
    }

    pub async fn set_title(id: String, title: String) -> Result<(), String> {
        tasks::set_title(id, title).await
    }

    pub async fn remove(id: String) -> Result<(), String> {
        tasks::remove(id).await
    }
}

/// `polyvisor:app/route`, thin like [`service`] above.
#[cfg(target_arch = "wasm32")]
mod route {
    use crate::bindings::polyvisor::app::route;

    pub fn get() -> String {
        route::get()
    }

    pub fn set(route: &str) {
        route::set(route)
    }
}

/// Off the component target there is no host to answer it; same reason as
/// `service`'s native stub just below.
#[cfg(not(target_arch = "wasm32"))]
mod route {
    pub fn get() -> String {
        String::new()
    }

    pub fn set(_route: &str) {}
}

/// Off the component target there is no service and no host to answer it.
/// The stub exists only so the components below type-check under a native
/// `cargo clippy --workspace --all-targets`; it is never linked into the
/// component.
#[cfg(not(target_arch = "wasm32"))]
mod service {
    use super::TodoItem;

    pub async fn items() -> Result<Vec<TodoItem>, String> {
        Ok(Vec::new())
    }

    pub async fn add(title: String) -> Result<String, String> {
        Ok(title)
    }

    pub async fn set_completed(_id: String, _completed: bool) -> Result<(), String> {
        Ok(())
    }

    pub async fn set_title(_id: String, _title: String) -> Result<(), String> {
        Ok(())
    }

    pub async fn remove(_id: String) -> Result<(), String> {
        Ok(())
    }
}

/// Replace the snapshot with a fresh one from the service.
///
/// This is the *only* thing that refreshes: it runs on mount and after each
/// of our own mutations. `tasks.revision` is a cheap monotonic probe and this
/// app never calls it, because there is nothing in the app world to call it
/// *from* — no timer, no wakeup, no incoming event that is not already one of
/// our own mutations. So a change applied by another session (or a sync) is
/// invisible here until the user touches something.
///
/// That is the documented shape of the contract, not an oversight:
/// `wit/app.wit`'s `tasks` doc calls the interface "poll-shaped on purpose"
/// and names "a change feed ... once apps have an event path that wants one"
/// as the expected additive next step (docs/design.md "Contracts"). When that
/// lands, this function is what it replaces.
///
/// A failed fetch leaves the previous snapshot in place. M1 has no surface to
/// report an error on.
async fn refresh(mut items: Signal<Vec<TodoItem>>) {
    if let Ok(fresh) = service::items().await {
        items.set(fresh);
    }
}

/// Run one mutation, then re-read the list. Every write path goes through
/// here, which is what keeps "mutate then re-fetch" from being restated six
/// times.
fn mutate(items: Signal<Vec<TodoItem>>, work: impl Future<Output = ()> + 'static) {
    spawn(async move {
        work.await;
        refresh(items).await;
    });
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

#[derive(PartialEq, Eq, Clone, Copy)]
enum FilterState {
    All,
    Active,
    Completed,
}

/// The stylesheet's asset handle, `asset:` followed by `manifest.json`'s
/// `handle` for `todomvc-app.css` — the spelling upstream's writer gives an
/// asset-valued attribute (polymorph-stream-dom#19, `writer.rs` `asset_handle`). The
/// `tests` module below asserts these stay in agreement.
const STYLESHEET: &str = "asset:0f827d119b7bec30534b1767e8ab8ee0f2890c98f93baa1159dcf1a46f10bc17";

pub fn app() -> Element {
    // The snapshot. Owned by the `tasks` service; this is a cached view of it.
    let items = use_signal(Vec::<TodoItem>::new);
    // The route is this app's own prior output, relayed back by the visor —
    // not user-typed input (`wit/app.wit` `route`: "a route this app is
    // handed is one it wrote itself on one of the user's own devices"). An
    // unknown value (including a plain launch's "") is simply `All`, the
    // same as a value this app never wrote.
    let filter = use_signal(|| match route::get().as_str() {
        "active" => FilterState::Active,
        "completed" => FilterState::Completed,
        _ => FilterState::All,
    });

    // On mount: the first snapshot.
    use_future(move || refresh(items));

    let active_todo_count = use_memo(move || items.read().iter().filter(|i| !i.completed).count());

    // The service returns items in stable id order, so unlike the example
    // this does not sort: filtering preserves that order.
    let filtered_todos = use_memo(move || {
        items
            .read()
            .iter()
            .filter(|item| match filter() {
                FilterState::All => true,
                FilterState::Active => !item.completed,
                FilterState::Completed => item.completed,
            })
            .cloned()
            .collect::<Vec<_>>()
    });

    // Toggle all the todos to the opposite of the current state. There is no
    // bulk call in the contract, so this is a loop over `set-completed` — and
    // only over the items that actually change.
    let toggle_all = move |_| {
        let completed = active_todo_count() != 0;
        let ids = items
            .read()
            .iter()
            .filter(|i| i.completed != completed)
            .map(|i| i.id.clone())
            .collect::<Vec<_>>();
        mutate(items, async move {
            for id in ids {
                let _ = service::set_completed(id, completed).await;
            }
        });
    };

    rsx! {
        link { rel: "stylesheet", href: STYLESHEET }

        section { class: "todoapp",
            TodoHeader { items }
            section { class: "main",
                if !items.read().is_empty() {
                    input {
                        id: "toggle-all",
                        class: "toggle-all",
                        r#type: "checkbox",
                        onchange: toggle_all,
                        checked: active_todo_count() == 0,
                    }
                    label { r#for: "toggle-all" }
                }

                ul { class: "todo-list",
                    for item in filtered_todos() {
                        TodoEntry { key: "{item.id}", item, items }
                    }
                }

                if !items.read().is_empty() {
                    ListFooter { active_todo_count, items, filter }
                }
            }
        }

        // The info footer, without the example's outbound links: an app has
        // no network, and the frame policy refuses any `href` that is not an
        // asset handle or a fragment — the first thing the policy caught.
        footer { class: "info",
            p { "Double-click to edit a todo" }
            p { "Created by jkelleyrtp" }
            p { "Part of TodoMVC" }
        }
    }
}

#[component]
fn TodoHeader(items: Signal<Vec<TodoItem>>) -> Element {
    let mut draft = use_signal(String::new);

    // A `<form onsubmit>` rather than the example's `onkeydown == Enter`:
    // Enter in a lone text input already submits, and the receiver's
    // `prevent_default` stops the frame from navigating.
    let onsubmit = move |evt: FormEvent| {
        evt.prevent_default();
        let title = draft();
        if title.is_empty() {
            return;
        }
        draft.set(String::new());
        mutate(items, async move {
            let _ = service::add(title).await;
        });
    };

    rsx! {
        header { class: "header",
            h1 { "todos" }
            form { onsubmit,
                input {
                    class: "new-todo",
                    placeholder: "What needs to be done?",
                    value: "{draft}",
                    autofocus: "true",
                    oninput: move |evt| draft.set(evt.value()),
                }
            }
        }
    }
}

/// A single todo entry. Takes the item by value: the snapshot is immutable
/// here, so there is nothing to memoize a read out of.
#[component]
fn TodoEntry(item: TodoItem, items: Signal<Vec<TodoItem>>) -> Element {
    let mut is_editing = use_signal(|| false);
    // The edit box is local until it is committed. The example wrote every
    // keystroke into the shared map; doing that here would be one
    // `set-title` round trip per character.
    let mut draft = use_signal(String::new);

    let title = item.title.clone();
    let completed = item.completed;
    let cbg_id = item.id.clone();
    let toggle_id = item.id.clone();
    let destroy_id = item.id.clone();
    let commit_id = item.id.clone();
    let edit_start = item.title.clone();

    let commit = use_callback(move |()| {
        if !is_editing() {
            return;
        }
        is_editing.set(false);
        let title = draft();
        let id = commit_id.clone();
        mutate(items, async move {
            let _ = service::set_title(id, title).await;
        });
    });

    rsx! {
        li {
            class: if completed { "completed" },
            class: if is_editing() { "editing" },

            div { class: "view",
                input {
                    class: "toggle",
                    r#type: "checkbox",
                    id: "cbg-{cbg_id}",
                    checked: "{completed}",
                    oninput: move |evt: FormEvent| {
                        let id = toggle_id.clone();
                        let completed = evt.checked();
                        mutate(items, async move { let _ = service::set_completed(id, completed).await; });
                    },
                }
                label {
                    r#for: "cbg-{cbg_id}",
                    ondoubleclick: move |_| {
                        draft.set(edit_start.clone());
                        is_editing.set(true);
                    },
                    onclick: |evt| evt.prevent_default(),
                    "{title}"
                }
                button {
                    class: "destroy",
                    onclick: move |evt: MouseEvent| {
                        evt.prevent_default();
                        let id = destroy_id.clone();
                        mutate(items, async move { let _ = service::remove(id).await; });
                    },
                }
            }

            if is_editing() {
                input {
                    class: "edit",
                    value: "{draft}",
                    oninput: move |evt| draft.set(evt.value()),
                    autofocus: "true",
                    onfocusout: move |_| commit.call(()),
                    onkeydown: move |evt: KeyboardEvent| {
                        match evt.key() {
                            Key::Enter | Key::Escape | Key::Tab => commit.call(()),
                            _ => {}
                        }
                    },
                }
            }
        }
    }
}

#[component]
fn ListFooter(
    items: Signal<Vec<TodoItem>>,
    active_todo_count: ReadSignal<usize>,
    mut filter: Signal<FilterState>,
) -> Element {
    let show_clear_completed = use_memo(move || items.read().iter().any(|i| i.completed));

    // No bulk call in the contract, so: a loop over `remove`.
    let clear_completed = move |_| {
        let ids = items
            .read()
            .iter()
            .filter(|i| i.completed)
            .map(|i| i.id.clone())
            .collect::<Vec<_>>();
        mutate(items, async move {
            for id in ids {
                let _ = service::remove(id).await;
            }
        });
    };

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
                // `#/`, `#/active`, `#/completed` stay as in-frame anchors
                // (the frame policy allows `#`-fragment hrefs); the visor's
                // *page* fragment that carries the bookmarkable route is a
                // different thing, set below via `route::set`.
                for (state , state_text , url , route_value) in [
                    (FilterState::All, "All", "#/", ""),
                    (FilterState::Active, "Active", "#/active", "active"),
                    (FilterState::Completed, "Completed", "#/completed", "completed"),
                ] {
                    li {
                        a {
                            href: url,
                            class: if filter() == state { "selected" },
                            onclick: move |evt: MouseEvent| {
                                evt.prevent_default();
                                filter.set(state);
                                route::set(route_value);
                            },
                            {state_text}
                        }
                    }
                }
            }
            if show_clear_completed() {
                button { class: "clear-completed", onclick: clear_completed, "Clear completed" }
            }
        }
    }
}

// ---------------------------------------------------------------------------

/// The bundle's `manifest.json` and `assets/` must agree on the asset handle,
/// which is `sha256(asset bytes)` (`runtime/crates/kernel/src/apps.rs`, "Asset
/// handles"). Nothing else checks that at build time, so this does.
#[cfg(test)]
mod tests {
    use super::STYLESHEET;
    use sha2::{Digest, Sha256};

    fn manifest() -> serde_json::Value {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap()
    }

    #[test]
    fn manifest_asset_handles_match_the_bytes() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let manifest = manifest();
        let assets = manifest["assets"].as_array().unwrap();
        assert!(!assets.is_empty(), "manifest declares no assets");

        for asset in assets {
            let path = asset["path"].as_str().unwrap();
            let bytes = std::fs::read(dir.join("assets").join(path)).unwrap();
            let digest = format!("{:x}", Sha256::digest(&bytes));
            assert_eq!(
                asset["handle"].as_str().unwrap(),
                digest,
                "manifest handle for {path} is stale"
            );
        }
    }

    /// The app's `STYLESHEET` const must name the same asset the manifest
    /// declares for `todomvc-app.css`, in the `asset:<hex>` spelling
    /// upstream's writer expects (polymorph-stream-dom#19).
    #[test]
    fn stylesheet_const_matches_the_manifest_handle() {
        let manifest = manifest();
        let assets = manifest["assets"].as_array().unwrap();
        let css = assets
            .iter()
            .find(|a| a["path"].as_str() == Some("todomvc-app.css"))
            .expect("manifest declares no todomvc-app.css asset");
        let expected = format!("asset:{}", css["handle"].as_str().unwrap());
        assert_eq!(
            STYLESHEET, expected,
            "STYLESHEET is stale against manifest.json"
        );
    }
}
