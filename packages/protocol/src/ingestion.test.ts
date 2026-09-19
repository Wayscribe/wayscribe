import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_EVENTS, batchRequestSchema, storedEventSchema } from "./ingestion.js";
import { buildJsonSchemas } from "./json-schema.js";

const built = buildJsonSchemas();

/**
 * The Zod schema, the generated JSON Schema and the route have to agree about
 * what is a whole-request refusal.
 *
 * The route's own half is in `apps/api/src/routes/events.integration.test.ts`,
 * which sends each of these bodies; the column here records what that route
 * answers, so a change to either side shows up as a disagreement rather than as
 * a document going quietly out of date.
 */
interface Corpus {
  name: string;
  body: unknown;
  accepted: boolean;
  /** What the route answers, for the reader; asserted against the route in the API's tests. */
  route: string;
}

const event = (id: string): unknown => ({
  protocolVersion: "0.1",
  event: {
    id,
    journeyId: "jrn_corpus",
    environment: "development",
    service: "customer-integration",
    entity: { type: "customer", id: "18492" },
    operation: "received",
    name: "receive-salesforce-webhook",
    timestamp: "2026-08-06T18:31:02.000Z"
  }
});

const many = (count: number): unknown[] =>
  Array.from({ length: count }, (_, index) => event(`evt_${String(index)}`));

const corpus: Corpus[] = [
  {
    name: "zero events",
    body: { events: [] },
    accepted: true,
    route: "202 with an empty results array"
  },
  { name: "one event", body: { events: many(1) }, accepted: true, route: "202 with one result" },
  {
    name: "one hundred events",
    body: { events: many(MAX_BATCH_EVENTS) },
    accepted: true,
    route: "202 with one hundred results"
  },
  {
    name: "one hundred and one events",
    body: { events: many(MAX_BATCH_EVENTS + 1) },
    accepted: false,
    route: "400 payload_too_large, before any event is processed"
  },
  {
    name: "no events key",
    body: {},
    accepted: false,
    route: "400 invalid_event, body must contain an events array"
  },
  {
    name: "events is not an array",
    body: { events: "one" },
    accepted: false,
    route: "400 invalid_event"
  },
  { name: "a null body", body: null, accepted: false, route: "400 invalid_event" },
  {
    name: "an unknown extra field beside events",
    body: { events: many(1), tenantRegion: "eu-west-1" },
    accepted: true,
    // Accepted rather than refused, which is what makes an additive optional
    // field a compatible change (ADR-049).
    route: "202, and the extra field is ignored"
  }
];

describe("the batch request shape", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  const validate: ValidateFunction = ajv.compile(built["batch-request"] ?? {});

  it.each(corpus.map((one) => [one.name, one] as const))(
    "%s: Zod and the generated schema agree",
    (_name, one) => {
      expect(batchRequestSchema.safeParse(one.body).success, one.route).toBe(one.accepted);
      expect(validate(one.body), one.route).toBe(one.accepted);
    }
  );

  it("caps the array at the constant, not at a copy of the number", () => {
    const events = built["batch-request"] as {
      properties: { events: { maxItems: number } };
    };
    expect(events.properties.events.maxItems).toBe(MAX_BATCH_EVENTS);
  });

  it("types the elements as anything, because the route refuses them per event", () => {
    // An array of envelopes would describe a server that refuses a whole batch
    // for one bad element, and this one does not.
    const events = built["batch-request"] as {
      properties: { events: { items: Record<string, unknown> } };
    };
    expect(events.properties.events.items).toEqual({});
    expect(batchRequestSchema.safeParse({ events: [1, "two", null] }).success).toBe(true);
  });
});

describe("the response shapes refer to their siblings rather than inlining them", () => {
  it.each([
    ["batch-response", ["properties", "data", "properties", "results", "items"], "event-result"],
    ["event-result", ["properties", "stored", "properties", "event"], "stored-event"],
    ["event-result", ["properties", "stored", "properties", "journey"], "stored-journey"]
  ])("%s refers to %s", (document, path, target) => {
    let node: unknown = built[document];
    for (const segment of path) node = (node as Record<string, unknown>)[segment];
    expect((node as { $ref: string }).$ref).toBe(`${target}.schema.json`);
  });
});

describe("the stored event timing projection", () => {
  const stored = {
    id: "evt_1",
    journeyId: "jrn_1",
    parentEventId: null,
    protocolVersion: "0.1",
    operation: "received",
    name: "receive-order",
    service: "orders",
    eventTimestamp: "2026-09-18T12:00:00.000Z",
    receivedAt: "2026-09-18T12:00:00.100Z",
    durationMs: 0,
    traceId: null,
    spanId: null,
    messageId: null,
    correlationId: null,
    hasInput: false,
    hasOutput: false,
    hasError: false,
    inputPayload: null,
    outputPayload: null,
    payloadDiff: null,
    error: null,
    runtimeMetadata: null,
    deploymentMetadata: null,
    customMetadata: null,
    aliases: []
  };

  it("publishes bounded timingContext and nullable recordedHost as additive fields", () => {
    const parsed = storedEventSchema.parse({
      ...stored,
      timingContext: {
        queue: "orders",
        queueWaitMs: 0,
        queueWaitBasis: "initial-enqueue",
        deliveryCount: 1,
        targetHost: "api.internal:8443",
        httpStatusCode: 429,
        retryAfterMs: 2_000,
        attempt: 1,
        retryGroup: 'queue:["orders","42"]'
      },
      recordedHost: null
    });
    expect(parsed).toMatchObject({
      timingContext: { queueWaitMs: 0, attempt: 1 },
      recordedHost: null
    });
    expect(storedEventSchema.safeParse(stored).success).toBe(true);
  });

  it("refuses timing output outside its public bounds", () => {
    expect(
      storedEventSchema.safeParse({
        ...stored,
        timingContext: { retryAfterMs: 2_147_483_648 },
        recordedHost: "host"
      }).success
    ).toBe(false);
    expect(
      storedEventSchema.safeParse({
        ...stored,
        timingContext: {},
        recordedHost: "x".repeat(257)
      }).success
    ).toBe(false);
  });
});
