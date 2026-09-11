//! The visor world bindings and stream-dom producer exports. This cannot use
//! `stream_dom_dioxus::launch!` because the visor has additional imports; the
//! remaps keep the generated stream and event types identical to the driver.

// WIT annotations decide async lowering; blanket async would incorrectly
// lower synchronous functions.
// `features`: not for this world, which imports nothing unstable — for the
// package. `world runtime` in the same directory imports
// `polymorph:iroh/identity-from-seed`, which is
// `@unstable(feature = guest-ed25519-signing)`, and resolution is
// package-wide: without the feature that import is an unresolvable
// reference and the whole parse fails, whichever world is being generated.
wit_bindgen::generate!({
    path: "../runtime/wit",
    world: "visor",
    features: ["guest-ed25519-signing"],
    with: {
        "polymorph:stream-dom/types@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::types,
        "polymorph:stream-dom/queries@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::queries,
        "polymorph:stream-dom/events@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::events,
        "wasi:random/random@0.3.1": generate,
    },
});

struct Component;

impl Guest for Component {
    async fn run(hydrate: bool) -> stream_dom_dioxus::driver::MutationStream {
        stream_dom_dioxus::driver::run(crate::ui::Visor, hydrate).await
    }

    async fn handle_event(target: EventTarget, name: u32, payload: Vec<u8>, ev: &DomEvent) {
        stream_dom_dioxus::driver::handle_event(target, name, payload, ev).await
    }
}

export!(Component);
