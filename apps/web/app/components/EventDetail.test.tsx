import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventDetailData } from "../../src/lib/api";
import { EventDetail } from "./EventDetail";

function event(overrides: Partial<EventDetailData> = {}): EventDetailData {
  return {
    id: "evt_1",
    journeyId: "jrn_1",
    operation: "identified",
    name: "identify",
    service: "job-sweep",
    eventTimestamp: "2026-09-16T08:00:00.000Z",
    receivedAt: "2026-09-16T08:00:00.100Z",
    durationMs: null,
    hasInput: false,
    hasOutput: false,
    hasError: false,
    traceId: null,
    messageId: null,
    inputPayload: null,
    outputPayload: null,
    payloadDiff: null,
    error: null,
    ...overrides
  };
}

/**
 * An event without payloads is not evidence of a capture policy. Identify,
 * finish and fail events carry none by nature, and a caller may record a step
 * without one; the API does not say which, so the page must not guess.
 */
describe("EventDetail without payloads", () => {
  it.each([
    ["identify", "identified"],
    ["finish", "completed"],
    ["run-failed", "failed"],
    ["fetch-board", "received"]
  ])("says only that nothing was recorded for %s", (name, operation) => {
    render(<EventDetail event={event({ name, operation })} />);
    expect(screen.getByText(/No payload was recorded for this step\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/stores metadata only\./);
    expect(document.body.textContent).not.toMatch(/No payload captured/);
    expect(screen.queryByText("Input")).toBeNull();
  });

  it("still shows the payloads when there are any", () => {
    render(
      <EventDetail
        event={event({
          operation: "transformed",
          hasInput: true,
          hasOutput: true,
          inputPayload: { a: 1 },
          outputPayload: { a: 2 }
        })}
      />
    );
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.queryByText(/No payload was recorded/)).toBeNull();
  });
});
