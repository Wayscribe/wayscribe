import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorBody } from "./admin.js";
import { AuthThrottle, throttleKey } from "./address-throttle.js";

export {
  AuthThrottle,
  DEFAULT_THROTTLE,
  MAX_TRACKED_ADDRESSES,
  throttleKey,
  type ThrottleOptions
} from "./address-throttle.js";

/**
 * Routes that authenticate the admin token. Ingestion takes API keys only and
 * is not throttled here: a misconfigured service must not lock out an operator
 * reading from the same address, and ingestion refuses the admin token anyway.
 */
const UNTHROTTLED_ROUTES = new Set(["/v1/events", "/v1/events/batch", "/health", "/ready"]);

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Count this request's credential as refused, against the address it came
     * from. Call it where the route refuses the credential, before sending the
     * 401. It does nothing for a request without an `Authorization` header or
     * on a route the throttle does not cover.
     */
    recordAuthenticationFailure(): void;
  }
}

/**
 * The address a request came from, for throttling.
 *
 * The socket's, unless `trustedProxyCount` proxies are declared: then the entry
 * that many hops from the right of X-Forwarded-For, which is what the
 * outermost trusted proxy saw. Entries to its left are whatever the client
 * sent. Fastify's own `trustProxy` is not used: given a hop count it trusts no
 * one, because a count cannot tell a proxy from a client that connects
 * directly and supplies enough hops itself. That is true here too, and is why
 * the setting is only for an API that nothing reaches except through those
 * proxies (docs/OPERATIONS.md §9).
 *
 * A header with fewer entries than the count falls back to the socket. The
 * result is `throttleKey`'s: an IPv6 address is keyed by its /64.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxyCount: number
): string {
  const socket = socketAddress ?? "unknown";
  if (trustedProxyCount <= 0 || forwardedFor === undefined) return throttleKey(socket);
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor)
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return throttleKey(hops[hops.length - trustedProxyCount] ?? socket);
}

/**
 * Throttle failed authentication on every route that accepts the admin token.
 *
 * It counts failures only. A failure is a credential the route refused: a
 * wrong admin token, or on a read route a token that is neither the admin token
 * nor a valid API key. The route records it with
 * `request.recordAuthenticationFailure()` at the moment it refuses, and the 401
 * it sends is unchanged. A request with no `Authorization` header guesses
 * nothing and is not counted, and a database error while a key is looked up is
 * a 500, not a refusal, and is not counted either.
 *
 * Before any credential is checked, a request that presents one from an
 * address with five failures inside the window is answered 429, with
 * `Retry-After` set to what remains of the lock. The admin token is refused
 * the same way, so a guesser learns nothing from which answer is not a 429.
 *
 * The limit is exact for requests that arrive one after another. It is not
 * exact under concurrency, and is not meant to be: a request that passed the
 * lock check before the fifth failure was recorded still has its credential
 * checked. On the admin-only routes the comparison follows the check with no
 * I/O between them, so only requests already inside that gap slip through. On
 * the read routes an API key is looked up in the database, so a burst sent all
 * at once can have up to its own concurrency checked before the lock lands.
 * That is acceptable because guessing is hopeless either way: the admin token
 * is at least 32 characters and an API key carries 192 random bits, and each
 * extra guess costs the server one indexed query. The next request after the
 * burst is refused. Holding the limit exact would take reserving and queueing
 * attempts in flight, which an earlier version did, at the cost of liveness
 * bugs on the authentication path.
 *
 * Success does not clear the count. On the read routes a valid API key also
 * succeeds, and clearing on it would let a key holder reset the budget between
 * guesses at the admin token. Failures age out of the window instead.
 */
export function registerAuthThrottle(
  app: FastifyInstance,
  options: { trustedProxyCount: number },
  throttle = new AuthThrottle()
): void {
  const throttled = (request: FastifyRequest): boolean => {
    const url = request.routeOptions.url;
    return (
      url !== undefined &&
      !UNTHROTTLED_ROUTES.has(url) &&
      request.headers.authorization !== undefined
    );
  };
  const addressOf = (request: FastifyRequest): string =>
    clientAddress(
      request.raw.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      options.trustedProxyCount
    );

  app.decorateRequest(
    "recordAuthenticationFailure",
    function recordAuthenticationFailure(this: FastifyRequest): void {
      if (!throttled(this)) return;
      const address = addressOf(this);
      const now = Date.now();
      throttle.recordFailure(address, now);
      if (throttle.lockedFor(address, now) > 0) {
        app.log.warn(
          { remoteAddress: address, route: this.routeOptions.url },
          "failed authentication limit reached; refusing this address for a while"
        );
      }
    }
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!throttled(request)) return;
    const waitMs = throttle.lockedFor(addressOf(request), Date.now());
    if (waitMs === 0) return;
    await reply
      .code(429)
      .header("retry-after", String(Math.ceil(waitMs / 1000)))
      .send(
        errorBody(
          "too_many_attempts",
          "Too many failed authentication attempts from this address. Try again later.",
          request.id
        )
      );
  });
}
