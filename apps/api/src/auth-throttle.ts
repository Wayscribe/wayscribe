import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorBody } from "./admin.js";
import { AuthThrottle, throttleKey, type Admission } from "./address-throttle.js";
import { bearerToken } from "./auth.js";

export {
  AuthThrottle,
  DEFAULT_THROTTLE,
  MAX_TRACKED_ADDRESSES,
  throttleKey,
  type Admission,
  type ThrottleOptions
} from "./address-throttle.js";

/**
 * Routes that authenticate the admin token. Ingestion takes API keys only and
 * is not throttled here: a misconfigured service must not lock out an operator
 * reading from the same address, and ingestion refuses the admin token anyway.
 */
const UNTHROTTLED_ROUTES = new Set(["/v1/events", "/v1/events/batch", "/health", "/ready"]);

/**
 * The longest a request waits for a slot held by attempts being verified. A key
 * lookup takes milliseconds, so a wait this long means the database is stuck,
 * and the request is refused rather than held.
 */
const MAX_WAIT_MS = 5_000;

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Report that this request's credential has been verified: `failed` when
     * it did not authenticate. Releases the throttle slot the request holds, if
     * any, so a valid key holds one for its lookup and not its whole request.
     * Called more than once, or for a request holding no slot, it does nothing.
     */
    settleAuthentication(failed: boolean): void;
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
 * A failure is a 401 to a request that presented an `Authorization` header: a
 * wrong admin token, or on a read route a token that is neither the admin token
 * nor a valid API key. A request with no header guesses nothing and is not
 * counted. The 401 itself is unchanged.
 *
 * The exact admin token is recognised here, synchronously and in constant time,
 * and is never counted or held back, so the web app's many concurrent reads from
 * one address are not limited. Any other credential is admitted before it is
 * verified (`AuthThrottle.admit`): an address may have at most five failures in
 * the window and attempts being verified together, which holds the limit under
 * concurrency. A slot is held only while the credential is checked: the read
 * routes call `request.settleAuthentication` the moment the key lookup answers,
 * and the admin routes, which compare synchronously, answer a refusal at once.
 * A request that finds every slot taken by attempts being checked waits for one,
 * up to `MAX_WAIT_MS` and `MAX_WAITING_PER_ADDRESS` deep, rather than being
 * refused, so fifty concurrent reads with a valid key are fifty answers, five
 * lookups at a time.
 *
 * Once an address reaches the limit, every request from it that presents
 * credentials on those routes is refused with 429, the right token included;
 * otherwise a guesser would keep guessing and look for the one answer that is
 * not a 429.
 *
 * Success does not clear the count. On the read routes a valid API key also
 * succeeds, and clearing on it would let a key holder reset the budget between
 * guesses at the admin token. Failures age out of the window instead.
 */
export function registerAuthThrottle(
  app: FastifyInstance,
  options: { adminToken: string; trustedProxyCount: number },
  throttle = new AuthThrottle()
): void {
  app.decorateRequest(
    "settleAuthentication",
    function settleAuthentication(this: FastifyRequest, failed: boolean): void {
      settle(this, failed);
    }
  );

  const throttled = (url: string | undefined): boolean =>
    url !== undefined && !UNTHROTTLED_ROUTES.has(url);
  const addressOf = (request: FastifyRequest): string =>
    clientAddress(
      request.raw.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      options.trustedProxyCount
    );
  /** Requests holding an admitted slot, and the key it was taken under. */
  const admitted = new WeakMap<FastifyRequest, string>();

  const refuse = (request: FastifyRequest, retryAfterMs: number) =>
    ({
      status: 429,
      retryAfter: String(Math.ceil(retryAfterMs / 1000)),
      body: errorBody(
        "too_many_attempts",
        "Too many failed authentication attempts from this address. Try again later.",
        request.id
      )
    }) as const;

  app.addHook("onRequest", async (request, reply) => {
    if (!throttled(request.routeOptions.url)) return;
    const header = request.headers.authorization;
    if (header === undefined) return;

    const address = addressOf(request);
    const now = Date.now();
    let refusal: ReturnType<typeof refuse> | undefined;

    if (presentsAdminToken(header, options.adminToken)) {
      const waitMs = throttle.lockedFor(address, now);
      if (waitMs > 0) refusal = refuse(request, waitMs);
    } else {
      const admission = await admitWhenFree(request, address, now);
      if (admission.ok) admitted.set(request, address);
      else refusal = refuse(request, admission.retryAfterMs);
    }

    if (refusal === undefined) return;
    await reply.code(refusal.status).header("retry-after", refusal.retryAfter).send(refusal.body);
  });

  /**
   * Admit `address`, waiting for a slot while every one is held by an attempt
   * being verified. A lock, a full queue, a closed connection, or the deadline
   * ends the wait with a refusal.
   */
  const admitWhenFree = async (
    request: FastifyRequest,
    address: string,
    now: number
  ): Promise<Admission> => {
    const deadline = now + MAX_WAIT_MS;
    let admission = throttle.admit(address, now);
    while (!admission.ok && admission.busy) {
      const remaining = deadline - Date.now();
      const wait = remaining > 0 ? throttle.waitForSlot(address) : undefined;
      if (wait === undefined) return admission;
      const freed = await Promise.race([
        wait.freed.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => {
            resolve(false);
          }, remaining);
          void wait.freed.then(() => {
            clearTimeout(timer);
          });
        })
      ]);
      if (!freed) {
        wait.cancel();
        return admission;
      }
      if (request.raw.destroyed) return { ok: false, retryAfterMs: 1_000, busy: false };
      admission = throttle.admit(address, Date.now());
    }
    return admission;
  };

  const settle = (request: FastifyRequest, failed: boolean): void => {
    const address = admitted.get(request);
    if (address === undefined) return;
    admitted.delete(request);
    const now = Date.now();
    throttle.settle(address, now, failed);
    if (failed && throttle.lockedFor(address, now) > 0) {
      app.log.warn(
        { remoteAddress: address, route: request.routeOptions.url },
        "failed authentication limit reached; refusing this address for a while"
      );
    }
  };

  // Whatever did not settle at verification settles here: the admin routes'
  // synchronous refusals, and anything that answered before authenticating.
  app.addHook("onResponse", async (request, reply) => {
    settle(request, reply.statusCode === 401);
  });
  // A client that disconnects before the answer still frees its slot.
  app.addHook("onRequestAbort", (request, done) => {
    settle(request, false);
    done();
  });
}

/** Whether the header is exactly `Bearer <admin token>`, compared in constant time. */
function presentsAdminToken(header: string, adminToken: string): boolean {
  const presented = bearerToken(header);
  if (presented === undefined) return false;
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(adminToken, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
