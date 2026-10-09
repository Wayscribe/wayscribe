import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventDetailData } from "../../src/lib/api";
import { eventForDisplay, type ApiEventDetail } from "../../src/lib/event-display";
import { AboutJourneyView } from "./AboutJourneyView";
import { AliasList } from "./AliasList";
import { EventDetail } from "./EventDetail";
import { EXPLANATIONS } from "./explanations";
import { JourneyHeading } from "./JourneyHeading";
import { GLOSSARY_URL } from "./SiteNav";

const event = (overrides: Partial<ApiEventDetail>): EventDetailData =>
  eventForDisplay({
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
  it("keeps the heading and the alias line free of definitions", () => {
    for (const label of ["Acme onboarding", null]) {
      const { unmount } = render(
        <JourneyHeading journey={{ entity: { type: "customer", id: "C-1" }, label }} />
      );
      expect(screen.queryByText(EXPLANATIONS.journey, { exact: false })).toBeNull();
      unmount();
    }
    render(
      <AliasList
        aliases={[{ type: "salesforceAccountId", displayValue: "0018Z", displayable: true }]}
      />
    );
    expect(screen.getByText(/^Also known as/).textContent).toBe(
      "Also known as salesforceAccountId 0018Z"
    );
    expect(screen.queryByText(EXPLANATIONS.alias, { exact: false })).toBeNull();
  });

  it("defines every journey-page term in About this view, each linked to the glossary", () => {
    const { container, unmount } = render(
      <AboutJourneyView
        startedAt="2026-09-16T08:00:00.000Z"
        lastEventAt="2026-09-16T08:00:09.400Z"
        hasAliases
      />
    );
    const details = container.querySelector("details.about-view");
    expect(details).not.toBeNull();
    // Collapsed until asked: the timeline comes first.
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector("summary")?.textContent).toBe("About this view");
    for (const text of [EXPLANATIONS.journey, EXPLANATIONS.alias, EXPLANATIONS.clockComparison]) {
      expect(details?.textContent).toContain(text);
    }
    expect(details?.textContent).toContain("Recorded span: 9.4 s");
    expect(details?.textContent).toContain("All times UTC.");
    const links = [...(details?.querySelectorAll("dt a") ?? [])].map((a) => [
      a.textContent,
      a.getAttribute("href")
    ]);
    expect(links).toEqual([
      ["Journey", `${GLOSSARY_URL}#journey`],
      ["Alias", `${GLOSSARY_URL}#alias`],
      ["Recorded span", `${GLOSSARY_URL}#recorded-span`],
      ["Clock comparison", `${GLOSSARY_URL}#clock-comparison`]
    ]);
    unmount();

    render(
      <AboutJourneyView
        startedAt="2026-09-16T08:00:00.000Z"
        lastEventAt="2026-09-16T08:00:09.400Z"
        hasAliases={false}
      />
    );
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

  it("finds every term the page links still defined in the glossary, and exactly those keys", () => {
    // From the workspace root, where Vitest runs: under jsdom, import.meta.url
    // is not a file URL.
    const glossary = readFileSync(join(process.cwd(), "docs", "GLOSSARY.md"), "utf8");
    for (const term of [
      "Journey",
      "Alias",
      "Clock comparison",
      "Recorded span",
      "Transformation",
      "Replay"
    ]) {
      expect(glossary).toContain(`## ${term}\n`);
    }
    expect(Object.keys(EXPLANATIONS).sort()).toEqual([
      "alias",
      "clockComparison",
      "journey",
      "replay",
      "transformation"
    ]);
  });
});
