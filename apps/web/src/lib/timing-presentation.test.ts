import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import {
  HOSTLESS_CLOCK_NOTE,
  isSkewed,
  journeyClockCondition,
  journeyClockNotice,
  journeySpan,
  formatDuration,
  presentTimelineTiming,
  retryGroups,
  type JourneyClockCondition,
  type TimelineTiming
} from "./timing-presentation";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "received",
    name: "sync-customer",
    service: "worker",
    eventTimestamp: "2026-09-18T10:00:00.000Z",
    receivedAt: "2026-09-18T10:00:00.100Z",
    durationMs: null,
    hasInput: false,
    hasOutput: false,
    hasError: false,
    ...overrides
  };
}

const byId = (timing: readonly TimelineTiming[], id: string): TimelineTiming => {
  const found = timing.find((item) => item.eventId === id);
  if (found === undefined) throw new Error(`missing timing for ${id}`);
  return found;
};

describe("journeySpan", () => {
  it("measures the first-to-last recorded event-start span, including a true zero", () => {
    expect(journeySpan("2026-09-18T10:00:00.000Z", "2026-09-18T10:00:00.000Z")).toBe(0);
    expect(journeySpan("2026-09-18T10:00:00.000Z", "2026-09-18T10:00:02.500Z")).toBe(2500);
  });

  it("returns null rather than zero for invalid or backwards timestamps", () => {
    expect(journeySpan("not-a-date", "2026-09-18T10:00:00.000Z")).toBeNull();
    expect(journeySpan("2026-09-18T10:00:01.000Z", "2026-09-18T10:00:00.000Z")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("keeps sub-second evidence exact and makes longer spans scan quickly", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(216000)).toBe("3m 36s");
    expect(formatDuration(7_200_000)).toBe("2h 0m");
  });
});

describe("timeline adjacency timing", () => {
  it("keeps zero, positive gaps, and overlaps distinct", () => {
    const timing = presentTimelineTiming([
      event("zero-before", { durationMs: 100 }),
      event("zero-after", { eventTimestamp: "2026-09-18T10:00:00.100Z", durationMs: 0 }),
      event("gap-after", { eventTimestamp: "2026-09-18T10:00:00.350Z", durationMs: 300 }),
      event("overlap-after", { eventTimestamp: "2026-09-18T10:00:00.600Z" })
    ]);

    expect(byId(timing, "zero-after").gapBefore).toMatchObject({ kind: "gap", milliseconds: 0 });
    expect(byId(timing, "gap-after").gapBefore).toMatchObject({ kind: "gap", milliseconds: 250 });
    expect(byId(timing, "overlap-after").gapBefore).toMatchObject({
      kind: "overlap",
      milliseconds: -50
    });
  });

  it("keeps an unknown idle gap unknown when the previous duration is missing", () => {
    const timing = presentTimelineTiming([
      event("before", { durationMs: null }),
      event("after", { eventTimestamp: "2026-09-18T10:00:03.000Z" })
    ]);
    expect(byId(timing, "after").gapBefore).toEqual({
      kind: "unknown",
      startToStartMs: 3000,
      label: "Recorded gap"
    });
  });

  it("labels adjacent publish-to-consume timing without claiming broker measurement", () => {
    const timing = presentTimelineTiming([
      event("publish", { operation: "published", durationMs: 10 }),
      event("consume", {
        operation: "consumed",
        eventTimestamp: "2026-09-18T10:00:00.050Z"
      })
    ]);
    expect(byId(timing, "consume").gapBefore).toMatchObject({
      kind: "gap",
      milliseconds: 40,
      label: "Publish → consume gap"
    });
  });

  it("adds a clock caveat for different or unknown hosts, but not equal explicit hosts", () => {
    const timing = presentTimelineTiming([
      event("a", { durationMs: 10, recordedHost: "host-a" }),
      event("b", { eventTimestamp: "2026-09-18T10:00:00.020Z", recordedHost: "host-b" }),
      event("c", {
        eventTimestamp: "2026-09-18T10:00:00.040Z",
        durationMs: 10,
        recordedHost: null
      }),
      event("d", {
        eventTimestamp: "2026-09-18T10:00:00.060Z",
        durationMs: 10,
        recordedHost: "host-b"
      }),
      event("e", { eventTimestamp: "2026-09-18T10:00:00.080Z", recordedHost: "host-b" })
    ]);
    expect(byId(timing, "b").clockCaveat).toContain("different recorded hosts");
    expect(byId(timing, "d").clockCaveat).toContain("host evidence is missing");
    expect(byId(timing, "e").clockCaveat).toBeNull();
  });

  it("derives adjacency before callers filter the rows", () => {
    const all = [
      event("a", { service: "visible", durationMs: 100 }),
      event("hidden", {
        service: "hidden",
        eventTimestamp: "2026-09-18T10:00:00.200Z",
        durationMs: 100
      }),
      event("b", { service: "visible", eventTimestamp: "2026-09-18T10:00:00.400Z" })
    ];
    const timing = presentTimelineTiming(all);
    expect(byId(timing, "b").previousEventId).toBe("hidden");
    expect(byId(timing, "b").gapBefore).toMatchObject({ milliseconds: 100 });
  });
});

describe("journey-wide clock condition", () => {
  const MISSING = "Clock comparison is uncertain because recorded host evidence is missing.";
  const condition = (events: EventListItem[]): JourneyClockCondition =>
    journeyClockCondition(events, presentTimelineTiming(events));
  const late = { receivedAt: "2026-09-18T10:05:00.000Z" };

  it("lifts a caveat every comparable row shares to the journey, once", () => {
    // Some events record a host and some do not: the data shows missing
    // evidence, so it stays a warning.
    const events = [event("a"), event("b"), event("c", { recordedHost: "h2" })];
    expect(condition(events)).toEqual({ caveat: MISSING, allSkewed: false, hostless: false });
    expect(journeyClockNotice(condition(events))).toBe(`Applies to every step: ${MISSING}`);
  });

  // ADR-071: no host recorded anywhere is the Node SDK's normal condition.
  describe("a journey whose events record no host", () => {
    const nulled = { recordedHost: null };
    const variants: [string, EventListItem[]][] = [
      ["two events, host absent", [event("a"), event("b")]],
      ["three events, host absent", [event("a"), event("b"), event("c")]],
      ["host null", [event("a", nulled), event("b", nulled), event("c", nulled)]],
      ["null and absent mixed", [event("a", nulled), event("b"), event("c")]],
      [
        "several services with durations",
        [
          event("a", { service: "api", durationMs: 12 }),
          event("b", { service: "worker", durationMs: 30 }),
          event("c", { service: "mailer", durationMs: null })
        ]
      ]
    ];

    for (const [label, events] of variants) {
      it(`gives no warning when received promptly: ${label}`, () => {
        expect(condition(events)).toEqual({ caveat: MISSING, allSkewed: false, hostless: true });
        expect(journeyClockNotice(condition(events))).toBeNull();
      });

      it(`warns with only the late-receipt sentence when every event is late: ${label}`, () => {
        const lateEvents = events.map((item) => ({ ...item, ...late }));
        expect(condition(lateEvents)).toEqual({ caveat: MISSING, allSkewed: true, hostless: true });
        expect(journeyClockNotice(condition(lateEvents))).toBe(
          "Applies to every step: Every event was received more than two minutes after its recorded time."
        );
      });
    }

    it("keeps the row caveat lifted, so it moves to About and is not repeated per row", () => {
      // The caveat is still the shared one rows compare against.
      expect(condition([event("a"), event("b")]).caveat).toBe(MISSING);
    });

    it("is not hostless when any one event records a host, wherever it sits", () => {
      for (const at of [0, 1, 2]) {
        const events = [event("a"), event("b"), event("c")].map((item, index) =>
          index === at ? { ...item, recordedHost: "h1" } : item
        );
        expect(condition(events).hostless).toBe(false);
        expect(journeyClockNotice(condition(events))).toBe(`Applies to every step: ${MISSING}`);
      }
    });

    it("is not hostless with one event or none: there is no gap to qualify", () => {
      expect(condition([event("a")]).hostless).toBe(false);
      expect(condition([]).hostless).toBe(false);
    });

    it("says it in a neutral sentence that does not read as a warning", () => {
      expect(HOSTLESS_CLOCK_NOTE).toBe(
        "These events do not record a host, so a gap between steps may compare times from different processes; a small negative gap can be clock disagreement rather than overlap."
      );
      expect(HOSTLESS_CLOCK_NOTE).not.toMatch(/uncertain|⚠|warning/i);
    });
  });

  it("keeps the warning for events from different recorded hosts, late or not", () => {
    const DIFFERENT =
      "Clock comparison is uncertain because these events came from different recorded hosts.";
    const events = [
      event("a", { recordedHost: "h1" }),
      event("b", { recordedHost: "h2" }),
      event("c", { recordedHost: "h3" })
    ];
    expect(condition(events)).toEqual({ caveat: DIFFERENT, allSkewed: false, hostless: false });
    expect(journeyClockNotice(condition(events))).toBe(`Applies to every step: ${DIFFERENT}`);
    const lateEvents = events.map((item) => ({ ...item, ...late }));
    expect(journeyClockNotice(condition(lateEvents))).toBe(
      `Applies to every step: ${DIFFERENT} Every event was received more than two minutes after its recorded time.`
    );
  });

  it("lifts nothing when one comparable row differs from the rest", () => {
    // a→b same host (no caveat), b→c different hosts: not uniform.
    const events = [
      event("a", { recordedHost: "h1" }),
      event("b", { recordedHost: "h1" }),
      event("c", { recordedHost: "h2" })
    ];
    expect(condition(events).caveat).toBeNull();
    // A known host beside a missing one is still missing evidence: uniform.
    expect(condition([event("a"), event("b"), event("c", { recordedHost: "h2" })]).caveat).toBe(
      MISSING
    );
    expect(
      condition([
        event("a", { recordedHost: "h1" }),
        event("b", { recordedHost: "h2" }),
        event("c")
      ]).caveat
    ).toBeNull(); // different hosts, then missing: two caveats, so neither is lifted
  });

  it("lifts nothing from a journey with no comparable row", () => {
    expect(condition([event("a")])).toEqual({ caveat: null, allSkewed: false, hostless: false });
    expect(condition([])).toEqual({ caveat: null, allSkewed: false, hostless: false });
    expect(journeyClockNotice({ caveat: null, allSkewed: false, hostless: false })).toBeNull();
  });

  it("calls late arrival journey-wide only when every event arrived late, and two or more did", () => {
    expect(condition([event("a", late), event("b", late)]).allSkewed).toBe(true);
    expect(condition([event("a", late), event("b")]).allSkewed).toBe(false);
    expect(condition([event("a", late)]).allSkewed).toBe(false);
    expect(isSkewed(event("a", late))).toBe(true);
    expect(isSkewed(event("a"))).toBe(false);
    expect(journeyClockNotice({ caveat: MISSING, allSkewed: true, hostless: false })).toBe(
      `Applies to every step: ${MISSING} Every event was received more than two minutes after its recorded time.`
    );
  });
});

describe("recorded retry groups", () => {
  it("groups only explicit identities and reports each attempt outcome", () => {
    const groups = retryGroups(
      [
        event("one", {
          operation: "failed",
          durationMs: 100,
          timingContext: { attempt: 1, retryGroup: "job-7" }
        }),
        event("between", {
          name: "unrelated-step",
          eventTimestamp: "2026-09-18T10:00:00.500Z",
          recordedHost: "host-c"
        }),
        event("two", {
          operation: "retried",
          eventTimestamp: "2026-09-18T10:00:00.250Z",
          timingContext: { attempt: 2, retryGroup: "job-7" }
        }),
        event("unlinked", { timingContext: { attempt: 1 } })
      ],
      true
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.attempts).toEqual([
      expect.objectContaining({ eventId: "one", number: 1, outcome: "failed" }),
      expect.objectContaining({ eventId: "two", number: 2, outcome: "succeeded", delayMs: 150 })
    ]);
    expect(groups[0]?.issues).toEqual([]);
  });

  it("labels duplicate and skipped attempt numbers instead of guessing delays", () => {
    const groups = retryGroups(
      [
        event("one-a", { timingContext: { attempt: 1, retryGroup: "job-7" } }),
        event("one-b", {
          eventTimestamp: "2026-09-18T10:00:00.100Z",
          timingContext: { attempt: 1, retryGroup: "job-7" }
        }),
        event("three", {
          eventTimestamp: "2026-09-18T10:00:00.300Z",
          timingContext: { attempt: 3, retryGroup: "job-7" }
        })
      ],
      true
    );
    expect(groups[0]?.issues).toEqual([
      "Attempt 1 is duplicated in the loaded events.",
      "Attempt 2 is missing from the loaded events."
    ]);
    expect(groups[0]?.attempts.every((attempt) => attempt.delayMs === null)).toBe(true);
  });

  it("compacts huge sparse missing ranges with output bounded by loaded evidence", () => {
    const groups = retryGroups(
      [
        event("one", { timingContext: { attempt: 1, retryGroup: "job-sparse" } }),
        event("huge", {
          timingContext: { attempt: Number.MAX_SAFE_INTEGER, retryGroup: "job-sparse" }
        })
      ],
      true
    );

    expect(groups[0]?.issues).toEqual([
      `Attempts 2–${String(Number.MAX_SAFE_INTEGER - 1)} are missing from the loaded events.`
    ]);
  });

  it("keeps grouped events with unknown attempt numbers and reports leading gaps", () => {
    const groups = retryGroups(
      [
        event("unknown", {
          operation: "failed",
          timingContext: { retryGroup: "job-7" }
        }),
        event("three", { timingContext: { attempt: 3, retryGroup: "job-7" } })
      ],
      true
    );

    expect(groups[0]?.attempts).toEqual([
      expect.objectContaining({ eventId: "unknown", number: null, outcome: "failed" }),
      expect.objectContaining({ eventId: "three", number: 3, outcome: "succeeded" })
    ]);
    expect(groups[0]?.issues).toEqual([
      "1 loaded event has no valid attempt number.",
      "Attempts 1–2 are missing from the loaded events."
    ]);
  });

  it("attaches clock uncertainty from the actual pair used for an observed retry delay", () => {
    const differentHosts = retryGroups(
      [
        event("one", {
          durationMs: 100,
          recordedHost: "host-a",
          timingContext: { attempt: 1, retryGroup: "job-7" }
        }),
        event("between-hosts", {
          name: "unrelated-step",
          eventTimestamp: "2026-09-18T10:00:00.500Z",
          recordedHost: "host-c"
        }),
        event("two", {
          eventTimestamp: "2026-09-18T10:00:01.100Z",
          recordedHost: "host-b",
          timingContext: { attempt: 2, retryGroup: "job-7" }
        })
      ],
      true
    );
    expect(differentHosts[0]?.attempts[1]).toMatchObject({
      delayMs: 1000,
      delayClockCaveat:
        "Clock comparison for this observed retry delay is uncertain because the attempts came from different recorded hosts."
    });

    const missingHost = retryGroups(
      [
        event("one", {
          durationMs: 100,
          recordedHost: "host-a",
          timingContext: { attempt: 1, retryGroup: "job-8" }
        }),
        event("two", {
          eventTimestamp: "2026-09-18T10:00:01.100Z",
          recordedHost: null,
          timingContext: { attempt: 2, retryGroup: "job-8" }
        })
      ],
      true
    );
    expect(missingHost[0]?.attempts[1]?.delayClockCaveat).toContain(
      "recorded host evidence is missing"
    );
  });

  it("makes missing duration, overlap, and incomplete loaded pages explicit", () => {
    const missing = retryGroups(
      [
        event("one", { timingContext: { attempt: 1, retryGroup: "job-7" } }),
        event("two", {
          eventTimestamp: "2026-09-18T10:00:00.100Z",
          timingContext: { attempt: 2, retryGroup: "job-7" }
        })
      ],
      false
    );
    expect(missing[0]?.issues).toContain(
      "Observed retry delay is unknown because attempt 1 has no duration."
    );
    expect(missing[0]?.issues).toContain(
      "Only loaded events are included; later attempts may exist."
    );

    const overlap = retryGroups(
      [
        event("one", { durationMs: 200, timingContext: { attempt: 1, retryGroup: "job-8" } }),
        event("two", {
          eventTimestamp: "2026-09-18T10:00:00.100Z",
          timingContext: { attempt: 2, retryGroup: "job-8" }
        })
      ],
      true
    );
    expect(overlap[0]?.issues).toContain(
      "Attempt 2 overlaps attempt 1 or their clocks disagree; no retry delay is claimed."
    );
  });
});
