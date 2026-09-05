/// <reference lib="dom" />
// `polymorph:visor-spike/entry-host` — A MOCK HOST IMPLEMENTATION of how a
// browser becomes a device with an account (visor/ui/entry.ts,
// wit/world.wit's `entry-host` doc). The picker is the one sheet that opens
// BEFORE the visor is claimed, so it renders on the unclaimed grey dress with
// index content only — this module supplies no account content either.
//
// `result<T, string>` / `result<T, picker-refusal>` as a host import lowers
// as: return the value for `ok`, throw a branded `ComponentException` for
// `err` (contract:"Value mapping", cited at host/mount.ts:206 and
// host/pairing.ts's header).

import { ComponentException } from "@deltic/protocol";

export interface PickerRow {
  id: string;
  petname: string;
  lastUsed: bigint;
  asksPassphrase: boolean;
  asksPasskey: boolean;
}

export interface PickerRefusal {
  needsPassphrase: boolean;
  message: string;
}

export interface EntryCallLog {
  calls: Array<{ fn: string; at: number; arg?: unknown }>;
}

/** Every arm the four fallible calls can take, and the two sync
 * capability flags — one flag per function, so a test can put `open` and
 * `openWithPasskey` in different arms in the same run (gate 4d needs both:
 * a `needs-passphrase` refusal on one row, an ordinary failure on
 * another). `"ok"` is the default for everything, so a test that only
 * cares about the picker's PRE-CLAIM rendering never has to touch this
 * object at all. */
export interface EntryTestControls {
  openResult: "ok" | PickerRefusal;
  openWithPasskeyResult: "ok" | PickerRefusal;
  openNewResult: "ok" | string;
  restoreResult: "ok" | string;
  newAccountResult: "ok" | string;
  supportsPasskey: boolean;
  supportsRestore: boolean;
}

export function defaultEntryTestControls(): EntryTestControls {
  return {
    openResult: "ok",
    openWithPasskeyResult: "ok",
    openNewResult: "ok",
    restoreResult: "ok",
    newAccountResult: "ok",
    supportsPasskey: true,
    supportsRestore: true,
  };
}

export function createEntryHostImports(controls: EntryTestControls, log: EntryCallLog) {
  const note = (fn: string) => (arg?: unknown) => {
    log.calls.push({ fn, at: Date.now(), arg });
  };

  return {
    async open(row: PickerRow, passphrase?: string): Promise<void> {
      note("open")({ row, passphrase });
      if (controls.openResult !== "ok") throw new ComponentException(controls.openResult);
    },
    async openWithPasskey(row: PickerRow): Promise<void> {
      note("open-with-passkey")(row);
      if (controls.openWithPasskeyResult !== "ok") {
        throw new ComponentException(controls.openWithPasskeyResult);
      }
    },
    supportsPasskey(): boolean {
      note("supports-passkey")();
      return controls.supportsPasskey;
    },
    async openNew(): Promise<void> {
      note("open-new")();
      if (controls.openNewResult !== "ok") throw new ComponentException(controls.openNewResult);
    },
    async restore(): Promise<void> {
      note("restore")();
      if (controls.restoreResult !== "ok") throw new ComponentException(controls.restoreResult);
    },
    supportsRestore(): boolean {
      note("supports-restore")();
      return controls.supportsRestore;
    },
    async newAccount(): Promise<void> {
      note("new-account")();
      if (controls.newAccountResult !== "ok") throw new ComponentException(controls.newAccountResult);
    },
  };
}
