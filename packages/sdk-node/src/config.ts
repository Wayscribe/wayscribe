import { DEFAULT_SECRET_PATHS } from "@flight-recorder/payload-security/redaction";
import type { Diagnostic } from "./diagnostics.js";

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
  onDiagnostic?: (diagnostic: Diagnostic) => void;
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
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;
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
    batchSize: config.batchSize ?? 20,
    flushIntervalMs: config.flushIntervalMs ?? 1_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 1_500,
    maxBufferedEvents: config.maxBufferedEvents ?? 1_000,
    maxPayloadBytes: config.maxPayloadBytes ?? 262_144,
    onDiagnostic: config.onDiagnostic
  };
}
