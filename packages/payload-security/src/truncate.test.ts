import { describe, expect, it } from "vitest";
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

  it("does not cut keys, which the server's limit does not measure", () => {
    const key = "k".repeat(300);
    const result = truncateStrings({ [key]: "v" }, 200) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual([key]);
  });
});
