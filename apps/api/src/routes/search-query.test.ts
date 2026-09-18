import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./search-query.js";

/** Written this way so the source file itself stays plain text. */
const NUL = String.fromCharCode(0);
const NOW = new Date("2026-09-15T12:00:00.000Z");
const parse = (query: Record<string, unknown>): ReturnType<typeof parseSearchQuery> =>
  parseSearchQuery(query, NOW);

describe("parseSearchQuery", () => {
  it("needs only q, and narrows nothing when the window is absent", () => {
    expect(parse({ q: "CUST-1" })).toEqual({
      ok: true,
      query: "CUST-1",
      filters: { since: undefined, until: undefined, environment: undefined }
    });
  });

  it("trims q the way the route always has", () => {
    expect(parse({ q: "  CUST-1  " })).toMatchObject({ ok: true, query: "CUST-1" });
  });

  it("passes the window and the environment through", () => {
    expect(
      parse({
        q: "CUST-1",
        since: "2026-09-14T12:00:00Z",
        until: "2026-09-15T00:00:00Z",
        environment: "production"
      })
    ).toEqual({
      ok: true,
      query: "CUST-1",
      filters: {
        since: new Date("2026-09-14T12:00:00Z"),
        until: new Date("2026-09-15T00:00:00Z"),
        environment: "production"
      }
    });
  });

  it("ignores limit and cursor, which every list parses the same way", () => {
    expect(parse({ q: "CUST-1", limit: "10", cursor: "abc" })).toMatchObject({ ok: true });
  });

  it("treats an empty value as omitted, as a GET form sends one", () => {
    expect(parse({ q: "CUST-1", since: "", until: "", environment: "" })).toEqual({
      ok: true,
      query: "CUST-1",
      filters: { since: undefined, until: undefined, environment: undefined }
    });
  });

  it.each([
    [{}, "q is required."],
    [{ q: "   " }, "q is required."],
    [{ q: `CUST-1${NUL}` }, "q must not contain a null byte."],
    // The wording search has always used for this one. Every other parameter
    // reads "must be given once", but changing q's message would change an
    // answer callers already see.
    [{ q: ["a", "b"] }, "q may be given once."],
    [
      { q: "CUST-1", since: "2026-09-14" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { q: "CUST-1", since: "2026-02-30T00:00:00Z" },
      "since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { q: "CUST-1", until: "2026-09-14" },
      "until must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z."
    ],
    [
      { q: "CUST-1", since: "2026-09-16T12:00:00Z" },
      "since must not be more than 60 seconds ahead of the API's clock."
    ],
    [
      { q: "CUST-1", since: "2026-09-14T12:00:00Z", until: "2026-09-14T12:00:00Z" },
      "until must be after since."
    ],
    [{ q: "CUST-1", environment: ["a", "b"] }, "environment must be given once."],
    [{ q: "CUST-1", environment: `prod${NUL}` }, "environment must not contain a null byte."],
    [
      { q: "CUST-1", status: "failed" },
      "status is not a parameter of this search. Known parameters: q, since, until, environment, limit, cursor."
    ]
  ])("refuses %o", (query, message) => {
    expect(parse(query as Record<string, unknown>)).toEqual({ ok: false, message });
  });

  it("tolerates a minute of clock skew on since, as the journey list does", () => {
    expect(parse({ q: "CUST-1", since: "2026-09-15T12:00:30Z" }).ok).toBe(true);
  });

  it("refuses a key holding a null byte without repeating it", () => {
    // The key is echoed into the response and the request log, so it gets the
    // check a value gets. `?q%00=y` used to put a raw NUL in both.
    const parsed = parse({ q: "CUST-1", [`q${NUL}`]: "y" });
    expect(parsed).toEqual({
      ok: false,
      message:
        "A parameter name must not contain a null byte. Known parameters: q, since, until, environment, limit, cursor."
    });
    expect(parsed.ok ? "" : parsed.message).not.toContain(NUL);
  });

  it("echoes at most 32 code points of an unknown key", () => {
    const parsed = parse({ q: "CUST-1", ["x".repeat(80)]: "1" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(`${"x".repeat(32)}…`);
  });
});
