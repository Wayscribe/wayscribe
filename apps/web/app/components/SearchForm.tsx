import type { ReactElement } from "react";
import { JOURNEY_PRESETS } from "../../src/lib/journey-filters";
import type { SearchFilters } from "../../src/lib/search-filters";
import { PendingForm, PendingSubmit } from "./PendingForm";

/**
 * The Search page's form: the identifier, and a time window and environment to
 * narrow it by (F-036). A plain GET form rendered on the server, like the
 * Journeys page's, so it works without JavaScript and a narrowed search is a
 * URL someone can paste; `PendingForm` only adds a status line once it is
 * sent, when JavaScript is there to show it.
 *
 * Time starts on "any time", not the Journeys page's 24 hours: without a
 * window the API searches the whole history, which is what a person with an
 * identifier in hand usually wants. The custom range is read as UTC, like
 * every time the app shows.
 */
export function SearchForm({
  filters,
  environments
}: {
  filters: SearchFilters;
  environments: readonly string[];
}): ReactElement {
  const environmentOptions =
    filters.environment === "" || environments.includes(filters.environment)
      ? environments
      : [...environments, filters.environment];

  return (
    // Keyed on what the fields show, for the reason JourneyFilterBar gives: an
    // uncontrolled field ignores a new defaultValue after a client navigation.
    <PendingForm
      key={JSON.stringify(filters)}
      method="get"
      action="/"
      className="search-form"
      role="search"
      aria-label="Find a record"
      pendingMessage="Searching…"
    >
      <div className="search-row">
        <input name="q" defaultValue={filters.q} placeholder="0018Z00002ABC" aria-label="Search" />
        <PendingSubmit>Search</PendingSubmit>
      </div>
      <div className="journey-filters search-narrowing">
        <div className="field">
          <label htmlFor="search-window" className="label">
            Time
          </label>
          <select id="search-window" name="window" defaultValue={filters.window}>
            <option value="">any time</option>
            {Object.entries(JOURNEY_PRESETS).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="custom">custom range</option>
          </select>
        </div>
        <fieldset className="range" aria-describedby="search-range-hint">
          <legend className="label">Custom range, UTC</legend>
          <label htmlFor="search-since" className="visually-hidden">
            From
          </label>
          <input
            id="search-since"
            name="since"
            type="datetime-local"
            defaultValue={filters.sinceInput}
          />
          <span aria-hidden="true">to</span>
          <label htmlFor="search-until" className="visually-hidden">
            To
          </label>
          <input
            id="search-until"
            name="until"
            type="datetime-local"
            defaultValue={filters.untilInput}
          />
        </fieldset>
        <div className="field">
          <label htmlFor="search-environment" className="label">
            Environment
          </label>
          <select id="search-environment" name="environment" defaultValue={filters.environment}>
            <option value="">all</option>
            {environmentOptions.map((environment) => (
              <option key={environment} value={environment}>
                {environment}
              </option>
            ))}
          </select>
        </div>
        <p id="search-range-hint" className="muted hint">
          Time is a journey&apos;s last activity. The range applies when Time is set to custom
          range; leave To empty for up to now.
        </p>
      </div>
    </PendingForm>
  );
}
