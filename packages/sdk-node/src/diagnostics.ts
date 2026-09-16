import { maskSecretsInText } from "@flight-recorder/payload-security/redaction";
import type { Operation } from "./operations.js";

/**
 * Every diagnostic kind. Closed, so a `switch` narrows; new kinds may still
 * arrive in a minor release, so a `switch` over them needs a `default` branch.
 *
 * `rejected` is distinct from `transport_error` on purpose. A transport error
 * means a request did not land, or the server could not store an event for
 * now, and what was not stored is retried: until the connection recovers, or
 * for an event refused for now, until 30 seconds or 10 sends have passed, when
 * it is given up and a `dropped` follows. A rejection means the server
 * received the event, understood it, and refused it; retrying changes nothing,
 * and the event is gone. Collapsing the two would tell an operator to wait for
 * a recovery that is never coming.
 *
 * `delivered_first` is the one diagnostic that is good news. It exists because
 * silence was the only sign of health, and silence is also what a recorder
 * pointed at the wrong port produces.
 */
export type DiagnosticKind = Diagnostic["kind"];

/**
 * Every diagnostic code, across kinds. Match on these, never on `reason`.
 * New codes may be added in any minor release.
 */
export type DiagnosticCode = Diagnostic["code"];

/**
 * Reported once per recorder, after the first batch the server stored
 * anything from. Counts toward no counter.
 */
export interface DeliveredFirstDiagnostic {
  kind: "delivered_first";
  code: "first_delivery";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    /** The endpoint's scheme, host and port only: a path or query can carry a credential. */
    endpoint: string;
    /** How many events of that first batch the server stored. */
    accepted: number;
  };
}

/**
 * Reported once, when the recorder is created, for an `http:` endpoint on
 * another machine: the API key and every payload would cross the network
 * unencrypted. A warning and never a refusal to start (ADR-007), and it names
 * only the scheme and host, because an endpoint URL can carry credentials.
 * Counts toward no counter.
 */
export interface InsecureEndpointDiagnostic {
  kind: "insecure_endpoint";
  code: "unencrypted_endpoint";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: { scheme: "http:"; host: string };
}

/**
 * The server received an event and refused it. Permanent: the event is not
 * sent again. `event_refused` is one event's verdict, with the server's error
 * in `serverError`; `request_refused` is a whole request answered with a 4xx,
 * reported once per event in it. Counted in `rejected`.
 */
export interface RejectedDiagnostic {
  kind: "rejected";
  code: "event_refused" | "request_refused";
  /**
   * A sentence for a person, which for `event_refused` quotes the server's
   * message. Its wording may change in any release.
   */
  reason: string;
  detail: {
    /** For `event_refused`: the server's error for this event, as sent. Never printed. */
    serverError?: unknown;
    /** For `request_refused`: how many events the refused request held. */
    events?: number;
    /** For `request_refused`: the response status. */
    httpStatus?: number;
  };
}

/**
 * A send did not store everything, and what was not stored is retried.
 * `request_failed`: the request itself failed. `refused_for_now`: the server
 * refused events with a verdict of 500 or above. `unexpected_error`: the SDK's
 * own send path failed, with the thrown value in `error`. Counted in
 * `transportErrors`.
 */
export interface TransportErrorDiagnostic {
  kind: "transport_error";
  code: "request_failed" | "refused_for_now" | "unexpected_error";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    /** Events going back to the queue. */
    unsent?: number;
    /** Events this send gave up on; each is also reported as `dropped`. */
    abandoned?: number;
    /** For `unexpected_error`: the value thrown. */
    error?: unknown;
  };
}

/**
 * A payload was replaced with `[PAYLOAD_TOO_LARGE]` or `[UNCAPTURABLE]`, or,
 * for `metadata`, left off; the event is still sent. The code says why:
 * `too_large` (the event's byte budget), `too_deep`, `too_wide`,
 * `unserialisable` (reading it threw, as a getter or a `toJSON` can), or
 * `projection_failed` (a `captureInput` or `captureOutput` threw or returned a
 * promise). What was thrown, if anything, is in `error`; it can quote the
 * payload, so it is never printed. Counted in `payloadsOmitted`.
 */
export interface PayloadOmittedDiagnostic {
  kind: "payload_omitted";
  code: "too_large" | "too_deep" | "too_wide" | "unserialisable" | "projection_failed";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: { field: "input" | "output" | "metadata"; error?: unknown };
}

/**
 * Strings in a payload were cut to the server's limit (`strings_cut`), or a
 * journey label was cut to 200 code points (`label_cut`, reported once, when
 * the label is set). The event is still sent. Counted in `payloadsTruncated`.
 */
export interface PayloadTruncatedDiagnostic {
  kind: "payload_truncated";
  code: "strings_cut" | "label_cut";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    field: "input" | "output" | "metadata" | "journeyLabel";
    /** How many strings were cut. */
    strings: number;
    /** UTF-16 code units removed. */
    charactersRemoved: number;
  };
}

/**
 * Entries the server would refuse were left off an event, or a label was not
 * set (`label_invalid`, reported once, when `label` is called). The event is
 * still sent. `keys` says how many entries this one report covers. Counted in
 * `keysDropped`, once per report.
 */
export interface KeyDroppedDiagnostic {
  kind: "key_dropped";
  code:
    | "aliases_not_object"
    | "alias_invalid"
    | "displayable_alias_invalid"
    | "metadata_key_too_long"
    | "label_invalid";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    field: "aliases" | "displayableAliases" | "metadata" | "journeyLabel";
    keys: number;
  };
}

/**
 * An event was not delivered. `queue_full`: the oldest queued event was shed.
 * `after_shutdown`: recorded after `shutdown()`, with its `name` and
 * `operation`. `shutdown`: still undelivered when shutdown finished, though
 * the server may have stored it. `retry_budget`: the server was still refusing
 * it for now after 30 seconds or 10 sends. `no_verdict`: the server's reply
 * gave no verdict for it; it may have been stored, so it is not sent again.
 * Counted in `dropped`.
 */
export interface DroppedDiagnostic {
  kind: "dropped";
  code: "queue_full" | "after_shutdown" | "shutdown" | "retry_budget" | "no_verdict";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    /** For `after_shutdown`: the event's name. */
    name?: string;
    /** For `after_shutdown`: the event's operation. */
    operation?: Operation;
  };
}

/**
 * A call could not record what it was asked to, and the host's call was
 * unaffected. `unexpected_error`: something threw, with the thrown value in
 * `error` (a value that cannot be described has a fixed reason).
 * `not_a_journey`: something given to `across` is neither a journey nor a
 * context. `invalid_options`: the options of the call named in `call` are not
 * an object, or hold keys it does not read (never quoted). `context_missing`:
 * an inject helper, named in `call`, was given no journey context. Counted in
 * `captureErrors`.
 */
export interface CaptureErrorDiagnostic {
  kind: "capture_error";
  code: "unexpected_error" | "not_a_journey" | "invalid_options" | "context_missing";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    error?: unknown;
    /** For `invalid_options` and `context_missing`: the method that was called. */
    call?: string;
  };
}

/**
 * A setting or an argument could not be used, or a call needed a setting the
 * recorder does not have; the call returned something safe. `setting` names
 * what could not be used, never its value.
 *
 * - `setting_unusable`, `required_setting_unusable`: a recorder setting.
 * - `setting_renamed`: a setting or option given under the name it had
 *   before the first release, which is not read; the reason names the new one.
 * - `journey_id_secret_missing`, `journey_id_secret_unusable`: from
 *   `journeyIdFor`, or from creating the recorder with a secret it cannot use.
 * - `entity_invalid`: an entity that is missing, or whose type or id is not a
 *   non-empty string, given to `journeyIdFor`, `startJourney` or
 *   `continueJourney` (`setting` is `entity`, or `context` for a context's).
 *   `startJourney` and `continueJourney` record under the entity
 *   `{ type: "unknown", id: "unknown" }` instead.
 * - `journey_id_invalid`: a `continueJourney` context, or `journeyId`, without
 *   a non-empty string id; it is not used.
 *
 * Counted in `configurationErrors`.
 */
export interface ConfigurationErrorDiagnostic {
  kind: "configuration_error";
  code:
    | "setting_unusable"
    | "required_setting_unusable"
    | "setting_renamed"
    | "journey_id_secret_missing"
    | "journey_id_secret_unusable"
    | "entity_invalid"
    | "journey_id_invalid";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: { setting?: string };
}

/**
 * Sends pause for `cooldownMs` after `failures` sends failed in a row.
 * Counted in `breakerOpened`.
 */
export interface BreakerOpenedDiagnostic {
  kind: "breaker_opened";
  code: "consecutive_failures";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: { failures: number; cooldownMs: number };
}

/**
 * A value was sent in plain text under a name that looks like a secret,
 * because no redaction rule covers the name (ADR-055). A warning: the event is
 * sent unchanged. `name` is as written, cut to 128 characters; the value is
 * never included. Counted in `unredactedSecretNames`.
 */
export interface UnredactedSecretNameDiagnostic {
  kind: "unredacted_secret_name";
  code: "secret_like_name";
  /** A sentence for a person. Its wording may change in any release. */
  reason: string;
  detail: {
    field: "input" | "output" | "metadata";
    name: string;
    /** Where the name was, with every array index written `[*]`. */
    path: string;
  };
}

/**
 * What `onDiagnostic` receives: `{ kind, code, reason, detail }`. Match on
 * `kind` and `code`; `reason` is prose whose wording may change in any
 * release. New kinds and codes may be added in any minor release, so handle
 * the ones you do not know in a `default` branch.
 */
export type Diagnostic =
  | DeliveredFirstDiagnostic
  | InsecureEndpointDiagnostic
  | RejectedDiagnostic
  | TransportErrorDiagnostic
  | PayloadOmittedDiagnostic
  | PayloadTruncatedDiagnostic
  | KeyDroppedDiagnostic
  | DroppedDiagnostic
  | CaptureErrorDiagnostic
  | ConfigurationErrorDiagnostic
  | BreakerOpenedDiagnostic
  | UnredactedSecretNameDiagnostic;

/**
 * What the recorder has counted since it was created. Every counter except
 * `recorded` and `sent` counts reports of one diagnostic kind, one per
 * report.
 *
 * Once `shutdown()` has returned, `sent + rejected + dropped === recorded`.
 *
 * @experimental Fields may be added in any minor release.
 */
export interface Counters {
  /** Events the recorder built and queued, and events refused because it had shut down. */
  recorded: number;
  /** Events the server accepted and stored. */
  sent: number;
  /** `rejected` reports: events the server received and refused. Permanent. */
  rejected: number;
  /** `dropped` reports: events not delivered. */
  dropped: number;
  /** `transport_error` reports. */
  transportErrors: number;
  /** `capture_error` reports. */
  captureErrors: number;
  /** `breaker_opened` reports. */
  breakerOpened: number;
  /**
   * `payload_omitted` reports: payloads replaced by a marker. The event is
   * still sent, so these are not part of `dropped`.
   */
  payloadsOmitted: number;
  /**
   * `payload_truncated` reports: payloads sent with at least one string cut,
   * and journey labels cut, each counted once, when set. A payload cut and
   * then omitted is counted as omitted only.
   */
  payloadsTruncated: number;
  /**
   * `key_dropped` reports: one per event field that lost entries, and one per
   * refused label. `detail.keys` says how many entries each report covers.
   */
  keysDropped: number;
  /** `configuration_error` reports. */
  configurationErrors: number;
  /**
   * `unredacted_secret_name` reports: distinct key names, folded as redaction
   * folds them, sent in plain text although they look like secrets
   * (ADR-055). At most 100.
   */
  unredactedSecretNames: number;
}

/**
 * The counter each kind increments. The naming rule: `<noun>_<participle>`
 * counts in `<nouns><Participle>`, `<noun>_error` in `<noun>Errors`, and a
 * bare participle in itself.
 */
const COUNTER_OF: Record<DiagnosticKind, keyof Counters | undefined> = {
  delivered_first: undefined,
  insecure_endpoint: undefined,
  rejected: "rejected",
  transport_error: "transportErrors",
  payload_omitted: "payloadsOmitted",
  payload_truncated: "payloadsTruncated",
  key_dropped: "keysDropped",
  dropped: "dropped",
  capture_error: "captureErrors",
  configuration_error: "configurationErrors",
  breaker_opened: "breakerOpened",
  unredacted_secret_name: "unredactedSecretNames"
};

/** The kinds the failure boundary reports a thrown value as. */
export type BoundaryKind = "capture_error" | "transport_error";

export interface Diagnostics {
  /**
   * `logLine`, when given, is printed in place of the reason. The reason goes
   * to `onDiagnostic` whole; the console gets only what is safe to put in a log
   * store the operator may not control.
   */
  report(diagnostic: Diagnostic, logLine?: string, options?: ReportOptions): void;
  recordSent(count: number): void;
  /** One event built and queued, or refused after shutdown. */
  countRecorded(): void;
  counters(): Counters;
  /** Prints any repeats still suppressed. A no-op unless logging is on. */
  flushLog(): void;
}

export interface ReportOptions {
  /**
   * Printed whatever else of its kind was printed this minute. For what a
   * recorder reports once, at creation: several configuration problems arrive
   * together, and the rate limit printed only the first, which could hide the
   * one warning SDK-56 requires.
   */
  unlimited?: boolean;
}

export interface DiagnosticsOptions {
  /** Write each diagnostic to `console.error`, rate-limited. Default false. */
  log?: boolean;
}

const PREFIX = "[flight-recorder]";
const LOG_WINDOW_MS = 60_000;
/**
 * Long enough for any reason the SDK writes itself; short enough that a
 * megabyte error message cannot become a megabyte log line.
 */
const MAX_LOGGED_REASON = 512;

/**
 * Failures go to counters and an optional callback, and to the console only
 * when the operator asked for that.
 *
 * SECURITY.md section 12 forbids recursive logging of recorder failures: a
 * recorder that writes to stderr on every failed flush becomes the incident
 * during an outage. Opt-in logging keeps to that by printing at most one line
 * per kind per minute, however many failures there are.
 */
export function createDiagnostics(
  onDiagnostic?: (diagnostic: Diagnostic) => void,
  options: DiagnosticsOptions = {}
): Diagnostics {
  const counters: Counters = {
    recorded: 0,
    sent: 0,
    dropped: 0,
    rejected: 0,
    transportErrors: 0,
    captureErrors: 0,
    breakerOpened: 0,
    payloadsOmitted: 0,
    payloadsTruncated: 0,
    keysDropped: 0,
    configurationErrors: 0,
    unredactedSecretNames: 0
  };
  const log = options.log === true;
  const lastPrinted = new Map<DiagnosticKind, number>();
  const suppressed = new Map<DiagnosticKind, number>();

  function print(diagnostic: Diagnostic, logLine: string | undefined, unlimited: boolean): void {
    const { kind } = diagnostic;
    const now = Date.now();
    const last = lastPrinted.get(kind);
    // delivered_first and insecure_endpoint happen once per recorder, so they
    // can never flood, and a second recorder in the same process must not have
    // its warning hidden by the first one's. An unlimited report is one the
    // recorder makes once, at creation, for the same reason.
    const once = unlimited || kind === "delivered_first" || kind === "insecure_endpoint";
    if (!once && last !== undefined && now - last < LOG_WINDOW_MS) {
      suppressed.set(kind, (suppressed.get(kind) ?? 0) + 1);
      return;
    }
    const repeats = suppressed.get(kind) ?? 0;
    lastPrinted.set(kind, now);
    suppressed.delete(kind);
    write(
      `${PREFIX} ${kind}: ${printable(logLine ?? diagnostic.reason)}` +
        (repeats > 0 ? ` (${plural(repeats)} suppressed since the last line)` : "")
    );
  }

  return {
    report(diagnostic, logLine, options) {
      const counter = COUNTER_OF[diagnostic.kind];
      if (counter !== undefined) counters[counter] += 1;

      if (log) {
        try {
          print(diagnostic, logLine, options?.unlimited === true);
        } catch {
          // Formatting runs the masker over text the recorder did not write; a
          // failure there must not cost the callback below.
        }
      }

      try {
        onDiagnostic?.(diagnostic);
      } catch {
        // A diagnostics callback that throws must not become the failure it was
        // reporting.
      }
    },
    recordSent(count) {
      counters.sent += count;
    },
    countRecorded() {
      counters.recorded += 1;
    },
    counters: () => ({ ...counters }),
    flushLog() {
      if (!log) return;
      for (const [kind, repeats] of suppressed) {
        write(`${PREFIX} ${kind}: ${plural(repeats)} suppressed since the last line`);
      }
      suppressed.clear();
    }
  };
}

/**
 * One diagnostic printed whatever `log` says, formatted and bounded like any
 * other printed line, with `note` saying why it was printed.
 *
 * For the one warning SDK-40 allows by default: a misconfiguration that splits
 * journeys and that nothing else would bring to anybody's attention.
 */
export function printDiagnostic(diagnostic: Diagnostic, note: string): void {
  try {
    write(`${PREFIX} ${diagnostic.kind}: ${printable(diagnostic.reason)} (${note})`);
  } catch {
    // As in report(): formatting must not become a failure of its own.
  }
}

function plural(repeats: number): string {
  return `${String(repeats)} ${repeats === 1 ? "repeat" : "repeats"}`;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

/**
 * The reason as one safe line: credential shapes masked, control characters
 * (newlines, terminal escapes) replaced so a reason cannot forge a second log
 * line, bidirectional formatting characters (U+061C, U+200E, U+200F,
 * U+202A-U+202E, U+2066-U+2069) replaced so it cannot make a log
 * viewer display text in an order other than the one it was written in, and
 * bounded.
 *
 * Masked over twice the bound before the cut, for the reason
 * `boundedMaskedText` gives: a cut first can split a credential so the masker
 * no longer recognises it.
 */
function printable(reason: string): string {
  const window = reason.slice(0, 2 * MAX_LOGGED_REASON);
  const flat = maskSecretsInText(window).replace(UNPRINTABLE, " ");
  return flat.length <= MAX_LOGGED_REASON
    ? flat.toWellFormed()
    : `${flat.slice(0, MAX_LOGGED_REASON).toWellFormed()}[TRUNCATED]`;
}

/** Never throws: stderr can be closed under a supervisor, and console.error then throws. */
function write(line: string): void {
  try {
    console.error(line);
  } catch {
    // Nothing useful to do; the counters still hold the truth.
  }
}
