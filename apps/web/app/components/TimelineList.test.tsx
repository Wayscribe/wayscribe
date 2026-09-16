import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventListItem } from "../../src/lib/api";
import { TimelineList } from "./TimelineList";

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

  it("names what the badge is when hovered", () => {
    renderList([event("evt_1", { name: "classify" })]);
    const badge = screen.getByText("transformed");
    expect(badge.getAttribute("title")).toBe("operation: transformed");
  });
});
