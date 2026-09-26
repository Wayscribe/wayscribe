import { describe, expect, it } from "vitest";
import { MAX_PATH_KEPT, otlpPath, WarnedSecretNames } from "./secret-names.js";

describe("otlpPath", () => {
  it("names the attribute each field is read from", () => {
    expect(otlpPath("input.gatewayApiToken")).toBe("wayscribe.input.gatewayApiToken");
    expect(otlpPath("output.a.b")).toBe("wayscribe.output.a.b");
    expect(otlpPath("metadata.x-auth-token")).toBe("wayscribe.metadata.x-auth-token");
    expect(otlpPath("input[*].authToken")).toBe("wayscribe.input[*].authToken");
    expect(otlpPath("error.code")).toBe("wayscribe.error.code");
  });

  it("keeps a field no attribute fills, and never matches a field by prefix", () => {
    expect(otlpPath("runtime.sessionId")).toBe("runtime.sessionId");
    expect(otlpPath("inputs.token")).toBe("inputs.token");
  });

  it("cuts a long path, so a sender's key names cannot size the log or the memory", () => {
    const long = otlpPath(`input.${"a".repeat(100_000)}Token`);
    expect(long).toHaveLength(MAX_PATH_KEPT);
    expect(long.startsWith("wayscribe.input.aaa")).toBe(true);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("WarnedSecretNames", () => {
  it("returns each (environment, path) once", () => {
    const warned = new WarnedSecretNames();
    expect(warned.fresh("env-a", ["p1", "p2"])).toEqual(["p1", "p2"]);
    expect(warned.fresh("env-a", ["p2", "p3"])).toEqual(["p3"]);
    expect(warned.fresh("env-b", ["p1"])).toEqual(["p1"]);
    expect(warned.fresh("env-a", ["p1", "p2", "p3"])).toEqual([]);
  });

  it("stays within its capacity by forgetting, at the cost of warning again", () => {
    const warned = new WarnedSecretNames(3);
    expect(warned.fresh("env", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(warned.fresh("env", ["d"])).toEqual(["d"]);
    expect(warned.fresh("env", ["a"])).toEqual(["a"]);
    for (let i = 0; i < 1_000; i += 1) warned.fresh("env", [`n${String(i)}`]);
    expect((warned as unknown as { seen: Set<string> }).seen.size).toBeLessThanOrEqual(3);
  });
});
