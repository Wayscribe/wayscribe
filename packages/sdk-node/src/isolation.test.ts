import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

// Port 1 refuses connections on every platform we care about.
const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

function circular(): Record<string, unknown> {
  const value: Record<string, unknown> = { name: "x" };
  value["self"] = value;
  return value;
}

describe("failure isolation (ADR-007)", () => {
  it("does not throw when the endpoint refuses connections", async () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    await recorder.shutdown({ timeoutMs: 100 });
  });

  it("does not throw on a circular payload", () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "transformed", name: "n", input: circular() });
    }).not.toThrow();
  });

  it("does not throw when the queue is full", () => {
    const recorder = createRecorder({ ...base, maxBufferedEvents: 2 });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      for (let i = 0; i < 50; i += 1) journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
    expect(recorder.counters().dropped).toBeGreaterThan(0);
  });

  it("does not throw when the diagnostics callback throws", () => {
    const recorder = createRecorder({
      ...base,
      maxBufferedEvents: 1,
      onDiagnostic: () => {
        throw new Error("callback exploded");
      }
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
  });

  it("does not throw on an empty entity", () => {
    const recorder = createRecorder(base);
    expect(() => {
      recorder.startJourney({ entity: { type: "", id: "" } });
    }).not.toThrow();
  });

  it("does not throw when the payload exceeds the size guard", () => {
    const recorder = createRecorder({ ...base, maxEventBytes: 64 });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "transformed", name: "n", input: { blob: "x".repeat(5_000) } });
    }).not.toThrow();
  });

  it("shutdown always returns, even against a dead endpoint", async () => {
    const recorder = createRecorder(base);
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "n" });
    const counters = await recorder.shutdown({ timeoutMs: 100 });
    expect(counters).toBeDefined();
  });

  it("shutdown is idempotent", async () => {
    const recorder = createRecorder(base);
    await recorder.shutdown({ timeoutMs: 50 });
    await expect(recorder.shutdown({ timeoutMs: 50 })).resolves.toBeDefined();
  });

  it("ignores records after shutdown without throwing", async () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    await recorder.shutdown({ timeoutMs: 50 });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
  });
});
