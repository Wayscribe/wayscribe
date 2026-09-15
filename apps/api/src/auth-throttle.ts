import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorBody } from "./admin.js";

export interface ThrottleOptions {
  maxFailures: number;
  windowMs: number;
  cooldownMs: number;
}

/** The web login's limits (`apps/web/src/lib/login-limiter.ts`), so neither door is the easier one. */
export const DEFAULT_THROTTLE: ThrottleOptions = {
  maxFailures: 5,
  windowMs: 60_000,
  cooldownMs: 300_000
};

/**
 * Routes that authenticate the admin token. Ingestion takes API keys only and
 * is not throttled here: a misconfigured service must not lock out an operator
 * reading from the same address, and ingestion refuses the admin token anyway.
 */
const UNTHROTTLED_ROUTES = new Set(["/v1/events", "/v1/events/batch", "/health", "/ready"]);

/**
 * Source addresses that have failed authentication too often, and for how long.
 *
 * In process, like the web login's limiter, and for the same reason: one
 * instance is the installation this is written for, and closing the hole there
 * is worth more than documenting a proxy. Keys are `clientAddress`'s.
 */
export class AuthThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  public constructor(private readonly options: ThrottleOptions = DEFAULT_THROTTLE) {}

  /** Milliseconds until `address` may try again, or 0 when it may now. */
  public lockedFor(address: string, now: number): number {
    const until = this.lockedUntil.get(address);
    if (until === undefined) return 0;
    if (until <= now) {
      this.lockedUntil.delete(address);
      return 0;
    }
    return until - now;
  }

  /** How many addresses are remembered, which a test uses to show the maps are bounded. */
  public get size(): number {
    return this.failures.size + this.lockedUntil.size;
  }

  public recordFailure(address: string, now: number): void {
    // Many addresses failing once each would otherwise grow the map without
    // end. Entries whose failures have all aged out, and locks that have
    // expired, carry nothing, so they are dropped once there are many.
    if (this.failures.size + this.lockedUntil.size >= PRUNE_AT) this.prune(now);

    const recent = (this.failures.get(address) ?? []).filter(
      (at) => at > now - this.options.windowMs
    );
    recent.push(now);
    if (recent.length >= this.options.maxFailures) {
      this.lockedUntil.set(address, now + this.options.cooldownMs);
      this.failures.delete(address);
      return;
    }
    this.failures.set(address, recent);
  }

  private prune(now: number): void {
    for (const [address, times] of this.failures) {
      if (times.every((at) => at <= now - this.options.windowMs)) this.failures.delete(address);
    }
    for (const [address, until] of this.lockedUntil) {
      if (until <= now) this.lockedUntil.delete(address);
    }
  }
}

/** Remembered addresses at which expired entries are swept. */
const PRUNE_AT = 10_000;

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
 * A header with fewer entries than the count falls back to the socket.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxyCount: number
): string {
  const socket = socketAddress ?? "unknown";
  if (trustedProxyCount <= 0 || forwardedFor === undefined) return socket;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor)
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  return hops[hops.length - trustedProxyCount] ?? socket;
}

/**
 * Throttle failed authentication on every route that accepts the admin token.
 *
 * A failure is a 401 to a request that presented an `Authorization` header: a
 * wrong admin token, or on a read route a token that is neither the admin token
 * nor a valid API key. A request with no header guesses nothing and is not
 * counted. The 401 itself is unchanged.
 *
 * Once an address reaches the limit, every request from it that presents
 * credentials on those routes is refused with 429 before the token is
 * compared, the right token included; otherwise a guesser would keep guessing
 * and look for the one answer that is not a 429.
 *
 * Success does not clear the count. On the read routes a valid API key also
 * succeeds, and clearing on it would let a key holder reset the budget between
 * guesses at the admin token. Failures age out of the window instead.
 */
export function registerAuthThrottle(
  app: FastifyInstance,
  trustedProxyCount: number,
  throttle = new AuthThrottle()
): void {
  const throttled = (url: string | undefined): boolean =>
    url !== undefined && !UNTHROTTLED_ROUTES.has(url);
  const addressOf = (request: FastifyRequest): string =>
    clientAddress(
      request.raw.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      trustedProxyCount
    );

  app.addHook("onRequest", async (request, reply) => {
    if (!throttled(request.routeOptions.url)) return;
    if (request.headers.authorization === undefined) return;

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

  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode !== 401) return;
    if (!throttled(request.routeOptions.url)) return;
    if (request.headers.authorization === undefined) return;

    const now = Date.now();
    const address = addressOf(request);
    throttle.recordFailure(address, now);
    if (throttle.lockedFor(address, now) > 0) {
      app.log.warn(
        { remoteAddress: address, route: request.routeOptions.url },
        "failed authentication limit reached; refusing this address for a while"
      );
    }
  });
}
