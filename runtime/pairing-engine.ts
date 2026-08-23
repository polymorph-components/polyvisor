// Engine-backed PairingDriver adapter (Track A -> Track B integration
// step, per pairing-mock.ts's own header comment: "Swapping this module
// for a thin adapter over the real `driver` export is the whole
// integration step — nothing in ../visor/ui/pairing.ts is aware this is
// a mock.").
//
// Wraps one `Engine.driver` (./engine.ts, itself a typed view over
// the composite's `polyvisor:engine/driver@0.1.0` export) as the
// `PairingDriver` shape the visor pairing UI consumes. The TYPE stays
// imported from visor/ui/pairing-driver.ts (the visor owns the
// contract); only the implementation lives here.
//
// SHAPE MISMATCH THIS ADAPTER BRIDGES: the engine.ts `Driver` methods
// follow the WIT `result<T, string>` convention documented at
// engine.ts:38 — resolve T, or REJECT with a `ComponentException`
// carrying the WIT err payload (embedder/errors.ts; recognized by the
// `isComponentException` brand predicate, never `instanceof`, per that
// module's own header). `PairingDriver` (visor/ui/pairing-driver.ts)
// instead returns `{ok:true,value:T} | {ok:false,error:string}` on every
// call, never rejecting. Every method below is therefore a
// try/reject-to-err wrapper, plus field-shape conversions (bigint u64 <->
// number ms/timestamps, Uint8Array id <-> string, `{tag,val}` variant <->
// the mock's `{tag, <fieldname>}` variant shapes) so the visor sees
// EXACTLY the mock's wire shape from either backend.
//
// MOCK-VS-ENGINE SEMANTIC DIFFERENCES (visor must not be able to tell):
//   - Hash: the mock computes SAS over SHA-256 (Web Crypto); the engine
//     composite computes it over BLAKE3 per PAIRING.md §2. Both derive
//     the same 6-digit decimal SAS shape (first 4 bytes of a 32-byte
//     digest, u32 BE, mod 10^6, zero-padded) from a hash, so the type at
//     this interface (`sas: string`, 6 digits) is identical; the visor
//     never sees which hash produced it. Documented deviation, per the
//     dispatch and pairing-mock.ts's own header.
//   - Timing: the mock's offer expiry and poll cadence are in-process
//     (no network latency); the real engine's pairing goes over an iroh
//     connection, so `pairJoinStatus`/`pairAddStatus` polling will
//     observe real round-trip latency between state transitions. The
//     interface contract (poll-and-observe) is identical either way —
//     only wall-clock timing differs, which the mock's own header
//     already flags as out of scope for parity ("develop the visor's
//     reconcile/announce paths" is the mock's stated goal, not
//     timing-faithful simulation).
//   - IDs: the mock's `userGroupId`/`partitionId`/`agentId` are opaque
//     random tokens (strings); the engine's are real `list<u8>` ids
//     (Uint8Array), hex-encoded here (via engine.ts's `hex`/`unhex`) so
//     the PairingDriver's string-typed fields keep the exact same
//     surface as the mock — see the per-field conversions below.
//   - Marks conflict repair (pairing-mock.ts §4 logic, ~176-258): this
//     mock-side JS logic has NO counterpart in this adapter; the real
//     engine repairs marks conflicts itself (usdoc.rs) and reports the
//     outcome only via `us-mark-changed`/no event per its own contract.
//     This adapter does not reimplement or duplicate that logic — it is
//     purely a passthrough to the engine's `us-mark-put`, which is
//     expected to have already applied any repair before returning.

import type { Driver, PairAddState, PairJoinState, UsEvent, UsMark, UsProfile } from "./engine.ts";
import { hex, unhex } from "./engine.ts";
import { isComponentException } from "@polyengine/runtime/embedder";
import type {
  PairAddState as MockPairAddState,
  PairEnrollment as MockPairEnrollment,
  PairingDriver,
  PairJoinState as MockPairJoinState,
  PairOffer as MockPairOffer,
  UsDevice as MockUsDevice,
  UsEvent as MockUsEvent,
  UsMark as MockUsMark,
  UsProfile as MockUsProfile,
} from "../visor/ui/pairing-driver.ts";

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function errFrom(e: unknown): { ok: false; error: string } {
  if (isComponentException(e)) {
    const p = (e as { payload?: unknown }).payload;
    return { ok: false, error: typeof p === "string" ? p : String(p) };
  }
  // An unbranded throw here is a host/adapter bug per the embedder's own
  // error model (errors.ts: brand recognition, "never `instanceof`") —
  // but PairingDriver has no trap channel, so surface it as an error
  // string rather than let it escape as an unhandled rejection.
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** try/reject-to-err wrapper shared by every method below. */
async function guard<T>(f: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: string }
> {
  try {
    return ok(await f());
  } catch (e) {
    return errFrom(e);
  }
}

function toMockProfile(p: UsProfile): MockUsProfile {
  return { displayName: p.displayName, hue: p.hue, icon: p.icon };
}
function fromMockProfile(p: MockUsProfile): UsProfile {
  return { displayName: p.displayName, hue: p.hue, icon: p.icon };
}

function toMockMark(m: UsMark): MockUsMark {
  return {
    provenance: m.provenance,
    petname: m.petname,
    // us-mark.hue -> us-mark.icon (#22 discussion): the wire type is a
    // string now, and the engine treats it as opaque.
    icon: m.icon,
    nickname: m.nickname,
    createdAt: Number(m.createdAt),
    needsReconfirm: m.needsReconfirm,
  };
}
function fromMockMark(m: MockUsMark): UsMark {
  return {
    provenance: m.provenance,
    petname: m.petname,
    icon: m.icon,
    nickname: m.nickname,
    createdAt: BigInt(m.createdAt),
    needsReconfirm: m.needsReconfirm,
  };
}

function toMockDevice(d: {
  agentId: Uint8Array;
  name: string;
  enrolledAt: bigint;
  revoked: boolean;
  endpoint: Uint8Array;
  enrolledBy: Uint8Array;
}): MockUsDevice {
  return {
    agentId: hex(d.agentId),
    name: d.name,
    enrolledAt: Number(d.enrolledAt),
    revoked: d.revoked,
    // EMPTY STAYS EMPTY across the hex boundary: `hex(new Uint8Array())`
    // is "", which is exactly the visor-side spelling of "not recorded"
    // that engine.wit's `us-device` gives these two fields. No
    // `undefined` is invented here — an absent endpoint and an unknown
    // one are the same fact and deserve one representation.
    endpoint: hex(d.endpoint),
    enrolledBy: hex(d.enrolledBy),
  };
}

// engine.ts's PairJoinState/PairAddState/UsEvent types now state the
// true wire convention (`{kind, value}`, per embedder/values.ts —
// engine.ts:132-140) directly, so these functions switch on `.kind`/
// `.value` with no cast. The `{tag, ...}` shapes below are the VISOR's
// own PairingDriver contract (visor/ui/pairing-driver.ts) being
// converted TO — unrelated to engine.ts's wire shape and not a mismatch.

function toMockJoinState(s: PairJoinState): MockPairJoinState {
  switch (s.kind) {
    case "waiting":
    case "confirmed-waiting":
    case "expired":
      return { tag: s.kind };
    case "claimed":
      return { tag: "claimed", sas: s.value };
    case "failed":
      return { tag: "failed", message: s.value };
    case "enrolled": {
      // TWO FIELDS, DELIBERATELY. The engine's `pair-enrollment` also
      // carries the adder's observed agent and endpoint ids, and they
      // are dropped here: the visor's contract has no place for them and
      // must not grow one, because dialling a peer is the EMBEDDER's
      // act, not the trusted surface's. An embedder that needs them
      // reads `driver.pairJoinStatus()` on the raw engine driver
      // (runtime/engine.ts's `PairEnrollment`) — demo/host/solo.ts does
      // exactly that.
      const enrollment: MockPairEnrollment = {
        userGroupId: hex(s.value.userGroupId),
        partitionId: hex(s.value.partitionId),
      };
      return { tag: "enrolled", enrollment };
    }
    default:
      throw new Error(`pair-join-state: unknown variant case '${(s as { kind: string }).kind}'`);
  }
}

function toMockAddState(s: PairAddState): MockPairAddState {
  switch (s.kind) {
    case "connecting":
    case "waiting-peer":
    case "enrolled":
      return { tag: s.kind };
    case "sas-ready":
      return { tag: "sas-ready", sas: s.value };
    case "failed":
      return { tag: "failed", message: s.value };
    default:
      throw new Error(`pair-add-state: unknown variant case '${(s as { kind: string }).kind}'`);
  }
}

function toMockEvent(e: UsEvent): MockUsEvent {
  switch (e.kind) {
    case "profile-changed":
      return { tag: "profile-changed" };
    case "mark-added":
      return { tag: "mark-added", provenance: e.value };
    case "mark-changed":
      return { tag: "mark-changed", provenance: e.value };
    case "mark-conflict-repaired": {
      const val = e.value;
      return {
        tag: "mark-conflict-repaired",
        provenance: val[0],
        // CONTRACT: engine.wit ~254 types the field name as a bare
        // `string` (tuple<string,string>), not an enum restricted to
        // "petname"|"icon" — the contract's stricter TS union
        // (visor/ui/pairing-driver.ts's `UsEvent`) is a visor-side
        // refinement of the same wire shape. Cast here rather than
        // widen the contract type (out of territory) or the
        // WIT (governing doc, not editable); the engine is expected to
        // only ever send these two literal strings (usdoc.rs's own
        // repair logic), so this is a narrowing assertion, not a lossy
        // conversion.
        field: val[1] as "petname" | "icon",
      };
    }
    case "device-added":
      return { tag: "device-added", name: e.value };
    case "device-revoked":
      return { tag: "device-revoked", name: e.value };
    case "storage-changed":
      return { tag: "storage-changed", provider: e.value };
    default:
      throw new Error(`us-event: unknown variant case '${(e as { kind: string }).kind}'`);
  }
}

/** Adapt one engine instance's `driver` export to `PairingDriver`. */
export function createEnginePairingDriver(driver: Driver): PairingDriver {
  return {
    pairJoinStart() {
      return guard(async () => {
        const offer: MockPairOffer = await driver.pairJoinStart().then((o) => ({
          code: o.code,
          expiresMs: Number(o.expiresMs),
        }));
        return offer;
      });
    },

    pairJoinStatus() {
      return guard(() => driver.pairJoinStatus().then(toMockJoinState));
    },

    pairJoinConfirm() {
      return guard(() => driver.pairJoinConfirm().then(() => null));
    },

    pairAddStart(code: string) {
      return guard(() => driver.pairAddStart(code).then(() => null));
    },

    pairAddStatus() {
      return guard(() => driver.pairAddStatus().then(toMockAddState));
    },

    pairAddConfirm(deviceName: string) {
      return guard(() => driver.pairAddConfirm(deviceName).then(() => null));
    },

    pairAbort() {
      return guard(() => driver.pairAbort().then(() => null));
    },

    userCreate(profile) {
      return guard(() => driver.userCreate(fromMockProfile(profile)).then(hex));
    },

    usProfileGet() {
      return guard(() => driver.usProfileGet().then(toMockProfile));
    },

    usProfileSet(profile) {
      return guard(() => driver.usProfileSet(fromMockProfile(profile)).then(() => null));
    },

    usMarksList() {
      return guard(() => driver.usMarksList().then((ms) => ms.map(toMockMark)));
    },

    usMarkPut(mark) {
      return guard(() => driver.usMarkPut(fromMockMark(mark)).then(() => null));
    },

    usMarkForget(provenance) {
      return guard(() => driver.usMarkForget(provenance).then(() => null));
    },

    usMarkConfirm(provenance) {
      return guard(() => driver.usMarkConfirm(provenance).then(() => null));
    },

    usContactsList() {
      return guard(() =>
        driver.usContactsList().then((cs) => cs.map(([card, petname]) => [hex(card), petname] as [string, string]))
      );
    },

    usContactPut(card, petname) {
      return guard(() => driver.usContactPut(unhex(card), petname).then(() => null));
    },

    usDevicesList() {
      return guard(() => driver.usDevicesList().then((ds) => ds.map(toMockDevice)));
    },

    usDeviceRevoke(agentId) {
      return guard(() => driver.usDeviceRevoke(unhex(agentId)).then(() => null));
    },

    usEvents() {
      return guard(() => driver.usEvents().then((es) => es.map(toMockEvent)));
    },
  };
}
