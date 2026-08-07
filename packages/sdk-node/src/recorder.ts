import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, checkLimits, redact } from "@flight-recorder/payload-security/redaction";
import { resolveConfig, type RecorderConfig } from "./config.js";
import { createDiagnostics, type Counters } from "./diagnostics.js";
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
  operation: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string; type?: string; code?: string };
  metadata?: Record<string, unknown>;
  durationMs?: number;
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
          if (!response.ok) throw new Error(`Ingestion responded ${String(response.status)}.`);
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

    const limits = checkLimits(value, {
      ...DEFAULT_LIMITS,
      maxBytes: resolved.maxPayloadBytes
    });
    if (!limits.ok) return TOO_LARGE;

    return redact(value, resolved.redact);
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
        timestamp: new Date().toISOString(),
        ...(readTrace() ?? {}),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.input === undefined ? {} : { input: capture(input.input) }),
        ...(input.output === undefined ? {} : { output: capture(input.output) }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata })
      }
    });

    if (queue.size() >= resolved.batchSize) void flush();
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

  const interval = setInterval(() => void flush(), resolved.flushIntervalMs);
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
    naturalOperation: string,
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
            metadata: { aliases }
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
      await safelyAsync(diagnostics, "transport_error", flush);
    },
    async shutdown(options) {
      stopped = true;
      clearInterval(interval);
      const timeoutMs = options?.timeoutMs ?? 2_000;
      // Never hang: a process that cannot exit because of a telemetry library is
      // the same failure ADR-007 forbids, arriving later.
      await Promise.race([
        safelyAsync(diagnostics, "transport_error", flush),
        new Promise((resolve) => {
          setTimeout(resolve, timeoutMs);
        })
      ]);
      return diagnostics.counters();
    },
    diagnostics: () => diagnostics.counters()
  };
}
