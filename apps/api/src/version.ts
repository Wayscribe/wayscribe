import { readFileSync } from "node:fs";

/**
 * What this process is running, as `/ready` reports it.
 *
 * `source` is the honest part. `build` means the image was built with the
 * release it was tagged as and the answer can be trusted as a fact about the
 * artefact; `package` means nothing was baked in, so this is a source run or a
 * hand-built image and the number is only the workspace's own, which is 0.0.0.
 */
export interface RunningVersion {
  version: string;
  /** The commit the image was built from, when the build recorded one. */
  commit?: string;
  source: "build" | "package";
}

/**
 * Baked into the image by `apps/api/Dockerfile` from build arguments that
 * `scripts/publish-image.sh` fills with the release tag and the commit.
 *
 * Deliberately not a runtime shell-out to git: the image carries no git
 * history, no git binary and no working tree, so a shell-out could only ever
 * answer for the machine that happened to run the container. A value fixed
 * when the artefact was built is a fact about the artefact.
 *
 * An ARG with no value bakes an empty string, so empty is read as absent.
 */
const VERSION_VARIABLE = "WAYSCRIBE_BUILD_VERSION";
const COMMIT_VARIABLE = "WAYSCRIBE_BUILD_COMMIT";

/**
 * The version in `apps/api/package.json`.
 *
 * `../package.json` resolves to it from `src/version.ts` and from
 * `dist/version.js` alike, because the build keeps one directory level either
 * way (`rootDir: src`, `outDir: dist`), so the test and the running server read
 * the same file. Unreadable is not a reason to fail a readiness check, so it
 * answers "unknown" instead of throwing.
 */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveRunningVersion(env: Record<string, string | undefined>): RunningVersion {
  const version = env[VERSION_VARIABLE];
  if (version === undefined || version === "") {
    return { version: packageVersion(), source: "package" };
  }
  const commit = env[COMMIT_VARIABLE];
  return {
    version,
    ...(commit === undefined || commit === "" ? {} : { commit }),
    source: "build"
  };
}

let resolved: RunningVersion | undefined;

/** Resolved once: it cannot change while the process runs. */
export function runningVersion(): RunningVersion {
  resolved ??= resolveRunningVersion(process.env);
  return resolved;
}
