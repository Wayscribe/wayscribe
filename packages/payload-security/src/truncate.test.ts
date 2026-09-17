import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { redact } from "./redact.js";
import {
  MAX_STRING_LENGTH,
  truncateStrings,
  truncateText,
  truncationMarker,
  type TruncationStats
} from "./truncate.js";

describe("truncateText", () => {
  it("leaves text at or under the limit untouched", () => {
    expect(truncateText("abc", 3)).toBe("abc");
    const exact = "x".repeat(MAX_STRING_LENGTH);
    expect(truncateText(exact, MAX_STRING_LENGTH)).toBe(exact);
  });

  it("cuts to exactly the limit, marker included, and says how much went", () => {
    const cut = truncateText("a".repeat(70_000), MAX_STRING_LENGTH);
    expect(cut.length).toBe(MAX_STRING_LENGTH);
    expect(cut).toBe(`${"a".repeat(65_500)}[TRUNCATED: 4500 characters removed]`);
  });

  it("counts the removed characters correctly when the marker's own length moves the cut", () => {
    // 100 characters over a limit of 200: the marker holds a 3-digit count,
    // and the cut has to make room for the marker itself, so the count is not
    // simply "length minus limit".
    for (const length of [201, 230, 299, 1_000, 10_050, 99_990, 100_001]) {
      const text = "b".repeat(length);
      const cut = truncateText(text, 200);
      expect(cut.length).toBe(200);
      const removed = Number(/\[TRUNCATED: (\d+) characters removed\]$/.exec(cut)?.[1]);
      expect(cut.length - truncationMarker(removed).length + removed).toBe(length);
    }
  });

  it("repairs a surrogate pair the cut splits, without changing the length", () => {
    // 65,499 ASCII characters then an emoji: the cut at 65,500 falls between
    // its two halves. 5,001 removed makes the marker 36 characters.
    const text = `${"a".repeat(65_499)}😀${"z".repeat(5_000)}`;
    const cut = truncateText(text, MAX_STRING_LENGTH);
    expect(cut.length).toBe(MAX_STRING_LENGTH);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.slice(65_499, 65_500)).toBe("\uFFFD");
  });

  it("never returns more than the limit, even when the limit is shorter than the marker", () => {
    expect(truncateText("x".repeat(50), 10).length).toBeLessThanOrEqual(10);
  });
});

describe("truncateStrings", () => {
  it("returns the same reference when nothing is cut", () => {
    const value = { a: "short", b: ["also short", { c: 1 }] };
    const stats: TruncationStats = { strings: 0, charactersRemoved: 0 };
    expect(truncateStrings(value, 10, stats)).toBe(value);
    expect(stats).toEqual({ strings: 0, charactersRemoved: 0 });
  });

  it("cuts every long string, in objects and arrays, and counts them", () => {
    const stats: TruncationStats = { strings: 0, charactersRemoved: 0 };
    const result = truncateStrings(
      { keep: "ok", long: "x".repeat(300), list: ["y".repeat(250), 7, null] },
      200,
      stats
    ) as { keep: string; long: string; list: unknown[] };
    expect(result.keep).toBe("ok");
    expect(result.long.length).toBe(200);
    expect((result.list[0] as string).length).toBe(200);
    expect(result.list.slice(1)).toEqual([7, null]);
    expect(stats.strings).toBe(2);
    // 135 = 300 - (200 - 35), and 84 = 250 - (200 - 34): the marker takes room too.
    expect(stats.charactersRemoved).toBe(135 + 84);
  });

  it("cuts a top-level string", () => {
    expect(truncateStrings("q".repeat(300), 200)).toHaveLength(200);
  });

  it("keeps a __proto__ key as an own property", () => {
    const value = JSON.parse(`{"__proto__": "${"p".repeat(300)}", "other": 1}`) as object;
    const result = truncateStrings(value, 200) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((Object.getOwnPropertyDescriptor(result, "__proto__")?.value as string).length).toBe(
      200
    );
  });

  it("copies the children before the first cut as they were, in order, holes and __proto__ included", () => {
    const shared = { deep: ["short"] };
    const value = JSON.parse(
      `{"__proto__": {"x": 1}, "first": "a", "nested": null, "late": "${"z".repeat(300)}", "after": 2}`
    ) as Record<string, unknown>;
    value["nested"] = shared;
    // eslint-disable-next-line no-sparse-arrays -- the hole before the cut is the case
    const list: unknown[] = [shared, , "b", "w".repeat(300), "c"];
    const before = JSON.stringify({ value, list });

    const result = truncateStrings(value, 200) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["__proto__", "first", "nested", "late", "after"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toBe(value["__proto__"]);
    expect(result["nested"]).toBe(shared);
    expect((result["late"] as string).length).toBe(200);
    expect(result["after"]).toBe(2);

    const cutList = truncateStrings(list, 200) as unknown[];
    expect(cutList).toHaveLength(5);
    expect(cutList[0]).toBe(shared);
    // Filled as it always was: a hole before the cut is an undefined element.
    expect(1 in cutList).toBe(true);
    expect(cutList[1]).toBeUndefined();
    expect(cutList[2]).toBe("b");
    expect((cutList[3] as string).length).toBe(200);
    expect(cutList[4]).toBe("c");

    // The input is not changed.
    expect(JSON.stringify({ value, list })).toBe(before);
  });

  it("does not cut keys, which the server's limit does not measure", () => {
    const key = "k".repeat(300);
    const result = truncateStrings({ [key]: "v" }, 200) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual([key]);
  });
});

/**
 * A cut must not hide a header block from the server's masking.
 *
 * The server masks secret-named lines only in text that looks like a header
 * block, which meant text containing a line break. A block whose first header
 * is secret only by the environment's own redaction paths, which the SDK does
 * not know, with a value over the limit, lost its only line break to the cut,
 * and about 65,500 characters of the value were stored unmasked.
 */
describe("truncation and header masking", () => {
  const environmentPaths = ["**.x-internal-token", ...DEFAULT_SECRET_PATHS];
  const block = `x-internal-token: ${"v".repeat(70_000)}\r\nhost: example.com\r\n\r\n`;

  it("keeps a line break before the marker when the text was a header block", () => {
    const cut = truncateText(block, MAX_STRING_LENGTH);
    expect(cut).toHaveLength(MAX_STRING_LENGTH);
    expect(cut.endsWith("\r\n[TRUNCATED: 4543 characters removed]")).toBe(true);
    expect(cut.startsWith(`x-internal-token: ${"v".repeat(65_480)}\r\n`)).toBe(true);
  });

  it("adds no line break to text that had none", () => {
    expect(truncateText("x".repeat(300), 200).includes("\r\n")).toBe(false);
  });

  it("leaves the server able to mask the cut block, end to end", () => {
    // The SDK redacts with its own paths (the defaults), then cuts; the server
    // redacts again with the environment's.
    const sent = truncateStrings(redact({ raw: block }, DEFAULT_SECRET_PATHS), MAX_STRING_LENGTH);
    const stored = redact(sent, environmentPaths) as { raw: string };
    expect(stored.raw).toBe("x-internal-token: [REDACTED]\r\n[TRUNCATED: 4543 characters removed]");
    expect(stored.raw).not.toContain("vvvv");
  });

  it("masks a cut line even when a client sent it without the line break", () => {
    // Another client, or a Node SDK from before this rule, may cut a block to
    // one line. Text ending in the marker is read as a header block too.
    const oneLine = `x-internal-token: ${"v".repeat(500)}[TRUNCATED: 69500 characters removed]`;
    const stored = redact({ raw: oneLine }, environmentPaths) as { raw: string };
    expect(stored.raw).toBe("x-internal-token: [REDACTED]");
  });

  it("leaves a cut line alone when its name is not secret", () => {
    const oneLine = `x-request-id: ${"v".repeat(50)}[TRUNCATED: 10 characters removed]`;
    expect((redact({ raw: oneLine }, environmentPaths) as { raw: string }).raw).toBe(oneLine);
    const prose = `a note${"v".repeat(50)}[TRUNCATED: 10 characters removed]`;
    expect((redact({ raw: prose }, environmentPaths) as { raw: string }).raw).toBe(prose);
  });
});
