import { defineConfig } from "vitest/config";

/**
 * The demo suite needs the full Compose stack, not a process, so it has its own
 * configuration rather than joining the unit or integration runs. `pnpm test`
 * and `pnpm test:integration` must stay runnable on a laptop with nothing up.
 */
export default defineConfig({
  test: {
    include: ["apps/demo/src/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
