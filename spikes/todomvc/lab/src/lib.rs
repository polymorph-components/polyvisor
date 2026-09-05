//! Lab guest: instrumentation for the backend differential harness and
//! the churn benchmark (polymorph-apps#15, fast-path plan).
//!
//! `probe(id)` attempts one surface violation per id (id 0 is the legal
//! baseline; id 7 makes a visible legal mutation *before* violating, to
//! pin the "ops emitted before a trap are applied" rule). `bench` drives
//! js-framework-benchmark-style row churn.

use std::cell::RefCell;

wit_bindgen::generate!({
    path: "../wit",
    world: "lab",
    // `generate_all`: the surface interfaces now live in a DEPENDENCY
    // package (`polyvisor:surface@0.1.0`, symlinked at ../wit/deps), and
    // wit-bindgen does not generate bindings for a dep unless told to —
    // it demands either this or a `with:` mapping per interface. Bindings
    // for all three are wanted here, so this is the one-word form.
    generate_all,
});

use crate::polyvisor::surface::dom::{create_element, create_text_node, Element};
use crate::polyvisor::surface::shell;

thread_local! {
    static LIST: RefCell<Option<Element>> = const { RefCell::new(None) };
    static ROWS: RefCell<Vec<(Element, Element)>> = const { RefCell::new(Vec::new()) };
}

fn with_list<R>(f: impl FnOnce(&Element) -> R) -> R {
    LIST.with(|l| {
        let mut l = l.borrow_mut();
        if l.is_none() {
            let ul = create_element("ul");
            ul.set_attribute("class", "rows");
            shell::root().append_child(&ul);
            *l = Some(ul);
        }
        f(l.as_ref().unwrap())
    })
}

struct Component;

impl Guest for Component {
    fn probe(id: u32) {
        match id {
            // Legal baseline: must succeed and leave visible DOM.
            0 => {
                let d = create_element("div");
                d.set_attribute("class", "ok");
                d.set_text_content("legal");
                shell::root().append_child(&d);
            }
            // Tag allowlist violations.
            1 => {
                create_element("script");
            }
            2 => {
                create_element("iframe");
            }
            // URL laundering: absolute href must be rejected.
            3 => {
                let a = create_element("a");
                a.set_attribute("href", "https://attacker.example/x");
            }
            // Per-(tag, attribute) value validation.
            4 => {
                let i = create_element("input");
                i.set_attribute("type", "file");
            }
            // Event-handler content attributes are not in any allowlist.
            5 => {
                let d = create_element("div");
                d.set_attribute("onclick", "1");
            }
            // IDL-attribute setters are input-only.
            6 => {
                let d = create_element("div");
                d.set_value("x");
            }
            // Visible legal mutation, THEN a violation: backends must agree
            // that the pre-trap ops landed.
            7 => {
                let d = create_element("div");
                d.set_attribute("class", "pre-trap");
                d.set_text_content("before the trap");
                shell::root().append_child(&d);
                let a = create_element("a");
                a.set_attribute("href", "http://attacker.example/y");
            }
            // Text-node op restrictions.
            8 => {
                let t = create_text_node("x");
                t.set_attribute("class", "nope");
            }
            9 => {
                let t = create_text_node("x");
                let d = create_element("div");
                t.append_child(&d);
            }
            _ => {}
        }
    }

    fn bench(scenario: u32, n: u32) {
        match scenario {
            // Create n rows: li(class) > span(text), tracked for updates.
            1 => with_list(|list| {
                ROWS.with(|rows| {
                    let mut rows = rows.borrow_mut();
                    for i in 0..n {
                        let li = create_element("li");
                        li.set_attribute("class", if i % 2 == 0 { "even" } else { "odd" });
                        let span = create_element("span");
                        span.set_text_content(&format!("row {i}"));
                        li.append_child(&span);
                        list.append_child(&li);
                        rows.push((li, span));
                    }
                });
            }),
            // Update every 10th row (text + class).
            2 => ROWS.with(|rows| {
                for (i, (li, span)) in rows.borrow().iter().enumerate() {
                    if i % 10 == 0 {
                        span.set_text_content(&format!("row {i} updated"));
                        li.set_attribute("class", "hot");
                    }
                }
            }),
            // Clear.
            3 => {
                with_list(|list| list.set_text_content(""));
                ROWS.with(|rows| rows.borrow_mut().clear());
            }
            _ => {}
        }
    }
}

export!(Component);
