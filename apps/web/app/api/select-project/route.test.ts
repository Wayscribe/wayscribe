import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATOR_SESSION_LABEL,
  READER_SESSION_LABEL,
  SESSION_COOKIE_NAME,
  signSession,
  verifySession
} from "../../../src/lib/session";
import { POST } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const { listProjectsMock } = vi.hoisted(() => ({ listProjectsMock: vi.fn() }));

vi.mock("../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/api")>();
  return { ...actual, listProjects: listProjectsMock };
});

const READ_TOKEN = "read-token-for-tests-000000000000000";

function requestFor(
  form: Record<string, string>,
  cookie: string | null = signSession(ADMIN_TOKEN, {
    projectId: "",
    expiresAt: Date.now() + 60_000
  })
): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/select-project", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
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
    expect(response.headers.get("location")).toBe("/?q=CUST-1");
  });

  it("sends a path-only Location behind a TLS proxy that sends no X-Forwarded-Proto", async () => {
    // The proxy forwards Host and nothing else. An absolute Location built
    // from them named http://, and the form's redirect broke under
    // `form-action 'self'` on the https page.
    const request = requestFor({ projectId: PROJECT_ID, next: "/recent" });
    request.headers.set("host", "wayscribe.example.com");
    const response = await POST(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/recent");
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
      expect(response.headers.get("location"), next).toBe("/");
    }
  });
});

/** The session cookie a response sets, by value. */
const setCookie = (response: Response): string => {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
  if (match?.[1] === undefined) throw new Error(`no session cookie in: ${header}`);
  return match[1];
};

describe("POST /api/select-project signs the session for the mode it runs in", () => {
  beforeEach(() => {
    vi.stubEnv("API_URL", "http://api:8080");
    listProjectsMock.mockReset();
    listProjectsMock.mockResolvedValue([{ id: PROJECT_ID, name: "Acme", slug: "acme" }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs an operator's choice as an admin's, under the operator label only", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    const cookie = setCookie(await POST(requestFor({ projectId: PROJECT_ID })));
    const now = Date.now();
    expect(verifySession(ADMIN_TOKEN, cookie, now, OPERATOR_SESSION_LABEL)).toMatchObject({
      projectId: PROJECT_ID,
      principal: "admin"
    });
    expect(verifySession(ADMIN_TOKEN, cookie, now, READER_SESSION_LABEL)).toBeNull();
  });

  it("signs a reader's choice with no cookie yet, under the reader label only", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    vi.stubEnv("READ_TOKEN", READ_TOKEN);
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    const response = await POST(requestFor({ projectId: PROJECT_ID, next: "/recent" }, null));
    expect(response.headers.get("location")).toBe("/recent");
    const cookie = setCookie(response);
    const now = Date.now();
    expect(verifySession(READ_TOKEN, cookie, now, READER_SESSION_LABEL)).toMatchObject({
      projectId: PROJECT_ID,
      principal: "reader"
    });
    expect(verifySession(READ_TOKEN, cookie, now, OPERATOR_SESSION_LABEL)).toBeNull();
  });

  it("never carries an operator session into anonymous mode, even if the tokens matched", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    vi.stubEnv("READ_TOKEN", READ_TOKEN);
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    const operatorCookie = signSession(
      READ_TOKEN,
      { projectId: "", expiresAt: Date.now() + 60_000, principal: "admin" },
      OPERATOR_SESSION_LABEL
    );
    const cookie = setCookie(await POST(requestFor({ projectId: PROJECT_ID }, operatorCookie)));
    expect(verifySession(READ_TOKEN, cookie, Date.now(), READER_SESSION_LABEL)).toMatchObject({
      principal: "reader"
    });
  });

  it("never accepts a reader session in operator mode, even if the tokens matched", async () => {
    vi.stubEnv("ADMIN_TOKEN", READ_TOKEN);
    const readerCookie = signSession(
      READ_TOKEN,
      { projectId: "", expiresAt: Date.now() + 60_000, principal: "reader" },
      READER_SESSION_LABEL
    );
    const response = await POST(requestFor({ projectId: PROJECT_ID }, readerCookie));
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
