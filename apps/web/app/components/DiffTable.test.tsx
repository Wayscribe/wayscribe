import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffTable } from "./DiffTable";

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
  });
});
