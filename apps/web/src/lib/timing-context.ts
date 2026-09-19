import type { TimingContext } from "./api";

const MAX_TIMING_MS = 2_147_483_647;
const MAX_CONTEXT_TEXT = 256;
const MARKERS = new Set(["[REDACTED]", "[UNCAPTURABLE]", "[PAYLOAD_TOO_LARGE]", "[CIRCULAR]"]);
const TRUNCATION_MARKER = /\[TRUNCATED: [0-9]+ characters removed\]$/;
const INVALID_AUTHORITY_DELIMITER = /[/?#@\\]/u;

/**
 * The web deliberately has no workspace runtime dependencies. This mirrors
 * the additive public read contract and validates each field independently,
 * so an older or malformed API response cannot turn unknown evidence into 0.
 */
export function readTimingContext(value: unknown): TimingContext {
  if (!isRecord(value)) return {};
  const result: TimingContext = {};
  const attempt = positiveSafeInteger(own(value, "attempt"));
  const queue = identity(own(value, "queue"));
  const deliveryCount = positiveSafeInteger(own(value, "deliveryCount"));
  const targetHost = host(own(value, "targetHost"));
  const httpStatusCode = integerIn(own(value, "httpStatusCode"), 100, 599);
  const retryAfterMs = integerIn(own(value, "retryAfterMs"), 0, MAX_TIMING_MS);
  const retryGroup = identity(own(value, "retryGroup"));
  if (queue !== undefined) result.queue = queue;
  if (deliveryCount !== undefined) result.deliveryCount = deliveryCount;
  if (targetHost !== undefined) result.targetHost = targetHost;
  if (httpStatusCode !== undefined) result.httpStatusCode = httpStatusCode;
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  if (attempt !== undefined) result.attempt = attempt;
  if (retryGroup !== undefined) result.retryGroup = retryGroup;

  const wait = integerIn(own(value, "queueWaitMs"), 0, MAX_TIMING_MS);
  const basis = own(value, "queueWaitBasis");
  if (
    wait !== undefined &&
    ((basis === "initial-enqueue" &&
      attempt === 1 &&
      (deliveryCount === undefined || deliveryCount === 1)) ||
      (basis === "retry-ready" && attempt !== undefined && attempt > 1))
  ) {
    result.queueWaitMs = wait;
    result.queueWaitBasis = basis;
  }
  return result;
}

/** A bounded explicit host, or null when the API is old or the value is unusable. */
export function readRecordedHost(value: unknown): string | null {
  return identity(value) ?? null;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(source: object, key: string): unknown {
  try {
    return Object.hasOwn(source, key) ? Reflect.get(source, key) : undefined;
  } catch {
    return undefined;
  }
}

function integerIn(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    fitsCodePoints(value, MAX_CONTEXT_TEXT) &&
    !MARKERS.has(value) &&
    !TRUNCATION_MARKER.test(value)
    ? value
    : undefined;
}

function host(value: unknown): string | undefined {
  const candidate = identity(value);
  if (
    candidate === undefined ||
    candidate.trim() !== candidate ||
    INVALID_AUTHORITY_DELIMITER.test(candidate) ||
    hasControlOrSpace(candidate) ||
    !validPort(candidate)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${candidate}`);
    return parsed.host !== "" && parsed.pathname === "/" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function hasControlOrSpace(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x20 || point === 0x7f)) return true;
  }
  return false;
}

function validPort(value: string): boolean {
  if (value.startsWith("[")) {
    const bracket = value.indexOf("]");
    if (bracket <= 1) return false;
    const rest = value.slice(bracket + 1);
    return rest === "" || /^:[0-9]+$/.test(rest);
  }
  const colon = value.indexOf(":");
  return colon === -1 || (colon === value.lastIndexOf(":") && /^:[0-9]+$/.test(value.slice(colon)));
}

function fitsCodePoints(value: string, maximum: number): boolean {
  if (value.length <= maximum) return true;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}
