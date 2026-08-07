import { createRequire } from "node:module";

export interface TraceContext {
  traceId: string;
  spanId: string;
}

interface OtelApi {
  trace: { getActiveSpan: () => { spanContext: () => TraceContext } | undefined };
}

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/**
 * Read trace context from OpenTelemetry when it happens to be present.
 *
 * Resolution runs once, here, rather than on every record: `record()` is
 * synchronous, so an async dynamic import cannot be used at record time.
 *
 * An absent package, an absent active span, and a throwing OpenTelemetry
 * implementation all degrade to no trace context. ADR-010 makes this optional
 * interoperability, so none of those is an error condition.
 */
export function createTraceReader(
  resolve?: () => OtelApi | undefined
): () => TraceContext | undefined {
  let api: OtelApi | undefined;

  try {
    api = resolve === undefined ? defaultResolve() : resolve();
  } catch {
    api = undefined;
  }

  if (api === undefined) return (): undefined => undefined;
  const resolved = api;

  return () => {
    try {
      const context = resolved.trace.getActiveSpan()?.spanContext();
      if (context === undefined) return undefined;
      // OpenTelemetry uses all-zero IDs for an invalid span; recording those
      // would put meaningless identifiers on every event.
      if (context.traceId === INVALID_TRACE_ID || context.spanId === INVALID_SPAN_ID) {
        return undefined;
      }
      return { traceId: context.traceId, spanId: context.spanId };
    } catch {
      return undefined;
    }
  };
}

function defaultResolve(): OtelApi | undefined {
  const require = createRequire(import.meta.url);
  return require("@opentelemetry/api") as OtelApi;
}
