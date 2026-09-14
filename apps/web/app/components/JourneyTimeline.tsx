"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventDetailData, EventListItem, EventsPageResponse } from "../../src/lib/api";
import { spansDays } from "../../src/lib/time";
import {
  NO_FILTERS,
  applyFilters,
  describeCount,
  distinctServices,
  mergeEvents,
  neighbour,
  type TimelineFilters
} from "../../src/lib/timeline";
import { EventDetail } from "./EventDetail";
import { FilterBar } from "./FilterBar";
import { TimelineList } from "./TimelineList";

export interface JourneyTimelineProps {
  journeyId: string;
  initialStatus: string;
  initialEvents: EventListItem[];
  initialCursor: string | null;
  initialSelectedId: string | null;
  initialDetail: EventDetailData | null;
  totalEvents: number;
  /** The journey's services from the server, which may include ones not yet loaded. */
  knownServices: string[];
}

const POLL_MS = 2000;
const MAX_POLL_FAILURES = 3;
const POLL_NOTICE = "Live updates stopped after three failed requests. Turn Live on to retry.";
const PERMANENT_NOTICE =
  "Live updates stopped: this session can no longer read the journey. Sign in again or choose a project.";
const DETAIL_ERROR = "Could not load this event. Select it again to retry.";
const LOAD_ERROR = "Could not load more events. Try again.";

/**
 * Everything below the journey heading: the count line, the filters, the
 * timeline, and the selected event's detail.
 *
 * The server renders the first paint with the same data this receives as
 * props, so what a reader sees before hydration is exactly the old page. After
 * hydration every change comes from one of four places: a selection, a filter,
 * a load-more, or a poll. Each one merges or replaces; nothing else touches
 * state.
 */
export function JourneyTimeline(props: JourneyTimelineProps) {
  const { journeyId } = props;
  const [events, setEvents] = useState(props.initialEvents);
  const [cursor, setCursor] = useState(props.initialCursor);
  const [status, setStatus] = useState(props.initialStatus);
  const [total, setTotal] = useState(props.totalEvents);
  const [filters, setFilters] = useState<TimelineFilters>(NO_FILTERS);
  const [selectedId, setSelectedId] = useState(props.initialSelectedId);
  const [detail, setDetail] = useState(props.initialDetail);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [live, setLive] = useState(props.initialStatus === "active");
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The id most recently asked for. A slower response for an earlier selection
  // must not overwrite the detail of a later one.
  const wanted = useRef(props.initialSelectedId);
  const pollFailures = useRef(0);
  // Where live mode reads from. The API's `nextCursor` is a "more pages exist"
  // flag, null on a partial page, so it cannot be the poll position: after the
  // tail of a long journey it would send the poller back to page one. Live mode
  // keeps the last cursor it was given and re-reads the tail from there, merging
  // idempotently; when the tail grows past a page, the new cursor advances it.
  // Under a hundred events there is no cursor, and page one is the tail. A long
  // journey that is still active backfills a page per tick rather than jumping
  // to the newest event; the count line says how far along that is.
  const pollFrom = useRef(props.initialCursor);
  // A poll slower than the interval must not overlap the next one: two
  // responses landing out of order would move the cursor back a page.
  const polling = useRef(false);

  const visible = useMemo(() => applyFilters(events, filters), [events, filters]);
  // From the merged list, not a server prop: a journey whose first page fell on
  // one day can cross midnight on the second.
  const multiDay = useMemo(() => spansDays(events.map((event) => event.eventTimestamp)), [events]);
  const services = useMemo(
    () => [...new Set([...props.knownServices, ...distinctServices(events)])],
    [props.knownServices, events]
  );

  const select = useCallback(
    async (id: string) => {
      wanted.current = id;
      setSelectedId(id);
      window.history.replaceState(null, "", `/journeys/${journeyId}?event=${id}`);
      setDetailState("loading");
      const result = await fetchJson<EventDetailData>(`/api/events/${encodeURIComponent(id)}`);
      if (wanted.current !== id) return;
      if (result.kind === "failed") {
        setDetailState("error");
        return;
      }
      setDetail(result.body);
      setDetailState("idle");
    },
    [journeyId]
  );

  // A filter that hides the selected event moves the selection to the first
  // visible one, so the detail panel never shows something the list does not.
  useEffect(() => {
    const first = visible[0];
    if (first === undefined) return;
    if (!visible.some((event) => event.id === selectedId)) void select(first.id);
  }, [visible, selectedId, select]);

  const onArrow = (direction: "up" | "down") => {
    const id = neighbour(visible, selectedId, direction);
    if (id !== null && id !== selectedId) void select(id);
  };

  const applyPage = useCallback((page: EventsPageResponse) => {
    setEvents((previous) => mergeEvents(previous, page.items));
    setCursor(page.nextCursor);
    if (page.nextCursor !== null) pollFrom.current = page.nextCursor;
    setStatus(page.journeyStatus);
    setTotal(page.journeyEventCount);
  }, []);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadError(null);
    const result = await fetchJson<EventsPageResponse>(eventsUrl(journeyId, cursor));
    if (result.kind === "failed") {
      setLoadError(LOAD_ERROR);
      return;
    }
    applyPage(result.body);
  };

  // Live mode: re-read the tail from `pollFrom` every two seconds and merge.
  // A permanent refusal (signed out, no project) stops at once; anything else
  // counts toward the three failures, so a blip does not stop it and an outage
  // does not poll forever.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    const tick = async () => {
      if (polling.current) return;
      polling.current = true;
      let result: Fetched<EventsPageResponse>;
      try {
        result = await fetchJson<EventsPageResponse>(eventsUrl(journeyId, pollFrom.current));
      } finally {
        // fetchJson never throws today; the guard must still release if that changes.
        polling.current = false;
      }
      if (cancelled) return;
      if (result.kind === "failed") {
        pollFailures.current += 1;
        if (result.permanent || pollFailures.current >= MAX_POLL_FAILURES) {
          setLive(false);
          setPollNotice(result.permanent ? PERMANENT_NOTICE : POLL_NOTICE);
        }
        return;
      }
      pollFailures.current = 0;
      applyPage(result.body);
      if (result.body.journeyStatus !== "active") setLive(false);
    };

    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, journeyId, applyPage]);

  const onLive = (next: boolean) => {
    pollFailures.current = 0;
    setPollNotice(null);
    setLive(next);
  };

  const count = describeCount({
    visible: visible.length,
    loaded: events.length,
    total,
    complete: cursor === null
  });

  return (
    <>
      <p className="muted">
        {status} · {count} · {services.join(", ")}
      </p>
      <FilterBar
        services={services}
        filters={filters}
        onFilters={setFilters}
        status={status}
        live={live}
        onLive={onLive}
        notice={pollNotice}
      />
      <div className="journey">
        <div>
          <TimelineList
            journeyId={journeyId}
            events={visible}
            selectedId={selectedId}
            multiDay={multiDay}
            onSelect={(id) => {
              void select(id);
            }}
            onArrow={onArrow}
          />
          {cursor === null ? null : (
            <p>
              <button
                type="button"
                className="plain"
                onClick={() => {
                  void loadMore();
                }}
              >
                Show {Math.max(total - events.length, 1)} more
              </button>
            </p>
          )}
          {loadError === null ? null : <p className="error">{loadError}</p>}
        </div>
        <div className="detail">
          {detailState === "loading" ? <p className="muted">Loading…</p> : null}
          {detailState === "error" ? <p className="error">{DETAIL_ERROR}</p> : null}
          {detail === null ? (
            <p className="muted">This journey has no events yet.</p>
          ) : (
            <EventDetail event={detail} collapsibleDiff />
          )}
        </div>
      </div>
    </>
  );
}

function eventsUrl(journeyId: string, cursor: string | null): string {
  const base = `/api/journeys/${encodeURIComponent(journeyId)}/events`;
  return cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

type Fetched<T> =
  | { kind: "ok"; body: T }
  | {
      kind: "failed";
      /** A 401 or 409: retrying cannot help, so the caller should stop rather than count. */
      permanent: boolean;
    };

/** Never throws: a non-2xx, a network error, and a non-JSON body are all failures. */
async function fetchJson<T>(url: string): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return { kind: "failed", permanent: response.status === 401 || response.status === 409 };
    }
    return { kind: "ok", body: (await response.json()) as T };
  } catch {
    return { kind: "failed", permanent: false };
  }
}
