import { describe, expect, it } from "vitest";
import { loadWebConfig } from "./config";

const valid = { ADMIN_TOKEN: "admin-token-for-tests-0000000000", API_URL: "http://api:8080" };

describe("loadWebConfig", () => {
  it("parses a valid environment", () => {
    expect(loadWebConfig(valid).API_URL).toBe("http://api:8080");
  });

  it("names a missing variable", () => {
    const { API_URL: _omitted, ...without } = valid;
    expect(() => loadWebConfig(without)).toThrow(/API_URL/);
  });

  it("rejects a short admin token", () => {
    expect(() => loadWebConfig({ ...valid, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });

  it("rejects a malformed API URL", () => {
    expect(() => loadWebConfig({ ...valid, API_URL: "not-a-url" })).toThrow(/API_URL/);
  });
});
