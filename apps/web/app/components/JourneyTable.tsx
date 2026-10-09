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
  items,
  listQuery = ""
}: {
  filters: JourneyFilters;
  items: readonly JourneyListRow[];
  /** This page's query string, for the rows' way back. */
  listQuery?: string;
}): ReactElement {
  const showEnvironment = filters.environment === "";
  return (
    // The roles are explicit because a phone lays each row out as a card
    // (globals.css), and a table whose rows are restyled with `display` loses
    // its table semantics in some browsers. Stated here, a screen reader keeps
    // reading rows and column headers at every width.
    <table className="journey-table" role="table">
      <caption className="journeys-summary">{describeJourneyFilters(filters)}</caption>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader" className="col-activity" title="Last activity">
            Last activity
          </th>
          <th
            scope="col"
            role="columnheader"
            className="col-span"
            title="Time from first recorded event start to last recorded event start"
          >
            Recorded span
          </th>
          <th scope="col" role="columnheader" className="col-status">
            Status
          </th>
          {showEnvironment ? (
            <th scope="col" role="columnheader" className="col-environment">
              Environment
            </th>
          ) : null}
          <th scope="col" role="columnheader" className="col-type">
            Entity type
          </th>
          <th scope="col" role="columnheader" className="col-shown">
            Shown as
          </th>
          <th scope="col" role="columnheader" className="col-step">
            Step
          </th>
          <th scope="col" role="columnheader" className="col-events" title="Events">
            Events
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {items.map((item) => (
          <JourneyRow
            key={item.journeyId}
            item={item}
            showEnvironment={showEnvironment}
            listQuery={listQuery}
          />
        ))}
      </tbody>
    </table>
  );
}
