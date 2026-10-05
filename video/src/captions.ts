export const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** The spec's reading rule: 1 second per 3 words plus 1 second, never under 2.5 seconds. */
export const minSeconds = (text: string): number => Math.max(2.5, words(text) / 3 + 1);

/**
 * Lines `text` wraps to at `fontPx` in `maxWidthPx`, assuming every character
 * is 0.58 em wide: wider than Inter's average, so the estimate errs high. The
 * stills review in Task 13 is the real check.
 */
export function estimateLines(text: string, fontPx: number, maxWidthPx: number): number {
  const perLine = Math.floor(maxWidthPx / (fontPx * 0.58));
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/)) {
    const need = used === 0 ? word.length : used + 1 + word.length;
    if (need <= perLine) used = need;
    else {
      lines++;
      used = word.length;
    }
  }
  return lines;
}
