import { describe, expect, it } from "vitest";
import { parseRecentJourneysQuery } from "./recent-query.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const parse = (query: Record<string, unknown>): ReturnType<typeof parseRecentJourneysQuery> =>
  parseRecentJourneysQuery(query, NOW);

describe("parseRecentJourneysQuery", () => {
  it("needs only since", () => {
    expect(parse({ since: "2026-09-14T12:00:00Z" })).toEqual({
      ok: true,
      filters: {
        since: new Date("2026-09-14T12:00:00Z"),
        status: undefined,
        environment: undefined,
        service: undefined
      }
    });
  });

  it("passes every filter through", () => {
    expect(
      parse({
        since: "2026-09-14T12:00:00Z",
        status: "failed",
        environment: "production",
        service: "sync-worker"
      })
    ).toEqual({
      ok: true,
      filters: {
        since: new Date("2026-09-14T12:00:00Z"),
        status: "failed",
        environment: "production",
        service: "sync-worker"
      }
    });
  });

  it.each(["active", "completed", "failed"])("accepts status %s", (status) => {
    expect(parse({ since: "2026-09-14T12:00:00Z", status }).ok).toBe(true);
  });

  it("treats an empty value as omitted, as a GET form sends one", () => {
    const parsed = parse({
      since: "2026-09-14T12:00:00Z",
      status: "",
      environment: "",
      service: ""
    });
    expect(parsed).toMatchObject({
      ok: true,
      filters: { status: undefined, environment: undefined, service: undefined }
    });
  });

  it.each([
    [{}, "since is required."],
    [{ since: "" }, "since is required."],
    [{ since: "yesterday" }, "since must be an ISO-8601 instant with a time zone."],
    // Date.parse accepts these; a filter should not guess what they meant.
    [{ since: "2026-09-14" }, "since must be an ISO-8601 instant with a time zone."],
    [{ since: "2026-09-14T12:00:00" }, "since must be an ISO-8601 instant with a time zone."],
    [{ since: "2026-13-01T00:00:00Z" }, "since must be an ISO-8601 instant with a time zone."],
    // V8 rolls these over to 2 March and 1 October rather than refusing them.
    [{ since: "2026-02-30T00:00:00Z" }, "since must be an ISO-8601 instant with a time zone."],
    [{ since: "2026-09-31T00:00:00Z" }, "since must be an ISO-8601 instant with a time zone."],
    [{ since: "2025-02-29T00:00:00Z" }, "since must be an ISO-8601 instant with a time zone."],
    [{ since: "2026-09-14T24:30:00Z" }, "since must be an ISO-8601 instant with a time zone."],
    // Past the clock tolerance.
    [{ since: "2026-09-15T12:01:01Z" }, "since must not be in the future."],
    [
      { since: "2026-09-14T12:00:00Z", status: "any" },
      "status must be one of active, completed, failed."
    ],
    [
      { since: "2026-09-14T12:00:00Z", status: "FAILED" },
      "status must be one of active, completed, failed."
    ],
    [{ since: ["2026-09-14T12:00:00Z", "2026-09-13T12:00:00Z"] }, "since must be given once."],
    [{ since: "2026-09-14T12:00:00Z", service: ["a", "b"] }, "service must be given once."],
    [
      { since: "2026-09-14T12:00:00Z", environment: ["production", "staging"] },
      "environment must be given once."
    ],
    [{ since: "2026-09-14T12:00:00Z", status: ["failed", "active"] }, "status must be given once."]
  ])("rejects %j", (query, message) => {
    expect(parse(query)).toEqual({ ok: false, message });
  });

  it("accepts since equal to now, and an offset other than Z", () => {
    expect(parse({ since: "2026-09-15T12:00:00.000Z" }).ok).toBe(true);
    expect(parse({ since: "2026-09-15T08:00:00-04:00" }).ok).toBe(true);
  });

  it("accepts a since up to the clock tolerance ahead of now", () => {
    // The web server computes since from its own clock; the API's may be behind.
    expect(parse({ since: "2026-09-15T12:00:59Z" }).ok).toBe(true);
  });

  it("accepts a leap day, and a date whose UTC day differs from its local one", () => {
    expect(parse({ since: "2024-02-29T00:00:00Z" }).ok).toBe(true);
    // 1 March at 01:00 in +02:00 is still 28 February in UTC.
    expect(parse({ since: "2026-03-01T01:00:00+02:00" }).ok).toBe(true);
  });
});
