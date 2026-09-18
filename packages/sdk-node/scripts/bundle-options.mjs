import { fileURLToPath } from "node:url";
import { buildIdentity } from "./build-identity.mjs";

/**
 * The esbuild options every build of the SDK uses: the published bundle
 * (`bundle.mjs`), the benchmarks (`bench/build.mjs`) and the tests that check
 * what the bundle inlines (`src/bundle.test.ts`) and what it bakes in
 * (`src/bundle-identity.test.ts`). One copy, so the tests check the bundle
 * that ships rather than one like it.
 *
 * `identity` is the version and commit baked into every event's
 * `runtime.sdk` through `define` (ADR-063); by default, `buildIdentity()`'s,
 * which fails the build for a malformed commit variable. Run from source,
 * where nothing is defined, the SDK reports `0.0.0-development`.
 */
export function bundleOptions(identity = buildIdentity()) {
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
    legalComments: "none",
    define: {
      __WAYSCRIBE_SDK_VERSION__: JSON.stringify(identity.version),
      // Empty when no commit was found; the SDK then leaves `commit` out.
      __WAYSCRIBE_SDK_COMMIT__: JSON.stringify(identity.commit ?? "")
    }
  };
}
