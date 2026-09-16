import { describe, expect, it } from "vitest";
import { parseJourneyListQuery } from "./journey-list-query.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const parse = (query: Record<string, unknown>): ReturnType<typeof parseJourneyListQuery> =>
  parseJourneyListQuery(query, NOW);

describe("parseJourneyListQuery", () => {
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
    [
      {},
      "since is required: the earliest last activity to list, as an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "" },
      "since is required: the earliest last activity to list, as an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "yesterday" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    // Date.parse accepts these; a filter should not guess what they meant.
    [
      { since: "2026-09-14" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "2026-09-14T12:00:00" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "2026-13-01T00:00:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    // V8 rolls these over to 2 March and 1 October rather than refusing them.
    [
      { since: "2026-02-30T00:00:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "2026-09-31T00:00:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "2025-02-29T00:00:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { since: "2026-09-14T24:30:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
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

  describe("until", () => {
    it("passes a later instant through, and may be in the future", () => {
      // A range ending after now means "up to now"; unlike a future since it
      // cannot empty the list, so clock skew does not apply to it.
      expect(
        parse({ since: "2026-09-14T12:00:00Z", until: "2026-09-16T00:00:00+02:00" })
      ).toMatchObject({ ok: true, filters: { until: new Date("2026-09-15T22:00:00Z") } });
    });

    it("treats an empty until as omitted", () => {
      expect(parse({ since: "2026-09-14T12:00:00Z", until: "" })).toMatchObject({
        ok: true,
        filters: { until: undefined }
      });
    });

    it.each([
      [
        "yesterday",
        "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
      ],
      [
        "2026-09-15",
        "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
      ],
      [
        "2026-09-15T00:00:00",
        "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
      ],
      [
        "2026-02-30T00:00:00Z",
        "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
      ],
      [`2026-09-15T00:00:00Z${String.fromCharCode(0)}`, "until must not contain a null byte."],
      [["2026-09-15T00:00:00Z", "2026-09-15T01:00:00Z"], "until must be given once."],
      // Equal is not after: the window would be empty by construction.
      ["2026-09-14T12:00:00Z", "until must be after since."],
      ["2026-09-14T14:00:00+02:00", "until must be after since."],
      ["2026-09-14T11:59:59.999Z", "until must be after since."]
    ])("rejects until %j", (until, message) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", until })).toEqual({ ok: false, message });
    });

    it("accepts until one millisecond after since", () => {
      expect(parse({ since: "2026-09-14T12:00:00Z", until: "2026-09-14T12:00:00.001Z" }).ok).toBe(
        true
      );
    });
  });

  describe("entityType", () => {
    it("passes an exact type through", () => {
      expect(parse({ since: "2026-09-14T12:00:00Z", entityType: "job_posting" })).toMatchObject({
        ok: true,
        filters: { entityType: "job_posting" }
      });
    });

    it("accepts the protocol's longest type, counted in code points", () => {
      const longest = "\u{1D11E}".repeat(128);
      expect(parse({ since: "2026-09-14T12:00:00Z", entityType: longest }).ok).toBe(true);
    });

    it.each([
      ["a".repeat(129), "entityType must be at most 128 characters."],
      ["\u{1D11E}".repeat(129), "entityType must be at most 128 characters."],
      [`job${String.fromCharCode(0)}`, "entityType must not contain a null byte."],
      [["customer", "order"], "entityType must be given once."]
    ])("rejects entityType %j", (entityType, message) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", entityType })).toEqual({ ok: false, message });
    });
  });

  describe("q", () => {
    it("passes the text through with surrounding white space removed", () => {
      expect(parse({ since: "2026-09-14T12:00:00Z", q: "  Mirantis AI  " })).toMatchObject({
        ok: true,
        filters: { text: "Mirantis AI" }
      });
    });

    it.each(["", "   "])("treats %j as omitted", (q) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", q })).toMatchObject({
        ok: true,
        filters: { text: undefined }
      });
    });

    it.each([
      ["ab", true],
      // Two code points, four UTF-16 units: the bounds count characters.
      ["\u{1D11E}\u{1D11E}", true],
      ["x".repeat(200), true],
      ["\u{1D11E}".repeat(200), true]
    ])("accepts %j", (q, ok) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", q }).ok).toBe(ok);
    });

    it.each([
      ["a", "q must be 2 to 200 characters."],
      ["\u{1D11E}", "q must be 2 to 200 characters."],
      [" a ", "q must be 2 to 200 characters."],
      ["x".repeat(201), "q must be 2 to 200 characters."],
      ["\u{1D11E}".repeat(201), "q must be 2 to 200 characters."],
      [`ab${String.fromCharCode(0)}`, "q must not contain a null byte."],
      [["ab", "cd"], "q must be given once."]
    ])("rejects q %j", (q, message) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", q })).toEqual({ ok: false, message });
    });
  });

  it.each(["entity_type", "until_", "search", "window"])(
    "rejects the unknown key %s rather than ignoring a filter",
    (key) => {
      expect(parse({ since: "2026-09-14T12:00:00Z", [key]: "x" })).toEqual({
        ok: false,
        message: `${key} is not a parameter of this list. Known parameters: since, until, status, environment, service, entityType, q, limit, cursor.`
      });
    }
  );

  it("repeats only the start of a long unknown key", () => {
    const key = `${"k".repeat(31)}\u{1D11E}${"x".repeat(5000)}`;
    expect(parse({ since: "2026-09-14T12:00:00Z", [key]: "x" })).toEqual({
      ok: false,
      message: `${"k".repeat(31)}\u{1D11E}… is not a parameter of this list. Known parameters: since, until, status, environment, service, entityType, q, limit, cursor.`
    });
  });

  it("repeats a key of exactly 32 characters whole", () => {
    const key = "k".repeat(32);
    const parsed = parse({ since: "2026-09-14T12:00:00Z", [key]: "x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message.startsWith(`${key} is not`)).toBe(true);
  });

  it("accepts limit and cursor, which are parsed elsewhere", () => {
    expect(parse({ since: "2026-09-14T12:00:00Z", limit: "5", cursor: "abc" }).ok).toBe(true);
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
