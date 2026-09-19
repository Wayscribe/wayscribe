import { fitsCodePoints } from "./code-points.js";

const MAX_TIMING_MS = 2_147_483_647;
const MAX_CONTEXT_TEXT = 256;

/** The BullMQ-shaped job fields used by {@link queueMetadata}. */
export interface QueueMetadataJob {
  readonly queueName?: string | undefined;
  readonly id?: string | undefined;
  /** When the job was initially enqueued, in epoch milliseconds. */
  readonly timestamp?: number | undefined;
  /** When the current attempt began, in epoch milliseconds. */
  readonly processedOn?: number | undefined;
  /** Attempts already completed; the current attempt is one more. */
  readonly attemptsMade?: number | undefined;
}

export interface QueueMetadataOptions {
  /** When a retry became ready for this attempt, in epoch milliseconds. */
  readonly readyAgainAt?: number | undefined;
  /** A delivery count explicitly reported by the broker or caller. */
  readonly deliveryCount?: number | undefined;
}

/** Metadata produced by {@link queueMetadata}, ready for `record` or a wrapper. */
export interface QueueTimingMetadata {
  [key: string]: unknown;
  queue?: string;
  queueWaitMs?: number;
  queueWaitBasis?: "initial-enqueue" | "retry-ready";
  deliveryCount?: number;
  attempt?: number;
  retryGroup?: string;
}

/** A response shaped like the parts of fetch `Response` that {@link httpMetadata} reads. */
export interface HttpMetadataResponse {
  readonly status?: number | undefined;
  readonly headers?:
    | {
        get(name: string): string | null | undefined;
      }
    | undefined;
}

export interface HttpMetadataOptions {
  /** The absolute HTTP(S) URL requested. Only its host is recorded. */
  readonly targetUrl?: string | undefined;
  /** Observation time for an HTTP-date `Retry-After`, in epoch milliseconds. */
  readonly now?: number | undefined;
}

/** Metadata produced by {@link httpMetadata}, ready for `metadataFrom`. */
export interface HttpTimingMetadata {
  [key: string]: unknown;
  targetHost?: string;
  httpStatusCode?: number;
  retryAfterMs?: number;
}

/**
 * Build bounded queue timing metadata without taking a broker dependency.
 * Every field is read and validated independently; no clock falls back to now.
 */
export function queueMetadata(
  job: QueueMetadataJob,
  options?: QueueMetadataOptions
): QueueTimingMetadata {
  const metadata: QueueTimingMetadata = {};

  const queue = boundedIdentity(read(job, "queueName"));
  if (queue !== undefined) metadata.queue = queue;

  const deliveryCount = positiveSafeInteger(read(options, "deliveryCount"));
  if (deliveryCount !== undefined) metadata.deliveryCount = deliveryCount;

  const attemptsMade = nonnegativeCompletedAttempts(read(job, "attemptsMade"));
  const attempt = attemptsMade === undefined ? undefined : attemptsMade + 1;
  if (attempt !== undefined) metadata.attempt = attempt;

  const id = boundedIdentity(read(job, "id"));
  if (queue !== undefined && id !== undefined) {
    const retryGroup = `queue:${JSON.stringify([queue, id])}`;
    if (fitsCodePoints(retryGroup, MAX_CONTEXT_TEXT)) metadata.retryGroup = retryGroup;
  }

  const processedOn = epochMilliseconds(read(job, "processedOn"));
  if (attempt === 1) {
    const enqueuedAt = epochMilliseconds(read(job, "timestamp"));
    const wait = elapsedMilliseconds(processedOn, enqueuedAt);
    if (wait !== undefined) {
      metadata.queueWaitMs = wait;
      metadata.queueWaitBasis = "initial-enqueue";
    }
  } else if (attempt !== undefined && attempt > 1) {
    const readyAgainAt = epochMilliseconds(read(options, "readyAgainAt"));
    const wait = elapsedMilliseconds(processedOn, readyAgainAt);
    if (wait !== undefined) {
      metadata.queueWaitMs = wait;
      metadata.queueWaitBasis = "retry-ready";
    }
  }

  return metadata;
}

/**
 * Build bounded response timing metadata. Getter, proxy, URL and header
 * failures cost only the field they prevent this helper from reading.
 */
export function httpMetadata(
  response: HttpMetadataResponse,
  options?: HttpMetadataOptions
): HttpTimingMetadata {
  const metadata: HttpTimingMetadata = {};

  const targetHost = hostFromUrl(read(options, "targetUrl"));
  if (targetHost !== undefined) metadata.targetHost = targetHost;

  const status = integerIn(read(response, "status"), 100, 599);
  if (status !== undefined) metadata.httpStatusCode = status;

  const retryAfter = retryAfterValue(response);
  if (retryAfter !== undefined) {
    const retryAfterMs = parseRetryAfter(retryAfter, read(options, "now"));
    if (retryAfterMs !== undefined) metadata.retryAfterMs = retryAfterMs;
  }

  return metadata;
}

/** Reads inherited broker/Headers APIs too, but isolates each property access. */
function read(source: unknown, key: string): unknown {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) {
    return undefined;
  }
  try {
    return Reflect.get(source, key);
  } catch {
    return undefined;
  }
}

function retryAfterValue(response: HttpMetadataResponse): unknown {
  const headers = read(response, "headers");
  const get = read(headers, "get");
  if (typeof get !== "function") return undefined;
  try {
    return Reflect.apply(get, headers, ["retry-after"]);
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: unknown, suppliedNow: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return integerIn(seconds * 1_000, 0, MAX_TIMING_MS);
  }

  const requestedAt = Date.parse(text);
  if (!Number.isFinite(requestedAt)) return undefined;
  const now = suppliedNow === undefined ? Date.now() : epochMilliseconds(suppliedNow);
  return elapsedMilliseconds(requestedAt, now);
}

function hostFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") {
      return undefined;
    }
    return boundedIdentity(parsed.host);
  } catch {
    return undefined;
  }
}

function elapsedMilliseconds(
  later: number | undefined,
  earlier: number | undefined
): number | undefined {
  if (later === undefined || earlier === undefined) return undefined;
  return integerIn(later - earlier, 0, MAX_TIMING_MS);
}

function epochMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonnegativeCompletedAttempts(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function integerIn(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    fitsCodePoints(value, MAX_CONTEXT_TEXT) &&
    !isMarker(value)
    ? value
    : undefined;
}

function isMarker(value: string): boolean {
  return (
    value === "[REDACTED]" ||
    value === "[UNCAPTURABLE]" ||
    value === "[PAYLOAD_TOO_LARGE]" ||
    value === "[CIRCULAR]" ||
    /^\[TRUNCATED: [0-9]+ characters removed\]$/.test(value)
  );
}
