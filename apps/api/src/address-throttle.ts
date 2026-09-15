import { isIP } from "node:net";

// No imports but Node's own, and nothing TypeScript must transform: the heap
// test runs this file in a child Node process with --expose-gc and type
// stripping alone.

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
 * The most addresses either throttle remembers at once.
 *
 * Each costs about 400 bytes; 50,000 measured 19.5 MB of heap. Past it the
 * address that failed least recently is forgotten, which lets an attacker who
 * controls more than 50,000 distinct IPv4 addresses or IPv6 /64s, and uses them
 * all within a window, reset one address's count. Someone with that many
 * addresses has no need to reset one.
 */
export const MAX_TRACKED_ADDRESSES = 50_000;

interface Entry {
  readonly address: string;
  /** Failures inside the window, oldest first; fewer than `maxFailures`. */
  failures: number[];
  /** 0 when not locked. */
  lockedUntil: number;
  /** Neighbours in recency order: `older` is towards eviction. */
  older: Entry | undefined;
  newer: Entry | undefined;
}

/**
 * Source addresses that have failed authentication too often, and for how long.
 *
 * It counts failures and nothing else: five inside the window lock the address
 * for the cooldown. It does not count, reserve, or queue attempts in flight.
 *
 * In process, like the web login's limiter, and for the same reason: one
 * instance is the installation this is written for, and closing the hole there
 * is worth more than documenting a proxy. Keys are `clientAddress`'s.
 *
 * Memory is proportional to the addresses held, never to the requests
 * answered. Entries sit in a `Map` for lookup and in a doubly linked list
 * ordered by their latest failure: a failure moves its entry to the newest end
 * by changing references, the `Map` is written only when an address is added
 * or forgotten, and at `maxTracked` the oldest entry is dropped from the end of
 * the list without iterating anything. `lockedFor` only reads. Expired entries
 * are swept by walking the list at most once per window.
 *
 * An earlier version kept recency in the `Map`'s insertion order with a
 * long-lived iterator; V8 retains every table a `Map` rehashes into while an
 * iterator over it lives, and the heap grew by about 150 MB per million
 * requests from one locked address.
 */
export class AuthThrottle {
  private readonly options: ThrottleOptions;
  private readonly maxTracked: number;
  private readonly entries = new Map<string, Entry>();
  private oldest: Entry | undefined;
  private newest: Entry | undefined;
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    options: ThrottleOptions = DEFAULT_THROTTLE,
    maxTracked: number = MAX_TRACKED_ADDRESSES
  ) {
    this.options = options;
    this.maxTracked = maxTracked;
  }

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

  /** Count a refused credential from `address`, locking it at the limit. */
  public recordFailure(address: string, now: number): void {
    this.sweep(now);
    const entry = this.touch(address);
    this.expire(entry, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures.length = 0;
    }
  }

  /** The entry for `address`, made the newest, evicting the oldest when full. */
  private touch(address: string): Entry {
    const existing = this.entries.get(address);
    if (existing !== undefined) {
      if (existing !== this.newest) {
        this.unlink(existing);
        this.link(existing);
      }
      return existing;
    }
    while (this.entries.size >= this.maxTracked && this.oldest !== undefined) {
      this.forget(this.oldest);
    }
    const created: Entry = {
      address,
      failures: [],
      lockedUntil: 0,
      older: undefined,
      newer: undefined
    };
    this.link(created);
    this.entries.set(address, created);
    return created;
  }

  private link(entry: Entry): void {
    entry.older = this.newest;
    entry.newer = undefined;
    if (this.newest === undefined) this.oldest = entry;
    else this.newest.newer = entry;
    this.newest = entry;
  }

  private unlink(entry: Entry): void {
    if (entry.older === undefined) this.oldest = entry.newer;
    else entry.older.newer = entry.newer;
    if (entry.newer === undefined) this.newest = entry.older;
    else entry.newer.older = entry.older;
    entry.older = undefined;
    entry.newer = undefined;
  }

  private forget(entry: Entry): void {
    this.unlink(entry);
    this.entries.delete(entry.address);
  }

  private expire(entry: Entry, now: number): void {
    const cutoff = now - this.options.windowMs;
    let aged = 0;
    while (aged < entry.failures.length && (entry.failures[aged] ?? now) <= cutoff) aged += 1;
    if (aged > 0) entry.failures.splice(0, aged);
  }

  /** Drop entries with no failure in the window and no lock in force. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    let entry = this.oldest;
    while (entry !== undefined) {
      const next = entry.newer;
      this.expire(entry, now);
      if (entry.failures.length === 0 && entry.lockedUntil <= now) this.forget(entry);
      entry = next;
    }
  }
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
