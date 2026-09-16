import { fileURLToPath } from "node:url";

/**
 * The esbuild options every build of the SDK uses: the published bundle
 * (`bundle.mjs`), the benchmarks (`bench/build.mjs`) and the test that checks
 * what the bundle inlines (`src/bundle.test.ts`). One copy, so the test checks
 * the bundle that ships rather than one like it.
 */
export function bundleOptions() {
  return {
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Resolved through the source condition so the workspace package is inlined
    // rather than left as an import of a package that will not exist.
    conditions: ["development"],
    // `createRequire` is used to reach OpenTelemetry when it is present. Bundling
    // must not try to follow that: the whole point is that it may be absent.
    external: ["node:*"],
    legalComments: "none"
  };
}
