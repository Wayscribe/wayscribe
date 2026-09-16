import { describe, expect, it } from "vitest";
import { journeyEventSchema } from "./event.js";

const minimalEvent = {
  id: "evt_01",
  journeyId: "jrn_01",
  environment: "development",
  service: "customer-integration",
  entity: { type: "customer", id: "18492" },
  operation: "received",
  name: "receive-salesforce-webhook",
  timestamp: "2026-08-06T18:31:02.000Z"
};

describe("journeyEventSchema", () => {
  it("accepts a minimal valid event", () => {
    expect(journeyEventSchema.safeParse(minimalEvent).success).toBe(true);
  });

  it("accepts the identified operation", () => {
    const event = { ...minimalEvent, operation: "identified" };
    expect(journeyEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an unknown operation", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, operation: "exploded" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id and names the field", () => {
    const { id: _omitted, ...withoutId } = minimalEvent;
    const result = journeyEventSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("id"))).toBe(true);
    }
  });

  it("rejects a non-ISO timestamp", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, timestamp: "yesterday" });
    expect(result.success).toBe(false);
  });

  it("rejects a timestamp without timezone information", () => {
    const result = journeyEventSchema.safeParse({
      ...minimalEvent,
      timestamp: "2026-08-06T18:31:02.000"
    });
    expect(result.success).toBe(false);
  });

  describe("displayableAliases", () => {
    it("is optional, and a list of alias types", () => {
      const event = {
        ...minimalEvent,
        aliases: { postingId: "gh_123", email: "a@example.com" },
        displayableAliases: ["postingId"]
      };
      const parsed = journeyEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.displayableAliases).toEqual(["postingId"]);
    });

    it("accepts a type the event's aliases do not name, which ingestion ignores", () => {
      // Refusing it would lose the event over a flag that can only mask.
      const event = { ...minimalEvent, displayableAliases: ["notHere", "__proto__"] };
      expect(journeyEventSchema.safeParse(event).success).toBe(true);
    });

    it("refuses anything but a list of short strings", () => {
      for (const displayableAliases of [
        "postingId",
        [7],
        { postingId: true },
        ["x".repeat(129)],
        Array.from({ length: 1_001 }, (_unused, index) => `t${String(index)}`)
      ]) {
        expect(
          journeyEventSchema.safeParse({ ...minimalEvent, displayableAliases }).success,
          JSON.stringify(displayableAliases).slice(0, 40)
        ).toBe(false);
      }
      expect(
        journeyEventSchema.safeParse({
          ...minimalEvent,
          displayableAliases: Array.from({ length: 1_000 }, (_unused, index) => `t${String(index)}`)
        }).success
      ).toBe(true);
    });
  });

  it("accepts optional aliases, payloads, error, and metadata", () => {
    const complete = {
      ...minimalEvent,
      aliases: { salesforceAccountId: "0018Z00002ABC" },
      durationMs: 18,
      parentEventId: "evt_00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      messageId: "msg_01",
      correlationId: "cor_01",
      input: { phone: "+1 919 555 1234" },
      output: { phone: null },
      error: { type: "ValidationError", message: "phone required", code: "phone_required" },
      runtime: { language: "node", version: "24.19.0", hostname: "worker-1", processId: 42 },
      deployment: { gitCommit: "abc123", version: "1.2.3", image: "app:1.2.3" },
      metadata: { attempt: 2, httpStatus: 422 }
    };
    expect(journeyEventSchema.safeParse(complete).success).toBe(true);
  });

  it("accepts a duration up to the largest the database stores, and refuses one past it", () => {
    // duration_ms is an int4. 2^31 passed the schema and failed the insert:
    // a 500 from the single route, and a per-event 500 in a batch, which the
    // SDK resends as transient until it gives up.
    expect(
      journeyEventSchema.safeParse({ ...minimalEvent, durationMs: 2_147_483_647 }).success
    ).toBe(true);
    const result = journeyEventSchema.safeParse({ ...minimalEvent, durationMs: 2_147_483_648 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative duration", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, durationMs: -1 });
    expect(result.success).toBe(false);
  });

  it("requires a message when an error is present", () => {
    const result = journeyEventSchema.safeParse({ ...minimalEvent, error: { code: "x" } });
    expect(result.success).toBe(false);
  });
});
