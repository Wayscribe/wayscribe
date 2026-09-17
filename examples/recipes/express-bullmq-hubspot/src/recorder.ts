import { createRecorder, type Recorder } from "@wayscribe/node";

// One recorder per process. The web process and the worker are separate
// services, so each names itself.
export function createAppRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: process.env.WAYSCRIBE_URL ?? "http://localhost:8080",
    apiKey: process.env.WAYSCRIBE_API_KEY ?? "",
    serviceName,
    // Must be the environment the API key was issued for.
    environment: process.env.WAYSCRIBE_ENVIRONMENT ?? "development",
    // Leads carry personal data. Keep the fields, replace their values.
    redact: ["**.email", "**.phone"],
    // Prints `delivered_first`, or why nothing arrives. Off once it sends.
    logDiagnostics: process.env.NODE_ENV !== "production"
  });
}
