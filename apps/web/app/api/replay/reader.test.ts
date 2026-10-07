import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createReplayMock } = vi.hoisted(() => ({ createReplayMock: vi.fn() }));
vi.mock("../../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createReplay: createReplayMock
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  createReplayMock.mockReset();
});

describe("replaying as a reader", () => {
  it("is refused with 403 before the API is called", async () => {
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    vi.stubEnv("READ_TOKEN", "read-token-for-tests-000000000000000");
    vi.stubEnv("ADMIN_TOKEN", "");
    vi.stubEnv("API_URL", "http://api:8080");
    const body = new FormData();
    body.set("journeyId", "jrn_1");
    body.set("eventId", "evt_1");
    const request = new NextRequest("http://localhost:3000/api/replay", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(createReplayMock).not.toHaveBeenCalled();
  });
});
