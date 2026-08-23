// Standalone host page for the pairing visor (Track B gate surface):
// two mock "devices" sharing one in-page network (host/pairing-mock.ts),
// each driving the visor's pairing UI (../../visor/ui/pairing.ts).
// This is
// deliberately NOT wired into host/demo.ts's three-pane engine
// choreography — that demo requires the real engine composite (Track A,
// in progress in parallel) and sibling wasm/relay/bucket infra neither
// available nor relevant to developing/gating the visor's pairing UI.
// Swapping the mock for the real composite is an integration step that
// touches this file's driver construction only (see pairing-mock.ts's
// header comment) — visor/ui/pairing.ts does not know the difference.
//
// It is also this page that supplies the visor UI's two consumer-owned
// things: the ANNOUNCEMENT SINKS (per-pane status lines here, because
// this page has no strip; a visor-integrated consumer passes
// `visorAnnounceSink(visor)` instead) and the boot-cache STORAGE KEYS.
import { createMockDriver, MockPairingNetwork } from "./pairing-mock.ts";
import {
  loadBootCache,
  mountAddPane,
  mountJoinPane,
  paletteAngle,
  reconcileFromDriver,
  statusWriter,
  usCacheKeys,
} from "../../visor/ui/pairing.ts";

const net = new MockPairingNetwork();

const alice = createMockDriver("alice-laptop", net);
const tablet = createMockDriver("tablet", net);

// alice-laptop is the account's first device: it already has a
// user-system partition (user-create), matching the contract's "first
// device only" call. The tablet has none yet — that's what "join" is
// for. `hue` is a PALETTE INDEX (PAIRING.md §4), not an angle — index 0
// is the visor's palette entry 265°, chosen here only for a stable initial
// swatch on this demo page.
await alice.userCreate({ displayName: "Alice", hue: 0 });

const addStatusEl = document.getElementById("add-status")!;
const joinStatusEl = document.getElementById("join-status")!;
const addStatus = statusWriter(addStatusEl, "add");
const joinStatus = statusWriter(joinStatusEl, "join");

// Boot-cache reconcile for the pane that already has a partition
// (§5: render from cache, reconcile after driver init, announce diffs).
// The keys are this page's, per visor/ui convention — `pm-demo-us-*`.
const CACHE_KEYS = usCacheKeys("pm-demo");
await reconcileFromDriver(alice, CACHE_KEYS, addStatus);

const addPaneEl = document.getElementById("add-pane")!;
const joinPaneEl = document.getElementById("join-pane")!;

const addHandle = mountAddPane(addPaneEl, alice, addStatus);
const joinHandle = mountJoinPane(joinPaneEl, tablet, joinStatus);

/** THE ADOPTION BEAT (§5), on the JOIN-COMPLETED EDGE — `tick()`'s
 * `true`, which is where the pane hands the moment to its consumer.
 * The pane no longer reads the profile itself, and rightly: on the real
 * engine the account's document arrives over a sync path the embedder
 * wires on this very edge, so a read inside the pane would read an
 * empty doc. THIS page's driver is the in-page mock, where enrollment
 * hands the whole us doc over instantly, so reading it here is both
 * correct and immediate.
 *
 * Repaint SOMETHING visibly on the join pane so Playwright (and a
 * human) can see the synced colour land. The consuming page, not
 * visor/ui/pairing.ts, owns painting its own pane — pairing.ts only
 * reports the value (see its mountJoinPane doc comment), consistent
 * with the anchor-colour discipline in host/demo.ts (applyVisorHue is
 * host-page code, not shared code). `profile.hue` is a palette INDEX;
 * `paletteAngle` is the one place that turns it into a paintable angle
 * (PAIRING.md §4). */
async function adoptOnJoin() {
  const res = await tablet.usProfileGet();
  if (!res.ok) return;
  const profile = res.value;
  // Announced, never silent — the sentence the pane used to say, said
  // where the value now comes from.
  joinStatus(
    `this device now follows your profile: ${profile.displayName}, your colour`,
    true,
  );
  const angle = paletteAngle(profile.hue);
  joinPaneEl.style.setProperty("--pm-hue", String(angle));
  joinPaneEl.style.background = `oklch(92% .03 ${angle})`;
}

// Poll both panes on a shared tick. Background driver calls are
// serialized here (one at a time) — same lesson host/demo.ts records
// for the three-pane engine (overlapping interval-driven calls into the
// same instances is the documented lockup risk); the pairing mock has
// no such hazard (plain JS state, no wasm instance), but serializing
// costs nothing and keeps the pattern consistent if this ever grows
// more mock instances.
let stopped = { add: false, join: false };
const POLL_MS = 150;
async function tick() {
  if (!stopped.add) stopped.add = await addHandle.tick();
  if (!stopped.join) {
    // The EDGE, not the level: `stopped.join` latches, so this branch
    // runs exactly once — the tick that first reports done.
    stopped.join = await joinHandle.tick();
    if (stopped.join) await adoptOnJoin();
  }
}
const timer = setInterval(() => {
  tick().catch((e) => console.error(e));
}, POLL_MS);

// Exposed for Playwright: force an immediate drain instead of waiting
// on the interval, and read pane state without depending on timing.
(globalThis as unknown as { __pairingDemo: unknown }).__pairingDemo = {
  tick,
  stopTimer: () => clearInterval(timer),
};
