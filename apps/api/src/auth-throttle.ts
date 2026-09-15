import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
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
 * The most addresses either throttle remembers at once.
 *
 * Each costs a few hundred bytes; 50,000 is about 15 MB at worst. Past it the
 * least recently seen address is forgotten, which lets an attacker who controls
 * more than 50,000 distinct IPv4 addresses or IPv6 /64s, and uses them all
 * within a window, reset one address's count. Someone with that many
 * addresses has no need to reset one.
 */
export const MAX_TRACKED_ADDRESSES = 50_000;

interface Entry {
  /** Failures inside the window, oldest first. */
  failures: number[];
  /** Attempts admitted and not yet answered. */
  pending: number;
  /** 0 when not locked. */
  lockedUntil: number;
}

export type Admission = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Source addresses that have failed authentication too often, and for how long.
 *
 * In process, like the web login's limiter, and for the same reason: one
 * instance is the installation this is written for, and closing the hole there
 * is worth more than documenting a proxy. Keys are `clientAddress`'s.
 *
 * Bounded in both memory and time. The map never holds more than
 * `maxTracked` addresses, evicting the least recently seen (a `Map` iterates
 * in insertion order, and every touch re-inserts). Expired entries are swept at
 * most once per window, so no single failure pays for the whole map; the
 * previous version swept on every failure once 10,000 were held.
 */
export class AuthThrottle {
  private readonly entries = new Map<string, Entry>();
  /** Live over `entries`: it skips deleted keys and reaches re-inserted ones at the end. */
  private evictionOrder: MapIterator<string> = this.entries.keys();
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly options: ThrottleOptions = DEFAULT_THROTTLE,
    private readonly maxTracked: number = MAX_TRACKED_ADDRESSES
  ) {}

  /** How many addresses are remembered. */
  public get size(): number {
    return this.entries.size;
  }

  public has(address: string): boolean {
    return this.entries.has(address);
  }

  /** Milliseconds until `address` may try again, or 0 when it may now. */
  public lockedFor(address: string, now: number): number {
    const entry = this.entries.get(address);
    return entry === undefined || entry.lockedUntil <= now ? 0 : entry.lockedUntil - now;
  }

  /**
   * Reserve one attempt for `address` before its credentials are verified.
   *
   * Refused while the address is locked, and while its failures in the window
   * plus the attempts already in flight reach the limit. Verification awaits
   * the database, so counting only answered failures let hundreds of
   * concurrent guesses through before the first came back; counting in-flight
   * attempts holds the limit however many arrive at once. Every admitted
   * attempt must be settled.
   */
  public admit(address: string, now: number): Admission {
    this.sweep(now);
    const entry = this.touch(address);
    if (entry.lockedUntil > now) return { ok: false, retryAfterMs: entry.lockedUntil - now };

    this.expire(entry, now);
    if (entry.failures.length + entry.pending >= this.options.maxFailures) {
      // The soonest a slot can free: the oldest failure leaving the window, or
      // an in-flight attempt answering, which is a moment away.
      const oldest = entry.failures[0];
      const retryAfterMs =
        entry.pending > 0 || oldest === undefined
          ? 1_000
          : Math.max(1_000, oldest + this.options.windowMs - now);
      return { ok: false, retryAfterMs };
    }
    entry.pending += 1;
    return { ok: true };
  }

  /** Answer an admitted attempt: a failure is counted, a success counts nothing. */
  public settle(address: string, now: number, failed: boolean): void {
    const entry = this.touch(address);
    entry.pending = Math.max(0, entry.pending - 1);
    if (failed) this.fail(entry, now);
  }

  /** Count a failure that was not admitted through `admit`. */
  public recordFailure(address: string, now: number): void {
    this.sweep(now);
    this.fail(this.touch(address), now);
  }

  private fail(entry: Entry, now: number): void {
    this.expire(entry, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures = [];
    }
  }

  /** The entry for `address`, moved to the newest position, evicting the oldest when full. */
  private touch(address: string): Entry {
    const existing = this.entries.get(address);
    if (existing !== undefined) {
      this.entries.delete(address);
      this.entries.set(address, existing);
      return existing;
    }
    while (this.entries.size >= this.maxTracked) {
      // One iterator kept across evictions. A fresh `keys()` starts at the
      // front of the table and walks every slot a delete left behind, so
      // asking for the oldest key cost more the more had been evicted: 14 ms
      // per thousand failures past the cap, against 0.4 before it.
      let oldest = this.evictionOrder.next();
      if (oldest.done === true) {
        this.evictionOrder = this.entries.keys();
        oldest = this.evictionOrder.next();
        if (oldest.done === true) break;
      }
      this.entries.delete(oldest.value);
    }
    const created: Entry = { failures: [], pending: 0, lockedUntil: 0 };
    this.entries.set(address, created);
    return created;
  }

  private expire(entry: Entry, now: number): void {
    const cutoff = now - this.options.windowMs;
    let aged = 0;
    while (aged < entry.failures.length && (entry.failures[aged] ?? now) <= cutoff) aged += 1;
    if (aged > 0) entry.failures.splice(0, aged);
  }

  /** Drop entries holding nothing: no failure in the window, no lock, nothing in flight. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const [address, entry] of this.entries) {
      this.expire(entry, now);
      if (entry.failures.length === 0 && entry.pending === 0 && entry.lockedUntil <= now) {
        this.entries.delete(address);
      }
    }
  }
}

/**
 * The throttling key for an address: an IPv4 address as it is, an IPv6 address
 * by its /64, and an IPv4-mapped IPv6 address as the IPv4 address it carries.
 *
 * One IPv6 host is routinely assigned a whole /64, so keying on the full
 * address would give it 2^64 separate budgets. Anything that is not an IP
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
 * the window and unverified attempts in flight together, which holds the limit
 * under concurrency. A valid API key on a read route takes a slot while it is
 * verified and gives it back when answered.
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
      const admission = throttle.admit(address, now);
      if (admission.ok) admitted.set(request, address);
      else refusal = refuse(request, admission.retryAfterMs);
    }

    if (refusal === undefined) return;
    await reply.code(refusal.status).header("retry-after", refusal.retryAfter).send(refusal.body);
  });

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
  const [scheme, presented, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || presented === undefined || rest.length > 0) {
    return false;
  }
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(adminToken, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
