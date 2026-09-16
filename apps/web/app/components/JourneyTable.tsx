import type { ReactElement } from "react";
import type { JourneyListRow } from "../../src/lib/api";
import { describeJourneyFilters, type JourneyFilters } from "../../src/lib/journey-filters";
import { JourneyRow } from "./JourneyRow";

/**
 * The Journeys page's table: one line per journey, named by a caption that
 * states the filters.
 *
 * The Environment column appears only when the list spans environments. With
 * one chosen, every row would repeat it, and the caption already names it.
 */
export function JourneyTable({
  filters,
  items
}: {
  filters: JourneyFilters;
  items: readonly JourneyListRow[];
}): ReactElement {
  const showEnvironment = filters.environment === "";
  return (
    <table className="journey-table">
      <caption className="journeys-summary">{describeJourneyFilters(filters)}</caption>
      <thead>
        <tr>
          <th scope="col" className="col-activity">
            Last activity
          </th>
          <th scope="col" className="col-status">
            Status
          </th>
          {showEnvironment ? (
            <th scope="col" className="col-environment">
              Environment
            </th>
          ) : null}
          <th scope="col" className="col-type">
            Entity type
          </th>
          <th scope="col" className="col-shown">
            Shown as
          </th>
          <th scope="col" className="col-step">
            Last step
          </th>
          <th scope="col" className="col-events">
            Events
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <JourneyRow key={item.journeyId} item={item} showEnvironment={showEnvironment} />
        ))}
      </tbody>
    </table>
  );
}
