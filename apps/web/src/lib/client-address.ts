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
 * The API keys its throttle the same way (`apps/api/src/auth-throttle.ts`).
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxyCount: number
): string {
  const socket = socketAddress ?? "unknown";
  if (trustedProxyCount <= 0 || forwardedFor === null) return socket;
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return hops[hops.length - trustedProxyCount] ?? socket;
}
