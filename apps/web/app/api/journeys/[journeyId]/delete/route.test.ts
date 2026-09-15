import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailableError, ProjectNotSelectedError } from "../../../../../src/lib/api";
import { SESSION_COOKIE_NAME, signSession } from "../../../../../src/lib/session";
import { POST } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const { deleteJourneyMock } = vi.hoisted(() => ({ deleteJourneyMock: vi.fn() }));

vi.mock("../../../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/api")>();
  return { ...actual, deleteJourney: deleteJourneyMock };
});

function requestFor(
  cookie: string | undefined,
  form: Record<string, string> = {},
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/journeys/jrn_1/delete", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
      ...headers
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
    vi.restoreAllMocks();
  });

  it("sends a missing or expired session to login, and never calls the API", async () => {
    const expired = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() - 1 });

    for (const cookie of [undefined, expired]) {
      const response = await POST(requestFor(cookie), context);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
    expect(deleteJourneyMock).not.toHaveBeenCalled();
  });

  it("deletes the journey in the session's project and redirects to search with a notice", async () => {
    deleteJourneyMock.mockResolvedValue("deleted");

    const response = await POST(requestFor(signedIn(), { entityType: "customer" }), context);

    expect(deleteJourneyMock).toHaveBeenCalledWith("jrn_1", "proj_1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?deleted=customer");
  });

  it("keeps anything but a plain entity type out of the redirect", async () => {
    deleteJourneyMock.mockResolvedValue("deleted");

    const response = await POST(
      requestFor(signedIn(), { entityType: "customer 18492 <script>" }),
      context
    );

    expect(response.headers.get("location")).toBe("/?deleted=journey");
  });

  it("treats a journey that is already gone, as on a double submit, as deleted", async () => {
    deleteJourneyMock.mockResolvedValue("not_found");

    const response = await POST(requestFor(signedIn(), { entityType: "customer" }), context);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?deleted=journey");
  });

  it("sends any other failure back to the confirmation page with a one-word reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: [unknown, string][] = [
      [new ApiUnavailableError("down"), "api_unavailable"],
      [new ProjectNotSelectedError("none"), "project_not_selected"],
      [new Error("boom"), "unexpected"]
    ];

    for (const [error, code] of cases) {
      deleteJourneyMock.mockRejectedValueOnce(error);
      const response = await POST(requestFor(signedIn()), context);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/journeys/jrn_1/delete?error=${code}`);
    }
  });

  describe("cross-origin requests", () => {
    const refused = async (headers: Record<string, string>): Promise<void> => {
      deleteJourneyMock.mockResolvedValue("deleted");
      const response = await POST(requestFor(signedIn(), {}, headers), context);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(deleteJourneyMock).not.toHaveBeenCalled();
    };

    const allowed = async (headers: Record<string, string>): Promise<void> => {
      deleteJourneyMock.mockResolvedValue("deleted");
      const response = await POST(requestFor(signedIn(), {}, headers), context);
      expect(response.status, JSON.stringify(headers)).toBe(303);
      expect(deleteJourneyMock).toHaveBeenCalled();
      deleteJourneyMock.mockReset();
    };

    it("refuses Sec-Fetch-Site cross-site and same-site, whatever Origin says", async () => {
      await refused({ "sec-fetch-site": "cross-site" });
      // A sibling subdomain or another localhost port: SameSite=strict still
      // sends the cookie, so this is the case the check exists for.
      await refused({ "sec-fetch-site": "same-site", origin: "http://localhost:3000" });
    });

    it("allows Sec-Fetch-Site same-origin and none", async () => {
      await allowed({ "sec-fetch-site": "same-origin", origin: "http://localhost:3000" });
      await allowed({ "sec-fetch-site": "none" });
    });

    it("without Sec-Fetch-Site, compares Origin with the host the client asked for", async () => {
      await allowed({ origin: "http://localhost:3000" });
      await refused({ origin: "http://localhost:3001" });
      await refused({ origin: "http://evil.localhost:3000" });
      await refused({ origin: "null" });
      await refused({ origin: "not a url" });
    });

    it("honours x-forwarded-host behind a proxy", async () => {
      await allowed({
        origin: "https://recorder.example.com",
        "x-forwarded-host": "recorder.example.com"
      });
      await refused({
        origin: "https://other.example.com",
        "x-forwarded-host": "recorder.example.com"
      });
    });

    it("allows a request with neither header", async () => {
      await allowed({});
    });
  });
});
