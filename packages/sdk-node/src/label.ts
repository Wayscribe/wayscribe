import { toStorableText } from "@flight-recorder/payload-security/redaction";
// The subpath, not the package root: the root brings Zod, and the bundle
// would carry it into every host.
import { MAX_JOURNEY_LABEL_LENGTH } from "@flight-recorder/protocol/limits";
import { firstCodePoints, fitsCodePoints } from "./code-points.js";
import type { Diagnostics } from "./diagnostics.js";

/**
 * What ends a cut journey label. One code point, so a cut label keeps 199 of
 * the host's own. The payload marker, `[TRUNCATED: <n> characters removed]`,
 * would take a sixth of the label and say something no reader of a name needs.
 */
export const LABEL_ELLIPSIS = "…";

/**
 * `text` as the server will accept it for `journeyLabel`, or undefined.
 *
 * Made storable first, as every payload string is: a NUL removed and a lone
 * surrogate replaced, so neither costs the event. Empty, or only whitespace
 * (as `String.prototype.trim` defines it), is refused. What is left over the limit
 * is cut, with the protocol's own constant, so the SDK and the API cannot
 * disagree about the number. Anything that is not a string is refused unread:
 * converting it would run the host's own `toString`. Neither report quotes
 * the label, which is the host's text.
 *
 * Reported when the label is set, once, rather than on every event that
 * carries it. `charactersRemoved` counts UTF-16 code units, as it does for a
 * cut payload string, although the limit itself counts code points.
 */
export function acceptLabel(text: unknown, diagnostics: Diagnostics): string | undefined {
  const storable = typeof text === "string" ? toStorableText(text) : "";
  // A label of only whitespace is valid on the wire, but it names nothing and
  // shows as a blank, so it is dropped like an empty one. What is sent is the
  // host's text as given, surrounding whitespace included.
  if (storable.trim() === "") {
    diagnostics.report({
      kind: "key_dropped",
      reason:
        "A journey label that is not a string with visible text was not set; later events carry the label set before it, if any.",
      detail: { field: "journeyLabel", keys: 1 }
    });
    return undefined;
  }
  if (fitsCodePoints(storable, MAX_JOURNEY_LABEL_LENGTH)) return storable;
  const kept = firstCodePoints(storable, MAX_JOURNEY_LABEL_LENGTH - 1);
  const removed = storable.length - kept.length;
  diagnostics.report({
    kind: "payload_truncated",
    reason: `A journey label was cut to ${String(MAX_JOURNEY_LABEL_LENGTH)} code points, ending in an ellipsis; ${String(removed)} UTF-16 code units were removed.`,
    detail: { field: "journeyLabel", strings: 1, charactersRemoved: removed }
  });
  return kept + LABEL_ELLIPSIS;
}
