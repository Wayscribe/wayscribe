import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./envelope.js";
import { PROTOCOL_ERROR_CODES } from "./errors.js";

const validEnvelope = {
  protocolVersion: "0.1",
  event: {
    id: "evt_01",
    journeyId: "jrn_01",
    environment: "development",
    service: "customer-integration",
    entity: { type: "customer", id: "18492" },
    operation: "received",
    name: "receive-salesforce-webhook",
    timestamp: "2026-08-06T18:31:02.000Z"
  }
};

describe("parseEnvelope", () => {
  it("returns the event for a valid envelope", () => {
    const result = parseEnvelope(validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.id).toBe("evt_01");
  });

  it("rejects an unsupported version before validating the event", () => {
    const result = parseEnvelope({ protocolVersion: "9.9", event: { garbage: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PROTOCOL_ERROR_CODES.unsupportedProtocolVersion);
    }
  });

  it("reports invalid_event with field details for a malformed event", () => {
    const result = parseEnvelope({ protocolVersion: "0.1", event: { id: "evt_01" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PROTOCOL_ERROR_CODES.invalidEvent);
      expect(result.details.length).toBeGreaterThan(0);
      expect(result.details[0]).toHaveProperty("path");
      expect(result.details[0]).toHaveProperty("message");
    }
  });

  it("rejects a non-object input", () => {
    expect(parseEnvelope(null).ok).toBe(false);
    expect(parseEnvelope("nope").ok).toBe(false);
  });
});
