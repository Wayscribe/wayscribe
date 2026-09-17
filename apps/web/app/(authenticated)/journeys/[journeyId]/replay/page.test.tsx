import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetailData, ReplayDestination } from "../../../../../src/lib/api";
import ReplayPage from "./page";

const { getEventMock, getReplayMock, listReplayDestinationsMock } = vi.hoisted(() => ({
  getEventMock: vi.fn(),
  getReplayMock: vi.fn(),
  listReplayDestinationsMock: vi.fn()
}));

vi.mock("../../../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/api")>();
  return {
    ...actual,
    getEvent: getEventMock,
    getReplay: getReplayMock,
    listReplayDestinations: listReplayDestinationsMock
  };
});

vi.mock("../../../../../src/lib/current-project", () => ({
  requireProjectId: vi.fn(() => Promise.resolve("proj_1"))
}));

/** Only the fields the page reads. */
const event = {
  name: "sync-customer",
  hasInput: true,
  inputPayload: { customerId: "C-1" }
} as unknown as EventDetailData;

const destination: ReplayDestination = {
  id: "dst_1",
  name: "local",
  baseUrl: "http://localhost:3200",
  environmentType: "development",
  enabled: true
};

async function renderPage(search: { event?: string; replay?: string; error?: string }) {
  const page = await ReplayPage({
    params: Promise.resolve({ journeyId: "jrn_1" }),
    searchParams: Promise.resolve(search)
  });
  render(page);
}

describe("ReplayPage", () => {
  beforeEach(() => {
    getEventMock.mockReset().mockResolvedValue(event);
    getReplayMock.mockReset().mockResolvedValue(null);
    listReplayDestinationsMock.mockReset().mockResolvedValue([destination]);
  });

  it("shows no alert when the route handler named no error", async () => {
    await renderPage({ event: "evt_1" });

    expect(screen.getByRole("heading", { level: 1, name: "Replay this input" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says why a replay that never became a run was not sent, and still offers the form", async () => {
    await renderPage({ event: "evt_1", error: "destination_disabled" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That destination is disabled, so nothing was sent. Choose another destination."
    );
    expect(screen.getByRole("button", { name: "Send replay" })).toBeInTheDocument();
    expect(getReplayMock).not.toHaveBeenCalled();
  });

  it("shows the generic message for a code it does not know, never the code", async () => {
    await renderPage({ event: "evt_1", error: "Call support at 555-0100" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong, so the replay may not have been sent. Try again."
    );
    expect(document.body.textContent).not.toContain("555-0100");
  });
});
