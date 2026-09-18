import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readSearchFilters } from "../../src/lib/search-filters";
import { SearchForm } from "./SearchForm";

const NOW = new Date("2026-09-18T12:00:00.000Z");

const renderForm = (
  params: Record<string, string>,
  environments: string[] = ["development", "production"]
): HTMLFormElement => {
  render(<SearchForm filters={readSearchFilters(params, NOW)} environments={environments} />);
  return screen.getByRole<HTMLFormElement>("search");
};

const selected = (label: string): string =>
  screen.getByLabelText<HTMLSelectElement>(label).selectedOptions[0]?.text ?? "";

/** F-036, the web half: search narrows by time and environment, in a plain form. */
describe("SearchForm", () => {
  // No JavaScript needed: the browser sends the fields and loads the page.
  it("is a plain GET form to the Search page", () => {
    const form = renderForm({});
    expect(form.tagName).toBe("FORM");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/");
  });

  it("labels every control and names what the form sends", () => {
    renderForm({});
    for (const [label, name] of [
      ["Search", "q"],
      ["Time", "window"],
      ["From", "since"],
      ["To", "until"],
      ["Environment", "environment"]
    ] as const) {
      expect(screen.getByLabelText(label).getAttribute("name"), label).toBe(name);
    }
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("starts on any time and every environment, which is what the API searches without them", () => {
    renderForm({});
    expect(selected("Time")).toBe("any time");
    expect(screen.getByLabelText<HTMLSelectElement>("Time").value).toBe("");
    expect(selected("Environment")).toBe("all");
    expect(screen.getByLabelText<HTMLSelectElement>("Environment").value).toBe("");
  });

  it("offers every preset, a custom range, and the project's environments", () => {
    renderForm({});
    const options = (label: string): string[] =>
      Array.from(screen.getByLabelText<HTMLSelectElement>(label).options).map(
        (option) => option.value
      );
    expect(options("Time")).toEqual(["", "1h", "24h", "7d", "30d", "custom"]);
    expect(options("Environment")).toEqual(["", "development", "production"]);
  });

  it("shows what the page searched with", () => {
    renderForm({
      q: "0018Z",
      window: "custom",
      since: "2026-09-10T08:00",
      until: "2026-09-11T08:30",
      environment: "production"
    });
    expect(screen.getByLabelText<HTMLInputElement>("Search").value).toBe("0018Z");
    expect(selected("Time")).toBe("custom range");
    expect(screen.getByLabelText<HTMLInputElement>("From").value).toBe("2026-09-10T08:00");
    expect(screen.getByLabelText<HTMLInputElement>("To").value).toBe("2026-09-11T08:30");
    expect(selected("Environment")).toBe("production");
  });

  // A shared link can name an environment this project no longer lists.
  it("keeps an environment the project does not list selectable", () => {
    renderForm({ q: "x", environment: "staging" });
    expect(selected("Environment")).toBe("staging");
  });
});
