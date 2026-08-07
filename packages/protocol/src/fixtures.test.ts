import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./envelope.js";
import { PROTOCOL_ERROR_CODES } from "./errors.js";

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("protocol fixtures", () => {
  it("v0.1-valid-minimal parses", () => {
    expect(parseEnvelope(loadFixture("v0.1-valid-minimal")).ok).toBe(true);
  });

  it("v0.1-valid-complete parses", () => {
    expect(parseEnvelope(loadFixture("v0.1-valid-complete")).ok).toBe(true);
  });

  it.each(["v0.1-invalid-missing-id", "v0.1-invalid-operation", "v0.1-invalid-timestamp"])(
    "%s is rejected as invalid_event",
    (name) => {
      const result = parseEnvelope(loadFixture(name));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(PROTOCOL_ERROR_CODES.invalidEvent);
    }
  );
});
