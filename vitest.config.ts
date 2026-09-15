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
      "@flight-recorder/protocol/conformance": fileURLToPath(
        new URL("./packages/protocol/src/conformance.ts", import.meta.url)
      ),
      "@flight-recorder/node/conformance-harness": fileURLToPath(
        new URL("./packages/sdk-node/src/conformance-harness.ts", import.meta.url)
      ),
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database"),
      "@flight-recorder/protocol": packageSource("protocol"),
      "@flight-recorder/payload-security": packageSource("payload-security"),
      "@flight-recorder/payload-diff": packageSource("payload-diff"),
      "@flight-recorder/node": packageSource("sdk-node"),
      "@flight-recorder/cli": packageSource("cli")
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          // Route-handler and other app/-level .ts tests run under node; .tsx
          // component tests run under jsdom in the "web" project below.
          include: [
            "{apps,packages}/*/src/**/*.test.ts",
            "tests/**/*.test.ts",
            "apps/web/app/**/*.test.ts"
          ],
          // The demo suite needs a running Compose stack, so it must never join this
          // run: `pnpm test` has to work on a laptop with nothing up.
          exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.e2e.test.ts"],
          environment: "node",
          testTimeout: 10_000
        }
      },
      {
        // React components render into jsdom. Kept as a second project rather than
        // a per-file environment comment so a component test cannot silently run
        // under node and pass by never rendering.
        extends: true,
        // apps/web/tsconfig.json sets jsx: "preserve" for Next, and there is no
        // React Vite plugin here, so the test transform has to name the
        // automatic runtime itself or JSX comes out referencing a global React.
        esbuild: { jsx: "automatic" },
        test: {
          name: "web",
          include: ["apps/web/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          environment: "jsdom",
          setupFiles: ["apps/web/vitest.setup.tsx"],
          testTimeout: 10_000
        }
      }
    ]
  }
});
