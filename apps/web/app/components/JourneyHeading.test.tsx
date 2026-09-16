import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JourneyHeading } from "./JourneyHeading";

const entity = { type: "job_posting", id: "0018Z00002ABC" };

describe("JourneyHeading", () => {
  it("names a labelled journey by its label, with the entity beneath", () => {
    render(<JourneyHeading journey={{ entity, label: "  Mirantis · Senior SWE  " }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mirantis · Senior SWE");
    expect(screen.getByText("job_posting: 0018Z00002ABC").tagName).toBe("P");
  });

  it.each([
    ["no label", null],
    ["an API that omits it", undefined],
    ["a blank label", " \t "]
  ])("names the journey by its entity for %s", (_what, label) => {
    render(<JourneyHeading journey={{ entity, ...(label === undefined ? {} : { label }) }} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("job_posting: 0018Z00002ABC");
    expect(heading.className).toBe("mono");
  });

  it("shows a dash for an identifier the API did not return", () => {
    render(<JourneyHeading journey={{ entity: { type: "customer", id: null }, label: "Acme" }} />);
    expect(screen.getByText("customer: —")).toBeTruthy();
  });
});
