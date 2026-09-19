import Link from "next/link";
import type { ReactElement } from "react";
import type { JourneyListRow } from "../../src/lib/api";
import { failedStepOf } from "../../src/lib/failed-step";
import { journeyHref } from "../../src/lib/journey-filters";
import { fullTimestamp } from "../../src/lib/time";
import { formatDuration, journeySpan } from "../../src/lib/timing-presentation";
import { LinkPending } from "./LinkPending";

/**
 * How many characters of joined alias values a row keeps. A label is at most
 * 200 already; alias values are not capped that tightly, and a row only has
 * room for the start of them anyway.
 */
export const SHOWN_AS_LIMIT = 200;

export interface ShownAs {
  kind: "label" | "aliases" | "entity";
  text: string;
}

/**
 * What a journey is shown as in the list: the label its instrumenting code
 * set; otherwise its displayable alias values, in the alias-type order the API
 * returns them; otherwise its entity type and identifier, as search shows it.
 * The first two are public by declaration (ADR-053 and the label's contract);
 * the identifier is whatever the API chose to return for it.
 *
 * A label or alias value of only whitespace is valid on the wire but shows
 * nothing, and this text is the row's only link, so blank values are skipped
 * and the rest shown trimmed.
 */
export function shownAs(item: JourneyListRow): ShownAs {
  const label = item.label?.trim() ?? "";
  if (label !== "") return { kind: "label", text: label };
  const values = item.displayableAliases
    .map((alias) => alias.value.trim())
    .filter((value) => value !== "");
  if (values.length > 0) {
    return { kind: "aliases", text: cut(values.join(" · "), SHOWN_AS_LIMIT) };
  }
  return { kind: "entity", text: `${item.entity.type}: ${item.entity.id ?? "—"}` };
}

/**
 * One journey on the Journeys page: a table row, one line, every long value
 * cut with an ellipsis by the stylesheet (`.journey-table`) and given in full
 * as a title.
 */
export function JourneyRow({
  item,
  showEnvironment = false,
  listQuery = ""
}: {
  item: JourneyListRow;
  /** Whether the table has an Environment column: only when it spans environments. */
  showEnvironment?: boolean;
  /** The Journeys page's query string, carried so the journey page can lead back. */
  listQuery?: string;
}): ReactElement {
  const shown = shownAs(item);
  const shownClass =
    shown.kind === "label"
      ? "shown-label"
      : shown.kind === "aliases"
        ? "shown-aliases"
        : "shown-entity mono";
  const span = journeySpan(item.startedAt, item.lastEventAt);
  return (
    <tr>
      <td className="col-activity">
        <time dateTime={item.lastEventAt} title={fullTimestamp(item.lastEventAt)}>
          <span className="day">{item.lastEventAt.slice(0, 10)}</span>{" "}
          <span>{item.lastEventAt.slice(11, 16)}</span>
        </time>
      </td>
      <td
        className="col-span mono"
        title="Time from first recorded event start to last recorded event start"
      >
        {span === null ? "unknown" : formatDuration(span)}
      </td>
      <td className="col-status">
        <span className={item.status === "failed" ? "status failed" : "status"}>{item.status}</span>
      </td>
      {showEnvironment ? (
        <td className="col-environment" title={item.environment}>
          {item.environment}
        </td>
      ) : null}
      <td className="col-type" title={item.entity.type}>
        {item.entity.type}
      </td>
      <td className="col-shown">
        <Link
          href={journeyHref(item.journeyId, listQuery)}
          className={shownClass}
          title={shown.text}
        >
          <LinkPending />
          {shown.text}
        </Link>
      </td>
      <StepCell item={item} />
      <td className="col-events">{item.eventCount}</td>
    </tr>
  );
}

/**
 * The Step column (ADR-063, F-047): the step that failed a failed journey, in
 * the failed style, when the API names it; otherwise the last step, as before.
 * A failed journey's last step can be a later step that succeeded, so the
 * title gives both.
 */
function StepCell({ item }: { item: JourneyListRow }): ReactElement {
  const failedStep = failedStepOf(item);
  if (failedStep === null) {
    return (
      <td className="col-step" title={item.lastStep ?? undefined}>
        {item.lastStep ?? ""}
      </td>
    );
  }
  const title =
    item.lastStep === null
      ? `Failed at ${failedStep}`
      : `Failed at ${failedStep}; last step ${item.lastStep}`;
  return (
    <td className="col-step failed" title={title}>
      {failedStep}
    </td>
  );
}

/** At most `limit` code points, the last an ellipsis when anything was cut. */
function cut(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}
