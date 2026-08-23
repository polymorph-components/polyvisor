// TWO DEVICES, ONE ACCOUNT, STORAGE ADOPTED WITHOUT RETYPING — the e2e
// headline of runtime/DRIVE.md's "The account syncs its storage config;
// devices keep their credentials".
//
// WHY THIS IS ITS OWN SCENARIO rather than more beats on solo-pairing.
// Two reasons, and the second is the load-bearing one:
//
//   - it needs the FAKE DRIVE (demo/host/fake-drive.ts), which
//     solo-pairing deliberately does not start: that scenario's subject
//     is convergence over the relay with no storage anywhere in it;
//   - THE BEAT ORDER IS THE ASSERTION. B must enroll BEFORE A binds, so
//     that A's bind is a change to an account B is ALREADY a member of
//     — which is the only ordering in which B can observe the
//     `storage-changed` announcement at all. solo-pairing's order is
//     fixed by its own argument (A's data, then B joins and converges);
//     bending it to make this observable would spoil the scenario that
//     is already there.
//
// The plumbing is borrowed from both: solo-pairing's two-isolated-
// contexts pairing ceremony, and solo-gdrive's fake Drive and popup
// path. Nothing is copied that could be imported.
//
// SIX CLAIMS, in the ruling's own order:
//
//   1. A creates the account; B pairs into it over the relay. Before A
//      binds anything, B's account carries NO storage record — the
//      absence is a fact, not an error (devstore row 45's browser-side
//      twin).
//   2. A binds Google Drive through the FULL sheet ceremony — the
//      provider choice, the folder, the client pair, the real popup —
//      and WRITES THE RECORD THROUGH: breadcrumb
//      "storage:account-written", and B can read the record back out of
//      its own engine.
//   3. B ANNOUNCES IT, never silently adopts it: the visor's own rule
//      line says the account now syncs through Google Drive and tells
//      the user where to act. B's own store is still unbound at that
//      moment, which is what "never silently adopt" means concretely.
//   4. B's storage sheet LEADS WITH THE ACCOUNT'S DESTINATION and
//      offers only the per-device half: the account sentence, a Connect
//      button, an escape hatch — and NO field for the folder, the
//      client id or the client secret, because retyping those is the
//      silent-fork failure mode the record exists to prevent.
//   5. B CONNECTS WITH NOTHING TYPED. The consent popup is the entire
//      ceremony (tokens and consent stay per-device — one click, and it
//      is also where the user authorizes THIS device). Breadcrumb
//      "storage:account-adopted", and NO "storage:account-written":
//      a bind that came FROM the record has nothing to write back.
//   6. BOTH DEVICES LAND IN ONE STORE. The fake's tree holds exactly
//      one root folder, in the hidden app-data space, and the set of
//      doc folders under it after B's flush is the SAME set A produced
//      — not a second, parallel, invisible one. That fork is the
//      failure this whole feature exists to prevent, so it is the last
//      thing asserted.
//
// SYNTHETIC LABELED VALUES THROUGHOUT: the client pair below is
// obviously-fake app identity for an in-process fake, never anything
// Google issued.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, stripText } from "../util.ts";
import { addTodo, appFrame, solo, until, WAITS } from "../solo-util.ts";
import { startFakeDrive } from "../../host/fake-drive.ts";
import type { FakeDrive } from "../../host/fake-drive.ts";

const ROOT = "pm-account-drive";
// Synthetic installed-app identifiers (DRIVE.md §3: an installed app's
// client secret is "not treated as a secret" by Google's own docs — and
// this pair was issued by nobody at all).
const CLIENT_ID = "SYNTHETIC-ACCOUNT-CLIENT";
const CLIENT_SECRET = "synthetic-account-client-secret-0000";

/** The strip's rule line, watched by SAMPLING rather than by a single
 * read. An announcement is sticky for a bounded window and then reverts
 * (visor/ui/pairing.ts's `visorAnnounceSink`), and the drain that
 * produces this one runs on solo.ts's own 1 s poll, so the honest way to
 * wait for it is to keep looking until it appears or the deadline
 * passes. */
async function waitForAnnouncement(
  page: Page,
  pred: (t: string) => boolean,
  what: string,
  timeout: number,
): Promise<string> {
  const deadline = Date.now() + timeout;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    const { bottom } = await stripText(page);
    if (bottom && seen[seen.length - 1] !== bottom) seen.push(bottom);
    if (pred(bottom)) return bottom;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waiting for ${what}: the strip's rule line said ${JSON.stringify(seen)} within ${timeout}ms`,
  );
}

/** The doc folders the fake holds under the store's root, in the hidden
 * app-data space — DRIVE.md §2's layout is root → `docs` → one folder
 * per document, and the leaf names are keyed hashes, so this is the
 * finest-grained thing an outside observer (or this scenario) can
 * compare. ONE store means ONE such set; a fork would show up as a
 * second root folder or a disjoint set here. */
function docFolders(fake: FakeDrive): string[] {
  return fake.childNames(`${ROOT}/docs`, "appDataFolder").slice().sort();
}

const scenario: Scenario = {
  name: "solo-account-storage",
  why:
    "two independent solo devices in one account: the first binds Google Drive and writes the destination through the account; the second announces the change, then adopts it with nothing typed but a consent click — and both land in ONE store",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },

  async run(pageA: Page, ctx: Ctx) {
    const fake = await startFakeDrive();
    try {
      await act("A creates the account and a todo, through the real app frame", async () => {
        // ORDER MATTERS (PR #88): `solo-new-account` lives in a drawer
        // sheet mounted only at first run, so the account is made before
        // any other sheet opens — same idiom as solo-gdrive.ts.
        assertEquals(await solo(pageA, "newAccount"), true, "the entry sheet's button was clicked");
        await until([pageA], "A's account", async () => await solo(pageA, "hasAccount"), 60_000);
        await appFrame(pageA).locator("input.new-todo").waitFor({
          state: "visible",
          timeout: WAITS.converge,
        });
        await addTodo(pageA, "buy milk");
        await until([pageA], "A's todo", async () => {
          const t = (await solo(pageA, "todos")) as string[];
          return t.length >= 1 ? t : false;
        }, WAITS.converge);
      });

      await act("A keeps its device (until-reseal), so the bind has somewhere to rest", async () => {
        await solo(pageA, "openDevice");
        await until([pageA], "A's device sheet", async () => {
          const s = await solo(pageA, "deviceSheet");
          return s.open && s.keep ? s : false;
        }, 15_000);
        assertEquals(
          await solo(pageA, "keepDevice", "laptop", "until-reseal"),
          true,
          "the promotion ceremony's own controls took the choice",
        );
        await until([pageA], "A's promoted device", async () => {
          const ds = (await solo(pageA, "devices").catch(() => [])) as { tier: string }[];
          return ds.find((d) => d.tier === "t1") ?? false;
        }, 30_000);
      });

      // --- B ENROLLS FIRST. The whole point of the ordering: A's bind,
      // --- below, is then a change to an account B already belongs to.
      const pageB = await ctx.fresh({
        path: "/solo.html",
        bootGlobal: "__solo",
        storage: { [SOLO_KEYS.hue]: "265" },
      });

      await act("B pairs into A's account over the relay", async () => {
        assertEquals(await solo(pageB, "hasAccount"), false, "B starts with no account");
        await solo(pageB, "joinAccount");
        const code = await until([pageB], "B's pairing code", async () => {
          const c = (await solo(pageB, "code")) as string;
          return c.length > 0 ? c : false;
        }, WAITS.code);
        assertEquals(code.length, 79, "the pairing code's length (PAIRING.md §1)");

        await solo(pageA, "openAdd");
        await until([pageA], "A's add sheet", async () => await solo(pageA, "addOpen"), 15_000);
        assertEquals(await solo(pageA, "pasteCode", code), true, "the code went into A's sheet");
        await solo(pageA, "connect");

        const sasA = await until([pageA, pageB], "A's SAS", async () => {
          const s = (await solo(pageA, "sasAdd")) as string;
          return s.trim().length > 0 ? s.trim() : false;
        }, WAITS.sas);
        const sasB = await until([pageA, pageB], "B's SAS", async () => {
          const s = (await solo(pageB, "sasJoin")) as string;
          return s.trim().length > 0 ? s.trim() : false;
        }, WAITS.sas);
        assertEquals(sasA, sasB, "the SAS must match across the two pages");

        await solo(pageA, "sasContinue");
        await until(
          [pageA, pageB],
          "A's grant control",
          async () => (await solo(pageA, "grantArmed")) !== null,
          WAITS.sas,
        );
        await solo(pageA, "typeDeviceName", "the other tab");
        await until(
          [pageA, pageB],
          "the grant to arm",
          async () => (await solo(pageA, "grantArmed")) === true,
          15_000,
        );
        await solo(pageA, "grant");
        await solo(pageB, "joinConfirm");

        await until(
          [pageA, pageB],
          "B's account",
          async () => await solo(pageB, "hasAccount"),
          WAITS.enrolled,
        );
        await until([pageA, pageB], "A's todo on B", async () => {
          const t = (await solo(pageB, "todos").catch(() => [])) as string[];
          return t.includes("buy milk") ? t : false;
        }, WAITS.converge);
      });

      await act("before any bind, the account carries NO storage record", async () => {
        // The absence is DATA (devstore row 45): the sheet asks this on
        // every open, so it must answer cheaply and never reject.
        assertEquals(
          await solo(pageA, "accountStorage"),
          null,
          "A's account has no storage record yet",
        );
        assertEquals(
          await solo(pageB, "accountStorage"),
          null,
          "B's account has no storage record yet",
        );
        assertEquals(await solo(pageB, "storageStatus"), null, "B's own device is unbound");
      });

      await act("A binds Drive through the FULL sheet ceremony, and writes it through", async () => {
        await solo(pageA, "setGdriveEndpoints", {
          apiBase: fake.url,
          authUrl: `${fake.url}/auth`,
          tokenUrl: `${fake.url}/token`,
        });
        await pageA.evaluate(() => {
          (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
        });
        await pageA.waitForFunction(
          () =>
            document.querySelector(
              '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
            ) !== null,
          undefined,
          { timeout: 15_000 },
        );
        await solo(pageA, "openStorageSheet");
        await pageA.waitForSelector("#storage-kind-gdrive", { timeout: 15_000 });
        // Clicked through evaluate for solo-gdrive.ts's reason: the
        // sheet renders taller than the viewport with both providers'
        // fields in the DOM, which Playwright's actionability check
        // reads as out-of-viewport.
        await pageA.evaluate(() => {
          (document.getElementById("storage-kind-gdrive") as HTMLInputElement).click();
        });
        await pageA.waitForSelector("#storage-gd-root", { state: "visible", timeout: 15_000 });
        await pageA.fill("#storage-gd-root", ROOT);
        await pageA.fill("#storage-gd-client", CLIENT_ID);
        await pageA.fill("#storage-gd-secret", CLIENT_SECRET);
        await pageA.click("#storage-connect");

        const trace = await until([pageA], "A's storage:bound", async () => {
          const t = (await solo(pageA, "bootTrace")) as string[];
          return t.includes("storage:bound") ? t : false;
        }, 60_000);
        assert(trace.includes("storage:consented"), `A's bootTrace: ${JSON.stringify(trace)}`);

        // THE WRITE-THROUGH, as its own breadcrumb: the bind happened
        // locally first and the account is the source of truth catching
        // up (solo.ts's `writeThroughAccountStorage`, the same idiom as
        // `onIdentityCommitted`).
        const written = await until([pageA], "A's storage:account-written", async () => {
          const t = (await solo(pageA, "bootTrace")) as string[];
          return t.includes("storage:account-written") ? t : false;
        }, 30_000);
        assert(
          written.includes("storage:account-written"),
          `A's bootTrace: ${JSON.stringify(written)}`,
        );

        const rec = await solo(pageA, "accountStorage");
        assertEquals(rec.kind, "gdrive", "the account's record names the provider");
        assertEquals(rec.value.root, ROOT, "the account's record carries the folder");
        assertEquals(rec.value.clientId, CLIENT_ID, "the account's record carries the client id");
        assertEquals(rec.value.space, "appdata", "the sheet's hidden-app-data default rode along");
      });

      await act("B ANNOUNCES the change on the visor's own rule line", async () => {
        // ANNOUNCE, NEVER SILENTLY ADOPT (DRIVE.md). The sentence names
        // the provider in the visor's own vocabulary and says where to
        // act; the drain that produces it is solo.ts's 1 s poll over
        // `us-events`.
        const said = await waitForAnnouncement(
          pageB,
          (t) => t.includes("syncs its storage through"),
          "B's storage-changed announcement",
          WAITS.converge,
        );
        assertIncludes(said, "Google Drive", "B's announcement names the provider");
        assertIncludes(said, "storage sheet", "B's announcement says where to act");
        // AND IT IS ONLY AN ANNOUNCEMENT: B's own device is still
        // unbound. Nothing re-pointed this device's store behind the
        // user's back.
        assertEquals(await solo(pageB, "storageStatus"), null, "B's own store is still unbound");
      });

      await act("B's sheet leads with the ACCOUNT'S destination and offers only consent", async () => {
        // The record reached B's own engine over the account's E2E
        // channel — asserted from the engine, not from the sheet, so
        // this is the SYNCED fact rather than a repaint.
        const rec = await until([pageB], "the record on B", async () => {
          const r = await solo(pageB, "accountStorage");
          return r ?? false;
        }, WAITS.converge);
        assertEquals(rec.value.clientId, CLIENT_ID, "B holds the account's client id");

        // The fake's endpoints, which on B stand in for Google's own —
        // harness plumbing, not something a user types. `apiBase` is
        // deliberately NOT set here: the sheet takes it from the
        // account's record on the adopt path, which is the sharper
        // assertion.
        await solo(pageB, "setGdriveEndpoints", {
          authUrl: `${fake.url}/auth`,
          tokenUrl: `${fake.url}/token`,
        });
        await pageB.evaluate(() => {
          (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
        });
        await pageB.waitForFunction(
          () =>
            document.querySelector(
              '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
            ) !== null,
          undefined,
          { timeout: 15_000 },
        );
        await solo(pageB, "openStorageSheet");
        await pageB.waitForSelector("#storage-lead", { timeout: 15_000 });

        const view = await until([pageB], "B's account-destination view", async () =>
          await pageB.evaluate(() => {
            const lead = document.getElementById("storage-lead")?.textContent ?? "";
            if (!lead.startsWith("Your account syncs")) return false;
            return {
              lead,
              diverge: document.getElementById("storage-diverge") !== null,
              connect:
                (document.getElementById("storage-connect") as HTMLButtonElement | null)
                  ?.textContent ?? "",
              // The fields that MUST NOT be on the page: every one of
              // them is config the account already agreed on.
              root: document.getElementById("storage-gd-root") !== null,
              client: document.getElementById("storage-gd-client") !== null,
              secret: document.getElementById("storage-gd-secret") !== null,
              kindChoice: document.getElementById("storage-kind-gdrive") !== null,
            };
          }), 15_000);

        assertIncludes(view.lead, ROOT, "B's lead names the account's folder");
        assertIncludes(view.lead, "nothing to type", "B's lead promises no typing");
        assertEquals(view.root, false, "no Drive-folder field on the adopt path");
        assertEquals(view.client, false, "no client-id field on the adopt path");
        assertEquals(view.secret, false, "no client-secret field on the adopt path");
        assertEquals(view.kindChoice, false, "no provider choice: an account has one store");
        assertEquals(view.diverge, true, "the escape hatch is still offered (#storage-diverge)");
        assertIncludes(view.connect, "Connect this device", "the button is the per-device half");
      });

      await act("B connects with NOTHING typed — the consent click is the whole ceremony", async () => {
        const before = docFolders(fake);
        assert(before.length > 0, "A's flush should already have produced a doc folder");

        await pageB.click("#storage-connect");
        const trace = await until([pageB], "B's storage:bound", async () => {
          const t = (await solo(pageB, "bootTrace")) as string[];
          return t.includes("storage:bound") ? t : false;
        }, 60_000);
        // The consent DID happen on B — tokens and consent stay
        // per-device, and this is the one click the ruling says it costs.
        assert(trace.includes("storage:consented"), `B's bootTrace: ${JSON.stringify(trace)}`);
        assert(
          trace.includes("storage:account-adopted"),
          `B's bind must be recorded as an adoption: ${JSON.stringify(trace)}`,
        );
        // AND NO WRITE-THROUGH: a bind that came FROM the record has
        // nothing to say back to it.
        assertEquals(
          trace.includes("storage:account-written"),
          false,
          `B must not rewrite the record it adopted: ${JSON.stringify(trace)}`,
        );

        // B's binding is the account's destination, field for field —
        // including the apiBase, which B never had in its endpoint
        // override and could only have taken from the record.
        const bound = await solo(pageB, "storageStatus");
        assertEquals(bound.kind, "gdrive", "B's binding names the provider");
        assertEquals(bound.root, ROOT, "B's binding is the account's folder");
        assertEquals(bound.clientId, CLIENT_ID, "B's binding is the account's client id");
        assertEquals(bound.space, "appdata", "B's binding is the account's space");
        assertEquals(bound.apiBase, fake.url, "B's apiBase came from the account's record");
        assertEquals(
          (await solo(pageB, "gdriveConsent"))?.space,
          "appdata",
          "B holds its OWN consent, granted for the account's space",
        );
      });

      await act("both devices landed in ONE store, not two", async () => {
        // ONE ROOT FOLDER in the hidden space. A second one would be the
        // invisible fork the whole feature exists to prevent — and in
        // the appdata space it is invisible in the user's Drive UI too,
        // which is what makes it worth an assertion rather than a
        // support ticket.
        const roots = fake.childNames("", "appDataFolder").filter((n) => n === ROOT);
        assertEquals(roots.length, 1, `exactly one store root in the hidden space: ${roots}`);
        assertEquals(
          fake.files().filter((f) => f.space === "drive").length,
          0,
          "nothing may land in the visible Drive space on an app-data binding",
        );

        // And the doc folders are ONE SET. B's flush may add documents
        // (its own device state), but every folder A produced must still
        // be there — a fork would show up as A's set and B's set being
        // disjoint.
        const before = docFolders(fake);
        await pageB.waitForSelector("#storage-sync", { state: "visible", timeout: 15_000 });
        await pageB.click("#storage-sync");
        await until([pageB], "B's storage:synced", async () => {
          const t = (await solo(pageB, "bootTrace")) as string[];
          return t.includes("storage:synced") ? t : false;
        }, 30_000);
        const after = docFolders(fake);
        for (const f of before) {
          assert(
            after.includes(f),
            `B's flush must join A's documents, not fork: ${JSON.stringify(before)} -> ` +
              JSON.stringify(after),
          );
        }
      });
    } finally {
      await fake.close();
    }
  },
};

export default scenario;
