import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Build `dist/` — for the container images and for npm alike.
 *
 * This is the package's only build. An earlier version left `build` as plain
 * tsc and bundled only at pack time, which meant the artifact running in a
 * container was not the artifact published to npm. That difference bit
 * immediately: tsc's output keeps `import "@flight-recorder/payload-security"`,
 * and the moment that dependency became dev-only so it would not appear in the
 * published manifest, every demo container failed to start.
 *
 * The SDK is embedded in other companies' applications, so every dependency it
 * declares becomes a dependency they carry and a version they may have to
 * reconcile. It needs a handful of pure functions from `@flight-recorder/payload-security`,
 * namely `redact`, `toStorable`, `checkLimits`, `DEFAULT_LIMITS`, `DEFAULT_SECRET_PATHS`
 * and `maskSecretsInText`, and nothing else, so those are bundled in. It takes
 * constants from `@flight-recorder/protocol/limits`, a subpath that imports
 * nothing; the package root would bring Zod. `src/bundle.test.ts` fails if
 * anything from `node_modules` is inlined.
 *
 * That also removes a defect rather than only an inconvenience: the dependency
 * is declared `workspace:*`, which `pnpm pack` rewrites to `"0.0.0"` — a version
 * published nowhere. Every install of the resulting tarball would fail.
 *
 * Types come from tsc rather than esbuild, which does not emit them. Nothing in
 * the public surface refers to an imported type, so the declarations come out
 * self-contained.
 */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

// Declarations first: tsc writes .js alongside .d.ts, and the bundle overwrites
// the entry point afterwards.
execFileSync(
  "npx",
  ["tsc", "-p", "tsconfig.build.json", "--declaration", "--emitDeclarationOnly"],
  {
    cwd: packageRoot,
    stdio: "inherit"
  }
);

await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Resolved through the source condition so the workspace package is inlined
  // rather than left as an import of a package that will not exist.
  conditions: ["development"],
  // `createRequire` is used to reach OpenTelemetry when it is present. Bundling
  // must not try to follow that: the whole point is that it may be absent.
  external: ["node:*"],
  legalComments: "none"
});

console.log("bundled dist/index.js with no runtime dependencies");
