// Browser host for the endpoint's linked UDP interface. Browsers provide no
// UDP, so every operation returns WIT `not-supported`. This is local rather
// than imported because the upstream package root pulls the translator into
// worker.js; the branded exception must also use this runtime's protocol copy.

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
  // Unbranded throws become traps rather than the WIT error arm.
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
