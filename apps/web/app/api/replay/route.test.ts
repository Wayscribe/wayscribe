import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostResult, ReplayRun } from "../../../src/lib/api";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session";
import { POST } from "./route";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";

const { createReplayMock } = vi.hoisted(() => ({ createReplayMock: vi.fn() }));

vi.mock("../../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/api")>();
  return { ...actual, createReplay: createReplayMock };
});

function requestFor(
  cookie: string | undefined,
  form: Record<string, string> = {},
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/replay", {
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

const signedIn = (): string =>
  signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() + 60_000 });

/** What the prepare screen's form posts. */
const FORM = {
  journeyId: "jrn_1",
  eventId: "evt_1",
  destinationId: "dst_1",
  path: "/webhooks/customer",
  method: "PUT"
};

/** Only the fields the route reads; the rest of a run does not matter here. */
const run = (fields: Partial<ReplayRun>): ReplayRun => ({ id: "rpl_1", ...fields }) as ReplayRun;

const result = (fields: Partial<PostResult<ReplayRun>>): PostResult<ReplayRun> => ({
  ok: true,
  status: 201,
  data: null,
  ...fields
});

describe("POST /api/replay", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
    createReplayMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends a missing or expired session to login, and never calls the API", async () => {
    const expired = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: Date.now() - 1 });

    for (const cookie of [undefined, expired]) {
      const response = await POST(requestFor(cookie, FORM));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
    expect(createReplayMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request before looking at the session or the form", async () => {
    for (const cookie of [signedIn(), undefined]) {
      const response = await POST(requestFor(cookie, FORM, { "sec-fetch-site": "cross-site" }));
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("text/html");
    }

    const response = await POST(requestFor(signedIn(), FORM, { origin: "http://evil.test" }));
    expect(response.status).toBe(403);
    expect(createReplayMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no journeyId", { ...FORM, journeyId: "" }],
    ["no eventId", { ...FORM, eventId: "" }],
    ["neither", {}]
  ])("sends a form with %s home, and never calls the API", async (_what, form) => {
    const response = await POST(requestFor(signedIn(), form));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(createReplayMock).not.toHaveBeenCalled();
  });

  it("sends the replay in the session's project and returns to the replay page with the run", async () => {
    createReplayMock.mockResolvedValue(result({ data: run({ id: "rpl_42" }) }));

    const response = await POST(requestFor(signedIn(), FORM));

    expect(createReplayMock).toHaveBeenCalledWith(
      { eventId: "evt_1", destinationId: "dst_1", path: "/webhooks/customer", method: "PUT" },
      "proj_1"
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/journeys/jrn_1/replay?event=evt_1&replay=rpl_42"
    );
  });

  it("sends POST when the form names no method", async () => {
    createReplayMock.mockResolvedValue(result({ data: run({}) }));

    await POST(requestFor(signedIn(), { ...FORM, method: "" }));

    expect(createReplayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" }),
      "proj_1"
    );
  });

  it("returns to the replay page with the error code when no run was created", async () => {
    createReplayMock.mockResolvedValue(
      result({
        ok: false,
        status: 404,
        error: { code: "destination_not_found", message: "No such destination." }
      })
    );

    const response = await POST(requestFor(signedIn(), FORM));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/journeys/jrn_1/replay?event=evt_1&error=destination_not_found"
    );
  });

  it("shows a refused run by its id rather than the error, since the run holds the reason", async () => {
    createReplayMock.mockResolvedValue(
      result({
        ok: false,
        status: 403,
        data: run({ id: "rpl_blocked", status: "blocked" }),
        error: { code: "replay_blocked", message: "Refused." }
      })
    );

    const response = await POST(requestFor(signedIn(), FORM));

    expect(response.headers.get("location")).toBe(
      "/journeys/jrn_1/replay?event=evt_1&replay=rpl_blocked"
    );
  });

  it("returns to the replay page with the event alone when the API answered neither", async () => {
    createReplayMock.mockResolvedValue(result({ ok: false, status: 500 }));

    const response = await POST(requestFor(signedIn(), FORM));

    expect(response.headers.get("location")).toBe("/journeys/jrn_1/replay?event=evt_1");
  });

  it("encodes the journey id and the query values from the form", async () => {
    createReplayMock.mockResolvedValue(result({ data: run({ id: "rpl 1&x=y" }) }));

    const response = await POST(
      requestFor(signedIn(), { ...FORM, journeyId: "../jrn?admin=1", eventId: "evt&1" })
    );

    expect(response.headers.get("location")).toBe(
      "/journeys/..%2Fjrn%3Fadmin%3D1/replay?event=evt%261&replay=rpl+1%26x%3Dy"
    );
  });
});
