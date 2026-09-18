import { describe, expect, it } from "vitest";
import { parseJourneyListQuery } from "./journey-list-query.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SINCE_CLOCK_TOLERANCE_MS,
  pageLimit
} from "./query-params.js";
import { parseSearchQuery } from "./search-query.js";

/** Written this way so the source file itself stays plain text. */
const NUL = String.fromCharCode(0);

const LIMIT_MESSAGE = `limit must be a whole number from 1 to ${String(MAX_PAGE_LIMIT)}.`;

/**
 * F-029: `limit` was read with `Number.parseInt`, which stops at the first
 * character that is not a digit. A NUL, or the comma a repeated parameter's
 * array stringifies to, cut the value short instead of being refused, so
 * `limit=1&limit=99` returned one row and `limit=2%005` two. Nonsense values
 * (`abc`, `0`, `-1`) silently became the default, and `1000` the maximum.
 */
describe("pageLimit", () => {
  it("is the default when limit is absent or empty, as a GET form sends it", () => {
    expect(pageLimit({})).toEqual({ ok: true, value: DEFAULT_PAGE_LIMIT });
    expect(pageLimit({ limit: "" })).toEqual({ ok: true, value: DEFAULT_PAGE_LIMIT });
    expect(DEFAULT_PAGE_LIMIT).toBe(25);
  });

  it.each([
    ["1", 1],
    ["25", 25],
    ["99", 99],
    ["100", 100],
    ["007", 7]
  ])("takes %s as %i", (raw, expected) => {
    expect(pageLimit({ limit: raw })).toEqual({ ok: true, value: expected });
  });

  it("refuses a repeated limit, whichever order the values come in", () => {
    // The two F-029 rows: parseInt read "1,99" as 1 and "99,1" as 99.
    for (const values of [
      ["1", "99"],
      ["99", "1"],
      ["5", "5"]
    ]) {
      expect(pageLimit({ limit: values })).toEqual({
        ok: false,
        message: "limit must be given once."
      });
    }
  });

  it("refuses a NUL rather than reading the digits before it", () => {
    expect(pageLimit({ limit: `2${NUL}5` })).toEqual({
      ok: false,
      message: "limit must not contain a null byte."
    });
  });

  it.each(["abc", "0", "-1", "101", "500", "1000", "2.5", "1e2", "+5", " 5", "5 ", "0x10", "5abc"])(
    "refuses %j instead of clamping it",
    (raw) => {
      expect(pageLimit({ limit: raw })).toEqual({ ok: false, message: LIMIT_MESSAGE });
    }
  );

  it("refuses a number too large to be a page size", () => {
    expect(pageLimit({ limit: "9".repeat(400) })).toEqual({ ok: false, message: LIMIT_MESSAGE });
  });
});

/**
 * F-035: a `since` 120 seconds ahead was refused with "since must not be in
 * the future.", while one 30 seconds ahead was accepted. The message stated a
 * rule the server does not enforce, and left out the tolerance a caller with a
 * fast clock needs to work out what happened.
 */
describe("the refusal of a future since", () => {
  const NOW = new Date("2026-09-15T12:00:00.000Z");
  const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
  const parsers = [
    ["the journey list", (since: string) => parseJourneyListQuery({ since }, NOW)],
    ["search", (since: string) => parseSearchQuery({ q: "CUST-1", since }, NOW)]
  ] as const;

  it.each(parsers)("%s names the tolerance the check applies", (_name, parse) => {
    const seconds = SINCE_CLOCK_TOLERANCE_MS / 1000;
    expect(Number.isInteger(seconds)).toBe(true);
    // The boundary is the tolerance itself: at it, accepted; a millisecond
    // past it, refused with a message that names it.
    expect(parse(at(SINCE_CLOCK_TOLERANCE_MS)).ok).toBe(true);
    expect(parse(at(SINCE_CLOCK_TOLERANCE_MS + 1))).toEqual({
      ok: false,
      message: `since must not be more than ${String(seconds)} seconds ahead of the API's clock.`
    });
  });

  it.each(parsers)("%s accepts a since inside the tolerance", (_name, parse) => {
    // The finding's second row: 30 seconds ahead is a 200.
    expect(parse(at(30_000)).ok).toBe(true);
  });
});
