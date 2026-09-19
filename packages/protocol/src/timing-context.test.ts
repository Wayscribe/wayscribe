import { describe, expect, it } from "vitest";
import { journeyEventSchema } from "./event.js";
import { timingContext } from "./timing-context.js";

const MAX_MS = 2_147_483_647;

describe("timingContext", () => {
  it("projects every recognized timing field and ignores unrelated metadata", () => {
    expect(
      timingContext({
        queue: "customer-updates",
        queueWaitMs: 120,
        queueWaitBasis: "retry-ready",
        deliveryCount: 3,
        targetHost: "api.example.test:8443",
        httpStatusCode: 429,
        retryAfterMs: 2_000,
        attempt: 2,
        retryGroup: 'queue:["customer-updates","job-42"]',
        sourceSystem: "crm"
      })
    ).toEqual({
      queue: "customer-updates",
      queueWaitMs: 120,
      queueWaitBasis: "retry-ready",
      deliveryCount: 3,
      targetHost: "api.example.test:8443",
      httpStatusCode: 429,
      retryAfterMs: 2_000,
      attempt: 2,
      retryGroup: 'queue:["customer-updates","job-42"]'
    });
  });

  it("keeps measured zero and the inclusive millisecond bounds", () => {
    expect(
      timingContext({
        queueWaitMs: 0,
        queueWaitBasis: "initial-enqueue",
        retryAfterMs: 0,
        attempt: 1
      })
    ).toEqual({
      queueWaitMs: 0,
      queueWaitBasis: "initial-enqueue",
      retryAfterMs: 0,
      attempt: 1
    });
    expect(
      timingContext({
        queueWaitMs: MAX_MS,
        queueWaitBasis: "retry-ready",
        retryAfterMs: MAX_MS,
        attempt: Number.MAX_SAFE_INTEGER
      })
    ).toEqual({
      queueWaitMs: MAX_MS,
      queueWaitBasis: "retry-ready",
      retryAfterMs: MAX_MS,
      attempt: Number.MAX_SAFE_INTEGER
    });
  });

  it("omits unknown, negative, fractional, non-finite, and out-of-range numbers instead of making them zero", () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MS + 1, "0", null]) {
      expect(timingContext({ retryAfterMs: value })).toEqual({});
    }
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(timingContext({ attempt: value })).toEqual({});
      expect(timingContext({ deliveryCount: value })).toEqual({});
    }
    for (const value of [99, 600, 200.5, Number.NaN, "429", null]) {
      expect(timingContext({ httpStatusCode: value })).toEqual({});
    }
  });

  it("requires a wait basis consistent with the recorded attempt", () => {
    expect(
      timingContext({ queueWaitMs: 40, queueWaitBasis: "initial-enqueue", attempt: 1 })
    ).toEqual({ queueWaitMs: 40, queueWaitBasis: "initial-enqueue", attempt: 1 });
    expect(timingContext({ queueWaitMs: 40, queueWaitBasis: "retry-ready", attempt: 2 })).toEqual({
      queueWaitMs: 40,
      queueWaitBasis: "retry-ready",
      attempt: 2
    });

    for (const metadata of [
      { queueWaitMs: 40, queueWaitBasis: "initial-enqueue", attempt: 2 },
      { queueWaitMs: 40, queueWaitBasis: "retry-ready", attempt: 1 },
      { queueWaitMs: 40, queueWaitBasis: "initial-enqueue" },
      { queueWaitMs: 40, attempt: 1 },
      { queueWaitBasis: "initial-enqueue", attempt: 1 },
      { queueWaitMs: 40, queueWaitBasis: "redacted", attempt: 1 }
    ]) {
      expect(timingContext({ queue: "orders", ...metadata })).toEqual({
        queue: "orders",
        ...(metadata.attempt === undefined ? {} : { attempt: metadata.attempt })
      });
    }
  });

  it("validates each field independently, including a field whose getter throws", () => {
    const metadata = Object.defineProperty(
      {
        queue: "orders",
        retryAfterMs: 250,
        attempt: 2,
        httpStatusCode: 700
      },
      "deliveryCount",
      {
        enumerable: true,
        get: () => {
          throw new Error("unreadable delivery count");
        }
      }
    );

    expect(timingContext(metadata)).toEqual({
      queue: "orders",
      retryAfterMs: 250,
      attempt: 2
    });
  });

  it("bounds queue, target host, and retry identity by Unicode code points", () => {
    const clef = "\u{1D11E}";
    const validTargetHost = `${"a.".repeat(126)}abc`;
    expect(
      timingContext({
        queue: clef.repeat(256),
        targetHost: validTargetHost,
        retryGroup: clef.repeat(256)
      })
    ).toEqual({
      queue: clef.repeat(256),
      targetHost: validTargetHost,
      retryGroup: clef.repeat(256)
    });
    expect(
      timingContext({
        queue: clef.repeat(257),
        targetHost: `${"a.".repeat(127)}abc`,
        retryGroup: clef.repeat(257),
        retryAfterMs: 1
      })
    ).toEqual({ retryAfterMs: 1 });
  });

  it("does not treat redaction or capture markers as queue, host, or retry identity", () => {
    for (const marker of [
      "[REDACTED]",
      "[UNCAPTURABLE]",
      "[PAYLOAD_TOO_LARGE]",
      "[CIRCULAR]",
      "[TRUNCATED: 12 characters removed]"
    ]) {
      expect(
        timingContext({
          queue: marker,
          targetHost: marker,
          retryGroup: marker,
          retryAfterMs: 0
        })
      ).toEqual({ retryAfterMs: 0 });
    }
  });

  it("does not treat a retained prefix plus truncation marker as identity", () => {
    const truncated = "job-prefix[TRUNCATED: 12 characters removed]";
    expect(
      timingContext({
        queue: truncated,
        targetHost: truncated,
        retryGroup: truncated,
        retryAfterMs: 0
      })
    ).toEqual({ retryAfterMs: 0 });
  });

  it("accepts only a hostname with an optional port as targetHost", () => {
    expect(timingContext({ targetHost: "[2001:db8::1]:8443" })).toEqual({
      targetHost: "[2001:db8::1]:8443"
    });
    for (const targetHost of [
      "",
      "https://api.example.test",
      "user:secret@api.example.test",
      "api.example.test/",
      "api.example.test?",
      "api.example.test#",
      "api.example.test/path",
      "api.example.test?token=x",
      "api.example.test#part",
      "api.exa\nmple.test",
      "api.exa\tmple.test",
      "api.example.test\\",
      "api.example.test:99999"
    ]) {
      expect(timingContext({ targetHost, attempt: 1 })).toEqual({ attempt: 1 });
    }
  });

  it("returns an empty object for non-record metadata and does not mutate its input", () => {
    for (const metadata of [
      undefined,
      null,
      1,
      "metadata",
      [],
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("revoked");
          }
        }
      )
    ]) {
      expect(timingContext(metadata)).toEqual({});
    }
    const metadata = {
      queue: "orders",
      queueWaitMs: 4,
      queueWaitBasis: "initial-enqueue",
      attempt: 1,
      nested: { untouched: true }
    };
    const before = structuredClone(metadata);
    timingContext(metadata);
    expect(metadata).toEqual(before);
  });

  it("projects only own stored JSON fields", () => {
    const inherited = Object.create({
      queue: "prototype-queue",
      attempt: 2,
      retryGroup: "prototype-group"
    }) as Record<string, unknown>;
    inherited.retryAfterMs = 0;
    expect(timingContext(inherited)).toEqual({ retryAfterMs: 0 });
  });

  it("does not narrow arbitrary metadata wire acceptance", () => {
    const metadata = {
      queueWaitMs: -1,
      queueWaitBasis: "unknown-basis",
      retryGroup: "[REDACTED]",
      applicationField: { any: "shape" }
    };
    const parsed = journeyEventSchema.safeParse({
      id: "evt_01",
      journeyId: "jrn_01",
      environment: "development",
      service: "worker",
      entity: { type: "order", id: "42" },
      operation: "consumed",
      name: "take-order",
      timestamp: "2026-09-18T12:00:00.000Z",
      metadata
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.metadata).toEqual(metadata);
    expect(timingContext(parsed.data?.metadata)).toEqual({});
  });
});
