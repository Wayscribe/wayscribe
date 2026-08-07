import type { Diagnostics } from "./diagnostics.js";

export interface TransportOptions {
  send: (batch: readonly unknown[]) => Promise<void>;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Retrying transport with a circuit breaker.
 *
 * Retries reuse the caller's batch unchanged, so the client-generated event IDs
 * make a duplicate delivery harmless under Phase 1b's idempotency.
 *
 * The clock, sleep, and jitter source are injectable so backoff and breaker
 * recovery are tested deterministically rather than with real waits.
 */
export class Transport {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  public constructor(
    private readonly options: TransportOptions,
    private readonly diagnostics: Diagnostics
  ) {}

  public async send(batch: readonly unknown[]): Promise<void> {
    const now = this.options.now ?? Date.now;

    if (this.openedAt !== null) {
      if (now() - this.openedAt < this.options.breakerCooldownMs) {
        throw new Error("Recorder transport circuit open.");
      }
      // Cooldown elapsed: try again and let the outcome decide.
      this.openedAt = null;
      this.consecutiveFailures = 0;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        await this.options.send(batch);
        this.consecutiveFailures = 0;
        this.diagnostics.recordSent(batch.length);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxAttempts) await this.backoff(attempt);
      }
    }

    this.consecutiveFailures += 1;
    this.diagnostics.report({
      kind: "transport_error",
      reason: lastError instanceof Error ? lastError.message : String(lastError)
    });

    if (this.consecutiveFailures >= this.options.breakerThreshold) {
      this.openedAt = now();
      this.diagnostics.report({ kind: "breaker_open", reason: "consecutive failures" });
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async backoff(attempt: number): Promise<void> {
    const random = this.options.random ?? Math.random;
    const sleep =
      this.options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));

    const capped = Math.min(
      this.options.baseBackoffMs * 2 ** (attempt - 1),
      this.options.maxBackoffMs
    );
    // Full jitter: without it, every client that failed together retries
    // together and the server sees the same thundering herd repeatedly.
    await sleep(Math.floor(random() * capped));
  }
}
