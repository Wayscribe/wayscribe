import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AboutJourneyView } from "./AboutJourneyView";

describe("AboutJourneyView", () => {
  it("says what a likely cause is (ADR-072)", () => {
    render(
      <AboutJourneyView
        startedAt="2026-10-12T10:00:00.000Z"
        lastEventAt="2026-10-12T10:00:09.400Z"
        hasAliases={false}
      />
    );
    expect(screen.getByText("Likely cause").tagName).toBe("DT");
    expect(
      screen.getByText(
        "When an error names the field it rejected, the likely cause is the nearest earlier step that changed that field."
      ).tagName
    ).toBe("DD");
  });
});
