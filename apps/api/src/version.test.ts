import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRunningVersion } from "./version.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("resolveRunningVersion", () => {
  it("reports what the image was built as", () => {
    expect(
      resolveRunningVersion({
        WAYSCRIBE_BUILD_VERSION: "v0.1.0",
        WAYSCRIBE_BUILD_COMMIT: "27f4d64e0b5a"
      })
    ).toEqual({ version: "v0.1.0", commit: "27f4d64e0b5a", source: "build" });
  });

  it("leaves the commit out when the build did not record one", () => {
    expect(resolveRunningVersion({ WAYSCRIBE_BUILD_VERSION: "v0.1.0" })).toEqual({
      version: "v0.1.0",
      source: "build"
    });
  });

  it("treats an empty build argument as absent, which is what an unset ARG bakes in", () => {
    expect(
      resolveRunningVersion({ WAYSCRIBE_BUILD_VERSION: "", WAYSCRIBE_BUILD_COMMIT: "" })
    ).toEqual({ version: packageVersion, source: "package" });
  });

  it("falls back to the package version, so a source run says what it is", () => {
    // Not a release: the workspace packages are all 0.0.0, and the source says
    // so rather than pretending the number means anything.
    expect(resolveRunningVersion({})).toEqual({ version: packageVersion, source: "package" });
  });

  it("never shells out to git", () => {
    const source = readFileSync(new URL("./version.ts", import.meta.url), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("execSync");
  });
});
