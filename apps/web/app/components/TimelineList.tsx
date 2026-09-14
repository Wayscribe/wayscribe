import type { KeyboardEvent } from "react";
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
      aria-activedescendant={selectedId === null ? undefined : rowId(selectedId)}
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
            href={`/journeys/${journeyId}?event=${event.id}`}
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
            <span className={event.hasError ? "op failed" : "op"}>{event.operation}</span>
            <span className="muted">{event.service}</span>
            {skewSeconds(event.eventTimestamp, event.receivedAt) > SKEW_THRESHOLD_SECONDS ? (
              <span
                className="muted"
                title={`Recorded at ${fullTimestamp(event.eventTimestamp)}, received at ${fullTimestamp(event.receivedAt)}. This service's clock may be wrong, which would put the timeline out of order.`}
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
