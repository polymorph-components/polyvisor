// The visor's device-pairing + user-system UI (PAIRING.md §5, #22
// rulings). This is THE module that may render a pairing code or a SAS
// — demo/scripts/check-invariants.sh (f) greps for that
// property, so a refactor that moves this rendering elsewhere must move
// the grep marker too (documented at the marker, below).
//
// It lives in visor/ui/ because that is what the invariant CLAIMS: "a
// pairing code or SAS renders only in visor pixels" should be a fact
// about the framework's own trusted-UI layer, not a fact about which
// file of a demo happens to hold the code today. Nothing here crosses
// the frame seam and no component frame can reach it, by construction
// (same discipline as the identity/petname code next door in visor.ts —
// see check-invariants.sh (a) and (e), which this file's check (f)
// extends).
//
// WHAT IS NOT HERE: any backend. The UI is written against
// `./pairing-driver.ts`'s `PairingDriver` and nothing wider; the demo
// supplies either a mock (demo/host/pairing-mock.ts) or an
// engine adapter (runtime/pairing-engine.ts). Nor does it own
// any pane's own chrome: a consumer passes in the container, the
// announcement sink, and the storage keys, exactly as the rest of
// visor/ui/ takes its consumer's keys.
//
// #22 rulings this file must keep, restated so a future edit here has
// them to hand:
//   - announced-never-silent: a recognition/identity change caused by
//     something OTHER than the user's own action in THIS pane (a
//     remote write) is always announced, never quietly applied.
//   - three names, whose voice: the device name in the ADD ceremony is
//     the visor's voice because the user typed it — never prefilled from
//     a string the joiner or the peer sent.
//   - ceremony weight classes: the ADD ceremony is heavy (consequential
//     grant: the new device becomes admin of everything) and pays the
//     drawer host's arming delay (`ARM_MS`, imported from visor.ts —
//     ONE arming duration in the framework, not a second one users
//     would have to learn). The JOIN ceremony's local confirm is light
//     (nothing secret is typed; the worst mis-tap outcome is a
//     cancelled join) and must stay light — no arming tax on it.
//   - status/rule-line priority over ambient telemetry: announcements
//     are STICKY for a window (see `AnnounceSink`), so a consequential
//     one-shot is not erased by the next ambient tick.

import { QrCode } from "./vendor/qrcodegen.ts";
import { ARM_MS, VISOR_HUES } from "./visor.ts";
import type { Visor } from "./visor.ts";
import type { PairingDriver, UsEvent, UsMark, UsProfile } from "./pairing-driver.ts";

// --- the palette: index -> OKLCH angle (PAIRING.md §4) ---------------------
//
// `us-profile.hue` is a PALETTE INDEX (u16, 0-9), not
// raw angles — the engine only ever compares/stores indices, and the
// angle is purely a visor rendering choice. The table is the visor's
// own `VISOR_HUES` (visor.ts:46): one palette in the framework, so a
// hue that arrives from the partition and a hue rolled locally cannot
// disagree about what index 3 looks like. (This file used to carry a
// duplicate array that merely had to AGREE with it; agreement by
// import is cheaper to keep true.)

/** Index -> displayable OKLCH angle. Out-of-range indices (a palette
 * bigger than this visor build knows about) fall back to the first
 * entry rather than producing an invalid colour. */
export function paletteAngle(index: number): number {
  return VISOR_HUES[index] ?? VISOR_HUES[0];
}

// --- THE GREP MARKER (invariant (f), scripts/check-invariants.sh) ---------
//
// Both a pairing CODE and a SAS are rendered ONLY through the two
// functions below. The invariant script asserts that the literal
// substrings "renderPairingCode(" and "renderSas(" appear ONLY in this
// file (never in the frame seam — visor/frame/frame.ts,
// frame-backend.ts, frame.html — nor in any guest-*/**, nor in any
// other visor/ui/*.ts or demo host file). That is a stronger, cheaper property than trying
// to grep the word "SAS" itself (which would also fire on comments
// elsewhere): it pins the RENDERING CALL SITE, and a component frame
// has no way to reach a host-side function call at all, so the
// existence of the call outside this file would mean the architecture
// itself had grown a new seam-crossing path — exactly the shape of bug
// invariant (a) already guards for the petname.
function renderPairingCode(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pm-code";
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += 4) groups.push(code.slice(i, i + 4));
  wrap.textContent = groups.join(" ");
  return wrap;
}

function renderSas(sas: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pm-sas";
  el.textContent = sas;
  return el;
}

// --- shared styling (injected once) ----------------------------------------

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .pm-pane { border: 1px solid #ccc; border-radius: 6px; padding: .8em;
      font: 13px/1.4 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .pm-code { font: 20px/1.4 ui-monospace, monospace; letter-spacing: .04em;
      word-break: break-all; margin: .5em 0; }
    .pm-sas { font: 28px/1.2 ui-monospace, monospace; letter-spacing: .1em;
      margin: .5em 0; }
    .pm-qr { image-rendering: pixelated; border: 1px solid #999; }
    .pm-status { min-height: 1.4em; font-weight: 600; }
    .pm-status.pm-consequential { color: #7a3b00; }
    .pm-waiting { padding: .4em 0; }
    .pm-consequence { background: #fff3cd; border: 1px solid #e0b23c;
      border-radius: 4px; padding: .6em; margin: .5em 0; }
    .pm-devices { list-style: none; padding: 0; margin: .3em 0; }
    .pm-devices li { padding: .2em 0; border-bottom: 1px solid #eee; }
    .pm-armed[disabled] { opacity: .5; cursor: not-allowed; }
    .pm-hue-swatch { display: inline-block; width: .9em; height: .9em;
      border-radius: 2px; vertical-align: -1px; margin-right: .3em;
      border: 1px solid rgba(0,0,0,.3); }
  `;
  document.head.appendChild(style);
}

// --- QR rendering (data-URL, per §5) ---------------------------------------

/** Render `text` as a QR data-URL. Vendored self-contained encoder (see
 * ./vendor/qrcodegen.ts) — no new dependency for one image. */
function qrDataUrl(text: string, scale = 4): string {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const size = qr.size;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return canvas.toDataURL("image/png");
}

// --- announcements: drained us-events, priority over ambient ticks --------

/** THE ANNOUNCEMENT SINK. Everything this module has to say goes
 * through one of these; nothing below writes to a status surface
 * directly. `consequential` marks the announcements #22 says an
 * ambient tick must not erase (a remotely-caused identity change, a
 * device added or revoked, a repaired naming conflict, a failure the
 * user must act on).
 *
 * A FUNCTION, not an object, on purpose: the two consumers are shaped
 * differently and both have to be trivial to satisfy. The standalone
 * pairing page owns a per-pane status line and passes `statusWriter(el,
 * key)`; a visor-integrated consumer owns no such element and passes
 * `visorAnnounceSink(visor)`, which speaks on the strip's rule line in
 * the visor's own voice. Neither shape has to know about the other, and
 * a test double is one arrow function.
 *
 * THE THREE-VOICES POLICY, same as `Visor.announce`'s (visor/ui/visor.ts,
 * visor/README.md): `line` is a FLAT STRING and therefore cannot carry
 * class marking, so an announcement speaks FRAMEWORK VOICE and may embed
 * USER-voice words inline (a petname, the user's word for a device). An
 * APP-INFLUENCED string must NEVER be passed to a sink: there is no way
 * to dress it as app voice here, so it would arrive in the visor's own
 * sentence wearing the visor's own authority. Describe such a fact in
 * the visor's vocabulary instead, and leave the component's own string
 * to a surface where `foreignToken` can plate it. In this module that
 * rule is concrete: a component is referred to by the user's word for
 * it, or described without naming (see `describeEvent`).
 *
 * WHERE THE BOUNDARY SITS. Sinks below are also handed DRIVER-supplied
 * strings — a `PairAddState`/`PairJoinState` failure message, a
 * `{ ok: false; error }` from a call. That is admissible because a
 * `PairingDriver` is CONSUMER HOST CODE (the demo's mock and its engine
 * adapter), on the visor's side of the app seam, not a sandboxed
 * component: it speaks with the same authority as the rest of the host.
 * The rule bites on strings that crossed the seam — a component's
 * nickname, a nominated glyph, a provenance key an app influenced. If a
 * driver ever became a relay for such text, it would have to clamp and
 * describe it before it reached a sink. */
export type AnnounceSink = (line: string, consequential?: boolean) => void;

/** How long a consequential announcement holds the surface against
 * ambient traffic (the revocation-note-erased-by-a-stats-tick lesson,
 * #22). Same duration as host/demo.ts's beat statuses. */
const STICKY_MS = 12_000;
const stickyUntil = new Map<string, number>();

/** A sink over a caller-owned status ELEMENT (the standalone pairing
 * page's per-pane lines). `key` names the sticky clock — one per
 * surface, so two panes on one page do not suppress each other. */
export function statusWriter(el: HTMLElement, key: string): AnnounceSink {
  return (line, consequential = false) => {
    if (!consequential && (stickyUntil.get(key) ?? 0) > performance.now()) return;
    if (consequential) {
      stickyUntil.set(key, performance.now() + STICKY_MS);
      el.classList.add("pm-consequential");
    } else {
      el.classList.remove("pm-consequential");
    }
    el.textContent = line;
  };
}

/** A sink over THE STRIP: the visor-integrated consumer's half of the
 * same interface. `visor.announce` re-renders the live context when the
 * window elapses (never restores a saved string — see its doc comment),
 * which is precisely the behaviour a pairing announcement wants: by the
 * time a "device added" line expires, the thing the line was about may
 * have moved on.
 *
 * The stickiness is enforced HERE rather than delegated, because
 * `announce` has no notion of priority: an ambient line arriving inside
 * a consequential line's window is DROPPED, not queued (it is ambient —
 * the next tick will bring another). `key` defaults to the strip, which
 * is a singleton per page. */
export function visorAnnounceSink(visor: Visor, key = "visor-strip"): AnnounceSink {
  return (line, consequential = false) => {
    const now = performance.now();
    if (!consequential && (stickyUntil.get(key) ?? 0) > now) return;
    if (consequential) stickyUntil.set(key, now + STICKY_MS);
    visor.announce(line, consequential ? STICKY_MS : undefined);
  };
}

/** One event, as a sentence for an announcement sink.
 *
 * HOW A COMPONENT IS REFERRED TO HERE (the three-voices announcement
 * policy — see `AnnounceSink` above and visor/README.md): by THE USER'S
 * WORD for it, the petname, which is user voice and therefore admissible
 * inline in a framework-voice sentence; or, when there is no petname to
 * use, DESCRIBED WITHOUT NAMING. The PROVENANCE KEY never rides an
 * announcement. It used to: the key was interpolated straight into these
 * lines, which put a string the visor classifies as APP VOICE everywhere
 * else (visor/ui/sheets.ts renders it through `foreignToken`, quoted,
 * monospaced and plated) onto the anchor's own line, undressed and
 * indistinguishable from the visor's own words — and a mark event can
 * arrive from another device running another visor build, so that key is
 * exactly the attacker-influenceable input `isAppMarkIcon`'s comment
 * enumerates. An announcement is a flat string with no way to dress it,
 * so the fix is to not say it.
 *
 * `petnameOf` resolves a provenance key to the user's word for that
 * record, or undefined when the account has none (a record the list did
 * not return, or an empty petname). The fallback is expected to be RARE:
 * a petname-conflict repair flags the loser but keeps its petname, and
 * an icon-conflict repair clears the loser's ICON while keeping its
 * petname, so a lookup succeeds in both repair cases — but it must
 * exist, because the visor never assumes the partition's shape.
 *
 * Petnames are CLAMPED at 40 (the naming sheet's own cap) on the way
 * in: a record hand-edited in devtools, or written by another build,
 * must not be able to stretch the anchor line. */
function describeEvent(ev: UsEvent, petnameOf: (provenance: string) => string | undefined): string {
  switch (ev.tag) {
    case "profile-changed":
      return "profile updated on another device";
    case "mark-added": {
      const p = petnameOf(ev.provenance);
      return p ? `new trust record: ${p}` : "a new trust record arrived from another device";
    }
    case "mark-changed": {
      const p = petnameOf(ev.provenance);
      return p ? `trust record changed: ${p}` : "a trust record changed on another device";
    }
    case "mark-conflict-repaired": {
      // Both wordings say what the user has to DO. An icon repair
      // CLEARS the losing record's mark rather than reassigning it (the
      // vocabulary is the visor's, not the partition's — see the naming
      // sheet's picker), so the honest sentence is that the mark is gone
      // and the ceremony will offer a new one. The unnamed fallbacks are
      // the same sentences minus the identifier: still actionable,
      // because the ceremony is where the user acts either way.
      const p = petnameOf(ev.provenance);
      if (ev.field === "petname") {
        return p
          ? `NEW — two components were both named ${p}; re-confirm which is which`
          : "NEW — a naming conflict was found and repaired (re-confirm the name)";
      }
      return p
        ? `NEW — two components claimed the same mark; ${p} lost its mark and needs a new one`
        : "NEW — two components claimed the same mark; one lost its mark and needs a new one";
    }
    case "device-added":
      return `device added: ${ev.name || "(unnamed)"}`;
    case "device-revoked":
      return `device revoked: ${ev.name || "(unnamed)"}`;
  }
}

/** Drain `us-events` and announce every one — announced-never-silent,
 * per PAIRING.md §5. `mark-conflict-repaired` for a petname collision
 * is rendered as a sticky NEW-with-explanation (the contract's
 * "needs-reconfirm... renders as NEW-with-explanation at next mount");
 * `device-added`/`device-revoked`/`profile-changed` are also
 * consequential (sticky) — an ambient tick must not erase them. */
export async function drainAnnouncements(
  driver: PairingDriver,
  status: AnnounceSink,
): Promise<UsEvent[]> {
  const res = await driver.usEvents();
  if (!res.ok) return [];
  // A component is named in an announcement by THE USER'S WORD for it
  // (see `describeEvent`), so a batch carrying any mark event needs the
  // account's marks. ONE list call per batch, and only when the batch
  // actually mentions a record: the drain runs on a 3s poll and most
  // batches are empty, so the common path stays a single `usEvents`
  // round trip. A failed list is not a failed drain — the sentences
  // simply fall back to their unnamed forms, which is the same
  // degradation as a record the list does not return.
  const names = new Map<string, string>();
  if (res.value.some((ev) => "provenance" in ev)) {
    const marks = await driver.usMarksList();
    if (marks.ok) {
      for (const m of marks.value) {
        const petname = (m.petname ?? "").trim().slice(0, 40);
        if (petname !== "") names.set(m.provenance, petname);
      }
    }
  }
  const petnameOf = (provenance: string) => names.get(provenance);
  for (const ev of res.value) status(describeEvent(ev, petnameOf), true);
  return res.value;
}

// --- boot cache: hue / display-name / marks, demoted from source of truth --

/** The cache's three storage keys. The KEYS are the consumer's, as
 * everywhere else in visor/ui (see visor.ts's `hueKey`/`identityKey`):
 * two spikes sharing an origin must not share a boot cache, and the
 * framework has no business naming a consumer's storage. Build them
 * with `usCacheKeys(prefix)` unless you have a reason not to. */
export interface UsCacheKeys {
  hue: string;
  name: string;
  marks: string;
}

/** The conventional key set: `<prefix>-us-{hue,name,marks}-cache`
 * (`usCacheKeys("pm-demo")` reproduces the keys this cache shipped
 * with, so an existing page keeps its cache across this refactor). */
export function usCacheKeys(prefix: string): UsCacheKeys {
  return {
    hue: `${prefix}-us-hue-cache`,
    name: `${prefix}-us-name-cache`,
    marks: `${prefix}-us-marks-cache`,
  };
}

export interface BootCache {
  /** A palette INDEX (see `paletteAngle`/`PALETTE`, above), not an angle. */
  hue?: number;
  displayName?: string;
  marks?: UsMark[];
}

/** Render-from-cache, per §5: localStorage is a BOOT CACHE now, not the
 * source of truth (the us-* partition is). Reconciliation happens once
 * the driver is up (see `reconcileFromDriver`); this only lets the visor
 * paint something before that completes instead of a blank frame. */
export function loadBootCache(keys: UsCacheKeys): BootCache {
  try {
    const hueRaw = localStorage.getItem(keys.hue);
    const nameRaw = localStorage.getItem(keys.name);
    const marksRaw = localStorage.getItem(keys.marks);
    return {
      hue: hueRaw !== null ? Number(hueRaw) : undefined,
      displayName: nameRaw ?? undefined,
      marks: marksRaw ? JSON.parse(marksRaw) : undefined,
    };
  } catch {
    return {};
  }
}

function saveBootCache(keys: UsCacheKeys, cache: BootCache) {
  try {
    if (cache.hue !== undefined) localStorage.setItem(keys.hue, String(cache.hue));
    if (cache.displayName !== undefined) localStorage.setItem(keys.name, cache.displayName);
    if (cache.marks !== undefined) localStorage.setItem(keys.marks, JSON.stringify(cache.marks));
  } catch { /* nothing durable to write to */ }
}

/** After driver init: pull the real profile + marks, compare against
 * the boot cache, ANNOUNCE any diff (a silently-changed hue/name is
 * exactly the "anchor that quietly changes" lesson from #22 the
 * visor-hue code already carries), then refresh the cache to match. */
export async function reconcileFromDriver(
  driver: PairingDriver,
  keys: UsCacheKeys,
  status: AnnounceSink,
  onProfile?: (profile: UsProfile) => void,
): Promise<void> {
  const cache = loadBootCache(keys);
  const profileRes = await driver.usProfileGet();
  if (profileRes.ok) {
    const p = profileRes.value;
    if (cache.hue !== undefined && cache.hue !== p.hue) {
      status(`your colour changed to match your account (was device-local)`, true);
    }
    if (cache.displayName !== undefined && cache.displayName !== p.displayName) {
      status(`your name is now "${p.displayName}" (synced from your account)`, true);
    }
    saveBootCache(keys, { hue: p.hue, displayName: p.displayName });
    onProfile?.(p);
  }
  const marksRes = await driver.usMarksList();
  if (marksRes.ok) saveBootCache(keys, { marks: marksRes.value });
}

// --- join flow: new device (§5) --------------------------------------------

export interface JoinPaneHandle {
  /** Poll once; call on an interval from the host page. Returns true
   * once enrollment completes (caller may stop polling). That `true` is
   * the JOIN-COMPLETED EDGE, and it is the caller's cue for everything
   * enrollment does not do by itself: wiring the sync path, then
   * reading and adopting the account's profile once the doc lands. */
  tick(): Promise<boolean>;
}

/** Mounts the join flow into `container`: entry button → QR + grouped
 * code → SAS screen → light confirm → "joined."
 *
 * THE ADOPTION BEAT IS NOT THIS PANE'S. Enrollment only makes this
 * device a member of the account; the account's own document arrives
 * LATER, over the sync path the embedder wires on the strength of this
 * pane's `tick()` returning true. Reading `us-profile-get` here would
 * read the just-adopted, still-empty us doc — an empty name and hue 0,
 * adopted once and never re-read. So the pane reports the
 * JOIN-COMPLETED EDGE and nothing else; the caller reads the profile
 * once its own wiring has delivered the doc, paints it (it owns the
 * strip), and makes the §5 announcement then. Announced-never-silent
 * still holds — the sentence simply belongs to the moment the value
 * exists. `profile.hue` is a PALETTE INDEX (see `paletteAngle`) — the
 * caller converts it to an angle when painting. */
export function mountJoinPane(
  container: HTMLElement,
  driver: PairingDriver,
  status: AnnounceSink,
): JoinPaneHandle {
  ensureStyles();
  container.classList.add("pm-pane");
  container.replaceChildren();

  let phase: "entry" | "waiting" | "sas" | "confirmed" | "done" | "failed" = "entry";
  let code: string | undefined;
  let confirmed = false;

  const entryBtn = document.createElement("button");
  entryBtn.textContent = "join existing account";
  container.appendChild(entryBtn);

  const body = document.createElement("div");
  container.appendChild(body);

  entryBtn.onclick = async () => {
    const res = await driver.pairJoinStart();
    if (!res.ok) {
      status(`could not start join: ${res.error}`, true);
      return;
    }
    code = res.value.code;
    phase = "waiting";
    entryBtn.hidden = true;
    body.replaceChildren();
    const qrImg = document.createElement("img");
    qrImg.className = "pm-qr";
    qrImg.width = 132;
    qrImg.height = 132;
    qrImg.alt = "pairing QR code";
    qrImg.src = qrDataUrl(code);
    const label = document.createElement("div");
    label.textContent = "on your trusted device: add a device, then enter this code";
    body.append(qrImg, renderPairingCode(code), label);
    status("waiting for the other device…");
  };

  const renderSasScreen = (sas: string) => {
    phase = "sas";
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "confirm this code matches the other device:";
    const sasEl = renderSas(sas);
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "I initiated this — codes match";
    // LIGHT ceremony (PAIRING.md §5 + #22 weight classes): nothing
    // secret is typed here and the gesture starts from a button this
    // pane's own visor drew, so no arming delay — see the file-header
    // note on ceremony weight classes.
    confirmBtn.onclick = async () => {
      if (confirmed) return;
      confirmed = true;
      confirmBtn.disabled = true;
      await driver.pairJoinConfirm();
      phase = "confirmed";
      status("confirmed — waiting for the other device to confirm…");
    };
    body.append(label, sasEl, confirmBtn);
  };

  const handle: JoinPaneHandle = {
    async tick() {
      if (!code || phase === "done" || phase === "failed") return phase === "done";
      const res = await driver.pairJoinStatus();
      if (!res.ok) return false;
      const st = res.value;
      if (st.tag === "claimed" && phase === "waiting") {
        renderSasScreen(st.sas);
      } else if (st.tag === "confirmed-waiting" && phase !== "confirmed") {
        phase = "confirmed";
        status("confirmed — waiting for the other device to confirm…");
      } else if (st.tag === "enrolled") {
        phase = "done";
        // NO PROFILE READ HERE. The us doc this device just adopted is
        // empty until the embedder's sync path delivers it; the §5
        // adoption announcement is made by the caller, on this tick's
        // `true`, with a profile that by then exists (see the function's
        // doc comment).
        body.replaceChildren();
        const done = document.createElement("div");
        done.textContent = "joined.";
        body.appendChild(done);
      } else if (st.tag === "expired") {
        phase = "failed";
        status("this code expired — start again", true);
      } else if (st.tag === "failed") {
        phase = "failed";
        status(st.message, true);
      }
      return phase === "done";
    },
  };
  return handle;
}

// --- add flow: trusted device (§5) — the HEAVY ceremony ---------------------

export interface AddPaneHandle {
  /** Advance the flow by one driver read. Returns true once the session
   * has ENROLLED. See `settled` for the "stop polling" question, which
   * is not the same one: a failed session is finished too. */
  tick(): Promise<boolean>;
  /** True once this session can make no further progress — enrolled or
   * failed. A caller polling from a timer stops on this, NOT on the
   * visibility of whatever surface the pane was mounted in: after the
   * grant the session outlives its own UI (`AddPaneOptions.onGranted`). */
  settled(): boolean;
  /** True once the grant has been made and accepted — i.e. the user has
   * nothing further to do on this device. */
  granted(): boolean;
}

// The arming delay is the framework's ONE constant, imported from
// visor.ts (`ARM_MS`, visor.ts:254 — the drawer host's own arming and
// deferred-teardown delay). This file used to redeclare 700ms with a
// comment saying it must match; importing removes the "must".

/** How the add flow is ENTERED.
 *
 * `"button"` (default) draws the flow's own "add a device" button and
 * waits for it — what a bare pane wants, and what the standalone
 * pairing page uses.
 *
 * `"immediate"` starts at code entry, for a consumer whose OWN visor
 * pixels were the entry: the demo reaches this ceremony through the
 * settings sheet's "add a device…" action, and a sheet that opened
 * because the user pressed "add a device…" must not then ask them to
 * press "add a device" again. The distinction is only about which
 * visor-owned surface carried the affordance — there is no path here
 * that a component can start, either way. */
export type AddEntry = "button" | "immediate";

export interface AddPaneOptions {
  /** How the flow is entered (see `AddEntry`). Default `"button"`. */
  entry?: AddEntry;
  /** THE GRANT IS THE USER'S LAST REQUIRED ACT ON THIS DEVICE.
   *
   * Called once, immediately after `pair-add-confirm` is accepted. A
   * consumer that put this flow in a SURFACE THAT HOLDS THE SCREEN — the
   * demo mounts it in a drawer sheet, over a dimmed page — must take
   * that surface down here, because everything after the grant is the
   * OTHER device's turn: the adder is waiting on a confirm it cannot
   * make. Keeping the sheet up until the peer acts is wrong on real
   * hardware (you put the laptop down after granting, and it sits there
   * holding its own screen hostage) and, on a one-page demo where both
   * devices are on one screen, it is a pointer DEADLOCK: the dim over
   * the "other device" intercepts the very click the ceremony is
   * waiting for. (Found by driving the demo with real clicks; the
   * regression guard is the `device-pairing` e2e scenario's
   * pointer-path act.)
   *
   * WHAT MUST NOT STOP when the surface goes: the session. The caller
   * keeps calling `tick()` until the handle reports a terminal state,
   * and the announcements — completion AND failure — go to the
   * `AnnounceSink`, which is a surface that outlives any sheet. */
  onGranted?: () => void;
}

/** Mounts the add flow: entry ("add a device", or the consumer's own —
 * see `AddEntry`) → code entry → SAS screen → HEAVY ceremony
 * (statement of consequence + arming delay + never-prefilled
 * device-name field) → grant → devices list.
 *
 * After the grant the flow keeps running with no UI of its own to speak
 * through (see `AddPaneOptions.onGranted`): everything it has left to
 * say, it says through `status`. */
export function mountAddPane(
  container: HTMLElement,
  driver: PairingDriver,
  status: AnnounceSink,
  options: AddPaneOptions = {},
): AddPaneHandle {
  const entry = options.entry ?? "button";
  ensureStyles();
  container.classList.add("pm-pane");
  container.replaceChildren();

  let phase:
    | "entry"
    | "code-entry"
    | "connecting"
    | "sas"
    | "consequence"
    | "waiting-peer"
    | "done"
    | "failed" = "entry";
  let started = false;
  let armTimer = 0;
  let armed = false;
  let granted = false;

  const entryBtn = document.createElement("button");
  entryBtn.textContent = "add a device";
  container.appendChild(entryBtn);
  const body = document.createElement("div");
  container.appendChild(body);
  const devicesList = document.createElement("ul");
  devicesList.className = "pm-devices";
  container.appendChild(devicesList);

  const renderDevices = async () => {
    const res = await driver.usDevicesList();
    if (!res.ok) return;
    devicesList.replaceChildren();
    for (const d of res.value) {
      const li = document.createElement("li");
      li.textContent = `${d.name || "(unnamed)"}${d.revoked ? " — revoked" : ""}`;
      devicesList.appendChild(li);
    }
  };

  const beginCodeEntry = () => {
    phase = "code-entry";
    entryBtn.hidden = true;
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "paste or type the code shown on the new device:";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.style.width = "100%";
    input.placeholder = "code (79 characters)";
    const submitBtn = document.createElement("button");
    submitBtn.textContent = "connect";
    submitBtn.onclick = async () => {
      const raw = input.value.trim();
      if (!raw) return;
      submitBtn.disabled = true;
      phase = "connecting";
      const res = await driver.pairAddStart(raw);
      if (!res.ok) {
        status(`could not start pairing: ${res.error}`, true);
        phase = "failed";
        return;
      }
      started = true;
      status("connecting…");
    };
    body.append(label, input, submitBtn);
  };
  entryBtn.onclick = beginCodeEntry;
  // The consumer's own surface was the entry: go straight to the step
  // the user asked for. The button stays in the DOM but hidden, so the
  // two paths converge on exactly one implementation of the flow.
  if (entry === "immediate") beginCodeEntry();

  const renderSasScreen = (sas: string) => {
    phase = "sas";
    body.replaceChildren();
    const label = document.createElement("div");
    label.textContent = "confirm this code matches the new device:";
    const sasEl = renderSas(sas);
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "codes match — continue";
    nextBtn.onclick = () => renderConsequenceScreen();
    body.append(label, sasEl, nextBtn);
  };

  /** HEAVY ceremony (PAIRING.md §5 + #22): enrollment gives the new
   * device admin over EVERYTHING in the account, so this is THE
   * consequential grant in this flow and pays the full ceremony —
   * statement of consequence, arming delay, and a device-name field
   * the user must type (never prefilled: neither from anything the
   * joiner sent nor from any default visor would otherwise invent —
   * same NO-FABRICATION rule host/demo.ts's identity record follows). */
  const renderConsequenceScreen = () => {
    phase = "consequence";
    body.replaceChildren();
    const warn = document.createElement("div");
    warn.className = "pm-consequence";
    warn.textContent =
      "this device will get full access to everything in your account. " +
      "Only continue if you started this from a device you trust.";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "your word for this device:";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = ""; // NEVER prefilled — see comment above.
    nameLabel.appendChild(document.createElement("br"));
    nameLabel.appendChild(nameInput);
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "pm-armed";
    confirmBtn.textContent = `arming… (${ARM_MS}ms)`;
    confirmBtn.disabled = true;
    armed = false;
    // THE ARMING DELAY: the enforcement is the timer, not the visible
    // countdown text (which is just a courtesy here; the drawer's own
    // slide animation is the "visible form" in visor.ts and drops
    // under prefers-reduced-motion without dropping the timer).
    armTimer = setTimeout(() => {
      armed = true;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "grant full access";
    }, ARM_MS) as unknown as number;
    confirmBtn.onclick = async () => {
      // Defence-in-depth: even if something raced past the `disabled`
      // attribute (synthetic click, a11y tooling), the click handler
      // itself refuses to act before the timer fired.
      if (!armed) return;
      const deviceName = nameInput.value.trim();
      if (!deviceName) {
        status("give the new device a name first", true);
        return;
      }
      confirmBtn.disabled = true;
      const res = await driver.pairAddConfirm(deviceName);
      if (!res.ok) {
        status(`could not confirm: ${res.error}`, true);
        phase = "failed";
        return;
      }
      phase = "waiting-peer";
      granted = true;
      status("waiting for the new device to finish joining…");
      // The ceremony's own surface has nothing left to ASK for, so it
      // stops looking like a form that wants something: whatever is
      // still to come is reported on the announcement surface, and the
      // consumer is told it may take this surface down (see
      // `AddPaneOptions.onGranted`).
      body.replaceChildren();
      const waiting = document.createElement("div");
      waiting.className = "pm-waiting";
      waiting.textContent =
        "granted — finish on the new device. You can put this one down.";
      body.append(waiting);
      options.onGranted?.();
    };
    body.append(warn, nameLabel, confirmBtn);
  };

  const handle: AddPaneHandle = {
    settled: () => phase === "done" || phase === "failed",
    granted: () => granted,
    async tick() {
      if (!started || phase === "done" || phase === "failed") return phase === "done";
      const res = await driver.pairAddStatus();
      if (!res.ok) return false;
      const st = res.value;
      if (st.tag === "sas-ready" && phase === "connecting") {
        renderSasScreen(st.sas);
      } else if (st.tag === "enrolled") {
        phase = "done";
        status("device added", true);
        body.replaceChildren();
        const done = document.createElement("div");
        done.textContent = "done.";
        body.appendChild(done);
        await renderDevices();
      } else if (st.tag === "failed") {
        phase = "failed";
        status(st.message, true);
        clearTimeout(armTimer);
      }
      return phase === "done";
    },
  };
  return handle;
}
