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

  describe("a __proto__ key the sender wrote", () => {
    /**
     * Built through JSON.parse rather than an object literal, because a literal
     * `__proto__:` sets the prototype and never makes an own key. This is the
     * shape any HTTP body arrives in.
     */
    const withProtoKeys = (): unknown =>
      JSON.parse(
        String.raw`{"protocolVersion":"0.1","event":{"id":"evt_01","journeyId":"jrn_01","environment":"development","service":"customer-integration","entity":{"type":"customer","id":"18492"},"operation":"received","name":"receive-salesforce-webhook","timestamp":"2026-08-06T18:31:02.000Z","aliases":{"__proto__":"alias-value","orderId":"ord_77"},"metadata":{"__proto__":"metadata-value","attempt":"2"},"input":{"__proto__":"input-value","field":"kept"}}}`
      ) as unknown;

    it("survives in aliases, beside the ordinary key", () => {
      // z.record assigned parsed keys onto a fresh object, so this key was
      // spent on the prototype and vanished from the event that was stored.
      const result = parseEnvelope(withProtoKeys());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Not toEqual against an object literal: a literal `__proto__:` sets the
      // prototype and never makes an own key, so the expected value would be
      // the very shape this test exists to refuse.
      expect(Object.hasOwn(result.event.aliases ?? {}, "__proto__")).toBe(true);
      expect(JSON.stringify(result.event.aliases)).toBe(
        String.raw`{"orderId":"ord_77","__proto__":"alias-value"}`
      );
    });

    it("survives in metadata, beside the ordinary key", () => {
      const result = parseEnvelope(withProtoKeys());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.hasOwn(result.event.metadata ?? {}, "__proto__")).toBe(true);
      expect(JSON.stringify(result.event.metadata)).toBe(
        String.raw`{"attempt":"2","__proto__":"metadata-value"}`
      );
    });

    it("survives in input, which was never the broken case", () => {
      const result = parseEnvelope(withProtoKeys());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.stringify(result.event.input)).toBe(
        String.raw`{"__proto__":"input-value","field":"kept"}`
      );
    });

    it("leaves the parsed objects' prototypes alone", () => {
      // Restoring the key must not be a way to set a prototype: the fix defines
      // an own property rather than assigning one.
      const result = parseEnvelope(withProtoKeys());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.getPrototypeOf(result.event.aliases)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(result.event.metadata)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(result.event)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)["orderId"]).toBeUndefined();
    });

    it("does not invent the key when the sender did not send one", () => {
      const result = parseEnvelope({
        ...validEnvelope,
        event: { ...validEnvelope.event, aliases: { orderId: "ord_77" }, metadata: { a: 1 } }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.hasOwn(result.event.aliases ?? {}, "__proto__")).toBe(false);
      expect(Object.hasOwn(result.event.metadata ?? {}, "__proto__")).toBe(false);
    });

    it("refuses an alias __proto__ whose value is not a string, as it does any other key", () => {
      const body = JSON.parse(
        String.raw`{"protocolVersion":"0.1","event":{"id":"evt_01","journeyId":"jrn_01","environment":"development","service":"customer-integration","entity":{"type":"customer","id":"18492"},"operation":"received","name":"receive-salesforce-webhook","timestamp":"2026-08-06T18:31:02.000Z","aliases":{"__proto__":{"nested":true}}}}`
      ) as unknown;
      // Restoring the key must not smuggle past the value schema: what Zod
      // refused stays refused.
      expect(parseEnvelope(body).ok).toBe(false);
    });
  });
});
