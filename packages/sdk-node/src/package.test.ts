import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGAL_FILES,
  PACKAGE_DIRECTORY,
  REPOSITORY_BLOB,
  releaseManifest,
  releaseReadme
} from "../scripts/release-manifest.mjs";

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
    devDependencies: { "@wayscribe/protocol": "0.0.0", esbuild: "^0.25.12" }
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
    for (const key of ["name", "version", "type", "license", "repository", "engines"]) {
      expect(released[key], key).toEqual(packed[key]);
    }
    expect(released.exports).toEqual(manifest.publishConfig?.exports);
    expect(released.publishConfig).toEqual({ access: "public" });
  });

  it("lists the LICENSE and NOTICE after the files the repository declares", () => {
    expect(LEGAL_FILES).toEqual(["LICENSE", "NOTICE"]);
    expect(released.files).toEqual(["dist", "README.md", "LICENSE", "NOTICE"]);
    const again = releaseManifest({ ...packed, files: ["dist", "LICENSE"] }) as Manifest;
    expect(again.files).toEqual(["dist", "LICENSE", "NOTICE"]);
  });

  it("has no dependencies at all", () => {
    expect(released).not.toHaveProperty("dependencies");
    expect(released).not.toHaveProperty("peerDependencies");
  });
});

describe("releaseReadme", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const targets = (markdown: string): string[] =>
    [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");

  it("leaves no relative link in the shipped README, and each one names a file at the tag", () => {
    const relative = targets(readme).filter(
      (t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("#")
    );
    expect(relative.length).toBeGreaterThan(0);
    const shipped = releaseReadme(readme, "9.8.7");
    const base = `${REPOSITORY_BLOB}/v9.8.7/`;
    for (const target of targets(shipped)) {
      if (target.startsWith("#") || !target.startsWith(base)) continue;
      const file = target.slice(base.length).split("#")[0] ?? "";
      expect(existsSync(join(repositoryRoot, file)), file).toBe(true);
    }
    const left = targets(shipped).filter(
      (t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("#")
    );
    expect(left).toEqual([]);
  });

  it("resolves ./ and ../ against the package, keeps anchors, and leaves absolute links alone", () => {
    const base = `${REPOSITORY_BLOB}/v1.2.3/`;
    expect(
      releaseReadme(
        "[a](../../docs/X.md#3-limits) [b](./CHANGELOG.md) [c](https://x.test/y) [d](#local) [e](mailto:a@b.test)",
        "1.2.3"
      )
    ).toBe(
      `[a](${base}docs/X.md#3-limits) [b](${base}${PACKAGE_DIRECTORY}/CHANGELOG.md) [c](https://x.test/y) [d](#local) [e](mailto:a@b.test)`
    );
    expect(() => releaseReadme("[x](../../../outside.md)", "1.2.3")).toThrow(
      /leaves the repository/
    );
  });
});
