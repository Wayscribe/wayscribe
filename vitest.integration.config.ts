import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * The PostgreSQL major version every integration test starts, and the only
 * place it is read. CI runs the suite on 17 and again on the other versions
 * docs/OPERATIONS.md supports (`database` in .gitlab-ci.yml); locally,
 * `TEST_POSTGRES_VERSION=15 pnpm test:integration`. Tests get the image with
 * `inject("postgresImage")` (tests/vitest-provided.d.ts).
 */
const postgresVersion = process.env.TEST_POSTGRES_VERSION ?? "17";
if (!/^\d+$/.test(postgresVersion)) {
  throw new Error(
    `TEST_POSTGRES_VERSION must be a PostgreSQL major version such as 17, not "${postgresVersion}".`
  );
}

export default defineConfig({
  resolve: {
    alias: {
      // Subpath first: Vite matches aliases in order, and the bare
      // specifier would otherwise shadow it.
      "@wayscribe/payload-security/redaction": fileURLToPath(
        new URL("./packages/payload-security/src/redaction.ts", import.meta.url)
      ),
      "@wayscribe/protocol/limits": fileURLToPath(
        new URL("./packages/protocol/src/limits.ts", import.meta.url)
      ),
      "@wayscribe/protocol/conformance": fileURLToPath(
        new URL("./packages/protocol/src/conformance.ts", import.meta.url)
      ),
      "@wayscribe/node/conformance-harness": fileURLToPath(
        new URL("./packages/sdk-node/src/conformance-harness.ts", import.meta.url)
      ),
      "@wayscribe/config": packageSource("config"),
      "@wayscribe/database": packageSource("database"),
      "@wayscribe/node": packageSource("sdk-node")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    provide: {
      postgresVersion,
      postgresImage: `postgres:${postgresVersion}-alpine`
    }
  }
});
