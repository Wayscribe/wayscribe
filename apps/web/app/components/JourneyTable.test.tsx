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
      "Status",
      "Environment",
      "Entity type",
      "Shown as",
      "Last step",
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
    expect(within(table).getAllByRole("cell")).toHaveLength(6);
  });

  it("uses column headers with a scope", () => {
    const table = renderTable({});
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header.tagName).toBe("TH");
      expect(header.getAttribute("scope")).toBe("col");
    }
  });
});
