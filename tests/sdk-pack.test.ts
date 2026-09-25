import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
const publishScript = join(root, "scripts/publish-sdk.sh");
const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();

let work = "";
let tarball = "";
let fakeBin = "";
let publishCall = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "sdk-pack-test-"));
  tarball = execFileSync("node", [packScript, work], { cwd: root, encoding: "utf8" }).trim();

  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })
  ) as { version: string };
  fakeBin = join(work, "bin");
  publishCall = join(work, "publish-call");
  mkdirSync(fakeBin);
  const npm = join(fakeBin, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
set -eu
if [ "\${1:-}" != "publish" ]; then
  exec "\${REAL_NPM}" "$@"
fi

DRY_RUN=
FORCE=
for ARG in "$@"; do
  [ "$ARG" = "--dry-run" ] && DRY_RUN=1
  [ "$ARG" = "--force" ] && FORCE=1
done

if [ -z "$DRY_RUN" ]; then
  echo "test refused a real registry write" >&2
  exit 97
fi
if [ -z "$FORCE" ]; then
  echo "npm error You cannot publish over the previously published versions: ${manifest.version}." >&2
  exit 1
fi
printf '%s\n' 'dry-run force' > "\${PUBLISH_CALL}"
`,
    "utf8"
  );
  chmodSync(npm, 0o755);
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

describe("the SDK publication rehearsal", () => {
  it("passes for an already-published version without publish credentials", () => {
    const manifest = JSON.parse(entry("package.json")) as { version: string };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DRY_RUN: "1",
      // A caller's locale must not reorder the tarball listing the script
      // compares: en_US sorts dist/ before LICENSE, C sorts it after.
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      PUBLISH_CALL: publishCall,
      REAL_NPM: realNpm
    };
    delete env.NPM_ID_TOKEN;
    delete env.SIGSTORE_ID_TOKEN;
    delete env.NPM_TOKEN;
    delete env.NODE_AUTH_TOKEN;

    const result = spawnSync(publishScript, [`v${manifest.version}`], {
      cwd: root,
      encoding: "utf8",
      env
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(publishCall, "utf8").trim()).toBe("dry-run force");
    expect(result.stdout).toContain(
      `dry run passed for @wayscribe/node@${manifest.version}; nothing was published`
    );
  }, 120_000);
});
