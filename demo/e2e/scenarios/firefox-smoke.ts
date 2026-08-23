// THE ONE GECKO BEAT: the engine runs, and the device store works,
// under Firefox.
//
// WHY IT EXISTS. Everything else in this suite is Chromium, and the
// demo's persistence story does not rest on standards so much as on
// five platform features whose availability is a per-ENGINE fact:
// WebAssembly JS Promise Integration (the engine's kernel parks guest
// frames on host promises through it), module SharedWorkers (the device
// host is one), OPFS (the chunk store and the archives), Web Locks (one
// writer per namespace), and a non-extractable CryptoKey surviving a
// structured clone into IndexedDB (the platform posture). A regression
// in any of them under Gecko was, until this scenario, findable only by
// the project owner opening the demo on his phone — which is exactly
// how the failure this beat now guards against was found.
//
// WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. This is a smoke
// beat, not a second matrix: it walks the T0 anchor path — boot, an
// account, a todo, a reload, the todo still there — because that path
// touches all five features and nothing else here would. Every visor
// ceremony, every storage flow and every pairing act stays Chromium's;
// duplicating them under Gecko would double the wall clock to re-assert
// claims about the visor's own code, which is engine-independent.
//
// THE PREF. Playwright's Firefox build ships JSPI off where release
// Firefox has it on; the harness restores the release default at launch
// (run.ts's `FIREFOX_PREFS`, which carries the measurement and the
// date). The first act below reads the feature back OUT OF THE PAGE
// rather than trusting the launch option — a pref that silently stops
// applying would otherwise turn this scenario into a slow, green lie
// about a browser that cannot run the engine at all.

import type { Page } from "npm:playwright@1.57.0";
import type { Scenario } from "../run.ts";
import { act, assert, assertEquals, SOLO_KEYS, waitForBoot } from "../util.ts";
import { addTodo, appFrame, solo, until, WAITS } from "../solo-util.ts";

const scenario: Scenario = {
  name: "firefox-smoke",
  why: "the engine runs and the device store works under Gecko, along the T0 anchor path",
  engine: "firefox",
  page: {
    path: "/solo.html",
    bootGlobal: "__solo",
    storage: { [SOLO_KEYS.hue]: "212" },
  },

  async run(page: Page) {
    await act("the five platform facts the device store rests on, read off Gecko", async () => {
      const feats = await page.evaluate(async () => {
        const out: Record<string, string> = {};
        out.jspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending;
        out.sharedWorker = typeof SharedWorker;
        out.opfs = typeof navigator.storage?.getDirectory;
        out.locks = typeof navigator.locks;
        // JSPI IS PER-GLOBAL (spikes/worker-host/README.md Q1), and the
        // global that matters is the SharedWorker's — the page's answer
        // says nothing about the realm that instantiates the engine.
        // Asked through a throwaway module SharedWorker, which also
        // answers the module-SharedWorker question by existing.
        const src =
          `self.onconnect = (e) => e.ports[0].postMessage(typeof WebAssembly.Suspending);`;
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        const sw = new SharedWorker(url, { type: "module", name: "e2e-jspi-probe" });
        out.workerJspi = await new Promise<string>((res) => {
          const t = setTimeout(() => res("TIMEOUT"), 5_000);
          sw.port.onmessage = (ev) => {
            clearTimeout(t);
            res(String(ev.data));
          };
          sw.onerror = () => {
            clearTimeout(t);
            res("ERROR");
          };
          sw.port.start();
        });
        // A non-extractable signing key, stored as a HANDLE. The device
        // store's platform posture is exactly this and nothing more —
        // if structured clone refuses it, the posture is unavailable.
        try {
          const k = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign", "verify"],
          );
          const db: IDBDatabase = await new Promise((res, rej) => {
            const r = indexedDB.open("e2e-gecko-probe", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("s");
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          await new Promise((res, rej) => {
            const tx = db.transaction("s", "readwrite");
            tx.objectStore("s").put(k.privateKey, "k");
            tx.oncomplete = () => res(null);
            tx.onerror = () => rej(tx.error);
          });
          out.keyHandleInIdb = "ok";
        } catch (e) {
          out.keyHandleInIdb = `refused: ${(e as Error).message}`;
        }
        return out;
      });
      const detail = JSON.stringify(feats);
      assertEquals(feats.jspi, "function", `JSPI in the page: ${detail}`);
      assertEquals(feats.workerJspi, "function", `JSPI in a module SharedWorker: ${detail}`);
      assertEquals(feats.sharedWorker, "function", `SharedWorker: ${detail}`);
      assertEquals(feats.opfs, "function", `OPFS: ${detail}`);
      assertEquals(feats.locks, "object", `Web Locks: ${detail}`);
      assertEquals(feats.keyHandleInIdb, "ok", `a key handle into IndexedDB: ${detail}`);
    });

    await act("a T0 device, an account, and a todo — under Gecko", async () => {
      const st = await solo(page, "deviceStatus");
      assertEquals(st.tier, "t0", "a first device starts ephemeral here too");
      await solo(page, "newAccount");
      await until([page], "the account", async () => await solo(page, "hasAccount"), 60_000);
      await appFrame(page).locator("input.new-todo").waitFor({
        state: "visible",
        timeout: WAITS.converge,
      });
      await addTodo(page, "buy stamps");
      const titles = await until([page], "the todo", async () => {
        const t = (await solo(page, "todos")) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "buy stamps", `the todos: ${JSON.stringify(titles)}`);
    });

    await solo(page, "checkpoint");

    await act("a reload: the anchor resumes this tab's device and the todo is there", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForBoot(page, "__solo");
      const trace = (await solo(page, "bootTrace")) as string[];
      assert(trace.includes("anchor:t0"), `boot trace: ${JSON.stringify(trace)}`);
      const st = await solo(page, "deviceStatus");
      assertEquals(st.resumed, true, "it RESUMED from the checkpoint — sealed bytes off OPFS");
      const titles = await until([page], "the resumed todo", async () => {
        const t = (await solo(page, "todos").catch(() => [])) as string[];
        return t.length >= 1 ? t : false;
      }, WAITS.converge);
      assertEquals(titles[0], "buy stamps", `resumed todos: ${JSON.stringify(titles)}`);
    });
  },
};

export default scenario;
