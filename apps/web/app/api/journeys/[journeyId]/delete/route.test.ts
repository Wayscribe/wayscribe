import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailableError } from "../../../../../src/lib/api";
import { SESSION_COOKIE_NAME, signSession } from "../../../../../src/lib/session";
import { POST } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const { deleteJourneyMock } = vi.hoisted(() => ({ deleteJourneyMock: vi.fn() }));

vi.mock("../../../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/api")>();
  return { ...actual, deleteJourney: deleteJourneyMock };
});

function requestFor(cookie: string | undefined, form: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/journeys/jrn_1/delete", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
    },
    body: new URLSearchParams(form).toString()
  });
}

const context = { params: Promise.resolve({ journeyId: "jrn_1" }) };

const signedIn = (): string =>
  signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 });

describe("POST /api/journeys/[journeyId]/delete", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
    deleteJourneyMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without a session, and never calls the API", async () => {
    const response = await POST(requestFor(undefined), context);

    expect(response.status).toBe(401);
    expect(deleteJourneyMock).not.toHaveBeenCalled();
  });

  it("deletes the journey in the session's project and redirects to search with a notice", async () => {
    deleteJourneyMock.mockResolvedValue("deleted");

    const response = await POST(requestFor(signedIn(), { entityType: "customer" }), context);

    expect(deleteJourneyMock).toHaveBeenCalledWith("jrn_1", "proj_1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/?deleted=customer");
  });

  it("keeps anything but a plain entity type out of the redirect", async () => {
    deleteJourneyMock.mockResolvedValue("deleted");

    const response = await POST(
      requestFor(signedIn(), { entityType: "customer 18492 <script>" }),
      context
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/?deleted=journey");
  });

  it("answers 404 when the journey is already gone", async () => {
    deleteJourneyMock.mockResolvedValue("not_found");

    const response = await POST(requestFor(signedIn()), context);

    expect(response.status).toBe(404);
  });

  it("maps an unreachable API to the usual 502", async () => {
    deleteJourneyMock.mockRejectedValue(new ApiUnavailableError("down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(requestFor(signedIn()), context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "api_unavailable" } });
  });
});
