import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const publishScript = join(root, "scripts", "publish-sdk.sh");
const manifest = JSON.parse(
  readFileSync(join(root, "packages", "sdk-node", "package.json"), "utf8")
) as { version: string };

let work = "";
let fakeBin = "";
let publishCall = "";
const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "sdk-publish-test-"));
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
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("the SDK publication rehearsal", () => {
  it("passes for an already-published version without publish credentials", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DRY_RUN: "1",
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
