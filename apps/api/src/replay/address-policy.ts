import { isIP } from "node:net";

export interface AddressVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Whether a resolved address may be connected to.
 *
 * **Private ranges are deliberately allowed** (ADR-033). Every destination this
 * feature exists for — `localhost`, `host.docker.internal`, a Compose service
 * name — resolves into one, and blocking them would leave replay unable to
 * reach anything it is for. `REPLAY_ALLOWED_HOSTS` is the control there.
 *
 * What is refused is the set of addresses that are never a legitimate replay
 * destination in any environment, and that an SSRF is usually aiming at:
 *
 * - **169.254.0.0/16**, which carries the cloud instance metadata endpoint at
 *   169.254.169.254. On a hosted runner that endpoint hands out credentials for
 *   the machine's role, and it answers unauthenticated HTTP. It is the single
 *   highest-value target reachable from a request-forgery bug.
 * - Multicast and broadcast, which are not a destination.
 * - The unspecified address, which means "this host" to a connect call.
 *
 * This is a floor, not the perimeter. The allowlist is the perimeter.
 */
export function checkAddress(address: string): AddressVerdict {
  const version = isIP(address);
  if (version === 0) return { allowed: false, reason: `${address} is not an IP address.` };

  if (version === 4) return checkIpv4(address);
  return checkIpv6(address);
}

function checkIpv4(address: string): AddressVerdict {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0] = octets;

  if (a === 0) {
    return { allowed: false, reason: "0.0.0.0/8 is not a destination." };
  }
  if (a === 169 && b === 254) {
    return {
      allowed: false,
      reason:
        "169.254.0.0/16 is refused: it carries the cloud instance metadata endpoint, which hands out machine credentials over unauthenticated HTTP."
    };
  }
  if (a >= 224) {
    return { allowed: false, reason: "Multicast and reserved ranges are not a destination." };
  }
  return { allowed: true };
}

function checkIpv6(address: string): AddressVerdict {
  const lower = address.toLowerCase();

  // IPv4-mapped forms carry an IPv4 address and must be judged as one, or
  // ::ffff:169.254.169.254 walks straight past the rule above.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return checkIpv4(mapped[1]);

  if (lower === "::") return { allowed: false, reason: ":: is not a destination." };
  if (lower.startsWith("ff")) {
    return { allowed: false, reason: "IPv6 multicast is not a destination." };
  }
  if (lower.startsWith("fe80")) {
    return {
      allowed: false,
      reason: "IPv6 link-local is refused for the same reason as 169.254.0.0/16."
    };
  }
  return { allowed: true };
}
