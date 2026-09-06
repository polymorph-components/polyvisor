//! The drawer state machine: a plain enum and a reducer, no Dioxus, so the
//! only stateful thing in the visor's chrome is testable natively.

/// What the drawer is showing when it is open. M1 has exactly two tenants
/// and no plans for a third, so this is an enum and not an abstraction.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Tenant {
    Apps,
    Settings,
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
    /// a session opening, or closing.
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
}
