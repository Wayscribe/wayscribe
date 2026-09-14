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
  onLive,
  notice
}: {
  services: readonly string[];
  filters: TimelineFilters;
  onFilters: (filters: TimelineFilters) => void;
  status: string;
  live: boolean;
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
        {status === "active" || live ? (
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
