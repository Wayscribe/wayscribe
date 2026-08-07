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
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database"),
      "@flight-recorder/protocol": packageSource("protocol"),
      "@flight-recorder/payload-security": packageSource("payload-security"),
      "@flight-recorder/payload-diff": packageSource("payload-diff"),
      "@flight-recorder/sdk-node": packageSource("sdk-node")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    // The demo suite needs a running Compose stack, so it must never join this
    // run: `pnpm test` has to work on a laptop with nothing up.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 10_000
  }
});
