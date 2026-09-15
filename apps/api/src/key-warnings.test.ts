import { describe, expect, it } from "vitest";
import { unknownKeyWarning, type WarnLogger } from "./key-warnings.js";

function recordingLogger(): { log: WarnLogger; warnings: { fields: unknown; message: string }[] } {
  const warnings: { fields: unknown; message: string }[] = [];
  return {
    warnings,
    log: {
      warn: (fields: unknown, message: string) => {
        warnings.push({ fields, message });
      }
    }
  };
}

describe("unknownKeyWarning", () => {
  it("warns once per key id however many reads meet it", () => {
    // A search over a table under a removed key meets the id on every row of
    // every request. One line per id says everything; a line per read would
    // bury the rest of the log.
    const { log, warnings } = recordingLogger();
    const warn = unknownKeyWarning(log);

    warn("aaaaaaaaaaaa");
    warn("aaaaaaaaaaaa");
    warn("bbbbbbbbbbbb");
    warn("aaaaaaaaaaaa");

    expect(warnings.map((warning) => warning.fields)).toEqual([
      { keyId: "aaaaaaaaaaaa" },
      { keyId: "bbbbbbbbbbbb" }
    ]);
    expect(warnings[0]?.message).toContain("aaaaaaaaaaaa");
    expect(warnings[0]?.message).toContain("rotate:status");
  });
});
