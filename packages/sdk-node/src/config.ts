import { DEFAULT_SECRET_PATHS } from "@flight-recorder/payload-security/redaction";
import type { Diagnostic } from "./diagnostics.js";
import type { PropagationLevel } from "./propagation.js";

export interface RecorderConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  environment: string;
  captureMode?: "metadata-only" | "redacted-payload" | "full-payload";
  redact?: readonly string[];
  batchSize?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  maxBufferedEvents?: number;
  maxPayloadBytes?: number;
  /** Default 'journey-and-type'. The entity ID propagates only at 'full' (SECURITY section 10). */
  propagate?: PropagationLevel;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /**
   * Write each diagnostic to `console.error` as one `[flight-recorder]` line, at
   * most one per kind per minute. Default false. Meant for setting up: turn it
   * on until `delivered_first` appears, then off.
   */
  logDiagnostics?: boolean;
  /**
   * Batches in flight at once from this process. Default 4, clamped to 1-16.
   * Across every process sending to one installation, the total should stay
   * under API instances times database pool size; see the README.
   */
  maxConcurrentSends?: number;
  /**
   * The key `journeyIdFor` derives journey ids under: a string of at least 32
   * bytes, kept like any other credential. Rotating it starts new journeys for
   * every entity. Without it, `journeyIdFor` reports a `configuration_error`
   * and returns random ids (ADR-052).
   */
  journeyIdSecret?: string;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  environment: string;
  captureMode: "metadata-only" | "redacted-payload" | "full-payload";
  redact: readonly string[];
  batchSize: number;
  flushIntervalMs: number;
  requestTimeoutMs: number;
  maxBufferedEvents: number;
  maxPayloadBytes: number;
  propagate: PropagationLevel;
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;
  logDiagnostics: boolean;
  maxConcurrentSends: number;
  journeyIdSecret: string | undefined;
  /**
   * Settings that could not be read or used, each replaced by its default, for
   * the recorder to report as `configuration_error` once it can.
   */
  problems: string[];
}

const CAPTURE_MODES = ["metadata-only", "redacted-payload", "full-payload"] as const;
const PROPAGATION_LEVELS = ["journey-only", "journey-and-type", "full"] as const;

/** The longest delay Node's timers accept; past it they fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Defaults come from NODE_SDK_SPEC section 3. Configured redaction paths are
 * appended to the built-in secret list rather than replacing it: an operator
 * adding one path must not silently disable the rest.
 *
 * Never throws, whatever it is given (SDK-6). Configuration usually comes from
 * the deploy environment, where a missing variable is `undefined` however the
 * code is typed, and a recorder that throws over it takes the application's
 * startup with it. A setting that cannot be read, or has the wrong type, is
 * replaced by its default and listed in `problems`. A missing endpoint cannot
 * be defaulted: it becomes empty, every send fails, and that is reported.
 */
export function resolveConfig(config: RecorderConfig): ResolvedConfig {
  const problems: string[] = [];
  const read = (key: keyof RecorderConfig): unknown => {
    try {
      return (config as Partial<RecorderConfig>)[key];
    } catch {
      problems.push(`${key} could not be read.`);
      return undefined;
    }
  };
  const text = (key: "endpoint" | "apiKey" | "serviceName" | "environment"): string => {
    const value = read(key);
    if (typeof value === "string") return value;
    problems.push(`${key} is not a string, so the server will refuse what is sent.`);
    return "";
  };
  const oneOf = <T extends string>(
    key: keyof RecorderConfig,
    allowed: readonly T[],
    fallback: T
  ): T => {
    const value = read(key);
    if (value === undefined) return fallback;
    if ((allowed as readonly unknown[]).includes(value)) return value as T;
    problems.push(`${key} is not one of ${allowed.join(", ")}; using ${fallback}.`);
    return fallback;
  };
  // A timer given NaN, a negative number or more than MAX_TIMER_MS fires after
  // 1 ms, and a queue bound or byte budget of NaN compares false with
  // everything, so the queue would grow without limit.
  const positive = (
    key: keyof RecorderConfig,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER
  ): number => {
    const value = read(key);
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) {
      return value;
    }
    problems.push(
      `${key} is not a whole number from 1 to ${String(max)}; using ${String(fallback)}.`
    );
    return fallback;
  };

  const endpoint = text("endpoint").replace(/\/$/, "");
  const redact = read("redact");
  const paths = Array.isArray(redact)
    ? (redact as unknown[]).filter((path): path is string => typeof path === "string")
    : [];
  if (redact !== undefined && (!Array.isArray(redact) || paths.length !== redact.length)) {
    problems.push("redact is not a list of paths; the entries that are not strings are ignored.");
  }
  const onDiagnostic = read("onDiagnostic");
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") {
    problems.push("onDiagnostic is not a function, so it is not called.");
  }
  const secret = read("journeyIdSecret");

  return {
    endpoint,
    apiKey: text("apiKey"),
    serviceName: text("serviceName"),
    environment: text("environment"),
    captureMode: oneOf("captureMode", CAPTURE_MODES, "redacted-payload"),
    redact: [...paths, ...DEFAULT_SECRET_PATHS],
    batchSize: clampBatchSize(read("batchSize")),
    flushIntervalMs: positive("flushIntervalMs", 1_000, MAX_TIMER_MS),
    requestTimeoutMs: positive("requestTimeoutMs", 1_500, MAX_TIMER_MS),
    maxBufferedEvents: positive("maxBufferedEvents", 1_000),
    maxPayloadBytes: positive("maxPayloadBytes", 262_144),
    propagate: oneOf("propagate", PROPAGATION_LEVELS, "journey-and-type"),
    onDiagnostic:
      typeof onDiagnostic === "function"
        ? (onDiagnostic as (diagnostic: Diagnostic) => void)
        : undefined,
    logDiagnostics: read("logDiagnostics") === true,
    maxConcurrentSends: clampConcurrentSends(read("maxConcurrentSends")),
    // Checked, and reported, by journeyIdSecretProblem, which accepts anything.
    journeyIdSecret: secret as string | undefined,
    problems
  };
}

/**
 * The server refuses a batch of more than 100 events, and that refusal was
 * invisible: an unclamped `batchSize: 150` produced a 400 the SDK read as a
 * transport failure, retried three times, and requeued to the front of the
 * queue — so 170 events were lost while the counters read like a brief blip.
 *
 * Clamped rather than thrown, because a recorder that refuses to start over a
 * tuning value would break the application it is meant to observe (ADR-007).
 * The default rises to 50: the old 20 meant five times more requests than the
 * protocol needs.
 */
export const MAX_BATCH_SIZE = 100;

function clampBatchSize(configured: unknown): number {
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 1) return 50;
  return Math.min(configured, MAX_BATCH_SIZE);
}

/**
 * Four, and not the eight a benchmark of one process against an unconstrained
 * stub favoured.
 *
 * Every ingestion request holds one database connection for its transaction,
 * so what the server can take is instances times pool size, shared by every
 * process sending to it. Simulated with one API instance, a pool of ten, and
 * ten SDK processes under a burst, eight per process queued requests past
 * `requestTimeoutMs`: the SDK aborted and resent batches the server went on to
 * store, 44 to 48 percent of the server's work was duplicates, the breaker
 * opened 40 times, and unique events stored fell from about 43,600 to about
 * 14,000. At four there were no duplicates and the breaker never opened.
 */
export const DEFAULT_MAX_CONCURRENT_SENDS = 4;

/** Past this, one process alone can exhaust a typical API instance's pool. */
export const MAX_CONCURRENT_SENDS_LIMIT = 16;

function clampConcurrentSends(configured: unknown): number {
  if (typeof configured !== "number" || !Number.isInteger(configured)) {
    return DEFAULT_MAX_CONCURRENT_SENDS;
  }
  return Math.min(Math.max(configured, 1), MAX_CONCURRENT_SENDS_LIMIT);
}
