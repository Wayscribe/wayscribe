import { createRecorder, type Recorder } from "@flight-recorder/node";

export function createAppRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
    apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
    serviceName,
    environment: process.env.FLIGHT_RECORDER_ENVIRONMENT ?? "development",
    redact: ["**.email", "**.phone", "**.taxId"],
    logDiagnostics: process.env.NODE_ENV !== "production",
    // Your logger, not the console, once the service is known to send.
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "rejected" || diagnostic.kind === "dropped") {
        console.warn("flight recorder", diagnostic.kind, diagnostic.code);
      }
    }
  });
}
