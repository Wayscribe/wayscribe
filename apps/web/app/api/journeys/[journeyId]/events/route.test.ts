import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "../../../../../src/lib/session";
import { GET } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

// vi.mock is hoisted above these imports, so the mocks it references must be
// hoisted too.
const { listEventsMock, getJourneyMock } = vi.hoisted(() => ({
  listEventsMock: vi.fn(),
  getJourneyMock: vi.fn()
}));

vi.mock("../../../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/api")>();
  return {
    ...actual,
    listEvents: listEventsMock,
    getJourney: getJourneyMock
  };
});

function requestFor(cookie?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/journeys/jrn_1/events?cursor=abc", {
    headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  });
}

describe("GET /api/journeys/[journeyId]/events", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
    listEventsMock.mockReset();
    getJourneyMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a session, and never calls the API", async () => {
    const response = await GET(requestFor(undefined), {
      params: Promise.resolve({ journeyId: "jrn_1" })
    });

    expect(response.status).toBe(401);
    expect(listEventsMock).not.toHaveBeenCalled();
    expect(getJourneyMock).not.toHaveBeenCalled();
  });

  it("returns the page with a no-store cache header for a signed-in session", async () => {
    listEventsMock.mockResolvedValue({ items: [], nextCursor: null });
    getJourneyMock.mockResolvedValue({ status: "failed", eventCount: 0 });

    const cookie = signSession(ADMIN_TOKEN, {
      projectId: "proj_1",
      expiresAt: Date.now() + 60_000
    });

    const response = await GET(requestFor(cookie), {
      params: Promise.resolve({ journeyId: "jrn_1" })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      items: [],
      nextCursor: null,
      journeyStatus: "failed",
      journeyEventCount: 0
    });
    expect(listEventsMock).toHaveBeenCalledWith("jrn_1", "proj_1", "abc");
  });
});
