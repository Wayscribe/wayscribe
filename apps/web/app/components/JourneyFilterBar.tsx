import type { ReactElement } from "react";
import {
  JOURNEY_PRESETS,
  JOURNEY_STATUSES,
  type JourneyFilters
} from "../../src/lib/journey-filters";

/**
 * The Journeys page's filters: a plain GET form rendered on the server.
 *
 * No client state, so it works without JavaScript and a filtered view is a URL
 * someone can paste. Not the timeline's `FilterBar`, which toggles filters in
 * the browser: this one only ever submits.
 *
 * The custom range uses `datetime-local` inputs, which carry no time zone.
 * They are read as UTC, like every time the app shows, and the group says so.
 */
export function JourneyFilterBar({
  filters,
  environments
}: {
  filters: JourneyFilters;
  environments: readonly string[];
}): ReactElement {
  // A shared URL can name an environment this project no longer lists; keep it
  // selectable so the form reflects the list it produced.
  const environmentOptions =
    filters.environment === "" || environments.includes(filters.environment)
      ? environments
      : [...environments, filters.environment];

  return (
    // Keyed on what the fields show. Next keeps this form mounted across a
    // client-side navigation, such as the Failures shortcut, and an
    // uncontrolled field ignores a new defaultValue, so the form showed the
    // old filters over the new list. A new key rebuilds it.
    <form
      key={JSON.stringify(filters)}
      method="get"
      action="/journeys"
      className="journey-filters"
      role="search"
      aria-label="Filter journeys"
    >
      {/* Labels name their control by id rather than by wrapping it: a label
          wrapped around a select also takes in the options' text, so a
          browser named the Status select "Status any failed active
          completed". */}
      <div className="field field-contains">
        <label htmlFor="journeys-q" className="label">
          Contains
        </label>
        <input
          id="journeys-q"
          name="q"
          type="search"
          defaultValue={filters.q}
          minLength={2}
          maxLength={200}
          placeholder="Part of a label or displayable alias"
        />
      </div>
      <div className="field">
        <label htmlFor="journeys-window" className="label">
          Time
        </label>
        <select id="journeys-window" name="window" defaultValue={filters.window}>
          {Object.entries(JOURNEY_PRESETS).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          <option value="custom">custom range</option>
        </select>
      </div>
      <fieldset className="range" aria-describedby="journeys-range-hint">
        <legend className="label">Custom range, UTC</legend>
        <label htmlFor="journeys-since" className="visually-hidden">
          From
        </label>
        <input
          id="journeys-since"
          name="since"
          type="datetime-local"
          defaultValue={filters.sinceInput}
        />
        <span aria-hidden="true">to</span>
        <label htmlFor="journeys-until" className="visually-hidden">
          To
        </label>
        <input
          id="journeys-until"
          name="until"
          type="datetime-local"
          defaultValue={filters.untilInput}
        />
      </fieldset>
      <div className="field">
        <label htmlFor="journeys-status" className="label">
          Status
        </label>
        <select id="journeys-status" name="status" defaultValue={filters.status}>
          <option value="">any</option>
          {JOURNEY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="journeys-entity-type" className="label">
          Entity type
        </label>
        <input
          id="journeys-entity-type"
          name="entityType"
          defaultValue={filters.entityType}
          maxLength={128}
          placeholder="any"
        />
      </div>
      <div className="field">
        <label htmlFor="journeys-environment" className="label">
          Environment
        </label>
        <select id="journeys-environment" name="environment" defaultValue={filters.environment}>
          <option value="">all</option>
          {environmentOptions.map((environment) => (
            <option key={environment} value={environment}>
              {environment}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="journeys-service" className="label">
          Service
        </label>
        <input
          id="journeys-service"
          name="service"
          defaultValue={filters.service}
          placeholder="any"
        />
      </div>
      <button type="submit">Show</button>
      <p id="journeys-range-hint" className="muted hint">
        The range applies when Time is set to custom range; leave To empty for up to now.
      </p>
    </form>
  );
}
