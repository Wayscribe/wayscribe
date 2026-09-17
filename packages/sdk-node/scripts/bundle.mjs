import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleOptions } from "./bundle-options.mjs";

/**
 * Build `dist/` — for the container images and for npm alike.
 *
 * This is the package's only build. An earlier version left `build` as plain
 * tsc and bundled only at pack time, which meant the artifact running in a
 * container was not the artifact published to npm. That difference bit
 * immediately: tsc's output keeps `import "@wayscribe/payload-security"`,
 * and the moment that dependency became dev-only so it would not appear in the
 * published manifest, every demo container failed to start.
 *
 * The SDK is embedded in other companies' applications, so every dependency it
 * declares becomes a dependency they carry and a version they may have to
 * reconcile. It needs a handful of pure functions from `@wayscribe/payload-security`,
 * namely `redact`, `toStorable`, `checkLimits`, `DEFAULT_LIMITS`, `DEFAULT_SECRET_PATHS`
 * and `maskSecretsInText`, and nothing else, so those are bundled in. It takes
 * constants from `@wayscribe/protocol/limits`, a subpath that imports
 * nothing; the package root would bring Zod. `src/bundle.test.ts` fails if
 * anything from `node_modules` is inlined.
 *
 * That also removes a defect rather than only an inconvenience: the dependency
 * is declared `workspace:*`, which `pnpm pack` rewrites to `"0.0.0"` — a version
 * published nowhere. Every install of the resulting tarball would fail.
 *
 * `dist/` holds two files: the bundle and one declaration file. tsc writes a
 * declaration per module into a temporary directory, and API Extractor rolls
 * the public ones into `dist/index.d.ts`. Shipping tsc's output as it was put
 * thirteen internal declaration files and their maps in the tarball: under
 * `moduleResolution: node10`, which ignores `exports`, a deep import of one
 * compiled and then failed at runtime, and the maps pointed at sources that are
 * not published. API Extractor also fails the build when a public type refers
 * to one that is not exported (`ae-forgotten-export`).
 */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = join(packageRoot, "dist");

rmSync(dist, { recursive: true, force: true });

const types = mkdtempSync(join(tmpdir(), "sdk-node-types-"));
try {
  execFileSync(
    "npx",
    [
      "tsc",
      "-p",
      "tsconfig.build.json",
      "--declaration",
      "--emitDeclarationOnly",
      "--declarationMap",
      "false",
      "--outDir",
      types
    ],
    { cwd: packageRoot, stdio: "inherit" }
  );

  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: packageRoot,
      mainEntryPointFilePath: join(types, "index.d.ts"),
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2024",
            lib: ["ES2024"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true
          },
          files: [join(types, "index.d.ts")]
        }
      },
      // No checked-in API report: the demo image builds this package from a
      // context that excludes markdown, where a missing report fails the build.
      apiReport: { enabled: false },
      docModel: { enabled: false },
      tsdocMetadata: { enabled: false },
      dtsRollup: { enabled: true, untrimmedFilePath: join(dist, "index.d.ts") },
      messages: {
        compilerMessageReporting: { default: { logLevel: "error" } },
        extractorMessageReporting: {
          default: { logLevel: "error" },
          // Release tags are not used: stability is marked with @experimental.
          "ae-missing-release-tag": { logLevel: "none" }
        },
        // The doc comments are read by editors, not by a documentation site.
        tsdocMessageReporting: { default: { logLevel: "none" } }
      }
    },
    packageJsonFullPath: join(packageRoot, "package.json")
  });
  const result = Extractor.invoke(config, { localBuild: false });
  if (!result.succeeded) {
    throw new Error(
      `API Extractor failed with ${String(result.errorCount)} errors and ${String(result.warningCount)} warnings.`
    );
  }
} finally {
  rmSync(types, { recursive: true, force: true });
}

await build({
  ...bundleOptions(),
  outfile: join(dist, "index.js")
});

console.log("bundled dist/index.js with no runtime dependencies, and dist/index.d.ts");
