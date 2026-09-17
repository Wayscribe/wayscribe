import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GLOSSARY_URL, SiteNav } from "./SiteNav";

describe("SiteNav", () => {
  it("offers the two ways in", () => {
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Journeys" }).getAttribute("href")).toBe("/journeys");
  });

  it("links the glossary where the repository hosts it, in the same tab", () => {
    render(<SiteNav />);
    const glossary = screen.getByRole("link", { name: "Glossary" });
    expect(glossary.getAttribute("href")).toBe(GLOSSARY_URL);
    expect(GLOSSARY_URL).toBe(
      "https://gitlab.com/jojithedev/wayscribe/-/blob/main/docs/GLOSSARY.md"
    );
    expect(glossary.getAttribute("target")).toBeNull();
  });
});
