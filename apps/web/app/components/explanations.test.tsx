import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventDetailData } from "../../src/lib/api";
import { AliasList } from "./AliasList";
import { EventDetail } from "./EventDetail";
import { EXPLANATIONS } from "./explanations";
import { JourneyHeading } from "./JourneyHeading";

const event = (overrides: Partial<EventDetailData>): EventDetailData => ({
  id: "evt_1",
  journeyId: "jrn_1",
  operation: "transformed",
  name: "transform-customer",
  service: "webhook-api",
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

/** The one muted paragraph holding `text`, however it is split across nodes. */
const mutedParagraphWith = (text: string): HTMLElement => {
  const paragraph = screen.getByText(
    (_content, element) =>
      element !== null && element.tagName === "P" && element.textContent.includes(text)
  );
  expect(paragraph).toHaveClass("muted");
  return paragraph;
};

describe("plain-language explanations", () => {
  it("explains a journey under the journey page's heading, labelled or not", () => {
    for (const label of ["Acme onboarding", null]) {
      const { unmount } = render(
        <JourneyHeading journey={{ entity: { type: "customer", id: "C-1" }, label }} />
      );
      expect(mutedParagraphWith(EXPLANATIONS.journey).textContent).toBe(EXPLANATIONS.journey);
      unmount();
    }
  });

  it("explains an alias after the list of them, and not when there are none", () => {
    const { unmount } = render(
      <AliasList
        aliases={[{ type: "salesforceAccountId", displayValue: "0018Z", displayable: true }]}
      />
    );
    expect(mutedParagraphWith(EXPLANATIONS.alias).textContent).toMatch(
      new RegExp(`^Also known as .*\\. ${escape(EXPLANATIONS.alias)}$`)
    );
    unmount();

    render(<AliasList aliases={[]} />);
    expect(screen.queryByText(EXPLANATIONS.alias, { exact: false })).toBeNull();
  });

  it("explains a transformation beside the comparison, and replay beside its link", () => {
    render(
      <EventDetail
        event={event({
          hasInput: true,
          hasOutput: true,
          inputPayload: { Phone: "1" },
          outputPayload: { phone: "1" },
          payloadDiff: { changes: [], truncated: false }
        })}
      />
    );

    const whatChanged = screen.getByRole("heading", { level: 3, name: "What changed" });
    expect(whatChanged.nextElementSibling).toBe(mutedParagraphWith(EXPLANATIONS.transformation));

    const link = screen.getByRole("link", { name: "Replay this input →" });
    const replay = mutedParagraphWith(EXPLANATIONS.replay);
    expect(link.closest("p")?.nextElementSibling).toBe(replay);
    expect(within(replay).queryByRole("link")).toBeNull();
  });

  it("says nothing about either when the step has no comparison and no input", () => {
    render(<EventDetail event={event({})} />);
    expect(screen.queryByText(EXPLANATIONS.transformation, { exact: false })).toBeNull();
    expect(screen.queryByText(EXPLANATIONS.replay, { exact: false })).toBeNull();
  });

  it("finds all four terms still defined in the glossary, and exactly those four keys", () => {
    // From the workspace root, where Vitest runs: under jsdom, import.meta.url
    // is not a file URL.
    const glossary = readFileSync(join(process.cwd(), "docs", "GLOSSARY.md"), "utf8");
    for (const term of ["Journey", "Alias", "Transformation", "Replay"]) {
      expect(glossary).toContain(`## ${term}\n`);
    }
    expect(Object.keys(EXPLANATIONS).sort()).toEqual([
      "alias",
      "journey",
      "replay",
      "transformation"
    ]);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
