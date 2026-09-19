import packageJson from "../../package.json";

/**
 * What a Wayscribe process is running, in the shape the API's `/ready` answers
 * with (docs/API_SPEC.md section 14).
 *
 * `source` is `build` when the published image baked the values in, so they
 * are a fact about the artefact, and `package` when nothing was baked in: a
 * source run or a hand-built image, whose version is only the workspace's own.
 */
export interface RunningVersion {
  version: string;
  /** The commit the image was built from, when the build recorded one. */
  commit?: string;
  source: "build" | "package";
}

/**
 * The web app's own version, from the same build arguments as the API's:
 * `WAYSCRIBE_BUILD_VERSION` and `WAYSCRIBE_BUILD_COMMIT`, which
 * `apps/web/Dockerfile` bakes in and `scripts/publish-image.sh` fills. Read
 * from the environment at request time, never at build time: only
 * `NEXT_PUBLIC_` variables are inlined into the bundle. An ARG with no value
 * bakes an empty string, so empty is read as absent.
 */
export function resolveWebVersion(env: Record<string, string | undefined>): RunningVersion {
  const version = env["WAYSCRIBE_BUILD_VERSION"] ?? "";
  if (version === "") return { version: packageJson.version, source: "package" };
  const commit = env["WAYSCRIBE_BUILD_COMMIT"] ?? "";
  return { version, ...(commit === "" ? {} : { commit }), source: "build" };
}

/**
 * The longest version and commit shown. A release tag and a full SHA-256
 * object name both fit. Whatever answers at API_URL is shown on every page, so
 * a longer value is refused rather than printed.
 */
const MAX_VERSION_LENGTH = 64;
const MAX_COMMIT_LENGTH = 64;

/** The running version in a `/ready` body, or null when it does not say. */
export function parseReady(body: unknown): RunningVersion | null {
  if (typeof body !== "object" || body === null) return null;
  const { version, commit, source } = body as Record<string, unknown>;
  if (typeof version !== "string" || version === "" || version.length > MAX_VERSION_LENGTH) {
    return null;
  }
  if (source !== "build" && source !== "package") return null;
  const keepCommit =
    typeof commit === "string" && commit !== "" && commit.length <= MAX_COMMIT_LENGTH;
  return { version, ...(keepCommit ? { commit } : {}), source };
}

/** Long enough for an API on the same network; short enough not to hold a page. */
const READY_TIMEOUT_MS = 1_500;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What the API says it is running, from `GET /ready`, or null when it cannot
 * say. Never throws: the version line is a courtesy on every page and must
 * not be the reason one fails to render.
 *
 * Unauthenticated, as `/ready` is: the admin token is not sent anywhere it is
 * not needed. A 503 still carries the version, so its body is read too.
 */
export async function readApiVersion(
  apiUrl: string,
  fetcher: Fetcher = fetch,
  timeoutMs: number = READY_TIMEOUT_MS
): Promise<RunningVersion | null> {
  try {
    const response = await fetcher(`${apiUrl}/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return parseReady(await response.json());
  } catch {
    return null;
  }
}

/**
 * `read`, asked at most once per `periodMs`. The version line is on every
 * page and `/ready` checks the database, so the answer is reused for a short
 * while; a partial upgrade shows within one period.
 */
export function cachedFor<T>(
  periodMs: number,
  read: () => Promise<T>,
  now: () => number = Date.now
): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null;
  return () => {
    const time = now();
    if (cached === null || time - cached.at >= periodMs) {
      cached = { at: time, value: read() };
    }
    return cached.value;
  };
}

const SHORT_COMMIT = 12;

function describe(name: string, running: RunningVersion): string {
  if (running.source === "package") return `${name} ${running.version}, not a release build`;
  return running.commit === undefined
    ? `${name} ${running.version}`
    : `${name} ${running.version}, commit ${running.commit.slice(0, SHORT_COMMIT)}`;
}

/**
 * The version line's two halves, and whether they name different builds: a
 * different version, or the same version from a different commit when both
 * recorded one. That is what a partial upgrade looks like (F-045).
 *
 * Only two build identities can be compared. A side with `source: "package"`
 * was built without `WAYSCRIBE_BUILD_VERSION`, so its version is the
 * workspace's own, `0.0.0`, whatever commit it came from, and it would differ
 * from any release: a hand-built web image beside its own API was called a
 * different build on every page (F-051). When exactly one side has no
 * identity, `unverified` names it and `mismatch` is false, because the page
 * cannot know. When neither has one, as in a run from a checkout, both halves
 * already say "not a release build" and there is nothing to compare.
 */
export function describeVersions(
  web: RunningVersion,
  api: RunningVersion | null
): { web: string; api: string; mismatch: boolean; unverified: "web" | "api" | null } {
  if (api === null) {
    return {
      web: describe("Web", web),
      api: "API version unknown",
      mismatch: false,
      unverified: null
    };
  }
  const halves = { web: describe("Web", web), api: describe("API", api) };
  if (web.source === "package" || api.source === "package") {
    const unverified = web.source === api.source ? null : web.source === "package" ? "web" : "api";
    return { ...halves, mismatch: false, unverified };
  }
  const mismatch =
    web.version !== api.version ||
    (web.commit !== undefined && api.commit !== undefined && web.commit !== api.commit);
  return { ...halves, mismatch, unverified: null };
}
