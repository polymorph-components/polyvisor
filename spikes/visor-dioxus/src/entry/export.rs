//! THE SHEET LIVING IN ONE SLIDE, for the two entry tenants.
//!
//! `crate::sheets::Sheet`'s twin, and reached from the same router — a slide
//! whose tenant `super::is_entry_tenant` recognises is grown by the guest
//! rather than left as a leaf awaiting foreign DOM, on the same terms as the
//! visor's own four and the pairing pair. See `sheets/export.rs` for why this
//! lives beside the ceremonies rather than in `component.rs`: that file is
//! the WIT seam for the strip and the drawer host, and the ceremonies are a
//! layer built on it.

use dioxus::prelude::*;

use super::{FIRST_RUN, PICKER};

#[component]
pub fn EntrySheet(tenant: String) -> Element {
    match tenant.as_str() {
        PICKER => rsx! { super::picker::PickerSheet {} },
        FIRST_RUN => rsx! { super::fork::FirstRunSheet {} },
        _ => rsx! {},
    }
}
