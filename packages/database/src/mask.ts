const MINIMUM_LENGTH_FOR_PARTIAL = 9;
const PREFIX_LENGTH = 4;
const SUFFIX_LENGTH = 3;

/**
 * Mask an alias display value for search results.
 *
 * Alias values are identifiers the caller may not be entitled to see in full —
 * unlike the primary entity ID, which is whatever they just searched for.
 *
 * Values of eight characters or fewer are masked completely: showing four
 * leading and three trailing characters of an eight-character value would
 * disclose almost all of it.
 */
export function maskDisplayValue(value: string): string {
  if (value.length < MINIMUM_LENGTH_FOR_PARTIAL) return "…";
  return `${value.slice(0, PREFIX_LENGTH)}…${value.slice(-SUFFIX_LENGTH)}`;
}
