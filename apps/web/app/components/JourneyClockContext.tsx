"use client";

import { createContext, type ReactElement, useContext } from "react";
import { HOSTLESS_CLOCK_NOTE } from "../../src/lib/timing-presentation";

/**
 * Whether the journey's loaded events record no host at all (`hostless` in
 * `journeyClockCondition`), provided by `JourneyTimeline` around the page's
 * own children so the server-rendered "About this view" disclosure follows the
 * same events the timeline does, polling included.
 */
export const HostlessJourneyContext = createContext(false);

/**
 * The neutral sentence that replaces a journey-wide warning when the only
 * reason for it is that no event records a host, the Node SDK's normal
 * condition (ADR-071). Renders nothing otherwise.
 */
export function HostlessClockNote(): ReactElement | null {
  const hostless = useContext(HostlessJourneyContext);
  return hostless ? <span className="hostless-clock-note"> {HOSTLESS_CLOCK_NOTE}</span> : null;
}
