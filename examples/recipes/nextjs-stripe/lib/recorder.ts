import { createRecorder, type Recorder } from "@flight-recorder/node";

// One recorder per server process. Development reloads modules, so keep it on
// globalThis rather than creating a second one on every edit.
const cache = globalThis as typeof globalThis & { flightRecorder?: Recorder };

export const recorder: Recorder = (cache.flightRecorder ??= createRecorder({
  endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
  apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
  serviceName: "storefront",
  environment: process.env.FLIGHT_RECORDER_ENVIRONMENT ?? "development",
  // Stripe's checkout session carries the buyer's details.
  redact: ["**.customer_details", "**.email"],
  // Experimental: at least 32 bytes, kept like any other credential.
  journeyIdSecret: process.env.JOURNEY_ID_SECRET,
  logDiagnostics: process.env.NODE_ENV !== "production"
}));
