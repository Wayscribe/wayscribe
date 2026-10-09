import type { ReactElement } from "react";
import type { JourneyDetail } from "../../src/lib/api";

/**
 * The journey page's heading. A journey with a label is named by it, with its
 * entity type and identifier beneath, as the Journeys page shows it; one
 * without is named by its entity, as search shows it. A label of only white
 * space names nothing and counts as none.
 *
 * What a journey is, for a reader who arrived from a link, is in the page's
 * "About this view" disclosure (`AboutJourneyView`), so the status line comes
 * straight after the heading.
 */
export function JourneyHeading({
  journey
}: {
  journey: Pick<JourneyDetail, "entity" | "label">;
}): ReactElement {
  const entity = `${journey.entity.type}: ${journey.entity.id ?? "—"}`;
  const label = journey.label?.trim() ?? "";
  return label === "" ? (
    <h1 className="mono">{entity}</h1>
  ) : (
    <>
      <h1 className="journey-label">{label}</h1>
      <p className="mono muted journey-entity">{entity}</p>
    </>
  );
}
