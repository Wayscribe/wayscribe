import type { Knex } from "knex";
import { scoped, type ReadScope } from "./read-scope.js";
import { decodeEventCursor, encodeCursor } from "./cursors.js";
import type { JourneyAlias } from "./journey-reads.js";

export interface EventListItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: Date;
  /**
   * When the server received it, as opposed to when the instrumented service
   * says it happened.
   *
   * Selected and then discarded until now, which left the interface unable to
   * show skew even in principle: a service with a wrong clock produced a
   * timeline that was confidently, silently out of order.
   */
  receivedAt: Date;
  durationMs: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  hasError: boolean;
  /**
   * The build that recorded the event: its `deployment` as stored, the same
   * value the event read returns, or null when it carried none.
   *
   * On the row, as `service` is, because "did every event of this journey
   * come from one build?" was otherwise a full event read per event, each
   * carrying its whole input and output payloads to deliver one short object
   * (F-043). The protocol keeps three optional strings of it, `gitCommit`,
   * `version` and `image`, of at most 128, 128 and 512 characters.
   */
  deploymentMetadata: unknown;
  /** Known custom-metadata keys only; interpreted at the API boundary. */
  timingMetadata: unknown;
  /** The already-redacted runtime.hostname value; interpreted at the API boundary. */
  recordedHostname: unknown;
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
  customMetadata: unknown;
  /**
   * The aliases this event stated, as the journey detail reads them: the same
   * rows, so the same values and the same display flags (ADR-053). Empty when
   * it stated none; null when the server did not record which it stated,
   * which is every event stored before migration 020 and any the previous API
   * stored during an upgrade (F-042).
   */
  aliases: JourneyAlias[] | null;
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
 *
 * It does carry each event's deployment (F-043), the one piece of metadata
 * short enough to belong on a row. Measured on PostgreSQL 17.11, 611,000
 * events, a journey of 10,000 events each with about 1 KB of input and output
 * and a 124-byte deployment, median of 21 runs under EXPLAIN (ANALYZE,
 * BUFFERS, SERIALIZE), without the column and then with it:
 *
 * - a page of 100: 0.068 and 0.100 ms, 15 and 28 kB serialized, 23 buffers
 *   either way; the 50th page 0.073 and 0.108 ms. A page of 25: 0.025 and
 *   0.034 ms.
 * - a journey of 1,000 events: the same, 0.067 and 0.100 ms for a page of 100.
 *
 * The cost is a fixed amount per row returned, whatever the journey's length.
 * The alternative, the distinct builds beside `services` on the journey read,
 * reads every event of the journey on every journey read: 0.44 ms at 1,000
 * events and 5.0 ms at 10,000 (1,879 buffers), growing with the journey.
 */
export async function listJourneyEvents(
  db: Knex,
  scope: ReadScope,
  journeyId: string,
  limit: number,
  cursor?: string
): Promise<EventPage> {
  const after = cursor === undefined ? undefined : decodeEventCursor(cursor);

  const rows: unknown = await scoped(db("journey_events"), scope)
    .where({ journey_id: journeyId })
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
      db.raw('error is not null as "hasError"'),
      "deployment_metadata as deploymentMetadata",
      ...timingProjection(db)
    )
    .orderBy([{ column: "event_timestamp" }, { column: "received_at" }, { column: "id" }])
    .limit(limit + 1);

  const all = rows as EventListItem[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;
  const last = page.at(-1);

  return {
    items: page,
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
  scope: ReadScope,
  eventId: string
): Promise<EventDetail | undefined> {
  const row: unknown = await scoped(db("journey_events"), scope)
    .where({ id: eventId })
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
      db.raw('error is not null as "hasError"'),
      "stated_alias_ids as statedAliasIds",
      ...timingProjection(db)
    );
  if (row === undefined) return undefined;

  const { statedAliasIds, ...detail } = row as Omit<EventDetail, "aliases"> & {
    statedAliasIds: string[] | null;
  };
  return { ...detail, aliases: await statedAliases(db, scope, detail, statedAliasIds) };
}

/**
 * The bounded row projection: only public timing vocabulary keys, never the
 * event's arbitrary metadata object or either payload.
 */
function timingProjection(db: Knex): Knex.Raw[] {
  return [
    db.raw(
      `jsonb_build_object(
         'queue', custom_metadata -> 'queue',
         'queueWaitMs', custom_metadata -> 'queueWaitMs',
         'queueWaitBasis', custom_metadata -> 'queueWaitBasis',
         'deliveryCount', custom_metadata -> 'deliveryCount',
         'targetHost', custom_metadata -> 'targetHost',
         'httpStatusCode', custom_metadata -> 'httpStatusCode',
         'retryAfterMs', custom_metadata -> 'retryAfterMs',
         'attempt', custom_metadata -> 'attempt',
         'retryGroup', custom_metadata -> 'retryGroup'
       ) as ??`,
      ["timingMetadata"]
    ),
    db.raw(`runtime_metadata -> 'hostname' as ??`, ["recordedHostname"])
  ];
}

/**
 * The alias rows an event names, read as `findJourneyDetail` reads a
 * journey's, in the same order.
 *
 * Project and journey alone, as the journey read does: the event above was
 * already inside the caller's scope, and `entity_aliases` carries no
 * environment. The journey condition is what keeps an id from reaching
 * another journey's alias. An id whose row is gone is left out rather than
 * failing the read; key rotation, the one path that deletes a single alias
 * row, first points the ids that name it at the row that replaces it.
 */
async function statedAliases(
  db: Knex,
  scope: ReadScope,
  event: { journeyId: string },
  ids: string[] | null
): Promise<JourneyAlias[] | null> {
  if (ids === null) return null;
  if (ids.length === 0) return [];
  const rows: unknown = await db("entity_aliases")
    .where({ project_id: scope.projectId, journey_id: event.journeyId })
    .whereIn("id", ids)
    .select(
      "alias_type as aliasType",
      "encrypted_display_value as encryptedDisplayValue",
      "displayable"
    )
    .orderBy("alias_type");
  return rows as JourneyAlias[];
}
