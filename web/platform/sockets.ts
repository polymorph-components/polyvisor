// `wasi:sockets/types@0.3.0` — the UDP direct path, which this deployment
// does not have.
//
// The endpoint component links this interface for its direct (UDP) path and
// therefore names it as an import whether or not a deployment can serve it
// (runtime/wit/deps/polymorph-iroh/iroh.wit, `world iroh-endpoint`). A
// browser has no UDP socket, so the endpoint binds with `udp-bind-addr`
// unset — "unset binds no socket" — and nothing here is ever called. What it
// has to be is present and honest: every entry point answers
// `error-code.not-supported`, which is what a browser host would answer.
//
// Vendored rather than imported. The upstream module is
// `jsr:@polymorph/iroh@0.6.0`'s `src/sockets.ts`, but the package's only
// export is its root, whose module graph statically pulls
// `@polyengine/translator` — and a realm that ships the translator is
// exactly what this repository's build is built to prevent (web/build.ts:
// "so no realm ever loads the translator"). The upstream file's test
// bookkeeping (a call log the endpoint exam asserts on) is dropped; what
// remains is the resource and the refusal. `ComponentException` comes from
// this repository's pinned `@polyengine/protocol`, which is the copy the
// worker's runtime uses — a branded throw from a second copy would not be
// recognized as one.

import { ComponentException } from "@polyengine/protocol";

/** `wasi:sockets/types@0.3.0`'s `ip-address-family` enum. */
export type IpAddressFamily = "ipv4" | "ipv6";

/** The `ip-socket-address` variant, in `{ kind, value }` form. Opaque here:
 * nothing in this file reads one. */
export type IpSocketAddress =
  | { kind: "ipv4"; value: unknown }
  | { kind: "ipv6"; value: unknown };

/** The one `error-code` case this host can produce. */
type NotSupported = { kind: "not-supported" };

function refuse(what: string): never {
  // A host import signals a WIT `err` by throwing a BRANDED
  // `ComponentException`: an unbranded throw becomes a trap naming the
  // import instead of a guest-visible `err`, and the guest's own answer to
  // "no UDP here" is to carry on over the relay.
  const payload: NotSupported = { kind: "not-supported" };
  throw new ComponentException(
    payload,
    `wasi:sockets/types@0.3.0: ${what} is not provided by this host`,
  );
}

/** The host-implemented `udp-socket` resource. No instance is ever
 * constructed — `create` refuses first. */
export class UdpSocket {
  static create(_addressFamily: IpAddressFamily): UdpSocket {
    return refuse("udp-socket.create");
  }

  bind(_localAddress: IpSocketAddress): void {
    return refuse("udp-socket.bind");
  }

  send(
    _data: Uint8Array,
    _remoteAddress: IpSocketAddress | undefined,
  ): Promise<void> {
    return refuse("udp-socket.send");
  }

  receive(): Promise<[Uint8Array, IpSocketAddress]> {
    return refuse("udp-socket.receive");
  }

  getLocalAddress(): IpSocketAddress {
    return refuse("udp-socket.get-local-address");
  }
}

/** The imports-record fragment for `wasi:sockets/types@0.3.0`. */
export function socketsImports(): Record<string, unknown> {
  return { "wasi:sockets/types@0.3.0": { UdpSocket } };
}
