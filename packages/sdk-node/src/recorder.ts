import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  checkLimits,
  redact,
  toStorable
} from "@flight-recorder/payload-security/redaction";
import { resolveConfig, type RecorderConfig } from "./config.js";
import { createDiagnostics, type Counters, type Diagnostics } from "./diagnostics.js";
import type { Operation } from "./operations.js";
import {
  extractHttpContext,
  fromQueueAttributes,
  injectHttpHeaders,
  toQueueAttributes,
  unwrapPayload,
  wrapPayload,
  type PropagatedContext
} from "./propagation.js";
import { BoundedQueue } from "./queue.js";
import { safely, safelyAsync } from "./safely.js";
import { createTraceReader } from "./trace.js";
import { Transport } from "./transport.js";

export interface JourneyContext {
  journeyId: string;
  entity: { type: string; id: string };
}

export interface RecordInput {
  /**
   * One of the eleven operations the server accepts.
   *
   * A union rather than `string`: anything else is refused at ingestion, and a
   * refused event leaves a timeline that is not empty but wrong.
   */
  operation: Operation;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string; type?: string; code?: string };
  aliases?: Record<string, string>;
  metadata?: Record<string, unknown>;
  durationMs?: number;
  /**
   * When the operation began, in epoch milliseconds. Defaults to now.
   *
   * The wrappers set this to the moment the callback started, because the
   * timeline orders by timestamp and a step must not sort after the work it
   * caused.
   */
  startedAt?: number;
}

export interface WrapOptions {
  /** Marks a result that did not throw but represents a failure, e.g. HTTP 422. */
  isFailure?: (result: unknown) => boolean;
  /** 1 for a first attempt. Anything higher records `retried` (ADR-022). */
  attempt?: number;
  metadata?: Record<string, unknown>;
}

export interface Journey {
  context(): JourneyContext;
  record(input: RecordInput): void;
  identify(aliases: Record<string, string>): void;
  transform<T>(
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  persist<T>(
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  publish<T>(
    name: string,
    message: unknown,
    fn: () => T | Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  deliver<T>(
    name: string,
    payload: unknown,
    fn: () => T | Promise<T>,
    options?: WrapOptions
  ): Promise<T>;
  fail(name: string, error: unknown, metadata?: Record<string, unknown>): void;
  finish(options?: { status?: "completed" | "failed" }): void;
}

export interface Recorder {
  startJourney(options: {
    entity: { type: string; id: string };
    aliases?: Record<string, string>;
  }): Journey;
  continueJourney(context: JourneyContext): Journey;
  consume(options: {
    context?: PropagatedContext | undefined;
    entityFallback?: { type: string; id: string };
  }): Journey;
  injectHttpHeaders(
    headers: Record<string, string>,
    context: PropagatedContext
  ): Record<string, string>;
  extractHttpContext(
    headers: Record<string, string | string[] | undefined> | undefined
  ): PropagatedContext | undefined;
  toQueueAttributes(
    context: PropagatedContext
  ): Record<string, { DataType: string; StringValue: string }>;
  fromQueueAttributes(attributes: unknown): PropagatedContext | undefined;
  wrapPayload(payload: unknown, context: PropagatedContext): { _flight: unknown; data: unknown };
  unwrapPayload(body: unknown): { context?: PropagatedContext; data: unknown };
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<Counters>;
  diagnostics(): Counters;
}

const TOO_LARGE = "[PAYLOAD_TOO_LARGE]";
const UNCAPTURABLE = "[UNCAPTURABLE]";

interface BatchOutcome {
  status: "accepted" | "rejected";
  eventId?: string | null;
  error?: {
    code?: string;
    message?: string;
    httpStatus?: number;
    details?: { path: string; message: string }[];
  };
}

/**
 * How many events the server stored, reporting each refusal on the way.
 *
 * A rejection is permanent — the event was understood and refused — so it is
 * counted separately from a transport failure and never retried. The server's
 * own message is passed through verbatim, because it is far more specific than
 * anything this side could reconstruct: "event.entity.id: expected string,
 * received number" ends the investigation that "invalid_event" begins.
 *
 * A body this cannot parse is treated as full acceptance. The alternative —
 * assuming the worst — would report phantom data loss whenever a proxy rewrote
 * a response, and the request did return 2xx.
 */
function countAccepted(body: unknown, diagnostics: Diagnostics): number {
  const results = (body as { data?: { results?: BatchOutcome[] } } | null)?.data?.results;
  if (!Array.isArray(results)) return 0;

  let accepted = 0;
  for (const result of results) {
    if (result.status === "accepted") {
      accepted += 1;
      continue;
    }

    const where = result.error?.details?.[0];
    const detail = where === undefined ? "" : ` (${where.path}: ${where.message})`;
    diagnostics.report({
      kind: "rejected",
      reason: `${result.error?.code ?? "rejected"}: ${result.error?.message ?? "The server refused this event."}${detail}`,
      detail: result.error
    });
  }
  return accepted;
}

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic);
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
  // Resolved once: record() is synchronous, so this cannot be an async import.
  const readTrace = createTraceReader();
  let stopped = false;

  const transport = new Transport(
    {
      send: async (batch) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, resolved.requestTimeoutMs);
        try {
          const response = await fetch(`${resolved.endpoint}/v1/events/batch`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${resolved.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ events: batch }),
            signal: controller.signal
          });
          if (!response.ok) {
            // A 4xx is permanent: the server understood the request and
            // refused it. Retrying burns three attempts, drives the breaker
            // open, and requeues the batch to the FRONT — so one malformed
            // batch used to block every event behind it for the life of the
            // process. Marked so the transport can tell the two apart.
            const error = new Error(`Ingestion responded ${String(response.status)}.`);
            if (response.status >= 400 && response.status < 500) {
              (error as { permanent?: boolean }).permanent = true;
            }
            throw error;
          }

          // The batch route replies 202 with a per-event verdict, so a request
          // that "succeeded" may have stored nothing. Reading the body is the
          // only way to know, and not reading it is how a misconfigured
          // environment name looked exactly like a healthy recorder.
          return countAccepted(await response.json(), diagnostics);
        } finally {
          clearTimeout(timer);
        }
      },
      maxAttempts: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 2_000,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000
    },
    diagnostics
  );

  /**
   * Capture is synchronous: the application may mutate the object after this
   * returns, and recording values the step never saw would make the diff lie.
   *
   * The size guard bounds the cost, because a server-side limit does not help a
   * host process that has already spent the CPU walking the payload.
   */
  function capture(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (resolved.captureMode === "metadata-only") return undefined;

    // Walking a payload runs the application's own code: `checkLimits` calls
    // Object.values, which invokes every own enumerable getter. A getter that
    // throws — `get total() { return this.lines.reduce(...) }` on an object
    // whose `lines` is undefined — used to escape from inside the event literal,
    // before queue.push, taking the whole event with it. The counters read
    // `dropped: 0` while OPERATIONS.md tells the operator that a non-zero
    // `dropped` is what means events were shed.
    //
    // Degrading to a marker keeps the event, and an event that says its payload
    // was uncapturable is far more useful than no event at all — especially
    // since the step being recorded is often the one that failed.
    try {
      const limits = checkLimits(value, {
        ...DEFAULT_LIMITS,
        maxBytes: resolved.maxPayloadBytes
      });
      if (!limits.ok) return TOO_LARGE;

      // Sanitized last, so redaction markers are untouched and every string
      // that leaves this process is one PostgreSQL will accept.
      return toStorable(redact(value, resolved.redact));
    } catch {
      return UNCAPTURABLE;
    }
  }

  function enqueue(journeyId: string, entity: JourneyContext["entity"], input: RecordInput): void {
    if (stopped) return;

    queue.push({
      protocolVersion: "0.1",
      event: {
        id: `evt_${randomUUID()}`,
        journeyId,
        environment: resolved.environment,
        service: resolved.serviceName,
        entity,
        operation: input.operation,
        name: input.name,
        timestamp: new Date(input.startedAt ?? Date.now()).toISOString(),
        ...(readTrace() ?? {}),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.input === undefined ? {} : { input: capture(input.input) }),
        ...(input.output === undefined ? {} : { output: capture(input.output) }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
        // Through capture like input and output: metadata used to go in raw,
        // so a Prisma BigInt or a circular request object threw inside
        // JSON.stringify at flush time and took the whole batch with it.
        ...(input.metadata === undefined ? {} : { metadata: capture(input.metadata) })
      }
    });

    if (queue.size() >= resolved.batchSize) track(flush());
  }

  /**
   * Flushes started in the background, so `flush()` and `shutdown()` can wait
   * for them.
   *
   * Without this set, `enqueue`'s fire-and-forget flush was unobservable:
   * `shutdown()` drained an already-empty queue, returned immediately, and read
   * the counters before the in-flight send had recorded anything. A run of
   * exactly `batchSize` events reported `sent: 0` while the server held all of
   * them, and `process.exit(0)` straight after `shutdown()` abandoned the batch
   * for real.
   */
  const inFlight = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  }

  /** Waits for every background flush, including ones started by those flushes. */
  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  async function flush(): Promise<void> {
    const batch = queue.drain(resolved.batchSize);
    if (batch.length === 0) return;
    try {
      await transport.send(batch);
    } catch {
      // Ordering matters: a retried batch must not reorder the timeline.
      queue.requeue(batch);
    }
  }

  /**
   * Drains everything currently queued, not just one batch.
   *
   * Stops as soon as a pass makes no progress. A failed send requeues its
   * batch, so looping on `size > 0` alone spins forever against an endpoint
   * that is refusing connections — which is precisely the situation where the
   * SDK must not hold the host process.
   */
  async function drainAll(): Promise<void> {
    let previous = Number.POSITIVE_INFINITY;
    while (queue.size() > 0 && queue.size() < previous) {
      previous = queue.size();
      await flush();
    }
    await settle();
  }

  const interval = setInterval(() => track(flush()), resolved.flushIntervalMs);
  // Never hold the host's event loop open on our account.
  interval.unref();

  function toErrorRecord(error: unknown): { message: string; type?: string; code?: string } {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return {
        message: error.message,
        type: error.name,
        ...(typeof code === "string" ? { code } : {})
      };
    }
    return { message: String(error) };
  }

  /**
   * One implementation behind all the public wrappers, so the contract cannot
   * drift between them.
   *
   * Returns the callback's value unchanged and rethrows its exact error object.
   * Everything the recorder does sits inside `safely`, so a recording failure
   * cannot reach the caller.
   */
  async function wrap<T>(
    context: JourneyContext,
    naturalOperation: Operation,
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options: WrapOptions = {}
  ): Promise<T> {
    const startedAt = Date.now();
    const attempt = options.attempt ?? 1;
    // ADR-022: a retry records as `retried` rather than the natural verb.
    const operation = attempt > 1 ? "retried" : naturalOperation;
    const metadata =
      options.metadata === undefined && attempt === 1
        ? undefined
        : { ...options.metadata, attempt };

    let result: T;
    try {
      result = await fn();
    } catch (error) {
      safely(diagnostics, "capture_error", () => {
        enqueue(context.journeyId, context.entity, {
          operation,
          name,
          input,
          startedAt,
          durationMs: Date.now() - startedAt,
          error: toErrorRecord(error),
          ...(metadata === undefined ? {} : { metadata })
        });
      });
      // The original object, not a copy: application code branches on instanceof
      // and on custom properties.
      throw error;
    }

    safely(diagnostics, "capture_error", () => {
      const failed = options.isFailure === undefined ? false : options.isFailure(result);
      enqueue(context.journeyId, context.entity, {
        operation,
        name,
        input,
        output: result,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(failed
          ? { error: { message: `${name} reported a failed result.`, code: "result_failed" } }
          : {}),
        ...(metadata === undefined ? {} : { metadata })
      });
    });

    return result;
  }

  function makeJourney(context: JourneyContext): Journey {
    return {
      context: () => context,
      record(input) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, input);
        });
      },
      identify(aliases) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "identified",
            name: "identify",
            // Top-level, not under metadata: EVENT_PROTOCOL puts aliases on the
            // event itself, and ingestion reads them from there. Nested, they
            // are accepted and then ignored, costing every alias-based search.
            aliases
          });
        });
      },
      transform: (name, input, fn, options) =>
        wrap(context, "transformed", name, input, fn, options),
      persist: (name, input, fn, options) => wrap(context, "persisted", name, input, fn, options),
      publish: (name, message, fn, options) =>
        wrap(context, "published", name, message, fn, options),
      deliver: (name, payload, fn, options) =>
        wrap(context, "delivered", name, payload, fn, options),
      fail(name, error, metadata) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "failed",
            name,
            error: toErrorRecord(error),
            ...(metadata === undefined ? {} : { metadata })
          });
        });
      },
      finish(options) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: options?.status === "failed" ? "failed" : "completed",
            name: "finish"
          });
        });
      }
    };
  }

  return {
    startJourney(options) {
      const context = safely(diagnostics, "capture_error", () => ({
        journeyId: `jrn_${randomUUID()}`,
        entity: options.entity
      }));

      const journey = makeJourney(
        context ?? { journeyId: `jrn_${randomUUID()}`, entity: { type: "unknown", id: "unknown" } }
      );
      if (options.aliases !== undefined) journey.identify(options.aliases);
      return journey;
    },
    continueJourney: (context) => makeJourney(context),
    // At the default propagation level the journey ID crosses the boundary and
    // the entity does not, so the consumer supplies the entity it already has
    // from the message body.
    consume: (options) =>
      makeJourney({
        journeyId: options.context?.journeyId ?? `jrn_${randomUUID()}`,
        entity: options.context?.entity ??
          options.entityFallback ?? { type: "unknown", id: "unknown" }
      }),
    injectHttpHeaders: (headers, context) =>
      injectHttpHeaders(headers, context, resolved.propagate),
    extractHttpContext,
    toQueueAttributes: (context) => toQueueAttributes(context, resolved.propagate),
    fromQueueAttributes,
    wrapPayload: (payload, context) => wrapPayload(payload, context, resolved.propagate),
    unwrapPayload,
    async flush() {
      await safelyAsync(diagnostics, "transport_error", drainAll);
    },
    async shutdown(options) {
      stopped = true;
      clearInterval(interval);
      const timeoutMs = options?.timeoutMs ?? 2_000;
      // Never hang: a process that cannot exit because of a telemetry library is
      // the same failure ADR-007 forbids, arriving later.
      await Promise.race([
        safelyAsync(diagnostics, "transport_error", drainAll),
        new Promise((resolve) => {
          setTimeout(resolve, timeoutMs);
        })
      ]);
      // Read after the race, so the counters describe what actually landed.
      return diagnostics.counters();
    },
    diagnostics: () => diagnostics.counters()
  };
}
