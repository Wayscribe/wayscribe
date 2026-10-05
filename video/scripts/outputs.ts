import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/**
 * The temporary name an output is written to before it is renamed into place.
 * It keeps the extension, which ffmpeg reads to pick the container.
 */
export function partialName(final: string): string {
  const ext = extname(final);
  return join(dirname(final), `${basename(final, ext)}.partial${ext}`);
}

/**
 * Removes what the last run left in `dir` under these names (files or
 * directories, with any half-written copy), so that a run which fails partway
 * leaves nothing that looks current. Names that are absent are fine.
 */
export async function clearOutputs(dir: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await rm(join(dir, name), { recursive: true, force: true });
    await rm(partialName(join(dir, name)), { force: true });
  }
}

/**
 * Has `write` produce the file at a temporary name beside `final`, and renames
 * it into place only once `write` has finished, and returns what `write`
 * returned. If `write` throws, the temporary file is removed and `final` is
 * untouched.
 */
export async function writeThenRename<T = void>(
  final: string,
  write: (partial: string) => T | Promise<T>
): Promise<T> {
  const partial = partialName(final);
  await mkdir(dirname(final), { recursive: true });
  await rm(partial, { force: true });
  try {
    const result = await write(partial);
    await rename(partial, final);
    return result;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
