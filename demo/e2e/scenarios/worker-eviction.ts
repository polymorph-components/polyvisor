// A DEVICE'S WHOLE ENGINE HOST DIES WITH NO GOODBYE, WHILE ITS SIBLING
// KEEPS WORKING — and the user-shaped recovery (reload the tab) brings
// the SAME device back from its checkpoint, converged again.
//
// THIS IS THE PRODUCT-LEVEL STORY OVER TWO DEVICES for a claim
// runtime/tests/devstore/run.ts already pinned at the unit level (rows
// 51-56, "WORKER EVICTION, TABS STILL ATTACHED", committed 2026-08-24):
//   - row 51: an EVICTED SharedWorker releases the platform's device
//     lock in ~2ms — no cooperation from the dying host, which is the
//     one thing a crashed agent cannot fake.
//   - row 52/52b: a port to a dead host hears NOTHING (there is no
//     peer-death event to hear — `"onclose" in port` is platform-given,
//     not a gap this store could close); a pending RPC against it ends
//     only at the CLIENT'S OWN timeout deadline.
//   - row 53: a fresh connect respawns the host, and the CHECKPOINTED
//     state is intact.
// Those rows are unit-level: one page, one device, a raw second port.
// This scenario asks the product question the matrix does not: does
// the ACCOUNT — two real devices, a real bound bucket, the real UI —
// survive the same eviction and converge again through the ordinary
// user recovery (reload), with nothing exotic driven by hand.
//
// THE BEATS:
//   1. A creates the account and binds a fake Drive through the full
//      sheet ceremony (solo-account-storage's claim; here a
//      precondition). B pairs in and ADOPTS the store with a consent
//      click — nothing retyped. BOTH DEVICES ARE KEPT (until-reseal):
//      the reopen path below needs the picker to already know them.
//      Live convergence is proven with one todo before anything dies.
//   2. B's deviceId is read off the HONEST hook (`solo(page,
//      "deviceId")` — the store's own opaque id, not something guessed
//      from a petname), and B's SharedWorker is killed by CDP
//      `Target.closeTarget` on the target whose TITLE is
//      `pm-device-<id>` (client.ts names the SharedWorker after the
//      device; solo/demo pages all run the identical `./worker.js`
//      script, so URL cannot tell two devices' hosts apart — the same
//      finding demo/e2e/cdp.ts's banner and devstore row 51 build on).
//      The kill is verified: the target is gone from a bounded poll of
//      `Target.getTargets`, not merely assumed from the call returning.
//   3. WHAT THE USER SEES ON B, measured cheaply and honestly: B's page
//      is still rendered — the app frame and its rows are still in the
//      DOM. The death of a SharedWorker does not blank the tab that was
//      talking to it. This act is DELIBERATELY DOM-ONLY: devstore row
//      52b measured that any RPC against B's engine now hangs until the
//      client's own timeout deadline (there is no peer-death event to
//      shortcut it), so driving a solo hook that reaches into the dead
//      worker here would either stall this scenario for that deadline
//      or silently prove nothing. The claim this act makes is bounded
//      to what a real user would see with their own eyes in the first
//      instant: the tab, not blank.
//   4. A authors a todo while B's host is dead. A's own scheduled flush
//      completes on its normal trailing debounce (SYNC.md §3) —
//      B's death is invisible to A, who has no reason to know.
//   5. B RELOADS (`page.reload` + `waitForBoot`) — the ordinary
//      user-shaped recovery, not a close+reopen. The SAME device comes
//      back through its anchor (bootTrace shows the resume, same
//      assertions solo-offline-sync makes), the storage binding is
//      still there with no re-entry, and within the boot-pull window
//      A's todo is on B. CHANNEL-AGNOSTIC, on purpose: B's worker
//      respawning also re-arms its resumed relay wire AND its
//      zero-delay boot pull (worker.ts's `startSyncSchedule` per
//      devstore row 50) in the same instant, so which one actually
//      carried this particular todo is not observable from outside and
//      not the claim. The claim is the RECOVERY, not the channel.
//   6. Convergence both ways after recovery: a todo authored on B
//      reaches A, bounded by the flush debounce (20s) plus the pull
//      cadence (45s) plus margin (SYNC.md §2-3).
//
// DISCIPLINE — CHECKPOINT BEFORE THE DELIBERATE KILL, and say what that
// buys and what it does not: beat 5's claim is about CHECKPOINTED
// state, so beat 1's live-convergence todo is followed by an explicit
// `checkpoint` hook call (solo-offline-sync's idiom, cited there)
// before B's host is killed in beat 2. What this scenario does NOT
// claim: state written in the final ~500ms trailing debounce window
// before an eviction is honestly NOT guaranteed to survive it — that is
// devstore row 17's discipline ("what is checkpointed survives a crash
// and what is inside the open window may not") and row 53's own report
// of an in-flight write racing the same kill this scenario uses. This
// scenario checkpoints first specifically so it is not making a claim
// that discipline would falsify.
//
// SYNTHETIC LABELED VALUES THROUGHOUT: the client pair below is
// obviously-fake app identity for an in-process fake, issued by nobody.

import type { Browser, Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, createAccount, pairPages, solo, until, WAITS } from "../solo-util.ts";
import { startFakeDrive } from "../../host/fake-drive.ts";

const ROOT = "pm-worker-eviction";
const CLIENT_ID = "SYNTHETIC-EVICTION-CLIENT";
const CLIENT_SECRET = "synthetic-eviction-client-secret-0000";

/** The live-convergence todo, authored before anything dies. */
const TODO_BEFORE = "todo authored before the eviction";
/** Authored on A while B's host is dead — the crossing beat 5 claims. */
const TODO_DURING_DEATH = "todo A wrote while B's host was dead";
/** Authored on B after its reload, to prove the OTHER direction still
 * works post-recovery. */
const TODO_AFTER_RECOVERY = "todo B wrote after its own recovery";

/** How long the scheduled flush may take: SYNC.md §3's ~20s trailing
 * debounce plus room for the cycle itself and a busy CI box (same
 * derivation as solo-offline-sync's `FLUSH_WAIT`). */
const FLUSH_WAIT = 60_000;
/** How long a convergence may take after recovery: the 20s flush
 * debounce plus the 45s pull cadence (SYNC.md §2) plus margin for a
 * second cadence tick if the first lands mid-boot. */
const CONVERGE_AFTER_RECOVERY = 100_000;
/** Bounded poll for the CDP-observed kill and lock/target settling —
 * not a sleep: devstore row 51 measured the platform's own release as
 * fast but UNSPECIFIED, so this scenario polls rather than guesses a
 * constant. */
const KILL_POLL_MS = 50;
const KILL_POLL_DEADLINE_MS = 5_000;

interface WorkerTarget {
  targetId: string;
  title: string;
  url: string;
}

/** Every `shared_worker` CDP target titled `pm-device-<deviceId>` —
 * `Target.getTargets` is browser-wide, so this is not scoped to one
 * page. COPIED FROM devstore's `sharedWorkersFor`
 * (runtime/tests/devstore/run.ts:105-117) and demo/e2e/cdp.ts's
 * `listSharedWorkers` (:43-55), with ONE difference from cdp.ts's
 * exported helper: cdp.ts's `killSharedWorker` matches by URL
 * substring, which cannot tell two devices' hosts apart because every
 * solo/demo page runs the identical `./worker.js` script (cdp.ts's own
 * banner names this as the reason its sequence needed re-deriving for
 * a multi-device scenario) — client.ts instead names the SharedWorker
 * itself `pm-device-<deviceId>`, which is what the CDP target's TITLE
 * carries. SUGGESTED GENERALIZATION for cdp.ts: a title-matching
 * sibling to `killSharedWorker` would let any multi-device scenario do
 * this without a scenario-local copy — flagged in this track's report
 * rather than added here, since cdp.ts is owned by another track this
 * wave. Detaches its own browser-level CDP session in a `finally`,
 * cdp.ts's own reason: a caller that polls this repeatedly must not
 * accumulate one session per call. */
async function sharedWorkersByTitle(browser: Browser, title: string): Promise<WorkerTarget[]> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets") as {
      targetInfos: (WorkerTarget & { type: string })[];
    };
    return targetInfos
      .filter((t) => t.type === "shared_worker" && t.title === title)
      .map((t) => ({ targetId: t.targetId, title: t.title, url: t.url }));
  } finally {
    await cdp.detach().catch(() => { /* already gone */ });
  }
}

/** Kill the SharedWorker titled `pm-device-<deviceId>` via CDP
 * `Target.closeTarget` — no attach/evaluate fallback needed, per
 * demo/e2e/cdp.ts's own spike finding (its banner, and devstore row 51
 * re-confirming it for exactly this kind of target) that closeTarget
 * alone is sufficient. Throws, NAMING the live titles, if none matches:
 * a scenario claiming "the host died with no goodbye" must fail loudly
 * rather than silently killing the wrong thing (or nothing) if the
 * naming ever drifts. Also throws, naming every MATCHING target, if
 * more than one comes back: the claim this helper is built on is that
 * the title picks out ONE device's host (client.ts's "the name is the
 * device"), and killing `targets[0]` of an unasserted multi-match would
 * silently kill an arbitrary one of them rather than surface that the
 * naming assumption had broken. */
async function killWorkerByDeviceId(browser: Browser, deviceId: string): Promise<WorkerTarget> {
  const title = `pm-device-${deviceId}`;
  const targets = await sharedWorkersByTitle(browser, title);
  if (targets.length === 0) {
    const cdp = await browser.newBrowserCDPSession();
    let live = "";
    try {
      const { targetInfos } = await cdp.send("Target.getTargets") as {
        targetInfos: { type: string; title: string }[];
      };
      live = JSON.stringify(
        targetInfos.filter((t) => t.type === "shared_worker").map((t) => t.title),
      );
    } finally {
      await cdp.detach().catch(() => { /* already gone */ });
    }
    throw new Error(`no shared worker titled ${JSON.stringify(title)} — live: ${live}`);
  }
  if (targets.length > 1) {
    throw new Error(
      `expected exactly one shared worker titled ${JSON.stringify(title)}, found ` +
        `${targets.length}: ${JSON.stringify(targets.map((t) => t.targetId))} — the title is ` +
        `supposed to pick out ONE device's host (client.ts), so more than one match means the ` +
        `naming assumption this helper relies on has broken`,
    );
  }
  const target = targets[0];
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await cdp.detach().catch(() => { /* already gone */ });
  }
  return target;
}

/** Bounded poll for the killed target to actually stop appearing in
 * `Target.getTargets` — verifying the kill rather than trusting that
 * `Target.closeTarget` returning is the same thing as the target being
 * gone (cdp.ts's spike measured them as effectively simultaneous, but
 * this scenario checks its OWN kill rather than importing that
 * measurement as a given). */
async function untilWorkerGone(
  browser: Browser,
  deviceId: string,
): Promise<{ gone: boolean; waitedMs: number; polls: number }> {
  const title = `pm-device-${deviceId}`;
  const started = Date.now();
  const deadline = started + KILL_POLL_DEADLINE_MS;
  let polls = 0;
  for (;;) {
    polls++;
    const targets = await sharedWorkersByTitle(browser, title);
    if (targets.length === 0) return { gone: true, waitedMs: Date.now() - started, polls };
    if (Date.now() >= deadline) return { gone: false, waitedMs: Date.now() - started, polls };
    await new Promise((r) => setTimeout(r, KILL_POLL_MS));
  }
}

/** Keep a device (until-reseal), so it is on the picker for a page that
 * did not exist when the device was made. COPIED from
 * solo-offline-sync.ts's `keepDevice` (same ceremony, same reasoning: a
 * T0 device is reached through the tab's own sessionStorage anchor,
 * which a reload keeps but a picker-driven respawn after eviction needs
 * the "kept" tier to still find). */
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

/** Leave the storage sheet the way a user does. COPIED from
 * solo-offline-sync.ts's `closeStorageSheet` (same reason: the drawer is
 * a chrome-owned tenant over the app surface and must not sit between
 * the driver and the todo input it types into next). */
async function closeStorageSheet(page: Page): Promise<void> {
  await page.click('#storage-sheet button:text-is("Close")');
  await page.waitForSelector("#storage-sheet", { state: "detached", timeout: 15_000 });
}

const scenario: Scenario = {
  name: "worker-eviction",
  why:
    "one device's SharedWorker is evicted with no goodbye while its sibling keeps working; the user's own recovery (reload) brings the same device back from its checkpoint, and the account converges again — the product-level story over runtime/tests/devstore/run.ts rows 51-56",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },
  // Two live-relay pull cadences (45s each) legitimately fit inside this
  // scenario's own waits (beats 5 and 6); the suite-wide deadline was
  // never sized for that (run.ts's own comment on this field).
  deadlineMs: 360_000,

  async run(pageA: Page, ctx: Ctx) {
    const fake = await startFakeDrive();
    try {
      let deviceIdB = "";
      // Assigned inside beat 1 (ctx.fresh mints it) and read by every
      // later beat — declared here so the whole scenario shares ONE
      // page object for B rather than re-deriving it.
      let pageB!: Page;

      await act("A creates the account, binds Drive, and B pairs in and adopts it", async () => {
        await createAccount(pageA);
        await keepDevice(pageA, "laptop");

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
        // Clicked through evaluate, solo-gdrive.ts's reason: the sheet
        // renders taller than the viewport with both providers' fields
        // present, which Playwright's actionability check reads as
        // out-of-viewport.
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
        await closeStorageSheet(pageA);

        pageB = await ctx.fresh({
          path: "/solo.html",
          bootGlobal: "__solo",
          storage: { [SOLO_KEYS.hue]: "265" },
        });
        assertEquals(await solo(pageB, "hasAccount"), false, "B starts with no account");
        await pairPages(pageA, pageB, "the other tab");
        await until(
          [pageA, pageB],
          "B's account",
          async () => await solo(pageB, "hasAccount"),
          WAITS.enrolled,
        );
        await keepDevice(pageB, "phone");
        deviceIdB = (await solo(pageB, "deviceId")) as string;
        assert(deviceIdB.length > 0, "B's deviceId is the honest hook, not guessed");

        // B ADOPTS THE STORE — nothing typed but the consent
        // (solo-account-storage's claim; a precondition here).
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
        await closeStorageSheet(pageB);

        // LIVE CONVERGENCE, proven before anything dies: a todo authored
        // on A reaches B over the relay, both still up.
        await addTodo(pageA, TODO_BEFORE);
        await until([pageA, pageB], "B has A's pre-eviction todo", async () => {
          const t = (await solo(pageB, "todos").catch(() => [])) as string[];
          return t.includes(TODO_BEFORE) ? t : false;
        }, WAITS.converge);
        // RENDERED, not just in the engine's own record — beat 3 later
        // claims this row is STILL painted after B's host dies, which is
        // only a claim worth making if it was painted here first.
        await appFrame(pageB).locator("ul.todo-list li").filter({ hasText: TODO_BEFORE })
          .first().waitFor({ state: "visible", timeout: WAITS.converge });

        // CHECKPOINT ON PURPOSE before anything is deliberately killed —
        // beat 5's claim is about CHECKPOINTED state (devstore row 53),
        // and this is what makes it that claim rather than a race with
        // the trailing debounce (row 17's discipline).
        await solo(pageB, "checkpoint");
      });

      await act("B's SharedWorker is EVICTED by CDP, with no goodbye", async () => {
        const killed = await killWorkerByDeviceId(ctx.browser, deviceIdB);
        assertEquals(
          killed.title,
          `pm-device-${deviceIdB}`,
          "the target killed was titled for B's own device, not guessed",
        );
        const gone = await untilWorkerGone(ctx.browser, deviceIdB);
        assert(
          gone.gone,
          `B's shared worker target must disappear from Target.getTargets ` +
            `(${gone.waitedMs}ms, ${gone.polls} poll(s), bounded ${KILL_POLL_DEADLINE_MS}ms) — ` +
            `devstore row 51's own instrument, reused here to verify THIS kill rather than ` +
            `trust the earlier measurement`,
        );
      });

      await act(
        "what the user sees on B: the tab is NOT blank — the app frame and its rows are still there",
        async () => {
          // DELIBERATELY DOM-ONLY. Devstore row 52b measured that any RPC
          // against B's engine now hangs until the client's OWN timeout
          // deadline (there is no peer-death event to shortcut it, per
          // row 52) — so this act does not drive a single solo hook that
          // would reach the dead worker. It reads the DOM a user's eyes
          // would read: the sandboxed app frame is still mounted, and the
          // pre-eviction todo row is still painted, because a dead
          // SharedWorker does not un-paint the tab that was talking to
          // it.
          const frameStillThere = await pageB.evaluate(() =>
            document.querySelector("#solo-app iframe") !== null
          );
          assert(frameStillThere, "B's app frame is still mounted in the DOM after the eviction");
          // A generous timeout, still DOM-only (no hook is driven to get
          // here): the row was already rendered before the kill, so this
          // is checking it is still there, not waiting for anything new
          // to happen — the deadline only needs to outlast Playwright's
          // own frame-attachment bookkeeping on a loaded CI box.
          await appFrame(pageB).locator("ul.todo-list li").filter({ hasText: TODO_BEFORE })
            .first()
            .waitFor({ state: "visible", timeout: WAITS.converge });
        },
      );

      await act("A authors a todo while B's host is dead — invisible to A", async () => {
        const syncBefore = await solo(pageA, "syncStatus");
        assert(syncBefore !== null, "A is bound, so it has a sync record");
        await addTodo(pageA, TODO_DURING_DEATH);
        const synced = await until([pageA], "A's SCHEDULED flush completes", async () => {
          const s = await solo(pageA, "syncStatus");
          return s !== null && s.lastFlush !== null &&
              (s.lastFlush as number) > ((syncBefore.lastFlush as number | null) ?? -1)
            ? s
            : false;
        }, FLUSH_WAIT);
        assertEquals(
          synced.flushFailures,
          0,
          `A's own schedule stayed healthy through B's death: ${JSON.stringify(synced)}`,
        );
      });

      let arrivedVia = "unknown";
      await act("B RELOADS — the ordinary user recovery — and comes back from its checkpoint", async () => {
        await pageB.reload({ waitUntil: "domcontentloaded" });
        await waitForBoot(pageB, "__solo");

        const trace = (await solo(pageB, "bootTrace")) as string[];
        assert(
          trace.includes("auto-unseal"),
          `B reopened its KEPT device through the anchor, not a fresh one: ${JSON.stringify(trace)}`,
        );
        assert(
          trace.includes("account:resumed"),
          `B resumed onto its account rather than a first-run fork: ${JSON.stringify(trace)}`,
        );
        assertEquals(
          (await solo(pageB, "deviceId")) as string,
          deviceIdB,
          "the SAME device came back, not a new one with the same petname",
        );
        assertEquals(
          (await solo(pageB, "storageStatus"))?.root,
          ROOT,
          "the storage binding came back with the device — re-applied at bring-up, no re-entry",
        );

        // THE PRE-EVICTION TODO IS STILL THERE — the checkpoint beat 1
        // took, not a re-derivation from A over the wire (B held this
        // one before it ever died).
        assert(
          ((await solo(pageB, "todos")) as string[]).includes(TODO_BEFORE),
          "B's checkpointed pre-eviction todo survived the crash",
        );

        // THE CLAIM: A's todo, authored while B was dead, is on B now.
        // CHANNEL-AGNOSTIC ON PURPOSE — a respawned worker re-arms BOTH
        // its resumed relay wire and its zero-delay boot pull
        // (worker.ts's `startSyncSchedule`, devstore row 50) in the same
        // instant, so which one actually carried this particular todo is
        // not observable from outside this scenario and is not the
        // claim being made. The claim is the RECOVERY.
        let lastSync: unknown = null;
        const titles = await until([pageB], "A's todo on B, after B's own recovery", async () => {
          const t = (await solo(pageB, "todos").catch(() => [])) as string[];
          lastSync = await solo(pageB, "syncStatus").catch((e) => String(e));
          return t.includes(TODO_DURING_DEATH) ? t : false;
        }, WAITS.converge).catch((e) => {
          throw new Error(
            `${(e as Error).message}; B's sync record says ${JSON.stringify(lastSync)}; ` +
              `bootTrace: ${JSON.stringify(trace)}`,
          );
        });
        assert(titles.includes(TODO_DURING_DEATH), `B holds A's todo: ${JSON.stringify(titles)}`);
        await appFrame(pageB).locator("ul.todo-list li").filter({ hasText: TODO_DURING_DEATH })
          .first().waitFor({ state: "visible", timeout: WAITS.converge });

        // REPORTED, NOT ASSERTED (the claim is channel-agnostic): which
        // path was actually live when the todo showed up, for the
        // report's own "what arrived by" question.
        const syncNow = await solo(pageB, "syncStatus").catch(() => null);
        arrivedVia = syncNow && (syncNow as { lastPull?: unknown }).lastPull !== null
          ? "bucket pull stamped (and/or relay — both re-arm on respawn; see banner)"
          : "no pull stamped yet — most likely the resumed relay wire";
      });

      await act("convergence both ways after recovery: a todo from B reaches A", async () => {
        await addTodo(pageB, TODO_AFTER_RECOVERY);
        await until([pageB, pageA], "A has B's post-recovery todo", async () => {
          const t = (await solo(pageA, "todos").catch(() => [])) as string[];
          return t.includes(TODO_AFTER_RECOVERY) ? t : false;
        }, CONVERGE_AFTER_RECOVERY);
        await appFrame(pageA).locator("ul.todo-list li").filter({
          hasText: TODO_AFTER_RECOVERY,
        }).first().waitFor({ state: "visible", timeout: WAITS.converge });
      });

      console.log(`worker-eviction: beat 5's todo arrived via — ${arrivedVia}`);
    } finally {
      await fake.close();
    }
  },
};

export default scenario;
