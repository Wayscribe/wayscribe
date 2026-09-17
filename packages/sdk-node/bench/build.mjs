import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleOptions } from "../scripts/bundle-options.mjs";

/**
 * Bundles the SDK from source, as `scripts/bundle.mjs` does, into a temporary
 * directory of this run's own, and returns a URL to import it from and a way
 * to remove it.
 *
 * From source rather than `dist/`, so a benchmark never measures a stale build.
 * Per run, so two runs at once, or a run on another branch, never import each
 * other's bundle.
 */
export async function buildRecorder() {
  const directory = mkdtempSync(join(tmpdir(), "wayscribe-bench-"));
  const outfile = join(directory, "recorder.mjs");

  await build({ ...bundleOptions(), outfile, logLevel: "error" });

  return {
    module: pathToFileURL(outfile).href,
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** The default, read from the source, so reports name the value they measured. */
export function defaultMaxConcurrentSends() {
  const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const match = /export const DEFAULT_MAX_CONCURRENT_SENDS = (\d+);/.exec(source);
  if (match === null) throw new Error("DEFAULT_MAX_CONCURRENT_SENDS not found in config.ts.");
  return Number(match[1]);
}
