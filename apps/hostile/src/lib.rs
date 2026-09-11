//! Test-only fixture that emits a forbidden `<script>` element, exercising
//! policy rejection and frame teardown before the element is attached.

use dioxus::prelude::*;

/// The full app world must match what the kernel serves.
#[cfg(target_arch = "wasm32")]
#[allow(clippy::empty_docs)]
mod bindings {
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

/// Keep the fixture type-checked by native clippy.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub fn __launch_root() {
    let _ = app;
}

pub fn app() -> Element {
    rsx! {
        div { "about to misbehave" }
        script { "1" }
    }
}
