// THE T0 ANCHOR: the tab's pointer to its ephemeral device
// (PERSISTENCE.md, "T0 reload survival: the sessionStorage anchor").
//
// A T0 device's state lives in a namespace nobody but this tab knows
// about, and the pointer to it lives in sessionStorage — which is
// per-tab, survives a reload, and dies with the tab. That last property
// is what makes T0 mean what it says.
//
// NOT localStorage, and not only because the design record says so: a
// pointer in localStorage would be shared by every tab on the origin,
// which would make two tabs of one T0 device silently the same device
// (the exact case the worker host exists to make structural), and it
// would outlive the tab, turning "ephemeral" into "garbage nobody
// collects". sessionStorage is also the only storage here that is
// allowed to be synchronous — the anchor is read during boot, before
// anything else can proceed.
//
// WHAT MAY BE IN IT: a device id, which is opaque and random by
// construction (index.ts's `newDeviceId`). Nothing else. It is as
// readable as the index and is held to the same rule.
//
// THE DEGRADE RULE IS THE CONSUMER'S. A restored tab (crash restore,
// reopen-closed-tab) can legitimately present a pointer to a namespace
// the sweep has already collected. That is A FRESH DEVICE, SILENTLY —
// never an error, never a dialog. This module does not decide that; it
// exposes `anchorIsLive` so the consumer can ask, and `clearAnchor` so
// it can move on.

import { getDevice } from "./index.ts";

const ANCHOR_KEY = "pm-device-anchor";

/** sessionStorage, or `null` where there is none (a worker — there is
 * no sessionStorage in one, which is precisely why the TAB holds the
 * pointer and hands it to the worker, rather than the worker keeping
 * it; and some private modes). */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Storage access can throw outright rather than be absent.
    return null;
  }
}

/** Point this tab at `id`. */
export function setAnchor(id: string): void {
  store()?.setItem(ANCHOR_KEY, id);
}

/** This tab's device pointer, or `null`. A pointer's PRESENCE says
 * nothing about whether the device still exists — ask `anchorIsLive`. */
export function getAnchor(): string | null {
  return store()?.getItem(ANCHOR_KEY) ?? null;
}

export function clearAnchor(): void {
  store()?.removeItem(ANCHOR_KEY);
}

/**
 * Does the device this pointer names still exist?
 *
 * THE INDEX ROW IS THE ANSWER, and the namespace deliberately is not.
 * A namespace database is created LAZILY, at first use — a device that
 * has been created but has not yet written anything has a row and no
 * storage, and it is as live as a device gets. (The probe matrix caught
 * this on its first run: a freshly created device answered "not live".)
 *
 * The ordering in `destroyNamespace` is what makes the row sufficient:
 * storage goes first and the row goes LAST, so a row that is gone means
 * a sweep or a remove definitely ran. The reverse state — row present,
 * storage already deleted — is a half-finished collection, and
 * answering "live" for it costs the consumer nothing: it opens an empty
 * namespace, which is a fresh device, silently, exactly as the degrade
 * rule prescribes. `namespaceExists` remains exported for callers that
 * want to ask the storage question separately.
 */
export async function anchorIsLive(id: string): Promise<boolean> {
  if (!id) return false;
  return (await getDevice(id)) !== undefined;
}

/**
 * The boot question, in one call: the tab's pointer if it still names a
 * live device, otherwise `null` WITH the stale pointer cleared. The
 * caller's next move on `null` is to make a fresh device — silently.
 */
export async function adoptAnchor(): Promise<string | null> {
  const id = getAnchor();
  if (id === null) return null;
  if (await anchorIsLive(id)) return id;
  clearAnchor();
  return null;
}
