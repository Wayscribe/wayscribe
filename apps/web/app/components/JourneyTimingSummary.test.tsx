import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JourneyTimingSummary } from "./JourneyTimingSummary";

describe("JourneyTimingSummary", () => {
  it("shows the recorded first-to-last event-start span with its limits", () => {
    render(
      <JourneyTimingSummary
        startedAt="2026-09-15T10:31:02.000Z"
        lastEventAt="2026-09-15T10:34:38.000Z"
      />
    );
    expect(screen.getByText(/Recorded span: 3m 36s/)).toBeTruthy();
    expect(screen.getByText(/not a sum of step durations/i)).toBeTruthy();
    expect(screen.getByText(/different service clocks can disagree/i)).toBeTruthy();
  });

  it("keeps a one-event journey's measured zero", () => {
    render(
      <JourneyTimingSummary
        startedAt="2026-09-15T10:31:02.000Z"
        lastEventAt="2026-09-15T10:31:02.000Z"
      />
    );
    expect(screen.getByText(/Recorded span: 0 ms/)).toBeTruthy();
  });
});
