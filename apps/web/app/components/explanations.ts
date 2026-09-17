/**
 * Plain-language explanations of the four terms a new reader meets first,
 * shown in place as muted helper text.
 *
 * Kept together so the wording is reviewed and changed in one place. Each one
 * restates the definition in `docs/GLOSSARY.md` for someone who has not read
 * it; change the glossary first and this to match, never the other way round,
 * so the two cannot drift apart.
 *
 * Where each appears:
 * - `journey`: under the journey page's heading (`JourneyHeading`).
 * - `alias`: after a journey's "Also known as" line (`AliasList`).
 * - `transformation`: under an event's "What changed" heading (`EventDetail`).
 * - `replay`: under an event's "Replay this input" link (`EventDetail`).
 */
export const EXPLANATIONS = {
  /** GLOSSARY.md, Journey. */
  journey:
    "A journey is the complete recorded history of one record or workflow instance, across every service, queue, and retry that handled it.",
  /** GLOSSARY.md, Alias. */
  alias:
    "An alias is another identifier for the same record, such as its ID in a CRM or in another internal system.",
  /** GLOSSARY.md, Transformation. */
  transformation:
    "A step that changes the shape or values of data on purpose is a transformation, so some differences are expected. Look for the one that should not be there.",
  /** GLOSSARY.md, Replay and Replay destination. */
  replay:
    "A replay sends this step's recorded input again, to an approved local, development, or test destination, so you can check a fix against it. Nothing is sent until you review it on the next page."
} as const;
