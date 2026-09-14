import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventsUrl, fetchJson } from "./api-client";

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eventsUrl", () => {
  it("omits the query string when there is no cursor", () => {
    expect(eventsUrl("jrn_1", null)).toBe("/api/journeys/jrn_1/events");
  });

  it("encodes the journey id and the cursor", () => {
    expect(eventsUrl("jrn/1", "a b+c")).toBe("/api/journeys/jrn%2F1/events?cursor=a%20b%2Bc");
  });
});

describe("fetchJson", () => {
  it("parses a 200 body", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "evt_1" }));

    const result = await fetchJson<{ id: string }>("/api/events/evt_1");

    expect(result).toEqual({ kind: "ok", body: { id: "evt_1" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/events/evt_1", {
      headers: { accept: "application/json" }
    });
  });

  it("calls a 401 permanent, because signing in again is the only cure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    expect(await fetchJson("/api/events/evt_1")).toEqual({ kind: "failed", permanent: true });
  });

  it("calls a 409 permanent: no project can be resolved for this session", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 409 }));

    expect(await fetchJson("/api/events/evt_1")).toEqual({ kind: "failed", permanent: true });
  });

  it("calls a 502 temporary, so a caller can retry it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 502 }));

    expect(await fetchJson("/api/events/evt_1")).toEqual({ kind: "failed", permanent: false });
  });

  it("turns a network error into a temporary failure rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    expect(await fetchJson("/api/events/evt_1")).toEqual({ kind: "failed", permanent: false });
  });

  it("turns a body that is not JSON into a temporary failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));

    expect(await fetchJson("/api/events/evt_1")).toEqual({ kind: "failed", permanent: false });
  });
});
