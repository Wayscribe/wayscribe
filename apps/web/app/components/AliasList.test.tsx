import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AliasList } from "./AliasList";

describe("AliasList", () => {
  it("renders nothing for a journey with no aliases", () => {
    const { container } = render(<AliasList aliases={[]} />);
    expect(container.textContent).toBe("");
  });

  it("shows a displayable alias as it is, and says which ones are masked", () => {
    render(
      <AliasList
        aliases={[
          { type: "postingId", displayValue: "greenhouse:4567", displayable: true },
          { type: "recruiterEmail", displayValue: "some…com", displayable: false }
        ]}
      />
    );
    const shown = screen.getByTestId("alias-postingId");
    expect(shown.textContent).toBe("postingId greenhouse:4567");
    const masked = screen.getByTestId("alias-recruiterEmail");
    expect(masked.textContent).toBe("recruiterEmail some…com (masked)");
    expect(masked.querySelector("[title]")?.getAttribute("title")).toContain(
      "not marked displayable"
    );
    expect(screen.getByText(/another identifier for the same record/)).toBeTruthy();
  });

  it("shows a dash for a value that could not be decrypted", () => {
    render(<AliasList aliases={[{ type: "sf", displayValue: null, displayable: false }]} />);
    expect(screen.getByTestId("alias-sf").textContent).toBe("sf — (masked)");
  });

  it("treats an alias from an API that predates the flag as masked", () => {
    render(<AliasList aliases={[{ type: "sf", displayValue: "SF-A…001" }]} />);
    expect(screen.getByTestId("alias-sf").textContent).toBe("sf SF-A…001 (masked)");
  });
});
