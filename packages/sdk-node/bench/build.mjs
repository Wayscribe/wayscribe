import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONSTANT = /const MAX_CONCURRENT_SENDS = \d+;/;

/**
 * Bundles the SDK from source, as `scripts/bundle.mjs` does, optionally with a
 * different send concurrency, and returns a URL to import it from.
 *
 * From source rather than `dist/`, so a benchmark never measures a stale build.
 * The concurrency is replaced in the bundle rather than exposed as an option,
 * because it is a measured default and not a knob the public API should grow
 * for the sake of a benchmark. The replacement fails loudly if the constant's
 * declaration ever changes shape, so a variant can never silently be the
 * default.
 */
export async function buildRecorder({ maxConcurrentSends } = {}) {
  const outdir = join(tmpdir(), "flight-recorder-bench");
  mkdirSync(outdir, { recursive: true });
  const outfile = join(
    outdir,
    `recorder-${maxConcurrentSends === undefined ? "default" : String(maxConcurrentSends)}.mjs`
  );

  await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    conditions: ["development"],
    external: ["node:*"],
    logLevel: "error",
    plugins: [
      {
        name: "max-concurrent-sends",
        setup(context) {
          context.onLoad({ filter: /[\\/]sdk-node[\\/]src[\\/]recorder\.ts$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            if (!CONSTANT.test(source)) {
              throw new Error(
                "MAX_CONCURRENT_SENDS is no longer declared as the benchmark expects."
              );
            }
            return {
              loader: "ts",
              contents:
                maxConcurrentSends === undefined
                  ? source
                  : source.replace(
                      CONSTANT,
                      `const MAX_CONCURRENT_SENDS = ${String(maxConcurrentSends)};`
                    )
            };
          });
        }
      }
    ]
  });

  return pathToFileURL(outfile).href;
}

/** The default, read from the source, so reports name the value they measured. */
export function defaultMaxConcurrentSends() {
  const source = readFileSync(new URL("../src/recorder.ts", import.meta.url), "utf8");
  const match = /const MAX_CONCURRENT_SENDS = (\d+);/.exec(source);
  if (match === null) throw new Error("MAX_CONCURRENT_SENDS not found in recorder.ts.");
  return Number(match[1]);
}
