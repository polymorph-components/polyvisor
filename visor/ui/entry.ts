// THE ENTRY CEREMONIES: how a browser becomes a device with an account.
//
// Two surfaces, and between them they are the whole of the way in:
//
//   - THE DEVICE PICKER — which of this browser's devices this tab is
//     looking at, and the passphrase for it when its rung demands one.
//     It renders BEFORE anything is unsealed.
//   - THE FIRST-RUN FORK — "this device has no account yet": start a new
//     account here, or join one this user already has on another device.
//     It renders after the seal opens, on a device that holds nothing.
//
// WHY THEY ARE DRAWER SHEETS. The user-training rule is that
// identity/account/ceremony UI appears ONLY in visor territory, so that
// "am I typing into the visor?" has one answer a user can learn once and
// apply everywhere. These three were the last surfaces on the solo page
// breaking that rule: they were page furniture below the strip, in the
// page's own light chrome, indistinguishable in kind from anything a
// component could paint into its own rectangle.
//
// The drawer's mechanics are what make the move worth something rather
// than merely tidy. A sheet here is ATTACHED TO THE PINNED STRIP and
// grows by pushing it down, and the page behind it is DIMMED around it.
// A component confined to its own frame can do neither: it cannot dim
// the page outside its own rect, and it cannot move the visor's bar. So
// drawer placement carries a real spatial anti-spoofing property on its
// own, before any colour anchor exists — which matters precisely here,
// because at picker time no colour anchor exists yet (see below).
//
// WHY THE PICKER IS GENERIC. Everything it renders comes from the
// unsealed INDEX, and the index's contents are bounded by
// runtime/PERSISTENCE.md ("The index: what may exist before unseal"):
// device petnames, times, an opaque id and the unseal-policy tag. No
// colour, no name, no icon, no account identifier. So the picker rides
// the UNCLAIMED grey dress — visor.ts's `deferClaim` boots the shell
// without reading a hue, and visor.css's zero-chroma fallback is what
// paints it. That ordering IS the anti-spoofing property: a page
// imitating this screen has nothing of the user's to copy, because at
// this moment neither does the real one. The colour and the name arrive
// together at `visor.claim()`, which is what "unseal success is when the
// visor becomes yours" means in code.
//
// VOICE (visor/README.md's three voices). Everything this module writes
// is FRAMEWORK VOICE — the visor's own headings, notes and refusals —
// except device PETNAMES, which are USER VOICE and are therefore
// rendered plain, unquoted and unplated, exactly as the strip renders
// them. There is no third voice here and there must never be: no
// app-influenced string can reach this module at all. Refusal text comes
// from the HOST (the device store, the consumer's boot code), which is
// on the visor's side of the app seam and speaks with the same authority
// as the visor does — the same boundary visor/ui/pairing.ts's
// `AnnounceSink` note draws. Consequently this file NEVER assigns the
// `foreign` class (check-invariants.sh (h)); `foreignToken` is the only
// door and nothing here has anything to put through it.
//
// THE INVARIANT MARKER (check (i), demo/scripts/check-invariants.sh).
// `mountDevicePicker(` and `offerFirstRun(` are pinned to this file, in
// exactly the pattern check (f) uses for `renderPairingCode(`/
// `renderSas(` next door in pairing.ts: they must be DEFINED only here,
// and must not be REFERENCED in the frame seam or in any guest/panel. A
// component frame has no path to a host-side call, so a hit out there
// would mean the architecture had grown a new seam-crossing path. Check
// (i2) adds the negative half on the markup side: no embedder page may
// carry account-lifecycle markup below the strip any more.

import type { Visor } from "./visor.ts";
import { type AnnounceSink, type JoinPaneHandle, mountJoinPane } from "./pairing.ts";
import type { PairingDriver } from "./pairing-driver.ts";

/** The input-masking type, spelled ONCE (check-invariants.sh (b)): the
 * visor's labels are the visor's own words, and "password" is never one
 * of them — this is the platform's masking token and nothing else. */
const MASKED = { type: "password" } as const;

// --- the device picker -------------------------------------------------------

/** One index row, as the picker may see it. Everything here rests in the
 * clear on disk by design, and nothing else may be added: the index is
 * readable by exactly the adversary the sealing defends against
 * (runtime/PERSISTENCE.md, "The index"). */
export interface DevicePickerRow {
  /** Opaque — non-personal, and never rendered. */
  id: string;
  /** The user's own word for this device; the index rests in the clear,
   * and this is the one thing in it that is the user's vocabulary. */
  petname: string;
  /** 0 = never opened. */
  lastUsed: number;
  /** The index's unseal-policy tag, which PREDICTS the ceremony before
   * anything is attached: true = this row will ask for a passphrase. */
  asksPassphrase: boolean;
  /** The same tag, read for the OTHER ceremony: true = this row will ask
   * for a passkey (runtime/PERSISTENCE.md, "The PRF rung: passkey
   * unseal"). MUTUALLY EXCLUSIVE WITH `asksPassphrase` BY
   * CONSTRUCTION — a policy names exactly ONE ceremony to OFFER, and the
   * offered one is not the only door: a passkey row still reaches the
   * passphrase field through the fallback control below, because rungs
   * are additive and the tag never claimed otherwise. */
  asksPasskey: boolean;
}

/** What a `DevicePickerHost.open` rejection may carry to land a refusal
 * in the sheet. `needsPassphrase` says the refusal is the device asking
 * rather than the device failing, so the sheet reveals the field instead
 * of merely reporting. A rejection that is NOT this shape is still
 * handled — it is reported as its own string — because a host throwing
 * something unexpected must not leave the user staring at a dead sheet. */
export interface PickerRefusal {
  needsPassphrase: boolean;
  message: string;
}

export interface DevicePickerHost {
  /** Open `row`, with `passphrase` once its rung demanded one. Resolve =
   * opened, and this module closes the sheet. Reject with a
   * `PickerRefusal`-shaped value to keep the sheet up and say why. */
  open(row: DevicePickerRow, passphrase?: string): Promise<void>;
  /** Open `row` through its PASSKEY ceremony: the host runs the WebAuthn
   * assertion, derives the key that unwraps the device, and opens it.
   *
   * THE CEREMONY IS THE HOST'S, NOT THE VISOR'S, and that is the seam
   * this optional method exists to keep: `navigator.credentials` is
   * window-only and embedder-side, the visor never touches a credential,
   * and nothing about the device store is imported here. The visor
   * renders the door; the host walks it.
   *
   * Same resolve/reject contract as `open`: resolve = opened and this
   * module closes the sheet; reject with a `PickerRefusal`-shaped value
   * to keep the sheet up and say why (`needsPassphrase: true` reveals
   * the passphrase field — the fallback the record allows for a device
   * that also carries a user-origin rung).
   *
   * OPTIONAL because an embedder may have no passkey path at all; a row
   * that asks for one on such a host is told so plainly rather than
   * silently offered a ceremony nobody will run. */
  openWithPasskey?(row: DevicePickerRow): Promise<void>;
  /** "Set up a new device here." Same resolve/reject contract; a new
   * device never needs a passphrase, so a refusal here is only ever a
   * report. */
  openNew(): Promise<void>;
  /** RESTORE AN ACCOUNT FROM A RECOVERY KIT (runtime/RECOVERY.md,
   * "Restore"). The account outlives its last device, so this door must
   * exist on a browser that holds NO device of that account — which is
   * every browser a real recovery happens on.
   *
   * THE CEREMONY IS THE HOST'S, exactly as `openWithPasskey`'s is, and
   * for a stronger reason: restoring collects a destination, storage
   * credentials, a kit secret and a device name, and drives a
   * multi-stage worker bring-up. None of that is the visor's to know.
   * The visor renders the door; the host walks it.
   *
   * THIS MODULE CLOSES THE PICKER BEFORE CALLING, and does not reopen
   * it. That is a departure from the resolve/reject contract above and
   * it is deliberate: the picker is an EXCLUSIVE drawer tenant, so a
   * ceremony that needs the drawer cannot have it while the picker
   * holds it. The host therefore owns the whole drawer from here on —
   * including putting the user back at a usable entry surface if the
   * restore is abandoned or refused (runtime/RECOVERY.md's ceremony
   * must never wedge the way in). A rejection is not rendered here,
   * because by then there is nothing here to render into.
   *
   * OPTIONAL because an embedder may ship no recovery path at all; the
   * control is simply not drawn on such a host, rather than drawn and
   * then apologised for. */
  restore?(): Promise<void>;
}

/** Read a rejection as a refusal, without trusting its shape. */
function refusalOf(e: unknown): PickerRefusal {
  const r = e as { needsPassphrase?: unknown; message?: unknown };
  const message = typeof r?.message === "string" && r.message !== "" ? r.message : String(e);
  return { needsPassphrase: r?.needsPassphrase === true, message };
}

/**
 * Mount the device picker as a drawer sheet, opened immediately.
 *
 * `opts.problem` pre-reveals the refusal line. It is the AUTO-UNSEAL
 * failure path: a single kept device whose policy permits it is opened
 * with no sheet at all, so when that attempt fails there is no surface
 * for the refusal to land on — the picker arrives already carrying it,
 * rather than arriving blank and leaving the user to re-discover the
 * failure by trying again.
 */
export function mountDevicePicker(
  visor: Visor,
  rows: DevicePickerRow[],
  host: DevicePickerHost,
  opts: { problem?: string } = {},
): { close(): void } {
  const tenant = visor.drawer.tenant<{ root: HTMLElement }>({
    name: "device-picker",
    // EXCLUSIVE: this is the login. Nothing may displace it, and it
    // displaces everything — though in practice there is nothing to
    // displace, since it opens before any other tenant can exist.
    exclusive: true,
    // ARMED: FALSE — a RULING, and the one place in the framework where
    // a secret is typed into an UNARMED sheet.
    //
    // The arming delay defends secret entry against a BAITED MIS-TAP: an
    // app rectangle training rapid taps at the position a visor control
    // is about to appear at, so that the tap meant for the app lands on
    // the visor's consent. That attack needs a live app rectangle to
    // train the tap in. Pre-unseal there is NO component frame on the
    // page at all — no engine, no app, nothing has been instantiated —
    // so the tax would defend nothing and would only teach users to sit
    // through a delay that means something elsewhere.
    //
    // What still holds, and is the part that matters: the passphrase is
    // typed in VISOR PIXELS, in a sheet attached to the pinned strip,
    // over a dimmed page. The geometry is doing the work here; the timer
    // would only be ceremony.
    armed: false,
    dim: true,
    context: () => ({ kind: "device-picker" }),
  });

  // THE PERSISTENT ROOT. The builder returns this SAME element every
  // time, which is what makes `rebuild()` safe to call on every
  // visibility change: a typed passphrase and a revealed section survive
  // the rebuild because the DOM survives it. A builder that constructed
  // a fresh tree would silently clear the field the user is typing into
  // the moment a refusal appeared under it.
  const root = document.createElement("div");
  root.id = "device-picker";
  root.className = "cred-sheet";

  const heading = document.createElement("h2");
  heading.textContent = "Which device is this?";

  const note = document.createElement("p");
  note.className = "cred-note";
  note.textContent = "This browser holds more than one. Pick the one you want to open; " +
    "nothing of yours is shown until it is.";

  const list = document.createElement("div");
  list.id = "device-list";

  const pass = document.createElement("div");
  pass.id = "device-pass";
  pass.hidden = true;
  const passLabelEl = document.createElement("label");
  passLabelEl.htmlFor = "device-pass-input";
  const passFor = document.createElement("span");
  passFor.id = "device-pass-for";
  passLabelEl.append(document.createTextNode("The passphrase for "), passFor);
  const passInput = document.createElement("input");
  passInput.id = "device-pass-input";
  passInput.autocomplete = "off";
  // Never a label, only the masking type — see MASKED.
  passInput.type = MASKED.type;
  const passOpen = document.createElement("button");
  passOpen.type = "button";
  passOpen.id = "device-pass-open";
  passOpen.textContent = "Open this device";
  pass.append(passLabelEl, passInput, passOpen);

  // THE PASSKEY BLOCK — a sibling of the passphrase field, and part of
  // the PERSISTENT ROOT for the same reason it is: it is created once,
  // hidden, and merely revealed, so a rebuild under a refusal cannot
  // wipe the screen the user is mid-ceremony on.
  const passkey = document.createElement("div");
  passkey.id = "device-passkey";
  passkey.hidden = true;
  const passkeyLabelEl = document.createElement("label");
  const passkeyFor = document.createElement("span");
  passkeyFor.id = "device-passkey-for";
  // USER VOICE for the petname, framework voice for the sentence around
  // it — the same shape as the passphrase label above.
  passkeyLabelEl.append(document.createTextNode("The passkey for "), passkeyFor);
  const passkeyOpen = document.createElement("button");
  passkeyOpen.type = "button";
  passkeyOpen.id = "device-passkey-open";
  passkeyOpen.textContent = "Use your passkey";
  // THE FALLBACK, offered unconditionally on a passkey row: the policy
  // tag names the ceremony to OFFER, not the only door
  // (runtime/PERSISTENCE.md, "Unseal"). A device with no user-origin
  // passphrase simply refuses at the host, exactly as a wrong one would.
  const passkeyFallback = document.createElement("button");
  passkeyFallback.type = "button";
  passkeyFallback.id = "device-passkey-fallback";
  passkeyFallback.className = "entry-secondary";
  passkeyFallback.textContent = "use your passphrase instead";
  passkey.append(passkeyLabelEl, passkeyOpen, passkeyFallback);

  const problem = document.createElement("div");
  problem.id = "device-problem";
  problem.className = "entry-problem";
  problem.hidden = true;

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.id = "device-new";
  newBtn.textContent = "Set up a new device here";

  // THE RECOVERY DOOR. Drawn only when the host has one — and drawn
  // WHATEVER `rows` holds, because the question it answers ("all my
  // devices are gone") is independent of what this browser happens to
  // remember. A browser with three unrelated devices in its index is
  // still a browser someone may be recovering an account onto.
  //
  // SECONDARY, not primary: recovery is the rare door, and a control
  // with the same weight as "open this device" would read as an
  // invitation rather than a way out of a disaster.
  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.id = "device-restore";
  restoreBtn.className = "entry-secondary";
  restoreBtn.textContent = "Restore from a recovery kit…";

  root.append(heading, note, list, pass, passkey, problem, newBtn);
  if (host.restore !== undefined) root.append(restoreBtn);

  /** THE HEIGHT IS MEASURED, so every visibility change owes the drawer
   * a re-measure: the sheet animates to a pixel target and clips
   * overflow, so a revealed passphrase field under a stale height is a
   * field the user cannot see. */
  const resize = () => tenant.rebuild();

  let busy = false;

  const showProblem = (text: string) => {
    problem.textContent = text;
    problem.hidden = false;
  };

  const askFor = (row: DevicePickerRow) => {
    // ONE CEREMONY ON SCREEN AT A TIME: revealing the passphrase field
    // is also how the passkey row's fallback is taken, and two doors up
    // at once would be the sheet failing to say which one it is asking
    // for.
    passkey.hidden = true;
    pass.hidden = false;
    // USER VOICE: the petname is the user's own word, said plainly in
    // the visor's sentence — not quoted, not plated.
    passFor.textContent = row.petname;
    passInput.value = "";
    passOpen.onclick = () => void choose(row, passInput.value);
    passInput.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") void choose(row, passInput.value);
    };
    // FOCUS AFTER THE REBUILD, not before: the field is inside a clipped
    // box whose height is about to change, and focusing a not-yet-laid-
    // out control scrolls the sheet to a position that stops making
    // sense a frame later.
    resize();
    passInput.focus();
  };

  const choose = async (row: DevicePickerRow, passphrase?: string) => {
    if (busy) return;
    busy = true;
    problem.hidden = true;
    resize();
    try {
      await host.open(row, passphrase);
      tenant.close();
    } catch (e) {
      busy = false;
      // NOT A DEAD END, and not a guess about why: the host says whether
      // this device is ASKING or FAILING, and only the asking case grows
      // a field.
      const refusal = refusalOf(e);
      showProblem(refusal.message);
      if (refusal.needsPassphrase) askFor(row);
      else resize();
    }
  };

  /** Reveal the passkey ceremony for `row` and wire its two controls.
   *
   * THE BUSY GUARD HAS ONE OWNER HERE. The click handler takes it, and
   * the same handler is the only path that releases it: the host runs
   * the WHOLE open (assertion, derivation, unseal), so there is no
   * nested `choose()` to hand ownership to — and handing it over was
   * precisely how an earlier round left the ceremony permanently
   * no-opping. A second click while an authenticator prompt is pending
   * must not raise a second prompt. */
  const askForPasskey = (row: DevicePickerRow) => {
    pass.hidden = true;
    passkey.hidden = false;
    // USER VOICE: the petname plain, unquoted, as everywhere else.
    passkeyFor.textContent = row.petname;

    passkeyOpen.onclick = () => {
      // AN EMBEDDER THAT CANNOT: honest degrade rather than a silent
      // swap to a ceremony the user did not ask for. The row's policy
      // says "passkey"; this host has no passkey path; the sheet says
      // exactly that and stays where it is. The fallback control below
      // is still there for a user who does know this device's
      // passphrase.
      if (host.openWithPasskey === undefined) {
        showProblem("this page cannot open devices with a passkey");
        resize();
        return;
      }
      if (busy) return;
      busy = true;
      problem.hidden = true;
      resize();
      void host.openWithPasskey(row).then(() => {
        tenant.close();
      }, (e: unknown) => {
        busy = false;
        // NOT A DEAD END: the button stays clickable (a cancelled or
        // refused ceremony is a thing to try again), and only a refusal
        // that says the device wants its passphrase grows the field.
        const refusal = refusalOf(e);
        showProblem(refusal.message);
        if (refusal.needsPassphrase) askFor(row);
        else resize();
      });
    };

    passkeyFallback.onclick = () => {
      // BUSY-GATED: the screen must not be swapped out from under a
      // pending authenticator prompt.
      if (busy) return;
      askFor(row);
    };

    // MEASURE AFTER THE REVEAL, before anything else (askFor's ordering,
    // and its reason: the block lives in a clipped box whose height just
    // changed). Nothing here takes focus — the interaction the user
    // asked for is a button press, not typing.
    resize();
  };

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "device-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "device-pick";
    btn.dataset.petname = row.petname;
    btn.textContent = row.petname;
    const when = document.createElement("span");
    when.className = "device-when";
    // TIMES ARE INDEX CONTENT and nothing more; there is no account, no
    // colour and no name to render beside them.
    when.textContent = row.lastUsed > 0
      ? `last used ${new Date(row.lastUsed).toLocaleString()}`
      : "never used";
    item.append(btn, when);
    list.append(item);
    btn.onclick = () => {
      if (row.asksPasskey) askForPasskey(row);
      else if (row.asksPassphrase) askFor(row);
      else void choose(row);
    };
  }

  newBtn.onclick = () => {
    if (busy) return;
    busy = true;
    problem.hidden = true;
    resize();
    host.openNew().then(() => {
      tenant.close();
    }, (e: unknown) => {
      busy = false;
      showProblem(refusalOf(e).message);
      resize();
    });
  };

  if (opts.problem !== undefined && opts.problem !== "") showProblem(opts.problem);

  // THE HANDOVER (see `DevicePickerHost.restore`): close first, then
  // call. The picker is exclusive, so the drawer has to be given up
  // before a ceremony that needs it can open — and closing first also
  // means a host whose ceremony throws immediately cannot leave two
  // sheets contending for the same slot.
  restoreBtn.onclick = () => {
    if (busy) return;
    const run = host.restore;
    if (run === undefined) return;
    busy = true;
    tenant.close();
    void run();
  };

  tenant.open({ root }, () => ({ root }));

  return {
    close() {
      if (tenant.isOpen()) tenant.close();
    },
  };
}

// --- the first-run fork ------------------------------------------------------

export interface FirstRunHost {
  /** Create the account this device is the first device of. Resolve =
   * created, and this module closes the sheet. Reject to re-enable the
   * fork and show the message on it. */
  newAccount(): Promise<void>;
  /** RESTORE AN ACCOUNT FROM A RECOVERY KIT — the same door the picker
   * carries, on the surface a VIRGIN BROWSER actually lands on.
   *
   * WHY IT IS HERE AS WELL, and this is the important half: a browser
   * with no devices never sees the picker at all (the first-run path
   * makes a device without asking — PERSISTENCE.md's try-then-keep), and
   * a browser with no devices is exactly the browser a real recovery
   * happens on. A recovery door that only appeared once you already had
   * a device would be a door on the wrong side of the disaster.
   *
   * Same handover contract as `DevicePickerHost.restore`: this module
   * closes the fork before calling and does not reopen it; the host owns
   * the drawer, the ceremony, and returning the user to a usable
   * surface. OPTIONAL for the same reason. */
  restore?(): Promise<void>;
}

/**
 * Offer the fork as a drawer sheet, opened immediately, with the JOIN
 * pane wired behind its second choice.
 *
 * The returned `joinHandle` is the caller's to drive: the pane advances
 * on a poll (`tick()`), and the caller owns the poll loop because the
 * caller owns everything that has to happen after enrollment — the sync
 * path, and the adoption of the account's profile once that path has
 * delivered the account's document (see `mountJoinPane`).
 */
export function offerFirstRun(
  visor: Visor,
  driver: PairingDriver,
  status: AnnounceSink,
  host: FirstRunHost,
): { joinHandle: JoinPaneHandle; close(): void } {
  const tenant = visor.drawer.tenant<{ root: HTMLElement }>({
    name: "first-run",
    // NOT EXCLUSIVE, and SUSPENDABLE — a RULING, and the pair goes
    // together.
    //
    // The fork is not a one-shot ceremony; it is the RESTING STATE of an
    // account-less device. There is nothing else for this device to be
    // doing, and the user may legitimately want to go somewhere else
    // first — most obviously the settings sheet, to set their own name
    // BEFORE creating the account it will be stamped on. An exclusive
    // tenant would refuse that outright; a non-suspendable one would
    // destroy the fork to allow it and never bring it back, leaving a
    // device with no account and no offer to make one.
    //
    // Suspension is exactly right instead: the fork slides out, the
    // settings sheet takes the drawer, and the fork slides back when it
    // closes — the same grammar the storage picker's detour uses.
    exclusive: false,
    // ARMED: FALSE. Nothing secret is typed on the fork, and neither
    // choice spends anything irreversibly — the same weight-class
    // judgement the naming sheet makes.
    armed: false,
    dim: true,
    suspendable: () => true,
    context: () => ({ kind: "first-run" }),
  });

  const root = document.createElement("div");
  root.id = "first-run";
  root.className = "cred-sheet";

  /** THE JOIN PANE'S CONTAINER, created ONCE and kept whether it is
   * attached or not. `mountJoinPane` renders its own entry button into
   * it and owns everything inside it from then on — the code, the SAS,
   * the confirm — so this module never draws a pairing code and the
   * check (f) marker stays where it belongs, in pairing.ts. Mounting
   * eagerly costs nothing visible: nothing is on screen until the sheet
   * adopts the container. */
  const joinContainer = document.createElement("div");
  joinContainer.id = "solo-join";
  const joinHandle = mountJoinPane(joinContainer, driver, status);

  let phase: "fork" | "join" = "fork";

  const problem = document.createElement("div");
  problem.className = "entry-problem";
  problem.hidden = true;

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.id = "solo-new-account";
  newBtn.textContent = "New account";

  const joinBtn = document.createElement("button");
  joinBtn.type = "button";
  joinBtn.id = "solo-join-account";
  joinBtn.textContent = "Join another device";

  const choice = (button: HTMLButtonElement, noteText: string) => {
    const wrap = document.createElement("div");
    wrap.className = "entry-choice";
    const note = document.createElement("p");
    note.className = "entry-note";
    note.textContent = noteText;
    wrap.append(button, note);
    return wrap;
  };

  const forkHeading = document.createElement("h2");
  forkHeading.textContent = "This device has no account yet";
  const joinHeading = document.createElement("h2");
  joinHeading.textContent = "Join another device";

  const newChoice = choice(
    newBtn,
    "Start fresh here. This device becomes the first device of a new account, and you " +
      "can add more devices to it later.",
  );
  const joinChoice = choice(
    joinBtn,
    "You already have this account on another device. This one shows a code; you enter " +
      "it there, and both of you check the same six digits.",
  );

  // THE THIRD CHOICE — see `FirstRunHost.restore`. Rendered as a quiet
  // control rather than a third peer of the two above: it is the answer
  // to a disaster, not a way to start.
  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.id = "solo-restore-account";
  restoreBtn.className = "entry-secondary";
  restoreBtn.textContent = "Restore from a recovery kit…";
  const restoreChoice = choice(
    restoreBtn,
    "Every device for this account is gone, and you kept a recovery kit — a phrase, or a " +
      "file and its passphrase. You will need the storage this account syncs through as well.",
  );

  const build = () => {
    if (phase === "join") root.replaceChildren(joinHeading, joinContainer);
    else if (host.restore !== undefined) {
      root.replaceChildren(forkHeading, newChoice, joinChoice, restoreChoice, problem);
    } else root.replaceChildren(forkHeading, newChoice, joinChoice, problem);
    return { root };
  };

  restoreBtn.onclick = () => {
    const run = host.restore;
    if (run === undefined) return;
    // Close first, then call — the handover the picker's door makes, for
    // the same reason: the ceremony needs the drawer this sheet is in.
    tenant.close();
    void run();
  };

  newBtn.onclick = () => {
    newBtn.disabled = true;
    joinBtn.disabled = true;
    problem.hidden = true;
    tenant.rebuild();
    host.newAccount().then(() => {
      tenant.close();
    }, (e: unknown) => {
      newBtn.disabled = false;
      joinBtn.disabled = false;
      problem.textContent = refusalOf(e).message;
      problem.hidden = false;
      tenant.rebuild();
    });
  };

  joinBtn.onclick = () => {
    phase = "join";
    tenant.rebuild();
    // The join pane draws its OWN entry button; this click is the
    // user's, forwarded — so the ceremony still starts from visor pixels
    // and this module still never renders a code.
    (joinContainer.querySelector("button") as HTMLButtonElement | null)?.click();
  };

  // THE PANE MUTATES ITSELF as the ceremony advances (entry → waiting →
  // SAS → joined), and every one of those is a shape change the drawer's
  // measured height knows nothing about. Watching the container is the
  // cheap, complete answer: whatever pairing.ts does in there, the sheet
  // re-measures a frame later. A slightly-tall sheet is a cosmetic
  // nuisance; a CLIPPED SAS is a user comparing six digits they cannot
  // see, so the bias is deliberate.
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending !== 0) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (phase === "join" && tenant.isOpen()) tenant.rebuild();
    });
  });
  observer.observe(joinContainer, { childList: true, subtree: true });

  tenant.open({ root }, build);

  return {
    joinHandle,
    close() {
      observer.disconnect();
      if (pending !== 0) cancelAnimationFrame(pending);
      if (tenant.isOpen()) tenant.close();
    },
  };
}
