//! The `visor` world: bindings, and the two producer exports.
//!
//! `stream_dom_dioxus::launch!` is deliberately not used: it exports the
//! bare `producer` world, which has none of the visor's kernel imports
//! (m1-context.md "Rust facts"). Instead this world's own `generate!`
//! remaps the three `polymorph:stream-dom` interfaces onto
//! `stream_dom_guest::bindings`, so the `StreamReader<u8>` and `DomEvent`
//! that cross into `stream_dom_dioxus::driver` are the same types the
//! driver was compiled against, and `run`/`handle-event` are two-line
//! delegations.

// No `async:` option, for the reason spelled out in
// `runtime/component/src/component.rs`: one blanket mode lowers WIT-sync
// functions with the async canonical option, which is illegal and only
// wasmtime catches it. Every function in this world is `async func`
// anyway, so following the WIT annotations is both correct today and
// proof against a sync one arriving later.
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
