import { defineConfig } from "@playwright/test";

/**
 * The live check of the public demo (ADR-073): `pnpm test:live`, and the
 * `live-demo` CI job. Its own config, so `pnpm test:e2e` (playwright.config.ts,
 * apps/web/e2e) can never reach production. LIVE_URL points it at another
 * deployment, such as a local overlay stack.
 */
export default defineConfig({
  testDir: "./apps/web/e2e-live",
  timeout: 60_000,
  workers: 1,
  // One retry rides out a dropped request; a demo that is down stays red.
  retries: 1,
  use: {
    baseURL: process.env["LIVE_URL"] ?? "https://demo.wayscribe.dev",
    // deploy/demo/visit-notifier skips the smoke check's prefix, so a check
    // is not announced as a visit.
    userAgent: "wayscribe-smoke/live-demo"
  },
  reporter: "list"
});
