import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailableError, InvalidPageLinkError, listJourneys } from "./api";

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests-0000000000");
  vi.stubEnv("API_URL", "http://api:8080");
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const error = (code: string): Response =>
  json({ error: { code, message: "m", requestId: "r" } }, 400);

describe("listJourneys", () => {
  it("returns the page", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { items: [], nextCursor: "c" } }));
    expect(await listJourneys("since=x", "project-1")).toEqual({
      items: [],
      nextCursor: "c"
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://api:8080/v1/journeys?since=x");
  });

  it.each(["invalid_cursor", "invalid_query"])(
    "calls a 400 %s an invalid page link, not an unreachable API",
    async (code) => {
      // A hand-edited or stale link. Reporting it as an outage sent people to
      // check a running API.
      fetchMock.mockResolvedValueOnce(error(code));
      await expect(listJourneys("since=x", "project-1")).rejects.toBeInstanceOf(
        InvalidPageLinkError
      );
    }
  );

  it("still reports any other failure as the API being unavailable", async () => {
    fetchMock.mockResolvedValueOnce(error("something_else"));
    await expect(listJourneys("since=x", "p")).rejects.toBeInstanceOf(ApiUnavailableError);

    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 400 }));
    await expect(listJourneys("since=x", "p")).rejects.toBeInstanceOf(ApiUnavailableError);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(listJourneys("since=x", "p")).rejects.toBeInstanceOf(ApiUnavailableError);
  });
});
