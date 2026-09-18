import { describe, expect, it } from "vitest";
import { describeSearchScope, readSearchFilters, searchApiQuery } from "./search-filters";

const NOW = new Date("2026-09-18T12:00:00.000Z");

describe("readSearchFilters", () => {
  // Search is what a person reaches for with an identifier in hand, so with
  // nothing chosen it spans the whole history, as the API does without a
  // window (docs/API_SPEC.md section 5).
  it("searches every time and every environment when nothing is chosen", () => {
    const filters = readSearchFilters({ q: " 0018Z " }, NOW);
    expect(filters).toMatchObject({
      q: "0018Z",
      window: "",
      environment: "",
      since: "",
      until: "",
      notes: []
    });
    expect(searchApiQuery(filters)).toBe("q=0018Z");
  });

  it.each([
    ["1h", "2026-09-18T11:00:00.000Z"],
    ["24h", "2026-09-17T12:00:00.000Z"],
    ["7d", "2026-09-11T12:00:00.000Z"],
    ["30d", "2026-08-19T12:00:00.000Z"]
  ])("reads window %s as a since that long before now", (window, since) => {
    const filters = readSearchFilters({ q: "x", window }, NOW);
    expect(filters.window).toBe(window);
    expect(searchApiQuery(filters)).toBe(`q=x&since=${encodeURIComponent(since)}`);
  });

  it("reads a custom range from the form's datetime-local fields, as UTC", () => {
    const filters = readSearchFilters(
      { q: "x", window: "custom", since: "2026-09-10T08:00", until: "2026-09-11T08:30" },
      NOW
    );
    expect(filters).toMatchObject({
      since: "2026-09-10T08:00:00.000Z",
      until: "2026-09-11T08:30:00.000Z",
      sinceInput: "2026-09-10T08:00",
      untilInput: "2026-09-11T08:30",
      notes: []
    });
    expect(new URLSearchParams(searchApiQuery(filters)).get("until")).toBe(
      "2026-09-11T08:30:00.000Z"
    );
  });

  // Falling back to all time widens the search, so the page has to say so.
  it("sets aside a custom range the API would refuse, and says the search spans all time", () => {
    for (const [since, until, reason] of [
      ["", "", "choose a start"],
      ["2026-09-30T08:00", "", "the start is in the future"],
      ["2026-09-10T08:00", "2026-09-10T07:00", "the end must be after the start"],
      ["2026-02-30T08:00", "", "the start is not a date and time"]
    ] as const) {
      const filters = readSearchFilters({ q: "x", window: "custom", since, until }, NOW);
      expect(filters.window, since).toBe("");
      expect(filters.since, since).toBe("");
      expect(filters.notes, since).toEqual([
        `The custom range was not used (${reason}), so this searches all time.`
      ]);
      // Echoed, so the reader can correct what they typed.
      expect(filters.sinceInput).toBe(since);
    }
  });

  it("sets aside a range sent without the custom window", () => {
    const filters = readSearchFilters({ q: "x", window: "24h", since: "2026-09-10T08:00" }, NOW);
    expect(filters.window).toBe("24h");
    expect(filters.since).toBe("2026-09-17T12:00:00.000Z");
    expect(filters.notes).toEqual([
      "The custom range applies only when Time is custom range, so this searches the last 24 hours."
    ]);
  });

  it("reads an environment, and passes it to the API", () => {
    const filters = readSearchFilters({ q: "x", environment: "production" }, NOW);
    expect(filters.environment).toBe("production");
    expect(searchApiQuery(filters)).toBe("q=x&environment=production");
  });

  it("sets aside an unknown window and a repeated key, with a note for each", () => {
    const filters = readSearchFilters(
      { q: "x", window: "fortnight", environment: ["production", "development"] },
      NOW
    );
    expect(filters.window).toBe("");
    expect(filters.environment).toBe("");
    expect(filters.notes).toEqual([
      'Time "fortnight" is not one of the choices, so this searches all time.',
      "environment was given more than once, so it was left out."
    ]);
  });

  it("sets aside an environment the API cannot search for", () => {
    const filters = readSearchFilters(
      { q: "x", environment: `prod${String.fromCharCode(0)}` },
      NOW
    );
    expect(filters.environment).toBe("");
    expect(filters.notes).toHaveLength(1);
  });
});

describe("describeSearchScope", () => {
  it("says nothing when the search is not narrowed", () => {
    expect(describeSearchScope(readSearchFilters({ q: "x" }, NOW))).toBeNull();
  });

  // The window is on the journey's last activity, not on the matching event:
  // a reader who narrows by time should know which time.
  it("names the window and the environment, and what the window is measured on", () => {
    expect(
      describeSearchScope(
        readSearchFilters({ q: "x", window: "24h", environment: "production" }, NOW)
      )
    ).toBe("Journeys in production whose last activity is in the last 24 hours.");
    expect(
      describeSearchScope(
        readSearchFilters(
          { q: "x", window: "custom", since: "2026-09-10T08:00", until: "2026-09-11T08:30" },
          NOW
        )
      )
    ).toBe("Journeys whose last activity is from 2026-09-10 08:00 to 2026-09-11 08:30 UTC.");
    expect(describeSearchScope(readSearchFilters({ q: "x", environment: "staging" }, NOW))).toBe(
      "Journeys in staging."
    );
  });
});
