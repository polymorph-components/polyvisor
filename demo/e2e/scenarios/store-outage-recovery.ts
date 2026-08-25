// A STORE THAT GOES DOWN MID-SESSION HEALS ON ITS OWN — the recovery
// half of the bucket-sync round (runtime/SYNC.md §3) that
// transport-refusal.ts does not cover.
//
// transport-refusal.ts proves an unreachable store fails HONESTLY: the
// engine names the failed request, retries it, and never traps. But
// that scenario's store is down for the scenario's WHOLE LIFE — it
// proves the failure is not a lie, not that the product ever gets
// better. Nothing anywhere proves the other half of SYNC.md §3's claim:
// a store that goes down, accumulates scheduled-flush failures and an
// ANNOUNCEMENT, then comes back — and sync heals with NO user action,
// purely through the worker's own backoff retry. That is this
// scenario's whole argument, and the BEATS ARE THE ORDER of it:
//
//   1. One device binds to the harness's real MinIO through the actual
//      storage sheet (solo-storage.ts's ceremony), and a first todo's
//      SCHEDULED flush completes with zero failures. This is the
//      healthy baseline: `syncStatus.lastFlush` moves and
//      `flushFailures` is 0. Capturing this value is what makes a
//      later failure count UNAMBIGUOUSLY the outage's, not some
//      pre-existing flake.
//   2. `ctx.stopMinio()` — the store goes down under a device that is
//      already mid-session, which nothing else in the suite does
//      (transport-refusal's store is down from before the page even
//      boots). A todo is authored; the worker's OWN 20s debounce fires
//      the flush into a dead store with nobody touching a button.
//      `flushFailures` climbs to the SYNC_VISIBLE_AFTER threshold (3,
//      worker.ts) via its own backoff retries, and the visor's own
//      announcement — the exact sentence solo.ts's `watchSyncFailures`
//      renders — appears on the strip.
//   3. `ctx.startMinio()`. NOBODY PRESSES ANYTHING. The backoff's next
//      scheduled retry (worker.ts's `armFlush`/`flushCycle`) finds the
//      store alive again: `flushFailures` resets to 0 and `lastFlush`
//      advances past its beat-1 value — the reset and the timestamp
//      are two different fields, so a stale `lastFlush` sitting beside
//      a zeroed count would not read as a heal, and this scenario
//      checks both. The filesystem witness (MinIO's own data
//      directory, `ctx.minioDataDir` — solo-storage.ts's technique)
//      confirms the bytes actually landed rather than trusting the
//      in-page status field alone.
//   4. The todo authored DURING the outage was never lost: it is still
//      rendered on the page after the heal. There is no separate
//      per-object witness available here beyond that and the healed
//      `lastFlush`/zero `flushFailures` from beat 3 — a scheduled
//      flush cycle flushes the WHOLE partition (worker.ts's
//      `flushCycle` iterates every partition in the pointer map), so a
//      cycle that succeeds after the outage-todo was authored and
//      before any earlier cycle succeeded necessarily carried it. That
//      is the honest reading, stated rather than invented as a
//      separate assertion.
//
// THE "Sync now" BYPASS BEAT IS DELIBERATELY OMITTED. Driving it here
// would mean opening the storage sheet purely to reach one button while
// a standing backoff is live — solo-storage.ts's own comments document
// the sheet's viewport/visibility quirks, and devstore row 49 already
// covers the backoff-bypass mechanics at the unit level (an injected
// failure backs off; Sync-now reports its own refusal immediately).
// Adding it here would buy little beyond what row 49 and this
// scenario's beat 2/3 already establish, for a real cost in sheet
// ceremony. Left out; noted per the dispatch.
//
// TIMING, DERIVED RATHER THAN GUESSED (worker.ts ~1858-1875):
// `FLUSH_DEBOUNCE_MS` = 20s, `BACKOFF_BASE_MS` = 5s (truncated
// exponential, factor 2, cap 10min, jittered 0.5x-1.5x). Beat 2 needs
// three failures: the debounce (20s) then two backoff retries at
// nominal 5s and 10s (jittered 2.5-15s), so worst case ~20+7.5+15 =
// 42.5s — the wait below budgets generously past that. Beat 3's heal
// rides the NEXT backoff arm, made after the third failure at nominal
// 20s (jittered 10-30s) — the wait below budgets past that too.
//
// SYNTHETIC CREDENTIALS THROUGHOUT: `minioadmin`/`minioadmin` is the
// harness's own MinIO root pair (run.ts's `Minio` class) — already
// public test config, never anything a person typed.

import type { Page } from "npm:playwright@1.57.0";
import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, stripText } from "../util.ts";
import { addTodo, appFrame, createAccount, solo, until, WAITS } from "../solo-util.ts";

const BUCKET = "pm-outage-recovery";
// The harness's own MinIO root credentials (run.ts's `Minio` class) —
// synthetic by construction, never anything a person would type.
const ACCESS = "minioadmin";
const SECRET = "minioadmin";

const FIRST_TODO = "the baseline todo, flushed while the store is healthy";
const OUTAGE_TODO = "the todo written while the store was down";

/** worker.ts's own constants, named here rather than re-guessed so the
 * derived waits below carry their arithmetic instead of a bare number. */
const FLUSH_DEBOUNCE_MS = 20_000;
const BACKOFF_BASE_MS = 5_000;
const SYNC_VISIBLE_AFTER = 3;

/** Beat 1's baseline wait: one debounce, plus margin for the cycle
 * itself and a busy CI box (solo-offline-sync.ts's FLUSH_WAIT idiom —
 * "a constant plus margin, not a guess"). */
const BASELINE_FLUSH_WAIT = FLUSH_DEBOUNCE_MS + 40_000;

/** Beat 2's wait: the debounce, then backoff retries at nominal 5s and
 * 10s (jittered up to 1.5x, i.e. up to 7.5s and 15s) to reach the
 * THIRD failure — worst case 20_000 + 7_500 + 15_000 = 42_500ms — plus
 * generous margin for the page's own 5s announcement-poll cadence
 * (host/solo.ts's `syncWatchAt` gate) and a slow CI box. */
const THREE_FAILURES_WAIT = FLUSH_DEBOUNCE_MS + BACKOFF_BASE_MS * 3 + 60_000;

/** Beat 3's wait. The most likely case is the backoff arm made AFTER
 * the third failure — nominal `BACKOFF_BASE_MS * 2^(3-1)` = 20s,
 * jittered up to 1.5x = 30s worst case. BUT the previous act's own
 * checks (the `lastError` read, then the announcement's `until`, up to
 * 20s) spend real time AFTER that third failure lands and BEFORE this
 * act calls `ctx.startMinio()` — enough for a FOURTH failure to land
 * first if the third arm's jitter came in short. That fourth arm is
 * nominal `BACKOFF_BASE_MS * 2^(4-1)` = 40s, jittered up to 1.5x = 60s
 * worst case, and it is THAT arm the heal must then be waited past. So
 * the bound below is the fourth arm's own worst case (60s) plus the
 * same margin as `THREE_FAILURES_WAIT` — a constant plus margin, not a
 * guess, with every term named. */
const HEAL_WAIT = BACKOFF_BASE_MS * Math.pow(2, 3) * 1.5 + 60_000;

/** Count regular files under MinIO's on-disk bucket directory,
 * recursively — the filesystem witness that does not go through
 * anything this scenario is trying to prove (solo-storage.ts's
 * technique, duplicated here per the dispatch's scenario-local-helper
 * instruction rather than imported from another scenario file). */
async function countBucketObjects(dataDir: string, bucket: string): Promise<number> {
  let count = 0;
  async function walk(dir: string) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else count++;
    }
  }
  await walk(`${dataDir}/${bucket}`);
  return count;
}

/** Leave the storage sheet the way a user does — its own Close button —
 * and wait for it to actually go (solo-offline-sync.ts's helper,
 * duplicated locally per the dispatch's scenario-local-helper
 * instruction). */
async function closeStorageSheet(page: Page): Promise<void> {
  await page.click('#storage-sheet button:text-is("Close")');
  await page.waitForSelector("#storage-sheet", { state: "detached", timeout: 15_000 });
}

/** `syncStatus`'s shape, named locally so the `until` callbacks below
 * read as claims rather than `any`-shaped guesses. */
interface SyncStatusLike {
  lastFlush: number | null;
  lastPull: number | null;
  flushFailures: number;
  pullFailures: number;
  lastError: string | null;
}

const scenario: Scenario = {
  name: "store-outage-recovery",
  why:
    "a store that goes down MID-SESSION, accumulates scheduled-flush failures and a visor announcement, then comes back — and sync heals with no user action, through the worker's own backoff retry",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },
  // Beats 2 and 3 alone budget past 100s of real backoff waiting; the
  // suite-wide deadline was never sized for that (Scenario.deadlineMs's
  // own doc comment, run.ts).
  deadlineMs: 420_000,

  async run(page: Page, ctx: Ctx) {
    assert(ctx.minioDataDir !== null, "the harness did not expose MinIO's data directory");
    const dataDir = ctx.minioDataDir!;

    await act("this device creates an account, so the todo app has somewhere to write", async () => {
      await createAccount(page);
    });

    await act("a device, kept (until-reseal, no passphrase) so the schedule has somewhere to live", async () => {
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "starts ephemeral");
      await solo(page, "openDevice");
      const sheet = await until([page], "the device sheet", async () => {
        const s = await solo(page, "deviceSheet");
        return s.open && s.keep ? s : false;
      }, 15_000);
      assert(sheet.keep, "the promotion ceremony must be on offer");
      assertEquals(
        await solo(page, "keepDevice", "laptop", "until-reseal"),
        true,
        "the ceremony's own controls took the choice",
      );
      await until([page], "the promoted device", async () => {
        const ds = (await solo(page, "devices").catch(() => [])) as { tier: string }[];
        return ds.find((d) => d.tier === "t1") ?? false;
      }, 30_000);
    });

    await act("bind through the storage sheet, to the harness's real MinIO", async () => {
      await page.evaluate(() => {
        (document.getElementById("visor-settings") as HTMLButtonElement | null)?.click();
      });
      await page.waitForFunction(
        () =>
          (document.querySelector(
            '#visor-drawer-inner .settings-extra-action[data-action="storage"]',
          ) as HTMLButtonElement | null) !== null,
        undefined,
        { timeout: 15_000 },
      );
      await solo(page, "openStorageSheet");
      await page.waitForSelector("#storage-endpoint", { timeout: 15_000 });
      await page.fill("#storage-endpoint", ctx.minioUrl);
      await page.fill("#storage-bucket", BUCKET);
      await page.fill("#storage-access", ACCESS);
      await page.fill("#storage-secret", SECRET);
      await page.click("#storage-connect");
      const trace = await until([page], "storage:bound", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:bound") ? t : false;
      }, 60_000);
      assert(trace.includes("storage:bound"), `bootTrace: ${JSON.stringify(trace)}`);
      await closeStorageSheet(page);
    });

    let baselineLastFlush = 0;
    await act("HEALTHY BASELINE: a todo, and the worker's own scheduled flush completes clean", async () => {
      const before = await solo(page, "syncStatus") as SyncStatusLike;
      assertEquals(
        before.lastFlush,
        null,
        "no SCHEDULED flush has completed yet — the connect ceremony's own flush is a client " +
          "act and deliberately does not move this field (rpc.ts's SyncStatus)",
      );

      await addTodo(page, FIRST_TODO);

      const synced = await until([page], "the baseline SCHEDULED flush", async () => {
        const s = await solo(page, "syncStatus") as SyncStatusLike;
        return s.lastFlush !== null ? s : false;
      }, BASELINE_FLUSH_WAIT).catch((e) => {
        throw new Error(`${(e as Error).message} — a store nobody has stopped yet must flush clean`);
      });
      assertEquals(synced.flushFailures, 0, `the baseline schedule is healthy: ${JSON.stringify(synced)}`);
      baselineLastFlush = synced.lastFlush!;
    });

    await act(
      "THE STORE GOES DOWN MID-SESSION: a mutation's own debounced flush fails into it, three times over, and the visor SAYS SO",
      async () => {
        await ctx.stopMinio();

        await addTodo(page, OUTAGE_TODO);

        let lastStatus: SyncStatusLike | null = null;
        const failed = await until([page], "three consecutive scheduled flush failures", async () => {
          const s = await solo(page, "syncStatus") as SyncStatusLike;
          lastStatus = s;
          return s.flushFailures >= SYNC_VISIBLE_AFTER ? s : false;
        }, THREE_FAILURES_WAIT).catch((e) => {
          throw new Error(
            `${(e as Error).message}; syncStatus was last ${JSON.stringify(lastStatus)}`,
          );
        });
        assert(
          failed.lastError !== null,
          "three failed flush cycles must leave a sentence a person can read (rpc.ts's SyncStatus.lastError)",
        );
        assertEquals(
          failed.lastFlush,
          baselineLastFlush,
          "no flush has succeeded since the baseline — the outage must not have quietly healed already",
        );

        // THE VISOR'S OWN WORDS (host/solo.ts's `watchSyncFailures`,
        // ~line 1621): the exact sentence it renders once `flushFailures`
        // (or `pullFailures`) crosses `SYNC_VISIBLE_AFTER`, carrying the
        // seam's own error after the dash. Read off the strip's bottom
        // line (`stripText`, util.ts) rather than invented.
        const announced = await until([page], "the visor's failing-sync announcement", async () => {
          const t = await stripText(page);
          return t.bottom.includes("this device has stopped syncing with your storage") ? t.bottom : false;
        }, 20_000);
        assert(
          announced.includes("this device has stopped syncing with your storage"),
          `the strip should carry the visor's own announcement: ${JSON.stringify(announced)}`,
        );
      },
    );

    await act(
      "THE STORE COMES BACK: nobody presses anything, and the backoff's own next retry heals it",
      async () => {
        const beforeHealObjects = await countBucketObjects(dataDir, BUCKET);

        await ctx.startMinio();

        let lastStatus: SyncStatusLike | null = null;
        const healed = await until([page], "the backoff's own retry to heal the schedule", async () => {
          const s = await solo(page, "syncStatus") as SyncStatusLike;
          lastStatus = s;
          return s.flushFailures === 0 && s.lastFlush !== null && s.lastFlush > baselineLastFlush
            ? s
            : false;
        }, HEAL_WAIT).catch((e) => {
          throw new Error(
            `${(e as Error).message}; syncStatus was last ${JSON.stringify(lastStatus)}`,
          );
        });
        assertEquals(healed.flushFailures, 0, `the flush direction is healthy again: ${JSON.stringify(healed)}`);
        assert(
          healed.lastFlush! > baselineLastFlush,
          `a scheduled flush must have completed AFTER the baseline: ${baselineLastFlush} -> ${healed.lastFlush}`,
        );

        // THE FILESYSTEM WITNESS: MinIO's own data directory shows more
        // objects than it did right before the heal — the bytes actually
        // reached the bucket, not merely a status field that flipped in
        // the page (solo-storage.ts's technique).
        const afterHealObjects = await until([page], "more objects on disk after the heal", async () => {
          const n = await countBucketObjects(dataDir, BUCKET);
          return n > beforeHealObjects ? n : false;
        }, 30_000);
        assert(
          afterHealObjects > beforeHealObjects,
          `the healed flush must have written new objects: ${beforeHealObjects} -> ${afterHealObjects}`,
        );

        // THE RECOVERY ANNOUNCEMENT (host/solo.ts's `watchSyncFailures`:
        // "A RECOVERY IS ANNOUNCED TOO, and only when a failure was
        // announced").
        const recovered = await until([page], "the visor's recovery announcement", async () => {
          const t = await stripText(page);
          return t.bottom.includes("this device is syncing with your storage again") ? t.bottom : false;
        }, 20_000);
        assert(
          recovered.includes("this device is syncing with your storage again"),
          `the strip should carry the recovery announcement: ${JSON.stringify(recovered)}`,
        );
      },
    );

    await act(
      "THE OUTAGE TODO WAS NEVER LOST: it is still on the page after the heal",
      async () => {
        // No separate per-object witness is available beyond this render
        // and the previous act's healed `lastFlush`/zeroed
        // `flushFailures`: a scheduled flush cycle flushes the WHOLE
        // partition (worker.ts's `flushCycle` walks every partition in
        // the pointer map), so a cycle that succeeded after this todo was
        // authored and before any earlier cycle had succeeded necessarily
        // carried it. Stated rather than separately proven, per the
        // dispatch's beat 4 guidance.
        await appFrame(page).locator("ul.todo-list li").filter({ hasText: OUTAGE_TODO }).first()
          .waitFor({ state: "visible", timeout: WAITS.converge });
        await appFrame(page).locator("ul.todo-list li").filter({ hasText: FIRST_TODO }).first()
          .waitFor({ state: "visible", timeout: WAITS.converge });
      },
    );
  },
};

export default scenario;
