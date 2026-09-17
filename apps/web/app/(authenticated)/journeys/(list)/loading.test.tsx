import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Loading from "./loading";

describe("the Journeys loading state", () => {
  it("is announced, inside the page's main", () => {
    render(<Loading />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading journeys…");
    expect(status.closest("main")?.id).toBe("main");
  });
});
