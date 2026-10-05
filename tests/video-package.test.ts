import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { read, root } from "./docs-helpers.js";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("the demo video project", () => {
  it("stays out of the root workspace, the root lint and the images", () => {
    const workspace = parse(read("pnpm-workspace.yaml")) as { packages: string[] };
    expect(workspace.packages.some((pattern) => pattern.startsWith("video"))).toBe(false);
    expect(existsSync(join(root, "video/pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(root, "video/pnpm-workspace.yaml"))).toBe(true);
    expect(read("eslint.config.js")).toContain('"video/**"');
    expect(read(".dockerignore").split("\n")).toContain("video");
    expect(read("scripts/verify-image-contents.sh")).toMatch(/for DIR in [^\n]* \/app\/video /);
  });

  it("pins every dependency to an exact version, and Remotion to Shorts Studio's", () => {
    const manifest = JSON.parse(read("video/package.json")) as PackageJson;
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      if (name === "remotion" || name.startsWith("@remotion/"))
        expect(version, name).toBe("4.0.532");
    }
  });
});
