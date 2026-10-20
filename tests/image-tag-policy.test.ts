import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const publish = `${root}scripts/publish-image.sh`;

let bin = "";
beforeAll((): void => {
  bin = mkdtempSync(join(tmpdir(), "policy-"));
  const docker = join(bin, "docker");
  // `docker buildx imagetools inspect <ref>` succeeds for the references in EXISTING.
  writeFileSync(
    docker,
    '#!/bin/sh\nref="$4"\nfor known in $EXISTING; do [ "$known" = "$ref" ] && exit 0; done\nexit 1\n'
  );
  chmodSync(docker, 0o755);
});
afterAll((): void => {
  rmSync(bin, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("sh", [policy, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ...env }
  });
}

describe("image-tag-policy.sh free", () => {
  it("refuses a tag the registry already holds, saying so", () => {
    const result = run(["free", "reg/api", "v1.2.3"], { EXISTING: "reg/api:v1.2.3" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reg/api:v1.2.3 already exists");
  });

  it("accepts a tag the registry does not hold", () => {
    expect(run(["free", "reg/api", "v1.2.4"], { EXISTING: "reg/api:v1.2.3" }).status).toBe(0);
  });
});

describe("image-tag-policy.sh moves-latest", () => {
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

  it("leaves latest alone for a name that is not a version", () => {
    expect(moves("rehearsal-abc123")).toBe(false);
  });
});

describe("publish-image.sh", () => {
  const publishRun = (env: Record<string, string>): SpawnSyncReturns<string> =>
    spawnSync("sh", [publish, "v1.2.3", "apps/api/Dockerfile=reg/api"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, ...env }
    });

  it("refuses to rebuild a tag that exists, before it builds anything", () => {
    const log = join(bin, "calls.log");
    rmSync(log, { force: true });
    const result = publishRun({ EXISTING: "reg/api:v1.2.3", DOCKER_LOG: log });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reg/api:v1.2.3 already exists");
    expect(result.stdout + result.stderr).not.toContain("Pushed");
  });

  it("asks the policy again before tagging, and for :latest", () => {
    const text = readFileSync(publish, "utf8");
    expect(text).toMatch(/image-tag-policy\.sh" free[\s\S]*docker buildx build/);
    expect(text).toMatch(/imagetools create[\s\S]*moves-latest/);
    expect(text).toContain('"$HERE/image-tag-policy.sh" moves-latest');
  });

  it("keeps the rehearsal free to re-run on a throwaway registry", () => {
    expect(readFileSync(publish, "utf8")).toContain('[ "${DRY_RUN:-}" != 1 ]');
  });
});
