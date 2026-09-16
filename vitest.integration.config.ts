import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Subpath first: Vite matches aliases in order, and the bare
      // specifier would otherwise shadow it.
      "@flight-recorder/payload-security/redaction": fileURLToPath(
        new URL("./packages/payload-security/src/redaction.ts", import.meta.url)
      ),
      "@flight-recorder/protocol/limits": fileURLToPath(
        new URL("./packages/protocol/src/limits.ts", import.meta.url)
      ),
      "@flight-recorder/protocol/conformance": fileURLToPath(
        new URL("./packages/protocol/src/conformance.ts", import.meta.url)
      ),
      "@flight-recorder/node/conformance-harness": fileURLToPath(
        new URL("./packages/sdk-node/src/conformance-harness.ts", import.meta.url)
      ),
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database"),
      "@flight-recorder/node": packageSource("sdk-node")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
