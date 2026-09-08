//! The drawer state machine: a plain enum and a reducer, no Dioxus, so the
//! only stateful thing in the visor's chrome is testable natively.

/// What the drawer is showing when it is open. A closed set, so this is an
/// enum and not an abstraction. `Apps`/`AppInfo` are what the strip's left
/// half raises and `Settings` what its right half does; `Unseal` and
/// `Devices` are ceremonies the boot may raise on its own, and `Devices` is
/// additionally reachable from `Settings`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Tenant {
    Apps,
    AppInfo,
    Settings,
    Unseal,
    Devices,
}

impl Tenant {
    /// Where this tenant sits on the one axis the drawer slides along, so a
    /// switch has a direction: a sheet reached from the strip's left half
    /// enters from the left of one reached from its right half, and
    /// "Other devices" — reached from Settings — enters from the right of
    /// it. Ties (`Apps`/`AppInfo`, which are the same half) slide the same
    /// way as any other rightward move; only the sign is read.
    pub(crate) fn ordinal(self) -> u8 {
        match self {
            Tenant::Apps | Tenant::AppInfo => 0,
            Tenant::Settings | Tenant::Unseal => 1,
            Tenant::Devices => 2,
        }
    }
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
/// `Closed` here means "no ceremony to raise", not "show nothing": the
/// caller runs the result through [`Drawer::reduce`] with the pinned flag,
/// which at boot — nothing is running yet — rests it on the app list.
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

/// `types.phase` from internal.wit, as a plain value: what a pairing
/// ceremony is doing right now. A copy rather than the generated type for
/// the same reason [`DeviceState`] is one — the bindings exist only on the
/// wasm target, and the rendering decisions this drives have to be
/// testable natively.
///
/// The kernel is the only authority on it. The visor never advances it on
/// its own guess about what a button did: every act re-reads
/// `pairing.status`, and the kernel additionally pushes
/// `events.pairing-changed` on every transition (including the ones the
/// *other* device caused, which is the only way they could arrive — this
/// world has no timer, and `pairing.status` may not park).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub(crate) enum Phase {
    #[default]
    Idle,
    /// Joiner: showing this code.
    Offering(String),
    /// Adder: dialing and claiming.
    Claiming,
    /// Both: the six digits to compare.
    AwaitingConfirm(String),
    /// Confirmed here; the other side has not.
    AwaitingPeer,
    Done,
    /// Framework voice.
    Failed(String),
}

/// A pairing code as it is shown: groups of four, separated by spaces.
///
/// The code is 79 characters of visual base32 (the M3b pairing contract
/// §1) and is read aloud or typed across from one screen to another, so
/// the grouping is what makes losing one's place recoverable. It is
/// display only — [`claim_code`] undoes it, and the kernel never sees a
/// space.
pub(crate) fn grouped(code: &str) -> String {
    let mut out = String::with_capacity(code.len() + code.len() / 4);
    for (i, c) in code.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

/// What to claim, given what is in the box.
///
/// All whitespace is dropped, not merely trimmed: the code is *shown* in
/// groups of four, so a user who typed what they saw typed spaces, and a
/// user who copied it copied them. An empty box is refused here rather
/// than sent, so the kernel's "that is not a code" is never the answer to
/// a press on an empty field.
///
// CONTRACT: internal.wit `pairing.claim` says nothing about the code's
// spelling beyond what the pairing contract fixes (visual base32, no
// padding). Stripping whitespace is the conservative normalisation — it
// removes only what this visor itself inserted; case and every other
// character are left for the kernel to judge.
pub(crate) fn claim_code(typed: &str) -> Option<String> {
    let code: String = typed.chars().filter(|c| !c.is_whitespace()).collect();
    (!code.is_empty()).then_some(code)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Drawer {
    #[default]
    Closed,
    Open(Tenant),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Action {
    /// A half of the strip was pressed, or a sheet sent the user on. Never
    /// closes: showing what is already shown is identity, so the drawer is
    /// not a toggle any more and a press can never leave the user looking
    /// at nothing.
    Show(Tenant),
    /// Something happened that the drawer must get out of the way of — a
    /// session opening, or closing, a seal opening, or the scrim pressed.
    Close,
}

impl Drawer {
    /// `pinned` is "nothing is running": with no app on screen there is
    /// nothing for the drawer to be in the way of, so the app list is what
    /// the visor rests at and `Closed` is not a state it can reach. With a
    /// session running the app owns the screen and `Close` means it.
    pub(crate) fn reduce(self, action: Action, pinned: bool) -> Drawer {
        let rest = if pinned {
            Drawer::Open(Tenant::Apps)
        } else {
            Drawer::Closed
        };
        match action {
            Action::Show(t) if self == Drawer::Open(t) => self,
            Action::Show(t) => Drawer::Open(t),
            Action::Close => rest,
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

    /// Showing what is already shown is identity: a press on the half of
    /// the strip whose sheet is open must not shut it, or the drawer would
    /// flicker every time a user pressed the thing they were reading.
    #[test]
    fn showing_the_open_tenant_changes_nothing() {
        for pinned in [true, false] {
            let d = Drawer::Open(Tenant::Apps);
            assert_eq!(d.reduce(Action::Show(Tenant::Apps), pinned), d);
        }
    }

    #[test]
    fn other_tenant_replaces() {
        let d = Drawer::default().reduce(Action::Show(Tenant::Apps), true);
        assert_eq!(
            d.reduce(Action::Show(Tenant::Settings), true),
            Drawer::Open(Tenant::Settings)
        );
    }

    /// Nothing running: the app list is where the drawer rests, so a close
    /// lands there and `Closed` is not reachable at all.
    #[test]
    fn pinned_close_opens_the_app_list() {
        for from in [
            Drawer::Open(Tenant::Settings),
            Drawer::Open(Tenant::Devices),
            Drawer::Open(Tenant::Unseal),
            Drawer::Closed,
        ] {
            assert_eq!(
                from.reduce(Action::Close, true),
                Drawer::Open(Tenant::Apps),
                "pinned close from {from:?}"
            );
        }
    }

    /// A session opening (and closing) sends `Close`: the app frame gets
    /// the screen, the drawer never covers it.
    #[test]
    fn unpinned_close_shuts_the_drawer() {
        for open in [
            Drawer::Open(Tenant::Apps),
            Drawer::Open(Tenant::AppInfo),
            Drawer::Open(Tenant::Settings),
            Drawer::Closed,
        ] {
            assert_eq!(open.reduce(Action::Close, false), Drawer::Closed);
        }
    }

    /// The slide direction is a sign, and it has to be the one the strip
    /// implies: the left half's sheets sit left of the right half's, and
    /// "Other devices" sits right of Settings, which is where it is
    /// reached from.
    #[test]
    fn ordinals_order_the_sheets_left_to_right() {
        assert_eq!(Tenant::Apps.ordinal(), Tenant::AppInfo.ordinal());
        assert!(Tenant::Apps.ordinal() < Tenant::Settings.ordinal());
        assert_eq!(Tenant::Unseal.ordinal(), Tenant::Settings.ordinal());
        assert!(Tenant::Settings.ordinal() < Tenant::Devices.ordinal());
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
    /// now painted with a real identity. Nothing is running at that moment,
    /// so what the drawer rests at is the app list.
    #[test]
    fn unseal_success_rests_on_the_app_list() {
        assert_eq!(
            Drawer::Open(Tenant::Unseal).reduce(Action::Close, true),
            Drawer::Open(Tenant::Apps)
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
            Drawer::Open(Tenant::Settings).reduce(Action::Show(Tenant::Devices), true),
            Drawer::Open(Tenant::Devices)
        );
    }

    /// The code is shown in groups of four so a person can keep their place
    /// while reading it across to another device.
    #[test]
    fn grouped_breaks_the_code_into_fours() {
        assert_eq!(grouped("ABCDEFGHIJ"), "ABCD EFGH IJ");
        assert_eq!(grouped("ABCD"), "ABCD");
        assert_eq!(grouped(""), "");
    }

    /// What the grouping put in, the claim takes out — including whatever
    /// a copy-paste or a typist added.
    #[test]
    fn claim_code_undoes_the_grouping() {
        assert_eq!(
            claim_code(" ABCD EFGH\n IJ "),
            Some("ABCDEFGHIJ".to_string())
        );
        assert_eq!(
            claim_code(&grouped("ABCDEFGHIJ")),
            Some("ABCDEFGHIJ".into())
        );
    }

    /// An empty box is not a claim: the press does nothing the kernel has
    /// to compose a refusal for.
    #[test]
    fn claim_code_refuses_an_empty_box() {
        assert_eq!(claim_code(""), None);
        assert_eq!(claim_code("  \t\n "), None);
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
