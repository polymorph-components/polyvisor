// The frame backend: the queued op protocol carried to a REAL sandboxed
// iframe (#16's per-surface frame; #5's zero-network frame). This is
// backend-channel.ts (../../todomvc/host/backend-channel.ts:1) with the
// applier moved out of the visor's realm entirely — the frame side lives in
// ./frame.ts and reaches the DOM of its own document, never ours.
//
// Why the demo uses this instead of the `direct` backend: the visor's strip
// carries the user's personal colour, which must never be disclosed to
// component code (see web/index.html's visor-strip comment). While the
// guest's nodes lived in THE VISOR'S OWN DOCUMENT, non-disclosure rested on
// an allowlist holding the line against CSS custom-property inheritance,
// class borrowing, getComputedStyle, and whatever the allowlist might
// grow next. A separate document on an OPAQUE ORIGIN closes that whole
// class structurally: there is nothing to read, not merely nothing
// allowed to be read.
//
// The frame's document is a `srcdoc` string this module ASSEMBLES, never
// a URL it navigates to (#142). A sandboxed frame's navigation is
// invisible to a service worker in both engines, so a real-URL skeleton
// would be served raw by the origin, outside the release-integrity path,
// with whatever headers the host sends — unpinnable. Assembling the
// document here means every byte of it came through the visor's own
// asset path, and lets us insert a <meta> CSP whose `script-src` is a
// hash of the bundled frame.js text. CSP policies compose, so that
// policy's `default-src 'none'` makes the frame network-dead regardless
// of what the visor's own inherited policy allows.
//
// CONTRACT (#142's correction comment, 2026-09-05): the hash below is
// computed at RUNTIME and lives only in the frame's own meta. That is
// sufficient exactly as long as the visor's page carries no header
// `script-src` — the inherited policy must also admit the inline
// script, and a header cannot know a runtime-assembled hash. When the
// visor starts shipping a header CSP, the same hash has to be emitted
// into it at build/serve time from the same frame.js bytes.

import type { Backend } from "../surface/backend.ts";
import { createQueuedBackend, type Op } from "../surface/backend-queued.ts";
import type { UiEvent } from "../surface/events.ts";

type ShellMsg =
  | { t: "ops"; ops: Op[] }
  | { t: "drain"; id: number }
  | { t: "theme"; mode: "light" | "dark" };
type FrameMsg =
  | { t: "event"; ev: UiEvent }
  | { t: "drained"; id: number }
  | { t: "height"; px: number };

/** Floor for the frame's height: an unsized iframe is 150px by spec, and
 * a frame that reports 0 before its first paint would otherwise collapse
 * to invisible. */
const MIN_HEIGHT_PX = 48;

/** The three texts the frame document is assembled from, at the same
 * relative URLs the template used to reference: they are served
 * alongside whatever page loaded the visor. Fetched in the VISOR's
 * realm — that is what puts them on the same path as every other visor
 * asset, and hence what makes the frame's content pinned. */
const TEMPLATE_URL = "./frame.html";
const STYLE_TAG = `<link rel="stylesheet" href="./todomvc-app.css">`;
const SCRIPT_TAG = `<script type="module" src="./frame.js"></script>`;

/** One assembly per page, shared by every surface. */
let srcdocOnce: Promise<string> | null = null;

function frameSrcdoc(): Promise<string> {
  return (srcdocOnce ??= buildSrcdoc());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function buildSrcdoc(): Promise<string> {
  const [template, css, js] = await Promise.all([
    fetchText(TEMPLATE_URL),
    fetchText("./todomvc-app.css"),
    fetchText("./frame.js"),
  ]);

  // Inlining is by exact tag match against the template, so a template
  // edit that moves an asset fails LOUDLY here instead of yielding a
  // frame that is silently missing its stylesheet or its script.
  for (const tag of [STYLE_TAG, SCRIPT_TAG]) {
    if (!template.includes(tag)) {
      throw new Error(`frame.html no longer contains ${tag}`);
    }
  }
  // An inline script is terminated by the first `</script` in the text,
  // whatever it is nested inside; a bundle containing one would break
  // out of the frame document rather than run.
  if (/<\/script/i.test(js)) {
    throw new Error("frame.js contains </script and cannot be inlined");
  }

  // The hash is over the EXACT text content of the inline <script>
  // element — every byte between the tags, INCLUDING the surrounding
  // newlines. Build that string once and hash the same value we embed.
  const inlineScript = `\n${js}\n`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(inlineScript),
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  // `img-src data:` is not laxity: TodoMVC's stylesheet draws its
  // glyphs from data-URL SVGs, and `data:` is not a network scheme, so
  // the zero-exfiltration property is untouched (#142).
  const meta = `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; script-src 'sha256-${hash}'; ` +
    `style-src 'unsafe-inline'; img-src data:">`;

  // Insert as the first child of <head>, so the policy is in force from
  // the first thing the parser sees after it. Anchored PAST `<html`:
  // the template's leading comment is prose about this very tag, and a
  // naive first-match replace buries the policy inside that comment
  // (where it is inert and invisible — this bit once).
  const headAt = template.indexOf("<head>", template.indexOf("<html"));
  if (headAt < 0) throw new Error("frame.html has no <head> after <html>");
  const withMeta = template.slice(0, headAt) +
    `<head>\n  ${meta}` + template.slice(headAt + "<head>".length);

  return withMeta
    .replace(STYLE_TAG, `<style>\n${css}\n</style>`)
    // `type="module"` is required, not stylistic: `deno bundle` emits
    // `import.meta.url`, which is a syntax error in a classic script.
    // Inline module scripts are hash-addressable in both engines.
    .replace(SCRIPT_TAG, `<script type="module">${inlineScript}</script>`);
}

export interface FrameBackend {
  /** Resolves once the port is live — i.e. once ops posted through the
   * returned Backend are guaranteed to reach the frame's applier.
   *
   * REJECTS if the surface is destroyed before the handshake completes.
   * That rejection is a CANCELLATION, not a fault: the only way to reach
   * it is for somebody to have torn this surface down while it was
   * coming up, and the caller is expected to recognise its own
   * supersession rather than report a failure (see demo.ts's mountPanel,
   * where the generation check is what tells the two apart). */
  backend: Promise<Backend>;
  frame: HTMLIFrameElement;
  /** Tear the surface down, and RESOLVE WHEN IT IS ACTUALLY GONE.
   *
   * The completion signal is the point. Teardown is not over when
   * `destroy()` returns: the frame's window may still have messages in
   * flight toward us (a `frame-ready` posted a moment before the
   * removal), and a caller that creates the NEXT surface synchronously
   * is racing that queue. Awaiting this promise is what makes a
   * remount-after-teardown ordered instead of hopeful.
   *
   * Idempotent: every call returns the same completion. */
  destroy(): Promise<void>;
}

export function createFrameBackend(
  container: HTMLElement,
  dispatch: (ev: UiEvent) => void,
  theme: "light" | "dark" = "light",
): FrameBackend {
  const frame = document.createElement("iframe");
  // THE load-bearing attribute. `allow-scripts` and NOTHING else: with
  // no `allow-same-origin`, the frame's document gets an opaque origin,
  // so it cannot touch the visor's DOM, styles, cookies or storage.
  // Adding `allow-same-origin` here would silently undo the entire
  // point of this file.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText =
    `width: 100%; border: none; display: block; height: ${MIN_HEIGHT_PX}px;`;
  frame.setAttribute("scrolling", "no");
  container.appendChild(frame);

  let port: MessagePort | null = null;
  let destroyed = false;
  /** The completion of the ONE teardown this surface ever gets — see
   * `destroy()`. Non-null means teardown has started. */
  let teardown: Promise<void> | null = null;
  const pendingDrains = new Map<number, () => void>();
  let drainId = 0;

  let resolveBackend!: (b: Backend) => void;
  let rejectBackend!: (e: unknown) => void;
  const backend = new Promise<Backend>((res, rej) => {
    resolveBackend = res;
    rejectBackend = rej;
  });
  // Nobody is required to await a backend whose surface got torn down
  // first; keep the rejection from surfacing as an unhandled rejection
  // when they don't.
  backend.catch(() => {});

  // The document arrives BY VALUE, one turn later (assembly needs three
  // fetches and a digest, both async). The `frame-ready` handshake below
  // is already listening by then, and a surface torn down while the
  // assembly was in flight must not get a document at all.
  frameSrcdoc().then((html) => {
    if (destroyed) return;
    frame.srcdoc = html;
  }, (err) => {
    if (!destroyed) rejectBackend(new Error(`frame document: ${err}`));
  });

  // Faults arrive on the WINDOW channel, which outlives the handshake —
  // the handshake listener below removes itself, and a diagnostic that
  // dies with it reports "no faults" for a frame that is on fire.
  const onFault = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    if ((e.data as { t?: string })?.t !== "fault") return;
    const faults = ((globalThis as Record<string, unknown>).__frameFaults ??= []) as string[];
    faults.push(String((e.data as { msg?: string }).msg));
  };
  globalThis.addEventListener("message", onFault);

  const onWindowMessage = (e: MessageEvent) => {
    // `e.source` is the only identification available: an opaque-origin
    // frame has origin "null", which is shared by every sandboxed frame
    // on the page, so origin checks cannot distinguish OUR frame. Ignore
    // everything that did not come from this frame's window.
    if (destroyed || e.source !== frame.contentWindow) return;
    const data = e.data as { t?: unknown } | null;
    if (!data || typeof data !== "object" || data.t !== "frame-ready") return;
    globalThis.removeEventListener("message", onWindowMessage);
    handshake();
  };
  globalThis.addEventListener("message", onWindowMessage);

  function handshake(): void {
    const channel = new MessageChannel();
    port = channel.port1;

    port.onmessage = (m: MessageEvent<FrameMsg>) => {
      if (destroyed) return;
      if (m.data.t === "event") {
        dispatch(m.data.ev);
      } else if (m.data.t === "drained") {
        pendingDrains.get(m.data.id)?.();
        pendingDrains.delete(m.data.id);
      } else if (m.data.t === "height") {
        // The shell cannot measure a cross-origin document, so the frame
        // reports its own layout height and the shell decides what to do
        // with it. Clamped, and never used for anything but sizing.
        const px = Math.max(MIN_HEIGHT_PX, Math.ceil(Number(m.data.px) || 0));
        frame.style.height = `${px}px`;
      }
    };
    port.start();

    // Target origin "*": an opaque-origin frame CANNOT be addressed by
    // origin (there is no origin string that matches "null" as a
    // targetOrigin), so "*" is the only option. It is safe here because
    // the payload is a bare MessagePort with no secret in it, and it is
    // delivered to one specific contentWindow rather than broadcast.
    frame.contentWindow!.postMessage({ t: "port" }, "*", [channel.port2]);
    // Coarse mode only — never the anchor colour (see frame.ts).
    channel.port1.postMessage({ t: "theme", mode: theme } satisfies ShellMsg);

    const queued = createQueuedBackend(
      (ops) => port?.postMessage({ t: "ops", ops } satisfies ShellMsg),
    );
    resolveBackend({
      ...queued,
      // The drain round-trip, exactly as backend-channel.ts does it: a
      // marker chases the last op batch through the same ordered port,
      // so resolution means "applied", not merely "posted".
      drain: () =>
        new Promise<void>((resolve) => {
          if (destroyed || !port) return resolve();
          const id = drainId++;
          pendingDrains.set(id, resolve);
          port.postMessage({ t: "drain", id } satisfies ShellMsg);
        }),
    });
  }

  return {
    backend,
    frame,
    destroy() {
      // Idempotent, and idempotent in the SAME completion: a second
      // caller must be able to await the teardown the first one started
      // rather than get a promise that resolves on its own schedule.
      if (teardown) return teardown;
      destroyed = true;
      globalThis.removeEventListener("message", onWindowMessage);
      globalThis.removeEventListener("message", onFault);
      // Resolve every waiter rather than leaving them hanging: a drain
      // on a dead surface is vacuously complete.
      for (const done of pendingDrains.values()) done();
      pendingDrains.clear();
      if (port) {
        port.onmessage = null;
        port.close();
        port = null;
      } else {
        rejectBackend(new Error("frame backend destroyed before it was ready"));
      }
      frame.remove();
      // WHY THE TURN. Everything above is synchronous, but the frame's
      // window can already have posted toward us — `frame-ready` is
      // delivered as a task, and removing the element does not unqueue a
      // message that was posted before the removal. The listeners are
      // gone so those messages hit nothing, but a caller that stands up
      // the NEXT surface must not do so while they are still landing:
      // that is the window in which a stale delivery gets attributed to
      // the new frame. So completion is one macrotask out, which is
      // exactly long enough for the queue this frame could still be
      // holding to drain.
      teardown = new Promise<void>((resolve) => setTimeout(resolve, 0));
      return teardown;
    },
  };
}
