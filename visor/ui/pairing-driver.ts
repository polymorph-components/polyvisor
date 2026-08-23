// What the visor's pairing UI requires of a backend (PAIRING.md §3).
//
// This file is a CONTRACT, not an implementation: it holds the async,
// WIT-shaped surface `visor/ui/pairing.ts` is written against, plus the
// record/variant mirrors of the WIT types in PAIRING.md §3. It lives in
// the visor because the visor's UI is what NEEDS it — the requirement
// runs from the trusted surface downwards, not from whichever backend
// happens to be plugged in today.
//
// Implementations live outside the visor, deliberately:
//   - demo/host/pairing-mock.ts — a demo test double (in-page
//     "network", SHA-256 transcript hash) for developing and gating the
//     visor without the engine;
//   - runtime/pairing-engine.ts — embedding-runtime glue adapting a
//     real engine instance (runtime/engine.ts's typed `Driver`) to this
//     shape.
// Neither is visor code, and this file imports neither. Nothing here
// touches the DOM.
//
// Naming: the TS field names are the WIT names lowerCamelCased
// (`expires-ms` -> `expiresMs`), and variants are discriminated by a
// `tag` field carrying the WIT case name verbatim, so a reader can hold
// PAIRING.md §3 beside this file and check it line by line.

// --- WIT record/variant mirrors (PAIRING.md §3, verbatim shapes) -----------

export interface PairOffer {
  code: string;
  expiresMs: number;
}

export interface PairEnrollment {
  userGroupId: string;
  partitionId: string;
}

export type PairJoinState =
  | { tag: "waiting" }
  | { tag: "claimed"; sas: string }
  | { tag: "confirmed-waiting" }
  | { tag: "enrolled"; enrollment: PairEnrollment }
  | { tag: "expired" }
  | { tag: "failed"; message: string };

export type PairAddState =
  | { tag: "connecting" }
  | { tag: "sas-ready"; sas: string }
  | { tag: "waiting-peer" }
  | { tag: "enrolled" }
  | { tag: "failed"; message: string };

export interface UsProfile {
  displayName: string;
  hue: number;
  icon?: Uint8Array;
}

export interface UsMark {
  provenance: string;
  petname: string;
  /** THE PET ICON: one glyph from the visor's curated vocabulary
   * (visor.ts's `APP_MARK_ICONS`), or "" for unmarked. Replaces the old
   * `hue: number` palette index (#22 discussion).
   *
   * THE PARTITION TREATS IT AS AN OPAQUE STRING. Uniqueness repair in
   * the engine is exact equality only — the engine has no business
   * knowing which glyphs look alike, and does not need to: visual
   * confusability is handled VISOR-SIDE, by construction, because the
   * curated set holds one glyph per confusability class. Anything
   * arriving here from the partition still passes `isAppMarkIcon` before
   * it is rendered: another device may be running a different visor
   * build with a different vocabulary. */
  icon: string;
  nickname?: string;
  createdAt: number;
  needsReconfirm: boolean;
}

export interface UsDevice {
  agentId: string;
  name: string;
  enrolledAt: number;
  revoked: boolean;
}

export type UsEvent =
  | { tag: "profile-changed" }
  | { tag: "mark-added"; provenance: string }
  | { tag: "mark-changed"; provenance: string }
  | { tag: "mark-conflict-repaired"; provenance: string; field: "petname" | "icon" }
  | { tag: "device-added"; name: string }
  | { tag: "device-revoked"; name: string }
  /** The account's storage destination changed on another device.
   * `provider` is the ENGINE's own word ("s3" | "gdrive") — framework
   * vocabulary, not an app-influenced string, so it is admissible
   * inline in an announcement sentence (see pairing.ts's three-voices
   * note). DRIVE.md, "The account syncs its storage config; devices
   * keep their credentials": other devices ANNOUNCE such a change,
   * never silently adopt it. */
  | { tag: "storage-changed"; provider: string };

/** The async, WIT-shaped surface a pairing backend implements. Visor
 * code is written against exactly this interface and nothing wider —
 * the mock and the engine adapter are interchangeable behind it. */
export interface PairingDriver {
  pairJoinStart(): Promise<{ ok: true; value: PairOffer } | { ok: false; error: string }>;
  pairJoinStatus(): Promise<{ ok: true; value: PairJoinState } | { ok: false; error: string }>;
  pairJoinConfirm(): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  pairAddStart(code: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  pairAddStatus(): Promise<{ ok: true; value: PairAddState } | { ok: false; error: string }>;
  pairAddConfirm(
    deviceName: string,
  ): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  pairAbort(): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  userCreate(profile: UsProfile): Promise<{ ok: true; value: string } | { ok: false; error: string }>;

  usProfileGet(): Promise<{ ok: true; value: UsProfile } | { ok: false; error: string }>;
  usProfileSet(profile: UsProfile): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usMarksList(): Promise<{ ok: true; value: UsMark[] } | { ok: false; error: string }>;
  usMarkPut(mark: UsMark): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  usMarkForget(provenance: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;
  usMarkConfirm(provenance: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usContactsList(): Promise<
    { ok: true; value: Array<[string, string]> } | { ok: false; error: string }
  >;
  usContactPut(
    card: string,
    petname: string,
  ): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  usDevicesList(): Promise<{ ok: true; value: UsDevice[] } | { ok: false; error: string }>;
  usDeviceRevoke(agentId: string): Promise<{ ok: true; value: null } | { ok: false; error: string }>;

  /** Drain remotely-caused changes. Local-echo suppression is the
   * backend's job (PAIRING.md §3: "a device never receives events for
   * its own writes"), so the visor may announce every event it drains
   * without second-guessing provenance. */
  usEvents(): Promise<{ ok: true; value: UsEvent[] } | { ok: false; error: string }>;
}
