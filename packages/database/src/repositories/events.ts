import type { Knex } from "knex";

export interface EventRow {
  id: string;
  environmentId: string;
  journeyId: string;
  parentEventId: string | null;
  protocolVersion: string;
  contentHash: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: Date;
  durationMs: number | null;
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

export type InsertOutcome = { kind: "inserted" } | { kind: "duplicate" } | { kind: "conflict" };

/**
 * Insert an event, reporting whether it was new, an identical resubmission, or a
 * reuse of an existing ID with different content (ADR-021).
 *
 * ON CONFLICT DO NOTHING followed by a hash comparison, rather than read-then-
 * write: the read-then-write ordering races, where two identical events both
 * observe "absent" and one insert then fails outright.
 *
 * `sameContent` decides whether the stored hash describes this event. Ingestion
 * passes one that recomputes under the key the stored hash names (ADR-048),
 * since a hash written under the previous key, or before hashes were keyed, is
 * not string-equal to the one just computed. Without it the hashes are compared
 * as strings.
 */
export async function insertEvent(
  db: Knex,
  projectId: string,
  event: EventRow,
  sameContent: (storedHash: string) => boolean = (storedHash) => storedHash === event.contentHash
): Promise<InsertOutcome> {
  const inserted: unknown = await db("journey_events")
    .insert({
      id: event.id,
      project_id: projectId,
      environment_id: event.environmentId,
      journey_id: event.journeyId,
      parent_event_id: event.parentEventId,
      protocol_version: event.protocolVersion,
      content_hash: event.contentHash,
      operation: event.operation,
      name: event.name,
      service: event.service,
      event_timestamp: event.eventTimestamp,
      duration_ms: event.durationMs,
      trace_id: event.traceId,
      span_id: event.spanId,
      message_id: event.messageId,
      correlation_id: event.correlationId,
      input_payload: toJson(event.inputPayload),
      output_payload: toJson(event.outputPayload),
      payload_diff: toJson(event.payloadDiff),
      error: toJson(event.error),
      runtime_metadata: toJson(event.runtimeMetadata),
      deployment_metadata: toJson(event.deploymentMetadata),
      custom_metadata: toJson(event.customMetadata)
    })
    .onConflict(["project_id", "id"])
    .ignore()
    .returning("id");

  if (Array.isArray(inserted) && inserted.length > 0) return { kind: "inserted" };

  const existing: unknown = await db("journey_events")
    .where({ project_id: projectId, id: event.id })
    .first("content_hash as contentHash");

  const existingHash = (existing as { contentHash?: string } | undefined)?.contentHash;
  return existingHash !== undefined && sameContent(existingHash)
    ? { kind: "duplicate" }
    : { kind: "conflict" };
}

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
