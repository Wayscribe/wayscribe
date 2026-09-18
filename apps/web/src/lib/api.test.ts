import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailableError, InvalidPageLinkError, getEvent, listJourneys } from "./api";

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

describe("getEvent", () => {
  /**
   * The event crosses from the server to the browser two ways: as a prop of
   * the timeline on first load, which React serialises, and as JSON from
   * /api/events on a later click. A key named `__proto__` in the API's JSON
   * survived the second and was lost in the first, so the same event showed
   * different metadata. `getEvent` hands out metadata as lists of plain
   * strings and payloads as text (`eventForDisplay`), which both ways carry
   * intact, and no raw object at all.
   */
  const RAW = `{"data":{"id":"evt_1","journeyId":"jrn_1","operation":"delivered","name":"push",
    "service":"s","eventTimestamp":"2026-09-18T00:00:00.000Z","receivedAt":"2026-09-18T00:00:00.000Z",
    "durationMs":null,"hasInput":false,"hasOutput":false,"hasError":false,"traceId":null,"messageId":null,
    "inputPayload":null,"outputPayload":null,"payloadDiff":null,"error":null,
    "customMetadata":{"__proto__":"kept","queue":"jobs"},
    "deploymentMetadata":{"version":"2.4.1"},"runtimeMetadata":null,
    "aliases":[{"type":"__proto__","displayValue":"kept","displayable":true}]}}`;

  const fetched = async (): Promise<Awaited<ReturnType<typeof getEvent>>> => {
    fetchMock.mockResolvedValueOnce(
      new Response(RAW, { headers: { "content-type": "application/json" } })
    );
    return getEvent("evt_1", "project-1");
  };

  it("lists a key named __proto__ as the key it is", async () => {
    const event = await fetched();
    expect(event?.metadata?.custom.entries).toEqual([
      { key: "__proto__", value: "kept" },
      { key: "queue", value: "jobs" }
    ]);
    expect(event?.metadata?.deployment.entries).toEqual([{ key: "version", value: "2.4.1" }]);
    expect(event?.metadata?.runtime.entries).toEqual([]);
    expect(event?.statedAliases).toEqual([{ type: "__proto__", value: "kept", masked: false }]);
  });

  it("hands out no raw payload, error or metadata object to be serialised", async () => {
    const event = await fetched();
    for (const field of [
      "inputPayload",
      "outputPayload",
      "error",
      "customMetadata",
      "deploymentMetadata",
      "runtimeMetadata",
      "aliases"
    ]) {
      expect(Object.hasOwn(event ?? {}, field), field).toBe(false);
    }
  });

  // What /api/events does to it, and every key is still there.
  it("comes through a JSON round trip unchanged", async () => {
    const event = await fetched();
    expect(JSON.parse(JSON.stringify(event)) as unknown).toEqual(event);
  });
});
