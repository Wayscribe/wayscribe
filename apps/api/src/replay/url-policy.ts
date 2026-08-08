import { isIP } from "node:net";

export type PolicyFailure =
  "invalid_base_url" | "invalid_scheme" | "invalid_path" | "host_not_allowed";

export type PolicyResult =
  { ok: true; url: URL; host: string } | { ok: false; reason: PolicyFailure; message: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Build and validate the URL a replay will be sent to.
 *
 * The destination supplies an origin and the request supplies a path (ADR-019).
 * Keeping those separate is what makes the allowlist meaningful: a caller who
 * could supply a whole URL could name any host regardless of the destination.
 */
export function resolveReplayUrl(
  baseUrl: string,
  path: string,
  allowedHosts: readonly string[]
): PolicyResult {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return fail("invalid_base_url", `Destination base URL is not a URL: ${baseUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(base.protocol)) {
    return fail("invalid_scheme", `Only http and https are allowed, not ${base.protocol}`);
  }

  const pathCheck = checkPath(path);
  if (pathCheck !== undefined) return pathCheck;

  // Resolved against the origin alone, so a base URL carrying its own path
  // cannot be escaped by a path that starts with a slash.
  const url = new URL(base.origin);
  url.pathname = path.startsWith("/") ? path : `/${path}`;

  // Re-checked after construction: a path can carry a query or fragment, and
  // neither may change the origin.
  if (url.origin !== base.origin) {
    return fail("invalid_path", "The path changed the destination origin.");
  }

  const host = normaliseHost(url.hostname);
  if (!allowedHosts.some((allowed) => normaliseHost(allowed) === host)) {
    return fail(
      "host_not_allowed",
      `Host ${host} is not in REPLAY_ALLOWED_HOSTS. Add it there to replay to it.`
    );
  }

  return { ok: true, url, host };
}

/**
 * Reject anything that is not a plain path.
 *
 * An absolute URL, a protocol-relative URL, a backslash (which some parsers
 * treat as a separator), and `..` traversal each let a caller reach an origin
 * the destination did not name.
 */
function checkPath(path: string): PolicyResult | undefined {
  if (path.includes("\\")) {
    return fail("invalid_path", "A path may not contain a backslash.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return fail("invalid_path", "A path may not be an absolute URL.");
  }
  if (path.startsWith("//")) {
    return fail("invalid_path", "A path may not be protocol-relative.");
  }
  // Decoded first: `%2e%2e%2f` is `../` to a server that decodes before routing.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return fail("invalid_path", "The path is not valid percent-encoding.");
  }
  if (decoded.split(/[/\\]/).includes("..")) {
    return fail("invalid_path", "A path may not traverse upward.");
  }
  return undefined;
}

/**
 * Normalise a host for comparison.
 *
 * Lowercased, brackets stripped from IPv6 literals, and IPv4-mapped IPv6
 * collapsed to its IPv4 form — so `::ffff:127.0.0.1` cannot slip past a rule
 * written for `127.0.0.1`.
 */
export function normaliseHost(host: string): string {
  const lowered = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lowered);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
  return lowered;
}

function fail(reason: PolicyFailure, message: string): PolicyResult {
  return { ok: false, reason, message };
}
