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
  redactAlways,
  checkLimits,
  contentHash,
  encryptValue,
  maskSecretsInText,
  searchTokens,
  type CaptureMode,
  type CapturePolicy,
  type Keyring
} from "@flight-recorder/payload-security";
import { PROTOCOL_ERROR_CODES, parseEnvelope } from "@flight-recorder/protocol";
import type { JourneyEvent, ParseDetail } from "@flight-recorder/protocol";

type EventError = NonNullable<JourneyEvent["error"]>;
import type { Knex } from "knex";
import { authorizeEnvironment } from "../auth.js";

export interface IngestResult {
  eventId: string | null;
  journeyId: string | null;
  status: "accepted" | "rejected";
  duplicate?: boolean;
  code?: string;
  message?: string;
  /**
   * Which fields were wrong, when the rejection came from validation.
   *
   * Carried rather than dropped because this is the difference between an SDK
   * user reading "invalid_event" and reading "event.entity.id: expected string,
   * received number". The second one ends the problem; the first starts a
   * search.
   */
  details?: ParseDetail[];
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
  keyring: Keyring,
  context: ApiKeyContext,
  body: unknown,
  /** From MAX_EVENT_PAYLOAD_BYTES. Defaults to the shared limit for callers that have none. */
  maxPayloadBytes: number = DEFAULT_LIMITS.maxBytes,
  /** From ALLOW_FULL_PAYLOAD_CAPTURE. */
  allowFullPayload = false
): Promise<IngestResult> {
  const limits = checkLimits(body, { ...DEFAULT_LIMITS, maxBytes: maxPayloadBytes });
  if (!limits.ok) {
    return reject(400, limits.reason, "The event exceeded a configured limit.");
  }

  const parsed = parseEnvelope(body);
  if (!parsed.ok) return reject(400, parsed.code, parsed.message, parsed.details);

  const event = parsed.event;

  const environment = authorizeEnvironment(context, event.environment);
  if (!environment.ok) return reject(403, environment.code, environment.message);

  const hash = contentHash(event);

  const policy = {
    mode: context.captureMode as CaptureMode,
    redactionPaths: context.redactionPaths,
    allowlist: context.captureAllowlist,
    allowFullPayload
  };
  const input = applyCapture(event.input, policy);
  const output = applyCapture(event.output, policy);
  const diff =
    input !== undefined && output !== undefined ? diffPayloads(input, output) : undefined;

  const journeyFacts = {
    journeyId: event.journeyId,
    environmentId: context.environmentId,
    entityType: event.entity.type,
    // Written under the current key alone. A journey created under the previous
    // key keeps its token and ciphertext until re-encryption: this insert
    // ignores an existing journey, and search matches either token meanwhile.
    primaryEntityIdHash: storedTokens(keyring, event.entity.id).current,
    encryptedPrimaryEntityId: encryptValue(keyring, event.entity.id),
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
      error: redactAlways(storedError(event.error, policy), policy),
      runtimeMetadata: redactAlways(event.runtime, policy),
      deploymentMetadata: redactAlways(event.deployment, policy),
      customMetadata: redactAlways(event.metadata, policy)
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
      Object.entries(event.aliases ?? {}).map(([aliasType, value]) => {
        const tokens = storedTokens(keyring, value);
        return {
          journeyId: event.journeyId,
          aliasType,
          aliasValueHash: tokens.current,
          encryptedDisplayValue: encryptValue(keyring, value),
          // During a rotation, a repeat of an alias stored under the previous
          // key's token moves that row rather than adding a second one.
          supersedesValueHash: tokens.previous
        };
      })
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

/**
 * The error as it may be stored: stack kept only under full capture, and every
 * free-text field masked (ADR-045).
 *
 * Path redaction cannot reach inside `message` or `stack`, and ingestion cannot
 * rely on the SDK having masked them, because any HTTP client can send an event.
 * A stack is dropped unless full capture is in effect, which takes both
 * ALLOW_FULL_PAYLOAD_CAPTURE and the environment's own setting: it is the
 * largest carrier of credentials an error has, and the Node SDK never sends one.
 * Under full capture it is kept, masked like the message.
 */
function storedError(error: EventError | undefined, policy: CapturePolicy): EventError | undefined {
  if (error === undefined) return undefined;
  const { stack, ...rest } = error;
  const fullCapture = policy.mode === "full-payload" && policy.allowFullPayload === true;
  return {
    ...rest,
    message: maskSecretsInText(error.message),
    ...(fullCapture && stack !== undefined ? { stack: maskSecretsInText(stack) } : {})
  };
}

/**
 * The token ingestion stores, which is the current key's, and the previous
 * key's token during a rotation.
 */
function storedTokens(
  keyring: Keyring,
  value: string
): { current: string; previous: string | null } {
  const [current, previous] = searchTokens(keyring, value);
  // searchTokens always returns the current key's token first; the check exists
  // for the type, which cannot know that.
  if (current === undefined) throw new Error("searchTokens returned no current token.");
  return { current, previous: previous ?? null };
}

function reject(
  httpStatus: number,
  code: string,
  message: string,
  details?: ParseDetail[]
): IngestResult {
  return {
    eventId: null,
    journeyId: null,
    status: "rejected",
    code,
    message,
    ...(details === undefined || details.length === 0 ? {} : { details }),
    httpStatus
  };
}
