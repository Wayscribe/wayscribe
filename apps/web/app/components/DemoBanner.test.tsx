import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoBanner, DEMO_SEARCH } from "./DemoBanner";

describe("DemoBanner", () => {
  it("says what this is, suggests the pinned search, and links the pilot address and the site", () => {
    render(<DemoBanner />);
    expect(screen.getByText("Public demo. Read-only, sample data.")).toBeTruthy();
    expect(DEMO_SEARCH).toBe("+1 555 0100");
    expect(screen.getByRole("link", { name: DEMO_SEARCH }).getAttribute("href")).toBe(
      "/?q=%2B1%20555%200100"
    );
    expect(screen.getByRole("link", { name: /pilot/i }).getAttribute("href")).toBe(
      "mailto:pilots@wayscribe.dev"
    );
    expect(screen.getByRole("link", { name: "wayscribe.dev" }).getAttribute("href")).toBe(
      "https://wayscribe.dev"
    );
  });
});
