import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import {
  NO_FILTERS,
  applyFilters,
  describeCount,
  mergeEvents,
  neighbour,
  services
} from "./timeline";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "received",
    name: `step-${id}`,
    service: "webhook-api",
    eventTimestamp: `2026-09-14T10:00:0${id.slice(-1)}.000Z`,
    receivedAt: `2026-09-14T10:00:0${id.slice(-1)}.500Z`,
    durationMs: null,
    hasInput: true,
    hasOutput: false,
    hasError: false,
    ...overrides
  };
}

const evt1 = event("evt_1");
const evt2 = event("evt_2", { service: "sync-worker" });
const evt3 = event("evt_3", { service: "sync-worker", hasError: true });
const evt4 = event("evt_4", { hasError: true });

const EVENTS = [evt1, evt2, evt3, evt4];

describe("applyFilters", () => {
  it("returns everything with no filters, in order", () => {
    expect(applyFilters(EVENTS, NO_FILTERS).map((e) => e.id)).toEqual([
      "evt_1",
      "evt_2",
      "evt_3",
      "evt_4"
    ]);
  });

  it("narrows to one service", () => {
    expect(
      applyFilters(EVENTS, { service: "sync-worker", failuresOnly: false }).map((e) => e.id)
    ).toEqual(["evt_2", "evt_3"]);
  });

  it("narrows to failures, and combines with the service", () => {
    expect(applyFilters(EVENTS, { service: null, failuresOnly: true }).map((e) => e.id)).toEqual([
      "evt_3",
      "evt_4"
    ]);
    expect(
      applyFilters(EVENTS, { service: "sync-worker", failuresOnly: true }).map((e) => e.id)
    ).toEqual(["evt_3"]);
  });
});

describe("neighbour", () => {
  it("moves one step and stops at the edges", () => {
    expect(neighbour(EVENTS, "evt_2", "down")).toBe("evt_3");
    expect(neighbour(EVENTS, "evt_2", "up")).toBe("evt_1");
    expect(neighbour(EVENTS, "evt_4", "down")).toBe("evt_4");
    expect(neighbour(EVENTS, "evt_1", "up")).toBe("evt_1");
  });

  it("lands on the first visible event when the selection is not visible", () => {
    const failures = applyFilters(EVENTS, { service: null, failuresOnly: true });
    expect(neighbour(failures, "evt_1", "down")).toBe("evt_3");
    expect(neighbour(failures, null, "up")).toBe("evt_3");
  });

  it("returns null for an empty list", () => {
    expect(neighbour([], "evt_1", "down")).toBeNull();
  });
});

describe("mergeEvents", () => {
  it("unions by id and orders by timestamp then id", () => {
    const merged = mergeEvents([evt2, evt4], [evt1, evt3]);
    expect(merged.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4"]);
  });

  it("is idempotent, and a newer copy of an event replaces the older one", () => {
    const once = mergeEvents(EVENTS, EVENTS);
    expect(once).toHaveLength(4);
    const updated = mergeEvents(once, [event("evt_2", { hasError: true })]);
    expect(updated.find((e) => e.id === "evt_2")?.hasError).toBe(true);
    expect(updated).toHaveLength(4);
  });
});

describe("services", () => {
  it("lists distinct services in first-seen order", () => {
    expect(services(EVENTS)).toEqual(["webhook-api", "sync-worker"]);
  });
});

describe("describeCount", () => {
  it("states the plain count when everything is loaded and shown", () => {
    expect(describeCount({ visible: 10, loaded: 10, total: 10, complete: true })).toBe("10 events");
  });

  it("says how many are loaded when more exist", () => {
    expect(describeCount({ visible: 100, loaded: 100, total: 240, complete: false })).toBe(
      "showing 100 of 240 events"
    );
  });

  it("says how many are shown when a filter hides some", () => {
    expect(describeCount({ visible: 2, loaded: 10, total: 10, complete: true })).toBe(
      "2 of 10 events shown"
    );
  });

  it("never reports a total below what is loaded", () => {
    // A live journey can deliver events before the count catches up.
    expect(describeCount({ visible: 12, loaded: 12, total: 10, complete: true })).toBe("12 events");
  });
});
