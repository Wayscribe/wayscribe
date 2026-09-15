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
 * least recently seen address is forgotten, which lets an attacker who controls
 * more than 50,000 distinct IPv4 addresses or IPv6 /64s, and uses them all
 * within a window, reset one address's count. Someone with that many
 * addresses has no need to reset one.
 */
export const MAX_TRACKED_ADDRESSES = 50_000;

/**
 * Requests from one address that may wait for a slot at once. Past it a
 * request is refused straight away, so a burst cannot park unbounded promises.
 */
export const MAX_WAITING_PER_ADDRESS = 64;

interface Entry {
  readonly address: string;
  /** Failures inside the window, oldest first; never more than `maxFailures`. */
  failures: number[];
  /** Attempts admitted and not yet settled. */
  pending: number;
  /** 0 when not locked. */
  lockedUntil: number;
  /** Requests waiting for a slot, woken in order. */
  waiters: (() => void)[];
  /** Neighbours in recency order: `older` is towards eviction. */
  older: Entry | undefined;
  newer: Entry | undefined;
}

export type Admission =
  | { ok: true }
  /** `busy`: every slot is held by an attempt in flight, and one may free in a moment. */
  | { ok: false; retryAfterMs: number; busy: boolean };

/** A place in an address's queue for a slot. */
export interface SlotWait {
  /** Resolves when a slot may have freed, or the address was locked or forgotten. */
  readonly freed: Promise<void>;
  /** Leave the queue without waiting any longer. */
  cancel(): void;
}

/**
 * Source addresses that have failed authentication too often, and for how long.
 *
 * In process, like the web login's limiter, and for the same reason: one
 * instance is the installation this is written for, and closing the hole there
 * is worth more than documenting a proxy. Keys are `clientAddress`'s.
 *
 * Memory is proportional to the addresses held, never to the requests
 * answered. Entries sit in a `Map` for lookup and in a doubly linked list for
 * recency: seeing an address again moves its entry to the newest end by
 * changing four references, and the `Map` is written only when an address is
 * added or forgotten. At `maxTracked` the oldest entry is dropped from the end
 * of the list, which needs no iteration. The previous version kept recency in
 * the `Map`'s insertion order, deleting and re-inserting on every request and
 * keeping one iterator alive to find the oldest key; V8 retains every table a
 * `Map` rehashes into while an iterator over it lives, and the constant
 * re-insertion rehashed it constantly, so the heap grew by about 150 MB per
 * million requests from a single locked address and never came back.
 *
 * Expired entries are swept by walking the list at most once per window, so no
 * single request pays for the whole of it.
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

  /**
   * Reserve one attempt for `address` before its credentials are verified.
   *
   * Refused while the address is locked, and while its failures in the window
   * plus the attempts in flight reach the limit (`busy`). Verification awaits
   * the database, so counting only answered failures let hundreds of
   * concurrent guesses through before the first came back; counting attempts
   * in flight holds the limit however many arrive at once. Every admitted
   * attempt must be settled, and should be as soon as its credential is
   * verified, so a slot is held for the lookup and not the whole request.
   */
  public admit(address: string, now: number): Admission {
    this.sweep(now);
    const entry = this.touch(address);
    if (entry.lockedUntil > now) {
      return { ok: false, retryAfterMs: entry.lockedUntil - now, busy: false };
    }
    this.expire(entry, now);
    if (entry.failures.length + entry.pending >= this.options.maxFailures) {
      const oldest = entry.failures[0];
      if (entry.pending > 0) return { ok: false, retryAfterMs: 1_000, busy: true };
      // Only failures hold the slots: the soonest one frees is when the oldest
      // leaves the window. Locking at `maxFailures` means this is rare.
      const retryAfterMs =
        oldest === undefined ? 1_000 : Math.max(1_000, oldest + this.options.windowMs - now);
      return { ok: false, retryAfterMs, busy: false };
    }
    entry.pending += 1;
    return { ok: true };
  }

  /**
   * Wait in `address`'s queue for a slot, after `admit` answered `busy`.
   *
   * Undefined when the queue is full. The caller admits again once `freed`
   * resolves, and cancels if it stops waiting first.
   */
  public waitForSlot(address: string): SlotWait | undefined {
    const entry = this.entries.get(address);
    if (entry === undefined || entry.waiters.length >= MAX_WAITING_PER_ADDRESS) return undefined;
    let wake: () => void = () => undefined;
    const freed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    entry.waiters.push(wake);
    return {
      freed,
      cancel: () => {
        const at = entry.waiters.indexOf(wake);
        if (at !== -1) entry.waiters.splice(at, 1);
      }
    };
  }

  /** Settle an admitted attempt: a failure is counted, a success counts nothing. */
  public settle(address: string, now: number, failed: boolean): void {
    const entry = this.touch(address);
    entry.pending = Math.max(0, entry.pending - 1);
    if (failed) this.fail(entry, now);
    this.wake(entry, now);
  }

  /** Count a failure that was not admitted through `admit`. */
  public recordFailure(address: string, now: number): void {
    this.sweep(now);
    const entry = this.touch(address);
    this.fail(entry, now);
    this.wake(entry, now);
  }

  private fail(entry: Entry, now: number): void {
    this.expire(entry, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures.length = 0;
    }
  }

  /** Wake as many waiters as there are slots, or all of them when there is nothing to wait for. */
  private wake(entry: Entry, now: number): void {
    if (entry.waiters.length === 0) return;
    const locked = entry.lockedUntil > now;
    const free = locked
      ? entry.waiters.length
      : this.options.maxFailures - entry.failures.length - entry.pending;
    for (const waiter of entry.waiters.splice(0, Math.max(0, free))) waiter();
  }

  /** The entry for `address`, made the newest, evicting the oldest when full. */
  private touch(address: string): Entry {
    const existing = this.entries.get(address);
    if (existing !== undefined) {
      this.moveToNewest(existing);
      return existing;
    }
    while (this.entries.size >= this.maxTracked && this.oldest !== undefined) {
      this.forget(this.oldest);
    }
    const created: Entry = {
      address,
      failures: [],
      pending: 0,
      lockedUntil: 0,
      waiters: [],
      older: this.newest,
      newer: undefined
    };
    if (this.newest === undefined) this.oldest = created;
    else this.newest.newer = created;
    this.newest = created;
    this.entries.set(address, created);
    return created;
  }

  private moveToNewest(entry: Entry): void {
    if (entry === this.newest) return;
    this.unlink(entry);
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

  /** Drop an entry. Anyone waiting on it is woken, admits again, and starts a new one. */
  private forget(entry: Entry): void {
    this.unlink(entry);
    this.entries.delete(entry.address);
    for (const waiter of entry.waiters.splice(0)) waiter();
  }

  private expire(entry: Entry, now: number): void {
    const cutoff = now - this.options.windowMs;
    let aged = 0;
    while (aged < entry.failures.length && (entry.failures[aged] ?? now) <= cutoff) aged += 1;
    if (aged > 0) entry.failures.splice(0, aged);
  }

  /** Drop entries holding nothing: no failure in the window, no lock, nothing in flight or waiting. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    let entry = this.oldest;
    while (entry !== undefined) {
      const next = entry.newer;
      this.expire(entry, now);
      if (
        entry.failures.length === 0 &&
        entry.pending === 0 &&
        entry.waiters.length === 0 &&
        entry.lockedUntil <= now
      ) {
        this.forget(entry);
      }
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
