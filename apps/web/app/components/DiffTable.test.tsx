import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DiffChange } from "../../src/lib/api";
import { displayChange, displayChanges, type DisplayedChange } from "../../src/lib/event-display";
import { DiffTable } from "./DiffTable";

/** The public demo's transform step: every field renamed, and phone lost on the way. */
const DEMO: DiffChange[] = [
  { path: "Id", kind: "removed", before: "0018Z00005PIN01" },
  { path: "Name", kind: "removed", before: "Dana Whitfield" },
  { path: "Phone", kind: "removed", before: "+1 555 0100" },
  { path: "Status__c", kind: "removed", before: "Active" },
  { path: "externalId", kind: "added", after: "0018Z00005PIN01" },
  { path: "name", kind: "added", after: "Dana Whitfield" },
  { path: "phone", kind: "added", after: null },
  { path: "status", kind: "added", after: "active" }
];

function changes(count: number): DisplayedChange[] {
  return Array.from({ length: count }, (_, i): DiffChange => ({
    path: `field${String(i)}`,
    kind: "changed",
    before: i,
    after: i + 1
  })).map(displayChange);
}

/** Body rows only, so the header row can't hide in a plain `getAllByRole("row")` count. */
function tbodyRows(): HTMLElement[] {
  const [, tbody] = within(screen.getByRole("table")).getAllByRole("rowgroup");
  if (!tbody) {
    throw new Error("expected a tbody row group");
  }
  return within(tbody).getAllByRole("row");
}

describe("DiffTable", () => {
  it("renders one row per change", () => {
    render(
      <DiffTable
        changes={[
          { path: "Phone", kind: "removed", before: "+1 919 555 1234" },
          { path: "phone", kind: "added", after: null }
        ].map((change) => displayChange(change as DiffChange))}
      />
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText('"+1 919 555 1234"')).toBeInTheDocument();
    // The first row's `after` and the second row's `before` are both absent
    // (undefined), which `displayChange` writes as an em dash; the second row's
    // `after` is explicitly `null`, which it writes as the string "null".
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("shows every row when not collapsible, however many", () => {
    render(<DiffTable changes={changes(12)} />);
    expect(tbodyRows()).toHaveLength(12);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses to eight rows and toggles open and closed on request", async () => {
    render(<DiffTable changes={changes(12)} collapsible />);
    expect(tbodyRows()).toHaveLength(8);

    const toggle = screen.getByRole("button", { name: "Show 4 more changed fields" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getAllByRole("row")).toHaveLength(13);
    const expandedToggle = screen.getByRole("button", { name: "Show fewer changed fields" });
    expect(expandedToggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(expandedToggle);
    expect(screen.getAllByRole("row")).toHaveLength(9);
  });

  it("does not offer to expand when there is nothing hidden", () => {
    render(<DiffTable changes={changes(8)} collapsible />);
    expect(tbodyRows()).toHaveLength(8);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers to expand when exactly one row is hidden", () => {
    render(<DiffTable changes={changes(9)} collapsible />);
    expect(tbodyRows()).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show 1 more changed field" })).toBeInTheDocument();
  });

  it("leads with the lost value, pairs the renames and names each row's kind in words", () => {
    render(<DiffTable changes={displayChanges(DEMO)} collapsible />);
    const rows = tbodyRows().map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ["Phone → phone", "value lost", '"+1 555 0100"', "null"],
      ["Status__c → status", "renamed, value changed", '"Active"', '"active"'],
      ["Id → externalId", "renamed", '"0018Z00005PIN01"'],
      ["Name → name", "renamed", '"Dana Whitfield"']
    ]);
    const [lost, , renamed] = tbodyRows();
    expect(lost).toHaveClass("lost");
    expect(renamed).toHaveClass("renamed");
    // The unchanged value is shown once, across the Before and After columns.
    expect(within(renamed as HTMLElement).getAllByRole("cell")[2]).toHaveAttribute("colspan", "2");
  });

  it("never hides a lost value behind the toggle, wherever it sits", async () => {
    const many: DisplayedChange[] = [
      ...changes(10),
      displayChange({ path: "late", kind: "changed", before: "x", after: null }),
      displayChange({ path: "later", kind: "removed", before: 1 })
    ];
    render(<DiffTable changes={many} collapsible />);
    expect(tbodyRows()).toHaveLength(10);
    expect(screen.getByText("late")).toBeInTheDocument();
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(screen.queryByText("field8")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show 2 more changed fields" }));
    expect(tbodyRows()).toHaveLength(12);
  });

  it("shows every row when the only rows past eight are lost", () => {
    const many = [...changes(8), displayChange({ path: "gone", kind: "removed", before: "v" })];
    render(<DiffTable changes={many} collapsible />);
    expect(tbodyRows()).toHaveLength(9);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("resets its expanded state when the key changes, as EventDetail relies on for a new event", async () => {
    const { rerender } = render(<DiffTable key="event-1" changes={changes(12)} collapsible />);
    await userEvent.click(screen.getByRole("button", { name: "Show 4 more changed fields" }));
    expect(tbodyRows()).toHaveLength(12);

    rerender(<DiffTable key="event-2" changes={changes(30)} collapsible />);
    expect(tbodyRows()).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show 22 more changed fields" })).toBeInTheDocument();
  });
});
