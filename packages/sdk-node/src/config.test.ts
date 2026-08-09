import { describe, expect, it } from "vitest";
import { MAX_BATCH_SIZE, resolveConfig } from "./config.js";

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
