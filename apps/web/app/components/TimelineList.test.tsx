import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventListItem } from "../../src/lib/api";
import { TimelineList } from "./TimelineList";
import { journeyClockCondition, presentTimelineTiming } from "../../src/lib/timing-presentation";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "transformed",
    name: `step-${id}`,
    service: "job-sweep",
    eventTimestamp: "2026-09-16T08:00:00.000Z",
    receivedAt: "2026-09-16T08:00:00.100Z",
    durationMs: null,
    hasInput: true,
    hasOutput: true,
    hasError: false,
    ...overrides
  };
}

function renderList(events: EventListItem[]): void {
  render(
    <TimelineList
      journeyId="jrn_1"
      events={events}
      selectedId={null}
      multiDay={false}
      onSelect={() => undefined}
      onArrow={() => undefined}
    />
  );
}

/**
 * A long journey is mostly one operation. Rows labelled by operation read
 * "transformed, transformed, transformed", so the step's own name leads.
 */
describe("TimelineList rows", () => {
  it("lead with the step name, and keep the operation and service beside it", () => {
    renderList([
      event("evt_1", { name: "normalize-greenhouse" }),
      event("evt_2", { name: "classify" }),
      event("evt_3", { name: "write-item-file", operation: "delivered", service: "notifier" })
    ]);
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.querySelector(".step")?.textContent)).toEqual([
      "normalize-greenhouse",
      "classify",
      "write-item-file"
    ]);
    const last = rows[2];
    if (last === undefined) throw new Error("no third row");
    expect(within(last).getByText("delivered").className).toBe("op");
    expect(within(last).getByText("notifier")).toBeTruthy();

    // The name comes before the operation in reading order.
    const text = last.textContent;
    expect(text.indexOf("write-item-file")).toBeLessThan(text.indexOf("delivered"));
  });

  it("keeps marking a failed operation", () => {
    renderList([event("evt_1", { name: "send-digest", operation: "delivered", hasError: true })]);
    expect(screen.getByText("delivered").className).toBe("op failed");
    expect(screen.getByText("send-digest").className).toContain("step");
  });

  it("falls back to the operation when an event has no name, without repeating it", () => {
    renderList([event("evt_1", { name: "", operation: "received" })]);
    const row = screen.getByRole("option");
    expect(row.querySelector(".step")?.textContent).toBe("received");
    expect(within(row).getAllByText("received")).toHaveLength(1);
  });

  it("puts the name on its own line and the operation, service and badges on a second", () => {
    renderList([
      event("evt_1", {
        name: "receive-salesforce-webhook",
        service: "demo-integration",
        timingContext: { attempt: 2 }
      })
    ]);
    const row = screen.getByRole("option");
    const link = row.querySelector("a");
    // The link's own children: time, the whole name, then the meta line.
    expect([...(link?.children ?? [])].map((child) => child.className)).toEqual([
      "mono time",
      "step",
      "row-meta"
    ]);
    const meta = row.querySelector(".row-meta");
    expect(meta?.textContent).toBe("transformeddemo-integrationattempt 2");
    expect(row.querySelector(".step")?.textContent).toBe("receive-salesforce-webhook");
  });

  it("badges a late-arriving row only when it is not the whole journey", () => {
    const late = { receivedAt: "2026-09-16T08:10:00.000Z" };
    const events = [event("evt_1"), event("evt_2", late), event("evt_3")];
    const { unmount } = render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.querySelector(".clock-badge")?.textContent ?? null)).toEqual([
      null,
      "⚠ clock",
      null
    ]);
    unmount();

    // Every event late: the journey says so once, and no row repeats it.
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events.map((item) => ({ ...item, ...late }))}
        clock={{ caveat: null, allSkewed: true, hostless: false }}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    expect(screen.queryByText("⚠ clock")).toBeNull();
  });

  it("leaves out only the caveat the journey already states", () => {
    const events = [
      event("evt_1"),
      event("evt_2", { recordedHost: "host-a" }),
      event("evt_3", { recordedHost: "host-b" })
    ];
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        timing={presentTimelineTiming(events)}
        clock={{
          caveat: "Clock comparison is uncertain because recorded host evidence is missing.",
          allSkewed: false,
          hostless: false
        }}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    const caveats = [...document.querySelectorAll(".clock-caveat")].map((item) => item.textContent);
    expect(caveats).toEqual([
      "Clock comparison is uncertain because these events came from different recorded hosts."
    ]);
  });

  // ADR-071: a journey with no recorded host says so in About this view, so
  // no row carries the caveat, and each row's gap line keeps its own words.
  it("keeps every gap line and puts no caveat on any row of a hostless journey", () => {
    const variants: [EventListItem[], string[]][] = [
      [
        [
          event("evt_1", { durationMs: null }),
          event("evt_2", { eventTimestamp: "2026-09-16T08:00:00.012Z", durationMs: 35 }),
          event("evt_3", { eventTimestamp: "2026-09-16T08:00:00.034Z" })
        ],
        [
          "Recorded gap: unknown (start-to-start 12 ms)",
          "Recorded gap: 13 ms overlap / clock disagreement"
        ]
      ],
      [
        [
          event("evt_1", { durationMs: 100, recordedHost: null }),
          event("evt_2", { eventTimestamp: "2026-09-16T08:00:00.500Z", recordedHost: null })
        ],
        ["Recorded gap: 400 ms"]
      ]
    ];
    for (const [events, gaps] of variants) {
      const timing = presentTimelineTiming(events);
      const clock = journeyClockCondition(events, timing);
      expect(clock.hostless).toBe(true);
      const { unmount } = render(
        <TimelineList
          journeyId="jrn_1"
          events={events}
          timing={timing}
          clock={clock}
          selectedId={null}
          multiDay={false}
          onSelect={() => undefined}
          onArrow={() => undefined}
        />
      );
      expect(document.querySelectorAll(".clock-caveat")).toHaveLength(0);
      expect(
        [...document.querySelectorAll(".timeline-gap > span:first-child")].map(
          (item) => item.textContent
        )
      ).toEqual(gaps);
      unmount();
    }
  });

  it("still badges the one late row of a hostless journey", () => {
    const events = [
      event("evt_1"),
      event("evt_2", { receivedAt: "2026-09-16T08:10:00.000Z" }),
      event("evt_3")
    ];
    const timing = presentTimelineTiming(events);
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        timing={timing}
        clock={journeyClockCondition(events, timing)}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.querySelector(".clock-badge")?.textContent ?? null)).toEqual([
      null,
      "⚠ clock",
      null
    ]);
  });

  it("names what the badge is when hovered", () => {
    renderList([event("evt_1", { name: "classify" })]);
    const badge = screen.getByText("transformed");
    expect(badge.getAttribute("title")).toBe("operation: transformed");
  });

  it("shows the gap derived from loaded adjacency and keeps overlap explicit", () => {
    const events = [
      event("evt_1", { durationMs: 150, recordedHost: "host-a" }),
      event("evt_2", {
        eventTimestamp: "2026-09-16T08:00:00.100Z",
        recordedHost: "host-b"
      })
    ];
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        timing={presentTimelineTiming(events)}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    expect(screen.getByText("Recorded gap: 50 ms overlap / clock disagreement")).toBeTruthy();
    expect(screen.getByText(/different recorded hosts/)).toBeTruthy();
  });

  it("keeps a backwards start-to-start interval explicit when idle time is unknown", () => {
    const events = [
      event("evt_1", { durationMs: null, recordedHost: "host-a" }),
      event("evt_2", {
        eventTimestamp: "2026-09-16T07:59:59.500Z",
        recordedHost: "host-a"
      })
    ];
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        timing={presentTimelineTiming(events)}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    expect(
      screen.getByText("Recorded gap: unknown (start-to-start 500 ms overlap / clock disagreement)")
    ).toBeTruthy();
  });

  it("qualifies publish-to-consume evidence for positive, unknown, and overlap states", () => {
    const events = [
      event("publish-gap", { operation: "published", durationMs: 100 }),
      event("consume-gap", {
        operation: "consumed",
        eventTimestamp: "2026-09-16T08:00:00.200Z",
        durationMs: 0
      }),
      event("publish-unknown", {
        operation: "published",
        eventTimestamp: "2026-09-16T08:00:00.300Z",
        durationMs: null
      }),
      event("consume-unknown", {
        operation: "consumed",
        eventTimestamp: "2026-09-16T08:00:00.500Z",
        durationMs: 0
      }),
      event("publish-overlap", {
        operation: "published",
        eventTimestamp: "2026-09-16T08:00:00.600Z",
        durationMs: 200
      }),
      event("consume-overlap", {
        operation: "consumed",
        eventTimestamp: "2026-09-16T08:00:00.700Z"
      })
    ];
    render(
      <TimelineList
        journeyId="jrn_1"
        events={events}
        timing={presentTimelineTiming(events)}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );

    expect(screen.getByText("Publish → consume gap: 100 ms")).toBeTruthy();
    expect(screen.getByText("Publish → consume gap: unknown (start-to-start 200 ms)")).toBeTruthy();
    expect(
      screen.getByText("Publish → consume gap: 100 ms overlap / clock disagreement")
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        "Adjacent events do not prove a matching message; this is not broker-measured queue wait."
      )
    ).toHaveLength(3);
  });
});

/**
 * F-043: each row names the build that recorded it, the way it names the
 * service, so whether a journey came from one build reads down the list.
 */
describe("TimelineList builds", () => {
  const build = {
    label: "1.4.2 · 3cd2c2034c6d",
    title: "Recorded by version 1.4.2, commit 3cd2c2034c6d3607"
  };

  it("names each row's build, with the whole of it on hover", () => {
    renderList([
      event("evt_1", { build }),
      event("evt_2", { build: { label: "1.5.0", title: "Recorded by version 1.5.0" } })
    ]);
    const shown = screen.getAllByRole("option").map((row) => row.querySelector(".build"));
    expect(shown.map((span) => span?.textContent)).toEqual(["1.4.2 · 3cd2c2034c6d", "1.5.0"]);
    expect(shown[0]?.getAttribute("title")).toBe(build.title);
  });

  it("names none on a row whose event carried none, or from an older API", () => {
    renderList([event("evt_1", { build: null }), event("evt_2")]);
    for (const row of screen.getAllByRole("option")) expect(row.querySelector(".build")).toBeNull();
  });

  it("comes after the service in reading order", () => {
    renderList([event("evt_1", { build })]);
    const text = screen.getByRole("option").textContent;
    expect(text.indexOf("job-sweep")).toBeLessThan(text.indexOf("1.4.2"));
  });

  it("renders markup in a build as text, never as elements", () => {
    const markup = '<img src="x" onerror="alert(1)">';
    const { container } = render(
      <TimelineList
        journeyId="jrn_1"
        events={[event("evt_1", { build: { label: markup, title: markup } })]}
        selectedId={null}
        multiDay={false}
        onSelect={() => undefined}
        onArrow={() => undefined}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".build")?.textContent).toBe(markup);
  });
});
