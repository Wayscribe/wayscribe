import { copyFile, link, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import type { Capture } from "../src/capture";

export const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");

const FONT_WEIGHTS = ["400", "600", "700"];

export async function readCapture(captureDir: string): Promise<Capture> {
  const capture = JSON.parse(await readFile(join(captureDir, "marks.json"), "utf8")) as Capture;
  if (capture.version !== 1) throw new Error(`Unknown capture version ${String(capture.version)}.`);
  return capture;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

/** Hard-links `from` to `to`, copying instead when they are on different disks. */
async function place(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await link(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
  }
}

/** The Inter woff2 files the composition loads, found through the package itself. */
function interFonts(): { name: string; path: string }[] {
  let root: string;
  try {
    root = dirname(
      createRequire(join(VIDEO, "package.json")).resolve("@fontsource/inter/package.json")
    );
  } catch {
    throw new Error("Cannot find @fontsource/inter: run pnpm --dir video install.");
  }
  return FONT_WEIGHTS.map((weight) => {
    const name = `inter-latin-${weight}-normal.woff2`;
    return { name, path: join(root, "files", name) };
  });
}

/**
 * Builds the render's public directory (the frames the capture lists, hard-linked,
 * and the Inter font files) under `outDir`, and bundles the composition with it.
 * The bundle goes in a fixed directory under `outDir`, replaced on each call, so
 * repeated runs leave nothing behind in the system temp directory.
 */
export async function prepareBundle(captureDir: string, outDir: string): Promise<string> {
  const source = resolve(captureDir);
  const out = resolve(outDir);
  const { frames } = await readCapture(source);
  const files = [...new Set(frames.map((frame) => frame.file))];
  const missing: string[] = [];
  for (const file of files) if (!(await exists(join(source, file)))) missing.push(file);
  if (missing.length > 0) {
    throw new Error(
      `The capture in ${source} lists ${String(missing.length)} frame file(s) that are missing, starting with ${missing.slice(0, 3).join(", ")}. Re-run the capture.`
    );
  }
  const fonts = interFonts();
  for (const font of fonts) {
    if (!(await exists(font.path))) {
      throw new Error(`Cannot find ${font.path}: run pnpm --dir video install.`);
    }
  }

  const publicDir = join(out, "render-public");
  await rm(publicDir, { recursive: true, force: true });
  for (const file of files) await place(join(source, file), join(publicDir, "capture", file));
  await mkdir(join(publicDir, "fonts"), { recursive: true });
  for (const font of fonts) await copyFile(font.path, join(publicDir, "fonts", font.name));

  const bundleDir = join(out, "render-bundle");
  await rm(bundleDir, { recursive: true, force: true });
  return bundle({
    entryPoint: join(VIDEO, "src", "index.ts"),
    publicDir,
    outDir: bundleDir,
    symlinkPublicDir: true
  });
}
