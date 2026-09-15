import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session";
import { POST } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const { listProjectsMock } = vi.hoisted(() => ({ listProjectsMock: vi.fn() }));

vi.mock("../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/api")>();
  return { ...actual, listProjects: listProjectsMock };
});

function requestFor(form: Record<string, string>): NextRequest {
  const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: Date.now() + 60_000 });
  return new NextRequest("http://0.0.0.0:3000/api/select-project", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${SESSION_COOKIE_NAME}=${cookie}`
    },
    body: new URLSearchParams(form).toString()
  });
}

describe("POST /api/select-project", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
    listProjectsMock.mockReset();
    listProjectsMock.mockResolvedValue([{ id: PROJECT_ID, name: "Acme", slug: "acme" }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns to where the picker interrupted", async () => {
    const response = await POST(requestFor({ projectId: PROJECT_ID, next: "/?q=CUST-1" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/?q=CUST-1");
  });

  it("never redirects off this host, whatever next normalises to", async () => {
    // Each of these once came back as a Location on http://evil.test.
    for (const next of [
      "/.//evil.test/phish",
      "/..//evil.test",
      "/%2e//evil.test",
      "/a/..//evil.test",
      "/./\\evil.test",
      "//evil.test",
      "https://evil.test/"
    ]) {
      const response = await POST(requestFor({ projectId: PROJECT_ID, next }));
      expect(response.status, next).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.host, next).toBe("localhost:3000");
      expect(location.pathname, next).toBe("/");
    }
  });
});
