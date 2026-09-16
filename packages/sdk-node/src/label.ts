import { toStorableText } from "@flight-recorder/payload-security/redaction";
// The subpath, not the package root: the root brings Zod, and the bundle
// would carry it into every host.
import { MAX_JOURNEY_LABEL_LENGTH } from "@flight-recorder/protocol/limits";
import { fitsCodePoints } from "./code-points.js";
import type { Diagnostics } from "./diagnostics.js";

/**
 * What ends a cut journey label. One code point, so a cut label keeps 199 of
 * the host's own. The payload marker, `[TRUNCATED: <n> characters removed]`,
 * would take a sixth of the label and say something no reader of a name needs.
 */
export const LABEL_ELLIPSIS = "…";

/**
 * The first `max` code points of `text`, which is longer than that. Sliced
 * where a code point ends, so a surrogate pair is never split.
 */
export function firstCodePoints(text: string, max: number): string {
  let units = 0;
  let count = 0;
  for (const codePoint of text) {
    if (count === max) break;
    units += codePoint.length;
    count += 1;
  }
  return text.slice(0, units);
}

/**
 * `text` as the server will accept it for `journeyLabel`, or undefined.
 *
 * Made storable first, as every payload string is: a NUL removed and a lone
 * surrogate replaced, so neither costs the event. What is left over the limit
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
  if (storable === "") {
    diagnostics.report({
      kind: "key_dropped",
      reason:
        "A journey label that is not a non-empty string was not set; later events carry the label set before it, if any.",
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
