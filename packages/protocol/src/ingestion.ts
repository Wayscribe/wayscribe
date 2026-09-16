import { z } from "zod";
import { JOURNEY_OPERATIONS } from "./event.js";

/**
 * The most events one batch request may carry.
 *
 * Fixed rather than configurable, and held here rather than in the API,
 * because it is part of the wire contract: a client has to know it to split a
 * queue into requests. The route enforces it and the body limit is derived from
 * it, and both used to hold a copy of the number.
 */
export const MAX_BATCH_EVENTS = 100;

/**
 * The body of `POST /v1/events/batch`.
 *
 * `events` is an array of anything, not an array of envelopes, deliberately.
 * The route accepts a batch containing an invalid event and refuses that event
 * alone, per position, so a schema that rejected the whole request would
 * describe a server that does not exist.
 */
export const batchRequestSchema = z.object({
  events: z
    .array(z.unknown())
    .max(MAX_BATCH_EVENTS)
    .describe(
      "The events to ingest, at most 100. Each element is one envelope. Per-element validation is per event: an element that fails is refused on its own, and the rest of the batch is stored."
    )
});

/** `{ error: { code, message, requestId, details? } }`, the shape of every refusal. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z
      .string()
      .describe(
        "A stable machine-readable code. Branch on the HTTP status for a code you do not recognize."
      ),
    message: z.string(),
    requestId: z
      .string()
      .describe("Quote this when reporting a problem; it is in the server's log line."),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe("Present when the refusal came from validation: which fields were wrong.")
  })
});

/** The `202` body of `POST /v1/events`. */
export const eventAcceptedSchema = z.object({
  data: z.object({
    eventId: z.string(),
    journeyId: z.string(),
    status: z.literal("accepted"),
    duplicate: z
      .boolean()
      .describe("True when an event with this id and identical content was already stored.")
  })
});

const storedEventPayload = z.unknown();

/**
 * One event as `GET /v1/events/:eventId` returns it, which is what a dry run
 * previews.
 *
 * Described so that a conformance case can state an expected stored event
 * against a shape the API already publishes, rather than against a private
 * representation.
 */
export const storedEventSchema = z.object({
  id: z.string(),
  journeyId: z.string(),
  parentEventId: z.string().nullable(),
  protocolVersion: z.string(),
  operation: z.enum(JOURNEY_OPERATIONS),
  name: z.string(),
  service: z.string(),
  eventTimestamp: z.string().describe("Normalized to UTC and stored to millisecond precision."),
  receivedAt: z
    .string()
    .optional()
    .describe(
      "When the server received it. Omitted from a dry run's preview, which received nothing."
    ),
  durationMs: z.number().int().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  messageId: z.string().nullable(),
  correlationId: z.string().nullable(),
  hasInput: z.boolean(),
  hasOutput: z.boolean(),
  hasError: z.boolean(),
  inputPayload: storedEventPayload.describe(
    "After this environment's capture policy and redaction."
  ),
  outputPayload: storedEventPayload,
  payloadDiff: storedEventPayload.describe(
    "Computed after capture, only when both payloads are present."
  ),
  error: storedEventPayload.describe(
    "Masked by shape. The stack is dropped unless full capture is in effect."
  ),
  runtimeMetadata: storedEventPayload,
  deploymentMetadata: storedEventPayload,
  customMetadata: storedEventPayload
});

/** One journey as `GET /v1/journeys/:journeyId` returns it. */
export const storedJourneySchema = z.object({
  journeyId: z.string(),
  environment: z.string(),
  entity: z.object({
    type: z.string(),
    id: z
      .string()
      .nullable()
      .describe("Decrypted for display. Null when the key that encrypted it is no longer held.")
  }),
  status: z.enum(["active", "completed", "failed"]),
  aliases: z.array(
    z.object({
      type: z.string(),
      displayValue: z
        .string()
        .nullable()
        .describe(
          "Masked, because an alias may be an identifier the caller is not entitled to see in full, unless displayable is true. Null when the key that encrypted it is no longer held."
        ),
      displayable: z
        .boolean()
        .describe(
          "True when every event that stated this alias listed it in displayableAliases; displayValue is then the whole value."
        )
    })
  ),
  services: z.array(z.string()),
  eventCount: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  lastEventAt: z.string()
});

/**
 * One verdict in a batch response, matched to its request element by position.
 *
 * `error.httpStatus` is what the same refusal would have returned from the
 * single-event route. It rides along because the batch route always answers
 * 202: the transport succeeded, and the client needs it to tell a permanent
 * refusal from a transient one.
 */
export const eventResultSchema = z.object({
  eventId: z
    .string()
    .nullable()
    .describe("Null when the event was refused before its id was read."),
  status: z.enum(["accepted", "rejected"]),
  duplicate: z.boolean().optional(),
  stored: z
    .object({ event: storedEventSchema, journey: storedJourneySchema })
    .optional()
    .describe(
      "A dry run only, and only for an accepted result that is not a duplicate: what would have been stored."
    ),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      httpStatus: z
        .number()
        .int()
        .describe(
          "Below 500 is permanent and the event must not be sent again; 500 or above is transient."
        ),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional()
    })
    .optional()
});

/** The body of `POST /v1/events/batch`: one result per sent event, in order. */
export const batchResponseSchema = z.object({
  data: z.object({
    dryRun: z
      .boolean()
      .optional()
      .describe("Present and true when nothing was stored, because `dryRun=true` was given."),
    results: z.array(eventResultSchema)
  })
});
