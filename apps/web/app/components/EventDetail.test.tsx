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

/**
 * F-044: the API returned all three kinds of metadata and the page showed
 * none, so an HTTP status an SDK user had moved into metadata, as the SDK
 * advises, disappeared from the screen.
 */
describe("EventDetail metadata", () => {
  it("lists custom, deployment and runtime metadata as keys and values", () => {
    render(
      <EventDetail
        event={event({
          customMetadata: { httpStatus: 429, retryDelayMs: 1200 },
          deploymentMetadata: { version: "2.4.1", gitCommit: "abc1234" },
          runtimeMetadata: { language: "node", hostname: "worker-3" }
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Metadata" })).toBeTruthy();
    const groups = ["Custom", "Deployment", "Runtime"].map((name) =>
      screen.getByRole("group", { name })
    );
    expect(groups.map((group) => group.textContent)).toEqual([
      "CustomhttpStatus429retryDelayMs1200",
      "DeploymentgitCommitabc1234version2.4.1",
      "Runtimehostnameworker-3languagenode"
    ]);
  });

  it("leaves out a kind with nothing in it", () => {
    render(<EventDetail event={event({ customMetadata: { queue: "jobs" } })} />);
    expect(screen.getByRole("group", { name: "Custom" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Deployment" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Runtime" })).toBeNull();
  });

  it("says so when the step recorded none, including from an API that omits the fields", () => {
    render(<EventDetail event={event()} />);
    expect(screen.getByText("No metadata was recorded for this step.")).toBeTruthy();
  });

  // Metadata is text the instrumented code chose. It is shown as text: a key
  // or a value that looks like markup must stay characters on the page.
  it("renders markup in a key or a value as text, never as elements", () => {
    const markup = '<img src="x" onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <EventDetail event={event({ customMetadata: { [markup]: markup, nested: { markup } } })} />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const group = screen.getByRole("group", { name: "Custom" });
    expect(group.textContent).toContain(markup);
    expect(group.innerHTML).toContain("&lt;img");
  });

  it("says how many entries it left out", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`k${String(index)}`, index])
    );
    render(<EventDetail event={event({ customMetadata: many })} />);
    expect(screen.getByText("10 more not shown.")).toBeTruthy();
  });
});
