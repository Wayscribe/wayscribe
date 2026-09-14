import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import {
  NO_FILTERS,
  applyFilters,
  describeCount,
  distinctServices,
  mergeEvents,
  neighbour
} from "./timeline";

let eventCounter = 0;

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  eventCounter += 1;
  return {
    id,
    operation: "received",
    name: `step-${id}`,
    service: "webhook-api",
    eventTimestamp: `2026-09-14T10:00:0${String(eventCounter)}.000Z`,
    receivedAt: `2026-09-14T10:00:0${String(eventCounter)}.500Z`,
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

  it("breaks a timestamp tie with receivedAt, then id, matching the server's order", () => {
    // Same millisecond eventTimestamp, and ids deliberately sorted the opposite
    // way from receivedAt: if the tie-break fell back to id instead of using
    // receivedAt, this would sort "evt_b_earlier" second instead of first.
    const earlier = event("evt_b_earlier", {
      eventTimestamp: "2026-09-14T10:05:00.000Z",
      receivedAt: "2026-09-14T10:05:00.100Z"
    });
    const later = event("evt_a_later", {
      eventTimestamp: "2026-09-14T10:05:00.000Z",
      receivedAt: "2026-09-14T10:05:00.200Z"
    });

    expect(mergeEvents([earlier, later], []).map((e) => e.id)).toEqual([
      "evt_b_earlier",
      "evt_a_later"
    ]);
    // The server's order does not depend on which array either copy arrived in.
    expect(mergeEvents([later, earlier], []).map((e) => e.id)).toEqual([
      "evt_b_earlier",
      "evt_a_later"
    ]);
    expect(mergeEvents([later], [earlier]).map((e) => e.id)).toEqual([
      "evt_b_earlier",
      "evt_a_later"
    ]);
  });

  it("does not mutate either input array", () => {
    const existing = [evt3, evt1];
    const incoming = [evt4, evt2];
    const existingBefore = [...existing];
    const incomingBefore = [...incoming];

    mergeEvents(existing, incoming);

    expect(existing).toEqual(existingBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it("collapses duplicate ids within incoming to the last one", () => {
    const older = event("evt_dup", { hasError: false });
    const newer = event("evt_dup", { hasError: true, eventTimestamp: older.eventTimestamp });
    const merged = mergeEvents([], [older, newer]);
    expect(merged).toHaveLength(1);
    expect(merged.find((e) => e.id === "evt_dup")?.hasError).toBe(true);
  });
});

describe("distinctServices", () => {
  it("lists distinct services in first-seen order", () => {
    expect(distinctServices(EVENTS)).toEqual(["webhook-api", "sync-worker"]);
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

  it("names the total when a filter hides some and pages remain unfetched", () => {
    // Otherwise "3 of 100 events shown" reads as though nothing more exists.
    expect(describeCount({ visible: 3, loaded: 100, total: 240, complete: false })).toBe(
      "3 of 100 loaded events shown, 240 in total"
    );
  });

  it("uses the singular for one event", () => {
    expect(describeCount({ visible: 1, loaded: 1, total: 1, complete: true })).toBe("1 event");
  });
});
