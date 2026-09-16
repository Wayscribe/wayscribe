import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JourneyListRow } from "../../src/lib/api";
import { fullTimestamp } from "../../src/lib/time";
import { JourneyRow, SHOWN_AS_LIMIT, shownAs } from "./JourneyRow";

const item: JourneyListRow = {
  journeyId: "jrn_1",
  entity: { type: "job_posting", id: "0018Z00002ABC" },
  status: "failed",
  eventCount: 14,
  startedAt: "2026-09-15T10:31:02.000Z",
  lastEventAt: "2026-09-15T10:34:38.000Z",
  environment: "production",
  label: "Mirantis · Senior SWE, AI Infra",
  lastStep: "audit-needs-review",
  displayableAliases: [
    { type: "company", value: "Mirantis" },
    { type: "url", value: "https://jobs.example.test/mirantis/1" }
  ]
};

const renderRow = (row: JourneyListRow): HTMLElement => {
  render(
    <table>
      <tbody>
        <JourneyRow item={row} />
      </tbody>
    </table>
  );
  return screen.getByRole("row");
};

const cells = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

describe("shownAs", () => {
  it("prefers the label", () => {
    expect(shownAs(item)).toEqual({ kind: "label", text: "Mirantis · Senior SWE, AI Infra" });
  });

  it("falls back to the displayable alias values, joined in the order the API gives", () => {
    expect(shownAs({ ...item, label: null })).toEqual({
      kind: "aliases",
      text: "Mirantis · https://jobs.example.test/mirantis/1"
    });
  });

  it("treats an empty label as none", () => {
    expect(shownAs({ ...item, label: "" }).kind).toBe("aliases");
  });

  it("falls back to the entity type and identifier when there is neither", () => {
    expect(shownAs({ ...item, label: null, displayableAliases: [] })).toEqual({
      kind: "entity",
      text: "job_posting: 0018Z00002ABC"
    });
    expect(
      shownAs({
        ...item,
        label: null,
        displayableAliases: [],
        entity: { type: "customer", id: null }
      })
    ).toEqual({ kind: "entity", text: "customer: —" });
  });

  it("cuts joined alias values short, by code point", () => {
    const long = "😀".repeat(150);
    const { text } = shownAs({
      ...item,
      label: null,
      displayableAliases: [
        { type: "a", value: long },
        { type: "b", value: long }
      ]
    });
    expect(Array.from(text)).toHaveLength(SHOWN_AS_LIMIT);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith(long)).toBe(true);
  });
});

describe("JourneyRow", () => {
  it("shows one line per journey in the column order", () => {
    const row = renderRow(item);
    expect(cells(row)).toEqual([
      "2026-09-15 10:34",
      "failed",
      "job_posting",
      "Mirantis · Senior SWE, AI Infra",
      "audit-needs-review",
      "14"
    ]);
  });

  it("gives the exact time on the time element", () => {
    const row = renderRow(item);
    const time = row.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-09-15T10:34:38.000Z");
    expect(time?.getAttribute("title")).toBe(fullTimestamp(item.lastEventAt));
  });

  it("links what it is shown as to the journey, with the full text as a title", () => {
    const row = renderRow({ ...item, journeyId: "jrn/1 a" });
    const link = within(row).getByRole("link", { name: item.label ?? "" });
    expect(link.getAttribute("href")).toBe("/journeys/jrn%2F1%20a");
    expect(link.getAttribute("title")).toBe(item.label);
    expect(link.className).toContain("shown-label");
  });

  it("marks alias and entity fallbacks so they read differently from a label", () => {
    const aliasRow = renderRow({ ...item, label: null });
    expect(within(aliasRow).getByRole("link").className).toContain("shown-aliases");
  });

  it("shows the entity fallback in a monospace face", () => {
    const row = renderRow({ ...item, label: null, displayableAliases: [] });
    const link = within(row).getByRole("link", { name: "job_posting: 0018Z00002ABC" });
    expect(link.className).toContain("mono");
  });

  it("marks a failure, and leaves the last step empty when there is none", () => {
    const row = renderRow({ ...item, lastStep: null });
    expect(within(row).getByText("failed").className).toBe("status failed");
    expect(cells(row)[4]).toBe("");
  });

  it("does not mark a status that is not a failure", () => {
    const row = renderRow({ ...item, status: "completed" });
    expect(within(row).getByText("completed").className).toBe("status");
  });
});
