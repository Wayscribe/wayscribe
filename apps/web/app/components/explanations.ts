/**
 * Plain-language explanations of the terms a new reader meets first.
 *
 * Kept together so the wording is reviewed and changed in one place. Each one
 * restates the definition in `docs/GLOSSARY.md` for someone who has not read
 * it; change the glossary first and this to match, never the other way round,
 * so the two cannot drift apart.
 *
 * Where each appears:
 * - `journey`, `alias`, `clockComparison`: in the journey page's "About this
 *   view" disclosure (`AboutJourneyView`), each beside a link to its glossary
 *   entry, rather than as text standing between the heading and the timeline.
 * - `transformation`: under an event's "What changed" heading (`EventDetail`).
 * - `replay`: under an event's "Replay this input" link (`EventDetail`).
 *
 * The recorded span's explanation stays with its value in
 * `JourneyTimingSummary`, which the same disclosure shows.
 */
export const EXPLANATIONS = {
  /** GLOSSARY.md, Journey. */
  journey:
    "A journey is the complete recorded history of one record or workflow instance, across every service, queue, and retry that handled it.",
  /** GLOSSARY.md, Alias. */
  alias:
    "An alias is another identifier for the same record, such as its ID in a CRM or in another internal system.",
  /** GLOSSARY.md, Clock comparison. */
  clockComparison:
    "Each service stamps its events with its own clock, so a gap between steps is uncertain when the events came from different recorded hosts or the host was not recorded. An event received more than two minutes after its recorded time may mean that service's clock is behind, that the event waited to be sent, or that the step ran long.",
  /** GLOSSARY.md, Transformation. */
  transformation:
    "A step that changes the shape or values of data on purpose is a transformation, so some differences are expected. Look for the one that should not be there.",
  /** GLOSSARY.md, Replay and Replay destination. */
  replay:
    "A replay sends this step's recorded input again, to an approved local, development, or test destination, so you can check a fix against it. Nothing is sent until you review it on the next page."
} as const;
