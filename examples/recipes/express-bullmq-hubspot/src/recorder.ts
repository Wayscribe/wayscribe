import { createRecorder, type Recorder } from "@flight-recorder/node";

// One recorder per process. The web process and the worker are separate
// services, so each names itself.
export function createAppRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
    apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
    serviceName,
    // Must be the environment the API key was issued for.
    environment: process.env.FLIGHT_RECORDER_ENVIRONMENT ?? "development",
    // Leads carry personal data. Keep the fields, replace their values.
    redact: ["**.email", "**.phone"],
    // Prints `delivered_first`, or why nothing arrives. Off once it sends.
    logDiagnostics: process.env.NODE_ENV !== "production"
  });
}
