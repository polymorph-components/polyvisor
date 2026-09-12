// Contact-file DOM glue: the browser-capability half of contact
// import/export (internal.wit `shell.copy-text`, `shell.read-contact-file`,
// `shell.save-contact-file`). This wraps clipboard, file-picker and download
// browser APIs only — no protobuf/JSON parsing, no merge policy: the
// runtime (`contacts.import-preview`/`import-accept`) parses and verifies
// the bytes this glue merely reads, and the visor drives the review
// (docs/design.md "TS is glue").

/** `shell.copy-text`: write `text` to the system clipboard. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Generous ceiling on a picked file, ahead of `arrayBuffer()`: a contact
 * file is a signed introduction or a small JSON list, not bulk data, so
 * this only needs to be well clear of that — not tuned to any exact runtime
 * bound. Rejects rather than reading arbitrarily large bytes into memory
 * from an untrusted picked file. */
const MAX_CONTACT_FILE_BYTES = 1 * 1024 * 1024;

/**
 * `shell.read-contact-file`: open the browser's file picker and read the
 * selected file's name and bytes. `undefined` for a cancelled picker — WIT
 * `option<...>` none, not an error. Accepts any file: the runtime selects
 * between its supported formats by content, not by what the OS file-type
 * filter admitted.
 */
export function readContactFile(): Promise<
  { name: string; bytes: Uint8Array } | undefined
> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.append(input);

    let settled = false;
    const finish = (
      result: { name: string; bytes: Uint8Array } | undefined,
    ) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      reject(err);
    };

    // Chromium/Edge fire `cancel` when the picker is dismissed with no
    // selection. Browsers without it never fire `change` either in that
    // case, so the promise simply never resolves there — a smaller gap than
    // inventing a focus-return heuristic for a picker with no other signal.
    // Unverified against real browsers pending Playwright coverage once
    // this is wired into a visor call site.
    input.addEventListener("cancel", () => finish(undefined));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined) {
        finish(undefined);
        return;
      }
      if (file.size > MAX_CONTACT_FILE_BYTES) {
        fail(new Error(`contact file too large: ${file.size} bytes`));
        return;
      }
      file.arrayBuffer().then((buf) => {
        finish({ name: file.name, bytes: new Uint8Array(buf) });
      }).catch(fail);
    });

    try {
      input.click();
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * `shell.save-contact-file`: offer `bytes` for download as `name`. Resolves
 * once the download has been handed to the browser; there is no browser
 * signal for where the user actually saves it, or whether they cancel that
 * dialog — that dialog is the browser's own, not this glue's business.
 */
export function saveContactFile(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice().buffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Not revoked synchronously: some browsers start the download on a
  // separate task and a URL revoked before that task runs downloads empty.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
