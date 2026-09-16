/** Whether `text` is at most `max` code points. Code units bound them from above. */
export function fitsCodePoints(text: string, max: number): boolean {
  if (text.length <= max) return true;
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
    if (count > max) return false;
  }
  return true;
}

/**
 * The first `max` code points of `text`, which is longer than that. Sliced
 * where a code point ends, so a surrogate pair is never split.
 */
export function firstCodePoints(text: string, max: number): string {
  let units = 0;
  let count = 0;
  for (const codePoint of text) {
    if (count === max) break;
    units += codePoint.length;
    count += 1;
  }
  return text.slice(0, units);
}
