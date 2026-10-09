import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventDetailData } from "../../src/lib/api";
import { eventForDisplay, type ApiEventDetail } from "../../src/lib/event-display";
import { EventDetail } from "./EventDetail";

/** An event as the API answers it, made into what `getEvent` hands the page. */
function event(overrides: Partial<ApiEventDetail> = {}): EventDetailData {
  return eventForDisplay({
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
  });
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
 * The demo's transform renames every field and loses phone on the way. The
 * page used to list eight unrelated rows and ask the reader to find the odd
 * one out; it now pairs the renames and leads with the lost value.
 */
describe("EventDetail what changed", () => {
  const transformed = (): EventDetailData =>
    event({
      operation: "transformed",
      hasInput: true,
      hasOutput: true,
      inputPayload: {
        Id: "0018Z00005PIN01",
        Name: "Dana Whitfield",
        Phone: "+1 555 0100",
        Status__c: "Active"
      },
      outputPayload: {
        externalId: "0018Z00005PIN01",
        name: "Dana Whitfield",
        phone: null,
        status: "active"
      },
      payloadDiff: {
        changes: [
          { path: "Id", kind: "removed", before: "0018Z00005PIN01" },
          { path: "Name", kind: "removed", before: "Dana Whitfield" },
          { path: "Phone", kind: "removed", before: "+1 555 0100" },
          { path: "Status__c", kind: "removed", before: "Active" },
          { path: "externalId", kind: "added", after: "0018Z00005PIN01" },
          { path: "name", kind: "added", after: "Dana Whitfield" },
          { path: "phone", kind: "added", after: null },
          { path: "status", kind: "added", after: "active" }
        ],
        truncated: false
      }
    });

  it("leads with the lost phone and lists the renames last", () => {
    render(<EventDetail event={transformed()} />);
    const [, tbody] = within(screen.getByRole("table")).getAllByRole("rowgroup");
    const fields = within(tbody as HTMLElement)
      .getAllByRole("row")
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(fields).toEqual([
      "Phone → phone",
      "Status__c → status",
      "Id → externalId",
      "Name → name"
    ]);
    expect(screen.getByText("value lost")).toBeTruthy();
  });

  it("says how the table is arranged, not that the reader must find the odd one out", () => {
    render(<EventDetail event={transformed()} />);
    const heading = screen.getByRole("heading", { level: 3, name: "What changed" });
    const explanation = heading.nextElementSibling?.textContent ?? "";
    expect(explanation).toContain(
      "Renamed fields are paired and muted; lost or altered values are listed first."
    );
    expect(explanation).not.toMatch(/should not be there/);
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

describe("EventDetail operational context", () => {
  it("labels measured queue evidence, attempt outcome and requested remote delay", () => {
    render(
      <EventDetail
        event={event({
          operation: "failed",
          timingContext: {
            queue: "customer-updates",
            queueWaitMs: 0,
            queueWaitBasis: "retry-ready",
            deliveryCount: 3,
            targetHost: "api.example.test:443",
            httpStatusCode: 429,
            retryAfterMs: 2000,
            attempt: 2,
            retryGroup: "job-7"
          },
          recordedHost: "worker-3",
          customMetadata: { sourceSystem: "salesforce" }
        })}
      />
    );
    const context = screen.getByRole("group", { name: "Operational context" });
    expect(context.textContent).toContain(
      "Measured queue wait0 ms (retry readiness to attempt start)"
    );
    expect(context.textContent).toContain("Attempt2 — failed");
    expect(context.textContent).toContain("Requested Retry-After2 s");
    expect(context.textContent).toContain("Recorded hostworker-3");
    expect(screen.getByRole("group", { name: "Custom" }).textContent).toContain("sourceSystem");
  });

  it("does not replace missing timing evidence with zero", () => {
    render(<EventDetail event={event()} />);
    expect(screen.queryByRole("group", { name: "Operational context" })).toBeNull();
    expect(document.body.textContent).not.toContain("Measured queue wait0 ms");
  });

  it("can rerender from absent to present to absent operational context", () => {
    const { rerender } = render(<EventDetail event={event()} />);
    expect(screen.queryByRole("group", { name: "Operational context" })).toBeNull();

    rerender(<EventDetail event={event({ timingContext: { attempt: 1, retryGroup: "job-7" } })} />);
    expect(screen.getByRole("group", { name: "Operational context" })).toBeTruthy();

    rerender(<EventDetail event={event()} />);
    expect(screen.queryByRole("group", { name: "Operational context" })).toBeNull();
  });
});

/**
 * F-042: the detail of an `identified` event said nothing about what it
 * identified. It now lists the aliases the event stated, as text.
 */
describe("EventDetail aliases", () => {
  const stated = [
    { type: "email", displayValue: "j…@example.com", displayable: false },
    { type: "hubspotContactId", displayValue: "1234", displayable: true }
  ];

  it("lists the aliases the event stated, marking the masked ones", () => {
    render(<EventDetail event={event({ aliases: stated })} />);
    expect(screen.getByRole("heading", { name: "Aliases stated" })).toBeTruthy();
    const group = screen.getByRole("group", { name: "Aliases stated" });
    expect(group.textContent).toBe("emailj…@example.com (masked)hubspotContactId1234");
    expect(within(group).getByTitle(/Masked/)).toBeTruthy();
  });

  it("lists them for any operation that stated some, not only identified", () => {
    render(<EventDetail event={event({ operation: "received", aliases: [stated[1]] })} />);
    expect(screen.getByRole("group", { name: "Aliases stated" }).textContent).toBe(
      "hubspotContactId1234"
    );
  });

  it("says an identified event stated none when the list is empty", () => {
    render(<EventDetail event={event({ aliases: [] })} />);
    expect(screen.getByText("This event stated no aliases.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Aliases stated" })).toBeNull();
  });

  it.each([
    ["null", { aliases: null }],
    ["absent", {}]
  ])("says an identified event's aliases were not recorded when they are %s", (_, fields) => {
    render(<EventDetail event={event(fields)} />);
    expect(
      screen.getByText(
        "Which aliases this event stated was not recorded: it was stored before the server kept them, or the API is older than this web app. Any aliases the journey has are listed at the top of the page."
      )
    ).toBeTruthy();
  });

  it.each([
    ["empty", { aliases: [] }],
    ["null", { aliases: null }],
    ["absent", {}]
  ])("says nothing about aliases for another operation when they are %s", (_, fields) => {
    render(<EventDetail event={event({ operation: "transformed", ...fields })} />);
    expect(screen.queryByRole("heading", { name: "Aliases stated" })).toBeNull();
  });

  it("renders markup in a type or a value as text, never as elements", () => {
    const markup = '<img src="x" onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <EventDetail
        event={event({ aliases: [{ type: markup, displayValue: markup, displayable: true }] })}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const group = screen.getByRole("group", { name: "Aliases stated" });
    expect(group.textContent).toBe(`${markup}${markup}`);
    expect(group.innerHTML).toContain("&lt;img");
  });
});

describe("EventDetail replay link", () => {
  const withInput = (): EventDetailData =>
    event({ operation: "transformed", hasInput: true, inputPayload: { a: 1 } });

  it("offers replay to an admin and hides it from a reader", () => {
    const { unmount } = render(<EventDetail event={withInput()} canReplay />);
    expect(screen.queryByRole("link", { name: /Replay this input/ })).not.toBeNull();
    unmount();
    render(<EventDetail event={withInput()} canReplay={false} />);
    expect(screen.queryByRole("link", { name: /Replay this input/ })).toBeNull();
  });
});
