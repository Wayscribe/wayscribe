import type { EventListItem } from "./api";

export type GapPresentation =
  | { kind: "gap"; milliseconds: number; label: string; qualification?: string }
  | { kind: "overlap"; milliseconds: number; label: string; qualification?: string }
  | { kind: "unknown"; startToStartMs: number | null; label: string; qualification?: string };

export interface TimelineTiming {
  eventId: string;
  previousEventId: string | null;
  gapBefore: GapPresentation | null;
  clockCaveat: string | null;
}

export interface RetryAttemptPresentation {
  eventId: string;
  number: number | null;
  outcome: "failed" | "succeeded";
  delayMs: number | null;
  delayClockCaveat: string | null;
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
    if (retryGroup === undefined) continue;
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
  const publishToConsume = previous.operation === "published" && next.operation === "consumed";
  const label = publishToConsume ? "Publish → consume gap" : "Recorded gap";
  const qualification = publishToConsume
    ? "Adjacent events do not prove a matching message; this is not broker-measured queue wait."
    : undefined;
  const startToStartMs =
    Number.isFinite(previousStart) && Number.isFinite(nextStart) ? nextStart - previousStart : null;
  if (previous.durationMs === null || startToStartMs === null) {
    return { kind: "unknown", startToStartMs, label, ...(qualification ? { qualification } : {}) };
  }
  const milliseconds = startToStartMs - previous.durationMs;
  return milliseconds < 0
    ? { kind: "overlap", milliseconds, label, ...(qualification ? { qualification } : {}) }
    : { kind: "gap", milliseconds, label, ...(qualification ? { qualification } : {}) };
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
  const unknownCount = group.events.length - [...byAttempt.values()].flat().length;
  if (unknownCount > 0) {
    issues.push(
      `${String(unknownCount)} loaded ${unknownCount === 1 ? "event has" : "events have"} no valid attempt number.`
    );
  }
  for (const number of numbers) {
    if ((byAttempt.get(number)?.length ?? 0) > 1) {
      issues.push(`Attempt ${String(number)} is duplicated in the loaded events.`);
    }
  }
  let expected = 1;
  for (const number of numbers) {
    if (number > expected) {
      issues.push(missingAttemptsIssue(expected, number - 1));
    }
    if (number < Number.MAX_SAFE_INTEGER) expected = number + 1;
  }

  const attempts = group.events.map((event): RetryAttemptPresentation => {
    const number = event.timingContext?.attempt ?? null;
    let delayMs: number | null = null;
    let delayClockCaveat: string | null = null;
    const previous = number === null ? undefined : byAttempt.get(number - 1);
    const current = number === null ? undefined : byAttempt.get(number);
    if (number !== null && number > 1 && previous?.length === 1 && current?.length === 1) {
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
              delayClockCaveat = retryDelayClockCaveat(
                previousEvent.recordedHost,
                event.recordedHost
              );
            }
          }
        }
      }
    }
    return {
      eventId: event.id,
      number,
      outcome: event.hasError || event.operation === "failed" ? "failed" : "succeeded",
      delayMs,
      delayClockCaveat
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

function missingAttemptsIssue(first: number, last: number): string {
  return first === last
    ? `Attempt ${String(first)} is missing from the loaded events.`
    : `Attempts ${String(first)}–${String(last)} are missing from the loaded events.`;
}

function retryDelayClockCaveat(
  previous: string | null | undefined,
  next: string | null | undefined
): string | null {
  if (previous === undefined || previous === null || next === undefined || next === null) {
    return "Clock comparison for this observed retry delay is uncertain because recorded host evidence is missing.";
  }
  return previous === next
    ? null
    : "Clock comparison for this observed retry delay is uncertain because the attempts came from different recorded hosts.";
}
