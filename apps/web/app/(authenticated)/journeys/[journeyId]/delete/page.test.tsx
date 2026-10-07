import { beforeEach, describe, expect, it, vi } from "vitest";
import DeleteJourneyPage from "./page";

const { currentSessionMock, getJourneyMock, notFoundMock } = vi.hoisted(() => ({
  currentSessionMock: vi.fn(),
  getJourneyMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("../../../../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getJourney: getJourneyMock
}));
vi.mock("../../../../../src/lib/current-project", () => ({
  requireProjectId: vi.fn(() => Promise.resolve("proj_1")),
  currentSession: currentSessionMock
}));

const session = (principal: "admin" | "reader") => ({
  projectId: "",
  expiresAt: Date.now() + 60_000,
  principal
});

const run = () =>
  DeleteJourneyPage({
    params: Promise.resolve({ journeyId: "jrn_1" }),
    searchParams: Promise.resolve({})
  });

describe("DeleteJourneyPage", () => {
  beforeEach(() => {
    getJourneyMock.mockReset().mockResolvedValue({
      entity: { type: "customer", id: "c1" },
      environment: "demo",
      eventCount: 3
    });
    notFoundMock.mockClear();
  });

  it("is not found for a reader who types the URL, and reads nothing", async () => {
    currentSessionMock.mockResolvedValue(session("reader"));
    await expect(run()).rejects.toThrow("NOT_FOUND");
    expect(getJourneyMock).not.toHaveBeenCalled();
  });

  it("shows an admin the confirmation", async () => {
    currentSessionMock.mockResolvedValue(session("admin"));
    await run();
    expect(getJourneyMock).toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
