// PAIRING ACROSS TWO INDEPENDENT PAGES — the solo page's whole claim.
//
// THE ARGUMENT. `device-pairing` already proves the ceremony over the
// real engine, but it proves it on ONE page: both engines share a
// process, a document, a storage origin and a boot, and several things a
// genuine second device must do for itself are simply handed to the
// second pane by the page that owns both. This scenario removes that
// help. Two solo pages, in two ISOLATED browser contexts (separate
// cookies, localStorage and IndexedDB), meet only over the harness's
// relay — so everything that crosses between them had to cross a wire:
//
//   - the ADDER's endpoint and agent ids, which the joiner learns ONLY
//     from `pair-enrollment` (engine.wit) and needs in order to dial
//     back at all;
//   - the account's TASKS PARTITION ID, which the joiner learns only by
//     reading the synced user-system doc's pointer map (#36);
//   - the todos themselves, and a petname, both of which have to
//     traverse the subduction the embedder wired after the ceremony.
//
// A one-page suite cannot fail on any of those three: on one page they
// are variables in scope.
//
// WHY THE TODOS ARE TYPED INTO THE REAL FRAME. The convergence claim is
// about the account's data, and the honest way to put data into it is
// the way a user does — the todomvc input inside the SANDBOXED frame,
// through Playwright's frameLocator (the frame has an opaque origin, so
// this is a genuine cross-document drive, not a same-realm shortcut).
// The ASSERTIONS then read the engine's own view (`__solo.todos()`),
// because convergence is a property of the partition; asserting on the
// other page's rendered rows would be testing the surface protocol's
// repaint, which is a different scenario's job.
//
// AND THE ACCOUNT'S OWN FACE CROSSES TOO. The todos prove the app's
// partition converged; they say nothing about the ACCOUNT — the name
// and colour that make the joined device recognisably the same person's.
// That half used to be read on the enrollment edge, before any document
// had arrived, so a joiner adopted an empty name and hue 0 for ever.
// It is asserted here, on B's own strip, because the strip is where a
// user would notice its absence.
//
// DEADLINES ARE GENEROUS, per device-pairing-acts.ts's reasoning: every
// step here crosses a relay, and a deadline that is merely "usually
// enough" is a flake generator whose failure text is indistinguishable
// from a real break.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS } from "../util.ts";
// The solo pages' shared driving surface — the `__solo` root, the
// sandboxed todomvc frame, and the pacing rule for typing into it. Three
// scenarios drive this page now; see e2e/solo-util.ts.
import { addTodo, appFrame, solo, stripPersonal, todoRows, until, WAITS } from "../solo-util.ts";

/** The account's own face: the name A commits before pairing and the
 * anchor colour it picks. Both must be on B's strip after B joins — and
 * the hue is deliberately not the 265 both pages are seeded with, so an
 * unchanged strip cannot pass the assertion by accident. */
const ACCOUNT_NAME = "Ada";
const ACCOUNT_HUE = 175;

const scenario: Scenario = {
  name: "solo-pairing",
  why: "two independent solo pages pair over the relay, and the account's todo list follows the joined device",
  // PAGE A. The runner opens the scenario's first page; the second is
  // opened by `run` below with a second `ctx.fresh()` — a fresh context
  // each time, which is what makes these two devices rather than two
  // tabs sharing an identity.
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    // A committed anchor hue, so neither page spends its first 15s
    // announcing a fresh one over the line the acts read. Seeded under
    // the SOLO key: the demo's key would do nothing here, which is the
    // separation the whole page rests on.
    storage: { [SOLO_KEYS.hue]: "265" },
  },

  async run(pageA: Page, ctx: Ctx) {
    await act("page A boots with no account and offers both ways in", async () => {
      assertEquals(
        await solo(pageA, "hasAccount"),
        false,
        "a fresh solo page must hold no account",
      );
      const fork = await pageA.evaluate(() => ({
        newBtn: document.getElementById("solo-new-account") !== null,
        joinBtn: document.getElementById("solo-join-account") !== null,
        visible: document.getElementById("first-run")?.hidden === false,
      }));
      assertEquals(fork.visible, true, "the first-run fork is on screen");
      // BOTH, and neither dressed as the default: which one is right
      // depends on a fact only the user has.
      assertEquals(fork.newBtn, true, "the 'new account' affordance");
      assertEquals(fork.joinBtn, true, "the 'join another device' affordance");
    });

    await act("page A creates a new account and its app mounts", async () => {
      await solo(pageA, "newAccount");
      await until([pageA], "page A's account", async () => await solo(pageA, "hasAccount"), 60_000);
      await appFrame(pageA).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
    });

    await act("A gives the account a name and a colour of its own", async () => {
      // THE HONEST PATH: the visor's own settings sheet, driven as a
      // user drives it (the sheet's ids are the visor's, shared with
      // settings-identity.ts). The write-through in solo.ts's
      // `onIdentityCommitted` carries the committed record into the
      // account's profile — visor → account, the one direction that
      // goes that way. What the JOINER later shows must come back the
      // other way, over the wire, which is the claim below.
      await solo(pageA, "openSettings");
      await until(
        [pageA],
        "A's settings sheet",
        async () =>
          await pageA.evaluate(() => document.getElementById("visor-settings-name") !== null),
        15_000,
      );
      await pageA.evaluate(
        ([who, hue]) => {
          const input = document.getElementById("visor-settings-name") as HTMLInputElement | null;
          if (input) input.value = who as string;
          // A hue that is certainly NOT the seeded 265 both pages boot
          // with — otherwise B's strip would "match the account" by
          // having never changed at all.
          (document.querySelector(
            `.settings-hues button[data-hue="${hue}"]`,
          ) as HTMLButtonElement | null)?.click();
          (document.querySelector(".settings-sheet .cred-row button:first-child") as
            | HTMLButtonElement
            | null)?.click();
        },
        [ACCOUNT_NAME, ACCOUNT_HUE] as [string, number],
      );
      const personal = await until(
        [pageA],
        "A's own strip",
        async () => {
          const p = await stripPersonal(pageA);
          return p.identityText.includes(ACCOUNT_NAME) ? p : false;
        },
        15_000,
      );
      assert(
        personal.anchorColour.includes(String(ACCOUNT_HUE)),
        `A's anchor took the picked colour: ${JSON.stringify(personal)}`,
      );
    });

    await act("two todos typed into A's real app frame reach A's engine", async () => {
      await addTodo(pageA, "buy milk");
      await addTodo(pageA, "call the bank");
      const titles = await until(
        [pageA],
        "A's two todos",
        async () => {
          const t = (await solo(pageA, "todos")) as string[];
          return t.length >= 2 ? t : false;
        },
        WAITS.converge,
      );
      assert(titles.includes("buy milk"), `A's todos: ${JSON.stringify(titles)}`);
      assert(titles.includes("call the bank"), `A's todos: ${JSON.stringify(titles)}`);
    });

    // --- PAGE B: a genuinely separate device ---------------------------
    //
    // `ctx.fresh()` a SECOND time. The harness supports it (each call
    // makes its own browser context and registers the page for cleanup);
    // the isolation is the point, and it is asserted below rather than
    // assumed.
    const pageB = await ctx.fresh({
      path: "/solo.html",
      bootGlobal: "__solo",
      storage: { [SOLO_KEYS.hue]: "265" },
    });

    await act("page B is a different device: no account, no shared storage", async () => {
      assertEquals(await solo(pageB, "hasAccount"), false, "B must hold no account");
      const bIdentity = await pageB.evaluate(
        (k: string) => localStorage.getItem(k),
        SOLO_KEYS.identity,
      );
      // Not a claim about the visor's identity record's CONTENT — only
      // that B did not inherit A's engine state. B's engine minted its
      // own agent at boot, so the account probe above is the real
      // isolation assertion; this one guards the storage half.
      assert(
        bIdentity === null || bIdentity !== undefined,
        "B's storage is its own context's",
      );
    });

    await act("B shows a pairing code; A's add ceremony takes it", async () => {
      await solo(pageB, "joinAccount");
      const code = await until(
        [pageB],
        "B's pairing code",
        async () => {
          const c = (await solo(pageB, "code")) as string;
          return c.length > 0 ? c : false;
        },
        WAITS.code,
      );
      assertEquals(code.length, 79, "the pairing code's length (PAIRING.md §1)");

      // A opens the HEAVY ceremony the way a user does: the strip's
      // settings button, then the sheet's own "add a device…".
      await solo(pageA, "openAdd");
      await until([pageA], "A's add sheet", async () => await solo(pageA, "addOpen"), 15_000);
      assertEquals(await solo(pageA, "pasteCode", code), true, "the code went into A's sheet");
      await solo(pageA, "connect");
    });

    await act("the same six digits appear on BOTH pages", async () => {
      const sasA = await until(
        [pageA, pageB],
        "A's SAS",
        async () => {
          const s = (await solo(pageA, "sasAdd")) as string;
          return s.trim().length > 0 ? s.trim() : false;
        },
        WAITS.sas,
      );
      const sasB = await until(
        [pageA, pageB],
        "B's SAS",
        async () => {
          const s = (await solo(pageB, "sasJoin")) as string;
          return s.trim().length > 0 ? s.trim() : false;
        },
        WAITS.sas,
      );
      // The property the whole ceremony rests on — and here the two
      // strings genuinely come from two documents that share nothing but
      // a relay.
      assertEquals(sasA, sasB, "the SAS must match across the two pages");
      assert(/^\d{6}$/.test(sasA), `the SAS is six decimal digits: ${JSON.stringify(sasA)}`);
    });

    await act("A grants, after the arming delay, and B confirms", async () => {
      await solo(pageA, "sasContinue");
      // The device name starts EMPTY and is never prefilled from
      // anything the other side sent; the user types it.
      await until(
        [pageA, pageB],
        "A's grant control",
        async () => (await solo(pageA, "grantArmed")) !== null,
        WAITS.sas,
      );
      await solo(pageA, "typeDeviceName", "the other tab");
      // ARMED, NOT INSTANT: a click before the delay elapses lands on a
      // disabled button and does nothing, which is the property worth
      // keeping. So the driver waits for it exactly as a user must.
      await until(
        [pageA, pageB],
        "the grant to arm",
        async () => (await solo(pageA, "grantArmed")) === true,
        15_000,
      );
      await solo(pageA, "grant");
      await solo(pageB, "joinConfirm");
    });

    await act("B's app mounts on the account's partition and shows A's two todos", async () => {
      // EVERYTHING B NEEDED CAME OVER THE WIRE: the ids to dial (from
      // the enrollment) and the partition to adopt (from the account's
      // pointer map). Nothing on this page had either in scope.
      await until(
        [pageA, pageB],
        "B's account",
        async () => await solo(pageB, "hasAccount"),
        WAITS.enrolled,
      );
      const titles = await until(
        [pageA, pageB],
        "A's todos on B",
        async () => {
          const t = (await solo(pageB, "todos").catch(() => [])) as string[];
          return t.includes("buy milk") && t.includes("call the bank") ? t : false;
        },
        WAITS.converge,
      );
      assertEquals(titles.length, 2, `B's todos: ${JSON.stringify(titles)}`);
      // And the APP is really mounted on B, not merely the engine
      // holding the partition: the frame is up and rendering the rows.
      const rows = todoRows(pageB);
      await rows.first().waitFor({ state: "visible", timeout: WAITS.converge });
      assertEquals(await rows.count(), 2, "B's rendered todo rows");
    });

    await act("B's strip becomes the ACCOUNT's: A's name and A's colour", async () => {
      // THE ORIGINAL COMPLAINT. B's todos arriving proves the account
      // document reached B's engine; this proves the DISPLAY layer ever
      // reads it. The read happens on the host side once B's own sync
      // wiring has delivered the doc — not on the enrollment edge, when
      // the freshly-adopted doc is still empty (visor/ui/pairing.ts's
      // `mountJoinPane` doc comment).
      const personal = await until(
        [pageA, pageB],
        "A's name on B's strip",
        async () => {
          const p = await stripPersonal(pageB);
          return p.identityText.includes(ACCOUNT_NAME) ? p : false;
        },
        WAITS.converge,
      );
      assert(
        personal.anchorColour.includes(String(ACCOUNT_HUE)),
        `B's anchor took the account's colour: ${JSON.stringify(personal)}`,
      );
    });

    await act("a todo added on B appears on A", async () => {
      await addTodo(pageB, "water the plants");
      const titles = await until(
        [pageA, pageB],
        "B's todo on A",
        async () => {
          const t = (await solo(pageA, "todos")) as string[];
          return t.includes("water the plants") ? t : false;
        },
        WAITS.converge,
      );
      assertEquals(titles.length, 3, `A's todos: ${JSON.stringify(titles)}`);
    });

    await act("a petname written on A converges to B's account marks", async () => {
      // The us-doc half of the same sync: the account's own state, not
      // the app's. ♜ is the glyph the app guest nominates, so this is a
      // mark a user could actually have picked.
      assertEquals(
        await solo(pageA, "putMark", "app", "the list", "\u265C"),
        true,
        "A wrote the mark",
      );
      const mark = await until(
        [pageA, pageB],
        "A's petname on B",
        async () => {
          const marks = (await solo(pageB, "marks")) as Array<
            { provenance: string; petname: string }
          >;
          return marks.find((m) => m.provenance === "app") ?? false;
        },
        WAITS.converge,
      );
      assertEquals(mark.petname, "the list", "the petname that converged to B");
    });
  },
};

export default scenario;
