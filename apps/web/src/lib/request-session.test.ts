import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "./session";
import { requestSession } from "./request-session";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const NOW = 1_800_000_000_000;

function requestWithCookie(cookie: string | undefined): NextRequest {
  return new NextRequest("http://localhost:3000/api/x", {
    headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  });
}

describe("requestSession", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null without a cookie", () => {
    expect(requestSession(requestWithCookie(undefined), NOW)).toBeNull();
  });

  it("returns null for a cookie signed with another token", () => {
    const cookie = signSession("some-other-token-000000000000000000", {
      projectId: "proj_1",
      expiresAt: NOW + 1000
    });
    expect(requestSession(requestWithCookie(cookie), NOW)).toBeNull();
  });

  it("returns null for an expired session", () => {
    const cookie = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: NOW - 1000 });
    expect(requestSession(requestWithCookie(cookie), NOW)).toBeNull();
  });

  it("returns the verified payload for a session with a project", () => {
    const cookie = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: NOW + 1000 });
    expect(requestSession(requestWithCookie(cookie), NOW)).toEqual({
      projectId: "proj_1",
      expiresAt: NOW + 1000
    });
  });

  it("passes an empty projectId through unchanged", () => {
    const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: NOW + 1000 });
    expect(requestSession(requestWithCookie(cookie), NOW)).toEqual({
      projectId: "",
      expiresAt: NOW + 1000
    });
  });
});
