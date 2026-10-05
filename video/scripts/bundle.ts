import { copyFile, link, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import type { Capture } from "../src/capture";

export const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function readCapture(captureDir: string): Promise<Capture> {
  const capture = JSON.parse(await readFile(join(captureDir, "marks.json"), "utf8")) as Capture;
  if (capture.version !== 1) throw new Error(`Unknown capture version ${String(capture.version)}.`);
  return capture;
}

/**
 * Builds the render's public directory (the capture's frames, hard-linked, and
 * the Inter font files) under `outDir`, and bundles the composition with it.
 */
export async function prepareBundle(captureDir: string, outDir: string): Promise<string> {
  const publicDir = join(outDir, "render-public");
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(join(publicDir, "capture", "frames"), { recursive: true });
  await mkdir(join(publicDir, "fonts"), { recursive: true });
  for (const name of await readdir(join(captureDir, "frames"))) {
    await link(join(captureDir, "frames", name), join(publicDir, "capture", "frames", name));
  }
  for (const weight of ["400", "600", "700"]) {
    const file = `inter-latin-${weight}-normal.woff2`;
    await copyFile(
      join(VIDEO, "node_modules", "@fontsource", "inter", "files", file),
      join(publicDir, "fonts", file)
    );
  }
  return bundle({ entryPoint: join(VIDEO, "src", "index.ts"), publicDir });
}
