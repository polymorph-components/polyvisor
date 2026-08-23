// prf-unseal spike: CAN THE TEST STORY EXIST AT ALL?
//
// The PRF unseal rung (PERSISTENCE.md's parked passphrase-free rung)
// only gets a browser gate if Playwright's CDP virtual authenticator
// can produce WebAuthn PRF outputs — the hmac-secret extension the
// real rung's KDF would feed on. wosh validated every passkey ceremony
// EXCEPT the PRF extension (its passkey-store.ts asks for no
// extensions, deliberately); this spike measures exactly the missing
// fact, before any design writing or UI building.
//
// DEFENSIVE FRAME: every row here exists to prove the wrap discipline
// can be tested — determinism (the same credential and input must
// re-derive the same KEK or the rung can never unseal), separation
// (a different input must derive a different key), and the clean
// refusal (a wrong PRF output must fail AES-KW unwrap with no partial
// key). All inputs are OBVIOUSLY SYNTHETIC (labeled 0x01…/0x02…
// constants); outputs are reported as lengths and equality bits plus
// an 8-hex-char prefix, never as whole values.
//
// Run: just run    (or: deno run -A run.ts)
//
// Served and navigated on http://localhost:<port>, NOT 127.0.0.1 —
// wosh's browser-passkey.mjs finding #1: a WebAuthn RP ID must be a
// domain, and an IP is a synchronous SecurityError before the
// authenticator is consulted.

import { chromium } from "npm:playwright@1.57.0";
import type { Browser, CDPSession, Page } from "npm:playwright@1.57.0";

type Verdict = "PASS" | "FAIL" | "INFO" | "BLOCKED";
interface Row {
  n: string;
  title: string;
  verdict: Verdict;
  evidence: string;
}
const rows: Row[] = [];
let failures = 0;

function record(n: string, title: string, verdict: Verdict, evidence: string) {
  if (verdict === "FAIL" || verdict === "BLOCKED") failures++;
  rows.push({ n, title, verdict, evidence });
  console.log(`\n[${verdict}] ${n} ${title}\n        ${evidence.replace(/\n/g, "\n        ")}`);
}

// A page is required (WebAuthn needs a secure context and a document),
// but nothing about it matters: the ceremonies run in evaluate().
const PAGE = `<!doctype html><meta charset="utf-8"><title>prf spike</title><body>prf spike`;

function serve(): { server: Deno.HttpServer; port: number } {
  let port = 0;
  const server = Deno.serve({
    port: 0,
    // Bind all interfaces so `localhost` resolves whichever family the
    // resolver prefers (wosh's finding: some prefer ::1).
    hostname: "0.0.0.0",
    onListen: (addr) => {
      port = addr.port;
    },
  }, () => new Response(PAGE, { headers: { "content-type": "text/html" } }));
  return { server, port };
}

async function main() {
  const { server, port } = serve();
  await new Promise((r) => setTimeout(r, 50));
  const browser: Browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log(`chromium ${browser.version()}`);

  try {
    const ctx = await browser.newContext();
    const page: Page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`      · pageerror: ${e.message}`));

    // --- 0: the virtual authenticator, with PRF ---------------------------
    //
    // Installed BEFORE any ceremony (wosh finding #2). `hasPrf` is the
    // CDP option that makes the virtual authenticator implement
    // hmac-secret; if this Chromium's CDP rejects the option, the whole
    // browser-gate story is BLOCKED and that is the finding.
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    let authenticatorId = "";
    try {
      const res = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          hasPrf: true,
          automaticPresenceSimulation: true,
        },
        // deno-lint-ignore no-explicit-any
      } as any);
      authenticatorId = (res as { authenticatorId: string }).authenticatorId;
      record(
        "0",
        "CDP addVirtualAuthenticator accepts hasPrf:true",
        "PASS",
        `authenticatorId=${authenticatorId}`,
      );
    } catch (e) {
      record(
        "0",
        "CDP addVirtualAuthenticator accepts hasPrf:true",
        "BLOCKED",
        `CDP refused the option: ${String(e)}. No PRF-capable virtual authenticator ` +
          `in this Chromium — the browser gate cannot exist; report before building.`,
      );
      return;
    }

    await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });

    // --- 1: detection, as a page would do it -------------------------------
    await (async () => {
      const caps = await page.evaluate(async () => {
        const pkc = (globalThis as unknown as {
          PublicKeyCredential?: {
            getClientCapabilities?: () => Promise<Record<string, boolean>>;
            isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
          };
        }).PublicKeyCredential;
        if (!pkc) return { present: false as const };
        const capabilities = pkc.getClientCapabilities ? await pkc.getClientCapabilities() : null;
        const uvpaa = pkc.isUserVerifyingPlatformAuthenticatorAvailable
          ? await pkc.isUserVerifyingPlatformAuthenticatorAvailable()
          : null;
        return { present: true as const, capabilities, uvpaa };
      });
      record(
        "1",
        "detection: getClientCapabilities / UVPAA",
        "INFO",
        `PublicKeyCredential present=${caps.present}; ` +
          `getClientCapabilities=${JSON.stringify(caps.present ? caps.capabilities : null)}; ` +
          `isUserVerifyingPlatformAuthenticatorAvailable=${caps.present ? caps.uvpaa : null}`,
      );
    })();

    // --- 2: enroll — create() with the prf extension ------------------------
    //
    // The enrollment the rung would run: resident key required (the
    // device wrap must survive a lost IndexedDB hint), ES256, prf:{}
    // to ask the authenticator whether it will serve PRF for this
    // credential. What the page must see is prf.enabled === true.
    const enroll = await page.evaluate(async () => {
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { id: location.hostname, name: "prf-spike" },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: "prf-spike-device",
            displayName: "prf spike device",
          },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: {
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required",
          },
          attestation: "none",
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      }) as PublicKeyCredential | null;
      if (!cred) return { ok: false as const, why: "no credential returned" };
      const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
      const transports =
        (cred.response as AuthenticatorAttestationResponse).getTransports?.() ?? [];
      // Kept for the later gets — the rung's wrap record would store
      // exactly this (the wosh capture/replay discipline).
      (globalThis as unknown as { __credId: number[] }).__credId = Array.from(
        new Uint8Array(cred.rawId),
      );
      return {
        ok: true as const,
        prfEnabled: ext.prf?.enabled === true,
        prfExt: JSON.stringify(ext.prf ?? null),
        transports,
        credIdLen: cred.rawId.byteLength,
      };
    });
    if (!enroll.ok || !enroll.prfEnabled) {
      record(
        "2",
        "create() with prf:{} reports enabled",
        "BLOCKED",
        `enrollment: ${JSON.stringify(enroll)} — the virtual authenticator did not enable ` +
          `PRF; the browser gate cannot exist. Report before building.`,
      );
      return;
    }
    record(
      "2",
      "create() with prf:{} reports enabled",
      "PASS",
      `prf=${enroll.prfExt}; credentialId ${enroll.credIdLen} bytes; ` +
        `transports=${JSON.stringify(enroll.transports)}`,
    );

    // --- helper: one assertion with a PRF eval ------------------------------
    //
    // `salt` and `second` are byte VALUES (obviously synthetic patterns
    // chosen by the caller); the return is length/prefix only.
    const assertPrf = (opts: { salt: number; second?: number; uv: UserVerificationRequirement }) =>
      page.evaluate(async ({ salt, second, uv }) => {
        const credId = new Uint8Array(
          (globalThis as unknown as { __credId: number[] }).__credId,
        );
        const first = new Uint8Array(32).fill(salt);
        const evalInputs: { first: BufferSource; second?: BufferSource } = { first };
        if (second !== undefined) evalInputs.second = new Uint8Array(32).fill(second);
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: location.hostname,
            userVerification: uv,
            allowCredentials: [{ type: "public-key", id: credId as BufferSource }],
            extensions: { prf: { eval: evalInputs } } as AuthenticationExtensionsClientInputs,
          },
        }) as PublicKeyCredential | null;
        if (!cred) return { ok: false as const, why: "no assertion returned" };
        const ext = cred.getClientExtensionResults() as {
          prf?: { results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
        };
        const firstOut = ext.prf?.results?.first;
        const secondOut = ext.prf?.results?.second;
        const hex = (b: ArrayBuffer | undefined) =>
          b === undefined ? null : Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
        // Whole values stay in the page for cross-row comparison;
        // only lengths and prefixes leave.
        const g = globalThis as unknown as { __prf: Record<string, string | null> };
        g.__prf ??= {};
        const key = `s${salt}-uv:${uv}` + (second !== undefined ? `-2nd${second}` : "");
        g.__prf[key] = hex(firstOut);
        return {
          ok: true as const,
          key,
          firstLen: firstOut?.byteLength ?? 0,
          firstPrefix: (hex(firstOut) ?? "").slice(0, 8),
          secondLen: secondOut?.byteLength ?? 0,
        };
      }, opts);

    const samePrf = (a: string, b: string) =>
      page.evaluate(([a, b]) => {
        const g = (globalThis as unknown as { __prf: Record<string, string | null> }).__prf;
        return g[a] !== null && g[a] !== undefined && g[a] === g[b];
      }, [a, b] as const);

    // --- 3: get() evaluates PRF; 32-byte output ------------------------------
    const one = await assertPrf({ salt: 0x01, uv: "required" });
    record(
      "3",
      "get() with prf.eval produces a 32-byte output",
      one.ok && one.firstLen === 32 ? "PASS" : "FAIL",
      one.ok
        ? `first: ${one.firstLen} bytes, prefix ${one.firstPrefix}… (synthetic input 0x01×32)`
        : `assertion failed: ${JSON.stringify(one)}`,
    );

    // --- 4: DETERMINISM — the rung's load-bearing fact -----------------------
    const oneAgain = await assertPrf({ salt: 0x01, uv: "required" });
    const deterministic = one.ok && oneAgain.ok && await samePrf(one.key, oneAgain.key);
    record(
      "4",
      "same credential + same input → the SAME output across ceremonies",
      deterministic ? "PASS" : "FAIL",
      `two independent get() ceremonies with input 0x01×32 agree: ${deterministic} — ` +
        `without this the wrap could never be re-opened`,
    );

    // --- 5: separation — a different input is a different key ----------------
    const two = await assertPrf({ salt: 0x02, uv: "required" });
    const separated = one.ok && two.ok && !(await samePrf(one.key, two.key));
    record(
      "5",
      "a different input derives a different output",
      separated ? "PASS" : "FAIL",
      `inputs 0x01×32 vs 0x02×32 differ: ${separated}`,
    );

    // --- 6: uv sensitivity — must the ceremony pin userVerification? --------
    //
    // hmac-secret keeps two credRandom secrets (with and without UV);
    // if the effective UV state changed the output, an unseal that ran
    // with a different uv value than enrollment would derive a WRONG
    // key and read as tampered. Measure it rather than assume.
    const disc = await assertPrf({ salt: 0x01, uv: "discouraged" });
    const uvSame = one.ok && disc.ok && await samePrf(one.key, disc.key);
    record(
      "6",
      "uv:required vs uv:discouraged — same output?",
      "INFO",
      disc.ok
        ? `same=${uvSame}. ${
          uvSame
            ? "This authenticator answers identically; the design still pins uv, because the spec's two-credRandom shape says other authenticators may not."
            : "DIFFERENT outputs: the ceremony MUST pin userVerification, at enrollment and every unseal."
        }`
        : `uv:discouraged assertion failed: ${JSON.stringify(disc)} — also a reason to pin uv:required`,
    );

    // --- 7: eval.second — the rotation seam ----------------------------------
    const dual = await assertPrf({ salt: 0x01, second: 0x03, uv: "required" });
    record(
      "7",
      "dual-input eval (first+second) — the future rotation seam",
      "INFO",
      dual.ok
        ? `second output: ${dual.secondLen} bytes (a re-wrap could evaluate old+new inputs in one ceremony)`
        : `dual eval failed: ${JSON.stringify(dual)}`,
    );

    // --- 8: create()-time eval — can enrollment skip the first assert? ------
    const createEval = await page.evaluate(async () => {
      try {
        const cred = await navigator.credentials.create({
          publicKey: {
            rp: { id: location.hostname, name: "prf-spike" },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: "prf-spike-create-eval",
              displayName: "prf spike create eval",
            },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: {
              residentKey: "required",
              requireResidentKey: true,
              userVerification: "required",
            },
            attestation: "none",
            extensions: {
              prf: { eval: { first: new Uint8Array(32).fill(4) } },
            } as AuthenticationExtensionsClientInputs,
          },
        }) as PublicKeyCredential | null;
        if (!cred) return { ok: false as const, why: "no credential" };
        const ext = cred.getClientExtensionResults() as {
          prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
        };
        return {
          ok: true as const,
          enabled: ext.prf?.enabled === true,
          resultsAtCreate: ext.prf?.results?.first?.byteLength ?? 0,
        };
      } catch (e) {
        return { ok: false as const, why: String(e) };
      }
    });
    record(
      "8",
      "PRF eval at create() time",
      "INFO",
      createEval.ok
        ? `enabled=${createEval.enabled}, results at create: ${createEval.resultsAtCreate} bytes ` +
          `(0 = enrollment needs one follow-up assertion to reach the output; the design assumes it does)`
        : `create-time eval refused: ${createEval.why}`,
    );

    // --- 9: the derivation chain, and the crossing ---------------------------
    //
    // The rung's whole pipeline, in one row: PRF output → HKDF-SHA-256
    // → non-extractable AES-KW key; wrap a throwaway AES-GCM key;
    // unwrap it back; a KEK derived from a DIFFERENT PRF output must
    // refuse the unwrap cleanly (AES-KW's integrity check). Then the
    // derived KEK structured-clones through postMessage into a Worker
    // and unwraps THERE — the page→worker crossing the real rung
    // needs, carrying a handle rather than bytes.
    const chainRow = await page.evaluate(async () => {
      const g = (globalThis as unknown as { __prf: Record<string, string | null> }).__prf;
      const unhex = (h: string) =>
        new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
      const prfOut = unhex(g["s1-uv:required"]!);
      const otherOut = unhex(g["s2-uv:required"]!);

      const kekFrom = async (ikm: Uint8Array, extractable = false) => {
        const material = await crypto.subtle.importKey(
          "raw",
          ikm as BufferSource,
          "HKDF",
          false,
          ["deriveKey"],
        );
        return await crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(32).fill(9) as BufferSource, // synthetic
            info: new TextEncoder().encode("pm-prf-spike kek v1") as BufferSource,
          },
          material,
          { name: "AES-KW", length: 256 },
          extractable,
          ["wrapKey", "unwrapKey"],
        );
      };

      const kek = await kekFrom(prfOut);
      const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]);
      const wrapped = new Uint8Array(
        await crypto.subtle.wrapKey("raw", dek, kek, { name: "AES-KW" }),
      );
      // Re-derive from the same PRF output — a second ceremony's KEK —
      // and unwrap.
      const kek2 = await kekFrom(prfOut);
      let reopened = false;
      try {
        await crypto.subtle.unwrapKey(
          "raw",
          wrapped as BufferSource,
          kek2,
          { name: "AES-KW" },
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        reopened = true;
      } catch { /* stays false */ }
      // The wrong PRF output must refuse.
      const kekWrong = await kekFrom(otherOut);
      let wrongRefused = false;
      try {
        await crypto.subtle.unwrapKey(
          "raw",
          wrapped as BufferSource,
          kekWrong,
          { name: "AES-KW" },
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      } catch {
        wrongRefused = true;
      }

      // The crossing: the non-extractable KEK handle through
      // postMessage into a worker, unwrap there.
      const workerSrc = `
        onmessage = async (ev) => {
          const { kek, wrapped } = ev.data;
          try {
            const dek = await crypto.subtle.unwrapKey(
              "raw", wrapped, kek, { name: "AES-KW" },
              { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
            postMessage({
              ok: true,
              kekExtractable: kek.extractable,
              dekExtractable: dek.extractable,
              alg: dek.algorithm.name,
            });
          } catch (e) {
            postMessage({ ok: false, why: String(e) });
          }
        };`;
      const worker = new Worker(
        URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })),
      );
      const crossed = await new Promise<Record<string, unknown>>((resolve) => {
        worker.onmessage = (ev) => resolve(ev.data as Record<string, unknown>);
        worker.postMessage({ kek, wrapped });
        setTimeout(() => resolve({ ok: false, why: "timeout" }), 5000);
      });
      worker.terminate();

      return {
        kekExtractable: kek.extractable,
        wrappedLen: wrapped.length,
        reopened,
        wrongRefused,
        crossed,
      };
    });
    const chainOk = chainRow.kekExtractable === false && chainRow.wrappedLen === 40 &&
      chainRow.reopened && chainRow.wrongRefused &&
      (chainRow.crossed as { ok?: boolean }).ok === true;
    record(
      "9",
      "PRF → HKDF → AES-KW round-trip; wrong output refused; KEK handle crosses to a worker",
      chainOk ? "PASS" : "FAIL",
      `derived KEK extractable=${chainRow.kekExtractable}; AES-KW wrap ${chainRow.wrappedLen} ` +
        `bytes; re-derived KEK unwraps: ${chainRow.reopened}; a KEK from a different PRF ` +
        `output refuses cleanly: ${chainRow.wrongRefused}; postMessage'd handle unwraps in a ` +
        `Worker: ${JSON.stringify(chainRow.crossed)}`,
    );

    // --- 10: the credential survives a reload (CDP session binding) --------
    await page.reload({ waitUntil: "load" });
    const afterReload = await page.evaluate(async () => {
      // The page lost __credId with the document; an empty allow list
      // asks the authenticator for any resident credential for this RP
      // — the discoverable-credential path a lost IndexedDB would need.
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: location.hostname,
          userVerification: "required",
          allowCredentials: [],
          extensions: {
            prf: { eval: { first: new Uint8Array(32).fill(1) } },
          } as AuthenticationExtensionsClientInputs,
        },
      }) as PublicKeyCredential | null;
      if (!cred) return { ok: false as const };
      const ext = cred.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      return { ok: true as const, firstLen: ext.prf?.results?.first?.byteLength ?? 0 };
    });
    record(
      "10",
      "virtual authenticator + resident credential survive a REAL reload; empty allow list works",
      afterReload.ok && afterReload.firstLen === 32 ? "PASS" : "FAIL",
      `discoverable-credential assertion after navigation: ${JSON.stringify(afterReload)} ` +
        `(two credentials exist by now; the authenticator picked one — fine for this row's ` +
        `question, which is liveness, not identity)`,
    );

    void authenticatorId;
  } finally {
    await browser.close();
    await server.shutdown();
  }
}

await main();

console.log("\n--- verdicts ---");
for (const r of rows) console.log(`  [${r.verdict}] ${r.n} ${r.title}`);
await Deno.writeTextFile(
  new URL("./last-run.json", import.meta.url).pathname,
  JSON.stringify(rows, null, 2) + "\n",
);
if (failures > 0) {
  console.error(`\n${failures} row(s) FAILED/BLOCKED`);
  Deno.exit(1);
}
console.log("\nall rows pass");
