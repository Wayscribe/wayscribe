import { describe, expect, it } from "vitest";
import {
  extractHttpContext,
  extractPayload,
  extractSqsContext,
  injectHttpHeaders,
  injectPayload,
  injectSqsAttributes
} from "./propagation.js";

const context = {
  journeyId: "jrn_11111111-2222-3333-4444-555555555555",
  entity: { type: "customer", id: "0018Z00002ABC" }
};

describe("HTTP propagation", () => {
  it("round-trips a context at the full level", () => {
    expect(extractHttpContext(injectHttpHeaders({}, context, "full"))).toEqual(context);
  });

  it("omits the entity id at the default level", () => {
    // SECURITY.md section 10: the primary entity ID propagates only when allowed.
    const headers = injectHttpHeaders({}, context, "journey-and-type");
    expect(headers["x-flight-entity-id"]).toBeUndefined();
    expect(headers["x-flight-entity-type"]).toBe("customer");
  });

  it("emits only the journey id at journey-only", () => {
    expect(Object.keys(injectHttpHeaders({}, context, "journey-only"))).toEqual([
      "x-flight-journey-id"
    ]);
  });

  it("never emits an alias", () => {
    expect(JSON.stringify(injectHttpHeaders({}, context, "full"))).not.toContain("alias");
  });

  it("does not mutate the caller's header object", () => {
    const original = { "content-type": "application/json" };
    injectHttpHeaders(original, context, "full");
    expect(original).toEqual({ "content-type": "application/json" });
  });

  it("preserves existing headers", () => {
    const headers = injectHttpHeaders({ authorization: "Bearer x" }, context, "journey-only");
    expect(headers["authorization"]).toBe("Bearer x");
  });

  it("returns undefined when no context is present", () => {
    expect(extractHttpContext({})).toBeUndefined();
  });

  it.each([
    ["an empty journey id", ""],
    ["a wrong prefix", "trace_11111111-2222-3333-4444-555555555555"],
    ["an oversized value", `jrn_${"x".repeat(400)}`],
    ["a control character", "jrn_1111\n1111"],
    ["a space", "jrn_1111 1111"]
  ])("rejects %s", (_label, journeyId) => {
    // Inbound context is attacker-controlled. Rejecting means the consumer
    // starts a fresh journey rather than joining a malformed one.
    expect(extractHttpContext({ "x-flight-journey-id": journeyId })).toBeUndefined();
  });

  it("reads a fetch Headers object, whatever the case of the names", () => {
    const headers = new Headers({
      "X-Flight-Journey-Id": context.journeyId,
      "X-Flight-Entity-Type": "customer",
      "X-Flight-Entity-Id": context.entity.id
    });
    expect(extractHttpContext(headers)).toEqual(context);
  });

  it("reads Node's incoming headers, ignoring values that are not strings", () => {
    const incoming: Record<string, string | string[] | number | undefined> = {
      "content-length": 12,
      "x-flight-journey-id": [context.journeyId, "jrn_second"],
      "x-flight-entity-type": undefined
    };
    expect(extractHttpContext(incoming)).toEqual({ journeyId: context.journeyId });
    expect(extractHttpContext({ "x-flight-journey-id": 7 })).toBeUndefined();
  });

  it("extracts a journey without an entity when only the id was sent", () => {
    const headers = injectHttpHeaders({}, context, "journey-only");
    expect(extractHttpContext(headers)?.journeyId).toBe(context.journeyId);
    expect(extractHttpContext(headers)?.entity).toBeUndefined();
  });
});

describe("SQS propagation", () => {
  it("round-trips through SQS message attributes", () => {
    expect(extractSqsContext(injectSqsAttributes({}, context, "full"))).toEqual(context);
  });

  it("emits the SQS attribute shape", () => {
    expect(injectSqsAttributes({}, context, "journey-only")["flightJourneyId"]).toEqual({
      DataType: "String",
      StringValue: context.journeyId
    });
  });

  it("adds to the caller's attributes without changing them", () => {
    const original = { tenant: { DataType: "String", StringValue: "acme" } };
    const injected = injectSqsAttributes(original, context, "journey-only");
    expect(injected).toEqual({
      tenant: { DataType: "String", StringValue: "acme" },
      flightJourneyId: { DataType: "String", StringValue: context.journeyId }
    });
    expect(original).toEqual({ tenant: { DataType: "String", StringValue: "acme" } });
  });

  it("accepts a plain name-to-value map", () => {
    // ElasticMQ and other brokers differ; a consumer should not have to
    // normalise before calling us.
    const plain = { flightJourneyId: context.journeyId, flightEntityType: "customer" };
    expect(extractSqsContext(plain)?.journeyId).toBe(context.journeyId);
  });

  it("returns undefined for absent attributes", () => {
    expect(extractSqsContext({})).toBeUndefined();
    expect(extractSqsContext(undefined)).toBeUndefined();
  });

  it("rejects a malformed journey id", () => {
    expect(extractSqsContext({ flightJourneyId: "nope" })).toBeUndefined();
  });
});

describe("payload envelope", () => {
  it("round-trips and leaves the caller's payload untouched", () => {
    const payload = { customerId: 18492 };
    const wrapped = injectPayload(payload, context, "full");
    expect(payload).toEqual({ customerId: 18492 });

    const { context: extracted, data } = extractPayload(wrapped);
    expect(extracted).toEqual(context);
    expect(data).toEqual(payload);
  });

  it("returns the body as data when there is no envelope", () => {
    const body = { plain: true };
    expect(extractPayload(body)).toEqual({ data: body });
  });

  it("ignores a malformed envelope but keeps the data", () => {
    const { context: extracted, data } = extractPayload({ _flight: { journeyId: "bad" }, data: 1 });
    expect(extracted).toBeUndefined();
    expect(data).toBe(1);
  });
});
