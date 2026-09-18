import { describe, expect, it } from "vitest";
import { MAX_METADATA_ENTRIES, MAX_METADATA_TEXT, metadataEntries } from "./metadata";

describe("metadataEntries", () => {
  it("lists an object's keys sorted, each value as text", () => {
    expect(
      metadataEntries({ status: 202, queue: "jobs", retried: false, delay: null }).entries
    ).toEqual([
      { key: "delay", value: "null" },
      { key: "queue", value: "jobs" },
      { key: "retried", value: "false" },
      { key: "status", value: "202" }
    ]);
  });

  it("writes a nested value as compact JSON", () => {
    expect(metadataEntries({ target: { host: "api.example", port: 443 } }).entries).toEqual([
      { key: "target", value: '{"host":"api.example","port":443}' }
    ]);
  });

  it("has nothing to list for an absent, null or empty value", () => {
    for (const value of [undefined, null, {}]) {
      expect(metadataEntries(value)).toEqual({ entries: [], omitted: 0 });
    }
  });

  // Stored before the protocol required an object, or by something else
  // writing to the table: shown, not dropped.
  it("shows a value that is not an object as one entry", () => {
    expect(metadataEntries("a bare string").entries).toEqual([
      { key: "(value)", value: "a bare string" }
    ]);
  });

  // Metadata is whatever the instrumented code sent. The page stays readable
  // however much there is: a bounded number of entries, each bounded in length.
  it("lists at most MAX_METADATA_ENTRIES and counts the rest", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES + 7 }, (_, index) => [
        `k${String(index).padStart(3, "0")}`,
        index
      ])
    );
    const listed = metadataEntries(many);
    expect(listed.entries).toHaveLength(MAX_METADATA_ENTRIES);
    expect(listed.omitted).toBe(7);
  });

  it("cuts a long key or value at MAX_METADATA_TEXT characters, and says so", () => {
    const long = "x".repeat(MAX_METADATA_TEXT * 3);
    const [entry] = metadataEntries({ [long]: long }).entries;
    expect(Array.from(entry?.key ?? "")).toHaveLength(MAX_METADATA_TEXT + 1);
    expect(entry?.key.endsWith("…")).toBe(true);
    expect(Array.from(entry?.value ?? "")).toHaveLength(MAX_METADATA_TEXT + 1);
    expect(entry?.value.endsWith("…")).toBe(true);
  });

  // Cut by code point, so an emoji at the boundary is not split into half a
  // surrogate pair, which a browser shows as a replacement character.
  it("never cuts a character in half", () => {
    const value = "😀".repeat(MAX_METADATA_TEXT + 5);
    const [entry] = metadataEntries({ k: value }).entries;
    expect(entry?.value).toBe(`${"😀".repeat(MAX_METADATA_TEXT)}…`);
  });

  // The function half of it: an own `__proto__` key, as JSON.parse makes one,
  // is listed. That the key then reaches the page both ways the event is
  // shown is getEvent's test (api.test.ts) and the browser suite's
  // (e2e/metadata.spec.ts).
  it("keeps a key that would otherwise be read as the object's prototype", () => {
    const value = JSON.parse('{"__proto__": "kept", "constructor": 1}') as unknown;
    expect(metadataEntries(value).entries).toEqual([
      { key: "__proto__", value: "kept" },
      { key: "constructor", value: "1" }
    ]);
  });
});
