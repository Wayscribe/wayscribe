import { createRecorder, type Recorder } from "@wayscribe/node";

// One recorder per server process. Development reloads modules, so keep it on
// globalThis rather than creating a second one on every edit.
const cache = globalThis as typeof globalThis & { wayscribe?: Recorder };

export const recorder: Recorder = (cache.wayscribe ??= createRecorder({
  endpoint: process.env.WAYSCRIBE_URL ?? "http://localhost:8080",
  apiKey: process.env.WAYSCRIBE_API_KEY ?? "",
  serviceName: "storefront",
  environment: process.env.WAYSCRIBE_ENVIRONMENT ?? "development",
  // Stripe's checkout session carries the buyer's details.
  redact: ["**.customer_details", "**.email"],
  // Experimental: at least 32 bytes, kept like any other credential.
  journeyIdSecret: process.env.JOURNEY_ID_SECRET,
  logDiagnostics: process.env.NODE_ENV !== "production"
}));
