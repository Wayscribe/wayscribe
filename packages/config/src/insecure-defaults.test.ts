import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findInsecureDefaults,
  LEGACY_PUBLISHED_DEMO_API_KEY,
  PUBLISHED_DEMO_API_KEY,
  PUBLISHED_DEMO_API_KEYS
} from "./insecure-defaults.js";

describe("findInsecureDefaults", () => {
  it("flags a published default", () => {
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000",
      ADMIN_TOKEN: "a-real-secret-that-is-long-enough-x"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY"]);
  });

  it("counts the demo key published before the rename as published", () => {
    expect(LEGACY_PUBLISHED_DEMO_API_KEY).toBe("fr_demo" + "0".repeat(29));
    expect(PUBLISHED_DEMO_API_KEY).toBe("wsk_demo" + "0".repeat(28));
    expect(PUBLISHED_DEMO_API_KEYS).toEqual([
      PUBLISHED_DEMO_API_KEY,
      LEGACY_PUBLISHED_DEMO_API_KEY
    ]);
    for (const demoKey of PUBLISHED_DEMO_API_KEYS) {
      expect(findInsecureDefaults({ ADMIN_TOKEN: demoKey }).map((f) => f.variable)).toEqual([
        "ADMIN_TOKEN"
      ]);
    }
  });

  it("flags every published default at once", () => {
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000",
      ADMIN_TOKEN: "local-admin-token-000000000000000"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY", "ADMIN_TOKEN"]);
  });

  it("flags a published default left in ENCRYPTION_KEY_PREVIOUS", () => {
    // Rotating away from the development default leaves it here for the grace
    // period, and a stack still reading under it is still readable by anyone.
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "5f3a9c1e7b2d8046f1a3c5e79b0d2468",
      ENCRYPTION_KEY_PREVIOUS: "replace-for-local-development-0000",
      ADMIN_TOKEN: "0a1b2c3d4e5f60718293a4b5c6d7e8f9"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY_PREVIOUS"]);
  });

  it("tells an operator mid-rotation to finish it, not to replace the previous key", () => {
    // The generic advice, to set your own value, would replace the key the
    // stored data is still under and make it unreadable.
    const [finding] = findInsecureDefaults({
      ENCRYPTION_KEY: "5f3a9c1e7b2d8046f1a3c5e79b0d2468",
      ENCRYPTION_KEY_PREVIOUS: "replace-for-local-development-0000"
    });
    expect(finding?.message).toBe(
      "ENCRYPTION_KEY_PREVIOUS, the key being rotated out, is a published development default, so data still under it is readable by anyone. " +
        "Do not replace it: finish rotate:reencrypt, then remove it (docs/OPERATIONS.md §6)."
    );
    expect(finding?.message).not.toContain("openssl");
  });

  it("recognises a published default despite surrounding whitespace", () => {
    const findings = findInsecureDefaults({
      ENCRYPTION_KEY: "replace-for-local-development-0000\n"
    });
    expect(findings.map((f) => f.variable)).toEqual(["ENCRYPTION_KEY"]);
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

  it("recognises every value the source Compose stacks ship as a published default", () => {
    // infrastructure/defaults.env is where compose.yaml and compose.demo.yaml
    // get their secrets when .env sets none. A value changed there but not in
    // the list above would boot a stack on a published secret with no warning.
    const shipped = Object.fromEntries(
      readFileSync(new URL("../../../infrastructure/defaults.env", import.meta.url), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
    expect(Object.keys(shipped).sort()).toEqual(["ADMIN_TOKEN", "ENCRYPTION_KEY"]);
    expect(
      findInsecureDefaults(shipped)
        .map((f) => f.variable)
        .sort()
    ).toEqual(["ADMIN_TOKEN", "ENCRYPTION_KEY"]);
  });
});
