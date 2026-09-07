//! The frame-teardown fixture: an app that names a tag the policy refuses.
//!
//! docs/design.md "M1" records the gap this fills — "the frame-teardown
//! integration test waits for a hostile fixture component — M2". Every other
//! app in this repository is well-behaved, so the path from a policy
//! rejection through the receiver's stream abort, `web/frame.ts`'s error
//! report, `shell.close-frame` and `apps.abort` to a `session-ended` event in
//! the strip has never been exercised end to end. This crate is the one input
//! that exercises it.
//!
//! It is not an attack: it is a single `<script>` element, which
//! `web/policy.ts`'s tag table does not contain (`TAGS` has no `script`, and
//! it never will — a producer that could name one would be running code in
//! the frame's realm rather than describing pixels). The frame's CSP would
//! refuse to execute it anyway; the point of the fixture is that the stream
//! never gets that far, because the policy check happens on the
//! `create-element` op before the element is ever attached.
//!
//! Ships only from `deno task build:fixtures`; the production site build does
//! not carry it (`web/build.ts`).

use dioxus::prelude::*;

/// Bindings for `polyvisor:app/app` — same shape and same reasons as
/// `apps/todomvc/src/lib.rs`'s, which is the crate this skeleton is copied
/// from. The world is `app`, not the bare stream-dom producer, because
/// `export!` must match what the kernel serves.
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

/// Keeps the root component reachable off the component target, so a native
/// `clippy -D warnings` type-checks it rather than dead-coding it away.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub fn __launch_root() {
    let _ = app;
}

pub fn app() -> Element {
    rsx! {
        // Rendered first so the fixture is legible in a screenshot of a run
        // that somehow got further than it should. Whether it survives to the
        // DOM is undefined and not asserted: the first render is one mutation
        // batch, and a rejection aborts the whole batch.
        div { "about to misbehave" }
        // The refusal. `web/policy.ts` `checkOp` returns `tag <script>` here,
        // which closes the stream and reports a `PolicyError`.
        script { "1" }
    }
}
