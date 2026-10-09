import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JourneyListRow } from "../../src/lib/api";
import { readJourneyFilters } from "../../src/lib/journey-filters";
import { JourneyTable } from "./JourneyTable";

const NOW = new Date("2026-09-15T12:00:00.000Z");

const item: JourneyListRow = {
  journeyId: "jrn_1",
  entity: { type: "job_posting", id: "0018Z00002ABC" },
  status: "failed",
  eventCount: 14,
  startedAt: "2026-09-15T10:31:02.000Z",
  lastEventAt: "2026-09-15T10:34:38.000Z",
  environment: "production",
  label: "Mirantis · Senior SWE",
  lastStep: "audit-needs-review",
  displayableAliases: []
};

const renderTable = (params: Record<string, string>): HTMLElement => {
  render(<JourneyTable filters={readJourneyFilters(params, NOW)} items={[item]} />);
  return screen.getByRole("table");
};

/** What a screen reader hears for each header. */
const headers = (table: HTMLElement): string[] =>
  within(table)
    .getAllByRole("columnheader")
    .map((header) => header.textContent);

describe("JourneyTable", () => {
  it("is named by its caption, which states the filters", () => {
    renderTable({ status: "failed" });
    expect(
      screen.getByRole("table", { name: "Failed journeys in the last 24 hours, all environments" })
    ).toBeTruthy();
  });

  it("names each row's environment when the list spans environments", () => {
    const table = renderTable({});
    expect(headers(table)).toEqual([
      "Last activity",
      "Recorded span",
      "Status",
      "Environment",
      "Entity type",
      "Shown as",
      "Step",
      "Events"
    ]);
    const row = within(table).getAllByRole("row")[1];
    expect(
      row === undefined
        ? []
        : within(row)
            .getAllByRole("cell")
            .map((c) => c.textContent)
    ).toEqual([
      "2026-09-15 10:34",
      "3m 36s",
      "failed",
      "production",
      "job_posting",
      "Mirantis · Senior SWE",
      "audit-needs-review",
      "14"
    ]);
  });

  it("leaves the environment out when one is chosen, since every row shares it", () => {
    const table = renderTable({ environment: "production" });
    expect(headers(table)).not.toContain("Environment");
    expect(within(table).queryByText("production")).toBeNull();
    expect(within(table).getAllByRole("cell")).toHaveLength(7);
  });

  it("states its table roles, so a phone's cards stay a table to a screen reader", () => {
    // A phone restyles the rows with `display` (globals.css), which strips the
    // implicit table roles in some browsers; the explicit ones keep them.
    const table = renderTable({});
    expect(table).toHaveAttribute("role", "table");
    for (const group of table.querySelectorAll("thead, tbody")) {
      expect(group).toHaveAttribute("role", "rowgroup");
    }
    for (const row of table.querySelectorAll("tr")) expect(row).toHaveAttribute("role", "row");
    for (const header of table.querySelectorAll("th")) {
      expect(header).toHaveAttribute("role", "columnheader");
    }
    for (const cell of table.querySelectorAll("td")) expect(cell).toHaveAttribute("role", "cell");
  });

  it("names each header in full, with no second label for narrow screens", () => {
    const table = renderTable({});
    expect(headers(table)).toEqual([
      "Last activity",
      "Recorded span",
      "Status",
      "Environment",
      "Entity type",
      "Shown as",
      "Step",
      "Events"
    ]);
    expect(table.querySelector("[aria-hidden]")).toBeNull();
  });

  it("uses column headers with a scope", () => {
    const table = renderTable({});
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header.tagName).toBe("TH");
      expect(header.getAttribute("scope")).toBe("col");
    }
  });

  it("explains that recorded span is between event starts", () => {
    const table = renderTable({});
    const span = within(table).getByRole("columnheader", { name: "Recorded span" });
    expect(span.getAttribute("title")).toContain("first recorded event start");
  });
});
