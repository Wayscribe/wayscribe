import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

describe("recorder propagation", () => {
  it("uses the configured level", () => {
    const recorder = createRecorder({ ...base, propagate: "full" });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "42" } });
    expect(recorder.injectHttpHeaders({}, journey.context())["x-flight-entity-id"]).toBe("42");
  });

  it("defaults to omitting the entity id", () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "42" } });
    expect(recorder.injectHttpHeaders({}, journey.context())["x-flight-entity-id"]).toBeUndefined();
  });

  it("continues a journey across a simulated process boundary", () => {
    const producer = createRecorder({ ...base, propagate: "full" });
    const journey = producer.startJourney({ entity: { type: "customer", id: "42" } });
    const attributes = producer.toQueueAttributes(journey.context());

    // A separate recorder instance, as a different process would have.
    const consumer = createRecorder(base);
    const continued = consumer.continueJourney({
      context: consumer.fromQueueAttributes(attributes),
      entity: { type: "customer", id: "42" }
    });

    expect(continued.context().journeyId).toBe(journey.context().journeyId);
  });

  it("continues across a boundary at the default level using the fallback entity", () => {
    // The default sends no entity id, which is the normal case: the consumer
    // supplies the entity it already has from the message body.
    const producer = createRecorder(base);
    const journey = producer.startJourney({ entity: { type: "customer", id: "42" } });
    const headers = producer.injectHttpHeaders({}, journey.context());

    const consumer = createRecorder(base);
    const continued = consumer.continueJourney({
      context: consumer.extractHttpContext(headers),
      entity: { type: "customer", id: "42" }
    });

    expect(continued.context().journeyId).toBe(journey.context().journeyId);
    expect(continued.context().entity.id).toBe("42");
  });

  it("starts a new journey when the inbound context is malformed", () => {
    const consumer = createRecorder(base);
    const continued = consumer.continueJourney({
      context: consumer.fromQueueAttributes({ flightJourneyId: "forged" }),
      entity: { type: "customer", id: "42" }
    });
    expect(continued.context().journeyId).toMatch(/^jrn_/);
    expect(continued.context().entity.id).toBe("42");
  });
});

describe("propagation cannot break the host", () => {
  const recorder = createRecorder({
    endpoint: "http://127.0.0.1:1",
    apiKey: "fr_test",
    serviceName: "relay",
    environment: "development"
  });

  it("returns the caller's headers when there is no context", () => {
    // The rollout failure: a relay does
    // injectHttpHeaders({}, extractHttpContext(req.headers)) and works for
    // every instrumented caller, then kills the process on the first
    // un-instrumented one. No headers is a degradation; no request is an
    // outage.
    const headers = { "content-type": "application/json" };
    const result = recorder.injectHttpHeaders(
      headers,
      undefined as unknown as { journeyId: string }
    );
    expect(result).toEqual(headers);
  });

  it("returns empty attributes rather than throwing", () => {
    expect(recorder.toQueueAttributes(undefined as unknown as { journeyId: string })).toEqual({});
  });

  it("returns the payload rather than throwing", () => {
    const payload = { id: 1 };
    const wrapped = recorder.wrapPayload(payload, undefined as unknown as { journeyId: string });
    expect(wrapped.data).toEqual(payload);
  });

  it("survives junk on the extract side", () => {
    expect(recorder.extractHttpContext(undefined)).toBeUndefined();
    expect(recorder.fromQueueAttributes("not an object")).toBeUndefined();
    expect(recorder.unwrapPayload(null).data).toBeNull();
  });

  it("still propagates properly when the context is real", () => {
    // The control: fallbacks that always fired would pass every test above.
    const context = { journeyId: "jrn_1111", entity: { type: "customer", id: "C1" } };
    expect(recorder.injectHttpHeaders({}, context)["x-flight-journey-id"]).toBe("jrn_1111");
  });
});

describe("an entity id that cannot be a header value", () => {
  const full = createRecorder({
    endpoint: "http://127.0.0.1:1",
    apiKey: "fr_test",
    serviceName: "svc",
    environment: "development",
    propagate: "full"
  });

  it.each([
    ["a non-ASCII id", "顧客-42"],
    ["a carriage return", "C123\r"],
    ["a slash", "ORD/2024/0012"],
    ["a space", "cus 42"]
  ])("omits %s rather than emitting it", (_label, id) => {
    // Unvalidated, these either threw out of the caller's own fetch or were
    // injected and then silently dropped by the consumer — so the level the
    // developer explicitly opted into quietly did nothing.
    const headers = full.injectHttpHeaders(
      {},
      {
        journeyId: "jrn_2222",
        entity: { type: "customer", id }
      }
    );
    expect(headers["x-flight-entity-id"]).toBeUndefined();
    expect(headers["x-flight-journey-id"]).toBe("jrn_2222");
  });

  it("still emits an ordinary id", () => {
    const headers = full.injectHttpHeaders(
      {},
      {
        journeyId: "jrn_2222",
        entity: { type: "customer", id: "0018Z00002ABC" }
      }
    );
    expect(headers["x-flight-entity-id"]).toBe("0018Z00002ABC");
  });
});
