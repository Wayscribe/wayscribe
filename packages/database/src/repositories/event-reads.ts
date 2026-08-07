import type { Knex } from "knex";
import { decodeEventCursor, encodeCursor } from "./cursors.js";

export interface EventListItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: Date;
  durationMs: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  hasError: boolean;
}

export interface EventPage {
  items: EventListItem[];
  nextCursor: string | null;
}

export interface EventDetail extends EventListItem {
  journeyId: string;
  parentEventId: string | null;
  protocolVersion: string;
  receivedAt: Date;
  traceId: string | null;
  spanId: string | null;
  messageId: string | null;
  correlationId: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  payloadDiff: unknown;
  error: unknown;
  runtimeMetadata: unknown;
  deploymentMetadata: unknown;
  customMetadata: unknown;
}

/**
 * One page of a journey's timeline.
 *
 * Ordering is (event_timestamp, received_at, id) per ARCHITECTURE.md section 9.
 * All three matter: clocks on different services collide, and without the final
 * tiebreak two events sharing a timestamp and arrival time could swap places
 * between pages — showing a developer a different history on every scroll.
 *
 * The list reports payload *presence*, not payload contents. A 500-event
 * timeline would otherwise transfer every captured body to render a list that
 * displays none of them.
 */
export async function listJourneyEvents(
  db: Knex,
  projectId: string,
  journeyId: string,
  limit: number,
  cursor?: string
): Promise<EventPage> {
  const after = cursor === undefined ? undefined : decodeEventCursor(cursor);

  const rows: unknown = await db("journey_events")
    .where({ project_id: projectId, journey_id: journeyId })
    .modify((builder) => {
      if (after !== undefined) {
        void builder.whereRaw(
          "(event_timestamp, received_at, id) > (?::timestamptz, ?::timestamptz, ?)",
          [after.eventTimestamp, after.receivedAt, after.id]
        );
      }
    })
    .select(
      "id",
      "operation",
      "name",
      "service",
      "event_timestamp as eventTimestamp",
      "received_at as receivedAt",
      "duration_ms as durationMs",
      db.raw('input_payload is not null as "hasInput"'),
      db.raw('output_payload is not null as "hasOutput"'),
      db.raw('error is not null as "hasError"')
    )
    .orderBy([{ column: "event_timestamp" }, { column: "received_at" }, { column: "id" }])
    .limit(limit + 1);

  const all = rows as (EventListItem & { receivedAt: Date })[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;
  const last = page.at(-1);

  return {
    items: page.map(({ receivedAt: _omitted, ...item }) => item),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            eventTimestamp: last.eventTimestamp.toISOString(),
            receivedAt: last.receivedAt.toISOString(),
            id: last.id
          })
        : null
  };
}

export async function findEventDetail(
  db: Knex,
  projectId: string,
  eventId: string
): Promise<EventDetail | undefined> {
  const row: unknown = await db("journey_events")
    .where({ project_id: projectId, id: eventId })
    .first(
      "id",
      "journey_id as journeyId",
      "parent_event_id as parentEventId",
      "protocol_version as protocolVersion",
      "operation",
      "name",
      "service",
      "event_timestamp as eventTimestamp",
      "received_at as receivedAt",
      "duration_ms as durationMs",
      "trace_id as traceId",
      "span_id as spanId",
      "message_id as messageId",
      "correlation_id as correlationId",
      "input_payload as inputPayload",
      "output_payload as outputPayload",
      "payload_diff as payloadDiff",
      "error",
      "runtime_metadata as runtimeMetadata",
      "deployment_metadata as deploymentMetadata",
      "custom_metadata as customMetadata",
      db.raw('input_payload is not null as "hasInput"'),
      db.raw('output_payload is not null as "hasOutput"'),
      db.raw('error is not null as "hasError"')
    );

  return row === undefined ? undefined : (row as EventDetail);
}
