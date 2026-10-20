import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/image-tag-policy.sh, which publish-image.sh asks before it tags: a
 * published version is never rebuilt, and :latest follows only the highest
 * final version. The registry is a stub `docker` that knows a list of
 * references; nothing here touches a network.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const policy = `${root}scripts/image-tag-policy.sh`;

let bin = "";
beforeAll((): void => {
  bin = mkdtempSync(join(tmpdir(), "policy-"));
  const docker = join(bin, "docker");
  // A registry in the file STATE (one reference per line), and a log of the calls.
  //   inspect <ref>               succeeds when STATE holds <ref>
  //   inspect <ref> --format ...  prints a manifest with the one digest built
  //   build                       writes that digest to --metadata-file, then adds
  //                               APPEAR to STATE (a tag pushed by someone else meanwhile)
  //   imagetools create --tag t   adds every --tag to STATE
  writeFileSync(
    docker,
    `#!/bin/sh
echo "$*" >> "$LOG"
case "$*" in
  "buildx imagetools inspect"*--format*) echo '{"digest":"sha256:abc"}' ;;
  "buildx imagetools inspect"*) grep -qx "$4" "$STATE" ;;
  "buildx build"*)
    while [ "$#" -gt 0 ]; do
      [ "$1" = "--metadata-file" ] && echo '{"containerimage.digest":"sha256:abc"}' > "$2"
      shift
    done
    [ -z "\${APPEAR:-}" ] || echo "$APPEAR" >> "$STATE" ;;
  "buildx imagetools create"*)
    while [ "$#" -gt 0 ]; do
      [ "$1" = "--tag" ] && echo "$2" >> "$STATE"
      shift
    done ;;
esac
`
  );
  chmodSync(docker, 0o755);
});
afterAll((): void => {
  rmSync(bin, { recursive: true, force: true });
});

let counter = 0;
/** A registry holding `refs`, with a fresh log; returns the environment for the stub docker. */
function registry(...refs: string[]): Record<string, string> {
  counter += 1;
  const state = join(bin, `state-${String(counter)}`);
  writeFileSync(state, refs.map((ref) => `${ref}\n`).join(""));
  return { STATE: state, LOG: join(bin, `log-${String(counter)}`) };
}

function run(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("sh", [policy, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ...env }
  });
}

describe("image-tag-policy.sh free", () => {
  it("refuses a tag the registry already holds, saying so", () => {
    const result = run(["free", "reg/api", "v1.2.3"], registry("reg/api:v1.2.3"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reg/api:v1.2.3 already exists");
  });

  it("accepts a tag the registry does not hold", () => {
    expect(run(["free", "reg/api", "v1.2.4"], registry("reg/api:v1.2.3")).status).toBe(0);
  });
});

describe("image-tag-policy.sh moves-latest", () => {
  it("sees a higher tag on another line of history, as git lists it", () => {
    // v0.3.0 is not an ancestor of the v0.2.8 maintenance commit; git still lists it.
    const repo = mkdtempSync(join(tmpdir(), "policy-repo-"));
    try {
      const git = (...args: string[]): void => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        expect(result.status, args.join(" ")).toBe(0);
      };
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base"
      );
      git("tag", "v0.2.7");
      git("checkout", "-q", "-b", "maintenance");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fix"
      );
      git("tag", "v0.2.8");
      git("checkout", "-q", "main");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "next"
      );
      git("tag", "v0.3.0");
      git("checkout", "-q", "maintenance");
      const result = spawnSync("sh", [policy, "moves-latest", "v0.2.8"], {
        cwd: repo,
        encoding: "utf8"
      });
      expect(result.status).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  const tags = "v0.9.0\nv0.10.0\nv0.10.1\nv0.11.0-rc.1\nphase-5\n";
  const moves = (tag: string): boolean =>
    run(["moves-latest", tag], { RELEASE_TAGS: tags }).status === 0;

  it("moves latest to the highest final version, ordered as versions", () => {
    expect(moves("v0.10.1")).toBe(true);
  });

  it("leaves latest alone for an older final version", () => {
    expect(moves("v0.10.0")).toBe(false);
    expect(moves("v0.9.0")).toBe(false);
  });

  it("leaves latest alone for a pre-release, even the newest tag", () => {
    expect(moves("v0.11.0-rc.1")).toBe(false);
  });

  it("leaves latest alone for a pre-release that is the only tag", () => {
    expect(run(["moves-latest", "v1.0.0-rc.1"], { RELEASE_TAGS: "v1.0.0-rc.1" }).status).toBe(1);
  });

  it("leaves latest alone for a name that is not a version", () => {
    expect(moves("rehearsal-abc123")).toBe(false);
  });
});

describe("publish-image.sh", () => {
  // The script beside a stub signer, so the whole flow runs against the stub docker.
  let scripts = "";
  beforeAll((): void => {
    scripts = join(bin, "scripts");
    mkdirSync(scripts);
    for (const name of ["publish-image.sh", "image-tag-policy.sh"]) {
      copyFileSync(`${root}scripts/${name}`, join(scripts, name));
    }
    writeFileSync(join(scripts, "attest-and-sign.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(scripts, "attest-and-sign.sh"), 0o755);
  });

  const publishRun = (env: Record<string, string>): SpawnSyncReturns<string> =>
    spawnSync("sh", [join(scripts, "publish-image.sh"), "v1.2.3", "apps/api/Dockerfile=reg/api"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ...env }
    });
  const calls = (env: Record<string, string>): string => readFileSync(env["LOG"] ?? "", "utf8");

  it("refuses to rebuild a tag that exists, before it builds anything", () => {
    const env = registry("reg/api:v1.2.3");
    const result = publishRun(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reg/api:v1.2.3 already exists");
    expect(existsSync(env["LOG"] ?? "")).toBe(true);
    expect(calls(env)).not.toContain("buildx build");
  });

  it("refuses again when the tag appears between the build and the tagging", () => {
    const env = { ...registry(), APPEAR: "reg/api:v1.2.3" };
    const result = publishRun(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reg/api:v1.2.3 already exists");
    expect(calls(env)).toContain("buildx build");
    expect(calls(env)).not.toContain("imagetools create");
  });

  it("tags the version and latest when it is the highest final version", () => {
    const env = { ...registry(), RELEASE_TAGS: "v1.2.2\nv1.2.3" };
    expect(publishRun(env).status).toBe(0);
    expect(calls(env)).toContain("--tag reg/api:v1.2.3 --tag reg/api:latest");
  });

  it("tags only the version when a higher final version exists", () => {
    const env = { ...registry(), RELEASE_TAGS: "v1.2.3\nv1.3.0" };
    expect(publishRun(env).status).toBe(0);
    const create = calls(env)
      .split("\n")
      .find((line) => line.includes("imagetools create"));
    expect(create).toContain("--tag reg/api:v1.2.3");
    expect(create).not.toContain("latest");
  });

  it("lets the rehearsal re-run a tag that exists, moving latest on its throwaway registry", () => {
    const env = { ...registry("reg/api:v1.2.3"), DRY_RUN: "1", RELEASE_TAGS: "v1.3.0" };
    expect(publishRun(env).status).toBe(0);
    expect(calls(env)).toContain("--tag reg/api:v1.2.3 --tag reg/api:latest");
  });
});
