import type { EventListItem } from "./api";

/**
 * Pure timeline logic, kept out of React so it can be tested without a DOM and
 * read without a component's state in the way.
 */

export interface TimelineFilters {
  /** A service name, or null for all of them. */
  service: string | null;
  failuresOnly: boolean;
}

export const NO_FILTERS: TimelineFilters = { service: null, failuresOnly: false };

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
  return visible[next]?.id ?? first.id;
}

/**
 * Union by id, ordered by timestamp then id.
 *
 * Polling delivers overlapping pages, so this has to be safe to apply
 * repeatedly. The order is the API's own (ADR-031: an event carries when its
 * operation started), so merging cannot reorder what a reader has already seen.
 */
export function mergeEvents(
  existing: readonly EventListItem[],
  incoming: readonly EventListItem[]
): EventListItem[] {
  const byId = new Map<string, EventListItem>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(
    (a, b) => a.eventTimestamp.localeCompare(b.eventTimestamp) || a.id.localeCompare(b.id)
  );
}

/** Distinct service names in first-seen order, for the filter chips. */
export function services(events: readonly EventListItem[]): string[] {
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

/**
 * The count line under the heading.
 *
 * The header used to print the journey's true count above a list capped at a
 * hundred, with nothing saying so. Each case here names what the number is a
 * count of.
 */
export function describeCount({ visible, loaded, total, complete }: CountInput): string {
  const all = Math.max(total, loaded);
  if (visible !== loaded) return `${String(visible)} of ${String(loaded)} events shown`;
  if (!complete) return `showing ${String(loaded)} of ${String(all)} events`;
  return `${String(all)} events`;
}
