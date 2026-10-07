export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * History must outlive a day of waiting for the next reset: the oldest journey
 * is `days` old when written and `days + 1` just before the next nightly reset,
 * which must still be inside retention.
 */
export function backfillWindowProblem(days: number, retentionDays: number): string | null {
  return days + 1 < retentionDays
    ? null
    : `DEMO_HISTORY_DAYS=${String(days)} would be swept by the ${String(retentionDays)}-day retention before the next nightly reset. Keep it below ${String(retentionDays - 1)}.`;
}
