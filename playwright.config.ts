import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 60_000,
  // Serial: the specs share one seeded journey, and parallel workers would race
  // to create it.
  workers: 1,
  use: { baseURL: process.env["WEB_URL"] ?? "http://localhost:3000" },
  reporter: "list"
});
