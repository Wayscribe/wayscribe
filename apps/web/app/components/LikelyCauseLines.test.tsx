import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisplayedLikelyCause } from "../../src/lib/likely-cause-display";
import { LikelyCauseLines } from "./LikelyCauseLines";

const LOST: DisplayedLikelyCause = {
  field: "phone",
  changedPath: null,
  reportedBy: "evt_retry_3",
  eventId: "evt_transform",
  step: "transform-salesforce-account",
  verb: "lost",
  before: "+1 919 555 1234",
  after: "null",
  alsoChangedAt: [],
  incomplete: false
};

const NAMES: Record<string, string> = { evt_retry_3: "retry-customer-delivery attempt 3" };
const describeEvent = (eventId: string): string | null => NAMES[eventId] ?? null;
const line = (): string | null | undefined => document.querySelector(".likely-cause")?.textContent;

describe("LikelyCauseLines", () => {
  it("says which step lost the field, and links to it", () => {
    render(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_demo_pinned_5550100"
        failedEventId="evt_retry_3"
        describeEvent={describeEvent}
      />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234)"
    );
    expect(
      screen.getByRole("link", { name: "transform-salesforce-account" }).getAttribute("href")
    ).toBe("/journeys/jrn_demo_pinned_5550100?event=evt_transform");
  });

  it("names the event that reported the field when it is another one", () => {
    render(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_1"
        failedEventId="evt_dead_letter"
        describeEvent={describeEvent}
      />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by retry-customer-delivery attempt 3"
    );
    expect(
      screen.getByRole("link", { name: "retry-customer-delivery attempt 3" }).getAttribute("href")
    ).toBe("/journeys/jrn_1?event=evt_retry_3");
  });

  it("describes a reporter the timeline has not loaded", () => {
    render(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_1"
        failedEventId={null}
        describeEvent={() => null}
      />
    );
    expect(line()).toBe(
      "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by an earlier failed step"
    );
  });

  it("gives both values of a change, and the earlier steps nearest first", () => {
    const changed: DisplayedLikelyCause = {
      ...LOST,
      field: "status",
      reportedBy: "evt_deliver",
      verb: "changed",
      before: "Former Customer",
      after: "former customer",
      alsoChangedAt: [
        { eventId: "evt_normalize", step: "normalize-status" },
        { eventId: "evt_enrich", step: "enrich-from-crm" }
      ]
    };
    render(
      <LikelyCauseLines
        causes={[changed]}
        journeyId="jrn_1"
        failedEventId="evt_deliver"
        describeEvent={describeEvent}
      />
    );
    const [first, second] = Array.from(document.querySelectorAll(".likely-causes p"));
    expect(first?.textContent).toBe(
      "Likely cause: status changed at transform-salesforce-account (was Former Customer, now former customer)"
    );
    expect(second?.textContent).toBe("Also changed earlier at: normalize-status, enrich-from-crm");
  });

  // ADR-072: a field matches a change below it, and the values are that path's.
  it("names the changed path when it lies below the reported field", () => {
    render(
      <LikelyCauseLines
        causes={[
          {
            ...LOST,
            field: "address",
            changedPath: "address.postalCode",
            verb: "changed",
            before: "27601",
            after: "2760"
          }
        ]}
        journeyId="jrn_1"
        failedEventId="evt_retry_3"
        describeEvent={describeEvent}
      />
    );
    expect(line()).toBe(
      "Likely cause: address.postalCode (in address) changed at transform-salesforce-account (was 27601, now 2760)"
    );
  });

  it("says when a nearer step's changes were too large to check", () => {
    render(
      <LikelyCauseLines
        causes={[{ ...LOST, incomplete: true }]}
        journeyId="jrn_1"
        failedEventId="evt_retry_3"
        describeEvent={describeEvent}
      />
    );
    expect(screen.getByText("Some earlier steps' changes were too large to check.")).toBeTruthy();
  });

  it("renders nothing without causes", () => {
    const { container } = render(
      <LikelyCauseLines
        causes={[]}
        journeyId="jrn_1"
        failedEventId={null}
        describeEvent={describeEvent}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  // deploy/demo/smoke-check.sh matches the server's HTML, where React puts a
  // comment marker between adjacent text nodes, so the label is one node. Each
  // double-quoted likely-cause pattern in the script is checked against this
  // render, as DiffTable.test.tsx checks the single-quoted diff patterns.
  it("renders on the server the markup the demo's smoke check matches", () => {
    const html = renderToString(
      <LikelyCauseLines
        causes={[LOST]}
        journeyId="jrn_demo_pinned_5550100"
        failedEventId={null}
        describeEvent={describeEvent}
      />
    );
    const smoke = readFileSync(join(__dirname, "../../../../deploy/demo/smoke-check.sh"), "utf8");
    const patterns = [...smoke.matchAll(/^\s*\*"(Likely cause:[^"]*)"\*\)/gm)].map(
      (m) => m[1] ?? ""
    );
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(html, pattern).toContain(pattern);
  });
});
