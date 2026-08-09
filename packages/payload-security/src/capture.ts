import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { defineKey, redact } from "./redact.js";

export type CaptureMode =
  "metadata-only" | "allowlisted-fields" | "redacted-payload" | "full-payload";

export interface CapturePolicy {
  mode: CaptureMode;
  redactionPaths?: readonly string[];
  allowlist?: readonly string[];
  /**
   * From ALLOW_FULL_PAYLOAD_CAPTURE. Defaults to false.
   *
   * `full-payload` stores payloads with only the built-in secret paths removed,
   * so an operator has to opt in at the process level before any environment
   * can select it. Without this the setting is inert, which is worse than
   * absent: it reads as a control and is not one.
   */
  allowFullPayload?: boolean;
}

/**
 * Apply an environment's capture policy to a payload.
 *
 * Server policy may capture less than the SDK requested; it never captures more.
 * Built-in secret paths are appended to whatever the operator configured, and
 * apply in every mode that stores a payload at all.
 */
export function applyCapture(payload: unknown, policy: CapturePolicy): unknown {
  if (payload === undefined) return undefined;
  if (policy.mode === "metadata-only") return undefined;

  if (policy.mode === "allowlisted-fields") {
    return pickAllowlisted(payload, policy.allowlist ?? []);
  }

  // An environment set to full-payload on an installation that has not allowed
  // it degrades to redacted-payload rather than failing. Refusing the event
  // would lose data to protect data.
  const paths =
    policy.mode === "full-payload" && policy.allowFullPayload === true
      ? DEFAULT_SECRET_PATHS
      : [...(policy.redactionPaths ?? []), ...DEFAULT_SECRET_PATHS];

  return redact(payload, paths);
}

function pickAllowlisted(payload: unknown, allowlist: readonly string[]): unknown {
  if (typeof payload !== "object" || payload === null) return {};

  const result: Record<string, unknown> = {};
  for (const path of allowlist) {
    const segments = path.split(".");
    const value = readPath(payload, segments);
    if (value !== undefined) writePath(result, segments, value);
  }

  // Built-in secrets still apply: an operator can allowlist a path that happens
  // to hold a token, and an allowlist must not override secret filtering.
  return redact(result, DEFAULT_SECRET_PATHS);
}

function readPath(source: unknown, segments: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown
): void {
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? "";
    const existing = current[segment];
    if (typeof existing !== "object" || existing === null) defineKey(current, segment, {});
    current = current[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] ?? "";
  defineKey(current, last, value);
}

/**
 * Redaction that applies whatever the capture mode is.
 *
 * {@link applyCapture} answers "how much of the business payload may we store",
 * and for `metadata-only` the answer is none. The fields this covers are not
 * business payloads — SECURITY.md section 3 keeps identifiers and operation
 * metadata in that mode — so they have to survive the mode and still lose their
 * secrets.
 *
 * `applyCapture` ran on `input` and `output` and on nothing else, so `metadata`
 * reached jsonb verbatim. The Node SDK redacts it before sending, but ingestion
 * is public HTTP and a client that is not the SDK runs none of that.
 *
 * For `error`, `runtime` and `deployment` this is defence against the schema
 * growing rather than a fix for today: their keys are fixed (`message`, `code`,
 * `hostname` …) so no path rule matches one. It also cannot reach a secret
 * pasted *inside* `error.message` or `error.stack`, because those are free text
 * and path redaction matches names. SECURITY.md is explicit that stack traces
 * carry credentials; treat that as unsolved rather than covered.
 */
export function redactAlways(value: unknown, policy: CapturePolicy): unknown {
  if (value === undefined) return undefined;
  return redact(value, [...(policy.redactionPaths ?? []), ...DEFAULT_SECRET_PATHS]);
}
