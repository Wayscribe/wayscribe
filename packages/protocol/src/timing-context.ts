/** The largest timing value presented from metadata: 2^31 - 1 milliseconds. */
const MAX_TIMING_MS = 2_147_483_647;
const MAX_CONTEXT_TEXT = 256;

export type QueueWaitBasis = "initial-enqueue" | "retry-ready";

/**
 * The bounded, independently validated timing vocabulary projected from an
 * event's already-redacted metadata.
 */
export interface TimingContext {
  queue?: string;
  queueWaitMs?: number;
  queueWaitBasis?: QueueWaitBasis;
  deliveryCount?: number;
  targetHost?: string;
  httpStatusCode?: number;
  retryAfterMs?: number;
  attempt?: number;
  retryGroup?: string;
}

const EXACT_MARKERS = new Set([
  "[REDACTED]",
  "[UNCAPTURABLE]",
  "[PAYLOAD_TOO_LARGE]",
  "[CIRCULAR]"
]);
const TRUNCATION_MARKER = /\[TRUNCATED: [0-9]+ characters removed\]$/;
const INVALID_AUTHORITY_DELIMITER = /[/?#@\\]/u;

/**
 * Interpret the known timing keys without changing metadata wire acceptance.
 * An unusable field is omitted by itself; unknown metadata remains available
 * to readers through the raw event detail.
 */
export function timingContext(metadata: unknown): TimingContext {
  if (!isRecord(metadata)) return {};

  const result: TimingContext = {};
  const queue = boundedIdentity(readOwn(metadata, "queue"));
  if (queue !== undefined) result.queue = queue;

  const deliveryCount = positiveSafeInteger(readOwn(metadata, "deliveryCount"));
  if (deliveryCount !== undefined) result.deliveryCount = deliveryCount;

  const targetHost = boundedTargetHost(readOwn(metadata, "targetHost"));
  if (targetHost !== undefined) result.targetHost = targetHost;

  const httpStatusCode = integerIn(readOwn(metadata, "httpStatusCode"), 100, 599);
  if (httpStatusCode !== undefined) result.httpStatusCode = httpStatusCode;

  const retryAfterMs = integerIn(readOwn(metadata, "retryAfterMs"), 0, MAX_TIMING_MS);
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;

  const attempt = positiveSafeInteger(readOwn(metadata, "attempt"));
  if (attempt !== undefined) result.attempt = attempt;

  const retryGroup = boundedIdentity(readOwn(metadata, "retryGroup"));
  if (retryGroup !== undefined) result.retryGroup = retryGroup;

  const queueWaitMs = integerIn(readOwn(metadata, "queueWaitMs"), 0, MAX_TIMING_MS);
  const queueWaitBasis = waitBasis(readOwn(metadata, "queueWaitBasis"));
  if (
    queueWaitMs !== undefined &&
    ((queueWaitBasis === "initial-enqueue" && attempt === 1) ||
      (queueWaitBasis === "retry-ready" && attempt !== undefined && attempt > 1))
  ) {
    result.queueWaitMs = queueWaitMs;
    result.queueWaitBasis = queueWaitBasis;
  }

  return result;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stored JSON metadata owns its fields; prototype values are not event evidence. */
function readOwn(source: object, key: string): unknown {
  try {
    if (!Object.hasOwn(source, key)) return undefined;
    return Reflect.get(source, key);
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

function waitBasis(value: unknown): QueueWaitBasis | undefined {
  return value === "initial-enqueue" || value === "retry-ready" ? value : undefined;
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    fitsCodePoints(value, MAX_CONTEXT_TEXT) &&
    !isMarker(value)
    ? value
    : undefined;
}

function boundedTargetHost(value: unknown): string | undefined {
  const host = boundedIdentity(value);
  if (
    host === undefined ||
    host.trim() !== host ||
    INVALID_AUTHORITY_DELIMITER.test(host) ||
    hasAsciiControlOrSpace(host) ||
    !hasValidPortShape(host)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.host !== "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? host
      : undefined;
  } catch {
    return undefined;
  }
}

function hasAsciiControlOrSpace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

function hasValidPortShape(host: string): boolean {
  if (host.startsWith("[")) {
    const bracket = host.indexOf("]");
    if (bracket <= 1) return false;
    const remainder = host.slice(bracket + 1);
    return remainder === "" || /^:[0-9]+$/.test(remainder);
  }

  const colon = host.indexOf(":");
  return colon === -1 || (colon === host.lastIndexOf(":") && /^:[0-9]+$/.test(host.slice(colon)));
}

function isMarker(value: string): boolean {
  return EXACT_MARKERS.has(value) || TRUNCATION_MARKER.test(value);
}

function fitsCodePoints(value: string, maximum: number): boolean {
  if (value.length <= maximum) return true;
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}
