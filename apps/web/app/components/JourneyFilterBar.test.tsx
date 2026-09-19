import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readJourneyFilters } from "../../src/lib/journey-filters";
import { JourneyFilterBar } from "./JourneyFilterBar";

const NOW = new Date("2026-09-15T12:00:00.000Z");

const renderBar = (
  params: Record<string, string>,
  environments: string[] = []
): HTMLFormElement => {
  render(
    <JourneyFilterBar filters={readJourneyFilters(params, NOW)} environments={environments} />
  );
  return screen.getByRole("search");
};

const selected = (select: HTMLElement): string[] =>
  Array.from((select as HTMLSelectElement).selectedOptions).map((option) => option.text);

describe("JourneyFilterBar", () => {
  it("is a plain GET form to the Journeys page", () => {
    const form = renderBar({});
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/journeys");
    expect(form.getAttribute("aria-label")).toBe("Filter journeys");
  });

  it("labels every control and names what the form sends", () => {
    renderBar({});
    const names = [
      ["Contains", "q"],
      ["Time", "window"],
      ["From", "since"],
      ["To", "until"],
      ["Status", "status"],
      ["Entity type", "entityType"],
      ["Environment", "environment"],
      ["Service", "service"]
    ];
    for (const [label, name] of names) {
      expect(screen.getByLabelText(label ?? "").getAttribute("name"), label).toBe(name);
    }
    expect(screen.getByRole("button", { name: "Show" })).toBeTruthy();
  });

  it("names each control by its label alone, not by the options inside it", () => {
    renderBar({});
    for (const name of ["Time", "Status", "Environment"]) {
      expect(screen.getByRole("combobox", { name }).tagName, name).toBe("SELECT");
    }
    expect(screen.getByRole("searchbox", { name: "Contains" })).toBeTruthy();
    for (const name of ["Entity type", "Service"]) {
      expect(screen.getByRole("textbox", { name }).tagName, name).toBe("INPUT");
    }
  });

  it("shows the defaults: any status and the last 24 hours", () => {
    renderBar({});
    expect(selected(screen.getByLabelText("Status"))).toEqual(["any"]);
    expect(selected(screen.getByLabelText("Time"))).toEqual(["last 24 hours"]);
    expect(
      within(screen.getByLabelText("Time"))
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["last hour", "last 24 hours", "last 7 days", "last 30 days", "custom range"]);
    expect(
      within(screen.getByLabelText("Status"))
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"))
    ).toEqual(["", "failed", "active", "completed"]);
  });

  it("uses datetime-local inputs and says they are UTC", () => {
    renderBar({});
    expect(screen.getByLabelText("From").getAttribute("type")).toBe("datetime-local");
    expect(screen.getByLabelText("To").getAttribute("type")).toBe("datetime-local");
    expect(screen.getByRole("group", { name: "Custom range, UTC" })).toBeTruthy();
  });

  it("reflects the filters it produced", () => {
    renderBar(
      {
        q: "acme",
        status: "failed",
        window: "custom",
        since: "2026-09-10T08:00",
        until: "2026-09-11T08:00",
        entityType: "customer",
        service: "sync"
      },
      ["production", "staging"]
    );
    expect(screen.getByLabelText("Contains")).toHaveValue("acme");
    expect(selected(screen.getByLabelText("Status"))).toEqual(["failed"]);
    expect(selected(screen.getByLabelText("Time"))).toEqual(["custom range"]);
    expect(screen.getByLabelText("From")).toHaveValue("2026-09-10T08:00");
    expect(screen.getByLabelText("To")).toHaveValue("2026-09-11T08:00");
    expect(screen.getByLabelText("Entity type")).toHaveValue("customer");
    expect(screen.getByLabelText("Service")).toHaveValue("sync");
  });

  it("shows new filters when a link changes them without a full page load", () => {
    // Next keeps the form mounted across a client-side navigation, such as
    // the Failures shortcut, and an uncontrolled field keeps its old value.
    const { rerender } = render(
      <JourneyFilterBar filters={readJourneyFilters({}, NOW)} environments={[]} />
    );
    rerender(
      <JourneyFilterBar
        filters={readJourneyFilters({ status: "failed", q: "acme" }, NOW)}
        environments={[]}
      />
    );
    expect(screen.getByLabelText("Status")).toHaveValue("failed");
    expect(screen.getByLabelText("Contains")).toHaveValue("acme");
  });

  it("keeps an environment the project no longer lists selectable", () => {
    renderBar({ environment: "retired" }, ["production"]);
    const environment = screen.getByLabelText("Environment");
    expect(selected(environment)).toEqual(["retired"]);
    expect(
      within(environment)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["all", "production", "retired"]);
  });

  it("bounds the text boxes without refusing text the API accepts", () => {
    // A browser counts minlength and maxlength in UTF-16 code units, and the
    // API counts code points, so a 200-code-point label of emoji is 400 units.
    renderBar({});
    expect(screen.getByLabelText("Contains").getAttribute("minLength")).toBe("2");
    expect(screen.getByLabelText("Contains").getAttribute("maxLength")).toBe("400");
    expect(screen.getByLabelText("Entity type").getAttribute("maxLength")).toBe("256");
  });

  it("offers whole-millisecond timing filters and explains inactivity scope", () => {
    renderBar({ minDurationMs: "0", minStepDurationMs: "250", inactiveForMs: "60000" });
    expect(screen.getByLabelText("Recorded span over (ms)")).toHaveValue(0);
    expect(screen.getByLabelText("Any step over (ms)")).toHaveValue(250);
    expect(screen.getByLabelText("Active and inactive for (ms)")).toHaveValue(60000);
    expect(screen.getByText(/debugging clue, not proof a job is stuck/i)).toBeTruthy();
    expect(screen.getByText(/activity window still applies/i)).toBeTruthy();
  });
});
