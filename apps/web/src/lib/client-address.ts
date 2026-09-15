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

/**
 * The throttling key for an address: an IPv4 address as it is, an IPv6 address
 * by its /64, and an IPv4-mapped IPv6 address as the IPv4 address it carries.
 *
 * One IPv6 host is routinely assigned a whole /64, so keying on the full
 * address would give it 2^64 separate budgets. The same function as the API's
 * (`apps/api/src/auth-throttle.ts`), repeated because the web app does not
 * depend on the API. Anything that is not an IP
 * address (an unknown socket, a proxy's opaque token) is kept as it is.
 */
export function throttleKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (isIP(address) !== 6) return address;

  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::")
    ? [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right]
    : left;
  const prefix = groups
    .slice(0, 4)
    .map((group) => (group.includes(".") ? group : Number.parseInt(group, 16).toString(16)))
    .join(":");
  return `${prefix}::/64`;
}

/** Groups a list of IPv6 pieces occupies: an embedded dotted quad is two. */
function width(pieces: readonly string[]): number {
  return pieces.reduce((sum, piece) => sum + (piece.includes(".") ? 2 : 1), 0);
}
