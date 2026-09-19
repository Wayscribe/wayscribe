import { fitsCodePoints } from "./code-points.js";

const MAX_TIMING_MS = 2_147_483_647;
const MAX_CONTEXT_TEXT = 256;
const SHORT_WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];
const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
const IMF_FIXDATE =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const RFC850_DATE =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const ASCTIME_DATE =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{2}| [0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;

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
  if (attempt === 1 && (deliveryCount === undefined || deliveryCount === 1)) {
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
    const retryAfterMs = parseRetryAfter(retryAfter, options);
    if (retryAfterMs !== undefined) metadata.retryAfterMs = retryAfterMs;
  }

  return metadata;
}

/** Reads inherited broker/Headers APIs too, but isolates each property access. */
function read(source: unknown, key: string): unknown {
  const result = readField(source, key);
  return result.ok ? result.value : undefined;
}

type FieldRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function readField(source: unknown, key: string): FieldRead {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: Reflect.get(source, key) };
  } catch {
    return { ok: false };
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

function parseRetryAfter(
  value: unknown,
  options: HttpMetadataOptions | undefined
): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return integerIn(seconds * 1_000, 0, MAX_TIMING_MS);
  }

  const suppliedNow = readField(options, "now");
  if (!suppliedNow.ok) return undefined;
  const now = suppliedNow.value === undefined ? Date.now() : epochMilliseconds(suppliedNow.value);
  if (now === undefined) return undefined;
  const requestedAt = parseHttpDate(text, now);
  return elapsedMilliseconds(requestedAt, now);
}

interface HttpDateParts {
  readonly weekday: number;
  readonly day: number;
  readonly month: number;
  readonly year: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE.exec(value);
  if (imf !== null) {
    return httpDateTimestamp({
      weekday: SHORT_WEEKDAYS.indexOf(regexCapture(imf, 1)),
      day: Number(imf[2]),
      month: MONTHS.indexOf(regexCapture(imf, 3)),
      year: Number(imf[4]),
      hour: Number(imf[5]),
      minute: Number(imf[6]),
      second: Number(imf[7])
    });
  }

  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850 !== null) {
    const nowDate = new Date(now);
    if (!Number.isFinite(nowDate.getTime())) return undefined;
    const parts = {
      day: Number(rfc850[2]),
      month: MONTHS.indexOf(regexCapture(rfc850, 3)),
      hour: Number(rfc850[5]),
      minute: Number(rfc850[6]),
      second: Number(rfc850[7])
    };
    const year = rfc850Year(Number(rfc850[4]), parts, nowDate);
    if (year === undefined) return undefined;

    return httpDateTimestamp({
      weekday: LONG_WEEKDAYS.indexOf(regexCapture(rfc850, 1)),
      ...parts,
      year
    });
  }

  const asctime = ASCTIME_DATE.exec(value);
  if (asctime !== null) {
    return httpDateTimestamp({
      weekday: SHORT_WEEKDAYS.indexOf(regexCapture(asctime, 1)),
      day: Number(regexCapture(asctime, 3).trim()),
      month: MONTHS.indexOf(regexCapture(asctime, 2)),
      year: Number(asctime[7]),
      hour: Number(asctime[4]),
      minute: Number(asctime[5]),
      second: Number(asctime[6])
    });
  }

  return undefined;
}

function regexCapture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function rfc850Year(
  twoDigitYear: number,
  parts: Omit<HttpDateParts, "weekday" | "year">,
  now: Date
): number | undefined {
  const cutoffTimestamp = shiftedUtcYear(now, 50);
  if (cutoffTimestamp === undefined) return undefined;
  const cutoff = new Date(cutoffTimestamp);
  let year = Math.floor(cutoff.getUTCFullYear() / 100) * 100 + twoDigitYear;
  const candidate = [year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  const latestAllowed = [
    cutoff.getUTCFullYear(),
    cutoff.getUTCMonth(),
    cutoff.getUTCDate(),
    cutoff.getUTCHours(),
    cutoff.getUTCMinutes(),
    cutoff.getUTCSeconds()
  ];
  if (isLaterDateParts(candidate, latestAllowed)) year -= 100;
  return year;
}

function isLaterDateParts(candidate: readonly number[], limit: readonly number[]): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const candidatePart = candidate[index];
    const limitPart = limit[index];
    if (candidatePart === undefined || limitPart === undefined) return false;
    if (candidatePart !== limitPart) return candidatePart > limitPart;
  }
  return false;
}

function httpDateTimestamp(parts: HttpDateParts): number | undefined {
  const timestamp = calendarTimestamp(parts);
  if (timestamp === undefined) return undefined;
  const weekdayDate = new Date(timestamp - (parts.second === 60 ? 1_000 : 0));
  return weekdayDate.getUTCDay() === parts.weekday ? timestamp : undefined;
}

function calendarTimestamp(parts: Omit<HttpDateParts, "weekday">): number | undefined {
  if (
    parts.month < 0 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 60
  ) {
    return undefined;
  }

  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month, parts.day);
  date.setUTCHours(parts.hour, parts.minute, Math.min(parts.second, 59), 0);
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month ||
    date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour ||
    date.getUTCMinutes() !== parts.minute ||
    date.getUTCSeconds() !== Math.min(parts.second, 59)
  ) {
    return undefined;
  }

  return date.getTime() + (parts.second === 60 ? 1_000 : 0);
}

function shiftedUtcYear(date: Date, years: number): number | undefined {
  const shifted = new Date(date.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  const timestamp = shifted.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
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
    /\[TRUNCATED: [0-9]+ characters removed\]$/.test(value)
  );
}
