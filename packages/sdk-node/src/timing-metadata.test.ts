import { describe, expect, it } from "vitest";
import {
  httpMetadata,
  queueMetadata,
  type HttpMetadataOptions,
  type HttpMetadataResponse,
  type HttpTimingMetadata,
  type QueueMetadataJob,
  type QueueMetadataOptions,
  type QueueTimingMetadata
} from "./index.js";

const MAX_MS = 2_147_483_647;

describe("queueMetadata", () => {
  it("exposes structural public input and output types", () => {
    const job = { queueName: "orders", attemptsMade: 0 } satisfies QueueMetadataJob;
    const options = { deliveryCount: 1 } satisfies QueueMetadataOptions;
    const metadata: QueueTimingMetadata = queueMetadata(job, options);
    expect(metadata).toEqual({ queue: "orders", deliveryCount: 1, attempt: 1 });
  });
  it("describes a first BullMQ attempt from its own clocks and stable identity", () => {
    expect(
      queueMetadata({
        queueName: "orders",
        id: "job-42",
        timestamp: 1_000,
        processedOn: 1_125,
        attemptsMade: 0
      })
    ).toEqual({
      queue: "orders",
      queueWaitMs: 125,
      queueWaitBasis: "initial-enqueue",
      attempt: 1,
      retryGroup: 'queue:["orders","job-42"]'
    });
  });

  it("measures a retry only from an explicit ready-again boundary", () => {
    const job = {
      queueName: "orders",
      id: "job-42",
      timestamp: 1_000,
      processedOn: 9_500,
      attemptsMade: 2
    };
    expect(queueMetadata(job)).toEqual({
      queue: "orders",
      attempt: 3,
      retryGroup: 'queue:["orders","job-42"]'
    });
    expect(queueMetadata(job, { readyAgainAt: 9_200 })).toEqual({
      queue: "orders",
      queueWaitMs: 300,
      queueWaitBasis: "retry-ready",
      attempt: 3,
      retryGroup: 'queue:["orders","job-42"]'
    });
  });

  it("keeps a measured zero and caller-reported delivery count", () => {
    expect(
      queueMetadata(
        {
          queueName: "orders",
          timestamp: 2_000,
          processedOn: 2_000,
          attemptsMade: 0
        },
        { deliveryCount: 1 }
      )
    ).toEqual({
      queue: "orders",
      queueWaitMs: 0,
      queueWaitBasis: "initial-enqueue",
      deliveryCount: 1,
      attempt: 1
    });
  });

  it("omits invalid clocks and negative differences instead of falling back or clamping", () => {
    for (const job of [
      { timestamp: Number.NaN, processedOn: 10, attemptsMade: 0 },
      { timestamp: 10, processedOn: Number.POSITIVE_INFINITY, attemptsMade: 0 },
      { timestamp: 11, processedOn: 10, attemptsMade: 0 },
      { timestamp: 0.5, processedOn: 10, attemptsMade: 0 },
      { timestamp: 0, processedOn: MAX_MS + 1, attemptsMade: 0 }
    ]) {
      expect(queueMetadata(job)).toEqual({ attempt: 1 });
    }
    expect(
      queueMetadata({ timestamp: 0, processedOn: 10, attemptsMade: 1 }, { readyAgainAt: 11 })
    ).toEqual({ attempt: 2 });
  });

  it("derives attempt only from a valid completed-attempt count", () => {
    for (const attemptsMade of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      "0",
      null
    ]) {
      expect(
        queueMetadata({ timestamp: 1_000, processedOn: 1_100, attemptsMade } as never)
      ).toEqual({});
    }
    expect(queueMetadata({ attemptsMade: Number.MAX_SAFE_INTEGER - 1 })).toEqual({
      attempt: Number.MAX_SAFE_INTEGER
    });
  });

  it("keeps identity collision-safe and omits it rather than truncating", () => {
    const one = queueMetadata({ queueName: "a:b", id: "c", attemptsMade: 0 });
    const two = queueMetadata({ queueName: "a", id: "b:c", attemptsMade: 0 });
    expect(one.retryGroup).not.toBe(two.retryGroup);
    expect(one.retryGroup).toBe('queue:["a:b","c"]');
    expect(two.retryGroup).toBe('queue:["a","b:c"]');

    const tooLong = queueMetadata({
      queueName: "q".repeat(250),
      id: "job-identity-that-would-be-truncated",
      attemptsMade: 0
    });
    expect(tooLong.queue).toBe("q".repeat(250));
    expect(tooLong).not.toHaveProperty("retryGroup");
  });

  it("isolates unreadable job and option fields", () => {
    const job = Object.defineProperty(
      { id: "job-42", timestamp: 10, processedOn: 20, attemptsMade: 0 },
      "queueName",
      {
        enumerable: true,
        get: () => {
          throw new Error("queue name getter");
        }
      }
    );
    const options = Object.defineProperty({ deliveryCount: 2 }, "readyAgainAt", {
      enumerable: true,
      get: () => {
        throw new Error("ready getter");
      }
    });
    expect(queueMetadata(job, options)).toEqual({
      queueWaitMs: 10,
      queueWaitBasis: "initial-enqueue",
      deliveryCount: 2,
      attempt: 1
    });
    expect(
      queueMetadata(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile job");
            }
          }
        )
      )
    ).toEqual({});
  });

  it("reads BullMQ-style inherited getters without mutating the job", () => {
    const prototype = Object.defineProperties(
      {},
      {
        queueName: { get: () => "orders" },
        id: { get: () => "job-42" },
        timestamp: { get: () => 1_000 },
        processedOn: { get: () => 1_050 },
        attemptsMade: { get: () => 0 }
      }
    );
    const job = Object.freeze(Object.create(prototype) as QueueMetadataJob);
    expect(queueMetadata(job)).toEqual({
      queue: "orders",
      queueWaitMs: 50,
      queueWaitBasis: "initial-enqueue",
      attempt: 1,
      retryGroup: 'queue:["orders","job-42"]'
    });
    expect(Object.keys(job)).toEqual([]);
  });

  it("omits invalid delivery counts and marker-valued identity fields independently", () => {
    expect(
      queueMetadata(
        { queueName: "[REDACTED]", id: "[REDACTED]", attemptsMade: 0 },
        { deliveryCount: 0 }
      )
    ).toEqual({ attempt: 1 });
    expect(
      queueMetadata(
        { queueName: "orders", id: "job-42", attemptsMade: 0 },
        { deliveryCount: Number.MAX_SAFE_INTEGER }
      )
    ).toEqual({
      queue: "orders",
      deliveryCount: Number.MAX_SAFE_INTEGER,
      attempt: 1,
      retryGroup: 'queue:["orders","job-42"]'
    });
  });
});

describe("httpMetadata", () => {
  it("exposes structural public input and output types", () => {
    const response = { status: 204, headers: { get: () => null } } satisfies HttpMetadataResponse;
    const options = { targetUrl: "https://api.example.test/path" } satisfies HttpMetadataOptions;
    const metadata: HttpTimingMetadata = httpMetadata(response, options);
    expect(metadata).toEqual({ targetHost: "api.example.test", httpStatusCode: 204 });
  });
  it("records status, strips a target URL to its host, and parses delay seconds", () => {
    expect(
      httpMetadata(
        { status: 429, headers: { get: () => "3" } },
        { targetUrl: "https://user:secret@api.example.test:8443/v1/orders?token=x#part" }
      )
    ).toEqual({
      targetHost: "api.example.test:8443",
      httpStatusCode: 429,
      retryAfterMs: 3_000
    });
  });

  it("keeps a zero delay and parses an HTTP date against the observation time", () => {
    expect(httpMetadata({ status: 503, headers: { get: () => "0" } })).toEqual({
      httpStatusCode: 503,
      retryAfterMs: 0
    });
    expect(
      httpMetadata(
        { status: 503, headers: { get: () => "Wed, 21 Oct 2015 07:28:00 GMT" } },
        { now: Date.parse("2015-10-21T07:27:58.000Z") }
      )
    ).toEqual({ httpStatusCode: 503, retryAfterMs: 2_000 });
  });

  it("omits malformed, past, non-integer, and overflowing Retry-After values", () => {
    for (const retryAfter of [
      "later",
      "-1",
      "1.5",
      String(Math.floor(MAX_MS / 1_000) + 1),
      "Wed, 21 Oct 2015 07:27:57 GMT"
    ]) {
      expect(
        httpMetadata(
          { status: 429, headers: { get: () => retryAfter } },
          { now: Date.parse("2015-10-21T07:27:58.000Z") }
        )
      ).toEqual({ httpStatusCode: 429 });
    }
  });

  it("validates response fields independently when getters and proxies throw", () => {
    const noStatus = Object.defineProperty({ headers: { get: () => "2" } }, "status", {
      enumerable: true,
      get: () => {
        throw new Error("status getter");
      }
    });
    expect(httpMetadata(noStatus, { targetUrl: "https://api.example.test/path" })).toEqual({
      targetHost: "api.example.test",
      retryAfterMs: 2_000
    });

    const noHeaders = Object.defineProperty({ status: 204 }, "headers", {
      enumerable: true,
      get: () => {
        throw new Error("headers getter");
      }
    });
    expect(httpMetadata(noHeaders, { targetUrl: "https://api.example.test/path" })).toEqual({
      targetHost: "api.example.test",
      httpStatusCode: 204
    });

    expect(
      httpMetadata(
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile response");
            }
          }
        ),
        { targetUrl: "https://api.example.test/path" }
      )
    ).toEqual({ targetHost: "api.example.test" });
  });

  it("isolates a throwing headers.get and targetUrl option", () => {
    const response = {
      status: 202,
      headers: {
        get: () => {
          throw new Error("get retry-after");
        }
      }
    };
    expect(httpMetadata(response, { targetUrl: "https://api.example.test/path" })).toEqual({
      targetHost: "api.example.test",
      httpStatusCode: 202
    });

    const options = Object.defineProperty({ now: 0 }, "targetUrl", {
      enumerable: true,
      get: () => {
        throw new Error("target URL getter");
      }
    });
    expect(httpMetadata({ status: 202, headers: { get: () => "0" } }, options)).toEqual({
      httpStatusCode: 202,
      retryAfterMs: 0
    });
  });

  it("omits invalid status and target URLs without inventing values", () => {
    expect(
      httpMetadata({ status: 99, headers: { get: () => null } }, { targetUrl: "relative/path" })
    ).toEqual({});
    expect(
      httpMetadata(
        { status: 600, headers: { get: () => undefined } },
        { targetUrl: "https://[REDACTED]/secret" }
      )
    ).toEqual({});
  });
});
