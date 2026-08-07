import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
