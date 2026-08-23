// GOOGLE DRIVE FROM THE WORKER HOST — the round after STORAGE-EGRESS.md,
// recorded in runtime/DRIVE.md. Same device-store plumbing as
// solo-storage.ts's MinIO scenario, but the destination is bearer-based
// and the ceremony crosses a real popup: the worker mints the PKCE
// verifier and runs the token exchange (DRIVE.md §3), the page only
// ever opens the window and relays a one-shot code. This scenario needs
// no MinIO at all — it drives its own in-process fake Drive
// (demo/host/fake-drive.ts) instead — and it must not disturb the
// harness's MinIO, which stays up for every other scenario regardless.
//
// NINE CLAIMS (plus 3b, the space choice), in DRIVE.md's own order:
//
//   1. An account and a todo, through the real app frame — made during
//      FIRST RUN, before any other sheet ever opens (PR #88: the entry
//      ceremony is a drawer sheet mounted only at first run, and it is
//      gone the moment any other sheet has opened once).
//   2. Kept device (until-reseal, no passphrase), exactly as
//      solo-storage.ts's own first beat — this scenario needs a device
//      that survives a reload to make claim 7 possible.
//   3. THE REAL POPUP PATH (§3): the worker mints PKCE, the page opens
//      window.open on the fake's headless `/auth`, which 302s straight
//      back with a synthetic code the page relays to the opener. The
//      breadcrumbs are two beats, not one: "storage:consented" (the
//      exchange finished) and then "storage:bound" (bind + first
//      flush).
//   3b. THE SPACE CHOICE IS THE SHEET'S, AND ITS DEFAULT IS THE HIDDEN
//      app-data space (§5): the scenario asserts the default is
//      pre-selected rather than setting it, so a regression that
//      silently flipped the default to the visible folder fails here.
//      The space rides the whole way through — consent scope, binding,
//      and the space the bytes actually land in.
//   4. TOKENS TOUCH NO PAGE STORAGE (§3's bearer ban, and §4: the
//      tokens are born in worker memory and rest DEK-sealed — never on
//      the page's side of the port at all). Scanned for the fake's own
//      synthetic labels, in BOTH localStorage and sessionStorage.
//   5. BYTES LANDED IN THE HIDDEN SPACE: the fake's own in-memory tree
//      (DRIVE.md §2's layout — root → `docs` → keyed object names) has
//      the root folder, the `docs` container and at least one object
//      after the connect's first flush — all of it in the APPDATA
//      space, which is what the sheet defaults to (DRIVE.md §5), and
//      NONE of it in the visible one. Structure, not literal names: the
//      leaf names are keyed hashes on purpose.
//   6. Sync now, then "storage:synced" — the fake's object count does
//      not decrease (the todo from claim 1 is what this sync carries).
//   7. A REAL RELOAD (§4: "bringUpEngine re-arms the grant and
//      re-applies initStore"): the binding and the consent both come
//      back with NOTHING re-entered, and a Sync now afterwards succeeds
//      with no fresh authorization_code exchange — refresh-grant calls
//      are fine (that is the 401→refresh→retry shape), a new code
//      exchange would mean the consent did not actually survive.
//   8. RESEAL SEALS IT, exactly as solo-storage.ts's device-store beat:
//      the upgrade ceremony, the picker, nothing personal, then the
//      passphrase brings the binding AND the consent back.
//   9. FORGET IS THE HONEST DISCONNECT (§4's mirror of
//      STORAGE-EGRESS.md §6): revokes at the fake (a real POST
//      /revoke), deletes the sealed consent, and DOES NOT touch the
//      binding — the folder is still the device's destination, only
//      the account behind it was forgotten.

import type { Ctx, Scenario } from "../run.ts";
import { act, assert, assertEquals, assertIncludes, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, solo, until, WAITS } from "../solo-util.ts";
import { startFakeDrive } from "../../host/fake-drive.ts";
import type { FakeDrive } from "../../host/fake-drive.ts";
import type { Page } from "npm:playwright@1.57.0";

const ROOT = "pm-solo-drive";
// Synthetic installed-app identifiers (DRIVE.md §3: "not treated as a
// secret" by Google's own docs) — never anything issued by Google, and
// never anything a person would type for a real account.
const CLIENT_ID = "SYNTHETIC-CLIENT";
const CLIENT_SECRET = "synthetic-client-secret-0000";

/** Every localStorage AND sessionStorage entry — key and value — for
 * the bearer-ban claim: the fake's own synthetic token labels
 * (`synthetic-access-…`/`synthetic-refresh-…`) must appear NOWHERE on
 * the page's side of the port. */
function allPageStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        out[k] = store.getItem(k) ?? "";
      }
    }
    return out;
  });
}

/** The `/auth` requests the fake has seen. A fresh authorization_code
 * ceremony MUST hit `/auth` first (that is where the code and the PKCE
 * challenge are minted) — so "no re-consent happened" is falsifiable as
 * "this count did not change", unlike a `/token` count, which a
 * refresh-grant call would legitimately bump on its own schedule and so
 * can only ever go up regardless of whether a re-consent occurred. */
function authCallCount(fake: FakeDrive): number {
  return fake.requests().filter((r) => r.method === "GET" && r.path === "/auth").length;
}

const scenario: Scenario = {
  name: "solo-gdrive",
  why:
    "the worker host's Google Drive egress, driven end to end through the real popup path against an in-process fake — tokens never touch page storage, bytes land in the fake's tree, and reseal/forget behave as DRIVE.md §§3-4 rule",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: {
      [SOLO_KEYS.hue]: "265",
      [SOLO_KEYS.identity]: JSON.stringify({ name: "Ada" }),
    },
  },

  async run(page: Page, _ctx: Ctx) {
    const fake = await startFakeDrive();
    try {
      await act("an account and a todo, through the real app frame", async () => {
        // ORDER MATTERS (PR #88): the entry ceremony (`solo-new-account`)
        // lives in a drawer sheet mounted only at first run — click it
        // any later (e.g. after the storage sheet has already been
        // opened once) and the hook silently finds nothing. So the
        // account is made HERE, before any other sheet ever opens, the
        // same idiom solo-persistence.ts and solo-passkey.ts already
        // follow.
        assertEquals(await solo(page, "newAccount"), true, "the entry sheet's button was clicked");
        await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
        await appFrame(page).locator("input.new-todo").waitFor({
          state: "visible",
          timeout: WAITS.converge,
        });
        await addTodo(page, "buy milk");
        const titles = await until([page], "the todo", async () => {
          const t = (await solo(page, "todos")) as string[];
          return t.length >= 1 ? t : false;
        }, WAITS.converge);
        assertEquals(titles[0], "buy milk", `the todos: ${JSON.stringify(titles)}`);
      });

      await act(
        "a device, kept (until-reseal, no passphrase) so a reload auto-unseals",
        async () => {
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
        },
      );

      await act(
        "connect through the sheet — a real popup, PKCE gated by the fake",
        async () => {
          await solo(page, "setGdriveEndpoints", {
            apiBase: fake.url,
            authUrl: `${fake.url}/auth`,
            tokenUrl: `${fake.url}/token`,
          });
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
          await page.waitForSelector("#storage-kind-gdrive", { timeout: 15_000 });
          // A real click, but through evaluate: the drawer sheet renders
          // taller than the viewport at this point (the S3 fields are
          // still in the DOM, merely hidden), which Playwright's own
          // actionability check reads as "outside the viewport" even
          // though the element is visible and clickable to a user who
          // has scrolled. `.click()` on the element itself is the same
          // DOM event a user's click dispatches.
          await page.evaluate(() => {
            (document.getElementById("storage-kind-gdrive") as HTMLInputElement).click();
          });
          await page.waitForSelector("#storage-gd-root", { state: "visible", timeout: 15_000 });
          // THE DEFAULT IS ASSERTED, NOT SET (DRIVE.md §5): the sheet
          // must arrive with hidden app data already chosen, so a
          // regression that flipped the default to the visible folder
          // fails right here rather than quietly changing where every
          // user's bytes land. The scenario then leaves it alone and
          // drives the whole ceremony on the default.
          const spaceDefaults = await page.evaluate(() => ({
            appdata:
              (document.getElementById("storage-gd-space-appdata") as HTMLInputElement).checked,
            drive: (document.getElementById("storage-gd-space-drive") as HTMLInputElement).checked,
          }));
          assertEquals(spaceDefaults.appdata, true, "hidden app data is the sheet's default");
          assertEquals(spaceDefaults.drive, false, "the visible folder is not the default");
          await page.fill("#storage-gd-root", ROOT);
          await page.fill("#storage-gd-client", CLIENT_ID);
          await page.fill("#storage-gd-secret", CLIENT_SECRET);
          await page.click("#storage-connect");
          const consented = await until([page], "storage:consented", async () => {
            const t = (await solo(page, "bootTrace")) as string[];
            return t.includes("storage:consented") ? t : false;
          }, 30_000);
          assert(
            consented.includes("storage:consented"),
            `bootTrace: ${JSON.stringify(consented)}`,
          );
          const bound = await until([page], "storage:bound", async () => {
            const t = (await solo(page, "bootTrace")) as string[];
            return t.includes("storage:bound") ? t : false;
          }, 60_000);
          assert(bound.includes("storage:bound"), `bootTrace: ${JSON.stringify(bound)}`);
        },
      );

      await act(
        "tokens touch NO page storage; the secret field is cleared; consent is true",
        async () => {
          const all = await allPageStorage(page);
          for (const [k, v] of Object.entries(all)) {
            assert(
              !/synthetic-access|synthetic-refresh/.test(v),
              `page storage[${k}] carried a token: ${v}`,
            );
          }
          const secretValue = await page.evaluate(() =>
            (document.getElementById("storage-gd-secret") as HTMLInputElement | null)?.value ?? ""
          );
          assertEquals(secretValue, "", "the client secret field after connect");
          // The consent is a nullable RECORD naming the space it was
          // granted for (rpc.ts) — and the space it names is the one
          // the sheet defaulted to, which is how "the default reached
          // the OAuth scope" is observable from out here at all.
          assertEquals(
            (await solo(page, "gdriveConsent"))?.space,
            "appdata",
            "the device holds a consent, granted for the hidden app-data space",
          );
        },
      );

      await act("bytes landed: the fake's tree has the root folder and an object", async () => {
        // ASKED OF THE HIDDEN SPACE, because that is where the sheet's
        // default sends them. `childNames` DEFAULTS to the visible
        // space (fake-drive.ts), so the negative below is the same
        // question asked the other way — and it is the half that would
        // catch a space that never made it past the sheet.
        const n = await until([page], "an object in the fake's hidden space", async () => {
          const names = fake.childNames(ROOT, "appDataFolder");
          return names.length > 0 ? names : false;
        }, 30_000);
        assert(n.length > 0, `expected children under ${ROOT} in the app-data space, got none`);
        // DRIVE.md §2's layout: root → `docs`/`pickup` → keyed names.
        // STRUCTURE is what this asserts, because the leaf names are
        // keyed hashes now and nothing on this side of the fake can
        // spell them. What an observer of the tree sees is exactly what
        // this check can see: fixed container words, and counts.
        assert(n.includes("docs"), `expected a docs folder under ${ROOT}, got ${JSON.stringify(n)}`);
        const total = fake.files().length;
        assert(total > 0, "the fake's store is empty after the connect's first flush");
        // NOTHING IN THE VISIBLE SPACE. The fake answers a cross-space
        // list with an EMPTY list rather than an error, exactly as
        // Google does, so this is the shape a mis-spaced strategy fails
        // in: the user's own Drive shows nothing at all.
        assertEquals(
          fake.childNames("").includes(ROOT),
          false,
          "the visible Drive root must not carry the store's folder",
        );
        assertEquals(
          fake.files().filter((f) => f.space === "drive").length,
          0,
          "no file may land in the visible space on an app-data binding",
        );
      });

      await act("Sync now — storage:synced — the object count does not decrease", async () => {
        const before = fake.files().length;
        await page.waitForSelector("#storage-sync", { state: "visible", timeout: 15_000 });
        await page.click("#storage-sync");
        const trace = await until([page], "storage:synced", async () => {
          const t = (await solo(page, "bootTrace")) as string[];
          return t.includes("storage:synced") ? t : false;
        }, 30_000);
        assert(trace.includes("storage:synced"), `bootTrace: ${JSON.stringify(trace)}`);
        const after = fake.files().length;
        assert(after >= before, `object count should not decrease: ${before} -> ${after}`);
        await page.evaluate(() => {
          (Array.from(document.querySelectorAll("#storage-sheet button")) as HTMLButtonElement[])
            .find((b) => b.textContent === "Close")?.click();
        });
      });

      await act(
        "a REAL reload: binding and consent come back with nothing re-entered",
        async () => {
          const authCallsBefore = authCallCount(fake);
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForBoot(page, "__solo");
          const trace = (await solo(page, "bootTrace")) as string[];
          assert(trace.includes("auto-unseal"), `trace: ${JSON.stringify(trace)}`);
          const status = await until([page], "the gdrive binding, restored", async () => {
            const s = await solo(page, "storageStatus");
            return s !== null ? s : false;
          }, 30_000);
          assertEquals(status.kind, "gdrive", "the restored binding's kind");
          assertEquals(status.root, ROOT, "the restored root folder");
          assertEquals(status.clientId, CLIENT_ID, "the restored client id");
          assertEquals(status.space, "appdata", "the restored space");
          assertEquals(
            (await solo(page, "gdriveConsent"))?.space,
            "appdata",
            "the consent — and its space — survived the reload",
          );

          // Sync now afterwards must succeed with NO new authorization_code
          // exchange. A fresh ceremony would have to hit `/auth` first (the
          // popup's whole job is to land there and relay the code back) —
          // so the FALSIFIABLE form of "no re-consent" is the `/auth`
          // request count being UNCHANGED across this beat, not a `/token`
          // count, which a legitimate refresh-grant call could bump either
          // way and so can only prove the log is non-decreasing (true
          // whether or not a re-consent happened — Finding 2).
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
          await page.click("#storage-sync");
          // bootTrace is per-boot (this is a fresh trace since the
          // reload), so "did a second sync happen" is simply "did this
          // boot's trace ever get storage:synced" — and "no re-consent"
          // is "this boot's trace never got storage:consented at all".
          const trace2 = await until([page], "storage:synced (post-reload)", async () => {
            const t = (await solo(page, "bootTrace")) as string[];
            return t.includes("storage:synced") ? t : false;
          }, 30_000);
          assert(
            trace2.includes("storage:synced"),
            `expected storage:synced after the reload: ${JSON.stringify(trace2)}`,
          );
          // No fresh authorization popup was ever opened for this sync —
          // this boot's own trace carries NO "storage:consented" at all.
          assertEquals(
            trace2.filter((x) => x === "storage:consented").length,
            0,
            `re-consent happened where it must not: ${JSON.stringify(trace2)}`,
          );
          const authCallsAfter = authCallCount(fake);
          assertEquals(
            authCallsAfter,
            authCallsBefore,
            "a fresh /auth request means a re-consent ran where it must not have",
          );
          await page.evaluate(() => {
            (Array.from(document.querySelectorAll("#storage-sheet button")) as HTMLButtonElement[])
              .find((b) => b.textContent === "Close")?.click();
          });
        },
      );

      const PASS = "correct-horse-battery-staple-TEST";
      await act("reseal seals it: picker, nothing personal", async () => {
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
        const picker = await until([page], "the picker", async () => {
          const p = await solo(page, "picker");
          return p.visible ? p : false;
        }, WAITS.boot);
        assert(picker.rows.includes("laptop"), `picker rows: ${JSON.stringify(picker.rows)}`);
        const body = await page.evaluate(() => document.body.textContent ?? "");
        assert(!body.includes("Ada"), "no personal name while sealed");
      });

      await act(
        "the passphrase brings the binding AND the consent back",
        async () => {
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
          assertEquals(status.root, ROOT, "the same binding, back with the seal");
          assertEquals(
            (await solo(page, "gdriveConsent"))?.space,
            "appdata",
            "the consent, and the space it names, came back sealed with the device",
          );
        },
      );

      await act(
        "forget is the honest disconnect: revokes at the fake, keeps the binding",
        async () => {
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
          await page.waitForSelector("#storage-gd-forget", { state: "visible", timeout: 15_000 });
          const revokesBefore = fake.requests().filter((r) => r.path === "/revoke").length;
          // Two clicks, exactly as the sheet arms it: the first states
          // what is about to happen, the second commits.
          await page.click("#storage-gd-forget");
          await page.click("#storage-gd-forget");
          const trace = await until([page], "storage:forgotten", async () => {
            const t = (await solo(page, "bootTrace")) as string[];
            return t.includes("storage:forgotten") ? t : false;
          }, 30_000);
          assert(trace.includes("storage:forgotten"), `bootTrace: ${JSON.stringify(trace)}`);
          const revokesAfter = fake.requests().filter((r) => r.path === "/revoke").length;
          assert(
            revokesAfter > revokesBefore,
            "forget must POST /revoke at the fake (best-effort revocation)",
          );
          assertEquals(
            await solo(page, "gdriveConsent"),
            null,
            "the consent is gone after forgetting the account",
          );
          // THE MIRROR (DRIVE.md §4 / STORAGE-EGRESS.md §6): forgetting
          // the account is not forgetting the destination.
          const status = await solo(page, "storageStatus");
          assert(status !== null, "the binding must survive a forget — only the consent is gone");
          assertEquals(status.root, ROOT, "the destination is unchanged by forget");
        },
      );
    } finally {
      await fake.close();
    }
  },
};

export default scenario;
