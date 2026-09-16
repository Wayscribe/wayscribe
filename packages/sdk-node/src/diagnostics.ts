import { maskSecretsInText } from "@flight-recorder/payload-security/redaction";

/**
 * `rejected` is distinct from `transport_error` on purpose. A transport error
 * means a request did not land, or the server could not store an event for
 * now, and what was not stored is retried: until the connection recovers, or
 * for an event refused for now, until 30 seconds or 10 sends have passed, when
 * it is given up and a `dropped` follows. A rejection means the
 * server received the event, understood it, and refused it — retrying changes
 * nothing, and the event is gone. Collapsing the two would tell an operator to
 * wait for a recovery that is never coming.
 */
export type FailureKind =
  | "dropped"
  | "rejected"
  | "transport_error"
  | "capture_error"
  | "breaker_open"
  | "payload_omitted"
  | "payload_truncated"
  | "configuration_error";

/**
 * `delivered_first` is the one diagnostic that is good news. It exists because
 * silence was the only sign of health, and silence is also what a recorder
 * pointed at the wrong port produces.
 */
export type DiagnosticKind = FailureKind | "delivered_first" | "insecure_endpoint";

export interface FailureDiagnostic {
  kind: FailureKind;
  reason: string;
  detail?: unknown;
}

/** Reported once per recorder, after the first batch the server stored anything from. */
export interface DeliveredFirstDiagnostic {
  kind: "delivered_first";
  reason: string;
  endpoint: string;
  /** How many events of that first batch the server stored. */
  accepted: number;
  // Declared so code written against the single-shape Diagnostic, which reads
  // `d.detail` without narrowing, still compiles.
  detail?: undefined;
}

/**
 * Reported once, when the recorder is created, for an `http:` endpoint on
 * another machine: the API key and every payload would cross the network
 * unencrypted. A warning and never a refusal to start (ADR-007), and it names
 * only the scheme and host, because an endpoint URL can carry credentials.
 */
export interface InsecureEndpointDiagnostic {
  kind: "insecure_endpoint";
  reason: string;
  scheme: "http:";
  host: string;
  // As on DeliveredFirstDiagnostic: `d.detail` still compiles unnarrowed.
  detail?: undefined;
}

export type Diagnostic = FailureDiagnostic | DeliveredFirstDiagnostic | InsecureEndpointDiagnostic;

export interface Counters {
  dropped: number;
  /** Received by the server and refused. Permanent; these events do not exist. */
  rejected: number;
  transportErrors: number;
  captureErrors: number;
  breakerOpened: number;
  /**
   * Payloads replaced by a marker because they exceeded the size guard. The
   * event itself is still sent, so this is not part of `dropped`: counting it
   * there counted one event twice, once as dropped and once as sent.
   */
  payloadsOmitted: number;
  /**
   * Payloads sent with at least one string cut to the server's 65,536 code
   * units, and a marker saying how much went. Like `payloadsOmitted`, not part
   * of `dropped`: the event is sent. A payload cut and then omitted anyway is
   * counted as omitted only.
   */
  payloadsTruncated: number;
  /**
   * Calls that needed a setting the recorder does not have, such as
   * `journeyIdFor` without a usable `journeyIdSecret`, and settings that could
   * not be used. The call still returned something safe; this is how a test
   * notices it did not return what was meant.
   */
  configurationErrors: number;
  /** Accepted and stored. Not "handed to fetch" — actually stored. */
  sent: number;
}

export interface Diagnostics {
  /**
   * `logLine`, when given, is printed in place of the reason. The reason goes
   * to `onDiagnostic` whole; the console gets only what is safe to put in a log
   * store the operator may not control.
   */
  report(diagnostic: Diagnostic, logLine?: string): void;
  recordSent(count: number): void;
  counters(): Counters;
  /** Prints any repeats still suppressed. A no-op unless logging is on. */
  flushLog(): void;
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
    dropped: 0,
    rejected: 0,
    transportErrors: 0,
    captureErrors: 0,
    breakerOpened: 0,
    payloadsOmitted: 0,
    payloadsTruncated: 0,
    configurationErrors: 0,
    sent: 0
  };
  const log = options.log === true;
  const lastPrinted = new Map<DiagnosticKind, number>();
  const suppressed = new Map<DiagnosticKind, number>();

  function print(diagnostic: Diagnostic, logLine: string | undefined): void {
    const { kind } = diagnostic;
    const now = Date.now();
    const last = lastPrinted.get(kind);
    // delivered_first and insecure_endpoint happen once per recorder, so they
    // can never flood, and a second recorder in the same process must not have
    // its warning hidden by the first one's.
    const once = kind === "delivered_first" || kind === "insecure_endpoint";
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
    report(diagnostic, logLine) {
      if (diagnostic.kind === "dropped") counters.dropped += 1;
      if (diagnostic.kind === "rejected") counters.rejected += 1;
      if (diagnostic.kind === "transport_error") counters.transportErrors += 1;
      if (diagnostic.kind === "capture_error") counters.captureErrors += 1;
      if (diagnostic.kind === "breaker_open") counters.breakerOpened += 1;
      if (diagnostic.kind === "payload_omitted") counters.payloadsOmitted += 1;
      if (diagnostic.kind === "payload_truncated") counters.payloadsTruncated += 1;
      if (diagnostic.kind === "configuration_error") counters.configurationErrors += 1;

      if (log) {
        try {
          print(diagnostic, logLine);
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
