// One-shot dedicated worker for backup-v1 Argon2. The Rust component does all
// cryptography; this file only loads artifacts and moves bytes.
import {
  artifactsFromEnvelope,
  instantiate,
} from "@polyengine/runtime/embedder";
import { wasi } from "@polyengine/wasi";

const BACKUP_KDF = "polyvisor:backup-kdf/backup-kdf@0.1.0";

declare const self: {
  readonly location: Location;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

interface Request {
  passphrase: string;
  salt: Uint8Array;
}

self.onmessage = (event: MessageEvent<Request>) => {
  void derive(event.data).then((key) => {
    self.postMessage({ ok: key }, [key.buffer]);
  }, (error: unknown) => {
    self.postMessage({ error: String((error as Error)?.message ?? error) });
  }).finally(() => self.close());
};

async function derive(request: Request): Promise<Uint8Array> {
  if (
    typeof request?.passphrase !== "string" ||
    !(request?.salt instanceof Uint8Array)
  ) throw new Error("invalid backup KDF request");

  const base = self.location.href;
  const [wasmResponse, planResponse] = await Promise.all([
    fetch(new URL("kdf.component.wasm", base)),
    fetch(new URL("kdf.component.plan.json", base)),
  ]);
  if (!wasmResponse.ok || !planResponse.ok) {
    throw new Error(
      `backup KDF component unavailable (${wasmResponse.status}/${planResponse.status})`,
    );
  }
  const instance = await instantiate(
    artifactsFromEnvelope(
      await planResponse.text(),
      new Uint8Array(await wasmResponse.arrayBuffer()),
    ),
    { ...wasi() },
    { jspi: false },
  );
  const derive = (instance.exports as Record<string, Record<string, unknown>>)
    [BACKUP_KDF].derive as (
      passphrase: string,
      salt: Uint8Array,
    ) => Uint8Array;
  const key = await derive(request.passphrase, request.salt);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error(
      `backup KDF returned an invalid key (${key?.constructor?.name ?? typeof key}, ${key?.byteLength ?? "unknown"} bytes)`,
    );
  }
  return key;
}
