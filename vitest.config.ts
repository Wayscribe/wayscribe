import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database"),
      "@flight-recorder/protocol": packageSource("protocol"),
      "@flight-recorder/payload-security": packageSource("payload-security"),
      "@flight-recorder/payload-diff": packageSource("payload-diff")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 10_000
  }
});
