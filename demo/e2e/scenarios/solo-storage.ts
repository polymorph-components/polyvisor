// STORAGE EGRESS FROM THE WORKER HOST — G4's bucket path meets the
// worker host, driven exactly the way a user meets it: the settings
// sheet, real fields, a real MinIO on the other end. MinIO ACCEPTING the
// signed requests IS the signature verification (SigV4 is not something
// this harness can fake past); a wrong signature is a 403 from a real
// server, not a mock's opinion.
//
// SIX CLAIMS, in the order STORAGE-EGRESS.md makes them:
//
//   1. BIND THROUGH THE SHEET (§5: one drawer tenant, chrome-owned
//      fields, no picker). Connect runs escrow → bindStore →
//      ensureBucket → storeGrant(self) → bucketFlush, and the sheet
//      reports it as `storage:bound`.
//   2. THE ESCROW IS A HANDLE, NOT A STRING (§2): the same
//      `pm-demo-keystore` database credential-flow.ts already proves
//      holds a non-extractable CryptoKey — this scenario re-proves it
//      for the WORKER-HOST path, and adds the negative space
//      credential-flow does not need: the solo page has no page-side
//      storage config to leak, so its ENTIRE localStorage must be clean.
//   3. BYTES REACHED THE BUCKET: MinIO's own data directory, which the
//      harness owns, is asserted directly — the filesystem is the one
//      witness that does not go through anything this scenario is
//      trying to test.
//   4. THE BINDING SURVIVES A REAL RELOAD (§3): the worker re-applies
//      the sealed binding at every bring-up with NO page-side state and
//      NO re-entry — asserted by reloading and reading `storageStatus`
//      back with nothing typed, then proving the wiring is actually
//      live with a second Sync now.
//   5. SEALED MEANS SEALED (§6): reseal drops the in-worker grant with
//      everything else; the binding rests sealed and returns at the
//      next unseal — asserted by landing on the picker (nothing
//      personal, nothing bucket-shaped reachable) and then unsealing.
//   6. DISCONNECT (§6's honest sentence, runtime/STORAGE-EGRESS.md:124-129):
//      unbind forgets THIS DEVICE's binding; the keystore record is
//      profile-tier escrow and PERSISTS — deleting it is the erase
//      ceremony's job, not disconnect's.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, waitForBoot } from "../util.ts";
import { solo, until, WAITS } from "../solo-util.ts";
import type { Page } from "npm:playwright@1.57.0";

const BUCKET = "pm-solo";
// The harness's own MinIO root credentials — synthetic by construction
// (run.ts's `Minio` class), never anything a person would type.
const ACCESS = "minioadmin";
const SECRET = "minioadmin";

/** Read the escrowed record straight out of IndexedDB, mirroring
 * credential-flow.ts's `keystoreRecord` — same database (§2: the DB
 * name is shared origin-wide on purpose), read from a different page. */
function keystoreRecord(page: Page): Promise<
  { origin: string; accessKey: string; extractable: boolean; usages: string[]; type: string } | null
> {
  return page.evaluate(() =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pm-demo-keystore");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sigv4")) return resolve(null);
        const all = db.transaction("sigv4", "readonly").objectStore("sigv4").getAll();
        all.onerror = () => reject(all.error);
        all.onsuccess = () => {
          const rec = all.result[0];
          if (!rec) return resolve(null);
          resolve({
            origin: rec.origin,
            accessKey: rec.accessKey,
            extractable: rec.key.extractable,
            usages: rec.key.usages,
            type: rec.key.type,
          });
        };
      };
    })
  ) as Promise<
    { origin: string; accessKey: string; extractable: boolean; usages: string[]; type: string } | null
  >;
}

/** Every localStorage entry on the page — key AND value — for the
 * negative claim: the solo page must hold NO page-side storage config
 * at all (§3: "no page-side state and no re-entry of anything"), unlike
 * demo.ts's page which at least keeps secret-free addressing. */
function allLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      out[k] = localStorage.getItem(k) ?? "";
    }
    return out;
  });
}

/** Count regular files under MinIO's on-disk bucket directory,
 * recursively. MinIO lays a bucket out as a plain directory tree (one
 * subdirectory per object, `xl.meta`/data files inside) under the data
 * dir the harness owns — the one witness to "bytes reached the bucket"
 * that does not go through anything this scenario is trying to prove. */
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

const scenario: Scenario = {
  name: "solo-storage",
  why:
    "the worker host's storage egress, driven end to end against real MinIO — the escrow is a handle, the binding survives reseal and reload, and MinIO accepting the signed requests is the signature verification",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },

  async run(page: Page, ctx: Ctx) {
    assert(ctx.minioDataDir !== null, "the harness did not expose MinIO's data directory");
    const dataDir = ctx.minioDataDir!;

    await act("a device, kept (until-reseal, no passphrase) so a reload auto-unseals", async () => {
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

    await act("open settings → storage, and connect through the sheet", async () => {
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
    });

    await act("the escrow is a HANDLE: a non-extractable CryptoKey, nowhere as text", async () => {
      const rec = await keystoreRecord(page);
      assert(rec !== null, "no keystore record was written by the connect ceremony");
      assertEquals(rec!.origin, new URL(ctx.minioUrl).origin, "the record's bound origin");
      assertEquals(rec!.accessKey, ACCESS, "the record's public identifier");
      assertEquals(rec!.extractable, false, "the escrowed key's extractable flag");
      assertEquals(rec!.usages.join(","), "sign", "the escrowed key's usages");
      // THE SOLO PAGE'S NEGATIVE SPACE (§3): unlike demo.ts's page, which
      // at least keeps secret-free addressing in localStorage, the solo
      // page keeps NO page-side storage config at all — the binding
      // lives sealed in the device store. So the whole of localStorage
      // must be free of the secret AND free of anything storage-shaped.
      const all = await allLocalStorage(page);
      for (const [k, v] of Object.entries(all)) {
        assert(!v.includes(SECRET), `localStorage[${k}] carried the secret: ${v}`);
        assert(
          !/pm-solo-storage|pm-demo-storage/i.test(k),
          `a page-side storage config key exists: ${k}`,
        );
      }
    });

    await act("bytes reached the bucket: MinIO's own data dir has the object", async () => {
      const n = await until([page], "an object on disk", async () => {
        const count = await countBucketObjects(dataDir, BUCKET);
        return count > 0 ? count : false;
      }, 30_000);
      assert(n > 0, `expected at least one object under ${dataDir}/${BUCKET}`);
    });

    await act("close the sheet, then a REAL reload: no re-entry, the binding is back", async () => {
      await page.evaluate(() => {
        (Array.from(document.querySelectorAll("#storage-sheet button")) as HTMLButtonElement[])
          .find((b) => b.textContent === "Close")?.click();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("auto-unseal"), `trace: ${JSON.stringify(trace)}`);
      const status = await until([page], "the binding, restored with no ceremony", async () => {
        const s = await solo(page, "storageStatus");
        return s !== null ? s : false;
      }, 30_000);
      assertEquals(status.endpoint, ctx.minioUrl, "the restored endpoint");
      assertEquals(status.bucket, BUCKET, "the restored bucket");
      assertEquals(status.accessKey, ACCESS, "the restored access key");
    });

    let beforeSecondFlush = 0;
    await act("the bound view renders, and Sync now lands a second flush", async () => {
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
      await page.waitForSelector("#storage-sync", { state: "visible", timeout: 15_000 });
      beforeSecondFlush = await countBucketObjects(dataDir, BUCKET);
      await page.click("#storage-sync");
      const trace = await until([page], "storage:synced", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:synced") ? t : false;
      }, 30_000);
      assert(trace.includes("storage:synced"), `bootTrace: ${JSON.stringify(trace)}`);
      const after = await countBucketObjects(dataDir, BUCKET);
      assert(
        after >= beforeSecondFlush,
        `object count should not decrease after a second flush: ${beforeSecondFlush} -> ${after}`,
      );
      await page.evaluate(() => {
        (Array.from(document.querySelectorAll("#storage-sheet button")) as HTMLButtonElement[])
          .find((b) => b.textContent === "Close")?.click();
      });
    });

    const PASS = "correct-horse-battery-staple-TEST";
    await act("sealed means sealed: reseal, land on the picker, nothing personal", async () => {
      await solo(page, "openDevice");
      const sheet = await until([page], "the reseal sheet", async () => {
        const s = await solo(page, "deviceSheet");
        return s.open && s.reseal ? s : false;
      }, 15_000);
      assertIncludes(sheet.text, "laptop", "the sheet names the device");
      assertEquals(await solo(page, "resealDevice", PASS), true, "the upgrade ceremony took it");
      await until([page], "the ceremony to settle", async () => {
        const s = await solo(page, "deviceSheet").catch(() => null);
        if (s === null) return true; // already reloading
        if (s.problem !== "") throw new Error(`the reseal refused: ${s.problem}`);
        return s.open === false ? true : false;
      }, 15_000);
      await waitForBoot(page, "__solo");
      // Landed on the picker, waiting for the passphrase the reseal
      // ceremony just minted — the anti-spoofing property (PERSISTENCE.md):
      // a device waiting to be opened has nothing personal on screen.
      const picker = await until([page], "the picker", async () => {
        const p = await solo(page, "picker");
        return p.visible ? p : false;
      }, WAITS.boot);
      assert(picker.rows.includes("laptop"), `picker rows: ${JSON.stringify(picker.rows)}`);
      const body = await page.evaluate(() => document.body.textContent ?? "");
      assert(!body.includes("Ada"), "no personal name while sealed");
    });

    await act("unseal with the passphrase: the sealed binding comes back with the seal", async () => {
      await solo(page, "pickDevice", "laptop");
      await until([page], "the passphrase demand", async () => {
        const p = await solo(page, "picker");
        return p.needsPassphrase ? p : false;
      }, WAITS.boot);
      await solo(page, "typePassphrase", PASS);
      await solo(page, "unsealClick");
      await until([page], "the unsealed device", async () => {
        try {
          const st = await solo(page, "deviceStatus");
          return st.sealed === false ? st : false;
        } catch {
          return false;
        }
      }, WAITS.boot);
      const status = await until([page], "storageStatus, non-null again", async () => {
        const s = await solo(page, "storageStatus");
        return s !== null ? s : false;
      }, 30_000);
      assertEquals(status.bucket, BUCKET, "the same binding, back with the seal");
      assertEquals(status.endpoint, ctx.minioUrl, "the same endpoint, back with the seal");
    });

    await act("disconnect: this device forgets it, the profile-tier escrow survives", async () => {
      // STORAGE-EGRESS.md §6: "disconnect forgets THIS DEVICE's
      // binding. The escrowed secret key stays on this browser for any
      // device that still names it — it is profile-tier escrow, not
      // device-tier … the erase ceremony is what deletes it."
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
      await page.waitForSelector("#storage-disconnect", { state: "visible", timeout: 15_000 });
      await page.click("#storage-disconnect");
      const trace = await until([page], "storage:disconnected", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:disconnected") ? t : false;
      }, 30_000);
      assert(trace.includes("storage:disconnected"), `bootTrace: ${JSON.stringify(trace)}`);
      const status = await solo(page, "storageStatus");
      assertEquals(status, null, "this device's binding is gone after disconnect");
      const rec = await keystoreRecord(page);
      assert(rec !== null, "the profile-tier escrow must survive a device-tier disconnect");
      assertEquals(rec!.extractable, false, "the surviving escrowed key is still a handle");
    });
  },
};

export default scenario;
