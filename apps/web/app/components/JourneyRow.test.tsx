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

const renderRow = (row: JourneyListRow, showEnvironment = false, listQuery = ""): HTMLElement => {
  render(
    <table>
      <tbody>
        <JourneyRow item={row} showEnvironment={showEnvironment} listQuery={listQuery} />
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

  it("treats a label of only whitespace as none, so the row's link is never blank", () => {
    for (const label of [" ", "\t\n", "\u00a0\u2003", "\ufeff"]) {
      expect(shownAs({ ...item, label }).kind).toBe("aliases");
    }
  });

  it("shows a label without the whitespace around it", () => {
    expect(shownAs({ ...item, label: "  Mirantis  " })).toEqual({
      kind: "label",
      text: "Mirantis"
    });
  });

  it("skips blank alias values, and falls back to the entity when every one is blank", () => {
    expect(
      shownAs({
        ...item,
        label: null,
        displayableAliases: [
          { type: "a", value: "  " },
          { type: "b", value: " Mirantis " }
        ]
      })
    ).toEqual({ kind: "aliases", text: "Mirantis" });
    expect(
      shownAs({
        ...item,
        label: " ",
        displayableAliases: [{ type: "a", value: "\u2003" }]
      })
    ).toEqual({ kind: "entity", text: "job_posting: 0018Z00002ABC" });
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

  it("adds the environment after the status only when asked", () => {
    const row = renderRow(item, true);
    expect(cells(row).slice(1, 4)).toEqual(["failed", "production", "job_posting"]);
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
    expect(link.getAttribute("href")).toBe("/journeys/jrn%2F1%20a?from=journeys");
    expect(link.getAttribute("title")).toBe(item.label);
    expect(link.className).toContain("shown-label");
  });

  it("carries the list's query, so the journey page can lead back to it", () => {
    const row = renderRow(item, false, "q=acme&cursor=abc");
    expect(within(row).getByRole("link").getAttribute("href")).toBe(
      "/journeys/jrn_1?from=journeys&list=q%3Dacme%26cursor%3Dabc"
    );
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

/**
 * ADR-063, F-047: a failed journey's last step can be a later step that
 * succeeded, so the Step column names the step that failed it when the API
 * says which one did.
 */
describe("JourneyRow's step", () => {
  const stepCell = (row: HTMLElement): HTMLElement => {
    const cell = within(row).getAllByRole("cell")[4];
    if (cell === undefined) throw new Error("no step cell");
    return cell;
  };

  it("shows the failed step of a failed journey, in the failed style, with both steps as a title", () => {
    const cell = stepCell(
      renderRow({ ...item, lastStep: "map-hubspot", failedStep: "push-hubspot" })
    );
    expect(cell.textContent).toBe("push-hubspot");
    expect(cell.className).toBe("col-step failed");
    expect(cell.getAttribute("title")).toBe("Failed at push-hubspot; last step map-hubspot");
  });

  it("shows the last step of a failed journey when the API sends no failed step", () => {
    // Null, and absent (`item` has no such field), as an older API sends it.
    for (const row of [{ ...item, failedStep: null }, item]) {
      const { unmount } = render(
        <table>
          <tbody>
            <JourneyRow item={{ ...row, lastStep: "map-hubspot" }} />
          </tbody>
        </table>
      );
      const cell = stepCell(screen.getByRole("row"));
      expect(cell.textContent).toBe("map-hubspot");
      expect(cell.className).toBe("col-step");
      expect(cell.getAttribute("title")).toBe("map-hubspot");
      unmount();
    }
  });

  // The API nulls it outside `failed`, and the row does not rely on that.
  it("shows the last step of a journey that is not failed, whatever failedStep holds", () => {
    const cell = stepCell(
      renderRow({
        ...item,
        status: "completed",
        lastStep: "finish",
        failedStep: "push-hubspot"
      })
    );
    expect(cell.textContent).toBe("finish");
    expect(cell.className).toBe("col-step");
    expect(cell.getAttribute("title")).toBe("finish");
  });

  it("titles a failed step with no last step by the failure alone", () => {
    const cell = stepCell(renderRow({ ...item, lastStep: null, failedStep: "push-hubspot" }));
    expect(cell.textContent).toBe("push-hubspot");
    expect(cell.getAttribute("title")).toBe("Failed at push-hubspot");
  });

  it("shows a step name holding markup as text", () => {
    const markup = '<img src="x" onerror="alert(1)">';
    const cell = stepCell(renderRow({ ...item, failedStep: markup }));
    expect(cell.textContent).toBe(markup);
    expect(cell.querySelector("img")).toBeNull();
  });
});
