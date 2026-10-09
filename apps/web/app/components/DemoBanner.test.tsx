import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoBanner, DEMO_SEARCH, DEMO_SEARCH_HREF } from "./DemoBanner";

describe("DemoBanner", () => {
  it("says what this is and links the pilot address and the site", () => {
    render(<DemoBanner />);
    expect(screen.getByText("Public demo. Read-only, sample data.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /pilot/i }).getAttribute("href")).toBe(
      "mailto:pilots@wayscribe.dev"
    );
    expect(screen.getByRole("link", { name: "wayscribe.dev" }).getAttribute("href")).toBe(
      "https://wayscribe.dev"
    );
  });

  // The Search page's call to action is the way in; the banner does not repeat it.
  it("leaves the sample search to the Search page", () => {
    render(<DemoBanner />);
    expect(screen.queryByRole("link", { name: DEMO_SEARCH })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("names the pinned search and the link that runs it", () => {
    expect(DEMO_SEARCH).toBe("+1 555 0100");
    expect(DEMO_SEARCH_HREF).toBe("/?q=%2B1%20555%200100");
  });
});
