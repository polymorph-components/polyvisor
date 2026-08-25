// THE FILE KIT — the owner's amendment to runtime/RECOVERY.md, driven
// end to end: a bundle the user KEEPS, opened by a passphrase the user
// CHOSE, restoring an account into a wiped browser.
//
// WHY IT IS A SEPARATE SCENARIO FROM `solo-recovery`. The two kinds
// share a mechanism and differ in exactly the places that are worth a
// test of their own — a different secret slot (argon2id over a
// user-chosen passphrase with a random per-file salt, rather than a KEK
// derived from generated entropy), a different way of finding the bundle
// (the file IS the bundle; nothing is fetched by a derived name), and a
// different failure mode when the secret is wrong. Folding it into the
// phrase scenario would have produced one long scenario whose failure
// told you less about which half broke.
//
// FOUR CLAIMS:
//
//   1. THE LOUD WARNING IS ON SCREEN BEFORE THE PASSPHRASE IS CHOSEN
//      (RECOVERY.md: "disallowing custody would be paternalism, so the
//      ceremony WARNS LOUDLY instead"). All three of the record's
//      sentences are asserted, because the amendment is the copy: a file
//      kit whose ceremony went quiet would be the paternalism ruling
//      inverted into negligence.
//   2. THE CONFIRM FIELD IS REAL: two different passphrases are refused
//      before anything is minted. A mistyped passphrase on a file kit is
//      undiscoverable until the disaster — nothing ever asks for it
//      again until then — so this is the one chance to catch it.
//   3. A WRONG PASSPHRASE REFUSES, AND THE CEREMONY RECOVERS. This is
//      the "no wedged ceremony" rule at its sharpest: the person typing
//      is mid-disaster and has one artifact left, and a sheet that died
//      on the first mistyped attempt would strand them with a file that
//      was always fine.
//   4. THE RIGHT ONE RESTORES THE ACCOUNT, into a context that was
//      destroyed and recreated — the todos come back.
//
// The file arrives through Playwright's DOWNLOAD event, which is the
// real delivery path: the sheet mints a blob URL and clicks an anchor,
// exactly as it does for a user, and the harness catches what the
// browser was handed rather than reaching into page memory for bytes.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, createAccount, solo, until, WAITS } from "../solo-util.ts";
import type { Page } from "npm:playwright@1.57.0";

const BUCKET = "pm-recovery-file";
const ACCESS = "minioadmin";
const SECRET = "minioadmin";
const TODOS = ["water the plants"];
const KIT_PASS = "a-passphrase-the-user-chose-TEST";
const WRONG_PASS = "not-the-one-TEST";

async function openStorageSheet(page: Page) {
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
}

const scenario: Scenario = {
  name: "solo-recovery-file",
  why:
    "the file kit: the ceremony warns loudly and confirms the passphrase before minting, the bundle is delivered as a real download, a wrong passphrase refuses without wedging the ceremony, and the right one restores the account into a destroyed-and-recreated browser",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "120",
    },
  },

  async run(page: Page, ctx: Ctx) {
    let kitPath = "";

    await act("an account, a todo, and a bucket behind it", async () => {
      await createAccount(page);
      for (const t of TODOS) await addTodo(page, t);
      await openStorageSheet(page);
      await page.waitForSelector("#storage-endpoint", { timeout: 15_000 });
      await page.fill("#storage-endpoint", ctx.minioUrl);
      await page.fill("#storage-bucket", BUCKET);
      await page.fill("#storage-access", ACCESS);
      await page.fill("#storage-secret", SECRET);
      await page.click("#storage-connect");
      await until([page], "storage:bound", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:bound") ? t : false;
      }, 60_000);
      await page.waitForSelector("#storage-sync", { state: "visible", timeout: 15_000 });
      await page.click("#storage-sync");
      await until([page], "storage:synced", async () => {
        const t = (await solo(page, "bootTrace")) as string[];
        return t.includes("storage:synced") ? t : false;
      }, 60_000);
    });

    await act("the file kind WARNS LOUDLY, in the record's own three sentences", async () => {
      await page.click("#storage-kits");
      await page.waitForSelector("#recovery-make", { state: "visible", timeout: 15_000 });
      await page.click("#recovery-kind-file");
      await page.waitForSelector("#recovery-file-warning", { state: "visible", timeout: 15_000 });
      const warning = (await page.textContent("#recovery-file-warning") ?? "").toLowerCase();
      // 1. the passphrase's strength is the USER'S own, and the visor
      //    says so rather than measuring it.
      assertIncludes(warning, "your choice", "the warning puts the strength on the user");
      assert(
        warning.includes("does not judge") || warning.includes("does not measure"),
        `the warning must decline to measure the passphrase: ${warning}`,
      );
      // 2. the file plus its passphrase open the WHOLE account.
      assertIncludes(warning, "whole account", "the warning states the blast radius");
      // 3. the file is dead the day it is used or its device revoked.
      assertIncludes(warning, "revoke", "the warning states how the file dies");
    });

    await act("the confirm field is real: two different passphrases mint nothing", async () => {
      await page.fill("#recovery-label", "the file one");
      await page.fill("#recovery-file-pass", KIT_PASS);
      await page.fill("#recovery-file-pass2", WRONG_PASS);
      await page.click("#recovery-make");
      const problem = await until([page], "the mismatch refusal", async () => {
        const el = await page.$("#recovery-problem");
        if (el === null || !(await el.isVisible())) return false;
        const t = (await el.textContent()) ?? "";
        return t.trim() === "" ? false : t;
      }, 15_000);
      assertIncludes(problem, "did not match", "the refusal names the mismatch");
      // NOTHING WAS MINTED: the account still has no kit.
      await page.waitForSelector("#recovery-none", { timeout: 15_000 });
    });

    await act("mint the file kit, and catch the real download", async () => {
      // The fields were cleared by the refused attempt — the same
      // one-moment-of-cleartext discipline every secret field on this
      // page keeps — so both are typed again, as a user would.
      await page.fill("#recovery-file-pass", KIT_PASS);
      await page.fill("#recovery-file-pass2", KIT_PASS);
      const waitForDownload = page.waitForEvent("download", { timeout: 120_000 });
      await page.click("#recovery-make");
      const download = await waitForDownload;
      // A VISOR-VOICED FILENAME: the user's own label, the date, and an
      // extension that says what it is.
      const name = download.suggestedFilename();
      assertIncludes(name, "the-file-one", "the download wears the label the user typed");
      assertIncludes(name, ".polyvisor-kit", "the download says what kind of thing it is");
      kitPath = await Deno.makeTempFile({ suffix: ".polyvisor-kit" });
      await download.saveAs(kitPath);
      const size = (await Deno.stat(kitPath)).size;
      assert(size > 0, "the downloaded kit is empty");

      // A KIT IS A DEVICE, AND IT IS IN THE LIST — RECOVERY.md's core
      // ruling, asserted for the file kind on the repaint the mint
      // ceremony does for itself. No re-entry, no polling, no grace
      // period: the account's registry answers immediately, so the sheet
      // that just minted a kit must be showing it by the time the
      // ceremony reports success.
      //
      // THIS ASSERTION EXISTS BECAUSE IT ONCE FAILED, and the reason is
      // worth carrying: the repaint ran INSIDE the mint's own job on the
      // page's serialized chain and re-entered `enqueue` to do its read,
      // so the read queued behind the job that was awaiting it and never
      // ran at all. The list stayed empty, every later call on the chain
      // queued behind a promise that would never settle, and the whole
      // thing presented as "the engine does not register file kits" —
      // which was false. See host/solo.ts's note on `enqueue`.
      await page.waitForSelector(".recovery-row", { timeout: 30_000 });
      const listed = await page.$$eval(".recovery-row", (els) => els.map((e) => e.textContent ?? ""));
      assertEquals(listed.length, 1, `one kit should be listed, got ${JSON.stringify(listed)}`);
      assertIncludes(listed[0], "file kit", "the listed kit names its kind");
    });

    await act("a file kit is REVOCABLE from the sheet — the answer to a leaked one", async () => {
      // RECOVERY.md's core ruling in full: a kit is "a real leaf in the
      // account's delegation graph, visible in the devices sheet under
      // the user's own label, REVOCABLE LIKE ANY DEVICE" — and
      // revocation is the record's whole answer to a leaked phrase or
      // file. An unrevocable kit would leave that answer with no
      // interface, so this claim has to be executable.
      //
      // A SECOND, THROWAWAY KIT IS MINTED TO SPEND. The first one is
      // this scenario's restore artifact and must survive to be used, so
      // revoking it here would trade one claim for another. Two kits
      // also make the assertion sharper: revoking must remove THE ONE
      // CHOSEN and leave the other alone.
      await page.fill("#recovery-file-pass", KIT_PASS);
      await page.fill("#recovery-file-pass2", KIT_PASS);
      await page.fill("#recovery-label", "the spare one");
      const spareDownload = page.waitForEvent("download", { timeout: 120_000 });
      await page.click("#recovery-make");
      await (await spareDownload).saveAs(await Deno.makeTempFile({ suffix: ".polyvisor-kit" }));
      await page.waitForFunction(
        () => document.querySelectorAll(".recovery-row").length === 2,
        undefined,
        { timeout: 60_000 },
      );

      // THE LAST ROW IS THE SPARE: the account's registry sorts by
      // creation time, so the kit minted a moment ago is the one at the
      // end. Revoking by POSITION rather than by a captured id is also
      // what a user does — they read the list and press the control on a
      // row.
      const revokeLast = () =>
        page.evaluate(() => {
          const rows = document.querySelectorAll(".recovery-row");
          (rows[rows.length - 1].querySelector(".recovery-revoke") as HTMLButtonElement).click();
        });
      // TWO CLICKS, ARMED: the first states what the second will do, the
      // same shape the reseal and forget-Google controls use. A driver
      // that could revoke in one click would not be driving this
      // ceremony.
      await revokeLast();
      const armedText = await page.evaluate(() => {
        const rows = document.querySelectorAll(".recovery-row");
        return rows[rows.length - 1].querySelector(".recovery-revoke")?.textContent ?? "";
      });
      assertIncludes(armedText, "Yes", "the first click arms rather than revokes");
      await revokeLast();

      await page.waitForFunction(
        () => document.querySelectorAll(".recovery-row").length === 1,
        undefined,
        { timeout: 120_000 },
      );
      // THE GUARANTEE NOTE, rendered as prose in its own node — the
      // store-revoke discipline: what revocation does and does not
      // promise is the one thing the user needs to read here.
      const guarantee = (await page.textContent("#recovery-guarantee") ?? "").trim();
      assert(guarantee !== "", "revoking must render the guarantee note it hands back");
      // AND THE SURVIVOR IS THE RESTORE ARTIFACT, untouched.
      const left = await page.$$eval(".recovery-row", (els) => els.map((e) => e.textContent ?? ""));
      assertIncludes(left[0], "file kit", "the kit that was not chosen is still there");
    });

    await act("DESTROY the browser", async () => {
      await page.context().close();
    });

    let fresh!: Page;
    await act("a wrong passphrase refuses — and the ceremony survives it", async () => {
      fresh = await ctx.fresh({ path: "/solo.html", bootGlobal: "__solo" });
      await fresh.waitForSelector("#solo-restore-account", { timeout: WAITS.boot });
      await fresh.click("#solo-restore-account");
      await fresh.waitForSelector("#restore-sheet", { state: "visible", timeout: WAITS.boot });
      await fresh.click("#restore-kind-file");
      await fresh.click("#restore-dest-s3");
      await fresh.fill("#restore-endpoint", ctx.minioUrl);
      await fresh.fill("#restore-bucket", BUCKET);
      await fresh.fill("#restore-access", ACCESS);
      await fresh.fill("#restore-secret", SECRET);
      await fresh.setInputFiles("#restore-file", kitPath);
      await fresh.fill("#restore-file-pass", WRONG_PASS);
      await fresh.fill("#restore-device-name", "the replacement laptop");
      await fresh.click("#restore-go");

      const text = await until([fresh], "the refusal", async () => {
        const el = await fresh.$("#restore-problem");
        if (el === null || !(await el.isVisible())) return false;
        const t = (await el.textContent()) ?? "";
        return t.trim() === "" ? false : t;
      }, WAITS.boot);
      assertIncludes(text, "passphrase", "the refusal names which secret was wrong");
      // THE FILE ITSELF IS FINE, and the sentence says so: the user must
      // not conclude their one artifact is ruined.
      assertIncludes(text, "file itself is fine", "the refusal exonerates the file");
      assert(await fresh.isVisible("#restore-go"), "the ceremony must stay usable");
    });

    await act("the right passphrase restores the account", async () => {
      // The file input survives the refusal (it is not a secret); the
      // passphrase field was cleared, so it is typed again.
      await fresh.setInputFiles("#restore-file", kitPath);
      await fresh.fill("#restore-file-pass", KIT_PASS);
      await fresh.click("#restore-go");
      await until([fresh], "the restore to land", async () => {
        return (await fresh.$("#restore-sheet")) === null;
      }, WAITS.boot);
      await waitForBoot(fresh, "__solo");
      const titles = await until([fresh], "the restored todos", async () => {
        const t = (await solo(fresh, "todos").catch(() => [])) as string[];
        return t.length >= TODOS.length ? t : false;
      }, WAITS.converge);
      for (const want of TODOS) {
        assertIncludes(titles.join(" | "), want, "a todo that was in the bucket");
      }
    });

    await Deno.remove(kitPath).catch(() => {});
  },
};

export default scenario;
