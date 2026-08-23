// Mock device-pairing + user-system driver (Track B, #10/#36).
//
// Implements the async surface pinned in
// ../../engine/PAIRING.md §3 ("WIT additions") in TypeScript,
// behind the exact same function names the real engine composite will
// export once Track A lands. Swapping this module for a thin adapter
// over the real `driver` export is the whole integration step — nothing
// in ../../visor/ui/pairing.ts is aware this is a mock.
//
// WHAT IS MOCKED, DELIBERATELY:
//   - Transport: an in-page "network" object shared by every mock
//     instance stands in for the iroh pairing stream (§2). Two panes
//     that hold a reference to the SAME MockPairingNetwork behave like
//     two devices on the real wire: a code offered by one is claimable
//     by the other, and both compute the same SAS from the same
//     transcript.
//   - Hash: the transcript is hashed with SHA-256 (Web Crypto,
//     synchronously available in every target) instead of BLAKE3. The
//     contract (§2) only requires that BOTH sides derive the SAME value
//     from the same transcript, which SHA-256 gives identically; BLAKE3
//     is an engine-side dependency this mock has no reason to vendor.
//     The digit derivation itself (first 4 bytes of the hash, u32 BE,
//     mod 10^6, zero-padded to 6 digits) is exactly the contract's
//     formula (§2) — only the hash function differs, and the mock's
//     hash is 32 bytes, so "first 4 bytes" reads identically over it.
//   - Sync fan-out: the user-system "doc" is a plain JS object shared by
//     reference across every mock instance that has adopted the same
//     user-group-id. A real doc is CRDT-merged across a network; this
//     mock skips convergence because every instance already shares the
//     same object, which is sufficient to develop the visor's reconcile/
//     announce paths without also faking automerge.
//   - Marks conflict repair (§4) is implemented for the two cases the
//     contract states (petname collision, pet-icon collision) so
//     mark-conflict-repaired has something real to fire on.
//
// Nothing here is visor. This module knows nothing about DOM, strips,
// sheets or ceremonies — see ../../visor/ui/pairing.ts, which is the ONLY
// module allowed to render a pairing code or a SAS (invariant (f) in
// scripts/check-invariants.sh).

// --- the driver contract (visor/ui/pairing-driver.ts) ----------------------
//
// The WIT-shaped types and the `PairingDriver` interface used to live
// here. They now live in the VISOR, because they are what the visor's
// pairing UI requires of a backend, not what this mock happens to
// offer; this file is one of two implementations (the other is
// ../../runtime/pairing-engine.ts). They are re-exported so this module's
// existing consumers keep one import for "the mock and its types".
export type {
  PairAddState,
  PairEnrollment,
  PairingDriver,
  PairJoinState,
  PairOffer,
  UsDevice,
  UsEvent,
  UsMark,
  UsProfile,
} from "../../visor/ui/pairing-driver.ts";
import type {
  PairAddState,
  PairEnrollment,
  PairingDriver,
  PairJoinState,
  PairOffer,
  UsDevice,
  UsEvent,
  UsMark,
  UsProfile,
} from "../../visor/ui/pairing-driver.ts";

// --- the shared user-system "doc" ------------------------------------------

interface UserGroupDoc {
  profile: UsProfile;
  marks: Map<string, UsMark>;
  contacts: Map<string, string>;
  devices: Map<string, UsDevice>;
  /** Per-instance-id drained event queues (§4: "per-instance drained
   * queue"). Keyed by the instance whose driver call should see them
   * next; every OTHER instance's write pushes here, never the writer's
   * own (local-echo suppression, per contract). */
  eventQueues: Map<string, UsEvent[]>;
}

function freshGroupDoc(profile: UsProfile): UserGroupDoc {
  return {
    profile,
    marks: new Map(),
    contacts: new Map(),
    devices: new Map(),
    eventQueues: new Map(),
  };
}

function broadcast(doc: UserGroupDoc, from: string, ev: UsEvent) {
  for (const id of doc.eventQueues.keys()) {
    if (id === from) continue; // local-echo suppression
    doc.eventQueues.get(id)!.push(ev);
  }
}

function ensureQueue(doc: UserGroupDoc, instanceId: string) {
  if (!doc.eventQueues.has(instanceId)) doc.eventQueues.set(instanceId, []);
}

// --- marks invariants + deterministic repair (§4) --------------------------

// PET ICONS are OPAQUE STRINGS here, exactly as they are to the engine
// (engine/guest/wit/engine.wit's `us-mark.icon`): the mock
// compares them for EXACT EQUALITY and nothing else. It does not know
// the curated vocabulary, cannot judge visual confusability, and must
// not try — that is the visor's job, discharged by construction (one
// glyph per confusability class in `APP_MARK_ICONS`). "" means UNMARKED
// and never collides with anything, itself included.
//
// (`us-profile.hue` is still a palette index; the ANCHOR colour is
// untouched by the mark change. Only the per-app mark moved from a hue
// to a glyph.)

/** Runs after every write that could have introduced a collision. Older
 * record wins (`createdAt`, tie-break lexicographic provenance); the
 * loser is repaired in place and a `mark-conflict-repaired` event is
 * broadcast, matching §4's "repair writes only from the device that
 * observes a violation involving its OWN losing write; others render
 * the computed outcome without writing" — since this mock's doc is one
 * shared object, "observing" and "repairing" collapse to the same
 * synchronous step, which still yields the same deterministic outcome
 * every instance would compute independently over the real CRDT. */
function repairMarks(doc: UserGroupDoc, instanceId: string) {
  const byPetname = new Map<string, UsMark[]>();
  const byIcon = new Map<string, UsMark[]>();
  for (const m of doc.marks.values()) {
    const pk = m.petname.toLowerCase();
    if (!byPetname.has(pk)) byPetname.set(pk, []);
    byPetname.get(pk)!.push(m);
    // UNMARKED IS NOT A CLAIM. Every record with icon "" would otherwise
    // form one enormous colliding group and repair each other forever.
    if (m.icon === "") continue;
    if (!byIcon.has(m.icon)) byIcon.set(m.icon, []);
    byIcon.get(m.icon)!.push(m);
  }
  const older = (a: UsMark, b: UsMark) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.provenance.localeCompare(b.provenance);

  for (const group of byPetname.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(older);
    for (const loser of sorted.slice(1)) {
      if (!loser.needsReconfirm) {
        loser.needsReconfirm = true;
        broadcast(doc, instanceId, {
          tag: "mark-conflict-repaired",
          provenance: loser.provenance,
          field: "petname",
        });
      }
    }
  }
  for (const [, group] of byIcon) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(older);
    // THE LOSER'S ICON IS CLEARED, NOT REASSIGNED — the engine contract
    // (engine, us-mark repair), mirrored here because the
    // mock is the e2e default and a mock that repaired differently would
    // gate the visor against a behaviour that does not exist.
    //
    // Why clearing rather than picking another glyph: the vocabulary is
    // the VISOR's. The partition holds opaque strings and has no
    // curation rules, no confusability classes and no idea which build
    // of the visor each device runs, so any glyph it invented would be a
    // mark the user never chose — possibly one this device cannot even
    // render. Clearing plus `needsReconfirm` hands the decision back to
    // the surface that owns it: the naming ceremony re-offers six free
    // marks at the next opening (see visor/ui/sheets.ts's picker).
    for (const loser of sorted.slice(1)) {
      if (loser.icon === "") continue;
      loser.icon = "";
      loser.needsReconfirm = true;
      broadcast(doc, instanceId, {
        tag: "mark-conflict-repaired",
        provenance: loser.provenance,
        field: "icon",
      });
    }
  }
}

// --- the "network": pairing offers shared across mock instances -----------

interface PendingOffer {
  code: string;
  token: string;
  joinEndpointId: string;
  joinInstanceId: string;
  expiresAt: number;
  claimed: boolean;
  /** Set once an adder claims the offer; the join side polls for it. */
  claim?: {
    addInstanceId: string;
    addEndpointId: string;
    nonceA: string;
    commit: string;
    sas?: string;
    joinConfirmed: boolean;
    addConfirmed: boolean;
    /** device-name from the ADDER (§3: "recorded... by the ADDER"). */
    deviceName?: string;
    aborted: boolean;
    /** Once true, ENROLL has fired: the join side may report `enrolled`. */
    enrolled: boolean;
  };
}

const BASE32_VISUAL = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // BASE32_NOPAD_VISUAL alphabet (confusable-free)

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += BASE32_VISUAL[b % BASE32_VISUAL.length];
  return out;
}

/** Format §1's fixed-width payload into the display code. This mock
 * does not bit-pack version/endpoint-id/token into 33 bytes (79 chars of
 * BASE32_NOPAD_VISUAL over 33 bytes, per §1's arithmetic) because
 * nothing on the mock side needs to DECODE the code — only look it up in
 * the shared network by exact string match, matching the real protocol's
 * "the adder dials the endpoint id from the code" without needing an
 * actual endpoint id. The LENGTH (79) and ALPHABET are real: the visor's
 * grouped-by-4 rendering and the join/add code fields are built and
 * tested against production dimensions. */
function makeCode(): string {
  // 33 raw bytes -> ceil(33*8/5) = 53 symbols is base32's true ratio;
  // the contract states 79 chars for its specific 1+32+16 = 49-byte
  // payload (49*8/5 = 78.4 -> 79 with padding). Mirror 79 directly so
  // the visor's "groups of 4" renderer is exercised against the real length.
  let out = "";
  while (out.length < 79) out += randomToken(8);
  return out.slice(0, 79);
}

async function sha256Hex(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("\u0000"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** (first 4 bytes of hash, u32 big-endian) mod 10^6, zero-padded to 6
 * digits — PAIRING.md §2's formula exactly, over a SHA-256 transcript
 * hash instead of BLAKE3 (see the sanctioned deviation noted at the
 * top of this file). */
function sasFromHash(hex: string): string {
  const u32be = parseInt(hex.slice(0, 8), 16); // first 4 bytes, big-endian
  return String(u32be % 1_000_000).padStart(6, "0");
}

export class MockPairingNetwork {
  private offers = new Map<string, PendingOffer>();
  /** instanceId -> userGroupId this instance has adopted. */
  private membership = new Map<string, string>();
  private groups = new Map<string, UserGroupDoc>();
  /** instanceId -> display name (for devices-list entries and the
   * demo's own bookkeeping; not part of the WIT surface). */
  instanceLabel = new Map<string, string>();

  /** Called once per instance so its event queue exists even before it
   * joins a group (kept simple: queues live on the group doc, so this
   * is a no-op placeholder for symmetry / future per-instance state). */
  registerInstance(instanceId: string, label: string) {
    this.instanceLabel.set(instanceId, label);
  }

  groupFor(instanceId: string): UserGroupDoc | undefined {
    const gid = this.membership.get(instanceId);
    return gid ? this.groups.get(gid) : undefined;
  }

  createGroup(instanceId: string, profile: UsProfile): string {
    const gid = randomToken(16);
    const doc = freshGroupDoc(profile);
    ensureQueue(doc, instanceId);
    this.groups.set(gid, doc);
    this.membership.set(instanceId, gid);
    return gid;
  }

  startOffer(instanceId: string): PairOffer {
    const code = makeCode();
    const offer: PendingOffer = {
      code,
      token: randomToken(16),
      joinEndpointId: randomToken(32),
      joinInstanceId: instanceId,
      expiresAt: Date.now() + 120_000,
      claimed: false,
    };
    this.offers.set(code, offer);
    return { code, expiresMs: 120_000 };
  }

  getOffer(code: string): PendingOffer | undefined {
    return this.offers.get(code);
  }

  /** CLAIM (§2 step 1). Single-claim: a second CLAIM on an
   * already-claimed offer is refused with a distinct error so the
   * joiner UI can say "someone already tried this code". */
  claim(
    code: string,
    addInstanceId: string,
  ): { ok: true } | { ok: false; error: "not-found" | "expired" | "claimed" } {
    const offer = this.offers.get(code);
    if (!offer) return { ok: false, error: "not-found" };
    if (Date.now() > offer.expiresAt) return { ok: false, error: "expired" };
    if (offer.claimed) return { ok: false, error: "claimed" };
    offer.claimed = true;
    offer.claim = {
      addInstanceId,
      addEndpointId: randomToken(32),
      nonceA: randomToken(16),
      commit: "", // unused: the mock has no separate CLAIM/REVEAL round (see the nonce_j stand-in note below)
      joinConfirmed: false,
      addConfirmed: false,
      aborted: false,
      enrolled: false,
    };
    return { ok: true };
  }

  async computeSas(code: string): Promise<string | undefined> {
    const offer = this.offers.get(code);
    if (!offer?.claim) return undefined;
    if (offer.claim.sas) return offer.claim.sas;
    const transcript = [
      "\x01",
      offer.token,
      offer.joinEndpointId,
      offer.claim.addEndpointId,
      offer.claim.nonceA, // stand-in nonce_j: mock has no separate reveal round
      offer.claim.nonceA,
    ];
    const hex = await sha256Hex(transcript);
    offer.claim.sas = sasFromHash(hex);
    return offer.claim.sas;
  }

  confirmJoin(code: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) offer.claim.joinConfirmed = true;
  }

  confirmAdd(code: string, deviceName: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) {
      offer.claim.addConfirmed = true;
      offer.claim.deviceName = deviceName;
    }
  }

  abort(code: string) {
    const offer = this.offers.get(code);
    if (offer?.claim) offer.claim.aborted = true;
  }

  /** ENROLL (§2 step 6): only after BOTH confirms. Adds the joiner's
   * instance to the same group doc and emits `device-added`. Returns
   * the enrollment payload the join side reports. */
  tryEnroll(code: string): PairEnrollment | undefined {
    const offer = this.offers.get(code);
    if (!offer?.claim || offer.claim.enrolled) return undefined;
    if (!offer.claim.joinConfirmed || !offer.claim.addConfirmed) return undefined;
    const gid = this.membership.get(offer.claim.addInstanceId);
    if (!gid) return undefined;
    const doc = this.groups.get(gid)!;
    this.membership.set(offer.joinInstanceId, gid);
    ensureQueue(doc, offer.joinInstanceId);
    const agentId = randomToken(16);
    const dev: UsDevice = {
      agentId,
      name: offer.claim.deviceName ?? "",
      enrolledAt: Date.now(),
      revoked: false,
      // The mock has no transport at all, so it has no endpoint id to
      // observe: "" is the record's own reading of "not recorded", and
      // inventing a plausible-looking one would make the mock lie about
      // a fact only a real dial can establish.
      endpoint: "",
      enrolledBy: "",
    };
    doc.devices.set(agentId, dev);
    broadcast(doc, offer.joinInstanceId, { tag: "device-added", name: dev.name });
    offer.claim.enrolled = true;
    return { userGroupId: gid, partitionId: gid };
  }
}

// --- per-instance driver ---------------------------------------------------

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Build a PairingDriver for one mock "device". `instanceId` must be
 * unique per pane; `net` must be the SAME MockPairingNetwork instance
 * shared with whatever other pane(s) should be reachable by pairing. */
export function createMockDriver(instanceId: string, net: MockPairingNetwork): PairingDriver {
  net.registerInstance(instanceId, instanceId);

  // join-side session state (this instance is the NEW device).
  let joinCode: string | undefined;
  let joinState: PairJoinState = { tag: "waiting" };

  // add-side session state (this instance is the TRUSTED device).
  let addCode: string | undefined;
  let addState: PairAddState = { tag: "connecting" };

  const driver: PairingDriver = {
    async pairJoinStart() {
      const offer = net.startOffer(instanceId);
      joinCode = offer.code;
      joinState = { tag: "waiting" };
      return ok(offer);
    },

    async pairJoinStatus() {
      if (!joinCode) return err("no offer started");
      const offer = net.getOffer(joinCode);
      if (!offer) return err("offer not found");
      if (offer.claim?.aborted) {
        joinState = { tag: "failed", message: "the other device cancelled" };
        return ok(joinState);
      }
      if (offer.claim?.enrolled) {
        // tryEnroll only sets enrolled after ENROLL is sent; before
        // that the join side must keep polling.
      }
      const enrollment = net.tryEnroll(joinCode);
      if (enrollment) {
        joinState = { tag: "enrolled", enrollment };
        return ok(joinState);
      }
      if (offer.claim?.joinConfirmed && offer.claim.addConfirmed) {
        joinState = { tag: "confirmed-waiting" };
        return ok(joinState);
      }
      if (offer.claim) {
        const sas = await net.computeSas(joinCode);
        if (sas) {
          joinState = { tag: "claimed", sas };
          return ok(joinState);
        }
      }
      if (Date.now() > offer.expiresAt) {
        joinState = { tag: "expired" };
        return ok(joinState);
      }
      joinState = { tag: "waiting" };
      return ok(joinState);
    },

    async pairJoinConfirm() {
      if (!joinCode) return err("no offer started");
      net.confirmJoin(joinCode);
      return ok(null);
    },

    async pairAddStart(code: string) {
      addCode = code.replace(/\s+/g, "");
      const claimed = net.claim(addCode, instanceId);
      if (!claimed.ok) {
        addState = {
          tag: "failed",
          message: claimed.error === "claimed"
            ? "someone already tried this code"
            : claimed.error === "expired"
            ? "this code has expired"
            : "code not recognized",
        };
        return ok(null); // pairAddStart itself succeeds; status reports failure (mirrors join side symmetry)
      }
      addState = { tag: "connecting" };
      return ok(null);
    },

    async pairAddStatus() {
      if (!addCode) return err("no pairing started");
      if (addState.tag === "failed") return ok(addState);
      const offer = net.getOffer(addCode);
      if (!offer?.claim) return ok(addState);
      if (offer.claim.aborted) {
        addState = { tag: "failed", message: "the other device cancelled" };
        return ok(addState);
      }
      if (offer.claim.enrolled) {
        addState = { tag: "enrolled" };
        return ok(addState);
      }
      if (offer.claim.addConfirmed) {
        addState = { tag: "waiting-peer" };
        return ok(addState);
      }
      const sas = await net.computeSas(addCode);
      addState = sas ? { tag: "sas-ready", sas } : { tag: "connecting" };
      return ok(addState);
    },

    async pairAddConfirm(deviceName: string) {
      if (!addCode) return err("no pairing started");
      net.confirmAdd(addCode, deviceName);
      net.tryEnroll(addCode);
      return ok(null);
    },

    async pairAbort() {
      if (joinCode) net.abort(joinCode);
      if (addCode) net.abort(addCode);
      joinCode = addCode = undefined;
      joinState = { tag: "waiting" };
      addState = { tag: "connecting" };
      return ok(null);
    },

    async userCreate(profile: UsProfile) {
      const gid = net.createGroup(instanceId, profile);
      return ok(gid);
    },

    async usProfileGet() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok(doc.profile);
    },

    async usProfileSet(profile: UsProfile) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.profile = profile;
      broadcast(doc, instanceId, { tag: "profile-changed" });
      return ok(null);
    },

    async usMarksList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.marks.values()]);
    },

    async usMarkPut(mark: UsMark) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const existed = doc.marks.has(mark.provenance);
      doc.marks.set(mark.provenance, { ...mark });
      broadcast(
        doc,
        instanceId,
        existed
          ? { tag: "mark-changed", provenance: mark.provenance }
          : { tag: "mark-added", provenance: mark.provenance },
      );
      repairMarks(doc, instanceId);
      return ok(null);
    },

    async usMarkForget(provenance: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.marks.delete(provenance);
      return ok(null);
    },

    async usMarkConfirm(provenance: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const mark = doc.marks.get(provenance);
      if (mark) mark.needsReconfirm = false;
      return ok(null);
    },

    async usContactsList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.contacts.entries()] as Array<[string, string]>);
    },

    async usContactPut(card: string, petname: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      doc.contacts.set(card, petname);
      return ok(null);
    },

    async usDevicesList() {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      return ok([...doc.devices.values()]);
    },

    async usDeviceRevoke(agentId: string) {
      const doc = net.groupFor(instanceId);
      if (!doc) return err("no user group");
      const dev = doc.devices.get(agentId);
      if (!dev) return err("no such device");
      dev.revoked = true;
      broadcast(doc, instanceId, { tag: "device-revoked", name: dev.name });
      return ok(null);
    },

    async usEvents() {
      const doc = net.groupFor(instanceId);
      if (!doc) return ok([]);
      ensureQueue(doc, instanceId);
      const q = doc.eventQueues.get(instanceId)!;
      const drained = q.splice(0, q.length);
      return ok(drained);
    },
  };

  return driver;
}
