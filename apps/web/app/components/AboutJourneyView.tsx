import type { ReactElement } from "react";
import { EXPLANATIONS } from "./explanations";
import { JourneyTimingSummary } from "./JourneyTimingSummary";
import { GLOSSARY_URL } from "./SiteNav";

/**
 * The journey page's definitions, behind one native disclosure.
 *
 * They used to stand between the heading and the timeline, so a reader met a
 * paragraph per term before the first step. Nothing is dropped: each term is
 * defined here, with a link to its glossary entry, and the recorded span keeps
 * its value beside its explanation. A `<details>` opens without JavaScript.
 *
 * The anchors are GitLab's for a `##` heading: lower case, spaces to hyphens.
 */
export function AboutJourneyView({
  startedAt,
  lastEventAt,
  hasAliases
}: {
  startedAt: string;
  lastEventAt: string;
  /** The alias definition is shown only when the page lists aliases. */
  hasAliases: boolean;
}): ReactElement {
  return (
    <details className="about-view">
      <summary>About this view</summary>
      <dl>
        <dt>
          <a href={`${GLOSSARY_URL}#journey`}>Journey</a>
        </dt>
        <dd>{EXPLANATIONS.journey}</dd>
        {hasAliases ? (
          <>
            <dt>
              <a href={`${GLOSSARY_URL}#alias`}>Alias</a>
            </dt>
            <dd>{EXPLANATIONS.alias}</dd>
          </>
        ) : null}
        <dt>
          <a href={`${GLOSSARY_URL}#recorded-span`}>Recorded span</a>
        </dt>
        <dd>
          <JourneyTimingSummary startedAt={startedAt} lastEventAt={lastEventAt} />
        </dd>
        <dt>Times</dt>
        <dd>All times UTC. A row&apos;s time shows the full timestamp on hover.</dd>
        <dt>
          <a href={`${GLOSSARY_URL}#clock-comparison`}>Clock comparison</a>
        </dt>
        <dd>{EXPLANATIONS.clockComparison}</dd>
      </dl>
    </details>
  );
}
