import type { TimelineFilters } from "../../src/lib/timeline";

/**
 * Service chips, the failures toggle, and the live toggle.
 *
 * Buttons with `aria-pressed` rather than radio inputs: a chip row is a set of
 * toggles a reader taps, and a screen reader announces "pressed" for exactly
 * the state that matters.
 */
export function FilterBar({
  services,
  filters,
  onFilters,
  status,
  live,
  liveOffered,
  onLive,
  notice
}: {
  services: readonly string[];
  filters: TimelineFilters;
  onFilters: (filters: TimelineFilters) => void;
  status: string;
  live: boolean;
  /**
   * Whether the Live control is on offer even while unticked: a finished
   * journey that is still warm keeps it until live mode's quiet stop withdraws
   * it, so unticking it does not make it vanish under the reader's click.
   */
  liveOffered: boolean;
  onLive: (live: boolean) => void;
  /** Why live updates stopped, if they did. */
  notice: string | null;
}) {
  return (
    <div className="filters">
      <div className="chips" role="group" aria-label="Service">
        <button
          type="button"
          className={filters.service === null ? "chip on" : "chip"}
          aria-pressed={filters.service === null}
          onClick={() => {
            onFilters({ ...filters, service: null });
          }}
        >
          All services
        </button>
        {services.map((service) => (
          <button
            key={service}
            type="button"
            className={filters.service === service ? "chip on" : "chip"}
            aria-pressed={filters.service === service}
            onClick={() => {
              onFilters({ ...filters, service });
            }}
          >
            {service}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="View">
        <button
          type="button"
          className={filters.failuresOnly ? "chip on" : "chip"}
          aria-pressed={filters.failuresOnly}
          onClick={() => {
            onFilters({ ...filters, failuresOnly: !filters.failuresOnly });
          }}
        >
          Failures only
        </button>
        {/* `notice` too: it tells the reader to turn Live on to retry, and live
            is false by then on a journey whose status is already terminal. */}
        {status === "active" || live || liveOffered || notice !== null ? (
          <label className="chip">
            <input
              type="checkbox"
              checked={live}
              onChange={(change) => {
                onLive(change.target.checked);
              }}
            />{" "}
            Live
          </label>
        ) : null}
      </div>
      {notice === null ? null : (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
