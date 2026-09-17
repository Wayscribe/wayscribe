import { createRecorder, type Recorder } from "@wayscribe/node";
import { optionalEnv, requiredEnv } from "./env.js";

/**
 * The recorder every instrumented demo service uses.
 *
 * `batchSize: 1` is a demo setting, not a recommendation. Somebody is watching
 * the interface while the journey runs, and the default one-second batching
 * would make the timeline lag the terminal by longer than the journey takes.
 * Real services should keep the defaults.
 */
export function demoRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: optionalEnv("WAYSCRIBE_ENDPOINT", "http://api:8080"),
    apiKey: requiredEnv("WAYSCRIBE_API_KEY"),
    serviceName,
    environment: optionalEnv("WAYSCRIBE_ENVIRONMENT", "development"),
    batchSize: 1,
    flushIntervalMs: 250,
    // The SDK never writes to the console itself (SECURITY.md section 12). The
    // demo opts in, because a silent recorder in a demo looks like a working
    // one right up until the timeline is empty.
    onDiagnostic: (diagnostic) => {
      console.warn(`[wayscribe] ${diagnostic.kind}: ${diagnostic.reason}`);
    }
  });
}
