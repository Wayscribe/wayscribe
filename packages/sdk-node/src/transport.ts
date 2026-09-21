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
  /**
   * Events of this request the reply gave no verdict for, already reported as
   * `dropped` with `no_verdict`. An attempt gave a verdict when this is less
   * than the number of events it sent (ADR-063).
   */
  noVerdict: number;
  /** The server's reason for the last transient refusal, for diagnostics. */
  reason?: string;
  /** The same refusal without the server's message, for the console. */
  logReason?: string;
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
  /**
   * How long an event may go on being refused for now before it is given up,
   * measured from its first refusal.
   */
  retryBudgetMs: number;
  /** The most logical sends a tracked refused event may participate in. */
  maxRefusedSends: number;
  /**
   * True once the owner has given up on everything in flight, at shutdown.
   * A send checks it between attempts and hands its events back rather than
   * counting a failure it caused itself.
   */
  isAbandoned?: () => boolean;
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
 * Thrown when the owner abandoned the send, carrying the events it had not
 * settled. The owner counts those; the transport reports nothing for them.
 */
export class AbandonedError extends UnsentError {
  public constructor(unsent: readonly unknown[]) {
    super("The recorder shut down before these events were delivered.", unsent);
    this.name = "AbandonedError";
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
   * When each refused event was first refused, and how many logical sends it
   * participated in from that point, kept across requeues.
   *
   * By time, because a refusal for now usually means the database is
   * restarting or overloaded, which takes seconds: three refusals inside the
   * few hundred milliseconds of one send's backoff dropped events that a
   * retry five seconds later would have stored. The send cap stops an event
   * that is refused in every batch of a busy stream from riding along for the
   * whole budget. Weak, so an event stored or given up on costs nothing.
   */
  private readonly refusals = new WeakMap<object, Refusal>();

  public constructor(
    private readonly options: TransportOptions,
    private readonly diagnostics: Diagnostics
  ) {}

  /**
   * True while the breaker would refuse a send without trying: it is open and
   * its cooldown has not elapsed. Reading it changes nothing.
   *
   * For the recorder's background flushes. A send started now would only throw,
   * after taking a batch off the queue and before putting it back, which is
   * work in the calling process for nothing (measured on 2026-09-16: with the
   * endpoint refusing connections, every recorded event started one).
   */
  public isOpen(): boolean {
    if (this.openedAt === null) return false;
    const now = this.options.now ?? Date.now;
    return now() - this.openedAt < this.options.breakerCooldownMs;
  }

  public async send(batch: readonly unknown[]): Promise<void> {
    // Nothing to send is not a send: it neither counts toward the breaker nor
    // resets it (ADR-063). flush never sends one, and the rule does not rely
    // on that.
    if (batch.length === 0) return;
    const now = this.options.now ?? Date.now;

    if (this.openedAt !== null) {
      if (now() - this.openedAt < this.options.breakerCooldownMs) {
        throw new Error("Recorder transport circuit open.");
      }
      // Cooldown elapsed. Clear the old failure run only if this send reaches
      // actual HTTP work; an expiry-only cycle is not a send to the breaker.
    }

    let pending: readonly unknown[] = batch;
    const abandoned: unknown[] = [];
    const participated = new Set<object>();
    let attempted = false;
    let storedAny = false;
    /**
     * Whether any attempt of this send got a verdict for at least one event:
     * accepted, refused for good, or refused for now. A send in which none
     * did counts toward the breaker even when nothing is left unsent, because
     * a collector that answers 2xx with the wrong body loses every event it
     * is sent (F-048, ADR-063, SDK-65).
     */
    let answered = false;
    let lastError: unknown = undefined;
    let lastRefusal = "The server could not store an event.";
    let lastRefusalLine = lastRefusal;

    for (let attempt = 1; attempt <= this.options.maxAttempts && pending.length > 0; attempt += 1) {
      // Before every attempt after the first, which only happens after one
      // that failed or left events refused.
      if (attempt > 1) await this.backoff(attempt - 1);
      if (this.options.isAbandoned?.() === true) {
        this.giveUp(abandoned, lastRefusal, lastRefusalLine);
        throw new AbandonedError(pending);
      }
      pending = pending.filter((event) => {
        if (typeof event !== "object" || event === null) return true;
        const refusal = this.refusals.get(event);
        if (refusal === undefined || now() - refusal.firstAt < this.options.retryBudgetMs) {
          return true;
        }
        abandoned.push(event);
        return false;
      });
      if (pending.length === 0) break;
      if (this.openedAt !== null) {
        this.openedAt = null;
        this.consecutiveFailures = 0;
      }
      attempted = true;
      for (const event of pending) {
        if (typeof event === "object" && event !== null) participated.add(event);
      }
      try {
        const outcome = await this.options.send(pending);
        lastError = undefined;
        // `accepted`, not `batch.length`. Counting the batch would report a
        // clean bill of health for events the server threw away.
        this.diagnostics.recordSent(outcome.accepted);
        if (outcome.accepted > 0) storedAny = true;
        if (outcome.noVerdict < pending.length) answered = true;
        if (outcome.reason !== undefined) lastRefusal = outcome.reason;
        if (outcome.logReason !== undefined) lastRefusalLine = outcome.logReason;

        // Only the refused events go again. The stored ones are done.
        const again: unknown[] = [];
        for (const event of outcome.retry) {
          const refusal = this.refusalOf(event, now());
          if (refusal === undefined || now() - refusal.firstAt >= this.options.retryBudgetMs) {
            abandoned.push(event);
          } else {
            again.push(event);
          }
        }
        pending = again;
      } catch (error) {
        // An abort the owner caused is not a transport failure.
        if (this.options.isAbandoned?.() === true) {
          this.giveUp(abandoned, lastRefusal, lastRefusalLine);
          throw new AbandonedError(pending);
        }
        // A permanent failure is not retried and does not count toward the
        // breaker: the batch is unsendable, and pretending otherwise turns one
        // bad payload into total loss.
        if (isPermanent(error)) {
          // One per event, so `rejected` counts events as it does for a
          // per-event refusal, and sent, rejected, and dropped add up to what
          // was recorded.
          const httpStatus = statusOf(error);
          for (const _event of pending) {
            this.diagnostics.report({
              kind: "rejected",
              code: "request_refused",
              reason: error instanceof Error ? error.message : String(error),
              detail: {
                events: pending.length,
                ...(httpStatus === undefined ? {} : { httpStatus })
              }
            });
          }
          this.giveUp(abandoned, lastRefusal, lastRefusalLine);
          return;
        }
        lastError = error;
      }
    }

    // Still refused after this send's attempts: requeued for a later send
    // unless this was the last send it was allowed.
    pending = pending.filter((event) => {
      if (typeof event !== "object" || event === null || !participated.has(event)) return true;
      const refusal = this.refusals.get(event);
      if (refusal === undefined) return true;
      refusal.sends += 1;
      if (refusal.sends < this.options.maxRefusedSends) return true;
      abandoned.push(event);
      return false;
    });

    if (pending.length === 0 && abandoned.length === 0) {
      // A send in which no attempt got a verdict for any event: its events
      // are reported as dropped with no_verdict already, so no transport
      // error, but it is a failure toward the breaker. Only a send that
      // stored something or got at least one verdict resets the count.
      if (!storedAny && !answered) {
        this.countFailure(now());
        return;
      }
      this.consecutiveFailures = 0;
      return;
    }

    this.diagnostics.report(
      {
        kind: "transport_error",
        code: lastError === undefined ? "refused_for_now" : "request_failed",
        reason: lastError === undefined ? lastRefusal : messageOf(lastError),
        detail: { unsent: pending.length, abandoned: abandoned.length }
      },
      lastError === undefined ? lastRefusalLine : undefined
    );
    this.giveUp(abandoned, lastRefusal, lastRefusalLine);

    // A server that stored something is up, even if it could not store every
    // event. Counting one unstorable event toward the breaker would let it
    // stop delivery of everything else for the cooldown, again and again.
    if (storedAny) {
      this.consecutiveFailures = 0;
    } else if (attempted) {
      this.countFailure(now());
    }

    if (pending.length === 0) return;
    throw new UnsentError(lastError === undefined ? lastRefusal : messageOf(lastError), pending);
  }

  /** One more send failed in a row; at the threshold the breaker opens. */
  private countFailure(at: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.options.breakerThreshold) return;
    this.openedAt = at;
    this.diagnostics.report({
      kind: "breaker_opened",
      code: "consecutive_failures",
      reason: `${String(this.consecutiveFailures)} sends failed in a row, so sending pauses for ${String(Math.round(this.options.breakerCooldownMs / 1_000))} seconds.`,
      detail: {
        failures: this.consecutiveFailures,
        cooldownMs: this.options.breakerCooldownMs
      }
    });
  }

  /**
   * The event's refusal record, started at `at` if this is its first refusal.
   * Undefined for anything but an object, which cannot be tracked and so is
   * given up on rather than retried without a bound.
   */
  private refusalOf(event: unknown, at: number): Refusal | undefined {
    if (typeof event !== "object" || event === null) return undefined;
    let refusal = this.refusals.get(event);
    if (refusal === undefined) {
      refusal = { firstAt: at, sends: 0 };
      this.refusals.set(event, refusal);
    }
    return refusal;
  }

  /**
   * Events the server went on refusing past their bounds. Lost, so counted as
   * dropped: that counter is the one OPERATIONS.md tells an operator means
   * events were shed.
   */
  private giveUp(events: readonly unknown[], reason: string, logReason: string): void {
    const bounds = `within ${String(Math.round(this.options.retryBudgetMs / 1_000))} seconds or ${String(this.options.maxRefusedSends)} sends`;
    for (const _event of events) {
      this.diagnostics.report(
        {
          kind: "dropped",
          code: "retry_budget",
          reason: `The server could not store an event ${bounds}: ${reason}`,
          detail: {}
        },
        `The server could not store an event ${bounds}: ${logReason}`
      );
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

interface Refusal {
  firstAt: number;
  sends: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The response status the sender attached to a refused request, if any. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === "number" ? status : undefined;
}

/** Marked by the sender when the server refused the batch outright. */
function isPermanent(error: unknown): boolean {
  return (error as { permanent?: boolean } | null)?.permanent === true;
}
