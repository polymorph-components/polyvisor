//! TodoMVC as a wasm component driving the curated DOM surface.
//!
//! No app JS, no app HTML: everything the user sees is expressed through
//! typed calls on `polymorph:todomvc-spike/dom` (a WebIDL-mirror subset)
//! and delivered back as event records (polymorph-apps#16).
//!
//! Rendering strategy: a static skeleton built once in `run()`, plus a
//! full rebuild of the todo list on every state change — deliberately
//! naive; the spike measures plumbing, not diffing.

use std::cell::RefCell;

wit_bindgen::generate!({
    path: "../wit",
    world: "todomvc",
    // `generate_all`: the surface interfaces now live in a DEPENDENCY
    // package (`polyvisor:surface@0.1.0`, symlinked at ../wit/deps), and
    // wit-bindgen does not generate bindings for a dep unless told to —
    // it demands either this or a `with:` mapping per interface. Bindings
    // for all three are wanted here, so this is the one-word form.
    generate_all,
});

use crate::polyvisor::surface::dom::{create_element, Element};
use crate::polyvisor::surface::events::{listen, EventKind};
use crate::polyvisor::surface::shell;

// --- listener tokens ---------------------------------------------------------
// Static controls get small fixed tokens; per-item listeners encode
// (todo id, slot) so `on_event` can decode without a lookup table.

const TOK_NEW: u32 = 1; // new-todo input, keydown
const TOK_TOGGLE_ALL: u32 = 2; // toggle-all checkbox, change
const TOK_CLEAR: u32 = 3; // clear-completed button, click
const TOK_ITEM_BASE: u32 = 8;

const SLOT_TOGGLE: u32 = 0; // item checkbox, change
const SLOT_DESTROY: u32 = 1; // item destroy button, click
const SLOT_LABEL: u32 = 2; // item label, dblclick (start editing)
const SLOT_EDIT: u32 = 3; // item edit input, keydown + blur

fn item_token(id: u32, slot: u32) -> u32 {
    TOK_ITEM_BASE + id * 4 + slot
}

// --- model -------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    Active,
    Completed,
}

impl Filter {
    fn from_route(route: &str) -> Filter {
        match route {
            "active" => Filter::Active,
            "completed" => Filter::Completed,
            _ => Filter::All,
        }
    }

    fn admits(self, completed: bool) -> bool {
        match self {
            Filter::All => true,
            Filter::Active => !completed,
            Filter::Completed => completed,
        }
    }
}

struct Todo {
    id: u32,
    title: String,
    completed: bool,
}

/// Handles into the static skeleton. Retained for the app's lifetime so the
/// host-side entries stay alive; per-render li handles live in `items` and
/// are dropped (-> host `free`) on each rebuild.
struct Ui {
    new_input: Element,
    main: Element,
    toggle_all: Element,
    list: Element,
    count: Element,
    footer: Element,
    link_all: Element,
    link_active: Element,
    link_completed: Element,
    clear: Element,
    items: Vec<Element>,
}

struct App {
    todos: Vec<Todo>,
    next_id: u32,
    filter: Filter,
    editing: Option<u32>,
    ui: Option<Ui>,
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App {
        todos: Vec::new(),
        next_id: 1,
        filter: Filter::All,
        editing: None,
        ui: None,
    });
}

// --- view --------------------------------------------------------------------

fn el(tag: &str, class: &str) -> Element {
    let e = create_element(tag);
    if !class.is_empty() {
        e.set_attribute("class", class);
    }
    e
}

fn filter_link(href: &str, label: &str) -> (Element, Element) {
    let li = el("li", "");
    let a = el("a", "");
    a.set_attribute("href", href);
    a.set_text_content(label);
    li.append_child(&a);
    (li, a)
}

fn build_skeleton(app: &mut App) {
    let root = shell::root();
    let todoapp = el("section", "todoapp");

    let header = el("header", "header");
    let h1 = el("h1", "");
    h1.set_text_content("todos");
    let new_input = el("input", "new-todo");
    new_input.set_attribute("placeholder", "What needs to be done?");
    listen(&new_input, EventKind::Keydown, TOK_NEW);
    header.append_child(&h1);
    header.append_child(&new_input);

    let main = el("section", "main");
    let toggle_all = el("input", "toggle-all");
    toggle_all.set_attribute("type", "checkbox");
    toggle_all.set_attribute("id", "toggle-all");
    listen(&toggle_all, EventKind::Change, TOK_TOGGLE_ALL);
    let toggle_label = el("label", "");
    toggle_label.set_attribute("for", "toggle-all");
    toggle_label.set_text_content("Mark all as complete");
    let list = el("ul", "todo-list");
    main.append_child(&toggle_all);
    main.append_child(&toggle_label);
    main.append_child(&list);

    let footer = el("footer", "footer");
    let count = el("span", "todo-count");
    let filters = el("ul", "filters");
    let (li_all, link_all) = filter_link("#/", "All");
    let (li_active, link_active) = filter_link("#/active", "Active");
    let (li_completed, link_completed) = filter_link("#/completed", "Completed");
    filters.append_child(&li_all);
    filters.append_child(&li_active);
    filters.append_child(&li_completed);
    let clear = el("button", "clear-completed");
    clear.set_text_content("Clear completed");
    listen(&clear, EventKind::Click, TOK_CLEAR);
    footer.append_child(&count);
    footer.append_child(&filters);
    footer.append_child(&clear);

    todoapp.append_child(&header);
    todoapp.append_child(&main);
    todoapp.append_child(&footer);
    root.append_child(&todoapp);

    app.ui = Some(Ui {
        new_input,
        main,
        toggle_all,
        list,
        count,
        footer,
        link_all,
        link_active,
        link_completed,
        clear,
        items: Vec::new(),
    });
}

fn render(app: &mut App) {
    let editing = app.editing;
    let filter = app.filter;
    let total = app.todos.len();
    let active = app.todos.iter().filter(|t| !t.completed).count();
    let completed = total - active;

    let App {
        ref todos, ref mut ui, ..
    } = *app;
    let ui = ui.as_mut().expect("render before run()");

    // Rebuild the visible list. Clearing textContent detaches the old
    // nodes; dropping the old handles frees the host-side table entries.
    ui.list.set_text_content("");
    ui.items.clear();

    for t in todos.iter().filter(|t| filter.admits(t.completed)) {
        let is_editing = editing == Some(t.id);
        let li_class = match (t.completed, is_editing) {
            (true, true) => "completed editing",
            (true, false) => "completed",
            (false, true) => "editing",
            (false, false) => "",
        };
        let li = el("li", li_class);

        let view = el("div", "view");
        let toggle = el("input", "toggle");
        toggle.set_attribute("type", "checkbox");
        toggle.set_checked(t.completed);
        listen(&toggle, EventKind::Change, item_token(t.id, SLOT_TOGGLE));
        let label = el("label", "");
        label.set_text_content(&t.title);
        listen(&label, EventKind::Dblclick, item_token(t.id, SLOT_LABEL));
        let destroy = el("button", "destroy");
        listen(&destroy, EventKind::Click, item_token(t.id, SLOT_DESTROY));
        view.append_child(&toggle);
        view.append_child(&label);
        view.append_child(&destroy);
        li.append_child(&view);

        let mut edit_input = None;
        if is_editing {
            let edit = el("input", "edit");
            edit.set_value(&t.title);
            listen(&edit, EventKind::Keydown, item_token(t.id, SLOT_EDIT));
            listen(&edit, EventKind::Blur, item_token(t.id, SLOT_EDIT));
            li.append_child(&edit);
            edit_input = Some(edit);
        }

        ui.list.append_child(&li);
        // focus() only works on connected elements: it must come after the
        // li joins the document, not at creation time.
        if let Some(edit) = edit_input {
            edit.focus();
        }
        ui.items.push(li);
    }

    ui.count.set_text_content(&format!(
        "{} item{} left",
        active,
        if active == 1 { "" } else { "s" }
    ));
    ui.toggle_all.set_checked(total > 0 && active == 0);

    ui.main
        .set_attribute("class", if total == 0 { "main hidden" } else { "main" });
    ui.footer.set_attribute(
        "class",
        if total == 0 { "footer hidden" } else { "footer" },
    );
    ui.clear.set_attribute(
        "class",
        if completed == 0 {
            "clear-completed hidden"
        } else {
            "clear-completed"
        },
    );

    ui.link_all
        .set_attribute("class", if filter == Filter::All { "selected" } else { "" });
    ui.link_active.set_attribute(
        "class",
        if filter == Filter::Active { "selected" } else { "" },
    );
    ui.link_completed.set_attribute(
        "class",
        if filter == Filter::Completed { "selected" } else { "" },
    );
}

// --- update ------------------------------------------------------------------

fn add_todo(app: &mut App, title: String) {
    let id = app.next_id;
    app.next_id += 1;
    app.todos.push(Todo {
        id,
        title,
        completed: false,
    });
}

fn commit_edit(app: &mut App, id: u32, value: Option<String>) {
    if app.editing != Some(id) {
        return; // already committed/cancelled (e.g. Enter then blur)
    }
    app.editing = None;
    let title = value.unwrap_or_default().trim().to_string();
    if title.is_empty() {
        app.todos.retain(|t| t.id != id);
    } else if let Some(t) = app.todos.iter_mut().find(|t| t.id == id) {
        t.title = title;
    }
    render(app);
}

fn handle_event(app: &mut App, ev: Event) {
    match ev.token {
        TOK_NEW => {
            if ev.kind == EventKind::Keydown && ev.key.as_deref() == Some("Enter") {
                let title = ev.value.unwrap_or_default().trim().to_string();
                if !title.is_empty() {
                    add_todo(app, title);
                    app.ui.as_ref().expect("ui").new_input.set_value("");
                    render(app);
                }
            }
        }
        TOK_TOGGLE_ALL => {
            let target = ev.checked.unwrap_or(false);
            for t in &mut app.todos {
                t.completed = target;
            }
            render(app);
        }
        TOK_CLEAR => {
            app.todos.retain(|t| !t.completed);
            render(app);
        }
        t if t >= TOK_ITEM_BASE => {
            let id = (t - TOK_ITEM_BASE) / 4;
            let slot = (t - TOK_ITEM_BASE) % 4;
            match slot {
                SLOT_TOGGLE => {
                    if let Some(todo) = app.todos.iter_mut().find(|t| t.id == id) {
                        todo.completed = ev.checked.unwrap_or(!todo.completed);
                        render(app);
                    }
                }
                SLOT_DESTROY => {
                    if app.editing == Some(id) {
                        app.editing = None;
                    }
                    app.todos.retain(|t| t.id != id);
                    render(app);
                }
                SLOT_LABEL => {
                    if ev.kind == EventKind::Dblclick {
                        app.editing = Some(id);
                        render(app);
                    }
                }
                SLOT_EDIT => match ev.kind {
                    EventKind::Keydown => match ev.key.as_deref() {
                        Some("Enter") => commit_edit(app, id, ev.value),
                        Some("Escape") => {
                            if app.editing == Some(id) {
                                app.editing = None;
                                render(app);
                            }
                        }
                        _ => {}
                    },
                    EventKind::Blur => commit_edit(app, id, ev.value),
                    _ => {}
                },
                _ => {}
            }
        }
        _ => {}
    }
}

// --- component exports ---------------------------------------------------------

struct Component;

impl Guest for Component {
    fn run() {
        APP.with(|a| {
            let mut app = a.borrow_mut();
            build_skeleton(&mut app);
            app.filter = Filter::from_route(&shell::route());
            render(&mut app);
        });
    }

    fn on_event(ev: Event) {
        APP.with(|a| handle_event(&mut a.borrow_mut(), ev));
    }

    fn on_route(route: String) {
        APP.with(|a| {
            let mut app = a.borrow_mut();
            app.filter = Filter::from_route(&route);
            if app.ui.is_some() {
                render(&mut app);
            }
        });
    }
}

export!(Component);
