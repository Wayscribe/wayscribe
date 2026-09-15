// No imports, and nothing TypeScript must transform: the heap test runs this
// file in a child Node process with --expose-gc and type stripping alone.

export interface LimiterOptions {
  maxFailures: number;
  windowMs: number;
  cooldownMs: number;
}

export const DEFAULT_LIMITER: LimiterOptions = {
  maxFailures: 5,
  windowMs: 60_000,
  cooldownMs: 300_000
};

/**
 * The most addresses the limiter remembers at once, as the API's throttle
 * (`apps/api/src/address-throttle.ts`). Past it the least recently seen is
 * forgotten; an attacker with more than 50,000 distinct IPv4 addresses or IPv6
 * /64s in one window gains a fresh count for one of them, which they did not
 * need.
 */
export const MAX_TRACKED_ADDRESSES = 50_000;

interface State {
  readonly key: string;
  /** Failures inside the window, oldest first. */
  failures: number[];
  lockedUntil: number;
  /** Neighbours in recency order: `older` is towards eviction. */
  older: State | undefined;
  newer: State | undefined;
}

/**
 * In-process throttle for login attempts.
 *
 * A login endpoint guarding a single global secret invites guessing. Constant-
 * time comparison prevents timing disclosure but says nothing about volume.
 *
 * Deliberately crude: per-process, so it would not survive horizontal scaling.
 * For a self-hosted single-instance tool this closes the obvious hole, and the
 * alternative — documenting "put this behind a reverse proxy" — is a way of not
 * solving the problem for exactly the user this product targets.
 *
 * Only failures count. A successful login clears the record, so an operator who
 * mistypes twice and then succeeds is not penalized.
 *
 * Bounded in memory and time, the same way as the API's throttle: at most
 * `maxTracked` addresses, in a `Map` for lookup and a doubly linked list for
 * recency, so seeing an address again changes references rather than the
 * `Map`, and the oldest is dropped from the end of the list without iterating
 * anything. Expired entries are swept at most once per window. The version
 * before kept recency in the `Map`'s insertion order with a long-lived
 * iterator, which made V8 keep every table the `Map` rehashed into: 2,000,000
 * failures from one address left 304 MB behind.
 */
export class LoginLimiter {
  private readonly options: LimiterOptions;
  private readonly maxTracked: number;
  private readonly state = new Map<string, State>();
  private oldest: State | undefined;
  private newest: State | undefined;
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    options: LimiterOptions = DEFAULT_LIMITER,
    maxTracked: number = MAX_TRACKED_ADDRESSES
  ) {
    this.options = options;
    this.maxTracked = maxTracked;
  }

  /** How many addresses are remembered. */
  public get size(): number {
    return this.state.size;
  }

  public has(key: string): boolean {
    return this.state.has(key);
  }

  public isLocked(key: string, now: number): boolean {
    const entry = this.state.get(key);
    return entry !== undefined && entry.lockedUntil > now;
  }

  public recordFailure(key: string, now: number): void {
    this.sweep(now);
    const entry = this.touch(key);
    this.expire(entry, now);
    entry.failures.push(now);

    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures.length = 0;
    }
  }

  public recordSuccess(key: string): void {
    const entry = this.state.get(key);
    if (entry !== undefined) this.forget(entry);
  }

  /** The entry for `key`, made the newest, evicting the oldest when full. */
  private touch(key: string): State {
    const existing = this.state.get(key);
    if (existing !== undefined) {
      if (existing !== this.newest) {
        this.unlink(existing);
        this.link(existing);
      }
      return existing;
    }
    while (this.state.size >= this.maxTracked && this.oldest !== undefined) {
      this.forget(this.oldest);
    }
    const created: State = {
      key,
      failures: [],
      lockedUntil: 0,
      older: undefined,
      newer: undefined
    };
    this.link(created);
    this.state.set(key, created);
    return created;
  }

  private link(entry: State): void {
    entry.older = this.newest;
    entry.newer = undefined;
    if (this.newest === undefined) this.oldest = entry;
    else this.newest.newer = entry;
    this.newest = entry;
  }

  private unlink(entry: State): void {
    if (entry.older === undefined) this.oldest = entry.newer;
    else entry.older.newer = entry.newer;
    if (entry.newer === undefined) this.newest = entry.older;
    else entry.newer.older = entry.older;
    entry.older = undefined;
    entry.newer = undefined;
  }

  private forget(entry: State): void {
    this.unlink(entry);
    this.state.delete(entry.key);
  }

  private expire(entry: State, now: number): void {
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
