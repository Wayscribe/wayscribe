import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The tarball the SDK release packs, packed for real.
 *
 * Apache-2.0 asks whoever redistributes the package to pass on its LICENSE and
 * NOTICE, and the npm registry redistributes it to every user. The pack script
 * copies both from the repository root; this proves the copies land in the
 * tarball and match the root byte for byte. scripts/publish-sdk.sh checks the
 * same before a release, and this catches a regression on every push.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const packScript = join(root, "packages/sdk-node/scripts/pack.mjs");

let work = "";
let tarball = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "sdk-pack-test-"));
  tarball = execFileSync("node", [packScript, work], { cwd: root, encoding: "utf8" }).trim();
}, 120_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

const entries = (): string[] =>
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);

const entry = (name: string): string =>
  execFileSync("tar", ["-xzOf", tarball, `package/${name}`], { encoding: "utf8" });

describe("the SDK release tarball", () => {
  it.each(["LICENSE", "NOTICE"])("carries the repository's %s unchanged", (name) => {
    expect(entries()).toContain(`package/${name}`);
    expect(entry(name)).toBe(readFileSync(join(root, name), "utf8"));
  });

  it("names both in the manifest it ships", () => {
    const manifest = JSON.parse(entry("package.json")) as { files?: string[] };
    expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
  });

  it("exports the timing helpers to ES module and CommonJS hosts", () => {
    const directory = join(work, "unpacked");
    mkdirSync(directory);
    execFileSync("tar", ["-xzf", tarball, "-C", directory]);
    const bundledEntry = join(directory, "package", "dist", "index.js");
    const esm = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const sdk = await import(${JSON.stringify(pathToFileURL(bundledEntry).href)}); console.log(typeof sdk.queueMetadata, typeof sdk.httpMetadata);`
      ],
      { encoding: "utf8" }
    ).trim();
    const commonJs = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "--eval",
        `const sdk = require(${JSON.stringify(bundledEntry)}); console.log(typeof sdk.queueMetadata, typeof sdk.httpMetadata);`
      ],
      { encoding: "utf8" }
    ).trim();
    expect(esm).toBe("function function");
    expect(commonJs).toBe("function function");
  });
});
