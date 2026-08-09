/**
 * Timeline timestamps, rendered so they cannot be misread.
 *
 * The timeline printed `slice(11, 19)` — time of day, UTC, with no date and no
 * marker. Four events across midnight read `23:58:41` then `00:04:02`, so a
 * five-minute queue hop looked like a jump backwards of nearly a day, and a
 * journey spanning two and a half days was byte-identical to one spanning
 * eleven hours. `README.md` claims delay is visible in the timeline; it was
 * the one thing the timeline could not show.
 *
 * Rendered on the server, so `Intl` with an explicit UTC zone rather than the
 * viewer's locale: a server-rendered local time would be the *server's* local
 * time, which is a more convincing lie than UTC.
 */

const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC"
});

/** `14:32:07`. Pair with {@link dayLabel} when a journey spans more than one day. */
export function timeOfDay(iso: string): string {
  return TIME.format(new Date(iso));
}

/** `09 Aug`. */
export function dayLabel(iso: string): string {
  return DATE.format(new Date(iso));
}

/** `09 Aug 14:32:07 UTC` — unambiguous, for a tooltip or a detail line. */
export function fullTimestamp(iso: string): string {
  return `${dayLabel(iso)} ${timeOfDay(iso)} UTC`;
}

/** Whether these events fall on more than one UTC day. */
export function spansDays(timestamps: readonly string[]): boolean {
  const days = new Set(timestamps.map((iso) => iso.slice(0, 10)));
  return days.size > 1;
}

/**
 * How far a service's clock was from the server's, in seconds.
 *
 * `ARCHITECTURE.md` section 264 asks the interface to indicate when timestamps
 * appear inconsistent or arrive late, and nothing did. Ingestion latency puts a
 * second or two of honest distance here, so only a gap large enough to reorder
 * a timeline is worth showing.
 */
export function skewSeconds(eventTimestamp: string, receivedAt: string): number {
  return Math.round((new Date(receivedAt).getTime() - new Date(eventTimestamp).getTime()) / 1000);
}

/** The threshold past which skew is reported rather than ignored. */
export const SKEW_THRESHOLD_SECONDS = 120;
