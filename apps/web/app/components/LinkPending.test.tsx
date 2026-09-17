import { render, screen } from "@testing-library/react";
import Link, { useLinkStatus } from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkPending } from "./LinkPending";

const renderLink = (): HTMLElement => {
  render(
    <Link href="/journeys">
      Journeys
      <LinkPending />
    </Link>
  );
  return screen.getByRole("link");
};

describe("LinkPending", () => {
  afterEach(() => {
    vi.mocked(useLinkStatus).mockReset();
    vi.mocked(useLinkStatus).mockReturnValue({ pending: false });
  });

  it("adds nothing to an idle link, so its text and name are unchanged", () => {
    const link = renderLink();
    expect(link.innerHTML).toBe("Journeys");
    expect(link).toHaveAccessibleName("Journeys");
  });

  it("marks a link being followed, without changing its name", () => {
    vi.mocked(useLinkStatus).mockReturnValue({ pending: true });
    const link = renderLink();
    const marker = link.querySelector(".link-pending");
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(marker?.getAttribute("style")).toBeNull();
    expect(link).toHaveAccessibleName("Journeys");
  });
});
