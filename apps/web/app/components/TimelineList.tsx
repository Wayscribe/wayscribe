import { type KeyboardEvent, useEffect, useMemo } from "react";
import type { EventListItem } from "../../src/lib/api";
import {
  type JourneyClockCondition,
  type TimelineTiming,
  formatDuration,
  isSkewed
} from "../../src/lib/timing-presentation";
import { dayLabel, fullTimestamp, timeOfDay } from "../../src/lib/time";

const NO_JOURNEY_CLOCK: JourneyClockCondition = { caveat: null, allSkewed: false };

/** DOM id of a row, referenced by `aria-activedescendant` on the list. */
export const rowId = (eventId: string): string => `event-${eventId}`;

/**
 * The rows of the timeline: a listbox whose options are still links.
 *
 * Links, so a middle-click, a copied address, and the Playwright specs that
 * click them all keep working; the click is intercepted so the ordinary case
 * does not navigate. Arrow keys are handled on the list, not the document, so
 * typing in the search box elsewhere on the page is never hijacked.
 */
export function TimelineList({
  journeyId,
  events,
  timing = [],
  clock = NO_JOURNEY_CLOCK,
  selectedId,
  multiDay,
  onSelect,
  onArrow
}: {
  journeyId: string;
  events: readonly EventListItem[];
  /** Derived from the complete loaded unfiltered timeline before `events` is filtered. */
  timing?: readonly TimelineTiming[];
  /**
   * What holds for the whole journey, from `journeyClockCondition`: a row
   * leaves out a caveat or badge that is already stated once above it.
   */
  clock?: JourneyClockCondition;
  selectedId: string | null;
  multiDay: boolean;
  onSelect: (id: string) => void;
  onArrow: (direction: "up" | "down") => void;
}) {
  const timingById = useMemo(() => new Map(timing.map((item) => [item.eventId, item])), [timing]);
  // `aria-activedescendant` moves the selection without moving focus, and
  // nothing scrolls on its own, so a row walked to with the arrow keys can sit
  // outside the list's own scroll box. No "use client" here: the only parent is
  // one, which puts this whole file in the client graph.
  useEffect(() => {
    if (selectedId === null) return;
    const row = document.getElementById(rowId(selectedId));
    // The row may be filtered out; and jsdom implements no layout, so the
    // method TypeScript promises is there is missing at runtime under test.
    // (`?.scrollIntoView?.()` says this more briefly but trips
    // no-unnecessary-condition, which trusts the DOM lib types.)
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const onKeyDown = (keyboard: KeyboardEvent<HTMLOListElement>) => {
    if (keyboard.key === "ArrowDown" || keyboard.key === "ArrowUp") {
      keyboard.preventDefault();
      onArrow(keyboard.key === "ArrowDown" ? "down" : "up");
    }
  };

  return (
    <ol
      className="timeline"
      role="listbox"
      tabIndex={0}
      aria-label="Events"
      aria-activedescendant={
        selectedId !== null && events.some((event) => event.id === selectedId)
          ? rowId(selectedId)
          : undefined
      }
      onKeyDown={onKeyDown}
    >
      {events.map((event) => {
        const evidence = timingById.get(event.id);
        const failed = event.hasError || event.operation === "failed";
        return (
          <li
            key={event.id}
            id={rowId(event.id)}
            role="option"
            aria-selected={event.id === selectedId}
            className={event.id === selectedId ? "active" : undefined}
          >
            {evidence?.gapBefore == null ? null : (
              <div className="timeline-gap">
                <span>{gapText(evidence.gapBefore)}</span>
                {evidence.gapBefore.qualification === undefined ? null : (
                  <span className="muted gap-qualification">
                    {evidence.gapBefore.qualification}
                  </span>
                )}
                {/* A caveat the whole journey shares is stated once above the
                  timeline; a row repeats it only when its own differs. */}
                {evidence.clockCaveat === null || evidence.clockCaveat === clock.caveat ? null : (
                  <span className="muted clock-caveat">{evidence.clockCaveat}</span>
                )}
              </div>
            )}
            <a
              href={`/journeys/${encodeURIComponent(journeyId)}?event=${encodeURIComponent(event.id)}`}
              tabIndex={-1}
              onClick={(click) => {
                if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
                click.preventDefault();
                onSelect(event.id);
              }}
            >
              <span className="mono time" title={fullTimestamp(event.eventTimestamp)}>
                {multiDay ? `${dayLabel(event.eventTimestamp)} ` : ""}
                {timeOfDay(event.eventTimestamp)}
              </span>
              {/* The step's own name leads, and whole: it wraps rather than
                being cut, because the name is what a reader came to read. A
                long journey is mostly one operation, so rows labelled by it
                would all read the same. An event with no name falls back to
                its operation, shown once. */}
              <span
                className={event.name === "" && failed ? "step failed" : "step"}
                title={event.name === "" ? undefined : event.name}
              >
                {event.name === "" ? event.operation : event.name}
              </span>
              {/* The second line: what kind of step, where it ran, and
                anything that singles this row out. */}
              <span className="row-meta">
                {event.name === "" ? null : (
                  <span
                    className={failed ? "op failed" : "op"}
                    title={`operation: ${event.operation}`}
                  >
                    {event.operation}
                  </span>
                )}
                <span className="muted service">{event.service}</span>
                {event.timingContext?.attempt === undefined ? null : (
                  <span className="muted attempt">attempt {event.timingContext.attempt}</span>
                )}
                {/* The build, beside the service it ran in (F-043): a journey
                  recorded by one build reads the same label down the list. */}
                {event.build == null ? null : (
                  <span className="muted mono build" title={event.build.title}>
                    {event.build.label}
                  </span>
                )}
                {/* Only when it singles this row out: a journey whose every
                  event arrived late says so once, above the timeline. */}
                {!clock.allSkewed && isSkewed(event) ? (
                  <span
                    className="clock-badge"
                    title={`Recorded at ${fullTimestamp(event.eventTimestamp)}, received at ${fullTimestamp(event.receivedAt)}. Received more than two minutes late: this service's clock may be behind, which would put the timeline out of order, or the event waited to be sent, or the step ran long.`}
                  >
                    ⚠ clock
                  </span>
                ) : null}
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

function gapText(gap: TimelineTiming["gapBefore"]): string {
  if (gap === null) return "";
  if (gap.kind === "overlap") {
    return `${gap.label}: ${formatDuration(Math.abs(gap.milliseconds))} overlap / clock disagreement`;
  }
  if (gap.kind === "unknown") {
    if (gap.startToStartMs === null) return `${gap.label}: unknown`;
    return gap.startToStartMs < 0
      ? `${gap.label}: unknown (start-to-start ${formatDuration(Math.abs(gap.startToStartMs))} overlap / clock disagreement)`
      : `${gap.label}: unknown (start-to-start ${formatDuration(gap.startToStartMs)})`;
  }
  return `${gap.label}: ${formatDuration(gap.milliseconds)}`;
}
