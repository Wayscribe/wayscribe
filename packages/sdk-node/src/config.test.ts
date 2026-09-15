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
