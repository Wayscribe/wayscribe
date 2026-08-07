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
    const continued = consumer.consume({
      context: consumer.fromQueueAttributes(attributes),
      entityFallback: { type: "customer", id: "42" }
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
    const continued = consumer.consume({
      context: consumer.extractHttpContext(headers),
      entityFallback: { type: "customer", id: "42" }
    });

    expect(continued.context().journeyId).toBe(journey.context().journeyId);
    expect(continued.context().entity.id).toBe("42");
  });

  it("starts a new journey when the inbound context is malformed", () => {
    const consumer = createRecorder(base);
    const continued = consumer.consume({
      context: consumer.fromQueueAttributes({ flightJourneyId: "forged" }),
      entityFallback: { type: "customer", id: "42" }
    });
    expect(continued.context().journeyId).toMatch(/^jrn_/);
    expect(continued.context().entity.id).toBe("42");
  });
});
