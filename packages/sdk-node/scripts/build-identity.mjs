import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The SDK's version and commit, as the bundle bakes them into every event's
 * `runtime.sdk` (F-046, ADR-063 decision 1).
 *
 * The version is `package.json`'s. The commit is the first of these that gives
 * a value:
 *
 * 1. `WAYSCRIBE_BUILD_COMMIT`, then `CI_COMMIT_SHA`, the variables
 *    `scripts/publish-image.sh` reads. Empty is unset, as it is there. A value
 *    that is set and is not 7 to 64 lowercase hex characters fails the build,
 *    rather than baking in something that names no commit.
 * 2. `BUILD_COMMIT` beside `package.json`, which holds `$Format:%H$` and is
 *    marked `export-subst` in `.gitattributes`, so `git archive` (Leadline's
 *    `pin-sdk.sh`, a GitLab source download) writes the commit into it. Used
 *    when it holds 40 lowercase hex characters, which it does only in an
 *    archive.
 * 3. `git rev-parse HEAD`, only when `git rev-parse --show-toplevel`, run in
 *    the package directory, names the repository root that contains the
 *    package: an extracted archive that sits inside another repository must
 *    not take that repository's commit.
 * 4. None: events carry no `commit`.
 *
 * Nothing here is read by the SDK at run time. The values are constants of the
 * build, so nothing in the host's environment or settings can change them.
 */

/** The variables step 1 reads, in order. */
export const COMMIT_VARIABLES = ["WAYSCRIBE_BUILD_COMMIT", "CI_COMMIT_SHA"];

const VARIABLE_COMMIT = /^[0-9a-f]{7,64}$/;
const ARCHIVE_COMMIT = /^[0-9a-f]{40}$/;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_VERSION_LENGTH = 64;

const defaultPackageRoot = fileURLToPath(new URL("..", import.meta.url));

/** Runs git in `cwd` and returns its standard output. Throws when git fails or is absent. */
function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000
  });
}

export function buildIdentity({
  packageRoot = defaultPackageRoot,
  env = process.env,
  git = runGit
} = {}) {
  const version = readVersion(packageRoot);
  const commit = fromVariables(env) ?? fromArchive(packageRoot) ?? fromGit(packageRoot, git);
  return commit === undefined ? { version } : { version, commit };
}

function readVersion(packageRoot) {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (typeof version !== "string" || version === "" || version.length > MAX_VERSION_LENGTH) {
    throw new Error(
      `package.json's version must be a string of 1 to ${String(MAX_VERSION_LENGTH)} characters, the limit on runtime.sdk.version.`
    );
  }
  return version;
}

function fromVariables(env) {
  for (const name of COMMIT_VARIABLES) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (!VARIABLE_COMMIT.test(value)) {
      // The value is not printed: a variable set by mistake can hold anything.
      throw new Error(
        `${name} is set and is not a commit: 7 to 64 lowercase hex characters. Unset it or fix it; the SDK is not built with a commit that names nothing.`
      );
    }
    return value;
  }
  return undefined;
}

function fromArchive(packageRoot) {
  let text;
  try {
    text = readFileSync(join(packageRoot, "BUILD_COMMIT"), "utf8");
  } catch {
    return undefined;
  }
  const commit = text.trim();
  return ARCHIVE_COMMIT.test(commit) ? commit : undefined;
}

function fromGit(packageRoot, git) {
  try {
    const toplevel = git(["rev-parse", "--show-toplevel"], packageRoot).trim();
    // The repository root this package belongs to is two levels up:
    // <root>/packages/sdk-node. Compared after resolving links, as git does.
    if (realpathSync(toplevel) !== realpathSync(resolve(packageRoot, "..", ".."))) return undefined;
    const head = git(["rev-parse", "HEAD"], packageRoot).trim();
    return GIT_COMMIT.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}
