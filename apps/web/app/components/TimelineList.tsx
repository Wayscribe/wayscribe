import { type KeyboardEvent, useEffect } from "react";
import type { EventListItem } from "../../src/lib/api";
import {
  SKEW_THRESHOLD_SECONDS,
  dayLabel,
  fullTimestamp,
  skewSeconds,
  timeOfDay
} from "../../src/lib/time";

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
  selectedId,
  multiDay,
  onSelect,
  onArrow
}: {
  journeyId: string;
  events: readonly EventListItem[];
  selectedId: string | null;
  multiDay: boolean;
  onSelect: (id: string) => void;
  onArrow: (direction: "up" | "down") => void;
}) {
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
      {events.map((event) => (
        <li
          key={event.id}
          id={rowId(event.id)}
          role="option"
          aria-selected={event.id === selectedId}
          className={event.id === selectedId ? "active" : undefined}
        >
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
            {/* The step's own name leads: a long journey is mostly one
                operation, and rows labelled by it all read the same. An event
                with no name falls back to its operation, shown once. */}
            {event.name === "" ? (
              <span className={event.hasError ? "step failed" : "step"}>{event.operation}</span>
            ) : (
              <>
                <span className="step" title={event.name}>
                  {event.name}
                </span>
                <span
                  className={event.hasError ? "op failed" : "op"}
                  title={`operation: ${event.operation}`}
                >
                  {event.operation}
                </span>
              </>
            )}
            <span className="muted service">{event.service}</span>
            {skewSeconds(event.eventTimestamp, event.receivedAt) > SKEW_THRESHOLD_SECONDS ? (
              <span
                className="muted"
                title={`Recorded at ${fullTimestamp(event.eventTimestamp)}, received at ${fullTimestamp(event.receivedAt)}. Received more than two minutes late: this service's clock may be behind, which would put the timeline out of order, or the event waited to be sent, or the step ran long.`}
              >
                ⚠ clock
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ol>
  );
}
