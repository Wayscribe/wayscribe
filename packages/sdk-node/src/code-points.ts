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
