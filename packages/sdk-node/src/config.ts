import { DEFAULT_SECRET_PATHS } from "@flight-recorder/payload-security/redaction";
import type { Diagnostic } from "./diagnostics.js";
import type { PropagationLevel } from "./propagation.js";
import { readKnownSafeNames } from "./secret-names.js";

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
  /**
   * Key names that look like secrets and are not, such as a `sessionId` that
   * is an analytics id. The `unredacted_secret_name` warning skips them. Plain
   * names only, compared with case, `-` and `_` ignored. Redaction is
   * unaffected: a name on `redact` or the built-in list is still redacted.
   */
  knownSafeNames?: readonly string[];
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
  /** Folded. */
  knownSafeNames: readonly string[];
  /**
   * Settings that could not be read or used, each replaced by its default or
   * clamped, for the recorder to report as `configuration_error` once it can.
   */
  problems: ConfigProblem[];
}

/** A setting `resolveConfig` could not use as given. The reason never quotes the value. */
export interface ConfigProblem {
  setting: keyof RecorderConfig;
  reason: string;
  /**
   * The setting has no default, so nothing the recorder records reaches the
   * server until it is fixed.
   */
  required: boolean;
}

const REQUIRED = ["endpoint", "apiKey", "serviceName", "environment"] as const;
type RequiredSetting = (typeof REQUIRED)[number];

/**
 * What happens to recorded events when a required setting cannot be used, so
 * the report says what the operator will see rather than a guess at it.
 */
const WITHOUT: Record<RequiredSetting, string> = {
  endpoint:
    "no request can be made: every send fails before reaching any server, and the events are dropped",
  apiKey: "the server refuses every request, and the events are counted as rejected",
  serviceName: "the server refuses every event, and the events are counted as rejected",
  environment: "the server refuses every event, and the events are counted as rejected"
};

const CAPTURE_MODES = ["metadata-only", "redacted-payload", "full-payload"] as const;
const PROPAGATION_LEVELS = ["journey-only", "journey-and-type", "full"] as const;

/** The longest delay Node's timers accept; past it they fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** A setting whose read threw, as distinct from one that is absent. */
const UNREADABLE = Symbol("unreadable");

/**
 * Defaults come from NODE_SDK_SPEC section 3. Configured redaction paths are
 * appended to the built-in secret list rather than replacing it: an operator
 * adding one path must not silently disable the rest.
 *
 * Never throws, whatever it is given (SDK-6). Configuration usually comes from
 * the deploy environment, where a missing variable is `undefined` however the
 * code is typed, and a recorder that throws over it takes the application's
 * startup with it. A setting that cannot be read, has the wrong type, or is out
 * of range is replaced by its default, or clamped, and listed in `problems`.
 * Nothing is coerced: `"5000"` from `process.env` is not a number. A required
 * setting has no default: it becomes empty, and the problem says what then
 * happens to events.
 */
export function resolveConfig(config: RecorderConfig): ResolvedConfig {
  const problems: ConfigProblem[] = [];
  const problem = (setting: keyof RecorderConfig, reason: string): void => {
    problems.push({
      setting,
      reason,
      required: (REQUIRED as readonly string[]).includes(setting)
    });
  };
  const read = (key: keyof RecorderConfig): unknown => {
    try {
      return (config as Partial<RecorderConfig>)[key];
    } catch {
      return UNREADABLE;
    }
  };
  /** The value, or undefined after reporting a read that threw. */
  const readOnce = (key: keyof RecorderConfig, fallback: string): unknown => {
    const value = read(key);
    if (value !== UNREADABLE) return value;
    problem(key, `${key} could not be read; ${fallback}.`);
    return undefined;
  };
  const text = (key: RequiredSetting): string => {
    const value = read(key);
    if (typeof value === "string") return value;
    problem(
      key,
      value === UNREADABLE
        ? `${key} could not be read, so ${WITHOUT[key]}.`
        : `${key} is not a string, so ${WITHOUT[key]}.`
    );
    return "";
  };
  const oneOf = <T extends string>(
    key: keyof RecorderConfig,
    allowed: readonly T[],
    fallback: T
  ): T => {
    const value = readOnce(key, `using ${fallback}`);
    if (value === undefined) return fallback;
    if ((allowed as readonly unknown[]).includes(value)) return value as T;
    problem(key, `${key} is not one of ${allowed.join(", ")}; using ${fallback}.`);
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
    const value = readOnce(key, `using ${String(fallback)}`);
    if (value === undefined) return fallback;
    if (isWhole(value) && value >= 1 && value <= max) return value;
    problem(
      key,
      `${key} is not a whole number from 1 to ${String(max)}; using ${String(fallback)}.`
    );
    return fallback;
  };

  const endpoint = text("endpoint").replace(/\/$/, "");
  const redact = readOnce("redact", "only the built-in secret names apply");
  const paths = Array.isArray(redact)
    ? (redact as unknown[]).filter((path): path is string => typeof path === "string")
    : [];
  if (redact !== undefined && (!Array.isArray(redact) || paths.length !== redact.length)) {
    problem(
      "redact",
      "redact is not a list of paths; the entries that are not strings are ignored."
    );
  }
  const onDiagnostic = readOnce("onDiagnostic", "it is not called");
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") {
    problem("onDiagnostic", "onDiagnostic is not a function, so it is not called.");
  }
  const logDiagnostics = readOnce("logDiagnostics", "logging stays off");
  if (logDiagnostics !== undefined && typeof logDiagnostics !== "boolean") {
    problem("logDiagnostics", "logDiagnostics is not true or false; logging stays off.");
  }
  const secret = readOnce("journeyIdSecret", "journeyIdFor returns random journey ids");
  const knownSafe = readKnownSafeNames(
    readOnce("knownSafeNames", "no name is exempt from the warning")
  );
  if (knownSafe.problem !== undefined) problem("knownSafeNames", knownSafe.problem);

  return {
    endpoint,
    apiKey: text("apiKey"),
    serviceName: text("serviceName"),
    environment: text("environment"),
    captureMode: oneOf("captureMode", CAPTURE_MODES, "redacted-payload"),
    redact: [...paths, ...DEFAULT_SECRET_PATHS],
    batchSize: clampBatchSize(readOnce("batchSize", "using 50"), problem),
    flushIntervalMs: positive("flushIntervalMs", 1_000, MAX_TIMER_MS),
    requestTimeoutMs: positive("requestTimeoutMs", 1_500, MAX_TIMER_MS),
    maxBufferedEvents: positive("maxBufferedEvents", 1_000),
    maxPayloadBytes: positive("maxPayloadBytes", 262_144),
    propagate: oneOf("propagate", PROPAGATION_LEVELS, "journey-and-type"),
    onDiagnostic:
      typeof onDiagnostic === "function"
        ? (onDiagnostic as (diagnostic: Diagnostic) => void)
        : undefined,
    logDiagnostics: logDiagnostics === true,
    maxConcurrentSends: clampConcurrentSends(
      readOnce("maxConcurrentSends", `using ${String(DEFAULT_MAX_CONCURRENT_SENDS)}`),
      problem
    ),
    // Checked, and reported, by journeyIdSecretProblem, which accepts anything.
    journeyIdSecret: secret as string | undefined,
    knownSafeNames: knownSafe.names,
    problems
  };
}

const warnedAboutSetting = new Set<string>();

/**
 * Whether the warning for a required setting that cannot be used should be
 * printed. Once per process and setting, not per recorder, as the secret's is:
 * a job that creates a recorder per task should not print it per task.
 */
export function firstRequiredSettingWarning(setting: string): boolean {
  if (warnedAboutSetting.has(setting)) return false;
  warnedAboutSetting.add(setting);
  return true;
}

/** For tests: the next required-setting warning prints again. */
export function forgetRequiredSettingWarnings(): void {
  warnedAboutSetting.clear();
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

type Report = (setting: keyof RecorderConfig, reason: string) => void;

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

function clampBatchSize(configured: unknown, report: Report): number {
  if (configured === undefined) return 50;
  if (!isWhole(configured) || configured < 1) {
    report("batchSize", "batchSize is not a whole number of at least 1; using 50.");
    return 50;
  }
  if (configured <= MAX_BATCH_SIZE) return configured;
  report(
    "batchSize",
    `batchSize is over ${String(MAX_BATCH_SIZE)}, the most the server accepts in one request; using ${String(MAX_BATCH_SIZE)}.`
  );
  return MAX_BATCH_SIZE;
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

function clampConcurrentSends(configured: unknown, report: Report): number {
  if (configured === undefined) return DEFAULT_MAX_CONCURRENT_SENDS;
  if (!isWhole(configured)) {
    report(
      "maxConcurrentSends",
      `maxConcurrentSends is not a whole number; using ${String(DEFAULT_MAX_CONCURRENT_SENDS)}.`
    );
    return DEFAULT_MAX_CONCURRENT_SENDS;
  }
  const clamped = Math.min(Math.max(configured, 1), MAX_CONCURRENT_SENDS_LIMIT);
  if (clamped !== configured) {
    report(
      "maxConcurrentSends",
      `maxConcurrentSends is outside 1 to ${String(MAX_CONCURRENT_SENDS_LIMIT)}; using ${String(clamped)}.`
    );
  }
  return clamped;
}
