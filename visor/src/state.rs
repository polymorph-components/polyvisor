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

/// Ordering between a read that takes time and the writes it may race.
///
/// The visor reads kernel state in spawned tasks — `device.status` when
/// Settings opens, `store.devices` during the boot — and a task that starts
/// before a write completes after it. Its answer describes the world as it
/// was *before* the write, so applying it afterwards silently undoes the
/// write. Both of the visor's flakes were exactly this:
///
/// * a `device.status` read spawned by the Settings press landed after the
///   user's set-name had been applied, and put the old name back;
/// * the boot's `boot_drawer` decision — one read of `device.status` and
///   one of `store.devices` — landed after the user had already opened a
///   tenant, and closed the drawer under their hands.
///
/// So a write bumps the generation, and a read carries the generation it
/// began with and applies its result only if nothing was written since.
/// Losing a read is always safe: the next press reads again, and what it
/// reads is newer than what was dropped. Losing a *write* is not, which is
/// why the tie goes to the writer.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) struct Gate {
    writes: u64,
}

/// What a read carries from its start to its completion. Opaque on purpose:
/// the only thing anyone may do with it is hand it back to [`Gate::apply`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Token(u64);

impl Gate {
    /// Start a read. The token is the generation it is answering about.
    pub(crate) fn begin(&self) -> Token {
        Token(self.writes)
    }

    /// A write happened: every read already in flight is now answering
    /// about a world that no longer exists.
    pub(crate) fn bump(&mut self) {
        // Wrapping is not a real case — it would take 2^64 presses — but a
        // silent wrap is still better than a panic in the trusted pixels,
        // and the failure it could cause is one wrongly-applied read.
        self.writes = self.writes.wrapping_add(1);
    }

    /// May a read that began at `token` apply its result?
    pub(crate) fn apply(&self, token: Token) -> bool {
        token.0 == self.writes
    }
}

/// What the sync form should dial, given what is in its box and which
/// device this is.
///
/// Endpoint ids travel by hand — read off one device's screen, typed or
/// pasted into another's — so surrounding whitespace is an artefact of the
/// carrying, not of the id, and is dropped. Two inputs are refused here
/// rather than sent: an empty box (nothing was pasted) and this device's
/// own id (a dial to oneself has no meaning and the kernel's refusal would
/// read as a failure of sync rather than of the paste).
///
// CONTRACT: internal.wit `sync.connect` says nothing about self-dialling;
// refusing it in the visor is the conservative reading — the kernel stays
// free to refuse it too, and this only means the call is never made.
pub(crate) fn dial_target(typed: &str, self_endpoint_id: &str) -> Option<String> {
    let id = typed.trim();
    if id.is_empty() || id == self_endpoint_id.trim() {
        return None;
    }
    Some(id.to_string())
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

    /// A pasted id carries whatever whitespace the carrying added.
    #[test]
    fn dial_target_trims_what_was_pasted() {
        assert_eq!(
            dial_target("  abcd \n", "mine"),
            Some("abcd".to_string()),
            "a pasted id should dial without its whitespace"
        );
    }

    /// The two refusals: nothing typed, and this device itself.
    #[test]
    fn dial_target_refuses_the_empty_box_and_this_device() {
        assert_eq!(dial_target("", "mine"), None);
        assert_eq!(dial_target("   ", "mine"), None);
        assert_eq!(dial_target("mine", "mine"), None);
        assert_eq!(dial_target(" mine ", "mine"), None);
    }

    /// A device whose endpoint is not bound yet has an empty id, and that
    /// must not turn every dial into a self-dial.
    #[test]
    fn dial_target_survives_an_unbound_endpoint() {
        assert_eq!(dial_target("theirs", ""), Some("theirs".to_string()));
        assert_eq!(dial_target("", ""), None);
    }

    /// The quiet case: nothing was written while the read was out, so the
    /// read is the newest thing anyone has and it applies.
    #[test]
    fn gate_applies_a_read_that_raced_nothing() {
        let gate = Gate::default();
        let token = gate.begin();
        assert!(gate.apply(token));
        // Applying twice is not a state change: `apply` only asks.
        assert!(gate.apply(token));
    }

    /// The flake, in miniature: the Settings press spawns a status read,
    /// the user renames the device before it lands, and the read must not
    /// put the old name back.
    #[test]
    fn gate_drops_a_read_that_a_write_overtook() {
        let mut gate = Gate::default();
        let read = gate.begin();
        gate.bump(); // set-name applied locally
        assert!(
            !gate.apply(read),
            "a read that started before a write reports the world before it"
        );
    }

    /// A read started *after* the write is answering about the new world,
    /// so the gate must let it through — otherwise a rename would wedge
    /// every later read.
    #[test]
    fn gate_applies_a_read_begun_after_the_write() {
        let mut gate = Gate::default();
        gate.bump();
        let read = gate.begin();
        assert!(gate.apply(read));
    }

    /// Two reads in flight across one write: the older is dropped, the
    /// newer survives. This is the boot's shape — `status` and then
    /// `store.devices` — against a user who acted in between.
    #[test]
    fn gate_sorts_overlapping_reads_around_a_write() {
        let mut gate = Gate::default();
        let early = gate.begin();
        gate.bump();
        let late = gate.begin();
        assert!(!gate.apply(early));
        assert!(gate.apply(late));
        // A second write drops the survivor too.
        gate.bump();
        assert!(!gate.apply(late));
    }

    /// Writes accumulate: a read is stale after one write and stays stale,
    /// rather than coming back into date on the next one.
    #[test]
    fn gate_never_lets_a_stale_read_come_back() {
        let mut gate = Gate::default();
        let read = gate.begin();
        for _ in 0..5 {
            gate.bump();
            assert!(!gate.apply(read));
        }
    }
}
