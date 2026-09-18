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
    <table className="journey-table">
      <caption className="journeys-summary">{describeJourneyFilters(filters)}</caption>
      <thead>
        <tr>
          <th scope="col" className="col-activity" title="Last activity">
            <HeaderLabel full="Last activity" short="When" />
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
            Step
          </th>
          <th scope="col" className="col-events" title="Events">
            <HeaderLabel full="Events" short="#" />
          </th>
        </tr>
      </thead>
      <tbody>
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

/**
 * A header with a shorter visible label for a phone, where its column is too
 * narrow for the full one. The full label stays in the accessibility tree
 * (visually hidden on a phone), and the short one is hidden from it, so a
 * screen reader hears "Last activity" at every width.
 */
function HeaderLabel({ full, short }: { full: string; short: string }): ReactElement {
  return (
    <>
      <span className="header-full">{full}</span>
      <span className="header-short" aria-hidden="true">
        {short}
      </span>
    </>
  );
}
