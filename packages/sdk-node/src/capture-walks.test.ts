import * as redaction from "@wayscribe/payload-security/redaction";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "./recorder.js";

/**
 * How many times capture walks a payload, counted rather than timed.
 *
 * On 2026-09-16 a wrapped call was found about 40 percent slower than a day
 * earlier: every event went through the full `checkLimits` a second time, as a
 * whole envelope, and every stored payload was walked again by
 * `truncateStrings`. A timing test could not tell that regression from machine
 * noise reliably. These count the calls instead, so the extra walks fail here
 * on any machine.
 */
vi.mock("@wayscribe/payload-security/redaction", async (importOriginal) => {
  const actual = await importOriginal<typeof redaction>();
  return {
    ...actual,
    checkLimits: vi.fn(actual.checkLimits),
    redact: vi.fn(actual.redact),
    toStorable: vi.fn(actual.toStorable),
    truncateStrings: vi.fn(actual.truncateStrings)
  };
});

const checkLimits = vi.mocked(redaction.checkLimits);
const redact = vi.mocked(redaction.redact);
const toStorable = vi.mocked(redaction.toStorable);
const truncateStrings = vi.mocked(redaction.truncateStrings);

function recorder(settings: { maxEventBytes?: number } = {}): ReturnType<typeof createRecorder> {
  return createRecorder({
    // Refuses connections; nothing here depends on delivery.
    endpoint: "http://127.0.0.1:1",
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development",
    logDiagnostics: false,
    flushIntervalMs: 3_600_000,
    ...settings
  });
}

const isEnvelope = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "protocolVersion" in value;

afterEach(() => {
  vi.clearAllMocks();
});

describe("capture's walks over a payload", () => {
  it("checks, redacts and stores each payload once, and never checks an event within budget", async () => {
    const r = recorder();
    const input = { customer: { id: "1", notes: ["a", "b"] } };
    const output = { id: 7 };
    const metadata = { attempt: 1 };
    vi.clearAllMocks();

    r.startJourney({ entity: { type: "customer", id: "1" } }).record({
      operation: "transformed",
      name: "map",
      input,
      output,
      metadata
    });

    expect(checkLimits.mock.calls.map(([value]) => value)).toEqual([input, output, metadata]);
    expect(checkLimits.mock.calls.some(([value]) => isEnvelope(value))).toBe(false);
    expect(redact).toHaveBeenCalledTimes(3);
    // Stored and cut in one walk.
    expect(toStorable).toHaveBeenCalledTimes(3);
    for (const [, cut] of toStorable.mock.calls) expect(cut).toBeDefined();
    expect(truncateStrings).not.toHaveBeenCalled();
    await r.shutdown({ timeoutMs: 50 });
  });

  it("does the same for a wrapper, which captures input and output", async () => {
    const r = recorder();
    const journey = r.startJourney({ entity: { type: "customer", id: "1" } });
    vi.clearAllMocks();

    journey.transform("map", { a: 1 }, () => ({ b: 2 }));

    expect(checkLimits).toHaveBeenCalledTimes(2);
    expect(redact).toHaveBeenCalledTimes(2);
    expect(toStorable).toHaveBeenCalledTimes(2);
    expect(truncateStrings).not.toHaveBeenCalled();
    await r.shutdown({ timeoutMs: 50 });
  });

  it("runs the server's check on the whole event only when it may be over budget", async () => {
    const r = recorder({ maxEventBytes: 1_000 });
    const journey = r.startJourney({ entity: { type: "customer", id: "1" } });
    vi.clearAllMocks();

    journey.record({ operation: "transformed", name: "t", input: "x".repeat(300) });
    expect(checkLimits.mock.calls.filter(([value]) => isEnvelope(value))).toHaveLength(0);

    journey.record({
      operation: "transformed",
      name: "t",
      input: "x".repeat(600),
      output: "y".repeat(600)
    });
    // Over budget: checked, the output omitted, and checked again.
    expect(checkLimits.mock.calls.filter(([value]) => isEnvelope(value))).toHaveLength(2);
    await r.shutdown({ timeoutMs: 50 });
  });
});
