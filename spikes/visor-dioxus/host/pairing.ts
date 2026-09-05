/// <reference lib="dom" />
// `polymorph:visor-spike/pairing-driver` — A MOCK HOST IMPLEMENTATION, for
// device enrollment: the ceremony where a relay able to see and modify
// everything on the wire still cannot get a device enrolled, because two
// humans compare a short authentication string out of band
// (wit/world.wit's `pairing-driver` doc, PAIRING.md §2).
//
// Modelled on demo/host/pairing-mock.ts, collapsed to the shape this spike's
// e2e actually needs: ONE component instance drives both the join session
// and the add session in the same page, so this is not a two-device network
// — it is a STEERABLE DOUBLE. Every `*-status` poll answers whatever the
// test last asked for (`PairingTestControls.forceJoinStatus`/
// `forceAddStatus`), so the e2e can walk each state machine through every
// arm (including `expired` and `failed`) without waiting on real transport
// timing. `pair-join-start`/`pair-add-start` still do real, if trivial,
// work — synthesizing a 79-character code, recording that a session
// started — so the surrounding ceremony (the code's length and grouping,
// the QR, the confirm calls actually reaching the driver) is exercised for
// real; only the STATUS the poll sees is test-controlled.
//
// Comparison digits are OBVIOUSLY SYNTHETIC (`DEFAULT_SAS`, "000000") and
// labelled as such — nothing here manufactures a value that looks like a
// real short authentication string.
//
// `result<T, string>` / `result<T, picker-refusal>` AS A HOST IMPORT lowers
// as: return the value for `ok`, throw a branded `ComponentException` for
// `err` (contract:"Value mapping", "Host import with `result<T, E>`" —
// cited at host/mount.ts:206). A payload-carrying variant lifts as
// `{ kind, value }` (contract:"Value mapping"'s variant row).

import { ComponentException } from "@deltic/protocol";

// -- WIT record/variant mirrors, camelCased ----------------------------------

export interface PairOffer {
  code: string;
  /** WIT `u64` lifts as `bigint` (contract:"Value mapping"). */
  expiresMs: bigint;
}
export interface PairEnrollment {
  userGroupId: string;
  partitionId: string;
}
export type PairJoinState =
  | { kind: "waiting" }
  | { kind: "claimed"; value: string }
  | { kind: "confirmed-waiting" }
  | { kind: "enrolled"; value: PairEnrollment }
  | { kind: "expired" }
  | { kind: "failed"; value: string };
export type PairAddState =
  | { kind: "connecting" }
  | { kind: "sas-ready"; value: string }
  | { kind: "waiting-peer" }
  | { kind: "enrolled" }
  | { kind: "failed"; value: string };

export interface UsProfile {
  displayName: string;
  hue: number;
  icon?: Uint8Array;
}
export interface UsMark {
  provenance: string;
  petname: string;
  icon: string;
  nickname?: string;
  createdAt: bigint;
  needsReconfirm: boolean;
}
export interface UsDevice {
  agentId: string;
  name: string;
  enrolledAt: bigint;
  revoked: boolean;
  endpoint: string;
  enrolledBy: string;
}
export type UsEvent =
  | { kind: "profile-changed" }
  | { kind: "mark-added"; value: string }
  | { kind: "mark-changed"; value: string }
  | { kind: "mark-conflict-repaired"; value: [string, string] }
  | { kind: "device-added"; value: string }
  | { kind: "device-revoked"; value: string }
  | { kind: "storage-changed"; value: string };

// -- an obviously-synthetic comparison string --------------------------------

/** SIX SYNTHETIC DIGITS, never a real short authentication string: the
 * mock's `sas-ready`/`claimed` payloads default to this unless a test asks
 * for a different one. Labelled here so nothing downstream mistakes it for
 * cryptographic output. */
export const DEFAULT_SAS = "000000";

const BASE32_VISUAL = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function syntheticCode(): string {
  // Deterministic, not random: a test double gains nothing from entropy it
  // never checks, and a fixed pattern is easier to eyeball in a failure.
  // 79 chars — PAIRING.md §1's real length — so the code's grouping and
  // QR-encoding gates run against production dimensions.
  let out = "";
  for (let i = 0; out.length < 79; i++) out += BASE32_VISUAL[i % BASE32_VISUAL.length];
  return out.slice(0, 79);
}

// -- test controls ------------------------------------------------------------

/** The one door the e2e drives this mock through: which state the NEXT
 * `pair-join-status` / `pair-add-status` poll answers. `undefined` means
 * "advance the obvious way" (waiting -> claimed -> ... on a fixed script),
 * which is enough for the ceremony to run to completion with no test
 * intervention at all; a test that needs `expired` or `failed` sets the
 * forced value once and it is consumed on the next poll. */
export interface PairingTestControls {
  forceJoinStatus?: PairJoinState;
  forceAddStatus?: PairAddState;
  /** Reject `pair-join-start` / `pair-add-start` with this string next call. */
  joinStartError?: string;
  addStartError?: string;
  /** Steer the NEXT `usDevicesList()` reply — the e2e's door onto the add
   * flow's `AddPhase::Enrolled` device list (`add.rs`'s `EnrolledDevices`).
   * `undefined` means "answer from the mock's own enrolled-device map",
   * which is enough to cover the ceremony's own admitted device with no
   * test steering at all; set this when a test needs a SPECIFIC roster —
   * an unnamed row, a revoked one, more than one device — gated in one
   * call rather than driven through several real `pairAddConfirm`s.
   * Consumed on the next call, same discipline as `forceJoinStatus`. */
  forceDevicesList?: UsDevice[];
  /** Reject the NEXT `usDevicesList()` call with this string — the e2e's
   * door onto add.rs's silent-on-failure rule (pairing.ts:715's
   * `if (!res.ok) return;`, kept rather than "fixed" into an error line:
   * "device added" has already been announced by the time this list is
   * fetched, so a listing failure must not read as the enrollment having
   * failed). Consumed on the next call. */
  devicesListError?: string;
  /** us-events queued for the next `usEvents()` drain — the e2e's door onto
   * gate 4c (the announced-never-silent drain). */
  pendingUsEvents: UsEvent[];
}

export interface PairingCallLog {
  calls: Array<{ fn: string; at: number; arg?: unknown }>;
}

/** The default script each session's status advances through when the test
 * has not forced a value — enough for the ceremony to complete on its own
 * so most gates need only wait, not steer. */
const JOIN_SCRIPT: PairJoinState[] = [
  { kind: "waiting" },
  { kind: "claimed", value: DEFAULT_SAS },
];
const ADD_SCRIPT: PairAddState[] = [
  { kind: "connecting" },
  { kind: "sas-ready", value: DEFAULT_SAS },
];

export function createPairingDriverImports(
  controls: PairingTestControls,
  log: PairingCallLog,
) {
  const note = (fn: string) => (arg?: unknown) => {
    log.calls.push({ fn, at: Date.now(), arg });
  };

  // -- join-side session state (this instance is the joining device) --------
  let joinStarted = false;
  let joinScriptIdx = 0;
  let joinConfirmed = false;
  let joinEnrolled = false;

  // -- add-side session state (this instance is the admitting device) -------
  let addStarted = false;
  let addScriptIdx = 0;
  let addConfirmed = false;
  let addEnrolled = false;

  // -- the account "doc": one shared object per instance, matching
  // demo/host/pairing-mock.ts's shape but with no cross-instance fan-out —
  // there is only one instance in this page.
  let profile: UsProfile | undefined;
  const marks = new Map<string, UsMark>();
  const devices = new Map<string, UsDevice>();

  return {
    async pairJoinStart(): Promise<PairOffer> {
      note("pair-join-start")();
      if (controls.joinStartError) {
        const e = controls.joinStartError;
        controls.joinStartError = undefined;
        throw new ComponentException(e);
      }
      joinStarted = true;
      joinScriptIdx = 0;
      joinConfirmed = false;
      joinEnrolled = false;
      return { code: syntheticCode(), expiresMs: 120_000n };
    },

    async pairJoinStatus(): Promise<PairJoinState> {
      note("pair-join-status")();
      if (!joinStarted) throw new ComponentException("no offer started");
      if (controls.forceJoinStatus) {
        const st = controls.forceJoinStatus;
        controls.forceJoinStatus = undefined;
        if (st.kind === "enrolled") joinEnrolled = true;
        return st;
      }
      if (joinEnrolled) {
        return { kind: "enrolled", value: { userGroupId: "mock-group", partitionId: "mock-partition" } };
      }
      if (joinConfirmed) {
        // ENROLL only after this device's own confirm — the join side
        // reports `confirmed-waiting` until the add side's own confirm
        // lands too (driven here by a test forcing `enrolled`, mirroring
        // the real driver's "both confirms" gate).
        return { kind: "confirmed-waiting" };
      }
      const st = JOIN_SCRIPT[Math.min(joinScriptIdx, JOIN_SCRIPT.length - 1)];
      if (joinScriptIdx < JOIN_SCRIPT.length - 1) joinScriptIdx++;
      return st;
    },

    async pairJoinConfirm(): Promise<void> {
      note("pair-join-confirm")();
      if (!joinStarted) throw new ComponentException("no offer started");
      joinConfirmed = true;
    },

    async pairAddStart(code: string): Promise<void> {
      note("pair-add-start")(code);
      if (controls.addStartError) {
        const e = controls.addStartError;
        controls.addStartError = undefined;
        throw new ComponentException(e);
      }
      addStarted = true;
      addScriptIdx = 0;
      addConfirmed = false;
      addEnrolled = false;
    },

    async pairAddStatus(): Promise<PairAddState> {
      note("pair-add-status")();
      if (!addStarted) throw new ComponentException("no pairing started");
      if (controls.forceAddStatus) {
        const st = controls.forceAddStatus;
        controls.forceAddStatus = undefined;
        if (st.kind === "enrolled") addEnrolled = true;
        return st;
      }
      if (addEnrolled) return { kind: "enrolled" };
      if (addConfirmed) return { kind: "waiting-peer" };
      const st = ADD_SCRIPT[Math.min(addScriptIdx, ADD_SCRIPT.length - 1)];
      if (addScriptIdx < ADD_SCRIPT.length - 1) addScriptIdx++;
      return st;
    },

    async pairAddConfirm(deviceName: string): Promise<void> {
      note("pair-add-confirm")(deviceName);
      if (!addStarted) throw new ComponentException("no pairing started");
      addConfirmed = true;
      const agentId = `mock-device-${devices.size + 1}`;
      devices.set(agentId, {
        agentId,
        name: deviceName,
        enrolledAt: BigInt(Date.now()),
        revoked: false,
        endpoint: "",
        enrolledBy: "",
      });
    },

    async pairAbort(): Promise<void> {
      note("pair-abort")();
      joinStarted = addStarted = false;
      joinConfirmed = addConfirmed = false;
      joinEnrolled = addEnrolled = false;
    },


    async usProfileGet(): Promise<UsProfile> {
      note("us-profile-get")();
      if (!profile) throw new ComponentException("no user group");
      return profile;
    },

    async usMarksList(): Promise<UsMark[]> {
      note("us-marks-list")();
      return [...marks.values()];
    },

    async usDevicesList(): Promise<UsDevice[]> {
      note("us-devices-list")();
      if (controls.devicesListError) {
        const e = controls.devicesListError;
        controls.devicesListError = undefined;
        throw new ComponentException(e);
      }
      if (controls.forceDevicesList) {
        const list = controls.forceDevicesList;
        controls.forceDevicesList = undefined;
        return list;
      }
      return [...devices.values()];
    },

    /** THE DRAIN, for gate 4c: the announced-never-silent rule. Whatever
     * the test queued in `controls.pendingUsEvents` comes back once and is
     * gone — draining is consuming, exactly as `us-events`'s doc requires. */
    async usEvents(): Promise<UsEvent[]> {
      note("us-events")();
      const drained = controls.pendingUsEvents;
      controls.pendingUsEvents = [];
      return drained;
    },
  };
}
