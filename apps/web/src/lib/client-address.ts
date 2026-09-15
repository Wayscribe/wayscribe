import { isIP } from "node:net";

/**
 * The address a login attempt came from, for the limiter.
 *
 * The socket's, unless `trustedProxyCount` (TRUSTED_PROXY_COUNT) proxies are
 * declared: then the entry that many hops from the right of X-Forwarded-For,
 * which is what the outermost trusted proxy saw. Entries to its left are
 * whatever the client sent. The count cannot tell a proxy from a client that
 * connects directly and supplies enough hops itself, so it is only for a web app
 * that nothing reaches except through those proxies (docs/OPERATIONS.md §9).
 *
 * A header with fewer entries than the count falls back to the socket. With no
 * socket address at all, which happens only where the capture in
 * `instrumentation.ts` is not running, every attempt shares one bucket: a
 * value the client chose would be worse than none.
 *
 * The result is keyed as `throttleKey` says: an IPv6 address by its /64.
 *
 * The API keys its throttle the same way (`apps/api/src/auth-throttle.ts`).
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxyCount: number
): string {
  const socket = socketAddress ?? "unknown";
  if (trustedProxyCount <= 0 || forwardedFor === null) return throttleKey(socket);
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return throttleKey(hops[hops.length - trustedProxyCount] ?? socket);
}

// throttleKey: begin
/**
 * The throttling key for an address: an IPv4 address as it is, an IPv6 address
 * by its /64, and an IPv6 address that carries an IPv4 address as that address.
 *
 * One IPv6 host is routinely assigned a whole /64, so keying on the full
 * address would give it 2^64 separate budgets. Every spelling of one address
 * must key alike, or a new spelling is a new budget: brackets and a port
 * (`[2001:db8::1]:443`, `203.0.113.7:5555`) and an interface zone (`%eth0`)
 * are removed, and an IPv4-mapped address in any form (`::ffff:203.0.113.7`,
 * `0:0:0:0:0:ffff:203.0.113.7`, `::ffff:cb00:7107`) or an IPv4-compatible one
 * written with its dotted quad (`::203.0.113.7`) is the IPv4 address. `::1` and
 * `::` are IPv6. Anything that is not an address (an unknown socket, a proxy's
 * opaque token) is kept as it is.
 *
 * Kept identical in `apps/api/src/address-throttle.ts` and
 * `apps/web/src/lib/client-address.ts`; `tests/throttle-key-parity.test.ts`
 * checks both the behaviour and the text.
 */
export function throttleKey(raw: string): string {
  const address = withoutPort(raw.trim());
  if (isIP(address) === 4) return address;

  const zoneAt = address.indexOf("%");
  const bare = zoneAt === -1 ? address : address.slice(0, zoneAt);
  const groups = isIP(bare) === 6 ? ipv6Groups(bare) : undefined;
  if (groups === undefined) return raw;

  const zeroes = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  const mapped = zeroes(5) && groups[5] === 0xffff;
  const compatible = zeroes(6) && bare.includes(".");
  if (mapped || compatible) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The address without `[` `]` around an IPv6 address, or a port after either. */
function withoutPort(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(address);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(address);
  return ipv4WithPort?.[1] ?? address;
}

/** The eight 16-bit groups of a valid IPv6 address, an embedded dotted quad as the last two. */
function ipv6Groups(address: string): number[] {
  const parse = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((piece) => {
          if (!piece.includes(".")) return [Number.parseInt(piece, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = piece.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const gap = address.indexOf("::");
  if (gap === -1) return parse(address);
  const head = parse(address.slice(0, gap));
  const tail = parse(address.slice(gap + 2));
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
// throttleKey: end
