import type { Knex } from "knex";
import { decodeSearchCursor, encodeCursor } from "./cursors.js";

export interface JourneyPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Order a journey query newest activity first and apply the cursor.
 *
 * Shared by search and the recent list so both pages walk journeys the same
 * way: `(last_event_at desc, id desc)`, strictly after the cursor. The id is
 * the tiebreaker that keeps the order total when journeys share a timestamp;
 * without it a page boundary inside a tie skips or repeats rows.
 *
 * Fetches one row more than the limit, so `toJourneyPage` can tell a full last
 * page from a page with more behind it without a count.
 *
 * Decodes the cursor before the query runs, so a malformed one throws
 * `InvalidCursorError` rather than silently restarting from the top.
 */
export function orderJourneysAfter<TRecord extends object, TResult>(
  builder: Knex.QueryBuilder<TRecord, TResult>,
  alias: string,
  limit: number,
  cursor: string | undefined
): Knex.QueryBuilder<TRecord, TResult> {
  const after = cursor === undefined ? undefined : decodeSearchCursor(cursor);
  if (after !== undefined) {
    void builder.whereRaw(`(??, ??) < (?::timestamptz, ?)`, [
      `${alias}.last_event_at`,
      `${alias}.id`,
      after.lastEventAt,
      after.id
    ]);
  }
  return builder
    .orderBy([
      { column: `${alias}.last_event_at`, order: "desc" },
      { column: `${alias}.id`, order: "desc" }
    ])
    .limit(limit + 1);
}

/** Trim the extra row `orderJourneysAfter` fetched and build the next cursor. */
export function toJourneyPage<T extends { journeyId: string; lastEventAt: Date }>(
  rows: readonly T[],
  limit: number
): JourneyPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ lastEventAt: last.lastEventAt.toISOString(), id: last.journeyId })
        : null
  };
}
