import { describe, expect, it } from "vitest";
import { findInsecureDefaults } from "./insecure-defaults.js";

describe("findInsecureDefaults", () => {
  it("flags a published default", () => {
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000",
      ADMIN_TOKEN: "a-real-secret-that-is-long-enough-x"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY"]);
  });

  it("flags every published default at once", () => {
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000",
      ADMIN_TOKEN: "local-admin-token-000000000000000"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY", "ADMIN_TOKEN"]);
  });

  it("says nothing about real secrets", () => {
    expect(
      findInsecureDefaults({
        ENCRYPTION_KEY: "5f3a9c1e7b2d8046f1a3c5e79b0d2468",
        ADMIN_TOKEN: "0a1b2c3d4e5f60718293a4b5c6d7e8f9"
      })
    ).toEqual([]);
  });

  it("says nothing when a variable is absent", () => {
    expect(findInsecureDefaults({})).toEqual([]);
  });

  it("names the variable and tells the reader how to fix it", () => {
    // A warning that does not say what to do produces a stack that keeps
    // running on a published token while its operator nods at the log line.
    const [finding] = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000"
    });
    expect(finding?.message).toContain("ENCRYPTION_KEY");
    expect(finding?.message).toContain("openssl rand -hex 32");
  });
});
