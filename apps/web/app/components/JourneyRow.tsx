import Link from "next/link";
import type { ReactElement } from "react";
import type { JourneyListRow } from "../../src/lib/api";
import { fullTimestamp } from "../../src/lib/time";

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
 */
export function shownAs(item: JourneyListRow): ShownAs {
  if (item.label !== null && item.label !== "") return { kind: "label", text: item.label };
  if (item.displayableAliases.length > 0) {
    const joined = item.displayableAliases.map((alias) => alias.value).join(" · ");
    return { kind: "aliases", text: cut(joined, SHOWN_AS_LIMIT) };
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
  showEnvironment = false
}: {
  item: JourneyListRow;
  /** Whether the table has an Environment column: only when it spans environments. */
  showEnvironment?: boolean;
}): ReactElement {
  const shown = shownAs(item);
  const shownClass =
    shown.kind === "label"
      ? "shown-label"
      : shown.kind === "aliases"
        ? "shown-aliases"
        : "shown-entity mono";
  return (
    <tr>
      <td className="col-activity">
        <time dateTime={item.lastEventAt} title={fullTimestamp(item.lastEventAt)}>
          <span className="day">{item.lastEventAt.slice(0, 10)}</span>{" "}
          <span>{item.lastEventAt.slice(11, 16)}</span>
        </time>
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
          href={`/journeys/${encodeURIComponent(item.journeyId)}`}
          className={shownClass}
          title={shown.text}
        >
          {shown.text}
        </Link>
      </td>
      <td className="col-step" title={item.lastStep ?? undefined}>
        {item.lastStep ?? ""}
      </td>
      <td className="col-events">{item.eventCount}</td>
    </tr>
  );
}

/** At most `limit` code points, the last an ellipsis when anything was cut. */
function cut(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}
