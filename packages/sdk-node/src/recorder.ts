import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, checkLimits, redact } from "@flight-recorder/payload-security/redaction";
import { resolveConfig, type RecorderConfig } from "./config.js";
import { createDiagnostics, type Counters } from "./diagnostics.js";
import { BoundedQueue } from "./queue.js";
import { safely, safelyAsync } from "./safely.js";
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

export interface Journey {
  context(): JourneyContext;
  record(input: RecordInput): void;
  identify(aliases: Record<string, string>): void;
}

export interface Recorder {
  startJourney(options: {
    entity: { type: string; id: string };
    aliases?: Record<string, string>;
  }): Journey;
  continueJourney(context: JourneyContext): Journey;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<Counters>;
  diagnostics(): Counters;
}

const TOO_LARGE = "[PAYLOAD_TOO_LARGE]";

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic);
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
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
