import { describe, expect, it } from "vitest";
import { createTraceReader } from "./trace.js";

describe("createTraceReader", () => {
  it("returns no context when OpenTelemetry is not installed", () => {
    // ADR-010: OpenTelemetry is optional interoperability, not a dependency.
    // The package is genuinely absent here, which is the case that must not throw.
    const read = createTraceReader();
    expect(read()).toBeUndefined();
  });

  it("never throws when the resolver itself fails", () => {
    const read = createTraceReader(() => {
      throw new Error("resolution exploded");
    });
    expect(() => read()).not.toThrow();
    expect(read()).toBeUndefined();
  });

  it("reads traceId and spanId from an active span", () => {
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({ traceId: "abc123", spanId: "def456" })
        })
      }
    }));
    expect(read()).toEqual({ traceId: "abc123", spanId: "def456" });
  });

  it("returns no context when there is no active span", () => {
    const read = createTraceReader(() => ({ trace: { getActiveSpan: () => undefined } }));
    expect(read()).toBeUndefined();
  });

  it("never throws when the OpenTelemetry implementation throws", () => {
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => {
          throw new Error("otel exploded");
        }
      }
    }));
    expect(() => read()).not.toThrow();
    expect(read()).toBeUndefined();
  });

  it("ignores an all-zero span context", () => {
    // OpenTelemetry uses all-zero IDs for an invalid span; recording them would
    // put meaningless identifiers on every event.
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) })
        })
      }
    }));
    expect(read()).toBeUndefined();
  });
});
