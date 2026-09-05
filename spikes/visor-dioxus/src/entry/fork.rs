//! THE FIRST-RUN FORK (`offerFirstRun`, entry.ts:529-705): no account on this
//! device yet, so start a new one or recover an existing one.
//!
//! # SCOPE NOTE, traced to the dispatch rather than to the source file
//!
//! `entry.ts`'s fork has THREE choices — new account, join an account this
//! user already has on another device, and restore from a recovery kit — and
//! all three are here.
//!
//! The join choice was dropped when this module was first written, because
//! the pairing ceremony it hands to belonged to another agent at the time.
//! That was a scope omission rather than a decision: for a user who already
//! has an account, joining IS the ordinary path, and a fork that offers only
//! "new account" and "restore" pushes them toward starting a second account —
//! the one outcome this screen exists to prevent. It is now wired to
//! `crate::pairing::export::request_join_from_entry`, the same door the
//! `pairing` export uses, so the two callers cannot drift.
//!
//! ONE STRUCTURAL DIFFERENCE REMAINS, and it is an improvement rather than a
//! loss. entry.ts mounted the join pane INSIDE this sheet
//! (:576-578's `joinContainer`/`mountJoinPane`, :636-637's `phase === "join"`
//! branch), which is why it needed the `MutationObserver` at :685-693 to
//! re-measure as the pane advanced through its own screens. Here the join
//! choice HANDS OVER to a tenant of its own, so the drawer's ordinary
//! precedence does the eviction and `pairing`'s `Frame` does the measuring —
//! there is no nested pane to observe.
//!
//! # WHY IT IS NOT EXCLUSIVE, AND IS SUSPENDABLE (entry.ts:540-563)
//!
//! The fork is the RESTING STATE of an account-less device, not a one-shot
//! ceremony: there is nothing else for the device to be doing, and the user
//! may legitimately want to go elsewhere first — the settings sheet, to set
//! their own name before creating the account it will be stamped on. An
//! exclusive tenant would refuse that outright; suspension is exactly right
//! instead, the same grammar `crate::pairing`'s specs use.
//!
//! # NO RESIZE MACHINERY NEEDED
//!
//! Unlike the picker, this sheet's shape does not change under the user's
//! hand in a way `SheetRoot`'s one-shot measurement misses: `supports_restore`
//! is a sync host query fixed at mount (so the restore button's presence is
//! decided once, before the first paint), and the only other height-changing
//! event — a failed `newAccount` showing a message — lands in `.cred-reason`,
//! which `crate::sheets::naming`/`settings`/`reset` all render unconditionally
//! for the identical reason: the class reserves its own space
//! (visor.css:735), so a refusal appearing does not move anything.

use dioxus::prelude::*;

use super::{close, owns, FIRST_RUN};
use crate::component::polymorph::visor_spike::entry_host as host;
use crate::sheets::SheetRoot;

#[component]
pub fn FirstRunSheet() -> Element {
    let mut busy = use_signal(|| false);
    let mut reason = use_signal(String::new);
    // READ ONCE PER MOUNT — a sync host query, fixed for the ceremony's whole
    // life (naming.rs's `use_hook` idiom, same reason).
    let supports_restore = use_hook(host::supports_restore);

    let new_account = move |_| {
        if !owns(FIRST_RUN) || *busy.read() {
            return;
        }
        busy.set(true);
        reason.set(String::new());
        crate::component::spawn(async move {
            let result = host::new_account().await;
            if !owns(FIRST_RUN) {
                return;
            }
            match result {
                Ok(()) => close(FIRST_RUN, true),
                Err(message) => {
                    busy.set(false);
                    reason.set(message);
                }
            }
        });
    };

    // Opening the join ceremony evicts this one through the ordinary drawer
    // precedence, so there is nothing to close by hand and no `busy` to set:
    // this hands over rather than awaiting a result.
    let join_account = move |_| {
        crate::pairing::export::request_join_from_entry();
    };

    let restore = move |_| {
        if !owns(FIRST_RUN) || *busy.read() {
            return;
        }
        // THE HANDOVER, entry.ts:644-651's ordering: close first, then call.
        // The fork gives up the drawer before a ceremony that needs it can
        // open, and closing first means a host whose ceremony throws
        // immediately cannot leave two sheets contending for the same slot.
        busy.set(true);
        close(FIRST_RUN, true);
        crate::component::spawn(async move {
            let _ = host::restore().await;
        });
    };

    rsx! {
        SheetRoot { tenant: FIRST_RUN.to_string(), class: "cred-sheet",
            h2 { "This device has no account yet" }

            div { class: "entry-choice",
                button {
                    r#type: "button",
                    id: "solo-new-account",
                    disabled: *busy.read(),
                    onclick: new_account,
                    "New account"
                }
                p { class: "entry-note",
                    "Start fresh here. This device becomes the first device of a new account, and you can add more devices to it later."
                }
            }

            // JOIN AN ACCOUNT THIS USER ALREADY HAS, on another device
            // (entry.ts:591-594, :616-620, :669-676). It hands straight to the
            // pairing wave's join ceremony, which is now ported — this choice
            // was dropped in the entry wave because pairing was another
            // agent's territory at the time, and the omission was mine.
            //
            // A PEER OF "NEW ACCOUNT", not a quiet control like restore: for a
            // user who already has an account, this is the ordinary path and
            // starting a second account would be the mistake.
            div { class: "entry-choice",
                button {
                    r#type: "button",
                    id: "solo-join-device",
                    disabled: *busy.read(),
                    onclick: join_account,
                    "Join an account you already have"
                }
                p { class: "entry-note",
                    "You have this account on another device. That device will show you a code, and both screens will show digits for you to compare out loud."
                }
            }

            // THE THIRD CHOICE — see the module header on restore's own
            // reasoning (entry.ts:622-624): a quiet control, not a peer of
            // the choice above. Rendered only when the host has a door
            // (`supports_restore` false renders no control at all rather
            // than an inert one — the same rule the back chevron and the
            // pet icon obey elsewhere in this crate).
            if supports_restore {
                div { class: "entry-choice",
                    button {
                        r#type: "button",
                        id: "solo-restore-account",
                        class: "entry-secondary",
                        disabled: *busy.read(),
                        onclick: restore,
                        "Restore from a recovery kit…"
                    }
                    p { class: "entry-note",
                        "Every device for this account is gone, and you kept a recovery kit — a phrase, or a file and its passphrase. You will need the storage this account syncs through as well."
                    }
                }
            }

            div { class: "cred-reason", "{reason}" }
        }
    }
}
