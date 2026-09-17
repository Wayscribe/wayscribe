import { Fragment } from "react";
import type { JourneyDetail } from "../../src/lib/api";
import { EXPLANATIONS } from "./explanations";

/**
 * The other identifiers a journey's record is known by.
 *
 * The API masks an alias unless the instrumenting code marked it displayable
 * in every event that stated it (ADR-053). A masked value looks like a value
 * with a piece missing, so it says so, rather than leaving a reader to wonder
 * whether `some…com` is what was recorded.
 */
export function AliasList({ aliases }: { aliases: JourneyDetail["aliases"] }) {
  if (aliases.length === 0) return null;
  return (
    <p className="muted aliases">
      Also known as{" "}
      {aliases.map((alias, index) => (
        <Fragment key={`${alias.type}-${String(index)}`}>
          {index === 0 ? "" : ", "}
          <span data-testid={`alias-${alias.type}`}>
            {alias.type} <span className="mono">{alias.displayValue ?? "—"}</span>
            {alias.displayable === true ? null : (
              <span
                className="masked"
                title="Masked: this identifier was not marked displayable when it was recorded."
              >
                {" "}
                (masked)
              </span>
            )}
          </span>
        </Fragment>
      ))}
      . {EXPLANATIONS.alias}
    </p>
  );
}
