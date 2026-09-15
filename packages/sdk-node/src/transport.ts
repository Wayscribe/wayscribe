import type { Diagnostics } from "./diagnostics.js";

/** What the server did with one request's events. */
export interface SendOutcome {
  /** Stored, including duplicates of events stored before. */
  accepted: number;
  /**
   * Events the server refused for now, with a per-event status of 500 or more:
   * it understood them and could not store them, which may not be true of a
   * later attempt. Permanent refusals are reported by the sender and are not
   * here.
   */
  retry: readonly unknown[];
  /** The server's reason for the last transient refusal, for diagnostics. */
  reason?: string;
}

export interface TransportOptions {
  /**
   * Delivers a batch and says what the server stored.
   *
   * Returning a count rather than void is the whole point: the ingestion route
   * replies 202 for a batch in which every event was refused, so "the request
   * succeeded" and "the events were stored" are different facts and only the
   * body distinguishes them.
   */
  send: (batch: readonly unknown[]) => Promise<SendOutcome>;
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
 * Thrown when a send ends with events still unsent, carrying exactly those.
 *
 * Without it the caller could only requeue the whole batch, so events the
 * server had already stored on an earlier attempt would be sent again and
 * counted as sent twice.
 */
export class UnsentError extends Error {
  public constructor(
    message: string,
    public readonly unsent: readonly unknown[]
  ) {
    super(message);
    this.name = "UnsentError";
  }
}

/**
 * Retrying transport with a circuit breaker.
 *
 * Retries reuse the caller's events unchanged, so the client-generated event
 * IDs make a duplicate delivery harmless under Phase 1b's idempotency.
 *
 * The clock, sleep, and jitter source are injectable so backoff and breaker
 * recovery are tested deterministically rather than with real waits.
 */
export class Transport {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  /**
   * Transient refusals per event, kept across sends.
   *
   * Per event rather than per send, because a send that ends in a connection
   * failure hands its events back for requeueing, and a fresh count on every
   * requeue would let an event the server can never store be retried for the
   * life of the process. Weak, so an event given up on or stored costs nothing.
   */
  private readonly refusals = new WeakMap<object, number>();

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

    let pending: readonly unknown[] = batch;
    const abandoned: unknown[] = [];
    let storedAny = false;
    let lastError: unknown = undefined;
    let lastRefusal = "The server could not store an event.";

    for (let attempt = 1; attempt <= this.options.maxAttempts && pending.length > 0; attempt += 1) {
      // Before every attempt after the first, which only happens after one
      // that failed or left events refused.
      if (attempt > 1) await this.backoff(attempt - 1);
      try {
        const outcome = await this.options.send(pending);
        lastError = undefined;
        // `accepted`, not `batch.length`. Counting the batch would report a
        // clean bill of health for events the server threw away.
        this.diagnostics.recordSent(outcome.accepted);
        if (outcome.accepted > 0) storedAny = true;
        if (outcome.reason !== undefined) lastRefusal = outcome.reason;

        // Only the refused events go again. The stored ones are done.
        const again: unknown[] = [];
        for (const event of outcome.retry) {
          if (this.refuse(event) >= this.options.maxAttempts) abandoned.push(event);
          else again.push(event);
        }
        pending = again;
      } catch (error) {
        // A permanent failure is not retried and does not count toward the
        // breaker: the batch is unsendable, and pretending otherwise turns one
        // bad payload into total loss.
        if (isPermanent(error)) {
          this.diagnostics.report({
            kind: "rejected",
            reason: error instanceof Error ? error.message : String(error),
            detail: { permanent: true, events: pending.length }
          });
          this.giveUp(abandoned, lastRefusal);
          return;
        }
        lastError = error;
      }
    }

    if (pending.length === 0 && abandoned.length === 0) {
      this.consecutiveFailures = 0;
      return;
    }

    this.diagnostics.report({
      kind: "transport_error",
      reason: lastError === undefined ? lastRefusal : messageOf(lastError),
      detail: { unsent: pending.length, abandoned: abandoned.length }
    });
    this.giveUp(abandoned, lastRefusal);

    // A server that stored something is up, even if it could not store every
    // event. Counting one unstorable event toward the breaker would let it
    // stop delivery of everything else for the cooldown, again and again.
    if (storedAny) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.breakerThreshold) {
        this.openedAt = now();
        this.diagnostics.report({ kind: "breaker_open", reason: "consecutive failures" });
      }
    }

    if (pending.length === 0) return;
    throw new UnsentError(lastError === undefined ? lastRefusal : messageOf(lastError), pending);
  }

  /** Counts a transient refusal and returns the event's total so far. */
  private refuse(event: unknown): number {
    // Anything but an object cannot be tracked, so it gets one attempt rather
    // than an unbounded number.
    if (typeof event !== "object" || event === null) return this.options.maxAttempts;
    const count = (this.refusals.get(event) ?? 0) + 1;
    this.refusals.set(event, count);
    return count;
  }

  /**
   * Events refused transiently on every attempt they were allowed. Lost, so
   * counted as dropped: that counter is the one OPERATIONS.md tells an operator
   * means events were shed.
   */
  private giveUp(events: readonly unknown[], reason: string): void {
    for (const _event of events) {
      this.diagnostics.report({
        kind: "dropped",
        reason: `The server could not store an event after ${String(this.options.maxAttempts)} attempts: ${reason}`
      });
    }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marked by the sender when the server refused the batch outright. */
function isPermanent(error: unknown): boolean {
  return (error as { permanent?: boolean } | null)?.permanent === true;
}
