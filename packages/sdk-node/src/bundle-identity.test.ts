import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { bundleOptions } from "../scripts/bundle-options.mjs";
import { buildIdentity, type BuildIdentity, type Git } from "../scripts/build-identity.mjs";

/**
 * The SDK's version and commit, baked into the bundle when it is built
 * (F-046, ADR-063 decision 1). The commit comes from the first of:
 * `WAYSCRIBE_BUILD_COMMIT` then `CI_COMMIT_SHA`; `BUILD_COMMIT`, which
 * `git archive` fills through `export-subst`; `git rev-parse HEAD` when the
 * package sits in its own repository; or nothing.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

const SHA = "27f4d64a3b1c0e9f8d7c6b5a4f3e2d1c0b9a8f7e";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const UNSUBSTITUTED = "$Format:%H$\n";

/** A git that answers as a checkout of this repository would, at `head`. */
function gitAt(toplevel: string, head: string): Git {
  return (args) => {
    if (args.join(" ") === "rev-parse --show-toplevel") return `${toplevel}\n`;
    if (args.join(" ") === "rev-parse HEAD") return `${head}\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const noGit: Git = () => {
  throw new Error("spawn git ENOENT");
};

/** A package directory of its own, with a manifest and a BUILD_COMMIT. */
function fakePackage(root: string, version: unknown, buildCommit: string | undefined): string {
  const directory = join(root, "packages", "sdk-node");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "@wayscribe/node", version })
  );
  if (buildCommit !== undefined) writeFileSync(join(directory, "BUILD_COMMIT"), buildCommit);
  return directory;
}

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "wayscribe-identity-")));
}

describe("the version baked in", () => {
  it("is package.json's version", () => {
    expect(buildIdentity({ packageRoot, env: {}, git: noGit }).version).toBe(manifest.version);
  });

  it.each([
    ["empty", ""],
    ["over 64 characters", "1".repeat(65)],
    ["not a string", 1]
  ])("fails the build when it is %s", (_what, version) => {
    const root = scratch();
    try {
      const directory = fakePackage(root, version, undefined);
      expect(() => buildIdentity({ packageRoot: directory, env: {}, git: noGit })).toThrow(
        /version/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the commit baked in, in order", () => {
  function identity(
    env: Record<string, string | undefined>,
    file?: string,
    git: Git = noGit
  ): BuildIdentity {
    const root = scratch();
    try {
      const directory = fakePackage(root, "0.1.0", file);
      return buildIdentity({ packageRoot: directory, env, git });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("1. takes WAYSCRIBE_BUILD_COMMIT, then CI_COMMIT_SHA, before anything else", () => {
    const file = `${OTHER}\n`;
    expect(identity({ WAYSCRIBE_BUILD_COMMIT: "27f4d64", CI_COMMIT_SHA: SHA }, file).commit).toBe(
      "27f4d64"
    );
    expect(identity({ CI_COMMIT_SHA: SHA }, file).commit).toBe(SHA);
    // Empty is unset, as scripts/publish-image.sh reads it.
    expect(identity({ WAYSCRIBE_BUILD_COMMIT: "", CI_COMMIT_SHA: SHA }, file).commit).toBe(SHA);
  });

  it.each([
    ["a branch name", "main"],
    ["uppercase hex", "27F4D64"],
    ["six characters", "27f4d6"],
    ["65 characters", "a".repeat(65)],
    ["a commit with a newline", `${SHA}\n`],
    ["a commit with spaces", ` ${SHA}`]
  ])("fails the build when a set variable is %s", (_what, value) => {
    expect(() => identity({ WAYSCRIBE_BUILD_COMMIT: value })).toThrow(/WAYSCRIBE_BUILD_COMMIT/);
    expect(() => identity({ CI_COMMIT_SHA: value })).toThrow(/CI_COMMIT_SHA/);
  });

  it("accepts 7 to 64 lowercase hex characters from a variable", () => {
    expect(identity({ CI_COMMIT_SHA: "a".repeat(7) }).commit).toBe("a".repeat(7));
    expect(identity({ CI_COMMIT_SHA: "a".repeat(64) }).commit).toBe("a".repeat(64));
  });

  it("2. then takes BUILD_COMMIT when git archive filled it, before git", () => {
    expect(identity({}, `${SHA}\n`, gitAt("/elsewhere", OTHER)).commit).toBe(SHA);
  });

  it.each([
    ["unsubstituted", UNSUBSTITUTED],
    ["abbreviated", "27f4d64\n"],
    ["uppercase", `${SHA.toUpperCase()}\n`],
    ["empty", ""]
  ])("does not take BUILD_COMMIT when it is %s", (_what, file) => {
    expect(identity({}, file).commit).toBeUndefined();
  });

  it("3. then takes git's HEAD when git names this package's repository", () => {
    const root = scratch();
    try {
      const directory = fakePackage(root, "0.1.0", UNSUBSTITUTED);
      expect(buildIdentity({ packageRoot: directory, env: {}, git: gitAt(root, SHA) }).commit).toBe(
        SHA
      );
      // Inside another repository: that repository's HEAD names nothing here.
      expect(
        buildIdentity({ packageRoot: directory, env: {}, git: gitAt(join(root, ".."), SHA) }).commit
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("4. otherwise bakes in no commit", () => {
    expect(identity({}, undefined, noGit).commit).toBeUndefined();
    expect(identity({}, UNSUBSTITUTED, noGit).commit).toBeUndefined();
  });
});

/** Whether a real git is installed: CI's node:24-alpine image has none. */
const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit)("with a real git", () => {
  function commitAll(directory: string): string {
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null"
        }
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD").trim();
  }

  it("takes the HEAD of the repository the package is in", () => {
    const root = scratch();
    try {
      const directory = fakePackage(root, "0.1.0", UNSUBSTITUTED);
      const head = commitAll(root);
      expect(buildIdentity({ packageRoot: directory, env: {} }).commit).toBe(head);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not take the commit of a repository an extracted archive sits inside", () => {
    const root = scratch();
    try {
      // An archive extracted into a directory of another repository: its
      // BUILD_COMMIT unsubstituted, as a plain copy leaves it, and no .git.
      writeFileSync(join(root, "README"), "outer");
      const extracted = join(root, "vendor", "wayscribe");
      const directory = fakePackage(extracted, "0.1.0", UNSUBSTITUTED);
      commitAll(root);
      expect(buildIdentity({ packageRoot: directory, env: {} }).commit).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("from this repository, bakes in its HEAD", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    }).trim();
    expect(buildIdentity({ packageRoot, env: {} }).commit).toBe(head);
  });
});

describe("BUILD_COMMIT", () => {
  it("holds git's placeholder, or the commit git archive wrote into it", () => {
    const text = readFileSync(join(packageRoot, "BUILD_COMMIT"), "utf8");
    expect(text === UNSUBSTITUTED || /^[0-9a-f]{40}\n?$/.test(text), text).toBe(true);
  });

  it("is marked export-subst, so git archive fills it", () => {
    const attributes = readFileSync(join(repositoryRoot, ".gitattributes"), "utf8");
    expect(attributes.split("\n")).toContain("packages/sdk-node/BUILD_COMMIT export-subst");
  });
});

describe("the built bundle", () => {
  async function eventFrom(identity: BuildIdentity): Promise<Record<string, unknown> | undefined> {
    const directory = mkdtempSync(join(tmpdir(), "wayscribe-bundle-"));
    const outfile = join(directory, "index.mjs");
    const events: Record<string, unknown>[] = [];
    const server = createServer((incoming, response) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
        events.push(...parsed.events.map((entry) => entry.event));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: { results: parsed.events.map(() => ({ status: "accepted" })) } })
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      await build({ ...bundleOptions(identity), outfile, logLevel: "error" });
      const sdk = (await import(pathToFileURL(outfile).href)) as typeof import("./index.js");
      const recorder = sdk.createRecorder({
        apiKey: "wsk_test",
        serviceName: "svc",
        environment: "development",
        endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      });
      recorder
        .startJourney({ entity: { type: "customer", id: "1" } })
        .record({ operation: "received", name: "r" });
      await recorder.shutdown({ timeoutMs: 5_000 });
      return events[0];
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("carries the version and commit it was built with", async () => {
    const event = await eventFrom({ version: "9.8.7-test", commit: SHA });
    expect(event?.["runtime"]).toEqual({
      language: "node",
      version: process.versions.node,
      sdk: { name: "@wayscribe/node", version: "9.8.7-test", commit: SHA }
    });
  });

  it("leaves the commit out when none was found", async () => {
    const event = await eventFrom({ version: "9.8.7-test" });
    expect(event?.["runtime"]).toEqual({
      language: "node",
      version: process.versions.node,
      sdk: { name: "@wayscribe/node", version: "9.8.7-test" }
    });
  });

  it("is built with package.json's version by default, never the development one", () => {
    const { define } = bundleOptions();
    expect(Object.values(define)).toContain(JSON.stringify(manifest.version));
    expect(JSON.stringify(define)).not.toContain("0.0.0-development");
  });

  it("is not built at all with a malformed commit, and dist is left alone", () => {
    const result = spawnSync(process.execPath, [join(packageRoot, "scripts", "bundle.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, WAYSCRIBE_BUILD_COMMIT: "not-a-commit" },
      timeout: 60_000
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WAYSCRIBE_BUILD_COMMIT");
    // It failed in the identity step, before anything was built or removed.
    // Whether dist/ survives is not checked on disk: tests/sdk-pack.test.ts
    // rebuilds it in parallel. The order is checked in the script instead.
    expect(result.stdout).not.toContain("bundled");
    expect(result.stderr).toContain("build-identity.mjs");
    const script = readFileSync(join(packageRoot, "scripts", "bundle.mjs"), "utf8");
    expect(script.indexOf("buildIdentity({ packageRoot })")).toBeGreaterThan(0);
    expect(script.indexOf("buildIdentity({ packageRoot })")).toBeLessThan(
      script.indexOf("rmSync(dist")
    );
  });
});
