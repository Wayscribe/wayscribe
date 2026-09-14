// Pure timeline logic, kept out of React so it can be tested without a DOM and
// read without a component's state in the way.
import type { EventListItem } from "./api";

export interface TimelineFilters {
  /** A service name, or null for all of them. */
  readonly service: string | null;
  readonly failuresOnly: boolean;
}

export const NO_FILTERS: TimelineFilters = Object.freeze({ service: null, failuresOnly: false });

/** The events a reader currently sees, in the order they already had. */
export function applyFilters(
  events: readonly EventListItem[],
  filters: TimelineFilters
): EventListItem[] {
  return events.filter(
    (event) =>
      (filters.service === null || event.service === filters.service) &&
      (!filters.failuresOnly || event.hasError)
  );
}

/**
 * The id one step up or down within the visible list.
 *
 * At an edge the selection stays put rather than wrapping: a reader pressing
 * ArrowDown at the bottom of a timeline is looking for more, and jumping to the
 * top would read as the list having changed. A selection that is no longer
 * visible (filtered out) resolves to the first visible event.
 */
export function neighbour(
  visible: readonly EventListItem[],
  selectedId: string | null,
  direction: "up" | "down"
): string | null {
  const first = visible[0];
  if (first === undefined) return null;

  const index = visible.findIndex((event) => event.id === selectedId);
  if (index === -1) return first.id;

  const next =
    direction === "down" ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0);
  // `next` is always a valid index of `visible` here (0 <= next < visible.length);
  // the `?? first.id` only satisfies noUncheckedIndexedAccess for the compiler
  // and can't actually be reached.
  return visible[next]?.id ?? first.id;
}

/** Plain string comparison: `a`/`b` are fixed-form machine strings (timestamps, ids), not locale text. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Union by id, in the server's order.
 *
 * The API orders and pages events by `(event_timestamp, received_at, id)`
 * (`packages/database/src/repositories/event-reads.ts`, the `orderBy` and the
 * cursor comparison), so this sorts on the same three fields in the same
 * order: two events can share a timestamp, and only `received_at` then `id`
 * settle the tie the way the server already did. Polling delivers overlapping
 * pages, so this also has to be safe to apply repeatedly, and it is: a
 * repeated union changes nothing, and a newer copy of an id replaces the
 * older one.
 */
export function mergeEvents(
  existing: readonly EventListItem[],
  incoming: readonly EventListItem[]
): EventListItem[] {
  const byId = new Map<string, EventListItem>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(
    (a, b) =>
      compare(a.eventTimestamp, b.eventTimestamp) ||
      compare(a.receivedAt, b.receivedAt) ||
      compare(a.id, b.id)
  );
}

/** Distinct service names in first-seen order, for the filter chips. */
export function distinctServices(events: readonly EventListItem[]): string[] {
  const seen: string[] = [];
  for (const event of events) {
    if (!seen.includes(event.service)) seen.push(event.service);
  }
  return seen;
}

export interface CountInput {
  /** Rows on screen after filtering. */
  visible: number;
  /** Rows fetched so far. */
  loaded: number;
  /** The journey's own count, which can lag a live journey. */
  total: number;
  /** Whether every page has been fetched. */
  complete: boolean;
}

/** "event" or "events", depending on `count`. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * The count line under the heading.
 *
 * The header used to print the journey's true count above a list capped at a
 * hundred, with nothing saying so. Each case here names what the number is a
 * count of, including the case where a filter is hiding rows and pages are
 * still unfetched: without a total, that reads as though nothing more exists.
 */
export function describeCount({ visible, loaded, total, complete }: CountInput): string {
  const all = Math.max(total, loaded);
  if (visible !== loaded) {
    if (!complete) {
      return `${String(visible)} of ${String(loaded)} loaded ${plural(loaded, "event")} shown, ${String(all)} in total`;
    }
    return `${String(visible)} of ${String(loaded)} ${plural(loaded, "event")} shown`;
  }
  if (!complete) return `showing ${String(loaded)} of ${String(all)} ${plural(all, "event")}`;
  return `${String(all)} ${plural(all, "event")}`;
}

/**
 * How recently the last event must have landed for a journey that is no longer
 * active to still be followed.
 *
 * A journey's status turns terminal on its first failure while the retries
 * that follow are still being recorded, so status alone would stop the
 * timeline following a journey that is plainly still moving.
 */
export const RECENT_MS = 30_000;

/**
 * Whether `iso` is within {@link RECENT_MS} of `now`.
 *
 * Computed on the server and passed down as a boolean, never recomputed in the
 * browser: the two clocks disagree, and a value that decides whether an
 * element renders would then differ between the server's HTML and the client's
 * first render, which is a hydration mismatch on every warm journey.
 *
 * A delta that is negative (a service clock running ahead, which is a real
 * possibility here — the timeline warns about exactly that skew) or NaN (an
 * unparsable timestamp) is not recent: both are `< RECENT_MS` arithmetically,
 * and neither is evidence that anything just happened.
 */
export function isRecent(iso: string, now: number): boolean {
  const delta = now - Date.parse(iso);
  return Number.isFinite(delta) && delta >= 0 && delta < RECENT_MS;
}
