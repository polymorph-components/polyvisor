// A DEVICE SYNCS THROUGH ITS BUCKET WHILE ITS SIBLINGS SLEEP — the
// product claim of the bucket-sync round (runtime/SYNC.md), driven end
// to end with nothing else running anywhere.
//
// THE ARGUMENT. Everything before this round made the bucket a
// write-only backup button: flush happened at the connect ceremony and
// when the user pressed "Sync to storage now", and the solo page never
// pulled at all. Two devices of one account could therefore only ever
// exchange work over the RELAY, which means both of them had to be
// awake at the same time. The three pillars change that — the name
// chain is account state so both devices address the SAME objects
// (§1), pull runs at bring-up and on a cadence (§2), and the WORKER
// schedules the flush off the same mutation hook that arms the
// checkpoint (§3) — and this scenario is the one story in which all
// three have to be true at once.
//
// THE BEATS ARE THE ASSERTION, and the ORDER of them is the argument
// that the relay cannot be what did the work:
//
//   1. A and B pair into one account, and B ADOPTS the account's
//      storage with a consent click (solo-account-storage's ceremony,
//      which is where that path is a claim; here it is a
//      precondition). B is KEPT, because it has to come back as the
//      same device later.
//   2. B'S PAGE IS CLOSED — entirely, not reloaded. From here on there
//      is no second device listening anywhere.
//   3. A AUTHORS A TODO AND NOBODY PRESSES ANYTHING. The flush that
//      follows is the worker's own 20 s trailing debounce (SYNC.md §3),
//      and it is witnessed twice: A's `status().sync.lastFlush` moves
//      off null (the SCHEDULER completed a cycle) and the fake Drive's
//      CHANGE BOARD moves (the bytes and the commit note reached the
//      provider). Neither witness alone would do — a status field can
//      move without a store being touched, and a store can be written
//      by a ceremony rather than by a schedule.
//   4. A'S PAGE IS CLOSED TOO. Now nothing of this account is running:
//      no page, no iroh endpoint, no acceptor, no relay presence.
//   5. B IS REOPENED — a fresh page in B's own browser context, so the
//      same kept device comes back through the picker and auto-unseals.
//      A's todo is there, and `status().sync.lastPull` is stamped. The
//      only channel that existed between beat 4 and beat 5 is the
//      bucket.
//
// WHY THE ORDERING IS ENOUGH TO RULE OUT THE RELAY, stated rather than
// waved at: the solo page owns its transport. The iroh endpoint, the
// acceptor and every subduction live in the PAGE (solo.ts), not in the
// device's SharedWorker — so a closed page is a device with no address
// and nothing listening. A's page is closed at beat 4 and B's page does
// not exist again until beat 5, so at no instant after A authored the
// todo were both devices reachable. There is no window in which a peer
// connection could have carried it. (A stronger severing — killing the
// harness's relay — would add nothing: with one side torn down there is
// no connection for a relay to carry.)
//
// WHAT THIS SCENARIO DOES NOT CLAIM: that the pull was specifically the
// BOOT one rather than the 45 s cadence's first tick. B's worker is torn
// down with its last client, and the reopened page's unseal arms the
// boot pull at zero delay (worker.ts's `startSyncSchedule`), so the boot
// pull is overwhelmingly what runs — but the claim being made here is
// the product one (the todo arrived through the bucket with no live
// peer), and it is true either way. The boot pull's own structural
// property — armed BEHIND readiness, never awaited by the unseal — is
// pinned in devstore row 50, where it can be measured against a store
// that is deliberately unreachable.
//
// HISTORY, kept because the failure taught the design: this scenario
// was first registered RED, deliberately. Beats 1-4 passed (the worker's
// debounced flush fired with no button; the change board moved), and B's
// boot pull then refused every cycle with "pickup object missing:
// revoked, or never granted to this device" — because a Drive pull was
// PICKUP-GATED, pickups are written only for explicit grantees, and the
// only grant the demo ever issues is a device granting ITSELF. Pillar 1
// had made the name chain account state on the FLUSH side while the
// PULL side still hard-required the pickup. The red run forced the
// ruling now in SYNC.md §2, "THE ACCOUNT PULL PATH": pulls between
// account siblings use the account's own chain and device directory and
// no pickup at all; the pickup remains the bootstrap for NON-account
// readers only. The last beat below is therefore the regression gate on
// that ruling: it goes red again if sibling pulls ever regrow a pickup
// dependency.
//
// SYNTHETIC LABELED VALUES THROUGHOUT: the client pair below is
// obviously-fake app identity for an in-process fake, issued by nobody.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, createAccount, pairPages, solo, until, WAITS } from "../solo-util.ts";
import { startFakeDrive } from "../../host/fake-drive.ts";
import type { FakeDrive } from "../../host/fake-drive.ts";

const ROOT = "pm-offline-sync";
const CLIENT_ID = "SYNTHETIC-OFFLINE-CLIENT";
const CLIENT_SECRET = "synthetic-offline-client-secret-0000";

/** The todo that has to make the crossing. Written on A while B is
 * closed, and read on B after A is closed too. */
const THE_TODO = "the todo that travelled through the bucket";

/** How long the scheduled flush may take: the worker's 20 s trailing
 * debounce (SYNC.md §3's `FLUSH_DEBOUNCE_MS`) plus room for the cycle
 * itself and a busy CI box. Not a guess — a constant plus margin. */
const FLUSH_WAIT = 60_000;
/** How long B may take to find A's work after it reopens: one boot pull,
 * with room for the 45 s cadence to have a second go if the first cycle
 * lands mid-bring-up. */
const PULL_WAIT = 100_000;

/**
 * THE CHANGE BOARD, whole, across every doc folder in the store — SYNC.md
 * §2's `appProperties` board, which each device patches with its OWN key
 * (16 hex characters of its public verifying key) at flush COMMIT, and
 * whose values are decimal flush counters and nothing else.
 *
 * Read as one comparable string because the assertion is about MOVEMENT:
 * between two snapshots taken with only one device awake, any change is
 * that device's committed flush.
 */
function board(fake: FakeDrive): string {
  const folders = fake.childNames(`${ROOT}/docs`, "appDataFolder").slice().sort();
  return JSON.stringify(
    folders.map((f) => [f, fake.appProperties(`${ROOT}/docs/${f}`, "appDataFolder")]),
  );
}

/** Keep a device, so it can be found again by a page that did not exist
 * when it was made. A T0 device is reached through the tab's own anchor
 * (sessionStorage), which a NEW page does not have — only a kept device
 * is on the picker. This is why beat 1 pays for the ceremony on B. */
async function keepDevice(page: Page, petname: string): Promise<void> {
  await solo(page, "openDevice");
  await until([page], `${petname}'s device sheet`, async () => {
    const s = await solo(page, "deviceSheet");
    return s.open && s.keep ? s : false;
  }, 15_000);
  assertEquals(
    await solo(page, "keepDevice", petname, "until-reseal"),
    true,
    `the promotion ceremony's own controls took the choice for ${petname}`,
  );
  await until([page], `${petname} promoted`, async () => {
    const ds = (await solo(page, "devices").catch(() => [])) as { tier: string }[];
    return ds.find((d) => d.tier === "t1") ?? false;
  }, 30_000);
}

/** Leave the storage sheet the way a user does — its own Close button —
 * and wait for it to actually go. Both pages need this: the drawer is a
 * chrome-owned tenant over the app surface, so a sheet left standing
 * would sit between the driver and the todo input it has to type into
 * next. */
async function closeStorageSheet(page: Page): Promise<void> {
  await page.click('#storage-sheet button:text-is("Close")');
  await page.waitForSelector("#storage-sheet", { state: "detached", timeout: 15_000 });
}

const scenario: Scenario = {
  name: "solo-offline-sync",
  why:
    "a todo written on one device reaches its sibling with NO live peer anywhere: the worker flushes it on its own debounce, both pages close, and the sibling picks it up out of the bucket when it reopens",
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
      await act("A creates the account and keeps its device", async () => {
        await createAccount(pageA);
        await appFrame(pageA).locator("input.new-todo").waitFor({
          state: "visible",
          timeout: WAITS.converge,
        });
        await keepDevice(pageA, "laptop");
      });

      const pageB = await ctx.fresh({
        path: "/solo.html",
        bootGlobal: "__solo",
        storage: { [SOLO_KEYS.hue]: "265" },
      });
      // B'S OWN CONTEXT AND B'S OWN URL, both captured now: the reopen in
      // beat 5 is a new PAGE in this same context (the device store lives
      // in the context's storage partition, so a new context would be a
      // new device and the scenario would be asserting nothing).
      const ctxB = pageB.context();
      const urlB = pageB.url();

      await act("B pairs into A's account over the relay, and is KEPT too", async () => {
        assertEquals(await solo(pageB, "hasAccount"), false, "B starts with no account");
        await pairPages(pageA, pageB, "the other tab");
        await until(
          [pageA, pageB],
          "B's account",
          async () => await solo(pageB, "hasAccount"),
          WAITS.enrolled,
        );
        await keepDevice(pageB, "phone");
      });

      await act("A binds Drive through the full sheet ceremony", async () => {
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
        // Clicked through evaluate for solo-gdrive.ts's reason: the sheet
        // renders taller than the viewport with both providers' fields in
        // the DOM, which Playwright reads as out-of-viewport.
        await pageA.evaluate(() => {
          (document.getElementById("storage-kind-gdrive") as HTMLInputElement).click();
        });
        await pageA.waitForSelector("#storage-gd-root", { state: "visible", timeout: 15_000 });
        await pageA.fill("#storage-gd-root", ROOT);
        await pageA.fill("#storage-gd-client", CLIENT_ID);
        await pageA.fill("#storage-gd-secret", CLIENT_SECRET);
        await pageA.click("#storage-connect");
        await until([pageA], "A's storage:bound", async () => {
          const t = (await solo(pageA, "bootTrace")) as string[];
          return t.includes("storage:bound") ? t : false;
        }, 60_000);
        // OUT OF THE SHEET AGAIN: A has a todo to type next, and the
        // drawer is a chrome-owned tenant sitting over the app surface.
        await closeStorageSheet(pageA);
      });

      await act("B ADOPTS the account's store — nothing typed but the consent", async () => {
        // THE ADOPT PATH, with nothing typed but the consent — the claim
        // solo-account-storage makes; here it is the cheapest way to get
        // B pointed at the same bucket, and it also gets B the account's
        // `apiBase` (the fake) without this scenario telling it.
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
        await until([pageB], "B's adopt view", async () =>
          await pageB.evaluate(() =>
            (document.getElementById("storage-lead")?.textContent ?? "").startsWith(
              "Your account syncs",
            )
          ), 15_000);
        await pageB.click("#storage-connect");
        await until([pageB], "B's storage:bound", async () => {
          const t = (await solo(pageB, "bootTrace")) as string[];
          return t.includes("storage:bound") ? t : false;
        }, 60_000);
        const bound = await solo(pageB, "storageStatus");
        assertEquals(bound.root, ROOT, "B is pointed at the account's folder");
        assertEquals(bound.apiBase, fake.url, "B's apiBase came from the account's record");
        await closeStorageSheet(pageB);
      });

      await act("B'S PAGE CLOSES — from here there is no second device awake", async () => {
        // A checkpoint first, so what comes back in beat 5 comes back from
        // a checkpoint rather than from a race with the worker's 500 ms
        // debounce (solo-persistence's discipline).
        await solo(pageB, "checkpoint");
        await pageB.close();
        assertEquals(pageB.isClosed(), true, "B's page is gone, not merely hidden");
        // A BEAT FOR B'S WORKER TO FINISH DYING. Its last client just
        // disconnected, which is one of the two moments the schedule
        // honours beside the debounce (worker.ts's `syncFlushNow` on
        // last-client-disconnect) — so B may write one more flush of its
        // OWN state right now. Letting that settle before the snapshot
        // below is what makes the board comparison in the next act
        // unambiguously ABOUT A.
        await new Promise((r) => setTimeout(r, 5_000));
      });

      const boardBefore = board(fake);

      await act("A authors a todo and NOBODY PRESSES ANYTHING", async () => {
        const syncBefore = await solo(pageA, "syncStatus");
        assert(syncBefore !== null, "A is bound, so it has a sync record to report");
        assertEquals(
          syncBefore.lastFlush,
          null,
          "no SCHEDULED flush has completed yet — the connect ceremony's own flush is a " +
            "client act and deliberately does not move this field (rpc.ts's SyncStatus)",
        );

        await addTodo(pageA, THE_TODO);

        // THE SCHEDULER'S OWN WITNESS: the worker completed a flush cycle
        // in which every partition of the account's pointer map
        // succeeded. Nothing in this scenario called `bucketFlush`; the
        // only thing that happened was a mutation.
        const synced = await until([pageA], "A's SCHEDULED flush", async () => {
          const s = await solo(pageA, "syncStatus");
          return s !== null && s.lastFlush !== null ? s : false;
        }, FLUSH_WAIT);
        assertEquals(synced.flushFailures, 0, `A's schedule is healthy: ${JSON.stringify(synced)}`);

        // THE PROVIDER'S OWN WITNESS: the change board moved. Each device
        // patches only its own key, with a decimal flush counter, AFTER
        // the manifest write that is the commit point — so a board that
        // moved while A was the only device awake is A's flush having
        // committed at the provider.
        const boardAfter = await until([pageA], "the change board to move", async () => {
          const b = board(fake);
          return b !== boardBefore ? b : false;
        }, FLUSH_WAIT);
        assert(
          boardAfter !== boardBefore,
          `the board must move: ${boardBefore} -> ${boardAfter}`,
        );
        // COUNTERS, and only counters. The board is plaintext Drive
        // metadata; SYNC.md §2 makes "a monotonic flush count and nothing
        // else" a rule, so the scenario checks it rather than trusting it.
        for (const [, props] of JSON.parse(boardAfter) as [string, Record<string, string>][]) {
          for (const [k, v] of Object.entries(props)) {
            assert(/^[0-9a-f]{16}$/.test(k), `a board key is a truncated public device tag: ${k}`);
            assert(/^[0-9]+$/.test(v), `a board value is a decimal counter: ${v}`);
          }
        }
      });

      await act("A'S PAGE CLOSES TOO — nothing of this account is running", async () => {
        await solo(pageA, "checkpoint");
        await pageA.close();
        assertEquals(pageA.isClosed(), true, "A's page is gone");
        // The ordering claim, made concrete: B does not exist again until
        // the next act, and A is gone now. The solo page owns the iroh
        // endpoint and every subduction, so neither device has an address
        // or a listener from this line until the reopen below.
      });

      await act("B REOPENS with no peer anywhere — and A's todo is there", async () => {
        const pageB2 = await ctxB.newPage();
        await pageB2.goto(urlB, { waitUntil: "domcontentloaded" });
        await waitForBoot(pageB2, "__solo");

        // THE SAME DEVICE, not a fresh one: found on the picker and
        // opened with no ceremony, which is what "kept" bought in beat 1.
        const trace = (await solo(pageB2, "bootTrace")) as string[];
        assert(trace.includes("auto-unseal"), `B reopened its kept device: ${JSON.stringify(trace)}`);
        assert(
          trace.includes("account:resumed"),
          `B resumed onto its account rather than the first-run fork: ${JSON.stringify(trace)}`,
        );
        assertEquals(
          (await solo(pageB2, "storageStatus"))?.root,
          ROOT,
          "the binding came back with the device — re-applied at bring-up, not re-entered",
        );

        // THE CLAIM. Asserted on B's ENGINE (the partition is what
        // converged) and then on B's RENDERED ROWS, because the user's
        // version of this complaint is "my other device's work is not
        // here".
        // THE DIAGNOSIS RIDES WITH THE FAILURE. This wait is the one
        // that fails when the pull path cannot reach a sibling's
        // namespace, and a bare "timed out" would send the reader looking
        // at the debounce or the relay. `status().sync` names the actual
        // refusal, so it is carried into the error rather than left in a
        // console dump the harness does not collect for a page it did not
        // open itself.
        let lastSync: unknown = null;
        const titles = await until([pageB2], "A's todo on B, through the bucket", async () => {
          const t = (await solo(pageB2, "todos").catch(() => [])) as string[];
          lastSync = await solo(pageB2, "syncStatus").catch((e) => String(e));
          return t.includes(THE_TODO) ? t : false;
        }, PULL_WAIT).catch((e) => {
          throw new Error(`${(e as Error).message}; B's sync record says ${JSON.stringify(lastSync)}`);
        });
        assert(
          titles.includes(THE_TODO),
          `B holds A's todo: ${JSON.stringify(titles)}`,
        );
        await appFrame(pageB2).locator("ul.todo-list li").filter({ hasText: THE_TODO }).first()
          .waitFor({ state: "visible", timeout: WAITS.converge });

        // AND THE SCHEDULE SAYS SO. `lastPull` is stamped by a pull cycle
        // that actually attempted a sibling and got something through
        // (worker.ts's `pullCycle` does NOT stamp an empty cycle — see
        // devstore row 50), so a non-null value here is the worker
        // reporting the very crossing this scenario is about.
        const sync = await until([pageB2], "B's stamped pull", async () => {
          const s = await solo(pageB2, "syncStatus");
          return s !== null && s.lastPull !== null ? s : false;
        }, PULL_WAIT);
        assert(
          sync.pullFailures === 0,
          `B's pull direction is healthy: ${JSON.stringify(sync)}`,
        );
      });
    } finally {
      await fake.close();
    }
  },
};

export default scenario;
