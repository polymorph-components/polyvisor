//! The drawer state machine: a plain enum and a reducer, no Dioxus, so the
//! only stateful thing in the visor's chrome is testable natively.

/// What the drawer is showing when it is open. A closed set, so this is an
/// enum and not an abstraction. `Apps`/`Settings` are the strip's own
/// buttons; `Unseal` and `Devices` are ceremonies the boot may raise on its
/// own, and `Devices` is additionally reachable from `Settings`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Tenant {
    Apps,
    Settings,
    Unseal,
    Devices,
}

/// `device.state` from internal.wit, as a plain value: the reducer decides
/// what the drawer does at boot, and that decision must be testable without
/// the component bindings (which exist only on the wasm target).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum DeviceState {
    Fresh,
    Sealed,
    Open,
}

/// `device.tier`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Tier {
    Ephemeral,
    Durable,
}

/// `device.rest`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Rest {
    RestsOpen,
    Passphrase,
}

/// What the drawer must be showing the moment the first `device.status` and
/// `store.devices` answers land.
///
/// Two ceremonies raise themselves, because in both cases the strip alone
/// cannot be acted on: a sealed device has no identity to show and every
/// other kernel call is `unavailable` until `unseal`, and a device that is
/// brand new on an origin that already holds a kept one is far more likely
/// to be a reload that lost its anchor than a deliberate second device.
///
// CONTRACT: the dispatch spells the "brand new" test two ways ("state is
// fresh" and "our status.tier == ephemeral && status.petname == \"\""). The
// conservative reading is the conjunction — all three must hold — so a
// device that is `fresh` but somehow already petnamed keeps its own screen
// rather than being pushed at a picker.
pub(crate) fn boot_drawer(
    state: DeviceState,
    tier: Tier,
    petname: &str,
    others_kept: bool,
) -> Drawer {
    match state {
        DeviceState::Sealed => Drawer::Open(Tenant::Unseal),
        DeviceState::Fresh if tier == Tier::Ephemeral && petname.is_empty() && others_kept => {
            Drawer::Open(Tenant::Devices)
        }
        _ => Drawer::Closed,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Drawer {
    #[default]
    Closed,
    Open(Tenant),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Action {
    /// A strip button for a tenant was pressed.
    Toggle(Tenant),
    /// Something happened that the drawer must get out of the way of —
    /// a session opening, or closing, or a seal opening.
    Close,
}

impl Drawer {
    pub(crate) fn reduce(self, action: Action) -> Drawer {
        match action {
            // The same button again closes: a strip button is a toggle,
            // never a one-way trip, so the strip is always one press from
            // showing nothing but itself.
            Action::Toggle(t) if self == Drawer::Open(t) => Drawer::Closed,
            Action::Toggle(t) => Drawer::Open(t),
            Action::Close => Drawer::Closed,
        }
    }

    pub(crate) fn tenant(self) -> Option<Tenant> {
        match self {
            Drawer::Closed => None,
            Drawer::Open(t) => Some(t),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_tenant_twice_closes() {
        let d = Drawer::default().reduce(Action::Toggle(Tenant::Apps));
        assert_eq!(d, Drawer::Open(Tenant::Apps));
        assert_eq!(d.reduce(Action::Toggle(Tenant::Apps)), Drawer::Closed);
    }

    #[test]
    fn other_tenant_replaces() {
        let d = Drawer::default().reduce(Action::Toggle(Tenant::Apps));
        assert_eq!(
            d.reduce(Action::Toggle(Tenant::Settings)),
            Drawer::Open(Tenant::Settings)
        );
    }

    /// A session opening (and closing) sends `Close`: the app frame gets
    /// the screen, the drawer never covers it.
    #[test]
    fn session_change_closes_the_drawer() {
        for open in [
            Drawer::Open(Tenant::Apps),
            Drawer::Open(Tenant::Settings),
            Drawer::Closed,
        ] {
            assert_eq!(open.reduce(Action::Close), Drawer::Closed);
        }
    }

    #[test]
    fn tenant_reports_what_is_open() {
        assert_eq!(Drawer::Closed.tenant(), None);
        assert_eq!(
            Drawer::Open(Tenant::Settings).tenant(),
            Some(Tenant::Settings)
        );
    }

    /// A sealed device has nothing else it can do: unseal is the login.
    #[test]
    fn sealed_boot_opens_unseal() {
        for tier in [Tier::Ephemeral, Tier::Durable] {
            assert_eq!(
                boot_drawer(DeviceState::Sealed, tier, "study laptop", false),
                Drawer::Open(Tenant::Unseal)
            );
        }
    }

    /// The seal opening is a `Close`: the ceremony is over and the strip is
    /// now painted with a real identity, which is the thing to look at.
    #[test]
    fn unseal_success_closes_the_drawer() {
        assert_eq!(
            Drawer::Open(Tenant::Unseal).reduce(Action::Close),
            Drawer::Closed
        );
    }

    /// A brand-new device on an origin that already holds a kept one is
    /// more likely a lost anchor than a deliberate second device, so the
    /// picker comes to it.
    #[test]
    fn fresh_with_others_kept_opens_devices() {
        assert_eq!(
            boot_drawer(DeviceState::Fresh, Tier::Ephemeral, "", true),
            Drawer::Open(Tenant::Devices)
        );
    }

    /// ...and every weakening of that conjunction leaves the drawer shut.
    #[test]
    fn fresh_alone_or_already_claimed_opens_nothing() {
        assert_eq!(
            boot_drawer(DeviceState::Fresh, Tier::Ephemeral, "", false),
            Drawer::Closed
        );
        assert_eq!(
            boot_drawer(DeviceState::Fresh, Tier::Ephemeral, "here", true),
            Drawer::Closed
        );
        assert_eq!(
            boot_drawer(DeviceState::Fresh, Tier::Durable, "", true),
            Drawer::Closed
        );
        assert_eq!(
            boot_drawer(DeviceState::Open, Tier::Ephemeral, "", true),
            Drawer::Closed
        );
    }

    /// "Other devices" in Settings is an ordinary tenant switch.
    #[test]
    fn devices_is_reachable_from_settings() {
        assert_eq!(
            Drawer::Open(Tenant::Settings).reduce(Action::Toggle(Tenant::Devices)),
            Drawer::Open(Tenant::Devices)
        );
    }
}
