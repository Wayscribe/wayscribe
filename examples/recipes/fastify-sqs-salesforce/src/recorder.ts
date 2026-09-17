import { createRecorder, type Recorder } from "@wayscribe/node";

export function createAppRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: process.env.WAYSCRIBE_URL ?? "http://localhost:8080",
    apiKey: process.env.WAYSCRIBE_API_KEY ?? "",
    serviceName,
    environment: process.env.WAYSCRIBE_ENVIRONMENT ?? "development",
    redact: ["**.email", "**.phone", "**.taxId"],
    logDiagnostics: process.env.NODE_ENV !== "production",
    // Your logger, not the console, once the service is known to send.
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "rejected" || diagnostic.kind === "dropped") {
        console.warn("wayscribe", diagnostic.kind, diagnostic.code);
      }
    }
  });
}
