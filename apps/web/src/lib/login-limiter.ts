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
 * (`apps/api/src/auth-throttle.ts`). Past it the least recently seen is
 * forgotten; an attacker with more than 50,000 distinct IPv4 addresses or IPv6
 * /64s in one window gains a fresh count for one of them, which they did not
 * need.
 */
export const MAX_TRACKED_ADDRESSES = 50_000;

interface State {
  failures: number[];
  lockedUntil: number;
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
 * Bounded in memory and time. It held every address it had ever seen, a
 * million in 325 MB; it now holds at most `maxTracked`, evicting the least
 * recently seen, and sweeps out expired entries at most once per window.
 */
export class LoginLimiter {
  private readonly state = new Map<string, State>();
  /** Live over `state`: it skips deleted keys and reaches re-inserted ones at the end. */
  private evictionOrder: MapIterator<string> = this.state.keys();
  private lastSweep = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly options: LimiterOptions = DEFAULT_LIMITER,
    private readonly maxTracked: number = MAX_TRACKED_ADDRESSES
  ) {}

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
    entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
    entry.failures.push(now);

    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures = [];
    }
  }

  public recordSuccess(key: string): void {
    this.state.delete(key);
  }

  /** The entry for `key`, moved to the newest position, evicting the oldest when full. */
  private touch(key: string): State {
    const existing = this.state.get(key);
    if (existing !== undefined) {
      this.state.delete(key);
      this.state.set(key, existing);
      return existing;
    }
    while (this.state.size >= this.maxTracked) {
      // One iterator across evictions: a fresh `keys()` walks every slot a
      // delete left at the front of the table, which made eviction slower the
      // more it had evicted.
      let oldest = this.evictionOrder.next();
      if (oldest.done === true) {
        this.evictionOrder = this.state.keys();
        oldest = this.evictionOrder.next();
        if (oldest.done === true) break;
      }
      this.state.delete(oldest.value);
    }
    const created: State = { failures: [], lockedUntil: 0 };
    this.state.set(key, created);
    return created;
  }

  /** Drop entries with no failure in the window and no lock in force. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.options.windowMs;
    for (const [key, entry] of this.state) {
      if (entry.lockedUntil <= now && entry.failures.every((at) => at <= cutoff)) {
        this.state.delete(key);
      }
    }
  }
}
