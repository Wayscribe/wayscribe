import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_SENDS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENT_SENDS_LIMIT,
  resolveConfig
} from "./config.js";

const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

describe("batchSize", () => {
  it("clamps to what the server will accept", () => {
    // The server refuses a batch of more than 100. Unclamped, that refusal
    // arrived as a 400 the SDK read as a transport failure, retried three
    // times, and requeued to the front of the queue — so events behind it were
    // lost too, while the counters read like a brief blip.
    expect(resolveConfig({ ...base, batchSize: 150 }).batchSize).toBe(MAX_BATCH_SIZE);
    expect(resolveConfig({ ...base, batchSize: 5_000 }).batchSize).toBe(MAX_BATCH_SIZE);
  });

  it("falls back for a nonsensical value rather than throwing", () => {
    // ADR-007: the recorder must never break the application it observes, and
    // that includes refusing to start because of a tuning value.
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(resolveConfig({ ...base, batchSize: value }).batchSize).toBe(50);
    }
  });

  it("keeps a sensible configured value", () => {
    // The control: a clamp that returned a constant would pass both tests
    // above.
    expect(resolveConfig({ ...base, batchSize: 10 }).batchSize).toBe(10);
    expect(resolveConfig({ ...base, batchSize: 100 }).batchSize).toBe(100);
  });

  it("defaults below the server ceiling", () => {
    expect(resolveConfig(base).batchSize).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });
});

describe("maxConcurrentSends", () => {
  it("defaults to four", () => {
    // Four, not the eight a one-process benchmark favoured: ten processes at
    // eight against one API instance with a pool of ten timed out, resent work
    // the server went on to finish, and stored a third as many unique events.
    expect(DEFAULT_MAX_CONCURRENT_SENDS).toBe(4);
    expect(resolveConfig(base).maxConcurrentSends).toBe(4);
  });

  it("clamps to between one and sixteen", () => {
    expect(MAX_CONCURRENT_SENDS_LIMIT).toBe(16);
    expect(resolveConfig({ ...base, maxConcurrentSends: 0 }).maxConcurrentSends).toBe(1);
    expect(resolveConfig({ ...base, maxConcurrentSends: -3 }).maxConcurrentSends).toBe(1);
    expect(resolveConfig({ ...base, maxConcurrentSends: 17 }).maxConcurrentSends).toBe(16);
    expect(resolveConfig({ ...base, maxConcurrentSends: 1_000 }).maxConcurrentSends).toBe(16);
  });

  it("falls back to the default for a value that is not a whole number", () => {
    // ADR-007 again: a tuning value never stops the recorder starting.
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveConfig({ ...base, maxConcurrentSends: value }).maxConcurrentSends).toBe(4);
    }
  });

  it("keeps a sensible configured value", () => {
    for (const value of [1, 8, 16]) {
      expect(resolveConfig({ ...base, maxConcurrentSends: value }).maxConcurrentSends).toBe(value);
    }
  });
});

describe("settings that cannot be used", () => {
  it.each([
    ["flushIntervalMs", Number.NaN, 1_000],
    ["flushIntervalMs", 2 ** 31, 1_000],
    ["requestTimeoutMs", -1, 1_500],
    ["maxBufferedEvents", Number.NaN, 1_000],
    ["maxBufferedEvents", "500", 1_000],
    ["maxEventBytes", Number.POSITIVE_INFINITY, 262_144],
    ["maxEventBytes", Number.NaN, 262_144],
    // Not coerced: a number read from process.env is still a string.
    ["maxEventBytes", "5000", 262_144],
    ["maxEventBytes", 0.5, 262_144]
  ] as const)("replaces %s of %s with the default and lists it", (key, value, fallback) => {
    // NaN as a queue bound compares false with every size, so the queue never
    // dropped anything; NaN or 2^31 as a timer fires after one millisecond.
    const resolved = resolveConfig({ ...base, [key]: value });
    expect(resolved[key]).toBe(fallback);
    expect(resolved.problems).toEqual([
      { setting: key, reason: expect.stringContaining(key) as string, required: false }
    ]);
  });

  it.each([
    ["batchSize", 150, 100],
    ["batchSize", 0, 50],
    ["batchSize", "20", 50],
    ["maxConcurrentSends", 0, 1],
    ["maxConcurrentSends", 99, 16],
    ["maxConcurrentSends", 1.5, 4]
  ] as const)("reports %s of %s, clamped or replaced with %s", (key, value, expected) => {
    const resolved = resolveConfig({ ...base, [key]: value });
    expect(resolved[key]).toBe(expected);
    expect(resolved.problems.map((one) => one.setting)).toEqual([key]);
  });

  it("reports a logDiagnostics that is not a boolean, and leaves logging off", () => {
    const resolved = resolveConfig({ ...base, logDiagnostics: "true" } as never);
    expect(resolved.logDiagnostics).toBe(false);
    expect(resolved.problems.map((one) => one.setting)).toEqual(["logDiagnostics"]);
  });

  it("marks a required setting, and says what becomes of events without it", () => {
    const resolved = resolveConfig({ ...base, endpoint: undefined, apiKey: 7 } as never);
    expect(resolved.problems).toEqual([
      {
        setting: "endpoint",
        reason: expect.stringContaining("no request can be made") as string,
        required: true
      },
      {
        setting: "apiKey",
        reason: expect.stringContaining("refuses every request") as string,
        required: true
      }
    ]);
    // The value is never quoted.
    expect(JSON.stringify(resolved.problems)).not.toContain("7");
  });

  it("says a setting could not be read, and only that, when the configuration is null", () => {
    const resolved = resolveConfig(null as never);
    const reasons = resolved.problems.map((one) => one.reason);
    expect(reasons.filter((reason) => reason.includes("is not a string"))).toEqual([]);
    expect(resolved.problems.filter((one) => one.required).map((one) => one.setting)).toEqual([
      "endpoint",
      "apiKey",
      "serviceName",
      "environment"
    ]);
    expect(reasons.every((reason) => reason.includes("could not be read"))).toBe(true);
  });

  it("replaces an unknown capture mode or propagation level with the default", () => {
    const resolved = resolveConfig({
      ...base,
      captureMode: "everything",
      propagation: "all"
    } as never);
    expect(resolved.captureMode).toBe("redacted-payload");
    expect(resolved.propagation).toBe("journey-and-type");
    expect(resolved.problems.map((one) => one.setting)).toEqual(["captureMode", "propagation"]);
  });

  it("does not read the names the options had before the first release", () => {
    const resolved = resolveConfig({
      ...base,
      maxPayloadBytes: 1_000,
      propagate: "full"
    } as never);
    expect(resolved.maxEventBytes).toBe(262_144);
    expect(resolved.propagation).toBe("journey-and-type");
  });

  it("keeps the built-in secret names when redact is not a list of strings", () => {
    const resolved = resolveConfig({ ...base, redact: ["token", 7, null] } as never);
    expect(resolved.redact).toContain("token");
    expect(resolved.redact.length).toBeGreaterThan(1);
    expect(resolved.problems).toHaveLength(1);
    expect(resolveConfig({ ...base, redact: 7 } as never).problems).toHaveLength(1);
  });

  it("lists nothing for a sound configuration", () => {
    expect(resolveConfig({ ...base, flushIntervalMs: 250, redact: ["a.b"] }).problems).toEqual([]);
  });
});
