// A SEEDED CONVERGENCE SOAK — the interleavings nobody wrote down.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────
//
// Every other scenario in this suite pins ONE fault shape, in one
// order, chosen by whoever wrote it: the store dies and comes back
// (store-outage-recovery), the relay dies and does not heal
// (relay-partition, xfail), both pages reload (solo-resume-sync), one
// page closes and reopens (solo-offline-sync). Each of those is a
// hand-picked point in a space of orderings, and the points a human
// picks are the ones a human already thought of. The bugs that survive
// a suite like that are the ones that need a store outage DURING a
// worker eviction, or a reload that lands between a mutation and its
// debounced flush.
//
// So this scenario does not pick. A seeded PRNG draws a sequence of
// faults and edits against a two-device account, the world is then
// healed completely, and convergence is DEMANDED. The seed is printed
// loudly at the start and comes from the environment, so a nightly
// failure is reproducible by one number rather than by a story.
//
// ─── THE WORLD, AND WHY CONVERGENCE IS EVEN ACHIEVABLE ───────────────
//
// A creates the account and binds the in-process fake Drive; B pairs,
// adopts the account's storage with a consent click, and BOTH DEVICES
// ARE KEPT. Both pages stay open for the whole soak (except where a
// step deliberately closes one and reopens it).
//
// THE BUCKET IS THE CHANNEL THIS SCENARIO RELIES ON, not the relay
// wires. runtime/SYNC.md §2 gives every unsealed device a pull at
// bring-up and then a 45 s cadence, and §3 gives it a 20 s trailing
// debounced flush armed by its own mutations — so two devices bound to
// one account's bucket converge THROUGH THE STORE whatever state their
// peer wires are in. That matters because of the gap
// scenarios/relay-partition.ts pins (`expected: "red"`): relay wires
// between two LIVE paired pages never re-dial after a relay outage —
// a ceremony-time wire is not re-entered, and `conn-status` never
// learns the wire died. This soak therefore NEVER asserts relay-path
// recovery. It stops and starts the relay because that is a fault a
// real user's network produces, and it demands only what the bucket
// can carry.
//
// ─── THE ORACLE ──────────────────────────────────────────────────────
//
// Every authored todo is CHECKPOINTED on the authoring device the
// instant it is typed. That is what makes "no todo was ever lost" a
// fair demand: devstore row 17 records that up to 500 ms of
// un-checkpointed final state is honestly lost by design (the
// checkpoint debounce), so an oracle that authored and immediately
// killed a worker would be pinning a designed loss as a bug. Removing
// that legitimate loss from the equation is the whole reason the
// author step is "add, then checkpoint" rather than "add".
//
// After the last step the world is healed (store refusals off, relay
// up) and BOTH PAGES RELOAD — the both-sides reload is the RECOVERED
// wiring path per solo-resume-sync.ts, and it is also what tears both
// SharedWorker hosts down with their last client, so each device's
// sync schedule comes back with its backoff counters at zero rather
// than mid-way up SYNC.md §3's 10-minute cap. Then, within a bound
// derived from the constants, all three of:
//
//   1. both devices hold the IDENTICAL todo set;
//   2. that set contains EVERY authored todo (count and titles);
//   3. both devices' `syncStatus` reports flushFailures 0, pullFailures
//      0, and a stamped lastFlush and lastPull.
//
// A failure attaches the full diagnosis — seed, step log, both todo
// lists, both sync records — because a nightly red run has no human
// watching it happen.
//
// ─── HOW TO RUN IT ───────────────────────────────────────────────────
//
//   deno run -A e2e/run.ts --file scenarios/convergence-soak.ts
//   PM_SOAK_SEED=1 PM_SOAK_STEPS=10 deno run -A e2e/run.ts --file …
//
// Deliberately NOT registered in run.ts's SCENARIOS: it is a soak, not
// a per-PR gate. .github/workflows/soak.yml runs it nightly and on
// demand with a seed.
//
// SYNTHETIC LABELED VALUES THROUGHOUT: the client pair below is
// obviously-fake app identity for an in-process fake, issued by nobody.

import type { Page } from "npm:playwright@1.57.0";
import type { Browser } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import {
  addTodo,
  appFrame,
  createAccount,
  pairPages,
  solo,
  until,
  WAITS,
} from "../solo-util.ts";
import { startFakeDrive } from "../../host/fake-drive.ts";

const ROOT = "pm-convergence-soak";
const CLIENT_ID = "SYNTHETIC-SOAK-CLIENT";
const CLIENT_SECRET = "synthetic-soak-client-secret-0000";

// --- the seed, the step count, and the arithmetic they drive ---------------

/** Decimal, from the environment; otherwise a fresh draw off the clock
 * masked to 32 bits (what mulberry32 consumes). Read at module load
 * because `deadlineMs` — a Scenario FIELD, read by the runner before
 * `run` is called — depends on the step count. */
const SEED = ((): number => {
  const raw = Deno.env.get("PM_SOAK_SEED");
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? (n >>> 0) : (Date.now() & 0xffffffff) >>> 0;
})();

const STEPS = ((): number => {
  const raw = Deno.env.get("PM_SOAK_STEPS");
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 18;
})();

/** THREE TERMS, and each one is a different part of the run.
 *
 *   SETUP (180 s): the four acts before the first step — the pairing
 *     ceremony over the relay, A's full storage-sheet ceremony, B's
 *     adopt, and two keep-this-device promotions. None of that rides on
 *     the step budget, and folding it in there would silently shrink
 *     the per-step allowance as PM_SOAK_STEPS grew.
 *   STEPS (30 s each): the slowest action is a reload or a
 *     close-and-reopen — a real navigation, a torn-down SharedWorker,
 *     an engine resumed from a checkpoint and an app remounted. 30 s is
 *     generous for that on a busy CI box; every other action is far
 *     cheaper.
 *   QUIESCENCE (300 s): the heal, the two reloads and the convergence
 *     wait — QUIESCE_MS (240 s) plus room for the reloads in front of
 *     it.
 *
 * Capped at 20 minutes so a large PM_SOAK_STEPS cannot ask the runner
 * for an unbounded afternoon. */
const DEADLINE_MS = Math.min(180_000 + STEPS * 30_000 + 300_000, 1_200_000);

/** THE CONVERGENCE BOUND, from runtime/SYNC.md's own constants rather
 * than from taste: one 20 s trailing flush debounce (§3) plus one 45 s
 * pull cadence (§2) plus the two page boots the heal performs, plus
 * margin for a loaded box and for the flush/pull phases landing in the
 * unlucky order (a pull that ticks just BEFORE the sibling's flush
 * commits waits a whole further cadence). 20+45+45+90 ≈ 200; 240 s. */
const QUIESCE_MS = 240_000;

// --- the PRNG --------------------------------------------------------------

/**
 * mulberry32 — a 32-bit seeded generator, inline and tiny because the
 * only property this soak needs from it is REPRODUCIBILITY: the same
 * seed must draw the same action sequence on any machine, so a nightly
 * failure can be replayed by number. (Public-domain snippet, Tommy
 * Ettinger's mulberry32; it is not and must not be used for anything
 * that needs unpredictability.)
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the action alphabet ---------------------------------------------------
//
// WEIGHTS ARE TUNED FOR INTERESTING RUNS THAT STILL FINISH. Authoring
// dominates because a step that writes nothing can neither lose nor
// converge anything — every other action is only interesting in
// relation to work that has to survive it. Reloads and store faults are
// the middle tier (they are the cheap, high-yield interleavings: a
// navigation landing inside a debounce window, an outage landing inside
// a flush). The three expensive or narrow ones — relay stop/start,
// worker eviction, close-and-reopen — are rare on purpose: each costs
// most of a step budget in wall time, and their VALUE is in landing
// unpredictably next to the others rather than in being frequent.

type ActionName =
  | "authorA"
  | "authorB"
  | "reloadA"
  | "reloadB"
  | "storeFault"
  | "storeHeal"
  | "relayStop"
  | "relayStart"
  | "evictB"
  | "closeReopenB";

const WEIGHTS: [ActionName, number][] = [
  ["authorA", 5],
  ["authorB", 5],
  ["reloadA", 2],
  ["reloadB", 2],
  ["storeFault", 2],
  ["storeHeal", 2],
  ["relayStop", 1],
  ["relayStart", 1],
  ["evictB", 1],
  ["closeReopenB", 1],
];
const TOTAL_WEIGHT = WEIGHTS.reduce((n, [, w]) => n + w, 0);

/** ONE DRAW PER STEP, unconditionally — the determinism gate depends on
 * it. Nothing in this scenario may consume the generator based on
 * observed state (a re-draw when an action "does not apply" would make
 * the sequence depend on timing, and the seed would stop being a
 * reproduction recipe). Every action below is therefore written to be
 * meaningful — or harmlessly idempotent — in any world state. */
function drawAction(rand: () => number): ActionName {
  let x = rand() * TOTAL_WEIGHT;
  for (const [name, w] of WEIGHTS) {
    x -= w;
    if (x < 0) return name;
  }
  return WEIGHTS[WEIGHTS.length - 1][0];
}

// --- CDP: killing a device's SharedWorker by TITLE -------------------------
//
// COPIED, NOT IMPORTED, from runtime/tests/devstore/run.ts:101-144
// (`sharedWorkersFor` / `killWorkerFor`), which in turn lifted the kill
// sequence from demo/e2e/cdp.ts:43-86 with the same one change this
// scenario needs: THE SELECTOR IS THE TARGET'S TITLE, NOT ITS URL.
// demo/e2e/cdp.ts's `killSharedWorker` matches on a URL substring, and
// both devices here run the same `./solo-worker.js`, so a URL match
// cannot tell A's host from B's. The title is the SharedWorker's NAME,
// which runtime/device-store/client.ts:411-413 sets to
// `nsDbName(deviceId)` — `pm-device-<id>` on the shared_worker target
// info. The kill itself is cdp.ts's spike finding, relied on and
// re-confirmed by devstore row 51: `Target.closeTarget` on a
// `shared_worker` target terminates it, with no attach/evaluate
// fallback needed.

interface WorkerTarget {
  targetId: string;
  title: string;
}

/** Every `shared_worker` target hosting THIS device. Browser-wide —
 * `Target.getTargets` is not scoped to a page — and it detaches its own
 * browser-level session in a `finally`, cdp.ts's reason: a soak that
 * calls this once per eviction must not accumulate CDP sessions. */
async function sharedWorkersFor(
  browser: Browser,
  deviceId: string,
): Promise<WorkerTarget[]> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets") as {
      targetInfos: { targetId: string; type: string; title: string }[];
    };
    return targetInfos
      .filter((t) =>
        t.type === "shared_worker" && t.title === `pm-device-${deviceId}`
      )
      .map((t) => ({ targetId: t.targetId, title: t.title }));
  } finally {
    await cdp.detach().catch(() => {/* already gone */});
  }
}

/** Terminate the SharedWorker hosting this device, NAMING what is live
 * when the match is not exactly one: a step whose whole subject is "the
 * host died" must fail loudly rather than quietly kill nothing — or
 * quietly kill an arbitrary one of several. */
async function killWorkerFor(
  browser: Browser,
  deviceId: string,
): Promise<WorkerTarget> {
  const targets = await sharedWorkersFor(browser, deviceId);
  if (targets.length !== 1) {
    // NEITHER ZERO NOR TWO. Zero means the step's whole subject —
    // "the host died" — would be a no-op quietly reported as done. TWO
    // means the title match is no longer the identity it is documented
    // to be (one SharedWorker per device namespace), and killing an
    // arbitrary one of them would make the step mean something nobody
    // wrote down. Both fail here, naming every live shared_worker.
    const all = await browser.newBrowserCDPSession();
    let live = "";
    try {
      const { targetInfos } = await all.send("Target.getTargets") as {
        targetInfos: { type: string; title: string }[];
      };
      live = JSON.stringify(
        targetInfos.filter((t) => t.type === "shared_worker").map((t) =>
          t.title
        ),
      );
    } finally {
      await all.detach().catch(() => {});
    }
    throw new Error(
      `expected exactly one shared worker for device ${deviceId}, found ${targets.length}` +
        ` — live shared workers: ${live}`,
    );
  }
  const target = targets[0];
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await cdp.detach().catch(() => {});
  }
  return target;
}

// --- the two ceremonies this soak needs as PRECONDITIONS -------------------
//
// Both are claims elsewhere (solo-persistence's promotion,
// solo-account-storage's adopt); here they are setup, driven the way
// solo-offline-sync.ts drives them.

/** Keep a device, so it survives its page being closed entirely — a T0
 * device is reachable only through the tab's own sessionStorage anchor,
 * which a NEW page does not have. `closeReopenB` depends on this. */
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
    const ds = (await solo(page, "devices").catch(() => [])) as {
      tier: string;
    }[];
    return ds.find((d) => d.tier === "t1") ?? false;
  }, 30_000);
}

/** Leave the storage sheet the way a user does — its own Close button.
 * The drawer is a chrome-owned tenant over the app surface, so a sheet
 * left standing would sit between the driver and the todo input. */
async function closeStorageSheet(page: Page): Promise<void> {
  await page.click('#storage-sheet button:text-is("Close")');
  await page.waitForSelector("#storage-sheet", {
    state: "detached",
    timeout: 15_000,
  });
}

// --- the devices, as the soak moves them around ---------------------------

interface Device {
  readonly who: "A" | "B";
  /** Replaced by `closeReopenB`, which opens a NEW page in the same
   * context — so every step reads this through the record rather than
   * closing over a page handle. */
  page: Page;
  /** The opaque device id, for the eviction's title match. Re-read and
   * COMPARED after every reload, eviction and reopen (`sameDevice`
   * below): a move that came back as a DIFFERENT device would be a
   * broken kept-device story, and it would be absorbed silently
   * otherwise — the bucket can still converge two devices that were
   * never meant to be two, and the next eviction would simply track
   * whatever id came back. */
  id: string;
}

const scenario: Scenario = {
  name: "convergence-soak",
  why:
    "a seeded random interleaving of faults and edits against two paired devices still converges: identical todo sets, nothing lost, both schedules healthy",
  deadlineMs: DEADLINE_MS,
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },

  async run(pageA: Page, ctx: Ctx) {
    // LOUD, AND FIRST. A nightly failure's log must open with the one
    // number that replays it.
    console.log(
      `\n         ══ SOAK: seed ${SEED}, ${STEPS} steps ══\n` +
        `         reproduce with PM_SOAK_SEED=${SEED} PM_SOAK_STEPS=${STEPS}\n`,
    );

    const rand = mulberry32(SEED);
    /** The step log, printed as it runs AND attached to any failure: a
     * failed nightly run's log has to read as a reproduction recipe. */
    const stepLog: string[] = [];
    /** Every todo this soak ever authored, in order. The oracle's
     * "nothing lost" half is exactly this list. */
    const authored: string[] = [];

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

      const pageB0 = await ctx.fresh({
        path: "/solo.html",
        bootGlobal: "__solo",
        storage: { [SOLO_KEYS.hue]: "265" },
      });
      // B'S OWN CONTEXT AND URL, captured now: `closeReopenB` reopens a
      // new PAGE in this same context (the device store lives in the
      // context's storage partition, so a new context would be a new
      // device and the soak would be asserting nothing).
      const ctxB = pageB0.context();
      const urlB = pageB0.url();

      await act(
        "B pairs into A's account over the relay, and is KEPT too",
        async () => {
          assertEquals(
            await solo(pageB0, "hasAccount"),
            false,
            "B starts with no account",
          );
          await pairPages(pageA, pageB0, "the other tab");
          await until(
            [pageA, pageB0],
            "B's account",
            async () => await solo(pageB0, "hasAccount"),
            WAITS.enrolled,
          );
          await keepDevice(pageB0, "phone");
        },
      );

      await act(
        "A binds the fake Drive through the full sheet ceremony",
        async () => {
          await solo(pageA, "setGdriveEndpoints", {
            apiBase: fake.url,
            authUrl: `${fake.url}/auth`,
            tokenUrl: `${fake.url}/token`,
          });
          await pageA.evaluate(() => {
            (document.getElementById("visor-settings") as
              | HTMLButtonElement
              | null)?.click();
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
          await pageA.waitForSelector("#storage-kind-gdrive", {
            timeout: 15_000,
          });
          // Clicked through evaluate for solo-gdrive.ts's reason: the sheet
          // renders taller than the viewport with both providers' fields in
          // the DOM, which Playwright reads as out-of-viewport.
          await pageA.evaluate(() => {
            (document.getElementById("storage-kind-gdrive") as HTMLInputElement)
              .click();
          });
          await pageA.waitForSelector("#storage-gd-root", {
            state: "visible",
            timeout: 15_000,
          });
          await pageA.fill("#storage-gd-root", ROOT);
          await pageA.fill("#storage-gd-client", CLIENT_ID);
          await pageA.fill("#storage-gd-secret", CLIENT_SECRET);
          await pageA.click("#storage-connect");
          await until([pageA], "A's storage:bound", async () => {
            const t = (await solo(pageA, "bootTrace")) as string[];
            return t.includes("storage:bound") ? t : false;
          }, 60_000);
          await closeStorageSheet(pageA);
        },
      );

      await act(
        "B ADOPTS the account's store — nothing typed but the consent",
        async () => {
          await solo(pageB0, "setGdriveEndpoints", {
            authUrl: `${fake.url}/auth`,
            tokenUrl: `${fake.url}/token`,
          });
          await pageB0.evaluate(() => {
            (document.getElementById("visor-settings") as
              | HTMLButtonElement
              | null)?.click();
          });
          await pageB0.waitForFunction(
            () =>
              document.querySelector(
                '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
              ) !== null,
            undefined,
            { timeout: 15_000 },
          );
          await solo(pageB0, "openStorageSheet");
          await pageB0.waitForSelector("#storage-lead", { timeout: 15_000 });
          await until(
            [pageB0],
            "B's adopt view",
            async () =>
              await pageB0.evaluate(() =>
                (document.getElementById("storage-lead")?.textContent ?? "")
                  .startsWith(
                    "Your account syncs",
                  )
              ),
            15_000,
          );
          await pageB0.click("#storage-connect");
          await until([pageB0], "B's storage:bound", async () => {
            const t = (await solo(pageB0, "bootTrace")) as string[];
            return t.includes("storage:bound") ? t : false;
          }, 60_000);
          assertEquals(
            (await solo(pageB0, "storageStatus")).root,
            ROOT,
            "B is pointed at the account's folder",
          );
          await closeStorageSheet(pageB0);
        },
      );

      const A: Device = {
        who: "A",
        page: pageA,
        id: (await solo(pageA, "deviceId")) as string,
      };
      const B: Device = {
        who: "B",
        page: pageB0,
        id: (await solo(pageB0, "deviceId")) as string,
      };
      const devices = () => [A, B];

      /** THE SAME DEVICE CAME BACK, not a new one wearing the same
       * petname — asserted after every move that tears a device's page
       * (and its host) down: a reload, an eviction, a close-and-reopen.
       * The idiom is worker-eviction.ts:460-464's; here it also keeps
       * `dev.id` honest, since that id is what the next eviction's
       * title match selects on. A silent overwrite would absorb exactly
       * the failure this soak would otherwise be well placed to find. */
      const sameDevice = async (dev: Device, move: string) => {
        const now = (await solo(dev.page, "deviceId")) as string;
        assertEquals(
          now,
          dev.id,
          `${dev.who} came back from ${move} as the SAME device, not a new one`,
        );
        dev.id = now;
      };

      // --- the moves ------------------------------------------------------

      /** AUTHOR, THEN CHECKPOINT IMMEDIATELY. The checkpoint is what
       * makes "nothing was lost" a fair oracle rather than a demand
       * that the checkpoint debounce (500 ms, devstore row 17) be
       * instantaneous — see the banner. */
      const author = async (dev: Device, step: number) => {
        const title = `soak-${step}-${dev.who}`;
        await addTodo(dev.page, title);
        await solo(dev.page, "checkpoint");
        authored.push(title);
      };

      /** A REAL NAVIGATION: the page and the device's SharedWorker both
       * go, and the engine below comes back from a checkpoint. The
       * device must RESUME onto its account rather than land on the
       * first-run fork — that is the assertion that makes this a move
       * rather than a sleep. */
      const reload = async (dev: Device) => {
        await solo(dev.page, "checkpoint").catch(
          () => {/* a dead host cannot checkpoint */},
        );
        await dev.page.reload({ waitUntil: "domcontentloaded" });
        await waitForBoot(dev.page, "__solo");
        const trace = (await solo(dev.page, "bootTrace")) as string[];
        assert(
          trace.includes("account:resumed"),
          `${dev.who} resumed onto its account after a reload: ${
            JSON.stringify(trace)
          }`,
        );
        await sameDevice(dev, "a reload");
      };

      /** THE EVICTION AND ITS RECOVERY ARE ONE ACTION. A dead host with
       * a LIVE tab is devstore rows 51-53's measured territory (the
       * lock, the respawn, what the tab can still answer) and is not
       * this soak's subject: what the soak wants is the interleaving in
       * which a device's worker dies mid-run and the device comes back.
       * No checkpoint before the kill — that is the point of the kill —
       * which is safe precisely because `author` checkpoints inline. */
      const evictAndReload = async (dev: Device) => {
        const killed = await killWorkerFor(ctx.browser, dev.id);
        stepLog.push(`           (killed shared_worker ${killed.title})`);
        await dev.page.reload({ waitUntil: "domcontentloaded" });
        await waitForBoot(dev.page, "__solo");
        const trace = (await solo(dev.page, "bootTrace")) as string[];
        assert(
          trace.includes("account:resumed"),
          `${dev.who} resumed after its host was evicted: ${
            JSON.stringify(trace)
          }`,
        );
        await sameDevice(dev, "an eviction");
      };

      /** solo-offline-sync.ts's beat-5 move: the page is CLOSED
       * entirely — not reloaded — and a new page opens in the SAME
       * context at the same URL, so the kept device comes back through
       * the picker and auto-unseals with no ceremony. */
      const closeReopen = async (dev: Device) => {
        await solo(dev.page, "checkpoint").catch(() => {});
        await dev.page.close();
        const next = await ctxB.newPage();
        await next.goto(urlB, { waitUntil: "domcontentloaded" });
        await waitForBoot(next, "__solo");
        dev.page = next;
        const trace = (await solo(next, "bootTrace")) as string[];
        assert(
          trace.includes("auto-unseal"),
          `${dev.who} reopened its KEPT device: ${JSON.stringify(trace)}`,
        );
        assert(
          trace.includes("account:resumed"),
          `${dev.who} reopened onto its account: ${JSON.stringify(trace)}`,
        );
        await sameDevice(dev, "a close-and-reopen");
      };

      /** CHEAP PER-STEP INVARIANTS, run after every action: neither page
       * died under us, and transport-refusal.ts's rule holds — a
       * transport failure is a sentence, never a wasm trap, anywhere on
       * the rendered document. */
      const invariants = async (step: number, action: string) => {
        for (const dev of devices()) {
          assert(
            !dev.page.isClosed(),
            `${dev.who}'s page is still open after step ${step} (${action})`,
          );
          const crashed = (dev.page as unknown as { __crashed?: () => boolean })
            .__crashed?.() === true;
          assert(
            !crashed,
            `${dev.who}'s renderer survived step ${step} (${action})`,
          );
          const body = await dev.page.evaluate(() => document.body.innerText);
          assert(
            !body.includes("Trap:"),
            `"Trap:" was rendered on ${dev.who} at step ${step} (${action}): ${
              JSON.stringify(body.split("\n").find((l) => l.includes("Trap:")))
            }`,
          );
        }
      };

      // --- the soak itself ------------------------------------------------

      await act(`${STEPS} seeded steps against the two devices`, async () => {
        for (let step = 1; step <= STEPS; step++) {
          const action = drawAction(rand);
          const line = `step ${String(step).padStart(3)}/${STEPS}: ${action}`;
          stepLog.push(line);
          console.log(`         ${line}`);
          switch (action) {
            case "authorA":
              await author(A, step);
              break;
            case "authorB":
              await author(B, step);
              break;
            case "reloadA":
              await reload(A);
              break;
            case "reloadB":
              await reload(B);
              break;
            case "storeFault":
              // An unbounded provider outage: every files-API call 503s
              // until it is healed. `n: Infinity` and `n: 0` are the
              // fake's ONE rule slot, so these two are idempotent —
              // which is why the draw never has to check the world.
              fake.failFiles({ n: Infinity, status: 503 });
              break;
            case "storeHeal":
              fake.failFiles({ n: 0 });
              break;
            case "relayStop":
              // The relay may already be down; `stopRelay` is
              // null-checked in the harness, so a second stop is a
              // no-op rather than an error. NOTHING here asserts that
              // relay-carried sync recovers afterwards — see the
              // banner's note on relay-partition.ts's pinned gap.
              await ctx.stopRelay();
              break;
            case "relayStart":
              await ctx.startRelay();
              break;
            case "evictB":
              await evictAndReload(B);
              break;
            case "closeReopenB":
              await closeReopen(B);
              break;
          }
          await invariants(step, action);
        }
      });

      // --- the heal, and the oracle ---------------------------------------

      /** Everything a failure needs to be diagnosed from a log file
       * alone: the seed, the sequence, what each device holds and what
       * each device's schedule says. */
      const diagnose = async (): Promise<string> => {
        const parts: string[] = [
          `seed=${SEED} steps=${STEPS}`,
          `step log:\n${stepLog.map((l) => `           ${l}`).join("\n")}`,
          `authored (${authored.length}): ${JSON.stringify(authored)}`,
        ];
        for (const dev of devices()) {
          const todos = await solo(dev.page, "todos").catch((e) =>
            `<${String(e)}>`
          );
          const sync = await solo(dev.page, "syncStatus").catch((e) =>
            `<${String(e)}>`
          );
          parts.push(`${dev.who} todos: ${JSON.stringify(todos)}`);
          parts.push(`${dev.who} sync: ${JSON.stringify(sync)}`);
        }
        return parts.join("\n         ");
      };

      await act(
        "the world HEALS and both pages reload — the recovered wiring path",
        async () => {
          fake.failFiles({ n: 0 });
          await ctx.startRelay();
          assertEquals(fake.refusalsPending(), 0, "the injected outage is off");
          // BOTH SIDES RELOAD. That is solo-resume-sync.ts's recovered
          // wiring path (each device reads its role out of the account's
          // device directory and re-dials or re-accepts), and reloading
          // only one would leave the other holding a stale handle that
          // `conn-status` will never invalidate (one-sided-reload.ts,
          // xfail). It is also what tears both SharedWorker hosts down
          // with their last client, so each schedule comes back with its
          // backoff counters at zero rather than part-way up SYNC.md §3's
          // 10-minute cap — which is what makes QUIESCE_MS a bound
          // derived from the cadences rather than from the cap.
          for (const dev of devices()) await reload(dev);
          // ONE FINAL TODO EACH, and it is not decoration: the flush half
          // of the schedule is EVENT-DRIVEN (worker.ts's
          // `startSyncSchedule` arms a PULL at boot and nothing else), so
          // a freshly reloaded device with no mutation would never stamp
          // `lastFlush` and the oracle's third clause would be asking for
          // something the design does not promise. These two are authored
          // like every other todo — checkpointed inline, counted in
          // `authored` — so they are also part of what must not be lost.
          await author(A, 0);
          await author(B, 0);
        },
      );

      await act(
        "both devices converge on the IDENTICAL set, with nothing lost",
        async () => {
          const want = [...authored].sort();
          const seen = await until(
            [A.page, B.page],
            "the two todo sets to agree",
            async () => {
              const ta = ((await solo(A.page, "todos")) as string[]).slice()
                .sort();
              const tb = ((await solo(B.page, "todos")) as string[]).slice()
                .sort();
              if (JSON.stringify(ta) !== JSON.stringify(tb)) return false;
              // EVERY authored todo, by title — a set that agreed on having
              // lost the same todo would pass the first clause alone.
              if (!want.every((t) => ta.includes(t))) return false;
              return { ta, tb };
            },
            QUIESCE_MS,
          ).catch(async (e) => {
            throw new Error(
              `${(e as Error).message}\n         ${await diagnose()}`,
            );
          });
          assertEquals(
            seen.ta.length,
            seen.tb.length,
            `both devices hold the same number of todos: ${await diagnose()}`,
          );
          assertEquals(
            authored.length,
            new Set(authored).size,
            "every authored title was unique, so the count comparison below means what it says",
          );
          assert(
            seen.ta.length >= authored.length,
            `no authored todo is missing (${authored.length} authored, ${seen.ta.length} held): ` +
              `${await diagnose()}`,
          );
        },
      );

      await act("and both schedules report themselves healthy", async () => {
        for (const dev of devices()) {
          const sync = await until(
            [A.page, B.page],
            `${dev.who}'s stamped flush and pull`,
            async () => {
              const s = await solo(dev.page, "syncStatus");
              return s !== null && s.lastFlush !== null && s.lastPull !== null
                ? s
                : false;
            },
            QUIESCE_MS,
          ).catch(async (e) => {
            throw new Error(
              `${(e as Error).message}\n         ${await diagnose()}`,
            );
          });
          assertEquals(
            sync.flushFailures,
            0,
            `${dev.who}'s flush direction is healthy: ${JSON.stringify(sync)}`,
          );
          assertEquals(
            sync.pullFailures,
            0,
            `${dev.who}'s pull direction is healthy: ${JSON.stringify(sync)}`,
          );
        }
        console.log(
          `\n         ══ SOAK GREEN: seed ${SEED}, ${STEPS} steps, ` +
            `${authored.length} todos converged ══\n`,
        );
      });
    } finally {
      await fake.close();
    }
  },
};

export default scenario;
