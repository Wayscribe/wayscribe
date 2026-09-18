import { DEFAULT_SECRET_PATHS } from "@wayscribe/payload-security/redaction";
import type { Diagnostic } from "./diagnostics.js";
import type { PropagationLevel } from "./propagation.js";
import { readHostList } from "./host-list.js";
import { readKnownSafeNames } from "./secret-names.js";

/**
 * What the recorder captures of a payload. `metadata-only` captures none;
 * `redacted-payload` captures it with secret names redacted; `full-payload`
 * asks for it whole, which the server stores only where its environment allows
 * it, and the built-in secret names are still redacted.
 */
export type CaptureMode = "metadata-only" | "redacted-payload" | "full-payload";

/**
 * Which build of a service recorded an event. The wire protocol has carried
 * these three fields since the first release and the API stores them, so a
 * timeline can answer "which build did this?" (F-002, ADR-060).
 *
 * Every field is optional. One that is given and is not a string, is empty or
 * only whitespace, or is longer than the protocol accepts (128 characters for
 * `gitCommit` and `version`, 512 for `image`) is left off rather than cut or
 * trimmed, since a cut commit or version names a build that does not exist,
 * and the rest is still sent. A key other than these three is left off too.
 *
 * Each is reported as a `configuration_error` and named in
 * `counters().rejectedSettings` (F-031, ADR-062): `deployment.gitCommit`,
 * `deployment.version` or `deployment.image` for a field that is not sent,
 * `deployment.*` for other keys, never by their own names, and `deployment`
 * when events carry no deployment at all, which includes `{}` and an object
 * whose every field is `undefined`, as unset environment variables give.
 */
export interface Deployment {
  /** The commit this build was made from. At most 128 characters. */
  gitCommit?: string | undefined;
  /** The service's own version, such as its package version. At most 128. */
  version?: string | undefined;
  /** The container image and tag, such as `registry.example/app:1.4.2`. At most 512. */
  image?: string | undefined;
}

/** What the protocol accepts, by field (`packages/protocol` `deploymentSchema`). */
const DEPLOYMENT_LIMITS: Readonly<Record<keyof Deployment, number>> = {
  gitCommit: 128,
  version: 128,
  image: 512
};

/**
 * The recorder's settings. The four without a default are required. A value
 * that cannot be used never stops the recorder starting: it is reported as a
 * `configuration_error` and replaced by its default, or clamped into range.
 * Nothing is converted: `"5000"` read from `process.env` is not a number.
 */
export interface RecorderConfig {
  /** Where the API is, such as `https://wayscribe.internal`. */
  endpoint: string;
  /** An API key for one project and one environment. */
  apiKey: string;
  /** The name of the service doing the recording. */
  serviceName: string;
  /** Which environment this process is. Must match the API key's environment. */
  environment: string;
  /** @defaultValue "redacted-payload" */
  captureMode?: CaptureMode | undefined;
  /**
   * Redaction rules, applied beside the built-in secret names, never instead
   * of them. At most 1,000; any past that are ignored and reported.
   *
   * @defaultValue []
   */
  redact?: readonly string[] | undefined;
  /**
   * Events per request. At most 100, the server's limit.
   *
   * @defaultValue 50
   */
  batchSize?: number | undefined;
  /** @defaultValue 1000 */
  flushIntervalMs?: number | undefined;
  /** @defaultValue 1500 */
  requestTimeoutMs?: number | undefined;
  /**
   * Events held in memory. Past it, the oldest are dropped and counted.
   *
   * @defaultValue 1000
   */
  maxBufferedEvents?: number | undefined;
  /**
   * The byte budget of one whole event, which should be the server's
   * `MAX_EVENT_PAYLOAD_BYTES`. Payloads that do not fit are replaced, the
   * largest first.
   *
   * @defaultValue 262144
   */
  maxEventBytes?: number | undefined;
  /**
   * What crosses a process boundary. The entity id propagates only at `full`
   * (SECURITY section 10); aliases never do.
   *
   * @defaultValue "journey-and-type"
   * @experimental The propagation names and grammar wait on the propagation
   * specification.
   */
  propagation?: PropagationLevel | undefined;
  /**
   * Called with every diagnostic. A callback that throws is ignored.
   *
   * @defaultValue none
   */
  onDiagnostic?: ((diagnostic: Diagnostic) => void) | undefined;
  /**
   * Write each diagnostic to `console.error` as one `[wayscribe]` line, at
   * most one per kind per minute. Meant for setting up: turn it on until
   * `delivered_first` appears, then off.
   *
   * @defaultValue false
   */
  logDiagnostics?: boolean | undefined;
  /**
   * Batches in flight at once from this process, clamped to 1 to 16. Across
   * every process sending to one installation, the total should stay under API
   * instances times database pool size; see the README.
   *
   * @defaultValue 4
   * @experimental Adaptive concurrency is the long-term fix, and would make
   * this option obsolete.
   */
  maxConcurrentSends?: number | undefined;
  /**
   * The key `journeyIdFor` derives journey ids under: a string of at least 32
   * bytes, kept like any other credential. Rotating it starts new journeys for
   * every entity. Without it, `journeyIdFor` reports a `configuration_error`
   * and returns random ids (ADR-052).
   *
   * @defaultValue none
   * @experimental As `journeyIdFor`.
   */
  journeyIdSecret?: string | undefined;
  /**
   * Which build this process is, sent on every event it records. Read once,
   * when the recorder is created, and copied, so a later change to the object
   * changes no event. What cannot be sent is reported by field, as
   * `Deployment` says.
   *
   * @defaultValue none: events carry no deployment
   */
  deployment?: Deployment | undefined;
  /**
   * Key names that look like secrets and are not, such as a `sessionId` that
   * is an analytics id. The `unredacted_secret_name` warning skips them. Plain
   * names only, compared with case, `-` and `_` ignored. Redaction is
   * unaffected: a name on `redact` or the built-in list is still redacted.
   * At most 1,000; any past that are ignored and reported.
   *
   * @defaultValue []
   */
  knownSafeNames?: readonly string[] | undefined;
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  environment: string;
  captureMode: CaptureMode;
  redact: readonly string[];
  batchSize: number;
  flushIntervalMs: number;
  requestTimeoutMs: number;
  maxBufferedEvents: number;
  maxEventBytes: number;
  propagation: PropagationLevel;
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;
  logDiagnostics: boolean;
  maxConcurrentSends: number;
  journeyIdSecret: string | undefined;
  /**
   * The deployment as every event will carry it, frozen, or undefined when
   * none was configured or none of it could be used. Resolved once here so
   * that recording an event costs one property and no per-field work.
   */
  deployment: Readonly<Deployment> | undefined;
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
  setting: string;
  code: "setting_unusable" | "required_setting_unusable" | "setting_renamed";
  reason: string;
  /**
   * The setting has no default, so nothing the recorder records reaches the
   * server until it is fixed.
   */
  required: boolean;
  /**
   * Printed once per process whatever `logDiagnostics` says. Every rejected
   * setting is: a required one because nothing reaches the server without it,
   * a renamed one because the value is otherwise lost unseen (SDK-60), and an
   * optional one because it was replaced by its default and the recorder goes
   * on looking healthy while the setting the operator chose is not in force
   * (ADR-060).
   */
  printed: boolean;
}

/** Options a JavaScript caller may still pass under the name they had before the first release. */
const RENAMED: Readonly<Record<string, keyof RecorderConfig>> = {
  maxPayloadBytes: "maxEventBytes",
  propagate: "propagation"
};

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

/**
 * The most entries a list setting keeps, `redact` and `knownSafeNames` alike.
 * Far more rules than anybody writes, and small enough that a list whose
 * `length` claims a trillion costs a moment, not the process.
 */
export const MAX_LIST_ENTRIES = 1_000;

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
  const problem: Report = (setting, reason) => {
    const required = (REQUIRED as readonly string[]).includes(setting);
    problems.push({
      setting,
      code: required ? "required_setting_unusable" : "setting_unusable",
      reason,
      required,
      // Every rejected setting prints, not only a required one. Gating this on
      // `required` left an optional setting silent with logDiagnostics off and
      // no onDiagnostic read: the recorder ran with a value the operator never
      // chose, and every event it was meant to bound or enrich kept flowing
      // (F-010, ADR-060).
      printed: true
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
    // Blank is missing: `process.env.X ?? ""`, the way these settings are
    // usually written, turns an unset variable into "", which used to pass
    // unreported and surface only as a 401.
    if (typeof value === "string" && value.trim() !== "") return value;
    problem(
      key,
      value === UNREADABLE
        ? `${key} could not be read, so ${WITHOUT[key]}.`
        : typeof value === "string"
          ? `${key} is empty, so ${WITHOUT[key]}.`
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
  // Copied by index into an array of the SDK's own before anything else
  // touches it: a revoked Proxy, a hostile method, a species constructor or a
  // huge length all threw out of createRecorder, or hung it (SDK-6).
  const redactList = readHostList(redact, MAX_LIST_ENTRIES);
  let paths: string[] = [];
  if (redactList.kind === "unreadable") {
    problem("redact", "redact could not be read; only the built-in secret names apply.");
  } else if (redactList.kind === "not_a_list") {
    problem("redact", "redact is not a list of paths; only the built-in secret names apply.");
  } else if (redactList.kind === "list") {
    paths = redactList.entries.filter((path): path is string => typeof path === "string");
    if (redactList.cut) {
      problem(
        "redact",
        `redact holds more than ${String(MAX_LIST_ENTRIES)} paths; the rest are ignored.`
      );
    } else if (paths.length !== redactList.entries.length) {
      problem(
        "redact",
        "redact is not a list of paths; the entries that are not strings are ignored."
      );
    }
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
  const deployment = readDeployment(readOnce("deployment", "events carry no deployment"), problem);
  const knownSafe = readKnownSafeNames(
    readOnce("knownSafeNames", "no name is exempt from the warning"),
    MAX_LIST_ENTRIES
  );
  if (knownSafe.problem !== undefined) problem("knownSafeNames", knownSafe.problem);
  for (const [old, current] of Object.entries(RENAMED)) {
    let given: unknown;
    try {
      given = (config as unknown as Record<string, unknown>)[old];
    } catch {
      // Unreadable configuration is already reported, setting by setting.
      continue;
    }
    if (given === undefined) continue;
    problems.push({
      setting: old,
      code: "setting_renamed",
      reason: `${old} is now called ${current}, and ${old} is not read; ${current} keeps its default unless it is set.`,
      required: false,
      printed: true
    });
  }

  return {
    endpoint,
    apiKey: text("apiKey"),
    serviceName: text("serviceName"),
    environment: text("environment"),
    captureMode: oneOf("captureMode", CAPTURE_MODES, "redacted-payload"),
    // Frozen, so redaction parses these rules once rather than per payload.
    redact: Object.freeze([...paths, ...DEFAULT_SECRET_PATHS]),
    batchSize: clampBatchSize(readOnce("batchSize", "using 50"), problem),
    flushIntervalMs: positive("flushIntervalMs", 1_000, MAX_TIMER_MS),
    requestTimeoutMs: positive("requestTimeoutMs", 1_500, MAX_TIMER_MS),
    maxBufferedEvents: positive("maxBufferedEvents", 1_000),
    maxEventBytes: positive("maxEventBytes", 262_144),
    propagation: oneOf("propagation", PROPAGATION_LEVELS, "journey-and-type"),
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
    deployment,
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

/**
 * Reports a setting that could not be used as given: a key of
 * `RecorderConfig`, or a part of `deployment` by its dotted name (ADR-062).
 */
type Report = (setting: keyof RecorderConfig | DeploymentPart, reason: string) => void;

/** The names a part of `deployment` is reported under (ADR-062). */
type DeploymentPart = `deployment.${keyof Deployment}` | "deployment.*";

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

/**
 * The deployment as events will carry it: the fields the protocol has, each a
 * string the protocol accepts, frozen and copied.
 *
 * Anything else is reported, naming what was refused and never a value, so a
 * partial refusal reads differently from a total one (F-031, ADR-062):
 *
 * - `deployment.<field>` for each field that was given, meaning its value is
 *   not `undefined`, and is not sent: not a string, empty or whitespace only,
 *   longer than the protocol accepts, or its getter threw. A value with text
 *   in it is sent as given, never trimmed.
 * - `deployment.*`, once, for own enumerable keys other than the three, which
 *   are never sent, or keys that could not be listed. Never the key's name,
 *   because it is the host's and could be anything.
 * - `deployment` when the setting was given and events carry no deployment:
 *   it could not be read, it is not an object, or no field of it is sent,
 *   which covers `{}` and `{ gitCommit: undefined }`, the shape an unset
 *   environment variable gives.
 *
 * In that order. Reading each field and listing the keys are guarded apart,
 * because the object is the host's and its getters and traps are the host's
 * code (SDK-6).
 */
function readDeployment(configured: unknown, report: Report): Readonly<Deployment> | undefined {
  if (configured === undefined) return undefined;
  let array: boolean;
  try {
    // Guarded: `Array.isArray` throws for a revoked Proxy, and this used to
    // throw out of createRecorder into the host's startup.
    array = Array.isArray(configured);
  } catch {
    report("deployment", "deployment could not be read; events carry no deployment.");
    return undefined;
  }
  if (typeof configured !== "object" || configured === null || array) {
    report(
      "deployment",
      "deployment is not an object of gitCommit, version and image; events carry no deployment."
    );
    return undefined;
  }
  const kept: Deployment = {};
  for (const field of Object.keys(DEPLOYMENT_LIMITS) as (keyof Deployment)[]) {
    let value: unknown;
    try {
      value = (configured as Deployment)[field];
    } catch {
      report(`deployment.${field}`, `deployment.${field} could not be read, so it is not sent.`);
      continue;
    }
    if (value === undefined) continue;
    // Measured in UTF-16 code units, which is never more permissive than the
    // protocol's own count, so a value kept here is one the server accepts.
    // Blank is empty, as for the required settings: three spaces name no
    // build, and would be on every event.
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= DEPLOYMENT_LIMITS[field]
    ) {
      kept[field] = value;
    } else {
      report(
        `deployment.${field}`,
        `deployment.${field} is ${
          typeof value !== "string"
            ? "not a string"
            : value.trim() === ""
              ? "empty"
              : `longer than the ${String(DEPLOYMENT_LIMITS[field])} characters the protocol accepts`
        }, so it is not sent.`
      );
    }
  }
  let extra: boolean;
  try {
    // Own keys against the table's own keys: `in` reads the prototype, and let
    // `constructor` and `toString` through unreported.
    extra = Object.keys(configured).some((key) => !Object.hasOwn(DEPLOYMENT_LIMITS, key));
  } catch {
    extra = true;
  }
  if (extra) {
    report(
      "deployment.*",
      "deployment holds keys other than gitCommit, version and image, or its keys could not be listed; those keys are not sent."
    );
  }
  if (Object.keys(kept).length === 0) {
    report("deployment", "deployment has no field that can be sent; events carry no deployment.");
    return undefined;
  }
  return Object.freeze(kept);
}
