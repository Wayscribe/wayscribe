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
}

/**
 * Defaults come from NODE_SDK_SPEC section 3. Configured redaction paths are
 * appended to the built-in secret list rather than replacing it: an operator
 * adding one path must not silently disable the rest.
 */
export function resolveConfig(config: RecorderConfig): ResolvedConfig {
  return {
    endpoint: config.endpoint.replace(/\/$/, ""),
    apiKey: config.apiKey,
    serviceName: config.serviceName,
    environment: config.environment,
    captureMode: config.captureMode ?? "redacted-payload",
    redact: [...(config.redact ?? []), ...DEFAULT_SECRET_PATHS],
    batchSize: clampBatchSize(config.batchSize),
    flushIntervalMs: config.flushIntervalMs ?? 1_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 1_500,
    maxBufferedEvents: config.maxBufferedEvents ?? 1_000,
    maxPayloadBytes: config.maxPayloadBytes ?? 262_144,
    propagate: config.propagate ?? "journey-and-type",
    onDiagnostic: config.onDiagnostic,
    logDiagnostics: config.logDiagnostics === true,
    maxConcurrentSends: clampConcurrentSends(config.maxConcurrentSends)
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

function clampBatchSize(configured: number | undefined): number {
  if (configured === undefined) return 50;
  if (!Number.isInteger(configured) || configured < 1) return 50;
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

function clampConcurrentSends(configured: number | undefined): number {
  if (configured === undefined || !Number.isInteger(configured)) {
    return DEFAULT_MAX_CONCURRENT_SENDS;
  }
  return Math.min(Math.max(configured, 1), MAX_CONCURRENT_SENDS_LIMIT);
}
