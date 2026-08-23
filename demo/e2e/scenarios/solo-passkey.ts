// THE PRF RUNG, END TO END — PERSISTENCE.md's "The PRF rung: passkey
// unseal" and "Unseal UX", driven as a user through a REAL WebAuthn
// ceremony against Playwright's CDP virtual authenticator.
//
// THE ARGUMENT. `until-reseal` and `every-session` are covered by
// solo-persistence; this scenario is the third rung — "open it with my
// passkey" — and it exists to prove the same things a person would rely
// on: enrollment runs a real ceremony (not a stub the UI merely trusts),
// a passkey device NEVER auto-unseals (PERSISTENCE.md is explicit that
// this rung has no silent path), the ceremony that does run is one
// authenticator prompt, and the state behind it survives exactly like
// any other kept device's does.
//
// THE RP-ID FACT (wosh's finding #1, cited in spikes/prf-unseal/run.ts):
// WebAuthn refuses an IP-address origin with a synchronous
// SecurityError before the authenticator is even consulted. Every other
// scenario in this suite runs on `127.0.0.1` for good reasons of its
// own (see run.ts's `serveSite`), so THIS scenario alone has to reach a
// DOMAIN origin — `http://localhost:<port>` on the very same server.
// `run.ts`'s static server was bound to `127.0.0.1` only; binding it to
// `0.0.0.0` (this scenario's one change outside its own file, matching
// the spike's own server and citing the same wosh finding for the
// ::1-resolver reason) is what makes "localhost" on this port resolve
// to it at all, on every platform's getaddrinfo ordering.
//
// HOW THE HARNESS'S OWN QUERY STRING SURVIVES THE ORIGIN SWITCH: rather
// than reconstructing the harness's base query (the ephemeral relay
// URL) from scratch, this scenario lets `ctx.fresh` build it as normal
// against the harness's usual `127.0.0.1` origin (with `noWait: true`,
// so nothing waits on a boot that is about to be abandoned), reads the
// resulting URL — full query string and all — off the page, and
// re-navigates the SAME context to the domain-swapped equivalent. The
// virtual authenticator is installed on that context before the swap,
// which is all CDP requires ("before any ceremony", not "before any
// navigation").
//
// FIVE CLAIMS:
//
//   1. Enrollment is a real ceremony against the virtual authenticator,
//      landing on `promoted:passkey` and a `passkey`-policy row.
//   2. THE ONE STATE-SURVIVAL DIFFERENCE FROM THE OTHER TWO RUNGS: a
//      passkey device's reload lands on the PICKER, not straight back
//      in — asserted as `picker:wait` present and `auto-unseal` absent,
//      the negative half PERSISTENCE.md rules explicitly ("A
//      `passkey`-policy device never auto-unseals").
//   3. The picker's passkey block (`needsPasskey`) is what is offered,
//      not the passphrase one.
//   4. The ceremony that runs (`automaticPresenceSimulation: true` means
//      no click is needed for user presence) opens the device —
//      `picked:passkey` on the boot trace.
//   5. The todo list made before the reload is the todo list after it.

import type { CDPSession, Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, solo, until, WAITS } from "../solo-util.ts";

/** The user's own name — same synthetic-constant discipline as
 * solo-persistence's `WHO`; nothing here is a real credential. */
const WHO = "Priya";
const PETNAME = "passkey-laptop";

const scenario: Scenario = {
  name: "solo-passkey",
  why:
    "a device kept on the passkey rung enrolls against a real WebAuthn ceremony, " +
    "never auto-unseals, and reopens itself — with its state intact — through one authenticator prompt",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    // The initial goto (on the harness's usual 127.0.0.1 origin) is
    // abandoned in favour of the localhost re-navigation below, so
    // nothing here should wait on ITS boot.
    noWait: true,
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: WHO }),
    },
  },

  async run(page: Page, _ctx) {
    await act("the virtual authenticator installs, PRF included", async () => {
      // CDP, not a page-level polyfill: this is the same shape
      // spikes/prf-unseal/run.ts proved works (row 0), attached to the
      // SAME context/page the scenario goes on to drive — WebAuthn.enable
      // and addVirtualAuthenticator need only run before the first
      // ceremony, not before the first navigation.
      const cdp: CDPSession = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const res = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          hasPrf: true,
          // No click is needed to satisfy "user presence" — the
          // ceremony still demands a real WebAuthn round trip through
          // the authenticator, it just does not block on a human.
          automaticPresenceSimulation: true,
        },
        // deno-lint-ignore no-explicit-any
      } as any);
      assert(
        typeof (res as { authenticatorId?: string }).authenticatorId === "string",
        "CDP handed back an authenticator id",
      );
    });

    await act("re-navigate to the SAME site on a DOMAIN origin (WebAuthn's own demand)", async () => {
      // `ctx.fresh`'s goto already ran (against 127.0.0.1, `noWait` so
      // nothing waited on that boot) — its URL carries the harness's
      // full query string (the ephemeral relay, notably), which this
      // reads off rather than reconstructing.
      const priorUrl = new URL(page.url());
      assertEquals(priorUrl.hostname, "127.0.0.1", "the harness's own origin, before the swap");
      const localUrl = new URL(page.url());
      localUrl.hostname = "localhost";
      await page.goto(localUrl.toString(), { waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      assertEquals(new URL(page.url()).hostname, "localhost", "now on a WebAuthn-legal origin");
    });

    await act("a T0 device on this ORIGIN, no ceremony yet", async () => {
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "nothing was kept yet");
      assertEquals(st.sealed, false, "a T0 device opens itself");
    });

    await act("an account and a todo, through the real app frame", async () => {
      await solo(page, "newAccount");
      await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
      await appFrame(page).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      await addTodo(page, "renew the passport");
      const titles = await until([page], "the todo", async () => {
        const t = (await solo(page, "todos")) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "renew the passport", `the todos: ${JSON.stringify(titles)}`);
    });

    await act("keep this device on the passkey rung: a REAL enrollment ceremony", async () => {
      await solo(page, "openDevice");
      const sheet = await until([page], "the promotion sheet", async () => {
        const s = await solo(page, "deviceSheet");
        return s.open && s.keep ? s : false;
      }, 15_000);
      assert(sheet.keep, "the promotion ceremony is on screen");
      // keepDevice drives the sheet's OWN controls — the real radio at
      // `input[name="device-rung"][value="passkey"]` (renderPromotion),
      // then the real "Keep this device" button, which for this choice
      // runs `enrollPasskey` against the virtual authenticator before
      // anything is written to the index (host/solo.ts's ordering:
      // enroll first, worker second, index last).
      assertEquals(
        await solo(page, "keepDevice", PETNAME, "passkey"),
        true,
        "the ceremony's own controls took the choice",
      );
      const row = await until([page], "the promoted device", async () => {
        const ds = (await solo(page, "devices")) as { petname: string; policy: string }[];
        return ds.find((d) => d.policy === "passkey") ?? false;
      }, 30_000);
      assertEquals(row.petname, PETNAME, "the petname the ceremony asked for");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("promoted:passkey"), `trace: ${JSON.stringify(trace)}`);
    });

    // A checkpoint on purpose (solo-persistence's same discipline): the
    // reload below is a claim about persistence, not a race with the
    // worker's debounce.
    await solo(page, "checkpoint");

    await act("a REAL reload: the picker offers the device — it does NOT auto-unseal", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("index:1"), `trace: ${JSON.stringify(trace)}`);
      // THE NEGATIVE HALF, asked-to-be-asked: PERSISTENCE.md rules that
      // a `passkey`-policy device never auto-unseals, and a single kept
      // device is exactly the case the picker WOULD otherwise skip
      // straight through (solo-persistence's `until-reseal` device does
      // precisely that). Both sides of that fork are on the boot trace.
      assert(trace.includes("picker:wait"), `the picker must wait for a user: ${trace}`);
      assert(!trace.includes("auto-unseal"), `a passkey device must not auto-unseal: ${trace}`);
      const picker = await until([page], "the picker", async () => {
        const p = await solo(page, "picker");
        return p.visible ? p : false;
      }, WAITS.boot);
      assert(picker.rows.includes(PETNAME), `the picker's rows: ${JSON.stringify(picker.rows)}`);
    });

    await act("clicking the row offers the passkey ceremony, not a passphrase field", async () => {
      assertEquals(await solo(page, "pickDevice", PETNAME), true, "the row was pickable");
      const asking = await until([page], "the passkey block", async () => {
        const p = await solo(page, "picker");
        return p.needsPasskey ? p : false;
      }, WAITS.boot);
      assertEquals(asking.needsPasskey, true, "the passkey block is shown");
      assertEquals(asking.needsPassphrase, false, "and the passphrase field is not");
      // THE FALLBACK IS OFFERED ON THE SAME SCREEN (PERSISTENCE.md,
      // "Unseal": the policy tag names the ceremony to OFFER, not the
      // only door). Present, not taken — this device's other rung is the
      // platform one, and taking the fallback here would be a different
      // scenario's claim.
      assertEquals(
        await page.evaluate(() => document.getElementById("device-passkey-fallback") !== null),
        true,
        "the passphrase fallback is on the passkey screen",
      );
    });

    await act("the passkey ceremony runs (one authenticator prompt) and opens the device", async () => {
      await solo(page, "passkeyUnsealClick");
      await until([page], "the unsealed device", async () => {
        try {
          const st = await solo(page, "deviceStatus");
          if (st.sealed === false) return st;
          // A refusal (wrong credential, unsupported browser, …) surfaces
          // on the picker rather than throwing — reported here so a
          // failure names the actual refusal instead of a bare timeout.
          const p = await solo(page, "picker");
          if (p.problem) throw new Error(`the picker refused: ${p.problem}`);
          return false;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("the picker refused")) throw e;
          return false;
        }
      }, WAITS.boot);
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(
        trace.includes("picked:passkey"),
        `the unseal was the passkey ceremony: ${JSON.stringify(trace)}`,
      );
      const st = await solo(page, "deviceStatus");
      assertEquals(st.policy, "passkey", "still on the rung it was kept on");
      assertEquals(st.resumed, true, "the engine resumed rather than starting fresh");
    });

    await act("the todo made before the reload is still there", async () => {
      const titles = await until([page], "the resumed todo", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assert(titles.includes("renew the passport"), `resumed todos: ${JSON.stringify(titles)}`);
    });
  },
};

export default scenario;
