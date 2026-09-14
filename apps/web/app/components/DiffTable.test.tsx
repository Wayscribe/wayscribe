import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DiffChange } from "../../src/lib/api";
import { DiffTable } from "./DiffTable";

function changes(count: number): DiffChange[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `field${String(i)}`,
    kind: "changed" as const,
    before: i,
    after: i + 1
  }));
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
        ]}
      />
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText('"+1 919 555 1234"')).toBeInTheDocument();
    // The first row's `after` and the second row's `before` are both absent
    // (undefined), which `render()` shows as an em dash; the second row's
    // `after` is explicitly `null`, which `render()` shows as the string "null".
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("shows every row when not collapsible, however many", () => {
    render(<DiffTable changes={changes(12)} />);
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(tbodyRows()).toHaveLength(12);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses to eight rows and reveals the rest on request", async () => {
    render(<DiffTable changes={changes(12)} collapsible />);
    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(tbodyRows()).toHaveLength(8);
    await userEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(tbodyRows()).toHaveLength(12);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not offer to expand when there is nothing hidden", () => {
    render(<DiffTable changes={changes(8)} collapsible />);
    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(tbodyRows()).toHaveLength(8);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
