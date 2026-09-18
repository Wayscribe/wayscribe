import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JourneyListItem } from "./JourneyListItem";

const item = {
  journeyId: "jrn_1",
  entity: { type: "customer", id: "0018Z00002ABC" },
  status: "failed",
  eventCount: 8,
  startedAt: "2026-09-15T10:31:02.000Z",
  lastEventAt: "2026-09-15T10:34:38.000Z",
  label: null,
  lastStep: null,
  displayableAliases: []
};

const renderRow = (props: Parameters<typeof JourneyListItem>[0]): void => {
  render(
    <ul>
      <JourneyListItem {...props} />
    </ul>
  );
};

describe("JourneyListItem", () => {
  it("links the entity to its journey", () => {
    renderRow({ item });
    const link = screen.getByRole("link", { name: "customer: 0018Z00002ABC" });
    expect(link.getAttribute("href")).toBe("/journeys/jrn_1");
  });

  it("encodes a journey id that is not URL-safe", () => {
    renderRow({ item: { ...item, journeyId: "jrn/1 a" } });
    expect(screen.getByRole("link").getAttribute("href")).toBe("/journeys/jrn%2F1%20a");
  });

  it("marks a failure and shows the count and last activity", () => {
    renderRow({ item });
    expect(screen.getByText("failed").className).toBe("status failed");
    expect(screen.getByRole("listitem").textContent).toContain(
      "8 events · last activity 2026-09-15 10:34:38"
    );
  });

  it("counts a single event in the singular", () => {
    renderRow({ item: { ...item, eventCount: 1 } });
    expect(screen.getByRole("listitem").textContent).toContain("1 event · last activity");
  });

  it("shows a dash for an entity id that could not be decrypted", () => {
    renderRow({ item: { ...item, entity: { type: "customer", id: null } } });
    expect(screen.getByRole("link", { name: "customer: —" })).toBeTruthy();
  });

  // F-036: the admin token searches every environment of a project, so a row
  // has to say which one it came from.
  it("says which environment the journey is in", () => {
    renderRow({ item: { ...item, environment: "production" } });
    const environment = screen.getByText("production");
    expect(environment.className).toBe("environment");
    expect(environment.getAttribute("title")).toBe("Environment");
  });

  // An API from before search rows carried it answers without the field.
  it("shows no environment when the API did not send one", () => {
    renderRow({ item });
    expect(screen.getByRole("listitem").querySelector(".environment")).toBeNull();
  });

  it("does not mark a status that is not a failure", () => {
    renderRow({ item: { ...item, status: "completed" } });
    expect(screen.getByText("completed").className).toBe("status");
  });
});
