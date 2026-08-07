import {
  ensureJourney,
  insertEvent,
  updateJourneySummary,
  upsertAliases,
  type ApiKeyContext
} from "@flight-recorder/database";
import { diffPayloads } from "@flight-recorder/payload-diff";
import {
  DEFAULT_LIMITS,
  applyCapture,
  checkLimits,
  contentHash,
  encryptField,
  searchToken,
  type CaptureMode,
  type Subkeys
} from "@flight-recorder/payload-security";
import { PROTOCOL_ERROR_CODES, parseEnvelope } from "@flight-recorder/protocol";
import type { Knex } from "knex";
import { authorizeEnvironment } from "../auth.js";

export interface IngestResult {
  eventId: string | null;
  journeyId: string | null;
  status: "accepted" | "rejected";
  duplicate?: boolean;
  code?: string;
  message?: string;
  httpStatus: number;
}

/**
 * Ingest one event inside a single transaction (ARCHITECTURE.md section 8).
 *
 * Ordering is deliberate: limits are enforced before anything walks the payload,
 * the content hash is taken over the event as received (before redaction, per
 * ADR-021), and the diff is computed after redaction so a stored diff can never
 * carry a secret.
 */
export async function ingestEvent(
  db: Knex,
  subkeys: Subkeys,
  context: ApiKeyContext,
  body: unknown
): Promise<IngestResult> {
  const limits = checkLimits(body, DEFAULT_LIMITS);
  if (!limits.ok) {
    return reject(400, limits.reason, "The event exceeded a configured limit.");
  }

  const parsed = parseEnvelope(body);
  if (!parsed.ok) return reject(400, parsed.code, parsed.message);

  const event = parsed.event;

  const environment = authorizeEnvironment(context, event.environment);
  if (!environment.ok) return reject(403, environment.code, environment.message);

  const hash = contentHash(event);

  const policy = {
    mode: context.captureMode as CaptureMode,
    redactionPaths: context.redactionPaths,
    allowlist: context.captureAllowlist
  };
  const input = applyCapture(event.input, policy);
  const output = applyCapture(event.output, policy);
  const diff =
    input !== undefined && output !== undefined ? diffPayloads(input, output) : undefined;

  const journeyFacts = {
    journeyId: event.journeyId,
    environmentId: context.environmentId,
    entityType: event.entity.type,
    primaryEntityIdHash: searchToken(subkeys.searchToken, event.entity.id),
    encryptedPrimaryEntityId: encryptField(subkeys.fieldEncryption, event.entity.id),
    eventTimestamp: new Date(event.timestamp),
    operation: event.operation,
    hasError: event.error !== undefined
  };

  return db.transaction(async (trx) => {
    // The journey must exist before the event: journey_events carries a
    // composite foreign key to journeys. A conflict below rolls the whole
    // transaction back, so this never leaves an orphan journey behind.
    await ensureJourney(trx, context.projectId, journeyFacts);

    const outcome = await insertEvent(trx, context.projectId, {
      id: event.id,
      environmentId: context.environmentId,
      journeyId: event.journeyId,
      parentEventId: event.parentEventId ?? null,
      protocolVersion: "0.1",
      contentHash: hash,
      operation: event.operation,
      name: event.name,
      service: event.service,
      eventTimestamp: new Date(event.timestamp),
      durationMs: event.durationMs ?? null,
      traceId: event.traceId ?? null,
      spanId: event.spanId ?? null,
      messageId: event.messageId ?? null,
      correlationId: event.correlationId ?? null,
      inputPayload: input,
      outputPayload: output,
      payloadDiff: diff,
      error: event.error,
      runtimeMetadata: event.runtime,
      deploymentMetadata: event.deployment,
      customMetadata: event.metadata
    });

    if (outcome.kind === "conflict") {
      return reject(
        409,
        PROTOCOL_ERROR_CODES.eventIdConflict,
        "This event ID already exists with different content."
      );
    }

    if (outcome.kind === "duplicate") {
      // Idempotent: derived updates are not repeated, so event_count stays right.
      return {
        eventId: event.id,
        journeyId: event.journeyId,
        status: "accepted" as const,
        duplicate: true,
        httpStatus: 202
      };
    }

    await updateJourneySummary(trx, context.projectId, journeyFacts);

    await upsertAliases(
      trx,
      context.projectId,
      Object.entries(event.aliases ?? {}).map(([aliasType, value]) => ({
        journeyId: event.journeyId,
        aliasType,
        aliasValueHash: searchToken(subkeys.searchToken, value),
        encryptedDisplayValue: encryptField(subkeys.fieldEncryption, value)
      }))
    );

    return {
      eventId: event.id,
      journeyId: event.journeyId,
      status: "accepted" as const,
      duplicate: false,
      httpStatus: 202
    };
  });
}

function reject(httpStatus: number, code: string, message: string): IngestResult {
  return { eventId: null, journeyId: null, status: "rejected", code, message, httpStatus };
}
