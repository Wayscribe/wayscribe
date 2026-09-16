import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseManifest } from "../scripts/release-manifest.mjs";

/**
 * The manifest users install, as the repository declares it and as the release
 * pack script rewrites it. The tarball's file list is checked by
 * scripts/publish-sdk.sh, which builds; this pins what can be pinned without
 * building.
 */

interface Manifest {
  engines?: { node?: string };
  exports?: Record<string, unknown> | undefined;
  publishConfig?: { exports?: Record<string, unknown> };
  files?: string[];
  [key: string]: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as Manifest;

describe("the package manifest", () => {
  it("claims only Node versions where require() of an ES module works unflagged", () => {
    // Node 20 is past end of life, and 22.0 to 22.11 keep require(esm) behind
    // a flag, so a CommonJS host there could not load the package.
    expect(manifest.engines?.node).toBe(">=22.12.0");
  });

  it("exposes package.json, in the repository and in what is published", () => {
    expect(manifest.exports?.["./package.json"]).toBe("./package.json");
    expect(manifest.publishConfig?.exports?.["./package.json"]).toBe("./package.json");
  });

  it("publishes one entry point, with one declaration file", () => {
    expect(manifest.publishConfig?.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js"
    });
    expect(manifest.files).toEqual(["dist", "README.md"]);
  });
});

describe("the release manifest", () => {
  const packed: Manifest = {
    ...manifest,
    // What `pnpm pack` writes: publishConfig applied, workspace ranges
    // rewritten to a version published nowhere.
    exports: manifest.publishConfig?.exports,
    devDependencies: { "@flight-recorder/protocol": "0.0.0", esbuild: "^0.25.12" }
  };
  const released = releaseManifest(packed) as Manifest;

  it("drops what only building the package needs", () => {
    expect(released).not.toHaveProperty("devDependencies");
    expect(released).not.toHaveProperty("scripts");
    expect(JSON.stringify(released)).not.toContain("0.0.0");
  });

  it("keeps no development condition and no source path", () => {
    expect(JSON.stringify(released)).not.toContain("development");
    expect(JSON.stringify(released)).not.toContain("src/");
  });

  it("keeps what npm and a user read", () => {
    for (const key of ["name", "version", "type", "license", "repository", "engines", "files"]) {
      expect(released[key], key).toEqual(packed[key]);
    }
    expect(released.exports).toEqual(manifest.publishConfig?.exports);
    expect(released.publishConfig).toEqual({ access: "public" });
  });

  it("has no dependencies at all", () => {
    expect(released).not.toHaveProperty("dependencies");
    expect(released).not.toHaveProperty("peerDependencies");
  });
});
