import type { EventListItem } from "./api";

export type GapPresentation =
  | { kind: "gap"; milliseconds: number; label: string }
  | { kind: "overlap"; milliseconds: number; label: string }
  | { kind: "unknown"; startToStartMs: number | null; label: string };

export interface TimelineTiming {
  eventId: string;
  previousEventId: string | null;
  gapBefore: GapPresentation | null;
  clockCaveat: string | null;
}

export interface RetryAttemptPresentation {
  eventId: string;
  number: number;
  outcome: "failed" | "succeeded";
  delayMs: number | null;
}

export interface RetryGroupPresentation {
  service: string;
  name: string;
  retryGroup: string;
  attempts: RetryAttemptPresentation[];
  issues: string[];
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${String(milliseconds)} ms`;
  if (milliseconds < 60_000) {
    const seconds = Math.round(milliseconds / 10) / 100;
    return `${String(seconds)} s`;
  }
  if (milliseconds < 3_600_000) {
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    return `${String(minutes)}m ${String(seconds)}s`;
  }
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  return `${String(hours)}h ${String(minutes)}m`;
}

export function journeySpan(_startedAt: string, _lastEventAt: string): number | null {
  const started = Date.parse(_startedAt);
  const last = Date.parse(_lastEventAt);
  if (!Number.isFinite(started) || !Number.isFinite(last) || last < started) return null;
  return last - started;
}

export function presentTimelineTiming(events: readonly EventListItem[]): TimelineTiming[] {
  return events.map((event, index) => {
    const previous = events[index - 1];
    if (previous === undefined) {
      return { eventId: event.id, previousEventId: null, gapBefore: null, clockCaveat: null };
    }
    return {
      eventId: event.id,
      previousEventId: previous.id,
      gapBefore: gapBetween(previous, event),
      clockCaveat: clockCaveat(previous.recordedHost, event.recordedHost)
    };
  });
}

export function retryGroups(
  events: readonly EventListItem[],
  complete: boolean
): RetryGroupPresentation[] {
  const grouped = new Map<
    string,
    { service: string; name: string; retryGroup: string; events: EventListItem[] }
  >();
  for (const event of events) {
    const retryGroup = event.timingContext?.retryGroup;
    const attempt = event.timingContext?.attempt;
    if (retryGroup === undefined || attempt === undefined) continue;
    const key = JSON.stringify([event.service, event.name, retryGroup]);
    const group = grouped.get(key) ?? {
      service: event.service,
      name: event.name,
      retryGroup,
      events: []
    };
    group.events.push(event);
    grouped.set(key, group);
  }

  return [...grouped.values()].map((group) => presentRetryGroup(group, complete));
}

function gapBetween(previous: EventListItem, next: EventListItem): GapPresentation {
  const previousStart = Date.parse(previous.eventTimestamp);
  const nextStart = Date.parse(next.eventTimestamp);
  const label =
    previous.operation === "published" && next.operation === "consumed"
      ? "Publish → consume gap"
      : "Recorded gap";
  const startToStartMs =
    Number.isFinite(previousStart) && Number.isFinite(nextStart) ? nextStart - previousStart : null;
  if (previous.durationMs === null || startToStartMs === null) {
    return { kind: "unknown", startToStartMs, label };
  }
  const milliseconds = startToStartMs - previous.durationMs;
  return milliseconds < 0
    ? { kind: "overlap", milliseconds, label }
    : { kind: "gap", milliseconds, label };
}

function clockCaveat(
  previous: string | null | undefined,
  next: string | null | undefined
): string | null {
  if (previous === undefined || previous === null || next === undefined || next === null) {
    return "Clock comparison is uncertain because recorded host evidence is missing.";
  }
  return previous === next
    ? null
    : "Clock comparison is uncertain because these events came from different recorded hosts.";
}

function presentRetryGroup(
  group: { service: string; name: string; retryGroup: string; events: EventListItem[] },
  complete: boolean
): RetryGroupPresentation {
  const byAttempt = new Map<number, EventListItem[]>();
  for (const event of group.events) {
    const number = event.timingContext?.attempt;
    if (number === undefined) continue;
    const same = byAttempt.get(number) ?? [];
    same.push(event);
    byAttempt.set(number, same);
  }

  const issues: string[] = [];
  const numbers = [...byAttempt.keys()].sort((a, b) => a - b);
  for (const number of numbers) {
    if ((byAttempt.get(number)?.length ?? 0) > 1) {
      issues.push(`Attempt ${String(number)} is duplicated in the loaded events.`);
    }
  }
  const first = numbers[0];
  const last = numbers.at(-1);
  if (first !== undefined && last !== undefined) {
    for (let number = first; number <= last; number += 1) {
      if (!byAttempt.has(number)) {
        issues.push(`Attempt ${String(number)} is missing from the loaded events.`);
      }
    }
  }

  const attempts = group.events.map((event): RetryAttemptPresentation => {
    const number = event.timingContext?.attempt ?? 0;
    let delayMs: number | null = null;
    const previous = byAttempt.get(number - 1);
    const current = byAttempt.get(number);
    if (number > 1 && previous?.length === 1 && current?.length === 1) {
      const previousEvent = previous[0];
      if (previousEvent !== undefined) {
        if (previousEvent.durationMs === null) {
          issues.push(
            `Observed retry delay is unknown because attempt ${String(number - 1)} has no duration.`
          );
        } else {
          const start = Date.parse(event.eventTimestamp);
          const previousStart = Date.parse(previousEvent.eventTimestamp);
          if (!Number.isFinite(start) || !Number.isFinite(previousStart)) {
            issues.push(
              `Observed retry delay for attempt ${String(number)} is unknown because a timestamp is invalid.`
            );
          } else {
            const observed = start - previousStart - previousEvent.durationMs;
            if (observed < 0) {
              issues.push(
                `Attempt ${String(number)} overlaps attempt ${String(number - 1)} or their clocks disagree; no retry delay is claimed.`
              );
            } else {
              delayMs = observed;
            }
          }
        }
      }
    }
    return {
      eventId: event.id,
      number,
      outcome: event.hasError || event.operation === "failed" ? "failed" : "succeeded",
      delayMs
    };
  });

  if (!complete) issues.push("Only loaded events are included; later attempts may exist.");
  return {
    service: group.service,
    name: group.name,
    retryGroup: group.retryGroup,
    attempts,
    issues: [...new Set(issues)]
  };
}
