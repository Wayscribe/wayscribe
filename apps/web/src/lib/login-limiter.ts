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
 */
export class LoginLimiter {
  private readonly state = new Map<string, State>();

  public constructor(private readonly options: LimiterOptions = DEFAULT_LIMITER) {}

  public isLocked(key: string, now: number): boolean {
    const entry = this.state.get(key);
    return entry !== undefined && entry.lockedUntil > now;
  }

  public recordFailure(key: string, now: number): void {
    const entry = this.state.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((at) => at > now - this.options.windowMs);
    entry.failures.push(now);

    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.cooldownMs;
      entry.failures = [];
    }

    this.state.set(key, entry);
  }

  public recordSuccess(key: string): void {
    this.state.delete(key);
  }
}
