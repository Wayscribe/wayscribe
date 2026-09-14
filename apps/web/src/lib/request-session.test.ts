import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "./session";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const NOW = 1_800_000_000_000;

vi.mock("./api", () => ({
  listProjects: vi.fn()
}));

// `vi.mock` is hoisted above these, so `listProjects` is already the mock.
import { listProjects } from "./api";
import { requestSession } from "./request-session";

function requestWithCookie(cookie: string | undefined): NextRequest {
  return new NextRequest("http://localhost:3000/api/x", {
    headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  });
}

describe("requestSession", () => {
  beforeEach(() => {
    process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
    process.env["API_URL"] = "http://api:8080";
    vi.mocked(listProjects).mockReset();
  });
  afterEach(() => {
    delete process.env["ADMIN_TOKEN"];
    delete process.env["API_URL"];
  });

  it("returns null without a cookie", async () => {
    expect(await requestSession(requestWithCookie(undefined), NOW)).toBeNull();
  });

  it("returns null for a cookie signed with another token", async () => {
    const cookie = signSession("some-other-token-000000000000000000", {
      projectId: "proj_1",
      expiresAt: NOW + 1000
    });
    expect(await requestSession(requestWithCookie(cookie), NOW)).toBeNull();
  });

  it("uses the session's project when it has one", async () => {
    const cookie = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: NOW + 1000 });
    expect(await requestSession(requestWithCookie(cookie), NOW)).toEqual({
      session: { projectId: "proj_1", expiresAt: NOW + 1000 },
      projectId: "proj_1"
    });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("falls back to the only project when the session has none", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "proj_only", name: "Only", slug: "only" }]);
    const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: NOW + 1000 });
    expect((await requestSession(requestWithCookie(cookie), NOW))?.projectId).toBe("proj_only");
  });

  it("resolves to no project when several exist and none is chosen", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: "a", name: "A", slug: "a" },
      { id: "b", name: "B", slug: "b" }
    ]);
    const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: NOW + 1000 });
    expect((await requestSession(requestWithCookie(cookie), NOW))?.projectId).toBe("");
  });
});
